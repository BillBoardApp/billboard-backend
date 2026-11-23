import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyResult } from "aws-lambda";

import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { applyTestEnv } from "./fixtures/env";

const mockSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    QueryCommand: jest.fn().mockImplementation((input) => ({ kind: "Query", input })),
    GetItemCommand: jest.fn().mockImplementation((input) => ({ kind: "GetItem", input })),
    BatchGetItemCommand: jest.fn().mockImplementation((input) => ({ kind: "BatchGetItem", input })),
  };
});

type Item = Record<string, AttributeValue>;
interface Command {
  kind: "Query" | "GetItem" | "BatchGetItem";
  input: {
    TableName?: string;
    Limit?: number;
    ScanIndexForward?: boolean;
    ExclusiveStartKey?: Item;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, AttributeValue>;
    RequestItems?: Record<string, { Keys: Item[] }>;
  };
}

const originalEnv = { ...process.env };
let restoreEnv: (() => void) | undefined;
let handler: (event: unknown) => Promise<APIGatewayProxyResult>;

const IN_THE_120TH = Date.parse("2027-01-20T12:00:00.000Z");

/** One member's vote rows, newest first as the table sorts them, and the tables the handler reads. */
const voteRow = (votedAt: string, guid: string, position: string, extra: Item = {}): Item => ({
  bioguideId: { S: "A000001" },
  recordKey: { S: `${votedAt}#${guid}` },
  billGuid: { S: guid },
  chamber: { S: "House" },
  position: { S: position },
  votedAt: { S: votedAt },
  ...extra,
});

const VOTES: Item[] = [
  voteRow("2027-01-15T00:00:00.000Z", "BILLS-120hr5", "Yea", { actionText: { S: "On passage Passed: 300 - 120" } }),
  voteRow("2026-12-10T00:00:00.000Z", "BILLS-119hr900", "Not Voting"),
  voteRow("2026-11-02T00:00:00.000Z", "BILLS-119hr812", "Present"),
  voteRow("2026-10-01T00:00:00.000Z", "BILLS-119hr77", "Nay", { actionText: { S: "On motion to recommit Failed" } }),
];

const MANIFEST: Record<string, Item> = {
  "BILLS-120hr5": {
    title: { S: "Extends school meals" },
    billStatus: { S: "Passed" },
    updatedAt: { S: "2027-01-15T18:00:00.000Z" },
  },
  "BILLS-119hr812": {
    title: { S: "Names a post office" },
    billStatus: { S: "Finalized" },
    updatedAt: { S: "2026-11-20T12:00:00.000Z" },
  },
  "BILLS-119hr77": {
    title: { S: "Changes the rules for small farms" },
    billStatus: { S: "Passed" },
    vetoed: { BOOL: true },
    updatedAt: { S: "2026-10-30T12:00:00.000Z" },
  },
  "BILLS-119hr10": {
    title: { S: "Older sponsored bill" },
    billStatus: { S: "New" },
    updatedAt: { S: "2025-03-01T00:00:00.000Z" },
  },
  "BILLS-119hr11": {
    title: { S: "Newer sponsored bill" },
    billStatus: { S: "Bogus" },
    updatedAt: { S: "2026-06-01T00:00:00.000Z" },
  },
  "BILLS-120hr2": {
    title: { S: "A 120th bill" },
    billStatus: { S: "New" },
    updatedAt: { S: "2027-01-10T00:00:00.000Z" },
  },
};

const STATS: Item = {
  bioguideId: { S: "A000001" },
  sponsoredBillGuids: { SS: ["BILLS-119hr10", "BILLS-119hr11", "BILLS-119hr404"] },
  sponsoredBillGuids120: { SS: ["BILLS-120hr2"] },
};

const fakeTables = (options: { votes?: Item[]; stats?: Item | null; manifestFails?: boolean } = {}) => {
  const votes = options.votes ?? VOTES;
  mockSend.mockImplementation(async (command: Command) => {
    const input = command.input;
    if (command.kind === "Query") {
      const after = input.ExclusiveStartKey?.recordKey?.S;
      const start = after ? votes.findIndex((row) => row.recordKey.S === after) + 1 : 0;
      return { Items: votes.slice(start, start + (input.Limit ?? votes.length)) };
    }
    if (command.kind === "GetItem") return options.stats === null ? {} : { Item: options.stats ?? STATS };
    if (options.manifestFails) throw new Error("ProvisionedThroughputExceededException");
    const keys = input.RequestItems!.BillsManifest.Keys;
    const items = keys.flatMap((key) => {
      const pk = key.pk.S;
      const sk = key.sk.S!;
      if (pk === "BILL_GUID") return MANIFEST[sk] ? [{ sk: { S: sk }, manifestSk: { S: `2026#${sk}` } }] : [];
      const guid = sk.split("#")[1];
      return MANIFEST[guid] ? [{ sk: { S: sk }, ...MANIFEST[guid] }] : [];
    });
    return { Responses: { BillsManifest: items } };
  });
};

const request = (query: Record<string, string> | undefined, signedIn = true) =>
  handler(
    asApiGatewayEvent({
      queryStringParameters: query,
      requestContext: signedIn ? { authorizer: { claims: { sub: "user-1" } } } : {},
    }),
  );
