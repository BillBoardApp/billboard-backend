process.env.TABLE_NAME = "test-table";
process.env.PARTITION_KEY = "user_id";
process.env.SORT_KEY = "sort_key";
process.env.PII_TABLE_NAME = "pii-table";
process.env.PII_PARTITION_KEY = "user_id";

/** One BatchWriteItem entry; the tests read the string attributes of the item. */
interface PutRequestEntry {
  PutRequest: { Item: Record<string, { S?: string }> };
}

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
const { __mockSend: mockSendSet } = jest.requireMock("@aws-sdk/client-dynamodb");
const { handler: setHandler } = require("../handlers/setPreferences");

describe("setPreferences handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = "test-table"; // Ensure TABLE_NAME is set
    process.env.PARTITION_KEY = "user_id"; // Ensure PARTITION_KEY is set to match handler
    process.env.SORT_KEY = "sort_key"; // Ensure SORT_KEY is set to match handler
    process.env.PII_TABLE_NAME = "pii-table";
    process.env.PII_PARTITION_KEY = "user_id";
  });

  it("should return 400 if preference or type is missing", async () => {
    mockSendSet.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({}),
    };

    const result = await setHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Missing or invalid `preference`" });
  });

  it("should return 200 and update preferences successfully", async () => {
    mockSendSet
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({}); // Ensure the mock is properly set up to simulate a successful DynamoDB call

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "Energy", type: "Category", category: "Environmental and Energy Policy" }),
    };

    const result = await setHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences updated", count: 1 });
    expect(mockSendSet).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            ["test-table"]: expect.arrayContaining([
              expect.objectContaining({
                PutRequest: expect.objectContaining({
                  Item: expect.objectContaining({
                    user_id: { S: "user-1" },
                    sort_key: { S: "Energy" },
                    category: { S: "Environmental and Energy Policy" },
                    type: { S: "Category" },
                  }),
                }),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("should accept bill preference type and store its plain guid (REL-42)", async () => {
    mockSendSet
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "BILLS-119hr900is", type: "bill", category: "" }),
    };

    const result = await setHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences updated", count: 1 });
    expect(mockSendSet).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            ["test-table"]: expect.arrayContaining([
              expect.objectContaining({
                PutRequest: expect.objectContaining({
                  Item: expect.objectContaining({
                    user_id: { S: "user-1" },
                    sort_key: { S: "BILLS-119hr900" },
                    type: { S: "Bill" },
                  }),
                }),
              }),
            ]),
          }),
        }),
      }),
    );

    const call = mockSendSet.mock.calls[1]?.[0];
    const item = call?.input?.RequestItems?.["test-table"]?.[0]?.PutRequest?.Item ?? {};
    expect(item).not.toHaveProperty("category");
  });

  it("should accept watch preferences without writing empty category", async () => {
    mockSendSet
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({
        preference: "BILLS-119hr42",
        type: "Watch",
        category: "",
      }),
    };

    const result = await setHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences updated", count: 1 });

    const call = mockSendSet.mock.calls[1]?.[0];
    const item = call?.input?.RequestItems?.["test-table"]?.[0]?.PutRequest?.Item ?? {};
    expect(item).toMatchObject({
      user_id: { S: "user-1" },
      sort_key: { S: "BILLS-119hr42" },
      type: { S: "Watch" },
    });
    expect(item).not.toHaveProperty("category");
  });

  it("should accept content type preferences and normalize the stored value", async () => {
    mockSendSet
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({
        preference: "BILLS",
        type: "content_type",
        category: "",
      }),
    };

    const result = await setHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences updated", count: 1 });

    const call = mockSendSet.mock.calls[1]?.[0];
    const item = call?.input?.RequestItems?.["test-table"]?.[0]?.PutRequest?.Item ?? {};
    expect(item).toMatchObject({
      user_id: { S: "user-1" },
      sort_key: { S: "bills" },
      type: { S: "Content Type" },
    });
    expect(item).not.toHaveProperty("category");
  });

  it("should return 400 for invalid category values", async () => {
    mockSendSet.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "Energy", type: "Category", category: "Invalid Category" }),
    };

    const result = await setHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Invalid preference or category for type 'Category'" });
    expect(mockSendSet).toHaveBeenCalledTimes(1);
  });

  it("should return 400 for invalid life area values", async () => {
    mockSendSet.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "UnknownArea", type: "Life Area" }),
    };

    const result = await setHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Invalid preference for type 'Life Area'" });
    expect(mockSendSet).toHaveBeenCalledTimes(1);
  });

  describe("renamed labels (LLM-10)", () => {
    const putItems = () =>
      (mockSendSet.mock.calls[1]?.[0]?.input?.RequestItems?.["test-table"] ?? []).map(
        (request: PutRequestEntry) => request.PutRequest.Item,
      );
    const put = async (body: unknown) => {
      mockSendSet.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }).mockResolvedValueOnce({});
      return setHandler({
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
        body: JSON.stringify(body),
      });
    };

    it.each([
      ["Social Justice", "Social Policy", "Civil Rights and Liberties"],
      ["Identity Politics", "Cultural and Ethical Issues", "Heritage and Identity"],
    ])("stores a follow sent under the former name %s under its current name", async (former, parent, current) => {
      const result = await put({ preference: former, type: "Category", category: parent });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ message: "Preferences updated", count: 1 });
      expect(putItems()).toEqual([
        { user_id: { S: "user-1" }, sort_key: { S: current }, type: { S: "Category" }, category: { S: parent } },
      ]);
    });

    it("stores the current names as sent", async () => {
      const result = await put([
        { preference: "Civil Rights and Liberties", type: "Category", category: "Social Policy" },
        { preference: "Heritage and Identity", type: "category", category: "Cultural and Ethical Issues" },
      ]);

      expect(result.statusCode).toBe(200);
      expect(
        putItems().map((item: PutRequestEntry["PutRequest"]["Item"]) => [item.sort_key.S, item.category.S]),
      ).toEqual([
        ["Civil Rights and Liberties", "Social Policy"],
        ["Heritage and Identity", "Cultural and Ethical Issues"],
      ]);
    });

    it("stores a former name with its parent category whatever category the client sent", async () => {
      await put({ preference: "Identity Politics", type: "Category", category: "Social Policy" });

      expect(putItems()[0]).toMatchObject({
        sort_key: { S: "Heritage and Identity" },
        category: { S: "Cultural and Ethical Issues" },
      });
    });

    it("writes one row when a body names a label under both names", async () => {
      const result = await put({
        preferences: [
          { preference: "Social Justice", type: "Category", category: "Social Policy" },
          { preference: "Energy", type: "Category", category: "Environmental and Energy Policy" },
          { preference: "Civil Rights and Liberties", type: "Category", category: "Social Policy" },
        ],
      });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ message: "Preferences updated", count: 3 });
      expect(putItems().map((item: PutRequestEntry["PutRequest"]["Item"]) => item.sort_key.S)).toEqual([
        "Energy",
        "Civil Rights and Liberties",
      ]);
    });

    it("still rejects an unknown or near-miss label name", async () => {
      for (const preference of ["social justice", "Social Justice ", "Identity Politic", "Civil Rights"]) {
        mockSendSet.mockReset();
        const result = await put({ preference, type: "Category", category: "Social Policy" });
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body)).toEqual({ error: "Invalid preference or category for type 'Category'" });
        expect(mockSendSet).toHaveBeenCalledTimes(1);
      }
    });

    it("does not rename a former label name sent as another type", async () => {
      await put({ preference: "Social Justice", type: "Congress Member" });

      expect(putItems()).toEqual([
        { user_id: { S: "user-1" }, sort_key: { S: "Social Justice" }, type: { S: "Congress Member" } },
      ]);
    });
  });

  describe("bill guids (REL-42)", () => {
    const putItems = () =>
      (mockSendSet.mock.calls[1]?.[0]?.input?.RequestItems?.["test-table"] ?? []).map(
        (request: PutRequestEntry) => request.PutRequest.Item,
      );
    const put = async (body: unknown) => {
      mockSendSet.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }).mockResolvedValueOnce({});
      return setHandler({
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
        body: JSON.stringify(body),
      });
    };

    it("stores a Bill or Watch sent under a legacy id under its plain guid, once", async () => {
      const result = await put([
        { preference: "BILLS-119hr1181rh", type: "watch", category: "" },
        { preference: "BILLS-119HR1181", type: "Watch", category: "" },
        { preference: "BILLS-119hres1061eh", type: "bill", category: "" },
      ]);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ message: "Preferences updated", count: 3 });
      expect(putItems()).toEqual([
        { user_id: { S: "user-1" }, sort_key: { S: "BILLS-119hr1181" }, type: { S: "Watch" } },
        { user_id: { S: "user-1" }, sort_key: { S: "BILLS-119hres1061" }, type: { S: "Bill" } },
      ]);
    });

    it("rejects a value that is not a bill guid, or a category, for Bill and Watch", async () => {
      for (const [body, error] of [
        [{ preference: "BILLS-119hr1181 x", type: "Watch" }, "Invalid preference for type 'Watch'"],
        [{ preference: "bills-119hr1181", type: "Bill" }, "Invalid preference for type 'Bill'"],
        [{ preference: "Social Justice", type: "Watch" }, "Invalid preference for type 'Watch'"],
        [
          { preference: "BILLS-119hr1181", type: "Watch", category: "Health" },
          "Category must be empty for type 'Watch'",
        ],
      ] as const) {
        mockSendSet.mockReset();
        const result = await put(body);
        expect(result.statusCode).toBe(400);
        expect(JSON.parse(result.body)).toEqual({ error });
        expect(mockSendSet).toHaveBeenCalledTimes(1);
      }
    });
  });

  it("allows writes when adult attestation is still unknown", async () => {
    mockSendSet.mockResolvedValueOnce({});
    mockSendSet.mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "Energy", type: "Category", category: "Environmental and Energy Policy" }),
    };

    const result = await setHandler(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences updated", count: 1 });
  });
});

export {};
