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
    UpdateItemCommand: jest.fn((input) => ({ input })),
    __mockSendDynamo: mockSend,
  };
});

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { applySetUpdate, type SetUpdateInput } from "./fixtures/dynamoUpdate";
import { handler } from "../../src/handlers/deviceNotificationSettings";

type Row = Record<string, AttributeValue>;

describe("deviceNotificationSettings handler", () => {
  const { __mockSendDynamo: mockDynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb");
  const { PutItemCommand, UpdateItemCommand } = jest.requireMock("@aws-sdk/client-dynamodb");
  /** The PUT's UpdateItem answered as DynamoDB would on `row` (undefined: no row yet), with ReturnValues ALL_NEW. */
  const updateOn =
    (row: Row | undefined) =>
    async ({ input }: { input: SetUpdateInput }) => ({ Attributes: applySetUpdate(row, input) });
  /** The PUT's UpdateItem input: the call after the eligibility read. */
  const updateInput = (): SetUpdateInput & { ReturnValues?: string } => mockDynamoSend.mock.calls[1][0].input;
  /** The names the PUT's UpdateItem writes. */
  const writtenNames = (): string[] => Object.values(updateInput().ExpressionAttributeNames ?? {});

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
    const stored: Row = {
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
    };
    mockDynamoSend
      .mockResolvedValueOnce({
        Item: {
          adultStatus: { S: "attested_adult" },
        },
      })
      .mockImplementationOnce(updateOn(stored));

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

    const written = applySetUpdate(stored, updateInput());
    expect(written.platform.S).toBe("ios");
    expect(written.pushToken.S).toBe("push-abc");
    expect(written.endpointArn.S).toContain("endpoint/APNS/app/device-1");
    expect(written.notificationsEnabled.BOOL).toBe(false);
    expect(written.notifyNew.BOOL).toBe(false);
    expect(written.notifyFailed.BOOL).toBe(false);
    expect(mockDynamoSend).toHaveBeenCalledTimes(2);
  });

  // UX-28 review: a whole-row PutItem built from an earlier read could undo a registerUserDevice write that landed in
  // between (or be undone by it). The PUT now sets only the switches, in one UpdateItem.
  it("writes only the switches, in one UpdateItem, never the registration fields", async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } }).mockImplementationOnce(
      updateOn({
        user_id: { S: "user-1" },
        device_id: { S: "device-1" },
        endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
      }),
    );

    await handler(
      asApiGatewayEvent({
        httpMethod: "PUT",
        body: JSON.stringify({ device_id: "device-1", notify_new: false }),
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      }),
    );

    expect(UpdateItemCommand).toHaveBeenCalledTimes(1);
    expect(PutItemCommand).not.toHaveBeenCalled();
    expect(updateInput().ReturnValues).toBe("ALL_NEW");
    expect(writtenNames()).toEqual(
      expect.not.arrayContaining(["platform", "pushToken", "endpointArn", "notifyWeeklyBrief"]),
    );
    expect(updateInput().UpdateExpression).toContain("if_not_exists");
  });

  it("stores the defaults on a row that has none, and the switches the body sends", async () => {
    mockDynamoSend
      .mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" } } })
      .mockImplementationOnce(updateOn(undefined));

    const result = await handler(
      asApiGatewayEvent({
        httpMethod: "PUT",
        body: JSON.stringify({ device_id: "device-1", notify_passed: false }),
        requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      }),
    );

    expect(JSON.parse(result.body)).toEqual({
      device_id: "device-1",
      notifications_enabled: true,
      notify_new: true,
      notify_updated: true,
      notify_alert: true,
      notify_passed: false,
      notify_failed: true,
    });
    expect(applySetUpdate(undefined, updateInput())).toEqual({
      user_id: { S: "user-1" },
      device_id: { S: "device-1" },
      notificationsEnabled: { BOOL: true },
      notifyNew: { BOOL: true },
      notifyUpdated: { BOOL: true },
      notifyAlert: { BOOL: true },
      notifyPassed: { BOOL: false },
      notifyFailed: { BOOL: true },
      updatedAt: { S: expect.any(String) },
    });
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
    const storedRow = (extra: Row = {}): { Item: Row } => ({
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
    /** The row the PUT leaves when the stored row is `stored`. */
    const written = (stored: { Item: Row }) => applySetUpdate(stored.Item, updateInput());
    const putOn = (stored: { Item: Row }) =>
      mockDynamoSend.mockResolvedValueOnce(adult).mockImplementationOnce(updateOn(stored.Item));

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
      const stored = storedRow();
      putOn(stored);

      const result = await put({ notify_new: true });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).not.toHaveProperty("notify_weekly_brief");
      expect(written(stored)).not.toHaveProperty("notifyWeeklyBrief");
      expect(writtenNames()).not.toContain("notifyWeeklyBrief");
      expect(written(stored).notifyNew).toEqual({ BOOL: true });
    });

    it.each([true, false])("keeps a stored value (%s) through a PUT without it", async (stored) => {
      const row = storedRow({ notifyWeeklyBrief: { BOOL: stored } });
      putOn(row);

      const result = await put({ notifications_enabled: false });

      expect(JSON.parse(result.body)).toEqual(
        expect.objectContaining({ notifications_enabled: false, notify_weekly_brief: stored }),
      );
      expect(writtenNames()).not.toContain("notifyWeeklyBrief");
      expect(written(row).notifyWeeklyBrief).toEqual({ BOOL: stored });
      expect(written(row).notificationsEnabled).toEqual({ BOOL: false });
    });

    it("stores a PUT carrying only the flag and leaves the other switches and the endpoint as they were", async () => {
      const row = storedRow({ notifyWeeklyBrief: { BOOL: true } });
      putOn(row);

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
      expect(written(row)).toEqual(
        expect.objectContaining({
          notifyWeeklyBrief: { BOOL: false },
          notifyNew: { BOOL: false },
          endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/app/device-1" },
          pushToken: { S: "push-abc" },
        }),
      );
    });

    it("creates it on a device that never had it when the PUT sends it", async () => {
      const row = storedRow();
      putOn(row);

      const result = await put({ notify_weekly_brief: true });

      expect(JSON.parse(result.body).notify_weekly_brief).toBe(true);
      expect(written(row).notifyWeeklyBrief).toEqual({ BOOL: true });
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
    mockDynamoSend.mockImplementationOnce(
      updateOn({
        user_id: { S: "user-1" },
        device_id: { S: "device-1" },
      }),
    );

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
