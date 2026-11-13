import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { BillStorage } from "../../adapters/billStorage";
import { parseProcessedBillLookupFromS3Key, processedBillGuid } from "../../adapters/processedBillKeys";
import { buildRawBillRootGuidKey } from "../../adapters/rawBillKeys";
import type { BillManifestEntry, RawBill } from "../../models/bill";
import { FORMERLY_FAILED_MARKER_PK, isDismissableBillStatus } from "../../models/feedback";
import { MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE } from "../../shared/billStats";
import {
  MANIFEST_CONTENT_HASH_ATTRIBUTE,
  MANIFEST_DATE_BASIS_ATTRIBUTE,
  billContentHash,
  classifyBillVersionChange,
  contentHashChangeClass,
  formatDateBasis,
  isContentHash,
  manifestDateBasis,
  manifestDateJudgement,
  manifestDateMoves,
  manifestSortKey,
  manifestTimestamp,
  parseDateBasis,
  rowDateMoves,
  type BillVersionChangeClass,
  type DateBasisVersion,
  type ManifestDateBasis,
  type ManifestDateMove,
  type SameDayActions,
} from "../../shared/billVersionChange";
import { rawCongressUpdatedAt, readProcessedSource } from "../../shared/billSourceReconcile";
import { isCommemorativeResolution, processedBillCommemorativeInput } from "../../shared/commemorativeResolutions";
import { correlationIdFromMetadata, isRel56BackfillCorrelationId } from "../../shared/correlation";
import { buildS3WrappedObjectMessage } from "../../shared/replayCongressVoteProfiles";
import { backoffDelayMs, sleep } from "../../shared/retry";
import { processSqsRecords } from "../../shared/sqsBatch";
import { Readable } from "stream";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;
const PRIMARY_KEY = process.env.PRIMARY_KEY!;
const SORT_KEY = process.env.SORT_KEY ?? "sk";
const PK_VALUE = process.env.PK_VALUE ?? "BILL";
const GUID_LOOKUP_PK = process.env.GUID_LOOKUP_PK ?? `${PK_VALUE}_GUID`;
const QUEUE_URL = process.env.QUEUE_URL;
const CONGRESS_MEMBER_STATS_QUEUE_URL = process.env.CONGRESS_MEMBER_STATS_QUEUE_URL;

const s3 = new S3Client({});
const sqs = new SQSClient({});
const ddb = new DynamoDBClient({});
const storage = new BillStorage(s3, BUCKET_NAME);

const SQS_BATCH_SIZE = 10;
// An upsert whose conditions fail (a concurrent voteCount update or manifest write) re-reads and retries.
const MAX_UPSERT_ATTEMPTS = 3;
const UPSERT_RETRY_BACKOFF = { baseMs: 50, maxMs: 500 };
// A row was dated by a document when the document's storedAt is the row's updatedAt or at most this much before it:
// March rows were dated 0.6 to 2.1 s after their document's storedAt.
const MAX_ROW_DATE_LAG_MS = 3_000;
// The row attribute holding the date of the document the row reflects (its storedAt, as resolveManifestUpdatedAt reads
// it), which a kept row's own updatedAt is not. A document older than it is never written over it (upsertManifestEntry).
// Never served: the manifest builders pick their attributes by name, as for contentHash and dateBasis.
const DOCUMENT_STORED_AT_ATTRIBUTE = "documentStoredAt";

const normalizeProcessedBillKey = (key: string): string => {
  const match = key.match(/^processed-bills\/([^/]+)\.json$/i);
  if (!match) return key;

  const guid = match[1];
  const normalizedGuid = guid.replace(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i, "$1");
  return `processed-bills/${normalizedGuid}.json`;
};

/** A processed-bill key, with the S3 version the event named when it is known. */
type ProcessedBillRef = { key: string; versionId?: string };

const refId = (ref: ProcessedBillRef): string => `${ref.key}||${ref.versionId ?? ""}`;

const sendProcessedBillRefsToQueue = async (
  refs: ProcessedBillRef[],
  queueUrl: string,
): Promise<{ enqueued: number }> => {
  const deduped = Array.from(
    new Map(
      refs.filter((ref) => typeof ref.key === "string" && ref.key.length > 0).map((ref) => [refId(ref), ref]),
    ).values(),
  );
  if (deduped.length === 0) return { enqueued: 0 };
  if (!queueUrl) throw new Error("Missing queue URL");

  let enqueued = 0;
  for (let i = 0; i < deduped.length; i += SQS_BATCH_SIZE) {
    const batch = deduped.slice(i, i + SQS_BATCH_SIZE);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((ref, idx) => ({
          Id: `msg-${i + idx}`,
          MessageBody: buildS3WrappedObjectMessage(BUCKET_NAME, ref.key, ref.versionId),
        })),
      }),
    );

    const failedCount = response.Failed ? response.Failed.length : 0;
    if (failedCount > 0) {
      for (const failure of response.Failed ?? []) {
        console.error("Failed to enqueue processed bill key to SQS:", failure);
      }
      throw new Error(`Failed to enqueue ${failedCount} processed bill key(s) to SQS`);
    }

    const successCount = response.Successful ? response.Successful.length : batch.length;
    enqueued += successCount;
  }

  return { enqueued };
};

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const decodeS3Key = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  try {
    // S3 event keys are URL-encoded; some producers may use '+' for spaces.
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
};

/**
 * JSON read from S3 or SQS without a schema: any property may be absent or hold any JSON value. Typed as nested
 * records so optional chaining type-checks; each value is checked where it is used (typeof, Array.isArray, String).
 */
type LooseJson = { readonly [key: string]: LooseJson } | undefined;

const normalizeBillGuidForKey = (guid: string): string => guid.replace(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i, "$1");

const resolveManifestUpdatedAt = (document: LooseJson, rawSnapshot: LooseJson, nowIso: string): string => {
  const candidates = [
    document?.storedAt,
    rawSnapshot?.storedAt,
    document?.metadata?.fetchedAt,
    rawSnapshot?.metadata?.fetchedAt,
    document?.metadata?.pubDate,
    rawSnapshot?.metadata?.pubDate,
  ];

  for (const candidate of candidates) {
    const normalized = manifestTimestamp(candidate);
    if (normalized) return normalized;
  }

  return nowIso;
};

const manifestRowKey = (manifestSk: string): Record<string, AttributeValue> => ({
  [PRIMARY_KEY]: { S: PK_VALUE },
  [SORT_KEY]: { S: manifestSk },
});

const lookupRowKey = (guid: string): Record<string, AttributeValue> => ({
  [PRIMARY_KEY]: { S: GUID_LOOKUP_PK },
  [SORT_KEY]: { S: guid },
});

