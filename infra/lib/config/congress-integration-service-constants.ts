import { parseOptionalReservedConcurrency, parseReservedConcurrencyWithDefault } from './env';

export const BILLS_DIFFER_QUEUE_BATCH_SIZE = 5;
export const BILLS_DIFFER_QUEUE_TIMEOUT_SECONDS = 60;

// REL-38: receives before a message moves to its dead-letter queue, set on their own. These queues
// used to reuse their batch-size constants, so a batch-size change would silently change the retry
// budget too. The values equal those batch sizes (5), so the synthesized RedrivePolicy is unchanged.
// Keep them at 5 or more for batch-of-5 consumers: a timeout charges a receive to every record of
// the batch.
export const BILLS_DIFFER_QUEUE_MAX_RECEIVE_COUNT = 5;
export const CONGRESS_MEMBERS_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT = 5;
export const UPDATED_CONGRESS_MEMBERS_QUEUE_MAX_RECEIVE_COUNT = 5;

// Infra review item 4: the six ingest dead-letter queues (UpdatedBills, BillVoteEnrichment, BillDiffer,
// CongressMemberSummarizer, UpdatedCongressMembers here, BillSummarizer in SummarizerServiceStack) keep a
// failed message 14 days, like every other DLQ, instead of the SQS default of 4. A message keeps its
// original enqueue time when it moves, so 4 days could expire a failure over a long weekend; nothing
// else can rebuild an UpdatedBills or BillVoteEnrichment message. Lowering this again deletes every
// DLQ message older than the new value within minutes: inspect or redrive the DLQs first.
export const INGEST_DLQ_RETENTION_DAYS = 14;

// FetchRawBill's receive batch size on UpdatedBillsQueue.
export const UPDATED_BILLS_QUEUE_BATCH_SIZE = 1;
// The base visibility: a failed record comes back after it when FetchRawBill sets none (FETCH_RETRY_BACKOFF off, a
// failed ChangeMessageVisibility, or a failure of the whole invocation: the key read, init, memory, a timeout).
export const UPDATED_BILLS_QUEUE_TIMEOUT_SECONDS = 180;

// REL-58: FetchRawBill's retry ladder. congress.gov's outages come and go for hours (2026-11-10: 7.7 h), and 3
// receives of 180 s rode out about 9 minutes (REL-05 set 3 so that one blip would not dead-letter a bill): 14 bills
// dead-lettered that day, 5 never stored until the redrive. Under FETCH_RETRY_BACKOFF 'on' FetchRawBill sets a failed
// record's visibility itself: after a congress.gov failure (a timeout, a network error, 500, 502, 503, 504, 520 to
// 530, 429, or a 404 on the bill endpoint for its first FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES receives) the step of
// its receive, 3, 5, 10, 20 and 30 minutes, then an hour 5 times: 22,080 s, about 6 h 8 min, before the dead letter.
// Any other failure, every failure of a bulk message (refetch:stale-bills, the REL-56 backfill, backfill:cosponsors)
// and the final receive come back after FETCH_RAW_BILL_RETRY_OTHER_SECONDS, so a poison message still dead-letters in
// about 11 minutes. Each step gets up to 10% more at random. 'off' is the behaviour before REL-58: every failure comes
// back after UPDATED_BILLS_QUEUE_TIMEOUT_SECONDS.
// Rollback, in two steps (docs/RUNBOOK.md 6.5): set 'off' and deploy; wait until UpdatedBillsQueue reads 0 0 0
// (messages already on the ladder keep their wait); then set UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT to 3 and deploy.
// Lowered first, every message received more times than the new count dead-letters at its next receive.
export const FETCH_RETRY_BACKOFF: 'off' | 'on' = 'on';
export const FETCH_RAW_BILL_RETRY_LADDER_SECONDS: readonly number[] = [180, 300, 600, 1200, 1800, 3600, 3600, 3600, 3600, 3600];
export const FETCH_RAW_BILL_RETRY_OTHER_SECONDS = 60;
// All 12 bill-endpoint 404s FetchRawBill retried since 2026-10-16 cleared within 6 minutes (congress.gov listed the bill
// before its detail): 4 steps, 38 minutes, then a 404 counts as any other failure.
export const FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES = 4;
// The ladder's steps plus the last receive (11). Independent of the batch size. The rollback's second step sets 3.
export const UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT: number = FETCH_RAW_BILL_RETRY_LADDER_SECONDS.length + 1;
// Billboard-Ingestion-FetchRawBillFailing: a bill failing on congress.gov this long (its 5th receive on the ladder)
// while the poller met no outage.
export const FETCH_RAW_BILL_FAILING_ALARM_SECONDS = 30 * 60;

