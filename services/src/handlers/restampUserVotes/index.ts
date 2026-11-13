import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import {
  ACCOUNT_INTEGRITY_METRIC_NAMESPACE,
  parseRestampMessage,
  sameVerificationStamp,
  verificationStampFromPii,
  type VerificationStamp,
} from "../../shared/addressClaims";
import { normalizeDeletionStatus } from "../../shared/adultEligibility";
import { mapWithConcurrency } from "../../shared/concurrency";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";
import { processSqsRecords } from "../../shared/sqsBatch";

/**
 * RestampUserVotes (INT-03, C2 3.3.4 with X8). For each `{"userId": "<sub>"}` message from
 * RestampUserVotesQueue (sent by DistrictVerification when an account's verification changes, or
 * by hand with `aws sqs send-message`), rewrites the verification stamp of the account's stored
 * votes so it matches the account's UserPII row now: `constituentVerified`, `verificationStatus`,
 * and `resolvedState`/`resolvedDistrict` when verified (removed when not), with
 * `effectiveWeight = 1`. The feedback stream then recomputes the touched bills' stats through
 * BillStatsAggregator.
 *
 * VOTE_RESTAMP_MODE (X8): `apply` writes; anything else (unset included) is `plan`, which reads the
 * same rows, logs the ones it would change and emits `VotesRestampPlanned`, and writes nothing.
 *
 * Legacy unstamped rows (neither `constituentVerified` nor `verificationStatus`: the 343 votes
 * written before SetFeedback stamped votes, C2 section 2) are never planned or rewritten; they are
 * only counted in `legacyUnstamped`. The stats count them as unverified with no state, as they
 * always have, so a message for an account whose stamped votes already match writes nothing, and
 * stamping them would change published numbers outside any verification change (project decision).
 *
 * Idempotent: a rerun or a redrive converges on the current UserPII row. An account with no
 * UserPII row, or whose deletion is in progress or completed, is skipped (deletion removes the
 * votes). A vote deleted meanwhile is not recreated (`attribute_exists` condition). A record fails
 * (and is retried, then lands in RestampUserVotesDLQ) only on an unreadable message, missing
 * configuration or a DynamoDB error.
 *
 * Env: PII_TABLE_NAME, PII_PARTITION_KEY (default userId), FEEDBACK_TABLE_NAME,
 * FEEDBACK_PARTITION_KEY (default userId), FEEDBACK_SORT_KEY (default billId), VOTE_RESTAMP_MODE.
 * IAM: GetItem on UserPII; Query and UpdateItem on UserFeedback.
 */

export type VoteRestampMode = "plan" | "apply";

/** VOTE_RESTAMP_MODE: `apply`, or `plan` for anything else. */
export const voteRestampMode = (value: string | undefined = process.env.VOTE_RESTAMP_MODE): VoteRestampMode =>
  value === "apply" ? "apply" : "plan";

/** Conditional vote updates in flight at once. */
export const RESTAMP_UPDATE_CONCURRENCY = 8;
/** Planned rows per log line in plan mode. */
const PLANNED_ROWS_PER_LOG_LINE = 100;

const METRIC_VOTES_RESTAMPED = "VotesRestamped";
const METRIC_VOTES_RESTAMP_PLANNED = "VotesRestampPlanned";

type Item = Record<string, AttributeValue>;
type Db = Pick<DynamoDBClient, "send">;

export interface RestampConfig {
  pii: { tableName: string; partitionKey: string };
  feedback: { tableName: string; partitionKey: string; sortKey: string };
  mode: VoteRestampMode;
}

type Env = Record<string, string | undefined>;

