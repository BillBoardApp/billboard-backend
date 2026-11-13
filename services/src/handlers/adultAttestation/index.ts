import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { loadUserEligibility } from "../../shared/adultEligibility";
import { getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY ?? "userId";

const db = new DynamoDBClient({});

function parseBody(event: APIGatewayProxyEvent): Record<string, unknown> {
  try {
    if (!event?.body) return {};
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getAuthenticatedUserId(event);
    if (!userId) {
      return jsonResponse(401, { message: "Unauthorized (missing authorizer claims)" });
    }

    const body = parseBody(event);
    if (typeof body.isAdult !== "boolean") {
      return jsonResponse(400, { error: "Missing or invalid isAdult boolean" });
    }

    const eligibility = await loadUserEligibility({
      db,
      piiTableName: TABLE_NAME,
      piiPartitionKey: PARTITION_KEY,
      userId,
    });
    if (eligibility.deletionStatus === "in_progress") {
      return jsonResponse(409, {
        error: "ACCOUNT_DELETION_IN_PROGRESS",
        message: "Account deletion is currently in progress.",
      });
    }
    if (eligibility.deletionStatus === "completed") {
      return jsonResponse(409, {
        error: "ACCOUNT_DELETED",
        message: "Account has already been deleted.",
      });
    }

    // An under-18 self-report is sticky. Without this, a user who answered "no"
    // could immediately re-post "yes" and the gate would be purely cosmetic.
    if (eligibility.adultStatus === "self_reported_under18" && body.isAdult) {
      return jsonResponse(409, {
        error: "ADULT_STATUS_LOCKED",
        message: "This account has been recorded as under 18 and cannot be changed in the app.",
      });
    }

    const nowIso = new Date().toISOString();
    const adultStatus = body.isAdult ? "attested_adult" : "self_reported_under18";

    await db.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: { [PARTITION_KEY]: { S: userId } },
        UpdateExpression:
          "SET adultStatus = :adultStatus, adultMethod = :adultMethod, adultStatusSetAt = :adultStatusSetAt, updatedAt = :updatedAt REMOVE deletionError",
        ExpressionAttributeValues: {
          ":adultStatus": { S: adultStatus },
          ":adultMethod": { S: "yes_no" },
          ":adultStatusSetAt": { S: nowIso },
          ":updatedAt": { S: nowIso },
        },
      }),
    );

    return jsonResponse(200, {
      adultStatus,
      adultMethod: "yes_no",
      adultStatusSetAt: nowIso,
      canWrite: adultStatus === "attested_adult",
    });
  } catch (error) {
    console.error("adultAttestation failed", error);
    return jsonResponse(500, { error: "Internal server error" });
  }
}

export default { handler };
