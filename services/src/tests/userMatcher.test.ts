import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { SQSEvent } from "aws-lambda";
import { applyTestEnv } from "./fixtures/env";
import { logLines, type LogLine } from "./logLines";

const originalEnv = { ...process.env };

const mockS3Send = jest.fn();
const mockDynamoSend = jest.fn();
const mockSQSSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
  BatchGetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  ScanCommand: jest.fn().mockImplementation((input) => ({ input })),
  TransactWriteItemsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

/** A pending-notification or marker row, as DynamoDB holds it. */
type PendingItem = Record<string, AttributeValue>;

/** One Put of a TransactWriteItems call. */
interface TransactPut {
  Item: PendingItem;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
}

/** The DynamoDB input fields the routes and assertions read, across the commands the matcher sends. */
interface FakeDynamoInput {
  TableName?: string;
  IndexName?: string;
  KeyConditionExpression?: string;
  ProjectionExpression?: string;
  Key?: Record<string, AttributeValue>;
  Item?: PendingItem;
  TransactItems?: Array<{ Put: TransactPut }>;
  RequestItems?: Record<string, { Keys: Array<Record<string, { S: string }>> }>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}
interface FakeDynamoCommand {
  input?: FakeDynamoInput;
}

type Handler = (event: SQSEvent) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
let handler: Handler;
let restoreEnv: (() => void) | undefined;

const buildEventFromBodies = (bodies: unknown[]): SQSEvent => ({
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
    eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:userMatcher",
    awsRegion: "us-east-1",
  })),
});

const pendingNotificationWriteInputs = () =>
  mockDynamoSend.mock.calls
    .map((call: [FakeDynamoCommand]) => call[0].input)
    .flatMap((input) =>
      Array.isArray(input?.TransactItems)
        ? input.TransactItems.map((item) => item?.Put?.Item).filter((item) => item?.billTitle?.S)
        : [],
    );

