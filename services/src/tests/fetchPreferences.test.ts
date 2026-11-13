import {
  buildPreferenceDeleteRequests,
  buildPreferencePutRequests,
  parsePreferenceMutationBody,
} from "../shared/userPreferenceMutations";

process.env.TABLE_NAME = "test-table";
process.env.PARTITION_KEY = "user_id";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({
      send: mockSend,
    })),
    __mockSend: mockSend,
  };
});
const { __mockSend: mockSendFetch } = jest.requireMock("@aws-sdk/client-dynamodb");

const { handler: fetchHandler } = require("../handlers/fetchPreferences");

/** A preference row as the handler returns it. */
interface PreferenceItem {
  preference?: string;
  category?: string | null;
  sub_category?: string | null;
}

describe("fetchPreferences handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = "test-table"; // Ensure TABLE_NAME is set
    process.env.PARTITION_KEY = "user_id"; // Ensure PARTITION_KEY is set to match handler
  });

  it("should return 200 with user preferences", async () => {
    mockSendFetch.mockResolvedValueOnce({
      Items: [
        {
          preference: { S: "8D3D6F85-0E3A-4B3C-..." },
          type: { S: "Congress Member" },
          category: { S: "" },
        },
        {
          preference: { S: "Energy" },
          type: { S: "Category" },
          category: { S: "Environment" },
        },
        {
          preference: { S: "Home energy" },
          type: { S: "Life Area" },
          category: { S: "" },
        },
        {
          preference: { S: "joint_resolutions" },
          type: { S: "Content Type" },
          category: { S: "" },
        },
      ],
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
    };

    const result = await fetchHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual([
      { preference: "8D3D6F85-0E3A-4B3C-...", type: "Congress Member", category: "", sub_category: null },
      { preference: "Energy", type: "Category", category: "Environment", sub_category: null },
      { preference: "Home energy", type: "Life Area", category: "", sub_category: null },
      { preference: "joint_resolutions", type: "Content Type", category: "", sub_category: null },
    ]);
    expect(mockSendFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "test-table",
          KeyConditionExpression: "user_id = :uid",
          ExpressionAttributeValues: {
            ":uid": { S: "user-1" },
          },
        }),
      }),
    );
  });

  it("should return 200 with an empty array if no preferences are found", async () => {
    mockSendFetch.mockResolvedValueOnce({ Items: [] });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
    };

    const result = await fetchHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual([]);
  });

  // LLM-10: "Social Justice" became "Civil Rights and Liberties" and "Identity Politics" became "Heritage and Identity".
  // R2 sends X-Billboard-App-Version and knows both names; builds 1.0 and R1 send no version header and know only the
  // legacy names, each under the parent category they file it in (SubscriptionsConfig.subcategoryGroups,
  // categoryForManifestSubcategory): "Social Policy" and "Cultural and Ethical Issues".
  describe("renamed labels (LLM-10)", () => {
    const claims = { requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } } };
    const r2Headers = { "X-Billboard-App-Version": "1.2" };
    const row = (preference: string, type: string, category?: string) => ({
      preference: { S: preference },
      type: { S: type },
      ...(category === undefined ? {} : { category: { S: category } }),
    });
    const fetchWith = async (items: unknown[], fields: Record<string, unknown> = {}) => {
      mockSendFetch.mockResolvedValueOnce({ Items: items });
      const result = await fetchHandler({ ...claims, ...fields });
      expect(result.statusCode).toBe(200);
      return JSON.parse(result.body) as PreferenceItem[];
    };

    // A user who followed both labels before the rename (legacy rows), then followed one of them again under its new
    // name; plus rows of other types, some holding a label name as their value (synthetic: a real user holds one row
    // per value, since the value is the sort key).
    const mixedRows = [
      row("BILLS-119hr1", "Bill"),
      row("Civil Rights and Liberties", "Category", "Social Policy"),
      row("Energy", "Category", "Environment"),
      row("Identity Politics", "Category", "Cultural and Ethical Issues"),
      row("Social Justice", "Category", "Social Policy"),
      row("Social Justice", "Watch"),
      row("Heritage and Identity", "Life Area"),
      { preference: { S: "Civil Rights and Liberties" }, type: { S: "Congress Member" }, sub_category: { S: "x" } },
      row("joint_resolutions", "Content Type", ""),
    ];

    // Rows from before the sort key held the value may also name the label in sub_category, which every build reads
    // before preference (PreferencesItem.value is `subCategory ?? preference` in 1.0, R1 and R2). movedRow is what
    // `relabel:sub-categories -- --apply --preferences` writes for such a row (movedItem; relabelSubCategories.test.ts);
    // legacySubCategoryRow is one stored under the current name that still carries the former name there.
    const movedRow = {
      userId: { S: "user-1" },
      preference: { S: "Civil Rights and Liberties" },
      type: { S: "Category" },
      category: { S: "Social Policy" },
      sub_category: { S: "Civil Rights and Liberties" },
      createdAt: { S: "2026-01-01T00:00:00Z" },
    };
    const legacySubCategoryRow = {
      ...row("Heritage and Identity", "Category", "Cultural and Ethical Issues"),
      sub_category: { S: "Identity Politics" },
    };
    // What builds 1.0 and R1 read as a row's value (PreferencesService.swift, PreferencesItem.value).
    const valueIn10AndR1 = (item: PreferenceItem): string => (item.sub_category ?? item.preference ?? "").trim();

    describe("requests with X-Billboard-App-Version (R2): current names", () => {
      it("returns follows stored under a former label name under the current name, once", async () => {
        const body = await fetchWith(
          [
            row("Civil Rights and Liberties", "Category", "Social Policy"),
            row("Energy", "Category", "Environmental and Energy Policy"),
            row("Identity Politics", "Category", "Cultural and Ethical Issues"),
            row("Social Justice", "Category", "Social Policy"),
            row("Social Justice", "Watch"),
            row("Heritage and Identity", "category", "Cultural and Ethical Issues"),
            row("BILLS-119hr1", "Bill"),
          ],
          { headers: r2Headers },
        );

        expect(body).toEqual([
          { preference: "Civil Rights and Liberties", type: "Category", category: "Social Policy", sub_category: null },
          { preference: "Energy", type: "Category", category: "Environmental and Energy Policy", sub_category: null },
          {
            preference: "Heritage and Identity",
            type: "Category",
            category: "Cultural and Ethical Issues",
            sub_category: null,
          },
          // A row under another type keeps its value: only Category rows are labels.
          { preference: "Social Justice", type: "Watch", category: null, sub_category: null },
          { preference: "BILLS-119hr1", type: "Bill", category: null, sub_category: null },
        ]);
      });

      it("returns a follow stored only under a former label name with the current name and parent", async () => {
        const body = await fetchWith([row("Social Justice", "Category", "Social Policy")], { headers: r2Headers });

        expect(body).toEqual([
          { preference: "Civil Rights and Liberties", type: "Category", category: "Social Policy", sub_category: null },
        ]);
      });

      it.each([
        ["the header as R2 names it", { headers: { "X-Billboard-App-Version": "1.2" } }],
        ["lower case (HTTP/2)", { headers: { "x-billboard-app-version": "1.2" } }],
        ["upper case", { headers: { "X-BILLBOARD-APP-VERSION": "1.2.3" } }],
        ["multiValueHeaders only", { headers: null, multiValueHeaders: { "x-billboard-app-version": ["1.2"] } }],
        [
          "both maps, as API Gateway sends them",
          {
            headers: { Accept: "application/json", "x-billboard-app-version": "1.2" },
            multiValueHeaders: { Accept: ["application/json"], "x-billboard-app-version": ["1.2"] },
          },
        ],
        // Any value counts: the header's presence, not the version, tells R2 from 1.0 and R1.
        ["a value that is not a version", { headers: { "X-Billboard-App-Version": "1.2 (45)" } }],
      ])("returns the current names with %s", async (_label, fields) => {
        const body = await fetchWith(
          [row("Heritage and Identity", "Category", "Cultural and Ethical Issues"), row("Social Justice", "Category")],
          fields,
        );

        expect(body.map((item: PreferenceItem) => [item.preference, item.category])).toEqual([
          ["Heritage and Identity", "Cultural and Ethical Issues"],
          ["Civil Rights and Liberties", "Social Policy"],
        ]);
      });

      it("returns a row's sub_category as stored, under either name (R2 maps both names itself)", async () => {
        const body = await fetchWith([movedRow, legacySubCategoryRow], { headers: r2Headers });

        expect(body).toEqual([
          {
            preference: "Civil Rights and Liberties",
            type: "Category",
            category: "Social Policy",
            sub_category: "Civil Rights and Liberties",
          },
          {
            preference: "Heritage and Identity",
            type: "Category",
            category: "Cultural and Ethical Issues",
            sub_category: "Identity Politics",
          },
        ]);
      });

      it("keeps every row that is not a renamed topic exactly as stored, in the stored order", async () => {
        const body = await fetchWith(mixedRows, { headers: r2Headers });

        expect(body).toEqual([
          { preference: "BILLS-119hr1", type: "Bill", category: null, sub_category: null },
          { preference: "Civil Rights and Liberties", type: "Category", category: "Social Policy", sub_category: null },
          { preference: "Energy", type: "Category", category: "Environment", sub_category: null },
          {
            preference: "Heritage and Identity",
            type: "Category",
            category: "Cultural and Ethical Issues",
            sub_category: null,
          },
          { preference: "Social Justice", type: "Watch", category: null, sub_category: null },
          { preference: "Heritage and Identity", type: "Life Area", category: null, sub_category: null },
          { preference: "Civil Rights and Liberties", type: "Congress Member", category: null, sub_category: "x" },
          { preference: "joint_resolutions", type: "Content Type", category: "", sub_category: null },
        ]);
      });
    });

    describe("requests without X-Billboard-App-Version (builds 1.0 and R1): legacy names", () => {
      it.each([
        ["no headers at all", {}],
        ["null header maps", { headers: null, multiValueHeaders: null }],
        ["other headers only", { headers: { Accept: "application/json", Authorization: "Bearer t" } }],
        ["an empty value", { headers: { "X-Billboard-App-Version": "" } }],
        ["a blank value", { headers: { "x-billboard-app-version": "  " }, multiValueHeaders: {} }],
        ["a header with a similar name", { headers: { "X-Billboard-App-Attest": "v1.u", "X-App-Version": "1.2" } }],
      ])("returns a follow stored under the current name under the legacy name and its parent: %s", async (_l, f) => {
        const body = await fetchWith(
          [
            row("Civil Rights and Liberties", "Category", "Social Policy"),
            row("Heritage and Identity", "Category", "Cultural and Ethical Issues"),
          ],
          f,
        );

        expect(body).toEqual([
          { preference: "Social Justice", type: "Category", category: "Social Policy", sub_category: null },
          {
            preference: "Identity Politics",
            type: "Category",
            category: "Cultural and Ethical Issues",
            sub_category: null,
          },
        ]);
      });

      it("returns a follow stored under the legacy name under that name and its parent", async () => {
        const body = await fetchWith([
          row("Identity Politics", "Category", "Cultural and Ethical Issues"),
          row("Social Justice", "category"),
        ]);

        expect(body).toEqual([
          {
            preference: "Identity Politics",
            type: "Category",
            category: "Cultural and Ethical Issues",
            sub_category: null,
          },
          { preference: "Social Justice", type: "category", category: "Social Policy", sub_category: null },
        ]);
      });

      it("returns a label followed under both names once, where it first appears", async () => {
        const body = await fetchWith([
          row("Civil Rights and Liberties", "Category", "Social Policy"),
          row("Heritage and Identity", "Category", "Cultural and Ethical Issues"),
          row("Identity Politics", "Category", "Cultural and Ethical Issues"),
          row("Social Justice", "Category", "Social Policy"),
        ]);

        expect(body).toEqual([
          { preference: "Social Justice", type: "Category", category: "Social Policy", sub_category: null },
          {
            preference: "Identity Politics",
            type: "Category",
            category: "Cultural and Ethical Issues",
            sub_category: null,
          },
        ]);
      });

      it("returns a renamed label held in sub_category under the legacy name too, since 1.0 and R1 read it first", async () => {
        const body = await fetchWith([
          movedRow,
          legacySubCategoryRow,
          { ...row("Social Justice", "Category", "Social Policy"), sub_category: { S: "Social Justice" } },
          // A Category row whose sub_category names a renamed label: that is the value every build reads.
          { ...row("Energy", "Category", "Environment"), sub_category: { S: "Heritage and Identity" } },
          // Other values in sub_category, and sub_category on rows of other types, stay as stored.
          { ...row("Infrastructure", "Category"), sub_category: { S: "Infrastructure" } },
          {
            ...row("Civil Rights and Liberties", "Congress Member"),
            sub_category: { S: "Civil Rights and Liberties" },
          },
        ]);

        expect(body).toEqual([
          { preference: "Social Justice", type: "Category", category: "Social Policy", sub_category: "Social Justice" },
          {
            preference: "Identity Politics",
            type: "Category",
            category: "Cultural and Ethical Issues",
            sub_category: "Identity Politics",
          },
          // Followed under both names (movedRow first): once.
          { preference: "Energy", type: "Category", category: "Environment", sub_category: "Identity Politics" },
          { preference: "Infrastructure", type: "Category", category: null, sub_category: "Infrastructure" },
          {
            preference: "Civil Rights and Liberties",
            type: "Congress Member",
            category: null,
            sub_category: "Civil Rights and Liberties",
          },
        ]);
        expect(body.slice(0, 3).map(valueIn10AndR1)).toEqual([
          "Social Justice",
          "Identity Politics",
          "Identity Politics",
        ]);
      });

      it("keeps every row that is not a renamed topic exactly as stored, in the stored order", async () => {
        const body = await fetchWith(mixedRows);

        expect(body).toEqual([
          { preference: "BILLS-119hr1", type: "Bill", category: null, sub_category: null },
          // Followed under both names: once, at the first row, under the legacy name.
          { preference: "Social Justice", type: "Category", category: "Social Policy", sub_category: null },
          // An unrenamed label keeps even a parent the app would not send today.
          { preference: "Energy", type: "Category", category: "Environment", sub_category: null },
          {
            preference: "Identity Politics",
            type: "Category",
            category: "Cultural and Ethical Issues",
            sub_category: null,
          },
          // Rows under another type keep their value: only Category rows are labels.
          { preference: "Social Justice", type: "Watch", category: null, sub_category: null },
          { preference: "Heritage and Identity", type: "Life Area", category: null, sub_category: null },
          { preference: "Civil Rights and Liberties", type: "Congress Member", category: null, sub_category: "x" },
          { preference: "joint_resolutions", type: "Content Type", category: "", sub_category: null },
        ]);
      });

      it("returns the legacy names' parents whatever parent the row was stored with", async () => {
        const body = await fetchWith([
          row("Civil Rights and Liberties", "Category", ""),
          row("Identity Politics", "Category"),
        ]);

        expect(body.map((item: PreferenceItem) => [item.preference, item.category])).toEqual([
          ["Social Justice", "Social Policy"],
          ["Identity Politics", "Cultural and Ethical Issues"],
        ]);
      });

      it("leaves a Category row without a value, or with an unknown label, as stored", async () => {
        const body = await fetchWith([
          { type: { S: "Category" }, category: { S: "Social Policy" } },
          row("Civil Rights", "Category", "Social Policy"),
          row("civil rights and liberties", "Category", "Social Policy"),
          row("toString", "Category"),
        ]);

        expect(body).toEqual([
          { preference: null, type: "Category", category: "Social Policy", sub_category: null },
          { preference: "Civil Rights", type: "Category", category: "Social Policy", sub_category: null },
          { preference: "civil rights and liberties", type: "Category", category: "Social Policy", sub_category: null },
          { preference: "toString", type: "Category", category: null, sub_category: null },
        ]);
      });

      it("returns the rows a 1.0 or R1 build can send back unchanged to PUT and DELETE /preferences", async () => {
        const body = await fetchWith([
          row("Civil Rights and Liberties", "Category", "Social Policy"),
          row("Heritage and Identity", "Category", "Cultural and Ethical Issues"),
          row("Identity Politics", "Category", "Cultural and Ethical Issues"),
        ]);
        expect(body.map((item: PreferenceItem) => item.preference)).toEqual(["Social Justice", "Identity Politics"]);
        // PreferencesMutations.categoryItems in 1.0 and R1: the name, its parent from subcategoryGroups, "Category".
        const sentBack = JSON.stringify({
          preferences: body.map((item: PreferenceItem) => ({
            preference: item.preference,
            category: item.category,
            type: "Category",
          })),
        });

        const parsed = parsePreferenceMutationBody(sentBack, "user_id");
        expect(
          buildPreferencePutRequests({
            userId: "user-1",
            partitionKey: "user_id",
            sortKey: "preference",
            preferences: parsed,
          }).map((request) => [request.PutRequest?.Item?.preference?.S, request.PutRequest?.Item?.category?.S]),
        ).toEqual([
          ["Civil Rights and Liberties", "Social Policy"],
          ["Heritage and Identity", "Cultural and Ethical Issues"],
        ]);
        // A toggle switched off in 1.0 or R1 removes the follow under both names.
        expect(
          buildPreferenceDeleteRequests({
            userId: "user-1",
            partitionKey: "user_id",
            sortKey: "preference",
            preferences: parsed,
            storedBillGuids: new Map(),
          }).map((request) => request.DeleteRequest?.Key?.preference?.S),
        ).toEqual(["Civil Rights and Liberties", "Social Justice", "Heritage and Identity", "Identity Politics"]);
      });
    });
  });
});

export {};
