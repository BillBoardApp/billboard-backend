import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";

import { dispatchShardPartitionValue } from "../shared/dispatchShards";
import { isPendingRowExpired, PENDING_ROW_TTL_SECONDS } from "../shared/pendingNotifications";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

/*
 * C1.3 with X6: the expired-push cutoff in UserNotifier. The pending notifications table is held in
 * memory and the rows are written by the real writer (writePendingNotification), so the cutoff is
 * checked against the ttl and createdAt the writer stamps, not against hand-made values: a unit
 * mismatch between the two would fail the round-trip tests below.
 *
 * PENDING_EXPIRY_MODE=enforce deletes a row past its 24-hour lifetime unsent. Any other value, or
 * none, is watch: the row is counted and logged "would_expire", then sent and deleted exactly as before.
 */

type Item = Record<string, AttributeValue>;

/** The input fields the fake DynamoDB and SNS read, across the commands UserNotifier and the writer send. */
interface FakeInput extends ConditionInput {
  TableName?: string;
  Key?: Item;
  TransactItems?: Array<{ Put: ConditionInput & { Item: Item } }>;
  RequestItems?: { Pending: Array<{ DeleteRequest: { Key: Item } }> };
  Message?: string;
}

/** What the fakes read from an AWS SDK command: its class's name and its input. */
interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

type Call = { name: string; input: FakeInput };

const mockTable = new Map<string, Item>();
const mockCalls: Call[] = [];
const mockPublishes: FakeInput[] = [];
let mockBatchWriteError: Error | undefined;

const tableKey = (userId: string, guid: string) => `${userId}|${guid}`;

const mockSend = async (cmd: FakeCommand): Promise<unknown> => {
  const name: string = cmd.constructor.name;
  const input = cmd.input;
  if (name !== "TransactWriteItemsCommand") mockCalls.push({ name, input });
  switch (name) {
    case "TransactWriteItemsCommand": {
      const puts = input.TransactItems!.map((entry) => entry.Put);
      const failed = puts.some(
        (put) => !evaluateCondition(mockTable.get(tableKey(put.Item.userId.S!, put.Item.guid.S!)), put),
      );
      if (failed) throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException" });
      for (const put of puts) mockTable.set(tableKey(put.Item.userId.S!, put.Item.guid.S!), put.Item);
      return {};
    }
    case "QueryCommand": {
      if (input.TableName === "Devices") {
        return { Items: [{ user_id: { S: "u1" }, device_id: { S: "d1" }, endpointArn: { S: ENDPOINT_ARN } }] };
      }
      const userId = input.ExpressionAttributeValues![":userId"].S;
      return { Items: [...mockTable.values()].filter((item) => item.userId.S === userId) };
    }
    case "GetItemCommand":
      return { Item: mockTable.get(tableKey(input.Key!.userId.S!, input.Key!.guid.S!)) };
    case "DeleteItemCommand": {
      const key = tableKey(input.Key!.userId.S!, input.Key!.guid.S!);
      if (!evaluateCondition(mockTable.get(key), input)) throw conditionalCheckFailed();
      mockTable.delete(key);
      return {};
    }
    case "BatchWriteItemCommand":
      if (mockBatchWriteError) throw mockBatchWriteError;
      for (const request of input.RequestItems!.Pending) {
        mockTable.delete(tableKey(request.DeleteRequest.Key.userId.S!, request.DeleteRequest.Key.guid.S!));
      }
      return {};
    default:
      throw new Error(`Unexpected DynamoDB call ${name}: ${JSON.stringify(input)}`);
  }
};

jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
}));
jest.mock("@aws-sdk/client-sns", () => ({
  ...jest.requireActual("@aws-sdk/client-sns"),
  SNSClient: jest.fn(() => ({
    send: async (cmd: FakeCommand) => {
      mockCalls.push({ name: cmd.constructor.name, input: cmd.input });
      mockPublishes.push(cmd.input);
      return { MessageId: "m" };
    },
  })),
}));

const ENDPOINT_ARN = "arn:aws:sns:us-east-1:1:endpoint/APNS/app/d1";
const HOUR = 3600;
const DAY = 24 * HOUR;
// The time the rows are written, in epoch seconds.
const T = 1_760_000_000;
const shard = dispatchShardPartitionValue("__dispatch__", "u1", 8);

const originalEnv = { ...process.env };
let restoreEnv: (() => void) | undefined;

