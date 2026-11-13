#!/usr/bin/env node

// REL-32 quiet refetch of stale raw bills (integration plan X14).
// A raw bill last fetched long before the cutoff (--older-than-days, default 180) holds stale related bills,
// cosponsors, titles, subjects and committees: nothing refetches a bill whose updateDate does not move.
//
// Dry run (the default; writes nothing): reads every raw-bills/<guid>.json and selects those whose stored
// metadata.fetchedAt is before the cutoff (now minus --older-than-days, default 180; a bill with no fetchedAt is
// selected and counted apart). Prints the count by congress and bill type, the bills already sent (progress file),
// the estimate (Congress.gov calls at CONGRESS_CALLS_PER_BILL per bill, hours at --per-hour, windows), the poller
// state, and each --apply precondition. The last line is
//   Refetch plan: stale= no_fetched_at= fresh= already_sent= to_send= unsendable= unreadable= missing= calls= hours= windows=
//
// --apply: refuses (exit 2) unless FetchRawBill:prod has MEMBER_VOTE_CARRY_MODE=on, the RUNBOOK 4.1 quiet window is
// open (NotificationTypeQueue mappings Disabled, BillsApiPoller rule DISABLED), every watched DLQ is empty and the
// poller state reads. Then sends one UpdatedBillsQueue message per bill in the poller's shape, oldest fetch first,
// at --per-hour (default 500), at most --limit bills (default 800) and for at most --window-minutes (default 100).
// Each message also carries noTextRetry (REL-45): FetchRawBill then makes a refused text final at once instead of
// sending itself a delayed retry, which could land after the window closed and push old news.
// It checks before the first send, so that no send goes out 60 seconds or more after a passing check, and once after
// the last send, and stops (exit 2) on any message in a watched DLQ, on FetchRawBill Errors, CongressApi429 or
// CongressApiAuthFailure since the start, on FetchRawBill's record failures since the start by REL-58's rule
// (recordFailureStop: one FetchRawBillRecordFailed of Kind other, or MAX_UNAVAILABLE_RECORD_FAILURES of Kind
// unavailable; a blip that FetchRawBill's own retries ride out does not stop it, and a throttled one stops it through
// CongressApi429), on more than --max-summaries bills sent to BillSummarizer since the start, when the window was
// closed, or when a check cannot run. The summary cap counts distinct bills, not BillDiffer passes: BillDifferEnqueued
// counts every pass, and a bill whose raw copy EnrichOfficialVotes rewrites after the refetch passes twice. So while
// BillDifferEnqueued is at most --max-summaries nothing more is read; above it, the distinct raw bill keys in
// BillDiffer's "Diffed raw bill" lines with outcome enqueued (Logs Insights) are counted, plus one bill for each
// BillDifferEnqueued the logs do not show yet.
// It pauses while UpdatedBillsQueue holds --max-backlog messages. Each send appends "guid<TAB>sent at<TAB>run start"
// to the progress file, whose header pins the cutoff: a rerun skips listed bills and resumes, and lists by guid the
// ones still stale (in flight, or FetchRawBill failed them; delete a line to send that bill again). The file is also
// a valid --guids-file for reconcile:processed-bills. The last line is
//   Refetch summary: mode=APPLY outcome= selected= already_sent= eligible= sent= remaining= unsendable= unreadable= missing=
//
// Every mode also stops on BillTextUnavailable above 0 since the start (REL-45: a refetch must not strip bill text).
//
// --text-recovery (REL-45): needs --guid or --guids-file (at most 100 bills) and selects, instead of the fetchedAt
// cutoff, the listed raw bills whose newest text version has a Formatted XML URL and that have no billXML. It waives
// the X7 precondition (MEMBER_VOTE_CARRY_MODE=on) with a printed line: a listed bill with member votes keeps them only
// under "on", otherwise EnrichOfficialVotes adds them again. --predict (dry run only, with --text-recovery) fetches
// each selected bill's GovInfo XML, one every 2 s with FetchRawBill's User-Agent, and plans the bill (planReconcile)
// on a copy of its raw bill with that text, printing
//   Text recovery prediction: bills= fetched= fetch_failed= summarize_missing= summarize_text_changed= patch= unchanged= awaiting_text= other=
//
// --snapshot-file (REL-56, RUNBOOK 16.1): selects exactly the bills of a list:skipped-bill-updates snapshot, in its
// order (newest first), instead of the fetchedAt cutoff: no cutoff, no 100-bill cap; --guid, --guids-file and
// --congress only narrow it, and --older-than-days and --text-recovery are refused with it. A bill whose raw copy was
// fetched at or after the snapshot's listedAt is skipped (fetched_since). A stored bill gets refetchMessage with its
// list row's latest action text as the description and, when congress.gov retitled it, the row's title (titles_differ),
// as the poller sends them; a stored title in the older GovInfo form ("H.R.&nbsp;N&nbsp;(IH) - ...") is kept
// (titles_govinfo: no news, and a new title would re-summarize the same text). A bill with no raw copy gets
// billListRowMessage, the poller's message for its list row. Correlation ids are rel56:<run start>:<guid>, and each
// message carries the snapshot's listedAt, which FetchRawBill dates the stored title by (REL-58).
// resummaries_likely forecasts the next batch's re-summaries (resummaryLikely; RUNBOOK 16.1, D5), and --apply says so
// when it is above --max-summaries. Two more --apply preconditions: the snapshot's congress is the poller state's and
// the primary one (the backfill bypasses a trailing Congress's outcome gate), and the time is before 2026-12-28T00:00Z
// (RUNBOOK 24.1: no quiet window from then; no send goes out after it either). The progress file's header names the
// snapshot (its SHA-256 and listedAt); another snapshot's file, or a cutoff or text-recovery file, is refused. Decision
// D3: a first summary (a BillDiffer pass with reason no_processed: the bill had no processed copy) of a bill the
// backfill sent, in this run or an earlier one (the progress file), is expected and does not count against
// --max-summaries. Re-summaries and passes not in the logs yet still do. The last lines are
//   Refetch plan: mode=snapshot missing= stale= fetched_since= already_sent= to_send= unsendable= unreadable= first_summaries= titles_differ= titles_govinfo= resummaries_likely= calls= hours= windows=
//   Refetch summary: mode=APPLY selection=snapshot outcome= ... missing= missing_sent= fetched_since=
//
// --unattended (with --snapshot-file only; REL-56, project decision 2026-11-12, RUNBOOK 16.1): the backfill without
// quiet windows. NotificationType hands a change with a rel56: id to nobody (BACKFILL_PUSH_MODE=skip), so the run needs
// the opposite of a window: --apply refuses unless NotificationType:prod reads BACKFILL_PUSH_MODE=skip and every poller
// rule is ENABLED and every NotificationTypeQueue mapping Enabled (with the carry, DLQ, poller state, congress and
// 2026-12-28 checks as above). It shares FetchRawBill and the congress.gov key with the poller, so it sends at
// --per-hour 300 by default (at most 400) and pauses while UpdatedBillsQueue or BillSummarizerQueue holds --max-backlog
// visible messages, and on Sundays from 09:30 to 11:00 New York time (the weekly digest). A run sends at most --limit
// bills (3,000 by default) with no window time; nothing goes out from 2026-12-28T00:00Z. Without --max-summaries the
// cap is the run's resummaries_likely + 5 (D5 b), held as the run goes: at each check, the bills sent so far that
// resummaries_likely flags, + 5 (a given --max-summaries is held as given). It stops (exit 2) on a watched DLQ
// message, on FetchRawBill Errors, CongressApi429, CongressApiAuthFailure or BillTextUnavailable since the start, on
// FetchRawBill's record failures by the same rule as a window's run (recordFailureStop; the poller's traffic counts too
// in all of them), on more re-summaries of bills it sent than the cap (BillDiffer's logs, rel56: ids, first summaries
// left out, D3), on NotificationType:prod no longer reading skip, on any UserMatcher line with a rel56: id (a backfill
// change reached the push path), on MEMBER_VOTE_CARRY_MODE no longer on, or when a window is opened. A check that
// cannot run is tried 3 times, 30 s apart. Just before each send it reads the bill's raw copy (HeadObject) and skips
// one stored since the snapshot's listedAt (the poller has it). Ctrl-C stops after the send in hand, under `npm run`
// too (npm forwards a copy of the terminal's SIGINT; the same signal within REPEAT_SIGNAL_MS is that copy); a later
// Ctrl-C quits at once. Every stop is resumed by the same command. The plan and summary lines say unattended=true,
// runs= instead of windows=, and max_summaries= and fetched_since_run=.
//
// Read-only AWS calls only, apart from the SQS sends under --apply: S3 List/Get/Head, SQS GetQueueUrl/GetQueueAttributes,
// CloudWatch GetMetricData, SSM GetParameter, and the AWS CLI for lambda get-function-configuration,
// list-event-source-mappings, get-alias, events list-rule-names-by-target, describe-rule and, only once
// BillDifferEnqueued is above --max-summaries, logs start-query, get-query-results (on /aws/lambda/BillDiffer;
// --unattended also on /aws/lambda/UserMatcher at every check).
// --predict adds GETs to www.govinfo.gov.
// Exit codes: 0 finished; 1 a send failed, a raw bill could not be read, or a usage error; 2 refused or stopped.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
  type QueueAttributeName,
} from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { BillStorage } from "../src/adapters/billStorage";
import { ProcessedBillDao } from "../src/adapters/processedBillDao";
import {
  billVersionStem,
  classifyBillXmlResponse,
  govInfoBillXmlUrl,
  locateBillXmlUrl,
  type HttpTextResponse,
} from "../src/handlers/fetchRawBill/billText";
import type { RawBill } from "../src/models/bill";
import { toBillMessage, toTrimmedString } from "../src/shared/billListRow";
import {
  extractRawBillTitle,
  extractRawBillXml,
  legacyAnchorHash,
  needsLegacyAnchor,
  planReconcile,
  rawFetchedAt,
} from "../src/shared/billSourceReconcile";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { correlationIdMessageAttributes, REL56_BACKFILL_CORRELATION_PREFIX } from "../src/shared/correlation";
import { BILLBOARD_FETCHER_USER_AGENT, fetchWithTimeout } from "../src/shared/http";
import { parseGuidsFile, plainGuid } from "./reconcileProcessedBills";
import { BACKFILL_DEADLINE, parseSnapshot, primaryCongressAt, type ParsedSnapshot } from "./skippedBillSnapshot";

// ─── Defaults and limits ─────────────────────────────────────────────────────

export const DEFAULT_OLDER_THAN_DAYS = 180;
export const DEFAULT_PER_HOUR = 500;
/** 600 bills an hour is 4,800 Congress.gov calls, just under the key's hourly limit. */
export const MAX_PER_HOUR = 600;
/** The --apply batch when --limit is not given: one RUNBOOK 4.1 quiet window (96 minutes at 500 an hour). */
export const DEFAULT_BATCH_LIMIT = 800;
/** Sends stop this long after the run started, so the queues drain and the window closes inside 2 hours. */
export const DEFAULT_WINDOW_MINUTES = 100;
const MAX_WINDOW_MINUTES = 110;
/** Sending pauses while UpdatedBillsQueue holds this many messages (its age alarm fires at 20 minutes). */
export const DEFAULT_MAX_BACKLOG = 20;
/** UA-28's limit: more bills sent to BillSummarizer than this in one run stops it. */
export const DEFAULT_MAX_SUMMARIES = 50;
/**
 * --unattended (REL-56, RUNBOOK 16.1): bills an hour by default, and at most. The backfill shares FetchRawBill (about
 * 570 bills an hour at MaximumConcurrency 2) and the congress.gov key (5,000 requests an hour) with the poller. Measured
 * 2026-11-09 to 11-12 (the fixed poller's first 72 hours): poller-sent FetchRawBill bills an hour median 7, p90 44, p95
 * 165, max 355; FetchRawBill and poller requests an hour median 146, p90 449, p95 1,419, max 2,943. At 300 an hour
 * (2,400 requests) a p95 hour needs 465 of FetchRawBill's 570 and about 3,900 requests; in a burst the backlog pause
 * leaves FetchRawBill to the poller. 400 keeps the backfill under 70% of FetchRawBill.
 */
export const UNATTENDED_DEFAULT_PER_HOUR = 300;
export const UNATTENDED_MAX_PER_HOUR = 400;
/** --unattended: the bills one run sends when --limit is not given, about 10 hours at 300 an hour. */
export const UNATTENDED_DEFAULT_LIMIT = 3_000;
/** D5 (b): a run's --max-summaries, when not given, is its resummaries_likely plus this. */
export const D5_MARGIN = 5;
/** --unattended: a check that cannot run is tried this many times, CHECK_RETRY_WAIT_MS apart, before the run stops. */
export const UNATTENDED_CHECK_ATTEMPTS = 3;
export const CHECK_RETRY_WAIT_MS = 30_000;
/** The Logs Insights query that counts the summary cap's bills is polled this often, at most this many times. */
export const LOGS_QUERY_POLL_MS = 1_000;
export const LOGS_QUERY_MAX_POLLS = 60;
/**
 * BillDiffer's enqueues since the start, one row per raw bill and invocation (a BillDiffer invocation diffs a raw bill
 * once, however many of its records name it, so each row is one BillDifferEnqueued), with the plan's reason:
 * no_processed for a first summary, text_changed for a re-summary.
 */
export const ENQUEUED_DIFFS_QUERY = [
  'filter message = "Diffed raw bill" and outcome = "enqueued"',
  "| stats count(*) as lines by key, awsRequestId, reason",
  "| limit 10000",
].join("\n");
/** BillDiffer's reason for a first summary: the bill had no processed copy (summarize_missing). */
export const FIRST_SUMMARY_REASON = "no_processed";
/**
 * --unattended: BillDiffer's enqueues since the start that count against --max-summaries: the backfill's (a rel56:
 * correlation id; the poller's passes are its own) other than first summaries (D3). A row with no reason counts.
 */
export const BACKFILL_RESUMMARIES_QUERY = [
  'filter message = "Diffed raw bill" and outcome = "enqueued" and correlationId like /^rel56:/',
  `| filter isblank(reason) or reason != "${FIRST_SUMMARY_REASON}"`,
  "| stats count(*) as lines by key, awsRequestId, reason",
  "| limit 10000",
].join("\n");
/** --unattended: UserMatcher's lines with a rel56: id since the start. Any means a backfill change reached the push path. */
export const BACKFILL_PUSHES_QUERY = ["filter correlationId like /^rel56:/", "| stats count(*) as lines"].join("\n");
export const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 25;
export const CHECK_INTERVAL_MS = 60_000;
export const BACKLOG_WAIT_MS = 30_000;
export const DEFAULT_PROGRESS_FILE = "refetch-stale-bills.progress.tsv";
/** --text-recovery takes a list, and at most this many bills (REL-45). */
export const TEXT_RECOVERY_MAX_BILLS = 100;
/** --predict asks GovInfo for one bill every 2 seconds. */
export const PREDICT_INTERVAL_MS = 2_000;
const PREDICT_REQUEST_TIMEOUT_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const LOG_EVERY_SENDS = 50;

/**
 * Congress.gov calls FetchRawBill makes per bill: its 8 endpoints (bill, actions, subjects, titles, cosponsors,
 * committees, relatedbills, text) under CONGRESS_API_MAX_CALLS_PER_BILL=10; extra cosponsor and related-bill pages
 * add a few. CongressApiCallsCore averaged 8.0 over 322 bills from 2026-09-24 to 2026-10-08.
 */
export const CONGRESS_CALLS_PER_BILL = 8;
/** api.congress.gov allows 5,000 requests an hour per key, shared with the poller and vote enrichment. */
export const CONGRESS_KEY_CALLS_PER_HOUR = 5_000;

/** The six ingest DLQs (INGEST_DLQ_RETENTION_DAYS in infra) and BillsManifestDLQ, which refetched bills reach. */
export const WATCHED_DLQ_NAMES: readonly string[] = [
  "UpdatedBillsDLQ",
  "BillDifferDLQ",
  "BillVoteEnrichmentDLQ",
  "BillSummarizerDLQ",
  "UpdatedCongressMembersDLQ",
  "CongressMemberSummarizerDLQ",
  "BillsManifestDLQ",
];

const BILL_TYPE_PATHS: Readonly<Record<string, string>> = {
  hr: "house-bill",
  s: "senate-bill",
  hjres: "house-joint-resolution",
  sjres: "senate-joint-resolution",
  hconres: "house-concurrent-resolution",
  sconres: "senate-concurrent-resolution",
  hres: "house-resolution",
  sres: "senate-resolution",
};

// ─── Configuration and arguments ────────────────────────────────────────────

