import {
  type AttributeValue,
  BatchGetItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import {
  BILL_STATUS_VALUES_V1,
  type CongressMemberRecordBillV1,
  type CongressMemberRecordCongressCountV1,
  type CongressMemberRecordPositionV1,
  type CongressMemberRecordV1,
  type CongressMemberRecordVoteV1,
} from "../../contracts";
import { getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";
import { counterAttributesFor, countedCongressesAt } from "../../shared/memberCounters";
import {
  VOTE_RECORD_POSITIONS,
  voteRecordBillKey,
  voteRecordVotedOnKey,
  type VoteRecordChamber,
} from "../../shared/memberVoteRecord";
import { sleep } from "../../shared/retry";

// GET /congress-member-record (UX-39d): a member of Congress's public record. Their latest roll-call vote on each bill
// in BillBoard, newest first, a page at a time (CongressMemberVoteRecord, written by congressMemberStats, read through
// its VotedOnIndex), and on the first page the bills they sponsored (CongressMembersStats' counted-bill sets, each
// Congress apart, REL-46) that the bills manifest lists. Titles, statuses and dates come from the bills manifest. With
// billGuids, only the member's votes on those bills (for "You and <member> voted alike", worked out on the device).
// Only public facts: no score, no ranking, no BillBoard user's vote.

const VOTE_RECORD_TABLE_NAME = process.env.VOTE_RECORD_TABLE_NAME ?? "";
const VOTE_RECORD_PRIMARY_KEY = process.env.VOTE_RECORD_PRIMARY_KEY ?? "bioguideId";
const VOTE_RECORD_SORT_KEY = process.env.VOTE_RECORD_SORT_KEY ?? "billKey";
const VOTE_RECORD_VOTED_ON_INDEX_NAME = process.env.VOTE_RECORD_VOTED_ON_INDEX_NAME ?? "VotedOnIndex";
const VOTE_RECORD_VOTED_ON_KEY = process.env.VOTE_RECORD_VOTED_ON_KEY ?? "votedOnKey";
const STATS_TABLE_NAME = process.env.STATS_TABLE_NAME ?? "";
const STATS_PRIMARY_KEY = process.env.STATS_PRIMARY_KEY ?? "bioguideId";
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME ?? "";
const MANIFEST_PRIMARY_KEY = process.env.MANIFEST_PRIMARY_KEY ?? "pk";
const MANIFEST_SORT_KEY = process.env.MANIFEST_SORT_KEY ?? "sk";
const MANIFEST_PK_VALUE = process.env.MANIFEST_PK_VALUE ?? "BILL";
const MANIFEST_GUID_LOOKUP_PK = process.env.MANIFEST_GUID_LOOKUP_PK ?? `${MANIFEST_PK_VALUE}_GUID`;

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const SPONSORED_BILLS_LIMIT = 250;
export const MAX_BILL_GUIDS = 100;
const BATCH_GET_SIZE = 100;
const BATCH_GET_MAX_ATTEMPTS = 4;
const BATCH_GET_BACKOFF_MS = 100;

const BIOGUIDE_ID_PATTERN = /^[A-Z]\d{6}$/;
const PLAIN_GUID_PATTERN = /^BILLS-(\d+)([a-z]+)(\d+)$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// What a cursor carries: the last vote served, "<votedOn>#<plain guid>#<chamber>".
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2})#(BILLS-\d+[a-z]+\d+)#(House|Senate)$/;
const CHAMBERS: readonly VoteRecordChamber[] = ["House", "Senate"];
const POSITIONS: ReadonlySet<string> = new Set<CongressMemberRecordPositionV1>(VOTE_RECORD_POSITIONS);
const BILL_STATUSES: ReadonlySet<string> = new Set(BILL_STATUS_VALUES_V1);

const ddb = new DynamoDBClient({});

type Item = Record<string, AttributeValue>;

const badRequest = (error: string, message: string): APIGatewayProxyResult => jsonResponse(400, { error, message });

