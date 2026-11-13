#!/usr/bin/env node

// Re-date of BillsManifest rows to the date the manifest date rule gives them (docs/RUNBOOK.md 4.9). A BILL row's
// updatedAt, and its sort key <updatedAt>#<guid>, is the storedAt of the processed bill it was dated by, and the apps'
// "recently updated" windows and Bills list order, the weekly digest and the priority resolver select bills by it.
// A bulk reprocess or re-summary can move many rows to a new date although only bookkeeping changed. This plans by the
// rule CreateBillsManifest dates rows by (shared/billVersionChange.ts manifestDateMoves: only a status, a newer action
// or another action on the latest date, or another text moves a row), so its dry run lists the rows a reprocess,
// re-summary or detail change moved for no news. Dry run by default.
//
// Dry run (reads only): every BILL row with a sort key at or after --since (default DEFAULT_SINCE; pass the start of
// the run being checked) is read with a consistent Query. A row is planned when its BILL_GUID lookup names it, its
// processed bill's latest version is the one it reflects (its contentHash, or its updatedAt equal to that version's
// storedAt), and the baseline (newest first, the first version written before --since, never past a delete marker)
// exists. Each version after the baseline is then judged against the one before it, as CreateBillsManifest judges a
// version against the row's (manifestDateMoves, with each version's source-text-hash S3 metadata), and the row's
// target is the storedAt of the last version that brought news, or the baseline's when none did: the row's updatedAt
// while that version was current (a row can be dated a second or two after its storedAt, so it can land about that
// much earlier than it was; RUNBOOK 4.9). A row already at that date, or whose latest version brought news,
// is "dated". A row is skipped when a BILL row exists at the target, when the target is not older, or when the bill
// has an ACTIVE BillPriority record. A bill first published after --since has no baseline and is never planned. The
// plan goes to --plan-file (redate-manifest-rows-plan-<UTC time>.jsonl by default, never overwritten), one line per
// row, sorted by guid, with the row and lookup as read.
//
// --apply --plan-file <reviewed plan> applies that plan's lines only, never a fresh classification, one at a time and
// paced (--rate, default 5 a second; --stop-after, default 420 s; Ctrl-C lets the line in flight finish). It first
// refuses (exit code 2) unless BillsManifestQueue and BillsManifestDLQ hold no message (visible, in flight or delayed).
// Per line: no ACTIVE priority (best effort: an eventually consistent read before the move, which cannot stop the
// hourly BillPriorityResolver from activating a bill it read as a candidate just before; RUNBOOK 4.9 starts the apply
// between its runs); the lookup (consistent) still names the row (or already the target: alreadyRedated); the row
// (consistent) still has the plan's updatedAt (and contentHash); the processed bill's latest VersionId is still the
// plan's (HEAD). Then one TransactWriteItems: delete the row (its updatedAt, vote state and contentHash as read), put it
// at the target with updatedAt and the plan's contentHash (attribute_not_exists), and point the lookup at it with the
// same updatedAt (manifestSk as read). Each applied or alreadyRedated line's undo record (rows and lookups before and
// after, DynamoDB JSON) is appended to --undo-file (redate-manifest-rows-undo-<UTC time>.jsonl), created before the
// first write; an alreadyRedated record covers a move whose run stopped before writing its own. --undo <file> moves the
// rows of an undo file (or of a plan file) back (dry run unless --apply): only a row still at its target with the
// target's updatedAt.
//
// No S3 write, SQS send, push or Bedrock call. Run --apply only from a reviewed plan, right after a PublishBillsManifest
// run between :10 and :45 past the hour (RUNBOOK 4.9 has the start window, the checks, the freeze and the undo).

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

import { BillPriorityDao } from "../src/adapters/billPriorityDao";
import { BillStorage } from "../src/adapters/billStorage";
import { ACTIVE_PRIORITY_STATUS } from "../src/models/billPriority";
import { plainBillGuid } from "../src/shared/billCompanions";
import { MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE } from "../src/shared/billStats";
import {
  MANIFEST_CONTENT_HASH_ATTRIBUTE,
  billContentHash,
  classifyBillVersionChange,
  contentHashChangeClass,
  manifestDateBasis,
  manifestDateMoves,
  manifestSortKey,
  manifestTimestamp,
  type ManifestDateMove,
} from "../src/shared/billVersionChange";
import { readProcessedSource } from "../src/shared/billSourceReconcile";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { backoffDelayMs, sleep as sleepMs } from "../src/shared/retry";

type Item = Record<string, AttributeValue>;
type TableSender = Pick<DynamoDBClient, "send">;
type QueueSender = Pick<SQSClient, "send">;
type PriorityReader = Pick<BillPriorityDao, "getByGuid">;
type Log = (...args: unknown[]) => void;

// ─── Configuration and arguments ────────────────────────────────────────────

/** Bucket, table, key and queue names; the defaults are production's (infra/lib/config). */
export interface RedateConfig {
  region: string;
  bucket: string;
  processedPrefix: string;
  manifestTableName: string;
  manifestPrimaryKey: string;
  manifestSortKey: string;
  manifestPkValue: string;
  guidLookupPk: string;
  priorityTableName: string;
  priorityPartitionKey: string;
  manifestQueueName: string;
  manifestDlqName: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): RedateConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  processedPrefix: env.PROCESSED_BILLS_PREFIX || "processed-bills/",
  manifestTableName: env.MANIFEST_TABLE_NAME || "BillsManifest",
  manifestPrimaryKey: env.MANIFEST_PRIMARY_KEY || "pk",
  manifestSortKey: env.MANIFEST_SORT_KEY || "sk",
  manifestPkValue: env.MANIFEST_PK_VALUE || "BILL",
  guidLookupPk: env.MANIFEST_GUID_LOOKUP_PK || "BILL_GUID",
  priorityTableName: env.PRIORITY_TABLE_NAME || "BillPriority",
  priorityPartitionKey: env.PRIORITY_TABLE_PARTITION_KEY || "guid",
  manifestQueueName: env.BILLS_MANIFEST_QUEUE_NAME || "BillsManifestQueue",
  manifestDlqName: env.BILLS_MANIFEST_DLQ_NAME || "BillsManifestDLQ",
});

