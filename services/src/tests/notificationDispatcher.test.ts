import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { EventBridgeEvent } from "aws-lambda";
import { dispatchShardPartitionValue } from "../shared/dispatchShards";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

const originalEnv = { ...process.env };

const mockDynamoSend = jest.fn();
const mockSQSSend = jest.fn();
const mockSnsSend = jest.fn();
const mockCloudWatchSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
  ScanCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteItemCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sns", () => ({
  SNSClient: jest.fn(() => ({ send: mockSnsSend })),
  GetPlatformApplicationAttributesCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCloudWatchSend })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type ScheduledEvent = EventBridgeEvent<"Scheduled Event", unknown>;

/** The DynamoDB input fields the route reads, across the commands the dispatcher sends. */
interface FakeDynamoInput {
  KeyConditionExpression?: string;
  ConditionExpression?: string;
  ProjectionExpression?: string;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ExclusiveStartKey?: { page: { N: string } };
  Item?: Record<string, AttributeValue>;
  Key?: Record<string, { S: string }>;
}
interface FakeDynamoCommand {
  input: FakeDynamoInput;
}

/** One entry of a SendMessageBatch call. */
interface SqsEntry {
  Id: string;
  MessageBody: string;
  MessageAttributes: { correlationId: { StringValue: string } };
}
interface FakeSqsCommand {
  input: { Entries: SqsEntry[] };
}

type Handler = (event: ScheduledEvent) => Promise<{
  status: string;
  distinctUsers: number;
  batchesSent: number;
}>;
let handler: Handler;
let restoreEnv: (() => void) | undefined;

const buildEventBridgeEvent = (): ScheduledEvent => ({
  version: "0",
  id: "event-id",
  "detail-type": "Scheduled Event",
  source: "aws.events",
  account: "123456789012",
  time: "2025-11-01T00:00:00Z",
  region: "us-east-1",
  resources: ["arn:aws:events:us-east-1:123456789012:rule/notification-dispatcher"],
  detail: {},
});

beforeEach(() => {
  jest.resetModules();
  mockDynamoSend.mockReset();
  mockSQSSend.mockReset();
  mockSnsSend.mockReset();
  mockCloudWatchSend.mockReset();

  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      PENDING_NOTIFICATIONS_TABLE: "PendingBillNotifications",
      PARTITION_KEY: "userId",
      QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/notification-processing",
      USER_BATCH_SIZE: "50",
      QUEUE_BATCH_SIZE: "10",
    },
    { replace: true, base: originalEnv },
  );

  const mod = require("../handlers/notificationDispatcher");
  handler = mod.handler;
});

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

const LEGACY = "__dispatch__";
const ALL_SHARDS = Array.from({ length: 8 }, (_, index) => `${LEGACY}#${index}`);
const shardOf = (userId: string): string => dispatchShardPartitionValue(LEGACY, userId, 8);

const marker = (userId: string, updatedAtEpoch?: number) => ({
  billId: { S: userId },
  markerType: { S: "pending-user" },
  targetUserId: { S: userId },
  ...(updatedAtEpoch === undefined ? {} : { updatedAtEpoch: { N: String(updatedAtEpoch) } }),
});
const claimItem = (userId: string) => ({
  billId: { S: `__claim__#${userId}` },
  markerType: { S: "dispatch-claim" },
  targetUserId: { S: userId },
});

// Groups markers into their users' shard partitions (several users can share a shard).
const markersByShard = (markers: Array<ReturnType<typeof marker>>): Record<string, unknown[]> => {
  const partitions: Record<string, unknown[]> = {};
  for (const item of markers) {
    (partitions[shardOf(item.targetUserId.S)] ??= []).push(item);
  }
  return partitions;
};

type DispatchWorld = {
  /** Items per dispatch partition value; an array of arrays is a list of pages. */
  partitions?: Record<string, unknown[] | unknown[][]>;
  /** Items the legacy full-table scan returns. */
  scanItems?: unknown[];
  /** "<partition>|<userId>" claims that fail their condition (held by another run). */
  heldClaims?: string[];
  /** "<partition>|<userId>" or userId -> error thrown by that claim write. */
  claimErrors?: Record<string, Error>;
  onClaim?: () => void;
};