/** Where a page ends: the last vote served. */
type CursorPosition = { votedOn: string; billGuid: string; chamber: VoteRecordChamber };

const encodeCursor = ({ votedOn, billGuid, chamber }: CursorPosition): string =>
  Buffer.from(`${votedOn}#${billGuid}#${chamber}`, "utf8").toString("base64url");

/** The vote a cursor continues after, or null when it is not one this handler sent. */
const decodeCursor = (cursor: string): CursorPosition | null => {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const match = Buffer.from(cursor, "base64url").toString("utf8").match(CURSOR_PATTERN);
  return match ? { votedOn: match[1], billGuid: match[2], chamber: match[3] as VoteRecordChamber } : null;
};

/** The billGuids parameter: 1 to MAX_BILL_GUIDS plain guids, comma-separated, repeats dropped; null when malformed. */
const parseBillGuids = (raw: string): string[] | null => {
  const guids = [...new Set(raw.split(",").map((guid) => guid.trim()))];
  if (guids.length === 0 || guids.length > MAX_BILL_GUIDS) return null;
  return guids.every((guid) => PLAIN_GUID_PATTERN.test(guid)) ? guids : null;
};

/** BILLS-119hr1234 -> its congress, type and number, as the bills manifest writes them. */
const billParts = (guid: string): { congress: string; billType: string; billNumber: string } | null => {
  const match = guid.match(PLAIN_GUID_PATTERN);
  return match ? { congress: match[1], billType: match[2], billNumber: match[3] } : null;
};

/** A bill's row in the bills manifest, as this record serves it. */
type ManifestFacts = { title?: string; billStatus?: string; vetoed?: true; updatedAt?: string };

/** BatchGetItem of every key, retrying unprocessed keys; the items found, and whether every key was read. */
const batchGetAll = async (
  tableName: string,
  keys: Item[],
  projection: string,
  names: Record<string, string>,
): Promise<{ items: Item[]; complete: boolean }> => {
  const items: Item[] = [];
  let complete = true;
  for (let start = 0; start < keys.length; start += BATCH_GET_SIZE) {
    let pending = keys.slice(start, start + BATCH_GET_SIZE);
    for (let attempt = 1; pending.length > 0; attempt += 1) {
      const response = await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [tableName]: { Keys: pending, ProjectionExpression: projection, ExpressionAttributeNames: names },
          },
        }),
      );
      items.push(...(response.Responses?.[tableName] ?? []));
      pending = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
      if (pending.length > 0) {
        if (attempt >= BATCH_GET_MAX_ATTEMPTS) {
          console.warn("Reads still unprocessed after retries", { tableName, unprocessed: pending.length });
          complete = false;
          break;
        }
        await sleep(BATCH_GET_BACKOFF_MS * attempt);
      }
    }
  }
  return { items, complete };
};

/**
 * Each guid's manifest facts: its BILL_GUID lookup row names its manifest row; a guid without both rows (a bill not
 * published) has none. `complete` is false when the manifest could not be read in full, and the record is then served
 * with the titles it has.
 */
