import { type AttributeValue, DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ACTIVE_PRIORITY_STATUS, INACTIVE_PRIORITY_STATUS, type BillPriorityRecord } from "../../models/billPriority";
import type { BillManifestEntry } from "../../models/bill";
import { activeCompanionPairs, BillCompanionDao } from "../../adapters/billCompanionDao";
import { BillPriorityDao } from "../../adapters/billPriorityDao";
import { isNoSuchKeyError } from "../../adapters/billStorage";
import { buildRawBillRootGuidKey } from "../../adapters/rawBillKeys";
import { mapWithConcurrency } from "../../shared/concurrency";
import {
  BEDROCK_METRIC_NAMESPACE,
  createBedrockClient,
  invokeMessages,
  parseEffort,
  requestProfileForModel,
} from "../../shared/bedrockMessages";
import { companionIndex, plainBillGuid, type CompanionIndex } from "../../shared/billCompanions";
import { buildPrioritySortKey, isPriorityRecordActive, parseIsoDate } from "../../shared/billPriority";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric, emitEmbeddedMetrics } from "../../shared/metrics";
import { capTitle, titlesFromRawBill, type BillTitles } from "./billTitles";
import {
  candidateExclusion,
  candidateTypeOf,
  matchHeadlines,
  newestCongressByNumber,
  normalizeText,
  type CandidateExclusion,
} from "./headlineMatching";
import {
  buildPriorityPayload,
  buildPriorityRequestBody,
  parseBedrockResponse,
  sanitizePriorityReason,
  type BedrockPriorityDecision,
  type PriorityBillCandidateInput,
  type PriorityHeadlineInput,
} from "./prompts";

const MANIFEST_TABLE_NAME = process.env.MANIFEST_TABLE_NAME!;
const MANIFEST_PRIMARY_KEY = process.env.MANIFEST_PRIMARY_KEY ?? "pk";
const MANIFEST_SORT_KEY = process.env.MANIFEST_SORT_KEY ?? "sk";
const MANIFEST_PK_VALUE = process.env.MANIFEST_PK_VALUE ?? "BILL";

const PRIORITY_TABLE_NAME = process.env.PRIORITY_TABLE_NAME!;
const PRIORITY_TABLE_PARTITION_KEY = process.env.PRIORITY_TABLE_PARTITION_KEY ?? "guid";
const PRIORITY_ACTIVE_INDEX_NAME = process.env.PRIORITY_ACTIVE_INDEX_NAME!;
const PRIORITY_STATUS_ATTRIBUTE = process.env.PRIORITY_STATUS_ATTRIBUTE ?? "status";
const PRIORITY_SORT_KEY_ATTRIBUTE = process.env.PRIORITY_SORT_KEY_ATTRIBUTE ?? "prioritySortKey";
const PRIORITY_ACTIVE_STATUS_VALUE = process.env.PRIORITY_ACTIVE_STATUS_VALUE ?? ACTIVE_PRIORITY_STATUS;

