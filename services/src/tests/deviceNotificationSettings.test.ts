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

  // UX-28: the Weekly Brief push flag has no default. It is returned and kept only once stored, and only an app that
  // sends it (1.3) stores it, so 1.1 and 1.2 devices never get the Sunday push (decision D2).
  describe("the Weekly Brief flag (notify_weekly_brief)", () => {
    const signedIn = { authorizer: { jwt: { claims: { sub: "user-1" } } } };
    const adult = { Item: { adultStatus: { S: "attested_adult" } } };
    const storedRow = (extra: Record<string, unknown> = {}) => ({
      Item: {
        user_id: { S: "user-1" },
        device_id: { S: "device-1" },
        platform: { S: "ios" },
        pushToken: { S: "push-abc" },
        endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
        notificationsEnabled: { BOOL: true },
        notifyNew: { BOOL: false },
        notifyUpdated: { BOOL: true },
        notifyAlert: { BOOL: true },
        notifyPassed: { BOOL: true },
        notifyFailed: { BOOL: true },
        ...extra,
      },
    });
    const get = () =>
      handler(
        asApiGatewayEvent({
          httpMethod: "GET",
          queryStringParameters: { device_id: "device-1" },
          requestContext: signedIn,
        }),
      );
    const put = (body: Record<string, unknown>) =>
      handler(
        asApiGatewayEvent({
          httpMethod: "PUT",
          body: JSON.stringify({ device_id: "device-1", ...body }),
          requestContext: signedIn,
        }),
      );
    const putItem = () => mockDynamoSend.mock.calls[2][0].input.Item;

    it("is left out of GET while the row has never stored it", async () => {
      mockDynamoSend.mockResolvedValueOnce(storedRow());

      const result = await get();

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).not.toHaveProperty("notify_weekly_brief");
    });

    it.each([true, false])("is returned by GET once stored (%s)", async (stored) => {
      mockDynamoSend.mockResolvedValueOnce(storedRow({ notifyWeeklyBrief: { BOOL: stored } }));

      const result = await get();

      expect(JSON.parse(result.body)).toEqual(
        expect.objectContaining({ notify_weekly_brief: stored, notify_new: false }),
      );
    });

    it("is never created by a PUT without it (as 1.1 and 1.2 send)", async () => {
      mockDynamoSend.mockResolvedValueOnce(adult).mockResolvedValueOnce(storedRow()).mockResolvedValueOnce({});

      const result = await put({ notify_new: true });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).not.toHaveProperty("notify_weekly_brief");
      expect(putItem()).not.toHaveProperty("notifyWeeklyBrief");
      expect(putItem().notifyNew).toEqual({ BOOL: true });
    });

    it.each([true, false])("keeps a stored value (%s) through a PUT without it", async (stored) => {
      mockDynamoSend
        .mockResolvedValueOnce(adult)
        .mockResolvedValueOnce(storedRow({ notifyWeeklyBrief: { BOOL: stored } }))
        .mockResolvedValueOnce({});

      const result = await put({ notifications_enabled: false });

      expect(JSON.parse(result.body)).toEqual(
        expect.objectContaining({ notifications_enabled: false, notify_weekly_brief: stored }),
      );
      expect(putItem().notifyWeeklyBrief).toEqual({ BOOL: stored });
      expect(putItem().notificationsEnabled).toEqual({ BOOL: false });
    });

    it("stores a PUT carrying only the flag and leaves the other switches and the endpoint as they were", async () => {
      mockDynamoSend
        .mockResolvedValueOnce(adult)
        .mockResolvedValueOnce(storedRow({ notifyWeeklyBrief: { BOOL: true } }))
        .mockResolvedValueOnce({});

      const result = await put({ notify_weekly_brief: false });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        device_id: "device-1",
        notifications_enabled: true,
        notify_new: false,
        notify_updated: true,
        notify_alert: true,
        notify_passed: true,
        notify_failed: true,
        notify_weekly_brief: false,
      });
      expect(putItem()).toEqual(
        expect.objectContaining({
          notifyWeeklyBrief: { BOOL: false },
          notifyNew: { BOOL: false },
          endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          pushToken: { S: "push-abc" },
        }),
      );
    });

    it("creates it on a device that never had it when the PUT sends it", async () => {
      mockDynamoSend.mockResolvedValueOnce(adult).mockResolvedValueOnce(storedRow()).mockResolvedValueOnce({});

      const result = await put({ notify_weekly_brief: true });

      expect(JSON.parse(result.body).notify_weekly_brief).toBe(true);
      expect(putItem().notifyWeeklyBrief).toEqual({ BOOL: true });
    });

    it.each(["true", 1, null])("rejects %p as the flag and writes nothing", async (value) => {
      mockDynamoSend.mockResolvedValueOnce(adult);

      const result = await put({ notify_weekly_brief: value });

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain("notify_weekly_brief");
      expect(mockDynamoSend).toHaveBeenCalledTimes(1);
    });
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
