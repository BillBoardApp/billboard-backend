import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { loadUserEligibility, toForbiddenResponse, writeEligibilityBlockReason } from "../../shared/adultEligibility";
import { getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";
import { batchWriteAll } from "../../shared/dynamoBatchWrite";
import { logger } from "../../shared/logger";
import {
  PreferenceMutationError,
  billRowItems,
  buildPreferenceDeleteRequests,
  findStoredBillGuids,
  findVotedBillGuids,
  parsePreferenceMutationBody,
  putBillRowsUnlessWatched,
  unwatchedBillSpellings,
} from "../../shared/userPreferenceMutations";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const SORT_KEY = process.env.SORT_KEY!;
const PII_TABLE_NAME = process.env.PII_TABLE_NAME;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? PARTITION_KEY;
// UX-47: unwatching a bill the caller voted on leaves the Bill row a vote saves (restoreVoterBillRows). Unset, an
// unwatch deletes the row as before.
const FEEDBACK_TABLE_NAME = process.env.FEEDBACK_TABLE_NAME?.trim();
const FEEDBACK_PARTITION_KEY = process.env.FEEDBACK_PARTITION_KEY ?? "userId";
const FEEDBACK_SORT_KEY = process.env.FEEDBACK_SORT_KEY ?? "billId";

const db = new DynamoDBClient({});

/**
 * UX-47, UX-35: after an unwatch, puts back the Bill row of each unwatched bill the caller holds a vote on, so the
 * voter keeps the pushes a vote gives (an `updated` push asking them to vote again, actions, the outcome). The row is
 * deleted first and the votes read after it, so a vote saved at any moment around the unwatch is either read here or
 * writes its own Bill row afterwards (both apps send it once the vote is stored), and the put is conditional, so a
 * watch saved again meanwhile is kept (putBillRowsUnlessWatched). Throws when the votes cannot be read or a row
 * cannot be written.
 */
async function restoreVoterBillRows(
  userId: string,
  spellings: ReadonlyMap<string, readonly string[]>,
): Promise<number> {
  if (!FEEDBACK_TABLE_NAME || spellings.size === 0) return 0;
  const voted = await findVotedBillGuids({
    db,
    feedbackTableName: FEEDBACK_TABLE_NAME,
    feedbackPartitionKey: FEEDBACK_PARTITION_KEY,
    feedbackSortKey: FEEDBACK_SORT_KEY,
    userId,
    spellings,
  });
  return putBillRowsUnlessWatched({
    db,
    tableName: TABLE_NAME,
    items: billRowItems({ userId, partitionKey: PARTITION_KEY, sortKey: SORT_KEY, guids: voted }),
  });
}

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
      try {
        const restored = await restoreVoterBillRows(userId, unwatchedBillSpellings(preferences, storedBillGuids));
        if (restored > 0) logger.info("Unwatched bills keep the voter's Bill row", { restored });
      } catch (error) {
        // The watch is deleted, but a voter's Bill row may be missing. On a 500 the app keeps the watch and saves the
        // Watch row again at its next preferences load, or the person unwatches again, which puts the Bill row back.
        logger.error("Could not restore the caller's Bill rows after an unwatch; a voted bill may have none", {
          error,
        });
        return jsonResponse(500, { message: "Internal Server Error" });
      }

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
