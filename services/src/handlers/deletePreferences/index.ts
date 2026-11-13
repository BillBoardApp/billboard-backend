import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { loadUserEligibility, toForbiddenResponse, writeEligibilityBlockReason } from "../../shared/adultEligibility";
import { getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";
import { batchWriteAll } from "../../shared/dynamoBatchWrite";
import {
  PreferenceMutationError,
  buildPreferenceDeleteRequests,
  findStoredBillGuids,
  parsePreferenceMutationBody,
} from "../../shared/userPreferenceMutations";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY!;
const PII_TABLE_NAME = process.env.PII_TABLE_NAME;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? PARTITION_KEY;

const db = new DynamoDBClient({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = getAuthenticatedUserId(event);

    if (!userId) {
      return jsonResponse(401, { message: "Unauthorized (missing authorizer claims)" });
    }

    const eligibility = await loadUserEligibility({
      db,
      piiTableName: PII_TABLE_NAME,
      piiPartitionKey: PII_PARTITION_KEY,
      userId,
    });
    const blockedReason = writeEligibilityBlockReason(eligibility);
    if (blockedReason) {
      return toForbiddenResponse(blockedReason);
    }

    try {
      const preferences = parsePreferenceMutationBody(event.body, PARTITION_KEY);
      // A bill's rows under a legacy id (REL-42), which the app no longer names, go with its plain row.
      const storedBillGuids = await findStoredBillGuids({
        db,
        tableName: TABLE_NAME,
        partitionKey: PARTITION_KEY,
        sortKey: SORT_KEY,
        userId,
        preferences,
      });
      const requests = buildPreferenceDeleteRequests({
        userId,
        partitionKey: PARTITION_KEY,
        sortKey: SORT_KEY,
        preferences,
        storedBillGuids,
      });

      await batchWriteAll({
        db,
        tableName: TABLE_NAME,
        requests,
      });

      return jsonResponse(200, {
        message: "Preferences deleted",
        count: preferences.length,
      });
    } catch (error) {
      if (error instanceof PreferenceMutationError) {
        return jsonResponse(error.statusCode, error.body);
      }
      throw error;
    }
  } catch (error) {
    console.error(error);
    return jsonResponse(500, { message: "Internal Server Error" });
  }
};
