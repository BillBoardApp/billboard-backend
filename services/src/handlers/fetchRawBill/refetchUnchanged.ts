import { correlationIdFromMetadata } from "../../shared/correlation";
import { BULK_CORRELATION_PREFIXES } from "./retryLadder";

/**
 * REL-57: a poller refetch that changes nothing. congress.gov re-stamps some bills' list time every 15 minutes for
 * hours after a floor action, and the poller's 120 s overlap doubles a stamp that lands just before a run, so one bill
 * can be sent dozens of times a day (2026-11-11: 1,034 sends for 247 bills). Each send is still fetched in full,
 * because congress.gov's detail and sub-endpoints lag (or run ahead of) its list and a repeat can carry a real update.
 * When the fetched bill equals the stored copy, writing it again and sending it to BillDiffer achieve nothing; this
 * module decides when that is so. Pure: nothing here reads or writes anything.
 */

/**
 * REFETCH_UNCHANGED_MODE. Unset or empty: off (the code default, so a function without the variable is untouched).
 * off, watch, on in any case: that mode. Anything else: watch, which never skips a write, so a typo cannot turn
 * skipping on.
 */
export type RefetchUnchangedMode = "off" | "watch" | "on";

export const parseRefetchUnchangedMode = (value: string | undefined): RefetchUnchangedMode => {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "") return "off";
  if (normalized === "off" || normalized === "watch" || normalized === "on") return normalized;
  return "watch";
};

/**
 * The paths every fetch rewrites whatever congress.gov says: when FetchRawBill stored the copy (storedAt), when it
 * fetched it (metadata.fetchedAt), when the listing it stores was listed (metadata.listedAt, REL-58: each poller run
 * dates its own, and a copy stored under FETCH_RETRY_BACKOFF off has none), and how the text step got the text
 * (content.billXMLFetch: "ok" with GovInfo's status on the fetch that brought a version, "reused" with none on every
 * fetch after it). The text itself (content.billXML) is compared, and nothing reads content.billXMLFetch or
 * metadata.listedAt outside FetchRawBill. Everything else is content, updateDateIncludingText included: it is
 * congress.gov's own record of an update, and the REL-56 tools (list:skipped-bill-updates, createBillsManifest's
 * dates) read it from the stored copy. An unchanged refetch that is not stored leaves the stored listedAt as it was:
 * the listing it dates has the same title, description and pubDate.
 */
export const REFETCH_VOLATILE_PATHS: ReadonlyArray<readonly string[]> = [
  ["storedAt"],
  ["metadata", "fetchedAt"],
  ["metadata", "listedAt"],
  ["content", "billXMLFetch"],
];

/** The id the poller sends with each bill: "<run start, toISOString>:<guid>" (shared/correlation.ts). */
const POLLER_CORRELATION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:BILLS-\d+[a-z]+\d+[a-z]*$/;

/**
 * Whether an SQS record's correlation id is one the poller minted. The REL-56 backfill's ("rel56:"), the REL-32
 * refetch's ("refetch:"), a repair's, and a record that carries none (FetchRawBill then mints its own) are not.
 */
export const isPollerCorrelationId = (correlationId: string | undefined): boolean =>
  typeof correlationId === "string" && POLLER_CORRELATION_ID.test(correlationId);

/**
 * Whether a stored copy's correlation id (its S3 metadata) is a bulk refetch's: the REL-56 backfill's ("rel56:") or
 * refetch:stale-bills' ("refetch:"). The covering invariant (decideRefetchUnchanged) reads it.
 */
export const isBulkRefetchCorrelationId = (correlationId: string | undefined): boolean =>
  typeof correlationId === "string" && BULK_CORRELATION_PREFIXES.some((prefix) => correlationId.startsWith(prefix));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isJsonObject = (value: Json | undefined): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value as S3 holds it: what JSON.stringify writes, read back (an undefined field is absent). */
const asStoredJson = (value: unknown): Json | undefined => {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : (JSON.parse(text) as Json);
};

const withoutVolatilePaths = (value: Json | undefined): Json | undefined => {
  for (const path of REFETCH_VOLATILE_PATHS) {
    let parent: Json | undefined = value;
    for (const key of path.slice(0, -1)) parent = isJsonObject(parent) ? parent[key] : undefined;
    if (isJsonObject(parent)) delete parent[path[path.length - 1]];
  }
  return value;
};

const childPath = (path: string, key: string): string => (path ? `${path}.${key}` : key);

const collectDifferences = (a: Json | undefined, b: Json | undefined, path: string, out: string[], limit: number) => {
  if (out.length >= limit || a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(path);
      return;
    }
    a.forEach((item, index) => collectDifferences(item, b[index], `${path}[${index}]`, out, limit));
    return;
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      if (out.length >= limit) return;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) out.push(childPath(path, key));
      else collectDifferences(a[key], b[key], childPath(path, key), out, limit);
    }
    return;
  }
  out.push(path);
};

/**
 * The paths at which the two raw bills differ, as their stored JSON, leaving out REFETCH_VOLATILE_PATHS: at most
 * `limit`, keys in sorted order, "" for the whole document. Exact: every value is compared as is (strings, numbers,
 * null, booleans), a key on one side only is a difference (null included), a list differs in its length or at an
 * index (a new order is a change), and key order alone is not. Neither argument is modified.
 */
export const rawBillDifferences = (stored: unknown, next: unknown, limit = Number.POSITIVE_INFINITY): string[] => {
  const out: string[] = [];
  collectDifferences(
    withoutVolatilePaths(asStoredJson(stored)),
    withoutVolatilePaths(asStoredJson(next)),
    "",
    out,
    limit,
  );
  return out;
};

