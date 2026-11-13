#!/usr/bin/env node

// Re-summary of the stored processed members (REL-52, docs/RUNBOOK.md 21.5). Since REL-52, CongressMemberSummarizer
// merges a senator's per-Congress entries into six-year terms; a processed member stored before that still lists one
// "term" per Congress, until the weekly FetchCongressMembersList run (every 7 days) refreshes every member. This
// script shows what a re-summary would change now, and with --apply has the deployed summarizer redo it at once.
//
// Dry run (the default; reads only): lists processed-congress-members/*.json, reads each stored member and its raw
// payload (raw-congress-members/<id>.json), and the Senate's list of senators once (senate.gov, as the summarizer
// does), and summarizes the raw payload with this checkout's code. A member is "terms" when its terms or termCount
// would change (every current senator: a term that stays one entry is still rewritten, its fields in a new order),
// "other" when only other fields would, "unchanged" otherwise; "no_raw" and "departed" (congress.gov says
// currentMember false; the pipeline retires it) are skipped. Counts only, plus the current senators' term counts
// before and after in total, and of those their Senate terms alone (the House entries of the senators who served
// there first, about half of them, are kept as they are, so the total falls to a little over half and the Senate
// figure to about 40%); --list adds one line per member that would change (public bioguide IDs). It also counts
// the current senators whose new terms apps 1.1 and 1.2 would read as a House member's (appChamberMismatch: the apps
// take the term with the latest startYear, then endYear, as current, so a House entry that began in the year the
// current Senate term began, and ended, would win); it should be 0. The plan line is
//   Reprocess plan: total= unchanged= terms= other= no_raw= departed= unreadable= senators= senatorTermsBefore=
//   senatorTermsAfter= senatorSenateTermsBefore= senatorSenateTermsAfter= inferredSenateClasses= appChamberMismatch=
// It stops (exit code 2) when the Senate's list cannot be read: without it the plan would infer every class.
//
// --apply: plans again, then sends {"bioguideId": ...} to CongressMemberSummarizerQueue for each "terms" and "other"
// member, paced by --rate. It writes nothing itself and calls no congress.gov API: the deployed CongressMemberSummarizer
// re-reads the stored raw payload and writes the processed member, and its S3 event updates the manifest row, as the
// weekly run does. Run it only once REL-52 is live on CongressMemberSummarizer:prod; a dry run afterwards should plan
// no "terms" member. Exits with status 1 when a send failed or a member could not be read.

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";

import { BillStorage } from "../src/adapters/billStorage";
import { summarizeCongressMemberPayload } from "../src/handlers/congressMemberSummarizer";
import { isDepartedCongressMember, unwrapCongressMember, type CongressMemberTerm } from "../src/models/congressMember";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { fetchSenateSeats } from "../src/shared/senateSeats";
import { isSenateTerm, latestTerm, resolveCurrentSenateSeat, type SenateSeat } from "../src/shared/senateTerms";

type Sender = Pick<S3Client, "send">;
type QueueSender = Pick<SQSClient, "send">;
type Log = (...args: unknown[]) => void;

export interface ReprocessConfig {
  region: string;
  bucket: string;
  processedPrefix: string;
  rawPrefix: string;
  /** Used as is when set; otherwise `queueName` is resolved with GetQueueUrl. */
  queueUrl: string;
  queueName: string;
}

/** The defaults are production's (infra/lib/config). */
export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): ReprocessConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.CONGRESS_MEMBER_STORE_BUCKET || env.BUCKET_NAME || "billboard-congress-member-store-bucket",
  processedPrefix: env.PROCESSED_CONGRESS_MEMBERS_PREFIX || "processed-congress-members/",
  rawPrefix: env.RAW_CONGRESS_MEMBERS_PREFIX || "raw-congress-members/",
  queueUrl: env.CONGRESS_MEMBER_SUMMARIZER_QUEUE_URL || "",
  queueName: env.CONGRESS_MEMBER_SUMMARIZER_QUEUE_NAME || "CongressMemberSummarizerQueue",
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  list: boolean;
  bioguideIds: string[];
  limit: number | null;
  concurrency: number;
  /** Messages a second in --apply. */
  rate: number;
}

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_RATE = 5;
const MAX_CONCURRENCY = 16;
const MAX_RATE = 20;
const SQS_BATCH_SIZE = 10;
const BIOGUIDE_ID_PATTERN = /^[A-Z]\d{6}$/;