/** The tables and mode from the environment; throws when a table name is missing. */
export function restampConfigFromEnv(env: Env = process.env): RestampConfig {
  const piiTable = env.PII_TABLE_NAME?.trim();
  const feedbackTable = env.FEEDBACK_TABLE_NAME?.trim();
  if (!piiTable || !feedbackTable) {
    throw new Error("PII_TABLE_NAME and FEEDBACK_TABLE_NAME must be configured for restampUserVotes.");
  }
  return {
    pii: { tableName: piiTable, partitionKey: env.PII_PARTITION_KEY?.trim() || "userId" },
    feedback: {
      tableName: feedbackTable,
      partitionKey: env.FEEDBACK_PARTITION_KEY?.trim() || "userId",
      sortKey: env.FEEDBACK_SORT_KEY?.trim() || "billId",
    },
    mode: voteRestampMode(env.VOTE_RESTAMP_MODE),
  };
}

export type RestampOutcome = "skipped_no_profile" | "skipped_deletion" | "planned" | "applied";

export interface RestampResult {
  outcome: RestampOutcome;
  /** Vote rows read. */
  votes: number;
  /** Rows whose stamp differs from the target (planned in plan mode). */
  differing: number;
  /** Rows rewritten (apply mode). */
  updated: number;
  /** Rows deleted between the read and the update, so left alone (apply mode). */
  vanished: number;
  /** Legacy rows with no stamp at all, never planned or rewritten (see the module comment). */
  legacyUnstamped: number;
  /** Whether the target stamp is verified (unset when skipped). The district is never logged. */
  targetVerified?: boolean;
}

const STAMP_FIELDS = ["constituentVerified", "verificationStatus", "resolvedState", "resolvedDistrict"] as const;

/** A vote written before SetFeedback stamped votes: it carries no stamp field at all. */
const isLegacyUnstampedRow = (row: Item): boolean =>
  row.constituentVerified === undefined && row.verificationStatus === undefined;

/** The stamp a vote row carries, as stored (no defaults, so a missing field reads as different). */
function stampOfVoteRow(row: Item): VerificationStamp {
  const stamp: VerificationStamp = {
    constituentVerified: row.constituentVerified?.BOOL === true,
    verificationStatus: row.verificationStatus?.S ?? "",
  };
  if (row.resolvedState?.S) stamp.resolvedState = row.resolvedState.S;
  if (row.resolvedDistrict?.S) stamp.resolvedDistrict = row.resolvedDistrict.S;
  return stamp;
}

/** The stamp fields that differ between a row and the target (names only; no values are logged). */
function changedFields(from: VerificationStamp, to: VerificationStamp): string[] {
  return STAMP_FIELDS.filter((field) => (from[field] ?? null) !== (to[field] ?? null));
}

async function updateVoteRow(
  db: Db,
  config: RestampConfig,
  userId: string,
  billId: string,
  target: VerificationStamp,
): Promise<"updated" | "vanished"> {
  const set = [
    "constituentVerified = :constituentVerified",
    "verificationStatus = :verificationStatus",
    "effectiveWeight = :one",
  ];
  const remove: string[] = [];
  const values: Item = {
    ":constituentVerified": { BOOL: target.constituentVerified },
    ":verificationStatus": { S: target.verificationStatus },
    ":one": { N: "1" },
  };
  for (const field of ["resolvedState", "resolvedDistrict"] as const) {
    const value = target[field];
    if (value) {
      set.push(`${field} = :${field}`);
      values[`:${field}`] = { S: value };
    } else {
      remove.push(field);
    }
  }

  try {
    await db.send(
      new UpdateItemCommand({
        TableName: config.feedback.tableName,
        Key: {
          [config.feedback.partitionKey]: { S: userId },
          [config.feedback.sortKey]: { S: billId },
        },
        UpdateExpression: `SET ${set.join(", ")}${remove.length ? ` REMOVE ${remove.join(", ")}` : ""}`,
        ConditionExpression: "attribute_exists(#pk)",
        ExpressionAttributeNames: { "#pk": config.feedback.partitionKey },
        ExpressionAttributeValues: values,
      }),
    );
    return "updated";
  } catch (error) {
    if ((error as { name?: string })?.name === "ConditionalCheckFailedException") return "vanished";
    throw error;
  }
}

/**
 * Re-stamps one account's votes from its UserPII row (see the module comment). Reads the votes a
 * Query page at a time and, in apply mode, updates the differing rows of each page with at most
 * RESTAMP_UPDATE_CONCURRENCY in flight.
 */
