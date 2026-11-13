// REL-56 backfill, decision D2 (docs/RUNBOOK.md 4.9 and 16.1): a first publication the backfill wrote is dated by
// congress.gov's update time, not by the backfill window's storedAt; every other write is dated as before.
process.env.BUCKET_NAME = "test-bucket";
process.env.TABLE_NAME = "test-table";
process.env.PRIMARY_KEY = "pk";
process.env.SORT_KEY = "sk";
process.env.PK_VALUE = "BILL";
process.env.QUEUE_URL = "https://example.com/notification-type";
process.env.CONGRESS_MEMBER_STATS_QUEUE_URL = "https://example.com/member-stats";

import { DynamoDBClient, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { handler } from "../handlers/createBillsManifest";
import { buildBillsManifest } from "../shared/billsManifestBuilder";
import { billContentHash, formatDateBasis, manifestDateBasis } from "../shared/billVersionChange";
import { asSqsEvent } from "./fixtures/awsEvents";
import { evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { jsonReadable } from "./fixtures/streams";
import { FakeVersionedS3, type FakeS3Command } from "./fakeVersionedS3";

type Item = Record<string, AttributeValue>;
type DdbCommand = { __type: string; input: Record<string, unknown> };
type WriteSpec = ConditionInput & { Item?: Item; Key?: Item };
type TransactItem = { Put?: WriteSpec; Delete?: WriteSpec; Update?: WriteSpec };
type SqsEntry = { Id: string; MessageBody: string };

let mockS3 = new FakeVersionedS3("2026-11-20T15:00:00.000Z");
/** The table: items by "pk|sk". */
let mockTable = new Map<string, Item>();
/** Runs once, before the next transaction is checked (a concurrent writer). */
let mockBeforeTransaction: (() => Promise<void>) | null = null;
const mockDdbCommands: DdbCommand[] = [];
const mockSqsSends: Array<{ QueueUrl: string; Entries: SqsEntry[] }> = [];

const mockItemKey = (key: Item | undefined): string => {
  if (!key?.pk?.S || !key?.sk?.S) throw new Error("Missing pk or sk");
  return `${key.pk.S}|${key.sk.S}`;
};

/** A GetObject answer from the fake bucket: it carries a body that reads as a string. */
const hasBody = (response: object): response is { Body: { transformToString(): Promise<string> } } =>
  "Body" in response;

const mockSendS3 = async (command: FakeS3Command) => {
  const response = await mockS3.send(command);
  if (command.__cmd !== "GetObject" || !hasBody(response)) return response;
  // The handler streams the body, as the SDK's Readable in Lambda.
  return { ...response, Body: jsonReadable(JSON.parse(await response.Body.transformToString())) };
};

const mockSendDdb = async (command: DdbCommand) => {
  mockDdbCommands.push(command);
  if (command.__type === "GetItem") {
    return { Item: mockTable.get(mockItemKey(command.input.Key as Item)) };
  }
  if (command.__type === "Query") {
    // The manifest build's key condition: the partition and, for a windowed load, sort keys after its start.
    const values = command.input.ExpressionAttributeValues as Item;
    const after = values[":updatedAfter"]?.S;
    const Items = [...mockTable.values()]
      .filter((item) => item.pk.S === values[":pk"].S && (after === undefined || (item.sk.S ?? "") > after))
      .sort((a, b) => (a.sk.S ?? "").localeCompare(b.sk.S ?? ""));
    return { Items };
  }
  if (command.__type === "TransactWriteItems") {
    const hook = mockBeforeTransaction;
    mockBeforeTransaction = null;
    if (hook) await hook();
    const ops = command.input.TransactItems as TransactItem[];
    const keys = ops.map((op) => {
      if (op.Update) throw new Error("No Update expected in these tests");
      return mockItemKey(op.Put?.Item ?? op.Delete?.Key);
    });
    const codes = ops.map((op, index) =>
      evaluateCondition(mockTable.get(keys[index]), op.Put ?? op.Delete) ? "None" : "ConditionalCheckFailed",
    );
    if (codes.some((code) => code !== "None")) {
      throw Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: codes.map((Code) => ({ Code })),
      });
    }
    ops.forEach((op, index) => {
      if (op.Put?.Item) mockTable.set(keys[index], op.Put.Item);
      else mockTable.delete(keys[index]);
    });
    return {};
  }
  throw new Error(`Unexpected DynamoDB command ${command.__type}`);
};

