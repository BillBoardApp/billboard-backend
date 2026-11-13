jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

import type {
  AttributeValue,
  BatchGetItemCommandInput,
  GetItemCommandInput,
  PutItemCommandInput,
  QueryCommandInput,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";

import { applyTestEnv } from "./fixtures/env";

/** The input of the commands the fake DynamoDB answers, in its own field names. */
type DynamoInput = Partial<
  GetItemCommandInput & QueryCommandInput & PutItemCommandInput & UpdateItemCommandInput & BatchGetItemCommandInput
>;
interface FakeCommand {
  constructor: { name: string };
  input: DynamoInput;
}
/** The mocked DynamoDBClient's send. */
type DynamoSend = jest.Mock<unknown, [FakeCommand]>;
type Row = Record<string, AttributeValue>;

process.env.STATS_TABLE_NAME = "BillStats";
process.env.STATS_PARTITION_KEY = "billId";
// INT-11: every request reads the caller's vote first.
process.env.FEEDBACK_TABLE_NAME = "UserFeedback";
process.env.FEEDBACK_PARTITION_KEY = "userId";
process.env.FEEDBACK_SORT_KEY = "billId";

const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { handler } = require("../handlers/fetchBillStats");
const {
  applyStatsSampleFloor,
  computeBillStats,
  writeCachedStats,
  STATS_MIN_DECISION_VOTES,
} = require("../shared/billStats");

// Same shape withPercentages produces; only decisionVotes drives the floor.
const bucket = (yea: number, nay: number, abstain = 0) => ({
  votes: yea + nay + abstain,
  yea,
  nay,
  abstain,
  decisionVotes: yea + nay,
  yeaPct: yea + nay > 0 ? (yea / (yea + nay)) * 100 : null,
  weightedVotes: yea + nay + abstain,
  weightedYea: yea,
  weightedNay: nay,
  weightedAbstain: abstain,
  weightedDecisionVotes: yea + nay,
  weightedYeaPct: yea + nay > 0 ? (yea / (yea + nay)) * 100 : null,
});
type Bucket = ReturnType<typeof bucket>;
const emptyBucket = bucket(0, 0);
const rollup = (yea: number, nay: number) => ({
  totals: bucket(yea, nay),
  segments: { verified: bucket(yea, nay), selfAttested: emptyBucket },
});
const statsPayload = (overrides: Record<string, unknown> = {}) => ({
  billId: "BILLS-119hr1",
  generatedAt: "2026-02-28T00:00:00.000Z",
  totals: bucket(20, 10),
  segments: { verified: bucket(8, 4), selfAttested: bucket(12, 6) },
  rollups: {
    byState: { CA: { state: "CA", ...rollup(8, 4) } },
    byDistrict: {
      "CA|12": { state: "CA", district: "12", ...rollup(4, 2) },
      "CA|13": { state: "CA", district: "13", ...rollup(4, 2) },
    },
  },
  reasonBreakdown: {
    minCount: 5,
    yea: { voteCount: 20, reasons: [] },
    nay: { voteCount: 10, reasons: [] },
  },
  ...overrides,
});
type Stats = ReturnType<typeof statsPayload>;
// 2C (C2 3.1): the comparison every 200 body carries, derived here independently of toServedStats.
const plainSplit = (b: Bucket) => ({
  votes: b.votes,
  yea: b.yea,
  nay: b.nay,
  abstain: b.abstain,
  decisionVotes: b.decisionVotes,
  yeaPct: b.yeaPct,
});
const expectedComparison = (stats: Stats) =>
  stats.segments.verified.decisionVotes >= 5
    ? {
        allUsers: plainSplit(stats.totals),
        verified: plainSplit(stats.segments.verified),
        verifiedWithheld: false,
        minDecisionVotes: 5,
      }
    : { allUsers: plainSplit(stats.totals), verifiedWithheld: true, minDecisionVotes: 5 };
/** What GET /bill-stats serves for a stored payload whose buckets already have equal weights. */
const served = (stats: Stats) => ({ ...stats, comparison: expectedComparison(stats) });
/** The same bucket as stored before 2C, with the verified votes at 1.25. */
const weightedAt125 = (yea: number, nay: number) => ({
  ...bucket(yea, nay),
  weightedVotes: (yea + nay) * 1.25,
  weightedYea: yea * 1.25,
  weightedNay: nay * 1.25,
  weightedDecisionVotes: (yea + nay) * 1.25,
  weightedYeaPct: 99,
});

// INT-11: the BatchGetItem answer for a caller who holds a vote on the bill.
const holdsVote = (feedback = "Yea") => ({ Responses: { UserFeedback: [{ feedback: { S: feedback } }] } });

describe("fetchBillStats handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await handler({ queryStringParameters: { billId: "BILLS-119hr1" } });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      message: "Unauthorized (missing authorizer claims)",
    });
  });

  it("returns 400 when billId is missing", async () => {
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: {},
    };

    const response = await handler(event);
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Missing billId" });
  });

  it("returns cached stats when available", async () => {
    const cached = statsPayload();

    mockSend.mockResolvedValueOnce(holdsVote());
    mockSend.mockResolvedValueOnce({
      Item: {
        schemaVersion: { S: "4" },
        payload: { S: JSON.stringify(cached) },
      },
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILLS-119hr1" },
    };

    const response = await handler(event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(served(cached));
    expect(JSON.parse(response.body).comparison).toEqual({
      allUsers: { votes: 30, yea: 20, nay: 10, abstain: 0, decisionVotes: 30, yeaPct: (20 / 30) * 100 },
      verified: { votes: 12, yea: 8, nay: 4, abstain: 0, decisionVotes: 12, yeaPct: (8 / 12) * 100 },
      verifiedWithheld: false,
      minDecisionVotes: 5,
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("serves a payload cached at the old 1.25 weight with every weighted field equal to its plain one (2C)", async () => {
    const cached = statsPayload({
      totals: weightedAt125(20, 10),
      segments: { verified: weightedAt125(8, 4), selfAttested: bucket(12, 6) },
      rollups: {
        byState: {
          CA: {
            state: "CA",
            totals: weightedAt125(8, 4),
            segments: { verified: weightedAt125(8, 4), selfAttested: emptyBucket },
          },
        },
        byDistrict: {
          "CA|12": {
            state: "CA",
            district: "12",
            totals: weightedAt125(4, 2),
            segments: { verified: weightedAt125(4, 2), selfAttested: emptyBucket },
          },
          "CA|13": {
            state: "CA",
            district: "13",
            totals: weightedAt125(4, 2),
            segments: { verified: weightedAt125(4, 2), selfAttested: emptyBucket },
          },
        },
      },
    });
    mockSend.mockResolvedValueOnce(holdsVote());
    mockSend.mockResolvedValueOnce({ Item: { schemaVersion: { S: "4" }, payload: { S: JSON.stringify(cached) } } });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILLS-119hr1" },
    });

    // Exactly the payload stored at equal weights, plus the comparison.
    expect(JSON.parse(response.body)).toEqual(served(statsPayload()));
    // Nothing is written back: the cached row is normalized on read only.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][0].input.Item).toBeUndefined();
  });

  it("returns empty stats shape when cache is missing", async () => {
    mockSend.mockResolvedValueOnce(holdsVote("Abstain"));
    mockSend.mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILLS-119hr2" },
    };

    const response = await handler(event);
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.billId).toBe("BILLS-119hr2");
    expect(body.totals).toEqual(
      expect.objectContaining({
        votes: 0,
        yea: 0,
        nay: 0,
        abstain: 0,
        weightedVotes: 0,
        weightedYea: 0,
        weightedNay: 0,
        weightedAbstain: 0,
      }),
    );
    expect(body.rollups).toEqual({ byState: {}, byDistrict: {} });
    expect(body.comparison).toEqual({
      allUsers: { votes: 0, yea: 0, nay: 0, abstain: 0, decisionVotes: 0, yeaPct: null },
      verifiedWithheld: true,
      minDecisionVotes: 5,
    });
    expect(body.totals).toMatchObject({ weightedDecisionVotes: 0, weightedYeaPct: null });
  });

  it("applies the sample floor to payloads cached before it existed", async () => {
    const legacy = statsPayload({
      totals: bucket(3, 1),
      segments: { verified: bucket(1, 0), selfAttested: bucket(2, 1) },
      rollups: {
        byState: { WY: { state: "WY", ...rollup(1, 0) } },
        byDistrict: { "WY|AL": { state: "WY", district: "AL", ...rollup(1, 0) } },
      },
    });
    mockSend.mockResolvedValueOnce(holdsVote("Nay"));
    mockSend.mockResolvedValueOnce({
      Item: { schemaVersion: { S: "4" }, payload: { S: JSON.stringify(legacy) } },
    });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILLS-119hr1" },
    });

    const body = JSON.parse(response.body);
    expect(body.totals).toEqual(bucket(3, 1));
    expect(body.segments).toEqual({ verified: emptyBucket, selfAttested: emptyBucket });
    expect(body.rollups).toEqual({ byState: {}, byDistrict: {} });
    // The floor emptied the segments, so the verified split is withheld too.
    expect(body.comparison).toEqual({
      allUsers: plainSplit(bucket(3, 1)),
      verifiedWithheld: true,
      minDecisionVotes: 5,
    });
  });
});