const getLookupManifestSkByGuid = async (guid: string): Promise<string | null> => {
  const response = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: lookupRowKey(guid),
      ProjectionExpression: "manifestSk",
      ConsistentRead: true,
    }),
  );

  const manifestSk = response.Item?.manifestSk?.S;
  return typeof manifestSk === "string" && manifestSk.length > 0 ? manifestSk : null;
};

/** What billStatsAggregator owns on a manifest row, raw; each undefined when the row or attribute is absent. */
type ManifestVoteState = { voteCount?: string; computedFrom?: string };

/**
 * The vote state, plus what dates the row: its date and status, and the contentHash, date basis and storedAt of the
 * document it reflects (each absent on older rows: the hash before 2026-10-14, the basis and storedAt before
 * 2026-10-28).
 */
type ManifestRowState = ManifestVoteState & {
  updatedAt?: string;
  billStatus?: string;
  contentHash?: string;
  dateBasis?: string;
  documentStoredAt?: string;
};

const readManifestRowState = async (manifestSk: string): Promise<ManifestRowState> => {
  const response = await ddb.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: manifestRowKey(manifestSk),
      ProjectionExpression:
        "voteCount, #computedFrom, #updatedAt, #billStatus, #contentHash, #dateBasis, #documentStoredAt",
      ExpressionAttributeNames: {
        "#computedFrom": MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE,
        "#updatedAt": "updatedAt",
        "#billStatus": "billStatus",
        "#contentHash": MANIFEST_CONTENT_HASH_ATTRIBUTE,
        "#dateBasis": MANIFEST_DATE_BASIS_ATTRIBUTE,
        "#documentStoredAt": DOCUMENT_STORED_AT_ATTRIBUTE,
      },
      ConsistentRead: true,
    }),
  );

  const voteCount = response.Item?.voteCount?.N;
  const computedFrom = response.Item?.[MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE]?.S;
  const updatedAt = response.Item?.updatedAt?.S;
  const billStatus = response.Item?.billStatus?.S;
  const contentHash = response.Item?.[MANIFEST_CONTENT_HASH_ATTRIBUTE]?.S;
  const dateBasis = response.Item?.[MANIFEST_DATE_BASIS_ATTRIBUTE]?.S;
  const documentStoredAt = response.Item?.[DOCUMENT_STORED_AT_ATTRIBUTE]?.S;
  return {
    ...(typeof voteCount === "string" ? { voteCount } : {}),
    ...(typeof computedFrom === "string" ? { computedFrom } : {}),
    ...(typeof updatedAt === "string" ? { updatedAt } : {}),
    ...(typeof billStatus === "string" ? { billStatus } : {}),
    ...(typeof contentHash === "string" ? { contentHash } : {}),
    ...(typeof dateBasis === "string" ? { dateBasis } : {}),
    ...(typeof documentStoredAt === "string" ? { documentStoredAt } : {}),
  };
};

/**
 * A condition that the row still holds exactly what was read of it, each attribute equal or absent as read: the vote
 * state billStatsAggregator owns, and the contentHash, date basis and storedAt of the document it reflects, which only
 * a manifest write changes. A count written in between, or another version's write (even a kept one, which leaves the
 * lookup where it was), cancels the transaction, and the upsert reads again.
 */
const rowStateUnchanged = (observed: ManifestRowState) => {
  const attributes: Array<[alias: string, attribute: string, observed: AttributeValue | undefined]> = [
    ["VoteCount", "voteCount", observed.voteCount === undefined ? undefined : { N: observed.voteCount }],
    [
      "ComputedFrom",
      MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE,
      observed.computedFrom === undefined ? undefined : { S: observed.computedFrom },
    ],
    [
      "ContentHash",
      MANIFEST_CONTENT_HASH_ATTRIBUTE,
      observed.contentHash === undefined ? undefined : { S: observed.contentHash },
    ],
    [
      "DateBasis",
      MANIFEST_DATE_BASIS_ATTRIBUTE,
      observed.dateBasis === undefined ? undefined : { S: observed.dateBasis },
    ],
    [
      "DocumentStoredAt",
      DOCUMENT_STORED_AT_ATTRIBUTE,
      observed.documentStoredAt === undefined ? undefined : { S: observed.documentStoredAt },
    ],
  ];
  const clauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  for (const [alias, attribute, value] of attributes) {
    const name = `#${alias.charAt(0).toLowerCase()}${alias.slice(1)}`;
    names[name] = attribute;
    if (value === undefined) clauses.push(`attribute_not_exists(${name})`);
    else {
      clauses.push(`${name} = :observed${alias}`);
      values[`:observed${alias}`] = value;
    }
  }
  return {
    ConditionExpression: clauses.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
  };
};

const toVoteCount = (raw: string | undefined): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const findLookupByGuidPrefix = async (
  guidPrefix: string,
): Promise<{ lookupGuid: string; manifestSk: string } | null> => {
  const response = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "#pk = :lookupPk AND begins_with(#sk, :guidPrefix)",
      ExpressionAttributeNames: {
        "#pk": PRIMARY_KEY,
        "#sk": SORT_KEY,
      },
      ExpressionAttributeValues: {
        ":lookupPk": { S: GUID_LOOKUP_PK },
        ":guidPrefix": { S: guidPrefix },
      },
      ProjectionExpression: "#sk, manifestSk",
      Limit: 1,
    }),
  );

  if (!response.Items || response.Items.length === 0) return null;

  const item = response.Items[0];
  const lookupGuid = item?.[SORT_KEY]?.S;
  const manifestSk = item?.manifestSk?.S;
  if (!lookupGuid || !manifestSk) return null;

  return { lookupGuid, manifestSk };
};

const buildLookupItem = (guid: string, manifestSk: string, updatedAt: string): Record<string, AttributeValue> => ({
  ...lookupRowKey(guid),
  guid: { S: guid },
  manifestSk: { S: manifestSk },
  updatedAt: { S: updatedAt },
});

