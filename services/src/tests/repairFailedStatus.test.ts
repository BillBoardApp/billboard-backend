import {
  type AttributeValue,
  type GetItemCommandInput,
  type QueryCommandInput,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { GetQueueAttributesCommandInput, GetQueueUrlCommandInput } from "@aws-sdk/client-sqs";
import { S3Client } from "@aws-sdk/client-s3";

import {
  APPLY_REQUIRES_RULE_LIVE,
  DEFAULT_CONCURRENCY,
  DEFAULT_RATE,
  configFromEnv,
  decideStatus,
  defaultPlanFile,
  defaultUndoFile,
  isPageOnlyRow,
  legacyBillOutcomeKind,
  parseArgs,
  parsePlanFile,
  repairedDocument,
  revertedDocument,
  rowReflectsDocument,
  runCorrelationId,
  runRepair,
  type CliOptions,
  type MarkerLine,
  type PlanEntry,
  type PlanLine,
  type UndoRecord,
} from "../../scripts/repairFailedStatus";
import { BillStorage } from "../adapters/billStorage";
import { billContentHash, manifestSortKey, manifestTimestamp } from "../shared/billVersionChange";
import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

type Item = Record<string, AttributeValue>;
/** A processed bill as the tests build it; the script reads the rest as unknown. */
interface Doc {
  guid: string;
  storedAt: string;
  [field: string]: unknown;
}
type Db = Parameters<typeof runRepair>[0]["db"];

/** The input of the commands the fake table and queues answer. */
type TableInput = Partial<GetItemCommandInput & UpdateItemCommandInput & QueryCommandInput>;
type QueueInput = Partial<GetQueueUrlCommandInput & GetQueueAttributesCommandInput>;
interface FakeCommand<Input> {
  constructor: { name: string };
  input: Input;
}

const config = configFromEnv({});
/** The 7-day window then starts at 2026-10-23T03:00Z, the 28-day one at 2026-10-02T03:00Z. */
const NOW = new Date("2026-10-30T03:00:00.000Z");

const key = (guid: string) => `processed-bills/${guid}.json`;
const SOURCE_METADATA = {
  "correlation-id": "2026-10-27T21:00:00.000Z:BILLS-119hr1",
  "source-text-hash": "v1:abc",
  "source-raw-version": "raw-v9",
  "source-fetched-at": "2026-10-27T20:59:00.000Z",
};

// congress.gov action lines, newest first as its API lists them.
const AMENDMENT = {
  actionDate: "2026-10-27",
  text: "Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53. Record Vote Number: 381.",
  type: "Floor",
  sourceSystem: { code: 0, name: "Senate" },
};
const MOTION_TO_PROCEED = {
  actionDate: "2026-10-20",
  text: "Motion to proceed to consideration of measure not agreed to in Senate by Yea-Nay Vote. 48 - 50.",
  type: "Floor",
  sourceSystem: { code: 0, name: "Senate" },
};
const FAILED_SUSPENSION = {
  actionCode: "9000",
  actionDate: "2026-09-15",
  text: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 238).",
  type: "Floor",
};
const PASSED_SENATE = {
  actionCode: "17000",
  actionDate: "2026-08-01",
  text: "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent.",
  type: "Floor",
};
const FAILED_PASSAGE = {
  actionCode: "9000",
  actionDate: "2026-10-01",
  text: "Failed of passage/not agreed to in House: On passage Failed by the Yeas and Nays: 202 - 220 (Roll no. 450).",
  type: "Floor",
};
const INTRODUCED = { actionCode: "1000", actionDate: "2026-03-02", text: "Introduced in House", type: "IntroReferral" };

const bill = (guid: string, storedAt: string, changes: Partial<Doc> = {}): Doc => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt,
  identifier: { congress: "119", billType: "hr", billNumber: guid.replace(/\D+/g, "").slice(3) },
  guid,
  title: `Bill ${guid}`,
  soWhat: "It changes something.",
  subCategories: ["Energy"],
  lifeAreas: [],
  sponsors: ["R000606"],
  cosponsors: ["C000001"],
  actions: [AMENDMENT, INTRODUCED],
  committees: [],
  billStatus: "Failed",
  ...changes,
});

/**
 * BillsManifest in memory: consistent GetItem and Query, and the UpdateItem the markers take ("SET #a = :a, ...,
 * #b = if_not_exists(#b, :b)").
 */
