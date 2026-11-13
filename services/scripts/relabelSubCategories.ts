#!/usr/bin/env node

// LLM-10 (decision 1B): moves stored data from the two former sub-category names to the current ones,
// "Social Justice" -> "Civil Rights and Liberties" and "Identity Politics" -> "Heritage and Identity"
// (LEGACY_SUB_CATEGORY_ALIASES in src/models/categories.ts). The code already accepts both names, so
// this only tidies the data; a later cleanup removes the aliases once a dry run plans 0 and 0.
//
// Dry run (the default, read-only): lists processed-bills/, reads each bill, and plans the ones whose
// subCategories hold a former name (new list: each former name mapped, duplicates removed, order
// kept). Scans UserPreferences for follows stored under a former name. Prints the counts per former
// name, the planned guids and the follows per user id (no emails). The last line is
//   Relabel plan: bills= socialJustice= identityPolitics= both= noSourceMetadata= follows= move= drop= skipped= unreadable=
//
// --guid <guid> --apply: that bill only (the canary). --apply: every planned bill, 4 at a time. Each
// write is GetObject, then PutObject with IfMatch (the ETag read), the same ContentType, the same user
// metadata (the source-* keys billDiffer compares are kept; correlation-id becomes
// relabel-llm10-<run>), and a body identical except subCategories, so storedAt (the manifest row's
// updatedAt) does not move. A refused write (a pipeline write landed in between) is re-read and
// retried up to 3 times, then reported. NotificationType compares summary, title and actions only,
// so a relabel write sends no push; CreateBillsManifest rewrites the row in place.
//
// --preferences (with --apply: moves them): only the follows. One transaction per follow: put the
// current-name row (attribute_not_exists; same attributes, parent category set) and delete the
// former-name row (attribute_exists). When the user already follows the current name, the former
// row is only deleted (on condition the current row still exists).
//
// --guids-out <file> writes the planned guids, one per line, for
//   npm run reconcile:processed-bills -- --guids-file <file>
// (a read-only check, before --apply, that none of them has a pending text change).
//
// Idempotent and resumable: a rerun plans only what is left. Exit status 1 when a bill could not be
// read or a write failed or kept conflicting.
//
// ON HOLD: the bills (the canary and --apply) until most active installs run R2, since builds 1.0
// and R1 know only the former names; the follows until GET /preferences returns the former names to
// those builds (BILL_RELABEL_HOLD; RUNBOOK 14.7 and 14.10 step 14).

import { writeFileSync } from "node:fs";
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { isPreconditionFailure } from "../src/adapters/billStorage";
import {
  BILL_SUBCATEGORY_TO_CATEGORY,
  LEGACY_SUB_CATEGORY_ALIASES,
  canonicalSubCategory,
  isLegacySubCategoryName,
} from "../src/models/categories";
import { SOURCE_METADATA_KEYS } from "../src/shared/billSourceReconcile";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { CORRELATION_ID_METADATA_KEY } from "../src/shared/correlation";

// ─── Configuration and arguments ────────────────────────────────────────────

export interface RelabelConfig {
  region: string;
  bucket: string;
  processedPrefix: string;
  preferencesTable: string;
  userIdAttribute: string;
  preferenceAttribute: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): RelabelConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  processedPrefix: env.PROCESSED_BILLS_PREFIX || "processed-bills/",
  preferencesTable: env.PREFERENCES_TABLE_NAME || "UserPreferences",
  userIdAttribute: env.PREFERENCES_PARTITION_KEY || "userId",
  preferenceAttribute: env.PREFERENCES_SORT_KEY || "preference",
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  /** Only the follows (UserPreferences); no bill is listed or written. */
  preferences: boolean;
  /** Only these bills (plain guids); no follow is scanned. */
  guids: string[];
  /** Bills read at once while planning. */
  concurrency: number;
  /** A local file to write the planned guids to, one per line. */
  guidsOut: string | null;
}

export const DEFAULT_READ_CONCURRENCY = 8;
const MAX_READ_CONCURRENCY = 25;
/** Bills written at once with --apply (C2 3.8.3). */
export const WRITE_CONCURRENCY = 4;
/** Re-reads after a refused conditional write, per bill or follow. */
export const MAX_RETRIES = 3;

