#!/usr/bin/env node

// REL-56 backfill, step 6 (RUNBOOK 16.1): the clean-up's leftovers, from the verification snapshot. Read-only: it reads
// two local snapshot files and writes a guids file. No AWS call, no congress.gov request, no key.
//
// The first snapshot (rel56-snapshot.tsv) answered for the rows dated before its own recentFrom (its settings line).
// Rows from then on were the fixed poller's, and its copies often lag (congress.gov's detail lags its list), so they
// look stale for a while whatever the backfill did. The leftovers are:
//   - every missing row of the verification snapshot, except one whose updateDate is from the verification's own
//     recentFrom on: a new bill the poller is fetching now. Sent in a quiet window, its "new" push would be dropped,
//     so it is left to the poller and reported apart;
//   - every stale, stale_same_day and unresolved row whose row time is before the FIRST snapshot's recentFrom (a date
//     alone by its UTC midnight, as the snapshot's recent rule reads it; a row with no time is kept).
// The stale, stale_same_day and unresolved rows from the first snapshot's recentFrom on are reported apart and not
// sent: they come in with the bills' next updates. The check passes when there are no leftovers.
//
//   npm run list:backfill-leftovers -- --first rel56-snapshot.tsv --verify rel56-verify.tsv [--out rel56-leftovers.txt]
//
// The file holds guid<TAB>class<TAB>row time, in the verification's order (newest first), after # lines that name both
// snapshots by SHA-256: a --guids-file for refetch:stale-bills and reconcile:processed-bills. It never replaces another
// file: an existing --out must be one this script wrote. The last line is
//   Leftovers summary: outcome=pass|leftovers leftovers= missing= stale= stale_same_day= unresolved= since_first_recent= new_for_poller= file=
// Exit codes: 0 done (passed or not); 1 a usage error, a file that cannot be read or is not a snapshot, or snapshots
// that do not belong together (another congress or cutoff, or a verification not listed after the first).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  SNAPSHOT_CLASSES,
  parseSnapshot,
  parseUpdateTime,
  type ParsedSnapshot,
  type SnapshotClass,
  type SnapshotEntry,
} from "./skippedBillSnapshot";

export const DEFAULT_OUT = "rel56-leftovers.txt";
export const LEFTOVERS_TITLE =
  "# list:backfill-leftovers (REL-56): the clean-up's bills, from the verification snapshot";

export interface LeftoverOptions {
  help: boolean;
  first: string | null;
  verify: string | null;
  out: string;
}

