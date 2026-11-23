import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { WeeklyDigest } from "../models/weeklyDigest";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

/*
 * UX-28: the Sunday Weekly Brief push. Hourly runs from 10:30 AM to 5:30 PM New York send each user's brief once, at the
 * first run outside their quiet hours, to the devices that took it (notifyWeeklyBrief exactly true: app 1.3 only).
 * The tables and SNS are in memory; DynamoDB conditions are evaluated as written (fixtures/dynamoCondition.ts).
 */

type Item = Record<string, AttributeValue>;
interface Command {
  __type: string;
  input: Record<string, unknown> & ConditionInput;
}

const PII_TABLE = "pii-table";
const DIGESTS_TABLE = "weekly-digests-table";
const DEVICES_TABLE = "devices-table";

// The in-memory store the mocked clients answer from (names start with "mock" so jest.mock may use them).
const mockWorld = {
  pii: new Map<string, Item>(),
  snapshots: new Map<string, Item>(),
  devices: new Map<string, Item[]>(),
  published: [] as Array<{ TargetArn: string; Message: string }>,
  commands: [] as Command[],
  publishErrors: new Map<string, Error>(),
  failGetFor: new Set<string>(),
};

const mockDynamoSend = async (command: Command): Promise<unknown> => {
  mockWorld.commands.push(command);
  const input = command.input;
  const key = input.Key as Item | undefined;
  switch (command.__type) {
    case "Scan":
      if (input.TableName !== PII_TABLE) throw new Error(`unexpected Scan of ${String(input.TableName)}`);
      return { Items: Array.from(mockWorld.pii.values()) };
    case "GetItem": {
      if (input.TableName !== DIGESTS_TABLE) throw new Error(`unexpected GetItem of ${String(input.TableName)}`);
      const userId = key!.userId.S!;
      if (mockWorld.failGetFor.has(userId))
        throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
      return { Item: mockWorld.snapshots.get(`${userId}|${key!.publishedAt.S}`) };
    }
    case "Query": {
      if (input.TableName !== DEVICES_TABLE) throw new Error(`unexpected Query of ${String(input.TableName)}`);
      const values = input.ExpressionAttributeValues as Item;
      return { Items: mockWorld.devices.get(values[":userValue"].S!) ?? [] };
    }
    case "UpdateItem": {
      if (input.TableName === DIGESTS_TABLE) {
        const row = mockWorld.snapshots.get(`${key!.userId.S}|${key!.publishedAt.S}`);
        if (!evaluateCondition(row, input)) throw conditionalCheckFailed();
        row!.pushClaimedAt = (input.ExpressionAttributeValues as Item)[":claimedAt"];
        return {};
      }
      if (input.TableName === DEVICES_TABLE) {
        const row = (mockWorld.devices.get(key!.userId.S!) ?? []).find(
          (device) => device.deviceId.S === key!.deviceId.S,
        );
        if (!evaluateCondition(row, input)) throw conditionalCheckFailed();
        delete row!.endpointArn;
        return {};
      }
      throw new Error(`unexpected UpdateItem of ${String(input.TableName)}`);
    }
    default:
      throw new Error(`unexpected command ${command.__type}`);
  }
};

const mockSnsSend = async (command: Command): Promise<unknown> => {
  const input = command.input as { TargetArn: string; Message: string };
  const error = mockWorld.publishErrors.get(input.TargetArn);
  if (error) throw error;
  mockWorld.published.push({ TargetArn: input.TargetArn, Message: input.Message });
  return { MessageId: "m-1" };
};

jest.mock("@aws-sdk/client-dynamodb", () => {
  const command = (type: string) => jest.fn().mockImplementation((input) => ({ __type: type, input }));
  return {
    DynamoDBClient: jest.fn(() => ({ send: (cmd: Command) => mockDynamoSend(cmd) })),
    ScanCommand: command("Scan"),
    GetItemCommand: command("GetItem"),
    QueryCommand: command("Query"),
    UpdateItemCommand: command("UpdateItem"),
    PutItemCommand: command("PutItem"),
  };
});

