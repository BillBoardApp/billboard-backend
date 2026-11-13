import { DynamoDBClient, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { activeCompanionPairs, BillCompanionDao, type CompanionGroupsState } from "../../adapters/billCompanionDao";
import { canonicalSubCategory } from "../../models/categories";
import {
  FIRST_VOTED_AT_ATTRIBUTE,
  firstVoteTimeOf,
  isLegacyDismissRow,
  LEGACY_DISMISS_ATTRIBUTE,
} from "../../models/feedback";
import { companionIndex, pickCountedRowPerGroup, type CompanionIndex } from "../../shared/billCompanions";
import { civicProfileThemes, parseCivicProfileMap } from "../../shared/civicProfileReadiness";
import { resolveCurrentRank, resolveNextRank } from "../../shared/civicProgression";
import {
  civicStanding,
  readCivicRecordRow,
  recordChanged,
  writeCivicRecord,
  type CivicRecordRow,
  type CivicRecordTable,
  type CivicStanding,
  type CountedVote,
} from "../../shared/civicRecord";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY ?? "billId";

// UX-31: the Civic Score record (the parts of the score that never go down, the honors earned and the switch to
// Eastern days) lives on the caller's UserPII row (shared/civicRecord.ts). Without PII_TABLE_NAME (tests, a local
// run) every read seeds the record afresh and keeps nothing.
const PII_TABLE_NAME = process.env.PII_TABLE_NAME?.trim() || undefined;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY?.trim() || "userId";
const CIVIC_SCORE_METRIC_NAMESPACE = "BillBoard/CivicScore";
/** Writes of a record that rose, the first included; a second only after a concurrent read raised it first. */
const RECORD_WRITE_ATTEMPTS = 2;

// APPF-23: a user's votes on the members of a companion group count once (the primary's row wins,
// a vote on the other member alone still counts). The groups are the ones PublishBillsManifest last
// published (none while they are turned off), read at most every 60 s; they need MANIFEST_TABLE_NAME,
// since TABLE_NAME here is the feedback table. With no groups every vote counts as before.
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME?.trim();
const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";

const db = new DynamoDBClient({});
const companionDao = MANIFEST_TABLE_NAME ? new BillCompanionDao(db) : null;
const recordTable: CivicRecordTable | null = PII_TABLE_NAME
  ? { db, tableName: PII_TABLE_NAME, partitionKey: PII_PARTITION_KEY }
  : null;
let companionIndexFor: { state: CompanionGroupsState | null; index: CompanionIndex } | undefined;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const claims = event?.requestContext?.authorizer?.claims || event?.requestContext?.authorizer?.jwt?.claims;

  const userId = claims?.sub;

  if (!userId) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Unauthorized (missing authorizer claims)" }),
    };
  }

  try {
    // A record that cannot be read fails the request (500): both apps keep the score they show, where answering
    // without the record could show a lower one.
    const [items, row] = await Promise.all([
      queryAllVotes(userId),
      recordTable ? readRecord(recordTable, userId) : Promise.resolve(null),
    ]);
    const { items: deduped, groupsRead } = await onePerCompanionGroup(items);
    const votes = countedVotes(deduped);
    const voteRows = items.filter(holdsOrHeldVote).length;
    const nowMs = Date.now();

    let standing = civicStanding(votes, voteRows, row?.exists ? row.record : null, nowMs);
    // Kept only from a full count: a read that could not apply the companion groups counts a pair twice.
    if (recordTable && row && groupsRead) {
      standing = await keepRecord(recordTable, userId, votes, voteRows, row, standing, nowMs);
    }

    const { body } = standing;
    const rank = resolveCurrentRank(body.civicScore);
    const nextRank = resolveNextRank(body.civicScore);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        civicScore: body.civicScore,
        totalVotes: body.totalVotes,
        currentStreak: body.currentStreak,
        longestStreak: body.longestStreak,
        lastVotedAt: body.lastVotedAt,
        recentVoteDays: body.recentVoteDays,
        voteScore: body.voteScore,
        streakBonus: body.streakBonus,
        honorBonus: body.honorBonus,
        coverageAreaCount: body.coverageAreaCount,
        rank,
        nextRank,
        scoreToNextRank: nextRank ? nextRank.minScore - body.civicScore : 0,
        honors: body.honors,
      }),
    };
  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

// ── Query all votes for a user ──────────────────────────────────────────

/** A feedback-table row as DynamoDB returns it. */
type VoteItem = Record<string, AttributeValue>;

