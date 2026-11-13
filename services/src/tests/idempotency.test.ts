/**
 * Idempotency tests — verify that replayed or duplicate events do not corrupt
 * state or produce duplicate side-effects.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { SQSEvent } from "aws-lambda";
import { billContentHash } from "../shared/billVersionChange";
import { applyTestEnv } from "./fixtures/env";

// ─── Mock setup (must precede dynamic requires) ──────────────────────────────

const mockDynamoSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "GetObjectCommand", input })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ __type: "ListObjectsV2Command", input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "PutObjectCommand", input })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "HeadObjectCommand", input })),
  ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ __type: "ListObjectVersionsCommand", input })),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  ScanCommand: jest.fn().mockImplementation((input) => ({ __type: "ScanCommand", input })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ __type: "QueryCommand", input })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "GetItemCommand", input })),
  PutItemCommand: jest.fn().mockImplementation((input) => ({ __type: "PutItemCommand", input })),
  DeleteItemCommand: jest.fn().mockImplementation((input) => ({ __type: "DeleteItemCommand", input })),
  TransactWriteItemsCommand: jest.fn().mockImplementation((input) => ({ __type: "TransactWriteItemsCommand", input })),
  BatchGetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "BatchGetItemCommand", input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Successful: [], Failed: [] }) })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

type Item = Record<string, AttributeValue>;

/** The mocked DynamoDB command constructors return their input tagged with __type; the fields the fakes read. */
interface DynamoCommand {
  __type: string;
  input: {
    Key?: Item;
    TransactItems?: Array<{ Put?: { Item: Item }; Delete?: { Key: Item } }>;
  };
}

const makeSqsEvent = (bodies: unknown[]): SQSEvent => ({
  Records: bodies.map((body, idx) => ({
    messageId: `msg-${idx}`,
    receiptHandle: `receipt-${idx}`,
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: `${Date.now()}`,
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: `${Date.now()}`,
    },
    messageAttributes: {},
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:test",
    awsRegion: "us-east-1",
  })),
});

const makeS3SqsEvent = (keys: string[]): unknown => ({
  Records: keys.map((key) => ({
    body: JSON.stringify({
      Records: [
        {
          eventName: "ObjectCreated:Put",
          s3: { bucket: { name: "test-bucket" }, object: { key } },
        },
      ],
    }),
  })),
});

/** Creates a fresh Readable stream for each call — avoids already-consumed stream issues. */
const makeReadableBodyFn = (obj: unknown) => () => {
  const str = JSON.stringify(obj);
  const { Readable } = require("stream");
  const readable = new Readable();
  readable.push(str);
  readable.push(null);
  return readable;
};

// ─── userMatcher: duplicate notification suppression ─────────────────────────