export interface RefetchConfig {
  region: string;
  bucket: string;
  rawPrefix: string;
  /** Used as is when set; otherwise `updatedBillsQueueName` is resolved with GetQueueUrl. */
  updatedBillsQueueUrl: string;
  updatedBillsQueueName: string;
  notificationTypeQueueName: string;
  fetchRawBillFunction: string;
  pollerFunction: string;
  lambdaAlias: string;
  pollerStateParameter: string;
  dlqNames: readonly string[];
  /** Where BillDiffer logs "Diffed raw bill" (the summary cap's distinct bills). */
  billDifferLogGroup: string;
  /** --unattended: the function whose BACKFILL_PUSH_MODE must read skip (REL-56). */
  notificationTypeFunction: string;
  /** --unattended: the summarizer's queue, whose backlog pauses the sends. */
  billSummarizerQueueName: string;
  /** --unattended: where UserMatcher logs; a line with a rel56: id there stops the run. */
  userMatcherLogGroup: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): RefetchConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  rawPrefix: env.RAW_BILLS_PREFIX || "raw-bills/",
  updatedBillsQueueUrl: env.UPDATED_BILLS_QUEUE_URL || "",
  updatedBillsQueueName: env.UPDATED_BILLS_QUEUE_NAME || "UpdatedBillsQueue",
  notificationTypeQueueName: "NotificationTypeQueue",
  fetchRawBillFunction: "FetchRawBill",
  pollerFunction: "BillsApiPoller",
  lambdaAlias: "prod",
  pollerStateParameter: "/billboard/congress/bills-poller-state",
  dlqNames: WATCHED_DLQ_NAMES,
  billDifferLogGroup: "/aws/lambda/BillDiffer",
  notificationTypeFunction: "NotificationType",
  billSummarizerQueueName: "BillSummarizerQueue",
  userMatcherLogGroup: "/aws/lambda/UserMatcher",
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  olderThanDays: number;
  perHour: number;
  /** Bills to send this run; null means DEFAULT_BATCH_LIMIT under --apply (see effectiveLimit). */
  limit: number | null;
  guids: string[];
  guidsFile: string | null;
  congress: string | null;
  progressFile: string;
  windowMinutes: number;
  maxBacklog: number;
  maxSummaries: number;
  concurrency: number;
  /** REL-45: select the listed raw bills that have a Formatted XML URL and no text, instead of the cutoff. */
  textRecovery: boolean;
  /** REL-45: dry run only; fetch each selected bill's GovInfo XML and predict its plan. */
  predict: boolean;
  /** REL-56: select exactly the bills of this list:skipped-bill-updates snapshot instead of the cutoff. */
  snapshotFile: string | null;
  /** REL-56 (--unattended, with --snapshot-file): send without a quiet window; set only when given. */
  unattended?: boolean;
  /** --unattended without --max-summaries: the cap is the run's resummaries_likely + D5_MARGIN (D5 b). */
  maxSummariesFromForecast?: boolean;
}

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    olderThanDays: DEFAULT_OLDER_THAN_DAYS,
    perHour: DEFAULT_PER_HOUR,
    limit: null,
    guids: [],
    guidsFile: null,
    congress: null,
    progressFile: DEFAULT_PROGRESS_FILE,
    windowMinutes: DEFAULT_WINDOW_MINUTES,
    maxBacklog: DEFAULT_MAX_BACKLOG,
    maxSummaries: DEFAULT_MAX_SUMMARIES,
    concurrency: DEFAULT_CONCURRENCY,
    textRecovery: false,
    predict: false,
    snapshotFile: null,
  };
  let olderThanDaysGiven = false;
  let perHourGiven = false;
  let windowMinutesGiven = false;
  let maxSummariesGiven = false;
  const readValue = (flag: string, raw: string | undefined): string => {
    if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs a value`);
    return raw;
  };
  const readWhole = (flag: string, raw: string | undefined, min: number, max: number): number => {
    const value = Number(raw);
    if (!raw || !/^\d+$/.test(raw) || value < min || value > max) {
      throw new Error(`${flag} needs a whole number from ${min} to ${max}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--older-than-days") {
      options.olderThanDays = readWhole(arg, argv[(index += 1)], 1, 3650);
      olderThanDaysGiven = true;
    } else if (arg === "--snapshot-file") options.snapshotFile = readValue(arg, argv[(index += 1)]);
    else if (arg === "--per-hour") {
      options.perHour = readWhole(arg, argv[(index += 1)], 1, MAX_PER_HOUR);
      perHourGiven = true;
    } else if (arg === "--limit") options.limit = readWhole(arg, argv[(index += 1)], 1, 1_000_000);
    else if (arg === "--guid") {
      const guid = plainGuid(readValue(arg, argv[(index += 1)]));
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hr1400");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--guids-file") options.guidsFile = readValue(arg, argv[(index += 1)]);
    else if (arg === "--congress") {
      const congress = readValue(arg, argv[(index += 1)]);
      if (!/^\d{2,3}$/.test(congress)) throw new Error("--congress needs a congress number such as 119");
      options.congress = congress;
    } else if (arg === "--progress-file") options.progressFile = readValue(arg, argv[(index += 1)]);
    else if (arg === "--window-minutes") {
      options.windowMinutes = readWhole(arg, argv[(index += 1)], 1, MAX_WINDOW_MINUTES);
      windowMinutesGiven = true;
    } else if (arg === "--max-backlog") options.maxBacklog = readWhole(arg, argv[(index += 1)], 1, 1000);
    else if (arg === "--max-summaries") {
      options.maxSummaries = readWhole(arg, argv[(index += 1)], 0, 1000);
      maxSummariesGiven = true;
    } else if (arg === "--concurrency") options.concurrency = readWhole(arg, argv[(index += 1)], 1, MAX_CONCURRENCY);
    else if (arg === "--text-recovery") options.textRecovery = true;
    else if (arg === "--predict") options.predict = true;
    else if (arg === "--unattended") options.unattended = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.textRecovery && options.guids.length === 0 && !options.guidsFile) {
    throw new Error("--text-recovery needs --guids-file or --guid: it never reads every raw bill");
  }
  if (options.predict && !options.textRecovery) throw new Error("--predict needs --text-recovery");
  if (options.predict && options.apply) throw new Error("--predict is a dry run only; leave out --apply");
  if (options.snapshotFile && options.textRecovery) {
    throw new Error("--snapshot-file and --text-recovery select bills in different ways; use one");
  }
  if (options.snapshotFile && olderThanDaysGiven) {
    throw new Error(
      "--older-than-days does not apply to --snapshot-file: the snapshot selects the bills, with no cutoff",
    );
  }
  if (options.unattended) {
    if (!options.snapshotFile) throw new Error("--unattended is the REL-56 backfill's: it needs --snapshot-file");
    if (windowMinutesGiven) {
      throw new Error(
        "--window-minutes is a quiet window's; --unattended runs without one (a run ends at --limit or 2026-12-28)",
      );
    }
    if (!perHourGiven) options.perHour = UNATTENDED_DEFAULT_PER_HOUR;
    if (options.perHour > UNATTENDED_MAX_PER_HOUR) {
      throw new Error(
        `--unattended sends at most ${UNATTENDED_MAX_PER_HOUR} bills an hour: it shares FetchRawBill and the key with the poller`,
      );
    }
    if (!maxSummariesGiven) options.maxSummariesFromForecast = true;
  }
  return options;
};

/** The most bills this run sends: --limit, or one window's batch under --apply (an --unattended run's 3,000). */
export const effectiveLimit = (options: Pick<CliOptions, "limit"> & Pick<Partial<CliOptions>, "unattended">): number =>
  options.limit ?? (options.unattended ? UNATTENDED_DEFAULT_LIMIT : DEFAULT_BATCH_LIMIT);

/** Milliseconds between two sends at --per-hour. */
export const sendIntervalMs = (perHour: number): number => Math.ceil((60 * MINUTE_MS) / perHour);

