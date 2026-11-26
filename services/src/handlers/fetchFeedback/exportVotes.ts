import { createHash } from "node:crypto";
import { type AttributeValue, BatchGetItemCommand, type DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  FIRST_VOTED_AT_ATTRIBUTE,
  firstVoteTimeOf,
  isLegacyDismissRow,
  isValidFeedback,
  LEGACY_DISMISS_ATTRIBUTE,
} from "../../models/feedback";
import { parseBillGuid } from "../../shared/billCompanions";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";

/**
 * UX-40 L7, "Download my votes": GET /account-data/votes, the caller's own votes, a page at a time, for app 1.3 to
 * write as CSV or JSON on the phone. Votes only (project decision D32, 2026-11-23): preferences, follows, devices and the
 * verification record stay with "Contact us".
 *
 * - Only the caller's partition: the partition key is always the authorizer's sub, never anything from the request.
 * - A page is one Query of at most VOTE_EXPORT_PAGE_SIZE rows (about 500 votes; DynamoDB may stop earlier at 1 MB), so
 *   a response stays far under Lambda's 6 MB with ~17k bills. `nextToken` is there while more rows follow; the app
 *   asks again with it as `cursor` until it is absent. A page can hold fewer votes than rows, even none, when rows are
 *   left out (below).
 * - The cursor carries only the last row's sort key (the bill id) and a tag of the caller's sub; the handler checks
 *   both and rebuilds the start key with the caller's own partition. Anything else (a tampered, foreign or
 *   malformed cursor) is 400 INVALID_CURSOR.
 * - Left out: an Abstain stored for a 1.0 or 1.1 Updates dismissal (INT-11: not a vote; the apps show those bills as
 *   not voted) and any row without a Yea, Nay or Abstain.
 * - Each bill once: a row stored under a legacy id (BILLS-119hr1181rh, before votes were kept under the plain guid) is
 *   left out when the row under its plain guid holds a vote, as GET /feedback reads the plain guid's row alone. The
 *   twin can be on another page (BILLS-119hr11810 sorts between BILLS-119hr1181 and BILLS-119hr1181rh), so each
 *   legacy row's twin is read by key (legacyRowsWithVotedTwin). A legacy row with no voted twin stays.
 * - Each vote: the bill (id, and the Congress, type and number its id carries), its title from the bills manifest (null
 *   when the bill has no manifest row), the vote, the reasons (keys, sorted), when it was first cast (the UX-31
 *   first-vote time, else the row's votedAt) and last changed, and the state, district and verification stored with
 *   it. Never the vote's weight, the App Attest outcome, the adult flag or the bill's theme scores and topics: those are
 *   anti-abuse and internal details, projected out of the read.
 * - Nothing about the rows is logged: no bill id, vote or reason, only the error of a failed read, which also emits
 *   VoteExportFailed (BillBoard/Accounts, alarm Billboard-Accounts-VoteExportFailed): the handler answers 500 rather
 *   than throwing, so the function's Errors alarm never counts it.
 */

export const VOTE_EXPORT_RESOURCE = "/account-data/votes";
/** Rows a page reads. */
export const VOTE_EXPORT_PAGE_SIZE = 500;
/** DynamoDB BatchGetItem's limit of keys per request. */
const BATCH_GET_MAX_KEYS = 100;
/** Retries of a BatchGetItem's UnprocessedKeys before the page fails (500). */
const BATCH_GET_MAX_RETRIES = 4;
const BATCH_GET_RETRY_BASE_MS = 50;
/** Where a failed export is counted (VoteExportFailed). */
export const VOTE_EXPORT_METRIC_NAMESPACE = "BillBoard/Accounts";
/** A cursor longer than this is refused unread. */
const MAX_CURSOR_LENGTH = 2048;
/** The longest sort key a cursor may carry (DynamoDB allows 1,024 bytes). */
const MAX_CURSOR_SORT_KEY_LENGTH = 1024;

export interface VoteExportConfig {
  tableName: string;
  partitionKey: string;
  sortKey: string;
  /** The bills manifest, for titles. Without a table name every title is null. */
  manifestTableName?: string;
  manifestPrimaryKey: string;
  manifestSortKey: string;
  /** The partition of the bill rows (BILL) and of their guid lookup rows (BILL_GUID). */
  manifestPkValue: string;
  manifestGuidLookupPk: string;
}

/** One vote in the file, as app 1.3 writes it. */
export interface ExportedVote {
  billId: string;
  title: string | null;
  congress: string | null;
  billType: string | null;
  billNumber: string | null;
  vote: "Yea" | "Nay" | "Abstain";
  reasons: string[];
  firstVotedAt: string | null;
  votedAt: string | null;
  state: string | null;
  district: string | null;
  verified: boolean;
}

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

const respond = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tag of the sub in the cursor, so a cursor works only for the caller it was given to. */
const ownerTag = (userId: string): string =>
  createHash("sha256").update(`billboard-vote-export:${userId}`).digest("base64url").slice(0, 22);

