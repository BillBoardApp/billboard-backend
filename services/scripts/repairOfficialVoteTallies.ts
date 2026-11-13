#!/usr/bin/env node

// One-off repair for REL-31. Before the fix, parseYeaNayFromText read Congressional Record page
// ranges and document numbers as vote tallies: "On passage Passed without objection. (text: CR
// H4758-4759)" became a House vote of 4758-4759. fetchRawBill stored that as the raw bill's
// content.officialVotes, and billDiffer / billSummarizer copied it to the processed bill.
//
// Dry run (the default, read-only): lists raw-bills/, re-parses each stored officialVotes chamber
// and reports the bills whose stored tally is exactly what the old parser read from the chamber's
// action text and the fixed parser rejects, with what the fixed parser gives instead and whether
// the processed bill still shows the old tally.
//
// --apply: for each such bill, rewrites the raw bill with only content.officialVotes corrected
// (conditional on the ETag it read, so a concurrent pipeline write is never overwritten) and sends
// {guid} to BillDifferQueue, the queue fetchRawBill and enrichOfficialVotes hand every raw bill to.
// billDiffer sees the title and bill text unchanged and only officialVotes changed, so it patches
// the processed bill without Bedrock; that write reaches createBillsManifest, notificationType
// (which sends nothing: summary, title and actions are unchanged) and congressMemberStats (which
// recomputes the bill's member vote rows). No Congress.gov or Bedrock calls are made.
//
// Why not re-enqueue a Lambda's own input queue: UpdatedBillsQueue (fetchRawBill) refetches the
// whole bill, and a changed title or text version would send it to billSummarizer (Bedrock);
// BillVoteEnrichmentQueue (enrichOfficialVotes) keeps a stored officialVotes as it is.
//
// Run --apply only after the parser fix is deployed (FetchRawBill and EnrichOfficialVotes); until
// then a refetch of one of these bills would store the old tally again.
//
// A bill an earlier --apply rewrote (its raw bill still carries this repair's correlation id) whose
// processed bill still shows the old tally was never handed to billDiffer (the run stopped between
// the write and the send). A later run lists it as stranded and --apply sends it again.

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import type { OfficialChamberVote, OfficialVotesBreakdown, RawBill } from "../src/models/bill";
import { mapWithConcurrency } from "../src/shared/concurrency";
import {
  computeCompleteness,
  extractOfficialVotesFromActions,
  parseYeaNayFromText,
  type VoteChamber,
} from "../src/shared/congressVotes";
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
const CHAMBERS: readonly VoteChamber[] = ["house", "senate"];

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
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hjres133");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--max-items") options.maxItems = readPositive(arg, argv[(index += 1)], 1_000_000);
    else if (arg === "--concurrency") options.concurrency = readPositive(arg, argv[(index += 1)], MAX_CONCURRENCY);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

