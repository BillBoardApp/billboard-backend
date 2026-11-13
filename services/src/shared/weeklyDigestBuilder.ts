import type { CompanionGroupV1 } from "../contracts";
import type { BillManifestEntry, BillStatusValue, ProcessedBillDocument } from "../models/bill";
import { canonicalSubCategory } from "../models/categories";
import type { WeeklyDigest, WeeklyDigestAccent, WeeklyDigestBillState, WeeklyDigestItem } from "../models/weeklyDigest";
import { plainBillGuid } from "./billCompanions";
import type { BillContentTypePreference } from "./billContentTypes";
import { billTypeMatchesContentPreferences } from "./billContentTypes";
import { officialBillNumber } from "./billNumbers";
import { isCommemorativeResolution } from "./commemorativeResolutions";
import { deterministicUuidFromString } from "./deterministicUuid";
import {
  addEasternDays,
  formatWeeklyDigestDay,
  formatWeeklyDigestShortDate,
  formatWeeklyDigestTitle,
  weeklyDigestDayKey,
  weeklyDigestDayKeyOf,
  type WeeklyDigestPublicationWindow,
} from "./weeklyDigestSchedule";

/*
 * What the Weekly Brief says (feature review 2026-10-28, S2 and S6). Both apps show an item's `title`, `summary`
 * and `reason`; app 1.1 also shows `detail` (two lines under the summary), app 1.2 never does. So:
 * - A bill's `summary` is what happened this week: Congress's latest action inside the week, with its date
 *   ("Mar 19: Passed the House."), passing over routine follow-ups such as calendar placements. Only without an
 *   action in the week is it the bill's "what it does" text.
 * - Its `detail` (1.1 only) is the context the summary did not use: "what it does" under an action, or the
 *   bottom line (soWhat) under "what it does". Never the same sentence as the summary or the title.
 * - A member item names its bills ("Cosponsored H.R. 77 and 1 more bill that moved this week."), counted over
 *   every candidate of the week, not only the dozen the sections draw on.
 * - The headline counts the sections' items and says "members you follow"; it never says a member "took
 *   action", since all the brief knows is that a followed member sponsors or cosponsors a bill that moved. It
 *   stays within the three lines app 1.1's Updates card shows (see `weeklyDigestHeadline`).
 * - A decided bill the user already voted on has nothing left to ask, so it leaves "Needs attention".
 * - A ceremonial resolution (shared/commemorativeResolutions.ts) never counts as a topic or life-area match,
 *   never shows in "Worth a quick look" and ranks last, unless the user watches it or voted on it. The official
 *   title decides once the bill is loaded; before that, a headline that reads as ceremonial only ranks it last.
 * Nothing here reads other users' votes (INT-11): the only votes in the input are the user's own.
 */

/** The longest Congress action text an item quotes, before "…". */
const ACTION_TEXT_MAX_CHARS = 200;
/** The longest "what it does" or bottom-line text an item quotes, before "…". */
const CONTEXT_TEXT_MAX_CHARS = 300;
/** Candidates whose processed bills are loaded for the bill sections. */
const HYDRATED_CANDIDATES = 12;

export interface WeeklyDigestPreferencesSummary {
  trackedTopics: string[];
  trackedLifeAreas: string[];
  followedMembers: string[];
  watchedBillGuids: string[];
  selectedBillContentTypes: BillContentTypePreference[];
}

export interface WeeklyDigestVoteRecord {
  billId: string;
  feedback: string;
  votedAt?: string | null;
}

type ProcessedBillLike = ProcessedBillDocument & {
  summary?: string;
  actions?: unknown[];
};

interface WeeklyDigestBuildInput {
  window: WeeklyDigestPublicationWindow;
  preferences: WeeklyDigestPreferencesSummary;
  voteStatesByBillId: Map<string, WeeklyDigestVoteRecord>;
  manifestItems: BillManifestEntry[];
  memberNameById: Map<string, string>;
  loadProcessedBill: (item: BillManifestEntry) => Promise<ProcessedBillLike | null>;
  /**
   * APPF-23: the published companion groups by member plain guid (shared/billCompanions.ts
   * companionIndex). A group is one candidate, watched or voted when any member is. Empty or absent:
   * every bill is its own candidate, as before.
   */
  companionIndex?: ReadonlyMap<string, CompanionGroupV1>;
}

type PriorityBucket =
  | "watched_changed"
  | "followed_representatives"
  | "voted_updated"
  | "passed_tracked"
  | "tracked_movement";

