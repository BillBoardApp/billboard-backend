import {
  type AttributeValue,
  BatchWriteItemCommand,
  DeleteItemCommand,
  type DeleteItemCommandInput,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { activeCompanionPairs, BillCompanionDao, type CompanionGroupsState } from "../../adapters/billCompanionDao";
import { UserDeviceDao, UserDeviceRecord } from "../../adapters/userDeviceDao";
import type { NotificationType } from "../../models/notifications";
import { companionIndex, plainBillGuid, type CompanionIndex } from "../../shared/billCompanions";
import { notBillFailureReason } from "../../shared/billOutcomes";
import { mapWithConcurrency } from "../../shared/concurrency";
import { normalizeCorrelationId } from "../../shared/correlation";
import {
  DISPATCH_MARKER_VERSION_ATTRIBUTE,
  dispatchShardPartitionValue,
  isDispatchPartitionValue,
  parseDispatchShardCount,
} from "../../shared/dispatchShards";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric, emitEmbeddedMetrics, type EmbeddedMetricInput } from "../../shared/metrics";
import {
  isPairedOutcomeType,
  isPendingRowExpired,
  type PendingNotificationAction,
  parsePendingNotificationAction,
  parsePendingNotificationChangedAtMs,
  parsePendingNotificationSubCategory,
} from "../../shared/pendingNotifications";
import type { OutcomePushType } from "../../shared/pushAudience";
import {
  paceWindowEndMs,
  parsePushPaceHours,
  PUSH_PACE_ITEM_MARGIN_SECONDS,
  PUSH_PACE_MARKER_TYPE,
  PUSH_PACE_SORT_KEY_PREFIX,
  type PushHold,
  pushHoldAt,
} from "../../shared/pushPace";
import { timeZoneForState } from "../../shared/quietHours";
import { sleep } from "../../shared/retry";
import { processSqsRecords } from "../../shared/sqsBatch";
import { reportUnprocessableMessage } from "../../shared/unprocessableMessages";
import {
  normalizeInlineText,
  PUSH_BODY_MAX_BYTES,
  type PushCopy,
  pushCopyFor,
  pushPayloadDetails,
  type PushPayloadDetails,
  SINGLE_TITLE_MAX_BYTES,
  truncateUtf8,
  uniqueNonEmpty,
} from "./pushCopy";

const dynamo = new DynamoDBClient({});
const sns = new SNSClient({});

const PENDING_NOTIFICATIONS_TABLE = process.env.PENDING_NOTIFICATIONS_TABLE!;
const PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY = process.env.PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY!;
const PENDING_NOTIFICATIONS_TABLE_SORT_KEY = process.env.PENDING_NOTIFICATIONS_TABLE_SORT_KEY!;
const DISPATCH_PARTITION_KEY = process.env.DISPATCH_PARTITION_KEY ?? PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY;
const DISPATCH_SORT_KEY = process.env.DISPATCH_SORT_KEY ?? PENDING_NOTIFICATIONS_TABLE_SORT_KEY;
// The legacy unsharded marker partition; markers and claims now live under `<value>#<shard>` (CAP-02).
const DISPATCH_PARTITION_VALUE = process.env.DISPATCH_PARTITION_VALUE ?? "__dispatch__";
const DISPATCH_SHARD_COUNT = parseDispatchShardCount(process.env.DISPATCH_SHARD_COUNT);
const DISPATCH_CLAIM_PREFIX = process.env.DISPATCH_CLAIM_PREFIX ?? "__claim__#";
const DEVICE_TABLE = process.env.DEVICE_TABLE!;
const USER_ID_ATTRIBUTE = process.env.USER_ID_ATTRIBUTE!;
const DEVICE_ID_ATTRIBUTE = process.env.DEVICE_ID_ATTRIBUTE!;
//TBD
const PLATFORM_ATTRIBUTE = process.env.PLATFORM_ATTRIBUTE ?? "platform";
const PUSH_TOKEN_ATTRIBUTE = process.env.PUSH_TOKEN_ATTRIBUTE ?? "push_token";
const ENDPOINT_ARN_ATTRIBUTE = process.env.ENDPOINT_ARN_ATTRIBUTE ?? "endpointArn";

/**
 * X6, the expired-push cutoff of C1.3 (decision D1): what happens to a pending row past its 24-hour
 * lifetime (isPendingRowExpired). Exactly "enforce": it is deleted unsent, counted and logged
 * "expired". Any other value, or none, is "watch": it is counted and logged "would_expire", then sent
 * and deleted exactly as before. Ships as "watch" (infra USER_NOTIFIER_PENDING_EXPIRY_MODE).
 */
type PendingExpiryMode = "watch" | "enforce";
const PENDING_EXPIRY_MODE: PendingExpiryMode = process.env.PENDING_EXPIRY_MODE === "enforce" ? "enforce" : "watch";
const NOTIFICATIONS_METRIC_NAMESPACE = "BillBoard/Notifications";
const EXPIRED_UNDELIVERED_METRIC = "NotificationsExpiredUndelivered";
/** REL-50: "failed" rows deleted unsent because their action is not the bill's own failure (dropNotFailureRows). */
const FAILURE_PUSHES_DROPPED_METRIC = "FailurePushesDropped";

/**
 * S5, quiet hours (shared/quietHours.ts): exactly "on" holds a user's pushes from 9 PM to 8 AM in the zone of their
 * district's state, read from UserPII (`resolvedState`, else `selfAttestedState`; Eastern time without one). Any other
 * value, or none, sends at any hour as before. Ships "on" (infra QUIET_HOURS_ENABLED).
 */
const QUIET_HOURS_ON = process.env.QUIET_HOURS === "on";
const PII_TABLE_NAME = process.env.PII_TABLE_NAME?.trim() || undefined;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? "userId";

/**
 * UX-33, the push pace (shared/pushPace.ts): with PUSH_PACE_HOURS a whole number from 1 to 8, a user gets at most one
 * push every that many hours; rows that arrive inside the window are held, the way the quiet hours hold them, and go
 * out folded in the first dispatch after it. Any other value, `0` or none, turns it off. Ships 3 (infra
 * PUSH_PACE_HOURS).
 */
const PUSH_PACE_HOURS = parsePushPaceHours(process.env.PUSH_PACE_HOURS);

/**
 * UX-33 (project decision 2026-10-28): an "updated" row ("vote again") is dropped unsent
 * when the user's vote on the bill (`votedAt` on their UserFeedback row) is newer than the summary change (the row's
 * `changedAtMs`, else its write time; see dropRevotedUpdates). Without FEEDBACK_TABLE_NAME every such row is sent, as
 * before.
 */
const FEEDBACK_TABLE_NAME = process.env.FEEDBACK_TABLE_NAME?.trim() || undefined;
const FEEDBACK_PARTITION_KEY = process.env.FEEDBACK_PARTITION_KEY ?? "userId";
const FEEDBACK_SORT_KEY = process.env.FEEDBACK_SORT_KEY ?? "billId";
const VOTE_READ_CONCURRENCY = 8;

// APPF-23: a companion group counts as one bill in a push ("1 New Bill", never "2 New Bills" for one
// pair). The groups are the ones PublishBillsManifest last published (none while they are turned off),
// read at most every 60 s from MANIFEST_TABLE_NAME. With no groups every bill id counts on its own.
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME?.trim();
const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";
const companionDao = MANIFEST_TABLE_NAME ? new BillCompanionDao(dynamo) : null;
let companionIndexFor: { state: CompanionGroupsState | null; index: CompanionIndex } | undefined;

const deviceDao = new UserDeviceDao(dynamo, {
  tableName: DEVICE_TABLE,
  userIdAttribute: USER_ID_ATTRIBUTE,
  deviceIdAttribute: DEVICE_ID_ATTRIBUTE,
  platformAttribute: PLATFORM_ATTRIBUTE,
  pushTokenAttribute: PUSH_TOKEN_ATTRIBUTE,
  endpointArnAttribute: ENDPOINT_ARN_ATTRIBUTE,
});

interface BatchPayload {
  userIds: string[];
  /** Per user, the dispatch partitions holding their marker and claim, as the dispatcher found them. */
  dispatchPartitions: Map<string, string[]>;
}

interface PendingNotification {
  userId: string;
  pendingKey: string;
  billId: string;
  billTitle: string;
  category: string;
  lifeArea: string;
  notificationType: NotificationType;
  /** The bill's first topic, when the writer stored one (S4; rows written before it have none). */
  subCategory?: string;
  /** For an alert, passed or failed: the action it is about, when the writer stored one (S4). */
  action?: PendingNotificationAction;
  /** The bill's pipeline trace id, stored on the row by userMatcher (OBS-10). */
  correlationId?: string;
  /** The row's `ttl` and `createdAt` (epoch seconds) when they are numbers; see isPendingRowExpired. */
  ttl?: number;
  createdAt?: number;
  /** UX-33, on an "updated" row: when the version with the new summary was stored (epoch ms), when the writer had it. */
  changedAtMs?: number;
  /**
   * UX-33, on an "alert" row written beside an outcome row of the same change (`pairedOutcome`, "passed" or "failed"):
   * sent only to a device that does not take that outcome's pushes; see oneRowPerOutcomeChange.
   */
  pairedOutcome?: OutcomePushType;
}