const USAGE = [
  "Refetch raw bills last fetched long ago (REL-32): select them, and with --apply send each one to",
  "UpdatedBillsQueue in the poller's message shape, paced, inside a RUNBOOK 4.1 quiet window (the REL-56 backfill's",
  "--unattended runs without one).",
  "",
  "Usage:",
  "  npm run refetch:stale-bills                                        Dry run over every raw bill",
  "  npm run refetch:stale-bills -- --guid BILLS-119hr1400 --apply      Canary, inside a quiet window",
  "  npm run refetch:stale-bills -- --apply                             One window's batch",
  "  npm run refetch:stale-bills -- --snapshot-file rel56-snapshot.tsv \\",
  "    --progress-file rel56-backfill.progress.tsv --apply              REL-56 backfill, one window's batch",
  "  npm run refetch:stale-bills -- --snapshot-file rel56-snapshot.tsv \\",
  "    --progress-file rel56-backfill.progress.tsv --unattended --apply REL-56 backfill without a window",
  "",
  "Options:",
  "  --apply                 Send (default: dry run, which writes nothing). Refuses unless FetchRawBill:prod has",
  "                          MEMBER_VOTE_CARRY_MODE=on, the quiet window is open, the DLQs are empty and the",
  "                          poller state reads",
  `  --older-than-days <n>   Select raw bills fetched more than n days ago (default ${DEFAULT_OLDER_THAN_DAYS}); fixed by the`,
  "                          progress file once it exists",
  `  --per-hour <n>          Bills sent per hour (default ${DEFAULT_PER_HOUR}, at most ${MAX_PER_HOUR})`,
  `  --limit <n>             Send at most n bills this run (default ${DEFAULT_BATCH_LIMIT} with --apply)`,
  `  --window-minutes <n>    Stop sending n minutes after the start (default ${DEFAULT_WINDOW_MINUTES}, at most ${MAX_WINDOW_MINUTES})`,
  "  --guid <guid>           Only this bill, if stale (repeatable)",
  "  --guids-file <f>        Only the bills listed (first tab-separated column, # lines skipped), if stale",
  "  --congress <n>          Only bills of this congress",
  `  --progress-file <f>     Resume file (default ${DEFAULT_PROGRESS_FILE} in the current directory)`,
  `  --max-backlog <n>       Pause while UpdatedBillsQueue holds n messages (default ${DEFAULT_MAX_BACKLOG})`,
  `  --max-summaries <n>     Stop above n bills sent to BillSummarizer since the start (default ${DEFAULT_MAX_SUMMARIES}). It counts`,
  "                          distinct bills, not passes: a bill BillDiffer enqueues twice (its raw copy rewritten by",
  "                          EnrichOfficialVotes) counts once. Read from BillDiffer's logs only once BillDifferEnqueued",
  "                          (every pass) is above n; a pass not in the logs yet counts as one more bill",
  `  --concurrency <n>       Raw bills read at once (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  `  --text-recovery         REL-45: needs --guid or --guids-file (at most ${TEXT_RECOVERY_MAX_BILLS} bills); selects the listed raw`,
  "                          bills with a Formatted XML URL and no billXML instead of the cutoff, and waives the",
  "                          X7 precondition (MEMBER_VOTE_CARRY_MODE=on) with a printed line",
  "  --predict               With --text-recovery, dry run only: fetch each selected bill's GovInfo XML (one every",
  "                          2 s) and print the plans BillDiffer would make (summarize_missing, summarize_text_changed,",
  "                          patch, unchanged)",
  "  --snapshot-file <f>     REL-56: exactly the bills of a list:skipped-bill-updates snapshot, newest first, never",
  "                          stored ones included (built from their list row); no cutoff and no cap. A bill fetched",
  "                          since the snapshot's listedAt is skipped. --guid, --guids-file and --congress narrow it.",
  "                          --apply also needs the snapshot's congress to be the poller's and the primary one, and",
  "                          refuses from 2026-12-28T00:00Z (RUNBOOK 24.1). First summaries (no processed copy) of",
  "                          bills the backfill sent, this run or listed in the progress file, are not counted",
  "                          against --max-summaries (D3); re-summaries are. Use its own --progress-file",
  "  --unattended            REL-56, with --snapshot-file: send without a quiet window. --apply needs",
  "                          NotificationType:prod at BACKFILL_PUSH_MODE=skip and no window open (every poller rule",
  "                          ENABLED, every NotificationTypeQueue mapping Enabled).",
  `                          --per-hour ${UNATTENDED_DEFAULT_PER_HOUR} by default (at most ${UNATTENDED_MAX_PER_HOUR}), --limit ${UNATTENDED_DEFAULT_LIMIT} a run, no --window-minutes;`,
  "                          pauses on UpdatedBillsQueue or BillSummarizerQueue at --max-backlog and",
  "                          on Sundays 09:30 to 11:00 New York time; --max-summaries defaults to the run's",
  "                          resummaries_likely + 5 (D5), held at each check to the bills sent so far that it flags",
  "                          + 5. Also stops when NotificationType stops skipping, a backfill change reaches",
  "                          UserMatcher, the carry is not on or a window opens; skips a bill stored since the",
  "                          snapshot. Ctrl-C stops after the send in hand (npm's copy of the signal is ignored);",
  "                          Ctrl-C again, a second or more later, quits at once; the same command resumes",
  "",
  "Exit codes: 0 finished (list done, batch or time limit reached); 1 a send failed, a raw bill could not be",
  "read, or a usage error; 2 a precondition refused or a stop condition fired.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "RAW_BILLS_PREFIX, UPDATED_BILLS_QUEUE_URL (or UPDATED_BILLS_QUEUE_NAME, default UpdatedBillsQueue).",
  "Needs the AWS CLI on PATH for the Lambda and EventBridge checks, and for the --max-summaries count from",
  "BillDiffer's logs (logs start-query, get-query-results).",
].join("\n");

// ─── The message ─────────────────────────────────────────────────────────────

/** The message BillsApiPoller sends to UpdatedBillsQueue and FetchRawBill reads, plus noTextRetry. */
export interface UpdatedBillMessage {
  guid: string;
  title: string;
  link: string;
  legislationUrl: string;
  pubDate: string;
  category?: string;
  description?: string;
  congress: string;
  billType: string;
  billNumber: string;
  /**
   * REL-45: FetchRawBill sends no delayed text retry for this message (a refusal is final and counts
   * BillTextUnavailable, which stops the run), so nothing this run sends lands after its quiet window closed.
   */
  noTextRetry: true;
  /** A never-stored bill's message from its list row (REL-56) carries the row's updateDate, as the poller's does. */
  updateDate?: string;
  /**
   * REL-56 (--snapshot-file): the snapshot's listedAt, when congress.gov listed the title and description the message
   * carries. FetchRawBill dates the stored title by it under FETCH_RETRY_BACKOFF on (REL-58), not by the run start in
   * the rel56: id, so a poller listing made after the snapshot is not taken for an older one.
   */
  listedAt?: string;
}

/** BILLS-119hr1400 -> its parts, or null when it is not a plain guid of a known bill type. */
export const guidParts = (guid: string): { congress: string; billType: string; billNumber: string } | null => {
  const match = guid.match(/^BILLS-(\d+)([a-z]+)(\d+)$/);
  if (!match || !BILL_TYPE_PATHS[match[2]]) return null;
  return { congress: match[1], billType: match[2], billNumber: match[3] };
};

const congressOrdinal = (congress: string): string => {
  const n = Number.parseInt(congress, 10);
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

/** The poller's legislationUrl for a bill. */
export const legislationUrlFor = (parts: { congress: string; billType: string; billNumber: string }): string =>
  `https://www.congress.gov/bill/${congressOrdinal(parts.congress)}-congress/${BILL_TYPE_PATHS[parts.billType]}/${parts.billNumber}`;

const storedString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The refetch message for the raw bill stored under `guid` (the plain key guid, as the poller sends it). Title,
 * pubDate, category, description and legislationUrl go back exactly as stored: billDiffer re-summarizes a bill
 * whose title changed, so the refetch must not change it. --snapshot-file (REL-56) sends the list row's title instead
 * when congress.gov retitled the bill, and the row's description (scanSnapshot, titleChange).
 */
export const refetchMessage = (
  guid: string,
  rawBill: RawBill,
): { message: UpdatedBillMessage; problem?: undefined } | { message?: undefined; problem: string } => {
  const parts = guidParts(guid);
  if (!parts) return { problem: "not a plain bill guid of a known bill type" };
  const metadata = (rawBill as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return { problem: "no metadata" };
  const stored = metadata as Record<string, unknown>;
  const legislationUrl = storedString(stored.legislationUrl).trim() || legislationUrlFor(parts);
  const category = storedString(stored.category);
  const description = storedString(stored.description);
  return {
    message: {
      guid,
      title: storedString(stored.title),
      link: legislationUrl,
      legislationUrl,
      pubDate: storedString(stored.pubDate),
      ...(category ? { category } : {}),
      ...(description ? { description } : {}),
      ...parts,
      noTextRetry: true,
    },
  };
};

/**
 * REL-56: the message for a bill that was never stored, from its snapshot list row: the poller's own (toBillMessage),
 * plus noTextRetry. Refused when the row names another bill than `guid`.
 */
export const billListRowMessage = (
  guid: string,
  row: Record<string, unknown>,
): { message: UpdatedBillMessage; problem?: undefined } | { message?: undefined; problem: string } => {
  const parts = guidParts(guid);
  if (!parts) return { problem: "not a plain bill guid of a known bill type" };
  const built = toBillMessage(row, parts.billType, parts.congress);
  if (!built) return { problem: "its list row names no bill" };
  if (built.guid !== guid) return { problem: `its list row names ${built.guid}` };
  return {
    message: {
      ...built,
      legislationUrl: built.legislationUrl ?? legislationUrlFor(parts),
      congress: built.congress ?? parts.congress,
      billType: built.billType ?? parts.billType,
      billNumber: built.billNumber ?? parts.billNumber,
      noTextRetry: true,
    },
  };
};

// ─── Progress file ───────────────────────────────────────────────────────────

export interface Progress {
  cutoff: string | null;
  olderThanDays: number | null;
  sent: Set<string>;
  /** Set when the file was started by a --text-recovery (REL-45) or --snapshot-file (REL-56) run; a cutoff run's has none. */
  mode?: "text-recovery" | "snapshot";
  /** --snapshot-file: the snapshot the file belongs to. */
  snapshotSha256?: string;
  listedAt?: string;
}

const PROGRESS_SETTINGS_LINE = /^#\s*cutoff=(\S+)\s+olderThanDays=(\d+)\s*$/;
const PROGRESS_TEXT_RECOVERY_LINE = /^#\s*mode=text-recovery\s*$/;
const PROGRESS_SNAPSHOT_LINE = /^#\s*mode=snapshot\s+snapshotSha256=([0-9a-f]{64})\s+listedAt=(\S+)\s*$/;

/** The header written when the file is created; it pins the cutoff (and a --text-recovery run's mode). */
export const progressHeader = (cutoff: string, olderThanDays: number, mode?: "text-recovery"): string =>
  [
    "# refetch:stale-bills progress (REL-32). One line per bill sent: guid<TAB>sent at<TAB>run start.",
    "# Resume with the same --progress-file. Check a window: npm run reconcile:processed-bills -- --guids-file <this file>",
    `# cutoff=${cutoff} olderThanDays=${olderThanDays}`,
    ...(mode ? [`# mode=${mode}`] : []),
    "",
  ].join("\n");

/** REL-56: the header of a --snapshot-file run's progress file; it names the snapshot (its SHA-256 and listedAt). */
export const snapshotProgressHeader = (snapshotSha256: string, listedAt: string): string =>
  [
    "# refetch:stale-bills progress (REL-56 backfill). One line per bill sent: guid<TAB>sent at<TAB>run start.",
    "# Resume with the same --snapshot-file and --progress-file. Check a window: npm run reconcile:processed-bills -- --guids-file <this file>",
    `# mode=snapshot snapshotSha256=${snapshotSha256} listedAt=${listedAt}`,
    "",
  ].join("\n");

export const progressLine = (guid: string, sentAt: string, runStartedAt: string): string =>
  `${guid}\t${sentAt}\t${runStartedAt}\n`;

export const parseProgress = (text: string): Progress => {
  let cutoff: string | null = null;
  let olderThanDays: number | null = null;
  let textRecovery = false;
  let snapshot: { sha256: string; listedAt: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (PROGRESS_TEXT_RECOVERY_LINE.test(line.trim())) textRecovery = true;
    const snapshotLine = line.trim().match(PROGRESS_SNAPSHOT_LINE);
    if (snapshotLine) {
      if (Number.isNaN(Date.parse(snapshotLine[2])))
        throw new Error(`The progress file's listedAt is not a time: ${line}`);
      snapshot = { sha256: snapshotLine[1], listedAt: new Date(snapshotLine[2]).toISOString() };
    }
    const settings = line.trim().match(PROGRESS_SETTINGS_LINE);
    if (!settings) continue;
    if (Number.isNaN(Date.parse(settings[1]))) throw new Error(`The progress file's cutoff is not a time: ${line}`);
    cutoff = new Date(settings[1]).toISOString();
    olderThanDays = Number(settings[2]);
  }
  // Same rules as reconcile:processed-bills --guids-file (first tab column, # lines skipped).
  return {
    cutoff,
    olderThanDays,
    sent: new Set(parseGuidsFile(text)),
    ...(textRecovery ? { mode: "text-recovery" as const } : {}),
    ...(snapshot ? { mode: "snapshot" as const, snapshotSha256: snapshot.sha256, listedAt: snapshot.listedAt } : {}),
  };
};

// ─── Selection ───────────────────────────────────────────────────────────────

export interface StaleBill {
  key: string;
  guid: string;
  /** null when the raw bill has no usable metadata.fetchedAt. */
  fetchedAt: string | null;
  message: UpdatedBillMessage;
  /** --text-recovery: the newest text version's Formatted XML URL. */
  xmlUrl?: string;
  /** --snapshot-file: no raw copy, so the message is the poller's for its list row (a first summary follows). */
  neverStored?: boolean;
  /** --snapshot-file: congress.gov retitled this stored bill (titleChange "differs"): it is sent with the row's. */
  titleDiffers?: boolean;
  /** --snapshot-file: a stored title in GovInfo's form (titleChange "govinfo"); it is sent as stored. */
  titleGovInfo?: boolean;
  /** --snapshot-file: a stored bill that will likely be re-summarized (resummaryLikely; RUNBOOK 16.1, D5). */
  resummaryLikely?: boolean;
}

export interface ScanResult {
  /** Selected bills, oldest fetch first (no fetchedAt first), then by guid. */
  stale: StaleBill[];
  /** Not selected: fetched at or after the cutoff, or (--text-recovery) already holding text. */
  fresh: number;
  /** --text-recovery: listed bills with no Formatted XML URL yet (text not published), not selected. */
  awaitingText: string[];
  /** Listed guids (or listed keys) with no raw bill. */
  missing: string[];
  unsendable: Array<{ key: string; reason: string }>;
  unreadable: Array<{ key: string; error: string }>;
  scanned: number;
  /** --snapshot-file: snapshot bills whose raw copy was fetched at or after the snapshot's listedAt (not selected). */
  fetchedSince?: string[];
  /** --snapshot-file: --guid and --guids-file bills that are not in the snapshot (not selected). */
  notInSnapshot?: string[];
}

type S3Sender = Pick<S3Client, "send">;
type QueueSender = Pick<SQSClient, "send">;
type MetricsReader = Pick<CloudWatchClient, "send">;
type ParameterReader = Pick<SSMClient, "send">;
type Log = (...args: unknown[]) => void;

const listRawKeys = async (s3: S3Sender, bucket: string, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  const rootLength = prefix.lastIndexOf("/") + 1;
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const object of response.Contents ?? []) {
      const key = object.Key ?? "";
      if (key.endsWith(".json") && !key.slice(rootLength).includes("/")) keys.push(key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys.sort();
};

const byOldestFetch = (a: StaleBill, b: StaleBill): number => {
  const aMs = a.fetchedAt === null ? -Infinity : Date.parse(a.fetchedAt);
  const bMs = b.fetchedAt === null ? -Infinity : Date.parse(b.fetchedAt);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
};

/** The --guid and --guids-file bills, once each, or null when neither was given. Throws for a missing or empty file. */
export const listedGuids = (
  options: Pick<CliOptions, "guids" | "guidsFile">,
  readFile: (path: string) => string | null,
): string[] | null => {
  if (options.guids.length === 0 && !options.guidsFile) return null;
  const fileText = options.guidsFile ? readFile(options.guidsFile) : null;
  if (options.guidsFile && fileText === null) throw new Error(`The guids file ${options.guidsFile} does not exist`);
  const listed = [...new Set([...options.guids, ...(fileText !== null ? parseGuidsFile(fileText) : [])])];
  // A list never widens to every raw bill.
  if (listed.length === 0) throw new Error(`The guids file ${options.guidsFile} lists no bills; nothing was read`);
  return listed;
};

/** --text-recovery's rule: the newest text version has a Formatted XML URL and the raw bill has no text. */
const textRecoveryCandidate = (rawBill: RawBill): { xmlUrl?: string; hasText: boolean } => {
  const content = (rawBill as { content?: unknown }).content as Record<string, unknown> | undefined;
  const located = locateBillXmlUrl(content?.text);
  return { xmlUrl: located.url, hasText: extractRawBillXml(rawBill) !== "" };
};

/**
 * Read-only: reads every raw bill (or the listed ones) and selects those fetched before `cutoff`, or with
 * --text-recovery the listed ones that have a Formatted XML URL and no text.
 */
export const scanRawBills = async (
  s3: S3Sender,
  config: Pick<RefetchConfig, "bucket" | "rawPrefix">,
  options: Pick<CliOptions, "guids" | "guidsFile" | "congress" | "concurrency"> &
    Partial<Pick<CliOptions, "textRecovery">>,
  cutoff: string,
  { log = console.log, readFile }: { log?: Log; readFile: (path: string) => string | null },
): Promise<ScanResult> => {
  const listed = listedGuids(options, readFile);
  if (options.textRecovery && !listed) throw new Error("--text-recovery needs --guids-file or --guid");
  const congressPrefix = options.congress ? `BILLS-${options.congress}` : "";
  const keys = (
    listed
      ? listed.map((guid) => `${config.rawPrefix}${guid}.json`)
      : await listRawKeys(s3, config.bucket, `${config.rawPrefix}${congressPrefix}`)
  ).filter((key) => {
    // A key that is not a plain guid is kept, and reported as unsendable if it is stale.
    const parts = guidParts(key.slice(config.rawPrefix.length, -".json".length));
    return !options.congress || !parts || parts.congress === options.congress;
  });
  log(`Reading ${keys.length} raw bills under s3://${config.bucket}/${config.rawPrefix}`);

  const storage = new BillStorage(s3 as S3Client, config.bucket);
  const cutoffMs = Date.parse(cutoff);
  const result: ScanResult = {
    stale: [],
    fresh: 0,
    awaitingText: [],
    missing: [],
    unsendable: [],
    unreadable: [],
    scanned: 0,
  };
  await mapWithConcurrency(keys, options.concurrency, async (key) => {
    const guid = key.slice(config.rawPrefix.length, -".json".length);
    try {
      const rawBill = await storage.getJson<RawBill>(key);
      if (!rawBill) result.missing.push(guid);
      else if (options.textRecovery) {
        const candidate = textRecoveryCandidate(rawBill);
        if (candidate.hasText) result.fresh += 1;
        else if (!candidate.xmlUrl) result.awaitingText.push(guid);
        else {
          const built = refetchMessage(guid, rawBill);
          if (built.problem !== undefined) result.unsendable.push({ key, reason: built.problem });
          else {
            const stored = rawFetchedAt(rawBill);
            const fetchedAt = stored && !Number.isNaN(Date.parse(stored)) ? new Date(stored).toISOString() : null;
            result.stale.push({ key, guid, fetchedAt, message: built.message, xmlUrl: candidate.xmlUrl });
          }
        }
      } else {
        const stored = rawFetchedAt(rawBill);
        const fetchedMs = stored ? Date.parse(stored) : Number.NaN;
        if (!Number.isNaN(fetchedMs) && fetchedMs >= cutoffMs) result.fresh += 1;
        else {
          const built = refetchMessage(guid, rawBill);
          if (built.problem !== undefined) result.unsendable.push({ key, reason: built.problem });
          else {
            const fetchedAt = Number.isNaN(fetchedMs) ? null : new Date(fetchedMs).toISOString();
            result.stale.push({ key, guid, fetchedAt, message: built.message });
          }
        }
      }
    } catch (error) {
      result.unreadable.push({ key, error: error instanceof Error ? error.message : String(error) });
    }
    result.scanned += 1;
    if (result.scanned % 500 === 0) log(`Read ${result.scanned} / ${keys.length} raw bills...`);
  });
  result.stale.sort(byOldestFetch);
  result.awaitingText.sort();
  result.missing.sort();
  result.unsendable.sort((a, b) => (a.key < b.key ? -1 : 1));
  result.unreadable.sort((a, b) => (a.key < b.key ? -1 : 1));
  return result;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}/;
const dayOf = (value: unknown): string | null => {
  const text = toTrimmedString(value);
  return DAY_PATTERN.test(text) ? text.slice(0, 10) : null;
};

/**
 * The older GovInfo path's title: the bill's label, number and text version, then GovInfo's title of that version.
 * The spaces are &nbsp; as stored, or any space (\s takes U+00A0 too).
 */
const GOVINFO_TITLE = /^([A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]*)*)(?:&nbsp;|\s)+(\d+)(?:&nbsp;|\s)+\([A-Za-z]+\)\s+-\s/;

/**
 * REL-56: whether a stored title is in the form the older GovInfo path stored, as 26 to 31% of the raw bills fetched
 * before the congress.gov poller (2026-03-05) have it in two samples of 2026-11-09: "H.R.&nbsp;7264&nbsp;(IH) -
 * Restoring America's Floodplains Act", with this bill's own label and number (H.R., S., H. Res., S.J. Res., H. Con.
 * Res. ...). congress.gov's list gives such a bill the title without the prefix, or another title of the same text (its
 * official title, or a short title's acronym).
 */
export const isGovInfoTitle = (title: string, guid: string): boolean => {
  const parts = guidParts(guid);
  const match = title.trim().match(GOVINFO_TITLE);
  if (!parts || !match) return false;
  return match[1].replace(/[^A-Za-z]/g, "").toLowerCase() === parts.billType && match[2] === parts.billNumber;
};

/**
 * REL-56 (RUNBOOK 16.1): a stored bill's title against its list row's, which decides the title the backfill sends.
 * - none: the row has no title. The stored one is sent.
 * - govinfo: the stored title is in GovInfo's form (isGovInfoTitle). It is sent as stored: the list's title is no news
 *   for such a bill, and since the title is part of the text hash, it would re-summarize unchanged text and move the
 *   bill's manifest date (textVersion, 4.9). The bill's next update through the poller brings congress.gov's title.
 * - same: the row's title is the one the text hash reads (metadata.title, else content.bill.bill.title). The row's is
 *   sent, which changes nothing.
 * - differs: congress.gov retitled the bill since it was stored. The row's title is sent, as the poller sends it
 *   (FetchRawBill stores the message's title, and the app shows it): a re-summary when the bill has text (D5).
 */
export type TitleChange = "none" | "govinfo" | "same" | "differs";
export const titleChange = (rawBill: RawBill, row: Record<string, unknown>, guid: string): TitleChange => {
  const listTitle = toTrimmedString(row.title);
  if (listTitle === "") return "none";
  const metadata = (rawBill as { metadata?: { title?: unknown } } | null)?.metadata;
  if (isGovInfoTitle(storedString(metadata?.title), guid)) return "govinfo";
  return listTitle === extractRawBillTitle(rawBill) ? "same" : "differs";
};

/**
 * REL-56 (RUNBOOK 16.1, D5): whether refetching this stored bill will likely end in a re-summary
 * (summarize_text_changed), from what the scan already reads: the stored raw copy and the snapshot's list row. A
 * re-summary needs a new text hash, which covers the title and the bill text. So it is likely when:
 * - the refetch sends a new title (`titleChanges`) and the bill has text;
 * - the stored copy lists text versions but holds no text, which the refetch may get;
 * - or the row's latest action is dated after the newest stored text version (or there is none): a text version is
 *   dated by the action it came with, so a new one needs a later action.
 * It errs high. On BillDiffer's poller passes from 2026-10-28 to 11-09 with both raw versions still kept (86 passes on
 * processed bills), it flagged 29 for 14 re-summaries and missed none; where the copy before was 30 days old or more,
 * 16 for 11. A bill with no processed copy gets a first summary instead, which D3 leaves out of the cap.
 */
export const resummaryLikely = (rawBill: RawBill, row: Record<string, unknown>, titleChanges: boolean): boolean => {
  const content = (rawBill as { content?: unknown }).content as Record<string, unknown> | undefined;
  const hasText = extractRawBillXml(rawBill) !== "";
  if (titleChanges && hasText) return true;
  const textData = content?.text as { textVersions?: unknown } | undefined;
  const versions = Array.isArray(textData?.textVersions) ? (textData.textVersions as unknown[]) : [];
  if (versions.length > 0 && !hasText) return true;
  const newestText = versions
    .map((version) => dayOf((version as { date?: unknown } | null)?.date))
    .reduce<string>((newest, day) => (day && day > newest ? day : newest), "");
  const action = dayOf((row.latestAction as { actionDate?: unknown } | undefined)?.actionDate);
  return action !== null && action > newestText;
};

/**
 * REL-56, read-only: the snapshot's bills (narrowed by --guid, --guids-file and --congress, never widened), in its
 * order. A bill with no raw copy is selected with its list row's message; one whose raw copy was fetched at or after the
 * snapshot's listedAt is skipped (fetchedSince); any other is selected with its stored message, but with the title
 * titleChange decides (the list row's, unless the stored one is in GovInfo's form) and the row's description (its
 * latest action's text, as the poller sends it; BillSummarizer reads it, and it is not part of the text hash).
 */
export const scanSnapshot = async (
  s3: S3Sender,
  config: Pick<RefetchConfig, "bucket" | "rawPrefix">,
  options: Pick<CliOptions, "guids" | "guidsFile" | "congress" | "concurrency">,
  snapshot: ParsedSnapshot,
  { log = console.log, readFile }: { log?: Log; readFile: (path: string) => string | null },
): Promise<ScanResult> => {
  const listed = listedGuids(options, readFile);
  const inSnapshot = new Set(snapshot.entries.map((entry) => entry.guid));
  const entries = snapshot.entries.filter(
    (entry) =>
      (!listed || listed.includes(entry.guid)) &&
      (!options.congress || guidParts(entry.guid)?.congress === options.congress),
  );
  log(
    `Reading ${entries.length} of the snapshot's ${snapshot.entries.length} raw bills under s3://${config.bucket}/${config.rawPrefix}`,
  );
  const storage = new BillStorage(s3 as S3Client, config.bucket);
  const listedAtMs = Date.parse(snapshot.listedAt);
  type Read =
    | { kind: "selected"; bill: StaleBill }
    | { kind: "fetched_since"; guid: string }
    | { kind: "unsendable"; key: string; reason: string }
    | { kind: "unreadable"; key: string; error: string };
  let done = 0;
  const reads = await mapWithConcurrency(entries, options.concurrency, async (entry): Promise<Read> => {
    const key = `${config.rawPrefix}${entry.guid}.json`;
    try {
      const rawBill = await storage.getJson<RawBill>(key);
      if (!rawBill) {
        const built = billListRowMessage(entry.guid, entry.row);
        return built.problem !== undefined
          ? { kind: "unsendable", key, reason: built.problem }
          : {
              kind: "selected",
              bill: {
                key,
                guid: entry.guid,
                fetchedAt: null,
                message: { ...built.message, listedAt: snapshot.listedAt },
                neverStored: true,
              },
            };
      }
      const stored = rawFetchedAt(rawBill);
      const fetchedMs = stored ? Date.parse(stored) : Number.NaN;
      if (!Number.isNaN(fetchedMs) && fetchedMs >= listedAtMs) return { kind: "fetched_since", guid: entry.guid };
      const built = refetchMessage(entry.guid, rawBill);
      if (built.problem !== undefined) return { kind: "unsendable", key, reason: built.problem };
      const fetchedAt = Number.isNaN(fetchedMs) ? null : new Date(fetchedMs).toISOString();
      // The poller's message for the row (a row that names another bill gives nothing).
      const listed = toBillMessage(entry.row, built.message.billType, built.message.congress);
      const polled = listed?.guid === entry.guid ? listed : null;
      const change: TitleChange = polled ? titleChange(rawBill, entry.row, entry.guid) : "none";
      const message: UpdatedBillMessage = { ...built.message, listedAt: snapshot.listedAt };
      if (polled && change !== "none" && change !== "govinfo") message.title = polled.title;
      if (polled?.description) message.description = polled.description;
      return {
        kind: "selected",
        bill: {
          key,
          guid: entry.guid,
          fetchedAt,
          message,
          titleDiffers: change === "differs",
          titleGovInfo: change === "govinfo",
          resummaryLikely: resummaryLikely(rawBill, entry.row, change === "differs"),
        },
      };
    } catch (error) {
      return { kind: "unreadable", key, error: error instanceof Error ? error.message : String(error) };
    } finally {
      done += 1;
      if (done % 500 === 0) log(`Read ${done} / ${entries.length} raw bills...`);
    }
  });
  const result: ScanResult = {
    stale: [],
    fresh: 0,
    awaitingText: [],
    missing: [],
    unsendable: [],
    unreadable: [],
    scanned: entries.length,
    fetchedSince: [],
    notInSnapshot: listed ? listed.filter((guid) => !inSnapshot.has(guid)) : [],
  };
  for (const read of reads) {
    if (read.kind === "selected") result.stale.push(read.bill);
    else if (read.kind === "fetched_since") result.fetchedSince!.push(read.guid);
    else if (read.kind === "unsendable") result.unsendable.push({ key: read.key, reason: read.reason });
    else result.unreadable.push({ key: read.key, error: read.error });
  }
  result.fresh = result.fetchedSince!.length;
  return result;
};

/** Stale bills per congress, then per bill type. */
export const countByCongressAndType = (stale: readonly StaleBill[]): Record<string, Record<string, number>> => {
  const counts: Record<string, Record<string, number>> = {};
  for (const bill of stale) {
    const { congress, billType } = bill.message;
    counts[congress] ??= {};
    counts[congress][billType] = (counts[congress][billType] ?? 0) + 1;
  }
  return counts;
};

// ─── Estimate ────────────────────────────────────────────────────────────────

export interface Estimate {
  bills: number;
  calls: number;
  callsPerHour: number;
  hours: number;
  batchPerWindow: number;
  windows: number;
}

/** --unattended has no window: a batch is a run of --limit bills, and `windows` counts those runs. */
export const estimateRun = (
  bills: number,
  options: Pick<CliOptions, "perHour" | "limit" | "windowMinutes"> & Pick<Partial<CliOptions>, "unattended">,
): Estimate => {
  const batchPerWindow = options.unattended
    ? effectiveLimit(options)
    : Math.max(1, Math.min(effectiveLimit(options), Math.floor((options.perHour * options.windowMinutes) / 60)));
  return {
    bills,
    calls: bills * CONGRESS_CALLS_PER_BILL,
    callsPerHour: options.perHour * CONGRESS_CALLS_PER_BILL,
    hours: Math.round((bills / options.perHour) * 10) / 10,
    batchPerWindow,
    windows: Math.ceil(bills / batchPerWindow),
  };
};

// ─── Poller state (REL-39) ───────────────────────────────────────────────────

export interface PollerStateSummary {
  known: boolean;
  detail: string;
  /** The state's congress, when it is known. */
  congress?: string;
}

/** A one-line summary of the poller's SSM state; `known` is false when it is missing or does not parse. */
export const summarizePollerState = (value: string | undefined, now: Date): PollerStateSummary => {
  if (!value) return { known: false, detail: "the parameter is missing or empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { known: false, detail: `the parameter does not parse (${value.slice(0, 40)})` };
  }
  const state = parsed as {
    schemaVersion?: unknown;
    congress?: unknown;
    lastRunAt?: unknown;
    cursors?: Record<string, { lastUpdateAt?: unknown; watermark?: unknown; backlog?: unknown; resume?: unknown }>;
  };
  const lastRunMs = typeof state.lastRunAt === "string" ? Date.parse(state.lastRunAt) : Number.NaN;
  if (state.schemaVersion !== 1 || !state.cursors || typeof state.cursors !== "object" || Number.isNaN(lastRunMs)) {
    return { known: false, detail: "the parameter is not a version 1 poller state" };
  }
  const cursors = Object.entries(state.cursors);
  // REL-56: a cursor's watermark, or the lastUpdateAt of one written before it; a window the poller is reading over
  // several runs is its backlog (a REL-06 resume point before REL-56).
  const updates = cursors
    .map(([, cursor]) => cursor?.watermark ?? cursor?.lastUpdateAt)
    .map((at) => (typeof at === "string" ? at : ""))
    .filter((at) => !Number.isNaN(Date.parse(at)))
    .sort();
  const pending = cursors.filter(([, cursor]) => cursor?.backlog || cursor?.resume).map(([billType]) => billType);
  const minutesAgo = Math.round((now.getTime() - lastRunMs) / MINUTE_MS);
  return {
    known: true,
    congress: String(state.congress),
    detail:
      `congress=${String(state.congress)} lastRunAt=${new Date(lastRunMs).toISOString()} (${minutesAgo} min ago) ` +
      `cursors=${cursors.length} oldestCursor=${updates[0] ?? "none"} pendingBacklog=${pending.join(",") || "none"}`,
  };
};

// ─── AWS checks (read-only) ──────────────────────────────────────────────────

/** Runs `aws <args>` and resolves with its stdout. */
export type AwsCli = (args: readonly string[]) => Promise<string>;

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { maxBuffer: number },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

/** The AWS CLI with --region and JSON output; the CLI reads AWS_PROFILE itself. */
export const awsCliRunner =
  (region: string, run: ExecFileLike = execFile as unknown as ExecFileLike): AwsCli =>
  (args) =>
    new Promise((resolve, reject) => {
      run(
        "aws",
        [...args, "--region", region, "--output", "json"],
        { maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(`aws ${args.slice(0, 2).join(" ")} failed: ${String(stderr || error.message).trim()}`));
          else resolve(String(stdout));
        },
      );
    });

const cliJson = async <T>(cli: AwsCli, args: readonly string[]): Promise<T> => {
  const out = (await cli(args)).trim();
  return (out ? JSON.parse(out) : null) as T;
};

/** The EventBridge rules that target the poller's prod alias; throws when there is none. */
export const pollerRuleNames = async (
  awsCli: AwsCli,
  config: Pick<RefetchConfig, "pollerFunction" | "lambdaAlias">,
): Promise<string[]> => {
  const aliasArn = await cliJson<string>(awsCli, [
    "lambda",
    "get-alias",
    "--function-name",
    config.pollerFunction,
    "--name",
    config.lambdaAlias,
    "--query",
    "AliasArn",
  ]);
  const names =
    (await cliJson<string[] | null>(awsCli, [
      "events",
      "list-rule-names-by-target",
      "--target-arn",
      aliasArn,
      "--query",
      "RuleNames",
    ])) ?? [];
  if (names.length === 0) throw new Error(`No EventBridge rule targets ${config.pollerFunction}:${config.lambdaAlias}`);
  return names;
};

/** An EventBridge rule's State: ENABLED or DISABLED. */
export const ruleState = (awsCli: AwsCli, name: string): Promise<string> =>
  cliJson<string>(awsCli, ["events", "describe-rule", "--name", name, "--query", "State"]);

export type StopReason =
  | "dlq_message"
  | "fetch_errors"
  | "congress_key_errors"
  | "text_unavailable"
  | "too_many_summaries"
  | "window_closed"
  | "check_failed"
  // --unattended only (REL-56): the switches it depends on changed, a backfill change reached UserMatcher, or a
  // quiet window was opened.
  | "push_mode_changed"
  | "backfill_push_sent"
  | "carry_mode_changed"
  | "window_opened";

export interface CheckResult {
  stop: { reason: StopReason; detail: string } | null;
  backlog: number;
  /** --unattended: the visible messages of each queue the backlog pause reads. */
  backlogDetail?: string;
  /** Set when BillDifferEnqueued was above --max-summaries and BillDiffer's logs were read. */
  summaries?: SummaryCount;
}

export interface Precondition {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RunMetrics {
  fetchRawBillErrors: number;
  congressApi429: number;
  congressApiAuthFailures: number;
  /** BillDifferEnqueued: every BillDiffer pass that sent a bill to BillSummarizer, so a bill sent twice counts twice. */
  differEnqueued: number;
  /** REL-45: bills FetchRawBill stored without text although a Formatted XML URL existed. */
  billTextUnavailable: number;
  /** REL-58: FetchRawBillRecordFailed{Kind=other}: a record failure that is not congress.gov's (S3, a code error). */
  recordFailedOther: number;
  /** REL-58: FetchRawBillRecordFailed{Kind=unavailable}: a record that failed on congress.gov timeouts or 5xx. */
  recordFailedUnavailable: number;
}

/**
 * REL-58: unavailable record failures since the start that stop a run. A blip fails a record or two that store on
 * their next receive (2026-11-09: 2); an outage passes 10 within half an hour (2026-11-10: 11 by 14:45Z, 24 minutes
 * after the first). Failures FetchRawBill retries on its own (RUNBOOK 6.5); this stops the run sending into an outage.
 */
export const MAX_UNAVAILABLE_RECORD_FAILURES = 10;

/**
 * REL-58: the only stop for FetchRawBill's record failures since the start, in a window's run and in --unattended
 * (the poller's records count too, as for Errors): any of Kind other (not congress.gov's: S3, a code error, a 4xx, a
 * 404 that outlasted its retries), or MAX_UNAVAILABLE_RECORD_FAILURES of Kind unavailable. A not_found within its
 * retries is detail lag and counts as neither. Throttled ones are not counted here: a throttled failure follows a 429,
 * and FetchRawBill counts CongressApi429 on every 429, so stopOnMetrics stops the run on the 429 itself
 * (congress_key_errors, whose cue is to wait an hour) unless an earlier rule stopped it.
 */
export const recordFailureStop = (metrics: RunMetrics): { reason: StopReason; detail: string } | null => {
  if (metrics.recordFailedOther > 0) {
    return {
      reason: "fetch_errors",
      detail: `FetchRawBillRecordFailed{Kind=other}=${metrics.recordFailedOther} since the start`,
    };
  }
  if (metrics.recordFailedUnavailable >= MAX_UNAVAILABLE_RECORD_FAILURES) {
    return {
      reason: "fetch_errors",
      detail:
        `FetchRawBillRecordFailed{Kind=unavailable}=${metrics.recordFailedUnavailable} since the start ` +
        `(the limit is ${MAX_UNAVAILABLE_RECORD_FAILURES})`,
    };
  }
  return null;
};

/**
 * The stops both modes read from the metrics since the start, in order: FetchRawBill Errors (an invocation that
 * failed), its record failures (recordFailureStop, REL-58), a congress.gov 429 or key refusal, and a bill stored
 * without text (REL-45: a refetch that leaves bills without text strips what they had). The summary cap is each mode's.
 */
export const stopOnMetrics = (
  metrics: RunMetrics,
  fetchRawBillFunction: string,
): { reason: StopReason; detail: string } | null => {
  if (metrics.fetchRawBillErrors > 0) {
    return {
      reason: "fetch_errors",
      detail: `${fetchRawBillFunction} Errors=${metrics.fetchRawBillErrors} since the start`,
    };
  }
  const recordFailures = recordFailureStop(metrics);
  if (recordFailures) return recordFailures;
  if (metrics.congressApi429 > 0 || metrics.congressApiAuthFailures > 0) {
    return {
      reason: "congress_key_errors",
      detail: `CongressApi429=${metrics.congressApi429} CongressApiAuthFailure=${metrics.congressApiAuthFailures} since the start`,
    };
  }
  if (metrics.billTextUnavailable > 0) {
    return {
      reason: "text_unavailable",
      detail: `BillTextUnavailable=${metrics.billTextUnavailable} since the start (RUNBOOK 4.10)`,
    };
  }
  return null;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One row of ENQUEUED_DIFFS_QUERY: a raw bill key BillDiffer enqueued, in one invocation, and the plan's reason. */
export interface EnqueuedDiff {
  key: string | null;
  requestId: string | null;
  reason?: string | null;
}

/** What --max-summaries is held against once BillDifferEnqueued is above it. */
export interface SummaryCount {
  /** BillDifferEnqueued since the start: every pass, so a bill enqueued twice counts twice. */
  passes: number;
  /** Distinct raw bill keys in BillDiffer's "Diffed raw bill" lines with outcome enqueued (a row with no key, one each). */
  inLogs: number;
  /** BillDifferEnqueued the logs do not show yet (passes minus enqueue rows), each counted as one more bill. */
  unseen: number;
  /** inLogs + unseen: the bills held against --max-summaries. */
  bills: number;
  /**
   * --snapshot-file (D3): distinct keys of bills the backfill sent whose every pass in the logs is a first summary
   * (reason no_processed), so expected and not counted.
   */
  expected?: number;
  /** --unattended: counted from the backfill's own rows only (countBackfillResummaries), no unseen passes. */
  backfillOnly?: true;
}

/**
 * The summary cap's bills: the distinct keys BillDiffer logged as enqueued, plus one for each BillDifferEnqueued the
 * logs do not show yet. A slow or broken log query can only raise the count (up to the passes), never lower it.
 * `sentKeys` (--snapshot-file, decision D3): raw keys of the bills the backfill sent, in this run or an earlier one
 * (the progress file). A pass that is a first summary of one of them (reason no_processed: no processed copy, whether
 * the bill was never stored or stored without one) is expected and not counted. A key counts when any of its passes
 * is not: a re-summary (text_changed), a reason missing, a bill the backfill did not send. A row without a key, and a
 * pass not in the logs, still counts.
 */
export const countSummarizedBills = (
  passes: number,
  diffs: readonly EnqueuedDiff[],
  sentKeys?: ReadonlySet<string>,
): SummaryCount => {
  const counted = new Set<string>();
  const expectedOnly = new Set<string>();
  const passRows = new Set<string>();
  let keyless = 0;
  diffs.forEach((diff, index) => {
    // One pass per raw bill and invocation, whatever its rows say.
    passRows.add(diff.key && diff.requestId ? `${diff.key}\u0000${diff.requestId}` : `#${index}`);
    if (!diff.key) {
      keyless += 1;
      return;
    }
    if (sentKeys?.has(diff.key) && diff.reason === FIRST_SUMMARY_REASON) expectedOnly.add(diff.key);
    else counted.add(diff.key);
  });
  for (const key of counted) expectedOnly.delete(key);
  const inLogs = counted.size + keyless;
  const unseen = Math.max(0, passes - passRows.size);
  return { passes, inLogs, unseen, bills: inLogs + unseen, ...(sentKeys ? { expected: expectedOnly.size } : {}) };
};

/**
 * --unattended: the bills held against --max-summaries, from BACKFILL_RESUMMARIES_QUERY's rows only (the backfill's
 * passes other than first summaries): distinct keys, and a row with no key as its own bill. BillDifferEnqueued counts
 * every pass, the poller's and the first summaries too, so it only says when to read the logs: a pass not in them yet
 * is counted at a later check.
 */
export const countBackfillResummaries = (passes: number, diffs: readonly EnqueuedDiff[]): SummaryCount => {
  const keys = new Set<string>();
  let keyless = 0;
  for (const diff of diffs) {
    if (diff.key) keys.add(diff.key);
    else keyless += 1;
  }
  const bills = keys.size + keyless;
  return { passes, inLogs: bills, unseen: 0, bills, backfillOnly: true };
};

const expectedNote = (summaries: SummaryCount): string =>
  summaries.expected ? `, not counting ${summaries.expected} first summaries of bills the backfill sent (D3)` : "";

/** The metric reads' time range: from the start floored to the minute, to the minute after the next. */
const metricRange = (since: Date, now: Date): { startTime: Date; endTime: Date } => ({
  startTime: new Date(Math.floor(since.getTime() / MINUTE_MS) * MINUTE_MS),
  endTime: new Date(Math.ceil((now.getTime() + MINUTE_MS) / MINUTE_MS) * MINUTE_MS),
});

/** Every AWS read the run makes, with queue URLs, ARNs and rule names resolved once. */
export class AwsChecks {
  private readonly queueUrls = new Map<string, string>();
  private notificationTypeQueueArn: string | null = null;
  private pollerRules: string[] | null = null;

  constructor(
    private readonly deps: {
      sqs: QueueSender;
      cloudwatch: MetricsReader;
      ssm: ParameterReader;
      awsCli: AwsCli;
      config: RefetchConfig;
      now: () => Date;
      /** Between Logs Insights polls; defaults to a timer. */
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  async queueUrl(name: string): Promise<string> {
    const { config, sqs } = this.deps;
    if (name === config.updatedBillsQueueName && config.updatedBillsQueueUrl) return config.updatedBillsQueueUrl;
    const known = this.queueUrls.get(name);
    if (known) return known;
    const response = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!response.QueueUrl) throw new Error(`Queue ${name} not found`);
    this.queueUrls.set(name, response.QueueUrl);
    return response.QueueUrl;
  }

  private async queueAttributes(name: string, names: QueueAttributeName[]): Promise<Record<string, string>> {
    const response = await this.deps.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: await this.queueUrl(name), AttributeNames: names }),
    );
    return response.Attributes ?? {};
  }

  /** Messages in each watched DLQ (visible, in flight and delayed). */
  async dlqDepths(): Promise<Array<{ name: string; messages: number }>> {
    const depths: Array<{ name: string; messages: number }> = [];
    for (const name of this.deps.config.dlqNames) {
      const attributes = await this.queueAttributes(name, [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
      ]);
      const messages = Object.values(attributes).reduce((sum, value) => sum + (Number(value) || 0), 0);
      depths.push({ name, messages });
    }
    return depths;
  }

  /** Visible messages waiting on UpdatedBillsQueue. */
  async backlog(): Promise<number> {
    return this.visibleMessages(this.deps.config.updatedBillsQueueName);
  }

  /** --unattended: visible messages waiting on BillSummarizerQueue (a Bedrock slowdown backs it up). */
  async summarizerBacklog(): Promise<number> {
    return this.visibleMessages(this.deps.config.billSummarizerQueueName);
  }

  private async visibleMessages(queueName: string): Promise<number> {
    const attributes = await this.queueAttributes(queueName, ["ApproximateNumberOfMessages"]);
    return Number(attributes.ApproximateNumberOfMessages ?? 0) || 0;
  }

  /** FetchRawBill:prod's MEMBER_VOTE_CARRY_MODE, or null when the variable is not set (the carry is not deployed). */
  async carryMode(): Promise<string | null> {
    const { config, awsCli } = this.deps;
    return cliJson<string | null>(awsCli, [
      "lambda",
      "get-function-configuration",
      "--function-name",
      `${config.fetchRawBillFunction}:${config.lambdaAlias}`,
      "--query",
      "Environment.Variables.MEMBER_VOTE_CARRY_MODE",
    ]);
  }

  /** NotificationType:prod's BACKFILL_PUSH_MODE, or null when the variable is not set (the skip is not deployed). */
  async backfillPushMode(): Promise<string | null> {
    const { config, awsCli } = this.deps;
    return cliJson<string | null>(awsCli, [
      "lambda",
      "get-function-configuration",
      "--function-name",
      `${config.notificationTypeFunction}:${config.lambdaAlias}`,
      "--query",
      "Environment.Variables.BACKFILL_PUSH_MODE",
    ]);
  }

  /**
   * Open when every NotificationTypeQueue mapping is Disabled and every poller rule is DISABLED (RUNBOOK 4.1); closed
   * (--unattended) when every mapping is Enabled and every rule ENABLED. Anything between is neither.
   */
  async windowState(): Promise<{ open: boolean; closed: boolean; detail: string }> {
    const { config, awsCli } = this.deps;
    if (!this.notificationTypeQueueArn) {
      const arn = (await this.queueAttributes(config.notificationTypeQueueName, ["QueueArn"])).QueueArn;
      if (!arn) throw new Error(`${config.notificationTypeQueueName} has no QueueArn`);
      this.notificationTypeQueueArn = arn;
    }
    const arn = this.notificationTypeQueueArn;
    const mappings =
      (await cliJson<Array<{ uuid: string; state: string }> | null>(awsCli, [
        "lambda",
        "list-event-source-mappings",
        "--event-source-arn",
        arn,
        "--query",
        "EventSourceMappings[].{uuid: UUID, state: State}",
      ])) ?? [];
    this.pollerRules ??= await pollerRuleNames(awsCli, config);
    const rules: Array<{ name: string; state: string }> = [];
    for (const name of this.pollerRules) rules.push({ name, state: await ruleState(awsCli, name) });
    const open =
      mappings.length > 0 &&
      mappings.every((mapping) => mapping.state === "Disabled") &&
      rules.every((rule) => rule.state === "DISABLED");
    const closed =
      mappings.length > 0 &&
      mappings.every((mapping) => mapping.state === "Enabled") &&
      rules.every((rule) => rule.state === "ENABLED");
    const detail = [
      mappings.length === 0
        ? `no ${config.notificationTypeQueueName} mapping found`
        : mappings
            .map((mapping) => `${config.notificationTypeQueueName} mapping ${mapping.uuid} ${mapping.state}`)
            .join(", "),
      rules.map((rule) => `poller rule ${rule.name} ${rule.state}`).join(", "),
    ].join("; ");
    return { open, closed, detail };
  }

  async pollerState(): Promise<PollerStateSummary> {
    try {
      const response = await this.deps.ssm.send(
        new GetParameterCommand({ Name: this.deps.config.pollerStateParameter }),
      );
      return summarizePollerState(response.Parameter?.Value, this.deps.now());
    } catch (error) {
      return { known: false, detail: `unreadable: ${errorText(error)}` };
    }
  }

  /** Sums since `since` (floored to the minute) of the metrics the stop conditions watch. */
  async metricsSince(since: Date): Promise<RunMetrics> {
    const { config, cloudwatch, now } = this.deps;
    const ingestion = "BillBoard/BillIngestion";
    const query = (id: keyof RunMetrics, namespace: string, name: string, dimensions?: Record<string, string>) =>
      ({
        Id: id,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: namespace,
            MetricName: name,
            ...(dimensions ? { Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })) } : {}),
          },
          Period: 60,
          Stat: "Sum",
        },
      }) satisfies MetricDataQuery;
    const queries = [
      query("fetchRawBillErrors", "AWS/Lambda", "Errors", { FunctionName: config.fetchRawBillFunction }),
      query("congressApi429", ingestion, "CongressApi429"),
      query("congressApiAuthFailures", ingestion, "CongressApiAuthFailure"),
      query("differEnqueued", ingestion, "BillDifferEnqueued"),
      query("billTextUnavailable", ingestion, "BillTextUnavailable"),
      query("recordFailedOther", ingestion, "FetchRawBillRecordFailed", { Kind: "other" }),
      query("recordFailedUnavailable", ingestion, "FetchRawBillRecordFailed", { Kind: "unavailable" }),
    ];
    const totals: RunMetrics = {
      fetchRawBillErrors: 0,
      congressApi429: 0,
      congressApiAuthFailures: 0,
      differEnqueued: 0,
      billTextUnavailable: 0,
      recordFailedOther: 0,
      recordFailedUnavailable: 0,
    };
    const { startTime, endTime } = metricRange(since, now());
    let nextToken: string | undefined;
    do {
      const response = await cloudwatch.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: startTime,
          EndTime: endTime,
          NextToken: nextToken,
        }),
      );
      for (const result of response.MetricDataResults ?? []) {
        const id = result.Id as keyof RunMetrics;
        if (id in totals) totals[id] += (result.Values ?? []).reduce((sum, value) => sum + value, 0);
      }
      nextToken = response.NextToken;
    } while (nextToken);
    return totals;
  }

  /**
   * BillDiffer's enqueues since `since` (floored to the minute, as the metrics), one per raw bill and invocation,
   * from a Logs Insights query on its log group. Throws when the query cannot start, fails, or does not complete.
   */
  async enqueuedDiffsSince(since: Date): Promise<EnqueuedDiff[]> {
    return (await this.logsQuery(this.deps.config.billDifferLogGroup, since, ENQUEUED_DIFFS_QUERY)).map((value) => ({
      key: value("key"),
      requestId: value("awsRequestId"),
      reason: value("reason"),
    }));
  }

  /** --unattended: BACKFILL_RESUMMARIES_QUERY's rows since `since`, as enqueuedDiffsSince reads them. */
  async backfillResummariesSince(since: Date): Promise<EnqueuedDiff[]> {
    return (await this.logsQuery(this.deps.config.billDifferLogGroup, since, BACKFILL_RESUMMARIES_QUERY)).map(
      (value) => ({ key: value("key"), requestId: value("awsRequestId"), reason: value("reason") }),
    );
  }

  /** --unattended: UserMatcher's lines with a rel56: correlation id since `since` (BACKFILL_PUSHES_QUERY). */
  async backfillPushesSince(since: Date): Promise<number> {
    const rows = await this.logsQuery(this.deps.config.userMatcherLogGroup, since, BACKFILL_PUSHES_QUERY);
    return rows.reduce((sum, value) => sum + (Number(value("lines")) || 0), 0);
  }

  /**
   * One Logs Insights query on `group` from `since` (floored to the minute, as the metrics) to now, polled until it
   * completes; each row as a field reader. Throws when the query cannot start, fails, or does not complete.
   */
  private async logsQuery(
    group: string,
    since: Date,
    queryString: string,
  ): Promise<Array<(field: string) => string | null>> {
    const { awsCli, now } = this.deps;
    const sleep = this.deps.sleep ?? defaultSleep;
    const { startTime } = metricRange(since, now());
    const queryId = await cliJson<string | null>(awsCli, [
      "logs",
      "start-query",
      "--log-group-name",
      group,
      "--start-time",
      String(Math.floor(startTime.getTime() / 1000)),
      "--end-time",
      String(Math.ceil(now().getTime() / 1000)),
      "--query-string",
      queryString,
      "--query",
      "queryId",
    ]);
    if (!queryId) throw new Error(`Logs Insights gave no query id for ${group}`);
    for (let poll = 1; poll <= LOGS_QUERY_MAX_POLLS; poll += 1) {
      await sleep(LOGS_QUERY_POLL_MS);
      const response = await cliJson<{
        status?: string;
        results?: Array<Array<{ field?: string; value?: string }>>;
      } | null>(awsCli, ["logs", "get-query-results", "--query-id", queryId]);
      const status = response?.status;
      if (status === "Complete") {
        return (response?.results ?? []).map(
          (row) => (field: string) => row.find((cell) => cell.field === field)?.value || null,
        );
      }
      if (status !== "Scheduled" && status !== "Running") {
        throw new Error(`The Logs Insights query on ${group} ended ${status ?? "without a status"}`);
      }
    }
    throw new Error(
      `The Logs Insights query on ${group} did not complete in ${(LOGS_QUERY_MAX_POLLS * LOGS_QUERY_POLL_MS) / 1000} s`,
    );
  }

  /**
   * The --apply preconditions, each read-only; a check that throws fails. With `waiveCarry` (--text-recovery) the
   * X7 check passes whatever MEMBER_VOTE_CARRY_MODE is, and says so. With `snapshot` (--snapshot-file, REL-56), the
   * snapshot's congress must be the poller state's and the primary one, and the time before BACKFILL_DEADLINE. With
   * `unattended` (REL-56), no quiet window may be open and NotificationType:prod must skip the backfill's pushes,
   * instead of the window being open.
   */
  async preconditions(
    waiveCarry = false,
    snapshot?: { congress: string },
    unattended = false,
  ): Promise<Precondition[]> {
    const { config } = this.deps;
    const results: Precondition[] = [];
    const check = async (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => {
      try {
        results.push({ name, ...(await run()) });
      } catch (error) {
        results.push({ name, ok: false, detail: `check failed: ${errorText(error)}` });
      }
    };
    await check("member vote carry on (X7)", async () => {
      const target = `${config.fetchRawBillFunction}:${config.lambdaAlias}`;
      if (waiveCarry) {
        const mode = await this.carryMode().catch((error: unknown) => `unread (${errorText(error)})`);
        return { ok: true, detail: `${target} MEMBER_VOTE_CARRY_MODE=${mode ?? "unset"}; waived for --text-recovery` };
      }
      const mode = await this.carryMode();
      if (mode === "on") return { ok: true, detail: `${target} MEMBER_VOTE_CARRY_MODE=on` };
      return {
        ok: false,
        detail:
          mode === null
            ? `${target} has no MEMBER_VOTE_CARRY_MODE (the carry is not deployed)`
            : `${target} MEMBER_VOTE_CARRY_MODE=${mode}; flip it to on first (X7)`,
      };
    });
    if (unattended) {
      await check("no quiet window open (unattended, RUNBOOK 16.1)", async () =>
        this.windowState().then(({ closed, detail }) => ({ ok: closed, detail })),
      );
      await check("NotificationType skips the backfill's pushes (REL-56)", async () => this.pushModeCheck());
    } else {
      await check("quiet window open (RUNBOOK 4.1)", async () =>
        this.windowState().then(({ open, detail }) => ({ ok: open, detail })),
      );
    }
    await check("watched DLQs empty", async () => {
      const depths = await this.dlqDepths();
      const full = depths.filter((depth) => depth.messages > 0);
      return {
        ok: full.length === 0,
        detail:
          full.length === 0
            ? `${depths.length} empty`
            : full.map((depth) => `${depth.name}=${depth.messages}`).join(" "),
      };
    });
    await check("poller state known (REL-39)", async () => {
      const state = await this.pollerState();
      return { ok: state.known, detail: state.detail };
    });
    if (snapshot) {
      // The backfill sends a trailing Congress's bills without its outcome gate (REL-46): only the primary's.
      await check("snapshot congress is the poller's and the primary (REL-46)", async () => {
        const state = await this.pollerState();
        const primary = primaryCongressAt(this.deps.now().getTime());
        return {
          ok: state.known && state.congress === snapshot.congress && primary === snapshot.congress,
          detail: `snapshot congress=${snapshot.congress} poller state congress=${state.congress ?? "unknown"} primary=${primary}`,
        };
      });
      await check("before the 2026-12-28 freeze (RUNBOOK 24.1)", async () => {
        const at = this.deps.now().toISOString();
        const ok = Date.parse(at) < Date.parse(BACKFILL_DEADLINE);
        return {
          ok,
          detail: ok
            ? `${at}; no send after ${BACKFILL_DEADLINE}`
            : `${at} is on or after ${BACKFILL_DEADLINE}: no quiet window from then; leftovers come in with their next update`,
        };
      });
    }
    return results;
  }

  /**
   * The stop conditions, then UpdatedBillsQueue's backlog. Any check that throws stops the run. `sentKeys`
   * (--snapshot-file): the raw keys of the bills the backfill sent; their first summaries are left out of the cap (D3).
   */
  async run(since: Date, maxSummaries: number, sentKeys?: ReadonlySet<string>): Promise<CheckResult> {
    try {
      const full = (await this.dlqDepths()).filter((depth) => depth.messages > 0);
      if (full.length > 0) {
        const detail = full.map((depth) => `${depth.name}=${depth.messages}`).join(" ");
        return { stop: { reason: "dlq_message", detail }, backlog: 0 };
      }
      const metrics = await this.metricsSince(since);
      const metricStop = stopOnMetrics(metrics, this.deps.config.fetchRawBillFunction);
      if (metricStop) return { stop: metricStop, backlog: 0 };
      // The cap counts bills, not passes; the passes bound the bills, so the logs are read only above it.
      let summaries: SummaryCount | undefined;
      if (metrics.differEnqueued > maxSummaries) {
        summaries = countSummarizedBills(metrics.differEnqueued, await this.enqueuedDiffsSince(since), sentKeys);
        if (summaries.bills > maxSummaries) {
          const detail =
            `${summaries.bills} bills sent to BillSummarizer since the start (limit ${maxSummaries}): ` +
            `${summaries.inLogs} in BillDiffer's "Diffed raw bill" lines with outcome enqueued` +
            `${summaries.unseen > 0 ? ` plus ${summaries.unseen} BillDifferEnqueued not in the logs yet` : ""}` +
            `${expectedNote(summaries)}; BillDifferEnqueued=${summaries.passes}`;
          return { stop: { reason: "too_many_summaries", detail }, backlog: 0, summaries };
        }
      }
      const window = await this.windowState();
      if (!window.open) return { stop: { reason: "window_closed", detail: window.detail }, backlog: 0 };
      return { stop: null, backlog: await this.backlog(), ...(summaries ? { summaries } : {}) };
    } catch (error) {
      return { stop: { reason: "check_failed", detail: errorText(error) }, backlog: 0 };
    }
  }

  /** --unattended: BACKFILL_PUSH_MODE must read skip on NotificationType:prod. */
  private async pushModeCheck(): Promise<{ ok: boolean; detail: string }> {
    const { config } = this.deps;
    const target = `${config.notificationTypeFunction}:${config.lambdaAlias}`;
    const mode = await this.backfillPushMode();
    if (mode === "skip") return { ok: true, detail: `${target} BACKFILL_PUSH_MODE=skip` };
    return {
      ok: false,
      detail:
        mode === null
          ? `${target} has no BACKFILL_PUSH_MODE (the skip is not deployed)`
          : `${target} BACKFILL_PUSH_MODE=${mode}; the backfill's changes would push`,
    };
  }

  /**
   * --unattended (REL-56): the stop conditions of `run`, without the window, plus what running without one relies on:
   * NotificationType:prod still skips, no backfill change reached UserMatcher, the carry is still on, and no window was
   * opened. The summary cap counts the backfill's re-summaries only (countBackfillResummaries); `limitNote` says how
   * `maxSummaries` was reached when it is held as the run goes (D5 b). Then the backlog: the larger of
   * UpdatedBillsQueue's and BillSummarizerQueue's visible messages. Any check that throws stops the run.
   */
  async runUnattended(since: Date, maxSummaries: number, limitNote?: string): Promise<CheckResult> {
    const { config } = this.deps;
    const stop = (reason: StopReason, detail: string): CheckResult => ({ stop: { reason, detail }, backlog: 0 });
    try {
      const pushMode = await this.backfillPushMode();
      if (pushMode !== "skip") {
        return stop(
          "push_mode_changed",
          `${config.notificationTypeFunction}:${config.lambdaAlias} BACKFILL_PUSH_MODE=${pushMode ?? "unset"}; ` +
            "the backfill's changes would push",
        );
      }
      const pushed = await this.backfillPushesSince(since);
      if (pushed > 0) {
        return stop(
          "backfill_push_sent",
          `${pushed} UserMatcher log lines with a rel56: correlation id since the start: a backfill change reached the push path`,
        );
      }
      const full = (await this.dlqDepths()).filter((depth) => depth.messages > 0);
      if (full.length > 0) {
        return stop("dlq_message", full.map((depth) => `${depth.name}=${depth.messages}`).join(" "));
      }
      const metrics = await this.metricsSince(since);
      const metricStop = stopOnMetrics(metrics, config.fetchRawBillFunction);
      if (metricStop) return { stop: metricStop, backlog: 0 };
      let summaries: SummaryCount | undefined;
      if (metrics.differEnqueued > maxSummaries) {
        summaries = countBackfillResummaries(metrics.differEnqueued, await this.backfillResummariesSince(since));
        if (summaries.bills > maxSummaries) {
          return {
            ...stop(
              "too_many_summaries",
              `${summaries.bills} bills the backfill sent were re-summarized since the start ` +
                `(limit ${maxSummaries}${limitNote ? `: ${limitNote}` : ""}): ` +
                `the distinct keys of BillDiffer's "Diffed raw bill" lines with outcome enqueued, a rel56: correlation id ` +
                `and a reason other than ${FIRST_SUMMARY_REASON} (first summaries do not count, D3; the poller's passes ` +
                `are not the backfill's). BillDifferEnqueued=${summaries.passes} counts every pass`,
            ),
            summaries,
          };
        }
      }
      const carry = await this.carryMode();
      if (carry !== "on") {
        return stop(
          "carry_mode_changed",
          `${config.fetchRawBillFunction}:${config.lambdaAlias} MEMBER_VOTE_CARRY_MODE=${carry ?? "unset"}; ` +
            "a refetch would drop enriched member votes (X7)",
        );
      }
      const window = await this.windowState();
      if (!window.closed) return stop("window_opened", window.detail);
      const updated = await this.backlog();
      const summarizer = await this.summarizerBacklog();
      return {
        stop: null,
        backlog: Math.max(updated, summarizer),
        backlogDetail: `${config.updatedBillsQueueName} holds ${updated} and ${config.billSummarizerQueueName} ${summarizer} messages`,
        ...(summaries ? { summaries } : {}),
      };
    } catch (error) {
      return stop("check_failed", errorText(error));
    }
  }
}