beforeEach(() => {
  jest.resetModules();
  mockS3Send.mockReset();
  mockDynamoSend.mockReset();
  mockSQSSend.mockReset();
  mockDynamoSend.mockResolvedValue({ Items: [] });

  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      BUCKET_NAME: "test-bucket",
      PREFERENCE_TABLE: "UserPreferences",
      PREFERENCE_INDEX: "GSI_SubCategoryIndex",
      PENDING_NOTIFICATIONS_TABLE: "PendingBillNotifications",
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
      USER_ID_ATTRIBUTE: "userId",
      SUB_CATEGORY_ATTRIBUTE: "subCategory",
    },
    { replace: true, base: originalEnv },
  );

  const mod = require("../handlers/userMatcher");
  handler = mod.handler;
});

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("userMatcher handler", () => {
  it("for Bill Alert notifications, only notifies users subscribed to the bill", async () => {
    const guid = "BILLS-119hr900is";
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-01-04T00:00:00.000Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "900" },
      guid,
      title: "Alert Bill",
      link: "https://example.com/bill",
      soWhat: "",
      billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
      bodyText: "",
      billXml: "",
      actions: [],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: ["Taxes"],
      sponsors: ["S001235"],
      cosponsors: [],
    };

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });

    // Bill-specific preference lookup (GSI query)
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ userId: { S: "user-1" } }, { userId: { S: "user-2" } }] });
    // Bill-specific preference lookup (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [
          { userId: { S: "user-1" }, preference: { S: guid }, type: { S: "Bill" } },
          { userId: { S: "user-2" }, preference: { S: guid }, type: { S: "Bill" } },
        ],
      },
    });

    const event: SQSEvent = {
      Records: [
        {
          messageId: "msg-0",
          receiptHandle: "receipt-0",
          body: JSON.stringify({
            domain: "bill",
            objectId: guid,
            notificationType: "alert",
            alert: {
              text: "Placed on the Union Calendar, Calendar No. 366.",
              actionDate: "2025-12-30",
              actionCode: "H12410",
              actionType: "Calendars",
            },
          }),
          attributes: {
            ApproximateReceiveCount: "1",
            SentTimestamp: `${Date.now()}`,
            SenderId: "sender",
            ApproximateFirstReceiveTimestamp: `${Date.now()}`,
          },
          messageAttributes: {},
          md5OfBody: "md5",
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:userMatcher",
          awsRegion: "us-east-1",
        },
      ],
    };

    await handler(event);

    const firstQuery = mockDynamoSend.mock.calls[0][0].input;
    expect(firstQuery.ExpressionAttributeValues).toEqual({ ":sub": { S: guid } });

    const [putItem1, putItem2] = pendingNotificationWriteInputs();

    expect(putItem1.userId.S).toBe("user-1");
    expect(putItem1.sourceBillId.S).toBe(guid);
    expect(putItem1.billTitle.S).toBe("Alert Bill");
    expect(putItem1.notificationType.S).toBe("alert");
    expect(putItem1.billId.S).toBe(`${guid}#alert`);

    expect(putItem2.userId.S).toBe("user-2");
    expect(putItem2.sourceBillId.S).toBe(guid);
  });

  it("for Bill Alert notifications, also notifies users who only watch the bill when others voted on it (REL-42)", async () => {
    const guid = "BILLS-119hr2606";
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-01-04T00:00:00.000Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "2606" },
      guid,
      title: "Watched Bill",
      link: "https://example.com/bill",
      soWhat: "",
      billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
      actions: [],
      committees: [],
      subCategories: [],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    };
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });
    // GSI query, then the BatchGet that reads each row's type: user-1 voted (Bill), user-2 only watches (Watch).
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ userId: { S: "user-1" } }, { userId: { S: "user-2" } }] });
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [
          { userId: { S: "user-1" }, preference: { S: guid }, type: { S: "Bill" } },
          { userId: { S: "user-2" }, preference: { S: guid }, type: { S: "Watch" } },
        ],
      },
    });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "updated" }]));

    expect(pendingNotificationWriteInputs().map((item) => item.userId.S)).toEqual(["user-1", "user-2"]);
  });

  // UX-33 (project decision 2026-10-29): a bill's own voters and watchers are never filtered by the bill types they chose.
  it("sends a bill alert to its voter even when their content type filter excludes the bill", async () => {
    const guid = "BILLS-119hr901is";
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-01-05T00:00:00.000Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "901" },
      guid,
      title: "Filtered Alert Bill",
      link: "https://example.com/bill",
      soWhat: "",
      billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
      bodyText: "",
      billXml: "",
      actions: [],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    };

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });

    mockDynamoSend
      .mockResolvedValueOnce({ Items: [{ userId: { S: "user-1" } }] })
      .mockResolvedValueOnce({
        Responses: {
          UserPreferences: [{ userId: { S: "user-1" }, preference: { S: guid }, type: { S: "Bill" } }],
        },
      })
      .mockResolvedValueOnce({
        Items: [{ userId: { S: "user-1" }, subCategory: { S: "other_resolutions" }, type: { S: "Content Type" } }],
      });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "alert" }]));

    expect(pendingNotificationWriteInputs().map((item) => item.userId.S)).toEqual(["user-1"]);
    // The filter is not even read for them.
    expect(
      mockDynamoSend.mock.calls.filter(([cmd]) => cmd.input?.KeyConditionExpression && !cmd.input?.IndexName),
    ).toHaveLength(0);
  });

  it("processes notificationType bill messages (new) and enqueues notifications", async () => {
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2025-11-01T00:00:00.000Z",
      identifier: {
        congress: "119",
        billType: "house-bill",
        billNumber: "100",
      },
      guid: "BILLS-119hr100is",
      title: "An Act for Comprehensive Healthcare",
      link: "https://example.com/bill",
      soWhat: "Matters for testing.",
      billBreakdown: {
        who: "Healthcare patients",
        what: "Expands access to care",
        how: "Funds innovation",
        when: "Immediately",
        where: "Not Applicable",
        why: "Improve healthcare",
      },
      bodyText: "Full bill text.",
      billXml: "<xml>Full bill xml</xml>",
      actions: [],
      committees: [],
      subCategories: ["Healthcare", "Research and Innovation"],
      lifeAreas: ["Taxes"],
      sponsors: ["S001235"],
      cosponsors: ["S001213"],
    };

    const transformToString = jest.fn().mockResolvedValue(JSON.stringify(document));

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString },
    });

    // Category: Healthcare (GSI query)
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }, { userId: { S: "user-2" } }],
    });
    // Category: Healthcare (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [
          { userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } },
          { userId: { S: "user-2" }, preference: { S: "Healthcare" }, type: { S: "Category" } },
        ],
      },
    });

    // Category: Research and Innovation (GSI query) -> overlaps user-1
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }],
    });
    // Category: Research and Innovation (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [
          { userId: { S: "user-1" }, preference: { S: "Research and Innovation" }, type: { S: "Category" } },
        ],
      },
    });

    // Life Area: Taxes (GSI query) -> overlaps user-1
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }],
    });
    // Life Area: Taxes (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Taxes" }, type: { S: "Life Area" } }],
      },
    });

    // Congress Member: sponsor (GSI query) -> overlaps user-1
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }],
    });
    // Congress Member: sponsor (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "S001235" }, type: { S: "Congress Member" } }],
      },
    });

    // Congress Member: cosponsor (GSI query) -> no users
    mockDynamoSend.mockResolvedValueOnce({
      Items: [],
    });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: "BILLS-119hr100is", notificationType: "new" }]));

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const getCommand = mockS3Send.mock.calls[0][0].input;
    expect(getCommand).toMatchObject({
      Bucket: "test-bucket",
      Key: "processed-bills/BILLS-119hr100.json",
    });

    const firstQuery = mockDynamoSend.mock.calls[0][0].input;
    expect(firstQuery.ExpressionAttributeValues).toEqual({
      ":sub": { S: "Healthcare" },
    });

    const putItemCalls = pendingNotificationWriteInputs();
    expect(putItemCalls).toHaveLength(2);

    const putItem1 = putItemCalls[0];
    const putItem2 = putItemCalls[1];

    const userIds = [putItem1.userId.S, putItem2.userId.S].sort();
    expect(userIds).toEqual(["user-1", "user-2"]);

    expect(putItem1.sourceBillId.S).toBe("BILLS-119hr100is");
    expect(putItem1.billTitle.S).toBe("An Act for Comprehensive Healthcare");
    expect(putItem1.category.S).toBe("Social Policy");
    expect(putItem1.notificationType.S).toBe("new");

    expect(putItem2.sourceBillId.S).toBe("BILLS-119hr100is");
    expect(putItem2.billTitle.S).toBe("An Act for Comprehensive Healthcare");
    expect(putItem2.category.S).toBe("Social Policy");
    expect(putItem2.notificationType.S).toBe("new");
  });

  it("treats active priority bills as subscribed for all active users", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-bucket",
        PREFERENCE_TABLE: "UserPreferences",
        PREFERENCE_INDEX: "GSI_SubCategoryIndex",
        PENDING_NOTIFICATIONS_TABLE: "PendingBillNotifications",
        PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
        PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
        USER_ID_ATTRIBUTE: "userId",
        SUB_CATEGORY_ATTRIBUTE: "subCategory",
        PRIORITY_TABLE_NAME: "BillPriority",
        PRIORITY_TABLE_PARTITION_KEY: "guid",
        PII_TABLE_NAME: "UserPII",
        PII_PARTITION_KEY: "userId",
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    const mod = require("../handlers/userMatcher");
    handler = mod.handler;

    const guid = "BILLS-119hr400is";
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-03-07T00:00:00.000Z",
      identifier: { congress: "119", billType: "hr", billNumber: "400" },
      guid,
      title: "National Funding Bill",
      link: "https://example.com/bill",
      soWhat: "Important bill.",
      billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
      actions: [],
      committees: [],
      subCategories: [],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    };

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });
    mockDynamoSend.mockImplementation(async (command: FakeDynamoCommand) => {
      const input = command.input ?? {};

      if (input.TableName === "BillPriority" && input.Key?.guid?.S === guid) {
        return {
          Item: {
            guid: { S: guid },
            status: { S: "ACTIVE" },
            isPriority: { BOOL: true },
            priorityRank: { N: "1" },
            priorityReason: { S: "Shutdown coverage" },
            priorityExpiresAt: { S: "2099-03-08T00:00:00.000Z" },
            priorityUpdatedAt: { S: "2026-03-07T12:00:00.000Z" },
          },
        };
      }

      if (input.TableName === "UserPII" && input.ProjectionExpression === "#pk, deletionStatus") {
        return {
          Items: [
            { userId: { S: "user-1" } },
            { userId: { S: "user-2" }, deletionStatus: { S: "not_started" } },
            { userId: { S: "user-3" }, deletionStatus: { S: "completed" } },
          ],
        };
      }

      // UX-33: the content-type filter reads each user's own preference rows, also for a bill in the news.
      if (input.TableName === "UserPreferences" && !input.IndexName && input.KeyConditionExpression) {
        return { Items: [] };
      }

      if (Array.isArray(input.TransactItems)) {
        return {};
      }

      throw new Error(`Unexpected DynamoDB call: ${JSON.stringify(input)}`);
    });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "new" }]));

    const writes = pendingNotificationWriteInputs();
    expect(writes).toHaveLength(2);
    expect(writes.map((item) => item.userId.S).sort()).toEqual(["user-1", "user-2"]);
    expect(writes[0].category.S).toBe("Priority Bill");
  });

  it("paginates DynamoDB results", async () => {
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2025-11-01T00:01:00.000Z",
      identifier: {
        congress: "119",
        billType: "house-bill",
        billNumber: "200",
      },
      guid: "BILLS-119hr200is",
      title: "Chronic Care Expansion Act",
      link: "https://example.com/bill-200",
      soWhat: "Matters for testing pagination.",
      billBreakdown: {
        who: "Chronic care patients",
        what: "Enhances chronic care support",
        how: "Expanded programs",
        when: "Immediately",
        where: "Not Applicable",
        why: "Better care",
      },
      bodyText: "Full bill text.",
      billXml: "<xml>Full bill xml</xml>",
      actions: [],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: ["Taxes"],
      sponsors: ["S001235"],
      cosponsors: [],
    };

    const transformToString = jest.fn().mockResolvedValue(JSON.stringify(document));

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString },
    });

    // Category: Healthcare (GSI query) with pagination
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [{ userId: { S: "user-1" } }],
        LastEvaluatedKey: {
          subCategory: { S: "Chronic Care" },
        },
      })
      .mockResolvedValueOnce({
        Items: [{ userId: { S: "user-2" } }],
      });

    // Category: Healthcare (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [
          { userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } },
          { userId: { S: "user-2" }, preference: { S: "Healthcare" }, type: { S: "Category" } },
        ],
      },
    });

    // Life Area: Taxes (GSI query)
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    // Life Area: Taxes (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({ Responses: { UserPreferences: [] } });

    // Congress Member: sponsor (GSI query)
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    // Congress Member: sponsor (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({ Responses: { UserPreferences: [] } });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: "BILLS-119hr200is", notificationType: "new" }]));

    const [putItem1, putItem2] = pendingNotificationWriteInputs();

    expect(putItem1.userId.S).toBe("user-1");
    expect(putItem1.sourceBillId.S).toBe("BILLS-119hr200is");
    expect(putItem1.notificationType.S).toBe("new");

    expect(putItem2.userId.S).toBe("user-2");
    expect(putItem2.sourceBillId.S).toBe("BILLS-119hr200is");
    expect(putItem2.notificationType.S).toBe("new");
  });

  it("does not enqueue duplicate notifications for duplicate S3 records", async () => {
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2025-11-01T00:03:00.000Z",
      identifier: {
        congress: "119",
        billType: "house-bill",
        billNumber: "300",
      },
      guid: "BILLS-119hr300is",
      title: "Duplicate Event Test Bill",
      link: "https://example.com/bill-300",
      soWhat: "Matters for testing dedupe.",
      billBreakdown: {
        who: "Test subjects",
        what: "Testing",
        how: "Testing",
        when: "Now",
        where: "Not Applicable",
        why: "Testing",
      },
      bodyText: "Full bill text.",
      billXml: "<xml>Full bill xml</xml>",
      actions: [],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    };

    const transformToString1 = jest.fn().mockResolvedValue(JSON.stringify(document));
    const transformToString2 = jest.fn().mockResolvedValue(JSON.stringify(document));
    mockS3Send
      .mockResolvedValueOnce({ Body: { transformToString: transformToString1 } })
      .mockResolvedValueOnce({ Body: { transformToString: transformToString2 } });

    // Category: Healthcare (GSI query)
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }],
    });
    // Category: Healthcare (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } }],
      },
    });

    // Second duplicate S3 record will repeat the dynamo calls unless deduped at send-time.
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }],
    });
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } }],
      },
    });

    await handler(
      buildEventFromBodies([
        { domain: "bill", objectId: "BILLS-119hr300is", notificationType: "updated" },
        { domain: "bill", objectId: "BILLS-119hr300is", notificationType: "updated" },
      ]),
    );

    const putItemCalls = pendingNotificationWriteInputs();
    expect(putItemCalls).toHaveLength(1);

    const putItem = putItemCalls[0];
    expect(putItem.userId.S).toBe("user-1");
    expect(putItem.sourceBillId.S).toBe("BILLS-119hr300is");
    expect(putItem.notificationType.S).toBe("updated");
  });

  it("for Bill Updated notifications, only notifies users subscribed to the bill", async () => {
    const guid = "BILLS-119hr600is";
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-01-20T00:00:00.000Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "600" },
      guid,
      title: "Updated Bill",
      link: "https://example.com/bill",
      soWhat: "New summary",
      billBreakdown: {
        who: "All Americans",
        what: "Updated bill",
        how: "New approach",
        when: "Soon",
        where: "Not Applicable",
        why: "Improvement",
      },
      bodyText: "",
      billXml: "",
      actions: [],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: ["Taxes"],
      sponsors: ["S001235"],
      cosponsors: [],
    };

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });

    // Bill-specific preference lookup (GSI query)
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }, { userId: { S: "user-2" } }],
    });
    // Bill-specific preference lookup (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [
          { userId: { S: "user-1" }, preference: { S: guid }, type: { S: "Bill" } },
          { userId: { S: "user-2" }, preference: { S: guid }, type: { S: "Bill" } },
        ],
      },
    });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "updated" }]));

    // Should query by bill GUID (not by categories)
    const firstQuery = mockDynamoSend.mock.calls[0][0].input;
    expect(firstQuery.ExpressionAttributeValues).toEqual({ ":sub": { S: guid } });

    // Should write pending notifications with type "updated"
    const putItemCalls = pendingNotificationWriteInputs();
    expect(putItemCalls).toHaveLength(2);

    expect(putItemCalls[0].userId.S).toBe("user-1");
    expect(putItemCalls[0].notificationType.S).toBe("updated");

    expect(putItemCalls[1].userId.S).toBe("user-2");
    expect(putItemCalls[1].notificationType.S).toBe("updated");
  });

  // UX-33: an outcome reaches the bill's voters and watchers as well as the followers of its labels.
  it("routes 'passed' notifications to the bill's voters and watchers and through criteria matching", async () => {
    const guid = "BILLS-119hr500is";
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-01-15T00:00:00.000Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "500" },
      guid,
      title: "Passed Bill",
      link: "https://example.com/bill",
      soWhat: "",
      billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
      bodyText: "",
      billXml: "",
      actions: [{ actionCode: "8000", actionDate: "2026-01-15", text: "Passed the House", type: "Floor" }],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    };

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });

    // The bill's voters and watchers (GSI query on its guid, then the BatchGet type filter)
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ userId: { S: "user-2" } }] });
    mockDynamoSend.mockResolvedValueOnce({
      Responses: { UserPreferences: [{ userId: { S: "user-2" }, preference: { S: guid }, type: { S: "Bill" } }] },
    });
    // Category: Healthcare (GSI query)
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }],
    });
    // Category: Healthcare (BatchGet filter)
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } }],
      },
    });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "passed" }]));

    // The bill's guid first, then its category, and a "passed" row for each user
    const queries = mockDynamoSend.mock.calls.map(([cmd]) => cmd.input).filter((input) => input.IndexName);
    expect(queries.map((input) => input.ExpressionAttributeValues)).toEqual([
      { ":sub": { S: guid } },
      { ":sub": { S: "Healthcare" } },
    ]);

    const putItemCalls = pendingNotificationWriteInputs();
    expect(putItemCalls.map((item) => [item.userId.S, item.sourceBillId.S, item.notificationType.S])).toEqual([
      ["user-2", guid, "passed"],
      ["user-1", guid, "passed"],
    ]);
  });

  it("routes 'failed' notifications to the bill's voters and watchers and through criteria matching", async () => {
    const guid = "BILLS-119hr501is";
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-02-10T00:00:00.000Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "501" },
      guid,
      title: "Failed Bill",
      link: "https://example.com/bill",
      soWhat: "",
      billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
      bodyText: "",
      billXml: "",
      actions: [{ actionCode: "9000", actionDate: "2026-02-10", text: "Failed the House", type: "Floor" }],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    };

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });

    // No voter or watcher (an empty typed lookup, then the untyped fallback), then the category's follower
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    mockDynamoSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" } }],
    });
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } }],
      },
    });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "failed" }]));

    const queries = mockDynamoSend.mock.calls.map(([cmd]) => cmd.input).filter((input) => input.IndexName);
    expect(queries.map((input) => input.ExpressionAttributeValues)).toEqual([
      { ":sub": { S: guid } },
      { ":sub": { S: guid } },
      { ":sub": { S: "Healthcare" } },
    ]);

    const putItemCalls = pendingNotificationWriteInputs();
    expect(putItemCalls).toHaveLength(1);

    const putItem = putItemCalls[0];
    expect(putItem.userId.S).toBe("user-1");
    expect(putItem.sourceBillId.S).toBe(guid);
    expect(putItem.notificationType.S).toBe("failed");
  });

  it("skips criteria-based notifications when the user's content type filter excludes the bill", async () => {
    const guid = "BILLS-119hr777is";
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-01-16T00:00:00.000Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "777" },
      guid,
      title: "Filtered Criteria Bill",
      link: "https://example.com/bill",
      soWhat: "",
      billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
      bodyText: "",
      billXml: "",
      actions: [],
      committees: [],
      subCategories: ["Healthcare"],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    };

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });

    mockDynamoSend
      .mockResolvedValueOnce({ Items: [{ userId: { S: "user-1" } }] })
      .mockResolvedValueOnce({
        Responses: {
          UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } }],
        },
      })
      .mockResolvedValueOnce({
        Items: [{ userId: { S: "user-1" }, subCategory: { S: "other_resolutions" }, type: { S: "Content Type" } }],
      });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "new" }]));

    expect(pendingNotificationWriteInputs()).toHaveLength(0);
  });

  it("handles SNS wrapped messages", async () => {
    const document = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2025-11-01T00:02:00.000Z",
      identifier: {
        congress: "118",
        billType: "senate-bill",
        billNumber: "50",
      },
      guid: "BILLS-118s50is",
      title: "Education Access Improvement Act",
      link: "https://example.com/bill-50",
      soWhat: "Matters for testing SNS unwrap.",
      billBreakdown: {
        who: "Students",
        what: "Improves education access",
        how: "New programs",
        when: "Next year",
        where: "Not Applicable",
        why: "Better education",
      },
      bodyText: "Full bill text.",
      billXml: "<xml>Full bill xml</xml>",
      actions: [],
      committees: [],
      subCategories: ["Education"],
      lifeAreas: ["Taxes"],
      sponsors: ["S001235"],
      cosponsors: [],
    };

    const transformToString = jest.fn().mockResolvedValue(JSON.stringify(document));

    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString },
    });

    mockDynamoSend
      .mockResolvedValueOnce({ Items: [{ userId: { S: "user-1" } }] }) // Category: Education (GSI)
      .mockResolvedValueOnce({
        Responses: {
          UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Education" }, type: { S: "Category" } }],
        },
      }) // Category filter
      .mockResolvedValueOnce({ Items: [] }) // Life Area: Taxes (GSI)
      .mockResolvedValueOnce({ Responses: { UserPreferences: [] } }) // Life Area filter
      .mockResolvedValueOnce({ Items: [] }) // Congress Member: sponsor (GSI)
      .mockResolvedValueOnce({ Responses: { UserPreferences: [] } }); // Congress Member filter

    const snsWrappedEvent: SQSEvent = {
      Records: [
        {
          messageId: "msg-0",
          receiptHandle: "receipt-0",
          body: JSON.stringify({
            Type: "Notification",
            Message: JSON.stringify({
              domain: "bill",
              objectId: "BILLS-118s50is",
              notificationType: "new",
            }),
          }),
          attributes: {
            ApproximateReceiveCount: "1",
            SentTimestamp: `${Date.now()}`,
            SenderId: "sender",
            ApproximateFirstReceiveTimestamp: `${Date.now()}`,
          },
          messageAttributes: {},
          md5OfBody: "md5",
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:userMatcher",
          awsRegion: "us-east-1",
        },
      ],
    };

    await handler(snsWrappedEvent);

    expect(mockS3Send).toHaveBeenCalledTimes(1);

    // Should have at least 1 PutItem call
    const putItemCalls = pendingNotificationWriteInputs();
    expect(putItemCalls.length).toBeGreaterThan(0);
  });
});

