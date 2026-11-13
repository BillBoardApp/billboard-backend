import { resolve as resolvePath } from "node:path";

import {
  DEFAULT_OUT,
  LEFTOVERS_TITLE,
  USAGE,
  parseArgs,
  runLeftovers,
  selectLeftovers,
} from "../../scripts/listBackfillLeftovers";
import { parseGuidsFile } from "../../scripts/reconcileProcessedBills";
import {
  formatSnapshot,
  parseSnapshot,
  type SnapshotEntry,
  type SnapshotSettings,
} from "../../scripts/skippedBillSnapshot";

// The first snapshot listed to 2026-11-12T12:00Z, so it answered for rows before 11-10T12:00Z; the fixed poller for
// the rest. The verification listed to 12-23T12:00Z, its own recent rows from 12-21T12:00Z.
const FIRST_RECENT_FROM = "2026-11-10T12:00:00.000Z";
const VERIFY_RECENT_FROM = "2026-12-21T12:00:00.000Z";

const settings = (overrides: Partial<SnapshotSettings> = {}): SnapshotSettings => ({
  congress: "119",
  cutoff: "2026-03-05T00:00:00.000Z",
  top: "2026-11-12T12:00:00.000Z",
  listedAt: "2026-11-12T12:10:00.000Z",
  rowTimes: "date",
  requests: 10,
  types: "hr,s",
  recentHours: 48,
  recentFrom: FIRST_RECENT_FROM,
  ...overrides,
});
const VERIFY_SETTINGS = {
  top: "2026-12-23T12:00:00.000Z",
  listedAt: "2026-12-23T12:30:00.000Z",
  recentFrom: VERIFY_RECENT_FROM,
};

const listRow = (guid: string, updateDate: string, updateDateIncludingText = updateDate) => {
  const [, type, number] = guid.match(/^BILLS-119([a-z]+)(\d+)$/)!;
  return {
    congress: 119,
    number,
    type: type.toUpperCase(),
    title: `Title of ${guid}`,
    updateDate,
    updateDateIncludingText,
  };
};
const entry = (guid: string, cls: SnapshotEntry["cls"], rowTime: string, updateDate = rowTime): SnapshotEntry => ({
  guid,
  cls,
  rowTime,
  storedTime: cls === "missing" ? null : "2026-04-01T00:00:00.000Z",
  row: listRow(guid, updateDate),
});
const snapshotText = (entries: SnapshotEntry[], overrides: Partial<SnapshotSettings> = {}) =>
  formatSnapshot(settings(overrides), ["# counts x"], entries);

const FIRST_TEXT = snapshotText([entry("BILLS-119hr1", "missing", "2026-05-01")]);

/** The verification's rows, newest first, as list:skipped-bill-updates writes them. */
const VERIFY_ENTRIES = [
  // Missing, updated within the verification's own recent hours: a new bill the poller is fetching (apart).
  entry("BILLS-119hr40000", "missing", "2026-12-22"),
  // Missing, updated on the day the verification's recent hours start: its midnight is before 12:00, so a leftover.
  entry("BILLS-119hr40001", "missing", "2026-12-21"),
  // A text-only change within the recent hours: the poller never listed it (updateDate 11-30), so a leftover.
  {
    ...entry("BILLS-119hr40002", "missing", "2026-12-22"),
    row: listRow("BILLS-119hr40002", "2026-11-30", "2026-12-22"),
  },
  // Stale since the first snapshot's recentFrom: the fixed poller's (apart).
  entry("BILLS-119hr20000", "stale", "2026-11-13"),
  entry("BILLS-119hr20001", "stale_same_day", "2026-11-12T01:00:00.000Z"),
  entry("BILLS-119hr20002", "unresolved", "2026-11-11"),
  entry("BILLS-119hr20003", "stale", "2026-11-10T12:00:00.000Z"),
  // On the first snapshot's recentFrom day, a date alone: its midnight is before 12:00, so the first snapshot's.
  entry("BILLS-119hr20004", "stale", "2026-11-10"),
  // Missing between the two recentFroms: the poller should have stored it, so a leftover.
  entry("BILLS-119s20005", "missing", "2026-11-11"),
  // The first snapshot's: still stale or unresolved, so leftovers.
  entry("BILLS-119hr400", "stale", "2026-05-05"),
  entry("BILLS-119s401", "stale_same_day", "2026-05-04T10:00:00.000Z"),
  entry("BILLS-119hr402", "unresolved", "2026-05-03"),
  entry("BILLS-119hr403", "missing", "2026-05-02"),
  // No update date: kept.
  entry("BILLS-119hr404", "stale", "-"),
];
const LEFTOVER_GUIDS = [
  "BILLS-119hr40001",
  "BILLS-119hr40002",
  "BILLS-119hr20004",
  "BILLS-119s20005",
  "BILLS-119hr400",
  "BILLS-119s401",
  "BILLS-119hr402",
  "BILLS-119hr403",
  "BILLS-119hr404",
];

