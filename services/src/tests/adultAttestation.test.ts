jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

process.env.TABLE_NAME = "UserPII";
process.env.PARTITION_KEY = "userId";

const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { handler } = require("../handlers/adultAttestation");

describe("adultAttestation handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = "UserPII";
    process.env.PARTITION_KEY = "userId";
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await handler({ body: JSON.stringify({ isAdult: true }) });
    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for invalid payload", async () => {
    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
      body: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Missing or invalid isAdult boolean" });
  });

  it("stores adult attestation", async () => {
    mockSend
      .mockResolvedValueOnce({}) // eligibility lookup
      .mockResolvedValueOnce({}); // update

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
      body: JSON.stringify({ isAdult: true }),
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        adultStatus: "attested_adult",
        adultMethod: "yes_no",
        canWrite: true,
      }),
    );
  });

  it("refuses to flip an under-18 self-report back to adult", async () => {
    mockSend.mockResolvedValueOnce({
      Item: { adultStatus: { S: "self_reported_under18" } },
    });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
      body: JSON.stringify({ isAdult: true }),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ error: "ADULT_STATUS_LOCKED" }));
    expect(mockSend).toHaveBeenCalledTimes(1); // no UpdateItem
  });

  it("returns 500 instead of writing when the eligibility lookup fails", async () => {
    mockSend.mockRejectedValueOnce(new Error("DynamoDB unavailable"));

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
      body: JSON.stringify({ isAdult: true }),
    });

    expect(response.statusCode).toBe(500);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when deletion is in progress", async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        deletionStatus: { S: "in_progress" },
      },
    });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
      body: JSON.stringify({ isAdult: true }),
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        error: "ACCOUNT_DELETION_IN_PROGRESS",
      }),
    );
  });
});

export {};
