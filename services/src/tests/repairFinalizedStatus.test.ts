import { type AttributeValue } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";

import {
  DEFAULT_CONCURRENCY,
  APPLY_REQUIRES_RULE_LIVE,
  DEFAULT_RATE,
  billState,
  configFromEnv,
  defaultPlanFile,
  defaultUndoFile,
  finalizedDocument,
  parseArgs,
  parsePlanFile,
  revertedDocument,
  rowReflectsDocument,
  runCorrelationId,
  runRepair,
  type CliOptions,
  type PlanLine,
  type RunOptions,
  type UndoRecord,
} from "../../scripts/repairFinalizedStatus";
import { BillStorage } from "../adapters/billStorage";
import { billContentHash, manifestSortKey, manifestTimestamp } from "../shared/billVersionChange";
import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

type Item = Record<string, AttributeValue>;
type Doc = Record<string, unknown>;
/** A processed bill as the tests build it: every one has a guid and a storedAt. */
type Bill = Doc & { guid: string; storedAt: string };
/** What the fakes read of an AWS SDK command. */
type FakeCommand = {
  input: { Key?: Item; QueueName?: string; QueueUrl?: string; ConsistentRead?: boolean };
};

const config = configFromEnv({});
/** The run's time. The 7-day window then starts at 2026-10-12T03:00Z, the 28-day one at 2026-09-21T03:00Z. */
const NOW = new Date("2026-10-19T03:00:00.000Z");

const key = (guid: string) => `processed-bills/${guid}.json`;
const SOURCE_METADATA = {
  "correlation-id": "2026-10-11T21:00:00.000Z:BILLS-119hjres131",
  "source-text-hash": "v1:abc",
  "source-raw-version": "raw-v9",
  "source-fetched-at": "2026-10-11T20:59:00.000Z",
};

const LAW_ACTIONS = [
  { actionCode: "E40000", actionDate: "2025-12-11", text: "Became Public Law No: 119-52.", type: "President" },
  { actionCode: "36000", actionDate: "2025-12-11", text: "Became Public Law No: 119-52.", type: "BecameLaw" },
  { actionCode: "E30000", actionDate: "2025-12-11", text: "Signed by President.", type: "President" },
  { actionCode: "28000", actionDate: "2025-12-10", text: "Presented to President.", type: "President" },
  {
    actionCode: "17000",
    actionDate: "2025-12-04",
    text: "Passed/agreed to in Senate: Passed Senate without amendment by Yea-Nay Vote. 49 - 45. Record Vote Number: 632.",
    type: "Floor",
  },
  { actionCode: "1000", actionDate: "2025-10-10", text: "Introduced in House", type: "IntroReferral" },
];
const PASSED_ACTIONS = LAW_ACTIONS.slice(3);

const bill = (guid: string, storedAt: string, changes: Doc = {}): Bill => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt,
  identifier: { congress: "119", billType: "hjres", billNumber: guid.replace(/\D+/g, "").slice(3) },
  guid,
  title: `Bill ${guid}`,
  soWhat: "It changes something.",
  subCategories: ["Energy"],
  lifeAreas: [],
  sponsors: ["R000606"],
  cosponsors: ["C000001"],
  actions: LAW_ACTIONS,
  committees: [],
  billStatus: "Passed",
  ...changes,
});

/** BillsManifest in memory: consistent GetItem only (the script writes no DynamoDB item). */
const fakeTable = () => {
  const items = new Map<string, Item>();
  const id = (item: Item) => `${item.pk.S}|${item.sk.S}`;
  const calls: Array<{ name: string; input: FakeCommand["input"] }> = [];
  const send = jest.fn(async (command: FakeCommand) => {
    const name: string = command.constructor.name;
    calls.push({ name, input: command.input });
    if (name === "GetItemCommand") return { Item: items.get(id(command.input.Key ?? {})) };
    throw new Error(`Unexpected DynamoDB command ${name}`);
  });
  return {
    db: { send } as unknown as RunOptions["db"],
    items,
    calls,
    put: (item: Item) => items.set(id(item), item),
    remove: (item: Item) => items.delete(id(item)),
  };
};
type Table = ReturnType<typeof fakeTable>;

const manifestRow = (guid: string, updatedAt: string, extra: Item = {}): Item => ({
  pk: { S: "BILL" },
  sk: { S: manifestSortKey(updatedAt, guid) },
  guid: { S: guid },
  updatedAt: { S: updatedAt },
  billStatus: { S: "Passed" },
  ...extra,
});

const lookupItem = (guid: string, manifestSk: string): Item => ({
  pk: { S: "BILL_GUID" },
  sk: { S: guid },
  manifestSk: { S: manifestSk },
  updatedAt: { S: manifestSk.split("#")[0] },
});

interface Seed {
  doc: Bill;
  /** The row's date (default: the bill's storedAt); null for no row and no lookup. */
  rowUpdatedAt?: string | null;
  rowExtra?: Item;
  /** The lookup names this sort key instead of the row's; null for no lookup. */
  lookupSk?: string | null;
  metadata?: Record<string, string>;
}

