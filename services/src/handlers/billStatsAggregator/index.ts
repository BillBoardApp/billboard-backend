import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, DynamoDBStreamEvent } from "aws-lambda";
import { activeCompanionPairs, BillCompanionDao, type CompanionGroupsState } from "../../adapters/billCompanionDao";
import type { CompanionGroupV1 } from "../../contracts";
import {
  COMPANION_STATS_KEY_PREFIX,
  companionIndex,
  companionStatsKey,
  plainBillGuid,
  type CompanionIndex,
} from "../../shared/billCompanions";
import {
  computeRawBillStats,
  computeRawCompanionStats,
  isCountedVote,
  MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE,
  writeCachedStats,
} from "../../shared/billStats";
import { mapWithConcurrency } from "../../shared/concurrency";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY!;
const BILL_ID_INDEX_NAME = process.env.BILL_ID_INDEX_NAME!;

const STATS_TABLE_NAME = process.env.STATS_TABLE_NAME;
const STATS_PARTITION_KEY = process.env.STATS_PARTITION_KEY ?? SORT_KEY;
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME;
const MANIFEST_PRIMARY_KEY = process.env.MANIFEST_PRIMARY_KEY ?? "pk";
const MANIFEST_SORT_KEY = process.env.MANIFEST_SORT_KEY ?? "sk";
const MANIFEST_PK_VALUE = process.env.MANIFEST_PK_VALUE ?? "BILL";
const MANIFEST_GUID_LOOKUP_PK = process.env.MANIFEST_GUID_LOOKUP_PK ?? `${MANIFEST_PK_VALUE}_GUID`;
// Distinct bills recomputed at once. Each holds one 1 MB query page at a time, so memory stays flat.
const BILL_STATS_CONCURRENCY = Math.max(1, Number.parseInt(process.env.BILL_STATS_CONCURRENCY ?? "4", 10) || 4);

const db = new DynamoDBClient({});

// APPF-23 companion groups: a recompute of a grouped bill also recomputes the group's combined stats
// document (billId companionStatsKey(group), one vote per person), once per group per invocation.
// The groups are the ones PublishBillsManifest last published (none while they are turned off), read
// at most every 60 s. They need MANIFEST_TABLE_NAME: TABLE_NAME here is the feedback table.
const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";
const companionDao = MANIFEST_TABLE_NAME?.trim() ? new BillCompanionDao(db) : null;
let companionIndexFor: { state: CompanionGroupsState | null; index: CompanionIndex } | undefined;

/** A direct invoke names the bills itself: { billId } or { billIds: [...] }. */
type DirectInvokeEvent = { billId?: string; billIds?: unknown[] };

/**
 * Production runs on the feedback table's DynamoDB stream. An API Gateway request (billId in the
 * query string or body) and a direct invoke are also accepted.
 */
type BillStatsAggregatorEvent = DynamoDBStreamEvent | APIGatewayProxyEvent | DirectInvokeEvent;

/** Any of the accepted events, read field by field. */
type EventFields = Partial<DynamoDBStreamEvent & APIGatewayProxyEvent & DirectInvokeEvent>;

type AggregationSummary = {
  processedBillIds: string[];
  updatedCount: number;
  /** APPF-23: the companion group stats documents recomputed too (present only when there were any). */
  companionStatsKeys?: string[];
};

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter((v) => v.length > 0)));
}