const FIRST = "/fake/rel56-snapshot.tsv";
const VERIFY = "/fake/rel56-verify.tsv";
const OUT = "/fake/rel56-leftovers.txt";

const files = (verifyEntries = VERIFY_ENTRIES, verifyOverrides: Partial<SnapshotSettings> = VERIFY_SETTINGS) =>
  new Map<string, string>([
    [FIRST, FIRST_TEXT],
    [VERIFY, snapshotText(verifyEntries, verifyOverrides)],
  ]);

const run = (fileMap: Map<string, string>, out = OUT) => {
  const lines: string[] = [];
  const result = runLeftovers({
    options: parseArgs(["--first", FIRST, "--verify", VERIFY, "--out", out]),
    readFile: (path) => fileMap.get(path) ?? null,
    writeFile: (path, text) => void fileMap.set(path, text),
    log: (line) => lines.push(line),
  });
  return { result, lines, text: lines.join("\n") };
};

describe("list:backfill-leftovers", () => {
  it("parses its flags, and needs both snapshots", () => {
    expect(parseArgs(["--first", "a.tsv", "--verify", "b.tsv"])).toEqual({
      help: false,
      first: "a.tsv",
      verify: "b.tsv",
      out: DEFAULT_OUT,
    });
    expect(DEFAULT_OUT).toBe("rel56-leftovers.txt");
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(() => parseArgs(["--first", "a.tsv"])).toThrow("Pass --first");
    expect(() => parseArgs(["--verify", "b.tsv"])).toThrow("Pass --first");
    expect(() => parseArgs(["--first", "--verify", "b.tsv"])).toThrow("--first needs a value");
    expect(() => parseArgs(["--first", "a", "--verify", "b", "--apply"])).toThrow("Unknown argument: --apply");
    expect(USAGE).toContain("--first rel56-snapshot.tsv --verify rel56-verify.tsv");
  });

  it("sends every missing row and the first snapshot's still-stale rows, and reports the rest apart", () => {
    const fileMap = files();
    const { result, text } = run(fileMap);
    expect(result.leftovers.map((leftover) => leftover.guid)).toEqual(LEFTOVER_GUIDS);
    expect(result.sinceFirstRecent.map((apart) => apart.guid)).toEqual([
      "BILLS-119hr20000",
      "BILLS-119hr20001",
      "BILLS-119hr20002",
      "BILLS-119hr20003",
    ]);
    expect(result.newForPoller.map((apart) => apart.guid)).toEqual(["BILLS-119hr40000"]);
    expect(result.passed).toBe(false);
    expect(text).toContain(
      "Apart, not sent: 4 rows dated from the first snapshot's recentFrom 2026-11-10T12:00:00.000Z " +
        "(stale=2 stale_same_day=1 unresolved=1): the fixed poller's, mostly detail lag; they come in with the " +
        "bills' next updates",
    );
    expect(text).toContain(
      "Apart, not sent: 1 missing rows updated from the verification's recentFrom 2026-12-21T12:00:00.000Z: new bills " +
        'the poller is fetching (a quiet window would drop their "new" push): BILLS-119hr40000 (missing 2026-12-22)',
    );
    expect(text).toContain(
      `Leftovers summary: outcome=leftovers leftovers=9 missing=4 stale=3 stale_same_day=1 unresolved=1 ` +
        `since_first_recent=4 new_for_poller=1 file=${OUT}`,
    );
    // The file: a guids file of exactly the leftovers, in the verification's order.
    const written = fileMap.get(OUT)!;
    expect(parseGuidsFile(written)).toEqual(LEFTOVER_GUIDS);
    const verifySha = parseSnapshot(fileMap.get(VERIFY)!).sha256;
    expect(written.split("\n").slice(0, 6)).toEqual([
      LEFTOVERS_TITLE,
      `# first=${FIRST} sha256=${parseSnapshot(FIRST_TEXT).sha256} recentFrom=${FIRST_RECENT_FROM}`,
      `# verify=${VERIFY} sha256=${verifySha} top=2026-12-23T12:00:00.000Z recentFrom=${VERIFY_RECENT_FROM}`,
      "# leftovers=9 missing=4 stale=3 stale_same_day=1 unresolved=1",
      "# columns: guid, class, row time",
      "BILLS-119hr40001\tmissing\t2026-12-21",
    ]);
  });

  it("keeps the real leftovers however many of the poller's lagged rows there are", () => {
    // 900 rows the fixed poller fetched with a lagged copy, dated after the first snapshot's recentFrom, ahead of
    // five May bills still stale. Bounded by window 1's date, all 905 were leftovers, the May ones last.
    const lagged = Array.from({ length: 900 }, (_, index) =>
      entry(`BILLS-119hr${30000 + index}`, "stale", `2026-11-${String(11 + (index % 3)).padStart(2, "0")}`),
    );
    const may = Array.from({ length: 5 }, (_, index) =>
      entry(`BILLS-119hr${500 + index}`, "stale", `2026-05-0${5 - index}`),
    );
    const { result } = run(files([...lagged, ...may]));
    expect(result.leftovers.map((leftover) => leftover.guid)).toEqual(may.map((leftover) => leftover.guid));
    expect(result.sinceFirstRecent).toHaveLength(900);
  });

  it("passes when nothing is left over", () => {
    const fileMap = files([
      entry("BILLS-119hr40000", "missing", "2026-12-22"),
      entry("BILLS-119hr20000", "stale", "2026-11-13"),
    ]);
    const { result, text } = run(fileMap);
    expect(result.passed).toBe(true);
    expect(text).toContain("Leftovers summary: outcome=pass leftovers=0 ");
    expect(parseGuidsFile(fileMap.get(OUT)!)).toEqual([]);
  });

  it("refuses snapshots that do not belong together", () => {
    const first = parseSnapshot(FIRST_TEXT);
    const verify = (overrides: Partial<SnapshotSettings>) =>
      parseSnapshot(snapshotText(VERIFY_ENTRIES, { ...VERIFY_SETTINGS, ...overrides }));
    expect(() => selectLeftovers(first, first)).toThrow("--first and --verify are the same snapshot");
    const other = parseSnapshot(snapshotText([], { ...VERIFY_SETTINGS, congress: "120" }));
    expect(() => selectLeftovers(first, other)).toThrow("other Congresses: 119 and 120");
    expect(() => selectLeftovers(first, verify({ cutoff: "2025-01-03T00:00:00.000Z" }))).toThrow(
      "other cutoffs: 2026-03-05T00:00:00.000Z and 2025-01-03T00:00:00.000Z",
    );
    expect(() => selectLeftovers(verify({}), first)).toThrow("was not listed after the first");
    const noRecent = parseSnapshot(FIRST_TEXT.replace(` recentFrom=${FIRST_RECENT_FROM}`, ""));
    expect(() => selectLeftovers(noRecent, verify({}))).toThrow("The first snapshot's settings line has no recentFrom");
  });

  it("never replaces another file, and rewrites its own", () => {
    const fileMap = files();
    fileMap.set(OUT, "# something else\n");
    expect(() => run(fileMap)).toThrow(`${OUT} exists and is not a leftovers file`);
    expect(() => run(fileMap, FIRST)).toThrow("--out must not be one of the snapshots");
    fileMap.delete(OUT);
    run(fileMap);
    const { result } = run(fileMap);
    expect(result.leftovers).toHaveLength(LEFTOVER_GUIDS.length);
    expect(() => run(new Map([[VERIFY, fileMap.get(VERIFY)!]]))).toThrow(
      `The first snapshot ${resolvePath(FIRST)} does not exist`,
    );
  });
});
