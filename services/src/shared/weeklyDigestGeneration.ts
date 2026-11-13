import { type AttributeValue, DynamoDBClient, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { activeCompanionPairs, BillCompanionDao } from "../adapters/billCompanionDao";
import { UserPreferencesDao } from "../adapters/userPreferencesDao";
import { ProcessedBillDao } from "../adapters/processedBillDao";
import { WeeklyDigestSnapshotDao } from "../adapters/weeklyDigestSnapshotDao";
import type { BillManifestEntry, ProcessedBillDocument } from "../models/bill";
import type { CongressMemberManifestEntry } from "../models/congressMember";
import { isLegacyDismissRow, LEGACY_DISMISS_ATTRIBUTE } from "../models/feedback";
import type { WeeklyDigest } from "../models/weeklyDigest";
import {
  buildWeeklyDigest,
  type WeeklyDigestPreferencesSummary,
  type WeeklyDigestVoteRecord,
} from "./weeklyDigestBuilder";
import { latestPublishedWindow, type WeeklyDigestPublicationWindow } from "./weeklyDigestSchedule";
import { isBillContentTypePreference, type BillContentTypePreference } from "./billContentTypes";
import { companionIndex, type CompanionIndex } from "./billCompanions";
import { mapWithConcurrency } from "./concurrency";
import { logger } from "./logger";
import { emitEmbeddedMetric } from "./metrics";

const WEEKLY_DIGESTS_TABLE_NAME = process.env.TABLE_NAME;
const WEEKLY_DIGESTS_PARTITION_KEY = process.env.PARTITION_KEY ?? "userId";
const WEEKLY_DIGESTS_SORT_KEY = process.env.SORT_KEY ?? "publishedAt";

const PII_TABLE_NAME = process.env.PII_TABLE_NAME;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? "userId";

const PREFERENCES_TABLE_NAME = process.env.PREFERENCES_TABLE_NAME;
const PREFERENCES_PARTITION_KEY = process.env.PREFERENCES_PARTITION_KEY ?? "userId";
const PREFERENCES_SORT_KEY = process.env.PREFERENCES_SORT_KEY ?? "preference";

const FEEDBACK_TABLE_NAME = process.env.FEEDBACK_TABLE_NAME;
const FEEDBACK_PARTITION_KEY = process.env.FEEDBACK_PARTITION_KEY ?? "userId";
const FEEDBACK_SORT_KEY = process.env.FEEDBACK_SORT_KEY ?? "billId";

const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME;
const MANIFEST_PRIMARY_KEY = process.env.MANIFEST_PRIMARY_KEY ?? "pk";
const MANIFEST_PK_VALUE = process.env.MANIFEST_PK_VALUE ?? "BILL";
const MANIFEST_SORT_KEY = process.env.MANIFEST_SORT_KEY ?? "sk";

const CONGRESS_MEMBERS_TABLE_NAME = process.env.CONGRESS_MEMBERS_TABLE_NAME;
const CONGRESS_MEMBERS_PRIMARY_KEY = process.env.CONGRESS_MEMBERS_PRIMARY_KEY ?? "bioguideId";

const BUCKET_NAME = process.env.BUCKET_NAME;

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});

const preferencesDao = new UserPreferencesDao(dynamo, {
  tableName: PREFERENCES_TABLE_NAME ?? "",
  userIdAttribute: PREFERENCES_PARTITION_KEY,
  preferenceAttribute: PREFERENCES_SORT_KEY,
});

const processedBillDao = BUCKET_NAME ? new ProcessedBillDao(s3, BUCKET_NAME) : null;
// APPF-23: the companion groups PublishBillsManifest last published (none while they are turned off),
// read once per context from the manifest table.
const companionDao = MANIFEST_TABLE_NAME?.trim() ? new BillCompanionDao(dynamo) : null;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";
const snapshotDao = new WeeklyDigestSnapshotDao(dynamo, {
  tableName: WEEKLY_DIGESTS_TABLE_NAME,
  partitionKey: WEEKLY_DIGESTS_PARTITION_KEY,
  sortKey: WEEKLY_DIGESTS_SORT_KEY,
});

