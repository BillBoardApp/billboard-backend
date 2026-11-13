import { randomUUID } from "node:crypto";
import { type AttributeValue, type DynamoDBClient, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import type { NotificationType } from "../models/notifications";
import {
  billTypeMatchesContentPreferences,
  type BillContentTypePreference,
  isBillContentTypePreference,
} from "./billContentTypes";
import { mapWithConcurrency } from "./concurrency";
import { normalizeCorrelationId } from "./correlation";
import {
  DISPATCH_MARKER_VERSION_ATTRIBUTE,
  dispatchShardPartitionValue,
  LEGACY_DISPATCH_PARTITION_VALUE,
  parseDispatchShardCount,
} from "./dispatchShards";
import { logger } from "./logger";
import { emitEmbeddedMetric } from "./metrics";
import { isOutcomePushType, type OutcomePushType } from "./pushAudience";
import { backoffDelayMs, sleep } from "./retry";

/**
 * Pending notification writes shared by userMatcher (inline fallback) and notificationFanout
 * (CAP-02). One write is a three-item transaction on the pending notifications table:
 *
 *   1. dedupe marker   (`__dedupe__`, "<user>||<bill>||<type>[||<revision>]"), conditional, 3-day TTL
 *   2. pending row     (<userId>, "<billId>#<type>"), 24-hour TTL, read by userNotifier; it carries the bill's first
 *                      topic (`subCategory`) and, for an alert, passed or failed, the action (`actionText`,
 *                      `actionDate`, `actionCode`, `actionType`) the push names (S4)
 *   3. dispatch marker (`__dispatch__#<shard>`, <userId>), 26-hour TTL, read by notificationDispatcher;
 *      each write sets a new random `markerVersion`, which userNotifier's conditional delete checks
 *   4. only for a companion pair member's "new" (APPF-23): the other member's "new" dedupe marker,
 *      conditional (unless another deferral left it), 3-day TTL (see writePendingNotification)
 *   5. only for a "passed" or "failed" whose stored version also added an action, for a user the action push reaches
 *      (UX-33, `pairedAlert`): that action's dedupe marker and its pending row (<userId>, "<billId>#alert"), marked
 *      `pairedOutcome`, so the two rows of one change are always written, held and sent together
 *
 * A failed dedupe condition means this user was already notified for this bill revision, so the
 * write is a no-op; that is what makes SQS redelivery and fan-out retries safe.
 */

export const NOTIFICATION_TYPES: readonly NotificationType[] = ["new", "updated", "alert", "passed", "failed"];

const HOUR_SECONDS = 3600;
/**
 * Project decision D1 (2026-10-07): a push is still worth sending up to 24 hours late. While a pending
 * row and its user's dispatch marker exist, notificationDispatcher hands the user to userNotifier
 * again every 15 minutes, so a delivery outage shorter than this heals on its own and the pushes
 * arrive late instead of being lost (it was 1 hour, less than the hour a failing userNotifierQueue
 * message takes to reach its DLQ).
 */
export const PENDING_ROW_TTL_SECONDS = 24 * HOUR_SECONDS;
/**
 * At least the row's lifetime plus a margin: the marker is what makes the dispatcher look at the user,
 * so a marker that expired before its rows would leave them never sent. Both are written in one
 * transaction; TTL deletion is lazy and unordered, hence the 2-hour margin.
 */
export const DISPATCH_MARKER_TTL_SECONDS = 26 * HOUR_SECONDS;
/**
 * At least the row's lifetime, so a redelivered or redriven write cannot add a second pending row for
 * a notification the user still has pending or already got.
 */
export const DEDUPE_TTL_SECONDS = 3 * 24 * HOUR_SECONDS;

/**
 * C1.3 (decision D1): whether a pending row is past its lifetime at `nowSeconds`. The row's own `ttl`
 * decides (expired once `ttl <= nowSeconds`); a row without a usable `ttl` falls back to
 * `createdAt + PENDING_ROW_TTL_SECONDS`; a row with neither is never expired. All three are epoch
 * seconds, as writePendingNotification writes the row. A row value in milliseconds reads as far in the
 * future, so it is kept; a `nowSeconds` in milliseconds would expire every row, which is why
 * userNotifier's cutoff starts in watch mode (X6) and is tested against this writer's own rows.
 */
export const isPendingRowExpired = (row: { ttl?: number; createdAt?: number }, nowSeconds: number): boolean => {
  if (typeof row.ttl === "number" && Number.isFinite(row.ttl)) return row.ttl <= nowSeconds;
  if (typeof row.createdAt === "number" && Number.isFinite(row.createdAt)) {
    return row.createdAt + PENDING_ROW_TTL_SECONDS <= nowSeconds;
  }
  return false;
};

const MAX_TRANSACTION_CONFLICT_ATTEMPTS = 4;
// The companion "new" marker's place in the transaction (after dedupe, pending row, dispatch marker).
const COMPANION_NEW_ITEM_INDEX = 3;
// Set only on a companion "new" marker a deferral wrote, never on a "new"'s own dedupe marker.
const REACHED_BY_ATTRIBUTE = "reachedByBillId";
const NOTIFICATIONS_METRIC_NAMESPACE = "BillBoard/Notifications";

export interface PendingNotificationStoreConfig {
  tableName: string;
  partitionKey: string;
  sortKey: string;
  dispatchPartitionKey: string;
  dispatchSortKey: string;
  /** The unsharded base value; markers are written under `<value>#<shard>`. */
  dispatchPartitionValue: string;
  dispatchShardCount: number;
  dedupePartitionValue: string;
}

/** Reads the store settings userMatcher and notificationFanout share from their environment. */
export const pendingNotificationStoreConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): PendingNotificationStoreConfig => {
  const partitionKey = env.PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY ?? "";
  const sortKey = env.PENDING_NOTIFICATIONS_TABLE_SORT_KEY ?? "";
  return {
    tableName: env.PENDING_NOTIFICATIONS_TABLE ?? "",
    partitionKey,
    sortKey,
    dispatchPartitionKey: env.DISPATCH_PARTITION_KEY ?? partitionKey,
    dispatchSortKey: env.DISPATCH_SORT_KEY ?? sortKey,
    dispatchPartitionValue: env.DISPATCH_PARTITION_VALUE ?? LEGACY_DISPATCH_PARTITION_VALUE,
    dispatchShardCount: parseDispatchShardCount(env.DISPATCH_SHARD_COUNT),
    dedupePartitionValue: env.DEDUPE_PARTITION_VALUE ?? "__dedupe__",
  };
};

