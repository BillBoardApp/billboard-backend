import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { dispatchShardPartitionValue } from "../shared/dispatchShards";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

/*
 * S5 (feature review 2026-10-28): userNotifier holds a user's pushes from 9 PM to 8 AM in the zone of their district's
 * state (UserPII resolvedState, else selfAttestedState; Eastern time without one). A held user keeps their pending
 * rows and dispatch markers, and the claim the dispatcher took is extended to the end of the quiet hours, so the
 * first dispatch after 8 AM sends everything then pending, folded as usual.
 */

/** What the mocked command constructors return: the kind of command and the input fields the fake reads. */
interface FakeDynamoCommand {
  kind: string;
  input: {
    TableName?: string;
    Key?: Record<string, AttributeValue>;
    ExpressionAttributeValues?: Record<string, AttributeValue>;
  };
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
const at = (iso: string) => Date.parse(iso);
const epoch = (iso: string) => String(Date.parse(iso) / 1000);

const pendingRow = (guid: string, type: string) => ({
  userId: { S: USER },
  billId: { S: `${guid}#${type}` },
  sourceBillId: { S: guid },
  billTitle: { S: `Title of ${guid}` },
  category: { S: "Bill Alert" },
  lifeArea: { S: "" },
  notificationType: { S: type },
});

type Pii = { resolvedState?: string; selfAttestedState?: string } | "missing" | "error";

const sqsEvent = (body: unknown): SQSEvent =>
  ({
    Records: [{ messageId: "m-0", body: JSON.stringify(body), attributes: {}, messageAttributes: {} }],
  }) as unknown as SQSEvent;

let restoreEnv: (() => void) | undefined;
let pii: Pii;
let rows: ReturnType<typeof pendingRow>[];

const load = (env: Record<string, string | undefined>) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(
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
      ...env,
    },
    { replace: true, base: originalEnv },
  );
  jest.resetModules();
  return require("../handlers/userNotifier").handler as (event: SQSEvent) => Promise<{ batchItemFailures: unknown[] }>;
};

/** Runs the handler at `nowIso` for one user handed over in their shard. */
const runAt = async (nowIso: string, env: Record<string, string | undefined> = {}) => {
  const handler = load(env);
  jest.spyOn(Date, "now").mockReturnValue(at(nowIso));
  return handler(sqsEvent({ userIds: [USER], dispatchPartitions: { [USER]: [SHARD] } }));
};

const calls = (kind: string) =>
  mockSend.mock.calls.map(([cmd]: [FakeDynamoCommand]) => cmd).filter((cmd) => cmd.kind === kind);
