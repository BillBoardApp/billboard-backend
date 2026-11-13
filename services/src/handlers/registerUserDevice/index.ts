import {
  type AttributeValue,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
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

function attrToBool(attr: AttributeValue | undefined): boolean | null {
  if (!attr) return null;
  if (typeof attr.BOOL === "boolean") return attr.BOOL;
  if (typeof attr.S === "string") {
    const lowered = attr.S.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  if (typeof attr.N === "string") {
    if (attr.N === "1") return true;
    if (attr.N === "0") return false;
  }
  return null;
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
    const notificationsEnabled = attrToBool(existing.Item?.[NOTIFICATIONS_ENABLED_ATTRIBUTE]) ?? true;
    const notifyNew = attrToBool(existing.Item?.[NOTIFY_NEW_ATTRIBUTE]) ?? true;
    const notifyUpdated = attrToBool(existing.Item?.[NOTIFY_UPDATED_ATTRIBUTE]) ?? true;
    const notifyAlert = attrToBool(existing.Item?.[NOTIFY_ALERT_ATTRIBUTE]) ?? true;
    const notifyPassed = attrToBool(existing.Item?.[NOTIFY_PASSED_ATTRIBUTE]) ?? true;
    const notifyFailed = attrToBool(existing.Item?.[NOTIFY_FAILED_ATTRIBUTE]) ?? true;

    if (isAlreadyRegistered(existing.Item, pushToken)) {
      return { statusCode: 200, body: JSON.stringify({ message: "Device registered", endpointArn }) };
    }

    await removeConflictingDeviceRegistrations(userId, deviceId, pushToken);

    if (endpointArn) {
      await sns.send(
        new SetEndpointAttributesCommand({
          EndpointArn: endpointArn,
          Attributes: {
            Token: pushToken,
            Enabled: "true",
          },
        }),
      );
    } else {
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

    await db.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          [PARTITION_KEY]: { S: userId },
          [SORT_KEY]: { S: deviceId },
          platform: { S: "ios" },
          pushToken: { S: pushToken },
          endpointArn: { S: endpointArn! },
          [NOTIFICATIONS_ENABLED_ATTRIBUTE]: { BOOL: notificationsEnabled },
          [NOTIFY_NEW_ATTRIBUTE]: { BOOL: notifyNew },
          [NOTIFY_UPDATED_ATTRIBUTE]: { BOOL: notifyUpdated },
          [NOTIFY_ALERT_ATTRIBUTE]: { BOOL: notifyAlert },
          [NOTIFY_PASSED_ATTRIBUTE]: { BOOL: notifyPassed },
          [NOTIFY_FAILED_ATTRIBUTE]: { BOOL: notifyFailed },
          updatedAt: { S: new Date().toISOString() },
        },
      }),
    );

    return { statusCode: 200, body: JSON.stringify({ message: "Device registered", endpointArn }) };
  } catch (err) {
    console.error("Error registering device:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Internal server error" }) };
  }
}