/** BILLS-119hr835ih -> BILLS-119hr835 (the processed key form), or null for anything else. */
export const plainGuid = (value: string): string | null => {
  const match = value.trim().match(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i);
  return match ? match[1] : null;
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    preferences: false,
    guids: [],
    concurrency: DEFAULT_READ_CONCURRENCY,
    guidsOut: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--preferences") options.preferences = true;
    else if (arg === "--guid") {
      const raw = argv[(index += 1)];
      const guid = raw && !raw.startsWith("--") ? plainGuid(raw) : null;
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hr1400");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--concurrency") {
      const raw = argv[(index += 1)];
      const value = Number(raw);
      if (!raw || !Number.isInteger(value) || value < 1 || value > MAX_READ_CONCURRENCY) {
        throw new Error(`--concurrency needs a whole number from 1 to ${MAX_READ_CONCURRENCY}`);
      }
      options.concurrency = value;
    } else if (arg === "--guids-out") {
      const raw = argv[(index += 1)];
      if (!raw || raw.startsWith("--")) throw new Error("--guids-out needs a file path");
      options.guidsOut = raw;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.preferences && options.guids.length > 0) {
    throw new Error("--guid selects bills and --preferences selects follows; use one or the other");
  }
  if (options.preferences && options.guidsOut) {
    throw new Error("--guids-out lists bills, and --preferences plans no bills");
  }
  return options;
};

/**
 * LLM-10: the bill relabel (the canary and --apply) is on hold until most active installs run R2, because builds 1.0
 * and R1 know only the former names; the follows wait for the GET /preferences rule that names them the old way for
 * those builds. The script cannot measure R2's share, so it says so wherever it names a bill write (RUNBOOK 14.7 and
 * 14.10 step 14).
 */
export const BILL_RELABEL_HOLD =
  "ON HOLD: relabel no bill (the canary or --apply) until most active installs run R2; builds 1.0 and R1 know only " +
  "the former names (RUNBOOK 14.7, 14.10 step 14).";

export const USAGE = [
  "Relabel stored data from the former sub-category names to the current ones (LLM-10):",
  `  ${Object.entries(LEGACY_SUB_CATEGORY_ALIASES)
    .map(([from, to]) => `"${from}" -> "${to}"`)
    .join(", ")}`,
  "",
  BILL_RELABEL_HOLD,
  "Move the follows only once GET /preferences returns the former names to builds 1.0 and R1 (RUNBOOK 14.7).",
  "",
  "Usage:",
  "  npm run relabel:sub-categories                                   Dry run: bills and follows",
  "  npm run relabel:sub-categories -- --guid BILLS-119hr1400 --apply  Relabel one bill (the canary; ON HOLD)",
  "  npm run relabel:sub-categories -- --apply                        Relabel every planned bill (ON HOLD)",
  "  npm run relabel:sub-categories -- --apply --preferences          Move every planned follow",
  "",
  "Options:",
  "  --apply            Write (default: dry run, which writes nothing)",
  "  --guid <guid>      Only this bill (repeatable; a text-version suffix is ignored); no follows",
  "  --preferences      Only the follows (UserPreferences); no bills",
  `  --concurrency <n>  Bills read at once while planning (default ${DEFAULT_READ_CONCURRENCY}, at most ${MAX_READ_CONCURRENCY});`,
  `                     writes always run ${WRITE_CONCURRENCY} at a time`,
  "  --guids-out <file> Write the planned guids to a local file, one per line (for reconcile:processed-bills",
  "                     --guids-file)",
  "",
  "Done when a dry run plans 0 bills and 0 follows. No quiet window is needed: a relabel write moves",
  "no storedAt, calls no model and sends no push.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "PROCESSED_BILLS_PREFIX, PREFERENCES_TABLE_NAME, PREFERENCES_PARTITION_KEY, PREFERENCES_SORT_KEY",
].join("\n");

// ─── The pure rule ──────────────────────────────────────────────────────────

