import type { RawBill } from "../../models/bill";
import { correlationIdFromMetadata, REL56_BACKFILL_CORRELATION_PREFIX } from "../../shared/correlation";
import { isUpstreamUnavailableStatus } from "../../shared/http";

/**
 * REL-58: FetchRawBill's retries. A record that fails is retried by SQS after the queue's visibility timeout, 180 s,
 * and dead-lettered after maxReceiveCount receives. With 3 receives that rode out about 9 minutes of congress.gov
 * trouble, and congress.gov's outages come and go for hours (2026-11-10: 7.7 h; 14 bills dead-lettered, 5 of them
 * never stored until the redrive). Under FETCH_RETRY_BACKOFF on, FetchRawBill sets each failed record's visibility
 * itself (ChangeMessageVisibility), by its receive count and the cause: a congress.gov failure climbs a ladder of
 * about 6 hours, anything else comes back in a minute. This module holds the decisions. Pure: nothing here reads or
 * writes anything.
 */

/** FETCH_RETRY_BACKOFF: "on" in any case and spacing; anything else, or nothing, is "off" (today's behaviour). */
export type FetchRetryBackoffMode = "off" | "on";

export const parseFetchRetryBackoffMode = (value: string | undefined): FetchRetryBackoffMode =>
  (value ?? "").trim().toLowerCase() === "on" ? "on" : "off";

/**
 * Why a congress.gov request still failed after FetchRawBill's in-process retries:
 * - unavailable: a timeout, a network error (reset, refused, DNS), 500, 502, 503, 504 or Cloudflare's 520 to 530, or
 *   no Lambda time left to try again;
 * - throttled: 429;
 * - not_found: 404 (only the bill endpoint's counts: congress.gov's detail can lag the list that named the bill).
 */
export type CongressFailureKind = "unavailable" | "throttled" | "not_found";

/** A record's failure: a congress.gov one, or other (S3, SQS, a 401 or 403, another 4xx or 5xx, a code error). */
export type RecordFailureKind = CongressFailureKind | "other";

/** A congress.gov request that failed after the retries, typed by its cause. The message is the plain error's. */
export class CongressApiFailure extends Error {
  readonly kind: CongressFailureKind;

  /** The last HTTP status, or null for a timeout, a network error or no time left. */
  readonly status: number | null;

  constructor(kind: CongressFailureKind, status: number | null, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CongressApiFailure";
    this.kind = kind;
    this.status = status;
  }
}

/** The kind of a final non-200 answer, or null when it is not congress.gov's to fix (other). */
export const congressFailureKindOfStatus = (status: number): CongressFailureKind | null => {
  if (status === 429) return "throttled";
  if (isUpstreamUnavailableStatus(status)) return "unavailable";
  if (status === 404) return "not_found";
  return null;
};

/** The failure of one of the bill's endpoints ("bill", "actions", ..., "text"), with its cause. */
export class BillEndpointError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BillEndpointError";
    this.endpoint = endpoint;
  }
}

export interface ClassifiedFailure {
  kind: RecordFailureKind;
  status: number | null;
  /** The endpoint that failed, when the error came from one. */
  endpoint: string | null;
}

/** Errors deep enough for the handler's wrappers (record, endpoint, request); a cycle stops here too. */
const MAX_CAUSE_DEPTH = 6;

/**
 * The kind of a record's failure, from the error and its causes: the first CongressApiFailure found, else other. A
 * not_found from any endpoint but "bill" is other: a missing sub-resource is not detail lag.
 */
export const classifyRecordFailure = (error: unknown): ClassifiedFailure => {
  let endpoint: string | null = null;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof BillEndpointError && endpoint === null) endpoint = current.endpoint;
    if (current instanceof CongressApiFailure) {
      if (current.kind === "not_found" && endpoint !== "bill")
        return { kind: "other", status: current.status, endpoint };
      return { kind: current.kind, status: current.status, endpoint };
    }
    current = current.cause;
  }
  return { kind: "other", status: null, endpoint };
};

/**
 * The retry settings (FetchRawBill's environment, from infra's constants):
 * - steps: the visibility after a congress.gov failure on receive n is steps[n - 1] (the last step past the end);
 * - otherSeconds: after any other failure, after every failure of a bulk message, and on the final receive;
 * - notFoundReceives: the receives on which a not_found takes the ladder; after them it counts as other;
 * - maxReceives: UpdatedBillsQueue's maxReceiveCount. A failure on that receive is the last: SQS moves the message
 *   to UpdatedBillsDLQ at its next receive.
 */
export interface RetryLadder {
  steps: readonly number[];
  otherSeconds: number;
  notFoundReceives: number;
  maxReceives: number;
}

/** SQS's largest visibility timeout, 12 hours. */
export const MAX_VISIBILITY_SECONDS = 43_200;

