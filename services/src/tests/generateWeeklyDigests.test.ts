import type { WeeklyDigest } from "../models/weeklyDigest";
import { applyTestEnv } from "./fixtures/env";
import {
  PROCESSED_BILL_KEYS,
  WEEKLY_DIGEST_TEST_ENV,
  WEEKLY_DIGEST_TEST_NOW,
  WEEKLY_DIGEST_TEST_WINDOW_ID,
  preferencesItems,
  processedBillS3Route,
  s3GetKeys,
  storedDigestUserIds,
  storedSnapshotItem,
  weeklyDigestDynamoRoute,
  weeklyDigestMetricData,
} from "./fixtures/weeklyDigest";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    QueryCommand: jest.fn().mockImplementation((input) => ({ __type: "QueryCommand", input })),
    ScanCommand: jest.fn().mockImplementation((input) => ({ __type: "ScanCommand", input })),
    GetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "GetItemCommand", input })),
    PutItemCommand: jest.fn().mockImplementation((input) => ({ __type: "PutItemCommand", input })),
  };
});

jest.mock("@aws-sdk/client-s3", () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "GetObjectCommand", input })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "PutObjectCommand", input })),
    ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ __type: "ListObjectsV2Command", input })),
    ListObjectVersionsCommand: jest
      .fn()
      .mockImplementation((input) => ({ __type: "ListObjectVersionsCommand", input })),
  };
});

jest.mock("@aws-sdk/client-cloudwatch", () => {
  const mockSend = jest.fn();
  return {
    CloudWatchClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ __type: "PutMetricDataCommand", input })),
  };
});

jest.mock("@aws-sdk/client-sqs", () => {
  const mockSend = jest.fn();
  return {
    SQSClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ __type: "SendMessageBatchCommand", input })),
  };
});

/** A DynamoDB command as the mocked SDK constructors build it; the input fields are the ones the tests route on. */
interface DdbCommand {
  __type: string;
  input?: { TableName?: string; Key?: { pk?: { S?: string }; userId?: { S?: string } } };
}

/** A SendMessageBatchCommand as the mocked SDK constructor builds it. */
interface SqsBatchCommand {
  input: { Entries: Array<{ Id: string; MessageBody: string; MessageAttributes?: Record<string, unknown> }> };
}

/** The body of one fan-out message. */
interface SentBody {
  userIds: string[];
  windowId: string;
}

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/WeeklyDigestQueue";