/** The default --since: a fixed time that predates every bulk run this tool was written for. Pass --since for a window. */
export const DEFAULT_SINCE = "2026-10-11T19:00:00.000Z";
export const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;
// Project decision (RUNBOOK 4.9): PublishBillsManifest is not paused during the apply. A move takes a row from the tail
// of the BILL partition to its head, so a paginated full read running at the same time can miss it; the apply starts
// right after a publish run, takes a few minutes for a few hundred lines at this pace, and stops by itself at
// DEFAULT_STOP_AFTER_SECONDS, before the next run (every 10 minutes).
export const DEFAULT_RATE = 5;
const MAX_RATE = 10;
export const DEFAULT_STOP_AFTER_SECONDS = 420;
// Project decision (RUNBOOK 4.9): the re-date is applied before the next digest even if the prevention change is not
// live on CreateBillsManifest:prod by then; freeze A holds until it is. true makes --apply also require
// --prevention-live, the operator's statement that check P1 passed.
export const APPLY_REQUIRES_PREVENTION_LIVE = false;
/** The days of the apps' default "recently updated" window, for the plan's before and after count. */
const WINDOW_DAYS = 7;
const MAX_APPLY_ATTEMPTS = 3;
const APPLY_RETRY_BACKOFF = { baseMs: 100, maxMs: 1000 };
const PLAN_FILE_PREFIX = "redate-manifest-rows-plan-";
const UNDO_FILE_PREFIX = "redate-manifest-rows-undo-";

export interface CliOptions {
  help: boolean;
  apply: boolean;
  /** Only these bills (plain guids). */
  guids: string[];
  /** At most this many rows read (dry run) or lines applied or undone; null for all. */
  limit: number | null;
  since: string;
  concurrency: number;
  /** Transactions a second, at most. */
  rate: number;
  stopAfterSeconds: number;
  /** The dry run's output, or the plan --apply applies; null for the default name (dry run only). */
  planFile: string | null;
  /** Where --apply appends the undo records; null for the default name. */
  undoFile: string | null;
  /** An undo file to move back (dry run unless --apply). */
  undo: string | null;
  preventionLive: boolean;
}

const valueAfter = (argv: readonly string[], index: number, flag: string, what: string): string => {
  const raw = argv[index];
  if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return raw;
};

const wholeNumber = (raw: string, flag: string, min: number, max: number): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${flag} needs a whole number from ${min} to ${max}`);
  }
  return value;
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    guids: [],
    limit: null,
    since: DEFAULT_SINCE,
    concurrency: DEFAULT_CONCURRENCY,
    rate: DEFAULT_RATE,
    stopAfterSeconds: DEFAULT_STOP_AFTER_SECONDS,
    planFile: null,
    undoFile: null,
    undo: null,
    preventionLive: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--prevention-live") options.preventionLive = true;
    else if (arg === "--guid") {
      const raw = argv[(index += 1)];
      const guid = raw && !raw.startsWith("--") ? plainBillGuid(raw) : null;
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hr2743");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--limit") {
      options.limit = wholeNumber(valueAfter(argv, (index += 1), arg, "a number"), arg, 1, Number.MAX_SAFE_INTEGER);
    } else if (arg === "--since") {
      const since = manifestTimestamp(valueAfter(argv, (index += 1), arg, "an ISO time"));
      if (!since) throw new Error("--since needs an ISO time such as 2026-10-11T19:00:00.000Z");
      options.since = since;
    } else if (arg === "--concurrency") {
      options.concurrency = wholeNumber(valueAfter(argv, (index += 1), arg, "a number"), arg, 1, MAX_CONCURRENCY);
    } else if (arg === "--rate") {
      options.rate = wholeNumber(valueAfter(argv, (index += 1), arg, "a number"), arg, 1, MAX_RATE);
    } else if (arg === "--stop-after") {
      options.stopAfterSeconds = wholeNumber(valueAfter(argv, (index += 1), arg, "seconds"), arg, 1, 86400);
    } else if (arg === "--plan-file") {
      options.planFile = valueAfter(argv, (index += 1), arg, "a file path");
    } else if (arg === "--undo-file") {
      options.undoFile = valueAfter(argv, (index += 1), arg, "a file path");
    } else if (arg === "--undo") {
      options.undo = valueAfter(argv, (index += 1), arg, "an undo file");
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.undo && (options.planFile || options.undoFile)) {
    throw new Error("--undo takes neither --plan-file nor --undo-file");
  }
  if (options.apply && !options.undo && !options.planFile) {
    throw new Error("--apply needs --plan-file <the reviewed dry-run plan>");
  }
  return options;
};

const USAGE = [
  "Move BillsManifest rows dated after --since back to their earlier date when nothing new happened to the bill since",
  "then: no status change, newer action, other action on the latest date or other text (docs/RUNBOOK.md 4.9).",
  "",
  "Usage:",
  "  npm run redate:manifest-rows                                          Dry run: writes the plan (reads only)",
  "  npm run redate:manifest-rows -- --apply --plan-file <plan> --guid G   Apply one bill of a reviewed plan",
  "  npm run redate:manifest-rows -- --apply --plan-file <plan>            Apply a reviewed plan",
  "  npm run redate:manifest-rows -- --undo <undo file> [--apply]          Move applied rows back (dry run first)",
  "",
  "Options:",
  "  --apply              Write (the default is a dry run, which only reads)",
  `  --plan-file <path>   Dry run: where the plan goes (default ${PLAN_FILE_PREFIX}<UTC time>.jsonl); --apply: the`,
  "                       plan to apply (required)",
  "  --guid <guid>        Only this bill (repeatable; a text-version suffix is ignored)",
  "  --limit <n>          At most n rows read (dry run) or lines applied or undone",
  `  --since <iso>        Rows dated at or after this time (default ${DEFAULT_SINCE})`,
  `  --concurrency <n>    Dry-run reads in flight (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  `  --rate <n>           Transactions a second, at most (default ${DEFAULT_RATE}, at most ${MAX_RATE})`,
  `  --stop-after <s>     Stop starting lines after this many seconds (default ${DEFAULT_STOP_AFTER_SECONDS}); rerun to resume`,
  `  --undo-file <path>   Where --apply appends the undo records (default ${UNDO_FILE_PREFIX}<UTC time>.jsonl)`,
  "  --undo <path>        Move the rows of an undo file back, newest first (with --apply; otherwise a dry run)",
  "  --prevention-live    The prevention change runs on CreateBillsManifest:prod (RUNBOOK 4.9 P1)",
  "",
  "--apply refuses to start (exit code 2) unless BillsManifestQueue and BillsManifestDLQ are empty; a message in the",
  "DLQ never leaves by itself: inspect it and redrive it before the dry run (RUNBOOK 4.9 P2). Ctrl-C during --apply",
  "starts no new line and lets the one in flight write its undo record (press it again to exit at once). No S3 write,",
  "SQS send, push or Bedrock call.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "PROCESSED_BILLS_PREFIX, MANIFEST_TABLE_NAME, MANIFEST_PRIMARY_KEY, MANIFEST_SORT_KEY, MANIFEST_PK_VALUE,",
  "MANIFEST_GUID_LOOKUP_PK, PRIORITY_TABLE_NAME, PRIORITY_TABLE_PARTITION_KEY, BILLS_MANIFEST_QUEUE_NAME,",
  "BILLS_MANIFEST_DLQ_NAME",
].join("\n");

