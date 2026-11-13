import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { dispatchShardPartitionValue } from "../shared/dispatchShards";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

/*
 * UX-33 (feature review 2026-10-28, S5; project decisions that day and later): userNotifier's push pace and its "vote
 * again" check.
 * - At most one push every PUSH_PACE_HOURS (3) per user: a push that reaches a device records the time in a
 *   `__pace__#<user>` item in the user's dispatch shard; rows that arrive inside the window are held like the quiet
 *   hours hold them (the claim extended to the window's end) and go out folded in the first dispatch after it.
 * - "updated" rows ("vote again") count toward the pace but go on a push of their own; a device's second push of one
 *   dispatch is silent.
 * - A held "updated" row is dropped when the user voted on the bill after it was written.
 * - Held, folded, dropped and sent rows are counted.
 * - A change that added an action and passed or failed the bill sends each device one push: the outcome where the
 *   device takes that outcome's pushes, else the action (project decision 2026-10-29, "one event, per phone").
 */

/** The DynamoDB input fields the fake and the assertions read, across the commands UserNotifier sends. */
interface FakeDynamoInput {
  TableName?: string;
  Key?: Record<string, AttributeValue>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  RequestItems?: { Pending: Array<{ DeleteRequest: { Key: Record<string, AttributeValue> } }> };
}

/** What the mocked command constructors return: the kind of command and its input. */
interface FakeDynamoCommand {
  kind: string;
  input: FakeDynamoInput;
}
interface FakeSnsCommand {
  input: { TargetArn?: string; Message?: string };
}