const readManifestFacts = async (
  guids: string[],
): Promise<{ facts: Map<string, ManifestFacts>; complete: boolean }> => {
  const facts = new Map<string, ManifestFacts>();
  if (!MANIFEST_TABLE_NAME) return { facts, complete: false };
  if (guids.length === 0) return { facts, complete: true };
  try {
    const lookups = await batchGetAll(
      MANIFEST_TABLE_NAME,
      guids.map((guid) => ({
        [MANIFEST_PRIMARY_KEY]: { S: MANIFEST_GUID_LOOKUP_PK },
        [MANIFEST_SORT_KEY]: { S: guid },
      })),
      "#sk, manifestSk",
      { "#sk": MANIFEST_SORT_KEY },
    );
    const guidByManifestSk = new Map<string, string>();
    for (const lookup of lookups.items) {
      const guid = lookup[MANIFEST_SORT_KEY]?.S;
      const manifestSk = lookup.manifestSk?.S;
      if (guid && manifestSk) guidByManifestSk.set(manifestSk, guid);
    }
    const rows = await batchGetAll(
      MANIFEST_TABLE_NAME,
      [...guidByManifestSk.keys()].map((manifestSk) => ({
        [MANIFEST_PRIMARY_KEY]: { S: MANIFEST_PK_VALUE },
        [MANIFEST_SORT_KEY]: { S: manifestSk },
      })),
      "#sk, #title, billStatus, vetoed, updatedAt",
      { "#sk": MANIFEST_SORT_KEY, "#title": "title" },
    );
    for (const row of rows.items) {
      const guid = guidByManifestSk.get(row[MANIFEST_SORT_KEY]?.S ?? "");
      if (!guid) continue;
      const title = row.title?.S?.trim();
      const billStatus = row.billStatus?.S;
      const updatedAt = row.updatedAt?.S;
      facts.set(guid, {
        ...(title ? { title } : {}),
        ...(billStatus && BILL_STATUSES.has(billStatus) ? { billStatus } : {}),
        ...(row.vetoed?.BOOL === true ? { vetoed: true as const } : {}),
        ...(updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? { updatedAt } : {}),
      });
    }
    return { facts, complete: lookups.complete && rows.complete };
  } catch (error) {
    console.warn("Failed to read bill titles for a member record; serving it without them", { error });
    return { facts, complete: false };
  }
};

const VOTE_PROJECTION = "billGuid, #chamber, #position, votedOn, actionText";
const VOTE_PROJECTION_NAMES = { "#chamber": "chamber", "#position": "position" };

/** A vote row's place in the newest-first order, as a cursor names it; null for a row that cannot be served. */
const cursorPositionOf = (row: Item): CursorPosition | null => {
  const votedOn = row.votedOn?.S ?? "";
  const billGuid = row.billGuid?.S ?? "";
  const chamber = row.chamber?.S;
  if (!DAY_PATTERN.test(votedOn) || !PLAIN_GUID_PATTERN.test(billGuid)) return null;
  return chamber === "House" || chamber === "Senate" ? { votedOn, billGuid, chamber } : null;
};

/** One page of the member's vote rows, newest first (VotedOnIndex), and where the next page starts when more follow. */
const readVotePage = async (
  bioguideId: string,
  limit: number,
  after: CursorPosition | null,
): Promise<{ rows: Item[]; next: CursorPosition | null }> => {
  if (!VOTE_RECORD_TABLE_NAME) return { rows: [], next: null };
  // One row more than asked, so a page that ends the record says so (no empty last page).
  const response = await ddb.send(
    new QueryCommand({
      TableName: VOTE_RECORD_TABLE_NAME,
      IndexName: VOTE_RECORD_VOTED_ON_INDEX_NAME,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": VOTE_RECORD_PRIMARY_KEY, ...VOTE_PROJECTION_NAMES },
      ExpressionAttributeValues: { ":pk": { S: bioguideId } },
      ProjectionExpression: VOTE_PROJECTION,
      ScanIndexForward: false,
      Limit: limit + 1,
      ...(after
        ? {
            ExclusiveStartKey: {
              [VOTE_RECORD_PRIMARY_KEY]: { S: bioguideId },
              [VOTE_RECORD_SORT_KEY]: { S: voteRecordBillKey(after.billGuid, after.chamber) },
              [VOTE_RECORD_VOTED_ON_KEY]: { S: voteRecordVotedOnKey(after.votedOn, after.billGuid) },
            },
          }
        : {}),
    }),
  );
  const items = response.Items ?? [];
  const rows = items.slice(0, limit);
  const next = items.length > limit && rows.length > 0 ? cursorPositionOf(rows[rows.length - 1]) : null;
  return { rows, next };
};

/** Newest first, as the VotedOnIndex reads: by day, then guid, then chamber, each descending. */
const compareVoteRows = (a: Item, b: Item): number =>
  (b.votedOn?.S ?? "").localeCompare(a.votedOn?.S ?? "") ||
  (b.billGuid?.S ?? "").localeCompare(a.billGuid?.S ?? "") ||
  (b.chamber?.S ?? "").localeCompare(a.chamber?.S ?? "");