describe("bill stats sample floor (INT-01)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("matches the app's low-sample threshold", () => {
    expect(STATS_MIN_DECISION_VOTES).toBe(5);
  });

  it("keeps buckets at the floor and the totals as they are", () => {
    const stats = statsPayload({
      segments: { verified: bucket(3, 2), selfAttested: bucket(17, 8) },
      rollups: {
        byState: { CA: { state: "CA", ...rollup(3, 2) } },
        byDistrict: { "CA|12": { state: "CA", district: "12", ...rollup(3, 2) } },
      },
    });
    expect(applyStatsSampleFloor(stats)).toEqual(stats);
  });

  it("omits state and district rollups under the floor, counting only Yea and Nay", () => {
    const floored = applyStatsSampleFloor(
      statsPayload({
        segments: { verified: bucket(8, 4), selfAttested: bucket(12, 6) },
        rollups: {
          byState: {
            CA: { state: "CA", ...rollup(6, 2) },
            WY: {
              state: "WY",
              totals: bucket(3, 1, 9),
              segments: { verified: bucket(3, 1, 9), selfAttested: emptyBucket },
            },
          },
          byDistrict: {
            "CA|12": { state: "CA", district: "12", ...rollup(6, 2) },
            "WY|AL": {
              state: "WY",
              district: "AL",
              totals: bucket(3, 1, 9),
              segments: { verified: bucket(3, 1, 9), selfAttested: emptyBucket },
            },
          },
        },
      }),
    );
    expect(Object.keys(floored.rollups.byState)).toEqual(["CA"]);
    expect(Object.keys(floored.rollups.byDistrict)).toEqual(["CA|12"]);
    expect(floored.totals).toEqual(bucket(20, 10));
  });

  it("also hides the smallest shown district when state minus shown districts would expose 1 to 4 votes", () => {
    const floored = applyStatsSampleFloor(
      statsPayload({
        segments: { verified: bucket(8, 4), selfAttested: bucket(12, 6) },
        rollups: {
          byState: { CA: { state: "CA", ...rollup(8, 4) } },
          byDistrict: {
            "CA|12": { state: "CA", district: "12", ...rollup(4, 2) },
            "CA|13": { state: "CA", district: "13", ...rollup(3, 2) },
            // One verified voter: state 12 - (6 + 5) would reveal this vote without the extra suppression.
            "CA|14": { state: "CA", district: "14", ...rollup(1, 0) },
          },
        },
      }),
    );
    expect(Object.keys(floored.rollups.byDistrict)).toEqual(["CA|12"]);
    expect(Object.keys(floored.rollups.byState)).toEqual(["CA"]);
  });

  it("publishes both segments empty when the verified segment is under the floor", () => {
    const floored = applyStatsSampleFloor(
      statsPayload({
        totals: bucket(10, 3),
        segments: { verified: bucket(2, 2), selfAttested: bucket(8, 1) },
        rollups: { byState: {}, byDistrict: {} },
      }),
    );
    expect(floored.segments).toEqual({ verified: emptyBucket, selfAttested: emptyBucket });
    expect(floored.totals).toEqual(bucket(10, 3));
  });

  it("publishes both segments empty when verified minus shown states would expose 1 to 4 votes", () => {
    const floored = applyStatsSampleFloor(
      statsPayload({
        segments: { verified: bucket(6, 1), selfAttested: bucket(14, 9) },
        rollups: {
          byState: { CA: { state: "CA", ...rollup(4, 1) }, WY: { state: "WY", ...rollup(2, 0) } },
          byDistrict: {},
        },
      }),
    );
    expect(Object.keys(floored.rollups.byState)).toEqual(["CA"]);
    expect(floored.segments).toEqual({ verified: emptyBucket, selfAttested: emptyBucket });
  });

  it("is idempotent", () => {
    const once = applyStatsSampleFloor(
      statsPayload({
        rollups: {
          byState: { CA: { state: "CA", ...rollup(8, 4) } },
          byDistrict: {
            "CA|12": { state: "CA", district: "12", ...rollup(4, 2) },
            "CA|13": { state: "CA", district: "13", ...rollup(3, 2) },
            "CA|14": { state: "CA", district: "14", ...rollup(1, 0) },
          },
        },
      }),
    );
    expect(applyStatsSampleFloor(once)).toEqual(once);
  });

  it("computeBillStats applies the floor to verified-only rollups", async () => {
    const vote = (feedback: string, verified: boolean, district: string) => ({
      feedback: { S: feedback },
      constituentVerified: { BOOL: verified },
      ...(verified ? { resolvedState: { S: "ca" }, resolvedDistrict: { S: district } } : {}),
    });
    mockSend.mockResolvedValueOnce({
      Items: [
        ...Array.from({ length: 5 }, () => vote("Yea", true, "12")),
        vote("Nay", true, "13"),
        vote("Nay", false, "13"),
      ],
    });

    const stats = await computeBillStats({
      db: { send: mockSend },
      tableName: "UserFeedback",
      partitionKey: "userId",
      sortKey: "billId",
      billIdIndexName: "GSIBillIdIndex",
      billId: "BILL-3",
    });

    expect(stats.totals.decisionVotes).toBe(7);
    expect(stats.segments.verified.decisionVotes).toBe(6);
    expect(Object.keys(stats.rollups.byState)).toEqual(["CA"]);
    // CA|12 clears the floor, but CA (6) minus CA|12 (5) would reveal CA|13's single vote.
    expect(stats.rollups.byDistrict).toEqual({});
  });

  it("writeCachedStats stores the floored payload and propagates write errors (REL-11)", async () => {
    const raw = statsPayload({
      segments: { verified: bucket(1, 0), selfAttested: bucket(19, 10) },
      rollups: { byState: { WY: { state: "WY", ...rollup(1, 0) } }, byDistrict: {} },
    });

    mockSend.mockResolvedValueOnce({});
    await writeCachedStats({
      db: { send: mockSend },
      statsTableName: "BillStats",
      statsPartitionKey: "billId",
      stats: raw,
    });
    const stored = JSON.parse(mockSend.mock.calls[0][0].input.Item.payload.S);
    expect(stored.rollups.byState).toEqual({});
    expect(stored.segments.verified).toEqual(emptyBucket);

    mockSend.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      writeCachedStats({
        db: { send: mockSend },
        statsTableName: "BillStats",
        statsPartitionKey: "billId",
        stats: raw,
      }),
    ).rejects.toThrow("write failed");
  });
});

export {};

describe("fetchBillStats scope=companions (APPF-23)", () => {
  const HOUSE = "BILLS-119hr1285";
  const SENATE = "BILLS-119s570";
  const GROUP_KEY = `COMPANIONS#${HOUSE}#${SENATE}`;
  const claims = { requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } } };
  const vote = (userId: string, feedback: string) => ({
    userId: { S: userId },
    feedback: { S: feedback },
    constituentVerified: { BOOL: false },
    effectiveWeight: { N: "1.0" },
  });
  const votesByBill: Record<string, ReturnType<typeof vote>[]> = {
    [HOUSE]: [vote("u1", "Yea"), vote("u2", "Nay")],
    [SENATE]: [vote("u1", "Nay"), vote("u3", "Yea")],
  };
  let send: DynamoSend;
  let fetchStats: (event: unknown) => Promise<{ statusCode: number; body: string }>;
  let stored: Record<string, unknown>;
  let groupsEnabled: boolean;
  // INT-11: the bills the caller (user-1) voted on; the gate reads them before any stats.
  let callerVotes: Set<string>;
  let restore: () => void;

  beforeEach(() => {
    jest.resetModules();
    restore = applyTestEnv({
      MANIFEST_TABLE_NAME: "BillsManifest",
      MANIFEST_PRIMARY_KEY: "pk",
      FEEDBACK_TABLE_NAME: "UserFeedback",
      FEEDBACK_PARTITION_KEY: "userId",
      FEEDBACK_SORT_KEY: "billId",
      FEEDBACK_BILL_ID_INDEX_NAME: "GSIBillIdIndex",
    });
    stored = {};
    groupsEnabled = true;
    callerVotes = new Set([HOUSE]);
    ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
    send.mockReset();
    send.mockImplementation(async (command: FakeCommand) => {
      const input: DynamoInput = command.input ?? {};
      if (input.RequestItems?.UserFeedback) {
        const keys = input.RequestItems.UserFeedback.Keys as { billId: { S: string } }[];
        const held = keys.filter((key) => callerVotes.has(key.billId.S));
        return { Responses: { UserFeedback: held.map(() => ({ feedback: { S: "Yea" } })) } };
      }
      if (input.Key?.pk?.S === "BILL_COMPANION_GROUPS") {
        return {
          Item: {
            pk: { S: "BILL_COMPANION_GROUPS" },
            sk: { S: "CURRENT" },
            pairsVersion: { N: "1" },
            enabled: { BOOL: groupsEnabled },
            pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
          },
        };
      }
      if (input.TableName === "BillStats" && input.Key) {
        const payload = stored[input.Key.billId.S!];
        return payload ? { Item: { schemaVersion: { S: "4" }, payload: { S: JSON.stringify(payload) } } } : {};
      }
      if (input.IndexName === "GSIBillIdIndex")
        return { Items: votesByBill[input.ExpressionAttributeValues![":billId"].S!] };
      throw new Error(`Unexpected call: ${JSON.stringify(input)}`);
    });
    fetchStats = require("../handlers/fetchBillStats").handler;
  });

  afterEach(() => {
    restore();
    jest.useRealTimers();
  });

  const request = async (billId: string, scope?: string) => {
    const response = await fetchStats({ ...claims, queryStringParameters: { billId, ...(scope ? { scope } : {}) } });
    return { statusCode: response.statusCode, body: JSON.parse(response.body) };
  };
  const featureQueries = () => send.mock.calls.filter(([command]) => command.input?.IndexName);
  const writes = () => send.mock.calls.filter(([command]) => command.input?.Item || command.input?.UpdateExpression);

  it("serves the stored group document under the requested bill id, with the members", async () => {
    stored[GROUP_KEY] = statsPayload({ billId: GROUP_KEY });

    const { statusCode, body } = await request(SENATE, "companions");

    expect(statusCode).toBe(200);
    expect(body).toEqual({ ...served(statsPayload()), billId: SENATE, companionBillIds: [HOUSE, SENATE] });
    expect(featureQueries()).toHaveLength(0);
  });

  it("serves a group document stored at the old 1.25 weight with equal weights (2C)", async () => {
    stored[GROUP_KEY] = statsPayload({
      billId: GROUP_KEY,
      totals: weightedAt125(20, 10),
      segments: { verified: weightedAt125(8, 4), selfAttested: bucket(12, 6) },
    });

    const { body } = await request(SENATE, "companions");

    expect(body).toEqual({ ...served(statsPayload()), billId: SENATE, companionBillIds: [HOUSE, SENATE] });
  });

  describe("a group document older than a member's own stats", () => {
    // 40 votes when the group was last recomputed; H.R. 1285 got more votes afterwards (while the
    // groups were off, or in a batch whose groups read failed), so its own stats are newer.
    beforeEach(() => {
      stored[GROUP_KEY] = statsPayload({
        billId: GROUP_KEY,
        generatedAt: "2026-09-01T00:00:00.000Z",
        totals: bucket(40, 0),
      });
      stored[HOUSE] = statsPayload({ billId: HOUSE, generatedAt: "2026-09-10T00:00:00.000Z" });
    });

    it("is folded again from the members' votes, without writing", async () => {
      const { body } = await request(SENATE, "companions");

      expect(body).toMatchObject({
        billId: SENATE,
        companionBillIds: [HOUSE, SENATE],
        totals: { votes: 3, yea: 2, nay: 1 },
      });
      // The fold carries the comparison too (every voter here is self-attested).
      expect(body.comparison).toEqual({
        allUsers: { votes: 3, yea: 2, nay: 1, abstain: 0, decisionVotes: 3, yeaPct: 66.6667 },
        verifiedWithheld: true,
        minDecisionVotes: 5,
      });
      expect(body.totals).toMatchObject({ weightedVotes: 3, weightedYeaPct: 66.6667 });
      expect(featureQueries()).toHaveLength(2);
      expect(writes()).toHaveLength(0);
    });

    it("is still served when the fold fails", async () => {
      const route = send.getMockImplementation()!;
      send.mockImplementation(async (command: FakeCommand) => {
        if (command.input?.IndexName) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        return route(command);
      });
      jest.spyOn(console, "warn").mockImplementation(() => undefined);

      const { body } = await request(SENATE, "companions");

      expect(body).toMatchObject({ billId: SENATE, companionBillIds: [HOUSE, SENATE], totals: { yea: 40 } });
    });

    it("is served as stored once the aggregator has recomputed the group after the member", async () => {
      stored[GROUP_KEY] = { ...(stored[GROUP_KEY] as object), generatedAt: "2026-09-10T00:00:01.000Z" };

      const { body } = await request(SENATE, "companions");

      expect(body).toMatchObject({ totals: { yea: 40 } });
      expect(featureQueries()).toHaveLength(0);
    });
  });

  it("folds the members' votes when there is no group document, without writing, and keeps it for 60 s", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-25T10:00:00.000Z") });

    const first = await request(HOUSE, "companions");
    expect(first.body).toMatchObject({
      billId: HOUSE,
      companionBillIds: [HOUSE, SENATE],
      totals: { votes: 3, yea: 2, nay: 1 },
    });
    expect(featureQueries().map(([command]) => command.input.ExpressionAttributeValues![":billId"].S!)).toEqual([
      HOUSE,
      SENATE,
    ]);

    jest.setSystemTime(new Date("2026-09-25T10:00:59.000Z"));
    await request(SENATE, "companions");
    expect(featureQueries()).toHaveLength(2);

    jest.setSystemTime(new Date("2026-09-25T10:01:01.000Z"));
    await request(SENATE, "companions");
    expect(featureQueries()).toHaveLength(4);
    expect(writes()).toHaveLength(0);
  });

  it("leaves 1.0 and 1.1 dismissals out of the votes it combines, and lets a dismissal hide no vote (INT-11)", async () => {
    const dismissal = (userId: string) => ({ ...vote(userId, "Abstain"), legacyDismiss: { BOOL: true } });
    const route = send.getMockImplementation()!;
    send.mockImplementation(async (command: FakeCommand) => {
      if (command.input?.IndexName) {
        const billId = command.input.ExpressionAttributeValues![":billId"].S!;
        // u2 dismissed the House primary in Updates and voted Nay on the Senate bill; u4 and u5 only dismissed.
        return {
          Items:
            billId === HOUSE
              ? [vote("u1", "Yea"), dismissal("u2"), dismissal("u4")]
              : [vote("u2", "Nay"), vote("u3", "Abstain"), dismissal("u5")],
        };
      }
      return route(command);
    });

    const { statusCode, body } = await request(HOUSE, "companions");

    expect(statusCode).toBe(200);
    expect(body.totals).toMatchObject({ votes: 3, yea: 1, nay: 1, abstain: 1 });
    expect(body.comparison.allUsers).toEqual({ votes: 3, yea: 1, nay: 1, abstain: 1, decisionVotes: 2, yeaPct: 50 });
    expect(featureQueries()[0][0].input.ProjectionExpression).toContain("legacyDismiss");
    expect(writes()).toHaveLength(0);
  });

  it("answers as before without scope, with scope=bill, for an ungrouped bill and while groups are off", async () => {
    stored[SENATE] = statsPayload({ billId: SENATE });
    stored[GROUP_KEY] = statsPayload({ billId: GROUP_KEY, totals: bucket(99, 1) });
    callerVotes.add("BILLS-119hr77");
    const statsKeysRead = () =>
      send.mock.calls
        .filter(([command]) => command.input?.TableName === "BillStats")
        .map(([command]) => command.input.Key!.billId.S!);

    const plain = await request(SENATE);
    expect(plain.body).toEqual(served(statsPayload({ billId: SENATE })));
    // scope=bill reads the bill's own stats only (INT-11 reads the groups for the vote check alone).
    expect(statsKeysRead()).toEqual([SENATE]);
    expect((await request(SENATE, "bill")).body).toEqual(plain.body);

    const ungrouped = await request("BILLS-119hr77", "companions");
    expect(ungrouped.body.billId).toBe("BILLS-119hr77");
    expect(ungrouped.body).not.toHaveProperty("companionBillIds");

    groupsEnabled = false;
    jest.resetModules();
    ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
    send.mockImplementation(async (command: FakeCommand) =>
      command.input?.RequestItems
        ? { Responses: { UserFeedback: [{ feedback: { S: "Yea" } }] } }
        : command.input?.Key?.pk?.S === "BILL_COMPANION_GROUPS"
          ? { Item: { pairsVersion: { N: "2" }, enabled: { BOOL: false }, pairs: { S: "[]" } } }
          : { Item: { schemaVersion: { S: "4" }, payload: { S: JSON.stringify(stored[SENATE]) } } },
    );
    fetchStats = require("../handlers/fetchBillStats").handler;
    expect((await request(SENATE, "companions")).body).toEqual(plain.body);
  });

  it("rejects an unknown scope", async () => {
    const { statusCode, body } = await request(SENATE, "everything");

    expect(statusCode).toBe(400);
    expect(body).toEqual({ error: "Invalid scope" });
  });

  it("falls back to the bill's own stats when the members' votes cannot be read", async () => {
    stored[SENATE] = statsPayload({ billId: SENATE });
    const route = send.getMockImplementation()!;
    send.mockImplementation(async (command: FakeCommand) => {
      if (command.input?.IndexName) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
      return route(command);
    });
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const { body } = await request(SENATE, "companions");

    expect(body).toEqual(served(statsPayload({ billId: SENATE })));
  });
});

