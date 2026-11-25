import type { BillStatusValue } from "../models/bill";

/*
 * APPF-23: which member of a companion group stands for the group's status, as app 1.3's companion card picks it
 * (`CompanionGroupIndex.statusLead` in the iOS app). The Weekly Brief (weeklyDigestBuilder.ts) and the Updates list
 * (handlers/fetchRecentActions) both use it, so a pair reads the same status there as on the Bills card.
 */

/**
 * A status's rank among a companion group's members: Finalized 5, Passed 3, Failed 2, Updated 1, New 0, and a vetoed
 * member that is not Finalized 4 (COMPANION_VETOED_RANK). Passed and Failed are not tied: a Passed/Failed pair shows as
 * the Passed bill, whichever moved later.
 */
export const COMPANION_STATUS_RANK: Readonly<Record<BillStatusValue, number>> = {
  New: 0,
  Updated: 1,
  Failed: 2,
  Passed: 3,
  Finalized: 5,
};

/**
 * A vetoed member's rank (project decision 2026-11-19), above Passed and below Finalized: a vetoed bill whose override
 * failed is Failed, and ranked by its status it lost to a partner that had only passed its own chamber, so the group
 * hid the veto. App 1.2 ranks by the status alone, so in that rare case its card shows the partner while the brief
 * names the vetoed bill.
 */
export const COMPANION_VETOED_RANK = 4;

/** What ranks one member of a companion group. */
export interface CompanionLeadFacts {
  /** The member's billStatus; none ranks as New. */
  status: BillStatusValue | undefined;
  /** Whether the member's veto stands (billOutcomes.ts deriveBillVetoedFromActions, or its manifest row's flag). */
  vetoed: boolean;
  /** When the member's manifest row last moved (its updatedAt, the app's storedAt), in epoch ms; 0 when unknown. */
  movedAtMs: number;
  /** Whether the member is the group's primary (the House bill). */
  isPrimary: boolean;
}

/** A member's rank in its companion group (COMPANION_STATUS_RANK, or COMPANION_VETOED_RANK). */
export const companionStatusRank = (facts: Pick<CompanionLeadFacts, "status" | "vetoed">): number =>
  facts.status !== "Finalized" && facts.vetoed ? COMPANION_VETOED_RANK : COMPANION_STATUS_RANK[facts.status ?? "New"];

/**
 * The member that stands for the group: the highest rank (companionStatusRank), so a law (REL-44) whose twin moved
 * later still reads "Became law", a vetoed bill stands over a twin that only passed, and a Passed bill stands over its
 * Failed twin. Among equal ranks, the member whose manifest row moved most recently; a tie goes to the primary, and a
 * full tie to the earlier listed. Undefined for no members.
 */
export const companionStatusLead = <T>(
  members: readonly T[],
  factsOf: (member: T) => CompanionLeadFacts,
): T | undefined => {
  let lead: { member: T; facts: CompanionLeadFacts; rank: number } | undefined;
  for (const member of members) {
    const facts = factsOf(member);
    const rank = companionStatusRank(facts);
    if (lead) {
      if (rank !== lead.rank) {
        if (rank < lead.rank) continue;
      } else {
        const delta = facts.movedAtMs - lead.facts.movedAtMs;
        if (!(delta > 0 || (delta === 0 && facts.isPrimary && !lead.facts.isPrimary))) continue;
      }
    }
    lead = { member, facts, rank };
  }
  return lead?.member;
};
