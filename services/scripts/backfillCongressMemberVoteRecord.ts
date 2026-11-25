#!/usr/bin/env node

// UX-39d backfill: fill CongressMemberVoteRecord (each member's latest roll-call position on each bill, the record GET
// /congress-member-record serves) for the processed bills already stored. New and changed bills fill it as they go
// through congressMemberStats; this sends the others there once.
//
// Counts first, changes nothing without --apply:
//   Dry run (the default, read-only): lists processed-bills/ (--congress <n> narrows it to one Congress), reads each,
//   and counts the bills whose official votes name at least one member with a position (Yea, Nay, Present or Not
//   Voting), and those member rows. Last line:
//     Vote record plan: scanned= withVotes= memberRows= unreadable=
//   --apply --canary <n>: sends the first n of those bills only, to check the rows on a few members' pages.
//   --apply --expect-bills <withVotes>: sends every one, after the dry run's count is confirmed (any other count stops
//   it, exit 2, nothing sent).
// Each send is the processed bill's S3 event without a versionId on CongressMemberStatsQueue, which congressMemberStats
// applies in full: the record rows, and the counters and profile rows as they already are (each bill counts once per
// member; the profile rows are written again unchanged). It writes nothing itself and never calls Bedrock.
//
// Stop rules, checked before every batch of 10: CongressMemberStatsDLQ holding more messages than at the start stops
// the run (exit 1); CongressMemberStatsQueue holding more than --max-queue messages pauses it, 30 s at a time, and after
// 10 minutes stops it (exit 2); a message SQS refuses stops it (exit 1). Each stop prints the last bill sent: resume
// with --start-after <that guid>. Ends with
//   Vote record backfill: sent= remaining= stopped=<no|reason> lastSent=<guid>

import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Readable } from "node:stream";

import { congressOfBillGuid } from "../src/shared/memberCounters";
import { voteRecordDayOf, voteRecordPositionOf } from "../src/shared/memberVoteRecord";
import { buildS3WrappedObjectMessage } from "../src/shared/replayCongressVoteProfiles";

export interface VoteRecordBackfillConfig {
  region: string;
  bucket: string;
  processedPrefix: string;
  queueUrl: string;
  queueName: string;
  dlqUrl: string;
  dlqName: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): VoteRecordBackfillConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  processedPrefix: env.PROCESSED_BILLS_PREFIX || "processed-bills/",
  queueUrl: env.CONGRESS_MEMBER_STATS_QUEUE_URL || "",
  queueName: env.CONGRESS_MEMBER_STATS_QUEUE_NAME || "CongressMemberStatsQueue",
  dlqUrl: env.CONGRESS_MEMBER_STATS_DLQ_URL || "",
  dlqName: env.CONGRESS_MEMBER_STATS_DLQ_NAME || "CongressMemberStatsDLQ",
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  congress: number | null;
  canary: number | null;
  expectBills: number | null;
  startAfter: string | null;
  /** Messages per second. */
  rate: number;
  maxQueue: number;
  concurrency: number;
}

