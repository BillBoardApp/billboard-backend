import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ProcessedCongressMemberDao } from "../../adapters/processedCongressMemberDao";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const STATS_TABLE_NAME = process.env.STATS_TABLE_NAME;
const STATS_PRIMARY_KEY = process.env.STATS_PRIMARY_KEY ?? "bioguideId";

// Bioguide IDs are one letter and six digits (e.g. A000001); they become S3 keys and DynamoDB keys.
const BIOGUIDE_ID_PATTERN = /^[A-Z]\d{6}$/;

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const processedMemberDao = new ProcessedCongressMemberDao(s3, BUCKET_NAME);

const toNumberOrZero = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

type TrackedCounts = { sponsored: number; supported: number };

// Null when the stats table is not configured, the read failed, or the member has no stats row. No row means no tracked
// 119th bill, as for every member new in the 120th Congress: no counts rather than zeros, so the apps hide "Tracked by
// Billboard" (REL-46, project decision D8). A row keeps its counts, zeros included.
const getTrackedCounts = async (bioguideId: string): Promise<TrackedCounts | null> => {
  if (!STATS_TABLE_NAME) return null;

  try {
    const response = await ddb.send(
      new GetItemCommand({
        TableName: STATS_TABLE_NAME,
        Key: {
          [STATS_PRIMARY_KEY]: { S: bioguideId },
        },
        ProjectionExpression: "billsSponsored, billsSupported",
      }),
    );

    if (!response.Item) return null;
    return {
      sponsored: toNumberOrZero(response.Item.billsSponsored?.N),
      supported: toNumberOrZero(response.Item.billsSupported?.N),
    };
  } catch (error) {
    console.warn("Failed to load current-Congress member stats", { bioguideId, error });
    return null;
  }
};

const STATS_FIELDS = ["currentCongressBillsSupportedCount", "trackedSponsoredCount", "trackedSupportedCount"] as const;

const withStatsFields = (member: Record<string, unknown>, trackedCounts: TrackedCounts | null) => {
  const rest = { ...member };
  for (const field of STATS_FIELDS) delete rest[field];
  return trackedCounts
    ? {
        ...rest,
        currentCongressBillsSupportedCount: trackedCounts.supported,
        trackedSponsoredCount: trackedCounts.sponsored,
        trackedSupportedCount: trackedCounts.supported,
      }
    : rest;
};

// currentCongressBillsSupportedCount is kept for app builds that read it. All three counts are left out when the stats
// could not be read (tracked counts since APPF-03, the supported count since REL-52), so the app never shows a false
// zero: apps 1.1 and 1.2 then show the members manifest's tracked counts, or no "Tracked by Billboard" rows. A member
// with no stats row gets none either (REL-46, D8), and the manifest leaves them out of that member too.
const augmentProcessedMemberPayload = (payload: unknown, trackedCounts: TrackedCounts | null): unknown => {
  if (!payload || typeof payload !== "object") return payload;

  const root = payload as Record<string, unknown>;
  const member = root.member;
  if (member && typeof member === "object" && !Array.isArray(member)) {
    return { ...root, member: withStatsFields(member as Record<string, unknown>, trackedCounts) };
  }

  return withStatsFields(root, trackedCounts);
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
      const trackedCounts = await getTrackedCounts(normalizedId);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(augmentProcessedMemberPayload(payload, trackedCounts)),
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
