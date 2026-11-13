jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    GetItemCommand: actual.GetItemCommand,
  };
});

process.env.PARTITION_KEY = "user_id";
process.env.SORT_KEY = "bill_id";
process.env.TABLE_NAME = "test-table";

const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { handler } = require("../handlers/fetchFeedback");

describe("fetchFeedback handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 400 when billId missing", async () => {
    const event = { requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } }, body: JSON.stringify({}) };
    const res = await handler(event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Missing billId" });
  });

  it("returns 200 with empty body when feedback not found", async () => {
    mockSend.mockResolvedValueOnce({});
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ billId: "bill-1" }),
    };
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });

  it("returns 200 with feedback when present", async () => {
    mockSend.mockResolvedValueOnce({ Item: { feedback: { S: "Yea" } } });
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ billId: "bill-1" }),
    };
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ feedback: "Yea", votedAt: null, reasons: [] });
  });

  // APPF-01: setFeedback stores reasons as a string set; they must come back on read.
  it("returns stored reasons (a DynamoDB string set) as a sorted array", async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        feedback: { S: "Nay" },
        votedAt: { S: "2026-09-20T12:00:00.000Z" },
        reasons: { SS: ["public_safety", "education"] },
      },
    });
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILLS-119sjres213" },
    };
    const res = await handler(event);

    expect(JSON.parse(res.body)).toEqual({
      feedback: "Nay",
      votedAt: "2026-09-20T12:00:00.000Z",
      reasons: ["education", "public_safety"],
    });
    expect(mockSend.mock.calls[0][0].input.ProjectionExpression).toBe("feedback, votedAt, reasons, legacyDismiss");
  });

  it("returns reasons for each vote in batch mode", async () => {
    mockSend.mockResolvedValueOnce({
      Responses: {
        "test-table": [
          { bill_id: { S: "bill-1" }, feedback: { S: "Yea" }, votedAt: { S: "t1" }, reasons: { SS: ["education"] } },
          { bill_id: { S: "bill-2" }, feedback: { S: "Abstain" }, votedAt: { S: "t2" } },
        ],
      },
    });
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ billIds: ["bill-1", "bill-2"] }),
    };
    const res = await handler(event);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      votes: [
        { billId: "bill-1", feedback: "Yea", votedAt: "t1", reasons: ["education"] },
        { billId: "bill-2", feedback: "Abstain", votedAt: "t2", reasons: [] },
      ],
    });
    expect(mockSend.mock.calls[0][0].input.RequestItems["test-table"].ProjectionExpression).toBe(
      "bill_id, feedback, votedAt, reasons, legacyDismiss",
    );
  });

  // Votes are kept under the plain guid; a legacy id (BILLS-119hr1181rh) names the same bill.
  it("reads a vote asked for by a suffixed id from the plain guid", async () => {
    mockSend.mockResolvedValueOnce({ Item: { feedback: { S: "Yea" }, votedAt: { S: "t1" } } });
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId: "BILLS-119hr1181rh" },
    };
    const res = await handler(event);

    expect(JSON.parse(res.body)).toEqual({ feedback: "Yea", votedAt: "t1", reasons: [] });
    expect(mockSend.mock.calls[0][0].input.Key).toEqual({
      user_id: { S: "user-1" },
      bill_id: { S: "BILLS-119hr1181" },
    });
  });

  it("reads one plain key for a suffixed and a plain id in batch mode and answers each id asked for", async () => {
    mockSend.mockResolvedValueOnce({
      Responses: {
        "test-table": [{ bill_id: { S: "BILLS-119hr1181" }, feedback: { S: "Nay" }, votedAt: { S: "t2" } }],
      },
    });
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ billIds: ["BILLS-119hr1181rh", "BILLS-119hr1181"] }),
    };
    const res = await handler(event);

    expect(res.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].input.RequestItems["test-table"].Keys).toEqual([
      { user_id: { S: "user-1" }, bill_id: { S: "BILLS-119hr1181" } },
    ]);
    expect(JSON.parse(res.body)).toEqual({
      votes: [
        { billId: "BILLS-119hr1181rh", feedback: "Nay", votedAt: "t2", reasons: [] },
        { billId: "BILLS-119hr1181", feedback: "Nay", votedAt: "t2", reasons: [] },
      ],
    });
  });

  // INT-11: setFeedback stores the Abstain 1.0 and 1.1 write when the user dismisses a Passed or Failed bill in
  // Updates with legacyDismiss. It is not a vote: 1.2 (which sends X-Billboard-App-Version) does not get it.
  describe("an Abstain stored as a 1.0 or 1.1 dismissal (INT-11)", () => {
    const DISMISSAL = { feedback: { S: "Abstain" }, votedAt: { S: "t1" }, legacyDismiss: { BOOL: true } };
    const single = (headers?: Record<string, string>) => ({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      ...(headers ? { headers } : {}),
      queryStringParameters: { billId: "BILLS-119hr77" },
    });
    const batch = (headers?: Record<string, string>) => ({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      ...(headers ? { headers } : {}),
      body: JSON.stringify({ billIds: ["BILLS-119hr77", "BILLS-119hr9"] }),
    });
    const batchAnswer = () => ({
      Responses: {
        "test-table": [
          { bill_id: { S: "BILLS-119hr77" }, ...DISMISSAL },
          { bill_id: { S: "BILLS-119hr9" }, feedback: { S: "Abstain" }, votedAt: { S: "t2" } },
        ],
      },
    });

    it.each<Record<string, string>>([{ "X-Billboard-App-Version": "1.2" }, { "x-billboard-app-version": "1.2.1" }])(
      "is not sent to 1.2 (%p): the bill reads as not voted",
      async (headers) => {
        mockSend.mockResolvedValueOnce({ Item: DISMISSAL });
        expect(JSON.parse((await handler(single(headers))).body)).toEqual({});

        mockSend.mockResolvedValueOnce(batchAnswer());
        expect(JSON.parse((await handler(batch(headers))).body)).toEqual({
          votes: [{ billId: "BILLS-119hr9", feedback: "Abstain", votedAt: "t2", reasons: [] }],
        });
      },
    );

    it("is still sent to 1.0 and 1.1 (no header), so the bill stays handled there", async () => {
      mockSend.mockResolvedValueOnce({ Item: DISMISSAL });
      expect(JSON.parse((await handler(single())).body)).toEqual({ feedback: "Abstain", votedAt: "t1", reasons: [] });

      mockSend.mockResolvedValueOnce(batchAnswer());
      expect(JSON.parse((await handler(batch({ "X-Billboard-App-Version": " " }))).body)).toEqual({
        votes: [
          { billId: "BILLS-119hr77", feedback: "Abstain", votedAt: "t1", reasons: [] },
          { billId: "BILLS-119hr9", feedback: "Abstain", votedAt: "t2", reasons: [] },
        ],
      });
    });
  });
});

export {};