const originalEnv = { ...process.env };
const mockSend = jest.fn();
const mockSnsSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: (cmd: FakeDynamoCommand) => mockSend(cmd) })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input, kind: "GetItem" })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input, kind: "Query" })),
  UpdateItemCommand: jest.fn().mockImplementation((input) => ({ input, kind: "UpdateItem" })),
  BatchWriteItemCommand: jest.fn().mockImplementation((input) => ({ input, kind: "BatchWriteItem" })),
  DeleteItemCommand: jest.fn().mockImplementation((input) => ({ input, kind: "DeleteItem" })),
}));
jest.mock("@aws-sdk/client-sns", () => ({
  SNSClient: jest.fn(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const USER = "user-1";
const SHARD = dispatchShardPartitionValue("__dispatch__", USER, 8);
const PACE_KEY = `__pace__#${USER}`;
const HOUR = 3600;
const at = (iso: string) => Date.parse(iso);
const epochOf = (iso: string) => Date.parse(iso) / 1000;

/** 2 PM EDT on a Thursday: outside the quiet hours of a New York user. */
const NOW = "2026-10-29T18:00:00Z";
const NOW_EPOCH = epochOf(NOW);

const pendingRow = (guid: string, type: string, createdAt = NOW_EPOCH - 600) => ({
  userId: { S: USER },
  billId: { S: `${guid}#${type}` },
  sourceBillId: { S: guid },
  billTitle: { S: `Title of ${guid}` },
  category: { S: "Bill Alert" },
  lifeArea: { S: "" },
  notificationType: { S: type },
  createdAt: { N: String(createdAt) },
  ttl: { N: String(createdAt + 24 * HOUR) },
});

type Device = {
  id: string;
  notifyNew?: boolean;
  notifyUpdated?: boolean;
  notifyAlert?: boolean;
  notifyPassed?: boolean;
  notifyFailed?: boolean;
};

/**
 * Pending rows; an "updated" row may also carry `changedAtMs`, and an action row of an outcome change `pairedOutcome`
 * (UX-33).
 */
let rows: Array<ReturnType<typeof pendingRow> & Record<string, { S: string } | { N: string }>>;
let lastPushAtEpoch: number | "error" | undefined;
/** The user's votes: bill guid to votedAt (ISO), or "error" for a read that fails. */
let votes: Record<string, string | "error">;
let devices: Device[];
let failPaceWrite: boolean;

const load = (env: Record<string, string | undefined>) => {
  applyTestEnv(
    {
      PENDING_NOTIFICATIONS_TABLE: "Pending",
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
      DEVICE_TABLE: "Devices",
      USER_ID_ATTRIBUTE: "user_id",
      DEVICE_ID_ATTRIBUTE: "device_id",
      PII_TABLE_NAME: "UserPII",
      PII_PARTITION_KEY: "userId",
      QUIET_HOURS: "on",
      PUSH_PACE_HOURS: "3",
      FEEDBACK_TABLE_NAME: "UserFeedback",
      FEEDBACK_PARTITION_KEY: "userId",
      FEEDBACK_SORT_KEY: "billId",
      ...env,
    },
    { replace: true, base: originalEnv },
  );
  jest.resetModules();
  return require("../handlers/userNotifier").handler as (event: SQSEvent) => Promise<{ batchItemFailures: unknown[] }>;
};

const sqsEvent = (): SQSEvent =>
  ({
    Records: [
      {
        messageId: "m-0",
        body: JSON.stringify({ userIds: [USER], dispatchPartitions: { [USER]: [SHARD] } }),
        attributes: {},
        messageAttributes: {},
      },
    ],
  }) as unknown as SQSEvent;

/** Runs the handler at `nowIso` for one user handed over in their shard. */
const runAt = async (nowIso: string = NOW, env: Record<string, string | undefined> = {}) => {
  const handler = load(env);
  jest.spyOn(Date, "now").mockReturnValue(at(nowIso));
  return handler(sqsEvent());
};

const calls = (kind: string) =>
  mockSend.mock.calls.map(([cmd]: [FakeDynamoCommand]) => cmd).filter((cmd) => cmd.kind === kind);
const paceReads = () => calls("GetItem").filter((cmd) => cmd.input.Key!.billId?.S === PACE_KEY);
const paceWrites = () => calls("UpdateItem").filter((cmd) => cmd.input.Key!.billId?.S === PACE_KEY);
const claimHolds = () => calls("UpdateItem").filter((cmd) => cmd.input.Key!.billId?.S === `__claim__#${USER}`);
const voteReads = () => calls("GetItem").filter((cmd) => cmd.input.TableName === "UserFeedback");
const deletedRowKeys = () =>
  calls("BatchWriteItem").flatMap((cmd) =>
    cmd.input.RequestItems!.Pending.map((request) => request.DeleteRequest.Key.billId.S),
  );
const pushes = () =>
  mockSnsSend.mock.calls.map(([cmd]: [FakeSnsCommand]) => ({
    target: cmd.input.TargetArn as string,
    apns: JSON.parse(JSON.parse(cmd.input.Message!).APNS),
  }));
const outcomes = () =>
  logLines(console.log)
    .filter((line) => line.message === "Bill notification outcome")
    .map((line) => [line.guid, line.outcome]);
const metricLines = () => logLines(console.log).filter((line) => line._aws);

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  rows = [pendingRow("BILLS-119hr1", "alert"), pendingRow("BILLS-119hr2", "new")];
  lastPushAtEpoch = undefined;
  votes = {};
  devices = [{ id: "phone" }];
  failPaceWrite = false;
  mockSend.mockReset();
  mockSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
    const input = cmd.input;
    if (cmd.kind === "GetItem" && input.TableName === "UserPII") return { Item: { resolvedState: { S: "NY" } } };
    if (cmd.kind === "GetItem" && input.TableName === "UserFeedback") {
      const vote = votes[input.Key!.billId.S!];
      if (vote === "error") throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
      return vote ? { Item: { votedAt: { S: vote } } } : {};
    }
    if (cmd.kind === "GetItem" && input.Key!.billId?.S === PACE_KEY) {
      if (lastPushAtEpoch === "error") throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
      return lastPushAtEpoch === undefined ? {} : { Item: { lastPushAtEpoch: { N: String(lastPushAtEpoch) } } };
    }
    if (cmd.kind === "GetItem") return { Item: { markerVersion: { S: "v1" } } };
    if (cmd.kind === "Query" && input.TableName === "Pending") return { Items: rows };
    if (cmd.kind === "Query" && input.TableName === "Devices") {
      return {
        Items: devices.map((device) => ({
          user_id: { S: USER },
          device_id: { S: device.id },
          endpointArn: { S: `arn:aws:sns:x:endpoint/APNS/a/${device.id}` },
          ...(device.notifyNew === false ? { notifyNew: { BOOL: false } } : {}),
          ...(device.notifyUpdated === false ? { notifyUpdated: { BOOL: false } } : {}),
          ...(device.notifyAlert === false ? { notifyAlert: { BOOL: false } } : {}),
          ...(device.notifyPassed === false ? { notifyPassed: { BOOL: false } } : {}),
          ...(device.notifyFailed === false ? { notifyFailed: { BOOL: false } } : {}),
        })),
      };
    }
    if (cmd.kind === "UpdateItem" && input.Key!.billId?.S === PACE_KEY && failPaceWrite) {
      throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    }
    return {};
  });
  mockSnsSend.mockReset();
  mockSnsSend.mockResolvedValue({ MessageId: "m" });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("the push pace in userNotifier (UX-33)", () => {
  it("holds a user pushed an hour ago until 3 hours after that push: nothing is sent or deleted", async () => {
    lastPushAtEpoch = NOW_EPOCH - HOUR;

    expect(await runAt()).toEqual({ batchItemFailures: [] });

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(calls("BatchWriteItem")).toEqual([]);
    expect(calls("DeleteItem")).toEqual([]);
    expect(paceReads().map((cmd) => cmd.input)).toEqual([
      {
        TableName: "Pending",
        Key: { userId: { S: SHARD }, billId: { S: PACE_KEY } },
        ProjectionExpression: "lastPushAtEpoch",
        ConsistentRead: true,
      },
    ]);
    const until = String(NOW_EPOCH + 2 * HOUR);
    expect(claimHolds().map((cmd) => cmd.input)).toEqual([
      {
        TableName: "Pending",
        Key: { userId: { S: SHARD }, billId: { S: `__claim__#${USER}` } },
        UpdateExpression:
          "SET #markerType = :claim, #targetUserId = :userId, #lease = :until, #holdUntil = :until, " +
          "#holdReason = :reason, #ttl = :until",
        ExpressionAttributeNames: {
          "#markerType": "markerType",
          "#targetUserId": "targetUserId",
          "#lease": "leaseExpiresAtEpoch",
          "#holdUntil": "holdUntilEpoch",
          "#holdReason": "holdReason",
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: {
          ":claim": { S: "dispatch-claim" },
          ":userId": { S: USER },
          ":until": { N: until },
          ":reason": { S: "pace" },
        },
      },
    ]);
    const held = logLines(console.log).filter((line) => line.outcome === "held");
    expect(held.map((line) => [line.guid, line.heldUntil, line.holdReason])).toEqual([
      ["BILLS-119hr1", "2026-10-29T20:00:00.000Z", "pace"],
      ["BILLS-119hr2", "2026-10-29T20:00:00.000Z", "pace"],
    ]);
    expect(logLines(console.log).map((line) => line.message)).toContain(
      "Holding pending notifications for the push pace",
    );
    expect(metricLines()).toEqual([expect.objectContaining({ NotificationsHeldPace: 2, holdReason: "pace" })]);
    // No vote is read for a held row.
    expect(voteReads()).toEqual([]);
  });

  it("holds an 'updated' row too: vote again counts toward the pace", async () => {
    lastPushAtEpoch = NOW_EPOCH - HOUR;
    rows = [pendingRow("BILLS-119hr3", "updated")];

    await runAt();

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(claimHolds()).toHaveLength(1);
  });

  it("holds until 8 AM when the window ends in the quiet hours", async () => {
    // 8 PM EDT; the last push at 7 PM opens a window to 10 PM, in the quiet hours.
    lastPushAtEpoch = epochOf("2026-10-29T23:00:00Z");

    await runAt("2026-10-30T00:00:00Z");

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(claimHolds()[0].input.ExpressionAttributeValues).toEqual(
      expect.objectContaining({ ":until": { N: String(epochOf("2026-10-30T12:00:00Z")) }, ":reason": { S: "pace" } }),
    );
  });

  it("sends once the window has ended, folding the rows of one type into one push that keeps the type", async () => {
    lastPushAtEpoch = NOW_EPOCH - 3 * HOUR;
    rows = [
      pendingRow("BILLS-119hr1", "new", NOW_EPOCH - 2 * HOUR),
      pendingRow("BILLS-119hr2", "new", NOW_EPOCH - HOUR),
      pendingRow("BILLS-119hr3", "new", NOW_EPOCH - 60),
    ];

    await runAt();

    expect(pushes().map(({ apns }) => [apns.aps.alert.title, apns.notificationType, apns.aps.sound])).toEqual([
      ["3 New Bills for You", "new", "default"],
    ]);
    expect(claimHolds()).toEqual([]);
    expect(metricLines()).toEqual([
      expect.objectContaining({ PushesSent: 1, NotificationsDelivered: 3, NotificationsFolded: 2 }),
    ]);
  });

  it("records the push so the next window opens, before the dispatch state is released", async () => {
    await runAt();

    expect(paceWrites().map((cmd) => cmd.input)).toEqual([
      {
        TableName: "Pending",
        Key: { userId: { S: SHARD }, billId: { S: PACE_KEY } },
        UpdateExpression: "SET #markerType = :pace, #targetUserId = :userId, #lastPush = :at, #ttl = :ttl",
        ExpressionAttributeNames: {
          "#markerType": "markerType",
          "#targetUserId": "targetUserId",
          "#lastPush": "lastPushAtEpoch",
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: {
          ":pace": { S: "push-pace" },
          ":userId": { S: USER },
          ":at": { N: String(NOW_EPOCH) },
          ":ttl": { N: String(NOW_EPOCH + 4 * HOUR) },
        },
      },
    ]);
    const order = mockSend.mock.calls.map(([cmd]) => cmd);
    const paceWrite = order.indexOf(paceWrites()[0]);
    expect(paceWrite).toBeLessThan(order.findIndex((cmd) => cmd.kind === "DeleteItem"));
    expect(paceWrite).toBeGreaterThan(order.findIndex((cmd) => cmd.kind === "BatchWriteItem"));
  });

  it("sends 'vote again' on its own push beside the other one, the second silent, and counts both", async () => {
    rows = [
      pendingRow("BILLS-119hr1", "alert"),
      pendingRow("BILLS-119hr2", "alert"),
      pendingRow("BILLS-119hr3", "updated"),
    ];

    await runAt();

    expect(pushes().map(({ apns }) => [apns.aps.alert.title, apns.notificationType, apns.aps.sound])).toEqual([
      ["Action on 2 Bills", "digest", "default"],
      ["Updated: Title of BILLS-119hr3", "updated", undefined],
    ]);
    expect(pushes()[1].apns.billIds).toEqual(["BILLS-119hr3"]);
    expect(paceWrites()).toHaveLength(1);
    expect(metricLines()).toEqual([
      expect.objectContaining({ PushesSent: 2, NotificationsDelivered: 3, NotificationsFolded: 1 }),
    ]);
  });

  it("plays the sound on each device's first push: a device that takes only 'updated' pushes hears it", async () => {
    devices = [{ id: "phone" }, { id: "tablet", notifyNew: false }];
    rows = [pendingRow("BILLS-119hr2", "new"), pendingRow("BILLS-119hr3", "updated")];

    await runAt();

    expect(
      pushes().map(({ target, apns }) => [target.split("/").pop(), apns.notificationType, apns.aps.sound]),
    ).toEqual([
      ["phone", "new", "default"],
      ["phone", "updated", undefined],
      ["tablet", "updated", "default"],
    ]);
  });

  it("opens no window when no push reached a device", async () => {
    devices = [{ id: "phone", notifyNew: false }];
    rows = [pendingRow("BILLS-119hr2", "new")];

    await runAt();

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([["BILLS-119hr2", "not_sent"]]);
    expect(paceWrites()).toEqual([]);
    expect(metricLines()).toEqual([]);
  });

  it("sends without the pace, and warns, when the last push time cannot be read", async () => {
    lastPushAtEpoch = "error";

    expect(await runAt()).toEqual({ batchItemFailures: [] });

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    expect(logLines(console.warn).map((line) => line.message)).toContain(
      "Could not read the user's last push time; sending without the push pace",
    );
  });

  it("still deletes the sent rows and releases the user, and warns, when the push time cannot be recorded", async () => {
    failPaceWrite = true;

    expect(await runAt()).toEqual({ batchItemFailures: [] });

    expect(deletedRowKeys()).toEqual(["BILLS-119hr1#alert", "BILLS-119hr2#new"]);
    expect(calls("DeleteItem").map((cmd) => cmd.input.Key!.billId.S)).toEqual([USER, `__claim__#${USER}`]);
    expect(logLines(console.warn).map((line) => line.message)).toContain(
      "Could not record the user's push time; their next push may come before the push pace allows",
    );
  });

  it("opens the window when one push went out and another is kept for the retry", async () => {
    rows = [pendingRow("BILLS-119hr2", "new"), pendingRow("BILLS-119hr3", "updated")];
    mockSnsSend.mockImplementation(async (cmd: FakeSnsCommand) => {
      if (JSON.parse(JSON.parse(cmd.input.Message!).APNS).notificationType === "updated") {
        throw Object.assign(new Error("Internal error"), { name: "InternalErrorException" });
      }
      return { MessageId: "m" };
    });

    expect(await runAt()).toEqual({ batchItemFailures: [{ itemIdentifier: "m-0" }] });

    expect(deletedRowKeys()).toEqual(["BILLS-119hr2#new"]);
    expect(paceWrites()).toHaveLength(1);
  });

  it.each([[undefined], ["0"], ["off"], ["24"]])(
    "with PUSH_PACE_HOURS=%j sends at once and keeps no push time",
    async (hours) => {
      lastPushAtEpoch = NOW_EPOCH - 60;

      await runAt(NOW, { PUSH_PACE_HOURS: hours });

      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(paceReads()).toEqual([]);
      expect(paceWrites()).toEqual([]);
    },
  );

  it("reads no push time for a user with nothing pending", async () => {
    rows = [];

    await runAt();

    expect(paceReads()).toEqual([]);
    expect(paceWrites()).toEqual([]);
  });

  it("counts the rows a hold would carry past their 24 hours, and warns", async () => {
    // A row already 23 hours old (from a delivery outage) held for 2 more hours.
    lastPushAtEpoch = NOW_EPOCH - HOUR;
    rows = [pendingRow("BILLS-119hr1", "alert", NOW_EPOCH - 23 * HOUR), pendingRow("BILLS-119hr2", "new")];

    await runAt();

    expect(metricLines()).toEqual([
      expect.objectContaining({ NotificationsHeldPace: 2, NotificationsHeldPastLifetime: 1 }),
    ]);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: "Holding pending notifications past their 24-hour lifetime",
        // RUNBOOK 18.6: a pace hold is released by deleting the pace item, then the claims.
        holdReason: "pace",
        pendingKeys: ["BILLS-119hr1#alert"],
      }),
    );
    const held = logLines(console.log).filter((line) => line.outcome === "held");
    expect(held.map((line) => [line.guid, line.pastLifetime])).toEqual([
      ["BILLS-119hr1", true],
      ["BILLS-119hr2", undefined],
    ]);
  });
});

describe("a 'vote again' push after a newer vote (UX-33)", () => {
  // The summary change reached the user at 7:30 PM (the row's createdAt); held overnight, sent at 8 AM.
  const CHANGED = epochOf("2026-10-29T23:30:00Z");
  const MORNING = "2026-10-30T12:05:00Z";

  it("drops the push when the user voted on the bill after the change, and sends the rest", async () => {
    rows = [pendingRow("BILLS-119hr3", "updated", CHANGED), pendingRow("BILLS-119hr4", "updated", CHANGED)];
    rows.push(pendingRow("BILLS-119hr2", "new", CHANGED));
    votes = { "BILLS-119hr3": "2026-10-30T01:00:00.000Z", "BILLS-119hr4": "2026-10-29T20:00:00.000Z" };

    expect(await runAt(MORNING)).toEqual({ batchItemFailures: [] });

    expect(voteReads().map((cmd) => cmd.input)).toEqual([
      {
        TableName: "UserFeedback",
        Key: { userId: { S: USER }, billId: { S: "BILLS-119hr3" } },
        ProjectionExpression: "votedAt",
        ConsistentRead: true,
      },
      {
        TableName: "UserFeedback",
        Key: { userId: { S: USER }, billId: { S: "BILLS-119hr4" } },
        ProjectionExpression: "votedAt",
        ConsistentRead: true,
      },
    ]);
    expect(pushes().map(({ apns }) => [apns.notificationType, apns.billIds])).toEqual([
      ["new", ["BILLS-119hr2"]],
      ["updated", ["BILLS-119hr4"]],
    ]);
    // The dropped row first, then the sent ones.
    expect(deletedRowKeys()).toEqual(["BILLS-119hr3#updated", "BILLS-119hr4#updated", "BILLS-119hr2#new"]);
    expect(outcomes()).toEqual([
      ["BILLS-119hr3", "dropped_revoted"],
      ["BILLS-119hr2", "delivered"],
      ["BILLS-119hr4", "delivered"],
    ]);
    expect(metricLines()).toEqual([
      expect.objectContaining({ NotificationsDroppedRevoted: 1 }),
      expect.objectContaining({ PushesSent: 2, NotificationsDelivered: 2, NotificationsFolded: 0 }),
    ]);
  });

  // Review of UX-33, F2: the row is written after the pipeline's delay (here 4 minutes after the summary was stored, a
  // UserMatcher retry); a vote cast in between was on the new summary.
  it("compares the vote with when the summary changed (changedAtMs), not with when the row was written", async () => {
    const stored = at("2026-10-29T23:26:00Z");
    rows = [
      { ...pendingRow("BILLS-119hr3", "updated", CHANGED), changedAtMs: { N: String(stored) } },
      { ...pendingRow("BILLS-119hr4", "updated", CHANGED), changedAtMs: { N: String(stored) } },
    ];
    votes = { "BILLS-119hr3": "2026-10-29T23:28:00.000Z", "BILLS-119hr4": "2026-10-29T23:25:00.000Z" };

    expect(await runAt(MORNING)).toEqual({ batchItemFailures: [] });

    expect(pushes().map(({ apns }) => [apns.notificationType, apns.billIds])).toEqual([["updated", ["BILLS-119hr4"]]]);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Bill notification outcome",
        guid: "BILLS-119hr3",
        outcome: "dropped_revoted",
        changedAt: "2026-10-29T23:26:00.000Z",
      }),
    );
  });

  it("falls back to the row's write time for a row without a usable change time", async () => {
    rows = [{ ...pendingRow("BILLS-119hr3", "updated", CHANGED), changedAtMs: { N: "soon" } }];
    votes = { "BILLS-119hr3": "2026-10-29T23:28:00.000Z" };

    await runAt(MORNING);

    expect(pushes().map(({ apns }) => apns.notificationType)).toEqual(["updated"]);
  });

  it("keeps the push for a user who has not voted, and reads votes only for 'updated' rows", async () => {
    rows = [pendingRow("BILLS-119hr3", "updated", CHANGED), pendingRow("BILLS-119hr1", "alert", CHANGED)];

    await runAt(MORNING);

    expect(voteReads().map((cmd) => cmd.input.Key!.billId.S)).toEqual(["BILLS-119hr3"]);
    expect(pushes().map(({ apns }) => apns.notificationType)).toEqual(["alert", "updated"]);
  });

  it("sends nothing, opens no window and releases the user when every row is dropped", async () => {
    rows = [pendingRow("BILLS-119hr3", "updated", CHANGED)];
    votes = { "BILLS-119hr3": "2026-10-30T11:00:00.000Z" };

    expect(await runAt(MORNING)).toEqual({ batchItemFailures: [] });

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(deletedRowKeys()).toEqual(["BILLS-119hr3#updated"]);
    expect(calls("DeleteItem").map((cmd) => cmd.input.Key!.billId.S)).toEqual([USER, `__claim__#${USER}`]);
    expect(calls("Query").filter((cmd) => cmd.input.TableName === "Devices")).toEqual([]);
    expect(paceWrites()).toEqual([]);
  });

  it("sends the push, and warns, when the vote cannot be read", async () => {
    rows = [pendingRow("BILLS-119hr3", "updated", CHANGED)];
    votes = { "BILLS-119hr3": "error" };

    expect(await runAt(MORNING)).toEqual({ batchItemFailures: [] });

    expect(pushes().map(({ apns }) => apns.notificationType)).toEqual(["updated"]);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: "Could not read the user's vote on the bill; sending its vote-again push",
        guid: "BILLS-119hr3",
      }),
    );
  });

  it("checks nothing without FEEDBACK_TABLE_NAME", async () => {
    rows = [pendingRow("BILLS-119hr3", "updated", CHANGED)];
    votes = { "BILLS-119hr3": "2026-10-30T11:00:00.000Z" };

    await runAt(MORNING, { FEEDBACK_TABLE_NAME: undefined });

    expect(voteReads()).toEqual([]);
    expect(pushes().map(({ apns }) => apns.notificationType)).toEqual(["updated"]);
  });

  it("reads no vote while the row is held", async () => {
    rows = [pendingRow("BILLS-119hr3", "updated", CHANGED)];
    votes = { "BILLS-119hr3": "2026-10-30T01:00:00.000Z" };

    await runAt("2026-10-30T03:00:00Z");

    expect(voteReads()).toEqual([]);
    expect(claimHolds()).toHaveLength(1);
  });
});

