import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { eligibilityBlockReason, loadUserEligibility } from "../../shared/adultEligibility";
import { getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY ?? "userId";

const db = new DynamoDBClient({});

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getAuthenticatedUserId(event);
    if (!userId) {
      return jsonResponse(401, { message: "Unauthorized (missing authorizer claims)" });
    }

    const eligibility = await loadUserEligibility({
      db,
      piiTableName: TABLE_NAME,
      piiPartitionKey: PARTITION_KEY,
      userId,
    });
    const blockedReason = eligibilityBlockReason(eligibility);

    return jsonResponse(200, {
      userId,
      adultStatus: eligibility.adultStatus,
      adultMethod: eligibility.adultMethod,
      adultStatusSetAt: eligibility.adultStatusSetAt,
      deletionStatus: eligibility.deletionStatus,
      canWrite: blockedReason === null,
    });
  } catch (error) {
    console.error("fetchMe failed", error);
    return jsonResponse(500, { error: "Internal server error" });
  }
}

export default { handler };
