import { randomUUID } from "node:crypto";
import type { MessageAttributeValue } from "@aws-sdk/client-sqs";
import type { SQSRecord } from "aws-lambda";

/**
 * The correlation id that follows one bill through the pipeline (OBS-10):
 *
 *   billsApiPoller -> fetchRawBill -> (enrichOfficialVotes) -> billDiffer -> billSummarizer
 *     -> processed bill in S3 -> createBillsManifest -> notificationType -> userMatcher
 *     -> pending notification row -> notificationDispatcher -> userNotifier
 *
 * The poller mints "<runStartedAt>:<guid>". Every SQS producer copies it into the message
 * attribute `correlationId`; where a hop goes through S3 (the processed-bill write that triggers
 * the manifest and notification steps) it is stored as the object's user metadata
 * `x-amz-meta-correlation-id`, and userMatcher keeps it on the pending notification row. A
 * handler that receives none (old messages, S3 events, backfills) mints a new one.
 */

/** SQS message attribute name. */
export const CORRELATION_ID_ATTRIBUTE = "correlationId";

/** S3 user metadata key; S3 sends and returns it as the x-amz-meta-correlation-id header. */
export const CORRELATION_ID_METADATA_KEY = "correlation-id";

const MAX_CORRELATION_ID_LENGTH = 200;

/**
 * The id if it is usable, else undefined. Printable ASCII without spaces only: S3 metadata
 * values must be ASCII, and the id is copied into log lines and message attributes.
 */
export const normalizeCorrelationId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CORRELATION_ID_LENGTH) return undefined;
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : undefined;
};

/** "<time>:<guid>", or "<time>:<random uuid>" when there is no usable guid. */
export const mintCorrelationId = (guid?: string, at: Date = new Date()): string => {
  const withGuid = normalizeCorrelationId(guid)
    ? normalizeCorrelationId(`${at.toISOString()}:${guid!.trim()}`)
    : undefined;
  return withGuid ?? `${at.toISOString()}:${randomUUID()}`;
};

/** The id carried by an SQS record's `correlationId` message attribute, if any. */
export const correlationIdFromRecord = (
  record: Pick<SQSRecord, "messageAttributes"> | null | undefined,
): string | undefined => normalizeCorrelationId(record?.messageAttributes?.[CORRELATION_ID_ATTRIBUTE]?.stringValue);

/**
 * Spread into a SendMessage(Batch) entry: `{ Id, MessageBody, ...correlationIdMessageAttributes(id) }`.
 * Adds nothing when there is no usable id.
 */
export const correlationIdMessageAttributes = (
  correlationId: string | undefined,
): { MessageAttributes?: Record<string, MessageAttributeValue> } => {
  const id = normalizeCorrelationId(correlationId);
  return id ? { MessageAttributes: { [CORRELATION_ID_ATTRIBUTE]: { DataType: "String", StringValue: id } } } : {};
};

/** S3 user metadata for a PutObject, or undefined when there is no usable id. */
export const correlationIdMetadata = (correlationId: string | undefined): Record<string, string> | undefined => {
  const id = normalizeCorrelationId(correlationId);
  return id ? { [CORRELATION_ID_METADATA_KEY]: id } : undefined;
};

/** The id stored in an object's user metadata (as returned by GetObject or HeadObject), if any. */
export const correlationIdFromMetadata = (metadata: Record<string, string> | null | undefined): string | undefined =>
  normalizeCorrelationId(metadata?.[CORRELATION_ID_METADATA_KEY]);

/**
 * The start of the ids the REL-56 backfill sends with (`refetch:stale-bills --snapshot-file` mints
 * "rel56:<run start>:<guid>"; nothing else does). createBillsManifest dates a first publication that carries one by
 * congress.gov's update time instead of its storedAt (docs/RUNBOOK.md 4.9).
 */
export const REL56_BACKFILL_CORRELATION_PREFIX = "rel56:";

/** Whether the id is one the REL-56 backfill minted. */
export const isRel56BackfillCorrelationId = (correlationId: string | undefined): boolean =>
  normalizeCorrelationId(correlationId)?.startsWith(REL56_BACKFILL_CORRELATION_PREFIX) ?? false;