interface DigestNotificationData {
  userId: string;
  bills: PendingNotification[];
  devices: UserDeviceRecord[];
}

const APNS_SAFE_PAYLOAD_BYTES = 3500;
const DIGEST_PREVIEW_BILL_ID_LIMIT = 8;
/**
 * An "updated" push lists every bill it covers, since both apps ask to vote again only on the ids in `billIds`
 * (PushDeepLinkRouter, 1.1 and 1.2). 50 is the most either app reads (PushPayloadLimits.maxBillIds); more "updated"
 * bills go on further "updated" pushes (see buildUpdatedPushes).
 */
const UPDATED_PUSH_BILL_ID_LIMIT = 50;
const DEFAULT_MESSAGE_MAX_BYTES = 120;
const SNS_ENDPOINT_ARN_SEGMENT = ":endpoint/";
// Markers written before markerVersion existed are deleted by time: userMatcher and notificationFanout
// stamp updatedAtEpoch in whole seconds, and a marker stamped this close to the pending-row query may
// belong to a row the query missed, so it is kept.
const DISPATCH_MARKER_SAFETY_MARGIN_SECONDS = 1;

/**
 * S5: "updated" rows (the summary changed; both apps then ask to vote again) go on a push of their own, so its type
 * stays "updated" even when other rows are pending, and it lists every one of their bills (UPDATED_PUSH_BILL_ID_LIMIT).
 * Every other type shares one push, folded as before.
 */
type PushGroup = "other" | "updated";
const pushGroupOf = (type: NotificationType): PushGroup => (type === "updated" ? "updated" : "other");

/**
 * One of the user's pushes: the rows it covers (all of them, settled together), the devices it reached, the failures,
 * and per row the devices whose push carried it (a device leaves out the types it turned off, and one of the two rows
 * of an outcome change).
 */
type PushOutcome = {
  rows: PendingNotification[];
  sent: number;
  failures: Error[];
  rowDevices: Map<PendingNotification, number>;
};

const newPushOutcome = (rows: PendingNotification[]): PushOutcome => ({
  rows,
  sent: 0,
  failures: [],
  rowDevices: new Map(),
});

/** Records that a push carrying `rows` reached one more device. */
const countDeviceSend = (push: PushOutcome, rows: readonly PendingNotification[]): void => {
  push.sent += 1;
  for (const row of rows) push.rowDevices.set(row, (push.rowDevices.get(row) ?? 0) + 1);
};

type PublishOutcome = {
  /** Pushes sent, over every device. */
  sent: number;
  failures: Error[];
  pushes: PushOutcome[];
};

/** A user's dispatch marker in one partition, as read before the pending-row query. */
type SeenDispatchMarker = { partitionValue: string } & (
  | { exists: false }
  /** markerVersion is undefined for a marker written before markers carried one. */
  | { exists: true; markerVersion?: string }
);

type PendingDeleteRequest = {
  DeleteRequest: {
    Key: Record<string, { S: string }>;
  };
};

const isConditionalCheckFailed = (error: unknown): boolean => {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "ConditionalCheckFailedException" || message.includes("ConditionalCheckFailed");
};

const attributeValueToString = (attr: AttributeValue | undefined): string | null => {
  if (!attr) return null;
  if ("S" in attr && typeof attr.S === "string") return attr.S;
  if ("N" in attr && typeof attr.N === "string") return attr.N;
  return null;
};

// A Number attribute (epoch seconds) as a finite number; absent, any other type or not numeric: undefined.
const epochSecondsAttribute = (attr: AttributeValue | undefined): number | undefined => {
  if (!attr || typeof attr.N !== "string" || attr.N.trim().length === 0) return undefined;
  const value = Number(attr.N);
  return Number.isFinite(value) ? value : undefined;
};

const byteLengthOfJson = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// ─── Companion groups (APPF-23) ───────────────────────────────────────────────

/** How pending rows are counted as bills: by bill id, or by companion group where there are groups. */
interface BillCounting {
  /** The bill id, or its group's primary guid when grouped. */
  keyOf: (billId: string) => string;
  index: CompanionIndex;
}

const BY_BILL_ID: BillCounting = { keyOf: (billId) => normalizeInlineText(billId), index: new Map() };

const companionGroupOf = (billId: string, index: CompanionIndex) => {
  const plain = plainBillGuid(billId);
  return plain ? index.get(plain) : undefined;
};

/** Counting for this invocation: by companion group when groups are published, else by bill id. */
const loadBillCounting = async (): Promise<BillCounting> => {
  if (!companionDao) return BY_BILL_ID;
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    if (companionIndexFor?.state !== state) {
      companionIndexFor = { state, index: companionIndex(activeCompanionPairs(state)) };
    }
    const index = companionIndexFor.index;
    if (index.size === 0) return BY_BILL_ID;
    return {
      keyOf: (billId) => companionGroupOf(billId, index)?.primaryGuid ?? normalizeInlineText(billId),
      index,
    };
  } catch (error) {
    logger.warn("Could not read the companion groups; counting each bill on its own", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return BY_BILL_ID;
  }
};

/**
 * The rows a push's copy describes: one per companion group and notification type (the primary's row
 * wins, otherwise the first), so a pair's two "new" rows read as one bill. The push still lists every
 * row's bill id (see pushBillIds), and every row is deleted after the push. Unchanged when there are
 * no groups.
 */
const collapseCompanionRows = (bills: PendingNotification[], counting: BillCounting): PendingNotification[] => {
  if (counting.index.size === 0) return bills;
  const isOnPrimary = (billId: string): boolean => {
    const group = companionGroupOf(billId, counting.index);
    return group !== undefined && group.primaryGuid === plainBillGuid(billId);
  };
  const chosen = new Map<string, number>();
  bills.forEach((bill, position) => {
    const key = `${counting.keyOf(bill.billId)}|${bill.notificationType}`;
    const kept = chosen.get(key);
    if (kept === undefined || (isOnPrimary(bill.billId) && !isOnPrimary(bills[kept].billId))) {
      chosen.set(key, position);
    }
  });
  return Array.from(chosen.values())
    .sort((left, right) => left - right)
    .map((position) => bills[position]);
};

/**
 * The bill ids a push carries: the described rows' ids first, then those of the companion rows the
 * copy folded in, so the app handles each member (an "updated" push clears a vote for a revote only
 * on the member that holds it).
 */
const pushBillIds = (shownBills: PendingNotification[], allBills: PendingNotification[]): string[] =>
  uniqueNonEmpty([...shownBills, ...allBills].map((bill) => bill.billId));

type BuiltPushPayload = {
  apnsPayload: string;
  defaultMessage: string;
  /** The bill ids the payload carries (a digest's size fallbacks may drop some). */
  billIds: string[];
};

// Only dispatch partition values are accepted, so a message can never name another key to delete.
const parseDispatchPartitions = (raw: unknown, userIds: string[]): Map<string, string[]> => {
  const result = new Map<string, string[]>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const userId of userIds) {
    const value = (raw as Record<string, unknown>)[userId];
    if (!Array.isArray(value)) continue;
    const partitions = Array.from(
      new Set(value.filter((entry) => isDispatchPartitionValue(entry, DISPATCH_PARTITION_VALUE))),
    );
    if (partitions.length > 0) result.set(userId, partitions);
  }
  return result;
};

/**
 * Where to release a user's dispatch state: the partitions the dispatcher handed over, or, for a
 * message from a dispatcher that predates sharding, both the user's shard and the legacy partition.
 */
const dispatchPartitionsForUser = (userId: string, handed: string[] | undefined): string[] =>
  handed && handed.length > 0
    ? handed
    : [dispatchShardPartitionValue(DISPATCH_PARTITION_VALUE, userId, DISPATCH_SHARD_COUNT), DISPATCH_PARTITION_VALUE];

/** A message body as parsed, before its fields are checked. */
type BatchMessage = { userIds?: unknown; dispatchPartitions?: unknown };

/**
 * The record's users, or null for a message that can never be processed. Such a message is
 * acknowledged as before, and now logged and counted as `userNotifier.malformed` (C1.8) with the
 * reason: empty_body, invalid_json, invalid_structure (no `userIds` array) or no_user_ids.
 */