jest.mock("@aws-sdk/client-sns", () => ({
  SNSClient: jest.fn(() => ({ send: (cmd: Command) => mockSnsSend(cmd) })),
  PublishCommand: jest.fn().mockImplementation((input) => ({ __type: "Publish", input })),
}));

// Sunday 2026-11-22 (Eastern standard time): the brief was released at 15:00Z (10:00 New York).
const WINDOW_ID = "2026-11-22T15:00:00.000Z";
const RUN_1030_ET = "2026-11-22T15:30:00.000Z";

const arn = (userId: string, deviceId: string) =>
  `arn:aws:sns:us-east-1:000000000000:endpoint/APNS/Billboard/${userId}-${deviceId}`;

const brief = (titles: string[]): WeeklyDigest => ({
  id: WINDOW_ID,
  title: "Your Week in Congress | Nov 15-21, 2026",
  summary: "One bill needs your attention.",
  weekStart: "2026-11-15T05:00:00.000Z",
  weekEnd: "2026-11-21T05:00:00.000Z",
  publishedAt: WINDOW_ID,
  isRead: false,
  stats: [],
  sections: [
    {
      kind: "moved_this_week",
      title: "What Moved This Week",
      items: titles.map((title, index) => ({
        id: `bill|BILLS-119hr${index + 1}`,
        kind: "bill" as const,
        title,
        summary: "Nov 18: Passed the House.",
        accent: "movement" as const,
        billGuid: `BILLS-119hr${index + 1}`,
      })),
    },
  ],
});

interface UserSetup {
  state?: string;
  adultStatus?: string;
  deletionStatus?: string;
  /** Default: one device that took the brief. */
  devices?: Array<Partial<Record<"endpoint" | "enabled" | "brief", boolean | null>> & { id?: string }>;
  /** Default: a brief with two bills. Null: no brief this week. */
  digest?: WeeklyDigest | null;
  claimedAt?: string;
}

const addUser = (userId: string, setup: UserSetup = {}): void => {
  mockWorld.pii.set(userId, {
    userId: { S: userId },
    adultStatus: { S: setup.adultStatus ?? "attested_adult" },
    ...(setup.deletionStatus ? { deletionStatus: { S: setup.deletionStatus } } : {}),
    ...(setup.state ? { resolvedState: { S: setup.state } } : {}),
  });
  const digest = setup.digest === undefined ? brief(["Rural Broadband Access Act", "Clean Water Act"]) : setup.digest;
  if (digest) {
    mockWorld.snapshots.set(`${userId}|${WINDOW_ID}`, {
      userId: { S: userId },
      publishedAt: { S: WINDOW_ID },
      payload: { S: JSON.stringify(digest) },
      ...(setup.claimedAt ? { pushClaimedAt: { S: setup.claimedAt } } : {}),
    });
  }
  const devices = setup.devices ?? [{}];
  mockWorld.devices.set(
    userId,
    devices.map((device, index) => {
      const deviceId = device.id ?? `d${index + 1}`;
      return {
        userId: { S: userId },
        deviceId: { S: deviceId },
        platform: { S: "ios" },
        ...(device.endpoint === false ? {} : { endpointArn: { S: arn(userId, deviceId) } }),
        notificationsEnabled: { BOOL: device.enabled ?? true },
        ...(device.brief === null ? {} : { notifyWeeklyBrief: { BOOL: device.brief ?? true } }),
      };
    }),
  );
};

type HandlerModule = typeof import("../handlers/weeklyBriefPush");
let restoreEnv: (() => void) | undefined;

