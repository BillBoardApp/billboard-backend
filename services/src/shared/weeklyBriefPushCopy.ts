import type { WeeklyDigest } from "../models/weeklyDigest";
import { normalizeInlineText, truncateUtf8 } from "./pushText";
import { formatWeeklyDigestShortRange } from "./weeklyDigestSchedule";

/*
 * What the Sunday Weekly Brief push says (UX-28, decision D4 (a)). UX-27's rule is that a push says what it is about,
 * so it names the brief's week and its bills, never counts:
 * - Title: "Weekly Brief · Nov 15–21", the week as app 1.3's front page docket gives it ("Oct 25–Nov 1" across months).
 * - Body: "Includes {bill}." for one bill, "Includes {bill 1} and {bill 2}." for two, "Includes {bill 1}, {bill 2}, and
 *   {N} more." for three or more, the bills in app 1.3's page order (Your bills this week first, then the sections)
 *   with member items skipped and each bill once. A title is named once: a later bill with the same title as one
 *   already named (two unrelated bills can share a short title) is counted in "N more", never named twice, so the
 *   body reads "Includes SAVE Act and 1 more.", not "Includes SAVE Act and SAVE Act." So a brief with Your bills names the reader's own bills first; the
 *   proposed count of them ("2 bills you voted on moved this week.") is not used (project decision 2026-11-25). Listed
 *   titles are cut to 36 bytes with "...", as userNotifier's example titles are; a lone title gets the whole body. The
 *   body stays within 160 bytes, as a bill push's does.
 * - A brief with no bill item (only members you follow) says its own headline instead.
 * The words come only from the user's own brief: bill titles and the headline. Nothing here reads anyone's vote.
 */

export const WEEKLY_BRIEF_PUSH_BODY_MAX_BYTES = 160;
/** A listed bill title's length in the body, as in userNotifier's exampleTitlesBody. */
export const WEEKLY_BRIEF_LISTED_TITLE_MAX_BYTES = 36;
const INCLUDES = "Includes ";
const ELLIPSIS = "...";

export interface WeeklyBriefPushCopy {
  title: string;
  body: string;
}

/**
 * The brief's bill titles in app 1.3's page order: Your bills this week (UX-41 concept 4), then each section's items,
 * member items skipped, each bill once. A bill is a repeat when its billGuid was already listed. That names a companion
 * group once: the builder gives a group one billGuid in the whole brief (a Your bills item takes its section item's
 * guid), and this module has no companion index to match a group by. Two bills that only share a title, not paired as
 * companions, are two bills, as app 1.3 lists them, so both count toward "N more".
 */
export const weeklyBriefBillTitles = (digest: Pick<WeeklyDigest, "sections" | "yourBills">): string[] => {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const list of [digest.yourBills ?? [], ...(digest.sections ?? []).map((section) => section.items ?? [])]) {
    for (const item of list) {
      if (item.kind !== "bill") continue;
      const key = item.billGuid ?? item.id;
      const title = normalizeInlineText(item.title);
      if (!title || seen.has(key)) continue;
      seen.add(key);
      titles.push(title);
    }
  }
  return titles;
};

/** "Weekly Brief · Nov 15–21". */
export const weeklyBriefPushTitle = (weekStart: Date, weekEnd: Date): string =>
  `Weekly Brief · ${formatWeeklyDigestShortRange(weekStart, weekEnd)}`;

/** A sentence's closing period, left off after a cut title's "..." so it never reads "....". */
const closed = (text: string): string => (text.endsWith(ELLIPSIS) ? text : `${text}.`);

export const weeklyBriefPushBody = (digest: Pick<WeeklyDigest, "sections" | "summary" | "yourBills">): string => {
  const titles = weeklyBriefBillTitles(digest);
  if (titles.length === 0) {
    return truncateUtf8(digest.summary, WEEKLY_BRIEF_PUSH_BODY_MAX_BYTES) || "Here is your week in Congress.";
  }

  if (titles.length === 1) {
    const room = WEEKLY_BRIEF_PUSH_BODY_MAX_BYTES - Buffer.byteLength(`${INCLUDES}.`, "utf8");
    return closed(`${INCLUDES}${truncateUtf8(titles[0], room)}`);
  }

  // Up to two titles that read differently as listed (cut to 36 bytes, any letter case); every other bill is "N more".
  const named: string[] = [];
  const namedKeys = new Set<string>();
  for (const title of titles) {
    const listed = truncateUtf8(title, WEEKLY_BRIEF_LISTED_TITLE_MAX_BYTES);
    const key = listed.toLowerCase();
    if (namedKeys.has(key)) continue;
    namedKeys.add(key);
    named.push(listed);
    if (named.length === 2) break;
  }
  const more = titles.length - named.length;
  const [first, second] = named;
  let body: string;
  if (second === undefined) body = `${INCLUDES}${first} and ${more} more.`;
  else if (more === 0) body = closed(`${INCLUDES}${first} and ${second}`);
  else body = `${INCLUDES}${first}, ${second}, and ${more} more.`;
  return truncateUtf8(body, WEEKLY_BRIEF_PUSH_BODY_MAX_BYTES);
};

/** The push's title and body for `digest`, whose week is `weekStart` to `weekEnd` (the snapshot's own). */
export const weeklyBriefPushCopy = (
  digest: Pick<WeeklyDigest, "sections" | "summary" | "weekStart" | "weekEnd" | "yourBills">,
): WeeklyBriefPushCopy => ({
  title: weeklyBriefPushTitle(new Date(digest.weekStart), new Date(digest.weekEnd)),
  body: weeklyBriefPushBody(digest),
});