/** Each wait gets up to this much more, at random, so bills that failed together do not come back together. */
export const RETRY_JITTER = 0.1;

const wholeNumber = (value: string | undefined, min: number, max: number): number | null => {
  const text = (value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return parsed >= min && parsed <= max ? parsed : null;
};

export interface RetryLadderEnv {
  FETCH_RETRY_LADDER_SECONDS?: string;
  FETCH_RETRY_OTHER_SECONDS?: string;
  FETCH_RETRY_NOT_FOUND_RECEIVES?: string;
  FETCH_RETRY_MAX_RECEIVES?: string;
}

/** The settings, or why they cannot be used (then FETCH_RETRY_BACKOFF on changes nothing). */
export const parseRetryLadder = (env: RetryLadderEnv): { ladder: RetryLadder } | { error: string } => {
  const raw = (env.FETCH_RETRY_LADDER_SECONDS ?? "").trim();
  const steps = raw === "" ? [] : raw.split(",").map((step) => wholeNumber(step, 1, MAX_VISIBILITY_SECONDS));
  if (steps.length === 0 || steps.some((step) => step === null)) {
    return {
      error: `FETCH_RETRY_LADDER_SECONDS must list whole seconds from 1 to ${MAX_VISIBILITY_SECONDS} (got "${raw}")`,
    };
  }
  const otherSeconds = wholeNumber(env.FETCH_RETRY_OTHER_SECONDS, 1, MAX_VISIBILITY_SECONDS);
  if (otherSeconds === null) {
    return { error: `FETCH_RETRY_OTHER_SECONDS must be whole seconds from 1 to ${MAX_VISIBILITY_SECONDS}` };
  }
  // SQS allows a maxReceiveCount of 1 to 1,000.
  const maxReceives = wholeNumber(env.FETCH_RETRY_MAX_RECEIVES, 1, 1000);
  if (maxReceives === null) return { error: "FETCH_RETRY_MAX_RECEIVES must be a whole number from 1 to 1000" };
  const notFoundReceives = wholeNumber(env.FETCH_RETRY_NOT_FOUND_RECEIVES, 0, maxReceives - 1);
  if (notFoundReceives === null) {
    return { error: "FETCH_RETRY_NOT_FOUND_RECEIVES must be a whole number below FETCH_RETRY_MAX_RECEIVES" };
  }
  return { ladder: { steps: steps as number[], otherSeconds, notFoundReceives, maxReceives } };
};

export interface RetryInput {
  kind: RecordFailureKind;
  /** The record's ApproximateReceiveCount: 1 on its first receive. */
  receiveCount: number;
  /** A bulk message (isBulkMessage): the refetch's and the backfills', which keep a fast cadence. */
  bulk: boolean;
  /** Math.random by default; tests pin it. */
  random?: () => number;
}

export interface RetryDecision {
  /** The kind the decision used: a not_found after ladder.notFoundReceives receives is other. */
  kind: RecordFailureKind;
  /** The VisibilityTimeout to set: when the next receive comes. Never 0. */
  retryInSeconds: number;
  /** ladder (a congress.gov step), other, bulk, or final (the last receive before the dead letter). */
  step: "ladder" | "other" | "bulk" | "final";
  final: boolean;
}

/**
 * When a failed record comes back. The final receive gets otherSeconds, never 0: a copy of maxReceives lower than the
 * queue's (a partial revert, a hand edit) then retries once a minute, not at once in a loop, and a message at the
 * queue's own limit is dead-lettered a minute later instead of after the last step. Then, a failure that is not
 * congress.gov's, or a not_found past its receives, gets otherSeconds, so a poison message dead-letters in about
 * 11 minutes; so does every failure of a bulk message. A congress.gov failure takes the ladder.
 */
export const decideRetry = (input: RetryInput, ladder: RetryLadder): RetryDecision => {
  const receiveCount =
    Number.isFinite(input.receiveCount) && input.receiveCount >= 1 ? Math.floor(input.receiveCount) : 1;
  const kind: RecordFailureKind =
    input.kind === "not_found" && receiveCount > ladder.notFoundReceives ? "other" : input.kind;
  const final = receiveCount >= ladder.maxReceives;
  const step: RetryDecision["step"] = final ? "final" : kind === "other" ? "other" : input.bulk ? "bulk" : "ladder";
  const base = step === "ladder" ? ladder.steps[Math.min(receiveCount, ladder.steps.length) - 1] : ladder.otherSeconds;
  const random = input.random ?? Math.random;
  const retryInSeconds = Math.min(
    MAX_VISIBILITY_SECONDS,
    Math.max(1, Math.round(base * (1 + RETRY_JITTER * random()))),
  );
  return { kind, retryInSeconds, step, final };
};

/**
 * The correlation id prefixes of bulk refetches: the REL-56 backfill ("rel56:") and refetch:stale-bills
 * ("refetch:"). Their messages also carry noTextRetry.
 */
export const BULK_CORRELATION_PREFIXES: readonly string[] = ["rel56:", "refetch:"];

/**
 * A bulk message: from refetch:stale-bills (noTextRetry, "refetch:" or "rel56:" ids) or backfill:cosponsors
 * (bulk). These run inside a quiet window or must not outlive their run, so they keep a one-minute cadence and
 * dead-letter in minutes, where the run's stop rules and the DLQ check see them.
 */
export const isBulkMessage = (body: unknown, correlationId: string | undefined): boolean => {
  const fields = body && typeof body === "object" ? (body as { noTextRetry?: unknown; bulk?: unknown }) : {};
  if (fields.noTextRetry === true || fields.bulk === true) return true;
  return (
    typeof correlationId === "string" && BULK_CORRELATION_PREFIXES.some((prefix) => correlationId.startsWith(prefix))
  );
};

/** "<run start>:<guid>", optionally after "rel56:" or "refetch:": the poller's ids and the refetch's. */
const DATED_CORRELATION_ID =
  /^(?:rel56:|refetch:)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):BILLS-\d+[a-z]+\d+[a-z]*$/;

