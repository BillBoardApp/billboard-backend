import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

import { RawCongressMemberDao } from "../../adapters/rawCongressMemberDao";
import { CONGRESS_API_BASE_URL } from "../../shared/apiBaseUrls";
import {
  getCongressApiKey,
  invalidateCongressApiKey,
  isCongressApiAuthFailureStatus,
} from "../../shared/congressApiKey";
import { fetchWithTimeout, redactUrl } from "../../shared/http";
import { putMetric } from "../../shared/metrics";
import { isRetryableStatus, retryDelayMs, sleep } from "../../shared/retry";
import { processSqsRecords } from "../../shared/sqsBatch";
import { normalizeCongressMemberPayload } from "../../models/congressMember";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const SECRET_NAME = process.env.SECRET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const QUEUE_BATCH_SIZE = Number.parseInt(process.env.QUEUE_BATCH_SIZE!, 10);
// Same defaults as fetchRawBill so all congress.gov callers pace themselves alike.
const CONGRESS_API_MAX_RETRIES = Number.parseInt(process.env.CONGRESS_API_MAX_RETRIES ?? "2", 10);
const CONGRESS_API_BASE_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_BASE_DELAY_MS ?? "500", 10);
const CONGRESS_API_MAX_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_MAX_DELAY_MS ?? "5000", 10);
const CONGRESS_API_CALL_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_CALL_DELAY_MS ?? "1200", 10);
const CONGRESS_API_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CONGRESS_API_REQUEST_TIMEOUT_MS ?? "4000", 10);
const CONGRESS_API_BACKOFF = { baseMs: CONGRESS_API_BASE_DELAY_MS, maxMs: CONGRESS_API_MAX_DELAY_MS };

const DEFAULT_USER_AGENT = "BillBoardFetcher/1.0 (+https://billboard-project.com/privacy.html)";

const s3 = new S3Client({});
const sqs = new SQSClient({});
const rawMemberDao = new RawCongressMemberDao(s3, BUCKET_NAME);

const fetchMemberByBioguideId = async (bioguideId: string): Promise<unknown> => {
  let authRetried = false;
  for (let attempt = 0; ; attempt += 1) {
    const url = new URL(`${CONGRESS_API_BASE_URL}/member/${bioguideId}`);
    url.searchParams.set("api_key", await getCongressApiKey());
    url.searchParams.set("format", "json");

    let res: Response;
    try {
      res = await fetchWithTimeout(
        url.toString(),
        {
          method: "GET",
          headers: {
            "User-Agent": DEFAULT_USER_AGENT,
            Accept: "application/json",
          },
        },
        CONGRESS_API_REQUEST_TIMEOUT_MS,
      );
      // Read the body inside the try: the timeout also covers the body, and a cut-off body is retryable.
      if (res.ok) return await res.json();
    } catch (error) {
      if (attempt < CONGRESS_API_MAX_RETRIES) {
        const delayMs = retryDelayMs(attempt, CONGRESS_API_BACKOFF);
        console.warn(
          `Congress API network error. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${CONGRESS_API_MAX_RETRIES}) for ${redactUrl(url)}`,
          error,
        );
        await sleep(delayMs);
        continue;
      }
      throw error;
    }

    if (isCongressApiAuthFailureStatus(res.status)) {
      // The cached key may have been rotated; drop it and retry once with a fresh read.
      invalidateCongressApiKey();
      await putMetric("BillBoard/BillIngestion", "CongressApiAuthFailure", 1);
      if (!authRetried) {
        authRetried = true;
        continue;
      }
    } else if (isRetryableStatus(res.status) && attempt < CONGRESS_API_MAX_RETRIES) {
      const delayMs = retryDelayMs(attempt, CONGRESS_API_BACKOFF, res.headers?.get?.("retry-after") ?? undefined);
      console.warn(
        `Congress API returned ${res.status}. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${CONGRESS_API_MAX_RETRIES}) for ${redactUrl(url)}`,
      );
      await res.body?.cancel().catch(() => undefined);
      await sleep(delayMs);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(
      `Congress API member request failed: status ${res.status} (${res.statusText}) body=${body.slice(0, 500)}`,
    );
  }
};

const parseBioguideId = (record: SQSRecord): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.body);
  } catch {
    throw new Error("Invalid JSON in SQS message body");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid SQS message payload");
  }

  const bioguideId = (parsed as { bioguideId?: unknown }).bioguideId;
  if (typeof bioguideId !== "string" || bioguideId.trim().length === 0) {
    throw new Error("Missing bioguideId in SQS message payload");
  }

  return bioguideId.trim();
};

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  if (!BUCKET_NAME) throw new Error("Missing env var BUCKET_NAME");
  if (!SECRET_NAME) throw new Error("Missing env var SECRET_NAME");
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");
  if (!Number.isFinite(QUEUE_BATCH_SIZE) || QUEUE_BATCH_SIZE <= 0 || QUEUE_BATCH_SIZE > 10) {
    throw new Error("Invalid env var QUEUE_BATCH_SIZE");
  }

  const records = event.Records ?? [];
  if (records.length === 0) {
    return { batchItemFailures: [] };
  }

  const storedIds: string[] = [];
  const storedIdToRecordIds = new Map<string, string[]>();
  let apiCalls = 0;

  // One record at a time with a pause between congress.gov calls (as fetchRawBill does),
  // instead of firing the whole batch at the API in parallel.
  const { batchItemFailures } = await processSqsRecords(
    event,
    async (record: SQSRecord) => {
      const bioguideId = parseBioguideId(record);
      const recordIds = storedIdToRecordIds.get(bioguideId);
      if (recordIds) {
        // Same member twice in one batch: fetched once, both messages share the outcome.
        recordIds.push(record.messageId);
        return;
      }

      if (apiCalls > 0 && CONGRESS_API_CALL_DELAY_MS > 0) {
        await sleep(CONGRESS_API_CALL_DELAY_MS);
      }
      apiCalls += 1;

      const payload = normalizeCongressMemberPayload(await fetchMemberByBioguideId(bioguideId));
      await rawMemberDao.store(bioguideId, payload);

      storedIds.push(bioguideId);
      storedIdToRecordIds.set(bioguideId, [record.messageId]);
    },
    { label: "Failed to process SQS record:" },
  );
  const batchFailureIds = new Set<string>(batchItemFailures.map((failure) => failure.itemIdentifier));

  // After raw objects exist in S3, enqueue for processing into the app-friendly format.
  for (let i = 0; i < storedIds.length; i += QUEUE_BATCH_SIZE) {
    const batch = storedIds.slice(i, i + QUEUE_BATCH_SIZE);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: batch.map((bioguideId, idx) => ({
          Id: `msg-${i + idx}`,
          MessageBody: JSON.stringify({ bioguideId }),
        })),
      }),
    );

    if (response.Failed && response.Failed.length > 0) {
      for (const failure of response.Failed) {
        console.error("Failed to enqueue raw congress member bioguideId to SQS:", failure);
        const failedIndex = failure.Id ? Number.parseInt(failure.Id.replace("msg-", ""), 10) : NaN;
        const offset = Number.isFinite(failedIndex) ? failedIndex - i : -1;
        const failedBioguideId = offset >= 0 ? batch[offset] : undefined;
        if (!failedBioguideId) continue;
        for (const messageId of storedIdToRecordIds.get(failedBioguideId) ?? []) {
          batchFailureIds.add(messageId);
        }
      }
    }
  }

  return {
    batchItemFailures: Array.from(batchFailureIds).map((itemIdentifier) => ({ itemIdentifier })),
  };
}