describe("userMatcher — duplicate notification suppression", () => {
  let handler: (event: SQSEvent) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
  let restoreEnv: () => void;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    mockDynamoSend.mockReset();
    mockS3Send.mockReset();

    restoreEnv = applyTestEnv({
      PENDING_NOTIFICATIONS_TABLE: "pending-table",
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "pk",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "sk",
      BUCKET_NAME: "test-bucket",
      PREFERENCE_TABLE: "prefs-table",
      PREFERENCE_INDEX: "subcategory-index",
      USER_ID_ATTRIBUTE: "userId",
      SUB_CATEGORY_ATTRIBUTE: "subcategory",
    });

    const module = require("../handlers/userMatcher/index");
    handler = module.handler;
  });

  afterEach(() => {
    restoreEnv?.();
    logSpy.mockRestore();
  });

  it("returns empty batchItemFailures when ConditionalCheckFailed blocks a duplicate notification", async () => {
    // TransactWrite throws ConditionalCheckFailed → writePendingNotification returns false → no failure
    mockDynamoSend.mockImplementation((cmd: DynamoCommand) => {
      if (cmd.__type === "ScanCommand") return Promise.resolve({ Items: [] });
      if (cmd.__type === "QueryCommand") {
        return Promise.resolve({ Items: [{ userId: { S: "user1" } }] });
      }
      if (cmd.__type === "BatchGetItemCommand") {
        return Promise.resolve({ Responses: {} });
      }
      if (cmd.__type === "TransactWriteItemsCommand") {
        const err = new Error(
          "Transaction cancelled, please refer to cancellation reasons for specific reasons [ConditionalCheckFailed]",
        );
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const processedBillBody = makeReadableBodyFn({
      schemaVersion: 1,
      kind: "processed",
      guid: "BILLS-118hr1234",
      title: "Test Bill",
      subCategories: ["TaxationAndRevenue"],
      identifier: { billType: "hr", congress: "118", billNumber: "1234" },
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    });

    // Fresh stream per call
    mockS3Send.mockImplementation(() => Promise.resolve({ Body: processedBillBody() }));

    const event = makeSqsEvent([{ domain: "bill", objectId: "BILLS-118hr1234", notificationType: "new" }]);

    const result = await handler(event);
    // ConditionalCheckFailed means duplicate: handler succeeds, not a failure
    expect(result.batchItemFailures).toEqual([]);
  });

  it("does not fail when a bill has no matching user preferences", async () => {
    // No users returned for any subcategory → handler skips gracefully
    mockDynamoSend.mockImplementation((cmd: DynamoCommand) => {
      if (cmd.__type === "ScanCommand") return Promise.resolve({ Items: [] });
      if (cmd.__type === "QueryCommand") return Promise.resolve({ Items: [] });
      if (cmd.__type === "BatchGetItemCommand") return Promise.resolve({ Responses: {} });
      return Promise.resolve({});
    });

    const billBody = makeReadableBodyFn({
      schemaVersion: 1,
      kind: "processed",
      guid: "BILLS-118hr0001",
      title: "Unmatched Bill",
      subCategories: ["TaxationAndRevenue"],
      identifier: { billType: "hr", congress: "118", billNumber: "0001" },
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    });

    mockS3Send.mockImplementation(() => Promise.resolve({ Body: billBody() }));

    const event = makeSqsEvent([{ domain: "bill", objectId: "BILLS-118hr0001", notificationType: "new" }]);

    const result = await handler(event);
    expect(result.batchItemFailures).toEqual([]);
    // No pending notification should have been attempted
    const transactCalls = mockDynamoSend.mock.calls.filter(
      (c: [DynamoCommand]) => c[0]?.__type === "TransactWriteItemsCommand",
    );
    expect(transactCalls).toHaveLength(0);
  });
});

// ─── createBillsManifest: stale S3 event skip ────────────────────────────────

describe("createBillsManifest — stale event skip (idempotency)", () => {
  let handler: (event: unknown) => Promise<{ statusCode: number; body: string }>;
  let restoreEnv: () => void;

  beforeEach(() => {
    jest.resetModules();
    mockDynamoSend.mockReset();
    mockS3Send.mockReset();

    restoreEnv = applyTestEnv({
      BUCKET_NAME: "test-bucket",
      TABLE_NAME: "test-table",
      PRIMARY_KEY: "pk",
      SORT_KEY: "sk",
      PK_VALUE: "BILL",
      QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/test-queue",
    });

    const module = require("../handlers/createBillsManifest/index");
    handler = module.handler;
  });

  afterEach(() => {
    restoreEnv?.();
  });

  it("skips the DynamoDB upsert when the existing entry is strictly newer", async () => {
    const guid = "BILLS-118hr9999";
    const olderTimestamp = "2024-01-01T00:00:00.000Z";
    // Existing DB sort key uses a timestamp in 2024-12-31 — newer than incoming
    const newerSk = `2024-12-31T00:00:00.000Z#${guid}`;

    const billBody = makeReadableBodyFn({
      kind: "processed",
      guid,
      title: "Old Version Bill",
      storedAt: olderTimestamp,
      identifier: { billType: "hr", congress: "118", billNumber: "9999" },
      subCategories: [],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    });

    mockS3Send.mockImplementation(() => Promise.resolve({ Body: billBody() }));

    mockDynamoSend.mockImplementation((cmd: DynamoCommand) => {
      if (cmd.__type === "GetItemCommand") {
        // Lookup row → points at a NEWER sort key
        return Promise.resolve({ Item: { manifestSk: { S: newerSk } } });
      }
      if (cmd.__type === "PutItemCommand") return Promise.resolve({});
      if (cmd.__type === "DeleteItemCommand") return Promise.resolve({});
      return Promise.resolve({});
    });

    const event = makeS3SqsEvent([`processed-bills/${guid}.json`]);
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    // upsertsSkipped should be 1
    expect(body.stats?.upsertsSkipped).toBe(1);
    expect(body.stats?.upsertsSucceeded).toBe(0);

    // No BILL-partition PutItemCommand should have been issued
    const manifestPuts = mockDynamoSend.mock.calls.filter((call: [DynamoCommand & { input: { Item?: Item } }]) => {
      const input = call[0]?.input;
      return call[0]?.__type === "PutItemCommand" && input?.Item?.pk?.S === "BILL";
    });
    expect(manifestPuts).toHaveLength(0);
  });

  it("processes the same event twice and the second run is skipped once the first succeeds", async () => {
    const guid = "BILLS-118hr8888";
    const timestamp = "2024-06-15T12:00:00.000Z";
    // After first run the lookup row will have exactly the same sort key we'd compute
    const expectedSk = `${timestamp}#${guid}`;

    const billBody = makeReadableBodyFn({
      kind: "processed",
      guid,
      title: "Stable Bill",
      storedAt: timestamp,
      identifier: { billType: "hr", congress: "118", billNumber: "8888" },
      subCategories: [],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    });

    mockS3Send.mockImplementation(() => Promise.resolve({ Body: billBody() }));

    // First invocation: no existing row → upsert proceeds
    mockDynamoSend.mockImplementation((cmd: DynamoCommand) => {
      if (cmd.__type === "GetItemCommand") return Promise.resolve({ Item: undefined });
      if (cmd.__type === "PutItemCommand") return Promise.resolve({});
      if (cmd.__type === "DeleteItemCommand") return Promise.resolve({});
      return Promise.resolve({});
    });

    const event = makeS3SqsEvent([`processed-bills/${guid}.json`]);
    const firstResult = await handler(event);
    expect(JSON.parse(firstResult.body).stats?.upsertsSucceeded).toBe(1);

    // Second invocation: existing row has the SAME sort key (not strictly greater)
    // → equal means: still allowed to update (not skipped)
    mockDynamoSend.mockReset();
    mockDynamoSend.mockImplementation((cmd: DynamoCommand) => {
      if (cmd.__type === "GetItemCommand") return Promise.resolve({ Item: { manifestSk: { S: expectedSk } } });
      if (cmd.__type === "GetItemCommand") return Promise.resolve({ Item: { voteCount: { N: "0" } } });
      if (cmd.__type === "PutItemCommand") return Promise.resolve({});
      if (cmd.__type === "DeleteItemCommand") return Promise.resolve({});
      return Promise.resolve({});
    });

    mockS3Send.mockReset();
    mockS3Send.mockImplementation(() => Promise.resolve({ Body: billBody() }));

    const secondResult = await handler(event);
    const secondBody = JSON.parse(secondResult.body);
    // Equal SK → not skipped (allows billStatus / field updates from deterministic backfills)
    expect(secondBody.stats?.upsertsSkipped).toBe(0);
  });

  it("keeps a row at its date for a bookkeeping-only version, again on a replay, with no Delete (RUNBOOK 4.9)", async () => {
    const guid = "BILLS-118hr7777";
    const earlier = {
      kind: "processed",
      guid,
      title: "Stable Bill",
      storedAt: "2024-03-01T00:00:00.000Z",
      identifier: { billType: "hr", congress: "118", billNumber: "7777" },
      subCategories: [],
      lifeAreas: [],
      sponsors: ["S000001"],
      cosponsors: ["C000001"],
    };
    // Only the cosponsor list and storedAt changed.
    const refilled = { ...earlier, storedAt: "2024-06-15T12:00:00.000Z", cosponsors: ["C000001", "C000002"] };
    const rowSk = `${earlier.storedAt}#${guid}`;
    const items = new Map<string, Item>([
      [
        `BILL|${rowSk}`,
        {
          pk: { S: "BILL" },
          sk: { S: rowSk },
          guid: { S: guid },
          updatedAt: { S: earlier.storedAt },
          voteCount: { N: "5" },
          contentHash: { S: billContentHash(earlier) },
        },
      ],
      [`BILL_GUID|${guid}`, { pk: { S: "BILL_GUID" }, sk: { S: guid }, manifestSk: { S: rowSk } }],
    ]);
    const transactions: Array<NonNullable<DynamoCommand["input"]["TransactItems"]>> = [];
    mockS3Send.mockImplementation(() => Promise.resolve({ Body: makeReadableBodyFn(refilled)() }));
    mockDynamoSend.mockImplementation((cmd: DynamoCommand) => {
      if (cmd.__type === "GetItemCommand") {
        return Promise.resolve({ Item: items.get(`${cmd.input.Key!.pk.S}|${cmd.input.Key!.sk.S}`) });
      }
      if (cmd.__type === "TransactWriteItemsCommand") {
        transactions.push(cmd.input.TransactItems!);
        for (const item of cmd.input.TransactItems!) {
          if (item.Put) items.set(`${item.Put.Item.pk.S}|${item.Put.Item.sk.S}`, item.Put.Item);
          if (item.Delete) items.delete(`${item.Delete.Key.pk.S}|${item.Delete.Key.sk.S}`);
        }
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`Unexpected DynamoDB command ${cmd.__type}`));
    });
    const info = jest.spyOn(console, "info").mockImplementation(() => undefined);

    const event = makeS3SqsEvent([`processed-bills/${guid}.json`]);
    const first = JSON.parse((await handler(event)).body);
    const second = JSON.parse((await handler(event)).body);

    expect(first.stats).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
    expect(second.stats).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
    expect(transactions).toHaveLength(2);
    expect(transactions.flat().filter((item) => item.Delete)).toEqual([]);
    expect([...items.keys()].sort()).toEqual([`BILL_GUID|${guid}`, `BILL|${rowSk}`]);
    expect(items.get(`BILL|${rowSk}`)).toMatchObject({
      updatedAt: { S: earlier.storedAt },
      voteCount: { N: "5" },
      cosponsors: { L: [{ S: "C000001" }, { S: "C000002" }] },
      contentHash: { S: billContentHash(refilled) },
    });
    info.mockRestore();
  });
});
