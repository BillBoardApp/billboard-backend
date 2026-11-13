import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { dispatchShardPartitionValue } from "../shared/dispatchShards";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

type Item = Record<string, AttributeValue>;

/** The DynamoDB input fields the fakes and assertions read, across the commands UserNotifier sends. */
interface FakeDynamoInput {
  TableName?: string;
  KeyConditionExpression?: string;
  ConditionExpression?: string;
  UpdateExpression?: string;
  Key?: Item;
  ExpressionAttributeValues?: Item;
  RequestItems?: { PendingBillNotifications: Array<{ DeleteRequest: { Key: Item } }> };
}

/** What the mocked command constructors return: the command's input. */
interface FakeDynamoCommand {
  input: FakeDynamoInput;
}
interface FakeSnsCommand {
  input: { TargetArn?: string; Message?: string };
}

const originalEnv = { ...process.env };

const mockDynamoSend = jest.fn();
const mockSnsSend = jest.fn();
// The consistent marker reads userNotifier makes before each pending-row query go here, so the call
// sequences below stay about queries and deletes. By default every marker exists with version "v-read".
const mockMarkerRead = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({
    send: (cmd: { __getItem?: boolean }) => (cmd.__getItem ? mockMarkerRead(cmd) : mockDynamoSend(cmd)),
  })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input, __getItem: true })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
  UpdateItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  BatchWriteItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteItemCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sns", () => ({
  SNSClient: jest.fn(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type Handler = (event: SQSEvent) => Promise<SQSBatchResponse>;
let handler: Handler;

// The bill's own failure, as notificationType has found it since REL-50 (and stored on the row since S4).
const FAILED_ACTION_ATTRIBUTES = {
  actionText: { S: "Failed of passage/not agreed to in House: On passage Failed by the Yeas and Nays: 190 - 228." },
  actionDate: { S: `${new Date().getUTCFullYear()}-10-27` },
  actionCode: { S: "9000" },
  actionType: { S: "Floor" },
};

// The shard partition value the dispatcher and writers use for a user (DISPATCH_SHARD_COUNT defaults to 8).
const shardOf = (userId: string): string => dispatchShardPartitionValue("__dispatch__", userId, 8);

// A dispatcher message that names each user's marker partition, as the sharded dispatcher sends it.
const hinted = (userIds: string[]) => ({
  userIds,
  dispatchPartitions: Object.fromEntries(userIds.map((userId) => [userId, [shardOf(userId)]])),
});
let restoreEnv: (() => void) | undefined;

const buildSqsEvent = (payloads: Record<string, unknown>[]): SQSEvent => ({
  Records: payloads.map((payload, idx) => ({
    messageId: `msg-${idx}`,
    receiptHandle: `receipt-${idx}`,
    body: JSON.stringify(payload),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: `${Date.now()}`,
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: `${Date.now()}`,
    },
    messageAttributes: {},
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:userNotifier",
    awsRegion: "us-east-1",
  })),
});