const loadHandler = (env: Record<string, string | undefined> = {}): HandlerModule["handler"] => {
  restoreEnv?.();
  restoreEnv = applyTestEnv({
    PII_TABLE_NAME: PII_TABLE,
    PII_PARTITION_KEY: "userId",
    TABLE_NAME: DIGESTS_TABLE,
    PARTITION_KEY: "userId",
    SORT_KEY: "publishedAt",
    DEVICES_TABLE_NAME: DEVICES_TABLE,
    DEVICES_PARTITION_KEY: "userId",
    DEVICES_SORT_KEY: "deviceId",
    CANONICAL_PUBLISH_TIMEZONE: "America/New_York",
    CANONICAL_PUBLISH_HOUR: "10",
    CANONICAL_PUBLISH_MINUTE: "0",
    QUIET_HOURS: "on",
    WEEKLY_BRIEF_PUSH: "on",
    WEEKLY_BRIEF_PUSH_LAST_RUN_HOUR: "17",
    AWS_LAMBDA_LOG_FORMAT: undefined,
    ...env,
  });
  let loaded: HandlerModule | undefined;
  jest.isolateModules(() => {
    loaded = require("../handlers/weeklyBriefPush");
  });
  return loaded!.handler;
};

const runAt = async (iso: string, env: Record<string, string | undefined> = {}, context?: object) => {
  jest.setSystemTime(new Date(iso));
  return loadHandler(env)(undefined, context);
};

const publishedTo = () => mockWorld.published.map((publish) => publish.TargetArn).sort();
const emf = () => logLines(console.log).filter((line) => line._aws);
const metric = (name: string) => emf().flatMap((line) => (name in line ? [line[name]] : []));

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  mockWorld.pii.clear();
  mockWorld.snapshots.clear();
  mockWorld.devices.clear();
  mockWorld.published = [];
  mockWorld.commands = [];
  mockWorld.publishErrors.clear();
  mockWorld.failGetFor.clear();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("when it arrives (D3: the first run outside the user's quiet hours)", () => {
  it("sends New York at 10:30 ET and holds Los Angeles (7:30 AM there), then sends Los Angeles at 11:30 ET", async () => {
    addUser("ny", { state: "NY" });
    addUser("la", { state: "CA" });

    const first = await runAt(RUN_1030_ET);
    expect(publishedTo()).toEqual([arn("ny", "d1")]);
    expect(first.users).toEqual(expect.objectContaining({ sent: 1, held_quiet_hours: 1 }));

    const second = await runAt("2026-11-22T16:30:00.000Z");
    expect(publishedTo()).toEqual([arn("la", "d1"), arn("ny", "d1")]);
    expect(second.users).toEqual(expect.objectContaining({ sent: 1, already_sent: 1, held_quiet_hours: 0 }));
  });

  it("holds Hawaii until 13:30 ET (8:30 AM there)", async () => {
    addUser("hi", { state: "HI" });

    await runAt("2026-11-22T17:30:00.000Z");
    expect(publishedTo()).toEqual([]);

    await runAt("2026-11-22T18:30:00.000Z");
    expect(publishedTo()).toEqual([arn("hi", "d1")]);
  });

  it("reaches Guam at the 5:30 PM ET run, Monday 8:30 AM there", async () => {
    addUser("gu", { state: "GU" });

    await runAt("2026-11-22T21:30:00.000Z");
    expect(publishedTo()).toEqual([]);

    const last = await runAt("2026-11-22T22:30:00.000Z");
    expect(publishedTo()).toEqual([arn("gu", "d1")]);
    expect(last.lastRun).toBe(true);
    expect(metric("WeeklyBriefPushesUnsent")).toEqual([0]);
  });

  it("counts a brief still held at the last run as unsent (Guam on a summer Sunday, 7:30 AM there)", async () => {
    // Sunday 2026-07-12, Eastern daylight time: released at 14:00Z, last run at 21:30Z.
    addUser("gu", { state: "GU", digest: { ...brief(["Clean Water Act"]), id: "2026-07-12T14:00:00.000Z" } });
    mockWorld.snapshots.set("gu|2026-07-12T14:00:00.000Z", {
      ...mockWorld.snapshots.get(`gu|${WINDOW_ID}`)!,
      publishedAt: { S: "2026-07-12T14:00:00.000Z" },
    });

    const last = await runAt("2026-07-12T21:30:00.000Z");

    expect(publishedTo()).toEqual([]);
    expect(last.lastRun).toBe(true);
    expect(last.users.held_quiet_hours).toBe(1);
    expect(metric("WeeklyBriefPushesUnsent")).toEqual([1]);
  });

  it("uses Eastern time for a user with no state", async () => {
    addUser("nostate");

    await runAt(RUN_1030_ET);

    expect(publishedTo()).toEqual([arn("nostate", "d1")]);
  });

  it("sends at any hour with QUIET_HOURS off", async () => {
    addUser("la", { state: "CA" });

    await runAt(RUN_1030_ET, { QUIET_HOURS: "off" });

    expect(publishedTo()).toEqual([arn("la", "d1")]);
  });

  it("emits WeeklyBriefPushesUnsent only on the last run", async () => {
    addUser("ny", { state: "NY" });

    await runAt(RUN_1030_ET);

    expect(metric("WeeklyBriefPushesSent")).toEqual([1]);
    expect(metric("WeeklyBriefPushFailed")).toEqual([0]);
    expect(metric("WeeklyBriefPushesUnsent")).toEqual([]);
  });
});