const buildManifestItem = (
  entry: BillManifestEntry,
  manifestSk: string,
  updatedAt: string,
  voteState: ManifestVoteState,
  contentHash: string,
  dateBasis: ManifestDateBasis,
  documentStoredAt: string,
): Record<string, AttributeValue> => {
  const ddbItem: Record<string, AttributeValue> = {
    ...manifestRowKey(manifestSk),
    guid: { S: entry.guid },
    billType: { S: entry.billType ?? "" },
    congress: { S: entry.congress ?? "" },
    billNumber: { S: entry.billNumber ?? "" },
    updatedAt: { S: updatedAt },
    title: { S: entry.title ?? "" },
    subCategories: { L: (entry.subCategories ?? []).map((v) => ({ S: String(v) })) },
    lifeAreas: { L: (entry.lifeAreas ?? []).map((v) => ({ S: String(v) })) },
    sponsors: { L: (entry.sponsors ?? []).map((v) => ({ S: String(v) })) },
    cosponsors: { L: (entry.cosponsors ?? []).map((v) => ({ S: String(v) })) },
    voteCount: { N: String(toVoteCount(voteState.voteCount)) },
    // The document this row reflects, so the next version can be judged against it without reading S3
    // (billVersionChange.ts). Never served: the manifest builders pick their attributes by name.
    [MANIFEST_CONTENT_HASH_ATTRIBUTE]: { S: contentHash },
    [MANIFEST_DATE_BASIS_ATTRIBUTE]: { S: formatDateBasis(dateBasis) },
    [DOCUMENT_STORED_AT_ATTRIBUTE]: { S: documentStoredAt },
  };
  // Kept with the count, so a recompute that started before the one that wrote it still loses.
  if (voteState.computedFrom !== undefined) {
    ddbItem[MANIFEST_VOTE_COUNT_COMPUTED_FROM_ATTRIBUTE] = { S: voteState.computedFrom };
  }
  if (entry.billStatus) {
    ddbItem.billStatus = { S: entry.billStatus };
  }
  if (entry.civicProfile && Object.keys(entry.civicProfile).length > 0) {
    ddbItem.civicProfile = {
      M: Object.fromEntries(Object.entries(entry.civicProfile).map(([k, v]) => [k, { N: String(v) }])),
    };
  }
  return ddbItem;
};

/** True when a transaction was cancelled by a condition or a concurrent transaction, so a re-read can succeed. */
const isRetryableTransactionCancel = (error: unknown): boolean => {
  const candidate = error as { name?: unknown; CancellationReasons?: Array<{ Code?: string }> } | null;
  if (candidate?.name !== "TransactionCanceledException") return false;
  const reasons = Array.isArray(candidate.CancellationReasons) ? candidate.CancellationReasons : [];
  if (reasons.length === 0) return true;
  return reasons.some((reason) => reason?.Code === "ConditionalCheckFailed" || reason?.Code === "TransactionConflict");
};

/** A processed bill as read for the manifest: its entry, the document, and the S3 version that was read. */
type ManifestRead = {
  key: string;
  entry: BillManifestEntry;
  document: unknown;
  /** billContentHash of the document; every row written from it carries the hash. */
  contentHash: string;
  /** manifestDateBasis of the document and its source-text-hash; every row written from it carries the basis. */
  dateBasis: ManifestDateBasis;
  /** The VersionId GetObject returned; absent from an unversioned answer. */
  versionId?: string;
  /** The pipeline trace id the processed write stored (x-amz-meta-correlation-id, OBS-10), when it has one. */
  correlationId?: string;
  /** The raw version the document was built from (its source-raw-version metadata, REL-30), when recorded. */
  sourceRawVersion?: string;
};

/** An earlier version of a processed bill: its document and the source-text-hash S3 metadata it was stored with. */
type PreviousVersion = { document: unknown; sourceTextHash?: string };

/** How an upsert of a newer document dates the row. */
type DateDecision = {
  /** The row's own updatedAt when it keeps its date (its sort key carries it); null when the row moves. */
  keptUpdatedAt: string | null;
  /** The news that moves the row (billVersionChange.manifestDateMoves); empty when it brings none. */
  moves: ManifestDateMove[];
  /** For the logs: the change class, when the row's hash or the previous version tells it. */
  changeClass: BillVersionChangeClass | null;
  decidedBy: "dateBasis" | "contentHash" | "previousVersion" | "row";
  /** For the logs: the row's basis format (d2, or d1 from a release before 2026-11-12), or null without a valid one. */
  basis: DateBasisVersion | null;
  /** For the logs: the version's actions on the latest date against the row's basis (sameDayActions), when it judged them. */
  sameDay: SameDayActions | null;
};

const asDocument = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The source-text-hash of a processed bill's S3 user metadata, when it has one (not a legacy bill). */
const sourceTextHashOf = (metadata: Record<string, string> | undefined): string | undefined =>
  readProcessedSource(metadata)?.textHash;

/**
 * The version of the key just before the one read, or null: none was read by VersionId, it is the oldest, the one
 * before is a delete marker, or it is gone (noncurrent versions expire after 30 days). A failed read counts as none,
 * so the row's own status and date decide (rowDateMoves), or for a d1 row its basis, keeping the date when unsure.
 */
const readPreviousVersion = async (read: ManifestRead): Promise<PreviousVersion | null> => {
  if (!read.versionId) return null;
  try {
    const versions = await storage.listObjectVersionsForKey(read.key);
    const index = versions.findIndex((version) => version.versionId === read.versionId);
    const previous = index >= 0 ? versions[index + 1] : undefined;
    if (!previous || previous.isDeleteMarker) return null;
    const stored = await storage.getJsonObjectWithVersionId<unknown>(read.key, previous.versionId);
    if (stored.value === null || stored.value === undefined) return null;
    const sourceTextHash = sourceTextHashOf(stored.metadata);
    return { document: stored.value, ...(sourceTextHash ? { sourceTextHash } : {}) };
  } catch (error) {
    console.warn(
      "Could not read the previous processed bill version; the row's basis, or its status and date, decide",
      {
        key: read.key,
        versionId: read.versionId,
        error,
      },
    );
    return null;
  }
};

/** How a first publication (a bill with no row yet) is dated. */
type FirstPublicationDate = {
  /** The row's date: the document's storedAt, or the earlier congress.gov update time of a backfilled bill. */
  updatedAt: string;
  /** Set for a document the REL-56 backfill wrote, for its log line; absent for every other first publication. */
  backfill?: {
    /** rawCongressUpdatedAt of the raw copy read, or null when none could be read or it has no update time. */
    congressUpdatedAt: string | null;
    /** Which raw copy was read: the version the document was built from, else the current one. */
    raw: "sourceVersion" | "current" | null;
  };
};

/** The raw bill a backfilled document was built from (its source-raw-version), else the current one, or null. */
const readBackfillRawBill = async (
  read: ManifestRead,
): Promise<{ raw: RawBill; from: "sourceVersion" | "current" } | null> => {
  const rawKey = buildRawBillRootGuidKey(read.entry.guid);
  try {
    if (read.sourceRawVersion) {
      const stored = await storage.getJsonObjectWithVersionId<RawBill>(rawKey, read.sourceRawVersion);
      if (stored.value) return { raw: stored.value, from: "sourceVersion" };
    }
    // The version expired (raw noncurrent versions are kept 7 days) or was not recorded. The current copy is that
    // fetch or a later one, which can only date the bill later, and never after its storedAt.
    const current = await storage.getJsonObject<RawBill>(rawKey);
    return current.value ? { raw: current.value, from: "current" } : null;
  } catch (error) {
    console.warn("Could not read the raw bill of a backfilled first publication; it is dated by its storedAt", {
      key: rawKey,
      error,
    });
    return null;
  }
};

