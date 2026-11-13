#!/usr/bin/env node

// Repair of the House Present and Not voting figures. Before the fix, enrichOfficialVotes
// (mergeHouseMembersIntoOfficialVotes) attached a House roll call's member rows to the raw bill but kept
// the figures read from the action text, which states only Yea and Nay ("On passage Passed by the Yeas
// and Nays: 216 - 212 (Roll no. 278)."). Every enriched House chamber was stored with present 0,
// notVoting 0 and totalCounted yea + nay, whatever its rows held: a roll call showed "Present 0 · Not
// voting 0" next to a member list with more rows than Yea plus Nay. billDiffer copied that into the
// processed bill, which the app shows.
//
// Dry run (the default, read-only): lists raw-bills/ and, for each raw bill whose
// content.officialVotes.house holds member rows, counts Present, Not voting and the total from the rows
// with the rule enrichOfficialVotes now applies (houseCountsFromMembers: only when the rows' Yea and Nay
// equal the stored ones). It reports the bills whose stored figures differ from that count, the bills
// whose rows' Yea or Nay differ from the stored ones (never rewritten), and whether each processed bill
// still shows the stored figures. Counts and bill ids only: no member rows are printed.
//
// --apply: for each such bill, rewrites the raw bill with only officialVotes.house.present, notVoting
// and totalCounted changed (conditional on the ETag it read, so a concurrent pipeline write is never
// overwritten) and sends {guid} to BillDifferQueue, as repairOfficialVoteTallies.ts does. billDiffer
// sees the title and bill text unchanged and only officialVotes changed, so it patches the processed
// bill without Bedrock; that write reaches createBillsManifest (a tally is not news: the row keeps its
// date), notificationType (which sends nothing: summary, title and actions are unchanged) and
// congressMemberStats (no member vote row changes). No Congress.gov or Bedrock calls are made. A bill
// with no processed copy yet is rewritten but not sent: billDiffer would hand it to billSummarizer
// (Bedrock), and billSummarizer takes the repaired figures from the raw bill when it runs anyway.
//
// Run --apply only after the fix is deployed (EnrichOfficialVotes); until then an enrichment of one of
// these bills, which follows a refetch that dropped its members, stores 0 again.
//
// Idempotent: a bill whose stored figures already equal the count is left alone. A bill an earlier
// --apply rewrote (its raw bill still carries this repair's correlation id) whose processed bill still
// shows other House figures was never handed to billDiffer (the run stopped between the write and the
// send). A later run lists it as stranded and --apply sends it again.

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import { isPreconditionFailure } from "../src/adapters/billStorage";
import type { OfficialVoteMember, OfficialVotesBreakdown, RawBill } from "../src/models/bill";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { houseCountsFromMembers, usableOfficialVotes } from "../src/shared/congressVotes";
import { CORRELATION_ID_METADATA_KEY, correlationIdMessageAttributes } from "../src/shared/correlation";

export interface RepairConfig {
  region: string;
  bucket: string;
  rawPrefix: string;
  processedPrefix: string;
  /** Used as is when set; otherwise --apply resolves `billDifferQueueName`. */
  billDifferQueueUrl: string;
  billDifferQueueName: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): RepairConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  rawPrefix: env.RAW_BILLS_PREFIX || "raw-bills/",
  processedPrefix: env.PROCESSED_BILLS_PREFIX || "processed-bills/",
  billDifferQueueUrl: env.BILL_DIFFER_QUEUE_URL || "",
  billDifferQueueName: env.BILL_DIFFER_QUEUE_NAME || "BillDifferQueue",
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  guids: string[];
  maxItems: number | null;
  concurrency: number;
  scanProcessed: boolean;
}

export const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 25;

