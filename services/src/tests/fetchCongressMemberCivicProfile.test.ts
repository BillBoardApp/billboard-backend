import type { APIGatewayProxyResult } from "aws-lambda";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

process.env.TABLE_NAME = "CongressMemberVoteProfiles";
process.env.PARTITION_KEY = "bioguideId";
process.env.LEGISLATIVE_TABLE_NAME = "CongressMemberLegislativeProfiles";
process.env.LEGISLATIVE_PARTITION_KEY = "bioguideId";
delete process.env.MANIFEST_TABLE_NAME;

/** The parts of a DynamoDB command the isolated fake reads. */
interface FakeDynamoCommand {
  input: {
    KeyConditionExpression?: string;
    TableName?: string;
    Key?: { pk: { S: string }; sk: { S: string } };
  };
}

const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { handler } = require("../handlers/fetchCongressMemberCivicProfile");

describe("fetchCongressMemberCivicProfile handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await handler({ queryStringParameters: { bioguideId: "A000001" } });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ message: "Unauthorized" });
  });

  it("returns 400 when bioguideId is missing", async () => {
    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: {},
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Missing bioguideId" });
  });

  it("returns empty locked response when no rows are found", async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});
    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { bioguideId: "A000001" },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual(
      expect.objectContaining({
        axes: {},
        votesUsed: 0,
        totalVotesWithProfile: 0,
        sponsoredBillsUsed: 0,
        cosponsoredBillsUsed: 0,
        totalEvidenceUsed: 0,
        totalEvidenceWithProfile: 0,
        minEvidenceRequired: 20,
        isReady: false,
        evidence: [],
      }),
    );
    expect(body.diagnostics.weightedEvidenceUsed).toBe(0);
    expect(body.diagnostics.minAxesRequired).toBe(3);
    expect(body.diagnostics.axisCoverage.individualVsCommunity).toEqual({
      evidenceCount: 0,
      weightedEvidence: 0,
      isReady: false,
    });
  });

  it("computes weighted axis scores from votes, sponsorships, and cosponsorships", async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          billGuid: { S: "BILLS-119hr1ih" },
          votePosition: { S: "Yea" },
          votedAt: { S: "2026-02-03T00:00:00.000Z" },
          civicProfile: { M: { individualVsCommunity: { N: "0.8" }, localVsFederal: { N: "0.2" } } },
        },
        {
          billGuid: { S: "BILLS-119hr2ih" },
          votePosition: { S: "Nay" },
          votedAt: { S: "2026-02-02T00:00:00.000Z" },
          civicProfile: { M: { individualVsCommunity: { N: "0.6" }, localVsFederal: { N: "0.4" } } },
        },
        {
          billGuid: { S: "BILLS-119hr3ih" },
          votePosition: { S: "Present" },
          votedAt: { S: "2026-02-01T00:00:00.000Z" },
          civicProfile: { M: { individualVsCommunity: { N: "0.2" } } },
        },
      ],
    });
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          billGuid: { S: "BILLS-119s1is" },
          evidenceType: { S: "sponsor" },
          occurredAt: { S: "2026-02-04T00:00:00.000Z" },
          civicProfile: { M: { individualVsCommunity: { N: "1.0" }, localVsFederal: { N: "0.0" } } },
        },
        {
          billGuid: { S: "BILLS-119s2is" },
          evidenceType: { S: "cosponsor" },
          occurredAt: { S: "2026-02-01T12:00:00.000Z" },
          civicProfile: { M: { individualVsCommunity: { N: "0.2" }, localVsFederal: { N: "0.8" } } },
        },
      ],
    });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { bioguideId: "a000001" },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.votesUsed).toBe(2);
    expect(body.totalVotesWithProfile).toBe(2);
    expect(body.sponsoredBillsUsed).toBe(1);
    expect(body.cosponsoredBillsUsed).toBe(1);
    expect(body.totalEvidenceUsed).toBe(4);
    expect(body.totalEvidenceWithProfile).toBe(4);
    expect(body.minEvidenceRequired).toBe(20);
    expect(body.isReady).toBe(false);
    expect(body.axes.individualVsCommunity).toBeCloseTo(0.6645, 4);
    expect(body.axes.localVsFederal).toBeCloseTo(0.5129, 4);
    expect(body.diagnostics.weightedEvidenceUsed).toBeCloseTo(3.1, 6);
    expect(body.diagnostics.axesWithSufficientSignal).toBe(2);
    expect(body.evidence).toHaveLength(4);
    expect(body.evidence[0]).toEqual(
      expect.objectContaining({
        billGuid: "BILLS-119s1is",
        evidenceType: "sponsor",
        weight: 0.75,
      }),
    );
  });

  // UX-32 raised only the user's own floor (to 8 votes, fetchCivicProfile); a member's theme still needs 3.
  it("returns a member's theme at 3 weighted evidence, below the user's floor of 8", async () => {
    mockSend.mockResolvedValueOnce({
      Items: [1, 2, 3].map((day) => ({
        billGuid: { S: `BILLS-119hr${day}ih` },
        votePosition: { S: day === 2 ? "Nay" : "Yea" },
        votedAt: { S: `2026-02-0${day}T00:00:00.000Z` },
        civicProfile: { M: { privacyVsSecurity: { N: day === 2 ? "-0.5" : "0.5" } } },
      })),
    });
    mockSend.mockResolvedValueOnce({ Items: [] });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { bioguideId: "A000001" },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.axes).toEqual({ privacyVsSecurity: 0.75 });
    expect(body.diagnostics.minAxisWeightedEvidenceRequired).toBe(3);
    expect(body.diagnostics.axisCoverage.privacyVsSecurity).toEqual({
      evidenceCount: 3,
      weightedEvidence: 3,
      isReady: true,
    });
  });

  it("caps computation to the latest 100 qualifying evidence rows", async () => {
    const items: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 110; i += 1) {
      const day = String((i % 28) + 1).padStart(2, "0");
      items.push({
        billGuid: { S: `BILLS-119hr${i}ih` },
        votePosition: { S: "Yea" },
        votedAt: { S: `2026-02-${day}T00:00:00.000Z` },
        civicProfile: {
          M: {
            individualVsCommunity: { N: "1" },
            localVsFederal: { N: "1" },
            freeMarketVsRegulated: { N: "1" },
          },
        },
      });
    }
    mockSend.mockResolvedValueOnce({ Items: items });
    mockSend.mockResolvedValueOnce({ Items: [] });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { bioguideId: "A000001" },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.votesUsed).toBe(100);
    expect(body.totalVotesWithProfile).toBe(110);
    expect(body.totalEvidenceUsed).toBe(100);
    expect(body.minEvidenceRequired).toBe(20);
    expect(body.isReady).toBe(true);
    expect(body.axes.individualVsCommunity).toBe(1);
    expect(body.diagnostics.axesWithSufficientSignal).toBe(3);
  });
  it("bounds concurrent bill title lookups to 10 (REL-17)", async () => {
    let isolatedHandler!: (event: unknown) => Promise<APIGatewayProxyResult>;
    let isolatedSend: jest.Mock = jest.fn();
    process.env.MANIFEST_TABLE_NAME = "BillsManifest";
    try {
      jest.isolateModules(() => {
        isolatedSend = jest.requireMock("@aws-sdk/client-dynamodb").__mockSend;
        isolatedHandler = require("../handlers/fetchCongressMemberCivicProfile").handler;
      });
    } finally {
      delete process.env.MANIFEST_TABLE_NAME;
    }

    const rows = Array.from({ length: 12 }, (_, i) => ({
      billGuid: { S: `BILLS-119hr${i + 1}` },
      evidenceType: { S: "sponsor" },
      occurredAt: { S: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` },
      civicProfile: { M: { individualVsCommunity: { N: "0.5" } } },
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    let titleLookups = 0;
    isolatedSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      if (cmd.input.KeyConditionExpression) {
        return cmd.input.TableName === "CongressMemberLegislativeProfiles" ? { Items: rows } : {};
      }
      titleLookups += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (cmd.input.Key?.pk.S === "BILL_GUID") return { Item: { manifestSk: { S: `sk#${cmd.input.Key.sk.S}` } } };
      return { Item: { title: { S: `Title for ${cmd.input.Key?.sk.S}` } } };
    });

    const response = await isolatedHandler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { bioguideId: "A000001" },
    });

    expect(response.statusCode).toBe(200);
    expect(titleLookups).toBe(24);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(10);
    const titled = JSON.parse(response.body).evidence.filter((e: { title?: unknown }) => typeof e.title === "string");
    expect(titled.length).toBeGreaterThan(0);
    expect(titled[0].title).toMatch(/^Title for sk#BILLS-119hr/);
  });
});

export {};
