import { Readable } from "node:stream";
import { DynamoDBClient, TransactWriteItemsCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";

import {
  DEFAULT_RATE,
  DEFAULT_SINCE,
  DEFAULT_STOP_AFTER_SECONDS,
  configFromEnv,
  defaultPlanFile,
  defaultUndoFile,
  parseArgs,
  parsePlanFile,
  pickVersions,
  rowUnchangedCondition,
  runRedate,
  type CliOptions,
  type RunOptions,
  type PlanLine,
  type UndoRecord,
} from "../../scripts/redateManifestRows";
import type { BillPriorityRecord } from "../models/billPriority";
import { BillStorage } from "../adapters/billStorage";
import { billContentHash } from "../shared/billVersionChange";
import { evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

type Item = Record<string, AttributeValue>;

/** A processed bill as the tests build it: the fields they read are typed, any other field is open. */
interface Doc {
  [field: string]: unknown;
  guid: string;
  storedAt: string;
  title: string;
  identifier: { billNumber: string; [field: string]: string };
  subCategories: string[];
  sponsors: string[];
  cosponsors: string[];
  billStatus: string;
  actions: Array<Record<string, string>>;
  officialVotes: {
    house: { members: Array<{ party: string; [field: string]: unknown }>; [field: string]: unknown };
    [field: string]: unknown;
  };
}

/** One write of a transaction, as the fake reads it. */
interface FakeTransactItem extends ConditionInput {
  Item?: Item;
  Key?: Item;
}

/** Every input field the fake DynamoDB and SQS read, across the commands they answer. */
interface FakeInput extends ConditionInput {
  ExclusiveStartKey?: { cursor: { N: string } };
  Select?: string;
  ConsistentRead?: boolean;
  Key?: Item;
  ClientRequestToken?: string;
  TransactItems?: Array<Record<string, FakeTransactItem>>;
  QueueName?: string;
  QueueUrl?: string;
}

/** What the fakes read from an AWS SDK command: its class's name and its input. */
interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

const config = configFromEnv({});
// The 7-day window then starts at 2026-10-07T05:45Z.
const NOW = new Date("2026-10-14T05:45:00.000Z");
const BULK_AT = "2026-10-11T22:41:29.355Z";

const key = (guid: string) => `processed-bills/${guid}.json`;
const sortKey = (updatedAt: string, guid: string) => `${updatedAt}#${guid}`;
const cosponsors = (count: number) => Array.from({ length: count }, (_, index) => `C${String(index).padStart(6, "0")}`);

/** A processed bill before the bulk runs: cosponsors cut off at 20 (REL-28). */
const bill = (guid: string, storedAt: string, changes: Partial<Doc> = {}): Doc => ({
  kind: "processed",
  storedAt,
  identifier: { congress: "119", billType: "hr", billNumber: guid.replace(/\D+/g, "") },
  guid,
  title: `Bill ${guid}`,
  soWhat: "It changes something.",
  subCategories: ["Healthcare"],
  lifeAreas: [],
  sponsors: ["R000606"],
  cosponsors: cosponsors(20),
  actions: [
    { actionCode: "H11100", actionDate: "2026-02-10", text: "Referred to the Committee." },
    { actionCode: "1025", actionDate: "2026-02-10", text: "Introduced in House" },
  ],
  committees: [],
  billStatus: "New",
  officialVotes: {
    house: {
      yea: 216,
      nay: 211,
      resultText: "Passed",
      members: [
        { bioguideId: "A000055", party: "R", votePosition: "Yea" },
        { bioguideId: "V000133", party: "D", votePosition: "Nay" },
      ],
    },
    lastSyncedAt: "2026-03-19T00:00:00.000Z",
    completeness: "complete",
  },
  ...changes,
});

/** The whole second after `at`, as S3 lists a version stored at `at`. */
const listedAt = (at: string) => new Date(Math.floor(Date.parse(at) / 1000) * 1000 + 1000).toISOString();

const manifestRow = (doc: Doc, updatedAt: string, extra: Item = {}): Item => ({
  pk: { S: "BILL" },
  sk: { S: sortKey(updatedAt, doc.guid) },
  guid: { S: doc.guid },
  billType: { S: "hr" },
  congress: { S: "119" },
  billNumber: { S: doc.identifier.billNumber },
  updatedAt: { S: updatedAt },
  title: { S: doc.title },
  subCategories: { L: doc.subCategories.map((value: string) => ({ S: value })) },
  lifeAreas: { L: [] },
  sponsors: { L: doc.sponsors.map((value: string) => ({ S: value })) },
  cosponsors: { L: doc.cosponsors.map((value: string) => ({ S: value })) },
  billStatus: { S: doc.billStatus },
  ...extra,
});

const lookupItem = (guid: string, manifestSk: string): Item => ({
  pk: { S: "BILL_GUID" },
  sk: { S: guid },
  guid: { S: guid },
  manifestSk: { S: manifestSk },
  updatedAt: { S: manifestSk.split("#")[0] },
});

interface BillSetup {
  /** Versions oldest first, each with its S3 metadata; a delete marker when `deleted`. */
  versions: Array<{ doc?: Doc; deleted?: boolean; at: string; metadata?: Record<string, string> }>;
  /** The row's date (default: the latest version's storedAt) and extra attributes. */
  rowUpdatedAt?: string;
  rowExtra?: Item;
  /** The sort key the lookup names (default: the row's). */
  lookupSk?: string;
}

/**
 * BillsManifest in memory: Query (2 items a page, COUNT too), consistent GetItem, and transactions that evaluate the
 * exact condition expressions sent, all or nothing. `beforeTransaction` lands another writer first; `failNext` makes
 * the next transaction throw (after committing, when `commit` is set, as a send whose answer was lost); `failReads`
 * makes the next GetItems throw. A ClientRequestToken is honoured as DynamoDB does within its 10-minute window: the
 * token of a committed transaction with the same items succeeds and writes nothing, with other items it is refused.
 */
const fakeTable = () => {
  const items = new Map<string, Item>();
  const id = (item: Item) => `${item.pk.S}|${item.sk.S}`;
  const calls: Array<{ name: string; input: FakeInput }> = [];
  const hooks: Array<() => void> = [];
  const failures: Array<{ error: Error; commit: boolean }> = [];
  const committedTokens = new Map<string, string>();
  let readFailures = 0;
  const send = jest.fn(async (command: FakeCommand): Promise<Record<string, unknown>> => {
    const name: string = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });
    if (name === "QueryCommand") {
      const pk = input.ExpressionAttributeValues![":pk"].S;
      const since = input.ExpressionAttributeValues![":since"].S;
      const all = [...items.values()]
        .filter((item) => item.pk.S === pk && item.sk.S! >= since!)
        .sort((a, b) => (a.sk.S! < b.sk.S! ? -1 : 1));
      const start = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.cursor.N) : 0;
      const page = all.slice(start, start + 2);
      const next = start + 2 < all.length ? { LastEvaluatedKey: { cursor: { N: String(start + 2) } } } : {};
      return input.Select === "COUNT" ? { Count: page.length, ...next } : { Items: page, ...next };
    }
    if (name === "GetItemCommand") {
      if (readFailures > 0) {
        readFailures -= 1;
        throw Object.assign(new Error("connect ETIMEDOUT"), { name: "TimeoutError" });
      }
      return { Item: items.get(id(input.Key!)) };
    }
    if (name === "TransactWriteItemsCommand") {
      const token = input.ClientRequestToken;
      if (token !== undefined && committedTokens.has(token)) {
        if (committedTokens.get(token) === JSON.stringify(input.TransactItems)) return {};
        throw Object.assign(new Error("Idempotent parameter mismatch"), {
          name: "IdempotentParameterMismatchException",
        });
      }
      hooks.shift()?.();
      const failure = failures.shift();
      if (failure && !failure.commit) throw failure.error;
      const ops = input.TransactItems!.map((entry) => {
        const [kind, op] = Object.entries(entry)[0];
        return { kind, op, itemId: id(kind === "Put" ? op.Item! : op.Key!) };
      });
      const codes = ops.map(({ op, itemId }) =>
        evaluateCondition(items.get(itemId), op) ? "None" : "ConditionalCheckFailed",
      );
      if (codes.some((code) => code !== "None")) {
        throw Object.assign(new Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: codes.map((Code) => ({ Code })),
        });
      }
      for (const { kind, op, itemId } of ops) {
        if (kind === "Put") items.set(itemId, op.Item!);
        else items.delete(itemId);
      }
      if (token !== undefined) committedTokens.set(token, JSON.stringify(input.TransactItems));
      if (failure) throw failure.error;
      return {};
    }
    throw new Error(`Unexpected DynamoDB command ${name}`);
  });
  return {
    db: { send } as RunOptions["db"],
    items,
    calls,
    put: (item: Item) => items.set(id(item), item),
    row: (guid: string, updatedAt: string) => items.get(`BILL|${sortKey(updatedAt, guid)}`),
    lookup: (guid: string) => items.get(`BILL_GUID|${guid}`),
    beforeTransaction: (hook: () => void) => hooks.push(hook),
    failNext: (error: Error, { commit = false } = {}) => failures.push({ error, commit }),
    failReads: (count: number) => {
      readFailures += count;
    },
    transactions: () => calls.filter((call) => call.name === "TransactWriteItemsCommand").map((call) => call.input),
  };
};

