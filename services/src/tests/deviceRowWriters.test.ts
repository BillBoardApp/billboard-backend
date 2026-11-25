process.env.TABLE_NAME = "UserDevices";
process.env.PARTITION_KEY = "user_id";
process.env.SORT_KEY = "device_id";
process.env.PII_TABLE_NAME = "pii-table";
process.env.PII_PARTITION_KEY = "user_id";
process.env.APNS_PLATFORM_APPLICATION_ARN = "arn:aws:sns:us-east-1:123456789012:app/APNS/test";
process.env.PUSH_TOKEN_INDEX = "GSIPushTokenIndex";

/*
 * UX-28 review: the two device-row writers, registerUserDevice (a new APNs token) and deviceNotificationSettings (the
 * switches, app 1.3's Weekly Brief flag among them), against one in-memory table. Each used to read the row and then
 * replace it whole, so a write landing between the other's read and write was lost: a flag stored during a token change
 * silently opted the device out of the Sunday push. Both now write with UpdateItem, so neither undoes the other.
 */

jest.mock("@aws-sdk/client-dynamodb", () => {
  const { applySetUpdate } = jest.requireActual("./fixtures/dynamoUpdate");
  const world = {
    rows: new Map<string, Record<string, unknown>>(),
    /** Called when a CreatePlatformEndpoint starts; it then waits for `releaseCreate`. */
    createStarted: undefined as undefined | (() => void),
    releaseCreate: undefined as undefined | (() => void),
  };
  const keyOf = (key: Record<string, { S: string }>) => `${key.user_id.S}|${key.device_id.S}`;
  const send = async ({ type, input }: { type: string; input: Record<string, never> }) => {
    if (input.TableName === "pii-table") return { Item: { adultStatus: { S: "attested_adult" } } };
    switch (type) {
      case "GetItem":
        return { Item: world.rows.get(keyOf(input.Key)) };
      case "Query":
        return { Items: [] };
      case "PutItem":
        // The earlier writers' whole-row replace, kept so this test shows what it lost.
        world.rows.set(keyOf(input.Item), input.Item);
        return {};
      case "UpdateItem": {
        const next = applySetUpdate(world.rows.get(keyOf(input.Key)), input);
        world.rows.set(keyOf(input.Key), next);
        return { Attributes: next };
      }
      default:
        throw new Error(`Unexpected ${type}`);
    }
  };
  const command = (type: string) => jest.fn((input) => ({ type, input }));
  return {
    DynamoDBClient: jest.fn(() => ({ send })),
    DeleteItemCommand: command("DeleteItem"),
    GetItemCommand: command("GetItem"),
    PutItemCommand: command("PutItem"),
    QueryCommand: command("Query"),
    UpdateItemCommand: command("UpdateItem"),
    __world: world,
  };
});

jest.mock("@aws-sdk/client-sns", () => {
  const send = async ({ type }: { type: string }) => {
    const world = jest.requireMock("@aws-sdk/client-dynamodb").__world;
    if (type !== "CreatePlatformEndpoint") return {};
    world.createStarted?.();
    await new Promise<void>((resolve) => {
      world.releaseCreate = resolve;
    });
    return { EndpointArn: "arn:aws:sns:us-east-1:123:endpoint/APNS/test/new-endpoint" };
  };
  return {
    SNSClient: jest.fn(() => ({ send })),
    CreatePlatformEndpointCommand: jest.fn((input) => ({ type: "CreatePlatformEndpoint", input })),
    SetEndpointAttributesCommand: jest.fn((input) => ({ type: "SetEndpointAttributes", input })),
  };
});

import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { handler as registerUserDevice } from "../../src/handlers/registerUserDevice";
import { handler as deviceNotificationSettings } from "../../src/handlers/deviceNotificationSettings";

const { __world: world } = jest.requireMock("@aws-sdk/client-dynamodb");
const NEW_TOKEN = "c".repeat(64);
const signedIn = { authorizer: { jwt: { claims: { sub: "user-1" } } } };

describe("the two device-row writers", () => {
  beforeEach(() => {
    world.rows.clear();
    // A 1.3 device whose endpoint userNotifier dropped (APNs refused it), so its next registration makes a new one.
    world.rows.set("user-1|device-1", {
      user_id: { S: "user-1" },
      device_id: { S: "device-1" },
      platform: { S: "ios" },
      pushToken: { S: "b".repeat(64) },
      notificationsEnabled: { BOOL: true },
      notifyNew: { BOOL: false },
    });
  });

  it("keep both a new token and a Weekly Brief flag stored while the registration was under way", async () => {
    const createStarted = new Promise<void>((resolve) => {
      world.createStarted = resolve;
    });
    const registration = registerUserDevice(
      asApiGatewayEvent({
        requestContext: signedIn,
        body: JSON.stringify({ device_id: "device-1", platform: "ios", push_token: NEW_TOKEN }),
      }),
    );
    // The registration has read the row and waits on SNS; app 1.3's first-launch sync stores the flag now.
    await createStarted;
    const settings = await deviceNotificationSettings(
      asApiGatewayEvent({
        httpMethod: "PUT",
        body: JSON.stringify({ device_id: "device-1", notify_weekly_brief: true }),
        requestContext: signedIn,
      }),
    );
    world.releaseCreate();
    const registered = await registration;

    expect(settings.statusCode).toBe(200);
    expect(registered.statusCode).toBe(200);
    expect(world.rows.get("user-1|device-1")).toEqual(
      expect.objectContaining({
        pushToken: { S: NEW_TOKEN },
        endpointArn: { S: "arn:aws:sns:us-east-1:123:endpoint/APNS/test/new-endpoint" },
        notifyWeeklyBrief: { BOOL: true },
        notifyNew: { BOOL: false },
        notificationsEnabled: { BOOL: true },
      }),
    );
  });
});