/**
 * The date of a first publication. Every bill stored in normal operation is dated by its document's storedAt, as
 * before, with no extra read. A bill the REL-56 backfill sent (its processed write carries a rel56: correlation id;
 * docs/RUNBOOK.md 4.9 and 16.1) was skipped by the old poller for weeks or months, so its storedAt is only the day of
 * the backfill window: it is dated by congress.gov's update time instead (rawCongressUpdatedAt of the raw copy the
 * document was built from) when that is earlier than its storedAt. A detail copy that lags congress.gov's list only
 * dates it earlier. A raw copy that cannot be read or has no update time leaves the storedAt.
 */
const dateFirstPublication = async (read: ManifestRead, storedAt: string): Promise<FirstPublicationDate> => {
  if (!isRel56BackfillCorrelationId(read.correlationId)) return { updatedAt: storedAt };
  const source = await readBackfillRawBill(read);
  const congressUpdatedAt = rawCongressUpdatedAt(source?.raw) ?? null;
  return {
    updatedAt: congressUpdatedAt !== null && congressUpdatedAt < storedAt ? congressUpdatedAt : storedAt,
    backfill: { congressUpdatedAt, raw: source?.from ?? null },
  };
};

/**
 * Whether the row was written from `document` (or from a version that differs from it by bookkeeping alone): by its
 * contentHash when it has one of the current version, else by its date, which is that document's storedAt or up to
 * MAX_ROW_DATE_LAG_MS after it. A later version is not the row's, nor a much older one: the copy an S3 rollback makes
 * of an old version (RUNBOOK 5) keeps its old storedAt, and the upsert skipped it.
 */
const rowReflects = (row: ManifestRowState, document: unknown): boolean => {
  if (isContentHash(row.contentHash)) return row.contentHash === billContentHash(document);
  return datedBy(row, manifestTimestamp(asDocument(document)?.storedAt));
};

/** Whether the row's date is `documentAt` or at most MAX_ROW_DATE_LAG_MS after it. */
const datedBy = (row: ManifestRowState, documentAt: string | null): boolean => {
  const lagMs = documentAt && row.updatedAt ? Date.parse(row.updatedAt) - Date.parse(documentAt) : Number.NaN;
  return lagMs >= 0 && lagMs <= MAX_ROW_DATE_LAG_MS;
};

/**
 * Whether the row, at a sort key newer than the document's, was written from this very document: dated at most
 * MAX_ROW_DATE_LAG_MS after its storedAt (the March load dated rows 0.6 to 2.1 s late, and a replay never rewrote
 * them) and, when the row has a contentHash, with this document's. Such a version is the row's own, so it is rewritten
 * in place like an equal sort key (a replay relabels it, S6) instead of being skipped as an older document.
 */
const isRowsOwnVersion = (read: ManifestRead, documentAt: string, row: ManifestRowState, existingSk: string): boolean =>
  row.updatedAt !== undefined &&
  manifestSortKey(row.updatedAt, read.entry.guid) === existingSk &&
  datedBy(row, documentAt) &&
  (!isContentHash(row.contentHash) || row.contentHash === read.contentHash);

/**
 * Whether the row reflects a document stored after this one (its documentStoredAt, written since 2026-10-28): a slower
 * writer of an earlier version, or an S3 rollback's copy, which keeps its old storedAt (RUNBOOK 5). Such a document
 * never replaces the row's content, whether the row moved or kept its date for the newer one.
 */
const reflectsNewerDocument = (row: ManifestRowState, documentAt: string): boolean => {
  const rowDocumentAt = manifestTimestamp(row.documentStoredAt);
  return rowDocumentAt !== null && rowDocumentAt > documentAt;
};

/**
 * Whether a document newer than the row keeps the row's date: unless it brings news against the document the row
 * reflects (a status, a newer action or another action on the latest date, another text; shared/billVersionChange.ts
 * manifestDateMoves), the row keeps the date its sort key carries. What the row reflects is known, in this order, from:
 *
 * - its date basis (every row this release writes, d2, and every row the releases of 2026-10-28 to 2026-11-12 wrote,
 *   d1). A d1 basis holds each latest-date action's text with its Congressional Record citations; when it cannot tell
 *   a citation changed or removed from another action (sameDayActions `unknown`), the S3 version before the one read
 *   decides, as below, and without it the row keeps its date;
 * - its contentHash, when it equals the new document's: only bookkeeping changed, so there is no news;
 * - the S3 version before the one read, when the row reflects it (rowReflects): a row written by an older release;
 * - otherwise the row itself (rowDateMoves): its status, and an action dated after the day it was dated.
 *
 * A first publication has no row and is dated by its document (a REL-56 backfill's by congress.gov's update time,
 * dateFirstPublication), as an equal sort key (a replay) is rewritten in place.
 */
const decideManifestDate = async (
  read: ManifestRead,
  row: ManifestRowState,
  existingSk: string,
  previousVersion: () => Promise<PreviousVersion | null>,
): Promise<DateDecision> => {
  let changeClass = contentHashChangeClass(row.contentHash, read.contentHash);
  let moves: ManifestDateMove[];
  let decidedBy: DateDecision["decidedBy"];
  const rowBasis = parseDateBasis(row.dateBasis);
  const judgement = rowBasis ? manifestDateJudgement(rowBasis, read.dateBasis) : null;
  // The S3 version before the one read is needed for a row without a basis whose hash does not settle it, and for a
  // d1 row whose keys cannot tell a citation edit from another action on the latest date (sameDayActions `unknown`).
  // Such a d1 row keeps its date without it (newActionEntry left out): a missed same-day entry costs less than an old
  // bill re-dated for a citation (RUNBOOK 4.9).
  const needsPrevious = judgement ? judgement.sameDay === "unknown" : changeClass !== "bookkeeping_only";
  const previous = needsPrevious && row.updatedAt ? await previousVersion() : null;
  if (previous && rowReflects(row, previous.document)) {
    moves = manifestDateMoves(manifestDateBasis(previous.document, previous.sourceTextHash), read.dateBasis);
    changeClass = classifyBillVersionChange(previous.document, read.document).changeClass;
    decidedBy = "previousVersion";
  } else if (judgement) {
    moves = judgement.moves;
    decidedBy = "dateBasis";
  } else if (changeClass === "bookkeeping_only") {
    // Equal status and actions. A text the summary was not written from always brings a new summary, which is not
    // bookkeeping, so the text cannot have changed either.
    moves = [];
    decidedBy = "contentHash";
  } else {
    moves = rowDateMoves(row, read.dateBasis);
    decidedBy = "row";
  }
  const keptUpdatedAt =
    moves.length === 0 && row.updatedAt && manifestSortKey(row.updatedAt, read.entry.guid) === existingSk
      ? row.updatedAt
      : null;
  return {
    keptUpdatedAt,
    moves,
    changeClass,
    decidedBy,
    basis: rowBasis?.version ?? null,
    sameDay: judgement?.sameDay ?? null,
  };
};

