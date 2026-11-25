import { createHash } from "node:crypto";
import type {
  BillStatusV1,
  RecentActionItemV1,
  RecentActionV1,
  RecentActionVoteTimingV1,
  RecentActionVoteV1,
} from "../../contracts";
import { BILL_STATUS_VALUES_V1 } from "../../contracts";
import { isRoutineFollowUpText } from "../../shared/billActions";
import { parseBillGuid } from "../../shared/billCompanions";
import { officialBillNumber } from "../../shared/billNumbers";
import { billOutcomeTextForAction, deriveBillVetoedFromActions } from "../../shared/billOutcomes";
import { addDays, daysBetween, easternDayKey } from "../../shared/civicDays";
import { usableOfficialVotes } from "../../shared/congressVotes";
import { normalizeInlineText, pushActionPhrase } from "../userNotifier/pushCopy";

/*
 * UX-35: the Updates tab's list, built on the server from the caller's own data (GET /recent-actions). Pure: the
 * handler reads the votes, watches, companion groups and processed bills, and this turns them into rows.
 *
 * - A row is one bill: a companion group (APPF-23) is one bill, shown by the member with the latest action, with the
 *   vote on the primary when the caller voted on both members, and watched when either member is.
 * - Its action is the bill's latest one dated in the window, worded as a push words it (pushActionPhrase): the bill's
 *   own outcome ("Passed the House", "Became law"), or Congress's text without record references. A routine follow-up
 *   ("Motion to reconsider laid on the table", billActions.ts) counts only when the window has nothing else, as in the
 *   Weekly Brief, and on the latest day an outcome line comes before the other lines of that day, which otherwise keep
 *   congress.gov's order (newest first, UX-43).
 * - The vote is the caller's own and nobody else's (INT-11): there is no count or tally anywhere in a row.
 * - UX-41 concept 2: voteTiming says how many days before a chamber's roll call the vote shown was saved. The roll
 *   call is the latest House or Senate vote on the bill (How Congress voted's, officialVotes) in the window. The vote's
 *   time is votedAt, when the row was last saved, so a vote changed or saved again on or after the roll call's day has
 *   no timing, and the line never claims an earlier vote than the one shown.
 */

export const DEFAULT_RECENT_ACTIONS_WINDOW_DAYS = 30;
export const RECENT_ACTIONS_MAX_ITEMS = 50;
/** The schema's maxLength for an action's text. */
const ACTION_TEXT_MAX_CHARS = 300;
const ELLIPSIS = "…";

/** The caller's vote on one bill, as stored: Yea, Nay or Abstain (never a 1.0 or 1.1 dismissal). */
export interface CallerVote {
  feedback: RecentActionVoteV1;
  /** When the row was last saved (ISO), or null for a vote without a time. */
  votedAt: string | null;
}

export interface RecentActionsInput {
  /** The caller's bills, one entry per bill: its guid, or a companion group's member guids, primary first. */
  groups: readonly (readonly string[])[];
  /** The processed bills read, by plain guid. A member that is not here (not read, or not stored) is skipped. */
  bills: ReadonlyMap<string, unknown>;
  /** The caller's votes, by plain guid. */
  votes: ReadonlyMap<string, CallerVote>;
  /** The plain guids the caller watches. */
  watched: ReadonlySet<string>;
  nowMs: number;
  windowDays: number;
}

type LooseAction = { actionCode?: unknown; actionDate?: unknown; text?: unknown; type?: unknown };

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** The leading YYYY-MM-DD of a congress.gov date when it is a real calendar day, else null. */
export const calendarDayOf = (value: unknown): string | null => {
  const match = DAY_RE.exec(trimmed(value));
  if (!match) return null;
  const [day, year, month, date] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(date)));
  return parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(date)
    ? day
    : null;
};

/** The first day of the window: `windowDays` Eastern calendar days before today's. Actions dated on it count. */
export const recentActionsWindowStart = (nowMs: number, windowDays: number): string =>
  addDays(easternDayKey(nowMs), -windowDays);

