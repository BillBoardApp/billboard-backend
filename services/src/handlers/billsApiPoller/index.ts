import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { CONGRESS_API_BASE_URL } from "../../shared/apiBaseUrls";
import { normalizeIsoDate, toBillMessage, toTrimmedString, type UpdatedBillMessage } from "../../shared/billListRow";
import {
  getCongressApiKey,
  invalidateCongressApiKey,
  isCongressApiAuthFailureStatus,
} from "../../shared/congressApiKey";
import { correlationIdMessageAttributes, mintCorrelationId } from "../../shared/correlation";
import {
  fetchWithTimeout,
  isNetworkError,
  isTimeoutError,
  isUpstreamUnavailableStatus,
  networkErrorCode,
  redactUrl,
} from "../../shared/http";
import { logger } from "../../shared/logger";
import { putMetric, type MetricUnit } from "../../shared/metrics";
import { isRetryableStatus, retryDelayMs, sleep } from "../../shared/retry";

const SECRET_NAME = process.env.SECRET_NAME!;
const STATE_PARAMETER_NAME = process.env.STATE_PARAMETER_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const QUEUE_BATCH_SIZE = Number.parseInt(process.env.QUEUE_BATCH_SIZE ?? "10", 10);
const POLL_CONGRESS = (process.env.POLL_CONGRESS ?? "119").trim();
const BILL_TYPES = (process.env.BILL_TYPES ?? "hr,s,hjres,sjres,hconres,sconres,hres,sres")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter((value) => value.length > 0);
const MAX_PAGES_PER_BILL_TYPE = Number.parseInt(process.env.MAX_PAGES_PER_BILL_TYPE ?? "20", 10);
const CONGRESS_API_MAX_RETRIES = Number.parseInt(process.env.CONGRESS_API_MAX_RETRIES ?? "3", 10);
const CONGRESS_API_BASE_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_BASE_DELAY_MS ?? "500", 10);
const CONGRESS_API_MAX_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_MAX_DELAY_MS ?? "5000", 10);
// Per-attempt deadline for a list request. It was 4000 ms, which aborted slow but healthy 250-row
// pages and caused most of the poller's retry churn (REL-25); 10000 ms matches the other congress.gov callers.
const CONGRESS_API_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CONGRESS_API_REQUEST_TIMEOUT_MS ?? "10000", 10);
const SOFT_STOP_REMAINING_MS = Number.parseInt(process.env.SOFT_STOP_REMAINING_MS ?? "2000", 10);
// Recovery knob (REC-05). When the poller has no usable state (first deploy, the SSM parameter was
// lost or reset, or POLL_CONGRESS changed) it normally starts every cursor at "now", so the next
// scan only reaches back OVERLAP_SECONDS and anything updated while the state was missing is never
// fetched. Set BACKFILL_FROM_ISO to an ISO-8601 time in the past to start new cursors there instead;
// later runs scan forward from it, working through a large backlog over several runs. It only
// affects cursors that are being created; existing cursors are untouched. Unset it once caught up.
const BACKFILL_FROM_ISO = (process.env.BACKFILL_FROM_ISO ?? "").trim();
// REL-46: the Congresses to poll, as "<congress>=<state parameter>,...", each with its own SSM state. When set it wins
// over POLL_CONGRESS and STATE_PARAMETER_NAME; when unset the poller polls POLL_CONGRESS alone, as before. A Congress
// is not polled before it starts. The newest one that has started is the primary; the others are trailing: polled
// after it while time remains, and only their outcomes are enqueued (TRAILING_ENQUEUE=all enqueues every update).
const POLL_TARGETS = (process.env.POLL_TARGETS ?? "").trim();
const TRAILING_ENQUEUE = (process.env.TRAILING_ENQUEUE ?? "outcomes").trim().toLowerCase();
// The earliest latestAction.actionDate (YYYY-MM-DD) a trailing Congress's update may have and still be enqueued.
// Unset: 33 days before that Congress ends (the next one's start), so 2026-12-01 for the 119th.
const TRAILING_ACTION_CUTOFF = (process.env.TRAILING_ACTION_CUTOFF ?? "").trim();

// REL-56: congress.gov filters its bill list on an update time finer than the date its rows show (checked to 12 hours,
// RUNBOOK 6), and its rows show updateDate as a date only, so a row cannot be placed against a cursor. Each bill type
// keeps a watermark instead: the top of the last window it listed in full. The next window starts OVERLAP_SECONDS
// before it, so a row inside the overlap is enqueued by both runs, and every row in a window is enqueued. A row is
// skipped only if it shows in the list more than OVERLAP_SECONDS after its time (BillPollerLateRows watches that) or
// the list changes its order while a window is read (the count check in pollBillType).
const OVERLAP_SECONDS = 120;
// Rows each page reads again from the end of the page before (REL-56). A row that leaves the window while it is read
// (updated again, so its time is now past the window's top) moves the rows below it up; the overlap keeps such a row
// from slipping between two pages.
const PAGE_OVERLAP_ROWS = 25;
// How often a scan steps back one page (PAGE_STEP_ROWS) when a page shares no row with the end of the page before
// (BillPollerPageDrift).
const MAX_PAGE_DRIFT_STEP_BACKS = 2;
// A window read in this run lists at least every row it still counts (it only loses rows). When it lists fewer, the
// scan reads it again from where it started, this many times at most (BillPollerPageDrift).
const MAX_WINDOW_REREADS = 1;
// REL-56: "hourly" (the default) makes the first run of each hour check congress.gov's list filter
// (BillPollerFilterImprecise) and list again a window read an hour before (BillPollerLateRows); "off" turns both off.
const FILTER_PRECISION_CHECK = (process.env.FILTER_PRECISION_CHECK ?? "hourly").trim().toLowerCase();
// The filter check counts hr rows over the whole day before and over one second of it, at 18:00:00Z (afternoon in
// Washington, when most rows are updated). The day needs this many rows for the check to tell anything.
const FILTER_CHECK_MIN_DAY_ROWS = 3;
// More rows than this in that second, or as many as in the whole day, means the filter does not work below an hour.
const FILTER_CHECK_MAX_SECOND_ROWS = 10;
const FILTER_CHECK_HOUR_UTC = 18;
const FILTER_CHECK_BILL_TYPE = "hr";
// The late-row check keeps a window of at most this many rows (their numbers are stored in the state).
const PROBE_MAX_ROWS = 20;
const PROBE_BILL_TYPE = BILL_TYPES.includes("hr") ? "hr" : BILL_TYPES[0];
// The poller's schedule (rate 5 minutes): the run that starts in the first 5 minutes of an hour makes the checks.
const SCHEDULE_MINUTES = 5;
const USER_AGENT = "BillBoardFetcher/1.0 (+https://billboard-project.com/privacy.html)";
const METRIC_NAMESPACE = "BillBoard/BillIngestion";
const RETRY_BACKOFF = { baseMs: CONGRESS_API_BASE_DELAY_MS, maxMs: CONGRESS_API_MAX_DELAY_MS };
const LIST_PAGE_SIZE = 250;
// How far a full page moves the offset on.
const PAGE_STEP_ROWS = LIST_PAGE_SIZE - PAGE_OVERLAP_ROWS;
// Allowance per SendMessageBatch call. New bills are enqueued right after each page is parsed, so
// a full page's worth of sends has to fit in the reserve too (with QUEUE_BATCH_SIZE=1 that is 250
// sequential calls).
const SQS_SEND_ESTIMATE_MS = 50;
const PAGE_ENQUEUE_RESERVE_MS = Math.ceil(LIST_PAGE_SIZE / QUEUE_BATCH_SIZE) * SQS_SEND_ESTIMATE_MS;
// Lambda time that must remain before starting a request: one full request, enqueueing that page,
// and the soft-stop margin, so a request that is slow but would succeed never runs into the Lambda
// timeout before the page's bills are sent and the cursor is saved.
const REQUEST_TIME_RESERVE_MS = SOFT_STOP_REMAINING_MS + CONGRESS_API_REQUEST_TIMEOUT_MS + PAGE_ENQUEUE_RESERVE_MS;

const ssm = new SSMClient({});
const sqs = new SQSClient({});

type UnknownRecord = Record<string, unknown>;

interface BillTypeCursor {
  /**
   * For code from before REL-56 (a rollback), which lists from lastUpdateAt less OVERLAP_SECONDS and drops every row
   * whose "<updateDate>#<guid>" is at or below lastSeenKey. Written as the UTC midnight that starts this code's next
   * window, and that midnight with no guid, so that code enqueues every row of that day once more instead of dropping
   * any. A cursor written before REL-56 has only these two fields.
   */
  lastUpdateAt: string;
  lastSeenKey: string;
  /** REL-56: the top of the last window listed in full (whole seconds). The next window starts OVERLAP_SECONDS earlier. */
  watermark?: string;
  /** REL-56: whether congress.gov has listed a bill of this type (REL-46's no-bill-yet rule). */
  listed?: boolean;
  /**
   * REL-56: set while a window is listed over several runs (the page cap, the soft stop, an outage). The watermark
   * stays put until the window is read in full; the next run reads the same window, with the same top, from offset.
   */
  backlog?: BillTypeBacklog;
}

interface BillTypeBacklog {
  /** The window's top, fixed until it is read in full. */
  to: string;
  /**
   * Where the next page starts, rows from the newest in the window. Kept only with a count: without one the next run
   * cannot tell how far rows moved since, so it reads the window from its top again (offset 0).
   */
  offset: number;
  /** The window's pagination.count at the last page read, when congress.gov gave one. */
  count?: number;
}

/**
 * REL-56: a window the first run of an hour listed in full, from its start to its top less OVERLAP_SECONDS (the part no
 * later window lists), with the bill numbers it listed. The next hour's first run lists it again: a bill in it now
 * that was not then showed in the list too late to be listed by any window (BillPollerLateRows) and is enqueued then.
 */
interface LateRowProbe {
  billType: string;
  from: string;
  to: string;
  numbers: string[];
}

interface BillsApiPollerState {
  schemaVersion: 1;
  congress: string;
  /** When a run last saved this state, whatever its outcome. */
  lastRunAt: string;
  /**
   * The start of the last run that polled congress.gov without finding it unavailable: every request it made was
   * answered, so every bill type was scanned up to then (or the run stopped for time or the page cap, as before).
   * BillPollerLagSeconds is measured from it, so an outage keeps the lag growing although its runs end normally. A
   * state written before this field existed reads lastRunAt here.
   */
  lastPolledAt: string;
  cursors: Record<string, BillTypeCursor>;
  /** REL-56: the newest Congress's late-row probe, if any. */
  probe?: LateRowProbe;
}

/** One Congress to poll and the SSM parameter that holds its state (REL-46). */
interface PollTarget {
  congress: string;
  stateParameterName: string;
}

interface LatestAction {
  text: string;
  /** YYYY-MM-DD, or empty when the row has none. */
  actionDate: string;
}

/** REL-46: a trailing Congress's enqueue gate, and what it let through and held back in one run. */
interface OutcomeGate {
  actionCutoff: string;
  enqueued: number;
  skipped: number;
  sample: Array<{ guid: string; actionDate: string; action: string }>;
}

type ScanStopReason = "soft_stop" | "max_pages" | "upstream_unavailable";

