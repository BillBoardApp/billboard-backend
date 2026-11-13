import { type AttributeValue, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { loadUserEligibility, toForbiddenResponse, writeEligibilityBlockReason } from "../../shared/adultEligibility";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY!;
const PII_TABLE_NAME = process.env.PII_TABLE_NAME;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? PARTITION_KEY;
const NOTIFICATIONS_ENABLED_ATTRIBUTE = process.env.NOTIFICATIONS_ENABLED_ATTRIBUTE ?? "notificationsEnabled";
const NOTIFY_NEW_ATTRIBUTE = process.env.NOTIFY_NEW_ATTRIBUTE ?? "notifyNew";
const NOTIFY_UPDATED_ATTRIBUTE = process.env.NOTIFY_UPDATED_ATTRIBUTE ?? "notifyUpdated";
const NOTIFY_ALERT_ATTRIBUTE = process.env.NOTIFY_ALERT_ATTRIBUTE ?? "notifyAlert";
const NOTIFY_PASSED_ATTRIBUTE = process.env.NOTIFY_PASSED_ATTRIBUTE ?? "notifyPassed";
const NOTIFY_FAILED_ATTRIBUTE = process.env.NOTIFY_FAILED_ATTRIBUTE ?? "notifyFailed";

const db = new DynamoDBClient({});

type DeviceNotificationSettings = {
  notificationsEnabled: boolean;
  notifyNew: boolean;
  notifyUpdated: boolean;
  notifyAlert: boolean;
  notifyPassed: boolean;
  notifyFailed: boolean;
};

const DEFAULT_SETTINGS: DeviceNotificationSettings = {
  notificationsEnabled: true,
  notifyNew: true,
  notifyUpdated: true,
  notifyAlert: true,
  notifyPassed: true,
  notifyFailed: true,
};

function json(statusCode: number, payload: unknown) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function getUserSub(event: APIGatewayProxyEvent): string | undefined {
  return event?.requestContext?.authorizer?.claims?.sub || event?.requestContext?.authorizer?.jwt?.claims?.sub;
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

function attrToString(attr: AttributeValue | undefined): string | null {
  if (!attr) return null;
  if (typeof attr.S === "string") return attr.S;
  return null;
}

function readSettingsFromItem(item?: Record<string, AttributeValue>): DeviceNotificationSettings {
  return {
    notificationsEnabled: attrToBool(item?.[NOTIFICATIONS_ENABLED_ATTRIBUTE]) ?? DEFAULT_SETTINGS.notificationsEnabled,
    notifyNew: attrToBool(item?.[NOTIFY_NEW_ATTRIBUTE]) ?? DEFAULT_SETTINGS.notifyNew,
    notifyUpdated: attrToBool(item?.[NOTIFY_UPDATED_ATTRIBUTE]) ?? DEFAULT_SETTINGS.notifyUpdated,
    notifyAlert: attrToBool(item?.[NOTIFY_ALERT_ATTRIBUTE]) ?? DEFAULT_SETTINGS.notifyAlert,
    notifyPassed: attrToBool(item?.[NOTIFY_PASSED_ATTRIBUTE]) ?? DEFAULT_SETTINGS.notifyPassed,
    notifyFailed: attrToBool(item?.[NOTIFY_FAILED_ATTRIBUTE]) ?? DEFAULT_SETTINGS.notifyFailed,
  };
}

function responsePayload(deviceId: string, settings: DeviceNotificationSettings) {
  return {
    device_id: deviceId,
    notifications_enabled: settings.notificationsEnabled,
    notify_new: settings.notifyNew,
    notify_updated: settings.notifyUpdated,
    notify_alert: settings.notifyAlert,
    notify_passed: settings.notifyPassed,
    notify_failed: settings.notifyFailed,
  };
}

function extractDeviceId(event: APIGatewayProxyEvent, body: Record<string, unknown> | undefined): string {
  const fromQuery = event?.queryStringParameters?.device_id;
  const fromBody = body?.device_id;
  const raw = typeof fromBody === "string" && fromBody.trim().length > 0 ? fromBody : fromQuery;
  return typeof raw === "string" ? raw.trim() : "";
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "boolean") {
    throw new Error("Expected boolean");
  }
  return value;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getUserSub(event);
    if (!userId) {
      return json(401, { error: "Unauthorized" });
    }

    const method = String(event?.httpMethod ?? "").toUpperCase();

    if (method === "GET") {
      const deviceId = extractDeviceId(event, undefined);
      if (!deviceId) {
        return json(400, { error: "Missing device_id" });
      }

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

      const settings = readSettingsFromItem(existing.Item);
      return json(200, responsePayload(deviceId, settings));
    }

    if (method === "PUT") {
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

      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(event?.body ?? "{}");
      } catch {
        return json(400, { error: "Invalid JSON body" });
      }

      const deviceId = extractDeviceId(event, body);
      if (!deviceId) {
        return json(400, { error: "Missing device_id" });
      }

      let notificationsEnabled: boolean | undefined;
      let notifyNew: boolean | undefined;
      let notifyUpdated: boolean | undefined;
      let notifyAlert: boolean | undefined;
      let notifyPassed: boolean | undefined;
      let notifyFailed: boolean | undefined;

      try {
        notificationsEnabled = parseOptionalBool(body.notifications_enabled);
        notifyNew = parseOptionalBool(body.notify_new);
        notifyUpdated = parseOptionalBool(body.notify_updated);
        notifyAlert = parseOptionalBool(body.notify_alert);
        notifyPassed = parseOptionalBool(body.notify_passed);
        notifyFailed = parseOptionalBool(body.notify_failed);
      } catch {
        return json(400, {
          error:
            "Invalid boolean field. Expected booleans for notifications_enabled/notify_new/notify_updated/notify_alert/notify_passed/notify_failed",
        });
      }

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

      const baseSettings = readSettingsFromItem(existing.Item);
      const nextSettings: DeviceNotificationSettings = {
        notificationsEnabled: notificationsEnabled ?? baseSettings.notificationsEnabled,
        notifyNew: notifyNew ?? baseSettings.notifyNew,
        notifyUpdated: notifyUpdated ?? baseSettings.notifyUpdated,
        notifyAlert: notifyAlert ?? baseSettings.notifyAlert,
        notifyPassed: notifyPassed ?? baseSettings.notifyPassed,
        notifyFailed: notifyFailed ?? baseSettings.notifyFailed,
      };

      const item: Record<string, AttributeValue> = {
        [PARTITION_KEY]: { S: userId },
        [SORT_KEY]: { S: deviceId },
        [NOTIFICATIONS_ENABLED_ATTRIBUTE]: { BOOL: nextSettings.notificationsEnabled },
        [NOTIFY_NEW_ATTRIBUTE]: { BOOL: nextSettings.notifyNew },
        [NOTIFY_UPDATED_ATTRIBUTE]: { BOOL: nextSettings.notifyUpdated },
        [NOTIFY_ALERT_ATTRIBUTE]: { BOOL: nextSettings.notifyAlert },
        [NOTIFY_PASSED_ATTRIBUTE]: { BOOL: nextSettings.notifyPassed },
        [NOTIFY_FAILED_ATTRIBUTE]: { BOOL: nextSettings.notifyFailed },
        updatedAt: { S: new Date().toISOString() },
      };

      const existingPlatform = attrToString(existing.Item?.platform);
      if (existingPlatform) {
        item.platform = { S: existingPlatform };
      }

      const existingPushToken = attrToString(existing.Item?.pushToken);
      if (existingPushToken) {
        item.pushToken = { S: existingPushToken };
      }

      const existingEndpointArn = attrToString(existing.Item?.endpointArn);
      if (existingEndpointArn) {
        item.endpointArn = { S: existingEndpointArn };
      }

      await db.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: item,
        }),
      );

      return json(200, responsePayload(deviceId, nextSettings));
    }

    return json(405, { error: "Method not allowed" });
  } catch (error) {
    console.error("Error in deviceNotificationSettings:", error);
    return json(500, { error: "Internal server error" });
  }
}
