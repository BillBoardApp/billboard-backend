#!/usr/bin/env node

// Reconcile of processed bills with raw bills (REL-30, REL-33). It plans each bill with the same pure
// rule billDiffer runs (shared/billSourceReconcile.ts, planReconcile): the processed bill read first,
// then the latest raw bill, compared on the recorded source text hash (or the legacy anchor for a
// processed bill written before REL-30), and the fields billDiffer maintains compared on what clients
// can see.
//
// Dry run (the default, read-only): prints the counts by plan and by changed field, the guids
// planned for a summary (no processed bill, or changed text), and the patches that add a passed or
// failed action or change billStatus. The last line is
//   Reconcile plan: total= unchanged= patch= summarize_missing= summarize_text_changed= awaiting_text= stale_raw= skipped= unreadable=
//
// --apply: plans again, then sends {"guid": ...} to BillDifferQueue (correlation id
// reconcile:<run start>:<guid>) for the patch and summarize plans only (or the kinds --plans names),
// paced by --rate. It never writes to S3: billDiffer re-plans each bill when its message arrives and
// does the write or the summary send itself, so a bill that changed in between is handled from its
// newer state. Run it only once the deployed BillDiffer, BillSummarizer and EnrichOfficialVotes are the
// ones that carry this rule, inside a quiet window of the notification path (RUNBOOK 4.1). Ends with
// "Reconcile complete sent= failed= unreadable=" and exits
// with status 1 when a send failed or a bill could not be read. --guid and --guids-file never fall
// back to every raw bill: a list file without a guid stops the run.

import { readFileSync } from "node:fs";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { BillStorage } from "../src/adapters/billStorage";
import { ProcessedBillDao } from "../src/adapters/processedBillDao";
import type { RawBill } from "../src/models/bill";
import { latestNewBillOutcomeAction } from "../src/shared/billOutcomes";
import {
  VISIBLE_FIELDS,
  isActionablePlan,
  legacyAnchorHash,
  needsLegacyAnchor,
  planReconcile,
  type ReconcilePlan,
  type ReconcilePlanKind,
} from "../src/shared/billSourceReconcile";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { correlationIdMessageAttributes } from "../src/shared/correlation";

export interface ReconcileConfig {
  region: string;
  bucket: string;
  rawPrefix: string;
  /** Used as is when set; otherwise `billDifferQueueName` is resolved with GetQueueUrl. */
  billDifferQueueUrl: string;
  billDifferQueueName: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): ReconcileConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  rawPrefix: env.RAW_BILLS_PREFIX || "raw-bills/",
  billDifferQueueUrl: env.BILL_DIFFER_QUEUE_URL || "",
  billDifferQueueName: env.BILL_DIFFER_QUEUE_NAME || "BillDifferQueue",
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  guids: string[];
  guidsFile: string | null;
  limit: number | null;
  concurrency: number;
  /** Sends per second in --apply. */
  rate: number;
  /** --plans: the actionable plan kinds --apply sends (null: all of them). */
  plans: ReconcilePlanKind[] | null;
}

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_RATE = 10;
const MAX_CONCURRENCY = 25;
const MAX_RATE = 100;

/** BILLS-119hr835ih -> BILLS-119hr835 (the raw and processed key form), or null for anything else. */
export const plainGuid = (value: string): string | null => {
  const match = value.trim().match(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i);
  return match ? match[1] : null;
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    guids: [],
    guidsFile: null,
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    rate: DEFAULT_RATE,
    plans: null,
  };
  const readValue = (flag: string, raw: string | undefined): string => {
    if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs a value`);
    return raw;
  };
  const readPositive = (flag: string, raw: string | undefined, max: number): number => {
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`${flag} needs a whole number from 1 to ${max}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--guid") {
      const guid = plainGuid(readValue(arg, argv[(index += 1)]));
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hr1400");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--guids-file") options.guidsFile = readValue(arg, argv[(index += 1)]);
    else if (arg === "--limit") options.limit = readPositive(arg, argv[(index += 1)], 1_000_000);
    else if (arg === "--concurrency") options.concurrency = readPositive(arg, argv[(index += 1)], MAX_CONCURRENCY);
    else if (arg === "--rate") options.rate = readPositive(arg, argv[(index += 1)], MAX_RATE);
    else if (arg === "--plans") {
      const kinds = readValue(arg, argv[(index += 1)])
        .split(",")
        .map((kind) => kind.trim());
      if (kinds.some((kind) => !isActionablePlan(kind as ReconcilePlanKind))) {
        throw new Error("--plans takes patch, summarize_missing and summarize_text_changed, comma-separated");
      }
      options.plans = [...new Set(kinds)] as ReconcilePlanKind[];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

/**
 * The guids in a list file: lines starting with "#" and blank lines are skipped, and each line's
 * first tab-separated column is the guid (so a file of "guid<TAB>raw LastModified" lines works too). A line
 * whose first column is not a bill guid is an error.
 */
export const parseGuidsFile = (text: string): string[] => {
  const guids: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const guid = plainGuid(trimmed.split("\t")[0]);
    if (!guid) throw new Error(`Line ${index + 1} of the guids file is not a bill guid: ${trimmed}`);
    if (!guids.includes(guid)) guids.push(guid);
  });
  return guids;
};