/**
 * The relabelled list when `values` holds a former name, else null: each former name becomes its current
 * name, later duplicates are removed and the order is kept. Anything that is not a former name is kept as is.
 */
export const relabelSubCategoryList = (values: unknown): unknown[] | null => {
  if (!Array.isArray(values) || !values.some((value) => typeof value === "string" && isLegacySubCategoryName(value))) {
    return null;
  }
  const next: unknown[] = [];
  for (const value of values) {
    const mapped = typeof value === "string" ? canonicalSubCategory(value) : value;
    if (!next.includes(mapped)) next.push(mapped);
  }
  return next;
};

/**
 * The relabelled JSON body, or null when the bill holds no former name. Only `subCategories` changes: it keeps its
 * position, so every other field (storedAt included) serializes exactly as before.
 */
export const relabelBillBody = (body: string): { body: string; from: string[]; to: unknown[] } | null => {
  const document: unknown = JSON.parse(body);
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;
  const next = relabelSubCategoryList(record.subCategories);
  if (!next) return null;
  const from = (record.subCategories as unknown[]).filter(
    (value): value is string => typeof value === "string" && isLegacySubCategoryName(value),
  );
  return { body: JSON.stringify({ ...record, subCategories: next }), from, to: next };
};

// ─── Bills ──────────────────────────────────────────────────────────────────

type S3Sender = Pick<S3Client, "send">;
type DdbSender = Pick<DynamoDBClient, "send">;
type Log = (...args: unknown[]) => void;

export interface PlannedBill {
  key: string;
  guid: string;
  /** The former names it carries. */
  from: string[];
  to: unknown[];
  /** False for a bill written before REL-30 (no source-text-hash): the write moves its LastModified. */
  hasSourceMetadata: boolean;
}

export interface BillScan {
  /** Keys read. */
  read: number;
  planned: PlannedBill[];
  unreadable: Array<{ key: string; error: string }>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readBody = async (response: { Body?: unknown }): Promise<string> => {
  const body = response.Body as { transformToString?: () => Promise<string> } | undefined;
  if (!body || typeof body.transformToString !== "function") throw new Error("empty body");
  return body.transformToString();
};

const isNoSuchKey = (error: unknown): boolean => {
  const candidate = error as { name?: unknown; Code?: unknown } | null;
  return candidate?.name === "NoSuchKey" || candidate?.Code === "NoSuchKey";
};

/** The flat processed-bills/<name>.json keys (the only layout writers use). */
const listProcessedKeys = async (s3: S3Sender, config: RelabelConfig): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: config.processedPrefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      const key = object.Key ?? "";
      if (key.endsWith(".json") && !key.slice(config.processedPrefix.length).includes("/")) keys.push(key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys.sort();
};

const guidOfKey = (config: RelabelConfig, key: string): string => key.slice(config.processedPrefix.length, -5);

/** Read-only: plans every bill (or the --guid ones). A --guid bill that does not exist is reported unreadable. */
export const scanBills = async (
  s3: S3Sender,
  config: RelabelConfig,
  options: Pick<CliOptions, "guids" | "concurrency">,
  log: Log = console.log,
): Promise<BillScan> => {
  const keys =
    options.guids.length > 0
      ? options.guids.map((guid) => `${config.processedPrefix}${guid}.json`)
      : await listProcessedKeys(s3, config);
  log(`Reading ${keys.length} bills under s3://${config.bucket}/${config.processedPrefix}`);
  const scan: BillScan = { read: 0, planned: [], unreadable: [] };
  await mapWithConcurrency(keys, options.concurrency, async (key) => {
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      const relabelled = relabelBillBody(await readBody(response));
      if (relabelled) {
        const metadata = response.Metadata ?? {};
        scan.planned.push({
          key,
          guid: guidOfKey(config, key),
          from: relabelled.from,
          to: relabelled.to,
          hasSourceMetadata: Boolean(metadata[SOURCE_METADATA_KEYS.textHash]),
        });
      }
    } catch (error) {
      scan.unreadable.push({ key, error: isNoSuchKey(error) ? "no such bill" : errorText(error) });
    }
    scan.read += 1;
    if (scan.read % 1000 === 0) log(`Read ${scan.read} / ${keys.length} bills...`);
  });
  scan.planned.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  scan.unreadable.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return scan;
};