/** At most ACTION_TEXT_MAX_CHARS, cut at a word with "…" when longer. */
const clip = (text: string): string => {
  if (text.length <= ACTION_TEXT_MAX_CHARS) return text;
  const cut = text.slice(0, ACTION_TEXT_MAX_CHARS - ELLIPSIS.length);
  const lastSpace = cut.lastIndexOf(" ");
  const atWord = lastSpace > ACTION_TEXT_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
  return `${atWord.replace(/[\s,;:.-]+$/, "")}${ELLIPSIS}`;
};

/**
 * The bill's latest action dated on or after `windowStart`, in a push's words, or null when it has none there. Only
 * actions a push can word count (pushActionPhrase: an action without text that is no outcome has none).
 */
export const latestRecentAction = (actions: unknown, windowStart: string): RecentActionV1 | null => {
  const candidates = (Array.isArray(actions) ? actions : []).flatMap((value) => {
    const action = asRecord(value) as LooseAction | undefined;
    if (!action) return [];
    const day = calendarDayOf(action.actionDate);
    if (day === null || day < windowStart) return [];
    const actionCode = trimmed(action.actionCode) || undefined;
    const actionType = trimmed(action.type) || undefined;
    const text = typeof action.text === "string" ? action.text : "";
    const phrase = pushActionPhrase({ text, actionDate: day, actionCode, actionType });
    if (!phrase) return [];
    return [
      {
        day,
        phrase,
        actionCode,
        routine: isRoutineFollowUpText(normalizeInlineText(text)),
        outcome: billOutcomeTextForAction(action) !== null,
      },
    ];
  });
  const pool = candidates.some((action) => !action.routine)
    ? candidates.filter((action) => !action.routine)
    : candidates;
  if (pool.length === 0) return null;
  const latestDay = pool.reduce((latest, action) => (action.day > latest ? action.day : latest), pool[0].day);
  const ofDay = pool.filter((action) => action.day === latestDay);
  const chosen = ofDay.find((action) => action.outcome) ?? ofDay[0];
  return {
    date: chosen.day,
    text: clip(chosen.phrase),
    ...(chosen.actionCode ? { actionCode: chosen.actionCode } : {}),
  };
};

/** A chamber's recorded vote on a bill, as How Congress voted shows it. */
export interface ChamberRollCall {
  chamber: RecentActionVoteTimingV1["chamber"];
  date: string;
}

/** The House and Senate roll calls a processed bill holds (officialVotes), each with its calendar day. */
export const chamberRollCalls = (document: unknown): ChamberRollCall[] => {
  const votes = usableOfficialVotes(asRecord(document)?.officialVotes);
  if (!votes) return [];
  const calls: ChamberRollCall[] = [];
  const houseDay = calendarDayOf(votes.house?.actionDate);
  if (houseDay) calls.push({ chamber: "House", date: houseDay });
  const senateDay = calendarDayOf(votes.senate?.actionDate);
  if (senateDay) calls.push({ chamber: "Senate", date: senateDay });
  return calls;
};

/** The Eastern calendar day of an ISO time, or null when it is not one. */
export const easternDayOfTime = (iso: string | null): string | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : easternDayKey(ms);
};

/**
 * UX-41 concept 2: the days from the vote's day (`votedOn`, when it was last saved) to the latest roll call in the
 * window, when that is at least 1. Of two roll calls on one day the House's is named. Undefined when there is no vote
 * day, no roll call in the window, or the latest came the same day as the vote or before it.
 */
export const voteTimingFor = (
  votedOn: string | null,
  rollCalls: readonly ChamberRollCall[],
  windowStart: string,
): RecentActionVoteTimingV1 | undefined => {
  if (!votedOn) return undefined;
  let latest: ChamberRollCall | undefined;
  for (const call of rollCalls) {
    if (call.date < windowStart) continue;
    if (!latest || call.date > latest.date || (call.date === latest.date && call.chamber === "House")) latest = call;
  }
  if (!latest) return undefined;
  const daysBefore = daysBetween(votedOn, latest.date);
  return daysBefore >= 1 ? { chamber: latest.chamber, rollCallDate: latest.date, daysBefore } : undefined;
};

