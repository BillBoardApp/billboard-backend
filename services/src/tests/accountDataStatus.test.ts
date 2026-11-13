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
const { handler } = require("../handlers/accountDataStatus");

describe("accountDataStatus handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await handler({});
    expect(response.statusCode).toBe(401);
  });

  it("returns not_requested when no status exists", async () => {
    mockSend
      .mockResolvedValueOnce({}) // eligibility lookup
      .mockResolvedValueOnce({}); // status read

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        deletionStatus: "not_requested",
        deletionRequestedAt: null,
        deletionCompletedAt: null,
      }),
    );
  });

  it("returns in-progress status when present", async () => {
    mockSend
      .mockResolvedValueOnce({
        Item: {
          adultStatus: { S: "attested_adult" },
          deletionStatus: { S: "in_progress" },
        },
      })
      .mockResolvedValueOnce({
        Item: {
          deletionStatus: { S: "in_progress" },
          deletionRequestedAt: { S: "2026-03-01T00:00:00.000Z" },
        },
      });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(
      expect.objectContaining({
        deletionStatus: "in_progress",
        deletionRequestedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
  });
});

export {};