jest.mock("@aws-sdk/client-s3", () => {
  const command = (name: string) => jest.fn().mockImplementation((input: unknown) => ({ __cmd: name, input }));
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: (cmd: FakeS3Command) => mockSendS3(cmd) })),
    GetObjectCommand: command("GetObject"),
    HeadObjectCommand: command("HeadObject"),
    ListObjectVersionsCommand: command("ListObjectVersions"),
  };
});

jest.mock("@aws-sdk/client-dynamodb", () => {
  const command = (name: string) => jest.fn().mockImplementation((input: unknown) => ({ __type: name, input }));
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({ send: (cmd: DdbCommand) => mockSendDdb(cmd) })),
    GetItemCommand: command("GetItem"),
    QueryCommand: command("Query"),
    TransactWriteItemsCommand: command("TransactWriteItems"),
  };
});

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn().mockImplementation(() => ({
    send: async (cmd: { input: { QueueUrl: string; Entries: SqsEntry[] } }) => {
      mockSqsSends.push(cmd.input);
      return { Successful: cmd.input.Entries.map((entry) => ({ Id: entry.Id })), Failed: [] };
    },
  })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

const guid = "BILLS-119hr2743";
const key = `processed-bills/${guid}.json`;
const rawKey = `raw-bills/${guid}.json`;
const TEXT = { "source-text-hash": "v1:0b6f1c1d2a3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccdd" };
/** When the backfill window stored the processed bill, and the trace ids a processed write carries (OBS-10). */
const WINDOW_STORED_AT = "2026-11-20T15:04:05.678Z";
const BACKFILL_ID = `rel56:2026-11-20T14:30:00.000Z:${guid}`;
const POLLER_ID = `2026-11-20T14:59:40.000Z:${guid}`;
/** congress.gov's two update times of a bill introduced in May, as the backfill's detail copy has them. */
const MAY_UPDATE = { updateDate: "2026-05-21T08:08:29Z", updateDateIncludingText: "2026-05-22T14:03:11Z" };
const MAY_DATE = "2026-05-22T14:03:11.000Z";
const BACKFILL_FETCHED_AT = "2026-11-20T15:03:51.000Z";

const cosponsors = (count: number) => Array.from({ length: count }, (_, index) => `C${String(index).padStart(6, "0")}`);

type ProcessedDoc = {
  kind: string;
  storedAt: string;
  identifier: { congress: string; billType: string; billNumber: string };
  guid: string;
  title: string;
  soWhat: string;
  subCategories: string[];
  lifeAreas: string[];
  sponsors: string[];
  cosponsors: string[];
  actions: Array<{ actionCode?: string; actionDate: string; text: string }>;
  committees: unknown[];
  billStatus: string;
};

/** The processed bill the backfill window stored: the bill's only version, written from the backfill's raw copy. */
const mayBill: ProcessedDoc = {
  kind: "processed",
  storedAt: WINDOW_STORED_AT,
  identifier: { congress: "119", billType: "hr", billNumber: "2743" },
  guid,
  title: "Lowers Drug Costs for Seniors",
  soWhat: "Seniors would pay less for insulin.",
  subCategories: ["Healthcare"],
  lifeAreas: ["Medical Costs"],
  sponsors: ["R000606"],
  cosponsors: cosponsors(20),
  actions: [
    { actionCode: "H11100", actionDate: "2026-05-20", text: "Referred to the Committee on Energy and Commerce." },
  ],
  committees: [],
  billStatus: "New",
};

/** A raw copy as fetchRawBill stores it, with congress.gov's update times in content.bill.bill. */
const rawCopy = (update: { updateDate?: string; updateDateIncludingText?: string }, fetchedAt: string) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: fetchedAt,
  identifier: { congress: "119", billType: "hr", billNumber: "2743" },
  metadata: { guid, title: mayBill.title, pubDate: "2026-11-03T00:00:00.000Z", fetchedAt },
  content: { bill: { bill: { number: "2743", introducedDate: "2026-05-20", ...update } } },
});

