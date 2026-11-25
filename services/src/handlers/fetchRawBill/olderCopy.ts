import { isPollerCorrelationId } from "./refetchUnchanged";
import { isBulkMessage, listingTimeOfCorrelationId } from "./retryLadder";

/**
 * REL-56 (2026-11-21): congress.gov's bill answer can be older than its list. The poller lists a bill in the window
 * that holds its new update time, and the fetch a minute later gets the bill as it was before that update: over
 * 2026-11-14 to 11-21, 739 of about 3,070 poller fetches got a copy older than the update their listing showed (the
 * update showed in the bill's answer up to 48 minutes later; median 5), and 721 bills were left stored without an
 * update congress.gov had. The list is not the gap: 4 of 2,904 updates showed in it late.
 *
 * So a poller message whose fetched bill is older than its listing is checked again: OLDER_COPY_RECHECK.
 * - "off" (unset or empty, the code default): nothing is compared, as before.
 * - "watch" (and any value it does not know): each such copy is logged and counted (RawBillOlderThanListing); no
 *   message is sent.
 * - "on" (as shipped): also sends the message back to UpdatedBillsQueue OLDER_COPY_RECHECK_DELAY_SECONDS later, at
 *   most OLDER_COPY_MAX_RECHECKS times (olderCopyRecheck in the body). A re-check reads the bill's own answer only (one
 *   call) and fetches the bill in full only when that answer is newer than the stored copy (RawBillOlderCopyRecheck,
 *   Outcome). It makes no call when a later listing of the bill was stored since (isRecheckSuperseded).
 * The fetched copy is stored and sent on as before either way: it is never worse than the stored one.
 *
 * 2026-11-25: two re-checks (30 minutes) were too few. Over 11-23 to 11-25, 43 bills listed once gave up, and each of
 * the 8 read again later was missing an update congress.gov's answer then had. About half the re-check calls went to
 * the few bills congress.gov re-stamps every few minutes, whose later listings fetch them anyway. So a re-check now
 * stops when a later listing was stored, and the default is 5 re-checks (75 minutes).
 */
export type OlderCopyRecheckMode = "off" | "watch" | "on";

export const parseOlderCopyRecheckMode = (value: string | undefined): OlderCopyRecheckMode => {
  const mode = (value ?? "").trim().toLowerCase();
  if (mode === "" || mode === "off") return "off";
  return mode === "on" ? "on" : "watch";
};

/** What a re-check message carries (its body's olderCopyRecheck). */
export interface OlderCopyRecheck {
  /** 1 on the first re-check, up to OLDER_COPY_MAX_RECHECKS. */
  attempt: number;
  /** The bill's update time (ISO) in the answer that was found older; used when the stored copy cannot be read. */
  updateDate: string | null;
}

const isoTimeMs = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
};

/** The body's olderCopyRecheck, or null on every other message (the poller's own, a text retry, a bulk send). */
export const olderCopyRecheckOf = (value: unknown): OlderCopyRecheck | null => {
  if (!value || typeof value !== "object") return null;
  const fields = value as { attempt?: unknown; updateDate?: unknown };
  const attempt = typeof fields.attempt === "number" ? fields.attempt : Number.NaN;
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return { attempt, updateDate: isoTimeMs(fields.updateDate) === null ? null : (fields.updateDate as string) };
};

/**
 * When the poller listed this message's bill: the run start in its correlation id, which is the top of the window
 * that listed it. Null for every message that is not the poller's (the REL-56 backfill's, refetch:stale-bills',
 * backfill:cosponsors', a repair's, one with no id): nothing says what their list showed.
 */
