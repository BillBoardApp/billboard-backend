process.env.BUCKET_NAME = "test-bucket"; // Set env vars before imports
process.env.STATS_TABLE_NAME = "congress-member-stats-table";
process.env.STATS_PRIMARY_KEY = "bioguideId";
import { handler } from "../handlers/fetchProcessedCongressMembers";
import { noSuchKeyError } from "./fixtures/awsErrors";
import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { jsonReadable } from "./fixtures/streams";
import { applyTestEnv } from "./fixtures/env";

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  const mockSend = jest.fn();
  return {
    ...actual,
    S3Client: jest.fn(() => ({
      send: mockSend,
    })),
    __mockSend: mockSend,
  };
});

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({
      send: mockSend,
    })),
    GetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
    __mockSend: mockSend,
  };
});

describe("fetchProcessedCongressMembers handler", () => {
  const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-s3");
  const { __mockSend: mockDdbSend } = jest.requireMock("@aws-sdk/client-dynamodb");

  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    mockSend.mockReset();
    mockDdbSend.mockReset();
    restoreEnv?.();
    restoreEnv = applyTestEnv({
      BUCKET_NAME: "test-bucket",
      STATS_TABLE_NAME: "congress-member-stats-table",
      STATS_PRIMARY_KEY: "bioguideId",
    });
  });

  afterEach(() => {
    restoreEnv?.();
  });

  it("should return 400 if bioguideId is missing", async () => {
    const event = { queryStringParameters: {} };

    const result = await handler(asApiGatewayEvent(event));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Missing bioguideId" });
  });
  it.each([["A00001"], ["AB000001"], ["A0000011"], ["../A000001"], ["A000001.json"], ["1000001"]])(
    "returns 400 without touching S3 or DynamoDB for bioguideId %p",
    async (bioguideId) => {
      const result = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId } }));

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ error: "Invalid bioguideId" });
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockDdbSend).not.toHaveBeenCalled();
    },
  );

  it("normalizes a lowercase, padded bioguideId before using it as a key", async () => {
    mockSend.mockResolvedValueOnce({ Body: jsonReadable({ member: { bioguideId: "A000001" } }) });
    mockDdbSend.mockResolvedValueOnce({});

    const result = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: " a000001 " } }));

    expect(result.statusCode).toBe(200);
    expect(mockSend.mock.calls[0][0].input.Key).toBe("processed-congress-members/A000001.json");
    expect(mockDdbSend.mock.calls[0][0].input.Key).toEqual({ bioguideId: { S: "A000001" } });
  });

  it("should return 200 with the member JSON if found", async () => {
    const payload = { member: { bioguideId: "A000001", name: "Test" } };

    mockSend.mockResolvedValueOnce({ Body: jsonReadable(payload) });
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        billsSponsored: { N: "2" },
        billsSupported: { N: "5" },
      },
    });

    const event = {
      queryStringParameters: {
        bioguideId: "A000001",
      },
    };

    const result = await handler(asApiGatewayEvent(event));

    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(result.body)).toEqual({
      member: {
        bioguideId: "A000001",
        name: "Test",
        currentCongressBillsSupportedCount: 5,
        trackedSponsoredCount: 2,
        trackedSupportedCount: 5,
      },
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "test-bucket",
          Key: "processed-congress-members/A000001.json",
        }),
      }),
    );
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "congress-member-stats-table",
          Key: {
            bioguideId: { S: "A000001" },
          },
          ProjectionExpression: "billsSponsored, billsSupported",
        }),
      }),
    );
  });

  // REL-46, project decision D8: no stats row means no tracked 119th bill (every member new in the 120th Congress). Apps
  // 1.1 and 1.2 hide "Tracked by Billboard" when the member and its manifest entry have none of the three counts.
  it("omits all three counts, and drops any the stored object carries, when the member has no stats row", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const stale = { currentCongressBillsSupportedCount: 0, trackedSponsoredCount: 0, trackedSupportedCount: 0 };
    mockSend
      .mockResolvedValueOnce({ Body: jsonReadable({ member: { bioguideId: "A000001", name: "Test" } }) })
      .mockResolvedValueOnce({ Body: jsonReadable({ member: { bioguideId: "A000001", name: "Test", ...stale } }) })
      .mockResolvedValueOnce({ Body: jsonReadable({ bioguideId: "A000001", name: "Test", ...stale }) });
    mockDdbSend.mockResolvedValue({});

    const plain = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));
    const enveloped = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));
    const bare = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));

    expect(plain.statusCode).toBe(200);
    expect(JSON.parse(plain.body)).toEqual({ member: { bioguideId: "A000001", name: "Test" } });
    expect(JSON.parse(enveloped.body)).toEqual({ member: { bioguideId: "A000001", name: "Test" } });
    expect(JSON.parse(bare.body)).toEqual({ bioguideId: "A000001", name: "Test" });
    // A missing row is not a failed read.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    ["zeros", { billsSponsored: { N: "0" }, billsSupported: { N: "0" } }, 0, 0],
    ["one counter only (the other has never been added to)", { billsSponsored: { N: "1" } }, 1, 0],
  ])("keeps the counts of a member whose stats row has %s", async (_label, item, sponsored, supported) => {
    mockSend.mockResolvedValueOnce({ Body: jsonReadable({ member: { bioguideId: "A000001", name: "Test" } }) });
    mockDdbSend.mockResolvedValueOnce({ Item: item });

    const result = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      member: {
        bioguideId: "A000001",
        name: "Test",
        currentCongressBillsSupportedCount: supported,
        trackedSponsoredCount: sponsored,
        trackedSupportedCount: supported,
      },
    });
  });

  it("adds the counts at the root of a bare (pre-envelope) member object", async () => {
    mockSend.mockResolvedValueOnce({ Body: jsonReadable({ bioguideId: "A000001", name: "Test" }) });
    mockDdbSend.mockResolvedValueOnce({ Item: { billsSponsored: { N: "3" }, billsSupported: { N: "8" } } });

    const result = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));

    expect(JSON.parse(result.body)).toEqual({
      bioguideId: "A000001",
      name: "Test",
      currentCongressBillsSupportedCount: 8,
      trackedSponsoredCount: 3,
      trackedSupportedCount: 8,
    });
  });

  // REL-52 (feature review S12): a supported count of 0 made apps 1.1 and 1.2 show "Supported in 119th Congress 0"
  // when the manifest had no tracked counts either. Both decode the member without it.
  it("omits all three counts, but still returns the member, when the stats read fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSend.mockResolvedValueOnce({ Body: jsonReadable({ member: { bioguideId: "A000001", name: "Test" } }) });
    mockDdbSend.mockRejectedValueOnce(new Error("ProvisionedThroughputExceededException"));

    const result = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toEqual({ member: { bioguideId: "A000001", name: "Test" } });
    expect(body.member).not.toHaveProperty("currentCongressBillsSupportedCount");
    expect(warn).toHaveBeenCalledWith("Failed to load current-Congress member stats", expect.anything());
    warn.mockRestore();
  });

  it("drops counts a stored object carries when the stats read fails, from the envelope and from a bare member", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const stale = { currentCongressBillsSupportedCount: 0, trackedSponsoredCount: 4, trackedSupportedCount: 0 };
    mockSend
      .mockResolvedValueOnce({ Body: jsonReadable({ member: { bioguideId: "A000001", name: "Test", ...stale } }) })
      .mockResolvedValueOnce({ Body: jsonReadable({ bioguideId: "A000001", name: "Test", ...stale }) });
    mockDdbSend.mockRejectedValue(new Error("AccessDeniedException"));

    const enveloped = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));
    const bare = await handler(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));

    expect(JSON.parse(enveloped.body)).toEqual({ member: { bioguideId: "A000001", name: "Test" } });
    expect(JSON.parse(bare.body)).toEqual({ bioguideId: "A000001", name: "Test" });
    warn.mockRestore();
  });

  it("omits the tracked counts when no stats table is configured", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv({ BUCKET_NAME: "test-bucket", STATS_TABLE_NAME: undefined });
    // A fresh module registry re-reads STATS_TABLE_NAME and builds fresh client mocks.
    let isolatedHandler: typeof handler | undefined;
    let isolatedS3Send: jest.Mock | undefined;
    let isolatedDdbSend: jest.Mock | undefined;
    jest.isolateModules(() => {
      isolatedHandler = require("../handlers/fetchProcessedCongressMembers").handler;
      isolatedS3Send = jest.requireMock("@aws-sdk/client-s3").__mockSend;
      isolatedDdbSend = jest.requireMock("@aws-sdk/client-dynamodb").__mockSend;
    });
    isolatedS3Send!.mockResolvedValueOnce({ Body: jsonReadable({ member: { bioguideId: "A000001", name: "Test" } }) });

    const result = await isolatedHandler!(asApiGatewayEvent({ queryStringParameters: { bioguideId: "A000001" } }));

    expect(JSON.parse(result.body)).toEqual({ member: { bioguideId: "A000001", name: "Test" } });
    expect(isolatedDdbSend).not.toHaveBeenCalled();
  });

  it("should return 404 if the member is not found", async () => {
    mockSend.mockRejectedValueOnce(noSuchKeyError());

    const event = {
      queryStringParameters: {
        bioguideId: "A000001",
      },
    };

    const result = await handler(asApiGatewayEvent(event));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: "Member not found" });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

export {};