const body = (result: APIGatewayProxyResult) => JSON.parse(result.body);
const commands = (kind: Command["kind"]) =>
  mockSend.mock.calls.map((call) => call[0] as Command).filter((command) => command.kind === kind);

beforeEach(() => {
  jest.resetModules();
  mockSend.mockReset();
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      VOTE_RECORD_TABLE_NAME: "CongressMemberVoteRecord",
      VOTE_RECORD_PRIMARY_KEY: "bioguideId",
      VOTE_RECORD_SORT_KEY: "recordKey",
      STATS_TABLE_NAME: "CongressMembersStats",
      STATS_PRIMARY_KEY: "bioguideId",
      MANIFEST_TABLE_NAME: "BillsManifest",
      MANIFEST_PRIMARY_KEY: "pk",
      MANIFEST_SORT_KEY: "sk",
      MANIFEST_PK_VALUE: "BILL",
      MANIFEST_GUID_LOOKUP_PK: "BILL_GUID",
    },
    { replace: true, base: originalEnv },
  );
  jest.spyOn(Date, "now").mockReturnValue(IN_THE_120TH);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  handler = require("../handlers/fetchCongressMemberRecord").handler;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  restoreEnv?.();
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("fetchCongressMemberRecord (UX-39d)", () => {
  it("serves the votes newest first with every position, titles from the manifest, and the sponsored bills", async () => {
    fakeTables();

    const result = await request({ bioguideId: " a000001 " });

    expect(result.statusCode).toBe(200);
    expect(body(result)).toEqual({
      bioguideId: "A000001",
      votes: [
        {
          billGuid: "BILLS-120hr5",
          congress: "120",
          billType: "hr",
          billNumber: "5",
          title: "Extends school meals",
          chamber: "House",
          position: "Yea",
          votedAt: "2027-01-15T00:00:00.000Z",
          actionText: "On passage Passed: 300 - 120",
        },
        // No manifest row yet: the vote is served without a title.
        {
          billGuid: "BILLS-119hr900",
          congress: "119",
          billType: "hr",
          billNumber: "900",
          chamber: "House",
          position: "Not Voting",
          votedAt: "2026-12-10T00:00:00.000Z",
        },
        {
          billGuid: "BILLS-119hr812",
          congress: "119",
          billType: "hr",
          billNumber: "812",
          title: "Names a post office",
          chamber: "House",
          position: "Present",
          votedAt: "2026-11-02T00:00:00.000Z",
        },
        {
          billGuid: "BILLS-119hr77",
          congress: "119",
          billType: "hr",
          billNumber: "77",
          title: "Changes the rules for small farms",
          chamber: "House",
          position: "Nay",
          votedAt: "2026-10-01T00:00:00.000Z",
          actionText: "On motion to recommit Failed",
        },
      ],
      sponsoredBills: [
        {
          billGuid: "BILLS-120hr2",
          congress: "120",
          billType: "hr",
          billNumber: "2",
          title: "A 120th bill",
          billStatus: "New",
          updatedAt: "2027-01-10T00:00:00.000Z",
        },
        // An unknown status is left out rather than sent.
        {
          billGuid: "BILLS-119hr11",
          congress: "119",
          billType: "hr",
          billNumber: "11",
          title: "Newer sponsored bill",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          billGuid: "BILLS-119hr10",
          congress: "119",
          billType: "hr",
          billNumber: "10",
          title: "Older sponsored bill",
          billStatus: "New",
          updatedAt: "2025-03-01T00:00:00.000Z",
        },
        { billGuid: "BILLS-119hr404", congress: "119", billType: "hr", billNumber: "404" },
      ],
      sponsoredBillCount: 4,
    });
    const [query] = commands("Query");
    expect(query.input).toMatchObject({
      TableName: "CongressMemberVoteRecord",
      ScanIndexForward: false,
      Limit: 26,
      ExpressionAttributeValues: { ":pk": { S: "A000001" } },
    });
    expect(query.input.ExclusiveStartKey).toBeUndefined();
    // Each counted Congress's sponsored set, and only the sponsored ones (no cosponsored bill).
    expect(Object.values(commands("GetItem")[0].input.ExpressionAttributeNames!)).toEqual([
      "sponsoredBillGuids120",
      "sponsoredBillGuids",
    ]);
  });

  it("serves a vetoed bill as vetoed", async () => {
    fakeTables({ stats: { bioguideId: { S: "A000001" }, sponsoredBillGuids: { SS: ["BILLS-119hr77"] } } });

    const [bill] = body(await request({ bioguideId: "A000001" })).sponsoredBills;

    expect(bill).toMatchObject({ billGuid: "BILLS-119hr77", billStatus: "Passed", vetoed: true });
  });

  it("pages with a cursor that continues after the last vote served, and sends sponsoredBills on the first page only", async () => {
    fakeTables();

    const first = body(await request({ bioguideId: "A000001", limit: "2" }));
    expect(first.votes.map((vote: { billGuid: string }) => vote.billGuid)).toEqual(["BILLS-120hr5", "BILLS-119hr900"]);
    expect(Buffer.from(first.nextCursor, "base64url").toString()).toBe("2026-12-10T00:00:00.000Z#BILLS-119hr900");
    expect(first.sponsoredBills).toHaveLength(4);

    mockSend.mockClear();
    const second = body(await request({ bioguideId: "A000001", limit: "2", cursor: first.nextCursor }));
    expect(second.votes.map((vote: { billGuid: string }) => vote.billGuid)).toEqual([
      "BILLS-119hr812",
      "BILLS-119hr77",
    ]);
    // The last page says so: no cursor, so no empty page follows.
    expect(second).not.toHaveProperty("nextCursor");
    expect(second).not.toHaveProperty("sponsoredBills");
    expect(second).not.toHaveProperty("sponsoredBillCount");
    expect(commands("Query")[0].input.ExclusiveStartKey).toEqual({
      bioguideId: { S: "A000001" },
      recordKey: { S: "2026-12-10T00:00:00.000Z#BILLS-119hr900" },
    });
    expect(commands("GetItem")).toEqual([]);
  });

  it("answers an unknown member with an empty record, not a 404", async () => {
    fakeTables({ votes: [], stats: null });

    const result = await request({ bioguideId: "Z999999" });

    expect(result.statusCode).toBe(200);
    expect(body(result)).toEqual({ bioguideId: "Z999999", votes: [], sponsoredBills: [], sponsoredBillCount: 0 });
    expect(commands("BatchGetItem")).toEqual([]);
  });

  it("caps the sponsored bills at 250 and counts them all", async () => {
    const guids = Array.from({ length: 260 }, (_, index) => `BILLS-119hr${index + 1000}`);
    fakeTables({ votes: [], stats: { bioguideId: { S: "A000001" }, sponsoredBillGuids: { SS: guids } } });

    const record = body(await request({ bioguideId: "A000001" }));

    expect(record.sponsoredBills).toHaveLength(250);
    expect(record.sponsoredBillCount).toBe(260);
    // 260 lookups, in batches of at most 100 keys.
    expect(commands("BatchGetItem").map((command) => command.input.RequestItems!.BillsManifest.Keys.length)).toEqual([
      100, 100, 60,
    ]);
  });

  it("serves the record without titles when the manifest cannot be read", async () => {
    fakeTables({ manifestFails: true });

    const result = await request({ bioguideId: "A000001" });

    expect(result.statusCode).toBe(200);
    expect(body(result).votes[0]).not.toHaveProperty("title");
    expect(body(result).votes).toHaveLength(4);
  });

  it("answers 500 with ApiError when the vote record cannot be read", async () => {
    mockSend.mockRejectedValue(new Error("AccessDeniedException"));

    const result = await request({ bioguideId: "A000001" });

    expect(result.statusCode).toBe(500);
    expect(body(result)).toEqual({ error: "INTERNAL_ERROR", message: "Couldn't load the member's record." });
  });

  it.each([
    [{}, "INVALID_BIOGUIDE_ID"],
    [{ bioguideId: "A00001" }, "INVALID_BIOGUIDE_ID"],
    [{ bioguideId: "../A000001" }, "INVALID_BIOGUIDE_ID"],
    [{ bioguideId: "A000001", limit: "0" }, "INVALID_LIMIT"],
    [{ bioguideId: "A000001", limit: "101" }, "INVALID_LIMIT"],
    [{ bioguideId: "A000001", limit: "2.5" }, "INVALID_LIMIT"],
    [{ bioguideId: "A000001", limit: "ten" }, "INVALID_LIMIT"],
    [{ bioguideId: "A000001", cursor: "not a cursor!" }, "INVALID_CURSOR"],
    [{ bioguideId: "A000001", cursor: Buffer.from("A000002#anything").toString("base64url") }, "INVALID_CURSOR"],
    [{ bioguideId: "A000001", cursor: "" }, "INVALID_CURSOR"],
  ])("answers 400 for %j without reading anything", async (query, error) => {
    const result = await request(query as Record<string, string>);

    expect(result.statusCode).toBe(400);
    expect(body(result).error).toBe(error);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("answers 401 without a signed-in caller", async () => {
    const result = await request({ bioguideId: "A000001" }, false);

    expect(result.statusCode).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never sends a user's vote or a judging word: only the record's own fields", async () => {
    fakeTables({
      votes: [
        voteRow("2026-10-01T00:00:00.000Z", "BILLS-119hr77", "Nay", { userVote: { S: "Yea" }, score: { N: "3" } }),
      ],
    });

    const [vote] = body(await request({ bioguideId: "A000001" })).votes;

    expect(Object.keys(vote).sort()).toEqual(
      ["billGuid", "billNumber", "billType", "chamber", "congress", "position", "title", "votedAt"].sort(),
    );
  });

  it("leaves out a row with a position Congress does not record", async () => {
    fakeTables({ votes: [voteRow("2026-10-01T00:00:00.000Z", "BILLS-119hr77", "Missed")] });

    expect(body(await request({ bioguideId: "A000001" })).votes).toEqual([]);
  });
});