describe("once per user per week", () => {
  it("sends nothing on a rerun of the same hour, and claims the snapshot before publishing", async () => {
    addUser("ny", { state: "NY", devices: [{}, { id: "ipad" }] });

    await runAt(RUN_1030_ET);
    const rerun = await runAt(RUN_1030_ET);

    expect(publishedTo()).toEqual([arn("ny", "d1"), arn("ny", "ipad")]);
    expect(rerun.users.already_sent).toBe(1);
    expect(mockWorld.snapshots.get(`ny|${WINDOW_ID}`)!.pushClaimedAt).toEqual({ S: RUN_1030_ET });
    const claimAt = mockWorld.commands.findIndex(
      (command) => command.__type === "UpdateItem" && command.input.TableName === DIGESTS_TABLE,
    );
    expect(claimAt).toBeGreaterThan(-1);
  });

  it("skips a user whose claim was taken between the read and the claim (a run overlapping a retry)", async () => {
    addUser("ny", { state: "NY" });
    const original = mockWorld.snapshots.get(`ny|${WINDOW_ID}`)!;
    // The read sees no claim; the claim's condition then finds one.
    const realGet = mockWorld.snapshots.get.bind(mockWorld.snapshots);
    let reads = 0;
    jest.spyOn(mockWorld.snapshots, "get").mockImplementation((key: string) => {
      reads += 1;
      if (reads === 2) return { ...original, pushClaimedAt: { S: "2026-11-22T15:29:59.000Z" } };
      return realGet(key);
    });

    const result = await runAt(RUN_1030_ET);

    expect(publishedTo()).toEqual([]);
    expect(result.users.already_sent).toBe(1);
  });

  it("never writes the bill-push pace marker or any other table (D6)", async () => {
    addUser("ny", { state: "NY" });

    await runAt(RUN_1030_ET);

    const tables = new Set(mockWorld.commands.map((command) => command.input.TableName));
    expect([...tables].sort()).toEqual([DEVICES_TABLE, PII_TABLE, DIGESTS_TABLE].sort());
    expect(mockWorld.commands.some((command) => command.__type === "PutItem")).toBe(false);
  });
});