const parseBatchPayload = (record: SQSRecord): BatchPayload | null => {
  const drop = (reason: string): null => {
    reportUnprocessableMessage({
      site: "userNotifier.malformed",
      reason,
      messageId: record.messageId,
      body: record.body,
    });
    return null;
  };

  if (!record.body) return drop("empty_body");

  let parsed: BatchMessage | null;
  try {
    parsed = JSON.parse(record.body);
  } catch {
    // The preview in the drop line shows what was received.
    return drop("invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.userIds)) return drop("invalid_structure");

  const userIds = parsed.userIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
  if (userIds.length === 0) return drop("no_user_ids");

  return { userIds, dispatchPartitions: parseDispatchPartitions(parsed.dispatchPartitions, userIds) };
};

const getPendingNotificationsForUser = async (userId: string): Promise<PendingNotification[]> => {
  const notifications: PendingNotification[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamo.send(
      new QueryCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        KeyConditionExpression: "#pk = :userId",
        ExpressionAttributeNames: {
          "#pk": PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY,
        },
        ExpressionAttributeValues: {
          ":userId": { S: userId },
        },
        // Must see every row written before the marker read; see readDispatchMarkers.
        ConsistentRead: true,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const pendingKey = attributeValueToString(item[PENDING_NOTIFICATIONS_TABLE_SORT_KEY]);
      const billId = attributeValueToString(item.sourceBillId) ?? pendingKey?.split("#")[0] ?? null;
      const billTitle = attributeValueToString(item.billTitle);
      const category = attributeValueToString(item.category);
      const lifeArea = attributeValueToString(item.lifeArea);
      const notificationType = attributeValueToString(item.notificationType);
      const correlationId = normalizeCorrelationId(attributeValueToString(item.correlationId));
      const subCategory = parsePendingNotificationSubCategory(attributeValueToString(item.subCategory));
      const action = parsePendingNotificationAction({
        text: attributeValueToString(item.actionText),
        actionDate: attributeValueToString(item.actionDate),
        actionCode: attributeValueToString(item.actionCode),
        actionType: attributeValueToString(item.actionType),
      });
      const ttl = epochSecondsAttribute(item.ttl);
      const createdAt = epochSecondsAttribute(item.createdAt);
      const changedAtMs = parsePendingNotificationChangedAtMs(item.changedAtMs?.N);
      const pairedOutcome = attributeValueToString(item.pairedOutcome);

      if (
        pendingKey &&
        billId &&
        billTitle &&
        category &&
        notificationType &&
        (notificationType === "new" ||
          notificationType === "updated" ||
          notificationType === "alert" ||
          notificationType === "passed" ||
          notificationType === "failed")
      ) {
        notifications.push({
          userId,
          pendingKey,
          billId,
          billTitle,
          category,
          lifeArea: lifeArea ?? "",
          notificationType: notificationType as NotificationType,
          ...(subCategory ? { subCategory } : {}),
          ...(action ? { action } : {}),
          ...(correlationId ? { correlationId } : {}),
          ...(ttl !== undefined ? { ttl } : {}),
          ...(createdAt !== undefined ? { createdAt } : {}),
          ...(changedAtMs !== undefined ? { changedAtMs } : {}),
          ...(notificationType === "alert" && isPairedOutcomeType(pairedOutcome) ? { pairedOutcome } : {}),
        });
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return notifications;
};

const deletePendingNotifications = async (userId: string, pendingKeys: string[]): Promise<void> => {
  if (pendingKeys.length === 0) return;

  const deleteRequests: PendingDeleteRequest[] = pendingKeys.map((pendingKey) => ({
    DeleteRequest: {
      Key: {
        [PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY]: { S: userId },
        [PENDING_NOTIFICATIONS_TABLE_SORT_KEY]: { S: pendingKey },
      },
    },
  }));

  const BATCH_SIZE = 25;
  for (let i = 0; i < deleteRequests.length; i += BATCH_SIZE) {
    let pending: PendingDeleteRequest[] = deleteRequests.slice(i, i + BATCH_SIZE);
    let attempts = 0;
    while (pending.length > 0) {
      const resp = await dynamo.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [PENDING_NOTIFICATIONS_TABLE]: pending,
          },
        }),
      );
      const unprocessed = (resp.UnprocessedItems?.[PENDING_NOTIFICATIONS_TABLE] ?? []).filter(
        (request): request is PendingDeleteRequest => Boolean(request?.DeleteRequest?.Key),
      );
      if (unprocessed.length === 0) break;
      attempts += 1;
      if (attempts > 5) {
        throw new Error(`Failed to delete pending notifications after retries for userId=${userId}`);
      }
      await sleep(100 * attempts);
      pending = unprocessed;
    }
  }
};

/**
 * Reads the user's marker in each partition it will release, with a consistent read, BEFORE the
 * pending rows are queried. A pending-notification transaction that committed before this read is
 * seen by the query; one that commits later rewrites the marker with a new markerVersion.
 */
const readDispatchMarkers = async (
  userId: string,
  dispatchPartitions: readonly string[],
): Promise<SeenDispatchMarker[]> => {
  const markers: SeenDispatchMarker[] = [];
  for (const partitionValue of dispatchPartitions) {
    const response = await dynamo.send(
      new GetItemCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        Key: {
          [DISPATCH_PARTITION_KEY]: { S: partitionValue },
          [DISPATCH_SORT_KEY]: { S: userId },
        },
        ProjectionExpression: "#sk, #markerVersion",
        ExpressionAttributeNames: { "#sk": DISPATCH_SORT_KEY, "#markerVersion": DISPATCH_MARKER_VERSION_ATTRIBUTE },
        ConsistentRead: true,
      }),
    );
    const item = response.Item;
    markers.push(
      item
        ? {
            partitionValue,
            exists: true,
            markerVersion: attributeValueToString(item[DISPATCH_MARKER_VERSION_ATTRIBUTE]) ?? undefined,
          }
        : { partitionValue, exists: false },
    );
  }
  return markers;
};

