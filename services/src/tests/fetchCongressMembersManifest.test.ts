process.env.TABLE_NAME = "test-table"; // set env vars before imports
process.env.STATS_TABLE_NAME = "congress-member-stats-table";
process.env.STATS_PRIMARY_KEY = "bioguideId";
import { handler } from "../handlers/fetchCongressMembersManifest";
import type { ScanCommandInput } from "@aws-sdk/client-dynamodb";
import { applyTestEnv } from "./fixtures/env";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    ScanCommand: jest.fn().mockImplementation((input) => ({ __type: "ScanCommand", input })),
    QueryCommand: jest.fn().mockImplementation((input) => ({ __type: "QueryCommand", input })),
    BatchGetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "BatchGetItemCommand", input })),
  };
});

const COUNT_FIELDS = ["currentCongressBillsSupportedCount", "trackedSponsoredCount", "trackedSupportedCount"] as const;

interface ManifestMember {
  bioguideId: string;
  currentCongressBillsSupportedCount?: number;
  trackedSponsoredCount?: number;
  trackedSupportedCount?: number;
}

describe("fetchCongressMembersManifest handler", () => {
  const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");

  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    mockSend.mockReset();
    restoreEnv?.();
    restoreEnv = applyTestEnv({
      TABLE_NAME: "test-table",
      STATS_TABLE_NAME: "congress-member-stats-table",
      STATS_PRIMARY_KEY: "bioguideId",
    });
  });

  afterEach(() => {
    restoreEnv?.();
  });

  it("returns the manifest when present", async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          {
            bioguideId: { S: "A1" },
            name: { S: "Alice" },
            chamber: { S: "House" },
            state: { S: "CA" },
            party: { S: "D" },
            district: { S: "01" },
            depictionImageUrl: { NULL: true },
            updatedAt: { S: "2026-01-01T00:00:00.000Z" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Responses: {
          "congress-member-stats-table": [
            {
              bioguideId: { S: "A1" },
              billsSponsored: { N: "2" },
              billsSupported: { N: "4" },
            },
          ],
        },
      });

    const res = await handler();

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.members[0].bioguideId).toBe("A1");
    expect(body.members[0].currentCongressBillsSupportedCount).toBe(4);
    expect(body.members[0].trackedSponsoredCount).toBe(2);
    expect(body.members[0].trackedSupportedCount).toBe(4);
    const statsRead = mockSend.mock.calls[1][0].input.RequestItems["congress-member-stats-table"];
    expect(statsRead.ProjectionExpression).toBe("#pk, billsSponsored, billsSupported");
  });

  it("returns empty manifest when no items exist", async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const res = await handler();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.members).toEqual([]);
  });

  it("filters by updatedAfter when provided", async () => {
    mockSend
      .mockImplementationOnce((cmd: { input?: Partial<ScanCommandInput> }) => {
        const input: Partial<ScanCommandInput> = cmd.input || {};
        expect(input.FilterExpression).toBe("#updatedAt > :updatedAfter");
        expect(input.ExpressionAttributeValues?.[":updatedAfter"]?.S).toBe("2026-01-15T00:00:00.000Z");
        return {
          Items: [
            {
              bioguideId: { S: "A2" },
              name: { S: "Bob" },
              chamber: { S: "Senate" },
              state: { S: "NY" },
              party: { S: "R" },
              district: { NULL: true },
              depictionImageUrl: { NULL: true },
              updatedAt: { S: "2026-02-01T00:00:00.000Z" },
            },
          ],
        };
      })
      .mockResolvedValueOnce({
        Responses: {
          "congress-member-stats-table": [],
        },
      });

    const res = await handler({ queryStringParameters: { updatedAfter: "2026-01-15T00:00:00.000Z" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.members[0].updatedAt).toBe("2026-02-01T00:00:00.000Z");
    // No stats row: no tracked counts (REL-46, D8).
    expect(body.members[0]).not.toHaveProperty("currentCongressBillsSupportedCount");
    expect(body.members[0]).not.toHaveProperty("trackedSponsoredCount");
    expect(body.members[0]).not.toHaveProperty("trackedSupportedCount");
  });

  const manifestItem = (bioguideId: string) => ({
    bioguideId: { S: bioguideId },
    name: { S: `Member ${bioguideId}` },
    chamber: { S: "House" },
    state: { S: "CA" },
    party: { S: "D" },
    district: { S: "01" },
    depictionImageUrl: { NULL: true },
    updatedAt: { S: "2026-01-01T00:00:00.000Z" },
  });

  const statsItem = (bioguideId: string, sponsored: string, supported: string) => ({
    bioguideId: { S: bioguideId },
    billsSponsored: { N: sponsored },
    billsSupported: { N: supported },
  });

  // REL-46, project decision D8: no stats row means no tracked 119th bill (every member new in the 120th Congress), so the
  // member gets none of the three counts and apps 1.1 and 1.2 hide "Tracked by Billboard". A row keeps its counts.
  it("omits the counts of a member with no stats row and keeps a row's counts, zeros included", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSend
      .mockResolvedValueOnce({
        Items: [manifestItem("A1"), manifestItem("B2"), manifestItem("C3"), manifestItem("D4")],
      })
      .mockResolvedValueOnce({
        Responses: {
          "congress-member-stats-table": [
            statsItem("A1", "0", "0"),
            statsItem("C3", "2", "6"),
            { bioguideId: { S: "D4" }, billsSupported: { N: "1" } },
          ],
        },
      });

    const res = await handler();

    expect(res.statusCode).toBe(200);
    const members: ManifestMember[] = JSON.parse(res.body).members;
    const countsOf = (member: ManifestMember) => [
      member.bioguideId,
      Object.fromEntries(COUNT_FIELDS.filter((field) => field in member).map((field) => [field, member[field]])),
    ];
    expect(members.map(countsOf)).toEqual([
      ["A1", { currentCongressBillsSupportedCount: 0, trackedSponsoredCount: 0, trackedSupportedCount: 0 }],
      ["B2", {}],
      ["C3", { currentCongressBillsSupportedCount: 6, trackedSponsoredCount: 2, trackedSupportedCount: 6 }],
      ["D4", { currentCongressBillsSupportedCount: 1, trackedSponsoredCount: 0, trackedSupportedCount: 1 }],
    ]);
    // A missing row is not a failed read.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("retries stats keys DynamoDB returns as unprocessed", async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [manifestItem("A1"), manifestItem("B2")] })
      .mockResolvedValueOnce({
        Responses: { "congress-member-stats-table": [statsItem("A1", "1", "3")] },
        UnprocessedKeys: { "congress-member-stats-table": { Keys: [{ bioguideId: { S: "B2" } }] } },
      })
      .mockResolvedValueOnce({
        Responses: { "congress-member-stats-table": [statsItem("B2", "5", "7")] },
      });

    const res = await handler();

    const body = JSON.parse(res.body);
    expect(
      body.members.map((m: ManifestMember) => [m.bioguideId, m.trackedSponsoredCount, m.trackedSupportedCount]),
    ).toEqual([
      ["A1", 1, 3],
      ["B2", 5, 7],
    ]);
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockSend.mock.calls[2][0].input.RequestItems["congress-member-stats-table"].Keys).toEqual([
      { bioguideId: { S: "B2" } },
    ]);
  });

  it("omits tracked counts for members whose stats stay unprocessed, keeping the ones it read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const unprocessed = { "congress-member-stats-table": { Keys: [{ bioguideId: { S: "B2" } }] } };
    mockSend
      .mockResolvedValueOnce({ Items: [manifestItem("A1"), manifestItem("B2")] })
      .mockResolvedValueOnce({
        Responses: { "congress-member-stats-table": [statsItem("A1", "1", "3")] },
        UnprocessedKeys: unprocessed,
      })
      .mockResolvedValue({ Responses: { "congress-member-stats-table": [] }, UnprocessedKeys: unprocessed });

    const res = await handler();

    const [a1, b2] = JSON.parse(res.body).members;
    expect(a1).toMatchObject({ bioguideId: "A1", trackedSponsoredCount: 1, trackedSupportedCount: 3 });
    expect(b2.bioguideId).toBe("B2");
    expect(b2).not.toHaveProperty("currentCongressBillsSupportedCount");
    expect(b2).not.toHaveProperty("trackedSponsoredCount");
    expect(b2).not.toHaveProperty("trackedSupportedCount");
    // One manifest query, then four stats attempts.
    expect(mockSend).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledWith("Member stats reads still unprocessed after retries", { unprocessed: 1 });
    warn.mockRestore();
  });

  it("omits all three counts when the stats read fails (REL-52: no supported count of 0)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSend
      .mockResolvedValueOnce({ Items: [manifestItem("A1")] })
      .mockRejectedValueOnce(new Error("AccessDeniedException"));

    const res = await handler();

    expect(res.statusCode).toBe(200);
    const [a1] = JSON.parse(res.body).members;
    expect(a1).not.toHaveProperty("currentCongressBillsSupportedCount");
    expect(a1).not.toHaveProperty("trackedSponsoredCount");
    expect(a1).not.toHaveProperty("trackedSupportedCount");
    warn.mockRestore();
  });
});

export {};