const notifierEvent = (): SQSEvent =>
  ({
    Records: [{ messageId: "m1", body: JSON.stringify({ userIds: ["u1"], dispatchPartitions: { u1: [shard] } }) }],
  }) as unknown as SQSEvent;

beforeEach(() => {
  jest.resetModules();
  mockTable.clear();
  mockCalls.length = 0;
  mockPublishes.length = 0;
  mockBatchWriteError = undefined;
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    jest.spyOn(console, method).mockImplementation();
  }
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

/** Loads the writer and UserNotifier with PENDING_EXPIRY_MODE set to `mode` (unset when undefined). */
const load = (mode: string | undefined) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      PENDING_NOTIFICATIONS_TABLE: "Pending",
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "guid",
      DEVICE_TABLE: "Devices",
      USER_ID_ATTRIBUTE: "user_id",
      DEVICE_ID_ATTRIBUTE: "device_id",
      MANIFEST_TABLE_NAME: undefined,
      AWS_LAMBDA_LOG_FORMAT: undefined,
      PENDING_EXPIRY_MODE: mode,
    },
    { replace: true, base: originalEnv },
  );
  const pending = require("../shared/pendingNotifications");
  const store = pending.pendingNotificationStoreConfigFromEnv();
  const now = jest.spyOn(Date, "now");
  /** Writes bill `billId`'s pending row (and the user's marker) as the real writer does at `atSeconds`. */
  const writeAt = async (atSeconds: number, billId: string, notificationType = "new") => {
    now.mockReturnValue(atSeconds * 1000);
    await pending.writePendingNotification({ send: mockSend }, store, {
      userId: "u1",
      billId,
      billTitle: `Bill ${billId}`,
      category: "Defense",
      lifeArea: "",
      notificationType,
    });
  };
  const handler: (event: SQSEvent) => Promise<SQSBatchResponse> = require("../handlers/userNotifier").handler;
  /** Runs UserNotifier at `atMs` (epoch milliseconds), recording only its own AWS calls. */
  const runAt = async (atMs: number) => {
    now.mockReturnValue(atMs);
    mockCalls.length = 0;
    return handler(notifierEvent());
  };
  return { writeAt, runAt };
};

const pendingRows = () =>
  [...mockTable.values()]
    .filter((item) => item.userId.S === "u1")
    .map((item) => String(item.guid.S))
    .sort();
const dispatchState = () =>
  [...mockTable.values()].filter((item) => item.userId.S === shard).map((item) => item.guid.S);
const expiryMetrics = () =>
  logLines(console.log).filter((line) => line._aws && "NotificationsExpiredUndelivered" in line);
const outcomes = () => logLines(console.log).filter((line) => line.message === "Bill notification outcome");
const pushedApns = () => mockPublishes.map((input) => JSON.parse(JSON.parse(input.Message!).APNS));
const callNames = () =>
  mockCalls.map((call) => `${call.name}${call.input?.TableName ? `:${call.input.TableName}` : ""}`);

describe("isPendingRowExpired (C1.3)", () => {
  const now = T + DAY;

  it("lets the row's own ttl decide: expired at ttl, not one second before", () => {
    expect(isPendingRowExpired({ ttl: now, createdAt: T }, now)).toBe(true);
    expect(isPendingRowExpired({ ttl: now - 1 }, now)).toBe(true);
    expect(isPendingRowExpired({ ttl: now + 1, createdAt: T - 30 * DAY }, now)).toBe(false);
  });

  it("falls back to createdAt plus the 24-hour lifetime when there is no usable ttl", () => {
    expect(PENDING_ROW_TTL_SECONDS).toBe(DAY);
    expect(isPendingRowExpired({ createdAt: now - DAY }, now)).toBe(true);
    expect(isPendingRowExpired({ createdAt: now - DAY + 1 }, now)).toBe(false);
    expect(isPendingRowExpired({ ttl: Number.NaN, createdAt: now - DAY }, now)).toBe(true);
  });

  it("never expires a row with neither value, or one stamped in milliseconds", () => {
    expect(isPendingRowExpired({}, now)).toBe(false);
    expect(isPendingRowExpired({ ttl: Number.POSITIVE_INFINITY }, now)).toBe(false);
    expect(isPendingRowExpired({ ttl: (T + DAY) * 1000 }, now)).toBe(false);
    expect(isPendingRowExpired({ createdAt: T * 1000 }, now)).toBe(false);
  });
});