interface PollResult {
  /** Messages sent to the queue by this scan (each page is sent as soon as it is parsed). */
  enqueued: number;
  nextCursor: BillTypeCursor;
  apiCalls: number;
  discovered: number;
  missingUpdateDateCount: number;
  fallbackUsed: boolean;
  stoppedEarlyDueToTime: boolean;
  /** Null when the scan finished; the watermark only advances then. */
  incompleteReason: ScanStopReason | null;
  pagesScanned: number;
  /** The window's pagination.count on its first page this run (null without one): rows congress.gov lists in it. */
  windowRows: number | null;
  /** Set when congress.gov was unavailable (incompleteReason "upstream_unavailable"). */
  unavailable: CongressApiUnavailableError | null;
  /** A late-row probe of this window, when this run listed all of it and it was small enough (REL-56). */
  probe: LateRowProbe | null;
}

class CongressApiError extends Error {
  readonly status: number;

  readonly body: string;

  constructor(status: number, body: string) {
    super(`Congress API request failed: status ${status}`);
    this.name = "CongressApiError";
    this.status = status;
    this.body = body;
  }
}

// Thrown instead of retrying when the Lambda has too little time left for another attempt; the
// scan then stops like a soft stop (cursor kept) rather than failing the run.
class OutOfTimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutOfTimeError";
  }
}

/**
 * A list request that still failed after the retries the run could afford, in a way that says congress.gov (or
 * Cloudflare in front of it) is unavailable: HTTP 500, 502, 503, 504 or 520 to 530, a timeout, or a network error.
 * The scan stops like a soft stop (watermark kept, pages already read recorded as a backlog) and the run ends
 * without an error: an outage is not ours to fix, and a thrown error only added Lambda Errors, async retries that
 * collided with the next scheduled run (Throttles) and emails. It counts CongressApiUnavailable and logs one warning;
 * BillPollerLagSeconds keeps growing until a run polls again. 4xx (401, 403, 429 included), a malformed body and
 * every other failure still fail the run.
 */
class CongressApiUnavailableError extends Error {
  readonly path: string;

  /** The last HTTP status, or null for a timeout or network error. */
  readonly status: number | null;

  readonly reason: string;

  /** Requests made for this URL, counted against CONGRESS_API_MAX_RETRIES. */
  readonly attempts: number;

  constructor(path: string, reason: string, status: number | null, attempts: number, options?: { cause?: unknown }) {
    super(`congress.gov unavailable for ${path}: ${reason}`, options);
    this.name = "CongressApiUnavailableError";
    this.path = path;
    this.status = status;
    this.reason = reason;
    this.attempts = attempts;
  }
}

/**
 * REL-46: with POLL_TARGETS, a state parameter that holds another congress than its mapping is never written. The run
 * skips that Congress, logs an error and counts BillPollerStateMismatch.
 */
class StateMismatchError extends Error {
  readonly stateParameter: string;

  readonly storedCongress: string;

  readonly congress: string;

  constructor(stateParameter: string, storedCongress: string, congress: string) {
    super(`Bill poller state ${stateParameter} holds congress ${storedCongress}, not ${congress}`);
    this.name = "StateMismatchError";
    this.stateParameter = stateParameter;
    this.storedCongress = storedCongress;
    this.congress = congress;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Since the 20th Amendment a Congress meets at noon Eastern (17:00Z) on January 3 of its first year, 1789 + 2(N - 1).
// Congress can move the day by law; the gate does not know that.
const congressStartMs = (congress: string): number =>
  Date.UTC(1789 + 2 * (Number.parseInt(congress, 10) - 1), 0, 3, 17);

const defaultTrailingActionCutoff = (congress: string): string =>
  new Date(congressStartMs(String(Number.parseInt(congress, 10) + 1)) - 33 * DAY_MS).toISOString().slice(0, 10);

// What a trailing Congress still enqueues: a passage, a failure, a step towards or past the President, and the
// wordings that follow a vote in the other chamber.
const OUTCOME_ACTION_PATTERN =
  /\b(passed|agreed to|failed|president|public law|private law|vetoe?d?|veto|became law|enrolled|presented|received in the|held at the desk|message on senate action|cleared for white house)\b/i;

// REL-46: how long after a Congress starts an error answer for a bill type with no bill yet is read as an empty list.
const NO_BILL_YET_WINDOW_DAYS = 30;

const SKIPPED_SAMPLE_SIZE = 5;

const parsePollTargets = (value: string): PollTarget[] => {
  const invalid = () => new Error("Invalid env var POLL_TARGETS (expected <congress>=<state parameter>,...)");
  const targets = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf("=");
      const congress = separator === -1 ? "" : entry.slice(0, separator).trim();
      const stateParameterName = separator === -1 ? "" : entry.slice(separator + 1).trim();
      if (!/^[1-9]\d*$/.test(congress) || stateParameterName.length === 0) throw invalid();
      return { congress, stateParameterName };
    });
  const congresses = new Set(targets.map((target) => target.congress));
  const names = new Set(targets.map((target) => target.stateParameterName));
  if (targets.length === 0 || congresses.size !== targets.length || names.size !== targets.length) throw invalid();
  return targets;
};

interface PollerContextLike {
  awsRequestId?: string;
  getRemainingTimeInMillis?: () => number;
}

const toCongressApiDateTime = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid datetime for Congress API: ${value}`);
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const hour = String(parsed.getUTCHours()).padStart(2, "0");
  const minute = String(parsed.getUTCMinutes()).padStart(2, "0");
  const second = String(parsed.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
};

const buildCursorKey = (updateDate: string, guid: string): string => `${updateDate}#${guid}`;

const splitCursorKey = (cursorKey: string): { updateDate: string; guid: string } => {
  const hashIndex = cursorKey.indexOf("#");
  if (hashIndex === -1) return { updateDate: cursorKey, guid: "" };
  return {
    updateDate: cursorKey.slice(0, hashIndex),
    guid: cursorKey.slice(hashIndex + 1),
  };
};

const startOfUtcDayIso = (iso: string): string => `${new Date(iso).toISOString().slice(0, 10)}T00:00:00.000Z`;

const floorToSecondIso = (iso: string): string => new Date(Math.floor(Date.parse(iso) / 1000) * 1000).toISOString();

const windowStartIso = (watermark: string): string =>
  new Date(Math.max(0, Date.parse(watermark) - OVERLAP_SECONDS * 1000)).toISOString();

/**
 * A cursor at `watermark` (REL-56), with the two fields code from before REL-56 reads: the midnight that starts this
 * code's next window, so that code enqueues that whole day again rather than skip any of it.
 */
const cursorAt = (watermark: string, listed: boolean, backlog?: BillTypeBacklog): BillTypeCursor => {
  const day = startOfUtcDayIso(windowStartIso(watermark));
  return {
    lastUpdateAt: day,
    lastSeenKey: buildCursorKey(day, ""),
    watermark,
    listed,
    ...(backlog ? { backlog } : {}),
  };
};

/**
 * A cursor's watermark. One written before REL-56 has none: it starts at the midnight of its lastUpdateAt, since its
 * key's date-only "<updateDate>#<guid>" may have skipped any row of that day (and a cursor at a full time, from
 * initialization, BACKFILL_FROM_ISO or a Congress's start, every row of that day before it).
 */
const effectiveWatermark = (cursor: BillTypeCursor): string =>
  cursor.watermark ?? startOfUtcDayIso(cursor.lastUpdateAt);

/** Whether congress.gov has listed a bill of the type; before REL-56, whether the cursor's key names one. */
const isListed = (cursor: BillTypeCursor): boolean =>
  cursor.listed ?? splitCursorKey(cursor.lastSeenKey).guid.length > 0;

// A backlog that is not above its watermark has nothing left to read; one that does not parse is dropped too. Either
// way the next scan lists the whole window from the watermark, which holds the backlog's.
const parseBacklog = (value: unknown, watermark: string): BillTypeBacklog | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const backlog = value as Record<string, unknown>;
  const to = normalizeIsoDate(backlog.to);
  const { offset, count } = backlog;
  if (!to || Date.parse(to) <= Date.parse(watermark)) return undefined;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return undefined;
  const validCount = typeof count === "number" && Number.isInteger(count) && count >= 0;
  return { to: floorToSecondIso(to), ...(validCount ? { offset, count } : { offset: 0 }) };
};

const parseProbe = (value: unknown): LateRowProbe | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const probe = value as Record<string, unknown>;
  const billType = toTrimmedString(probe.billType);
  const from = normalizeIsoDate(probe.from);
  const to = normalizeIsoDate(probe.to);
  const { numbers } = probe;
  if (!billType || !from || !to || !Array.isArray(numbers)) return undefined;
  if (!numbers.every((number) => typeof number === "string")) return undefined;
  return { billType, from, to, numbers: numbers as string[] };
};

const parseState = (raw: string): BillsApiPollerState | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<BillsApiPollerState>;
    if (parsed?.schemaVersion !== 1) return null;
    if (toTrimmedString(parsed.congress).length === 0) return null;
    if (toTrimmedString(parsed.lastRunAt).length === 0) return null;
    if (!parsed.cursors || typeof parsed.cursors !== "object") return null;

    const cursors: Record<string, BillTypeCursor> = {};
    for (const [billType, cursorValue] of Object.entries(parsed.cursors as Record<string, unknown>)) {
      if (!cursorValue || typeof cursorValue !== "object") continue;
      const cursor = cursorValue as Record<string, unknown>;
      const watermarkIso = normalizeIsoDate(cursor.watermark);
      if (watermarkIso) {
        const watermark = floorToSecondIso(watermarkIso);
        cursors[billType] = cursorAt(watermark, cursor.listed === true, parseBacklog(cursor.backlog, watermark));
        continue;
      }
      // Written before REL-56: kept as it is until its type is scanned, without its REL-06 resume point, which
      // this code never reads or writes back (code from before REL-56 would misread one written now).
      const lastUpdateAt = normalizeIsoDate(cursor.lastUpdateAt) ?? normalizeIsoDate(parsed.lastRunAt);
      if (!lastUpdateAt) continue;
      const lastSeenKeyRaw = toTrimmedString(cursor.lastSeenKey);
      const fallbackKey = buildCursorKey(lastUpdateAt, "");
      const lastSeenKey = lastSeenKeyRaw.length > 0 ? lastSeenKeyRaw : fallbackKey;
      cursors[billType] = { lastUpdateAt, lastSeenKey };
    }

    const lastRunAt = normalizeIsoDate(parsed.lastRunAt) ?? new Date().toISOString();
    const probe = parseProbe(parsed.probe);
    return {
      schemaVersion: 1,
      congress: toTrimmedString(parsed.congress),
      lastRunAt,
      lastPolledAt: normalizeIsoDate(parsed.lastPolledAt) ?? lastRunAt,
      cursors,
      ...(probe ? { probe } : {}),
    };
  } catch {
    return null;
  }
};

// cursorStartIso is "now", or BACKFILL_FROM_ISO when set, or the Congress's start when that was under 14 days ago. A new
// cursor's watermark is that time: its first window starts OVERLAP_SECONDS before it (REL-56).
const newCursor = (cursorStartIso: string): BillTypeCursor => cursorAt(floorToSecondIso(cursorStartIso), false);

const buildInitialState = (congress: string, nowIso: string, cursorStartIso: string): BillsApiPollerState => {
  const cursors: Record<string, BillTypeCursor> = {};
  for (const billType of BILL_TYPES) {
    cursors[billType] = newCursor(cursorStartIso);
  }

  return {
    schemaVersion: 1,
    congress,
    lastRunAt: nowIso,
    lastPolledAt: nowIso,
    cursors,
  };
};

