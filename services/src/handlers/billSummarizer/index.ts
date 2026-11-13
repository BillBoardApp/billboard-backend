import { S3Client } from "@aws-sdk/client-s3";
import { ProcessedBillDocument, RawBill, CURRENT_INTERNAL_SCHEMA } from "../../models/bill";
import { RawBillDao } from "../../adapters/rawBillDao";
import { ProcessedBillDao, type ProcessedBillRevision } from "../../adapters/processedBillDao";
import { BillStorage, isPreconditionFailure, type StoredJson } from "../../adapters/billStorage";
import { buildRawBillRootGuidKey } from "../../adapters/rawBillKeys";
import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import {
  createBedrockClient,
  invokeMessages,
  parseEffort,
  requestProfileForModel,
  type BedrockCallResult,
  type MessagesRequestBody,
} from "../../shared/bedrockMessages";
import { deriveBillStatusFromActions } from "../../shared/billOutcomes";
import {
  BILL_INGESTION_METRIC_NAMESPACE,
  extractRawBillXml,
  hasMeaningfulRawContent,
  mergeOfficialVotes,
  rawFetchedAt,
  readProcessedSource,
  reconcileProcessedBill,
  sourceTextHash,
} from "../../shared/billSourceReconcile";
import { extractCosponsorIdsFromRawBill, extractSponsorIdsFromRawBill } from "../../shared/billSponsors";
import { usableOfficialVotes } from "../../shared/congressVotes";
import { processSqsRecords } from "../../shared/sqsBatch";
import { mapWithConcurrency } from "../../shared/concurrency";
import { correlationIdFromRecord, mintCorrelationId } from "../../shared/correlation";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric, emitEmbeddedMetrics } from "../../shared/metrics";
import { reportUnprocessableMessage } from "../../shared/unprocessableMessages";
import { analyzeBill, type AnalyzeBillResult } from "./analyzeBill";
import { BILL_TEXT_BUDGET_CHARS } from "./billText";
import {
  ANALYSIS_TEXT_FIELDS,
  answerFieldText,
  buildBedrockRequestBody,
  countSentences,
  extractMinimalBillInfo,
  extractReducedBillInfo,
  interpretModelOutput,
  MinimalBillInput,
  BedrockBillAnalysis,
  type SummarizerRequestOptions,
} from "./prompts";

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const BUCKET_NAME = process.env.BUCKET_NAME!;
const MODEL_ID = process.env.MODEL_ID!;
// Throws at cold start for a model this code has no request shape for (LLM-11), before any message is taken.
const REQUEST_PROFILE = requestProfileForModel(MODEL_ID);
// output_config.effort on Haiku 5.5; Haiku 4.5 gets temperature 0 instead.
const BEDROCK_EFFORT = parseEffort(process.env.BEDROCK_EFFORT, "medium");
const MAX_BILLS_PER_BATCH = Number(process.env.MAX_BILLS_PER_BATCH!);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS!);
// Chunks of MAX_BILLS_PER_BATCH bills summarized at once, each with its own Bedrock calls.
const BEDROCK_CONCURRENCY = Number(process.env.BEDROCK_CONCURRENCY ?? "1");
// One attempt's deadline; an attempt also ends 5 s before the invocation would.
const BEDROCK_CALL_TIMEOUT_MS = Number(process.env.BEDROCK_CALL_TIMEOUT_MS ?? "60000");
const BEDROCK_MAX_RETRIES = Number(process.env.BEDROCK_MAX_RETRIES ?? "4");
const BEDROCK_BASE_DELAY_MS = Number(process.env.BEDROCK_BASE_DELAY_MS ?? "1000");
const BEDROCK_MAX_DELAY_MS = Number(process.env.BEDROCK_MAX_DELAY_MS ?? "15000");
// No Bedrock call starts with less than this left in the invocation. A timeout
// would fail the whole SQS batch, including bills already stored.
const BEDROCK_MIN_REMAINING_MS = Number(process.env.BEDROCK_MIN_REMAINING_MS ?? "20000");
const RECORD_LOAD_CONCURRENCY = 5;

// Two attempts at the conditional processed write (REL-30); the second conflict fails the record.
const SUMMARY_STORE_MAX_ATTEMPTS = 2;
// Raw versions read to check that no other text landed between the summarized one and a later one without
// text (otherTextSince). Each refetch of a voted bill writes 2, and older versions are kept 7 days; past this
// many the summary is not stored, as `too_many_versions` with its own metric.
const TEXTLESS_LATEST_MAX_GETS = 50;

const REQUEST_OPTIONS: SummarizerRequestOptions = {
  profile: REQUEST_PROFILE,
  effort: BEDROCK_EFFORT,
  maxTokens: MAX_OUTPUT_TOKENS,
};

const s3 = new S3Client({});
const bedrock = createBedrockClient();
const storage = new BillStorage(s3, BUCKET_NAME);
const rawBillDao = new RawBillDao(s3, BUCKET_NAME);
const processedBillDao = new ProcessedBillDao(s3, BUCKET_NAME);

type RemainingTime = () => number;

