import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import {
  DEFAULT_CONCURRENCY,
  configFromEnv,
  defaultKeysFile,
  documentDate,
  isCandidate,
  parseArgs,
  predictReplay,
  runListVetoedBills,
  summaryLine,
} from "../../scripts/listVetoedBills";
import type { ProcessedBillDocument, RawBill } from "../models/bill";
import { deriveBillVetoedFromActions } from "../shared/billOutcomes";
import { applyDerivedFields } from "../shared/billSourceReconcile";
import { billContentHash, formatDateBasis, manifestDateBasis } from "../shared/billVersionChange";

/*
 * list:vetoed-bills (project decision 2026-11-19): lists the vetoed bills' manifest rows, whether each carries the
 * vetoed flag, and what a rows-only replay would do to each; writes the keys of the rows a replay can safely fix.
 * Strictly read-only: one Query and GetObjects, never a write.
 */

type Item = Record<string, AttributeValue>;
type Doc = Record<string, unknown>;

/** What the fakes read from an AWS SDK command: its class's name and its input. */
interface FakeCommand<Input> {
  constructor: { name: string };
  input: Input;
}
interface FakeQueryInput {
  TableName?: string;
  ConsistentRead?: boolean;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ExclusiveStartKey?: { page: { N: string } };
}

const config = configFromEnv({});
const NOW = new Date("2026-11-20T15:00:00.000Z");
const TEXT_HASH = "v1:0b6f1c1d2a3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccdd";
const METADATA = { "source-text-hash": TEXT_HASH };

// H.R. 131's lines as stored (texts shortened), newest first: vetoed, then the House failed to override.
const FAILED_OVERRIDE = {
  actionCode: "33000",
  actionDate: "2026-01-08",
  text: "Failed of passage in House over veto.",
  type: "Veto",
};
const VETO = [
  { actionCode: "E30000", actionDate: "2025-12-29", text: "Vetoed by President.", type: "President" },
  { actionCode: "31000", actionDate: "2025-12-29", text: "Vetoed by President.", type: "President" },
];
const PASSAGES = [
  { actionCode: "28000", actionDate: "2025-12-18", text: "Presented to President.", type: "President" },
  { actionCode: "17000", actionDate: "2025-12-16", text: "Passed/agreed to in Senate.", type: "Floor" },
  { actionCode: "8000", actionDate: "2025-07-21", text: "Passed/agreed to in House.", type: "Floor" },
];
const LAW = { actionCode: "36000", actionDate: "2026-01-20", text: "Became Public Law No: 119-90.", type: "BecameLaw" };
// A veto whose passage lines carry no Library of Congress code: its actions derive New.
const PRESENTED_ONLY = [PASSAGES[0]];

const numberOf = (guid: string): string => guid.replace(/^BILLS-\d{3}[a-z]+/, "");
const typeOf = (guid: string): string => guid.replace(/^BILLS-\d{3}([a-z]+)\d+.*$/, "$1");

/** A processed bill. */
const doc = (guid: string, storedAt: string, billStatus: string, actions: unknown[], extra: Doc = {}): Doc => ({
  kind: "processed",
  storedAt,
  identifier: { congress: "119", billType: typeOf(guid), billNumber: numberOf(guid) },
  guid,
  title: `Headline of ${guid}`,
  subCategories: ["Healthcare"],
  lifeAreas: [],
  sponsors: ["B001318"],
  cosponsors: [],
  actions,
  committees: [],
  billStatus,
  ...extra,
});

/**
 * A BILL row for `document` at `updatedAt`, as CreateBillsManifest writes it (hash, basis and documentStoredAt of
 * `reflects`, by default the document), or as a release before 2026-10-14 did (`legacy`: none of the three).
 */