/**
 * REL-58: the retry ladder's synth-time check. Each step 60 s to 12 hours (SQS's largest visibility), and a minute to
 * 15 minutes for other failures. While the switch is 'on', also: the steps plus the last receive equal
 * UpdatedBillsQueue's maxReceiveCount and add up to 6 hours or more, and a 404 takes the ladder for fewer receives than
 * the queue allows ('off' leaves the receive count free, for the rollback's second step).
 */
export const assertFetchRawBillRetryLadder = (ladder: {
  backoff: 'off' | 'on';
  steps: readonly number[];
  maxReceiveCount: number;
  otherSeconds: number;
  notFoundReceives: number;
}): void => {
  const { backoff, steps, maxReceiveCount, otherSeconds, notFoundReceives } = ladder;
  if (steps.length === 0 || steps.some((step) => !Number.isInteger(step) || step < 60 || step > 43200)) {
    throw new Error(`FETCH_RAW_BILL_RETRY_LADDER_SECONDS: each step must be whole seconds from 60 to 43200 (${steps.join(',')})`);
  }
  if (backoff === 'on' && steps.length + 1 !== maxReceiveCount) {
    throw new Error(`FETCH_RAW_BILL_RETRY_LADDER_SECONDS: its ${steps.length} steps plus 1 must equal the maxReceiveCount ${maxReceiveCount}`);
  }
  const total = steps.reduce((sum, step) => sum + step, 0);
  if (backoff === 'on' && total < 6 * 3600) {
    throw new Error(`FETCH_RAW_BILL_RETRY_LADDER_SECONDS: the steps must add up to at least 21600 s (6 hours), not ${total}`);
  }
  if (!Number.isInteger(otherSeconds) || otherSeconds < 60 || otherSeconds > 900) {
    throw new Error(`FETCH_RAW_BILL_RETRY_OTHER_SECONDS must be whole seconds from 60 to 900 (${otherSeconds})`);
  }
  if (!Number.isInteger(notFoundReceives) || notFoundReceives < 0 || (backoff === 'on' && notFoundReceives >= maxReceiveCount)) {
    throw new Error(`FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES must be from 0 to below ${maxReceiveCount} (${notFoundReceives})`);
  }
};
assertFetchRawBillRetryLadder({
  backoff: FETCH_RETRY_BACKOFF,
  steps: FETCH_RAW_BILL_RETRY_LADDER_SECONDS,
  maxReceiveCount: UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT,
  otherSeconds: FETCH_RAW_BILL_RETRY_OTHER_SECONDS,
  notFoundReceives: FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES,
});
// Messages per SendMessageBatch call when BillsApiPoller enqueues bills onto
// UpdatedBillsQueue (its QUEUE_BATCH_SIZE). 10 is the SQS maximum and keeps a
// 250-bill page to 25 calls. Unrelated to UPDATED_BILLS_QUEUE_BATCH_SIZE, the
// consumer's receive batch size.
export const BILLS_API_POLLER_SEND_BATCH_SIZE = 10;

export const BILL_VOTE_ENRICHMENT_QUEUE_BATCH_SIZE = 1;
export const BILL_VOTE_ENRICHMENT_QUEUE_TIMEOUT_SECONDS = 180;

export const CONGRESS_MEMBERS_SUMMARIZER_QUEUE_BATCH_SIZE = 5;
export const CONGRESS_MEMBERS_SUMMARIZER_QUEUE_TIMEOUT_SECONDS = 60;