/** A positive whole-number env value, clamped to [1, max]; the default when unset or invalid. */
export const parseBoundedPositiveInt = (raw: string | undefined, fallback: number, max: number): number => {
  const value = Number(raw);
  if (typeof raw !== "string" || raw.trim().length === 0 || !Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
};

/**
 * APPF-23: the other member's "new" that a companion pair member's "new" defers to: its bill and the
 * revision it was sent with, which together give that "new"'s dedupe marker for each user.
 */
export interface CompanionNewRef {
  billId: string;
  sourceRevision: string;
}

/**
 * S4 (feature review 2026-10-28): the Congress action an "alert", "passed" or "failed" is about, as notificationType
 * found it (the newest new action, or the passage or failure action), carried on the pending row so the push can say
 * what happened ("Passed the House · Oct 27") instead of a fixed line.
 */
export interface PendingNotificationAction {
  /** Congress's text for the action (at most 512 characters). */
  text: string;
  /** The action's date as Congress gives it ("2026-10-27"). */
  actionDate?: string;
  actionCode?: string;
  actionType?: string;
}

const MAX_ACTION_TEXT_LENGTH = 512;
const MAX_ACTION_FIELD_LENGTH = 64;
const MAX_SUB_CATEGORY_LENGTH = 128;

const boundedString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

/** A well-formed action from a message or row (non-empty text; other fields optional and bounded), or undefined. */
export const parsePendingNotificationAction = (value: unknown): PendingNotificationAction | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const text = boundedString(candidate.text, MAX_ACTION_TEXT_LENGTH);
  if (!text) return undefined;
  const actionDate = boundedString(candidate.actionDate, MAX_ACTION_FIELD_LENGTH);
  const actionCode = boundedString(candidate.actionCode, MAX_ACTION_FIELD_LENGTH);
  const actionType = boundedString(candidate.actionType, MAX_ACTION_FIELD_LENGTH);
  return {
    text,
    ...(actionDate ? { actionDate } : {}),
    ...(actionCode ? { actionCode } : {}),
    ...(actionType ? { actionType } : {}),
  };
};

/** A bill topic name from a message or row (non-empty, bounded), or undefined. */
export const parsePendingNotificationSubCategory = (value: unknown): string | undefined =>
  boundedString(value, MAX_SUB_CATEGORY_LENGTH);

/**
 * UX-33 (project decision 2026-10-29, "one event, per phone"): the action row written beside a "passed" or "failed" row
 * when the same stored version also added that action, for a user the action push reaches. The two rows go in one
 * transaction, so a dispatch sees both or neither, and they are held, folded and paced together. The action row is a
 * plain "alert" row ("<billId>#alert", the action and its category as an alert row has them) marked `pairedOutcome`
 * with the outcome's type: userNotifier sends it only to a device that does not take that outcome's pushes, and the
 * outcome row to the devices that do, so each device gets one push for the change. A UserNotifier older than UX-33
 * reads it as an alert row and folds the two into the one push it sends a device for one bill.
 */
