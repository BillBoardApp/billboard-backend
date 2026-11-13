import type { GetItemCommandInput, PutItemCommandInput, QueryCommandInput } from "@aws-sdk/client-dynamodb";
import { applyTestEnv } from "./fixtures/env";
import { logLines, type LogLine } from "./logLines";

/** The input fields the Dynamo fake reads, across the commands the handler sends. */
type DynamoInput = Partial<QueryCommandInput & GetItemCommandInput & PutItemCommandInput>;
interface DynamoCommand {
  input?: DynamoInput;
}

// LLM-11: the resolver maps MODEL_ID to a request shape at cold start, so the tests use real profile ARNs.
const HAIKU_45_PROFILE_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_55_PROFILE_ARN = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-5-5";

const originalEnv = { ...process.env };
const mockDynamoSend = jest.fn();
const mockBedrockSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

/** The published companion groups row (APPF-23); the tests without groups find none. */
const isCompanionGroupsRead = (input: DynamoInput): boolean => input?.Key?.pk?.S === "BILL_COMPANION_GROUPS";

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe("billPriorityResolver handler", () => {
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        MANIFEST_TABLE_NAME: "BillsManifest",
        MANIFEST_PRIMARY_KEY: "pk",
        MANIFEST_SORT_KEY: "sk",
        MANIFEST_PK_VALUE: "BILL",
        PRIORITY_TABLE_NAME: "BillPriority",
        PRIORITY_TABLE_PARTITION_KEY: "guid",
        PRIORITY_ACTIVE_INDEX_NAME: "PriorityStatusIndex",
        PRIORITY_STATUS_ATTRIBUTE: "status",
        PRIORITY_SORT_KEY_ATTRIBUTE: "prioritySortKey",
        PRIORITY_ACTIVE_STATUS_VALUE: "ACTIVE",
        MODEL_ID: HAIKU_45_PROFILE_ARN,
        NEWS_FEED_URLS: "https://news.example/feed.xml",
        BILL_LOOKBACK_DAYS: "7",
        MAX_CANDIDATE_BILLS: "10",
        MAX_HEADLINES: "10",
        MAX_PRIORITY_RESULTS: "5",
        MAX_OUTPUT_TOKENS: "500",
        HEADLINE_MAX_AGE_HOURS: "72",
        DEFAULT_PRIORITY_DURATION_HOURS: "12",
        PRIORITY_MIN_SCORE: "75",
        PRIORITY_MIN_CONFIDENCE: "0.55",
      },
      { replace: true, base: originalEnv },
    );

    const recentHeadlineDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toUTCString();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        [
          "<rss><channel>",
          "<item>",
          "<title>Congress races to pass H.R. 400 funding bill</title>",
          "<link>https://example.com/story</link>",
          "<source>Reuters</source>",
          `<pubDate>${recentHeadlineDate}</pubDate>`,
          "</item>",
          "</channel></rss>",
        ].join(""),
    } as Response);
  });

  afterEach(() => {
    restoreEnv?.();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv as NodeJS.ProcessEnv;
  });

  it("stores active priority rows from headline-ranked Bedrock output", async () => {
    const encoder = new TextEncoder();
    mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
      const input = command.input ?? {};

      if (input.IndexName === "PriorityStatusIndex") {
        return { Items: [] };
      }

      if (isCompanionGroupsRead(input)) {
        return {};
      }

      if (input.TableName === "BillsManifest" && input.KeyConditionExpression?.includes("#sk > :updatedAfter")) {
        return {
          Items: [
            {
              pk: { S: "BILL" },
              sk: { S: "2026-03-30T10:00:00.000Z#BILLS-119hr400" },
              guid: { S: "BILLS-119hr400" },
              billType: { S: "hr" },
              congress: { S: "119" },
              billNumber: { S: "400" },
              updatedAt: { S: "2026-03-30T10:00:00.000Z" },
              title: { S: "Government Funding Bill" },
              subCategories: { L: [] },
              lifeAreas: { L: [] },
              sponsors: { L: [] },
              cosponsors: { L: [] },
              billStatus: { S: "Updated" },
            },
          ],
        };
      }

      if (input.TableName === "BillPriority" && input.Item) {
        return {};
      }

      throw new Error(`Unexpected DynamoDB request: ${JSON.stringify(input)}`);
    });

    mockBedrockSend.mockResolvedValueOnce({
      body: encoder.encode(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                bills: [
                  {
                    guid: "BILLS-119hr400",
                    isPriority: true,
                    score: 91,
                    confidence: 0.88,
                    reason: "Multiple national outlets are leading with funding-bill coverage.",
                  },
                ],
              }),
            },
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 321,
            output_tokens: 87,
          },
        }),
      ),
    });

    const { handler } = require("../handlers/billPriorityResolver");
    const result = await handler();

    expect(result).toMatchObject({
      status: "ok",
      modelAnswer: "ok",
      activated: 1,
      carriedOver: 0,
    });

    const putCalls = mockDynamoSend.mock.calls
      .map((call) => call[0].input)
      .filter((input) => input?.TableName === "BillPriority" && input?.Item);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].Item.guid.S).toBe("BILLS-119hr400");
    expect(putCalls[0].Item.status.S).toBe("ACTIVE");
    expect(putCalls[0].Item.isPriority.BOOL).toBe(true);
    expect(putCalls[0].Item.priorityRank.N).toBe("1");
  });
  it("hides current priority status from the model and stores neutral, capped reasons (LLM-08)", async () => {
    const encoder = new TextEncoder();
    const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
      const input = command.input ?? {};

      if (isCompanionGroupsRead(input)) {
        return {};
      }

      if (input.IndexName === "PriorityStatusIndex") {
        return {
          Items: [
            {
              guid: { S: "BILLS-119hr500" },
              status: { S: "ACTIVE" },
              isPriority: { BOOL: true },
              congress: { S: "119" },
              billType: { S: "hr" },
              billNumber: { S: "500" },
              title: { S: "Border Security Bill" },
              updatedAt: { S: "2026-03-29T10:00:00.000Z" },
              priorityRank: { N: "1" },
              priorityUpdatedAt: { S: new Date().toISOString() },
              priorityExpiresAt: { S: future },
              prioritySortKey: { S: "0001#BILLS-119hr500" },
            },
          ],
        };
      }

      if (input.TableName === "BillsManifest" && input.KeyConditionExpression?.includes("#sk > :updatedAfter")) {
        return {
          Items: [
            {
              pk: { S: "BILL" },
              sk: { S: "2026-03-30T10:00:00.000Z#BILLS-119hr400" },
              guid: { S: "BILLS-119hr400" },
              billType: { S: "hr" },
              congress: { S: "119" },
              billNumber: { S: "400" },
              updatedAt: { S: "2026-03-30T10:00:00.000Z" },
              title: { S: "Government Funding Bill" },
              subCategories: { L: [] },
              lifeAreas: { L: [] },
              sponsors: { L: [] },
              cosponsors: { L: [] },
              billStatus: { S: "Updated" },
            },
          ],
        };
      }

      if (input.TableName === "BillPriority" && input.Item) {
        return {};
      }

      throw new Error(`Unexpected DynamoDB request: ${JSON.stringify(input)}`);
    });

    const longReason = `Reuters and AP lead with the funding deadline; ${"coverage continues across outlets and regions ".repeat(5)}`;
    mockBedrockSend.mockResolvedValueOnce({
      body: encoder.encode(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                bills: [
                  { guid: "BILLS-119hr400", isPriority: true, score: 91, confidence: 0.88, reason: longReason },
                  {
                    guid: "BILLS-119hr500",
                    isPriority: true,
                    score: 85,
                    confidence: 0.8,
                    reason: "Critics call it a radical power grab.",
                  },
                ],
              }),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 321, output_tokens: 87 },
        }),
      ),
    });

    const { handler } = require("../handlers/billPriorityResolver");
    await handler();

    const request = JSON.parse(mockBedrockSend.mock.calls[0][0].input.body);
    const userText: string = request.messages[0].content[0].text;
    expect(userText).not.toContain("alreadyPriority");
    const payload = JSON.parse(userText.slice(userText.indexOf("{")));
    expect(payload.candidates.map((candidate: { guid: string }) => candidate.guid)).toEqual([
      "BILLS-119hr400",
      "BILLS-119hr500",
    ]);

    const puts = mockDynamoSend.mock.calls
      .map((call) => call[0].input)
      .filter((input) => input?.TableName === "BillPriority" && input?.Item);
    const reasonFor = (guid: string) => puts.find((input) => input.Item.guid.S === guid)?.Item.priorityReason?.S;

    const capped = reasonFor("BILLS-119hr400");
    expect(capped.length).toBeLessThanOrEqual(140);
    expect(capped.startsWith("Reuters and AP lead with the funding deadline;")).toBe(true);
    expect(capped.endsWith("…")).toBe(true);
    expect(reasonFor("BILLS-119hr500")).toBe("In recent national news coverage.");
  });
});