const ensureAllCursors = (state: BillsApiPollerState, cursorStartIso: string): BillsApiPollerState => {
  const next = { ...state, cursors: { ...state.cursors } };

  for (const billType of BILL_TYPES) {
    const cursor = next.cursors[billType];
    if (cursor) continue;
    next.cursors[billType] = newCursor(cursorStartIso);
  }

  return next;
};

const loadState = async (stateParameterName: string): Promise<BillsApiPollerState | null> => {
  try {
    const response = await ssm.send(
      new GetParameterCommand({
        Name: stateParameterName,
      }),
    );
    const value = response.Parameter?.Value;
    if (!value) return null;
    return parseState(value);
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "ParameterNotFound") {
      return null;
    }
    throw error;
  }
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// By instant; plain string order if either side does not parse.
const compareIsoTimes = (a: string, b: string): number => {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return compareStrings(a, b);
  return Math.sign(aMs - bMs);
};

// Between two backlogs of one window: the one with fewer rows left below its offset (count less offset), since a window
// only loses rows and a page read later sees them moved up by as many as it lost; on a tie the later reading (the lower
// count), then the higher offset. Without both counts, the higher offset.
const compareBacklogProgress = (a: BillTypeBacklog, b: BillTypeBacklog): number => {
  if (a.count !== undefined && b.count !== undefined) {
    const byRowsLeft = Math.sign(b.count - b.offset - (a.count - a.offset));
    if (byRowsLeft !== 0) return byRowsLeft;
    const byReading = Math.sign(b.count - a.count);
    if (byReading !== 0) return byReading;
  }
  return Math.sign(a.offset - b.offset);
};

/**
 * Positive when cursor `a` is further along than `b`, negative when behind, 0 when level (REL-56). Ordered by
 * watermark (a cursor from before REL-56 by the midnight of its lastUpdateAt). On the same watermark a backlog is
 * further along than none, since it records pages of the next window already read; between two backlogs, the one with
 * the later window top, then compareBacklogProgress; then a type that has been listed. Each cursor on its own only
 * records what its run listed, so a wrong pick makes a run list rows again, never skip them.
 */
const compareCursorProgress = (a: BillTypeCursor, b: BillTypeCursor): number => {
  const byWatermark = compareIsoTimes(effectiveWatermark(a), effectiveWatermark(b));
  if (byWatermark !== 0) return byWatermark;
  if (!a.backlog || !b.backlog) {
    const byBacklog = Number(Boolean(a.backlog)) - Number(Boolean(b.backlog));
    if (byBacklog !== 0) return byBacklog;
  } else {
    const byTop = compareIsoTimes(a.backlog.to, b.backlog.to);
    if (byTop !== 0) return byTop;
    const byProgress = compareBacklogProgress(a.backlog, b.backlog);
    if (byProgress !== 0) return byProgress;
  }
  return Number(isListed(a)) - Number(isListed(b));
};

// Cursors as parseState writes them, so a stored one can be told from the one a run loaded.
const sameCursor = (a: BillTypeCursor | undefined, b: BillTypeCursor | undefined): boolean =>
  a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

interface StateMerge {
  state: BillsApiPollerState;
  /** Bill types whose stored cursor was further along than this run's, so it was kept. */
  keptStored: Array<{ billType: string; stored: BillTypeCursor; own: BillTypeCursor }>;
  /** Bill types only the stored state had; kept as they were. */
  keptStoredOnly: string[];
  keptStoredLastRunAt: boolean;
  keptStoredLastPolledAt: boolean;
}

/**
 * Merges this run's state into the one stored now (REL-06, defense in depth). A cursor only ever
 * records scans its run finished, so every stored cursor stays true; keeping the further-along one
 * per bill type means a slower overlapping run can never move a cursor backwards or erase another
 * run's progress. Cursors are kept whole, never mixed: a backlog is only valid with its own
 * watermark. A stored cursor that is the one this run loaded (`loaded`) was written by no other run, so this run's
 * own wins, even one further back: a scan that stepped back for rows that moved (REL-56) reads them again from there.
 * The later lastRunAt and lastPolledAt are kept too, so an overlapping run's completed poll is not hidden
 * from the lag. Nothing is merged from a missing or unparseable stored value, or one for another congress.
 */
const mergeWithStoredState = (
  own: BillsApiPollerState,
  stored: BillsApiPollerState | null,
  loaded: Record<string, BillTypeCursor> = {},
): StateMerge => {
  const merge: StateMerge = {
    state: own,
    keptStored: [],
    keptStoredOnly: [],
    keptStoredLastRunAt: false,
    keptStoredLastPolledAt: false,
  };
  if (!stored || stored.congress !== own.congress) return merge;

  const cursors = { ...own.cursors };
  for (const [billType, storedCursor] of Object.entries(stored.cursors)) {
    const ownCursor = own.cursors[billType];
    if (!ownCursor) {
      cursors[billType] = storedCursor;
      merge.keptStoredOnly.push(billType);
    } else if (!sameCursor(storedCursor, loaded[billType]) && compareCursorProgress(storedCursor, ownCursor) > 0) {
      cursors[billType] = storedCursor;
      merge.keptStored.push({ billType, stored: storedCursor, own: ownCursor });
    }
  }
  merge.keptStoredLastRunAt = compareIsoTimes(stored.lastRunAt, own.lastRunAt) > 0;
  merge.keptStoredLastPolledAt = compareIsoTimes(stored.lastPolledAt, own.lastPolledAt) > 0;
  merge.state = {
    ...own,
    lastRunAt: merge.keptStoredLastRunAt ? stored.lastRunAt : own.lastRunAt,
    lastPolledAt: merge.keptStoredLastPolledAt ? stored.lastPolledAt : own.lastPolledAt,
    cursors,
  };
  return merge;
};

// Re-reads the stored state immediately before writing and merges with it (see mergeWithStoredState);
// the Lambda also has reserved concurrency 1. SSM has no conditional put, so a write landing between
// this read and the put can still be overwritten: the merge narrows that window, it does not close it.
// A state stored for another congress is replaced without POLL_TARGETS, as before, and never written with it
// (StateMismatchError). `loaded` is the cursors this run last read or wrote. Returns the state written.
const saveState = async (
  state: BillsApiPollerState,
  stateParameterName: string,
  replaceOtherCongress: boolean,
  loaded?: Record<string, BillTypeCursor>,
): Promise<BillsApiPollerState> => {
  const stored = await loadState(stateParameterName);
  if (stored && stored.congress !== state.congress) {
    if (!replaceOtherCongress) throw new StateMismatchError(stateParameterName, stored.congress, state.congress);
    logger.warn("Replacing bill poller state stored for another congress", {
      stateParameter: stateParameterName,
      storedCongress: stored.congress,
      congress: state.congress,
    });
  }

  const merge = mergeWithStoredState(state, stored, loaded);
  // A later stored lastPolledAt alone is not reported: this run has not finished its own poll yet, so keeping the
  // other run's loses nothing.
  if (merge.keptStored.length > 0 || merge.keptStoredOnly.length > 0 || merge.keptStoredLastRunAt) {
    logger.warn("Bill poller state stored by an overlapping run was further along; kept its values", {
      stateParameter: stateParameterName,
      keptStoredCursors: merge.keptStored,
      keptStoredOnlyBillTypes: merge.keptStoredOnly,
      ...(merge.keptStoredLastRunAt ? { lastRunAt: { stored: merge.state.lastRunAt, own: state.lastRunAt } } : {}),
    });
  }

  await ssm.send(
    new PutParameterCommand({
      Name: stateParameterName,
      Type: "String",
      Overwrite: true,
      Value: JSON.stringify(merge.state),
    }),
  );
  return merge.state;
};

const emitMetric = (metricName: string, value: number, unit: MetricUnit = "Count"): Promise<void> =>
  putMetric(METRIC_NAMESPACE, metricName, value, undefined, unit);

const emitCongressMetric = (
  metricName: string,
  congress: string,
  value: number,
  unit: MetricUnit = "Count",
): Promise<void> => putMetric(METRIC_NAMESPACE, metricName, value, { Congress: congress }, unit);

// The list's rows, or null when the answer holds no list at all.
const extractBillsArray = (payload: unknown): UnknownRecord[] | null => {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as UnknownRecord;

  if (Array.isArray(p.bills)) return p.bills as UnknownRecord[];

  if (p.bills && typeof p.bills === "object") {
    const nested = p.bills as UnknownRecord;
    if (Array.isArray(nested.bill)) return nested.bill as UnknownRecord[];
    if (Array.isArray(nested.bills)) return nested.bills as UnknownRecord[];
  }

  if (Array.isArray(p.results)) return p.results as UnknownRecord[];
  return null;
};

// pagination.count: the rows in the whole filtered list, or null when the answer has none (REL-56).
const extractTotalCount = (payload: unknown): number | null => {
  if (!payload || typeof payload !== "object") return null;
  const pagination = (payload as UnknownRecord).pagination;
  if (!pagination || typeof pagination !== "object") return null;
  const raw = (pagination as UnknownRecord).count;
  const count = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
};

/**
 * REL-56: a page's rows. An answer with no list (`{}`, `"bills": null`, an error object), unless it counts no rows, or
 * one with no row at an offset below its own count, is not a page of the list: read as empty, it would move the
 * watermark past rows nobody listed. It fails the run instead, as a body that is not JSON does, and the cursor stays.
 */
const listRowsOf = (
  payload: UnknownRecord,
  pageCount: number | null,
  offset: number,
  list: string,
): UnknownRecord[] => {
  const rows = extractBillsArray(payload);
  if (rows === null) {
    if (pageCount === 0) return [];
    throw new Error(`Congress API answer for ${list} holds no bill list`);
  }
  if (rows.length === 0 && pageCount !== null && pageCount > offset) {
    throw new Error(`Congress API answer for ${list} lists no bill at offset ${offset} but counts ${pageCount}`);
  }
  return rows;
};

const describeRequestFailure = (error: unknown): string => {
  if (isTimeoutError(error)) return `timed out after ${CONGRESS_API_REQUEST_TIMEOUT_MS}ms`;
  if (error instanceof Error) {
    const code = networkErrorCode(error);
    return `${error.name}: ${error.message}${code && !error.message.includes(code) ? ` (${code})` : ""}`;
  }
  return String(error);
};

/** A failed attempt, as the retry decision and an eventual CongressApiUnavailableError need it. */
interface AttemptFailure {
  reason: string;
  /** Whether it is an upstream-unavailable condition (see CongressApiUnavailableError). */
  unavailable: boolean;
  status: number | null;
  cause?: unknown;
}