describe("userMatcher partial batches and revision dedupe", () => {
  const processedDoc = (guid: string, title: string, subCategories: string[] = []) => ({
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-09-01T00:00:00.000Z",
    identifier: { congress: "119", billType: "house-bill", billNumber: guid.replace(/^BILLS-119hr(\d+)is$/, "$1") },
    guid,
    title,
    link: "https://example.com/bill",
    soWhat: "",
    billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
    bodyText: "",
    billXml: "",
    actions: [],
    committees: [],
    subCategories,
    lifeAreas: [],
    sponsors: [],
    cosponsors: [],
  });

  // Routes S3 and DynamoDB calls by input so the order of calls does not matter.
  const routeCalls = (options: {
    docs: Record<string, ReturnType<typeof processedDoc>>;
    failingS3KeyFragment?: string;
    subscribers: Record<string, string[]>;
    transactFailureForUser?: Record<string, Error>;
  }) => {
    mockS3Send.mockImplementation(async (cmd: { input: { Key?: string; Prefix?: string } }) => {
      const key: string = cmd.input.Key ?? "";
      if (options.failingS3KeyFragment && key.includes(options.failingS3KeyFragment)) {
        throw Object.assign(new Error("We encountered an internal error. Please try again."), {
          name: "InternalError",
        });
      }
      // processed-bills/<guid without the text-version suffix>.json
      const doc = Object.values(options.docs).find((d) => key === `processed-bills/${d.guid.replace(/is$/, "")}.json`);
      if (!doc) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      return { Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(doc)) } };
    });

    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      const input = cmd.input ?? {};
      if (input.TransactItems) {
        const userId = input.TransactItems[1].Put.Item.userId.S!;
        const failure = options.transactFailureForUser?.[userId];
        if (failure) throw failure;
        return {};
      }
      if (input.RequestItems) {
        const keys = input.RequestItems.UserPreferences.Keys;
        return { Responses: { UserPreferences: keys.map((k) => ({ ...k, type: { S: "Bill" } })) } };
      }
      const sub = input.ExpressionAttributeValues?.[":sub"]?.S;
      if (sub) {
        return { Items: (options.subscribers[sub] ?? []).map((userId) => ({ userId: { S: userId } })) };
      }
      return { Items: [] };
    });
  };

  const dedupeKeysWritten = () =>
    mockDynamoSend.mock.calls
      .map((call) => call[0].input)
      .filter((input) => Array.isArray(input?.TransactItems))
      .map((input) => input.TransactItems[0].Put.Item.billId.S as string);

  it("reports exactly the messageIds of the records that failed", async () => {
    routeCalls({
      docs: {
        a: processedDoc("BILLS-119hr811is", "Bill A"),
        c: processedDoc("BILLS-119hr813is", "Bill C"),
      },
      failingS3KeyFragment: "hr812",
      subscribers: { "BILLS-119hr811is": ["user-1"], "BILLS-119hr813is": ["user-3"] },
      transactFailureForUser: {
        "user-3": Object.assign(new Error("Throughput exceeds the current capacity"), {
          name: "ProvisionedThroughputExceededException",
        }),
      },
    });

    const result = await handler(
      buildEventFromBodies([
        { domain: "bill", objectId: "BILLS-119hr811is", notificationType: "alert", sourceRevision: "v1" },
        { domain: "bill", objectId: "BILLS-119hr812is", notificationType: "alert", sourceRevision: "v1" },
        { not: "a notificationType message" },
        { domain: "bill", objectId: "BILLS-119hr813is", notificationType: "updated", sourceRevision: "v1" },
      ]),
    );

    // msg-2 is malformed and cannot succeed on retry, so it is dropped rather than reported.
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }, { itemIdentifier: "msg-3" }] });
    expect(pendingNotificationWriteInputs().map((item) => item.userId.S)).toEqual(["user-1", "user-3"]);
  });

  describe("unprocessable messages (C1.8)", () => {
    const DROP_LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";
    const dropLines = () => logLines(console.warn).filter((line) => line.message === DROP_LOG_MESSAGE);
    const dropMetrics = () => logLines(console.log).filter((line) => line._aws && "MessagesUnprocessable" in line);
    const goodBody = { domain: "bill", objectId: "BILLS-119hr830is", notificationType: "alert", sourceRevision: "v1" };
    const eventWithRawBodies = (bodies: string[]): SQSEvent => {
      const event = buildEventFromBodies(bodies);
      event.Records.forEach((record, i) => {
        record.body = bodies[i];
      });
      return event;
    };

    it("acknowledges, logs and counts each message that is not a NotificationType message, with its reason", async () => {
      routeCalls({
        docs: { a: processedDoc("BILLS-119hr830is", "Bill") },
        subscribers: { "BILLS-119hr830is": ["user-1"] },
      });

      const result = await handler(
        eventWithRawBodies([
          JSON.stringify({ not: "a notificationType message" }),
          "not json",
          "",
          JSON.stringify({
            domain: "bill",
            objectId: "BILLS-119hr830is",
            notificationType: "alert",
            alert: { text: " " },
          }),
          JSON.stringify({ Type: "Notification", Message: JSON.stringify({ domain: "bill", objectId: 7 }) }),
          JSON.stringify(goodBody),
        ]),
      );

      expect(result).toEqual({ batchItemFailures: [] });
      expect(pendingNotificationWriteInputs().map((item) => item.userId.S)).toEqual(["user-1"]);
      expect(dropLines().map((line) => [line.messageId, line.dropSite, line.reason])).toEqual([
        ["msg-0", "userMatcher.malformed", "not_notification_type"],
        ["msg-1", "userMatcher.malformed", "invalid_json"],
        ["msg-2", "userMatcher.malformed", "empty_body"],
        ["msg-3", "userMatcher.malformed", "not_notification_type"],
        ["msg-4", "userMatcher.malformed", "not_notification_type"],
      ]);
      expect(dropLines()[0].messageContent).toEqual({ not: "a notificationType message" });
      expect(dropLines()[1].messagePreview).toBe("not json");
      expect(dropMetrics().map((line) => [line.sqsMessageId, line.MessagesUnprocessable, line.dropSite])).toEqual([
        ["msg-0", 1, "userMatcher.malformed"],
        ["msg-1", 1, "userMatcher.malformed"],
        ["msg-2", 1, "userMatcher.malformed"],
        ["msg-3", 1, "userMatcher.malformed"],
        ["msg-4", 1, "userMatcher.malformed"],
      ]);
    });

    it("counts nothing for a NotificationType message, or for one whose processed bill is missing", async () => {
      routeCalls({ docs: {}, subscribers: {} });

      const result = await handler(buildEventFromBodies([goodBody]));

      expect(result).toEqual({ batchItemFailures: [] });
      expect(dropLines()).toEqual([]);
      expect(dropMetrics()).toEqual([]);
    });

    it("still acknowledges the message, and the batch goes on, when the drop's log and metric lines throw", async () => {
      routeCalls({
        docs: { a: processedDoc("BILLS-119hr830is", "Bill") },
        subscribers: { "BILLS-119hr830is": ["user-1"] },
      });
      (console.warn as jest.Mock).mockImplementation((line: unknown) => {
        if (String(line).includes(DROP_LOG_MESSAGE)) throw new Error("console.warn broke");
      });
      (console.log as jest.Mock).mockImplementation((line: unknown) => {
        if (String(line).includes('"MessagesUnprocessable"')) throw new Error("console.log broke");
      });

      const result = await handler(eventWithRawBodies(["not json", JSON.stringify(goodBody)]));

      expect(result).toEqual({ batchItemFailures: [] });
      expect(pendingNotificationWriteInputs().map((item) => item.userId.S)).toEqual(["user-1"]);
      const attempts = (spy: unknown, needle: string) =>
        (spy as jest.Mock).mock.calls.filter(([line]) => String(line).includes(needle)).length;
      expect(attempts(console.warn, DROP_LOG_MESSAGE)).toBe(1);
      expect(attempts(console.log, '"MessagesUnprocessable"')).toBe(1);
    });
  });

  it("notifies once for each distinct revision of the same bill update", async () => {
    const guid = "BILLS-119hr820is";
    routeCalls({ docs: { a: processedDoc(guid, "Revised Bill") }, subscribers: { [guid]: ["user-1"] } });

    const result = await handler(
      buildEventFromBodies([
        { domain: "bill", objectId: guid, notificationType: "updated", sourceRevision: "v1" },
        { domain: "bill", objectId: guid, notificationType: "updated", sourceRevision: "v1" },
        { domain: "bill", objectId: guid, notificationType: "updated", sourceRevision: "v2" },
      ]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(dedupeKeysWritten()).toEqual([`user-1||${guid}||updated||v1`, `user-1||${guid}||updated||v2`]);
    const dedupeItem = mockDynamoSend.mock.calls
      .map((call) => call[0].input)
      .find((input) => Array.isArray(input?.TransactItems)).TransactItems[0].Put;
    expect(dedupeItem.ConditionExpression).toBe("attribute_not_exists(#pk) AND attribute_not_exists(#sk)");
    expect(dedupeItem.Item.sourceRevision).toEqual({ S: "v1" });
  });

  it("treats a redelivered revision as a duplicate without failing the record", async () => {
    const guid = "BILLS-119hr821is";
    routeCalls({
      docs: { a: processedDoc(guid, "Redelivered Bill") },
      subscribers: { [guid]: ["user-1"] },
      transactFailureForUser: {
        "user-1": new Error(
          "Transaction cancelled, please refer cancellation reasons for specific reasons [ConditionalCheckFailed, None, None]",
        ),
      },
    });

    const result = await handler(
      buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "alert", sourceRevision: "v9" }]),
    );

    expect(result.batchItemFailures).toEqual([]);
    expect(dedupeKeysWritten()).toEqual([`user-1||${guid}||alert||v9`]);
  });

  it("keeps the legacy dedupe key for messages queued without a revision", async () => {
    const guid = "BILLS-119hr822is";
    routeCalls({ docs: { a: processedDoc(guid, "Legacy Bill") }, subscribers: { [guid]: ["user-1"] } });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "alert" }]));

    expect(dedupeKeysWritten()).toEqual([`user-1||${guid}||alert`]);
  });

  it("adds the revision to the dedupe key on the criteria-matching path", async () => {
    const guid = "BILLS-119hr823is";
    routeCalls({
      docs: { a: processedDoc(guid, "Criteria Bill", ["Healthcare"]) },
      subscribers: { Healthcare: ["user-4"] },
    });
    // Criteria lookups filter on type "Category", not "Bill".
    const routed = mockDynamoSend.getMockImplementation()!;
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      if (cmd.input?.RequestItems) {
        const keys = cmd.input.RequestItems.UserPreferences.Keys;
        return { Responses: { UserPreferences: keys.map((k) => ({ ...k, type: { S: "Category" } })) } };
      }
      return routed(cmd);
    });

    await handler(
      buildEventFromBodies([
        { domain: "bill", objectId: guid, notificationType: "passed", sourceRevision: "v3" },
        { domain: "bill", objectId: guid, notificationType: "passed", sourceRevision: "v4" },
      ]),
    );

    expect(dedupeKeysWritten()).toEqual([`user-4||${guid}||passed||v3`, `user-4||${guid}||passed||v4`]);
  });
});