describe("billPriorityResolver ranking", () => {
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        MANIFEST_TABLE_NAME: "BillsManifest",
        PRIORITY_TABLE_NAME: "BillPriority",
        PRIORITY_ACTIVE_INDEX_NAME: "PriorityStatusIndex",
        MODEL_ID: HAIKU_45_PROFILE_ARN,
        NEWS_FEED_URLS: "https://news.example/feed.xml",
        MAX_PRIORITY_RESULTS: "2",
        PRIORITY_MIN_SCORE: "75",
        PRIORITY_MIN_CONFIDENCE: "0.55",
      },
      { replace: true, base: originalEnv },
    );
    const recentHeadlineDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toUTCString();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        `<rss><channel><item><title>Senate vote on S. 20 and H.R. 400 and H.R. 7 this week</title><link>https://example.com/s</link><pubDate>${recentHeadlineDate}</pubDate></item></channel></rss>`,
    } as Response);
  });

  afterEach(() => {
    restoreEnv?.();
    jest.restoreAllMocks();
  });

  const manifestRow = (billType: string, billNumber: string) => ({
    pk: { S: "BILL" },
    sk: { S: `2026-03-30T10:00:00.000Z#BILLS-119${billType}${billNumber}` },
    guid: { S: `BILLS-119${billType}${billNumber}` },
    billType: { S: billType },
    congress: { S: "119" },
    billNumber: { S: billNumber },
    updatedAt: { S: "2026-03-30T10:00:00.000Z" },
    title: { S: `Bill ${billNumber}` },
    subCategories: { L: [] },
    lifeAreas: { L: [] },
    sponsors: { L: [] },
    cosponsors: { L: [] },
  });

  it("ranks by score, not by the model's output order, and keeps the top N by score", async () => {
    mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
      const input = command.input ?? {};
      if (input.IndexName === "PriorityStatusIndex") return { Items: [] };
      if (isCompanionGroupsRead(input)) return {};
      if (input.TableName === "BillsManifest") {
        return { Items: [manifestRow("hr", "7"), manifestRow("hr", "400"), manifestRow("s", "20")] };
      }
      if (input.TableName === "BillPriority" && input.Item) return {};
      throw new Error(`Unexpected DynamoDB request: ${JSON.stringify(input)}`);
    });
    mockBedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                // Echoes the guid-sorted input order: lowest score first.
                bills: [
                  { guid: "BILLS-119hr400", isPriority: true, score: 76, confidence: 0.9, reason: "In the news." },
                  { guid: "BILLS-119hr7", isPriority: true, score: 80, confidence: 0.9, reason: "In the news." },
                  { guid: "BILLS-119s20", isPriority: true, score: 95, confidence: 0.9, reason: "In the news." },
                ],
              }),
            },
          ],
          stop_reason: "end_turn",
        }),
      ),
    });

    const { handler } = require("../handlers/billPriorityResolver");
    await handler();

    const puts = mockDynamoSend.mock.calls
      .map((call) => call[0].input)
      .filter((input) => input?.TableName === "BillPriority" && input?.Item?.status?.S === "ACTIVE");
    const rankOf = Object.fromEntries(puts.map((input) => [input.Item.guid.S, input.Item.priorityRank.N]));
    expect(rankOf).toEqual({ "BILLS-119s20": "1", "BILLS-119hr7": "2" });
  });
});

