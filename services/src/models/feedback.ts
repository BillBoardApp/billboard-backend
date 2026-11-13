const FEEDBACK_VALUES = ["Yea", "Nay", "Abstain"] as const;
const FEEDBACK_REASON_KEYS = [
  "morals_values",
  "constitutional_rights",
  "economic_impact",
  "taxes_spending",
  "public_safety",
  "healthcare",
  "education",
  "environment",
  "national_security",
  "privacy_liberty",
  "local_community",
  "trust_sponsor",
  "evidence_data",
  "need_more_info",
] as const;
const MAX_FEEDBACK_REASONS = 3;

type Feedback = (typeof FEEDBACK_VALUES)[number];
type FeedbackReasonKey = (typeof FEEDBACK_REASON_KEYS)[number];

export function isValidFeedback(value: unknown): value is Feedback {
  return typeof value === "string" && (FEEDBACK_VALUES as readonly string[]).includes(value);
}

/**
 * INT-11: builds 1.0 and 1.1 (no X-Billboard-App-Version) store Abstain when the user dismisses a Passed or Failed
 * bill in Updates ("Dismiss" and "Dismiss All"). That is not a vote, so setFeedback marks such a row with
 * `legacyDismiss: true` (BOOL), and a one-time repair marked the rows stored before it did. A marked
 * row is kept, so the old build still sees the bill as handled, but it never unlocks other users' votes (GET
 * /bill-stats), it is counted in no bill's or companion group's results (isCountedVote in shared/billStats: not in
 * "N people abstained"), builds that send X-Billboard-App-Version do not get it from GET /feedback, and the weekly
 * digest does not read it as the user's vote. A later Yea or Nay, or an Abstain from 1.2 or later, replaces the row
 * and its mark.
 */
export const LEGACY_DISMISS_ATTRIBUTE = "legacyDismiss";

/** The statuses whose bills 1.0 and 1.1 list in Updates under Passed Bills and Failed Bills, with Dismiss. */
const DISMISSABLE_BILL_STATUSES: readonly string[] = ["Passed", "Failed"];

/** Whether a manifest billStatus is one whose bills 1.0 and 1.1 let the user dismiss with an Abstain write. */
export const isDismissableBillStatus = (status: unknown): boolean =>
  typeof status === "string" && DISMISSABLE_BILL_STATUSES.includes(status);

/**
 * REL-50: the BillsManifest partition of the "formerly failed" markers, one item per bill (sk: its plain guid, as the
 * BILL_GUID lookup's) whose manifest row was Failed and may since be open. Apps 1.0 and 1.1 never lower a status they
 * hold (preferredBillStatus), so a device that held the bill as Failed still lists it under Failed Bills and dismisses
 * it with an Abstain: setFeedback stores an Abstain from them on a marked bill as a dismissal (INT-11), as on a Passed
 * or Failed one. Written by CreateBillsManifest in the same transaction as any row that leaves Failed for an open
 * status (so SetFeedback never sees such a bill open without it), and by scripts/repairFailedStatus.ts for the bills
 * the rule before REL-50 stamped Failed from a line that is not the bill's own failure, before the release can lower
 * them. markedAt keeps the first marking. Never served; only setFeedback and the legacy-dismissal repair
 * (--formerly-failed-since) read them.
 */
export const FORMERLY_FAILED_MARKER_PK = "BILL_FORMERLY_FAILED";

/** A stored vote row, as DynamoDB returns it (only the attributes these helpers read). */
type StoredVoteRow = {
  feedback?: { S?: string };
  [LEGACY_DISMISS_ATTRIBUTE]?: { BOOL?: boolean };
};

/** Whether the row is an Abstain that a 1.0 or 1.1 dismissal stored (LEGACY_DISMISS_ATTRIBUTE). */
export const isLegacyDismissRow = (item: StoredVoteRow | undefined): boolean =>
  item?.[LEGACY_DISMISS_ATTRIBUTE]?.BOOL === true;

/** INT-11: whether the row is a vote that unlocks other users' votes: Yea, Nay or Abstain, and not a dismissal. */
export const unlocksResults = (item: StoredVoteRow | undefined): boolean =>
  isValidFeedback(item?.feedback?.S) && !isLegacyDismissRow(item);

/**
 * UX-31: when the user first voted on the bill, the time the Civic Score counts the vote's day by. `votedAt` stays the
 * time of the row's last write (GET /bill-stats and the Weekly Brief read it so), and a changed vote keeps this one, so
 * changing an old vote adds no day to a streak. SetFeedback writes it (firstVotedAtFor); a row has:
 * - an ISO time (S): the first Yea, Nay or Abstain that was not a 1.0 or 1.1 dismissal. A later dismissal on the same
 *   bill keeps it, so a vote after that is still not a new first vote;
 * - NULL: a vote stored before votes were timed (no votedAt) and changed since. Counted, on no day;
 * - nothing: a row written before UX-31 (its votedAt, the time of its last change before then, is the best time known:
 *   firstVoteTimeOf), or a dismissal that never was a vote.
 */
export const FIRST_VOTED_AT_ATTRIBUTE = "firstVotedAt";

type FirstVoteRow = StoredVoteRow & {
  votedAt?: { S?: string };
  [FIRST_VOTED_AT_ATTRIBUTE]?: { S?: string; NULL?: boolean };
};

/**
 * The `firstVotedAt` a vote write stores, given the row it replaces (read with feedback, votedAt, firstVotedAt and
 * the dismissal mark) and whether the write is a vote (false for a 1.0 or 1.1 dismissal). Undefined: store none.
 */
export const firstVotedAtFor = (
  prior: FirstVoteRow | undefined,
  nowIso: string,
  isVote: boolean,
): { S: string } | { NULL: true } | undefined => {
  const kept = prior?.[FIRST_VOTED_AT_ATTRIBUTE];
  if (typeof kept?.S === "string" && kept.S) return { S: kept.S };
  if (kept?.NULL === true) return { NULL: true };
  if (prior && unlocksResults(prior)) {
    // A vote stored before UX-31: its votedAt is the time of its last change, the best time known.
    const votedAt = prior.votedAt?.S;
    return typeof votedAt === "string" && votedAt ? { S: votedAt } : { NULL: true };
  }
  return isVote ? { S: nowIso } : undefined;
};

/**
 * When the user first voted on the bill, as stored (FIRST_VOTED_AT_ATTRIBUTE), or the row's votedAt when it has none
 * (a row written before UX-31). Null for a vote with no time at all.
 */
export const firstVoteTimeOf = (item: FirstVoteRow | undefined): string | null => {
  const first = item?.[FIRST_VOTED_AT_ATTRIBUTE];
  if (typeof first?.S === "string" && first.S) return first.S;
  if (first?.NULL === true) return null;
  const votedAt = item?.votedAt?.S;
  return typeof votedAt === "string" && votedAt ? votedAt : null;
};

export function normalizeFeedbackReasons(value: unknown): FeedbackReasonKey[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const seen = new Set<FeedbackReasonKey>();
  const normalized: FeedbackReasonKey[] = [];

  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!(FEEDBACK_REASON_KEYS as readonly string[]).includes(trimmed)) return null;

    const key = trimmed as FeedbackReasonKey;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }

  if (normalized.length > MAX_FEEDBACK_REASONS) return null;
  return normalized;
}