/**
 * --unattended: the end of the Sunday 09:30 to 11:00 New York time slot `at` falls in, else null. GenerateWeeklyDigests
 * builds the weekly digest at 10:00 (RUNBOOK 11.4), and no backfill window ran across it (16, 16.1); the run pauses
 * instead.
 */
export const weeklyDigestPauseEnd = (at: Date): Date | null => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((each) => each.type === type)?.value ?? "";
  if (part("weekday") !== "Sun") return null;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  if (minute < 9 * 60 + 30 || minute >= 11 * 60) return null;
  const msToEnd = ((11 * 60 - minute) * 60 - Number(part("second"))) * 1000 - at.getUTCMilliseconds();
  return new Date(at.getTime() + msToEnd);
};

// ─── The run ─────────────────────────────────────────────────────────────────

export type RunOutcome =
  | "dry_run"
  | "refused"
  | "done"
  | "batch_limit"
  | "window_time"
  | "send_failed"
  // --unattended: 2026-12-28T00:00Z was reached, or Ctrl-C (the same command resumes either).
  | "deadline"
  | "interrupted"
  | `stopped_${StopReason}`;

export interface RunDeps {
  s3: S3Sender;
  sqs: QueueSender;
  cloudwatch: MetricsReader;
  ssm: ParameterReader;
  awsCli: AwsCli;
  config: RefetchConfig;
  options: CliOptions;
  log?: Log;
  logError?: Log;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The file's text, or null when it does not exist. */
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, text: string) => void;
  appendFile?: (path: string, text: string) => void;
  /** --predict's GET (GovInfo); defaults to fetch with FetchRawBill's User-Agent, no redirects followed. */
  httpGet?: (url: string) => Promise<HttpTextResponse>;
  /** --unattended: true once Ctrl-C (SIGINT or SIGTERM) asked the run to stop after the send in hand. */
  interrupted?: () => boolean;
}