/** The run start in a poller's (or the refetch's) correlation id, in ms, or null when the id holds none. */
export const listingTimeOfCorrelationId = (correlationId: string | undefined): number | null => {
  const match = typeof correlationId === "string" ? DATED_CORRELATION_ID.exec(correlationId) : null;
  if (!match) return null;
  const time = Date.parse(match[1]);
  return Number.isNaN(time) ? null : time;
};

/**
 * When a message's title, description and pubDate were current: the run start in its correlation id (which a
 * redrive and a text retry keep), else its SentTimestamp; null when neither is a time.
 */
export const messageListedAtMs = (
  correlationId: string | undefined,
  sentTimestamp: string | undefined,
): number | null => {
  const fromId = listingTimeOfCorrelationId(correlationId);
  if (fromId !== null) return fromId;
  const sent = Number(sentTimestamp);
  return typeof sentTimestamp === "string" && sentTimestamp.trim() !== "" && Number.isFinite(sent) ? sent : null;
};

/** The message fields the poller takes from congress.gov's list row, which a later listing may have newer. */
export const LISTING_FIELDS = ["title", "description", "pubDate"] as const;

/** A time in ms from an ISO string, or null when it is not one. */
const isoTimeMs = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
};

/**
 * Where a message's title, description and pubDate come from, for the overtaking rule:
 * - listed: a congress.gov listing at atMs. The poller's (the run start in its id, else its SentTimestamp), the REL-56
 *   backfill's (the snapshot's listedAt, which its body carries; an older build's message by its run start), a
 *   hand-sent message's;
 * - stored_copy: the stored copy's own, sent back by a bulk message that is no listing: refetch:stale-bills outside
 *   --snapshot-file ("refetch:" ids, noTextRetry) and backfill:cosponsors (bulk). Its run start dates nothing.
 */
export type MessageListing = { kind: "listed"; atMs: number } | { kind: "stored_copy" };

/** The message's listing (MessageListing), or null when nothing dates it. */
export const messageListing = (
  body: unknown,
  correlationId: string | undefined,
  sentTimestamp: string | undefined,
): MessageListing | null => {
  const fields = body && typeof body === "object" ? (body as { listedAt?: unknown }) : {};
  const bodyListedAt = isoTimeMs(fields.listedAt);
  if (bodyListedAt !== null) return { kind: "listed", atMs: bodyListedAt };
  const rel56 = typeof correlationId === "string" && correlationId.startsWith(REL56_BACKFILL_CORRELATION_PREFIX);
  if (!rel56 && isBulkMessage(body, correlationId)) return { kind: "stored_copy" };
  const atMs = messageListedAtMs(correlationId, sentTimestamp);
  return atMs === null ? null : { kind: "listed", atMs };
};

/** A stored raw bill as FetchRawBill reads it: the document (null when none) and its S3 user metadata. */
export interface StoredCopy {
  value: unknown;
  metadata?: Record<string, string>;
}

const storedMetadataOf = (stored: StoredCopy | undefined): Record<string, unknown> | null => {
  const value = stored?.value;
  if (!value || typeof value !== "object") return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
};

/**
 * When the stored copy's title, description and pubDate were listed: its metadata.listedAt, which FetchRawBill writes
 * under on (the listing's own time, also after a store that kept an older copy's fields, and in a bulk copy); else
 * the run start in its correlation id (a copy stored before the switch went on, or under off); else its fetchedAt,
 * since a listing is never later than its fetch. Null when nothing dates it or there is no stored copy.
 */