describe("generateWeeklyDigests handler", () => {
  let mockDynamoSend: jest.Mock;
  let mockS3Send: jest.Mock;
  let mockCloudWatchSend: jest.Mock;
  let mockSqsSend: jest.Mock;
  let restoreEnv: (() => void) | undefined;
  let logSpy: jest.SpyInstance;

  function useEnv(overrides: Record<string, string> = {}) {
    restoreEnv?.();
    restoreEnv = applyTestEnv({ ...WEEKLY_DIGEST_TEST_ENV, ...overrides }, { replace: true });
  }

  beforeEach(() => {
    jest.resetModules();
    // advanceTimers: the planner's send retries sleep, so fake time has to move.
    jest.useFakeTimers({ advanceTimers: true });
    jest.setSystemTime(new Date(WEEKLY_DIGEST_TEST_NOW));
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

    ({ __mockSend: mockDynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb"));
    ({ __mockSend: mockS3Send } = jest.requireMock("@aws-sdk/client-s3"));
    ({ __mockSend: mockCloudWatchSend } = jest.requireMock("@aws-sdk/client-cloudwatch"));
    ({ __mockSend: mockSqsSend } = jest.requireMock("@aws-sdk/client-sqs"));

    mockDynamoSend.mockReset();
    mockS3Send.mockReset();
    mockCloudWatchSend.mockReset();
    mockSqsSend.mockReset();
    mockCloudWatchSend.mockResolvedValue({});

    useEnv();

    mockDynamoSend.mockImplementation(weeklyDigestDynamoRoute());
    mockS3Send.mockImplementation(processedBillS3Route);
  });

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
    jest.useRealTimers();
    logSpy.mockRestore();
  });

  function metricData(metricName: string) {
    return weeklyDigestMetricData(mockCloudWatchSend, metricName);
  }

  // Wraps the default DynamoDB routing so tests can override single commands.
  function routeDynamo(override: (command: DdbCommand) => Promise<unknown> | undefined) {
    const fallback = mockDynamoSend.getMockImplementation()!;
    mockDynamoSend.mockImplementation(async (command: DdbCommand) => {
      const result = override(command);
      return result === undefined ? fallback(command) : result;
    });
  }

  function piiScanReturns(userIds: string[]) {
    routeDynamo((command) =>
      command.__type === "ScanCommand" && command.input?.TableName === "pii-table"
        ? Promise.resolve({ Items: userIds.map((userId) => ({ userId: { S: userId } })) })
        : undefined,
    );
  }

  function userIdsFor(count: number) {
    return Array.from({ length: count }, (_, index) => `user-${String(index).padStart(3, "0")}`);
  }

  function dynamoCommands(type: string) {
    return mockDynamoSend.mock.calls.map(([command]) => command).filter((command) => command.__type === type);
  }

  describe("inline pass", () => {
    test("generates and stores digests for eligible users", async () => {
      const { handler } = require("../handlers/generateWeeklyDigests");

      const response = await handler({});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        releaseAt: "2026-03-22T14:00:00.000Z",
        userCount: 1,
        stored: 1,
        existing: 0,
        empty: 0,
        failed: 0,
      });

      const putCall = mockDynamoSend.mock.calls.find(([command]) => command.__type === "PutItemCommand");
      expect(putCall).toBeDefined();

      const putInput = putCall?.[0].input;
      expect(putInput.TableName).toBe("weekly-digests-table");
      expect(putInput.Item.userId).toEqual({ S: "user-1" });
      expect(putInput.Item.publishedAt).toEqual({ S: "2026-03-22T14:00:00.000Z" });
      // S15 (was 180 days, CAP-09): snapshots expire 21 days after publication; only the current week is read.
      expect(putInput.Item.ttl).toEqual({
        N: String(Date.parse("2026-03-22T14:00:00.000Z") / 1000 + 21 * 24 * 60 * 60),
      });
      expect(metricData("WeeklyDigestUsersFailed")).toEqual([
        expect.objectContaining({ MetricName: "WeeklyDigestUsersFailed", Value: 0 }),
      ]);
      expect(metricData("WeeklyDigestUsersProcessed")).toEqual([
        expect.objectContaining({ MetricName: "WeeklyDigestUsersProcessed", Value: 1 }),
      ]);
      expect(mockSqsSend).not.toHaveBeenCalled();

      // The fixture user watches H.R. 21, follows its sponsor, and voted on H.R. 22, which passed (S2: so it is
      // under "Moved", not "Needs attention"). Every text the apps show, as stored.
      const storedDigest = JSON.parse(putInput.Item.payload.S);
      expect(storedDigest).toEqual({
        id: "2026-03-22T14:00:00.000Z",
        title: "Your Week in Congress | Mar 15-21, 2026",
        summary: "One bill needs your attention, 2 more moved, and one member you follow had a bill move.",
        weekStart: "2026-03-15T04:00:00.000Z",
        weekEnd: "2026-03-21T04:00:00.000Z",
        publishedAt: "2026-03-22T14:00:00.000Z",
        isRead: false,
        stats: [
          { id: "attention", label: "Need attention", value: "1", accent: "attention" },
          { id: "representatives", label: "Members active", value: "1", accent: "representative" },
          { id: "quicklook", label: "Worth a look", value: "0", accent: "discovery" },
        ],
        sections: [
          {
            kind: "needs_attention",
            title: "Needs Your Attention",
            subtitle: "Bills you watch, changes since your vote, and outcomes on your topics.",
            items: [
              {
                id: "bill|BILLS-119hr21ih",
                kind: "bill",
                title: "Current Watch Bill",
                eyebrow: "Updated Mar 18",
                summary: "Mar 18: Committee reported the bill.",
                detail: "A watched bill moved this week.",
                reason: "You're watching this",
                accent: "attention",
                billState: "updated",
                billGuid: "BILLS-119hr21ih",
                primaryMemberBioguideId: "A000360",
              },
            ],
          },
          {
            kind: "moved_this_week",
            title: "What Moved This Week",
            subtitle: "Other bills that moved this week.",
            items: [
              {
                id: "bill|BILLS-119hr22ih",
                kind: "bill",
                title: "Tracked Passed Bill",
                eyebrow: "Passed Mar 19",
                summary: "Mar 19: Passed the House.",
                detail: "A tracked-area bill passed.",
                reason: "You voted on this",
                accent: "movement",
                billState: "passed",
                billGuid: "BILLS-119hr22ih",
              },
              {
                id: "bill|BILLS-119hr23ih",
                kind: "bill",
                title: "Quick Look Bill",
                eyebrow: "New Mar 20",
                summary: "Mar 20: Introduced in the House.",
                detail: "A fresh bill worth a look.",
                reason: "Matches your topic: Energy",
                accent: "movement",
                billState: "new",
                billGuid: "BILLS-119hr23ih",
              },
            ],
          },
          {
            kind: "representatives",
            title: "Members You Follow",
            subtitle: "Members you follow who sponsor or cosponsor a bill that moved this week.",
            items: [
              {
                id: "member|A000360|BILLS-119hr21ih",
                kind: "member",
                title: "Rep. Alice Example",
                eyebrow: "1 bill this week",
                summary: "Sponsored H.R. 21, which moved this week.",
                detail: "H.R. 21: Current Watch Bill",
                reason: "Member you follow",
                accent: "representative",
                billGuid: "BILLS-119hr21ih",
                primaryMemberBioguideId: "A000360",
              },
            ],
          },
        ],
      });
    });

    describe("the user's votes (INT-11: a 1.0 or 1.1 dismissal is not one)", () => {
      // The fixture preferences without the watch and the followed member, so the Updated bill BILLS-119hr21ih is
      // in the digest only for its tracked topic, unless the user voted on it.
      const trackedOnlyPreferences = preferencesItems.filter(
        (item) => item.type.S !== "Watch" && item.type.S !== "Congress Member",
      );

      async function digestWithFeedbackRows(rows: Record<string, unknown>[]) {
        routeDynamo((command) => {
          if (command.__type !== "QueryCommand") return undefined;
          if (command.input?.TableName === "preferences-table") {
            return Promise.resolve({ Items: trackedOnlyPreferences });
          }
          if (command.input?.TableName === "feedback-table") {
            return Promise.resolve({ Items: rows });
          }
          return undefined;
        });

        const { handler } = require("../handlers/generateWeeklyDigests");
        const response = await handler({});
        expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ stored: 1, failed: 0 }));

        const digest = JSON.parse(dynamoCommands("PutItemCommand")[0].input.Item.payload.S) as WeeklyDigest;
        const items = digest.sections.flatMap((section) =>
          section.items.map((item) => ({ section: section.kind, billGuid: item.billGuid, reason: item.reason })),
        );
        return { items, item: (billGuid: string) => items.find((item) => item.billGuid === billGuid) };
      }

      const row = (feedback: string, extra: Record<string, unknown> = {}) => ({
        billId: { S: "BILLS-119hr21ih" },
        feedback: { S: feedback },
        votedAt: { S: "2026-03-01T15:00:00.000Z" },
        ...extra,
      });

      test.each([
        ["a Yea", row("Yea")],
        ["an Abstain", row("Abstain")],
        ["an Abstain whose legacyDismiss is false", row("Abstain", { legacyDismiss: { BOOL: false } })],
      ])("%s on an Updated bill reads 'You voted on this before'", async (_label, feedbackRow) => {
        const { item } = await digestWithFeedbackRows([feedbackRow]);

        expect(item("BILLS-119hr21ih")).toEqual({
          section: "needs_attention",
          billGuid: "BILLS-119hr21ih",
          reason: "You voted on this before",
        });
      });

      test("a marked dismissal is not read as a vote, and the query asks for the mark", async () => {
        const { items, item } = await digestWithFeedbackRows([
          row("Abstain", { legacyDismiss: { BOOL: true } }),
          // A real vote on another bill still counts beside it.
          { billId: { S: "BILLS-119hr22ih" }, feedback: { S: "Yea" }, votedAt: { S: "2026-03-01T15:00:00.000Z" } },
        ]);

        // The same bill as with no vote at all: listed for its tracked topic, not as a bill the user voted on.
        expect(item("BILLS-119hr21ih")).toEqual({
          section: "moved_this_week",
          billGuid: "BILLS-119hr21ih",
          reason: "Matches your topic: Energy",
        });
        expect(items.map((entry) => entry.reason)).not.toContain("You voted on this before");

        const feedbackQueries = dynamoCommands("QueryCommand").filter(
          (command) => command.input?.TableName === "feedback-table",
        );
        expect(feedbackQueries).toHaveLength(1);
        expect(feedbackQueries[0].input.ProjectionExpression.split(/,\s*/)).toContain("legacyDismiss");
      });
    });

    test("skips writing when the digest snapshot already exists", async () => {
      mockDynamoSend.mockImplementation(async (command: DdbCommand) => {
        if (command.__type === "ScanCommand") {
          if (command.input?.TableName === "pii-table") {
            return { Items: [{ userId: { S: "user-1" } }] };
          }

          if (command.input?.TableName === "members-table") {
            return { Items: [] };
          }
        }

        if (command.__type === "QueryCommand" && command.input?.TableName === "bill-manifest-table") {
          return { Items: [] };
        }

        if (command.__type === "GetItemCommand") {
          return {
            Item: {
              payload: {
                S: JSON.stringify({
                  id: "2026-03-22T14:00:00.000Z",
                  title: "Your Week in Congress | Mar 15-21, 2026",
                  summary: "Already stored.",
                  weekStart: "2026-03-15T04:00:00.000Z",
                  weekEnd: "2026-03-21T04:00:00.000Z",
                  publishedAt: "2026-03-22T14:00:00.000Z",
                  isRead: false,
                  stats: [],
                  sections: [],
                }),
              },
            },
          };
        }

        if (command.__type === "PutItemCommand") {
          throw new Error("Expected existing digests to skip writes");
        }

        return { Items: [] };
      });

      const { handler } = require("../handlers/generateWeeklyDigests");
      const response = await handler({});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        releaseAt: "2026-03-22T14:00:00.000Z",
        userCount: 1,
        stored: 0,
        existing: 1,
        empty: 0,
        failed: 0,
      });
      expect(mockDynamoSend.mock.calls.some(([command]) => command.__type === "PutItemCommand")).toBe(false);
    });

    test("throws after processing every user when any user fails, and emits the failure metric", async () => {
      piiScanReturns(["user-1", "user-2", "user-3"]);
      routeDynamo((command) =>
        command.__type === "GetItemCommand" && command.input?.Key?.userId?.S === "user-2"
          ? Promise.reject(new Error("ProvisionedThroughputExceededException"))
          : undefined,
      );
      const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        const { handler } = require("../handlers/generateWeeklyDigests");
        await expect(handler({})).rejects.toThrow("generateWeeklyDigests failed for 1 of 3 users");
      } finally {
        errorLog.mockRestore();
      }

      expect(storedDigestUserIds(mockDynamoSend)).toEqual(["user-1", "user-3"]);
      expect(metricData("WeeklyDigestUsersFailed")).toEqual([
        expect.objectContaining({ MetricName: "WeeklyDigestUsersFailed", Value: 1, Unit: "Count" }),
      ]);
      expect(metricData("WeeklyDigestUsersFailed")[0]).not.toHaveProperty("Dimensions");
    });

    test("a rerun skips users whose snapshot was already written", async () => {
      piiScanReturns(["user-1", "user-2"]);
      routeDynamo((command) => {
        if (command.__type === "GetItemCommand" && command.input?.Key?.userId?.S === "user-1") {
          return Promise.resolve(storedSnapshotItem());
        }
        return undefined;
      });

      const { handler } = require("../handlers/generateWeeklyDigests");
      const response = await handler({});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(
        expect.objectContaining({ userCount: 2, existing: 1, stored: 1, failed: 0 }),
      );

      const puts = dynamoCommands("PutItemCommand");
      expect(puts).toHaveLength(1);
      expect(puts[0].input.Item.userId).toEqual({ S: "user-2" });
      // The write is conditional, so a concurrent rerun cannot overwrite a stored snapshot.
      expect(puts[0].input.ConditionExpression).toBe("attribute_not_exists(#pk) AND attribute_not_exists(#sk)");
    });

    test("treats a lost conditional write race as success", async () => {
      routeDynamo((command) => {
        if (command.__type === "PutItemCommand") {
          const error = Object.assign(new Error("The conditional request failed"), {
            name: "ConditionalCheckFailedException",
          });
          return Promise.reject(error);
        }
        return undefined;
      });

      const { handler } = require("../handlers/generateWeeklyDigests");
      const response = await handler({});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ failed: 0 }));
    });

    test("throws instead of returning a 500 body when setup fails", async () => {
      const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
      routeDynamo((command) =>
        command.__type === "QueryCommand" && command.input?.TableName === "bill-manifest-table"
          ? Promise.reject(new Error("manifest unavailable"))
          : undefined,
      );

      try {
        const { handler } = require("../handlers/generateWeeklyDigests");
        await expect(handler({})).rejects.toThrow("manifest unavailable");
      } finally {
        errorLog.mockRestore();
      }
      expect(mockDynamoSend.mock.calls.some(([command]) => command.__type === "PutItemCommand")).toBe(false);
    });

    test("reads each processed bill from S3 once per run, however many users need it", async () => {
      piiScanReturns(userIdsFor(8));

      const { handler } = require("../handlers/generateWeeklyDigests");
      const response = await handler({});

      expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ userCount: 8, stored: 8, failed: 0 }));
      // Every user's digest uses all three bills; each is fetched once for the whole run.
      expect(s3GetKeys(mockS3Send).sort()).toEqual([...PROCESSED_BILL_KEYS].sort());
    });

    test("generates at most 5 users at a time", async () => {
      piiScanReturns(userIdsFor(12));
      let inFlight = 0;
      let maxInFlight = 0;
      routeDynamo((command) => {
        if (command.__type !== "GetItemCommand") return undefined;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return (async () => {
          for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
          inFlight -= 1;
          return {};
        })();
      });

      const { handler } = require("../handlers/generateWeeklyDigests");
      const response = await handler({});

      expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ userCount: 12, stored: 12 }));
      expect(maxInFlight).toBe(5);
    });

    test("stops starting users when the Lambda is close to its timeout, and throws so the retry resumes", async () => {
      piiScanReturns(userIdsFor(12));
      const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
      let checks = 0;
      // Plenty of time for the first three users, then under the reserve.
      const lambdaContext = {
        awsRequestId: "req-1",
        getRemainingTimeInMillis: () => (++checks <= 3 ? 10 * 60_000 : 30_000),
      };

      try {
        const { handler, INLINE_TIME_RESERVE_MS } = require("../handlers/generateWeeklyDigests");
        expect(INLINE_TIME_RESERVE_MS).toBe(60_000);
        await expect(handler({}, lambdaContext)).rejects.toThrow(
          "stopped before the Lambda timeout with 9 of 12 users not started and 0 failed",
        );
      } finally {
        errorLog.mockRestore();
      }

      expect(storedDigestUserIds(mockDynamoSend)).toEqual(["user-000", "user-001", "user-002"]);
      expect(metricData("WeeklyDigestUsersFailed")).toEqual([expect.objectContaining({ Value: 0 })]);
      expect(metricData("WeeklyDigestUsersProcessed")).toEqual([expect.objectContaining({ Value: 3 })]);
    });
  });

  describe("fan-out planner (WEEKLY_DIGEST_QUEUE_URL set)", () => {
    beforeEach(() => {
      useEnv({ WEEKLY_DIGEST_QUEUE_URL: QUEUE_URL });
      mockSqsSend.mockImplementation(async (command: SqsBatchCommand) => ({
        Successful: command.input.Entries.map((entry) => ({ Id: entry.Id, MessageId: `msg-${entry.Id}` })),
        Failed: [],
      }));
    });

    function sentEntries(): SqsBatchCommand["input"]["Entries"] {
      return mockSqsSend.mock.calls.flatMap(([command]: [SqsBatchCommand]) => command.input.Entries);
    }

    function sentBodies() {
      return sentEntries().map((entry) => JSON.parse(entry.MessageBody) as SentBody);
    }

    test("enqueues every user in messages of 25 users with the window id, and generates nothing itself", async () => {
      const users = userIdsFor(260);
      piiScanReturns(users);

      const { handler } = require("../handlers/generateWeeklyDigests");
      const response = await handler({});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        mode: "fan-out",
        releaseAt: WEEKLY_DIGEST_TEST_WINDOW_ID,
        windowId: WEEKLY_DIGEST_TEST_WINDOW_ID,
        userCount: 260,
        messageCount: 11,
        enqueuedUsers: 260,
        failedMessages: 0,
        failedUsers: 0,
      });

      // 11 messages: one full batch of 10, then 1.
      expect(mockSqsSend).toHaveBeenCalledTimes(2);
      expect(mockSqsSend.mock.calls.map(([command]) => command.input.Entries.length)).toEqual([10, 1]);
      expect(mockSqsSend.mock.calls.every(([command]) => command.input.QueueUrl === QUEUE_URL)).toBe(true);

      const bodies = sentBodies();
      expect(bodies.map((body) => body.userIds.length)).toEqual([25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 10]);
      expect(bodies.every((body) => body.windowId === WEEKLY_DIGEST_TEST_WINDOW_ID)).toBe(true);
      expect(bodies.flatMap((body) => body.userIds)).toEqual(users);
      expect(new Set(sentEntries().map((entry) => entry.Id)).size).toBe(11);
      expect(sentEntries()[0].MessageAttributes!.correlationId).toEqual(
        expect.objectContaining({ DataType: "String", StringValue: expect.stringContaining("weekly-digest-1") }),
      );

      expect(metricData("WeeklyDigestUsersEnqueued")).toEqual([
        expect.objectContaining({ MetricName: "WeeklyDigestUsersEnqueued", Value: 260, Unit: "Count" }),
      ]);
      expect(metricData("WeeklyDigestUsersFailed")).toEqual([]);
      // No generation in the planner: no manifest or member load, no snapshot reads or writes, no S3.
      expect(dynamoCommands("QueryCommand")).toHaveLength(0);
      expect(dynamoCommands("GetItemCommand")).toHaveLength(0);
      expect(dynamoCommands("PutItemCommand")).toHaveLength(0);
      expect(dynamoCommands("ScanCommand").map((command) => command.input.TableName)).toEqual(["pii-table"]);
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    test("resends only the entries SQS did not accept", async () => {
      piiScanReturns(userIdsFor(60));
      mockSqsSend.mockImplementationOnce(async (command: SqsBatchCommand) => ({
        Successful: command.input.Entries.filter((entry) => entry.Id !== "m1").map((entry) => ({
          Id: entry.Id,
        })),
        Failed: [{ Id: "m1", Code: "InternalError", SenderFault: false, Message: "try again" }],
      }));
      const warnLog = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const { handler } = require("../handlers/generateWeeklyDigests");
        const response = await handler({});
        expect(JSON.parse(response.body)).toEqual(
          expect.objectContaining({ messageCount: 3, enqueuedUsers: 60, failedMessages: 0 }),
        );
      } finally {
        warnLog.mockRestore();
      }

      expect(mockSqsSend).toHaveBeenCalledTimes(2);
      const retry: SqsBatchCommand["input"]["Entries"] = mockSqsSend.mock.calls[1][0].input.Entries;
      expect(retry.map((entry) => entry.Id)).toEqual(["m1"]);
      expect(JSON.parse(retry[0].MessageBody).userIds).toEqual(userIdsFor(60).slice(25, 50));
      expect(metricData("WeeklyDigestUsersEnqueued")).toEqual([expect.objectContaining({ Value: 60 })]);
    });

    test("retries a SendMessageBatch call that throws", async () => {
      piiScanReturns(userIdsFor(30));
      mockSqsSend.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { name: "TimeoutError" }));
      const warnLog = jest.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const { handler } = require("../handlers/generateWeeklyDigests");
        const response = await handler({});
        expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ enqueuedUsers: 30, failedMessages: 0 }));
      } finally {
        warnLog.mockRestore();
      }

      expect(mockSqsSend.mock.calls.map(([command]) => command.input.Entries.length)).toEqual([2, 2]);
    });

    test("throws after the retries when some entries still fail, so the async retry plans again", async () => {
      piiScanReturns(userIdsFor(60));
      mockSqsSend.mockImplementation(async (command: SqsBatchCommand) => ({
        Successful: command.input.Entries.filter((entry) => entry.Id !== "m2").map((entry) => ({
          Id: entry.Id,
        })),
        Failed: command.input.Entries.filter((entry) => entry.Id === "m2").map((entry) => ({
          Id: entry.Id,
          Code: "InternalError",
          SenderFault: false,
        })),
      }));
      const warnLog = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        const { handler } = require("../handlers/generateWeeklyDigests");
        await expect(handler({})).rejects.toThrow("could not enqueue 10 of 60 users in 1 messages");
      } finally {
        warnLog.mockRestore();
        errorLog.mockRestore();
      }

      // First send of all three, then two resends of the one that keeps failing.
      expect(
        mockSqsSend.mock.calls.map(([command]: [SqsBatchCommand]) => command.input.Entries.map((entry) => entry.Id)),
      ).toEqual([["m0", "m1", "m2"], ["m2"], ["m2"]]);
      expect(metricData("WeeklyDigestUsersEnqueued")).toEqual([expect.objectContaining({ Value: 50 })]);
    });

    test("with no users it sends nothing and reports zero", async () => {
      piiScanReturns([]);

      const { handler } = require("../handlers/generateWeeklyDigests");
      const response = await handler({});

      expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ userCount: 0, messageCount: 0 }));
      expect(mockSqsSend).not.toHaveBeenCalled();
      expect(metricData("WeeklyDigestUsersEnqueued")).toEqual([expect.objectContaining({ Value: 0 })]);
    });

    test("a run that names users generates them inline instead of enqueueing", async () => {
      const { handler } = require("../handlers/generateWeeklyDigests");

      const direct = await handler({ userIds: ["user-7", " user-8 "] });
      const viaDetail = await handler({ detail: { userId: "user-9" } });

      expect(JSON.parse(direct.body)).toEqual(expect.objectContaining({ userCount: 2, stored: 2, failed: 0 }));
      expect(JSON.parse(viaDetail.body)).toEqual(expect.objectContaining({ userCount: 1, stored: 1 }));
      expect(mockSqsSend).not.toHaveBeenCalled();
      // The PII table is never listed for a targeted run.
      expect(dynamoCommands("ScanCommand").map((command) => command.input.TableName)).not.toContain("pii-table");
      expect(storedDigestUserIds(mockDynamoSend)).toEqual(["user-7", "user-8", "user-9"]);
      expect(metricData("WeeklyDigestUsersEnqueued")).toEqual([]);
    });
  });
});