/** The member's vote rows on these bills, both chambers, newest first; one BatchGetItem per 50 bills. */
const readVotesOnBills = async (bioguideId: string, guids: string[]): Promise<Item[]> => {
  if (!VOTE_RECORD_TABLE_NAME) return [];
  const keys = guids.flatMap((guid) =>
    CHAMBERS.map((chamber) => ({
      [VOTE_RECORD_PRIMARY_KEY]: { S: bioguideId },
      [VOTE_RECORD_SORT_KEY]: { S: voteRecordBillKey(guid, chamber) },
    })),
  );
  const { items, complete } = await batchGetAll(VOTE_RECORD_TABLE_NAME, keys, VOTE_PROJECTION, VOTE_PROJECTION_NAMES);
  // A partial answer would undercount "voted alike": fail instead, and the app tries again.
  if (!complete) throw new Error("Vote record reads still unprocessed after retries");
  return items.sort(compareVoteRows);
};

/** The member's sponsored bill guids, each Congress BillBoard counts, newest Congress first. */
const readSponsoredGuids = async (bioguideId: string): Promise<string[]> => {
  if (!STATS_TABLE_NAME) return [];
  const nowMs = Date.now();
  const congresses = countedCongressesAt(nowMs).reverse();
  const names: Record<string, string> = {};
  congresses.forEach((congress, index) => {
    names[`#s${index}`] = counterAttributesFor(congress, nowMs)!.sponsoredGuids;
  });
  const response = await ddb.send(
    new GetItemCommand({
      TableName: STATS_TABLE_NAME,
      Key: { [STATS_PRIMARY_KEY]: { S: bioguideId } },
      ProjectionExpression: Object.keys(names).join(", "),
      ExpressionAttributeNames: names,
    }),
  );
  const guids: string[] = [];
  for (const name of Object.keys(names)) {
    for (const guid of response.Item?.[names[name]]?.SS ?? []) {
      if (PLAIN_GUID_PATTERN.test(guid) && !guids.includes(guid)) guids.push(guid);
    }
  }
  return guids;
};

const toVote = (row: Item, facts: Map<string, ManifestFacts>): CongressMemberRecordVoteV1 | null => {
  const place = cursorPositionOf(row);
  const parts = place ? billParts(place.billGuid) : null;
  const position = row.position?.S ?? "";
  if (!place || !parts || !POSITIONS.has(position)) return null;
  const title = facts.get(place.billGuid)?.title;
  const actionText = row.actionText?.S?.trim();
  return {
    billGuid: place.billGuid,
    ...parts,
    ...(title ? { title } : {}),
    chamber: place.chamber,
    position: position as CongressMemberRecordPositionV1,
    votedOn: place.votedOn,
    ...(actionText ? { actionText } : {}),
  };
};

const toSponsoredBill = (guid: string, facts: Map<string, ManifestFacts>): CongressMemberRecordBillV1 => {
  const fact = facts.get(guid) ?? {};
  return {
    billGuid: guid,
    ...billParts(guid)!,
    ...(fact.title ? { title: fact.title } : {}),
    ...(fact.billStatus ? { billStatus: fact.billStatus as CongressMemberRecordBillV1["billStatus"] } : {}),
    ...(fact.vetoed ? { vetoed: true as const } : {}),
    ...(fact.updatedAt ? { updatedAt: fact.updatedAt } : {}),
  };
};