/** Users per work message from the scheduled planner to weeklyDigestWorker (CAP-03). */
export const WEEKLY_DIGEST_USERS_PER_MESSAGE = 25;

/** Users generated at once by one invocation (inline pass or one worker message). */
export const WEEKLY_DIGEST_USER_CONCURRENCY = 5;

export interface WeeklyDigestGenerationContext {
  window: WeeklyDigestPublicationWindow;
  manifestItems: BillManifestEntry[];
  memberNameById: Map<string, string>;
  /**
   * Processed-bill loads by guid (CAP-03). Every user's digest draws on the same dozen or so
   * bills, so each bill is read from S3 once per context and the promise is shared by every
   * user that needs it. A load that throws is dropped, so a later user retries it; a bill that
   * is not in S3 is remembered as null.
   */
  processedBills: Map<string, Promise<ProcessedBillDocument | null>>;
  /**
   * The published companion groups (APPF-23), read once with the manifest: each group is one digest
   * candidate. Empty when groups are off or could not be read.
   */
  companionIndex: CompanionIndex;
}

interface WeeklyDigestGenerationResult {
  userId: string;
  status: "stored" | "existing" | "empty";
  digest: WeeklyDigest | null;
}

function normalizePreferenceKind(
  raw: string | null | undefined,
): "topic" | "lifeArea" | "congressMember" | "watch" | "contentType" | "bill" {
  const normalized = (raw ?? "").trim().toLowerCase().replace(/[_-]/g, " ").split(/\s+/).join("");

  switch (normalized) {
    case "watch":
      return "watch";
    case "lifearea":
      return "lifeArea";
    case "congressmember":
      return "congressMember";
    case "contenttype":
      return "contentType";
    case "bill":
      return "bill";
    default:
      return "topic";
  }
}

function normalizeStringList(value: AttributeValue | undefined): string[] {
  const list = value?.L;
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((entry: AttributeValue) => (typeof entry?.S === "string" ? entry.S : ""))
    .filter((entry: string) => entry.length > 0);
}

function toBillManifestEntry(item: Record<string, AttributeValue> | undefined): BillManifestEntry | null {
  if (!item) {
    return null;
  }

  const guid = item.guid?.S ?? "";
  const billType = item.billType?.S ?? "";
  if (!guid || !billType) {
    return null;
  }

  const billStatus = item.billStatus?.S ?? undefined;
  const validStatuses = new Set(["New", "Updated", "Passed", "Failed", "Finalized"]);

  return {
    guid,
    billType,
    congress: item.congress?.S ?? "",
    billNumber: item.billNumber?.S ?? "",
    updatedAt: item.updatedAt?.S ?? "",
    title: item.title?.S ?? "",
    subCategories: normalizeStringList(item.subCategories),
    lifeAreas: normalizeStringList(item.lifeAreas),
    sponsors: normalizeStringList(item.sponsors),
    cosponsors: normalizeStringList(item.cosponsors),
    ...(billStatus && validStatuses.has(billStatus)
      ? { billStatus: billStatus as BillManifestEntry["billStatus"] }
      : {}),
  };
}

function toCongressMemberManifestEntry(
  item: Record<string, AttributeValue> | undefined,
): CongressMemberManifestEntry | null {
  if (!item) {
    return null;
  }

  const bioguideId = item.bioguideId?.S ?? "";
  const name = item.name?.S ?? "";
  const chamber = item.chamber?.S ?? "";
  const state = item.state?.S ?? "";
  const party = item.party?.S ?? "";

  if (!bioguideId || !name || !chamber || !state || !party) {
    return null;
  }

  return {
    bioguideId,
    name,
    chamber,
    state,
    party,
    district: item.district?.NULL ? null : (item.district?.S ?? null),
    depictionImageUrl: item.depictionImageUrl?.NULL ? null : (item.depictionImageUrl?.S ?? null),
    updatedAt: item.updatedAt?.NULL ? null : (item.updatedAt?.S ?? null),
    currentCongressBillsSupportedCount: 0,
  };
}

