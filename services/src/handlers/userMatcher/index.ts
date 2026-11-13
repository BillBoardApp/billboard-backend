import { S3Client } from "@aws-sdk/client-s3";
import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { BillCompanionDao, type CompanionGroupsState } from "../../adapters/billCompanionDao";
import { BillStorage } from "../../adapters/billStorage";
import { buildProcessedBillRootGuidKey, ProcessedBillDao } from "../../adapters/processedBillDao";
import { UserPreferencesDao } from "../../adapters/userPreferencesDao";
import { BillPriorityDao } from "../../adapters/billPriorityDao";
import {
  BillCategoryReference,
  BILL_SUBCATEGORY_TO_CATEGORY,
  canonicalSubCategory,
  isAcceptedSubCategoryName,
  isBillCategoryName,
  subCategoryNameVariants,
} from "../../models/categories";
import { isLifeAreaName } from "../../models/lifeAreas";
import { BillDocument, ProcessedBillDocument } from "../../models/bill";
import type { NotificationType, NotificationTypeMessage } from "../../models/notifications";
import {
  chamberOf,
  companionIndex,
  parseBillGuid,
  plainBillGuid,
  toCompanionGroupV1,
  type CompanionIndex,
} from "../../shared/billCompanions";
import { isPriorityRecordActive } from "../../shared/billPriority";
import { isCommemorativeResolution } from "../../shared/commemorativeResolutions";
import { correlationIdFromRecord, correlationIdMessageAttributes, mintCorrelationId } from "../../shared/correlation";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";
import {
  buildAggregatedNotificationKey,
  buildNotificationFanoutMessage,
  chunkUserIds,
  type CompanionNewRef,
  DEFAULT_FANOUT_USERS_PER_MESSAGE,
  MAX_FANOUT_USERS_PER_MESSAGE,
  type NotificationDelivery,
  parseBoundedPositiveInt,
  parsePendingNotificationAction,
  type PendingNotificationAction,
  type PendingPairedAlert,
  pendingNotificationStoreConfigFromEnv,
  type UserContentTypePreferenceCache,
  writePendingNotificationsForUsers,
} from "../../shared/pendingNotifications";
import {
  isOutcomePushType,
  outcomeCoversAlert,
  type OutcomePushType,
  type PushAudienceSource,
  pushAudienceSources,
} from "../../shared/pushAudience";
import { sendMessageBatchWithRetry } from "../../shared/sqsSendWithRetry";
import { reportUnprocessableMessage } from "../../shared/unprocessableMessages";

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
let sqs: SQSClient | undefined;

// Table names, key names, the dispatch marker partition and DISPATCH_SHARD_COUNT (shared/dispatchShards.ts).
const PENDING_NOTIFICATIONS_STORE = pendingNotificationStoreConfigFromEnv();
const BUCKET_NAME = process.env.BUCKET_NAME!;
const PREFERENCE_TABLE = process.env.PREFERENCE_TABLE!;
const PREFERENCE_INDEX = process.env.PREFERENCE_INDEX!;
const USER_ID_ATTRIBUTE = process.env.USER_ID_ATTRIBUTE!;
const SUB_CATEGORY_ATTRIBUTE = process.env.SUB_CATEGORY_ATTRIBUTE!;
const PII_TABLE_NAME = process.env.PII_TABLE_NAME;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? "userId";
const PRIORITY_TABLE_NAME = process.env.PRIORITY_TABLE_NAME;
const PRIORITY_TABLE_PARTITION_KEY = process.env.PRIORITY_TABLE_PARTITION_KEY ?? "guid";
// CAP-02: when set, matched users are sent in chunks to notificationFanout, which does the writes.
// When unset, the writes happen here with bounded concurrency.
const NOTIFICATION_FANOUT_QUEUE_URL = process.env.NOTIFICATION_FANOUT_QUEUE_URL?.trim() || undefined;
const FANOUT_USERS_PER_MESSAGE = parseBoundedPositiveInt(
  process.env.NOTIFICATION_FANOUT_USERS_PER_MESSAGE,
  DEFAULT_FANOUT_USERS_PER_MESSAGE,
  MAX_FANOUT_USERS_PER_MESSAGE,
);
const INLINE_WRITE_CONCURRENCY = parseBoundedPositiveInt(process.env.NOTIFICATION_WRITE_CONCURRENCY, 8, 32);

const preferencesDao = new UserPreferencesDao(dynamo, {
  tableName: PREFERENCE_TABLE,
  subCategoryIndexName: PREFERENCE_INDEX,
  userIdAttribute: USER_ID_ATTRIBUTE,
  subCategoryAttribute: SUB_CATEGORY_ATTRIBUTE,
});
const priorityDao = PRIORITY_TABLE_NAME
  ? new BillPriorityDao(dynamo, {
      tableName: PRIORITY_TABLE_NAME,
      partitionKey: PRIORITY_TABLE_PARTITION_KEY,
    })
  : null;

// APPF-23 companion groups, once PublishBillsManifest publishes them enabled (the CURRENT row, read at
// most every 60 s; they need MANIFEST_TABLE_NAME). "passed", "failed" and "alert" also reach the
// watchers of the other members, and a user the pair's first "new" reached is not sent the other.
// With no groups, or when they cannot be read, every bill is handled on its own as before.
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME?.trim();
const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";
const companionDao = MANIFEST_TABLE_NAME ? new BillCompanionDao(dynamo) : null;
const billStorage = new BillStorage(s3, BUCKET_NAME);
// How long a pair's "new" deferral claim is kept: longer than any redelivery of either member's "new".
const COMPANION_NEW_CLAIM_TTL_SECONDS = 86400 * 30;
let companionIndexFor: { state: CompanionGroupsState; index: CompanionIndex } | undefined;

type ChangeInfo = {
  guid?: string;
  notificationType: NotificationType;
  sourceRevision?: string;
  correlationId?: string;
  /** S4: the action an "alert", "passed" or "failed" is about, from notificationType's message. */
  action?: PendingNotificationAction;
  /** UX-33, only on an "updated": when the version with the new summary was stored (epoch ms). */
  changedAtMs?: number;
};

// notificationType stamps each message with the processed bill's S3 version id (or a content hash).
// Messages queued before that change carry none and fall back to the old dedupe key.
type RevisionedNotificationTypeMessage = NotificationTypeMessage & { sourceRevision?: string };