// remainingMs is the Lambda time left; it returns Infinity outside Lambda.
const fetchCongressJson = async (
  url: string,
  remainingMs: () => number,
  attempt = 0,
  keyRefreshed = false,
): Promise<UnknownRecord> => {
  const targetUrl = new URL(url.startsWith("http") ? url : `${CONGRESS_API_BASE_URL}/${url.replace(/^\/+/, "")}`);
  // Always the current key, so a pagination URL can never carry a rotated one.
  targetUrl.searchParams.set("api_key", await getCongressApiKey());
  if (!targetUrl.searchParams.has("format")) {
    targetUrl.searchParams.set("format", "json");
  }

  const unavailableError = (failure: AttemptFailure, reason = failure.reason) =>
    new CongressApiUnavailableError(targetUrl.pathname, reason, failure.status, attempt + 1, { cause: failure.cause });

  const retry = async (delayMs: number, nextAttempt: number, refreshed: boolean, failure: AttemptFailure) => {
    const { reason, cause } = failure;
    if (remainingMs() - delayMs < REQUEST_TIME_RESERVE_MS) {
      // No time for another attempt: an unavailable congress.gov still ends the run as an outage, anything else
      // (a 429, another 5xx, the key refresh) as a soft stop.
      if (failure.unavailable) throw unavailableError(failure, `${reason}; no Lambda time left to retry`);
      throw new OutOfTimeError(`Not enough Lambda time left to retry ${targetUrl.pathname} (${reason})`, { cause });
    }
    // Retries are routine (congress.gov is often slow): logged without a stack so a request that
    // recovers is not reported as an error (REL-25). Only the final failure is thrown. A retry of an
    // unavailable congress.gov is logged at INFO: if it never recovers, the run's one outage warning
    // reports it. Other retries (a 429, another 5xx, the key refresh, a fetch failure that is not a
    // network error) still warn.
    const retryLine = {
      path: targetUrl.pathname,
      reason,
      attempt: nextAttempt,
      maxRetries: CONGRESS_API_MAX_RETRIES,
      delayMs,
    };
    if (failure.unavailable) {
      logger.info("Congress API request will be retried", retryLine);
    } else {
      logger.warn("Congress API request will be retried", retryLine);
    }
    await sleep(delayMs);
    return fetchCongressJson(url, remainingMs, nextAttempt, refreshed);
  };

  let response: Response;
  let body: string;
  try {
    response = await fetchWithTimeout(
      targetUrl.toString(),
      {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      },
      CONGRESS_API_REQUEST_TIMEOUT_MS,
    );
    // Inside the try: the deadline also covers reading the body.
    body = await response.text();
  } catch (error) {
    // Everything fetch and the body read throw is retried; only a timeout or a network error says congress.gov
    // is unavailable.
    const failure: AttemptFailure = {
      reason: describeRequestFailure(error),
      unavailable: isTimeoutError(error) || isNetworkError(error),
      status: null,
      cause: error,
    };
    if (attempt < CONGRESS_API_MAX_RETRIES) {
      return retry(retryDelayMs(attempt, RETRY_BACKOFF), attempt + 1, keyRefreshed, failure);
    }
    if (failure.unavailable) throw unavailableError(failure);
    throw error;
  }

  if (!response.ok) {
    if (response.status === 429) {
      await emitMetric("CongressApi429", 1);
    }

    const failure: AttemptFailure = {
      reason: `status ${response.status}`,
      unavailable: isUpstreamUnavailableStatus(response.status),
      status: response.status,
    };
    if (isRetryableStatus(response.status) && attempt < CONGRESS_API_MAX_RETRIES) {
      const delayMs = retryDelayMs(attempt, RETRY_BACKOFF, response.headers.get("retry-after"));
      return retry(delayMs, attempt + 1, keyRefreshed, failure);
    }

    // The cached key may have been rotated: re-read it and retry once (REL-13).
    if (isCongressApiAuthFailureStatus(response.status)) {
      if (!keyRefreshed) {
        invalidateCongressApiKey();
        return retry(0, attempt, true, { ...failure, reason: `${failure.reason}; refreshing the API key` });
      }
      logger.error("Congress API rejected a freshly read API key", {
        path: targetUrl.pathname,
        status: response.status,
      });
      await emitMetric("CongressApiAuthFailure", 1);
    }

    const apiError = new CongressApiError(response.status, body.slice(0, 500));
    if (failure.unavailable) throw unavailableError({ ...failure, cause: apiError });
    throw apiError;
  }

  try {
    return JSON.parse(body) as UnknownRecord;
  } catch {
    throw new Error(`Congress API response was not valid JSON for ${redactUrl(targetUrl)}`);
  }
};

const shouldFallbackToNewestScan = (error: unknown): boolean => {
  if (!(error instanceof CongressApiError)) return false;
  if (error.status !== 400 && error.status !== 422) return false;

  const message = error.body.toLowerCase();
  return (
    message.includes("invalid") ||
    message.includes("unknown") ||
    message.includes("unsupported") ||
    message.includes("parameter")
  );
};

/**
 * REL-46: congress.gov may answer 404, 400 or 422 for the list of a bill type that has no bill yet in a new Congress (not
 * checked yet: RUNBOOK 24.2). Such an answer reads as an empty list. A 400 the filtered scan can fall back on is tried
 * unfiltered first.
 */
const isNoBillYetAnswer = (error: unknown, filtered: boolean): error is CongressApiError =>
  error instanceof CongressApiError &&
  (error.status === 404 ||
    error.status === 422 ||
    (error.status === 400 && !(filtered && shouldFallbackToNewestScan(error))));

// One page of a bill type's list, newest first; `window` null for the unfiltered fallback. The offset is the scan's own
// (REL-56), never pagination.next. fetchCongressJson adds the API key.
const buildListUrl = (
  congress: string,
  billType: string,
  offset: number,
  window: { from: string; to: string } | null,
  limit = LIST_PAGE_SIZE,
): string => {
  const url = new URL(`${CONGRESS_API_BASE_URL}/bill/${congress}/${billType}`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(Math.max(0, offset)));
  url.searchParams.set("sort", "updateDate+desc");

  if (window) {
    url.searchParams.set("fromDateTime", toCongressApiDateTime(window.from));
    url.searchParams.set("toDateTime", toCongressApiDateTime(window.to));
  }

  return url.toString();
};

const latestActionOf = (row: UnknownRecord): LatestAction => {
  const latestAction = row.latestAction as UnknownRecord | undefined;
  return {
    text: toTrimmedString(latestAction?.text),
    actionDate: toTrimmedString(latestAction?.actionDate).slice(0, 10),
  };
};

// REL-46: a trailing Congress's update is enqueued only when its latest action is an outcome dated on or after the
// cutoff. Without the gate, a late text version, summary or cosponsor change on a dead bill would come back as a
// fresh "New" or "Updated" row, with pushes; with the text alone, a months-old "Passed House" still would.
const admitTrailingUpdate = (gate: OutcomeGate, guid: string, action: LatestAction): boolean => {
  const admitted = OUTCOME_ACTION_PATTERN.test(action.text) && action.actionDate >= gate.actionCutoff;
  if (admitted) {
    gate.enqueued += 1;
  } else {
    gate.skipped += 1;
    if (gate.sample.length < SKIPPED_SAMPLE_SIZE) {
      gate.sample.push({ guid, actionDate: action.actionDate, action: action.text.slice(0, 200) });
    }
  }
  return admitted;
};

const collapseToLatestPerGuid = (messages: UpdatedBillMessage[]): UpdatedBillMessage[] => {
  const byGuid = new Map<string, UpdatedBillMessage>();

  for (const message of messages) {
    const existing = byGuid.get(message.guid);
    if (!existing) {
      byGuid.set(message.guid, message);
      continue;
    }

    const currentStamp = toTrimmedString(existing.updateDate) || toTrimmedString(existing.pubDate);
    const candidateStamp = toTrimmedString(message.updateDate) || toTrimmedString(message.pubDate);
    if (candidateStamp > currentStamp) {
      byGuid.set(message.guid, message);
    }
  }

  return Array.from(byGuid.values());
};

const parseBackfillFromIso = (nowMs: number): string | null => {
  if (!BACKFILL_FROM_ISO) return null;
  const parsed = new Date(BACKFILL_FROM_ISO);
  // A future start would put the cursor ahead of real updates and silently skip them.
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > nowMs) {
    throw new Error("Invalid env var BACKFILL_FROM_ISO (expected an ISO-8601 time in the past)");
  }
  return parsed.toISOString();
};

/** The window a scan of a cursor lists (REL-56): from its watermark less OVERLAP_SECONDS to its backlog's top or now. */
interface ScanWindow {
  watermark: string;
  from: string;
  to: string;
  backlog: BillTypeBacklog | undefined;
}

// runTopIso is the run's start, in whole seconds.
const scanWindowFor = (cursor: BillTypeCursor, runTopIso: string): ScanWindow => {
  const watermark = effectiveWatermark(cursor);
  return { watermark, from: windowStartIso(watermark), to: cursor.backlog?.to ?? runTopIso, backlog: cursor.backlog };
};

/** How one scan mode ended; pollBillType adds what was enqueued. */
interface ScanOutcome {
  nextCursor: BillTypeCursor;
  incompleteReason: ScanStopReason | null;
  pagesScanned: number;
  unavailable: CongressApiUnavailableError | null;
  windowRows: number | null;
  probe: LateRowProbe | null;
}

