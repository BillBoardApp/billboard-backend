import { DynamoDBClient, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type {
  BillsManifestItemV1 as BillManifestEntry,
  BillsManifestV1 as BillsManifest,
  CompanionGroupV1,
} from "../contracts";
import { BillPriorityDao } from "../adapters/billPriorityDao";
import type { BillPriorityRecord } from "../models/billPriority";
import { mergePriorityIntoManifestEntry, priorityFirstRankValue } from "./billPriority";
import { logger } from "./logger";

/**
 * Builds the bills manifest from the manifest table (CAP-01). Shared by fetchBillsManifest, which
 * serves windowed (updatedAfter) loads and the inline fallback, and publishBillsManifest, which
 * writes the full manifest to S3 as a gzip snapshot.
 *
 * Every manifest item sits under one partition value (PK_VALUE, "BILL") with the sort key
 * "<updatedAt>#<guid>", so a full build reads the whole partition and a windowed build reads only
 * the items whose sort key is after updatedAfter. Active bill priorities are merged in and the
 * entries are sorted priority first, then newest first, then by guid.
 *
 * INT-11: no entry carries voteCount, and nothing is ordered by it. A bill's vote count is an aggregate
 * of other users' votes, which nobody may see before voting on that bill, and the manifest goes to every
 * signed-in user (and, as the S3 snapshot, to anyone holding a pointer). The manifest row keeps its
 * voteCount attribute (BillStatsAggregator writes it); this builder no longer reads it.
 *
 * One bill has one row, but the pre-remediation upsert (delete, put, re-point the lookup, not in a
 * transaction) left stale copies of some bills under older sort keys (CAP-13). The build keeps
 * only the newest row of each guid, so neither the snapshot nor the inline manifest carries a bill
 * twice; a one-time cleanup deleted the stale rows.
 */

/** Where the manifest comes from: the manifest table, and the priority table when configured. */
export interface BillsManifestSource {
  ddb: DynamoDBClient;
  tableName: string | undefined;
  primaryKey: string;
  pkValue: string;
  /** Null when PRIORITY_TABLE_NAME or PRIORITY_ACTIVE_INDEX_NAME is unset: no priority merge. */
  priorityDao: BillPriorityDao | null;
}

export interface BuildBillsManifestOptions {
  /** Only items whose sort key is after this value (a windowed load). Absent: the full manifest. */
  updatedAfter?: string;
  /**
   * Companion groups (APPF-23) to return as `companionGroups`, after `bills`, as given (the caller
   * sorts them). Absent: the field is left out, as before.
   */
  companionGroups?: CompanionGroupV1[];
}

// The manifest table's sort key is "<updatedAt>#<guid>".
const SORT_KEY_ATTRIBUTE = "sk";

type ManifestItem = Record<string, AttributeValue>;

const VALID_BILL_STATUSES: ReadonlySet<string> = new Set(["New", "Updated", "Passed", "Failed", "Finalized"]);

/**
 * The source configured by the handler environment: TABLE_NAME, PRIMARY_KEY (default "pk"),
 * PK_VALUE (default "BILL") and the PRIORITY_* variables.
 */
export const billsManifestSourceFromEnv = (
  ddb: DynamoDBClient,
  env: NodeJS.ProcessEnv = process.env,
): BillsManifestSource => {
  const priorityTableName = env.PRIORITY_TABLE_NAME;
  const priorityActiveIndexName = env.PRIORITY_ACTIVE_INDEX_NAME;
  return {
    ddb,
    tableName: env.TABLE_NAME,
    primaryKey: env.PRIMARY_KEY ?? "pk",
    pkValue: env.PK_VALUE ?? "BILL",
    priorityDao:
      priorityTableName && priorityActiveIndexName
        ? new BillPriorityDao(ddb, {
            tableName: priorityTableName,
            partitionKey: env.PRIORITY_TABLE_PARTITION_KEY ?? "guid",
            activeIndexName: priorityActiveIndexName,
            statusAttribute: env.PRIORITY_STATUS_ATTRIBUTE ?? "status",
            prioritySortKeyAttribute: env.PRIORITY_SORT_KEY_ATTRIBUTE ?? "prioritySortKey",
            activeStatusValue: (env.PRIORITY_ACTIVE_STATUS_VALUE ?? "ACTIVE") as "ACTIVE",
          })
        : null,
  };
};

/** A trimmed, non-empty updatedAfter, or undefined. */
export const normalizeUpdatedAfter = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const toStringList = (value: AttributeValue | undefined): string[] => {
  const list = value?.L;
  if (!Array.isArray(list)) return [];
  return list.map((v) => (typeof v?.S === "string" ? v.S : "")).filter((v) => v.length > 0);
};

const toNumberMap = (value: AttributeValue | undefined): Record<string, number> | undefined => {
  const map = value?.M;
  if (!map || typeof map !== "object") return undefined;
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(map)) {
    // parseFloat applies ToString itself, so String() changes nothing (undefined still gives NaN).
    const num = parseFloat(String(val?.N));
    if (!isNaN(num)) result[key] = num;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

/**
 * Priority bills first (by rank), then newest updatedAt, then guid. Never by vote count (INT-11): even
 * the order would reveal which bills other users voted on most.
 */
export const compareManifestEntries = (lhs: BillManifestEntry, rhs: BillManifestEntry): number => {
  const leftPriorityRank = priorityFirstRankValue(lhs);
  const rightPriorityRank = priorityFirstRankValue(rhs);
  if (leftPriorityRank !== rightPriorityRank) {
    return leftPriorityRank - rightPriorityRank;
  }

  const dateComparison = (rhs.updatedAt ?? "").localeCompare(lhs.updatedAt ?? "");
  if (dateComparison !== 0) return dateComparison;

  return (lhs.guid ?? "").localeCompare(rhs.guid ?? "");
};

/**
 * A manifest table item as a manifest entry, or null when it has no guid or billType. The item's
 * voteCount is left out (INT-11); clients decode the field as optional.
 */
export const toManifestEntry = (item: ManifestItem | null | undefined): BillManifestEntry | null => {
  if (!item) return null;
  const guid = item.guid?.S ?? "";
  const billType = item.billType?.S ?? "";
  if (!guid || !billType) return null;

  const billStatus = item.billStatus?.S ?? undefined;
  const civicProfile = toNumberMap(item.civicProfile);

  return {
    guid,
    billType,
    congress: item.congress?.S ?? "",
    billNumber: item.billNumber?.S ?? "",
    updatedAt: item.updatedAt?.S ?? "",
    title: item.title?.S ?? "",
    subCategories: toStringList(item.subCategories),
    lifeAreas: toStringList(item.lifeAreas),
    sponsors: toStringList(item.sponsors),
    cosponsors: toStringList(item.cosponsors),
    ...(billStatus && VALID_BILL_STATUSES.has(billStatus)
      ? { billStatus: billStatus as BillManifestEntry["billStatus"] }
      : {}),
    ...(civicProfile ? { civicProfile } : {}),
  };
};

/**
 * Reads the manifest partition (all of it, or the items after updatedAfter), merges active
 * priorities and returns the sorted manifest. DynamoDB and priority-table errors propagate.
 *
 * Memory: each 1 MB query page is converted and dropped before the next is read, entries without
 * an active priority are kept as built (no copy), one entry per guid is held, and the array is
 * sorted in place.
 */
export const buildBillsManifest = async (
  source: BillsManifestSource,
  options: BuildBillsManifestOptions = {},
): Promise<BillsManifest> => {
  if (!source.tableName) throw new Error("Missing env var TABLE_NAME");

  const activePriorityMap = source.priorityDao
    ? new Map((await source.priorityDao.listActive()).map((record) => [record.guid, record]))
    : new Map<string, BillPriorityRecord>();
  const updatedAfter = normalizeUpdatedAfter(options.updatedAfter);

  // guid -> the entry built from its newest row (greatest sort key, i.e. latest updatedAt).
  const newestByGuid = new Map<string, { sortKey: string; entry: BillManifestEntry }>();
  let duplicateRows = 0;
  let startKey: ManifestItem | undefined;
  do {
    const result = await source.ddb.send(
      new QueryCommand({
        TableName: source.tableName,
        KeyConditionExpression: updatedAfter ? "#pk = :pk AND #sk > :updatedAfter" : "#pk = :pk",
        ExpressionAttributeNames: {
          "#pk": source.primaryKey,
          ...(updatedAfter ? { "#sk": SORT_KEY_ATTRIBUTE } : {}),
        },
        ExpressionAttributeValues: {
          ":pk": { S: source.pkValue },
          ...(updatedAfter ? { ":updatedAfter": { S: updatedAfter } } : {}),
        },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const entry = toManifestEntry(item);
      if (!entry) continue;
      const sortKey = item[SORT_KEY_ATTRIBUTE]?.S ?? entry.updatedAt ?? "";
      const kept = newestByGuid.get(entry.guid);
      if (kept) {
        duplicateRows += 1;
        // Rows arrive in sort-key order, so the later one is newer; compare anyway.
        if (kept.sortKey > sortKey) continue;
      }
      const priority = activePriorityMap.get(entry.guid);
      newestByGuid.set(entry.guid, {
        sortKey,
        entry: priority ? mergePriorityIntoManifestEntry(entry, priority) : entry,
      });
    }

    startKey = result.LastEvaluatedKey;
  } while (startKey);

  if (duplicateRows > 0) {
    logger.info("Dropped stale duplicate bills manifest rows", {
      duplicateRows,
      updatedAfter,
    });
  }
  const bills = Array.from(newestByGuid.values(), ({ entry }) => entry);

  return {
    generatedAt: new Date().toISOString(),
    count: bills.length,
    bills: bills.sort(compareManifestEntries),
    ...(options.companionGroups ? { companionGroups: options.companionGroups } : {}),
  };
};
