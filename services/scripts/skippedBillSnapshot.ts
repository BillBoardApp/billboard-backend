// The REL-56 backfill's snapshot file and update times. list:skipped-bill-updates writes the file;
// refetch:stale-bills --snapshot-file reads it. RUNBOOK 16.1.
//
// The file is tab-separated, so its first column is also a valid --guids-file for reconcile:processed-bills and
// refetch:stale-bills:
//
//   # list:skipped-bill-updates (REL-56) snapshot v1
//   # congress=119 cutoff=<iso> top=<iso> listedAt=<iso> rowTimes=date|full|mixed requests=<n> types=<list> ...
//   # counts missing=<n> stale=<n> stale_same_day=<n> unresolved=<n> fresh=<n> recent=<n> titles_differ=<n>
//   # type hr missing=<n> ...                      (one line per bill type)
//   # columns: guid, class, row time, stored time (or -), list row (JSON)
//   BILLS-119hr10953<TAB>missing<TAB>2026-10-16<TAB>-<TAB>{"congress":119,"number":"10953",...}

import { createHash } from "node:crypto";

export const SNAPSHOT_TITLE = "# list:skipped-bill-updates (REL-56) snapshot v1";
export const SNAPSHOT_COLUMNS = "# columns: guid, class, row time, stored time (or -), list row (JSON)";

/** The classes a snapshot lists: the bills the backfill sends. */
export const SNAPSHOT_CLASSES = ["missing", "stale", "stale_same_day", "unresolved"] as const;
export type SnapshotClass = (typeof SNAPSHOT_CLASSES)[number];

/**
 * The 119th's snapshot only: the backfill bypasses the outcome gate a trailing Congress's poll applies (REL-46), so it
 * must run while the 119th is the primary Congress.
 */
export const SNAPSHOT_CONGRESS = "119";

/** RUNBOOK 24.1: no quiet window from this time, so the backfill sends nothing from then on. */
export const BACKFILL_DEADLINE = "2026-12-28T00:00:00.000Z";

/** When Congress N meets: noon Eastern (17:00Z) on January 3 of its first year, 1789 + 2(N - 1), as the poller has it. */
export const congressStartMs = (congress: number): number => Date.UTC(1789 + 2 * (congress - 1), 0, 3, 17);

/** The primary (newest) Congress at a time: the 119th until 2027-01-03T17:00Z, then the 120th. */
export const primaryCongressAt = (ms: number): string => {
  let congress = Math.floor((new Date(ms).getUTCFullYear() - 1789) / 2) + 1;
  if (ms < congressStartMs(congress)) congress -= 1;
  return String(congress);
};

// ─── Update times ────────────────────────────────────────────────────────────

/**
 * A congress.gov update time: a full time (the detail's "2026-11-05T21:38:20Z"), or a date alone (the list's
 * "2026-11-05"). A date is the UTC date: list rows of the 2026-11-09 first run dated 11-07 had detail times from
 * 00:23Z, which is 11-06 in New York.
 */