// Project decision 2026-10-29, "one event, per phone": one stored version added an action and passed (or failed) the bill.
// UserMatcher wrote the user both rows in one write, the action's marked `pairedOutcome`; each device gets one of them.
describe("a change's action and outcome (UX-33)", () => {
  const BILL = "BILLS-119hr7";
  const OUTCOME_ACTION = {
    passed: { text: "Passed/agreed to in House.", code: "8000" },
    failed: { text: "Failed of passage in House.", code: "9000" },
  } as const;
  /** The two rows of one change, as the paired write leaves them. */
  const changeRows = (outcome: "passed" | "failed", createdAt = NOW_EPOCH - 600) => [
    {
      ...pendingRow(BILL, "alert", createdAt),
      actionText: { S: "Motion to reconsider laid on the table." },
      actionDate: { S: "2026-10-28" },
      pairedOutcome: { S: outcome },
    },
    {
      ...pendingRow(BILL, outcome, createdAt),
      category: { S: "Health" },
      actionText: { S: OUTCOME_ACTION[outcome].text },
      actionCode: { S: OUTCOME_ACTION[outcome].code },
      actionDate: { S: "2026-10-28" },
    },
  ];
  const shown = () =>
    pushes().map(({ target, apns }) => [
      target.split("/").pop(),
      `${apns.aps.alert.title} | ${apns.aps.alert.body}`,
      apns.notificationType,
    ]);

  it.each([
    ["passed", "notifyPassed", "Passed: Title of BILLS-119hr7 | Passed the House · Oct 28"],
    ["failed", "notifyFailed", "Failed: Title of BILLS-119hr7 | Failed in the House · Oct 28"],
  ] as const)(
    "sends the '%s' push where the device takes it, and the action push where it does not, one each",
    async (outcome, switchName, outcomeCopy) => {
      devices = [{ id: "phone" }, { id: "tablet", [switchName]: false }, { id: "watch", notifyAlert: false }];
      rows = changeRows(outcome);

      expect(await runAt()).toEqual({ batchItemFailures: [] });

      expect(shown()).toEqual([
        ["phone", outcomeCopy, outcome],
        ["tablet", "Action: Title of BILLS-119hr7 | Motion to reconsider laid on the table · Oct 28", "alert"],
        ["watch", outcomeCopy, outcome],
      ]);
      // Both rows are settled together; one window opens.
      expect(deletedRowKeys()).toEqual([`${BILL}#alert`, `${BILL}#${outcome}`]);
      expect(paceWrites()).toHaveLength(1);
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Sent each device one push for a change's action and outcome",
          guid: BILL,
          outcomeType: outcome,
          devicesOutcome: 2,
          devicesAction: 1,
        }),
      );
      expect(metricLines()).toEqual([
        expect.objectContaining({
          PushesSent: 1,
          NotificationsDelivered: 1,
          NotificationsFolded: 0,
          OutcomeChangeSentAsOutcome: 2,
          OutcomeChangeSentAsAction: 1,
        }),
      ]);
      expect(
        logLines(console.log)
          .filter((line) => line.message === "Bill notification outcome")
          .map((line) => [line.notificationType, line.outcome, line.devicesSent, line.pairedOutcome]),
      ).toEqual([
        ["alert", "delivered", 1, outcome],
        [outcome, "delivered", 2, undefined],
      ]);
    },
  );

  it("sends a device with both types off neither, and logs the action row not sent when no device took it", async () => {
    devices = [{ id: "phone" }, { id: "quiet", notifyAlert: false, notifyPassed: false }];
    rows = changeRows("passed");

    await runAt();

    expect(shown().map(([device, , type]) => [device, type])).toEqual([["phone", "passed"]]);
    expect(outcomes()).toEqual([
      [BILL, "not_sent"],
      [BILL, "delivered"],
    ]);
    expect(metricLines()).toEqual([
      expect.objectContaining({ OutcomeChangeSentAsOutcome: 1, OutcomeChangeSentAsAction: 0 }),
    ]);
  });

  it("folds the change into a device's one push as one bill, said the way that device takes it", async () => {
    devices = [{ id: "phone" }, { id: "tablet", notifyPassed: false }];
    rows = [...changeRows("passed"), pendingRow("BILLS-119hr2", "new")];

    await runAt();

    expect(shown()).toEqual([
      ["phone", "2 Bill Updates | 1 new, 1 passed", "digest"],
      ["tablet", "2 Bill Updates | 1 new, 1 action", "digest"],
    ]);
    expect(metricLines()).toEqual([
      expect.objectContaining({ PushesSent: 1, NotificationsDelivered: 2, NotificationsFolded: 1 }),
    ]);
  });

  it("holds both rows together for the pace, as one push, and sends them together after it", async () => {
    lastPushAtEpoch = NOW_EPOCH - HOUR;
    rows = changeRows("failed");

    await runAt();

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(claimHolds()).toHaveLength(1);
    expect(logLines(console.log).filter((line) => line.outcome === "held")).toHaveLength(2);

    mockSend.mockClear();
    devices = [{ id: "phone" }, { id: "tablet", notifyFailed: false }];
    lastPushAtEpoch = NOW_EPOCH - HOUR;
    await runAt("2026-10-29T20:00:00Z");

    expect(shown().map(([device, , type]) => [device, type])).toEqual([
      ["phone", "failed"],
      ["tablet", "alert"],
    ]);
    expect(paceWrites()).toHaveLength(1);
  });

  it("holds both rows together for the quiet hours", async () => {
    rows = changeRows("passed", epochOf("2026-10-30T02:00:00Z") - 60);

    // 10 PM EDT.
    await runAt("2026-10-30T02:00:00Z");

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(
      logLines(console.log)
        .filter((line) => line.outcome === "held")
        .map((line) => [line.notificationType, line.holdReason]),
    ).toEqual([
      ["alert", "quiet_hours"],
      ["passed", "quiet_hours"],
    ]);
  });

  it("sends 'vote again' on its own push beside the device's one push for the change", async () => {
    devices = [{ id: "phone" }, { id: "tablet", notifyPassed: false }];
    rows = [...changeRows("passed"), pendingRow(BILL, "updated")];

    await runAt();

    expect(
      pushes().map(({ target, apns }) => [target.split("/").pop(), apns.notificationType, apns.aps.sound]),
    ).toEqual([
      ["phone", "passed", "default"],
      ["phone", "updated", undefined],
      ["tablet", "alert", "default"],
      ["tablet", "updated", undefined],
    ]);
  });

  // An older writer (before UX-33's project decision) wrote an unmarked action row: today's behaviour.
  it("sends an unmarked action row to every device that takes actions, folded with the outcome as before", async () => {
    devices = [{ id: "phone" }, { id: "tablet", notifyPassed: false }];
    rows = changeRows("passed").map((row) => {
      const { pairedOutcome: _paired, ...unmarked } = row as typeof row & { pairedOutcome?: unknown };
      return unmarked;
    });

    await runAt();

    expect(shown().map(([device, copy, type]) => [device, copy.split(" | ")[0], type])).toEqual([
      ["phone", "Passed: Title of BILLS-119hr7", "digest"],
      ["tablet", "Action: Title of BILLS-119hr7", "alert"],
    ]);
    expect(logLines(console.log).map((line) => line.message)).not.toContain(
      "Sent each device one push for a change's action and outcome",
    );
  });

  it("reads a marked action row as an action row only when it is one, and the mark only when it names an outcome", async () => {
    devices = [{ id: "tablet", notifyPassed: false }];
    rows = [{ ...pendingRow(BILL, "alert"), pairedOutcome: { S: "law" } }];

    await runAt();

    expect(shown().map(([device, , type]) => [device, type])).toEqual([["tablet", "alert"]]);
  });

  // REL-50's words for a vote that is not the bill's failure reach the action push a device with the outcome off gets,
  // its Recent actions row (`alert.text`) and a push folded for one bill.
  it.each([
    [
      "a failed 60-vote Senate vote",
      "18000",
      "Failed of passage/not agreed to in Senate: Under the order of 10/27/2026, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48. Record Vote Number: 528.",
      "Senate vote fell short of 60",
    ],
    [
      "a failed suspension vote",
      "9000",
      "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
      "House vote fell short of two-thirds",
    ],
  ])("says %s in the project's words on the action push of a change's outcome", async (_name, code, text, words) => {
    devices = [{ id: "phone" }, { id: "tablet", notifyPassed: false }];
    const [action, outcome] = changeRows("passed");
    rows = [{ ...action, actionText: { S: text }, actionCode: { S: code } }, outcome, pendingRow(BILL, "new")];

    await runAt();

    expect(shown()).toEqual([
      ["phone", "Passed: Title of BILLS-119hr7 | Passed the House · Oct 28", "digest"],
      ["tablet", `Action: Title of BILLS-119hr7 | ${words} · Oct 28`, "digest"],
    ]);
    expect(pushes()[1].apns.alert).toEqual({ text: words, actionDate: "2026-10-28", actionCode: code });
  });

  describe("beside a 'failed' row the rule before REL-50 wrote", () => {
    const amendment = "Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53.";
    const actionCopy =
      "Action: Title of BILLS-119hr7 | Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53 · Oct 28";
    /** An old-rule "failed" for an amendment line, and its action row marked, as UX-33's writer put them down. */
    const oldRuleChange = () =>
      changeRows("failed").map((row) => {
        const { actionCode: _code, ...uncoded } = row as typeof row & { actionCode?: unknown };
        return { ...uncoded, actionText: { S: amendment } };
      });
    const actionRowUnmarks = () => calls("UpdateItem").filter((cmd) => cmd.input.Key!.billId?.S === `${BILL}#alert`);

    it("unmarks the action row and sends it to every device that takes actions, Failed: pushes on or off", async () => {
      devices = [{ id: "phone" }, { id: "tablet", notifyFailed: false }, { id: "watch", notifyAlert: false }];
      rows = oldRuleChange() as typeof rows;

      expect(await runAt()).toEqual({ batchItemFailures: [] });

      // The watch takes "Failed:" pushes only, so it gets none: the failure was not the bill's, the action is all.
      expect(shown()).toEqual([
        ["phone", actionCopy, "alert"],
        ["tablet", actionCopy, "alert"],
      ]);
      expect(actionRowUnmarks().map((cmd) => cmd.input)).toEqual([
        {
          TableName: "Pending",
          Key: { userId: { S: USER }, billId: { S: `${BILL}#alert` } },
          UpdateExpression: "REMOVE #paired",
          ConditionExpression: "#paired = :failed",
          ExpressionAttributeNames: { "#paired": "pairedOutcome" },
          ExpressionAttributeValues: { ":failed": { S: "failed" } },
        },
      ]);
      // The mark comes off before the failed row goes; the action row is settled once sent.
      const writes = mockSend.mock.calls
        .map(([cmd]) => cmd)
        .filter((cmd) => cmd.kind === "BatchWriteItem" || actionRowUnmarks().includes(cmd))
        .map((cmd) => cmd.kind);
      expect(writes).toEqual(["UpdateItem", "BatchWriteItem", "BatchWriteItem"]);
      expect(deletedRowKeys()).toEqual([`${BILL}#failed`, `${BILL}#alert`]);
      expect(
        logLines(console.log)
          .filter((line) => line.message === "Bill notification outcome")
          .map((line) => [
            line.notificationType,
            line.outcome,
            line.reason,
            line.actionRowUnmarked,
            line.pairedOutcome,
          ]),
      ).toEqual([
        ["failed", "not_a_failure", "amendment", true, undefined],
        ["alert", "delivered", undefined, undefined, undefined],
      ]);
      expect(logLines(console.log).map((line) => line.message)).not.toContain(
        "Sent each device one push for a change's action and outcome",
      );
    });

    it("sends a device that takes only Failed: pushes nothing, and settles both rows with no window", async () => {
      devices = [{ id: "watch", notifyAlert: false }];
      rows = oldRuleChange() as typeof rows;

      expect(await runAt()).toEqual({ batchItemFailures: [] });

      expect(mockSnsSend).not.toHaveBeenCalled();
      expect(deletedRowKeys()).toEqual([`${BILL}#failed`, `${BILL}#alert`]);
      expect(paceWrites()).toEqual([]);
      expect(
        logLines(console.log)
          .filter((line) => line.message === "Bill notification outcome")
          .map((line) => [line.notificationType, line.outcome, line.reason]),
      ).toEqual([
        ["failed", "not_a_failure", "amendment"],
        ["alert", "not_sent", undefined],
      ]);
    });

    it("leaves the action row unmarked in the table through a pace hold, so the dispatch after it sends it", async () => {
      lastPushAtEpoch = NOW_EPOCH - HOUR;
      rows = oldRuleChange() as typeof rows;

      await runAt();

      expect(mockSnsSend).not.toHaveBeenCalled();
      expect(actionRowUnmarks()).toHaveLength(1);
      expect(deletedRowKeys()).toEqual([`${BILL}#failed`]);
      expect(
        logLines(console.log)
          .filter((line) => line.outcome === "held")
          .map((line) => [line.notificationType, line.pairedOutcome]),
      ).toEqual([["alert", undefined]]);

      // What the table now holds: the action row alone, unmarked.
      mockSend.mockClear();
      devices = [{ id: "phone" }, { id: "tablet", notifyFailed: false }];
      const [action] = oldRuleChange();
      const { pairedOutcome: _mark, ...unmarked } = action as typeof action & { pairedOutcome?: unknown };
      rows = [unmarked] as typeof rows;
      await runAt("2026-10-29T20:00:00Z");

      expect(shown()).toEqual([
        ["phone", actionCopy, "alert"],
        ["tablet", actionCopy, "alert"],
      ]);
    });

    it("fails the record, and deletes and sends nothing, when the mark cannot come off", async () => {
      rows = oldRuleChange() as typeof rows;
      const send = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
        if (cmd.kind === "UpdateItem" && cmd.input.Key!.billId?.S === `${BILL}#alert`) {
          throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        }
        return send(cmd);
      });

      expect(await runAt()).toEqual({ batchItemFailures: [{ itemIdentifier: "m-0" }] });

      expect(deletedRowKeys()).toEqual([]);
      expect(mockSnsSend).not.toHaveBeenCalled();
    });

    it("sends the action alone when the action row was rewritten since the read (the mark's condition fails)", async () => {
      devices = [{ id: "phone" }];
      rows = oldRuleChange() as typeof rows;
      const send = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
        if (cmd.kind === "UpdateItem" && cmd.input.Key!.billId?.S === `${BILL}#alert`) {
          throw Object.assign(new Error("The conditional request failed"), {
            name: "ConditionalCheckFailedException",
          });
        }
        return send(cmd);
      });

      expect(await runAt()).toEqual({ batchItemFailures: [] });

      expect(shown()).toEqual([["phone", actionCopy, "alert"]]);
    });

    it("leaves the change of a coded failure of the bill paired (REL-50's rule keeps its 'failed' row)", async () => {
      devices = [{ id: "phone" }, { id: "tablet", notifyFailed: false }];
      rows = changeRows("failed");

      await runAt();

      expect(actionRowUnmarks()).toEqual([]);
      expect(shown().map(([device, , type]) => [device, type])).toEqual([
        ["phone", "failed"],
        ["tablet", "alert"],
      ]);
    });
  });
});