const USAGE = [
  "Reconcile processed bills with raw bills (REL-30, REL-33): plan each bill with billDiffer's rule,",
  "and with --apply send the bills that need a patch or a summary to BillDifferQueue.",
  "",
  "Usage:",
  "  npm run reconcile:processed-bills                                    Dry run over every raw bill",
  "  npm run reconcile:processed-bills -- --guids-file ./guids.txt",
  "  npm run reconcile:processed-bills -- --guid BILLS-119hr1400 --apply",
  "",
  "Options:",
  "  --apply            Send {guid} to BillDifferQueue for the patch and summarize plans (default: dry run).",
  "                     Never writes to S3. Run it inside a RUNBOOK 4.1 quiet window.",
  "  --plans <kinds>    With --apply, send only these plans: patch, summarize_missing, summarize_text_changed",
  "                     (comma-separated), e.g. --plans patch",
  "  --guid <guid>      Only this bill (repeatable; a text-version suffix is ignored)",
  "  --guids-file <f>   Bills listed in a file: first tab-separated column, # lines skipped; a file that",
  "                     lists no bill stops the run",
  "  --limit <n>        Plan at most n bills",
  `  --concurrency <n>  Bills read at once (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  `  --rate <n>         Sends per second with --apply (default ${DEFAULT_RATE}, at most ${MAX_RATE})`,
  "",
  "With neither --guid nor --guids-file it reads every raw-bills/*.json.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "RAW_BILLS_PREFIX, BILL_DIFFER_QUEUE_URL (or BILL_DIFFER_QUEUE_NAME, default BillDifferQueue)",
].join("\n");

type Sender = Pick<S3Client, "send">;
type QueueSender = Pick<SQSClient, "send">;
type Log = (...args: unknown[]) => void;

export const resolveBillDifferQueueUrl = async (sqs: QueueSender, config: ReconcileConfig): Promise<string> => {
  if (config.billDifferQueueUrl) return config.billDifferQueueUrl;
  const response = await sqs.send(new GetQueueUrlCommand({ QueueName: config.billDifferQueueName }));
  if (!response.QueueUrl) throw new Error(`Queue ${config.billDifferQueueName} not found`);
  return response.QueueUrl;
};

const listRawKeys = async (s3: Sender, bucket: string, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const object of response.Contents ?? []) {
      const key = object.Key ?? "";
      if (key.endsWith(".json") && !key.slice(prefix.length).includes("/")) keys.push(key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys.sort();
};

/** One planned bill. `outcome` / `status` are set for a patch that adds a passed or failed action or changes billStatus. */
export interface PlannedBill {
  key: string;
  guid: string;
  plan: ReconcilePlan;
  outcome?: { kind: "passed" | "failed"; text?: string; actionDate?: string };
  status?: { from: string; to: string };
}

export interface ScanResult {
  planned: PlannedBill[];
  unreadable: Array<{ key: string; error: string }>;
}

const planOne = async (
  storage: BillStorage,
  processedDao: ProcessedBillDao,
  key: string,
  guid: string,
): Promise<PlannedBill> => {
  const processed = await processedDao.getRevisionByGuid(guid);
  const raw = await storage.getJsonObject<RawBill>(key);
  const anchorHash = needsLegacyAnchor(processed, raw)
    ? await legacyAnchorHash(storage, key, raw, processed?.lastModified)
    : undefined;
  const plan = planReconcile({ processed, raw, messageGuid: guid, anchorHash });
  const planned: PlannedBill = { key, guid: plan.guid, plan };
  // A patch, or the pre-summary patch of a text change.
  if (processed && plan.next) {
    const outcome = latestNewBillOutcomeAction(processed.bill.actions, plan.next.actions);
    if (outcome) planned.outcome = { kind: outcome.kind, text: outcome.text, actionDate: outcome.actionDate };
    const from = String(processed.bill.billStatus ?? "");
    const to = String(plan.next.billStatus ?? "");
    if (from !== to) planned.status = { from, to };
  }
  return planned;
};

/** Read-only: plans every bill (the --guid ones, the file's, or every raw bill). */
export const scanBills = async (
  s3: Sender,
  config: ReconcileConfig,
  options: Pick<CliOptions, "guids" | "guidsFile" | "limit" | "concurrency">,
  {
    log = console.log,
    readFile = (path: string) => readFileSync(path, "utf8"),
  }: { log?: Log; readFile?: (path: string) => string } = {},
): Promise<ScanResult> => {
  const listed = [...options.guids, ...(options.guidsFile ? parseGuidsFile(readFile(options.guidsFile)) : [])];
  // A list never widens to every raw bill: an empty list file (only comments or blank lines) stops the run.
  if (options.guidsFile && listed.length === 0) {
    throw new Error(`The guids file ${options.guidsFile} lists no bills; nothing was planned or sent`);
  }
  const allKeys =
    options.guids.length > 0 || options.guidsFile
      ? [...new Set(listed)].map((guid) => `${config.rawPrefix}${guid}.json`)
      : await listRawKeys(s3, config.bucket, config.rawPrefix);
  const keys = options.limit ? allKeys.slice(0, options.limit) : allKeys;
  log(`Planning ${keys.length} bills under s3://${config.bucket}/${config.rawPrefix}`);

  const client = s3 as S3Client;
  const storage = new BillStorage(client, config.bucket);
  const processedDao = new ProcessedBillDao(client, config.bucket);
  const result: ScanResult = { planned: [], unreadable: [] };
  let done = 0;
  await mapWithConcurrency(keys, options.concurrency, async (key) => {
    const guid = key.slice(config.rawPrefix.length, -".json".length);
    try {
      result.planned.push(await planOne(storage, processedDao, key, guid));
    } catch (error) {
      result.unreadable.push({ key, error: error instanceof Error ? error.message : String(error) });
    }
    done += 1;
    if (done % 500 === 0) log(`Planned ${done} / ${keys.length} bills...`);
  });
  result.planned.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  result.unreadable.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return result;
};

