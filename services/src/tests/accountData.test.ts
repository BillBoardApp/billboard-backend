import type {
  BatchWriteItemCommandInput,
  DeleteItemCommandInput,
  GetItemCommandInput,
  PutItemCommandInput,
  QueryCommandInput,
  TransactWriteItemsCommandInput,
  UpdateItemCommandInput,
  WriteRequest,
} from "@aws-sdk/client-dynamodb";
import type { AdminDeleteUserCommandInput } from "@aws-sdk/client-cognito-identity-provider";
import type { DeleteEndpointCommandInput } from "@aws-sdk/client-sns";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

jest.mock("@aws-sdk/client-sns", () => {
  const actual = jest.requireActual("@aws-sdk/client-sns");
  const mockSend = jest.fn();
  return {
    ...actual,
    SNSClient: jest.fn(() => ({ send: mockSend })),
    __mockSnsSend: mockSend,
  };
});

jest.mock("@aws-sdk/client-cognito-identity-provider", () => {
  const actual = jest.requireActual("@aws-sdk/client-cognito-identity-provider");
  const mockSend = jest.fn();
  return {
    ...actual,
    CognitoIdentityProviderClient: jest.fn(() => ({ send: mockSend })),
    __mockCognitoSend: mockSend,
  };
});

process.env.PII_TABLE_NAME = "UserPII";
process.env.PII_PARTITION_KEY = "userId";
process.env.PREFERENCES_TABLE_NAME = "UserPreferences";
process.env.PREFERENCES_PARTITION_KEY = "userId";
process.env.PREFERENCES_SORT_KEY = "preference";
process.env.DEVICES_TABLE_NAME = "UserDevices";
process.env.DEVICES_PARTITION_KEY = "userId";
process.env.DEVICES_SORT_KEY = "deviceId";
process.env.DEVICES_PUSH_TOKEN_INDEX_NAME = "GSIPushTokenIndex";
process.env.FEEDBACK_TABLE_NAME = "UserFeedback";
process.env.FEEDBACK_PARTITION_KEY = "userId";
process.env.FEEDBACK_SORT_KEY = "billId";
process.env.FEEDBACK_BILL_ID_INDEX_NAME = "GSIBillIdIndex";
process.env.WEEKLY_DIGESTS_TABLE_NAME = "UserWeeklyDigests";
process.env.WEEKLY_DIGESTS_PARTITION_KEY = "userId";
process.env.WEEKLY_DIGESTS_SORT_KEY = "publishedAt";
process.env.STATS_TABLE_NAME = "BillStats";
process.env.STATS_PARTITION_KEY = "billId";
process.env.USER_POOL_ID = "us-east-1_pool";

/** The input of any command these tests read back: DynamoDB, SNS and Cognito, in the SDK's own field names. */
type FakeInput = Partial<
  GetItemCommandInput &
    UpdateItemCommandInput &
    QueryCommandInput &
    BatchWriteItemCommandInput &
    PutItemCommandInput &
    DeleteItemCommandInput &
    TransactWriteItemsCommandInput &
    DeleteEndpointCommandInput &
    AdminDeleteUserCommandInput
>;

interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { __mockSnsSend: mockSnsSend } = jest.requireMock("@aws-sdk/client-sns");
const { __mockCognitoSend: mockCognitoSend } = jest.requireMock("@aws-sdk/client-cognito-identity-provider");
const { handler } = require("../handlers/accountData");

// Builds that expect the backend to delete the Cognito user opt in with a header.
const deleteEvent = (sub = "u1", headers: Record<string, string> = { "X-Billboard-Delete-Sign-In": "1" }) => ({
  httpMethod: "DELETE",
  headers,
  requestContext: { authorizer: { jwt: { claims: { sub } } } },
});
const legacyDeleteEvent = (sub = "u1") => deleteEvent(sub, {});

function awsError(name: string, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}

type Device = { deviceId: string; pushToken?: string; endpointArn?: string };

/**
 * Routes DynamoDB commands for one user. `claim` decides the conditional
 * in_progress update; `tokenOwners` maps a push token to the user ids the GSI returns.
 */