async function queryAllVotes(userId: string): Promise<VoteItem[]> {
  const items: VoteItem[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const resp = await db.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: {
          "#pk": PARTITION_KEY,
          "#sk": SORT_KEY,
          "#legacyDismiss": LEGACY_DISMISS_ATTRIBUTE,
          "#firstVotedAt": FIRST_VOTED_AT_ATTRIBUTE,
        },
        ExpressionAttributeValues: { ":pk": { S: userId } },
        // The bill id (sort key) and the INT-11 dismissal mark are read for the companion-group dedupe; UX-31 counts
        // a vote's day by its first-vote time.
        ProjectionExpression:
          "feedback, votedAt, #firstVotedAt, civicProfile, lifeAreas, subCategories, #sk, #legacyDismiss",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (resp.Items) {
      items.push(...resp.Items);
    }

    exclusiveStartKey = resp.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

// ── The Civic Score record (UX-31) ──────────────────────────────────────

/**
 * The caller's record, or a thrown error after the log line and the metric CivicRecordReadFailed: the request then
 * answers 500, which the alias Errors alarm does not count (the handler returns it), so the metric has its own alarm
 * (Billboard-CivicScore-RecordFailed, RUNBOOK 19.6).
 */
async function readRecord(table: CivicRecordTable, userId: string): Promise<CivicRecordRow> {
  try {
    return await readCivicRecordRow(table, userId);
  } catch (error) {
    logger.error("fetchCivicScore could not read the Civic Score record; answering 500", { error });
    emitEmbeddedMetric(CIVIC_SCORE_METRIC_NAMESPACE, "CivicRecordReadFailed", 1);
    throw error;
  }
}

/**
 * Stores the record when this read changed it: a user's first read after UX-31 (the seed), a new vote, votes counted
 * that fell, a longer best streak, a new honor. Never on a row that is missing or being deleted. A concurrent read
 * that raised the record first makes the write fail its condition: the standing is then recomputed from the record it
 * stored and written again once. A failure leaves the record as it was; the answer is still the standing, which is
 * never below it.
 */
async function keepRecord(
  table: CivicRecordTable,
  userId: string,
  votes: CountedVote[],
  voteRows: number,
  row: CivicRecordRow,
  standing: CivicStanding,
  nowMs: number,
): Promise<CivicStanding> {
  let current = row;
  let latest = standing;
  for (let attempt = 0; attempt < RECORD_WRITE_ATTEMPTS; attempt++) {
    if (!current.exists || current.deleting || !recordChanged(current.record, latest.record)) return latest;
    try {
      const write = await writeCivicRecord(table, userId, latest.record, new Date(nowMs).toISOString());
      if (write.outcome === "written") return latest;
      current = write.row;
      if (current.exists && !current.deleting) latest = civicStanding(votes, voteRows, current.record, nowMs);
    } catch (error) {
      logger.warn("fetchCivicScore could not store the Civic Score record; answering from the one it read", { error });
      emitEmbeddedMetric(CIVIC_SCORE_METRIC_NAMESPACE, "CivicRecordWriteFailed", 1);
      return latest;
    }
  }
  if (current.exists && !current.deleting && recordChanged(current.record, latest.record)) {
    logger.warn("fetchCivicScore left the Civic Score record as it was after concurrent writes");
    emitEmbeddedMetric(CIVIC_SCORE_METRIC_NAMESPACE, "CivicRecordWriteFailed", 1);
  }
  return latest;
}

// ── Companion groups (APPF-23) ──────────────────────────────────────────

/**
 * A row that holds a vote: Yea, Nay or Abstain (the vote a group's primary row can stand for). An Abstain stored for
 * a 1.0 or 1.1 Updates dismissal (INT-11, models/feedback.ts) is not one, so it never hides the user's vote on the
 * other member, and it is not counted (UX-31 counts Yea, Nay and Abstain alike).
 */
function isVoteRow(item: VoteItem): boolean {
  if (isLegacyDismissRow(item)) return false;
  const normalized = normalizedFeedback(item);
  return normalized === "yea" || normalized === "nay" || normalized === "abstain";
}

/**
 * A row that holds a vote or held one: a vote row, or a 1.0 or 1.1 dismissal written over a vote, which keeps the
 * vote's firstVotedAt (models/feedback.ts). Rows are only deleted with the account, so these only grow: the record
 * adds a vote only when they do (shared/civicRecord.ts).
 */
function holdsOrHeldVote(item: VoteItem): boolean {
  const first = item[FIRST_VOTED_AT_ATTRIBUTE];
  return isVoteRow(item) || (typeof first?.S === "string" && first.S.length > 0) || first?.NULL === true;
}

function normalizedFeedback(item: VoteItem): string {
  return typeof item.feedback?.S === "string" ? item.feedback.S.trim().toLowerCase() : "";
}

/**
 * The published companion groups; empty when they are off or not configured. When they cannot be read, the ones this
 * container read last (UX-31: so one answer does not count a pair twice in "Bills voted", the days and the honors,
 * and the next one less), or none (every vote counts); `read` is then false.
 */
async function loadCompanionIndex(): Promise<{ index: CompanionIndex; read: boolean }> {
  if (!companionDao) return { index: new Map(), read: true };
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    if (companionIndexFor?.state !== state) {
      companionIndexFor = { state, index: companionIndex(activeCompanionPairs(state)) };
    }
    return { index: companionIndexFor.index, read: true };
  } catch (error) {
    logger.warn(
      companionIndexFor
        ? "fetchCivicScore could not read the companion groups; using the ones it read last"
        : "fetchCivicScore could not read the companion groups; counting every vote",
      { error },
    );
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return { index: companionIndexFor?.index ?? new Map(), read: false };
  }
}

/**
 * One vote row per companion group: of a user's vote rows on a group's members, the primary's wins,
 * otherwise the first; suffixed bill ids count as their plain guid. Rows that hold no vote or have no
 * bill id are kept as they are. Unchanged when there are no groups; `groupsRead` is false when they could
 * not be read (loadCompanionIndex), so nothing is stored from the count.
 */
async function onePerCompanionGroup(items: VoteItem[]): Promise<{ items: VoteItem[]; groupsRead: boolean }> {
  const billIdOf = (item: VoteItem): string | undefined => {
    const billId = item[SORT_KEY]?.S;
    return typeof billId === "string" && billId.trim() && isVoteRow(item) ? billId : undefined;
  };
  if (items.filter((item) => billIdOf(item)).length < 2) return { items, groupsRead: true };

  const { index, read } = await loadCompanionIndex();
  if (index.size === 0) return { items, groupsRead: read };

  // Rows outside the dedupe get a key no bill id can have, so each is kept.
  const keyed = items.map((item, position) => ({ item, key: billIdOf(item) ?? `\u0000row${position}` }));
  return { items: pickCountedRowPerGroup(keyed, (row) => row.key, index).map((row) => row.item), groupsRead: read };
}

// ── Counted votes ───────────────────────────────────────────────────────

function parseStringListAttribute(attribute: AttributeValue | undefined): string[] {
  return Array.isArray(attribute?.L)
    ? attribute.L.map((entry: AttributeValue | undefined) => entry?.S).filter(
        (value: unknown): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
}

/**
 * The vote's life areas and sub-categories, one key per area. A vote row keeps the labels its bill had when the vote
 * was cast, so a former sub-category name (LLM-10) counts as its current one: "Social Justice" on an old vote and
 * "Civil Rights and Liberties" on a new one are one area. The stored rows are not rewritten.
 */
function coverageAreasOf(item: VoteItem): string[] {
  const subCategories = parseStringListAttribute(item.subCategories).map((name) => canonicalSubCategory(name.trim()));
  return [...parseStringListAttribute(item.lifeAreas), ...subCategories].map((area) => area.trim().toLowerCase());
}

/**
 * The themes the row's own civic profile snapshot scores, or null when it carries none (UX-32: Civic Compass). Parsed
 * as GET /civic-profile parses it; no manifest read here, since this runs on every tab header.
 */
function civicProfileThemesOf(item: VoteItem): string[] | null {
  const civicProfile = parseCivicProfileMap(item.civicProfile);
  return civicProfile ? civicProfileThemes(civicProfile) : null;
}

/** The votes the score counts (UX-31): every Yea, Nay and Abstain that is not a 1.0 or 1.1 dismissal. */
function countedVotes(items: VoteItem[]): CountedVote[] {
  return items.filter(isVoteRow).map((item) => ({
    feedback: normalizedFeedback(item) as CountedVote["feedback"],
    firstVotedAt: firstVoteTimeOf(item),
    votedAt: typeof item.votedAt?.S === "string" ? item.votedAt.S : null,
    areas: coverageAreasOf(item),
    civicProfileThemes: civicProfileThemesOf(item),
  }));
}

export default { handler };