type Table = ReturnType<typeof fakeTable>;

/** Stores a bill's versions in the fake bucket and its row and lookup in the table; returns the row's date. */
const seedBill = (table: Table, guid: string, setup: BillSetup): string => {
  // The row reflects the last content version (a later delete marker leaves it, as removals are rare and separate).
  let doc: Doc | undefined;
  for (const version of setup.versions) {
    if (version.deleted) {
      mockS3.deleteObject(key(guid));
      mockS3.versions(key(guid))[0].lastModified = new Date(version.at);
    } else {
      mockS3.putAt(key(guid), version.doc, version.at, version.metadata);
      doc = version.doc;
    }
  }
  if (!doc) throw new Error(`${guid} needs a content version`);
  const updatedAt = setup.rowUpdatedAt ?? doc.storedAt;
  const row = manifestRow(doc, updatedAt, setup.rowExtra);
  table.put(row);
  table.put(lookupItem(guid, setup.lookupSk ?? row.sk.S!));
  return updatedAt;
};

/** The usual shape: one version before the cutoff (`before`) and the bulk run's version (`after`). */
const twoVersions = (guid: string, baselineAt: string, after: Partial<Doc> = {}) => {
  const baseline = bill(guid, baselineAt);
  const current = bill(guid, BULK_AT, { cosponsors: cosponsors(177), ...after });
  return {
    baseline,
    current,
    versions: [
      { doc: baseline, at: listedAt(baselineAt) },
      { doc: current, at: listedAt(BULK_AT) },
    ],
  };
};

