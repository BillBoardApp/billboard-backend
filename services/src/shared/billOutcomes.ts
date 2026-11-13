import type { BillStatusValue } from "../models/bill";
import { actionTextWithoutCitations } from "./congressionalRecordCitations";

// Passed and Failed (docs/RUNBOOK.md 4.11), and Finalized (4.13). A bill's status is Finalized once an action records
// it becoming law (REL-44, below), else it comes from its most recent outcome action: a passage or a failure of the
// bill itself (deriveBillStatusFromActions), and a new outcome action is what sends a "passed" or "failed" push
// (notificationType, latestNewBillOutcomeAction).
//
// REL-50 (feature review S7; project decision 2026-10-28: trust action codes). congress.gov gives each milestone its
// Library of Congress action code: 8000 "Passed/agreed to in House", 17000 "Passed/agreed to in Senate", 9000 "Failed
// of passage/not agreed to in House", 18000 "Failed of passage/not agreed to in Senate", 33000 and 35000 "Failed of
// passage in House/Senate over veto". Amendments have codes of their own (73000, 77000, 80000, 95000 and others), and
// so do conference reports (22000, 24000); the House's own floor lines carry its H-codes, the Senate's carry none.
// Until REL-50 any action's text matching "not agreed to in House/Senate" counted as a failure, so a line such as
// "Amendment SA 2205 not agreed to in Senate" or "Motion to proceed to consideration of measure not agreed to in
// Senate" stamped a live bill FAILED and sent a "Failed:" push in the middle of its debate. Now a failure counts only
// with one of the four failure codes, unless its text shows the vote was not on the bill itself, and never without a
// code, whatever the text: like passage, a failure waits for its Library of Congress code (the Senate's own line for
// the same vote, which has none, would otherwise count once uncoded and again when coded, with two "Failed:" pushes).
//
// Never an amendment (a measure voted on "without amendment" or "with an amendment", or a joint resolution proposing a
// constitutional amendment, is still the bill), a motion (to recommit, table, proceed, commit, reconsider, waive,
// concur, discharge, instruct; "On motion that the House agree to the Senate amendment"), cloture, a conference report
// or a point of order, and never an action with any other code, whatever its text. When unsure, nothing is stamped: a
// false FAILED, and its push, is worse than a missing one. Passage is unchanged: codes 8000 and 17000 only.
//
// A failed vote under a threshold that procedure set, not the Constitution, is not the bill's failure: the chamber can
// take the bill up again and pass it by a simple majority, and such votes often have a majority for it.
//
//   - A failed suspension vote. A motion to suspend the rules and pass a bill needs two thirds of the House; the
//     Library of Congress codes its defeat 9000 ("Failed of passage/not agreed to in House: On motion to suspend the
//     rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180"), but CRS report 98-314
//     (Suspension of the Rules in the House: Principal Features, 2022) says the House can take such a bill up again,
//     for example under a rule from the Rules Committee, which needs only a simple majority. The unitedstates/congress
//     project behind GovTrack gives it the status PROV_KILL:SUSPENSIONFAILED, "provisionally killed", apart from an
//     outright failure (FAIL:ORIGINATING:HOUSE). H.R. 7217 failed so in February 2024, 250 - 180.
//   - A failed Senate vote under an agreement that it needs 60 votes ("Under the order of 9/18/2025, not having
//     achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48."; coded 18000). The
//     Senate reconsiders such votes and agrees to new orders: H.R. 5371, the FY2026 continuing resolution, failed so on
//     2025-09-19 (44 - 48) and on reconsideration on 2025-09-30 (55 - 45), passed the Senate 60 - 40 on 2025-11-10 and
//     became Public Law 119-37 on 2025-11-12. Under the code alone it would have shown FAILED for seven weeks, with two
//     "Failed:" pushes, before it became law.
//
// Either keeps the bill's status, and reaches its followers as an action push in plain words (FAILED_SUSPENSION_TEXT,
// FAILED_SIXTY_VOTES_TEXT), never as "Failed:". A constitutional amendment short of the two thirds the Constitution
// asks, and a failed veto override (33000, 35000), are still the bill's failure.

type RawBillAction = {
  actionCode?: unknown;
  actionDate?: unknown;
  text?: unknown;
  type?: unknown;
};

export type BillOutcomeKind = "passed" | "failed";

