import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { SQSEvent, SQSMessageAttributes } from "aws-lambda";
import { dispatchShardPartitionValue } from "../shared/dispatchShards";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

const originalEnv = { ...process.env };

const mockS3Send = jest.fn();
const mockDynamoSend = jest.fn();
const mockSQSSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
  BatchGetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  ScanCommand: jest.fn().mockImplementation((input) => ({ input })),
  TransactWriteItemsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type Handler = (event: SQSEvent) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/notificationFanoutQueue";
const CORRELATION_ID = "2026-09-25T10:00:00.000Z:BILLS-119hr900is";

const baseEnv = {
  BUCKET_NAME: "test-bucket",
  PREFERENCE_TABLE: "UserPreferences",
  PREFERENCE_INDEX: "GSI_SubCategoryIndex",
  PENDING_NOTIFICATIONS_TABLE: "PendingBillNotifications",
  PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
  PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
  USER_ID_ATTRIBUTE: "userId",
  SUB_CATEGORY_ATTRIBUTE: "subCategory",
};

let restoreEnv: (() => void) | undefined;

const loadHandler = (overrides: Record<string, string | undefined>): Handler => {
  restoreEnv?.();
  restoreEnv = applyTestEnv({ ...baseEnv, ...overrides }, { replace: true, base: originalEnv });
  jest.resetModules();
  return require("../handlers/userMatcher").handler;
};

const processedDoc = (guid: string, title: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2026-09-01T00:00:00.000Z",
  identifier: { congress: "119", billType: "house-bill", billNumber: guid.replace(/^BILLS-119hr(\d+)is$/, "$1") },
  guid,
  title,
  link: "https://example.com/bill",
  soWhat: "",
  billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
  actions: [],
  committees: [],
  subCategories: [],
  lifeAreas: [],
  sponsors: [],
  cosponsors: [],
  ...extra,
});

const eventFor = (bodies: unknown[], correlationId?: string): SQSEvent => ({
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
    messageAttributes: (correlationId
      ? { correlationId: { dataType: "String", stringValue: correlationId } }
      : {}) as SQSMessageAttributes,
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:userMatcher",
    awsRegion: "us-east-1",
  })),
});

/** One entry of a TransactWriteItems call: every entry the matcher writes is a Put. */
interface TransactItem {
  Put: { Item: Record<string, AttributeValue>; ConditionExpression?: string };
}

/** The DynamoDB input fields the route and assertions read, across the commands the matcher sends. */
interface FakeDynamoInput {
  TableName?: string;
  Key?: { guid?: { S: string } };
  TransactItems?: TransactItem[];
  RequestItems?: { UserPreferences: { Keys: Array<Record<string, { S: string }>> } };
  ExpressionAttributeValues?: Record<string, { S: string }>;
}
interface FakeDynamoCommand {
  input?: FakeDynamoInput;
}

/** One entry of a SendMessageBatch call. */
interface SqsEntry {
  Id: string;
  MessageBody: string;
  MessageAttributes?: unknown;
}
interface FakeSqsCommand {
  input: { Entries: SqsEntry[] };
}

const users = (count: number, prefix = "user") => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

// Routes S3 and DynamoDB calls by input. `subscribers` maps a preference value (bill guid, category,
// life area) to its users; every candidate passes the type filter with `preferenceType`.
const routeCalls = (options: {
  docs: Array<ReturnType<typeof processedDoc>>;
  subscribers: Record<string, string[]>;
  preferenceType?: string;
  priorityGuid?: string;
  activeUsers?: string[];
  onTransact?: (input: FakeDynamoInput) => Promise<void> | void;
}) => {
  mockS3Send.mockImplementation(async (cmd: { input: { Key?: string } }) => {
    const key: string = cmd.input.Key ?? "";
    const doc = options.docs.find((d) => key === `processed-bills/${d.guid.replace(/is$/, "")}.json`);
    if (!doc) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    return { Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(doc)) } };
  });

  mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
    const input = cmd.input ?? {};
    if (input.TransactItems) {
      await options.onTransact?.(input);
      return {};
    }
    if (input.TableName === "BillPriority") {
      return input.Key?.guid?.S === options.priorityGuid
        ? {
            Item: {
              guid: { S: options.priorityGuid },
              status: { S: "ACTIVE" },
              isPriority: { BOOL: true },
              priorityRank: { N: "1" },
              priorityReason: { S: "Shutdown coverage" },
              priorityExpiresAt: { S: "2099-03-08T00:00:00.000Z" },
              priorityUpdatedAt: { S: "2026-03-07T12:00:00.000Z" },
            },
          }
        : {};
    }
    if (input.TableName === "UserPII") {
      return { Items: (options.activeUsers ?? []).map((userId) => ({ userId: { S: userId } })) };
    }
    if (input.RequestItems) {
      const keys = input.RequestItems.UserPreferences.Keys;
      const type = options.preferenceType ?? "Bill";
      return { Responses: { UserPreferences: keys.map((k) => ({ ...k, type: { S: type } })) } };
    }
    const sub = input.ExpressionAttributeValues?.[":sub"]?.S;
    if (sub) {
      return { Items: (options.subscribers[sub] ?? []).map((userId) => ({ userId: { S: userId } })) };
    }
    // A user's own preference rows (content-type filter): none set.
    return { Items: [] };
  });
};

