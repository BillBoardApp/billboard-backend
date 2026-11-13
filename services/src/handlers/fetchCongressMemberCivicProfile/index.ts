import { type AttributeValue, DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  computeMemberCivicProfile,
  MEMBER_CIVIC_PROFILE_EVIDENCE_LIMIT,
  MemberEvidenceRow,
  MemberEvidenceType,
} from "../../shared/memberCivicProfile";
import { mapWithConcurrency } from "../../shared/concurrency";

const VOTE_TABLE_NAME = process.env.TABLE_NAME!;
const VOTE_PARTITION_KEY = process.env.PARTITION_KEY ?? "bioguideId";
const VOTE_SORT_KEY = process.env.SORT_KEY ?? "billGuid";
const LEGISLATIVE_TABLE_NAME = process.env.LEGISLATIVE_TABLE_NAME || "";
const LEGISLATIVE_PARTITION_KEY = process.env.LEGISLATIVE_PARTITION_KEY ?? "bioguideId";
const LEGISLATIVE_SORT_KEY = process.env.LEGISLATIVE_SORT_KEY ?? "billGuid";
const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME;
const MANIFEST_PRIMARY_KEY = process.env.MANIFEST_PRIMARY_KEY ?? "pk";
const MANIFEST_SORT_KEY = process.env.MANIFEST_SORT_KEY ?? "sk";
const MANIFEST_PK_VALUE = process.env.MANIFEST_PK_VALUE ?? "BILL";
const MANIFEST_GUID_LOOKUP_PK = process.env.MANIFEST_GUID_LOOKUP_PK ?? `${MANIFEST_PK_VALUE}_GUID`;
const BILL_TITLE_LOOKUP_CONCURRENCY = 10;

const db = new DynamoDBClient({});

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const parseVotePosition = (value: unknown): "Yea" | "Nay" | null => {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "yea" || normalized === "yes" || normalized === "aye") return "Yea";
  if (normalized === "nay" || normalized === "no") return "Nay";
  return null;
};

const parseEvidenceType = (value: unknown): MemberEvidenceType | null => {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "sponsor") return "sponsor";
  if (normalized === "cosponsor") return "cosponsor";
  if (normalized === "voteyea") return "voteYea";
  if (normalized === "votenay") return "voteNay";
  return null;
};

const parseCivicProfileMap = (mapAttr: AttributeValue | undefined): Record<string, number> | null => {
  const m = mapAttr?.M;
  if (!m || typeof m !== "object") return null;

  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(m)) {
    // A value without N parses to NaN and is skipped.
    const numeric = parseFloat(val?.N as string);
    if (!Number.isNaN(numeric)) result[key] = numeric;
  }
  return Object.keys(result).length > 0 ? result : null;
};

const emptyResponse = () => computeMemberCivicProfile([]);