interface Candidate {
  manifest: BillManifestEntry;
  status: BillStatusValue;
  updatedAt: Date;
  watched: boolean;
  userPreviouslyVoted: boolean;
  /** The bill's topics and life areas the user follows, whether or not they count (see `ceremonial`). */
  followedAreas: { topics: string[]; lifeAreas: string[] };
  /** The followed topics and life areas that count: none for a ceremonial resolution. */
  topicMatches: string[];
  lifeAreaMatches: string[];
  matchingMemberIds: string[];
  /** The followed members who sponsor the bill; the rest of `matchingMemberIds` cosponsor it. */
  sponsoringMemberIds: string[];
  /**
   * A ceremonial resolution (S6): no topic or life-area match, never "Worth a quick look", ranked last. Known only
   * once the processed bill is loaded, from its official title (see `ceremonialVerdict`).
   */
  ceremonial: boolean;
  /**
   * The manifest headline reads as ceremonial (for a companion group, either bill's). Until the bill is loaded this
   * only ranks it last: the headline is the short plain form, which can drop the words that make a resolution more
   * than ceremonial ("Honor the victims" for "Honoring the victims … and condemning the attack").
   */
  looksCeremonial: boolean;
  inTrackedAreas: boolean;
  priorityBucket: PriorityBucket;
  /**
   * The per-bill candidates of a companion group this candidate stands for (APPF-23), whose own
   * sponsors keep the representatives section per bill. Absent for an ungrouped bill.
   */
  companionMembers?: Candidate[];
}

/** A candidate before its matches count: `classify` derives the rest. */
type CandidateFacts = Omit<Candidate, "topicMatches" | "lifeAreaMatches" | "inTrackedAreas" | "priorityBucket">;

interface RankedCandidate extends Candidate {
  bill: ProcessedBillLike;
}

/** One bill a followed member sponsors or cosponsors, and the candidate (maybe a companion group) it is part of. */
interface MemberBill {
  candidate: Candidate;
  manifest: BillManifestEntry;
  sponsored: boolean;
}

interface MemberActivity {
  id: string;
  name: string;
  /** The member's bills that moved this week, the one to name first, without repeats. */
  bills: MemberBill[];
}

const PRIORITY_ORDER: PriorityBucket[] = [
  "watched_changed",
  "followed_representatives",
  "voted_updated",
  "passed_tracked",
  "tracked_movement",
] as const;

// Finalized (the bill became law, REL-44) ranks first: it is the last and biggest step a bill takes. Until REL-44 no
// bill was ever Finalized, so its old weight (1) was never used.
const STATUS_WEIGHT: Record<BillStatusValue, number> = {
  Finalized: 5,
  Passed: 4,
  Failed: 4,
  Updated: 3,
  New: 2,
};

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * A sub-category as a match key, with a former name (LLM-10) folded into its current one, so a follow and a bill
 * label match whichever name either was stored under.
 */
function normalizeTopic(value: string | null | undefined): string {
  return normalize(canonicalSubCategory((value ?? "").trim()));
}

/** A bill's labels under their current names (a former name shown as its current one), unique, in order. */
function currentTopicNames(values: readonly unknown[]): string[] {
  const names = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => canonicalSubCategory(value.trim()));
  return Array.from(new Set(names));
}

function normalizeBillGuid(value: string | null | undefined): string {
  return normalize(value);
}

function normalizeBillStatus(value: string | null | undefined): BillStatusValue {
  switch (value) {
    case "Updated":
    case "Passed":
    case "Failed":
    case "Finalized":
      return value;
    case "New":
    default:
      return "New";
  }
}

function bucketRank(bucket: PriorityBucket): number {
  return PRIORITY_ORDER.indexOf(bucket);
}

/** Passed, failed or became law: the bill's outcome is known (S2: a vote on it leaves "Needs attention"). */
function hasOutcome(status: BillStatusValue): boolean {
  return status === "Passed" || status === "Failed" || status === "Finalized";
}

/**
 * The bucket a bill takes for the user, from its matches, or null when it is not for them. Unchanged by S2: a
 * ceremonial resolution simply arrives with no topic or life-area match.
 */
function priorityBucketFor(
  candidate: Pick<Candidate, "watched" | "matchingMemberIds" | "userPreviouslyVoted" | "status" | "inTrackedAreas">,
): PriorityBucket | null {
  const { status, inTrackedAreas } = candidate;
  if (candidate.watched) {
    return "watched_changed";
  }

  if (candidate.matchingMemberIds.length > 0) {
    return "followed_representatives";
  }

  if (candidate.userPreviouslyVoted && status === "Updated") {
    return "voted_updated";
  }

  if (inTrackedAreas && hasOutcome(status)) {
    return "passed_tracked";
  }

  if (inTrackedAreas && (status === "Updated" || status === "New")) {
    return "tracked_movement";
  }

  return null;
}

/** The candidate with the matches that count and its bucket, or null when nothing makes it the user's. */
function classify(facts: CandidateFacts): Candidate | null {
  const topicMatches = facts.ceremonial ? [] : facts.followedAreas.topics;
  const lifeAreaMatches = facts.ceremonial ? [] : facts.followedAreas.lifeAreas;
  const inTrackedAreas = topicMatches.length > 0 || lifeAreaMatches.length > 0;
  const priorityBucket = priorityBucketFor({ ...facts, inTrackedAreas });
  return priorityBucket ? { ...facts, topicMatches, lifeAreaMatches, inTrackedAreas, priorityBucket } : null;
}

/**
 * A ceremonial resolution nobody asked about, or before its bill is loaded one whose headline reads as ceremonial:
 * it ranks after every other candidate (S6).
 */