export const USAGE = `Usage: npm run reprocess:congress-members -- [--dry-run | --apply] [--list] [--bioguide-id <id>]...
  [--limit <n>] [--concurrency <n>] [--rate <n>]

  --dry-run           Default. Reads only and prints the counts of what a re-summary would change.
  --apply             Plans again, then sends each member that would change to CongressMemberSummarizerQueue.
  --list              Also prints each member that would change, with its terms (and Senate terms) before and after.
  --bioguide-id <id>  Only this member (repeatable).
  --limit <n>         At most n members, in key order.
  --concurrency <n>   Parallel reads (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY}).
  --rate <n>          Messages a second with --apply (default ${DEFAULT_RATE}, at most ${MAX_RATE}).

Environment: AWS_REGION, CONGRESS_MEMBER_STORE_BUCKET, CONGRESS_MEMBER_SUMMARIZER_QUEUE_URL or _NAME.
docs/RUNBOOK.md 21.5.`;

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    list: false,
    bioguideIds: [],
    limit: null,
    concurrency: DEFAULT_CONCURRENCY,
    rate: DEFAULT_RATE,
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
    else if (arg === "--list") options.list = true;
    else if (arg === "--bioguide-id") {
      const id = (argv[(index += 1)] ?? "").trim().toUpperCase();
      if (!BIOGUIDE_ID_PATTERN.test(id)) throw new Error("--bioguide-id needs a bioguide ID such as K000367");
      if (!options.bioguideIds.includes(id)) options.bioguideIds.push(id);
    } else if (arg === "--limit") options.limit = readPositive(arg, argv[(index += 1)], 1_000_000);
    else if (arg === "--concurrency") options.concurrency = readPositive(arg, argv[(index += 1)], MAX_CONCURRENCY);
    else if (arg === "--rate") options.rate = readPositive(arg, argv[(index += 1)], MAX_RATE);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

export type MemberPlanKind = "unchanged" | "terms" | "other" | "no_raw" | "departed";

export interface MemberPlan {
  bioguideId: string;
  kind: MemberPlanKind;
  /** A current senator (their latest entry is Senate service). */
  senator: boolean;
  /** A current senator whose class the list did not give. */
  inferredSenateClass: boolean;
  termsBefore: number | null;
  termsAfter: number | null;
  /** Of those, the Senate entries (stored) and terms (after); null without terms. */
  senateTermsBefore: number | null;
  senateTermsAfter: number | null;
  /** A current senator whose new terms apps 1.1 and 1.2 would read as a House member's (appCurrentTerm). */
  appChamberMismatch: boolean;
}

type Term = { startYear?: unknown; endYear?: unknown };

const yearOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * The term apps 1.1 and 1.2 take as the member's current one, for its chamber, state and district
 * (Domain/Models/ProcessedCongressMember.swift:219-224 in both): the latest startYear, then the latest endYear (a
 * missing one counts as 0), the first of equal terms.
 */
export const appCurrentTerm = <T extends Term>(terms: readonly T[]): T | null =>
  terms.reduce<T | null>((best, term) => {
    if (!best) return term;
    const byStart = yearOf(best.startYear) - yearOf(term.startYear);
    const byEnd = yearOf(best.endYear) - yearOf(term.endYear);
    return byStart < 0 || (byStart === 0 && byEnd < 0) ? term : best;
  }, null);

const memberOf = (payload: unknown): Record<string, unknown> | null => {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const member = root.member ?? root;
  return member && typeof member === "object" ? (member as Record<string, unknown>) : null;
};

const termCountOf = (member: Record<string, unknown> | null): number | null => {
  if (!member) return null;
  if (Array.isArray(member.terms)) return member.terms.length;
  return typeof member.termCount === "number" ? member.termCount : null;
};

const senateTermCountOf = (member: Record<string, unknown> | null): number | null =>
  member && Array.isArray(member.terms)
    ? (member.terms as CongressMemberTerm[]).filter((term) => isSenateTerm(term)).length
    : null;

