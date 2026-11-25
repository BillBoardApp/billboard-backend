// The members' public roll-call record (UX-39d): CongressMemberVoteRecord rows as congressMemberStats writes them and
// GET /congress-member-record reads them, and the day a chamber vote is dated by.
//
// One row per member, bill and chamber (sort key "<billGuid>#<chamber>"), so a newer roll call on a bill overwrites the
// member's row instead of adding one. The VotedOnIndex (a local index, sort key "<votedOn>#<billGuid>") reads a
// member's rows newest first; the BillGuidIndex finds a bill's rows.

export type VoteRecordChamber = "House" | "Senate";
export type VoteRecordPosition = "Yea" | "Nay" | "Present" | "Not Voting";

export const VOTE_RECORD_POSITIONS: readonly VoteRecordPosition[] = ["Yea", "Nay", "Present", "Not Voting"];

/** The table's sort key: the bill's plain guid and the chamber whose roll call it is. */
export const voteRecordBillKey = (billGuid: string, chamber: VoteRecordChamber): string => `${billGuid}#${chamber}`;

/** The VotedOnIndex sort key: the roll call's day, then the bill, so a member's rows read newest first. */
export const voteRecordVotedOnKey = (votedOn: string, billGuid: string): string => `${votedOn}#${billGuid}`;

const DAY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

/**
 * The roll call's day as Congress records it (YYYY-MM-DD), from a chamber vote's actionDate. A House vote's is the day
 * itself ("2026-02-01"). A Senate vote read from its XML is stored as that day and the Senate's clock time in ISO form
 * ("2027-01-15T14:30:00.000Z", the Eastern time read as if it were UTC), whose first ten characters are still the
 * Senate's own day. Null for anything else: such a vote is left out of the record rather than dated by the time
 * Billboard synced it, and its day is never moved by a time zone.
 */
export const voteRecordDayOf = (actionDate: unknown): string | null => {
  if (typeof actionDate !== "string") return null;
  const match = actionDate.trim().match(DAY_PREFIX);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? `${match[1]}-${match[2]}-${match[3]}` : null;
};

/** A member's position as the record keeps it, from the forms official votes carry; null for Unknown and the like. */
export const voteRecordPositionOf = (value: unknown): VoteRecordPosition | null => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "yea" || normalized === "yes" || normalized === "aye") return "Yea";
  if (normalized === "nay" || normalized === "no") return "Nay";
  if (normalized === "present") return "Present";
  if (normalized === "not voting" || normalized === "not-voting" || normalized === "nv") return "Not Voting";
  return null;
};