const pollBillType = async (
  congress: string,
  billType: string,
  cursor: BillTypeCursor,
  runStartedAtIso: string,
  shouldSoftStop: () => boolean,
  remainingMs: () => number,
  gate: OutcomeGate | null,
  // REL-46: congress.gov has listed no bill of this type since its Congress started.
  noBillYet: boolean,
): Promise<PollResult> => {
  const runTopIso = floorToSecondIso(runStartedAtIso);
  const window = scanWindowFor(cursor, runTopIso);
  const listedBefore = isListed(cursor);
  const list = `bill/${congress}/${billType}`;

  // Each page's bills are sent before the next page is requested, so enqueue time is covered by the per-request
  // reserve and a soft stop keeps what was already sent. Every row in the window is sent (REL-56): a row cannot be told
  // from one already sent, since its updateDate is a date only. Within a scan a guid is sent once: pages overlap by
  // PAGE_OVERLAP_ROWS, and a fallback rescan repeats rows. A trailing Congress's rows go through its outcome gate first
  // (REL-46): a row it holds back is handled all the same, and the watermark still moves past it.
  const handledGuids = new Set<string>();
  const handledNumbers = new Set<string>();
  const latestActions = new WeakMap<UpdatedBillMessage, LatestAction>();
  let enqueued = 0;
  let discovered = 0;
  let missingUpdateDateCount = 0;
  let apiCalls = 0;
  const enqueuePage = async (pageMessages: UpdatedBillMessage[]): Promise<void> => {
    const fresh = collapseToLatestPerGuid(pageMessages).filter((message) => !handledGuids.has(message.guid));
    discovered += fresh.length;
    missingUpdateDateCount += fresh.filter((message) => !message.updateDate).length;
    const admitted = gate
      ? fresh.filter((message) =>
          admitTrailingUpdate(gate, message.guid, latestActions.get(message) ?? { text: "", actionDate: "" }),
        )
      : fresh;
    enqueued += await sendBatches(admitted, runStartedAtIso);
    for (const message of fresh) {
      handledGuids.add(message.guid);
      if (message.billNumber) handledNumbers.add(message.billNumber);
    }
  };

  const scanMode = async (filtered: boolean): Promise<ScanOutcome> => {
    // Filtered: the window by offset, newest first. Its top stays put until the window is read in full, over several
    // runs if need be (the backlog), so a row updated while it is read leaves it rather than moving to its top.
    // Unfiltered (the fallback): newest first from the top of the whole list, down to the first row dated before the
    // day the window starts (rows are dated by day); no backlog.
    const backlog = filtered ? window.backlog : undefined;
    const fallbackFromDay = startOfUtcDayIso(window.from);
    // A backlog keeps an offset only with a count (parseBacklog).
    let offset = backlog?.offset ?? 0;
    // Where this scan's reading of the window starts: the rows above it were read by the runs before.
    let readFrom = offset;
    // The window's pagination.count at the last page read (null when that page had none).
    let count: number | null = backlog?.count ?? null;
    // The guids of the previous page's rows that the next page should read again.
    let previousTail: Set<string> | null = null;
    // Rows the count rose by between pages of a window whose top is this run's start, in this reading of it: rows that
    // showed in the list while it was read (a lower bound, since rows that leave it meanwhile lower the count). Those
    // that showed below the page being read are listed all the same.
    let risen = 0;
    let stepBacks = 0;
    let rereads = 0;
    let pages = 0;
    let windowRows: number | null = null;
    // pagination.count on the page that reached the end of the window.
    let finalCount: number | null = null;
    let anyRow = false;
    // Rows read with no bill number to name them (none so far): counted as listed.
    let unnamedRows = 0;
    let noBillYetAnswer = false;
    const scanStartedAt = Date.now();
    let incompleteReason: ScanStopReason | null = null;
    let unavailable: CongressApiUnavailableError | null = null;

    // Until the window is read in full (incompleteReason stays null), or a stop.
    for (;;) {
      if (pages >= MAX_PAGES_PER_BILL_TYPE) {
        incompleteReason = "max_pages";
        logger.warn("Reached MAX_PAGES_PER_BILL_TYPE", { billType, maxPages: MAX_PAGES_PER_BILL_TYPE });
        break;
      }

      if (shouldSoftStop()) {
        incompleteReason = "soft_stop";
        logger.warn("Stopping bill-type scan early due to low remaining Lambda time", {
          billType,
          pagesScanned: pages,
          apiCalls,
          discovered,
          elapsedMs: Date.now() - scanStartedAt,
        });
        break;
      }

      let payload: UnknownRecord;
      try {
        payload = await fetchCongressJson(
          buildListUrl(congress, billType, offset, filtered ? { from: window.from, to: window.to } : null),
          remainingMs,
        );
      } catch (error) {
        if (error instanceof CongressApiUnavailableError) {
          // Stops like a soft stop: the pages already read become the backlog. The handler ends the run and logs it
          // once.
          incompleteReason = "upstream_unavailable";
          unavailable = error;
          break;
        }
        if (noBillYet && pages === 0 && isNoBillYetAnswer(error, filtered)) {
          // Read as an empty list: the watermark stays put, so the first bills are still listed from there once
          // congress.gov lists them, and the bill types after this one are polled.
          // WARN and a metric, so a bill type that is dead in a new Congress is seen; after the window the same answer
          // is an error.
          logger.warn("congress.gov answered an error for a bill type with no bill yet; read as an empty list", {
            congress,
            billType,
            status: error.status,
            filtered,
          });
          await emitCongressMetric("BillPollerNoBillYetAnswer", congress, 1);
          noBillYetAnswer = true;
          break;
        }
        if (!(error instanceof OutOfTimeError)) throw error;
        incompleteReason = "soft_stop";
        logger.warn("Stopping bill-type scan early: no Lambda time left to retry a page", {
          billType,
          pagesScanned: pages,
          reason: error.message,
        });
        break;
      }
      pages += 1;
      apiCalls += 1;

      const pageCount = extractTotalCount(payload);
      if (noBillYet && pages === 1 && pageCount === null && extractBillsArray(payload) === null) {
        // REL-46: a 200 with no bill list and no count for a type with no bill yet reads as an empty list, as the
        // error answers above do. The watermark stays put, so nothing is skipped, and the types after it are polled.
        logger.warn(
          "congress.gov answered a 200 with no bill list for a bill type with no bill yet; read as an empty list",
          { congress, billType, status: 200, filtered },
        );
        await emitCongressMetric("BillPollerNoBillYetAnswer", congress, 1);
        noBillYetAnswer = true;
        break;
      }
      if (!backlog && count !== null && pageCount !== null && pageCount > count) risen += pageCount - count;
      const rows = listRowsOf(payload, pageCount, offset, list);
      if (pages === 1) windowRows = pageCount;
      if (rows.length > 0) anyRow = true;

      const rowGuids: Array<string | null> = [];
      const pageMessages: UpdatedBillMessage[] = [];
      let reachedEarlierDay = false;
      for (const row of rows) {
        const msg = toBillMessage(row, billType, congress);
        rowGuids.push(msg?.guid ?? null);
        if (!msg) {
          unnamedRows += 1;
          continue;
        }
        if (!filtered && msg.updateDate && msg.updateDate < fallbackFromDay) {
          reachedEarlierDay = true;
          break;
        }
        if (gate) latestActions.set(msg, latestActionOf(row));
        pageMessages.push(msg);
      }
      await enqueuePage(pageMessages);

      // A backlog resumed on a page with no count cannot be checked for rows that moved since its last page: read its
      // window again from the top.
      if (pages === 1 && backlog && offset > 0 && pageCount === null) {
        logger.warn("congress.gov gave no count to check a backlog against; reading its window again from the top", {
          congress,
          billType,
          offset,
        });
        offset = 0;
        readFrom = 0;
        count = null;
        continue;
      }

      // Drift: the page shares no row with the end of the page before, or a backlog's window lost more rows since its
      // last page than the overlap covers. Rows that left the window above the offset moved the rest up past the
      // overlap, so rows between the two pages may not have been read: read again from further up.
      // Nothing can be missed above offset 0, and a fallback that reached an earlier day is done.
      const tail = previousTail;
      const lostSinceBacklog =
        pages === 1 && backlog?.count !== undefined && pageCount !== null ? backlog.count - pageCount : 0;
      let drifted = false;
      if (offset > 0 && !reachedEarlierDay) {
        drifted =
          tail && tail.size > 0
            ? !rowGuids.some((guid) => guid !== null && tail.has(guid))
            : lostSinceBacklog > PAGE_OVERLAP_ROWS;
      }
      if (drifted) {
        await emitMetric("BillPollerPageDrift", 1);
        const driftLine = {
          congress,
          billType,
          filtered,
          offset,
          rows: rows.length,
          count: pageCount,
          lostSinceBacklog,
        };
        if (stepBacks < MAX_PAGE_DRIFT_STEP_BACKS) {
          stepBacks += 1;
          logger.warn("congress.gov's list moved between two pages; reading it again from further up", {
            ...driftLine,
            stepBack: stepBacks,
          });
          // Back one page within a run; back as many rows as the window lost since a backlog's last page.
          offset = Math.max(0, offset - (tail ? PAGE_STEP_ROWS : lostSinceBacklog));
          readFrom = Math.min(readFrom, offset);
          count = pageCount;
          continue;
        }
        logger.error("congress.gov's list kept moving between pages; rows between them may not have been read", {
          ...driftLine,
          stepBacks,
        });
      }

      // Done when the page reaches the end of the list: its count, or a short page when there is none.
      const end = offset + rows.length;
      if (
        reachedEarlierDay ||
        rows.length === 0 ||
        (pageCount !== null ? end >= pageCount : rows.length < LIST_PAGE_SIZE)
      ) {
        // A window only loses rows while it is read (a row updated again leaves it), so this scan has listed every row
        // it still counts from where its reading began, unless rows moved between pages without a trace: an order that
        // changes from one request to the next among rows with the same time, or rows that showed up late.
        const listedRows = handledGuids.size + unnamedRows;
        const expectedRows = filtered && pageCount !== null ? pageCount - readFrom : 0;
        const shortLine = {
          congress,
          billType,
          from: window.from,
          to: window.to,
          readFrom,
          listedRows,
          count: pageCount,
          risen,
        };
        if (listedRows < expectedRows) {
          // No more short than the count rose by between pages of a window whose top is this run's start: rows that
          // showed in the list while it was read, not page drift. Read again all the same, for any that came more than
          // OVERLAP_SECONDS after their time; one that came within that is in the next window's overlap too.
          const showedWhileRead = expectedRows - listedRows <= risen;
          if (rereads < MAX_WINDOW_REREADS) {
            if (!showedWhileRead) await emitMetric("BillPollerPageDrift", 1);
            rereads += 1;
            logger.warn(
              showedWhileRead
                ? "Rows showed in congress.gov's list while the window was read; reading the window again"
                : "congress.gov's list counted more rows than the scan listed; reading the window again",
              { ...shortLine, reread: rereads },
            );
            offset = readFrom;
            previousTail = null;
            count = pageCount;
            // The reading again lists the rows that showed so far, so only rows that show while it is read can
            // explain what it lacks.
            risen = 0;
            continue;
          }
          // Still short: counted either way. Rows that came more than OVERLAP_SECONDS after their time are in no later
          // window, and the count cannot tell them from rows that came sooner, nor from rows an order among rows with
          // the same time stepped over.
          await emitMetric("BillPollerPageDrift", 1);
          if (showedWhileRead) {
            logger.warn(
              "Rows still showed in congress.gov's list while the window was read; rows that came more than 120 s late may not have been read",
              shortLine,
            );
          } else {
            logger.error(
              "congress.gov's list still counted more rows than the scan listed; rows of the window may not have been read",
              shortLine,
            );
          }
        }
        finalCount = pageCount;
        break;
      }
      // The next page starts PAGE_OVERLAP_ROWS before this one ends, and as many rows earlier again as the window
      // lost since the page before (rows that left it above the offset moved the rest up).
      const lostSincePrevious = count !== null && pageCount !== null ? Math.max(0, count - pageCount) : 0;
      const nextOffset = Math.max(0, end - Math.min(PAGE_OVERLAP_ROWS, rows.length - 1) - lostSincePrevious);
      previousTail = new Set(
        rowGuids.slice(Math.max(0, nextOffset - offset)).filter((guid): guid is string => guid !== null),
      );
      offset = nextOffset;
      count = pageCount;

      logger.info("Poller progress", {
        billType,
        page: pages,
        filtered,
        rows: rows.length,
        count: pageCount,
        nextOffset,
        discovered,
        apiCalls,
        elapsedMs: Date.now() - scanStartedAt,
      });
    }

    const listed = listedBefore || anyRow;
    let nextCursor: BillTypeCursor;
    if (noBillYetAnswer) {
      nextCursor = cursor;
    } else if (incompleteReason === null) {
      // Every row up to the window's top has been listed; the fallback has listed everything up to the run's start.
      nextCursor = cursorAt(filtered ? window.to : runTopIso, listed);
    } else if (pages === 0 || !filtered) {
      // Nothing read (an earlier backlog stays as it was), or the fallback, which keeps no backlog.
      nextCursor = cursor;
    } else {
      // Stopped early: the same window, from where this scan got to, next run; from its top without a count.
      nextCursor = cursorAt(
        window.watermark,
        listed,
        count !== null ? { to: window.to, offset, count } : { to: window.to, offset: 0 },
      );
    }

    // A window this scan read in full, from its top and without a step back, small enough to keep (REL-56).
    const probeTo = Date.parse(window.to) - OVERLAP_SECONDS * 1000;
    const probe: LateRowProbe | null =
      filtered &&
      !backlog &&
      incompleteReason === null &&
      finalCount !== null &&
      stepBacks === 0 &&
      rereads === 0 &&
      unnamedRows === 0 &&
      handledNumbers.size <= PROBE_MAX_ROWS &&
      probeTo > Date.parse(window.from)
        ? { billType, from: window.from, to: new Date(probeTo).toISOString(), numbers: [...handledNumbers] }
        : null;

    return { nextCursor, incompleteReason, pagesScanned: pages, unavailable, windowRows, probe };
  };

  const result = (outcome: ScanOutcome, fallbackUsed: boolean): PollResult => ({
    ...outcome,
    enqueued,
    apiCalls,
    discovered,
    missingUpdateDateCount,
    fallbackUsed,
    stoppedEarlyDueToTime: outcome.incompleteReason === "soft_stop",
  });

  // A run that started before an overlapping run's watermark has nothing to list.
  if (!window.backlog && compareIsoTimes(window.to, window.watermark) <= 0) {
    return result(
      { nextCursor: cursor, incompleteReason: null, pagesScanned: 0, unavailable: null, windowRows: null, probe: null },
      false,
    );
  }

  try {
    return result(await scanMode(true), false);
  } catch (error) {
    if (!shouldFallbackToNewestScan(error)) {
      throw error;
    }

    logger.warn("Filtered scan rejected; switching to fallback newest-page scan", { billType, error });
    return result(await scanMode(false), true);
  }
};

