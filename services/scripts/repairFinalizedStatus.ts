#!/usr/bin/env node

// REL-44, once, on the day app 1.2 is out on the App Store (docs/RUNBOOK.md 4.13): marks "Finalized" the processed
// bills that became law before billStatus had that status. Until REL-44 nothing derived Finalized, so every bill that
// became law kept "Passed". billDiffer and billSummarizer now derive it (billOutcomes.deriveBillStatusFromActions), but
// billDiffer writes a bill only when it next handles it, with storedAt set to now, and a status change is news
// (RUNBOOK 4.9): the manifest row would move to the top of every "recently updated" list and into the weekly digest's
// week for a law months old. This script makes the one-time correction without moving any row and without a push.
// Dry run by default.
//
// Dry run (reads only): lists processed-bills/ (or reads the --guid bills) and plans each bill whose actions record it
// becoming law while its billStatus is a derived one (missing, "", New, Passed or Failed). For each it reads the
// BILL_GUID lookup and the BILL row it names (consistent reads), and plans the bill only when the row reflects the
// bill's current version: its documentStoredAt (rows written since 2026-10-28) is the bill's storedAt and its
// contentHash is the bill's billContentHash, or, for an older row without a hash, its updatedAt is the bill's storedAt
// or up to 3 s after it (March rows were dated 0.6 to 2.1 s after their storedAt) and its status is the bill's. The
// planned write sets billStatus to Finalized and, when the row's date is not the bill's storedAt (a row whose date a
// version without news kept, RUNBOOK 4.9, a March row, or a row redate:manifest-rows moved back), storedAt to the
// row's date. CreateBillsManifest then takes the version at the row's own sort key and rewrites the row in place (an
// older key would be skipped, a newer one would move the row). It prints the planned bills and why others were not
// planned, writes the plan (--plan-file, default repair-finalized-status-plan-<UTC time>.jsonl, never overwritten) and
// ends with
//   Finalized plan: read= planned= storedAtAligned= noSourceMetadata= recent7= recent14= recent28=
//   alreadyFinalized= unmanagedStatus= finalizedNotDerived= otherDrift=
//   skipped(noLookup= lookupMismatch= noRow= rowNotCurrent=) unreadable=
//
// --apply --plan-file <reviewed plan> --rule-live [--guid <guid>]: applies that plan's lines, never a fresh plan.
// --rule-live is the operator's statement that the REL-44 release runs on BillDiffer:prod and BillSummarizer:prod
// (RUNBOOK 4.13): before it, billSummarizer derives Passed again when it next summarizes a repaired bill, and moves its
// row (the release before REL-44 keeps a stored Finalized only in billDiffer). It refuses to start (exit code 2)
// without it, and unless BillsManifestQueue and BillsManifestDLQ hold no message, so every row reflects its bill's
// latest version. Per line, one at a time and paced (--rate, default 2 a second): GetObject; a version other than the
// plan's is "superseded" (nothing written; take the dry run again), or "alreadyApplied" when it is this script's own
// write; the lookup and the row must still be as planned; then PutObject with IfMatch on the ETag read, the same user
// metadata (the source-* keys billDiffer compares are kept; correlation-id becomes finalize-rel44-<run>) and a body
// identical but for billStatus (and storedAt when planned). Each applied line's undo record is appended to
// --undo-file (repair-finalized-status-undo-<UTC time>.jsonl, created before the first write) before the next line
// starts; Ctrl-C lets the line in flight finish. A rerun is idempotent: a line already written reports alreadyApplied.
//
// --undo <undo file> [--apply]: puts the stored billStatus back on each bill whose current version is still the one
// this script wrote (storedAt stays, so the row is rewritten in place again); any other bill is "changedSince" and
// left alone. A record repeated in the file (an apply rerun with the same undo file records each line it finds already
// written again: the canary's bills after the full run) counts once. Undo only with the REL-44 code rolled back:
// billDiffer derives Finalized again at the bill's next update.
// Devices that showed Finalized keep it: apps 1.1 and 1.2 never lower a status they hold.
//
// No push. The write reaches the pipeline as any processed write does: CreateBillsManifest rewrites the row in place
// (and, for a bill stored Failed, sets its "formerly failed" marker in the same transaction, REL-50) and forwards the
// key to NotificationTypeQueue and CongressMemberStatsQueue. NotificationType compares the summary, the title and the
// actions of the version written and the one before it (RUNBOOK 18.10); none of them change, so it sends nothing (a
// test pins it). CongressMemberStats reads none of the changed fields. No Bedrock call, no SQS send and no DynamoDB
// write of the script's own.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { DynamoDBClient, GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

import { BillStorage, isPreconditionFailure } from "../src/adapters/billStorage";
import { plainBillGuid } from "../src/shared/billCompanions";
import { deriveBillStatusFromActions, latestEnactmentAction } from "../src/shared/billOutcomes";
import { MANAGED_BILL_STATUSES, SOURCE_METADATA_KEYS } from "../src/shared/billSourceReconcile";
import {
  MANIFEST_CONTENT_HASH_ATTRIBUTE,
  billContentHash,
  isContentHash,
  manifestSortKey,
  manifestTimestamp,
} from "../src/shared/billVersionChange";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { CORRELATION_ID_METADATA_KEY } from "../src/shared/correlation";
import { sleep as sleepMs } from "../src/shared/retry";

type Item = Record<string, AttributeValue>;
type Doc = Record<string, unknown>;
type TableSender = Pick<DynamoDBClient, "send">;
type QueueSender = Pick<SQSClient, "send">;
type Log = (...args: unknown[]) => void;

// ─── Configuration and arguments ────────────────────────────────────────────

