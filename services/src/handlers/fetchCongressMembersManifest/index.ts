import {
  type AttributeValue,
  BatchGetItemCommand,
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type {
  CongressMemberManifestItemV1 as CongressMemberManifestEntry,
  CongressMembersManifestV1 as CongressMembersManifest,
} from "../../contracts";
import { sleep } from "../../shared/retry";

const TABLE_NAME = process.env.TABLE_NAME!;
const MANIFEST_PRIMARY_KEY = process.env.MANIFEST_PRIMARY_KEY;
const MANIFEST_PK_VALUE = process.env.MANIFEST_PK_VALUE;
const MANIFEST_SORT_KEY = process.env.MANIFEST_SORT_KEY ?? "sk";
const STATS_TABLE_NAME = process.env.STATS_TABLE_NAME;
const STATS_PRIMARY_KEY = process.env.STATS_PRIMARY_KEY ?? "bioguideId";
const STATS_BATCH_GET_MAX_ATTEMPTS = 4;
const STATS_BATCH_GET_BACKOFF_MS = 100;

const ddb = new DynamoDBClient({});

const toEntry = (item: Record<string, AttributeValue> | undefined): CongressMemberManifestEntry | null => {
  if (!item) return null;
  const bioguideId = item.bioguideId?.S ?? "";
  const name = item.name?.S ?? "";
  const chamber = item.chamber?.S ?? "";
  const state = item.state?.S ?? "";
  const party = item.party?.S ?? "";
  if (!bioguideId || !name || !chamber || !state || !party) return null;

  const district = item.district?.NULL ? null : (item.district?.S ?? null);
  const depictionImageUrl = item.depictionImageUrl?.NULL ? null : (item.depictionImageUrl?.S ?? null);
  const updatedAt = item.updatedAt?.S ?? "";

  return {
    bioguideId,
    name,
    chamber,
    state,
    party,
    district,
    depictionImageUrl,
    updatedAt,
  };
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

const toNumberOrZero = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

type TrackedCounts = { sponsored: number; supported: number };

/**
 * Reads billsSponsored and billsSupported from CongressMembersStats. A member missing from the map gets no tracked
 * counts: it has no stats row (no tracked 119th bill, as for every member new in the 120th Congress; REL-46, project
 * decision D8), or its row could not be read (no table configured, a failed read, or a key still unprocessed after
 * the retries). A member with a row keeps its counts, zeros included.
 */
const getTrackedCountsByBioguideId = async (bioguideIds: string[]): Promise<Map<string, TrackedCounts>> => {
  const counts = new Map<string, TrackedCounts>();
  if (!STATS_TABLE_NAME) return counts;

  try {
    for (const idsChunk of chunk(bioguideIds, 100)) {
      let keys: Array<Record<string, AttributeValue>> = idsChunk.map((bioguideId) => ({
        [STATS_PRIMARY_KEY]: { S: bioguideId },
      }));

      for (let attempt = 1; keys.length > 0; attempt += 1) {
        const response = await ddb.send(
          new BatchGetItemCommand({
            RequestItems: {
              [STATS_TABLE_NAME]: {
                Keys: keys,
                ProjectionExpression: "#pk, billsSponsored, billsSupported",
                ExpressionAttributeNames: {
                  "#pk": STATS_PRIMARY_KEY,
                },
              },
            },
          }),
        );

        for (const item of response.Responses?.[STATS_TABLE_NAME] ?? []) {
          const bioguideId = item?.[STATS_PRIMARY_KEY]?.S;
          if (!bioguideId) continue;
          counts.set(bioguideId, {
            sponsored: toNumberOrZero(item?.billsSponsored?.N),
            supported: toNumberOrZero(item?.billsSupported?.N),
          });
        }

        // DynamoDB returns throttled keys as UnprocessedKeys instead of failing the call.
        keys = response.UnprocessedKeys?.[STATS_TABLE_NAME]?.Keys ?? [];
        if (keys.length > 0) {
          if (attempt >= STATS_BATCH_GET_MAX_ATTEMPTS) {
            console.warn("Member stats reads still unprocessed after retries", { unprocessed: keys.length });
            break;
          }
          await sleep(STATS_BATCH_GET_BACKOFF_MS * attempt);
        }
      }
    }
  } catch (error) {
    console.warn("Failed to load current-Congress member stats for manifest", { error });
  }

  return counts;
};

/** An API Gateway GET, or a direct invoke that may pass `updatedAfter` at the top level. */
type ManifestRequestEvent = Partial<APIGatewayProxyEvent> & { updatedAfter?: string };

export async function handler(event?: ManifestRequestEvent): Promise<APIGatewayProxyResult> {
  try {
    const updatedAfterRaw = event?.queryStringParameters?.updatedAfter ?? event?.updatedAfter ?? undefined;
    const updatedAfter =
      typeof updatedAfterRaw === "string" && updatedAfterRaw.trim().length > 0 ? updatedAfterRaw.trim() : undefined;
    const canQueryManifest = Boolean(MANIFEST_PRIMARY_KEY && MANIFEST_PK_VALUE);

    const members: CongressMemberManifestEntry[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const result = canQueryManifest
        ? await ddb.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: updatedAfter ? "#pk = :pk AND #sk > :updatedAfter" : "#pk = :pk",
              ExpressionAttributeNames: {
                "#pk": MANIFEST_PRIMARY_KEY!,
                ...(updatedAfter ? { "#sk": MANIFEST_SORT_KEY } : {}),
              },
              ExpressionAttributeValues: {
                ":pk": { S: MANIFEST_PK_VALUE! },
                ...(updatedAfter ? { ":updatedAfter": { S: updatedAfter } } : {}),
              },
              ExclusiveStartKey: startKey,
            }),
          )
        : await ddb.send(
            new ScanCommand({
              TableName: TABLE_NAME,
              ...(updatedAfter
                ? {
                    FilterExpression: "#updatedAt > :updatedAfter",
                    ExpressionAttributeNames: { "#updatedAt": "updatedAt" },
                    ExpressionAttributeValues: { ":updatedAfter": { S: updatedAfter } },
                  }
                : {}),
              ExclusiveStartKey: startKey,
            }),
          );

      const items = result.Items ?? [];
      for (const item of items) {
        const entry = toEntry(item);
        if (entry) members.push(entry);
      }

      startKey = result.LastEvaluatedKey;
    } while (startKey);

    const trackedCounts = await getTrackedCountsByBioguideId(members.map((member) => member.bioguideId));
    const enrichedMembers = members.map((member) => {
      const counts = trackedCounts.get(member.bioguideId);
      // All three counts are omitted when the stats could not be read (APPF-03 and REL-52), so the app never shows a
      // false zero, and for a member with no stats row (REL-46, D8), so apps 1.1 and 1.2 hide "Tracked by Billboard".
      return counts
        ? {
            ...member,
            currentCongressBillsSupportedCount: counts.supported,
            trackedSponsoredCount: counts.sponsored,
            trackedSupportedCount: counts.supported,
          }
        : member;
    });

    const manifest: CongressMembersManifest = {
      generatedAt: new Date().toISOString(),
      count: enrichedMembers.length,
      members: enrichedMembers.sort((a, b) => (a.bioguideId ?? "").localeCompare(b.bioguideId ?? "")),
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
