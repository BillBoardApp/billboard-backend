import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { mapWithConcurrency } from "./concurrency";
import { correlationIdFromRecord } from "./correlation";
import { logger } from "./logger";

interface ProcessSqsRecordsOptions {
  /** Records handled at once. Defaults to 1 (sequential, in batch order). */
  concurrency?: number;
  /** Log message used when a record fails. */
  label?: string;
}

/**
 * Runs `handleRecord` for every record and reports only the records that
 * threw as batch item failures. Requires `ReportBatchItemFailures` on the
 * event source mapping; without it Lambda treats the response as success.
 * Everything a record logs carries its `sqsMessageId` and, when the message
 * has one, its `correlationId` attribute (see shared/logger.ts).
 */
export const processSqsRecords = async (
  event: Pick<SQSEvent, "Records"> | null | undefined,
  handleRecord: (record: SQSRecord, index: number) => Promise<unknown> | unknown,
  options: ProcessSqsRecordsOptions = {},
): Promise<SQSBatchResponse> => {
  const records = event?.Records ?? [];
  const { concurrency = 1, label = "Failed to process SQS record" } = options;

  const failedFlags = await mapWithConcurrency(records, concurrency, (record, index) =>
    logger.withKeys({ sqsMessageId: record.messageId, correlationId: correlationIdFromRecord(record) }, async () => {
      try {
        await handleRecord(record, index);
        return false;
      } catch (error) {
        logger.error(label, { messageId: record.messageId, error });
        return true;
      }
    }),
  );

  const batchItemFailures: SQSBatchItemFailure[] = [];
  records.forEach((record, index) => {
    if (failedFlags[index]) batchItemFailures.push({ itemIdentifier: record.messageId });
  });
  return { batchItemFailures };
};
