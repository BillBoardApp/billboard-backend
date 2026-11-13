import { CIVIC_PROFILE_AXES, type CivicProfileAxis } from "../models/bill";
import { MEMBER_CIVIC_PROFILE_MIN_READY_AXES } from "./memberCivicProfile";

/**
 * UX-32: when a user's own Civic Profile is ready (unlocked), in one place for GET /civic-profile (fetchCivicProfile)
 * and the Civic Compass honor, "Unlock your Civic Profile." (civicRecord.ts, GET /civic-score).
 *
 * The window is the user's 100 most recent Yea or Nay votes on bills with theme scores, newest first by `votedAt` (an
 * Abstain or a 1.0 or 1.1 dismissal never counts; a companion pair counts once). A theme (axis) is scored only from 8
 * of those votes on bills scored on it (feature review S16, project decision 2026-10-28; a bill scored on two themes counts for
 * each). The profile is ready at 25 votes in the window AND 3 themes at 8 (project decision 2026-10-29, "Keep it
 * locked"): before that a ready profile could show the chart with no shape, since the radar charts of apps 1.1 and 1.2
 * draw a shape only from 3 scored themes (RadarChartView, `guard values.count >= 3`). 3 is also what a member's
 * profile needs (memberCivicProfile.ts), and must never drop below the charts' 3.
 */

/** The votes the profile reads: the most recent 100 Yea or Nay votes on bills with theme scores. */
export const CIVIC_PROFILE_WINDOW = 100;
/** Votes in the window before the profile can unlock. */
export const CIVIC_PROFILE_MIN_VOTES = 25;
/** Votes in the window on bills scored on a theme before the theme gets a score (a member's needs 3). */
export const CIVIC_PROFILE_MIN_THEME_VOTES = 8;
/** Themes at CIVIC_PROFILE_MIN_THEME_VOTES before the profile can unlock: the 3 a radar shape needs. */
export const CIVIC_PROFILE_MIN_READY_THEMES = MEMBER_CIVIC_PROFILE_MIN_READY_AXES;

/**
 * What sets the votes a locked profile asks for, whichever is larger: the votes' shortfall (25 less the votes in the
 * window) or the 3rd theme's (8 less the votes of the theme ranked 3rd by votes). From 25 votes, always the themes.
 */
export type CivicProfileLock = "votes" | "themes";

/** A vote in the window, by the themes its bill is scored on. */
export interface CivicProfileWindowVote {
  /** The row's `votedAt` (the time of its last write), which orders the window. */
  votedAt: string;
  /**
   * The CIVIC_PROFILE_AXES its bill is scored on ([] for a profile with none of them), or null when the read does not
   * know the bill's profile: such a vote takes its place in the window but counts toward nothing (the Civic Compass
   * honor, civicRecord.ts, which reads no manifest).
   */
  themes: readonly string[] | null;
}

export interface CivicProfileReadiness {
  isReady: boolean;
  /** The votes in the window whose bill's profile is known: GET /civic-profile's `votesUsed`. */
  votesUsed: number;
  /**
   * GET /civic-profile's `minVotesRequired`. While locked, votesUsed plus the larger of the votes' shortfall and the
   * 3rd theme's (at least 1), so apps 1.1 and 1.2, which ask for `minVotesRequired - votesUsed` more votes, never ask
   * for 0 and, under the 100-vote cap, never for more after a vote on a bill not yet in the window (civicProfileReadiness
   * has the companion pairs' exception). 25 for a new user, and 25 when ready, as before UX-32.
   */
  minVotesRequired: number;
  /** For each theme, the votes in the window on bills scored on it. */
  themeVotes: Record<CivicProfileAxis, number>;
  /** Themes with at least CIVIC_PROFILE_MIN_THEME_VOTES votes: the themes that get a score. */
  themesReady: number;
  /**
   * The shortfall that sets minVotesRequired while locked: "themes" when the 3rd theme's is the larger, else "votes" (a
   * tie, or the themes already ready). Null when ready.
   */
  lockedBy: CivicProfileLock | null;
}

/**
 * The parsed numeric entries of a DynamoDB civicProfile map (a vote row's snapshot or a manifest row's), or null when
 * it has none. Both handlers parse rows with it, so the chart and the honor know the same rows' profiles.
 */
