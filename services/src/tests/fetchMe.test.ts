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
const { handler } = require("../handlers/fetchMe");

describe("fetchMe handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await handler({});
    expect(response.statusCode).toBe(401);
  });

  it("returns unknown when no eligibility row exists", async () => {
    mockSend.mockResolvedValueOnce({});

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        userId: "u1",
        adultStatus: "unknown",
        deletionStatus: "not_requested",
        canWrite: false,
      }),
    );
  });

  it("returns attested adult status", async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        adultStatus: { S: "attested_adult" },
        adultMethod: { S: "yes_no" },
        adultStatusSetAt: { S: "2026-03-01T00:00:00.000Z" },
      },
    });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        adultStatus: "attested_adult",
        adultMethod: "yes_no",
        adultStatusSetAt: "2026-03-01T00:00:00.000Z",
        canWrite: true,
      }),
    );
  });
});

export {};