const USAGE = [
  "Repair official vote tallies misread from Congressional Record page ranges (REL-31).",
  "",
  "Usage:",
  "  npm run repair:official-vote-tallies                         Dry run: list affected bills, no writes",
  "  npm run repair:official-vote-tallies -- --guid BILLS-119hjres133",
  "  npm run repair:official-vote-tallies -- --apply              Rewrite them and re-run billDiffer",
  "",
  "Options:",
  "  --apply            Rewrite the raw bills' officialVotes and send their guids to BillDifferQueue",
  "                     (the default is a dry run). Run it only after the parser fix is deployed.",
  "  --guid <guid>      Only this bill (repeatable; a text-version suffix is ignored)",
  "  --max-items <n>    Stop after reading n raw bills",
  `  --concurrency <n>  Reads and repairs in flight (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  "  --scan-processed   Also list processed bills that show a rejected tally while their raw bill",
  "                     does not and was not rewritten by this repair (only reported)",
  "",
  "A raw bill an earlier --apply rewrote whose processed bill still shows the old tally is listed as",
  "stranded; --apply sends it to BillDifferQueue again.",
  "",
  "It never calls Congress.gov or Bedrock, and billDiffer's patch sends no pushes (see the header).",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "RAW_BILLS_PREFIX, PROCESSED_BILLS_PREFIX, BILL_DIFFER_QUEUE_URL (or BILL_DIFFER_QUEUE_NAME)",
].join("\n");

// ── Classification (pure) ────────────────────────────────────────────────────

// The parser before REL-31, kept only to recognise the tallies it produced.
const LEGACY_YEA_NAY_PATTERNS: readonly RegExp[] = [
  /yeas?\s+and\s+nays?:\s*(?:\([^)]*\)\s*:?\s*)*([0-9]{1,4})\s*-\s*([0-9]{1,4})/i,
  /yea[-\s]?nay\s+vote\.?\s*([0-9]{1,4})\s*-\s*([0-9]{1,4})/i,
  /(?:passed|agreed|vote)[^0-9]{0,80}([0-9]{1,4})\s*-\s*([0-9]{1,4})/i,
];

export const legacyParseYeaNay = (text: string): { yea: number; nay: number } | null => {
  for (const pattern of LEGACY_YEA_NAY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { yea: Number.parseInt(match[1], 10), nay: Number.parseInt(match[2], 10) };
  }
  return null;
};

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;

const hasMemberData = (vote: UnknownRecord): boolean =>
  vote.memberDataAvailable === true || (Array.isArray(vote.members) && vote.members.length > 0);

/**
 * True when a stored chamber vote's yea/nay are exactly what the old parser read from its own
 * action text and the fixed parser does not read the same numbers. Senate votes counted from the
 * roll-call XML, and every tally the fixed parser still reads, are never flagged.
 */
export const isRejectedTally = (vote: unknown, chamber: VoteChamber): boolean => {
  const record = asRecord(vote);
  if (!record || typeof record.yea !== "number" || typeof record.nay !== "number") return false;
  const text = typeof record.resultText === "string" ? record.resultText : "";
  const legacy = legacyParseYeaNay(text);
  if (!legacy || legacy.yea !== record.yea || legacy.nay !== record.nay) return false;
  const fixed = parseYeaNayFromText(text, chamber);
  return !fixed || fixed.yea !== record.yea || fixed.nay !== record.nay;
};

export interface TallySummary {
  yea: number;
  nay: number;
  actionDate?: string;
  resultText?: string;
}

const summarize = (vote: UnknownRecord | OfficialChamberVote): TallySummary => ({
  yea: Number(vote.yea),
  nay: Number(vote.nay),
  ...(typeof vote.actionDate === "string" ? { actionDate: vote.actionDate } : {}),
  ...(typeof vote.resultText === "string" ? { resultText: vote.resultText } : {}),
});

export interface ChamberFinding {
  chamber: VoteChamber;
  before: TallySummary;
  /** What the fixed parser reads from the bill's actions instead; null removes the chamber. */
  after: TallySummary | null;
  /** The chamber also holds member votes: reported for a manual look, never rewritten. */
  manualReview: boolean;
}

export interface BillRepairPlan {
  guid: string;
  key: string;
  findings: ChamberFinding[];
  /** At least one finding is rewritten (not only manual-review ones). */
  repairable: boolean;
  /** The corrected content.officialVotes; undefined removes it (no chamber left). */
  nextOfficialVotes: OfficialVotesBreakdown | undefined;
}

/** The repair a raw bill needs, or null when its stored officialVotes hold no rejected tally. */
export const planRawBillRepair = (
  rawBill: unknown,
  key: string,
  guid: string,
  now: Date = new Date(),
): BillRepairPlan | null => {
  const content = asRecord(asRecord(rawBill)?.content);
  const stored = asRecord(content?.officialVotes);
  if (!content || !stored) return null;

  const fresh = extractOfficialVotesFromActions(content);
  const findings: ChamberFinding[] = [];
  const next: UnknownRecord = { ...stored };
  for (const chamber of CHAMBERS) {
    const vote = asRecord(stored[chamber]);
    if (!vote || !isRejectedTally(vote, chamber)) continue;
    if (hasMemberData(vote)) {
      findings.push({ chamber, before: summarize(vote), after: summarize(vote), manualReview: true });
      continue;
    }
    // A flagged chamber came from a text-only action (a roll-call action is picked the same way
    // before and after the fix, and its text would still be rejected), so the replacement is
    // text-only too and needs no member enrichment.
    const replacement = fresh?.[chamber];
    findings.push({
      chamber,
      before: summarize(vote),
      after: replacement ? summarize(replacement) : null,
      manualReview: false,
    });
    if (replacement) next[chamber] = replacement;
    else delete next[chamber];
  }
  if (findings.length === 0) return null;

  const repairable = findings.some((finding) => !finding.manualReview);
  let nextOfficialVotes: OfficialVotesBreakdown | undefined = stored as unknown as OfficialVotesBreakdown;
  if (repairable) {
    if (!next.house && !next.senate) {
      nextOfficialVotes = undefined;
    } else {
      const updated = { ...next, lastSyncedAt: now.toISOString() } as unknown as OfficialVotesBreakdown;
      updated.completeness = computeCompleteness(updated);
      nextOfficialVotes = updated;
    }
  }
  return { guid, key, findings, repairable, nextOfficialVotes };
};

/** True when any chamber of a processed bill's officialVotes shows a tally the fixed parser rejects. */
export const processedShowsAnyRejectedTally = (processed: unknown): boolean => {
  const votes = asRecord(asRecord(processed)?.officialVotes);
  return CHAMBERS.some((chamber) => isRejectedTally(votes?.[chamber], chamber));
};

/** Chambers of a processed bill's officialVotes that still show a finding's old tally. */
export const processedShowsRejectedTally = (processed: unknown, findings: readonly ChamberFinding[]): boolean => {
  const votes = asRecord(asRecord(processed)?.officialVotes);
  return findings.some((finding) => {
    const vote = asRecord(votes?.[finding.chamber]);
    return Boolean(vote && vote.yea === finding.before.yea && vote.nay === finding.before.nay);
  });
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

const isPreconditionFailure = (error: unknown): boolean => {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  const status = candidate?.$metadata?.httpStatusCode;
  return (
    candidate?.name === "PreconditionFailed" ||
    candidate?.name === "ConditionalRequestConflict" ||
    status === 412 ||
    status === 409
  );
};

interface StoredObject {
  value: unknown;
  etag?: string;
  metadata?: Record<string, string>;
}

const REPAIR_CORRELATION_PREFIX = "rel31-repair:";

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

export type ProcessedStatus = "shows-rejected-tally" | "clean" | "missing" | "unreadable";

export interface AffectedBill extends BillRepairPlan {
  processed: ProcessedStatus;
}

export interface ScanResult {
  scanned: number;
  missing: string[];
  unreadable: string[];
  withOfficialVotes: number;
  affected: AffectedBill[];
  /** Rewritable findings per chamber (manual-review ones excluded). */
  chambers: Record<VoteChamber, number>;
  manualReview: number;
  /**
   * Raw bills an earlier --apply rewrote whose processed bill still shows a rejected tally: the run
   * stopped before handing them to billDiffer. --apply sends them again.
   */
  stranded: string[];
  /** --scan-processed: other processed guids showing a rejected tally whose raw bill does not. */
  processedOnly: string[] | null;
}

export interface ScanOptions {
  guids?: readonly string[];
  maxItems?: number | null;
  concurrency?: number;
  scanProcessed?: boolean;
  log?: Log;
  now?: Date;
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
    now,
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
    withOfficialVotes: 0,
    affected: [],
    chambers: { house: 0, senate: 0 },
    manualReview: 0,
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
    if (asRecord(asRecord(asRecord(stored.value)?.content)?.officialVotes)) result.withOfficialVotes += 1;
    const plan = planRawBillRepair(stored.value, key, guid, now);
    if (!plan) {
      if (writtenByRepair(stored)) {
        try {
          const processedObject = await getJsonObject(s3, config.bucket, `${config.processedPrefix}${guid}.json`);
          if (processedShowsAnyRejectedTally(processedObject?.value)) result.stranded.push(guid);
        } catch (error) {
          log(`Unreadable processed bill for ${guid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }

    let processed: ProcessedStatus;
    try {
      const processedObject = await getJsonObject(s3, config.bucket, `${config.processedPrefix}${guid}.json`);
      processed = !processedObject
        ? "missing"
        : processedShowsRejectedTally(processedObject.value, plan.findings)
          ? "shows-rejected-tally"
          : "clean";
    } catch {
      processed = "unreadable";
    }
    result.affected.push({ ...plan, processed });
    for (const finding of plan.findings) {
      if (finding.manualReview) result.manualReview += 1;
      else result.chambers[finding.chamber] += 1;
    }
  });

  result.affected.sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
  result.missing.sort();
  result.unreadable.sort();
  result.stranded.sort();

  if (scanProcessed) {
    const affectedGuids = new Set([...result.affected.map((bill) => bill.guid), ...result.stranded]);
    const processedKeys = await listJsonKeys(s3, config.bucket, config.processedPrefix);
    log(`Reading ${processedKeys.length} processed bills under s3://${config.bucket}/${config.processedPrefix}`);
    const processedOnly: string[] = [];
    await mapWithConcurrency(processedKeys, concurrency, async (key) => {
      const guid = guidFromKey(key, config.processedPrefix);
      if (affectedGuids.has(guid)) return;
      try {
        const object = await getJsonObject(s3, config.bucket, key);
        if (processedShowsAnyRejectedTally(object?.value)) processedOnly.push(guid);
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

/**
 * Re-reads each bill, re-plans on that copy, writes it back only if its ETag is unchanged, then
 * sends its guid to BillDifferQueue. A bill that no longer needs the repair is left alone.
 */
export const applyRepairs = async (
  s3: Sender,
  sqs: QueueSender,
  config: RepairConfig,
  queueUrl: string,
  bills: readonly Pick<AffectedBill, "guid" | "key">[],
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
    resent: 0,
    enqueueFailed: [],
  };

  const repairOne = async (guid: string, key: string): Promise<RepairOutcome> => {
    const stored = await getJsonObject(s3, config.bucket, key);
    if (!stored) return "missing";
    const at = now();
    const plan = planRawBillRepair(stored.value, key, guid, at);
    if (!plan || !plan.repairable) return "alreadyClean";

    const rawBill = stored.value as RawBill;
    const content = rawBill.content as Record<string, unknown>;
    if (plan.nextOfficialVotes) content.officialVotes = plan.nextOfficialVotes;
    else delete content.officialVotes;

    const correlationId = repairCorrelationId(guid, at);
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
    log(
      `Rewrote ${key}`,
      plan.findings.map((finding) => ({
        chamber: finding.chamber,
        from: `${finding.before.yea}-${finding.before.nay}`,
        to: finding.after ? `${finding.after.yea}-${finding.after.nay}` : "none",
      })),
    );

    try {
      await sendToBillDiffer(sqs, queueUrl, guid, correlationId);
      summary.enqueued += 1;
    } catch (error) {
      summary.enqueueFailed.push(guid);
      logError("Rewrote the raw bill but could not send it to BillDifferQueue", { guid, error });
    }
    return "repaired";
  };

  await mapWithConcurrency(bills, concurrency, async ({ guid, key }) => {
    summary.attempted += 1;
    let outcome: RepairOutcome;
    try {
      outcome = await repairOne(guid, key);
    } catch (error) {
      outcome = "failed";
      logError("Failed to repair raw bill", { guid, key, error });
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

const formatTally = (tally: TallySummary | null): string =>
  tally ? `${tally.yea}-${tally.nay}${tally.actionDate ? ` (${tally.actionDate})` : ""}` : "none";

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
    `repair:official-vote-tallies mode=${options.apply ? "APPLY" : "DRY-RUN"} bucket=${config.bucket} ` +
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
    now: now(),
  });

  log(
    `raw bills: scanned=${scan.scanned} missing=${scan.missing.length} unreadable=${scan.unreadable.length} ` +
      `with-official-votes=${scan.withOfficialVotes}`,
  );
  if (scan.missing.length > 0) log(`missing: ${scan.missing.join(", ")}`);
  if (scan.unreadable.length > 0) log(`unreadable: ${scan.unreadable.join(", ")}`);
  const processedCounts = scan.affected.reduce<Record<string, number>>((counts, bill) => {
    counts[bill.processed] = (counts[bill.processed] ?? 0) + 1;
    return counts;
  }, {});
  log(
    `affected bills=${scan.affected.length} chambers: house=${scan.chambers.house} senate=${scan.chambers.senate} ` +
      `manual-review=${scan.manualReview} processed: ${JSON.stringify(processedCounts)}`,
  );
  for (const bill of scan.affected) {
    for (const finding of bill.findings) {
      log(
        `  ${bill.guid} ${finding.chamber} ${formatTally(finding.before)} -> ` +
          `${finding.manualReview ? "MANUAL REVIEW (has member votes)" : formatTally(finding.after)} ` +
          `processed=${bill.processed} text=${JSON.stringify(finding.before.resultText ?? "")}`,
      );
    }
  }
  if (scan.stranded.length > 0) {
    log(
      `stranded: rewritten by an earlier --apply, processed bill still shows the old tally: ${scan.stranded.length} ` +
        scan.stranded.join(", "),
    );
  }
  if (scan.processedOnly) {
    log(
      `processed bills showing a rejected tally whose raw bill does not (not repairable here): ${scan.processedOnly.length}` +
        (scan.processedOnly.length > 0 ? ` ${scan.processedOnly.join(", ")}` : ""),
    );
  }

  const repairable = scan.affected.filter((bill) => bill.repairable);
  if (!options.apply) {
    log(
      `Dry run: would rewrite ${repairable.length} raw bills` +
        (scan.stranded.length > 0 ? `, re-send ${scan.stranded.length} stranded ones,` : "") +
        ` and send their guids to ${config.billDifferQueueUrl || config.billDifferQueueName}. ` +
        "Re-run with --apply after the parser fix is deployed.",
    );
    return { scan };
  }

  const summary = await applyRepairs(s3, sqs, config, queueUrl, repairable, {
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
    console.error("Official vote tally repair failed", error);
    process.exitCode = 1;
  });
}