beforeEach(() => {
  jest.resetModules();
  mockDynamoSend.mockReset();
  mockSnsSend.mockReset();
  mockMarkerRead.mockReset();
  mockMarkerRead.mockImplementation(async (cmd: FakeDynamoCommand) => ({
    Item: { billId: cmd.input.Key!.billId, markerVersion: { S: "v-read" } },
  }));

  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      PENDING_NOTIFICATIONS_TABLE: "PendingBillNotifications",
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
      DEVICE_TABLE: "UserDevices",
      USER_ID_ATTRIBUTE: "user_id",
      DEVICE_ID_ATTRIBUTE: "device_id",
      ENDPOINT_ARN_ATTRIBUTE: "endpointArn",
    },
    { replace: true, base: originalEnv },
  );

  const mod = require("../handlers/userNotifier");
  handler = mod.handler;
});

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("userNotifier handler", () => {
  it("processes batch of userIds and sends an updated row on its own push next to the others (S5)", async () => {
    // Mock pending notifications query for user-1 (2 bills)
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr100is#new" },
            sourceBillId: { S: "BILLS-119hr100is" },
            billTitle: { S: "Healthcare Act" },
            category: { S: "Social Policy" },
            lifeArea: { S: "Taxes" },
            notificationType: { S: "new" },
          },
          {
            billId: { S: "BILLS-119hr200is#updated" },
            sourceBillId: { S: "BILLS-119hr200is" },
            billTitle: { S: "Defense Bill" },
            category: { S: "Defense" },
            lifeArea: { S: "" },
            notificationType: { S: "updated" },
          },
        ],
      })
      // Mock devices query for user-1
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            platform: { S: "ios" },
            push_token: { S: "token-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          },
        ],
      })
      // Mock BatchWriteItem for deletions
      .mockResolvedValueOnce({});

    const event = buildSqsEvent([hinted(["user-1"])]);

    await handler(event);

    // 1 Query for pending notifications + 1 Query for devices + 1 BatchWriteItem + 2 DeleteItem calls = 5
    expect(mockDynamoSend).toHaveBeenCalledTimes(5);

    // Check pending notifications query
    const pendingQuery = mockDynamoSend.mock.calls[0][0].input;
    expect(pendingQuery.TableName).toBe("PendingBillNotifications");
    expect(pendingQuery.ExpressionAttributeNames["#pk"]).toBe("userId");
    expect(pendingQuery.ExpressionAttributeValues[":userId"].S).toBe("user-1");

    // The new bill's push, then the updated bill's own push, so the app asks to vote again on it.
    expect(mockSnsSend).toHaveBeenCalledTimes(2);
    const [first, second] = mockSnsSend.mock.calls.map(([cmd]) => JSON.parse(JSON.parse(cmd.input.Message).APNS));
    expect(first.aps.alert).toEqual({ title: "New: Healthcare Act", body: "A new bill matched your interests." });
    expect(first.aps["thread-id"]).toBe("bill-digest");
    expect(first.billIds).toEqual(["BILLS-119hr100is"]);
    expect(first.notificationType).toBe("new");
    expect(second.aps.alert).toEqual({ title: "Updated: Defense Bill", body: "Open Billboard to see what changed." });
    expect(second.billIds).toEqual(["BILLS-119hr200is"]);
    expect(second.notificationType).toBe("updated");
  });

  it("uses example-based copy when multiple bills share the same type", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr301is#new" },
            sourceBillId: { S: "BILLS-119hr301is" },
            billTitle: { S: "Lower Drug Costs" },
            category: { S: "Healthcare" },
            lifeArea: { S: "" },
            notificationType: { S: "new" },
          },
          {
            billId: { S: "BILLS-119hr302is#new" },
            sourceBillId: { S: "BILLS-119hr302is" },
            billTitle: { S: "Veterans Housing" },
            category: { S: "Housing" },
            lifeArea: { S: "" },
            notificationType: { S: "new" },
          },
          {
            billId: { S: "BILLS-119hr303is#new" },
            sourceBillId: { S: "BILLS-119hr303is" },
            billTitle: { S: "Child Care Support" },
            category: { S: "Families" },
            lifeArea: { S: "" },
            notificationType: { S: "new" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            platform: { S: "ios" },
            push_token: { S: "token-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          },
        ],
      })
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    const apns = JSON.parse(msg.APNS);
    expect(apns.aps.alert.title).toBe("3 New Bills for You");
    expect(apns.aps.alert.body).toContain("Lower Drug Costs");
    expect(apns.aps.alert.body).toContain("Veterans Housing");
    // S5: rows of one type keep it.
    expect(apns.notificationType).toBe("new");
  });

  it("sends single bill notification when user has only one pending bill (a row without its action)", async () => {
    // Mock pending notifications query for user-1 (1 bill)
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr900is#alert" },
            sourceBillId: { S: "BILLS-119hr900is" },
            billTitle: { S: "Alert Bill" },
            category: { S: "Bill Alert" },
            lifeArea: { S: "" },
            notificationType: { S: "alert" },
          },
        ],
      })
      // Mock devices query for user-1
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            platform: { S: "ios" },
            push_token: { S: "token-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          },
        ],
      })
      // Mock BatchWriteItem for deletions
      .mockResolvedValueOnce({});

    const event = buildSqsEvent([
      {
        userIds: ["user-1"],
      },
    ]);

    await handler(event);

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    const apns = JSON.parse(msg.APNS);
    expect(apns.aps.alert.title).toBe("Action: Alert Bill");
    // A row written before S4 names no action.
    expect(apns.aps.alert.body).toBe("Congress updated this bill's record.");
    expect(apns.aps["thread-id"]).toBe("bill-digest");
    expect(apns.billId).toBe("BILLS-119hr900is");
    expect(apns.billIds).toEqual(["BILLS-119hr900is"]);
    expect(apns.notificationType).toBe("alert");
  });

  it("sends correct body text for single 'passed' notification", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr500is#passed" },
            sourceBillId: { S: "BILLS-119hr500is" },
            billTitle: { S: "Passed Bill" },
            category: { S: "Social Policy" },
            lifeArea: { S: "" },
            notificationType: { S: "passed" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            platform: { S: "ios" },
            push_token: { S: "token-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          },
        ],
      })
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    const apns = JSON.parse(msg.APNS);
    expect(apns.aps.alert.title).toBe("Passed: Passed Bill");
    // A row written before S4 names no action; it no longer claims the reader watches the bill.
    expect(apns.aps.alert.body).toBe("It passed a vote in Congress.");
    expect(apns.notificationType).toBe("passed");
  });

  it("sends correct body text for single 'failed' notification", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr501is#failed" },
            sourceBillId: { S: "BILLS-119hr501is" },
            billTitle: { S: "Failed Bill" },
            category: { S: "Social Policy" },
            lifeArea: { S: "" },
            notificationType: { S: "failed" },
            ...FAILED_ACTION_ATTRIBUTES,
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            platform: { S: "ios" },
            push_token: { S: "token-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          },
        ],
      })
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    const apns = JSON.parse(msg.APNS);
    expect(apns.aps.alert.title).toBe("Failed: Failed Bill");
    expect(apns.aps.alert.body).toMatch(/^Failed in the House · Oct 27(, 2026)?$/);
    expect(apns.notificationType).toBe("failed");
  });

  describe("REL-50: a failed row whose action is not the bill's own failure", () => {
    const deviceItems = {
      Items: [
        {
          device_id: { S: "device-1" },
          platform: { S: "ios" },
          push_token: { S: "token-1" },
          endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
        },
      ],
    };
    const failedRow = (billId: string, action: Record<string, { S: string }>) => ({
      billId: { S: `${billId}#failed` },
      sourceBillId: { S: billId },
      billTitle: { S: `Bill ${billId}` },
      category: { S: "Social Policy" },
      lifeArea: { S: "" },
      notificationType: { S: "failed" },
      ...action,
    });
    const deletes = () =>
      mockDynamoSend.mock.calls
        .map(([cmd]: [FakeDynamoCommand]) => cmd.input)
        .filter((input) => input.RequestItems)
        .map((input) => input.RequestItems!.PendingBillNotifications.map((request) => request.DeleteRequest.Key));

    it.each<[string, Record<string, { S: string }>, string]>([
      [
        "an amendment line the old text rule matched",
        { actionText: { S: "Amendment SA 2205 not agreed to in Senate by Yea-Nay Vote. 45 - 53." } },
        "amendment",
      ],
      [
        "a motion to proceed",
        { actionText: { S: "Motion to proceed to consideration of measure not agreed to in Senate." } },
        "motion",
      ],
      [
        "a failed suspension vote",
        {
          actionText: {
            S: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
          },
          actionCode: { S: "9000" },
        },
        "suspension",
      ],
      [
        "a failed Senate vote under a 60-vote order",
        {
          actionText: {
            S: "Failed of passage/not agreed to in Senate: Under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48.",
          },
          actionCode: { S: "18000" },
        },
        "sixtyVotes",
      ],
      [
        "the Senate's own line of a failure, without its code (the coded line sends failed when it comes)",
        { actionText: { S: "Failed of passage in Senate by Yea-Nay Vote. 45 - 55. Record Vote Number: 99." } },
        "uncoded",
      ],
      ["a row written before S4, which names no action", {}, "noAction"],
    ])("deletes %s unsent, and logs why", async (_name, action, reason) => {
      mockDynamoSend.mockResolvedValueOnce({ Items: [failedRow("BILLS-119s100", action)] }).mockResolvedValueOnce({});

      expect(await handler(buildSqsEvent([{ userIds: ["user-1"] }]))).toEqual({ batchItemFailures: [] });

      expect(mockSnsSend).not.toHaveBeenCalled();
      expect(deletes()).toEqual([[{ userId: { S: "user-1" }, billId: { S: "BILLS-119s100#failed" } }]]);
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Bill notification outcome",
          guid: "BILLS-119s100",
          outcome: "not_a_failure",
          notificationType: "failed",
          reason,
        }),
      );
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({ _aws: expect.anything(), FailurePushesDropped: 1 }),
      );
    });

    it("sends the user's other rows, and the bill's own failure, on the same run", async () => {
      mockDynamoSend
        .mockResolvedValueOnce({
          Items: [
            failedRow("BILLS-119s100", { actionText: { S: "Amendment SA 2205 not agreed to in Senate." } }),
            failedRow("BILLS-119hr501is", FAILED_ACTION_ATTRIBUTES),
            {
              billId: { S: "BILLS-119s100#alert" },
              sourceBillId: { S: "BILLS-119s100" },
              billTitle: { S: "Bill BILLS-119s100" },
              category: { S: "Bill Alert" },
              lifeArea: { S: "" },
              notificationType: { S: "alert" },
              actionText: { S: "Amendment SA 2205 not agreed to in Senate." },
            },
          ],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(deviceItems)
        .mockResolvedValueOnce({});

      expect(await handler(buildSqsEvent([{ userIds: ["user-1"] }]))).toEqual({ batchItemFailures: [] });

      expect(deletes()).toEqual([
        [{ userId: { S: "user-1" }, billId: { S: "BILLS-119s100#failed" } }],
        [
          { userId: { S: "user-1" }, billId: { S: "BILLS-119hr501is#failed" } },
          { userId: { S: "user-1" }, billId: { S: "BILLS-119s100#alert" } },
        ],
      ]);
      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      const apns = JSON.parse(JSON.parse(mockSnsSend.mock.calls[0][0].input.Message).APNS);
      expect(apns.notificationType).toBe("digest");
      expect(apns.aps.alert.body).toBe("1 action, 1 failed");
    });
  });

  it("includes passed count in digest summary", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr500is#passed" },
            sourceBillId: { S: "BILLS-119hr500is" },
            billTitle: { S: "Passed Bill" },
            category: { S: "Social Policy" },
            lifeArea: { S: "" },
            notificationType: { S: "passed" },
          },
          {
            billId: { S: "BILLS-119hr100is#new" },
            sourceBillId: { S: "BILLS-119hr100is" },
            billTitle: { S: "New Bill" },
            category: { S: "Social Policy" },
            lifeArea: { S: "Taxes" },
            notificationType: { S: "new" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            platform: { S: "ios" },
            push_token: { S: "token-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          },
        ],
      })
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    const apns = JSON.parse(msg.APNS);
    expect(apns.aps.alert.title).toBe("2 Bill Updates");
    expect(apns.aps.alert.body).toContain("1 new");
    expect(apns.aps.alert.body).toContain("1 passed");
  });

  it("includes failed count in digest summary", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr501is#failed" },
            sourceBillId: { S: "BILLS-119hr501is" },
            billTitle: { S: "Failed Bill" },
            category: { S: "Social Policy" },
            lifeArea: { S: "" },
            notificationType: { S: "failed" },
            ...FAILED_ACTION_ATTRIBUTES,
          },
          {
            billId: { S: "BILLS-119hr100is#new" },
            sourceBillId: { S: "BILLS-119hr100is" },
            billTitle: { S: "New Bill" },
            category: { S: "Social Policy" },
            lifeArea: { S: "Taxes" },
            notificationType: { S: "new" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            platform: { S: "ios" },
            push_token: { S: "token-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          },
        ],
      })
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    const apns = JSON.parse(msg.APNS);
    expect(apns.aps.alert.title).toBe("2 Bill Updates");
    expect(apns.aps.alert.body).toContain("1 new");
    expect(apns.aps.alert.body).toContain("1 failed");
  });

  it("skips notifications when no devices are found", async () => {
    // Mock pending notifications query returns bills
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr101is#updated" },
            sourceBillId: { S: "BILLS-119hr101is" },
            billTitle: { S: "Another Act" },
            category: { S: "Governance" },
            lifeArea: { S: "" },
            notificationType: { S: "updated" },
          },
        ],
      })
      // Mock devices query returns no devices
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const event = buildSqsEvent([
      {
        userIds: ["user-1"],
      },
    ]);

    await handler(event);

    expect(mockSnsSend).not.toHaveBeenCalled();
    // No dispatchPartitions (an older dispatcher): marker and claim deleted in the shard and the legacy partition.
    expect(mockDynamoSend).toHaveBeenCalledTimes(7);

    const deleteBatch = mockDynamoSend.mock.calls[2][0].input;
    expect(deleteBatch.RequestItems.PendingBillNotifications).toHaveLength(1);

    const deleteKeys = mockDynamoSend.mock.calls.slice(3).map((call) => call[0].input.Key);
    expect(deleteKeys).toEqual([
      { userId: { S: shardOf("user-1") }, billId: { S: "user-1" } },
      { userId: { S: "__dispatch__" }, billId: { S: "user-1" } },
      { userId: { S: shardOf("user-1") }, billId: { S: "__claim__#user-1" } },
      { userId: { S: "__dispatch__" }, billId: { S: "__claim__#user-1" } },
    ]);
  });

  it("ignores malformed records", async () => {
    const event = buildSqsEvent([{ some: "thing" }, { userIds: [] }, { userIds: [""] }]);

    const result = await handler(event);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it("filters notifications by device-level type settings", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr100is#new" },
            sourceBillId: { S: "BILLS-119hr100is" },
            billTitle: { S: "New Bill" },
            category: { S: "Social Policy" },
            lifeArea: { S: "" },
            notificationType: { S: "new" },
          },
          {
            billId: { S: "BILLS-119hr200is#alert" },
            sourceBillId: { S: "BILLS-119hr200is" },
            billTitle: { S: "Alert Bill" },
            category: { S: "Bill Alert" },
            lifeArea: { S: "" },
            notificationType: { S: "alert" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
            notificationsEnabled: { BOOL: true },
            notifyNew: { BOOL: false },
            notifyUpdated: { BOOL: true },
            notifyAlert: { BOOL: true },
            notifyPassed: { BOOL: true },
          },
          {
            device_id: { S: "device-2" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-2" },
            notificationsEnabled: { BOOL: false },
            notifyNew: { BOOL: true },
            notifyUpdated: { BOOL: true },
            notifyAlert: { BOOL: true },
            notifyPassed: { BOOL: true },
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    const apns = JSON.parse(msg.APNS);
    expect(apns.aps.alert.title).toBe("Action: Alert Bill");
    expect(apns.billId).toBe("BILLS-119hr200is");
    expect(apns.notificationType).toBe("alert");
  });

  it("suppresses failed notifications when notifyFailed is disabled for the device", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr501is#failed" },
            sourceBillId: { S: "BILLS-119hr501is" },
            billTitle: { S: "Failed Bill" },
            category: { S: "Social Policy" },
            lifeArea: { S: "" },
            notificationType: { S: "failed" },
            ...FAILED_ACTION_ATTRIBUTES,
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
            notificationsEnabled: { BOOL: true },
            notifyNew: { BOOL: true },
            notifyUpdated: { BOOL: true },
            notifyAlert: { BOOL: true },
            notifyPassed: { BOOL: true },
            notifyFailed: { BOOL: false },
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));

    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  // F1: both apps ask to vote again only on the ids a push lists, and every row is deleted once it is sent.
  it("lists every bill on an updated push of many bills, under the payload size limit", async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      billId: { S: `BILLS-119hr${1000 + index}is#updated` },
      sourceBillId: { S: `BILLS-119hr${1000 + index}is` },
      billTitle: {
        S: `A Very Long Bill Title ${index} `.repeat(10).trim(),
      },
      category: {
        S: `Long Category Name ${index} `.repeat(6).trim(),
      },
      lifeArea: { S: "" },
      notificationType: { S: "updated" },
    }));

    mockDynamoSend
      .mockResolvedValueOnce({ Items: items })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    expect(Buffer.byteLength(msg.APNS, "utf8")).toBeLessThanOrEqual(3500);

    const apns = JSON.parse(msg.APNS);
    expect(apns.notificationType).toBe("updated");
    expect(apns.domain).toBe("bill");
    expect(apns.billCount).toBe(40);
    expect(apns.billIds).toEqual(items.map((item) => item.sourceBillId.S));
    expect(apns.aps.alert.title).toBe("40 Bills Changed");
  });

  it("skips publishing when master notification toggle is disabled", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr777is#updated" },
            sourceBillId: { S: "BILLS-119hr777is" },
            billTitle: { S: "Suppressed Bill" },
            category: { S: "Defense" },
            lifeArea: { S: "" },
            notificationType: { S: "updated" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            device_id: { S: "device-1" },
            endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
            notificationsEnabled: { BOOL: false },
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await handler(buildSqsEvent([hinted(["user-1"])]));

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).toHaveBeenCalledTimes(5);
  });
});