/** The processed write's S3 metadata: its text hash, the raw version it was built from and its trace id. */
const written = (correlationId: string, rawVersion?: string): Record<string, string> => ({
  ...TEXT,
  ...(rawVersion ? { "source-raw-version": rawVersion } : {}),
  "correlation-id": correlationId,
});

const basisOf = (doc: ProcessedDoc) => formatDateBasis(manifestDateBasis(doc, TEXT["source-text-hash"]));

/** The exact row a first publication of `doc` writes at `updatedAt`: every attribute, as before D2. */
const firstRow = (doc: ProcessedDoc, updatedAt: string, documentStoredAt = doc.storedAt): Item => ({
  pk: { S: "BILL" },
  sk: { S: `${updatedAt}#${guid}` },
  guid: { S: guid },
  billType: { S: "hr" },
  congress: { S: "119" },
  billNumber: { S: "2743" },
  updatedAt: { S: updatedAt },
  title: { S: doc.title },
  subCategories: { L: [{ S: "Healthcare" }] },
  lifeAreas: { L: [{ S: "Medical Costs" }] },
  sponsors: { L: [{ S: "R000606" }] },
  cosponsors: { L: doc.cosponsors.map((value) => ({ S: value })) },
  voteCount: { N: "0" },
  contentHash: { S: billContentHash(doc) },
  dateBasis: { S: basisOf(doc) },
  documentStoredAt: { S: documentStoredAt },
  billStatus: { S: "New" },
});

const lookup = (updatedAt: string): Item => ({
  pk: { S: "BILL_GUID" },
  sk: { S: guid },
  guid: { S: guid },
  manifestSk: { S: `${updatedAt}#${guid}` },
  updatedAt: { S: updatedAt },
});

/** The table as an object, for whole-table comparisons. */
const table = () => Object.fromEntries([...mockTable.entries()].sort(([a], [b]) => a.localeCompare(b)));
const tableWith = (row: Item, lookupRow: Item) => ({
  [`BILL_GUID|${guid}`]: lookupRow,
  [`BILL|${row.sk.S}`]: row,
});

const event = () =>
  asSqsEvent({
    Records: [{ messageId: "m1", body: JSON.stringify({ Records: [{ s3: { object: { key } } }] }) }],
  });

const rawReads = () => mockS3.commands("GetObject", rawKey);
const transactionCount = () => mockDdbCommands.filter((command) => command.__type === "TransactWriteItems").length;
const sentTo = (queueUrl: string) =>
  mockSqsSends
    .filter((send) => send.QueueUrl === queueUrl)
    .flatMap((send) => send.Entries.map((entry) => JSON.parse(entry.MessageBody).Records[0].s3));
const stats = (response: { body: string }) => JSON.parse(response.body).stats;