export interface RunResult {
  exitCode: 0 | 1 | 2;
  outcome: RunOutcome;
  cutoff: string;
  preconditions: Precondition[];
  scan: ScanResult | null;
  alreadySent: number;
  eligible: number;
  sentGuids: string[];
  stop: { reason: StopReason; detail: string } | null;
  /** --predict's counts. */
  prediction?: Prediction;
  /** --unattended --apply: the cap the run held re-summaries to (given, or resummaries_likely + 5). */
  maxSummaries?: number;
  /** --unattended --apply: bills not sent because their raw copy was stored since the snapshot's listedAt. */
  skippedSinceSnapshot?: string[];
}

const defaultReadFile = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** Listed by guid in the report, at most this many. */
const MAX_LISTED_GUIDS = 50;

const printScanReport = (
  scan: ScanResult,
  sentStillStale: StaleBill[],
  eligible: StaleBill[],
  log: Log,
  textRecovery = false,
): void => {
  const noFetchedAt = scan.stale.filter((bill) => bill.fetchedAt === null).length;
  if (textRecovery) {
    log(
      `read=${scan.scanned} selected=${scan.stale.length} (a Formatted XML URL and no text) has_text=${scan.fresh} ` +
        `awaiting_text=${scan.awaitingText.length}`,
    );
    if (scan.awaitingText.length > 0) log(`  no Formatted XML yet (not selected): ${scan.awaitingText.join(", ")}`);
  } else {
    log(`read=${scan.scanned} stale=${scan.stale.length} (no fetchedAt ${noFetchedAt}) fresh=${scan.fresh}`);
  }
  const counts = countByCongressAndType(scan.stale);
  for (const congress of Object.keys(counts).sort()) {
    const types = Object.entries(counts[congress]).sort(([a], [b]) => (a < b ? -1 : 1));
    const total = types.reduce((sum, [, count]) => sum + count, 0);
    log(`  congress ${congress}: ${types.map(([type, count]) => `${type}=${count}`).join(" ")} total=${total}`);
  }
  const oldest = scan.stale.find((bill) => bill.fetchedAt !== null);
  if (oldest) log(`oldest fetch: ${oldest.fetchedAt} (${oldest.guid})`);
  log(`to send: ${eligible.length}; already sent (progress file) and still stale: ${sentStillStale.length}`);
  if (sentStillStale.length > 0) {
    // In flight, or FetchRawBill failed them: check the DLQs. A rerun skips them until their line is deleted.
    const listed = sentStillStale.slice(0, MAX_LISTED_GUIDS).map((bill) => bill.guid);
    const more =
      sentStillStale.length > MAX_LISTED_GUIDS ? ` and ${sentStillStale.length - MAX_LISTED_GUIDS} more` : "";
    log(`  sent but still stale: ${listed.join(", ")}${more}`);
  }
  if (scan.missing.length > 0) log(`missing (${scan.missing.length}): ${scan.missing.join(", ")}`);
  if (scan.unsendable.length > 0) {
    log(
      `unsendable (${scan.unsendable.length}): ${scan.unsendable.map((entry) => `${entry.key} (${entry.reason})`).join(", ")}`,
    );
  }
  if (scan.unreadable.length > 0) {
    log(
      `unreadable (${scan.unreadable.length}): ${scan.unreadable.map((entry) => `${entry.key} (${entry.error})`).join(", ")}`,
    );
  }
};

