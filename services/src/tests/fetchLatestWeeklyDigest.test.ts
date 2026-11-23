import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    GetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "GetItemCommand", input })),
    PutItemCommand: jest.fn().mockImplementation((input) => ({ __type: "PutItemCommand", input })),
  };
});

describe("fetchLatestWeeklyDigest handler", () => {
  let mockDynamoSend: jest.Mock;
  let restoreEnv: (() => void) | undefined;

  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
  };

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();

    ({ __mockSend: mockDynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb"));
    mockDynamoSend.mockReset();

    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        TABLE_NAME: "weekly-digests-table",
        PARTITION_KEY: "userId",
        SORT_KEY: "publishedAt",
        CANONICAL_PUBLISH_TIMEZONE: "America/New_York",
        CANONICAL_PUBLISH_HOUR: "10",
        CANONICAL_PUBLISH_MINUTE: "0",
      },
      { replace: true },
    );
  });

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
    jest.useRealTimers();
  });

  test("returns unauthorized when auth claims are missing", async () => {
    const { handler } = require("../handlers/fetchLatestWeeklyDigest");

    const response = await handler({});

    expect(response.statusCode).toBe(401);
  });

  test("returns the stored digest for the latest eligible publication window", async () => {
    jest.setSystemTime(new Date("2026-03-22T14:00:00.000Z"));

    const storedDigest = {
      id: "2026-03-22T14:00:00.000Z",
      title: "Your Week in Congress | Mar 15-21, 2026",
      summary: "One bill needs your attention.",
      weekStart: "2026-03-15T04:00:00.000Z",
      weekEnd: "2026-03-21T04:00:00.000Z",
      publishedAt: "2026-03-22T14:00:00.000Z",
      isRead: false,
      stats: [],
      sections: [],
    };

    mockDynamoSend.mockResolvedValue({
      Item: {
        payload: { S: JSON.stringify(storedDigest) },
      },
    });

    const { handler } = require("../handlers/fetchLatestWeeklyDigest");
    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(storedDigest);
    expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    expect(mockDynamoSend.mock.calls[0][0].input).toMatchObject({
      TableName: "weekly-digests-table",
      Key: {
        userId: { S: "user-1" },
        publishedAt: { S: "2026-03-22T14:00:00.000Z" },
      },
    });
  });

  // UX-28, decision D7 (a): the brief fetch app 1.3 makes after a tap on the Sunday push carries ?trigger=push, and
  // only that fetch adds 1 to WeeklyBriefOpenedFromPush. The metric line holds no user id; the response is the same.
  describe("the push-open count (?trigger=push)", () => {
    const opens = () => logLines(console.log).filter((line) => line._aws && "WeeklyBriefOpenedFromPush" in line);

    beforeEach(() => {
      jest.spyOn(console, "log").mockImplementation();
      jest.setSystemTime(new Date("2026-03-22T15:00:00.000Z"));
      mockDynamoSend.mockResolvedValue({});
      delete process.env.AWS_LAMBDA_LOG_FORMAT;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test("counts a fetch with trigger=push, without the caller's id", async () => {
      const { handler } = require("../handlers/fetchLatestWeeklyDigest");

      const response = await handler({ ...event, queryStringParameters: { trigger: "push" } });

      expect(response.statusCode).toBe(204);
      expect(opens()).toHaveLength(1);
      expect(opens()[0]).toEqual(
        expect.objectContaining({
          WeeklyBriefOpenedFromPush: 1,
          _aws: expect.objectContaining({
            CloudWatchMetrics: [
              {
                Namespace: "BillBoard/WeeklyDigest",
                Dimensions: [[]],
                Metrics: [{ Name: "WeeklyBriefOpenedFromPush", Unit: "Count" }],
              },
            ],
          }),
        }),
      );
      expect(JSON.stringify(opens())).not.toContain("user-1");
    });

    test.each([undefined, { trigger: "updates" }, { other: "push" }])(
      "counts nothing for the query %p",
      async (queryStringParameters) => {
        const { handler } = require("../handlers/fetchLatestWeeklyDigest");

        await handler({ ...event, queryStringParameters });

        expect(opens()).toEqual([]);
      },
    );

    test("counts nothing for a caller who is not signed in", async () => {
      const { handler } = require("../handlers/fetchLatestWeeklyDigest");

      const response = await handler({ queryStringParameters: { trigger: "push" } });

      expect(response.statusCode).toBe(401);
      expect(opens()).toEqual([]);
    });
  });

  // UX-41 concept 4: the snapshot is served as stored, so app 1.3 gets Your bills this week, and 1.1 and 1.2 ignore it.
  test("serves Your bills this week as stored, and never the push claim", async () => {
    jest.setSystemTime(new Date("2026-03-22T14:00:00.000Z"));
    const yourBills = [
      {
        id: "bill|BILLS-119hr22ih",
        kind: "bill",
        title: "Tracked Passed Bill",
        summary: "Mar 19: Passed the House.",
        reason: "You voted on this",
        accent: "movement",
        billState: "passed",
        billGuid: "BILLS-119hr22ih",
      },
    ];
    const storedDigest = {
      id: "2026-03-22T14:00:00.000Z",
      title: "Your Week in Congress | Mar 15-21, 2026",
      summary: "One bill moved this week.",
      weekStart: "2026-03-15T04:00:00.000Z",
      weekEnd: "2026-03-21T04:00:00.000Z",
      publishedAt: "2026-03-22T14:00:00.000Z",
      isRead: false,
      stats: [],
      sections: [],
      yourBills,
    };
    mockDynamoSend.mockResolvedValue({
      Item: { payload: { S: JSON.stringify(storedDigest) }, pushClaimedAt: { S: "2026-03-22T15:30:00.000Z" } },
    });

    const { handler } = require("../handlers/fetchLatestWeeklyDigest");
    const response = await handler(event);

    expect(JSON.parse(response.body)).toEqual(storedDigest);
    expect(response.body).not.toContain("pushClaimedAt");
    expect(mockDynamoSend.mock.calls[0][0].input.ProjectionExpression).toBe("payload");
  });

  test("uses the previous release window before Sunday 10am Eastern", async () => {
    jest.setSystemTime(new Date("2026-03-22T13:59:00.000Z"));
    mockDynamoSend.mockResolvedValue({});

    const { handler } = require("../handlers/fetchLatestWeeklyDigest");
    const response = await handler(event);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(mockDynamoSend.mock.calls[0][0].input).toMatchObject({
      Key: {
        userId: { S: "user-1" },
        publishedAt: { S: "2026-03-15T14:00:00.000Z" },
      },
    });
  });
});
