import type {
  AttributeValue,
  GetItemCommandInput,
  PutItemCommandInput,
  QueryCommandInput,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

process.env.TABLE_NAME = "UserFeedback";
process.env.PARTITION_KEY = "userId";
process.env.SORT_KEY = "billId";
process.env.BILL_ID_INDEX_NAME = "GSIBillIdIndex";
process.env.STATS_TABLE_NAME = "BillStats";
process.env.STATS_PARTITION_KEY = "billId";
// Ignored since 2C (INT-08): set to the old production weights to prove they change nothing.
process.env.VERIFIED_VOTE_WEIGHT = "1.25";
process.env.SELF_ATTESTED_VOTE_WEIGHT = "1.0";

/** The input of any DynamoDB command these tests read back, in the SDK's own field names. */
type FakeInput = Partial<GetItemCommandInput & PutItemCommandInput & QueryCommandInput & UpdateItemCommandInput>;

interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { handler } = require("../handlers/billStatsAggregator");

describe("billStatsAggregator handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Queued mockResolvedValueOnce values must not leak from one test into the next.
    mockSend.mockReset();
  });

  it("returns 400 for API invocation without billId", async () => {
    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: {},
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Missing billId" });
  });

  it("computes and writes stats for direct billId", async () => {
    mockSend
      // query feedback rows
      .mockResolvedValueOnce({
        Items: [
          {
            userId: { S: "u1" },
            billId: { S: "BILL-2" },
            feedback: { S: "Yea" },
            constituentVerified: { BOOL: true },
            effectiveWeight: { N: "1.25" },
            resolvedState: { S: "CA" },
            resolvedDistrict: { S: "CA-12" },
          },
          {
            userId: { S: "u2" },
            billId: { S: "BILL-2" },
            feedback: { S: "Nay" },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
            resolvedState: { S: "CA" },
            resolvedDistrict: { S: "CA-12" },
          },
        ],
      })
      // cache write
      .mockResolvedValueOnce({});

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILL-2" },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      processedBillIds: ["BILL-2"],
      updatedCount: 1,
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "BillStats",
          Item: expect.objectContaining({
            billId: { S: "BILL-2" },
            payload: { S: expect.any(String) },
            schemaVersion: { S: "4" },
          }),
        }),
      }),
    );

    const statsWriteCall = mockSend.mock.calls.find(
      ([command]: [FakeCommand]) => command?.input?.TableName === "BillStats",
    );
    expect(statsWriteCall).toBeDefined();
    const statsPayload = JSON.parse(statsWriteCall[0].input.Item.payload.S);
    expect(statsPayload.reasonBreakdown).toEqual({
      minCount: 5,
      yea: { voteCount: 1, reasons: [] },
      nay: { voteCount: 1, reasons: [] },
    });
  });

  it("stores stats with every vote counted once, whatever effectiveWeight the rows hold (2C)", async () => {
    const row = (userId: string, feedback: string, verified: boolean, weight: string) => ({
      userId: { S: userId },
      billId: { S: "BILL-W" },
      feedback: { S: feedback },
      constituentVerified: { BOOL: verified },
      effectiveWeight: { N: weight },
      ...(verified ? { resolvedState: { S: "CA" }, resolvedDistrict: { S: "CA-12" } } : {}),
    });
    mockSend
      .mockResolvedValueOnce({
        Items: [
          ...["v1", "v2", "v3", "v4", "v5"].map((id) => row(id, "Yea", true, "1.25")),
          ...["s1", "s2", "s3", "s4", "s5"].map((id) => row(id, "Nay", false, "1.0")),
          row("s6", "Abstain", false, "1"),
        ],
      })
      .mockResolvedValueOnce({});

    await handler({ billId: "BILL-W" });

    const statsWriteCall = mockSend.mock.calls.find(
      ([command]: [FakeCommand]) => command?.input?.TableName === "BillStats",
    );
    const stored = JSON.parse(statsWriteCall[0].input.Item.payload.S);
    // At 1.25 per verified vote the national Yea share would have been 55.5556%.
    expect(stored.totals).toEqual({
      votes: 11,
      yea: 5,
      nay: 5,
      abstain: 1,
      decisionVotes: 10,
      yeaPct: 50,
      weightedVotes: 11,
      weightedYea: 5,
      weightedNay: 5,
      weightedAbstain: 1,
      weightedDecisionVotes: 10,
      weightedYeaPct: 50,
    });
    expect(stored.segments.verified).toMatchObject({ votes: 5, weightedVotes: 5, weightedYea: 5, weightedYeaPct: 100 });
    expect(stored.rollups.byState.CA.totals).toMatchObject({ votes: 5, weightedVotes: 5 });
    // The comparison is added when served, never stored; the schema version is unchanged.
    expect(stored).not.toHaveProperty("comparison");
    expect(statsWriteCall[0].input.Item.schemaVersion).toEqual({ S: "4" });
  });

  it("extracts bill ids from dynamodb stream records", async () => {
    mockSend
      // query for BILL-3
      .mockResolvedValueOnce({ Items: [] })
      // write for BILL-3
      .mockResolvedValueOnce({})
      // query for BILL-4
      .mockResolvedValueOnce({ Items: [] })
      // write for BILL-4
      .mockResolvedValueOnce({});

    const streamResult = await handler({
      Records: [
        {
          eventSource: "aws:dynamodb",
          eventName: "INSERT",
          dynamodb: {
            NewImage: {
              billId: { S: "BILL-3" },
              feedback: { S: "Yea" },
            },
          },
        },
        {
          eventSource: "aws:dynamodb",
          eventName: "MODIFY",
          dynamodb: {
            Keys: {
              billId: { S: "BILL-4" },
            },
          },
        },
        {
          eventSource: "aws:dynamodb",
          eventName: "MODIFY",
          dynamodb: {
            Keys: {
              billId: { S: "BILL-4" },
            },
          },
        },
      ],
    });

    expect(streamResult).toEqual({
      processedBillIds: ["BILL-3", "BILL-4"],
      updatedCount: 2,
    });
  });

  it("builds reason breakdown buckets at or above minCount", async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          {
            userId: { S: "u1" },
            billId: { S: "BILL-9" },
            feedback: { S: "Yea" },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
            reasons: { SS: ["economic_impact"] },
          },
          {
            userId: { S: "u2" },
            billId: { S: "BILL-9" },
            feedback: { S: "Yea" },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
            reasons: { SS: ["economic_impact"] },
          },
          {
            userId: { S: "u3" },
            billId: { S: "BILL-9" },
            feedback: { S: "Yea" },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
            reasons: { SS: ["economic_impact"] },
          },
          {
            userId: { S: "u4" },
            billId: { S: "BILL-9" },
            feedback: { S: "Yea" },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
            reasons: { SS: ["economic_impact"] },
          },
          {
            userId: { S: "u5" },
            billId: { S: "BILL-9" },
            feedback: { S: "Yea" },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
            reasons: { SS: ["economic_impact"] },
          },
        ],
      })
      .mockResolvedValueOnce({});

    await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILL-9" },
    });

    const statsWriteCall = mockSend.mock.calls.find(
      ([command]: [FakeCommand]) => command?.input?.TableName === "BillStats",
    );
    expect(statsWriteCall).toBeDefined();
    const statsPayload = JSON.parse(statsWriteCall[0].input.Item.payload.S);
    expect(statsPayload.reasonBreakdown).toEqual({
      minCount: 5,
      yea: {
        voteCount: 5,
        reasons: [{ reasonKey: "economic_impact", count: 5, pct: 100 }],
      },
      nay: { voteCount: 0, reasons: [] },
    });
  });

  it("excludes feedback rows marked adultEligible=false", async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          {
            userId: { S: "u1" },
            billId: { S: "BILL-10" },
            feedback: { S: "Yea" },
            adultEligible: { BOOL: false },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
          },
          {
            userId: { S: "u2" },
            billId: { S: "BILL-10" },
            feedback: { S: "Nay" },
            adultEligible: { BOOL: true },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
          },
        ],
      })
      .mockResolvedValueOnce({});

    await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILL-10" },
    });

    const statsWriteCall = mockSend.mock.calls.find(
      ([command]: [FakeCommand]) => command?.input?.TableName === "BillStats",
    );
    expect(statsWriteCall).toBeDefined();
    const statsPayload = JSON.parse(statsWriteCall[0].input.Item.payload.S);
    expect(statsPayload.totals.votes).toBe(1);
    expect(statsPayload.totals.nay).toBe(1);
    expect(statsPayload.totals.yea).toBe(0);
  });

  it("leaves a 1.0 or 1.1 dismissal (legacyDismiss) out of every count of the bill, the comparison included (INT-11)", async () => {
    const { toServedStats } = require("../shared/billStats");
    const row = (userId: string, feedback: string, verified: boolean, fields: Record<string, unknown> = {}) => ({
      userId: { S: userId },
      billId: { S: "BILL-D" },
      feedback: { S: feedback },
      constituentVerified: { BOOL: verified },
      ...(verified ? { resolvedState: { S: "CA" }, resolvedDistrict: { S: "12" } } : {}),
      ...fields,
    });
    const dismissed = { legacyDismiss: { BOOL: true } };
    mockSend
      .mockResolvedValueOnce({
        Items: [
          // Enough verified Yea that the sample floor keeps the segments and the CA rollups.
          ...["v1", "v2", "v3", "v4", "v5"].map((id) => row(id, "Yea", true)),
          row("v6", "Abstain", true),
          row("v7", "Abstain", true, dismissed),
          row("v8", "Abstain", true, dismissed),
          ...["s1", "s2", "s3", "s4", "s5"].map((id) => row(id, "Nay", false)),
          row("s6", "Abstain", false),
          row("s7", "Abstain", false, dismissed),
          // An explicit false is no mark.
          row("s8", "Abstain", false, { legacyDismiss: { BOOL: false } }),
        ],
      })
      .mockResolvedValueOnce({});

    await handler({ billId: "BILL-D" });

    const statsWriteCall = mockSend.mock.calls.find(
      ([command]: [FakeCommand]) => command?.input?.TableName === "BillStats",
    );
    const stored = JSON.parse(statsWriteCall[0].input.Item.payload.S);
    expect(stored.totals).toMatchObject({ votes: 13, yea: 5, nay: 5, abstain: 3, decisionVotes: 10 });
    expect(stored.totals.weightedAbstain).toBe(3);
    expect(stored.segments.verified).toMatchObject({ votes: 6, yea: 5, abstain: 1 });
    expect(stored.segments.selfAttested).toMatchObject({ votes: 7, nay: 5, abstain: 2 });
    expect(stored.rollups.byState.CA.totals).toMatchObject({ votes: 6, abstain: 1 });
    expect(stored.rollups.byState.CA.segments.verified).toMatchObject({ votes: 6, abstain: 1 });
    expect(stored.rollups.byDistrict["CA|12"].totals).toMatchObject({ votes: 6, abstain: 1 });

    const { comparison } = toServedStats(stored);
    expect(comparison.allUsers).toEqual({ votes: 13, yea: 5, nay: 5, abstain: 3, decisionVotes: 10, yeaPct: 50 });
    expect(comparison.verified).toEqual({ votes: 6, yea: 5, nay: 0, abstain: 1, decisionVotes: 5, yeaPct: 100 });
  });

  it("writes manifest voteCount when manifest env is configured", async () => {
    jest.resetModules();
    process.env.TABLE_NAME = "UserFeedback";
    process.env.PARTITION_KEY = "userId";
    process.env.SORT_KEY = "billId";
    process.env.BILL_ID_INDEX_NAME = "GSIBillIdIndex";
    process.env.STATS_TABLE_NAME = "BillStats";
    process.env.STATS_PARTITION_KEY = "billId";
    process.env.VERIFIED_VOTE_WEIGHT = "1.25";
    process.env.SELF_ATTESTED_VOTE_WEIGHT = "1.0";
    process.env.MANIFEST_TABLE_NAME = "BillsManifest";
    process.env.MANIFEST_PRIMARY_KEY = "pk";
    process.env.MANIFEST_SORT_KEY = "sk";
    process.env.MANIFEST_PK_VALUE = "BILL";
    process.env.MANIFEST_GUID_LOOKUP_PK = "BILL_GUID";

    const { __mockSend: manifestMockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
    manifestMockSend.mockClear();
    const { handler: handlerWithManifest } = require("../handlers/billStatsAggregator");

    manifestMockSend
      .mockResolvedValueOnce({
        Items: [
          {
            userId: { S: "u1" },
            billId: { S: "BILL-11" },
            feedback: { S: "Yea" },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
          },
          {
            userId: { S: "u2" },
            billId: { S: "BILL-11" },
            feedback: { S: "Nay" },
            constituentVerified: { BOOL: false },
            effectiveWeight: { N: "1.0" },
          },
          {
            userId: { S: "u3" },
            billId: { S: "BILL-11" },
            feedback: { S: "Yea" },
            constituentVerified: { BOOL: true },
            effectiveWeight: { N: "1.25" },
            resolvedState: { S: "CA" },
          },
          {
            userId: { S: "u4" },
            billId: { S: "BILL-11" },
            feedback: { S: "Nay" },
            constituentVerified: { BOOL: true },
            effectiveWeight: { N: "1.25" },
            resolvedState: { S: "CA" },
          },
          {
            userId: { S: "u5" },
            billId: { S: "BILL-11" },
            feedback: { S: "Abstain" },
            constituentVerified: { BOOL: true },
            effectiveWeight: { N: "1.25" },
            resolvedState: { S: "CA" },
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: {
          manifestSk: { S: "2026-01-05T00:00:00.000Z#BILL-11" },
        },
      })
      .mockResolvedValueOnce({});

    const response = await handlerWithManifest({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILL-11" },
    });

    expect(response.statusCode).toBe(200);

    const manifestUpdateCall = manifestMockSend.mock.calls.find(
      ([command]: [FakeCommand]) =>
        command?.input?.TableName === "BillsManifest" &&
        command?.input?.UpdateExpression === "SET voteCount = :voteCount, #computedFrom = :computedFrom",
    );
    expect(manifestUpdateCall).toBeDefined();
    // INT-07: only verified Yea/Nay votes rank the feed (2 of 4 decision votes here, abstain excluded).
    // The count is not floored, although the cached payload's verified segment is.
    expect(manifestUpdateCall[0].input.ExpressionAttributeValues[":voteCount"].N).toBe("2");
    expect(manifestUpdateCall[0].input.ConditionExpression).toBe(
      "attribute_exists(#pk) AND (attribute_not_exists(#computedFrom) OR #computedFrom <= :computedFrom)",
    );
    expect(manifestUpdateCall[0].input.ExpressionAttributeNames).toEqual({
      "#pk": "pk",
      "#computedFrom": "voteCountComputedFrom",
    });
    expect(manifestUpdateCall[0].input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
    // The same instant the stats write was conditioned on.
    const statsPut = manifestMockSend.mock.calls.find(
      ([command]: [FakeCommand]) => command?.input?.TableName === "BillStats",
    );
    expect(manifestUpdateCall[0].input.ExpressionAttributeValues[":computedFrom"]).toEqual(
      statsPut[0].input.Item.computedFrom,
    );

    const statsWriteCall = manifestMockSend.mock.calls.find(
      ([command]: [FakeCommand]) => command?.input?.TableName === "BillStats",
    );
    const cached = JSON.parse(statsWriteCall[0].input.Item.payload.S);
    expect(cached.totals.decisionVotes).toBe(4);
    expect(cached.segments.verified.decisionVotes).toBe(0);
    expect(cached.rollups).toEqual({ byState: {}, byDistrict: {} });
  });

  describe("manifest voteCount and stats write failures", () => {
    const loadWithManifest = () => {
      jest.resetModules();
      process.env.MANIFEST_TABLE_NAME = "BillsManifest";
      process.env.MANIFEST_PRIMARY_KEY = "pk";
      process.env.MANIFEST_SORT_KEY = "sk";
      process.env.MANIFEST_PK_VALUE = "BILL";
      process.env.MANIFEST_GUID_LOOKUP_PK = "BILL_GUID";
      const { __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb");
      send.mockReset();
      const { handler: loaded } = require("../handlers/billStatsAggregator");
      return { send, loaded };
    };

    const conditionalFailure = () =>
      Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

    afterEach(() => {
      delete process.env.MANIFEST_TABLE_NAME;
      jest.restoreAllMocks();
    });

    it("re-reads the lookup once when the manifest row moved under the update", async () => {
      const { send, loaded } = loadWithManifest();
      send
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Item: { manifestSk: { S: "2026-01-01T00:00:00.000Z#BILL-12" } } })
        .mockRejectedValueOnce(conditionalFailure())
        .mockResolvedValueOnce({ Item: { manifestSk: { S: "2026-02-01T00:00:00.000Z#BILL-12" } } })
        .mockResolvedValueOnce({});

      await loaded({ billId: "BILL-12" });

      const updates = send.mock.calls.filter(([command]: [FakeCommand]) => command?.input?.UpdateExpression);
      expect(updates.map(([command]: [FakeCommand]) => command.input.Key!.sk.S)).toEqual([
        "2026-01-01T00:00:00.000Z#BILL-12",
        "2026-02-01T00:00:00.000Z#BILL-12",
      ]);
    });

    it("gives up quietly when the row keeps moving, without recreating it", async () => {
      const { send, loaded } = loadWithManifest();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      send
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Item: { manifestSk: { S: "a#BILL-13" } } })
        .mockRejectedValueOnce(conditionalFailure())
        .mockResolvedValueOnce({ Item: { manifestSk: { S: "b#BILL-13" } } })
        .mockRejectedValueOnce(conditionalFailure());

      await expect(loaded({ billId: "BILL-13" })).resolves.toEqual({ processedBillIds: ["BILL-13"], updatedCount: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not find the manifest row"), "BILL-13");
    });

    // The manifest table in memory: the lookup row and the bill's row, conditions evaluated as DynamoDB does.
    const manifestTable = (row: Record<string, AttributeValue> | undefined) => {
      const { evaluateCondition, conditionalCheckFailed } = require("./fixtures/dynamoCondition");
      const state = { row };
      const { send } = loadWithManifest();
      send.mockImplementation(async (command: FakeCommand) => {
        const input = command.input;
        if (input.Key?.pk?.S === "BILL_GUID") {
          return state.row ? { Item: { manifestSk: { S: "2026-01-01T00:00:00.000Z#BILL-20" } } } : {};
        }
        if (input.UpdateExpression) {
          if (!evaluateCondition(state.row, input)) {
            throw conditionalCheckFailed(
              input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? state.row : undefined,
            );
          }
          state.row = {
            ...state.row,
            voteCount: input.ExpressionAttributeValues![":voteCount"],
            voteCountComputedFrom: input.ExpressionAttributeValues![":computedFrom"],
          };
          return {};
        }
        throw new Error(`Unexpected call: ${JSON.stringify(input)}`);
      });
      const { updateManifestVoteCount } = require("../handlers/billStatsAggregator");
      return { state, send, updateManifestVoteCount };
    };
    const billRow = (fields: Record<string, AttributeValue> = {}) => ({
      pk: { S: "BILL" },
      sk: { S: "2026-01-01T00:00:00.000Z#BILL-20" },
      voteCount: { N: "3" },
      ...fields,
    });

    it("never lets an earlier-started recompute overwrite a later one's count", async () => {
      const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
      const { state, send, updateManifestVoteCount } = manifestTable(billRow());

      // Started 10:00:02 with 7 votes, finished first.
      await expect(updateManifestVoteCount("BILL-20", 7, "2026-09-25T10:00:02.000Z")).resolves.toBe("updated");
      // Started 10:00:01 with 6 votes, finished last.
      await expect(updateManifestVoteCount("BILL-20", 6, "2026-09-25T10:00:01.000Z")).resolves.toBe("superseded");

      expect(state.row).toMatchObject({
        voteCount: { N: "7" },
        voteCountComputedFrom: { S: "2026-09-25T10:00:02.000Z" },
      });
      // A superseded update is not mistaken for a moved row: one lookup read for it, no retry.
      const lookups = send.mock.calls.filter(([command]: [FakeCommand]) => command.input.Key?.pk?.S === "BILL_GUID");
      expect(lookups).toHaveLength(2);
      expect(log).toHaveBeenCalledWith(
        "billStatsAggregator kept a manifest voteCount from a later-started recompute:",
        "BILL-20",
      );
    });

    it("updates a row written before voteCountComputedFrom existed, and a recompute that started at the same instant", async () => {
      const { state, updateManifestVoteCount } = manifestTable(billRow());

      await expect(updateManifestVoteCount("BILL-20", 4, "2026-09-25T10:00:00.000Z")).resolves.toBe("updated");
      await expect(updateManifestVoteCount("BILL-20", 5, "2026-09-25T10:00:00.000Z")).resolves.toBe("updated");

      expect(state.row).toMatchObject({ voteCount: { N: "5" } });
    });

    it("reports a missing lookup without writing", async () => {
      const { send, updateManifestVoteCount } = manifestTable(undefined);

      await expect(updateManifestVoteCount("BILL-20", 4, "2026-09-25T10:00:00.000Z")).resolves.toBe("missing");
      expect(send.mock.calls.filter(([command]: [FakeCommand]) => command.input.UpdateExpression)).toHaveLength(0);
    });

    it("throws a stats write failure for stream invocations so the mapping retries", async () => {
      const { send, loaded } = loadWithManifest();
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      send
        .mockResolvedValueOnce({ Items: [] })
        .mockRejectedValueOnce(
          Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }),
        );

      await expect(
        loaded({
          Records: [
            {
              eventSource: "aws:dynamodb",
              eventName: "INSERT",
              dynamodb: { NewImage: { billId: { S: "BILL-14" }, feedback: { S: "Nay" } } },
            },
          ],
        }),
      ).rejects.toThrow("throttled");
      const manifestCalls = send.mock.calls.filter(
        ([command]: [FakeCommand]) => command?.input?.TableName === "BillsManifest",
      );
      expect(manifestCalls).toHaveLength(0);
    });

    it("returns 500 to API callers when the stats write fails", async () => {
      const { send, loaded } = loadWithManifest();
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      send.mockResolvedValueOnce({ Items: [] }).mockRejectedValueOnce(new Error("boom"));

      const response = await loaded({
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
        queryStringParameters: { billId: "BILL-15" },
      });
      expect(response.statusCode).toBe(500);
    });
  });

  describe("coalesced stream recomputes (CAP-04)", () => {
    const vote = (userId: string, billId: string, fields: Record<string, unknown> = {}) => ({
      userId: { S: userId },
      billId: { S: billId },
      feedback: { S: "Yea" },
      constituentVerified: { BOOL: false },
      effectiveWeight: { N: "1.0" },
      ...fields,
    });
    const streamRecord = (eventName: string, dynamodb: Record<string, unknown>) => ({
      eventSource: "aws:dynamodb",
      eventName,
      dynamodb,
    });
    const queries = () =>
      mockSend.mock.calls.filter(([command]: [FakeCommand]) => command?.input?.IndexName === "GSIBillIdIndex");
    const statsWrites = () =>
      mockSend.mock.calls.filter(([command]: [FakeCommand]) => command?.input?.TableName === "BillStats");

    beforeEach(() => {
      jest.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("recomputes each distinct bill once however many of its votes the batch holds", async () => {
      mockSend.mockImplementation(async (command: FakeCommand) => {
        if (command?.input?.IndexName)
          return { Items: [vote("u1", command.input.ExpressionAttributeValues![":billId"].S!)] };
        return {};
      });

      const records = [
        ...Array.from({ length: 40 }, (_, i) =>
          streamRecord("INSERT", { NewImage: vote(`u${i}`, "BILL-HOT"), Keys: { billId: { S: "BILL-HOT" } } }),
        ),
        streamRecord("MODIFY", { NewImage: vote("u1", "BILL-B"), Keys: { billId: { S: "BILL-B" } } }),
        streamRecord("REMOVE", { Keys: { userId: { S: "u9" }, billId: { S: "BILL-HOT" } } }),
      ];
      const result = await handler({ Records: records });

      expect(result).toEqual({ processedBillIds: ["BILL-HOT", "BILL-B"], updatedCount: 2 });
      expect(
        queries().map(([command]: [FakeCommand]) => command.input.ExpressionAttributeValues![":billId"].S),
      ).toEqual(["BILL-HOT", "BILL-B"]);
      expect(statsWrites()).toHaveLength(2);
    });

    it("skips an INSERT of an item the stats do not count, and nothing else", async () => {
      mockSend.mockImplementation(async (command: FakeCommand) => (command?.input?.IndexName ? { Items: [] } : {}));

      const result = await handler({
        Records: [
          // Provably irrelevant: new items that the fold would ignore.
          streamRecord("INSERT", { NewImage: vote("u1", "BILL-SKIP-1", { adultEligible: { BOOL: false } }) }),
          streamRecord("INSERT", { NewImage: { userId: { S: "u2" }, billId: { S: "BILL-SKIP-2" } } }),
          streamRecord("INSERT", { NewImage: vote("u3", "BILL-SKIP-3", { feedback: { S: "Maybe" } }) }),
          // Without the old image a MODIFY or REMOVE may have changed a counted vote.
          streamRecord("MODIFY", { NewImage: vote("u4", "BILL-MOD", { adultEligible: { BOOL: false } }) }),
          streamRecord("REMOVE", { Keys: { userId: { S: "u5" }, billId: { S: "BILL-DEL" } } }),
          // An INSERT without an image (a KEYS_ONLY stream) cannot be judged, so it recomputes.
          streamRecord("INSERT", { Keys: { userId: { S: "u6" }, billId: { S: "BILL-KEYS" } } }),
        ],
      });

      expect(result).toEqual({ processedBillIds: ["BILL-MOD", "BILL-DEL", "BILL-KEYS"], updatedCount: 3 });
      expect(console.log).toHaveBeenCalledWith("billStatsAggregator stream batch", {
        records: 6,
        skippedRecords: 3,
        distinctBills: 3,
      });
    });

    it("skips an INSERT of a 1.0 or 1.1 dismissal and recomputes a bill whose stored row gets marked (INT-11)", async () => {
      mockSend.mockImplementation(async (command: FakeCommand) => (command?.input?.IndexName ? { Items: [] } : {}));
      const dismissal = (userId: string, billId: string) =>
        vote(userId, billId, { feedback: { S: "Abstain" }, legacyDismiss: { BOOL: true } });

      const result = await handler({
        Records: [
          // SetFeedback stored a new row as a dismissal: no count changes.
          streamRecord("INSERT", { NewImage: dismissal("u1", "BILL-NEW-DISMISSAL") }),
          // The legacy-dismissal repair marked a stored Abstain, or SetFeedback replaced a vote with a dismissal.
          streamRecord("MODIFY", { NewImage: dismissal("u2", "BILL-MARKED") }),
          // An unmarked Abstain still counts.
          streamRecord("INSERT", { NewImage: vote("u3", "BILL-ABSTAIN", { feedback: { S: "Abstain" } }) }),
        ],
      });

      expect(result).toEqual({ processedBillIds: ["BILL-MARKED", "BILL-ABSTAIN"], updatedCount: 2 });
      expect(console.log).toHaveBeenCalledWith("billStatsAggregator stream batch", {
        records: 3,
        skippedRecords: 1,
        distinctBills: 2,
      });
    });

    it("returns without reading anything when every record in the batch is skipped", async () => {
      const result = await handler({
        Records: [streamRecord("INSERT", { NewImage: vote("u1", "BILL-X", { adultEligible: { BOOL: false } }) })],
      });

      expect(result).toEqual({ processedBillIds: [], updatedCount: 0 });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("projects only the attributes the computation reads and follows every page", async () => {
      mockSend
        .mockResolvedValueOnce({
          Items: [vote("u1", "BILL-P")],
          LastEvaluatedKey: { billId: { S: "BILL-P" }, userId: { S: "u1" } },
        })
        .mockResolvedValueOnce({ Items: [vote("u2", "BILL-P", { feedback: { S: "Nay" } })] })
        .mockResolvedValueOnce({});

      await handler({ billId: "BILL-P" });

      const [first, second] = queries().map(([command]: [FakeCommand]) => command.input);
      expect(first.ProjectionExpression).toBe(
        "feedback, constituentVerified, resolvedState, resolvedDistrict, reasons, adultEligible, legacyDismiss",
      );
      expect(first.ExclusiveStartKey).toBeUndefined();
      expect(second.ExclusiveStartKey).toEqual({ billId: { S: "BILL-P" }, userId: { S: "u1" } });
      const stored = JSON.parse(statsWrites()[0][0].input.Item.payload.S);
      expect(stored.totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
    });

    it("stores stats conditioned on no later-started computation having stored first", async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-09-25T10:00:00.000Z"));
      try {
        mockSend.mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});

        await handler({ Records: [streamRecord("MODIFY", { Keys: { billId: { S: "BILL-O" } } })] });

        const put = statsWrites()[0][0].input;
        expect(put.Item.computedFrom).toEqual({ S: "2026-09-25T10:00:00.000Z" });
        expect(put.ConditionExpression).toBe("attribute_not_exists(#computedFrom) OR #computedFrom <= :computedFrom");
        expect(put.ExpressionAttributeNames).toEqual({ "#computedFrom": "computedFrom" });
        expect(put.ExpressionAttributeValues).toEqual({ ":computedFrom": { S: "2026-09-25T10:00:00.000Z" } });
      } finally {
        jest.useRealTimers();
      }
    });

    it("drops a superseded recompute without failing the batch or touching the manifest", async () => {
      jest.resetModules();
      process.env.MANIFEST_TABLE_NAME = "BillsManifest";
      try {
        const { __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb");
        send.mockReset();
        const { handler: loaded } = require("../handlers/billStatsAggregator");
        send
          .mockResolvedValueOnce({ Items: [vote("u1", "BILL-S")] })
          .mockRejectedValueOnce(
            Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" }),
          );

        await expect(
          loaded({ Records: [streamRecord("MODIFY", { Keys: { billId: { S: "BILL-S" } } })] }),
        ).resolves.toEqual({ processedBillIds: ["BILL-S"], updatedCount: 1 });
        // Only the read of the published companion groups; no voteCount lookup or update.
        const manifestCalls = send.mock.calls.filter(
          ([command]: [FakeCommand]) =>
            command?.input?.TableName === "BillsManifest" && command.input.Key?.pk?.S !== "BILL_COMPANION_GROUPS",
        );
        expect(manifestCalls).toHaveLength(0);
      } finally {
        delete process.env.MANIFEST_TABLE_NAME;
      }
    });

    it("gives the same stats however the votes are ordered or paged", async () => {
      const { computeRawBillStats, createBillStatsAccumulator } = require("../shared/billStats");
      // Deterministic pseudo-random votes covering every branch of the fold.
      let seed = 42;
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      const pick = <T>(values: T[]): T => values[Math.floor(next() * values.length)];
      const items = Array.from({ length: 2000 }, (_, i) => ({
        feedback: { S: pick(["Yea", "Nay", "Abstain", "Yea", "Nay", "bogus"]) },
        effectiveWeight: next() < 0.1 ? { N: "NaN" } : { N: pick(["1", "1.25", "0.5"]) },
        constituentVerified: { BOOL: next() < 0.6 },
        ...(next() < 0.9 ? { resolvedState: { S: pick(["ca", "NY", " tx ", "WY"]) } } : {}),
        ...(next() < 0.8 ? { resolvedDistrict: { S: pick(["1", "2", "12", "AL"]) } } : {}),
        ...(next() < 0.7 ? { reasons: { SS: [pick(["economic_impact", "healthcare", " taxes_spending "])] } } : {}),
        ...(next() < 0.05 ? { adultEligible: { BOOL: false } } : {}),
        userId: { S: `u${i}` },
      }));
      const withoutTime = ({ generatedAt: _generatedAt, ...rest }: { generatedAt: string }) => rest;

      const inOrder = createBillStatsAccumulator("BILL-E");
      items.forEach((item) => inOrder.add(item));
      const reversed = createBillStatsAccumulator("BILL-E");
      [...items].reverse().forEach((item) => reversed.add(item));
      expect(withoutTime(reversed.result())).toEqual(withoutTime(inOrder.result()));

      const pageSize = 7;
      const paged = jest.fn(async (command: FakeCommand) => {
        const offset = Number(command.input.ExclusiveStartKey?.offset?.N ?? "0");
        const end = offset + pageSize;
        return {
          Items: items.slice(offset, end),
          ...(end < items.length ? { LastEvaluatedKey: { offset: { N: String(end) } } } : {}),
        };
      });
      const recomputed = await computeRawBillStats({
        db: { send: paged },
        tableName: "UserFeedback",
        partitionKey: "userId",
        sortKey: "billId",
        billIdIndexName: "GSIBillIdIndex",
        billId: "BILL-E",
      });
      expect(paged).toHaveBeenCalledTimes(Math.ceil(items.length / pageSize));
      expect(withoutTime(recomputed)).toEqual(withoutTime(inOrder.result()));
      expect(recomputed.totals.votes).toBeGreaterThan(1500);
    });

    it("recomputes distinct bills concurrently, capped, and rethrows a failure after the rest settle", async () => {
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      let inFlight = 0;
      let maxInFlight = 0;
      mockSend.mockImplementation(async (command: FakeCommand) => {
        if (!command?.input?.IndexName) return {};
        const billId = command.input.ExpressionAttributeValues![":billId"].S;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (billId === "BILL-2") throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        return { Items: [] };
      });

      const records = Array.from({ length: 10 }, (_, i) =>
        streamRecord("MODIFY", { Keys: { billId: { S: `BILL-${i}` } } }),
      );
      await expect(handler({ Records: records })).rejects.toThrow("throttled");

      expect(maxInFlight).toBe(4);
      // Bills already started finish and store their stats; no new bill starts after the failure.
      expect(statsWrites().length).toBeGreaterThanOrEqual(3);
      expect(queries().length).toBeLessThan(10);
    });
  });

  describe("companion group stats (APPF-23)", () => {
    const HOUSE = "BILLS-119hr1285";
    const SENATE = "BILLS-119s570";
    const GROUP_KEY = `COMPANIONS#${HOUSE}#${SENATE}`;
    const vote = (userId: string, feedback: string) => ({
      userId: { S: userId },
      feedback: { S: feedback },
      constituentVerified: { BOOL: false },
      effectiveWeight: { N: "1.0" },
    });
    // u1 voted on both (the House row wins); u3 and u4 only on the Senate bill; u5's House row is
    // not a vote, so its Senate vote counts.
    const votesByBill: Record<string, ReturnType<typeof vote>[]> = {
      [HOUSE]: [vote("u1", "Yea"), vote("u2", "Nay"), vote("u5", "Maybe")],
      [SENATE]: [vote("u1", "Nay"), vote("u3", "Yea"), vote("u4", "Abstain"), vote("u5", "Yea")],
    };
    const groupsItem = (enabled = true) => ({
      Item: {
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "5" },
        enabled: { BOOL: enabled },
        pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
      },
    });
    let send: jest.Mock;

    const load = (
      options: {
        groups?: () => unknown;
        statsWrite?: (input: FakeInput) => unknown;
        votes?: Record<string, Record<string, unknown>[]>;
      } = {},
    ) => {
      jest.resetModules();
      process.env.MANIFEST_TABLE_NAME = "BillsManifest";
      process.env.MANIFEST_PRIMARY_KEY = "pk";
      process.env.MANIFEST_GUID_LOOKUP_PK = "BILL_GUID";
      ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
      send.mockReset();
      send.mockImplementation(async (command: FakeCommand) => {
        const input = command.input ?? {};
        if (input.Key?.pk?.S === "BILL_COMPANION_GROUPS") return (options.groups ?? (() => groupsItem()))();
        if (input.IndexName) {
          return { Items: (options.votes ?? votesByBill)[input.ExpressionAttributeValues![":billId"].S!] ?? [] };
        }
        if (input.Key?.pk?.S === "BILL_GUID") {
          return { Item: { manifestSk: { S: `2026-01-01T00:00:00.000Z#${input.Key!.sk.S}` } } };
        }
        if (input.TableName === "BillStats") return options.statsWrite ? options.statsWrite(input) : {};
        if (input.UpdateExpression) return {};
        throw new Error(`Unexpected call: ${JSON.stringify(input)}`);
      });
      jest.spyOn(console, "log").mockImplementation(() => undefined);
      jest.spyOn(console, "warn").mockImplementation(() => undefined);
      return require("../handlers/billStatsAggregator").handler;
    };

    const statsPuts = (): FakeInput[] =>
      send.mock.calls
        .map(([command]: [FakeCommand]) => command.input)
        .filter((input: FakeInput) => input?.TableName === "BillStats");
    const storedPayload = (billId: string) =>
      JSON.parse(statsPuts().find((input: FakeInput) => input.Item!.billId.S === billId)!.Item!.payload.S!);
    const record = (eventName: string, billId: string, userId: string) => ({
      eventSource: "aws:dynamodb",
      eventName,
      dynamodb: {
        Keys: { userId: { S: userId }, billId: { S: billId } },
        NewImage: { ...vote(userId, "Yea"), billId: { S: billId } },
      },
    });

    afterEach(() => {
      delete process.env.MANIFEST_TABLE_NAME;
      delete process.env.MANIFEST_GUID_LOOKUP_PK;
      jest.restoreAllMocks();
    });

    it("recomputes the group once per batch, one vote per person, and never touches a manifest voteCount for it", async () => {
      const handler = load();

      const result = await handler({
        Records: [record("INSERT", HOUSE, "u1"), record("MODIFY", SENATE, "u3"), record("INSERT", HOUSE, "u2")],
      });

      expect(result).toEqual({ processedBillIds: [HOUSE, SENATE], updatedCount: 2, companionStatsKeys: [GROUP_KEY] });
      expect(statsPuts().map((input: FakeInput) => input.Item!.billId.S)).toEqual([HOUSE, SENATE, GROUP_KEY]);
      expect(storedPayload(GROUP_KEY)).toMatchObject({
        billId: GROUP_KEY,
        totals: { votes: 5, yea: 3, nay: 1, abstain: 1 },
      });
      // The members' own stats are unchanged by the group.
      expect(storedPayload(HOUSE).totals).toMatchObject({ votes: 2, yea: 1, nay: 1 });
      expect(storedPayload(SENATE).totals).toMatchObject({ votes: 4, yea: 2, nay: 1, abstain: 1 });

      const groupPut = statsPuts().find((input: FakeInput) => input.Item!.billId.S === GROUP_KEY);
      expect(groupPut!.ConditionExpression).toBe(
        "attribute_not_exists(#computedFrom) OR #computedFrom <= :computedFrom",
      );
      expect(groupPut!.Item!.computedFrom).toEqual({ S: expect.any(String) });

      const groupQueries = send.mock.calls
        .map(([command]: [FakeCommand]) => command.input)
        .filter((input: FakeInput) => input.IndexName && input.ExpressionAttributeNames!["#userId"]);
      expect(groupQueries.map((input: FakeInput) => input.ExpressionAttributeValues![":billId"].S)).toEqual([
        HOUSE,
        SENATE,
      ]);
      expect(groupQueries[0].ProjectionExpression).toBe(
        "feedback, constituentVerified, resolvedState, resolvedDistrict, reasons, adultEligible, legacyDismiss, #userId",
      );
      expect(groupQueries[0].ExpressionAttributeNames).toEqual({ "#billId": "billId", "#userId": "userId" });

      const manifestWrites = send.mock.calls
        .map(([command]: [FakeCommand]) => command.input)
        .filter((input: FakeInput) => input.UpdateExpression);
      expect(manifestWrites.map((input: FakeInput) => input.Key!.sk.S!.split("#")[1])).toEqual([HOUSE, SENATE]);
      const lookups = send.mock.calls
        .map(([command]: [FakeCommand]) => command.input)
        .filter((input: FakeInput) => input.Key?.pk?.S === "BILL_GUID");
      expect(lookups.map((input: FakeInput) => input.Key!.sk.S)).toEqual([HOUSE, SENATE]);
    });

    it("leaves 1.0 and 1.1 dismissals out of the members and the group, and lets a dismissal hide no vote (INT-11)", async () => {
      const dismissal = (userId: string) => ({ ...vote(userId, "Abstain"), legacyDismiss: { BOOL: true } });
      const handler = load({
        votes: {
          // u2 dismissed the House primary in Updates and voted Nay on the Senate bill; u3 and u5 only dismissed.
          [HOUSE]: [vote("u1", "Yea"), dismissal("u2"), dismissal("u3")],
          [SENATE]: [vote("u2", "Nay"), vote("u4", "Abstain"), dismissal("u5")],
        },
      });

      await handler({ Records: [record("MODIFY", HOUSE, "u2")] });

      expect(storedPayload(HOUSE).totals).toMatchObject({ votes: 1, yea: 1, nay: 0, abstain: 0 });
      expect(storedPayload(GROUP_KEY).totals).toMatchObject({ votes: 3, yea: 1, nay: 1, abstain: 1 });
    });

    it("recomputes the group for a vote on either member, a suffixed id or an API request", async () => {
      const handler = load();

      await handler({ Records: [record("INSERT", `${SENATE}is`, "u9")] });
      const response = await handler({
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
        queryStringParameters: { billId: HOUSE },
      });

      expect(JSON.parse(response.body)).toEqual({
        processedBillIds: [HOUSE],
        updatedCount: 1,
        companionStatsKeys: [GROUP_KEY],
      });
      expect(statsPuts().filter((input: FakeInput) => input.Item!.billId.S === GROUP_KEY)).toHaveLength(2);
    });

    it("recomputes no group while the published groups are turned off", async () => {
      const handler = load({ groups: () => groupsItem(false) });

      const result = await handler({ Records: [record("INSERT", HOUSE, "u1")] });

      expect(result).toEqual({ processedBillIds: [HOUSE], updatedCount: 1 });
      expect(statsPuts().map((input: FakeInput) => input.Item!.billId.S)).toEqual([HOUSE]);
    });

    it("still stores the bills' stats when the groups cannot be read", async () => {
      const handler = load({
        groups: () => {
          throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        },
      });

      const result = await handler({ Records: [record("INSERT", HOUSE, "u1")] });

      expect(result).toEqual({ processedBillIds: [HOUSE], updatedCount: 1 });
      expect(statsPuts().map((input: FakeInput) => input.Item!.billId.S)).toEqual([HOUSE]);
      const lines = (console.log as jest.Mock).mock.calls
        .concat((console.warn as jest.Mock).mock.calls)
        .map(([line]: [unknown]) => String(line));
      expect(lines.some((line) => line.includes('"CompanionGroupsReadFailed":1'))).toBe(true);
    });

    it("drops a superseded group recompute without failing the batch", async () => {
      const handler = load({
        statsWrite: (input) => {
          if (input.Item!.billId.S === GROUP_KEY) {
            throw Object.assign(new Error("The conditional request failed"), {
              name: "ConditionalCheckFailedException",
            });
          }
          return {};
        },
      });

      await expect(handler({ Records: [record("INSERT", HOUSE, "u1")] })).resolves.toMatchObject({
        companionStatsKeys: [GROUP_KEY],
      });
    });

    it("never recomputes a group's stats key named as a bill", async () => {
      const handler = load();

      const result = await handler({ billIds: [GROUP_KEY, HOUSE] });

      expect(result).toMatchObject({ processedBillIds: [HOUSE], updatedCount: 1 });
      const queried = send.mock.calls
        .map(([command]: [FakeCommand]) => command.input)
        .filter((input: FakeInput) => input.IndexName)
        .map((input: FakeInput) => input.ExpressionAttributeValues![":billId"].S);
      expect(queried).not.toContain(GROUP_KEY);
    });
  });
});

export {};