/** What a re-summary of `raw` would do to the stored member (pure). */
export const planMember = (
  bioguideId: string,
  stored: unknown,
  raw: unknown,
  seats: ReadonlyMap<string, SenateSeat> | null,
): MemberPlan => {
  const storedMember = memberOf(stored);
  const base = {
    bioguideId,
    senator: false,
    inferredSenateClass: false,
    termsBefore: termCountOf(storedMember),
    senateTermsBefore: senateTermCountOf(storedMember),
    appChamberMismatch: false,
  };
  if (!raw) return { ...base, kind: "no_raw", termsAfter: null, senateTermsAfter: null };
  if (isDepartedCongressMember(raw)) return { ...base, kind: "departed", termsAfter: null, senateTermsAfter: null };

  const terms = unwrapCongressMember(raw)?.terms;
  const senator = isSenateTerm(latestTerm(terms));
  const { seat, inferredReason } = resolveCurrentSenateSeat(bioguideId, terms, seats);
  const next = summarizeCongressMemberPayload(raw, { senateSeat: seat })?.member as Record<string, unknown> | undefined;
  const after = next ?? null;
  const same = (key: string) => JSON.stringify(storedMember?.[key]) === JSON.stringify(after?.[key]);
  const kind: MemberPlanKind =
    !same("terms") || !same("termCount")
      ? "terms"
      : JSON.stringify(storedMember) === JSON.stringify(after)
        ? "unchanged"
        : "other";
  const newTerms = Array.isArray(after?.terms) ? (after.terms as CongressMemberTerm[]) : [];
  return {
    ...base,
    kind,
    senator,
    inferredSenateClass: inferredReason !== null,
    termsAfter: termCountOf(after),
    senateTermsAfter: senateTermCountOf(after),
    appChamberMismatch: senator && !isSenateTerm(appCurrentTerm(newTerms)),
  };
};

export interface ScanResult {
  plans: MemberPlan[];
  unreadable: string[];
}

const listMemberIds = async (s3: Sender, config: ReprocessConfig): Promise<string[]> => {
  const ids: string[] = [];
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
      const name = (object.Key ?? "").slice(config.processedPrefix.length);
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (BIOGUIDE_ID_PATTERN.test(id)) ids.push(id);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return ids.sort();
};

/** Reads each stored member and its raw payload and plans it. */
export const scanMembers = async (
  s3: Sender,
  config: ReprocessConfig,
  options: CliOptions,
  seats: ReadonlyMap<string, SenateSeat>,
  logError: Log = console.error,
): Promise<ScanResult> => {
  const storage = new BillStorage(s3 as S3Client, config.bucket);
  const listed = options.bioguideIds.length > 0 ? [...options.bioguideIds].sort() : await listMemberIds(s3, config);
  const ids = options.limit ? listed.slice(0, options.limit) : listed;
  const unreadable: string[] = [];
  const results = await mapWithConcurrency(ids, options.concurrency, async (bioguideId) => {
    try {
      const stored = await storage.getJson<unknown>(`${config.processedPrefix}${bioguideId}.json`);
      if (!stored) return null;
      const raw = await storage.getJson<unknown>(`${config.rawPrefix}${bioguideId}.json`);
      return planMember(bioguideId, stored, raw, seats);
    } catch (error) {
      unreadable.push(bioguideId);
      logError("Could not read a member", { bioguideId, error });
      return null;
    }
  });
  return { plans: results.filter((plan): plan is MemberPlan => plan !== null), unreadable: unreadable.sort() };
};

export const planSummaryLine = ({ plans, unreadable }: ScanResult): string => {
  const count = (kind: MemberPlanKind) => plans.filter((plan) => plan.kind === kind).length;
  const senators = plans.filter((plan) => plan.senator && plan.kind !== "no_raw" && plan.kind !== "departed");
  const sum = (values: Array<number | null>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  return (
    `Reprocess plan: total=${plans.length + unreadable.length} unchanged=${count("unchanged")} terms=${count("terms")} ` +
    `other=${count("other")} no_raw=${count("no_raw")} departed=${count("departed")} unreadable=${unreadable.length} ` +
    `senators=${senators.length} senatorTermsBefore=${sum(senators.map((plan) => plan.termsBefore))} ` +
    `senatorTermsAfter=${sum(senators.map((plan) => plan.termsAfter))} ` +
    `senatorSenateTermsBefore=${sum(senators.map((plan) => plan.senateTermsBefore))} ` +
    `senatorSenateTermsAfter=${sum(senators.map((plan) => plan.senateTermsAfter))} ` +
    `inferredSenateClasses=${senators.filter((plan) => plan.inferredSenateClass).length} ` +
    `appChamberMismatch=${senators.filter((plan) => plan.appChamberMismatch).length}`
  );
};

export const resolveQueueUrl = async (sqs: QueueSender, config: ReprocessConfig): Promise<string> => {
  if (config.queueUrl) return config.queueUrl;
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: config.queueName }));
  if (!QueueUrl) throw new Error(`No queue named ${config.queueName}`);
  return QueueUrl;
};