export const parseArgs = (argv: readonly string[]): LeftoverOptions => {
  const options: LeftoverOptions = { help: false, first: null, verify: null, out: DEFAULT_OUT };
  const readValue = (flag: string, raw: string | undefined): string => {
    if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs a value`);
    return raw;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--first") options.first = readValue(arg, argv[(index += 1)]);
    else if (arg === "--verify") options.verify = readValue(arg, argv[(index += 1)]);
    else if (arg === "--out") options.out = readValue(arg, argv[(index += 1)]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help && (!options.first || !options.verify)) {
    throw new Error("Pass --first <the backfill's snapshot> and --verify <the verification snapshot>");
  }
  return options;
};

export const USAGE = [
  "List the REL-56 backfill's leftovers for the clean-up window, from the verification snapshot (read-only).",
  "",
  "Usage:",
  "  npm run list:backfill-leftovers -- --first rel56-snapshot.tsv --verify rel56-verify.tsv",
  "",
  "Options:",
  "  --first <file>    The snapshot the backfill sent (its recentFrom bounds the rows it answered for)",
  "  --verify <file>   The verification snapshot, listed with the same cutoff after the last window",
  `  --out <file>      The leftovers, a --guids-file (default ${DEFAULT_OUT}); never replaces another file`,
  "",
  "Leftovers: every missing row, except one updated from the verification's own recentFrom on (a new bill the",
  "poller is fetching), and every stale, stale_same_day or unresolved row dated before the first snapshot's",
  "recentFrom. The rest are reported apart. No AWS call, no congress.gov request. RUNBOOK 16.1, step 6.",
].join("\n");

export interface Leftovers {
  /** The bills the clean-up sends, in the verification's order. */
  leftovers: SnapshotEntry[];
  /** Stale, stale_same_day or unresolved rows from the first snapshot's recentFrom on: the fixed poller's. */
  sinceFirstRecent: SnapshotEntry[];
  /** Missing rows updated from the verification's recentFrom on: new bills the poller is fetching. */
  newForPoller: SnapshotEntry[];
  firstRecentFrom: string;
  verifyRecentFrom: string;
}

const recentFromOf = (snapshot: ParsedSnapshot, name: string): { iso: string; ms: number } => {
  const value = snapshot.settings.recentFrom;
  const ms = value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) throw new Error(`The ${name} snapshot's settings line has no recentFrom time`);
  return { iso: new Date(ms).toISOString(), ms };
};

/** Throws when the two snapshots do not belong together; RUNBOOK 16.1 step 6 lists the second with the same cutoff. */
export const checkPair = (first: ParsedSnapshot, verify: ParsedSnapshot): void => {
  if (first.sha256 === verify.sha256) throw new Error("--first and --verify are the same snapshot");
  if (first.congress !== verify.congress) {
    throw new Error(`The snapshots list other Congresses: ${first.congress} and ${verify.congress}`);
  }
  if (first.cutoff !== verify.cutoff) {
    throw new Error(
      `The snapshots have other cutoffs: ${first.cutoff} and ${verify.cutoff}; list the verification with the same ` +
        "--cutoff (RUNBOOK 16.1, step 6)",
    );
  }
  if (Date.parse(verify.top) <= Date.parse(first.top)) {
    throw new Error(
      `The verification snapshot (top ${verify.top}) was not listed after the first (top ${first.top}): swap the files`,
    );
  }
};

/** The leftovers and the rows reported apart; see the header. */
export const selectLeftovers = (first: ParsedSnapshot, verify: ParsedSnapshot): Leftovers => {
  checkPair(first, verify);
  const firstRecent = recentFromOf(first, "first");
  const verifyRecent = recentFromOf(verify, "verification");
  const result: Leftovers = {
    leftovers: [],
    sinceFirstRecent: [],
    newForPoller: [],
    firstRecentFrom: firstRecent.iso,
    verifyRecentFrom: verifyRecent.iso,
  };
  for (const entry of verify.entries) {
    if (entry.cls === "missing") {
      // As the snapshot's recent rule: by updateDate, the field the poller's list filter uses; a date by its midnight.
      const listed = parseUpdateTime(entry.row.updateDate);
      if (listed && listed.ms >= verifyRecent.ms) result.newForPoller.push(entry);
      else result.leftovers.push(entry);
      continue;
    }
    const rowTime = parseUpdateTime(entry.rowTime);
    if (rowTime && rowTime.ms >= firstRecent.ms) result.sinceFirstRecent.push(entry);
    else result.leftovers.push(entry);
  }
  return result;
};

const countsByClass = (entries: readonly SnapshotEntry[]): Record<SnapshotClass, number> => {
  const counts = Object.fromEntries(SNAPSHOT_CLASSES.map((cls) => [cls, 0])) as Record<SnapshotClass, number>;
  for (const entry of entries) counts[entry.cls] += 1;
  return counts;
};

const classesLine = (
  entries: readonly SnapshotEntry[],
  classes: readonly SnapshotClass[] = SNAPSHOT_CLASSES,
): string => {
  const counts = countsByClass(entries);
  return classes.map((cls) => `${cls}=${counts[cls]}`).join(" ");
};

/** The leftovers file: its # lines, then guid<TAB>class<TAB>row time per bill. */
export const formatLeftovers = (
  selected: Leftovers,
  files: { first: string; verify: string },
  first: ParsedSnapshot,
  verify: ParsedSnapshot,
): string =>
  [
    LEFTOVERS_TITLE,
    `# first=${files.first} sha256=${first.sha256} recentFrom=${selected.firstRecentFrom}`,
    `# verify=${files.verify} sha256=${verify.sha256} top=${verify.top} recentFrom=${selected.verifyRecentFrom}`,
    `# leftovers=${selected.leftovers.length} ${classesLine(selected.leftovers)}`,
    "# columns: guid, class, row time",
    ...selected.leftovers.map((entry) => [entry.guid, entry.cls, entry.rowTime].join("\t")),
  ].join("\n") + "\n";

export interface LeftoverDeps {
  options: LeftoverOptions;
  /** The file's text, or null when it does not exist. */
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, text: string) => void;
  log?: (line: string) => void;
}

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const MAX_LISTED = 20;

