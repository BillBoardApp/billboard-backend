import {
  type AttributeValue,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SNSClient, CreatePlatformEndpointCommand, SetEndpointAttributesCommand } from "@aws-sdk/client-sns";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { loadUserEligibility, toForbiddenResponse, writeEligibilityBlockReason } from "../../shared/adultEligibility";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY!;
// GSI keyed on pushToken. When unset (e.g. before the index is deployed) we skip
// conflict cleanup rather than fall back to a table scan.
const PUSH_TOKEN_INDEX = process.env.PUSH_TOKEN_INDEX;
const APNS_PLATFORM_APPLICATION_ARN = process.env.APNS_PLATFORM_APPLICATION_ARN!;
const PII_TABLE_NAME = process.env.PII_TABLE_NAME;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? PARTITION_KEY;
const NOTIFICATIONS_ENABLED_ATTRIBUTE = process.env.NOTIFICATIONS_ENABLED_ATTRIBUTE ?? "notificationsEnabled";
const NOTIFY_NEW_ATTRIBUTE = process.env.NOTIFY_NEW_ATTRIBUTE ?? "notifyNew";
const NOTIFY_UPDATED_ATTRIBUTE = process.env.NOTIFY_UPDATED_ATTRIBUTE ?? "notifyUpdated";
const NOTIFY_ALERT_ATTRIBUTE = process.env.NOTIFY_ALERT_ATTRIBUTE ?? "notifyAlert";
const NOTIFY_PASSED_ATTRIBUTE = process.env.NOTIFY_PASSED_ATTRIBUTE ?? "notifyPassed";
const NOTIFY_FAILED_ATTRIBUTE = process.env.NOTIFY_FAILED_ATTRIBUTE ?? "notifyFailed";
/** The switches a registration stores with their default (on) when the row has none; a stored value is kept. */
const DEFAULT_ON_SWITCHES = [
  NOTIFICATIONS_ENABLED_ATTRIBUTE,
  NOTIFY_NEW_ATTRIBUTE,
  NOTIFY_UPDATED_ATTRIBUTE,
  NOTIFY_ALERT_ATTRIBUTE,
  NOTIFY_PASSED_ATTRIBUTE,
  NOTIFY_FAILED_ATTRIBUTE,
];

const db = new DynamoDBClient({});
const sns = new SNSClient({});

function getUserSub(event: APIGatewayProxyEvent): string | undefined {
  return (
    // REST API + Cognito authorizer
    event?.requestContext?.authorizer?.claims?.sub ||
    // HTTP API JWT authorizer (fallback)
    event?.requestContext?.authorizer?.jwt?.claims?.sub
  );
}

function extractEndpointArnFromError(err: unknown): string | undefined {
  const msg = String((err as { message?: unknown } | null)?.message ?? "");
  const m = msg.match(/arn:aws:sns:[^\s]+:endpoint\/APNS\/[^/\s]+\/[^/\s]+/);
  return m?.[0];
}

// APNs device tokens are hex strings (32 bytes today, but Apple says not to
// assume a fixed length). Device ids are client-generated identifiers.
const PUSH_TOKEN_PATTERN = /^[0-9a-fA-F]{16,512}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isValidPushToken(value: unknown): value is string {
  return typeof value === "string" && PUSH_TOKEN_PATTERN.test(value);
}

function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

function isAlreadyRegistered(existingItem: Record<string, AttributeValue> | undefined, pushToken: string): boolean {
  return (
    existingItem?.platform?.S === "ios" &&
    existingItem?.pushToken?.S === pushToken &&
    typeof existingItem?.endpointArn?.S === "string" &&
    existingItem.endpointArn.S.length > 0
  );
}

/**
 * A push token identifies one physical device, and SNS keeps one endpoint per
 * token, so when a different account registers the same token (e.g. a second
 * user signs in on the same phone) the previous account's row for that token
 * must go, or both accounts would receive that device's pushes.
 *
 * Only rows whose pushToken matches are touched. A client-chosen device id is
 * not proof of possession, so it is never used as a match key. The lookup goes
 * through the pushToken GSI; there is no table scan.
 */
