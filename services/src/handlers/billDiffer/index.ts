import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { BillCompanionDao, billCompanionConfigFromEnv } from "../../adapters/billCompanionDao";
import { BillStorage } from "../../adapters/billStorage";
import { ProcessedBillDao } from "../../adapters/processedBillDao";
import type { RawBill } from "../../models/bill";
import { extractIdenticalDeclarations, sameDeclaredLinks } from "../../shared/billCompanions";
import {
  reconcileProcessedBill,
  type ReconcileOutcome,
  type ReconcileResult,
  type SummarizerMessage,
} from "../../shared/billSourceReconcile";
import { correlationIdFromRecord, correlationIdMessageAttributes, mintCorrelationId } from "../../shared/correlation";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";
import { processSqsRecords } from "../../shared/sqsBatch";
import { reportUnprocessableMessage } from "../../shared/unprocessableMessages";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const QUEUE_BATCH_SIZE = Number.parseInt(process.env.QUEUE_BATCH_SIZE!, 10);
const RAW_BILLS_PREFIX = process.env.RAW_BILLS_PREFIX ?? "raw-bills/";

// Companion link-list metrics (APPF-23); embedded-metric lines, so no PutMetricData grant is needed.
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const companionDao = new BillCompanionDao(new DynamoDBClient({}), billCompanionConfigFromEnv());

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const normalizeBillGuidForKey = (guid: string): string => {
  // Keep consistent with adapters/rawBillKeys.ts
  const match = guid.match(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i);
  return match ? match[1] : guid;
};

// The bill guid a record names, or why it names none (C1.8 reports the reason).
const extractBillGuidFromRecord = (record: SQSRecord): { guid: string; reason?: string } => {
  const body = record?.body;
  if (!body) return { guid: "", reason: "empty_body" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { guid: "", reason: "invalid_json" };
  }
  const guid = toTrimmedString((parsed as { guid?: unknown } | null)?.guid);
  return guid ? { guid } : { guid: "", reason: "missing_guid" };
};

// Every message carries `correlationId` (the bill's pipeline trace id) as a message attribute.
const sendMessagesToQueue = async (queueUrl: string, bodies: string[], correlationId?: string): Promise<number> => {
  if (!queueUrl) throw new Error("Missing queue URL");
  if (bodies.length === 0) return 0;

  let enqueued = 0;
  for (let i = 0; i < bodies.length; i += QUEUE_BATCH_SIZE) {
    const batch = bodies.slice(i, i + QUEUE_BATCH_SIZE);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((body, idx) => ({
          Id: `msg-${i + idx}`,
          MessageBody: body,
          ...correlationIdMessageAttributes(correlationId),
        })),
      }),
    );

    const failedCount = response.Failed ? response.Failed.length : 0;
    if (failedCount > 0) {
      for (const failure of response.Failed ?? []) {
        logger.error("Failed to enqueue bill guid to SQS", { failure });
      }
      throw new Error(`Failed to enqueue ${failedCount} bill guid message(s) to SQS`);
    }

    enqueued += response.Successful ? response.Successful.length : batch.length;
  }

  return enqueued;
};

/** `{"guid","rawVersionId"}` to BillSummarizerQueue; rawVersionId marks the work as billDiffer's (REL-30). */
const sendToSummarizerQueue = async (message: SummarizerMessage, correlationId?: string): Promise<number> => {
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");
  return sendMessagesToQueue(QUEUE_URL, [JSON.stringify(message)], correlationId);
};

// "refreshed": the same links from a newer fetch; only the row's sourceFetchedAt moved (no metric).
type CompanionSyncOutcome = "written" | "refreshed" | "deleted" | "stale" | "unchanged" | "skipped";

const COMPANION_SYNC_METRICS: Partial<Record<CompanionSyncOutcome, string>> = {
  written: "CompanionDeclWritten",
  deleted: "CompanionDeclDeleted",
  stale: "CompanionDeclStale",
};

/**
 * Keeps the bill's companion link-list row (APPF-23) in step with its latest raw version: the
 * identical-bill links are extracted (identity from the S3 key, not metadata.guid), compared with
 * the stored row, and put or deleted only when they differ. The write is conditional on the stored
 * row not coming from newer raw data, so a stale copy (the REL-30 race, or one restored by
 * enrichOfficialVotes with its old fetchedAt) is skipped as "stale". The same links from a newer
 * fetch are written again ("refreshed") so the row's sourceFetchedAt keeps up with the latest fetch
 * that confirmed them; otherwise an older copy restored later could still remove them. DynamoDB
 * errors propagate and fail the record before anything is sent downstream. The processed bill is
 * not touched.
 */
