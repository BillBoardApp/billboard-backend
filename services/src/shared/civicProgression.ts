export interface CivicRankDefinition {
  id: string;
  title: string;
  minScore: number;
  approxVotesRequired: number;
}

interface CivicHonorDefinition {
  id: string;
  title: string;
  description: string;
  bonusScore: number;
  category: "participation" | "consistency" | "breadth" | "identity" | "unlock";
  isEarned: (context: CivicProgressContext) => boolean;
}

interface CivicProgressContext {
  totalVotes: number;
  currentStreak: number;
  longestStreak: number;
  coverageAreaCount: number;
  civicProfileUnlocked: boolean;
}

export interface EarnedCivicHonor {
  id: string;
  title: string;
  description: string;
  bonusScore: number;
  category: CivicHonorDefinition["category"];
}

/** UX-31: points for each vote counted (Yea, Nay or Abstain; a companion pair once). */
export const VOTE_POINTS = 10;
/** UX-31: points for each day of the user's best streak, kept when a streak ends (before, 5 a day of the current one). */
export const STREAK_DAY_POINTS = 5;

/**
 * The rank ladder. Ranks come from the server: both apps show `title` (1.1 also colours the rank card by `id`,
 * CivicScoreCard.swift), so a title can change without an app release, and the score never goes down (UX-31), so
 * neither does the rank. Keep the thresholds: lowering one is harmless, but raising one would take a rank away.
 */
const CIVIC_RANKS: CivicRankDefinition[] = [
  {
    id: "citizen",
    title: "Citizen",
    minScore: 0,
    approxVotesRequired: 0,
  },
  {
    id: "voice",
    title: "Voice",
    minScore: 250,
    approxVotesRequired: 25,
  },
  {
    // UX-31: "Delegate" is a real House office (the non-voting delegates of DC and the territories), so the rank has a
    // plain title that is no office and reads as a step up from "Voice": someone who keeps showing up (about 100
    // votes). A question in the UX-31 pull request. The id stays: app 1.1 colours this rank's card by it.
    id: "delegate",
    title: "Stalwart",
    minScore: 1_000,
    approxVotesRequired: 100,
  },
  {
    id: "steward",
    title: "Steward",
    minScore: 4_000,
    approxVotesRequired: 400,
  },
  {
    id: "advocate",
    title: "Advocate",
    minScore: 16_000,
    approxVotesRequired: 1_600,
  },
  {
    id: "champion",
    title: "Champion",
    minScore: 64_000,
    approxVotesRequired: 6_400,
  },
];

/**
 * The honors. UX-31: an honor once earned is kept on the user's Civic Score record (civicRecord.ts) by its id, even
 * when its condition stops holding, so never remove one or reuse its id: an id the list no longer has drops out of the
 * score. The conditions count Yea, Nay and Abstain alike, except Civic Compass, which is earned when the Civic Profile
 * is ready under its own rule (UX-32, civicRecord.ts civicProfileReadyFromOwnRows).
 */
const CIVIC_HONORS: CivicHonorDefinition[] = [
  {
    id: "first-voice",
    title: "First Voice",
    description: "Cast your first vote.",
    bonusScore: 25,
    category: "participation",
    isEarned: (context) => context.totalVotes >= 1,
  },
  {
    id: "steady",
    title: "Steady",
    description: "Reach a 3-day voting streak.",
    bonusScore: 25,
    category: "consistency",
    isEarned: (context) => context.longestStreak >= 3,
  },
  {
    id: "on-record",
    title: "On Record",
    description: "Reach 25 lifetime votes.",
    bonusScore: 50,
    category: "participation",
    isEarned: (context) => context.totalVotes >= 25,
  },
  {
    id: "steady-hand",
    title: "Steady Hand",
    description: "Reach a 7-day voting streak.",
    bonusScore: 50,
    category: "consistency",
    isEarned: (context) => context.longestStreak >= 7,
  },
  {
    id: "broad-view",
    title: "Broad View",
    description: "Vote across 3 issue areas.",
    bonusScore: 50,
    category: "breadth",
    isEarned: (context) => context.coverageAreaCount >= 3,
  },
  {
    id: "civic-compass",
    title: "Civic Compass",
    description: "Unlock your Civic Profile.",
    bonusScore: 100,
    category: "unlock",
    isEarned: (context) => context.civicProfileUnlocked,
  },
  {
    id: "public-record",
    title: "Public Record",
    description: "Reach 100 lifetime votes.",
    bonusScore: 100,
    category: "participation",
    isEarned: (context) => context.totalVotes >= 100,
  },
  {
    id: "wide-lens",
    title: "Wide Lens",
    description: "Vote across 5 issue areas.",
    bonusScore: 100,
    category: "breadth",
    isEarned: (context) => context.coverageAreaCount >= 5,
  },
];

export function evaluateEarnedHonors(context: CivicProgressContext): EarnedCivicHonor[] {
  return CIVIC_HONORS.filter((honor) => honor.isEarned(context)).map((honor) => ({
    id: honor.id,
    title: honor.title,
    description: honor.description,
    bonusScore: honor.bonusScore,
    category: honor.category,
  }));
}

/** The honors with these ids, in the ladder's order; ids no honor has are left out. */
export function honorsWithIds(ids: Iterable<string>): EarnedCivicHonor[] {
  const wanted = new Set(ids);
  return CIVIC_HONORS.filter((honor) => wanted.has(honor.id)).map((honor) => ({
    id: honor.id,
    title: honor.title,
    description: honor.description,
    bonusScore: honor.bonusScore,
    category: honor.category,
  }));
}

export function sumHonorBonus(honors: EarnedCivicHonor[]): number {
  return honors.reduce((sum, honor) => sum + honor.bonusScore, 0);
}

export function resolveCurrentRank(score: number): CivicRankDefinition {
  return [...CIVIC_RANKS].reverse().find((rank) => score >= rank.minScore) ?? CIVIC_RANKS[0];
}

export function resolveNextRank(score: number): CivicRankDefinition | null {
  return CIVIC_RANKS.find((rank) => score < rank.minScore) ?? null;
}