// Routes every DynamoDB call by its input, so the order of the parallel partition queries does not matter.
const routeDynamo = (world: DispatchWorld) => {
  const claims: string[] = [];
  const queried: string[] = [];
  const released: string[] = [];
  mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
    const input = cmd.input;
    if (input.KeyConditionExpression) {
      const partition = input.ExpressionAttributeValues![":dispatch"].S as string;
      queried.push(partition);
      const configured = world.partitions?.[partition] ?? [];
      const pages = Array.isArray(configured[0]) ? (configured as unknown[][]) : [configured as unknown[]];
      const page = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.page.N) : 0;
      return {
        Items: pages[page] ?? [],
        ...(page + 1 < pages.length ? { LastEvaluatedKey: { page: { N: String(page + 1) } } } : {}),
      };
    }
    if (input.Item && input.ConditionExpression) {
      world.onClaim?.();
      const partition = input.Item.userId.S as string;
      const userId = input.Item.targetUserId.S as string;
      const error = world.claimErrors?.[`${partition}|${userId}`] ?? world.claimErrors?.[userId];
      if (error) throw error;
      if (world.heldClaims?.includes(`${partition}|${userId}`)) {
        throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      }
      claims.push(`${partition}|${input.Item.billId.S}`);
      return {};
    }
    if (input.Key && !input.Item) {
      released.push(`${input.Key.userId.S}|${input.Key.billId.S}`);
      return {};
    }
    if (input.ProjectionExpression === "#pk") {
      return { Items: world.scanItems ?? [] };
    }
    throw new Error(`Unexpected DynamoDB call: ${JSON.stringify(input)}`);
  });
  return { claims, queried, released };
};

const acceptAllSqs = () =>
  mockSQSSend.mockImplementation(async (cmd: FakeSqsCommand) => ({
    Successful: cmd.input.Entries.map((entry: SqsEntry) => ({ Id: entry.Id })),
    Failed: [],
  }));

const sentBodies = () =>
  mockSQSSend.mock.calls.flatMap((call) =>
    call[0].input.Entries.map((entry: SqsEntry) => JSON.parse(entry.MessageBody)),
  );

describe("notificationDispatcher correlation id (OBS-10)", () => {
  it("mints one id per run, logs it and sends it with every batch to userNotifier", async () => {
    process.env.USER_BATCH_SIZE = "1";
    jest.resetModules();
    const dispatch = require("../handlers/notificationDispatcher").handler as (
      event: ScheduledEvent,
      context?: unknown,
    ) => ReturnType<Handler>;
    routeDynamo({ partitions: { [LEGACY]: [marker("user-1"), marker("user-2")] } });
    acceptAllSqs();

    await dispatch(buildEventBridgeEvent(), { awsRequestId: "req-8" });

    const entries = mockSQSSend.mock.calls[0][0].input.Entries;
    expect(entries).toHaveLength(2);
    const ids = entries.map((entry: SqsEntry) => entry.MessageAttributes.correlationId.StringValue);
    expect(ids[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z:[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Dispatched user ID batches to queue",
        correlationId: ids[0],
        awsRequestId: "req-8",
      }),
    );
  });
});

