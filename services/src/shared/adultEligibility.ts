import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

type AdultStatus = "attested_adult" | "self_reported_under18" | "unknown";

type DeletionStatus = "not_requested" | "in_progress" | "completed" | "failed";

type UserEligibility = {
  adultStatus: AdultStatus;
  adultMethod: string | null;
  adultStatusSetAt: string | null;
  deletionStatus: DeletionStatus;
};

/** The subset of eligibility fields the block-reason checks actually read. */
type EligibilityGateInput = Pick<UserEligibility, "adultStatus" | "deletionStatus">;

type EligibilityBlockReason = "ADULT_REQUIRED" | "ACCOUNT_INELIGIBLE" | "ACCOUNT_DELETION_IN_PROGRESS";

type LoadEligibilityParams = {
  db: DynamoDBClient;
  piiTableName?: string;
  piiPartitionKey?: string;
  userId: string;
};

export function normalizeAdultStatus(value: string | undefined): AdultStatus {
  if (value === "attested_adult") return "attested_adult";
  if (value === "self_reported_under18") return "self_reported_under18";
  return "unknown";
}

export function normalizeDeletionStatus(value: string | undefined): DeletionStatus {
  if (value === "in_progress") return "in_progress";
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  return "not_requested";
}

/**
 * Loads the caller's adult-attestation and deletion state from the PII table.
 *
 * This deliberately fails closed: a missing table name or a DynamoDB error is
 * thrown to the caller (every handler wraps this in try/catch and returns 500)
 * rather than being reported as "unknown", because "unknown" means "has not
 * attested yet" and is allowed to write.
 */
export async function loadUserEligibility({
  db,
  piiTableName,
  piiPartitionKey = "userId",
  userId,
}: LoadEligibilityParams): Promise<UserEligibility> {
  if (!piiTableName) {
    throw new Error("PII table name is not configured; cannot evaluate user eligibility.");
  }

  const result = await db.send(
    new GetItemCommand({
      TableName: piiTableName,
      Key: { [piiPartitionKey]: { S: userId } },
      ConsistentRead: true,
      ProjectionExpression: "adultStatus, adultMethod, adultStatusSetAt, deletionStatus",
    }),
  );

  return {
    adultStatus: normalizeAdultStatus(result.Item?.adultStatus?.S),
    adultMethod: result.Item?.adultMethod?.S ?? null,
    adultStatusSetAt: result.Item?.adultStatusSetAt?.S ?? null,
    deletionStatus: normalizeDeletionStatus(result.Item?.deletionStatus?.S),
  };
}

export function eligibilityBlockReason(eligibility: EligibilityGateInput): EligibilityBlockReason | null {
  if (eligibility.deletionStatus === "in_progress") {
    return "ACCOUNT_DELETION_IN_PROGRESS";
  }

  if (eligibility.deletionStatus === "completed") {
    return "ACCOUNT_INELIGIBLE";
  }

  if (eligibility.adultStatus === "attested_adult") {
    return null;
  }

  if (eligibility.adultStatus === "self_reported_under18") {
    return "ACCOUNT_INELIGIBLE";
  }

  return "ADULT_REQUIRED";
}

export function writeEligibilityBlockReason(eligibility: EligibilityGateInput): EligibilityBlockReason | null {
  if (eligibility.deletionStatus === "in_progress") {
    return "ACCOUNT_DELETION_IN_PROGRESS";
  }

  if (eligibility.deletionStatus === "completed") {
    return "ACCOUNT_INELIGIBLE";
  }

  if (eligibility.adultStatus === "self_reported_under18") {
    return "ACCOUNT_INELIGIBLE";
  }

  return null;
}

export function toForbiddenResponse(reason: EligibilityBlockReason) {
  if (reason === "ACCOUNT_INELIGIBLE") {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "ACCOUNT_INELIGIBLE",
        message: "Account is not eligible for this action.",
      }),
    };
  }

  if (reason === "ACCOUNT_DELETION_IN_PROGRESS") {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "ACCOUNT_DELETION_IN_PROGRESS",
        message: "Account deletion is currently in progress.",
      }),
    };
  }

  return {
    statusCode: 403,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      error: "ADULT_REQUIRED",
      message: "Adult attestation is required before using this action.",
    }),
  };
}