export interface PendingPairedAlert {
  /** The action row's `category`: "Bill Alert", or "Priority Bill" for a bill in the news, as for an alert row. */
  category: string;
  /** The action (the version's newest new action), when the message named one. */
  action?: PendingNotificationAction;
}

/** A paired action from a message (a non-empty category; a malformed action is left out), or undefined. */
export const parsePendingPairedAlert = (value: unknown): PendingPairedAlert | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const category = boundedString(candidate.category, MAX_SUB_CATEGORY_LENGTH);
  if (!category) return undefined;
  const action = parsePendingNotificationAction(candidate.action);
  return { category, ...(action ? { action } : {}) };
};

/**
 * The outcome types a paired action row is written beside (and names in `pairedOutcome`): the outcome push types of
 * shared/pushAudience.ts, so a new outcome joins the pairing there.
 */
export const isPairedOutcomeType = (value: unknown): value is OutcomePushType => isOutcomePushType(value);

/** UX-33: a summary change's time from a message or row (a positive whole number of epoch ms), or undefined. */
export const parsePendingNotificationChangedAtMs = (value: unknown): number | undefined => {
  const ms = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
  return typeof ms === "number" && Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
};

export interface PendingNotificationItem {
  userId: string;
  billId: string;
  billTitle: string;
  category: string;
  lifeArea: string;
  /** The bill's first topic under its current name ("Medical Costs"), for the push payload's `subCategory`. */
  subCategory?: string;
  /** Only on an "alert", "passed" or "failed": the action it is about. */
  action?: PendingNotificationAction;
  notificationType: NotificationType;
  sourceRevision?: string;
  /** The bill's pipeline trace id; kept on the pending row so userNotifier can log it (OBS-10). */
  correlationId?: string;
  /**
   * UX-33, only on an "updated": when the version with the new summary was stored (epoch ms), kept on the row as
   * `changedAtMs`. userNotifier drops the "vote again" push when the user's vote is newer.
   */
  changedAtMs?: number;
  /** Only on a "new": the companion's "new" this one defers to (see writePendingNotification). */
  companionNew?: CompanionNewRef;
  /**
   * UX-33, only on a "passed" or "failed": the action the same stored version added, written as this user's action row
   * in the same transaction (see PendingPairedAlert).
   */
  pairedAlert?: PendingPairedAlert;
}

export const buildPendingNotificationSortKey = (billId: string, notificationType: NotificationType): string =>
  `${billId}#${notificationType}`;

// Keyed on the bill revision so a redelivery is suppressed but a later update to the same bill notifies again.
export const buildNotificationDedupeKey = (
  item: Pick<PendingNotificationItem, "userId" | "billId" | "notificationType" | "sourceRevision">,
): string =>
  item.sourceRevision
    ? `${item.userId}||${item.billId}||${item.notificationType}||${item.sourceRevision}`
    : `${item.userId}||${item.billId}||${item.notificationType}`;

/** Per-invocation key that stops two records of one batch from writing the same notification. */
export const buildAggregatedNotificationKey = (
  billId: string,
  userId: string,
  notificationType: NotificationType,
  sourceRevision?: string,
): string =>
  sourceRevision
    ? `${billId}||${userId}||${notificationType}||${sourceRevision}`
    : `${billId}||${userId}||${notificationType}`;

const transactionCancellationCodes = (error: unknown): string[] => {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: unknown }> } | null)?.CancellationReasons;
  if (Array.isArray(reasons)) {
    return reasons.map((reason) => (typeof reason?.Code === "string" ? reason.Code : "None"));
  }
  return [];
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The dedupe condition failed: this notification was already written. */
export const isDuplicateNotificationError = (error: unknown): boolean =>
  transactionCancellationCodes(error).includes("ConditionalCheckFailed") ||
  errorMessage(error).includes("ConditionalCheckFailed");

// Two transactions touching the same user's dispatch marker at once cancel one of them; retrying is safe.
const isTransactionConflict = (error: unknown): boolean =>
  transactionCancellationCodes(error).includes("TransactionConflict") ||
  errorMessage(error).includes("TransactionConflict");

/**
 * The pending row's action attributes (`actionText`, `actionDate`, `actionCode`, `actionType`), each only when set.
 * A later row for the same bill and type replaces the whole row, so the push names the newest action.
 */
const pendingRowActionAttributes = (action: PendingNotificationAction | undefined): Record<string, { S: string }> =>
  action
    ? {
        actionText: { S: action.text },
        ...(action.actionDate ? { actionDate: { S: action.actionDate } } : {}),
        ...(action.actionCode ? { actionCode: { S: action.actionCode } } : {}),
        ...(action.actionType ? { actionType: { S: action.actionType } } : {}),
      }
    : {};

/**
 * UX-33: the paired action's dedupe marker (the one the version's alert message would have written, so a redelivered
 * alert finds it) and its pending row, an alert row marked `pairedOutcome`; see PendingPairedAlert.
 */