describe("notificationDispatcher handler", () => {
  it("reads the legacy partition and every shard", async () => {
    const { queried } = routeDynamo({});

    await handler(buildEventBridgeEvent());

    expect(queried).toEqual([LEGACY, ...ALL_SHARDS]);
    const queries = mockDynamoSend.mock.calls.map((call) => call[0].input).filter((i) => i.KeyConditionExpression);
    for (const query of queries) {
      expect(query.TableName).toBe("PendingBillNotifications");
      expect(query.KeyConditionExpression).toBe("#pk = :dispatch");
      expect(query.ProjectionExpression).toContain("markerType");
    }
  });

  it("reads DISPATCH_SHARD_COUNT shards", async () => {
    process.env.DISPATCH_SHARD_COUNT = "3";
    jest.resetModules();
    handler = require("../handlers/notificationDispatcher").handler;
    const { queried } = routeDynamo({});

    await handler(buildEventBridgeEvent());

    expect(queried).toEqual([LEGACY, `${LEGACY}#0`, `${LEGACY}#1`, `${LEGACY}#2`]);
  });

  it("merges users across the legacy partition and the shards and batches them to SQS", async () => {
    const partitions = markersByShard([marker("user-1"), marker("user-2"), marker("user-3")]);
    // Claims share the partitions with the markers and are not users.
    partitions[shardOf("user-2")].push(claimItem("user-8"));
    partitions[LEGACY] = [marker("user-1"), claimItem("user-9")];
    const { claims } = routeDynamo({ partitions });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 3, batchesSent: 1 });
    expect(mockSQSSend).toHaveBeenCalledTimes(1);
    const sqsCommand = mockSQSSend.mock.calls[0][0].input;
    expect(sqsCommand.QueueUrl).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/notification-processing");
    const [body] = sentBodies();
    expect([...body.userIds].sort()).toEqual(["user-1", "user-2", "user-3"]);
    // user-1 also has a marker from an older version, so both keys are handed to userNotifier.
    expect(body.dispatchPartitions).toEqual({
      "user-1": [shardOf("user-1"), LEGACY],
      "user-2": [shardOf("user-2")],
      "user-3": [shardOf("user-3")],
    });
    // Claims go to each user's shard, plus the legacy partition when a legacy marker exists.
    expect([...claims].sort()).toEqual(
      [
        `${shardOf("user-1")}|__claim__#user-1`,
        `${LEGACY}|__claim__#user-1`,
        `${shardOf("user-2")}|__claim__#user-2`,
        `${shardOf("user-3")}|__claim__#user-3`,
      ].sort(),
    );
  });

  it("handles pagination within a partition", async () => {
    const { queried } = routeDynamo({
      partitions: {
        [ALL_SHARDS[4]]: [
          [marker("user-1"), marker("user-2")],
          [marker("user-3"), marker("user-4")],
        ],
      },
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result.distinctUsers).toBe(4);
    expect(queried.filter((partition) => partition === ALL_SHARDS[4])).toHaveLength(2);
    const secondPage = mockDynamoSend.mock.calls.map((call) => call[0].input).find((input) => input.ExclusiveStartKey);
    expect(secondPage.ExpressionAttributeValues[":dispatch"].S).toBe(ALL_SHARDS[4]);
  });

  it("batches userIds into groups of USER_BATCH_SIZE", async () => {
    routeDynamo({ partitions: { [LEGACY]: Array.from({ length: 75 }, (_, i) => marker(`user-${i}`)) } });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result.distinctUsers).toBe(75);
    // 75 users / 50 per batch = 2 batches, sent in one SQS call since QUEUE_BATCH_SIZE allows it.
    expect(result.batchesSent).toBe(2);
    expect(mockSQSSend).toHaveBeenCalledTimes(1);
    const bodies = sentBodies();
    expect(bodies.map((body) => body.userIds.length)).toEqual([50, 25]);
  });

  it("claims users oldest marker first", async () => {
    routeDynamo({
      partitions: {
        ...markersByShard([marker("user-new", 1_760_000_300), marker("user-old", 1_760_000_100)]),
        [LEGACY]: [marker("user-mid", 1_760_000_200)],
      },
    });
    acceptAllSqs();

    await handler(buildEventBridgeEvent());

    expect(sentBodies()[0].userIds).toEqual(["user-old", "user-mid", "user-new"]);
  });

  it("returns early when no pending notifications exist", async () => {
    routeDynamo({});

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 0, batchesSent: 0 });
    // Nine marker partitions, then the legacy full-table scan.
    expect(mockDynamoSend).toHaveBeenCalledTimes(10);
    expect(mockSQSSend).not.toHaveBeenCalled();
  });

  it("ignores dispatch (legacy and sharded) and dedupe partitions during the legacy fallback scan", async () => {
    const { claims } = routeDynamo({
      scanItems: [
        { userId: { S: "__dispatch__" } },
        { userId: { S: "__dispatch__#3" } },
        { userId: { S: "__dedupe__" } },
        { userId: { S: "user-1" } },
        { userId: { S: "user-2" } },
        { userId: { S: "user-1" } },
      ],
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 2, batchesSent: 1 });
    const [body] = sentBodies();
    expect(body.userIds).toEqual(["user-1", "user-2"]);
    expect(body.dispatchPartitions).toEqual({ "user-1": [shardOf("user-1")], "user-2": [shardOf("user-2")] });
    expect(claims).toEqual([`${shardOf("user-1")}|__claim__#user-1`, `${shardOf("user-2")}|__claim__#user-2`]);
  });

  it("skips users that are already claimed by another dispatcher run", async () => {
    routeDynamo({
      partitions: markersByShard([marker("user-1"), marker("user-2")]),
      heldClaims: [`${shardOf("user-1")}|user-1`],
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 2, batchesSent: 1 });
    expect(sentBodies()[0].userIds).toEqual(["user-2"]);
  });

  it("skips a user whose legacy claim is held by an older dispatcher and releases its shard claim", async () => {
    const { released } = routeDynamo({
      partitions: { [LEGACY]: [marker("user-1"), marker("user-2")] },
      heldClaims: [`${LEGACY}|user-1`],
    });
    acceptAllSqs();

    await handler(buildEventBridgeEvent());

    expect(sentBodies()[0].userIds).toEqual(["user-2"]);
    // The shard claim taken before the legacy claim failed is given back, not held for the lease.
    expect(released).toEqual([`${shardOf("user-1")}|__claim__#user-1`]);
  });

  it("treats a ConditionalCheckFailed message without the exception name as an already-claimed user", async () => {
    routeDynamo({
      partitions: { [LEGACY]: [marker("user-1"), marker("user-2")] },
      claimErrors: { "user-1": new Error("ConditionalCheckFailedException: already claimed") },
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 2, batchesSent: 1 });
    expect(sentBodies()[0].userIds).toEqual(["user-2"]);
  });

  it("sends every user it did claim, then fails the run when a claim write errors", async () => {
    const { released } = routeDynamo({
      partitions: { [LEGACY]: [marker("user-1"), marker("user-2"), marker("user-3")] },
      claimErrors: {
        [`${LEGACY}|user-2`]: Object.assign(new Error("Internal server error"), { name: "InternalServerError" }),
      },
    });
    acceptAllSqs();

    await expect(handler(buildEventBridgeEvent())).rejects.toThrow("Failed to claim 1 user(s) for dispatch");
    expect(sentBodies()[0].userIds).toEqual(["user-1", "user-3"]);
    // user-2 has only a legacy marker, so its shard claim came first and is released after the error.
    expect(released).toEqual([`${shardOf("user-2")}|__claim__#user-2`]);
  });

  it("claims with bounded concurrency", async () => {
    process.env.DISPATCH_CLAIM_CONCURRENCY = "4";
    jest.resetModules();
    handler = require("../handlers/notificationDispatcher").handler;
    let inFlight = 0;
    let maxInFlight = 0;
    const routed = routeDynamo({ partitions: { [LEGACY]: Array.from({ length: 40 }, (_, i) => marker(`user-${i}`)) } });
    const inner = mockDynamoSend.getMockImplementation()!;
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      if (!cmd.input.Item) return inner(cmd);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return inner(cmd);
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result.batchesSent).toBe(1);
    // Two claims per user (shard and legacy).
    expect(routed.claims).toHaveLength(80);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("stops before its timeout and leaves the unclaimed users for the next run", async () => {
    process.env.USER_BATCH_SIZE = "2";
    process.env.QUEUE_BATCH_SIZE = "1";
    jest.resetModules();
    const dispatch = require("../handlers/notificationDispatcher").handler as (
      event: ScheduledEvent,
      context?: unknown,
    ) => ReturnType<Handler>;
    let claimWrites = 0;
    const users = ["user-a", "user-b", "user-c", "user-d", "user-e", "user-f"];
    const { claims } = routeDynamo({
      partitions: markersByShard(users.map((userId, i) => marker(userId, 1_760_000_000 + i))),
      onClaim: () => {
        claimWrites += 1;
      },
    });
    // Reserve is a fifth of the 10 s left at the start (2 s); each claim "takes" 1.5 s.
    const context = { awsRequestId: "req-9", getRemainingTimeInMillis: () => 10_000 - claimWrites * 1_500 };
    acceptAllSqs();

    const result = await dispatch(buildEventBridgeEvent(), context);

    // Chunks of USER_BATCH_SIZE * QUEUE_BATCH_SIZE = 2 users; 10 s, 7 s and 4 s remain before each, all above 2 s.
    expect(result).toEqual({ status: "ok", distinctUsers: 6, batchesSent: 3 });
    expect(sentBodies().flatMap((body) => body.userIds)).toEqual(users);
    expect(claims).toHaveLength(6);

    // Same run with less time: stops after the first chunk and does not claim the rest.
    mockSQSSend.mockClear();
    claimWrites = 0;
    claims.length = 0;
    const shortContext = { awsRequestId: "req-10", getRemainingTimeInMillis: () => 5_000 - claimWrites * 1_500 };

    const partial = await dispatch(buildEventBridgeEvent(), shortContext);

    // Reserve 1 s: 5 s at the start, 2 s after the first chunk, -1 s after the second.
    expect(partial).toEqual({ status: "partial", distinctUsers: 6, batchesSent: 2 });
    expect(sentBodies().flatMap((body) => body.userIds)).toEqual(["user-a", "user-b", "user-c", "user-d"]);
    expect(claims).toHaveLength(4);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: "Stopped dispatch run early to stay within the timeout; the rest wait for the next run",
        deferredUsers: 2,
        reachedUsers: 4,
      }),
    );
  });

  it("retries entries SQS reports as failed", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    process.env.USER_BATCH_SIZE = "1";
    jest.resetModules();
    handler = require("../handlers/notificationDispatcher").handler;
    routeDynamo({ partitions: { [LEGACY]: [marker("user-1"), marker("user-2")] } });
    mockSQSSend
      .mockResolvedValueOnce({
        Successful: [{ Id: "batch-0" }],
        Failed: [{ Id: "batch-1", Code: "InternalError", SenderFault: false }],
      })
      .mockResolvedValueOnce({ Successful: [{ Id: "batch-1" }], Failed: [] });

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 2, batchesSent: 2 });
    expect(mockSQSSend).toHaveBeenCalledTimes(2);
    expect(mockSQSSend.mock.calls[1][0].input.Entries.map((entry: SqsEntry) => entry.Id)).toEqual(["batch-1"]);
  });

  it("throws when SQS keeps failing", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    routeDynamo({ partitions: { [LEGACY]: [marker("user-1")] } });
    mockSQSSend.mockResolvedValue({
      Successful: [],
      Failed: [{ Id: "batch-0", Code: "InternalError", Message: "Something went wrong", SenderFault: false }],
    });

    await expect(handler(buildEventBridgeEvent())).rejects.toThrow(
      "Failed to send 1 message(s) to SQS after 4 attempt(s)",
    );
    expect(mockSQSSend).toHaveBeenCalledTimes(4);
  });
});

