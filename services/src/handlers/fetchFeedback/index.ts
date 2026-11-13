import { type AttributeValue, DynamoDBClient, GetItemCommand, BatchGetItemCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { isLegacyDismissRow, LEGACY_DISMISS_ATTRIBUTE } from "../../models/feedback";
import { sendsAppVersion } from "../../shared/appAttest/wire";
import { plainBillGuid } from "../../shared/billCompanions";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY!;

const db = new DynamoDBClient({});

/** DynamoDB BatchGetItem limit per request. */
const BATCH_GET_CHUNK_SIZE = 100;

/** Hard cap on how many bill IDs a single batch request may contain. */
const MAX_BATCH_BILL_IDS = 500;

/** setFeedback stores reasons as a DynamoDB string set (SS); returned as a sorted array. */
function toReasonList(attribute: AttributeValue | undefined): string[] {
  const values = Array.isArray(attribute?.SS) ? attribute.SS : [];
  return values.filter((value: unknown): value is string => typeof value === "string").sort();
}

function parseJsonBody(event: APIGatewayProxyEvent): Record<string, unknown> | null {
  try {
    if (!event?.body) return {};
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
    return JSON.parse(raw);
  } catch {
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
      body: JSON.stringify({ message: "Unauthorized (missing authorizer claims)" }),
    };
  }

  const body = parseJsonBody(event);
  // INT-11: an Abstain that 1.0 or 1.1 stored when the user dismissed a Passed or Failed bill (legacyDismiss) is not
  // a vote. Builds that send X-Billboard-App-Version (1.2 and later) do not get it, so they show the bill as not
  // voted, with Results locked, as GET /bill-stats keeps them. 1.0 and 1.1 still get it, so the bill stays handled.
  const hideLegacyDismissals = sendsAppVersion(event);

  // ── Batch mode: POST with billIds array ─────────────────────────────
  if (Array.isArray(body?.billIds)) {
    return handleBatch(userId, body.billIds, hideLegacyDismissals);
  }

  // ── Single mode: GET with billId query param or body ────────────────
  const qsBillId = event?.queryStringParameters?.billId;
  const billId = qsBillId ?? body?.billId;

  if (!billId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing billId" }),
    };
  }

  // Votes are kept under the plain guid (setFeedback); a legacy id (BILLS-119hr1181rh) names the same bill.
  const requestedBillId = String(billId);
  return handleSingle(userId, plainBillGuid(requestedBillId) ?? requestedBillId, hideLegacyDismissals);
}

// ── Single bill lookup (existing behavior) ──────────────────────────────

async function handleSingle(userId: string, billId: string, hideLegacyDismissals: boolean) {
  try {
    const resp = await db.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          [PARTITION_KEY]: { S: userId },
          [SORT_KEY]: { S: billId },
        },
        ProjectionExpression: `feedback, votedAt, reasons, ${LEGACY_DISMISS_ATTRIBUTE}`,
      }),
    );

    if (!resp.Item?.feedback?.S || (hideLegacyDismissals && isLegacyDismissRow(resp.Item))) {
      // Important: return 200 so the iOS client can treat as "not voted"
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedback: resp.Item.feedback.S,
        votedAt: resp.Item.votedAt?.S ?? null,
        reasons: toReasonList(resp.Item.reasons),
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

// ── Batch bill lookup ───────────────────────────────────────────────────

async function handleBatch(userId: string, rawBillIds: unknown[], hideLegacyDismissals: boolean) {
  // Deduplicate, stringify, and cap.
  const billIds = [
    ...new Set(
      rawBillIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()),
    ),
  ].slice(0, MAX_BATCH_BILL_IDS);

  if (billIds.length === 0) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votes: [] }),
    };
  }

  // Votes are kept under the plain guid (setFeedback): each requested id reads its plain guid's row, and every id
  // naming that bill (BILLS-119hr1181rh and BILLS-119hr1181) gets the vote under the id it asked for.
  const requestedIdsByKey = new Map<string, string[]>();
  for (const id of billIds) {
    const key = plainBillGuid(id) ?? id;
    requestedIdsByKey.set(key, [...(requestedIdsByKey.get(key) ?? []), id]);
  }
  const voteKeys = [...requestedIdsByKey.keys()];

  try {
    const votes: { billId: string; feedback: string; votedAt: string | null; reasons: string[] }[] = [];

    for (let i = 0; i < voteKeys.length; i += BATCH_GET_CHUNK_SIZE) {
      const chunk = voteKeys.slice(i, i + BATCH_GET_CHUNK_SIZE);

      let keys = chunk.map((id) => ({
        [PARTITION_KEY]: { S: userId },
        [SORT_KEY]: { S: id },
      }));

      // Retry loop for any UnprocessedKeys returned by DynamoDB.
      while (keys.length > 0) {
        const resp = await db.send(
          new BatchGetItemCommand({
            RequestItems: {
              [TABLE_NAME]: {
                Keys: keys,
                ProjectionExpression: `${SORT_KEY}, feedback, votedAt, reasons, ${LEGACY_DISMISS_ATTRIBUTE}`,
              },
            },
          }),
        );

        for (const item of resp.Responses?.[TABLE_NAME] ?? []) {
          const itemBillId = item[SORT_KEY]?.S;
          const feedback = item.feedback?.S;
          if (itemBillId && feedback && !(hideLegacyDismissals && isLegacyDismissRow(item))) {
            for (const billId of requestedIdsByKey.get(itemBillId) ?? []) {
              votes.push({
                billId,
                feedback,
                votedAt: item.votedAt?.S ?? null,
                reasons: toReasonList(item.reasons),
              });
            }
          }
        }

        // If DynamoDB throttled some keys, retry them.
        const unprocessed = resp.UnprocessedKeys?.[TABLE_NAME]?.Keys;
        if (unprocessed && unprocessed.length > 0) {
          keys = unprocessed as typeof keys;
          // Brief pause before retry to ease throttling.
          await new Promise((r) => setTimeout(r, 100));
        } else {
          break;
        }
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votes }),
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

export default { handler };
