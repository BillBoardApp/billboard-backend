import { type AttributeValue, DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { activeCompanionPairs, BillCompanionDao, type CompanionGroupsState } from "../../adapters/billCompanionDao";
import { CIVIC_PROFILE_AXES } from "../../models/bill";
import { isLegacyDismissRow, LEGACY_DISMISS_ATTRIBUTE } from "../../models/feedback";
import { companionIndex, pickCountedRowPerGroup, type CompanionIndex } from "../../shared/billCompanions";
import {
  CIVIC_PROFILE_MIN_READY_THEMES,
  CIVIC_PROFILE_MIN_THEME_VOTES,
  civicProfileReadiness,
  civicProfileThemes,
  civicProfileWindow,
  parseCivicProfileMap,
} from "../../shared/civicProfileReadiness";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY ?? "billId";
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME;
const MANIFEST_PRIMARY_KEY = process.env.MANIFEST_PRIMARY_KEY ?? "pk";
const MANIFEST_SORT_KEY = process.env.MANIFEST_SORT_KEY ?? "sk";
const MANIFEST_GUID_LOOKUP_PK = process.env.MANIFEST_GUID_LOOKUP_PK ?? "BILL_GUID";

// UX-32: the window (the 100 most recent Yea or Nay votes on bills with theme scores), the floor of 8 votes a theme
// (a theme's label never rests on a few AI-scored bills; members keep 3) and readiness (25 votes and 3 themes at 8,
// project decision 2026-10-29, "Keep it locked") are shared/civicProfileReadiness.ts, which the Civic Compass honor follows too.
// A theme under the floor is left out of `axes`, as before UX-32, and both apps show it as "No signal" or "Not
// enough data".

// APPF-23: a user's votes on the members of a companion group count once (the primary's row wins,
// a vote on the other member alone still counts), as in fetchCivicScore. The groups are the ones
// PublishBillsManifest last published (none while they are turned off), read at most every 60 s from
// MANIFEST_TABLE_NAME. With no groups every vote counts as before.
const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";

const db = new DynamoDBClient({});
const companionDao = MANIFEST_TABLE_NAME?.trim() ? new BillCompanionDao(db) : null;
let companionIndexFor: { state: CompanionGroupsState | null; index: CompanionIndex } | undefined;

interface VoteWithProfile {
  feedback: "yea" | "nay";
  votedAt: string;
  civicProfile: Record<string, number>;
  themes: string[];
}

type BillMetadataSnapshot = {
  civicProfile?: Record<string, number>;
};

function normalizeFeedback(feedback: string): "yea" | "nay" | "abstain" | null {
  const normalized = feedback.trim().toLowerCase();
  if (normalized === "yea") return "yea";
  if (normalized === "nay") return "nay";
  if (normalized === "abstain") return "abstain";
  return null;
}

/** The published companion groups; empty when they are off, not configured or cannot be read. */
async function loadCompanionIndex(): Promise<CompanionIndex> {
  if (!companionDao) return new Map();
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    if (companionIndexFor?.state !== state) {
      companionIndexFor = { state, index: companionIndex(activeCompanionPairs(state)) };
    }
    return companionIndexFor.index;
  } catch (error) {
    logger.warn("fetchCivicProfile could not read the companion groups; counting every vote", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return new Map();
  }
}

/**
 * One vote row per companion group: of a user's vote rows (Yea, Nay or Abstain) on a group's members,
 * the primary's wins, otherwise the first; suffixed bill ids count as their plain guid. Rows that hold
 * no vote or have no bill id are kept as they are, and so is an Abstain stored for a 1.0 or 1.1 Updates
 * dismissal (INT-11, models/feedback.ts): it is not a vote, so it never hides the user's vote on the other
 * member (and, as an Abstain, it is never counted). Unchanged when there are no groups. So a vote on the
 * primary after one on the other member replaces that vote in the window instead of adding one, and an
 * Abstain there hides it: UX-32's "Vote on N more bills" can then ask for 1 more (civicProfileReadiness.ts).
 */
async function onePerCompanionGroup(
  items: Record<string, AttributeValue>[],
): Promise<Record<string, AttributeValue>[]> {
  const billIdOf = (item: Record<string, AttributeValue>): string | undefined => {
    const billId = item[SORT_KEY]?.S;
    const feedback = typeof item.feedback?.S === "string" ? normalizeFeedback(item.feedback.S) : null;
    return typeof billId === "string" && billId.trim() && feedback && !isLegacyDismissRow(item) ? billId : undefined;
  };
  if (items.filter((item) => billIdOf(item)).length < 2) return items;

  const index = await loadCompanionIndex();
  if (index.size === 0) return items;

  // Rows outside the dedupe get a key no bill id can have, so each is kept.
  const keyed = items.map((item, position) => ({ item, key: billIdOf(item) ?? `\u0000row${position}` }));
  return pickCountedRowPerGroup(keyed, (row) => row.key, index).map((row) => row.item);
}

/**
 * Resolve civic profile metadata for legacy feedback rows that predate the
 * denormalized civicProfile snapshot on UserFeedback.
 */
async function lookupBillMetadata(billId: string): Promise<BillMetadataSnapshot> {
  if (!MANIFEST_TABLE_NAME) return {};

  try {
    const lookup = await db.send(
      new GetItemCommand({
        TableName: MANIFEST_TABLE_NAME,
        Key: {
          [MANIFEST_PRIMARY_KEY]: { S: MANIFEST_GUID_LOOKUP_PK },
          [MANIFEST_SORT_KEY]: { S: billId },
        },
        ProjectionExpression: "manifestSk",
      }),
    );
    const manifestSk = lookup.Item?.manifestSk?.S;
    if (!manifestSk) return {};

    const result = await db.send(
      new GetItemCommand({
        TableName: MANIFEST_TABLE_NAME,
        Key: {
          [MANIFEST_PRIMARY_KEY]: { S: "BILL" },
          [MANIFEST_SORT_KEY]: { S: manifestSk },
        },
        ProjectionExpression: "civicProfile",
      }),
    );

    return {
      civicProfile: parseCivicProfileMap(result.Item?.civicProfile) ?? undefined,
    };
  } catch (err) {
    console.warn("Failed to look up bill civic profile metadata:", billId, err);
    return {};
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const claims = event?.requestContext?.authorizer?.claims || event?.requestContext?.authorizer?.jwt?.claims;

  const userId = claims?.sub;

  if (!userId) {
    return {
      statusCode: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Unauthorized" }),
    };
  }

  try {
    // Fetch all votes for the user
    const items: Record<string, AttributeValue>[] = [];
    let startKey: Record<string, AttributeValue> | undefined;

    do {
      const result = await db.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: {
            "#pk": PARTITION_KEY,
            "#sk": SORT_KEY,
            "#legacyDismiss": LEGACY_DISMISS_ATTRIBUTE,
          },
          ExpressionAttributeValues: { ":pk": { S: userId } },
          ProjectionExpression: "feedback, votedAt, civicProfile, #sk, #legacyDismiss",
          ExclusiveStartKey: startKey,
        }),
      );

      items.push(...(result.Items ?? []));
      startKey = result.LastEvaluatedKey;
    } while (startKey);

    const votes: VoteWithProfile[] = [];
    const manifestMetadataCache = new Map<string, BillMetadataSnapshot>();

    for (const item of await onePerCompanionGroup(items)) {
      const feedback = item.feedback?.S;
      const votedAt = item.votedAt?.S;
      let civicProfile = parseCivicProfileMap(item.civicProfile);
      const billId = item[SORT_KEY]?.S;

      if (!feedback || !votedAt) continue;

      const normalizedFeedback = normalizeFeedback(feedback);
      // Treat abstain as non-voted for civic profile metrics.
      if (normalizedFeedback !== "yea" && normalizedFeedback !== "nay") continue;

      if (!civicProfile && billId) {
        let billMetadata = manifestMetadataCache.get(billId);
        if (!billMetadata) {
          billMetadata = await lookupBillMetadata(billId);
          manifestMetadataCache.set(billId, billMetadata);
        }
        civicProfile = billMetadata.civicProfile ?? null;
      }

      if (!civicProfile) continue;

      votes.push({ feedback: normalizedFeedback, votedAt, civicProfile, themes: civicProfileThemes(civicProfile) });
    }

    // The most recent 100 Yea or Nay votes (all of `votes` are), newest first: the window of every count below.
    const recentVotes = civicProfileWindow(votes);
    const totalVotesWithProfile = votes.length;
    const readiness = civicProfileReadiness(recentVotes);

    // Compute axis averages
    const axisSums: Record<string, number> = {};
    for (const vote of recentVotes) {
      const sign = vote.feedback === "yea" ? 1 : -1;
      for (const axis of vote.themes) axisSums[axis] = (axisSums[axis] ?? 0) + sign * vote.civicProfile[axis];
    }

    // Average and normalize from [-1, 1] to [0, 1]
    const axes: Record<string, number> = {};
    for (const axis of CIVIC_PROFILE_AXES) {
      const count = readiness.themeVotes[axis];
      // Counted in the same window as votesUsed ("Based on N votes"), so a theme never has more votes than that.
      if (count < CIVIC_PROFILE_MIN_THEME_VOTES) continue;
      const avg = axisSums[axis] / count;
      // Normalize: (-1..1) -> (0..1)
      axes[axis] = Math.max(0, Math.min(1, (avg + 1) / 2));
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        axes,
        // All recent votes are Yea or Nay by construction.
        votesUsed: readiness.votesUsed,
        totalVotesWithProfile,
        // While locked, votesUsed plus the larger of the votes' and the 3rd theme's shortfalls (at least 1), so both
        // apps' "Vote on N more bills" (N = minVotesRequired - votesUsed) never says 0 and, under the 100-vote cap,
        // never asks for more after a vote on a bill not yet in the window (no jump at 25 votes). A vote on the primary
        // of a pair the user voted on through the other member replaces that row (onePerCompanionGroup), so it can ask
        // for 1 more (civicProfileReadiness.ts). 25 for a new user, and when ready.
        minVotesRequired: readiness.minVotesRequired,
        // 25 votes and 3 themes at 8: a ready chart always has a shape (both apps draw one from 3 scored themes).
        isReady: readiness.isReady,
        // UX-32, additive (app 1.1 ignores them): what holds the profile, for app 1.2 to explain a theme lock.
        lockedBy: readiness.lockedBy,
        themesReady: readiness.themesReady,
        minThemesRequired: CIVIC_PROFILE_MIN_READY_THEMES,
        minThemeVotes: CIVIC_PROFILE_MIN_THEME_VOTES,
      }),
    };
  } catch (err) {
    console.error("fetchCivicProfile error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