describe("notificationDispatcher quiet hours (S5)", () => {
  const NOW = Date.parse("2026-10-29T03:00:00Z");
  const nowEpoch = NOW / 1000;
  // A claim userNotifier extended to the end of the user's quiet hours.
  const quietHold = (userId: string, untilEpoch: number) => ({
    ...claimItem(userId),
    leaseExpiresAtEpoch: { N: String(untilEpoch) },
    quietHoursUntilEpoch: { N: String(untilEpoch) },
    ttl: { N: String(untilEpoch) },
  });
  const inShard = (userId: string, ...items: unknown[]) => ({ [shardOf(userId)]: items });

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  it("reads the claims' lease and hold end with the markers", async () => {
    routeDynamo({ partitions: {} });
    acceptAllSqs();

    await handler(buildEventBridgeEvent());

    const projections = mockDynamoSend.mock.calls
      .map(([cmd]) => cmd.input)
      .filter((input) => input.KeyConditionExpression)
      .map((input) => input.ProjectionExpression);
    expect(new Set(projections)).toEqual(
      new Set([
        "#sk, targetUserId, markerType, updatedAtEpoch, leaseExpiresAtEpoch, quietHoursUntilEpoch, " +
          "holdUntilEpoch, holdReason",
      ]),
    );
  });

  it("leaves a user held for quiet hours out of the run, without trying to claim them", async () => {
    const { claims } = routeDynamo({
      partitions: {
        ...inShard("user-1", marker("user-1", 10), quietHold("user-1", nowEpoch + 5 * 3600)),
        ...inShard("user-2", marker("user-2", 20)),
      },
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 2, batchesSent: 1 });
    expect(sentBodies()[0].userIds).toEqual(["user-2"]);
    expect(claims).toEqual([`${shardOf("user-2")}|__claim__#user-2`]);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Scanned distinct user IDs", count: 2, heldForQuietHours: 1 }),
    );
  });

  it("sends nothing when every user is held, and says so", async () => {
    const { claims } = routeDynamo({
      partitions: inShard("user-1", marker("user-1", 10), quietHold("user-1", nowEpoch + 60)),
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 1, batchesSent: 0 });
    expect(claims).toEqual([]);
    expect(mockSQSSend).not.toHaveBeenCalled();
    expect(logLines(console.log).map((line) => line.message)).toContain(
      "Every user with pending notifications is in quiet hours",
    );
  });

  it("claims the user in the first run after the hold ends", async () => {
    const { claims } = routeDynamo({
      partitions: inShard("user-1", marker("user-1", 10), quietHold("user-1", nowEpoch - 1)),
    });
    acceptAllSqs();

    await handler(buildEventBridgeEvent());

    expect(sentBodies()[0].userIds).toEqual(["user-1"]);
    expect(claims).toEqual([`${shardOf("user-1")}|__claim__#user-1`]);
  });

  it("leaves an ordinary in-flight claim to the claim step, as before", async () => {
    const inFlight = { ...claimItem("user-1"), leaseExpiresAtEpoch: { N: String(nowEpoch + 600) } };
    routeDynamo({
      partitions: inShard("user-1", marker("user-1", 10), inFlight),
      heldClaims: [`${shardOf("user-1")}|user-1`],
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 1, batchesSent: 0 });
    expect(mockDynamoSend.mock.calls.some(([cmd]) => cmd.input.ConditionExpression)).toBe(true);
  });
});