/**
 * REL-50 (INT-11): whether this write takes the row from Failed to an open status (New, Updated, none, or anything
 * else that is not Passed or Failed). Apps 1.0 and 1.1 never lower a status they hold, so a device that held the bill
 * as Failed keeps listing it under Failed bills, and its Dismiss stores an Abstain that SetFeedback must keep a
 * dismissal: the bill gets its "formerly failed" marker (formerlyFailedMarkerUpdate) in the same transaction.
 */
const leavesFailedForOpenStatus = (row: ManifestRowState, entry: BillManifestEntry): boolean =>
  row.billStatus === "Failed" && !isDismissableBillStatus(entry.billStatus);

/**
 * The bill's "formerly failed" marker (FORMERLY_FAILED_MARKER_PK, models/feedback.ts; sk the plain guid, as the lookup
 * row's): set with the row's status change, so SetFeedback never sees the bill open without it. markedAt keeps the
 * first marking (repair:failed-status may have written the marker before); statusLoweredAt and statusLoweredTo record
 * this write. Unconditional, so it never cancels the transaction.
 */
const formerlyFailedMarkerUpdate = (guid: string, toStatus: string | undefined, nowIso: string): TransactWriteItem => ({
  Update: {
    TableName: TABLE_NAME,
    Key: { [PRIMARY_KEY]: { S: FORMERLY_FAILED_MARKER_PK }, [SORT_KEY]: { S: guid } },
    UpdateExpression:
      "SET #guid = :guid, #markedAt = if_not_exists(#markedAt, :now), #loweredAt = :now, #loweredTo = :loweredTo",
    ExpressionAttributeNames: {
      "#guid": "guid",
      "#markedAt": "markedAt",
      "#loweredAt": "statusLoweredAt",
      "#loweredTo": "statusLoweredTo",
    },
    ExpressionAttributeValues: {
      ":guid": { S: guid },
      ":now": { S: nowIso },
      ":loweredTo": { S: toStatus ?? "" },
    },
  },
});

/**
 * Writes one manifest entry and its guid lookup row in a single transaction.
 *
 * billStatsAggregator owns `voteCount` and `voteCountComputedFrom` and updates them in place on the
 * row the lookup points to. The rewritten row carries the values read here, and the transaction is
 * conditional on the row still holding exactly those values (and on the lookup still pointing where
 * it did), so a count written in between cancels the transaction and the upsert re-reads instead of
 * losing it.
 *
 * The same transaction deletes the old row, puts the new one and moves the lookup, conditional on
 * the lookup still naming the old row (or not existing), so two writers of one bill cannot both
 * commit: the loser is cancelled whole and re-reads. A bill therefore never gains a second row.
 *
 * A document newer than the row moves the row to the document's date only when it brings news: a status, a newer
 * action or another action on the latest date, another text (decideManifestDate). Any other keeps the row at its date:
 * the row is rewritten in place with every other attribute from the document, like an equal sort key, and the lookup
 * keeps its manifestSk and updatedAt ("kept"; docs/RUNBOOK.md 4.9). Forwarding is the same either way (applyRecord).
 *
 * A kept write leaves the lookup where it was, so the row's own condition carries what the row reflects (contentHash,
 * dateBasis, documentStoredAt): of two writers holding different versions, the later commit is cancelled and reads
 * again, and a row that then reflects a newer document than the one held is left as it is (reflectsNewerDocument).
 * A document at an older sort key is skipped, unless the row was written from it (a March row dated up to 2.1 s after
 * its document: isRowsOwnVersion), which is rewritten in place at the row's own key and date like a replay.
 *
 * A write that takes the row from Failed to an open status also sets the bill's "formerly failed" marker in the same
 * transaction (REL-50, INT-11: leavesFailedForOpenStatus).
 */