export type BillOutcomeAction = {
  kind: BillOutcomeKind;
  actionCode?: string;
  actionDate?: string;
  actionType?: string;
  text?: string;
};

/** Decides whether one action is an outcome of the bill, and which. */
export type BillOutcomeRule = (action: unknown) => BillOutcomeKind | null;

const PASSAGE_ACTION_CODES = new Set(["8000", "17000"]);
const FAILED_ACTION_CODES = new Set(["9000", "18000", "33000", "35000"]);
/** The Library of Congress code of a failure in the House (a failed suspension vote has it too). */
const HOUSE_FAILURE_ACTION_CODE = "9000";
/** The Library of Congress code of a failure in the Senate (a failed vote under a 60-vote order has it too). */
const SENATE_FAILURE_ACTION_CODE = "18000";

/** Why an action that reads like a failure is not the bill's own failure (REL-50). */
export type NotBillFailureReason =
  /** A motion to suspend the rules (two thirds needed): the bill can come back. */
  | "suspension"
  /** A Senate vote under an order that it needs 60 votes (three fifths): the bill can come back. */
  | "sixtyVotes"
  | "motion"
  | "cloture"
  | "amendment"
  | "conferenceReport"
  | "pointOfOrder"
  /** A code that is not a failure code (an amendment, floor or other code): codes are trusted over text. */
  | "otherCode"
  /** No code: a failure counts only with its Library of Congress code, as passage does. */
  | "uncoded";

/** The votes that are not on the bill itself, in the order they are checked (suspension before any other motion). */
const NOT_THE_BILL_PATTERNS: ReadonlyArray<readonly [NotBillFailureReason, RegExp]> = [
  ["suspension", /\bsuspend(?:ing)? the rules\b/i],
  ["motion", /\bmotions?\b/i],
  ["cloture", /\bcloture\b/i],
  ["amendment", /\bamendments?\b|\bamdt\b/i],
  ["conferenceReport", /\bconference report\b/i],
  ["pointOfOrder", /\bpoint of order\b/i],
  ["sixtyVotes", /\b60 votes\b|\bthree[- ]fifths\b/i],
];

/**
 * Mentions of an amendment that do not make it the vote's subject: a measure voted on "without amendment" or "with an
 * amendment", and a joint resolution proposing an amendment to the Constitution. Removed before the patterns above.
 */
const AMENDMENT_NOT_THE_SUBJECT = /\bwith(?:out)? (?:an )?amendments?\b|\bamendments? to the constitution\b/gi;

/**
 * The plain words of an action push for a failed suspension vote (REL-50; wording approved by the project 2026-10-29).
 * Said instead of "Failed in the House", which a bill that can come back has not done.
 */
export const FAILED_SUSPENSION_TEXT = "House vote fell short of two-thirds";

/**
 * The plain words of an action push for a failed Senate vote under a 60-vote order (REL-50; wording approved by the
 * project 2026-10-29). Said instead of "Failed in the Senate", which a bill that can come back has not done.
 */
export const FAILED_SIXTY_VOTES_TEXT = "Senate vote fell short of 60";

// REL-44. Finalized means the bill became law: the President signed it, it became law without a signature, or Congress
// overrode a veto. Like passage and failure under REL-50, it is read from the Library of Congress's coding, never from
// text alone: code 36000 (congress.gov type "BecameLaw"), which it gives both "Signed by President." and "Became Public
// Law No: 119-52." (or "Became Private Law No: ..."), and E40000, the House's own "Became Public Law No: ..." line.
// Nothing else is Finalized:
//   - a vetoed bill is not law ("Vetoed by President.", 31000 and E30000): it stays Passed, and a failed override
//     (33000, 35000) makes it Failed as before; a pocket veto (30000) has no enactment action either;
//   - "Presented to President." (28000, E20000) and "Sent to Archivist of the United States unsigned." (E30000) come
//     before the law: the bill turns Finalized when the 36000 or E40000 line that follows arrives. The House's own
//     "Signed by President." line is coded E30000 too, so it counts only through its 36000 twin;
//   - simple and concurrent resolutions agreed to, and joint resolutions proposing a constitutional amendment, never
//     go to the President and never become law: they stay Passed;
//   - a line without the code, whatever its text: "Signed by President pro tempore of the Senate.", or a later action
//     that mentions another bill's public law.
// When unsure, nothing is stamped: apps 1.1 and 1.2 never lower a status they hold, so a false Finalized would stay on
// devices after the bill page is put right.
const ENACTMENT_ACTION_CODES = new Set(["36000", "E40000"]);
const ENACTMENT_ACTION_TYPE = "becamelaw";