export const UPDATED_CONGRESS_MEMBERS_QUEUE_BATCH_SIZE = 5;
// 6x FETCH_RAW_CONGRESS_MEMBERS_LAMBDA_TIMEOUT_SECONDS.
export const UPDATED_CONGRESS_MEMBERS_QUEUE_TIMEOUT_SECONDS = 360;
// FetchRawCongressMembers paces its congress.gov calls per invocation; more parallel
// invocations would undo that pacing.
export const FETCH_RAW_CONGRESS_MEMBERS_EVENT_SOURCE_MAX_CONCURRENCY = 2;

export const FETCH_RAW_BILLS_LAMBDA_TIMEOUT_SECONDS = 90;
export const FETCH_RAW_BILLS_LAMBDA_MEMORY_MB = 512;
export const ENRICH_OFFICIAL_VOTES_LAMBDA_TIMEOUT_SECONDS = 90;
export const ENRICH_OFFICIAL_VOTES_LAMBDA_MEMORY_MB = 512;

export const FETCH_RAW_BILLS_EVENT_SOURCE_MAX_CONCURRENCY = 2;
export const ENRICH_OFFICIAL_VOTES_EVENT_SOURCE_MAX_CONCURRENCY = 2;

// Optional override for accounts that have enough unreserved concurrency headroom.
// Leave unset to avoid deployment failures in constrained accounts.
export const FETCH_RAW_BILLS_RESERVED_CONCURRENCY =
  parseOptionalReservedConcurrency(
    process.env.FETCH_RAW_BILLS_RESERVED_CONCURRENCY,
    'FETCH_RAW_BILLS_RESERVED_CONCURRENCY'
  );
export const ENRICH_OFFICIAL_VOTES_RESERVED_CONCURRENCY =
  parseOptionalReservedConcurrency(
    process.env.ENRICH_OFFICIAL_VOTES_RESERVED_CONCURRENCY,
    'ENRICH_OFFICIAL_VOTES_RESERVED_CONCURRENCY'
  );
// The poller reads and writes one SSM cursor, so overlapping runs would race it;
// reserving 1 prevents that (a throttled run is retried by Lambda's async queue).
// CloudFormation rejects any reservation that would leave the account below its
// minimum unreserved concurrency (100), which fails the stack update.
// Reserved by default; set the repository variable of the same name to `off` to
// drop the reservation (for example in an account without that headroom), or to
// another integer >= 1 to change it.
export const BILLS_API_POLLER_RESERVED_CONCURRENCY_DEFAULT = 1;
export const BILLS_API_POLLER_RESERVED_CONCURRENCY =
  parseReservedConcurrencyWithDefault(
    process.env.BILLS_API_POLLER_RESERVED_CONCURRENCY,
    'BILLS_API_POLLER_RESERVED_CONCURRENCY',
    BILLS_API_POLLER_RESERVED_CONCURRENCY_DEFAULT
  );

export const BILLS_API_POLLER_LAMBDA_MEMORY_MB = 256;

export const BILLS_API_POLLER_LAMBDA_TIMEOUT_SECONDS = 120;
// Read by the poller only when POLL_TARGETS is unset, so it stays 119 for a rollback to code without POLL_TARGETS.
export const POLL_CONGRESS = 119;
// REL-46: the Congresses BillsApiPoller polls, each from its own SSM state parameter ("<congress>=<parameter>").
// It wins over POLL_CONGRESS. A Congress is not polled before its start (17:00Z on January 3), so the 120th turns on
// by itself at noon ET on 2027-01-03 and the 119th becomes trailing: polled after it, outcomes only. The 119th
// stays here through 2027-03-31 (project decision D2), then goes in its own PR with Billboard-Ingestion-BillPollerLag119.
// The first parameter is the original BillsApiPollerStateParameter, which no deploy may change (RUNBOOK 6).
export const POLL_TARGETS =
  '119=/billboard/congress/bills-poller-state,120=/billboard/congress/bills-poller-state-120';
export const POLL_BILL_TYPES = 'hr,s,hjres,sjres,hconres,sconres,hres,sres';
export const BILLS_API_POLLER_MAX_PAGES_PER_BILL_TYPE = 20;

export const BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS = 60 * 60; // Minutes x Seconds
// REL-46: Billboard-Ingestion-BillPollerLag119, the trailing 119th's lag (Congress=119) or no datapoint, for 3 hours.
export const BILL_POLLER_TRAILING_LAG_ALARM_THRESHOLD_SECONDS = 3 * 60 * 60;