/** Reads both snapshots, writes the leftovers file and prints the counts. Throws on a usage error. */
export const runLeftovers = ({
  options,
  readFile = defaultReadFile,
  writeFile = (path, text) => writeFileSync(path, text, "utf8"),
  log = console.log,
}: LeftoverDeps): Leftovers & { file: string; passed: boolean } => {
  const firstPath = resolvePath(options.first ?? "");
  const verifyPath = resolvePath(options.verify ?? "");
  const outPath = resolvePath(options.out);
  if (outPath === firstPath || outPath === verifyPath) throw new Error("--out must not be one of the snapshots");
  const read = (path: string, name: string): ParsedSnapshot => {
    const text = readFile(path);
    if (text === null) throw new Error(`The ${name} snapshot ${path} does not exist`);
    return parseSnapshot(text);
  };
  const first = read(firstPath, "first");
  const verify = read(verifyPath, "verification");
  const existing = readFile(outPath);
  if (existing !== null && existing.split(/\r?\n/)[0] !== LEFTOVERS_TITLE) {
    throw new Error(`${outPath} exists and is not a leftovers file: pass another --out, or move it first`);
  }
  const selected = selectLeftovers(first, verify);
  writeFile(outPath, formatLeftovers(selected, { first: firstPath, verify: verifyPath }, first, verify));

  const stored: readonly SnapshotClass[] = ["stale", "stale_same_day", "unresolved"];
  const list = (entries: readonly SnapshotEntry[]): string =>
    entries
      .slice(0, MAX_LISTED)
      .map((entry) => `${entry.guid} (${entry.cls} ${entry.rowTime})`)
      .join(", ") + (entries.length > MAX_LISTED ? ` and ${entries.length - MAX_LISTED} more` : "");
  log(
    `list:backfill-leftovers first=${firstPath} (recentFrom ${selected.firstRecentFrom}) verify=${verifyPath} ` +
      `(top ${verify.top}, recentFrom ${selected.verifyRecentFrom}) rows=${verify.entries.length}`,
  );
  log(`Leftovers: ${selected.leftovers.length} (${classesLine(selected.leftovers)}), written to ${outPath}`);
  if (selected.leftovers.length > 0) log(`  ${list(selected.leftovers)}`);
  log(
    `Apart, not sent: ${selected.sinceFirstRecent.length} rows dated from the first snapshot's recentFrom ` +
      `${selected.firstRecentFrom} (${classesLine(selected.sinceFirstRecent, stored)}): the fixed poller's, ` +
      "mostly detail lag; they come in with the bills' next updates",
  );
  log(
    `Apart, not sent: ${selected.newForPoller.length} missing rows updated from the verification's recentFrom ` +
      `${selected.verifyRecentFrom}: new bills the poller is fetching (a quiet window would drop their "new" push)` +
      `${selected.newForPoller.length > 0 ? `: ${list(selected.newForPoller)}` : ""}`,
  );
  const passed = selected.leftovers.length === 0;
  const counts = countsByClass(selected.leftovers);
  log(
    `Leftovers summary: outcome=${passed ? "pass" : "leftovers"} leftovers=${selected.leftovers.length} ` +
      `missing=${counts.missing} stale=${counts.stale} stale_same_day=${counts.stale_same_day} ` +
      `unresolved=${counts.unresolved} since_first_recent=${selected.sinceFirstRecent.length} ` +
      `new_for_poller=${selected.newForPoller.length} file=${outPath}`,
  );
  return { ...selected, file: outPath, passed };
};

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else runLeftovers({ options });
  } catch (error) {
    console.error("Backfill leftovers failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