const MAX_SOURCE_REVISION_LENGTH = 256;

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const unwrapSns = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  const candidate = value as { Message?: unknown };
  if (typeof candidate.Message === "string") {
    const parsed = parseJson(candidate.Message);
    return parsed ?? value;
  }
  return value;
};

/** The fields isNotificationTypeMessage checks, before they are known to be valid. */
type UncheckedNotificationTypeMessage = {
  domain?: unknown;
  objectId?: unknown;
  notificationType?: unknown;
  alert?: { text?: unknown } | null;
};

const isNotificationTypeMessage = (value: unknown): value is NotificationTypeMessage => {
  if (!value || typeof value !== "object") return false;
  const v = value as UncheckedNotificationTypeMessage;
  if (v.domain !== "bill" || typeof v.objectId !== "string") return false;
  const okType =
    v.notificationType === "new" ||
    v.notificationType === "updated" ||
    v.notificationType === "alert" ||
    v.notificationType === "passed" ||
    v.notificationType === "failed";
  if (!okType) return false;
  if (v.notificationType !== "alert") return true;
  if (typeof v.alert === "undefined") return true;
  if (!v.alert || typeof v.alert !== "object") return false;
  return typeof v.alert.text === "string" && v.alert.text.trim().length > 0;
};

const extractNotificationTypeMessage = (record: SQSRecord): RevisionedNotificationTypeMessage | null => {
  const raw = record.body ? parseJson(record.body) : null;
  const payload = unwrapSns(raw ?? record);
  return isNotificationTypeMessage(payload) ? payload : null;
};

// Why extractNotificationTypeMessage found no message (C1.8 reports it).
const malformedMessageReason = (record: SQSRecord): string => {
  if (!record.body) return "empty_body";
  return parseJson(record.body) === null ? "invalid_json" : "not_notification_type";
};

/**
 * S4: the action notificationType found for this change (`alert`, `passed` or `failed` on the message, matching its
 * type), which the pending row keeps so the push can name it. Undefined for "new" and "updated", and for a message
 * that carries none (an older producer, or a change with no identifiable action).
 */
const actionOfMessage = (msg: NotificationTypeMessage): PendingNotificationAction | undefined => {
  switch (msg.notificationType) {
    case "alert":
      return parsePendingNotificationAction(msg.alert);
    case "passed":
      return parsePendingNotificationAction(msg.passed);
    case "failed":
      return parsePendingNotificationAction(msg.failed);
    default:
      return undefined;
  }
};

/**
 * S6: a ceremonial resolution (shared/commemorativeResolutions.ts) never sends a "new" push, to topic followers or,
 * for an "in the news" bill, to everyone. Its later alert, updated, passed and failed pushes go out by their rules,
 * except that no follower of a topic or a life area is matched (matchBillAudience, `ceremonial`): the resolution has
 * none on its manifest row or from GET /processed-bill (project decision 2026-10-29 for the topics).
 */
const isCeremonialResolution = (processed: ProcessedBillDocument, billGuid: string): boolean =>
  isCommemorativeResolution({
    guid: processed.guid ?? billGuid,
    billType: extractBillType(processed) ?? parseBillGuid(billGuid)?.billType,
    officialTitle: processed.officialTitle,
    title: processed.title,
  });

/**
 * UX-33: when an "updated" message's summary change was stored (`changedAt`, epoch ms), for userNotifier's check of a
 * newer vote. Undefined for other types and for a message without a usable time (an older producer); then the pending
 * row's write time stands in. A time ahead of this clock is taken as now.
 */
const changedAtOfMessage = (msg: NotificationTypeMessage): number | undefined => {
  if (msg.notificationType !== "updated" || typeof msg.changedAt !== "string") return undefined;
  const ms = Date.parse(msg.changedAt);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, Date.now()) : undefined;
};

/**
 * UX-33: the outcome push the same stored version also sends, named on its "alert" message: one of the outcome push
 * types (shared/pushAudience.ts OUTCOME_PUSH_TYPES), else undefined.
 */
const sameVersionOutcomeOf = (msg: NotificationTypeMessage): OutcomePushType | undefined =>
  msg.notificationType === "alert" && isOutcomePushType(msg.sameVersionOutcome) ? msg.sameVersionOutcome : undefined;

/**
 * UX-33: the action the same stored version also added, named on its outcome message (`sameVersionAlert` on a
 * "passed" or "failed", shared/pushAudience.ts OUTCOME_PUSH_TYPES): `{ action }`, the action undefined when the
 * message's details are malformed (its row then reads as an action with no single new one). Undefined for another
 * type, or a message without it (an older producer).
 */
const sameVersionAlertOf = (msg: NotificationTypeMessage): { action?: PendingNotificationAction } | undefined => {
  if (!isOutcomePushType(msg.notificationType)) return undefined;
  const value = msg.sameVersionAlert as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = parsePendingNotificationAction(value);
  return action ? { action } : {};
};

const normaliseSourceRevision = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_SOURCE_REVISION_LENGTH ? trimmed : undefined;
};

// A bill is followed with a Bill row (the app writes one with each vote) or a Watch row on its guid. ["Bill"] alone is
// the lookup before REL-42, when a Watch row counted only while no user had a Bill row on the bill. These are the
// bill's voters and watchers of the push audience rules (shared/pushAudience.ts, UX-33).
const BILL_FOLLOW_TYPES: readonly string[] = ["Bill", "Watch"];

const getAlertSubscribersForBill = async (billGuid: string): Promise<string[]> => {
  // Prefer a typed lookup if the table stores explicit bill subscriptions. Both types, so a user who only watches the
  // bill is found even when others voted on it (REL-42).
  try {
    const typed = await preferencesDao.getUsersForSubCategory(billGuid, BILL_FOLLOW_TYPES);
    if (typed.length > 0) return typed;
  } catch (error) {
    logger.warn("Failed to query preferences for bill alert type", { billGuid, type: BILL_FOLLOW_TYPES, error });
  }

  // Fallback: any preference rows keyed by the guid.
  try {
    const ids = await preferencesDao.getUsersForSubCategory(billGuid);
    return Array.from(new Set(ids));
  } catch {
    return [];
  }
};

// ─── Companion groups (APPF-23) ───────────────────────────────────────────────

/** The enabled companion groups, or null when they are off, not configured or cannot be read. */
const loadCompanionIndex = async (): Promise<CompanionIndex | null> => {
  if (!companionDao) return null;
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    if (!state?.enabled) return null;
    if (companionIndexFor?.state !== state) {
      companionIndexFor = { state, index: companionIndex(state.pairs) };
    }
    return companionIndexFor.index;
  } catch (error) {
    logger.warn("Could not read the companion groups; matching this bill on its own", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return null;
  }
};