function ranksLast(candidate: Candidate): boolean {
  return (candidate.ceremonial || candidate.looksCeremonial) && !candidate.watched && !candidate.userPreviouslyVoted;
}

function candidateTieBreaker(candidate: Candidate): number {
  return (
    candidate.matchingMemberIds.length * 10 +
    candidate.topicMatches.length * 6 +
    candidate.lifeAreaMatches.length * 4 +
    (candidate.userPreviouslyVoted ? 3 : 0) +
    (candidate.watched ? 2 : 0)
  );
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const lastDelta = Number(ranksLast(left)) - Number(ranksLast(right));
  if (lastDelta !== 0) {
    return lastDelta;
  }

  const bucketDelta = bucketRank(left.priorityBucket) - bucketRank(right.priorityBucket);
  if (bucketDelta !== 0) {
    return bucketDelta;
  }

  const statusDelta = STATUS_WEIGHT[right.status] - STATUS_WEIGHT[left.status];
  if (statusDelta !== 0) {
    return statusDelta;
  }

  const matchDelta = candidateTieBreaker(right) - candidateTieBreaker(left);
  if (matchDelta !== 0) {
    return matchDelta;
  }

  const updatedDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return (left.manifest.title ?? "").localeCompare(right.manifest.title ?? "", undefined, {
    sensitivity: "base",
  });
}

