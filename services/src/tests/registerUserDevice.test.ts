process.env.TABLE_NAME = "test-table";
process.env.PARTITION_KEY = "user_id";
process.env.SORT_KEY = "device_id";
process.env.PII_TABLE_NAME = "pii-table";
process.env.PII_PARTITION_KEY = "user_id";
process.env.APNS_PLATFORM_APPLICATION_ARN = "arn:aws:sns:us-east-1:123456789012:app/APNS/test";
process.env.PUSH_TOKEN_INDEX = "GSIPushTokenIndex";

const PUSH_TOKEN = "a".repeat(64);

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    DeleteItemCommand: jest.fn((input) => ({ input })),
    GetItemCommand: jest.fn((input) => ({ input })),
    PutItemCommand: jest.fn((input) => ({ input })),
    QueryCommand: jest.fn((input) => ({ input })),
    ScanCommand: jest.fn((input) => ({ input })),
    UpdateItemCommand: jest.fn((input) => ({ input })),
    __mockSendDynamo: mockSend,
  };
});

jest.mock("@aws-sdk/client-sns", () => {
  const mockSend = jest.fn();
  return {
    SNSClient: jest.fn(() => ({ send: mockSend })),
    CreatePlatformEndpointCommand: jest.fn((input) => ({ input })),
    SetEndpointAttributesCommand: jest.fn((input) => ({ input })),
    __mockSendSNS: mockSend,
  };
});

import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { applySetUpdate } from "./fixtures/dynamoUpdate";
import { handler } from "../../src/handlers/registerUserDevice";