/** BILLS-119hr8800eh -> BILLS-119hr8800 (the raw and processed key form), or null for anything else. */
export const plainGuid = (value: string): string | null => {
  const match = value.trim().match(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i);
  return match ? match[1] : null;
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    guids: [],
    maxItems: null,
    concurrency: DEFAULT_CONCURRENCY,
    scanProcessed: false,
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
    else if (arg === "--scan-processed") options.scanProcessed = true;
    else if (arg === "--guid") {
      const raw = argv[(index += 1)];
      const guid = raw && !raw.startsWith("--") ? plainGuid(raw) : null;
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hr8800");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--max-items") options.maxItems = readPositive(arg, argv[(index += 1)], 1_000_000);
    else if (arg === "--concurrency") options.concurrency = readPositive(arg, argv[(index += 1)], MAX_CONCURRENCY);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

export const USAGE = [
  "Repair House Present and Not voting figures stored as 0 next to member rows that hold them.",
  "",
  "Usage:",
  "  npm run repair:house-vote-counts                          Dry run: list affected bills, no writes",
  "  npm run repair:house-vote-counts -- --guid BILLS-119hr8800",
  "  npm run repair:house-vote-counts -- --apply               Rewrite them and re-run billDiffer",
  "",
  "Options:",
  "  --apply            Rewrite the raw bills' officialVotes.house present, notVoting and totalCounted and",
  "                     send their guids to BillDifferQueue (the default is a dry run). Run it only after",
  "                     the EnrichOfficialVotes fix is deployed.",
  "  --guid <guid>      Only this bill (repeatable; a text-version suffix is ignored)",
  "  --max-items <n>    Stop after reading n raw bills",
  `  --concurrency <n>  Reads and repairs in flight (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  "  --scan-processed   Also list processed bills whose House figures differ from their member rows while",
  "                     their raw bill needs no repair and was not rewritten by this repair (only reported)",
  "",
  "A raw bill an earlier --apply rewrote whose processed bill still shows other House figures is listed as",
  "stranded; --apply sends it to BillDifferQueue again.",
  "",
  "It never calls Congress.gov or Bedrock, and billDiffer's patch sends no pushes (see the header).",
  "It prints counts and bill ids only.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "RAW_BILLS_PREFIX, PROCESSED_BILLS_PREFIX, BILL_DIFFER_QUEUE_URL (or BILL_DIFFER_QUEUE_NAME)",
].join("\n");

// ── Classification (pure) ────────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;

/** The figures this repair rewrites. Stored values are kept as found (a missing one is undefined). */
export interface HouseFigures {
  present: unknown;
  notVoting: unknown;
  totalCounted: unknown;
}

const FIGURES = ["present", "notVoting", "totalCounted"] as const;

const figuresOf = (vote: UnknownRecord): HouseFigures => ({
  present: vote.present,
  notVoting: vote.notVoting,
  totalCounted: vote.totalCounted,
});

const sameFigures = (a: HouseFigures, b: HouseFigures): boolean => FIGURES.every((field) => a[field] === b[field]);

/**
 * What a stored House chamber holds:
 * - "no-member-rows": no House chamber, no numeric Yea and Nay, or no member rows; nothing to count;
 * - "mismatch": the rows' Yea or Nay differ from the stored ones, so they are not counted (and never rewritten);
 * - "matches": the stored figures already equal the rows' count;
 * - "differs": they do not; `counted` is what the rows give.
 */
export type HouseCheckStatus = "no-member-rows" | "mismatch" | "matches" | "differs";

export interface HouseCheck {
  status: HouseCheckStatus;
  yea?: number;
  nay?: number;
  stored?: HouseFigures;
  counted?: { present: number; notVoting: number; totalCounted: number };
}

/** Checks the House chamber of an officialVotes value (a raw bill's content.officialVotes or a processed bill's). */
export const checkHouseChamber = (officialVotes: unknown): HouseCheck => {
  const house = asRecord(asRecord(officialVotes)?.house);
  if (!house || typeof house.yea !== "number" || typeof house.nay !== "number") return { status: "no-member-rows" };
  const members = Array.isArray(house.members) ? (house.members.filter(asRecord) as OfficialVoteMember[]) : [];
  if (members.length === 0) return { status: "no-member-rows" };
  const base = { yea: house.yea, nay: house.nay, stored: figuresOf(house) };
  const counted = houseCountsFromMembers({ yea: house.yea, nay: house.nay }, members);
  if (!counted) return { status: "mismatch", ...base };
  return { status: sameFigures(base.stored, counted) ? "matches" : "differs", ...base, counted };
};

export interface BillRepairPlan {
  guid: string;
  key: string;
  yea: number;
  nay: number;
  before: HouseFigures;
  after: { present: number; notVoting: number; totalCounted: number };
  /** content.officialVotes with only house.present, house.notVoting and house.totalCounted changed. */
  nextOfficialVotes: OfficialVotesBreakdown;
}

/** The raw bill's usable officialVotes (what billDiffer copies), as a record. */
const rawOfficialVotes = (rawBill: unknown): UnknownRecord | null =>
  asRecord(usableOfficialVotes(asRecord(asRecord(rawBill)?.content)?.officialVotes));

/** The repair a raw bill needs, or null when its House figures already match its rows or cannot be counted. */
export const planRawBillRepair = (rawBill: unknown, key: string, guid: string): BillRepairPlan | null => {
  const stored = rawOfficialVotes(rawBill);
  const check = checkHouseChamber(stored);
  if (!stored || check.status !== "differs") return null;
  const house = asRecord(stored.house)!;
  return {
    guid,
    key,
    yea: check.yea!,
    nay: check.nay!,
    before: check.stored!,
    after: check.counted!,
    nextOfficialVotes: { ...stored, house: { ...house, ...check.counted! } } as unknown as OfficialVotesBreakdown,
  };
};

/** True when a processed bill's House chamber shows figures other than `expected`. */
export const processedShowsOtherFigures = (processed: unknown, expected: HouseFigures): boolean => {
  const house = asRecord(asRecord(asRecord(processed)?.officialVotes)?.house);
  return Boolean(house && !sameFigures(figuresOf(house), expected));
};

// ── S3 / SQS ─────────────────────────────────────────────────────────────────

type Sender = Pick<S3Client, "send">;
type QueueSender = Pick<SQSClient, "send">;
type Log = (...args: unknown[]) => void;

const readBody = async (body: GetObjectCommandOutput["Body"] | undefined): Promise<string | null> => {
  if (!body) return null;
  const candidate = body as { transformToString?: () => Promise<string> };
  if (typeof candidate.transformToString === "function") return candidate.transformToString();
  if (typeof body === "string") return body;
  return null;
};

const isMissingKey = (error: unknown): boolean => {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return candidate?.name === "NoSuchKey" || candidate?.$metadata?.httpStatusCode === 404;
};

interface StoredObject {
  value: unknown;
  etag?: string;
  metadata?: Record<string, string>;
}

export const REPAIR_CORRELATION_PREFIX = "house-counts-repair:";

/** The object's latest version was written by this repair (its correlation id says so). */
const writtenByRepair = (stored: StoredObject): boolean =>
  stored.metadata?.[CORRELATION_ID_METADATA_KEY]?.startsWith(REPAIR_CORRELATION_PREFIX) === true;

/** The object parsed as JSON, or null when the key does not exist. Throws when it is unreadable. */
const getJsonObject = async (s3: Sender, bucket: string, key: string): Promise<StoredObject | null> => {
  let response: GetObjectCommandOutput;
  try {
    response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isMissingKey(error)) return null;
    throw error;
  }
  const text = await readBody(response.Body);
  if (!text) throw new Error(`Empty body for ${key}`);
  return { value: JSON.parse(text) as unknown, etag: response.ETag, metadata: response.Metadata };
};

const listJsonKeys = async (s3: Sender, bucket: string, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const object of response.Contents ?? []) {
      if (typeof object.Key === "string" && object.Key.endsWith(".json")) keys.push(object.Key);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return keys.sort();
};

const guidFromKey = (key: string, prefix: string): string => key.slice(prefix.length, -".json".length);

export type ProcessedStatus = "shows-old-figures" | "clean" | "missing" | "unreadable";

export interface AffectedBill extends BillRepairPlan {
  processed: ProcessedStatus;
}

export interface ScanResult {
  scanned: number;
  missing: string[];
  unreadable: string[];
  /** Raw bills whose House chamber holds member rows. */
  withHouseMembers: number;
  /** Of those, the ones whose stored figures already equal the rows' count. */
  alreadyMatching: number;
  affected: AffectedBill[];
  /** Affected bills whose Present, or Not voting, changes. */
  presentChanged: number;
  notVotingChanged: number;
  /** Raw bills whose rows' Yea or Nay differ from the stored ones: never rewritten. */
  mismatched: string[];
  /**
   * Raw bills an earlier --apply rewrote whose processed bill still shows other House figures: the run
   * stopped before handing them to billDiffer. --apply sends them again.
   */
  stranded: string[];
  /** --scan-processed: other processed guids whose House figures differ from their member rows. */
  processedOnly: string[] | null;
}

export interface ScanOptions {
  guids?: readonly string[];
  maxItems?: number | null;
  concurrency?: number;
  scanProcessed?: boolean;
  log?: Log;
}

/** Read-only: every raw bill (or the --guid ones), its repair plan and its processed bill's state. */
export const scanRawBills = async (
  s3: Sender,
  config: RepairConfig,
  {
    guids = [],
    maxItems = null,
    concurrency = DEFAULT_CONCURRENCY,
    scanProcessed = false,
    log = console.log,
  }: ScanOptions = {},
): Promise<ScanResult> => {
  const allKeys =
    guids.length > 0
      ? guids.map((guid) => `${config.rawPrefix}${guid}.json`)
      : await listJsonKeys(s3, config.bucket, config.rawPrefix);
  const keys = maxItems ? allKeys.slice(0, maxItems) : allKeys;
  log(`Reading ${keys.length} raw bills under s3://${config.bucket}/${config.rawPrefix}`);

  const result: ScanResult = {
    scanned: 0,
    missing: [],
    unreadable: [],
    withHouseMembers: 0,
    alreadyMatching: 0,
    affected: [],
    presentChanged: 0,
    notVotingChanged: 0,
    mismatched: [],
    stranded: [],
    processedOnly: null,
  };

  await mapWithConcurrency(keys, concurrency, async (key) => {
    const guid = guidFromKey(key, config.rawPrefix);
    let stored: StoredObject | null;
    try {
      stored = await getJsonObject(s3, config.bucket, key);
    } catch (error) {
      result.scanned += 1;
      result.unreadable.push(guid);
      log(`Unreadable raw bill ${key}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    result.scanned += 1;
    if (result.scanned % 1000 === 0) log(`Read ${result.scanned} / ${keys.length} raw bills...`);
    if (!stored) {
      result.missing.push(guid);
      return;
    }

    const check = checkHouseChamber(rawOfficialVotes(stored.value));
    if (check.status === "no-member-rows") return;
    result.withHouseMembers += 1;
    if (check.status === "mismatch") {
      result.mismatched.push(guid);
      return;
    }
    if (check.status === "matches") {
      result.alreadyMatching += 1;
      if (writtenByRepair(stored)) {
        try {
          const processedObject = await getJsonObject(s3, config.bucket, `${config.processedPrefix}${guid}.json`);
          if (processedShowsOtherFigures(processedObject?.value, check.stored!)) result.stranded.push(guid);
        } catch (error) {
          log(`Unreadable processed bill for ${guid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }

    const plan = planRawBillRepair(stored.value, key, guid)!;
    let processed: ProcessedStatus;
    try {
      const processedObject = await getJsonObject(s3, config.bucket, `${config.processedPrefix}${guid}.json`);
      processed = !processedObject
        ? "missing"
        : processedShowsOtherFigures(processedObject.value, plan.after)
          ? "shows-old-figures"
          : "clean";
    } catch {
      processed = "unreadable";
    }
    result.affected.push({ ...plan, processed });
    if (plan.before.present !== plan.after.present) result.presentChanged += 1;
    if (plan.before.notVoting !== plan.after.notVoting) result.notVotingChanged += 1;
  });

  result.affected.sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
  result.missing.sort();
  result.unreadable.sort();
  result.mismatched.sort();
  result.stranded.sort();

  if (scanProcessed) {
    const known = new Set([...result.affected.map((bill) => bill.guid), ...result.stranded]);
    const processedKeys = await listJsonKeys(s3, config.bucket, config.processedPrefix);
    log(`Reading ${processedKeys.length} processed bills under s3://${config.bucket}/${config.processedPrefix}`);
    const processedOnly: string[] = [];
    await mapWithConcurrency(processedKeys, concurrency, async (key) => {
      const guid = guidFromKey(key, config.processedPrefix);
      if (known.has(guid)) return;
      try {
        const object = await getJsonObject(s3, config.bucket, key);
        const votes = asRecord(object?.value)?.officialVotes;
        if (checkHouseChamber(votes).status === "differs") processedOnly.push(guid);
      } catch (error) {
        log(`Unreadable processed bill ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    result.processedOnly = processedOnly.sort();
  }
  return result;
};

export type RepairOutcome = "repaired" | "alreadyClean" | "changedConcurrently" | "missing" | "failed";

export interface ApplySummary {
  attempted: number;
  repaired: number;
  alreadyClean: number;
  changedConcurrently: number;
  missing: number;
  failed: number;
  enqueued: number;
  /** Rewritten and deliberately not sent: no processed bill yet (see the header). */
  notSentNoProcessed: number;
  /** Stranded bills (see ScanResult.stranded) sent to BillDifferQueue again. */
  resent: number;
  /** Rewritten but not handed to billDiffer; send {"guid": ...} to the queue by hand, or re-run --apply. */
  enqueueFailed: string[];
}

export const resolveBillDifferQueueUrl = async (sqs: QueueSender, config: RepairConfig): Promise<string> => {
  if (config.billDifferQueueUrl) return config.billDifferQueueUrl;
  const response = await sqs.send(new GetQueueUrlCommand({ QueueName: config.billDifferQueueName }));
  if (!response.QueueUrl) throw new Error(`Queue ${config.billDifferQueueName} not found`);
  return response.QueueUrl;
};

const repairCorrelationId = (guid: string, at: Date): string =>
  `${REPAIR_CORRELATION_PREFIX}${at.toISOString()}:${guid}`;

const sendToBillDiffer = async (sqs: QueueSender, queueUrl: string, guid: string, correlationId: string) => {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ guid }),
      ...correlationIdMessageAttributes(correlationId),
    }),
  );
};

const formatFigures = (before: HouseFigures, after: BillRepairPlan["after"]): string =>
  `present ${String(before.present)}->${after.present} not-voting ${String(before.notVoting)}->${after.notVoting} ` +
  `total ${String(before.totalCounted)}->${after.totalCounted}`;

/** A bill to repair; `send: false` rewrites it without sending it to BillDifferQueue (no processed bill yet). */
export interface RepairTarget {
  guid: string;
  key: string;
  send?: boolean;
}

/**
 * Re-reads each bill, re-plans on that copy, writes it back only if its ETag is unchanged, then sends
 * its guid to BillDifferQueue (unless `send` is false). A bill that no longer needs the repair is left alone.
 */
export const applyRepairs = async (
  s3: Sender,
  sqs: QueueSender,
  config: RepairConfig,
  queueUrl: string,
  bills: readonly RepairTarget[],
  {
    concurrency = DEFAULT_CONCURRENCY,
    log = console.log,
    logError = console.error,
    now = () => new Date(),
  }: { concurrency?: number; log?: Log; logError?: Log; now?: () => Date } = {},
): Promise<ApplySummary> => {
  const summary: ApplySummary = {
    attempted: 0,
    repaired: 0,
    alreadyClean: 0,
    changedConcurrently: 0,
    missing: 0,
    failed: 0,
    enqueued: 0,
    notSentNoProcessed: 0,
    resent: 0,
    enqueueFailed: [],
  };

  const repairOne = async ({ guid, key, send = true }: RepairTarget): Promise<RepairOutcome> => {
    const stored = await getJsonObject(s3, config.bucket, key);
    if (!stored) return "missing";
    const plan = planRawBillRepair(stored.value, key, guid);
    if (!plan) return "alreadyClean";

    const rawBill = stored.value as RawBill;
    (rawBill.content as Record<string, unknown>).officialVotes = plan.nextOfficialVotes;

    const correlationId = repairCorrelationId(guid, now());
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: JSON.stringify(rawBill),
          ContentType: "application/json",
          Metadata: { ...(stored.metadata ?? {}), [CORRELATION_ID_METADATA_KEY]: correlationId },
          ...(stored.etag ? { IfMatch: stored.etag } : {}),
        }),
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      // A PUT that S3 stored but whose answer was lost is retried with the same IfMatch and fails
      // here too; the object then carries this repair's correlation id and must still be sent on.
      const current = await getJsonObject(s3, config.bucket, key);
      if (current?.metadata?.[CORRELATION_ID_METADATA_KEY] !== correlationId) {
        log(`Skipped ${guid}: it changed after it was read; run again to re-check it`);
        return "changedConcurrently";
      }
      log(`${guid}: S3 refused a retry of the rewrite it had already stored; sending the bill on`);
    }
    log(`Rewrote ${key} house ${plan.yea}-${plan.nay} ${formatFigures(plan.before, plan.after)}`);

    if (!send) {
      summary.notSentNoProcessed += 1;
      return "repaired";
    }
    try {
      await sendToBillDiffer(sqs, queueUrl, guid, correlationId);
      summary.enqueued += 1;
    } catch (error) {
      summary.enqueueFailed.push(guid);
      logError("Rewrote the raw bill but could not send it to BillDifferQueue", { guid, error });
    }
    return "repaired";
  };

  await mapWithConcurrency(bills, concurrency, async (bill) => {
    summary.attempted += 1;
    let outcome: RepairOutcome;
    try {
      outcome = await repairOne(bill);
    } catch (error) {
      outcome = "failed";
      logError("Failed to repair raw bill", { guid: bill.guid, key: bill.key, error });
    }
    summary[outcome] += 1;
  });
  return summary;
};

/**
 * Sends stranded bills (rewritten by an earlier --apply, never handed to billDiffer) to
 * BillDifferQueue. Returns how many were sent and the guids that could not be.
 */
export const resendStranded = async (
  sqs: QueueSender,
  queueUrl: string,
  guids: readonly string[],
  { logError = console.error, now = () => new Date() }: { logError?: Log; now?: () => Date } = {},
): Promise<{ resent: number; failed: string[] }> => {
  const outcome = { resent: 0, failed: [] as string[] };
  for (const guid of guids) {
    try {
      await sendToBillDiffer(sqs, queueUrl, guid, repairCorrelationId(guid, now()));
      outcome.resent += 1;
    } catch (error) {
      outcome.failed.push(guid);
      logError("Could not send a stranded bill to BillDifferQueue", { guid, error });
    }
  }
  return outcome;
};

export interface RunOptions {
  s3: Sender;
  sqs: QueueSender;
  config: RepairConfig;
  options: CliOptions;
  log?: Log;
  logError?: Log;
  now?: () => Date;
}

/** Scans, prints the report, and repairs when `options.apply` is set. */
export const runRepair = async ({
  s3,
  sqs,
  config,
  options,
  log = console.log,
  logError = console.error,
  now = () => new Date(),
}: RunOptions): Promise<{ scan: ScanResult; summary?: ApplySummary }> => {
  log(
    `repair:house-vote-counts mode=${options.apply ? "APPLY" : "DRY-RUN"} bucket=${config.bucket} ` +
      `raw=${config.rawPrefix} processed=${config.processedPrefix}` +
      (options.guids.length > 0 ? ` guids=${options.guids.join(",")}` : ""),
  );

  // Resolve the queue before reading anything, so --apply fails before any write when it is missing.
  const queueUrl = options.apply ? await resolveBillDifferQueueUrl(sqs, config) : "";

  const scan = await scanRawBills(s3, config, {
    guids: options.guids,
    maxItems: options.maxItems,
    concurrency: options.concurrency,
    scanProcessed: options.scanProcessed,
    log,
  });

  log(
    `raw bills: scanned=${scan.scanned} missing=${scan.missing.length} unreadable=${scan.unreadable.length} ` +
      `with-house-member-rows=${scan.withHouseMembers} already-matching=${scan.alreadyMatching}`,
  );
  if (scan.missing.length > 0) log(`missing: ${scan.missing.join(", ")}`);
  if (scan.unreadable.length > 0) log(`unreadable: ${scan.unreadable.join(", ")}`);
  const processedCounts = scan.affected.reduce<Record<string, number>>((counts, bill) => {
    counts[bill.processed] = (counts[bill.processed] ?? 0) + 1;
    return counts;
  }, {});
  log(
    `affected bills=${scan.affected.length} present-changed=${scan.presentChanged} ` +
      `not-voting-changed=${scan.notVotingChanged} mismatched=${scan.mismatched.length} ` +
      `processed: ${JSON.stringify(processedCounts)}`,
  );
  for (const bill of scan.affected) {
    log(
      `  ${bill.guid} house ${bill.yea}-${bill.nay} ${formatFigures(bill.before, bill.after)} processed=${bill.processed}`,
    );
  }
  if (scan.mismatched.length > 0) {
    log(
      `mismatched: member rows whose Yea or Nay differ from the stored tally (left as they are): ` +
        `${scan.mismatched.length} ${scan.mismatched.join(", ")}`,
    );
  }
  if (scan.stranded.length > 0) {
    log(
      `stranded: rewritten by an earlier --apply, processed bill still shows other House figures: ${scan.stranded.length} ` +
        scan.stranded.join(", "),
    );
  }
  if (scan.processedOnly) {
    log(
      `processed bills whose House figures differ from their member rows while their raw bill does not (not repairable here): ` +
        `${scan.processedOnly.length}` +
        (scan.processedOnly.length > 0 ? ` ${scan.processedOnly.join(", ")}` : ""),
    );
  }

  const targets: RepairTarget[] = scan.affected.map(({ guid, key, processed }) => ({
    guid,
    key,
    send: processed !== "missing",
  }));
  const withoutProcessed = targets.filter((target) => !target.send).length;
  if (!options.apply) {
    log(
      `Dry run: would rewrite ${scan.affected.length} raw bills` +
        (withoutProcessed > 0 ? ` (${withoutProcessed} without a processed bill, not sent)` : "") +
        (scan.stranded.length > 0 ? `, re-send ${scan.stranded.length} stranded ones,` : "") +
        ` and send their guids to ${config.billDifferQueueUrl || config.billDifferQueueName}. ` +
        "Re-run with --apply after the EnrichOfficialVotes fix is deployed.",
    );
    return { scan };
  }

  const summary = await applyRepairs(s3, sqs, config, queueUrl, targets, {
    concurrency: options.concurrency,
    log,
    logError,
    now,
  });
  const stranded = await resendStranded(sqs, queueUrl, scan.stranded, { logError, now });
  summary.resent = stranded.resent;
  summary.enqueueFailed.push(...stranded.failed);
  log("Repair complete", summary);
  if (summary.enqueueFailed.length > 0) {
    log(
      `Send these to ${queueUrl} by hand (body {"guid":"<guid>"}), or re-run --apply; billDiffer patches ` +
        `them while the rewrite is the raw bill's latest version: ${summary.enqueueFailed.join(", ")}`,
    );
  }
  return { scan, summary };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const { summary } = await runRepair({
    s3: new S3Client({ region: config.region }),
    sqs: new SQSClient({ region: config.region }),
    config,
    options,
  });
  if (summary && (summary.failed > 0 || summary.enqueueFailed.length > 0)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("House vote count repair failed", error);
    process.exitCode = 1;
  });
}