export interface RunOptions {
  s3: Sender;
  sqs: QueueSender;
  config: ReprocessConfig;
  options: CliOptions;
  loadSeats?: () => Promise<ReadonlyMap<string, SenateSeat>>;
  log?: Log;
  logError?: Log;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunResult {
  /** null when the Senate's list could not be read (nothing was planned). */
  scan: ScanResult | null;
  sent: number;
  failed: string[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads the Senate's list, plans, prints the counts, and sends the members that would change with --apply. */
export const runReprocess = async ({
  s3,
  sqs,
  config,
  options,
  loadSeats = () => fetchSenateSeats(),
  log = console.log,
  logError = console.error,
  sleep = defaultSleep,
}: RunOptions): Promise<RunResult> => {
  // Before anything else, so a missing queue stops an --apply before any read.
  const queueUrl = options.apply ? await resolveQueueUrl(sqs, config) : null;
  log(
    `reprocess:congress-members mode=${options.apply ? "APPLY" : "DRY-RUN"} bucket=${config.bucket} ` +
      `processed=${config.processedPrefix} raw=${config.rawPrefix}${queueUrl ? ` queue=${queueUrl}` : ""}`,
  );

  let seats: ReadonlyMap<string, SenateSeat>;
  try {
    seats = await loadSeats();
  } catch (error) {
    logError("Could not read the Senate's list of senators; nothing planned", error);
    return { scan: null, sent: 0, failed: [] };
  }
  log(`The Senate's list names ${seats.size} senators.`);

  const scan = await scanMembers(s3, config, options, seats, logError);
  const changing = scan.plans.filter((plan) => plan.kind === "terms" || plan.kind === "other");
  if (options.list) {
    for (const plan of changing) {
      log(
        `${plan.kind} ${plan.bioguideId} terms ${plan.termsBefore ?? "-"} -> ${plan.termsAfter ?? "-"} ` +
          `(Senate ${plan.senateTermsBefore ?? "-"} -> ${plan.senateTermsAfter ?? "-"})`,
      );
    }
    for (const plan of scan.plans.filter((candidate) => candidate.appChamberMismatch)) {
      log(`appChamberMismatch ${plan.bioguideId}`);
    }
  }
  log(planSummaryLine(scan));

  if (!queueUrl) {
    log(`Dry run: would send ${changing.length} members to CongressMemberSummarizerQueue.`);
    return { scan, sent: 0, failed: [] };
  }

  log(`Sending ${changing.length} members to ${queueUrl}.`);
  const intervalMs = Math.ceil((1000 * SQS_BATCH_SIZE) / options.rate);
  let sent = 0;
  const failed: string[] = [];
  for (let index = 0; index < changing.length; index += SQS_BATCH_SIZE) {
    if (index > 0) await sleep(intervalMs);
    const batch = changing.slice(index, index + SQS_BATCH_SIZE);
    try {
      const response = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: batch.map((plan, batchIndex) => ({
            Id: `member-${index + batchIndex}`,
            MessageBody: JSON.stringify({ bioguideId: plan.bioguideId }),
          })),
        }),
      );
      sent += response.Successful?.length ?? 0;
      for (const failure of response.Failed ?? []) {
        const plan = batch[Number((failure.Id ?? "").replace("member-", "")) - index];
        failed.push(plan?.bioguideId ?? String(failure.Id));
        logError("Could not send a member to CongressMemberSummarizerQueue", { id: failure.Id, code: failure.Code });
      }
    } catch (error) {
      failed.push(...batch.map((plan) => plan.bioguideId));
      logError("Could not send members to CongressMemberSummarizerQueue", { error });
    }
  }
  if (failed.length > 0) log(`Not sent (re-run --apply, or send {"bioguideId":"<id>"} by hand): ${failed.join(", ")}`);
  log(`Reprocess complete sent=${sent} failed=${failed.length} unreadable=${scan.unreadable.length}`);
  return { scan, sent, failed };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runReprocess({
    s3: new S3Client({ region: config.region }),
    sqs: new SQSClient({ region: config.region }),
    config,
    options,
  });
  if (!result.scan) process.exitCode = 2;
  else if (result.failed.length > 0 || result.scan.unreadable.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Processed member re-summary failed", error);
    process.exitCode = 1;
  });
}
