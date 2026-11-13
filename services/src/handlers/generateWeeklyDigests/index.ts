import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { ScheduledEvent } from "aws-lambda";
import { correlationIdMessageAttributes, mintCorrelationId } from "../../shared/correlation";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { putMetric, putMetrics } from "../../shared/metrics";
import { sleep } from "../../shared/retry";
import {
  WEEKLY_DIGEST_USER_CONCURRENCY,
  WEEKLY_DIGEST_USERS_PER_MESSAGE,
  createWeeklyDigestGenerationContext,
  generateWeeklyDigestsForUsers,
  listAllWeeklyDigestUserIds,
  type WeeklyDigestWorkMessage,
} from "../../shared/weeklyDigestGeneration";
import { latestPublishedWindow } from "../../shared/weeklyDigestSchedule";

const WEEKLY_DIGEST_METRIC_NAMESPACE = "BillBoard/WeeklyDigest";

/**
 * Lambda time kept in hand by the inline pass: no new user starts once less than this remains,
 * so the pass stops and throws (and the async retry resumes) instead of hitting the timeout.
 */
export const INLINE_TIME_RESERVE_MS = 60_000;

// SendMessageBatch takes at most 10 entries. Entries that fail are resent up to
// SEND_MAX_ATTEMPTS times in all, with a short linear backoff.
const SEND_BATCH_MAX_ENTRIES = 10;
const SEND_MAX_ATTEMPTS = 3;
const SEND_RETRY_BASE_MS = 200;

let sqs: SQSClient | undefined;

/** A manual run can name users at the top level or in `detail`: { userId } or { userIds: [...] }. */
type TargetedUsers = { userId?: unknown; userIds?: unknown };

type InvocationContext = LambdaContextLike & { getRemainingTimeInMillis?: () => number };

type JsonResult = { statusCode: number; headers: Record<string, string>; body: string };

function json(statusCode: number, body: unknown): JsonResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function requestedUserIds(event: Record<string, unknown> | null | undefined): string[] {
  const candidates = [
    event?.userId,
    event?.userIds,
    (event?.detail as Record<string, unknown> | undefined)?.userId,
    (event?.detail as Record<string, unknown> | undefined)?.userIds,
  ];

  const values = new Set<string>();

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) {
        values.add(trimmed);
      }
      continue;
    }

    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (typeof entry !== "string") {
          continue;
        }

        const trimmed = entry.trim();
        if (trimmed) {
          values.add(trimmed);
        }
      }
    }
  }

  return Array.from(values);
}

type OutgoingEntry = { id: string; message: WeeklyDigestWorkMessage; correlationId: string };

/** Sends `entries` in one SendMessageBatch call and returns the entries that were not accepted. */
async function sendBatchOnce(queueUrl: string, entries: OutgoingEntry[]): Promise<OutgoingEntry[]> {
  try {
    sqs ??= new SQSClient({});
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: entries.map((entry) => ({
          Id: entry.id,
          MessageBody: JSON.stringify(entry.message),
          ...correlationIdMessageAttributes(entry.correlationId),
        })),
      }),
    );

    const failures = response.Failed ?? [];
    if (failures.length === 0) {
      return [];
    }

    logger.warn("Weekly digest work messages were not accepted", {
      failures: failures.map((failure) => ({
        id: failure.Id,
        code: failure.Code,
        senderFault: failure.SenderFault,
        reason: failure.Message,
      })),
    });
    const failedIds = new Set(failures.map((failure) => failure.Id));
    return entries.filter((entry) => failedIds.has(entry.id));
  } catch (error) {
    logger.warn("SendMessageBatch for weekly digest work messages failed", { entries: entries.length, error });
    return entries;
  }
}

/** Enqueues every message, retrying rejected entries; returns the messages that still failed. */
async function enqueueWorkMessages(
  queueUrl: string,
  messages: WeeklyDigestWorkMessage[],
  runStartedAt: Date,
): Promise<WeeklyDigestWorkMessage[]> {
  const failed: WeeklyDigestWorkMessage[] = [];

  for (let start = 0; start < messages.length; start += SEND_BATCH_MAX_ENTRIES) {
    let pending: OutgoingEntry[] = messages.slice(start, start + SEND_BATCH_MAX_ENTRIES).map((message, offset) => ({
      id: `m${start + offset}`,
      message,
      correlationId: mintCorrelationId(`weekly-digest-${start + offset + 1}`, runStartedAt),
    }));

    for (let attempt = 1; pending.length > 0 && attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        await sleep(SEND_RETRY_BASE_MS * (attempt - 1));
      }
      pending = await sendBatchOnce(queueUrl, pending);
    }

    failed.push(...pending.map((entry) => entry.message));
  }

  return failed;
}

/**
 * Fan-out (CAP-03): list every user and enqueue them for weeklyDigestWorker in messages of
 * WEEKLY_DIGEST_USERS_PER_MESSAGE users. If some messages still cannot be sent after retries the
 * run throws, so the async retry plans again; that is safe because the worker skips users whose
 * snapshot for the window already exists.
 */
