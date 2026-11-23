import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ProcessedCongressMemberDao } from "../../adapters/processedCongressMemberDao";
import { memberCountsFromItem, memberCountsProjection, type MemberCounts } from "../../shared/memberCounters";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const STATS_TABLE_NAME = process.env.STATS_TABLE_NAME;
const STATS_PRIMARY_KEY = process.env.STATS_PRIMARY_KEY ?? "bioguideId";

// Bioguide IDs are one letter and six digits (e.g. A000001); they become S3 keys and DynamoDB keys.
const BIOGUIDE_ID_PATTERN = /^[A-Z]\d{6}$/;

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const processedMemberDao = new ProcessedCongressMemberDao(s3, BUCKET_NAME);

// Null when the stats table is not configured, the read failed, or the member has no stats row; then the member gets no
// counts at all. A row gives its 119th counts only when it has a 119th counter: a member new in the 120th Congress has
// none, so the apps hide "Tracked by Billboard" (REL-46, project decision D8). A row keeps its counts, zeros included.
const getMemberCounts = async (bioguideId: string): Promise<MemberCounts | null> => {
  if (!STATS_TABLE_NAME) return null;

  const nowMs = Date.now();
  try {
    const response = await ddb.send(
      new GetItemCommand({
        TableName: STATS_TABLE_NAME,
        Key: {
          [STATS_PRIMARY_KEY]: { S: bioguideId },
        },
        ...memberCountsProjection(STATS_PRIMARY_KEY, nowMs),
      }),
    );

    if (!response.Item) return null;
    return memberCountsFromItem(response.Item, nowMs);
  } catch (error) {
    console.warn("Failed to load current-Congress member stats", { bioguideId, error });
    return null;
  }
};

// Every count this handler sets; a stored object's own values for them are always dropped.
const STATS_FIELDS = [
  "currentCongressBillsSupportedCount",
  "trackedSponsoredCount",
  "trackedSupportedCount",
  "currentCongressCounts",
] as const;

const withStatsFields = (member: Record<string, unknown>, counts: MemberCounts | null) => {
  const rest = { ...member };
  for (const field of STATS_FIELDS) delete rest[field];
  return {
    ...rest,
    ...(counts?.tracked
      ? {
          currentCongressBillsSupportedCount: counts.tracked.supported,
          trackedSponsoredCount: counts.tracked.sponsored,
          trackedSupportedCount: counts.tracked.supported,
        }
      : {}),
    ...(counts?.current ? { currentCongressCounts: counts.current } : {}),
  };
};

// currentCongressBillsSupportedCount is kept for app builds that read it. All three 119th counts are left out when the
// stats could not be read (tracked counts since APPF-03, the supported count since REL-52), so the app never shows a
// false zero: apps 1.1 and 1.2 then show the members manifest's tracked counts, or no "Tracked by Billboard" rows. A
// member with no 119th counter gets none either (REL-46, D8), and the manifest leaves them out of that member too.
// currentCongressCounts, the newest Congress the member has counters for, follows the same rules.
const augmentProcessedMemberPayload = (payload: unknown, counts: MemberCounts | null): unknown => {
  if (!payload || typeof payload !== "object") return payload;

  const root = payload as Record<string, unknown>;
  const member = root.member;
  if (member && typeof member === "object" && !Array.isArray(member)) {
    return { ...root, member: withStatsFields(member as Record<string, unknown>, counts) };
  }

  return withStatsFields(root, counts);
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const bioguideId = event.queryStringParameters?.bioguideId;

  if (!bioguideId || typeof bioguideId !== "string" || bioguideId.trim().length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing bioguideId" }),
    };
  }

  const normalizedId = bioguideId.trim().toUpperCase();
  if (!BIOGUIDE_ID_PATTERN.test(normalizedId)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid bioguideId" }),
    };
  }

  try {
    const payload = await processedMemberDao.get<unknown>(normalizedId);
    if (payload) {
      const counts = await getMemberCounts(normalizedId);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(augmentProcessedMemberPayload(payload, counts)),
      };
    }

    return {
      statusCode: 404,
      body: JSON.stringify({ error: "Member not found" }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
