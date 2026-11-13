import { UpdateItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { VOTE_DAILY_LIMIT } from "./abuseLimits";
import { logger } from "./logger";
import { emitEmbeddedMetrics, type EmbeddedMetricInput } from "./metrics";

/**
 * INT-06: at most VOTE_DAILY_LIMIT vote writes per account per UTC day (C2 3.2).
 *
 * The counter lives on the caller's UserPII row: `voteDay` (S, YYYY-MM-DD UTC) and `voteDayCount` (N).
 * SetFeedback counts every vote write it is about to make (new, changed or Abstain) after the body
 * validation, the manifest check and the eligibility check, and before its PutItem:
 *   1. SET voteDayCount = voteDayCount + 1 if voteDay = today;
 *   2. otherwise SET voteDay = today, voteDayCount = 1 if voteDay is absent or another day (this creates
 *      the PII row of a user who has none; such a row reads everywhere as an unverified, eligible user);
 *   3. if a concurrent request reset the day in between, step 1 once more; if that fails too, throw.
 * Both conditions also require that the row is not being deleted (deletionStatus in_progress or
 * completed), so a deletion that lands after SetFeedback's eligibility read neither gets a counter
 * written onto its tombstone nor a vote written after it.
 *
 * VOTE_DAILY_CAP_MODE (SetFeedback): "watch" counts and emits VoteDailyCapExceeded but
 * never refuses, and a counter failure lets the vote through (VoteDailyCapError); "enforce" (flip PR)
 * answers 429 VOTE_DAILY_LIMIT with Retry-After over the limit, and 500 when the counter cannot be
 * updated. Any other value means watch.
 *
 * Metrics go to BillBoard/AccountIntegrity as EMF lines without dimensions (no IAM needed); the
 * Billboard-Integrity-VoteDailyCapExceeded and -VoteVelocity alarms read VoteDailyCapExceeded and
 * VotesCast. Each line carries userId (the Cognito sub), voteDay and voteDayCount, so Logs Insights
 * can answer the flip condition (the most writes any account made on any day) from a watch period.
 *
 * VOTE_DAILY_LIMIT lives in abuseLimits.ts and is re-exported here.
 */

export { VOTE_DAILY_LIMIT };
export const ACCOUNT_INTEGRITY_METRIC_NAMESPACE = "BillBoard/AccountIntegrity";
export const VOTE_DAILY_CAP_EXCEEDED_METRIC = "VoteDailyCapExceeded";
export const VOTES_CAST_METRIC = "VotesCast";
export const VOTE_DAILY_CAP_ERROR_METRIC = "VoteDailyCapError";
export const VOTE_DAILY_LIMIT_ERROR = "VOTE_DAILY_LIMIT";
export const VOTE_DAILY_LIMIT_MESSAGE = `You've reached today's limit of ${VOTE_DAILY_LIMIT} votes. You can vote again after midnight UTC.`;

export type VoteDailyCapMode = "watch" | "enforce";

/** "enforce" only when the value says so (case and surrounding spaces ignored); anything else is "watch". */
export function parseVoteDailyCapMode(raw: string | undefined | null): VoteDailyCapMode {
  return typeof raw === "string" && raw.trim().toLowerCase() === "enforce" ? "enforce" : "watch";
}

/** The UTC day of `now` as YYYY-MM-DD. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whole seconds from `now` to the next UTC midnight (1 to 86400): the 429's Retry-After. */
export function secondsUntilNextUtcMidnight(now: Date): number {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000));
}

/** Thrown when the counter could not be updated after the concurrent-reset retry (step 3). */
export class VoteDailyCapConflictError extends Error {
  constructor(message = "The daily vote counter kept changing under the update") {
    super(message);
    this.name = "VoteDailyCapConflictError";
  }
}

type DeletingStatus = "in_progress" | "completed";

export type VoteDayCount =
  | { kind: "counted"; voteDay: string; voteDayCount: number }
  /** The PII row is being deleted or was deleted: nothing was written. */
  | { kind: "account_deleting"; deletionStatus: DeletingStatus };

export type CountVoteWriteParams = {
  db: Pick<DynamoDBClient, "send">;
  /** The UserPII table. */
  tableName: string;
  /** Its partition key (the user id). */
  partitionKey: string;
  userId: string;
  now?: Date;
};

const NAMES = { "#voteDay": "voteDay", "#voteDayCount": "voteDayCount", "#deletionStatus": "deletionStatus" };
const NOT_DELETING =
  "(attribute_not_exists(#deletionStatus) OR (#deletionStatus <> :deletionInProgress AND #deletionStatus <> :deletionCompleted))";
const SAME_DAY_CONDITION = `#voteDay = :today AND ${NOT_DELETING}`;
const NEW_DAY_CONDITION = `(attribute_not_exists(#voteDay) OR #voteDay <> :today) AND ${NOT_DELETING}`;

