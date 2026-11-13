process.env.TABLE_NAME = "UserDevices";
process.env.PARTITION_KEY = "user_id";
process.env.SORT_KEY = "device_id";
process.env.PII_TABLE_NAME = "pii-table";
process.env.PII_PARTITION_KEY = "user_id";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    GetItemCommand: jest.fn((input) => ({ input })),
    PutItemCommand: jest.fn((input) => ({ input })),
    __mockSendDynamo: mockSend,
  };
});

import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { handler } from "../../src/handlers/deviceNotificationSettings";

describe("deviceNotificationSettings handler", () => {
  const { __mockSendDynamo: mockDynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb");

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TABLE_NAME = "UserDevices";
    process.env.PARTITION_KEY = "user_id";
    process.env.SORT_KEY = "device_id";
    process.env.PII_TABLE_NAME = "pii-table";
    process.env.PII_PARTITION_KEY = "user_id";
  });

  it("returns 401 when user is not authenticated", async () => {
    const result = await handler(
      asApiGatewayEvent({
        httpMethod: "GET",
        queryStringParameters: { device_id: "device-1" },
      }),
    );

    expect(result.statusCode).toBe(401);
  });

  it("returns default settings when device record does not exist", async () => {
    mockDynamoSend.mockResolvedValueOnce({});

    const result = await handler(
      asApiGatewayEvent({
        httpMethod: "GET",
        queryStringParameters: { device_id: "device-1" },
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      device_id: "device-1",
      notifications_enabled: true,
      notify_new: true,
      notify_updated: true,
      notify_alert: true,
      notify_passed: true,
      notify_failed: true,
    });
  });

  it("updates settings and preserves existing endpoint fields", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: {
          adultStatus: { S: "attested_adult" },
        },
      })
      .mockResolvedValueOnce({
        Item: {
          user_id: { S: "user-1" },
          device_id: { S: "device-1" },
          platform: { S: "ios" },
          pushToken: { S: "push-abc" },
          endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          notificationsEnabled: { BOOL: true },
          notifyNew: { BOOL: true },
          notifyUpdated: { BOOL: true },
          notifyAlert: { BOOL: true },
          notifyPassed: { BOOL: true },
          notifyFailed: { BOOL: false },
        },
      })
      .mockResolvedValueOnce({});

    const result = await handler(
      asApiGatewayEvent({
        httpMethod: "PUT",
        body: JSON.stringify({
          device_id: "device-1",
          notifications_enabled: false,
          notify_new: false,
        }),
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      device_id: "device-1",
      notifications_enabled: false,
      notify_new: false,
      notify_updated: true,
      notify_alert: true,
      notify_passed: true,
      notify_failed: false,
    });

    const putInput = mockDynamoSend.mock.calls[2][0].input;
    expect(putInput.Item.platform.S).toBe("ios");
    expect(putInput.Item.pushToken.S).toBe("push-abc");
    expect(putInput.Item.endpointArn.S).toContain("endpoint/APNS/app/device-1");
    expect(putInput.Item.notificationsEnabled.BOOL).toBe(false);
    expect(putInput.Item.notifyNew.BOOL).toBe(false);
    expect(putInput.Item.notifyFailed.BOOL).toBe(false);
  });

  it("returns 400 when boolean fields are invalid", async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        adultStatus: { S: "attested_adult" },
      },
    });

    const result = await handler(
      asApiGatewayEvent({
        httpMethod: "PUT",
        body: JSON.stringify({
          device_id: "device-1",
          notify_new: "false",
        }),
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      }),
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain("Invalid boolean field");
  });

  it("allows updates when adult attestation is still unknown", async () => {
    mockDynamoSend.mockResolvedValueOnce({});
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        user_id: { S: "user-1" },
        device_id: { S: "device-1" },
      },
    });
    mockDynamoSend.mockResolvedValueOnce({});

    const result = await handler(
      asApiGatewayEvent({
        httpMethod: "PUT",
        body: JSON.stringify({
          device_id: "device-1",
          notify_new: false,
        }),
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual(expect.objectContaining({ device_id: "device-1" }));
  });
});

export {};
