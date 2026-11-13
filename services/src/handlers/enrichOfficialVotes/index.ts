import { S3Client } from "@aws-sdk/client-s3";
import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import type { IncomingHttpHeaders } from "http";
import { request as httpsRequest } from "https";

import type { OfficialChamberVote, OfficialVoteMember, RawBill } from "../../models/bill";
import { isPreconditionFailure } from "../../adapters/billStorage";
import { RawBillDao } from "../../adapters/rawBillDao";
import { CONGRESS_API_BASE_URL } from "../../shared/apiBaseUrls";
import { mapWithConcurrency } from "../../shared/concurrency";
import {
  getCongressApiKey,
  invalidateCongressApiKey,
  isCongressApiAuthFailureStatus,
} from "../../shared/congressApiKey";
import {
  computeCompleteness,
  countVotesByPosition,
  extractHouseRollCallRef,
  extractOfficialVotesFromActions,
  extractSenateRollCallRef,
  mapMemberVote,
  mergeHouseMembersIntoOfficialVotes,
  upsertOfficialChamberVote,
} from "../../shared/congressVotes";
import { correlationIdFromRecord, correlationIdMessageAttributes, mintCorrelationId } from "../../shared/correlation";
import { applySocketTimeout } from "../../shared/http";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric, putMetric } from "../../shared/metrics";
import { isRetryableStatus, retryDelayMs, sleep } from "../../shared/retry";
import { reportUnprocessableMessage } from "../../shared/unprocessableMessages";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const SECRET_NAME = process.env.SECRET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const ENRICHMENT_QUEUE_URL = process.env.ENRICHMENT_QUEUE_URL || process.env.SOURCE_QUEUE_URL || "";
const CONGRESS_MEMBERS_MANIFEST_TABLE_NAME = process.env.CONGRESS_MEMBERS_MANIFEST_TABLE_NAME || "";

const QUEUE_BATCH_SIZE = Number.parseInt(process.env.QUEUE_BATCH_SIZE ?? "5", 10);
const CONGRESS_API_MAX_RETRIES = Number.parseInt(process.env.CONGRESS_API_MAX_RETRIES ?? "2", 10);
const CONGRESS_API_BASE_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_BASE_DELAY_MS ?? "750", 10);
const CONGRESS_API_MAX_DELAY_MS = Number.parseInt(process.env.CONGRESS_API_MAX_DELAY_MS ?? "5000", 10);
// Socket inactivity timeout for congress.gov and senate.gov requests; a stalled socket is retried like a network error.
const CONGRESS_API_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.CONGRESS_API_REQUEST_TIMEOUT_MS ?? "10000", 10);
const CONGRESS_VOTE_CALL_DELAY_MS = Number.parseInt(process.env.CONGRESS_VOTE_CALL_DELAY_MS ?? "1500", 10);
const CONGRESS_API_MAX_HOUSE_VOTE_PAGES = Number.parseInt(process.env.CONGRESS_API_MAX_HOUSE_VOTE_PAGES ?? "2", 10);
const CONGRESS_VOTE_MAX_CALLS_PER_BILL = Number.parseInt(process.env.CONGRESS_VOTE_MAX_CALLS_PER_BILL ?? "4", 10);
const VOTE_ENRICHMENT_DEFER_DELAY_SECONDS = Number.parseInt(
  process.env.VOTE_ENRICHMENT_DEFER_DELAY_SECONDS ?? "900",
  10,
);
const VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS = Number.parseInt(process.env.VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS ?? "4", 10);
const HOUSE_ROLLCALL_ENDPOINT_TEMPLATE =
  process.env.HOUSE_ROLLCALL_ENDPOINT_TEMPLATE ||
  `${CONGRESS_API_BASE_URL}/house-vote/{congress}/{session}/{rollCall}/members`;
const SENATE_ROLLCALL_XML_BASE_URL =
  process.env.SENATE_ROLLCALL_XML_BASE_URL || "https://www.senate.gov/legislative/LIS/roll_call_votes";

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const rawBillDao = new RawBillDao(s3, BUCKET_NAME);

const DEFAULT_USER_AGENT = "BillBoardFetcher/1.0 (+https://billboard-project.com/privacy.html)";
const METRIC_NAMESPACE = "BillBoard/BillIngestion";
const RETRY_BACKOFF = { baseMs: CONGRESS_API_BASE_DELAY_MS, maxMs: CONGRESS_API_MAX_DELAY_MS };
// Parsing a Senate member waits on the shared manifest lookup; bound the fan-out (REL-17).
const SENATE_MEMBER_PARSE_CONCURRENCY = 5;
// Conditional raw writes (REL-36): a write refused this many times fails the record.
const ENRICHMENT_WRITE_MAX_ATTEMPTS = 3;