function isConditionalCheckFailed(error: unknown): error is { name: string; Item?: Record<string, AttributeValue> } {
  return (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";
}

/** The deletion status of the row a failed condition returned (ALL_OLD), when it blocks writes. */
function deletingStatusOf(error: { Item?: Record<string, AttributeValue> }): DeletingStatus | null {
  const status = error.Item?.deletionStatus?.S;
  return status === "in_progress" || status === "completed" ? status : null;
}

/**
 * Counts one vote write for `userId` on its UserPII row (steps 1 to 3 above) and returns the day's
 * count after it. Throws VoteDailyCapConflictError when step 3 fails too, and any other DynamoDB error
 * as it is. Makes 1 UpdateItem normally, 2 on the first vote of a day, at most 3.
 */
export async function countVoteWrite({
  db,
  tableName,
  partitionKey,
  userId,
  now = new Date(),
}: CountVoteWriteParams): Promise<VoteDayCount> {
  const today = utcDay(now);
  const key = { [partitionKey]: { S: userId } };
  const values = {
    ":today": { S: today },
    ":one": { N: "1" },
    ":deletionInProgress": { S: "in_progress" },
    ":deletionCompleted": { S: "completed" },
  };

  const update = async (
    UpdateExpression: string,
    ConditionExpression: string,
  ): Promise<{ count: number } | { deleting: DeletingStatus } | null> => {
    try {
      const result = await db.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression,
          ConditionExpression,
          ExpressionAttributeNames: NAMES,
          ExpressionAttributeValues: values,
          ReturnValues: "UPDATED_NEW",
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      const count = Number(result.Attributes?.voteDayCount?.N);
      return { count: Number.isFinite(count) ? count : 1 };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      const deleting = deletingStatusOf(error);
      return deleting ? { deleting } : null;
    }
  };

  const increment = () => update("SET #voteDayCount = #voteDayCount + :one", SAME_DAY_CONDITION);
  const resetDay = () => update("SET #voteDay = :today, #voteDayCount = :one", NEW_DAY_CONDITION);

  const outcome = (await increment()) ?? (await resetDay()) ?? (await increment());
  if (!outcome) throw new VoteDailyCapConflictError();
  if ("deleting" in outcome) return { kind: "account_deleting", deletionStatus: outcome.deleting };
  return { kind: "counted", voteDay: today, voteDayCount: outcome.count };
}

export type VoteDailyCapDecision =
  /** Write the vote. voteDayCount is null when the counter failed in watch mode. */
  | { action: "write"; voteDay: string; voteDayCount: number | null; overLimit: boolean }
  /** Enforce only: over the limit; answer voteDailyLimitResponse(retryAfterSeconds). */
  | { action: "refuse_limit"; voteDay: string; voteDayCount: number; retryAfterSeconds: number }
  /** The account is being deleted (both modes, as the eligibility check would): answer 403. */
  | { action: "refuse_deleting"; deletionStatus: DeletingStatus }
  /** Enforce only: the counter could not be updated; answer 500 and write nothing. */
  | { action: "error"; error: unknown };

export type ApplyVoteDailyCapParams = CountVoteWriteParams & { mode: VoteDailyCapMode };

function emitIntegrity(metrics: EmbeddedMetricInput[], properties: Record<string, unknown>): void {
  emitEmbeddedMetrics(ACCOUNT_INTEGRITY_METRIC_NAMESPACE, metrics, { properties });
}

/**
 * Counts the vote write and decides what SetFeedback does with it, emitting VoteDailyCapExceeded
 * (count over the limit, both modes) or VoteDailyCapError (counter failure). Never throws.
 */
export async function applyVoteDailyCap(params: ApplyVoteDailyCapParams): Promise<VoteDailyCapDecision> {
  const { mode, userId } = params;
  const now = params.now ?? new Date();
  const voteDay = utcDay(now);

  let counted: VoteDayCount;
  try {
    counted = await countVoteWrite({ ...params, now });
  } catch (error) {
    try {
      emitIntegrity([{ name: VOTE_DAILY_CAP_ERROR_METRIC, value: 1 }], { userId, voteDay, voteDailyCapMode: mode });
      logger.warn(
        mode === "enforce"
          ? "Could not count the vote toward the daily cap; refusing it (enforce)"
          : "Could not count the vote toward the daily cap; writing it anyway (watch)",
        { userId, voteDay, voteDailyCapMode: mode, error },
      );
    } catch {
      // Logging is best effort; the decision below stands.
    }
    return mode === "enforce"
      ? { action: "error", error }
      : { action: "write", voteDay, voteDayCount: null, overLimit: false };
  }

  if (counted.kind === "account_deleting") {
    return { action: "refuse_deleting", deletionStatus: counted.deletionStatus };
  }

  const overLimit = counted.voteDayCount > VOTE_DAILY_LIMIT;
  if (overLimit) {
    emitIntegrity([{ name: VOTE_DAILY_CAP_EXCEEDED_METRIC, value: 1 }], {
      userId,
      voteDay: counted.voteDay,
      voteDayCount: counted.voteDayCount,
      voteDailyCapMode: mode,
      outcome: mode === "enforce" ? "refused" : "would_refuse",
    });
  }
  if (overLimit && mode === "enforce") {
    return {
      action: "refuse_limit",
      voteDay: counted.voteDay,
      voteDayCount: counted.voteDayCount,
      retryAfterSeconds: secondsUntilNextUtcMidnight(now),
    };
  }
  return { action: "write", voteDay: counted.voteDay, voteDayCount: counted.voteDayCount, overLimit };
}

/** VotesCast = 1 for a vote SetFeedback has written, with the day's count for the watch-period analysis. */
export function emitVoteCast(details: {
  userId: string;
  mode: VoteDailyCapMode;
  voteDay: string;
  voteDayCount: number | null;
}): void {
  emitIntegrity([{ name: VOTES_CAST_METRIC, value: 1 }], {
    userId: details.userId,
    voteDay: details.voteDay,
    voteDayCount: details.voteDayCount,
    voteDailyCapMode: details.mode,
  });
}

/** The enforce-mode 429 (OpenAPI VoteDailyLimit): ApiError VOTE_DAILY_LIMIT with Retry-After in seconds. */
export function voteDailyLimitResponse(retryAfterSeconds: number) {
  return {
    statusCode: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) },
    body: JSON.stringify({ error: VOTE_DAILY_LIMIT_ERROR, message: VOTE_DAILY_LIMIT_MESSAGE }),
  };
}
