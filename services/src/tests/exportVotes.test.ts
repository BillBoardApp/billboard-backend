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
process.env.MANIFEST_TABLE_NAME = "BillsManifest";
process.env.MANIFEST_PRIMARY_KEY = "pk";
process.env.MANIFEST_SORT_KEY = "sk";
process.env.MANIFEST_PK_VALUE = "BILL";
process.env.MANIFEST_GUID_LOOKUP_PK = "BILL_GUID";

import { readFileSync } from "fs";
import { join } from "path";
import { BatchGetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";

const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { handler } = require("../handlers/fetchFeedback");
const {
  decodeVoteExportCursor,
  encodeVoteExportCursor,
  VOTE_EXPORT_PAGE_SIZE,
} = require("../handlers/fetchFeedback/exportVotes");

/** A DynamoDB attribute as these tests build and read it. */
type Attr = {
  S?: string;
  N?: string;
  BOOL?: boolean;
  NULL?: boolean;
  SS?: string[];
  M?: Record<string, Attr>;
  L?: Attr[];
};
type Item = Record<string, Attr>;
/** An exported vote as the response body holds it. */
type Vote = Record<string, unknown>;

const CALLER = "caller-sub";
const OTHER = "someone-else-sub";

const exportEvent = (options: { sub?: string; cursor?: string; body?: string } = {}) => ({
  resource: "/account-data/votes",
  path: "/account-data/votes",
  httpMethod: "GET",
  queryStringParameters: options.cursor === undefined ? null : { cursor: options.cursor },
  body: options.body ?? null,
  requestContext: options.sub === undefined ? {} : { authorizer: { claims: { sub: options.sub } } },
});

/** A stored vote row, with the internal fields SetFeedback writes beside the ones the file keeps. */
const voteRow = (billId: string, feedback: string, extra: Item = {}): Item => ({
  userId: { S: CALLER },
  billId: { S: billId },
  feedback: { S: feedback },
  votedAt: { S: "2026-10-02T15:00:00.000Z" },
  firstVotedAt: { S: "2026-10-01T15:00:00.000Z" },
  effectiveWeight: { N: "1" },
  constituentVerified: { BOOL: true },
  verificationStatus: { S: "likely_constituent" },
  adultEligible: { BOOL: true },
  resolvedState: { S: "VA" },
  resolvedDistrict: { S: "8" },
  appAttest: { S: "valid" },
  civicProfile: { M: { localVsFederal: { N: "0.5" } } },
  lifeAreas: { L: [{ S: "Taxes" }] },
  ...extra,
});

/**
 * A fake of the two tables: `pages` are the Query answers in order (each Items and LastEvaluatedKey), and the votes
 * table holds every row of every page (read by key too); the manifest holds a lookup row and a bill row for each entry
 * of `titles` (a guid with title null has a lookup row only).
 */
const fakeTables = (
  pages: Array<{ Items: Item[]; LastEvaluatedKey?: Item }>,
  titles: Record<string, string | null>,
) => {
  let page = 0;
  const voteRows = new Map(pages.flatMap((answer) => answer.Items).map((row) => [row.billId.S, row]));
  const lookups = new Map(Object.keys(titles).map((guid) => [guid, `2026-10-01T00:00:00.000Z#${guid}`]));
  const bills = new Map(
    Object.entries(titles)
      .filter(([, title]) => title !== null)
      .map(([guid, title]) => [`2026-10-01T00:00:00.000Z#${guid}`, title as string]),
  );
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof QueryCommand) return pages[page++] ?? { Items: [] };
    if (command instanceof BatchGetItemCommand && command.input.RequestItems!.UserFeedback) {
      const { Keys } = command.input.RequestItems!.UserFeedback;
      const rows = (Keys as unknown as Item[]).flatMap((key): Item[] => {
        const row = key.userId.S === CALLER ? voteRows.get(key.billId.S) : undefined;
        return row ? [row] : [];
      });
      return { Responses: { UserFeedback: rows } };
    }
    if (command instanceof BatchGetItemCommand) {
      const { Keys } = command.input.RequestItems!.BillsManifest;
      const items = (Keys as unknown as Item[]).flatMap((key): Item[] => {
        if (key.pk.S === "BILL_GUID") {
          const manifestSk = lookups.get(key.sk.S ?? "");
          return manifestSk ? [{ sk: { S: key.sk.S }, manifestSk: { S: manifestSk } }] : [];
        }
        const title = bills.get(key.sk.S ?? "");
        return key.pk.S === "BILL" && title !== undefined ? [{ sk: { S: key.sk.S }, title: { S: title } }] : [];
      });
      return { Responses: { BillsManifest: items } };
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`);
  });
};

const queries = () =>
  mockSend.mock.calls
    .map(([command]: [unknown]) => command)
    .filter((command: unknown) => command instanceof QueryCommand);
const batchGets = (table = "BillsManifest") =>
  mockSend.mock.calls
    .map(([command]: [unknown]) => command)
    .filter(
      (command: unknown) => command instanceof BatchGetItemCommand && Boolean(command.input.RequestItems?.[table]),
    );

const run = async (options: Parameters<typeof exportEvent>[0] = { sub: CALLER }) => {
  const response = await handler(exportEvent(options));
  return { ...response, json: JSON.parse(response.body) };
};

describe("GET /account-data/votes (UX-40 L7)", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it("answers 401 without authorizer claims, reading nothing", async () => {
    const response = await run({});
    expect(response.statusCode).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reads only the caller's partition, whatever the request carries", async () => {
    fakeTables([{ Items: [voteRow("BILLS-119hr1", "Yea")] }], { "BILLS-119hr1": "A Bill" });

    // A body (a batch read or another user's id) is ignored: this route reads no body.
    const response = await run({
      sub: CALLER,
      body: JSON.stringify({ billIds: ["BILLS-119hr2"], userId: OTHER, billId: "BILLS-119hr3" }),
    });

    expect(response.statusCode).toBe(200);
    const [query] = queries();
    expect(queries()).toHaveLength(1);
    expect(query.input).toEqual(
      expect.objectContaining({
        TableName: "UserFeedback",
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: CALLER } },
        Limit: VOTE_EXPORT_PAGE_SIZE,
      }),
    );
    expect(query.input.ExclusiveStartKey).toBeUndefined();
    expect(query.input.ExpressionAttributeNames["#pk"]).toBe("userId");
    expect(response.json.votes.map((vote: Vote) => vote.billId)).toEqual(["BILLS-119hr1"]);
  });

  it("answers each vote with exactly the agreed fields, and projects the internal ones out of the read", async () => {
    fakeTables(
      [{ Items: [voteRow("BILLS-119hr1285", "Nay", { reasons: { SS: ["taxes_spending", "economic_impact"] } })] }],
      { "BILLS-119hr1285": "Clean Energy Access Act" },
    );

    const response = await run();

    expect(response.headers).toEqual({ "Content-Type": "application/json", "Cache-Control": "no-store" });
    expect(response.json).toEqual({
      votes: [
        {
          billId: "BILLS-119hr1285",
          title: "Clean Energy Access Act",
          congress: "119",
          billType: "hr",
          billNumber: "1285",
          vote: "Nay",
          reasons: ["economic_impact", "taxes_spending"],
          firstVotedAt: "2026-10-01T15:00:00.000Z",
          votedAt: "2026-10-02T15:00:00.000Z",
          state: "VA",
          district: "8",
          verified: true,
        },
      ],
    });
    // Never the weight, the App Attest outcome, the adult flag or the bill's theme scores and topics.
    const projection: string = queries()[0].input.ProjectionExpression;
    for (const internal of [
      "effectiveWeight",
      "appAttest",
      "adultEligible",
      "civicProfile",
      "lifeAreas",
      "subCategories",
      "verificationStatus",
    ]) {
      expect(projection).not.toContain(internal);
    }
    expect(JSON.stringify(response.json)).not.toMatch(/effectiveWeight|appAttest|adultEligible|civicProfile|lifeAreas/);
  });

  it("leaves out 1.0 and 1.1 dismissals and rows that hold no vote", async () => {
    fakeTables(
      [
        {
          Items: [
            voteRow("BILLS-119hr1", "Abstain", { legacyDismiss: { BOOL: true } }),
            voteRow("BILLS-119hr2", "Abstain"),
            voteRow("BILLS-119hr3", "Maybe"),
            { userId: { S: CALLER }, billId: { S: "BILLS-119hr4" } },
            voteRow("BILLS-119hr5", "yea"),
          ],
        },
      ],
      {},
    );

    const response = await run();

    expect(response.json.votes.map((vote: Vote) => [vote.billId, vote.vote])).toEqual([
      ["BILLS-119hr2", "Abstain"],
      ["BILLS-119hr5", "Yea"],
    ]);
  });

  it("falls back to votedAt for the first vote time, and keeps null times and missing location as null", async () => {
    const { firstVotedAt: _first, ...beforeUx31 } = voteRow("BILLS-119s1", "Yea");
    const {
      resolvedState: _state,
      resolvedDistrict: _district,
      constituentVerified: _verified,
      ...unlocated
    } = voteRow("BILLS-119s3", "Nay");
    fakeTables(
      [
        {
          Items: [
            beforeUx31,
            voteRow("BILLS-119s2", "Yea", { firstVotedAt: { NULL: true }, votedAt: { S: "2026-10-05T00:00:00.000Z" } }),
            unlocated,
          ],
        },
      ],
      {},
    );

    const [first, untimed, located] = (await run()).json.votes;

    expect(first).toEqual(
      expect.objectContaining({ firstVotedAt: "2026-10-02T15:00:00.000Z", votedAt: "2026-10-02T15:00:00.000Z" }),
    );
    expect(untimed).toEqual(expect.objectContaining({ firstVotedAt: null, votedAt: "2026-10-05T00:00:00.000Z" }));
    expect(located).toEqual(expect.objectContaining({ state: null, district: null, verified: false, reasons: [] }));
  });

  it("gives a null title to a bill with no manifest row, or a lookup row without its bill row", async () => {
    fakeTables(
      [{ Items: [voteRow("BILLS-119hr1", "Yea"), voteRow("BILLS-119hr2", "Nay"), voteRow("BILLS-119hr3", "Yea")] }],
      { "BILLS-119hr1": "Has A Title", "BILLS-119hr2": null },
    );

    const titles = (await run()).json.votes.map((vote: Vote) => [vote.billId, vote.title]);

    expect(titles).toEqual([
      ["BILLS-119hr1", "Has A Title"],
      ["BILLS-119hr2", null],
      ["BILLS-119hr3", null],
    ]);
  });

  it("reads a suffixed bill id's title under its plain guid, once, and a non-guid id gets no bill fields", async () => {
    fakeTables(
      [
        {
          Items: [
            voteRow("BILLS-119hr1181ih", "Yea"),
            voteRow("BILLS-119hr1181rh", "Nay"),
            voteRow("not-a-bill", "Yea"),
          ],
        },
      ],
      { "BILLS-119hr1181": "The Same Bill" },
    );

    const votes = (await run()).json.votes;

    expect(votes.map((vote: Vote) => [vote.billId, vote.title, vote.billNumber])).toEqual([
      ["BILLS-119hr1181ih", "The Same Bill", "1181"],
      ["BILLS-119hr1181rh", "The Same Bill", "1181"],
      ["not-a-bill", null, null],
    ]);
    // BatchGetItem refuses a request that repeats a key.
    const lookupKeys = batchGets()[0].input.RequestItems.BillsManifest.Keys;
    expect(lookupKeys).toEqual([{ pk: { S: "BILL_GUID" }, sk: { S: "BILLS-119hr1181" } }]);
    expect(batchGets("UserFeedback")[0].input.RequestItems.UserFeedback.Keys).toEqual([
      { userId: { S: CALLER }, billId: { S: "BILLS-119hr1181" } },
    ]);
  });

  describe("a bill with a vote under a legacy id and under its plain guid", () => {
    it("lists it once, from the plain guid's row, when both are on one page, reading no twin", async () => {
      fakeTables([{ Items: [voteRow("BILLS-119hr1181", "Nay"), voteRow("BILLS-119hr1181rh", "Yea")] }], {
        "BILLS-119hr1181": "The Same Bill",
      });

      const votes = (await run()).json.votes;

      expect(votes.map((vote: Vote) => [vote.billId, vote.vote, vote.title])).toEqual([
        ["BILLS-119hr1181", "Nay", "The Same Bill"],
      ]);
      expect(batchGets("UserFeedback")).toHaveLength(0);
    });

    it("lists it once when the two rows fall on different pages", async () => {
      // BILLS-119hr11810 sorts between the plain guid and its legacy id, so a page can end between them.
      fakeTables(
        [
          {
            Items: [voteRow("BILLS-119hr1181", "Nay"), voteRow("BILLS-119hr11810", "Yea")],
            LastEvaluatedKey: { userId: { S: CALLER }, billId: { S: "BILLS-119hr11810" } },
          },
          { Items: [voteRow("BILLS-119hr1181rh", "Yea"), voteRow("BILLS-119hr1182", "Abstain")] },
        ],
        { "BILLS-119hr1181": "The Same Bill" },
      );

      const first = await run();
      const second = await run({ sub: CALLER, cursor: first.json.nextToken });

      expect([...first.json.votes, ...second.json.votes].map((vote: Vote) => vote.billId)).toEqual([
        "BILLS-119hr1181",
        "BILLS-119hr11810",
        "BILLS-119hr1182",
      ]);
      // The twin is read by key, in the caller's partition only.
      const twinReads = batchGets("UserFeedback");
      expect(twinReads).toHaveLength(1);
      expect(twinReads[0].input.RequestItems.UserFeedback.Keys).toEqual([
        { userId: { S: CALLER }, billId: { S: "BILLS-119hr1181" } },
      ]);
    });

    it("keeps a legacy row whose plain guid has no row, or only a 1.0 or 1.1 dismissal", async () => {
      fakeTables(
        [
          {
            Items: [
              voteRow("BILLS-119hr1181rh", "Yea"),
              voteRow("BILLS-119hr77", "Abstain", { legacyDismiss: { BOOL: true } }),
              voteRow("BILLS-119hr77eh", "Nay"),
            ],
          },
        ],
        {},
      );

      const votes = (await run()).json.votes;

      expect(votes.map((vote: Vote) => [vote.billId, vote.vote])).toEqual([
        ["BILLS-119hr1181rh", "Yea"],
        ["BILLS-119hr77eh", "Nay"],
      ]);
    });

    it("reads the twins in requests of at most 100 keys", async () => {
      const items = Array.from({ length: 150 }, (_, i) => voteRow(`BILLS-119hr${i + 1}rh`, "Yea"));
      fakeTables([{ Items: items }], {});

      expect((await run()).json.votes).toHaveLength(150);
      expect(batchGets("UserFeedback").map((command) => command.input.RequestItems.UserFeedback.Keys.length)).toEqual([
        100, 50,
      ]);
    });
  });

  it("reads the manifest in requests of at most 100 keys", async () => {
    const items = Array.from({ length: 250 }, (_, i) => voteRow(`BILLS-119hr${i + 1}`, "Yea"));
    fakeTables([{ Items: items }], Object.fromEntries(items.map((item) => [item.billId.S, `Title ${item.billId.S}`])));

    const votes = (await run()).json.votes;

    expect(votes).toHaveLength(250);
    expect(votes[249].title).toBe("Title BILLS-119hr250");
    const sizes = batchGets().map(
      (command: BatchGetItemCommand) => command.input.RequestItems!.BillsManifest.Keys!.length,
    );
    expect(sizes).toEqual([100, 100, 50, 100, 100, 50]);
  });

  it("retries the manifest's unprocessed keys", async () => {
    fakeTables([{ Items: [voteRow("BILLS-119hr1", "Yea"), voteRow("BILLS-119hr2", "Yea")] }], {
      "BILLS-119hr1": "First",
      "BILLS-119hr2": "Second",
    });
    const fake = mockSend.getMockImplementation();
    let throttledOnce = false;
    mockSend.mockImplementation(async (command: unknown) => {
      const answer = await fake(command);
      if (!throttledOnce && command instanceof BatchGetItemCommand) {
        throttledOnce = true;
        const [kept, ...unprocessed] = answer.Responses.BillsManifest;
        const keyOf = (item: Item) => ({ pk: { S: "BILL_GUID" }, sk: item.sk });
        return {
          Responses: { BillsManifest: [kept] },
          UnprocessedKeys: { BillsManifest: { Keys: unprocessed.map(keyOf) } },
        };
      }
      return answer;
    });

    const votes = (await run()).json.votes;

    expect(votes.map((vote: Vote) => vote.title)).toEqual(["First", "Second"]);
  });

  it("pages with a cursor that holds only the last bill id and works only for its caller", async () => {
    fakeTables(
      [
        {
          Items: [voteRow("BILLS-119hr1", "Yea")],
          LastEvaluatedKey: { userId: { S: CALLER }, billId: { S: "BILLS-119hr1" } },
        },
        { Items: [voteRow("BILLS-119hr2", "Nay")] },
      ],
      {},
    );

    const first = await run();
    expect(first.json.votes.map((vote: Vote) => vote.billId)).toEqual(["BILLS-119hr1"]);
    const { nextToken } = first.json;
    expect(typeof nextToken).toBe("string");
    expect(JSON.parse(Buffer.from(nextToken, "base64url").toString("utf8"))).toEqual({
      v: 1,
      u: expect.any(String),
      after: "BILLS-119hr1",
    });
    // The tag is not the sub.
    expect(Buffer.from(nextToken, "base64url").toString("utf8")).not.toContain(CALLER);

    const second = await run({ sub: CALLER, cursor: nextToken });
    expect(second.statusCode).toBe(200);
    expect(second.json).toEqual({ votes: [expect.objectContaining({ billId: "BILLS-119hr2" })] });
    expect(queries()[1].input.ExclusiveStartKey).toEqual({ userId: { S: CALLER }, billId: { S: "BILLS-119hr1" } });
    expect(queries()[1].input.ExpressionAttributeValues).toEqual({ ":pk": { S: CALLER } });
  });

  it("answers a page with no votes but a nextToken when every row on it was left out", async () => {
    fakeTables(
      [
        {
          Items: [voteRow("BILLS-119hr1", "Abstain", { legacyDismiss: { BOOL: true } })],
          LastEvaluatedKey: { userId: { S: CALLER }, billId: { S: "BILLS-119hr1" } },
        },
      ],
      {},
    );

    const response = await run();

    expect(response.json.votes).toEqual([]);
    expect(decodeVoteExportCursor(CALLER, response.json.nextToken)).toBe("BILLS-119hr1");
    expect(batchGets()).toHaveLength(0);
  });

  it("answers 400 to a tampered, foreign or malformed cursor, reading nothing", async () => {
    const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const valid = encodeVoteExportCursor(CALLER, "BILLS-119hr1");
    const { u } = JSON.parse(Buffer.from(valid, "base64url").toString("utf8"));
    const bad = [
      encodeVoteExportCursor(OTHER, "BILLS-119hr1"),
      encode({ v: 1, u: "x".repeat(22), after: "BILLS-119hr1" }),
      encode({ v: 2, u, after: "BILLS-119hr1" }),
      encode({ v: 1, u, after: "BILLS-119hr1", userId: OTHER }),
      encode({ v: 1, u, after: "" }),
      encode({ v: 1, u, after: 7 }),
      encode({ v: 1, u, after: "B".repeat(1025) }),
      encode([1, u, "BILLS-119hr1"]),
      encode("BILLS-119hr1"),
      Buffer.from("not json", "utf8").toString("base64url"),
      `${valid}=`,
      valid.replace(/.$/, "!"),
      "",
      "A".repeat(2049),
    ];

    for (const cursor of bad) {
      const response = await run({ sub: CALLER, cursor });
      expect({ cursor, status: response.statusCode, body: response.json }).toEqual({
        cursor,
        status: 400,
        body: { error: "INVALID_CURSOR", message: expect.any(String) },
      });
    }
    expect(mockSend).not.toHaveBeenCalled();
    expect(decodeVoteExportCursor(CALLER, valid)).toBe("BILLS-119hr1");
  });

  it("answers 500 when a read fails, and logs neither bill ids nor votes on any path", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      fakeTables(
        [
          {
            Items: [voteRow("BILLS-119hr77", "Nay", { reasons: { SS: ["public_safety"] } })],
            LastEvaluatedKey: { userId: { S: CALLER }, billId: { S: "BILLS-119hr77" } },
          },
        ],
        { "BILLS-119hr77": "Secret Ballot Act" },
      );
      expect((await run()).statusCode).toBe(200);

      mockSend.mockReset();
      mockSend.mockRejectedValue(Object.assign(new Error("Throughput exceeded"), { name: "ThrottlingException" }));
      const failed = await run();
      expect(failed.statusCode).toBe(500);
      expect(failed.json).toEqual({ error: "Internal server error" });

      const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))).join("\n");
      expect(logged).toContain("exportVotes could not read the caller's votes");
      for (const secret of ["BILLS-119hr77", "Nay", "public_safety", "Secret Ballot Act", "VA", CALLER]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("counts each failed export in VoteExportFailed, a failed twin read too, and nothing on success", async () => {
    const lines = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const exportFailures = () =>
      lines.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('"_aws"'))
        .map((line) => JSON.parse(line))
        .filter((metric) => metric.VoteExportFailed !== undefined);
    try {
      fakeTables([{ Items: [voteRow("BILLS-119hr1181rh", "Yea")] }], {});
      expect((await run()).statusCode).toBe(200);
      expect(exportFailures()).toEqual([]);

      mockSend.mockReset();
      mockSend.mockRejectedValue(Object.assign(new Error("Throughput exceeded"), { name: "ThrottlingException" }));
      expect((await run()).statusCode).toBe(500);

      fakeTables([{ Items: [voteRow("BILLS-119hr1181rh", "Yea")] }], {});
      const route = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof BatchGetItemCommand && command.input.RequestItems?.UserFeedback) {
          throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        }
        return route(command);
      });
      expect((await run()).statusCode).toBe(500);

      const failures = exportFailures();
      expect(failures).toHaveLength(2);
      failures.forEach((metric) => {
        expect(metric.VoteExportFailed).toBe(1);
        expect(metric._aws.CloudWatchMetrics).toEqual([
          expect.objectContaining({
            Namespace: "BillBoard/Accounts",
            Metrics: [expect.objectContaining({ Name: "VoteExportFailed" })],
          }),
        ]);
        expect(JSON.stringify(metric)).not.toContain(CALLER);
      });
    } finally {
      lines.mockRestore();
      errors.mockRestore();
    }
  });

  it("matches the contract's VoteExport schema and sample", async () => {
    fakeTables([{ Items: [voteRow("BILLS-119hr1285", "Yea")] }], { "BILLS-119hr1285": "Clean Energy Access Act" });
    const body = (await run()).json;

    const openapi = JSON.parse(readFileSync(join(__dirname, "../../../contracts/openapi/user-api.v1.json"), "utf8"));
    const schema = openapi.components.schemas;
    expect(Object.keys(body).sort()).toEqual(schema.VoteExport.required.sort());
    expect(Object.keys(body.votes[0]).sort()).toEqual(Object.keys(schema.ExportedVote.properties).sort());
    expect(schema.ExportedVote.required.sort()).toEqual(Object.keys(schema.ExportedVote.properties).sort());
    const fixture = JSON.parse(
      readFileSync(join(__dirname, "../../../contracts/fixtures/openapi/VoteExport.valid.json"), "utf8"),
    );
    expect(Object.keys(fixture.votes[0]).sort()).toEqual(Object.keys(body.votes[0]).sort());
  });
});

describe("GET /feedback is unchanged by the export route", () => {
  beforeEach(() => mockSend.mockReset());

  it("still answers the single-bill lookup for its own resource", async () => {
    mockSend.mockResolvedValueOnce({ Item: { feedback: { S: "Yea" } } });
    const response = await handler({
      resource: "/feedback",
      httpMethod: "GET",
      queryStringParameters: { billId: "BILLS-119hr1" },
      requestContext: { authorizer: { claims: { sub: CALLER } } },
    });
    expect(JSON.parse(response.body)).toEqual({ feedback: "Yea", votedAt: null, reasons: [] });
  });
});