/** The other members of the bill's companion group (plain guids); none when it is not grouped. */
const companionPartnersOf = (billGuid: string, index: CompanionIndex | null): string[] => {
  const plain = plainBillGuid(billGuid);
  const group = plain ? index?.get(plain) : undefined;
  return group ? group.memberGuids.filter((member) => member !== plain) : [];
};

/**
 * Watchers of the bill and of every other member of its companion group, each user once, in lookup
 * order. For an ungrouped bill this is getAlertSubscribersForBill.
 */
const getAlertSubscribersForGroup = async (billGuid: string, partners: readonly string[]): Promise<string[]> => {
  const subscribers = new Set(await getAlertSubscribersForBill(billGuid));
  for (const partner of partners) {
    for (const userId of await getAlertSubscribersForBill(partner)) subscribers.add(userId);
  }
  return Array.from(subscribers);
};

/** The bill's manifest updatedAt in epoch ms (from its BILL_GUID lookup row), or null when unknown. */
const manifestUpdatedAtMs = async (plainGuid: string): Promise<number | null> => {
  const config = companionDao!.config;
  const response = await dynamo.send(
    new GetItemCommand({
      TableName: config.tableName,
      Key: { [config.primaryKey]: { S: config.guidLookupPk }, [config.sortKey]: { S: plainGuid } },
      ProjectionExpression: "updatedAt, manifestSk",
      ConsistentRead: true,
    }),
  );
  const updatedAt = response?.Item?.updatedAt?.S ?? response?.Item?.manifestSk?.S?.split("#")[0];
  const parsed = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Records, once per pair, that `deferring` sends its "new" only to the users its partner's "new" does
 * not reach: a conditional put in the pending-notifications table's dedupe partition, which only
 * this member may repeat (a redelivery). False when the partner already deferred to this bill.
 */
const claimCompanionNewDeferral = async (deferring: string, partner: string): Promise<boolean> => {
  const store = PENDING_NOTIFICATIONS_STORE;
  const createdAt = Math.floor(Date.now() / 1000);
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: store.tableName,
        Item: {
          markerType: { S: "companion-new-deferral" },
          deferredGuid: { S: deferring },
          companionGuid: { S: partner },
          createdAt: { N: String(createdAt) },
          ttl: { N: String(createdAt + COMPANION_NEW_CLAIM_TTL_SECONDS) },
          // Key attributes last, as for the dedupe markers.
          [store.partitionKey]: { S: store.dedupePartitionValue },
          [store.sortKey]: { S: `companion-new||${toCompanionGroupV1([deferring, partner]).primaryGuid}` },
        },
        ConditionExpression: "attribute_not_exists(#sk) OR #deferredGuid = :deferring",
        ExpressionAttributeNames: { "#sk": store.sortKey, "#deferredGuid": "deferredGuid" },
        ExpressionAttributeValues: { ":deferring": { S: deferring } },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
};

/**
 * The revision a bill's "new" was sent with: the S3 version id of its first stored processed bill
 * (notificationType sends "new" for the version with no previous one, stamped with its version id).
 * Null when there is none, or it predates versioning ("null"). Once that first version has expired
 * (30 days after it was replaced) the oldest one left is another, but the "new"'s dedupe markers
 * (3 days) are gone by then, so a wrong revision finds no marker either and only sends in full.
 */
const firstStoredRevision = async (guid: string): Promise<string | null> => {
  const versions = await billStorage.listObjectVersionsForKey(buildProcessedBillRootGuidKey(guid));
  const stored = versions.filter((version) => !version.isDeleteMarker);
  const first = stored[stored.length - 1];
  return first && first.versionId !== "null" ? first.versionId : null;
};

/**
 * For a "new" of a companion pair member, the partner's "new" it defers to; undefined sends it as an
 * ungrouped bill's. Each user's write then puts the partner "new"'s dedupe marker for that user
 * (writePendingNotification): a user that "new" reached (its own marker exists, 3 days) is skipped, and
 * any other user gets this "new", including users who started following its topics later and the
 * followers of its own sponsors. No user is skipped on a guess, and the created marker makes the
 * partner's "new", if it is still in flight, skip the users this one reached.
 * This member defers when the partner (resolved fresh from the link lists, since the pair may be newer
 * than the published groups) reached the manifest first, or at the same instant and this is the Senate
 * member. The deferral is also claimed once per pair: a member whose partner already deferred to it is
 * sent in full. Only while the published groups are enabled; any failure sends in full.
 */
const companionNewToDeferTo = async (billGuid: string): Promise<CompanionNewRef | undefined> => {
  const plain = plainBillGuid(billGuid);
  if (!plain || !companionDao || !(await loadCompanionIndex())) return undefined;

  try {
    const partner = await companionDao.resolveFresh(plain);
    if (!partner) return undefined;
    const [ownMs, partnerMs] = await Promise.all([manifestUpdatedAtMs(plain), manifestUpdatedAtMs(partner)]);
    if (ownMs === null || partnerMs === null) return undefined;
    const isSenate = chamberOf(parseBillGuid(plain)!.billType) === "Senate";
    if (!(partnerMs < ownMs || (partnerMs === ownMs && isSenate))) return undefined;

    const partnerRevision = await firstStoredRevision(partner);
    if (!partnerRevision) {
      logger.warn("Companion bill's new revision is unknown; sending the new notification in full", {
        companionGuid: partner,
      });
      return undefined;
    }

    if (!(await claimCompanionNewDeferral(plain, partner))) {
      logger.info("Sending new notification in full; its companion bill already deferred to it", {
        billId: billGuid,
        companionGuid: partner,
      });
      return undefined;
    }
    logger.info("Deferring new notification to its companion bill for the users that one reached", {
      billId: billGuid,
      companionGuid: partner,
      companionRevision: partnerRevision,
    });
    return { billId: partner, sourceRevision: partnerRevision };
  } catch (error) {
    logger.warn("Could not resolve the bill's companion; sending its new notification", { error });
    return undefined;
  }
};

const findBillTitle = (payload: Record<string, unknown>): string | null => {
  const candidates = [
    payload.title,
    (payload.metadata as Record<string, unknown> | undefined)?.title,
    (payload.bill as Record<string, unknown> | undefined)?.title,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
};

// LLM-10 (1B): a bill label is read under its current name. A legacy name ("Social Justice", "Identity
// Politics") on a bill not yet relabelled is accepted and mapped to its current name, never dropped.
// Each label is then matched against follows stored under every spelling (matchBillAudience).
const currentSubCategoryReference = (name: string): BillCategoryReference | null => {
  if (!isAcceptedSubCategoryName(name)) return null;
  const subCategory = canonicalSubCategory(name);
  return { category: BILL_SUBCATEGORY_TO_CATEGORY[subCategory], subCategory };
};

const normaliseCategoryEntry = (raw: unknown): BillCategoryReference | null => {
  if (!raw) {
    return null;
  }

  if (typeof raw === "string") {
    return currentSubCategoryReference(raw);
  }

  if (typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const subCategoryCandidate =
    (typeof obj.subCategory === "string" && obj.subCategory) ||
    (typeof obj.subcategory === "string" && obj.subcategory) ||
    (typeof obj.name === "string" && obj.name) ||
    (typeof obj.label === "string" && obj.label) ||
    (typeof obj.category === "string" && obj.category) ||
    "";

  const derived = currentSubCategoryReference(subCategoryCandidate);
  if (!derived) {
    return null;
  }

  const explicitCategory =
    (typeof obj.category === "string" && obj.category) ||
    (typeof obj.mainCategory === "string" && obj.mainCategory) ||
    (typeof obj.group === "string" && obj.group) ||
    undefined;

  if (explicitCategory && isBillCategoryName(explicitCategory)) {
    return { category: explicitCategory, subCategory: derived.subCategory };
  }

  return derived;
};

const extractCategories = (payload: Record<string, unknown>): BillCategoryReference[] => {
  const candidates: unknown[] = [];
  const direct = payload.categories;
  if (Array.isArray(direct)) {
    candidates.push(...direct);
  }

  const bill = payload.bill as Record<string, unknown> | undefined;
  if (bill && Array.isArray(bill.categories)) {
    candidates.push(...bill.categories);
  }

  const metadata = payload.metadata as Record<string, unknown> | undefined;
  if (metadata && Array.isArray(metadata.categories)) {
    candidates.push(...metadata.categories);
  }

  const nestedCategories = payload.categories as { items?: unknown[] } | undefined;
  if (nestedCategories && Array.isArray(nestedCategories.items)) {
    candidates.push(...nestedCategories.items);
  }

  const results: BillCategoryReference[] = [];

  for (const candidate of candidates) {
    const entry = normaliseCategoryEntry(candidate);
    if (entry) {
      results.push(entry);
    }
  }

  return results;
};

// One entry per label under its current name, so a bill carrying both spellings of a renamed label is
// matched once.
const dedupeCategories = (categories: BillCategoryReference[]): BillCategoryReference[] => {
  const map = new Map<string, BillCategoryReference>();

  for (const category of categories) {
    const key = canonicalSubCategory(category.subCategory);
    if (!map.has(key)) {
      map.set(key, { ...category, subCategory: key });
    }
  }

  return Array.from(map.values());
};

const isBillDocument = (value: unknown): value is BillDocument => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.schemaVersion === "number" &&
    typeof candidate.kind === "string" &&
    typeof candidate.identifier === "object" &&
    candidate.identifier !== null
  );
};

// UX-33: every push type reads the document here now, so only what the push needs is required: the rows are keyed by
// the guid the processed key names (never the document's), and a missing topic list is no topic. Before, an "alert" or
// "updated" never read these fields, and a "new", "passed" or "failed" also required `guid` and `subCategories`.
const isProcessedBillDocument = (document: BillDocument): document is ProcessedBillDocument => {
  const candidate = document as Partial<ProcessedBillDocument>;
  return document.kind === "processed" && typeof candidate.title === "string";
};

const toCategoryReferencesFromStrings = (subCategories: unknown): BillCategoryReference[] => {
  if (!Array.isArray(subCategories)) {
    return [];
  }

  const results: BillCategoryReference[] = [];

  for (const raw of subCategories) {
    if (typeof raw !== "string") {
      continue;
    }

    const reference = currentSubCategoryReference(raw);
    if (reference) {
      results.push(reference);
    }
  }

  return results;
};

const extractStringList = (payload: Record<string, unknown>, keys: string[]): string[] => {
  const results: string[] = [];

  for (const key of keys) {
    const value = payload[key];
    if (!Array.isArray(value)) {
      continue;
    }

    for (const entry of value) {
      if (typeof entry === "string" && entry.length > 0) {
        results.push(entry);
      }
    }
  }

  return results;
};

const dedupeStrings = (values: string[]): string[] => {
  return Array.from(new Set(values.filter(Boolean)));
};

const extractBillType = (rawDocument: unknown, payload?: Record<string, unknown> | null): string | null => {
  if (isBillDocument(rawDocument)) {
    const identifier = (rawDocument.identifier ?? {}) as { billType?: unknown };
    if (typeof identifier.billType === "string" && identifier.billType.length > 0) {
      return identifier.billType;
    }
  }

  const activePayload =
    payload ?? (rawDocument && typeof rawDocument === "object" ? (rawDocument as Record<string, unknown>) : null);
  if (!activePayload) {
    return null;
  }

  const identifier = activePayload.identifier as Record<string, unknown> | undefined;
  const bill = activePayload.bill as Record<string, unknown> | undefined;
  const metadata = activePayload.metadata as Record<string, unknown> | undefined;
  const candidates = [
    activePayload.billType,
    activePayload.type,
    identifier?.billType,
    identifier?.type,
    bill?.billType,
    bill?.type,
    metadata?.billType,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
};

// Drops users an earlier record of this batch already gave the same notification, keeping order.
const selectUndeliveredUsers = (
  delivery: NotificationDelivery,
  userIds: readonly string[],
  sentNotificationKeys: Set<string>,
): string[] => {
  const selected: string[] = [];
  for (const userId of userIds) {
    const notificationKey = buildAggregatedNotificationKey(
      delivery.billId,
      userId,
      delivery.notificationType,
      delivery.sourceRevision,
    );
    if (sentNotificationKeys.has(notificationKey)) {
      logger.info("Skipping duplicate aggregated notification", { billId: delivery.billId, userId });
      continue;
    }
    sentNotificationKeys.add(notificationKey);
    selected.push(userId);
  }
  return selected;
};

const getSqs = (): SQSClient => (sqs ??= new SQSClient({}));

// About FANOUT_USERS_PER_MESSAGE users per message, up to ten messages per SendMessageBatch. Failed
// entries are retried; if any still fail this throws, the record is reported as a batch item failure
// and its redelivery re-sends every chunk, which notificationFanout's dedupe markers make harmless.
const enqueueFanout = async (delivery: NotificationDelivery, userIds: readonly string[]): Promise<void> => {
  const entries = chunkUserIds(userIds, FANOUT_USERS_PER_MESSAGE).map((chunk, index) => ({
    Id: `fanout-${index}`,
    MessageBody: JSON.stringify(buildNotificationFanoutMessage(delivery, chunk)),
    ...correlationIdMessageAttributes(delivery.correlationId),
  }));
  const messageCount = await sendMessageBatchWithRetry(getSqs(), NOTIFICATION_FANOUT_QUEUE_URL!, entries);
  logger.info("Enqueued notification fan-out", {
    billId: delivery.billId,
    notificationType: delivery.notificationType,
    isPriorityBill: delivery.isPriorityBill,
    ...(delivery.skipBillTypeFilter ? { skipBillTypeFilter: true } : {}),
    ...(delivery.pairedAlert ? { pairedAlert: true } : {}),
    userCount: userIds.length,
    messageCount,
  });
};

// CAP-02: hands the users to notificationFanout when its queue is configured, else writes here with
// bounded concurrency. Either way the content-type filter (skipped only for the voters and watchers of a bill in the
// news, UX-33) and the dedupe-guarded write are the ones in shared/pendingNotifications.ts.
const deliverNotification = async (
  delivery: NotificationDelivery,
  userIds: readonly string[],
  userContentTypeCache: UserContentTypePreferenceCache,
): Promise<void> => {
  if (userIds.length === 0) return;
  if (NOTIFICATION_FANOUT_QUEUE_URL) {
    await enqueueFanout(delivery, userIds);
    return;
  }

  const outcome = await writePendingNotificationsForUsers(
    {
      dynamo,
      store: PENDING_NOTIFICATIONS_STORE,
      preferences: preferencesDao,
      subCategoryAttribute: SUB_CATEGORY_ATTRIBUTE,
      contentTypeCache: userContentTypeCache,
    },
    delivery,
    userIds,
    { concurrency: INLINE_WRITE_CONCURRENCY },
  );
  logger.info("Wrote pending notifications inline", {
    billId: delivery.billId,
    notificationType: delivery.notificationType,
    userCount: userIds.length,
    ...outcome,
  });
};

/** How a user was found: through which kind of follow, or as one of everyone. */
type MatchType = "Category" | "Life Area" | "Congress Member" | "Priority" | "Bill Follow";

/** The users a bill document matches, and what its pending rows carry. */
interface BillAudience {
  billId: string;
  billTitle: string;
  billType: string | null;
  isPriorityBill: boolean;
  primaryCategory: string;
  primaryLifeArea: string;
  /** The bill's first topic under its current name, for the push payload (S4); undefined when it has none. */
  primarySubCategory?: string;
  /** In match order, each user once. */
  userIds: string[];
  /** Per user, how they were found (UX-33: which of them a paired action row also reaches). */
  matchTypesByUser: ReadonlyMap<string, ReadonlySet<MatchType>>;
}

/**
 * Which followers of the bill's labels a push reaches (UX-33, shared/pushAudience.ts): of its topics, life areas,
 * sponsors and cosponsors ("interests"), of its topics only, or none.
 */
type LabelFollowers = "interests" | "topics" | "none";

interface BillAudienceOptions {
  logContext?: { bucket?: string; key?: string };
  /** The guid the rows are keyed by: the one the processed bill's key names, never the document's (REL-41). */
  billId: string;
  labelFollowers: LabelFollowers;
  /** A bill "in the news" (an active BillPriority record). */
  inTheNews: boolean;
  /** Every active user, for a push that reaches everyone. */
  everyoneUserIds?: string[];
  /** The bill's voters and watchers, and those of its companion group where the rule says so. */
  billFollowerUserIds?: string[];
  /**
   * A ceremonial resolution (S6): it is about no topic and touches no life area, as its manifest row and GET
   * /processed-bill say (project decision 2026-10-29 for the topics), so no follower of either is matched and its pushes
   * carry neither. Its voters, watchers and the followers of its sponsors and cosponsors are matched as for any bill.
   */
  ceremonial?: boolean;
}

/**
 * The users a push about a bill document reaches, as its audience rule names them: everyone, the bill's voters and
 * watchers, and the followers of its labels (categories, then life areas and sponsors or cosponsors). Null when the
 * document cannot be used or the push reaches nobody.
 */
const matchBillAudience = async (rawDocument: unknown, options: BillAudienceOptions): Promise<BillAudience | null> => {
  const { logContext, billId, labelFollowers } = options;
  const isPriorityBill = options.inTheNews;
  const everyoneUserIds = Array.from(new Set((options.everyoneUserIds ?? []).filter(Boolean)));
  const billFollowerUserIds = Array.from(new Set((options.billFollowerUserIds ?? []).filter(Boolean)));

  let payload: Record<string, unknown> | null;
  let metadataTitle: string | null;
  const metadataCategories: BillCategoryReference[] = [];
  let documentCategories: BillCategoryReference[];

  if (!rawDocument || typeof rawDocument !== "object") {
    logger.warn("Processed bill not found", { ...logContext });
    return null;
  }

  if (isBillDocument(rawDocument)) {
    if (!isProcessedBillDocument(rawDocument)) {
      logger.info(`Skipping bill document; received kind=${String(rawDocument.kind ?? "unknown")}`, {
        ...logContext,
      });
      return null;
    }

    const processed = rawDocument as ProcessedBillDocument;
    payload = processed as unknown as Record<string, unknown>;
    metadataTitle = processed.title ?? null;
    documentCategories = toCategoryReferencesFromStrings(processed.subCategories);
  } else {
    payload = rawDocument as Record<string, unknown>;
    const titleCandidate = (payload.title ?? payload.name) as unknown;
    metadataTitle = typeof titleCandidate === "string" ? titleCandidate : null;

    const directCategories = Array.isArray(payload.categories)
      ? payload.categories.filter((entry): entry is BillCategoryReference => {
          return (
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as { category?: unknown }).category === "string" &&
            typeof (entry as { subCategory?: unknown }).subCategory === "string"
          );
        })
      : [];

    documentCategories = directCategories;
    if (documentCategories.length === 0) {
      documentCategories = toCategoryReferencesFromStrings(payload.subCategories);
    }
  }

  if (!payload || typeof payload !== "object") {
    logger.warn("Processed bill payload invalid", { ...logContext });
    return null;
  }

  const billTitle = findBillTitle(payload) ?? metadataTitle;

  if (!billTitle) {
    logger.warn("Unable to determine bill title", { billId, ...logContext });
    return null;
  }

  const categoriesFromPayload = extractCategories(payload);
  // S6: the processed bill keeps the summarizer's topics, but a ceremonial resolution is served and listed without
  // them, so none is matched or named in the push (its primary category is then "General", as for any bill without
  // topics).
  const categories = options.ceremonial
    ? []
    : dedupeCategories([...categoriesFromPayload, ...metadataCategories, ...documentCategories]);
  const billType = extractBillType(rawDocument, payload);

  // S6: likewise its life areas, which the row and GET /processed-bill have left out since 2026-10-28; until this
  // change an outcome push still reached a life area's followers through the processed bill's own list.
  const lifeAreas = options.ceremonial
    ? []
    : dedupeStrings(extractStringList(payload, ["lifeAreas", "life_areas", "lifeareas"]).filter(isLifeAreaName));
  const sponsorIds = dedupeStrings(extractStringList(payload, ["sponsors", "sponsorIds", "sponsor_ids"]));
  const cosponsorIds = dedupeStrings(
    extractStringList(payload, ["cosponsors", "coSponsors", "cosponsorIds", "cosponsor_ids"]),
  );
  const congressMemberIds = dedupeStrings([...sponsorIds, ...cosponsorIds]);

  // The labels whose followers this push reaches (UX-33): every label, the topics only, or none.
  const followedCategories = labelFollowers === "none" ? [] : categories;
  const followedLifeAreas = labelFollowers === "interests" ? lifeAreas : [];
  const followedMemberIds = labelFollowers === "interests" ? congressMemberIds : [];

  logger.info("Extracted match candidates", {
    billId,
    labelFollowers,
    ...(options.ceremonial ? { ceremonial: true } : {}),
    categoryCount: categories.length,
    lifeAreaCount: lifeAreas.length,
    sponsorCount: sponsorIds.length,
    cosponsorCount: cosponsorIds.length,
  });

  if (
    everyoneUserIds.length === 0 &&
    billFollowerUserIds.length === 0 &&
    followedCategories.length === 0 &&
    followedLifeAreas.length === 0 &&
    followedMemberIds.length === 0
  ) {
    logger.info("No match candidates found for bill; nothing to notify", { billId });
    return null;
  }

  const userMatches = new Map<
    string,
    {
      matches: Array<{
        category: string;
        subCategory: string;
        matchType: MatchType;
      }>;
      seen: Set<string>;
    }
  >();

  const addMatchForUsers = (
    userIds: string[],
    match: {
      category: string;
      subCategory: string;
      matchType: MatchType;
    },
  ) => {
    const matchKey = `${match.matchType}||${match.category}||${match.subCategory}`;
    for (const userId of userIds) {
      if (!userId) {
        continue;
      }
      const existing = userMatches.get(userId) ?? { matches: [], seen: new Set<string>() };
      if (!existing.seen.has(matchKey)) {
        existing.seen.add(matchKey);
        existing.matches.push(match);
      }
      userMatches.set(userId, existing);
    }
  };

  if (everyoneUserIds.length > 0) {
    addMatchForUsers(everyoneUserIds, {
      category: "Priority Bill",
      subCategory: "Priority Bill",
      matchType: "Priority",
    });
  }

  if (billFollowerUserIds.length > 0) {
    addMatchForUsers(billFollowerUserIds, {
      category: "Bill Alert",
      subCategory: billId,
      matchType: "Bill Follow",
    });
    logger.info("Matched the bill's voters and watchers", {
      billId,
      matchType: "Bill Follow",
      userCount: billFollowerUserIds.length,
    });
  }

  for (const category of followedCategories) {
    // LLM-10: a renamed label is looked up under its current name and each legacy name, so a follow the
    // relabel script has not moved yet still matches; one lookup for every other label.
    const followedNames = subCategoryNameVariants(category.subCategory);
    const lookups: string[] = [];
    for (const name of followedNames) {
      lookups.push(...(await preferencesDao.getUsersForSubCategory(name, "Category")));
    }
    const userIds = dedupeStrings(lookups);
    const legacyNamesQueried = followedNames.length > 1 ? { followedNames } : {};

    if (userIds.length === 0) {
      logger.info("No users subscribed for match, skipping", {
        billId,
        matchType: "Category",
        subCategory: category.subCategory,
        ...legacyNamesQueried,
      });
      continue;
    }

    addMatchForUsers(userIds, {
      category: category.category,
      subCategory: category.subCategory,
      matchType: "Category",
    });

    logger.info("Matched users for category", {
      billId,
      matchType: "Category",
      subCategory: category.subCategory,
      userCount: userIds.length,
      ...legacyNamesQueried,
    });
  }

  for (const lifeArea of followedLifeAreas) {
    const userIds = dedupeStrings(await preferencesDao.getUsersForSubCategory(lifeArea, "Life Area"));
    if (userIds.length === 0) {
      logger.info("No users subscribed for match, skipping", { billId, matchType: "Life Area", subCategory: lifeArea });
      continue;
    }

    addMatchForUsers(userIds, {
      category: "Life Area",
      subCategory: lifeArea,
      matchType: "Life Area",
    });

    logger.info("Matched users for life area", {
      billId,
      matchType: "Life Area",
      subCategory: lifeArea,
      userCount: userIds.length,
    });
  }

  for (const congressMemberId of followedMemberIds) {
    const userIds = dedupeStrings(await preferencesDao.getUsersForSubCategory(congressMemberId, "Congress Member"));
    if (userIds.length === 0) {
      logger.info("No users subscribed for match, skipping", {
        billId,
        matchType: "Congress Member",
        subCategory: congressMemberId,
      });
      continue;
    }

    addMatchForUsers(userIds, {
      category: "Congress Member",
      subCategory: congressMemberId,
      matchType: "Congress Member",
    });

    logger.info("Matched users for congress member", {
      billId,
      matchType: "Congress Member",
      subCategory: congressMemberId,
      userCount: userIds.length,
    });
  }

  if (userMatches.size === 0) {
    logger.info("No users matched any preferences; nothing to notify", { billId });
    return null;
  }

  const aggregatedUsers = Array.from(userMatches.keys());
  logger.info("Aggregated matches for users", { billId, uniqueUsers: aggregatedUsers.length });

  return {
    billId,
    billTitle,
    billType,
    isPriorityBill,
    primaryCategory: isPriorityBill ? "Priority Bill" : categories.length > 0 ? categories[0].category : "General",
    primaryLifeArea: lifeAreas.length > 0 ? lifeAreas[0] : "",
    ...(categories.length > 0 ? { primarySubCategory: categories[0].subCategory } : {}),
    userIds: aggregatedUsers,
    matchTypesByUser: new Map(
      aggregatedUsers.map((userId) => [userId, new Set(userMatches.get(userId)!.matches.map((m) => m.matchType))]),
    ),
  };
};

/** The follows each audience source finds a user through (UX-33: who a paired action row reaches). */
const MATCH_TYPES_OF_SOURCE: Readonly<Record<PushAudienceSource, readonly MatchType[]>> = {
  interests: ["Category", "Life Area", "Congress Member"],
  topics: ["Category"],
  billFollowers: ["Bill Follow"],
  groupFollowers: ["Bill Follow"],
  everyone: ["Priority", "Category", "Life Area", "Congress Member", "Bill Follow"],
};

/** Whether a user found through `matchTypes` is in the audience `sources` names. */
const isInAudience = (
  matchTypes: ReadonlySet<MatchType> | undefined,
  sources: readonly PushAudienceSource[],
): boolean => sources.some((source) => MATCH_TYPES_OF_SOURCE[source].some((matchType) => matchTypes?.has(matchType)));

/**
 * UX-33 (project decision 2026-10-29, "one event, per phone"): on a "passed" or "failed" whose stored version also added
 * an action, the action's row each user of that action's audience gets beside the outcome's.
 */
interface PairedAlertOptions {
  /** The action, when the message named one. */
  action?: PendingNotificationAction;
  /** The audience of the version's "alert" (shared/pushAudience.ts), which the outcome's covers. */
  alertSources: readonly PushAudienceSource[];
}

const processBillDocument = async (
  rawDocument: unknown,
  changeInfo: ChangeInfo,
  options: BillAudienceOptions & {
    sentNotificationKeys: Set<string>;
    userContentTypeCache: UserContentTypePreferenceCache;
    /** A companion pair member's "new": the partner's "new" whose recipients are skipped. */
    companionNew?: CompanionNewRef;
    /** A "passed" or "failed" whose version also added an action: that action's rows, written beside the outcome's. */
    pairedAlert?: PairedAlertOptions;
  },
): Promise<void> => {
  const audience = await matchBillAudience(rawDocument, options);
  if (!audience) return;

  const { billId, userIds } = audience;
  const { notificationType } = changeInfo;
  const companionNew = notificationType === "new" ? options.companionNew : undefined;
  // An "alert" or "updated" is about a bill the user follows: the "Bill Alert" category (the Recent actions row an
  // alert push files in both apps) and no life area, as before UX-33. The other pushes carry the bill's first topic
  // group and life area. A bill in the news is "Priority Bill" either way.
  const aboutAFollowedBill = notificationType === "alert" || notificationType === "updated";

  const delivery: NotificationDelivery = {
    billId,
    billTitle: audience.billTitle,
    category: audience.isPriorityBill ? "Priority Bill" : aboutAFollowedBill ? "Bill Alert" : audience.primaryCategory,
    lifeArea: aboutAFollowedBill ? "" : audience.primaryLifeArea,
    ...(audience.primarySubCategory ? { subCategory: audience.primarySubCategory } : {}),
    // S4: actionOfMessage gives one only for an "alert", "passed" or "failed".
    ...(changeInfo.action ? { action: changeInfo.action } : {}),
    notificationType,
    sourceRevision: changeInfo.sourceRevision,
    correlationId: changeInfo.correlationId,
    isPriorityBill: audience.isPriorityBill,
    rawBillType: audience.billType,
    ...(changeInfo.changedAtMs !== undefined ? { changedAtMs: changeInfo.changedAtMs } : {}),
    ...(companionNew ? { companionNew } : {}),
  };

  // UX-33 (project decision 2026-10-29): the bill's own voters and watchers (and its companion's) are never filtered by
  // the bill types they chose, in or out of the news; everyone else it reaches is. Both apps show a bill in the news
  // whatever those types are (Bill.swift matchesPriorityAwareFeedEligibility, 1.1 :358-359, 1.2 :379-380), so users
  // vote on bills outside them, and a vote or a watch is on that bill whatever its type.
  const followers = new Set(options.billFollowerUserIds ?? []);
  // UX-33 (project decision 2026-10-29, "one event, per phone"): an outcome whose version also added an action gives
  // that action's row, in the same write, to each user the action push reaches (here, as the outcome's lookups found
  // them), the "Bill Alert" (or "Priority Bill") row an alert push writes; userNotifier sends each device one of them.
  const { pairedAlert } = options;
  const pairedAlertRow: PendingPairedAlert | undefined = pairedAlert
    ? {
        category: audience.isPriorityBill ? "Priority Bill" : "Bill Alert",
        ...(pairedAlert.action ? { action: pairedAlert.action } : {}),
      }
    : undefined;
  const pairedWith = (userId: string): boolean =>
    pairedAlert !== undefined && isInAudience(audience.matchTypesByUser.get(userId), pairedAlert.alertSources);

  // At most four deliveries, each user in one, the bill's voters and watchers first: they differ in the filter and in
  // the paired action row.
  for (const follower of [true, false]) {
    for (const paired of [true, false]) {
      const groupIds = userIds.filter((userId) => followers.has(userId) === follower && pairedWith(userId) === paired);
      if (groupIds.length === 0) continue;
      const groupDelivery: NotificationDelivery = {
        ...delivery,
        ...(follower ? { skipBillTypeFilter: true } : {}),
        ...(paired && pairedAlertRow ? { pairedAlert: pairedAlertRow } : {}),
      };
      await deliverNotification(
        groupDelivery,
        selectUndeliveredUsers(groupDelivery, groupIds, options.sentNotificationKeys),
        options.userContentTypeCache,
      );
    }
  }
};

const listAllActiveUserIds = async (): Promise<string[]> => {
  if (!PII_TABLE_NAME) {
    return [];
  }

  const userIds = new Set<string>();
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamo.send(
      new ScanCommand({
        TableName: PII_TABLE_NAME,
        ProjectionExpression: "#pk, deletionStatus",
        ExpressionAttributeNames: {
          "#pk": PII_PARTITION_KEY,
        },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const userId = item?.[PII_PARTITION_KEY]?.S?.trim();
      const deletionStatus = item?.deletionStatus?.S?.trim();
      if (userId && deletionStatus !== "completed" && deletionStatus !== "in_progress") {
        userIds.add(userId);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return Array.from(userIds);
};

export const handler = async (event: SQSEvent, context?: LambdaContextLike): Promise<SQSBatchResponse> => {
  logger.resetContext(context);
  const billDao = new ProcessedBillDao(s3, BUCKET_NAME);
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  const sentNotificationKeys = new Set<string>();
  const userContentTypeCache: UserContentTypePreferenceCache = new Map();
  let cachedPriorityAudienceUserIds: string[] | null = null;

  const loadPriorityAudienceUserIds = async (): Promise<string[]> => {
    if (cachedPriorityAudienceUserIds) {
      return cachedPriorityAudienceUserIds;
    }
    cachedPriorityAudienceUserIds = await listAllActiveUserIds();
    return cachedPriorityAudienceUserIds;
  };

  const processRecord = async (record: SQSRecord): Promise<void> => {
    const msg = extractNotificationTypeMessage(record);
    if (!msg) {
      // Acknowledged as before; now logged and counted (C1.8).
      reportUnprocessableMessage({
        site: "userMatcher.malformed",
        reason: malformedMessageReason(record),
        messageId: record.messageId,
        body: record.body,
      });
      return;
    }

    const { objectId, notificationType } = msg;
    const sourceRevision = normaliseSourceRevision(msg.sourceRevision);
    // Minted here for messages sent without one (older producers, manual sends).
    const correlationId = correlationIdFromRecord(record) ?? mintCorrelationId(objectId);
    logger.appendKeys({ guid: objectId, correlationId });
    logger.info("Matching users for bill notification", { notificationType, sourceRevision });

    try {
      const processed = await billDao.getByGuid(objectId);
      if (!processed) {
        logger.warn("Processed bill not found for notificationType", { guid: objectId });
        return;
      }
      // S6: checked before the companion deferral below, so a ceremonial "new" claims nothing.
      const ceremonial = isCeremonialResolution(processed, objectId);
      if (notificationType === "new" && ceremonial) {
        logger.info("Skipping new-bill notification for a ceremonial resolution", { billId: objectId });
        return;
      }
      const action = actionOfMessage(msg);
      // A companion pair member's "new" skips the users its partner's "new" reached.
      const companionNew = notificationType === "new" ? await companionNewToDeferTo(objectId) : undefined;
      const inTheNews = priorityDao ? isPriorityRecordActive(await priorityDao.getByGuid(objectId)) : false;

      // UX-33 (project decision 2026-10-29, "one event, per phone"): an action whose stored version also passes or fails
      // the bill is written by the outcome's message, beside the outcome's row for each user this action reaches, in
      // one write. Written from here too, a user would get two action rows, and written apart, a dispatch between the
      // writes would send one row, then hold the other for the pace window. Only when the outcome's audience covers
      // this action's (it always does today, in and out of the news); otherwise both go out as before UX-33. So the
      // action reaches no one while the outcome message is in its DLQ (RUNBOOK 11.1), and reaches no voter outside the
      // bill's labels when a UserMatcher older than UX-33 handles the outcome message (a retry or a rollback across a
      // shift; RUNBOOK 18.9 pauses NotificationType across the deploy for that reason).
      const sameVersionOutcome = sameVersionOutcomeOf(msg);
      if (sameVersionOutcome && outcomeCoversAlert(sameVersionOutcome, inTheNews)) {
        logger.info("Skipping the action message; the outcome message of the same version writes its rows", {
          billId: objectId,
          outcome: sameVersionOutcome,
          inTheNews,
        });
        return;
      }
      const sameVersionAlert = sameVersionAlertOf(msg);
      const pairedAlert: PairedAlertOptions | undefined =
        sameVersionAlert && outcomeCoversAlert(notificationType, inTheNews)
          ? { ...sameVersionAlert, alertSources: pushAudienceSources("alert", inTheNews) }
          : undefined;

      // UX-33: who gets this push is its type's audience rule (shared/pushAudience.ts). The rows stay keyed by this
      // bill, also for the users found through its companion (APPF-23).
      const sources = pushAudienceSources(notificationType, inTheNews);
      const billFollowerUserIds = sources.includes("groupFollowers")
        ? await getAlertSubscribersForGroup(objectId, companionPartnersOf(objectId, await loadCompanionIndex()))
        : sources.includes("billFollowers")
          ? await getAlertSubscribersForBill(objectId)
          : [];
      const everyoneUserIds = sources.includes("everyone") ? await loadPriorityAudienceUserIds() : [];
      // Without a user list (no PII_TABLE_NAME), a push for everyone goes to the followers of the bill's labels.
      const labelFollowers: LabelFollowers =
        sources.includes("interests") || (sources.includes("everyone") && everyoneUserIds.length === 0)
          ? "interests"
          : sources.includes("topics")
            ? "topics"
            : "none";
      logger.info("Push audience", {
        notificationType,
        inTheNews,
        sources,
        ...(pairedAlert ? { pairedAlertSources: pairedAlert.alertSources } : {}),
      });

      const changedAtMs = changedAtOfMessage(msg);
      const changeInfo: ChangeInfo = {
        guid: objectId,
        notificationType,
        sourceRevision,
        correlationId,
        ...(action ? { action } : {}),
        ...(changedAtMs !== undefined ? { changedAtMs } : {}),
      };
      await processBillDocument(processed, changeInfo, {
        billId: objectId,
        labelFollowers,
        inTheNews,
        everyoneUserIds,
        billFollowerUserIds,
        sentNotificationKeys,
        userContentTypeCache,
        companionNew,
        ...(pairedAlert ? { pairedAlert } : {}),
        ...(ceremonial ? { ceremonial } : {}),
        logContext: { bucket: BUCKET_NAME, key: `processed-bills/${objectId}.json` },
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      logger.error("Failed to process notificationType message", {
        messageId: record.messageId,
        error: failure,
      });
      // Report only this record; the rest of the batch is deleted from the queue.
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  };

  for (const record of event.Records) {
    await logger.withKeys({ sqsMessageId: record.messageId }, () => processRecord(record));
  }

  return { batchItemFailures };
};