const row = (
  document: Doc,
  {
    updatedAt = String(document.storedAt),
    reflects = document,
    legacy = false,
    vetoed = false,
    billType = typeOf(String(document.guid)),
    guid = String(document.guid),
  }: { updatedAt?: string; reflects?: Doc; legacy?: boolean; vetoed?: boolean; billType?: string; guid?: string } = {},
): Item => ({
  pk: { S: "BILL" },
  sk: { S: `${updatedAt}#${guid}` },
  guid: { S: guid },
  billType: { S: billType },
  congress: { S: "119" },
  billNumber: { S: numberOf(guid) },
  updatedAt: { S: updatedAt },
  title: { S: String(document.title) },
  subCategories: { L: [{ S: "Healthcare" }] },
  lifeAreas: { L: [] },
  sponsors: { L: [{ S: "B001318" }] },
  cosponsors: { L: [] },
  voteCount: { N: "3" },
  ...(document.billStatus ? { billStatus: { S: String(document.billStatus) } } : {}),
  ...(vetoed ? { vetoed: { BOOL: true } } : {}),
  ...(legacy
    ? {}
    : {
        contentHash: { S: billContentHash(reflects) },
        dateBasis: { S: formatDateBasis(manifestDateBasis(reflects, TEXT_HASH)) },
        documentStoredAt: { S: String(reflects.storedAt) },
      }),
});

const fakeTable = (rows: Item[]) => {
  const names: string[] = [];
  const send = jest.fn(async (command: FakeCommand<FakeQueryInput>) => {
    names.push(command.constructor.name);
    if (command.constructor.name !== "QueryCommand")
      throw new Error(`Unexpected DynamoDB command ${command.constructor.name}`);
    expect(command.input.TableName).toBe("BillsManifest");
    expect(command.input.ConsistentRead).toBe(true);
    expect(command.input.ExpressionAttributeValues![":pk"]).toEqual({ S: "BILL" });
    // Pages of two, as DynamoDB pages a large partition.
    const start = command.input.ExclusiveStartKey ? Number(command.input.ExclusiveStartKey.page.N) : 0;
    return {
      Items: rows.slice(start, start + 2).map((item) => structuredClone(item)),
      ...(start + 2 < rows.length ? { LastEvaluatedKey: { page: { N: String(start + 2) } } } : {}),
    };
  });
  return { db: { send }, names };
};