describe("fetchBillStats results gate (INT-11)", () => {
  const HOUSE = "BILLS-119hr1285";
  const SENATE = "BILLS-119s570";
  const UNGROUPED = "BILLS-119hr77";
  const UNRELATED = "BILLS-119hr9";
  const GROUP_KEY = `COMPANIONS#${HOUSE}#${SENATE}`;
  const LOCKED = { error: "RESULTS_LOCKED", message: "Vote or abstain on this bill to see its results." };
  let send: DynamoSend;
  let fetchStats: (event: unknown) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;
  let stored: Record<string, unknown>;
  /** "userId|billId" -> the stored feedback value; null stores a row without the attribute. */
  let rows: Map<string, string | null>;
  /** "userId|billId" of rows setFeedback stored as a 1.0 or 1.1 dismissal (legacyDismiss). */
  let dismissals: Set<string>;
  let groups: "on" | "off" | "fail";
  /** How many feedback reads still answer every key as unprocessed. */
  let unprocessedReads: number;
  let restore: () => void;
  let logLines: string[];

  const loadHandler = () => {
    jest.resetModules();
    ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
    send.mockReset();
    send.mockImplementation(async (command: FakeCommand) => {
      const input: DynamoInput = command.input ?? {};
      if (input.RequestItems) {
        const request = input.RequestItems.UserFeedback;
        if (!request) throw new Error(`Unexpected batch read: ${JSON.stringify(input)}`);
        if (unprocessedReads > 0) {
          unprocessedReads -= 1;
          return { Responses: { UserFeedback: [] }, UnprocessedKeys: { UserFeedback: { ...request } } };
        }
        const items = (request.Keys as { userId: { S: string }; billId: { S: string } }[])
          .filter((key) => rows.has(`${key.userId.S}|${key.billId.S}`))
          .map((key) => {
            const rowKey = `${key.userId.S}|${key.billId.S}`;
            const feedback = rows.get(rowKey);
            const mark = dismissals.has(rowKey) ? { legacyDismiss: { BOOL: true } } : {};
            return feedback === null ? mark : { feedback: { S: feedback }, ...mark };
          });
        return { Responses: { UserFeedback: items } };
      }
      if (input.Key?.pk?.S === "BILL_COMPANION_GROUPS") {
        if (groups === "fail") throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        return {
          Item: {
            pk: { S: "BILL_COMPANION_GROUPS" },
            sk: { S: "CURRENT" },
            pairsVersion: { N: "1" },
            enabled: { BOOL: groups === "on" },
            pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
          },
        };
      }
      if (input.TableName === "BillStats" && input.Key) {
        const payload = stored[input.Key.billId.S!];
        return payload ? { Item: { schemaVersion: { S: "4" }, payload: { S: JSON.stringify(payload) } } } : {};
      }
      if (input.IndexName === "GSIBillIdIndex") return { Items: [] };
      throw new Error(`Unexpected call: ${JSON.stringify(input)}`);
    });
    fetchStats = require("../handlers/fetchBillStats").handler;
  };

  beforeEach(() => {
    restore = applyTestEnv({
      MANIFEST_TABLE_NAME: "BillsManifest",
      MANIFEST_PRIMARY_KEY: "pk",
      FEEDBACK_TABLE_NAME: "UserFeedback",
      FEEDBACK_PARTITION_KEY: "userId",
      FEEDBACK_SORT_KEY: "billId",
      FEEDBACK_BILL_ID_INDEX_NAME: "GSIBillIdIndex",
    });
    stored = {
      [HOUSE]: statsPayload({ billId: HOUSE }),
      [SENATE]: statsPayload({ billId: SENATE, totals: bucket(7, 3) }),
      [GROUP_KEY]: statsPayload({ billId: GROUP_KEY, totals: bucket(27, 13), generatedAt: "2026-10-01T00:00:00.000Z" }),
      [UNGROUPED]: statsPayload({ billId: UNGROUPED }),
      [`${UNGROUPED}ih`]: statsPayload({ billId: `${UNGROUPED}ih` }),
    };
    rows = new Map();
    dismissals = new Set();
    groups = "on";
    unprocessedReads = 0;
    logLines = [];
    jest.spyOn(console, "log").mockImplementation((line?: unknown) => void logLines.push(String(line)));
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    loadHandler();
  });

  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  const request = async (billId: string, scope?: string, sub = "user-1", extra: Record<string, string> = {}) => {
    const response = await fetchStats({
      requestContext: { authorizer: { jwt: { claims: { sub } } } },
      queryStringParameters: { billId, ...(scope ? { scope } : {}), ...extra },
    });
    return { statusCode: response.statusCode, headers: response.headers, body: JSON.parse(response.body) };
  };
  const feedbackReads = () =>
    send.mock.calls.filter(([command]) => command.input?.RequestItems).map(([command]) => command.input);
  const keysRead = () =>
    feedbackReads().map((input) => input.RequestItems!.UserFeedback.Keys!.map((key) => key.billId.S));
  const statsReads = () => send.mock.calls.filter(([command]) => command.input?.TableName === "BillStats");
  const indexQueries = () => send.mock.calls.filter(([command]) => command.input?.IndexName);
  const lockedMetricLines = () => logLines.filter((line) => line.includes('"ResultsLocked"'));

  it.each([
    [HOUSE, undefined],
    [HOUSE, "bill"],
    [HOUSE, "companions"],
    [SENATE, "companions"],
    [UNGROUPED, undefined],
  ])(
    "answers %s scope=%s with 403 RESULTS_LOCKED to a caller with no vote, and reads no stats",
    async (billId, scope) => {
      const { statusCode, headers, body } = await request(billId, scope);

      expect(statusCode).toBe(403);
      expect(headers).toEqual({ "Content-Type": "application/json" });
      expect(body).toEqual(LOCKED);
      // No stats document, no member stats, no fold of the votes: nothing is read before the check.
      expect(statsReads()).toHaveLength(0);
      expect(indexQueries()).toHaveLength(0);
      expect(feedbackReads()).toHaveLength(1);

      const [metric] = lockedMetricLines();
      expect(JSON.parse(metric)).toMatchObject({
        ResultsLocked: 1,
        _aws: { CloudWatchMetrics: [{ Namespace: "BillBoard/BillStats", Metrics: [{ Name: "ResultsLocked" }] }] },
      });
      expect(metric).not.toContain("user-1");
    },
  );

  it.each(["Yea", "Nay", "Abstain"])(
    "a %s row unlocks the same 200 body as before INT-11, for both scopes",
    async (feedback) => {
      rows.set(`user-1|${HOUSE}`, feedback);

      const bill = await request(HOUSE);
      expect(bill.statusCode).toBe(200);
      expect(bill.body).toEqual(served(statsPayload({ billId: HOUSE })));
      expect((await request(HOUSE, "bill")).body).toEqual(bill.body);

      const companions = await request(HOUSE, "companions");
      expect(companions.statusCode).toBe(200);
      expect(companions.body).toEqual({
        ...served(statsPayload({ billId: GROUP_KEY, totals: bucket(27, 13), generatedAt: "2026-10-01T00:00:00.000Z" })),
        billId: HOUSE,
        companionBillIds: [HOUSE, SENATE],
      });
      expect(lockedMetricLines()).toEqual([]);
    },
  );

  it.each([[""], ["Skip"], ["Clear"], ["yea"], [null]])("a row whose feedback is %p stays locked", async (feedback) => {
    rows.set(`user-1|${HOUSE}`, feedback);

    const { statusCode, body } = await request(HOUSE);

    expect(statusCode).toBe(403);
    expect(body).toEqual(LOCKED);
    expect(statsReads()).toHaveLength(0);
  });

  // setFeedback marks the Abstain 1.0 and 1.1 write when the user dismisses a Passed or Failed bill in Updates.
  it.each([
    [HOUSE, undefined],
    [HOUSE, "companions"],
    [SENATE, "companions"],
  ])("an Abstain stored as a 1.0 or 1.1 dismissal keeps %s scope=%s locked", async (billId, scope) => {
    rows.set(`user-1|${HOUSE}`, "Abstain");
    dismissals.add(`user-1|${HOUSE}`);

    const { statusCode, body } = await request(billId, scope);

    expect(statusCode).toBe(403);
    expect(body).toEqual(LOCKED);
    expect(statsReads()).toHaveLength(0);
    expect(indexQueries()).toHaveLength(0);
    expect(lockedMetricLines()).toHaveLength(1);
  });

  it("a dismissal on one member does not hide a real vote on the other: Results unlock", async () => {
    rows.set(`user-1|${HOUSE}`, "Abstain");
    dismissals.add(`user-1|${HOUSE}`);
    rows.set(`user-1|${SENATE}`, "Abstain");

    expect((await request(HOUSE)).statusCode).toBe(200);
    expect((await request(SENATE, "companions")).statusCode).toBe(200);
  });

  it("a vote on the other member of a companion pair unlocks both members and both scopes; a vote elsewhere does not", async () => {
    // The vote is on the Senate bill; the group (and its combined stats) is keyed by the House primary.
    rows.set(`user-1|${SENATE}`, "Nay");

    const houseCompanions = await request(HOUSE, "companions");
    expect(houseCompanions.statusCode).toBe(200);
    expect(houseCompanions.body).toMatchObject({
      billId: HOUSE,
      companionBillIds: [HOUSE, SENATE],
      totals: { yea: 27 },
    });
    expect((await request(HOUSE)).body).toEqual(served(statsPayload({ billId: HOUSE })));
    expect((await request(SENATE, "companions")).body).toMatchObject({
      billId: SENATE,
      companionBillIds: [HOUSE, SENATE],
    });
    expect((await request(SENATE)).body).toEqual(served(stored[SENATE] as Stats));
    // Both members are read in one request; the plain guid equals the requested id, so it is read once.
    expect(keysRead()[0]).toEqual([HOUSE, SENATE]);

    rows.clear();
    rows.set(`user-2|${UNRELATED}`, "Yea");
    expect((await request(HOUSE, undefined, "user-2")).statusCode).toBe(403);
    expect((await request(HOUSE, "companions", "user-2")).statusCode).toBe(403);
  });

  it.each(["fail", "off"] as const)(
    "when the companion groups are %s, only a vote on the bill itself unlocks",
    async (state) => {
      groups = state;
      loadHandler();
      rows.set(`user-1|${SENATE}`, "Yea");

      expect((await request(HOUSE)).body).toEqual(LOCKED);
      expect((await request(HOUSE, "companions")).body).toEqual(LOCKED);
      expect(keysRead()).toEqual([[HOUSE], [HOUSE]]);
      expect(statsReads()).toHaveLength(0);

      // A vote on the bill itself still unlocks; without the group, that is the bill's own stats.
      rows.set(`user-1|${HOUSE}`, "Abstain");
      const own = await request(HOUSE, "companions");
      expect(own.statusCode).toBe(200);
      expect(own.body).toEqual(served(statsPayload({ billId: HOUSE })));
    },
  );

  it.each([GROUP_KEY, "BILL-1", "not a bill", "BILLS-119xx1"])(
    "answers billId %s with 400 INVALID_BILL_ID before reading anything",
    async (billId) => {
      rows.set(`user-1|${HOUSE}`, "Yea");

      for (const scope of [undefined, "companions"]) {
        const { statusCode, body } = await request(billId, scope);
        expect(statusCode).toBe(400);
        expect(body).toEqual({ error: "INVALID_BILL_ID" });
      }
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("unlocks a suffixed billId on the plain-guid row, and a legacy row stored under the suffixed id", async () => {
    rows.set(`user-1|${HOUSE}`, "Yea");
    const suffixed = await request(`${HOUSE}ih`);
    expect(suffixed.statusCode).toBe(200);
    expect(keysRead()[0]).toEqual([HOUSE, SENATE, `${HOUSE}ih`]);

    rows.clear();
    rows.set(`user-1|${UNGROUPED}ih`, "Nay");
    const legacy = await request(`${UNGROUPED}ih`);
    expect(legacy.statusCode).toBe(200);
    expect(legacy.body).toEqual(served(stored[`${UNGROUPED}ih`] as Stats));
    expect(keysRead()[1]).toEqual([UNGROUPED, `${UNGROUPED}ih`]);
  });

  it("reads only the caller's own rows, strongly consistent, and ignores a userId query parameter", async () => {
    rows.set(`user-2|${HOUSE}`, "Yea");

    const { statusCode } = await request(HOUSE, undefined, "user-1", { userId: "user-2" });

    expect(statusCode).toBe(403);
    const [read] = feedbackReads();
    // The key, votedAt and adultEligible are for S1 (forceRefresh): when the caller's own vote was stored and
    // whether it counts. Still the caller's own rows only.
    expect(read.RequestItems!.UserFeedback).toMatchObject({
      ConsistentRead: true,
      ProjectionExpression: "#feedback, #legacyDismiss, #billId, #votedAt, #adultEligible",
      ExpressionAttributeNames: {
        "#feedback": "feedback",
        "#legacyDismiss": "legacyDismiss",
        "#billId": "billId",
        "#votedAt": "votedAt",
        "#adultEligible": "adultEligible",
      },
    });
    expect(read.RequestItems!.UserFeedback.Keys!.map((key) => key.userId)).toEqual([{ S: "user-1" }, { S: "user-1" }]);
  });

  it("retries unprocessed keys and unlocks on a later answer", async () => {
    rows.set(`user-1|${HOUSE}`, "Yea");
    unprocessedReads = 2;

    const { statusCode } = await request(HOUSE);

    expect(statusCode).toBe(200);
    expect(feedbackReads()).toHaveLength(3);
  });

  it("fails closed with 500 when keys stay unprocessed, the read fails or the table is not configured", async () => {
    const internalError = { error: "Internal server error" };
    rows.set(`user-1|${HOUSE}`, "Yea");

    unprocessedReads = Number.POSITIVE_INFINITY;
    expect(await request(HOUSE)).toMatchObject({ statusCode: 500, body: internalError });
    expect(feedbackReads()).toHaveLength(4);

    unprocessedReads = 0;
    const route = send.getMockImplementation()!;
    send.mockImplementation(async (command: FakeCommand) => {
      if (command.input?.RequestItems) throw Object.assign(new Error("unavailable"), { name: "InternalServerError" });
      return route(command);
    });
    expect(await request(HOUSE, "companions")).toMatchObject({ statusCode: 500, body: internalError });

    const restoreTable = applyTestEnv({ FEEDBACK_TABLE_NAME: undefined });
    try {
      loadHandler();
      expect(await request(HOUSE)).toMatchObject({ statusCode: 500, body: internalError });
      expect(feedbackReads()).toHaveLength(0);
    } finally {
      restoreTable();
    }
    expect(statsReads()).toHaveLength(0);
    expect(indexQueries()).toHaveLength(0);

    // Each one is counted (an answer, not a thrown error, so the function's Errors alarm never sees it), without
    // the user id, and none of them as ResultsLocked.
    const failed = logLines.filter((line) => line.includes('"ResultsGateReadFailed"'));
    expect(failed).toHaveLength(3);
    for (const line of failed) {
      expect(JSON.parse(line)).toMatchObject({
        ResultsGateReadFailed: 1,
        _aws: {
          CloudWatchMetrics: [{ Namespace: "BillBoard/BillStats", Metrics: [{ Name: "ResultsGateReadFailed" }] }],
        },
      });
      expect(line).not.toContain("user-1");
    }
    expect(lockedMetricLines()).toEqual([]);
  });

  it("answers a failure after the gate with 500 and no ResultsGateReadFailed: that metric is the gate's read alone", async () => {
    rows.set(`user-1|${HOUSE}`, "Yea");
    const errors = jest.mocked(console.error);
    // Loaded by loadHandler after its resetModules, so this is the module the handler calls.
    jest.spyOn(require("../shared/billStats"), "toServedStats").mockImplementation(() => {
      throw new TypeError("cannot serve this stats document");
    });

    expect(await request(HOUSE)).toMatchObject({ statusCode: 500, body: { error: "Internal server error" } });

    expect(feedbackReads()).toHaveLength(1);
    expect(statsReads()).toHaveLength(1);
    expect(errors.mock.calls.map(([message]) => message)).toEqual(["fetchBillStats failed"]);
    expect(logLines.filter((line) => line.includes('"ResultsGateReadFailed"'))).toEqual([]);
    expect(lockedMetricLines()).toEqual([]);
  });

  it("keeps the shapes 1.0 and 1.1 decode: the strict 200 body when unlocked, an error body they already handle when locked", async () => {
    const locked = await request(HOUSE);
    expect(locked.statusCode).toBe(403);
    expect(Object.keys(locked.body).sort()).toEqual(["error", "message"]);

    rows.set(`user-1|${HOUSE}`, "Yea");
    const unlocked = await request(HOUSE);
    expect(unlocked.statusCode).toBe(200);
    expect(Object.keys(unlocked.body).sort()).toEqual([
      "billId",
      "comparison",
      "generatedAt",
      "reasonBreakdown",
      "rollups",
      "segments",
      "totals",
    ]);
    expect(Object.keys(unlocked.body.totals).sort()).toEqual(Object.keys(bucket(0, 0)).sort());
    expect(Object.keys((await request(HOUSE, "companions")).body).sort()).toEqual([
      "billId",
      "companionBillIds",
      "comparison",
      "generatedAt",
      "reasonBreakdown",
      "rollups",
      "segments",
      "totals",
    ]);
  });
});

describe("fetchBillStats forceRefresh right after a vote (S1)", () => {
  const BILL = "BILLS-119hr500";
  const VOTED_AT_MS = Date.parse("2026-10-28T12:00:00.000Z");
  const HOUR_MS = 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  // Pages of the bill-id index in this mock (a real page is 1 MB).
  const PAGE_ROWS = 4_000;
  type VoteOptions = {
    /** null stores a row without votedAt. */
    votedAt?: string | null;
    verified?: boolean;
    state?: string;
    district?: string;
    adultEligible?: boolean;
    legacyDismiss?: boolean;
    /** false: in the table but not yet in the eventually consistent bill-id index. */
    indexed?: boolean;
  };
  let send: DynamoSend;
  let fetchStats: (event: unknown) => Promise<{ statusCode: number; body: string }>;
  /** "userId|billId" -> the UserFeedback row. */
  let table: Map<string, Row>;
  /** Row keys the bill-id index does not show yet. */
  let notIndexed: Set<string>;
  /** billId -> rows of other users the index holds besides `table` (large bills). */
  let bulk: Record<string, Row[]>;
  /** billId -> the BillStats row. */
  let stored: Record<string, { payload: unknown; computedFrom?: string }>;
  let indexFails: boolean;
  let logLines: string[];
  let warnLines: string[];
  let restore: () => void;

  const castVote = (userId: string, billId: string, feedback: string, options: VoteOptions = {}) => {
    const key = `${userId}|${billId}`;
    table.set(key, {
      userId: { S: userId },
      billId: { S: billId },
      feedback: { S: feedback },
      ...(options.votedAt === null ? {} : { votedAt: { S: options.votedAt ?? iso(VOTED_AT_MS - HOUR_MS) } }),
      constituentVerified: { BOOL: options.verified ?? false },
      adultEligible: { BOOL: options.adultEligible ?? true },
      ...(options.state ? { resolvedState: { S: options.state } } : {}),
      ...(options.district ? { resolvedDistrict: { S: options.district } } : {}),
      ...(options.legacyDismiss ? { legacyDismiss: { BOOL: true } } : {}),
    });
    if (options.indexed === false) notIndexed.add(key);
    else notIndexed.delete(key);
  };
  const indexRows = (billId: string) => [
    ...[...table.entries()]
      .filter(([key, row]) => row.billId.S === billId && !notIndexed.has(key))
      .map(([, row]) => row),
    ...(bulk[billId] ?? []),
  ];

  beforeEach(() => {
    jest.resetModules();
    restore = applyTestEnv({
      MANIFEST_TABLE_NAME: undefined,
      FEEDBACK_TABLE_NAME: "UserFeedback",
      FEEDBACK_PARTITION_KEY: "userId",
      FEEDBACK_SORT_KEY: "billId",
      FEEDBACK_BILL_ID_INDEX_NAME: "GSIBillIdIndex",
    });
    table = new Map();
    notIndexed = new Set();
    bulk = {};
    stored = {};
    indexFails = false;
    logLines = [];
    warnLines = [];
    jest.spyOn(console, "log").mockImplementation((line?: unknown) => void logLines.push(String(line)));
    jest.spyOn(console, "warn").mockImplementation((line?: unknown) => void warnLines.push(String(line)));
    jest.useFakeTimers({ now: VOTED_AT_MS + 300 });
    ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
    send.mockReset();
    send.mockImplementation(async (command: FakeCommand) => {
      const input: DynamoInput = command.input ?? {};
      if (input.RequestItems?.UserFeedback) {
        // As the projection returns them: the gate's attributes, the key and the S1 ones.
        const projected = ["feedback", "legacyDismiss", "billId", "votedAt", "adultEligible"];
        const items = (input.RequestItems.UserFeedback.Keys as { userId: { S: string }; billId: { S: string } }[])
          .map((key) => table.get(`${key.userId.S}|${key.billId.S}`))
          .filter((row): row is Row => Boolean(row))
          .map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => projected.includes(name))));
        return { Responses: { UserFeedback: items } };
      }
      if (input.TableName === "BillStats" && input.Key) {
        const row = stored[input.Key.billId.S!];
        return row
          ? {
              Item: {
                schemaVersion: { S: "4" },
                payload: { S: JSON.stringify(row.payload) },
                ...(row.computedFrom ? { computedFrom: { S: row.computedFrom } } : {}),
              },
            }
          : {};
      }
      if (input.IndexName === "GSIBillIdIndex") {
        if (indexFails) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        const rows = indexRows(input.ExpressionAttributeValues![":billId"].S!);
        const offset = Number(input.ExclusiveStartKey?.offset?.N ?? "0");
        const end = offset + PAGE_ROWS;
        return {
          Items: rows.slice(offset, end),
          ...(end < rows.length ? { LastEvaluatedKey: { offset: { N: String(end) } } } : {}),
        };
      }
      throw new Error(`Unexpected call: ${JSON.stringify(input)}`);
    });
    fetchStats = require("../handlers/fetchBillStats").handler;
  });

  afterEach(() => {
    restore();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const request = async (sub = "user-1", query: Record<string, string> = { forceRefresh: "true" }, billId = BILL) => {
    const response = await fetchStats({
      requestContext: { authorizer: { jwt: { claims: { sub } } } },
      queryStringParameters: { billId, ...query },
    });
    return { statusCode: response.statusCode, body: JSON.parse(response.body) };
  };
  const at = (ms: number) => jest.setSystemTime(new Date(ms));
  const indexQueries = () => send.mock.calls.filter(([command]) => command.input?.IndexName);
  const statsReads = () => send.mock.calls.filter(([command]) => command.input?.TableName === "BillStats");
  const writes = () => send.mock.calls.filter(([command]) => command.input?.Item || command.input?.UpdateExpression);
  const foldMetricLines = () => logLines.filter((line) => line.includes('"FreshStatsFold"'));
  /** A document billStatsAggregator stored, whose computation started at computedFromMs. */
  const storeStats = (payload: Record<string, unknown>, computedFromMs?: number) => {
    stored[BILL] = {
      payload: statsPayload({ billId: BILL, ...payload }),
      ...(computedFromMs === undefined ? {} : { computedFrom: iso(computedFromMs) }),
    };
  };
  // As the aggregator stores one self-attested Nay: both segments empty under the verified floor.
  const nayOnly = {
    totals: bucket(0, 1),
    segments: { verified: emptyBucket, selfAttested: emptyBucket },
    rollups: { byState: {}, byDistrict: {} },
  };

  it("shows the first voter on a bill their own vote, folded from the bill-id index without writing", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });

    // Before S1, and still without forceRefresh: no stored document yet, so "No Yea or Nay votes yet".
    const plain = await request("user-1", {});
    expect(plain.body.totals).toMatchObject({ votes: 0, yea: 0, nay: 0 });
    expect(indexQueries()).toHaveLength(0);

    const { statusCode, body } = await request();

    expect(statusCode).toBe(200);
    expect(body.totals).toMatchObject({ votes: 1, yea: 1, nay: 0, abstain: 0, decisionVotes: 1, yeaPct: 100 });
    expect(body.totals).toMatchObject({ weightedVotes: 1, weightedYea: 1, weightedYeaPct: 100 });
    expect(body.comparison).toEqual({
      allUsers: { votes: 1, yea: 1, nay: 0, abstain: 0, decisionVotes: 1, yeaPct: 100 },
      verifiedWithheld: true,
      minDecisionVotes: 5,
    });
    // The shape 1.0, 1.1 and 1.2 decode, unchanged.
    expect(Object.keys(body).sort()).toEqual(Object.keys(plain.body).sort());
    expect(Object.keys(body.totals).sort()).toEqual(Object.keys(bucket(0, 0)).sort());

    const [query] = indexQueries().map(([command]) => command.input);
    expect(query).toMatchObject({
      TableName: "UserFeedback",
      IndexName: "GSIBillIdIndex",
      ExpressionAttributeNames: { "#billId": "billId", "#userId": "userId", "#votedAt": "votedAt" },
      ExpressionAttributeValues: { ":billId": { S: BILL } },
      ProjectionExpression:
        "feedback, constituentVerified, resolvedState, resolvedDistrict, reasons, adultEligible, legacyDismiss, #userId, #votedAt",
    });
    expect(writes()).toHaveLength(0);
    const [metric] = foldMetricLines();
    expect(JSON.parse(metric)).toMatchObject({
      FreshStatsFold: 1,
      _aws: { CloudWatchMetrics: [{ Namespace: "BillBoard/BillStats", Metrics: [{ Name: "FreshStatsFold" }] }] },
    });
    expect(metric).not.toContain("user-1");
  });

  it("shows a Yea voter after one earlier Nay both votes, not 0% Yea", async () => {
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS - 60_000) });
    storeStats(nayOnly, VOTED_AT_MS - 50_000);
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });

    expect((await request("user-1", {})).body.totals).toMatchObject({ yea: 0, nay: 1, yeaPct: 0 });

    const { body } = await request();

    expect(body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1, decisionVotes: 2, yeaPct: 50 });
    expect(body.comparison.allUsers).toEqual({ votes: 2, yea: 1, nay: 1, abstain: 0, decisionVotes: 2, yeaPct: 50 });
    expect(indexQueries()).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it("answers a locked caller 403 RESULTS_LOCKED before reading anything, with forceRefresh too", async () => {
    castVote("user-2", BILL, "Nay");
    castVote("user-3", BILL, "Abstain", { votedAt: iso(VOTED_AT_MS), legacyDismiss: true });

    for (const sub of ["user-1", "user-3"]) {
      const { statusCode, body } = await request(sub);
      expect(statusCode).toBe(403);
      expect(body).toEqual({ error: "RESULTS_LOCKED", message: "Vote or abstain on this bill to see its results." });
    }
    expect(statsReads()).toHaveLength(0);
    expect(indexQueries()).toHaveLength(0);
    expect(foldMetricLines()).toEqual([]);
  });

  it("serves the stored document of a bill above 5,000 votes, and folds one at 5,000", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    storeStats({ totals: bucket(4_000, 1_001) }, VOTED_AT_MS - 20_000);

    const above = await request();
    expect(above.body.totals).toMatchObject({ votes: 5_001, yea: 4_000 });
    expect(indexQueries()).toHaveLength(0);

    storeStats({ totals: bucket(4_000, 1_000) }, VOTED_AT_MS - 20_000);
    const atCap = await request();
    expect(indexQueries()).toHaveLength(1);
    // The mock index holds only user-1's row: what it serves is the fold, not the stored 5,000.
    expect(atCap.body.totals).toMatchObject({ votes: 1, yea: 1 });
  });

  it("stops a fold past 10,000 rows of a bill with no stored document, and serves empty stats", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    bulk[BILL] = Array.from({ length: 12_000 }, (_, i) => ({
      userId: { S: `u${i}` },
      billId: { S: BILL },
      feedback: { S: "Nay" },
      votedAt: { S: iso(VOTED_AT_MS - HOUR_MS) },
      constituentVerified: { BOOL: false },
      adultEligible: { BOOL: true },
    }));

    const { statusCode, body } = await request();

    expect(statusCode).toBe(200);
    expect(body.totals).toMatchObject({ votes: 0 });
    // 12,001 rows in pages of 4,000: the third page takes it past 10,000, so the fourth is never read.
    expect(indexQueries()).toHaveLength(3);
    expect(warnLines.some((line) => line.includes("more vote rows than a fresh fold reads"))).toBe(true);
  });

  it("serves one fold for 60 s to every caller whose vote it holds, and folds again for a later vote", async () => {
    castVote("user-3", BILL, "Nay", { votedAt: iso(VOTED_AT_MS - 5_000) });
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });

    expect((await request()).body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(1);

    // The app's second request, 4 s later, and an earlier voter's request: the same fold.
    at(VOTED_AT_MS + 4_300);
    expect((await request()).body.totals).toMatchObject({ votes: 2 });
    expect((await request("user-3")).body.totals).toMatchObject({ votes: 2 });
    expect(indexQueries()).toHaveLength(1);

    // A vote stored after that fold started is not in it: folded again.
    castVote("user-4", BILL, "Yea", { votedAt: iso(VOTED_AT_MS + 10_000) });
    at(VOTED_AT_MS + 10_300);
    expect((await request("user-4")).body.totals).toMatchObject({ votes: 3, yea: 2, nay: 1 });
    expect(indexQueries()).toHaveLength(2);

    // That fold serves user-1 too until it is 60 s old.
    at(VOTED_AT_MS + 70_299);
    expect((await request()).body.totals).toMatchObject({ votes: 3 });
    expect(indexQueries()).toHaveLength(2);
    at(VOTED_AT_MS + 70_300);
    await request();
    expect(indexQueries()).toHaveLength(3);
    expect(writes()).toHaveLength(0);
    expect(foldMetricLines()).toHaveLength(3);
  });

  it("redoes a fold that ran before the vote reached the index, at most once every 2 s per bill", async () => {
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS - 60_000) });
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS), indexed: false });

    // The index has not caught up: the fold misses the vote, and is still the newest stats there are.
    expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 0, nay: 1 });
    expect(indexQueries()).toHaveLength(1);

    // A client asking again and again within 2 s gets that fold, with no new query.
    for (const ms of [500, 900, 1_500, 2_299]) {
      at(VOTED_AT_MS + ms);
      await request();
    }
    expect(indexQueries()).toHaveLength(1);

    // The app's 4 s request folds again, now with the vote; after that, no more queries.
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    at(VOTED_AT_MS + 4_300);
    expect((await request()).body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    for (const ms of [4_400, 8_000, 30_000]) {
      at(VOTED_AT_MS + ms);
      expect((await request()).body.totals).toMatchObject({ votes: 2, yea: 1 });
    }
    expect(indexQueries()).toHaveLength(2);
  });

  it("does not count a fold that missed the caller's row as holding their vote, however late it read", async () => {
    // The app's first request comes late (a slow network), and the index lags more than the 1 s margin.
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS), indexed: false });
    at(VOTED_AT_MS + 1_500);
    expect((await request()).body.totals).toMatchObject({ votes: 0 });

    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    at(VOTED_AT_MS + 5_500);
    expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 1 });
    expect(indexQueries()).toHaveLength(2);
  });

  it("applies the state and district floors and the segment suppression exactly as the stored document", async () => {
    const { computeBillStats } = require("../shared/billStats");
    // CA: 5 verified votes, 4 of them in CA-12; WY: 1 verified vote; 1 self-attested vote.
    for (let i = 0; i < 4; i += 1) castVote(`ca12-${i}`, BILL, "Yea", { verified: true, state: "ca", district: "12" });
    castVote("ca13", BILL, "Nay", { verified: true, state: "CA", district: "13" });
    castVote("wy", BILL, "Nay", { verified: true, state: "WY", district: "AL" });
    castVote("self", BILL, "Yea");
    // The caller, verified in CA-12: CA-12 now clears 5, but CA minus CA-12 would show CA-13's one vote.
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS), verified: true, state: "CA", district: "12" });

    const { body } = await request();

    expect(body.totals).toMatchObject({ votes: 8, yea: 6, nay: 2 });
    expect(Object.keys(body.rollups.byState)).toEqual(["CA"]);
    expect(body.rollups.byState.CA.totals).toMatchObject({ yea: 5, nay: 1 });
    expect(body.rollups.byDistrict).toEqual({});
    // Verified 7 minus the 6 shown in CA would reveal WY's one vote: both segments go out empty.
    expect(body.segments).toEqual({ verified: emptyBucket, selfAttested: emptyBucket });
    expect(body.comparison.verifiedWithheld).toBe(true);
    expect(body.comparison).not.toHaveProperty("verified");

    // The same body the aggregator's computation gives for these votes.
    const aggregated = await computeBillStats({
      db: { send: async () => ({ Items: indexRows(BILL) }) },
      tableName: "UserFeedback",
      partitionKey: "userId",
      sortKey: "billId",
      billIdIndexName: "GSIBillIdIndex",
      billId: BILL,
    });
    const { toServedStats } = require("../shared/billStats");
    expect(body).toEqual(JSON.parse(JSON.stringify(toServedStats(aggregated))));
  });

  it("serves the stored document when its read started at least 1 s after the caller's vote", async () => {
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS - 60_000) });
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    at(VOTED_AT_MS + 31_000);

    // Stored by the aggregator 30 s after the vote: it holds the vote, so no fold.
    storeStats({ ...nayOnly, totals: bucket(1, 1) }, VOTED_AT_MS + 30_000);
    expect((await request()).body.totals).toMatchObject({ yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(0);

    // A document without computedFrom is judged by its generatedAt.
    storeStats({ ...nayOnly, totals: bucket(1, 1), generatedAt: iso(VOTED_AT_MS + 1_000) });
    expect((await request()).body.totals).toMatchObject({ yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(0);

    // One whose read began within 1 s of the vote may have missed it in the index: folded.
    storeStats(nayOnly, VOTED_AT_MS + 500);
    expect((await request()).body.totals).toMatchObject({ yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(1);
  });

  it("serves a stored document newer than this container's fold", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    await request();
    expect(indexQueries()).toHaveLength(1);

    // A later voter whose vote the fold misses, within 2 s of it, while the aggregator has just stored
    // a newer document (read 400 ms after their vote): the newer of the two.
    castVote("user-5", BILL, "Nay", { votedAt: iso(VOTED_AT_MS + 600) });
    storeStats({ ...nayOnly, totals: bucket(1, 1) }, VOTED_AT_MS + 1_000);
    at(VOTED_AT_MS + 1_200);
    expect((await request("user-5")).body.totals).toMatchObject({ yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(1);
  });

  const FORCE = { forceRefresh: "true" };
  const noFoldCases: [string, () => void, Record<string, string>, string][] = [
    ["without forceRefresh", () => castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) }), {}, BILL],
    [
      "with forceRefresh=false",
      () => castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) }),
      { forceRefresh: "false" },
      BILL,
    ],
    [
      "for a row that is not adult-eligible",
      () => castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS), adultEligible: false }),
      FORCE,
      BILL,
    ],
    ["for a row without votedAt", () => castVote("user-1", BILL, "Yea", { votedAt: null }), FORCE, BILL],
    [
      "for a vote stored under the plain guid of a suffixed request",
      () => castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) }),
      FORCE,
      `${BILL}ih`,
    ],
  ];
  it.each(noFoldCases)("serves the stored stats with no fold %s", async (_label, vote, query, billId) => {
    vote();
    stored[billId] = { payload: statsPayload({ billId, ...nayOnly }), computedFrom: iso(VOTED_AT_MS - 50_000) };

    const { statusCode, body } = await request("user-1", query, billId);

    expect(statusCode).toBe(200);
    expect(body).toEqual(served(statsPayload({ billId, ...nayOnly })));
    expect(indexQueries()).toHaveLength(0);
  });

  it("answers scope=companions on an ungrouped bill like scope=bill", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });

    const { body } = await request("user-1", { forceRefresh: "TRUE", scope: "companions" });

    expect(body).not.toHaveProperty("companionBillIds");
    expect(body.totals).toMatchObject({ votes: 1, yea: 1 });
  });

  it("serves the stored stats when the fold fails, and tries again no sooner than 2 s later", async () => {
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS - 60_000) });
    storeStats(nayOnly, VOTED_AT_MS - 50_000);
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    indexFails = true;

    const failed = await request();
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toEqual(served(statsPayload({ billId: BILL, ...nayOnly })));
    expect(warnLines.some((line) => line.includes("Could not fold the bill's votes"))).toBe(true);

    at(VOTED_AT_MS + 1_000);
    await request();
    expect(indexQueries()).toHaveLength(1);

    indexFails = false;
    at(VOTED_AT_MS + 4_300);
    expect((await request()).body.totals).toMatchObject({ yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(2);
    expect(foldMetricLines()).toHaveLength(2);
  });

  it("does not serve a fold to an earlier voter whose row the index had not shown yet", async () => {
    // user-2 votes Nay first, but the index shows user-1's later Yea before it (rows propagate unordered).
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS), indexed: false });
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS + 400) });
    at(VOTED_AT_MS + 600);
    expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 1, nay: 0 });

    // Seeing user-1's row says nothing about user-2's: user-2's request folds again.
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS) });
    at(VOTED_AT_MS + 4_000);
    expect((await request("user-2")).body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(2);
  });

  it("serves a fold to another recent voter whose row it read, without folding again", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS + 200) });
    expect((await request()).body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });

    for (const ms of [600, 4_200]) {
      at(VOTED_AT_MS + ms);
      expect((await request("user-2")).body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    }
    expect(indexQueries()).toHaveLength(1);
  });

  it("keeps the last good fold when a later one fails, so its voters keep their vote", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 1 });

    // user-2's vote needs a new fold, which fails: user-2 gets the newest fold there is.
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS + 2_500) });
    indexFails = true;
    at(VOTED_AT_MS + 2_800);
    expect((await request("user-2")).body.totals).toMatchObject({ votes: 1, yea: 1 });
    expect(indexQueries()).toHaveLength(2);

    // user-1's 4 s request still gets the fold that holds their vote, without a query.
    at(VOTED_AT_MS + 4_300);
    expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 1 });
    expect(indexQueries()).toHaveLength(2);

    // user-2's 4 s request folds again once the failed attempt is 2 s old.
    indexFails = false;
    at(VOTED_AT_MS + 6_800);
    expect((await request("user-2")).body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(3);
  });

  it("does not fold for a vote 2 minutes old or more, with or without a stored document", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS - 90 * 24 * HOUR_MS) });
    castVote("user-2", BILL, "Nay", { votedAt: iso(VOTED_AT_MS) });

    // "Try again" in 1.2 sends forceRefresh=true at any time: no fold, and empty stats with no document.
    for (let i = 0; i < 10; i += 1) {
      at(VOTED_AT_MS + 300 + i * 2_000);
      expect((await request()).body.totals).toMatchObject({ votes: 0 });
    }
    expect(indexQueries()).toHaveLength(0);

    // A vote 2 minutes old is past the window too, even under a stored document older than it (the
    // aggregator never stored the vote); one just inside the window folds.
    storeStats(nayOnly, VOTED_AT_MS - 50_000);
    at(VOTED_AT_MS + 120_000);
    expect((await request("user-2")).body.totals).toMatchObject({ votes: 1, yea: 0, nay: 1 });
    expect(indexQueries()).toHaveLength(0);
    at(VOTED_AT_MS + 119_999);
    expect((await request("user-2")).body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    expect(indexQueries()).toHaveLength(1);
  });

  it("does not fold a bill again for 60 s after it stopped past 10,000 rows", async () => {
    castVote("user-1", BILL, "Yea", { votedAt: iso(VOTED_AT_MS) });
    bulk[BILL] = Array.from({ length: 12_000 }, (_, i) => ({
      userId: { S: `u${i}` },
      billId: { S: BILL },
      feedback: { S: "Nay" },
      votedAt: { S: iso(VOTED_AT_MS - HOUR_MS) },
      constituentVerified: { BOOL: false },
      adultEligible: { BOOL: true },
    }));

    for (let ms = 300; ms < 60_300; ms += 2_000) {
      at(VOTED_AT_MS + ms);
      expect((await request()).body.totals).toMatchObject({ votes: 0 });
    }
    expect(foldMetricLines()).toHaveLength(1);
    expect(indexQueries()).toHaveLength(3);

    at(VOTED_AT_MS + 60_300);
    await request();
    expect(foldMetricLines()).toHaveLength(2);
  });
});