const acceptAllSqs = () =>
  mockSQSSend.mockImplementation(async (cmd: FakeSqsCommand) => ({
    Successful: cmd.input.Entries.map((entry) => ({ Id: entry.Id })),
    Failed: [],
  }));

const sqsEntries = (): SqsEntry[] => mockSQSSend.mock.calls.flatMap((call: [FakeSqsCommand]) => call[0].input.Entries);
const sentMessages = () => sqsEntries().map((entry) => JSON.parse(entry.MessageBody));
const dynamoInputs = (): FakeDynamoInput[] =>
  mockDynamoSend.mock.calls.map((call: [FakeDynamoCommand]) => call[0].input!);
const transactInputs = () =>
  dynamoInputs().filter((input): input is FakeDynamoInput & { TransactItems: TransactItem[] } =>
    Array.isArray(input?.TransactItems),
  );
const userPreferenceQueries = () => dynamoInputs().filter((input) => input?.ExpressionAttributeValues?.[":uid"]);

beforeEach(() => {
  mockS3Send.mockReset();
  mockDynamoSend.mockReset();
  mockSQSSend.mockReset();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("userMatcher fan-out to notificationFanout (CAP-02)", () => {
  it("sends the matched users in chunks of 100 with everything the write needs", async () => {
    const handler = loadHandler({ NOTIFICATION_FANOUT_QUEUE_URL: QUEUE_URL });
    const guid = "BILLS-119hr900is";
    routeCalls({ docs: [processedDoc(guid, "Fan-out Bill")], subscribers: { [guid]: users(250) } });
    acceptAllSqs();

    const result = await handler(
      eventFor([{ domain: "bill", objectId: guid, notificationType: "alert", sourceRevision: "v1" }], CORRELATION_ID),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    // No per-user work in the matcher: no content-type reads and no writes.
    expect(transactInputs()).toHaveLength(0);
    expect(userPreferenceQueries()).toHaveLength(0);

    expect(mockSQSSend).toHaveBeenCalledTimes(1);
    expect(mockSQSSend.mock.calls[0][0].input.QueueUrl).toBe(QUEUE_URL);
    const messages = sentMessages();
    expect(messages.map((m) => m.userIds.length)).toEqual([100, 100, 50]);
    expect(messages.flatMap((m) => m.userIds)).toEqual(users(250));
    expect(messages[0]).toEqual({
      version: 1,
      billId: guid,
      billTitle: "Fan-out Bill",
      category: "Bill Alert",
      lifeArea: "",
      notificationType: "alert",
      sourceRevision: "v1",
      correlationId: CORRELATION_ID,
      isPriorityBill: false,
      rawBillType: "house-bill",
      // UX-33: the bill's voters and watchers are never filtered by the bill types they chose.
      skipBillTypeFilter: true,
      userIds: users(250).slice(0, 100),
    });
    for (const entry of sqsEntries()) {
      expect(entry.MessageAttributes).toEqual({ correlationId: { DataType: "String", StringValue: CORRELATION_ID } });
    }
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Enqueued notification fan-out",
        guid,
        correlationId: CORRELATION_ID,
        userCount: 250,
        messageCount: 3,
      }),
    );
  });

  it("honours NOTIFICATION_FANOUT_USERS_PER_MESSAGE and sends at most ten messages per call", async () => {
    const handler = loadHandler({
      NOTIFICATION_FANOUT_QUEUE_URL: QUEUE_URL,
      NOTIFICATION_FANOUT_USERS_PER_MESSAGE: "10",
    });
    const guid = "BILLS-119hr901is";
    routeCalls({ docs: [processedDoc(guid, "Many Chunks")], subscribers: { [guid]: users(150) } });
    acceptAllSqs();

    await handler(eventFor([{ domain: "bill", objectId: guid, notificationType: "updated" }]));

    expect(mockSQSSend.mock.calls.map((call) => call[0].input.Entries.length)).toEqual([10, 5]);
    expect(new Set(sqsEntries().map((entry) => entry.Id)).size).toBe(15);
    expect(sentMessages().every((m) => m.userIds.length === 10)).toBe(true);
  });

  it("retries entries SQS reports as failed and succeeds", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const handler = loadHandler({ NOTIFICATION_FANOUT_QUEUE_URL: QUEUE_URL });
    const guid = "BILLS-119hr902is";
    routeCalls({ docs: [processedDoc(guid, "Retry Bill")], subscribers: { [guid]: users(250) } });
    mockSQSSend
      .mockResolvedValueOnce({
        Successful: [{ Id: "fanout-0" }, { Id: "fanout-2" }],
        Failed: [{ Id: "fanout-1", Code: "InternalError", SenderFault: false }],
      })
      .mockResolvedValueOnce({ Successful: [{ Id: "fanout-1" }], Failed: [] });

    const result = await handler(eventFor([{ domain: "bill", objectId: guid, notificationType: "alert" }]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSQSSend).toHaveBeenCalledTimes(2);
    const retried: SqsEntry[] = mockSQSSend.mock.calls[1][0].input.Entries;
    expect(retried.map((entry) => entry.Id)).toEqual(["fanout-1"]);
    expect(JSON.parse(retried[0].MessageBody).userIds).toEqual(users(250).slice(100, 200));
  });

  it("reports only the record whose chunks still fail after the retries", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    const handler = loadHandler({ NOTIFICATION_FANOUT_QUEUE_URL: QUEUE_URL });
    const failing = "BILLS-119hr903is";
    const healthy = "BILLS-119hr904is";
    routeCalls({
      docs: [processedDoc(failing, "Failing Bill"), processedDoc(healthy, "Healthy Bill")],
      subscribers: { [failing]: users(120, "f"), [healthy]: users(3, "h") },
    });
    mockSQSSend.mockImplementation(async (cmd: FakeSqsCommand) => {
      const entries = cmd.input.Entries;
      const failed = entries.filter((entry) => JSON.parse(entry.MessageBody).billId === failing).slice(-1);
      return {
        Successful: entries.filter((entry) => !failed.includes(entry)).map((entry) => ({ Id: entry.Id })),
        Failed: failed.map((entry) => ({ Id: entry.Id, Code: "InternalError", SenderFault: false })),
      };
    });

    const result = await handler(
      eventFor([
        { domain: "bill", objectId: failing, notificationType: "alert" },
        { domain: "bill", objectId: healthy, notificationType: "alert" },
      ]),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-0" }] });
    // Four attempts for the failing record's second chunk, then the healthy record's one call.
    expect(mockSQSSend).toHaveBeenCalledTimes(5);
    expect(sentMessages().filter((m) => m.billId === healthy)).toHaveLength(1);
    expect(logLines(console.error)).toContainEqual(
      expect.objectContaining({ message: "Failed to process notificationType message", messageId: "msg-0" }),
    );
  });

  it("marks a priority bill so notificationFanout skips the content filter", async () => {
    const handler = loadHandler({
      NOTIFICATION_FANOUT_QUEUE_URL: QUEUE_URL,
      PRIORITY_TABLE_NAME: "BillPriority",
      PRIORITY_TABLE_PARTITION_KEY: "guid",
      PII_TABLE_NAME: "UserPII",
      PII_PARTITION_KEY: "userId",
    });
    const guid = "BILLS-119hr905is";
    routeCalls({
      docs: [processedDoc(guid, "Priority Bill", { identifier: { billType: "hjres" } })],
      subscribers: {},
      priorityGuid: guid,
      activeUsers: users(130),
    });
    acceptAllSqs();

    await handler(eventFor([{ domain: "bill", objectId: guid, notificationType: "new" }]));

    const messages = sentMessages();
    expect(messages.map((m) => m.userIds.length)).toEqual([100, 30]);
    expect(messages[0]).toMatchObject({
      billId: guid,
      category: "Priority Bill",
      lifeArea: "",
      notificationType: "new",
      isPriorityBill: true,
      rawBillType: "hjres",
    });
  });

  it("carries the criteria path's primary category and life area", async () => {
    const handler = loadHandler({ NOTIFICATION_FANOUT_QUEUE_URL: QUEUE_URL });
    const guid = "BILLS-119hr906is";
    routeCalls({
      docs: [processedDoc(guid, "Criteria Bill", { subCategories: ["Healthcare"], lifeAreas: ["Taxes"] })],
      subscribers: { Healthcare: ["user-1", "user-2"], Taxes: ["user-2", "user-3"] },
      preferenceType: "Category",
    });
    // Life-area lookups filter on "Life Area"; accept both types.
    const routed = mockDynamoSend.getMockImplementation()!;
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      if (cmd.input?.RequestItems) {
        const keys = cmd.input.RequestItems.UserPreferences.Keys;
        const type = keys[0].subCategory.S === "Taxes" ? "Life Area" : "Category";
        return { Responses: { UserPreferences: keys.map((k) => ({ ...k, type: { S: type } })) } };
      }
      return routed(cmd);
    });
    acceptAllSqs();

    await handler(eventFor([{ domain: "bill", objectId: guid, notificationType: "passed", sourceRevision: "v7" }]));

    const [message] = sentMessages();
    expect(message).toMatchObject({
      billId: guid,
      billTitle: "Criteria Bill",
      category: "Social Policy",
      lifeArea: "Taxes",
      notificationType: "passed",
      sourceRevision: "v7",
      isPriorityBill: false,
      rawBillType: "house-bill",
    });
    expect([...message.userIds].sort()).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("does not enqueue the same users twice for duplicate records in one batch", async () => {
    const handler = loadHandler({ NOTIFICATION_FANOUT_QUEUE_URL: QUEUE_URL });
    const guid = "BILLS-119hr907is";
    routeCalls({ docs: [processedDoc(guid, "Duplicate Bill")], subscribers: { [guid]: users(5) } });
    acceptAllSqs();

    const body = { domain: "bill", objectId: guid, notificationType: "updated", sourceRevision: "v1" };
    const result = await handler(eventFor([body, body]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].userIds).toEqual(users(5));
  });
});

