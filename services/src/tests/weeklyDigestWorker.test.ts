import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { GetObjectCommandInput } from "@aws-sdk/client-s3";
import { applyTestEnv } from "./fixtures/env";
import { asSqsEvent } from "./fixtures/awsEvents";
import {
  PROCESSED_BILL_KEYS,
  WEEKLY_DIGEST_PREVIOUS_WINDOW_ID,
  WEEKLY_DIGEST_TEST_ENV,
  WEEKLY_DIGEST_TEST_NOW,
  WEEKLY_DIGEST_TEST_WINDOW_ID,
  processedBillS3Route,
  s3GetKeys,
  storedDigestUserIds,
  storedSnapshotItem,
  weeklyDigestDynamoRoute,
  weeklyDigestMetricData,
} from "./fixtures/weeklyDigest";
import { logLinesWithMessage } from "./logLines";

/** The DynamoDB input fields the routes read. */
interface DynamoInput {
  TableName?: string;
  Key?: Record<string, AttributeValue>;
  Item?: Record<string, AttributeValue>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

/** A command as the mocked SDK constructors below build it. */
interface MockedCommand<Input> {
  __type: string;
  input?: Input;
}

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

type WorkerModule = typeof import("../handlers/weeklyDigestWorker");

describe("weeklyDigestWorker handler", () => {
  let mockDynamoSend: jest.Mock;
  let mockS3Send: jest.Mock;
  let mockCloudWatchSend: jest.Mock;
  let restoreEnv: (() => void) | undefined;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers({ advanceTimers: true });
    jest.setSystemTime(new Date(WEEKLY_DIGEST_TEST_NOW));

    ({ __mockSend: mockDynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb"));
    ({ __mockSend: mockS3Send } = jest.requireMock("@aws-sdk/client-s3"));
    ({ __mockSend: mockCloudWatchSend } = jest.requireMock("@aws-sdk/client-cloudwatch"));

    mockDynamoSend.mockReset();
    mockS3Send.mockReset();
    mockCloudWatchSend.mockReset();
    mockCloudWatchSend.mockResolvedValue({});

    restoreEnv?.();
    restoreEnv = applyTestEnv(WEEKLY_DIGEST_TEST_ENV, { replace: true });

    mockDynamoSend.mockImplementation(weeklyDigestDynamoRoute());
    mockS3Send.mockImplementation(processedBillS3Route);

    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    restoreEnv?.();
    restoreEnv = undefined;
    jest.useRealTimers();
  });

  function loadWorker(): WorkerModule {
    return require("../handlers/weeklyDigestWorker");
  }

  function record(messageId: string, body: unknown) {
    return { messageId, body: typeof body === "string" ? body : JSON.stringify(body), messageAttributes: {} };
  }

  function workEvent(...records: ReturnType<typeof record>[]) {
    return asSqsEvent({ Records: records });
  }

  function routeDynamo(override: (command: MockedCommand<DynamoInput>) => Promise<unknown> | undefined) {
    const fallback = mockDynamoSend.getMockImplementation()!;
    mockDynamoSend.mockImplementation(async (command: MockedCommand<DynamoInput>) => {
      const result = override(command);
      return result === undefined ? fallback(command) : result;
    });
  }

  function metricValues(metricName: string): number[] {
    return weeklyDigestMetricData(mockCloudWatchSend, metricName).map((datum) => datum.Value!);
  }

  function dynamoCommands(type: string, tableName?: string) {
    return mockDynamoSend.mock.calls
      .map(([command]) => command)
      .filter((command) => command.__type === type && (!tableName || command.input?.TableName === tableName));
  }

  test("generates the message's users, reports no failures and emits zero failed users", async () => {
    const { handler } = loadWorker();

    const response = await handler(
      workEvent(record("msg-1", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["user-1", "user-2"] })),
    );

    expect(response).toEqual({ batchItemFailures: [] });
    expect(storedDigestUserIds(mockDynamoSend)).toEqual(["user-1", "user-2"]);
    const put = dynamoCommands("PutItemCommand")[0];
    expect(put.input.Item.publishedAt).toEqual({ S: WEEKLY_DIGEST_TEST_WINDOW_ID });

    expect(metricValues("WeeklyDigestUsersFailed")).toEqual([0]);
    expect(metricValues("WeeklyDigestUsersProcessed")).toEqual([2]);
    expect(weeklyDigestMetricData(mockCloudWatchSend, "WeeklyDigestUsersFailed")[0]).not.toHaveProperty("Dimensions");

    expect(logLinesWithMessage(logSpy, "weeklyDigestWorker message summary")).toEqual([
      expect.objectContaining({
        sqsMessageId: "msg-1",
        windowId: WEEKLY_DIGEST_TEST_WINDOW_ID,
        userCount: 2,
        stored: 2,
        existing: 0,
        empty: 0,
        failed: 0,
        processed: 2,
      }),
    ]);
  });

  test("counts users whose snapshot exists and users with nothing to report", async () => {
    routeDynamo((command) => {
      if (command.__type === "GetItemCommand" && command.input?.Key?.userId?.S === "user-old") {
        return Promise.resolve(storedSnapshotItem());
      }
      // Preferences query on ":uid", feedback query on ":pk": this user follows nothing and never voted.
      const values = command.input?.ExpressionAttributeValues ?? {};
      if (command.__type === "QueryCommand" && (values[":uid"]?.S ?? values[":pk"]?.S) === "user-quiet") {
        return Promise.resolve({ Items: [] });
      }
      return undefined;
    });

    const { handler } = loadWorker();
    const response = await handler(
      workEvent(
        record("msg-1", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["user-new", "user-old", "user-quiet"] }),
      ),
    );

    expect(response.batchItemFailures).toEqual([]);
    expect(storedDigestUserIds(mockDynamoSend)).toEqual(["user-new"]);
    expect(logLinesWithMessage(logSpy, "weeklyDigestWorker message summary")).toEqual([
      expect.objectContaining({ userCount: 3, stored: 1, existing: 1, empty: 1, failed: 0, processed: 3 }),
    ]);
    expect(metricValues("WeeklyDigestUsersFailed")).toEqual([0]);
    expect(metricValues("WeeklyDigestUsersProcessed")).toEqual([3]);
  });