const pairedAlertTransactItems = (
  store: PendingNotificationStoreConfig,
  item: PendingNotificationItem,
  pairedAlert: PendingPairedAlert,
  createdAt: number,
) => [
  {
    Put: {
      TableName: store.tableName,
      Item: {
        markerType: { S: "notification-dedupe" },
        targetUserId: { S: item.userId },
        billId: { S: item.billId },
        notificationType: { S: "alert" },
        ...(item.sourceRevision ? { sourceRevision: { S: item.sourceRevision } } : {}),
        createdAt: { N: String(createdAt) },
        ttl: { N: String(createdAt + DEDUPE_TTL_SECONDS) },
        [store.partitionKey]: { S: store.dedupePartitionValue },
        [store.sortKey]: {
          S: buildNotificationDedupeKey({
            userId: item.userId,
            billId: item.billId,
            notificationType: "alert",
            sourceRevision: item.sourceRevision,
          }),
        },
      },
      ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
      ExpressionAttributeNames: { "#pk": store.partitionKey, "#sk": store.sortKey },
    },
  },
  {
    Put: {
      TableName: store.tableName,
      Item: {
        [store.partitionKey]: { S: item.userId },
        [store.sortKey]: { S: buildPendingNotificationSortKey(item.billId, "alert") },
        sourceBillId: { S: item.billId },
        billTitle: { S: item.billTitle },
        category: { S: pairedAlert.category },
        lifeArea: { S: "" },
        ...(item.subCategory ? { subCategory: { S: item.subCategory } } : {}),
        ...pendingRowActionAttributes(pairedAlert.action),
        notificationType: { S: "alert" },
        pairedOutcome: { S: item.notificationType },
        ...(item.correlationId ? { correlationId: { S: item.correlationId } } : {}),
        createdAt: { N: String(createdAt) },
        ttl: { N: String(createdAt + PENDING_ROW_TTL_SECONDS) },
      },
    },
  },
];

/**
 * "written"; "duplicate" when the dedupe marker already exists; "companionReached" when the
 * companion's "new" this "new" defers to already reached the user (its marker exists);
 * "writtenWithoutPairedAlert" when an outcome row was written without its paired action row, because
 * that action's own row for the version was already written (an older userMatcher wrote it from the
 * version's alert message, so the user has it, unmarked, as before UX-33).
 */
export type PendingNotificationWriteResult = "written" | "duplicate" | "companionReached" | "writtenWithoutPairedAlert";

/**
 * Writes the dedupe marker, the pending row and the user's sharded dispatch marker in one
 * transaction. Throws on any failure other than a failed dedupe condition, after retrying
 * transaction conflicts a few times.
 *
 * With `companionNew` (a companion pair member's "new", APPF-23) the transaction also puts the other
 * member's "new" dedupe marker for this user. When that "new" itself wrote it, that "new" already
 * reached the user (within the markers' 3 days) and nothing is written. Otherwise it is created with
 * this "new", so the other member's "new", still in flight or redelivered, skips the user. A marker
 * that a deferral wrote (it names the bill in `reachedByBillId`; the other member's own never does)
 * is no proof: it is left by a bill the other member was paired with before, since only one member
 * of a pair defers. It is overwritten to name this bill. A user is skipped only when the other
 * member's own "new" provably reached them, and gets one "new" for the pair even when both are
 * written at once.
 *
 * With `pairedAlert` (a "passed" or "failed" whose version also added an action, UX-33) the transaction
 * also puts that action's dedupe marker (conditional, as the outcome's) and its pending row, marked
 * `pairedOutcome`, so the user's two rows of one change exist together or not at all. When only the
 * action's marker already exists, an older userMatcher wrote that action's row from the version's
 * alert message: the outcome row is then written alone, as before UX-33 ("writtenWithoutPairedAlert").
 */