describe("userMatcher inline fallback (no NOTIFICATION_FANOUT_QUEUE_URL)", () => {
  it("writes inline with bounded concurrency, sharded dispatch markers and no SQS", async () => {
    const handler = loadHandler({ NOTIFICATION_FANOUT_QUEUE_URL: undefined });
    const guid = "BILLS-119hr910is";
    let inFlight = 0;
    let maxInFlight = 0;
    routeCalls({
      docs: [processedDoc(guid, "Inline Bill")],
      subscribers: { [guid]: users(30) },
      onTransact: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
      },
    });

    const result = await handler(
      eventFor([{ domain: "bill", objectId: guid, notificationType: "alert", sourceRevision: "v2" }], CORRELATION_ID),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSQSSend).not.toHaveBeenCalled();
    expect(transactInputs()).toHaveLength(30);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);

    const byUser = new Map(transactInputs().map((input) => [input.TransactItems[1].Put.Item.userId.S, input]));
    const [dedupe, pending, dispatchMarker] = byUser.get("user-7")!.TransactItems.map((item) => item.Put);
    expect(dedupe.Item.billId).toEqual({ S: `user-7||${guid}||alert||v2` });
    expect(dedupe.ConditionExpression).toBe("attribute_not_exists(#pk) AND attribute_not_exists(#sk)");
    expect(pending.Item).toMatchObject({
      userId: { S: "user-7" },
      billId: { S: `${guid}#alert` },
      category: { S: "Bill Alert" },
      correlationId: { S: CORRELATION_ID },
    });
    expect(dispatchMarker.Item).toMatchObject({
      userId: { S: dispatchShardPartitionValue("__dispatch__", "user-7", 8) },
      billId: { S: "user-7" },
      markerType: { S: "pending-user" },
      targetUserId: { S: "user-7" },
    });
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Wrote pending notifications inline", userCount: 30, written: 30 }),
    );
  });

  it("uses NOTIFICATION_WRITE_CONCURRENCY and DISPATCH_SHARD_COUNT", async () => {
    const handler = loadHandler({ NOTIFICATION_WRITE_CONCURRENCY: "2", DISPATCH_SHARD_COUNT: "16" });
    const guid = "BILLS-119hr911is";
    let inFlight = 0;
    let maxInFlight = 0;
    routeCalls({
      docs: [processedDoc(guid, "Tuned Bill")],
      subscribers: { [guid]: users(10) },
      onTransact: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
      },
    });

    await handler(eventFor([{ domain: "bill", objectId: guid, notificationType: "alert" }]));

    expect(maxInFlight).toBe(2);
    for (const input of transactInputs()) {
      const userId = input.TransactItems[1].Put.Item.userId.S!;
      expect(input.TransactItems[2].Put.Item.userId.S).toBe(dispatchShardPartitionValue("__dispatch__", userId, 16));
    }
  });
});
