import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";

import { CONGRESS_API_BASE_URL } from "../../shared/apiBaseUrls";
import { mapWithConcurrency } from "../../shared/concurrency";
import {
  getCongressApiKey,
  invalidateCongressApiKey,
  isCongressApiAuthFailureStatus,
} from "../../shared/congressApiKey";
import { fetchWithTimeout, redactUrl } from "../../shared/http";
import { putMetric } from "../../shared/metrics";
import { isRetryableStatus, retryDelayMs, sleep } from "../../shared/retry";

const SECRET_NAME = process.env.SECRET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const QUEUE_BATCH_SIZE = Number.parseInt(process.env.QUEUE_BATCH_SIZE!, 10);
// Optional: when set, manifest members missing from the current list are re-queued so the
// per-member pipeline can confirm their departure and retire them.
const CONGRESS_MEMBERS_MANIFEST_TABLE_NAME = process.env.CONGRESS_MEMBERS_MANIFEST_TABLE_NAME || "";
const CONGRESS_API_MAX_RETRIES = Number.parseInt(process.env.CONGRESS_API_MAX_RETRIES ?? "2", 10);
const CONGRESS_API_BASE_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_BASE_DELAY_MS ?? "500", 10);
const CONGRESS_API_MAX_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_MAX_DELAY_MS ?? "5000", 10);
const CONGRESS_API_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CONGRESS_API_REQUEST_TIMEOUT_MS ?? "4000", 10);
// congress.gov's maximum page size; the default of 20 needs ~28 pages for ~540 members.
const MEMBER_LIST_PAGE_SIZE = "250";
const CONGRESS_API_BACKOFF = { baseMs: CONGRESS_API_BASE_DELAY_MS, maxMs: CONGRESS_API_MAX_DELAY_MS };

const DEFAULT_USER_AGENT = "BillBoardFetcher/1.0 (+https://billboard-project.com/privacy.html)";

const sqs = new SQSClient({});
const ddb = new DynamoDBClient({});

type UnknownRecord = Record<string, unknown>;

const asString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const extractMembersArray = (payload: unknown): unknown[] => {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as UnknownRecord;

  // Common Congress API shapes we can tolerate:
  // - { members: [...] }
  // - { members: { member: [...] } }
  // - { members: { members: [...] } }
  // - { results: [...] }
  const members = p["members"];
  if (Array.isArray(members)) return members;
  if (members && typeof members === "object") {
    const m = members as UnknownRecord;
    if (Array.isArray(m["member"])) return m["member"] as unknown[];
    if (Array.isArray(m["members"])) return m["members"] as unknown[];
  }

  const results = p["results"];
  if (Array.isArray(results)) return results;

  return [];
};

const extractBioguideIds = (payload: unknown): string[] => {
  const members = extractMembersArray(payload);
  const out: string[] = [];

  for (const member of members) {
    if (!member || typeof member !== "object") continue;
    const m = member as UnknownRecord;

    const id =
      asString(m["bioguideId"]) ||
      asString(m["bioGuideId"]) ||
      asString(m["bioguide_id"]) ||
      (m["member"] && typeof m["member"] === "object" ? asString((m["member"] as UnknownRecord)["bioguideId"]) : null);

    if (id) out.push(id);
  }

  return out;
};

const extractNextUrl = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as UnknownRecord;
  const pagination = p["pagination"];
  if (!pagination || typeof pagination !== "object") return null;
  const next = (pagination as UnknownRecord)["next"];
  return asString(next);
};