// The writers rewrite the marker with every pending row. Deleting it unconditionally after the
// query would orphan a row written in between, so only the marker that was read before the query
// is deleted: same markerVersion, or, for a marker written before versions existed, still without
// one and stamped before the query. A marker that did not exist at the read is left alone.
const deleteDispatchMarkerForUser = async (
  userId: string,
  seen: SeenDispatchMarker,
  queriedAtMs: number,
): Promise<void> => {
  const { partitionValue } = seen;
  if (!seen.exists) {
    logger.debug("No dispatch marker to release in this partition", { userId, dispatchPartition: partitionValue });
    return;
  }
  const condition: Pick<
    DeleteItemCommandInput,
    "ConditionExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues"
  > =
    seen.markerVersion !== undefined
      ? {
          ConditionExpression: "#markerVersion = :seenVersion",
          ExpressionAttributeNames: { "#markerVersion": DISPATCH_MARKER_VERSION_ATTRIBUTE },
          ExpressionAttributeValues: { ":seenVersion": { S: seen.markerVersion } },
        }
      : {
          ConditionExpression:
            "attribute_not_exists(#markerVersion) AND (attribute_not_exists(#updatedAt) OR #updatedAt < :cutoff)",
          ExpressionAttributeNames: {
            "#markerVersion": DISPATCH_MARKER_VERSION_ATTRIBUTE,
            "#updatedAt": "updatedAtEpoch",
          },
          ExpressionAttributeValues: {
            ":cutoff": { N: String(Math.floor(queriedAtMs / 1000) - DISPATCH_MARKER_SAFETY_MARGIN_SECONDS) },
          },
        };
  try {
    await dynamo.send(
      new DeleteItemCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        Key: {
          [DISPATCH_PARTITION_KEY]: { S: partitionValue },
          [DISPATCH_SORT_KEY]: { S: userId },
        },
        ...condition,
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    logger.info("Kept dispatch marker; pending notifications may have arrived after the query", {
      userId,
      dispatchPartition: partitionValue,
    });
  }
};

const deleteDispatchClaimForUser = async (userId: string, partitionValue: string): Promise<void> => {
  await dynamo.send(
    new DeleteItemCommand({
      TableName: PENDING_NOTIFICATIONS_TABLE,
      Key: {
        [DISPATCH_PARTITION_KEY]: { S: partitionValue },
        [DISPATCH_SORT_KEY]: { S: `${DISPATCH_CLAIM_PREFIX}${userId}` },
      },
    }),
  );
};

// Every marker before any claim: while a claim stands no other run can pick the user up, and once the
// markers are gone a run has nothing left to claim in the partitions still being released.
const releaseDispatchStateForUser = async (
  userId: string,
  queriedAtMs: number,
  markers: readonly SeenDispatchMarker[],
): Promise<void> => {
  for (const marker of markers) {
    await deleteDispatchMarkerForUser(userId, marker, queriedAtMs);
  }
  for (const { partitionValue } of markers) {
    await deleteDispatchClaimForUser(userId, partitionValue);
  }
};

// Notifications are delivered directly to platform endpoint ARNs via SNS Publish(TargetArn).
// No SNS topic is used by this lambda.

const buildSingleBillApnsPayload = (
  bill: PendingNotification,
  copy: PushCopy,
  details: PushPayloadDetails,
  billIds: string[] = [bill.billId],
): BuiltPushPayload => {
  const apns = {
    aps: {
      alert: {
        title: truncateUtf8(copy.title, SINGLE_TITLE_MAX_BYTES),
        body: truncateUtf8(copy.body, PUSH_BODY_MAX_BYTES),
      },
      sound: "default",
      "thread-id": "bill-digest",
    },
    domain: "bill",
    billId: bill.billId,
    billIds,
    notificationType: copy.notificationType,
    ...details,
  };

  if (byteLengthOfJson(apns) > APNS_SAFE_PAYLOAD_BYTES) {
    const fallback = {
      aps: {
        alert: {
          title: truncateUtf8(bill.billTitle, 96),
          body: "Open Billboard",
        },
        sound: "default",
        "thread-id": "bill-digest",
      },
      domain: "bill",
      billId: bill.billId,
      billIds,
      notificationType: copy.notificationType,
    };
    return {
      apnsPayload: JSON.stringify(fallback),
      defaultMessage: truncateUtf8(copy.title, DEFAULT_MESSAGE_MAX_BYTES),
      billIds,
    };
  }

  return {
    apnsPayload: JSON.stringify(apns),
    defaultMessage: truncateUtf8(copy.title, DEFAULT_MESSAGE_MAX_BYTES),
    billIds,
  };
};

/** A digest push's APNs payload; the size fallbacks drop the Updates row details and shorten the rest. */
type DigestApnsPayload = PushPayloadDetails & {
  aps: { alert: { title: string; body: string }; sound: string; "thread-id": string };
  domain: string;
  billIds: string[];
  billCount: number;
  notificationType: PushCopy["notificationType"];
};

/** `billIdLimit`: how many ids the push lists at most, before the size fallbacks (8, UPDATED_PUSH_BILL_ID_LIMIT). */
const buildDigestApnsPayload = (
  bills: PendingNotification[],
  copy: PushCopy,
  details: PushPayloadDetails,
  counting: BillCounting = BY_BILL_ID,
  uniqueBillIds: string[] = uniqueNonEmpty(bills.map((b) => b.billId)),
  billIdLimit: number = DIGEST_PREVIEW_BILL_ID_LIMIT,
): BuiltPushPayload => {
  const billCount = uniqueNonEmpty(bills.map((b) => counting.keyOf(b.billId))).length;

  const apns: DigestApnsPayload = {
    aps: {
      alert: {
        title: truncateUtf8(copy.title, SINGLE_TITLE_MAX_BYTES),
        body: truncateUtf8(copy.body, PUSH_BODY_MAX_BYTES),
      },
      sound: "default",
      "thread-id": "bill-digest",
    },
    domain: "bill",
    billIds: uniqueBillIds.slice(0, billIdLimit),
    billCount,
    notificationType: copy.notificationType,
    ...details,
  };

  // The Updates row details go first, then bill ids, then the body.
  if (byteLengthOfJson(apns) > APNS_SAFE_PAYLOAD_BYTES) {
    delete apns.alert;
    delete apns.category;
    delete apns.subCategory;
  }

  while (byteLengthOfJson(apns) > APNS_SAFE_PAYLOAD_BYTES && apns.billIds.length > 1) {
    apns.billIds = apns.billIds.slice(0, -1);
  }

  if (byteLengthOfJson(apns) > APNS_SAFE_PAYLOAD_BYTES) {
    apns.aps.alert.body = `${billCount} bill updates`;
  }

  if (byteLengthOfJson(apns) > APNS_SAFE_PAYLOAD_BYTES) {
    apns.billIds = uniqueBillIds.slice(0, 1);
  }

  if (byteLengthOfJson(apns) > APNS_SAFE_PAYLOAD_BYTES) {
    apns.aps.alert.body = "Open Billboard for recent updates";
  }

  return {
    apnsPayload: JSON.stringify(apns),
    defaultMessage: truncateUtf8(copy.title, DEFAULT_MESSAGE_MAX_BYTES),
    billIds: apns.billIds,
  };
};

/**
 * One push for `rows`, the rows of one push a device gets (companion rows already folded): the copy and type from
 * pushCopy.ts, the Updates row details, and the single-bill or digest shape both apps read.
 */
const buildApnsPayload = (
  rows: PendingNotification[],
  counting: BillCounting,
  billIds: string[] | undefined,
  nowMs: number,
  billIdLimit: number = DIGEST_PREVIEW_BILL_ID_LIMIT,
): BuiltPushPayload => {
  const copy = pushCopyFor(rows, counting.keyOf, nowMs);
  const details = pushPayloadDetails(rows, copy.notificationType, counting.keyOf);
  return rows.length === 1
    ? buildSingleBillApnsPayload(rows[0], copy, details, billIds)
    : buildDigestApnsPayload(rows, copy, details, counting, billIds, billIdLimit);
};

/** The push for a device's "other" rows: one push, its ids cut to DIGEST_PREVIEW_BILL_ID_LIMIT as before S5. */
const buildOtherPush = (rows: PendingNotification[], counting: BillCounting, nowMs: number): BuiltPushPayload => {
  const shownBills = collapseCompanionRows(rows, counting);
  // Only a push whose copy folded companion rows lists more ids than it describes.
  const billIds = shownBills.length < rows.length ? pushBillIds(shownBills, rows) : undefined;
  return buildApnsPayload(shownBills, counting, billIds, nowMs);
};

/** `rows` by bill (a companion group's rows together), in the order each bill first appears. */
const rowsByBill = (rows: PendingNotification[], counting: BillCounting): PendingNotification[][] => {
  const byKey = new Map<string, PendingNotification[]>();
  for (const row of rows) {
    const key = counting.keyOf(row.billId);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  return Array.from(byKey.values());
};

const billIdCount = (rows: PendingNotification[]): number => uniqueNonEmpty(rows.map((row) => row.billId)).length;

/** One "updated" push for `rows`, listing all their ids; halved by bill, again and again, until no id is dropped. */
const buildUpdatedPushParts = (
  rows: PendingNotification[],
  counting: BillCounting,
  nowMs: number,
): { rows: PendingNotification[]; built: BuiltPushPayload }[] => {
  const shownBills = collapseCompanionRows(rows, counting);
  const billIds = pushBillIds(shownBills, rows);
  const built = buildApnsPayload(shownBills, counting, billIds, nowMs, UPDATED_PUSH_BILL_ID_LIMIT);
  const bills = rowsByBill(rows, counting);
  if (built.billIds.length >= billIds.length || bills.length < 2) return [{ rows, built }];
  // Ids too long for one payload (a guid can be 64 characters; 50 of them are about 3.4 KB).
  const half = Math.ceil(bills.length / 2);
  return [
    ...buildUpdatedPushParts(bills.slice(0, half).flat(), counting, nowMs),
    ...buildUpdatedPushParts(bills.slice(half).flat(), counting, nowMs),
  ];
};

/**
 * The pushes for the user's "updated" rows (review of S5, F1). Both apps ask to vote again only on the bills a push
 * lists, and the rows are deleted once it is sent, so each push lists every bill it covers: up to
 * UPDATED_PUSH_BILL_ID_LIMIT ids, a companion group's rows always on the same push, and further "updated" pushes for
 * the rest. The same on every device that takes "updated" pushes, so they are built once.
 */
const buildUpdatedPushes = (
  rows: PendingNotification[],
  counting: BillCounting,
  nowMs: number,
): { rows: PendingNotification[]; built: BuiltPushPayload }[] => {
  const chunks: PendingNotification[][] = [];
  let chunk: PendingNotification[] = [];
  for (const bill of rowsByBill(rows, counting)) {
    if (chunk.length > 0 && billIdCount([...chunk, ...bill]) > UPDATED_PUSH_BILL_ID_LIMIT) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk = [...chunk, ...bill];
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.flatMap((rowsOfChunk) => buildUpdatedPushParts(rowsOfChunk, counting, nowMs));
};

/**
 * UX-33: the same push without its sound. A device's second push of one dispatch (the "updated" push beside the one for
 * every other row, or a further "updated" push) arrives silently, so one dispatch plays one sound. Neither app reads
 * `aps.sound` (1.1 and 1.2 PushNotificationsAppDelegate present a foreground push with `.sound`, which plays nothing
 * for a push without one).
 */
const withoutSound = (built: BuiltPushPayload): BuiltPushPayload => {
  const apns = JSON.parse(built.apnsPayload);
  if (apns?.aps && typeof apns.aps === "object") delete apns.aps.sound;
  return { ...built, apnsPayload: JSON.stringify(apns) };
};

const isNotificationTypeEnabledForDevice = (device: UserDeviceRecord, type: NotificationType): boolean => {
  if (device.notificationsEnabled === false) {
    return false;
  }

  switch (type) {
    case "new":
      return device.notifyNew !== false;
    case "updated":
      return device.notifyUpdated !== false;
    case "alert":
      return device.notifyAlert !== false;
    case "passed":
      return device.notifyPassed !== false;
    case "failed":
      return device.notifyFailed !== false;
    default:
      return true;
  }
};

/**
 * UX-33 (project decision 2026-10-29, "one event, per phone"): of a device's rows, the ones it gets. A change that added
 * an action and passed or failed the bill wrote the user both rows at once (shared/pendingNotifications.ts,
 * PendingPairedAlert); the action row (`pairedOutcome`) goes only to a device that does not take that outcome's pushes,
 * and the outcome row, as any row, only to one that does. So a device that takes the outcome gets the outcome push, one
 * with that outcome off but actions on gets the action push, and no device gets both or neither (unless both types are
 * off). The two rows are written, held and settled together, so this needs no look at the other row. An unmarked action
 * row (an older writer) goes to every device that takes actions, as before.
 */
const oneRowPerOutcomeChange = (rows: PendingNotification[], device: UserDeviceRecord): PendingNotification[] =>
  rows.filter(
    (row) => row.pairedOutcome === undefined || !isNotificationTypeEnabledForDevice(device, row.pairedOutcome),
  );

type DevicePublishResult = "sent" | "endpoint_removed" | Error;

/** What a failed SNS Publish is read for: the error's name and message, or the Error.Code of an older client's error. */
type PublishFailure = { name?: unknown; message?: unknown; Error?: { Code?: unknown } };

const publishDigestNotification = async (
  data: DigestNotificationData,
  counting: BillCounting = BY_BILL_ID,
): Promise<PublishOutcome> => {
  // One clock read for the run's copy ("Oct 27" against the current year).
  const nowMs = Date.now();
  const rowsOf = (group: PushGroup) => data.bills.filter((bill) => pushGroupOf(bill.notificationType) === group);
  // The "other" push differs by device (each drops the types it turned off, and one row of an outcome change); its
  // outcome covers all its rows.
  const otherPush = newPushOutcome(rowsOf("other"));
  const updatedPushes = buildUpdatedPushes(rowsOf("updated"), counting, nowMs).map(({ rows, built }) => ({
    outcome: newPushOutcome(rows),
    built,
  }));
  const pushes = [...(otherPush.rows.length > 0 ? [otherPush] : []), ...updatedPushes.map(({ outcome }) => outcome)];
  const outcome = (): PublishOutcome => ({
    sent: pushes.reduce((total, push) => total + push.sent, 0),
    failures: pushes.flatMap((push) => push.failures),
    pushes,
  });
  if (data.devices.length === 0) {
    logger.warn("No devices available for push", { userId: data.userId });
    return outcome();
  }

  const removeEndpointArnForDevice = async (userId: string, deviceId: string): Promise<void> => {
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: DEVICE_TABLE,
          Key: {
            [USER_ID_ATTRIBUTE]: { S: userId },
            [DEVICE_ID_ATTRIBUTE]: { S: deviceId },
          },
          UpdateExpression: `REMOVE #endpoint`,
          ExpressionAttributeNames: {
            "#endpoint": ENDPOINT_ARN_ATTRIBUTE,
          },
        }),
      );
      logger.info("Removed stale endpointArn from device record", { userId, deviceId });
    } catch (err) {
      logger.warn("Failed to remove endpointArn for device", { userId, deviceId, err });
    }
  };

  const publishToDevice = async (
    device: UserDeviceRecord,
    targetArn: string,
    builtPayload: BuiltPushPayload,
  ): Promise<DevicePublishResult> => {
    const message = JSON.stringify({
      default: builtPayload.defaultMessage,
      APNS: builtPayload.apnsPayload,
      APNS_SANDBOX: builtPayload.apnsPayload,
    });

    try {
      await sns.send(
        new PublishCommand({
          TargetArn: targetArn,
          MessageStructure: "json",
          Message: message,
        }),
      );
      return "sent";
    } catch (err) {
      const name = err && (err as PublishFailure).name ? String((err as PublishFailure).name) : "";
      const msg = err && (err as PublishFailure).message ? String((err as PublishFailure).message) : "";
      const code = (err as PublishFailure)?.Error?.Code ? String((err as PublishFailure).Error!.Code) : "";

      const isNoEndpointError =
        (name === "InvalidParameterException" && msg.includes("No endpoint found")) ||
        msg.includes("No endpoint found for the target arn specified");

      const isEndpointDisabledError =
        name === "EndpointDisabledException" || code === "EndpointDisabled" || msg.includes("Endpoint is disabled");
      if (isNoEndpointError || isEndpointDisabledError) {
        await removeEndpointArnForDevice(data.userId, device.deviceId);
        logger.warn(
          isNoEndpointError
            ? "SNS reported no endpoint for TargetArn; removed stale endpointArns (best-effort)"
            : "SNS endpoint disabled; removed endpointArn from device records (best-effort)",
          { userId: data.userId, deviceId: device.deviceId, targetArn },
        );
        return "endpoint_removed";
      }

      logger.error("Failed to publish push notification", {
        userId: data.userId,
        deviceId: device.deviceId,
        targetArn,
        errorName: name,
        errorCode: code || undefined,
        error: err,
      });
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  for (const device of data.devices) {
    const targetArn = device.endpointArn;
    if (!targetArn) {
      continue;
    }

    if (!targetArn.includes(SNS_ENDPOINT_ARN_SEGMENT)) {
      logger.warn("Skipping invalid SNS target ARN stored on device; removing endpointArn", {
        userId: data.userId,
        deviceId: device.deviceId,
        targetArn,
      });
      await removeEndpointArnForDevice(data.userId, device.deviceId);
      continue;
    }

    const filteredBills = oneRowPerOutcomeChange(
      data.bills.filter((bill) => isNotificationTypeEnabledForDevice(device, bill.notificationType)),
      device,
    );
    if (filteredBills.length === 0) {
      logger.info("Skipping device for this batch; all notification types disabled", {
        userId: data.userId,
        deviceId: device.deviceId,
      });
      continue;
    }

    const otherBills = filteredBills.filter((bill) => pushGroupOf(bill.notificationType) === "other");
    const devicePushes: { outcome: PushOutcome; built: BuiltPushPayload; rows: PendingNotification[] }[] = [
      ...(otherBills.length > 0
        ? [{ outcome: otherPush, built: buildOtherPush(otherBills, counting, nowMs), rows: otherBills }]
        : []),
      // A device takes every "updated" push or none (its notifyUpdated).
      ...(filteredBills.some((bill) => bill.notificationType === "updated")
        ? updatedPushes.map((push) => ({ ...push, rows: push.outcome.rows }))
        : []),
    ];
    // The first push this device takes plays the sound; any later one of this dispatch is silent (withoutSound).
    let soundPlayed = false;
    for (const { outcome: push, built, rows } of devicePushes) {
      const result = await publishToDevice(device, targetArn, soundPlayed ? withoutSound(built) : built);
      if (result === "sent") {
        soundPlayed = true;
        countDeviceSend(push, rows);
      } else if (result === "endpoint_removed") {
        // The device is gone; its other pushes would fail the same way.
        break;
      } else {
        push.failures.push(result);
      }
    }
  }

  return outcome();
};

// One line per bill, keyed by the bill's own guid and correlation id, so a Logs Insights query for
// one bill finds where its notification ended; `dispatchCorrelationId` is the dispatch run's id.
// "delivered": at least one device was sent a push carrying the row (`devicesSent`: how many). "not_sent":
// no device was (no endpoint, the notification type is turned off, or, for one row of an outcome change, the
// device took the other: UX-33). "no_devices": the user has no devices.
// "expired": the row was past its 24-hour lifetime and was deleted unsent (PENDING_EXPIRY_MODE
// enforce). "would_expire": the same row in watch mode; it is then handled as before and gets one of
// the first three lines too. "held": the user's quiet hours (S5) or the pace window of their last push
// (UX-33); the row is kept, with `heldUntil` and `holdReason`, and sent by the first dispatch after it.
// "dropped_revoted": an "updated" row deleted unsent because the user voted on the bill after the row was
// written (UX-33). "not_a_failure": a "failed" row whose action is not the bill's own failure under REL-50's
// rule (an old-rule row), deleted unsent (dropNotFailureRows).
type BillOutcome =
  | "delivered"
  | "not_sent"
  | "no_devices"
  | "expired"
  | "would_expire"
  | "held"
  | "dropped_revoted"
  | "not_a_failure";

const logBillOutcomes = (
  bills: PendingNotification[],
  outcome: BillOutcome | ((bill: PendingNotification) => BillOutcome),
  fields: Record<string, unknown> | ((bill: PendingNotification) => Record<string, unknown>),
): void => {
  const dispatchCorrelationId = logger.currentKeys().correlationId;
  for (const bill of bills) {
    logger.withKeys({ guid: bill.billId, correlationId: bill.correlationId }, () => {
      // Rows written before OBS-10 have no id; do not let the dispatch run's id stand in for it.
      if (!bill.correlationId) logger.removeKeys("correlationId");
      logger.info("Bill notification outcome", {
        outcome: typeof outcome === "function" ? outcome(bill) : outcome,
        notificationType: bill.notificationType,
        ...(bill.pairedOutcome ? { pairedOutcome: bill.pairedOutcome } : {}),
        dispatchCorrelationId,
        ...(typeof fields === "function" ? fields(bill) : fields),
      });
    });
  }
};

/**
 * Counts and logs pending rows past their lifetime (C1.3, X6): one EMF line,
 * BillBoard/Notifications NotificationsExpiredUndelivered = the number of rows (no dimensions; the
 * alarm Billboard-Notifications-ExpiredUndelivered sums it per day), and one outcome line per row with
 * its age. Never throws, so in watch mode it cannot change what is delivered.
 */
const reportExpiredRows = (
  expired: PendingNotification[],
  outcome: "expired" | "would_expire",
  nowSeconds: number,
): void => {
  try {
    emitEmbeddedMetric(NOTIFICATIONS_METRIC_NAMESPACE, EXPIRED_UNDELIVERED_METRIC, expired.length, {
      properties: { pendingExpiryMode: PENDING_EXPIRY_MODE },
    });
  } catch {
    // emitEmbeddedMetric catches its own failures; this covers a throwing console.warn there.
  }
  try {
    logBillOutcomes(expired, outcome, (bill) => ({
      pendingExpiryMode: PENDING_EXPIRY_MODE,
      ageSeconds: bill.createdAt === undefined ? undefined : nowSeconds - bill.createdAt,
      createdAt: bill.createdAt,
      ttl: bill.ttl,
    }));
  } catch {
    // The outcome lines are lost; the metric above still counts the rows.
  }
};

/**
 * C1.3 with X6: the rows to deliver, after handling those past their 24-hour lifetime at `nowSeconds`.
 * No expired row: every row, and nothing is written. Watch: the expired rows are counted and logged
 * "would_expire", and every row is returned, so they are sent and deleted exactly as before. Enforce:
 * the expired rows are deleted first (a failed delete throws, so the record is retried and nothing is
 * published), then counted and logged "expired"; only the fresh rows are returned. A retried record
 * counts again the rows it still finds (watch); enforce counts a row once it is deleted.
 */
const settleExpiredRows = async (
  userId: string,
  bills: PendingNotification[],
  nowSeconds: number,
): Promise<PendingNotification[]> => {
  const expired = bills.filter((bill) => isPendingRowExpired(bill, nowSeconds));
  if (expired.length === 0) return bills;
  if (PENDING_EXPIRY_MODE !== "enforce") {
    reportExpiredRows(expired, "would_expire", nowSeconds);
    return bills;
  }

  const expiredKeys = expired.map((bill) => bill.pendingKey);
  await deletePendingNotifications(userId, expiredKeys);
  reportExpiredRows(expired, "expired", nowSeconds);
  logger.warn("Deleted pending notifications past their lifetime unsent", { userId, pendingKeys: expiredKeys });
  const expiredRows = new Set(expired);
  return bills.filter((bill) => !expiredRows.has(bill));
};

/**
 * Why a "failed" row must not be pushed: its action is not the bill's own failure under REL-50's rule
 * (shared/billOutcomes.ts: an amendment or motion line, a failed suspension vote or 60-vote Senate vote, an action
 * with another code or none: the coded line of a real failure sends its own "failed"), or it names no action, so it
 * cannot be judged. null for a row that may be pushed, and for every row of another type.
 * notificationType has sent "failed" only for the rule's failures, with the action, since REL-50 (and S4), so this
 * stops only rows the rule before it wrote: during the deploy, or held for quiet hours or a retry across it (a row
 * lives 24 hours).
 */
const notFailurePushReason = (bill: Pick<PendingNotification, "notificationType" | "action">): string | null => {
  if (bill.notificationType !== "failed") return null;
  if (!bill.action) return "noAction";
  return notBillFailureReason({
    actionCode: bill.action.actionCode,
    actionDate: bill.action.actionDate,
    text: bill.action.text,
    type: bill.action.actionType,
  });
};

/**
 * REL-50 with UX-33: removes `pairedOutcome` "failed" from an action row written beside a "failed" row that
 * dropNotFailureRows deletes (shared/pendingNotifications.ts PendingPairedAlert), in the table, conditional on the
 * mark: a row rewritten since the read (a later change's row, marked or not) is left as it is. A failed write throws,
 * so the record is retried with both rows still pending.
 */
const unmarkPairedActionRow = async (userId: string, row: PendingNotification): Promise<void> => {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        Key: {
          [PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY]: { S: userId },
          [PENDING_NOTIFICATIONS_TABLE_SORT_KEY]: { S: row.pendingKey },
        },
        UpdateExpression: "REMOVE #paired",
        ConditionExpression: "#paired = :failed",
        ExpressionAttributeNames: { "#paired": "pairedOutcome" },
        ExpressionAttributeValues: { ":failed": { S: "failed" } },
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
  }
};