const upsertManifestEntry = async (read: ManifestRead, nowIso: string): Promise<"written" | "kept" | "skipped"> => {
  const { entry } = read;
  const updatedAt = entry.updatedAt ?? nowIso;
  const newSk = manifestSortKey(updatedAt, entry.guid);
  // Read at most once per upsert, and only for a row with neither a date basis nor the new document's contentHash, or
  // with a d1 basis that cannot tell a citation edit from another action on the latest date.
  let previous: Promise<PreviousVersion | null> | undefined;
  const previousVersion = () => (previous ??= readPreviousVersion(read));
  // Decided at most once per upsert, and only for a first publication (no lookup); only a backfilled one reads S3.
  let firstDate: Promise<FirstPublicationDate> | undefined;
  const firstPublicationDate = () => (firstDate ??= dateFirstPublication(read, updatedAt));

  for (let attempt = 0; ; attempt += 1) {
    // Read existing SK via dedicated lookup row (O(1)).
    const existingSk = await getLookupManifestSkByGuid(entry.guid);
    // A first publication is dated by its document, or a backfilled bill by congress.gov (dateFirstPublication). The
    // checks below that compare documents keep using updatedAt, the document's storedAt, as does documentStoredAt.
    const first = existingSk === null ? await firstPublicationDate() : null;
    const currentSk = existingSk ?? manifestSortKey(first?.updatedAt ?? updatedAt, entry.guid);
    const observedRow = await readManifestRowState(currentSk);
    // Equal sort keys can still carry newer manifest fields such as billStatus updates from deterministic backfills
    // (a repair that sets a document's storedAt to its row's date relies on it), so they are always rewritten in place.
    // A strictly older snapshot is skipped, unless it is the row's own version (isRowsOwnVersion), and so is any
    // document older than the one a row reflects (reflectsNewerDocument), whatever its sort key.
    const ownVersion =
      existingSk !== null && existingSk > newSk && isRowsOwnVersion(read, updatedAt, observedRow, existingSk);
    if (existingSk !== null && existingSk > newSk && !ownVersion) return "skipped";
    if (existingSk !== null && existingSk !== newSk && reflectsNewerDocument(observedRow, updatedAt)) return "skipped";

    const decision =
      existingSk && existingSk < newSk
        ? await decideManifestDate(read, observedRow, existingSk, previousVersion)
        : null;
    // The row's own version and a version that brings no news keep the row's sort key and date; a first publication
    // takes its own (currentSk).
    const keptUpdatedAt = ownVersion ? (observedRow.updatedAt ?? null) : (decision?.keptUpdatedAt ?? null);
    const targetSk = keptUpdatedAt || first ? currentSk : newSk;
    const targetUpdatedAt = keptUpdatedAt ?? first?.updatedAt ?? updatedAt;

    const rowUnchanged = rowStateUnchanged(observedRow);
    const lookupUnchanged = existingSk
      ? {
          ConditionExpression: "#manifestSk = :expectedManifestSk",
          ExpressionAttributeNames: { "#manifestSk": "manifestSk" },
          ExpressionAttributeValues: { ":expectedManifestSk": { S: existingSk } },
        }
      : {
          ConditionExpression: "attribute_not_exists(#manifestSk)",
          ExpressionAttributeNames: { "#manifestSk": "manifestSk" },
        };

    const manifestItem = buildManifestItem(
      entry,
      targetSk,
      targetUpdatedAt,
      observedRow,
      read.contentHash,
      read.dateBasis,
      updatedAt,
    );
    const transactItems: TransactWriteItem[] =
      currentSk === targetSk
        ? [{ Put: { TableName: TABLE_NAME, Item: manifestItem, ...rowUnchanged } }]
        : [
            { Delete: { TableName: TABLE_NAME, Key: manifestRowKey(currentSk), ...rowUnchanged } },
            { Put: { TableName: TABLE_NAME, Item: manifestItem } },
          ];
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: buildLookupItem(entry.guid, targetSk, targetUpdatedAt),
        ...lookupUnchanged,
      },
    });
    // REL-50 (INT-11): the row leaves Failed for an open status: the marker commits with it, or neither does.
    const marksFormerlyFailed = leavesFailedForOpenStatus(observedRow, entry);
    if (marksFormerlyFailed) transactItems.push(formerlyFailedMarkerUpdate(entry.guid, entry.billStatus, nowIso));

    try {
      await ddb.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
      if (marksFormerlyFailed) {
        console.info("Marked a formerly failed bill", { guid: entry.guid, statusLoweredTo: entry.billStatus ?? null });
      }
      if (first?.backfill) {
        console.info("Dated backfill first publication", {
          guid: entry.guid,
          datedBy: targetUpdatedAt === updatedAt ? "storedAt" : "congressUpdate",
          updatedAt: targetUpdatedAt,
          storedAt: updatedAt,
          congressUpdatedAt: first.backfill.congressUpdatedAt,
          raw: first.backfill.raw,
          correlationId: read.correlationId ?? null,
        });
      }
      if (decision) {
        console.info("Dated manifest upsert", {
          guid: entry.guid,
          decision: keptUpdatedAt ? "kept" : "moved",
          moves: decision.moves,
          changeClass: decision.changeClass,
          decidedBy: decision.decidedBy,
          basis: decision.basis,
          sameDay: decision.sameDay,
          rowUpdatedAt: observedRow.updatedAt ?? null,
          storedAt: updatedAt,
        });
      }
      return decision?.keptUpdatedAt ? "kept" : "written";
    } catch (error) {
      if (!isRetryableTransactionCancel(error) || attempt + 1 >= MAX_UPSERT_ATTEMPTS) throw error;
      console.warn("Manifest upsert raced a concurrent write; re-reading", { guid: entry.guid, attempt: attempt + 1 });
      await sleep(backoffDelayMs(attempt, UPSERT_RETRY_BACKOFF));
    }
  }
};

// addOrUpdateRefs carries the event's versionId for the member-stats (CAP-05) and notificationType (REL-59) forwards.
type S3Delta = { addOrUpdateKeys: string[]; removeKeys: string[]; addOrUpdateRefs: ProcessedBillRef[] };

const extractS3DeltasFromSqsEvent = (event: Pick<SQSEvent, "Records">): S3Delta => {
  const addOrUpdateKeys: string[] = [];
  const removeKeys: string[] = [];
  const addOrUpdateRefs: ProcessedBillRef[] = [];

  const records = event?.Records;
  if (!Array.isArray(records)) return { addOrUpdateKeys, removeKeys, addOrUpdateRefs };

  for (const rec of records) {
    let body: unknown;
    try {
      body = typeof rec?.body === "string" ? JSON.parse(rec.body) : (rec?.body ?? rec);
    } catch {
      body = rec;
    }

    const envelope = body as LooseJson;
    const s3Records = envelope?.Records ?? envelope?.records;
    if (!Array.isArray(s3Records)) continue;

    for (const s3r of s3Records) {
      const keyDecoded = decodeS3Key(s3r?.s3?.object?.key);
      if (!keyDecoded) continue;
      if (!keyDecoded.toLowerCase().startsWith("processed-bills/")) continue;

      const key = normalizeProcessedBillKey(keyDecoded);
      const eventName = (s3r?.eventName ?? "").toString();
      if (/^ObjectRemoved:/i.test(eventName)) {
        removeKeys.push(key);
        continue;
      }
      addOrUpdateKeys.push(key);
      // The version belongs to the key the event named, so it is kept only when normalizing left it alone.
      const versionId = s3r?.s3?.object?.versionId;
      addOrUpdateRefs.push({
        key,
        ...(key === keyDecoded && typeof versionId === "string" && versionId.length > 0 ? { versionId } : {}),
      });
    }
  }

  return { addOrUpdateKeys, removeKeys, addOrUpdateRefs };
};

const unwrapRawBillSnapshot = (document: LooseJson): LooseJson => {
  if (!document || typeof document !== "object") return document;

  // Prefer `content.rawSnapshot` when present (some writers may omit `kind`).
  const snapshot = document?.content?.rawSnapshot;
  if (snapshot && typeof snapshot === "object") return snapshot;

  return document;
};

const extractBioguideIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item: LooseJson | string) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") return (item.bioguideId ?? item.bioguideid ?? "").toString();
      return "";
    })
    .map((s) => s.trim())
    .filter(Boolean);
};

type ManifestStats = {
  addFetchProcessed: number;
  addFetchFailed: number;
  removeCount: number;
  upsertsAttempted: number;
  upsertsSucceeded: number;
  upsertsSkipped: number;
  /** Rows rewritten in place at their own date: the new version brought no news (counted as succeeded too). */
  upsertsKeptDate: number;
  deletesAttempted: number;
  deletesSucceeded: number;
};

const uniqueJsonKeys = (keys: string[]): string[] =>
  Array.from(new Set(keys.filter((k) => typeof k === "string" && k.endsWith(".json"))));