describe("userMatcher correlation id (OBS-10)", () => {
  const correlationId = "2026-01-15T10:00:00.000Z:BILLS-119hr500is";
  const guid = "BILLS-119hr500is";
  const document = {
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-01-15T00:00:00.000Z",
    identifier: { congress: "119", billType: "house-bill", billNumber: "500" },
    guid,
    title: "Passed Bill",
    link: "https://example.com/bill",
    soWhat: "",
    billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
    actions: [],
    committees: [],
    subCategories: ["Healthcare"],
    lifeAreas: [],
    sponsors: [],
    cosponsors: [],
  };

  const tracedEvent = (body: unknown): SQSEvent => {
    const event = buildEventFromBodies([body]);
    event.Records[0].messageAttributes = { correlationId: { dataType: "String", stringValue: correlationId } };
    return event;
  };

  it("keeps the record's id on the pending row for userNotifier (criteria path)", async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ userId: { S: "user-1" } }] });
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } }],
      },
    });

    await (handler as (event: SQSEvent, context?: unknown) => Promise<unknown>)(
      tracedEvent({ domain: "bill", objectId: guid, notificationType: "new" }),
      { awsRequestId: "req-4" },
    );

    const [row] = pendingNotificationWriteInputs();
    expect(row.correlationId).toEqual({ S: correlationId });
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Wrote pending notification",
        guid,
        correlationId,
        userId: "user-1",
        sqsMessageId: "msg-0",
        awsRequestId: "req-4",
      }),
    );
  });

  it("keeps the record's id on the pending row for userNotifier (bill-subscriber path)", async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ userId: { S: "user-2" } }] });
    mockDynamoSend.mockResolvedValueOnce({
      Responses: { UserPreferences: [{ userId: { S: "user-2" }, preference: { S: guid }, type: { S: "Bill" } }] },
    });

    await handler(tracedEvent({ domain: "bill", objectId: guid, notificationType: "updated" }));

    const [row] = pendingNotificationWriteInputs();
    expect(row.userId).toEqual({ S: "user-2" });
    expect(row.correlationId).toEqual({ S: correlationId });
  });

  it("mints one when the record carries none", async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) },
    });
    mockDynamoSend.mockResolvedValueOnce({ Items: [{ userId: { S: "user-1" } }] });
    mockDynamoSend.mockResolvedValueOnce({
      Responses: {
        UserPreferences: [{ userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } }],
      },
    });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: guid, notificationType: "new" }]));

    expect(pendingNotificationWriteInputs()[0].correlationId.S).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z:BILLS-119hr500is$/,
    );
  });
});

