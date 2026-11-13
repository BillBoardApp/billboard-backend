process.env.BUCKET_NAME = "test-bucket"; // Set BUCKET_NAME before imports
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handler } from "../handlers/fetchProcessedBill";
import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { HELD_FOR_REVIEW_CASES } from "./fixtures/heldForReview";
import { CURATED_OVERRIDE_CASES } from "./fixtures/curatedCeremonialOverrides";
import { applyTestEnv } from "./fixtures/env";

/** What the fake S3 sends read from a command: the input's key. */
interface S3Command {
  input: { Key?: string };
}

/** What the fake DynamoDB reads from a command: the input's table and key. */
interface DdbCommand {
  input?: { TableName?: string; Key?: { pk?: { S?: string } } };
}

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
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    GetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
    __mockSend: mockSend,
  };
});

describe("fetchProcessedBill handler", () => {
  const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-s3");

  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv?.();
    restoreEnv = applyTestEnv({ BUCKET_NAME: "test-bucket" });
  });

  afterEach(() => {
    restoreEnv?.();
  });

  it("should return 400 if congress, type, or bill_id is missing", async () => {
    const event = { queryStringParameters: {} };

    jest.resetModules();
    const { handler: priorityHandler } = require("../handlers/fetchProcessedBill");
    const result = await priorityHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Missing guid, or congress/type/bill_id" });
  });

  it("should return 200 with the bill content if found", async () => {
    const processedBill = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: new Date().toISOString(),
      identifier: { congress: "118", billType: "house-bill", billNumber: "1234" },
      guid: "BILLS-118hr1234is",
      title: "Bill title",
      link: "https://example.com/bill",
      soWhat: "Why it matters",
      billBreakdown: {
        who: "Citizens",
        what: "Test bill",
        how: "Through legislation",
        when: "Immediately",
        where: "Not Applicable",
        why: "Testing",
      },
      bodyText: "Full text",
      billXml: "<xml>Full bill xml</xml>",
      actions: [],
      committees: [],
      subCategories: ["Education"],
      lifeAreas: ["Work"],
      sponsors: ["A123"],
      cosponsors: ["B456"],
    };

    mockSend.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(JSON.stringify(processedBill)),
      },
    });

    const event = {
      queryStringParameters: {
        guid: "BILLS-118hr1234is",
        congress: "118",
        type: "house-bill",
      },
    };

    const result = await handler(asApiGatewayEvent(event));

    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ "Content-Type": "application/json" });
    // Served under its plain guid, the one the app keys the bill by, though stored with a text-version suffix.
    expect(JSON.parse(result.body)).toEqual({ ...processedBill, guid: "BILLS-118hr1234" });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "test-bucket",
          Key: "processed-bills/BILLS-118hr1234.json",
        }),
      }),
    );
  });

  it.each([
    [
      "a ceremonial resolution without its topics or life areas (S6)",
      { billType: "hres", officialTitle: "Expressing support for the designation of Community Health Workers Week." },
      false,
    ],
    [
      "a ceremonial resolution typed by its slug without its topics or life areas",
      { billType: "house-resolution", officialTitle: "Recognizing National Apprenticeship Week." },
      false,
    ],
    [
      "a resolution that condemns with its topics and life areas",
      { billType: "hres", officialTitle: "Condemning the rise in drug prices and recognizing those harmed." },
      true,
    ],
    [
      "a censure with its topics and life areas",
      { billType: "hres", officialTitle: "Censuring Representative Doe." },
      true,
    ],
    [
      "an impeachment with its topics and life areas",
      { billType: "hres", officialTitle: "Impeaching Judge Roe for high crimes and misdemeanors." },
      true,
    ],
    [
      "a resolution that is not ceremonial with its topics and life areas",
      {
        billType: "hres",
        officialTitle: "Providing for consideration of the bill (H.R. 77) to amend the Clean Air Act.",
      },
      true,
    ],
    [
      "a bill that designates a facility with its topics and life areas",
      { billType: "hr", officialTitle: "To designate the facility." },
      true,
    ],
  ])("serves %s, as its manifest row has them", async (_name, { billType, officialTitle }, keepsLabels) => {
    const stored = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-10-20T15:00:00.000Z",
      identifier: { congress: "119", billType, billNumber: "1187" },
      guid: `BILLS-119${billType === "house-resolution" ? "hres" : billType}1187`,
      title: "Recognize Community Health Workers Week",
      officialTitle,
      link: "https://example.com/bill",
      soWhat: "No law changes.",
      subCategories: ["Healthcare"],
      lifeAreas: ["Medical Costs"],
      sponsors: ["B001318"],
      cosponsors: [],
      actions: [],
      committees: [],
    };
    mockSend.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(stored)) },
    });

    const result = await handler(asApiGatewayEvent({ queryStringParameters: { guid: stored.guid } }));

    expect(result.statusCode).toBe(200);
    // Every other field is served as stored; the keys stay, so both apps decode the lists (required in both).
    expect(JSON.parse(result.body)).toEqual(keepsLabels ? stored : { ...stored, subCategories: [], lifeAreas: [] });
  });

  // The curated overrides of 2026-10-29 (RUNBOOK 4.12), as each bill is stored now and once a re-summary stores
  // Congress's title: served as its manifest row is written.
  it.each(CURATED_OVERRIDE_CASES)(
    "serves %s as its curated override decides, by %s",
    async (_guid, _titles, decision) => {
      const { guid, billType, billNumber, headline, officialTitle, ceremonial } = decision;
      const stored = {
        schemaVersion: 1,
        kind: "processed",
        storedAt: "2026-10-20T15:00:00.000Z",
        identifier: { congress: "119", billType, billNumber },
        guid,
        title: headline,
        ...(officialTitle ? { officialTitle } : {}),
        link: "https://example.com/bill",
        soWhat: "No law changes.",
        subCategories: decision.subCategories,
        lifeAreas: decision.lifeAreas,
        sponsors: ["B001318"],
        cosponsors: [],
        actions: [],
        committees: [],
      };
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(stored)) },
      });

      const result = await handler(asApiGatewayEvent({ queryStringParameters: { guid } }));

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual(ceremonial ? { ...stored, subCategories: [], lifeAreas: [] } : stored);
    },
  );

  it.each(HELD_FOR_REVIEW_CASES)(
    "serves %s's lists while it is held for review, by %s",
    async (_guid, _titles, held) => {
      const { guid, billType, billNumber, headline, officialTitle } = held;
      const stored = {
        schemaVersion: 1,
        kind: "processed",
        storedAt: "2026-10-20T15:00:00.000Z",
        identifier: { congress: "119", billType, billNumber },
        guid,
        title: headline,
        ...(officialTitle ? { officialTitle } : {}),
        link: "https://example.com/bill",
        soWhat: "No law changes.",
        subCategories: ["Elections and Voting"],
        lifeAreas: ["Medical Costs"],
        sponsors: ["B001318"],
        cosponsors: [],
        actions: [],
        committees: [],
      };
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(stored)) },
      });

      const result = await handler(asApiGatewayEvent({ queryStringParameters: { guid } }));

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual(stored);
    },
  );

  it("should return 404 if the bill is not found", async () => {
    mockSend.mockRejectedValueOnce(new Error("Not Found"));

    const event = {
      queryStringParameters: {
        guid: "BILLS-118hr1234is",
        congress: "118",
        type: "house-bill",
      },
    };

    const result = await handler(asApiGatewayEvent(event));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: "Bill not found" });
  });

  describe("input validation (SEC-12)", () => {
    it.each([
      ["../../etc/passwd"],
      ["BILLS-119hr1234/../../x"],
      ["not-a-guid"],
      ["BILLS-119hr"],
      [`BILLS-${"9".repeat(80)}hr1`],
    ])("returns 400 without touching S3 for guid %p", async (guid) => {
      const result = await handler(asApiGatewayEvent({ queryStringParameters: { guid } }));

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ error: "Invalid guid" });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      [{ congress: "119/..", type: "hr", bill_id: "1" }],
      [{ congress: "119", type: "hr/../x", bill_id: "1" }],
      [{ congress: "119", type: "hr", bill_id: "1.json" }],
      [{ congress: "1190", type: "hr", bill_id: "1" }],
    ])("returns 400 without touching S3 for locator %p", async (params) => {
      const result = await handler(asApiGatewayEvent({ queryStringParameters: params }));

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ error: "Invalid congress/type/bill_id" });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("trims a whitespace-padded guid before using it", async () => {
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToString: jest
            .fn()
            .mockResolvedValue(JSON.stringify({ guid: "BILLS-118hr1234is", actions: [], committees: [] })),
        },
      });

      const result = await handler(asApiGatewayEvent({ queryStringParameters: { guid: " BILLS-118hr1234is " } }));

      expect(result.statusCode).toBe(200);
      expect(mockSend.mock.calls[0][0].input.Key).toBe("processed-bills/BILLS-118hr1234.json");
    });

    it("ignores an unusable locator next to a valid guid instead of rejecting the request", async () => {
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToString: jest
            .fn()
            .mockResolvedValue(JSON.stringify({ guid: "BILLS-118hr1234is", actions: [], committees: [] })),
        },
      });

      const result = await handler(
        asApiGatewayEvent({
          queryStringParameters: { guid: "BILLS-118hr1234is", congress: "118", type: "H.R." },
        }),
      );

      expect(result.statusCode).toBe(200);
      const keys = mockSend.mock.calls.map(([command]: [S3Command]) => command.input.Key);
      expect(keys).toEqual(["processed-bills/BILLS-118hr1234.json"]);
    });

    it("serves the locator-only path when every part is well formed", async () => {
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToString: jest
            .fn()
            .mockResolvedValue(JSON.stringify({ guid: "BILLS-118hr1234is", actions: [], committees: [] })),
        },
      });

      const result = await handler(
        asApiGatewayEvent({ queryStringParameters: { congress: "118", type: "house-bill", bill_id: "1234" } }),
      );

      expect(result.statusCode).toBe(200);
      expect(mockSend.mock.calls[0][0].input.Key).toBe("processed-bills/congress-118/house-bill/1234.json");
    });
  });

  it("merges active priority metadata into the processed bill response", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv({
      BUCKET_NAME: "test-bucket",
      PRIORITY_TABLE_NAME: "BillPriority",
      PRIORITY_TABLE_PARTITION_KEY: "guid",
    });

    const processedBill = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: new Date().toISOString(),
      identifier: { congress: "118", billType: "hr", billNumber: "1234" },
      guid: "BILLS-118hr1234is",
      title: "Bill title",
      link: "https://example.com/bill",
      soWhat: "Why it matters",
      billBreakdown: {
        who: "Citizens",
        what: "Test bill",
        how: "Through legislation",
        when: "Immediately",
        where: "Not Applicable",
        why: "Testing",
      },
      actions: [],
      committees: [],
      subCategories: ["Education"],
      lifeAreas: ["Work"],
      sponsors: ["A123"],
      cosponsors: ["B456"],
    };

    jest.resetModules();
    const { __mockSend: activeS3Send } = jest.requireMock("@aws-sdk/client-s3");
    const { __mockSend: activeDdbSend } = jest.requireMock("@aws-sdk/client-dynamodb");

    activeS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(JSON.stringify(processedBill)),
      },
    });
    activeDdbSend.mockResolvedValueOnce({
      Item: {
        guid: { S: "BILLS-118hr1234" },
        status: { S: "ACTIVE" },
        isPriority: { BOOL: true },
        priorityRank: { N: "2" },
        priorityReason: { S: "Heavy national coverage" },
        priorityExpiresAt: { S: "2099-03-08T00:00:00.000Z" },
        priorityUpdatedAt: { S: "2026-03-07T12:00:00.000Z" },
      },
    });

    const event = {
      queryStringParameters: {
        guid: "BILLS-118hr1234is",
      },
    };

    const { handler: priorityHandler } = require("../handlers/fetchProcessedBill");
    const result = await priorityHandler(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      guid: "BILLS-118hr1234",
      isPriority: true,
      priorityRank: 2,
      priorityReason: "Heavy national coverage",
    });
    expect(activeDdbSend.mock.calls[0][0].input).toEqual({
      TableName: "BillPriority",
      Key: { guid: { S: "BILLS-118hr1234" } },
    });
  });

  it("serves a bill stored with a suffixed guid under the plain guid the app asks for, with its priority", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv({
      BUCKET_NAME: "test-bucket",
      PRIORITY_TABLE_NAME: "BillPriority",
      PRIORITY_TABLE_PARTITION_KEY: "guid",
    });
    jest.resetModules();
    const { __mockSend: activeS3Send } = jest.requireMock("@aws-sdk/client-s3");
    const { __mockSend: activeDdbSend } = jest.requireMock("@aws-sdk/client-dynamodb");
    activeS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest
          .fn()
          .mockResolvedValue(
            JSON.stringify({ guid: "BILLS-119hr1181rh", title: "Bill title", actions: [], committees: [] }),
          ),
      },
    });
    activeDdbSend.mockImplementation(async (command: DdbCommand) =>
      command.input?.TableName === "BillPriority"
        ? {
            Item: {
              guid: { S: "BILLS-119hr1181" },
              status: { S: "ACTIVE" },
              isPriority: { BOOL: true },
              priorityRank: { N: "1" },
              priorityReason: { S: "Heavy national coverage" },
              priorityExpiresAt: { S: "2099-03-08T00:00:00.000Z" },
              priorityUpdatedAt: { S: "2026-03-07T12:00:00.000Z" },
            },
          }
        : {},
    );

    const { handler: plainHandler } = require("../handlers/fetchProcessedBill");
    const result = await plainHandler(asApiGatewayEvent({ queryStringParameters: { guid: "BILLS-119hr1181" } }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ guid: "BILLS-119hr1181", isPriority: true, priorityRank: 1 });
    expect(activeS3Send.mock.calls[0][0].input.Key).toBe("processed-bills/BILLS-119hr1181.json");
    const priorityReads = activeDdbSend.mock.calls.filter(
      ([command]: [DdbCommand]) => command.input?.TableName === "BillPriority",
    );
    expect(priorityReads.map(([command]: [DdbCommand]) => command.input?.Key)).toEqual([
      { guid: { S: "BILLS-119hr1181" } },
    ]);
  });
});

