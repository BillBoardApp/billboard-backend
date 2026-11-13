import { GetItemCommand, UpdateItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { civicDayKeys, computeStreaks, nextEasternMidnight, recentDays } from "./civicDays";
import { CIVIC_PROFILE_MIN_VOTES, civicProfileReadiness, civicProfileWindow } from "./civicProfileReadiness";
import {
  evaluateEarnedHonors,
  honorsWithIds,
  STREAK_DAY_POINTS,
  sumHonorBonus,
  VOTE_POINTS,
  type EarnedCivicHonor,
} from "./civicProgression";

/**
 * UX-31 (feature review S8, project decision 2026-10-28): the Civic Score is a participation record that never goes
 * down. A Yea, Nay or Abstain counts the same (a 1.0 or 1.1 Updates dismissal is no vote), and so does each day with a
 * first vote on a bill (models/feedback.ts firstVotedAt, so changing an old vote adds no day).
 *
 *   civicScore = voteScore + streakBonus + honorBonus
 *   voteScore   = 10 x the votes the record holds: each new vote adds one, and a vote that leaves the count keeps it
 *   streakBonus = 5 x the best streak ever (days), kept when a streak ends
 *   honorBonus  = the bonuses of every honor ever earned, kept when its condition stops holding
 *
 * Each part only rises, so the score and the rank (a function of the score) never drop. What has to be remembered is
 * kept on the user's UserPII row, beside the INT-06 vote counter (CIVIC_RECORD_ATTRIBUTES):
 *   civicEasternFrom  (S)  the instant the user's days switch from UTC to America/New_York (civicDays.ts);
 *   civicVotes        (N)  the votes the record holds, the floor of voteScore;
 *   civicVoteRows     (N)  the most vote rows seen: rows that hold a vote or held one (heldVoteRows);
 *   civicCountedVotes (N)  the votes counted at the last write (totalVotes then);
 *   civicBestStreak   (N)  the best streak, the floor of longestStreak and streakBonus;
 *   civicHonors       (SS) the ids of the honors earned;
 *   civicUpdatedAt    (S)  when the record last changed.
 * Account deletion removes it with the row (the tombstone replaces the row whole; CleanupOrphanedUsers deletes it).
 *
 * Why three vote counters (feature review follow-up F1). The votes counted can fall: a companion pair published over
 * two of the user's votes counts once from then on, and 1.1 can write a dismissal over a vote on a decided bill. A
 * high-water mark of the count would keep those points but then pay nothing for the next new votes until the count
 * caught up. So the record adds the rise instead: each read adds min(rows rise, count rise) to civicVotes, where rows
 * rise = vote rows now - civicVoteRows and count rise = totalVotes now - civicCountedVotes. Vote rows are never
 * deleted (only with the account) and a row that held a vote keeps its firstVotedAt through a dismissal, so the vote
 * rows only grow: a read that sees fewer (a replica behind, an older read finishing last) adds nothing, and since
 * civicVoteRows only rises, no vote is ever added twice. The count rise keeps the companion rule: a vote on the other
 * member of a pair adds a row but no count, and the count jumping when the groups are switched off adds no row, so
 * neither adds points. civicVotes is therefore at most civicVoteRows plus what the seed gave. A vote is missed only
 * when a fall of the count (a pair published over two of the user's votes, a dismissal over a vote, the groups switched
 * back on) and that vote come between the same two reads; both apps read the score after every saved vote.
 *
 * The first read after UX-31 seeds a user's record from what the rule before it showed, so no score drops at the
 * deploy and no backfill is needed: the best streak is at least the old longestStreak (UTC days of `votedAt`, Yea and
 * Nay only), and every other part counts at least what it did (Abstain added), so the score, the rank, the best streak
 * and the honors are at least what the old rule gave: its streak bonus (5 x the current streak) is at most 5 x the
 * best. The days switch at the first Eastern midnight after that read, so the switch breaks no streak.
 *
 * Civic Compass ("Unlock your Civic Profile.", UX-32) is earned when the Civic Profile is ready under the profile's own
 * rule (civicProfileReadiness.ts: 25 votes and 3 themes at 8), never before: civicProfileReadyFromOwnRows. The one
 * exception is a seed (a read with no stored record): it keeps the honor on the rule before UX-32 (25 Yea or Nay votes
 * whose rows carry a civic profile), which the user saw, so it can grant it, for good, while the chart is locked on its
 * themes. That is every user's first read after the deploy, every read of a user with no UserPII row (who has not
 * voted since INT-06, so no new vote counts), and a read after a UserPII restore to before the user's seed.
 */

/** The record's attributes on the UserPII row. */
export const CIVIC_RECORD_ATTRIBUTES = {
  easternFrom: "civicEasternFrom",
  votes: "civicVotes",
  voteRows: "civicVoteRows",
  countedVotes: "civicCountedVotes",
  bestStreak: "civicBestStreak",
  honors: "civicHonors",
  updatedAt: "civicUpdatedAt",
} as const;

/** The last 30 days in the Civic Rank sheet. */
export const RECENT_VOTE_DAYS = 30;

export interface CivicRecord {
  /**
   * Days are UTC days before this instant and America/New_York days from it on (civicDays.ts): an ISO time, as stored.
   * Null in a record that has none yet (the next write sets it).
   */
  easternFrom: string | null;
  /** The votes the record holds (voteScore / 10). */
  votes: number;
  /** The most vote rows seen (heldVoteRows); null in a record that has none (the read then takes the rows it sees). */
  voteRows: number | null;
  /** totalVotes at the last write; null in a record that has none, like voteRows. */
  countedVotes: number | null;
  /** The best streak, in days. */
  bestStreak: number;
  /** The ids of the honors earned. */
  honorIds: string[];
}

/** A vote the score counts: one per bill (a companion pair once), Yea, Nay or Abstain, not a 1.0 or 1.1 dismissal. */
export interface CountedVote {
  feedback: "yea" | "nay" | "abstain";
  /** When the user first voted on the bill (firstVoteTimeOf); null for a vote with no time. */
  firstVotedAt: string | null;
  /** The row's votedAt, the time of its last write: only the seed reads it, as the rule before UX-31 did. */
  votedAt: string | null;
  /** The bill's life areas and sub-categories, normalized (one key per area). */
  areas: string[];
  /**
   * The themes the vote row's own civic profile snapshot scores (civicProfileThemes; [] for a snapshot with none of
   * them), or null when the row carries none. GET /civic-profile reads such a row's profile from the manifest; the
   * score does not (it runs on every tab header), so the honor never knows more of a vote than the chart.
   */
  civicProfileThemes: readonly string[] | null;
}

/** GET /civic-score's body (contracts/openapi/user-api.v1.json CivicScore). */
export interface CivicScoreBody {
  civicScore: number;
  totalVotes: number;
  currentStreak: number;
  longestStreak: number;
  lastVotedAt: string | null;
  recentVoteDays: { date: string; count: number }[];
  voteScore: number;
  streakBonus: number;
  honorBonus: number;
  coverageAreaCount: number;
  honors: EarnedCivicHonor[];
}

export interface CivicStanding {
  /** The body without the rank, which follows from civicScore. */
  body: CivicScoreBody;
  /** What the record holds after this read: the stored one, raised by what the votes give now. */
  record: StoredCivicRecord;
}

/** A record as written: every attribute set. */
export type StoredCivicRecord = CivicRecord & { easternFrom: string; voteRows: number; countedVotes: number };

const parseInstant = (value: string | null): number | null => {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The longest streak under the rule before UX-31: UTC days (the first 10 characters of votedAt, as it read them) with
 * a Yea or Nay. Only the seed of a user's record reads it.
 */
export function legacyLongestStreak(votes: readonly CountedVote[], nowMs: number): number {
  const days = votes
    .filter((vote) => vote.feedback !== "abstain" && vote.votedAt)
    .map((vote) => (vote.votedAt as string).substring(0, 10));
  return computeStreaks(days, new Date(nowMs).toISOString().slice(0, 10)).longestStreak;
}

/**
 * Civic Compass (UX-32): whether the Civic Profile is ready, by the profile's rule (civicProfileReadiness) applied to
 * the vote rows' own civic profiles, so that the honor is never earned while GET /civic-profile shows the profile
 * locked. It can come later: the chart also reads from the manifest the profile of a bill whose row has none.
 *
 * The window mirrors the chart's (fetchCivicProfile): the same rows after the same companion dedupe, Yea or Nay only
 * (a 1.0 or 1.1 dismissal, which the score leaves out, is always an Abstain), with a `votedAt`, the 100 most recent by
 * `votedAt` in the same stable order (civicProfileWindow). A row without its own profile still takes its place here
 * and counts for nothing: the chart counts it only when the manifest has a profile for its bill. So the chart's votes
 * are a sub-list of these, every vote counted here is in the chart's window (it can only rank higher there) with the
 * same themes, and the chart has at least these votes and theme votes. A window over the rows with a profile of their
 * own alone would not do: newer votes whose profile only the manifest has would push those rows out of the chart's
 * window but not out of that one. The cost is that the honor can come later than the chart: a row whose bill's profile
 * only the manifest has (an older row, or a bill scored after the vote) counts for the chart only, and past 100 Yea or
 * Nay votes every row without its own profile takes a place here that the chart gives to an older vote, also a vote on
 * a bill scored on no theme (no civic profile anywhere, so the chart skips it).
 */
export function civicProfileReadyFromOwnRows(votes: readonly CountedVote[]): boolean {
  const yeaOrNay = votes.flatMap((vote) =>
    vote.feedback !== "abstain" && vote.votedAt ? [{ votedAt: vote.votedAt, themes: vote.civicProfileThemes }] : [],
  );
  return civicProfileReadiness(civicProfileWindow(yeaOrNay)).isReady;
}

/**
 * Civic Compass under the rule before UX-32 (UX-31 kept it from before): 25 Yea or Nay votes whose rows carry a civic
 * profile, `votedAt` or not, all votes counted. Only a seed reads it, so a user who saw the honor before keeps it.
 */
function legacyCivicProfileUnlocked(votes: readonly CountedVote[]): boolean {
  return (
    votes.filter((vote) => vote.feedback !== "abstain" && vote.civicProfileThemes !== null).length >=
    CIVIC_PROFILE_MIN_VOTES
  );
}

/**
 * The votes the record holds after this read, and its two vote counters (module comment). Without counters (no record
 * yet, or one without them) the record starts from the votes counted now, and from at least the votes it holds.
 */
function keptVoteCounts(
  stored: CivicRecord | null,
  totalVotes: number,
  heldVoteRows: number,
): { votes: number; voteRows: number; countedVotes: number } {
  if (!stored || stored.voteRows === null || stored.countedVotes === null) {
    return { votes: Math.max(stored?.votes ?? 0, totalVotes), voteRows: heldVoteRows, countedVotes: totalVotes };
  }
  const added = Math.max(0, Math.min(heldVoteRows - stored.voteRows, totalVotes - stored.countedVotes));
  return {
    votes: stored.votes + added,
    voteRows: Math.max(stored.voteRows, heldVoteRows),
    countedVotes: totalVotes,
  };
}

/**
 * The user's standing now: the votes counted under UX-31, raised to the stored record (null before the user's first
 * record: it is then seeded as the module comment says). `heldVoteRows` is the number of the user's vote rows that
 * hold a vote or held one, before the companion dedupe (at least votes.length). Pure.
 */
export function civicStanding(
  votes: readonly CountedVote[],
  heldVoteRows: number,
  stored: CivicRecord | null,
  nowMs: number,
): CivicStanding {
  const easternFromMs = parseInstant(stored?.easternFrom ?? null) ?? nextEasternMidnight(nowMs);
  const dayOf = civicDayKeys(easternFromMs);
  const today = dayOf(nowMs);

  const dayCounts = new Map<string, number>();
  let lastFirstVoteMs: number | null = null;
  for (const vote of votes) {
    const firstMs = parseInstant(vote.firstVotedAt);
    if (firstMs === null) continue;
    const day = dayOf(firstMs);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    if (lastFirstVoteMs === null || firstMs > lastFirstVoteMs) lastFirstVoteMs = firstMs;
  }
  const { currentStreak, longestStreak } = computeStreaks(dayCounts.keys(), today);

  const totalVotes = votes.length;
  const coverageAreaCount = new Set(votes.flatMap((vote) => vote.areas)).size;
  // UX-32: the profile's own readiness, never earlier than the chart; a seed keeps what the rule before showed. The
  // legacy rule counts every vote the new one does (and more), so a seed takes it alone.
  const civicProfileUnlocked = stored ? civicProfileReadyFromOwnRows(votes) : legacyCivicProfileUnlocked(votes);

  const voteCounts = keptVoteCounts(stored, totalVotes, Math.max(heldVoteRows, totalVotes));
  const keptVotes = voteCounts.votes;
  const keptBestStreak = Math.max(stored ? stored.bestStreak : legacyLongestStreak(votes, nowMs), longestStreak);
  const earned = evaluateEarnedHonors({
    totalVotes: keptVotes,
    currentStreak,
    longestStreak: keptBestStreak,
    coverageAreaCount,
    civicProfileUnlocked,
  });
  const honors = honorsWithIds([...(stored?.honorIds ?? []), ...earned.map((honor) => honor.id)]);
  // Kept ids no honor has any more are kept too, so the record never shrinks.
  const honorIds = [...new Set([...(stored?.honorIds ?? []), ...honors.map((honor) => honor.id)])];

  const voteScore = keptVotes * VOTE_POINTS;
  const streakBonus = keptBestStreak * STREAK_DAY_POINTS;
  const honorBonus = sumHonorBonus(honors);

  return {
    body: {
      civicScore: voteScore + streakBonus + honorBonus,
      totalVotes,
      currentStreak,
      longestStreak: keptBestStreak,
      lastVotedAt: lastFirstVoteMs === null ? null : new Date(lastFirstVoteMs).toISOString(),
      recentVoteDays: recentDays(dayCounts, today, RECENT_VOTE_DAYS),
      voteScore,
      streakBonus,
      honorBonus,
      coverageAreaCount,
      honors,
    },
    record: {
      easternFrom: stored?.easternFrom ?? new Date(easternFromMs).toISOString(),
      votes: keptVotes,
      voteRows: voteCounts.voteRows,
      countedVotes: voteCounts.countedVotes,
      bestStreak: keptBestStreak,
      honorIds,
    },
  };
}

/**
 * Whether `next` differs from `stored` so that it must be written: it holds more, or the votes counted moved (a fall
 * must be stored, or the next new vote would only make up for it). A new record is worth storing once it holds
 * anything.
 */
export function recordChanged(stored: CivicRecord | null, next: StoredCivicRecord): boolean {
  if (!stored) return next.votes > 0 || next.bestStreak > 0 || next.honorIds.length > 0;
  const storedHonors = new Set(stored.honorIds);
  return (
    next.votes > stored.votes ||
    next.voteRows !== stored.voteRows ||
    next.countedVotes !== stored.countedVotes ||
    next.bestStreak > stored.bestStreak ||
    next.honorIds.some((id) => !storedHonors.has(id)) ||
    next.easternFrom !== stored.easternFrom
  );
}

// ── The record on the UserPII row ───────────────────────────────────────────────────────────────

export interface CivicRecordTable {
  db: Pick<DynamoDBClient, "send">;
  /** The UserPII table and its partition key. */
  tableName: string;
  partitionKey: string;
}

/** What the user's UserPII row says: no row, or the row with its record (null before the first) and deletion state. */
export type CivicRecordRow = { exists: false } | { exists: true; record: CivicRecord | null; deleting: boolean };

const nonNegativeInteger = (attribute: AttributeValue | undefined): number => {
  const value = Number(attribute?.N);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

/** A stored counter, or null when the record has none. */
const storedCounter = (attribute: AttributeValue | undefined): number | null =>
  attribute?.N === undefined ? null : nonNegativeInteger(attribute);

/** The row as read (GetItem, or the ALL_OLD of a failed condition). */
export function civicRecordRowOf(
  item: Record<string, AttributeValue> | undefined,
  partitionKey: string,
): CivicRecordRow {
  if (!item?.[partitionKey]) return { exists: false };
  const deletionStatus = item.deletionStatus?.S;
  const deleting = deletionStatus === "in_progress" || deletionStatus === "completed";
  const stored = Object.values(CIVIC_RECORD_ATTRIBUTES).some((name) => item[name] !== undefined);
  if (!stored) return { exists: true, record: null, deleting };
  return {
    exists: true,
    record: {
      easternFrom: item[CIVIC_RECORD_ATTRIBUTES.easternFrom]?.S ?? null,
      votes: nonNegativeInteger(item[CIVIC_RECORD_ATTRIBUTES.votes]),
      voteRows: storedCounter(item[CIVIC_RECORD_ATTRIBUTES.voteRows]),
      countedVotes: storedCounter(item[CIVIC_RECORD_ATTRIBUTES.countedVotes]),
      bestStreak: nonNegativeInteger(item[CIVIC_RECORD_ATTRIBUTES.bestStreak]),
      honorIds: item[CIVIC_RECORD_ATTRIBUTES.honors]?.SS ?? [],
    },
    deleting,
  };
}

/** The user's row, strongly consistent, so a read never sees a record older than the last one written. */
export async function readCivicRecordRow(table: CivicRecordTable, userId: string): Promise<CivicRecordRow> {
  const result = await table.db.send(
    new GetItemCommand({
      TableName: table.tableName,
      Key: { [table.partitionKey]: { S: userId } },
      ConsistentRead: true,
      ProjectionExpression:
        "#pk, deletionStatus, #easternFrom, #votes, #voteRows, #countedVotes, #bestStreak, #honors, #updatedAt",
      ExpressionAttributeNames: {
        "#pk": table.partitionKey,
        "#easternFrom": CIVIC_RECORD_ATTRIBUTES.easternFrom,
        "#votes": CIVIC_RECORD_ATTRIBUTES.votes,
        "#voteRows": CIVIC_RECORD_ATTRIBUTES.voteRows,
        "#countedVotes": CIVIC_RECORD_ATTRIBUTES.countedVotes,
        "#bestStreak": CIVIC_RECORD_ATTRIBUTES.bestStreak,
        "#honors": CIVIC_RECORD_ATTRIBUTES.honors,
        "#updatedAt": CIVIC_RECORD_ATTRIBUTES.updatedAt,
      },
    }),
  );
  return civicRecordRowOf(result.Item, table.partitionKey);
}

export type CivicRecordWrite =
  | { outcome: "written" }
  /** The row changed since it was read, is gone, or is being deleted: `row` is what it holds now. */
  | { outcome: "conflict"; row: CivicRecordRow };

/**
 * Writes `next` onto the user's row. One UpdateItem, on condition that the row exists (a GET never creates the row,
 * which would read everywhere as a user), is not being deleted, and holds no other `civicEasternFrom` and no higher
 * vote count, vote rows or best streak: so a stored value never drops, even under a concurrent read, and a vote is
 * never added twice (module comment). `civicCountedVotes` is written as this read counted. Honors are added to the
 * set. Errors other than the failed condition are thrown.
 */
export async function writeCivicRecord(
  table: CivicRecordTable,
  userId: string,
  next: StoredCivicRecord,
  nowIso: string,
): Promise<CivicRecordWrite> {
  const names: Record<string, string> = {
    "#pk": table.partitionKey,
    "#deletionStatus": "deletionStatus",
    "#easternFrom": CIVIC_RECORD_ATTRIBUTES.easternFrom,
    "#votes": CIVIC_RECORD_ATTRIBUTES.votes,
    "#voteRows": CIVIC_RECORD_ATTRIBUTES.voteRows,
    "#countedVotes": CIVIC_RECORD_ATTRIBUTES.countedVotes,
    "#bestStreak": CIVIC_RECORD_ATTRIBUTES.bestStreak,
    "#updatedAt": CIVIC_RECORD_ATTRIBUTES.updatedAt,
  };
  const values: Record<string, AttributeValue> = {
    ":easternFrom": { S: next.easternFrom },
    ":votes": { N: String(next.votes) },
    ":voteRows": { N: String(next.voteRows) },
    ":countedVotes": { N: String(next.countedVotes) },
    ":bestStreak": { N: String(next.bestStreak) },
    ":updatedAt": { S: nowIso },
    ":deletionInProgress": { S: "in_progress" },
    ":deletionCompleted": { S: "completed" },
  };
  let update =
    "SET #easternFrom = :easternFrom, #votes = :votes, #voteRows = :voteRows, #countedVotes = :countedVotes, " +
    "#bestStreak = :bestStreak, #updatedAt = :updatedAt";
  if (next.honorIds.length > 0) {
    update += " ADD #honors :honors";
    names["#honors"] = CIVIC_RECORD_ATTRIBUTES.honors;
    values[":honors"] = { SS: [...next.honorIds] };
  }
  try {
    await table.db.send(
      new UpdateItemCommand({
        TableName: table.tableName,
        Key: { [table.partitionKey]: { S: userId } },
        UpdateExpression: update,
        ConditionExpression: [
          "attribute_exists(#pk)",
          "(attribute_not_exists(#deletionStatus) OR (#deletionStatus <> :deletionInProgress AND #deletionStatus <> :deletionCompleted))",
          "(attribute_not_exists(#easternFrom) OR #easternFrom = :easternFrom)",
          "(attribute_not_exists(#votes) OR #votes <= :votes)",
          "(attribute_not_exists(#voteRows) OR #voteRows <= :voteRows)",
          "(attribute_not_exists(#bestStreak) OR #bestStreak <= :bestStreak)",
        ].join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }),
    );
    return { outcome: "written" };
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name !== "ConditionalCheckFailedException") throw error;
    const item = (error as { Item?: Record<string, AttributeValue> }).Item;
    return { outcome: "conflict", row: civicRecordRowOf(item, table.partitionKey) };
  }
}