const MODEL_ID = process.env.MODEL_ID!;
// LLM-11: a model this code has no request shape for fails at cold start.
const REQUEST_PROFILE = requestProfileForModel(MODEL_ID);
// Haiku 5.5 only; ranking titles against headlines needs little thinking.
const BEDROCK_EFFORT = parseEffort(process.env.BEDROCK_EFFORT, "low");
const NEWS_FEED_URLS = (process.env.NEWS_FEED_URLS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const BILL_LOOKBACK_DAYS = Number(process.env.BILL_LOOKBACK_DAYS ?? "7");
const MAX_CANDIDATE_BILLS = Number(process.env.MAX_CANDIDATE_BILLS ?? "50");
const MAX_HEADLINES = Number(process.env.MAX_HEADLINES ?? "30");
const MAX_PRIORITY_RESULTS = Number(process.env.MAX_PRIORITY_RESULTS ?? "8");
// Haiku 5.5's thinking counts toward it.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? "4096");
const HEADLINE_MAX_AGE_HOURS = Number(process.env.HEADLINE_MAX_AGE_HOURS ?? "48");
const DEFAULT_PRIORITY_DURATION_HOURS = Number(process.env.DEFAULT_PRIORITY_DURATION_HOURS ?? "12");
const PRIORITY_MIN_SCORE = Number(process.env.PRIORITY_MIN_SCORE ?? "75");
const PRIORITY_MIN_CONFIDENCE = Number(process.env.PRIORITY_MIN_CONFIDENCE ?? "0.55");
const BEDROCK_MAX_RETRIES = Number(process.env.BEDROCK_MAX_RETRIES ?? "4");
const BEDROCK_BASE_DELAY_MS = Number(process.env.BEDROCK_BASE_DELAY_MS ?? "1000");
const BEDROCK_MAX_DELAY_MS = Number(process.env.BEDROCK_MAX_DELAY_MS ?? "15000");
// One attempt's deadline; an attempt also ends 5 s before the invocation would.
const BEDROCK_CALL_TIMEOUT_MS = Number(process.env.BEDROCK_CALL_TIMEOUT_MS ?? "75000");
// No Bedrock call or retry starts with less than this left in the invocation.
const BEDROCK_MIN_REMAINING_MS = Number(process.env.BEDROCK_MIN_REMAINING_MS ?? "20000");
// REL-51: headline text sent to the model is capped, so a request's size (and cost) has a ceiling.
const HEADLINE_TITLE_MAX_CHARS = 300;

// REL-51: the bill store whose raw bills hold the short and official titles; unset, no titles are read and
// headlines are matched against Billboard's own headline only (as before REL-51).
const BILL_STORE_BUCKET_NAME = process.env.BILL_STORE_BUCKET_NAME?.trim() ?? "";
// Raw bills read per run, most likely first (title lookups); the rest are matched by Billboard's headline only.
const MAX_TITLE_LOOKUPS = Number(process.env.MAX_TITLE_LOOKUPS ?? "200");
const TITLE_LOOKUP_CONCURRENCY = Number(process.env.TITLE_LOOKUP_CONCURRENCY ?? "6");
// No raw bill read starts after this long, and none runs longer than TITLE_READ_TIMEOUT_MS, so the lookups leave the
// Bedrock call its time.
const TITLE_LOOKUP_BUDGET_MS = Number(process.env.TITLE_LOOKUP_BUDGET_MS ?? "15000");
const TITLE_READ_TIMEOUT_MS = Number(process.env.TITLE_READ_TIMEOUT_MS ?? "5000");
// A raw bill holds the bill's full text (billXML) and member votes, and only its titles are read: reading one costs
// about three times its size in memory while it is parsed (the bytes, the string, the parsed copy). Most are under
// 200 KB; a defense authorization or an omnibus runs to megabytes. A body over TITLE_LARGE_BODY_BYTES is read one at a
// time, so six large ones never sit in the 512 MB function at once; one over TITLE_MAX_BODY_BYTES is not read at all
// (titleLookups.tooLarge) and keeps Billboard's headline only.
const TITLE_LARGE_BODY_BYTES = Number(process.env.TITLE_LARGE_BODY_BYTES ?? String(2 * 1024 * 1024));
const TITLE_MAX_BODY_BYTES = Number(process.env.TITLE_MAX_BODY_BYTES ?? String(40 * 1024 * 1024));

const ddb = new DynamoDBClient({});
const s3 = BILL_STORE_BUCKET_NAME ? new S3Client({}) : null;
const bedrock = createBedrockClient();
const priorityDao = new BillPriorityDao(ddb, {
  tableName: PRIORITY_TABLE_NAME,
  partitionKey: PRIORITY_TABLE_PARTITION_KEY,
  activeIndexName: PRIORITY_ACTIVE_INDEX_NAME,
  statusAttribute: PRIORITY_STATUS_ATTRIBUTE,
  prioritySortKeyAttribute: PRIORITY_SORT_KEY_ATTRIBUTE,
  activeStatusValue: PRIORITY_ACTIVE_STATUS_VALUE as BillPriorityRecord["status"],
});

// APPF-23: the companion groups PublishBillsManifest last published (none while they are turned off).
const COMPANION_METRIC_NAMESPACE = "BillBoard/BillsManifest";
const companionDao = MANIFEST_TABLE_NAME?.trim() ? new BillCompanionDao(ddb) : null;

type CandidateBill = PriorityBillCandidateInput & {
  heuristicScore: number;
  /** Of explicitHeadlineMatches, the headlines that name the bill by a short title only (for the logs). */
  shortTitleMatches?: number;
};

type ParsedHeadline = PriorityHeadlineInput & {
  normalizedTitle: string;
  sourceKey: string;
};

type InvocationContext = LambdaContextLike & { getRemainingTimeInMillis?: () => number };

/** Why a run had no answer it could use; logged as priority_no_answer. */
type NoAnswerReason = "refusal" | "max_tokens" | "incomplete" | "empty" | "unparseable";

type ModelAnswer =
  | { answered: true; decisions: BedrockPriorityDecision[] }
  | { answered: false; reason: NoAnswerReason };

const toStringList = (value: AttributeValue | undefined): string[] => {
  const list = value?.L;
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((entry: AttributeValue) => (typeof entry?.S === "string" ? entry.S : ""))
    .filter((entry: string) => entry.length > 0);
};

const toManifestEntry = (item: Record<string, AttributeValue> | undefined): BillManifestEntry | null => {
  if (!item) {
    return null;
  }

  const guid = item.guid?.S ?? "";
  const billType = item.billType?.S ?? "";
  if (!guid || !billType) {
    return null;
  }

  const billStatus = item.billStatus?.S ?? undefined;
  const validStatuses = new Set(["New", "Updated", "Passed", "Failed", "Finalized"]);

  return {
    guid,
    billType,
    congress: item.congress?.S ?? "",
    billNumber: item.billNumber?.S ?? "",
    updatedAt: item.updatedAt?.S ?? "",
    title: item.title?.S ?? "",
    subCategories: toStringList(item.subCategories),
    lifeAreas: toStringList(item.lifeAreas),
    sponsors: toStringList(item.sponsors),
    cosponsors: toStringList(item.cosponsors),
    ...(billStatus && validStatuses.has(billStatus)
      ? { billStatus: billStatus as BillManifestEntry["billStatus"] }
      : {}),
  };
};

const xmlEntityMap: Record<string, string> = {
  "&amp;": "&",
  "&apos;": "'",
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
};

const decodeXml = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(amp|apos|gt|lt|quot);/g, (match) => xmlEntityMap[match] ?? match)
    .replace(/\s+/g, " ")
    .trim();

const sourceKey = (value: string): string => normalizeText(value).replace(/\s+/g, "_");

const headlineKey = (headline: ParsedHeadline): string => `${headline.normalizedTitle}||${headline.sourceKey}`;

const heuristicScoreOf = (candidate: PriorityBillCandidateInput): number => {
  const updatedAt = parseIsoDate(candidate.updatedAt);
  const ageHours = updatedAt
    ? Math.max(0, (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60))
    : 24 * BILL_LOOKBACK_DAYS;
  const recencyBoost = Math.max(0, 72 - ageHours);
  return (
    (candidate.alreadyPriority ? 400 : 0) +
    (candidate.explicitHeadlineMatches ?? 0) * 180 +
    (candidate.headlineOverlapCount ?? 0) * 35 +
    recencyBoost
  );
};

