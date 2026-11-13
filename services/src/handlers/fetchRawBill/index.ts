import { S3Client } from "@aws-sdk/client-s3";
import { ChangeMessageVisibilityCommand, SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import type { IncomingHttpHeaders } from "http";
import { request as httpsRequest } from "https";
import { BillIdentifier, OfficialVotesBreakdown, RawBill } from "../../models/bill";
import { isPreconditionFailure, type StoredJson } from "../../adapters/billStorage";
import { RawBillDao } from "../../adapters/rawBillDao";
import { CONGRESS_API_BASE_URL } from "../../shared/apiBaseUrls";
import { plainBillGuid } from "../../shared/billCompanions";
import { decideMemberVoteCarry, rawFetchedAt, type MemberVoteCarryDecision } from "../../shared/billSourceReconcile";
import {
  getCongressApiKey,
  invalidateCongressApiKey,
  isCongressApiAuthFailureStatus,
} from "../../shared/congressApiKey";
import { extractOfficialVotesFromActions, hasVoteRelatedActionForChamber } from "../../shared/congressVotes";
import {
  correlationIdFromMetadata,
  correlationIdFromRecord,
  correlationIdMessageAttributes,
  mintCorrelationId,
} from "../../shared/correlation";
import {
  applySocketTimeout,
  BILLBOARD_FETCHER_USER_AGENT,
  isNetworkError,
  isTimeoutError,
  TimeoutError,
} from "../../shared/http";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { putMetric, putMetrics } from "../../shared/metrics";
import { isRetryableStatus, retryDelayMs, sleep } from "../../shared/retry";
import { reportUnprocessableMessage } from "../../shared/unprocessableMessages";
import {
  billTextRequests,
  billVersionStem,
  fetchBillText,
  LAMBDA_TIME_MARGIN_MS,
  locateBillXmlUrl,
  parseBillXmlSources,
  timeBudget,
  type BillTextSource,
  type BillXmlFetchMarker,
  type SourceResultKind,
} from "./billText";
import {
  decideRefetchUnchanged,
  parseRefetchUnchangedMode,
  type RefetchUnchangedDecision,
  type RefetchUnchangedInput,
  type RefetchUnchangedMode,
} from "./refetchUnchanged";
import {
  BillEndpointError,
  classifyRecordFailure,
  CongressApiFailure,
  congressFailureKindOfStatus,
  decideRetry,
  isBulkMessage,
  listingToStore,
  messageListing,
  parseFetchRetryBackoffMode,
  parseRetryLadder,
  queueUrlFromArn,
  type CongressFailureKind,
  type MessageListing,
  type RetryLadder,
} from "./retryLadder";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const SECRET_NAME = process.env.SECRET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const VOTE_ENRICHMENT_QUEUE_URL = process.env.VOTE_ENRICHMENT_QUEUE_URL;
const QUEUE_BATCH_SIZE = Number.parseInt(process.env.QUEUE_BATCH_SIZE!, 10);
const CONGRESS_API_MAX_CALLS_PER_BILL = Number.parseInt(process.env.CONGRESS_API_MAX_CALLS_PER_BILL ?? "10", 10);

const CONGRESS_API_MAX_RETRIES = Number.parseInt(process.env.CONGRESS_API_MAX_RETRIES ?? "2", 10);
const CONGRESS_API_BASE_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_BASE_DELAY_MS ?? "500", 10);
const CONGRESS_API_MAX_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_MAX_DELAY_MS ?? "5000", 10);
const CONGRESS_API_CALL_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_CALL_DELAY_MS ?? "1200", 10);
const CONGRESS_API_ACTIONS_PAGE_LIMIT = Number.parseInt(process.env.CONGRESS_API_ACTIONS_PAGE_LIMIT ?? "250", 10);
// congress.gov returns 20 list items per page unless asked for more (250 is its maximum).
const CONGRESS_API_COSPONSORS_PAGE_LIMIT = Number.parseInt(process.env.CONGRESS_API_COSPONSORS_PAGE_LIMIT ?? "250", 10);
// The House has 441 members including delegates, so four full pages (1,000 cosponsors) is a
// safety stop, not a real limit.
const CONGRESS_API_COSPONSORS_MAX_PAGES = 4;
// relatedbills rows per page: congress.gov's maximum. The largest live list is 85 rows, so one page
// holds every bill seen so far (APPF-23).
const RELATED_BILLS_PAGE_LIMIT = 250;
// Extra relatedbills pages followed through pagination.next before the list is flagged as truncated.
const RELATED_BILLS_MAX_EXTRA_PAGES = 3;
// pagination.next is followed only to this host (and only to the same relatedbills path).
const CONGRESS_API_HOST = "api.congress.gov";
// Socket inactivity timeout for every congress.gov request; a stalled socket is retried like a network error.
const CONGRESS_API_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CONGRESS_API_REQUEST_TIMEOUT_MS ?? "10000", 10);

const METRIC_NAMESPACE = "BillBoard/BillIngestion";
const RETRY_BACKOFF = { baseMs: CONGRESS_API_BASE_DELAY_MS, maxMs: CONGRESS_API_MAX_DELAY_MS };

const positiveIntegerEnv = (name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? Math.min(value, max) : fallback;
};

/**
 * REL-45: bill text. The newest text version's XML is read from the sources in BILL_XML_SOURCES (default GovInfo,
 * then congress.gov; "congress" alone is the rollback switch) inside BILL_XML_FETCH_BUDGET_MS, and a host that
 * refused this environment is skipped for BILL_XML_REFUSED_HOST_COOLDOWN_MS (billText.ts). With
 * BILL_XML_REUSE_SAME_VERSION on (anything but "off"), a bill whose stored raw copy already has the text of the same
 * version is not fetched again. When every source refused, the bill is stored (with the previous text of the same
 * version, if any) and sent again to TEXT_RETRY_QUEUE_URL (UpdatedBillsQueue) after BILL_TEXT_RETRY_DELAY_SECONDS,
 * at most BILL_TEXT_MAX_RETRIES times; anything else that leaves the bill without text is final, as before.
 */
const BILL_XML_SOURCES: BillTextSource[] = parseBillXmlSources(process.env.BILL_XML_SOURCES);
const BILL_XML_REUSE_SAME_VERSION = (process.env.BILL_XML_REUSE_SAME_VERSION ?? "on").trim().toLowerCase() !== "off";
const TEXT_RETRY_QUEUE_URL = process.env.TEXT_RETRY_QUEUE_URL ?? "";
// SQS allows a delay of at most 900 s.
const BILL_TEXT_RETRY_DELAY_SECONDS = positiveIntegerEnv("BILL_TEXT_RETRY_DELAY_SECONDS", 600, 900);
const BILL_TEXT_MAX_RETRIES = positiveIntegerEnv("BILL_TEXT_MAX_RETRIES", 3, 10);
const BILL_XML_FETCH_BUDGET_MS = positiveIntegerEnv("BILL_XML_FETCH_BUDGET_MS", 40_000) || 40_000;
const BILL_XML_REFUSED_HOST_COOLDOWN_MS = positiveIntegerEnv("BILL_XML_REFUSED_HOST_COOLDOWN_MS", 600_000);

/**
 * X7, REL-35 (C2 3.9): whether a refetch keeps the member votes enrichOfficialVotes added. Both modes
 * read the previous raw bill (one S3 GET) and decide with decideMemberVoteCarry.
 * - "on": the decided votes are stored, over the ETag that was read (IfMatch; no condition for a new
 *   bill). A refused write (enrichOfficialVotes wrote in between) is re-read, re-decided and retried,
 *   3 attempts in all, then the record fails and SQS retries it. A carried chamber is not sent to
 *   BillVoteEnrichmentQueue. MemberVotesCarried = the chambers kept.
 * - "watch", for any other value or none: the decision is logged and MemberVotesCarriable counts the
 *   chambers that would be kept; the bill is then stored exactly as before (same body, no IfMatch)
 *   and enrichment is queued as before. A failed read is logged and changes nothing.
 * Ships as "watch" (infra, FetchRawBill env MEMBER_VOTE_CARRY_MODE); flip to "on" before REL-32.
 */
type MemberVoteCarryMode = "watch" | "on";
const MEMBER_VOTE_CARRY_MODE: MemberVoteCarryMode = process.env.MEMBER_VOTE_CARRY_MODE === "on" ? "on" : "watch";
/** Conditional raw-bill writes per record in "on" mode before the record fails (as RECONCILE_MAX_ATTEMPTS). */
const RAW_BILL_WRITE_MAX_ATTEMPTS = 3;