export async function listAllWeeklyDigestUserIds(): Promise<string[]> {
  if (!PII_TABLE_NAME) {
    throw new Error("PII_TABLE_NAME is required");
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

  return Array.from(userIds).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

async function loadPreferencesForUser(userId: string): Promise<WeeklyDigestPreferencesSummary> {
  if (!PREFERENCES_TABLE_NAME) {
    throw new Error("PREFERENCES_TABLE_NAME is required");
  }

  const items = await preferencesDao.getUserPreferences(userId);
  const trackedTopics = new Set<string>();
  const trackedLifeAreas = new Set<string>();
  const followedMembers = new Set<string>();
  const watchedBillGuids = new Set<string>();
  const selectedBillContentTypes = new Set<BillContentTypePreference>();

  for (const item of items) {
    const type = normalizePreferenceKind(item.type?.S ?? null);
    const rawValue = item[PREFERENCES_SORT_KEY];
    const value = preferencesDao.attributeValueToString(rawValue)?.trim();
    if (!value) {
      continue;
    }

    switch (type) {
      case "lifeArea":
        trackedLifeAreas.add(value);
        break;
      case "congressMember":
        followedMembers.add(value);
        break;
      case "watch":
      case "bill":
        watchedBillGuids.add(value);
        break;
      case "contentType": {
        const normalized = value.toLowerCase();
        if (isBillContentTypePreference(normalized)) {
          selectedBillContentTypes.add(normalized);
        }
        break;
      }
      case "topic":
      default:
        trackedTopics.add(value);
        break;
    }
  }

  return {
    trackedTopics: Array.from(trackedTopics).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    ),
    trackedLifeAreas: Array.from(trackedLifeAreas).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    ),
    followedMembers: Array.from(followedMembers).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    ),
    watchedBillGuids: Array.from(watchedBillGuids).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    ),
    selectedBillContentTypes: Array.from(selectedBillContentTypes),
  };
}

/**
 * The user's votes by lower-cased bill id. An Abstain that 1.0 or 1.1 stored for an Updates dismissal
 * (legacyDismiss, INT-11) is not a vote, so it is left out: the digest never says "You voted on this
 * before" for it, and the bill stays eligible for "worth a quick look", as 1.2 shows it as not voted.
 */