export function parseCivicProfileMap(mapAttr: unknown): Record<string, number> | null {
  const map = (mapAttr as { M?: unknown } | null | undefined)?.M;
  if (!map || typeof map !== "object") return null;

  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(map as Record<string, { N?: unknown }>)) {
    const parsed = typeof value?.N === "string" ? parseFloat(value.N) : NaN;
    if (!isNaN(parsed)) result[key] = parsed;
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** The themes (CIVIC_PROFILE_AXES) a bill's civic profile scores, in the axes' order. */
export function civicProfileThemes(civicProfile: Record<string, number>): CivicProfileAxis[] {
  return CIVIC_PROFILE_AXES.filter((axis) => civicProfile[axis] !== undefined);
}

/**
 * The window: the 100 most recent of these Yea or Nay votes, newest first by `votedAt`. The sort is stable, so of two
 * lists where one is a sub-list of the other in the same order, every vote of the shorter list in the longer list's
 * window is in the shorter list's window (the Civic Compass honor relies on it, civicRecord.ts).
 */
export function civicProfileWindow<T extends { votedAt: string }>(votes: readonly T[]): T[] {
  return [...votes].sort((a, b) => b.votedAt.localeCompare(a.votedAt)).slice(0, CIVIC_PROFILE_WINDOW);
}

/**
 * Whether the profile with this window is ready, and what it needs while locked. The one readiness rule of a user's own
 * Civic Profile: GET /civic-profile answers it, and the Civic Compass honor is earned by it (isReady only).
 *
 * While locked, the apps ask for N = minVotesRequired - votesUsed more votes ("Vote on N more bills"), and N is the
 * larger of two shortfalls, each a lower bound on the votes the profile still needs: the votes' (25 less votesUsed) and
 * the 3rd theme's (8 less the votes of the theme ranked 3rd by votes: a vote adds at most 1 to each theme, so at most 1
 * to the 3rd-ranked count, and one bill can count toward several themes). So a new user is asked for 25, and from 25
 * votes N is the 3rd theme's shortfall, 1 to 8. Under 25 votes N is the 3rd theme's shortfall when that is larger, so
 * the prompt never jumps up at 25 votes (decided 2026-10-29; before, a user at 24 votes was asked for 1 more vote, then
 * up to 8 more at 25). lockedBy names the shortfall that sets N.
 *
 * Below the 100-vote cap, N never rises as votes are added to the window. A vote the window takes without pushing one
 * out adds 1 to votesUsed (nothing, and changes nothing, for a vote whose bill's profile is not known) and adds 0 or 1
 * to each theme, taking none away. So the votes' shortfall falls by exactly 1, and the 3rd-ranked count can only grow,
 * by at most 1, so the 3rd theme's shortfall falls by 0 or 1. N, the larger of the two (at least 1), therefore falls by
 * 0 or 1 a vote, and since both are lower bounds the profile unlocks only on a vote made at "1 more bill". At the cap (a
 * full window) each new vote pushes the oldest out, which can take a vote off a theme: N, then the 3rd theme's
 * shortfall alone (votesUsed is 100), can go back up after a vote, never above 8, and minVotesRequired is above 100, as
 * before.
 *
 * A vote is added to the window when it is on a bill not yet in it. A vote on the other bill of a companion pair the
 * user already voted on is not: GET /civic-profile keeps one row per pair, the primary's (the House bill's), an Abstain
 * too (fetchCivicProfile's onePerCompanionGroup, APPF-23), so a vote on the primary replaces the row the window counted
 * and one on the other member changes nothing. Taking a vote out of the window raises each shortfall by 0 or 1
 * (votesUsed falls by 1 or 0, the 3rd-ranked count by at most 1), so such a vote, like changing a counted vote to an
 * Abstain, can raise N under the cap too, by at most 1, or lock a ready profile again at "1 more bill".
 *
 * The floor of 1 never binds while locked (under 25 votes the votes' shortfall is at least 1; from 25 a locked profile
 * has its 3rd theme under 8); it only guards the apps' "Vote on 0 more bills".
 */
export function civicProfileReadiness(
  window: readonly Pick<CivicProfileWindowVote, "themes">[],
): CivicProfileReadiness {
  const themeVotes = Object.fromEntries(CIVIC_PROFILE_AXES.map((axis) => [axis, 0])) as Record<
    CivicProfileAxis,
    number
  >;
  let votesUsed = 0;
  for (const vote of window) {
    if (vote.themes === null) continue;
    votesUsed += 1;
    for (const theme of new Set(vote.themes)) {
      if ((CIVIC_PROFILE_AXES as readonly string[]).includes(theme)) themeVotes[theme as CivicProfileAxis] += 1;
    }
  }

  const counts = CIVIC_PROFILE_AXES.map((axis) => themeVotes[axis]).sort((a, b) => b - a);
  const themesReady = counts.filter((count) => count >= CIVIC_PROFILE_MIN_THEME_VOTES).length;
  if (votesUsed >= CIVIC_PROFILE_MIN_VOTES && themesReady >= CIVIC_PROFILE_MIN_READY_THEMES) {
    return {
      isReady: true,
      votesUsed,
      minVotesRequired: CIVIC_PROFILE_MIN_VOTES,
      themeVotes,
      themesReady,
      lockedBy: null,
    };
  }
  const votesShort = CIVIC_PROFILE_MIN_VOTES - votesUsed;
  const themesShort = CIVIC_PROFILE_MIN_THEME_VOTES - (counts[CIVIC_PROFILE_MIN_READY_THEMES - 1] ?? 0);
  return {
    isReady: false,
    votesUsed,
    minVotesRequired: votesUsed + Math.max(votesShort, themesShort, 1),
    themeVotes,
    themesReady,
    lockedBy: themesShort > votesShort ? "themes" : "votes",
  };
}