/** Bucket, table, key and queue names; the defaults are production's (infra/lib/config). */
export interface RepairConfig {
  region: string;
  bucket: string;
  processedPrefix: string;
  manifestTableName: string;
  manifestPrimaryKey: string;
  manifestSortKey: string;
  manifestPkValue: string;
  guidLookupPk: string;
  manifestQueueName: string;
  manifestDlqName: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): RepairConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  processedPrefix: env.PROCESSED_BILLS_PREFIX || "processed-bills/",
  manifestTableName: env.MANIFEST_TABLE_NAME || "BillsManifest",
  manifestPrimaryKey: env.MANIFEST_PRIMARY_KEY || "pk",
  manifestSortKey: env.MANIFEST_SORT_KEY || "sk",
  manifestPkValue: env.MANIFEST_PK_VALUE || "BILL",
  guidLookupPk: env.MANIFEST_GUID_LOOKUP_PK || "BILL_GUID",
  manifestQueueName: env.BILLS_MANIFEST_QUEUE_NAME || "BillsManifestQueue",
  manifestDlqName: env.BILLS_MANIFEST_DLQ_NAME || "BillsManifestDLQ",
});

/**
 * --apply needs --rule-live, the operator's statement that the REL-44 release runs on BillDiffer and BillSummarizer
 * (RUNBOOK 4.13 has the check). Before it, billSummarizer stamps Passed back on a repaired bill when it next summarizes
 * it, and moves its row.
 */
export const APPLY_REQUIRES_RULE_LIVE = true;
/** A row without a contentHash reflects a version stored this long before its date, at most (CreateBillsManifest). */
export const MAX_ROW_DATE_LAG_MS = 3_000;
export const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 25;
export const DEFAULT_RATE = 2;
const MAX_RATE = 5;
/** The apps' "recently updated" windows (7, 14 or 28 days): a bill dated inside one shows its new status there. */
const RECENT_WINDOWS_DAYS = [7, 14, 28] as const;
const PLAN_FILE_PREFIX = "repair-finalized-status-plan-";
const UNDO_FILE_PREFIX = "repair-finalized-status-undo-";
/** The correlation ids this script stores on the bills it writes; its own writes are recognised by them. */
const APPLY_CORRELATION_PREFIX = "finalize-rel44-";
const UNDO_CORRELATION_PREFIX = "finalize-rel44-undo-";
const FINALIZED = "Finalized";

