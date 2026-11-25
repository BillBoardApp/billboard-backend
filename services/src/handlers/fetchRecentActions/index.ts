import { type AttributeValue, BatchGetItemCommand, DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  activeCompanionPairs,
  BillCompanionDao,
  billCompanionConfigFromEnv,
  type CompanionGroupsState,
} from "../../adapters/billCompanionDao";
import { BillStorage } from "../../adapters/billStorage";
import { buildProcessedBillRootGuidKey } from "../../adapters/processedBillKeys";
import type { RecentActionsV1, RecentActionVoteV1 } from "../../contracts";
import { isLegacyDismissRow, LEGACY_DISMISS_ATTRIBUTE } from "../../models/feedback";
import { getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";
import { companionIndex, plainBillGuid, type CompanionIndex } from "../../shared/billCompanions";
import { addDays } from "../../shared/civicDays";
import { mapWithConcurrency } from "../../shared/concurrency";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";
import { sleep } from "../../shared/retry";
import {
  buildRecentActionItems,
  DEFAULT_RECENT_ACTIONS_WINDOW_DAYS,
  recentActionsWindowStart,
  type CallerVote,
} from "./recentActions";

/*
 * GET /recent-actions (UX-35): the Updates tab's list of the caller's bills with an action in Congress in the last
 * RECENT_ACTIONS_WINDOW_DAYS days (recentActions.ts says what a row holds). Everything is read at request time, and only
 * the caller's own rows: their votes (a Query of their UserFeedback partition) and Watch rows (a Query of their
 * UserPreferences partition), keyed by the authorizer's sub. Then, for those bills and their companions, the manifest's
 * BILL_GUID lookup rows (BatchGetItem), whose updatedAt keeps only bills that moved in the window (a prefilter: the
 * action date decides), and at most MAX_BILL_READS processed bills from S3, BILL_READ_CONCURRENCY at a time, the most
 * recently moved first. A companion group's members are all read when either moved, since the member whose status the
 * group shows may not have moved. A bill with no processed copy is skipped. Nothing is written.
 */

const FEEDBACK_TABLE_NAME = process.env.FEEDBACK_TABLE_NAME ?? "";
const FEEDBACK_PARTITION_KEY = process.env.FEEDBACK_PARTITION_KEY?.trim() || "userId";
const FEEDBACK_SORT_KEY = process.env.FEEDBACK_SORT_KEY?.trim() || "billId";
const PREFERENCES_TABLE_NAME = process.env.PREFERENCES_TABLE_NAME ?? "";
const PREFERENCES_PARTITION_KEY = process.env.PREFERENCES_PARTITION_KEY?.trim() || "userId";
const PREFERENCES_SORT_KEY = process.env.PREFERENCES_SORT_KEY?.trim() || "preference";
const BUCKET_NAME = process.env.BUCKET_NAME ?? "";

/** RECENT_ACTIONS_WINDOW_DAYS: a whole number of days from 1 to 90; anything else is the default, 30. */
export const windowDaysFrom = (value: string | undefined): number => {
  const parsed = Number(value?.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 90 ? parsed : DEFAULT_RECENT_ACTIONS_WINDOW_DAYS;
};
const WINDOW_DAYS = windowDaysFrom(process.env.RECENT_ACTIONS_WINDOW_DAYS);

/** Processed bills read per request, at most: with 50 rows at most, room for bills whose news is older. */
export const MAX_BILL_READS = 60;
const BILL_READ_CONCURRENCY = 8;
const BATCH_GET_LIMIT = 100;
const BATCH_GET_MAX_ATTEMPTS = 5;
const BATCH_GET_BACKOFF_MS = 100;
// APPF-23: the groups PublishBillsManifest last published, read at most every 60 s, as the other readers do.
const COMPANION_GROUPS_MAX_AGE_MS = 60_000;
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";
// ReadCapHit: a request whose moved bills did not all fit in MAX_BILL_READS (a count only, no dimensions).
const RECENT_ACTIONS_METRIC_NAMESPACE = "BillBoard/RecentActions";

const db = new DynamoDBClient({});
const storage = new BillStorage(new S3Client({}), BUCKET_NAME);
const manifestConfig = billCompanionConfigFromEnv();
const companionDao = new BillCompanionDao(db, manifestConfig);
let companionIndexFor: { state: CompanionGroupsState | null; index: CompanionIndex } | undefined;

type Item = Record<string, AttributeValue>;

/** Every item of a Query, page by page. */
const queryAll = async (input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Item[]> => {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const page = await db.send(new QueryCommand({ ...input, ExclusiveStartKey: startKey }));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
};

const VOTE_VALUES: Readonly<Record<string, RecentActionVoteV1>> = { yea: "Yea", nay: "Nay", abstain: "Abstain" };

/**
 * The caller's votes by plain guid: Yea, Nay and Abstain rows, without the Abstain rows 1.0 and 1.1 stored for an
 * Updates dismissal (INT-11). Of two rows naming one bill (a legacy suffixed id beside the plain guid), the plain
 * guid's wins, else the later saved.
 */
const readCallerVotes = async (userId: string): Promise<Map<string, CallerVote & { onPlainGuid: boolean }>> => {
  const items = await queryAll({
    TableName: FEEDBACK_TABLE_NAME,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: {
      "#pk": FEEDBACK_PARTITION_KEY,
      "#sk": FEEDBACK_SORT_KEY,
      "#dismiss": LEGACY_DISMISS_ATTRIBUTE,
    },
    ExpressionAttributeValues: { ":pk": { S: userId } },
    ProjectionExpression: "#sk, feedback, votedAt, #dismiss",
  });
  const votes = new Map<string, CallerVote & { onPlainGuid: boolean }>();
  for (const item of items) {
    const billId = item[FEEDBACK_SORT_KEY]?.S?.trim() ?? "";
    const guid = plainBillGuid(billId);
    const feedback = VOTE_VALUES[item.feedback?.S?.trim().toLowerCase() ?? ""];
    if (!guid || !feedback || isLegacyDismissRow(item)) continue;
    const votedAt = item.votedAt?.S?.trim() || null;
    const vote = { feedback, votedAt, onPlainGuid: billId === guid };
    const kept = votes.get(guid);
    const replaces =
      !kept ||
      (vote.onPlainGuid && !kept.onPlainGuid) ||
      (vote.onPlainGuid === kept.onPlainGuid && (vote.votedAt ?? "") > (kept.votedAt ?? ""));
    if (replaces) votes.set(guid, vote);
  }
  return votes;
};

/**
 * The plain guids of the caller's Watch rows (not the Bill rows a vote writes). A vote's Bill row has the same key as
 * the bill's Watch row and replaces it, so a watched bill voted on since is missing here until the watch is saved
 * again; the contract's `watched` tells the app to show its own watch state when it has one.
 */
const readWatchedGuids = async (userId: string): Promise<Set<string>> => {
  const items = await queryAll({
    TableName: PREFERENCES_TABLE_NAME,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: { "#pk": PREFERENCES_PARTITION_KEY, "#sk": PREFERENCES_SORT_KEY, "#type": "type" },
    ExpressionAttributeValues: { ":pk": { S: userId } },
    ProjectionExpression: "#sk, #type",
  });
  const watched = new Set<string>();
  for (const item of items) {
    if (item.type?.S?.trim().toLowerCase() !== "watch") continue;
    const guid = plainBillGuid(item[PREFERENCES_SORT_KEY]?.S);
    if (guid) watched.add(guid);
  }
  return watched;
};

/** The published companion groups, or none (each bill its own row) when they cannot be read. */
const loadCompanionIndex = async (): Promise<CompanionIndex> => {
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    if (companionIndexFor?.state !== state) {
      companionIndexFor = { state, index: companionIndex(activeCompanionPairs(state)) };
    }
    return companionIndexFor.index;
  } catch (error) {
    logger.warn("fetchRecentActions could not read the companion groups; listing each bill on its own", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return companionIndexFor?.index ?? new Map();
  }
};

/** When each bill's manifest row last moved (its BILL_GUID lookup row's updatedAt), by plain guid; absent: no row. */
const readManifestUpdatedAt = async (guids: readonly string[]): Promise<Map<string, string>> => {
  const { tableName, primaryKey, sortKey, guidLookupPk } = manifestConfig;
  const updatedAt = new Map<string, string>();
  for (let start = 0; start < guids.length; start += BATCH_GET_LIMIT) {
    let keys: Item[] = guids
      .slice(start, start + BATCH_GET_LIMIT)
      .map((guid) => ({ [primaryKey]: { S: guidLookupPk }, [sortKey]: { S: guid } }));
    for (let attempt = 1; keys.length > 0; attempt += 1) {
      const response = await db.send(
        new BatchGetItemCommand({
          RequestItems: {
            [tableName]: {
              Keys: keys,
              ProjectionExpression: "#sk, updatedAt, manifestSk",
              ExpressionAttributeNames: { "#sk": sortKey },
            },
          },
        }),
      );
      for (const item of response.Responses?.[tableName] ?? []) {
        const guid = item[sortKey]?.S;
        // manifestSk is "<updatedAt>#<guid>": the date when a lookup row has no updatedAt of its own.
        const when = item.updatedAt?.S || item.manifestSk?.S?.split("#")[0];
        if (guid && when) updatedAt.set(guid, when);
      }
      keys = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
      if (keys.length === 0) break;
      if (attempt >= BATCH_GET_MAX_ATTEMPTS) {
        throw new Error(`BatchGetItem left ${keys.length} guid lookups unprocessed after ${attempt} attempts`);
      }
      await sleep(BATCH_GET_BACKOFF_MS * attempt);
    }
  }
  return updatedAt;
};

/**
 * The groups to read and which of their members: a group whose manifest rows moved on or after the day before the
 * window's first day (an action in the window moves the row when it is stored, so no row with one is left out), most
 * recently moved group first, while the members to read stay within MAX_BILL_READS. Every member of such a group with
 * a manifest row is read, moved or not: the group's row takes the status of the member the Bills card shows
 * (companionStatusLead.ts), which may be a law or a veto from before the window. `moved` counts the groups that moved
 * and `unread` those of them the cap left out, which then have no row.
 */
export const selectBillReads = (
  groups: readonly (readonly string[])[],
  updatedAt: ReadonlyMap<string, string>,
  movedSince: string,
): { groups: string[][]; reads: string[]; moved: number; unread: number } => {
  const fresh = groups
    .map((members) => {
      const listed = members.filter((guid) => updatedAt.has(guid));
      const latest = listed.reduce((max, guid) => {
        const when = updatedAt.get(guid) ?? "";
        return when > max ? when : max;
      }, "");
      return { members: [...members], listed, latest };
    })
    .filter((group) => group.latest >= movedSince)
    .sort((left, right) => (left.latest === right.latest ? 0 : left.latest > right.latest ? -1 : 1));
  const selected: string[][] = [];
  const reads: string[] = [];
  for (const group of fresh) {
    if (reads.length + group.listed.length > MAX_BILL_READS) continue;
    selected.push(group.members);
    reads.push(...group.listed);
  }
  return { groups: selected, reads, moved: fresh.length, unread: fresh.length - selected.length };
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return jsonResponse(401, { message: "Unauthorized (missing authorizer claims)" });

  const nowMs = Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const empty: RecentActionsV1 = { generatedAt, windowDays: WINDOW_DAYS, items: [] };
  try {
    const [votes, watched] = await Promise.all([readCallerVotes(userId), readWatchedGuids(userId)]);
    const held = new Set([...votes.keys(), ...watched]);
    if (held.size === 0) return jsonResponse(200, empty);

    // One entry per bill: a companion group (either member held) is one, its members primary first.
    const index = await loadCompanionIndex();
    const groupsByKey = new Map<string, readonly string[]>();
    for (const guid of held) {
      const group = index.get(guid);
      groupsByKey.set(group?.primaryGuid ?? guid, group?.memberGuids ?? [guid]);
    }
    const groups = [...groupsByKey.values()];

    const updatedAt = await readManifestUpdatedAt([...new Set(groups.flat())]);
    const movedSince = addDays(recentActionsWindowStart(nowMs, WINDOW_DAYS), -1);
    const selection = selectBillReads(groups, updatedAt, movedSince);
    if (selection.unread > 0) emitEmbeddedMetric(RECENT_ACTIONS_METRIC_NAMESPACE, "ReadCapHit", 1);
    const documents = await mapWithConcurrency(selection.reads, BILL_READ_CONCURRENCY, (guid) =>
      storage.getJson<unknown>(buildProcessedBillRootGuidKey(guid)),
    );
    const bills = new Map<string, unknown>();
    selection.reads.forEach((guid, position) => {
      if (documents[position]) bills.set(guid, documents[position]);
    });

    const items = buildRecentActionItems({
      groups: selection.groups,
      bills,
      movedAt: updatedAt,
      votes,
      watched,
      nowMs,
      windowDays: WINDOW_DAYS,
    });
    logger.info("fetchRecentActions built the list", {
      bills: groups.length,
      moved: selection.moved,
      unread: selection.unread,
      read: selection.reads.length,
      missing: selection.reads.length - bills.size,
      items: items.length,
    });
    return jsonResponse(200, { ...empty, items } satisfies RecentActionsV1);
  } catch (error) {
    logger.error("fetchRecentActions failed", { error });
    return jsonResponse(500, { error: "Internal server error" });
  }
}

export default { handler };
