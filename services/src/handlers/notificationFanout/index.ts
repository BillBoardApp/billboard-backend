import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { UserPreferencesDao } from "../../adapters/userPreferencesDao";
import { correlationIdFromRecord, mintCorrelationId } from "../../shared/correlation";
import { logger, type LambdaContextLike } from "../../shared/logger";
import {
  parseBoundedPositiveInt,
  parseNotificationFanoutMessage,
  pendingNotificationStoreConfigFromEnv,
  type UserContentTypePreferenceCache,
  writePendingNotificationsForUsers,
} from "../../shared/pendingNotifications";
import { processSqsRecords } from "../../shared/sqsBatch";
import { reportUnprocessableMessage } from "../../shared/unprocessableMessages";

/**
 * notificationFanout (CAP-02): consumes the chunks userMatcher sends for one bill (about 100 users
 * each) and, for each user, applies the content-type filter (not for priority bills) and writes the
 * pending notification with its dedupe and sharded dispatch markers, a few users at a time.
 *
 * A duplicate (the dedupe marker already exists) is a no-op, so redelivered or re-sent chunks are
 * harmless. Any other failure fails only that message (ReportBatchItemFailures); its retry skips the
 * users already written. Malformed messages are dropped, logged and counted (`MessagesUnprocessable`,
 * C1.8); a message from a newer producer (higher `version`) is failed so it reaches the DLQ instead of
 * being lost.
 */

const dynamo = new DynamoDBClient({});

const PENDING_NOTIFICATIONS_STORE = pendingNotificationStoreConfigFromEnv();
const PREFERENCE_TABLE = process.env.PREFERENCE_TABLE!;
const PREFERENCE_INDEX = process.env.PREFERENCE_INDEX;
const USER_ID_ATTRIBUTE = process.env.USER_ID_ATTRIBUTE!;
const SUB_CATEGORY_ATTRIBUTE = process.env.SUB_CATEGORY_ATTRIBUTE!;
const WRITE_CONCURRENCY = parseBoundedPositiveInt(process.env.NOTIFICATION_WRITE_CONCURRENCY, 8, 32);

const preferencesDao = new UserPreferencesDao(dynamo, {
  tableName: PREFERENCE_TABLE,
  subCategoryIndexName: PREFERENCE_INDEX,
  userIdAttribute: USER_ID_ATTRIBUTE,
  subCategoryAttribute: SUB_CATEGORY_ATTRIBUTE,
});

const REQUIRED_ENV = [
  "PENDING_NOTIFICATIONS_TABLE",
  "PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY",
  "PENDING_NOTIFICATIONS_TABLE_SORT_KEY",
  "PREFERENCE_TABLE",
  "USER_ID_ATTRIBUTE",
  "SUB_CATEGORY_ATTRIBUTE",
] as const;

const processRecord = async (record: SQSRecord, contentTypeCache: UserContentTypePreferenceCache): Promise<void> => {
  const parsed = parseNotificationFanoutMessage(record.body);
  if (!parsed.ok) {
    if (parsed.retryable) {
      throw new Error(`Cannot process notification fan-out message: ${parsed.reason}`);
    }
    // Acknowledged as before; now logged and counted (C1.8).
    reportUnprocessableMessage({
      site: "notificationFanout.malformed",
      reason: parsed.reason,
      messageId: record.messageId,
      body: record.body,
    });
    return;
  }

  const message = parsed.message;
  // The attribute and the body carry the same id; mint one only for a message that has neither.
  const correlationId = correlationIdFromRecord(record) ?? message.correlationId ?? mintCorrelationId(message.billId);
  logger.appendKeys({ guid: message.billId, correlationId });

  const outcome = await writePendingNotificationsForUsers(
    {
      dynamo,
      store: PENDING_NOTIFICATIONS_STORE,
      preferences: preferencesDao,
      subCategoryAttribute: SUB_CATEGORY_ATTRIBUTE,
      contentTypeCache,
    },
    { ...message, correlationId },
    message.userIds,
    { concurrency: WRITE_CONCURRENCY },
  );

  logger.info("Fanned out pending notifications", {
    billId: message.billId,
    notificationType: message.notificationType,
    isPriorityBill: message.isPriorityBill,
    userCount: message.userIds.length,
    ...outcome,
  });
};

export const handler = async (event: SQSEvent, context?: LambdaContextLike): Promise<SQSBatchResponse> => {
  logger.resetContext(context);
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing env var(s): ${missing.join(", ")}`);
  }

  // Per invocation, like userMatcher: a user's content-type preferences are read once per batch.
  const contentTypeCache: UserContentTypePreferenceCache = new Map();
  return processSqsRecords(event, (record) => processRecord(record, contentTypeCache), {
    label: "Failed to process notification fan-out message",
  });
};