/**
 * REL-50: deletes the user's "failed" rows that notFailurePushReason stops, unsent (a failed delete throws, so the
 * record is retried and nothing is published), counts them (FailurePushesDropped in BillBoard/Notifications) and logs
 * each as "not_a_failure" with its reason; returns the other rows. A bill's "alert" row for the same action, if the
 * user follows the bill, is kept and pushed as an action.
 *
 * UX-33: when an old-rule version both added the action and "failed" the bill, that alert row was written beside the
 * failed row, marked `pairedOutcome` "failed", for a device without "Failed:" pushes only (oneRowPerOutcomeChange).
 * With its outcome row gone the change is an action only, so the mark comes off first, in the table
 * (unmarkPairedActionRow) and on the row returned (`actionRowUnmarked` on the "not_a_failure" line): every device that
 * takes actions gets the action push, the ones with "Failed:" pushes on included, now or in a later dispatch (after a
 * hold, or the retry of a push that failed), and none gets two. A device with action pushes off and "Failed:" pushes
 * on gets none for the change: the failure was not the bill's, and the action is all that happened.
 */
const dropNotFailureRows = async (userId: string, bills: PendingNotification[]): Promise<PendingNotification[]> => {
  const dropped = bills.flatMap((bill) => {
    const reason = notFailurePushReason(bill);
    return reason ? [{ bill, reason }] : [];
  });
  if (dropped.length === 0) return bills;
  const droppedBillIds = new Set(dropped.map(({ bill }) => bill.billId));
  const pairedActionRows = new Set(
    bills.filter(
      (bill) => bill.notificationType === "alert" && bill.pairedOutcome === "failed" && droppedBillIds.has(bill.billId),
    ),
  );
  for (const row of pairedActionRows) await unmarkPairedActionRow(userId, row);
  await deletePendingNotifications(
    userId,
    dropped.map(({ bill }) => bill.pendingKey),
  );
  emitEmbeddedMetric(NOTIFICATIONS_METRIC_NAMESPACE, FAILURE_PUSHES_DROPPED_METRIC, dropped.length);
  const reasons = new Map(dropped.map(({ bill, reason }) => [bill, reason]));
  const unmarkedBillIds = new Set(Array.from(pairedActionRows, (row) => row.billId));
  logBillOutcomes(
    dropped.map(({ bill }) => bill),
    "not_a_failure",
    (bill) => ({
      reason: reasons.get(bill),
      actionCode: bill.action?.actionCode,
      actionDate: bill.action?.actionDate,
      ...(unmarkedBillIds.has(bill.billId) ? { actionRowUnmarked: true } : {}),
    }),
  );
  return bills
    .filter((bill) => !reasons.has(bill))
    .map((bill) => {
      if (!pairedActionRows.has(bill)) return bill;
      const unmarked = { ...bill };
      delete unmarked.pairedOutcome;
      return unmarked;
    });
};