/**
 * A bill to summarize, and the SQS records (by index) that asked for it. The other fields come from one
 * of those records' loads, the one whose raw bill has the newest text (isNewerText); `correlationId` is
 * that record's pipeline trace id, stored on the processed bill (OBS-10). `processed` was read before
 * the raw bill (REL-30). `rawRevision` (whose value is `raw`) is the raw bill summarized: the latest
 * one, or the version billDiffer's message named (messageRawRevision); `latest` is the latest one at
 * load. `fromDiffer` is true when every record carried billDiffer's rawVersionId; only such work may
 * skip Bedrock when the summary is already current.
 */
interface BillWork {
  billId: string;
  raw: RawBill;
  rawRevision: StoredJson<RawBill>;
  latest: StoredJson<RawBill>;
  processed: ProcessedBillRevision | null;
  input: MinimalBillInput;
  recordIndexes: number[];
  correlationId: string;
  fromDiffer: boolean;
}

type LoadResult =
  | {
      kind: "bill";
      billId: string;
      raw: RawBill;
      rawRevision: StoredJson<RawBill>;
      latest: StoredJson<RawBill>;
      processed: ProcessedBillRevision | null;
      correlationId: string;
      rawVersionId?: string;
    }
  | { kind: "skip" }
  | { kind: "error"; error: Error };

type StoreOutcome = "stored" | "superseded" | "already_current";

/** Why a summary is not stored: newer text landed, an older fetch, or too many raw versions to check. */
type SupersededReason = "newer_text" | "older_fetch" | "too_many_versions";

/** The raw bill to build the processed bill from, or why the summary is not stored. */
type BaseChoice = { base: StoredJson<RawBill> } | { superseded: SupersededReason };

/** A bill Bedrock refused to summarize twice: its records are acknowledged (LLM-11). */
interface BillRefused {
  kind: "refused";
  category: string | null;
}