// ─── Reading ─────────────────────────────────────────────────────────────────

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const rowKey = (config: RedateConfig, sk: string): Item => ({
  [config.manifestPrimaryKey]: { S: config.manifestPkValue },
  [config.manifestSortKey]: { S: sk },
});

const lookupKey = (config: RedateConfig, guid: string): Item => ({
  [config.manifestPrimaryKey]: { S: config.guidLookupPk },
  [config.manifestSortKey]: { S: guid },
});

const getItem = async (db: TableSender, config: RedateConfig, key: Item): Promise<Item | undefined> => {
  const response = await db.send(
    new GetItemCommand({ TableName: config.manifestTableName, Key: key, ConsistentRead: true }),
  );
  return response.Item;
};

/** The BILL rows dated at or after `since`, read consistently. */
const queryRowsSince = async (db: TableSender, config: RedateConfig, since: string): Promise<Item[]> => {
  const rows: Item[] = [];
  let startKey: Item | undefined;
  do {
    const response = await db.send(
      new QueryCommand({
        TableName: config.manifestTableName,
        KeyConditionExpression: "#pk = :pk AND #sk >= :since",
        ExpressionAttributeNames: { "#pk": config.manifestPrimaryKey, "#sk": config.manifestSortKey },
        ExpressionAttributeValues: { ":pk": { S: config.manifestPkValue }, ":since": { S: since } },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...(response.Items ?? []));
    startKey = response.LastEvaluatedKey;
  } while (startKey);
  return rows;
};

/** How many BILL rows are dated at or after `since`. */
const countRowsSince = async (db: TableSender, config: RedateConfig, since: string): Promise<number> => {
  let count = 0;
  let startKey: Item | undefined;
  do {
    const response = await db.send(
      new QueryCommand({
        TableName: config.manifestTableName,
        KeyConditionExpression: "#pk = :pk AND #sk >= :since",
        ExpressionAttributeNames: { "#pk": config.manifestPrimaryKey, "#sk": config.manifestSortKey },
        ExpressionAttributeValues: { ":pk": { S: config.manifestPkValue }, ":since": { S: since } },
        Select: "COUNT",
        ExclusiveStartKey: startKey,
      }),
    );
    count += response.Count ?? 0;
    startKey = response.LastEvaluatedKey;
  } while (startKey);
  return count;
};

const hasActivePriority = async (priority: PriorityReader, guid: string): Promise<boolean> =>
  (await priority.getByGuid(guid))?.status === ACTIVE_PRIORITY_STATUS;

type ObjectVersion = Awaited<ReturnType<BillStorage["listObjectVersionsForKey"]>>[number];

/**
 * The latest content version (null when the latest version is a delete marker, or there is none) and the baseline:
 * newest first, the first content version written before `since`, never past a delete marker. Versions that share
 * a LastModified second keep S3's listing order (listObjectVersionsForKey sorts stably).
 */
export const pickVersions = (
  versions: readonly ObjectVersion[],
  since: string,
): { current: ObjectVersion | null; baseline: ObjectVersion | null } => {
  const latest = versions.find((version) => version.isLatest) ?? versions[0];
  if (!latest || latest.isDeleteMarker) return { current: null, baseline: null };
  const sinceMs = Date.parse(since);
  for (const version of versions) {
    if (version.isDeleteMarker) break;
    const lastModifiedMs = Date.parse(version.lastModified ?? "");
    if (Number.isFinite(lastModifiedMs) && lastModifiedMs < sinceMs) return { current: latest, baseline: version };
  }
  return { current: latest, baseline: null };
};

// ─── Planning ────────────────────────────────────────────────────────────────

export interface PlanLine {
  guid: string;
  fromSk: string;
  toSk: string;
  fromUpdatedAt: string;
  toUpdatedAt: string;
  /**
   * The version the target date is the storedAt of: the last version since --since that brought news (judged against
   * the version before it), or the baseline (the version current at --since) when none did.
   */
  baselineVersionId: string;
  baselineLastModified: string;
  currentVersionId: string;
  /** billContentHash of the current version, which the moved row carries. */
  contentHash: string;
  /** What changed from the target's version to the current one, which brought no news. */
  labels: string[];
  /** The news of the target's version, when it is not the baseline (a version since --since moved the row for it). */
  datedBy?: ManifestDateMove[];
  /** The row and the lookup as the dry run read them (DynamoDB JSON). */
  row: Item;
  lookup: Item;
}

export type SkipReason =
  /** The BILL_GUID lookup names another row (or none). */
  | "lookupMismatch"
  /** The processed bill's latest version is a delete marker, or it has none. */
  | "deleted"
  /** The row does not reflect the latest version (a write since, or a pending one). */
  | "rowNotCurrent"
  /** The baseline has no readable storedAt. */
  | "badStoredAt"
  /** The target is not older than the row. */
  | "notOlder"
  /** A BILL row exists at the target. */
  | "targetOccupied"
  /** The bill has an ACTIVE BillPriority record. */
  | "activePriority"
  /** A read failed. */
  | "unreadable";

export const SKIP_REASONS: readonly SkipReason[] = [
  "lookupMismatch",
  "deleted",
  "rowNotCurrent",
  "badStoredAt",
  "notOlder",
  "targetOccupied",
  "activePriority",
  "unreadable",
];

export type Assessment =
  | { guid: string; outcome: "planned"; line: PlanLine }
  /** The current version brought news against the one before it, so the row keeps its date (manifestDateMoves). */
  | { guid: string; outcome: "dated"; moves: ManifestDateMove[]; labels: string[] }
  /** No version before --since: a first publication (the row was never dated earlier). */
  | { guid: string; outcome: "noBaseline" }
  | { guid: string; outcome: "skipped"; reason: SkipReason; detail?: string };

interface ReadDeps {
  db: TableSender;
  storage: BillStorage;
  priority: PriorityReader;
  config: RedateConfig;
}

const guidOfRow = (row: Item, config: RedateConfig): string =>
  row.guid?.S ?? (row[config.manifestSortKey]?.S ?? "").split("#").slice(1).join("#");

const processedKey = (config: RedateConfig, guid: string): string => `${config.processedPrefix}${guid}.json`;

const asDoc = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Reads one row's lookup, versions, baseline and target, and plans it or says why not. */
export const assessRow = async (
  { db, storage, priority, config }: ReadDeps,
  row: Item,
  since: string,
): Promise<Assessment> => {
  const guid = guidOfRow(row, config);
  const fromSk = row[config.manifestSortKey]?.S ?? "";
  const skip = (reason: SkipReason, detail?: string): Assessment => ({
    guid,
    outcome: "skipped",
    reason,
    ...(detail ? { detail } : {}),
  });

  const lookup = await getItem(db, config, lookupKey(config, guid));
  if (!lookup || lookup.manifestSk?.S !== fromSk) return skip("lookupMismatch", lookup?.manifestSk?.S ?? "no lookup");

  const key = processedKey(config, guid);
  const listed = await storage.listObjectVersionsForKey(key);
  const { current, baseline } = pickVersions(listed, since);
  if (!current) return skip("deleted");
  if (!baseline) return { guid, outcome: "noBaseline" };
  // The baseline and every version after it, oldest first (pickVersions stops at a delete marker, so none is one).
  const chain = listed.slice(listed.indexOf(current), listed.indexOf(baseline) + 1).reverse();
  const objects = await Promise.all(
    chain.map((version) => storage.getJsonObjectWithVersionId<unknown>(key, version.versionId)),
  );
  const docs = objects.map((object) => object.value ?? null);
  if (docs.some((doc) => doc === null)) return skip("unreadable", "a version could not be read");
  const currentDoc = docs[docs.length - 1];

  // The row reflects the current version: by its hash when it has one of this version, else by its date.
  const contentHash = billContentHash(currentDoc);
  const rowHash = row[MANIFEST_CONTENT_HASH_ATTRIBUTE]?.S;
  const fromUpdatedAt = row.updatedAt?.S ?? "";
  const reflectsCurrent =
    contentHashChangeClass(rowHash, contentHash) !== null
      ? rowHash === contentHash
      : fromUpdatedAt === manifestTimestamp(asDoc(currentDoc).storedAt);
  if (!reflectsCurrent) return skip("rowNotCurrent", `row ${fromUpdatedAt}`);

  // Each version judged against the one before it, as CreateBillsManifest judges a version against the row's: the rule
  // dates the row by the last version that brought news, or by the baseline when none since did.
  const bases = docs.map((doc, index) =>
    manifestDateBasis(doc, readProcessedSource(objects[index].metadata)?.textHash),
  );
  let datedBy = 0;
  let moves: ManifestDateMove[] = [];
  for (let index = 1; index < chain.length; index += 1) {
    const news = manifestDateMoves(bases[index - 1], bases[index]);
    if (news.length > 0) [datedBy, moves] = [index, news];
  }
  const change = classifyBillVersionChange(docs[datedBy], currentDoc);
  const dated: Assessment = { guid, outcome: "dated", moves, labels: change.labels };
  // The current version brought news: the row is where the rule puts it.
  if (datedBy > 0 && datedBy === chain.length - 1) return dated;

  const target = chain[datedBy];
  const toUpdatedAt = manifestTimestamp(asDoc(docs[datedBy]).storedAt);
  if (!toUpdatedAt) return skip("badStoredAt");
  const toSk = manifestSortKey(toUpdatedAt, guid);
  // An earlier version brought the news and a later one kept the row there (a bookkeeping change under the rule before the date rule).
  if (datedBy > 0 && toSk === fromSk) return dated;
  if (!(toSk < fromSk)) return skip("notOlder", toSk);
  if (await getItem(db, config, rowKey(config, toSk))) return skip("targetOccupied", toSk);
  if (await hasActivePriority(priority, guid)) return skip("activePriority");

  return {
    guid,
    outcome: "planned",
    line: {
      guid,
      fromSk,
      toSk,
      fromUpdatedAt,
      toUpdatedAt,
      baselineVersionId: target.versionId,
      baselineLastModified: target.lastModified ?? "",
      currentVersionId: current.versionId,
      contentHash,
      labels: change.labels,
      ...(datedBy > 0 ? { datedBy: moves } : {}),
      row,
      lookup,
    },
  };
};

export interface PlanSummary {
  rows: number;
  planned: number;
  /** Rows whose change since the baseline brings news: they keep their date. */
  dated: number;
  noBaseline: number;
  skipped: Record<SkipReason, number>;
  /** BILL rows in the last WINDOW_DAYS days now, and after the plan is applied. */
  window: { since: string; now: number; after: number };
}

/** The report's last line. */
export const planSummaryLine = (summary: PlanSummary): string =>
  `Re-date plan: rows=${summary.rows} planned=${summary.planned} dated=${summary.dated} ` +
  `noBaseline=${summary.noBaseline} ` +
  `skipped(${SKIP_REASONS.map((reason) => `${reason}=${summary.skipped[reason]}`).join(" ")}) ` +
  `window${WINDOW_DAYS}=${summary.window.now}->${summary.window.after}`;

export const summarizePlan = (
  assessments: readonly Assessment[],
  windowSince: string,
  windowNow: number,
): PlanSummary => {
  const count = (outcome: Assessment["outcome"]) => assessments.filter((entry) => entry.outcome === outcome).length;
  const skipped = Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<SkipReason, number>;
  for (const entry of assessments) if (entry.outcome === "skipped") skipped[entry.reason] += 1;
  const leaving = assessments.filter(
    (entry) =>
      entry.outcome === "planned" && entry.line.fromUpdatedAt >= windowSince && entry.line.toUpdatedAt < windowSince,
  ).length;
  return {
    rows: assessments.length,
    planned: count("planned"),
    dated: count("dated"),
    noBaseline: count("noBaseline"),
    skipped,
    window: { since: windowSince, now: windowNow, after: windowNow - leaving },
  };
};

/** redate-manifest-rows-plan-20261014T170000Z.jsonl for 2026-10-14T17:00:00.123Z. */
const fileStamp = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

export const defaultPlanFile = (at: Date): string => `${PLAN_FILE_PREFIX}${fileStamp(at)}.jsonl`;
export const defaultUndoFile = (at: Date): string => `${UNDO_FILE_PREFIX}${fileStamp(at)}.jsonl`;

const PLAN_STRING_FIELDS = [
  "guid",
  "fromSk",
  "toSk",
  "fromUpdatedAt",
  "toUpdatedAt",
  "baselineVersionId",
  "currentVersionId",
  "contentHash",
] as const;

/** The plan file's lines, each checked to be a re-date to an older key of its own guid. */
export const parsePlanFile = (text: string): PlanLine[] =>
  text
    .split("\n")
    .map((raw, index) => ({ raw: raw.trim(), number: index + 1 }))
    .filter(({ raw }) => raw.length > 0)
    .map(({ raw, number }) => {
      const line = JSON.parse(raw) as PlanLine;
      const missing = PLAN_STRING_FIELDS.filter((field) => typeof line[field] !== "string" || !line[field]);
      if (missing.length > 0) throw new Error(`Plan line ${number}: missing ${missing.join(", ")}`);
      if (
        line.fromSk !== manifestSortKey(line.fromUpdatedAt, line.guid) ||
        line.toSk !== manifestSortKey(line.toUpdatedAt, line.guid) ||
        !(line.toSk < line.fromSk)
      ) {
        throw new Error(`Plan line ${number} (${line.guid}): not a re-date of its guid to an older key`);
      }
      if (contentHashChangeClass(line.contentHash, line.contentHash) === null) {
        throw new Error(`Plan line ${number} (${line.guid}): contentHash is not of the current version`);
      }
      if (!line.row || typeof line.row !== "object" || !line.lookup || typeof line.lookup !== "object") {
        throw new Error(`Plan line ${number} (${line.guid}): missing row or lookup`);
      }
      return line;
    });

// ─── Applying ────────────────────────────────────────────────────────────────

interface Condition {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

/**
 * The row still has the updatedAt it is moved from, and exactly the vote state (billStatsAggregator's voteCount and
 * voteCountComputedFrom) and contentHash read: each equal, or absent when it was (older rows have no voteCount).
 */
export const rowUnchangedCondition = (row: Item, updatedAt: string): Condition => {
  const clauses = ["#updatedAt = :updatedAt"];
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, AttributeValue> = { ":updatedAt": { S: updatedAt } };
  const attributes: Array<[string, string]> = [
    ["voteCount", "voteCount"],
    ["computedFrom", MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE],
    ["contentHash", MANIFEST_CONTENT_HASH_ATTRIBUTE],
  ];
  for (const [alias, attribute] of attributes) {
    names[`#${alias}`] = attribute;
    if (row[attribute] === undefined) clauses.push(`attribute_not_exists(#${alias})`);
    else {
      clauses.push(`#${alias} = :${alias}`);
      values[`:${alias}`] = row[attribute];
    }
  }
  return {
    ConditionExpression: clauses.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
};

/** A move of `row` (at `from`) and its lookup to `to`, as one transaction: delete, put, lookup. */
const moveTransaction = (
  config: RedateConfig,
  move: { fromSk: string; fromUpdatedAt: string; toSk: string; toUpdatedAt: string },
  row: Item,
  lookup: Item,
  rowChanges: Item = {},
): { items: TransactWriteItem[]; rowAfter: Item; lookupAfter: Item } => {
  const rowAfter: Item = {
    ...row,
    ...rowChanges,
    [config.manifestSortKey]: { S: move.toSk },
    updatedAt: { S: move.toUpdatedAt },
  };
  // userMatcher orders companion bills by the lookup's updatedAt, so it moves with the row.
  const lookupAfter: Item = { ...lookup, manifestSk: { S: move.toSk }, updatedAt: { S: move.toUpdatedAt } };
  const items: TransactWriteItem[] = [
    {
      Delete: {
        TableName: config.manifestTableName,
        Key: rowKey(config, move.fromSk),
        ...rowUnchangedCondition(row, move.fromUpdatedAt),
      },
    },
    {
      Put: {
        TableName: config.manifestTableName,
        Item: rowAfter,
        ConditionExpression: "attribute_not_exists(#sk)",
        ExpressionAttributeNames: { "#sk": config.manifestSortKey },
      },
    },
    {
      Put: {
        TableName: config.manifestTableName,
        Item: lookupAfter,
        ConditionExpression: "#manifestSk = :fromSk",
        ExpressionAttributeNames: { "#manifestSk": "manifestSk" },
        ExpressionAttributeValues: { ":fromSk": { S: move.fromSk } },
      },
    },
  ];
  return { items, rowAfter, lookupAfter };
};

/** The re-date of one plan line: the row read now moves to the target with the plan's contentHash. */
export const redateTransaction = (config: RedateConfig, line: PlanLine, row: Item, lookup: Item) =>
  moveTransaction(config, line, row, lookup, { [MANIFEST_CONTENT_HASH_ATTRIBUTE]: { S: line.contentHash } });

const cancellationCodes = (error: unknown): string[] | null => {
  const candidate = error as { name?: unknown; CancellationReasons?: Array<{ Code?: string }> } | null;
  if (candidate?.name !== "TransactionCanceledException") return null;
  return (candidate.CancellationReasons ?? []).map((reason) => reason?.Code ?? "None");
};

export interface UndoRecord {
  guid: string;
  fromSk: string;
  toSk: string;
  fromUpdatedAt: string;
  toUpdatedAt: string;
  currentVersionId: string;
  /** When the move committed; for an alreadyRedated line, when this run found it moved. */
  appliedAt: string;
  before: { row: Item; lookup: Item };
  after: { row: Item; lookup: Item };
}

/** A plan line's undo record: the row and lookup before the move and after it. */
const undoRecord = (
  line: PlanLine,
  before: UndoRecord["before"],
  after: UndoRecord["after"],
  at: Date,
): UndoRecord => ({
  guid: line.guid,
  fromSk: line.fromSk,
  toSk: line.toSk,
  fromUpdatedAt: line.fromUpdatedAt,
  toUpdatedAt: line.toUpdatedAt,
  currentVersionId: line.currentVersionId,
  appliedAt: at.toISOString(),
  before,
  after,
});

export type ApplyOutcome =
  | "applied"
  /** The transaction committed but its answer was lost: the lookup and the row are at the target. */
  | "appliedLostResponse"
  /** An earlier run moved it: no write, and its undo record again (that run may have stopped before writing one). */
  | "alreadyRedated"
  /** The row or the processed bill changed since the dry run: no write; run the dry run again. */
  | "superseded"
  /** The lookup names neither the row nor the target: a newer version moved the row. */
  | "movedForward"
  | "targetOccupied"
  | "activePriority"
  | "failed";

export const APPLY_OUTCOMES: readonly ApplyOutcome[] = [
  "applied",
  "appliedLostResponse",
  "alreadyRedated",
  "superseded",
  "movedForward",
  "targetOccupied",
  "activePriority",
  "failed",
];

interface ApplyDeps extends ReadDeps {
  log: Log;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** True once SIGINT or SIGTERM arrived (main): no new line starts. */
  interrupted: () => boolean;
}

/** Re-reads one plan line's lookup, row and processed bill, and moves the row in one transaction. */
export const applyPlanLine = async (
  deps: ApplyDeps,
  line: PlanLine,
): Promise<{ outcome: Exclude<ApplyOutcome, "failed">; record?: UndoRecord }> => {
  const { db, storage, priority, config, log, now, sleep } = deps;
  if (await hasActivePriority(priority, line.guid)) return { outcome: "activePriority" };
  for (let attempt = 0; ; attempt += 1) {
    const lookup = await getItem(db, config, lookupKey(config, line.guid));
    const lookupSk = lookup?.manifestSk?.S;
    if (lookup && lookupSk === line.toSk) {
      // An earlier run's commit whose undo record may never have been written (Ctrl-C a second time, a crash, or a
      // failed send whose re-reads failed too): record it again, before as the plan read it. A second undo of a
      // duplicate record finds the row moved back already (movedSinceRedate).
      const moved = await getItem(db, config, rowKey(config, line.toSk));
      if (moved?.updatedAt?.S !== line.toUpdatedAt) return { outcome: "alreadyRedated" };
      const before = { row: line.row, lookup: line.lookup };
      return { outcome: "alreadyRedated", record: undoRecord(line, before, { row: moved, lookup }, now()) };
    }
    if (!lookup || lookupSk !== line.fromSk) return { outcome: "movedForward" };
    const row = await getItem(db, config, rowKey(config, line.fromSk));
    const rowHash = row?.[MANIFEST_CONTENT_HASH_ATTRIBUTE]?.S;
    if (!row || row.updatedAt?.S !== line.fromUpdatedAt || (rowHash !== undefined && rowHash !== line.contentHash)) {
      return { outcome: "superseded" };
    }
    const head = await storage.s3Client.send(
      new HeadObjectCommand({ Bucket: storage.bucketName, Key: processedKey(config, line.guid) }),
    );
    if (head.VersionId !== line.currentVersionId) return { outcome: "superseded" };

    const { items, rowAfter, lookupAfter } = redateTransaction(config, line, row, lookup);
    const record = () => undoRecord(line, { row, lookup }, { row: rowAfter, lookup: lookupAfter }, now());
    try {
      // No ClientRequestToken of the script's own: the SDK gives each send a fresh one and reuses it on its own retry
      // of a lost answer. One derived from the items would make a later identical move (apply, undo, apply within
      // DynamoDB's 10-minute idempotency window) report success and write nothing.
      await db.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return { outcome: "applied", record: record() };
    } catch (error) {
      // A send can fail after its commit (the answer lost after the SDK's last retry): look before judging.
      const lookupNow = await getItem(db, config, lookupKey(config, line.guid));
      if (lookupNow?.manifestSk?.S === line.toSk) {
        const moved = await getItem(db, config, rowKey(config, line.toSk));
        if (moved?.updatedAt?.S === line.toUpdatedAt) return { outcome: "appliedLostResponse", record: record() };
      }
      if (lookupNow?.manifestSk?.S !== line.fromSk) return { outcome: "movedForward" };
      const codes = cancellationCodes(error);
      if (!codes) throw error;
      if (codes[1] === "ConditionalCheckFailed") return { outcome: "targetOccupied" };
      if (codes[2] === "ConditionalCheckFailed") return { outcome: "movedForward" };
      const retryable = codes[0] === "ConditionalCheckFailed" || codes.includes("TransactionConflict");
      if (!retryable || attempt + 1 >= MAX_APPLY_ATTEMPTS) throw error;
      // billStatsAggregator wrote a vote count, or another transaction held an item: read again.
      log(`  ${line.guid}: ${codes.join(",")} on attempt ${attempt + 1}; reading again`);
      await sleep(backoffDelayMs(attempt, APPLY_RETRY_BACKOFF));
    }
  }
};

/**
 * The undo file's records, each checked to name a move of its own guid. A plan file's lines carry the same keys, which
 * is all the undo reads, so --undo <plan file> moves back every planned row still at its target, recorded or not.
 */
export const parseUndoFile = (text: string): UndoRecord[] =>
  text
    .split("\n")
    .map((raw, index) => ({ raw: raw.trim(), number: index + 1 }))
    .filter(({ raw }) => raw.length > 0)
    .map(({ raw, number }) => {
      const record = JSON.parse(raw) as UndoRecord;
      if (
        typeof record.guid !== "string" ||
        record.fromSk !== manifestSortKey(record.fromUpdatedAt, record.guid) ||
        record.toSk !== manifestSortKey(record.toUpdatedAt, record.guid)
      ) {
        throw new Error(`Undo line ${number}: not a re-date record`);
      }
      return record;
    });

export type UndoOutcome =
  /** Dry run: still at its target with the target's updatedAt, so it would move back. */
  | "revertible"
  | "reverted"
  /** The reverse transaction committed but its answer was lost. */
  | "revertedLostResponse"
  /** A write moved or changed it since the re-date: left as it is. */
  | "movedSinceRedate"
  | "failed";

export const UNDO_OUTCOMES: readonly UndoOutcome[] = [
  "revertible",
  "reverted",
  "revertedLostResponse",
  "movedSinceRedate",
  "failed",
];

/** Moves one re-dated row back to where it was, with its lookup, when it is still at its target. */
export const undoRecordLine = async (
  deps: ApplyDeps,
  record: UndoRecord,
  apply: boolean,
): Promise<Exclude<UndoOutcome, "failed">> => {
  const { db, config, log, sleep } = deps;
  const back = {
    fromSk: record.toSk,
    fromUpdatedAt: record.toUpdatedAt,
    toSk: record.fromSk,
    toUpdatedAt: record.fromUpdatedAt,
  };
  for (let attempt = 0; ; attempt += 1) {
    const lookup = await getItem(db, config, lookupKey(config, record.guid));
    const row =
      lookup?.manifestSk?.S === record.toSk ? await getItem(db, config, rowKey(config, record.toSk)) : undefined;
    if (!lookup || !row || row.updatedAt?.S !== record.toUpdatedAt) return "movedSinceRedate";
    if (!apply) return "revertible";
    // The row as it is now (a kept bookkeeping write may have updated it), at its old key and date.
    const { items } = moveTransaction(config, back, row, lookup);
    try {
      // The SDK's token, as for the apply: an undo repeats the items of an earlier undo of the same row exactly.
      await db.send(new TransactWriteItemsCommand({ TransactItems: items }));
      return "reverted";
    } catch (error) {
      const lookupNow = await getItem(db, config, lookupKey(config, record.guid));
      if (lookupNow?.manifestSk?.S === record.fromSk) {
        const restored = await getItem(db, config, rowKey(config, record.fromSk));
        if (restored?.updatedAt?.S === record.fromUpdatedAt) return "revertedLostResponse";
      }
      if (lookupNow?.manifestSk?.S !== record.toSk) return "movedSinceRedate";
      const codes = cancellationCodes(error);
      const retryable = codes && (codes[0] === "ConditionalCheckFailed" || codes.includes("TransactionConflict"));
      if (!retryable || attempt + 1 >= MAX_APPLY_ATTEMPTS) throw error;
      log(`  ${record.guid}: ${codes.join(",")} on attempt ${attempt + 1}; reading again`);
      await sleep(backoffDelayMs(attempt, APPLY_RETRY_BACKOFF));
    }
  }
};

// ─── Report and run ─────────────────────────────────────────────────────────

export interface QueueDepth {
  name: string;
  visible: number;
  notVisible: number;
  delayed: number;
}

/** Messages in BillsManifestQueue and its DLQ: visible, in flight and delayed. */
export const manifestQueueDepths = async (sqs: QueueSender, config: RedateConfig): Promise<QueueDepth[]> => {
  const depths: QueueDepth[] = [];
  for (const name of [config.manifestQueueName, config.manifestDlqName]) {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`Queue ${name} not found`);
    const { Attributes = {} } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
        ],
      }),
    );
    depths.push({
      name,
      visible: Number(Attributes.ApproximateNumberOfMessages ?? 0) || 0,
      notVisible: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0) || 0,
      delayed: Number(Attributes.ApproximateNumberOfMessagesDelayed ?? 0) || 0,
    });
  }
  return depths;
};

