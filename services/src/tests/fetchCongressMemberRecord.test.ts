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
    IndexName?: string;
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

/** One member's vote rows, newest first as the VotedOnIndex sorts them, and the tables the handler reads. */
const voteRow = (votedOn: string, guid: string, position: string, extra: Item = {}, chamber = "House"): Item => ({
  bioguideId: { S: "A000001" },
  billKey: { S: `${guid}#${chamber}` },
  votedOnKey: { S: `${votedOn}#${guid}` },
  billGuid: { S: guid },
  chamber: { S: chamber },
  position: { S: position },
  votedOn: { S: votedOn },
  ...extra,
});

const VOTES: Item[] = [
  voteRow("2027-01-15", "BILLS-120hr5", "Yea", { actionText: { S: "On passage Passed: 300 - 120" } }),
  voteRow("2026-12-10", "BILLS-119hr900", "Not Voting"),
  voteRow("2026-11-02", "BILLS-119hr812", "Present"),
  voteRow("2026-10-01", "BILLS-119hr77", "Nay", { actionText: { S: "On motion to recommit Failed" } }),
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

const fakeTables = (
  options: {
    votes?: Item[];
    stats?: Item | null;
    manifest?: Record<string, Item>;
    manifestFails?: boolean;
    recordUnprocessed?: boolean;
  } = {},
) => {
  const votes = options.votes ?? VOTES;
  const manifest = options.manifest ?? MANIFEST;
  mockSend.mockImplementation(async (command: Command) => {
    const input = command.input;
    if (command.kind === "Query") {
      const after = input.ExclusiveStartKey;
      const start = after
        ? votes.findIndex((row) => row.billKey.S === after.billKey?.S && row.votedOnKey.S === after.votedOnKey?.S) + 1
        : 0;
      return { Items: votes.slice(start, start + (input.Limit ?? votes.length)) };
    }
    if (command.kind === "GetItem") return options.stats === null ? {} : { Item: options.stats ?? STATS };
    const recordKeys = input.RequestItems!.CongressMemberVoteRecord?.Keys;
    if (recordKeys) {
      if (options.recordUnprocessed) {
        return { Responses: { CongressMemberVoteRecord: [] }, UnprocessedKeys: input.RequestItems };
      }
      const wanted = new Set(recordKeys.map((key) => `${key.bioguideId.S}|${key.billKey.S}`));
      const items = votes.filter((row) => wanted.has(`${row.bioguideId.S}|${row.billKey.S}`));
      return { Responses: { CongressMemberVoteRecord: items } };
    }
    if (options.manifestFails) throw new Error("ProvisionedThroughputExceededException");
    const keys = input.RequestItems!.BillsManifest.Keys;
    const items = keys.flatMap((key) => {
      const pk = key.pk.S;
      const sk = key.sk.S!;
      if (pk === "BILL_GUID") return manifest[sk] ? [{ sk: { S: sk }, manifestSk: { S: `2026#${sk}` } }] : [];
      const guid = sk.split("#")[1];
      return manifest[guid] ? [{ sk: { S: sk }, ...manifest[guid] }] : [];
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
      VOTE_RECORD_SORT_KEY: "billKey",
      VOTE_RECORD_VOTED_ON_INDEX_NAME: "VotedOnIndex",
      VOTE_RECORD_VOTED_ON_KEY: "votedOnKey",
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
  jest.spyOn(global, "setTimeout").mockImplementation(((callback: () => void) => {
    callback();
    return 0;
  }) as unknown as typeof setTimeout);
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
          votedOn: "2027-01-15",
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
          votedOn: "2026-12-10",
        },
        {
          billGuid: "BILLS-119hr812",
          congress: "119",
          billType: "hr",
          billNumber: "812",
          title: "Names a post office",
          chamber: "House",
          position: "Present",
          votedOn: "2026-11-02",
        },
        {
          billGuid: "BILLS-119hr77",
          congress: "119",
          billType: "hr",
          billNumber: "77",
          title: "Changes the rules for small farms",
          chamber: "House",
          position: "Nay",
          votedOn: "2026-10-01",
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
        // BILLS-119hr404 is counted in the member stats but has no manifest row (still waiting for its text): not in
        // BillBoard yet, so neither listed nor counted.
      ],
      sponsoredBillCount: 3,
      sponsoredBillCounts: [
        { congress: "120", count: 1 },
        { congress: "119", count: 2 },
      ],
    });
    const [query] = commands("Query");
    expect(query.input).toMatchObject({
      TableName: "CongressMemberVoteRecord",
      IndexName: "VotedOnIndex",
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
    expect(Buffer.from(first.nextCursor, "base64url").toString()).toBe("2026-12-10#BILLS-119hr900#House");
    expect(first.sponsoredBills).toHaveLength(3);

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
    expect(second).not.toHaveProperty("sponsoredBillCounts");
    // The local index's start key: the table's keys and the index's sort key.
    expect(commands("Query")[0].input.ExclusiveStartKey).toEqual({
      bioguideId: { S: "A000001" },
      billKey: { S: "BILLS-119hr900#House" },
      votedOnKey: { S: "2026-12-10#BILLS-119hr900" },
    });
    expect(commands("GetItem")).toEqual([]);
  });

  it("answers an unknown member with an empty record, not a 404", async () => {
    fakeTables({ votes: [], stats: null });

    const result = await request({ bioguideId: "Z999999" });

    expect(result.statusCode).toBe(200);
    expect(body(result)).toEqual({
      bioguideId: "Z999999",
      votes: [],
      sponsoredBills: [],
      sponsoredBillCount: 0,
      sponsoredBillCounts: [],
    });
    expect(commands("BatchGetItem")).toEqual([]);
  });

  it("caps the sponsored bills at 250 and counts them all", async () => {
    const guids = Array.from({ length: 260 }, (_, index) => `BILLS-119hr${index + 1000}`);
    const manifest = Object.fromEntries(guids.map((guid) => [guid, { title: { S: `Bill ${guid}` } }]));
    fakeTables({ votes: [], manifest, stats: { bioguideId: { S: "A000001" }, sponsoredBillGuids: { SS: guids } } });

    const record = body(await request({ bioguideId: "A000001" }));

    expect(record.sponsoredBills).toHaveLength(250);
    expect(record.sponsoredBillCount).toBe(260);
    expect(record.sponsoredBillCounts).toEqual([{ congress: "119", count: 260 }]);
    // 260 lookups and then 260 rows, in batches of at most 100 keys.
    expect(commands("BatchGetItem").map((command) => command.input.RequestItems!.BillsManifest.Keys.length)).toEqual([
      100, 100, 60, 100, 100, 60,
    ]);
  });

  it("serves the record without titles, and every counted sponsored bill, when the manifest cannot be read", async () => {
    fakeTables({ manifestFails: true });

    const result = await request({ bioguideId: "A000001" });

    expect(result.statusCode).toBe(200);
    expect(body(result).votes[0]).not.toHaveProperty("title");
    expect(body(result).votes).toHaveLength(4);
    expect(body(result).sponsoredBills.map((bill: { billGuid: string }) => bill.billGuid)).toEqual([
      "BILLS-120hr2",
      "BILLS-119hr404",
      "BILLS-119hr11",
      "BILLS-119hr10",
    ]);
    expect(body(result).sponsoredBillCount).toBe(4);
  });

  describe("billGuids: the member's votes on given bills (UX-18 'voted alike')", () => {
    const BOTH_CHAMBERS: Item[] = [
      ...VOTES,
      voteRow("2027-01-20", "BILLS-120hr5", "Nay", {}, "Senate"),
      voteRow("2026-09-01", "BILLS-119s3", "Yea", {}, "Senate"),
    ];

    it("reads both chambers' rows of each bill and serves them newest first, with no cursor or sponsored bills", async () => {
      fakeTables({ votes: BOTH_CHAMBERS });

      const result = await request({ bioguideId: "A000001", billGuids: "BILLS-119hr77, BILLS-120hr5,BILLS-119hr1" });

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
            chamber: "Senate",
            position: "Nay",
            votedOn: "2027-01-20",
          },
          {
            billGuid: "BILLS-120hr5",
            congress: "120",
            billType: "hr",
            billNumber: "5",
            title: "Extends school meals",
            chamber: "House",
            position: "Yea",
            votedOn: "2027-01-15",
            actionText: "On passage Passed: 300 - 120",
          },
          {
            billGuid: "BILLS-119hr77",
            congress: "119",
            billType: "hr",
            billNumber: "77",
            title: "Changes the rules for small farms",
            chamber: "House",
            position: "Nay",
            votedOn: "2026-10-01",
            actionText: "On motion to recommit Failed",
          },
        ],
      });
      const [batch] = commands("BatchGetItem");
      expect(batch.input.RequestItems!.CongressMemberVoteRecord.Keys).toEqual(
        ["BILLS-119hr77", "BILLS-120hr5", "BILLS-119hr1"].flatMap((guid) =>
          ["House", "Senate"].map((chamber) => ({
            bioguideId: { S: "A000001" },
            billKey: { S: `${guid}#${chamber}` },
          })),
        ),
      );
      expect(commands("Query")).toEqual([]);
      expect(commands("GetItem")).toEqual([]);
    });

    it("reads 100 bills in two batches of 100 keys", async () => {
      fakeTables({ votes: [] });
      const guids = Array.from({ length: 100 }, (_, index) => `BILLS-119hr${index + 1}`);

      const result = await request({ bioguideId: "A000001", billGuids: guids.join(",") });

      expect(body(result)).toEqual({ bioguideId: "A000001", votes: [] });
      expect(
        commands("BatchGetItem").map((command) => command.input.RequestItems!.CongressMemberVoteRecord.Keys.length),
      ).toEqual([100, 100]);
    });

    it("answers 500 rather than a partial answer when the record cannot be read in full", async () => {
      fakeTables({ recordUnprocessed: true });

      const result = await request({ bioguideId: "A000001", billGuids: "BILLS-119hr77" });

      expect(result.statusCode).toBe(500);
      expect(body(result).error).toBe("INTERNAL_ERROR");
    });

    it.each([
      [{ billGuids: "" }],
      [{ billGuids: "BILLS-119hr77ih" }],
      [{ billGuids: "BILLS-119hr77,hr5" }],
      [{ billGuids: Array.from({ length: 101 }, (_, index) => `BILLS-119hr${index + 1}`).join(",") }],
      [{ billGuids: "BILLS-119hr77", limit: "10" }],
      [{ billGuids: "BILLS-119hr77", cursor: Buffer.from("2026-12-10#BILLS-119hr900#House").toString("base64url") }],
    ])("answers 400 INVALID_BILL_GUIDS for %j without reading anything", async (query) => {
      const result = await request({ bioguideId: "A000001", ...query });

      expect(result.statusCode).toBe(400);
      expect(body(result).error).toBe("INVALID_BILL_GUIDS");
      expect(mockSend).not.toHaveBeenCalled();
    });
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
    [
      // A cursor of the record's first key design: no chamber.
      { bioguideId: "A000001", cursor: Buffer.from("2026-12-10T00:00:00.000Z#BILLS-119hr900").toString("base64url") },
      "INVALID_CURSOR",
    ],
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
      votes: [voteRow("2026-10-01", "BILLS-119hr77", "Nay", { userVote: { S: "Yea" }, score: { N: "3" } })],
    });

    const [vote] = body(await request({ bioguideId: "A000001" })).votes;

    expect(Object.keys(vote).sort()).toEqual(
      ["billGuid", "billNumber", "billType", "chamber", "congress", "position", "title", "votedOn"].sort(),
    );
  });

  it("leaves out a row with a position Congress does not record", async () => {
    fakeTables({ votes: [voteRow("2026-10-01", "BILLS-119hr77", "Missed")] });

    expect(body(await request({ bioguideId: "A000001" })).votes).toEqual([]);
  });
});