/**
 * REL-56 (D5): the next batch's likely re-summaries, all of the bills to send, the titles the run changes and the
 * GovInfo-form titles it keeps.
 */
export const resummaryForecast = (
  eligible: readonly StaleBill[],
  batchSize: number,
): { batch: number; likelyBatch: number; likelyAll: number; titlesDiffer: number; titlesGovInfo: number } => {
  const batch = eligible.slice(0, batchSize);
  return {
    batch: batch.length,
    likelyBatch: batch.filter((bill) => bill.resummaryLikely).length,
    likelyAll: eligible.filter((bill) => bill.resummaryLikely).length,
    titlesDiffer: eligible.filter((bill) => bill.titleDiffers).length,
    titlesGovInfo: eligible.filter((bill) => bill.titleGovInfo).length,
  };
};

const forecastLine = (forecast: ReturnType<typeof resummaryForecast>, total: number, maxSummaries: number): string =>
  `Re-summaries likely: ${forecast.likelyBatch} in the next batch of ${forecast.batch} (${forecast.likelyAll} of the ` +
  `${total} bills to send); a forecast that errs high, against --max-summaries ${maxSummaries} (RUNBOOK 16.1, D5).`;

/** REL-56: what a --snapshot-file run selected, skipped and has left to send. */
const printSnapshotReport = (
  scan: ScanResult,
  sentStillStale: StaleBill[],
  eligible: StaleBill[],
  snapshot: ParsedSnapshot,
  log: Log,
): void => {
  const missing = scan.stale.filter((bill) => bill.neverStored).length;
  const classes = new Map<string, number>();
  const selected = new Set(scan.stale.map((bill) => bill.guid));
  for (const entry of snapshot.entries) {
    if (selected.has(entry.guid)) classes.set(entry.cls, (classes.get(entry.cls) ?? 0) + 1);
  }
  log(
    `read=${scan.scanned} selected=${scan.stale.length} (never stored ${missing}, stored ${scan.stale.length - missing}) ` +
      `fetched_since=${scan.fetchedSince?.length ?? 0} (fetched at or after ${snapshot.listedAt}: skipped)`,
  );
  log(
    `  by the snapshot's class: ${[...classes]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([cls, count]) => `${cls}=${count}`)
      .join(" ")}`,
  );
  const counts = countByCongressAndType(scan.stale);
  for (const congress of Object.keys(counts).sort()) {
    const types = Object.entries(counts[congress]).sort(([a], [b]) => (a < b ? -1 : 1));
    const total = types.reduce((sum, [, count]) => sum + count, 0);
    log(`  congress ${congress}: ${types.map(([type, count]) => `${type}=${count}`).join(" ")} total=${total}`);
  }
  if (scan.notInSnapshot && scan.notInSnapshot.length > 0) {
    log(`not in the snapshot (${scan.notInSnapshot.length}, not sent): ${scan.notInSnapshot.join(", ")}`);
  }
  log(
    `to send: ${eligible.length} (first summaries ${eligible.filter((bill) => bill.neverStored).length}); ` +
      `already sent (progress file) and still pending: ${sentStillStale.length}`,
  );
  log(
    `  titles_differ=${eligible.filter((bill) => bill.titleDiffers).length}: stored bills whose list title differs ` +
      "(a retitle, or the list's title against an older copy's detail title), sent with their list row's title, as " +
      "the poller sends it (a re-summary when the bill has text; RUNBOOK 16.1, D5)",
  );
  log(
    `  titles_govinfo=${eligible.filter((bill) => bill.titleGovInfo).length}: stored titles in GovInfo's form ` +
      '("H.R.&nbsp;N&nbsp;(IH) - ..."), sent as stored: no news, so no re-summary and no date move (RUNBOOK 16.1)',
  );
  if (sentStillStale.length > 0) {
    // In flight, or FetchRawBill failed them: check the DLQs. A rerun skips them until their line is deleted.
    const listed = sentStillStale.slice(0, MAX_LISTED_GUIDS).map((bill) => bill.guid);
    const more =
      sentStillStale.length > MAX_LISTED_GUIDS ? ` and ${sentStillStale.length - MAX_LISTED_GUIDS} more` : "";
    log(`  sent but still pending: ${listed.join(", ")}${more}`);
  }
  if (scan.unsendable.length > 0) {
    log(
      `unsendable (${scan.unsendable.length}): ${scan.unsendable.map((entry) => `${entry.key} (${entry.reason})`).join(", ")}`,
    );
  }
  if (scan.unreadable.length > 0) {
    log(
      `unreadable (${scan.unreadable.length}): ${scan.unreadable.map((entry) => `${entry.key} (${entry.error})`).join(", ")}`,
    );
  }
};

// ─── --predict (REL-45) ──────────────────────────────────────────────────────

export interface Prediction {
  bills: number;
  fetched: number;
  fetchFailed: number;
  summarize_missing: number;
  summarize_text_changed: number;
  patch: number;
  unchanged: number;
  awaiting_text: number;
  /** stale_raw or skipped. */
  other: number;
}