export interface CliOptions {
  help: boolean;
  apply: boolean;
  /** With --apply: the operator says the REL-44 release runs on BillDiffer and BillSummarizer (APPLY_REQUIRES_RULE_LIVE). */
  ruleLive: boolean;
  /** Only these bills (plain guids). */
  guids: string[];
  concurrency: number;
  /** Writes a second, at most. */
  rate: number;
  /** The dry run's output, or the plan --apply applies; null for the default name (dry run only). */
  planFile: string | null;
  /** Where --apply appends the undo records; null for the default name. */
  undoFile: string | null;
  /** An undo file to revert (dry run unless --apply). */
  undo: string | null;
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
    ruleLive: false,
    guids: [],
    concurrency: DEFAULT_CONCURRENCY,
    rate: DEFAULT_RATE,
    planFile: null,
    undoFile: null,
    undo: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--rule-live") options.ruleLive = true;
    else if (arg === "--guid") {
      const raw = argv[(index += 1)];
      const guid = raw && !raw.startsWith("--") ? plainBillGuid(raw) : null;
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hjres131");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--concurrency") {
      options.concurrency = wholeNumber(valueAfter(argv, (index += 1), arg, "a number"), arg, 1, MAX_CONCURRENCY);
    } else if (arg === "--rate") {
      options.rate = wholeNumber(valueAfter(argv, (index += 1), arg, "a number"), arg, 1, MAX_RATE);
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
  "Mark Finalized the processed bills that became law before REL-44, keeping every manifest date (RUNBOOK 4.13).",
  "",
  "Usage:",
  "  npm run repair:finalized-status                                                    Dry run: writes the plan",
  "  npm run repair:finalized-status -- --apply --rule-live --plan-file <plan> --guid G  Apply one bill of a plan",
  "  npm run repair:finalized-status -- --apply --rule-live --plan-file <plan>           Apply a reviewed plan",
  "  npm run repair:finalized-status -- --undo <undo file> [--apply]                    Put the old status back",
  "",
  "Options:",
  "  --apply              Write (the default is a dry run, which only reads)",
  "  --rule-live          With --apply: the REL-44 release runs on BillDiffer and BillSummarizer (required)",
  `  --plan-file <path>   Dry run: where the plan goes (default ${PLAN_FILE_PREFIX}<UTC time>.jsonl); --apply: the`,
  "                       plan to apply (required)",
  "  --guid <guid>        Only this bill (repeatable; a text-version suffix is ignored)",
  `  --concurrency <n>    Dry-run reads in flight (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  `  --rate <n>           Writes a second, at most (default ${DEFAULT_RATE}, at most ${MAX_RATE})`,
  `  --undo-file <path>   Where --apply appends the undo records (default ${UNDO_FILE_PREFIX}<UTC time>.jsonl)`,
  "  --undo <path>        Revert the bills of an undo file, newest first (with --apply; otherwise a dry run)",
  "",
  "--apply refuses to start (exit code 2) without --rule-live and unless BillsManifestQueue and BillsManifestDLQ are",
  "empty. Ctrl-C during a write starts no new line and lets the one in flight write its undo record (press it again",
  "to exit at once). The undo dry run only reads. No push, Bedrock call, SQS send or DynamoDB write.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "PROCESSED_BILLS_PREFIX, MANIFEST_TABLE_NAME, MANIFEST_PRIMARY_KEY, MANIFEST_SORT_KEY, MANIFEST_PK_VALUE,",
  "MANIFEST_GUID_LOOKUP_PK, BILLS_MANIFEST_QUEUE_NAME, BILLS_MANIFEST_DLQ_NAME",
].join("\n");

// ─── The rule ────────────────────────────────────────────────────────────────

const asDoc = (value: unknown): Doc =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Doc) : {};

/** The stored billStatus, or null when the document has none (a missing field, not a string). */
const storedStatusOf = (doc: Doc): string | null => (typeof doc.billStatus === "string" ? doc.billStatus : null);

const actionsOf = (doc: Doc): unknown[] | undefined => (Array.isArray(doc.actions) ? doc.actions : undefined);

export type BillState =
  /** It became law and its stored status is a derived one: the script marks it Finalized. */
  | "candidate"
  | "alreadyFinalized"
  /** It became law but is stored as "Updated" (or another status billDiffer keeps): left as it is. */
  | "unmanagedStatus"
  /** Stored as Finalized although its actions record no law: billDiffer derives it again at its next update. */
  | "finalizedNotDerived"
  /** Another derived status differs from the actions (REL-37 drift): reconcile:processed-bills patches those. */
  | "otherDrift"
  | "unchanged";

/** How a processed bill's stored status compares with the status its actions give. */
export const billState = (doc: Doc): BillState => {
  const stored = storedStatusOf(doc);
  const derived = deriveBillStatusFromActions(actionsOf(doc));
  const managed = stored === null || MANAGED_BILL_STATUSES.has(stored);
  if (derived === FINALIZED) {
    if (stored === FINALIZED) return "alreadyFinalized";
    return managed ? "candidate" : "unmanagedStatus";
  }
  if (stored === FINALIZED) return "finalizedNotDerived";
  return managed && (stored ?? "") !== derived ? "otherDrift" : "unchanged";
};

/**
 * The document the script writes: billStatus Finalized, and storedAt set to the manifest row's date when that is not
 * the stored one. Every other field keeps its value and its position.
 */
export const finalizedDocument = (doc: Doc, toStoredAt: string): Doc => ({
  ...doc,
  ...(manifestTimestamp(doc.storedAt) === toStoredAt ? {} : { storedAt: toStoredAt }),
  billStatus: FINALIZED,
});

/** Whether the row's date is the document's storedAt or at most MAX_ROW_DATE_LAG_MS after it. */
const rowDatedByDocument = (row: Item, doc: Doc): boolean => {
  const storedAt = manifestTimestamp(doc.storedAt);
  const rowUpdatedAt = manifestTimestamp(row.updatedAt?.S);
  if (!storedAt || !rowUpdatedAt) return false;
  const lagMs = Date.parse(rowUpdatedAt) - Date.parse(storedAt);
  return lagMs >= 0 && lagMs <= MAX_ROW_DATE_LAG_MS;
};

/**
 * Whether the BILL row reflects this version of the bill, as repair:failed-status judges it: its documentStoredAt (rows
 * written since 2026-10-28) is the bill's storedAt, and its contentHash, when it has one this code reads, is the
 * bill's; an older row without a hash by its date (the version's storedAt, or up to MAX_ROW_DATE_LAG_MS after it) and
 * its status.
 */
export const rowReflectsDocument = (row: Item, doc: Doc): boolean => {
  const storedAt = manifestTimestamp(doc.storedAt);
  if (!storedAt) return false;
  const rowDocumentAt = manifestTimestamp(row.documentStoredAt?.S);
  if (rowDocumentAt !== null && rowDocumentAt !== storedAt) return false;
  const rowHash = row[MANIFEST_CONTENT_HASH_ATTRIBUTE]?.S;
  if (isContentHash(rowHash)) return rowHash === billContentHash(doc);
  return rowDatedByDocument(row, doc) && (row.billStatus?.S ?? "") === (storedStatusOf(doc) ?? "");
};

// ─── Planning ────────────────────────────────────────────────────────────────

export interface PlanLine {
  guid: string;
  key: string;
  /** The processed bill's version and ETag the dry run read; --apply writes only over this version. */
  versionId: string;
  etag: string;
  /** The stored billStatus (null: none). */
  fromStatus: string | null;
  storedAt: string;
  /** The storedAt the write stores: the row's date (equal to storedAt unless the row's date differs). */
  toStoredAt: string;
  manifestSk: string;
  rowUpdatedAt: string;
  rowContentHash: string | null;
  /** The row's documentStoredAt (null for a row written before 2026-10-28); --apply checks it is unchanged. */
  rowDocumentStoredAt: string | null;
  rowBillStatus: string | null;
  /** billContentHash of the document written, which CreateBillsManifest stamps on the row. */
  contentHashAfter: string;
  enactment: { actionCode?: string; actionDate?: string; text?: string };
  /** False for a bill written before REL-30 (no source-text-hash): the write moves its LastModified (RUNBOOK 4.4). */
  hasSourceMetadata: boolean;
}

export type SkipReason = "noLookup" | "lookupMismatch" | "noRow" | "rowNotCurrent";
export const SKIP_REASONS: readonly SkipReason[] = ["noLookup", "lookupMismatch", "noRow", "rowNotCurrent"];

export type Assessment =
  | { guid: string; outcome: "planned"; line: PlanLine }
  | { guid: string; outcome: Exclude<BillState, "candidate" | "unchanged">; fromStatus: string | null; to: string }
  | { guid: string; outcome: "unchanged" }
  | { guid: string; outcome: "skipped"; reason: SkipReason; detail?: string }
  | { guid: string; outcome: "unreadable"; detail: string };

interface ReadDeps {
  db: TableSender;
  storage: BillStorage;
  config: RepairConfig;
}

const rowKey = (config: RepairConfig, sk: string): Item => ({
  [config.manifestPrimaryKey]: { S: config.manifestPkValue },
  [config.manifestSortKey]: { S: sk },
});

const lookupKey = (config: RepairConfig, guid: string): Item => ({
  [config.manifestPrimaryKey]: { S: config.guidLookupPk },
  [config.manifestSortKey]: { S: guid },
});

const getItem = async (db: TableSender, config: RepairConfig, key: Item): Promise<Item | undefined> =>
  (await db.send(new GetItemCommand({ TableName: config.manifestTableName, Key: key, ConsistentRead: true }))).Item;

const processedKey = (config: RepairConfig, guid: string): string => `${config.processedPrefix}${guid}.json`;
const guidOfKey = (config: RepairConfig, key: string): string => key.slice(config.processedPrefix.length, -5);

/** The flat processed-bills/<guid>.json keys (the only layout writers use). */
const listProcessedKeys = async (storage: BillStorage, config: RepairConfig): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await storage.s3Client.send(
      new ListObjectsV2Command({
        Bucket: storage.bucketName,
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

/** Reads one bill, and for a candidate its lookup and row, and plans it or says why not. */
export const assessBill = async ({ db, storage, config }: ReadDeps, key: string): Promise<Assessment> => {
  const guid = guidOfKey(config, key);
  const stored = await storage.getJsonObject<unknown>(key);
  if (stored.value === null || stored.value === undefined) return { guid, outcome: "unreadable", detail: "no bill" };
  const doc = asDoc(stored.value);
  const state = billState(doc);
  if (state === "unchanged") return { guid, outcome: "unchanged" };
  if (state !== "candidate") {
    return {
      guid,
      outcome: state,
      fromStatus: storedStatusOf(doc),
      to: deriveBillStatusFromActions(actionsOf(doc)),
    };
  }
  if (!stored.versionId || !stored.etag) return { guid, outcome: "unreadable", detail: "no VersionId or ETag" };

  const skip = (reason: SkipReason, detail?: string): Assessment => ({
    guid,
    outcome: "skipped",
    reason,
    ...(detail ? { detail } : {}),
  });
  const lookup = await getItem(db, config, lookupKey(config, guid));
  const manifestSk = lookup?.manifestSk?.S;
  if (!manifestSk) return skip("noLookup");
  const row = await getItem(db, config, rowKey(config, manifestSk));
  if (!row) return skip("noRow", manifestSk);
  const rowUpdatedAt = row.updatedAt?.S ?? "";
  if (manifestSortKey(rowUpdatedAt, guid) !== manifestSk) return skip("lookupMismatch", manifestSk);
  if (!rowReflectsDocument(row, doc)) {
    return skip("rowNotCurrent", `row ${rowUpdatedAt}, storedAt ${String(doc.storedAt ?? "")}`);
  }

  const next = finalizedDocument(doc, rowUpdatedAt);
  const enactment = latestEnactmentAction(actionsOf(doc)) ?? {};
  return {
    guid,
    outcome: "planned",
    line: {
      guid,
      key,
      versionId: stored.versionId,
      etag: stored.etag,
      fromStatus: storedStatusOf(doc),
      storedAt: String(doc.storedAt ?? ""),
      toStoredAt: rowUpdatedAt,
      manifestSk,
      rowUpdatedAt,
      rowContentHash: row[MANIFEST_CONTENT_HASH_ATTRIBUTE]?.S ?? null,
      rowDocumentStoredAt: row.documentStoredAt?.S ?? null,
      rowBillStatus: row.billStatus?.S ?? null,
      contentHashAfter: billContentHash(next),
      enactment: {
        ...(enactment.actionCode ? { actionCode: enactment.actionCode } : {}),
        ...(enactment.actionDate ? { actionDate: enactment.actionDate } : {}),
        ...(enactment.text ? { text: enactment.text } : {}),
      },
      hasSourceMetadata: Boolean(stored.metadata?.[SOURCE_METADATA_KEYS.textHash]),
    },
  };
};

export interface PlanSummary {
  read: number;
  planned: number;
  storedAtAligned: number;
  noSourceMetadata: number;
  /** Planned bills whose row is dated within each recent window (days -> count). */
  recent: Record<(typeof RECENT_WINDOWS_DAYS)[number], number>;
  alreadyFinalized: number;
  unmanagedStatus: number;
  finalizedNotDerived: number;
  otherDrift: number;
  skipped: Record<SkipReason, number>;
  unreadable: number;
}

export const summarizePlan = (assessments: readonly Assessment[], now: Date): PlanSummary => {
  const lines = assessments.flatMap((entry) => (entry.outcome === "planned" ? [entry.line] : []));
  const count = (outcome: Assessment["outcome"]) => assessments.filter((entry) => entry.outcome === outcome).length;
  const skipped = Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<SkipReason, number>;
  for (const entry of assessments) if (entry.outcome === "skipped") skipped[entry.reason] += 1;
  const recent = Object.fromEntries(
    RECENT_WINDOWS_DAYS.map((days) => {
      const since = now.getTime() - days * 86_400_000;
      return [days, lines.filter((line) => Date.parse(line.rowUpdatedAt) >= since).length];
    }),
  ) as PlanSummary["recent"];
  return {
    read: assessments.length,
    planned: lines.length,
    storedAtAligned: lines.filter((line) => line.toStoredAt !== manifestTimestamp(line.storedAt)).length,
    noSourceMetadata: lines.filter((line) => !line.hasSourceMetadata).length,
    recent,
    alreadyFinalized: count("alreadyFinalized"),
    unmanagedStatus: count("unmanagedStatus"),
    finalizedNotDerived: count("finalizedNotDerived"),
    otherDrift: count("otherDrift"),
    skipped,
    unreadable: count("unreadable"),
  };
};

/** The report's last line. */
export const planSummaryLine = (summary: PlanSummary): string =>
  `Finalized plan: read=${summary.read} planned=${summary.planned} storedAtAligned=${summary.storedAtAligned} ` +
  `noSourceMetadata=${summary.noSourceMetadata} ` +
  RECENT_WINDOWS_DAYS.map((days) => `recent${days}=${summary.recent[days]}`).join(" ") +
  ` alreadyFinalized=${summary.alreadyFinalized} unmanagedStatus=${summary.unmanagedStatus} ` +
  `finalizedNotDerived=${summary.finalizedNotDerived} otherDrift=${summary.otherDrift} ` +
  `skipped(${SKIP_REASONS.map((reason) => `${reason}=${summary.skipped[reason]}`).join(" ")}) ` +
  `unreadable=${summary.unreadable}`;

/** repair-finalized-status-plan-20261019T030000Z.jsonl for 2026-10-19T03:00:00.123Z. */
const fileStamp = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

export const defaultPlanFile = (at: Date): string => `${PLAN_FILE_PREFIX}${fileStamp(at)}.jsonl`;
export const defaultUndoFile = (at: Date): string => `${UNDO_FILE_PREFIX}${fileStamp(at)}.jsonl`;
/** The correlation id stored on every bill one run writes. */
export const runCorrelationId = (at: Date, undo = false): string =>
  `${undo ? UNDO_CORRELATION_PREFIX : APPLY_CORRELATION_PREFIX}${fileStamp(at)}`;

const PLAN_STRING_FIELDS = [
  "guid",
  "key",
  "versionId",
  "etag",
  "toStoredAt",
  "manifestSk",
  "rowUpdatedAt",
  "contentHashAfter",
] as const;

/** The plan file's lines, each checked to be a status write of its own guid at its row's date. */
export const parsePlanFile = (text: string, config: RepairConfig): PlanLine[] =>
  text
    .split("\n")
    .map((raw, index) => ({ raw: raw.trim(), number: index + 1 }))
    .filter(({ raw }) => raw.length > 0)
    .map(({ raw, number }) => {
      const line = JSON.parse(raw) as PlanLine;
      const missing = PLAN_STRING_FIELDS.filter((field) => typeof line[field] !== "string" || !line[field]);
      if (missing.length > 0) throw new Error(`Plan line ${number}: missing ${missing.join(", ")}`);
      if (
        typeof line.storedAt !== "string" ||
        !(line.fromStatus === null || typeof line.fromStatus === "string") ||
        (line.rowContentHash !== null && typeof line.rowContentHash !== "string") ||
        (line.rowDocumentStoredAt !== null && typeof line.rowDocumentStoredAt !== "string") ||
        line.key !== processedKey(config, line.guid) ||
        line.manifestSk !== manifestSortKey(line.rowUpdatedAt, line.guid) ||
        line.toStoredAt !== line.rowUpdatedAt
      ) {
        throw new Error(`Plan line ${number} (${line.guid}): not a status write of its guid at its row's date`);
      }
      return line;
    });