// Each bill starts its pipeline trace here: the correlation id "<runStartedAt>:<guid>" goes in the
// message's correlationId attribute and every later hop copies it (OBS-10, shared/correlation.ts).
const sendBatches = async (messages: UpdatedBillMessage[], runStartedAtIso: string): Promise<number> => {
  if (messages.length === 0) return 0;

  const runStartedAt = new Date(runStartedAtIso);
  let enqueued = 0;
  for (let i = 0; i < messages.length; i += QUEUE_BATCH_SIZE) {
    const batch = messages.slice(i, i + QUEUE_BATCH_SIZE);
    const correlationIds = batch.map((item) => mintCorrelationId(item.guid, runStartedAt));
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: batch.map((item, idx) => ({
          Id: `msg-${i + idx}`,
          MessageBody: JSON.stringify(item),
          ...correlationIdMessageAttributes(correlationIds[idx]),
        })),
      }),
    );

    if (response.Failed && response.Failed.length > 0) {
      const failedGuids: string[] = [];
      for (const failure of response.Failed) {
        const id = toTrimmedString(failure.Id);
        const parsedIndex = id.startsWith("msg-") ? Number.parseInt(id.slice(4), 10) : NaN;
        const relativeIndex = Number.isFinite(parsedIndex) ? parsedIndex - i : -1;
        const guid = relativeIndex >= 0 ? batch[relativeIndex]?.guid : undefined;
        if (guid) failedGuids.push(guid);
      }
      throw new Error(`Failed to enqueue ${response.Failed.length} bill(s): ${failedGuids.join(", ")}`);
    }

    batch.forEach((item, idx) =>
      logger.info("Enqueued bill", {
        guid: item.guid,
        correlationId: correlationIds[idx],
        updateDate: item.updateDate,
      }),
    );
    enqueued += response.Successful ? response.Successful.length : batch.length;
  }

  return enqueued;
};

interface PollRun {
  runStartedAtIso: string;
  runStartedAtMs: number;
  backfillFromIso: string | null;
  /** Where new cursors start: BACKFILL_FROM_ISO, or now. */
  cursorStartIso: string;
  shouldSoftStop: () => boolean;
  remainingMs: () => number;
}

interface PollCounts {
  apiCalls: number;
  discovered: number;
  enqueued: number;
  missingUpdateDate: number;
  fallbackTypes: number;
}

/** What polling one Congress did in a run. */
interface CongressPoll extends PollCounts {
  initialized: boolean;
  stoppedEarlyDueToTime: boolean;
  unavailable: boolean;
  lagSeconds: number;
  /** The state the poll wrote last (null when it initialized one). */
  state: BillsApiPollerState | null;
  /** A late-row probe of this run's PROBE_BILL_TYPE window, when it qualifies (REL-56). */
  probe: LateRowProbe | null;
}

/**
 * Loads one Congress's state and scans every bill type from its cursors, saving after each type. A missing or
 * unparseable state is initialized instead, and nothing is scanned. `legacy` is the poller without POLL_TARGETS: a
 * state for another congress is replaced, as before. Otherwise it is never written: StateMismatchError.
 */
const pollCongress = async (
  target: PollTarget,
  run: PollRun,
  legacy: boolean,
  gate: OutcomeGate | null,
  trailing: boolean,
): Promise<CongressPoll> => {
  const { congress, stateParameterName } = target;
  const { runStartedAtIso, shouldSoftStop, remainingMs } = run;

  let state = await loadState(stateParameterName);
  if (state && state.congress !== congress && !legacy) {
    throw new StateMismatchError(stateParameterName, state.congress, congress);
  }
  if (!state || state.congress !== congress) {
    // REL-46: a Congress that started under 14 days ago starts its cursors at its start, so its first bills are
    // scanned by the next run.
    const startMs = congressStartMs(congress);
    const fromStart = !legacy && run.runStartedAtMs - startMs < 14 * DAY_MS;
    const cursorsStartAt = fromStart ? new Date(startMs).toISOString() : run.cursorStartIso;
    await saveState(buildInitialState(congress, runStartedAtIso, cursorsStartAt), stateParameterName, legacy);
    let message = "Initialized bill poller state; skipping enqueue for forward-only cutover";
    if (fromStart) {
      message = "Initialized bill poller state at the start of its congress; the next run scans forward from it";
    } else if (run.backfillFromIso) {
      message = "Initialized bill poller state from BACKFILL_FROM_ISO; the next run scans forward from it";
    }
    logger.info(message, {
      congress,
      stateParameter: stateParameterName,
      cursorsStartAt,
    });
    return {
      initialized: true,
      apiCalls: 0,
      discovered: 0,
      enqueued: 0,
      missingUpdateDate: 0,
      fallbackTypes: 0,
      stoppedEarlyDueToTime: false,
      unavailable: false,
      lagSeconds: 0,
      state: null,
      probe: null,
    };
  }

  state = ensureAllCursors(state, run.cursorStartIso);
  const { probe: storedProbe } = state;
  // REL-46: a bill type congress.gov has not listed a bill of (REL-56: `listed` still false; the watermark moves on
  // with every empty list), with no backlog, has had no bill yet. Not without POLL_TARGETS.
  const withinNoBillYetWindow =
    !legacy && run.runStartedAtMs - congressStartMs(congress) < NO_BILL_YET_WINDOW_DAYS * DAY_MS;
  const runTopIso = floorToSecondIso(runStartedAtIso);

  let totalApiCalls = 0;
  let totalDiscovered = 0;
  let totalMissingUpdateDate = 0;
  let fallbackTypeCount = 0;
  const nextCursors: Record<string, BillTypeCursor> = { ...state.cursors };
  // The cursors as this run last read or wrote them: a stored cursor still equal to its own was written by no other run.
  let savedCursors: Record<string, BillTypeCursor> = { ...state.cursors };
  let lastPolledAt = state.lastPolledAt;
  let totalEnqueued = 0;
  let stoppedEarlyDueToTime = false;
  let unavailable: { billType: string; error: CongressApiUnavailableError; pagesScanned: number } | null = null;
  let probe: LateRowProbe | null = null;

  logger.info("Starting bills API poll", {
    billTypes: BILL_TYPES,
    maxPagesPerType: MAX_PAGES_PER_BILL_TYPE,
    queueBatchSize: QUEUE_BATCH_SIZE,
    requestTimeoutMs: CONGRESS_API_REQUEST_TIMEOUT_MS,
    softStopRemainingMs: SOFT_STOP_REMAINING_MS,
  });

  for (const billType of BILL_TYPES) {
    if (shouldSoftStop()) {
      stoppedEarlyDueToTime = true;
      break;
    }

    const cursor = nextCursors[billType] ?? newCursor(state.lastRunAt);
    const window = scanWindowFor(cursor, runTopIso);

    const typeStartedAt = Date.now();
    logger.info("Polling bill type", {
      billType,
      watermark: window.watermark,
      listed: isListed(cursor),
      from: window.from,
      to: window.to,
      backlog: window.backlog,
    });

    const noBillYet = withinNoBillYetWindow && !isListed(cursor) && !cursor.backlog;
    const result = await pollBillType(
      congress,
      billType,
      cursor,
      runStartedAtIso,
      shouldSoftStop,
      remainingMs,
      gate,
      noBillYet,
    );
    nextCursors[billType] = result.nextCursor;
    if (billType === PROBE_BILL_TYPE) probe = result.probe;

    totalApiCalls += result.apiCalls;
    totalDiscovered += result.discovered;
    totalMissingUpdateDate += result.missingUpdateDateCount;
    if (result.fallbackUsed) fallbackTypeCount += 1;

    const enqueuedForType = result.enqueued;
    totalEnqueued += enqueuedForType;

    const savedState = await saveState(
      {
        schemaVersion: 1,
        congress,
        lastRunAt: new Date().toISOString(),
        lastPolledAt,
        cursors: nextCursors,
        ...(storedProbe ? { probe: storedProbe } : {}),
      },
      stateParameterName,
      legacy,
      savedCursors,
    );
    // Carry the written cursors forward, so a bill type an overlapping run already advanced is
    // scanned from its cursor and later saves do not report the same merge again.
    Object.assign(nextCursors, savedState.cursors);
    savedCursors = { ...savedState.cursors };
    lastPolledAt = savedState.lastPolledAt;

    // An outage is reported once, below, with the run's outcome.
    if (result.incompleteReason && result.incompleteReason !== "upstream_unavailable") {
      logger.warn("Bill-type scan incomplete; watermark kept, the next run reads the rest of the window", {
        billType,
        reason: result.incompleteReason,
        pagesScanned: result.pagesScanned,
        cursor: result.nextCursor,
      });
    }
    logger.info("Saved bill poller cursor", {
      billType,
      // Whether the watermark moved: not for an answer read as empty, a scan cut short or a run with nothing to list.
      advanced: effectiveWatermark(result.nextCursor) !== window.watermark,
      cursor: savedState.cursors[billType],
    });

    logger.info("Completed bill type", {
      billType,
      apiCalls: result.apiCalls,
      discovered: result.discovered,
      enqueued: enqueuedForType,
      missingUpdateDate: result.missingUpdateDateCount,
      fallbackUsed: result.fallbackUsed,
      stoppedEarlyDueToTime: result.stoppedEarlyDueToTime,
      incompleteReason: result.incompleteReason,
      windowRows: result.windowRows,
      pages: result.pagesScanned,
      elapsedMs: Date.now() - typeStartedAt,
    });

    if (result.unavailable) {
      // The other bill types would meet the same outage; the next run starts again from every saved cursor.
      unavailable = { billType, error: result.unavailable, pagesScanned: result.pagesScanned };
      break;
    }

    if (result.stoppedEarlyDueToTime) {
      stoppedEarlyDueToTime = true;
      break;
    }
  }

  // A run that met no outage has polled congress.gov up to its start (an overlapping run may have got further). A
  // trailing Congress counts as polled only when the run reached every bill type, so one that soft stops every run
  // keeps its lag growing.
  if (!unavailable && !(trailing && stoppedEarlyDueToTime) && compareIsoTimes(runStartedAtIso, lastPolledAt) > 0) {
    lastPolledAt = runStartedAtIso;
  }
  const finalState = await saveState(
    {
      schemaVersion: 1,
      congress,
      lastRunAt: new Date().toISOString(),
      lastPolledAt,
      cursors: nextCursors,
      ...(storedProbe ? { probe: storedProbe } : {}),
    },
    stateParameterName,
    legacy,
    savedCursors,
  );
  logger.info("Saved bill poller state", {
    stateParameter: stateParameterName,
    lastRunAt: finalState.lastRunAt,
    lastPolledAt: finalState.lastPolledAt,
    cursors: finalState.cursors,
  });

  // Time since the start of the last run that polled congress.gov, measured as this run ends, so it says how stale
  // the data is now. After a poll it is about this run's own duration: the run that recovers from an outage reports a
  // fresh poll, not the staleness it started from, so it never fires Billboard-Ingestion-BillPollerLag itself. A run
  // that finds congress.gov unavailable ends normally but leaves lastPolledAt alone, so the lag keeps growing through
  // an outage and the alarm fires after an hour of it. With POLL_TARGETS each Congress's lag is measured as its own
  // poll ends.
  const lagSeconds = Math.max(0, Math.floor((Date.now() - new Date(finalState.lastPolledAt).getTime()) / 1000));

  if (unavailable) {
    const { billType, error, pagesScanned } = unavailable;
    // The one warning an outage run writes (its retries are logged at INFO); no stack, no error level: nothing on
    // our side is wrong, and the next run catches up from the cursors.
    logger.warn("congress.gov unavailable; run ended early with every cursor kept", {
      billType,
      path: error.path,
      status: error.status,
      reason: error.reason,
      attempts: error.attempts,
      pagesScanned,
      billTypesNotPolled: BILL_TYPES.slice(BILL_TYPES.indexOf(billType) + 1),
      cursor: finalState.cursors[billType],
      lastPolledAt: finalState.lastPolledAt,
      lagSeconds,
    });
  }

  return {
    initialized: false,
    apiCalls: totalApiCalls,
    discovered: totalDiscovered,
    enqueued: totalEnqueued,
    missingUpdateDate: totalMissingUpdateDate,
    fallbackTypes: fallbackTypeCount,
    stoppedEarlyDueToTime,
    unavailable: unavailable !== null,
    lagSeconds,
    state: finalState,
    probe,
  };
};

