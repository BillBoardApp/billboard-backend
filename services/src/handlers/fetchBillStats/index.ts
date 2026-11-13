import { BatchGetItemCommand, DynamoDBClient, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { activeCompanionPairs, BillCompanionDao, type CompanionGroupsState } from "../../adapters/billCompanionDao";
import type { CompanionGroupV1 } from "../../contracts";
import { LEGACY_DISMISS_ATTRIBUTE, unlocksResults } from "../../models/feedback";
import { companionIndex, companionStatsKey, plainBillGuid, type CompanionIndex } from "../../shared/billCompanions";
import {
  applyStatsSampleFloor,
  computeFreshBillStats,
  computeFreshCompanionStats,
  computeRawCompanionStats,
  createEmptyBillStats,
  isCountedVote,
  readStoredStats,
  toServedStats,
  type BillStatsResponse,
  type FreshBillStats,
  type StoredBillStats,
} from "../../shared/billStats";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";
import { sleep } from "../../shared/retry";

const STATS_TABLE_NAME = process.env.STATS_TABLE_NAME;
const STATS_PARTITION_KEY = process.env.STATS_PARTITION_KEY ?? process.env.SORT_KEY ?? "billId";

// APPF-23 scope=companions. The groups are the ones PublishBillsManifest last published (none while
// they are turned off), read at most every 60 s; they need MANIFEST_TABLE_NAME. A group's combined
// stats are the document billStatsAggregator stores under companionStatsKey(group). When there is none
// yet, or a member's own stats are newer (votes that reached no group recompute: while the groups
// were off, or when the aggregator could not read them), they are folded here from the feedback
// bill-id index, without writing, and kept for 60 s.
//
// INT-11: every request first checks that the caller voted or abstained on the bill or its companion
// (readCallerVotes), so FEEDBACK_TABLE_NAME is required: without it every request answers 500.
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME?.trim();
const FEEDBACK_TABLE_NAME = process.env.FEEDBACK_TABLE_NAME?.trim();
const FEEDBACK_PARTITION_KEY = process.env.FEEDBACK_PARTITION_KEY ?? "userId";
const FEEDBACK_SORT_KEY = process.env.FEEDBACK_SORT_KEY ?? "billId";
const FEEDBACK_BILL_ID_INDEX_NAME = process.env.FEEDBACK_BILL_ID_INDEX_NAME?.trim();

const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
const COMPUTED_GROUP_STATS_MAX_AGE_MS = 60_000;
// Groups number in the hundreds; the bound only stops a warm container from growing without limit.
const COMPUTED_GROUP_STATS_MAX_ENTRIES = 500;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";

// INT-11: results only after the caller's own vote. One strongly consistent BatchGetItem on the
// caller's UserFeedback rows: the first read and up to 3 retries of unprocessed keys.
const FEEDBACK_READ_MAX_ATTEMPTS = 4;
const FEEDBACK_READ_BACKOFF_MS = 50;
const RESULTS_METRIC_NAMESPACE = "BillBoard/BillStats";

// S1: results right after a vote. billStatsAggregator stores a bill's stats up to about 30 s after a vote
// (the stream's batching window), and apps 1.1 and 1.2 ask again with forceRefresh=true at about 0 s and
// 4 s after a saved vote (1.2 also on Try again, at any time). For scope=bill with forceRefresh=true,
// when the caller's own counted vote on the bill is newer than the stored document, the bill's votes are
// folded here from the bill-id index, without writing (computeFreshBillStats: the aggregator's fold and
// sample floor). The bounds:
// - only for a vote less than FRESH_STATS_VOTE_MAX_AGE_MS old: S1 is about the answer right after a
//   vote, so an older one (Try again, a missing document) never folds;
// - only a bill whose stored totals hold at most FRESH_STATS_MAX_VOTES votes (or that has no stored
//   document), and a fold stops past FRESH_STATS_MAX_ROWS rows; a bill that did is not folded again
//   for FRESH_STATS_MAX_AGE_MS in that container;
// - a fold is kept for FRESH_STATS_MAX_AGE_MS and served to every caller whose vote it holds, and a bill
//   is folded at most once every FRESH_STATS_MIN_INTERVAL_MS in a container, whoever asks;
// - only while the caller's vote is newer than the stored document: once the aggregator has stored the
//   vote (about 30 s), every request is served the stored document again.
// So a client sending forceRefresh again and again gets at most one fold per bill every 2 s per
// container, only in the 2 minutes after a vote of its own, and usually one or two in all.
//
// REL-48: the same for scope=companions on a bill in a companion group, which is what apps 1.1 and 1.2
// ask for every grouped bill (the primary's guid, scope=companions, forceRefresh=true). The caller's
// vote is their row the group counts (callerGroupVotedAtMs), the document is the group's (its stats
// key), the fold reads every member's rows with the aggregator's rule (computeFreshCompanionStats), the
// vote cap applies to the group document and to the members' own documents added together (a person
// who voted on both is a row on each, and the fold reads both), and the row cap to the members together.
// Folds of a bill and of a group share these bounds and this container's folds (by bill id or stats key).
// A group fold that does not answer (past the row cap, or failed) leaves the request to go on as one
// without forceRefresh, as before REL-48: APPF-23's fold of every member row, with no row cap, when the
// group document is missing (a failed read counts as missing) or behind a member's own, and when that
// gives no group stats either, the bill's own document and its S1 fold. So the worst request makes a
// capped group fold, an uncapped APPF-23 fold and a capped bill fold; a group past the row cap does it
// at most once every FRESH_STATS_MAX_AGE_MS per container (the APPF-23 fold is kept as long).
const FRESH_STATS_MAX_VOTES = 5_000;
// Rows of any kind (uncounted ones too, and votes since the stored document): a bill without a stored
// document, or one that grew past it, is never read to the end.
const FRESH_STATS_MAX_ROWS = 2 * FRESH_STATS_MAX_VOTES;
const FRESH_STATS_MAX_AGE_MS = 60_000;
// Four times the aggregator's 30 s batching window.
const FRESH_STATS_VOTE_MAX_AGE_MS = 120_000;
// Under the apps' 4 s between their two requests, so a fold read before the caller's vote reached the
// index is redone on the second.
const FRESH_STATS_MIN_INTERVAL_MS = 2_000;
const FRESH_STATS_MAX_ENTRIES = 500;
// A document or fold whose read started less than this after a vote may still have missed it: the
// bill-id index is eventually consistent, and votedAt and the read times come from different clocks.
const VOTE_INDEX_SETTLE_MS = 1_000;

const STATS_SCOPES = ["bill", "companions"] as const;
type StatsScope = (typeof STATS_SCOPES)[number];

const db = new DynamoDBClient({});
const companionDao = MANIFEST_TABLE_NAME ? new BillCompanionDao(db) : null;
let companionIndexFor: { state: CompanionGroupsState | null; index: CompanionIndex } | undefined;
const computedGroupStats = new Map<string, { stats: BillStatsResponse; computedAtMs: number }>();

/** S1: a fold of one bill's votes, or of a companion group's (REL-48), that read every row. */
type FreshFold = {
  /** When the fold started reading (ms). */
  startedAtMs: number;
  stats: BillStatsResponse;
  /**
   * Votes stored at or before this time (ms) are taken to be in `stats`: VOTE_INDEX_SETTLE_MS before the
   * fold started reading, or just before the folding caller's vote when the fold missed that row. One
   * row read says nothing of another (the index shows rows in no order), so a later vote is held only
   * when `recentVotes` lists it.
   */
  settledUntilMs: number;
  /**
   * User id to votedAt (ms) of the rows it read that were stored after settledUntilMs (and a few before);
   * for a group, only each user's row the group counts.
   */
  recentVotes: ReadonlyMap<string, number>;
};
/** S1: this container's folds of one bill, or of one companion group (REL-48). */
type FreshFoldState = {
  /** The last fold that read every row; served until FRESH_STATS_MAX_AGE_MS after it started. */
  fold?: FreshFold;
  /**
   * No fold starts before this (ms): FRESH_STATS_MIN_INTERVAL_MS after the last attempt, and
   * FRESH_STATS_MAX_AGE_MS after one that stopped past FRESH_STATS_MAX_ROWS. A failed attempt leaves
   * `fold` as it was.
   */
  nextFoldAtMs: number;
};
/** Keyed by bill id, or by a group's stats key (COMPANIONS#…), which is never a bill id. */
const freshFolds = new Map<string, FreshFoldState>();

function json(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Every 200 body goes through toServedStats (2C, INT-08): weighted* equal to the plain counts (also
 * for payloads cached at the old 1.25 weight) and the national `comparison` block.
 */
function served(stats: BillStatsResponse, extra: Record<string, unknown> = {}) {
  return json(200, { ...toServedStats(stats), ...extra });
}

/** "bill" when the parameter is absent or empty, null when it is not one of STATS_SCOPES. */
function parseScope(raw: unknown): StatsScope | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "bill";
  return (STATS_SCOPES as readonly string[]).includes(value) ? (value as StatsScope) : null;
}

/** The bill's companion group, or undefined when it has none (or the groups cannot be read). */
async function companionGroupOf(billId: string): Promise<CompanionGroupV1 | undefined> {
  if (!companionDao) return undefined;
  const plain = plainBillGuid(billId);
  if (!plain) return undefined;
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    if (companionIndexFor?.state !== state) {
      companionIndexFor = { state, index: companionIndex(activeCompanionPairs(state)) };
    }
    return companionIndexFor.index.get(plain);
  } catch (error) {
    logger.warn("Could not read the companion groups; answering with the bill's own stats", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return undefined;
  }
}

type FeedbackRow = Record<string, AttributeValue>;

/** The caller's own rows as the results gate read them. */
type CallerVotes = {
  /** INT-11: one of them is a vote (unlocksResults). */
  unlocked: boolean;
  /** The rows the read returned, with their bill id (FEEDBACK_SORT_KEY), votedAt and adultEligible. */
  rows: FeedbackRow[];
  /** Every key was read, so an id without a row holds none (false when a vote found stopped the read early). */
  complete: boolean;
};

/**
 * INT-11: whether the caller holds a vote (Yea, Nay or Abstain, as setFeedback stores it) under any
 * of these bill ids. An Abstain stored for a 1.0 or 1.1 dismissal (legacyDismiss) is not a vote.
 * Reads only the caller's own rows: userId is the authorizer's sub, never a request value. Throws
 * when the table is not configured, on a DynamoDB error, and when keys are still unprocessed after
 * the retries and no vote was found, so the handler fails closed. The same read gives S1 the time
 * of the caller's vote (callerVotedAtMs, callerGroupVotedAtMs); a vote found stops it, with any keys
 * left unread (complete false).
 */
async function readCallerVotes(userId: string, billIds: readonly string[]): Promise<CallerVotes> {
  if (!FEEDBACK_TABLE_NAME) throw new Error("FEEDBACK_TABLE_NAME is not configured; cannot check the caller's vote");
  let keys: Record<string, AttributeValue>[] = billIds.map((billId) => ({
    [FEEDBACK_PARTITION_KEY]: { S: userId },
    [FEEDBACK_SORT_KEY]: { S: billId },
  }));
  const rows: FeedbackRow[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const response = await db.send(
      new BatchGetItemCommand({
        RequestItems: {
          [FEEDBACK_TABLE_NAME]: {
            Keys: keys,
            // setFeedback's PutItem returns before the apps ask for the stats: an eventually consistent
            // read could still miss the vote it just stored.
            ConsistentRead: true,
            ProjectionExpression: "#feedback, #legacyDismiss, #billId, #votedAt, #adultEligible",
            ExpressionAttributeNames: {
              "#feedback": "feedback",
              "#legacyDismiss": LEGACY_DISMISS_ATTRIBUTE,
              "#billId": FEEDBACK_SORT_KEY,
              "#votedAt": "votedAt",
              "#adultEligible": "adultEligible",
            },
          },
        },
      }),
    );
    rows.push(...(response.Responses?.[FEEDBACK_TABLE_NAME] ?? []));
    keys = response.UnprocessedKeys?.[FEEDBACK_TABLE_NAME]?.Keys ?? [];
    if (rows.some(unlocksResults)) {
      return { unlocked: true, rows, complete: keys.length === 0 };
    }
    if (keys.length === 0) return { unlocked: false, rows, complete: true };
    if (attempt >= FEEDBACK_READ_MAX_ATTEMPTS) {
      throw new Error(`BatchGetItem left ${keys.length} vote lookups unprocessed after ${attempt} attempts`);
    }
    await sleep(FEEDBACK_READ_BACKOFF_MS * attempt);
  }
}

/** The caller's row stored under exactly this bill id, if the gate's read returned one. */
function callerRowOn(rows: readonly FeedbackRow[], billId: string): FeedbackRow | undefined {
  return rows.find((candidate) => candidate[FEEDBACK_SORT_KEY]?.S === billId);
}

/** The row's votedAt (ms) when it counts in stats (isCountedVote: adult-eligible, not a dismissal) and has one. */
function countedVotedAtMs(row: FeedbackRow | undefined): number | undefined {
  if (!row || !isCountedVote(row)) return undefined;
  const votedAtMs = Date.parse(row.votedAt?.S ?? "");
  return Number.isFinite(votedAtMs) ? votedAtMs : undefined;
}

/**
 * S1: when the caller's vote stored under exactly `billId` (the id the stats document is kept under)
 * was written, if it counts in that document (isCountedVote: adult-eligible, not a dismissal) and has
 * a votedAt. Otherwise undefined: no fold could add the caller's vote to these stats.
 */
function callerVotedAtMs(rows: readonly FeedbackRow[], billId: string): number | undefined {
  return countedVotedAtMs(callerRowOn(rows, billId));
}

/**
 * REL-48: when the caller's vote that the group's combined stats count was written. That is the row the
 * aggregator's fold (computeRawCompanionStats) keeps for them, the same one fetchCivicScore counts
 * (pickCountedRowPerGroup): their row on the first member, in memberGuids order (primary first), that
 * holds a vote (unlocksResults). A 1.0 or 1.1 dismissal is not one, so their row on the next member
 * counts. Only rows under the members' plain guids are in the group's stats (a legacy suffixed row is
 * not). Undefined when that row does not count (isCountedVote) or has no votedAt, when no member holds a
 * vote, and when the gate's read stopped with a member unread ahead of that row (the primary's, or the
 * other member's behind a dismissal on the primary): its row could be the one the group counts. A member
 * left unread after a vote read on an earlier one cannot change which row counts, so the vote stands.
 */
function callerGroupVotedAtMs(caller: CallerVotes, group: CompanionGroupV1): number | undefined {
  for (const member of new Set(group.memberGuids)) {
    const row = callerRowOn(caller.rows, member);
    if (!row) {
      if (!caller.complete) return undefined;
      continue;
    }
    if (unlocksResults(row)) return countedVotedAtMs(row);
  }
  return undefined;
}

/** "true" (any case): GET /bill-stats' forceRefresh, which apps 1.1 and 1.2 send after a saved vote. */
function parseForceRefresh(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

const generatedAtMs = (stats: BillStatsResponse | null): number => {
  const parsed = Date.parse(stats?.generatedAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

/** When a stored document's computation started reading votes (ms): its computedFrom, else its generatedAt. */
function storedReadStartMs(stored: StoredBillStats): number {
  const computedFrom = Date.parse(stored.computedFrom ?? "");
  return Number.isFinite(computedFrom) ? computedFrom : generatedAtMs(stored.stats);
}

type FreshStatsVoter = { userId: string; votedAtMs: number };

/** Whether the fold holds this caller's vote: stored before it settled, or a row it read. */
function foldHoldsVote(fold: FreshFold, voter: FreshStatsVoter): boolean {
  return (
    voter.votedAtMs <= fold.settledUntilMs ||
    (fold.recentVotes.get(voter.userId) ?? Number.NEGATIVE_INFINITY) >= voter.votedAtMs
  );
}

/** S1: what a fresh fold reads, one bill or one companion group (REL-48), and how its logs name it. */
type FreshFoldTarget = {
  /** The freshFolds key: the bill id, or the group's stats key. */
  key: string;
  /** Log fields that name it (never a user id). */
  logFields: Record<string, unknown>;
  tooManyRowsMessage: string;
  failedMessage: string;
  /** The fold: every row listed in recentVotes whose votedAt is later than recentAfterMs; null past the row cap. */
  read: (recentAfterMs: number) => Promise<FreshBillStats | null>;
};

function billFoldTarget(billId: string): FreshFoldTarget {
  return {
    key: billId,
    logFields: { billId },
    tooManyRowsMessage: "The bill has more vote rows than a fresh fold reads; answering with the stored stats",
    failedMessage: "Could not fold the bill's votes; answering with the stored stats",
    read: (recentAfterMs) =>
      computeFreshBillStats({
        db,
        tableName: FEEDBACK_TABLE_NAME!,
        userIdAttribute: FEEDBACK_PARTITION_KEY,
        sortKey: FEEDBACK_SORT_KEY,
        billIdIndexName: FEEDBACK_BILL_ID_INDEX_NAME!,
        billId,
        recentAfterMs,
        maxRows: FRESH_STATS_MAX_ROWS,
      }),
  };
}

function groupFoldTarget(group: CompanionGroupV1, statsKey: string): FreshFoldTarget {
  return {
    key: statsKey,
    logFields: { statsKey },
    tooManyRowsMessage:
      "The companion group has more vote rows than a fresh fold reads; answering with the stored group stats",
    failedMessage: "Could not fold the companion group's votes after a vote; answering with the stored group stats",
    read: (recentAfterMs) =>
      computeFreshCompanionStats({
        db,
        tableName: FEEDBACK_TABLE_NAME!,
        userIdAttribute: FEEDBACK_PARTITION_KEY,
        sortKey: FEEDBACK_SORT_KEY,
        billIdIndexName: FEEDBACK_BILL_ID_INDEX_NAME!,
        statsKey,
        memberGuids: group.memberGuids,
        recentAfterMs,
        maxRows: FRESH_STATS_MAX_ROWS,
      }),
  };
}

/**
 * Folds the target's votes now (S1). Keeps the fold as the target's last one when it read every row; a
 * failed attempt, or one past FRESH_STATS_MAX_ROWS, keeps the previous fold and only delays the next
 * attempt. Answers the new fold, or undefined.
 */
async function foldVotes(target: FreshFoldTarget, voter: FreshStatsVoter): Promise<FreshFold | undefined> {
  const startedAtMs = Date.now();
  const settledUntilMs = startedAtMs - VOTE_INDEX_SETTLE_MS;
  // The lowest settledUntilMs the fold can end with: every row after it is listed.
  const recentAfterMs = Math.min(settledUntilMs, voter.votedAtMs - 1);
  let nextFoldAtMs = startedAtMs + FRESH_STATS_MIN_INTERVAL_MS;
  let fold: FreshFold | undefined;
  // Every attempt reads the index, so every one counts (no user id on the line).
  emitEmbeddedMetric(RESULTS_METRIC_NAMESPACE, "FreshStatsFold", 1);
  try {
    const fresh = await target.read(recentAfterMs);
    if (fresh) {
      const readCallerRow = (fresh.recentVotes.get(voter.userId) ?? Number.NEGATIVE_INFINITY) >= voter.votedAtMs;
      fold = {
        startedAtMs,
        stats: fresh.stats,
        // A fold that missed the caller's row holds nothing from their votedAt on, however late it ran.
        settledUntilMs: readCallerRow ? settledUntilMs : recentAfterMs,
        recentVotes: fresh.recentVotes,
      };
    } else {
      nextFoldAtMs = startedAtMs + FRESH_STATS_MAX_AGE_MS;
      logger.warn(target.tooManyRowsMessage, { ...target.logFields, maxRows: FRESH_STATS_MAX_ROWS });
    }
  } catch (error) {
    logger.warn(target.failedMessage, { ...target.logFields, error });
  }
  const previous = freshFolds.get(target.key)?.fold;
  freshFolds.delete(target.key);
  freshFolds.set(target.key, { fold: fold ?? previous, nextFoldAtMs });
  while (freshFolds.size > FRESH_STATS_MAX_ENTRIES) {
    freshFolds.delete(freshFolds.keys().next().value!);
  }
  return fold;
}

/**
 * S1: whether a forceRefresh=true request may be answered with a fold, from what is stored: not when the
 * vote is FRESH_STATS_VOTE_MAX_AGE_MS old or more, when the stored document's read started at least
 * VOTE_INDEX_SETTLE_MS after the vote (it holds it), when the stored stats hold more than
 * FRESH_STATS_MAX_VOTES votes (or a count that is not a number), or when the index is not configured.
 */
function freshFoldAllowed(voter: FreshStatsVoter, storedStartMs: number, storedVotes: number): boolean {
  if (Date.now() - voter.votedAtMs >= FRESH_STATS_VOTE_MAX_AGE_MS) return false;
  if (storedStartMs - VOTE_INDEX_SETTLE_MS >= voter.votedAtMs) return false;
  if (!(storedVotes <= FRESH_STATS_MAX_VOTES)) return false;
  return Boolean(FEEDBACK_TABLE_NAME && FEEDBACK_BILL_ID_INDEX_NAME);
}

/**
 * S1: this container's fold of the target when it holds the caller's vote, else a new fold (none before
 * the target's nextFoldAtMs). When that leaves no fold holding the vote, the last fold if it started
 * after the stored document's read (storedStartMs). Undefined when there is none.
 */
async function freshFoldStats(
  target: FreshFoldTarget,
  storedStartMs: number,
  voter: FreshStatsVoter,
): Promise<BillStatsResponse | undefined> {
  const state = freshFolds.get(target.key);
  let fold = state?.fold && Date.now() - state.fold.startedAtMs < FRESH_STATS_MAX_AGE_MS ? state.fold : undefined;
  if (fold && foldHoldsVote(fold, voter)) return fold.stats;
  if (!state || Date.now() >= state.nextFoldAtMs) {
    fold = (await foldVotes(target, voter)) ?? fold;
  }
  return fold && fold.startedAtMs > storedStartMs ? fold.stats : undefined;
}

/**
 * S1: the stats for a forceRefresh=true request on scope=bill from a caller whose counted vote on the
 * bill was stored at voter.votedAtMs. The stored document unless freshFoldAllowed. Else this container's
 * fold of the bill when it holds the vote, else a new fold; when that leaves no fold holding the vote,
 * the newer of the last fold and the stored document. Null when there is neither.
 */
async function statsWithCallerVote(
  billId: string,
  stored: StoredBillStats | null,
  voter: FreshStatsVoter,
): Promise<BillStatsResponse | null> {
  const storedStartMs = stored ? storedReadStartMs(stored) : Number.NEGATIVE_INFINITY;
  if (!freshFoldAllowed(voter, storedStartMs, stored ? stored.stats.totals?.votes : 0)) return stored?.stats ?? null;
  return (await freshFoldStats(billFoldTarget(billId), storedStartMs, voter)) ?? stored?.stats ?? null;
}

/**
 * REL-48: for a forceRefresh=true request on scope=companions from a caller whose vote the group counts
 * was stored at voter.votedAtMs, a fold of the group's votes (freshFoldStats), when freshFoldAllowed by
 * the stored group document and the vote cap. The cap is on the larger of the group document's votes
 * and the members' own documents' votes added together: those are the rows the fold reads. Undefined
 * when no fold applies or none is newer than the group document: the request is then answered as one
 * without forceRefresh.
 */
async function groupStatsWithCallerVote(
  group: CompanionGroupV1,
  statsKey: string,
  stored: StoredBillStats | null,
  memberStored: readonly (StoredBillStats | null)[],
  voter: FreshStatsVoter,
): Promise<BillStatsResponse | undefined> {
  const storedStartMs = stored ? storedReadStartMs(stored) : Number.NEGATIVE_INFINITY;
  const membersVotes = memberStored.reduce((sum, member) => sum + (member ? member.stats.totals?.votes : 0), 0);
  const storedVotes = Math.max(stored ? stored.stats.totals?.votes : 0, membersVotes);
  if (!freshFoldAllowed(voter, storedStartMs, storedVotes)) return undefined;
  return freshFoldStats(groupFoldTarget(group, statsKey), storedStartMs, voter);
}

/**
 * The group's combined stats. With `voter` (REL-48, forceRefresh after a vote), first a fold that holds
 * their vote (groupStatsWithCallerVote). Otherwise the stored group document while it is at least as new
 * as every member's own stats, else a fold of the members' votes (not stored). When no fold can be had,
 * the stored document however old, or null.
 */
async function companionGroupStats(
  group: CompanionGroupV1,
  voter?: FreshStatsVoter,
): Promise<BillStatsResponse | null> {
  const statsKey = companionStatsKey(group);
  const [stored, ...memberStored] = await Promise.all(
    [statsKey, ...group.memberGuids].map((billId) =>
      readStoredStats({ db, statsTableName: STATS_TABLE_NAME, statsPartitionKey: STATS_PARTITION_KEY, billId }),
    ),
  );
  if (voter) {
    const fresh = await groupStatsWithCallerVote(group, statsKey, stored, memberStored, voter);
    if (fresh) return fresh;
  }

  const cached = stored?.stats ?? null;
  const memberStats = memberStored.map((member) => member?.stats ?? null);
  if (cached && memberStats.every((member) => generatedAtMs(member) <= generatedAtMs(cached))) return cached;
  if (cached) {
    logger.info("The stored companion group stats are older than a member's; folding the votes again", {
      statsKey,
      groupGeneratedAt: cached.generatedAt,
    });
  }

  const now = Date.now();
  const computed = computedGroupStats.get(statsKey);
  if (computed && now - computed.computedAtMs < COMPUTED_GROUP_STATS_MAX_AGE_MS) return computed.stats;

  if (!FEEDBACK_TABLE_NAME || !FEEDBACK_BILL_ID_INDEX_NAME) {
    logger.warn("No current companion group stats and no feedback index configured to fold them", { statsKey });
    return cached;
  }

  try {
    const stats = applyStatsSampleFloor(
      await computeRawCompanionStats({
        db,
        tableName: FEEDBACK_TABLE_NAME,
        userIdAttribute: FEEDBACK_PARTITION_KEY,
        sortKey: FEEDBACK_SORT_KEY,
        billIdIndexName: FEEDBACK_BILL_ID_INDEX_NAME,
        statsKey,
        memberGuids: group.memberGuids,
      }),
    );
    computedGroupStats.delete(statsKey);
    computedGroupStats.set(statsKey, { stats, computedAtMs: now });
    while (computedGroupStats.size > COMPUTED_GROUP_STATS_MAX_ENTRIES) {
      computedGroupStats.delete(computedGroupStats.keys().next().value!);
    }
    return stats;
  } catch (error) {
    logger.warn(
      cached
        ? "Could not fold the companion group's votes; answering with the older stored group stats"
        : "Could not fold the companion group's votes; answering with the bill's own stats",
      { statsKey, error },
    );
    return cached;
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const claims = event?.requestContext?.authorizer?.claims || event?.requestContext?.authorizer?.jwt?.claims;
    const userId = claims?.sub;

    if (!userId) {
      return json(401, { message: "Unauthorized (missing authorizer claims)" });
    }

    const billId = event?.queryStringParameters?.billId?.trim();
    if (!billId) {
      return json(400, { error: "Missing billId" });
    }

    const scope = parseScope(event?.queryStringParameters?.scope);
    if (!scope) {
      return json(400, { error: "Invalid scope" });
    }

    // INT-11: every aggregate of Billboard users' votes is for a caller who has voted Yea, Nay or
    // Abstain on this bill, or on a member of its companion group (a 1.0 or 1.1 dismissal stored as
    // Abstain does not count), and nothing is read before that is known. Only a bill guid is accepted: a stats key such as COMPANIONS#<House>#<Senate> would
    // otherwise be read as is. The row is looked up under the group's members (a vote on either
    // unlocks both scopes), the plain guid setFeedback stores, and the requested id when it differs
    // (legacy suffixed rows). When the groups cannot be read the bill alone is checked: stricter, never
    // looser. A read that fails answers 500, never the stats.
    const plain = plainBillGuid(billId);
    if (!plain) {
      return json(400, { error: "INVALID_BILL_ID" });
    }
    const group = await companionGroupOf(billId);
    let caller: CallerVotes;
    try {
      caller = await readCallerVotes(userId, [...new Set([...(group?.memberGuids ?? []), plain, billId])]);
    } catch (error) {
      logger.error("Could not read the caller's vote; not serving the bill stats", { error });
      // An answer, not a thrown error, so the function's Errors alarm never counts it: this metric is what
      // Billboard-BillStats-ResultsGateReadFailed watches (RUNBOOK 17.4).
      emitEmbeddedMetric(RESULTS_METRIC_NAMESPACE, "ResultsGateReadFailed", 1);
      return json(500, { error: "Internal server error" });
    }
    if (!caller.unlocked) {
      emitEmbeddedMetric(RESULTS_METRIC_NAMESPACE, "ResultsLocked", 1);
      return json(403, { error: "RESULTS_LOCKED", message: "Vote or abstain on this bill to see its results." });
    }

    const forceRefresh = parseForceRefresh(event?.queryStringParameters?.forceRefresh);

    // scope=companions on a grouped bill: the group's combined votes, one per person. An ungrouped
    // bill, or combined stats that cannot be had, get the bill's own stats without companionBillIds.
    // REL-48: with forceRefresh=true, stats that hold the caller's vote on either member even before
    // billStatsAggregator has stored it in the group's document (callerGroupVotedAtMs,
    // groupStatsWithCallerVote). Apps 1.1 and 1.2 ask this for every grouped bill, under its primary.
    if (scope === "companions") {
      const groupVotedAtMs = group && forceRefresh ? callerGroupVotedAtMs(caller, group) : undefined;
      const stats = group
        ? await companionGroupStats(
            group,
            groupVotedAtMs === undefined ? undefined : { userId, votedAtMs: groupVotedAtMs },
          )
        : null;
      if (group && stats) {
        return served(stats, { billId, companionBillIds: [...group.memberGuids] });
      }
    }

    const stored = await readStoredStats({
      db,
      statsTableName: STATS_TABLE_NAME,
      statsPartitionKey: STATS_PARTITION_KEY,
      billId,
    });

    // S1: with forceRefresh=true, stats that hold the caller's own vote even before billStatsAggregator
    // has stored it (statsWithCallerVote). Without it, or with no counted vote of the caller's under this
    // id (a vote on the companion only, a legacy suffixed id, a row that is not adult-eligible), the
    // stored document as is.
    const votedAtMs = forceRefresh ? callerVotedAtMs(caller.rows, billId) : undefined;
    const stats =
      votedAtMs === undefined
        ? (stored?.stats ?? null)
        : await statsWithCallerVote(billId, stored, { userId, votedAtMs });

    // Read-only handler: return empty stats when aggregate is not yet available.
    return served(stats ?? createEmptyBillStats(billId));
  } catch (error) {
    console.error("fetchBillStats failed", error);
    return json(500, { error: "Internal server error" });
  }
}

export default { handler };