describe("userNotifier delivery bookkeeping", () => {
  const endpointArn = (deviceId: string) => `arn:aws:sns:us-east-1:123:endpoint/APNS/app/${deviceId}`;
  const pendingItem = (billNumber: number, type = "updated") => ({
    billId: { S: `BILLS-119hr${billNumber}is#${type}` },
    sourceBillId: { S: `BILLS-119hr${billNumber}is` },
    billTitle: { S: `Bill ${billNumber}` },
    category: { S: "Defense" },
    lifeArea: { S: "" },
    notificationType: { S: type },
  });
  const device = (deviceId: string) => ({ device_id: { S: deviceId }, endpointArn: { S: endpointArn(deviceId) } });

  type World = {
    pending: Record<string, unknown[]>;
    devices: Record<string, unknown[]>;
    publishErrors?: Record<string, Error>;
    markerConditionFails?: boolean;
    slowEndpointCleanup?: boolean;
  };

  // Routes every AWS call by its input and records the order of side effects.
  const setUpWorld = (world: World): string[] => {
    const events: string[] = [];
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      const input = cmd.input;
      if (input.TableName === "PendingBillNotifications" && input.KeyConditionExpression) {
        const userId = input.ExpressionAttributeValues![":userId"].S!;
        events.push(`query:${userId}`);
        return { Items: world.pending[userId] ?? [] };
      }
      if (input.TableName === "UserDevices" && input.KeyConditionExpression) {
        return { Items: world.devices[input.ExpressionAttributeValues![":userValue"].S!] ?? [] };
      }
      if (input.RequestItems) {
        const requests = input.RequestItems.PendingBillNotifications;
        events.push(`deleteRows:${requests[0].DeleteRequest.Key.userId.S}`);
        return {};
      }
      if (input.UpdateExpression) {
        if (world.slowEndpointCleanup) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        events.push(`removeEndpoint:${input.Key!.device_id.S}`);
        return {};
      }
      if (input.TableName === "PendingBillNotifications" && input.Key) {
        const sortKey = input.Key!.billId.S!;
        if (sortKey.startsWith("__claim__#")) {
          events.push(`deleteClaim:${sortKey.slice("__claim__#".length)}`);
          return {};
        }
        events.push(`deleteMarker:${sortKey}`);
        if (world.markerConditionFails) {
          throw Object.assign(new Error("The conditional request failed"), {
            name: "ConditionalCheckFailedException",
          });
        }
        return {};
      }
      throw new Error(`Unexpected DynamoDB call: ${JSON.stringify(input)}`);
    });
    mockSnsSend.mockImplementation(async (cmd: FakeSnsCommand) => {
      const target = cmd.input.TargetArn!;
      events.push(`publish:${target.split("/").pop()}`);
      const error = world.publishErrors?.[target];
      if (error) throw error;
      return { MessageId: "m" };
    });
    return events;
  };

  const snsError = (name: string, message: string) => Object.assign(new Error(message), { name });

  it("reports only the record whose user could not be notified", async () => {
    const events = setUpWorld({
      pending: { "user-1": [pendingItem(1)], "user-2": [pendingItem(2)], "user-3": [pendingItem(3)] },
      devices: { "user-1": [device("d1")], "user-2": [device("d2")], "user-3": [device("d3")] },
      publishErrors: { [endpointArn("d2")]: snsError("InternalErrorException", "Internal error") },
    });

    const result = await handler(
      buildSqsEvent([{ userIds: ["user-1"] }, { userIds: ["user-2"] }, { userIds: ["user-3"] }]),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    // Nothing reached user-2, so their rows, marker and claim stay for the retry.
    expect(events).not.toContain("deleteRows:user-2");
    expect(events).not.toContain("deleteMarker:user-2");
    expect(events).not.toContain("deleteClaim:user-2");
    expect(events).toEqual(expect.arrayContaining(["deleteRows:user-1", "deleteRows:user-3"]));
  });

  it("deletes each user's rows right after their pushes, before the next user runs", async () => {
    const events = setUpWorld({
      pending: { "user-1": [pendingItem(1)], "user-2": [pendingItem(2)] },
      devices: { "user-1": [device("d1")], "user-2": [device("d2")] },
      publishErrors: { [endpointArn("d2")]: snsError("ThrottledException", "Rate exceeded") },
    });

    const result = await handler(buildSqsEvent([hinted(["user-1", "user-2"])]));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-0" }] });
    expect(events).toEqual([
      "query:user-1",
      "publish:d1",
      "deleteRows:user-1",
      "deleteMarker:user-1",
      "deleteClaim:user-1",
      "query:user-2",
      "publish:d2",
    ]);
  });

  it("deletes the rows and does not retry when only some devices fail", async () => {
    const events = setUpWorld({
      pending: { "user-1": [pendingItem(1, "new"), pendingItem(2, "alert")] },
      devices: { "user-1": [device("phone"), device("tablet")] },
      publishErrors: { [endpointArn("tablet")]: snsError("InternalErrorException", "Internal error") },
    });

    const result = await handler(buildSqsEvent([hinted(["user-1"])]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(events).toEqual([
      "query:user-1",
      "publish:phone",
      "publish:tablet",
      "deleteRows:user-1",
      "deleteMarker:user-1",
      "deleteClaim:user-1",
    ]);
    expect(logLines(console.error)).toContainEqual(
      expect.objectContaining({
        message: "Failed to publish push notification",
        userId: "user-1",
        deviceId: "tablet",
        targetArn: endpointArn("tablet"),
      }),
    );
  });

  it("reads each marker with a consistent read before the pending-row query and deletes it only if its version is unchanged", async () => {
    const order: string[] = [];
    mockMarkerRead.mockImplementation(async (cmd: FakeDynamoCommand) => {
      order.push(`read:${cmd.input.Key!.userId.S}`);
      return { Item: { billId: { S: "user-1" }, markerVersion: { S: "v-read" } } };
    });
    const events = setUpWorld({ pending: { "user-1": [pendingItem(1)] }, devices: { "user-1": [device("d1")] } });

    await handler(buildSqsEvent([hinted(["user-1"])]));

    expect(mockMarkerRead).toHaveBeenCalledTimes(1);
    expect(mockMarkerRead.mock.calls[0][0].input).toEqual({
      TableName: "PendingBillNotifications",
      Key: { userId: { S: shardOf("user-1") }, billId: { S: "user-1" } },
      ProjectionExpression: "#sk, #markerVersion",
      ExpressionAttributeNames: { "#sk": "billId", "#markerVersion": "markerVersion" },
      ConsistentRead: true,
    });
    // The read happened before the query: the query is the first call on the main mock, after it.
    expect(order).toEqual([`read:${shardOf("user-1")}`]);
    expect(mockMarkerRead.mock.invocationCallOrder[0]).toBeLessThan(mockDynamoSend.mock.invocationCallOrder[0]);
    expect(events[0]).toBe("query:user-1");

    const inputs = mockDynamoSend.mock.calls.map((call) => call[0].input);
    expect(inputs[0].ConsistentRead).toBe(true);
    const markerDelete = inputs.find((input) => input.Key?.billId?.S === "user-1");
    expect(markerDelete).toEqual({
      TableName: "PendingBillNotifications",
      Key: { userId: { S: shardOf("user-1") }, billId: { S: "user-1" } },
      ConditionExpression: "#markerVersion = :seenVersion",
      ExpressionAttributeNames: { "#markerVersion": "markerVersion" },
      ExpressionAttributeValues: { ":seenVersion": { S: "v-read" } },
    });
  });

  it("deletes a marker written before marker versions only if it still has none and predates the query", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1_760_000_000_500);
    mockMarkerRead.mockResolvedValue({ Item: { billId: { S: "user-1" } } });
    setUpWorld({ pending: { "user-1": [pendingItem(1)] }, devices: { "user-1": [device("d1")] } });

    await handler(buildSqsEvent([hinted(["user-1"])]));

    const inputs = mockDynamoSend.mock.calls.map((call) => call[0].input);
    const markerDelete = inputs.find((input) => input.Key?.billId?.S === "user-1");
    expect(markerDelete).toMatchObject({
      ConditionExpression:
        "attribute_not_exists(#markerVersion) AND (attribute_not_exists(#updatedAt) OR #updatedAt < :cutoff)",
      ExpressionAttributeNames: { "#markerVersion": "markerVersion", "#updatedAt": "updatedAtEpoch" },
      ExpressionAttributeValues: { ":cutoff": { N: "1759999999" } },
    });
  });

  it("leaves a marker alone that did not exist when it was read, and still releases the claim", async () => {
    mockMarkerRead.mockResolvedValue({});
    const events = setUpWorld({ pending: { "user-1": [pendingItem(1)] }, devices: { "user-1": [device("d1")] } });

    const result = await handler(buildSqsEvent([hinted(["user-1"])]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(events).toEqual(["query:user-1", "publish:d1", "deleteRows:user-1", "deleteClaim:user-1"]);
  });

  it("fails the user, and deletes nothing, when the marker read fails", async () => {
    mockMarkerRead.mockRejectedValue(Object.assign(new Error("Throttled"), { name: "ThrottlingException" }));
    const events = setUpWorld({ pending: { "user-1": [pendingItem(1)] }, devices: { "user-1": [device("d1")] } });

    const result = await handler(buildSqsEvent([hinted(["user-1"])]));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-0" }] });
    expect(events).toEqual([]);
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  it("keeps a marker rewritten after the query and still releases the claim", async () => {
    const events = setUpWorld({
      pending: { "user-1": [pendingItem(1)], "user-2": [] },
      devices: { "user-1": [device("d1")] },
      markerConditionFails: true,
    });

    const result = await handler(buildSqsEvent([hinted(["user-1", "user-2"])]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(events).toEqual([
      "query:user-1",
      "publish:d1",
      "deleteRows:user-1",
      "deleteMarker:user-1",
      "deleteClaim:user-1",
      "query:user-2",
      "deleteMarker:user-2",
      "deleteClaim:user-2",
    ]);
  });

  it("awaits endpoint cleanup and logs the user for disabled endpoints", async () => {
    const events = setUpWorld({
      pending: { "user-1": [pendingItem(1)] },
      devices: { "user-1": [device("stale"), device("live")] },
      publishErrors: { [endpointArn("stale")]: snsError("EndpointDisabledException", "Endpoint is disabled") },
      slowEndpointCleanup: true,
    });

    const result = await handler(buildSqsEvent([hinted(["user-1"])]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(events).toEqual([
      "query:user-1",
      "publish:stale",
      "removeEndpoint:stale",
      "publish:live",
      "deleteRows:user-1",
      "deleteMarker:user-1",
      "deleteClaim:user-1",
    ]);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: "SNS endpoint disabled; removed endpointArn from device records (best-effort)",
        userId: "user-1",
        deviceId: "stale",
        targetArn: endpointArn("stale"),
      }),
    );
  });

  it("logs one outcome line per bill with the bill's own correlation id (OBS-10)", async () => {
    setUpWorld({
      pending: {
        "user-1": [
          { ...pendingItem(1), correlationId: { S: "2026-03-02T10:00:00.000Z:BILLS-119hr1is" } },
          pendingItem(2),
        ],
      },
      devices: { "user-1": [device("d1")] },
    });
    const event = buildSqsEvent([{ userIds: ["user-1"] }]);
    event.Records[0].messageAttributes = {
      correlationId: { dataType: "String", stringValue: "2026-03-02T10:05:00.000Z:dispatch" },
    };

    await (handler as (event: SQSEvent, context?: unknown) => Promise<SQSBatchResponse>)(event, {
      awsRequestId: "req-6",
    });

    const outcomes = logLines(console.log).filter((line) => line.message === "Bill notification outcome");
    expect(outcomes).toEqual([
      expect.objectContaining({
        guid: "BILLS-119hr1is",
        correlationId: "2026-03-02T10:00:00.000Z:BILLS-119hr1is",
        dispatchCorrelationId: "2026-03-02T10:05:00.000Z:dispatch",
        userId: "user-1",
        sqsMessageId: "msg-0",
        awsRequestId: "req-6",
        outcome: "delivered",
        devicesSent: 1,
      }),
      expect.objectContaining({ guid: "BILLS-119hr2is", dispatchCorrelationId: "2026-03-02T10:05:00.000Z:dispatch" }),
    ]);
    // A row written before OBS-10 has no id; the dispatch run's id must not stand in for it.
    expect(outcomes[1]).not.toHaveProperty("correlationId");
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Published notification",
        correlationId: "2026-03-02T10:05:00.000Z:dispatch",
        userId: "user-1",
      }),
    );
  });
});

describe("userNotifier dispatch marker release (CAP-02 sharding)", () => {
  const pendingRow = {
    billId: { S: "BILLS-119hr900is#new" },
    sourceBillId: { S: "BILLS-119hr900is" },
    billTitle: { S: "Sharded Bill" },
    category: { S: "Defense" },
    lifeArea: { S: "" },
    notificationType: { S: "new" },
  };

  // Every DeleteItem on the pending table, as "<partition>|<sort key>|<conditional?>".
  const routeAndRecordDeletes = (): string[] => {
    const deletes: string[] = [];
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      const input = cmd.input;
      if (input.TableName === "PendingBillNotifications" && input.KeyConditionExpression) {
        return { Items: [pendingRow] };
      }
      if (input.TableName === "UserDevices") {
        return {
          Items: [{ device_id: { S: "d1" }, endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/d1" } }],
        };
      }
      if (input.RequestItems) return {};
      if (input.TableName === "PendingBillNotifications" && input.Key) {
        deletes.push(
          `${input.Key.userId.S}|${input.Key.billId.S}|${input.ConditionExpression ? "conditional" : "plain"}`,
        );
        return {};
      }
      throw new Error(`Unexpected DynamoDB call: ${JSON.stringify(input)}`);
    });
    mockSnsSend.mockResolvedValue({ MessageId: "m" });
    return deletes;
  };

  it("deletes the marker and claim in exactly the partitions the dispatcher handed over", async () => {
    const deletes = routeAndRecordDeletes();

    const result = await handler(
      buildSqsEvent([{ userIds: ["user-1"], dispatchPartitions: { "user-1": ["__dispatch__#5", "__dispatch__"] } }]),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    // Every marker first, then every claim.
    expect(deletes).toEqual([
      "__dispatch__#5|user-1|conditional",
      "__dispatch__|user-1|conditional",
      "__dispatch__#5|__claim__#user-1|plain",
      "__dispatch__|__claim__#user-1|plain",
    ]);
  });

  it("deletes only the sharded keys when that is all it was handed", async () => {
    const deletes = routeAndRecordDeletes();

    await handler(buildSqsEvent([hinted(["user-1"])]));

    expect(deletes).toEqual([`${shardOf("user-1")}|user-1|conditional`, `${shardOf("user-1")}|__claim__#user-1|plain`]);
  });

  it("deletes both the sharded and the legacy keys for a message from an older dispatcher", async () => {
    const deletes = routeAndRecordDeletes();

    await handler(buildSqsEvent([{ userIds: ["user-1", "user-2"] }]));

    expect(deletes).toEqual([
      `${shardOf("user-1")}|user-1|conditional`,
      "__dispatch__|user-1|conditional",
      `${shardOf("user-1")}|__claim__#user-1|plain`,
      "__dispatch__|__claim__#user-1|plain",
      `${shardOf("user-2")}|user-2|conditional`,
      "__dispatch__|user-2|conditional",
      `${shardOf("user-2")}|__claim__#user-2|plain`,
      "__dispatch__|__claim__#user-2|plain",
    ]);
  });

  it("never deletes a key outside the dispatch partitions, whatever the message names", async () => {
    const deletes = routeAndRecordDeletes();

    await handler(
      buildSqsEvent([
        { userIds: ["user-1"], dispatchPartitions: { "user-1": ["user-2", "__dedupe__", "__dispatch__#x"] } },
      ]),
    );

    // Nothing valid was handed, so it falls back to the user's shard and the legacy partition.
    expect(deletes).toEqual([
      `${shardOf("user-1")}|user-1|conditional`,
      "__dispatch__|user-1|conditional",
      `${shardOf("user-1")}|__claim__#user-1|plain`,
      "__dispatch__|__claim__#user-1|plain",
    ]);
  });

  it("keeps a marker rewritten after the query in any partition and still releases every claim", async () => {
    const deletes = routeAndRecordDeletes();
    const routed = mockDynamoSend.getMockImplementation()!;
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      if (cmd.input.ConditionExpression && cmd.input.Key?.userId?.S === "__dispatch__") {
        deletes.push("__dispatch__|user-1|kept");
        throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      }
      return routed(cmd);
    });

    const result = await handler(
      buildSqsEvent([{ userIds: ["user-1"], dispatchPartitions: { "user-1": ["__dispatch__", "__dispatch__#2"] } }]),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(deletes).toEqual([
      "__dispatch__|user-1|kept",
      "__dispatch__#2|user-1|conditional",
      "__dispatch__|__claim__#user-1|plain",
      "__dispatch__#2|__claim__#user-1|plain",
    ]);
  });
});

export {};

describe("userNotifier companion groups (APPF-23)", () => {
  const HOUSE = "BILLS-119hr1285";
  const SENATE = "BILLS-119s570";
  const device = {
    device_id: { S: "device-1" },
    platform: { S: "ios" },
    push_token: { S: "token-1" },
    endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
  };
  const pendingRow = (guid: string, title: string, type: string) => ({
    billId: { S: `${guid}#${type}` },
    sourceBillId: { S: guid },
    billTitle: { S: title },
    category: { S: "Energy" },
    lifeArea: { S: "" },
    notificationType: { S: type },
  });
  let groupsItem: Item | undefined;

  beforeEach(() => {
    jest.resetModules();
    process.env.MANIFEST_TABLE_NAME = "BillsManifest";
    process.env.MANIFEST_PRIMARY_KEY = "pk";
    groupsItem = {
      pk: { S: "BILL_COMPANION_GROUPS" },
      sk: { S: "CURRENT" },
      pairsVersion: { N: "1" },
      enabled: { BOOL: true },
      pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
    };
    const markerRead = mockMarkerRead.getMockImplementation()!;
    mockMarkerRead.mockImplementation(async (cmd: FakeDynamoCommand) =>
      cmd.input.Key!.pk?.S === "BILL_COMPANION_GROUPS" ? { Item: groupsItem } : markerRead(cmd),
    );
    handler = require("../handlers/userNotifier").handler;
  });

  const pushFor = async (rows: Item[]) => {
    mockDynamoSend
      .mockResolvedValueOnce({ Items: rows })
      .mockResolvedValueOnce({ Items: [device] })
      .mockResolvedValueOnce({});
    await handler(buildSqsEvent([{ userIds: ["user-1"] }]));
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    return JSON.parse(JSON.parse(mockSnsSend.mock.calls[0][0].input.Message).APNS);
  };

  it("reads one pair's two new rows as one bill, the primary's, and deletes both rows", async () => {
    const apns = await pushFor([
      pendingRow(SENATE, "Senate Water Act", "new"),
      pendingRow(HOUSE, "House Water Act", "new"),
    ]);

    expect(apns.aps.alert.title).toBe("New: House Water Act");
    expect(apns.aps.alert.title).not.toMatch(/2 New Bills/);
    expect(apns.billId).toBe(HOUSE);
    expect(apns.billIds).toEqual([HOUSE, SENATE]);
    expect(apns.notificationType).toBe("new");
    const deletes = mockDynamoSend.mock.calls
      .map(([cmd]: [FakeDynamoCommand]) => cmd.input)
      .find((input) => input.RequestItems);
    expect(deletes!.RequestItems!.PendingBillNotifications.map((r) => r.DeleteRequest.Key.billId.S)).toEqual([
      `${SENATE}#new`,
      `${HOUSE}#new`,
    ]);
  });

  it("counts a pair once next to other bills, including a suffixed member guid", async () => {
    const apns = await pushFor([
      pendingRow(`${HOUSE}ih`, "House Water Act", "new"),
      pendingRow(SENATE, "Senate Water Act", "new"),
      pendingRow("BILLS-119hr77", "Other Bill", "new"),
    ]);

    expect(apns.aps.alert.title).toBe("2 New Bills for You");
    expect(apns.billCount).toBe(2);
    expect(apns.billIds).toEqual([`${HOUSE}ih`, "BILLS-119hr77", SENATE]);
  });

  it("keeps both members' ids on a pair's updated push, so the app can clear whichever vote counts", async () => {
    // The user's counted vote is on S. 570; a push listing only H.R. 1285 would never clear it.
    const apns = await pushFor([
      pendingRow(HOUSE, "House Water Act", "updated"),
      pendingRow(SENATE, "Senate Water Act", "updated"),
    ]);

    expect(apns.aps.alert.title).toBe("Updated: House Water Act");
    expect(apns.notificationType).toBe("updated");
    expect(apns.billIds).toEqual([HOUSE, SENATE]);
  });

  it("keeps a pair's updated rows on one push when the updated bills need more than one push", async () => {
    // 49 other bills and the pair are 51 ids, one past what either app reads: the pair moves whole to the next push.
    const others = Array.from({ length: 49 }, (_, n) => pendingRow(`BILLS-119hr${2000 + n}`, `Bill ${n}`, "updated"));
    mockDynamoSend.mockResolvedValue({});
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          ...others,
          pendingRow(SENATE, "Senate Water Act", "updated"),
          pendingRow(HOUSE, "House Water Act", "updated"),
        ],
      })
      .mockResolvedValueOnce({ Items: [device] });

    expect(await handler(buildSqsEvent([{ userIds: ["user-1"] }]))).toEqual({ batchItemFailures: [] });

    const pushes = mockSnsSend.mock.calls.map(([cmd]) => JSON.parse(JSON.parse(cmd.input.Message).APNS));
    expect(pushes.map((apns) => [apns.aps.alert.title, apns.notificationType, apns.billIds])).toEqual([
      ["49 Bills Changed", "updated", others.map((row) => row.sourceBillId.S)],
      ["Updated: House Water Act", "updated", [HOUSE, SENATE]],
    ]);
  });

  it("counts a pair's different notification types as one bill", async () => {
    const apns = await pushFor([
      pendingRow(HOUSE, "House Water Act", "new"),
      pendingRow(SENATE, "Senate Water Act", "passed"),
    ]);

    // One bill: the most telling row (passed) speaks for it; the types differ, so it stays a digest.
    expect(apns.aps.alert.title).toBe("Passed: Senate Water Act");
    expect(apns.aps.alert.body).toBe("It passed a vote in Congress.");
    expect(apns.notificationType).toBe("digest");
    expect(apns.billCount).toBe(1);
  });

  it("counts every bill id on its own while the groups are turned off", async () => {
    groupsItem = { ...groupsItem, enabled: { BOOL: false } };
    const apns = await pushFor([
      pendingRow(HOUSE, "House Water Act", "new"),
      pendingRow(SENATE, "Senate Water Act", "new"),
    ]);

    expect(apns.aps.alert.title).toBe("2 New Bills for You");
    expect(apns.billCount).toBe(2);
  });

  it("counts every bill id on its own when the groups cannot be read", async () => {
    mockMarkerRead.mockImplementation(async (cmd: FakeDynamoCommand) => {
      if (cmd.input.Key!.pk?.S === "BILL_COMPANION_GROUPS") throw new Error("AccessDenied");
      return { Item: { billId: cmd.input.Key!.billId, markerVersion: { S: "v-read" } } };
    });
    const apns = await pushFor([
      pendingRow(HOUSE, "House Water Act", "new"),
      pendingRow(SENATE, "Senate Water Act", "new"),
    ]);

    expect(apns.aps.alert.title).toBe("2 New Bills for You");
    expect(logLines(console.warn).map((line) => line.message)).toContain(
      "Could not read the companion groups; counting each bill on its own",
    );
  });
});

