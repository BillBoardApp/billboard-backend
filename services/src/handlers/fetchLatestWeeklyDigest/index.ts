import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { WeeklyDigestSnapshotDao } from "../../adapters/weeklyDigestSnapshotDao";
import { emptyJsonResponse, getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetrics } from "../../shared/metrics";
import { latestPublishedWindow } from "../../shared/weeklyDigestSchedule";

const TABLE_NAME = process.env.TABLE_NAME;
const PARTITION_KEY = process.env.PARTITION_KEY ?? "userId";
const SORT_KEY = process.env.SORT_KEY ?? "publishedAt";
const METRIC_NAMESPACE = "BillBoard/WeeklyDigest";

const dynamo = new DynamoDBClient({});
const snapshotDao = new WeeklyDigestSnapshotDao(dynamo, {
  tableName: TABLE_NAME,
  partitionKey: PARTITION_KEY,
  sortKey: SORT_KEY,
});

/**
 * UX-28, decision D7 (a): app 1.3 adds ?trigger=push to the brief fetch it makes after a tap on the Sunday push. Each
 * such fetch adds 1 to WeeklyBriefOpenedFromPush (BillBoard/WeeklyDigest), a count beside WeeklyBriefPushesSent. The
 * metric line carries no user id, and nothing is stored.
 */
const countPushOpen = (event: APIGatewayProxyEvent): void => {
  if (event?.queryStringParameters?.trigger?.trim() !== "push") return;
  emitEmbeddedMetrics(METRIC_NAMESPACE, [{ name: "WeeklyBriefOpenedFromPush", value: 1 }]);
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  logger.resetContext();
  try {
    const userId = getAuthenticatedUserId(event);
    if (!userId) {
      return jsonResponse(401, { message: "Unauthorized (missing authorizer claims)" });
    }

    countPushOpen(event);

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