describe("userMatcher companion groups (APPF-23)", () => {
  const HOUSE = "BILLS-119hr1285";
  const SENATE = "BILLS-119s570";
  const OTHER = "BILLS-119hr77";

  const processedDoc = (guid: string, subCategories: string[] = ["Healthcare"], sponsors: string[] = []) => ({
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-09-01T00:00:00.000Z",
    identifier: { congress: "119", billType: guid.includes("s570") ? "s" : "hr", billNumber: "1" },
    guid,
    title: `Title of ${guid}`,
    link: "https://example.com/bill",
    soWhat: "",
    billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
    bodyText: "",
    billXml: "",
    actions: [],
    committees: [],
    subCategories,
    lifeAreas: [],
    sponsors,
    cosponsors: [],
  });

  type Preference = { userId: string; value: string; type: string };
  type RouteOptions = {
    groups?: { enabled: boolean; pairs: string[][] } | "fail";
    declarations?: Record<string, string[]>;
    held?: string[];
    updatedAt?: Record<string, string>;
    preferences?: Preference[];
    failDeclarations?: boolean;
    /** Sponsor ids per bill (none by default). */
    sponsors?: Record<string, string[]>;
    /** Subcategories per bill (Healthcare by default). */
    subCategories?: Record<string, string[]>;
    /** A processed bill's S3 versions, newest first (by default one: firstRevision(guid)). */
    versions?: Record<string, string[]>;
    /** Bills with an active priority record (needs PRIORITY_TABLE_NAME), and the active users. */
    priorityGuids?: string[];
    activeUsers?: string[];
  };

  // The revision a bill's "new" is sent with: its first stored S3 version.
  const firstRevision = (guid: string) => `v1-${guid}`;

  // The pending table, kept across route() calls: the companion "new" deferral claims (by sort key),
  // the dedupe markers (by key), and the pending rows of the transactions that committed.
  let claims: Map<string, PendingItem>;
  let markers: Map<string, PendingItem>;
  let committedRows: PendingItem[];

  const keyOf = (item: PendingItem) => `${item.userId.S}|${item.billId.S}`;
  // An attribute_not_exists condition fails when the item already exists, unless the condition's
  // "OR attribute_exists(#name)" holds on the stored item.
  const conditionFails = ({ Item, ConditionExpression, ExpressionAttributeNames }: TransactPut) => {
    const existing = markers.get(keyOf(Item));
    if (!ConditionExpression?.includes("attribute_not_exists") || !existing) return false;
    const orExists = /OR attribute_exists\((#\w+)\)/.exec(ConditionExpression);
    return !(orExists && existing[ExpressionAttributeNames?.[orExists[1]] ?? ""] !== undefined);
  };

  // The pending table's transactions: a failed condition cancels the whole transaction, as DynamoDB does.
  const transact = (items: Array<{ Put: TransactPut }>) => {
    const codes = items.map(({ Put }) => (conditionFails(Put) ? "ConditionalCheckFailed" : "None"));
    if (codes.includes("ConditionalCheckFailed")) {
      throw Object.assign(
        new Error(
          `Transaction cancelled, please refer cancellation reasons for specific reasons [${codes.join(", ")}]`,
        ),
        { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) },
      );
    }
    for (const { Put } of items) {
      if (Put.ConditionExpression) markers.set(keyOf(Put.Item), Put.Item);
      if (Put.Item.billTitle?.S) committedRows.push(Put.Item);
    }
    return {};
  };

  const route = (options: RouteOptions) => {
    const preferences = options.preferences ?? [];
    mockS3Send.mockImplementation(async (cmd: { input: { Key?: string; Prefix?: string } }) => {
      const key = cmd.input.Key ?? cmd.input.Prefix;
      const guid = [HOUSE, SENATE, OTHER].find((candidate) => key === `processed-bills/${candidate}.json`);
      if (!guid) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      if (cmd.input.Prefix) {
        const versionIds = options.versions?.[guid] ?? [firstRevision(guid)];
        return {
          Versions: versionIds.map((VersionId, index) => ({
            Key: key,
            VersionId,
            IsLatest: index === 0,
            LastModified: new Date(Date.UTC(2026, 8, 20 - index)),
          })),
        };
      }
      const document = processedDoc(
        guid,
        options.subCategories?.[guid] ?? ["Healthcare"],
        options.sponsors?.[guid] ?? [],
      );
      return { Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(document)) } };
    });
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      const input = cmd.input ?? {};
      if (input.TransactItems) return transact(input.TransactItems);
      if (input.TableName === "Priority") {
        const guid = input.Key?.guid?.S;
        return options.priorityGuids?.includes(guid!)
          ? {
              Item: {
                guid: { S: guid },
                status: { S: "ACTIVE" },
                isPriority: { BOOL: true },
                priorityUpdatedAt: { S: "2026-09-02T00:00:00.000Z" },
              },
            }
          : {};
      }
      if (input.TableName === "Pii") {
        return { Items: (options.activeUsers ?? []).map((userId) => ({ userId: { S: userId } })) };
      }
      if (input.Item?.markerType?.S === "companion-new-deferral") {
        const existing = claims.get(input.Item.billId.S!);
        if (existing && existing.deferredGuid.S !== input.ExpressionAttributeValues![":deferring"].S) {
          throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
        }
        claims.set(input.Item.billId.S!, input.Item);
        return {};
      }
      const pk = input.Key?.pk?.S;
      if (pk === "BILL_COMPANION_GROUPS") {
        if (!options.groups) return {};
        if (options.groups === "fail") throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        return {
          Item: {
            pk: { S: pk },
            sk: { S: "CURRENT" },
            pairsVersion: { N: "4" },
            enabled: { BOOL: options.groups.enabled },
            pairs: { S: JSON.stringify(options.groups.pairs) },
          },
        };
      }
      if (pk === "BILL_GUID") {
        const updatedAt = options.updatedAt?.[input.Key!.sk.S!];
        return updatedAt ? { Item: { updatedAt: { S: updatedAt } } } : {};
      }
      if (input.ExpressionAttributeValues?.[":pk"]?.S === "BILL_COMPANION_DECL") {
        if (options.failDeclarations) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        return {
          Items: Object.entries(options.declarations ?? {}).map(([guid, declared]) => ({
            pk: { S: "BILL_COMPANION_DECL" },
            sk: { S: guid },
            declared: { L: declared.map((target) => ({ M: { guid: { S: target } } })) },
          })),
        };
      }
      if (input.RequestItems?.BillsManifest) {
        const keys = input.RequestItems.BillsManifest.Keys;
        return { Responses: { BillsManifest: keys.filter((key) => options.held?.includes(key.sk.S)) } };
      }
      if (input.RequestItems?.UserPreferences) {
        const keys = input.RequestItems.UserPreferences.Keys;
        return {
          Responses: {
            UserPreferences: keys.flatMap((key) => {
              // The key is the user id and the preference value, whatever the value attribute is called.
              const [value] = Object.entries(key).filter(([name]) => name !== "userId");
              const found = preferences.find((p) => p.userId === key.userId.S && p.value === value?.[1].S);
              return found ? [{ ...key, type: { S: found.type } }] : [];
            }),
          },
        };
      }
      const sub = input.ExpressionAttributeValues?.[":sub"]?.S;
      if (sub) {
        return { Items: preferences.filter((p) => p.value === sub).map((p) => ({ userId: { S: p.userId } })) };
      }
      return { Items: [] };
    });
  };

  const watchersAndTopic: Preference[] = [
    { userId: "watches-house", value: HOUSE, type: "Bill" },
    { userId: "watches-senate", value: SENATE, type: "Bill" },
    { userId: "watches-both", value: HOUSE, type: "Bill" },
    { userId: "watches-both", value: SENATE, type: "Bill" },
    { userId: "topic-user", value: "Healthcare", type: "Category" },
  ];
  const enabledPair = { enabled: true, pairs: [[HOUSE, SENATE]] };

  const pendingRows = () =>
    committedRows.map((item) => ({
      userId: item.userId.S,
      sourceBillId: item.sourceBillId.S,
      notificationType: item.notificationType.S,
    }));
  const suppressedMetricLines = () =>
    logLines(console.log).filter((line) => typeof line.CompanionNewSuppressed === "number" && line._aws);
  const declarationQueries = () =>
    mockDynamoSend.mock.calls.filter(
      ([cmd]) => cmd.input?.ExpressionAttributeValues?.[":pk"]?.S === "BILL_COMPANION_DECL",
    );

  beforeEach(() => {
    jest.resetModules();
    process.env.MANIFEST_TABLE_NAME = "BillsManifest";
    process.env.MANIFEST_PRIMARY_KEY = "pk";
    process.env.GUID_LOOKUP_PK = "BILL_GUID";
    claims = new Map();
    markers = new Map();
    committedRows = [];
    handler = require("../handlers/userMatcher").handler;
  });

  it.each(["passed", "failed"])(
    "sends '%s' to the watchers of every member, each user once, keyed by the event's bill",
    async (notificationType) => {
      route({ groups: enabledPair, preferences: watchersAndTopic });

      await handler(buildEventFromBodies([{ domain: "bill", objectId: SENATE, notificationType }]));

      const rows = pendingRows();
      expect(rows.map((row) => row.userId).sort()).toEqual([
        "topic-user",
        "watches-both",
        "watches-house",
        "watches-senate",
      ]);
      expect(rows.every((row) => row.sourceBillId === SENATE && row.notificationType === notificationType)).toBe(true);
    },
  );

  it("sends 'alert' to the watchers of every member, each user once", async () => {
    route({ groups: enabledPair, preferences: watchersAndTopic });

    await handler(
      buildEventFromBodies([{ domain: "bill", objectId: HOUSE, notificationType: "alert", alert: { text: "Vote" } }]),
    );

    const rows = pendingRows();
    expect(rows.map((row) => row.userId)).toEqual(["watches-house", "watches-both", "watches-senate"]);
    expect(rows.every((row) => row.sourceBillId === HOUSE)).toBe(true);
  });

  it("keeps 'updated' to the bill's own watchers", async () => {
    route({ groups: enabledPair, preferences: watchersAndTopic });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: SENATE, notificationType: "updated" }]));

    expect(pendingRows().map((row) => row.userId)).toEqual(["watches-senate", "watches-both"]);
  });

  // UX-33: an outcome reaches the bill's own voters and watchers whether or not it is grouped.
  it("matches each bill on its own while the published groups are turned off", async () => {
    route({ groups: { enabled: false, pairs: [] }, preferences: watchersAndTopic });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: SENATE, notificationType: "passed" }]));
    await handler(
      buildEventFromBodies([{ domain: "bill", objectId: HOUSE, notificationType: "alert", alert: { text: "Vote" } }]),
    );

    expect(pendingRows()).toEqual([
      { userId: "watches-senate", sourceBillId: SENATE, notificationType: "passed" },
      { userId: "watches-both", sourceBillId: SENATE, notificationType: "passed" },
      { userId: "topic-user", sourceBillId: SENATE, notificationType: "passed" },
      { userId: "watches-house", sourceBillId: HOUSE, notificationType: "alert" },
      { userId: "watches-both", sourceBillId: HOUSE, notificationType: "alert" },
    ]);
  });

  it("matches the bill on its own when the groups cannot be read", async () => {
    route({ groups: "fail", preferences: watchersAndTopic });

    await handler(buildEventFromBodies([{ domain: "bill", objectId: SENATE, notificationType: "passed" }]));

    expect(pendingRows().map((row) => row.userId)).toEqual(["watches-senate", "watches-both", "topic-user"]);
    expect(logLines(console.log).some((line) => line.CompanionGroupsReadFailed === 1)).toBe(true);
  });

  describe("'new' for a companion pair", () => {
    const pairRoute = (updatedAt: Record<string, string>, extra: Partial<RouteOptions> = {}) =>
      route({
        groups: enabledPair,
        // One-sided: only the Senate bill lists the House bill; the pair still forms.
        declarations: { [SENATE]: [HOUSE] },
        held: [HOUSE, SENATE],
        updatedAt,
        preferences: [{ userId: "topic-user", value: "Healthcare", type: "Category" }],
        ...extra,
      });
    const sendNew = (guid: string) =>
      handler(
        buildEventFromBodies([
          { domain: "bill", objectId: guid, notificationType: "new", sourceRevision: firstRevision(guid) },
        ]),
      );
    const companionMarkerPuts = () =>
      mockDynamoSend.mock.calls
        .map(([cmd]: [FakeDynamoCommand]) => cmd.input?.TransactItems?.[3]?.Put)
        .filter((put) => put !== undefined);

    it("skips the users the earlier member's 'new' reached, and the later member defers", async () => {
      pairRoute({ [HOUSE]: "2026-09-02T00:00:00.000Z", [SENATE]: "2026-09-01T00:00:00.000Z" });

      await sendNew(SENATE);
      await sendNew(HOUSE);

      expect(pendingRows()).toEqual([{ userId: "topic-user", sourceBillId: SENATE, notificationType: "new" }]);
      expect(suppressedMetricLines()).toHaveLength(1);
      expect(suppressedMetricLines()[0].CompanionNewSuppressed).toBe(1);
      expect(suppressedMetricLines()[0]._aws!.CloudWatchMetrics[0].Namespace).toBe("BillBoard/Notifications");
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Deferring new notification to its companion bill for the users that one reached",
          billId: HOUSE,
          companionGuid: SENATE,
          companionRevision: firstRevision(SENATE),
        }),
      );
      expect([...claims.values()]).toEqual([
        expect.objectContaining({
          userId: { S: "__dedupe__" },
          billId: { S: `companion-new||${HOUSE}` },
          deferredGuid: { S: HOUSE },
          companionGuid: { S: SENATE },
        }),
      ]);
      // The House write checks (and would create) the Senate "new"'s dedupe marker for the user.
      expect(companionMarkerPuts()).toEqual([
        expect.objectContaining({
          ConditionExpression: "attribute_not_exists(#sk) OR attribute_exists(#reachedBy)",
          ExpressionAttributeNames: { "#sk": "billId", "#reachedBy": "reachedByBillId" },
          Item: expect.objectContaining({
            userId: { S: "__dedupe__" },
            billId: { S: `topic-user||${SENATE}||new||${firstRevision(SENATE)}` },
            reachedByBillId: { S: HOUSE },
          }),
        }),
      ]);
    });

    it("gives each user one 'new' when the later member's is handled first", async () => {
      pairRoute({ [HOUSE]: "2026-09-02T00:00:00.000Z", [SENATE]: "2026-09-01T00:00:00.000Z" });

      await sendNew(HOUSE); // defers, but the Senate "new" has reached nobody yet
      await sendNew(SENATE);

      // The House write left the Senate "new"'s marker for topic-user, so the Senate "new" skips them.
      expect(pendingRows()).toEqual([{ userId: "topic-user", sourceBillId: HOUSE, notificationType: "new" }]);
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({ message: "Skipping duplicate pending notification", billId: SENATE }),
      );
    });

    it("still sends the later member's 'new' to the users only it matches, such as its sponsor's followers", async () => {
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-02T00:00:00.000Z" },
        {
          sponsors: { [HOUSE]: ["H000001"], [SENATE]: ["S000001"] },
          preferences: [
            { userId: "topic-user", value: "Healthcare", type: "Category" },
            { userId: "follows-senator", value: "S000001", type: "Congress Member" },
            { userId: "follows-both", value: "H000001", type: "Congress Member" },
            { userId: "follows-both", value: "S000001", type: "Congress Member" },
          ],
        },
      );

      await sendNew(HOUSE);
      await sendNew(SENATE);

      expect(pendingRows()).toEqual([
        { userId: "topic-user", sourceBillId: HOUSE, notificationType: "new" },
        { userId: "follows-both", sourceBillId: HOUSE, notificationType: "new" },
        { userId: "follows-senator", sourceBillId: SENATE, notificationType: "new" },
      ]);
      expect(suppressedMetricLines().map((line) => line.CompanionNewSuppressed)).toEqual([2]);
    });

    it("sends the later member's 'new' to a user who started following its topic after the earlier 'new'", async () => {
      // Day 1: H.R. 1285's "new" reaches the Healthcare followers of the time.
      pairRoute({ [HOUSE]: "2026-09-01T00:00:00.000Z" }, { held: [HOUSE] });
      await sendNew(HOUSE);

      // Day 5: late-user follows Healthcare. Day 8: S. 570 arrives and declares H.R. 1285.
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-08T00:00:00.000Z" },
        {
          preferences: [
            { userId: "topic-user", value: "Healthcare", type: "Category" },
            { userId: "late-user", value: "Healthcare", type: "Category" },
          ],
        },
      );
      await sendNew(SENATE);

      expect(pendingRows()).toEqual([
        { userId: "topic-user", sourceBillId: HOUSE, notificationType: "new" },
        { userId: "late-user", sourceBillId: SENATE, notificationType: "new" },
      ]);
      expect(suppressedMetricLines().map((line) => line.CompanionNewSuppressed)).toEqual([1]);
    });

    it("sends the later member's 'new' when the earlier member became a priority bill after its own 'new'", async () => {
      process.env.PRIORITY_TABLE_NAME = "Priority";
      process.env.PRIORITY_TABLE_PARTITION_KEY = "guid";
      process.env.PII_TABLE_NAME = "Pii";
      process.env.PII_PARTITION_KEY = "userId";
      jest.resetModules();
      handler = require("../handlers/userMatcher").handler;
      const extra: Partial<RouteOptions> = {
        sponsors: { [HOUSE]: ["H000001"], [SENATE]: ["S000001"] },
        subCategories: { [HOUSE]: [], [SENATE]: [] },
        preferences: [{ userId: "follows-senator", value: "S000001", type: "Congress Member" }],
        activeUsers: ["follows-senator", "someone-else"],
      };

      // H.R. 1285's "new" goes out while it is not a priority bill: it matches nobody.
      pairRoute({ [HOUSE]: "2026-09-01T00:00:00.000Z" }, { ...extra, held: [HOUSE] });
      await sendNew(HOUSE);
      // It is then picked as a priority bill, and S. 570's "new" arrives in that window.
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-03T00:00:00.000Z" },
        { ...extra, priorityGuids: [HOUSE] },
      );
      await sendNew(SENATE);

      expect(pendingRows()).toEqual([{ userId: "follows-senator", sourceBillId: SENATE, notificationType: "new" }]);
      expect(suppressedMetricLines()).toHaveLength(0);
    });

    it("does not take a marker another member's deferral left for proof that the partner's 'new' reached the user", async () => {
      // H.R. 1285 (Healthcare) defers to the older S. 570 (Energy), whose own "new" reaches nobody:
      // topic-user gets H.R. 1285's "new", and that write leaves S. 570's marker for them.
      const senateOnEnergy = { subCategories: { [SENATE]: ["Energy"] } };
      pairRoute(
        { [HOUSE]: "2026-09-02T00:00:00.000Z", [SENATE]: "2026-09-01T00:00:00.000Z" },
        { declarations: { [HOUSE]: [SENATE] }, ...senateOnEnergy },
      );
      await sendNew(SENATE);
      await sendNew(HOUSE);
      const senateMarkerKey = `__dedupe__|topic-user||${SENATE}||new||${firstRevision(SENATE)}`;
      expect(markers.get(senateMarkerKey)?.reachedByBillId).toEqual({ S: HOUSE });

      // Within the markers' 3 days H.R. 1285 drops the link and H.R. 77 declares S. 570: the pair is now
      // (H.R. 77, S. 570), and H.R. 77 (whose claim is its own) defers to S. 570 too.
      pairRoute(
        {
          [HOUSE]: "2026-09-02T00:00:00.000Z",
          [SENATE]: "2026-09-01T00:00:00.000Z",
          [OTHER]: "2026-09-03T00:00:00.000Z",
        },
        {
          groups: { enabled: true, pairs: [[OTHER, SENATE]] },
          declarations: { [OTHER]: [SENATE] },
          held: [HOUSE, SENATE, OTHER],
          ...senateOnEnergy,
        },
      );
      await sendNew(OTHER);

      // S. 570's "new" never reached topic-user, so H.R. 77's does, as it would with the groups off.
      expect(pendingRows()).toEqual([
        { userId: "topic-user", sourceBillId: HOUSE, notificationType: "new" },
        { userId: "topic-user", sourceBillId: OTHER, notificationType: "new" },
      ]);
      expect(suppressedMetricLines()).toHaveLength(0);
      // The marker now names H.R. 77, so S. 570's own "new", if still in flight, skips the user.
      expect(markers.get(senateMarkerKey)?.reachedByBillId).toEqual({ S: OTHER });
    });

    it("checks the marker of the revision the partner's 'new' was sent with: its first stored version", async () => {
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-02T00:00:00.000Z" },
        { versions: { [HOUSE]: ["v3-house", "v2-house", firstRevision(HOUSE)] } },
      );

      await sendNew(HOUSE);
      await sendNew(SENATE);

      expect(pendingRows()).toEqual([{ userId: "topic-user", sourceBillId: HOUSE, notificationType: "new" }]);
      expect(companionMarkerPuts()[0].Item.billId).toEqual({
        S: `topic-user||${HOUSE}||new||${firstRevision(HOUSE)}`,
      });
    });

    it("sends in full, without claiming, when the partner's first stored version is unknown", async () => {
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-02T00:00:00.000Z" },
        { versions: { [HOUSE]: ["null"] } },
      );

      await sendNew(HOUSE);
      await sendNew(SENATE);

      expect(pendingRows().map((row) => row.sourceBillId)).toEqual([HOUSE, SENATE]);
      expect(companionMarkerPuts()).toHaveLength(0);
      expect(claims.size).toBe(0);
      expect(logLines(console.warn).map((line) => line.message)).toContain(
        "Companion bill's new revision is unknown; sending the new notification in full",
      );
    });

    it("hands the partner's 'new' to notificationFanout with the users", async () => {
      process.env.NOTIFICATION_FANOUT_QUEUE_URL =
        "https://sqs.us-east-1.amazonaws.com/123456789012/notificationFanoutQueue";
      jest.resetModules();
      handler = require("../handlers/userMatcher").handler;
      mockSQSSend.mockResolvedValue({ Failed: [] });
      pairRoute({ [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-02T00:00:00.000Z" });

      await sendNew(SENATE);

      const bodies = mockSQSSend.mock.calls.flatMap(([cmd]) =>
        cmd.input.Entries.map((entry: { MessageBody: string }) => JSON.parse(entry.MessageBody)),
      );
      expect(bodies).toEqual([
        expect.objectContaining({
          billId: SENATE,
          notificationType: "new",
          userIds: ["topic-user"],
          companionNew: { billId: HOUSE, sourceRevision: firstRevision(HOUSE) },
        }),
      ]);
    });

    it("never defers both members when the earlier one is stored again before its own 'new' is handled", async () => {
      // S's "new" is handled first, while H's manifest row is older: S defers to H, whose "new" has
      // reached nobody yet, so S reaches topic-user and leaves H's marker for them.
      pairRoute({ [HOUSE]: "2026-09-01T10:00:00.000Z", [SENATE]: "2026-09-01T10:00:05.000Z" });
      await sendNew(SENATE);
      expect(pendingRows()).toEqual([{ userId: "topic-user", sourceBillId: SENATE, notificationType: "new" }]);

      // H is stored again (its updatedAt moves) before its own "new" is handled, late or on a retry.
      pairRoute({ [HOUSE]: "2026-09-01T10:03:00.000Z", [SENATE]: "2026-09-01T10:00:05.000Z" });
      await sendNew(HOUSE);

      expect(pendingRows()).toEqual([{ userId: "topic-user", sourceBillId: SENATE, notificationType: "new" }]);
      expect(logLines(console.log).map((line) => line.message)).toContain(
        "Sending new notification in full; its companion bill already deferred to it",
      );
    });

    it("keeps deferring on a redelivery of the member that deferred", async () => {
      pairRoute({ [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-02T00:00:00.000Z" });

      await sendNew(HOUSE);
      await sendNew(SENATE);
      await sendNew(SENATE);

      expect(pendingRows()).toEqual([{ userId: "topic-user", sourceBillId: HOUSE, notificationType: "new" }]);
      expect(companionMarkerPuts()).toHaveLength(2);
      expect(suppressedMetricLines()).toHaveLength(2);
    });

    it("defers the Senate member on an exact tie", async () => {
      pairRoute({ [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-01T00:00:00.000Z" });

      await sendNew(HOUSE);
      await sendNew(SENATE);

      expect(pendingRows()).toEqual([{ userId: "topic-user", sourceBillId: HOUSE, notificationType: "new" }]);
      expect(suppressedMetricLines()).toHaveLength(1);
      expect([...claims.values()].map((claim) => claim.deferredGuid.S)).toEqual([SENATE]);
    });

    it("pairs fresh from the link lists, even before the published groups list the pair", async () => {
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-03T00:00:00.000Z" },
        { groups: { enabled: true, pairs: [] } },
      );

      await sendNew(HOUSE);
      await sendNew(SENATE);

      expect(pendingRows()).toEqual([{ userId: "topic-user", sourceBillId: HOUSE, notificationType: "new" }]);
      expect(suppressedMetricLines()).toHaveLength(1);
    });

    it("sends both while the published groups are turned off, without reading the link lists", async () => {
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-03T00:00:00.000Z" },
        { groups: { enabled: false, pairs: [] } },
      );

      await sendNew(SENATE);
      await sendNew(HOUSE);

      expect(pendingRows().map((row) => row.sourceBillId)).toEqual([SENATE, HOUSE]);
      expect(declarationQueries()).toHaveLength(0);
      expect(suppressedMetricLines()).toHaveLength(0);
    });

    it("sends an ungrouped bill, a pair whose partner is not held, and a hub member", async () => {
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-03T00:00:00.000Z" },
        {
          declarations: { [SENATE]: [HOUSE], "BILLS-119s900": [OTHER], "BILLS-119s901": [OTHER] },
          held: [SENATE, OTHER, "BILLS-119s900", "BILLS-119s901"],
        },
      );

      await sendNew(SENATE); // HOUSE is not held
      await sendNew(OTHER); // two Senate bills list it

      expect(pendingRows().map((row) => row.sourceBillId)).toEqual([SENATE, OTHER]);
      expect(suppressedMetricLines()).toHaveLength(0);
    });

    it("sends the notification when the companion cannot be resolved", async () => {
      pairRoute(
        { [HOUSE]: "2026-09-01T00:00:00.000Z", [SENATE]: "2026-09-03T00:00:00.000Z" },
        { failDeclarations: true },
      );

      await sendNew(SENATE);

      expect(pendingRows().map((row) => row.sourceBillId)).toEqual([SENATE]);
      expect(logLines(console.warn).map((line) => line.message)).toContain(
        "Could not resolve the bill's companion; sending its new notification",
      );
    });

    it("sends the notification when a member's manifest time is unknown", async () => {
      pairRoute({ [SENATE]: "2026-09-03T00:00:00.000Z" });

      await sendNew(SENATE);

      expect(pendingRows().map((row) => row.sourceBillId)).toEqual([SENATE]);
    });
  });
});

describe("userMatcher renamed labels (LLM-10, decision 1B)", () => {
  const GUID = "BILLS-119hr950is";
  const document = (subCategories: string[]) => ({
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-10-01T00:00:00.000Z",
    identifier: { congress: "119", billType: "house-bill", billNumber: "950" },
    guid: GUID,
    title: "A Labelled Bill",
    link: "https://example.com/bill",
    soWhat: "",
    billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
    bodyText: "",
    billXml: "",
    actions: [],
    committees: [],
    subCategories,
    lifeAreas: [],
    sponsors: [],
    cosponsors: [],
  });

  type Follow = { userId: string; value: string };

  /** Serves the processed bill (or `stored` as given) and the UserPreferences rows: every follow is a Category row. */
  const route = (subCategories: string[], follows: Follow[], stored: unknown = document(subCategories)) => {
    mockS3Send.mockImplementation(async (cmd: { input: { Key?: string; Prefix?: string } }) => {
      if (cmd.input.Key !== "processed-bills/BILLS-119hr950.json") {
        throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      }
      return { Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(stored)) } };
    });
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      const input = cmd.input ?? {};
      if (input.TransactItems) return {};
      if (input.RequestItems?.UserPreferences) {
        const keys = input.RequestItems.UserPreferences.Keys;
        return {
          Responses: {
            UserPreferences: keys.flatMap((key) => {
              const [value] = Object.entries(key).filter(([name]) => name !== "userId");
              const found = follows.some((f) => f.userId === key.userId.S && f.value === value?.[1].S);
              return found ? [{ ...key, type: { S: "Category" } }] : [];
            }),
          },
        };
      }
      const sub = input.ExpressionAttributeValues?.[":sub"]?.S;
      if (sub) return { Items: follows.filter((f) => f.value === sub).map((f) => ({ userId: { S: f.userId } })) };
      return { Items: [] };
    });
  };

  const sendNew = () => handler(buildEventFromBodies([{ domain: "bill", objectId: GUID, notificationType: "new" }]));
  const subCategoryLookups = () =>
    mockDynamoSend.mock.calls
      .map(([cmd]) => cmd.input?.ExpressionAttributeValues?.[":sub"]?.S)
      .filter((value): value is string => typeof value === "string");
  const rows = () =>
    pendingNotificationWriteInputs().map((item) => ({ userId: item.userId.S, category: item.category.S }));
  const matchedLine = () =>
    logLines(console.log).find((line) => line.message === "Matched users for category") ?? ({} as LogLine);

  const followers: Follow[] = [
    { userId: "follows-new", value: "Civil Rights and Liberties" },
    { userId: "follows-both", value: "Civil Rights and Liberties" },
    { userId: "follows-both", value: "Social Justice" },
    { userId: "follows-old", value: "Social Justice" },
  ];

  it("matches a bill still carrying a legacy name under its new name and the old one, each user once", async () => {
    route(["Social Justice"], followers);

    const result = await sendNew();

    expect(result.batchItemFailures).toEqual([]);
    expect(subCategoryLookups()).toEqual(["Civil Rights and Liberties", "Social Justice"]);
    expect(rows()).toEqual([
      { userId: "follows-new", category: "Social Policy" },
      { userId: "follows-both", category: "Social Policy" },
      { userId: "follows-old", category: "Social Policy" },
    ]);
    expect(matchedLine()).toMatchObject({
      subCategory: "Civil Rights and Liberties",
      followedNames: ["Civil Rights and Liberties", "Social Justice"],
      userCount: 3,
    });
  });

  it("reaches a follow the relabel script has not moved yet on a relabelled bill", async () => {
    route(["Civil Rights and Liberties"], [{ userId: "follows-old", value: "Social Justice" }]);

    await sendNew();

    expect(subCategoryLookups()).toEqual(["Civil Rights and Liberties", "Social Justice"]);
    expect(rows()).toEqual([{ userId: "follows-old", category: "Social Policy" }]);
  });

  it("does the same for Heritage and Identity, under Cultural and Ethical Issues", async () => {
    route(
      ["Identity Politics"],
      [
        { userId: "follows-old", value: "Identity Politics" },
        { userId: "follows-new", value: "Heritage and Identity" },
      ],
    );

    await sendNew();

    expect(subCategoryLookups()).toEqual(["Heritage and Identity", "Identity Politics"]);
    expect(rows()).toEqual([
      { userId: "follows-new", category: "Cultural and Ethical Issues" },
      { userId: "follows-old", category: "Cultural and Ethical Issues" },
    ]);
  });

  it("treats a bill carrying both spellings as one label", async () => {
    route(["Social Justice", "Civil Rights and Liberties", "Healthcare"], followers);

    await sendNew();

    expect(subCategoryLookups()).toEqual(["Civil Rights and Liberties", "Social Justice", "Healthcare"]);
    expect(rows().map((row) => row.userId)).toEqual(["follows-new", "follows-both", "follows-old"]);
  });

  it("looks up a label that was not renamed once, as before", async () => {
    route(["Healthcare"], [{ userId: "follows-health", value: "Healthcare" }]);

    await sendNew();

    expect(subCategoryLookups()).toEqual(["Healthcare"]);
    expect(rows()).toEqual([{ userId: "follows-health", category: "Social Policy" }]);
    expect(matchedLine()).not.toHaveProperty("followedNames");
  });

  it("reads legacy names from an older payload's categories list once each, under their current names", async () => {
    // No schemaVersion: matched as a plain payload, whose {category, subCategory} entries are also taken as given.
    const { schemaVersion: _schemaVersion, ...payload } = document([]);
    route([], followers, {
      ...payload,
      categories: [
        "Identity Politics",
        { subCategory: "Not A Label" },
        { label: "Social Justice" },
        { category: "Social Policy", subCategory: "Social Justice" },
      ],
    });

    await sendNew();

    expect(subCategoryLookups()).toEqual([
      "Heritage and Identity",
      "Identity Politics",
      "Civil Rights and Liberties",
      "Social Justice",
    ]);
    expect(rows().map((row) => row.userId)).toEqual(["follows-new", "follows-both", "follows-old"]);
  });

  it("still ignores a label that is neither a current nor a legacy name", async () => {
    route(["Crime and Law Enforcement", "social justice"], [{ userId: "u", value: "Crime and Law Enforcement" }]);

    await sendNew();

    expect(subCategoryLookups()).toEqual([]);
    expect(rows()).toEqual([]);
  });
});