describe("userNotifier push copy (X9)", () => {
  const device = {
    device_id: { S: "device-1" },
    endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
  };
  const row = (guid: string, title: string, type: string) => ({
    billId: { S: `${guid}#${type}` },
    sourceBillId: { S: guid },
    billTitle: { S: title },
    category: { S: "Defense" },
    lifeArea: { S: "" },
    notificationType: { S: type },
  });
  // An id too long for any APNs payload, so the size fallbacks take over.
  const HUGE_GUID = `BILLS-119hr1${"x".repeat(3600)}`;

  const pushFor = async (rows: Record<string, unknown>[]) => {
    mockDynamoSend
      .mockResolvedValueOnce({ Items: rows })
      .mockResolvedValueOnce({ Items: [device] })
      .mockResolvedValueOnce({});
    const result = await handler(buildSqsEvent([hinted(["user-1"])]));
    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const message = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    return { message, apns: JSON.parse(message.APNS) };
  };

  it.each([
    ["an updated bill", [row("BILLS-119hr1", "Water Act", "updated")], "Open Billboard to see what changed."],
    ["a passed bill", [row("BILLS-119hr1", "Water Act", "passed")], "It passed a vote in Congress."],
    [
      "same-type bills without a readable title",
      [row("BILLS-119hr1", " ", "new"), row("BILLS-119hr2", "  ", "new")],
      "Open Billboard to review the latest.",
    ],
    ["one bill too large for the payload", [row(HUGE_GUID, "Water Act", "alert")], "Open Billboard"],
    [
      "a digest too large for the payload",
      [row(HUGE_GUID, "Water Act", "new"), row("BILLS-119hr2", "Road Act", "new")],
      "Open Billboard for recent updates",
    ],
  ])("says Billboard, not BillBoard, for %s", async (_case, rows, body) => {
    const { message, apns } = await pushFor(rows);

    expect(apns.aps.alert.body).toBe(body);
    expect(message.APNS_SANDBOX).toBe(message.APNS);
    expect(JSON.stringify(message)).not.toContain("BillBoard");
  });
});