describe("notificationDispatcher push pace (UX-33)", () => {
  const NOW = Date.parse("2026-10-29T15:00:00Z");
  const nowEpoch = NOW / 1000;
  // A claim userNotifier extended to the end of a hold, as it writes them since UX-33.
  const hold = (userId: string, untilEpoch: number, reason: "pace" | "quiet_hours") => ({
    ...claimItem(userId),
    leaseExpiresAtEpoch: { N: String(untilEpoch) },
    holdUntilEpoch: { N: String(untilEpoch) },
    holdReason: { S: reason },
    ...(reason === "quiet_hours" ? { quietHoursUntilEpoch: { N: String(untilEpoch) } } : {}),
    ttl: { N: String(untilEpoch) },
  });
  // The item userNotifier keeps next to the user's marker: when it last sent them a push.
  const paceItem = (userId: string, lastPushAtEpoch: number) => ({
    billId: { S: `__pace__#${userId}` },
    markerType: { S: "push-pace" },
    targetUserId: { S: userId },
    lastPushAtEpoch: { N: String(lastPushAtEpoch) },
  });
  const inShard = (userId: string, ...items: unknown[]) => ({ [shardOf(userId)]: items });

  beforeEach(() => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
  });

  it("leaves a user held for the push pace out of the run, without trying to claim them, and counts them", async () => {
    const { claims } = routeDynamo({
      partitions: {
        ...inShard("user-1", marker("user-1", 10), hold("user-1", nowEpoch + 2 * 3600, "pace")),
        ...inShard("user-2", marker("user-2", 20)),
      },
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 2, batchesSent: 1 });
    expect(sentBodies()[0].userIds).toEqual(["user-2"]);
    expect(claims).toEqual([`${shardOf("user-2")}|__claim__#user-2`]);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Scanned distinct user IDs",
        count: 2,
        heldForQuietHours: 0,
        heldForPace: 1,
      }),
    );
  });

  it("counts each hold by its reason, and says so when every user is held", async () => {
    routeDynamo({
      partitions: {
        ...inShard("user-1", marker("user-1", 10), hold("user-1", nowEpoch + 600, "pace")),
        ...inShard("user-3", marker("user-3", 30), hold("user-3", nowEpoch + 600, "quiet_hours")),
      },
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 2, batchesSent: 0 });
    expect(mockSQSSend).not.toHaveBeenCalled();
    const lines = logLines(console.log);
    expect(lines).toContainEqual(
      expect.objectContaining({ message: "Scanned distinct user IDs", heldForQuietHours: 1, heldForPace: 1 }),
    );
    expect(lines.map((line) => line.message)).toContain(
      "Every user with pending notifications is held for the quiet hours or the push pace",
    );
  });

  it("claims the user in the first run after the pace window ends, and folds nothing itself", async () => {
    const { claims } = routeDynamo({
      partitions: inShard("user-1", marker("user-1", 10), hold("user-1", nowEpoch - 1, "pace")),
    });
    acceptAllSqs();

    await handler(buildEventBridgeEvent());

    expect(sentBodies()[0].userIds).toEqual(["user-1"]);
    expect(claims).toEqual([`${shardOf("user-1")}|__claim__#user-1`]);
  });

  it("reads a pace item as neither a marker nor a claim", async () => {
    const { claims } = routeDynamo({
      partitions: {
        ...inShard("user-1", paceItem("user-1", nowEpoch - 600)),
        ...inShard("user-2", marker("user-2", 20), paceItem("user-2", nowEpoch - 600)),
      },
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    // user-1 has nothing pending; user-2 is dispatched (userNotifier decides whether their pace holds them).
    expect(result).toEqual({ status: "ok", distinctUsers: 1, batchesSent: 1 });
    expect(sentBodies()[0].userIds).toEqual(["user-2"]);
    expect(claims).toEqual([`${shardOf("user-2")}|__claim__#user-2`]);
  });

  it("holds a user until the later end when two partitions hold them", async () => {
    routeDynamo({
      partitions: {
        [LEGACY]: [marker("user-1", 10), hold("user-1", nowEpoch + 3600, "quiet_hours")],
        ...inShard("user-1", hold("user-1", nowEpoch - 60, "pace")),
      },
    });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 1, batchesSent: 0 });
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Scanned distinct user IDs", heldForQuietHours: 1, heldForPace: 0 }),
    );
  });
});