/** `newestCongress` is the pool's newestCongressByNumber (REL-46). */
const scoreCandidate = (
  candidate: PriorityBillCandidateInput,
  headlines: ParsedHeadline[],
  newestCongress: ReadonlyMap<string, number>,
): CandidateBill => {
  const { explicitHeadlineMatches, shortTitleMatches, headlineOverlapCount } = matchHeadlines(
    candidate,
    headlines,
    newestCongress,
  );
  const scored = { ...candidate, explicitHeadlineMatches, headlineOverlapCount };
  return { ...scored, shortTitleMatches, heuristicScore: heuristicScoreOf(scored) };
};

// ─── Companion groups (APPF-23) ───────────────────────────────────────────────

/** The published companion groups; empty when they are off, not configured or cannot be read. */
const loadCompanionIndex = async (): Promise<CompanionIndex> => {
  if (!companionDao) return new Map();
  try {
    return companionIndex(activeCompanionPairs(await companionDao.getCurrentGroups()));
  } catch (error) {
    logger.warn("Priority resolver could not read the companion groups; ranking every bill on its own", { error });
    emitEmbeddedMetric(COMPANION_METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return new Map();
  }
};

/**
 * The guid of the group's primary for a grouped bill, else the plain guid (a suffixed guid counts as its plain guid;
 * a guid naming no bill stays as it is).
 */
const companionGroupKey = (guid: string, index: CompanionIndex): string => {
  const plain = plainBillGuid(guid);
  return (plain ? (index.get(plain)?.primaryGuid ?? plain) : undefined) ?? guid;
};

const isNewerCompanionCandidate = (candidate: CandidateBill, than: CandidateBill, primaryGuid: string): boolean => {
  const candidateTime = parseIsoDate(candidate.updatedAt)?.getTime() ?? 0;
  const thanTime = parseIsoDate(than.updatedAt)?.getTime() ?? 0;
  if (candidateTime !== thanTime) return candidateTime > thanTime;
  return plainBillGuid(candidate.guid) === primaryGuid && plainBillGuid(than.guid) !== primaryGuid;
};

/**
 * One candidate per companion group, so a pair never takes two of the model's slots. The member with
 * the newest updatedAt stands for the group (a tie goes to the primary) and carries the group's
 * strongest signals: already a priority if any member is, and the most headline matches of any
 * member (a headline may name either number). Ungrouped candidates are unchanged.
 */
const collapseCompanionCandidates = (candidates: CandidateBill[], index: CompanionIndex): CandidateBill[] => {
  if (index.size === 0) return candidates;

  const byGroup = new Map<string, CandidateBill[]>();
  for (const candidate of candidates) {
    const key = companionGroupKey(candidate.guid, index);
    const members = byGroup.get(key);
    if (members) members.push(candidate);
    else byGroup.set(key, [candidate]);
  }

  return Array.from(byGroup.entries()).map(([primaryGuid, members]) => {
    if (members.length === 1) return members[0];
    const kept = members.reduce((best, member) =>
      isNewerCompanionCandidate(member, best, primaryGuid) ? member : best,
    );
    const merged: CandidateBill = {
      ...kept,
      alreadyPriority: members.some((member) => member.alreadyPriority === true),
      explicitHeadlineMatches: Math.max(...members.map((member) => member.explicitHeadlineMatches ?? 0)),
      headlineOverlapCount: Math.max(...members.map((member) => member.headlineOverlapCount ?? 0)),
      shortTitleMatches: Math.max(...members.map((member) => member.shortTitleMatches ?? 0)),
    };
    logger.info("Collapsed companion bills into one priority candidate", {
      kept: kept.guid,
      dropped: members.filter((member) => member !== kept).map((member) => member.guid),
    });
    return { ...merged, heuristicScore: heuristicScoreOf(merged) };
  });
};

const toCandidateFromManifest = (entry: BillManifestEntry): PriorityBillCandidateInput | null => {
  if (!entry.guid || !entry.title || !candidateTypeOf(entry.billType)) {
    return null;
  }

  return {
    // A bill is ranked and stored under its plain guid: a suffixed manifest row (REL-41) is the same bill.
    guid: plainBillGuid(entry.guid) ?? entry.guid,
    congress: entry.congress,
    billType: entry.billType,
    billNumber: entry.billNumber,
    title: entry.title,
    billStatus: entry.billStatus,
    updatedAt: entry.updatedAt,
    alreadyPriority: entry.isPriority === true,
  };
};

const toCandidateFromPriorityRecord = (record: BillPriorityRecord): PriorityBillCandidateInput | null => {
  if (!record.guid || !record.title || !record.billType || !candidateTypeOf(record.billType)) {
    return null;
  }

  return {
    guid: plainBillGuid(record.guid) ?? record.guid,
    congress: record.congress,
    billType: record.billType,
    billNumber: record.billNumber,
    title: record.title,
    billStatus: record.billStatus,
    updatedAt: record.updatedAt,
    alreadyPriority: record.isPriority === true,
  };
};

const fetchFeedText = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent": "BillBoardPriorityResolver/1.0",
      accept: "application/rss+xml, application/atom+xml, text/xml, application/xml",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Feed request failed (${response.status}) for ${url}`);
  }

  return await response.text();
};

const parseFeedItems = (xml: string): ParsedHeadline[] => {
  const headlines: ParsedHeadline[] = [];

  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const block of itemBlocks) {
    const title = capTitle(decodeXml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ""), HEADLINE_TITLE_MAX_CHARS);
    const link = decodeXml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? "");
    const source =
      decodeXml(block.match(/<source(?:\s+[^>]*)?>([\s\S]*?)<\/source>/i)?.[1] ?? "") ||
      decodeXml(block.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/i)?.[1] ?? "");
    const publishedAt =
      decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] ?? "") ||
      decodeXml(block.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1] ?? "");

    if (!title || !link) {
      continue;
    }

    const normalizedTitle = normalizeText(title);
    if (!normalizedTitle) {
      continue;
    }

    headlines.push({
      title,
      source: source || "Unknown",
      publishedAt: publishedAt || undefined,
      normalizedTitle,
      sourceKey: sourceKey(source || "Unknown"),
    });
  }

  const entryBlocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of entryBlocks) {
    const title = capTitle(
      decodeXml(block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
      HEADLINE_TITLE_MAX_CHARS,
    );
    const link =
      decodeXml(block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i)?.[1] ?? "") ||
      decodeXml(block.match(/<id>([\s\S]*?)<\/id>/i)?.[1] ?? "");
    const source =
      decodeXml(block.match(/<source[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>[\s\S]*?<\/source>/i)?.[1] ?? "") ||
      decodeXml(block.match(/<author[^>]*>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i)?.[1] ?? "");
    const publishedAt =
      decodeXml(block.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1] ?? "") ||
      decodeXml(block.match(/<published>([\s\S]*?)<\/published>/i)?.[1] ?? "");

    if (!title || !link) {
      continue;
    }

    const normalizedTitle = normalizeText(title);
    if (!normalizedTitle) {
      continue;
    }

    headlines.push({
      title,
      source: source || "Unknown",
      publishedAt: publishedAt || undefined,
      normalizedTitle,
      sourceKey: sourceKey(source || "Unknown"),
    });
  }

  return headlines;
};

const loadHeadlines = async (): Promise<ParsedHeadline[]> => {
  if (NEWS_FEED_URLS.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(NEWS_FEED_URLS.map(async (url) => parseFeedItems(await fetchFeedText(url))));

  const deduped = new Map<string, ParsedHeadline>();
  const maxAgeMs = HEADLINE_MAX_AGE_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  for (const result of results) {
    if (result.status !== "fulfilled") {
      console.warn("Failed to load priority news feed", result.reason);
      continue;
    }

    for (const headline of result.value) {
      const publishedAt = parseIsoDate(headline.publishedAt);
      if (publishedAt && now - publishedAt.getTime() > maxAgeMs) {
        continue;
      }

      const key = headlineKey(headline);
      if (!deduped.has(key)) {
        deduped.set(key, headline);
      }
    }
  }

  return Array.from(deduped.values())
    .sort((left, right) => {
      const leftDate = parseIsoDate(left.publishedAt)?.getTime() ?? 0;
      const rightDate = parseIsoDate(right.publishedAt)?.getTime() ?? 0;
      return rightDate - leftDate;
    })
    .slice(0, MAX_HEADLINES);
};

const loadRecentBills = async (): Promise<BillManifestEntry[]> => {
  const bills: BillManifestEntry[] = [];
  const updatedAfterDate = new Date(Date.now() - BILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: MANIFEST_TABLE_NAME,
        KeyConditionExpression: "#pk = :pk AND #sk > :updatedAfter",
        ExpressionAttributeNames: {
          "#pk": MANIFEST_PRIMARY_KEY,
          "#sk": MANIFEST_SORT_KEY,
        },
        ExpressionAttributeValues: {
          ":pk": { S: MANIFEST_PK_VALUE },
          ":updatedAfter": { S: updatedAfterDate },
        },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const entry = toManifestEntry(item);
      if (entry && candidateTypeOf(entry.billType)) {
        bills.push(entry);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return bills;
};

/**
 * The bills the run may rank: the window's manifest rows and the records still active, one per plain guid (a record
 * whose bill is in the window marks that bill already a priority). Only candidate types (headlineMatching.ts) get
 * here; whether an H.Res. impeaches, censures or expels, and whether a resolution is ceremonial by its official
 * title, is decided once the titles are read (excludeCandidates).
 */
const buildCandidatePool = (
  recentBills: BillManifestEntry[],
  activePriorityRecords: BillPriorityRecord[],
): PriorityBillCandidateInput[] => {
  const byGuid = new Map<string, PriorityBillCandidateInput>();

  for (const entry of recentBills) {
    const candidate = toCandidateFromManifest(entry);
    if (candidate) {
      byGuid.set(candidate.guid, candidate);
    }
  }

  for (const record of activePriorityRecords) {
    const candidate = toCandidateFromPriorityRecord(record);
    if (!candidate) {
      continue;
    }

    const existing = byGuid.get(candidate.guid);
    if (existing) {
      byGuid.set(candidate.guid, {
        ...existing,
        alreadyPriority: true,
        congress: existing.congress ?? candidate.congress,
        billType: existing.billType || candidate.billType,
        billNumber: existing.billNumber ?? candidate.billNumber,
        title: existing.title || candidate.title,
        billStatus: existing.billStatus ?? candidate.billStatus,
        updatedAt: existing.updatedAt ?? candidate.updatedAt,
      });
    } else {
      byGuid.set(candidate.guid, candidate);
    }
  }

  return Array.from(byGuid.values());
};

const byHeuristicThenNewest = (left: CandidateBill, right: CandidateBill): number => {
  if (left.heuristicScore !== right.heuristicScore) {
    return right.heuristicScore - left.heuristicScore;
  }

  const leftDate = parseIsoDate(left.updatedAt)?.getTime() ?? 0;
  const rightDate = parseIsoDate(right.updatedAt)?.getTime() ?? 0;
  return rightDate - leftDate;
};

// ─── Titles (REL-51) ─────────────────────────────────────────────────────────

/** What the title lookups of one run did, for priority_candidates. */
type TitleLookupStats = {
  /** Raw bills read with at least one title. */
  found: number;
  /** Raw bills read without a title, or not found. */
  missing: number;
  /** Reads that failed or timed out (the bill is matched by Billboard's headline only). */
  failed: number;
  /** Bills not read: past MAX_TITLE_LOOKUPS or TITLE_LOOKUP_BUDGET_MS, or no bill store configured. */
  skipped: number;
  /** Raw bills over TITLE_MAX_BODY_BYTES, not read (an INFO line names the guid and size). */
  tooLarge: number;
};

/** A lock that lets one caller through at a time: `await acquire()` resolves to the function that releases it. */
const oneAtATime = (): (() => Promise<() => void>) => {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = tail.then(() => release);
    tail = tail.then(() => released);
    return acquired;
  };
};

/** What reading one raw bill gave. */
type RawBillRead =
  | { outcome: "read"; titles: BillTitles | null }
  | { outcome: "tooLarge"; bytes: number }
  | { outcome: "skipped" };

/** Lets a stream go without reading it; an unread body would hold its connection. */
const discardBody = (body: unknown): void => {
  (body as { destroy?: () => void } | undefined)?.destroy?.();
};

/**
 * One raw bill's titles (null when the raw bill does not exist). Throws on a failed read, or one that takes longer
 * than TITLE_READ_TIMEOUT_MS. A body over TITLE_LARGE_BODY_BYTES waits for `largeBodies` (its clock stops while it
 * waits) and is not read when the lookups' deadline has passed by then; one over TITLE_MAX_BODY_BYTES is not read.
 */
const readRawBillTitles = async (
  guid: string,
  largeBodies: () => Promise<() => void>,
  deadline: number,
): Promise<RawBillRead> => {
  const controller = new AbortController();
  const startClock = () => setTimeout(() => controller.abort(), TITLE_READ_TIMEOUT_MS);
  let clock = startClock();
  let release: (() => void) | undefined;
  try {
    const response = await s3!.send(
      new GetObjectCommand({ Bucket: BILL_STORE_BUCKET_NAME, Key: buildRawBillRootGuidKey(guid) }),
      { abortSignal: controller.signal },
    );
    const bytes = response.ContentLength ?? 0;
    if (bytes > TITLE_MAX_BODY_BYTES) {
      discardBody(response.Body);
      return { outcome: "tooLarge", bytes };
    }
    if (bytes > TITLE_LARGE_BODY_BYTES) {
      clearTimeout(clock);
      release = await largeBodies();
      if (Date.now() >= deadline) {
        discardBody(response.Body);
        return { outcome: "skipped" };
      }
      clock = startClock();
    }
    const body = await response.Body?.transformToString();
    return { outcome: "read", titles: body ? titlesFromRawBill(JSON.parse(body)) : null };
  } catch (error) {
    if (isNoSuchKeyError(error)) return { outcome: "read", titles: null };
    throw error;
  } finally {
    clearTimeout(clock);
    release?.();
  }
};

/**
 * Reads the short and official titles of the pool's bills from their raw bills, most likely first (the order of the
 * heuristic without titles: active records, bills named by number, overlaps, then the newest), at most
 * MAX_TITLE_LOOKUPS of them, TITLE_LOOKUP_CONCURRENCY at a time (a large one alone), starting none after
 * TITLE_LOOKUP_BUDGET_MS. A bill whose raw bill cannot be read keeps Billboard's headline only: a lookup never fails
 * the run.
 */
const lookUpTitles = async (
  pool: PriorityBillCandidateInput[],
  headlines: ParsedHeadline[],
  newestCongress: ReadonlyMap<string, number>,
): Promise<{ titlesByGuid: Map<string, BillTitles>; stats: TitleLookupStats }> => {
  const titlesByGuid = new Map<string, BillTitles>();
  const stats: TitleLookupStats = { found: 0, missing: 0, failed: 0, skipped: 0, tooLarge: 0 };
  if (!s3) {
    stats.skipped = pool.length;
    return { titlesByGuid, stats };
  }

  const ordered = pool
    .map((candidate) => scoreCandidate(candidate, headlines, newestCongress))
    .sort(byHeuristicThenNewest);
  const toRead = ordered.slice(0, Math.max(0, MAX_TITLE_LOOKUPS));
  stats.skipped = ordered.length - toRead.length;
  const deadline = Date.now() + TITLE_LOOKUP_BUDGET_MS;
  const largeBodies = oneAtATime();

  await mapWithConcurrency(toRead, Math.max(1, TITLE_LOOKUP_CONCURRENCY), async (candidate) => {
    if (Date.now() >= deadline) {
      stats.skipped += 1;
      return;
    }
    try {
      const read = await readRawBillTitles(candidate.guid, largeBodies, deadline);
      if (read.outcome === "skipped") {
        stats.skipped += 1;
      } else if (read.outcome === "tooLarge") {
        stats.tooLarge += 1;
        logger.info("Priority resolver did not read a raw bill too large for it; matching it by its headline only", {
          guid: candidate.guid,
          bytes: read.bytes,
        });
      } else if (read.titles && (read.titles.shortTitles.length > 0 || read.titles.officialTitle)) {
        titlesByGuid.set(candidate.guid, read.titles);
        stats.found += 1;
      } else {
        stats.missing += 1;
      }
    } catch (error) {
      stats.failed += 1;
      logger.warn("Priority resolver could not read a raw bill's titles; matching it by its headline only", {
        guid: candidate.guid,
        error,
      });
    }
  });

  return { titlesByGuid, stats };
};

/**
 * The pool with each bill's titles, less the bills that are not candidates (headlineMatching.ts candidateExclusion):
 * a ceremonial resolution, an H.Res. that does not impeach, censure or expel, or an H.Res. whose official title was
 * not read. Counts what it left out by reason.
 */
const excludeCandidates = (
  pool: PriorityBillCandidateInput[],
  titlesByGuid: Map<string, BillTitles>,
): { eligible: PriorityBillCandidateInput[]; excluded: Record<CandidateExclusion, number> } => {
  const excluded: Record<CandidateExclusion, number> = { type: 0, ceremonial: 0, resolution: 0, noOfficialTitle: 0 };
  const eligible: PriorityBillCandidateInput[] = [];
  for (const candidate of pool) {
    const titles = titlesByGuid.get(candidate.guid);
    const withTitles: PriorityBillCandidateInput = titles
      ? {
          ...candidate,
          ...(titles.shortTitles.length > 0 ? { shortTitles: titles.shortTitles } : {}),
          ...(titles.officialTitle ? { officialTitle: titles.officialTitle } : {}),
        }
      : candidate;
    const exclusion = candidateExclusion(withTitles);
    if (exclusion) excluded[exclusion] += 1;
    else eligible.push(withTitles);
  }
  return { eligible, excluded };
};

/**
 * At most MAX_CANDIDATE_BILLS candidates for the model, one per companion group: every bill already a priority or
 * named by a headline (by number or short title), then the best of the rest by the heuristic, then the newest.
 */
const selectCandidates = (
  eligible: PriorityBillCandidateInput[],
  headlines: ParsedHeadline[],
  newestCongress: ReadonlyMap<string, number>,
  companions: CompanionIndex = new Map(),
): CandidateBill[] => {
  const scored = collapseCompanionCandidates(
    eligible.map((candidate) => scoreCandidate(candidate, headlines, newestCongress)),
    companions,
  ).sort(byHeuristicThenNewest);

  const guaranteed = scored.filter(
    (candidate) => candidate.alreadyPriority === true || (candidate.explicitHeadlineMatches ?? 0) > 0,
  );
  const guaranteedIds = new Set(guaranteed.map((candidate) => candidate.guid));

  const selected: CandidateBill[] = [...guaranteed];
  for (const candidate of scored) {
    if (selected.length >= MAX_CANDIDATE_BILLS) {
      break;
    }
    if (guaranteedIds.has(candidate.guid)) {
      continue;
    }
    selected.push(candidate);
  }

  return selected.slice(0, MAX_CANDIDATE_BILLS);
};

/**
 * One line per run that has headlines (INFO, before the model is asked): how the candidates were found. Numbers only;
 * the titles the model was shown are in priority_request.
 */
const logCandidates = (fields: {
  windowBills: number;
  pool: number;
  titleLookups: TitleLookupStats;
  excluded: Record<CandidateExclusion, number>;
  candidates: CandidateBill[];
}): void => {
  const { candidates, ...rest } = fields;
  logger.info("priority_candidates", {
    event: "priority_candidates",
    ...rest,
    candidatesSent: candidates.length,
    // By type, so joint resolutions and impeachment, censure or expulsion resolutions show up.
    candidateTypes: candidates.reduce<Record<string, number>>((counts, candidate) => {
      const type = candidateTypeOf(candidate.billType) ?? "other";
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {}),
    withShortTitle: candidates.filter((candidate) => (candidate.shortTitles?.length ?? 0) > 0).length,
    withOfficialTitle: candidates.filter((candidate) => Boolean(candidate.officialTitle)).length,
    namedByNumber: candidates.filter(
      (candidate) => (candidate.explicitHeadlineMatches ?? 0) > (candidate.shortTitleMatches ?? 0),
    ).length,
    namedByShortTitle: candidates.filter((candidate) => (candidate.shortTitleMatches ?? 0) > 0).length,
    overlapping: candidates.filter((candidate) => (candidate.headlineOverlapCount ?? 0) > 0).length,
  });
};

/**
 * Asks the model which candidates are priority bills (LLM-11). An answer the run cannot use (a refusal, an
 * answer cut at max_tokens or otherwise incomplete, no text, or text that does not parse) is not an
 * error: it is logged as priority_no_answer and counted as PriorityResolverNoAnswer, and the run carries
 * the active records over. Throwing would only repeat it, since Lambda retries the run twice with the
 * same headlines, and would trip the Errors alarm and a CodeDeploy rollback on one bad hour. A call with
 * no answer at all (a rejected request, or throttles or timeouts past their retries) still throws.
 */
const askModel = async (
  headlines: ParsedHeadline[],
  candidates: CandidateBill[],
  now: Date,
  remainingMs: (() => number) | undefined,
): Promise<ModelAnswer> => {
  // Public headlines and bill titles only: what the model was shown, so a run can be replayed on another model.
  logger.info("priority_request", {
    event: "priority_request",
    now: now.toISOString(),
    maxResults: MAX_PRIORITY_RESULTS,
    payload: buildPriorityPayload({ headlines, candidates, maxResults: MAX_PRIORITY_RESULTS }),
  });

  const call = await invokeMessages({
    client: bedrock,
    modelId: MODEL_ID,
    caller: "BillPriorityResolver",
    kind: "priority",
    body: buildPriorityRequestBody(headlines, candidates, {
      profile: REQUEST_PROFILE,
      maxTokens: MAX_OUTPUT_TOKENS,
      effort: BEDROCK_EFFORT,
      now,
      maxResults: MAX_PRIORITY_RESULTS,
    }),
    remainingMs,
    callTimeoutMs: BEDROCK_CALL_TIMEOUT_MS,
    minRemainingMs: BEDROCK_MIN_REMAINING_MS,
    maxThrottleRetries: BEDROCK_MAX_RETRIES,
    baseDelayMs: BEDROCK_BASE_DELAY_MS,
    maxDelayMs: BEDROCK_MAX_DELAY_MS,
  });
  // REL-51: the input tokens of the answered attempt, the bulk of the resolver's Bedrock cost (18 calls a day), so the
  // cost of the titles the model now reads can be watched without Logs Insights (bedrock_call has input_tokens too).
  if (call.usage.input !== null) {
    emitEmbeddedMetric(BEDROCK_METRIC_NAMESPACE, "PriorityInputTokens", call.usage.input);
  }

  const hasText = call.text.trim().length > 0;
  const parsed = call.outcome === "ok" && hasText ? parseBedrockResponse(call.text) : null;
  if (parsed) {
    return { answered: true, decisions: parsed.bills };
  }

  // A refusal's text is always empty, and a cut answer is not used even when part of it would parse.
  const reason: NoAnswerReason = call.outcome !== "ok" ? call.outcome : hasText ? "unparseable" : "empty";
  logger.warn("priority_no_answer", {
    event: "priority_no_answer",
    reason,
    stop_reason: call.stopReason,
    refusalCategory: call.refusalCategory,
    output_tokens: call.usage.output,
    ...(reason === "unparseable" ? { preview: call.text.slice(0, 300) } : {}),
  });
  emitEmbeddedMetric(BEDROCK_METRIC_NAMESPACE, "PriorityResolverNoAnswer", 1, { properties: { reason } });
  return { answered: false, reason };
};

/** The largest of the values, or null when there are none. */
const highest = (values: number[]): number | null => (values.length > 0 ? Math.max(...values) : null);

/**
 * Logs what the model decided in one answer it could use (priority_answer) and counts it, so a quiet hour
 * (the model found nothing newsworthy) can be told from a broken one without replaying the call on Bedrock.
 * Numbers and guids only: no titles, headlines or reasons, which priority_request already holds.
 *
 * - candidatesSent: the candidates the model was shown.
 * - billsReturned: the bills in its answer that parsed (an entry without a guid, reason, score or
 *   confidence is dropped by parseBedrockResponse first). answerEmpty is billsReturned 0.
 * - billsPassing: the returned bills the run would activate if it had room for them: isPriority, a score of
 *   at least minScore, a confidence of at least minConfidence and a guid it sent. billsActivated is the
 *   same capped at MAX_PRIORITY_RESULTS, in rank order in activatedGuids.
 * - topScore, topConfidence: the highest of each over all the returned bills, passing or not, so a model that
 *   only reached 70 shows as a near miss; null with no bills. They may come from different bills.
 * - newPicks, newPickGuids (REL-51): the activated bills that were not in the news when the run started, so a pick
 *   that renews an active record (every hour the bill stays in the news) is not counted again.
 *
 * The metrics (BillBoard/Bedrock, no dimensions) are PriorityAnswerBills, PriorityPassingBills, PriorityNewPicks,
 * PriorityTopScore and PriorityTopConfidence. A run without a usable answer logs priority_no_answer instead, and a run
 * that asked nothing (no headlines or no candidates) neither.
 */
const logPriorityAnswer = (
  candidatesSent: number,
  returned: BedrockPriorityDecision[],
  passing: BedrockPriorityDecision[],
  activated: BedrockPriorityDecision[],
  newPickGuids: string[],
): void => {
  const topScore = highest(returned.map((decision) => decision.score));
  const topConfidence = highest(returned.map((decision) => decision.confidence));

  logger.info("priority_answer", {
    event: "priority_answer",
    candidatesSent,
    billsReturned: returned.length,
    billsPassing: passing.length,
    billsActivated: activated.length,
    activatedGuids: activated.map((decision) => decision.guid),
    newPicks: newPickGuids.length,
    newPickGuids,
    topScore,
    topConfidence,
    answerEmpty: returned.length === 0,
    minScore: PRIORITY_MIN_SCORE,
    minConfidence: PRIORITY_MIN_CONFIDENCE,
  });
  emitEmbeddedMetrics(BEDROCK_METRIC_NAMESPACE, [
    { name: "PriorityAnswerBills", value: returned.length },
    { name: "PriorityPassingBills", value: passing.length },
    { name: "PriorityNewPicks", value: newPickGuids.length },
    // With no bills there is no top: a 0 would pull the average down.
    ...(topScore !== null && topConfidence !== null
      ? [
          { name: "PriorityTopScore", value: topScore, unit: "None" as const },
          { name: "PriorityTopConfidence", value: topConfidence, unit: "None" as const },
        ]
      : []),
  ]);
};

const materializeActiveRecord = (
  decision: BedrockPriorityDecision,
  candidate: CandidateBill,
  rank: number,
  now: Date,
): BillPriorityRecord => {
  const expiresAt = new Date(now.getTime() + DEFAULT_PRIORITY_DURATION_HOURS * 60 * 60 * 1000);

  return {
    guid: candidate.guid,
    status: ACTIVE_PRIORITY_STATUS,
    isPriority: true,
    congress: candidate.congress,
    billType: candidate.billType,
    billNumber: candidate.billNumber,
    title: candidate.title,
    billStatus: candidate.billStatus as BillPriorityRecord["billStatus"],
    updatedAt: candidate.updatedAt,
    priorityRank: rank,
    priorityScore: decision.score,
    priorityConfidence: decision.confidence,
    // REL-51: a reason with a loaded word becomes "Named in N recent national news headlines.", which users read as
    // fact, so N counts only the headlines that name the bill (by number or short title), never the word overlaps.
    priorityReason: sanitizePriorityReason(decision.reason, candidate.explicitHeadlineMatches ?? 0),
    priorityUpdatedAt: now.toISOString(),
    priorityExpiresAt: expiresAt.toISOString(),
    prioritySortKey: buildPrioritySortKey(rank, candidate.guid),
    ttl: Math.floor(expiresAt.getTime() / 1000) + 30 * 24 * 60 * 60,
  };
};

const materializeInactiveRecord = (record: BillPriorityRecord, now: Date): BillPriorityRecord => ({
  ...record,
  status: INACTIVE_PRIORITY_STATUS,
  isPriority: false,
  priorityRank: undefined,
  prioritySortKey: undefined,
  priorityUpdatedAt: now.toISOString(),
  ttl: Math.floor(now.getTime() / 1000) + 30 * 24 * 60 * 60,
});

/**
 * modelAnswer in the result: "ok" when the model answered (possibly with no bills), "none" when it gave
 * no usable answer (noAnswerReason says why; active records carry over), "not_asked" with no headlines
 * or candidates.
 */
export async function handler(_event?: unknown, context?: InvocationContext): Promise<Record<string, unknown>> {
  logger.resetContext(context);
  const remainingMs = context?.getRemainingTimeInMillis?.bind(context);
  const now = new Date();
  const [recentBills, existingActiveRecords, headlines] = await Promise.all([
    loadRecentBills(),
    priorityDao.listActive(),
    loadHeadlines(),
  ]);

  const stillActiveRecords = existingActiveRecords.filter((record) => isPriorityRecordActive(record, now));
  const expiredRecords = existingActiveRecords.filter((record) => !isPriorityRecordActive(record, now));

  if (headlines.length === 0) {
    await Promise.all(expiredRecords.map((record) => priorityDao.put(materializeInactiveRecord(record, now))));
    return {
      status: "ok",
      headlinesProcessed: 0,
      candidateBills: 0,
      modelAnswer: "not_asked",
      activated: 0,
      carriedOver: stillActiveRecords.length,
      expired: expiredRecords.length,
    };
  }

  const companions = await loadCompanionIndex();
  const pool = buildCandidatePool(recentBills, stillActiveRecords);
  // REL-46: from the whole pool, so a newer bill the run does not rank (a new House's rules resolution) still takes
  // the headlines that name its number from an older bill.
  const newestCongress = newestCongressByNumber(pool);
  const { titlesByGuid, stats: titleLookups } = await lookUpTitles(pool, headlines, newestCongress);
  const { eligible, excluded } = excludeCandidates(pool, titlesByGuid);
  const candidates = selectCandidates(eligible, headlines, newestCongress, companions);
  const candidateByGuid = new Map(candidates.map((candidate) => [candidate.guid, candidate]));
  logCandidates({ windowBills: recentBills.length, pool: pool.length, titleLookups, excluded, candidates });

  const answer = candidates.length > 0 ? await askModel(headlines, candidates, now, remainingMs) : null;
  // No usable answer activates nothing, as an answer of no bills does: the records still active carry over.
  const decisions = answer?.answered ? answer.decisions : [];
  // Rank by the model's score, never by its output order: candidates are sent sorted by guid
  // (LLM-08) and models tend to echo input order.
  const passingDecisions = decisions.filter(
    (decision) =>
      decision.isPriority === true &&
      decision.score >= PRIORITY_MIN_SCORE &&
      decision.confidence >= PRIORITY_MIN_CONFIDENCE &&
      candidateByGuid.has(decision.guid),
  );
  const activeDecisions = [...passingDecisions]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.confidence - left.confidence ||
        candidateByGuid.get(right.guid)!.heuristicScore - candidateByGuid.get(left.guid)!.heuristicScore ||
        left.guid.localeCompare(right.guid),
    )
    .slice(0, MAX_PRIORITY_RESULTS);
  if (answer?.answered) {
    const activeBefore = new Set(stillActiveRecords.map((record) => plainBillGuid(record.guid) ?? record.guid));
    const newPickGuids = activeDecisions.map((decision) => decision.guid).filter((guid) => !activeBefore.has(guid));
    logPriorityAnswer(candidates.length, decisions, passingDecisions, activeDecisions, newPickGuids);
  }

  const returnedGuidSet = new Set(activeDecisions.map((decision) => decision.guid));
  const activatedRecords = activeDecisions.map((decision, index) =>
    materializeActiveRecord(decision, candidateByGuid.get(decision.guid)!, index + 1, now),
  );

  // A companion group keeps one active record: a member the model just picked replaces its partner's
  // carried-over record, and of two carried-over members the better ranked stays (APPF-23). Without
  // groups every key is the record's plain guid, so this only retires a record stored under a suffixed
  // guid (REL-41) whose bill the model just picked, or the worse ranked of two records of one bill.
  const returnedGroupKeys = new Set(activeDecisions.map((decision) => companionGroupKey(decision.guid, companions)));
  const carriedGroupKeys = new Set<string>();
  const carryoverRecords = stillActiveRecords
    .filter((record) => !returnedGuidSet.has(record.guid))
    .filter((record) => !returnedGroupKeys.has(companionGroupKey(record.guid, companions)))
    .sort(
      (left, right) => (left.priorityRank ?? Number.MAX_SAFE_INTEGER) - (right.priorityRank ?? Number.MAX_SAFE_INTEGER),
    )
    .filter((record) => {
      const key = companionGroupKey(record.guid, companions);
      if (carriedGroupKeys.has(key)) return false;
      carriedGroupKeys.add(key);
      return true;
    })
    .map((record, index) => ({
      ...record,
      priorityRank: activatedRecords.length + index + 1,
      prioritySortKey: buildPrioritySortKey(activatedRecords.length + index + 1, record.guid),
    }))
    .slice(0, Math.max(0, MAX_PRIORITY_RESULTS - activatedRecords.length));

  const finalActiveRecords = [...activatedRecords, ...carryoverRecords];
  const finalActiveGuidSet = new Set(finalActiveRecords.map((record) => record.guid));
  const inactiveRecords = [
    ...expiredRecords,
    ...stillActiveRecords.filter((record) => !finalActiveGuidSet.has(record.guid) && !returnedGuidSet.has(record.guid)),
  ].map((record) => materializeInactiveRecord(record, now));

  for (const record of finalActiveRecords) {
    await priorityDao.put(record);
  }
  for (const record of inactiveRecords) {
    await priorityDao.put(record);
  }

  return {
    status: "ok",
    headlinesProcessed: headlines.length,
    candidateBills: candidates.length,
    titlesRead: titleLookups.found,
    modelAnswer: answer === null ? "not_asked" : answer.answered ? "ok" : "none",
    ...(answer?.answered === false ? { noAnswerReason: answer.reason } : {}),
    activated: activatedRecords.length,
    carriedOver: carryoverRecords.length,
    expired: inactiveRecords.length,
  };
}