/**
 * The plain words of an action push for an action that records the bill becoming law (REL-44), the label both apps
 * show for Finalized. Said instead of Congress's "Signed by President." or "Became Public Law No: 119-52.", so the law
 * lines of one day read the same and reach a follower as one push (notificationType's repeated-vote rule).
 */
export const BECAME_LAW_TEXT = "Became law";

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const toOptionalString = (value: unknown): string | undefined => {
  const trimmed = toTrimmedString(value);
  return trimmed.length > 0 ? trimmed : undefined;
};

const asAction = (action: unknown): RawBillAction =>
  action && typeof action === "object" ? (action as RawBillAction) : {};

const toEpochMsOrNull = (value: unknown): number | null => {
  const raw = toTrimmedString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

const sortMostRecentFirst = (actions: RawBillAction[]): RawBillAction[] =>
  actions
    .map((action, index) => ({ action, index, time: toEpochMsOrNull(action.actionDate) }))
    .sort((left, right) => {
      if (left.time === null && right.time === null) return left.index - right.index;
      if (left.time === null) return 1;
      if (right.time === null) return -1;
      if (left.time !== right.time) return right.time - left.time;
      return left.index - right.index;
    })
    .map((entry) => entry.action);

/**
 * An action without its Congressional Record citations: its date, code and type, and its text without the citations at
 * its end, with spaces collapsed and case ignored (actionTextWithoutCitations, as the manifest date knows it).
 * newBillActions pairs a line with the one it replaced by this key: a passage line that gains "(text: CR H6104)" is no
 * new passage. Only the key drops them; a push names the action by its own text.
 */
export const normalizeBillActionKey = (action: unknown): string => {
  const record = (action ?? {}) as RawBillAction;
  const actionDate = toTrimmedString(record.actionDate);
  const actionCode = toTrimmedString(record.actionCode);
  const actionType = toTrimmedString(record.type);
  const text = actionTextWithoutCitations(toTrimmedString(record.text));
  return `${actionDate}|${actionCode}|${actionType}|${text}`;
};

/** An action as congress.gov wrote it: its date, code, type and text, citations included. */
const billActionKeyAsWritten = (action: unknown): string => {
  const record = (action ?? {}) as RawBillAction;
  return [record.actionDate, record.actionCode, record.type, record.text].map(toTrimmedString).join("|");
};

/**
 * The actions of `current` that `previous` does not have: what notificationType's alert counts and names, and where
 * latestNewBillOutcomeAction looks for a passage or failure. An action is new when `previous` has no action of its
 * date, code, type and text as written (as before 2026-11-12), unless it takes the place of a previous action that
 * differs from it only by Congressional Record citations (normalizeBillActionKey) and that `current` no longer has as
 * written. congress.gov adds, changes and drops citations on actions it already lists, days or months later, and such
 * an edit is not news (project decision 2026-11-12, docs/RUNBOOK.md 18.1). Each replaced action takes the place of one,
 * so a step repeated on one day that comes in a later version with a citation of its own is still new (H.R. 8800's
 * "Considered as unfinished business." at H5029-5127, then at H5153-5157 on 2026-07-22). Of two lines that could take
 * one place, the older takes it and the newer is new (congress.gov lists the newest first).
 */
export const newBillActions = <T>(previous: readonly unknown[], current: readonly T[]): Set<T> => {
  const previousAsWritten = new Set(previous.map(billActionKeyAsWritten));
  const currentAsWritten = new Set(current.map(billActionKeyAsWritten));
  const replaced = new Map<string, number>();
  for (const action of previous) {
    if (currentAsWritten.has(billActionKeyAsWritten(action))) continue;
    const key = normalizeBillActionKey(action);
    replaced.set(key, (replaced.get(key) ?? 0) + 1);
  }

  const added = new Set<T>();
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const action = current[index];
    if (previousAsWritten.has(billActionKeyAsWritten(action))) continue;
    const key = normalizeBillActionKey(action);
    const places = replaced.get(key) ?? 0;
    if (places > 0) replaced.set(key, places - 1);
    else added.add(action);
  }
  return added;
};

