import { CIVIC_PROFILE_AXES, CivicProfileAxis } from "../models/bill";

const MEMBER_CIVIC_PROFILE_ROLLING_WINDOW = 100;
const MEMBER_CIVIC_PROFILE_MIN_WEIGHTED_EVIDENCE = 20;
// A member's axis needs this much weighted evidence. Your own profile (GET /civic-profile) has its own floor of 8
// votes per theme (UX-32, civicProfileReadiness.ts); the member page's "Compare to you" shows each side with its own
// floor.
export const MEMBER_CIVIC_PROFILE_MIN_AXIS_WEIGHTED_EVIDENCE = 3;
// Axes with enough evidence before a member's chart is ready. Your own profile needs as many themes at its floor of 8
// (UX-32, civicProfileReadiness.ts): the radar charts of apps 1.1 and 1.2 draw a shape only from 3 scored axes, so
// neither may drop below 3.
export const MEMBER_CIVIC_PROFILE_MIN_READY_AXES = 3;
export const MEMBER_CIVIC_PROFILE_EVIDENCE_LIMIT = 12;

const MEMBER_CIVIC_PROFILE_EVIDENCE_WEIGHTS = {
  voteYea: 1,
  voteNay: 1,
  sponsor: 0.75,
  cosponsor: 0.35,
} as const;

export type MemberEvidenceType = keyof typeof MEMBER_CIVIC_PROFILE_EVIDENCE_WEIGHTS;

export type MemberEvidenceRow = {
  billGuid?: string;
  evidenceType: MemberEvidenceType;
  occurredAt: string;
  civicProfile: Record<string, number>;
  title?: string;
};

type MemberCivicProfileAxisCoverage = {
  evidenceCount: number;
  weightedEvidence: number;
  isReady: boolean;
};

type MemberCivicProfileEvidenceSummary = {
  billGuid: string;
  title?: string;
  evidenceType: MemberEvidenceType;
  votePosition?: "Yea" | "Nay";
  occurredAt: string;
  weight: number;
  axes: CivicProfileAxis[];
  civicProfile: Partial<Record<CivicProfileAxis, number>>;
};

type MemberCivicProfileDiagnostics = {
  rollingWindow: number;
  evidenceWeights: typeof MEMBER_CIVIC_PROFILE_EVIDENCE_WEIGHTS;
  weightedEvidenceUsed: number;
  totalWeightedEvidenceWithProfile: number;
  minWeightedEvidenceRequired: number;
  minAxisWeightedEvidenceRequired: number;
  minAxesRequired: number;
  axesWithSufficientSignal: number;
  axisCoverage: Record<CivicProfileAxis, MemberCivicProfileAxisCoverage>;
  readinessReasons: string[];
  latestEvidenceAt?: string;
};