export const writePendingNotification = async (
  dynamo: Pick<DynamoDBClient, "send">,
  store: PendingNotificationStoreConfig,
  item: PendingNotificationItem,
): Promise<PendingNotificationWriteResult> => {
  const companionNew = item.notificationType === "new" ? item.companionNew : undefined;
  let pairedAlert = isPairedOutcomeType(item.notificationType) ? item.pairedAlert : undefined;
  let pairedAlertAlreadyWritten = false;
  for (let attempt = 0; ; attempt += 1) {
    const createdAt = Math.floor(Date.now() / 1000);
    // The paired action's marker follows the companion marker, which a "passed" or "failed" never has.
    const pairedAlertDedupeIndex = COMPANION_NEW_ITEM_INDEX + (companionNew ? 1 : 0);
    try {
      await dynamo.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: store.tableName,
                Item: {
                  markerType: { S: "notification-dedupe" },
                  targetUserId: { S: item.userId },
                  billId: { S: item.billId },
                  notificationType: { S: item.notificationType },
                  ...(item.sourceRevision ? { sourceRevision: { S: item.sourceRevision } } : {}),
                  createdAt: { N: String(createdAt) },
                  ttl: { N: String(createdAt + DEDUPE_TTL_SECONDS) },
                  // Key attributes last, so a sort key named "billId" keeps the dedupe key.
                  [store.partitionKey]: { S: store.dedupePartitionValue },
                  [store.sortKey]: { S: buildNotificationDedupeKey(item) },
                },
                ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
                ExpressionAttributeNames: {
                  "#pk": store.partitionKey,
                  "#sk": store.sortKey,
                },
              },
            },
            {
              Put: {
                TableName: store.tableName,
                Item: {
                  [store.partitionKey]: { S: item.userId },
                  [store.sortKey]: { S: buildPendingNotificationSortKey(item.billId, item.notificationType) },
                  sourceBillId: { S: item.billId },
                  billTitle: { S: item.billTitle },
                  category: { S: item.category },
                  lifeArea: { S: item.lifeArea },
                  ...(item.subCategory ? { subCategory: { S: item.subCategory } } : {}),
                  ...pendingRowActionAttributes(item.action),
                  notificationType: { S: item.notificationType },
                  ...(item.correlationId ? { correlationId: { S: item.correlationId } } : {}),
                  ...(item.changedAtMs !== undefined ? { changedAtMs: { N: String(item.changedAtMs) } } : {}),
                  createdAt: { N: String(createdAt) },
                  ttl: { N: String(createdAt + PENDING_ROW_TTL_SECONDS) },
                },
              },
            },
            {
              Put: {
                TableName: store.tableName,
                Item: {
                  [store.dispatchPartitionKey]: {
                    S: dispatchShardPartitionValue(store.dispatchPartitionValue, item.userId, store.dispatchShardCount),
                  },
                  [store.dispatchSortKey]: { S: item.userId },
                  markerType: { S: "pending-user" },
                  targetUserId: { S: item.userId },
                  [DISPATCH_MARKER_VERSION_ATTRIBUTE]: { S: randomUUID() },
                  updatedAtEpoch: { N: String(createdAt) },
                  ttl: { N: String(createdAt + DISPATCH_MARKER_TTL_SECONDS) },
                },
              },
            },
            ...(companionNew
              ? [
                  {
                    Put: {
                      TableName: store.tableName,
                      Item: {
                        markerType: { S: "notification-dedupe" },
                        targetUserId: { S: item.userId },
                        billId: { S: companionNew.billId },
                        notificationType: { S: "new" },
                        sourceRevision: { S: companionNew.sourceRevision },
                        // The pair's "new" this user got instead; only a deferral's marker carries it.
                        [REACHED_BY_ATTRIBUTE]: { S: item.billId },
                        createdAt: { N: String(createdAt) },
                        ttl: { N: String(createdAt + DEDUPE_TTL_SECONDS) },
                        [store.partitionKey]: { S: store.dedupePartitionValue },
                        [store.sortKey]: {
                          S: buildNotificationDedupeKey({
                            userId: item.userId,
                            billId: companionNew.billId,
                            notificationType: "new",
                            sourceRevision: companionNew.sourceRevision,
                          }),
                        },
                      },
                      // Fails only on the other member's own marker (see above).
                      ConditionExpression: "attribute_not_exists(#sk) OR attribute_exists(#reachedBy)",
                      ExpressionAttributeNames: {
                        "#sk": store.sortKey,
                        "#reachedBy": REACHED_BY_ATTRIBUTE,
                      },
                    },
                  },
                ]
              : []),
            ...(pairedAlert ? pairedAlertTransactItems(store, item, pairedAlert, createdAt) : []),
          ],
        }),
      );
      return pairedAlertAlreadyWritten ? "writtenWithoutPairedAlert" : "written";
    } catch (error) {
      if (isDuplicateNotificationError(error)) {
        const codes = transactionCancellationCodes(error);
        if (
          pairedAlert &&
          codes[0] !== "ConditionalCheckFailed" &&
          codes[pairedAlertDedupeIndex] === "ConditionalCheckFailed"
        ) {
          // Not a retry of this write (the outcome's marker is new): the action's own row for this version is already
          // there, or was sent. Write the outcome row alone.
          pairedAlert = undefined;
          pairedAlertAlreadyWritten = true;
          attempt -= 1;
          continue;
        }
        return companionNew &&
          codes[0] !== "ConditionalCheckFailed" &&
          codes[COMPANION_NEW_ITEM_INDEX] === "ConditionalCheckFailed"
          ? "companionReached"
          : "duplicate";
      }
      if (isTransactionConflict(error) && attempt + 1 < MAX_TRANSACTION_CONFLICT_ATTEMPTS) {
        await sleep(backoffDelayMs(attempt, { baseMs: 25, maxMs: 200 }));
        continue;
      }
      throw error;
    }
  }
};