export type BillWriteOutcome = "relabelled" | "already_current" | "gone" | "conflict" | "failed";

/**
 * Relabels one bill: GetObject, then PutObject over the ETag read. A refused write is re-read and retried up to
 * MAX_RETRIES times. "already_current" when a writer in between already removed the former names; "gone" when the
 * bill no longer exists.
 */
export const relabelBill = async (
  s3: S3Sender,
  config: RelabelConfig,
  key: string,
  correlationId: string,
): Promise<{ outcome: BillWriteOutcome; error?: string }> => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response: { Body?: unknown; ETag?: string; ContentType?: string; Metadata?: Record<string, string> };
    try {
      response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    } catch (error) {
      if (isNoSuchKey(error)) return { outcome: "gone" };
      return { outcome: "failed", error: errorText(error) };
    }
    let relabelled: ReturnType<typeof relabelBillBody>;
    try {
      relabelled = relabelBillBody(await readBody(response));
    } catch (error) {
      return { outcome: "failed", error: errorText(error) };
    }
    if (!relabelled) return { outcome: "already_current" };
    if (!response.ETag) return { outcome: "failed", error: "GetObject returned no ETag" };
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: relabelled.body,
          ContentType: response.ContentType || "application/json",
          Metadata: { ...(response.Metadata ?? {}), [CORRELATION_ID_METADATA_KEY]: correlationId },
          IfMatch: response.ETag,
        }),
      );
      return { outcome: "relabelled" };
    } catch (error) {
      if (!isPreconditionFailure(error)) return { outcome: "failed", error: errorText(error) };
    }
  }
  return { outcome: "conflict", error: `the bill changed during ${MAX_RETRIES + 1} attempts` };
};

// ─── Follows (UserPreferences) ──────────────────────────────────────────────

export type FollowPlanKind = "move" | "drop" | "skipped";

export interface PlannedFollow {
  userId: string;
  from: string;
  to: string;
  /** move: put the current-name row and delete this one; drop: the current row exists, delete this one. */
  kind: FollowPlanKind;
  /** Why a row stored under a former name is left alone (not a Category row). */
  reason?: string;
}

const stringOf = (value: AttributeValue | undefined): string | undefined =>
  value && "S" in value && typeof value.S === "string" ? value.S : undefined;

const followKey = (config: RelabelConfig, userId: string, preference: string): Record<string, AttributeValue> => ({
  [config.userIdAttribute]: { S: userId },
  [config.preferenceAttribute]: { S: preference },
});

const getFollow = async (
  ddb: DdbSender,
  config: RelabelConfig,
  userId: string,
  preference: string,
): Promise<Record<string, AttributeValue> | undefined> => {
  const response = await ddb.send(
    new GetItemCommand({
      TableName: config.preferencesTable,
      Key: followKey(config, userId, preference),
      ConsistentRead: true,
    }),
  );
  return response.Item;
};

const isCategoryType = (item: Record<string, AttributeValue>): boolean =>
  (stringOf(item.type) ?? "").trim().toLowerCase() === "category";

/** Read-only: every follow stored under a former name, and whether the current-name row exists. */
export const scanFollows = async (ddb: DdbSender, config: RelabelConfig): Promise<PlannedFollow[]> => {
  const legacyNames = Object.keys(LEGACY_SUB_CATEGORY_ALIASES);
  const values: Record<string, AttributeValue> = {};
  legacyNames.forEach((name, index) => {
    values[`:p${index}`] = { S: name };
  });
  const rows: Array<Record<string, AttributeValue>> = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: config.preferencesTable,
        FilterExpression: `#pref IN (${Object.keys(values).join(", ")})`,
        ExpressionAttributeNames: { "#pref": config.preferenceAttribute },
        ExpressionAttributeValues: values,
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...(response.Items ?? []));
    startKey = response.LastEvaluatedKey;
  } while (startKey);

  const planned: PlannedFollow[] = [];
  for (const row of rows) {
    const userId = stringOf(row[config.userIdAttribute]);
    const from = stringOf(row[config.preferenceAttribute]);
    if (!userId || !from || !isLegacySubCategoryName(from)) continue;
    const to = canonicalSubCategory(from);
    if (!isCategoryType(row)) {
      planned.push({ userId, from, to, kind: "skipped", reason: `type ${stringOf(row.type) ?? "(none)"}` });
      continue;
    }
    const current = await getFollow(ddb, config, userId, to);
    planned.push({ userId, from, to, kind: current ? "drop" : "move" });
  }
  return planned.sort((a, b) =>
    a.userId === b.userId ? (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) : a.userId < b.userId ? -1 : 1,
  );
};

