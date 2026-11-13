import { SendMessageBatchCommand, type SendMessageBatchRequestEntry, type SQSClient } from "@aws-sdk/client-sqs";
import { logger } from "./logger";
import { backoffDelayMs, sleep } from "./retry";

/** SQS allows at most 10 entries per SendMessageBatch call. */
export const SQS_MAX_BATCH_ENTRIES = 10;
/** SQS caps the whole batch payload (256 KiB historically); stay below it with room for attributes. */
const MAX_BATCH_PAYLOAD_BYTES = 240 * 1024;
const PER_ENTRY_OVERHEAD_BYTES = 1024;

export interface SendMessageBatchRetryOptions {
  /** Entries per call, 1 to 10. Defaults to 10. */
  batchSize?: number;
  /** Attempts per batch including the first. Defaults to 4 (the first plus three retries). */
  maxAttempts?: number;
  /** Backoff for the retries: full jitter from baseMs, doubling, capped at maxMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class SqsBatchSendError extends Error {
  readonly failedIds: string[];

  constructor(message: string, failedIds: string[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SqsBatchSendError";
    this.failedIds = failedIds;
  }
}

const entryBytes = (entry: SendMessageBatchRequestEntry): number =>
  Buffer.byteLength(entry.MessageBody ?? "", "utf8") + PER_ENTRY_OVERHEAD_BYTES;

/** Groups entries into calls of at most `batchSize` entries and under the batch payload limit. */
export const groupEntriesForBatches = (
  entries: readonly SendMessageBatchRequestEntry[],
  batchSize: number = SQS_MAX_BATCH_ENTRIES,
): SendMessageBatchRequestEntry[][] => {
  const limit = Math.max(1, Math.min(SQS_MAX_BATCH_ENTRIES, Math.floor(batchSize) || SQS_MAX_BATCH_ENTRIES));
  const batches: SendMessageBatchRequestEntry[][] = [];
  let current: SendMessageBatchRequestEntry[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const bytes = entryBytes(entry);
    if (current.length > 0 && (current.length >= limit || currentBytes + bytes > MAX_BATCH_PAYLOAD_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

/**
 * Sends every entry with SendMessageBatch, retrying only the entries SQS reports as failed (and a
 * call that throws) with jittered backoff. Throws SqsBatchSendError once an entry has failed
 * `maxAttempts` times, or at once for a sender fault, which a retry cannot fix. Entries sent before
 * the error stay sent, so callers must make redelivery harmless. Returns the number of entries sent.
 * Entry ids must be unique across `entries`.
 */
export const sendMessageBatchWithRetry = async (
  sqs: Pick<SQSClient, "send">,
  queueUrl: string,
  entries: readonly SendMessageBatchRequestEntry[],
  options: SendMessageBatchRetryOptions = {},
): Promise<number> => {
  const { batchSize = SQS_MAX_BATCH_ENTRIES, maxAttempts = 4, baseDelayMs = 100, maxDelayMs = 2000 } = options;
  let sent = 0;

  for (const batch of groupEntriesForBatches(entries, batchSize)) {
    let pending = batch;
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      let failureDetails: Array<{ Id?: string; Code?: string; Message?: string; SenderFault?: boolean }> = [];
      let callError: unknown;
      try {
        const response = await sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: pending }));
        failureDetails = response.Failed ?? [];
        const failedIds = new Set(failureDetails.map((failure) => failure.Id));
        sent += pending.length - pending.filter((entry) => failedIds.has(entry.Id)).length;
        pending = pending.filter((entry) => failedIds.has(entry.Id));
      } catch (error) {
        callError = error;
      }
      if (pending.length === 0) break;

      const failedIds = pending.map((entry) => entry.Id ?? "");
      const senderFault = failureDetails.some((failure) => failure.SenderFault === true);
      if (senderFault || attempt + 1 >= maxAttempts) {
        logger.error("SendMessageBatch entries failed after retries", {
          queueUrl,
          attempts: attempt + 1,
          failedIds,
          failures: failureDetails,
          error: callError,
        });
        throw new SqsBatchSendError(
          `Failed to send ${pending.length} message(s) to SQS after ${attempt + 1} attempt(s)`,
          failedIds,
          callError === undefined ? undefined : { cause: callError },
        );
      }

      logger.warn("Retrying SendMessageBatch entries", {
        queueUrl,
        attempt: attempt + 1,
        failedIds,
        failures: failureDetails,
        error: callError,
      });
      await sleep(backoffDelayMs(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs }));
    }
  }

  return sent;
};