/**
 * S5: the zone of the user's quiet hours, from the state of their district (`resolvedState`, else `selfAttestedState`
 * on their UserPII row); Eastern time when the state is unknown or cannot be read.
 */
const quietHoursTimeZone = async (userId: string): Promise<string> => {
  let state: string | undefined;
  if (PII_TABLE_NAME) {
    try {
      const response = await dynamo.send(
        new GetItemCommand({
          TableName: PII_TABLE_NAME,
          Key: { [PII_PARTITION_KEY]: { S: userId } },
          ProjectionExpression: "resolvedState, selfAttestedState",
        }),
      );
      state = response.Item?.resolvedState?.S ?? response.Item?.selfAttestedState?.S;
    } catch (error) {
      logger.warn("Could not read the user's state; using Eastern time for quiet hours", { userId, error });
    }
  }
  return timeZoneForState(state);
};

/**
 * UX-33: the pace item, next to the user's dispatch marker in their shard partition (`__pace__#<user>`). Its
 * `markerType` is neither "pending-user" nor a claim's, so NotificationDispatcher, old or new, passes over it, and a
 * dispatch partition is never scanned as a user's pending rows.
 */
const pushPaceKey = (userId: string): Record<string, { S: string }> => ({
  [DISPATCH_PARTITION_KEY]: { S: dispatchShardPartitionValue(DISPATCH_PARTITION_VALUE, userId, DISPATCH_SHARD_COUNT) },
  [DISPATCH_SORT_KEY]: { S: `${PUSH_PACE_SORT_KEY_PREFIX}${userId}` },
});

/** When the user was last sent a push (epoch ms), or null: none recorded, or the item cannot be read (then no pace). */
const lastPushAtMs = async (userId: string): Promise<number | null> => {
  try {
    const response = await dynamo.send(
      new GetItemCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        Key: pushPaceKey(userId),
        ProjectionExpression: "lastPushAtEpoch",
        ConsistentRead: true,
      }),
    );
    const epoch = epochSecondsAttribute(response.Item?.lastPushAtEpoch);
    return epoch === undefined ? null : epoch * 1000;
  } catch (error) {
    logger.warn("Could not read the user's last push time; sending without the push pace", { userId, error });
    return null;
  }
};

/**
 * UX-33: records that a push reached the user at `atMs`, opening the pace window. Written before the dispatch state is
 * released, while the claim still keeps every other run off the user. A failed write is logged and the dispatch goes
 * on: the next push may then come before the window ends, and nothing is lost.
 */