const fakeS3 = (docs: Record<string, Doc>) => {
  const names: string[] = [];
  const keys: string[] = [];
  const send = jest.fn(async (command: FakeCommand<{ Bucket?: string; Key?: string }>) => {
    names.push(command.constructor.name);
    if (command.constructor.name !== "GetObjectCommand")
      throw new Error(`Unexpected S3 command ${command.constructor.name}`);
    expect(command.input.Bucket).toBe("billboard-bill-store-bucket");
    keys.push(command.input.Key!);
    const guid = String(command.input.Key)
      .replace(/^processed-bills\//, "")
      .replace(/\.json$/, "");
    const body = docs[guid];
    if (!body) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    return { Body: { transformToString: async () => JSON.stringify(body) }, Metadata: METADATA };
  });
  return { s3: { send }, names, keys };
};

const files = () => {
  const store = new Map<string, string>();
  return {
    store,
    createFile: (path: string, text: string) => {
      if (store.has(path)) throw new Error(`EEXIST: ${path}`);
      store.set(path, text);
    },
  };
};

const run = async (argv: string[], rows: Item[], docs: Record<string, Doc>, fs = files()) => {
  const table = fakeTable(rows);
  const s3 = fakeS3(docs);
  const log = jest.fn();
  const result = await runListVetoedBills({
    db: table.db,
    s3: s3.s3,
    config,
    options: parseArgs(argv),
    log,
    now: () => NOW,
    createFile: fs.createFile,
  });
  return { result, lines: log.mock.calls.map((call) => String(call[0])), table, s3, fs };
};

// ─── The world ───────────────────────────────────────────────────────────────

const IN_PLACE = "BILLS-119hr131"; // vetoed, its row dated by its document, no flag yet
const KEPT = "BILLS-119hr504"; // vetoed, a version with committees only kept its row's date, no flag yet
const FLAGGED = "BILLS-119hr600"; // vetoed, its row already carries the flag
const MAY_MOVE = "BILLS-119sjres10"; // vetoed, a legacy row (no hash, no basis) older than its document
const NEWS = "BILLS-119hjres11"; // vetoed, its row reflects the version before the veto (a missed write)
const SKIPPED = "BILLS-119s20"; // vetoed, its row dated after its document
const SLUG = "BILLS-119hr21"; // vetoed, a March row typed by its slug and dated 0.7 s after its document
const STALE = "BILLS-119hr700"; // the row carries the flag, but the bill became law after the override
const UPDATED = "BILLS-119hr301"; // vetoed, stored Updated (billDiffer keeps it as stored), no flag yet
const UNCODED = "BILLS-119s302"; // vetoed, its passage lines not coded so it derives New, no flag yet
const OPEN = "BILLS-119hr224"; // Passed and presented, not vetoed
const NEW_BILL = "BILLS-119hr900"; // New and not vetoed: read, not listed
const RESOLUTION = "BILLS-119hres5"; // a simple resolution: never vetoed, not a candidate
const LAW_BILL = "BILLS-119hr800"; // Finalized: not a candidate

const world = () => {
  const vetoedActions = [FAILED_OVERRIDE, ...VETO, ...PASSAGES];
  const docs: Record<string, Doc> = {
    [IN_PLACE]: doc(IN_PLACE, "2026-11-13T05:00:00.000Z", "Failed", vetoedActions),
    [KEPT]: doc(KEPT, "2026-11-17T05:00:00.000Z", "Failed", vetoedActions, {
      committees: [{ name: "Energy and Commerce Committee" }],
    }),
    [FLAGGED]: doc(FLAGGED, "2026-01-09T05:00:00.000Z", "Failed", vetoedActions),
    [MAY_MOVE]: doc(MAY_MOVE, "2026-01-09T05:00:00.000Z", "Passed", [...VETO, ...PASSAGES]),
    [NEWS]: doc(NEWS, "2026-01-09T05:00:00.000Z", "Passed", [...VETO, ...PASSAGES]),
    [SKIPPED]: doc(SKIPPED, "2026-01-09T05:00:00.000Z", "Failed", vetoedActions),
    [SLUG]: doc(SLUG, "2026-03-19T16:57:53.915Z", "Passed", [...VETO, ...PASSAGES]),
    [STALE]: doc(STALE, "2026-01-21T05:00:00.000Z", "Finalized", [LAW, ...VETO, ...PASSAGES]),
    [UPDATED]: doc(UPDATED, "2026-11-18T05:00:00.000Z", "Updated", vetoedActions),
    [UNCODED]: doc(UNCODED, "2026-01-09T05:00:00.000Z", "New", [...VETO, ...PRESENTED_ONLY]),
    [OPEN]: doc(OPEN, "2026-01-13T05:00:00.000Z", "Passed", PASSAGES),
    [NEW_BILL]: doc(NEW_BILL, "2026-01-13T05:00:00.000Z", "New", []),
    [RESOLUTION]: doc(RESOLUTION, "2026-01-13T05:00:00.000Z", "Passed", PASSAGES),
    [LAW_BILL]: doc(LAW_BILL, "2026-01-21T05:00:00.000Z", "Finalized", [LAW, ...PASSAGES]),
  };
  const keptBase = { ...docs[KEPT], storedAt: "2026-01-09T05:00:00.000Z", committees: [] };
  const beforeVeto = doc(NEWS, "2025-12-19T05:00:00.000Z", "Passed", PASSAGES);
  const rows = [
    row(docs[IN_PLACE]),
    row(docs[KEPT], { updatedAt: String(keptBase.storedAt), reflects: keptBase }),
    row(docs[FLAGGED], { vetoed: true }),
    row(docs[MAY_MOVE], { updatedAt: "2026-01-08T00:00:00.000Z", legacy: true }),
    row(docs[NEWS], { updatedAt: String(beforeVeto.storedAt), reflects: beforeVeto }),
    row(docs[SKIPPED], {
      updatedAt: "2026-01-09T05:00:10.000Z",
      reflects: { ...docs[SKIPPED], title: "Another headline" },
    }),
    row(docs[SLUG], { updatedAt: "2026-03-19T16:57:54.669Z", billType: "house-bill", legacy: true }),
    row(docs[STALE], { vetoed: true }),
    row(docs[UPDATED]),
    row(docs[UNCODED]),
    row(docs[OPEN]),
    row(docs[NEW_BILL]),
    row(docs[RESOLUTION]),
    row(docs[LAW_BILL]),
  ];
  return { rows, docs };
};

const keyOf = (guid: string) => `processed-bills/${guid}.json`;

describe("parseArgs", () => {
  it("lists every row by default, with the default concurrency and keys file", () => {
    expect(parseArgs([])).toEqual({ help: false, guids: [], concurrency: DEFAULT_CONCURRENCY, keysFile: null });
    expect(parseArgs(["--keys-file", "k.txt", "--concurrency", "4"])).toMatchObject({
      keysFile: "k.txt",
      concurrency: 4,
    });
  });

  it("refuses what it does not know, so a mistyped flag never runs, and has no write mode to ask for", () => {
    for (const flag of ["--apply", "--dry-run", "--force", "--undo", "BILLS-119hr131"]) {
      expect(() => parseArgs([flag])).toThrow(`Unknown argument: ${flag}`);
    }
    expect(parseArgs(["--guid", "BILLS-119hr131enr", "--guid", "BILLS-119hr131"]).guids).toEqual(["BILLS-119hr131"]);
    expect(() => parseArgs(["--guid", "H.R. 131"])).toThrow("--guid needs a bill guid");
    expect(() => parseArgs(["--concurrency", "40"])).toThrow("--concurrency needs a whole number from 1 to 16");
    expect(() => parseArgs(["--keys-file"])).toThrow("--keys-file needs a file path");
  });

  it("names its keys file by the UTC time", () => {
    expect(defaultKeysFile(NOW)).toBe("vetoed-bills-keys-20261120T150000Z.txt");
  });
});

describe("isCandidate", () => {
  const candidate = (fields: Item) => isCandidate({ guid: { S: "BILLS-119hr1" }, ...fields });

  it("reads bills and joint resolutions of every status but Finalized, none or unknown included, slugs included", () => {
    for (const billType of [
      "hr",
      "s",
      "hjres",
      "sjres",
      "house-bill",
      "senate-bill",
      "house-joint-resolution",
      "S.J.Res.",
    ]) {
      // The flag never reads the status: a stored Updated (which billDiffer keeps), a New whose passage lines carry
      // no code, or a value no release writes still gets it at the row's next write, so missing= must count the row.
      for (const billStatus of ["Passed", "Failed", "Updated", "New", "", "Pending", undefined]) {
        expect(
          candidate({
            billType: { S: billType },
            ...(billStatus !== undefined ? { billStatus: { S: billStatus } } : {}),
          }),
        ).toBe(true);
      }
      expect(candidate({ billType: { S: billType }, billStatus: { NULL: true } })).toBe(true);
    }
  });

  it("leaves out a law and the other types, unless the row carries the flag", () => {
    expect(candidate({ billType: { S: "hr" }, billStatus: { S: "Finalized" } })).toBe(false);
    expect(candidate({ billType: { S: "hr" }, billStatus: { S: "Finalized" }, vetoed: { BOOL: true } })).toBe(true);
    for (const billType of ["hres", "sres", "hconres", "sconres", "house-resolution", "", "xyz"]) {
      for (const billStatus of ["Passed", "Updated", "New"]) {
        expect(candidate({ billType: { S: billType }, billStatus: { S: billStatus } })).toBe(false);
      }
    }
    expect(candidate({ billType: { S: "hres" }, vetoed: { BOOL: true } })).toBe(true);
    expect(candidate({ billType: { S: "hr" }, billStatus: { S: "Finalized" }, vetoed: { BOOL: false } })).toBe(false);
  });

  it("reads a vetoed bill whose stored Updated status billDiffer keeps when the veto arrives", () => {
    const stored = doc(UPDATED, "2025-12-19T05:00:00.000Z", "Updated", PASSAGES) as unknown as ProcessedBillDocument;
    const rawBill = { content: { actions: { actions: [...VETO, ...PASSAGES] } } } as unknown as RawBill;
    const next = applyDerivedFields(stored, rawBill);
    expect(next.billStatus).toBe("Updated");
    expect(deriveBillVetoedFromActions(next.actions)).toBe(true);
    expect(isCandidate(row(next as unknown as Doc))).toBe(true);
  });
});

describe("predictReplay", () => {
  const stored = (document: Doc) => ({ document, metadata: METADATA });
  const vetoed = doc(IN_PLACE, "2026-11-13T05:00:00.000Z", "Failed", [FAILED_OVERRIDE, ...VETO, ...PASSAGES]);

  it("is in place for a row dated by the document, or a March row dated up to 3 s after it", () => {
    expect(predictReplay(row(vetoed), stored(vetoed), NOW)).toEqual({
      outcome: "in place",
      why: "dated by this document",
    });
    expect(
      predictReplay(row(vetoed, { updatedAt: "2026-11-13T05:00:02.100Z", legacy: true }), stored(vetoed), NOW).outcome,
    ).toBe("in place");
    expect(predictReplay(row(vetoed, { updatedAt: "2026-11-13T05:00:02.100Z" }), stored(vetoed), NOW).outcome).toBe(
      "in place",
    );
  });

  it("is kept for an older row the document brings no news to, by its basis or else an equal hash", () => {
    const earlier = { ...vetoed, storedAt: "2026-01-09T05:00:00.000Z" };
    expect(
      predictReplay(row(vetoed, { updatedAt: String(earlier.storedAt), reflects: earlier }), stored(vetoed), NOW),
    ).toEqual({
      outcome: "kept",
      why: "no news against the d2 basis",
    });
    const hashOnly = row(vetoed, { updatedAt: String(earlier.storedAt), reflects: earlier });
    delete hashOnly.dateBasis;
    expect(predictReplay(hashOnly, stored(vetoed), NOW)).toEqual({
      outcome: "kept",
      why: "no basis; the same contentHash",
    });
  });

  it("may move an older row the document brings news to, or one it cannot judge", () => {
    const beforeOverride = {
      ...vetoed,
      storedAt: "2026-01-01T05:00:00.000Z",
      billStatus: "Passed",
      actions: [...VETO, ...PASSAGES],
    };
    const news = predictReplay(
      row(vetoed, { updatedAt: "2026-01-01T05:00:00.000Z", reflects: beforeOverride }),
      stored(vetoed),
      NOW,
    );
    expect(news).toEqual({ outcome: "may move", why: "news against the d2 basis: status, newerAction" });

    const legacy = predictReplay(
      row(vetoed, { updatedAt: "2026-01-09T05:00:00.000Z", legacy: true }),
      stored(vetoed),
      NOW,
    );
    expect(legacy.outcome).toBe("may move");

    // Another text version only: the raw copies decide.
    const otherText = row(vetoed, { updatedAt: "2026-01-09T05:00:00.000Z" });
    otherText.dateBasis = { S: formatDateBasis(manifestDateBasis(vetoed, "v1:another")) };
    expect(predictReplay(otherText, stored(vetoed), NOW)).toEqual({
      outcome: "may move",
      why: "a new text version only; the raw copies decide",
    });

    // A d1 basis that cannot tell a citation edit from another action on the latest day.
    const d1 = row(vetoed, { updatedAt: "2026-01-09T05:00:00.000Z" });
    d1.dateBasis = { S: "d1|Failed|2026-01-08|0000abcd|" };
    expect(predictReplay(d1, stored(vetoed), NOW).outcome).toBe("may move");
  });

  it("is skipped for a row dated after its document, one that reflects a newer document, or a suffixed guid's row", () => {
    const later = row(vetoed, {
      updatedAt: "2026-11-13T05:00:10.000Z",
      reflects: { ...vetoed, title: "Another headline" },
    });
    expect(predictReplay(later, stored(vetoed), NOW)).toEqual({
      outcome: "skipped",
      why: "the row is dated after its document",
    });
    // Up to 3 s after, but with another document's hash: not the row's own version.
    const otherHash = row(vetoed, {
      updatedAt: "2026-11-13T05:00:01.000Z",
      reflects: { ...vetoed, title: "Another headline" },
    });
    expect(predictReplay(otherHash, stored(vetoed), NOW).outcome).toBe("skipped");

    const newer = row(vetoed, { updatedAt: "2026-01-09T05:00:00.000Z" });
    newer.documentStoredAt = { S: "2026-11-14T00:00:00.000Z" };
    expect(predictReplay(newer, stored(vetoed), NOW)).toEqual({
      outcome: "skipped",
      why: "the row reflects a newer document",
    });

    const suffixed = row(vetoed, { guid: "BILLS-119hr131enr" });
    expect(predictReplay(suffixed, stored(vetoed), NOW)).toEqual({
      outcome: "skipped",
      why: "a row of the suffixed guid; the replay writes BILLS-119hr131's",
    });
  });

  it("dates a document as CreateBillsManifest does, and one without a date by the time the replay runs", () => {
    expect(documentDate({ storedAt: "2026-11-13T05:00:00Z" })).toBe("2026-11-13T05:00:00.000Z");
    expect(documentDate({ content: { rawSnapshot: { storedAt: "2026-11-13T05:00:00.000Z" } } })).toBe(
      "2026-11-13T05:00:00.000Z",
    );
    expect(documentDate({ metadata: { fetchedAt: "2026-11-12T05:00:00.000Z" } })).toBe("2026-11-12T05:00:00.000Z");
    expect(documentDate({ storedAt: "soon" })).toBeNull();
    const undated = { ...vetoed, storedAt: undefined };
    expect(
      predictReplay(row(vetoed, { updatedAt: "2026-11-13T05:00:00.000Z", legacy: true }), stored(undated), NOW).outcome,
    ).toBe("may move");
  });
});

describe("the listing", () => {
  it("lists every vetoed bill's row and stale row, and writes the keys a replay can safely fix", async () => {
    const { rows, docs } = world();
    const { result, fs, lines } = await run(["--keys-file", "keys.txt"], rows, docs);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual({
      rows: 14,
      candidates: 12,
      vetoed: 9,
      missing: 8,
      stale: 1,
      unpredictable: 3,
      unreadable: 0,
    });
    // Sorted, one key per line, as backfill:bills-manifest --keys-file reads them: the missing rows a replay
    // rewrites at their own key (the Updated and New ones too), and the stale one. Not the flagged row, nor the rows
    // a replay may move or skips.
    const replayed = [IN_PLACE, SLUG, KEPT, UPDATED, UNCODED, STALE];
    expect(fs.store.get("keys.txt")).toBe(replayed.map(keyOf).sort().join("\n") + "\n");
    expect(result.keys).toEqual(replayed.map(keyOf).sort());
    expect(lines[lines.length - 1]).toBe(
      "Vetoed rows: rows=14 candidates=12 vetoed=9 missing=8 stale=1 unpredictable=3 unreadable=0",
    );
  });

  it("prints each row's veto, flag, basis, hash, date and predicted replay", async () => {
    const { rows, docs } = world();
    const { lines } = await run(["--keys-file", "keys.txt"], rows, docs);

    expect(lines).toContain(
      `  missing ${IN_PLACE} Failed: veto 2025-12-29 (31000); row flag no; basis d2; hash equal yes; ` +
        "row after document no; replay: in place (dated by this document)",
    );
    expect(lines).toContain(
      `  missing ${KEPT} Failed: veto 2025-12-29 (31000); row flag no; basis d2; hash equal no; ` +
        "row after document no; replay: kept (no news against the d2 basis)",
    );
    expect(lines).toContain(
      `  vetoed ${FLAGGED} Failed: veto 2025-12-29 (31000); row flag yes; basis d2; hash equal yes; ` +
        "row after document no; replay: in place (dated by this document)",
    );
    expect(lines).toContain(
      `  missing ${SKIPPED} Failed: veto 2025-12-29 (31000); row flag no; basis d2; hash equal no; ` +
        "row after document yes; replay: skipped (the row is dated after its document)",
    );
    expect(lines).toContain(
      `  missing ${SLUG} Passed: veto 2025-12-29 (31000); row flag no; basis none; hash equal none; ` +
        "row after document yes; replay: in place (the row's own version)",
    );
    expect(lines).toContain(
      `  stale ${STALE} Finalized: veto 2025-12-29 (31000); row flag yes; basis d2; hash equal yes; ` +
        "row after document no; replay: in place (dated by this document)",
    );
    // A vetoed bill keeps a stored Updated, and one whose passage lines carry no code derives New: both are listed.
    expect(lines).toContain(
      `  missing ${UPDATED} Updated: veto 2025-12-29 (31000); row flag no; basis d2; hash equal yes; ` +
        "row after document no; replay: in place (dated by this document)",
    );
    expect(lines).toContain(
      `  missing ${UNCODED} New: veto 2025-12-29 (31000); row flag no; basis d2; hash equal yes; ` +
        "row after document no; replay: in place (dated by this document)",
    );
    expect(lines.find((line) => line.includes(`missing ${NEWS} `))).toContain(
      "replay: may move (news against the d2 basis: newerAction)",
    );
    expect(lines.find((line) => line.startsWith("Not in the keys file"))).toContain(
      `${NEWS} (may move), ${SKIPPED} (skipped), ${MAY_MOVE} (may move)`,
    );
    // A bill that is not vetoed (whatever its status), and the rows that are not candidates, are not listed.
    for (const guid of [OPEN, NEW_BILL, RESOLUTION, LAW_BILL]) {
      expect(lines.some((line) => line.includes(guid))).toBe(false);
    }
  });

  it("only reads: one consistent Query, and a GetObject per candidate; never a write", async () => {
    const { rows, docs } = world();
    const { table, s3 } = await run(["--keys-file", "keys.txt"], rows, docs);

    expect(new Set(table.names)).toEqual(new Set(["QueryCommand"]));
    expect(new Set(s3.names)).toEqual(new Set(["GetObjectCommand"]));
    // Every bill's and joint resolution's document but a law's is read, and the non-candidates' never are.
    expect(s3.keys.sort()).toEqual(
      [IN_PLACE, KEPT, FLAGGED, MAY_MOVE, NEWS, SKIPPED, SLUG, STALE, UPDATED, UNCODED, OPEN, NEW_BILL]
        .map(keyOf)
        .sort(),
    );
  });

  it("names no AWS command but Query and GetObject in its source, so no write can be sent", () => {
    const source = readFileSync(join(__dirname, "../../scripts/listVetoedBills.ts"), "utf8");
    const commands = Array.from(source.matchAll(/\b([A-Z][A-Za-z]+Command)\b/g), (match) => match[1]);
    expect(new Set(commands)).toEqual(new Set(["QueryCommand", "GetObjectCommand"]));
    const imports = Array.from(source.matchAll(/from "(@aws-sdk\/[^"]+)"/g), (match) => match[1]);
    expect(new Set(imports)).toEqual(new Set(["@aws-sdk/client-dynamodb", "@aws-sdk/client-s3"]));
  });

  it("reports a row whose processed bill cannot be read, and exits 1", async () => {
    const { rows, docs } = world();
    delete docs[KEPT];
    const { result, lines, s3 } = await run(["--keys-file", "keys.txt"], rows, docs);

    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({ unreadable: 1, missing: 7 });
    expect(lines).toContain(`  unreadable ${KEPT}: NoSuchKey: The specified key does not exist.`);
    expect(new Set(s3.names)).toEqual(new Set(["GetObjectCommand"]));
  });

  it("with --guid, reads only those bills", async () => {
    const { rows, docs } = world();
    const { result, s3 } = await run(["--guid", IN_PLACE, "--guid", `${OPEN}enr`, "--keys-file", "k.txt"], rows, docs);

    expect(result.summary).toEqual({
      rows: 2,
      candidates: 2,
      vetoed: 1,
      missing: 1,
      stale: 0,
      unpredictable: 0,
      unreadable: 0,
    });
    expect(s3.keys.sort()).toEqual([IN_PLACE, OPEN].map(keyOf).sort());
  });

  it("writes no keys file when no row needs a replay, and never overwrites one", async () => {
    const { rows, docs } = world();
    const done = await run(
      [],
      rows.filter((item) => [FLAGGED, OPEN].includes(item.guid.S!)),
      docs,
    );
    expect(done.result.keysFile).toBeUndefined();
    expect(done.fs.store.size).toBe(0);
    expect(done.lines).toContain("Keys: no row to replay; no keys file written");
    expect(done.lines[done.lines.length - 1]).toBe(
      summaryLine({ rows: 2, candidates: 2, vetoed: 1, missing: 0, stale: 0, unpredictable: 0, unreadable: 0 }),
    );

    // The default name, by the UTC time; a second run in the same second refuses to write over it.
    const fs = files();
    const first = await run([], rows, docs, fs);
    expect(first.result.keysFile).toBe("vetoed-bills-keys-20261120T150000Z.txt");
    await expect(run([], rows, docs, fs)).rejects.toThrow("EEXIST");
  });
});