export const encodeVoteExportCursor = (userId: string, afterSortKey: string): string =>
  Buffer.from(JSON.stringify({ v: 1, u: ownerTag(userId), after: afterSortKey }), "utf8").toString("base64url");

/** The sort key a cursor starts after, or null when the cursor is not one this handler gave this caller. */
export const decodeVoteExportCursor = (userId: string, cursor: string): string | null => {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { v, u, after, ...rest } = payload as Record<string, unknown>;
  if (v !== 1 || u !== ownerTag(userId) || Object.keys(rest).length > 0) return null;
  if (typeof after !== "string" || after.length === 0 || after.length > MAX_CURSOR_SORT_KEY_LENGTH) return null;
  return after;
};

const stringOrNull = (attribute: AttributeValue | undefined): string | null =>
  typeof attribute?.S === "string" && attribute.S.length > 0 ? attribute.S : null;

const reasonKeys = (attribute: AttributeValue | undefined): string[] =>
  (Array.isArray(attribute?.SS) ? attribute.SS : []).filter((value) => typeof value === "string").sort();

/** The row's vote as the app shows it, or null for a row that holds none (a 1.0 or 1.1 dismissal included). */
const voteOf = (row: Record<string, AttributeValue>): ExportedVote["vote"] | null => {
  if (isLegacyDismissRow(row)) return null;
  const raw = row.feedback?.S?.trim();
  if (!raw) return null;
  const normalized = `${raw.charAt(0).toUpperCase()}${raw.slice(1).toLowerCase()}`;
  return isValidFeedback(normalized) ? normalized : null;
};

/** Every item of these keys, in requests of at most 100 distinct keys, retrying UnprocessedKeys. */
async function batchGetAll(
  db: DynamoDBClient,
  tableName: string,
  keys: Record<string, AttributeValue>[],
  projection: { expression: string; names: Record<string, string> },
): Promise<Record<string, AttributeValue>[]> {
  const chunks: Record<string, AttributeValue>[][] = [];
  for (let i = 0; i < keys.length; i += BATCH_GET_MAX_KEYS) chunks.push(keys.slice(i, i + BATCH_GET_MAX_KEYS));
  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const items: Record<string, AttributeValue>[] = [];
      let pending = chunk;
      for (let attempt = 0; pending.length > 0; attempt += 1) {
        if (attempt > BATCH_GET_MAX_RETRIES) throw new Error("BatchGetItem left keys unprocessed after retries");
        if (attempt > 0) await sleep(BATCH_GET_RETRY_BASE_MS * 2 ** (attempt - 1));
        const response = await db.send(
          new BatchGetItemCommand({
            RequestItems: {
              [tableName]: {
                Keys: pending,
                ProjectionExpression: projection.expression,
                ExpressionAttributeNames: projection.names,
              },
            },
          }),
        );
        items.push(...(response.Responses?.[tableName] ?? []));
        pending = (response.UnprocessedKeys?.[tableName]?.Keys ?? []) as Record<string, AttributeValue>[];
      }
      return items;
    }),
  );
  return pages.flat();
}

/**
 * The manifest title of each of these plain bill guids that has one: its BILL_GUID lookup row names its BILL row's
 * sort key, and that row holds the title. A bill without either row (or with an empty title) is left out.
 */