async function removeConflictingDeviceRegistrations(userId: string, deviceId: string, pushToken: string) {
  if (!PUSH_TOKEN_INDEX) {
    console.warn("PUSH_TOKEN_INDEX is not configured; skipping conflicting device cleanup.");
    return;
  }

  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await db.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: PUSH_TOKEN_INDEX,
        KeyConditionExpression: "#pushToken = :pushToken",
        ExpressionAttributeNames: {
          "#userId": PARTITION_KEY,
          "#deviceId": SORT_KEY,
          "#pushToken": "pushToken",
        },
        ExpressionAttributeValues: {
          ":pushToken": { S: pushToken },
        },
        ProjectionExpression: "#userId, #deviceId",
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const existingUserId = item?.[PARTITION_KEY]?.S;
      const existingDeviceId = item?.[SORT_KEY]?.S;
      if (!existingUserId || !existingDeviceId) continue;
      if (existingUserId === userId && existingDeviceId === deviceId) continue;

      await db.send(
        new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: {
            [PARTITION_KEY]: { S: existingUserId },
            [SORT_KEY]: { S: existingDeviceId },
          },
        }),
      );
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getUserSub(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };

    let body: { device_id?: unknown; platform?: unknown; push_token?: unknown };
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }
    const { device_id, platform, push_token } = body;

    if (!device_id || !platform || !push_token) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing device_id, platform, or push_token" }) };
    }
    if (platform !== "ios") {
      return { statusCode: 400, body: JSON.stringify({ error: "Only ios is supported right now" }) };
    }
    if (!isValidDeviceId(device_id) || !isValidPushToken(push_token)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid device_id or push_token" }) };
    }

    const eligibility = await loadUserEligibility({
      db,
      piiTableName: PII_TABLE_NAME,
      piiPartitionKey: PII_PARTITION_KEY,
      userId,
    });
    const blockedReason = writeEligibilityBlockReason(eligibility);
    if (blockedReason) {
      return toForbiddenResponse(blockedReason);
    }

    const deviceId = device_id;
    const pushToken = push_token;

    // Look up existing record to reuse endpointArn if present
    const existing = await db.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          [PARTITION_KEY]: { S: userId },
          [SORT_KEY]: { S: deviceId },
        },
        ConsistentRead: true,
      }),
    );

    let endpointArn = existing.Item?.endpointArn?.S;

    if (isAlreadyRegistered(existing.Item, pushToken)) {
      return { statusCode: 200, body: JSON.stringify({ message: "Device registered", endpointArn }) };
    }

    await removeConflictingDeviceRegistrations(userId, deviceId, pushToken);

    if (!endpointArn) {
      try {
        const resp = await sns.send(
          new CreatePlatformEndpointCommand({
            PlatformApplicationArn: APNS_PLATFORM_APPLICATION_ARN,
            Token: pushToken,
            CustomUserData: `${userId}:${deviceId}`,
          }),
        );
        endpointArn = resp.EndpointArn;
      } catch (err) {
        // If SNS says an endpoint already exists for this token, extract it.
        endpointArn = extractEndpointArnFromError(err);
        if (!endpointArn) throw err;
      }
    }

    // Always, also right after CreatePlatformEndpoint: for a token SNS already knows, that returns the existing
    // endpoint (or names it in the "already exists" error) as it is, so an endpoint SNS disabled stays disabled.
    // UserNotifier drops a disabled endpoint's ARN from the row, so without this the device would get its next push
    // refused (EndpointDisabled), lose the ARN again and stay without pushes until its APNs token changed. The token
    // was just sent by the device, so it is current, and AWS's token-management guidance is to set the current token
    // and Enabled=true together. SetEndpointAttributes is the call the role already has for the endpoints.
    await sns.send(
      new SetEndpointAttributesCommand({
        EndpointArn: endpointArn,
        Attributes: {
          Token: pushToken,
          Enabled: "true",
        },
      }),
    );

    // One UpdateItem that sets only the registration and the switch defaults, never a whole-row replace: a
    // deviceNotificationSettings PUT at the same moment keeps the switches it stores, the Weekly Brief flag (UX-28)
    // included. A stored switch is kept; a missing one gets its default (on). The Weekly Brief flag has no default,
    // so it is never written here: a new token neither opts the device out of the Sunday push nor in.
    await db.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          [PARTITION_KEY]: { S: userId },
          [SORT_KEY]: { S: deviceId },
        },
        UpdateExpression: `SET ${[
          "#platform = :platform",
          "#pushToken = :pushToken",
          "#endpointArn = :endpointArn",
          "#updatedAt = :updatedAt",
          ...DEFAULT_ON_SWITCHES.map((_, index) => `#s${index} = if_not_exists(#s${index}, :on)`),
        ].join(", ")}`,
        ExpressionAttributeNames: {
          "#platform": "platform",
          "#pushToken": "pushToken",
          "#endpointArn": "endpointArn",
          "#updatedAt": "updatedAt",
          ...Object.fromEntries(DEFAULT_ON_SWITCHES.map((attribute, index) => [`#s${index}`, attribute])),
        },
        ExpressionAttributeValues: {
          ":platform": { S: "ios" },
          ":pushToken": { S: pushToken },
          ":endpointArn": { S: endpointArn! },
          ":updatedAt": { S: new Date().toISOString() },
          ":on": { BOOL: true },
        },
      }),
    );

    return { statusCode: 200, body: JSON.stringify({ message: "Device registered", endpointArn }) };
  } catch (err) {
    console.error("Error registering device:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal server error" }) };
  }
}