/** True when `next` would store nothing `stored` does not hold already (rawBillDifferences is empty). */
export const unchangedRawBill = (stored: unknown, next: unknown): boolean =>
  rawBillDifferences(stored, next, 1).length === 0;

const valueAt = (value: Json | undefined, path: readonly string[]): Json | undefined =>
  path.reduce<Json | undefined>((node, key) => (isJsonObject(node) ? node[key] : undefined), value);

/** The volatile paths whose values differ between the two (what an unchanged refetch still moved). */
const volatileChanges = (stored: unknown, next: unknown): string[] => {
  const before = asStoredJson(stored);
  const after = asStoredJson(next);
  return REFETCH_VOLATILE_PATHS.filter(
    (path) => JSON.stringify(valueAt(before, path)) !== JSON.stringify(valueAt(after, path)),
  ).map((path) => path.join("."));
};

export interface RefetchUnchangedInput {
  /** The record's correlationId attribute as it came, or undefined when it carried none (never a minted id). */
  messageCorrelationId: string | undefined;
  /** The body's textRetryAttempt as FetchRawBill reads it: 0 on the poller's messages, 1 to 3 on its own retries. */
  textRetryAttempt: number;
  /** The body's noTextRetry is true: a bulk refetch's message (refetch:stale-bills, the REL-56 backfill). */
  noTextRetry: boolean;
  /** This fetch's text step scheduled a delayed retry (every source refused). */
  textRetryScheduled: boolean;
  /** This fetch's text step left the bill without text for good (BillTextUnavailable). */
  textUnavailable: boolean;
  /**
   * The stored raw bill as read, with its S3 user metadata: value null when there is none; undefined when it could
   * not be read.
   */
  stored: { value: unknown; metadata?: Record<string, string> } | undefined;
  /** The document this refetch would store (after the REL-35 member vote carry). */
  next: unknown;
}

/**
 * Why a refetch is written, or "unchanged". In the order they are checked: the message, the text step, the stored
 * copy, the content.
 */
export type RefetchUnchangedReason =
  | "not_poller_message"
  | "bulk_message"
  | "text_retry_message"
  | "text_retry_scheduled"
  | "text_unavailable"
  | "stored_copy_unreadable"
  | "no_stored_copy"
  | "stored_by_this_message"
  | "stored_by_bulk_refetch"
  | "changed"
  | "unchanged";

export interface RefetchUnchangedDecision {
  /** True only for "unchanged": the write, and the BillDiffer message it would send, add nothing. */
  unchanged: boolean;
  reason: RefetchUnchangedReason;
  /** For "changed": the first paths that differ (5 at most). */
  changedPaths?: string[];
  /** For "unchanged": the volatile paths that moved (they are not compared). */
  volatileChanged?: string[];
}

const CHANGED_PATHS_LOGGED = 5;

const written = (reason: Exclude<RefetchUnchangedReason, "unchanged">): RefetchUnchangedDecision => ({
  unchanged: false,
  reason,
});

/**
 * Whether a refetch is unchanged: a poller message (its correlation id in the poller's form, no noTextRetry, not a
 * text retry), whose text step scheduled nothing and lost nothing, whose stored copy exists, was written by another
 * poller message, and equals the document to store (rawBillDifferences). Anything else is written:
 * - other messages must reach BillDiffer: the backfill and the refetch (whose stop rules read BillDiffer's work),
 *   backfill:cosponsors, a hand-sent message;
 * - a scheduled retry or a lost text must be stored, sent and counted as before (REL-45);
 * - a copy this message stored itself may never have reached BillDiffer: the message is being retried after a
 *   failed send, a timeout or a dead letter's redrive, so it is written and sent again;
 * - the covering invariant (REL-56): a copy a bulk refetch stored (a "rel56:" or "refetch:" id,
 *   isBulkRefetchCorrelationId) never covers a poller listing, whatever its content. NotificationType skips the push
 *   of a processed version with a rel56: id (BACKFILL_PUSH_MODE=skip), so if such a copy covered the listing that a
 *   real update brought, the update would stay published under the backfill's id alone, its push skipped with no
 *   poller store or BillDiffer pass to trace it. Written, the listing goes on exactly as before REL-57: stored under
 *   the poller's id and sent to BillDiffer.
 */
export const decideRefetchUnchanged = (input: RefetchUnchangedInput): RefetchUnchangedDecision => {
  if (!isPollerCorrelationId(input.messageCorrelationId)) return written("not_poller_message");
  if (input.noTextRetry) return written("bulk_message");
  if (input.textRetryAttempt > 0) return written("text_retry_message");
  if (input.textRetryScheduled) return written("text_retry_scheduled");
  if (input.textUnavailable) return written("text_unavailable");
  if (!input.stored) return written("stored_copy_unreadable");
  if (input.stored.value === null || input.stored.value === undefined) return written("no_stored_copy");
  const storedCorrelationId = correlationIdFromMetadata(input.stored.metadata);
  if (storedCorrelationId === input.messageCorrelationId) return written("stored_by_this_message");
  if (isBulkRefetchCorrelationId(storedCorrelationId)) return written("stored_by_bulk_refetch");
  const changedPaths = rawBillDifferences(input.stored.value, input.next, CHANGED_PATHS_LOGGED);
  if (changedPaths.length > 0) return { unchanged: false, reason: "changed", changedPaths };
  return { unchanged: true, reason: "unchanged", volatileChanged: volatileChanges(input.stored.value, input.next) };
};