const seed = (table: Table, { doc, rowUpdatedAt, rowExtra, lookupSk, metadata }: Seed): void => {
  mockS3.put(key(doc.guid), doc, metadata ?? SOURCE_METADATA);
  if (rowUpdatedAt === null) return;
  const row = manifestRow(doc.guid, rowUpdatedAt ?? doc.storedAt, rowExtra);
  table.put(row);
  if (lookupSk !== null) table.put(lookupItem(doc.guid, lookupSk ?? row.sk.S!));
};

const fakeQueues = (depths: Record<string, Partial<Record<string, string>>> = {}) => {
  const send = jest.fn(async (command: FakeCommand) => {
    const name: string = command.constructor.name;
    if (name === "GetQueueUrlCommand") return { QueueUrl: `https://sqs.example/${command.input.QueueName}` };
    if (name === "GetQueueAttributesCommand") {
      const queue = (command.input.QueueUrl ?? "").split("/").pop() ?? "";
      return {
        Attributes: {
          ApproximateNumberOfMessages: "0",
          ApproximateNumberOfMessagesNotVisible: "0",
          ApproximateNumberOfMessagesDelayed: "0",
          ...depths[queue],
        },
      };
    }
    throw new Error(`Unexpected SQS command ${name}`);
  });
  return { send };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({ ...parseArgs([]), ...overrides });

interface Harness {
  table: Table;
  sqs?: ReturnType<typeof fakeQueues>;
  storage?: BillStorage;
  clock?: { now: number };
  appendFile?: (path: string, text: string) => void;
  interrupted?: () => boolean;
}

/** Runs the script on the fakes and returns what it printed, wrote and read. */
const run = async (harness: Harness, overrides: Partial<CliOptions> = {}, files = new Map<string, string>()) => {
  const lines: string[] = [];
  const errors: unknown[][] = [];
  const clock = harness.clock ?? { now: NOW.getTime() };
  const s3CallsBefore = mockS3.calls.length;
  const sqs = harness.sqs ?? fakeQueues();
  const result = await runRepair({
    db: harness.table.db,
    storage: harness.storage ?? new BillStorage(new S3Client({}), config.bucket),
    sqs: sqs as unknown as RunOptions["sqs"],
    config,
    options: options(overrides),
    ...(harness.interrupted ? { interrupted: harness.interrupted } : {}),
    log: (...args: unknown[]) =>
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")),
    logError: (...args: unknown[]) => errors.push(args),
    now: () => new Date(clock.now),
    sleep: async (ms: number) => {
      clock.now += ms;
    },
    appendFile: harness.appendFile ?? ((path, text) => files.set(path, (files.get(path) ?? "") + text)),
    createFile: (path, text) => {
      if (files.has(path)) throw new Error(`EEXIST: ${path}`);
      files.set(path, text);
    },
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  });
  return {
    result,
    lines,
    errors,
    files,
    s3Commands: mockS3.calls.slice(s3CallsBefore).map((call) => call.__cmd),
    sqsCommands: sqs.send.mock.calls.map(([command]) => command.constructor.name),
  };
};

const summaryOf = (lines: string[]) => lines.find((line) => line.startsWith("Finalized plan:"));
const planLines = (files: Map<string, string>, path = "plan.jsonl"): PlanLine[] =>
  parsePlanFile(files.get(path)!, config);
const undoLines = (files: Map<string, string>, path = "undo.jsonl"): UndoRecord[] =>
  (files.get(path) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// The three shapes of the production dry run (2026-10-15): a row at the bill's storedAt, a March row dated 0.754 s
// after it, and a row redate:manifest-rows moved back to 2026-05-18 (stamped with the current bill's contentHash).
const EQUAL = bill("BILLS-119hjres131", "2026-07-13T18:37:57.677Z");
const MARCH = bill("BILLS-119hr1", "2026-03-20T12:16:06.945Z");
const MARCH_ROW_AT = "2026-03-20T12:16:07.699Z";
const REDATED = bill("BILLS-119s2392", "2026-10-12T00:41:36.988Z");
const REDATED_ROW_AT = "2026-05-18T05:13:09.418Z";

const seedThree = (table: Table) => {
  seed(table, { doc: EQUAL });
  seed(table, { doc: MARCH, rowUpdatedAt: MARCH_ROW_AT, metadata: {} });
  seed(table, {
    doc: REDATED,
    rowUpdatedAt: REDATED_ROW_AT,
    rowExtra: { contentHash: { S: billContentHash(REDATED) }, voteCount: { N: "3" } },
  });
};

/** A dry run over the three bills; returns the plan file. */
const planThree = async (table: Table) => {
  seedThree(table);
  const files = new Map<string, string>();
  await run({ table }, { planFile: "plan.jsonl" }, files);
  return files;
};

beforeEach(() => {
  mockS3 = new FakeVersionedS3("2026-10-15T00:00:00.000Z");
});

afterEach(() => jest.restoreAllMocks());

describe("repairFinalizedStatus: arguments", () => {
  it("defaults to a dry run of every bill", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      apply: false,
      ruleLive: false,
      guids: [],
      concurrency: DEFAULT_CONCURRENCY,
      rate: DEFAULT_RATE,
      planFile: null,
      undoFile: null,
      undo: null,
    });
    expect([DEFAULT_CONCURRENCY, DEFAULT_RATE, APPLY_REQUIRES_RULE_LIVE]).toEqual([8, 2, true]);
  });

  it("reads every flag", () => {
    expect(
      parseArgs([
        "--apply",
        "--rule-live",
        "--plan-file",
        "plan.jsonl",
        "--guid",
        "BILLS-119hjres131ih",
        "--guid",
        "BILLS-119hjres131",
        "--concurrency",
        "25",
        "--rate",
        "5",
        "--undo-file",
        "undo.jsonl",
      ]),
    ).toEqual(
      options({
        apply: true,
        ruleLive: true,
        planFile: "plan.jsonl",
        guids: ["BILLS-119hjres131"],
        concurrency: 25,
        rate: 5,
        undoFile: "undo.jsonl",
      }),
    );
    expect(parseArgs(["--undo", "undo.jsonl", "--apply", "--dry-run"])).toEqual(options({ undo: "undo.jsonl" }));
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("refuses unknown, malformed and contradictory arguments", () => {
    expect(() => parseArgs(["--aply"])).toThrow("Unknown argument: --aply");
    expect(() => parseArgs(["--apply"])).toThrow(/--apply needs --plan-file/);
    expect(() => parseArgs(["--guid", "hjres131"])).toThrow(/--guid needs a bill guid/);
    expect(() => parseArgs(["--guid"])).toThrow(/--guid needs a bill guid/);
    expect(() => parseArgs(["--rate", "6"])).toThrow(/--rate needs a whole number from 1 to 5/);
    expect(() => parseArgs(["--concurrency", "0"])).toThrow(/--concurrency needs a whole number from 1 to 25/);
    expect(() => parseArgs(["--plan-file"])).toThrow(/--plan-file needs a file path/);
    expect(() => parseArgs(["--undo", "u.jsonl", "--undo-file", "x.jsonl"])).toThrow(/--undo takes neither/);
  });

  it("names the files and the correlation ids after the run, and reads production names by default", () => {
    const at = new Date("2026-10-19T03:00:00.123Z");
    expect(defaultPlanFile(at)).toBe("repair-finalized-status-plan-20261019T030000Z.jsonl");
    expect(defaultUndoFile(at)).toBe("repair-finalized-status-undo-20261019T030000Z.jsonl");
    expect(runCorrelationId(at)).toBe("finalize-rel44-20261019T030000Z");
    expect(runCorrelationId(at, true)).toBe("finalize-rel44-undo-20261019T030000Z");
    expect(config).toEqual({
      region: "us-east-1",
      bucket: "billboard-bill-store-bucket",
      processedPrefix: "processed-bills/",
      manifestTableName: "BillsManifest",
      manifestPrimaryKey: "pk",
      manifestSortKey: "sk",
      manifestPkValue: "BILL",
      guidLookupPk: "BILL_GUID",
      manifestQueueName: "BillsManifestQueue",
      manifestDlqName: "BillsManifestDLQ",
    });
  });
});

describe("repairFinalizedStatus: the rule", () => {
  it("plans only a law stored with a derived status", () => {
    expect(billState(bill("g", "t"))).toBe("candidate");
    expect(billState(bill("g", "t", { billStatus: "New" }))).toBe("candidate");
    expect(billState(bill("g", "t", { billStatus: "" }))).toBe("candidate");
    expect(billState(bill("g", "t", { billStatus: undefined }))).toBe("candidate");
    expect(billState(bill("g", "t", { billStatus: "Finalized" }))).toBe("alreadyFinalized");
    expect(billState(bill("g", "t", { billStatus: "Updated" }))).toBe("unmanagedStatus");
    expect(billState(bill("g", "t", { billStatus: "Finalized", actions: PASSED_ACTIONS }))).toBe("finalizedNotDerived");
    expect(billState(bill("g", "t", { billStatus: "New", actions: PASSED_ACTIONS }))).toBe("otherDrift");
    expect(billState(bill("g", "t", { actions: PASSED_ACTIONS }))).toBe("unchanged");
    expect(billState(bill("g", "t", { billStatus: "Updated", actions: PASSED_ACTIONS }))).toBe("unchanged");
    expect(billState({})).toBe("otherDrift");
  });

  it("changes only billStatus, and storedAt only to the row's date, keeping every field's place", () => {
    const kept = finalizedDocument(EQUAL, EQUAL.storedAt);
    expect(kept).toEqual({ ...EQUAL, billStatus: "Finalized" });
    expect(Object.keys(kept)).toEqual(Object.keys(EQUAL));
    const aligned = finalizedDocument(MARCH, MARCH_ROW_AT);
    expect(aligned).toEqual({ ...MARCH, storedAt: MARCH_ROW_AT, billStatus: "Finalized" });
    expect(Object.keys(aligned)).toEqual(Object.keys(MARCH));
    // A storedAt written in another form of the same instant is kept as written.
    const offset = bill("g", "2026-07-13T14:37:57.677-04:00");
    expect(finalizedDocument(offset, "2026-07-13T18:37:57.677Z").storedAt).toBe("2026-07-13T14:37:57.677-04:00");
    // A bill without a status gets one at the end.
    const none = bill("g", "t", { billStatus: undefined });
    delete none.billStatus;
    expect(Object.keys(finalizedDocument(none, "t")).pop()).toBe("billStatus");
  });

  it("puts back exactly the status a bill had, or none", () => {
    const finalized = finalizedDocument(EQUAL, EQUAL.storedAt);
    expect(revertedDocument(finalized, "Passed")).toEqual(EQUAL);
    expect(revertedDocument(finalized, null)).not.toHaveProperty("billStatus");
  });

  it("matches a row to the bill by its documentStoredAt and contentHash, or else by its date and status", () => {
    const row = (updatedAt: string, extra: Item = {}) => manifestRow("g", updatedAt, extra);
    expect(rowReflectsDocument(row(EQUAL.storedAt), EQUAL)).toBe(true);
    expect(rowReflectsDocument(row("2026-07-13T18:38:00.677Z"), EQUAL)).toBe(true);
    expect(rowReflectsDocument(row("2026-07-13T18:38:00.678Z"), EQUAL)).toBe(false);
    expect(rowReflectsDocument(row("2026-07-13T18:37:57.676Z"), EQUAL)).toBe(false);
    expect(rowReflectsDocument(row("not a date"), EQUAL)).toBe(false);
    const stamped = { contentHash: { S: billContentHash(REDATED) } };
    expect(rowReflectsDocument(row(REDATED_ROW_AT, stamped), REDATED)).toBe(true);
    expect(rowReflectsDocument(row(REDATED.storedAt, { contentHash: { S: billContentHash(EQUAL) } }), REDATED)).toBe(
      false,
    );
    // A hash this code cannot read counts as none: the date and the status decide.
    expect(rowReflectsDocument(row(EQUAL.storedAt, { contentHash: { S: "v0:old" } }), EQUAL)).toBe(true);
    // An older row that shows another status than the bill's is behind it.
    expect(rowReflectsDocument(row(EQUAL.storedAt, { billStatus: { S: "New" } }), EQUAL)).toBe(false);
    // A row written since 2026-10-28 names the document it reflects (RUNBOOK 4.9): it must be this one.
    const current = { contentHash: { S: billContentHash(REDATED) }, documentStoredAt: { S: REDATED.storedAt } };
    expect(rowReflectsDocument(row(REDATED_ROW_AT, current), REDATED)).toBe(true);
    const behind = { ...current, documentStoredAt: { S: "2026-10-01T00:00:00.000Z" } };
    expect(rowReflectsDocument(row(REDATED_ROW_AT, behind), REDATED)).toBe(false);
    expect(rowReflectsDocument(row(EQUAL.storedAt), { ...EQUAL, storedAt: undefined })).toBe(false);
  });
});

describe("repairFinalizedStatus: dry run", () => {
  it("plans the three row shapes, says why the rest are not planned, and writes nothing to AWS", async () => {
    const table = fakeTable();
    seedThree(table);
    const other = (guid: string, changes: Doc) => bill(guid, "2026-06-01T00:00:00.000Z", changes);
    seed(table, { doc: other("BILLS-119hr9", {}), rowExtra: { contentHash: { S: billContentHash(EQUAL) } } });
    seed(table, { doc: other("BILLS-119hr10", {}), lookupSk: null });
    seed(table, { doc: other("BILLS-119hr11", {}), lookupSk: "2026-06-01T00:00:00.000Z#BILLS-119hr99" });
    seed(table, { doc: other("BILLS-119hr12", {}), rowUpdatedAt: "2026-06-01T00:00:05.000Z" });
    seed(table, { doc: other("BILLS-119hr13", {}), lookupSk: "2026-01-01T00:00:00.000Z#BILLS-119hr13" });
    table.put(manifestRow("BILLS-119hr13", "2026-01-01T00:00:00.000Z", { guid: { S: "BILLS-119hr13" } }));
    table.items.set("BILL|2026-01-01T00:00:00.000Z#BILLS-119hr13", {
      ...manifestRow("BILLS-119hr13", "2026-01-02T00:00:00.000Z"),
      sk: { S: "2026-01-01T00:00:00.000Z#BILLS-119hr13" },
    });
    seed(table, { doc: other("BILLS-119hr20", { actions: PASSED_ACTIONS }) });
    seed(table, { doc: other("BILLS-119hr21", { billStatus: "Updated" }) });
    seed(table, { doc: other("BILLS-119hr22", { billStatus: "Finalized" }) });
    seed(table, { doc: other("BILLS-119hr23", { billStatus: "New", actions: PASSED_ACTIONS }) });
    seed(table, { doc: other("BILLS-119hr24", { billStatus: "Finalized", actions: PASSED_ACTIONS }) });
    // Not a flat processed key: never listed.
    mockS3.put("processed-bills/119/hr/25.json", other("BILLS-119hr25", {}));

    const files = new Map<string, string>();
    const { result, lines, s3Commands } = await run({ table }, { planFile: "plan.jsonl" }, files);

    expect(summaryOf(lines)).toBe(
      "Finalized plan: read=13 planned=3 storedAtAligned=2 noSourceMetadata=1 recent7=0 recent14=0 recent28=0 " +
        "alreadyFinalized=1 unmanagedStatus=1 finalizedNotDerived=1 otherDrift=1 " +
        "skipped(noLookup=1 lookupMismatch=1 noRow=1 rowNotCurrent=2) unreadable=0",
    );
    expect(result).toMatchObject({ exitCode: 0, planFile: "plan.jsonl" });
    expect(s3Commands.filter((command) => command !== "GetObject" && command !== "ListObjectsV2")).toEqual([]);
    expect(table.calls.every((call) => call.name === "GetItemCommand" && call.input.ConsistentRead)).toBe(true);
    expect(lines).toEqual(
      expect.arrayContaining([
        "  planned BILLS-119hjres131: Passed -> Finalized (row 2026-07-13T18:37:57.677Z; 2025-12-11 Became Public Law No: 119-52.)",
        "  planned BILLS-119hr1: Passed -> Finalized, storedAt 2026-03-20T12:16:06.945Z -> 2026-03-20T12:16:07.699Z (row 2026-03-20T12:16:07.699Z; 2025-12-11 Became Public Law No: 119-52.)",
        "  skipped (rowNotCurrent) BILLS-119hr9: row 2026-06-01T00:00:00.000Z, storedAt 2026-06-01T00:00:00.000Z",
        "  skipped (noLookup) BILLS-119hr10",
        "  skipped (noRow) BILLS-119hr11: 2026-06-01T00:00:00.000Z#BILLS-119hr99",
        "  skipped (rowNotCurrent) BILLS-119hr12: row 2026-06-01T00:00:05.000Z, storedAt 2026-06-01T00:00:00.000Z",
        "  skipped (lookupMismatch) BILLS-119hr13: 2026-01-01T00:00:00.000Z#BILLS-119hr13",
        "  unmanagedStatus BILLS-119hr21: stored Updated, actions say Finalized",
        "  otherDrift BILLS-119hr23: stored New, actions say Passed",
        "  finalizedNotDerived BILLS-119hr24: stored Finalized, actions say Passed",
      ]),
    );

    const plan = planLines(files);
    expect(plan.map((line) => line.guid)).toEqual(["BILLS-119hjres131", "BILLS-119hr1", "BILLS-119s2392"]);
    const [equal, march, redated] = plan;
    expect(equal).toEqual({
      guid: "BILLS-119hjres131",
      key: "processed-bills/BILLS-119hjres131.json",
      versionId: mockS3.current(key(EQUAL.guid))!.versionId,
      etag: mockS3.current(key(EQUAL.guid))!.etag,
      fromStatus: "Passed",
      storedAt: EQUAL.storedAt,
      toStoredAt: EQUAL.storedAt,
      manifestSk: `${EQUAL.storedAt}#BILLS-119hjres131`,
      rowUpdatedAt: EQUAL.storedAt,
      rowContentHash: null,
      rowDocumentStoredAt: null,
      rowBillStatus: "Passed",
      contentHashAfter: billContentHash({ ...EQUAL, billStatus: "Finalized" }),
      enactment: { actionCode: "E40000", actionDate: "2025-12-11", text: "Became Public Law No: 119-52." },
      hasSourceMetadata: true,
    });
    expect(march).toMatchObject({ toStoredAt: MARCH_ROW_AT, storedAt: MARCH.storedAt, hasSourceMetadata: false });
    expect(redated).toMatchObject({
      toStoredAt: REDATED_ROW_AT,
      storedAt: REDATED.storedAt,
      rowContentHash: billContentHash(REDATED),
      manifestSk: `${REDATED_ROW_AT}#BILLS-119s2392`,
    });
    // The write lands on each row's own sort key, so CreateBillsManifest rewrites the row in place.
    for (const line of plan) {
      const doc = mockS3.json<Doc>(line.key)!;
      const written = finalizedDocument(doc, line.toStoredAt);
      expect(manifestSortKey(manifestTimestamp(written.storedAt)!, line.guid)).toBe(line.manifestSk);
    }
  });

  it("plans a row whose date a version without news kept, by its documentStoredAt and contentHash (RUNBOOK 4.9)", async () => {
    const table = fakeTable();
    const kept = bill("BILLS-119hr30", "2026-10-30T08:00:00.000Z");
    const keptRowAt = "2026-08-04T15:20:00.000Z";
    seed(table, {
      doc: kept,
      rowUpdatedAt: keptRowAt,
      rowExtra: { contentHash: { S: billContentHash(kept) }, documentStoredAt: { S: kept.storedAt } },
    });
    // The row reflects an older version (its documentStoredAt), although the hash matches: not planned.
    const behind = bill("BILLS-119hr31", "2026-10-30T08:00:00.000Z");
    seed(table, {
      doc: behind,
      rowUpdatedAt: keptRowAt,
      rowExtra: { contentHash: { S: billContentHash(behind) }, documentStoredAt: { S: "2026-10-29T08:00:00.000Z" } },
    });
    const files = new Map<string, string>();

    const { lines } = await run({ table }, { planFile: "plan.jsonl" }, files);

    expect(summaryOf(lines)).toMatch(/ planned=1 storedAtAligned=1 .* rowNotCurrent=1\) /);
    expect(planLines(files)).toEqual([
      expect.objectContaining({
        guid: "BILLS-119hr30",
        storedAt: kept.storedAt,
        toStoredAt: keptRowAt,
        rowDocumentStoredAt: kept.storedAt,
      }),
    ]);

    // A pipeline write in between stamps the row with another documentStoredAt: the line is superseded.
    table.put(
      manifestRow(kept.guid, keptRowAt, {
        contentHash: { S: billContentHash(kept) },
        documentStoredAt: { S: "2026-10-31T08:00:00.000Z" },
      }),
    );
    const { lines: applied } = await run(
      { table },
      { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" },
      files,
    );
    expect(applied).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=0 superseded=1 gone=0 failed=0 remaining=0",
    );
  });

  it("counts the planned bills dated inside the apps' recent windows", async () => {
    const table = fakeTable();
    seed(table, { doc: bill("BILLS-119s5", "2026-10-15T00:26:39.492Z") });
    seed(table, { doc: bill("BILLS-119s759", "2026-10-05T13:01:45.794Z") });
    seed(table, { doc: bill("BILLS-119s790", "2026-09-29T21:57:58.385Z") });
    seed(table, { doc: bill("BILLS-119s858", "2026-09-01T19:03:03.765Z") });

    const { lines } = await run({ table }, { planFile: "plan.jsonl" });

    expect(summaryOf(lines)).toMatch(/ recent7=1 recent14=2 recent28=3 /);
  });

  it("reads only the --guid bills, reports a missing or unreadable one, and exits 1", async () => {
    const table = fakeTable();
    seedThree(table);
    mockS3.put(key("BILLS-119hr77"), "{not json");
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const { result, lines, s3Commands } = await run(
      { table },
      { guids: ["BILLS-119hr1", "BILLS-119hr77", "BILLS-119hr78"], planFile: "plan.jsonl" },
    );

    expect(s3Commands).toEqual(["GetObject", "GetObject", "GetObject"]);
    expect(summaryOf(lines)).toMatch(/^Finalized plan: read=3 planned=1 .* unreadable=2$/);
    expect(lines).toContain("  unreadable BILLS-119hr78: no bill");
    expect(result.exitCode).toBe(1);
  });

  it("writes no plan file when nothing is planned, and never overwrites one", async () => {
    const table = fakeTable();
    seed(table, { doc: bill("BILLS-119hr20", "2026-06-01T00:00:00.000Z", { actions: PASSED_ACTIONS }) });
    const empty = await run({ table }, { planFile: "plan.jsonl" });
    expect(empty.files.size).toBe(0);
    expect(empty.lines).toContain("Plan: nothing to mark Finalized; no plan file written");

    seedThree(table);
    const files = new Map([["plan.jsonl", "old"]]);
    await expect(run({ table }, { planFile: "plan.jsonl" }, files)).rejects.toThrow("EEXIST: plan.jsonl");
    expect(files.get("plan.jsonl")).toBe("old");
  });
});