const PLAN_KINDS: readonly ReconcilePlanKind[] = [
  "unchanged",
  "patch",
  "summarize_missing",
  "summarize_text_changed",
  "awaiting_text",
  "stale_raw",
  "skipped",
];

export const countPlans = (planned: readonly PlannedBill[]): Record<ReconcilePlanKind, number> => {
  const counts = Object.fromEntries(PLAN_KINDS.map((kind) => [kind, 0])) as Record<ReconcilePlanKind, number>;
  for (const bill of planned) counts[bill.plan.kind] += 1;
  return counts;
};

/** The report's last line; unreadable bills were not planned and are never sent. */
export const planSummaryLine = (scan: ScanResult): string => {
  const counts = countPlans(scan.planned);
  return (
    `Reconcile plan: total=${scan.planned.length} ${PLAN_KINDS.map((kind) => `${kind}=${counts[kind]}`).join(" ")} ` +
    `unreadable=${scan.unreadable.length}`
  );
};

const printReport = (scan: ScanResult, log: Log): void => {
  const counts = countPlans(scan.planned);
  log(`plans: ${PLAN_KINDS.map((kind) => `${kind}=${counts[kind]}`).join(" ")}`);
  const fieldCounts = Object.fromEntries(VISIBLE_FIELDS.map((field) => [field, 0])) as Record<string, number>;
  const decided: Record<string, number> = {};
  for (const bill of scan.planned) {
    for (const field of bill.plan.changedFields) fieldCounts[field] += 1;
    if (bill.plan.decidedBy) decided[bill.plan.decidedBy] = (decided[bill.plan.decidedBy] ?? 0) + 1;
  }
  log(`patched fields: ${VISIBLE_FIELDS.map((field) => `${field}=${fieldCounts[field]}`).join(" ")}`);
  log(
    `text decided by: ${["source-hash", "legacy-anchor", "assumed"].map((by) => `${by}=${decided[by] ?? 0}`).join(" ")}`,
  );
  for (const kind of ["summarize_missing", "summarize_text_changed"] as const) {
    const guids = scan.planned.filter((bill) => bill.plan.kind === kind).map((bill) => bill.guid);
    log(`${kind} (${guids.length})${guids.length > 0 ? `: ${guids.join(", ")}` : ""}`);
  }
  const notable = scan.planned.filter((bill) => bill.outcome || bill.status);
  log(`patches that add a passed or failed action or change billStatus (${notable.length})`);
  for (const bill of notable) {
    const parts = [
      bill.outcome
        ? `${bill.outcome.kind}${bill.outcome.actionDate ? ` ${bill.outcome.actionDate}` : ""} ${JSON.stringify(bill.outcome.text ?? "")}`
        : "",
      bill.status ? `billStatus ${bill.status.from || "(none)"} -> ${bill.status.to || "(none)"}` : "",
    ].filter(Boolean);
    log(`  ${bill.guid} ${parts.join("; ")}`);
  }
  if (scan.unreadable.length > 0) {
    log(
      `unreadable (${scan.unreadable.length}): ${scan.unreadable.map((entry) => `${entry.key} (${entry.error})`).join(", ")}`,
    );
  }
};