describe("PENDING_EXPIRY_MODE=enforce (C1.3)", () => {
  it("publishes a row the real writer stamped at T until T + 24 h - 1 s", async () => {
    const { writeAt, runAt } = load("enforce");
    await writeAt(T, "B1");

    const result = await runAt((T + DAY - 1) * 1000);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(pushedApns().map((apns) => apns.billId)).toEqual(["B1"]);
    expect(pendingRows()).toEqual([]);
    expect(dispatchState()).toEqual([]);
    expect(expiryMetrics()).toEqual([]);
    expect(outcomes().map((line) => line.outcome)).toEqual(["delivered"]);
  });

  it("deletes the same row unsent at T + 24 h, counts it and logs it expired", async () => {
    const { writeAt, runAt } = load("enforce");
    await writeAt(T, "B1");

    const result = await runAt((T + DAY) * 1000);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockPublishes).toEqual([]);
    expect(pendingRows()).toEqual([]);
    // The dispatch state is released, so the dispatcher stops handing the user over.
    expect(dispatchState()).toEqual([]);
    expect(expiryMetrics()).toEqual([
      expect.objectContaining({
        NotificationsExpiredUndelivered: 1,
        pendingExpiryMode: "enforce",
        userId: "u1",
        _aws: expect.objectContaining({
          CloudWatchMetrics: [
            {
              Namespace: "BillBoard/Notifications",
              Dimensions: [[]],
              Metrics: [{ Name: "NotificationsExpiredUndelivered", Unit: "Count" }],
            },
          ],
        }),
      }),
    ]);
    expect(outcomes()).toEqual([
      expect.objectContaining({
        guid: "B1",
        userId: "u1",
        outcome: "expired",
        notificationType: "new",
        ageSeconds: DAY,
        createdAt: T,
        ttl: T + DAY,
        pendingExpiryMode: "enforce",
      }),
    ]);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: "Deleted pending notifications past their lifetime unsent",
        userId: "u1",
        pendingKeys: ["B1#new"],
      }),
    );
    // No device read and no push: rows, then markers, then claims.
    expect(callNames()).toEqual([
      "GetItemCommand:Pending",
      "QueryCommand:Pending",
      "BatchWriteItemCommand",
      "DeleteItemCommand:Pending",
      "DeleteItemCommand:Pending",
    ]);
  });

  it("sends one push listing only the fresh bills and deletes both sets", async () => {
    const { writeAt, runAt } = load("enforce");
    await writeAt(T - 2 * HOUR, "OLD1");
    await writeAt(T - HOUR, "OLD2", "updated");
    await writeAt(T + DAY - HOUR, "FRESH1");
    await writeAt(T + DAY - 60, "FRESH2");

    const result = await runAt((T + DAY) * 1000);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(pushedApns()).toHaveLength(1);
    expect(pushedApns()[0]).toMatchObject({
      billIds: ["FRESH1", "FRESH2"],
      billCount: 2,
      aps: { alert: { title: "2 New Bills for You" } },
    });
    expect(pendingRows()).toEqual([]);
    expect(dispatchState()).toEqual([]);
    expect(expiryMetrics().map((line) => line.NotificationsExpiredUndelivered)).toEqual([2]);
    expect(outcomes().map((line) => [line.guid, line.outcome])).toEqual([
      ["OLD1", "expired"],
      ["OLD2", "expired"],
      ["FRESH1", "delivered"],
      ["FRESH2", "delivered"],
    ]);
    // The expired rows are deleted before anything is published.
    const deletedFirst = mockCalls.find((call) => call.name === "BatchWriteItemCommand")!;
    expect(deletedFirst.input.RequestItems!.Pending.map((request) => request.DeleteRequest.Key.guid.S)).toEqual([
      "OLD1#new",
      "OLD2#updated",
    ]);
    expect(mockCalls.indexOf(deletedFirst)).toBeLessThan(mockCalls.findIndex((call) => call.name === "PublishCommand"));
  });

  it("with every row expired makes no SNS call, deletes the rows and releases the dispatch state", async () => {
    const { writeAt, runAt } = load("enforce");
    await writeAt(T - 3 * DAY, "B1");
    await writeAt(T - 2 * DAY, "B2", "passed");

    const result = await runAt(T * 1000);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockPublishes).toEqual([]);
    expect(callNames()).not.toContain("QueryCommand:Devices");
    expect(pendingRows()).toEqual([]);
    expect(dispatchState()).toEqual([]);
    expect(expiryMetrics().map((line) => line.NotificationsExpiredUndelivered)).toEqual([2]);
    expect(outcomes().map((line) => [line.guid, line.outcome, line.ageSeconds])).toEqual([
      ["B1", "expired", 3 * DAY],
      ["B2", "expired", 2 * DAY],
    ]);
  });

  it("expires a row without ttl by its createdAt, and sends a row with neither", async () => {
    const { writeAt, runAt } = load("enforce");
    await writeAt(T - DAY, "NO_TTL");
    await writeAt(T - 30 * DAY, "NEITHER");
    delete mockTable.get(tableKey("u1", "NO_TTL#new"))!.ttl;
    const neither = mockTable.get(tableKey("u1", "NEITHER#new"))!;
    delete neither.ttl;
    delete neither.createdAt;

    const result = await runAt(T * 1000);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(pushedApns().map((apns) => apns.billId)).toEqual(["NEITHER"]);
    expect(pendingRows()).toEqual([]);
    expect(outcomes().map((line) => [line.guid, line.outcome])).toEqual([
      ["NO_TTL", "expired"],
      ["NEITHER", "delivered"],
    ]);
    expect(outcomes()[0]).not.toHaveProperty("ttl");
  });

  it("reads only a numeric Number attribute as ttl, and otherwise falls back to createdAt", async () => {
    const { writeAt, runAt } = load("enforce");
    await writeAt(T - DAY, "STRING_TTL");
    await writeAt(T - DAY, "EMPTY_TTL");
    await writeAt(T - DAY, "TEXT_TTL");
    await writeAt(T - HOUR, "FRESH_STRING_TTL");
    mockTable.get(tableKey("u1", "STRING_TTL#new"))!.ttl = { S: String(T + DAY) };
    mockTable.get(tableKey("u1", "EMPTY_TTL#new"))!.ttl = { N: " " };
    mockTable.get(tableKey("u1", "TEXT_TTL#new"))!.ttl = { N: "soon" };
    mockTable.get(tableKey("u1", "FRESH_STRING_TTL#new"))!.ttl = { S: String(T - DAY) };

    await runAt(T * 1000);

    expect(outcomes().map((line) => [line.guid, line.outcome])).toEqual([
      ["STRING_TTL", "expired"],
      ["EMPTY_TTL", "expired"],
      ["TEXT_TTL", "expired"],
      ["FRESH_STRING_TTL", "delivered"],
    ]);
    expect(pushedApns().map((apns) => apns.billId)).toEqual(["FRESH_STRING_TTL"]);
  });

  it("fails the record and publishes nothing when the expired rows cannot be deleted", async () => {
    const { writeAt, runAt } = load("enforce");
    await writeAt(T - 2 * DAY, "OLD");
    await writeAt(T - HOUR, "FRESH");
    mockBatchWriteError = Object.assign(new Error("Throttled"), { name: "ProvisionedThroughputExceededException" });

    const result = await runAt(T * 1000);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(mockPublishes).toEqual([]);
    expect(pendingRows()).toEqual(["FRESH#new", "OLD#new"]);
    // Nothing released: the retry finds the rows and the marker again.
    expect(dispatchState()).toEqual(["u1"]);
    // Counted once deleted, so the retry that deletes them counts them.
    expect(expiryMetrics()).toEqual([]);
    expect(outcomes()).toEqual([]);
  });
});