describe("repairFinalizedStatus: apply", () => {
  it("refuses without --rule-live, and with messages in a manifest queue", async () => {
    const table = fakeTable();
    const files = await planThree(table);

    const early = await run({ table }, { apply: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" }, files);
    expect(early.result.exitCode).toBe(2);
    expect(early.errors[0][0]).toMatch(/^Refusing to apply without --rule-live: .*BillDiffer and BillSummarizer/);
    expect(early.sqsCommands).toEqual([]);

    const busy = await run(
      { table, sqs: fakeQueues({ BillsManifestDLQ: { ApproximateNumberOfMessages: "1" } }) },
      { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" },
      files,
    );
    expect(busy.result.exitCode).toBe(2);
    expect(busy.errors[0][0]).toMatch(/a manifest queue holds messages/);

    for (const attempt of [early, busy]) expect(attempt.s3Commands).not.toContain("PutObject");
    expect(files.has("undo.jsonl")).toBe(false);
  });

  it("writes the canary's status only, over the version read, with the metadata kept, and records it", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    const before = mockS3.current(key(EQUAL.guid))!;

    const { result, lines } = await run(
      { table },
      { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl", guids: [EQUAL.guid] },
      files,
    );

    expect(lines).toContain(
      "Applied: applied=1 appliedLostResponse=0 alreadyApplied=0 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(result).toMatchObject({ exitCode: 0, undoFile: "undo.jsonl" });
    const put = mockS3.commands("PutObject");
    expect(put).toHaveLength(1);
    expect(put[0].input).toMatchObject({ Key: key(EQUAL.guid), IfMatch: before.etag, ContentType: "application/json" });
    const after = mockS3.current(key(EQUAL.guid))!;
    expect(JSON.parse(after.body)).toEqual({ ...EQUAL, billStatus: "Finalized" });
    expect(after.metadata).toEqual({ ...SOURCE_METADATA, "correlation-id": "finalize-rel44-20261019T030000Z" });
    expect(mockS3.versions(key(MARCH.guid))).toHaveLength(1);
    expect(undoLines(files)).toEqual([
      {
        guid: EQUAL.guid,
        key: key(EQUAL.guid),
        manifestSk: `${EQUAL.storedAt}#${EQUAL.guid}`,
        correlationId: "finalize-rel44-20261019T030000Z",
        appliedAt: NOW.toISOString(),
        before: { versionId: before.versionId, billStatus: "Passed", storedAt: EQUAL.storedAt },
        after: { versionId: after.versionId, billStatus: "Finalized", storedAt: EQUAL.storedAt },
      },
    ]);
  });

  it("aligns storedAt to the row's date, paces the writes, and a rerun records every line as alreadyApplied", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    const clock = { now: NOW.getTime() };

    await run({ table, clock }, { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" }, files);

    expect(clock.now - NOW.getTime()).toBe(1000); // 3 lines at 2 a second
    expect(mockS3.json(key(MARCH.guid))).toEqual({ ...MARCH, storedAt: MARCH_ROW_AT, billStatus: "Finalized" });
    expect(mockS3.json(key(REDATED.guid))).toEqual({ ...REDATED, storedAt: REDATED_ROW_AT, billStatus: "Finalized" });
    // A bill without metadata gets only the correlation id.
    expect(mockS3.current(key(MARCH.guid))!.metadata).toEqual({ "correlation-id": "finalize-rel44-20261019T030000Z" });
    expect(undoLines(files).map((record) => [record.guid, record.after.storedAt])).toEqual([
      [EQUAL.guid, EQUAL.storedAt],
      [MARCH.guid, MARCH_ROW_AT],
      [REDATED.guid, REDATED_ROW_AT],
    ]);

    const again = await run(
      { table, clock: { now: NOW.getTime() + 60_000 } },
      { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo-2.jsonl" },
      files,
    );
    expect(again.lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=3 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(mockS3.commands("PutObject")).toHaveLength(3);
    expect(undoLines(files, "undo-2.jsonl").map((record) => record.after)).toEqual(
      undoLines(files).map((record) => record.after),
    );
  });

  it("writes nothing for a bill, lookup or row that changed since the dry run", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    // A pipeline write of the first bill, a row stamped for the second, the third's lookup moved.
    mockS3.put(key(EQUAL.guid), { ...EQUAL, soWhat: "New summary." }, SOURCE_METADATA);
    table.put(manifestRow(MARCH.guid, MARCH_ROW_AT, { contentHash: { S: billContentHash(MARCH) } }));
    table.put(lookupItem(REDATED.guid, `${REDATED.storedAt}#${REDATED.guid}`));

    const { result, lines } = await run(
      { table },
      { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" },
      files,
    );

    expect(lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=0 superseded=3 gone=0 failed=0 remaining=0",
    );
    expect(lines).toContain("Superseded lines changed since the dry run: take the dry run again for them.");
    expect(mockS3.commands("PutObject")).toHaveLength(0);
    expect(files.get("undo.jsonl")).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("treats a refused write as superseded, a lost answer as applied, and another error as failed", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    mockS3.injectPutError(key(EQUAL.guid), 412);
    mockS3.injectPutError(key(REDATED.guid), 500);
    // The second bill's write lands, then its answer is lost.
    const storage = new BillStorage(new S3Client({}), config.bucket);
    const putJson = storage.putJson.bind(storage);
    storage.putJson = async (putKey, payload, putOptions) => {
      const written = await putJson(putKey, payload, putOptions);
      if (putKey === key(MARCH.guid)) throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
      return written;
    };

    const { result, lines, errors } = await run(
      { table, storage },
      { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" },
      files,
    );

    expect(lines).toContain(
      "Applied: applied=0 appliedLostResponse=1 alreadyApplied=0 superseded=1 gone=0 failed=1 remaining=0",
    );
    expect(lines).toContain("A failed line may have landed: run again, which records it if it did (alreadyApplied).");
    expect(errors[0][0]).toBe("Failed to mark the bill Finalized");
    expect(undoLines(files).map((record) => record.guid)).toEqual([MARCH.guid]);
    expect(result.exitCode).toBe(1);
  });

  it("reports a bill deleted since the dry run as gone", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    mockS3.deleteObject(key(MARCH.guid));

    const { lines } = await run(
      { table },
      { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" },
      files,
    );

    expect(lines).toContain("  gone: BILLS-119hr1");
  });

  it("stops when an undo record cannot be written, after the write it could not record", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    const appendFile = (path: string, text: string) => {
      if (text.length > 0) throw new Error("ENOSPC");
      files.set(path, files.get(path) ?? "");
    };

    await expect(
      run(
        { table, appendFile },
        { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" },
        files,
      ),
    ).rejects.toThrow("ENOSPC");
    expect(mockS3.commands("PutObject")).toHaveLength(1);
  });

  it("starts no new line once interrupted", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    let started = 0;
    const interrupted = () => started++ >= 1;

    const { lines, result } = await run(
      { table, interrupted },
      { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" },
      files,
    );

    expect(lines).toContain("Interrupted: 2 lines remain; run again to resume.");
    expect(result.remaining).toBe(2);
    expect(mockS3.commands("PutObject")).toHaveLength(1);
  });

  it("refuses a plan line that is not a status write of its guid at its row's date", () => {
    const line = {
      guid: "BILLS-119hr1",
      key: "processed-bills/BILLS-119hr1.json",
      versionId: "v1",
      etag: '"e"',
      fromStatus: "Passed",
      storedAt: MARCH.storedAt,
      toStoredAt: MARCH_ROW_AT,
      manifestSk: `${MARCH_ROW_AT}#BILLS-119hr1`,
      rowUpdatedAt: MARCH_ROW_AT,
      rowContentHash: null,
      rowDocumentStoredAt: null,
      contentHashAfter: "v1:a:b",
    };
    expect(parsePlanFile(`${JSON.stringify(line)}\n\n`, config)).toHaveLength(1);
    expect(() => parsePlanFile(JSON.stringify({ ...line, versionId: "" }), config)).toThrow(/missing versionId/);
    expect(() => parsePlanFile(JSON.stringify({ ...line, key: "processed-bills/BILLS-119hr2.json" }), config)).toThrow(
      /not a status write/,
    );
    expect(() => parsePlanFile(JSON.stringify({ ...line, toStoredAt: MARCH.storedAt }), config)).toThrow(
      /not a status write/,
    );
    expect(() => parsePlanFile(JSON.stringify({ ...line, fromStatus: 7 }), config)).toThrow(/not a status write/);
    // A plan from before the row's documentStoredAt was recorded is not applied: take the dry run again.
    expect(() => parsePlanFile(JSON.stringify({ ...line, rowDocumentStoredAt: undefined }), config)).toThrow(
      /not a status write/,
    );
  });
});

describe("repairFinalizedStatus: undo", () => {
  const applied = async () => {
    const table = fakeTable();
    const files = await planThree(table);
    await run({ table }, { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" }, files);
    return { table, files };
  };

  it("checks first, then puts the old status back and leaves storedAt at the row's date", async () => {
    const { table, files } = await applied();

    const check = await run({ table }, { undo: "undo.jsonl" }, files);
    expect(check.lines).toContain(
      "Undo: records=3 revertible=3 reverted=0 revertedLostResponse=0 alreadyReverted=0 changedSince=0 failed=0 remaining=0",
    );
    expect(check.s3Commands).not.toContain("PutObject");

    const clock = { now: NOW.getTime() + 3_600_000 };
    const undo = await run({ table, clock }, { undo: "undo.jsonl", apply: true }, files);
    expect(undo.lines).toContain(
      "Undo: records=3 revertible=0 reverted=3 revertedLostResponse=0 alreadyReverted=0 changedSince=0 failed=0 remaining=0",
    );
    expect(mockS3.json(key(EQUAL.guid))).toEqual(EQUAL);
    expect(mockS3.json(key(MARCH.guid))).toEqual({ ...MARCH, storedAt: MARCH_ROW_AT });
    expect(mockS3.current(key(REDATED.guid))!.metadata).toEqual({
      ...SOURCE_METADATA,
      "correlation-id": "finalize-rel44-undo-20261019T040000Z",
    });

    const again = await run({ table }, { undo: "undo.jsonl" }, files);
    expect(again.lines).toContain(
      "Undo: records=3 revertible=0 reverted=0 revertedLostResponse=0 alreadyReverted=3 changedSince=0 failed=0 remaining=0",
    );
  });

  it("counts a canary's bills once after the full run wrote their records again to the same undo file", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    const options = { apply: true, ruleLive: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" } as const;
    await run({ table }, { ...options, guids: [EQUAL.guid] }, files);
    const full = await run({ table, clock: { now: NOW.getTime() + 60_000 } }, options, files);
    expect(full.lines).toContain(
      "Applied: applied=2 appliedLostResponse=0 alreadyApplied=1 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(undoLines(files)).toHaveLength(4);

    const check = await run({ table }, { undo: "undo.jsonl" }, files);
    expect(check.lines).toContain("  repeated records (written again by a rerun): 1, each counted once");
    expect(check.lines).toContain(
      "Undo: records=3 revertible=3 reverted=0 revertedLostResponse=0 alreadyReverted=0 changedSince=0 failed=0 remaining=0",
    );

    const undo = await run({ table }, { undo: "undo.jsonl", apply: true }, files);
    expect(undo.lines).toContain(
      "Undo: records=3 revertible=0 reverted=3 revertedLostResponse=0 alreadyReverted=0 changedSince=0 failed=0 remaining=0",
    );
    expect(mockS3.json(key(EQUAL.guid))).toEqual(EQUAL);
  });

  it("leaves a bill written since, and removes a status the bill never had", async () => {
    const { table, files } = await applied();
    mockS3.put(key(EQUAL.guid), { ...EQUAL, billStatus: "Finalized", soWhat: "Newer." }, SOURCE_METADATA);
    const record = undoLines(files)[1];
    files.set("undo-none.jsonl", `${JSON.stringify({ ...record, before: { ...record.before, billStatus: null } })}\n`);

    const changed = await run({ table }, { undo: "undo.jsonl", apply: true, guids: [EQUAL.guid] }, files);
    expect(changed.lines).toContain("  changedSince: BILLS-119hjres131");
    expect(mockS3.json<Doc>(key(EQUAL.guid))!.soWhat).toBe("Newer.");

    await run({ table }, { undo: "undo-none.jsonl", apply: true }, files);
    expect(mockS3.json(key(MARCH.guid))).not.toHaveProperty("billStatus");
  });

  it("refuses a file that is not an undo file of this script", async () => {
    const table = fakeTable();
    const files = new Map([["undo.jsonl", `${JSON.stringify({ guid: "BILLS-119hr1", key: "x" })}\n`]]);
    await expect(run({ table }, { undo: "undo.jsonl" }, files)).rejects.toThrow(/not a repair:finalized-status record/);
  });
});