/** GET with FetchRawBill's User-Agent; a redirect is returned, not followed (as FetchRawBill). */
export const defaultHttpGet = async (url: string): Promise<HttpTextResponse> => {
  const response = await fetchWithTimeout(
    url,
    { headers: { "User-Agent": BILLBOARD_FETCHER_USER_AGENT, Accept: "application/xml" }, redirect: "manual" },
    PREDICT_REQUEST_TIMEOUT_MS,
  );
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { statusCode: response.status, headers, body: await response.text() };
};

/**
 * Dry run only: for each bill, GovInfo's XML of its newest text version (one request every PREDICT_INTERVAL_MS), then
 * planReconcile on a copy of its raw bill holding that text (fetched now, no version id), against its processed bill
 * as BillDiffer reads it. Derived fields are compared as stored, since the refetch's other endpoints are not called.
 */
export const predictTextRecovery = async ({
  s3,
  bucket,
  bills,
  httpGet,
  sleep,
  now,
  log,
}: {
  s3: S3Sender;
  bucket: string;
  bills: readonly StaleBill[];
  httpGet: (url: string) => Promise<HttpTextResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  log: Log;
}): Promise<Prediction> => {
  const storage = new BillStorage(s3 as S3Client, bucket);
  const processedDao = new ProcessedBillDao(s3 as S3Client, bucket);
  const prediction: Prediction = {
    bills: bills.length,
    fetched: 0,
    fetchFailed: 0,
    summarize_missing: 0,
    summarize_text_changed: 0,
    patch: 0,
    unchanged: 0,
    awaiting_text: 0,
    other: 0,
  };
  log(`Predicting ${bills.length} bills from GovInfo, one every ${PREDICT_INTERVAL_MS / 1000} s:`);
  let asked = 0;
  for (const bill of bills) {
    const stem = bill.xmlUrl ? billVersionStem(bill.xmlUrl) : null;
    if (!stem) {
      prediction.fetchFailed += 1;
      log(`  ${bill.guid}: fetch_failed (no GovInfo package id in ${bill.xmlUrl ?? "no URL"})`);
      continue;
    }
    if (asked > 0) await sleep(PREDICT_INTERVAL_MS);
    asked += 1;
    const url = govInfoBillXmlUrl(stem);
    let response: HttpTextResponse;
    try {
      response = await httpGet(url);
    } catch (error) {
      prediction.fetchFailed += 1;
      log(`  ${bill.guid}: fetch_failed (${errorText(error)})`);
      continue;
    }
    const answer = classifyBillXmlResponse(response);
    if (answer.kind !== "ok") {
      prediction.fetchFailed += 1;
      log(`  ${bill.guid}: fetch_failed (GovInfo ${answer.status} ${answer.detail})`);
      continue;
    }
    prediction.fetched += 1;
    try {
      const processed = await processedDao.getRevisionByGuid(bill.guid);
      const raw = await storage.getJsonObject<RawBill>(bill.key);
      if (!raw.value) {
        prediction.other += 1;
        log(`  ${bill.guid}: other (the raw bill is gone)`);
        continue;
      }
      const anchorHash = needsLegacyAnchor(processed, raw)
        ? await legacyAnchorHash(storage, bill.key, raw, processed?.lastModified)
        : undefined;
      const at = now();
      const stored = raw.value as RawBill & { metadata: Record<string, unknown>; content: Record<string, unknown> };
      const predicted = {
        ...stored,
        metadata: { ...stored.metadata, fetchedAt: at.toISOString() },
        content: { ...stored.content, billXML: response.body },
      } as unknown as RawBill;
      const plan = planReconcile({ processed, raw: { value: predicted }, messageGuid: bill.guid, anchorHash, now: at });
      if (plan.kind === "stale_raw" || plan.kind === "skipped") prediction.other += 1;
      else prediction[plan.kind] += 1;
      log(`  ${bill.guid}: ${plan.kind} (${plan.reason}${plan.decidedBy ? `, ${plan.decidedBy}` : ""})`);
    } catch (error) {
      prediction.other += 1;
      log(`  ${bill.guid}: other (could not plan: ${errorText(error)})`);
    }
  }
  log(
    `Text recovery prediction: bills=${prediction.bills} fetched=${prediction.fetched} fetch_failed=${prediction.fetchFailed} ` +
      `summarize_missing=${prediction.summarize_missing} summarize_text_changed=${prediction.summarize_text_changed} ` +
      `patch=${prediction.patch} unchanged=${prediction.unchanged} awaiting_text=${prediction.awaiting_text} ` +
      `other=${prediction.other}`,
  );
  return prediction;
};

/** --unattended: what to do after each stop (RUNBOOK 16.1, "After a stop"). */
const UNATTENDED_RESUME_ADVICE: Partial<Record<RunOutcome, string>> = {
  interrupted: "run the same command; the progress file lists every bill sent.",
  deadline: "nothing more: a bill left over comes in with its next update (RUNBOOK 24.1).",
  send_failed: "find why the send failed (its error above), then run the same command.",
  stopped_check_failed:
    "fix what the check needs (an expired AWS login, the network), then run the same command; it resumes from the " +
    "progress file.",
  stopped_window_opened: "the same command, once the quiet window is closed (RUNBOOK 4.1).",
  stopped_dlq_message:
    "wait for the project's maintainers: redrive or look into the dead letter first (RUNBOOK 6.2), then the same command.",
  stopped_fetch_errors: "wait for the project's maintainers: congress.gov or FetchRawBill trouble (RUNBOOK 6.2).",
  stopped_congress_key_errors:
    "wait for the project's maintainers: an hour after a 429, once Billboard-Ingestion-CongressApi429 is OK.",
  stopped_text_unavailable: "wait for the project's maintainers: bill text could not be fetched (RUNBOOK 4.10).",
  stopped_too_many_summaries: "wait for the project's maintainers (D5): the re-summaries went above the cap.",
  stopped_push_mode_changed:
    "do not resume: NotificationType no longer skips the backfill's pushes; the project's maintainers look first.",
  stopped_backfill_push_sent:
    "do not resume: a backfill change reached UserMatcher; the project's maintainers look first.",
  stopped_carry_mode_changed: "do not resume until MEMBER_VOTE_CARRY_MODE is on again (14.8).",
};

/**
 * --unattended: when the bill's raw copy was stored at or after the snapshot's listedAt (its HeadObject LastModified;
 * the poller or a redrive fetched it since), else null. A read that fails is logged and the bill is sent: a refetch is
 * safe.
 */
const storedSinceSnapshot = async (
  s3: S3Sender,
  bucket: string,
  key: string,
  listedAtMs: number,
  log: Log,
): Promise<string | null> => {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const stored = head.LastModified ? new Date(head.LastModified).getTime() : Number.NaN;
    return Number.isFinite(stored) && stored >= listedAtMs ? new Date(stored).toISOString() : null;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
    const name = (error as { name?: unknown } | null)?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return null;
    log(`Could not read ${key} before its send (${errorText(error)}); sending it all the same.`);
    return null;
  }
};

/**
 * Plans, prints the report and, with --apply, sends one window's batch (or, --unattended, one run's). Never throws for
 * a stop condition or a failed send (see RunResult.exitCode); throws on a usage error (a bad guids or progress file).
 */
