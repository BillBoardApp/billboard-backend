import type { BatchWriteItemCommandInput, QueryCommandInput, WriteRequest } from "@aws-sdk/client-dynamodb";

process.env.TABLE_NAME = "test-table";
process.env.PARTITION_KEY = "user_id";
process.env.SORT_KEY = "sort_key";
process.env.PII_TABLE_NAME = "pii-table";
process.env.PII_PARTITION_KEY = "user_id";

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
interface FakeCommand {
  constructor: { name: string };
  input: Partial<BatchWriteItemCommandInput & QueryCommandInput>;
}
const { __mockSend: mockSendDelete } = jest.requireMock("@aws-sdk/client-dynamodb");

const { handler: deleteHandler } = require("../handlers/deletePreferences");

describe("deletePreferences handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = "test-table";
    process.env.PARTITION_KEY = "user_id";
    process.env.SORT_KEY = "sort_key";
    process.env.PII_TABLE_NAME = "pii-table";
    process.env.PII_PARTITION_KEY = "user_id";
  });

  it("should return 400 if preference or type is missing", async () => {
    mockSendDelete.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({}),
    };

    const result = await deleteHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Missing or invalid `preference`" });
  });

  it("should return 200 and delete the preference successfully", async () => {
    mockSendDelete
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "Energy", type: "Category", category: "Environmental and Energy Policy" }),
    };

    const result = await deleteHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences deleted", count: 1 });
    expect(mockSendDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            ["test-table"]: expect.arrayContaining([
              expect.objectContaining({
                DeleteRequest: expect.objectContaining({
                  Key: expect.objectContaining({
                    user_id: { S: "user-1" },
                    sort_key: { S: "Energy" },
                  }),
                }),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("should return 400 for invalid category values", async () => {
    mockSendDelete.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "Energy", type: "Category", category: "Invalid Category" }),
    };

    const result = await deleteHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Invalid preference or category for type 'Category'" });
    expect(mockSendDelete).toHaveBeenCalledTimes(1);
  });

  it("should return 400 for invalid life area values", async () => {
    mockSendDelete.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "UnknownArea", type: "Life Area" }),
    };

    const result = await deleteHandler(event);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Invalid preference for type 'Life Area'" });
    expect(mockSendDelete).toHaveBeenCalledTimes(1);
  });

  it("should delete normalized content type preferences", async () => {
    mockSendDelete
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "OTHER_RESOLUTIONS", type: "contenttype", category: "" }),
    };

    const result = await deleteHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences deleted", count: 1 });

    const call = mockSendDelete.mock.calls[1]?.[0];
    const key = call?.input?.RequestItems?.["test-table"]?.[0]?.DeleteRequest?.Key ?? {};
    expect(key).toMatchObject({
      user_id: { S: "user-1" },
      sort_key: { S: "other_resolutions" },
    });
  });

  it("should delete normalized bill preferences", async () => {
    mockSendDelete
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "BILLS-119hr900is", type: "bill", category: "" }),
    };

    const result = await deleteHandler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences deleted", count: 1 });

    // Under the plain guid, and under the legacy id sent (REL-42), after the Query of the user's rows of the bill.
    const call = mockSendDelete.mock.calls[2]?.[0];
    const keys = (call?.input?.RequestItems?.["test-table"] ?? []).map(
      (request: WriteRequest) => request.DeleteRequest?.Key,
    );
    expect(keys).toEqual([
      { user_id: { S: "user-1" }, sort_key: { S: "BILLS-119hr900" } },
      { user_id: { S: "user-1" }, sort_key: { S: "BILLS-119hr900is" } },
    ]);
  });

  describe("renamed labels (LLM-10)", () => {
    const deletedKeys = () =>
      (mockSendDelete.mock.calls[1]?.[0]?.input?.RequestItems?.["test-table"] ?? []).map(
        (request: WriteRequest) => request.DeleteRequest!.Key!.sort_key.S,
      );
    const remove = async (body: unknown) => {
      mockSendDelete
        .mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } })
        .mockResolvedValueOnce({});
      return deleteHandler({
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
        body: JSON.stringify(body),
      });
    };

    it.each([
      ["Social Justice", "Social Policy"],
      ["Civil Rights and Liberties", "Social Policy"],
    ])("deletes the follow under both names when sent as %s", async (preference, category) => {
      const result = await remove({ preference, type: "Category", category });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ message: "Preferences deleted", count: 1 });
      expect(deletedKeys()).toEqual(["Civil Rights and Liberties", "Social Justice"]);
      expect(mockSendDelete.mock.calls[1][0].input.RequestItems["test-table"][0].DeleteRequest.Key.user_id).toEqual({
        S: "user-1",
      });
    });

    it("deletes each name once when a body names a label under both", async () => {
      const result = await remove([
        { preference: "Identity Politics", type: "Category", category: "Cultural and Ethical Issues" },
        { preference: "Heritage and Identity", type: "Category", category: "Cultural and Ethical Issues" },
        { preference: "Energy", type: "Category", category: "Environmental and Energy Policy" },
      ]);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ message: "Preferences deleted", count: 3 });
      expect(deletedKeys()).toEqual(["Heritage and Identity", "Identity Politics", "Energy"]);
    });

    it("deletes an unrenamed label, or a former name sent as another type, under that name only", async () => {
      await remove([
        { preference: "Energy", type: "Category", category: "Environmental and Energy Policy" },
        { preference: "Social Justice", type: "Congress Member" },
      ]);

      expect(deletedKeys()).toEqual(["Energy", "Social Justice"]);
    });

    it("still rejects an unknown label name", async () => {
      const result = await remove({ preference: "Social Justice Policy", type: "Category", category: "Social Policy" });

      expect(result.statusCode).toBe(400);
      expect(mockSendDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe("bill guids (REL-42)", () => {
    const sent = (name: string): FakeCommand[] =>
      mockSendDelete.mock.calls
        .map(([command]: [FakeCommand]) => command)
        .filter((command: FakeCommand) => command.constructor.name === name);
    const deletedKeys = () =>
      sent("BatchWriteItemCommand").flatMap((command) =>
        command.input.RequestItems!["test-table"].map(
          (request: WriteRequest) => request.DeleteRequest!.Key!.sort_key.S,
        ),
      );
    /** Sends a DELETE for a user whose rows have `storedKeys` (in key order); the Query returns 2 a page. */
    const remove = async (body: unknown, storedKeys: string[] = []) => {
      mockSendDelete.mockImplementation(async (command: FakeCommand) => {
        const input = command.input;
        if (command.constructor.name === "GetItemCommand") return { Item: { adultStatus: { S: "attested_adult" } } };
        if (command.constructor.name !== "QueryCommand") return {};
        const matching = storedKeys.filter((key) => key.startsWith(input.ExpressionAttributeValues![":plainGuid"].S!));
        const start = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.cursor.N) : 0;
        return {
          Items: matching.slice(start, start + 2).map((key) => ({ sort_key: { S: key } })),
          ...(start + 2 < matching.length ? { LastEvaluatedKey: { cursor: { N: String(start + 2) } } } : {}),
        };
      });
      return deleteHandler({
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
        body: JSON.stringify(body),
      });
    };

    afterEach(() => mockSendDelete.mockReset());

    it("deletes a plain guid under that guid only when the user has no other spelling of the bill", async () => {
      const result = await remove({ preference: "BILLS-119hr1181", type: "Watch", category: "" });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ message: "Preferences deleted", count: 1 });
      expect(deletedKeys()).toEqual(["BILLS-119hr1181"]);
    });

    it("deletes a Watch sent under a legacy id under its plain guid and under that id", async () => {
      const result = await remove({ preference: "BILLS-119hr1181rh", type: "Watch", category: "" });

      expect(JSON.parse(result.body)).toEqual({ message: "Preferences deleted", count: 1 });
      expect(deletedKeys()).toEqual(["BILLS-119hr1181", "BILLS-119hr1181rh"]);
      expect(sent("QueryCommand").map((command) => command.input.ExpressionAttributeValues![":plainGuid"])).toEqual([
        { S: "BILLS-119hr1181" },
      ]);
    });

    it("deletes a plain guid under every legacy id the user has a row under, and not another bill's rows", async () => {
      // A user watched a bill under two legacy ids before the fix; hr27071 is another bill.
      const result = await remove({ preference: "BILLS-119hr2707", type: "Watch", category: "" }, [
        "BILLS-119hr2707",
        "BILLS-119hr27071",
        "BILLS-119hr27071ih",
        "BILLS-119hr2707ih",
        "BILLS-119hr2707rh",
      ]);

      expect(result.statusCode).toBe(200);
      expect(deletedKeys()).toEqual(["BILLS-119hr2707", "BILLS-119hr2707ih", "BILLS-119hr2707rh"]);
      expect(sent("QueryCommand").map((command) => command.input)).toEqual([
        {
          TableName: "test-table",
          KeyConditionExpression: "#pk = :userId AND begins_with(#sk, :plainGuid)",
          ExpressionAttributeNames: { "#pk": "user_id", "#sk": "sort_key" },
          ExpressionAttributeValues: { ":userId": { S: "user-1" }, ":plainGuid": { S: "BILLS-119hr2707" } },
          ProjectionExpression: "#sk",
          ConsistentRead: true,
        },
        expect.objectContaining({ ExclusiveStartKey: { cursor: { N: "2" } } }),
        expect.objectContaining({ ExclusiveStartKey: { cursor: { N: "4" } } }),
      ]);
    });

    it("does not query for a type whose value is not a bill guid", async () => {
      await remove(
        [
          { preference: "Energy", type: "Category", category: "Environmental and Energy Policy" },
          { preference: "A000001", type: "Congress Member" },
        ],
        ["Energy", "A000001"],
      );

      expect(sent("QueryCommand")).toEqual([]);
      expect(deletedKeys()).toEqual(["Energy", "A000001"]);
    });
  });

  it("allows deletes when adult attestation is still unknown", async () => {
    mockSendDelete.mockResolvedValueOnce({});
    mockSendDelete.mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ preference: "Energy", type: "Category", category: "Environmental and Energy Policy" }),
    };

    const result = await deleteHandler(event);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Preferences deleted", count: 1 });
  });
});

export {};