describe("billPriorityResolver prompts", () => {
  const {
    buildPriorityRequestBody,
    getSystemPrompt,
    getUserPrompt,
    parseBedrockResponse,
    sanitizePriorityReason,
    PRIORITY_REASON_MAX_CHARS,
  } = require("../handlers/billPriorityResolver/prompts");

  const NOW = new Date("2026-03-30T12:00:00.000Z");

  it("omits alreadyPriority and orders candidates by guid", () => {
    const prompt: string = getUserPrompt({
      headlines: [{ source: "AP", title: "Headline" }],
      candidates: [
        { guid: "BILLS-119s9is", billType: "s", title: "B", alreadyPriority: true, explicitHeadlineMatches: 2 },
        { guid: "BILLS-119hr1ih", billType: "hr", title: "A", alreadyPriority: false },
      ],
      maxResults: 3,
      now: NOW,
    });
    const payload = JSON.parse(prompt.slice(prompt.indexOf("{")));
    expect(payload.candidates.map((candidate: { guid: string }) => candidate.guid)).toEqual([
      "BILLS-119hr1ih",
      "BILLS-119s9is",
    ]);
    for (const candidate of payload.candidates) {
      expect(candidate).not.toHaveProperty("alreadyPriority");
    }
    expect(payload.candidates[1].explicitHeadlineMatches).toBe(2);
  });

  // LLM-11: the model has no clock of its own to judge how recent a headline is.
  it("opens with the current time, ahead of the payload, and sends only the headline fields the model reads", () => {
    const prompt: string = getUserPrompt({
      headlines: [{ source: "AP", title: "Headline", normalizedTitle: "headline", sourceKey: "ap" }],
      candidates: [{ guid: "BILLS-119hr1ih", billType: "hr", title: "A" }],
      maxResults: 3,
      now: NOW,
    });
    expect(prompt.split("\n\n")[0]).toBe("Current time: 2026-03-30T12:00:00.000Z.");
    expect(JSON.parse(prompt.slice(prompt.indexOf("{"))).headlines).toEqual([{ source: "AP", title: "Headline" }]);
  });

  // The 4.5 body is today's; 5.5 takes effort instead of sampling parameters, and "default" sends none.
  it.each([
    ["haiku-4-5", "low", ["anthropic_version", "max_tokens", "system", "messages"]],
    ["haiku-5-5", "low", ["anthropic_version", "max_tokens", "output_config", "system", "messages"]],
    ["haiku-5-5", "high", ["anthropic_version", "max_tokens", "output_config", "system", "messages"]],
    ["haiku-5-5", "default", ["anthropic_version", "max_tokens", "system", "messages"]],
  ])("builds the %s body at effort %s with one user turn and no sampling parameters", (profile, effort, keys) => {
    const headlines = [{ source: "AP", title: "Headline" }];
    const candidates = [{ guid: "BILLS-119hr1ih", billType: "hr", title: "A" }];
    const body = buildPriorityRequestBody(headlines, candidates, {
      profile,
      maxTokens: 4096,
      effort,
      now: NOW,
      maxResults: 3,
    });

    expect(Object.keys(body)).toEqual(keys);
    expect(body).toMatchObject({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      system: getSystemPrompt(),
    });
    expect(body.output_config).toEqual(keys.includes("output_config") ? { effort } : undefined);
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: getUserPrompt({ headlines, candidates, maxResults: 3, now: NOW }) }],
      },
    ]);
  });

  it("reads the bills object inside fences or prose, and an answer of no bills", () => {
    const bills = [
      { guid: "BILLS-119hr1ih", isPriority: true, score: 90.4, confidence: 1.2, reason: "AP leads with it." },
    ];
    const expected = {
      bills: [{ guid: "BILLS-119hr1ih", isPriority: true, score: 90, confidence: 1, reason: "AP leads with it." }],
    };

    expect(parseBedrockResponse(JSON.stringify({ bills }))).toEqual(expected);
    expect(parseBedrockResponse(`\`\`\`json\n${JSON.stringify({ bills })}\n\`\`\``)).toEqual(expected);
    expect(parseBedrockResponse(`Here are the bills:\n${JSON.stringify({ bills })}\nBoth lead the news.`)).toEqual(
      expected,
    );
    expect(parseBedrockResponse('{"bills":[]}')).toEqual({ bills: [] });
    // Entries missing a reason are dropped; what is left is still an answer.
    expect(parseBedrockResponse('{"bills":[{"guid":"BILLS-119hr1ih","score":90,"confidence":0.9}]}')).toEqual({
      bills: [],
    });
  });

  it.each([
    ["prose", "No bill is in the news today."],
    [
      "an answer cut after its first entry",
      '{"bills":[{"guid":"BILLS-119hr1ih","isPriority":true,"score":90,"confidence":0.9,"reason":"AP."},{"guid":"BI',
    ],
    ["an object without bills", '{"priority":[]}'],
    ["nothing", ""],
  ])("returns null for %s, so the caller can tell no answer from an answer of no bills", (_label, text) => {
    expect(parseBedrockResponse(text)).toBeNull();
  });

  it("caps reasons at 140 characters on a word boundary", () => {
    const reason = sanitizePriorityReason(`${"Outlets report steady coverage ".repeat(8)}today.`, 2);
    expect(reason.length).toBeLessThanOrEqual(PRIORITY_REASON_MAX_CHARS);
    expect(reason).toMatch(/coverage…$|report…$|steady…$|Outlets…$/);
    expect(sanitizePriorityReason("  Covered   by AP and Reuters.  ", 2)).toBe("Covered by AP and Reuters.");
  });

  it("replaces empty or loaded-word reasons with a neutral template", () => {
    expect(sanitizePriorityReason("A reckless handout, critics say.", 3)).toBe(
      "Named in 3 recent national news headlines.",
    );
    expect(sanitizePriorityReason("Congress finally acts on the loophole", 1)).toBe(
      "Named in 1 recent national news headline.",
    );
    expect(sanitizePriorityReason("", 0)).toBe("In recent national news coverage.");
  });
});