export const DEFAULT_RATE = 2;
export const DEFAULT_MAX_QUEUE = 100;
const MAX_RATE = 20;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 25;
const BATCH_SIZE = 10;
export const QUEUE_WAIT_MS = 30_000;
export const QUEUE_WAIT_LIMIT_MS = 10 * 60_000;

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    congress: null,
    canary: null,
    expectBills: null,
    startAfter: null,
    rate: DEFAULT_RATE,
    maxQueue: DEFAULT_MAX_QUEUE,
    concurrency: DEFAULT_CONCURRENCY,
  };
  const readWhole = (flag: string, raw: string | undefined, min: number, max: number): number => {
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${flag} needs a whole number from ${min} to ${max}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--congress") options.congress = readWhole(arg, argv[(index += 1)], 1, 999);
    else if (arg === "--canary") options.canary = readWhole(arg, argv[(index += 1)], 1, 1000);
    else if (arg === "--expect-bills") options.expectBills = readWhole(arg, argv[(index += 1)], 0, 1_000_000);
    else if (arg === "--rate") options.rate = readWhole(arg, argv[(index += 1)], 1, MAX_RATE);
    else if (arg === "--max-queue") options.maxQueue = readWhole(arg, argv[(index += 1)], 1, 10_000);
    else if (arg === "--concurrency") options.concurrency = readWhole(arg, argv[(index += 1)], 1, MAX_CONCURRENCY);
    else if (arg === "--start-after") {
      const guid = argv[(index += 1)] ?? "";
      if (!/^BILLS-\d+[a-z]+\d+$/.test(guid)) throw new Error("--start-after needs a plain bill guid");
      options.startAfter = guid;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.apply && options.canary === null && options.expectBills === null) {
    throw new Error("--apply needs --canary <n> or --expect-bills <the dry run's withVotes>");
  }
  if (options.canary !== null && options.expectBills !== null) {
    throw new Error("--canary and --expect-bills are separate runs: a canary first, then the full send");
  }
  return options;
};