const recordPushSent = async (userId: string, atMs: number): Promise<void> => {
  const atEpoch = Math.floor(atMs / 1000);
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        Key: pushPaceKey(userId),
        UpdateExpression: "SET #markerType = :pace, #targetUserId = :userId, #lastPush = :at, #ttl = :ttl",
        ExpressionAttributeNames: {
          "#markerType": "markerType",
          "#targetUserId": "targetUserId",
          "#lastPush": "lastPushAtEpoch",
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: {
          ":pace": { S: PUSH_PACE_MARKER_TYPE },
          ":userId": { S: userId },
          ":at": { N: String(atEpoch) },
          ":ttl": { N: String(atEpoch + PUSH_PACE_HOURS * 3600 + PUSH_PACE_ITEM_MARGIN_SECONDS) },
        },
      }),
    );
  } catch (error) {
    logger.warn("Could not record the user's push time; their next push may come before the push pace allows", {
      userId,
      error,
    });
  }
};

/**
 * S5 and UX-33: whether the user's pending rows wait at `nowMs`, and until when (shared/pushPace.ts): the quiet hours
 * (QUIET_HOURS=on, one UserPII read) and the pace window of their last push (PUSH_PACE_HOURS, one read of the pace
 * item). Null: send now.
 */
const pushHoldFor = async (userId: string, nowMs: number): Promise<PushHold | null> => {
  const timeZone = QUIET_HOURS_ON ? await quietHoursTimeZone(userId) : null;
  const lastPushMs = PUSH_PACE_HOURS > 0 ? await lastPushAtMs(userId) : null;
  return pushHoldAt(nowMs, timeZone, lastPushMs === null ? null : paceWindowEndMs(lastPushMs, PUSH_PACE_HOURS));
};

/**
 * Keeps the dispatcher off the user until the hold ends: the claim the dispatcher took in each partition gets that
 * lease (and TTL), marked `holdUntilEpoch` and `holdReason` ("quiet_hours" or "pace") so the dispatcher skips the user
 * without trying to claim. A quiet-hours hold also keeps `quietHoursUntilEpoch`, the mark a NotificationDispatcher
 * older than UX-33 reads. The markers and pending rows stay, so the first dispatch after the lease claims the user and
 * sends everything then pending.
 */
const holdDispatchUntil = async (
  userId: string,
  markers: readonly SeenDispatchMarker[],
  hold: PushHold,
): Promise<void> => {
  const untilEpoch = String(Math.ceil(hold.untilMs / 1000));
  const quiet = hold.reason === "quiet_hours";
  for (const { partitionValue } of markers) {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        Key: {
          [DISPATCH_PARTITION_KEY]: { S: partitionValue },
          [DISPATCH_SORT_KEY]: { S: `${DISPATCH_CLAIM_PREFIX}${userId}` },
        },
        UpdateExpression:
          "SET #markerType = :claim, #targetUserId = :userId, #lease = :until, #holdUntil = :until, " +
          `#holdReason = :reason, #ttl = :until${quiet ? ", #quietUntil = :until" : ""}`,
        ExpressionAttributeNames: {
          "#markerType": "markerType",
          "#targetUserId": "targetUserId",
          "#lease": "leaseExpiresAtEpoch",
          "#holdUntil": "holdUntilEpoch",
          "#holdReason": "holdReason",
          "#ttl": "ttl",
          ...(quiet ? { "#quietUntil": "quietHoursUntilEpoch" } : {}),
        },
        ExpressionAttributeValues: {
          ":claim": { S: "dispatch-claim" },
          ":userId": { S: userId },
          ":until": { N: untilEpoch },
          ":reason": { S: hold.reason },
        },
      }),
    );
  }
};

/**
 * Logs and counts the rows a hold keeps: one `held` outcome line per row (`heldUntil`, `holdReason`), the metric
 * NotificationsHeldQuietHours or NotificationsHeldPace (rows), and NotificationsHeldPastLifetime for rows whose 24 hours
 * end before the hold does (alarm Billboard-Notifications-HeldPastLifetime). Neither hold is long enough for that on
 * its own (at most 12 hours of quiet hours, or a pace window and then the night), so such a row was already late, from
 * a delivery outage: DynamoDB may delete it unsent before the hold ends.
 */
const reportHeldRows = (userId: string, bills: PendingNotification[], hold: PushHold): void => {
  const heldUntil = new Date(hold.untilMs).toISOString();
  const pastLifetime = new Set(bills.filter((bill) => isPendingRowExpired(bill, Math.ceil(hold.untilMs / 1000))));
  const metrics: EmbeddedMetricInput[] = [
    { name: hold.reason === "pace" ? "NotificationsHeldPace" : "NotificationsHeldQuietHours", value: bills.length },
    ...(pastLifetime.size > 0 ? [{ name: "NotificationsHeldPastLifetime", value: pastLifetime.size }] : []),
  ];
  emitEmbeddedMetrics(NOTIFICATIONS_METRIC_NAMESPACE, metrics, { properties: { holdReason: hold.reason } });
  logger.info(
    hold.reason === "pace"
      ? "Holding pending notifications for the push pace"
      : "Holding pending notifications for the user's quiet hours",
    { userId, billCount: bills.length, heldUntil, holdReason: hold.reason },
  );
  logBillOutcomes(bills, "held", (bill) => ({
    heldUntil,
    holdReason: hold.reason,
    ...(pastLifetime.has(bill) ? { pastLifetime: true } : {}),
  }));
  if (pastLifetime.size > 0) {
    // RUNBOOK 18.6 says how to send them now; for a pace hold the pace item goes first, or the user is held again.
    logger.warn("Holding pending notifications past their 24-hour lifetime", {
      userId,
      heldUntil,
      holdReason: hold.reason,
      pendingKeys: Array.from(pastLifetime, (bill) => bill.pendingKey),
    });
  }
};

/** When the user last voted on the bill (`votedAt` on their UserFeedback row, epoch ms), or null without a vote. */
const votedAtMs = async (userId: string, billId: string): Promise<number | null> => {
  const response = await dynamo.send(
    new GetItemCommand({
      TableName: FEEDBACK_TABLE_NAME,
      Key: { [FEEDBACK_PARTITION_KEY]: { S: userId }, [FEEDBACK_SORT_KEY]: { S: billId } },
      // The time only: never the vote.
      ProjectionExpression: "votedAt",
      ConsistentRead: true,
    }),
  );
  const raw = response.Item?.votedAt?.S;
  const ms = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * When the summary change behind an "updated" row was stored (epoch ms): `changedAtMs`, which notificationType reads
 * from the stored version (its S3 write time), else the row's write time (`createdAt`, a row written before the review
 * fix of UX-33 or by an older writer), which is later by the pipeline's delay. Undefined with neither.
 */
const summaryChangedAtMs = (bill: PendingNotification): number | undefined =>
  bill.changedAtMs ?? (bill.createdAt === undefined ? undefined : bill.createdAt * 1000);

/**
 * UX-33 (project decision 2026-10-28): a "vote again" push is not sent when the user has voted on the
 * bill since the summary changed. Both apps clear the vote they hold on every bill an "updated" push lists, whenever
 * that vote was cast (1.1 and 1.2 PushDeepLinkRouter), so a push held for the quiet hours or the pace would otherwise
 * ask them to vote again on a summary they already voted on. The change's time is when the version with the new
 * summary was stored (summaryChangedAtMs; a later change of the bill's summary rewrites the row and its time); a vote
 * stamped after it (`votedAt`, rewritten by each vote, an Abstain or a 1.1 dismissal included) is newer, and the row is
 * deleted unsent: outcome `dropped_revoted`, metric NotificationsDroppedRevoted. A vote that cannot be read keeps the
 * row (the push is sent, as before). Returns the rows still to send.
 */
const dropRevotedUpdates = async (userId: string, bills: PendingNotification[]): Promise<PendingNotification[]> => {
  if (!FEEDBACK_TABLE_NAME) return bills;
  const updates = bills.filter((bill) => bill.notificationType === "updated" && summaryChangedAtMs(bill) !== undefined);
  if (updates.length === 0) return bills;

  const revoted = new Set<PendingNotification>();
  await mapWithConcurrency(updates, VOTE_READ_CONCURRENCY, async (bill) => {
    try {
      const voted = await votedAtMs(userId, bill.billId);
      if (voted !== null && voted > (summaryChangedAtMs(bill) ?? Number.POSITIVE_INFINITY)) revoted.add(bill);
    } catch (error) {
      logger.warn("Could not read the user's vote on the bill; sending its vote-again push", {
        userId,
        guid: bill.billId,
        error,
      });
    }
  });
  if (revoted.size === 0) return bills;

  const dropped = bills.filter((bill) => revoted.has(bill));
  await deletePendingNotifications(
    userId,
    dropped.map((bill) => bill.pendingKey),
  );
  emitEmbeddedMetric(NOTIFICATIONS_METRIC_NAMESPACE, "NotificationsDroppedRevoted", dropped.length);
  logBillOutcomes(dropped, "dropped_revoted", (bill) => ({
    createdAt: bill.createdAt,
    ...(bill.changedAtMs !== undefined ? { changedAt: new Date(bill.changedAtMs).toISOString() } : {}),
  }));
  return bills.filter((bill) => !revoted.has(bill));
};