const fetchCongressJson = async (url: string): Promise<unknown> => {
  let authRetried = false;
  for (let attempt = 0; ; attempt += 1) {
    const u = new URL(url);
    u.searchParams.set("api_key", await getCongressApiKey());
    u.searchParams.set("format", "json");

    let res: Response;
    try {
      res = await fetchWithTimeout(
        u.toString(),
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
          `Congress API network error. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${CONGRESS_API_MAX_RETRIES}) for ${redactUrl(u)}`,
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
      if (!authRetried) {
        authRetried = true;
        continue;
      }
      // Only a freshly read key being rejected is an alarmable auth failure (as in the other callers).
      console.error("Congress API rejected a freshly read API key", { status: res.status, url: redactUrl(u) });
      await putMetric("BillBoard/BillIngestion", "CongressApiAuthFailure", 1);
    } else if (isRetryableStatus(res.status) && attempt < CONGRESS_API_MAX_RETRIES) {
      const delayMs = retryDelayMs(attempt, CONGRESS_API_BACKOFF, res.headers?.get?.("retry-after") ?? undefined);
      console.warn(
        `Congress API returned ${res.status}. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${CONGRESS_API_MAX_RETRIES}) for ${redactUrl(u)}`,
      );
      await res.body?.cancel().catch(() => undefined);
      await sleep(delayMs);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Congress API request failed: status ${res.status} (${res.statusText}) body=${body.slice(0, 500)}`);
  }
};

const SQS_SEND_CONCURRENCY = 5;

const sendBioguideIdsToSqs = async (bioguideIds: string[]): Promise<{ enqueued: number }> => {
  // Prepare batches of up to QUEUE_BATCH_SIZE entries
  const batches: Array<Array<{ Id: string; MessageBody: string }>> = [];
  for (let i = 0; i < bioguideIds.length; i += QUEUE_BATCH_SIZE) {
    const batch = bioguideIds.slice(i, i + QUEUE_BATCH_SIZE);
    const entries = batch.map((bioguideId, idx) => ({
      Id: `msg-${i + idx}`,
      MessageBody: JSON.stringify({ bioguideId }),
    }));
    batches.push(entries);
  }

  // Task for sending a single batch; returns number of successful messages
  const sendBatch = async (entries: Array<{ Id: string; MessageBody: string }>): Promise<number> => {
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: entries,
      }),
    );

    const failedCount = response.Failed ? response.Failed.length : 0;
    const successfulCount = response.Successful ? response.Successful.length : entries.length - failedCount;

    if (failedCount > 0) {
      for (const failure of response.Failed ?? []) {
        console.error("Failed to push bioguideId to SQS:", failure);
      }
      throw new Error(`Failed to enqueue ${failedCount} messages to SQS`);
    }

    return successfulCount;
  };

  const counts = await mapWithConcurrency(batches, SQS_SEND_CONCURRENCY, sendBatch);
  return { enqueued: counts.reduce((sum, count) => sum + count, 0) };
};

const loadManifestBioguideIds = async (): Promise<string[]> => {
  const ids: string[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
        ProjectionExpression: "bioguideId",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of response.Items ?? []) {
      const id = asString(item?.bioguideId?.S);
      if (id) ids.push(id);
    }
    startKey = response.LastEvaluatedKey;
  } while (startKey);
  return ids;
};

/**
 * Re-queues manifest members that the complete current-member list no longer contains.
 * Nothing is deleted here: fetchRawCongressMembers re-reads each member's detail and the
 * summarizer retires only those congress.gov explicitly marks `currentMember: false`, so a
 * current member missing from one list run is simply refreshed.
 */
const requeueMembersMissingFromList = async (currentIds: Set<string>): Promise<number> => {
  if (!CONGRESS_MEMBERS_MANIFEST_TABLE_NAME) {
    console.log("CONGRESS_MEMBERS_MANIFEST_TABLE_NAME not set; skipping departed-member check");
    return 0;
  }
  if (currentIds.size === 0) {
    console.warn("Current member list was empty; skipping departed-member check");
    return 0;
  }

  try {
    const missing = Array.from(new Set(await loadManifestBioguideIds())).filter((id) => !currentIds.has(id));
    if (missing.length === 0) return 0;
    console.log("Re-checking manifest members missing from the current member list:", missing);
    const { enqueued } = await sendBioguideIdsToSqs(missing);
    return enqueued;
  } catch (error) {
    // The current-member enqueue already succeeded; failing here would make the scheduled
    // invocation retry and re-enqueue every member.
    console.error("Departed-member check failed", error);
    return 0;
  }
};

export async function handler(): Promise<{
  status: "ok";
  discovered: number;
  enqueued: number;
  pages: number;
  departedChecks: number;
}> {
  if (!SECRET_NAME) throw new Error("Missing env var SECRET_NAME");
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");

  const initialUrl = new URL(`${CONGRESS_API_BASE_URL}/member`);
  initialUrl.searchParams.set("currentMember", "true");
  initialUrl.searchParams.set("limit", MEMBER_LIST_PAGE_SIZE);

  const seen = new Set<string>();
  let pages = 0;
  let url: string | null = initialUrl.toString();

  // Safety guard to prevent infinite loops if pagination is malformed.
  const maxPages = 500;

  let enqueued = 0;

  while (url) {
    pages += 1;
    if (pages > maxPages) {
      throw new Error(`Pagination exceeded maxPages=${maxPages}; lastUrl=${redactUrl(url)}`);
    }

    const payload = await fetchCongressJson(url);
    const ids = extractBioguideIds(payload);

    const newIds: string[] = [];
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        newIds.push(id);
      }
    }

    // Pages hold up to 250 members, so there are only a few; awaiting each page's enqueue
    // keeps the count exact and surfaces SQS failures.
    if (newIds.length > 0) {
      enqueued += (await sendBioguideIdsToSqs(newIds)).enqueued;
    }

    url = extractNextUrl(payload);
  }

  console.log("Discovered bioguideIds:", seen.size);
  console.log("Enqueued bioguideIds to SQS:", enqueued);

  // Only reached after every page was fetched, so `seen` is the complete current roster.
  const departedChecks = await requeueMembersMissingFromList(seen);

  return { status: "ok", discovered: seen.size, enqueued, pages, departedChecks };
}