export async function restampUserVotes(db: Db, config: RestampConfig, userId: string): Promise<RestampResult> {
  const result: RestampResult = {
    outcome: "planned",
    votes: 0,
    differing: 0,
    updated: 0,
    vanished: 0,
    legacyUnstamped: 0,
  };

  const profile = await db.send(
    new GetItemCommand({
      TableName: config.pii.tableName,
      Key: { [config.pii.partitionKey]: { S: userId } },
      ConsistentRead: true,
      ProjectionExpression: "constituentVerified, verificationStatus, resolvedState, resolvedDistrict, deletionStatus",
    }),
  );
  const item = profile.Item;
  if (!item) return { ...result, outcome: "skipped_no_profile" };
  const deletion = normalizeDeletionStatus(item.deletionStatus?.S);
  if (deletion === "in_progress" || deletion === "completed") return { ...result, outcome: "skipped_deletion" };

  const target = verificationStampFromPii(item);
  result.outcome = config.mode === "apply" ? "applied" : "planned";
  result.targetVerified = target.constituentVerified;
  const { tableName, partitionKey, sortKey } = config.feedback;

  let startKey: Item | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": partitionKey, "#sk": sortKey },
        ExpressionAttributeValues: { ":pk": { S: userId } },
        ProjectionExpression: "#pk, #sk, constituentVerified, verificationStatus, resolvedState, resolvedDistrict",
        ExclusiveStartKey: startKey,
      }),
    );

    const differing: Array<{ billId: string; changes: string[] }> = [];
    for (const row of page.Items ?? []) {
      const billId = row[sortKey]?.S;
      if (!billId) continue;
      result.votes += 1;
      if (isLegacyUnstampedRow(row)) {
        result.legacyUnstamped += 1;
        continue;
      }
      const stamp = stampOfVoteRow(row);
      if (!sameVerificationStamp(stamp, target)) differing.push({ billId, changes: changedFields(stamp, target) });
    }
    result.differing += differing.length;

    if (config.mode === "apply") {
      const outcomes = await mapWithConcurrency(differing, RESTAMP_UPDATE_CONCURRENCY, (row) =>
        updateVoteRow(db, config, userId, row.billId, target),
      );
      for (const outcome of outcomes) {
        if (outcome === "updated") result.updated += 1;
        else result.vanished += 1;
      }
    } else {
      for (let start = 0; start < differing.length; start += PLANNED_ROWS_PER_LOG_LINE) {
        logger.info("Vote re-stamp planned rows", {
          voteRestampMode: config.mode,
          rows: differing.slice(start, start + PLANNED_ROWS_PER_LOG_LINE),
        });
      }
    }

    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return result;
}

const db = new DynamoDBClient({});

export async function handler(event: SQSEvent, context?: LambdaContextLike): Promise<SQSBatchResponse> {
  logger.resetContext(context);
  return processSqsRecords(
    event,
    async (record) => {
      const userId = parseRestampMessage(record.body);
      if (!userId) throw new Error('Re-stamp message must be {"userId": "<sub>"}');
      const config = restampConfigFromEnv();

      await logger.withKeys({ userId }, async () => {
        const result = await restampUserVotes(db, config, userId);
        logger.info("Vote re-stamp summary", { voteRestampMode: config.mode, ...result });
        if (result.outcome === "applied") {
          emitEmbeddedMetric(ACCOUNT_INTEGRITY_METRIC_NAMESPACE, METRIC_VOTES_RESTAMPED, result.updated, {
            properties: { voteRestampMode: config.mode },
          });
        } else if (result.outcome === "planned") {
          emitEmbeddedMetric(ACCOUNT_INTEGRITY_METRIC_NAMESPACE, METRIC_VOTES_RESTAMP_PLANNED, result.differing, {
            properties: { voteRestampMode: config.mode },
          });
        }
      });
    },
    { label: "Vote re-stamp failed" },
  );
}

export default { handler };