async function planFanOut(queueUrl: string): Promise<JsonResult> {
  const runStartedAt = new Date();
  const window = latestPublishedWindow(runStartedAt);
  const userIds = await listAllWeeklyDigestUserIds();

  const messages: WeeklyDigestWorkMessage[] = [];
  for (let start = 0; start < userIds.length; start += WEEKLY_DIGEST_USERS_PER_MESSAGE) {
    messages.push({ windowId: window.id, userIds: userIds.slice(start, start + WEEKLY_DIGEST_USERS_PER_MESSAGE) });
  }

  const failedMessages = await enqueueWorkMessages(queueUrl, messages, runStartedAt);
  const failedUsers = failedMessages.reduce((total, message) => total + message.userIds.length, 0);
  const enqueuedUsers = userIds.length - failedUsers;

  const summary = {
    mode: "fan-out",
    releaseAt: window.releaseAt.toISOString(),
    windowId: window.id,
    userCount: userIds.length,
    messageCount: messages.length,
    enqueuedUsers,
    failedMessages: failedMessages.length,
    failedUsers,
  };

  await putMetric(WEEKLY_DIGEST_METRIC_NAMESPACE, "WeeklyDigestUsersEnqueued", enqueuedUsers);

  if (failedMessages.length > 0) {
    logger.error("generateWeeklyDigests could not enqueue every user", summary);
    throw new Error(
      `generateWeeklyDigests could not enqueue ${failedUsers} of ${userIds.length} users in ${failedMessages.length} messages (release ${summary.releaseAt})`,
    );
  }

  logger.info("generateWeeklyDigests enqueued users", summary);
  return json(200, summary);
}

/**
 * Inline pass: a targeted run, or a full run when no queue is configured. Generates up to
 * WEEKLY_DIGEST_USER_CONCURRENCY users at once and stops starting users once less than
 * INLINE_TIME_RESERVE_MS remains. If any user fails, or the pass stopped early, it throws so
 * the invocation counts as a Lambda error and the async retry runs it again; a rerun skips
 * users whose snapshot already exists, and the snapshot write is conditional.
 */
async function runInline(targetedUserIds: string[], lambdaContext?: InvocationContext): Promise<JsonResult> {
  const context = await createWeeklyDigestGenerationContext(new Date());
  const userIds = targetedUserIds.length > 0 ? targetedUserIds : await listAllWeeklyDigestUserIds();
  const remainingMs = lambdaContext?.getRemainingTimeInMillis?.bind(lambdaContext);

  const result = await generateWeeklyDigestsForUsers(userIds, context, {
    concurrency: WEEKLY_DIGEST_USER_CONCURRENCY,
    shouldStart: () => !remainingMs || remainingMs() > INLINE_TIME_RESERVE_MS,
  });

  const summary = {
    releaseAt: context.window.releaseAt.toISOString(),
    userCount: userIds.length,
    stored: result.stored,
    existing: result.existing,
    empty: result.empty,
    failed: result.failed,
  };
  const log = result.failed > 0 || result.notStarted > 0 ? logger.error.bind(logger) : logger.info.bind(logger);
  log("generateWeeklyDigests summary", {
    mode: targetedUserIds.length > 0 ? "targeted" : "inline",
    ...summary,
    notStarted: result.notStarted,
  });

  // Emitted whenever the pass gets through its users (or stops early), zero included.
  await putMetrics(WEEKLY_DIGEST_METRIC_NAMESPACE, [
    { name: "WeeklyDigestUsersFailed", value: result.failed },
    { name: "WeeklyDigestUsersProcessed", value: result.stored + result.existing + result.empty },
  ]);

  // Throw rather than return an error body: the invocation must count as a Lambda error
  // (alarms) and trigger the async retry.
  if (result.notStarted > 0) {
    throw new Error(
      `generateWeeklyDigests stopped before the Lambda timeout with ${result.notStarted} of ${userIds.length} users not started and ${result.failed} failed (release ${summary.releaseAt}); the retry resumes`,
    );
  }

  if (result.failed > 0) {
    throw new Error(
      `generateWeeklyDigests failed for ${result.failed} of ${userIds.length} users (release ${summary.releaseAt})`,
    );
  }

  return json(200, summary);
}

/**
 * The Sunday schedule's target. With WEEKLY_DIGEST_QUEUE_URL set and no users named in the event,
 * it plans: it enqueues every user for weeklyDigestWorker and returns. A run that names users,
 * or any run while the queue is not configured, generates the digests inline.
 */
export async function handler(
  event: ScheduledEvent<TargetedUsers> | TargetedUsers,
  lambdaContext?: InvocationContext,
): Promise<JsonResult> {
  logger.resetContext(lambdaContext);
  try {
    const targetedUserIds = requestedUserIds(event as Record<string, unknown>);
    const queueUrl = process.env.WEEKLY_DIGEST_QUEUE_URL?.trim();

    if (queueUrl && targetedUserIds.length === 0) {
      return await planFanOut(queueUrl);
    }

    return await runInline(targetedUserIds, lambdaContext);
  } catch (error) {
    logger.error("generateWeeklyDigests failed", { error });
    throw error;
  }
}

export default { handler };