export interface RunOptions {
  db: TableSender;
  storage: BillStorage;
  sqs: QueueSender;
  priority: PriorityReader;
  config: RedateConfig;
  options: CliOptions;
  /** Defaults to APPLY_REQUIRES_PREVENTION_LIVE. */
  requirePreventionLive?: boolean;
  log?: Log;
  logError?: Log;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  appendFile?: (path: string, text: string) => void;
  /** Creates a file; it must not exist. */
  createFile?: (path: string, text: string) => void;
  readFile?: (path: string) => string;
  /** True once the run should start no new line (main sets it on SIGINT or SIGTERM); defaults to never. */
  interrupted?: () => boolean;
}

export interface RunResult {
  exitCode: 0 | 1 | 2;
  summary?: PlanSummary;
  planFile?: string;
  applied?: Record<ApplyOutcome, number>;
  undone?: Record<UndoOutcome, number>;
  undoFile?: string;
  /** Lines not started because --stop-after was reached. */
  remaining?: number;
}

const filterByGuidAndLimit = <T extends { guid: string }>(entries: readonly T[], options: CliOptions): T[] => {
  const selected = options.guids.length > 0 ? entries.filter((entry) => options.guids.includes(entry.guid)) : entries;
  return options.limit !== null ? selected.slice(0, options.limit) : [...selected];
};