// The Senate lookup is rebuilt hourly, so a senator sworn in mid-session resolves soon after
// the manifest has them (REL-46).
const SENATE_LOOKUP_TTL_MS = 60 * 60 * 1000;
let cachedSenateBioguideLookupPromise: Promise<Map<string, string>> | null = null;
let cachedSenateBioguideLookupAt = 0;

class EnqueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnqueueError";
  }
}

class VoteRecordPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoteRecordPendingError";
  }
}

// congress.gov rejected the key even after it was re-read from Secrets Manager.
class CongressApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CongressApiAuthError";
  }
}

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripXmlTags = (value: string): string => value.replace(/<[^>]+>/g, " ");

const cleanXmlText = (value: string): string => decodeXmlEntities(stripXmlTags(value)).replace(/\s+/g, " ").trim();
const normalizeLettersOnly = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
const stripTrailingPartyState = (value: string): string => value.replace(/\s*\([^)]+\)\s*$/, "").trim();
const SENATE_NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

const buildSenateNameKeys = (value: string): string[] => {
  const cleaned = stripTrailingPartyState(toTrimmedString(value));
  if (!cleaned) return [];

  const tokens = cleaned
    .split(/\s+/)
    .map((token) => normalizeLettersOnly(token))
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return [];

  const keys = new Set<string>();
  keys.add(tokens.join(""));
  if (tokens.length > 1) {
    for (let index = 1; index < tokens.length; index += 1) {
      keys.add(tokens.slice(index).join(""));
    }
  }
  keys.add(tokens[tokens.length - 1]);
  const nonSuffixTokens = tokens.filter((token) => !SENATE_NAME_SUFFIXES.has(token));
  if (nonSuffixTokens.length > 0) {
    keys.add(nonSuffixTokens[nonSuffixTokens.length - 1]);
  }
  return [...keys].filter((key) => key.length > 0);
};

const looksLikeCanonicalBioguideId = (value: string): boolean => /^[A-Z]\d{6}$/i.test(value);

const loadSenateBioguideLookup = async (): Promise<Map<string, string>> => {
  if (!CONGRESS_MEMBERS_MANIFEST_TABLE_NAME) return new Map<string, string>();
  if (cachedSenateBioguideLookupPromise && Date.now() - cachedSenateBioguideLookupAt < SENATE_LOOKUP_TTL_MS) {
    return cachedSenateBioguideLookupPromise;
  }

  cachedSenateBioguideLookupAt = Date.now();
  const lookupPromise = (async () => {
    const candidateIdsByKey = new Map<string, Set<string>>();
    let startKey: Record<string, AttributeValue> | undefined;

    do {
      const response = await ddb.send(
        new ScanCommand({
          TableName: CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
          ProjectionExpression: "bioguideId, #name, chamber, #state",
          ExpressionAttributeNames: {
            "#name": "name",
            "#state": "state",
          },
          ExclusiveStartKey: startKey,
        }),
      );

      for (const item of response.Items ?? []) {
        const chamber = toTrimmedString(item?.chamber?.S);
        if (chamber !== "Senate") continue;

        const bioguideId = toTrimmedString(item?.bioguideId?.S).toUpperCase();
        const state = toTrimmedString(item?.state?.S).toUpperCase();
        const name = toTrimmedString(item?.name?.S);
        if (!bioguideId || !state || !name) continue;

        for (const key of buildSenateNameKeys(name)) {
          const compositeKey = `${state}|${key}`;
          const existing = candidateIdsByKey.get(compositeKey) ?? new Set<string>();
          existing.add(bioguideId);
          candidateIdsByKey.set(compositeKey, existing);
        }
      }

      startKey = response.LastEvaluatedKey;
    } while (startKey);

    const resolved = new Map<string, string>();
    for (const [key, ids] of candidateIdsByKey.entries()) {
      if (ids.size === 1) {
        resolved.set(key, [...ids][0]);
      }
    }
    return resolved;
  })();
  cachedSenateBioguideLookupPromise = lookupPromise;
  // Do not keep a failed scan cached; the next call retries it.
  lookupPromise.catch(() => {
    if (cachedSenateBioguideLookupPromise === lookupPromise) cachedSenateBioguideLookupPromise = null;
  });

  return lookupPromise;
};

const resolveSenateBioguideId = async (rawId: string, displayName: string, state?: string): Promise<string> => {
  const normalizedRawId = toTrimmedString(rawId).toUpperCase();
  const normalizedState = toTrimmedString(state).toUpperCase();
  if (normalizedState) {
    const lookup = await loadSenateBioguideLookup();
    for (const key of buildSenateNameKeys(displayName)) {
      const resolved = lookup.get(`${normalizedState}|${key}`);
      if (resolved) return resolved;
    }
  }

  if (looksLikeCanonicalBioguideId(normalizedRawId)) return normalizedRawId;
  return normalizedRawId;
};