describe("registerUserDevice handler", () => {
  const { __mockSendDynamo: mockDynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb");
  const { __mockSendSNS: mockSnsSend } = jest.requireMock("@aws-sdk/client-sns");
  const { DeleteItemCommand, PutItemCommand, QueryCommand, ScanCommand, UpdateItemCommand } =
    jest.requireMock("@aws-sdk/client-dynamodb");
  /**
   * The row the registration leaves: its last call, an UpdateItem, applied as DynamoDB would to the row its GetItem
   * read (the second call's answer, after the eligibility read).
   */
  const writtenRow = async () => {
    const stored = (await mockDynamoSend.mock.results[1].value)?.Item;
    const lastCall = mockDynamoSend.mock.calls[mockDynamoSend.mock.calls.length - 1];
    return applySetUpdate(stored, lastCall[0].input);
  };
  const { CreatePlatformEndpointCommand, SetEndpointAttributesCommand } = jest.requireMock("@aws-sdk/client-sns");

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = "test-table";
    process.env.PARTITION_KEY = "user_id";
    process.env.SORT_KEY = "device_id";
    process.env.PII_TABLE_NAME = "pii-table";
    process.env.PII_PARTITION_KEY = "user_id";
  });

  it("should return 400 if device_id, platform, or push_token is missing", async () => {
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
      body: JSON.stringify({}),
    };

    const result = await handler(asApiGatewayEvent(event));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Missing device_id, platform, or push_token" });
  });

  it("should return 200 and register the device successfully", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({}); // GetItem
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query conflicts by push token
    mockSnsSend.mockResolvedValueOnce({ EndpointArn: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123" }); // CreatePlatformEndpoint
    mockDynamoSend.mockResolvedValueOnce({}); // UpdateItem

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
      body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
    };

    const result = await handler(asApiGatewayEvent(event));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe("Device registered");
    expect(body.endpointArn).toBe("arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123");

    expect(mockDynamoSend).toHaveBeenCalled();
    const updateCall = mockDynamoSend.mock.calls[mockDynamoSend.mock.calls.length - 1];
    expect(updateCall[0].input.TableName).toBe("test-table");
    expect(await writtenRow()).toEqual({
      user_id: { S: "user123" },
      device_id: { S: "device123" },
      platform: { S: "ios" },
      pushToken: { S: PUSH_TOKEN },
      endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123" },
      notificationsEnabled: { BOOL: true },
      notifyNew: { BOOL: true },
      notifyUpdated: { BOOL: true },
      notifyAlert: { BOOL: true },
      notifyPassed: { BOOL: true },
      notifyFailed: { BOOL: true },
      updatedAt: { S: expect.any(String) },
    });
    expect(PutItemCommand).not.toHaveBeenCalled();
  });

  // UX-28 review: a whole-row PutItem built from the earlier read could erase a deviceNotificationSettings PUT that
  // landed in between, such as app 1.3 storing notify_weekly_brief. The registration now sets only its own fields and
  // the switch defaults, in one UpdateItem.
  it("writes only the registration and the switch defaults, never the Weekly Brief flag", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({}); // GetItem
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query conflicts by push token
    mockSnsSend.mockResolvedValueOnce({ EndpointArn: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123" });
    mockSnsSend.mockResolvedValueOnce({}); // SetEndpointAttributes
    mockDynamoSend.mockResolvedValueOnce({}); // UpdateItem

    await handler(registerEvent());

    expect(UpdateItemCommand).toHaveBeenCalledTimes(1);
    const input = UpdateItemCommand.mock.calls[0][0];
    expect(input.Key).toEqual({ user_id: { S: "user123" }, device_id: { S: "device123" } });
    expect(Object.values(input.ExpressionAttributeNames)).not.toContain("notifyWeeklyBrief");
    // Each switch keeps a stored value; only a missing one gets its default.
    expect(input.UpdateExpression.match(/if_not_exists/g)).toHaveLength(6);
    // A row the settings PUT changed after the GetItem keeps that change.
    expect(
      applySetUpdate(
        { user_id: { S: "user123" }, device_id: { S: "device123" }, notifyWeeklyBrief: { BOOL: true } },
        input,
      ).notifyWeeklyBrief,
    ).toEqual({ BOOL: true });
  });

  // An endpoint SNS disabled (APNs refused a push to it) keeps Enabled=false when CreatePlatformEndpoint hands it back.
  const ENDPOINT_ARN = "arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123";
  const registerEvent = () =>
    asApiGatewayEvent({
      requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
      body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
    });
  const snsInputs = () =>
    mockSnsSend.mock.calls.map(([command]: [{ input: Record<string, unknown> }]) => command.input);

  it("enables the endpoint CreatePlatformEndpoint returns, which may be one SNS disabled", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({}); // GetItem: userNotifier removed the disabled endpoint's ARN
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query conflicts by push token
    mockSnsSend.mockResolvedValueOnce({ EndpointArn: ENDPOINT_ARN }); // CreatePlatformEndpoint: the existing endpoint
    mockSnsSend.mockResolvedValueOnce({}); // SetEndpointAttributes
    mockDynamoSend.mockResolvedValueOnce({}); // UpdateItem

    const result = await handler(registerEvent());

    expect(result.statusCode).toBe(200);
    expect(snsInputs()).toEqual([
      {
        PlatformApplicationArn: "arn:aws:sns:us-east-1:123456789012:app/APNS/test",
        Token: PUSH_TOKEN,
        CustomUserData: "user123:device123",
      },
      { EndpointArn: ENDPOINT_ARN, Attributes: { Token: PUSH_TOKEN, Enabled: "true" } },
    ]);
    expect(CreatePlatformEndpointCommand).toHaveBeenCalledTimes(1);
    expect(SetEndpointAttributesCommand).toHaveBeenCalledTimes(1);
    expect((await writtenRow()).endpointArn.S).toBe(ENDPOINT_ARN);
  });

  it("enables the endpoint named in SNS's already-exists error", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({}); // GetItem
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query conflicts by push token
    mockSnsSend.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `Invalid parameter: Token Reason: Endpoint ${ENDPOINT_ARN} already exists with the same Token, but different attributes.`,
        ),
        { name: "InvalidParameterException" },
      ),
    ); // CreatePlatformEndpoint
    mockSnsSend.mockResolvedValueOnce({}); // SetEndpointAttributes
    mockDynamoSend.mockResolvedValueOnce({}); // UpdateItem

    const result = await handler(registerEvent());

    expect(result.statusCode).toBe(200);
    expect(snsInputs()[1]).toEqual({ EndpointArn: ENDPOINT_ARN, Attributes: { Token: PUSH_TOKEN, Enabled: "true" } });
    expect((await writtenRow()).endpointArn.S).toBe(ENDPOINT_ARN);
  });

  it("stores nothing when the endpoint cannot be enabled", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({}); // GetItem
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query conflicts by push token
    mockSnsSend.mockResolvedValueOnce({ EndpointArn: ENDPOINT_ARN }); // CreatePlatformEndpoint
    mockSnsSend.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await handler(registerEvent());

    expect(result.statusCode).toBe(500);
    expect(UpdateItemCommand).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("refreshes a stored endpoint with one SetEndpointAttributes and no CreatePlatformEndpoint", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({
      Item: { user_id: { S: "user123" }, device_id: { S: "device123" }, endpointArn: { S: ENDPOINT_ARN } },
    }); // GetItem: an older token
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query conflicts by push token
    mockSnsSend.mockResolvedValueOnce({}); // SetEndpointAttributes
    mockDynamoSend.mockResolvedValueOnce({}); // UpdateItem

    const result = await handler(registerEvent());

    expect(result.statusCode).toBe(200);
    expect(CreatePlatformEndpointCommand).not.toHaveBeenCalled();
    expect(snsInputs()).toEqual([{ EndpointArn: ENDPOINT_ARN, Attributes: { Token: PUSH_TOKEN, Enabled: "true" } }]);
  });

  it("preserves existing notification settings when token is refreshed", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        user_id: { S: "user123" },
        device_id: { S: "device123" },
        endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123" },
        notificationsEnabled: { BOOL: false },
        notifyNew: { BOOL: false },
        notifyUpdated: { BOOL: true },
        notifyAlert: { BOOL: false },
        notifyPassed: { BOOL: true },
        notifyFailed: { BOOL: false },
      },
    }); // GetItem
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query conflicts by push token
    mockSnsSend.mockResolvedValueOnce({}); // SetEndpointAttributes
    mockDynamoSend.mockResolvedValueOnce({}); // UpdateItem

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
      body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
    };

    const result = await handler(asApiGatewayEvent(event));
    expect(result.statusCode).toBe(200);

    const written = await writtenRow();
    expect(written.notificationsEnabled.BOOL).toBe(false);
    expect(written.notifyNew.BOOL).toBe(false);
    expect(written.notifyUpdated.BOOL).toBe(true);
    expect(written.notifyAlert.BOOL).toBe(false);
    expect(written.notifyPassed.BOOL).toBe(true);
    expect(written.notifyFailed.BOOL).toBe(false);
    // A row without the Weekly Brief flag (every 1.1 and 1.2 device) stays without it.
    expect(written).not.toHaveProperty("notifyWeeklyBrief");
  });

  // UX-28: a new token must neither opt the device out of the Sunday push nor (written as a default) opt a 1.2 device
  // in: the stored flag is kept exactly.
  it.each([true, false])("carries a stored Weekly Brief flag (%s) over to the new token", async (stored) => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        user_id: { S: "user123" },
        device_id: { S: "device123" },
        pushToken: { S: "b".repeat(64) },
        endpointArn: { S: ENDPOINT_ARN },
        notificationsEnabled: { BOOL: true },
        notifyWeeklyBrief: { BOOL: stored },
      },
    }); // GetItem
    mockDynamoSend.mockResolvedValueOnce({ Items: [] }); // Query conflicts by push token
    mockSnsSend.mockResolvedValueOnce({}); // SetEndpointAttributes
    mockDynamoSend.mockResolvedValueOnce({}); // UpdateItem

    const result = await handler(registerEvent());

    expect(result.statusCode).toBe(200);
    expect((await writtenRow()).pushToken.S).toBe(PUSH_TOKEN);
    expect((await writtenRow()).notifyWeeklyBrief).toEqual({ BOOL: stored });
  });

  it("returns early when the device is already registered with the same token", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: { adultStatus: { S: "attested_adult" } },
    }); // eligibility
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        user_id: { S: "user123" },
        device_id: { S: "device123" },
        platform: { S: "ios" },
        pushToken: { S: PUSH_TOKEN },
        endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/existing123" },
        notificationsEnabled: { BOOL: true },
        notifyNew: { BOOL: true },
        notifyUpdated: { BOOL: true },
        notifyAlert: { BOOL: true },
        notifyPassed: { BOOL: true },
        notifyFailed: { BOOL: true },
      },
    }); // GetItem

    const result = await handler(
      asApiGatewayEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
        body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      message: "Device registered",
      endpointArn: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/existing123",
    });
    expect(ScanCommand).not.toHaveBeenCalled();
    expect(UpdateItemCommand).not.toHaveBeenCalled();
    expect(CreatePlatformEndpointCommand).not.toHaveBeenCalled();
    expect(SetEndpointAttributesCommand).not.toHaveBeenCalled();
    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });

  it("should return 500 if an error occurs", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(new Error("DynamoDB error"));
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockSnsSend.mockResolvedValueOnce({
      EndpointArn: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123",
    });

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
      body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
    };

    const result = await handler(asApiGatewayEvent(event));
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: "Internal server error" });
    expect(mockDynamoSend).toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "Error registering device:",
      expect.objectContaining({ message: "DynamoDB error" }),
    );
    errorLog.mockRestore();
  });

  it("allows registration when adult attestation is still unknown", async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    mockDynamoSend.mockResolvedValueOnce({});
    mockDynamoSend.mockResolvedValueOnce({ Items: [] });
    mockSnsSend.mockResolvedValueOnce({ EndpointArn: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123" });
    mockDynamoSend.mockResolvedValueOnce({});

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
      body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
    };

    const result = await handler(asApiGatewayEvent(event));
    expect(result.statusCode).toBe(200);
  });

  it("rejects a push token that is not hex", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } });
    const result = await handler(
      asApiGatewayEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
        body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: "not-a-token" }),
      }),
    );
    expect(result.statusCode).toBe(400);
    expect(QueryCommand).not.toHaveBeenCalled();
    expect(ScanCommand).not.toHaveBeenCalled();
  });

  it("returns 500 and registers nothing when the eligibility lookup fails", async () => {
    mockDynamoSend.mockRejectedValueOnce(new Error("DynamoDB unavailable"));
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await handler(
      asApiGatewayEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
        body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
      }),
    );
    expect(result.statusCode).toBe(500);
    expect(UpdateItemCommand).not.toHaveBeenCalled();
    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "Error registering device:",
      expect.objectContaining({ message: "DynamoDB unavailable" }),
    );
    errorLog.mockRestore();
  });

  it("removes another user's registration only when it holds the same push token", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: { adultStatus: { S: "attested_adult" } },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          { user_id: { S: "other-user" }, device_id: { S: "device123" } },
          { user_id: { S: "user123" }, device_id: { S: "device123" } },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    mockSnsSend.mockResolvedValueOnce({ EndpointArn: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/endpoint123" });

    const result = await handler(
      asApiGatewayEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
        body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(ScanCommand).not.toHaveBeenCalled();
    expect(QueryCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: "test-table",
        IndexName: "GSIPushTokenIndex",
        KeyConditionExpression: "#pushToken = :pushToken",
        ExpressionAttributeValues: { ":pushToken": { S: PUSH_TOKEN } },
      }),
    );
    expect(DeleteItemCommand).toHaveBeenCalledTimes(1);
    expect(DeleteItemCommand).toHaveBeenCalledWith({
      TableName: "test-table",
      Key: {
        user_id: { S: "other-user" },
        device_id: { S: "device123" },
      },
    });
  });
});

export {};