const fakeQueues = (depths: Record<string, Partial<Record<string, string>>> = {}) => {
  const send = jest.fn(async (command: FakeCommand) => {
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
  return { send } as RunOptions["sqs"];
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({ ...parseArgs([]), ...overrides });

interface Harness {
  table: Table;
  priority?: Record<string, string>;
  sqs?: RunOptions["sqs"];
  clock?: { now: number };
  appendFile?: (path: string, text: string) => void;
  requirePreventionLive?: boolean;
  interrupted?: () => boolean;
}

/** Runs the script on the fakes and returns what it printed, wrote and read. */
const run = async (harness: Harness, overrides: Partial<CliOptions> = {}, files = new Map<string, string>()) => {
  const lines: string[] = [];
  const errors: unknown[][] = [];
  const sleeps: number[] = [];
  const clock = harness.clock ?? { now: NOW.getTime() };
  const s3CallsBefore = mockS3.calls.length;
  const sqs = harness.sqs ?? fakeQueues();
  const priority = harness.priority ?? {};
  const result = await runRedate({
    db: harness.table.db,
    storage: new BillStorage(new S3Client({}), config.bucket),
    sqs,
    priority: {
      getByGuid: async (guid: string) => (priority[guid] ? ({ status: priority[guid] } as BillPriorityRecord) : null),
    },
    config,
    options: options(overrides),
    ...(harness.requirePreventionLive !== undefined ? { requirePreventionLive: harness.requirePreventionLive } : {}),
    ...(harness.interrupted ? { interrupted: harness.interrupted } : {}),
    log: (...args: unknown[]) =>
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")),
    logError: (...args: unknown[]) => errors.push(args),
    now: () => new Date(clock.now),
    sleep: async (ms: number) => {
      sleeps.push(ms);
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
    sleeps,
    files,
    s3Commands: mockS3.calls.slice(s3CallsBefore).map((call) => call.__cmd),
    sqsCommands: (sqs.send as jest.Mock<unknown, [FakeCommand]>).mock.calls.map(
      ([command]) => command.constructor.name,
    ),
  };
};

const summaryOf = (lines: string[]) => lines.find((line) => line.startsWith("Re-date plan:"));

beforeEach(() => {
  mockS3 = new FakeVersionedS3("2026-03-01T00:00:00.000Z");
});

describe("redateManifestRows: arguments", () => {
  it("defaults to a dry run of every row since the cutoff", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      apply: false,
      guids: [],
      limit: null,
      since: DEFAULT_SINCE,
      concurrency: 8,
      rate: DEFAULT_RATE,
      stopAfterSeconds: DEFAULT_STOP_AFTER_SECONDS,
      planFile: null,
      undoFile: null,
      undo: null,
      preventionLive: false,
    });
    expect(DEFAULT_SINCE).toBe("2026-10-11T19:00:00.000Z");
    expect([DEFAULT_RATE, DEFAULT_STOP_AFTER_SECONDS]).toEqual([5, 420]);
  });

  it("reads every flag", () => {
    expect(
      parseArgs([
        "--apply",
        "--plan-file",
        "plan.jsonl",
        "--guid",
        "BILLS-119hr2743ih",
        "--guid",
        "BILLS-119hr2743",
        "--limit",
        "3",
        "--since",
        "2026-10-11T19:00:00Z",
        "--concurrency",
        "16",
        "--rate",
        "10",
        "--stop-after",
        "60",
        "--undo-file",
        "undo.jsonl",
        "--prevention-live",
      ]),
    ).toEqual(
      options({
        apply: true,
        planFile: "plan.jsonl",
        guids: ["BILLS-119hr2743"],
        limit: 3,
        since: "2026-10-11T19:00:00.000Z",
        concurrency: 16,
        rate: 10,
        stopAfterSeconds: 60,
        undoFile: "undo.jsonl",
        preventionLive: true,
      }),
    );
    expect(parseArgs(["--undo", "undo.jsonl", "--apply"])).toEqual(options({ undo: "undo.jsonl", apply: true }));
  });

  it("refuses unknown, malformed and contradictory arguments", () => {
    expect(() => parseArgs(["--aply"])).toThrow("Unknown argument: --aply");
    expect(() => parseArgs(["--apply"])).toThrow(/--apply needs --plan-file/);
    expect(() => parseArgs(["--guid", "hr2743"])).toThrow(/--guid needs a bill guid/);
    expect(() => parseArgs(["--since", "yesterday"])).toThrow(/--since needs an ISO time/);
    expect(() => parseArgs(["--rate", "11"])).toThrow(/--rate needs a whole number from 1 to 10/);
    expect(() => parseArgs(["--rate", "0"])).toThrow(/--rate/);
    expect(() => parseArgs(["--concurrency", "17"])).toThrow(/--concurrency needs a whole number from 1 to 16/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/--limit/);
    expect(() => parseArgs(["--stop-after", "1.5"])).toThrow(/--stop-after/);
    expect(() => parseArgs(["--plan-file"])).toThrow(/--plan-file needs a file path/);
    expect(() => parseArgs(["--undo", "u.jsonl", "--plan-file", "p.jsonl"])).toThrow(/--undo takes neither/);
  });

  it("names the plan and undo files after the run, and reads production names by default", () => {
    expect(defaultPlanFile(new Date("2026-10-14T17:00:00.123Z"))).toBe(
      "redate-manifest-rows-plan-20261014T170000Z.jsonl",
    );
    expect(defaultUndoFile(new Date("2026-10-14T17:00:00.123Z"))).toBe(
      "redate-manifest-rows-undo-20261014T170000Z.jsonl",
    );
    expect(config).toEqual({
      region: "us-east-1",
      bucket: "billboard-bill-store-bucket",
      processedPrefix: "processed-bills/",
      manifestTableName: "BillsManifest",
      manifestPrimaryKey: "pk",
      manifestSortKey: "sk",
      manifestPkValue: "BILL",
      guidLookupPk: "BILL_GUID",
      priorityTableName: "BillPriority",
      priorityPartitionKey: "guid",
      manifestQueueName: "BillsManifestQueue",
      manifestDlqName: "BillsManifestDLQ",
    });
  });
});

describe("redateManifestRows: the baseline", () => {
  const version = (
    versionId: string,
    lastModified: string,
    extra: Partial<{ isLatest: boolean; isDeleteMarker: boolean }> = {},
  ) => ({
    key: "k",
    versionId,
    lastModified,
    isLatest: false,
    isDeleteMarker: false,
    ...extra,
  });

  it("takes the newest version before the cutoff, in listing order within a second", () => {
    const versions = [
      version("v4", "2026-10-11T22:41:30.000Z", { isLatest: true }),
      version("v3", "2026-03-19T16:57:54.000Z"), // listed first within the second: the newer one
      version("v2", "2026-03-19T16:57:54.000Z"),
      version("v1", "2026-02-01T00:00:00.000Z"),
    ];
    expect(pickVersions(versions, DEFAULT_SINCE)).toEqual({ current: versions[0], baseline: versions[1] });
  });

  it("finds none past a delete marker, and no current version when the latest is one", () => {
    const afterMarker = [
      version("v3", "2026-10-11T20:20:20.000Z", { isLatest: true }),
      version("d2", "2026-02-01T00:00:00.000Z", { isDeleteMarker: true }),
      version("v1", "2026-01-01T00:00:00.000Z"),
    ];
    expect(pickVersions(afterMarker, DEFAULT_SINCE)).toEqual({ current: afterMarker[0], baseline: null });
    const deleted = [version("d2", "2026-10-12T00:00:00.000Z", { isLatest: true, isDeleteMarker: true })];
    expect(pickVersions(deleted, DEFAULT_SINCE)).toEqual({ current: null, baseline: null });
    expect(pickVersions([], DEFAULT_SINCE)).toEqual({ current: null, baseline: null });
  });

  it("keeps S3's order of two versions stored in the same second (listObjectVersionsForKey sorts stably)", async () => {
    const table = fakeTable();
    const guid = "BILLS-119hr2189";
    const first = bill(guid, "2026-03-19T16:53:12.100Z");
    const second = bill(guid, "2026-03-19T16:53:12.705Z", { cosponsors: cosponsors(21) });
    seedBill(table, guid, {
      versions: [
        { doc: first, at: "2026-03-19T16:53:13.000Z" },
        { doc: second, at: "2026-03-19T16:53:13.000Z" },
        { doc: bill(guid, BULK_AT, { cosponsors: cosponsors(30) }), at: listedAt(BULK_AT) },
      ],
    });

    const { files } = await run({ table }, { planFile: "plan.jsonl" });

    expect(parsePlanFile(files.get("plan.jsonl")!)[0]).toMatchObject({ toUpdatedAt: second.storedAt });
  });
});

describe("redateManifestRows: the dry run", () => {
  /** One bill of every outcome, as production had them on 2026-10-14. */
  const seedEveryShape = (table: Table) => {
    const planned = twoVersions("BILLS-119hr2743", "2026-03-19T16:57:53.915Z");
    seedBill(table, "BILLS-119hr2743", { versions: planned.versions, rowExtra: { voteCount: { N: "0" } } });
    // Target inside the 7-day window: the row stays in it.
    const recent = twoVersions("BILLS-119hres684", "2026-10-08T21:18:05.071Z");
    seedBill(table, "BILLS-119hres684", { versions: recent.versions });
    // Re-dated after the prevention deploy kept it: the row has the current version's hash.
    const stamped = twoVersions("BILLS-119sjres117", "2026-03-22T10:58:43.746Z");
    seedBill(table, "BILLS-119sjres117", {
      versions: stamped.versions,
      rowUpdatedAt: "2026-10-11T21:08:39.904Z",
      rowExtra: { contentHash: { S: billContentHash(stamped.current) } },
    });
    // hres1186: a duplicate "Introduced in House" removed. Detail: the row stays.
    const duplicate = bill("BILLS-119hres1186", "2026-04-16T10:00:00.000Z");
    duplicate.actions.push({ ...duplicate.actions[1] });
    seedBill(table, "BILLS-119hres1186", {
      versions: [
        { doc: duplicate, at: listedAt(duplicate.storedAt) },
        { doc: bill("BILLS-119hres1186", BULK_AT, { cosponsors: cosponsors(43) }), at: listedAt(BULK_AT) },
      ],
    });
    // hr3492: a member's party corrected. Detail.
    const party = twoVersions("BILLS-119hr3492", "2026-03-20T12:24:51.097Z");
    party.current.officialVotes.house.members[1].party = "R";
    seedBill(table, "BILLS-119hr3492", { versions: party.versions });
    // A new summary: visible.
    seedBill(table, "BILLS-119sres814", {
      versions: twoVersions("BILLS-119sres814", "2026-07-25T10:58:06.244Z", { soWhat: "New summary." }).versions,
    });
    // A first publication (U9e), and one with only a delete marker before it.
    seedBill(table, "BILLS-119hr6437", {
      versions: [{ doc: bill("BILLS-119hr6437", BULK_AT), at: listedAt(BULK_AT) }],
    });
    seedBill(table, "BILLS-119hr1400", {
      versions: [
        { doc: bill("BILLS-119hr1400", "2026-01-01T00:00:00.000Z"), at: "2026-01-01T00:00:01.000Z" },
        { deleted: true, at: "2026-02-01T00:00:00.000Z" },
        { doc: bill("BILLS-119hr1400", "2026-10-11T20:20:19.780Z"), at: "2026-10-11T20:20:20.000Z" },
      ],
    });
    // The lookup names another row.
    seedBill(table, "BILLS-119hr10", {
      versions: twoVersions("BILLS-119hr10", "2026-03-19T00:00:00.000Z").versions,
      lookupSk: "2026-10-12T00:00:00.000Z#BILLS-119hr10",
    });
    // The processed bill was deleted since.
    seedBill(table, "BILLS-119hr11", {
      versions: [
        ...twoVersions("BILLS-119hr11", "2026-03-19T00:00:00.000Z").versions,
        { deleted: true, at: "2026-10-13T00:00:00.000Z" },
      ],
    });
    // A newer version the row does not reflect yet.
    const pending = twoVersions("BILLS-119hr12", "2026-03-19T00:00:00.000Z");
    seedBill(table, "BILLS-119hr12", {
      versions: [
        ...pending.versions,
        { doc: bill("BILLS-119hr12", "2026-10-13T08:00:00.000Z"), at: "2026-10-13T08:00:01.000Z" },
      ],
      rowUpdatedAt: BULK_AT,
    });
    // A row already exists at the target.
    seedBill(table, "BILLS-119hr13", { versions: twoVersions("BILLS-119hr13", "2026-03-19T00:00:00.000Z").versions });
    table.put(manifestRow(bill("BILLS-119hr13", "2026-03-19T00:00:00.000Z"), "2026-03-19T00:00:00.000Z"));
    // An ACTIVE priority bill.
    seedBill(table, "BILLS-119hr5334", {
      versions: twoVersions("BILLS-119hr5334", "2026-08-31T14:27:55.318Z").versions,
    });
    // A baseline whose storedAt is not older than the row, and one without a storedAt.
    seedBill(table, "BILLS-119hr14", {
      versions: [
        { doc: bill("BILLS-119hr14", "2026-10-12T00:00:00.000Z"), at: "2026-10-11T18:00:00.000Z" },
        { doc: bill("BILLS-119hr14", BULK_AT, { cosponsors: cosponsors(30) }), at: listedAt(BULK_AT) },
      ],
    });
    seedBill(table, "BILLS-119hr15", {
      versions: [
        { doc: bill("BILLS-119hr15", "", { storedAt: undefined }), at: "2026-03-19T00:00:01.000Z" },
        { doc: bill("BILLS-119hr15", BULK_AT, { cosponsors: cosponsors(30) }), at: listedAt(BULK_AT) },
      ],
    });
    // In the 7-day window but before the cutoff: counted, never read.
    table.put(manifestRow(bill("BILLS-119hr16", "2026-10-09T00:00:00.000Z"), "2026-10-09T00:00:00.000Z"));
    table.put(lookupItem("BILLS-119hr16", "2026-10-09T00:00:00.000Z#BILLS-119hr16"));
    // News since the baseline: each keeps its date (manifestDateMoves).
    seedBill(table, "BILLS-119hr20", {
      versions: twoVersions("BILLS-119hr20", "2026-03-19T00:00:00.000Z", { billStatus: "Passed" }).versions,
    });
    const newerAction = twoVersions("BILLS-119hr21", "2026-03-19T00:00:00.000Z");
    newerAction.current.actions.push({ actionCode: "8000", actionDate: "2026-10-09", text: "Passed House" });
    seedBill(table, "BILLS-119hr21", { versions: newerAction.versions });
    const text = twoVersions("BILLS-119hr22", "2026-03-19T00:00:00.000Z", { soWhat: "From the reported text." });
    seedBill(table, "BILLS-119hr22", {
      versions: [
        { ...text.versions[0], metadata: { "source-text-hash": "v1:aaaa" } },
        { ...text.versions[1], metadata: { "source-text-hash": "v1:bbbb" } },
      ],
    });
    return { planned, recent, stamped };
  };

  it("plans the rows whose change brings no news, says why every other row stays, and counts the window", async () => {
    const table = fakeTable();
    const { planned, stamped } = seedEveryShape(table);

    const { result, lines, files, s3Commands } = await run(
      { table, priority: { "BILLS-119hr5334": "ACTIVE" } },
      { planFile: "plan.jsonl" },
    );

    expect(summaryOf(lines)).toBe(
      "Re-date plan: rows=18 planned=6 dated=3 noBaseline=2 skipped(lookupMismatch=1 deleted=1 " +
        "rowNotCurrent=1 badStoredAt=1 notOlder=1 targetOccupied=1 activePriority=1 unreadable=0) window7=19->14",
    );
    expect(result.exitCode).toBe(0);
    expect(lines).toContain("  dated BILLS-119hr20: status");
    expect(lines).toContain("  dated BILLS-119hr21: newerAction");
    expect(lines).toContain("  dated BILLS-119hr22: textVersion");
    expect(lines).toContain("  skipped (lookupMismatch) BILLS-119hr10: 2026-10-12T00:00:00.000Z#BILLS-119hr10");
    expect(lines).toContain("  skipped (rowNotCurrent) BILLS-119hr12: row 2026-10-11T22:41:29.355Z");

    // Since 2026-10-28 a detail change (hres1186's duplicate action, hr3492's member party) and a re-summary of the
    // same text (sres814) are not news either.
    const plan = parsePlanFile(files.get("plan.jsonl")!);
    expect(plan.map((line) => line.guid)).toEqual([
      "BILLS-119hr2743",
      "BILLS-119hr3492",
      "BILLS-119hres1186",
      "BILLS-119hres684",
      "BILLS-119sjres117",
      "BILLS-119sres814",
    ]);
    expect(plan.find((line) => line.guid === "BILLS-119hres1186")!.labels).toEqual([
      "D:actions",
      "K:storedAt",
      "K:cosponsors",
    ]);
    expect(plan.find((line) => line.guid === "BILLS-119sres814")!.labels).toContain("V:soWhat");
    const [hr2743] = plan;
    const versions = mockS3.versions(key("BILLS-119hr2743"));
    expect(hr2743).toEqual({
      guid: "BILLS-119hr2743",
      fromSk: `${BULK_AT}#BILLS-119hr2743`,
      toSk: "2026-03-19T16:57:53.915Z#BILLS-119hr2743",
      fromUpdatedAt: BULK_AT,
      toUpdatedAt: "2026-03-19T16:57:53.915Z",
      baselineVersionId: versions[1].versionId,
      baselineLastModified: "2026-03-19T16:57:54.000Z",
      currentVersionId: versions[0].versionId,
      contentHash: billContentHash(planned.current),
      labels: ["K:storedAt", "K:cosponsors"],
      row: table.row("BILLS-119hr2743", BULK_AT),
      lookup: table.lookup("BILLS-119hr2743"),
    });
    expect(plan.find((line) => line.guid === "BILLS-119sjres117")).toMatchObject({
      fromUpdatedAt: "2026-10-11T21:08:39.904Z",
      contentHash: billContentHash(stamped.current),
    });

    // Reads only.
    expect(new Set(table.calls.map((call) => call.name))).toEqual(new Set(["QueryCommand", "GetItemCommand"]));
    expect(
      table.calls
        .filter((call) => call.name === "QueryCommand")
        .every((call) => call.input.ConsistentRead || call.input.Select === "COUNT"),
    ).toBe(true);
    expect(
      table.calls.filter((call) => call.name === "GetItemCommand").every((call) => call.input.ConsistentRead),
    ).toBe(true);
    expect(new Set(s3Commands)).toEqual(new Set(["ListObjectVersions", "GetObject"]));
  });

  it("dates a row by its last news since --since, judging each version against the one before it", async () => {
    const table = fakeTable();
    const NEWS_AT = "2026-10-12T10:00:00.000Z";
    const LATER_AT = "2026-10-13T09:00:00.000Z";
    const withAction = (guid: string, storedAt: string, changes: Partial<Doc> = {}) => {
      const doc = bill(guid, storedAt, { cosponsors: cosponsors(177), ...changes });
      doc.actions = [...doc.actions, { actionCode: "8000", actionDate: "2026-10-09", text: "Passed House" }];
      return doc;
    };
    // An action on Oct 12 moved the row (news under both rules); a re-summary of the same text on Oct 13 moved it
    // again under the rule of 2026-10-14. The baseline and the latest version differ by the action, so the change
    // since --since alone would call the row dated.
    const resummarized = "BILLS-119hr30";
    seedBill(table, resummarized, {
      versions: [
        { doc: bill(resummarized, "2026-03-19T00:00:00.000Z"), at: "2026-03-19T00:00:01.000Z" },
        { doc: withAction(resummarized, NEWS_AT), at: listedAt(NEWS_AT) },
        { doc: withAction(resummarized, LATER_AT, { soWhat: "A new summary." }), at: listedAt(LATER_AT) },
      ],
    });
    // The same action, then a cosponsor refill that kept the row at the action's date (rule of 2026-10-14).
    const refilled = "BILLS-119hr31";
    const refilledLatest = withAction(refilled, LATER_AT, { cosponsors: cosponsors(180) });
    seedBill(table, refilled, {
      versions: [
        { doc: bill(refilled, "2026-03-19T00:00:00.000Z"), at: "2026-03-19T00:00:01.000Z" },
        { doc: withAction(refilled, NEWS_AT), at: listedAt(NEWS_AT) },
        { doc: refilledLatest, at: listedAt(LATER_AT) },
      ],
      rowUpdatedAt: NEWS_AT,
      rowExtra: { contentHash: { S: billContentHash(refilledLatest) } },
    });

    const { lines, files } = await run({ table }, { guids: [resummarized, refilled], planFile: "plan.jsonl" });

    expect(summaryOf(lines)).toMatch(/^Re-date plan: rows=2 planned=1 dated=1 noBaseline=0 /);
    expect(lines).toContain(`  planned ${resummarized}: ${LATER_AT} -> ${NEWS_AT}, its last news: newerAction`);
    expect(lines).toContain(`  dated ${refilled}: newerAction`);
    const [line] = parsePlanFile(files.get("plan.jsonl")!);
    const versions = mockS3.versions(key(resummarized));
    expect(line).toMatchObject({
      guid: resummarized,
      fromUpdatedAt: LATER_AT,
      toUpdatedAt: NEWS_AT,
      toSk: sortKey(NEWS_AT, resummarized),
      baselineVersionId: versions[1].versionId,
      baselineLastModified: listedAt(NEWS_AT),
      currentVersionId: versions[0].versionId,
      datedBy: ["newerAction"],
    });
    expect(line.labels).toContain("V:soWhat");
  });

  it("plans back a row that only Congressional Record citations re-dated, and dates one with another action (2026-11-12)", async () => {
    const table = fakeTable();
    const BASELINE_AT = "2026-03-19T00:00:00.000Z";
    /** A bill whose actions on its latest date (2026-02-10) have these texts. */
    const withTexts = (guid: string, storedAt: string, texts: string[]) =>
      bill(guid, storedAt, {
        cosponsors: storedAt === BASELINE_AT ? cosponsors(20) : cosponsors(177),
        actions: texts.map((text) => ({ actionCode: "H30000", actionDate: "2026-02-10", text })),
      });
    const seed = (guid: string, before: string[], after: string[]) =>
      seedBill(table, guid, {
        versions: [
          { doc: withTexts(guid, BASELINE_AT, before), at: listedAt(BASELINE_AT) },
          { doc: withTexts(guid, BULK_AT, after), at: listedAt(BULK_AT) },
        ],
      });
    // BILLS-119hr9614's texts of 2026-11-10 and 2026-11-11.
    seed(
      "BILLS-119hr40",
      ["Considered under suspension of the rules."],
      ["Considered under suspension of the rules. (consideration: CR H6104-6105)"],
    );
    seed(
      "BILLS-119hr41",
      ["Considered under suspension of the rules. (consideration: CR H6104-6105)"],
      ["Considered under suspension of the rules. (consideration: CR H6104)"],
    );
    seed(
      "BILLS-119hr42",
      ["Considered under suspension of the rules."],
      [
        "Considered under suspension of the rules. (consideration: CR H6104-6105)",
        "Motion to reconsider laid on the table Agreed to without objection.",
      ],
    );

    const { lines, files } = await run({ table }, { planFile: "plan.jsonl" });

    expect(summaryOf(lines)).toMatch(/^Re-date plan: rows=3 planned=2 dated=1 noBaseline=0 /);
    expect(lines).toContain("  dated BILLS-119hr42: newActionEntry");
    expect(parsePlanFile(files.get("plan.jsonl")!).map((line) => [line.guid, line.toUpdatedAt, line.labels])).toEqual([
      ["BILLS-119hr40", BASELINE_AT, ["V:latestAction", "D:actions", "K:storedAt", "K:cosponsors"]],
      ["BILLS-119hr41", BASELINE_AT, ["V:latestAction", "D:actions", "K:storedAt", "K:cosponsors"]],
    ]);
  });

  it("reads only --guid's rows, and at most --limit", async () => {
    const table = fakeTable();
    seedEveryShape(table);

    const one = await run({ table }, { guids: ["BILLS-119hres684"], planFile: "one.jsonl" });
    const two = await run({ table }, { limit: 2, planFile: "two.jsonl" });

    expect(summaryOf(one.lines)).toMatch(/^Re-date plan: rows=1 planned=1 /);
    expect(summaryOf(two.lines)).toMatch(/^Re-date plan: rows=2 /);
  });

  it("never overwrites a plan file, and writes none for an empty plan", async () => {
    const table = fakeTable();
    seedBill(table, "BILLS-119sres814", {
      versions: twoVersions("BILLS-119sres814", "2026-07-25T10:58:06.244Z", { billStatus: "Passed" }).versions,
    });
    const files = new Map([["plan.jsonl", "reviewed\n"]]);

    const { lines } = await run({ table }, { planFile: "plan.jsonl" }, files);
    expect(lines).toContain("Plan: nothing to re-date; no plan file written");
    expect(files.get("plan.jsonl")).toBe("reviewed\n");

    seedBill(table, "BILLS-119hr2743", {
      versions: twoVersions("BILLS-119hr2743", "2026-03-19T16:57:53.915Z").versions,
    });
    await expect(run({ table }, { planFile: "plan.jsonl" }, files)).rejects.toThrow(/EEXIST/);
  });

  it("counts a row whose version cannot be read as unreadable and exits 1", async () => {
    const table = fakeTable();
    seedBill(table, "BILLS-119hr2743", {
      versions: twoVersions("BILLS-119hr2743", "2026-03-19T16:57:53.915Z").versions,
    });
    mockS3.afterGet(key("BILLS-119hr2743"), () => {
      throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
    });

    const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { result, lines } = await run({ table }, { planFile: "plan.jsonl" });

      expect(result.exitCode).toBe(1);
      expect(summaryOf(lines)).toContain("unreadable=1");
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('"message":"Failed to load bill from S3"'));
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("redateManifestRows: --apply", () => {
  const GUID = "BILLS-119hr2743";
  const FROM_SK = `${BULK_AT}#${GUID}`;
  const TO_AT = "2026-03-19T16:57:53.915Z";
  const TO_SK = `${TO_AT}#${GUID}`;

  /** hr2743 and two more bookkeeping-only bills, planned by a dry run; returns the plan file's text. */
  const planned = async (table: Table, files: Map<string, string>, more = 2) => {
    seedBill(table, GUID, { versions: twoVersions(GUID, TO_AT).versions, rowExtra: { voteCount: { N: "4" } } });
    for (let index = 1; index <= more; index += 1) {
      const guid = `BILLS-119hr${9000 + index}`;
      seedBill(table, guid, { versions: twoVersions(guid, `2026-03-2${index}T00:00:00.000Z`).versions });
    }
    await run({ table }, { planFile: "plan.jsonl" }, files);
    return files.get("plan.jsonl")!;
  };

  const apply = (harness: Harness, files: Map<string, string>, overrides: Partial<CliOptions> = {}) =>
    run(harness, { apply: true, planFile: "plan.jsonl", undoFile: "undo.jsonl", ...overrides }, files);

  const undoRecords = (files: Map<string, string>, file = "undo.jsonl"): UndoRecord[] =>
    (files.get(file) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  it("moves the row and its lookup in one conditional transaction, and writes the undo record", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files, 0);
    const rowBefore = table.row(GUID, BULK_AT)!;
    const lookupBefore = table.lookup(GUID)!;
    const appends: string[] = [];

    const { result, lines, s3Commands, sqsCommands } = await apply(
      {
        table,
        appendFile: (path, text) => {
          appends.push(text);
          files.set(path, (files.get(path) ?? "") + text);
        },
      },
      files,
    );

    expect(result).toMatchObject({ exitCode: 0, remaining: 0 });
    expect(result.applied).toMatchObject({ applied: 1, failed: 0 });
    expect(lines).toContain(
      "Applied: applied=1 appliedLostResponse=0 alreadyRedated=0 superseded=0 movedForward=0 targetOccupied=0 " +
        "activePriority=0 failed=0 remaining=0",
    );
    // The undo file exists before the first write.
    expect(appends[0]).toBe("");

    const [transaction] = table.transactions();
    const [remove, put, lookup] = transaction.TransactItems!;
    expect(remove.Delete).toEqual({
      TableName: "BillsManifest",
      Key: { pk: { S: "BILL" }, sk: { S: FROM_SK } },
      ConditionExpression:
        "#updatedAt = :updatedAt AND #voteCount = :voteCount AND attribute_not_exists(#computedFrom) AND " +
        "attribute_not_exists(#contentHash)",
      ExpressionAttributeNames: {
        "#updatedAt": "updatedAt",
        "#voteCount": "voteCount",
        "#computedFrom": "voteCountComputedFrom",
        "#contentHash": "contentHash",
      },
      ExpressionAttributeValues: { ":updatedAt": { S: BULK_AT }, ":voteCount": { N: "4" } },
    });
    const plan = parsePlanFile(files.get("plan.jsonl")!)[0];
    const rowAfter = { ...rowBefore, sk: { S: TO_SK }, updatedAt: { S: TO_AT }, contentHash: { S: plan.contentHash } };
    expect(put.Put).toEqual({
      TableName: "BillsManifest",
      Item: rowAfter,
      ConditionExpression: "attribute_not_exists(#sk)",
      ExpressionAttributeNames: { "#sk": "sk" },
    });
    const lookupAfter = { ...lookupBefore, manifestSk: { S: TO_SK }, updatedAt: { S: TO_AT } };
    expect(lookup.Put).toEqual({
      TableName: "BillsManifest",
      Item: lookupAfter,
      ConditionExpression: "#manifestSk = :fromSk",
      ExpressionAttributeNames: { "#manifestSk": "manifestSk" },
      ExpressionAttributeValues: { ":fromSk": { S: FROM_SK } },
    });
    // The SDK gives each send its own token (the test below).
    expect(transaction.ClientRequestToken).toBeUndefined();

    expect(table.row(GUID, BULK_AT)).toBeUndefined();
    expect(table.row(GUID, TO_AT)).toEqual(rowAfter);
    expect(table.lookup(GUID)).toEqual(lookupAfter);
    expect(undoRecords(files)).toEqual([
      {
        guid: GUID,
        fromSk: FROM_SK,
        toSk: TO_SK,
        fromUpdatedAt: BULK_AT,
        toUpdatedAt: TO_AT,
        currentVersionId: plan.currentVersionId,
        appliedAt: NOW.toISOString(),
        before: { row: rowBefore, lookup: lookupBefore },
        after: { row: rowAfter, lookup: lookupAfter },
      },
    ]);

    // Only these calls: no S3 write, no SQS send.
    expect(new Set(s3Commands)).toEqual(new Set(["HeadObject"]));
    expect(new Set(sqsCommands)).toEqual(new Set(["GetQueueUrlCommand", "GetQueueAttributesCommand"]));
    expect(new Set(table.calls.map((call) => call.name))).toEqual(
      new Set(["QueryCommand", "GetItemCommand", "TransactWriteItemsCommand"]),
    );
  });

  it("conditions a row without a vote count on its absence", () => {
    expect(rowUnchangedCondition({ updatedAt: { S: BULK_AT } }, BULK_AT)).toEqual({
      ConditionExpression:
        "#updatedAt = :updatedAt AND attribute_not_exists(#voteCount) AND attribute_not_exists(#computedFrom) AND " +
        "attribute_not_exists(#contentHash)",
      ExpressionAttributeNames: {
        "#updatedAt": "updatedAt",
        "#voteCount": "voteCount",
        "#computedFrom": "voteCountComputedFrom",
        "#contentHash": "contentHash",
      },
      ExpressionAttributeValues: { ":updatedAt": { S: BULK_AT } },
    });
  });

  it("reports alreadyRedated on a rerun, writes nothing to the table and records the moves again", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files);
    await apply({ table }, files);
    const writes = table.transactions().length;

    const { result } = await apply({ table }, files, { undoFile: "undo-2.jsonl" });

    expect(result.applied).toMatchObject({ applied: 0, alreadyRedated: 3 });
    expect(table.transactions()).toHaveLength(writes);
    // The plan's row and lookup as before, the table's as after: the same records as the run that moved them.
    expect(undoRecords(files, "undo-2.jsonl")).toEqual(undoRecords(files));
  });

  it("records a move whose run stopped between the commit and its undo record, so its rerun's undo reverts it", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files, 0);
    // The process dies after the commit, before the record (a second Ctrl-C, a crash).
    const died = apply(
      {
        table,
        appendFile: (path, text) => {
          if (text) throw new Error("killed");
          files.set(path, (files.get(path) ?? "") + text);
        },
      },
      files,
    );
    await expect(died).rejects.toThrow("killed");
    expect(table.lookup(GUID)!.manifestSk.S).toBe(TO_SK);
    expect(files.get("undo.jsonl")).toBe("");

    const rerun = await apply({ table }, files, { undoFile: "undo-2.jsonl" });
    const undo = await run({ table }, { undo: "undo-2.jsonl", apply: true }, files);

    expect(rerun.result.applied).toMatchObject({ applied: 0, alreadyRedated: 1 });
    expect(undoRecords(files, "undo-2.jsonl")).toHaveLength(1);
    expect(undo.result.undone).toMatchObject({ reverted: 1 });
    expect(table.lookup(GUID)!.manifestSk.S).toBe(FROM_SK);
  });

  it("records a failed line that committed (its send and re-reads failed) when the run is repeated", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files, 0);
    // The connection drops: the commit's answer is lost and the reads after it fail too.
    table.failNext(Object.assign(new Error("socket hang up"), { name: "TimeoutError" }), { commit: true });
    table.beforeTransaction(() => table.failReads(1));

    const failed = await apply({ table }, files);

    expect(failed.result).toMatchObject({ exitCode: 1 });
    expect(failed.result.applied).toMatchObject({ applied: 0, failed: 1 });
    expect(failed.lines).toContain(
      "A failed line may have committed: run again, which records it if it did (alreadyRedated).",
    );
    expect(table.lookup(GUID)!.manifestSk.S).toBe(TO_SK);
    expect(files.get("undo.jsonl")).toBe("");

    const rerun = await apply({ table }, files, { undoFile: "undo-2.jsonl" });
    const check = await run({ table }, { undo: "undo-2.jsonl" }, files);

    expect(rerun.result.applied).toMatchObject({ alreadyRedated: 1, failed: 0 });
    const [record] = undoRecords(files, "undo-2.jsonl");
    const plan = parsePlanFile(files.get("plan.jsonl")!)[0];
    expect(record).toMatchObject({
      fromSk: FROM_SK,
      toSk: TO_SK,
      before: { row: plan.row, lookup: plan.lookup },
      after: { row: table.row(GUID, TO_AT), lookup: table.lookup(GUID) },
    });
    expect(check.result.undone).toMatchObject({ revertible: 1, movedSinceRedate: 0 });
  });

  it("starts no line after an interrupt, once the line in flight has written its undo record", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files);
    let interrupted = false;
    // Ctrl-C while the first line's transaction is in flight.
    table.beforeTransaction(() => {
      interrupted = true;
    });

    const { result, lines } = await apply({ table, interrupted: () => interrupted }, files);

    expect(result.applied).toMatchObject({ applied: 1, failed: 0 });
    expect(result.remaining).toBe(2);
    expect(undoRecords(files)).toHaveLength(1);
    expect(lines).toContain("Interrupted: 2 lines remain; run again to resume.");
  });

  it("skips a row whose date or processed bill changed since the dry run (superseded)", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files);
    // hr9001 got a new version (its row is not moved yet): HEAD differs.
    mockS3.put(key("BILLS-119hr9001"), bill("BILLS-119hr9001", "2026-10-14T05:00:00.000Z"));
    // hr9002's row was rewritten in place with another date.
    const row = table.row("BILLS-119hr9002", BULK_AT)!;
    table.put({ ...row, updatedAt: { S: "2026-10-11T22:41:29.999Z" } });

    const { result, lines } = await apply({ table }, files);

    expect(result.applied).toMatchObject({ applied: 1, superseded: 2 });
    expect(lines).toContain("  superseded: BILLS-119hr9001");
    expect(lines).toContain("Superseded lines changed since the dry run: run the dry run again for them.");
  });

  it("skips a row a newer version moved (movedForward), a taken target and an ACTIVE priority bill", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files);
    const newerSk = `2026-10-13T00:00:00.000Z#${GUID}`;
    table.put({ ...table.lookup(GUID)!, manifestSk: { S: newerSk } });
    table.put(manifestRow(bill("BILLS-119hr9001", "2026-03-21T00:00:00.000Z"), "2026-03-21T00:00:00.000Z"));

    const { result } = await apply({ table, priority: { "BILLS-119hr9002": "ACTIVE" } }, files);

    expect(result.applied).toMatchObject({ applied: 0, movedForward: 1, targetOccupied: 1, activePriority: 1 });
    expect(table.lookup("BILLS-119hr9001")!.manifestSk.S).toBe(`${BULK_AT}#BILLS-119hr9001`);
  });

  it("reads again and keeps a vote count billStatsAggregator wrote before the commit", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files, 0);
    table.beforeTransaction(() => {
      table.put({ ...table.row(GUID, BULK_AT)!, voteCount: { N: "5" } });
    });

    const { result } = await apply({ table }, files);

    expect(result.applied).toMatchObject({ applied: 1 });
    expect(table.transactions()).toHaveLength(2);
    expect(table.row(GUID, TO_AT)!.voteCount).toEqual({ N: "5" });
    expect(undoRecords(files)[0].before.row.voteCount).toEqual({ N: "5" });
  });

  it("finds its own commit when the answer was lost (appliedLostResponse) and still writes the undo record", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files, 0);
    table.failNext(Object.assign(new Error("socket hang up"), { name: "TimeoutError" }), { commit: true });

    const { result } = await apply({ table }, files);

    expect(result.applied).toMatchObject({ applied: 0, appliedLostResponse: 1, failed: 0 });
    expect(undoRecords(files)).toHaveLength(1);
    expect(table.lookup(GUID)!.manifestSk.S).toBe(TO_SK);
  });

  it("leaves the ClientRequestToken to the SDK: a new one for each send, the same on its retry of a lost answer", async () => {
    const tokens: string[] = [];
    const client = new DynamoDBClient({
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 2,
      requestHandler: {
        handle: async (request: { body: string }) => {
          tokens.push(JSON.parse(request.body).ClientRequestToken);
          // The first answer is lost (a 500 here): the SDK sends the same request again.
          const lost = tokens.length === 1;
          return {
            response: {
              statusCode: lost ? 500 : 200,
              headers: { "content-type": "application/x-amz-json-1.0" },
              body: Readable.from([Buffer.from(lost ? '{"__type":"InternalServerError"}' : "{}")]),
            },
          };
        },
      },
    });
    const items = [{ Put: { TableName: "BillsManifest", Item: { pk: { S: "BILL" }, sk: { S: TO_SK } } } }];

    await client.send(new TransactWriteItemsCommand({ TransactItems: items }));
    await client.send(new TransactWriteItemsCommand({ TransactItems: items }));

    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it("backs off and retries a TransactionConflict, and fails on any other error", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files, 1);
    table.failNext(
      Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }, { Code: "None" }],
      }),
    );
    table.failNext(Object.assign(new Error("ValidationException"), { name: "ValidationException" }));

    const { result, errors } = await apply({ table }, files);

    // hr2743: conflict, then the validation error; hr9001 applies.
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.applied).toMatchObject({ applied: 1, failed: 1 });
    expect(errors[0][0]).toBe("Failed to re-date the manifest row");
  });

  it("refuses to start while a manifest queue holds messages, before creating the undo file", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files);

    const busy = await apply(
      { table, sqs: fakeQueues({ BillsManifestQueue: { ApproximateNumberOfMessagesNotVisible: "1" } }) },
      files,
    );
    const dead = await apply(
      { table, sqs: fakeQueues({ BillsManifestDLQ: { ApproximateNumberOfMessages: "2" } }) },
      files,
    );

    expect(busy.result.exitCode).toBe(2);
    expect(busy.lines).toContain("  BillsManifestQueue: visible=0 notVisible=1 delayed=0");
    expect(dead.result.exitCode).toBe(2);
    expect(table.transactions()).toEqual([]);
    expect(files.has("undo.jsonl")).toBe(false);
  });

  it("refuses to start without --prevention-live when the project decision requires it", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files);

    const refused = await apply({ table, requirePreventionLive: true }, files);
    const allowed = await apply({ table, requirePreventionLive: true }, files, { preventionLive: true });

    expect(refused.result.exitCode).toBe(2);
    expect(allowed.result.applied).toMatchObject({ applied: 3 });
  });

  it("stops when an undo record cannot be written", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files);
    let appends = 0;

    const attempt = apply(
      {
        table,
        appendFile: () => {
          appends += 1;
          if (appends > 1) throw new Error("ENOSPC");
        },
      },
      files,
    );

    await expect(attempt).rejects.toThrow("ENOSPC");
    expect(table.transactions()).toHaveLength(1);
  });

  it("applies only --guid's lines, at most --limit", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files);

    const one = await apply({ table }, files, { guids: ["BILLS-119hr9002"], undoFile: "u1.jsonl" });
    const limited = await apply({ table }, files, { limit: 1, undoFile: "u2.jsonl" });

    expect(one.result.applied).toMatchObject({ applied: 1 });
    expect(table.lookup("BILLS-119hr9002")!.manifestSk.S).toBe("2026-03-22T00:00:00.000Z#BILLS-119hr9002");
    expect(limited.result.applied).toMatchObject({ applied: 1 });
    expect(table.lookup(GUID)!.manifestSk.S).toBe(TO_SK);
    expect(table.lookup("BILLS-119hr9001")!.manifestSk.S).toBe(`${BULK_AT}#BILLS-119hr9001`);
  });

  it("starts at most --rate lines a second and stops starting them at --stop-after", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    await planned(table, files, 7);
    const clock = { now: NOW.getTime() };

    const { result, lines, sleeps } = await apply({ table, clock }, files, { rate: 5, stopAfterSeconds: 1 });

    expect(result.applied).toMatchObject({ applied: 5 });
    expect(result.remaining).toBe(3);
    expect(sleeps).toEqual([200, 200, 200, 200]);
    expect(lines).toContain("Stopped after 1 s: 3 lines remain; run again to resume.");

    const resumed = await apply({ table, clock }, files, { undoFile: "undo-2.jsonl" });
    expect(resumed.result.applied).toMatchObject({ applied: 3, alreadyRedated: 5 });
    expect(undoRecords(files, "undo-2.jsonl")).toHaveLength(8);
  });

  it("refuses a plan line that is not a re-date to an older key of its own guid", () => {
    const line = (changes: Partial<PlanLine>) =>
      JSON.stringify({
        guid: GUID,
        fromSk: FROM_SK,
        toSk: TO_SK,
        fromUpdatedAt: BULK_AT,
        toUpdatedAt: TO_AT,
        baselineVersionId: "v1",
        baselineLastModified: "2026-03-19T16:57:54.000Z",
        currentVersionId: "v2",
        contentHash: "v1:0123456789abcdef:0123456789abcdef",
        labels: [],
        row: {},
        lookup: {},
        ...changes,
      });
    expect(parsePlanFile(`${line({})}\n\n`)).toHaveLength(1);
    expect(() => parsePlanFile(line({ toSk: `${TO_AT}#BILLS-119hr1` }))).toThrow(/not a re-date/);
    expect(() => parsePlanFile(line({ toSk: FROM_SK, toUpdatedAt: BULK_AT }))).toThrow(/not a re-date/);
    expect(() => parsePlanFile(line({ contentHash: "v0:x" }))).toThrow(/contentHash/);
    expect(() => parsePlanFile(line({ currentVersionId: "" }))).toThrow(/missing currentVersionId/);
  });
});