function parseBodyObject(event: EventFields): Record<string, unknown> {
  try {
    if (!event?.body || typeof event.body !== "string") return {};
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function isStreamEvent(event: EventFields): boolean {
  return (
    Array.isArray(event?.Records) &&
    event.Records.some(
      (record) =>
        (record?.eventSource || (record as { EventSource?: string } | undefined)?.EventSource) === "aws:dynamodb",
    )
  );
}

type StreamBillIds = { billIds: string[]; skippedRecords: number };

/**
 * The bills a stream batch can have changed. The stream carries NEW_IMAGE only, so a MODIFY or
 * REMOVE says nothing about the vote it replaced and always recomputes its bill. The one record
 * provably irrelevant is an INSERT of an item the stats do not count (not adult-eligible, not a
 * Yea/Nay/Abstain vote, or a 1.0 or 1.1 dismissal marked legacyDismiss, INT-11): the item did not
 * exist before and is not counted now. So the legacy-dismissal repair marking a stored row (a MODIFY)
 * recomputes its bill, and its companion group, without it.
 */
function billIdsFromStreamRecords(event: EventFields): StreamBillIds {
  if (!Array.isArray(event?.Records)) return { billIds: [], skippedRecords: 0 };

  const collected: string[] = [];
  let skippedRecords = 0;
  for (const record of event.Records) {
    const source = record?.eventSource || (record as { EventSource?: string } | undefined)?.EventSource;
    if (source !== "aws:dynamodb") continue;

    const newImage = record?.dynamodb?.NewImage;
    if (record?.eventName === "INSERT" && newImage && !isCountedVote(newImage)) {
      skippedRecords += 1;
      continue;
    }

    const fromNewImage = newImage?.[SORT_KEY]?.S;
    const fromKeys = record?.dynamodb?.Keys?.[SORT_KEY]?.S;
    if (typeof fromNewImage === "string" && fromNewImage.trim()) {
      collected.push(fromNewImage);
      continue;
    }
    if (typeof fromKeys === "string" && fromKeys.trim()) {
      collected.push(fromKeys);
    }
  }

  return { billIds: uniqueNonEmpty(collected), skippedRecords };
}

function resolveBillIds(event: EventFields): string[] {
  const directBillId =
    (typeof event?.billId === "string" && event.billId) ||
    (typeof event?.queryStringParameters?.billId === "string" && event.queryStringParameters.billId);
  if (directBillId) return uniqueNonEmpty([directBillId]);

  const fromArray = Array.isArray(event?.billIds) ? event.billIds.filter((v: unknown) => typeof v === "string") : [];
  if (fromArray.length > 0) return uniqueNonEmpty(fromArray);

  const body = parseBodyObject(event);
  const bodyBillId = typeof body.billId === "string" ? body.billId : "";
  if (bodyBillId) return uniqueNonEmpty([bodyBillId]);
  if (Array.isArray(body.billIds)) {
    return uniqueNonEmpty(body.billIds.filter((v: unknown) => typeof v === "string"));
  }

  return [];
}

function response(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isApiInvocation(event: EventFields): boolean {
  return Boolean(event?.requestContext);
}

// One retry covers createBillsManifest moving the row between the lookup read and the update.
const MANIFEST_VOTE_COUNT_ATTEMPTS = 2;

/** "superseded": a computation that started later already wrote the row's count; nothing was written. */
export type ManifestVoteCountOutcome = "updated" | "superseded" | "missing" | "failed" | "disabled";

/**
 * Sets `voteCount` on the bill's manifest row, with `voteCountComputedFrom` = computationStartedAt
 * (when the computation began reading votes). Recomputes of one bill can run at once and finish in
 * any order; the update is conditional on no later-started computation having written first, so
 * the count never goes backwards. Never throws: a failure is logged and reported in the outcome
 * (scripts/backfillManifestVoteCounts.ts counts them).
 */
export async function updateManifestVoteCount(
  billId: string,
  voteCount: number,
  computationStartedAt: string,
): Promise<ManifestVoteCountOutcome> {
  if (!MANIFEST_TABLE_NAME) return "disabled";

  try {
    for (let attempt = 1; attempt <= MANIFEST_VOTE_COUNT_ATTEMPTS; attempt += 1) {
      const lookup = await db.send(
        new GetItemCommand({
          TableName: MANIFEST_TABLE_NAME,
          Key: {
            [MANIFEST_PRIMARY_KEY]: { S: MANIFEST_GUID_LOOKUP_PK },
            [MANIFEST_SORT_KEY]: { S: billId },
          },
          ProjectionExpression: "manifestSk",
          ConsistentRead: true,
        }),
      );

      const manifestSk = lookup.Item?.manifestSk?.S;
      if (!manifestSk) return "missing";

      try {
        await db.send(
          new UpdateItemCommand({
            TableName: MANIFEST_TABLE_NAME,
            Key: {
              [MANIFEST_PRIMARY_KEY]: { S: MANIFEST_PK_VALUE },
              [MANIFEST_SORT_KEY]: { S: manifestSk },
            },
            UpdateExpression: "SET voteCount = :voteCount, #computedFrom = :computedFrom",
            // attribute_exists: an update racing a manifest rewrite must not recreate a bare row at the old key.
            ConditionExpression:
              "attribute_exists(#pk) AND (attribute_not_exists(#computedFrom) OR #computedFrom <= :computedFrom)",
            ExpressionAttributeNames: {
              "#pk": MANIFEST_PRIMARY_KEY,
              "#computedFrom": MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE,
            },
            ExpressionAttributeValues: {
              ":voteCount": { N: String(Math.max(0, Math.trunc(voteCount))) },
              ":computedFrom": { S: computationStartedAt },
            },
            // The row comes back on a failed condition: present means a later computation won,
            // absent means the row moved.
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          }),
        );
        return "updated";
      } catch (err) {
        if ((err as { name?: unknown } | null)?.name !== "ConditionalCheckFailedException") throw err;
        if ((err as { Item?: unknown }).Item) {
          console.log("billStatsAggregator kept a manifest voteCount from a later-started recompute:", billId);
          return "superseded";
        }
      }
    }
    console.warn("billStatsAggregator could not find the manifest row to update voteCount:", billId);
    return "missing";
  } catch (err) {
    console.warn("billStatsAggregator failed to update manifest voteCount:", billId, err);
    return "failed";
  }
}

/**
 * Recomputes one bill from all of its votes and stores the result. A computation that another,
 * later-started one has already superseded stores nothing and leaves the manifest count alone.
 */
async function recomputeBill(billId: string): Promise<void> {
  const computationStartedAt = new Date().toISOString();
  const stats = await computeRawBillStats({
    db,
    tableName: TABLE_NAME,
    partitionKey: PARTITION_KEY,
    sortKey: SORT_KEY,
    billIdIndexName: BILL_ID_INDEX_NAME,
    billId,
  });

  // writeCachedStats applies the sample floor before storing.
  const outcome = await writeCachedStats({
    db,
    statsTableName: STATS_TABLE_NAME,
    statsPartitionKey: STATS_PARTITION_KEY,
    stats,
    computationStartedAt,
  });
  if (outcome === "superseded") {
    console.log("billStatsAggregator skipped a stale recompute; a later one already stored the stats:", billId);
    return;
  }

  // The feed ranks on verified Yea/Nay votes only, so self-attested votes cannot reorder it.
  // The unfloored count is used: a count discloses nobody's choice, and the floor would zero it.
  await updateManifestVoteCount(billId, stats.segments.verified.decisionVotes, computationStartedAt);
}

/**
 * The companion groups of these bills (a suffixed id counts as its plain guid), each once. None when
 * groups are off or not configured; a failed read of the groups is logged and also gives none, so the
 * per-bill stats are never held back by it.
 */
async function companionGroupsOf(billIds: readonly string[]): Promise<CompanionGroupV1[]> {
  if (!companionDao || !STATS_TABLE_NAME) return [];
  let index: CompanionIndex;
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    if (companionIndexFor?.state !== state) {
      companionIndexFor = { state, index: companionIndex(activeCompanionPairs(state)) };
    }
    index = companionIndexFor.index;
  } catch (error) {
    logger.warn("billStatsAggregator could not read the companion groups; group stats not recomputed", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return [];
  }

  const groups = new Map<string, CompanionGroupV1>();
  for (const billId of billIds) {
    const plain = plainBillGuid(billId);
    const group = plain ? index.get(plain) : undefined;
    if (group) groups.set(companionStatsKey(group), group);
  }
  return Array.from(groups.values());
}

/**
 * Recomputes a companion group's combined stats from every member's votes (the primary's row wins
 * per user) and stores them under companionStatsKey(group), with the same computationStartedAt
 * ordering as a bill. The manifest voteCount is never touched for a group: each member's row keeps
 * its own count.
 */
async function recomputeCompanionGroup(group: CompanionGroupV1): Promise<void> {
  const statsKey = companionStatsKey(group);
  const computationStartedAt = new Date().toISOString();
  const stats = await computeRawCompanionStats({
    db,
    tableName: TABLE_NAME,
    userIdAttribute: PARTITION_KEY,
    sortKey: SORT_KEY,
    billIdIndexName: BILL_ID_INDEX_NAME,
    statsKey,
    memberGuids: group.memberGuids,
  });

  const outcome = await writeCachedStats({
    db,
    statsTableName: STATS_TABLE_NAME,
    statsPartitionKey: STATS_PARTITION_KEY,
    stats,
    computationStartedAt,
  });
  if (outcome === "superseded") {
    logger.info("billStatsAggregator skipped a stale companion group recompute; a later one already stored it", {
      statsKey,
    });
  }
}

/** A stats document key that is not a bill (a companion group's): never recomputed as a bill. */
function isCompanionStatsKey(billId: string): boolean {
  return billId.startsWith(COMPANION_STATS_KEY_PREFIX);
}

export async function handler(event: BillStatsAggregatorEvent): Promise<APIGatewayProxyResult | AggregationSummary> {
  try {
    const fields = event as EventFields;
    let billIds: string[];
    if (isStreamEvent(fields)) {
      const fromStream = billIdsFromStreamRecords(fields);
      billIds = fromStream.billIds;
      console.log("billStatsAggregator stream batch", {
        records: fields.Records?.length ?? 0,
        skippedRecords: fromStream.skippedRecords,
        distinctBills: billIds.length,
      });
    } else {
      billIds = resolveBillIds(fields);
    }

    // A group's stats key named directly would otherwise be recomputed as a bill with no votes.
    const groupKeysNamed = billIds.filter(isCompanionStatsKey);
    if (groupKeysNamed.length > 0) {
      logger.warn("billStatsAggregator ignored companion group stats keys; recompute a member bill instead", {
        statsKeys: groupKeysNamed,
      });
      billIds = billIds.filter((billId) => !isCompanionStatsKey(billId));
    }

    if (billIds.length === 0) {
      if (isApiInvocation(event)) {
        return response(400, { error: "Missing billId" });
      }
      return { processedBillIds: [], updatedCount: 0 };
    }

    // Each distinct bill is recomputed once per invocation, however many of its votes the batch holds.
    // A failure stops new bills from starting and is rethrown once the ones in flight settle, so the
    // stream mapping retries the batch; recomputing a bill that already succeeded is harmless.
    await mapWithConcurrency(billIds, BILL_STATS_CONCURRENCY, recomputeBill);

    // Then each companion group any of those bills belongs to, once, after its members' own stats.
    // A failure is rethrown like a bill's, so the stream mapping retries the batch.
    const groups = await companionGroupsOf(billIds);
    await mapWithConcurrency(groups, BILL_STATS_CONCURRENCY, recomputeCompanionGroup);

    const result: AggregationSummary = {
      processedBillIds: billIds,
      updatedCount: billIds.length,
      ...(groups.length > 0 ? { companionStatsKeys: groups.map(companionStatsKey) } : {}),
    };

    if (isApiInvocation(event)) {
      return response(200, result);
    }
    return result;
  } catch (err) {
    console.error("billStatsAggregator failed:", err);
    if (isApiInvocation(event)) {
      return response(500, { error: "Internal server error" });
    }
    throw err;
  }
}

export default { handler };