/** The row's id: the guid, the action's day and a hash of its wording (case aside). */
export const recentActionId = (guid: string, action: RecentActionV1): string =>
  `${guid}#${action.date}#${createHash("sha256").update(action.text.toLowerCase()).digest("hex").slice(0, 16)}`;

const BILL_STATUSES: ReadonlySet<string> = new Set(BILL_STATUS_VALUES_V1);

const billStatusOf = (document: Record<string, unknown> | undefined): BillStatusV1 | undefined => {
  const status = trimmed(document?.billStatus);
  return BILL_STATUSES.has(status) ? (status as BillStatusV1) : undefined;
};

/** One group's row, or null when no member read has an action in the window. */
const rowForGroup = (
  members: readonly string[],
  input: RecentActionsInput,
  windowStart: string,
): RecentActionItemV1 | null => {
  const loaded = members.flatMap((guid) => {
    const document = asRecord(input.bills.get(guid));
    return document ? [{ guid, document, action: latestRecentAction(document.actions, windowStart) }] : [];
  });
  // The member with the latest action; of two on one day, the earlier listed (the primary).
  let shown: (typeof loaded)[number] | undefined;
  for (const member of loaded) {
    if (member.action && (!shown?.action || member.action.date > shown.action.date)) shown = member;
  }
  if (!shown?.action) return null;

  const parsed = parseBillGuid(shown.guid);
  if (!parsed) return null;
  const officialNumber =
    officialBillNumber({ billType: parsed.billType, billNumber: parsed.billNumber, guid: shown.guid }) ?? shown.guid;
  const title = normalizeInlineText(trimmed(shown.document.title)) || officialNumber;
  const billStatus = billStatusOf(shown.document);
  const actions = Array.isArray(shown.document.actions) ? shown.document.actions : [];
  const vote = members.map((guid) => input.votes.get(guid)).find((value) => value !== undefined);
  const votedOn = vote ? easternDayOfTime(vote.votedAt) : null;
  const voteTiming = vote
    ? voteTimingFor(
        votedOn,
        loaded.flatMap((member) => chamberRollCalls(member.document)),
        windowStart,
      )
    : undefined;

  return {
    id: recentActionId(parsed.plainGuid, shown.action),
    billGuid: parsed.plainGuid,
    congress: parsed.congress,
    billType: parsed.billType,
    billNumber: parsed.billNumber,
    officialNumber,
    title,
    ...(billStatus ? { billStatus } : {}),
    ...(deriveBillVetoedFromActions(actions) ? { vetoed: true as const } : {}),
    action: shown.action,
    ...(vote ? { yourVote: vote.feedback } : {}),
    ...(votedOn ? { votedOn } : {}),
    ...(voteTiming ? { voteTiming } : {}),
    watched: members.some((guid) => input.watched.has(guid)),
  };
};

/** Newest action first, then by title, then by guid. */
const compareRows = (left: RecentActionItemV1, right: RecentActionItemV1): number => {
  if (left.action.date !== right.action.date) return left.action.date > right.action.date ? -1 : 1;
  const byTitle = left.title.localeCompare(right.title, "en", { sensitivity: "base" });
  if (byTitle !== 0) return byTitle;
  return left.billGuid < right.billGuid ? -1 : left.billGuid > right.billGuid ? 1 : 0;
};

/** The rows of the list: one per group with an action in the window, sorted, at most RECENT_ACTIONS_MAX_ITEMS. */
export const buildRecentActionItems = (input: RecentActionsInput): RecentActionItemV1[] => {
  const windowStart = recentActionsWindowStart(input.nowMs, input.windowDays);
  return input.groups
    .map((members) => rowForGroup(members, input, windowStart))
    .filter((row): row is RecentActionItemV1 => row !== null)
    .sort(compareRows)
    .slice(0, RECENT_ACTIONS_MAX_ITEMS);
};
