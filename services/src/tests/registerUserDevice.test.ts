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
import { handler } from "../../src/handlers/registerUserDevice";

describe("registerUserDevice handler", () => {
  const { __mockSendDynamo: mockDynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb");
  const { __mockSendSNS: mockSnsSend } = jest.requireMock("@aws-sdk/client-sns");
  const { DeleteItemCommand, PutItemCommand, QueryCommand, ScanCommand } = jest.requireMock("@aws-sdk/client-dynamodb");
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
    mockDynamoSend.mockResolvedValueOnce({}); // PutItem

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
    const putCall = mockDynamoSend.mock.calls[mockDynamoSend.mock.calls.length - 1];
    const putInput = putCall[0].input || putCall[0];
    expect(putInput.TableName).toBe("test-table");
    expect(putInput.Item.user_id.S).toBe("user123");
    expect(putInput.Item.device_id.S).toBe("device123");
    expect(putInput.Item.platform.S).toBe("ios");
    expect(putInput.Item.pushToken.S).toBe(PUSH_TOKEN);
    expect(putInput.Item.notificationsEnabled.BOOL).toBe(true);
    expect(putInput.Item.notifyNew.BOOL).toBe(true);
    expect(putInput.Item.notifyUpdated.BOOL).toBe(true);
    expect(putInput.Item.notifyAlert.BOOL).toBe(true);
    expect(putInput.Item.notifyPassed.BOOL).toBe(true);
    expect(putInput.Item.notifyFailed.BOOL).toBe(true);
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
    mockDynamoSend.mockResolvedValueOnce({}); // PutItem

    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
      body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
    };

    const result = await handler(asApiGatewayEvent(event));
    expect(result.statusCode).toBe(200);

    const putCall = mockDynamoSend.mock.calls[mockDynamoSend.mock.calls.length - 1];
    const putInput = putCall[0].input || putCall[0];
    expect(putInput.Item.notificationsEnabled.BOOL).toBe(false);
    expect(putInput.Item.notifyNew.BOOL).toBe(false);
    expect(putInput.Item.notifyUpdated.BOOL).toBe(true);
    expect(putInput.Item.notifyAlert.BOOL).toBe(false);
    expect(putInput.Item.notifyPassed.BOOL).toBe(true);
    expect(putInput.Item.notifyFailed.BOOL).toBe(false);
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
    expect(PutItemCommand).not.toHaveBeenCalled();
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
    const result = await handler(
      asApiGatewayEvent({
        requestContext: { authorizer: { jwt: { claims: { sub: "user123" } } } },
        body: JSON.stringify({ device_id: "device123", platform: "ios", push_token: PUSH_TOKEN }),
      }),
    );
    expect(result.statusCode).toBe(500);
    expect(PutItemCommand).not.toHaveBeenCalled();
    expect(mockSnsSend).not.toHaveBeenCalled();
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