async function loadVoteStatesByBillId(userId: string): Promise<Map<string, WeeklyDigestVoteRecord>> {
  const voteStates = new Map<string, WeeklyDigestVoteRecord>();
  if (!FEEDBACK_TABLE_NAME) {
    return voteStates;
  }

  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamo.send(
      new QueryCommand({
        TableName: FEEDBACK_TABLE_NAME,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: {
          "#pk": FEEDBACK_PARTITION_KEY,
          "#sk": FEEDBACK_SORT_KEY,
        },
        ExpressionAttributeValues: {
          ":pk": { S: userId },
        },
        ProjectionExpression: `#sk, feedback, votedAt, ${LEGACY_DISMISS_ATTRIBUTE}`,
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const billId = item?.[FEEDBACK_SORT_KEY]?.S?.trim();
      const feedback = item?.feedback?.S?.trim();
      if (!billId || !feedback || isLegacyDismissRow(item)) {
        continue;
      }

      voteStates.set(billId.toLowerCase(), {
        billId,
        feedback,
        votedAt: item.votedAt?.S ?? null,
      });
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return voteStates;
}

async function loadManifestItems(updatedAfter: string): Promise<BillManifestEntry[]> {
  if (!MANIFEST_TABLE_NAME) {
    throw new Error("MANIFEST_TABLE_NAME is required");
  }

  const items: BillManifestEntry[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamo.send(
      new QueryCommand({
        TableName: MANIFEST_TABLE_NAME,
        KeyConditionExpression: "#pk = :pk AND #sk > :updatedAfter",
        ExpressionAttributeNames: {
          "#pk": MANIFEST_PRIMARY_KEY,
          "#sk": MANIFEST_SORT_KEY,
        },
        ExpressionAttributeValues: {
          ":pk": { S: MANIFEST_PK_VALUE },
          ":updatedAfter": { S: updatedAfter },
        },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const entry = toBillManifestEntry(item);
      if (entry) {
        items.push(entry);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return items;
}

async function loadMemberNameById(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!CONGRESS_MEMBERS_TABLE_NAME) {
    return names;
  }

  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamo.send(
      new ScanCommand({
        TableName: CONGRESS_MEMBERS_TABLE_NAME,
        ProjectionExpression: "#pk, #name, #chamber, #state, #party, district, depictionImageUrl, updatedAt",
        ExpressionAttributeNames: {
          "#pk": CONGRESS_MEMBERS_PRIMARY_KEY,
          "#name": "name",
          "#chamber": "chamber",
          "#state": "state",
          "#party": "party",
        },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const entry = toCongressMemberManifestEntry(item);
      if (entry) {
        names.set(entry.bioguideId.toUpperCase(), entry.name);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return names;
}

/** The published companion groups; empty when they are off, not configured or cannot be read. */
async function loadCompanionIndex(): Promise<CompanionIndex> {
  if (!companionDao) return new Map();
  try {
    return companionIndex(activeCompanionPairs(await companionDao.getCurrentGroups()));
  } catch (error) {
    logger.warn("Could not read the companion groups; the weekly digest lists each bill on its own", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return new Map();
  }
}

async function fetchProcessedBill(item: BillManifestEntry): Promise<ProcessedBillDocument | null> {
  if (!processedBillDao) {
    return null;
  }

  if (item.congress && item.billType) {
    return processedBillDao.getByGuidWithLocator({
      congress: item.congress,
      billType: item.billType,
      guid: item.guid,
    });
  }

  return processedBillDao.getByGuid(item.guid);
}

/** Loads a processed bill through the context's cache; a failed load yields null (the digest uses a placeholder). */
async function loadProcessedBill(
  context: WeeklyDigestGenerationContext,
  item: BillManifestEntry,
): Promise<ProcessedBillDocument | null> {
  let pending = context.processedBills.get(item.guid);
  if (!pending) {
    const load = fetchProcessedBill(item);
    context.processedBills.set(item.guid, load);
    load.catch(() => {
      if (context.processedBills.get(item.guid) === load) {
        context.processedBills.delete(item.guid);
      }
    });
    pending = load;
  }

  try {
    return await pending;
  } catch (error) {
    logger.warn("Failed to hydrate processed bill for weekly digest", { guid: item.guid, error });
    return null;
  }
}

/** Loads the shared inputs (manifest items and member names) for one publication window. */
export async function createWeeklyDigestGenerationContextForWindow(
  window: WeeklyDigestPublicationWindow,
): Promise<WeeklyDigestGenerationContext> {
  const [manifestItems, memberNameById, companions] = await Promise.all([
    loadManifestItems(window.start.toISOString()),
    loadMemberNameById(),
    loadCompanionIndex(),
  ]);

  return {
    window,
    manifestItems,
    memberNameById,
    processedBills: new Map(),
    companionIndex: companions,
  };
}

/** A fresh context (and bill cache) for the window published at or before `relativeTo`. */
export async function createWeeklyDigestGenerationContext(
  relativeTo: Date = new Date(),
): Promise<WeeklyDigestGenerationContext> {
  return createWeeklyDigestGenerationContextForWindow(latestPublishedWindow(relativeTo));
}

let sharedContext: { windowId: string; context: Promise<WeeklyDigestGenerationContext> } | undefined;

/**
 * The context for `window`, reused across invocations while the container is warm, so a worker
 * loads the manifest, the member names and each processed bill once per publication window
 * rather than once per message. Only the latest window is kept; a load that fails is not kept.
 */
export function sharedWeeklyDigestGenerationContext(
  window: WeeklyDigestPublicationWindow,
): Promise<WeeklyDigestGenerationContext> {
  if (sharedContext?.windowId === window.id) {
    return sharedContext.context;
  }

  const context = createWeeklyDigestGenerationContextForWindow(window);
  const entry = { windowId: window.id, context };
  sharedContext = entry;
  context.catch(() => {
    if (sharedContext === entry) {
      sharedContext = undefined;
    }
  });
  return context;
}

/**
 * The publication window whose id (its release instant, ISO-8601) is `windowId`, or null when
 * the id is not a release instant under the current schedule settings.
 */
export function weeklyDigestWindowFromId(windowId: string): WeeklyDigestPublicationWindow | null {
  const releaseAt = new Date(windowId);
  if (Number.isNaN(releaseAt.getTime())) {
    return null;
  }

  const window = latestPublishedWindow(releaseAt);
  return window.id === windowId ? window : null;
}

/** Body of a planner-to-worker message: generate `userIds`' digests for window `windowId`. */
export interface WeeklyDigestWorkMessage {
  windowId: string;
  userIds: string[];
}

/** Parses and validates a work message body; throws when it is not one. */
export function parseWeeklyDigestWorkMessage(body: string): WeeklyDigestWorkMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Weekly digest work message is not JSON");
  }

  const candidate = parsed as { windowId?: unknown; userIds?: unknown } | null;
  const windowId = typeof candidate?.windowId === "string" ? candidate.windowId.trim() : "";
  const userIds = Array.isArray(candidate?.userIds)
    ? candidate.userIds
        .filter((userId): userId is string => typeof userId === "string")
        .map((userId) => userId.trim())
        .filter((userId) => userId.length > 0)
    : [];

  if (!windowId || userIds.length === 0) {
    throw new Error("Weekly digest work message needs a windowId and at least one userId");
  }

  return { windowId, userIds: Array.from(new Set(userIds)) };
}

export async function generateWeeklyDigestForUser(
  userId: string,
  context: WeeklyDigestGenerationContext,
  options?: { skipIfExists?: boolean },
): Promise<WeeklyDigestGenerationResult> {
  const skipIfExists = options?.skipIfExists ?? true;
  if (skipIfExists) {
    const stored = await snapshotDao.get(userId, context.window.id);
    if (stored) {
      return {
        userId,
        status: "existing",
        digest: stored,
      };
    }
  }

  const [preferences, voteStatesByBillId] = await Promise.all([
    loadPreferencesForUser(userId),
    loadVoteStatesByBillId(userId),
  ]);

  const digest = await buildWeeklyDigest({
    window: context.window,
    preferences,
    voteStatesByBillId,
    manifestItems: context.manifestItems,
    memberNameById: context.memberNameById,
    loadProcessedBill: (item) => loadProcessedBill(context, item),
    companionIndex: context.companionIndex,
  });

  if (!digest) {
    return {
      userId,
      status: "empty",
      digest: null,
    };
  }

  await snapshotDao.put(userId, digest);
  return {
    userId,
    status: "stored",
    digest,
  };
}

export interface WeeklyDigestBatchResult {
  stored: number;
  existing: number;
  empty: number;
  failed: number;
  /** Users never started because `shouldStart` returned false. */
  notStarted: number;
  failedUserIds: string[];
}

/**
 * Generates the digest for each user, `concurrency` at a time, skipping users whose snapshot for
 * the window already exists. A user's failure is logged and counted; it never stops the others.
 * `shouldStart` is asked before each user; once it returns false no further user is started
 * (users already running finish) and the rest are counted as not started.
 */
export async function generateWeeklyDigestsForUsers(
  userIds: readonly string[],
  context: WeeklyDigestGenerationContext,
  options: { concurrency?: number; shouldStart?: () => boolean } = {},
): Promise<WeeklyDigestBatchResult> {
  const result: WeeklyDigestBatchResult = {
    stored: 0,
    existing: 0,
    empty: 0,
    failed: 0,
    notStarted: 0,
    failedUserIds: [],
  };
  let stopped = false;

  await mapWithConcurrency(userIds, options.concurrency ?? WEEKLY_DIGEST_USER_CONCURRENCY, (userId) => {
    if (stopped || (options.shouldStart && !options.shouldStart())) {
      stopped = true;
      result.notStarted += 1;
      return Promise.resolve();
    }

    return logger.withKeys({ userId }, async () => {
      try {
        const generated = await generateWeeklyDigestForUser(userId, context, { skipIfExists: true });
        result[generated.status] += 1;
      } catch (error) {
        result.failed += 1;
        result.failedUserIds.push(userId);
        logger.error("Weekly digest generation failed for user", { windowId: context.window.id, error });
      }
    });
  });

  return result;
}