/** Reads one processed bill and builds its manifest entry; null when it lacks a guid, type or title. */
const readManifestEntry = async (key: string, nowIso: string): Promise<ManifestRead | null> => {
  const getResp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  const bodyString = await streamToString(getResp.Body as Readable);
  const parsed = JSON.parse(bodyString) as LooseJson;
  const rawSnapshot = unwrapRawBillSnapshot(parsed);
  const contentBill = rawSnapshot?.content?.bill?.bill ?? rawSnapshot?.content?.bill ?? undefined;
  const identifier = rawSnapshot?.identifier ?? parsed?.identifier ?? {};
  const billType = (identifier?.billType ?? "").toString();
  const documentGuid = (
    rawSnapshot?.guid ??
    parsed?.guid ??
    rawSnapshot?.metadata?.guid ??
    parsed?.metadata?.guid ??
    ""
  ).toString();
  const title: unknown =
    contentBill?.title ?? rawSnapshot?.title ?? parsed?.metadata?.title ?? rawSnapshot?.metadata?.title ?? "";
  if (!documentGuid || !billType || !title) return null;
  // The row, its sort key and its lookup take the key's guid: a suffixed document guid made a second row.
  const guid = processedBillGuid(key, documentGuid) ?? documentGuid;

  let congress: string | null = null;
  let billNumber: string | null = null;
  if (identifier?.congress) congress = String(identifier.congress);
  if (identifier?.billNumber) billNumber = String(identifier.billNumber);
  if (!congress || !billNumber) {
    const parsedLookup = parseProcessedBillLookupFromS3Key(key);
    if (parsedLookup) {
      if (parsedLookup.kind === "guidWithLocator") {
        congress = congress ?? parsedLookup.congress;
      } else if (parsedLookup.kind === "identifier") {
        congress = congress ?? parsedLookup.identifier.congress;
        billNumber = billNumber ?? parsedLookup.identifier.billNumber;
      }
    }
  }

  const documentSubCategories = Array.isArray(rawSnapshot?.subCategories)
    ? rawSnapshot.subCategories.map((v: unknown) => String(v)).filter(Boolean)
    : Array.isArray(parsed?.subCategories)
      ? parsed.subCategories.map((v: unknown) => String(v)).filter(Boolean)
      : [];
  const documentLifeAreas = Array.isArray(rawSnapshot?.lifeAreas)
    ? rawSnapshot.lifeAreas.map((v: unknown) => String(v)).filter(Boolean)
    : Array.isArray(parsed?.lifeAreas)
      ? parsed.lifeAreas.map((v: unknown) => String(v)).filter(Boolean)
      : [];
  // A ceremonial resolution (a day, a week, a group recognized) is about no topic and touches no part of anyone's
  // life, whatever the summary tagged (feature review S6; its topics too since the project's decision of 2026-10-29,
  // as the apps' cards showed a followed topic on it). The document keeps both lists; only the row drops them, and
  // the date basis leaves topics and life areas out, so a row relabelled this way keeps its date.
  const ceremonial = isCommemorativeResolution(processedBillCommemorativeInput(parsed));
  const subCategories = ceremonial ? [] : documentSubCategories;
  const lifeAreas = ceremonial ? [] : documentLifeAreas;

  const sponsors = extractBioguideIds(
    Array.isArray(rawSnapshot?.sponsors)
      ? rawSnapshot.sponsors
      : Array.isArray(contentBill?.sponsors)
        ? contentBill.sponsors
        : rawSnapshot?.content?.sponsors,
  );
  const cosponsors = extractBioguideIds(
    Array.isArray(rawSnapshot?.cosponsors)
      ? rawSnapshot.cosponsors
      : (rawSnapshot?.content?.cosponsors?.cosponsors ?? contentBill?.cosponsors),
  );

  const billStatus = (rawSnapshot?.billStatus ?? parsed?.billStatus ?? undefined) as string | undefined;
  const validStatuses = new Set(["New", "Updated", "Passed", "Failed", "Finalized"]);

  // Extract civicProfile scores (object with axis name keys and number values)
  const rawCivicProfile = rawSnapshot?.civicProfile ?? parsed?.civicProfile;
  const civicProfile: Record<string, number> | undefined =
    rawCivicProfile && typeof rawCivicProfile === "object" && !Array.isArray(rawCivicProfile)
      ? Object.fromEntries(
          Object.entries(rawCivicProfile as Record<string, unknown>)
            .filter(([, v]) => typeof v === "number" && !isNaN(v as number))
            .map(([k, v]) => [k, v as number]),
        )
      : undefined;
  const manifestUpdatedAt = resolveManifestUpdatedAt(parsed, rawSnapshot, nowIso);

  const entry: BillManifestEntry = {
    guid,
    billType,
    congress: congress ?? "",
    billNumber: billNumber ?? "",
    updatedAt: manifestUpdatedAt,
    subCategories,
    lifeAreas,
    sponsors,
    cosponsors,
    // The JSON value as read: a string for every document the summarizer writes.
    title: title as string,
    ...(billStatus && validStatuses.has(billStatus)
      ? { billStatus: billStatus as BillManifestEntry["billStatus"] }
      : {}),
    ...(civicProfile && Object.keys(civicProfile).length > 0 ? { civicProfile } : {}),
  };
  const versionId = typeof getResp.VersionId === "string" && getResp.VersionId.length > 0 ? getResp.VersionId : null;
  const correlationId = correlationIdFromMetadata(getResp.Metadata);
  const sourceRawVersion = readProcessedSource(getResp.Metadata)?.rawVersion;
  return {
    key,
    entry,
    document: parsed,
    contentHash: billContentHash(parsed),
    dateBasis: manifestDateBasis(parsed, sourceTextHashOf(getResp.Metadata)),
    ...(versionId ? { versionId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(sourceRawVersion ? { sourceRawVersion } : {}),
  };
};

const removeManifestEntry = async (normGuid: string, stats: ManifestStats): Promise<void> => {
  stats.deletesAttempted += 1;
  let existingSk = await getLookupManifestSkByGuid(normGuid);
  let lookupGuidToDelete = normGuid;
  if (!existingSk) {
    const fallbackLookup = await findLookupByGuidPrefix(normGuid);
    if (!fallbackLookup) return;
    existingSk = fallbackLookup.manifestSk;
    lookupGuidToDelete = fallbackLookup.lookupGuid;
  }
  // One transaction, so a crash cannot leave a lookup row pointing at a deleted manifest row.
  const lookupGuids = Array.from(new Set([lookupGuidToDelete, normGuid]));
  await ddb.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        { Delete: { TableName: TABLE_NAME, Key: manifestRowKey(existingSk) } },
        ...lookupGuids.map((guid) => ({ Delete: { TableName: TABLE_NAME, Key: lookupRowKey(guid) } })),
      ],
    }),
  );
  stats.deletesSucceeded += 1;
};

/** The versions (key and versionId, as `refId`) an earlier record of this invocation already forwarded, per queue. */
type ForwardedRefs = { notification: Set<string>; memberStats: Set<string> };