/**
 * REL-57: a poller refetch whose result equals the stored copy (refetchUnchanged.ts: decideRefetchUnchanged, compared
 * after the member vote carry, on the read storeRawBill makes anyway). Every congress.gov call is still made.
 * - "off" (unset or empty, the code default): nothing is compared; every refetch is stored as before.
 * - "watch" (as shipped, and any value it does not know): logs "Refetched raw bill is unchanged; it would not be
 *   stored again (watch)" and counts RawBillUnchangedWouldSkip, then stores and sends the bill exactly as before.
 * - "on": the bill is not stored again and not sent to BillDifferQueue; logs "Refetched raw bill is unchanged; not
 *   stored again" and counts RawBillUnchangedSkipped. Vote enrichment is still queued when the stored copy needs it,
 *   as before (its own retries depend on it). The stored copy, its member votes and lastSyncedAt stay as they are.
 * A refetch over a copy a rel56: or refetch: message stored is never unchanged (stored_by_bulk_refetch, the covering
 * invariant): NotificationType skips the backfill's pushes, so its store must never cover a poller listing.
 * Under "watch" and "on" the "Successfully processed bill" line says why (refetchUnchanged, rawBillStored).
 * Ships as "watch" (infra, FetchRawBill env REFETCH_UNCHANGED_MODE); "off" is the rollback.
 */
const REFETCH_UNCHANGED_MODE: RefetchUnchangedMode = parseRefetchUnchangedMode(process.env.REFETCH_UNCHANGED_MODE);

/**
 * REL-58: failed records and congress.gov's outages (retryLadder.ts). Under FETCH_RETRY_BACKOFF "on":
 * - each failed record's visibility is set from its receive count and cause (ChangeMessageVisibility on the record's
 *   queue): a congress.gov failure (unavailable, throttled, a bill-endpoint 404 for its first
 *   FETCH_RETRY_NOT_FOUND_RECEIVES receives) climbs FETCH_RETRY_LADDER_SECONDS; any other failure, every failure of a
 *   bulk message and the final receive come back after FETCH_RETRY_OTHER_SECONDS. "Failed record will be retried"
 *   says why, and FetchRawBillRecordFailed (with and without Kind) and FetchRawBillFailingSeconds count it;
 * - no congress.gov request starts with less than a request timeout plus LAMBDA_TIME_MARGIN_MS of Lambda time left,
 *   and each one is destroyed LAMBDA_TIME_MARGIN_MS before the timeout, so a slow bill fails as unavailable and takes
 *   the ladder instead of timing out the invocation;
 * - a message overtaken by a later listing (the stored copy was fetched after it was listed) keeps the stored title,
 *   description and pubDate; its content is stored as fetched.
 * "off" (unset, or anything else; the code default) is the behaviour before REL-58: every failure comes back after
 * the queue's visibility timeout. Settings that cannot be used make "on" act as "off", with one error line at load.
 * A failure of the whole invocation (the key read, the environment checks, an init or memory failure, a timeout
 * the guard misses) never reaches this: it comes back after the queue's visibility timeout.
 */
const FETCH_RETRY_LADDER: RetryLadder | null = ((): RetryLadder | null => {
  if (parseFetchRetryBackoffMode(process.env.FETCH_RETRY_BACKOFF) !== "on") return null;
  const parsed = parseRetryLadder(process.env);
  if ("error" in parsed) {
    logger.error(
      "FETCH_RETRY_BACKOFF is on but its settings cannot be used; failed records keep the queue's visibility timeout",
      {
        reason: parsed.error,
      },
    );
    return null;
  }
  return parsed.ladder;
})();
const FETCH_RETRY_ON = FETCH_RETRY_LADDER !== null;

const s3 = new S3Client({});
const rawBillDao = new RawBillDao(s3, BUCKET_NAME);
const sqs = new SQSClient({});

interface FeedItem {
  guid: string;
  title: string;
  link?: string;
  legislationUrl?: string;
  pubDate: string;
  category?: string;
  description?: string;
  billType?: string;
  congress?: string;
  billNumber?: string;
  /** REL-45: set on the delayed retry FetchRawBill sends itself after every text source refused (1, 2, 3). */
  textRetryAttempt?: number;
  /**
   * REL-45: true on a message from a bulk refetch (refetch:stale-bills), which runs inside a RUNBOOK 4.1 quiet
   * window: a refused text is then final at once (BillTextUnavailable, which stops the run), because a delayed retry
   * could land after the window closed and push old news.
   */
  noTextRetry?: boolean;
  /**
   * REL-58: true on a message from backfill:cosponsors, which runs inside a quiet window but sends no noTextRetry:
   * like the refetch's, its failures come back after a minute, never on the hours-long ladder.
   */
  bulk?: boolean;
  /**
   * REL-58: when congress.gov listed this message's title, description and pubDate (ISO), on the REL-56 backfill's
   * messages: the snapshot's listedAt, which is older than the run start in their ids. FetchRawBill dates the stored
   * title by it (messageListing).
   */
  listedAt?: string;
}

/** The handler context FetchRawBill reads: the logger's request id and the time left. */
type FetchRawBillContext = LambdaContextLike & { getRemainingTimeInMillis?: () => number };

// Parse bill information from RSS feed link
// Example: https://www.congress.gov/bill/118th-congress/house-bill/1234
const HUMAN_TO_ABBREV_BILL_TYPE: Record<string, string> = {
  "house-bill": "hr",
  "senate-bill": "s",
  "house-joint-resolution": "hjres",
  "senate-joint-resolution": "sjres",
  "house-concurrent-resolution": "hconres",
  "senate-concurrent-resolution": "sconres",
  "house-resolution": "hres",
  "senate-resolution": "sres",
};

const toAbbreviatedBillType = (billType: string): string => {
  const lowered = billType.toLowerCase();
  return HUMAN_TO_ABBREV_BILL_TYPE[lowered] || lowered;
};

const parseBillLink = (link: string): BillIdentifier | null => {
  const match = link.match(
    /\/bill\/(\d+)(?:th|st|nd|rd)-congress\/(house-bill|senate-bill|house-joint-resolution|senate-joint-resolution|house-concurrent-resolution|senate-concurrent-resolution|house-resolution|senate-resolution)\/(\d+)/i,
  );

  if (!match) {
    logger.warn("Could not parse bill link", { link });
    return null;
  }

  const [, congress, billTypeDisplay, billNumber] = match;
  const billTypeDisplayLower = billTypeDisplay.toLowerCase();

  return {
    congress,
    billType: billTypeDisplayLower,
    billNumber,
  };
};

const extractLegislationUrl = (billData: Record<string, unknown>): string | undefined => {
  const billPayload = billData?.bill as Record<string, unknown> | undefined;
  const billRecord = (billPayload?.bill ?? billPayload) as Record<string, unknown> | undefined;
  const candidate = billRecord?.legislationUrl;
  return typeof candidate === "string" ? candidate : undefined;
};

const toCongressOrdinal = (congress: string): string => {
  const n = Number.parseInt(congress, 10);
  if (!Number.isFinite(n)) return `${congress}th`;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
};

const buildLegislationUrl = (billId: BillIdentifier): string => {
  const congress = toCongressOrdinal(billId.congress);
  const billType = billId.billType.toLowerCase();
  return `https://www.congress.gov/bill/${congress}-congress/${billType}/${billId.billNumber}`;
};

interface HttpsTextResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