describe("userNotifier unprocessable messages (C1.8)", () => {
  const DROP_LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";
  const dropLines = () => logLines(console.warn).filter((line) => line.message === DROP_LOG_MESSAGE);
  const dropMetrics = () => logLines(console.log).filter((line) => line._aws && "MessagesUnprocessable" in line);
  const withBodies = (bodies: string[]): SQSEvent => {
    const event = buildSqsEvent(bodies.map(() => ({})));
    event.Records.forEach((record, index) => (record.body = bodies[index]));
    return event;
  };
  const goodUser = () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Items: [
          {
            billId: { S: "BILLS-119hr100is#new" },
            sourceBillId: { S: "BILLS-119hr100is" },
            billTitle: { S: "Healthcare Act" },
            category: { S: "Social Policy" },
            lifeArea: { S: "" },
            notificationType: { S: "new" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [{ device_id: { S: "device-1" }, endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/d1" } }],
      })
      .mockResolvedValueOnce({});
  };

  it("acknowledges each malformed message, logging and counting it once with its reason", async () => {
    const result = await handler(
      withBodies([
        "",
        "not json",
        "null",
        JSON.stringify({ some: "thing" }),
        JSON.stringify({ userIds: "user-1" }),
        JSON.stringify({ userIds: [] }),
        JSON.stringify({ userIds: ["", 5] }),
      ]),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockSnsSend).not.toHaveBeenCalled();
    const expected = [
      ["msg-0", "empty_body"],
      ["msg-1", "invalid_json"],
      ["msg-2", "invalid_structure"],
      ["msg-3", "invalid_structure"],
      ["msg-4", "invalid_structure"],
      ["msg-5", "no_user_ids"],
      ["msg-6", "no_user_ids"],
    ];
    expect(dropLines().map((line) => [line.messageId, line.reason])).toEqual(expected);
    expect(dropLines().every((line) => line.dropSite === "userNotifier.malformed")).toBe(true);
    expect(dropMetrics().map((line) => [line.sqsMessageId, line.reason])).toEqual(expected);
    expect(dropMetrics().every((line) => line.MessagesUnprocessable === 1)).toBe(true);
    expect(dropMetrics().every((line) => line.dropSite === "userNotifier.malformed")).toBe(true);
    expect(dropMetrics()[0]._aws!.CloudWatchMetrics).toEqual([
      {
        Namespace: "BillBoard/Pipeline",
        Dimensions: [[]],
        Metrics: [{ Name: "MessagesUnprocessable", Unit: "Count" }],
      },
    ]);
    expect(dropLines()[1].messagePreview).toBe("not json");
    expect(dropLines()[3].messageContent).toEqual({ some: "thing" });
    // The old per-reason lines are replaced by the drop line.
    expect(logLines(console.warn).map((line) => line.message)).toEqual(expected.map(() => DROP_LOG_MESSAGE));
  });

  it("counts nothing for a well-formed message", async () => {
    goodUser();

    const result = await handler(buildSqsEvent([hinted(["user-1"])]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    expect(dropLines()).toEqual([]);
    expect(dropMetrics()).toEqual([]);
  });

  it("redacts token and email keys in the logged content", async () => {
    await handler(
      withBodies([JSON.stringify({ userIds: [], pushToken: "secret-token-1", email: "someone@example.com" })]),
    );

    expect(dropLines()).toHaveLength(1);
    expect(dropLines()[0].messageContent).toEqual({ userIds: [], pushToken: "[redacted]", email: "[redacted]" });
    const written = (console.warn as jest.Mock).mock.calls.map(([line]) => String(line)).join("\n");
    expect(written).not.toContain("secret-token-1");
    expect(written).not.toContain("someone@example.com");
  });

  it("still acknowledges a malformed message, and delivers the rest, when its log and metric lines throw", async () => {
    (console.warn as jest.Mock).mockImplementation((line: unknown) => {
      if (String(line).includes(DROP_LOG_MESSAGE)) throw new Error("console.warn broke");
    });
    (console.log as jest.Mock).mockImplementation((line: unknown) => {
      if (String(line).includes('"MessagesUnprocessable"')) throw new Error("console.log broke");
    });
    goodUser();
    const event = buildSqsEvent([{}, hinted(["user-1"])]);
    event.Records[0].body = "not json";

    const result = await handler(event);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const attempts = (spy: unknown, text: string) =>
      (spy as jest.Mock).mock.calls.filter(([line]) => String(line).includes(text)).length;
    expect(attempts(console.warn, DROP_LOG_MESSAGE)).toBe(1);
    expect(attempts(console.log, '"MessagesUnprocessable"')).toBe(1);
  });
});