describe("billPriorityResolver companion groups (APPF-23)", () => {
  const HOUSE = "BILLS-119hr400";
  const SENATE = "BILLS-119s200";
  const OTHER = "BILLS-119hr7";
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        MANIFEST_TABLE_NAME: "BillsManifest",
        MANIFEST_PRIMARY_KEY: "pk",
        PRIORITY_TABLE_NAME: "BillPriority",
        PRIORITY_ACTIVE_INDEX_NAME: "PriorityStatusIndex",
        MODEL_ID: HAIKU_45_PROFILE_ARN,
        NEWS_FEED_URLS: "https://news.example/feed.xml",
        MAX_PRIORITY_RESULTS: "5",
        PRIORITY_MIN_SCORE: "75",
        PRIORITY_MIN_CONFIDENCE: "0.55",
      },
      { replace: true, base: originalEnv },
    );
    const recentHeadlineDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toUTCString();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        `<rss><channel><item><title>Congress races to pass H.R. 400 water bill</title><link>https://example.com/s</link><pubDate>${recentHeadlineDate}</pubDate></item></channel></rss>`,
    } as Response);
  });

  afterEach(() => {
    restoreEnv?.();
    jest.restoreAllMocks();
  });

  const manifestRow = (guid: string, billType: string, billNumber: string, updatedAt: string) => ({
    pk: { S: "BILL" },
    sk: { S: `${updatedAt}#${guid}` },
    guid: { S: guid },
    billType: { S: billType },
    congress: { S: "119" },
    billNumber: { S: billNumber },
    updatedAt: { S: updatedAt },
    title: { S: `Bill ${billNumber}` },
    subCategories: { L: [] },
    lifeAreas: { L: [] },
    sponsors: { L: [] },
    cosponsors: { L: [] },
  });

  const activeRecord = (guid: string, billType: string, billNumber: string) => ({
    guid: { S: guid },
    status: { S: "ACTIVE" },
    isPriority: { BOOL: true },
    congress: { S: "119" },
    billType: { S: billType },
    billNumber: { S: billNumber },
    title: { S: `Bill ${billNumber}` },
    updatedAt: { S: "2026-03-28T10:00:00.000Z" },
    priorityRank: { N: "1" },
    priorityUpdatedAt: { S: new Date().toISOString() },
    priorityExpiresAt: { S: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() },
    prioritySortKey: { S: `0001#${guid}` },
  });

  const route = (options: {
    houseUpdatedAt: string;
    senateUpdatedAt: string;
    enabled?: boolean;
    active?: Array<ReturnType<typeof activeRecord>>;
    rows?: Array<ReturnType<typeof manifestRow>>;
  }) =>
    mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
      const input = command.input ?? {};
      if (input.IndexName === "PriorityStatusIndex") return { Items: options.active ?? [] };
      if (isCompanionGroupsRead(input)) {
        return {
          Item: {
            pk: { S: "BILL_COMPANION_GROUPS" },
            sk: { S: "CURRENT" },
            pairsVersion: { N: "2" },
            enabled: { BOOL: options.enabled ?? true },
            pairs: { S: JSON.stringify(options.enabled === false ? [] : [[HOUSE, SENATE]]) },
          },
        };
      }
      if (input.TableName === "BillsManifest") {
        return {
          Items: [
            manifestRow(HOUSE, "hr", "400", options.houseUpdatedAt),
            manifestRow(SENATE, "s", "200", options.senateUpdatedAt),
            manifestRow(OTHER, "hr", "7", "2026-03-29T09:00:00.000Z"),
            ...(options.rows ?? []),
          ],
        };
      }
      if (input.TableName === "BillPriority" && input.Item) return {};
      throw new Error(`Unexpected DynamoDB request: ${JSON.stringify(input)}`);
    });

  const modelReturns = (guids: string[]) =>
    mockBedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                bills: guids.map((guid) => ({ guid, isPriority: true, score: 90, confidence: 0.9, reason: "News." })),
              }),
            },
          ],
          stop_reason: "end_turn",
        }),
      ),
    });

  const candidatesSent = () => {
    const request = JSON.parse(mockBedrockSend.mock.calls[0][0].input.body);
    const text: string = request.messages[0].content[0].text;
    return JSON.parse(text.slice(text.indexOf("{"))).candidates as Array<{
      guid: string;
      explicitHeadlineMatches?: number;
    }>;
  };

  const priorityPuts = () =>
    mockDynamoSend.mock.calls
      .map(([command]) => command.input)
      .filter((input) => input?.TableName === "BillPriority" && input?.Item)
      .map((input) => ({ guid: input.Item.guid.S, status: input.Item.status.S }));

  it("sends one candidate per pair: the newest member, with the pair's headline matches", async () => {
    route({ houseUpdatedAt: "2026-03-29T10:00:00.000Z", senateUpdatedAt: "2026-03-30T10:00:00.000Z" });
    modelReturns([SENATE]);

    const { handler } = require("../handlers/billPriorityResolver");
    const result = await handler();

    const candidates = candidatesSent();
    expect(candidates.map((candidate) => candidate.guid)).toEqual([OTHER, SENATE]);
    // The headline names H.R. 400; the Senate member stands for the pair and keeps the match.
    expect(candidates.find((candidate) => candidate.guid === SENATE)?.explicitHeadlineMatches).toBe(1);
    expect(result).toMatchObject({ candidateBills: 2, activated: 1 });
    expect(priorityPuts()).toEqual([{ guid: SENATE, status: "ACTIVE" }]);
  });

  it("keeps the primary on an exact tie", async () => {
    route({ houseUpdatedAt: "2026-03-30T10:00:00.000Z", senateUpdatedAt: "2026-03-30T10:00:00.000Z" });
    modelReturns([HOUSE]);

    const { handler } = require("../handlers/billPriorityResolver");
    await handler();

    expect(candidatesSent().map((candidate) => candidate.guid)).toEqual([HOUSE, OTHER]);
  });

  it("retires the partner's active record when the model picks the member standing for the pair", async () => {
    route({
      houseUpdatedAt: "2026-03-30T10:00:00.000Z",
      senateUpdatedAt: "2026-03-29T10:00:00.000Z",
      active: [activeRecord(SENATE, "s", "200")],
    });
    modelReturns([HOUSE]);

    const { handler } = require("../handlers/billPriorityResolver");
    await handler();

    expect(candidatesSent().map((candidate) => candidate.guid)).toEqual([HOUSE, OTHER]);
    expect(priorityPuts()).toEqual([
      { guid: HOUSE, status: "ACTIVE" },
      { guid: SENATE, status: "INACTIVE" },
    ]);
  });

  it("carries a pair's active record over once when the model picks neither member", async () => {
    route({
      houseUpdatedAt: "2026-03-30T10:00:00.000Z",
      senateUpdatedAt: "2026-03-29T10:00:00.000Z",
      active: [activeRecord(SENATE, "s", "200"), { ...activeRecord(HOUSE, "hr", "400"), priorityRank: { N: "2" } }],
    });
    modelReturns([OTHER]);

    const { handler } = require("../handlers/billPriorityResolver");
    await handler();

    expect(priorityPuts()).toEqual([
      { guid: OTHER, status: "ACTIVE" },
      { guid: SENATE, status: "ACTIVE" },
      { guid: HOUSE, status: "INACTIVE" },
    ]);
  });

  // REL-41: U9b left a second, suffixed manifest row for 29 bills, newer than the plain one, which the resolver may
  // have picked before the fix.
  it.each([
    ["on", true],
    ["off", false],
  ])(
    "ranks a bill once under its plain guid and retires its record under a suffixed guid (groups %s)",
    async (_label, enabled) => {
      const SUFFIXED = `${OTHER}rh`;
      route({
        houseUpdatedAt: "2026-03-30T10:00:00.000Z",
        senateUpdatedAt: "2026-03-29T10:00:00.000Z",
        enabled,
        rows: [manifestRow(SUFFIXED, "hr", "7", "2026-03-29T09:00:05.000Z")],
        active: [activeRecord(SUFFIXED, "hr", "7")],
      });
      modelReturns([OTHER]);

      const { handler } = require("../handlers/billPriorityResolver");
      await handler();

      const guids = candidatesSent().map((candidate) => candidate.guid);
      expect(guids.filter((guid) => guid.startsWith(OTHER))).toEqual([OTHER]);
      expect(priorityPuts()).toEqual([
        { guid: OTHER, status: "ACTIVE" },
        { guid: SUFFIXED, status: "INACTIVE" },
      ]);
    },
  );

  it("keeps the better ranked of two active records of one bill when the model picks neither", async () => {
    const SUFFIXED = `${OTHER}rh`;
    route({
      houseUpdatedAt: "2026-03-30T10:00:00.000Z",
      senateUpdatedAt: "2026-03-29T10:00:00.000Z",
      enabled: false,
      active: [{ ...activeRecord(SUFFIXED, "hr", "7"), priorityRank: { N: "2" } }, activeRecord(OTHER, "hr", "7")],
    });
    modelReturns([HOUSE]);

    const { handler } = require("../handlers/billPriorityResolver");
    await handler();

    expect(priorityPuts()).toEqual([
      { guid: HOUSE, status: "ACTIVE" },
      { guid: OTHER, status: "ACTIVE" },
      { guid: SUFFIXED, status: "INACTIVE" },
    ]);
  });

  it("sends every bill while the published groups are turned off", async () => {
    route({
      houseUpdatedAt: "2026-03-29T10:00:00.000Z",
      senateUpdatedAt: "2026-03-30T10:00:00.000Z",
      enabled: false,
    });
    modelReturns([HOUSE]);

    const { handler } = require("../handlers/billPriorityResolver");
    await handler();

    expect(candidatesSent().map((candidate) => candidate.guid)).toEqual([HOUSE, OTHER, SENATE]);
  });
});