type MemberCivicProfileResult = {
  axes: Partial<Record<CivicProfileAxis, number>>;
  votesUsed: number;
  totalVotesWithProfile: number;
  sponsoredBillsUsed: number;
  cosponsoredBillsUsed: number;
  totalEvidenceUsed: number;
  totalEvidenceWithProfile: number;
  minEvidenceRequired: number;
  isReady: boolean;
  diagnostics: MemberCivicProfileDiagnostics;
  evidence: MemberCivicProfileEvidenceSummary[];
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const roundMetric = (value: number): number => Number(value.toFixed(4));

const countByType = (rows: MemberEvidenceRow[], type: MemberEvidenceType): number =>
  rows.filter((row) => row.evidenceType === type).length;

const validAxisEntries = (civicProfile: Record<string, number>): Array<[CivicProfileAxis, number]> =>
  Object.entries(civicProfile).filter(
    (entry): entry is [CivicProfileAxis, number] =>
      CIVIC_PROFILE_AXES.includes(entry[0] as CivicProfileAxis) &&
      typeof entry[1] === "number" &&
      Number.isFinite(entry[1]),
  );

const emptyAxisCoverage = (): Record<CivicProfileAxis, MemberCivicProfileAxisCoverage> =>
  Object.fromEntries(
    CIVIC_PROFILE_AXES.map((axis) => [axis, { evidenceCount: 0, weightedEvidence: 0, isReady: false }]),
  ) as Record<CivicProfileAxis, MemberCivicProfileAxisCoverage>;

const evidenceWeight = (type: MemberEvidenceType): number => MEMBER_CIVIC_PROFILE_EVIDENCE_WEIGHTS[type] ?? 0;

const totalWeight = (rows: MemberEvidenceRow[]): number =>
  rows.reduce((sum, row) => sum + evidenceWeight(row.evidenceType), 0);

const evidenceSummary = (row: MemberEvidenceRow): MemberCivicProfileEvidenceSummary | null => {
  const axes = validAxisEntries(row.civicProfile);
  if (axes.length === 0) return null;

  const civicProfile = Object.fromEntries(axes) as Partial<Record<CivicProfileAxis, number>>;
  return {
    billGuid: row.billGuid ?? "",
    ...(row.title ? { title: row.title } : {}),
    evidenceType: row.evidenceType,
    ...(row.evidenceType === "voteYea" ? { votePosition: "Yea" as const } : {}),
    ...(row.evidenceType === "voteNay" ? { votePosition: "Nay" as const } : {}),
    occurredAt: row.occurredAt,
    weight: evidenceWeight(row.evidenceType),
    axes: axes.map(([axis]) => axis),
    civicProfile,
  };
};

export const computeMemberCivicProfile = (
  rows: MemberEvidenceRow[],
  options?: { evidenceLimit?: number },
): MemberCivicProfileResult => {
  const sortedRows = [...rows].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const recentEvidence = sortedRows.slice(0, MEMBER_CIVIC_PROFILE_ROLLING_WINDOW);
  const axisSums: Partial<Record<CivicProfileAxis, number>> = {};
  const axisWeights: Partial<Record<CivicProfileAxis, number>> = {};
  const axisCounts: Partial<Record<CivicProfileAxis, number>> = {};

  for (const evidence of recentEvidence) {
    const sign = evidence.evidenceType === "voteNay" ? -1 : 1;
    const weight = evidenceWeight(evidence.evidenceType);
    for (const [axis, score] of validAxisEntries(evidence.civicProfile)) {
      axisSums[axis] = (axisSums[axis] ?? 0) + sign * score * weight;
      axisWeights[axis] = (axisWeights[axis] ?? 0) + weight;
      axisCounts[axis] = (axisCounts[axis] ?? 0) + 1;
    }
  }

  const axes: Partial<Record<CivicProfileAxis, number>> = {};
  const axisCoverage = emptyAxisCoverage();

  for (const axis of CIVIC_PROFILE_AXES) {
    const weightedEvidence = axisWeights[axis] ?? 0;
    const isAxisReady = weightedEvidence >= MEMBER_CIVIC_PROFILE_MIN_AXIS_WEIGHTED_EVIDENCE;
    axisCoverage[axis] = {
      evidenceCount: axisCounts[axis] ?? 0,
      weightedEvidence: roundMetric(weightedEvidence),
      isReady: isAxisReady,
    };

    if (!isAxisReady) continue;
    const avg = (axisSums[axis] ?? 0) / weightedEvidence;
    axes[axis] = roundMetric(clamp01((avg + 1) / 2));
  }

  const votesUsed = countByType(recentEvidence, "voteYea") + countByType(recentEvidence, "voteNay");
  const totalVotesWithProfile = countByType(sortedRows, "voteYea") + countByType(sortedRows, "voteNay");
  const sponsoredBillsUsed = countByType(recentEvidence, "sponsor");
  const cosponsoredBillsUsed = countByType(recentEvidence, "cosponsor");
  const weightedEvidenceUsed = roundMetric(totalWeight(recentEvidence));
  const totalWeightedEvidenceWithProfile = roundMetric(totalWeight(sortedRows));
  const axesWithSufficientSignal = Object.values(axisCoverage).filter((coverage) => coverage.isReady).length;
  const hasEnoughWeightedEvidence = weightedEvidenceUsed >= MEMBER_CIVIC_PROFILE_MIN_WEIGHTED_EVIDENCE;
  const hasEnoughAxes = axesWithSufficientSignal >= MEMBER_CIVIC_PROFILE_MIN_READY_AXES;
  const readinessReasons: string[] = [];
  if (!hasEnoughWeightedEvidence) {
    readinessReasons.push(
      `Needs ${roundMetric(MEMBER_CIVIC_PROFILE_MIN_WEIGHTED_EVIDENCE - weightedEvidenceUsed)} more weighted evidence.`,
    );
  }
  if (!hasEnoughAxes) {
    readinessReasons.push(
      `Needs ${MEMBER_CIVIC_PROFILE_MIN_READY_AXES - axesWithSufficientSignal} more axes with enough signal.`,
    );
  }

  return {
    axes,
    votesUsed,
    totalVotesWithProfile,
    sponsoredBillsUsed,
    cosponsoredBillsUsed,
    totalEvidenceUsed: recentEvidence.length,
    totalEvidenceWithProfile: sortedRows.length,
    minEvidenceRequired: MEMBER_CIVIC_PROFILE_MIN_WEIGHTED_EVIDENCE,
    isReady: hasEnoughWeightedEvidence && hasEnoughAxes,
    diagnostics: {
      rollingWindow: MEMBER_CIVIC_PROFILE_ROLLING_WINDOW,
      evidenceWeights: MEMBER_CIVIC_PROFILE_EVIDENCE_WEIGHTS,
      weightedEvidenceUsed,
      totalWeightedEvidenceWithProfile,
      minWeightedEvidenceRequired: MEMBER_CIVIC_PROFILE_MIN_WEIGHTED_EVIDENCE,
      minAxisWeightedEvidenceRequired: MEMBER_CIVIC_PROFILE_MIN_AXIS_WEIGHTED_EVIDENCE,
      minAxesRequired: MEMBER_CIVIC_PROFILE_MIN_READY_AXES,
      axesWithSufficientSignal,
      axisCoverage,
      readinessReasons,
      ...(recentEvidence[0]?.occurredAt ? { latestEvidenceAt: recentEvidence[0].occurredAt } : {}),
    },
    evidence: recentEvidence
      .slice(0, options?.evidenceLimit ?? MEMBER_CIVIC_PROFILE_EVIDENCE_LIMIT)
      .map(evidenceSummary)
      .filter((item): item is MemberCivicProfileEvidenceSummary => item !== null && item.billGuid.length > 0),
  };
};