export const storedListingTimeMs = (stored: StoredCopy | undefined): number | null => {
  const metadata = storedMetadataOf(stored);
  if (!metadata) return null;
  return (
    isoTimeMs(metadata.listedAt) ??
    listingTimeOfCorrelationId(correlationIdFromMetadata(stored?.metadata)) ??
    isoTimeMs(metadata.fetchedAt)
  );
};

/**
 * Overtaking: whether the stored copy holds a newer listing than a message listed at `listedAtMs`. True when the copy
 * was fetched after this message was listed and its listing (storedListingTimeMs) is not older than this message's.
 * An older message whose retry came through between this message's listing and its receive is the older listing.
 */
export const storedListingIsNewer = (listedAtMs: number | null, stored: StoredCopy | undefined): boolean => {
  const metadata = storedMetadataOf(stored);
  if (listedAtMs === null || !metadata) return false;
  const fetchedAt = isoTimeMs(metadata.fetchedAt);
  if (fetchedAt === null || fetchedAt <= listedAtMs) return false;
  const storedListedAt = storedListingTimeMs(stored);
  return storedListedAt !== null && storedListedAt >= listedAtMs;
};

/**
 * A copy of `next` whose title, description and pubDate are the stored copy's (a field the stored copy lacks is left
 * out), and the fields that changed. The content stays this fetch's. Neither argument is modified.
 */
export const withStoredListingFields = (next: RawBill, stored: RawBill): { document: RawBill; kept: string[] } => {
  const metadata: Record<string, unknown> = { ...next.metadata };
  const storedMetadata = (stored.metadata ?? {}) as unknown as Record<string, unknown>;
  const kept: string[] = [];
  for (const field of LISTING_FIELDS) {
    const value = storedMetadata[field];
    if (value === metadata[field]) continue;
    kept.push(field);
    if (value === undefined) delete metadata[field];
    else metadata[field] = value;
  }
  return { document: { ...next, metadata: metadata as unknown as RawBill["metadata"] }, kept };
};

/** A copy of `document` whose metadata.listedAt is `listedAtMs` (left out when null). */
const withListedAt = (document: RawBill, listedAtMs: number | null): RawBill => {
  const metadata: RawBill["metadata"] = { ...document.metadata };
  if (listedAtMs === null) delete metadata.listedAt;
  else metadata.listedAt = new Date(listedAtMs).toISOString();
  return { ...document, metadata };
};

export interface ListingToStore {
  /** The document to store: this fetch's content, with the title, description and pubDate of `from`. */
  document: RawBill;
  /** message: this message's own fields; stored: the stored copy's (overtaken, or a bulk copy). */
  from: "message" | "stored";
  /** The listing fields that differ from this message's (empty when they are the same, or from the message). */
  kept: string[];
  /** The metadata.listedAt stored with them, in ms; null when nothing dates them (then it is left out). */
  listedAtMs: number | null;
}

/**
 * The document a message stores, with the listing time of the title, description and pubDate it stores
 * (metadata.listedAt), so the next message is compared with that listing, not with whichever message stored it:
 * - a listed message keeps the stored copy's fields and their listing time when the stored copy holds a newer listing
 *   (storedListingIsNewer), else stores its own, dated by its listing;
 * - a stored_copy message keeps the stored copy's fields and their listing time whenever there is a stored copy (its
 *   own are a copy of a stored listing no newer than the one stored now), else stores its own, undated;
 * - no listing (off, or a message nothing dates) stores the document as it is.
 * The content is always this fetch's, and the correlation id (S3 metadata) is the message's. Neither argument is
 * modified.
 */
export const listingToStore = (
  next: RawBill,
  stored: { value: RawBill | null; metadata?: Record<string, string> } | undefined,
  listing: MessageListing | null,
): ListingToStore => {
  if (listing === null) return { document: next, from: "message", kept: [], listedAtMs: null };
  const keepStored =
    stored?.value && (listing.kind === "stored_copy" || storedListingIsNewer(listing.atMs, stored))
      ? stored.value
      : null;
  if (keepStored) {
    const listedAtMs = storedListingTimeMs(stored);
    const { document, kept } = withStoredListingFields(next, keepStored);
    return { document: withListedAt(document, listedAtMs), from: "stored", kept, listedAtMs };
  }
  const listedAtMs = listing.kind === "listed" ? listing.atMs : null;
  return { document: withListedAt(next, listedAtMs), from: "message", kept: [], listedAtMs };
};

/** The queue URL of an SQS record's eventSourceARN (arn:aws:sqs:<region>:<account>:<name>), or null. */
export const queueUrlFromArn = (arn: string | undefined): string | null => {
  const match =
    typeof arn === "string" ? /^arn:aws:sqs:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]+(?:\.fifo)?)$/.exec(arn) : null;
  return match ? `https://sqs.${match[1]}.amazonaws.com/${match[2]}/${match[3]}` : null;
};