describe("fetchBillStats forceRefresh right after a vote on a companion group (REL-48)", () => {
  // Both apps ask for a grouped bill's Results under its primary, with scope=companions, and send
  // forceRefresh=true about 0 s and 4 s after a saved vote (1.1 and 1.2 BillDetail statsBillGuid and
  // refreshStatsAfterVoteSaved). Their vote goes to the member that holds their row, else the primary.
  const HOUSE = "BILLS-119hr1285";
  const SENATE = "BILLS-119s570";
  const GROUP_KEY = `COMPANIONS#${HOUSE}#${SENATE}`;
  const VOTED_AT_MS = Date.parse("2026-10-29T12:00:00.000Z");
  const HOUR_MS = 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const PAGE_ROWS = 4_000;
  type VoteOptions = {
    votedAt?: string;
    verified?: boolean;
    state?: string;
    district?: string;
    adultEligible?: boolean;
    legacyDismiss?: boolean;
    indexed?: boolean;
  };
  let send: DynamoSend;
  let fetchStats: (event: unknown) => Promise<{ statusCode: number; body: string }>;
  let table: Map<string, Row>;
  let notIndexed: Set<string>;
  let bulk: Record<string, Row[]>;
  let stored: Record<string, { payload: unknown; computedFrom?: string }>;
  /** Bill ids the gate's BatchGetItem leaves unprocessed. */
  let unprocessed: Set<string>;
  let indexFails: boolean;
  let logLines: string[];
  let warnLines: string[];
  let restore: () => void;

  const row = (userId: string, billId: string, feedback: string, options: VoteOptions = {}) => ({
    userId: { S: userId },
    billId: { S: billId },
    feedback: { S: feedback },
    votedAt: { S: options.votedAt ?? iso(VOTED_AT_MS - HOUR_MS) },
    constituentVerified: { BOOL: options.verified ?? false },
    adultEligible: { BOOL: options.adultEligible ?? true },
    ...(options.state ? { resolvedState: { S: options.state } } : {}),
    ...(options.district ? { resolvedDistrict: { S: options.district } } : {}),
    ...(options.legacyDismiss ? { legacyDismiss: { BOOL: true } } : {}),
  });
  const castVote = (userId: string, billId: string, feedback: string, options: VoteOptions = {}) => {
    const key = `${userId}|${billId}`;
    table.set(key, row(userId, billId, feedback, options));
    if (options.indexed === false) notIndexed.add(key);
    else notIndexed.delete(key);
  };
  const dismiss = (userId: string, billId: string, options: VoteOptions = {}) =>
    castVote(userId, billId, "Abstain", { ...options, legacyDismiss: true });
  const indexRows = (billId: string) => [
    ...[...table.entries()]
      .filter(([key, item]) => item.billId.S === billId && !notIndexed.has(key))
      .map(([, item]) => item),
    ...(bulk[billId] ?? []),
  ];

  beforeEach(() => {
    jest.resetModules();
    restore = applyTestEnv({
      MANIFEST_TABLE_NAME: "BillsManifest",
      MANIFEST_PRIMARY_KEY: "pk",
      FEEDBACK_TABLE_NAME: "UserFeedback",
      FEEDBACK_PARTITION_KEY: "userId",
      FEEDBACK_SORT_KEY: "billId",
      FEEDBACK_BILL_ID_INDEX_NAME: "GSIBillIdIndex",
    });
    table = new Map();
    notIndexed = new Set();
    bulk = {};
    stored = {};
    unprocessed = new Set();
    indexFails = false;
    logLines = [];
    warnLines = [];
    jest.spyOn(console, "log").mockImplementation((line?: unknown) => void logLines.push(String(line)));
    jest.spyOn(console, "warn").mockImplementation((line?: unknown) => void warnLines.push(String(line)));
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.useFakeTimers({ now: VOTED_AT_MS + 300 });
    ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
    send.mockReset();
    send.mockImplementation(async (command: FakeCommand) => {
      const input: DynamoInput = command.input ?? {};
      if (input.RequestItems?.UserFeedback) {
        const projected = ["feedback", "legacyDismiss", "billId", "votedAt", "adultEligible"];
        const keys = input.RequestItems.UserFeedback.Keys as { userId: { S: string }; billId: { S: string } }[];
        const left = keys.filter((key) => unprocessed.has(key.billId.S));
        const items = keys
          .filter((key) => !unprocessed.has(key.billId.S))
          .map((key) => table.get(`${key.userId.S}|${key.billId.S}`))
          .filter((item): item is Row => Boolean(item))
          .map((item) => Object.fromEntries(Object.entries(item).filter(([name]) => projected.includes(name))));
        return {
          Responses: { UserFeedback: items },
          ...(left.length > 0 ? { UnprocessedKeys: { UserFeedback: { Keys: left } } } : {}),
        };
      }
      if (input.Key?.pk?.S === "BILL_COMPANION_GROUPS") {
        return {
          Item: {
            pk: { S: "BILL_COMPANION_GROUPS" },
            sk: { S: "CURRENT" },
            pairsVersion: { N: "1" },
            enabled: { BOOL: true },
            pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
          },
        };
      }
      if (input.TableName === "BillStats" && input.Key) {
        const item = stored[input.Key.billId.S!];
        return item
          ? {
              Item: {
                schemaVersion: { S: "4" },
                payload: { S: JSON.stringify(item.payload) },
                ...(item.computedFrom ? { computedFrom: { S: item.computedFrom } } : {}),
              },
            }
          : {};
      }
      if (input.IndexName === "GSIBillIdIndex") {
        if (indexFails) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        const rows = indexRows(input.ExpressionAttributeValues![":billId"].S!);
        const offset = Number(input.ExclusiveStartKey?.offset?.N ?? "0");
        const end = offset + PAGE_ROWS;
        return {
          Items: rows.slice(offset, end),
          ...(end < rows.length ? { LastEvaluatedKey: { offset: { N: String(end) } } } : {}),
        };
      }
      throw new Error(`Unexpected call: ${JSON.stringify(input)}`);
    });
    fetchStats = require("../handlers/fetchBillStats").handler;
  });

  afterEach(() => {
    restore();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** What the apps send after a saved vote on a grouped bill: the primary, scope=companions, forceRefresh. */
  const AFTER_VOTE = { scope: "companions", forceRefresh: "true" };
  const request = async (sub = "user-1", query: Record<string, string> = AFTER_VOTE, billId = HOUSE) => {
    const response = await fetchStats({
      requestContext: { authorizer: { jwt: { claims: { sub } } } },
      queryStringParameters: { billId, ...query },
    });
    return { statusCode: response.statusCode, body: JSON.parse(response.body) };
  };
  const at = (ms: number) => jest.setSystemTime(new Date(ms));
  const indexQueries = () => send.mock.calls.filter(([command]) => command.input?.IndexName);
  const queriedBills = () => indexQueries().map(([command]) => command.input.ExpressionAttributeValues![":billId"].S!);
  const statsReads = () => send.mock.calls.filter(([command]) => command.input?.TableName === "BillStats");
  const writes = () => send.mock.calls.filter(([command]) => command.input?.Item || command.input?.UpdateExpression);
  const foldMetricLines = () => logLines.filter((line) => line.includes('"FreshStatsFold"'));
  /** A document billStatsAggregator stored under `key`, whose computation started at computedFromMs. */
  const store = (key: string, payload: Record<string, unknown>, computedFromMs?: number) => {
    stored[key] = {
      payload: statsPayload({ billId: key, ...payload }),
      ...(computedFromMs === undefined ? {} : { computedFrom: iso(computedFromMs) }),
    };
  };
  // Self-attested votes only: both segments empty under the verified floor, no rollups.
  const selfAttested = (yea: number, nay: number, abstain = 0) => ({
    totals: bucket(yea, nay, abstain),
    segments: { verified: emptyBucket, selfAttested: emptyBucket },
    rollups: { byState: {}, byDistrict: {} },
  });
  /** The group as the aggregator stored it 50 s before the caller's vote: u2's Nay and u3's Yea. */
  const storeGroupBeforeVote = () => {
    castVote("u2", HOUSE, "Nay");
    castVote("u2", SENATE, "Yea");
    castVote("u3", SENATE, "Yea");
    store(GROUP_KEY, selfAttested(1, 1), VOTED_AT_MS - 50_000);
    store(HOUSE, selfAttested(0, 1), VOTED_AT_MS - 50_000);
    store(SENATE, selfAttested(2, 0), VOTED_AT_MS - 50_000);
  };
  const bulkRows = (billId: string, count: number, options: VoteOptions = {}) =>
    Array.from({ length: count }, (_, i) => row(`${billId}-u${i}`, billId, "Nay", options));

  it("shows a vote on the primary right after it: both members folded, one vote per person, without writing", async () => {
    storeGroupBeforeVote();
    castVote("user-1", HOUSE, "Yea", { votedAt: iso(VOTED_AT_MS) });

    // Without forceRefresh (opening the bill), the stored group document as before.
    const plain = await request("user-1", { scope: "companions" });
    expect(plain.body).toMatchObject({ billId: HOUSE, companionBillIds: [HOUSE, SENATE], totals: { yea: 1, nay: 1 } });
    expect(indexQueries()).toHaveLength(0);

    const { statusCode, body } = await request();

    expect(statusCode).toBe(200);
    // user-1's Yea, u2's Nay on the primary (their Senate Yea is not counted), u3's Yea on the Senate bill.
    expect(body).toMatchObject({
      billId: HOUSE,
      companionBillIds: [HOUSE, SENATE],
      totals: { votes: 3, yea: 2, nay: 1, abstain: 0, decisionVotes: 3, weightedVotes: 3 },
    });
    expect(body.comparison).toEqual({
      allUsers: { votes: 3, yea: 2, nay: 1, abstain: 0, decisionVotes: 3, yeaPct: 66.6667 },
      verifiedWithheld: true,
      minDecisionVotes: 5,
    });
    // The shape 1.1 and 1.2 decode, unchanged.
    expect(Object.keys(body).sort()).toEqual(Object.keys(plain.body).sort());

    // Primary first, as the aggregator reads them, with the user id and votedAt.
    expect(queriedBills()).toEqual([HOUSE, SENATE]);
    expect(indexQueries()[0][0].input).toMatchObject({
      TableName: "UserFeedback",
      IndexName: "GSIBillIdIndex",
      ExpressionAttributeNames: { "#billId": "billId", "#userId": "userId", "#votedAt": "votedAt" },
      ProjectionExpression:
        "feedback, constituentVerified, resolvedState, resolvedDistrict, reasons, adultEligible, legacyDismiss, #userId, #votedAt",
    });
    expect(writes()).toHaveLength(0);
    const [metric] = foldMetricLines();
    expect(JSON.parse(metric)).toMatchObject({ FreshStatsFold: 1 });
    expect(metric).not.toContain("user-1");

    // The app's 4 s request: the same fold, no new query.
    at(VOTED_AT_MS + 4_300);
    expect((await request()).body.totals).toMatchObject({ votes: 3, yea: 2, nay: 1 });
    expect(indexQueries()).toHaveLength(2);
  });

  it("leaves scope=bill on a grouped bill to the bill's own fold (S1), without companionBillIds", async () => {
    storeGroupBeforeVote();
    castVote("user-1", HOUSE, "Yea", { votedAt: iso(VOTED_AT_MS) });

    const { body } = await request("user-1", { forceRefresh: "true" });

    expect(body).not.toHaveProperty("companionBillIds");
    expect(body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    expect(queriedBills()).toEqual([HOUSE]);
  });

  it("shows a vote on the other member, asked for under the primary as the apps do, or under the member", async () => {
    storeGroupBeforeVote();
    // The caller's only row is on the Senate bill, so the apps send the vote there.
    castVote("user-1", SENATE, "Nay", { votedAt: iso(VOTED_AT_MS) });

    const { body } = await request();
    expect(body).toMatchObject({
      billId: HOUSE,
      companionBillIds: [HOUSE, SENATE],
      totals: { votes: 3, yea: 1, nay: 2 },
    });
    expect(indexQueries()).toHaveLength(2);

    // The same group fold under the other member's guid: it holds the vote, so no new query.
    const bySenate = await request("user-1", AFTER_VOTE, SENATE);
    expect(bySenate.body).toMatchObject({ billId: SENATE, companionBillIds: [HOUSE, SENATE], totals: { votes: 3 } });
    expect(indexQueries()).toHaveLength(2);
    expect(writes()).toHaveLength(0);
  });

  it("does not fold for a new vote on the other member while the primary holds the caller's vote: the group counts that one", async () => {
    storeGroupBeforeVote();
    castVote("user-1", HOUSE, "Yea", { votedAt: iso(VOTED_AT_MS - HOUR_MS) });
    store(GROUP_KEY, selfAttested(2, 1), VOTED_AT_MS - 50_000);
    castVote("user-1", SENATE, "Nay", { votedAt: iso(VOTED_AT_MS) });

    const { body } = await request("user-1", AFTER_VOTE, SENATE);

    expect(body.totals).toMatchObject({ votes: 3, yea: 2, nay: 1 });
    expect(indexQueries()).toHaveLength(0);
  });

  describe("1.0 and 1.1 dismissals (legacyDismiss) are not votes", () => {
    it("a dismissal alone is locked out before anything is read", async () => {
      storeGroupBeforeVote();
      dismiss("user-1", HOUSE, { votedAt: iso(VOTED_AT_MS) });

      const { statusCode, body } = await request();

      expect(statusCode).toBe(403);
      expect(body).toEqual({ error: "RESULTS_LOCKED", message: "Vote or abstain on this bill to see its results." });
      expect(statsReads()).toHaveLength(0);
      expect(indexQueries()).toHaveLength(0);
      expect(foldMetricLines()).toEqual([]);
    });

    it("a dismissal on the primary hides no vote: a new vote on the other member folds, and dismissals count nowhere", async () => {
      storeGroupBeforeVote();
      dismiss("u4", HOUSE, { votedAt: iso(VOTED_AT_MS - 2_000) });
      dismiss("user-1", HOUSE, { votedAt: iso(VOTED_AT_MS - 10_000) });
      castVote("user-1", SENATE, "Yea", { votedAt: iso(VOTED_AT_MS) });

      const { body } = await request();

      expect(body.totals).toMatchObject({ votes: 3, yea: 2, nay: 1, abstain: 0 });
      expect(indexQueries()).toHaveLength(2);
    });

    it("a fresh dismissal next to an old vote causes no fold: the caller's vote is the old one", async () => {
      storeGroupBeforeVote();
      castVote("user-1", SENATE, "Yea");
      store(GROUP_KEY, selfAttested(2, 1), VOTED_AT_MS - 50_000);
      dismiss("user-1", HOUSE, { votedAt: iso(VOTED_AT_MS) });

      const { statusCode, body } = await request();

      expect(statusCode).toBe(200);
      expect(body.totals).toMatchObject({ votes: 3, yea: 2, nay: 1, abstain: 0 });
      expect(indexQueries()).toHaveLength(0);
    });
  });

  describe("bounds", () => {
    beforeEach(() => castVote("user-1", HOUSE, "Yea", { votedAt: iso(VOTED_AT_MS) }));

    it("serves the stored group document of a group above 5,000 votes, counting each member's own document too", async () => {
      store(GROUP_KEY, { totals: bucket(4_000, 1_001) }, VOTED_AT_MS - 20_000);
      expect((await request()).body.totals).toMatchObject({ votes: 5_001 });
      expect(indexQueries()).toHaveLength(0);

      // 4,000 people, but 5,001 rows to read: a person who voted on both members is a row on each.
      store(GROUP_KEY, { totals: bucket(4_000, 0) }, VOTED_AT_MS - 20_000);
      store(HOUSE, { totals: bucket(3_000, 0) }, VOTED_AT_MS - 20_000);
      store(SENATE, { totals: bucket(2_000, 1) }, VOTED_AT_MS - 20_000);
      expect((await request()).body.totals).toMatchObject({ votes: 4_000 });
      expect(indexQueries()).toHaveLength(0);

      // At 5,000 rows it folds (the mock index holds only user-1's row).
      store(SENATE, { totals: bucket(2_000, 0) }, VOTED_AT_MS - 20_000);
      expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 1 });
      expect(indexQueries()).toHaveLength(2);
      expect(foldMetricLines()).toHaveLength(1);
    });

    it("stops a fold past 10,000 rows across both members, serves the stored group stats, and waits 60 s", async () => {
      // Rows the stored counts do not show (not adult-eligible): 6,001 on the primary, 6,000 on the other.
      bulk[HOUSE] = bulkRows(HOUSE, 6_000, { adultEligible: false });
      bulk[SENATE] = bulkRows(SENATE, 6_000, { adultEligible: false });
      store(GROUP_KEY, selfAttested(0, 2), VOTED_AT_MS - 20_000);

      const { body } = await request();

      expect(body).toMatchObject({ companionBillIds: [HOUSE, SENATE], totals: { votes: 2, nay: 2 } });
      // The primary's 6,001 rows in 2 pages leave 3,999 for the other member, whose first page passes them.
      expect(queriedBills()).toEqual([HOUSE, HOUSE, SENATE]);
      expect(
        warnLines.some((line) => line.includes("companion group has more vote rows than a fresh fold reads")),
      ).toBe(true);

      for (let ms = 2_300; ms < 60_300; ms += 2_000) {
        at(VOTED_AT_MS + ms);
        expect((await request()).body.totals).toMatchObject({ votes: 2 });
      }
      expect(foldMetricLines()).toHaveLength(1);
      expect(indexQueries()).toHaveLength(3);

      at(VOTED_AT_MS + 60_300);
      await request();
      expect(foldMetricLines()).toHaveLength(2);
    });

    it("does not fold for a vote 2 minutes old or more, or once the stored group document holds the vote", async () => {
      store(GROUP_KEY, selfAttested(0, 1), VOTED_AT_MS - 50_000);
      at(VOTED_AT_MS + 120_000);
      expect((await request()).body.totals).toMatchObject({ votes: 1, nay: 1 });
      expect(indexQueries()).toHaveLength(0);

      // Stored by the aggregator 30 s after the vote: its read started more than 1 s after it.
      at(VOTED_AT_MS + 31_000);
      store(GROUP_KEY, selfAttested(1, 1), VOTED_AT_MS + 30_000);
      expect((await request()).body.totals).toMatchObject({ votes: 2, yea: 1 });
      expect(indexQueries()).toHaveLength(0);

      // One whose read began within 1 s of the vote may have missed it: folded.
      store(GROUP_KEY, selfAttested(0, 1), VOTED_AT_MS + 500);
      expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 1 });
      expect(indexQueries()).toHaveLength(2);
    });

    const noFoldCases: [string, () => void, Record<string, string>][] = [
      ["without forceRefresh", () => undefined, { scope: "companions" }],
      ["with forceRefresh=false", () => undefined, { scope: "companions", forceRefresh: "false" }],
      [
        "for a counted row that is not adult-eligible",
        () => castVote("user-1", HOUSE, "Yea", { votedAt: iso(VOTED_AT_MS), adultEligible: false }),
        AFTER_VOTE,
      ],
      [
        "when the gate's read stopped before the primary's row was read",
        () => {
          table.delete("user-1|" + HOUSE);
          castVote("user-1", SENATE, "Yea", { votedAt: iso(VOTED_AT_MS) });
          unprocessed.add(HOUSE);
        },
        AFTER_VOTE,
      ],
    ];
    it.each(noFoldCases)("serves the stored group stats with no fold %s", async (_label, setUp, query) => {
      setUp();
      store(GROUP_KEY, selfAttested(0, 1), VOTED_AT_MS - 50_000);

      const { statusCode, body } = await request("user-1", query);

      expect(statusCode).toBe(200);
      expect(body).toEqual({
        ...served(statsPayload({ billId: GROUP_KEY, ...selfAttested(0, 1) })),
        billId: HOUSE,
        companionBillIds: [HOUSE, SENATE],
      });
      expect(indexQueries()).toHaveLength(0);
    });

    it("folds when the gate's read returned the caller's vote on the primary and left the other member unread", async () => {
      // The primary's vote is the row the group counts, whatever the other member holds.
      castVote("user-1", SENATE, "Nay");
      unprocessed.add(SENATE);
      store(GROUP_KEY, selfAttested(0, 1), VOTED_AT_MS - 50_000);

      const { body } = await request();

      expect(body).toMatchObject({ companionBillIds: [HOUSE, SENATE], totals: { votes: 1, yea: 1, nay: 0 } });
      expect(queriedBills()).toEqual([HOUSE, SENATE]);
      expect(foldMetricLines()).toHaveLength(1);
    });

    it("after a fold that stopped past 10,000 rows of a group with no document, makes APPF-23's fold in the same request, then neither for 60 s", async () => {
      // No group or member documents (a new pair, a STATS_SCHEMA_VERSION bump): no vote count to check first.
      bulk[HOUSE] = bulkRows(HOUSE, 6_000, { adultEligible: false });
      bulk[SENATE] = bulkRows(SENATE, 6_000, { adultEligible: false });

      const { body } = await request();

      // APPF-23's fold reads every row, so it holds the caller's vote.
      expect(body).toMatchObject({ companionBillIds: [HOUSE, SENATE], totals: { votes: 1, yea: 1 } });
      // The capped fold (the primary's 2 pages, the other member's first), then every page of both members.
      expect(queriedBills()).toEqual([HOUSE, HOUSE, SENATE, HOUSE, HOUSE, SENATE, SENATE]);
      expect(
        warnLines.some((line) => line.includes("companion group has more vote rows than a fresh fold reads")),
      ).toBe(true);
      expect(foldMetricLines()).toHaveLength(1);
      expect(writes()).toHaveLength(0);

      for (let ms = 2_300; ms < 60_300; ms += 2_000) {
        at(VOTED_AT_MS + ms);
        expect((await request()).body.totals).toMatchObject({ votes: 1 });
      }
      expect(indexQueries()).toHaveLength(7);

      at(VOTED_AT_MS + 60_300);
      await request();
      expect(indexQueries()).toHaveLength(14);
      expect(foldMetricLines()).toHaveLength(2);
    });

    it("when the group fold and APPF-23's both fail with no group document, answers with the bill's own stats and fold, as before REL-48", async () => {
      indexFails = true;

      const { statusCode, body } = await request();

      expect(statusCode).toBe(200);
      expect(body).not.toHaveProperty("companionBillIds");
      expect(body).toMatchObject({ billId: HOUSE, totals: { votes: 0 } });
      // The group fold, APPF-23's fold and the bill's own fold each fail on their first page.
      expect(queriedBills()).toEqual([HOUSE, HOUSE, HOUSE]);
      expect(foldMetricLines()).toHaveLength(2);
      expect(warnLines.some((line) => line.includes("Could not fold the companion group's votes after a vote"))).toBe(
        true,
      );
      expect(warnLines.some((line) => line.includes("answering with the bill's own stats"))).toBe(true);

      // Within 2 s only APPF-23's fold is tried again, as on every request before REL-48.
      at(VOTED_AT_MS + 1_000);
      await request();
      expect(indexQueries()).toHaveLength(4);

      indexFails = false;
      at(VOTED_AT_MS + 4_300);
      expect((await request()).body).toMatchObject({ companionBillIds: [HOUSE, SENATE], totals: { votes: 1, yea: 1 } });
      expect(foldMetricLines()).toHaveLength(3);
    });

    it("serves the stored group stats when the fold fails, and tries again no sooner than 2 s later", async () => {
      store(GROUP_KEY, selfAttested(0, 1), VOTED_AT_MS - 50_000);
      indexFails = true;

      expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 0, nay: 1 });
      expect(warnLines.some((line) => line.includes("Could not fold the companion group's votes after a vote"))).toBe(
        true,
      );
      at(VOTED_AT_MS + 1_000);
      await request();
      expect(indexQueries()).toHaveLength(1);

      indexFails = false;
      at(VOTED_AT_MS + 4_300);
      expect((await request()).body.totals).toMatchObject({ votes: 1, yea: 1 });
      expect(foldMetricLines()).toHaveLength(2);
    });
  });

  it("redoes a fold that ran before the vote reached the index, at most once every 2 s per group", async () => {
    storeGroupBeforeVote();
    castVote("user-1", SENATE, "Yea", { votedAt: iso(VOTED_AT_MS), indexed: false });

    // The fold misses the vote and is still the newest count there is.
    expect((await request()).body.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    for (const ms of [500, 1_500, 2_299]) {
      at(VOTED_AT_MS + ms);
      await request();
    }
    expect(foldMetricLines()).toHaveLength(1);

    // The app's 4 s request folds again, now with the vote; a later voter whose row it read gets it too.
    castVote("user-1", SENATE, "Yea", { votedAt: iso(VOTED_AT_MS) });
    castVote("user-5", HOUSE, "Nay", { votedAt: iso(VOTED_AT_MS + 4_000) });
    at(VOTED_AT_MS + 4_300);
    expect((await request()).body.totals).toMatchObject({ votes: 4, yea: 2, nay: 2 });
    expect((await request("user-5")).body.totals).toMatchObject({ votes: 4 });
    expect(foldMetricLines()).toHaveLength(2);
  });

  it("shows the first voters on a new pair their votes: no stored documents, one fold of both members, no APPF-23 fold", async () => {
    // A pair just published: no COMPANIONS# document and no member documents.
    castVote("u2", SENATE, "Nay", { votedAt: iso(VOTED_AT_MS - 5_000) });
    castVote("user-1", HOUSE, "Yea", { votedAt: iso(VOTED_AT_MS) });

    const { statusCode, body } = await request();

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({
      billId: HOUSE,
      companionBillIds: [HOUSE, SENATE],
      totals: { votes: 2, yea: 1, nay: 1 },
    });
    expect(queriedBills()).toEqual([HOUSE, SENATE]);
    expect(foldMetricLines()).toHaveLength(1);

    // A vote on the other member 3 s later, asked for under the primary: that fold does not hold it, so a new one.
    castVote("user-3", SENATE, "Yea", { votedAt: iso(VOTED_AT_MS + 3_000) });
    at(VOTED_AT_MS + 3_300);
    expect((await request("user-3")).body).toMatchObject({
      companionBillIds: [HOUSE, SENATE],
      totals: { votes: 3, yea: 2, nay: 1 },
    });
    expect(queriedBills()).toEqual([HOUSE, SENATE, HOUSE, SENATE]);
    expect(foldMetricLines()).toHaveLength(2);
    expect(writes()).toHaveLength(0);
  });

  it("answers a group document behind a member's own with the fresh fold alone, not a second fold", async () => {
    storeGroupBeforeVote();
    store(HOUSE, { ...selfAttested(0, 1), generatedAt: iso(VOTED_AT_MS - 40_000) }, VOTED_AT_MS - 40_000);
    castVote("user-1", HOUSE, "Yea", { votedAt: iso(VOTED_AT_MS) });

    expect((await request()).body.totals).toMatchObject({ votes: 3, yea: 2, nay: 1 });
    expect(queriedBills()).toEqual([HOUSE, SENATE]);
  });

  it("applies the state and district floors and the segment suppression exactly as the aggregator stores the group", async () => {
    const { computeRawCompanionStats, toServedStats } = require("../shared/billStats");
    // CA: 4 verified voters before the caller (3 in CA-12 on the primary, 1 in CA-13 on the other member);
    // ca-0 also voted on the other member, which does not count. WY: 1. One self-attested voter.
    for (let i = 0; i < 3; i += 1) castVote(`ca-${i}`, HOUSE, "Yea", { verified: true, state: "CA", district: "12" });
    castVote("ca-0", SENATE, "Nay", { verified: true, state: "CA", district: "12" });
    castVote("ca-3", SENATE, "Nay", { verified: true, state: "ca", district: "13" });
    castVote("wy", HOUSE, "Nay", { verified: true, state: "WY", district: "AL" });
    castVote("self", SENATE, "Yea");
    store(GROUP_KEY, selfAttested(4, 2), VOTED_AT_MS - 50_000);
    // The caller, verified in CA-12, votes on the other member: CA reaches 5, CA-12 only 4.
    castVote("user-1", SENATE, "Yea", { votedAt: iso(VOTED_AT_MS), verified: true, state: "CA", district: "12" });

    const { body } = await request();

    expect(body.totals).toMatchObject({ votes: 7, yea: 5, nay: 2 });
    expect(Object.keys(body.rollups.byState)).toEqual(["CA"]);
    expect(body.rollups.byState.CA.totals).toMatchObject({ yea: 4, nay: 1 });
    expect(body.rollups.byDistrict).toEqual({});
    // Verified 6 minus the 5 shown in CA would reveal WY's one vote: both segments go out empty.
    expect(body.segments).toEqual({ verified: emptyBucket, selfAttested: emptyBucket });
    expect(body.comparison.verifiedWithheld).toBe(true);
    expect(body.comparison).not.toHaveProperty("verified");

    // The same body the aggregator's group computation gives for these votes, floored as it stores it.
    const aggregated = await computeRawCompanionStats({
      db: {
        send: async (command: FakeCommand) => ({
          Items: indexRows(command.input.ExpressionAttributeValues![":billId"].S!),
        }),
      },
      tableName: "UserFeedback",
      userIdAttribute: "userId",
      sortKey: "billId",
      billIdIndexName: "GSIBillIdIndex",
      statsKey: GROUP_KEY,
      memberGuids: [HOUSE, SENATE],
    });
    const { comparison, ...rest } = body;
    const expected = JSON.parse(JSON.stringify(toServedStats(aggregated)));
    expect({ ...rest, comparison }).toEqual({ ...expected, billId: HOUSE, companionBillIds: [HOUSE, SENATE] });
  });
});