describe("weekly digest companion groups (APPF-23)", () => {
  const HOUSE = "BILLS-119hr1285";
  const SENATE = "BILLS-119s570";
  const OTHER = "BILLS-119hr77";
  let restoreEnv: () => void;
  let buildWeeklyDigest: typeof import("../shared/weeklyDigestBuilder").buildWeeklyDigest;
  let window: import("../shared/weeklyDigestSchedule").WeeklyDigestPublicationWindow;
  let index: import("../shared/billCompanions").CompanionIndex;

  beforeEach(() => {
    jest.resetModules();
    restoreEnv = applyTestEnv(WEEKLY_DIGEST_TEST_ENV, { replace: true });
    ({ buildWeeklyDigest } = require("../shared/weeklyDigestBuilder"));
    window = require("../shared/weeklyDigestSchedule").latestPublishedWindow(new Date(WEEKLY_DIGEST_TEST_NOW));
    index = require("../shared/billCompanions").companionIndex([[HOUSE, SENATE]]);
  });

  afterEach(() => restoreEnv());

  const entry = (guid: string, updatedAt: string, fields: Record<string, unknown> = {}) => ({
    guid,
    billType: guid.includes("s570") ? "s" : "hr",
    congress: "119",
    billNumber: guid.replace(/^BILLS-119[a-z]+/, ""),
    updatedAt,
    title: `Title ${guid}`,
    subCategories: ["Energy"],
    lifeAreas: [],
    sponsors: [],
    cosponsors: ["C000003"],
    billStatus: "Updated" as const,
    ...fields,
  });

  const build = (options: {
    houseUpdatedAt?: string;
    senateUpdatedAt?: string;
    watched?: string[];
    votedOn?: string[];
    followed?: string[];
    companions?: boolean;
  }) =>
    buildWeeklyDigest({
      window,
      preferences: {
        trackedTopics: ["Energy"],
        trackedLifeAreas: [],
        followedMembers: options.followed ?? [],
        watchedBillGuids: options.watched ?? [],
        selectedBillContentTypes: [],
      },
      voteStatesByBillId: new Map(
        (options.votedOn ?? []).map((billId) => [billId.toLowerCase(), { billId, feedback: "Yea" }]),
      ),
      manifestItems: [
        entry(HOUSE, options.houseUpdatedAt ?? "2026-03-18T15:00:00.000Z"),
        entry(SENATE, options.senateUpdatedAt ?? "2026-03-19T15:00:00.000Z"),
        entry(OTHER, "2026-03-20T15:00:00.000Z", { billStatus: "New", cosponsors: [] }),
      ],
      memberNameById: new Map([["C000003", "Sen. Cosponsor"]]),
      loadProcessedBill: async () => null,
      ...(options.companions === false ? {} : { companionIndex: index }),
    });

  const billGuids = (digest: WeeklyDigest | null) =>
    digest!.sections.flatMap((section) =>
      section.items.filter((item) => item.kind === "bill").map((item) => item.billGuid),
    );

  it("lists a pair once, as the member that moved most recently", async () => {
    expect(billGuids(await build({}))).toEqual([SENATE, OTHER]);
    expect(billGuids(await build({ houseUpdatedAt: "2026-03-20T16:00:00.000Z" }))).toEqual([HOUSE, OTHER]);
    // Without groups both members are listed, as before.
    expect(billGuids(await build({ companions: false })).sort()).toEqual([HOUSE, OTHER, SENATE]);
  });

  it("treats a vote on the partner as a vote on the pair", async () => {
    const digest = (await build({ votedOn: [HOUSE] }))!;

    const attention = digest.sections.find((section) => section.kind === "needs_attention");
    expect(attention!.items).toEqual([
      expect.objectContaining({ billGuid: SENATE, reason: "You voted on this before" }),
    ]);

    // Without groups the Senate bill is not one the user voted on.
    const ungrouped = (await build({ votedOn: [HOUSE], companions: false }))!;
    expect(ungrouped.sections.find((section) => section.kind === "needs_attention")!.items).toEqual([
      expect.objectContaining({ billGuid: HOUSE, reason: "You voted on this before" }),
    ]);
  });

  it("treats a watch on the partner as a watch on the pair", async () => {
    const digest = (await build({ watched: [HOUSE] }))!;

    expect(digest.sections[0].items[0]).toMatchObject({ billGuid: SENATE, reason: "You're watching this" });
  });

  it("treats a watch stored under a legacy id as a watch on the plain bill (REL-42)", async () => {
    const digest = (await build({ watched: [`${OTHER}ih`], companions: false }))!;

    expect(digest.sections[0].items[0]).toMatchObject({ billGuid: OTHER, reason: "You're watching this" });
  });

  it("treats a vote stored under a legacy id as a vote on the plain bill (REL-42)", async () => {
    const digest = (await build({ votedOn: [`${HOUSE}ih`], companions: false }))!;

    expect(digest.sections.find((section) => section.kind === "needs_attention")!.items).toEqual([
      expect.objectContaining({ billGuid: HOUSE, reason: "You voted on this before" }),
    ]);
  });

  it("keeps member activity per bill", async () => {
    const digest = (await build({ followed: ["C000003"] }))!;

    const representatives = digest.sections.find((section) => section.kind === "representatives");
    // The pair is two bills for the member, named by the one that moved most recently.
    expect(representatives!.items).toEqual([
      expect.objectContaining({
        title: "Sen. Cosponsor",
        eyebrow: "2 bills this week",
        summary: "Cosponsored S. 570 and 1 more bill that moved this week.",
        billGuid: SENATE,
      }),
    ]);
    expect(billGuids(digest)).toEqual([SENATE, OTHER]);
  });

  it("reads the published groups once per context and passes them to every digest", async () => {
    const { __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb");
    send.mockReset();
    send.mockImplementation(async (command: DdbCommand) => {
      if (command.input?.Key?.pk?.S === "BILL_COMPANION_GROUPS") {
        return {
          Item: { pairsVersion: { N: "1" }, enabled: { BOOL: true }, pairs: { S: JSON.stringify([[HOUSE, SENATE]]) } },
        };
      }
      return weeklyDigestDynamoRoute()(command);
    });
    const { createWeeklyDigestGenerationContextForWindow } = require("../shared/weeklyDigestGeneration");

    const context = await createWeeklyDigestGenerationContextForWindow(window);

    expect(context.companionIndex.get(SENATE)).toEqual({
      primaryGuid: HOUSE,
      memberGuids: [HOUSE, SENATE],
      relationship: "identical",
    });
    const groupReads = send.mock.calls.filter(
      ([command]: [DdbCommand]) => command.input?.Key?.pk?.S === "BILL_COMPANION_GROUPS",
    );
    expect(groupReads).toHaveLength(1);
    expect(groupReads[0][0].input.TableName).toBe("bill-manifest-table");
  });

  it("builds per bill when the groups cannot be read", async () => {
    const { __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb");
    send.mockReset();
    send.mockImplementation(async (command: DdbCommand) => {
      if (command.input?.Key?.pk?.S === "BILL_COMPANION_GROUPS") throw new Error("AccessDenied");
      return weeklyDigestDynamoRoute()(command);
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const { createWeeklyDigestGenerationContextForWindow } = require("../shared/weeklyDigestGeneration");

    const context = await createWeeklyDigestGenerationContextForWindow(window);

    expect(context.companionIndex.size).toBe(0);
    expect(context.manifestItems).toHaveLength(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"CompanionGroupsReadFailed":1'));
    warn.mockRestore();
    log.mockRestore();
  });
});

describe("weekly digest renamed labels (LLM-10)", () => {
  let restoreEnv: () => void;
  let buildWeeklyDigest: typeof import("../shared/weeklyDigestBuilder").buildWeeklyDigest;
  let window: import("../shared/weeklyDigestSchedule").WeeklyDigestPublicationWindow;

  beforeEach(() => {
    jest.resetModules();
    restoreEnv = applyTestEnv(WEEKLY_DIGEST_TEST_ENV, { replace: true });
    ({ buildWeeklyDigest } = require("../shared/weeklyDigestBuilder"));
    window = require("../shared/weeklyDigestSchedule").latestPublishedWindow(new Date(WEEKLY_DIGEST_TEST_NOW));
  });

  afterEach(() => restoreEnv());

  const entry = (number: number, subCategories: string[]) => ({
    guid: `BILLS-119hr${number}`,
    billType: "hr",
    congress: "119",
    billNumber: String(number),
    updatedAt: `2026-03-1${number}T15:00:00.000Z`,
    title: `Title ${number}`,
    subCategories,
    lifeAreas: [],
    sponsors: [],
    cosponsors: [],
    billStatus: "New" as const,
  });

  const reasonsFor = async (trackedTopics: string[], manifestItems: ReturnType<typeof entry>[]) => {
    const digest = await buildWeeklyDigest({
      window,
      preferences: {
        trackedTopics,
        trackedLifeAreas: [],
        followedMembers: [],
        watchedBillGuids: [],
        selectedBillContentTypes: [],
      },
      voteStatesByBillId: new Map(),
      manifestItems,
      memberNameById: new Map(),
      loadProcessedBill: async () => null,
    });
    return Object.fromEntries(
      (digest?.sections ?? []).flatMap((section) =>
        section.items.filter((item) => item.kind === "bill").map((item) => [item.billGuid, item.reason]),
      ),
    );
  };

  it("matches a follow and a bill label whichever name each is stored under, and shows the current name", async () => {
    const reasons = await reasonsFor(
      ["Social Justice", "Heritage and Identity"],
      [
        entry(5, ["Civil Rights and Liberties"]), // relabelled bill, follow not yet moved
        entry(6, ["Identity Politics"]), // bill not yet relabelled, follow under the current name
        entry(7, ["Energy"]),
      ],
    );

    expect(reasons).toEqual({
      "BILLS-119hr5": "Matches your topic: Civil Rights and Liberties",
      "BILLS-119hr6": "Matches your topic: Heritage and Identity",
    });
  });

  it("shows a former label under its current name when both sides use the former name", async () => {
    expect(await reasonsFor(["Social Justice"], [entry(5, ["Social Justice", "Healthcare"])])).toEqual({
      "BILLS-119hr5": "Matches your topic: Civil Rights and Liberties",
    });
  });

  it("matches nothing for a label the user does not follow under either name", async () => {
    expect(await reasonsFor(["Heritage and Identity"], [entry(5, ["Social Justice"])])).toEqual({});
  });
});