/**
 * Forwards a record's processed bills to notificationType and to congressMemberStats: each written version once, with
 * the event's versionId, even when two records of the batch name it. Each compares that version with the one stored
 * just before it. NotificationType classifies that change (REL-59; it used to get the key alone and compare the latest
 * version, so a version followed by another within a second or two was never judged). Member stats do nothing when
 * sponsors, cosponsors, official votes and civic profile did not change (CAP-05). A key that normalization rewrote goes
 * without a version, and both read the latest.
 *
 * Deploy order (REL-59): this goes out only once NotificationType's half of REL-59 is live, which judges a named
 * version against the one stored just before it, and in a later deploy than it. A NotificationType older than that
 * judges a bill's oldest version against itself or a newer one, so a new bill's `new` can be lost. Roll this back
 * first, and NotificationType only once NotificationTypeQueue is empty and no message that names a version is
 * redriven into it (RUNBOOK 2.4, 18.10).
 */
const forwardProcessedBills = async (
  addOrUpdateRefs: ProcessedBillRef[],
  forwarded: ForwardedRefs,
): Promise<number> => {
  const jsonRefs = addOrUpdateRefs.filter((ref) => ref.key.endsWith(".json"));
  const refsToNotify = jsonRefs.filter((ref) => !forwarded.notification.has(refId(ref)));
  const refsForMemberStats = jsonRefs.filter((ref) => !forwarded.memberStats.has(refId(ref)));

  let enqueued = 0;
  if (QUEUE_URL && refsToNotify.length > 0) {
    enqueued += (await sendProcessedBillRefsToQueue(refsToNotify, QUEUE_URL)).enqueued;
  }
  if (CONGRESS_MEMBER_STATS_QUEUE_URL && refsForMemberStats.length > 0) {
    enqueued += (await sendProcessedBillRefsToQueue(refsForMemberStats, CONGRESS_MEMBER_STATS_QUEUE_URL)).enqueued;
  }
  for (const ref of refsToNotify) forwarded.notification.add(refId(ref));
  for (const ref of refsForMemberStats) forwarded.memberStats.add(refId(ref));
  return enqueued;
};

/**
 * Applies one SQS record: reads its processed bills, writes their manifest entries, removes
 * deleted ones, then forwards them unless `forward` is false. `forwarded` holds what an earlier
 * record of this invocation already forwarded, so a version named twice in one batch is forwarded
 * once.
 */
const applyRecord = async (
  record: SQSRecord,
  nowIso: string,
  stats: ManifestStats,
  forwarded: ForwardedRefs,
  forward: boolean,
): Promise<number> => {
  const deltas = extractS3DeltasFromSqsEvent({ Records: [record] });
  const addOrUpdateKeys = uniqueJsonKeys(deltas.addOrUpdateKeys);
  const removeKeys = uniqueJsonKeys(deltas.removeKeys);

  const addsByNormGuid: Record<string, ManifestRead> = {};
  for (const key of addOrUpdateKeys) {
    let read: ManifestRead | null;
    try {
      read = await readManifestEntry(key, nowIso);
    } catch (error) {
      stats.addFetchFailed += 1;
      console.error("Failed to load processed bill for manifest update", { key, error });
      throw error;
    }
    if (!read) continue;
    addsByNormGuid[normalizeBillGuidForKey(read.entry.guid)] = read;
    stats.addFetchProcessed += 1;
  }

  const removeNormGuids = new Set<string>();
  for (const key of removeKeys) {
    const lookup = parseProcessedBillLookupFromS3Key(key);
    if (!lookup) continue;
    if (lookup.kind === "guid" || lookup.kind === "guidWithLocator") removeNormGuids.add(lookup.guid);
  }
  stats.removeCount += removeNormGuids.size;

  for (const read of Object.values(addsByNormGuid)) {
    stats.upsertsAttempted += 1;
    const outcome = await upsertManifestEntry(read, nowIso);
    if (outcome === "skipped") stats.upsertsSkipped += 1;
    else stats.upsertsSucceeded += 1;
    if (outcome === "kept") stats.upsertsKeptDate += 1;
  }

  for (const normGuid of removeNormGuids) {
    await removeManifestEntry(normGuid, stats);
  }

  if (!forward) return 0;
  return forwardProcessedBills(deltas.addOrUpdateRefs, forwarded);
};

/** Lambda reads only batchItemFailures; statusCode, headers and body summarise the run for the logs. */
type ManifestUpdateResponse = SQSBatchResponse & { statusCode: number; headers: Record<string, string>; body: string };

/**
 * The SQS event, or a direct invoke of the same shape. Only a direct invoke sets `forward`: the
 * manifest backfill sends `forward: false` to write manifest rows without forwarding anything to
 * NotificationTypeQueue or CongressMemberStatsQueue. Real SQS events never carry the field, and any
 * value other than `false` forwards exactly as before.
 */
export type ManifestUpdateEvent = SQSEvent & { forward?: boolean };

export const handler = async (event: ManifestUpdateEvent): Promise<ManifestUpdateResponse> => {
  const nowIso = new Date().toISOString();
  // Echoed in every response body, so a caller can tell this code from a release that ignores the flag.
  const forward = event?.forward !== false;
  const deltas = extractS3DeltasFromSqsEvent(event);

  if (uniqueJsonKeys(deltas.addOrUpdateKeys).length === 0 && uniqueJsonKeys(deltas.removeKeys).length === 0) {
    return {
      batchItemFailures: [],
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generatedAt: nowIso,
        updated: false,
        enqueued: 0,
        addedOrUpdated: 0,
        deleted: 0,
        forward,
      }),
    };
  }

  const stats: ManifestStats = {
    addFetchProcessed: 0,
    addFetchFailed: 0,
    removeCount: 0,
    upsertsAttempted: 0,
    upsertsSucceeded: 0,
    upsertsSkipped: 0,
    upsertsKeptDate: 0,
    deletesAttempted: 0,
    deletesSucceeded: 0,
  };
  const forwarded: ForwardedRefs = { notification: new Set<string>(), memberStats: new Set<string>() };
  let enqueued = 0;

  // Records are applied one at a time, in batch order. A record whose S3 read, manifest write or
  // forward fails is reported back so SQS redelivers (and eventually dead-letters) only that
  // record; the rest of the batch is not retried or forwarded again.
  const { batchItemFailures } = await processSqsRecords(
    event,
    async (record) => {
      enqueued += await applyRecord(record, nowIso, stats, forwarded, forward);
    },
    { label: "Failed to apply bills manifest update" },
  );

  const summary = {
    generatedAt: nowIso,
    addedOrUpdated: stats.upsertsSucceeded,
    deleted: stats.deletesSucceeded,
    updated: true,
    writeAttempts: stats.upsertsAttempted + stats.deletesAttempted,
    enqueued,
    failedRecords: batchItemFailures.length,
    forward,
    stats,
  };
  // statusCode/body are kept for existing log readers; Lambda only reads batchItemFailures.
  return {
    batchItemFailures,
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(summary),
  };
};