/** How many devices were sent a push carrying `row` in this dispatch. */
const devicesSentRow = (pushes: readonly PushOutcome[], row: PendingNotification): number =>
  pushes.reduce((total, push) => total + (push.rowDevices.get(row) ?? 0), 0);

/** UX-33: an outcome change's two rows: each action row marked `pairedOutcome`, with its outcome row when pending. */
const outcomeChanges = (
  rows: readonly PendingNotification[],
): { action: PendingNotification; outcome: PendingNotification | undefined }[] =>
  rows
    .filter((row) => row.pairedOutcome !== undefined)
    .map((action) => ({
      action,
      outcome: rows.find((row) => row.billId === action.billId && row.notificationType === action.pairedOutcome),
    }));

/**
 * UX-33: what one dispatch sent the user, as one metric line: PushesSent (pushes that reached at least one device; an
 * "updated" push and the push for every other row are two), NotificationsDelivered (the rows a device was sent; an
 * outcome change's two rows count once, its one event), NotificationsFolded (delivered rows less pushes: the rows that
 * did not get a push of their own) and, for outcome changes (project decision 2026-10-29, "one event, per phone"),
 * OutcomeChangeSentAsOutcome and OutcomeChangeSentAsAction: the devices sent the outcome push, and those sent the
 * action push instead (that outcome's pushes off on the device). Each change is also logged, with both counts.
 */
const reportPushesSent = (pushes: readonly PushOutcome[], settled: readonly PendingNotification[]): void => {
  const changes = outcomeChanges(settled);
  for (const { action, outcome } of changes) {
    logger.withKeys({ guid: action.billId, correlationId: action.correlationId }, () => {
      if (!action.correlationId) logger.removeKeys("correlationId");
      logger.info("Sent each device one push for a change's action and outcome", {
        outcomeType: action.pairedOutcome,
        devicesOutcome: outcome ? devicesSentRow(pushes, outcome) : 0,
        devicesAction: devicesSentRow(pushes, action),
      });
    });
  }
  const reached = pushes.filter((push) => push.sent > 0);
  if (reached.length === 0) return;
  const countedOnce = new Set(
    changes.filter(({ outcome }) => outcome && devicesSentRow(pushes, outcome) > 0).map(({ action }) => action),
  );
  const delivered = settled.filter((row) => !countedOnce.has(row) && devicesSentRow(pushes, row) > 0).length;
  const sentAs = (pick: "action" | "outcome") =>
    changes.reduce((total, change) => total + (change[pick] ? devicesSentRow(pushes, change[pick]!) : 0), 0);
  emitEmbeddedMetrics(NOTIFICATIONS_METRIC_NAMESPACE, [
    { name: "PushesSent", value: reached.length },
    { name: "NotificationsDelivered", value: delivered },
    { name: "NotificationsFolded", value: Math.max(0, delivered - reached.length) },
    ...(changes.length > 0
      ? [
          { name: "OutcomeChangeSentAsOutcome", value: sentAs("outcome") },
          { name: "OutcomeChangeSentAsAction", value: sentAs("action") },
        ]
      : []),
  ]);
};

const processUser = (userId: string, dispatchPartitions: readonly string[], counting: BillCounting): Promise<void> =>
  logger.withKeys({ userId }, () => processUserInScope(userId, dispatchPartitions, counting));

const processUserInScope = async (
  userId: string,
  dispatchPartitions: readonly string[],
  counting: BillCounting,
): Promise<void> => {
  // The markers first: see readDispatchMarkers.
  const markers = await readDispatchMarkers(userId, dispatchPartitions);
  const queriedAtMs = Date.now();
  const pending = await getPendingNotificationsForUser(userId);
  if (pending.length === 0) {
    logger.info("No pending notifications for user", { userId });
    await releaseDispatchStateForUser(userId, queriedAtMs, markers);
    return;
  }

  // REL-50: a "failed" row the rule before it wrote (an amendment or motion line) is deleted unsent, whatever its age.
  const judged = await dropNotFailureRows(userId, pending);
  // Rows are judged expired at the query's time (one clock read per user).
  const unexpired = judged.length > 0 ? await settleExpiredRows(userId, judged, Math.floor(queriedAtMs / 1000)) : [];
  if (unexpired.length === 0) {
    // Every row was dropped above, or (enforce only) past its lifetime and deleted unsent. No device read, no push.
    await releaseDispatchStateForUser(userId, queriedAtMs, markers);
    return;
  }

  // S5 and UX-33: nothing is pushed in the user's quiet hours or inside the pace window of their last push. The rows
  // wait (at most a pace window and then the night, well inside their 24 hours) and go out, folded as usual, with
  // whatever else arrives meanwhile.
  const hold = await pushHoldFor(userId, queriedAtMs);
  if (hold) {
    await holdDispatchUntil(userId, markers, hold);
    reportHeldRows(userId, unexpired, hold);
    return;
  }

  // UX-33: no "vote again" for a bill the user voted on since its summary changed.
  const bills = await dropRevotedUpdates(userId, unexpired);
  if (bills.length === 0) {
    await releaseDispatchStateForUser(userId, queriedAtMs, markers);
    return;
  }

  const pendingKeys = bills.map((bill) => bill.pendingKey);
  const devices = await deviceDao.getDevicesForUser(userId);
  if (devices.length === 0) {
    logger.info("No devices found for user; clearing pending notifications", {
      userId,
      billCount: bills.length,
    });
    await deletePendingNotifications(userId, pendingKeys);
    await releaseDispatchStateForUser(userId, queriedAtMs, markers);
    logger.info("Deleted pending notifications", { userId, pendingKeys });
    logBillOutcomes(bills, "no_devices", {});
    return;
  }

  const outcome = await publishDigestNotification({ userId, bills, devices }, counting);
  // A push that reached no device because every attempt failed keeps its rows for the SQS retry.
  const failedPushes = outcome.pushes.filter((push) => push.sent === 0 && push.failures.length > 0);
  const keptRows = new Set(failedPushes.flatMap((push) => push.rows));
  const keptBills = bills.filter((bill) => keptRows.has(bill));
  const settledBills = bills.filter((bill) => !keptRows.has(bill));
  if (settledBills.length === 0) {
    // Nothing reached the user, so keep the rows for the SQS retry.
    throw failedPushes[0].failures[0];
  }

  // Delete before any further work, so a later failure or a retry cannot push these rows again.
  // A device that failed while another succeeded is not retried, since a retry would re-send to the rest.
  const settledKeys = settledBills.map((bill) => bill.pendingKey);
  await deletePendingNotifications(userId, settledKeys);
  logger.info("Published notification", {
    userId,
    billCount: settledBills.length,
    // Pushes, not devices, since S5: a device can get "updated" pushes beside the others.
    devicesSent: outcome.sent,
    devicesFailed: outcome.failures.length,
  });
  for (const push of outcome.pushes) {
    if (failedPushes.includes(push)) continue;
    logBillOutcomes(
      push.rows,
      (bill) => ((push.rowDevices.get(bill) ?? 0) > 0 ? "delivered" : "not_sent"),
      (bill) => ({ devicesSent: push.rowDevices.get(bill) ?? 0, devicesFailed: push.failures.length }),
    );
  }
  reportPushesSent(
    outcome.pushes.filter((push) => !failedPushes.includes(push)),
    settledBills,
  );
  // UX-33: a push reached the user, so the pace window opens now, also when another push is kept for the retry (that
  // retry then waits for the window like any other row).
  if (PUSH_PACE_HOURS > 0 && outcome.pushes.some((push) => push.sent > 0)) {
    await recordPushSent(userId, Date.now());
  }
  if (keptBills.length > 0) {
    // The dispatch state stays, so the retry finds the kept rows; the sent ones are gone.
    logger.warn("Kept pending notifications whose push failed on every device", {
      userId,
      pendingKeys: keptBills.map((bill) => bill.pendingKey),
    });
    throw failedPushes[0].failures[0];
  }
  await releaseDispatchStateForUser(userId, queriedAtMs, markers);
  logger.info("Deleted pending notifications", { userId, pendingKeys: settledKeys });
};

const processRecord = async (record: SQSRecord, counting: BillCounting): Promise<void> => {
  const batch = parseBatchPayload(record);
  if (!batch) {
    return;
  }

  let failed = 0;
  for (const userId of batch.userIds) {
    try {
      await processUser(userId, dispatchPartitionsForUser(userId, batch.dispatchPartitions.get(userId)), counting);
    } catch (error) {
      logger.error("Failed to process notification for user", { userId, error });
      failed += 1;
    }
  }

  // Users already notified have no pending rows left, so a retry of this record skips them.
  if (failed > 0) {
    throw new Error(`Failed to notify ${failed} of ${batch.userIds.length} users`);
  }
};

export const handler = async (event: SQSEvent, context?: LambdaContextLike): Promise<SQSBatchResponse> => {
  logger.resetContext(context);
  const counting = event?.Records?.length ? await loadBillCounting() : BY_BILL_ID;
  return processSqsRecords(event, (record) => processRecord(record, counting), {
    label: "Failed to process userNotifier record",
  });
};