describe("PENDING_EXPIRY_MODE=watch, the shipped mode (X6)", () => {
  /** The AWS calls of one run, with the random marker versions masked. */
  const normalizedCalls = () =>
    mockCalls.map(({ name, input }) => {
      const text = JSON.stringify(input).replace(/"S":"[0-9a-f-]{36}"/g, '"S":"<markerVersion>"');
      return { name, input: JSON.parse(text) };
    });

  /** A run where the row is fresh (1 h old) and one where it is past its lifetime (25 h old). */
  const freshAndExpiredRuns = async (mode: string | undefined) => {
    const runs: { calls: Call[]; result: SQSBatchResponse; rows: string[]; metrics: number; outcomes: string[] }[] = [];
    for (const ageSeconds of [HOUR, DAY + HOUR]) {
      jest.resetModules();
      mockTable.clear();
      mockPublishes.length = 0;
      (console.log as jest.Mock).mockClear();
      const { writeAt, runAt } = load(mode);
      await writeAt(T, "B1", "passed");
      const result = await runAt((T + ageSeconds) * 1000);
      runs.push({
        calls: normalizedCalls(),
        result,
        rows: pendingRows(),
        metrics: expiryMetrics().length,
        outcomes: outcomes().map((line) => line.outcome as string),
      });
    }
    return { fresh: runs[0], expired: runs[1] };
  };

  it("sends and deletes an expired row with exactly the AWS calls of a fresh one, and counts it", async () => {
    const { fresh, expired } = await freshAndExpiredRuns(undefined);

    expect(expired.calls).toEqual(fresh.calls);
    expect(expired.calls.map((call) => call.name)).toEqual([
      "GetItemCommand",
      "QueryCommand",
      "QueryCommand",
      "PublishCommand",
      "BatchWriteItemCommand",
      "DeleteItemCommand",
      "DeleteItemCommand",
    ]);
    expect(expired.result).toEqual({ batchItemFailures: [] });
    expect(fresh.result).toEqual({ batchItemFailures: [] });
    expect(expired.rows).toEqual([]);
    // Only the expired run writes the metric and the would_expire line; both get today's delivered line.
    expect(fresh.metrics).toBe(0);
    expect(fresh.outcomes).toEqual(["delivered"]);
    expect(expired.metrics).toBe(1);
    expect(expired.outcomes).toEqual(["would_expire", "delivered"]);
  });

  it("counts and logs the expired row as would_expire with its age", async () => {
    const { writeAt, runAt } = load(undefined);
    await writeAt(T, "B1", "passed");

    await runAt((T + DAY + HOUR) * 1000);

    expect(pushedApns().map((apns) => [apns.billId, apns.aps.alert.body])).toEqual([
      ["B1", "It passed a vote in Congress."],
    ]);
    expect(expiryMetrics()).toEqual([
      expect.objectContaining({ NotificationsExpiredUndelivered: 1, pendingExpiryMode: "watch" }),
    ]);
    expect(outcomes()[0]).toEqual(
      expect.objectContaining({
        guid: "B1",
        outcome: "would_expire",
        ageSeconds: DAY + HOUR,
        createdAt: T,
        ttl: T + DAY,
        pendingExpiryMode: "watch",
      }),
    );
    expect(logLines(console.warn)).toEqual([]);
  });

  it.each([["watch"], [""], ["Enforce"], ["ENFORCE"], [" enforce"], ["enforce "], ["on"], ["true"]])(
    "treats PENDING_EXPIRY_MODE=%j as watch",
    async (mode) => {
      const { fresh, expired } = await freshAndExpiredRuns(mode);

      expect(expired.calls).toEqual(fresh.calls);
      expect(expired.calls.map((call) => call.name)).toContain("PublishCommand");
      expect(expired.rows).toEqual([]);
      expect(expired.metrics).toBe(1);
      expect(expired.outcomes).toEqual(["would_expire", "delivered"]);
      expect(expiryMetrics()[0].pendingExpiryMode).toBe("watch");
    },
  );

  it("writes no metric and no extra line in normal running", async () => {
    const { writeAt, runAt } = load(undefined);
    await writeAt(T, "B1");
    await writeAt(T + 60, "B2");

    await runAt((T + 5 * 60) * 1000);

    expect(pushedApns()).toHaveLength(1);
    expect(expiryMetrics()).toEqual([]);
    expect(outcomes().map((line) => line.outcome)).toEqual(["delivered", "delivered"]);
  });

  it("still delivers when the expiry metric and log lines throw", async () => {
    (console.log as jest.Mock).mockImplementation((line: unknown) => {
      const text = String(line);
      if (text.includes('"NotificationsExpiredUndelivered"') || text.includes('"would_expire"')) {
        throw new Error("console.log broke");
      }
    });
    const { writeAt, runAt } = load(undefined);
    await writeAt(T, "B1");

    const result = await runAt((T + 2 * DAY) * 1000);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(pushedApns().map((apns) => apns.billId)).toEqual(["B1"]);
    expect(pendingRows()).toEqual([]);
    expect(dispatchState()).toEqual([]);
    const attempted = (console.log as jest.Mock).mock.calls.map(([line]) => String(line));
    expect(attempted.filter((line) => line.includes('"NotificationsExpiredUndelivered"'))).toHaveLength(1);
    expect(attempted.filter((line) => line.includes('"would_expire"'))).toHaveLength(1);
  });
});