// Per-request timeout for congress.gov calls in BillsApiPoller, FetchRawBill and
// EnrichOfficialVotes. The poller keeps SOFT_STOP_REMAINING_MS plus this in reserve,
// so raising it well above 10 s shortens each poller run. The two members fetchers
// use their own 4 s default.
export const CONGRESS_API_REQUEST_TIMEOUT_MS = 10000;
// Retries after the first attempt, for the same three congress.gov callers.
export const CONGRESS_API_MAX_RETRIES = 2;

// FetchRawBill congress.gov budget
export const CONGRESS_API_CALL_DELAY_MS = 1200;
export const CONGRESS_API_MAX_CALLS_PER_BILL = 10;

// REL-45: FetchRawBill's bill text. The newest text version's XML is read from GovInfo first, then www.congress.gov
// ('congress' alone is the rollback switch: no code revert). A bill whose stored copy has the text of the same version
// is not fetched again ('off' fetches every time). When every source refuses, the bill is stored and sent again to
// UpdatedBillsQueue after BILL_TEXT_RETRY_DELAY_SECONDS (well under the queue's hour-long age alarm), at most
// BILL_TEXT_MAX_RETRIES times (about 30 minutes), so it can land on another execution environment; then
// BillTextUnavailable counts it. The fetch stops starting requests after BILL_XML_FETCH_BUDGET_MS (and 15 s before the
// 90 s Lambda timeout), and a host that refused an execution environment is skipped there for the cooldown.
export const BILL_XML_SOURCES = 'govinfo,congress';
export const BILL_XML_REUSE_SAME_VERSION = 'on';
export const BILL_TEXT_RETRY_DELAY_SECONDS = 600;
export const BILL_TEXT_MAX_RETRIES = 3;
export const BILL_XML_FETCH_BUDGET_MS = 40000;
export const BILL_XML_REFUSED_HOST_COOLDOWN_MS = 600000;

// REL-57: FetchRawBill's poller refetches that change nothing. congress.gov re-stamps some bills every 15 minutes for
// hours, and each listing is still fetched in full (a repeat can carry a real update). 'watch' compares the fetched
// bill (after the REL-35 carry) with the stored copy, logs and counts each one that is unchanged
// (RawBillUnchangedWouldSkip), and stores it as before. 'on' stores none of those and sends them to no BillDiffer
// (RawBillUnchangedSkipped); vote enrichment is still queued when the stored copy needs it. Messages of the REL-56
// backfill, refetch:stale-bills, backfill:cosponsors and FetchRawBill's own text retries are always stored. The
// covering invariant (REL-56): a poller refetch over a copy that a rel56: or refetch: message stored (the stored
// copy's correlation id) is always stored and sent on too, however equal, so a backfill store never covers a poller
// listing whose push NotificationType's BACKFILL_PUSH_MODE=skip would then drop unseen. 'off' compares nothing; it and
// 'watch' are the rollback (docs/RUNBOOK.md 6.4).
export const REFETCH_UNCHANGED_MODE: 'off' | 'watch' | 'on' = 'watch';

// EnrichOfficialVotes congress.gov budget and deferral
export const CONGRESS_VOTE_CALL_DELAY_MS = 1500;
export const CONGRESS_API_MAX_HOUSE_VOTE_PAGES = 2;
export const CONGRESS_VOTE_MAX_CALLS_PER_BILL = 4;
export const VOTE_ENRICHMENT_DEFER_DELAY_SECONDS = 900;
export const VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS = 4;

// BillsApiPoller stops starting congress.gov requests once less than this (plus a
// request timeout and a page's enqueue time) remains, so it saves its cursor in time.
export const SOFT_STOP_REMAINING_MS = 3000;

// Covers page retries, the departed-member manifest scan and the re-queue.
export const FETCH_CONGRESS_MEMBERS_LIST_LAMBDA_TIMEOUT_SECONDS = 60;

// A batch of 5 is fetched one at a time with paced calls, 4 s request timeouts and retries.
export const FETCH_RAW_CONGRESS_MEMBERS_LAMBDA_TIMEOUT_SECONDS = 60;