describe("notificationDispatcher APNs certificate expiry metric", () => {
  const platformApplicationArn = "arn:aws:sns:us-east-1:123456789012:app/APNS/BillBoard";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const START_MS = Date.parse("2026-09-24T12:00:00Z");

  let nowMs: number;

  beforeEach(() => {
    process.env.APNS_PLATFORM_APPLICATION_ARN = platformApplicationArn;
    jest.resetModules();
    handler = require("../handlers/notificationDispatcher").handler;

    nowMs = START_MS;
    jest.spyOn(Date, "now").mockImplementation(() => nowMs);
    // No pending users: marker query and legacy scan both come back empty.
    mockDynamoSend.mockResolvedValue({ Items: [] });
    mockCloudWatchSend.mockResolvedValue({});
    mockSnsSend.mockResolvedValue({
      Attributes: { AppleCertificateExpirationDate: new Date(START_MS + 124.6 * DAY_MS).toISOString() },
    });
  });

  const emittedDatums = () =>
    mockCloudWatchSend.mock.calls.map((call) => ({
      namespace: call[0].input.Namespace,
      data: call[0].input.MetricData,
    }));

  it("publishes the whole days left on the certificate", async () => {
    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 0, batchesSent: 0 });
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    expect(mockSnsSend.mock.calls[0][0].input).toEqual({ PlatformApplicationArn: platformApplicationArn });
    expect(emittedDatums()).toEqual([
      {
        namespace: "BillBoard/Notifications",
        data: [{ MetricName: "ApnsCertificateDaysRemaining", Unit: "Count", Value: 124 }],
      },
    ]);
  });

  it("reads the certificate at most once every 6 hours per container", async () => {
    await handler(buildEventBridgeEvent());
    nowMs += 5 * 60 * 1000;
    await handler(buildEventBridgeEvent());
    nowMs = START_MS + 6 * 60 * 60 * 1000 - 1;
    await handler(buildEventBridgeEvent());
    expect(mockSnsSend).toHaveBeenCalledTimes(1);

    nowMs = START_MS + 6 * 60 * 60 * 1000;
    await handler(buildEventBridgeEvent());
    expect(mockSnsSend).toHaveBeenCalledTimes(2);
    expect(emittedDatums()).toHaveLength(2);
  });

  it("does not fail the dispatch run when the certificate cannot be read", async () => {
    mockSnsSend.mockRejectedValueOnce(
      Object.assign(new Error("Access denied"), { name: "AuthorizationErrorException" }),
    );
    mockDynamoSend.mockReset();
    routeDynamo({ partitions: { [LEGACY]: [marker("user-1")] } });
    acceptAllSqs();

    const result = await handler(buildEventBridgeEvent());

    expect(result).toEqual({ status: "ok", distinctUsers: 1, batchesSent: 1 });
    expect(mockCloudWatchSend).not.toHaveBeenCalled();
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({ message: "Failed to read APNs certificate expiry", error: expect.anything() }),
    );
  });

  it("skips with a log when the platform application does not exist yet", async () => {
    mockSnsSend.mockRejectedValueOnce(
      Object.assign(new Error("PlatformApplication does not exist"), { name: "NotFoundException" }),
    );

    await expect(handler(buildEventBridgeEvent())).resolves.toEqual({
      status: "ok",
      distinctUsers: 0,
      batchesSent: 0,
    });
    expect(mockCloudWatchSend).not.toHaveBeenCalled();
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "APNs platform application not found; skipping certificate expiry metric",
        platformApplicationArn,
      }),
    );
  });

  it("does not fail the dispatch run when CloudWatch rejects the metric", async () => {
    mockCloudWatchSend.mockRejectedValueOnce(new Error("Throttling"));

    await expect(handler(buildEventBridgeEvent())).resolves.toEqual({
      status: "ok",
      distinctUsers: 0,
      batchesSent: 0,
    });
  });

  it("skips the metric when the platform application has no certificate expiry", async () => {
    mockSnsSend.mockResolvedValueOnce({ Attributes: { Enabled: "true" } });

    await handler(buildEventBridgeEvent());

    expect(mockCloudWatchSend).not.toHaveBeenCalled();
  });

  it("skips the check when no platform application is configured", async () => {
    delete process.env.APNS_PLATFORM_APPLICATION_ARN;
    jest.resetModules();
    handler = require("../handlers/notificationDispatcher").handler;

    await handler(buildEventBridgeEvent());

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(mockCloudWatchSend).not.toHaveBeenCalled();
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "APNS_PLATFORM_APPLICATION_ARN is not set; skipping APNs certificate expiry metric",
      }),
    );
  });
});

export {};
