import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
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
    const blockReason = eligibilityBlockReason(eligibility);

    const statusResult = await db.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { [PARTITION_KEY]: { S: userId } },
        ProjectionExpression: "deletionStatus, deletionRequestedAt, deletionCompletedAt, deletionError",
      }),
    );

    const deletionStatus = statusResult.Item?.deletionStatus?.S ?? "not_requested";

    return jsonResponse(200, {
      deletionStatus,
      deletionRequestedAt: statusResult.Item?.deletionRequestedAt?.S ?? null,
      deletionCompletedAt: statusResult.Item?.deletionCompletedAt?.S ?? null,
      deletionError: statusResult.Item?.deletionError?.S ?? null,
      adultStatus: eligibility.adultStatus,
      canWrite: blockReason === null,
    });
  } catch (error) {
    console.error("accountDataStatus failed", error);
    return jsonResponse(500, { error: "Internal server error" });
  }
}

export default { handler };