// ─── Applying ────────────────────────────────────────────────────────────────

export interface UndoRecord {
  guid: string;
  key: string;
  manifestSk: string;
  correlationId: string;
  /** When the write committed; for an alreadyApplied line, when this run found it. */
  appliedAt: string;
  before: { versionId: string; billStatus: string | null; storedAt: string };
  after: { versionId: string; billStatus: string; storedAt: string };
}

export type ApplyOutcome =
  | "applied"
  /** The write landed but its answer was lost: the current version is this run's. */
  | "appliedLostResponse"
  /** An earlier run of this script wrote it: no write, and its undo record again (that run may have stopped first). */
  | "alreadyApplied"
  /** The bill, its lookup or its row changed since the dry run: no write; take the dry run again. */
  | "superseded"
  /** The processed bill no longer exists. */
  | "gone"
  | "failed";

export const APPLY_OUTCOMES: readonly ApplyOutcome[] = [
  "applied",
  "appliedLostResponse",
  "alreadyApplied",
  "superseded",
  "gone",
  "failed",
];

interface ApplyDeps extends ReadDeps {
  log: Log;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** True once SIGINT or SIGTERM arrived (main): no new line starts. */
  interrupted: () => boolean;
}

const correlationOf = (metadata: Record<string, string> | undefined): string =>
  metadata?.[CORRELATION_ID_METADATA_KEY] ?? "";