interface HttpsTextResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

// GET over HTTPS with a socket inactivity timeout (REL-05). Resolves for any HTTP status and
// rejects on network errors, including the TimeoutError raised when the socket stalls.
const httpsGetText = (url: string, accept: string, label: string): Promise<HttpsTextResponse> =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Accept: accept,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        // A connection reset mid-body surfaces here, not on req.
        res.on("error", reject);
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );

    req.on("error", reject);
    applySocketTimeout(req, CONGRESS_API_REQUEST_TIMEOUT_MS, label);
    req.end();
  });

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// A 401/403 refreshes the API key and retries once, since the cached key may have been rotated (REL-13).
const fetchFromCongressAPI = async (
  url: string,
  attempt = 0,
  keyRefreshed = false,
): Promise<Record<string, unknown>> => {
  const apiKey = await getCongressApiKey();
  const fullUrl = `${url}${url.includes("?") ? "&" : "?"}api_key=${apiKey}&format=json`;

  let response: HttpsTextResponse;
  try {
    response = await httpsGetText(fullUrl, "application/json", "Congress API request");
  } catch (error) {
    if (attempt < CONGRESS_API_MAX_RETRIES) {
      await sleep(retryDelayMs(attempt, RETRY_BACKOFF));
      return fetchFromCongressAPI(url, attempt + 1, keyRefreshed);
    }
    throw new Error(`Network error fetching ${url}: ${errorMessage(error)}`, { cause: error });
  }

  const { statusCode } = response;
  if (statusCode === 429) {
    await putMetric(METRIC_NAMESPACE, "CongressApi429", 1);
  }

  if (isRetryableStatus(statusCode) && attempt < CONGRESS_API_MAX_RETRIES) {
    await sleep(retryDelayMs(attempt, RETRY_BACKOFF, response.headers["retry-after"]));
    return fetchFromCongressAPI(url, attempt + 1, keyRefreshed);
  }

  if (isCongressApiAuthFailureStatus(statusCode)) {
    if (!keyRefreshed) {
      invalidateCongressApiKey();
      logger.warn(`Congress API returned ${statusCode}. Refreshing the API key and retrying once`, { url, statusCode });
      return fetchFromCongressAPI(url, attempt, true);
    }
    await putMetric(METRIC_NAMESPACE, "CongressApiAuthFailure", 1);
    throw new CongressApiAuthError(`Congress API request failed with status ${statusCode} for ${url}`);
  }

  if (statusCode !== 200) {
    throw new Error(`Congress API request failed with status ${statusCode} for ${url}`);
  }

  try {
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse JSON response from ${url}`);
  }
};

const fetchText = async (url: string, accept: string, attempt = 0): Promise<{ body: string; statusCode: number }> => {
  let response: HttpsTextResponse;
  try {
    response = await httpsGetText(url, accept, "Vote record request");
  } catch (error) {
    if (attempt < CONGRESS_API_MAX_RETRIES) {
      await sleep(retryDelayMs(attempt, RETRY_BACKOFF));
      return fetchText(url, accept, attempt + 1);
    }
    throw new Error(`Network error fetching ${url}: ${errorMessage(error)}`, { cause: error });
  }

  const { statusCode } = response;
  if (isRetryableStatus(statusCode) && attempt < CONGRESS_API_MAX_RETRIES) {
    await sleep(retryDelayMs(attempt, RETRY_BACKOFF, response.headers["retry-after"]));
    return fetchText(url, accept, attempt + 1);
  }

  if (statusCode === 404) {
    throw new VoteRecordPendingError(`Vote record not available yet for ${url}`);
  }

  if (statusCode !== 200) {
    throw new Error(`Vote record request failed with status ${statusCode} for ${url}`);
  }

  return { body: response.body, statusCode };
};

const extractXmlTagValue = (xml: string, tagNames: string[]): string | null => {
  for (const tagName of tagNames) {
    const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
    const match = xml.match(pattern);
    if (!match) continue;
    const cleaned = cleanXmlText(match[1]);
    if (cleaned) return cleaned;
  }
  return null;
};

const extractXmlBlocks = (xml: string, tagName: string): string[] => {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    out.push(match[1]);
  }
  return out;
};

const normalizeXmlVotePosition = (value: string): OfficialVoteMember["votePosition"] => {
  const normalized = value.toLowerCase();
  if (["yea", "yes", "aye", "guilty"].includes(normalized)) return "Yea";
  if (["nay", "no", "not guilty"].includes(normalized)) return "Nay";
  if (normalized === "present") return "Present";
  if (["not voting", "absent"].includes(normalized)) return "Not Voting";
  return "Unknown";
};

const congressStartYear = (congress: string): number | null => {
  const parsed = Number.parseInt(congress, 10);
  if (!Number.isFinite(parsed)) return null;
  return 1789 + (parsed - 1) * 2;
};

const deriveCongressSession = (congress: string, actionDate?: string): 1 | 2 => {
  const startYear = congressStartYear(congress);
  const actionYear = (() => {
    const source = toTrimmedString(actionDate);
    if (!source) return new Date().getUTCFullYear();
    const parsed = new Date(source);
    return Number.isNaN(parsed.getTime()) ? new Date().getUTCFullYear() : parsed.getUTCFullYear();
  })();

  if (startYear === null) return 1;
  const offset = actionYear - startYear;
  if (offset <= 0) return 1;
  return offset >= 1 ? 2 : 1;
};

const buildSenateVoteXmlUrl = (congress: string, session: 1 | 2, rollCallNumber: string): string => {
  const paddedRollCall = rollCallNumber.padStart(5, "0");
  return `${SENATE_ROLLCALL_XML_BASE_URL}/vote${congress}${session}/vote_${congress}_${session}_${paddedRollCall}.xml`;
};

const normalizeVoteDate = (value: string | null, fallback?: string): string | undefined => {
  const fallbackValue = toTrimmedString(fallback);
  const candidate = value ?? (fallbackValue || null);
  if (!candidate) return undefined;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
};

const parseSenateMembers = async (xml: string): Promise<OfficialVoteMember[]> =>
  (
    await mapWithConcurrency(extractXmlBlocks(xml, "member"), SENATE_MEMBER_PARSE_CONCURRENCY, async (block) => {
      const id =
        extractXmlTagValue(block, [
          "bioguide_id",
          "bioguideId",
          "member_id",
          "memberId",
          "lis_member_id",
          "lisMemberId",
        ]) ?? "";
      const state = extractXmlTagValue(block, ["state", "state_code", "stateCode"]) ?? undefined;
      const displayName =
        extractXmlTagValue(block, ["member_full", "memberFull", "name", "full_name"]) ??
        extractXmlTagValue(block, ["last_name", "lastName"]) ??
        "";
      const voteCast = extractXmlTagValue(block, ["vote_cast", "voteCast", "vote_position", "votePosition"]) ?? "";

      if (!id || !displayName || !voteCast) return null;

      return {
        bioguideId: await resolveSenateBioguideId(id, displayName, state),
        displayName,
        party: extractXmlTagValue(block, ["party"]),
        state,
        votePosition: normalizeXmlVotePosition(voteCast),
      } as OfficialVoteMember;
    })
  ).filter((member): member is OfficialVoteMember => Boolean(member));

const buildSenateVoteFromXml = async (
  xml: string,
  ref: { actionDate?: string; actionCode?: string; resultText?: string },
): Promise<OfficialChamberVote> => {
  const members = await parseSenateMembers(xml);
  const counts = countVotesByPosition(members);
  const resultText =
    extractXmlTagValue(xml, ["vote_result_text", "voteResultText", "vote_result", "voteResult", "question"]) ??
    ref.resultText;
  const actionDate = normalizeVoteDate(
    extractXmlTagValue(xml, ["vote_date", "voteDate", "modify_date", "modifyDate"]),
    ref.actionDate,
  );

  return {
    ...counts,
    actionCode: ref.actionCode,
    actionDate,
    resultText: resultText ?? undefined,
    memberDataAvailable: members.length > 0,
    members,
  };
};

const extractMembersFromPayload = (payload: Record<string, unknown>): Record<string, unknown>[] => {
  const candidates: unknown[] = [
    payload.members,
    payload.votes,
    payload.results,
    (payload.houseRollCallVoteMemberVotes as Record<string, unknown> | undefined)?.results,
    (payload.houseRollCallVoteMemberVotes as Record<string, unknown> | undefined)?.members,
    (payload.houseRollCallVote as Record<string, unknown> | undefined)?.members,
    (payload.houseRollCallVote as Record<string, unknown> | undefined)?.votes,
    (payload.rollCallVote as Record<string, unknown> | undefined)?.members,
    (payload.rollCallVote as Record<string, unknown> | undefined)?.votes,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
    }
  }

  return [];
};

const hasMorePages = (payload: Record<string, unknown>, fetchedCount: number, limit: number): boolean => {
  const houseMemberResults = (payload.houseRollCallVoteMemberVotes as Record<string, unknown> | undefined)?.results;
  if (Array.isArray(houseMemberResults)) {
    return false;
  }

  const nextUrlCandidates = [
    (payload.pagination as Record<string, unknown> | undefined)?.next,
    (payload.houseRollCallVoteMemberVotes as Record<string, unknown> | undefined)?.next,
    (payload.houseRollCallVote as Record<string, unknown> | undefined)?.next,
    (payload.rollCallVote as Record<string, unknown> | undefined)?.next,
  ];
  if (nextUrlCandidates.some((candidate) => typeof candidate === "string" && candidate.trim().length > 0)) {
    return true;
  }
  return fetchedCount >= limit;
};

const buildHouseVotesUrl = (
  congress: string,
  sessionNumber: string,
  rollCallNumber: string,
  offset: number,
  limit: number,
): string => {
  const base = HOUSE_ROLLCALL_ENDPOINT_TEMPLATE.replace("{congress}", encodeURIComponent(congress))
    .replace("{session}", encodeURIComponent(sessionNumber))
    .replace("{rollCall}", encodeURIComponent(rollCallNumber));
  const queryGlue = base.includes("?") ? "&" : "?";
  return `${base}${queryGlue}limit=${limit}&offset=${offset}`;
};

// Every message carries `correlationId` (the bill's pipeline trace id) as a message attribute.
const enqueueGuids = async (queueUrl: string, guids: string[], correlationId?: string) => {
  if (!queueUrl || guids.length === 0) return;
  for (let i = 0; i < guids.length; i += QUEUE_BATCH_SIZE) {
    const batch = guids.slice(i, i + QUEUE_BATCH_SIZE);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((guid, idx) => ({
          Id: `msg-${i + idx}`,
          MessageBody: JSON.stringify({ guid }),
          ...correlationIdMessageAttributes(correlationId),
        })),
      }),
    );

    const failed = response.Failed ?? [];
    if (failed.length > 0) {
      const failedGuids: string[] = [];
      for (const failure of failed) {
        const failedIndex = failure.Id ? Number.parseInt(failure.Id.replace("msg-", ""), 10) : NaN;
        const offset = Number.isFinite(failedIndex) ? failedIndex - i : -1;
        const guid = offset >= 0 ? batch[offset] : undefined;
        if (guid) failedGuids.push(guid);
      }
      throw new EnqueueError(
        `Failed to enqueue ${failed.length} vote enrichment guid message(s) to ${queueUrl}: ${failedGuids.join(", ")}`,
      );
    }
  }
};

const requeueDeferred = async (guid: string, attempt: number, correlationId?: string) => {
  if (!ENRICHMENT_QUEUE_URL) return;
  const response = await sqs.send(
    new SendMessageBatchCommand({
      QueueUrl: ENRICHMENT_QUEUE_URL,
      Entries: [
        {
          Id: `defer-${guid}-${Date.now()}`,
          MessageBody: JSON.stringify({ guid, attempt }),
          DelaySeconds: Math.max(0, Math.min(900, VOTE_ENRICHMENT_DEFER_DELAY_SECONDS)),
          ...correlationIdMessageAttributes(correlationId),
        },
      ],
    }),
  );
  const failed = response.Failed ?? [];
  if (failed.length > 0) {
    throw new EnqueueError(
      `Failed to defer vote enrichment message for ${guid}: ${failed.map((f) => f.Message ?? f.Id ?? "unknown").join(", ")}`,
    );
  }
};

const isRetryableCongressError = (error: unknown): boolean => {
  if (error instanceof VoteRecordPendingError) return true;
  // A rejected key is our configuration problem, not a missing vote record: defer instead of
  // finalizing the bill as partial, so a key fixed within the deferral window still completes it.
  if (error instanceof CongressApiAuthError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /status\s(404|429|5\d{2})/i.test(message) || /network error/i.test(message);
};

const emitMetric = (metricName: string, value = 1): Promise<void> => putMetric(METRIC_NAMESPACE, metricName, value);

const fetchHouseMembers = async (
  congress: string,
  sessionNumber: string,
  rollCallNumber: string,
): Promise<{ members: OfficialVoteMember[]; callBudgetUsed: number }> => {
  const members: OfficialVoteMember[] = [];
  const limit = 250;
  let offset = 0;
  let calls = 0;

  for (let page = 0; page < CONGRESS_API_MAX_HOUSE_VOTE_PAGES; page += 1) {
    if (calls >= CONGRESS_VOTE_MAX_CALLS_PER_BILL) break;
    if (page > 0 && CONGRESS_VOTE_CALL_DELAY_MS > 0) {
      await sleep(CONGRESS_VOTE_CALL_DELAY_MS);
    }

    const url = buildHouseVotesUrl(congress, sessionNumber, rollCallNumber, offset, limit);
    const payload = await fetchFromCongressAPI(url);
    calls += 1;

    const entries = extractMembersFromPayload(payload);
    for (const entry of entries) {
      const mapped = mapMemberVote(entry);
      if (mapped) members.push(mapped);
    }

    if (!hasMorePages(payload, entries.length, limit)) {
      break;
    }
    offset += limit;
  }

  return { members, callBudgetUsed: calls };
};

const fetchSenateVote = async (
  congress: string,
  actionDate: string | undefined,
  rollCallNumber: string,
  actionCode: string | undefined,
  resultText: string | undefined,
): Promise<{ vote: OfficialChamberVote; callBudgetUsed: number }> => {
  const session = deriveCongressSession(congress, actionDate);
  const url = buildSenateVoteXmlUrl(congress, session, rollCallNumber);
  const response = await fetchText(url, "application/xml, text/xml");
  return {
    vote: await buildSenateVoteFromXml(response.body, { actionDate, actionCode, resultText }),
    callBudgetUsed: 1,
  };
};

const isChamberVoteComplete = (vote: { memberDataAvailable?: boolean; members?: unknown[] } | undefined): boolean =>
  Boolean(vote?.memberDataAvailable && Array.isArray(vote.members) && vote.members.length > 0);

const ensureOfficialVotes = (rawBill: RawBill) => {
  const content = rawBill.content as Record<string, unknown>;
  if (content.officialVotes) return;

  const extracted = extractOfficialVotesFromActions(content);
  if (extracted) {
    extracted.completeness = computeCompleteness(extracted);
    content.officialVotes = extracted;
  }
};

const patchRawBillWithCompleteness = (rawBill: RawBill, members: OfficialVoteMember[]) => {
  const content = rawBill.content as Record<string, unknown>;
  const merged = mergeHouseMembersIntoOfficialVotes(rawBill, members);
  if (merged) {
    merged.completeness = computeCompleteness(merged);
    content.officialVotes = merged;
    return;
  }

  const extracted = extractOfficialVotesFromActions(content);
  if (extracted) {
    extracted.completeness = computeCompleteness(extracted);
    content.officialVotes = extracted;
  }
};

const patchRawBillWithSenateVote = (rawBill: RawBill, vote: OfficialChamberVote) => {
  const content = rawBill.content as Record<string, unknown>;
  const updated = upsertOfficialChamberVote(rawBill, "senate", vote);
  updated.completeness = computeCompleteness(updated);
  content.officialVotes = updated;
};

/**
 * What one enrichment fetched: the House members (an empty list finalizes the House chamber as
 * partial) and the Senate vote built from the roll-call XML.
 */
export interface FetchedEnrichment {
  house?: OfficialVoteMember[];
  senate?: OfficialChamberVote;
}

/**
 * Applies fetched member votes to a raw bill in place, the same way every time, so the result can be
 * re-applied to a fresher copy after a refused conditional write (REL-36): fills officialVotes from
 * the actions when missing, then the House members, then the Senate vote.
 */
export const applyEnrichment = (rawBill: RawBill, fetched: FetchedEnrichment): void => {
  ensureOfficialVotes(rawBill);
  if (fetched.house !== undefined) patchRawBillWithCompleteness(rawBill, fetched.house);
  if (fetched.senate) patchRawBillWithSenateVote(rawBill, fetched.senate);
};

type RollCallRefs = { house: unknown; senate: unknown };

const rollCallRefsOf = (rawBill: RawBill): RollCallRefs => ({
  house: extractHouseRollCallRef(rawBill),
  senate: extractSenateRollCallRef(rawBill),
});

const sameRollCallRefs = (a: RollCallRefs, b: RollCallRefs): boolean =>
  JSON.stringify(a.house ?? null) === JSON.stringify(b.house ?? null) &&
  JSON.stringify(a.senate ?? null) === JSON.stringify(b.senate ?? null);

/**
 * What to re-apply to a fresher copy of the same roll calls: a chamber this run got no members for
 * (a partial finalize after congress.gov failed) is left out when the fresh copy already has that
 * chamber's members, which another enrichment wrote meanwhile; applying it would wipe them.
 */
const reapplicableEnrichment = (fetched: FetchedEnrichment, fresh: RawBill): FetchedEnrichment => {
  const votes = (fresh.content as Record<string, unknown> | undefined)?.officialVotes as
    | { house?: { memberDataAvailable?: boolean; members?: unknown[] }; senate?: OfficialChamberVote }
    | undefined;
  const keepHouse = fetched.house !== undefined && (fetched.house.length > 0 || !isChamberVoteComplete(votes?.house));
  const keepSenate =
    fetched.senate !== undefined && (fetched.senate.members.length > 0 || !isChamberVoteComplete(votes?.senate));
  return {
    ...(keepHouse ? { house: fetched.house } : {}),
    ...(keepSenate ? { senate: fetched.senate } : {}),
  };
};

/**
 * Writes the enriched raw bill with IfMatch on the ETag it was read with (REL-36), so a newer fetch
 * is never overwritten with an older copy. On a 412 or 409 it re-reads the raw bill: when its House
 * and Senate roll-call refs are the ones enriched, the same enrichment is applied to the fresh copy
 * and written again (up to 3 attempts, then it throws), except a chamber without members that the
 * fresh copy already has members for ("already_complete" when nothing is left: nothing is written,
 * and the caller still sends the bill to billDiffer); otherwise the fetch moved on to another vote
 * ("superseded": nothing is written or sent; that fetch queued its own enrichment).
 */
const storeEnrichment = async (
  guid: string,
  enriched: RawBill,
  etag: string | undefined,
  fetched: FetchedEnrichment,
  refs: RollCallRefs,
  correlationId: string,
): Promise<"written" | "already_complete" | "superseded"> => {
  let doc = enriched;
  let ifMatch = etag;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rawBillDao.store(doc, { correlationId, ...(ifMatch ? { ifMatch } : {}) });
      return "written";
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      emitEmbeddedMetric(METRIC_NAMESPACE, "VoteEnrichmentWriteConflict", 1);
      if (attempt >= ENRICHMENT_WRITE_MAX_ATTEMPTS) {
        throw new Error(`Raw bill ${guid} changed during ${attempt} enrichment writes`, { cause: error });
      }
      const fresh = await rawBillDao.getRevisionByGuid(guid);
      if (!fresh.value || !sameRollCallRefs(rollCallRefsOf(fresh.value), refs)) {
        logger.warn("enrichment_superseded", { event: "enrichment_superseded", billGuid: guid, attempt });
        emitEmbeddedMetric(METRIC_NAMESPACE, "VoteEnrichmentSuperseded", 1);
        return "superseded";
      }
      const reapply = reapplicableEnrichment(fetched, fresh.value);
      if (reapply.house === undefined && reapply.senate === undefined) {
        logger.info("enrichment_already_complete", { event: "enrichment_already_complete", billGuid: guid, attempt });
        return "already_complete";
      }
      applyEnrichment(fresh.value, reapply);
      doc = fresh.value;
      ifMatch = fresh.etag;
    }
  }
};

const processRecord = async (record: SQSRecord): Promise<void> => {
  const payload = JSON.parse(record.body || "{}") as { guid?: string; attempt?: number };
  const guid = toTrimmedString(payload.guid);
  const attempt = Number.isFinite(payload.attempt) ? Number(payload.attempt) : 0;
  if (!guid) {
    // Acknowledged as before; now logged and counted (C1.8).
    reportUnprocessableMessage({
      site: "enrichOfficialVotes.missingGuid",
      reason: record.body ? "missing_guid" : "empty_body",
      messageId: record.messageId,
      body: record.body,
    });
    return;
  }
  const correlationId = correlationIdFromRecord(record) ?? mintCorrelationId(guid);
  logger.appendKeys({ guid, correlationId });

  const revision = await rawBillDao.getRevisionByGuid(guid);
  const rawBill = revision.value;
  if (!rawBill) {
    // No raw bill (or an empty object) under this guid: acknowledged as before; now logged and counted (C1.8).
    reportUnprocessableMessage({
      site: "enrichOfficialVotes.rawBillMissing",
      reason: "raw_bill_not_found",
      messageId: record.messageId,
      body: record.body,
    });
    return;
  }

  const content = rawBill.content as Record<string, unknown>;
  const hadOfficialVotesBefore = Boolean(content.officialVotes);
  ensureOfficialVotes(rawBill);
  const existingOfficial = content.officialVotes as
    | {
        house?: { memberDataAvailable?: boolean; members?: unknown[] };
        senate?: { memberDataAvailable?: boolean; members?: unknown[] };
      }
    | undefined;

  const refs = rollCallRefsOf(rawBill);
  const houseRef = extractHouseRollCallRef(rawBill);
  const senateRef = extractSenateRollCallRef(rawBill);
  const houseComplete = isChamberVoteComplete(existingOfficial?.house);
  const senateComplete = isChamberVoteComplete(existingOfficial?.senate);
  const needsHouse = Boolean(houseRef && !houseComplete);
  const needsSenate = Boolean(senateRef && !senateComplete);
  const incompleteWithoutRef = Boolean(
    (existingOfficial?.house && !houseComplete && !houseRef) ||
    (existingOfficial?.senate && !senateComplete && !senateRef),
  );

  if (!needsHouse && !needsSenate && !incompleteWithoutRef) {
    await enqueueGuids(QUEUE_URL, [guid], correlationId);
    return;
  }

  const fetched: FetchedEnrichment = {};
  let callBudgetUsed = 0;
  let attachedHouseMembers = 0;
  let attachedSenateMembers = 0;
  let mutated = !hadOfficialVotesBefore && Boolean(content.officialVotes);
  let finalizedPartial = incompleteWithoutRef;
  let pendingRetry = false;
  let errorMessage: string | null = null;

  if (needsHouse && houseRef) {
    try {
      const { members, callBudgetUsed: used } = await fetchHouseMembers(
        houseRef.congress,
        houseRef.sessionNumber ?? "1",
        houseRef.rollCallNumber,
      );
      callBudgetUsed += used;
      attachedHouseMembers = members.length;
      fetched.house = members;
      mutated = true;
    } catch (error) {
      if (error instanceof EnqueueError) {
        throw error;
      }
      if (isRetryableCongressError(error) && attempt < VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS) {
        pendingRetry = true;
        errorMessage = error instanceof Error ? error.message : String(error);
      } else {
        fetched.house = [];
        mutated = true;
        finalizedPartial = true;
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (needsSenate && senateRef) {
    try {
      const { vote, callBudgetUsed: used } = await fetchSenateVote(
        senateRef.congress,
        senateRef.actionDate,
        senateRef.rollCallNumber,
        senateRef.actionCode,
        senateRef.resultText,
      );
      callBudgetUsed += used;
      attachedSenateMembers = vote.members.length;
      fetched.senate = vote;
      mutated = true;
    } catch (error) {
      if (error instanceof EnqueueError) {
        throw error;
      }
      if (isRetryableCongressError(error) && attempt < VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS) {
        pendingRetry = true;
        errorMessage = error instanceof Error ? error.message : String(error);
      } else {
        finalizedPartial = true;
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
  }

  applyEnrichment(rawBill, fetched);

  let superseded = false;
  if (mutated) {
    const written = await storeEnrichment(guid, rawBill, revision.etag, fetched, refs, correlationId);
    if (written === "superseded") superseded = true;
    else await enqueueGuids(QUEUE_URL, [guid], correlationId);
  }

  await emitMetric("CongressApiCallsVoteEnrich", callBudgetUsed);
  if (superseded) return;
  if (attachedHouseMembers > 0) {
    await emitMetric("HouseMemberVotesAttached", attachedHouseMembers);
  }
  if (attachedSenateMembers > 0) {
    await emitMetric("SenateMemberVotesAttached", attachedSenateMembers);
  }

  const updatedVotes = (rawBill.content as Record<string, unknown>).officialVotes as
    | { completeness?: string }
    | undefined;

  if (pendingRetry) {
    await requeueDeferred(guid, attempt + 1, correlationId);
    await emitMetric("EnrichmentDeferred", 1);
    logger.warn("vote enrichment deferred", {
      billGuid: guid,
      retryCount: attempt + 1,
      maxDeferredAttempts: VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS,
      callBudgetUsed,
      error: errorMessage,
    });
    return;
  }

  if (finalizedPartial) {
    if (!mutated && hadOfficialVotesBefore) {
      await enqueueGuids(QUEUE_URL, [guid], correlationId);
    }
    await emitMetric("EnrichmentPartialFinalized", 1);
    logger.warn("vote enrichment finalized as partial", {
      billGuid: guid,
      retryCount: attempt,
      completeness: updatedVotes?.completeness ?? "none",
      callBudgetUsed,
      error: errorMessage,
    });
    return;
  }

  logger.info("vote enrichment completed", {
    billGuid: guid,
    callBudgetUsed,
    retryCount: attempt,
    houseMembersAttached: attachedHouseMembers,
    senateMembersAttached: attachedSenateMembers,
    completeness: updatedVotes?.completeness ?? "none",
  });
};

export const handler = async (event: SQSEvent, context?: LambdaContextLike): Promise<SQSBatchResponse> => {
  logger.resetContext(context);
  if (!BUCKET_NAME) throw new Error("Missing env var BUCKET_NAME");
  if (!SECRET_NAME) throw new Error("Missing env var SECRET_NAME");
  if (!QUEUE_URL) throw new Error("Missing env var QUEUE_URL");
  if (!Number.isFinite(CONGRESS_API_REQUEST_TIMEOUT_MS) || CONGRESS_API_REQUEST_TIMEOUT_MS <= 0) {
    throw new Error("Invalid env var CONGRESS_API_REQUEST_TIMEOUT_MS");
  }

  // Read the key up front so a missing or unreadable secret fails the whole batch before any work.
  // Requests read it again through the shared 15-minute cache, so a rotated key is picked up.
  await getCongressApiKey();
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records ?? []) {
    await logger.withKeys({ sqsMessageId: record.messageId }, async () => {
      try {
        await processRecord(record);
      } catch (error) {
        logger.error("enrichOfficialVotes record failure", { messageId: record.messageId, error });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    });
  }

  return { batchItemFailures };
};

export default { handler };