describe("redateManifestRows: --undo", () => {
  const seedAndApply = async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    for (const [index, guid] of ["BILLS-119hr2743", "BILLS-119hr9001", "BILLS-119hr9002"].entries()) {
      seedBill(table, guid, {
        versions: twoVersions(guid, `2026-03-1${index + 1}T00:00:00.000Z`).versions,
        rowExtra:
          index === 0 ? { voteCount: { N: "7" }, voteCountComputedFrom: { S: "2026-10-01T00:00:00.000Z" } } : {},
      });
    }
    const before = new Map(table.items);
    await run({ table }, { planFile: "plan.jsonl" }, files);
    await run({ table }, { apply: true, planFile: "plan.jsonl", undoFile: "undo.jsonl" }, files);
    return { table, files, before };
  };

  it("finds every applied row still revertible in the dry run (the post-apply check), and writes nothing", async () => {
    const { table, files } = await seedAndApply();
    const writes = table.transactions().length;

    const { result, lines } = await run({ table }, { undo: "undo.jsonl" }, files);

    expect(result.undone).toMatchObject({ revertible: 3, movedSinceRedate: 0 });
    expect(lines).toContain(
      "Undo: records=3 revertible=3 reverted=0 revertedLostResponse=0 movedSinceRedate=0 failed=0 remaining=0",
    );
    expect(table.transactions()).toHaveLength(writes);
  });

  it("moves applied rows back, keeping their contentHash, and leaves a row a newer version moved", async () => {
    const { table, files, before } = await seedAndApply();
    // A newer, visible version moved hr9001 after the re-date.
    const moved = table.row("BILLS-119hr9001", "2026-03-12T00:00:00.000Z")!;
    table.items.delete("BILL|2026-03-12T00:00:00.000Z#BILLS-119hr9001");
    const newerSk = "2026-10-14T00:00:00.000Z#BILLS-119hr9001";
    table.put({ ...moved, sk: { S: newerSk }, updatedAt: { S: "2026-10-14T00:00:00.000Z" } });
    table.put({ ...table.lookup("BILLS-119hr9001")!, manifestSk: { S: newerSk } });

    const { result } = await run({ table }, { undo: "undo.jsonl", apply: true }, files);

    expect(result.undone).toMatchObject({ reverted: 2, movedSinceRedate: 1 });
    for (const guid of ["BILLS-119hr2743", "BILLS-119hr9002"]) {
      const lookup = before.get(`BILL_GUID|${guid}`)!;
      const { contentHash, ...row } = table.items.get(`BILL|${lookup.manifestSk.S}`)!;
      expect(row).toEqual(before.get(`BILL|${lookup.manifestSk.S}`));
      expect(contentHash.S).toMatch(/^v1:/);
      expect(table.lookup(guid)).toEqual(lookup);
    }
    expect(table.lookup("BILLS-119hr9001")!.manifestSk.S).toBe(newerSk);
    // BILL and BILL_GUID still pair up one to one.
    const bills = [...table.items.values()].filter((item) => item.pk.S === "BILL");
    expect(bills).toHaveLength(3);
  });

  it("moves back every applied line of a plan file, recorded or not, and leaves the others", async () => {
    const table = fakeTable();
    const files = new Map<string, string>();
    const guids = ["BILLS-119hr2743", "BILLS-119hr9001", "BILLS-119hr9002"];
    for (const [index, guid] of guids.entries()) {
      seedBill(table, guid, { versions: twoVersions(guid, `2026-03-1${index + 1}T00:00:00.000Z`).versions });
    }
    const before = new Map(table.items);
    await run({ table }, { planFile: "plan.jsonl" }, files);
    await run({ table }, { apply: true, planFile: "plan.jsonl", undoFile: "undo.jsonl", limit: 2 }, files);
    // One of the two applied moves has no undo record.
    files.set("undo.jsonl", files.get("undo.jsonl")!.split("\n").slice(0, 1).join("\n"));

    const check = await run({ table }, { undo: "plan.jsonl" }, files);
    const { result } = await run({ table }, { undo: "plan.jsonl", apply: true }, files);

    expect(check.result.undone).toMatchObject({ revertible: 2, movedSinceRedate: 1 });
    expect(result.undone).toMatchObject({ reverted: 2, movedSinceRedate: 1, failed: 0 });
    for (const guid of guids) expect(table.lookup(guid)).toEqual(before.get(`BILL_GUID|${guid}`));
  });

  it.each([
    ["a row without a contentHash", false],
    ["a row the prevention change stamped", true],
  ])("applies, undoes, applies and undoes %s within minutes, writing each time", async (_name, stamped) => {
    const table = fakeTable();
    const files = new Map<string, string>();
    const guid = "BILLS-119hr2743";
    const toAt = "2026-03-19T16:57:53.915Z";
    const { versions, current } = twoVersions(guid, toAt);
    seedBill(table, guid, {
      versions,
      rowExtra: stamped ? { contentHash: { S: billContentHash(current) } } : {},
    });
    await run({ table }, { planFile: "plan.jsonl" }, files);

    const lookups: string[] = [];
    for (const round of [1, 2]) {
      await run({ table }, { apply: true, planFile: "plan.jsonl", undoFile: `undo-${round}.jsonl` }, files);
      lookups.push(table.lookup(guid)!.manifestSk.S!);
      await run({ table }, { undo: `undo-${round}.jsonl`, apply: true }, files);
      lookups.push(table.lookup(guid)!.manifestSk.S!);
    }

    // The second undo repeats the first one's items exactly (and, for a stamped row, the second apply the first's):
    // with a token derived from them, DynamoDB would answer success and write nothing.
    const fromSk = `${BULK_AT}#${guid}`;
    const toSk = `${toAt}#${guid}`;
    expect(lookups).toEqual([toSk, fromSk, toSk, fromSk]);
    expect(table.row(guid, BULK_AT)).toBeDefined();
    expect(table.row(guid, toAt)).toBeUndefined();
  });
});