// ─── Content-type preferences ─────────────────────────────────────────────────

/** What the content filter needs from UserPreferencesDao. */
export interface UserPreferencesReader {
  getUserPreferences(userId: string): Promise<Record<string, AttributeValue>[]>;
}

export type UserContentTypePreferenceCache = Map<string, ReadonlySet<BillContentTypePreference> | null>;

const attributeValueToString = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const attr = value as { S?: unknown; N?: unknown };
  if (typeof attr.S === "string") return attr.S;
  if (typeof attr.N === "string") return attr.N;
  return null;
};

/** The user's "Content Type" preferences, or null when none are set (null allows every bill type). */
export const loadUserContentTypePreferences = async (
  preferences: UserPreferencesReader,
  subCategoryAttribute: string,
  userId: string,
  cache: UserContentTypePreferenceCache,
): Promise<ReadonlySet<BillContentTypePreference> | null> => {
  if (cache.has(userId)) {
    return cache.get(userId) ?? null;
  }

  const items = await preferences.getUserPreferences(userId);
  const selected = new Set<BillContentTypePreference>();

  for (const item of items) {
    const type = attributeValueToString(item.type)?.trim().toLowerCase();
    if (type !== "content type") {
      continue;
    }

    const preference = (
      attributeValueToString(item.preference) ??
      attributeValueToString(item[subCategoryAttribute]) ??
      attributeValueToString(item.sort_key)
    )
      ?.trim()
      .toLowerCase();
    if (isBillContentTypePreference(preference)) {
      selected.add(preference);
    }
  }

  const result = selected.size > 0 ? selected : null;
  cache.set(userId, result);
  return result;
};

export const userAllowsBillType = async (
  preferences: UserPreferencesReader,
  subCategoryAttribute: string,
  userId: string,
  rawBillType: string | null,
  cache: UserContentTypePreferenceCache,
): Promise<boolean> => {
  const allowedContentTypes = await loadUserContentTypePreferences(preferences, subCategoryAttribute, userId, cache);
  return billTypeMatchesContentPreferences(rawBillType, allowedContentTypes);
};

// ─── Writing one bill's notification for many users ───────────────────────────

/** Everything a pending-notification write needs apart from the user. */
export interface NotificationDelivery {
  billId: string;
  billTitle: string;
  category: string;
  lifeArea: string;
  /** The bill's first topic under its current name, when it has one. */
  subCategory?: string;
  /** Only on an "alert", "passed" or "failed": the action it is about. */
  action?: PendingNotificationAction;
  notificationType: NotificationType;
  sourceRevision?: string;
  correlationId?: string;
  /**
   * A bill "in the news" (an active BillPriority record). Since UX-33 it no longer skips the content-type filter (every
   * push respects the bill types the user chose, but for the bill's own voters and watchers); it is kept for the logs
   * and for a NotificationFanout older than UX-33, which still skips the filter when it is true.
   */
  isPriorityBill: boolean;
  /** The bill's raw type (e.g. "house-bill", "hjres") for the content-type filter. */
  rawBillType: string | null;
  /**
   * UX-33: these users are the bill's own voters and watchers (and its companion's), who are never filtered by the bill
   * types they chose, in or out of the news (project decision 2026-10-29). A NotificationFanout older than UX-33 ignores
   * it and filters them as before (but for a bill in the news, which it sends every user unfiltered).
   */
  skipBillTypeFilter?: boolean;
  /** UX-33, only on an "updated": when the version with the new summary was stored (epoch ms). */
  changedAtMs?: number;
  /** Only on a "new" of a companion pair member: the other member's "new" it defers to. */
  companionNew?: CompanionNewRef;
  /**
   * UX-33, only on a "passed" or "failed" whose version also added an action, for users that action's push reaches:
   * each gets the action's row beside the outcome's, in one write (PendingPairedAlert). A NotificationFanout older
   * than UX-33 ignores it and writes the outcome row alone.
   */
  pairedAlert?: PendingPairedAlert;
}

export interface PendingNotificationWriterDeps {
  dynamo: Pick<DynamoDBClient, "send">;
  store: PendingNotificationStoreConfig;
  preferences: UserPreferencesReader;
  subCategoryAttribute: string;
  contentTypeCache: UserContentTypePreferenceCache;
}

export interface DeliveryOutcome {
  written: number;
  duplicates: number;
  filtered: number;
  /** Users skipped because the companion's "new" this one defers to already reached them. */
  companionReached: number;
  /** UX-33: users given the paired action's row beside the outcome's (`pairedAlert`), of those written. */
  pairedActionRows: number;
}