const syncCompanionDeclaration = async (current: RawBill, key: string): Promise<CompanionSyncOutcome> => {
  const extracted = extractIdenticalDeclarations(current, key);
  if (!extracted) {
    logger.warn("Skipping companion links; the raw bill's identity could not be resolved", { key });
    return "skipped";
  }

  const stored = await companionDao.getDeclaration(extracted.guid);
  let outcome: CompanionSyncOutcome;
  if (extracted.declared.length === 0) {
    if (!stored) return "unchanged";
    outcome = await companionDao.deleteDeclaration(extracted.guid, extracted.sourceFetchedAt);
  } else if (stored && sameDeclaredLinks(stored, extracted)) {
    if (extracted.sourceFetchedAt <= stored.sourceFetchedAt) return "unchanged";
    const refreshed = await companionDao.putDeclaration(extracted);
    outcome = refreshed === "written" ? "refreshed" : refreshed;
  } else {
    outcome = await companionDao.putDeclaration(extracted);
  }

  logger.info("Synced companion links", {
    key,
    companionGuid: extracted.guid,
    outcome,
    declared: extracted.declared.map((ref) => ref.guid),
    truncated: extracted.truncated,
    sourceFetchedAt: extracted.sourceFetchedAt,
  });
  const metric = COMPANION_SYNC_METRICS[outcome];
  if (metric) emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, metric, 1);
  return outcome;
};

export type BillDifferResponse = SQSBatchResponse & {
  status: "ok";
  scanned: number;
  enqueued: number;
  updatedProcessed: number;
};

/**
 * Returns an SQSBatchResponse listing only the records whose bill could not be
 * diffed or enqueued. Requires ReportBatchItemFailures on the event source
 * mapping. The counters are kept for logs and tests.
 *
 * Each record reconciles the bill's processed copy with its latest raw bill (REL-30, REL-33; the
 * rule is in shared/billSourceReconcile.ts): no processed bill, or a changed title or text, sends
 * `{"guid","rawVersionId"}` to billSummarizer ("enqueued"; for a changed text the maintained fields
 * that changed are written first); otherwise the maintained fields are written only when something
 * clients can see changed ("patched"), so storedAt moves only then.
 */
export const handler = async (event: SQSEvent, context?: LambdaContextLike): Promise<BillDifferResponse> => {
  logger.resetContext(context);
  if (!BUCKET_NAME) throw new Error("Missing env var BUCKET_NAME");
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");

  const storage = new BillStorage(s3, BUCKET_NAME);
  const processedDao = new ProcessedBillDao(s3, BUCKET_NAME);

  let updatedProcessed = 0;
  let enqueued = 0;

  // correlationId is the trace id of the record that asked for this diff; it goes on every message
  // sent and on the patched processed bill's S3 metadata.
  const diffBill = async (key: string, messageGuid: string, correlationId: string): Promise<ReconcileResult> => {
    const result = await reconcileProcessedBill(
      { key, messageGuid, correlationId, mode: "differ" },
      {
        storage,
        processedDao,
        sendToSummarizer: async (message, id) => {
          enqueued += await sendToSummarizerQueue(message, id);
        },
        syncCompanionDeclaration,
      },
    );
    // Member stats need no message from here (CAP-05): the patched bill's S3 event reaches
    // createBillsManifest, which forwards it with its versionId to congressMemberStats, and that
    // compares the version with the one before it.
    // A text change can also carry a pre-summary patch of the derived fields (plan.next).
    if (result.outcome === "patched" || (result.outcome === "enqueued" && result.plan.next)) updatedProcessed += 1;
    return result;
  };

  // Several records can name the same raw bill; diff it once and give every record that outcome.
  const diffsByKey = new Map<string, Promise<ReconcileResult>>();

  const response = await processSqsRecords(
    event,
    async (record) => {
      const extracted = extractBillGuidFromRecord(record);
      if (!extracted.guid) {
        // Acknowledged as before; now logged and counted (C1.8).
        reportUnprocessableMessage({
          site: "billDiffer.missingGuid",
          reason: extracted.reason ?? "missing_guid",
          messageId: record?.messageId,
          body: record?.body,
        });
        return;
      }
      const { guid } = extracted;
      const correlationId = correlationIdFromRecord(record) ?? mintCorrelationId(guid);
      logger.appendKeys({ guid, correlationId });
      const key = `${RAW_BILLS_PREFIX}${normalizeBillGuidForKey(guid)}.json`;
      let diff = diffsByKey.get(key);
      if (!diff) {
        diff = diffBill(key, guid, correlationId);
        diffsByKey.set(key, diff);
      }
      // "enqueued" continues at billSummarizer and "patched" through the processed bill's S3 event;
      // the other outcomes end the bill's trace here.
      const { outcome, plan, attempts } = await diff;
      logger.info("Diffed raw bill", {
        key,
        outcome,
        reason: plan.reason,
        ...(plan.decidedBy ? { decidedBy: plan.decidedBy } : {}),
        ...(plan.changedFields.length > 0 ? { changedFields: plan.changedFields } : {}),
        ...(attempts > 1 ? { attempts } : {}),
      });
      return outcome satisfies ReconcileOutcome;
    },
    { label: "billDiffer record failed" },
  );

  return {
    ...response,
    status: "ok",
    scanned: diffsByKey.size,
    enqueued,
    updatedProcessed,
  };
};
