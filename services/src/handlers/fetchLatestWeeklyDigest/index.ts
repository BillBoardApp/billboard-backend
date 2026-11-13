import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { WeeklyDigestSnapshotDao } from "../../adapters/weeklyDigestSnapshotDao";
import { emptyJsonResponse, getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";
import { latestPublishedWindow } from "../../shared/weeklyDigestSchedule";

const TABLE_NAME = process.env.TABLE_NAME;
const PARTITION_KEY = process.env.PARTITION_KEY ?? "userId";
const SORT_KEY = process.env.SORT_KEY ?? "publishedAt";

const dynamo = new DynamoDBClient({});
const snapshotDao = new WeeklyDigestSnapshotDao(dynamo, {
  tableName: TABLE_NAME,
  partitionKey: PARTITION_KEY,
  sortKey: SORT_KEY,
});

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getAuthenticatedUserId(event);
    if (!userId) {
      return jsonResponse(401, { message: "Unauthorized (missing authorizer claims)" });
    }

    const window = latestPublishedWindow(new Date());
    const stored = await snapshotDao.get(userId, window.id);
    if (!stored) {
      return emptyJsonResponse();
    }

    return jsonResponse(200, stored);
  } catch (error) {
    console.error("fetchLatestWeeklyDigest failed", error);
    return jsonResponse(500, { error: "Internal server error" });
  }
}

export default { handler };