/**
 * For each user, with at most `concurrency` users in flight: skips the user when the bill's type is
 * outside their content-type preferences, then writes the pending notification. A duplicate is a
 * no-op. The first other failure is rethrown once the writes in flight settle, and no further users
 * are started. Users a companion's "new" already reached are counted in the metric
 * `CompanionNewSuppressed`.
 *
 * UX-33: the filter applies to every bill. A bill "in the news" skipped it before, so a user who had
 * turned off a bill type still got that type's pushes while it was in the news, although both apps
 * say the bill types also choose the notifications (1.1 "Controls which bill types appear in Home and
 * which bill notifications you can receive.", 1.2 "Choose which kinds of bills appear on the Bills tab
 * and in notifications."). Only a delivery to the bill's own voters and watchers skips it
 * (`skipBillTypeFilter`), in or out of the news (project decision 2026-10-29): their vote or watch is on
 * that bill, whatever its type.
 */
export const writePendingNotificationsForUsers = async (
  deps: PendingNotificationWriterDeps,
  delivery: NotificationDelivery,
  userIds: readonly string[],
  options: { concurrency: number },
): Promise<DeliveryOutcome> => {
  const outcome: DeliveryOutcome = { written: 0, duplicates: 0, filtered: 0, companionReached: 0, pairedActionRows: 0 };
  const { billId, notificationType } = delivery;

  await mapWithConcurrency(userIds, options.concurrency, async (userId) => {
    if (
      delivery.skipBillTypeFilter !== true &&
      !(await userAllowsBillType(
        deps.preferences,
        deps.subCategoryAttribute,
        userId,
        delivery.rawBillType,
        deps.contentTypeCache,
      ))
    ) {
      logger.info("Skipping user due to bill content filter", {
        billId,
        userId,
        billType: delivery.rawBillType,
        notificationType,
      });
      outcome.filtered += 1;
      return;
    }

    const result = await writePendingNotification(deps.dynamo, deps.store, {
      userId,
      billId,
      billTitle: delivery.billTitle,
      category: delivery.category,
      lifeArea: delivery.lifeArea,
      ...(delivery.subCategory ? { subCategory: delivery.subCategory } : {}),
      ...(delivery.action ? { action: delivery.action } : {}),
      notificationType,
      sourceRevision: delivery.sourceRevision,
      correlationId: delivery.correlationId,
      ...(delivery.changedAtMs !== undefined ? { changedAtMs: delivery.changedAtMs } : {}),
      ...(delivery.companionNew ? { companionNew: delivery.companionNew } : {}),
      ...(delivery.pairedAlert ? { pairedAlert: delivery.pairedAlert } : {}),
    });
    if (result === "duplicate") {
      logger.info("Skipping duplicate pending notification", { billId, userId, notificationType });
      outcome.duplicates += 1;
      return;
    }
    if (result === "companionReached") {
      logger.info("Skipping user; its companion bill's new notification reached them", {
        billId,
        userId,
        companionGuid: delivery.companionNew?.billId,
      });
      outcome.companionReached += 1;
      return;
    }
    if (result === "writtenWithoutPairedAlert") {
      logger.info("Wrote the outcome row alone; the change's action row was already written for the user", {
        billId,
        userId,
        notificationType,
      });
    } else if (delivery.pairedAlert && isPairedOutcomeType(notificationType)) {
      outcome.pairedActionRows += 1;
    }
    logger.info("Wrote pending notification", { billId, userId, notificationType });
    outcome.written += 1;
  });

  if (outcome.companionReached > 0) {
    emitEmbeddedMetric(NOTIFICATIONS_METRIC_NAMESPACE, "CompanionNewSuppressed", outcome.companionReached);
  }
  return outcome;
};

// ─── Fan-out message (userMatcher -> notificationFanout) ──────────────────────

export const NOTIFICATION_FANOUT_MESSAGE_VERSION = 1;
export const DEFAULT_FANOUT_USERS_PER_MESSAGE = 100;
export const MAX_FANOUT_USERS_PER_MESSAGE = 500;

export interface NotificationFanoutMessage extends NotificationDelivery {
  version: typeof NOTIFICATION_FANOUT_MESSAGE_VERSION;
  userIds: string[];
}

export const buildNotificationFanoutMessage = (
  delivery: NotificationDelivery,
  userIds: readonly string[],
): NotificationFanoutMessage => ({
  version: NOTIFICATION_FANOUT_MESSAGE_VERSION,
  billId: delivery.billId,
  billTitle: delivery.billTitle,
  category: delivery.category,
  lifeArea: delivery.lifeArea,
  // S4, optional and additive: a NotificationFanout that predates them ignores both, as version 1 allows.
  ...(delivery.subCategory ? { subCategory: delivery.subCategory } : {}),
  ...(delivery.action ? { action: { ...delivery.action } } : {}),
  notificationType: delivery.notificationType,
  ...(delivery.sourceRevision ? { sourceRevision: delivery.sourceRevision } : {}),
  ...(delivery.correlationId ? { correlationId: delivery.correlationId } : {}),
  isPriorityBill: delivery.isPriorityBill,
  rawBillType: delivery.rawBillType,
  // UX-33, optional and additive like the S4 fields.
  ...(delivery.skipBillTypeFilter === true ? { skipBillTypeFilter: true } : {}),
  ...(delivery.changedAtMs !== undefined ? { changedAtMs: delivery.changedAtMs } : {}),
  ...(delivery.companionNew
    ? { companionNew: { billId: delivery.companionNew.billId, sourceRevision: delivery.companionNew.sourceRevision } }
    : {}),
  ...(delivery.pairedAlert && isPairedOutcomeType(delivery.notificationType)
    ? {
        pairedAlert: {
          category: delivery.pairedAlert.category,
          ...(delivery.pairedAlert.action ? { action: { ...delivery.pairedAlert.action } } : {}),
        },
      }
    : {}),
  userIds: [...userIds],
});