const piiReads = () => calls("GetItem").filter((cmd) => cmd.input.TableName === "UserPII");
const claimHolds = () => calls("UpdateItem").filter((cmd) => cmd.input.TableName === "Pending");

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  pii = { resolvedState: "NY" };
  rows = [pendingRow("BILLS-119hr1", "alert"), pendingRow("BILLS-119hr2", "new")];
  mockSend.mockReset();
  mockSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
    const input = cmd.input;
    if (cmd.kind === "GetItem" && input.TableName === "UserPII") {
      if (pii === "error")
        throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
      if (pii === "missing") return {};
      return {
        Item: {
          userId: { S: USER },
          ...(pii.resolvedState ? { resolvedState: { S: pii.resolvedState } } : {}),
          ...(pii.selfAttestedState ? { selfAttestedState: { S: pii.selfAttestedState } } : {}),
        },
      };
    }
    if (cmd.kind === "GetItem") return { Item: { markerVersion: { S: "v1" } } };
    if (cmd.kind === "Query" && input.TableName === "Pending") return { Items: rows };
    if (cmd.kind === "Query" && input.TableName === "Devices") {
      return {
        Items: [
          { user_id: { S: USER }, device_id: { S: "phone" }, endpointArn: { S: "arn:aws:sns:x:endpoint/APNS/a/p" } },
        ],
      };
    }
    return {};
  });
  mockSnsSend.mockReset();
  mockSnsSend.mockResolvedValue({ MessageId: "m" });
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("quiet hours in userNotifier (S5)", () => {
  it("holds a Pacific user's pushes at 10:30 PM: nothing is sent or deleted, and the claim lasts until 8 AM there", async () => {
    pii = { resolvedState: "CA" };

    expect(await runAt("2026-10-29T05:30:00Z")).toEqual({ batchItemFailures: [] });

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(calls("BatchWriteItem")).toEqual([]);
    expect(calls("DeleteItem")).toEqual([]);
    expect(piiReads().map((cmd) => cmd.input)).toEqual([
      { TableName: "UserPII", Key: { userId: { S: USER } }, ProjectionExpression: "resolvedState, selfAttestedState" },
    ]);
    // 8 AM PDT on Oct 29 is 15:00Z.
    expect(claimHolds().map((cmd) => cmd.input)).toEqual([
      {
        TableName: "Pending",
        Key: { userId: { S: SHARD }, billId: { S: `__claim__#${USER}` } },
        // UX-33: every hold names its end and reason; a quiet-hours hold keeps the mark an older dispatcher reads.
        UpdateExpression:
          "SET #markerType = :claim, #targetUserId = :userId, #lease = :until, #holdUntil = :until, " +
          "#holdReason = :reason, #ttl = :until, #quietUntil = :until",
        ExpressionAttributeNames: {
          "#markerType": "markerType",
          "#targetUserId": "targetUserId",
          "#lease": "leaseExpiresAtEpoch",
          "#holdUntil": "holdUntilEpoch",
          "#holdReason": "holdReason",
          "#ttl": "ttl",
          "#quietUntil": "quietHoursUntilEpoch",
        },
        ExpressionAttributeValues: {
          ":claim": { S: "dispatch-claim" },
          ":userId": { S: USER },
          ":until": { N: epoch("2026-10-29T15:00:00Z") },
          ":reason": { S: "quiet_hours" },
        },
      },
    ]);
    const outcomes = logLines(console.log).filter((line) => line.message === "Bill notification outcome");
    expect(outcomes.map((line) => [line.guid, line.outcome, line.heldUntil, line.holdReason])).toEqual([
      ["BILLS-119hr1", "held", "2026-10-29T15:00:00.000Z", "quiet_hours"],
      ["BILLS-119hr2", "held", "2026-10-29T15:00:00.000Z", "quiet_hours"],
    ]);
    // UX-33: the held rows are counted.
    expect(logLines(console.log).filter((line) => line._aws)).toEqual([
      expect.objectContaining({ NotificationsHeldQuietHours: 2, holdReason: "quiet_hours" }),
    ]);
  });

  it("sends to a Hawaii user at the same instant (7:30 PM there)", async () => {
    pii = { resolvedState: "HI" };

    await runAt("2026-10-29T05:30:00Z");

    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    expect(claimHolds()).toEqual([]);
    expect(calls("BatchWriteItem")).toHaveLength(1);
  });

  it.each([
    ["8:59 PM", "2026-10-29T00:59:00Z", false],
    ["9:00 PM", "2026-10-29T01:00:00Z", true],
    ["7:59 AM", "2026-10-29T11:59:00Z", true],
    ["8:00 AM", "2026-10-29T12:00:00Z", false],
  ])("for an Eastern-time user, at %s holds: %s", async (_label, now, held) => {
    await runAt(now);

    expect(mockSnsSend).toHaveBeenCalledTimes(held ? 0 : 1);
    expect(claimHolds()).toHaveLength(held ? 1 : 0);
  });

  it("holds through the 2026-11-01 clock change until 8 AM EST", async () => {
    // 7:30 AM EST, which a fixed EDT offset would read as 8:30.
    await runAt("2026-11-01T12:30:00Z");

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(claimHolds()[0].input.ExpressionAttributeValues![":until"]).toEqual({ N: epoch("2026-11-01T13:00:00Z") });
  });

  it.each<[string, Pii, boolean]>([
    ["the verified state over the self-attested one", { resolvedState: "AZ", selfAttestedState: "NY" }, false],
    ["the self-attested state when there is no verified one", { selfAttestedState: "AZ" }, false],
    ["Eastern time without a state", {}, true],
    ["Eastern time without a UserPII row", "missing", true],
    ["Eastern time for a value that is not a state", { resolvedState: "Arizona" }, true],
  ])("uses %s", async (_case, value, held) => {
    pii = value;
    // 9:30 PM EDT, 6:30 PM in Arizona.
    await runAt("2026-10-29T01:30:00Z");

    expect(mockSnsSend).toHaveBeenCalledTimes(held ? 0 : 1);
  });

  it("uses Eastern time, and warns, when UserPII cannot be read", async () => {
    pii = "error";

    expect(await runAt("2026-10-29T01:30:00Z")).toEqual({ batchItemFailures: [] });

    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(claimHolds()).toHaveLength(1);
    expect(logLines(console.warn).map((line) => line.message)).toContain(
      "Could not read the user's state; using Eastern time for quiet hours",
    );
  });

  it("holds the claim in every partition the dispatcher handed over", async () => {
    const handler = load({});
    jest.spyOn(Date, "now").mockReturnValue(at("2026-10-29T03:00:00Z"));

    await handler(sqsEvent({ userIds: [USER], dispatchPartitions: { [USER]: [SHARD, "__dispatch__"] } }));

    expect(claimHolds().map((cmd) => cmd.input.Key!.userId.S)).toEqual([SHARD, "__dispatch__"]);
  });

  it("fails the user, and sends nothing, when the claim cannot be extended", async () => {
    const fallback = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      if (cmd.kind === "UpdateItem") throw new Error("throttled");
      return fallback(cmd);
    });

    const result = await runAt("2026-10-29T03:00:00Z");

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m-0" }] });
    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(calls("BatchWriteItem")).toEqual([]);
  });

  it("sends everything pending, folded as usual, in the first dispatch after 8 AM", async () => {
    rows = [
      pendingRow("BILLS-119hr1", "alert"),
      pendingRow("BILLS-119hr2", "alert"),
      pendingRow("BILLS-119hr3", "updated"),
    ];

    await runAt("2026-10-29T12:05:00Z");

    const pushes = mockSnsSend.mock.calls.map(([cmd]) => JSON.parse(JSON.parse(cmd.input.Message).APNS));
    expect(pushes.map((apns) => [apns.aps.alert.title, apns.notificationType, apns.billIds])).toEqual([
      ["Action on 2 Bills", "digest", ["BILLS-119hr1", "BILLS-119hr2"]],
      ["Updated: Title of BILLS-119hr3", "updated", ["BILLS-119hr3"]],
    ]);
    expect(calls("BatchWriteItem")).toHaveLength(1);
    expect(calls("DeleteItem").map((cmd) => cmd.input.Key!.billId.S)).toEqual([USER, `__claim__#${USER}`]);
  });

  it.each([[undefined], ["off"], ["ON"], ["true"]])(
    "with QUIET_HOURS=%j sends at any hour and never reads UserPII",
    async (mode) => {
      await runAt("2026-10-29T07:00:00Z", { QUIET_HOURS: mode });

      expect(mockSnsSend).toHaveBeenCalledTimes(1);
      expect(piiReads()).toEqual([]);
      expect(claimHolds()).toEqual([]);
    },
  );

  it("reads no state for a user with nothing pending", async () => {
    rows = [];

    await runAt("2026-10-29T03:00:00Z");

    expect(piiReads()).toEqual([]);
    expect(claimHolds()).toEqual([]);
  });
});