export const runRefetch = async ({
  s3,
  sqs,
  cloudwatch,
  ssm,
  awsCli,
  config,
  options,
  log = console.log,
  logError = console.error,
  now = () => new Date(),
  sleep = defaultSleep,
  readFile = defaultReadFile,
  writeFile = (path, text) => writeFileSync(path, text, "utf8"),
  appendFile = (path, text) => appendFileSync(path, text, "utf8"),
  httpGet = defaultHttpGet,
  interrupted = () => false,
}: RunDeps): Promise<RunResult> => {
  const startedAt = now();
  const startedIso = startedAt.toISOString();
  if (options.snapshotFile && options.textRecovery) {
    throw new Error("--snapshot-file and --text-recovery select bills in different ways; use one");
  }
  const unattended = options.unattended === true;
  if (unattended && !options.snapshotFile) {
    throw new Error("--unattended is the REL-56 backfill's: it needs --snapshot-file");
  }
  let snapshot: ParsedSnapshot | null = null;
  if (options.snapshotFile) {
    const snapshotText = readFile(resolvePath(options.snapshotFile));
    if (snapshotText === null) throw new Error(`The snapshot file ${options.snapshotFile} does not exist`);
    snapshot = parseSnapshot(snapshotText);
  }
  if (options.textRecovery) {
    const listed = listedGuids(options, readFile);
    if (!listed) throw new Error("--text-recovery needs --guids-file or --guid: it never reads every raw bill");
    if (listed.length > TEXT_RECOVERY_MAX_BILLS) {
      throw new Error(
        `--text-recovery takes at most ${TEXT_RECOVERY_MAX_BILLS} bills; the list has ${listed.length}. Split it.`,
      );
    }
  }
  const progressPath = resolvePath(options.progressFile);
  const progressText = readFile(progressPath);
  const progressExists = progressText !== null && progressText.trim().length > 0;
  const progress: Progress = progressExists
    ? parseProgress(progressText)
    : { cutoff: null, olderThanDays: null, sent: new Set() };
  if (progress.olderThanDays !== null && progress.olderThanDays !== options.olderThanDays) {
    throw new Error(
      `The progress file ${progressPath} was started with --older-than-days ${progress.olderThanDays}; ` +
        "pass the same value, or use a new --progress-file",
    );
  }
  if (progressExists && (progress.mode === "snapshot") !== (snapshot !== null)) {
    throw new Error(
      `The progress file ${progressPath} was started ${progress.mode === "snapshot" ? "with" : "without"} ` +
        "--snapshot-file; use a separate --progress-file for each mode",
    );
  }
  if (progressExists && snapshot && progress.snapshotSha256 !== snapshot.sha256) {
    throw new Error(
      `The progress file ${progressPath} belongs to another snapshot (SHA-256 ${progress.snapshotSha256}, listedAt ` +
        `${progress.listedAt}); ${options.snapshotFile} has ${snapshot.sha256}. Use the snapshot it was started with, ` +
        "or a new --progress-file",
    );
  }
  if (progressExists && (progress.mode === "text-recovery") !== options.textRecovery) {
    throw new Error(
      `The progress file ${progressPath} was started ${progress.mode === "text-recovery" ? "with" : "without"} ` +
        "--text-recovery; use a separate --progress-file for each mode",
    );
  }
  const cutoff =
    snapshot?.cutoff ?? progress.cutoff ?? new Date(startedAt.getTime() - options.olderThanDays * DAY_MS).toISOString();
  log(
    snapshot
      ? `refetch:stale-bills mode=${options.apply ? "APPLY" : "DRY-RUN"} selection=snapshot ` +
          `${unattended ? "unattended=true " : ""}` +
          `snapshot=${resolvePath(options.snapshotFile!)} sha256=${snapshot.sha256} congress=${snapshot.congress} ` +
          `cutoff=${snapshot.cutoff} top=${snapshot.top} listedAt=${snapshot.listedAt} bills=${snapshot.entries.length} ` +
          `bucket=${config.bucket} raw=${config.rawPrefix} perHour=${options.perHour} ` +
          `progress=${progressPath}${progressExists ? "" : " (new)"}`
      : `refetch:stale-bills mode=${options.apply ? "APPLY" : "DRY-RUN"}${options.textRecovery ? " selection=text-recovery" : ""} ` +
          `bucket=${config.bucket} raw=${config.rawPrefix} ` +
          `cutoff=${cutoff}${progress.cutoff ? " (from the progress file)" : ""}${options.textRecovery ? " (not used)" : ""} ` +
          `perHour=${options.perHour} progress=${progressPath}${progressExists ? "" : " (new)"}`,
  );

  const checks = new AwsChecks({ sqs, cloudwatch, ssm, awsCli, config, now, sleep });
  const result: RunResult = {
    exitCode: 0,
    outcome: options.apply ? "done" : "dry_run",
    cutoff,
    preconditions: [],
    scan: null,
    alreadySent: 0,
    eligible: 0,
    sentGuids: [],
    stop: null,
  };

  // Before the scan, so a refused --apply stops before thousands of reads.
  result.preconditions = await checks.preconditions(
    options.textRecovery,
    snapshot ? { congress: snapshot.congress } : undefined,
    unattended,
  );
  log(`Preconditions for --apply${options.apply ? "" : " (a dry run does not need them)"}:`);
  for (const pre of result.preconditions) log(`  ${pre.ok ? "ok  " : "FAIL"}  ${pre.name}: ${pre.detail}`);
  if (options.textRecovery) {
    log(
      "X7 waiver (--text-recovery): MEMBER_VOTE_CARRY_MODE=on is not required. A refetched bill whose raw copy has " +
        "enriched member votes keeps them only under on; otherwise EnrichOfficialVotes adds them again, as after any " +
        "poller refetch.",
    );
  }
  if (options.apply && result.preconditions.some((pre) => !pre.ok)) {
    log("Refused: a precondition failed; nothing was sent.");
    return { ...result, exitCode: 2, outcome: "refused" };
  }

  const scan = snapshot
    ? await scanSnapshot(s3, config, options, snapshot, { log, readFile })
    : await scanRawBills(s3, config, options, cutoff, { log, readFile });
  const eligible = scan.stale.filter((bill) => !progress.sent.has(bill.guid));
  result.scan = scan;
  result.alreadySent = scan.stale.length - eligible.length;
  result.eligible = eligible.length;
  const sentStillStale = scan.stale.filter((bill) => progress.sent.has(bill.guid));
  if (snapshot) printSnapshotReport(scan, sentStillStale, eligible, snapshot, log);
  else printScanReport(scan, sentStillStale, eligible, log, options.textRecovery);
  const estimate = estimateRun(eligible.length, options);
  log(
    `estimate: ${estimate.calls} Congress.gov calls (${CONGRESS_CALLS_PER_BILL} a bill), ${estimate.hours} hours at ` +
      `${options.perHour} an hour (${estimate.callsPerHour} calls an hour of the key's ${CONGRESS_KEY_CALLS_PER_HOUR}` +
      `${unattended ? ", shared with the poller" : ""}), ` +
      `${estimate.windows} ${unattended ? "runs" : "windows"} of up to ${estimate.batchPerWindow}`,
  );
  /** D5 (b): --unattended without --max-summaries caps a run at its resummaries_likely + 5. */
  const capFor = (likelyBatch: number): number =>
    unattended && options.maxSummariesFromForecast ? likelyBatch + D5_MARGIN : options.maxSummaries;
  const readFailed = scan.unreadable.length > 0;

  if (!options.apply) {
    const batch = eligible.slice(0, effectiveLimit(options));
    log(
      `Dry run: --apply would send ${batch.length} bills now${
        batch.length > 0
          ? `, first ${batch
              .slice(0, 10)
              .map((bill) => bill.guid)
              .join(", ")}`
          : ""
      }.`,
    );
    if (options.predict) {
      result.prediction = await predictTextRecovery({
        s3,
        bucket: config.bucket,
        bills: eligible,
        httpGet,
        sleep,
        now,
        log,
      });
    }
    if (snapshot) {
      const missing = scan.stale.filter((bill) => bill.neverStored).length;
      const forecast = resummaryForecast(eligible, effectiveLimit(options));
      const cap = capFor(forecast.likelyBatch);
      log(forecastLine(forecast, eligible.length, cap));
      log(
        `Refetch plan: mode=snapshot ${unattended ? "unattended=true " : ""}missing=${missing} ` +
          `stale=${scan.stale.length - missing} ` +
          `fetched_since=${scan.fetchedSince?.length ?? 0} already_sent=${result.alreadySent} to_send=${eligible.length} ` +
          `unsendable=${scan.unsendable.length} unreadable=${scan.unreadable.length} ` +
          `first_summaries=${eligible.filter((bill) => bill.neverStored).length} ` +
          `titles_differ=${forecast.titlesDiffer} titles_govinfo=${forecast.titlesGovInfo} ` +
          `resummaries_likely=${forecast.likelyBatch} ${unattended ? `max_summaries=${cap} ` : ""}` +
          `calls=${estimate.calls} hours=${estimate.hours} ${unattended ? "runs" : "windows"}=${estimate.windows}`,
      );
      return { ...result, exitCode: readFailed ? 1 : 0 };
    }
    log(
      `Refetch plan: ${options.textRecovery ? `selection=text-recovery awaiting_text=${scan.awaitingText.length} ` : ""}` +
        `stale=${scan.stale.length} no_fetched_at=${scan.stale.filter((bill) => bill.fetchedAt === null).length} ` +
        `fresh=${scan.fresh} already_sent=${result.alreadySent} to_send=${eligible.length} ` +
        `unsendable=${scan.unsendable.length} unreadable=${scan.unreadable.length} missing=${scan.missing.length} ` +
        `calls=${estimate.calls} hours=${estimate.hours} windows=${estimate.windows}`,
    );
    return { ...result, exitCode: readFailed ? 1 : 0 };
  }

  const queueUrl = await checks.queueUrl(config.updatedBillsQueueName);
  const batch = eligible.slice(0, effectiveLimit(options));
  const intervalMs = sendIntervalMs(options.perHour);
  // A snapshot run sends nothing from BACKFILL_DEADLINE on, even inside a window opened before it (RUNBOOK 24.1); an
  // --unattended run has no window time.
  const deadline = unattended
    ? Date.parse(BACKFILL_DEADLINE)
    : Math.min(
        startedAt.getTime() + options.windowMinutes * MINUTE_MS,
        snapshot ? Date.parse(BACKFILL_DEADLINE) : Number.POSITIVE_INFINITY,
      );
  log(
    `Sending ${batch.length} of ${eligible.length} bills to ${queueUrl}, one every ${intervalMs / 1000} s, ` +
      `until ${new Date(deadline).toISOString()}${unattended ? ", without a quiet window (BACKFILL_PUSH_MODE=skip)" : ""}.`,
  );
  let maxSummaries = options.maxSummaries;
  if (snapshot) {
    const forecast = resummaryForecast(eligible, batch.length);
    maxSummaries = capFor(forecast.likelyBatch);
    log(forecastLine(forecast, eligible.length, maxSummaries));
    if (unattended) {
      result.maxSummaries = maxSummaries;
      log(
        options.maxSummariesFromForecast
          ? `--max-summaries ${maxSummaries}: this run's resummaries_likely ${forecast.likelyBatch} + ${D5_MARGIN} (RUNBOOK 16.1, D5).`
          : `--max-summaries ${maxSummaries} (given); this run's resummaries_likely is ${forecast.likelyBatch} (RUNBOOK 16.1, D5).`,
      );
      if (options.maxSummariesFromForecast) {
        log(
          "The cap is held as the run goes (D5 b for the bills sent so far): at each check, at most the bills sent so " +
            `far that resummaries_likely flags, plus ${D5_MARGIN}; ${maxSummaries} once every bill is sent.`,
        );
      }
    }
    if (forecast.likelyBatch > maxSummaries) {
      log(
        `The batch's resummaries_likely=${forecast.likelyBatch} is above --max-summaries ${maxSummaries}: ` +
          "the run may stop with too_many_summaries (RUNBOOK 16.1, D5).",
      );
    }
  }
  // Written before the first send, so the cutoff is pinned even when the first check stops the run.
  if (batch.length > 0 && !progressExists) {
    writeFile(
      progressPath,
      snapshot
        ? snapshotProgressHeader(snapshot.sha256, snapshot.listedAt)
        : progressHeader(cutoff, options.olderThanDays, options.textRecovery ? "text-recovery" : undefined),
    );
  }
  // D3: the raw keys of the bills the backfill sent, this run's and (after a stop and a rerun, or from earlier
  // windows) the progress file's; their first summaries are not held against the cap.
  const sentKeys = snapshot
    ? new Set<string>([...progress.sent].map((guid) => `${config.rawPrefix}${guid}.json`))
    : undefined;
  // CreateBillsManifest dates a first publication with a rel56: id by congress.gov (RUNBOOK 4.9, D2): mint it from
  // the prefix it checks.
  const correlationPrefix = snapshot ? REL56_BACKFILL_CORRELATION_PREFIX : "refetch:";
  // D5 (b), --unattended without --max-summaries: D5 set a batch's cap at its forecast + 5, for windows of 800 bills.
  // A run of 3,000 holds it to the bills sent so far, so a re-summary the forecast cannot see (a misread legacy
  // anchor) stops the run within minutes, not hundreds of bills in. Sends come before the passes they cause, so the
  // cap rises before the count. maxSummaries is where it ends; a given --max-summaries is held as given.
  const heldByForecast = unattended && options.maxSummariesFromForecast === true;
  let likelySent = 0;
  const heldCap = (): number => (heldByForecast ? likelySent + D5_MARGIN : maxSummaries);

  const stopOutcome = (stop: NonNullable<CheckResult["stop"]>): RunOutcome => {
    result.stop = stop;
    logError(`Stopped: ${stop.reason}: ${stop.detail}`);
    return `stopped_${stop.reason}`;
  };
  // Said once per change: BillDifferEnqueued is above the cap, but the bills it counts are not.
  let lastSummaryNote = "";
  const noteSummaries = (checked: CheckResult): void => {
    if (checked.stop || !checked.summaries) return;
    const { passes, bills, inLogs, unseen } = checked.summaries;
    const note = checked.summaries.backfillOnly
      ? `BillDifferEnqueued=${passes} is above --max-summaries ${heldCap()}, but it counts every pass, the ` +
        `poller's too: the backfill re-summarized ${bills} bills (BillDiffer's logs, rel56: ids, first summaries not ` +
        "counted, D3), within the limit."
      : `BillDifferEnqueued=${passes} is above --max-summaries ${options.maxSummaries}, but it counts passes: ` +
        `${bills} bills were sent to BillSummarizer (${inLogs} in BillDiffer's logs` +
        `${unseen > 0 ? `, ${unseen} passes not in them yet` : ""}${expectedNote(checked.summaries)}), within the limit.`;
    if (note !== lastSummaryNote) log(note);
    lastSummaryNote = note;
  };
  // --unattended: a check that cannot run is tried again (an unattended run is long, and one blip must not end it).
  const runChecks = async (): Promise<CheckResult> => {
    if (!unattended) return checks.run(startedAt, options.maxSummaries, sentKeys);
    for (let attempt = 1; ; attempt += 1) {
      const checked = await checks.runUnattended(
        startedAt,
        heldCap(),
        heldByForecast
          ? `the ${likelySent} bills sent so far that resummaries_likely flags, plus ${D5_MARGIN}, D5 b`
          : undefined,
      );
      if (checked.stop?.reason !== "check_failed" || attempt >= UNATTENDED_CHECK_ATTEMPTS) return checked;
      log(
        `A check could not run (${checked.stop.detail}); trying again in ${CHECK_RETRY_WAIT_MS / 1000} s ` +
          `(attempt ${attempt} of ${UNATTENDED_CHECK_ATTEMPTS}).`,
      );
      await sleep(CHECK_RETRY_WAIT_MS);
    }
  };
  const listedAtMs = snapshot ? Date.parse(snapshot.listedAt) : Number.NaN;
  const skippedSinceSnapshot: string[] = [];
  let outcome = null as RunOutcome | null;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let lastSendAt = Number.NEGATIVE_INFINITY;
  let backlog = 0;
  let backlogDetail: string | undefined;
  let digestPauseNoted = Number.NaN;

  for (const bill of batch) {
    // The stop checks run before the first send, and again whenever this send would go out CHECK_INTERVAL_MS or
    // more after the last check, so no send is further than that from a passing check. A backlog pauses.
    while (!outcome && now().getTime() < deadline) {
      if (unattended && interrupted()) {
        outcome = "interrupted";
        break;
      }
      const sendAt = Math.max(now().getTime(), lastSendAt + intervalMs);
      if (sendAt - lastCheckAt >= CHECK_INTERVAL_MS) {
        const checked = await runChecks();
        lastCheckAt = now().getTime();
        if (checked.stop) {
          outcome = stopOutcome(checked.stop);
          break;
        }
        noteSummaries(checked);
        backlog = checked.backlog;
        backlogDetail = checked.backlogDetail;
      }
      // --unattended: no send in the weekly digest's slot (RUNBOOK 11.4); the checks go on while it waits.
      const digestEnd = unattended
        ? weeklyDigestPauseEnd(new Date(Math.max(now().getTime(), lastSendAt + intervalMs)))
        : null;
      if (digestEnd) {
        if (digestPauseNoted !== digestEnd.getTime()) {
          log(
            "Sunday 09:30 to 11:00 New York time (the weekly digest, RUNBOOK 11.4): pausing until " +
              `${digestEnd.toISOString()}.`,
          );
          digestPauseNoted = digestEnd.getTime();
        }
        await sleep(Math.max(1, Math.min(BACKLOG_WAIT_MS, digestEnd.getTime() - now().getTime())));
        continue;
      }
      if (backlog < options.maxBacklog) break;
      log(`${backlogDetail ?? `UpdatedBillsQueue holds ${backlog} messages`}; pausing ${BACKLOG_WAIT_MS / 1000} s.`);
      await sleep(BACKLOG_WAIT_MS);
      lastCheckAt = Number.NEGATIVE_INFINITY;
    }
    if (outcome) break;
    // --unattended: a bill stored since the snapshot (the poller fetched it) is not sent; its slot is not spent.
    if (unattended) {
      const storedAt = await storedSinceSnapshot(s3, config.bucket, bill.key, listedAtMs, log);
      if (storedAt) {
        skippedSinceSnapshot.push(bill.guid);
        log(`${bill.guid}: stored at ${storedAt}, since the snapshot's listedAt; not sent (fetched_since_run).`);
        continue;
      }
    }
    // Paced from the previous send, so time spent on checks never makes two sends closer than the interval.
    const wait = lastSendAt + intervalMs - now().getTime();
    if (wait > 0) await sleep(wait);
    if (now().getTime() >= deadline) {
      outcome = unattended ? "deadline" : "window_time";
      break;
    }
    if (unattended && interrupted()) {
      outcome = "interrupted";
      break;
    }
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(bill.message),
          ...correlationIdMessageAttributes(`${correlationPrefix}${startedIso}:${bill.guid}`),
        }),
      );
    } catch (error) {
      logError("Could not send a bill to UpdatedBillsQueue; stopping", { guid: bill.guid, error });
      outcome = "send_failed";
      break;
    }
    lastSendAt = now().getTime();
    if (bill.resummaryLikely) likelySent += 1;
    sentKeys?.add(bill.key);
    appendFile(progressPath, progressLine(bill.guid, new Date(lastSendAt).toISOString(), startedIso));
    result.sentGuids.push(bill.guid);
    const sent = result.sentGuids.length;
    if (sent === 1 || sent % LOG_EVERY_SENDS === 0) {
      const minutes = Math.round((lastSendAt - startedAt.getTime()) / MINUTE_MS);
      log(`Sent ${sent} / ${batch.length} (${minutes} min since the start; backlog ${backlog})`);
    }
  }
  outcome ??= batch.length < eligible.length ? "batch_limit" : "done";

  // A last look after the final send, so a stop that fired since the last check is not missed (not after Ctrl-C).
  if (
    result.sentGuids.length > 0 &&
    !outcome.startsWith("stopped_") &&
    outcome !== "send_failed" &&
    outcome !== "interrupted"
  ) {
    const final = await runChecks();
    if (final.stop) outcome = stopOutcome(final.stop);
    else noteSummaries(final);
  }

  const sent = result.sentGuids.length;
  if (outcome === "window_time") log("The window's time is used up; resume in the next window with the same command.");
  if (outcome === "batch_limit") {
    log(
      unattended
        ? "This run's bills are sent; the same command sends the next run."
        : "This window's batch is sent; resume in the next window with the same command.",
    );
  }
  if (outcome === "deadline") log(`${BACKFILL_DEADLINE} is reached: nothing is sent from then (RUNBOOK 24.1).`);
  if (unattended) {
    result.skippedSinceSnapshot = skippedSinceSnapshot;
    const advice = UNATTENDED_RESUME_ADVICE[outcome];
    if (advice) log(`Resume: ${advice}`);
    log(
      "Next: there is no window to close; the queues drain on their own and NotificationType sends the backfill's " +
        "changes to nobody (BACKFILL_PUSH_MODE=skip). Check the run (RUNBOOK 16.1, step 5): the DLQs, " +
        `\`npm run reconcile:processed-bills -- --guids-file ${progressPath}\` (dry run), the re-summaries against ` +
        `${maxSummaries}, and no UserMatcher line with a rel56: correlation id.`,
    );
  } else {
    log(
      "Next: wait for UpdatedBillsQueue, BillVoteEnrichmentQueue, BillDifferQueue, BillSummarizerQueue and BillsManifestQueue to drain " +
        "(ApproximateNumberOfMessages, ApproximateNumberOfMessagesNotVisible and ApproximateNumberOfMessagesDelayed all 0: " +
        "delayed retries are invisible to the first two), " +
        "close the window (RUNBOOK 4.1), check the DLQs, and run `npm run reconcile:processed-bills -- --guids-file " +
        `${progressPath}\` (dry run): stop and ask if summarize_text_changed is above ${options.maxSummaries}.`,
    );
  }
  if (options.textRecovery) {
    log(
      "Text recovery: once the queues drain, the same command without --apply and --progress-file should show " +
        "to_send=0 (RUNBOOK 4.10).",
    );
  }
  if (snapshot) {
    const sentSet = new Set(result.sentGuids);
    log(
      `Refetch summary: mode=APPLY selection=snapshot ${unattended ? "unattended=true " : ""}outcome=${outcome} ` +
        `selected=${scan.stale.length} ` +
        `already_sent=${result.alreadySent} eligible=${eligible.length} sent=${sent} remaining=${eligible.length - sent} ` +
        `unsendable=${scan.unsendable.length} unreadable=${scan.unreadable.length} ` +
        `missing=${scan.stale.filter((bill) => bill.neverStored).length} ` +
        `missing_sent=${scan.stale.filter((bill) => bill.neverStored && sentSet.has(bill.guid)).length} ` +
        `fetched_since=${scan.fetchedSince?.length ?? 0}` +
        `${unattended ? ` fetched_since_run=${skippedSinceSnapshot.length} max_summaries=${maxSummaries}` : ""}`,
    );
  } else {
    log(
      `Refetch summary: mode=APPLY outcome=${outcome} selected=${scan.stale.length} already_sent=${result.alreadySent} ` +
        `eligible=${eligible.length} sent=${sent} remaining=${eligible.length - sent} unsendable=${scan.unsendable.length} ` +
        `unreadable=${scan.unreadable.length} missing=${scan.missing.length}`,
    );
  }
  const exitCode =
    outcome.startsWith("stopped_") || outcome === "interrupted" ? 2 : outcome === "send_failed" || readFailed ? 1 : 0;
  return { ...result, outcome, exitCode };
};

/** --unattended --apply: the same signal again this soon after the last one that counted is the same press. */
export const REPEAT_SIGNAL_MS = 1_000;

/** What installStopSignals needs of `process`. */
export interface SignalTarget {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

/**
 * --unattended --apply: the first SIGINT or SIGTERM asks the run to stop after the send in hand (the returned function
 * then says true), so the progress file stays complete. One Ctrl-C under `npm run` reaches node twice, milliseconds
 * apart: the terminal sends SIGINT to the whole process group and npm forwards its own copy to node. So the listeners
 * stay (`on`, not `once`, whose removal leaves the copy to Node's default, an exit at once), and the same signal again
 * within REPEAT_SIGNAL_MS of the last one that counted is that copy and is ignored. A later press, or another signal,
 * quits at once: exit 130 for SIGINT, 143 for SIGTERM.
 */
export const installStopSignals = (
  proc: SignalTarget,
  now: () => number = Date.now,
  logError: Log = console.error,
): (() => boolean) => {
  let interrupted = false;
  let last: { signal: NodeJS.Signals; at: number } | null = null;
  const onSignal = (signal: NodeJS.Signals): void => {
    const at = now();
    if (last && last.signal === signal && at - last.at < REPEAT_SIGNAL_MS) return;
    last = { signal, at };
    if (!interrupted) {
      interrupted = true;
      logError(
        `${signal}: stopping after the send in hand (the same command resumes); Ctrl-C again, a second or more ` +
          "later, quits at once.",
      );
      return;
    }
    logError(
      `${signal} again: quitting at once. A bill sent but not in the progress file yet is sent again on the resume.`,
    );
    proc.exit(signal === "SIGTERM" ? 143 : 130);
  };
  proc.on("SIGINT", onSignal);
  proc.on("SIGTERM", onSignal);
  return () => interrupted;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  // --unattended: Ctrl-C (or SIGTERM) stops after the send in hand; a later Ctrl-C quits at once.
  const interrupted = options.unattended && options.apply ? installStopSignals(process) : () => false;
  const result = await runRefetch({
    s3: new S3Client({ region: config.region }),
    sqs: new SQSClient({ region: config.region }),
    cloudwatch: new CloudWatchClient({ region: config.region }),
    ssm: new SSMClient({ region: config.region }),
    awsCli: awsCliRunner(config.region),
    config,
    options,
    interrupted,
  });
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Stale bill refetch failed", error);
    process.exitCode = 1;
  });
}