/** Splits users into consecutive groups of at most `size`. */
export const chunkUserIds = (userIds: readonly string[], size: number): string[][] => {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += chunkSize) {
    chunks.push(userIds.slice(i, i + chunkSize));
  }
  return chunks;
};

export type ParsedNotificationFanoutMessage =
  | { ok: true; message: NotificationFanoutMessage }
  /** `retryable`: a newer message version this code cannot read (for example after a rollback); keep it for the DLQ. */
  | { ok: false; reason: string; retryable: boolean };

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// Optional: a message without it, or with a malformed one, is written as an ungrouped bill's "new".
const parseCompanionNewRef = (value: unknown): CompanionNewRef | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { billId, sourceRevision } = value as Record<string, unknown>;
  return nonEmptyString(billId) && nonEmptyString(sourceRevision)
    ? { billId: billId.trim(), sourceRevision: sourceRevision.trim() }
    : undefined;
};

export const parseNotificationFanoutMessage = (body: string | undefined | null): ParsedNotificationFanoutMessage => {
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    return { ok: false, reason: "body is not JSON", retryable: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "body is not an object", retryable: false };
  }
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.version !== "number" || !Number.isInteger(candidate.version) || candidate.version < 1) {
    return { ok: false, reason: "missing or invalid version", retryable: false };
  }
  if (candidate.version > NOTIFICATION_FANOUT_MESSAGE_VERSION) {
    return { ok: false, reason: `unsupported message version ${candidate.version}`, retryable: true };
  }
  if (!nonEmptyString(candidate.billId) || !nonEmptyString(candidate.billTitle)) {
    return { ok: false, reason: "missing billId or billTitle", retryable: false };
  }
  if (!NOTIFICATION_TYPES.includes(candidate.notificationType as NotificationType)) {
    return { ok: false, reason: "missing or invalid notificationType", retryable: false };
  }
  if (!Array.isArray(candidate.userIds)) {
    return { ok: false, reason: "missing userIds", retryable: false };
  }
  const userIds = Array.from(new Set(candidate.userIds.filter(nonEmptyString)));
  if (userIds.length === 0) {
    return { ok: false, reason: "no valid userIds", retryable: false };
  }

  const sourceRevision = nonEmptyString(candidate.sourceRevision) ? candidate.sourceRevision.trim() : undefined;
  const correlationId = normalizeCorrelationId(candidate.correlationId);
  const companionNew = parseCompanionNewRef(candidate.companionNew);
  // Optional: a message without them, or with malformed ones, is written without them (the push then uses its
  // fallback wording).
  const subCategory = parsePendingNotificationSubCategory(candidate.subCategory);
  const action = parsePendingNotificationAction(candidate.action);
  const changedAtMs = parsePendingNotificationChangedAtMs(candidate.changedAtMs);
  const pairedAlert = isPairedOutcomeType(candidate.notificationType)
    ? parsePendingPairedAlert(candidate.pairedAlert)
    : undefined;
  return {
    ok: true,
    message: {
      version: NOTIFICATION_FANOUT_MESSAGE_VERSION,
      billId: candidate.billId,
      billTitle: candidate.billTitle,
      category: typeof candidate.category === "string" ? candidate.category : "General",
      lifeArea: typeof candidate.lifeArea === "string" ? candidate.lifeArea : "",
      ...(subCategory ? { subCategory } : {}),
      ...(action ? { action } : {}),
      notificationType: candidate.notificationType as NotificationType,
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(correlationId ? { correlationId } : {}),
      isPriorityBill: candidate.isPriorityBill === true,
      rawBillType: nonEmptyString(candidate.rawBillType) ? candidate.rawBillType : null,
      ...(candidate.skipBillTypeFilter === true ? { skipBillTypeFilter: true } : {}),
      ...(changedAtMs !== undefined ? { changedAtMs } : {}),
      ...(companionNew ? { companionNew } : {}),
      ...(pairedAlert ? { pairedAlert } : {}),
      userIds,
    },
  };
};
