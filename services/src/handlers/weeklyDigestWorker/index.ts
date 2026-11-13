import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { putMetrics } from "../../shared/metrics";
import { processSqsRecords } from "../../shared/sqsBatch";
import {
  WEEKLY_DIGEST_USER_CONCURRENCY,
  generateWeeklyDigestsForUsers,
  parseWeeklyDigestWorkMessage,
  sharedWeeklyDigestGenerationContext,
  weeklyDigestWindowFromId,
} from "../../shared/weeklyDigestGeneration";

const WEEKLY_DIGEST_METRIC_NAMESPACE = "BillBoard/WeeklyDigest";

interface MessageOutcome {
  windowId?: string;
  userCount: number;
  stored: number;
  existing: number;
  empty: number;
  failed: number;
  error?: unknown;
}

/** Generates the digests one message asks for. Never throws; failures are counted in the outcome. */
async function generateForMessage(record: SQSRecord): Promise<MessageOutcome> {
  const outcome: MessageOutcome = { userCount: 0, stored: 0, existing: 0, empty: 0, failed: 0 };

  try {
    const message = parseWeeklyDigestWorkMessage(record.body);
    outcome.windowId = message.windowId;
    outcome.userCount = message.userIds.length;

    const window = weeklyDigestWindowFromId(message.windowId);
    if (!window) {
      throw new Error(`Weekly digest work message has an unknown window id ${message.windowId}`);
    }

    const context = await sharedWeeklyDigestGenerationContext(window);
    const result = await generateWeeklyDigestsForUsers(message.userIds, context, {
      concurrency: WEEKLY_DIGEST_USER_CONCURRENCY,
    });
    outcome.stored = result.stored;
    outcome.existing = result.existing;
    outcome.empty = result.empty;
    outcome.failed = result.failed;
    if (result.failed > 0) {
      outcome.error = new Error(
        `Weekly digest failed for ${result.failed} of ${message.userIds.length} users (window ${message.windowId})`,
      );
    }
  } catch (error) {
    // Nothing was generated (unreadable message, unknown window, or the shared inputs failed to
    // load): count every user in the message, or the message itself when it cannot be read.
    outcome.failed = Math.max(outcome.userCount, 1);
    outcome.error = error;
  }

  return outcome;
}

async function processMessage(record: SQSRecord): Promise<void> {
  const outcome = await generateForMessage(record);
  const { error, ...counts } = outcome;
  const summary = { ...counts, processed: counts.stored + counts.existing + counts.empty };

  if (counts.failed > 0) {
    logger.error("weeklyDigestWorker message summary", summary);
  } else {
    logger.info("weeklyDigestWorker message summary", summary);
  }

  // One datum of each per message, zero included.
  await putMetrics(WEEKLY_DIGEST_METRIC_NAMESPACE, [
    { name: "WeeklyDigestUsersFailed", value: counts.failed },
    { name: "WeeklyDigestUsersProcessed", value: summary.processed },
  ]);

  // Any failed user fails the whole message. The retry is cheap: users whose snapshot for the
  // window already exists are skipped, and the snapshot write is conditional.
  if (counts.failed > 0) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Consumes the weekly digest work queue (CAP-03). Each message names a publication window and up
 * to 25 users; the planner (generateWeeklyDigests) sends them every Sunday. Needs
 * ReportBatchItemFailures on the event source mapping: a message with any failed user is reported
 * as a batch item failure and redelivered, and after maxReceiveCount it goes to the DLQ.
 */
export const handler = async (event: SQSEvent, context?: LambdaContextLike): Promise<SQSBatchResponse> => {
  logger.resetContext(context);
  return processSqsRecords(event, processMessage, { label: "Weekly digest work message failed" });
};

export default { handler };