function createPlaceholderBill(item: BillManifestEntry): ProcessedBillLike {
  return {
    schemaVersion: 1,
    kind: "processed",
    storedAt: item.updatedAt ?? "",
    identifier: {
      congress: item.congress ?? "",
      billType: item.billType,
      billNumber: item.billNumber ?? "",
    },
    guid: item.guid,
    title: item.title ?? item.guid,
    link: "",
    soWhat: "",
    // No "what it does": the item falls back to its status line rather than repeat the title.
    billBreakdown: {
      who: "",
      what: "",
      how: "",
      when: "",
      where: "",
      why: "",
    },
    subCategories: item.subCategories ?? [],
    lifeAreas: item.lifeAreas ?? [],
    sponsors: item.sponsors ?? [],
    cosponsors: item.cosponsors ?? [],
    actions: [],
    committees: [],
    billStatus: item.billStatus,
  };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function statusLabel(status: BillStatusValue): string {
  switch (status) {
    case "Passed":
      return "Passed";
    case "Failed":
      return "Failed";
    case "Updated":
      return "Updated";
    case "Finalized":
      return "Became law";
    case "New":
    default:
      return "New";
  }
}

function digestState(status: BillStatusValue): WeeklyDigestBillState {
  switch (status) {
    case "Passed":
      return "passed";
    case "Failed":
      return "failed";
    case "Updated":
      return "updated";
    case "Finalized":
      return "finalized";
    case "New":
    default:
      return "new";
  }
}

function defaultChangeLine(status: BillStatusValue): string {
  switch (status) {
    case "Passed":
      return "Passed this week.";
    case "Failed":
      return "Failed this week.";
    case "Updated":
      return "Updated this week.";
    case "Finalized":
      return "Became law this week.";
    case "New":
    default:
      return "New this week.";
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whitespace collapsed, and cut at a word before `maxChars` with "…" when longer. */
function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) {
    return flat;
  }

  const cut = flat.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The same sentence, ignoring case, spacing and a closing period. */
function sameText(left: string | undefined, right: string | undefined): boolean {
  const key = (value: string | undefined) =>
    (value ?? "")
      .replace(/\s+/g, " ")
      .replace(/[.…\s]+$/, "")
      .trim()
      .toLowerCase();
  return key(left).length > 0 && key(left) === key(right);
}

/**
 * Routine entries Congress.gov records right after the action they follow, the same day or the next; that action
 * says more. "Motion to reconsider laid on the table" follows a House vote, "Placed on the Union Calendar, Calendar
 * No. 123." a committee report, "Message on Senate action sent to the House." a Senate passage, and "Held at the
 * desk." a bill received from the other chamber.
 */
const ROUTINE_FOLLOW_UP_RE = new RegExp(
  "^(?:" +
    [
      "motion to reconsider",
      "placed on (?:the )?(?:union|house|private|senate legislative) calendar",
      "message on senate action sent to the house",
      "held at the desk",
    ].join("|") +
    ")\\b",
  "i",
);

interface WeekAction {
  /** The action's calendar day, "yyyy-mm-dd". */
  day: string;
  text: string;
}

/**
 * The bill's latest Congress.gov action dated inside the week (Sunday to Saturday, New York time), as Congress
 * wrote it. Actions come newest first, so on the latest day the first one listed wins. A routine follow-up
 * (ROUTINE_FOLLOW_UP_RE) is passed over for the latest other action of the week, and used only when the week has
 * nothing else.
 */
function latestActionInWeek(bill: ProcessedBillLike, window: WeeklyDigestPublicationWindow): WeekAction | undefined {
  const firstDay = weeklyDigestDayKey(window.start);
  const lastDay = weeklyDigestDayKey(window.end);
  const actions = Array.isArray(bill.actions) ? bill.actions : [];

  const inWeek = actions
    .map((action, index) => {
      const actionRecord = (action ?? {}) as Record<string, unknown>;
      const day = weeklyDigestDayKeyOf(actionRecord.actionDate ?? actionRecord.action_date ?? actionRecord.date);
      if (!day || day < firstDay || day > lastDay) {
        return null;
      }

      const text = firstNonEmpty(
        typeof actionRecord.text === "string" ? actionRecord.text : undefined,
        typeof actionRecord.actionText === "string" ? actionRecord.actionText : undefined,
        typeof actionRecord.description === "string" ? actionRecord.description : undefined,
      );

      return text ? { day, text, index } : null;
    })
    .filter((value): value is WeekAction & { index: number } => value !== null)
    .sort((left, right) => (left.day === right.day ? left.index - right.index : left.day < right.day ? 1 : -1));

  const chosen = inWeek.find((action) => !ROUTINE_FOLLOW_UP_RE.test(action.text)) ?? inWeek[0];
  return chosen ? { day: chosen.day, text: chosen.text } : undefined;
}

/** What the bill does, in the summarizer's words, unless it only repeats the title. */
function whatItDoes(bill: ProcessedBillLike, title: string): string | undefined {
  const text = firstNonEmpty(bill.summary, bill.billBreakdown?.what);
  return text && !sameText(text, title) ? clip(text, CONTEXT_TEXT_MAX_CHARS) : undefined;
}

/** The bill's item text: `summary` for both apps, `detail` for 1.1 (see the module comment). */
function billItemText(
  bill: ProcessedBillLike,
  title: string,
  status: BillStatusValue,
  window: WeeklyDigestPublicationWindow,
): { summary: string; detail?: string } {
  const action = latestActionInWeek(bill, window);
  const does = whatItDoes(bill, title);
  const bottomLine = firstNonEmpty(bill.soWhat);
  const summary = action
    ? `${formatWeeklyDigestDay(action.day)}: ${clip(action.text, ACTION_TEXT_MAX_CHARS)}`
    : (does ?? defaultChangeLine(status));
  const detail = [action ? does : undefined, bottomLine ? clip(bottomLine, CONTEXT_TEXT_MAX_CHARS) : undefined].find(
    (text): text is string => text !== undefined && !sameText(text, summary) && !sameText(text, title),
  );
  return detail ? { summary, detail } : { summary };
}

function makeBillItem(
  candidate: RankedCandidate,
  window: WeeklyDigestPublicationWindow,
  memberNameById: Map<string, string>,
  accent: WeeklyDigestAccent,
): WeeklyDigestItem {
  const bill = candidate.bill;
  const status = normalizeBillStatus(bill.billStatus ?? candidate.status);
  const guid = bill.guid ?? candidate.manifest.guid;
  const updatedAt = parseDate(bill.storedAt) ?? candidate.updatedAt;
  const eyebrow = [statusLabel(status), updatedAt ? formatWeeklyDigestShortDate(updatedAt) : undefined]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
  const title = firstNonEmpty(bill.title, candidate.manifest.title, guid) ?? guid;
  const { summary, detail } = billItemText(bill, title, status, window);

  const reason = (() => {
    if (candidate.watched) {
      return "You're watching this";
    }

    if (candidate.userPreviouslyVoted && status === "Updated") {
      return "You voted on this before";
    }

    if (candidate.userPreviouslyVoted && hasOutcome(status)) {
      return "You voted on this";
    }

    const memberId = candidate.matchingMemberIds[0];
    if (memberId) {
      return `Backed by ${memberNameById.get(memberId) ?? memberId}`;
    }

    if (candidate.topicMatches[0]) {
      return `Matches your topic: ${candidate.topicMatches[0]}`;
    }

    if (candidate.lifeAreaMatches[0]) {
      return `Matches your life area: ${candidate.lifeAreaMatches[0]}`;
    }

    if (status === "Passed") {
      return "Passed this week";
    }
    if (status === "Failed") {
      return "Failed this week";
    }
    if (status === "Finalized") {
      return "Became law this week";
    }

    return undefined;
  })();

  return {
    id: `bill|${guid}`,
    kind: "bill",
    title,
    eyebrow: eyebrow || undefined,
    summary,
    ...(detail ? { detail } : {}),
    reason,
    accent,
    billState: digestState(status),
    billGuid: guid,
    primaryMemberBioguideId: candidate.matchingMemberIds[0],
  };
}

/**
 * Each followed member with the bills they sponsor or cosponsor among `candidates` (all of the week's, S2),
 * busiest first. A companion group counts each of its bills for that bill's own sponsors. A member's bills are
 * ranked as the sections rank them, a group's moving member before its partner, so the first is the one named.
 */
function buildMemberActivityRows(candidates: Candidate[], memberNameById: Map<string, string>): MemberActivity[] {
  const grouped = new Map<string, MemberBill[]>();

  for (const candidate of candidates) {
    for (const bill of candidate.companionMembers ?? [candidate]) {
      for (const memberId of bill.matchingMemberIds) {
        const existing = grouped.get(memberId) ?? [];
        existing.push({ candidate, manifest: bill.manifest, sponsored: bill.sponsoringMemberIds.includes(memberId) });
        grouped.set(memberId, existing);
      }
    }
  }

  return Array.from(grouped.entries())
    .map(([memberId, entries]): MemberActivity => {
      const ordered = [...entries].sort(
        (left, right) =>
          compareCandidates(left.candidate, right.candidate) ||
          Number(right.manifest === right.candidate.manifest) - Number(left.manifest === left.candidate.manifest),
      );
      const seen = new Set<string>();
      const bills = ordered.filter((entry) => {
        const key = normalizeBillGuid(plainBillGuid(entry.manifest.guid) ?? entry.manifest.guid);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { id: memberId, name: memberNameById.get(memberId) ?? memberId, bills };
    })
    .filter((activity) => activity.bills.length > 0)
    .sort((left, right) => {
      if (left.bills.length !== right.bills.length) {
        return right.bills.length - left.bills.length;
      }

      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
}

function billsWord(count: number): string {
  return count === 1 ? "bill" : "bills";
}

/**
 * "Cosponsored H.R. 77, which moved this week.", "Sponsored S. 12 and 2 more bills that moved this week.",
 * "Sponsored H.R. 5 and cosponsored 1 more bill that moved this week." The first bill is named by its number as
 * the apps show it; the verb says what the member's name is on, which is all the brief knows.
 */
function memberActivitySummary(bills: MemberBill[]): string {
  const [first, ...rest] = bills;
  const number = officialBillNumber(first.manifest);
  if (!number) {
    const what = bills.length === 1 ? "a bill" : `${bills.length} bills`;
    return `${capitalize(roleOf(bills))} ${what} that moved this week.`;
  }

  const firstRole = roleOf([first]);
  if (rest.length === 0) {
    return `${capitalize(firstRole)} ${number}, which moved this week.`;
  }

  const restRole = roleOf(rest);
  const more = `${rest.length} more ${billsWord(rest.length)} that moved this week`;
  return `${capitalize(firstRole)} ${number} and ${restRole === firstRole ? "" : `${restRole} `}${more}.`;
}

/** What the member's name is on across `bills`: "sponsored", "cosponsored" or "sponsored or cosponsored". */
function roleOf(bills: MemberBill[]): string {
  const sponsored = bills.filter((bill) => bill.sponsored).length;
  return sponsored === bills.length ? "sponsored" : sponsored === 0 ? "cosponsored" : "sponsored or cosponsored";
}

function memberItem(activity: MemberActivity): WeeklyDigestItem {
  const named = activity.bills[0];
  const number = officialBillNumber(named.manifest);
  const title = firstNonEmpty(named.manifest.title);
  const count = activity.bills.length;
  const detail = number && title ? `${number}: ${title}` : (number ?? title);

  return {
    id: `member|${activity.id}|${named.manifest.guid}`,
    kind: "member",
    title: activity.name,
    eyebrow: `${count} ${billsWord(count)} this week`,
    summary: memberActivitySummary(activity.bills),
    ...(detail ? { detail } : {}),
    reason: "Member you follow",
    accent: "representative",
    billGuid: named.manifest.guid,
    primaryMemberBioguideId: activity.id,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The headline: what each section holds, in page order. "2 bills need your attention, 3 more moved, 2 members you
 * follow had bills move, and one more is worth a look." A member "had a bill move": their name is on a bill that
 * moved, as sponsor or cosponsor, which is all the brief knows about them; it claims nothing they did.
 *
 * App 1.1 shows this on its Updates card in 16 pt rounded type, cut after three lines (v1.1
 * WeeklyDigestViews.swift:30-33), on a line 295 pt wide on a 375 pt phone. The clauses are kept short so the
 * longest headline (115 characters, every section at one) fits three lines there at the default text size and the
 * next one up; 1.2 shows it whole.
 */
export function weeklyDigestHeadline(counts: {
  attention: number;
  moved: number;
  members: number;
  quickLook: number;
}): string {
  const { attention, moved, members, quickLook } = counts;
  const count = (value: number): string => (value === 1 ? "one" : String(value));
  const clauses: string[] = [];

  if (attention > 0) {
    clauses.push(attention === 1 ? "one bill needs your attention" : `${attention} bills need your attention`);
  }

  if (moved > 0) {
    clauses.push(attention > 0 ? `${count(moved)} more moved` : `${count(moved)} ${billsWord(moved)} moved this week`);
  }

  if (members > 0) {
    clauses.push(
      members === 1 ? "one member you follow had a bill move" : `${members} members you follow had bills move`,
    );
  }

  if (quickLook > 0) {
    const verb = quickLook === 1 ? "is" : "are";
    clauses.push(
      attention > 0 || moved > 0
        ? `${count(quickLook)} more ${verb} worth a look`
        : `${count(quickLook)} ${billsWord(quickLook)} ${verb} worth a look`,
    );
  }

  if (clauses.length === 0) {
    return "Here is your week in Congress.";
  }

  const sentence =
    clauses.length === 1
      ? clauses[0]
      : clauses.length === 2
        ? `${clauses[0]}, and ${clauses[1]}`
        : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
  return `${capitalize(sentence)}.`;
}

/** The companion group of a bill (a suffixed guid counts as its plain guid), if any. */
function companionGroupOf(
  guid: string | null | undefined,
  index: ReadonlyMap<string, CompanionGroupV1>,
): CompanionGroupV1 | undefined {
  if (index.size === 0) return undefined;
  const plain = plainBillGuid(guid);
  return plain ? index.get(plain) : undefined;
}

/**
 * A companion group as one candidate (APPF-23): `representative`'s bill, status and billGuid, the best priority
 * bucket of `members` and the union of their matches; watched and voted already cover the whole group. A group is
 * ceremonial when either bill is, and then neither bill's topics or life areas count; it looks ceremonial when
 * either bill's headline does. Null when no member is left.
 */
function companionGroupCandidate(representative: Candidate, members: Candidate[]): Candidate | null {
  const ceremonial = members.some((member) => member.ceremonial);
  const classified = members
    .map((member) => (member.ceremonial === ceremonial ? member : classify({ ...member, ceremonial })))
    .filter((member): member is Candidate => member !== null);
  if (classified.length === 0) return null;

  const union = (values: string[][]): string[] => Array.from(new Set(values.flat()));
  const priorityBucket = classified
    .map((member) => member.priorityBucket)
    .sort((left, right) => bucketRank(left) - bucketRank(right))[0];

  return {
    ...representative,
    watched: classified.some((member) => member.watched),
    userPreviouslyVoted: classified.some((member) => member.userPreviouslyVoted),
    followedAreas: {
      topics: union(classified.map((member) => member.followedAreas.topics)),
      lifeAreas: union(classified.map((member) => member.followedAreas.lifeAreas)),
    },
    topicMatches: union(classified.map((member) => member.topicMatches)),
    lifeAreaMatches: union(classified.map((member) => member.lifeAreaMatches)),
    matchingMemberIds: union(classified.map((member) => member.matchingMemberIds)).sort(),
    sponsoringMemberIds: union(classified.map((member) => member.sponsoringMemberIds)).sort(),
    ceremonial,
    looksCeremonial: classified.some((member) => member.looksCeremonial),
    inTrackedAreas: classified.some((member) => member.inTrackedAreas),
    priorityBucket,
    companionMembers: classified,
  };
}

/**
 * A status's rank among a companion group's members, as app 1.2's companion card ranks them
 * (`CompanionGroupIndex.statusLead` in the iOS app): Finalized 4, Passed 3, Failed 2, Updated 1, New 0. Passed and
 * Failed are not tied: a Passed/Failed pair shows as the Passed bill, whichever moved later.
 */
const COMPANION_STATUS_RANK: Record<BillStatusValue, number> = {
  New: 0,
  Updated: 1,
  Failed: 2,
  Passed: 3,
  Finalized: 4,
};

/**
 * APPF-23: one candidate per companion group. The member with the highest status stands for the
 * group (its bill, status and billGuid), as the apps show one card for the pair with that status:
 * a law (REL-44) whose twin moved later still reads "Became law", and a Passed bill stands over its
 * Failed twin. Among equal statuses, the member that moved most recently in the window; a tie goes
 * to the primary. The group takes the best priority bucket of its members and the union of their
 * matches; watched and voted already cover the whole group. Ungrouped candidates are unchanged.
 */
function collapseCompanionCandidates(
  candidates: Candidate[],
  index: ReadonlyMap<string, CompanionGroupV1>,
): Candidate[] {
  if (index.size === 0) return candidates;

  // Each ungrouped candidate, and each group's members, in first-seen order.
  const slots: Candidate[][] = [];
  const slotByPrimary = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const primaryGuid = companionGroupOf(candidate.manifest.guid, index)?.primaryGuid;
    const slot = primaryGuid ? slotByPrimary.get(primaryGuid) : undefined;
    if (slot) {
      slot.push(candidate);
      continue;
    }
    const created = [candidate];
    slots.push(created);
    if (primaryGuid) slotByPrimary.set(primaryGuid, created);
  }

  const isPrimary = (candidate: Candidate): boolean =>
    companionGroupOf(candidate.manifest.guid, index)?.primaryGuid === plainBillGuid(candidate.manifest.guid);

  return slots.flatMap((members) => {
    if (members.length === 1) return members;

    const representative = members.reduce((best, member) => {
      const rank = COMPANION_STATUS_RANK[member.status] - COMPANION_STATUS_RANK[best.status];
      if (rank !== 0) return rank > 0 ? member : best;
      const delta = member.updatedAt.getTime() - best.updatedAt.getTime();
      return delta > 0 || (delta === 0 && isPrimary(member) && !isPrimary(best)) ? member : best;
    });
    const group = companionGroupCandidate(representative, members);
    return group ? [group] : [];
  });
}

/**
 * Whether a loaded candidate is a ceremonial resolution (S6). Congress's official title decides; the manifest row
 * does not carry it, which is why the first pass only ranks by the headline. Without an official title, the
 * headlines decide: the loaded bill's, or for a companion group either bill's (`looksCeremonial`). A curated
 * override of a bill, by its guid, stands over both (commemorativeResolutions.ts CURATED_OVERRIDES).
 */
function ceremonialVerdict(candidate: Candidate, bill: ProcessedBillLike): boolean {
  const { guid, billType } = candidate.manifest;
  const officialTitle = firstNonEmpty(bill.officialTitle);
  if (officialTitle) {
    return isCommemorativeResolution({ guid, billType, officialTitle });
  }

  return (
    candidate.looksCeremonial ||
    isCommemorativeResolution({ guid, billType, title: firstNonEmpty(bill.title, candidate.manifest.title) })
  );
}

/**
 * The candidate once its processed bill says whether it is ceremonial: the matches that count follow the verdict,
 * and the headline's guess gives way to it. Null when that leaves it no bucket.
 */
function withCeremonial(candidate: Candidate, ceremonial: boolean): Candidate | null {
  if (candidate.ceremonial === ceremonial && candidate.looksCeremonial === ceremonial) return candidate;
  const settle = (member: Candidate): Candidate | null =>
    classify({ ...member, ceremonial, looksCeremonial: ceremonial });
  if (!candidate.companionMembers) return settle(candidate);

  const members = candidate.companionMembers.map(settle).filter((member): member is Candidate => member !== null);
  return members.length > 0 ? companionGroupCandidate(candidate, members) : null;
}

export async function buildWeeklyDigest(input: WeeklyDigestBuildInput): Promise<WeeklyDigest | null> {
  const companions = input.companionIndex ?? new Map<string, CompanionGroupV1>();
  // The watched, voted and used sets are keyed by bill, except that a companion group's members
  // share the key of its primary: watching or voting on either member counts for the group. A
  // suffixed guid (a watch or vote stored under BILLS-119hr1181rh, REL-42) counts as its plain guid.
  const billKey = (guid: string | null | undefined): string => {
    const group = companionGroupOf(guid, companions);
    return group ? `group|${normalizeBillGuid(group.primaryGuid)}` : normalizeBillGuid(plainBillGuid(guid) ?? guid);
  };
  const watchedBillGuids = new Set(input.preferences.watchedBillGuids.map(billKey));
  const votedBillKeys = new Set(Array.from(input.voteStatesByBillId.values()).map((vote) => billKey(vote.billId)));
  const trackedTopics = new Set(input.preferences.trackedTopics.map(normalizeTopic));
  const trackedLifeAreas = new Set(input.preferences.trackedLifeAreas.map(normalize));
  const followedMembers = new Set(input.preferences.followedMembers.map(normalize));
  const allowedContentTypes =
    input.preferences.selectedBillContentTypes.length > 0 ? new Set(input.preferences.selectedBillContentTypes) : null;
  const dayAfterWeekEnd = addEasternDays(input.window.end, 1);
  const isFollowed = (memberId: string): boolean =>
    followedMembers.has(normalize(memberId)) ||
    followedMembers.has(deterministicUuidFromString(memberId).toLowerCase());
  const followedIds = (memberIds: readonly string[] | undefined): string[] =>
    Array.from(new Set((memberIds ?? []).map((memberId) => memberId.trim())))
      .filter((memberId) => memberId.length > 0 && isFollowed(memberId))
      .map((memberId) => memberId.toUpperCase());

  const candidates = input.manifestItems
    .map((item): Candidate | null => {
      if (!billTypeMatchesContentPreferences(item.billType, allowedContentTypes)) {
        return null;
      }

      const updatedAt = parseDate(item.updatedAt);
      if (!updatedAt || updatedAt < input.window.start || updatedAt >= dayAfterWeekEnd) {
        return null;
      }

      const sponsoringMemberIds = Array.from(new Set(followedIds(item.sponsors))).sort();
      return classify({
        manifest: item,
        status: normalizeBillStatus(item.billStatus),
        updatedAt,
        watched: watchedBillGuids.has(billKey(item.guid)),
        userPreviouslyVoted: votedBillKeys.has(billKey(item.guid)),
        followedAreas: {
          topics: currentTopicNames(item.subCategories ?? []).filter((value) =>
            trackedTopics.has(normalizeTopic(value)),
          ),
          lifeAreas: (item.lifeAreas ?? []).filter((value) => trackedLifeAreas.has(normalize(value))),
        },
        matchingMemberIds: Array.from(new Set([...sponsoringMemberIds, ...followedIds(item.cosponsors)])).sort(),
        sponsoringMemberIds,
        // The manifest row has only the headline, which may leave out what makes a resolution more than
        // ceremonial. So it only ranks the bill last here; its matches all count until the official title,
        // read once the bill is loaded, says otherwise (ceremonialVerdict).
        ceremonial: false,
        looksCeremonial: isCommemorativeResolution({ guid: item.guid, billType: item.billType, title: item.title }),
      });
    })
    .filter((value): value is Candidate => value !== null);
  const rankedCandidates = collapseCompanionCandidates(candidates, companions).sort(compareCandidates);

  if (rankedCandidates.length === 0) {
    return null;
  }

  const hydratedCandidates = (
    await Promise.all(
      rankedCandidates.slice(0, HYDRATED_CANDIDATES).map(async (candidate): Promise<RankedCandidate | null> => {
        const bill = (await input.loadProcessedBill(candidate.manifest)) ?? createPlaceholderBill(candidate.manifest);
        const settled = withCeremonial(candidate, ceremonialVerdict(candidate, bill));
        return settled ? { ...settled, bill } : null;
      }),
    )
  )
    .filter((candidate): candidate is RankedCandidate => candidate !== null)
    .sort(compareCandidates);

  if (hydratedCandidates.length === 0) {
    return null;
  }

  const consumed = new Set<string>();
  // A grouped candidate is used under its group's key; otherwise, as before, under its bill's guid.
  const usedKey = (candidate: RankedCandidate): string =>
    companionGroupOf(candidate.manifest.guid, companions)
      ? billKey(candidate.manifest.guid)
      : (candidate.bill.guid ?? candidate.manifest.guid);
  const statusOf = (candidate: RankedCandidate): BillStatusValue =>
    normalizeBillStatus(candidate.bill.billStatus ?? candidate.status);

  const needsAttention = hydratedCandidates
    .filter((candidate) => {
      const status = statusOf(candidate);
      // A decided bill the user already voted on asks nothing more of them (S2); it can show under "Moved".
      if (candidate.userPreviouslyVoted && hasOutcome(status)) {
        return false;
      }

      return (
        candidate.watched ||
        (candidate.userPreviouslyVoted && status === "Updated") ||
        (candidate.inTrackedAreas && hasOutcome(status))
      );
    })
    .slice(0, 3)
    .map((candidate) => {
      consumed.add(usedKey(candidate));
      return makeBillItem(candidate, input.window, input.memberNameById, "attention");
    });

  const movedThisWeek = hydratedCandidates
    .filter((candidate) => !consumed.has(usedKey(candidate)))
    .slice(0, 3)
    .map((candidate) => {
      consumed.add(usedKey(candidate));
      return makeBillItem(candidate, input.window, input.memberNameById, "movement");
    });

  // Every candidate of the week, not only the hydrated dozen: the counts are the members' real ones (S2).
  const representatives = buildMemberActivityRows(rankedCandidates, input.memberNameById).slice(0, 3).map(memberItem);

  const worthQuickLook = hydratedCandidates
    .filter((candidate) => {
      const status = statusOf(candidate);
      return (
        !consumed.has(usedKey(candidate)) &&
        !candidate.ceremonial &&
        candidate.priorityBucket === "tracked_movement" &&
        !candidate.watched &&
        !candidate.userPreviouslyVoted &&
        candidate.matchingMemberIds.length === 0 &&
        (status === "New" || status === "Updated")
      );
    })
    .slice(0, 2)
    .map((candidate) => {
      consumed.add(usedKey(candidate));
      return makeBillItem(candidate, input.window, input.memberNameById, "discovery");
    });

  // App 1.1 shows these titles and subtitles; 1.2 sets its own section titles and shows no subtitle.
  const sections = [
    {
      kind: "needs_attention" as const,
      title: "Needs Your Attention",
      subtitle:
        needsAttention.length > 0
          ? "Bills you watch, changes since your vote, and outcomes on your topics."
          : undefined,
      items: needsAttention,
    },
    {
      kind: "moved_this_week" as const,
      title: "What Moved This Week",
      subtitle: movedThisWeek.length > 0 ? "Other bills that moved this week." : undefined,
      items: movedThisWeek,
    },
    {
      kind: "representatives" as const,
      title: "Members You Follow",
      subtitle:
        representatives.length > 0
          ? "Members you follow who sponsor or cosponsor a bill that moved this week."
          : undefined,
      items: representatives,
    },
    {
      kind: "worth_quick_look" as const,
      title: "Worth A Quick Look",
      subtitle: worthQuickLook.length > 0 ? "More new or updated bills on your topics." : undefined,
      items: worthQuickLook,
    },
  ].filter((section) => section.items.length > 0);

  if (sections.length === 0) {
    return null;
  }

  const summary = weeklyDigestHeadline({
    attention: needsAttention.length,
    moved: movedThisWeek.length,
    members: representatives.length,
    quickLook: worthQuickLook.length,
  });

  return {
    id: input.window.id,
    title: formatWeeklyDigestTitle(input.window.start, input.window.end),
    summary,
    weekStart: input.window.start.toISOString(),
    weekEnd: input.window.end.toISOString(),
    publishedAt: input.window.releaseAt.toISOString(),
    isRead: false,
    // App 1.1 shows these labels; 1.2 words the three ids itself ("2 need attention · 1 member active").
    stats: [
      {
        id: "attention",
        label: "Need attention",
        value: String(needsAttention.length),
        accent: "attention",
      },
      {
        id: "representatives",
        label: "Members active",
        value: String(representatives.length),
        accent: "representative",
      },
      {
        id: "quicklook",
        label: "Worth a look",
        value: String(worthQuickLook.length),
        accent: "discovery",
      },
    ],
    sections,
  };
}