export type FollowWriteOutcome = "moved" | "dropped" | "gone" | "conflict" | "failed";

const cancellationCodes = (error: unknown): string[] | null => {
  const candidate = error as { name?: unknown; CancellationReasons?: Array<{ Code?: string }> } | null;
  if (candidate?.name !== "TransactionCanceledException") return null;
  return (candidate.CancellationReasons ?? []).map((reason) => reason.Code ?? "None");
};

/**
 * Moves one follow, re-reading both rows on each attempt: the former row gone means nothing to do; the current row
 * present means only the former row is deleted; otherwise the current row is put and the former row deleted, in one
 * transaction. A transaction cancelled by a condition or a conflict is retried up to MAX_RETRIES times.
 */
export const moveFollow = async (
  ddb: DdbSender,
  config: RelabelConfig,
  follow: Pick<PlannedFollow, "userId" | "from" | "to">,
): Promise<{ outcome: FollowWriteOutcome; error?: string }> => {
  const keyNames = { "#pk": config.userIdAttribute };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const former = await getFollow(ddb, config, follow.userId, follow.from);
      if (!former) return { outcome: "gone" };
      const current = await getFollow(ddb, config, follow.userId, follow.to);
      const deleteFormer: TransactWriteItem = {
        Delete: {
          TableName: config.preferencesTable,
          Key: followKey(config, follow.userId, follow.from),
          ConditionExpression: "attribute_exists(#pk)",
          ExpressionAttributeNames: keyNames,
        },
      };
      const first: TransactWriteItem = current
        ? {
            ConditionCheck: {
              TableName: config.preferencesTable,
              Key: followKey(config, follow.userId, follow.to),
              ConditionExpression: "attribute_exists(#pk)",
              ExpressionAttributeNames: keyNames,
            },
          }
        : {
            Put: {
              TableName: config.preferencesTable,
              Item: movedItem(config, former, follow.to),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: keyNames,
            },
          };
      await ddb.send(new TransactWriteItemsCommand({ TransactItems: [first, deleteFormer] }));
      return { outcome: current ? "dropped" : "moved" };
    } catch (error) {
      const codes = cancellationCodes(error);
      const retryable = codes?.some((code) => code === "ConditionalCheckFailed" || code === "TransactionConflict");
      if (!retryable) return { outcome: "failed", error: errorText(error) };
    }
  }
  return { outcome: "conflict", error: `the follow changed during ${MAX_RETRIES + 1} attempts` };
};

/** The former row's attributes under the current name, with the current name's parent category. */
const movedItem = (
  config: RelabelConfig,
  former: Record<string, AttributeValue>,
  to: string,
): Record<string, AttributeValue> => {
  const item: Record<string, AttributeValue> = { ...former, [config.preferenceAttribute]: { S: to } };
  const parent = BILL_SUBCATEGORY_TO_CATEGORY[to as keyof typeof BILL_SUBCATEGORY_TO_CATEGORY];
  if (parent) item.category = { S: parent };
  // Rows from before the sort key held the value may also name the label in sub_category.
  const legacySubCategory = stringOf(former.sub_category);
  if (legacySubCategory && isLegacySubCategoryName(legacySubCategory)) {
    item.sub_category = { S: canonicalSubCategory(legacySubCategory) };
  }
  return item;
};

// ─── Report and run ─────────────────────────────────────────────────────────