const queryRowsForMember = async (
  bioguideId: string,
  tableName: string,
  partitionKey: string,
  sortKey: string,
  parseItem: (item: Record<string, AttributeValue>) => MemberEvidenceRow | null,
): Promise<MemberEvidenceRow[]> => {
  if (!tableName) return [];

  const rows: MemberEvidenceRow[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await db.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": partitionKey, "#sk": sortKey },
        ExpressionAttributeValues: { ":pk": { S: bioguideId } },
        ProjectionExpression: "#sk, evidenceType, votePosition, occurredAt, votedAt, civicProfile",
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const parsed = parseItem(item);
      if (parsed) rows.push(parsed);
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return rows;
};

const queryAllRowsForMember = async (bioguideId: string): Promise<MemberEvidenceRow[]> => {
  const [voteRows, legislativeRows] = await Promise.all([
    queryRowsForMember(bioguideId, VOTE_TABLE_NAME, VOTE_PARTITION_KEY, VOTE_SORT_KEY, (item) => {
      const votePosition = parseVotePosition(item?.votePosition?.S);
      const occurredAt = toTrimmedString(item?.occurredAt?.S || item?.votedAt?.S);
      const civicProfile = parseCivicProfileMap(item?.civicProfile);
      if (!votePosition || !occurredAt || !civicProfile) return null;
      return {
        billGuid: toTrimmedString(item?.[VOTE_SORT_KEY]?.S),
        evidenceType: votePosition === "Yea" ? "voteYea" : "voteNay",
        occurredAt,
        civicProfile,
      };
    }),
    queryRowsForMember(bioguideId, LEGISLATIVE_TABLE_NAME, LEGISLATIVE_PARTITION_KEY, LEGISLATIVE_SORT_KEY, (item) => {
      const evidenceType = parseEvidenceType(item?.evidenceType?.S);
      const occurredAt = toTrimmedString(item?.occurredAt?.S);
      const civicProfile = parseCivicProfileMap(item?.civicProfile);
      if (
        !evidenceType ||
        (evidenceType !== "sponsor" && evidenceType !== "cosponsor") ||
        !occurredAt ||
        !civicProfile
      ) {
        return null;
      }
      return {
        billGuid: toTrimmedString(item?.[LEGISLATIVE_SORT_KEY]?.S),
        evidenceType,
        occurredAt,
        civicProfile,
      };
    }),
  ]);
  return [...voteRows, ...legislativeRows];
};

const lookupBillTitle = async (billGuid: string): Promise<string | undefined> => {
  if (!MANIFEST_TABLE_NAME || !billGuid) return undefined;

  try {
    const lookup = await db.send(
      new GetItemCommand({
        TableName: MANIFEST_TABLE_NAME,
        Key: {
          [MANIFEST_PRIMARY_KEY]: { S: MANIFEST_GUID_LOOKUP_PK },
          [MANIFEST_SORT_KEY]: { S: billGuid },
        },
        ProjectionExpression: "manifestSk",
      }),
    );
    const manifestSk = lookup.Item?.manifestSk?.S;
    if (!manifestSk) return undefined;

    const result = await db.send(
      new GetItemCommand({
        TableName: MANIFEST_TABLE_NAME,
        Key: {
          [MANIFEST_PRIMARY_KEY]: { S: MANIFEST_PK_VALUE },
          [MANIFEST_SORT_KEY]: { S: manifestSk },
        },
        ProjectionExpression: "title",
      }),
    );

    return toTrimmedString(result.Item?.title?.S) || undefined;
  } catch (err) {
    console.warn("Failed to look up bill title for member civic profile evidence:", billGuid, err);
    return undefined;
  }
};

const enrichRecentEvidenceTitles = async (rows: MemberEvidenceRow[]): Promise<MemberEvidenceRow[]> => {
  const sortedRows = [...rows].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const recentBillGuids = [
    ...new Set(
      sortedRows
        .slice(0, MEMBER_CIVIC_PROFILE_EVIDENCE_LIMIT)
        .map((row) => row.billGuid)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (recentBillGuids.length === 0) return rows;

  // Up to MEMBER_CIVIC_PROFILE_EVIDENCE_LIMIT bills, two GetItems each; cap the calls in flight.
  const titleEntries = await mapWithConcurrency(
    recentBillGuids,
    BILL_TITLE_LOOKUP_CONCURRENCY,
    async (billGuid) => [billGuid, await lookupBillTitle(billGuid)] as const,
  );
  const titlesByGuid = new Map(titleEntries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])));
  return rows.map((row) => {
    const title = row.billGuid ? titlesByGuid.get(row.billGuid) : undefined;
    return title ? { ...row, title } : row;
  });
};

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

  const bioguideIdRaw = event?.queryStringParameters?.bioguideId;
  const bioguideId = toTrimmedString(bioguideIdRaw).toUpperCase();
  if (!bioguideId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing bioguideId" }),
    };
  }

  try {
    const queriedRows = await queryAllRowsForMember(bioguideId);
    const allRows = await enrichRecentEvidenceTitles(queriedRows);
    if (allRows.length === 0) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(emptyResponse()),
      };
    }

    const profile = computeMemberCivicProfile(allRows);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    };
  } catch (err) {
    console.error("fetchCongressMemberCivicProfile error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

export default { handler };