// GET over HTTPS with a socket inactivity timeout (REL-05). Resolves for any HTTP status and
// rejects on network errors, including the TimeoutError raised when the socket stalls. REL-58: with `deadlineMs` the
// request is also destroyed that long after it starts, however the socket behaves (a body that trickles in keeps the
// inactivity timeout from ever firing), with a TimeoutError.
const httpsGetText = (url: string, accept: string, label: string, deadlineMs?: number): Promise<HttpsTextResponse> =>
  new Promise((resolve, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle =
      <T>(done: (value: T) => void) =>
      (value: T) => {
        if (deadline) clearTimeout(deadline);
        done(value);
      };
    const req = httpsRequest(
      url,
      {
        headers: {
          "User-Agent": BILLBOARD_FETCHER_USER_AGENT,
          Accept: accept,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        // A connection reset mid-body surfaces here, not on req.
        res.on("error", settle(reject));
        res.on("end", () => settle(resolve)({ statusCode: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );

    req.on("error", settle(reject));
    applySocketTimeout(req, CONGRESS_API_REQUEST_TIMEOUT_MS, label);
    if (deadlineMs !== undefined && typeof req.destroy === "function") {
      const ms = Math.max(0, Math.floor(deadlineMs));
      deadline = setTimeout(() => {
        req.destroy(new TimeoutError(`${label} passed its deadline of ${ms}ms (no Lambda time left)`, ms));
      }, ms);
    }
    req.end();
  });

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * REL-58, under FETCH_RETRY_BACKOFF on: the Lambda time left (context.getRemainingTimeInMillis), so that no
 * congress.gov request runs into the timeout. Undefined (off, or no context): no guard, as before.
 */
type RequestClock = (() => number) | undefined;

/** The failure a retry is for: its kind (null when it is not congress.gov's), its status and why. */
interface RetriedFailure {
  kind: CongressFailureKind | null;
  status: number | null;
  reason: string;
}

/** A request needs a whole request timeout, plus the margin the store and the sends after it need. */
const REQUEST_TIME_NEEDED_MS = CONGRESS_API_REQUEST_TIMEOUT_MS + LAMBDA_TIME_MARGIN_MS;

/**
 * The error for a request, or a retry, the Lambda has no time left for: of the kind of the failure being retried,
 * else unavailable (time ran out on a slow congress.gov), so the record takes the ladder instead of timing out.
 */
const outOfTimeError = (url: string, leftMs: number, retried?: RetriedFailure): Error => {
  const message = `Congress API request to ${url} not started: no Lambda time left (${Math.max(0, Math.floor(leftMs))}ms)${
    retried ? `; it was a retry of ${retried.reason}` : ""
  }`;
  const kind = retried ? retried.kind : "unavailable";
  return kind ? new CongressApiFailure(kind, retried?.status ?? null, message) : new Error(message);
};

// Generic function to fetch from Congress API using HTTPS.
// Retries on 429 (rate limit), 5xx (server errors), network errors and socket timeouts.
// A 401/403 refreshes the API key and retries once, since the cached key may have been rotated (REL-13).
// REL-58: a failure after the retries is a CongressApiFailure when it is congress.gov's (unavailable, throttled,
// not_found), with the same message as before; with a clock, no request or retry starts without the time it needs.
const fetchFromCongressAPI = async (
  url: string,
  clock?: RequestClock,
  attempt = 0,
  keyRefreshed = false,
  retried?: RetriedFailure,
): Promise<Record<string, unknown>> => {
  const leftMs = clock ? clock() : Number.POSITIVE_INFINITY;
  if (leftMs < REQUEST_TIME_NEEDED_MS) throw outOfTimeError(url, leftMs, retried);
  const targetUrl = new URL(url);
  targetUrl.searchParams.set("api_key", await getCongressApiKey());
  if (!targetUrl.searchParams.has("format")) {
    targetUrl.searchParams.set("format", "json");
  }

  /** Throws when the Lambda has no time for this retry after waiting delayMs. */
  const assertTimeForRetry = (delayMs: number, failure: RetriedFailure): void => {
    if (!clock) return;
    const left = clock();
    if (left - delayMs < REQUEST_TIME_NEEDED_MS) throw outOfTimeError(url, left, failure);
  };

  let response: HttpsTextResponse;
  try {
    response = await httpsGetText(
      targetUrl.toString(),
      "application/json",
      `Congress API ${targetUrl.pathname}`,
      clock ? leftMs - LAMBDA_TIME_MARGIN_MS : undefined,
    );
  } catch (error) {
    // A timeout or a connection failure is congress.gov's; any other request error (TLS, a bad URL) is not.
    const unavailable = isTimeoutError(error) || isNetworkError(error);
    const failure: RetriedFailure = {
      kind: unavailable ? "unavailable" : null,
      status: null,
      reason: errorMessage(error),
    };
    // Retry on network errors
    if (attempt < CONGRESS_API_MAX_RETRIES) {
      const delayMs = retryDelayMs(attempt, RETRY_BACKOFF);
      assertTimeForRetry(delayMs, failure);
      logger.warn(
        `Congress API network error. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${CONGRESS_API_MAX_RETRIES})`,
        {
          url,
          delayMs,
          attempt: attempt + 1,
          maxRetries: CONGRESS_API_MAX_RETRIES,
          reason: errorMessage(error),
        },
      );
      await sleep(delayMs);
      return fetchFromCongressAPI(url, clock, attempt + 1, keyRefreshed, failure);
    }
    const message = `Network error fetching ${url} after ${CONGRESS_API_MAX_RETRIES} retries: ${errorMessage(error)}`;
    throw unavailable
      ? new CongressApiFailure("unavailable", null, message, { cause: error })
      : new Error(message, { cause: error });
  }

  const { statusCode } = response;
  if (statusCode === 429) {
    await putMetric(METRIC_NAMESPACE, "CongressApi429", 1);
  }

  // Retry on 429 (rate limit) or 5xx (server errors)
  if (isRetryableStatus(statusCode) && attempt < CONGRESS_API_MAX_RETRIES) {
    const delayMs = retryDelayMs(attempt, RETRY_BACKOFF, response.headers["retry-after"]);
    const failure: RetriedFailure = {
      kind: congressFailureKindOfStatus(statusCode),
      status: statusCode,
      reason: `status ${statusCode}`,
    };
    assertTimeForRetry(delayMs, failure);
    logger.warn(
      `Congress API returned ${statusCode}. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${CONGRESS_API_MAX_RETRIES})`,
      {
        url,
        statusCode,
        delayMs,
        attempt: attempt + 1,
        maxRetries: CONGRESS_API_MAX_RETRIES,
      },
    );
    await sleep(delayMs);
    return fetchFromCongressAPI(url, clock, attempt + 1, keyRefreshed, failure);
  }

  if (isCongressApiAuthFailureStatus(statusCode)) {
    if (!keyRefreshed) {
      invalidateCongressApiKey();
      logger.warn(`Congress API returned ${statusCode}. Refreshing the API key and retrying once`, { url, statusCode });
      return fetchFromCongressAPI(url, clock, attempt, true, {
        kind: null,
        status: statusCode,
        reason: `status ${statusCode}`,
      });
    }
    logger.error("Congress API rejected a freshly read API key", { url, statusCode });
    await putMetric(METRIC_NAMESPACE, "CongressApiAuthFailure", 1);
  }

  if (statusCode !== 200) {
    const message = `Congress API request failed with status ${statusCode} for ${url}`;
    const kind = congressFailureKindOfStatus(statusCode);
    throw kind ? new CongressApiFailure(kind, statusCode, message) : new Error(message);
  }

  try {
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse JSON response from ${url}`);
  }
};

const toRecordArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];

const hasNextPage = (page: Record<string, unknown>): boolean => {
  const pagination = page.pagination as Record<string, unknown> | undefined;
  return typeof pagination?.next === "string" && pagination.next.length > 0;
};

// Reads every page of /cosponsors (REL-28). Without this a bill keeps only the first page, which
// is 20 cosponsors at congress.gov's default page size. Later pages are requested with our own
// offset rather than by following pagination.next, so the API key is only ever sent to
// CONGRESS_API_BASE_URL. Extra pages are counted in CongressApiCallsCore but are not limited by
// CONGRESS_API_MAX_CALLS_PER_BILL, which picks how many endpoints are called. Returns the first
// page's response with every page's cosponsors merged into it and pagination.next removed, plus
// the number of extra requests made.
const fetchAllCosponsorPages = async (
  firstPageUrl: string,
  firstPage: Record<string, unknown>,
  clock?: RequestClock,
): Promise<{ data: Record<string, unknown>; extraCalls: number }> => {
  const cosponsors = [...toRecordArray(firstPage.cosponsors)];
  let page = firstPage;
  let pagesRead = 1;
  let extraCalls = 0;

  while (hasNextPage(page) && pagesRead < CONGRESS_API_COSPONSORS_MAX_PAGES) {
    if (CONGRESS_API_CALL_DELAY_MS > 0) {
      await sleep(CONGRESS_API_CALL_DELAY_MS);
    }
    const pageUrl = new URL(firstPageUrl);
    pageUrl.searchParams.set("offset", String(cosponsors.length));
    page = await fetchFromCongressAPI(pageUrl.toString(), clock);
    extraCalls += 1;
    pagesRead += 1;

    const pageItems = toRecordArray(page.cosponsors);
    if (pageItems.length === 0) break;
    cosponsors.push(...pageItems);
  }

  if (hasNextPage(page)) {
    logger.warn(
      `Stopped reading cosponsors after ${pagesRead} pages (${cosponsors.length} cosponsors); congress.gov reports more`,
      { url: firstPageUrl, pagesRead, cosponsors: cosponsors.length },
    );
  }

  if (pagesRead === 1) {
    return { data: firstPage, extraCalls };
  }

  const pagination = { ...((firstPage.pagination ?? {}) as Record<string, unknown>) };
  delete pagination.next;
  return { data: { ...firstPage, cosponsors, pagination }, extraCalls };
};

// The next relatedbills page to request, or null when pagination.next is not a relatedbills page of
// this bill on api.congress.gov over HTTPS. Any api_key in it is dropped: fetchFromCongressAPI adds
// ours, so the key is never taken from a response or sent to another host.
const relatedBillsNextPageUrl = (next: unknown, firstPageUrl: URL): URL | null => {
  if (typeof next !== "string" || next.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(next.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.host !== CONGRESS_API_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname.toLowerCase() !== firstPageUrl.pathname.toLowerCase()
  ) {
    return null;
  }
  url.searchParams.delete("api_key");
  url.hash = "";
  return url;
};

const relatedBillIdentity = (item: Record<string, unknown>, position: number): string => {
  const parts = [item.congress, item.type, item.number].map((part) =>
    typeof part === "string" || typeof part === "number" ? String(part).trim().toUpperCase() : "",
  );
  // An item missing part of its identity is never merged with another.
  return parts.every((part) => part.length > 0) ? parts.join("|") : `#${position}`;
};

// One item per related bill (congress, type, number), with the relationshipDetails of every copy.
const mergeRelatedBillItems = (items: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
  const merged = new Map<string, Record<string, unknown>>();
  items.forEach((item, position) => {
    const identity = relatedBillIdentity(item, position);
    const kept = merged.get(identity);
    if (!kept) {
      merged.set(identity, item);
      return;
    }
    const details = [...toRecordArray(kept.relationshipDetails)];
    const seen = new Set(details.map((detail) => JSON.stringify(detail)));
    for (const detail of toRecordArray(item.relationshipDetails)) {
      const detailKey = JSON.stringify(detail);
      if (seen.has(detailKey)) continue;
      seen.add(detailKey);
      details.push(detail);
    }
    merged.set(identity, { ...kept, relationshipDetails: details });
  });
  return [...merged.values()];
};

// Reads /relatedbills (APPF-23). The first page asks for RELATED_BILLS_PAGE_LIMIT rows, which is
// every live bill's whole list. If congress.gov still reports pagination.next, up to
// RELATED_BILLS_MAX_EXTRA_PAGES more pages are read by following that URL as given (never an offset
// built from item counts: a page holds relationship rows, not bills), only when it is a relatedbills
// page of this bill on api.congress.gov. Items are merged by (congress, type, number). A next page
// that is still reported afterwards is logged and counted as RelatedBillsTruncated, and stays in the
// stored pagination so readers can tell the list may be incomplete.
const fetchAllRelatedBillPages = async (
  firstPageUrl: string,
  firstPage: Record<string, unknown>,
  clock?: RequestClock,
): Promise<{ data: Record<string, unknown>; extraCalls: number }> => {
  const firstUrl = new URL(firstPageUrl);
  const items = [...toRecordArray(firstPage.relatedBills)];
  let page = firstPage;
  let extraCalls = 0;

  while (hasNextPage(page) && extraCalls < RELATED_BILLS_MAX_EXTRA_PAGES) {
    const nextUrl = relatedBillsNextPageUrl((page.pagination as Record<string, unknown>).next, firstUrl);
    if (!nextUrl) {
      logger.warn(
        "Not following relatedbills pagination.next: it is not this bill's relatedbills page on api.congress.gov",
        {
          url: firstPageUrl,
        },
      );
      break;
    }
    if (CONGRESS_API_CALL_DELAY_MS > 0) {
      await sleep(CONGRESS_API_CALL_DELAY_MS);
    }
    page = await fetchFromCongressAPI(nextUrl.toString(), clock);
    extraCalls += 1;

    const pageItems = toRecordArray(page.relatedBills);
    if (pageItems.length === 0) break;
    items.push(...pageItems);
  }

  const truncated = hasNextPage(page);
  if (truncated) {
    logger.warn(
      `relatedbills still reports a next page after ${extraCalls + 1} pages; related bills may be incomplete`,
      {
        url: firstPageUrl,
        pagesRead: extraCalls + 1,
        relatedBills: items.length,
      },
    );
    await putMetric(METRIC_NAMESPACE, "RelatedBillsTruncated", 1);
  }

  if (extraCalls === 0) {
    return { data: firstPage, extraCalls };
  }

  const pagination = { ...((firstPage.pagination ?? {}) as Record<string, unknown>) };
  if (truncated) pagination.next = (page.pagination as Record<string, unknown>).next;
  else delete pagination.next;
  return { data: { ...firstPage, relatedBills: mergeRelatedBillItems(items), pagination }, extraCalls };
};

// Fetch comprehensive bill data from Congress API (main bill + all related endpoints)
// Uses sequential fetching with rate limiting to avoid API throttling
const fetchComprehensiveBillData = async (
  billId: BillIdentifier,
  clock?: RequestClock,
): Promise<{ data: Record<string, unknown>; coreApiCalls: number }> => {
  const { congress, billType, billNumber } = billId;
  const billTypeSegment = toAbbreviatedBillType(billType);
  const baseUrl = `${CONGRESS_API_BASE_URL}/bill/${congress}/${billTypeSegment}/${billNumber}`;
  const actionsUrl = new URL(`${baseUrl}/actions`);
  actionsUrl.searchParams.set("limit", String(Math.max(1, CONGRESS_API_ACTIONS_PAGE_LIMIT)));
  const cosponsorsUrl = new URL(`${baseUrl}/cosponsors`);
  cosponsorsUrl.searchParams.set("limit", String(Math.max(1, CONGRESS_API_COSPONSORS_PAGE_LIMIT)));
  const relatedBillsUrl = new URL(`${baseUrl}/relatedbills`);
  relatedBillsUrl.searchParams.set("limit", String(RELATED_BILLS_PAGE_LIMIT));

  // Define all endpoints to fetch - ordered by importance (bill first, text last since it triggers XML fetch)
  const endpoints: Array<[string, string]> = [
    ["bill", baseUrl],
    ["actions", actionsUrl.toString()],
    ["subjects", `${baseUrl}/subjects`],
    ["titles", `${baseUrl}/titles`],
    ["cosponsors", cosponsorsUrl.toString()],
    ["committees", `${baseUrl}/committees`],
    ["relatedBills", relatedBillsUrl.toString()],
    ["text", `${baseUrl}/text`],
  ];

  const endpointBudget = Number.isFinite(CONGRESS_API_MAX_CALLS_PER_BILL)
    ? Math.max(1, CONGRESS_API_MAX_CALLS_PER_BILL)
    : endpoints.length;
  const boundedEndpoints = endpoints.slice(0, Math.min(endpoints.length, endpointBudget));
  logger.info("Fetching comprehensive bill data sequentially", {
    endpoints: boundedEndpoints.length,
    availableEndpoints: endpoints.length,
    callDelayMs: CONGRESS_API_CALL_DELAY_MS,
  });

  const comprehensiveData: Record<string, unknown> = {};
  let coreApiCalls = 0;

  // Fetch endpoints sequentially with delay to avoid rate limiting
  for (let i = 0; i < boundedEndpoints.length; i++) {
    const [key, url] = boundedEndpoints[i];

    // Add delay between calls (skip delay for first call)
    if (i > 0 && CONGRESS_API_CALL_DELAY_MS > 0) {
      await sleep(CONGRESS_API_CALL_DELAY_MS);
    }

    try {
      let data = await fetchFromCongressAPI(url, clock);
      coreApiCalls += 1;
      if (key === "cosponsors") {
        const allPages = await fetchAllCosponsorPages(url, data, clock);
        data = allPages.data;
        coreApiCalls += allPages.extraCalls;
      } else if (key === "relatedBills") {
        const allPages = await fetchAllRelatedBillPages(url, data, clock);
        data = allPages.data;
        coreApiCalls += allPages.extraCalls;
      }
      comprehensiveData[key] = data;
      logger.debug("Fetched bill endpoint", { endpoint: key, index: i + 1, total: boundedEndpoints.length });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to fetch ${key} after all retries`, { endpoint: key, error });
      // Fail on any endpoint failure - incomplete bills are not useful. REL-58 reads the endpoint and the cause.
      throw new BillEndpointError(key, `Failed to fetch ${key} endpoint: ${errorMessage}`, { cause: error });
    }
  }

  if (!comprehensiveData.bill) {
    throw new Error("Failed to fetch main bill data");
  }

  return { data: comprehensiveData, coreApiCalls };
};

const emitCoreApiCallsMetric = (callCount: number): Promise<void> =>
  putMetric(METRIC_NAMESPACE, "CongressApiCallsCore", callCount);

// ─── REL-45: the bill text ───────────────────────────────────────────────────

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The text a raw bill's content holds (billXML, or a legacy key), unchanged, or undefined when empty. */
const storedBillXml = (content: Record<string, unknown>): string | undefined => {
  for (const key of ["billXML", "billXml", "bill_xml"]) {
    const value = content[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
};

interface PreviousBillText {
  /** The text version the stored copy names (its /text response, else its billXMLFetch marker). */
  versionStem: string | null;
  xml?: string;
  source?: BillTextSource;
}

/**
 * The stored raw bill's text and the version it belongs to, or null when there is no stored copy or it cannot be
 * read (then the text is fetched as if the bill were new). One S3 GET; storeRawBill keeps its own read (REL-35).
 */
const readPreviousBillText = async (guid: string): Promise<PreviousBillText | null> => {
  try {
    const previous = await rawBillDao.getRevisionByGuid(guid);
    const content = asObject((previous.value as { content?: unknown } | null)?.content);
    if (!content) return null;
    const marker = asObject(content.billXMLFetch);
    const located = locateBillXmlUrl(content.text);
    const versionStem =
      (located.url !== undefined ? billVersionStem(located.url) : null) ??
      (typeof marker?.versionStem === "string" ? marker.versionStem : null);
    const source = marker?.source === "GovInfo" || marker?.source === "CongressGov" ? marker.source : undefined;
    return { versionStem, xml: storedBillXml(content), ...(source ? { source } : {}) };
  } catch (error) {
    logger.warn("Could not read the stored raw bill for its text; fetching the text as for a new bill", { error });
    return null;
  }
};

interface BillTextStep {
  /** content.billXMLFetch; undefined when the /text endpoint was not read. */
  marker?: BillXmlFetchMarker;
  /** The text to store as content.billXML. */
  xml?: string;
  /** The stored text of the same version was kept without a request (BillXmlReused). */
  reused?: boolean;
  /** The textRetryAttempt of the delayed retry to send once the bill is stored. */
  nextRetryAttempt?: number;
  /** Final, and no text stored although a Formatted XML URL existed: BillTextUnavailable{Reason}. */
  unavailableReason?: SourceResultKind;
}

/**
 * Decides the text of the newest version (REL-45): reuse the stored text of the same version, else fetch it from the
 * sources in order; on failure carry the stored text of the same version forward. "No text versions" and "no
 * Formatted XML" are normal (a new bill) and count nothing.
 */
const resolveBillText = async (
  guid: string,
  textData: unknown,
  retryAttempt: number,
  retriesAllowed: boolean,
  remainingMs: (() => number) | undefined,
): Promise<BillTextStep> => {
  const at = new Date().toISOString();
  const retryFields = retryAttempt > 0 ? { retryAttempt } : {};
  if (!textData) {
    logger.warn("No text endpoint data available");
    return {};
  }
  const located = locateBillXmlUrl(textData);
  if (located.url === undefined) {
    if (located.missing === "no_text_version") logger.warn("No text versions available");
    else logger.warn("No XML format found in text versions");
    return { marker: { outcome: located.missing, versionStem: null, statuses: {}, at, ...retryFields } };
  }

  const xmlUrl = located.url;
  const versionStem = billVersionStem(xmlUrl);
  // Only a recognised package id can be compared with the stored copy's.
  const previous = versionStem ? await readPreviousBillText(guid) : null;
  const sameVersionXml = previous && previous.versionStem === versionStem ? previous.xml : undefined;

  if (sameVersionXml && BILL_XML_REUSE_SAME_VERSION) {
    logger.info("Reusing the stored bill text of the same text version", { versionStem, xmlUrl });
    return {
      xml: sameVersionXml,
      reused: true,
      marker: {
        outcome: "reused",
        versionStem,
        ...(previous?.source ? { source: previous.source } : {}),
        statuses: {},
        at,
        ...retryFields,
      },
    };
  }

  const sources = billTextRequests(xmlUrl, BILL_XML_SOURCES).map((request) => request.source);
  logger.info("Fetching bill XML", { xmlUrl, versionStem, sources, textRetryAttempt: retryAttempt });
  const fetched = await fetchBillText({
    xmlUrl,
    order: BILL_XML_SOURCES,
    get: (url) => httpsGetText(url, "application/xml", "Bill XML request"),
    maxRetries: CONGRESS_API_MAX_RETRIES,
    backoff: RETRY_BACKOFF,
    budget: timeBudget({ budgetMs: BILL_XML_FETCH_BUDGET_MS, remainingMs }),
    cooldownMs: BILL_XML_REFUSED_HOST_COOLDOWN_MS,
  });
  await putMetrics(METRIC_NAMESPACE, fetched.metrics);

  if (fetched.outcome === "ok" && fetched.xml) {
    logger.info("Successfully fetched bill XML", { source: fetched.source, characters: fetched.xml.length });
    return {
      xml: fetched.xml,
      marker: { outcome: "ok", versionStem, source: fetched.source, statuses: fetched.statuses, at, ...retryFields },
    };
  }

  // Never regress the store: the same version's stored text stays.
  const carried = sameVersionXml;
  const marker: BillXmlFetchMarker = carried
    ? {
        outcome: "carried",
        fetchOutcome: fetched.outcome,
        versionStem,
        ...(previous?.source ? { source: previous.source } : {}),
        statuses: fetched.statuses,
        at,
        ...retryFields,
      }
    : { outcome: fetched.outcome, versionStem, statuses: fetched.statuses, at, ...retryFields };
  logger.warn("Could not fetch bill XML", {
    xmlUrl,
    versionStem,
    outcome: fetched.outcome,
    statuses: fetched.statuses,
    carriedPreviousText: Boolean(carried),
    textRetryAttempt: retryAttempt,
  });

  if (fetched.outcome === "refused") {
    if (!retriesAllowed) {
      logger.warn("The bill text was refused; no delayed retry for a bulk refetch's message (noTextRetry)");
    } else if (retryAttempt < BILL_TEXT_MAX_RETRIES && TEXT_RETRY_QUEUE_URL) {
      return { xml: carried, marker: { ...marker, retryScheduled: true }, nextRetryAttempt: retryAttempt + 1 };
    } else if (!TEXT_RETRY_QUEUE_URL) {
      logger.warn("TEXT_RETRY_QUEUE_URL is not set; a refused bill text is not retried");
    }
  }
  return carried ? { xml: carried, marker } : { marker, unavailableReason: fetched.outcome };
};

/** The textRetryAttempt a message carries: a whole number from 1, else 0 (the poller's and every other message). */
const textRetryAttemptOf = (value: unknown): number => {
  const attempt = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
};

/**
 * Sends the message again to UpdatedBillsQueue, delayed, with the next textRetryAttempt and the same correlation id
 * (as EnrichOfficialVotes defers its own work). A failed send throws, so SQS retries the record.
 */
const sendTextRetry = async (feedItem: FeedItem, nextAttempt: number, correlationId: string): Promise<void> => {
  const response = await sqs.send(
    new SendMessageBatchCommand({
      QueueUrl: TEXT_RETRY_QUEUE_URL,
      Entries: [
        {
          Id: `text-retry-${nextAttempt}`,
          MessageBody: JSON.stringify({ ...feedItem, textRetryAttempt: nextAttempt }),
          DelaySeconds: BILL_TEXT_RETRY_DELAY_SECONDS,
          ...correlationIdMessageAttributes(correlationId),
        },
      ],
    }),
  );
  const failed = response?.Failed ?? [];
  if (failed.length > 0) {
    throw new Error(
      `Failed to schedule the bill text retry: ${failed.map((failure) => failure.Message ?? failure.Id ?? "unknown").join(", ")}`,
    );
  }
};

// ─── REL-35: storing a fetched raw bill (MEMBER_VOTE_CARRY_MODE) ─────────────

const officialVotesOf = (rawBill: RawBill | null | undefined): OfficialVotesBreakdown | undefined => {
  const content = (rawBill as { content?: unknown } | null | undefined)?.content;
  return content && typeof content === "object"
    ? ((content as Record<string, unknown>).officialVotes as OfficialVotesBreakdown | undefined)
    : undefined;
};

/** A copy of rawBill whose content.officialVotes is `votes` (left out when undefined). rawBill is not modified. */
const withOfficialVotes = (rawBill: RawBill, votes: OfficialVotesBreakdown | undefined): RawBill => {
  const content: Record<string, unknown> = { ...rawBill.content };
  if (votes) content.officialVotes = votes;
  else delete content.officialVotes;
  return { ...rawBill, content };
};

/**
 * The raw bill currently stored under this guid, with its ETag (value null when there is none). An
 * object that is not JSON counts as none, so the refetch replaces it as before; any other read error
 * throws.
 */
const readPreviousRawBill = async (guid: string): Promise<StoredJson<RawBill>> => {
  try {
    return await rawBillDao.getRevisionByGuid(guid);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    logger.warn("The stored raw bill is not JSON; the refetch replaces it without a condition", {
      event: "member_vote_carry",
      memberVoteCarryMode: MEMBER_VOTE_CARRY_MODE,
      outcome: "previous_unreadable",
    });
    return { value: null };
  }
};

/**
 * One line per decision where the previous raw bill had member votes (the only refetches the rule can
 * change): what each chamber did and why, with both roll-call identities, so a decision can be checked
 * against the stored raw versions. "carried" in "on" mode, "would_carry" in "watch", else "none".
 */
const logCarryDecision = (
  decision: MemberVoteCarryDecision,
  previous: StoredJson<RawBill>,
  fields: Record<string, unknown> = {},
): void => {
  if (!decision.previousHadMembers) return;
  logger.info("Member vote carry decision", {
    event: "member_vote_carry",
    memberVoteCarryMode: MEMBER_VOTE_CARRY_MODE,
    outcome: decision.carried.length === 0 ? "none" : MEMBER_VOTE_CARRY_MODE === "on" ? "carried" : "would_carry",
    carriedChambers: decision.carried,
    chambers: decision.chambers,
    lastSyncedAtKept: decision.lastSyncedAtKept,
    previousVersionId: previous.versionId,
    previousFetchedAt: rawFetchedAt(previous.value),
    ...fields,
  });
};

// ─── REL-57: a refetch that changes nothing (REFETCH_UNCHANGED_MODE) ─────────

/** What processRecord knows of the message and of its text step, for REL-57's decision. */
type RefetchFacts = Omit<RefetchUnchangedInput, "stored" | "next">;

/** REL-57's decision on the document a refetch would store; undefined under "off", which compares nothing. */
const decideRefetch = (
  facts: RefetchFacts,
  previous: StoredJson<RawBill> | undefined,
  document: RawBill,
): RefetchUnchangedDecision | undefined =>
  REFETCH_UNCHANGED_MODE === "off" ? undefined : decideRefetchUnchanged({ ...facts, stored: previous, next: document });

/**
 * The line and metric of an unchanged refetch: RawBillUnchangedSkipped under "on" (not stored), else
 * RawBillUnchangedWouldSkip (stored as before). The line names the stored copy that stays, so a trace can follow it.
 */
const reportUnchangedRefetch = async (
  refetch: RefetchUnchangedDecision,
  previous: StoredJson<RawBill>,
  fields: Record<string, unknown> = {},
): Promise<void> => {
  const skipped = REFETCH_UNCHANGED_MODE === "on";
  logger.info(
    skipped
      ? "Refetched raw bill is unchanged; not stored again"
      : "Refetched raw bill is unchanged; it would not be stored again (watch)",
    {
      event: "refetch_unchanged",
      refetchUnchangedMode: REFETCH_UNCHANGED_MODE,
      reason: refetch.reason,
      volatileChanged: refetch.volatileChanged,
      storedVersionId: previous.versionId,
      storedCorrelationId: correlationIdFromMetadata(previous.metadata),
      storedFetchedAt: rawFetchedAt(previous.value),
      ...fields,
    },
  );
  await putMetric(METRIC_NAMESPACE, skipped ? "RawBillUnchangedSkipped" : "RawBillUnchangedWouldSkip", 1);
};

// ─── REL-58: a message overtaken by a later listing (FETCH_RETRY_BACKOFF on) ───

/**
 * The document to store (listingToStore): a retry on the ladder can come back hours after a later listing of the same
 * bill was stored, and its older title would start a new summary (the title is in the summary's text hash) and another
 * when the next listing put the newer one back. So a message keeps the stored copy's title, description and pubDate
 * when the stored copy holds a newer listing, and a bulk copy (refetch:stale-bills, backfill:cosponsors) always keeps
 * them; either way metadata.listedAt records when the fields stored were listed. The content is always this fetch's.
 * `listing` null (off, or a message nothing dates) keeps the document as it is. `previous` undefined (the stored copy
 * could not be read) stores this message's own fields.
 */
const keepNewerListing = (
  document: RawBill,
  previous: StoredJson<RawBill> | undefined,
  listing: MessageListing | null,
): RawBill => {
  const result = listingToStore(document, previous, listing);
  if (result.kept.length > 0 && previous?.value && listing) {
    logger.info(
      listing.kind === "listed"
        ? "Kept the stored title and description: a later listing was stored after this message's"
        : "Kept the stored title and description: a bulk message sent an older stored copy's",
      {
        event: "listing_overtaken",
        messageListing: listing.kind,
        keptFields: result.kept,
        ...(listing.kind === "listed" ? { listedAt: new Date(listing.atMs).toISOString() } : {}),
        ...(result.listedAtMs === null ? {} : { storedListedAt: new Date(result.listedAtMs).toISOString() }),
        storedFetchedAt: rawFetchedAt(previous.value),
        storedCorrelationId: correlationIdFromMetadata(previous.metadata),
        storedVersionId: previous.versionId,
      },
    );
  }
  return result.document;
};

interface StoreOutcome {
  /** The document stored; when nothing was stored (REL-57 "on"), the one that would have been: the stored copy's. */
  document: RawBill;
  stored: boolean;
  /** REL-57's decision; undefined under "off". */
  refetch?: RefetchUnchangedDecision;
}

/**
 * Stores a fetched raw bill per MEMBER_VOTE_CARRY_MODE and returns the document stored: in "watch" the
 * fetched bill itself, unchanged; in "on" a copy whose officialVotes went through the carry rule. REL-57: under
 * REFETCH_UNCHANGED_MODE "on" a document equal to the stored copy is not stored (stored false); the carry's metric
 * and line are then left out too, since the stored members were not written again. REL-58: with `listing` (under
 * FETCH_RETRY_BACKOFF on), a message overtaken by a later listing, or a bulk copy, keeps the stored title, description
 * and pubDate, and metadata.listedAt dates them (keepNewerListing), before REL-57 compares.
 */
const storeRawBill = async (
  rawBill: RawBill,
  correlationId: string,
  facts: RefetchFacts,
  listing: MessageListing | null,
): Promise<StoreOutcome> => {
  const guid = rawBill.metadata.guid;
  const fetchedVotes = officialVotesOf(rawBill);

  if (MEMBER_VOTE_CARRY_MODE !== "on") {
    let previous: StoredJson<RawBill> | undefined;
    try {
      previous = await readPreviousRawBill(guid);
      const decision = decideMemberVoteCarry(officialVotesOf(previous.value), fetchedVotes);
      logCarryDecision(decision, previous);
      if (decision.carried.length > 0) {
        await putMetric(METRIC_NAMESPACE, "MemberVotesCarriable", decision.carried.length);
      }
    } catch (error) {
      logger.warn("Could not evaluate the member vote carry; the raw bill is stored as before", {
        event: "member_vote_carry",
        memberVoteCarryMode: MEMBER_VOTE_CARRY_MODE,
        outcome: "read_failed",
        error,
      });
    }
    // REL-58: compared with the stored copy the carry's read gave; without it, this message's own fields are stored.
    const document = keepNewerListing(rawBill, previous, listing);
    const refetch = decideRefetch(facts, previous, document);
    if (refetch?.unchanged && previous && REFETCH_UNCHANGED_MODE === "on") {
      await reportUnchangedRefetch(refetch, previous);
      return { document, stored: false, refetch };
    }
    await rawBillDao.store(document, { correlationId });
    if (refetch?.unchanged && previous) await reportUnchangedRefetch(refetch, previous);
    return { document, stored: true, refetch };
  }

  for (let attempt = 1; ; attempt += 1) {
    const previous = await readPreviousRawBill(guid);
    const decision = decideMemberVoteCarry(officialVotesOf(previous.value), fetchedVotes);
    const document = keepNewerListing(withOfficialVotes(rawBill, decision.votes), previous, listing);
    // Decided again on each attempt: after a refused write the copy read is the other writer's.
    const refetch = decideRefetch(facts, previous, document);
    const carried = decision.carried.length > 0 ? { carriedChambers: decision.carried } : {};
    if (refetch?.unchanged && REFETCH_UNCHANGED_MODE === "on") {
      await reportUnchangedRefetch(refetch, previous, carried);
      return { document, stored: false, refetch };
    }
    const ifMatch = previous.value && previous.etag ? previous.etag : undefined;
    try {
      await rawBillDao.store(document, { correlationId, ...(ifMatch ? { ifMatch } : {}) });
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      await putMetric(METRIC_NAMESPACE, "RawBillWriteConflict", 1);
      logger.warn("The raw bill changed between its read and the refetch's write", {
        event: "member_vote_carry",
        memberVoteCarryMode: MEMBER_VOTE_CARRY_MODE,
        attempt,
        maxAttempts: RAW_BILL_WRITE_MAX_ATTEMPTS,
      });
      if (attempt >= RAW_BILL_WRITE_MAX_ATTEMPTS) {
        throw new Error(`Raw bill ${guid} changed during ${attempt} conditional writes`, { cause: error });
      }
      continue;
    }
    logCarryDecision(decision, previous, { attempt });
    if (decision.carried.length > 0) {
      await putMetric(METRIC_NAMESPACE, "MemberVotesCarried", decision.carried.length);
    }
    if (refetch?.unchanged) await reportUnchangedRefetch(refetch, previous, carried);
    return { document, stored: true, refetch };
  }
};

// Process a single SQS record. Returns the guid when the bill was stored, or found unchanged (REL-57, stored false).
type ProcessRecordResult = {
  guid: string;
  correlationId: string;
  needsVoteEnrichment: boolean;
  callBudgetUsed: number;
  completeness: "none" | "partial" | "complete";
  /** False when REL-57 left the stored copy as it was: nothing goes to BillDifferQueue. */
  stored: boolean;
} | null;

const processRecord = async (record: SQSRecord, remainingMs?: () => number): Promise<ProcessRecordResult> => {
  // REL-58 (FETCH_RETRY_BACKOFF on): the deadline guard's clock.
  const clock: RequestClock = FETCH_RETRY_ON ? remainingMs : undefined;
  try {
    const feedItem: FeedItem = JSON.parse(record.body);
    // Stored and sent on without a text-version suffix (an older raw bill's metadata.guid, as the U9b backfill sent).
    const guid = plainBillGuid(feedItem.guid) ?? feedItem.guid;
    // Minted here for messages sent without one (older poller builds, manual sends). REL-57 reads the one that came.
    const messageCorrelationId = correlationIdFromRecord(record);
    const correlationId = messageCorrelationId ?? mintCorrelationId(guid);
    logger.appendKeys({ guid, correlationId });
    if (guid !== feedItem.guid) {
      logger.warn("Dropped the text-version suffix from the message guid", { received: feedItem.guid });
    }
    logger.info("Processing bill");

    let billId: BillIdentifier | null = null;

    if (feedItem.congress && feedItem.billType && feedItem.billNumber) {
      billId = {
        congress: feedItem.congress,
        billType: feedItem.billType.toLowerCase(),
        billNumber: feedItem.billNumber,
      };
      logger.info("Using pre-parsed bill info from feed");
    } else if (typeof feedItem.link === "string" && feedItem.link.trim().length > 0) {
      billId = parseBillLink(feedItem.link);
    }

    if (!billId) {
      // Acknowledged as before (a refetch cannot identify it either); now logged and counted (C1.8).
      reportUnprocessableMessage({
        site: "fetchRawBill.unidentifiedBill",
        reason:
          typeof feedItem.link === "string" && feedItem.link.trim().length > 0 ? "unparseable_link" : "no_bill_id",
        messageId: record.messageId,
        body: record.body,
        fields: { link: feedItem.link },
      });
      return null;
    }

    const apiBillType = toAbbreviatedBillType(billId.billType);
    logger.info("Fetching comprehensive bill data", {
      congress: billId.congress,
      billType: apiBillType,
      billNumber: billId.billNumber,
      sourceBillType: billId.billType,
    });
    const { data: billData, coreApiCalls } = await fetchComprehensiveBillData(billId, clock);
    await emitCoreApiCallsMetric(coreApiCalls);

    const textRetryAttempt = textRetryAttemptOf(feedItem.textRetryAttempt);
    const text = await resolveBillText(
      guid,
      billData.text,
      textRetryAttempt,
      feedItem.noTextRetry !== true,
      remainingMs,
    );
    if (text.xml) billData.billXML = text.xml;
    if (text.marker) billData.billXMLFetch = text.marker;

    const nowIso = new Date().toISOString();
    let completeness: "none" | "partial" | "complete" = "none";
    if (typeof billData === "object" && billData) {
      const officialVotes = extractOfficialVotesFromActions(billData);
      if (officialVotes) {
        (billData as Record<string, unknown>).officialVotes = officialVotes;
        completeness = officialVotes.completeness;
      }
    }

    const rawBill: RawBill = {
      schemaVersion: 1,
      kind: "raw",
      storedAt: nowIso,
      identifier: billId,
      metadata: {
        guid,
        title: feedItem.title,
        pubDate: feedItem.pubDate,
        category: feedItem.category,
        description: feedItem.description,
        legislationUrl: feedItem.legislationUrl ?? extractLegislationUrl(billData) ?? buildLegislationUrl(billId),
        fetchedAt: nowIso,
      },
      content: billData,
    };

    // REL-35: enrichment is decided from the votes stored, so a chamber that kept its members ("on")
    // is not sent again. REL-57: a refetch whose text step scheduled a retry or lost the text is always stored, so
    // the retry and BillTextUnavailable below only follow a store.
    const {
      document: storedBill,
      stored,
      refetch,
    } = await storeRawBill(
      rawBill,
      correlationId,
      {
        messageCorrelationId,
        textRetryAttempt,
        noTextRetry: feedItem.noTextRetry === true,
        textRetryScheduled: text.nextRetryAttempt !== undefined,
        textUnavailable: text.unavailableReason !== undefined,
      },
      // REL-58: where this message's title came from (a listing and its time, or a bulk copy of the stored one).
      FETCH_RETRY_ON ? messageListing(feedItem, messageCorrelationId, record.attributes?.SentTimestamp) : null,
    );
    const officialVotes = officialVotesOf(storedBill);
    if (officialVotes) completeness = officialVotes.completeness;

    // REL-45: counted once the bill is stored (or found unchanged, REL-57), so a failed store (retried by SQS)
    // counts nothing.
    if (text.reused) await putMetric(METRIC_NAMESPACE, "BillXmlReused", 1);
    if (text.nextRetryAttempt !== undefined) {
      await sendTextRetry(feedItem, text.nextRetryAttempt, correlationId);
      await putMetric(METRIC_NAMESPACE, "BillTextRetryScheduled", 1);
      logger.warn("Every bill text source refused; a delayed retry is scheduled", {
        textRetryAttempt: text.nextRetryAttempt,
        maxRetries: BILL_TEXT_MAX_RETRIES,
        delaySeconds: BILL_TEXT_RETRY_DELAY_SECONDS,
      });
    }
    if (text.unavailableReason) {
      await putMetrics(METRIC_NAMESPACE, [
        { name: "BillTextUnavailable", value: 1 },
        { name: "BillTextUnavailable", value: 1, dimensions: { Reason: text.unavailableReason } },
      ]);
      logger.warn("Bill text unavailable: stored without text", {
        reason: text.unavailableReason,
        versionStem: text.marker?.versionStem,
        statuses: text.marker?.statuses,
        textRetryAttempt,
      });
    }

    const chamberNeedsEnrichment = (
      chamberVote: { memberDataAvailable?: boolean; members?: unknown[] } | undefined,
    ): boolean =>
      !chamberVote?.memberDataAvailable && (!Array.isArray(chamberVote?.members) || chamberVote.members.length === 0);

    const needsHouseVoteEnrichment = Boolean(
      hasVoteRelatedActionForChamber(storedBill, "house") && chamberNeedsEnrichment(officialVotes?.house),
    );
    const needsSenateVoteEnrichment = Boolean(
      hasVoteRelatedActionForChamber(storedBill, "senate") && chamberNeedsEnrichment(officialVotes?.senate),
    );

    logger.info("Successfully processed bill", {
      billGuid: guid,
      callBudgetUsed: coreApiCalls,
      completeness,
      billText: text.marker?.outcome,
      needsVoteEnrichment: needsHouseVoteEnrichment || needsSenateVoteEnrichment,
      // REL-57, under "watch" and "on": whether the bill was stored, and why.
      ...(refetch
        ? {
            rawBillStored: stored,
            refetchUnchanged: refetch.reason,
            ...(refetch.changedPaths ? { refetchChangedPaths: refetch.changedPaths } : {}),
          }
        : {}),
    });

    return {
      guid,
      correlationId,
      needsVoteEnrichment: needsHouseVoteEnrichment || needsSenateVoteEnrichment,
      callBudgetUsed: coreApiCalls,
      completeness,
      stored,
    };
  } catch (error) {
    logger.error("Error processing record", { error });
    throw error;
  }
};

interface StoredBill {
  guid: string;
  correlationId: string;
}

// ─── REL-58: when a failed record comes back (FETCH_RETRY_BACKOFF on) ─────────

/** A record the batch fails, and why. */
interface FailedRecord {
  record: SQSRecord;
  error: unknown;
}

const parsedBody = (record: SQSRecord): Record<string, unknown> | undefined => {
  try {
    const body: unknown = JSON.parse(record.body);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Sets the record's visibility on its queue; false (logged) when it cannot, so it comes back after the queue's. */
const setRecordVisibility = async (record: SQSRecord, seconds: number): Promise<boolean> => {
  const queueUrl = queueUrlFromArn(record.eventSourceARN);
  if (!queueUrl || !record.receiptHandle) {
    logger.warn(
      "Could not set the failed record's visibility: no queue or receipt handle; it comes back after the queue's visibility timeout",
      {
        eventSourceARN: record.eventSourceARN,
      },
    );
    return false;
  }
  try {
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: record.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
    return true;
  } catch (error) {
    logger.warn("Could not set the failed record's visibility; it comes back after the queue's visibility timeout", {
      retryInSeconds: seconds,
      error,
    });
    return false;
  }
};

/**
 * Under FETCH_RETRY_BACKOFF on: for each failed record, when it comes back (decideRetry), set as its visibility, one
 * "Failed record will be retried" line, and FetchRawBillRecordFailed (with and without Kind). A congress.gov
 * failure that takes the ladder (unavailable, throttled) also gives FetchRawBillFailingSeconds: the time since the
 * record's first receive, which the Billboard-Ingestion-FetchRawBillFailing alarm reads. Never throws.
 */
const scheduleRetries = async (ladder: RetryLadder, failures: readonly FailedRecord[]): Promise<void> => {
  const metrics: Array<{
    name: string;
    value: number;
    dimensions?: Record<string, string>;
    unit?: "Count" | "Seconds";
  }> = [];
  for (const { record, error } of failures) {
    const body = parsedBody(record);
    const correlationId = correlationIdFromRecord(record);
    const guid = typeof body?.guid === "string" ? (plainBillGuid(body.guid) ?? body.guid) : undefined;
    await logger.withKeys({ sqsMessageId: record.messageId, guid, correlationId }, async () => {
      const failure = classifyRecordFailure(error);
      const bulk = isBulkMessage(body, correlationId);
      const receiveCount = Number(record.attributes?.ApproximateReceiveCount);
      const decision = decideRetry({ kind: failure.kind, receiveCount, bulk }, ladder);
      const firstReceive = Number(record.attributes?.ApproximateFirstReceiveTimestamp);
      const failingSeconds =
        Number.isFinite(firstReceive) && firstReceive > 0
          ? Math.max(0, Math.round((Date.now() - firstReceive) / 1000))
          : undefined;
      const visibilitySet = await setRecordVisibility(record, decision.retryInSeconds);
      logger.warn("Failed record will be retried", {
        event: "record_retry",
        failureKind: decision.kind,
        failureCause: failure.kind,
        failureStatus: failure.status,
        failedEndpoint: failure.endpoint,
        receiveCount: Number.isFinite(receiveCount) ? receiveCount : undefined,
        maxReceives: ladder.maxReceives,
        retryInSeconds: decision.retryInSeconds,
        retryStep: decision.step,
        final: decision.final,
        bulk,
        failingSeconds,
        visibilitySet,
      });
      metrics.push(
        { name: "FetchRawBillRecordFailed", value: 1 },
        { name: "FetchRawBillRecordFailed", value: 1, dimensions: { Kind: decision.kind } },
      );
      if ((decision.kind === "unavailable" || decision.kind === "throttled") && failingSeconds !== undefined) {
        metrics.push({ name: "FetchRawBillFailingSeconds", value: failingSeconds, unit: "Seconds" });
      }
    });
  }
  await putMetrics(METRIC_NAMESPACE, metrics);
};

/** context.getRemainingTimeInMillis, bound, when the runtime gives one. */
const remainingTimeOf = (context: FetchRawBillContext | undefined): (() => number) | undefined =>
  typeof context?.getRemainingTimeInMillis === "function" ? () => context.getRemainingTimeInMillis!() : undefined;

// Each message carries its bill's correlation id to the next hop.
const enqueueGuids = async (queueUrl: string, bills: StoredBill[]) => {
  if (!queueUrl || bills.length === 0) return;
  for (let i = 0; i < bills.length; i += QUEUE_BATCH_SIZE) {
    const batch = bills.slice(i, i + QUEUE_BATCH_SIZE);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((bill, idx) => ({
          Id: `msg-${i + idx}`,
          MessageBody: JSON.stringify({ guid: bill.guid }),
          ...correlationIdMessageAttributes(bill.correlationId),
        })),
      }),
    );

    if (response.Failed && response.Failed.length > 0) {
      const failedGuids: string[] = [];
      for (const failure of response.Failed) {
        const failedIndex = failure.Id ? Number.parseInt(failure.Id.replace("msg-", ""), 10) : NaN;
        const offset = Number.isFinite(failedIndex) ? failedIndex - i : -1;
        const bill = offset >= 0 ? batch[offset] : undefined;
        if (bill) failedGuids.push(bill.guid);
        logger.error("Failed to enqueue raw bill guid to SQS", {
          failure,
          guid: bill?.guid,
          correlationId: bill?.correlationId,
        });
      }
      throw new Error(
        `Failed to enqueue ${response.Failed.length} raw bill guid message(s) to SQS ${queueUrl}: ${failedGuids.join(", ")}`,
      );
    }
  }
};

export const handler = async (event: SQSEvent, context?: FetchRawBillContext): Promise<SQSBatchResponse> => {
  logger.resetContext(context);
  if (!BUCKET_NAME) throw new Error("Missing env var BUCKET_NAME");
  if (!SECRET_NAME) throw new Error("Missing env var SECRET_NAME");
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");
  if (!Number.isFinite(QUEUE_BATCH_SIZE) || QUEUE_BATCH_SIZE <= 0 || QUEUE_BATCH_SIZE > 10) {
    throw new Error("Invalid env var QUEUE_BATCH_SIZE");
  }
  if (!Number.isFinite(CONGRESS_API_REQUEST_TIMEOUT_MS) || CONGRESS_API_REQUEST_TIMEOUT_MS <= 0) {
    throw new Error("Invalid env var CONGRESS_API_REQUEST_TIMEOUT_MS");
  }

  logger.info(`Processing ${event.Records.length} records from SQS`, { records: event.Records.length });

  // Read the key up front so a missing or unreadable secret fails the whole batch before any work.
  // Requests read it again through the shared 15-minute cache, so a rotated key is picked up.
  await getCongressApiKey();

  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  // REL-58: each failed record with its error, for scheduleRetries.
  const failures: FailedRecord[] = [];
  const storedBills: StoredBill[] = [];
  const voteEnrichmentBills: StoredBill[] = [];
  const successfulRecordIds: string[] = [];
  const voteEnrichmentRecordIds: string[] = [];
  let totalCallBudgetUsed = 0;
  // REL-57: records whose refetch equalled the stored copy, which was left as it was.
  let unchangedBills = 0;

  for (const record of event.Records) {
    await logger.withKeys({ sqsMessageId: record.messageId }, async () => {
      try {
        const result = await processRecord(record, remainingTimeOf(context));
        if (result?.guid) {
          const bill = { guid: result.guid, correlationId: result.correlationId };
          // An unchanged copy was sent to BillDiffer by the message that stored it.
          if (result.stored) {
            storedBills.push(bill);
            successfulRecordIds.push(record.messageId);
          } else {
            unchangedBills += 1;
          }
          totalCallBudgetUsed += result.callBudgetUsed;
          if (result.needsVoteEnrichment && VOTE_ENRICHMENT_QUEUE_URL) {
            voteEnrichmentBills.push(bill);
            voteEnrichmentRecordIds.push(record.messageId);
          }
        }
      } catch (error) {
        logger.error(`Failed to process record ${record.messageId}`, { messageId: record.messageId, error });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        failures.push({ record, error });
      }
    });
  }
  const recordById = new Map(event.Records.map((record) => [record.messageId, record]));
  const failSent = (messageIds: readonly string[], error: unknown): void => {
    const failedSet = new Set(batchItemFailures.map((f) => f.itemIdentifier));
    for (const messageId of messageIds) {
      if (failedSet.has(messageId)) continue;
      batchItemFailures.push({ itemIdentifier: messageId });
      failedSet.add(messageId);
      const record = recordById.get(messageId);
      if (record) failures.push({ record, error });
    }
  };

  // After raw objects exist in S3, enqueue GUIDs for downstream processing.
  // Only enqueue if we have successful records
  try {
    await enqueueGuids(QUEUE_URL, storedBills);
  } catch (error) {
    logger.error("Failed enqueue to downstream queue; marking successful records for retry", { error });
    failSent(successfulRecordIds, error);
  }

  try {
    await enqueueGuids(VOTE_ENRICHMENT_QUEUE_URL ?? "", voteEnrichmentBills);
  } catch (error) {
    logger.error("Failed enqueue to vote enrichment queue; marking source records for retry", { error });
    failSent(voteEnrichmentRecordIds, error);
  }

  // REL-58: set when each failed record comes back.
  if (FETCH_RETRY_LADDER && failures.length > 0) await scheduleRetries(FETCH_RETRY_LADDER, failures);

  logger.info(
    `Completed processing: ${storedBills.length + unchangedBills} succeeded, ${batchItemFailures.length} failed, ${voteEnrichmentBills.length} queued for vote enrichment, ${totalCallBudgetUsed} core calls used`,
    {
      succeeded: storedBills.length + unchangedBills,
      unchanged: unchangedBills,
      failed: batchItemFailures.length,
      queuedForVoteEnrichment: voteEnrichmentBills.length,
      coreCallsUsed: totalCallBudgetUsed,
    },
  );
  return { batchItemFailures };
};