export interface RunOptions {
  s3: Sender;
  sqs: QueueSender;
  config: ReconcileConfig;
  options: CliOptions;
  log?: Log;
  logError?: Log;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => string;
}

export interface RunResult {
  scan: ScanResult;
  queueUrl: string;
  sent: number;
  failed: string[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves the queue, plans, prints the report, and sends the actionable plans with --apply. */
export const runReconcile = async ({
  s3,
  sqs,
  config,
  options,
  log = console.log,
  logError = console.error,
  now = () => new Date(),
  sleep = defaultSleep,
  readFile,
}: RunOptions): Promise<RunResult> => {
  // Before anything else, so a missing queue stops the run before any read or send.
  const queueUrl = await resolveBillDifferQueueUrl(sqs, config);
  const startedAt = now().toISOString();
  log(
    `reconcile:processed-bills mode=${options.apply ? "APPLY" : "DRY-RUN"} bucket=${config.bucket} ` +
      `raw=${config.rawPrefix} queue=${queueUrl}`,
  );

  const scan = await scanBills(s3, config, options, { log, ...(readFile ? { readFile } : {}) });
  printReport(scan, log);
  const actionable = scan.planned.filter(
    (bill) => isActionablePlan(bill.plan.kind) && (!options.plans || options.plans.includes(bill.plan.kind)),
  );
  const sending = options.plans ? `${options.plans.join(", ")} plans only` : "patch and summarize plans";

  if (!options.apply) {
    log(`Dry run: would send ${actionable.length} guids (${sending}) to ${queueUrl}.`);
    log(planSummaryLine(scan));
    return { scan, queueUrl, sent: 0, failed: [] };
  }

  log(`Sending ${actionable.length} guids (${sending}) to ${queueUrl}.`);
  log(planSummaryLine(scan));
  const intervalMs = Math.ceil(1000 / options.rate);
  let sent = 0;
  const failed: string[] = [];
  for (const [index, bill] of actionable.entries()) {
    if (index > 0) await sleep(intervalMs);
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ guid: bill.guid }),
          ...correlationIdMessageAttributes(`reconcile:${startedAt}:${bill.guid}`),
        }),
      );
      sent += 1;
    } catch (error) {
      failed.push(bill.guid);
      logError("Could not send a bill to BillDifferQueue", { guid: bill.guid, error });
    }
  }
  if (failed.length > 0) log(`Not sent (re-run --apply, or send {"guid":"<guid>"} by hand): ${failed.join(", ")}`);
  log(`Reconcile complete sent=${sent} failed=${failed.length} unreadable=${scan.unreadable.length}`);
  return { scan, queueUrl, sent, failed };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runReconcile({
    s3: new S3Client({ region: config.region }),
    sqs: new SQSClient({ region: config.region }),
    config,
    options,
  });
  if (result.failed.length > 0 || result.scan.unreadable.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Processed bill reconcile failed", error);
    process.exitCode = 1;
  });
}