describe("fetchProcessedBill companion group (APPF-23)", () => {
  const GROUP = {
    primaryGuid: "BILLS-119hr1285",
    memberGuids: ["BILLS-119hr1285", "BILLS-119s570"],
    relationship: "identical",
  };
  const processed = (guid: string) => ({
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-09-01T00:00:00.000Z",
    identifier: { congress: "119", billType: "s", billNumber: "570" },
    guid,
    title: "Water Infrastructure Subcontractor and Taxpayer Protection Act",
    link: "https://example.com/bill",
    soWhat: "Why it matters",
    billBreakdown: { who: "", what: "", how: "", when: "", where: "", why: "" },
    subCategories: [],
    lifeAreas: [],
    sponsors: [],
    cosponsors: [],
    actions: [],
    committees: [],
  });
  const current = (enabled: boolean) => ({
    Item: {
      pk: { S: "BILL_COMPANION_GROUPS" },
      sk: { S: "CURRENT" },
      pairsVersion: { N: "1" },
      enabled: { BOOL: enabled },
      pairs: { S: JSON.stringify([["BILLS-119hr1285", "BILLS-119s570"]]) },
    },
  });

  let restoreEnv: (() => void) | undefined;
  let s3Send: jest.Mock;
  let ddbSend: jest.Mock;
  let fetchHandler: typeof handler;

  const load = (currentResponse: () => Promise<unknown>) => {
    jest.resetModules();
    s3Send = jest.requireMock("@aws-sdk/client-s3").__mockSend;
    ddbSend = jest.requireMock("@aws-sdk/client-dynamodb").__mockSend;
    s3Send.mockReset();
    ddbSend.mockReset();
    ddbSend.mockImplementation(async (command: DdbCommand) =>
      command.input?.Key?.pk?.S === "BILL_COMPANION_GROUPS" ? currentResponse() : {},
    );
    fetchHandler = require("../handlers/fetchProcessedBill").handler;
  };
  const serve = (guid: string) =>
    s3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(processed(guid))) },
    });

  beforeEach(() => {
    restoreEnv = applyTestEnv({ BUCKET_NAME: "test-bucket" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv?.();
  });

  it("adds companionGroup for a grouped plain guid, and changes nothing else (acceptance 12)", async () => {
    load(async () => current(true));
    serve("BILLS-119s570");

    const result = await fetchHandler(asApiGatewayEvent({ queryStringParameters: { guid: "BILLS-119s570" } }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ...processed("BILLS-119s570"), companionGroup: GROUP });
    expect(ddbSend.mock.calls[0][0].input).toEqual({
      TableName: "BillsManifest",
      Key: { pk: { S: "BILL_COMPANION_GROUPS" }, sk: { S: "CURRENT" } },
      ConsistentRead: true,
    });
  });

  it("normalizes a suffixed guid, and serves a locator lookup too", async () => {
    load(async () => current(true));
    serve("BILLS-119hr1285ih");
    const suffixed = await fetchHandler(asApiGatewayEvent({ queryStringParameters: { guid: "BILLS-119hr1285ih" } }));
    expect(JSON.parse(suffixed.body).companionGroup).toEqual(GROUP);

    serve("BILLS-119s570is");
    const byLocator = await fetchHandler(
      asApiGatewayEvent({ queryStringParameters: { congress: "119", type: "s", bill_id: "570" } }),
    );
    expect(JSON.parse(byLocator.body).companionGroup).toEqual(GROUP);
    // The second request was served from the 60-second cache.
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("adds nothing for an ungrouped bill or when the groups are disabled", async () => {
    load(async () => current(true));
    serve("BILLS-119hr77");
    const ungrouped = await fetchHandler(asApiGatewayEvent({ queryStringParameters: { guid: "BILLS-119hr77" } }));
    expect(JSON.parse(ungrouped.body)).toEqual(processed("BILLS-119hr77"));

    load(async () => current(false));
    serve("BILLS-119s570");
    const disabled = await fetchHandler(asApiGatewayEvent({ queryStringParameters: { guid: "BILLS-119s570" } }));
    expect(JSON.parse(disabled.body)).toEqual(processed("BILLS-119s570"));
  });

  it("still answers the bill, without the field, when the groups cannot be read", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    load(async () => {
      throw new Error("AccessDeniedException");
    });
    serve("BILLS-119s570");

    const result = await fetchHandler(asApiGatewayEvent({ queryStringParameters: { guid: "BILLS-119s570" } }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(processed("BILLS-119s570"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Could not read the companion groups"));
  });
});

// INT-11: results (every aggregate of Billboard users' votes) are served only by the Cognito GET /bill-stats,
// after the caller's own vote. This handler also answers the share site's unauthenticated
// /public/processed-bill, which CloudFront caches and cannot gate per user, so it must never carry them.
// Congress's own roll calls (officialVotes) are not Billboard users' votes and stay public.
describe("the public processed bill carries no Billboard-user vote data (INT-11)", () => {
  const CONTRACTS_DIR = join(__dirname, "../../../contracts");
  const schema = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, "schemas/entities/processed-bill.v1.schema.json"), "utf8"),
  );
  const fixture = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, "fixtures/entities/processed-bill.v1.valid.json"), "utf8"),
  );
  const USER_VOTE_FIELD =
    /^(votes?|voteCounts?|voters|stats|billStats|results|totals|segments|rollups|comparison|reasonBreakdown|consensus|trend|.*(yea|nay|abstain).*)$/i;

  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv?.();
  });

  it("the processed-bill contract is closed and names no Billboard-user vote field", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).filter((key) => USER_VOTE_FIELD.test(key))).toEqual([]);
    expect(Object.keys(schema.properties)).toContain("officialVotes");
  });

  it("serves only contract fields, with a priority and a companion group merged in", async () => {
    restoreEnv = applyTestEnv({
      BUCKET_NAME: "test-bucket",
      PRIORITY_TABLE_NAME: "BillPriority",
      PRIORITY_TABLE_PARTITION_KEY: "guid",
    });
    const stored = { ...fixture };
    for (const merged of ["companionGroup", "isPriority", "priorityRank", "priorityReason", "priorityExpiresAt"]) {
      delete stored[merged];
    }

    jest.resetModules();
    const s3Send: jest.Mock = jest.requireMock("@aws-sdk/client-s3").__mockSend;
    const ddbSend: jest.Mock = jest.requireMock("@aws-sdk/client-dynamodb").__mockSend;
    s3Send.mockReset();
    ddbSend.mockReset();
    s3Send.mockResolvedValueOnce({ Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(stored)) } });
    ddbSend.mockImplementation(async (command: DdbCommand) => {
      const input = command.input ?? {};
      if (input.TableName === "BillPriority") {
        return {
          Item: {
            guid: { S: "BILLS-119hr1285" },
            status: { S: "ACTIVE" },
            isPriority: { BOOL: true },
            priorityRank: { N: "1" },
            priorityReason: { S: "In the news" },
            priorityExpiresAt: { S: "2099-01-01T00:00:00.000Z" },
            priorityUpdatedAt: { S: "2026-10-17T00:00:00.000Z" },
          },
        };
      }
      if (input.Key?.pk?.S === "BILL_COMPANION_GROUPS") {
        return {
          Item: {
            pk: { S: "BILL_COMPANION_GROUPS" },
            sk: { S: "CURRENT" },
            pairsVersion: { N: "1" },
            enabled: { BOOL: true },
            pairs: { S: JSON.stringify([["BILLS-119hr1285", "BILLS-119s570"]]) },
          },
        };
      }
      throw new Error(`Unexpected call: ${JSON.stringify(input)}`);
    });
    const { handler: publicHandler } = require("../handlers/fetchProcessedBill");

    const result = await publicHandler(asApiGatewayEvent({ queryStringParameters: { guid: "BILLS-119hr1285ih" } }));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body).toMatchObject({ isPriority: true, companionGroup: { primaryGuid: "BILLS-119hr1285" } });
    expect(Object.keys(body).filter((key) => !(key in schema.properties))).toEqual([]);
    expect(body.officialVotes).toEqual(fixture.officialVotes);
    // Only the priority row and the companion groups row are read: no vote row, no stats document.
    expect(ddbSend.mock.calls.map(([command]: [DdbCommand]) => command.input?.TableName).sort()).toEqual([
      "BillPriority",
      "BillsManifest",
    ]);
  });
});