/** Newest Congress first, then the manifest's date, newest first (bills without one last), then guid. */
const compareSponsored = (a: CongressMemberRecordBillV1, b: CongressMemberRecordBillV1): number =>
  Number(b.congress) - Number(a.congress) ||
  (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") ||
  b.billGuid.localeCompare(a.billGuid);

/** How many of the bills each Congress has, newest Congress first. */
const countByCongress = (bills: readonly CongressMemberRecordBillV1[]): CongressMemberRecordCongressCountV1[] => {
  const counts = new Map<string, number>();
  for (const bill of bills) counts.set(bill.congress, (counts.get(bill.congress) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([congress, count]) => ({ congress, count }));
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!getAuthenticatedUserId(event)) return jsonResponse(401, { error: "UNAUTHORIZED", message: "Sign in again." });

  const query = event?.queryStringParameters ?? {};
  const bioguideId = (query.bioguideId ?? "").trim().toUpperCase();
  if (!BIOGUIDE_ID_PATTERN.test(bioguideId)) {
    return badRequest("INVALID_BIOGUIDE_ID", "bioguideId must be a bioguide ID such as D000001.");
  }
  const limitRaw = (query.limit ?? "").trim();
  const limit = limitRaw === "" ? DEFAULT_LIMIT : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) {
    return badRequest("INVALID_LIMIT", `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  }
  const cursorRaw = query.cursor;
  const after = cursorRaw === undefined || cursorRaw === null ? null : decodeCursor(cursorRaw.trim());
  if (cursorRaw !== undefined && cursorRaw !== null && !after) {
    return badRequest("INVALID_CURSOR", "cursor must be a nextCursor this route sent.");
  }
  const billGuidsRaw = query.billGuids;
  const billGuids = billGuidsRaw === undefined || billGuidsRaw === null ? null : parseBillGuids(billGuidsRaw);
  if (billGuidsRaw !== undefined && billGuidsRaw !== null && (!billGuids || limitRaw !== "" || after)) {
    return badRequest(
      "INVALID_BILL_GUIDS",
      `billGuids must be 1 to ${MAX_BILL_GUIDS} bill guids such as BILLS-119hr1234, comma-separated, without limit or cursor.`,
    );
  }

  try {
    if (billGuids) {
      const rows = await readVotesOnBills(bioguideId, billGuids);
      const { facts } = await readManifestFacts([...new Set(rows.map((row) => row.billGuid?.S ?? ""))]);
      const votes = rows
        .map((row) => toVote(row, facts))
        .filter((vote): vote is CongressMemberRecordVoteV1 => vote !== null);
      return jsonResponse(200, { bioguideId, votes } satisfies CongressMemberRecordV1);
    }

    const firstPage = after === null;
    const [page, sponsoredGuids] = await Promise.all([
      readVotePage(bioguideId, limit, after),
      firstPage ? readSponsoredGuids(bioguideId) : Promise.resolve([]),
    ]);
    const voteGuids = page.rows.map((row) => row.billGuid?.S ?? "").filter((guid) => PLAIN_GUID_PATTERN.test(guid));
    const { facts, complete } = await readManifestFacts([...new Set([...voteGuids, ...sponsoredGuids])]);

    const votes = page.rows
      .map((row) => toVote(row, facts))
      .filter((vote): vote is CongressMemberRecordVoteV1 => vote !== null);
    // Only bills the manifest lists: a sponsored bill still waiting for its text is not in BillBoard yet. When the
    // manifest could not be read in full, every counted bill is served, with the titles that were read.
    const sponsoredBills = sponsoredGuids
      .filter((guid) => !complete || facts.has(guid))
      .map((guid) => toSponsoredBill(guid, facts))
      .sort(compareSponsored);
    const record: CongressMemberRecordV1 = {
      bioguideId,
      votes,
      ...(page.next ? { nextCursor: encodeCursor(page.next) } : {}),
      ...(firstPage
        ? {
            sponsoredBills: sponsoredBills.slice(0, SPONSORED_BILLS_LIMIT),
            sponsoredBillCount: sponsoredBills.length,
            sponsoredBillCounts: countByCongress(sponsoredBills),
          }
        : {}),
    };
    return jsonResponse(200, record);
  } catch (error) {
    console.error("fetchCongressMemberRecord error:", error);
    return jsonResponse(500, { error: "INTERNAL_ERROR", message: "Couldn't load the member's record." });
  }
}