const countByFormerName = (planned: readonly PlannedBill[]) => {
  const [socialJustice, identityPolitics] = Object.keys(LEGACY_SUB_CATEGORY_ALIASES);
  return {
    socialJustice: planned.filter((bill) => bill.from.includes(socialJustice)).length,
    identityPolitics: planned.filter((bill) => bill.from.includes(identityPolitics)).length,
    both: planned.filter((bill) => bill.from.includes(socialJustice) && bill.from.includes(identityPolitics)).length,
  };
};

/** The report's last line. */
export const planSummaryLine = (bills: BillScan | null, follows: readonly PlannedFollow[] | null): string => {
  const parts: string[] = [];
  if (bills) {
    const counts = countByFormerName(bills.planned);
    parts.push(
      `bills=${bills.planned.length}`,
      `socialJustice=${counts.socialJustice}`,
      `identityPolitics=${counts.identityPolitics}`,
      `both=${counts.both}`,
      `noSourceMetadata=${bills.planned.filter((bill) => !bill.hasSourceMetadata).length}`,
    );
  }
  if (follows) {
    const kind = (k: FollowPlanKind) => follows.filter((follow) => follow.kind === k).length;
    parts.push(
      `follows=${kind("move") + kind("drop")}`,
      `move=${kind("move")}`,
      `drop=${kind("drop")}`,
      `skipped=${kind("skipped")}`,
    );
  }
  if (bills) parts.push(`unreadable=${bills.unreadable.length}`);
  return `Relabel plan: ${parts.join(" ")}`;
};

const printBills = (scan: BillScan, log: Log): void => {
  const counts = countByFormerName(scan.planned);
  const [socialJustice, identityPolitics] = Object.keys(LEGACY_SUB_CATEGORY_ALIASES);
  log(`Bills read: ${scan.read}. Bills to relabel: ${scan.planned.length}`);
  log(
    `  "${socialJustice}": ${counts.socialJustice}, "${identityPolitics}": ${counts.identityPolitics}, both: ${counts.both}`,
  );
  if (scan.planned.length > 0) log(`  guids: ${scan.planned.map((bill) => bill.guid).join(", ")}`);
  const legacy = scan.planned.filter((bill) => !bill.hasSourceMetadata);
  if (legacy.length > 0) {
    log(
      `  ${legacy.length} have no source metadata (written before REL-30). The write moves their LastModified, ` +
        "which billDiffer's legacy anchor reads; a reconcile:processed-bills dry run over them before --apply " +
        `shows any pending text change: ${legacy.map((bill) => bill.guid).join(", ")}`,
    );
  }
  if (scan.unreadable.length > 0) {
    log(`  unreadable (${scan.unreadable.length}): ${scan.unreadable.map((u) => `${u.key} (${u.error})`).join(", ")}`);
  }
};

const printFollows = (follows: readonly PlannedFollow[], log: Log): void => {
  const actionable = follows.filter((follow) => follow.kind !== "skipped");
  log(`Follows under a former name: ${actionable.length}`);
  const byUser = new Map<string, PlannedFollow[]>();
  for (const follow of follows) byUser.set(follow.userId, [...(byUser.get(follow.userId) ?? []), follow]);
  for (const [userId, rows] of byUser) {
    const described = rows.map((row) =>
      row.kind === "skipped"
        ? `"${row.from}" left alone (${row.reason})`
        : `"${row.from}" -> "${row.to}" (${row.kind === "move" ? "move" : "already follows the new name: delete"})`,
    );
    log(`  ${userId}: ${described.join("; ")}`);
  }
};

export interface RunOptions {
  s3: S3Sender;
  ddb: DdbSender;
  config: RelabelConfig;
  options: CliOptions;
  log?: Log;
  logError?: Log;
  now?: () => Date;
  writeFile?: (path: string, text: string) => void;
}

export interface RunResult {
  bills: BillScan | null;
  follows: PlannedFollow[] | null;
  billOutcomes: Record<BillWriteOutcome, number>;
  followOutcomes: Record<FollowWriteOutcome, number>;
  /** A bill that could not be read, or a write that failed or kept conflicting. */
  failed: boolean;
}