const isOwnApplyWrite = (metadata: Record<string, string> | undefined): boolean => {
  const id = correlationOf(metadata);
  return id.startsWith(APPLY_CORRELATION_PREFIX) && !id.startsWith(UNDO_CORRELATION_PREFIX);
};

const undoRecord = (
  line: PlanLine,
  correlationId: string,
  afterVersionId: string,
  afterStoredAt: string,
  at: Date,
): UndoRecord => ({
  guid: line.guid,
  key: line.key,
  manifestSk: line.manifestSk,
  correlationId,
  appliedAt: at.toISOString(),
  before: { versionId: line.versionId, billStatus: line.fromStatus, storedAt: line.storedAt },
  after: { versionId: afterVersionId, billStatus: FINALIZED, storedAt: afterStoredAt },
});

/** Re-reads one plan line's bill, lookup and row, and writes the Finalized status over the version read. */
export const applyPlanLine = async (
  deps: ApplyDeps,
  line: PlanLine,
  correlationId: string,
): Promise<{ outcome: Exclude<ApplyOutcome, "failed">; record?: UndoRecord }> => {
  const { db, storage, config, now } = deps;
  const stored = await storage.getJsonObject<unknown>(line.key);
  if (stored.value === null || stored.value === undefined) return { outcome: "gone" };
  const doc = asDoc(stored.value);
  if (stored.versionId !== line.versionId) {
    if (isOwnApplyWrite(stored.metadata) && doc.billStatus === FINALIZED && stored.versionId) {
      const record = undoRecord(line, correlationOf(stored.metadata), stored.versionId, String(doc.storedAt), now());
      return { outcome: "alreadyApplied", record };
    }
    return { outcome: "superseded" };
  }
  const lookup = await getItem(db, config, lookupKey(config, line.guid));
  if (lookup?.manifestSk?.S !== line.manifestSk) return { outcome: "superseded" };
  const row = await getItem(db, config, rowKey(config, line.manifestSk));
  if (
    !row ||
    row.updatedAt?.S !== line.rowUpdatedAt ||
    (row[MANIFEST_CONTENT_HASH_ATTRIBUTE]?.S ?? null) !== line.rowContentHash ||
    (row.documentStoredAt?.S ?? null) !== line.rowDocumentStoredAt
  ) {
    return { outcome: "superseded" };
  }
  if (storedStatusOf(doc) !== line.fromStatus || billState(doc) !== "candidate" || !stored.etag) {
    return { outcome: "superseded" };
  }

  const next = finalizedDocument(doc, line.toStoredAt);
  const record = (versionId: string) => undoRecord(line, correlationId, versionId, String(next.storedAt), now());
  try {
    const written = await storage.putJson(line.key, next, {
      metadata: { ...(stored.metadata ?? {}), [CORRELATION_ID_METADATA_KEY]: correlationId },
      ifMatch: stored.etag,
    });
    return { outcome: "applied", record: record(written.versionId ?? "") };
  } catch (error) {
    // A put can fail after it landed (the answer lost after the SDK's retries): look before judging.
    const after = await storage.getJsonObject<unknown>(line.key);
    if (correlationOf(after.metadata) === correlationId && asDoc(after.value).billStatus === FINALIZED) {
      return { outcome: "appliedLostResponse", record: record(after.versionId ?? "") };
    }
    if (isPreconditionFailure(error)) return { outcome: "superseded" };
    throw error;
  }
};