const fakeTable = () => {
  const items = new Map<string, Item>();
  let putError: Error | undefined;
  const id = (item: Item) => `${item.pk.S}|${item.sk.S}`;
  const calls: Array<{ name: string; input: TableInput }> = [];
  const send = jest.fn(async (command: FakeCommand<TableInput>) => {
    const name: string = command.constructor.name;
    calls.push({ name, input: command.input });
    if (name === "GetItemCommand") return { Item: items.get(id(command.input.Key!)) };
    if (name === "UpdateItemCommand") {
      if (putError) throw putError;
      const {
        Key,
        UpdateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      } = command.input;
      const before = items.get(id(Key!));
      const next: Item = { ...before, ...Key };
      for (const clause of String(UpdateExpression)
        .replace(/^SET /, "")
        .split(/,\s*(?![^(]*\))/)) {
        const plain = clause.match(/^(#\w+) = (:\w+)$/);
        const ifNotExists = clause.match(/^(#\w+) = if_not_exists\((#\w+), (:\w+)\)$/);
        if (plain) next[names![plain[1]]] = values![plain[2]];
        else if (ifNotExists)
          next[names![ifNotExists[1]]] = before?.[names![ifNotExists[2]]] ?? values![ifNotExists[3]];
        else throw new Error(`Unsupported update clause ${clause}`);
      }
      items.set(id(Key!), next);
      return {};
    }
    if (name === "QueryCommand") {
      const { ExpressionAttributeValues: values } = command.input;
      const matching = [...items.values()]
        .filter((item) => item.pk.S === values![":pk"].S && (!values![":since"] || item.sk.S! >= values![":since"].S!))
        .sort((a, b) => (a.sk.S! < b.sk.S! ? -1 : 1));
      // Two pages, as DynamoDB pages a large partition.
      const start = command.input.ExclusiveStartKey ? Number(command.input.ExclusiveStartKey.page.N) : 0;
      const page = matching.slice(start, start + 3);
      return {
        Items: page,
        ...(start + 3 < matching.length ? { LastEvaluatedKey: { page: { N: String(start + 3) } } } : {}),
      };
    }
    throw new Error(`Unexpected DynamoDB command ${name}`);
  });
  return {
    db: { send } as Db,
    items,
    calls,
    put: (item: Item) => items.set(id(item), item),
    remove: (item: Item) => items.delete(id(item)),
    failPuts: (error: Error) => {
      putError = error;
    },
    /** The "formerly failed" markers (REL-50, INT-11) by guid. */
    markers: () =>
      new Map(
        [...items.values()]
          .filter((item) => item.pk.S === "BILL_FORMERLY_FAILED")
          .map((item) => [item.sk.S!, item] as const),
      ),
  };
};
type Table = ReturnType<typeof fakeTable>;

const manifestRow = (guid: string, updatedAt: string, extra: Item = {}): Item => ({
  pk: { S: "BILL" },
  sk: { S: manifestSortKey(updatedAt, guid) },
  guid: { S: guid },
  updatedAt: { S: updatedAt },
  billStatus: { S: "Failed" },
  ...extra,
});

const lookupItem = (guid: string, manifestSk: string): Item => ({
  pk: { S: "BILL_GUID" },
  sk: { S: guid },
  manifestSk: { S: manifestSk },
  updatedAt: { S: manifestSk.split("#")[0] },
});

/** The row CreateBillsManifest writes since 2026-10-28: the document's contentHash and storedAt. */
const currentRowStamp = (doc: Doc): Item => ({
  contentHash: { S: billContentHash(doc) },
  documentStoredAt: { S: doc.storedAt },
  dateBasis: { S: "d1|Failed|2026-10-27|00000000|" },
});

interface Seed {
  doc: Doc;
  /** The row's date (default: the bill's storedAt); null for no row and no lookup. */
  rowUpdatedAt?: string | null;
  /** Default: the stamp of a row the current release wrote for `doc`. */
  rowExtra?: Item;
  /** The lookup names this sort key instead of the row's; null for no lookup. */
  lookupSk?: string | null;
  metadata?: Record<string, string>;
}

const seed = (table: Table, { doc, rowUpdatedAt, rowExtra, lookupSk, metadata }: Seed): void => {
  mockS3.put(key(doc.guid), doc, metadata ?? SOURCE_METADATA);
  if (rowUpdatedAt === null) return;
  const row = manifestRow(doc.guid, rowUpdatedAt ?? doc.storedAt, rowExtra ?? currentRowStamp(doc));
  table.put(row);
  if (lookupSk !== null) table.put(lookupItem(doc.guid, lookupSk ?? row.sk.S!));
};

const fakeQueues = (depths: Record<string, Partial<Record<string, string>>> = {}) => {
  const send = jest.fn(async (command: FakeCommand<QueueInput>) => {
    const name: string = command.constructor.name;
    if (name === "GetQueueUrlCommand") return { QueueUrl: `https://sqs.example/${command.input.QueueName}` };
    if (name === "GetQueueAttributesCommand") {
      const queue = command.input.QueueUrl!.split("/").pop()!;
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
  return { send } as Parameters<typeof runRepair>[0]["sqs"] & { send: typeof send };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({ ...parseArgs([]), ...overrides });
const applyOptions = (overrides: Partial<CliOptions> = {}): Partial<CliOptions> => ({
  apply: true,
  ruleLive: true,
  planFile: "plan.jsonl",
  undoFile: "undo.jsonl",
  ...overrides,
});

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
    sqs,
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

const summaryOf = (lines: string[]) => lines.find((line) => line.startsWith("Failed status plan:"));
const planEntries = (files: Map<string, string>, path = "plan.jsonl"): PlanEntry[] =>
  parsePlanFile(files.get(path)!, config);
const planLines = (files: Map<string, string>, path = "plan.jsonl"): PlanLine[] =>
  planEntries(files, path).filter((entry): entry is PlanLine => entry.kind === "status");
const markerLines = (files: Map<string, string>, path = "plan.jsonl"): MarkerLine[] =>
  planEntries(files, path).filter((entry): entry is MarkerLine => entry.kind === "marker");
const undoLines = (files: Map<string, string>, path = "undo.jsonl"): UndoRecord[] =>
  (files.get(path) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// The row shapes production holds: a row at the bill's storedAt (the amendment line moved it, as a status change), a
// row whose date a version without news kept (its storedAt is later), and a March row an older release wrote 0.754 s
// after its document, with no hash.
const AT_STORED = bill("BILLS-119hr1", "2026-10-27T21:00:00.000Z");
const KEPT = bill("BILLS-119s2392", "2026-10-21T09:12:44.512Z", {
  actions: [MOTION_TO_PROCEED, FAILED_SUSPENSION, PASSED_SENATE, INTRODUCED],
});
const KEPT_ROW_AT = "2026-10-05T22:41:29.355Z";
const MARCH = bill("BILLS-119hr44", "2026-03-20T12:16:06.945Z", { actions: [FAILED_SUSPENSION, INTRODUCED] });
const MARCH_ROW_AT = "2026-03-20T12:16:07.699Z";

const seedThree = (table: Table) => {
  seed(table, { doc: AT_STORED });
  seed(table, { doc: KEPT, rowUpdatedAt: KEPT_ROW_AT, rowExtra: { ...currentRowStamp(KEPT), voteCount: { N: "3" } } });
  seed(table, { doc: MARCH, rowUpdatedAt: MARCH_ROW_AT, rowExtra: {}, metadata: {} });
};

// A page-only bill (H.J.Res. 139 and S. 2882 on 2026-10-29): the March load dated its row 0.657 s after the document and
// wrote New; backfill:bill-status stored Failed on 2026-04-07 with the March storedAt and no source metadata, and the
// CreateBillsManifest of then skipped that write as older than the row. The list shows New, the bill page Failed.
const PAGE_ONLY = bill("BILLS-119hjres139", "2026-03-23T18:22:58.583Z", { actions: [FAILED_SUSPENSION, INTRODUCED] });
const PAGE_ONLY_ROW_AT = "2026-03-23T18:22:59.240Z";
const LIST_ROW_NEW: Item = { billStatus: { S: "New" } };
const seedPageOnly = (table: Table) =>
  seed(table, { doc: PAGE_ONLY, rowUpdatedAt: PAGE_ONLY_ROW_AT, rowExtra: LIST_ROW_NEW, metadata: {} });

/** A dry run over the three bills; returns the plan file. */
const planThree = async (table: Table) => {
  seedThree(table);
  const files = new Map<string, string>();
  await run({ table }, { planFile: "plan.jsonl" }, files);
  return files;
};

beforeEach(() => {
  mockS3 = new FakeVersionedS3("2026-10-29T00:00:00.000Z");
});

afterEach(() => jest.restoreAllMocks());

describe("repairFailedStatus: arguments", () => {
  it("defaults to a dry run of every manifest row", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      apply: false,
      guids: [],
      since: null,
      limit: null,
      concurrency: DEFAULT_CONCURRENCY,
      rate: DEFAULT_RATE,
      planFile: null,
      undoFile: null,
      undo: null,
      ruleLive: false,
      markersOnly: false,
      deployedAt: null,
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
        "BILLS-119hr1ih",
        "--guid",
        "BILLS-119hr1",
        "--limit",
        "3",
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
        guids: ["BILLS-119hr1"],
        limit: 3,
        concurrency: 25,
        rate: 5,
        undoFile: "undo.jsonl",
      }),
    );
    expect(parseArgs(["--since", "2026-10-02T03:00:00Z"]).since).toBe("2026-10-02T03:00:00.000Z");
    expect(parseArgs(["--deployed-at", "2026-11-02T14:00:00Z"]).deployedAt).toBe("2026-11-02T14:00:00.000Z");
    expect(parseArgs(["--apply", "--markers-only", "--plan-file", "plan.jsonl"])).toEqual(
      options({ apply: true, markersOnly: true, planFile: "plan.jsonl" }),
    );
    expect(parseArgs(["--undo", "undo.jsonl", "--apply", "--dry-run"])).toEqual(options({ undo: "undo.jsonl" }));
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("refuses unknown, malformed and contradictory arguments", () => {
    expect(() => parseArgs(["--aply"])).toThrow("Unknown argument: --aply");
    expect(() => parseArgs(["--apply", "--rule-live"])).toThrow(/--apply needs --plan-file/);
    expect(() => parseArgs(["--guid", "hr1"])).toThrow(/--guid needs a bill guid/);
    expect(() => parseArgs(["--guid"])).toThrow(/--guid needs a bill guid/);
    expect(() => parseArgs(["--rate", "6"])).toThrow(/--rate needs a whole number from 1 to 5/);
    expect(() => parseArgs(["--concurrency", "0"])).toThrow(/--concurrency needs a whole number from 1 to 25/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/--limit needs a whole number/);
    expect(() => parseArgs(["--plan-file"])).toThrow(/--plan-file needs a file path/);
    expect(() => parseArgs(["--since", "yesterday"])).toThrow(/--since needs an ISO time/);
    expect(() => parseArgs(["--since", "2026-10-02", "--guid", "BILLS-119hr1"])).toThrow(/do not go together/);
    expect(() => parseArgs(["--since", "2026-10-02", "--undo", "u.jsonl"])).toThrow(/dry run only/);
    expect(() => parseArgs(["--undo", "u.jsonl", "--undo-file", "x.jsonl"])).toThrow(/--undo takes neither/);
    expect(() => parseArgs(["--deployed-at", "monday"])).toThrow(/--deployed-at needs an ISO time/);
    expect(() => parseArgs(["--deployed-at", "2026-11-02", "--apply", "--plan-file", "p"])).toThrow(/dry run only/);
    expect(() => parseArgs(["--markers-only"])).toThrow(/--markers-only goes with --apply/);
    expect(() => parseArgs(["--markers-only", "--undo", "u.jsonl", "--apply"])).toThrow(/--markers-only goes with/);
  });

  it("names the files and the correlation ids after the run, and reads production names by default", () => {
    const at = new Date("2026-10-30T03:00:00.123Z");
    expect(defaultPlanFile(at)).toBe("repair-failed-status-plan-20261030T030000Z.jsonl");
    expect(defaultUndoFile(at)).toBe("repair-failed-status-undo-20261030T030000Z.jsonl");
    expect(runCorrelationId(at)).toBe("failed-status-rel50-20261030T030000Z");
    expect(runCorrelationId(at, true)).toBe("failed-status-rel50-undo-20261030T030000Z");
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

describe("repairFailedStatus: the rule", () => {
  it("keeps the rule before REL-50 for the report: every 'not agreed to in House/Senate' line was a failure", () => {
    expect(legacyBillOutcomeKind(AMENDMENT)).toBe("failed");
    expect(legacyBillOutcomeKind(MOTION_TO_PROCEED)).toBe("failed");
    expect(legacyBillOutcomeKind(FAILED_SUSPENSION)).toBe("failed");
    expect(legacyBillOutcomeKind({ text: "Failed in the House." })).toBe("failed");
    expect(legacyBillOutcomeKind({ text: "Override veto rejected." })).toBe("failed");
    expect(legacyBillOutcomeKind(PASSED_SENATE)).toBe("passed");
    expect(legacyBillOutcomeKind(INTRODUCED)).toBeNull();
    expect(legacyBillOutcomeKind(null)).toBeNull();
  });

  it("plans only a status the old rule gave and REL-50's rule changes", () => {
    const state = (changes: Partial<Doc>) => decideStatus(bill("g", "t", changes)).state;
    expect(state({})).toBe("candidate"); // an amendment line: Failed -> New
    expect(decideStatus(KEPT)).toMatchObject({ state: "candidate", before: "Failed", after: "Passed" });
    expect(decideStatus(MARCH)).toMatchObject({ state: "candidate", before: "Failed", after: "New" });
    expect(state({ actions: [FAILED_PASSAGE, INTRODUCED] })).toBe("unchanged"); // the bill's own failure
    expect(state({ billStatus: "New" })).toBe("unchanged"); // billDiffer already put it right
    expect(state({ billStatus: "", actions: [INTRODUCED] })).toBe("unchanged");
    expect(state({ billStatus: undefined, actions: [INTRODUCED] })).toBe("unchanged");
    expect(state({ billStatus: "Passed" })).toBe("drift"); // stored Passed: not the old rule's either
    expect(state({ billStatus: "Updated" })).toBe("unmanagedStatus");
    expect(state({ billStatus: "Finalized" })).toBe("finalizedLeft");
    expect(decideStatus({}).state).toBe("unchanged");
  });

  it("changes only billStatus, and storedAt only to the row's date, keeping every field's place", () => {
    const kept = repairedDocument(AT_STORED, "New", AT_STORED.storedAt);
    expect(kept).toEqual({ ...AT_STORED, billStatus: "New" });
    expect(Object.keys(kept)).toEqual(Object.keys(AT_STORED));
    const aligned = repairedDocument(KEPT, "Passed", KEPT_ROW_AT);
    expect(aligned).toEqual({ ...KEPT, storedAt: KEPT_ROW_AT, billStatus: "Passed" });
    expect(Object.keys(aligned)).toEqual(Object.keys(KEPT));
    // A storedAt written in another form of the same instant is kept as written.
    const offset = bill("g", "2026-10-27T17:00:00.000-04:00");
    expect(repairedDocument(offset, "New", "2026-10-27T21:00:00.000Z").storedAt).toBe("2026-10-27T17:00:00.000-04:00");
  });

  it("puts back exactly the status a bill had, or none", () => {
    const repaired = repairedDocument(AT_STORED, "New", AT_STORED.storedAt);
    expect(revertedDocument(repaired, "Failed")).toEqual(AT_STORED);
    expect(revertedDocument(repaired, null)).not.toHaveProperty("billStatus");
  });

  it("matches a row to the bill by its contentHash and documentStoredAt, or else by its date and status", () => {
    const row = (updatedAt: string, extra: Item = {}) => manifestRow("g", updatedAt, extra);
    expect(rowReflectsDocument(row(KEPT_ROW_AT, currentRowStamp(KEPT)), KEPT)).toBe(true);
    expect(
      rowReflectsDocument(row(KEPT_ROW_AT, { ...currentRowStamp(KEPT), documentStoredAt: { S: KEPT_ROW_AT } }), KEPT),
    ).toBe(false);
    expect(rowReflectsDocument(row(KEPT_ROW_AT, currentRowStamp(AT_STORED)), KEPT)).toBe(false);
    expect(rowReflectsDocument(row(KEPT_ROW_AT, { contentHash: { S: billContentHash(KEPT) } }), KEPT)).toBe(true);
    // Without a hash: the version's storedAt, or up to 3 s after it, with the same status.
    expect(rowReflectsDocument(row(MARCH.storedAt), MARCH)).toBe(true);
    expect(rowReflectsDocument(row("2026-03-20T12:16:09.945Z"), MARCH)).toBe(true);
    expect(rowReflectsDocument(row("2026-03-20T12:16:09.946Z"), MARCH)).toBe(false);
    expect(rowReflectsDocument(row("2026-03-20T12:16:06.944Z"), MARCH)).toBe(false);
    expect(rowReflectsDocument(row(MARCH.storedAt, { billStatus: { S: "New" } }), MARCH)).toBe(false);
    expect(rowReflectsDocument(row("not a date"), MARCH)).toBe(false);
    expect(rowReflectsDocument(row(MARCH.storedAt), { ...MARCH, storedAt: "never" })).toBe(false);
    // A hash this code cannot read counts as none: the date decides.
    expect(rowReflectsDocument(row(MARCH.storedAt, { contentHash: { S: "v0:old" } }), MARCH)).toBe(true);
  });

  it("calls a row page only when an older row dated by the bill already shows REL-50's status, and no other", () => {
    const decision = decideStatus(PAGE_ONLY);
    const row = (updatedAt: string, extra: Item = {}) =>
      manifestRow(PAGE_ONLY.guid, updatedAt, { ...LIST_ROW_NEW, ...extra });
    expect(decision).toMatchObject({ state: "candidate", stored: "Failed", before: "Failed", after: "New" });
    expect(isPageOnlyRow(row(PAGE_ONLY_ROW_AT), PAGE_ONLY, decision)).toBe(true);
    // Its status is not the document's, so the row does not reflect the bill (rowNotCurrent before 2026-10-29).
    expect(rowReflectsDocument(row(PAGE_ONLY_ROW_AT), PAGE_ONLY)).toBe(false);
    // Dated at the bill's storedAt or up to 3 s after it.
    expect(isPageOnlyRow(row(PAGE_ONLY.storedAt), PAGE_ONLY, decision)).toBe(true);
    expect(isPageOnlyRow(row("2026-03-23T18:23:01.583Z"), PAGE_ONLY, decision)).toBe(true);
    expect(isPageOnlyRow(row("2026-03-23T18:23:01.584Z"), PAGE_ONLY, decision)).toBe(false);
    expect(isPageOnlyRow(row("2026-03-23T18:22:58.582Z"), PAGE_ONLY, decision)).toBe(false);
    // Showing exactly the status REL-50's rule gives.
    expect(isPageOnlyRow(row(PAGE_ONLY_ROW_AT, { billStatus: { S: "Failed" } }), PAGE_ONLY, decision)).toBe(false);
    expect(isPageOnlyRow(row(PAGE_ONLY_ROW_AT, { billStatus: { S: "Passed" } }), PAGE_ONLY, decision)).toBe(false);
    const noStatus = row(PAGE_ONLY_ROW_AT);
    delete noStatus.billStatus;
    expect(isPageOnlyRow(noStatus, PAGE_ONLY, decision)).toBe(false);
    // Never a row a newer release stamped: its hash and documentStoredAt say which version it reflects.
    const stamps: Item[] = [
      { contentHash: { S: billContentHash({ ...PAGE_ONLY, billStatus: "New" }) } },
      { contentHash: { S: "v0:old" } },
      { dateBasis: { S: "d1|New|2026-09-15|00000000|" } },
      { documentStoredAt: { S: PAGE_ONLY.storedAt } },
    ];
    for (const stamp of stamps) {
      expect(isPageOnlyRow(row(PAGE_ONLY_ROW_AT, stamp), PAGE_ONLY, decision)).toBe(false);
    }
    // Only a candidate stored Failed: never a bill already right, failed by its own failure, drift, Updated, Finalized.
    const pageOnlyFor = (doc: Doc) => isPageOnlyRow(row(PAGE_ONLY_ROW_AT), doc, decideStatus(doc));
    expect(pageOnlyFor({ ...PAGE_ONLY, billStatus: "New" })).toBe(false);
    expect(pageOnlyFor({ ...PAGE_ONLY, actions: [FAILED_PASSAGE, INTRODUCED] })).toBe(false);
    expect(pageOnlyFor({ ...PAGE_ONLY, billStatus: "Passed" })).toBe(false);
    expect(pageOnlyFor({ ...PAGE_ONLY, billStatus: "Updated" })).toBe(false);
    expect(pageOnlyFor({ ...PAGE_ONLY, billStatus: "Finalized" })).toBe(false);
    expect(isPageOnlyRow(row(PAGE_ONLY_ROW_AT), PAGE_ONLY, { ...decision, stored: "New" })).toBe(false);
    expect(isPageOnlyRow(row(PAGE_ONLY_ROW_AT), PAGE_ONLY, { ...decision, before: "New" })).toBe(false);
  });
});

describe("repairFailedStatus: dry run", () => {
  it("plans the three row shapes with the actions that decide them, says why the rest are not, and writes nothing", async () => {
    const table = fakeTable();
    seedThree(table);
    const other = (guid: string, changes: Partial<Doc>) => bill(guid, "2026-10-10T00:00:00.000Z", changes);
    seed(table, { doc: other("BILLS-119hr9", {}), rowExtra: currentRowStamp(AT_STORED) });
    seed(table, { doc: other("BILLS-119hr10", {}), lookupSk: null });
    // A stale duplicate row: its lookup names the bill's other row.
    seed(table, { doc: other("BILLS-119hr13", { actions: [FAILED_PASSAGE, INTRODUCED] }) });
    table.put(manifestRow("BILLS-119hr13", "2026-01-01T00:00:00.000Z"));
    seed(table, { doc: other("BILLS-119hr20", { actions: [FAILED_PASSAGE, INTRODUCED] }) });
    seed(table, { doc: other("BILLS-119hr21", { billStatus: "Updated" }) });
    seed(table, { doc: other("BILLS-119hr22", { billStatus: "Finalized" }) });
    seed(table, { doc: other("BILLS-119hr23", { billStatus: "Passed" }) });
    seed(table, { doc: other("BILLS-119hr24", { billStatus: "New" }) });
    // A row whose processed bill is missing.
    table.put(manifestRow("BILLS-119hr30", "2026-10-10T00:00:00.000Z"));
    table.put(lookupItem("BILLS-119hr30", manifestSortKey("2026-10-10T00:00:00.000Z", "BILLS-119hr30")));

    const files = new Map<string, string>();
    const { result, lines, s3Commands } = await run({ table }, { planFile: "plan.jsonl" }, files);

    expect(summaryOf(lines)).toBe(
      "Failed status plan: rows=13 read=11 planned=3 pageOnly=0 markerOnly=1 alreadyMarked=0 noMarkerNeeded=4 toNew=2 toPassed=1 " +
        "storedAtAligned=2 noSourceMetadata=1 " +
        "recent7=1 recent14=1 recent28=2 drift=1 unmanagedStatus=1 finalizedLeft=1 " +
        "skipped(noLookup=1 lookupMismatch=1 noRow=0 rowNotCurrent=1) unreadable=1",
    );
    expect(result).toMatchObject({ exitCode: 1, planFile: "plan.jsonl" });
    expect(s3Commands.every((command) => command === "GetObject")).toBe(true);
    expect(table.calls.every((call) => call.input.ConsistentRead)).toBe(true);
    expect(table.calls.filter((call) => call.name === "QueryCommand")).toHaveLength(5);
    expect(lines).toEqual(
      expect.arrayContaining([
        "  planned BILLS-119hr1: Failed -> New (row 2026-10-27T21:00:00.000Z)\n" +
          `      was: 2026-10-27 ${JSON.stringify(AMENDMENT.text)} (not the bill's failure: amendment)\n` +
          "      now: no passage or failure action",
        "  planned BILLS-119hr44: Failed -> New, storedAt 2026-03-20T12:16:06.945Z -> 2026-03-20T12:16:07.699Z " +
          "(row 2026-03-20T12:16:07.699Z)\n" +
          `      was: 2026-09-15 [9000] ${JSON.stringify(FAILED_SUSPENSION.text)} (not the bill's failure: suspension)\n` +
          "      now: no passage or failure action",
        "  planned BILLS-119s2392: Failed -> Passed, storedAt 2026-10-21T09:12:44.512Z -> 2026-10-05T22:41:29.355Z " +
          "(row 2026-10-05T22:41:29.355Z)\n" +
          `      was: 2026-10-20 ${JSON.stringify(MOTION_TO_PROCEED.text)} (not the bill's failure: motion)\n` +
          `      now: 2026-08-01 [17000] ${JSON.stringify(PASSED_SENATE.text)}`,
        "  skipped (rowNotCurrent) BILLS-119hr9 (Failed -> New): row 2026-10-10T00:00:00.000Z, storedAt 2026-10-10T00:00:00.000Z",
        "  skipped (noLookup) BILLS-119hr10",
        "  skipped (lookupMismatch) BILLS-119hr13: 2026-01-01T00:00:00.000Z#BILLS-119hr13 (lookup: 2026-10-10T00:00:00.000Z#BILLS-119hr13)",
        "  unmanagedStatus BILLS-119hr21: stored Updated, the old rule says Failed, REL-50's rule says New",
        "  finalizedLeft BILLS-119hr22: stored Finalized, the old rule says Failed, REL-50's rule says New",
        "  drift BILLS-119hr23: stored Passed, the old rule says Failed, REL-50's rule says New",
        "  unreadable BILLS-119hr30: no bill",
        "  Not the bill's failure: amendment=1 suspension=1 motion=1",
        "Plan: 3 status lines and 1 marker-only lines in plan.jsonl",
        `  marker only BILLS-119hr9 (rowNotCurrent): stored Failed, was Failed by 2026-10-27 ${JSON.stringify(AMENDMENT.text)} (not the bill's failure: amendment)`,
        "  4 bills the old rule gives Failed get no marker: never stored Failed (after the deploy, take the dry run " +
          "with --deployed-at <deploy start> to mark those it lowered)",
      ]),
    );
    // Only a bill devices can hold as Failed gets a marker (INT-11): one stored Failed. Stored Updated, Finalized,
    // Passed or New (without --deployed-at), the old rule's Failed never reached a device from this bill's row.
    expect(markerLines(files)).toEqual([
      {
        kind: "marker",
        guid: "BILLS-119hr9",
        storedStatus: "Failed",
        status: "New",
        why: "rowNotCurrent",
        decidedBefore: { kind: "failed", actionDate: "2026-10-27", text: AMENDMENT.text, notBillFailure: "amendment" },
      },
    ]);
    expect(planEntries(files).map((entry) => entry.guid)).toEqual([...planEntries(files).map((e) => e.guid)].sort());

    const plan = planLines(files);
    expect(plan.map((line) => line.guid)).toEqual(["BILLS-119hr1", "BILLS-119hr44", "BILLS-119s2392"]);
    const [atStored, march, kept] = plan;
    expect(atStored).toEqual({
      kind: "status",
      guid: "BILLS-119hr1",
      key: "processed-bills/BILLS-119hr1.json",
      versionId: mockS3.current(key(AT_STORED.guid))!.versionId,
      etag: mockS3.current(key(AT_STORED.guid))!.etag,
      fromStatus: "Failed",
      toStatus: "New",
      storedAt: AT_STORED.storedAt,
      toStoredAt: AT_STORED.storedAt,
      manifestSk: `${AT_STORED.storedAt}#BILLS-119hr1`,
      rowUpdatedAt: AT_STORED.storedAt,
      rowContentHash: billContentHash(AT_STORED),
      rowDocumentStoredAt: AT_STORED.storedAt,
      contentHashAfter: billContentHash({ ...AT_STORED, billStatus: "New" }),
      decidedBefore: {
        kind: "failed",
        actionDate: "2026-10-27",
        text: AMENDMENT.text,
        notBillFailure: "amendment",
      },
      decidedAfter: null,
      hasSourceMetadata: true,
    });
    expect(march).toMatchObject({ toStoredAt: MARCH_ROW_AT, storedAt: MARCH.storedAt, hasSourceMetadata: false });
    expect(kept).toMatchObject({
      toStatus: "Passed",
      toStoredAt: KEPT_ROW_AT,
      storedAt: KEPT.storedAt,
      decidedAfter: { kind: "passed", actionCode: "17000", actionDate: "2026-08-01", text: PASSED_SENATE.text },
    });
    // The write lands on each row's own sort key, so CreateBillsManifest rewrites the row in place.
    for (const line of plan) {
      const written = repairedDocument(mockS3.json<Doc>(key(line.guid))!, line.toStatus, line.toStoredAt);
      expect(manifestSortKey(manifestTimestamp(written.storedAt)!, line.guid)).toBe(line.manifestSk);
    }
  });

  it("reports on the rows dated since --since, or the first --limit bills, and writes no plan of them", async () => {
    const table = fakeTable();
    seedThree(table);

    const since = await run({ table }, { since: "2026-10-16T00:00:00.000Z", planFile: "plan.jsonl" });
    expect(summaryOf(since.lines)).toMatch(/^Failed status plan: rows=1 read=1 planned=1 /);
    expect(since.lines).toContain(
      "  planned BILLS-119hr1: Failed -> New (row 2026-10-27T21:00:00.000Z)\n" +
        `      was: 2026-10-27 ${JSON.stringify(AMENDMENT.text)} (not the bill's failure: amendment)\n` +
        "      now: no passage or failure action",
    );
    // F4 of the REL-50 review: an approved plan covers every bill (or names its --guid bills), so no bill that needs
    // a marker drops out of an apply unnoticed.
    expect(since.files.size).toBe(0);
    expect(since.lines).toContain(
      "Report only (--since or --limit): 1 status lines and 0 marker-only lines, no plan file. An apply takes the " +
        "plan of a dry run over every manifest bill (or of the --guid bills).",
    );
    expect(since.result).not.toHaveProperty("planFile");
    const query = table.calls.find((call) => call.name === "QueryCommand")!.input;
    expect(query).toMatchObject({
      KeyConditionExpression: "#pk = :pk AND #sk >= :since",
      ExpressionAttributeValues: { ":pk": { S: "BILL" }, ":since": { S: "2026-10-16T00:00:00.000Z" } },
    });

    const limited = await run({ table }, { limit: 2, planFile: "plan-2.jsonl" });
    expect(summaryOf(limited.lines)).toMatch(/^Failed status plan: rows=2 read=2 planned=2 /);
    expect(limited.files.size).toBe(0);
  });

  it("after the deploy, marks a bill already open only when the old rule's failure is dated by the deploy's day", async () => {
    const table = fakeTable();
    const open = (guid: string, actionDate: string) =>
      bill(guid, "2026-11-03T10:00:00.000Z", {
        billStatus: "New",
        actions: [{ ...AMENDMENT, actionDate }, INTRODUCED],
      });
    // Lowered by billDiffer while the deploy shifted the functions (before CreateBillsManifest marked such rows).
    seed(table, { doc: open("BILLS-119hr60", "2026-11-02") });
    // An undated line: it may be older than the deploy.
    seed(table, { doc: open("BILLS-119hr61", "") });
    // Already marked (CreateBillsManifest marked it when its row left Failed).
    seed(table, { doc: open("BILLS-119hr62", "2026-10-30") });
    table.put({
      pk: { S: "BILL_FORMERLY_FAILED" },
      sk: { S: "BILLS-119hr62" },
      markedAt: { S: "2026-11-02T14:20:00Z" },
    });
    // An amendment rejected after the deploy: billDiffer never stamped it Failed (F3 of the REL-50 review).
    seed(table, { doc: open("BILLS-119hr63", "2026-11-03") });
    // Passed by the new rule: dismissable as Passed anyway.
    seed(table, {
      doc: bill("BILLS-119hr64", "2026-11-03T10:00:00.000Z", {
        billStatus: "Passed",
        actions: [{ ...AMENDMENT, actionDate: "2026-10-30" }, PASSED_SENATE, INTRODUCED],
      }),
    });
    // Still stored Failed: planned, whatever the date.
    seed(table, {
      doc: bill("BILLS-119hr65", "2026-11-03T10:00:00.000Z", { actions: [{ ...AMENDMENT, actionDate: "2026-11-03" }] }),
    });

    const files = new Map<string, string>();
    const { lines } = await run({ table }, { planFile: "plan.jsonl", deployedAt: "2026-11-02T14:00:00.000Z" }, files);

    expect(summaryOf(lines)).toMatch(/ planned=1 pageOnly=0 markerOnly=2 alreadyMarked=1 noMarkerNeeded=2 /);
    expect(markerLines(files).map((line) => [line.guid, line.why, line.storedStatus])).toEqual([
      ["BILLS-119hr60", "alreadyRight", "New"],
      ["BILLS-119hr61", "alreadyRight", "New"],
    ]);
    expect(planLines(files).map((line) => line.guid)).toEqual(["BILLS-119hr65"]);
    expect(lines).toContain(
      "  2 bills the old rule gives Failed get no marker: never stored Failed, or stored open with the old rule's " +
        "failure dated after 2026-11-02",
    );

    // Without --deployed-at (a dry run before the deploy) no bill stored open gets a marker.
    const before = await run({ table }, { planFile: "plan-before.jsonl" });
    expect(summaryOf(before.lines)).toMatch(/ planned=1 pageOnly=0 markerOnly=0 alreadyMarked=0 noMarkerNeeded=5 /);
  });

  it("counts a rowNotCurrent bill that has its marker as alreadyMarked, so the after-check settles (review R6)", async () => {
    const table = fakeTable();
    seed(table, { doc: AT_STORED });
    // Stored Failed, but its row stands for another version (an S3 rollback's copy, say): no status line, a marker.
    seed(table, { doc: bill("BILLS-119hr9", "2026-10-10T00:00:00.000Z"), rowExtra: currentRowStamp(AT_STORED) });
    const files = new Map<string, string>();
    const first = await run({ table }, { planFile: "plan.jsonl" }, files);
    expect(summaryOf(first.lines)).toMatch(/ planned=1 pageOnly=0 markerOnly=1 alreadyMarked=0 .* rowNotCurrent=1\) /);
    await run({ table }, { apply: true, markersOnly: true, planFile: "plan.jsonl" }, files);
    table.calls.length = 0;

    const again = await run({ table }, { planFile: "plan-2.jsonl" }, files);

    expect(summaryOf(again.lines)).toMatch(/ planned=1 pageOnly=0 markerOnly=0 alreadyMarked=1 .* rowNotCurrent=1\) /);
    expect(markerLines(files, "plan-2.jsonl")).toEqual([]);
    expect(again.lines).toContain(
      "  skipped (rowNotCurrent) BILLS-119hr9 (Failed -> New): row 2026-10-10T00:00:00.000Z, storedAt 2026-10-10T00:00:00.000Z",
    );
    // A planned bill's marker is not read: its status line writes it again (markedAt keeps the first).
    const markerReads = table.calls
      .filter((call) => call.name === "GetItemCommand" && call.input.Key!.pk.S === "BILL_FORMERLY_FAILED")
      .map((call) => call.input.Key!.sk.S);
    expect(markerReads).toEqual(["BILLS-119hr9"]);
  });

  it("plans a page-only bill as a status line of its own kind, and skips every near miss (2026-10-29)", async () => {
    const table = fakeTable();
    seedPageOnly(table);
    const near = (guid: string, changes: Partial<Doc> = {}) =>
      bill(guid, PAGE_ONLY.storedAt, { actions: [FAILED_SUSPENSION, INTRODUCED], ...changes });
    const nearRow = (doc: Doc, extra: Item = {}, rowUpdatedAt = PAGE_ONLY_ROW_AT) =>
      seed(table, { doc, rowUpdatedAt, rowExtra: { ...LIST_ROW_NEW, ...extra }, metadata: {} });
    // The row shows another status than REL-50's rule gives.
    nearRow(near("BILLS-119hr70"), { billStatus: { S: "Passed" } });
    // A row a newer release stamped for another version: by its hash, or by its documentStoredAt.
    nearRow(near("BILLS-119hr71"), { contentHash: { S: billContentHash(AT_STORED) } });
    nearRow(near("BILLS-119hr72"), { documentStoredAt: { S: PAGE_ONLY_ROW_AT } });
    // Dated more than 3 s after the document.
    nearRow(near("BILLS-119hr73"), {}, "2026-03-23T18:23:01.584Z");
    // The page says New already, or Failed by the bill's own failure: nothing to put right.
    nearRow(near("BILLS-119hr74", { billStatus: "New" }));
    nearRow(near("BILLS-119hr75", { actions: [FAILED_PASSAGE, INTRODUCED] }));

    const files = new Map<string, string>();
    const { result, lines } = await run({ table }, { planFile: "plan.jsonl" }, files);

    expect(summaryOf(lines)).toBe(
      "Failed status plan: rows=7 read=7 planned=1 pageOnly=1 markerOnly=4 alreadyMarked=0 noMarkerNeeded=1 toNew=1 " +
        "toPassed=0 storedAtAligned=1 noSourceMetadata=1 recent7=0 recent14=0 recent28=0 drift=0 unmanagedStatus=0 " +
        "finalizedLeft=0 skipped(noLookup=0 lookupMismatch=0 noRow=0 rowNotCurrent=4) unreadable=0",
    );
    expect(result.exitCode).toBe(0);
    const skippedAt = (guid: string, rowAt = PAGE_ONLY_ROW_AT) =>
      `  skipped (rowNotCurrent) ${guid} (Failed -> New): row ${rowAt}, storedAt ${PAGE_ONLY.storedAt}`;
    expect(lines).toEqual(
      expect.arrayContaining([
        "  planned (page only) BILLS-119hjres139: Failed -> New, the list row already New, " +
          `storedAt ${PAGE_ONLY.storedAt} -> ${PAGE_ONLY_ROW_AT} (row ${PAGE_ONLY_ROW_AT})\n` +
          `      was: 2026-09-15 [9000] ${JSON.stringify(FAILED_SUSPENSION.text)} (not the bill's failure: suspension)\n` +
          "      now: no passage or failure action",
        skippedAt("BILLS-119hr70"),
        skippedAt("BILLS-119hr71"),
        skippedAt("BILLS-119hr72"),
        skippedAt("BILLS-119hr73", "2026-03-23T18:23:01.584Z"),
        "  1 planned bills are page only: their list row already shows the new status, so the write puts right the " +
          "bill page (GET /processed-bill) and CreateBillsManifest rewrites the row in place as it is.",
      ]),
    );
    // The near misses stored Failed keep their marker-only lines, as before.
    expect(markerLines(files).map((line) => [line.guid, line.why])).toEqual([
      ["BILLS-119hr70", "rowNotCurrent"],
      ["BILLS-119hr71", "rowNotCurrent"],
      ["BILLS-119hr72", "rowNotCurrent"],
      ["BILLS-119hr73", "rowNotCurrent"],
    ]);
    const current = mockS3.current(key(PAGE_ONLY.guid))!;
    const written = repairedDocument(PAGE_ONLY, "New", PAGE_ONLY_ROW_AT);
    expect(planLines(files)).toEqual([
      {
        kind: "status",
        guid: PAGE_ONLY.guid,
        key: key(PAGE_ONLY.guid),
        versionId: current.versionId,
        etag: current.etag,
        fromStatus: "Failed",
        toStatus: "New",
        storedAt: PAGE_ONLY.storedAt,
        toStoredAt: PAGE_ONLY_ROW_AT,
        manifestSk: `${PAGE_ONLY_ROW_AT}#${PAGE_ONLY.guid}`,
        rowUpdatedAt: PAGE_ONLY_ROW_AT,
        rowContentHash: null,
        rowDocumentStoredAt: null,
        contentHashAfter: billContentHash(written),
        decidedBefore: {
          kind: "failed",
          actionCode: "9000",
          actionDate: "2026-09-15",
          text: FAILED_SUSPENSION.text,
          notBillFailure: "suspension",
        },
        decidedAfter: null,
        hasSourceMetadata: false,
        pageOnly: true,
      },
    ]);
    // The write lands on the row's own sort key: CreateBillsManifest rewrites the row in place, its date kept.
    expect(manifestSortKey(manifestTimestamp(written.storedAt)!, PAGE_ONLY.guid)).toBe(planLines(files)[0].manifestSk);
  });

  it("reads only the --guid bills through their lookups", async () => {
    const table = fakeTable();
    seedThree(table);

    const { lines, s3Commands } = await run(
      { table },
      { guids: ["BILLS-119hr44", "BILLS-119hr78"], planFile: "plan.jsonl" },
    );

    expect(s3Commands).toEqual(["GetObject"]);
    expect(table.calls.some((call) => call.name === "QueryCommand")).toBe(false);
    expect(summaryOf(lines)).toMatch(/^Failed status plan: rows=2 read=1 planned=1 .*noLookup=1 /);
  });

  it("writes no plan file when nothing is planned, and never overwrites one", async () => {
    const table = fakeTable();
    seed(table, { doc: bill("BILLS-119hr20", "2026-10-10T00:00:00.000Z", { actions: [FAILED_PASSAGE] }) });
    const empty = await run({ table }, { planFile: "plan.jsonl" });
    expect(empty.files.size).toBe(0);
    expect(empty.lines).toContain("Plan: no status to put right and no bill to mark; no plan file written");
    expect(empty.result.exitCode).toBe(0);

    seedThree(table);
    const files = new Map([["plan.jsonl", "old"]]);
    await expect(run({ table }, { planFile: "plan.jsonl" }, files)).rejects.toThrow("EEXIST: plan.jsonl");
    expect(files.get("plan.jsonl")).toBe("old");
  });
});

describe("repairFailedStatus: apply", () => {
  it("refuses without --rule-live, and with messages in a manifest queue", async () => {
    const table = fakeTable();
    const files = await planThree(table);

    const early = await run({ table }, applyOptions({ ruleLive: false }), files);
    expect(early.result.exitCode).toBe(2);
    expect(early.errors[0][0]).toMatch(/Refusing to apply without --rule-live/);
    expect(early.sqsCommands).toEqual([]);

    const busy = await run(
      { table, sqs: fakeQueues({ BillsManifestDLQ: { ApproximateNumberOfMessages: "1" } }) },
      applyOptions(),
      files,
    );
    expect(busy.result.exitCode).toBe(2);
    expect(busy.errors[0][0]).toMatch(/a manifest queue holds messages/);

    const delayed = await run(
      { table, sqs: fakeQueues({ BillsManifestQueue: { ApproximateNumberOfMessagesDelayed: "2" } }) },
      applyOptions(),
      files,
    );
    expect(delayed.result.exitCode).toBe(2);

    for (const attempt of [early, busy, delayed]) expect(attempt.s3Commands).not.toContain("PutObject");
    expect(files.has("undo.jsonl")).toBe(false);
  });

  it("writes the canary's status only, over the version read, with the metadata kept, and records it", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    const before = mockS3.current(key(AT_STORED.guid))!;

    const { result, lines, sqsCommands } = await run({ table }, applyOptions({ guids: [AT_STORED.guid] }), files);

    expect(lines).toContain(
      "Applied: applied=1 appliedLostResponse=0 alreadyApplied=0 markedOnly=0 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(result).toMatchObject({ exitCode: 0, undoFile: "undo.jsonl" });
    expect(sqsCommands.every((name: string) => name.startsWith("GetQueue"))).toBe(true);
    // Its marker (INT-11), written before the status, and only its.
    expect([...table.markers().keys()]).toEqual([AT_STORED.guid]);
    expect(table.markers().get(AT_STORED.guid)).toEqual({
      pk: { S: "BILL_FORMERLY_FAILED" },
      sk: { S: AT_STORED.guid },
      guid: { S: AT_STORED.guid },
      rule: { S: "REL-50" },
      markedAt: { S: NOW.toISOString() },
      correlationId: { S: "failed-status-rel50-20261030T030000Z" },
      failedOn: { S: "2026-10-27" },
      failedBy: { S: AMENDMENT.text },
      notBillFailure: { S: "amendment" },
    });
    const writes = table.calls.filter((call) => call.name === "UpdateItemCommand");
    expect(writes).toHaveLength(1);
    expect(table.calls.filter((call) => call.name === "PutItemCommand")).toEqual([]);
    const put = mockS3.commands("PutObject");
    expect(put).toHaveLength(1);
    expect(put[0].input).toMatchObject({
      Key: key(AT_STORED.guid),
      IfMatch: before.etag,
      ContentType: "application/json",
    });
    const after = mockS3.current(key(AT_STORED.guid))!;
    expect(JSON.parse(after.body)).toEqual({ ...AT_STORED, billStatus: "New" });
    expect(after.metadata).toEqual({ ...SOURCE_METADATA, "correlation-id": "failed-status-rel50-20261030T030000Z" });
    expect(mockS3.versions(key(KEPT.guid))).toHaveLength(1);
    expect(undoLines(files)).toEqual([
      {
        guid: AT_STORED.guid,
        key: key(AT_STORED.guid),
        manifestSk: `${AT_STORED.storedAt}#${AT_STORED.guid}`,
        correlationId: "failed-status-rel50-20261030T030000Z",
        appliedAt: NOW.toISOString(),
        before: { versionId: before.versionId, billStatus: "Failed", storedAt: AT_STORED.storedAt },
        after: { versionId: after.versionId, billStatus: "New", storedAt: AT_STORED.storedAt },
      },
    ]);
  });

  it("aligns storedAt to the row's date, paces the writes, and a rerun records every line as alreadyApplied", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    const clock = { now: NOW.getTime() };

    await run({ table, clock }, applyOptions(), files);

    expect(clock.now - NOW.getTime()).toBe(1000); // 3 lines at 2 a second
    expect(mockS3.json(key(MARCH.guid))).toEqual({ ...MARCH, storedAt: MARCH_ROW_AT, billStatus: "New" });
    expect(mockS3.json(key(KEPT.guid))).toEqual({ ...KEPT, storedAt: KEPT_ROW_AT, billStatus: "Passed" });
    // A bill without metadata gets only the correlation id.
    expect(mockS3.current(key(MARCH.guid))!.metadata).toEqual({
      "correlation-id": "failed-status-rel50-20261030T030000Z",
    });
    expect(undoLines(files).map((record) => [record.guid, record.after.billStatus, record.after.storedAt])).toEqual([
      [AT_STORED.guid, "New", AT_STORED.storedAt],
      [MARCH.guid, "New", MARCH_ROW_AT],
      [KEPT.guid, "Passed", KEPT_ROW_AT],
    ]);

    const again = await run(
      { table, clock: { now: NOW.getTime() + 60_000 } },
      applyOptions({ undoFile: "undo-2.jsonl" }),
      files,
    );
    expect(again.lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=3 markedOnly=0 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(mockS3.commands("PutObject")).toHaveLength(3);
    expect(undoLines(files, "undo-2.jsonl").map((record) => record.after)).toEqual(
      undoLines(files).map((record) => record.after),
    );
    // The after-check: a dry run with --deployed-at finds nothing to put right or to mark. The two bills now open
    // have their markers; the one now Passed needs none (dismissable as Passed).
    const after = await run({ table }, { planFile: "plan-after.jsonl", deployedAt: "2026-10-29T12:00:00.000Z" });
    expect(summaryOf(after.lines)).toMatch(/ planned=0 pageOnly=0 markerOnly=0 alreadyMarked=2 noMarkerNeeded=1 /);
    expect(after.files.has("plan-after.jsonl")).toBe(false);
    // A rerun's marker write keeps the first markedAt (the legacy-dismissal repair's --formerly-failed-since reads it).
    expect(table.markers().get(MARCH.guid)!.markedAt).toEqual({ S: "2026-10-30T03:00:00.500Z" }); // its line's pace
    expect(table.markers().get(MARCH.guid)!.correlationId).toEqual({ S: "failed-status-rel50-20261030T030100Z" });
  });

  it("applies a page-only line like every other status line: marker first, If-Match, the row's date, undo, no row write", async () => {
    const table = fakeTable();
    seedPageOnly(table);
    // Step 1b marked it, as a rowNotCurrent bill, before the deploy.
    const MARKED_AT = "2026-10-29T16:15:35.935Z";
    table.put({
      pk: { S: "BILL_FORMERLY_FAILED" },
      sk: { S: PAGE_ONLY.guid },
      guid: { S: PAGE_ONLY.guid },
      rule: { S: "REL-50" },
      correlationId: { S: "failed-status-rel50-20261029T161535Z" },
      markerOnly: { S: "rowNotCurrent" },
      markedAt: { S: MARKED_AT },
    });
    const files = new Map<string, string>();
    await run({ table }, { planFile: "plan.jsonl", guids: [PAGE_ONLY.guid] }, files);
    expect(planLines(files).map((line) => [line.guid, line.pageOnly])).toEqual([[PAGE_ONLY.guid, true]]);
    const manifestBefore = [...table.items.entries()].filter(([, item]) => item.pk.S !== "BILL_FORMERLY_FAILED");
    const before = mockS3.current(key(PAGE_ONLY.guid))!;

    // The same gates as every status write: --rule-live, and both manifest queues empty.
    const unstated = await run({ table }, applyOptions({ ruleLive: false }), files);
    const busy = await run(
      { table, sqs: fakeQueues({ BillsManifestQueue: { ApproximateNumberOfMessagesNotVisible: "1" } }) },
      applyOptions(),
      files,
    );
    expect([unstated.result.exitCode, busy.result.exitCode]).toEqual([2, 2]);
    expect(mockS3.commands("PutObject")).toHaveLength(0);

    let markerAtPut: Item | undefined;
    mockS3.beforePut(key(PAGE_ONLY.guid), () => {
      markerAtPut = table.markers().get(PAGE_ONLY.guid);
    });
    const clock = { now: NOW.getTime() };
    const { result, lines } = await run({ table, clock }, applyOptions(), files);

    expect(lines).toContain(
      "Applied: applied=1 appliedLostResponse=0 alreadyApplied=0 markedOnly=0 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(result.exitCode).toBe(0);
    // The marker first (this run's correlation id is on it when the bill is written), its first markedAt kept.
    expect(markerAtPut?.correlationId).toEqual({ S: "failed-status-rel50-20261030T030000Z" });
    expect(table.markers().get(PAGE_ONLY.guid)).toEqual({
      pk: { S: "BILL_FORMERLY_FAILED" },
      sk: { S: PAGE_ONLY.guid },
      guid: { S: PAGE_ONLY.guid },
      rule: { S: "REL-50" },
      correlationId: { S: "failed-status-rel50-20261030T030000Z" },
      markerOnly: { S: "rowNotCurrent" },
      markedAt: { S: MARKED_AT },
      failedOn: { S: "2026-09-15" },
      failedByCode: { S: "9000" },
      failedBy: { S: FAILED_SUSPENSION.text },
      notBillFailure: { S: "suspension" },
    });
    // Over the version read, with its storedAt moved to the row's date and only billStatus else.
    const [put] = mockS3.commands("PutObject");
    expect(put.input).toMatchObject({ Key: key(PAGE_ONLY.guid), IfMatch: before.etag });
    const after = mockS3.current(key(PAGE_ONLY.guid))!;
    expect(JSON.parse(after.body)).toEqual({ ...PAGE_ONLY, storedAt: PAGE_ONLY_ROW_AT, billStatus: "New" });
    expect(after.metadata).toEqual({ "correlation-id": "failed-status-rel50-20261030T030000Z" });
    expect(manifestSortKey(PAGE_ONLY_ROW_AT, PAGE_ONLY.guid)).toBe(manifestBefore[0][1].sk.S);
    // The script writes no row and no lookup (CreateBillsManifest rewrites the row in place); only the marker.
    expect([...table.items.entries()].filter(([, item]) => item.pk.S !== "BILL_FORMERLY_FAILED")).toEqual(
      manifestBefore,
    );
    expect(
      new Set(table.calls.filter((call) => call.name === "UpdateItemCommand").map((c) => c.input.Key!.pk.S)),
    ).toEqual(new Set(["BILL_FORMERLY_FAILED"]));
    expect(undoLines(files)).toEqual([
      {
        guid: PAGE_ONLY.guid,
        key: key(PAGE_ONLY.guid),
        manifestSk: `${PAGE_ONLY_ROW_AT}#${PAGE_ONLY.guid}`,
        correlationId: "failed-status-rel50-20261030T030000Z",
        appliedAt: NOW.toISOString(),
        before: { versionId: before.versionId, billStatus: "Failed", storedAt: PAGE_ONLY.storedAt },
        after: { versionId: after.versionId, billStatus: "New", storedAt: PAGE_ONLY_ROW_AT },
      },
    ]);

    // Idempotent: a rerun finds its own write.
    const again = await run({ table }, applyOptions({ undoFile: "undo-2.jsonl" }), files);
    expect(again.lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=1 markedOnly=0 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(mockS3.commands("PutObject")).toHaveLength(1);
    // The after-check settles: the bill is open on both sides, with its marker.
    const check = await run(
      { table },
      { guids: [PAGE_ONLY.guid], planFile: "plan-after.jsonl", deployedAt: "2026-10-28T23:00:00.000Z" },
    );
    expect(summaryOf(check.lines)).toMatch(/ planned=0 pageOnly=0 markerOnly=0 alreadyMarked=1 /);
  });

  it("writes nothing for a page-only line whose row no longer shows the new status", async () => {
    const table = fakeTable();
    seedPageOnly(table);
    const files = new Map<string, string>();
    await run({ table }, { planFile: "plan.jsonl" }, files);
    // Its row says Failed now, with the date and stamps the plan read.
    table.put(manifestRow(PAGE_ONLY.guid, PAGE_ONLY_ROW_AT, {}));

    const { lines } = await run({ table }, applyOptions(), files);

    expect(lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=0 markedOnly=0 superseded=1 gone=0 failed=0 remaining=0",
    );
    expect(mockS3.commands("PutObject")).toHaveLength(0);
    expect(mockS3.json(key(PAGE_ONLY.guid))).toEqual(PAGE_ONLY);
  });

  it("applies only the first --limit lines", async () => {
    const table = fakeTable();
    const files = await planThree(table);

    const { lines } = await run({ table }, applyOptions({ limit: 2 }), files);

    expect(lines).toContain("Plan plan.jsonl: 2 lines to apply");
    expect(mockS3.commands("PutObject").map((command) => command.input.Key)).toEqual([
      key(AT_STORED.guid),
      key(MARCH.guid),
    ]);
  });

  it("writes nothing for a bill, lookup, row or status that changed since the dry run", async () => {
    const table = fakeTable();
    seedThree(table);
    const fourth = bill("BILLS-119hr2", "2026-10-26T00:00:00.000Z");
    seed(table, { doc: fourth });
    const files = new Map<string, string>();
    await run({ table }, { planFile: "plan.jsonl" }, files);
    // A pipeline write of the first bill, a row stamped for the second, the third's lookup moved, and the fourth
    // stored again as it was (another version, and billDiffer's status): each is superseded.
    mockS3.put(key(AT_STORED.guid), { ...AT_STORED, soWhat: "New summary." }, SOURCE_METADATA);
    table.put(manifestRow(MARCH.guid, MARCH_ROW_AT, { contentHash: { S: billContentHash(MARCH) } }));
    table.put(lookupItem(KEPT.guid, `${KEPT.storedAt}#${KEPT.guid}`));
    mockS3.put(key(fourth.guid), { ...fourth, billStatus: "New" }, SOURCE_METADATA);

    const { result, lines } = await run({ table }, applyOptions(), files);

    expect(lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=0 markedOnly=0 superseded=4 gone=0 failed=0 remaining=0",
    );
    expect(lines).toContain("Superseded lines changed since the dry run: take the dry run again for them.");
    expect(mockS3.commands("PutObject")).toHaveLength(0);
    expect(files.get("undo.jsonl")).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("treats a refused write as superseded, a lost answer as applied, and another error as failed", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    mockS3.injectPutError(key(AT_STORED.guid), 412);
    mockS3.injectPutError(key(KEPT.guid), 500);
    // The second bill's write lands, then its answer is lost.
    const storage = new BillStorage(new S3Client({}), config.bucket);
    const putJson = storage.putJson.bind(storage);
    storage.putJson = async (putKey, payload, putOptions) => {
      const written = await putJson(putKey, payload, putOptions);
      if (putKey === key(MARCH.guid)) throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
      return written;
    };

    const { result, lines, errors } = await run({ table, storage }, applyOptions(), files);

    expect(lines).toContain(
      "Applied: applied=0 appliedLostResponse=1 alreadyApplied=0 markedOnly=0 superseded=1 gone=0 failed=1 remaining=0",
    );
    expect(lines).toContain("A failed line may have landed: run again, which records it if it did (alreadyApplied).");
    expect(errors[0][0]).toBe("Failed to put the bill's status right");
    expect(undoLines(files).map((record) => record.guid)).toEqual([MARCH.guid]);
    expect(result.exitCode).toBe(1);
  });

  it("reports a bill deleted since the dry run as gone", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    mockS3.deleteObject(key(MARCH.guid));

    const { lines } = await run({ table }, applyOptions(), files);

    expect(lines).toContain("  gone: BILLS-119hr44");
  });

  it("stops when an undo record cannot be written, after the write it could not record", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    const appendFile = (path: string, text: string) => {
      if (text.length > 0) throw new Error("ENOSPC");
      files.set(path, files.get(path) ?? "");
    };

    await expect(run({ table, appendFile }, applyOptions(), files)).rejects.toThrow("ENOSPC");
    expect(mockS3.commands("PutObject")).toHaveLength(1);
  });

  it("starts no new line once interrupted", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    let started = 0;
    const interrupted = () => started++ >= 1;

    const { lines, result } = await run({ table, interrupted }, applyOptions(), files);

    expect(lines).toContain("Interrupted: 2 lines remain; run again to resume.");
    expect(result.remaining).toBe(2);
    expect(mockS3.commands("PutObject")).toHaveLength(1);
  });

  it("refuses a plan line that is not a status write of its guid at its row's date", () => {
    const line = {
      kind: "status",
      guid: "BILLS-119hr44",
      key: "processed-bills/BILLS-119hr44.json",
      versionId: "v1",
      etag: '"e"',
      fromStatus: "Failed",
      toStatus: "New",
      storedAt: MARCH.storedAt,
      toStoredAt: MARCH_ROW_AT,
      manifestSk: `${MARCH_ROW_AT}#BILLS-119hr44`,
      rowUpdatedAt: MARCH_ROW_AT,
      rowContentHash: null,
      rowDocumentStoredAt: null,
      contentHashAfter: "v1:a:b",
      decidedBefore: null,
      decidedAfter: null,
      hasSourceMetadata: false,
    };
    expect(parsePlanFile(`${JSON.stringify(line)}\n\n`, config)).toHaveLength(1);
    const refused = (changes: Record<string, unknown>) => () =>
      parsePlanFile(JSON.stringify({ ...line, ...changes }), config);
    expect(refused({ versionId: "" })).toThrow(/missing versionId/);
    expect(refused({ key: "processed-bills/BILLS-119hr2.json" })).toThrow(/not a status write/);
    expect(refused({ toStoredAt: MARCH.storedAt })).toThrow(/not a status write/);
    expect(refused({ fromStatus: 7 })).toThrow(/not a status write/);
    expect(refused({ toStatus: "Finalized" })).toThrow(/not a status write/);
    expect(refused({ toStatus: "Failed" })).toThrow(/not a status write/);
    expect(refused({ rowDocumentStoredAt: 5 })).toThrow(/not a status write/);
    expect(refused({ kind: undefined })).toThrow(/not a status write/);
    // A page-only line: pageOnly true, of a row an older release wrote (no hash, no documentStoredAt).
    expect(parsePlanFile(JSON.stringify({ ...line, pageOnly: true }), config)).toEqual([{ ...line, pageOnly: true }]);
    expect(refused({ pageOnly: false })).toThrow(/not a status write/);
    expect(refused({ pageOnly: "yes" })).toThrow(/not a status write/);
    expect(refused({ pageOnly: true, rowContentHash: "v1:a:b" })).toThrow(/not a status write/);
    expect(refused({ pageOnly: true, rowDocumentStoredAt: MARCH.storedAt })).toThrow(/not a status write/);

    const marker = { kind: "marker", guid: "BILLS-119hr24", storedStatus: "New", status: "New", why: "alreadyRight" };
    expect(parsePlanFile(JSON.stringify({ ...marker, decidedBefore: null }), config)).toEqual([
      { ...marker, decidedBefore: null },
    ]);
    const refusedMarker = (changes: Record<string, unknown>) => () =>
      parsePlanFile(JSON.stringify({ ...marker, ...changes }), config);
    expect(refusedMarker({ guid: "hr24" })).toThrow(/not a marker line/);
    expect(refusedMarker({ guid: "BILLS-119hr24ih" })).toThrow(/not a marker line/);
    expect(refusedMarker({ status: "Failed" })).toThrow(/not a marker line/);
    expect(refusedMarker({ storedStatus: 3 })).toThrow(/not a marker line/);
  });

  it("writes only the marker of a marker-only line, and a failed marker write writes nothing else", async () => {
    const table = fakeTable();
    seedThree(table);
    seed(table, { doc: bill("BILLS-119hr24", "2026-10-10T00:00:00.000Z", { billStatus: "New" }) });
    const files = new Map<string, string>();
    await run({ table }, { planFile: "plan.jsonl", deployedAt: "2026-10-29T12:00:00.000Z" }, files);
    expect(markerLines(files).map((line) => line.guid)).toEqual(["BILLS-119hr24"]);

    const { lines, s3Commands } = await run({ table }, applyOptions({ guids: ["BILLS-119hr24"] }), files);

    expect(lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=0 markedOnly=1 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(s3Commands).toEqual([]);
    expect([...table.markers().keys()]).toEqual(["BILLS-119hr24"]);
    // Open without a marker until now: the legacy-dismissal repair keeps its window open to this markedAt (review R3).
    expect(table.markers().get("BILLS-119hr24")).toMatchObject({
      markerOnly: { S: "alreadyRight" },
      markedAt: { S: NOW.toISOString() },
    });
    expect(files.get("undo.jsonl")).toBe("");

    table.failPuts(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
    const failed = await run({ table }, applyOptions({ guids: [AT_STORED.guid], undoFile: "undo-2.jsonl" }), files);
    expect(failed.lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=0 markedOnly=0 superseded=0 gone=0 failed=1 remaining=0",
    );
    expect(failed.s3Commands).toEqual([]);
    expect(failed.result.exitCode).toBe(1);
  });
});

describe("repairFailedStatus: markers before the deploy (--markers-only)", () => {
  it("writes every line's marker and nothing else, needs no --rule-live and reads no queue", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    seed(table, { doc: bill("BILLS-119hr9", "2026-10-10T00:00:00.000Z"), rowExtra: currentRowStamp(AT_STORED) });
    files.delete("plan.jsonl");
    await run({ table }, { planFile: "plan.jsonl" }, files);
    expect(planEntries(files).map((entry) => [entry.guid, entry.kind])).toEqual([
      ["BILLS-119hr1", "status"],
      ["BILLS-119hr44", "status"],
      ["BILLS-119hr9", "marker"],
      ["BILLS-119s2392", "status"],
    ]);
    const clock = { now: NOW.getTime() };

    const { result, lines, s3Commands, sqsCommands } = await run(
      { table, clock },
      { apply: true, markersOnly: true, planFile: "plan.jsonl" },
      files,
    );

    expect(lines).toContain("Plan plan.jsonl: 4 lines to apply (markers only)");
    expect(lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=0 markedOnly=4 superseded=0 gone=0 failed=0 remaining=0",
    );
    expect(result).toMatchObject({ exitCode: 0, remaining: 0 });
    expect(result).not.toHaveProperty("undoFile");
    expect(clock.now - NOW.getTime()).toBe(1500); // 4 lines at 2 a second
    expect([...table.markers().keys()].sort()).toEqual([
      "BILLS-119hr1",
      "BILLS-119hr44",
      "BILLS-119hr9",
      "BILLS-119s2392",
    ]);
    expect(table.markers().get(KEPT.guid)).toMatchObject({
      rule: { S: "REL-50" },
      failedOn: { S: "2026-10-20" },
      notBillFailure: { S: "motion" },
      markedAt: { S: "2026-10-30T03:00:01.500Z" }, // the fourth line, paced
    });
    // Only a marker-only line says why it has no status line; a status line's marker was written while it was Failed.
    expect(table.markers().get(KEPT.guid)!.markerOnly).toBeUndefined();
    expect(table.markers().get("BILLS-119hr9")!.markerOnly).toEqual({ S: "rowNotCurrent" });
    // No status, no S3 read or write, no queue check, no undo file.
    expect(s3Commands).toEqual([]);
    expect(sqsCommands).toEqual([]);
    expect(files.has("undo.jsonl")).toBe(false);
    expect(mockS3.json(key(AT_STORED.guid))).toEqual(AT_STORED);

    // After the deploy, the status apply writes each marker again and keeps its first markedAt.
    await run({ table, clock: { now: NOW.getTime() + 86_400_000 } }, applyOptions(), files);
    expect(mockS3.json<Doc>(key(AT_STORED.guid))!.billStatus).toBe("New");
    expect(table.markers().get(AT_STORED.guid)!.markedAt).toEqual({ S: NOW.toISOString() });
  });

  it("counts a marker it could not write as failed and goes on", async () => {
    const table = fakeTable();
    const files = await planThree(table);
    table.failPuts(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));

    const { result, lines, errors } = await run(
      { table },
      { apply: true, markersOnly: true, planFile: "plan.jsonl" },
      files,
    );

    expect(lines).toContain(
      "Applied: applied=0 appliedLostResponse=0 alreadyApplied=0 markedOnly=0 superseded=0 gone=0 failed=3 remaining=0",
    );
    expect(lines).toContain("Run again: a marker write is idempotent.");
    expect(errors[0][0]).toBe("Failed to write the bill's marker");
    expect(result.exitCode).toBe(1);
  });
});

describe("repairFailedStatus: undo", () => {
  const applied = async () => {
    const table = fakeTable();
    const files = await planThree(table);
    await run({ table }, applyOptions(), files);
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
    expect(mockS3.json(key(AT_STORED.guid))).toEqual(AT_STORED);
    expect(mockS3.json(key(KEPT.guid))).toEqual({ ...KEPT, storedAt: KEPT_ROW_AT });
    expect(mockS3.current(key(AT_STORED.guid))!.metadata).toEqual({
      ...SOURCE_METADATA,
      "correlation-id": "failed-status-rel50-undo-20261030T040000Z",
    });

    const again = await run({ table }, { undo: "undo.jsonl" }, files);
    expect(again.lines).toContain(
      "Undo: records=3 revertible=0 reverted=0 revertedLostResponse=0 alreadyReverted=3 changedSince=0 failed=0 remaining=0",
    );
  });

  it("leaves a bill written since, and removes a status the bill never had", async () => {
    const { table, files } = await applied();
    mockS3.put(key(AT_STORED.guid), { ...AT_STORED, billStatus: "New", soWhat: "Newer." }, SOURCE_METADATA);
    const record = undoLines(files)[1];
    files.set("undo-none.jsonl", `${JSON.stringify({ ...record, before: { ...record.before, billStatus: null } })}\n`);

    const changed = await run({ table }, { undo: "undo.jsonl", apply: true, guids: [AT_STORED.guid] }, files);
    expect(changed.lines).toContain("  changedSince: BILLS-119hr1");
    expect(mockS3.json<Doc>(key(AT_STORED.guid))!.soWhat).toBe("Newer.");

    await run({ table }, { undo: "undo-none.jsonl", apply: true }, files);
    expect(mockS3.json(key(MARCH.guid))).not.toHaveProperty("billStatus");
  });

  it("refuses a file that is not an undo file of this script", async () => {
    const table = fakeTable();
    const files = new Map([["undo.jsonl", `${JSON.stringify({ guid: "BILLS-119hr1", key: "x" })}\n`]]);
    await expect(run({ table }, { undo: "undo.jsonl" }, files)).rejects.toThrow(/not a repair:failed-status record/);
  });
});