// The run's totals. lagSeconds null emits no BillPollerLagSeconds: Billboard-Heartbeat-BillsApiPoller treats the
// missing datapoint as breaching (the lag alarm does not: missing data is not breaching there).
const runMetrics = (counts: PollCounts, lagSeconds: number | null, unavailable: boolean): Array<Promise<void>> => {
  const metrics: Array<Promise<void>> = [
    emitMetric("CongressApiCallsLister", counts.apiCalls),
    emitMetric("BillsDiscovered", counts.discovered),
    emitMetric("BillsEnqueued", counts.enqueued),
  ];
  if (lagSeconds !== null) {
    metrics.push(emitMetric("BillPollerLagSeconds", lagSeconds, "Seconds"));
  }

  if (unavailable) {
    metrics.push(emitMetric("CongressApiUnavailable", 1));
  }

  if (counts.missingUpdateDate > 0) {
    metrics.push(emitMetric("BillPollerMissingUpdateDate", counts.missingUpdateDate));
  }

  if (counts.fallbackTypes > 0) {
    metrics.push(emitMetric("BillPollerFallbackTypeCount", counts.fallbackTypes));
  }
  return metrics;
};

// A poll that reached every bill type: not an initialization, an outage or a soft stop.
const polledInFull = (poll: CongressPoll): boolean =>
  !poll.initialized && !poll.unavailable && !poll.stoppedEarlyDueToTime;

const hourlyChecksDue = (run: PollRun): boolean =>
  FILTER_PRECISION_CHECK === "hourly" && new Date(run.runStartedAtMs).getUTCMinutes() < SCHEDULE_MINUTES;

// One attempt, no retry: an hourly check is not worth a run's time while congress.gov is slow.
const fetchCongressJsonOnce = (url: string, remainingMs: () => number): Promise<UnknownRecord> =>
  fetchCongressJson(url, remainingMs, CONGRESS_API_MAX_RETRIES);

/**
 * REL-56: the watermark relies on congress.gov's fromDateTime/toDateTime filter working well below a day, although its
 * rows show updateDate as a date only. On 2026-11-08 two 12-hour halves of a day added up to the whole day (RUNBOOK 6);
 * nothing finer has been checked. A coarser filter would skip nothing, but every run would enqueue every bill of the
 * day (or hour) again. So the first run of each hour counts hr rows (limit 1, pagination.count only) over the whole day
 * before, then over one second of it, 18:00:00Z to 18:00:01Z, for the first polled Congress with at least
 * FILTER_CHECK_MIN_DAY_ROWS rows that day. That second counting as many rows as the day, or more than
 * FILTER_CHECK_MAX_SECOND_ROWS, logs an error and counts BillPollerFilterImprecise; so does an answer with no
 * pagination.count, or congress.gov rejecting the filter (400 or 422), since the check cannot tell then. Any other
 * failure only warns. One attempt per request; it never changes what is enqueued. Returns the list calls answered.
 */
const checkFilterPrecision = async (congresses: string[], run: PollRun): Promise<number> => {
  const dayStartMs = Date.parse(startOfUtcDayIso(run.runStartedAtIso)) - DAY_MS;
  const day = { from: new Date(dayStartMs).toISOString(), to: new Date(dayStartMs + DAY_MS - 1000).toISOString() };
  const secondStartMs = dayStartMs + FILTER_CHECK_HOUR_UTC * 60 * 60 * 1000;
  const second = { from: new Date(secondStartMs).toISOString(), to: new Date(secondStartMs + 1000).toISOString() };
  let calls = 0;
  const countRows = async (congress: string, window: { from: string; to: string }): Promise<number | null> => {
    const payload = await fetchCongressJsonOnce(
      buildListUrl(congress, FILTER_CHECK_BILL_TYPE, 0, window, 1),
      run.remainingMs,
    );
    calls += 1;
    return extractTotalCount(payload);
  };
  const flag = async (message: string, line: Record<string, unknown>): Promise<void> => {
    logger.error(message, line);
    await emitMetric("BillPollerFilterImprecise", 1);
  };
  const noCount = "Could not confirm congress.gov's list filter: its answer has no pagination.count";

  for (const congress of congresses) {
    const line = { congress, billType: FILTER_CHECK_BILL_TYPE, day: day.from.slice(0, 10), second: second.from };
    try {
      if (run.shouldSoftStop()) return calls;
      const dayRows = await countRows(congress, day);
      if (dayRows === null) {
        await flag(noCount, line);
        return calls;
      }
      if (dayRows < FILTER_CHECK_MIN_DAY_ROWS) continue;
      if (run.shouldSoftStop()) return calls;
      const secondRows = await countRows(congress, second);
      const counted = { ...line, dayRows, secondRows, maxSecondRows: FILTER_CHECK_MAX_SECOND_ROWS };
      if (secondRows === null) {
        await flag(noCount, counted);
      } else if (secondRows >= dayRows || secondRows > FILTER_CHECK_MAX_SECOND_ROWS) {
        await flag(
          "congress.gov's list filter matched too many rows in one second; it may not work below an hour or a day",
          counted,
        );
      } else {
        logger.info("Checked congress.gov's list filter", counted);
      }
      return calls;
    } catch (error) {
      const reason = describeRequestFailure(error);
      if (error instanceof CongressApiError && (error.status === 400 || error.status === 422)) {
        await flag("Could not confirm congress.gov's list filter: congress.gov rejected it", {
          ...line,
          status: error.status,
          reason,
        });
      } else {
        logger.warn("Could not check congress.gov's list filter; the next hour checks again", { ...line, reason });
      }
      return calls;
    }
  }
  logger.info("Too few rows the day before to check congress.gov's list filter", {
    congresses,
    billType: FILTER_CHECK_BILL_TYPE,
    day: day.from.slice(0, 10),
    minDayRows: FILTER_CHECK_MIN_DAY_ROWS,
  });
  return calls;
};

/**
 * REL-56: the overlap covers a bill that shows in congress.gov's list up to OVERLAP_SECONDS after its time (or a
 * congress.gov clock up to that far behind ours); a bill that shows later than that is in no window. So the first run of
 * each hour lists again the probe (LateRowProbe) the newest Congress's state keeps from the hour before: a bill in it
 * now that was not listed then came late. It is enqueued now, counted (BillPollerLateRows) and logged as a warning.
 * Then the state keeps this run's own probe, if it has one. A failed request only warns and keeps the old probe for the
 * next hour. One attempt. Returns the list calls answered and the bills enqueued.
 */
const checkLateRows = async (
  target: PollTarget,
  poll: CongressPoll,
  run: PollRun,
  legacy: boolean,
): Promise<{ apiCalls: number; enqueued: number }> => {
  const { congress, stateParameterName } = target;
  const { state } = poll;
  if (!state) return { apiCalls: 0, enqueued: 0 };
  const old = state.probe;
  let keepOld = false;
  let apiCalls = 0;
  let enqueued = 0;
  if (old && run.shouldSoftStop()) {
    keepOld = true;
  } else if (old) {
    const line = { congress, billType: old.billType, from: old.from, to: old.to };
    try {
      const payload = await fetchCongressJsonOnce(
        buildListUrl(congress, old.billType, 0, { from: old.from, to: old.to }),
        run.remainingMs,
      );
      apiCalls += 1;
      const listedThen = new Set(old.numbers);
      const late = collapseToLatestPerGuid(
        (extractBillsArray(payload) ?? [])
          .map((row) => toBillMessage(row, old.billType, congress))
          .filter(
            (message): message is UpdatedBillMessage => message !== null && !listedThen.has(message.billNumber ?? ""),
          ),
      );
      if (late.length > 0) {
        enqueued = await sendBatches(late, run.runStartedAtIso);
        await emitMetric("BillPollerLateRows", late.length);
        logger.warn("Bills showed in congress.gov's list after their window was read; enqueued them now", {
          ...line,
          late: late.length,
          guids: late.slice(0, 10).map((message) => message.guid),
        });
      } else {
        logger.info("Listed a window read an hour ago again; no bill in it came late", {
          ...line,
          listedThen: listedThen.size,
        });
      }
    } catch (error) {
      keepOld = true;
      logger.warn("Could not list a window read an hour ago again; the next hour tries again", {
        ...line,
        reason: describeRequestFailure(error),
      });
    }
  }

  const next = keepOld ? old : (poll.probe ?? undefined);
  if (JSON.stringify(next ?? null) !== JSON.stringify(old ?? null)) {
    await saveState(
      {
        schemaVersion: 1,
        congress: state.congress,
        lastRunAt: state.lastRunAt,
        lastPolledAt: state.lastPolledAt,
        cursors: state.cursors,
        ...(next ? { probe: next } : {}),
      },
      stateParameterName,
      legacy,
      state.cursors,
    );
  }
  return { apiCalls, enqueued };
};

/** REL-56: the first run of each hour, once the newest Congress was polled in full: both checks, while time remains. */
const runHourlyChecks = async (
  target: PollTarget,
  poll: CongressPoll,
  congresses: string[],
  run: PollRun,
  legacy: boolean,
): Promise<{ apiCalls: number; enqueued: number }> => {
  if (!polledInFull(poll) || !hourlyChecksDue(run)) return { apiCalls: 0, enqueued: 0 };
  const filterCalls = await checkFilterPrecision(congresses, run);
  const late = await checkLateRows(target, poll, run, legacy);
  return { apiCalls: filterCalls + late.apiCalls, enqueued: late.enqueued };
};

/**
 * REL-46: one run over POLL_TARGETS. Congresses that have started are polled newest first: the primary every run, the
 * trailing ones after it while time remains, through their outcome gate. A Congress whose state holds another
 * congress is skipped. A Congress that fails is logged and counted, its cursors kept, and the next one is polled; the
 * run fails only when every Congress it polled failed. An outage ends the run, as before.
 */