/** Per bill: null when done (stored or nothing to store), a refusal to acknowledge, or why its records fail. */
type BillResult = Error | null | BillRefused;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** True when the raw bill comes from an older fetch than `than` (a processed bill's source-fetched-at). */
const isOlderFetch = (rawBill: RawBill | null | undefined, than: string | undefined): boolean => {
  const fetched = Date.parse(rawFetchedAt(rawBill) ?? "");
  const reference = Date.parse(than ?? "");
  return Number.isFinite(fetched) && Number.isFinite(reference) && fetched < reference;
};

/** Positive when time `a` is later than `b`, negative when earlier, 0 when equal or either is unknown. */
const compareTimes = (a: string | undefined, b: string | undefined): number => {
  const first = Date.parse(a ?? "");
  const second = Date.parse(b ?? "");
  return Number.isFinite(first) && Number.isFinite(second) ? first - second : 0;
};

/**
 * True when `candidate` is another raw version than `current`, has bill text, and is newer: `current` has
 * no text, or `candidate` comes from a later fetch (metadata.fetchedAt, as billDiffer's stale_raw rule
 * compares), or from the same fetch and was written later (LastModified). A version without text never
 * replaces one with text.
 */
const isNewerText = (candidate: StoredJson<RawBill>, current: StoredJson<RawBill>): boolean => {
  if (!candidate.value || candidate.versionId === current.versionId) return false;
  if (extractRawBillXml(candidate.value) === "") return false;
  if (!current.value || extractRawBillXml(current.value) === "") return true;
  const byFetch = compareTimes(rawFetchedAt(candidate.value), rawFetchedAt(current.value));
  return byFetch !== 0 ? byFetch > 0 : compareTimes(candidate.lastModified, current.lastModified) > 0;
};

const logSuperseded = (
  work: BillWork,
  stage: "before_bedrock" | "store",
  reason: SupersededReason,
  latestRawVersion?: string,
): void => {
  emitEmbeddedMetric(BILL_INGESTION_METRIC_NAMESPACE, "BillSummarizerSuperseded", 1);
  // Not stored without knowing whether newer text landed: nothing re-sends it, so it gets its own metric.
  if (reason === "too_many_versions") {
    emitEmbeddedMetric(BILL_INGESTION_METRIC_NAMESPACE, "BillSummarizerTooManyVersions", 1);
  }
  logger.warn("summary_superseded", {
    event: "summary_superseded",
    guid: work.billId,
    stage,
    reason,
    summarizedRawVersion: work.rawRevision.versionId,
    latestRawVersion,
  });
};

/**
 * Parse a bill ID string like "BILLS-119hr2312rh" into components.
 * Format: BILLS-<congress><billType><billNumber><version>
 */
const parseBillId = (billId: string): { congress: string; billType: string; billNumber: string } | null => {
  // Match pattern: BILLS-<congress><billType><billNumber><version>
  // e.g., BILLS-119hr2312rh -> congress=119, billType=hr, billNumber=2312
  const match = billId.match(/^BILLS-(\d+)([a-z]+)(\d+)[a-z]*$/i);
  if (!match) {
    logger.warn(`Invalid bill ID format: ${billId}`, { billId });
    return null;
  }

  const [, congress, billType, billNumber] = match;
  return { congress, billType: billType.toLowerCase(), billNumber };
};

/**
 * Returns an SQSBatchResponse listing only the records that failed; records
 * whose bill was stored, or that can never succeed (bad body, no raw bill, no
 * bill text yet, or Bedrock refused the bill twice, reported as
 * MessagesUnprocessable), are not listed. Requires ReportBatchItemFailures on
 * the event source mapping.
 */
export const handler = async (
  event: SQSEvent,
  context?: Pick<Context, "getRemainingTimeInMillis"> & LambdaContextLike,
): Promise<SQSBatchResponse> => {
  logger.resetContext(context);
  if (!Number.isInteger(MAX_BILLS_PER_BATCH) || MAX_BILLS_PER_BATCH <= 0) {
    throw new Error("Invalid env var MAX_BILLS_PER_BATCH");
  }
  if (!Number.isInteger(MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS <= 0) {
    throw new Error("Invalid env var MAX_OUTPUT_TOKENS");
  }
  if (!Number.isInteger(BEDROCK_CONCURRENCY) || BEDROCK_CONCURRENCY <= 0) {
    throw new Error("Invalid env var BEDROCK_CONCURRENCY");
  }
  if (!Number.isFinite(BEDROCK_CALL_TIMEOUT_MS) || BEDROCK_CALL_TIMEOUT_MS <= 0) {
    throw new Error("Invalid env var BEDROCK_CALL_TIMEOUT_MS");
  }

  const records = event?.Records ?? [];
  logger.info(`Processing ${records.length} SQS records`, { records: records.length });

  const remainingMs: RemainingTime = () =>
    typeof context?.getRemainingTimeInMillis === "function"
      ? context.getRemainingTimeInMillis()
      : Number.POSITIVE_INFINITY;

  // null = done (stored or intentionally skipped); an Error = report as failed.
  const outcomes: Array<Error | null> = records.map(() => null);

  const loaded = await mapWithConcurrency(records, RECORD_LOAD_CONCURRENCY, loadRecord);

  // Several records can name the same bill; summarize it once and give every record the outcome. Records
  // can resolve to different raw versions (billDiffer's messages for two texts, when the latest raw bill
  // has no text): the newest text is summarized, since the older one's summary would be superseded by it
  // and nothing else is pending for it.
  const works = new Map<string, BillWork>();
  loaded.forEach((result, index) => {
    if (result.kind === "error") {
      outcomes[index] = result.error;
      return;
    }
    if (result.kind === "skip") return;

    const existing = works.get(result.billId);
    if (existing && !isNewerText(result.rawRevision, existing.rawRevision)) {
      existing.recordIndexes.push(index);
      existing.fromDiffer = existing.fromDiffer && Boolean(result.rawVersionId);
      return;
    }
    try {
      const input = extractMinimalBillInfo(result.raw, BILL_TEXT_BUDGET_CHARS, result.billId);
      works.set(result.billId, {
        billId: result.billId,
        raw: result.raw,
        rawRevision: result.rawRevision,
        latest: result.latest,
        processed: result.processed,
        input,
        recordIndexes: [...(existing?.recordIndexes ?? []), index],
        correlationId: result.correlationId,
        fromDiffer: (existing?.fromDiffer ?? true) && Boolean(result.rawVersionId),
      });
    } catch (error) {
      logger.error("Failed to extract bill text", { guid: result.billId, correlationId: result.correlationId, error });
      outcomes[index] = toError(error);
    }
  });

  const toAnalyze: BillWork[] = [];
  for (const work of works.values()) {
    // billDiffer's work whose summary is already current (another job stored this text's summary):
    // no Bedrock call; the catch-up reconcile brings the derived fields up to the latest raw bill.
    if (work.fromDiffer && readProcessedSource(work.processed?.metadata)?.textHash === sourceTextHash(work.raw)) {
      const error = await logger.withKeys({ guid: work.billId, correlationId: work.correlationId }, async () => {
        try {
          await catchUpAlreadyCurrent(work, "before_bedrock");
          return null;
        } catch (caught) {
          logger.error("Failed to reconcile an already current summary", { error: caught });
          return toError(caught);
        }
      });
      for (const index of work.recordIndexes) outcomes[index] = error;
      continue;
    }
    // billDiffer's stale_raw guard: the processed bill comes from a newer fetch than both the raw bill
    // to summarize and the latest one (an older fetch stored late), so a summary would roll it back,
    // unless that newer fetch has no bill text (textlessSourceBase).
    const sourceFetchedAt = readProcessedSource(work.processed?.metadata)?.fetchedAt;
    if (isOlderFetch(work.raw, sourceFetchedAt) && isOlderFetch(work.latest.value, sourceFetchedAt)) {
      const guard = await logger.withKeys({ guid: work.billId, correlationId: work.correlationId }, async () => {
        try {
          return await textlessSourceBase(work.billId, work.rawRevision, work.processed, sourceTextHash(work.raw));
        } catch (caught) {
          logger.error("Failed to read the processed bill's source raw bill", { error: caught });
          return toError(caught);
        }
      });
      if (guard instanceof Error) {
        for (const index of work.recordIndexes) outcomes[index] = guard;
        continue;
      }
      if ("superseded" in guard) {
        logSuperseded(work, "before_bedrock", guard.superseded, work.latest.versionId);
        continue;
      }
    }
    if (!work.input.hasText) {
      // Text is usually published days after a bill appears. billDiffer re-enqueues
      // the bill when its billXML changes, so the record is finished here rather
      // than failed: retrying within the queue's receive limit would not find text.
      logger.warn("bill_skipped", {
        event: "bill_skipped",
        reason: "no_bill_text",
        guid: work.billId,
        correlationId: work.correlationId,
      });
      continue;
    }
    toAnalyze.push(work);
  }

  await mapWithConcurrency(chunkArray(toAnalyze, MAX_BILLS_PER_BATCH), BEDROCK_CONCURRENCY, async (batch) => {
    const results = await summarizeBatch(batch, remainingMs);
    for (const work of batch) {
      const result = results.has(work.billId)
        ? (results.get(work.billId) ?? null)
        : new Error(`No summarizer result for ${work.billId}`);
      for (const index of work.recordIndexes) {
        if (result === null || result instanceof Error) outcomes[index] = result;
        else acknowledgeRefusal(records[index], work, result.category);
      }
    }
  });

  const response = await processSqsRecords(
    { Records: records },
    (_record, index) => {
      const error = outcomes[index];
      if (error) throw error;
    },
    { label: "billSummarizer record failed" },
  );
  logger.info(
    `Completed processing: ${records.length - response.batchItemFailures.length} done, ${response.batchItemFailures.length} failed`,
    {
      done: records.length - response.batchItemFailures.length,
      failed: response.batchItemFailures.length,
    },
  );
  return response;
};

/**
 * Resolves one SQS record to its raw bill. Never throws: load errors become
 * `error` (retried via SQS) and unusable records become `skip`.
 */
const loadRecord = (record: SQSRecord): Promise<LoadResult> =>
  logger.withKeys({ sqsMessageId: record?.messageId, correlationId: correlationIdFromRecord(record) }, () =>
    loadRecordInScope(record),
  );

const loadRecordInScope = async (record: SQSRecord): Promise<LoadResult> => {
  // Support two SQS message formats:
  // 1) Plain legacy bill ID string: "BILLS-119hr2312rh"
  // 2) JSON object with a `guid` property: "{ \"guid\": \"...\" }"
  // 3) billDiffer's `{ "guid": "...", "rawVersionId": "..." }` (REL-30); the summary is built from
  //    the latest raw bill (or, when that one cannot stand for it, the named version: messageRawRevision),
  //    and rawVersionId marks the work as billDiffer's.
  const body = toTrimmedString(record?.body);
  try {
    let guid = "";
    let parsedBody: { guid?: unknown; rawVersionId?: unknown } | null = null;
    try {
      parsedBody = JSON.parse(body);
      if (parsedBody && typeof parsedBody.guid === "string") guid = parsedBody.guid.trim();
    } catch {
      // Not JSON, fall back to legacy plain string format
    }

    // Minted here for messages sent without one (older producers, manual sends).
    const traceBill = (billId: string): string => {
      const correlationId = correlationIdFromRecord(record) ?? mintCorrelationId(billId);
      logger.appendKeys({ guid: billId, correlationId });
      return correlationId;
    };

    if (guid) {
      const correlationId = traceBill(guid);
      // The processed bill first, then the latest raw bill (REL-30): a processed write after the
      // first read fails this job's conditional write.
      const processed = await processedBillDao.getRevisionByGuid(guid);
      const latest = await rawBillDao.getRevisionByGuid(guid);
      if (!latest.value) {
        logger.warn(`Skipping bill with no raw document: ${guid}`);
        return { kind: "skip" };
      }
      const rawVersionId = toTrimmedString(parsedBody?.rawVersionId) || undefined;
      if (rawVersionId) logger.appendKeys({ rawVersionId });
      const rawRevision = rawVersionId ? await messageRawRevision(guid, latest, processed, rawVersionId) : latest;
      return {
        kind: "bill",
        billId: guid,
        raw: rawRevision.value ?? latest.value,
        rawRevision,
        latest,
        processed,
        correlationId,
        ...(rawVersionId ? { rawVersionId } : {}),
      };
    }

    const parsedId = parseBillId(body);
    if (!parsedId) {
      logger.warn(`Skipping invalid bill ID/body: ${body}`);
      return { kind: "skip" };
    }
    const correlationId = traceBill(body);
    const rawBill = await fetchRawBill(parsedId);
    return rawBill
      ? {
          kind: "bill",
          billId: body,
          raw: rawBill,
          rawRevision: { value: rawBill },
          latest: { value: rawBill },
          processed: null,
          correlationId,
        }
      : { kind: "skip" };
  } catch (error) {
    logger.error("Failed to fetch bill from record", { error });
    return { kind: "error", error: toError(error) };
  }
};

/**
 * The raw bill to summarize for billDiffer's message: the latest one, unless it cannot stand for the
 * text the message was sent for, because it was stored without bill text (fetchBillXML failed, or no
 * Formatted XML yet; billDiffer never re-sends for such a fetch) or it comes from an older fetch than
 * the processed bill's source (an older fetch stored late). Then the version the message names, when
 * it still has text: older raw versions are kept 7 days, so it is there while the message is in flight.
 */
const messageRawRevision = async (
  guid: string,
  latest: StoredJson<RawBill>,
  processed: ProcessedBillRevision | null,
  rawVersionId: string,
): Promise<StoredJson<RawBill>> => {
  if (!latest.value || latest.versionId === rawVersionId) return latest;
  const sourceFetchedAt = readProcessedSource(processed?.metadata)?.fetchedAt;
  if (extractRawBillXml(latest.value) !== "" && !isOlderFetch(latest.value, sourceFetchedAt)) return latest;
  const named = await storage.getJsonObjectWithVersionId<RawBill>(buildRawBillRootGuidKey(guid), rawVersionId);
  if (!named.value || extractRawBillXml(named.value) === "") return latest;
  logger.info("summary_from_message_version", {
    event: "summary_from_message_version",
    guid,
    rawVersionId,
    latestRawVersion: latest.versionId,
  });
  return named;
};

/**
 * Fetch raw bill by identifier.
 */
const fetchRawBill = async (id: {
  congress: string;
  billType: string;
  billNumber: string;
}): Promise<RawBill | null> => {
  const bill = await rawBillDao.get(id);
  if (!bill) {
    logger.warn("Unable to fetch raw bill by identifier", { identifier: id });
    return null;
  }
  return bill;
};

/**
 * Summarizes a chunk of bills and stores each one that gets a valid summary. Returns, per bill, null (stored, or
 * nothing to store), the refusal to acknowledge, or the reason its records fail; every bill is judged on its own,
 * and it never throws. One bill (production): analyzeBill makes up to 2 calls, the answer and then a corrective
 * call or, after a refusal, a retry on shortened text. Several bills (MAX_BILLS_PER_BATCH > 1): one call for the
 * chunk, then analyzeBill from each bill's analysis. A bill without one gets a call of its own when the response
 * was cut off, not parseable or refused, and fails when a complete response left it out.
 */
const summarizeBatch = async (batch: BillWork[], remainingMs: RemainingTime): Promise<Map<string, BillResult>> => {
  const results = new Map<string, BillResult>();
  const guids = batch.map((work) => work.billId);
  const correlationIds = batch.map((work) => work.correlationId);
  logger.info(`Processing batch of ${batch.length} bills`, { guids, correlationIds });

  if (batch.length === 1) {
    results.set(batch[0].billId, await summarizeBill(batch[0], remainingMs, { batchCall: false }));
    return results;
  }

  let call: BedrockCallResult;
  try {
    const body = buildBedrockRequestBody(
      batch.map((work) => work.input),
      REQUEST_OPTIONS,
    );
    call = await invokeSummarizer("batch", body, remainingMs, { guids, correlationIds });
  } catch (error) {
    const failure = toError(error);
    for (const guid of guids) results.set(guid, failure);
    return results;
  }

  const output = interpretModelOutput(call.text, call.stopReason, guids);
  if (!output.complete || output.unmatchedGuids.length > 0 || output.analyses.size < batch.length) {
    logger.warn("bedrock_output_problem", {
      event: "bedrock_output_problem",
      guids,
      correlationIds,
      stop_reason: call.stopReason,
      parsed: output.parsed,
      refused: output.refused,
      analysesFound: output.analyses.size,
      missingGuids: guids.filter((guid) => !output.analyses.has(guid)),
      unmatchedGuids: output.unmatchedGuids,
      ...(output.parsed || output.refused ? {} : { preview: call.text.slice(0, 300) }),
    });
  }

  for (const work of batch) {
    const candidate = output.analyses.get(work.billId);
    if (candidate === undefined && output.complete) {
      results.set(work.billId, new Error(`Analysis for ${work.billId} missing from model response`));
      continue;
    }
    // Alone, the bill's answer fits max_tokens, and the chunk's refusal may not hold for each of its bills.
    results.set(
      work.billId,
      await summarizeBill(work, remainingMs, {
        batchCall: true,
        ...(candidate === undefined ? {} : { firstCandidate: candidate }),
      }),
    );
  }
  return results;
};

/**
 * One bill through analyzeBill, then storeSummary. A stored summary writes summary_stored, the provenance
 * record (which model, how many calls, what was revised or fitted), and the BillSummarizer outcome metrics.
 */
const summarizeBill = (
  work: BillWork,
  remainingMs: RemainingTime,
  options: { batchCall: boolean; firstCandidate?: unknown },
): Promise<BillResult> =>
  logger.withKeys({ guid: work.billId, correlationId: work.correlationId }, async (): Promise<BillResult> => {
    const logFields = { guids: [work.billId], correlationIds: [work.correlationId] };
    const result = await analyzeBill(
      work.input,
      {
        invoke: (kind, body) => invokeSummarizer(kind, body, remainingMs, logFields),
        request: REQUEST_OPTIONS,
        remainingMs,
        minRemainingMs: BEDROCK_MIN_REMAINING_MS,
        log: (level, event, fields) => logger[level](event, { event, ...fields }),
      },
      {
        ...(options.firstCandidate === undefined ? {} : { firstCandidate: options.firstCandidate }),
        reducedInput: () => extractReducedBillInfo(work.raw, work.billId),
      },
    );
    const rejected = result.attempts.filter((attempt) => attempt.outcome === "issues").length;
    if (rejected > 0) emitEmbeddedMetric(BILL_INGESTION_METRIC_NAMESPACE, "BillSummarizerAnalysisRejected", rejected);
    if (result.kind === "refused") return { kind: "refused", category: result.category };
    if (result.kind === "failed") return result.error;

    try {
      const outcome = await storeSummary(work, result.analysis);
      if (outcome === "stored") logStored(work, result, result.calls + (options.batchCall ? 1 : 0));
      return null;
    } catch (error) {
      logger.error("Failed to store processed bill", { error });
      return toError(error);
    }
  });

const logStored = (work: BillWork, result: Extract<AnalyzeBillResult, { kind: "ready" }>, calls: number): void => {
  logger.info(`Stored processed bill: ${work.billId}`);
  logger.info("summary_stored", {
    event: "summary_stored",
    modelId: MODEL_ID,
    requestProfile: REQUEST_PROFILE,
    effort: REQUEST_PROFILE === "haiku-5-5" ? BEDROCK_EFFORT : null,
    calls,
    revised: result.revised,
    reducedInput: result.reducedInput,
    repairedFields: result.repairs.map((repair) => repair.field),
    // 0: stored without a civic profile (the answer scored no axis, or none the validator keeps), so member stats
    // deletes the bill's member profile rows (REL-43).
    civicAxes: Object.keys(result.analysis.civicProfile ?? {}).length,
    fields: Object.fromEntries(
      ANALYSIS_TEXT_FIELDS.map((field) => {
        const text = answerFieldText(result.analysis, field);
        return [field, { chars: text.length, sentences: countSentences(text) }];
      }),
    ),
  });
  // REL-40: Billboard-Summarizer-FieldRepairRate is RepairedBills / Stored.
  emitEmbeddedMetrics(BILL_INGESTION_METRIC_NAMESPACE, [
    { name: "BillSummarizerStored", value: 1 },
    { name: "BillSummarizerAnalysisRevised", value: result.revised ? 1 : 0 },
    { name: "BillSummarizerRepairedBills", value: result.repairs.length > 0 ? 1 : 0 },
    { name: "BillSummarizerFieldRepaired", value: result.repairs.length },
  ]);
};

/**
 * A record of a bill Bedrock refused twice is acknowledged rather than failed: SQS redeliveries would be refused
 * the same way. The bill keeps its previous summary; MessagesUnprocessable counts the drop.
 */
const acknowledgeRefusal = (record: SQSRecord, work: BillWork, category: string | null): void => {
  reportUnprocessableMessage({
    site: "billSummarizer.refused",
    reason: "refusal",
    messageId: record?.messageId,
    body: record?.body,
    fields: { guid: work.billId, correlationId: work.correlationId, category },
  });
};

/** One Bedrock call through the shared invoker: its retries, per-attempt deadline, bedrock_call line and metrics. */
const invokeSummarizer = (
  kind: string,
  body: MessagesRequestBody,
  remainingMs: RemainingTime,
  logFields: { guids: string[]; correlationIds: string[] },
): Promise<BedrockCallResult> =>
  invokeMessages({
    client: bedrock,
    modelId: MODEL_ID,
    caller: "BillSummarizer",
    kind,
    body,
    remainingMs,
    callTimeoutMs: BEDROCK_CALL_TIMEOUT_MS,
    minRemainingMs: BEDROCK_MIN_REMAINING_MS,
    maxThrottleRetries: BEDROCK_MAX_RETRIES,
    baseDelayMs: BEDROCK_BASE_DELAY_MS,
    maxDelayMs: BEDROCK_MAX_DELAY_MS,
    logFields,
  });

/**
 * billDiffer's work found the summary already current (or another job stored this text's summary
 * first): no Bedrock call, and a catch-up reconcile patches the derived fields from the latest raw
 * bill when something visible changed (REL-30).
 */
const catchUpAlreadyCurrent = async (work: BillWork, stage: "before_bedrock" | "after_conflict"): Promise<void> => {
  const result = await reconcileProcessedBill(
    {
      key: buildRawBillRootGuidKey(work.billId),
      messageGuid: work.billId,
      correlationId: work.correlationId,
      mode: "summarizer",
    },
    { storage, processedDao: processedBillDao },
  );
  emitEmbeddedMetric(BILL_INGESTION_METRIC_NAMESPACE, "BillSummarizerAlreadyCurrent", 1);
  logger.info("summary_already_current", {
    event: "summary_already_current",
    guid: work.billId,
    stage,
    reconcile: result.outcome,
    reason: result.plan.reason,
  });
};

/**
 * Whether another text landed after the raw bill summarized (`read`) and before `later`, a raw version
 * without text: "none" when every raw version written in between has no text or the summarized text;
 * "other_text" when one has other text or cannot be read, or the listing does not show `later` after
 * `read`; "too_many_versions" when more than 50 lie in between (none is read).
 */
const otherTextSince = async (
  guid: string,
  read: StoredJson<RawBill>,
  later: StoredJson<RawBill>,
  summarizedHash: string,
): Promise<"none" | "other_text" | "too_many_versions"> => {
  if (!read.versionId || !later.versionId) return "other_text";
  const key = buildRawBillRootGuidKey(guid);
  // Newest first, as S3 lists a key's versions.
  const versions = (await storage.listObjectVersionsForKey(key)).filter((version) => !version.isDeleteMarker);
  const laterIndex = versions.findIndex((version) => version.versionId === later.versionId);
  const readIndex = versions.findIndex((version) => version.versionId === read.versionId);
  if (laterIndex < 0 || readIndex <= laterIndex) return "other_text";
  const between = versions.slice(laterIndex + 1, readIndex);
  if (between.length > TEXTLESS_LATEST_MAX_GETS) return "too_many_versions";
  for (const version of between) {
    const value = (await storage.getJsonObjectWithVersionId<RawBill>(key, version.versionId)).value;
    if (!value) return "other_text";
    if (extractRawBillXml(value) !== "" && sourceTextHash(value) !== summarizedHash) return "other_text";
  }
  return "none";
};

/**
 * The raw bill to build the processed bill from, given the raw bill that was summarized (`read`) and
 * the latest one now (`latest`): the latest when it is the same version; the one read when the latest
 * comes from an older fetch (an older copy stored late) or is gone; the latest when it has the same
 * text; the latest when it has no bill text and no other text landed since the one read
 * (otherTextSince), the same rule as billDiffer's, where a fetch without text never replaces the text
 * (the one read when the latest has no meaningful content either); otherwise superseded: the raw bill
 * moved on to new text, and billDiffer's message for it summarizes that.
 */
const chooseSummaryBase = async (
  guid: string,
  read: StoredJson<RawBill>,
  latest: StoredJson<RawBill>,
  summarizedHash: string,
): Promise<BaseChoice> => {
  if (!latest.value) return { base: read };
  if (read.versionId && latest.versionId === read.versionId) return { base: latest };
  if (compareTimes(rawFetchedAt(latest.value), rawFetchedAt(read.value)) < 0) return { base: read };
  if (sourceTextHash(latest.value) === summarizedHash) return { base: latest };
  if (extractRawBillXml(latest.value) === "") {
    const since = await otherTextSince(guid, read, latest, summarizedHash);
    if (since === "none") return { base: hasMeaningfulRawContent(latest.value) ? latest : read };
    if (since === "too_many_versions") return { superseded: since };
  }
  return { superseded: "newer_text" };
};

/**
 * For a summary whose raw bill comes from an older fetch than the processed bill (billDiffer's stale_raw
 * rule): the processed bill's source raw version (source-raw-version) when it has no bill text (billDiffer
 * patched it in and kept the summarized text's hash) and no other text landed between the raw bill
 * summarized and it. A fetch without text never replaces the text, so the summary still applies, built
 * with that newer fetch's derived fields. Otherwise superseded (`older_fetch`). One GET, only on this path.
 */
const textlessSourceBase = async (
  guid: string,
  read: StoredJson<RawBill>,
  processed: ProcessedBillRevision | null,
  summarizedHash: string,
): Promise<BaseChoice> => {
  const rawVersion = readProcessedSource(processed?.metadata)?.rawVersion;
  if (rawVersion) {
    const source = await storage.getJsonObjectWithVersionId<RawBill>(buildRawBillRootGuidKey(guid), rawVersion);
    if (source.value && extractRawBillXml(source.value) === "" && hasMeaningfulRawContent(source.value)) {
      const since = await otherTextSince(guid, read, source, summarizedHash);
      if (since === "none") return { base: source };
      if (since === "too_many_versions") return { superseded: since };
    }
  }
  return { superseded: "older_fetch" };
};

/**
 * Stores the summary conditionally (REL-30), up to 2 attempts: re-reads the latest raw bill and
 * chooses the base (chooseSummaryBase), builds the processed bill from it with the member votes the
 * processed copy already had for the same roll call, records the source metadata, and writes with
 * IfMatch on the processed version read first (IfNoneMatch "*" when there is no flat object). A base
 * from an older fetch than the processed version it would replace is not stored (billDiffer's
 * stale_raw guard), unless that version's source fetch has no bill text: then the summary is built
 * from that fetch (textlessSourceBase). On a 412 or 409 it re-reads the processed bill: billDiffer's
 * work whose text another job already stored catches up instead; otherwise it retries once over the
 * new ETag, and a second conflict throws.
 */
const storeSummary = async (work: BillWork, analysis: BedrockBillAnalysis): Promise<StoreOutcome> => {
  const summarizedHash = sourceTextHash(work.raw);
  let processed = work.processed;
  for (let attempt = 1; ; attempt += 1) {
    const latest = await rawBillDao.getRevisionByGuid(work.billId);
    let choice = await chooseSummaryBase(work.billId, work.rawRevision, latest, summarizedHash);
    if ("base" in choice && isOlderFetch(choice.base.value, readProcessedSource(processed?.metadata)?.fetchedAt)) {
      choice = await textlessSourceBase(work.billId, work.rawRevision, processed, summarizedHash);
    }
    const base = "base" in choice ? choice.base : null;
    if (!base?.value) {
      logSuperseded(work, "store", "superseded" in choice ? choice.superseded : "newer_text", latest.versionId);
      return "superseded";
    }

    const processedBill = buildProcessedBill(base.value, analysis, work.billId, work.input.officialTitle);
    const officialVotes = mergeOfficialVotes(
      processed?.bill.officialVotes,
      usableOfficialVotes((base.value.content as Record<string, unknown> | undefined)?.officialVotes),
    );
    if (officialVotes) processedBill.officialVotes = officialVotes;
    else delete processedBill.officialVotes;

    const baseFetchedAt = rawFetchedAt(base.value);
    try {
      // The correlation id rides on the object's metadata into the S3-triggered steps.
      await processedBillDao.store(processedBill, {
        correlationId: work.correlationId,
        source: {
          textHash: summarizedHash,
          ...(base.versionId ? { rawVersion: base.versionId } : {}),
          ...(baseFetchedAt ? { fetchedAt: baseFetchedAt } : {}),
        },
        ...(processed?.location === "flat" && processed.etag ? { ifMatch: processed.etag } : { ifNoneMatch: "*" }),
      });
      return "stored";
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const fresh = await processedBillDao.getRevisionByGuid(work.billId);
      logger.warn("Processed bill changed while summarizing", {
        guid: work.billId,
        attempt,
        freshVersion: fresh?.versionId,
      });
      if (work.fromDiffer && readProcessedSource(fresh?.metadata)?.textHash === summarizedHash) {
        await catchUpAlreadyCurrent(work, "after_conflict");
        return "already_current";
      }
      if (attempt >= SUMMARY_STORE_MAX_ATTEMPTS) {
        throw new Error(`Processed bill ${work.billId} changed during ${attempt} summary writes`, { cause: error });
      }
      processed = fresh;
    }
  }
};

/**
 * Build a ProcessedBillDocument from raw bill and Bedrock analysis.
 */
const buildProcessedBill = (
  rawBill: RawBill,
  analysis: BedrockBillAnalysis,
  guid: string,
  extractedOfficialTitle?: string,
): ProcessedBillDocument => {
  const now = new Date().toISOString();
  const content = rawBill.content as Record<string, unknown>;
  const metadata = (rawBill as Partial<RawBill>)?.metadata;

  // Sponsors from content.bill.bill.sponsors, cosponsors from content.cosponsors.cosponsors. billDiffer
  // patches both with the same functions when only they change.
  const sponsors = extractSponsorIdsFromRawBill(rawBill);
  const cosponsors = extractCosponsorIdsFromRawBill(rawBill);

  // Extract actions from content.actions.actions
  const actions = extractActions(content);

  // Extract committees from content.committees.committees
  const committees = extractCommittees(content);
  const officialVotes = usableOfficialVotes(content?.officialVotes);

  // `title` carries the validated plain-language headline; the official title is
  // kept alongside it (LLM-05), from the bill text or else Congress's title.
  const headline = analysis.title;
  const officialTitle = toTrimmedString(extractedOfficialTitle) || toTrimmedString(metadata?.title);

  const baseLegislationUrl = toTrimmedString(metadata?.legislationUrl);
  if (!baseLegislationUrl) {
    logger.warn(`Missing legislationUrl for bill: ${guid}`, { guid });
  }
  const legislationTextUrl = baseLegislationUrl
    ? baseLegislationUrl.endsWith("/text")
      ? baseLegislationUrl
      : `${baseLegislationUrl.replace(/\/+$/, "")}/text`
    : "";

  return {
    schemaVersion: 1,
    kind: "processed",
    storedAt: now,
    identifier: rawBill.identifier,
    guid,
    title: headline,
    ...(officialTitle ? { officialTitle } : {}),
    link: legislationTextUrl,
    soWhat: analysis.soWhat,
    billBreakdown: analysis.billBreakdown,
    internalSchema: CURRENT_INTERNAL_SCHEMA,
    subCategories: analysis.subCategories,
    lifeAreas: analysis.lifeAreas,
    sponsors,
    cosponsors,
    actions,
    committees,
    billStatus: deriveBillStatusFromActions(actions),
    ...(analysis.civicProfile ? { civicProfile: analysis.civicProfile } : {}),
    ...(officialVotes ? { officialVotes } : {}),
  };
};

/**
 * Extract actions from content.actions.actions
 */
const extractActions = (content: Record<string, unknown>): unknown[] => {
  try {
    const actionsWrapper = content?.actions as Record<string, unknown> | undefined;
    const actions = actionsWrapper?.actions;
    return Array.isArray(actions) ? actions : [];
  } catch (e) {
    logger.warn("Failed to extract actions", { error: e });
    return [];
  }
};

/**
 * Extract committees from content.committees.committees
 */
const extractCommittees = (content: Record<string, unknown>): unknown[] => {
  try {
    const committeesWrapper = content?.committees as Record<string, unknown> | undefined;
    const committees = committeesWrapper?.committees;
    return Array.isArray(committees) ? committees : [];
  } catch (e) {
    logger.warn("Failed to extract committees", { error: e });
    return [];
  }
};

/**
 * Split array into chunks of specified size.
 */
const chunkArray = <T>(array: T[], size: number): T[][] => {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`Invalid chunk size: ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};