describe("createBillsManifest: a first publication of the REL-56 backfill is dated by congress.gov (D2)", () => {
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;
  const linesOf = (message: string) =>
    info.mock.calls.filter(([logged]) => logged === message).map(([, fields]) => fields);
  const firstLines = () => linesOf("Dated backfill first publication");
  const dateLines = () => linesOf("Dated manifest upsert");

  beforeEach(() => {
    mockS3 = new FakeVersionedS3("2026-11-20T15:00:00.000Z");
    mockTable = new Map();
    mockBeforeTransaction = null;
    mockDdbCommands.length = 0;
    mockSqsSends.length = 0;
    info = jest.spyOn(console, "info").mockImplementation(() => undefined);
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(Math, "random").mockReturnValue(0); // zero retry backoff
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("golden: a new bill in normal operation keeps its storedAt exactly, with no raw read", async () => {
    // congress.gov updated it minutes before the poller's fetch; the date stays the document's.
    const rawVersion = mockS3.put(rawKey, rawCopy({ updateDate: "2026-11-20T14:58:02Z" }, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(POLLER_ID, rawVersion));

    await handler(event());

    expect(table()).toEqual(tableWith(firstRow(mayBill, WINDOW_STORED_AT), lookup(WINDOW_STORED_AT)));
    expect(rawReads()).toEqual([]);
    expect(firstLines()).toEqual([]);
    expect(dateLines()).toEqual([]);
    expect(sentTo(process.env.QUEUE_URL!)).toEqual([{ bucket: { name: "test-bucket" }, object: { key } }]);
  });

  it("golden: a never-stored bill from May is dated by the update time of the raw version it was built from", async () => {
    const sourceVersion = mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    // A later fetch (the poller, minutes after) is the current copy; the document was not built from it.
    mockS3.put(rawKey, rawCopy({ updateDate: "2026-11-20T15:30:00Z" }, "2026-11-20T15:40:00.000Z"));
    mockS3.put(key, mayBill, written(BACKFILL_ID, sourceVersion));

    const response = await handler(event());

    expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 0, upsertsSkipped: 0 });
    // The row and the lookup take the May date; documentStoredAt stays the window's storedAt.
    expect(table()).toEqual(tableWith(firstRow(mayBill, MAY_DATE, WINDOW_STORED_AT), lookup(MAY_DATE)));
    expect(rawReads().map((call) => call.input.VersionId)).toEqual([sourceVersion]);
    expect(firstLines()).toEqual([
      {
        guid,
        datedBy: "congressUpdate",
        updatedAt: MAY_DATE,
        storedAt: WINDOW_STORED_AT,
        congressUpdatedAt: MAY_DATE,
        raw: "sourceVersion",
        correlationId: BACKFILL_ID,
      },
    ]);
    expect(dateLines()).toEqual([]);
    // Forwarding is unchanged: the quiet window (RUNBOOK 4.1) is what keeps the "new" push from going out.
    expect(sentTo(process.env.QUEUE_URL!)).toEqual([{ bucket: { name: "test-bucket" }, object: { key } }]);
    expect(sentTo(process.env.CONGRESS_MEMBER_STATS_QUEUE_URL!)).toHaveLength(1);
  });

  it("golden: a stale bill whose refetch brings real news still moves to the window's storedAt", async () => {
    const before: ProcessedDoc = {
      ...mayBill,
      storedAt: "2026-03-19T16:57:53.915Z",
      actions: [
        { actionCode: "H11100", actionDate: "2026-02-10", text: "Referred to the Committee on Energy and Commerce." },
      ],
    };
    mockTable.set(`BILL|${before.storedAt}#${guid}`, { ...firstRow(before, before.storedAt), voteCount: { N: "7" } });
    mockTable.set(`BILL_GUID|${guid}`, lookup(before.storedAt));
    mockS3.put(key, before, TEXT);
    const sourceVersion = mockS3.put(rawKey, rawCopy({ updateDate: "2026-07-16T10:00:00Z" }, BACKFILL_FETCHED_AT));
    const caughtUp: ProcessedDoc = {
      ...before,
      storedAt: WINDOW_STORED_AT,
      actions: [
        ...before.actions,
        { actionCode: "H30000", actionDate: "2026-07-15", text: "Subcommittee Hearings Held" },
      ],
    };
    mockS3.put(key, caughtUp, written(BACKFILL_ID, sourceVersion));

    await handler(event());

    expect(table()).toEqual(
      tableWith({ ...firstRow(caughtUp, WINDOW_STORED_AT), voteCount: { N: "7" } }, lookup(WINDOW_STORED_AT)),
    );
    expect(dateLines()).toEqual([
      expect.objectContaining({ decision: "moved", moves: ["newerAction"], decidedBy: "dateBasis" }),
    ]);
    expect(rawReads()).toEqual([]);
    expect(firstLines()).toEqual([]);
  });

  it("golden: a replay of the backfilled version keeps the row at its May date (a redelivery, backfill:bills-manifest)", async () => {
    const sourceVersion = mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(BACKFILL_ID, sourceVersion));
    await handler(event());
    const before = table();
    const writesBefore = transactionCount();
    info.mockClear();

    const response = await handler(event());

    expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
    expect(table()).toEqual(before);
    expect(dateLines()).toEqual([
      expect.objectContaining({
        decision: "kept",
        moves: [],
        decidedBy: "dateBasis",
        rowUpdatedAt: MAY_DATE,
        storedAt: WINDOW_STORED_AT,
      }),
    ]);
    // The replay finds a row, so it is no first publication: no second raw read, no first-publication line.
    expect(rawReads()).toHaveLength(1);
    expect(firstLines()).toEqual([]);
    expect(transactionCount()).toBe(writesBefore + 1);
  });

  it("golden: an S3 rollback's copy of the backfilled version is skipped once a newer version kept the row (RUNBOOK 5)", async () => {
    const sourceVersion = mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(BACKFILL_ID, sourceVersion));
    await handler(event());
    // The poller's next version brings cosponsors only: kept at the May date, the row reflecting the newer document.
    const later: ProcessedDoc = { ...mayBill, storedAt: "2026-12-01T09:00:00.000Z", cosponsors: cosponsors(25) };
    mockS3.put(key, later, written(`2026-12-01T08:59:40.000Z:${guid}`));
    await handler(event());
    expect(table()).toEqual(tableWith(firstRow(later, MAY_DATE, later.storedAt), lookup(MAY_DATE)));
    const before = table();
    const writesBefore = transactionCount();
    info.mockClear();

    // copy-object of the backfilled version: its storedAt and its metadata, the rel56 id included.
    mockS3.put(key, mayBill, written(BACKFILL_ID, sourceVersion));
    const response = await handler(event());

    expect(stats(response)).toMatchObject({ upsertsSkipped: 1, upsertsSucceeded: 0 });
    expect(table()).toEqual(before);
    expect(transactionCount()).toBe(writesBefore);
    expect(rawReads()).toHaveLength(1);
    expect(firstLines()).toEqual([]);
    expect(dateLines()).toEqual([]);
  });

  it("golden: only a full manifest load returns a backfilled bill dated before a window (RUNBOOK 4.9)", async () => {
    // What a device's copy of the manifest gets: a windowed load (the 7- to 28-day refresh merged into a full copy)
    // reads only sort keys after its start, so it never returns this row; a full load (the snapshot) does.
    const source = { ddb: new DynamoDBClient({}), tableName: "test-table", primaryKey: "pk", pkValue: "BILL" };
    const load = async (updatedAfter?: string) =>
      (await buildBillsManifest({ ...source, priorityDao: null }, { updatedAfter })).bills.map(
        (bill) => `${bill.guid} ${bill.updatedAt}`,
      );
    const window28 = new Date(Date.parse(WINDOW_STORED_AT) - 28 * 24 * 60 * 60 * 1000).toISOString();
    const sourceVersion = mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(BACKFILL_ID, sourceVersion));
    await handler(event());

    expect(await load()).toEqual([`${guid} ${MAY_DATE}`]);
    expect(await load(window28)).toEqual([]);

    // Dated by its storedAt, as without D2 (no rel56 id), the same bill comes with the windowed load.
    mockS3 = new FakeVersionedS3("2026-11-20T15:00:00.000Z");
    mockTable = new Map();
    const pollerRawVersion = mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(POLLER_ID, pollerRawVersion));
    await handler(event());

    expect(await load(window28)).toEqual([`${guid} ${WINDOW_STORED_AT}`]);
  });

  it("reads the current raw copy when the version the document was built from is gone", async () => {
    mockS3.put(rawKey, rawCopy({ updateDate: "2026-10-30T23:42:06Z" }, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(BACKFILL_ID, "expired-version-id"));

    await handler(event());

    expect(mockTable.get(`BILL_GUID|${guid}`)).toEqual(lookup("2026-10-30T23:42:06.000Z"));
    expect(rawReads().map((call) => call.input.VersionId)).toEqual(["expired-version-id", undefined]);
    expect(firstLines()).toEqual([
      expect.objectContaining({ datedBy: "congressUpdate", raw: "current", updatedAt: "2026-10-30T23:42:06.000Z" }),
    ]);
  });

  it.each([
    ["the raw copy is missing", () => undefined, null, null],
    [
      "the raw copy has no update time",
      () => mockS3.put(rawKey, rawCopy({}, BACKFILL_FETCHED_AT)),
      null,
      "sourceVersion",
    ],
    [
      "congress.gov's update time is after the storedAt",
      () => mockS3.put(rawKey, rawCopy({ updateDate: "2026-11-20T15:30:00Z" }, "2026-11-20T15:40:00.000Z")),
      "2026-11-20T15:30:00.000Z",
      "sourceVersion",
    ],
  ])("dates a backfilled first publication by its storedAt when %s", async (_case, putRaw, congressUpdatedAt, raw) => {
    mockS3.put(key, mayBill, written(BACKFILL_ID, putRaw()));

    await handler(event());

    expect(table()).toEqual(tableWith(firstRow(mayBill, WINDOW_STORED_AT), lookup(WINDOW_STORED_AT)));
    expect(firstLines()).toEqual([
      expect.objectContaining({ datedBy: "storedAt", updatedAt: WINDOW_STORED_AT, congressUpdatedAt, raw }),
    ]);
  });

  it("dates it by its storedAt, with a warning, when the raw read fails", async () => {
    const sourceVersion = mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(BACKFILL_ID, sourceVersion));
    mockS3.afterGet(rawKey, () => {
      throw Object.assign(new Error("Internal"), { name: "InternalError", $metadata: { httpStatusCode: 500 } });
    });
    // BillStorage logs the failed GET as an error before it throws.
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handler(event());

    expect(response.batchItemFailures).toEqual([]);
    expect(table()).toEqual(tableWith(firstRow(mayBill, WINDOW_STORED_AT), lookup(WINDOW_STORED_AT)));
    expect(warn.mock.calls.map(([message]) => message)).toContain(
      "Could not read the raw bill of a backfilled first publication; it is dated by its storedAt",
    );
    expect(error.mock.calls.map(([line]) => JSON.parse(line).message)).toEqual(["Failed to load bill from S3"]);
    expect(firstLines()).toEqual([
      expect.objectContaining({ datedBy: "storedAt", congressUpdatedAt: null, raw: null }),
    ]);
  });

  it.each([
    ["a REL-32 refetch", written(`refetch:2026-11-20T14:30:00.000Z:${guid}`)],
    ["no trace id", TEXT],
  ])("leaves a first publication from %s at its storedAt, with no raw read", async (_case, metadata) => {
    mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, metadata);

    await handler(event());

    expect(table()).toEqual(tableWith(firstRow(mayBill, WINDOW_STORED_AT), lookup(WINDOW_STORED_AT)));
    expect(rawReads()).toEqual([]);
    expect(firstLines()).toEqual([]);
  });

  it("reads the raw copy once when its first write is retried after a transaction conflict", async () => {
    const sourceVersion = mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(BACKFILL_ID, sourceVersion));
    mockBeforeTransaction = async () => {
      throw Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "TransactionConflict" }],
      });
    };

    const response = await handler(event());

    expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 0 });
    expect(table()).toEqual(tableWith(firstRow(mayBill, MAY_DATE, WINDOW_STORED_AT), lookup(MAY_DATE)));
    expect(transactionCount()).toBe(2);
    expect(rawReads()).toHaveLength(1);
    expect(firstLines()).toHaveLength(1);
  });

  it("reads the raw copy once when a concurrent first write cancels its own, then keeps that row", async () => {
    const sourceVersion = mockS3.put(rawKey, rawCopy(MAY_UPDATE, BACKFILL_FETCHED_AT));
    mockS3.put(key, mayBill, written(BACKFILL_ID, sourceVersion));
    // A redelivery of the same event commits between this invocation's reads and its commit.
    mockBeforeTransaction = async () => {
      await handler(event());
    };

    const response = await handler(event());

    expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
    expect(table()).toEqual(tableWith(firstRow(mayBill, MAY_DATE, WINDOW_STORED_AT), lookup(MAY_DATE)));
    // One read for each invocation: the cancelled one does not read again when it retries.
    expect(rawReads()).toHaveLength(2);
    expect(firstLines()).toHaveLength(1);
  });
});