const pollTargets = async (targets: PollTarget[], run: PollRun) => {
  const started = targets
    .filter((target) => congressStartMs(target.congress) <= run.runStartedAtMs)
    .sort((a, b) => Number.parseInt(b.congress, 10) - Number.parseInt(a.congress, 10));
  logger.info("Polling congresses", {
    primary: started[0]?.congress ?? null,
    trailing: started.slice(1).map((target) => target.congress),
    notStarted: targets
      .filter((target) => !started.includes(target))
      .map((target) => ({
        congress: target.congress,
        startsAt: new Date(congressStartMs(target.congress)).toISOString(),
      })),
  });

  const totals: PollCounts = { apiCalls: 0, discovered: 0, enqueued: 0, missingUpdateDate: 0, fallbackTypes: 0 };
  const metrics: Array<Promise<void>> = [];
  const failures: unknown[] = [];
  const notPolled: string[] = [];
  let polled = 0;
  let initialized = false;
  let unavailable = false;
  let stoppedEarlyDueToTime = false;
  let primaryLagSeconds: number | null = null;
  let primary: { target: PollTarget; poll: CongressPoll } | null = null;
  // The Congresses polled without an error, newest first: the filter check's candidates.
  const polledCongresses: string[] = [];

  for (const [index, target] of started.entries()) {
    const { congress } = target;
    const trailing = index > 0;
    if (trailing && (unavailable || stoppedEarlyDueToTime || run.shouldSoftStop())) {
      notPolled.push(...started.slice(index).map((later) => later.congress));
      break;
    }

    const gate: OutcomeGate | null =
      trailing && TRAILING_ENQUEUE !== "all"
        ? {
            actionCutoff: TRAILING_ACTION_CUTOFF || defaultTrailingActionCutoff(congress),
            enqueued: 0,
            skipped: 0,
            sample: [],
          }
        : null;
    let poll: CongressPoll;
    try {
      poll = await logger.withKeys({ congress }, () => pollCongress(target, run, false, gate, trailing));
    } catch (error) {
      if (error instanceof StateMismatchError) {
        logger.error("Bill poller state is stored for another congress; skipped that congress, state not overwritten", {
          congress,
          storedCongress: error.storedCongress,
          stateParameter: error.stateParameter,
        });
        await Promise.all([
          emitCongressMetric("BillPollerStateMismatch", congress, 1),
          emitMetric("BillPollerStateMismatch", 1),
        ]);
        continue;
      }
      // congress.gov answering 4xx for a bill type that has had bills, say (a type with no bill yet reads it as an
      // empty list): the others are still polled. The cursor stays where the last finished bill type left it.
      polled += 1;
      failures.push(error);
      logger.error("Bill poller failed for a congress; its cursor kept, polling the next one", {
        congress,
        stateParameter: target.stateParameterName,
        error,
      });
      await emitCongressMetric("BillPollerTargetError", congress, 1);
      continue;
    }

    if (!poll.initialized) polled += 1;
    polledCongresses.push(congress);
    initialized ||= poll.initialized;
    unavailable ||= poll.unavailable;
    stoppedEarlyDueToTime ||= poll.stoppedEarlyDueToTime;
    totals.apiCalls += poll.apiCalls;
    totals.discovered += poll.discovered;
    totals.enqueued += poll.enqueued;
    totals.missingUpdateDate += poll.missingUpdateDate;
    totals.fallbackTypes += poll.fallbackTypes;
    // The lag without a dimension is the primary's, so Billboard-Ingestion-BillPollerLag keeps its meaning (and the
    // primary's missing datapoint is what Billboard-Heartbeat-BillsApiPoller watches).
    // Sent now, not with the run's totals, so a timeout while polling the trailing Congresses cannot drop it.
    if (!trailing) {
      primary = { target, poll };
      primaryLagSeconds = poll.lagSeconds;
      await emitMetric("BillPollerLagSeconds", poll.lagSeconds, "Seconds");
    }
    metrics.push(emitCongressMetric("BillPollerLagSeconds", congress, poll.lagSeconds, "Seconds"));

    if (gate) {
      metrics.push(
        emitCongressMetric("BillPollerTrailingEnqueued", congress, gate.enqueued),
        emitCongressMetric("BillPollerTrailingSkipped", congress, gate.skipped),
      );
      if (gate.skipped > 0) {
        // Bill numbers and public action text only, to check what the gate holds back.
        logger.info("Trailing congress updates held back by the outcome gate", {
          congress,
          enqueued: gate.enqueued,
          skipped: gate.skipped,
          actionCutoff: gate.actionCutoff,
          sample: gate.sample,
        });
      }
    }
  }

  // After every Congress, so a slow check never takes time from the trailing poll.
  if (primary) {
    const checks = await runHourlyChecks(primary.target, primary.poll, polledCongresses, run, false);
    totals.apiCalls += checks.apiCalls;
    totals.enqueued += checks.enqueued;
    totals.discovered += checks.enqueued;
  }

  metrics.push(...runMetrics(totals, null, unavailable));
  await Promise.all(metrics);

  logger.info("Completed bills API poll", {
    apiCalls: totals.apiCalls,
    discovered: totals.discovered,
    enqueued: totals.enqueued,
    missingUpdateDate: totals.missingUpdateDate,
    fallbackTypes: totals.fallbackTypes,
    stoppedEarlyDueToTime,
    congressApiUnavailable: unavailable,
    lagSeconds: primaryLagSeconds,
    failedCongresses: failures.length,
    notPolled,
    elapsedMs: Date.now() - run.runStartedAtMs,
  });

  if (failures.length > 0 && failures.length === polled) throw failures[0];

  return {
    status: unavailable ? "congress_api_unavailable" : "ok",
    processed: totals.enqueued,
    discovered: totals.discovered,
    initialized,
  };
};

export const handler = async (_event?: unknown, context?: PollerContextLike) => {
  logger.resetContext(context);
  if (!SECRET_NAME) throw new Error("Missing env var SECRET_NAME");
  const targets = POLL_TARGETS ? parsePollTargets(POLL_TARGETS) : null;
  if (!targets && !STATE_PARAMETER_NAME) throw new Error("Missing env var STATE_PARAMETER_NAME");
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");
  if (!targets && !POLL_CONGRESS) throw new Error("Missing env var POLL_CONGRESS");
  if (targets && TRAILING_ENQUEUE !== "outcomes" && TRAILING_ENQUEUE !== "all") {
    throw new Error("Invalid env var TRAILING_ENQUEUE (expected outcomes or all)");
  }
  if (
    targets &&
    TRAILING_ACTION_CUTOFF &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(TRAILING_ACTION_CUTOFF) || Number.isNaN(Date.parse(TRAILING_ACTION_CUTOFF)))
  ) {
    throw new Error("Invalid env var TRAILING_ACTION_CUTOFF (expected YYYY-MM-DD)");
  }
  if (FILTER_PRECISION_CHECK !== "hourly" && FILTER_PRECISION_CHECK !== "off") {
    throw new Error("Invalid env var FILTER_PRECISION_CHECK (expected hourly or off)");
  }
  if (!Number.isFinite(QUEUE_BATCH_SIZE) || QUEUE_BATCH_SIZE <= 0 || QUEUE_BATCH_SIZE > 10) {
    throw new Error("Invalid env var QUEUE_BATCH_SIZE");
  }
  if (!Number.isFinite(MAX_PAGES_PER_BILL_TYPE) || MAX_PAGES_PER_BILL_TYPE <= 0) {
    throw new Error("Invalid env var MAX_PAGES_PER_BILL_TYPE");
  }
  if (!Number.isFinite(CONGRESS_API_MAX_RETRIES) || CONGRESS_API_MAX_RETRIES < 0) {
    throw new Error("Invalid env var CONGRESS_API_MAX_RETRIES");
  }
  if (!Number.isFinite(CONGRESS_API_BASE_DELAY_MS) || CONGRESS_API_BASE_DELAY_MS < 0) {
    throw new Error("Invalid env var CONGRESS_API_BASE_DELAY_MS");
  }
  if (!Number.isFinite(CONGRESS_API_MAX_DELAY_MS) || CONGRESS_API_MAX_DELAY_MS < 0) {
    throw new Error("Invalid env var CONGRESS_API_MAX_DELAY_MS");
  }
  if (!Number.isFinite(CONGRESS_API_REQUEST_TIMEOUT_MS) || CONGRESS_API_REQUEST_TIMEOUT_MS <= 0) {
    throw new Error("Invalid env var CONGRESS_API_REQUEST_TIMEOUT_MS");
  }
  if (!Number.isFinite(SOFT_STOP_REMAINING_MS) || SOFT_STOP_REMAINING_MS < 0) {
    throw new Error("Invalid env var SOFT_STOP_REMAINING_MS");
  }
  if (CONGRESS_API_MAX_DELAY_MS < CONGRESS_API_BASE_DELAY_MS) {
    throw new Error("CONGRESS_API_MAX_DELAY_MS must be >= CONGRESS_API_BASE_DELAY_MS");
  }
  if (BILL_TYPES.length === 0) {
    throw new Error("BILL_TYPES must include at least one bill type");
  }

  const runStartedAtIso = new Date().toISOString();
  const runStartedAtMs = Date.now();
  const backfillFromIso = parseBackfillFromIso(runStartedAtMs);
  const cursorStartIso = backfillFromIso ?? runStartedAtIso;

  const remainingMs = (): number => {
    const remaining = context?.getRemainingTimeInMillis?.();
    return Number.isFinite(remaining) ? (remaining as number) : Number.POSITIVE_INFINITY;
  };

  let softStopLogged = false;
  // Stop before starting a request that might not finish inside the Lambda timeout.
  const shouldSoftStop = (): boolean => {
    const remaining = remainingMs();
    if (remaining > REQUEST_TIME_RESERVE_MS) return false;
    if (!softStopLogged) {
      softStopLogged = true;
      logger.warn("Approaching Lambda timeout; switching to graceful stop", {
        remainingTimeMs: remaining,
        softStopRemainingMs: SOFT_STOP_REMAINING_MS,
        requestTimeReserveMs: REQUEST_TIME_RESERVE_MS,
      });
    }
    return true;
  };

  const run: PollRun = {
    runStartedAtIso,
    runStartedAtMs,
    backfillFromIso,
    cursorStartIso,
    shouldSoftStop,
    remainingMs,
  };
  if (targets) return pollTargets(targets, run);

  // Without POLL_TARGETS: POLL_CONGRESS alone, from STATE_PARAMETER_NAME, as before REL-46.
  const target: PollTarget = { congress: POLL_CONGRESS, stateParameterName: STATE_PARAMETER_NAME };
  const poll = await pollCongress(target, run, true, null, false);
  const checks = await runHourlyChecks(target, poll, [POLL_CONGRESS], run, true);
  poll.apiCalls += checks.apiCalls;
  poll.enqueued += checks.enqueued;
  poll.discovered += checks.enqueued;
  await Promise.all(runMetrics(poll, poll.lagSeconds, poll.unavailable));
  if (poll.initialized) {
    return {
      status: "ok",
      processed: 0,
      discovered: 0,
      initialized: true,
    };
  }

  logger.info("Completed bills API poll", {
    apiCalls: poll.apiCalls,
    discovered: poll.discovered,
    enqueued: poll.enqueued,
    missingUpdateDate: poll.missingUpdateDate,
    fallbackTypes: poll.fallbackTypes,
    stoppedEarlyDueToTime: poll.stoppedEarlyDueToTime,
    congressApiUnavailable: poll.unavailable,
    lagSeconds: poll.lagSeconds,
    elapsedMs: Date.now() - runStartedAtMs,
  });

  return {
    status: poll.unavailable ? "congress_api_unavailable" : "ok",
    processed: poll.enqueued,
    discovered: poll.discovered,
    initialized: false,
  };
};