async function manifestTitles(
  db: DynamoDBClient,
  config: VoteExportConfig,
  plainGuids: string[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const tableName = config.manifestTableName;
  if (!tableName || plainGuids.length === 0) return titles;
  const { manifestPrimaryKey: pk, manifestSortKey: sk } = config;

  const lookups = await batchGetAll(
    db,
    tableName,
    [...new Set(plainGuids)].map((guid) => ({ [pk]: { S: config.manifestGuidLookupPk }, [sk]: { S: guid } })),
    { expression: "#sk, manifestSk", names: { "#sk": sk } },
  );
  const guidByManifestSk = new Map<string, string[]>();
  for (const lookup of lookups) {
    const guid = lookup[sk]?.S;
    const manifestSk = lookup.manifestSk?.S;
    if (!guid || !manifestSk) continue;
    guidByManifestSk.set(manifestSk, [...(guidByManifestSk.get(manifestSk) ?? []), guid]);
  }

  const rows = await batchGetAll(
    db,
    tableName,
    [...guidByManifestSk.keys()].map((manifestSk) => ({
      [pk]: { S: config.manifestPkValue },
      [sk]: { S: manifestSk },
    })),
    { expression: "#sk, title", names: { "#sk": sk } },
  );
  for (const row of rows) {
    const title = row.title?.S?.trim();
    const manifestSk = row[sk]?.S;
    if (!title || !manifestSk) continue;
    for (const guid of guidByManifestSk.get(manifestSk) ?? []) titles.set(guid, title);
  }
  return titles;
}

/**
 * The plain guids among `plainGuids` whose row in the caller's partition holds a vote (voteOf): from `pageRows` when
 * the row is on this page, else read by key (BatchGetItem, at most 100 keys a request).
 */
async function plainGuidsWithVote(
  db: DynamoDBClient,
  config: VoteExportConfig,
  userId: string,
  plainGuids: ReadonlySet<string>,
  pageRows: ReadonlyMap<string, Record<string, AttributeValue>>,
): Promise<Set<string>> {
  const voted = new Set<string>();
  const unread: string[] = [];
  for (const guid of plainGuids) {
    const row = pageRows.get(guid);
    if (!row) unread.push(guid);
    else if (voteOf(row)) voted.add(guid);
  }
  const { partitionKey, sortKey } = config;
  const twins = await batchGetAll(
    db,
    config.tableName,
    unread.map((guid) => ({ [partitionKey]: { S: userId }, [sortKey]: { S: guid } })),
    {
      expression: "#sk, feedback, #legacyDismiss",
      names: { "#sk": sortKey, "#legacyDismiss": LEGACY_DISMISS_ATTRIBUTE },
    },
  );
  for (const twin of twins) {
    const guid = twin[sortKey]?.S;
    if (guid && plainGuids.has(guid) && voteOf(twin)) voted.add(guid);
  }
  return voted;
}

/** GET /account-data/votes for the authorizer's `userId` (the handler has already answered 401 without one). */
export async function exportVotes(
  event: APIGatewayProxyEvent,
  userId: string,
  db: DynamoDBClient,
  config: VoteExportConfig,
): Promise<APIGatewayProxyResult> {
  const cursor = event?.queryStringParameters?.cursor;
  let startAfter: string | null = null;
  if (cursor !== undefined && cursor !== null) {
    startAfter = decodeVoteExportCursor(userId, cursor);
    if (startAfter === null) {
      return respond(400, { error: "INVALID_CURSOR", message: "Start again without a cursor." });
    }
  }

  try {
    const { partitionKey, sortKey } = config;
    const page = await db.send(
      new QueryCommand({
        TableName: config.tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: {
          "#pk": partitionKey,
          "#sk": sortKey,
          "#firstVotedAt": FIRST_VOTED_AT_ATTRIBUTE,
          "#legacyDismiss": LEGACY_DISMISS_ATTRIBUTE,
        },
        ExpressionAttributeValues: { ":pk": { S: userId } },
        ProjectionExpression:
          "#sk, feedback, votedAt, #firstVotedAt, reasons, resolvedState, resolvedDistrict, constituentVerified, #legacyDismiss",
        Limit: VOTE_EXPORT_PAGE_SIZE,
        ...(startAfter === null
          ? {}
          : { ExclusiveStartKey: { [partitionKey]: { S: userId }, [sortKey]: { S: startAfter } } }),
      }),
    );

    const pageRows = new Map<string, Record<string, AttributeValue>>();
    for (const row of page.Items ?? []) {
      const billId = row[sortKey]?.S;
      if (billId) pageRows.set(billId, row);
    }
    const voteRows = (page.Items ?? []).flatMap((row) => {
      const billId = row[sortKey]?.S;
      const vote = voteOf(row);
      return billId && vote ? [{ row, billId, vote, bill: parseBillGuid(billId) }] : [];
    });
    // A legacy row (its id is not its plain guid) is left out when the plain guid's row holds a vote, wherever it is.
    const isLegacy = ({ billId, bill }: (typeof voteRows)[number]) => bill !== null && bill.plainGuid !== billId;
    const votedTwins = await plainGuidsWithVote(
      db,
      config,
      userId,
      new Set(voteRows.filter(isLegacy).map(({ bill }) => bill!.plainGuid)),
      pageRows,
    );
    const rows = voteRows.filter((entry) => !(isLegacy(entry) && votedTwins.has(entry.bill!.plainGuid)));
    const titles = await manifestTitles(
      db,
      config,
      rows.flatMap(({ bill }) => (bill ? [bill.plainGuid] : [])),
    );

    const votes: ExportedVote[] = rows.map(({ row, billId, vote, bill }) => ({
      billId,
      title: (bill && titles.get(bill.plainGuid)) ?? null,
      congress: bill?.congress ?? null,
      billType: bill?.billType ?? null,
      billNumber: bill?.billNumber ?? null,
      vote,
      reasons: reasonKeys(row.reasons),
      firstVotedAt: firstVoteTimeOf(row),
      votedAt: stringOrNull(row.votedAt),
      state: stringOrNull(row.resolvedState),
      district: stringOrNull(row.resolvedDistrict),
      verified: row.constituentVerified?.BOOL === true,
    }));

    const lastSortKey = page.LastEvaluatedKey?.[sortKey]?.S;
    return respond(200, {
      votes,
      ...(lastSortKey ? { nextToken: encodeVoteExportCursor(userId, lastSortKey) } : {}),
    });
  } catch (error) {
    // The error only: never the rows, a bill id or a vote.
    logger.error("exportVotes could not read the caller's votes; answering 500", { error });
    emitEmbeddedMetric(VOTE_EXPORT_METRIC_NAMESPACE, "VoteExportFailed", 1);
    return respond(500, { error: "Internal server error" });
  }
}
