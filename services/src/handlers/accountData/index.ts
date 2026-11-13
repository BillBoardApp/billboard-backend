import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  accountDeletionConfigFromEnv,
  claimDeletion,
  deleteCognitoUser,
  deleteUserData,
  deletionErrorMessage,
  markDeletionCompleted,
  markDeletionFailed,
  type AccountDeletionContext,
  type UserDataCounts,
} from "../../shared/accountDeletion";
import { loadUserEligibility } from "../../shared/adultEligibility";
import { getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";

// Tables, keys, the push-token index and USER_POOL_ID come from the environment. When USER_POOL_ID
// is unset (infra not yet updated) the Cognito user is left for the app to delete, as before.
// STATS_TABLE_NAME and FEEDBACK_BILL_ID_INDEX_NAME are no longer read (C1.6): a deleted vote leaves
// the bill stats through the UserFeedback stream; the infra keeps the variables and the BillStats
// grant until C1.6 step 2. X5: ADDRESS_CLAIMS_TABLE_NAME, SIGNUP_EMAIL_CLAIMS_TABLE_NAME and
// APP_ATTEST_TABLE_NAME each turn on one more deletion step (address claim, email claim, App Attest
// bindings); unset, that step is skipped.
const db = new DynamoDBClient({});
const deletion: AccountDeletionContext = {
  config: accountDeletionConfigFromEnv(),
  db,
  sns: new SNSClient({}),
  cognito: new CognitoIdentityProviderClient({}),
};

/**
 * App builds up to and including the one in the App Store delete the Cognito
 * user themselves after polling for "completed", and show an error (leaving the
 * session and local data behind) if it is already gone. Only delete it here for
 * clients that say they expect it.
 */
export const DELETE_SIGN_IN_HEADER = "x-billboard-delete-sign-in";
export const DELETE_SIGN_IN_QUERY_PARAM = "deleteSignIn";

/**
 * The caller's Cognito username, which keys the sign-up email claim (X5 b): `cognito:username` in an ID
 * token, `username` in an access token. Undefined when absent; the deletion then uses the `sub`, which
 * is the username in this pool.
 */
/** The authorizer fields read here: `claims` (REST API) or `jwt.claims` (HTTP API). */
type AuthorizerClaims = { claims?: Record<string, unknown>; jwt?: { claims?: Record<string, unknown> } };

function cognitoUserNameFromEvent(event: APIGatewayProxyEvent): string | undefined {
  const authorizer: AuthorizerClaims | undefined | null = event?.requestContext?.authorizer;
  const claims: Record<string, unknown> | undefined = authorizer?.claims ?? authorizer?.jwt?.claims;
  const value = claims?.["cognito:username"] ?? claims?.username;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function clientRequestsSignInDeletion(event: APIGatewayProxyEvent): boolean {
  const headers: Record<string, unknown> = event?.headers ?? {};
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === DELETE_SIGN_IN_HEADER)?.[1];
  const query = event?.queryStringParameters?.[DELETE_SIGN_IN_QUERY_PARAM];
  return [header, query].some((value) =>
    ["1", "true"].includes(
      String(value ?? "")
        .trim()
        .toLowerCase(),
    ),
  );
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getAuthenticatedUserId(event);
    if (!userId) {
      return jsonResponse(401, { message: "Unauthorized (missing authorizer claims)" });
    }

    const method = String(event?.httpMethod ?? "").toUpperCase();
    if (method !== "DELETE") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const eligibility = await loadUserEligibility({
      db,
      piiTableName: deletion.config.pii.tableName,
      piiPartitionKey: deletion.config.pii.partitionKey,
      userId,
    });

    const deleteSignIn = clientRequestsSignInDeletion(event);

    if (eligibility.deletionStatus === "completed") {
      // Earlier deletions left the Cognito user to the client; finish the job
      // if it is still there. The app deletes it itself too, so a failure here
      // is logged and the response stays as before.
      if (deleteSignIn) {
        try {
          await deleteCognitoUser(deletion, userId);
        } catch (error) {
          console.error("accountData: Cognito user deletion failed after completed data deletion", { userId, error });
        }
      }
      return jsonResponse(200, {
        deletionStatus: "completed",
        message: "Account data has already been deleted.",
      });
    }

    const requestedAt = new Date().toISOString();
    const claimed = await claimDeletion(deletion, userId, requestedAt);
    if (!claimed) {
      return jsonResponse(202, {
        deletionStatus: "in_progress",
        message: "Account deletion is already in progress.",
      });
    }

    let cognitoUserDeleted = false;
    let items: UserDataCounts;
    try {
      // Votes, preferences, devices (SNS endpoints first), weekly digests, then (X5) the address claim,
      // the sign-up email claim and the App Attest bindings. No BillStats write: the UserFeedback
      // stream recomputes the stats of each bill whose vote was removed.
      items = await deleteUserData(deletion, userId, { cognitoUserName: cognitoUserNameFromEvent(event) });
      await markDeletionCompleted(deletion, userId, requestedAt);
    } catch (error) {
      await markDeletionFailed(deletion, userId, requestedAt, deletionErrorMessage(error));
      throw error;
    }
    // Counts only, no personal data: shows which X5 steps ran (a skipped step has no count).
    console.log("accountData: account data deleted", { userId, items });

    // Last, and outside the block above: the data is already gone and the status is
    // "completed", so a Cognito failure must not overwrite it with "failed". The
    // client still deletes the sign-in itself when the response says it is left.
    if (deleteSignIn) {
      try {
        cognitoUserDeleted = await deleteCognitoUser(deletion, userId);
      } catch (error) {
        console.error("accountData: data deleted but Cognito user deletion failed; client must finish", {
          userId,
          error,
        });
      }
    }

    return jsonResponse(202, {
      deletionStatus: "completed",
      message: cognitoUserDeleted
        ? "Account data and sign-in account deleted."
        : "Account data deleted. Delete Cognito account from the client to finish account removal.",
    });
  } catch (error) {
    console.error("accountData deletion failed", error);
    return jsonResponse(500, { error: "Internal server error" });
  }
}

export default { handler };