const voteNotOnTheBill = (text: string): NotBillFailureReason | null => {
  const subject = text.replace(AMENDMENT_NOT_THE_SUBJECT, " ");
  return NOT_THE_BILL_PATTERNS.find(([, pattern]) => pattern.test(subject))?.[0] ?? null;
};

/**
 * Why `action` is not the bill's own failure, or null when it is one (the rule is at the top of this file). A passage
 * code gives "otherCode".
 */
export const notBillFailureReason = (action: unknown): NotBillFailureReason | null => {
  const record = asAction(action);
  const actionCode = toTrimmedString(record.actionCode);
  const text = toTrimmedString(record.text);
  if (!actionCode) return voteNotOnTheBill(text) ?? "uncoded";
  if (!FAILED_ACTION_CODES.has(actionCode)) return "otherCode";
  return voteNotOnTheBill(text);
};

/** True when `action` records the bill's own failure (REL-50). */
export const isBillFailureAction = (action: unknown): boolean => notBillFailureReason(action) === null;

/** The outcome `action` records for the bill: passed (codes 8000, 17000), failed (isBillFailureAction), or null. */
export const billOutcomeKindForAction: BillOutcomeRule = (action) => {
  if (PASSAGE_ACTION_CODES.has(toTrimmedString(asAction(action).actionCode))) return "passed";
  return isBillFailureAction(action) ? "failed" : null;
};

/** True for an action that records the bill becoming law (REL-44; the rule is above ENACTMENT_ACTION_CODES). */
export const isEnactmentAction = (action: unknown): boolean => {
  const record = asAction(action);
  return (
    ENACTMENT_ACTION_CODES.has(toTrimmedString(record.actionCode)) ||
    toTrimmedString(record.type).toLowerCase() === ENACTMENT_ACTION_TYPE
  );
};

const toBillOutcomeAction = (action: RawBillAction, rule: BillOutcomeRule): BillOutcomeAction | null => {
  const kind = rule(action);
  if (!kind) return null;

  return {
    kind,
    actionCode: toOptionalString(action.actionCode),
    actionDate: toOptionalString(action.actionDate),
    actionType: toOptionalString(action.type),
    text: toOptionalString(action.text),
  };
};

const normalizeActions = (actions: unknown[] | null | undefined): RawBillAction[] =>
  Array.isArray(actions) ? actions.map((action) => (action ?? {}) as RawBillAction) : [];

/**
 * The most recent outcome action, or null. `rule` defaults to the rule above; the REL-50 status repair passes the
 * rule before it to report what decided a stored status (scripts/repairFailedStatus.ts).
 */
export const latestBillOutcomeAction = (
  actions: unknown[] | null | undefined,
  rule: BillOutcomeRule = billOutcomeKindForAction,
): BillOutcomeAction | null => {
  for (const action of sortMostRecentFirst(normalizeActions(actions))) {
    const outcome = toBillOutcomeAction(action, rule);
    if (outcome) {
      return outcome;
    }
  }

  return null;
};

/**
 * The most recent outcome action of `currentActions` that `previousActions` did not have (newBillActions: an action
 * that only gained, changed or lost a Congressional Record citation is not new), or null.
 */
export const latestNewBillOutcomeAction = (
  previousActions: unknown[] | null | undefined,
  currentActions: unknown[] | null | undefined,
): BillOutcomeAction | null => {
  const current = normalizeActions(currentActions);
  const added = newBillActions(normalizeActions(previousActions), current);

  for (const action of sortMostRecentFirst(current)) {
    if (!added.has(action)) continue;

    const outcome = toBillOutcomeAction(action, billOutcomeKindForAction);
    if (outcome) {
      return outcome;
    }
  }

  return null;
};

/**
 * The date (YYYY-MM-DD) of the bill's earliest dated passage or failure action: from that day on its derived status
 * is Passed, Failed or (once it becomes law, REL-44) Finalized (deriveBillStatusFromActions), never New again. null
 * when it has no dated outcome action.
 */