/** The undo file's records, each checked to name a write of its own guid. */
export const parseUndoFile = (text: string, config: RepairConfig): UndoRecord[] =>
  text
    .split("\n")
    .map((raw, index) => ({ raw: raw.trim(), number: index + 1 }))
    .filter(({ raw }) => raw.length > 0)
    .map(({ raw, number }) => {
      const record = JSON.parse(raw) as UndoRecord;
      if (
        typeof record.guid !== "string" ||
        record.key !== processedKey(config, record.guid) ||
        typeof record.after?.versionId !== "string" ||
        !record.after.versionId ||
        !record.before ||
        !(record.before.billStatus === null || typeof record.before.billStatus === "string")
      ) {
        throw new Error(`Undo line ${number}: not a repair:finalized-status record`);
      }
      return record;
    });

export type UndoOutcome =
  /** Dry run: the current version is still the one this script wrote, so it would be reverted. */
  | "revertible"
  | "reverted"
  /** The revert landed but its answer was lost. */
  | "revertedLostResponse"
  /** An earlier undo already put the status back. */
  | "alreadyReverted"
  /** A newer version was written since (or the bill is gone): left as it is. */
  | "changedSince"
  | "failed";

export const UNDO_OUTCOMES: readonly UndoOutcome[] = [
  "revertible",
  "reverted",
  "revertedLostResponse",
  "alreadyReverted",
  "changedSince",
  "failed",
];

/** The document with the status the bill had before the repair (none when it had none); storedAt stays. */
export const revertedDocument = (doc: Doc, billStatus: string | null): Doc => {
  if (billStatus !== null) return { ...doc, billStatus };
  const rest = { ...doc };
  delete rest.billStatus;
  return rest;
};

