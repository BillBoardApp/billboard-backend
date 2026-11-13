import { applyTestEnv } from "./fixtures/env";

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