export const firstBillOutcomeDate = (actions: unknown[] | null | undefined): string | null => {
  let first: string | null = null;
  for (const action of normalizeActions(actions)) {
    if (!billOutcomeKindForAction(action)) continue;
    const date = toTrimmedString(action.actionDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (first === null || date < first) first = date;
  }
  return first;
};

/** The status an outcome gives: Passed or Failed, or New without one. */
export const billStatusForOutcome = (outcome: Pick<BillOutcomeAction, "kind"> | null): BillStatusValue => {
  if (!outcome) return "New";
  return outcome.kind === "passed" ? "Passed" : "Failed";
};

/** The most recent action that records the bill becoming law, or null (for reports; the status needs only one). */
export const latestEnactmentAction = (
  actions: unknown[] | null | undefined,
): Omit<BillOutcomeAction, "kind"> | null => {
  const action = sortMostRecentFirst(normalizeActions(actions)).find(isEnactmentAction);
  if (!action) return null;
  return {
    actionCode: toOptionalString(action.actionCode),
    actionDate: toOptionalString(action.actionDate),
    actionType: toOptionalString(action.type),
    text: toOptionalString(action.text),
  };
};

/**
 * The bill's status from its actions: Finalized once any action records it becoming law (a law stays law, whatever
 * the order of same-day actions), else Passed or Failed by its most recent outcome action, else New.
 */
export const deriveBillStatusFromActions = (actions: unknown[] | null | undefined): BillStatusValue => {
  if (normalizeActions(actions).some(isEnactmentAction)) return "Finalized";
  const latestOutcome = latestBillOutcomeAction(actions);
  if (!latestOutcome) return "New";
  return latestOutcome.kind === "passed" ? "Passed" : "Failed";
};

/** True for the House's failed vote on a motion to suspend the rules and pass the bill (or agree to it). */
const isFailedSuspensionVote = (action: RawBillAction): boolean => {
  const actionCode = toTrimmedString(action.actionCode);
  const text = toTrimmedString(action.text);
  return (
    (actionCode === HOUSE_FAILURE_ACTION_CODE || actionCode === "" || /^H/i.test(actionCode)) &&
    voteNotOnTheBill(text) === "suspension" &&
    /\bfailed\b/i.test(text)
  );
};

/** True for the Senate's failed vote on the bill under an order that it needs 60 votes (coded 18000, or uncoded). */
const isFailedSixtyVoteVote = (action: RawBillAction): boolean => {
  const actionCode = toTrimmedString(action.actionCode);
  const text = toTrimmedString(action.text);
  return (
    (actionCode === SENATE_FAILURE_ACTION_CODE || actionCode === "") &&
    voteNotOnTheBill(text) === "sixtyVotes" &&
    /\bfailed\b/i.test(text)
  );
};

/**
 * The plain words for the bill's own passage or failure when Congress coded it ("Passed the House", "Senate failed to
 * override the veto"), BECAME_LAW_TEXT for an action that records it becoming law (REL-44), FAILED_SUSPENSION_TEXT for a failed suspension vote, FAILED_SIXTY_VOTES_TEXT for a failed
 * Senate vote under a 60-vote order, or null for any other action (pushes then use Congress's text). Pushes use them
 * instead of Congress's longer text for the same action.
 */
export const billOutcomeTextForAction = (action: unknown): string | null => {
  const record = asAction(action);
  const code = toTrimmedString(record.actionCode);
  if (isEnactmentAction(record)) return BECAME_LAW_TEXT;
  if (isFailedSuspensionVote(record)) return FAILED_SUSPENSION_TEXT;
  if (isFailedSixtyVoteVote(record)) return FAILED_SIXTY_VOTES_TEXT;
  if (!PASSAGE_ACTION_CODES.has(code) && !FAILED_ACTION_CODES.has(code)) return null;
  const kind = billOutcomeKindForAction(record);
  return kind ? defaultBillOutcomeText({ kind, actionCode: code }) : null;
};

export const defaultBillOutcomeText = (outcome: Pick<BillOutcomeAction, "kind" | "actionCode">): string => {
  if (outcome.kind === "passed") {
    return outcome.actionCode === "8000" ? "Passed the House" : "Passed the Senate";
  }

  switch (outcome.actionCode) {
    case "9000":
      return "Failed in the House";
    case "18000":
      return "Failed in the Senate";
    case "33000":
      return "House failed to override the veto";
    case "35000":
      return "Senate failed to override the veto";
    default:
      return "Failed a vote";
  }
};