export const pollerListingTimeMs = (body: unknown, correlationId: string | undefined): number | null => {
  if (!isPollerCorrelationId(correlationId) || isBulkMessage(body, correlationId)) return null;
  return listingTimeOfCorrelationId(correlationId);
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * The bill's update time in congress.gov's bill answer ({ bill: { updateDate, updateDateIncludingText } }, the shape
 * a raw bill keeps as content.bill): the later of the two, in ms; null when it holds neither.
 */
export const billAnswerUpdateMs = (answer: unknown): number | null => {
  const outer = asRecord(answer);
  const bill = asRecord(outer?.bill) ?? outer;
  const times = [isoTimeMs(bill?.updateDate), isoTimeMs(bill?.updateDateIncludingText)].filter(
    (time): time is number => time !== null,
  );
  return times.length > 0 ? Math.max(...times) : null;
};

/** The update time of a stored raw bill (its content.bill), or null. */
export const storedCopyUpdateMs = (rawBill: unknown): number | null =>
  billAnswerUpdateMs(asRecord(asRecord(rawBill)?.content)?.bill);

/**
 * The listing a stored raw bill records: its metadata.listedAt (FetchRawBill writes it under FETCH_RETRY_BACKOFF
 * "on", retryLadder.ts), in ms, or null. Not the fallbacks storedListingTimeMs takes (the correlation id's run start,
 * fetchedAt): a bulk copy's id or a fetch time is no listing.
 */
export const storedCopyListedAtMs = (rawBill: unknown): number | null =>
  isoTimeMs(asRecord(asRecord(rawBill)?.metadata)?.listedAt);

/**
 * Before a re-check calls congress.gov: whether the stored copy holds a later listing than the one this re-check
 * follows. That listing's own fetch compared the bill's answer again and, still older, sent its own re-checks, so this
 * one stops with no call ("superseded"). A bill congress.gov re-stamps is listed every few minutes, and each listing
 * used to run its own re-checks of the same answer. The re-check's own listing (the copy its first fetch stored, or a
 * "newer" re-check's) is not later; nor is a bulk copy's, which keeps the stored listing. No recorded listing: the
 * re-check goes on.
 */
export const isRecheckSuperseded = (storedListedAtMs: number | null, listedAtMs: number): boolean =>
  storedListedAtMs !== null && storedListedAtMs > listedAtMs;

/**
 * Whether a bill answer is older than its listing: its update time is before the start of the window that listed it.
 * The fetcher does not know that start; the poller's window starts at the run before (SCHEDULE: 5 minutes) less its
 * 120-second overlap, so `windowSeconds` (480: those 7 minutes and one more for a late run) before the listing is
 * the earliest a listed row's time can be, counted from the window's top (the run start in whole seconds). A window
 * that was longer (a run after an outage) only makes a copy look older and costs re-checks, never one missed. No
 * update time: not older (nothing to compare).
 */
export const isOlderThanListing = (updateMs: number | null, listedAtMs: number, windowSeconds: number): boolean =>
  updateMs !== null && updateMs < Math.floor(listedAtMs / 1000) * 1000 - windowSeconds * 1000;

/**
 * What a re-check does: superseded (isRecheckSuperseded: a later listing was stored, no call), or with the bill's
 * answer, read again:
 * - newer: it is newer than the stored copy, so the bill is fetched in full and stored (and checked again if it is
 *   still older than its listing and re-checks remain);
 * - caught_up: no newer than the stored copy, which is already as new as the listing (another message stored it);
 * - still_older: no newer, and older than the listing: checked again later;
 * - gave_up: the same on the last re-check: the stored copy stays.
 * The answer without an update time counts as newer, so the bill is fetched as before.
 */
export type OlderCopyRecheckOutcome = "superseded" | "newer" | "caught_up" | "still_older" | "gave_up";

export const decideOlderCopyRecheck = (input: {
  answerUpdateMs: number | null;
  /** The stored copy's update time; when it cannot be read, the update time the older answer had. */
  storedUpdateMs: number | null;
  listedAtMs: number;
  windowSeconds: number;
  attempt: number;
  maxRechecks: number;
}): Exclude<OlderCopyRecheckOutcome, "superseded"> => {
  const { answerUpdateMs, storedUpdateMs, listedAtMs, windowSeconds, attempt, maxRechecks } = input;
  if (answerUpdateMs === null || storedUpdateMs === null || answerUpdateMs > storedUpdateMs) return "newer";
  if (!isOlderThanListing(storedUpdateMs, listedAtMs, windowSeconds)) return "caught_up";
  return attempt < maxRechecks ? "still_older" : "gave_up";
};