function fakeDynamo(
  options: {
    deletionStatus?: string;
    feedback?: string[];
    devices?: Device[];
    tokenOwners?: Record<string, string[]>;
    claim?: () => Promise<unknown>;
  } = {},
) {
  mockSend.mockImplementation(async (command: FakeCommand) => {
    const name = command.constructor.name;
    const input = command.input ?? {};

    if (name === "GetItemCommand") {
      return {
        Item: {
          adultStatus: { S: "attested_adult" },
          ...(options.deletionStatus ? { deletionStatus: { S: options.deletionStatus } } : {}),
        },
      };
    }

    if (name === "UpdateItemCommand") {
      if (input.ConditionExpression && options.claim) return options.claim();
      return {};
    }

    if (name === "QueryCommand") {
      if (input.IndexName === "GSIPushTokenIndex") {
        const token = input.ExpressionAttributeValues![":pushToken"].S!;
        return { Items: (options.tokenOwners?.[token] ?? []).map((owner) => ({ userId: { S: owner } })) };
      }
      if (input.IndexName) throw new Error(`Unexpected index query ${input.IndexName}`);
      const userId = input.ExpressionAttributeValues![":pk"].S;
      switch (input.TableName) {
        case "UserFeedback":
          return {
            Items: (options.feedback ?? []).map((billId) => ({ userId: { S: userId }, billId: { S: billId } })),
          };
        case "UserDevices":
          return {
            Items: (options.devices ?? []).map((device) => ({
              userId: { S: userId },
              deviceId: { S: device.deviceId },
              ...(device.pushToken ? { pushToken: { S: device.pushToken } } : {}),
              ...(device.endpointArn ? { endpointArn: { S: device.endpointArn } } : {}),
            })),
          };
        default:
          return { Items: [] };
      }
    }

    if (name === "BatchWriteItemCommand" || name === "PutItemCommand") {
      return {};
    }

    throw new Error(`Unexpected DynamoDB command ${name}`);
  });
}

function sent(mock: jest.Mock, name: string): FakeCommand[] {
  return mock.mock.calls
    .map(([command]: [FakeCommand]) => command)
    .filter((command: FakeCommand) => command.constructor.name === name);
}

function lastStatusUpdate() {
  const updates = sent(mockSend, "UpdateItemCommand");
  return updates[updates.length - 1]?.input.ExpressionAttributeValues?.[":status"]?.S;
}