describe("who gets it", () => {
  it("sends only to devices with the Weekly Brief flag exactly true, notifications on and an endpoint", async () => {
    addUser("ny", {
      state: "NY",
      devices: [
        { id: "takes" },
        { id: "absent", brief: null },
        { id: "off", brief: false },
        { id: "muted", enabled: false },
        { id: "noendpoint", endpoint: false },
      ],
    });

    await runAt(RUN_1030_ET);

    expect(publishedTo()).toEqual([arn("ny", "takes")]);
  });

  it("leaves a user whose devices never stored the flag (1.1 and 1.2) unclaimed and unsent", async () => {
    addUser("old", { state: "NY", devices: [{ brief: null }] });

    const result = await runAt(RUN_1030_ET);

    expect(publishedTo()).toEqual([]);
    expect(result.users.no_device).toBe(1);
    expect(mockWorld.snapshots.get(`old|${WINDOW_ID}`)!.pushClaimedAt).toBeUndefined();
  });

  it.each([
    ["under 18", { adultStatus: "self_reported_under18" }],
    ["not yet attested", { adultStatus: "unknown" }],
    ["being deleted", { deletionStatus: "in_progress" }],
    ["deleted", { deletionStatus: "completed" }],
  ])("skips a user %s without reading their brief", async (_label, setup) => {
    addUser("skip", { state: "NY", ...setup });

    const result = await runAt(RUN_1030_ET);

    expect(publishedTo()).toEqual([]);
    expect(result.usersEligible).toBe(0);
    expect(mockWorld.commands.filter((command) => command.__type === "GetItem")).toEqual([]);
  });

  it("sends nothing to a user with no brief this week", async () => {
    addUser("quiet", { state: "NY", digest: null });

    const result = await runAt(RUN_1030_ET);

    expect(publishedTo()).toEqual([]);
    expect(result.users.no_brief).toBe(1);
  });
});

describe("the switch and the 12-hour limit", () => {
  it.each([undefined, "off", "ON"])("sends nothing while WEEKLY_BRIEF_PUSH is %p", async (value) => {
    addUser("ny", { state: "NY" });

    const result = await runAt(RUN_1030_ET, { WEEKLY_BRIEF_PUSH: value });

    expect(result.status).toBe("off");
    expect(mockWorld.commands).toEqual([]);
    expect(publishedTo()).toEqual([]);
  });

  it.each([
    ["more than 12 hours after the release", "2026-11-23T03:30:00.000Z"],
    ["on the Saturday before the next release", "2026-11-28T15:30:00.000Z"],
  ])("sends nothing %s", async (_label, now) => {
    addUser("ny", { state: "NY" });

    const result = await runAt(now);

    expect(result.status).toBe("late");
    expect(mockWorld.commands).toEqual([]);
  });
});

describe("the payload", () => {
  it("is userNotifier's message shape, read by 1.3 as the brief: domain, notificationType and digestId, no billIds", async () => {
    addUser("ny", { state: "NY", digest: brief(["Rural Broadband Access Act", "Clean Water Act", "Farm Credit Act"]) });

    await runAt(RUN_1030_ET);

    const message = JSON.parse(mockWorld.published[0].Message);
    expect(message.APNS).toBe(message.APNS_SANDBOX);
    expect(message.default).toBe("Weekly Brief · Nov 15–21");
    expect(JSON.parse(message.APNS)).toEqual({
      aps: {
        alert: {
          title: "Weekly Brief · Nov 15–21",
          body: "Includes Rural Broadband Access Act, Clean Water Act, and 1 more.",
        },
        sound: "default",
        "thread-id": "weekly-brief",
      },
      domain: "weekly_digest",
      notificationType: "digest",
      digestId: WINDOW_ID,
    });
    expect(Buffer.byteLength(mockWorld.published[0].Message, "utf8")).toBeLessThan(4096);
  });
});