export interface UpdateTime {
  /** "2026-11-05" for a date alone, else the ISO time. */
  text: string;
  /** UTC midnight for a date alone. */
  ms: number;
  day: string;
  full: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FULL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** The value as an update time, or null when it is not a date or an ISO time. */
export const parseUpdateTime = (value: unknown): UpdateTime | null => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (DATE_ONLY.test(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    return Number.isNaN(ms) ? null : { text, ms, day: text, full: false };
  }
  if (!FULL_TIME.test(text)) return null;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  return { text: iso, ms, day: iso.slice(0, 10), full: true };
};

/**
 * The later of two update times. A later day wins; on the same day the later full time, and a date alone over a full
 * time: the date says only that it was some time that day, maybe after the full time. (A full updateDate with a
 * date-only updateDateIncludingText the same day would otherwise read as the full time, and a text change later that
 * day as older than a copy stored in between.) Compared with a time that day, a date alone goes to the same-date
 * detail request.
 */
export const laterUpdateTime = (a: UpdateTime | null, b: UpdateTime | null): UpdateTime | null => {
  if (!a) return b;
  if (!b) return a;
  if (a.day !== b.day) return a.day > b.day ? a : b;
  if (a.full && b.full) return a.ms >= b.ms ? a : b;
  return a.full ? b : a;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The later of a record's updateDate and updateDateIncludingText (congress.gov's list rows and bill details). */
export const recordUpdateTime = (record: unknown): UpdateTime | null => {
  const fields = asRecord(record);
  if (!fields) return null;
  return laterUpdateTime(parseUpdateTime(fields.updateDate), parseUpdateTime(fields.updateDateIncludingText));
};

/** A raw bill's congress.gov update time: the later of content.bill.bill's two update fields. */
export const storedUpdateTime = (rawBill: unknown): UpdateTime | null => {
  const bill = asRecord(asRecord(asRecord(rawBill)?.content)?.bill);
  return recordUpdateTime(asRecord(bill?.bill) ?? bill);
};

// ─── The file ────────────────────────────────────────────────────────────────

export interface SnapshotEntry {
  guid: string;
  cls: SnapshotClass;
  /** The row's update time as written (a date alone or an ISO time), or "-" for a row with no update date. */
  rowTime: string;
  /** The stored raw copy's update time, or null when there is none (a bill never stored). */
  storedTime: string | null;
  /** The list row as congress.gov gave it. */
  row: Record<string, unknown>;
}

/** The second header line's settings, in this order; refetch:stale-bills needs congress, cutoff, top and listedAt. */
export interface SnapshotSettings {
  congress: string;
  cutoff: string;
  top: string;
  listedAt: string;
  rowTimes: string;
  requests: number;
  types: string;
  recentHours: number;
  recentFrom: string;
}

export const settingsLine = (settings: SnapshotSettings): string =>
  `# congress=${settings.congress} cutoff=${settings.cutoff} top=${settings.top} listedAt=${settings.listedAt} ` +
  `rowTimes=${settings.rowTimes} requests=${settings.requests} types=${settings.types} ` +
  `recentHours=${settings.recentHours} recentFrom=${settings.recentFrom}`;

export const entryLine = (entry: SnapshotEntry): string =>
  [entry.guid, entry.cls, entry.rowTime, entry.storedTime ?? "-", JSON.stringify(entry.row)].join("\t");

/** The whole file: the title, the settings, the count lines (each starting "# "), the columns line, then the entries. */
export const formatSnapshot = (
  settings: SnapshotSettings,
  countLines: readonly string[],
  entries: readonly SnapshotEntry[],
): string =>
  [SNAPSHOT_TITLE, settingsLine(settings), ...countLines, SNAPSHOT_COLUMNS, ...entries.map(entryLine)].join("\n") +
  "\n";

export interface ParsedSnapshot {
  congress: string;
  cutoff: string;
  top: string;
  listedAt: string;
  /** Every key=value of the settings line. */
  settings: Record<string, string>;
  /** In the file's order (newest row time first). */
  entries: SnapshotEntry[];
  /** SHA-256 (hex) of the file's text: a progress file names the snapshot it belongs to by it. */
  sha256: string;
}

const isoOrThrow = (settings: Record<string, string>, name: string): string => {
  const value = settings[name];
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new Error(`The snapshot file's settings line has no ${name} time`);
  }
  return new Date(value).toISOString();
};

/** Reads a snapshot file; throws, naming the line, on anything it does not expect. */
export const parseSnapshot = (text: string): ParsedSnapshot => {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== SNAPSHOT_TITLE) {
    throw new Error(
      `This is not a list:skipped-bill-updates snapshot v1 file (its first line must be "${SNAPSHOT_TITLE}")`,
    );
  }
  const settingsText = lines.find((line) => line.startsWith("# congress="));
  if (!settingsText) throw new Error("The snapshot file has no settings line (# congress=...)");
  const settings: Record<string, string> = {};
  for (const token of settingsText.slice(2).trim().split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator > 0) settings[token.slice(0, separator)] = token.slice(separator + 1);
  }
  const congress = settings.congress ?? "";
  if (!/^\d{2,3}$/.test(congress)) throw new Error("The snapshot file's settings line has no congress number");
  const parsed: ParsedSnapshot = {
    congress,
    cutoff: isoOrThrow(settings, "cutoff"),
    top: isoOrThrow(settings, "top"),
    listedAt: isoOrThrow(settings, "listedAt"),
    settings,
    entries: [],
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  const guidPattern = new RegExp(`^BILLS-${congress}(hr|s|hjres|sjres|hconres|sconres|hres|sres)\\d+$`);
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    if (!line.trim() || line.startsWith("#")) return;
    const where = `Line ${index + 1} of the snapshot file`;
    const fields = line.split("\t");
    if (fields.length !== 5) throw new Error(`${where} does not have 5 tab-separated fields`);
    const [guid, cls, rowTime, storedTime, rowJson] = fields;
    if (!guidPattern.test(guid)) throw new Error(`${where} does not start with a ${congress}th Congress bill guid`);
    if (seen.has(guid)) throw new Error(`${where} lists ${guid} a second time`);
    seen.add(guid);
    if (!(SNAPSHOT_CLASSES as readonly string[]).includes(cls)) throw new Error(`${where} has an unknown class ${cls}`);
    if (rowTime !== "-" && !parseUpdateTime(rowTime)) throw new Error(`${where} has a row time that is not a time`);
    if (storedTime !== "-" && !parseUpdateTime(storedTime))
      throw new Error(`${where} has a stored time that is not a time`);
    let row: unknown;
    try {
      row = JSON.parse(rowJson);
    } catch {
      throw new Error(`${where} has a list row that is not JSON`);
    }
    const record = asRecord(row);
    if (!record) throw new Error(`${where} has a list row that is not a JSON object`);
    parsed.entries.push({
      guid,
      cls: cls as SnapshotClass,
      rowTime,
      storedTime: storedTime === "-" ? null : storedTime,
      row: record,
    });
  });
  return parsed;
};