  test("a failed user fails only its message; the other users are still generated", async () => {
    routeDynamo((command) =>
      command.__type === "GetItemCommand" && command.input?.Key?.userId?.S === "user-2"
        ? Promise.reject(new Error("ProvisionedThroughputExceededException"))
        : undefined,
    );

    const { handler } = loadWorker();
    const response = await handler(
      workEvent(
        record("msg-a", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["user-1", "user-2", "user-3"] }),
        record("msg-b", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["user-4"] }),
      ),
    );

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-a" }] });
    expect(storedDigestUserIds(mockDynamoSend)).toEqual(["user-1", "user-3", "user-4"]);
    // One datum per message, in message order, zero included.
    expect(metricValues("WeeklyDigestUsersFailed")).toEqual([1, 0]);
    expect(metricValues("WeeklyDigestUsersProcessed")).toEqual([2, 1]);

    expect(logLinesWithMessage(errorSpy, "weeklyDigestWorker message summary")).toEqual([
      expect.objectContaining({ sqsMessageId: "msg-a", stored: 2, failed: 1 }),
    ]);
    expect(logLinesWithMessage(errorSpy, "Weekly digest generation failed for user")).toEqual([
      expect.objectContaining({ userId: "user-2", sqsMessageId: "msg-a" }),
    ]);
    expect(logLinesWithMessage(errorSpy, "Weekly digest work message failed")).toEqual([
      expect.objectContaining({ messageId: "msg-a" }),
    ]);
  });

  test("a redelivered message skips the users already stored", async () => {
    let failUser2 = true;
    const stored = new Set<string>();
    routeDynamo((command) => {
      const userId = command.input?.Key?.userId?.S ?? command.input?.Item?.userId?.S;
      if (command.__type === "GetItemCommand") {
        if (userId === "user-2" && failUser2) return Promise.reject(new Error("throttled"));
        return Promise.resolve(stored.has(userId!) ? storedSnapshotItem() : {});
      }
      if (command.__type === "PutItemCommand") {
        stored.add(userId!);
        return Promise.resolve({});
      }
      return undefined;
    });

    const { handler } = loadWorker();
    const message = record("msg-a", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["user-1", "user-2"] });

    expect((await handler(workEvent(message))).batchItemFailures).toEqual([{ itemIdentifier: "msg-a" }]);
    failUser2 = false;
    expect((await handler(workEvent(message))).batchItemFailures).toEqual([]);

    expect(storedDigestUserIds(mockDynamoSend)).toEqual(["user-1", "user-2"]);
    expect(logLinesWithMessage(logSpy, "weeklyDigestWorker message summary")).toEqual([
      expect.objectContaining({ stored: 1, existing: 1, failed: 0 }),
    ]);
    expect(metricValues("WeeklyDigestUsersFailed")).toEqual([1, 0]);
  });

  test("an unreadable message or an unknown window fails the message and counts its users as failed", async () => {
    const { handler } = loadWorker();

    const response = await handler(
      workEvent(
        record("not-json", "{nope"),
        record("no-users", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: [] }),
        // A Saturday instant, not a release time.
        record("bad-window", { windowId: "2026-03-21T14:00:00.000Z", userIds: ["user-1", "user-2"] }),
      ),
    );

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "not-json" },
      { itemIdentifier: "no-users" },
      { itemIdentifier: "bad-window" },
    ]);
    expect(metricValues("WeeklyDigestUsersFailed")).toEqual([1, 1, 2]);
    expect(dynamoCommands("PutItemCommand")).toHaveLength(0);
    expect(dynamoCommands("QueryCommand", "bill-manifest-table")).toHaveLength(0);
  });

  test("a failure loading the shared inputs fails the message, and the next message loads them again", async () => {
    let manifestFailures = 1;
    routeDynamo((command) =>
      command.__type === "QueryCommand" && command.input?.TableName === "bill-manifest-table" && manifestFailures-- > 0
        ? Promise.reject(new Error("manifest unavailable"))
        : undefined,
    );

    const { handler } = loadWorker();
    const first = await handler(
      workEvent(record("msg-1", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["user-1", "user-2"] })),
    );
    const second = await handler(
      workEvent(record("msg-2", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["user-1", "user-2"] })),
    );

    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
    expect(second.batchItemFailures).toEqual([]);
    expect(metricValues("WeeklyDigestUsersFailed")).toEqual([2, 0]);
    expect(dynamoCommands("QueryCommand", "bill-manifest-table")).toHaveLength(2);
    expect(storedDigestUserIds(mockDynamoSend)).toEqual(["user-1", "user-2"]);
  });

  describe("bill cache", () => {
    test("reads each processed bill once per window across users and messages while warm", async () => {
      const { handler } = loadWorker();

      await handler(
        workEvent(
          record("msg-1", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["u-01", "u-02", "u-03", "u-04"] }),
          record("msg-2", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["u-05", "u-06"] }),
        ),
      );
      await handler(
        workEvent(record("msg-3", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["u-07", "u-08", "u-09"] })),
      );

      expect(storedDigestUserIds(mockDynamoSend)).toHaveLength(9);
      // Nine digests, each using all three bills: three S3 reads in total.
      expect(s3GetKeys(mockS3Send).sort()).toEqual([...PROCESSED_BILL_KEYS].sort());
      // The manifest and member names are loaded once for the window too.
      expect(dynamoCommands("QueryCommand", "bill-manifest-table")).toHaveLength(1);
      expect(dynamoCommands("ScanCommand", "members-table")).toHaveLength(1);
    });

    test("a different window gets its own context and cache", async () => {
      const { handler } = loadWorker();

      await handler(workEvent(record("msg-1", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["u-01"] })));
      await handler(workEvent(record("msg-2", { windowId: WEEKLY_DIGEST_PREVIOUS_WINDOW_ID, userIds: ["u-02"] })));

      const manifestQueries = dynamoCommands("QueryCommand", "bill-manifest-table");
      expect(manifestQueries).toHaveLength(2);
      // Each window loads the manifest from its own start.
      expect(manifestQueries.map((command) => command.input.ExpressionAttributeValues[":updatedAfter"].S)).toEqual([
        "2026-03-15T04:00:00.000Z",
        "2026-03-08T05:00:00.000Z",
      ]);
      // Each message checks for (and would write) the snapshot of its own window.
      expect(
        dynamoCommands("GetItemCommand", "weekly-digests-table").map((command) => command.input.Key.publishedAt.S),
      ).toEqual([WEEKLY_DIGEST_TEST_WINDOW_ID, WEEKLY_DIGEST_PREVIOUS_WINDOW_ID]);
      // And each window's context reads the published companion groups once (APPF-23).
      expect(dynamoCommands("GetItemCommand", "bill-manifest-table").map((command) => command.input.Key.pk.S)).toEqual([
        "BILL_COMPANION_GROUPS",
        "BILL_COMPANION_GROUPS",
      ]);
    });

    test("a bill read that throws is not remembered: a later user reads it again", async () => {
      let failures = 1;
      mockS3Send.mockImplementation(async (command: MockedCommand<GetObjectCommandInput>) => {
        if (command.input?.Key === PROCESSED_BILL_KEYS[0] && failures-- > 0) {
          throw Object.assign(new Error("SlowDown"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
        }
        return processedBillS3Route(command);
      });

      const { handler } = loadWorker();
      await handler(workEvent(record("msg-1", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["u-01"] })));
      await handler(workEvent(record("msg-2", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["u-02"] })));
      await handler(workEvent(record("msg-3", { windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds: ["u-03"] })));

      const keys = s3GetKeys(mockS3Send);
      // Failed once, read again for the next user, then cached.
      expect(keys.filter((key) => key === PROCESSED_BILL_KEYS[0])).toHaveLength(2);
      expect(keys.filter((key) => key === PROCESSED_BILL_KEYS[1])).toHaveLength(1);
      expect(keys.filter((key) => key === PROCESSED_BILL_KEYS[2])).toHaveLength(1);
      expect(logLinesWithMessage(warnSpy, "Failed to hydrate processed bill for weekly digest")).toHaveLength(1);
      // The first user's digest still went out, with a placeholder for the unreadable bill.
      expect(storedDigestUserIds(mockDynamoSend)).toEqual(["u-01", "u-02", "u-03"]);
      expect(metricValues("WeeklyDigestUsersFailed")).toEqual([0, 0, 0]);
    });
  });
});