describe("failures", () => {
  it("removes a disabled endpoint's ARN, as userNotifier does, without counting a failure", async () => {
    addUser("ny", { state: "NY" });
    mockWorld.publishErrors.set(
      arn("ny", "d1"),
      Object.assign(new Error(`Endpoint is disabled: ${arn("ny", "d1")}`), { name: "EndpointDisabledException" }),
    );

    const result = await runAt(RUN_1030_ET);

    expect(mockWorld.devices.get("ny")![0].endpointArn).toBeUndefined();
    expect(result.devices).toEqual({ sent: 0, failed: 0, endpointsRemoved: 1 });
    expect(result.users.not_delivered).toBe(1);
    expect(metric("WeeklyBriefPushFailed")).toEqual([0]);
  });

  it("keeps a new endpoint the device registered meanwhile", async () => {
    addUser("ny", { state: "NY" });
    const device = () => mockWorld.devices.get("ny")![0];
    const gone = Object.assign(new Error("No endpoint found for the target arn specified"), {
      name: "NotFoundException",
    });
    // The device registers again (a new ARN) between the device read and the failed publish.
    jest.spyOn(mockWorld.publishErrors, "get").mockImplementation((target: string) => {
      device().endpointArn = { S: arn("ny", "d1-new") };
      return target === arn("ny", "d1") ? gone : undefined;
    });

    const result = await runAt(RUN_1030_ET);

    expect(device().endpointArn).toEqual({ S: arn("ny", "d1-new") });
    expect(result.devices).toEqual({ sent: 0, failed: 0, endpointsRemoved: 0 });
  });

  it("counts any other publish failure by error name, keeps the claim and does not throw", async () => {
    addUser("ny", { state: "NY", devices: [{}, { id: "ipad" }] });
    mockWorld.publishErrors.set(
      arn("ny", "d1"),
      Object.assign(new Error(`Throttled publishing to ${arn("ny", "d1")}`), { name: "ThrottledException" }),
    );

    const result = await runAt(RUN_1030_ET);

    expect(publishedTo()).toEqual([arn("ny", "ipad")]);
    expect(result.devices).toEqual({ sent: 1, failed: 1, endpointsRemoved: 0 });
    expect(result.errorNames).toEqual({ ThrottledException: 1 });
    expect(metric("WeeklyBriefPushFailed")).toEqual([1]);
    expect(mockWorld.snapshots.get(`ny|${WINDOW_ID}`)!.pushClaimedAt).toBeDefined();
  });

  it("finishes the other users, then throws so the retry tries a user whose read failed", async () => {
    addUser("ny", { state: "NY" });
    addUser("boston", { state: "MA" });
    mockWorld.failGetFor.add("boston");

    await expect(runAt(RUN_1030_ET)).rejects.toThrow(/could not finish 1 of 2 users/);

    expect(publishedTo()).toEqual([arn("ny", "d1")]);
    expect(metric("WeeklyBriefPushFailed")).toEqual([1]);
    expect(mockWorld.snapshots.get(`boston|${WINDOW_ID}`)!.pushClaimedAt).toBeUndefined();
  });

  it("stops starting users when the Lambda is about to time out, counts them unsent on the last run, and throws", async () => {
    addUser("gu", { state: "GU" });

    await expect(runAt("2026-11-22T22:30:00.000Z", {}, { getRemainingTimeInMillis: () => 10_000 })).rejects.toThrow(
      /could not finish 1 of 1 users/,
    );

    expect(publishedTo()).toEqual([]);
    expect(metric("WeeklyBriefPushesUnsent")).toEqual([1]);
  });

  it("never logs a user id, an endpoint ARN or an SNS error message", async () => {
    addUser("user-sub-1", { state: "NY", devices: [{}, { id: "ipad" }] });
    mockWorld.publishErrors.set(
      arn("user-sub-1", "d1"),
      Object.assign(new Error(`Throttled publishing to ${arn("user-sub-1", "d1")}`), { name: "ThrottledException" }),
    );

    await runAt(RUN_1030_ET);

    const everything = JSON.stringify(
      [console.log, console.warn, console.error].flatMap((spy) => (spy as jest.Mock).mock.calls),
    );
    expect(everything).not.toContain("user-sub-1");
    expect(everything).not.toContain("arn:aws:sns");
    expect(everything).not.toContain("Throttled publishing");
    expect(logLines(console.error).find((line) => line.message === "weeklyBriefPush summary")).toEqual(
      expect.objectContaining({ errorNames: { ThrottledException: 1 } }),
    );
  });
});