/** Puts one bill's old status back when its current version is still the one the repair wrote. */
export const undoRecordLine = async (
  deps: ApplyDeps,
  record: UndoRecord,
  apply: boolean,
  correlationId: string,
): Promise<Exclude<UndoOutcome, "failed">> => {
  const { storage } = deps;
  const stored = await storage.getJsonObject<unknown>(record.key);
  if (stored.value === null || stored.value === undefined) return "changedSince";
  const doc = asDoc(stored.value);
  if (stored.versionId !== record.after.versionId) {
    const id = correlationOf(stored.metadata);
    return id.startsWith(UNDO_CORRELATION_PREFIX) && storedStatusOf(doc) === record.before.billStatus
      ? "alreadyReverted"
      : "changedSince";
  }
  if (!apply) return "revertible";
  try {
    await storage.putJson(record.key, revertedDocument(doc, record.before.billStatus), {
      metadata: { ...(stored.metadata ?? {}), [CORRELATION_ID_METADATA_KEY]: correlationId },
      ...(stored.etag ? { ifMatch: stored.etag } : {}),
    });
    return "reverted";
  } catch (error) {
    const after = await storage.getJsonObject<unknown>(record.key);
    if (correlationOf(after.metadata) === correlationId) return "revertedLostResponse";
    if (isPreconditionFailure(error)) return "changedSince";
    throw error;
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
export const manifestQueueDepths = async (sqs: QueueSender, config: RepairConfig): Promise<QueueDepth[]> => {
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
  config: RepairConfig;
  options: CliOptions;
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
  /** Whether --apply needs --rule-live; defaults to APPLY_REQUIRES_RULE_LIVE. */
  requireRuleLive?: boolean;
}

export interface RunResult {
  exitCode: 0 | 1 | 2;
  summary?: PlanSummary;
  planFile?: string;
  applied?: Record<ApplyOutcome, number>;
  undone?: Record<UndoOutcome, number>;
  undoFile?: string;
  /** Lines not started because the run was interrupted. */
  remaining?: number;
}

const selectGuids = <T extends { guid: string }>(entries: readonly T[], options: CliOptions): T[] =>
  options.guids.length > 0 ? entries.filter((entry) => options.guids.includes(entry.guid)) : [...entries];

/** Runs `step` for each entry in turn, at most `rate` a second, and none once interrupted; returns how many remain. */
const paced = async <T>(
  entries: readonly T[],
  rate: number,
  { now, sleep, interrupted }: Pick<ApplyDeps, "now" | "sleep" | "interrupted">,
  step: (entry: T) => Promise<void>,
): Promise<number> => {
  const intervalMs = 1000 / rate;
  let nextStartAt = now().getTime();
  for (const [index, entry] of entries.entries()) {
    const waitMs = nextStartAt - now().getTime();
    if (waitMs > 0) await sleep(waitMs);
    if (interrupted()) return entries.length - index;
    nextStartAt = Math.max(now().getTime(), nextStartAt) + intervalMs;
    await step(entry);
  }
  return 0;
};

const describeLine = (line: PlanLine): string =>
  `${line.guid}: ${line.fromStatus ?? "(none)"} -> Finalized` +
  (line.toStoredAt !== manifestTimestamp(line.storedAt) ? `, storedAt ${line.storedAt} -> ${line.toStoredAt}` : "") +
  ` (row ${line.rowUpdatedAt}; ${[line.enactment.actionDate, line.enactment.text].filter(Boolean).join(" ")})`;

/** Plans every processed bill (or the --guid ones) and writes the plan file. */
const runDryRun = async (deps: ApplyDeps & Required<Pick<RunOptions, "createFile">>, options: CliOptions) => {
  const { storage, config, log, now, createFile } = deps;
  const keys =
    options.guids.length > 0
      ? options.guids.map((guid) => processedKey(config, guid))
      : await listProcessedKeys(storage, config);
  log(`Reading ${keys.length} bills under s3://${storage.bucketName}/${config.processedPrefix}`);
  let read = 0;
  const assessments = await mapWithConcurrency(keys, options.concurrency, async (key): Promise<Assessment> => {
    const guid = guidOfKey(config, key);
    try {
      return await assessBill(deps, key);
    } catch (error) {
      return { guid, outcome: "unreadable", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      read += 1;
      if (read % 1000 === 0) log(`Read ${read} / ${keys.length} bills...`);
    }
  });
  assessments.sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));

  const lines = assessments.flatMap((entry) => (entry.outcome === "planned" ? [entry.line] : []));
  for (const line of lines) log(`  planned ${describeLine(line)}`);
  for (const entry of assessments) {
    if (entry.outcome === "skipped") {
      log(`  skipped (${entry.reason}) ${entry.guid}${entry.detail ? `: ${entry.detail}` : ""}`);
    } else if (entry.outcome === "unreadable") {
      log(`  unreadable ${entry.guid}: ${entry.detail}`);
    } else if (entry.outcome !== "planned" && entry.outcome !== "unchanged") {
      log(`  ${entry.outcome} ${entry.guid}: stored ${entry.fromStatus ?? "(none)"}, actions say ${entry.to}`);
    }
  }
  const summary = summarizePlan(assessments, now());
  let planFile: string | undefined;
  if (lines.length > 0) {
    planFile = options.planFile ?? defaultPlanFile(now());
    createFile(planFile, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    log(`Plan: ${lines.length} lines in ${planFile}`);
  } else {
    log("Plan: nothing to mark Finalized; no plan file written");
  }
  if (summary.noSourceMetadata > 0) {
    log(
      `  ${summary.noSourceMetadata} planned bills have no source metadata (written before REL-30): the write moves ` +
        "their LastModified, which billDiffer's legacy anchor reads (RUNBOOK 4.4).",
    );
  }
  log(planSummaryLine(summary));
  log(
    "Dry run: nothing written. Review and archive the plan, then, once it is approved, --apply --rule-live " +
      "--plan-file <plan> --guid <canary>, and the rest (RUNBOOK 4.13).",
  );
  return { exitCode: summary.unreadable > 0 ? 1 : 0, summary, ...(planFile ? { planFile } : {}) } as const;
};

/** Writes the Finalized status of a reviewed plan's bills, paced; writes an undo record for each. */
const runApply = async (
  deps: ApplyDeps & Required<Pick<RunOptions, "appendFile" | "readFile" | "sqs" | "logError" | "requireRuleLive">>,
  options: CliOptions,
): Promise<RunResult> => {
  const { config, log, logError, now, appendFile, readFile, sqs, requireRuleLive } = deps;
  const lines = selectGuids(parsePlanFile(readFile(options.planFile!), config), options);
  log(`Plan ${options.planFile}: ${lines.length} lines to apply`);

  if (requireRuleLive && !options.ruleLive) {
    logError(
      "Refusing to apply without --rule-live: run it only once the REL-44 release runs on BillDiffer and " +
        "BillSummarizer (RUNBOOK 4.13), or billSummarizer stamps Passed back at a repaired bill's next summary",
    );
    return { exitCode: 2 };
  }
  const depths = await manifestQueueDepths(sqs, config);
  for (const depth of depths) {
    log(`  ${depth.name}: visible=${depth.visible} notVisible=${depth.notVisible} delayed=${depth.delayed}`);
  }
  if (depths.some((depth) => depth.visible + depth.notVisible + depth.delayed > 0)) {
    logError(
      "Refusing to apply: a manifest queue holds messages, so a row may not reflect its bill yet. BillsManifestQueue " +
        "drains by itself; a message in BillsManifestDLQ never does: inspect and redrive it (RUNBOOK 4.9 P2), then " +
        "take the dry run again",
    );
    return { exitCode: 2 };
  }

  const correlationId = runCorrelationId(now());
  const undoFile = options.undoFile ?? defaultUndoFile(now());
  // Created before the first write, so a path that cannot be written stops the run before any write.
  appendFile(undoFile, "");
  log(
    `Applying ${lines.length} lines at most ${options.rate} a second (correlation id ${correlationId}); undo ` +
      `records go to ${undoFile}`,
  );
  const applied = Object.fromEntries(APPLY_OUTCOMES.map((outcome) => [outcome, 0])) as Record<ApplyOutcome, number>;
  const remaining = await paced(lines, options.rate, deps, async (line) => {
    let result: Awaited<ReturnType<typeof applyPlanLine>> | { outcome: "failed"; record?: undefined };
    try {
      result = await applyPlanLine(deps, line, correlationId);
    } catch (error) {
      result = { outcome: "failed" };
      logError("Failed to mark the bill Finalized", { guid: line.guid, error });
    }
    applied[result.outcome] += 1;
    if (result.outcome !== "applied") log(`  ${result.outcome}: ${line.guid}`);
    if (result.record) {
      try {
        appendFile(undoFile, `${JSON.stringify(result.record)}\n`);
      } catch (error) {
        // The bill is written; going on would write the next ones without an undo record too.
        logError("Applied without an undo record; stopping", { record: result.record, error });
        throw error;
      }
    }
  });
  log(`Applied: ${APPLY_OUTCOMES.map((outcome) => `${outcome}=${applied[outcome]}`).join(" ")} remaining=${remaining}`);
  if (remaining > 0) log(`Interrupted: ${remaining} lines remain; run again to resume.`);
  if (applied.superseded > 0) log("Superseded lines changed since the dry run: take the dry run again for them.");
  if (applied.failed > 0) log("A failed line may have landed: run again, which records it if it did (alreadyApplied).");
  return { exitCode: applied.failed > 0 ? 1 : 0, applied, undoFile, remaining };
};

/**
 * The undo records with each write once: an apply rerun with the same undo file records every line it finds already
 * written (alreadyApplied) again, with the same version, so the canary's bills appear twice after the full run. The
 * first of each guid and version is kept.
 */
export const uniqueUndoRecords = (records: readonly UndoRecord[]): UndoRecord[] => {
  const seen = new Set<string>();
  return records.filter((record) => {
    const write = `${record.guid}|${record.after.versionId}`;
    if (seen.has(write)) return false;
    seen.add(write);
    return true;
  });
};

/** Puts the old status back on the bills of an undo file (newest first) that nothing has written since. */
const runUndo = async (
  deps: ApplyDeps & Required<Pick<RunOptions, "readFile" | "logError">>,
  options: CliOptions,
): Promise<RunResult> => {
  const { log, logError, readFile, now, config } = deps;
  const parsed = parseUndoFile(readFile(options.undo!), config).reverse();
  const unique = uniqueUndoRecords(parsed);
  const records = selectGuids(unique, options);
  const correlationId = runCorrelationId(now(), true);
  log(
    `Undo ${options.undo}: ${records.length} records${options.apply ? ` (correlation id ${correlationId})` : " (dry run)"}`,
  );
  if (options.apply) {
    log(
      "  billDiffer derives Finalized again at each bill's next update unless the REL-44 code is rolled back, and " +
        "devices that showed Finalized keep it (the apps never lower a status).",
    );
  }
  if (parsed.length > unique.length) {
    log(`  repeated records (written again by a rerun): ${parsed.length - unique.length}, each counted once`);
  }
  const undone = Object.fromEntries(UNDO_OUTCOMES.map((outcome) => [outcome, 0])) as Record<UndoOutcome, number>;
  const step = async (record: UndoRecord): Promise<void> => {
    let outcome: UndoOutcome;
    try {
      outcome = await undoRecordLine(deps, record, options.apply, correlationId);
    } catch (error) {
      outcome = "failed";
      logError("Failed to put the old status back", { guid: record.guid, error });
    }
    undone[outcome] += 1;
    if (outcome === "changedSince" || outcome === "failed") log(`  ${outcome}: ${record.guid}`);
  };
  let remaining = 0;
  if (options.apply) remaining = await paced(records, options.rate, deps, step);
  else await mapWithConcurrency(records, options.concurrency, step);
  log(
    `Undo: records=${records.length} ${UNDO_OUTCOMES.map((outcome) => `${outcome}=${undone[outcome]}`).join(" ")} ` +
      `remaining=${remaining}`,
  );
  return { exitCode: undone.failed > 0 ? 1 : 0, undone, remaining };
};

/** The dry run, an apply of a plan file, or an undo, by the options. */
export const runRepair = async ({
  db,
  storage,
  sqs,
  config,
  options,
  log = console.log,
  logError = console.error,
  now = () => new Date(),
  sleep = sleepMs,
  appendFile = (path: string, text: string) => appendFileSync(path, text, "utf8"),
  createFile = (path: string, text: string) => writeFileSync(path, text, { encoding: "utf8", flag: "wx" }),
  readFile = (path: string) => readFileSync(path, "utf8"),
  interrupted = () => false,
  requireRuleLive = APPLY_REQUIRES_RULE_LIVE,
}: RunOptions): Promise<RunResult> => {
  const mode = options.undo ? "UNDO" : options.apply ? "APPLY" : "DRY-RUN";
  log(
    `repair:finalized-status mode=${mode}${options.undo && !options.apply ? " (dry run)" : ""} ` +
      `bucket=${storage.bucketName} table=${config.manifestTableName}` +
      (options.guids.length > 0 ? ` guids=${options.guids.join(",")}` : ""),
  );
  const deps = {
    db,
    storage,
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
    requireRuleLive,
  };
  if (options.undo) return runUndo(deps, options);
  if (options.apply) return runApply(deps, options);
  return runDryRun(deps, options);
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  // A write lands before its undo record, so a writing run is not killed by the first Ctrl-C (or SIGTERM): it starts
  // no new line and lets the one in flight write its record. The second exits at once; a rerun then records a line
  // that landed (alreadyApplied). The dry runs stop at once, as they write nothing.
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
  const { exitCode } = await runRepair({
    db: new DynamoDBClient({ region: config.region }),
    storage: new BillStorage(new S3Client({ region: config.region }), config.bucket),
    sqs: new SQSClient({ region: config.region }),
    config,
    options,
    interrupted: () => interrupted,
  });
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Finalized status repair failed", error);
    process.exitCode = 1;
  });
}