/**
 * Runs `step` for each entry in turn, starting at most `rate` a second, and starts none once `stopAfterSeconds` have
 * passed or the run is interrupted (the step in flight finishes). Returns how many entries were not started.
 */
const paced = async <T>(
  entries: readonly T[],
  { rate, stopAfterSeconds }: Pick<CliOptions, "rate" | "stopAfterSeconds">,
  { now, sleep, interrupted }: Pick<ApplyDeps, "now" | "sleep" | "interrupted">,
  step: (entry: T) => Promise<void>,
): Promise<number> => {
  const startedAt = now().getTime();
  const intervalMs = 1000 / rate;
  let nextStartAt = startedAt;
  for (const [index, entry] of entries.entries()) {
    const startAt = Math.max(now().getTime(), nextStartAt);
    if (startAt - startedAt >= stopAfterSeconds * 1000) return entries.length - index;
    const waitMs = startAt - now().getTime();
    if (waitMs > 0) await sleep(waitMs);
    if (interrupted()) return entries.length - index;
    nextStartAt = startAt + intervalMs;
    await step(entry);
  }
  return 0;
};

/** Plans every row dated at or after --since and writes the plan file. */
const runDryRun = async (deps: ApplyDeps & Required<Pick<RunOptions, "createFile">>, options: CliOptions) => {
  const { db, config, log, now, createFile } = deps;
  const rows = filterByGuidAndLimit(
    (await queryRowsSince(db, config, options.since)).map((row) => ({ guid: guidOfRow(row, config), row })),
    options,
  );
  log(`Read ${rows.length} BILL rows dated at or after ${options.since}`);
  const assessments = await mapWithConcurrency(rows, options.concurrency, async ({ guid, row }) => {
    try {
      return await assessRow(deps, row, options.since);
    } catch (error) {
      return {
        guid,
        outcome: "skipped",
        reason: "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      } satisfies Assessment;
    }
  });
  assessments.sort((a, b) => compareText(a.guid, b.guid));
  for (const entry of assessments) {
    if (entry.outcome === "planned") {
      const { line } = entry;
      const reason = line.datedBy ? `, its last news: ${line.datedBy.join(" ")}` : ", no news since --since";
      log(`  planned ${entry.guid}: ${line.fromUpdatedAt} -> ${line.toUpdatedAt}${reason}`);
    }
    if (entry.outcome === "dated") log(`  dated ${entry.guid}: ${entry.moves.join(" ")}`);
    if (entry.outcome === "skipped") {
      log(`  skipped (${entry.reason}) ${entry.guid}${entry.detail ? `: ${entry.detail}` : ""}`);
    }
  }
  const windowSince = new Date(now().getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const summary = summarizePlan(assessments, windowSince, await countRowsSince(db, config, windowSince));
  const lines = assessments.flatMap((entry) => (entry.outcome === "planned" ? [entry.line] : []));
  let planFile: string | undefined;
  if (lines.length > 0) {
    planFile = options.planFile ?? defaultPlanFile(now());
    createFile(planFile, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    log(`Plan: ${lines.length} lines in ${planFile}`);
  } else {
    log("Plan: nothing to re-date; no plan file written");
  }
  log(planSummaryLine(summary));
  log("Dry run: nothing written to AWS. Review and archive the plan, then --apply --plan-file <plan> (RUNBOOK 4.9).");
  return { exitCode: summary.skipped.unreadable > 0 ? 1 : 0, summary, ...(planFile ? { planFile } : {}) } as const;
};

/** Moves the rows of a reviewed plan, paced; writes an undo record for each. */
const runApply = async (
  deps: ApplyDeps & Required<Pick<RunOptions, "appendFile" | "readFile" | "sqs" | "logError">>,
  options: CliOptions,
  requirePreventionLive: boolean,
): Promise<RunResult> => {
  const { config, log, logError, now, appendFile, readFile, sqs } = deps;
  const lines = filterByGuidAndLimit(parsePlanFile(readFile(options.planFile!)), options);
  log(`Plan ${options.planFile}: ${lines.length} lines to apply`);

  if (requirePreventionLive && !options.preventionLive) {
    logError("Refusing to apply: the prevention change must be live first (RUNBOOK 4.9 P1); pass --prevention-live");
    return { exitCode: 2 };
  }
  const depths = await manifestQueueDepths(sqs, config);
  for (const depth of depths) {
    log(`  ${depth.name}: visible=${depth.visible} notVisible=${depth.notVisible} delayed=${depth.delayed}`);
  }
  if (depths.some((depth) => depth.visible + depth.notVisible + depth.delayed > 0)) {
    logError(
      "Refusing to apply: a manifest queue holds messages. BillsManifestQueue drains by itself; a message in " +
        "BillsManifestDLQ never does: inspect and redrive it, then take the dry run again (RUNBOOK 4.9 P2)",
    );
    return { exitCode: 2 };
  }

  const undoFile = options.undoFile ?? defaultUndoFile(now());
  // Created before the first transaction, so a path that cannot be written stops the run before any write.
  appendFile(undoFile, "");
  log(`Applying ${lines.length} lines at most ${options.rate} a second; undo records go to ${undoFile}`);
  const applied = Object.fromEntries(APPLY_OUTCOMES.map((outcome) => [outcome, 0])) as Record<ApplyOutcome, number>;
  const remaining = await paced(lines, options, deps, async (line) => {
    let result: Awaited<ReturnType<typeof applyPlanLine>> | { outcome: "failed"; record?: undefined };
    try {
      result = await applyPlanLine(deps, line);
    } catch (error) {
      result = { outcome: "failed" };
      logError("Failed to re-date the manifest row", { guid: line.guid, fromSk: line.fromSk, error });
    }
    applied[result.outcome] += 1;
    if (result.outcome !== "applied") log(`  ${result.outcome}: ${line.guid}`);
    if (result.record) {
      try {
        appendFile(undoFile, `${JSON.stringify(result.record)}\n`);
      } catch (error) {
        // The row is moved; going on would move the next ones without an undo record too. The plan line and these
        // keys are what is left to undo it by hand.
        logError("Applied without an undo record; stopping", {
          guid: line.guid,
          fromSk: line.fromSk,
          toSk: line.toSk,
          error,
        });
        throw error;
      }
    }
  });
  log(`Applied: ${APPLY_OUTCOMES.map((outcome) => `${outcome}=${applied[outcome]}`).join(" ")} remaining=${remaining}`);
  if (remaining > 0) {
    const stoppedBy = deps.interrupted() ? "Interrupted" : `Stopped after ${options.stopAfterSeconds} s`;
    log(`${stoppedBy}: ${remaining} lines remain; run again to resume.`);
  }
  if (applied.superseded > 0) log("Superseded lines changed since the dry run: run the dry run again for them.");
  if (applied.failed > 0)
    log("A failed line may have committed: run again, which records it if it did (alreadyRedated).");
  return { exitCode: applied.failed > 0 ? 1 : 0, applied, undoFile, remaining };
};

/** Moves the rows of an undo file back (newest first) when they are still where the re-date put them. */
const runUndo = async (
  deps: ApplyDeps & Required<Pick<RunOptions, "readFile" | "logError">>,
  options: CliOptions,
): Promise<RunResult> => {
  const { log, logError, readFile } = deps;
  const records = filterByGuidAndLimit(parseUndoFile(readFile(options.undo!)).reverse(), options);
  log(`Undo ${options.undo}: ${records.length} records${options.apply ? "" : " (dry run)"}`);
  const undone = Object.fromEntries(UNDO_OUTCOMES.map((outcome) => [outcome, 0])) as Record<UndoOutcome, number>;
  const step = async (record: UndoRecord): Promise<void> => {
    let outcome: UndoOutcome;
    try {
      outcome = await undoRecordLine(deps, record, options.apply);
    } catch (error) {
      outcome = "failed";
      logError("Failed to move the manifest row back", { guid: record.guid, toSk: record.toSk, error });
    }
    undone[outcome] += 1;
    if (outcome === "movedSinceRedate" || outcome === "failed") log(`  ${outcome}: ${record.guid}`);
  };
  // Only moves are paced; the dry run (the post-apply check) only reads.
  let remaining = 0;
  if (options.apply) remaining = await paced(records, options, deps, step);
  else await mapWithConcurrency(records, options.concurrency, step);
  log(
    `Undo: records=${records.length} ${UNDO_OUTCOMES.map((outcome) => `${outcome}=${undone[outcome]}`).join(" ")} ` +
      `remaining=${remaining}`,
  );
  return { exitCode: undone.failed > 0 ? 1 : 0, undone, remaining };
};

/** The dry run, an apply of a plan file, or an undo, by the options. */
export const runRedate = async ({
  db,
  storage,
  sqs,
  priority,
  config,
  options,
  requirePreventionLive = APPLY_REQUIRES_PREVENTION_LIVE,
  log = console.log,
  logError = console.error,
  now = () => new Date(),
  sleep = sleepMs,
  appendFile = (path: string, text: string) => appendFileSync(path, text, "utf8"),
  createFile = (path: string, text: string) => writeFileSync(path, text, { encoding: "utf8", flag: "wx" }),
  readFile = (path: string) => readFileSync(path, "utf8"),
  interrupted = () => false,
}: RunOptions): Promise<RunResult> => {
  const mode = options.undo ? "UNDO" : options.apply ? "APPLY" : "DRY-RUN";
  log(
    `redate:manifest-rows mode=${mode}${options.undo && !options.apply ? " (dry run)" : ""} ` +
      `table=${config.manifestTableName} bucket=${config.bucket}` +
      (options.guids.length > 0 ? ` guids=${options.guids.join(",")}` : "") +
      (options.limit !== null ? ` limit=${options.limit}` : ""),
  );
  const deps = {
    db,
    storage,
    priority,
    config,
    log,
    logError,
    now,
    sleep,
    interrupted,
    sqs,
    appendFile,
    createFile,
    readFile,
  };
  if (options.undo) return runUndo(deps, options);
  if (options.apply) return runApply(deps, options, requirePreventionLive);
  return runDryRun(deps, options);
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const db = new DynamoDBClient({ region: config.region });
  // A move is written before its undo record, so a writing run is not killed by the first Ctrl-C (or SIGTERM): it
  // starts no new line and lets the one in flight write its record. The second exits at once; a rerun then records a
  // line that committed (alreadyRedated). The dry runs stop at once, as they write nothing.
  let interrupted = false;
  if (options.apply) {
    const interrupt = (signal: NodeJS.Signals) => {
      if (interrupted) process.exit(130);
      interrupted = true;
      console.error(`${signal}: finishing the line in flight, then stopping (again to exit at once)`);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
  }
  const { exitCode } = await runRedate({
    db,
    storage: new BillStorage(new S3Client({ region: config.region }), config.bucket),
    sqs: new SQSClient({ region: config.region }),
    priority: new BillPriorityDao(db, {
      tableName: config.priorityTableName,
      partitionKey: config.priorityPartitionKey,
    }),
    config,
    options,
    interrupted: () => interrupted,
  });
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Manifest re-date failed", error);
    process.exitCode = 1;
  });
}