/** The correlation id stored on every bill one run writes. */
export const runCorrelationId = (startedAt: Date): string =>
  `relabel-llm10-${startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;

export const runRelabel = async ({
  s3,
  ddb,
  config,
  options,
  log = console.log,
  logError = console.error,
  now = () => new Date(),
  writeFile = (path: string, text: string) => writeFileSync(path, text, "utf8"),
}: RunOptions): Promise<RunResult> => {
  const correlationId = runCorrelationId(now());
  const scope = options.preferences ? "follows" : options.guids.length > 0 ? "listed bills" : "bills and follows";
  log(
    `relabel:sub-categories mode=${options.apply ? "APPLY" : "DRY-RUN"} scope=${scope} ` +
      `bucket=${config.bucket} prefix=${config.processedPrefix} preferences=${config.preferencesTable}`,
  );

  const bills = options.preferences ? null : await scanBills(s3, config, options, log);
  if (bills) printBills(bills, log);
  if (bills && options.guidsOut) {
    writeFile(options.guidsOut, bills.planned.map((bill) => `${bill.guid}\n`).join(""));
    log(`Wrote ${bills.planned.length} planned guids to ${options.guidsOut}`);
  }
  const follows = options.preferences || options.guids.length === 0 ? await scanFollows(ddb, config) : null;
  if (follows) printFollows(follows, log);
  log(planSummaryLine(bills, follows));

  const billOutcomes: Record<BillWriteOutcome, number> = {
    relabelled: 0,
    already_current: 0,
    gone: 0,
    conflict: 0,
    failed: 0,
  };
  const followOutcomes: Record<FollowWriteOutcome, number> = { moved: 0, dropped: 0, gone: 0, conflict: 0, failed: 0 };
  const unreadable = (bills?.unreadable.length ?? 0) > 0;

  if (!options.apply) {
    log(
      options.preferences
        ? "Dry run: nothing written. Move the follows with --apply --preferences, once GET /preferences returns the " +
            "former names to builds 1.0 and R1 (RUNBOOK 14.7)."
        : `Dry run: nothing written. ${BILL_RELABEL_HOLD} Then relabel one bill with --guid <guid> --apply, then ` +
            "every bill with --apply.",
    );
    return { bills, follows, billOutcomes, followOutcomes, failed: unreadable };
  }

  if (bills) {
    log(`Relabelling ${bills.planned.length} bills, ${WRITE_CONCURRENCY} at a time (correlation id ${correlationId}).`);
    await mapWithConcurrency(bills.planned, WRITE_CONCURRENCY, async (bill) => {
      const result = await relabelBill(s3, config, bill.key, correlationId);
      billOutcomes[result.outcome] += 1;
      if (result.error)
        logError("Bill not relabelled", { guid: bill.guid, outcome: result.outcome, error: result.error });
    });
    log(
      `Bills: ${Object.entries(billOutcomes)
        .map(([outcome, count]) => `${outcome}=${count}`)
        .join(" ")}`,
    );
    if (follows) log("Follows not moved; move them with --apply --preferences.");
  } else if (follows) {
    const movable = follows.filter((follow) => follow.kind !== "skipped");
    log(`Moving ${movable.length} follows, one transaction each.`);
    for (const follow of movable) {
      const result = await moveFollow(ddb, config, follow);
      followOutcomes[result.outcome] += 1;
      if (result.error) logError("Follow not moved", { userId: follow.userId, from: follow.from, error: result.error });
    }
    log(
      `Follows: ${Object.entries(followOutcomes)
        .map(([outcome, count]) => `${outcome}=${count}`)
        .join(" ")}`,
    );
  }

  const failed =
    unreadable ||
    billOutcomes.failed + billOutcomes.conflict > 0 ||
    followOutcomes.failed + followOutcomes.conflict > 0;
  log(`Relabel complete${failed ? " with problems: rerun the dry run and check the log above" : ""}.`);
  return { bills, follows, billOutcomes, followOutcomes, failed };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runRelabel({
    s3: new S3Client({ region: config.region }),
    ddb: new DynamoDBClient({ region: config.region }),
    config,
    options,
  });
  if (result.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Relabel failed", error);
    process.exitCode = 1;
  });
}