const USAGE = [
  "Fill the members' roll-call record (CongressMemberVoteRecord, UX-39d) for the processed bills already stored.",
  "Counts first; changes nothing without --apply.",
  "",
  "Usage:",
  "  npm run backfill:member-vote-record                                   Dry run: counts only",
  "  npm run backfill:member-vote-record -- --apply --canary 5             Send 5 bills",
  "  npm run backfill:member-vote-record -- --apply --expect-bills <n>     Send every bill",
  "",
  "Options:",
  "  --congress <n>       Only the bills of that Congress (processed-bills/BILLS-<n><type><number>)",
  "  --apply              Send the bills' S3 events to CongressMemberStatsQueue (needs --canary or --expect-bills)",
  "  --canary <n>         With --apply: the first n bills only",
  "  --expect-bills <n>   With --apply: the dry run's withVotes; any other count stops before a send (exit 2)",
  "  --start-after <guid> Resume after the last bill a stopped run sent",
  `  --rate <n>           Messages per second (default ${DEFAULT_RATE}, at most ${MAX_RATE})`,
  `  --max-queue <n>      Pause while the queue holds more (default ${DEFAULT_MAX_QUEUE}); stop after 10 minutes`,
  `  --concurrency <n>    Processed bills read at once (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  "",
  "Environment: AWS_PROFILE, AWS_REGION, BILL_STORE_BUCKET (or BUCKET_NAME), PROCESSED_BILLS_PREFIX,",
  "CONGRESS_MEMBER_STATS_QUEUE_URL (or _NAME), CONGRESS_MEMBER_STATS_DLQ_URL (or _NAME)",
].join("\n");

type S3Sender = Pick<S3Client, "send">;
type SqsSender = Pick<SQSClient, "send">;
type Log = (...args: unknown[]) => void;

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * How many member rows a processed bill's official votes give the record: members with a position, in a chamber vote
 * dated by its own day (congressMemberStats leaves an undated one out).
 */
export const memberRowsOf = (payload: unknown): number => {
  if (!payload || typeof payload !== "object") return 0;
  const officialVotes = (payload as Record<string, unknown>).officialVotes as Record<string, unknown> | undefined;
  let rows = 0;
  for (const chamber of ["house", "senate"]) {
    const chamberVote = officialVotes?.[chamber] as Record<string, unknown> | undefined;
    if (!voteRecordDayOf(chamberVote?.actionDate)) continue;
    const members = chamberVote?.members;
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      const record = (member ?? {}) as Record<string, unknown>;
      const id = toTrimmedString(record.bioguideId ?? record.memberId ?? record.id);
      if (id && voteRecordPositionOf(record.votePosition ?? record.vote ?? record.position)) rows += 1;
    }
  }
  return rows;
};

const guidOfKey = (key: string, prefix: string): string => key.slice(prefix.length, -".json".length);

const listKeys = async (s3: S3Sender, bucket: string, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of response.Contents ?? []) {
      const key = object.Key ?? "";
      if (key.endsWith(".json") && !key.slice(prefix.length).includes("/")) keys.push(key);
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (token);
  return keys.sort();
};

const bodyText = async (body: unknown): Promise<string> => {
  if (body && typeof (body as { transformToString?: unknown }).transformToString === "function") {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Unsupported S3 body");
};

export interface Candidate {
  key: string;
  guid: string;
  rows: number;
}

export interface VoteRecordScan {
  scanned: number;
  candidates: Candidate[];
  memberRows: number;
  unreadable: string[];
  byCongress: Record<string, number>;
}

/** Read-only: every processed bill under the prefix, and those whose official votes give the record rows. */
export const scanProcessedBills = async (
  s3: S3Sender,
  config: VoteRecordBackfillConfig,
  options: Pick<CliOptions, "congress" | "concurrency">,
  log: Log,
): Promise<VoteRecordScan> => {
  const prefix = `${config.processedPrefix}${options.congress ? `BILLS-${options.congress}` : ""}`;
  const listed = await listKeys(s3, config.bucket, prefix);
  // The prefix BILLS-12 also lists the 120th to the 129th Congress: keep only the bills of the Congress named.
  const keys = options.congress
    ? listed.filter((key) => congressOfBillGuid(guidOfKey(key, config.processedPrefix)) === options.congress)
    : listed;
  log(
    `Reading ${keys.length} processed bills${options.congress ? ` of Congress ${options.congress}` : ""} ` +
      `under s3://${config.bucket}/${prefix}`,
  );
  const scan: VoteRecordScan = { scanned: keys.length, candidates: [], memberRows: 0, unreadable: [], byCongress: {} };
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next];
      next += 1;
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        const rows = memberRowsOf(JSON.parse(await bodyText(response.Body)));
        if (rows > 0) scan.candidates.push({ key, guid: guidOfKey(key, config.processedPrefix), rows });
      } catch (error) {
        scan.unreadable.push(`${key} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  scan.candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  scan.unreadable.sort();
  for (const candidate of scan.candidates) {
    scan.memberRows += candidate.rows;
    const congress = String(congressOfBillGuid(candidate.guid) ?? "unknown");
    scan.byCongress[congress] = (scan.byCongress[congress] ?? 0) + 1;
  }
  return scan;
};

export const planLine = (scan: VoteRecordScan): string =>
  `Vote record plan: scanned=${scan.scanned} withVotes=${scan.candidates.length} memberRows=${scan.memberRows} ` +
  `unreadable=${scan.unreadable.length}`;

const resolveQueueUrl = async (sqs: SqsSender, url: string, name: string): Promise<string> => {
  if (url) return url;
  const response = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!response.QueueUrl) throw new Error(`Queue ${name} not found`);
  return response.QueueUrl;
};

const queueDepth = async (sqs: SqsSender, queueUrl: string): Promise<number> => {
  const response = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
  );
  return Number(response.Attributes?.ApproximateNumberOfMessages ?? "0");
};

/** Thrown for a refusal before anything was sent (exit 2). */
export class RefusedError extends Error {}

export interface RunOptions {
  s3: S3Sender;
  sqs: SqsSender;
  config: VoteRecordBackfillConfig;
  options: CliOptions;
  log?: Log;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunResult {
  scan: VoteRecordScan;
  sent: number;
  remaining: number;
  lastSent: string | null;
  /** Why the send stopped early, or null; "dlq" and "send" exit 1, "queue" exits 2. */
  stopped: "dlq" | "queue" | "send" | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const runVoteRecordBackfill = async ({
  s3,
  sqs,
  config,
  options,
  log = console.log,
  sleep = defaultSleep,
}: RunOptions): Promise<RunResult> => {
  // Resolved first, so a missing queue stops the run before any read.
  const queueUrl = await resolveQueueUrl(sqs, config.queueUrl, config.queueName);
  const dlqUrl = await resolveQueueUrl(sqs, config.dlqUrl, config.dlqName);
  log(`backfill:member-vote-record mode=${options.apply ? "APPLY" : "DRY-RUN"} queue=${queueUrl}`);

  const scan = await scanProcessedBills(s3, config, options, log);
  const congresses = Object.keys(scan.byCongress).sort();
  log(
    `bills with member votes by Congress: ${congresses.map((c) => `${c}=${scan.byCongress[c]}`).join(" ") || "none"}`,
  );
  for (const entry of scan.unreadable) log(`unreadable: ${entry}`);
  log(planLine(scan));
  if (!options.apply) {
    log(`Dry run: would send ${scan.candidates.length} bills to ${queueUrl}.`);
    return { scan, sent: 0, remaining: scan.candidates.length, lastSent: null, stopped: null };
  }
  if (options.canary === null && options.expectBills !== scan.candidates.length) {
    throw new RefusedError(
      `--expect-bills ${options.expectBills} but ${scan.candidates.length} bills have member votes; run the dry run ` +
        "again and confirm the new count. Nothing was sent.",
    );
  }

  const startIndex = options.startAfter
    ? scan.candidates.findIndex((candidate) => candidate.guid > options.startAfter!)
    : 0;
  const pending = startIndex < 0 ? [] : scan.candidates.slice(startIndex);
  const sending = options.canary !== null ? pending.slice(0, options.canary) : pending;
  const dlqAtStart = await queueDepth(sqs, dlqUrl);
  log(`Sending ${sending.length} bills (${options.canary !== null ? "canary" : "all"}); DLQ holds ${dlqAtStart}.`);

  const intervalMs = Math.ceil((1000 * BATCH_SIZE) / options.rate);
  let sent = 0;
  let lastSent: string | null = null;
  let stopped: RunResult["stopped"] = null;
  for (let start = 0; start < sending.length && !stopped; start += BATCH_SIZE) {
    if (start > 0) await sleep(intervalMs);
    if ((await queueDepth(sqs, dlqUrl)) > dlqAtStart) {
      stopped = "dlq";
      break;
    }
    for (let waited = 0; (await queueDepth(sqs, queueUrl)) > options.maxQueue; waited += QUEUE_WAIT_MS) {
      if (waited >= QUEUE_WAIT_LIMIT_MS) {
        stopped = "queue";
        break;
      }
      await sleep(QUEUE_WAIT_MS);
    }
    if (stopped) break;

    const batch = sending.slice(start, start + BATCH_SIZE);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((candidate, index) => ({
          Id: `bill-${start + index}`,
          MessageBody: buildS3WrappedObjectMessage(config.bucket, candidate.key),
        })),
      }),
    );
    const failed = new Set((response.Failed ?? []).map((entry) => entry.Id));
    for (const [index, candidate] of batch.entries()) {
      if (failed.has(`bill-${start + index}`)) {
        stopped = "send";
        break;
      }
      sent += 1;
      lastSent = candidate.guid;
    }
  }

  const reasons = { dlq: "the DLQ grew", queue: "the queue stayed full", send: "a send failed" } as const;
  log(
    `Vote record backfill: sent=${sent} remaining=${pending.length - sent} ` +
      `stopped=${stopped ? reasons[stopped] : "no"} lastSent=${lastSent ?? "none"}`,
  );
  if (stopped) log(`Resume with --start-after ${lastSent ?? "(none sent: start again)"} once the cause is fixed.`);
  return { scan, sent, remaining: pending.length - sent, lastSent, stopped };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runVoteRecordBackfill({
    s3: new S3Client({ region: config.region }),
    sqs: new SQSClient({ region: config.region }),
    config,
    options,
  });
  if (result.stopped === "queue") process.exitCode = 2;
  else if (result.stopped || result.scan.unreadable.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Member vote record backfill failed", error instanceof Error ? error.message : error);
    process.exitCode = error instanceof RefusedError ? 2 : 1;
  });
}