describe("accountData handler", () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSnsSend.mockResolvedValue({});
    mockCognitoSend.mockResolvedValue({});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await handler({ httpMethod: "DELETE" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 405 for unsupported methods", async () => {
    const response = await handler({
      httpMethod: "GET",
      requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } },
    });
    expect(response.statusCode).toBe(405);
  });

  it("returns in-progress without deleting anything when another request holds the claim", async () => {
    fakeDynamo({
      deletionStatus: "in_progress",
      claim: () => Promise.reject(awsError("ConditionalCheckFailedException")),
    });

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ deletionStatus: "in_progress" }));
    expect(sent(mockSend, "QueryCommand")).toHaveLength(0);
    expect(sent(mockSend, "PutItemCommand")).toHaveLength(0);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it("claims the deletion with a conditional update that allows only stale in-progress takeovers", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-24T12:00:00.000Z"), doNotFake: ["nextTick", "setImmediate"] });
    try {
      fakeDynamo();
      await handler(deleteEvent());
    } finally {
      jest.useRealTimers();
    }

    const claim = sent(mockSend, "UpdateItemCommand")[0].input;
    expect(claim.ConditionExpression).toContain("attribute_not_exists(deletionStatus)");
    expect(claim.ConditionExpression).toContain("deletionRequestedAt < :staleBefore");
    expect(claim.ExpressionAttributeValues).toEqual(
      expect.objectContaining({
        ":status": { S: "in_progress" },
        ":completed": { S: "completed" },
        ":requestedAt": { S: "2026-09-24T12:00:00.000Z" },
        ":staleBefore": { S: "2026-09-24T11:45:00.000Z" },
      }),
    );
  });

  it("lets only one of two concurrent DELETEs run", async () => {
    let claimed = false;
    fakeDynamo({
      feedback: ["hr-1"],
      claim: async () => {
        if (claimed) throw awsError("ConditionalCheckFailedException");
        claimed = true;
        return {};
      },
    });

    const [first, second] = await Promise.all([handler(deleteEvent()), handler(deleteEvent())]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 202]);
    const statuses = [first, second].map((response) => JSON.parse(response.body).deletionStatus).sort();
    expect(statuses).toEqual(["completed", "in_progress"]);
    expect(sent(mockSend, "PutItemCommand").filter((command) => command.input.TableName === "UserPII")).toHaveLength(1);
    expect(sent(mockCognitoSend, "AdminDeleteUserCommand")).toHaveLength(1);
  });

  it("deletes user data, SNS endpoints and the Cognito user, in that order", async () => {
    fakeDynamo({
      feedback: [],
      devices: [
        { deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:aws:sns:us-east-1:1:endpoint/APNS/App/one" },
        { deviceId: "dev-2", pushToken: "bb22", endpointArn: "arn:aws:sns:us-east-1:1:endpoint/APNS/App/two" },
        { deviceId: "dev-3" },
      ],
      tokenOwners: { aa11: ["u1"], bb22: ["u1"] },
    });

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      deletionStatus: "completed",
      message: "Account data and sign-in account deleted.",
    });

    expect(sent(mockSnsSend, "DeleteEndpointCommand").map((command) => command.input.EndpointArn)).toEqual([
      "arn:aws:sns:us-east-1:1:endpoint/APNS/App/one",
      "arn:aws:sns:us-east-1:1:endpoint/APNS/App/two",
    ]);

    const deviceDelete = sent(mockSend, "BatchWriteItemCommand").find(
      (command) => command.input.RequestItems!.UserDevices,
    );
    expect(
      deviceDelete!.input.RequestItems!.UserDevices.map(
        (request: WriteRequest) => request.DeleteRequest?.Key?.deviceId.S,
      ),
    ).toEqual(["dev-1", "dev-2", "dev-3"]);

    const tombstone = sent(mockSend, "PutItemCommand").find((command) => command.input.TableName === "UserPII");
    expect(tombstone!.input.Item!.deletionStatus).toEqual({ S: "completed" });

    const [cognitoDelete] = sent(mockCognitoSend, "AdminDeleteUserCommand");
    expect(cognitoDelete.input).toEqual({ UserPoolId: "us-east-1_pool", Username: "u1" });

    // Endpoints before device rows; Cognito only after the tombstone.
    const order = (mock: jest.Mock, command: unknown) =>
      mock.mock.invocationCallOrder[mock.mock.calls.findIndex(([c]) => c === command)];
    const endpointCalls = sent(mockSnsSend, "DeleteEndpointCommand").map((command) => order(mockSnsSend, command));
    expect(Math.max(...endpointCalls)).toBeLessThan(order(mockSend, deviceDelete));
    expect(order(mockSend, tombstone)).toBeLessThan(order(mockCognitoSend, cognitoDelete));
  });

  it("makes the same calls in the same order as before C1.6, minus the BillStats recompute", async () => {
    fakeDynamo({
      feedback: ["hr-1", "s-2"],
      devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/one" }],
      tokenOwners: { aa11: ["u1"] },
    });

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(202);
    const sequence = mockSend.mock.calls.map(([command]: [FakeCommand]) => {
      const input = command.input;
      const table = input.TableName ?? Object.keys(input.RequestItems ?? {})[0];
      return [command.constructor.name, table, input.IndexName].filter(Boolean).join(":");
    });
    expect(sequence).toEqual([
      "GetItemCommand:UserPII", // eligibility
      "UpdateItemCommand:UserPII", // claim
      "QueryCommand:UserFeedback",
      "BatchWriteItemCommand:UserFeedback",
      "QueryCommand:UserPreferences",
      "QueryCommand:UserDevices",
      "QueryCommand:UserDevices:GSIPushTokenIndex",
      "BatchWriteItemCommand:UserDevices",
      "QueryCommand:UserWeeklyDigests",
      "PutItemCommand:UserPII", // tombstone
    ]);
    expect(sent(mockSnsSend, "DeleteEndpointCommand")).toHaveLength(1);
    expect(sent(mockCognitoSend, "AdminDeleteUserCommand")).toHaveLength(1);
    // X5: with none of the three table variables set, no step runs and no X5 count is reported.
    expect(logSpy).toHaveBeenCalledWith("accountData: account data deleted", {
      userId: "u1",
      items: { feedback: 2, preferences: 0, devices: 1, snsEndpoints: 1, sharedSnsEndpointsKept: 0, weeklyDigests: 0 },
    });
  });

  it("writes no BillStats and queries no bill-id index: the vote stream recomputes the stats (C1.6)", async () => {
    fakeDynamo({ feedback: ["hr-1", "s-2", "hr-1-dup"] });

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(202);
    const feedbackDelete = sent(mockSend, "BatchWriteItemCommand").find(
      (command) => command.input.RequestItems!.UserFeedback,
    );
    expect(
      feedbackDelete!.input.RequestItems!.UserFeedback.map(
        (request: WriteRequest) => request.DeleteRequest?.Key?.billId.S,
      ),
    ).toEqual(["hr-1", "s-2", "hr-1-dup"]);
    expect(sent(mockSend, "PutItemCommand").map((command) => command.input.TableName)).toEqual(["UserPII"]);
    expect(
      sent(mockSend, "QueryCommand").filter((command) => command.input.IndexName === "GSIBillIdIndex"),
    ).toHaveLength(0);
    expect(
      mockSend.mock.calls.some(([command]: [FakeCommand]) => JSON.stringify(command.input).includes("BillStats")),
    ).toBe(false);
  });

  it("ignores NotFound when deleting an endpoint", async () => {
    fakeDynamo({ devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/gone" }] });
    mockSnsSend.mockRejectedValueOnce(awsError("NotFoundException"));

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body).deletionStatus).toBe("completed");
  });

  it("keeps an endpoint that another user's device row still uses, but deletes this user's row", async () => {
    fakeDynamo({
      devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/shared" }],
      tokenOwners: { aa11: ["u1", "other-user"] },
    });

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(202);
    expect(mockSnsSend).not.toHaveBeenCalled();
    const deviceDelete = sent(mockSend, "BatchWriteItemCommand").find(
      (command) => command.input.RequestItems!.UserDevices,
    );
    expect(deviceDelete).toBeDefined();
  });

  it("marks the deletion failed and keeps device rows when an endpoint cannot be deleted", async () => {
    fakeDynamo({ devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/one" }] });
    mockSnsSend.mockRejectedValueOnce(awsError("AuthorizationErrorException", "not authorized"));

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(500);
    expect(lastStatusUpdate()).toBe("failed");
    expect(sent(mockSend, "BatchWriteItemCommand").some((command) => command.input.RequestItems!.UserDevices)).toBe(
      false,
    );
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it("treats a Cognito UserNotFoundException as success", async () => {
    fakeDynamo();
    mockCognitoSend.mockRejectedValueOnce(awsError("UserNotFoundException"));

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body).deletionStatus).toBe("completed");
    expect(lastStatusUpdate()).toBe("in_progress");
  });

  it("keeps the deletion completed when only the Cognito step fails, and tells the client to finish", async () => {
    fakeDynamo();
    mockCognitoSend.mockRejectedValueOnce(awsError("TooManyRequestsException", "Rate exceeded"));

    const response = await handler(deleteEvent());

    // The user's data is gone, so the status must say so; a retry (or the client) finishes the sign-in deletion.
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body);
    expect(body.deletionStatus).toBe("completed");
    expect(body.message).toMatch(/Delete Cognito account from the client/);
    // The completion tombstone is written, and nothing afterwards marks the deletion failed.
    const tombstone = sent(mockSend, "PutItemCommand").pop();
    expect(tombstone!.input.Item!.deletionStatus).toEqual({ S: "completed" });
    const statuses = sent(mockSend, "UpdateItemCommand").map((c) => c.input.ExpressionAttributeValues?.[":status"]?.S);
    expect(statuses).not.toContain("failed");
  });

  it("finishes Cognito deletion for an already-completed deletion and keeps the 200 response", async () => {
    fakeDynamo({ deletionStatus: "completed" });

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).deletionStatus).toBe("completed");
    expect(sent(mockCognitoSend, "AdminDeleteUserCommand")).toHaveLength(1);
    expect(sent(mockSend, "UpdateItemCommand")).toHaveLength(0);
  });

  it("still returns 200 for a completed deletion when Cognito deletion fails", async () => {
    fakeDynamo({ deletionStatus: "completed" });
    mockCognitoSend.mockRejectedValueOnce(awsError("InternalErrorException"));

    const response = await handler(deleteEvent());

    expect(response.statusCode).toBe(200);
  });

  it("leaves the Cognito user to the shipped app, which does not opt in, and keeps the legacy message", async () => {
    fakeDynamo({ devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/one" }] });

    const response = await handler(legacyDeleteEvent());

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      deletionStatus: "completed",
      message: "Account data deleted. Delete Cognito account from the client to finish account removal.",
    });
    expect(sent(mockSnsSend, "DeleteEndpointCommand")).toHaveLength(1);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it("does not delete the Cognito user on the already-completed path unless the client opts in", async () => {
    fakeDynamo({ deletionStatus: "completed" });

    const response = await handler(legacyDeleteEvent());

    expect(response.statusCode).toBe(200);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it("accepts the opt-in as a deleteSignIn=1 query parameter", async () => {
    fakeDynamo();

    const response = await handler({ ...legacyDeleteEvent(), queryStringParameters: { deleteSignIn: "1" } });

    expect(JSON.parse(response.body).message).toBe("Account data and sign-in account deleted.");
    expect(sent(mockCognitoSend, "AdminDeleteUserCommand")).toHaveLength(1);
  });

  it("leaves the Cognito user to the client when USER_POOL_ID is not configured", async () => {
    const previous = process.env.USER_POOL_ID;
    delete process.env.USER_POOL_ID;
    try {
      let isolatedHandler: typeof handler;
      jest.isolateModules(() => {
        isolatedHandler = require("../handlers/accountData").handler;
      });
      fakeDynamo();

      const response = await isolatedHandler!(deleteEvent());

      expect(response.statusCode).toBe(202);
      expect(JSON.parse(response.body)).toEqual({
        deletionStatus: "completed",
        message: "Account data deleted. Delete Cognito account from the client to finish account removal.",
      });
      expect(mockCognitoSend).not.toHaveBeenCalled();
    } finally {
      process.env.USER_POOL_ID = previous;
    }
  });
});

describe("accountData handler, X5 deletion steps", () => {
  const X5_ENV = {
    ADDRESS_CLAIMS_TABLE_NAME: "VerifiedAddressClaims",
    SIGNUP_EMAIL_CLAIMS_TABLE_NAME: "SignUpEmailClaims",
    APP_ATTEST_TABLE_NAME: "AppAttest",
  };
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSnsSend.mockResolvedValue({});
    mockCognitoSend.mockResolvedValue({});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  /** The handler loaded with the X5 table variables set (the infra sets all three). */
  function x5Handler(env: Record<string, string> = X5_ENV): typeof handler {
    const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
    Object.assign(process.env, env);
    try {
      let isolated: typeof handler;
      jest.isolateModules(() => {
        isolated = require("../handlers/accountData").handler;
      });
      return isolated!;
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  /**
   * fakeDynamo plus the X5 tables: u1's PII row points at claim unitA/streetS, its email claim is
   * USER#<userName> -> EMAIL#ek-1 (held by `emailHolder`), and it has two App Attest bindings.
   * `fail` throws for the first command it matches.
   */
  function fakeX5Dynamo(
    options: {
      userName?: string;
      emailHolder?: string;
      fail?: (name: string, input: FakeInput) => Error | undefined;
    } = {},
  ) {
    fakeDynamo({ feedback: ["hr-1"] });
    const base = mockSend.getMockImplementation()!;
    const userName = options.userName ?? "u1";
    mockSend.mockImplementation(async (command: FakeCommand) => {
      const name = command.constructor.name;
      const input = command.input ?? {};
      const failure = options.fail?.(name, input);
      if (failure) throw failure;
      if (name === "GetItemCommand" && input.TableName === "UserPII" && input.ConsistentRead) {
        return {
          Item: {
            verifiedAddressKey: { S: "unitA" },
            verifiedStreetKey: { S: "streetS" },
            addressChangeLog: { L: [{ S: "2026-10-01T00:00:00.000Z" }] },
          },
        };
      }
      if (name === "TransactWriteItemsCommand") return {};
      if (input.TableName === "SignUpEmailClaims") {
        if (name === "GetItemCommand") {
          return input.Key!.pk.S === `USER#${userName}` ? { Item: { emailKey: { S: "ek-1" } } } : {};
        }
        if (name === "DeleteItemCommand") {
          if (input.ConditionExpression && input.ExpressionAttributeValues![":userName"].S !== options.emailHolder) {
            throw awsError("ConditionalCheckFailedException");
          }
          return {};
        }
      }
      if (name === "QueryCommand" && input.TableName === "AppAttest") {
        return {
          Items: ["KEY#k1", "KEY#k2"].map((sk) => ({ pk: input.ExpressionAttributeValues![":pk"], sk: { S: sk } })),
        };
      }
      return base(command);
    });
  }

  const sequence = (): string[] =>
    mockSend.mock.calls.map(([command]: [FakeCommand]) => {
      const input = command.input;
      const table = input.TableName ?? Object.keys(input.RequestItems ?? {})[0];
      return [command.constructor.name, table, input.IndexName].filter(Boolean).join(":");
    });

  const x5Event = (claims: Record<string, string>) => ({
    httpMethod: "DELETE",
    headers: { "X-Billboard-Delete-Sign-In": "1" },
    requestContext: { authorizer: { claims: { sub: "u1", ...claims } } },
  });

  it("runs the three steps after the other data and before the tombstone, using the cognito:username claim", async () => {
    const isolatedHandler = x5Handler();
    fakeX5Dynamo({ userName: "cognito-name-1", emailHolder: "cognito-name-1" });

    const response = await isolatedHandler(x5Event({ "cognito:username": "cognito-name-1" }));

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      deletionStatus: "completed",
      message: "Account data and sign-in account deleted.",
    });
    expect(sequence()).toEqual([
      "GetItemCommand:UserPII", // eligibility
      "UpdateItemCommand:UserPII", // claim
      "QueryCommand:UserFeedback",
      "BatchWriteItemCommand:UserFeedback",
      "QueryCommand:UserPreferences",
      "QueryCommand:UserDevices",
      "QueryCommand:UserWeeklyDigests",
      "GetItemCommand:UserPII", // (a) the claim the row points at, strongly consistent
      "TransactWriteItemsCommand", // (a) delete the claim, decrement both counters
      "UpdateItemCommand:UserPII", // (a) REMOVE verifiedAddressKey, verifiedStreetKey, addressChangeLog
      "GetItemCommand:SignUpEmailClaims", // (b) USER#<userName>
      "DeleteItemCommand:SignUpEmailClaims", // (b) EMAIL#<emailKey> while it names this account
      "DeleteItemCommand:SignUpEmailClaims", // (b) USER#<userName>
      "QueryCommand:AppAttest", // (c) USER#<sub>
      "BatchWriteItemCommand:AppAttest",
      "PutItemCommand:UserPII", // tombstone
    ]);
    const emailCalls = sent(mockSend, "DeleteItemCommand").map((command: FakeCommand) => command.input);
    expect(emailCalls[0]).toEqual(
      expect.objectContaining({
        Key: { pk: { S: "EMAIL#ek-1" } },
        ExpressionAttributeValues: { ":userName": { S: "cognito-name-1" } },
      }),
    );
    expect(emailCalls[1].Key).toEqual({ pk: { S: "USER#cognito-name-1" } });
    const [appAttestQuery] = sent(mockSend, "QueryCommand").filter(
      (command: FakeCommand) => command.input.TableName === "AppAttest",
    );
    expect(appAttestQuery.input.ExpressionAttributeValues).toEqual({ ":pk": { S: "USER#u1" } });
    // Counts only: the proof each step ran.
    expect(logSpy).toHaveBeenCalledWith("accountData: account data deleted", {
      userId: "u1",
      items: expect.objectContaining({ feedback: 1, addressClaims: 1, emailClaims: 2, appAttestBindings: 2 }),
    });
    expect(sent(mockCognitoSend, "AdminDeleteUserCommand")).toHaveLength(1);
  });

  it("reads the username from an access token's username claim, and falls back to the sub without one", async () => {
    const isolatedHandler = x5Handler();

    fakeX5Dynamo({ userName: "access-name", emailHolder: "access-name" });
    await isolatedHandler(x5Event({ username: "access-name" }));
    expect(
      sent(mockSend, "GetItemCommand")
        .filter((command: FakeCommand) => command.input.TableName === "SignUpEmailClaims")
        .map((command: FakeCommand) => command.input.Key!.pk.S),
    ).toEqual(["USER#access-name"]);

    jest.clearAllMocks();
    fakeX5Dynamo({ userName: "u1", emailHolder: "u1" });
    await isolatedHandler(deleteEvent());
    expect(
      sent(mockSend, "GetItemCommand")
        .filter((command: FakeCommand) => command.input.TableName === "SignUpEmailClaims")
        .map((command: FakeCommand) => command.input.Key!.pk.S),
    ).toEqual(["USER#u1"]);
  });

  it("keeps an email claim another account now holds, and still completes", async () => {
    const isolatedHandler = x5Handler();
    fakeX5Dynamo({ emailHolder: "someone-else" });

    const response = await isolatedHandler(deleteEvent());

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body).deletionStatus).toBe("completed");
    expect(logSpy).toHaveBeenCalledWith(
      "accountData: account data deleted",
      expect.objectContaining({ items: expect.objectContaining({ emailClaims: 1 }) }),
    );
  });

  it.each([
    ["the address claim release", (name: string) => name === "TransactWriteItemsCommand"],
    [
      "the email claim delete",
      (name: string, input: FakeInput) => name === "DeleteItemCommand" && input.TableName === "SignUpEmailClaims",
    ],
    [
      "the App Attest bindings delete",
      (name: string, input: FakeInput) => name === "BatchWriteItemCommand" && Boolean(input.RequestItems!.AppAttest),
    ],
  ])("marks the deletion failed when %s fails, writes no tombstone and keeps the sign-in", async (_label, matches) => {
    const isolatedHandler = x5Handler();
    let thrown = false;
    fakeX5Dynamo({
      fail: (name, input) => {
        if (thrown || !matches(name, input)) return undefined;
        thrown = true;
        return awsError("AccessDeniedException", "not authorized");
      },
    });

    const response = await isolatedHandler(deleteEvent());

    expect(response.statusCode).toBe(500);
    expect(lastStatusUpdate()).toBe("failed");
    expect(sent(mockSend, "PutItemCommand")).toHaveLength(0);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it("touches none of the three tables on the already-completed path", async () => {
    const isolatedHandler = x5Handler();
    fakeX5Dynamo();
    mockSend.mockImplementationOnce(async () => ({
      Item: { adultStatus: { S: "attested_adult" }, deletionStatus: { S: "completed" } },
    }));

    const response = await isolatedHandler(deleteEvent());

    expect(response.statusCode).toBe(200);
    expect(sequence()).toEqual(["GetItemCommand:UserPII"]);
  });

  it("runs only the steps whose variable is set", async () => {
    const isolatedHandler = x5Handler({ APP_ATTEST_TABLE_NAME: "AppAttest" });
    fakeX5Dynamo();

    const response = await isolatedHandler(deleteEvent());

    expect(response.statusCode).toBe(202);
    const tables = new Set(sequence().map((entry) => entry.split(":")[1]));
    expect(tables.has("AppAttest")).toBe(true);
    expect(tables.has("SignUpEmailClaims")).toBe(false);
    expect(sent(mockSend, "TransactWriteItemsCommand")).toHaveLength(0);
    expect(sent(mockSend, "GetItemCommand")).toHaveLength(1); // eligibility only
    expect(logSpy).toHaveBeenCalledWith("accountData: account data deleted", {
      userId: "u1",
      items: expect.not.objectContaining({ addressClaims: expect.anything() }),
    });
  });
});

export {};