// LLM-11: how the run reads Bedrock's answer. One bill is in the news, one priority record is still active
// and one has expired. An answer the run cannot use activates nothing, keeps the active record, retires the
// expired one, counts PriorityResolverNoAnswer and succeeds; a call that got no answer at all throws.
describe("billPriorityResolver Bedrock answers (LLM-11)", () => {
  const CANDIDATE = "BILLS-119hr400";
  const CARRIED = "BILLS-119hr500";
  const EXPIRED = "BILLS-119hr600is";
  let restoreEnv: (() => void) | undefined;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const useEnv = (overrides: Record<string, string | undefined> = {}) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        MANIFEST_TABLE_NAME: "BillsManifest",
        PRIORITY_TABLE_NAME: "BillPriority",
        PRIORITY_ACTIVE_INDEX_NAME: "PriorityStatusIndex",
        MODEL_ID: HAIKU_45_PROFILE_ARN,
        NEWS_FEED_URLS: "https://news.example/feed.xml",
        MAX_PRIORITY_RESULTS: "5",
        PRIORITY_MIN_SCORE: "75",
        PRIORITY_MIN_CONFIDENCE: "0.55",
        AWS_LAMBDA_LOG_FORMAT: undefined,
        LOG_LEVEL: undefined,
        ...overrides,
      },
      { replace: true, base: originalEnv },
    );
  };

  const priorityRecord = (guid: string, billNumber: string, rank: number, expiresAt: string) => ({
    guid: { S: guid },
    status: { S: "ACTIVE" },
    isPriority: { BOOL: true },
    congress: { S: "119" },
    billType: { S: "hr" },
    billNumber: { S: billNumber },
    title: { S: `Bill ${billNumber}` },
    updatedAt: { S: "2026-03-28T10:00:00.000Z" },
    priorityRank: { N: String(rank) },
    priorityUpdatedAt: { S: new Date().toISOString() },
    priorityExpiresAt: { S: expiresAt },
    prioritySortKey: { S: `000${rank}#${guid}` },
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockBedrockSend.mockReset();
    useEnv();
    logSpy = jest.spyOn(console, "log").mockImplementation();
    warnSpy = jest.spyOn(console, "warn").mockImplementation();
    errorSpy = jest.spyOn(console, "error").mockImplementation();

    const recentHeadlineDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toUTCString();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        `<rss><channel><item><title>Congress races to pass H.R. 400 funding bill</title><link>https://example.com/s</link><source>Reuters</source><pubDate>${recentHeadlineDate}</pubDate></item></channel></rss>`,
    } as Response);

    mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
      const input = command.input ?? {};
      if (input.IndexName === "PriorityStatusIndex") {
        return {
          Items: [
            priorityRecord(CARRIED, "500", 1, new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()),
            priorityRecord(EXPIRED, "600", 2, new Date(Date.now() - 60 * 60 * 1000).toISOString()),
          ],
        };
      }
      if (isCompanionGroupsRead(input)) return {};
      if (input.TableName === "BillsManifest") {
        return {
          Items: [
            {
              pk: { S: "BILL" },
              sk: { S: `2026-03-30T10:00:00.000Z#${CANDIDATE}` },
              guid: { S: CANDIDATE },
              billType: { S: "hr" },
              congress: { S: "119" },
              billNumber: { S: "400" },
              updatedAt: { S: "2026-03-30T10:00:00.000Z" },
              title: { S: "Government Funding Bill" },
              subCategories: { L: [] },
              lifeAreas: { L: [] },
              sponsors: { L: [] },
              cosponsors: { L: [] },
            },
          ],
        };
      }
      if (input.TableName === "BillPriority" && input.Item) return {};
      throw new Error(`Unexpected DynamoDB request: ${JSON.stringify(input)}`);
    });
  });

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
    jest.restoreAllMocks();
  });

  const THINKING = { type: "thinking", thinking: "", signature: "sig" };
  const PICK = { guid: CANDIDATE, isPriority: true, score: 91, confidence: 0.88, reason: "Leading national coverage." };
  const answerText = (bills: unknown[]) => ({ type: "text", text: JSON.stringify({ bills }) });

  const modelReturns = (fields: Record<string, unknown>) =>
    mockBedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(
        JSON.stringify({ stop_reason: "end_turn", usage: { input_tokens: 2100, output_tokens: 180 }, ...fields }),
      ),
    });

  const bedrockError = (name: string, httpStatusCode: number): Error =>
    Object.assign(new Error(`${name} message`), { name, $metadata: { httpStatusCode } });

  const loadHandler = () => require("../handlers/billPriorityResolver").handler;

  const sentRequest = () => mockBedrockSend.mock.calls[0][0].input;
  const sentBody = () => JSON.parse(sentRequest().body);
  const sentUserText = (): string => sentBody().messages[0].content[0].text;

  const priorityPuts = () =>
    mockDynamoSend.mock.calls
      .map(([command]) => command.input)
      .filter((input) => input?.TableName === "BillPriority" && input?.Item)
      .map((input) => ({ guid: input.Item.guid.S, status: input.Item.status.S }));

  const lines = (): LogLine[] => [...logLines(logSpy), ...logLines(warnSpy), ...logLines(errorSpy)];
  const eventLines = (event: string) => lines().filter((line) => line.event === event);
  const metricLines = (name: string) =>
    lines().filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/Bedrock" && name in line);

  it("activates from the text after Haiku 5.5's thinking block", async () => {
    useEnv({ MODEL_ID: HAIKU_55_PROFILE_ARN });
    modelReturns({ content: [THINKING, answerText([PICK])] });

    const result = await loadHandler()();

    expect(result).toEqual({
      status: "ok",
      headlinesProcessed: 1,
      candidateBills: 2,
      // No bill store in these tests: no raw bill is read (REL-51).
      titlesRead: 0,
      modelAnswer: "ok",
      activated: 1,
      carriedOver: 1,
      expired: 1,
    });
    expect(priorityPuts()).toEqual([
      { guid: CANDIDATE, status: "ACTIVE" },
      { guid: CARRIED, status: "ACTIVE" },
      { guid: EXPIRED, status: "INACTIVE" },
    ]);
    expect(eventLines("bedrock_call")).toEqual([
      expect.objectContaining({
        caller: "BillPriorityResolver",
        kind: "priority",
        modelId: HAIKU_55_PROFILE_ARN,
        requestProfile: "haiku-5-5",
        effort: "low",
        outcome: "ok",
        thinking_blocks: 1,
      }),
    ]);
    expect(metricLines("PriorityResolverNoAnswer")).toEqual([]);
  });

  it.each([
    [
      "refusal",
      { content: [answerText([PICK])], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } },
    ],
    ["max_tokens", { content: [THINKING], stop_reason: "max_tokens" }],
    ["incomplete", { content: [answerText([PICK])], stop_reason: "pause_turn" }],
    ["empty", { content: [THINKING] }],
    ["unparseable", { content: [{ type: "text", text: "No bill leads the news today." }] }],
  ])(
    "%s: no usable answer, so nothing is activated, the records carry over, it is counted and the run succeeds",
    async (reason, fields) => {
      useEnv({ MODEL_ID: HAIKU_55_PROFILE_ARN });
      modelReturns(fields);

      const result = await loadHandler()();

      expect(result).toEqual({
        status: "ok",
        headlinesProcessed: 1,
        candidateBills: 2,
        titlesRead: 0,
        modelAnswer: "none",
        noAnswerReason: reason,
        activated: 0,
        carriedOver: 1,
        expired: 1,
      });
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      expect(priorityPuts()).toEqual([
        { guid: CARRIED, status: "ACTIVE" },
        { guid: EXPIRED, status: "INACTIVE" },
      ]);
      expect(logLines(warnSpy).filter((line) => line.event === "priority_no_answer")).toEqual([
        expect.objectContaining({
          reason,
          stop_reason: (fields as { stop_reason?: string }).stop_reason ?? "end_turn",
          refusalCategory: reason === "refusal" ? "cyber" : null,
          output_tokens: 180,
          ...(reason === "unparseable" ? { preview: "No bill leads the news today." } : {}),
        }),
      ]);
      expect(eventLines("priority_answer")).toEqual([]);
      expect(metricLines("PriorityAnswerBills")).toEqual([]);
      expect(metricLines("PriorityResolverNoAnswer")).toEqual([
        expect.objectContaining({
          PriorityResolverNoAnswer: 1,
          reason,
          _aws: expect.objectContaining({
            CloudWatchMetrics: [
              {
                Namespace: "BillBoard/Bedrock",
                Dimensions: [[]],
                Metrics: [{ Name: "PriorityResolverNoAnswer", Unit: "Count" }],
              },
            ],
          }),
        }),
      ]);
    },
  );

  it("takes an answer of no bills as an answer: the active record carries over and nothing is counted", async () => {
    modelReturns({ content: [answerText([])] });

    const result = await loadHandler()();

    expect(result).toMatchObject({ modelAnswer: "ok", activated: 0, carriedOver: 1, expired: 1 });
    expect(result).not.toHaveProperty("noAnswerReason");
    expect(priorityPuts()).toEqual([
      { guid: CARRIED, status: "ACTIVE" },
      { guid: EXPIRED, status: "INACTIVE" },
    ]);
    expect(eventLines("priority_no_answer")).toEqual([]);
    expect(metricLines("PriorityResolverNoAnswer")).toEqual([]);
  });

  // What the model decided, as numbers and guids: a quiet hour reads differently from a broken one without a replay.
  describe("priority_answer", () => {
    const decision = (guid: string, score: number, confidence: number, extra: Record<string, unknown> = {}) => ({
      guid,
      isPriority: true,
      score,
      confidence,
      reason: "Leading national coverage.",
      ...extra,
    });
    const answerLines = () => eventLines("priority_answer");

    it("logs the candidates sent, the bills returned and passing, the top numbers and the guid activated", async () => {
      modelReturns({ content: [answerText([PICK])] });

      await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "ok", activated: 1 });

      expect(answerLines()).toEqual([
        expect.objectContaining({
          level: "INFO",
          message: "priority_answer",
          candidatesSent: 2,
          billsReturned: 1,
          billsPassing: 1,
          billsActivated: 1,
          activatedGuids: [CANDIDATE],
          topScore: 91,
          topConfidence: 0.88,
          answerEmpty: false,
          minScore: 75,
          minConfidence: 0.55,
        }),
      ]);
      // Numbers and guids only: neither a bill title nor the model's reason is logged here.
      const line = JSON.stringify(answerLines()[0]);
      expect(line).not.toContain("Government Funding Bill");
      expect(line).not.toContain(PICK.reason);
      expect(eventLines("priority_no_answer")).toEqual([]);
    });

    it("counts the answer in BillBoard/Bedrock, with no dimensions", async () => {
      modelReturns({ content: [answerText([PICK])] });

      await loadHandler()();

      expect(metricLines("PriorityAnswerBills")).toEqual([
        expect.objectContaining({
          PriorityAnswerBills: 1,
          PriorityPassingBills: 1,
          // REL-51: the pick was not in the news before the run (the carried record is another bill).
          PriorityNewPicks: 1,
          PriorityTopScore: 91,
          PriorityTopConfidence: 0.88,
          _aws: expect.objectContaining({
            CloudWatchMetrics: [
              {
                Namespace: "BillBoard/Bedrock",
                Dimensions: [[]],
                Metrics: [
                  { Name: "PriorityAnswerBills", Unit: "Count" },
                  { Name: "PriorityPassingBills", Unit: "Count" },
                  { Name: "PriorityNewPicks", Unit: "Count" },
                  { Name: "PriorityTopScore", Unit: "None" },
                  { Name: "PriorityTopConfidence", Unit: "None" },
                ],
              },
            ],
          }),
        }),
      ]);
    });

    it("logs an answer of no bills as empty, with no top and no top metric (a quiet hour)", async () => {
      modelReturns({ content: [answerText([])] });

      await loadHandler()();

      expect(answerLines()).toEqual([
        expect.objectContaining({
          candidatesSent: 2,
          billsReturned: 0,
          billsPassing: 0,
          billsActivated: 0,
          activatedGuids: [],
          topScore: null,
          topConfidence: null,
          answerEmpty: true,
        }),
      ]);
      const [metrics] = metricLines("PriorityAnswerBills");
      expect(metrics).toMatchObject({ PriorityAnswerBills: 0, PriorityPassingBills: 0, PriorityNewPicks: 0 });
      expect(metrics).not.toHaveProperty("PriorityTopScore");
      expect(metrics).not.toHaveProperty("PriorityTopConfidence");
      expect(metrics._aws!.CloudWatchMetrics[0].Metrics).toEqual([
        { Name: "PriorityAnswerBills", Unit: "Count" },
        { Name: "PriorityPassingBills", Unit: "Count" },
        { Name: "PriorityNewPicks", Unit: "Count" },
      ]);
    });

    it("shows a bill under the score bar as returned but not passing, whatever its confidence (a near miss)", async () => {
      // The prompt asks for only the bills that should be priority, so a returned bill usually carries a
      // confidence above the bar: a near miss is read from topScore alone (RUNBOOK 11.7).
      modelReturns({ content: [answerText([decision(CANDIDATE, 70, 0.8)])] });

      const result = await loadHandler()();

      expect(result).toMatchObject({ modelAnswer: "ok", activated: 0 });
      expect(answerLines()).toEqual([
        expect.objectContaining({
          billsReturned: 1,
          billsPassing: 0,
          billsActivated: 0,
          activatedGuids: [],
          topScore: 70,
          topConfidence: 0.8,
          minScore: 75,
          minConfidence: 0.55,
          answerEmpty: false,
        }),
      ]);
    });

    it("shows bills that each fell short on one threshold as returned but not passing, with tops from different bills", async () => {
      modelReturns({ content: [answerText([decision(CANDIDATE, 70, 0.9), decision(CARRIED, 90, 0.5)])] });

      const result = await loadHandler()();

      expect(result).toMatchObject({ modelAnswer: "ok", activated: 0 });
      expect(answerLines()).toEqual([
        expect.objectContaining({
          billsReturned: 2,
          billsPassing: 0,
          billsActivated: 0,
          activatedGuids: [],
          topScore: 90,
          topConfidence: 0.9,
          answerEmpty: false,
        }),
      ]);
      expect(metricLines("PriorityAnswerBills")).toEqual([
        expect.objectContaining({
          PriorityAnswerBills: 2,
          PriorityPassingBills: 0,
          PriorityTopScore: 90,
          PriorityTopConfidence: 0.9,
        }),
      ]);
    });

    it("does not count a bill the model marked isPriority false, though it counts as returned", async () => {
      modelReturns({
        content: [answerText([decision(CARRIED, 95, 0.8, { isPriority: false }), decision(CANDIDATE, 80, 0.7)])],
      });

      await loadHandler()();

      expect(answerLines()).toEqual([
        expect.objectContaining({
          billsReturned: 2,
          billsPassing: 1,
          activatedGuids: [CANDIDATE],
          topScore: 95,
          topConfidence: 0.8,
        }),
      ]);
    });

    it("does not count a bill the model was never sent", async () => {
      modelReturns({ content: [answerText([decision("BILLS-119hr999", 99, 0.99), decision(CANDIDATE, 80, 0.7)])] });

      await loadHandler()();

      expect(answerLines()).toEqual([
        expect.objectContaining({
          billsReturned: 2,
          billsPassing: 1,
          activatedGuids: [CANDIDATE],
          topScore: 99,
          topConfidence: 0.99,
        }),
      ]);
    });

    it("lists the activated guids by rank, not in the order the model wrote them", async () => {
      modelReturns({ content: [answerText([decision(CARRIED, 85, 0.7), decision(CANDIDATE, 91, 0.88)])] });

      await loadHandler()();

      expect(answerLines()).toEqual([
        expect.objectContaining({ billsPassing: 2, billsActivated: 2, activatedGuids: [CANDIDATE, CARRIED] }),
      ]);
    });

    it("counts every passing bill but lists only those MAX_PRIORITY_RESULTS lets through", async () => {
      useEnv({ MAX_PRIORITY_RESULTS: "1" });
      modelReturns({ content: [answerText([decision(CARRIED, 85, 0.7), decision(CANDIDATE, 91, 0.88)])] });

      await expect(loadHandler()()).resolves.toMatchObject({ activated: 1 });

      expect(answerLines()).toEqual([
        expect.objectContaining({
          billsPassing: 2,
          billsActivated: 1,
          activatedGuids: [CANDIDATE],
        }),
      ]);
      expect(metricLines("PriorityAnswerBills")).toEqual([expect.objectContaining({ PriorityPassingBills: 2 })]);
    });

    it("reads PRIORITY_MIN_SCORE and PRIORITY_MIN_CONFIDENCE, and logs them", async () => {
      useEnv({ PRIORITY_MIN_SCORE: "60", PRIORITY_MIN_CONFIDENCE: "0.4" });
      modelReturns({ content: [answerText([decision(CANDIDATE, 65, 0.45)])] });

      await loadHandler()();

      expect(answerLines()).toEqual([
        expect.objectContaining({ billsPassing: 1, activatedGuids: [CANDIDATE], minScore: 60, minConfidence: 0.4 }),
      ]);
    });

    it("is logged before the records are written, so a failed write leaves the decision in the logs", async () => {
      const base = mockDynamoSend.getMockImplementation()!;
      mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
        if (command.input?.TableName === "BillPriority" && command.input?.Item) throw new Error("write failed");
        return base(command);
      });
      modelReturns({ content: [answerText([PICK])] });

      await expect(loadHandler()()).rejects.toThrow("write failed");

      expect(answerLines()).toEqual([expect.objectContaining({ billsPassing: 1, activatedGuids: [CANDIDATE] })]);
    });

    it("is not logged when no headline was found, since the model was not asked", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "<rss><channel></channel></rss>",
      } as Response);

      await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "not_asked" });

      expect(mockBedrockSend).not.toHaveBeenCalled();
      expect(answerLines()).toEqual([]);
      expect(metricLines("PriorityAnswerBills")).toEqual([]);
    });
  });

  it("throws on a rejected request without a retry or any write", async () => {
    mockBedrockSend.mockRejectedValue(bedrockError("ValidationException", 400));

    await expect(loadHandler()()).rejects.toMatchObject({
      name: "BedrockCallError",
      kind: "invalid_request",
      httpStatus: 400,
    });
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(priorityPuts()).toEqual([]);
    expect(metricLines("BedrockRequestRejected")).toHaveLength(1);
    expect(metricLines("PriorityResolverNoAnswer")).toEqual([]);
  });

  it("retries a throttle", async () => {
    useEnv({ BEDROCK_BASE_DELAY_MS: "1", BEDROCK_MAX_DELAY_MS: "2" });
    mockBedrockSend.mockRejectedValueOnce(bedrockError("ThrottlingException", 429));
    modelReturns({ content: [answerText([PICK])] });

    await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "ok", activated: 1 });
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  });

  it("throws without writing once BEDROCK_MAX_RETRIES throttle retries are used", async () => {
    useEnv({ BEDROCK_MAX_RETRIES: "1", BEDROCK_BASE_DELAY_MS: "1", BEDROCK_MAX_DELAY_MS: "2" });
    mockBedrockSend.mockRejectedValue(bedrockError("ThrottlingException", 429));

    await expect(loadHandler()()).rejects.toMatchObject({ name: "BedrockCallError", kind: "throttled" });
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
    expect(priorityPuts()).toEqual([]);
  });

  // The 75 s call deadline also ends 5 s before the invocation would (Lambda timeout 120 s).
  it.each([
    ["no context", undefined, 75_000],
    ["100 s left", 100_000, 75_000],
    ["60 s left", 60_000, 55_000],
  ])(
    "gives the call a deadline from BEDROCK_CALL_TIMEOUT_MS and the time left (%s)",
    async (_label, left, timeoutMs) => {
      const timeoutSpy = jest.spyOn(AbortSignal, "timeout");
      modelReturns({ content: [answerText([PICK])] });

      await loadHandler()(undefined, left === undefined ? undefined : { getRemainingTimeInMillis: () => left });

      // The feed fetch takes its own 10 s signal first.
      expect(timeoutSpy.mock.calls.map(([ms]) => ms).at(-1)).toBe(timeoutMs);
      expect(mockBedrockSend.mock.calls[0][1]).toEqual({ abortSignal: expect.any(AbortSignal) });
    },
  );

  it("starts no call with under 20 s left, and throws without writing", async () => {
    await expect(loadHandler()(undefined, { getRemainingTimeInMillis: () => 15_000 })).rejects.toMatchObject({
      name: "BedrockCallError",
      kind: "timeout",
    });
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(priorityPuts()).toEqual([]);
  });

  it.each([
    [
      "Haiku 4.5 (today's body, MAX_OUTPUT_TOKENS from env)",
      { MODEL_ID: HAIKU_45_PROFILE_ARN, MAX_OUTPUT_TOKENS: "3000" },
      ["anthropic_version", "max_tokens", "system", "messages"],
      3000,
    ],
    [
      "Haiku 5.5 (effort low, 4096 tokens by default)",
      { MODEL_ID: HAIKU_55_PROFILE_ARN },
      ["anthropic_version", "max_tokens", "output_config", "system", "messages"],
      4096,
    ],
  ])(
    "sends the body for %s, never temperature or fallbacks, ending with the user turn",
    async (_label, env, keys, maxTokens) => {
      useEnv(env);
      modelReturns({ content: [answerText([PICK])] });

      await loadHandler()();

      const body = sentBody();
      expect(sentRequest().modelId).toBe(env.MODEL_ID);
      expect(Object.keys(body)).toEqual(keys);
      expect(body.max_tokens).toBe(maxTokens);
      expect(body.output_config).toEqual(keys.includes("output_config") ? { effort: "low" } : undefined);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({ role: "user", content: [{ type: "text" }] });
    },
  );

  it("tells the model the time and logs the payload it was sent (priority_request)", async () => {
    modelReturns({ content: [answerText([PICK])] });
    const startedAt = Date.now();

    await loadHandler()();

    const text = sentUserText();
    const [timeLine] = text.split("\n\n");
    const now = /^Current time: (\S+)\.$/.exec(timeLine)?.[1] ?? "";
    expect(Date.parse(now)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(now)).toBeLessThanOrEqual(Date.now());

    const [request] = eventLines("priority_request");
    expect(request).toMatchObject({ level: "INFO", now, maxResults: 5 });
    expect(request.payload).toEqual(JSON.parse(text.slice(text.indexOf("{"))));
    expect(
      (request.payload as { candidates: Array<{ guid: string }> }).candidates.map(
        (candidate: { guid: string }) => candidate.guid,
      ),
    ).toEqual([CANDIDATE, CARRIED]);
  });

  it.each([
    ["MODEL_ID", "test-model", "Unknown Bedrock model profile: test-model"],
    ["BEDROCK_EFFORT", "max", "Invalid Bedrock effort: max"],
  ])("fails at cold start on an unknown %s", (name, value, message) => {
    useEnv({ [name]: value });

    expect(loadHandler).toThrow(message);
  });
});
