import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

import { BillStorage } from "../../adapters/billStorage";
import { processedBillGuid } from "../../adapters/processedBillKeys";
import { mapWithConcurrency } from "../../shared/concurrency";
import { batchWriteAll } from "../../shared/dynamoBatchWrite";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";
import { extractS3ObjectRefsFromSQSEvent } from "../../shared/s3EventExtract";
import { processSqsRecords } from "../../shared/sqsBatch";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;
const PRIMARY_KEY = process.env.PRIMARY_KEY!;
const CONGRESS_MEMBERS_MANIFEST_TABLE_NAME = process.env.CONGRESS_MEMBERS_MANIFEST_TABLE_NAME || "";
const VOTE_PROFILE_TABLE_NAME = process.env.VOTE_PROFILE_TABLE_NAME;
const VOTE_PROFILE_PRIMARY_KEY = process.env.VOTE_PROFILE_PRIMARY_KEY ?? "bioguideId";
const VOTE_PROFILE_SORT_KEY = process.env.VOTE_PROFILE_SORT_KEY ?? "billGuid";
const VOTE_PROFILE_BILL_GUID_INDEX_NAME = process.env.VOTE_PROFILE_BILL_GUID_INDEX_NAME ?? "BillGuidIndex";
const VOTE_PROFILE_BILL_GUID_INDEX_PK = process.env.VOTE_PROFILE_BILL_GUID_INDEX_PK ?? "billGuid";
const VOTE_PROFILE_BILL_GUID_INDEX_SK = process.env.VOTE_PROFILE_BILL_GUID_INDEX_SK ?? "bioguideId";
const LEGISLATIVE_PROFILE_TABLE_NAME = process.env.LEGISLATIVE_PROFILE_TABLE_NAME;
const LEGISLATIVE_PROFILE_PRIMARY_KEY = process.env.LEGISLATIVE_PROFILE_PRIMARY_KEY ?? "bioguideId";
const LEGISLATIVE_PROFILE_SORT_KEY = process.env.LEGISLATIVE_PROFILE_SORT_KEY ?? "billGuid";
const LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME =
  process.env.LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME ?? "BillGuidIndex";
const LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PK = process.env.LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PK ?? "billGuid";
const LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SK = process.env.LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SK ?? "bioguideId";

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

/*
 * Triggers (CAP-05). The pipeline sends one message per processed-bill write: createBillsManifest
 * forwards the processed bill's S3 event with its versionId. That message drives everything here:
 * the sponsor/cosponsor counters and the vote and legislative profiles. A message whose version
 * leaves sponsors, cosponsors, official votes and civic profile as its predecessor had them does
 * nothing beyond reading the two versions. A message without a versionId (the replay script, older
 * producers) is always applied in full.
 *
 * raw-bills/*.json keys still update the counters from the raw bill's version pair, so the S3
 * notification that sends them can be removed at any time without losing a count.
 */
const RAW_BILLS_PREFIX = process.env.RAW_BILLS_PREFIX ?? "raw-bills/";
const PROCESSED_BILLS_PREFIX = process.env.PROCESSED_BILLS_PREFIX ?? "processed-bills/";
const COUNTER_UPDATE_CONCURRENCY = 10;

// Per-member string sets of the bill guids already counted in each counter. The counter and
// its set change in one conditional UpdateItem, so a redelivered or replayed event cannot
// count the same bill twice.
const COUNTED_BILL_GUIDS_ATTRIBUTE = {
  billsSponsored: "sponsoredBillGuids",
  billsSupported: "supportedBillGuids",
} as const;
type MemberCounterField = keyof typeof COUNTED_BILL_GUIDS_ATTRIBUTE;

/*
 * When a counter may be incremented for a bill:
 *   - the row has the counted-guid set and the bill is not in it; or
 *   - the row has no set and the counter is absent or 0 (a new member, or one the backfill reset).
 * A row with a count above 0 and no set was counted before the sets existed (a bare ADD). Which
 * bills that count holds is unknown, so it is never incremented: counting there could count a bill
 * twice, since the processed path offers every current sponsor and cosponsor. Such a row stays
 * as it is until `npm run backfill:congress-member-stats` rewrites the counts and seeds the sets
 * from raw-bills (UA-03, right after the first deploy); from then on each bill counts exactly once.
 */
const COUNTER_INCREMENT_CONDITION =
  "(attribute_exists(#countedGuids) AND NOT contains(#countedGuids, :billGuid)) OR " +
  "(attribute_not_exists(#countedGuids) AND (attribute_not_exists(#counter) OR #counter = :zero))";

/*
 * The per-member counters count 119th Congress bills only. The apps label them "Sponsored/Supported in
 * 119th Congress", and that stays true once 120th bills arrive on 2027-01-03. It is a code constant on
 * purpose: a config change must not be able to undo it. Vote and legislative profile rows are still
 * written for every Congress.
 */
const COUNTED_CONGRESS = 119;

/** BILLS-119hr1234ih -> 119; null for a guid with no Congress number. */
const congressOfBillGuid = (guid: string): number | null => {
  const match = guid.match(/^BILLS-(\d+)[a-z]/i);
  return match ? Number(match[1]) : null;
};

export const MEMBER_STATS_METRIC_NAMESPACE = "BillBoard/CongressMemberStats";
const UNSEEDED_LOG_SAMPLE_SIZE = 10;

type CounterOutcome = "counted" | "alreadyCounted" | "unseeded";

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const normalizeLettersOnly = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
const toFiniteNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const stripTrailingPartyState = (value: string): string => value.replace(/\s*\([^)]+\)\s*$/, "").trim();
const looksLikeCanonicalBioguideId = (value: string): boolean => /^[A-Z]\d{6}$/i.test(value);
const SENATE_NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
// The Senate lookup is rebuilt hourly, so a senator sworn in mid-session resolves soon after
// the manifest has them (REL-46).
const SENATE_LOOKUP_TTL_MS = 60 * 60 * 1000;
let cachedSenateBioguideLookupPromise: Promise<Map<string, string>> | null = null;
let cachedSenateBioguideLookupAt = 0;

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
      if (ids.size === 1) resolved.set(key, [...ids][0]);
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

/** A raw bill's sponsor or cosponsor; the Congress API has spelled the id three ways. */
type RawBillPerson = { bioguideId?: unknown; bioguideID?: unknown; bioGuideId?: unknown } | null;

/** The sponsor and cosponsor parts of a raw bill's content, which may nest the bill in a second `bill`. */
type RawBillParts = {
  bill?: RawBillParts;
  sponsors?: RawBillPerson[];
  cosponsors?: RawBillPerson[] | RawBillParts;
};

const extractSponsorBioguideIds = (content: RawBillParts): string[] => {
  const billWrapper = content?.bill;
  const innerBill = billWrapper?.bill ?? billWrapper;
  const sponsors = innerBill?.sponsors ?? content?.sponsors;

  if (!Array.isArray(sponsors)) return [];
  return sponsors
    .map((s: RawBillPerson) => toTrimmedString(s?.bioguideId ?? s?.bioguideID ?? s?.bioGuideId))
    .filter((s: string) => s.length > 0);
};

const extractCosponsorBioguideIds = (content: RawBillParts): string[] => {
  const wrapper = content?.cosponsors ?? content?.bill?.cosponsors;
  const cosponsors = (wrapper as RawBillParts | undefined)?.cosponsors ?? wrapper;

  if (!Array.isArray(cosponsors)) return [];
  return cosponsors
    .map((c: RawBillPerson) => toTrimmedString(c?.bioguideId ?? c?.bioguideID ?? c?.bioGuideId))
    .filter((s: string) => s.length > 0);
};

const extractBillSponsorCosponsorIds = (payload: unknown): { sponsors: string[]; cosponsors: string[] } | null => {
  if (!payload || typeof payload !== "object") return null;
  // A raw bill document, or its content alone.
  const rawBill = payload as RawBillParts & { content?: RawBillParts };
  const content = rawBill?.content ?? rawBill;
  if (!content || typeof content !== "object") return null;

  const sponsors = extractSponsorBioguideIds(content);
  const cosponsors = extractCosponsorBioguideIds(content);

  return { sponsors, cosponsors };
};

const isConditionalCheckFailed = (error: unknown): boolean => {
  const candidate = error as { name?: unknown; Code?: unknown };
  return candidate?.name === "ConditionalCheckFailedException" || candidate?.Code === "ConditionalCheckFailedException";
};

/**
 * Adds the bill to one member counter. "alreadyCounted": the bill is in the member's set.
 * "unseeded": the row has a count but no set yet (see COUNTER_INCREMENT_CONDITION).
 */
const incrementCounter = async (
  bioguideId: string,
  field: MemberCounterField,
  billGuid: string,
): Promise<CounterOutcome> => {
  const countedGuidsAttribute = COUNTED_BILL_GUIDS_ATTRIBUTE[field];
  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          [PRIMARY_KEY]: { S: bioguideId },
        },
        UpdateExpression: "ADD #counter :inc, #countedGuids :billGuidSet",
        ConditionExpression: COUNTER_INCREMENT_CONDITION,
        ExpressionAttributeNames: {
          "#counter": field,
          "#countedGuids": countedGuidsAttribute,
        },
        ExpressionAttributeValues: {
          ":inc": { N: "1" },
          ":billGuidSet": { SS: [billGuid] },
          ":billGuid": { S: billGuid },
          ":zero": { N: "0" },
        },
        // A failed condition returns the row, which tells an already-counted bill from an unseeded row.
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }),
    );
    return "counted";
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    // The condition fails with the set absent only when the count is above 0.
    const row = (error as { Item?: Record<string, unknown> }).Item;
    return row && row[countedGuidsAttribute] === undefined ? "unseeded" : "alreadyCounted";
  }
};

// raw-bills/<guid>.json -> <guid>; the backfill script derives the same guid from the key.
const extractRawBillGuidFromKey = (key: string): string | null => {
  if (!key.startsWith(RAW_BILLS_PREFIX) || !key.endsWith(".json")) return null;
  const guid = key.slice(RAW_BILLS_PREFIX.length, -".json".length).trim();
  return guid.length > 0 ? guid : null;
};

// Keys drop the version suffix (BILLS-119hr1234ih -> BILLS-119hr1234); the counted-guid sets hold that
// form, whichever path (raw key, processed bill, backfill script) counted the bill.
const normalizeBillGuidForKey = (guid: string): string => {
  const match = guid.match(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i);
  return match ? match[1] : guid;
};

/** Applies the counter updates for one bill; each (member, bill) pair is counted at most once. */
const applyCounterUpdates = async (
  billGuid: string,
  updates: Array<{ bioguideId: string; field: MemberCounterField }>,
  key: string,
): Promise<number> => {
  if (congressOfBillGuid(billGuid) !== COUNTED_CONGRESS) {
    logger.info("Did not count a bill from another Congress; member counters count the 119th only", {
      key,
      billGuid,
      offered: updates.length,
    });
    emitEmbeddedMetric(MEMBER_STATS_METRIC_NAMESPACE, "MemberCounterOtherCongress", updates.length);
    return 0;
  }
  // Large bills have hundreds of cosponsors; cap the UpdateItem calls in flight.
  const outcomes = await mapWithConcurrency(updates, COUNTER_UPDATE_CONCURRENCY, (update) =>
    incrementCounter(update.bioguideId, update.field, billGuid),
  );
  const counted = outcomes.filter((outcome) => outcome === "counted").length;
  const alreadyCounted = outcomes.filter((outcome) => outcome === "alreadyCounted").length;
  const unseeded = updates.filter((_update, index) => outcomes[index] === "unseeded");
  if (alreadyCounted > 0) {
    console.log("Skipped congress member stat increments already counted for this bill", {
      key,
      skipped: alreadyCounted,
    });
  }
  if (unseeded.length > 0) {
    logger.warn(
      "Did not increment member counters that predate the counted-bill sets; run npm run backfill:congress-member-stats (UA-03)",
      {
        key,
        billGuid,
        skippedUnseeded: unseeded.length,
        members: unseeded.slice(0, UNSEEDED_LOG_SAMPLE_SIZE),
      },
    );
    emitEmbeddedMetric(MEMBER_STATS_METRIC_NAMESPACE, "MemberCounterSkippedUnseeded", unseeded.length);
  }
  return counted;
};

const processBillKey = async (storage: BillStorage, key: string, versionId?: string): Promise<number> => {
  const { current, previous } = await storage.getLatestAndPreviousJson<unknown>(key, versionId);
  if (!current) {
    console.warn("Skipping congress member stats; could not load raw bill", { key });
    return 0;
  }

  const extracted = extractBillSponsorCosponsorIds(current);
  if (!extracted) {
    console.warn("Skipping congress member stats; missing expected bill fields", { key });
    return 0;
  }

  const sponsors = new Set(extracted.sponsors);
  const cosponsors = new Set(extracted.cosponsors.filter((id) => !sponsors.has(id)));

  let addedSponsors = new Set(sponsors);
  let addedCosponsors = new Set(cosponsors);

  if (previous) {
    const prevExtracted = extractBillSponsorCosponsorIds(previous);
    if (prevExtracted) {
      const prevSponsors = new Set(prevExtracted.sponsors);
      const prevCosponsors = new Set(prevExtracted.cosponsors.filter((id) => !prevSponsors.has(id)));
      addedSponsors = new Set([...sponsors].filter((id) => !prevSponsors.has(id)));
      addedCosponsors = new Set([...cosponsors].filter((id) => !prevCosponsors.has(id)));
    }
  }

  const updates: Array<{ bioguideId: string; field: MemberCounterField }> = [
    ...[...addedSponsors].map((bioguideId) => ({ bioguideId, field: "billsSponsored" as const })),
    ...[...addedCosponsors].map((bioguideId) => ({ bioguideId, field: "billsSupported" as const })),
  ];

  if (updates.length === 0) {
    console.log("Skipping congress member stats; no sponsor or cosponsor added in this raw bill version", { key });
    return 0;
  }

  const billGuid = extractRawBillGuidFromKey(key);
  if (!billGuid) {
    throw new Error(`Cannot derive bill guid from raw bill key ${key}`);
  }

  return applyCounterUpdates(billGuid, updates, key);
};

type VoteProfilePosition = "Yea" | "Nay";
type LegislativeEvidenceType = "sponsor" | "cosponsor";

type VoteProfileRow = {
  bioguideId: string;
  votePosition: VoteProfilePosition;
  votedAt: string;
};

type LegislativeProfileRow = {
  bioguideId: string;
  evidenceType: LegislativeEvidenceType;
  occurredAt: string;
};

const extractBillGuidFromKey = (key: string): string | null => {
  const match = key.match(/^processed-bills\/([^/]+)\.json$/i);
  if (!match) return null;
  const guid = toTrimmedString(match[1]);
  return guid.length > 0 ? guid : null;
};

const normalizeVotePosition = (value: unknown): VoteProfilePosition | null => {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "yea" || normalized === "yes" || normalized === "aye") return "Yea";
  if (normalized === "nay" || normalized === "no") return "Nay";
  return null;
};

const toCivicProfileMap = (value: unknown): Record<string, { N: string }> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([axis, score]) => {
      const numeric = toFiniteNumberOrNull(score);
      if (numeric === null) return null;
      return [axis, { N: numeric.toString() }] as const;
    })
    .filter((entry): entry is readonly [string, { N: string }] => entry !== null);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
};

const extractVoteRows = async (
  payload: unknown,
): Promise<{
  billGuid: string | null;
  civicProfileMap: Record<string, { N: string }> | null;
  rows: VoteProfileRow[];
}> => {
  const nowIso = new Date().toISOString();
  if (!payload || typeof payload !== "object") {
    return { billGuid: null, civicProfileMap: null, rows: [] };
  }

  const root = payload as Record<string, unknown>;
  const billGuid = toTrimmedString(root.guid) || null;
  const civicProfileMap = toCivicProfileMap(root.civicProfile);
  const officialVotes = (root.officialVotes as Record<string, unknown> | undefined) ?? undefined;
  const house = (officialVotes?.house as Record<string, unknown> | undefined) ?? undefined;
  const senate = (officialVotes?.senate as Record<string, unknown> | undefined) ?? undefined;
  const lastSyncedAt = toTrimmedString(officialVotes?.lastSyncedAt);
  const storedAt = toTrimmedString(root.storedAt);

  const rows: VoteProfileRow[] = [];
  const seen = new Set<string>();

  const addRowsForChamber = async (
    chamberVote: Record<string, unknown> | undefined,
    options?: { canonicalizeSenateIds?: boolean },
  ) => {
    if (!chamberVote) return;
    const members = Array.isArray(chamberVote.members) ? (chamberVote.members as unknown[]) : [];
    const actionDate = toTrimmedString(chamberVote.actionDate);
    const votedAtSource = actionDate || lastSyncedAt || storedAt || nowIso;
    const votedAt = Number.isNaN(Date.parse(votedAtSource)) ? nowIso : new Date(votedAtSource).toISOString();

    for (const member of members) {
      if (!member || typeof member !== "object") continue;
      const memberRecord = member as Record<string, unknown>;
      const rawBioguideId = toTrimmedString(memberRecord.bioguideId ?? memberRecord.memberId ?? memberRecord.id);
      const bioguideId = options?.canonicalizeSenateIds
        ? await resolveSenateBioguideId(
            rawBioguideId,
            toTrimmedString(memberRecord.displayName ?? memberRecord.name),
            toTrimmedString(memberRecord.state),
          )
        : rawBioguideId;
      const votePosition = normalizeVotePosition(
        memberRecord.votePosition ?? memberRecord.vote ?? memberRecord.position,
      );
      if (!bioguideId || !votePosition) continue;
      const dedupeKey = `${bioguideId}|${votePosition}|${votedAt}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push({ bioguideId, votePosition, votedAt });
    }
  };

  await addRowsForChamber(house);
  await addRowsForChamber(senate, { canonicalizeSenateIds: true });

  return { billGuid, civicProfileMap, rows };
};

/** A processed bill's sponsor ids, and its cosponsor ids minus any sponsor (as the raw path counts them). */
const processedSponsorIds = (root: Record<string, unknown>): { sponsorIds: Set<string>; cosponsorIds: Set<string> } => {
  const sponsors = Array.isArray(root.sponsors) ? root.sponsors : [];
  const cosponsors = Array.isArray(root.cosponsors) ? root.cosponsors : [];
  const sponsorIds = new Set(sponsors.map((value) => toTrimmedString(value)).filter((value) => value.length > 0));
  const cosponsorIds = new Set(
    cosponsors.map((value) => toTrimmedString(value)).filter((value) => value.length > 0 && !sponsorIds.has(value)),
  );
  return { sponsorIds, cosponsorIds };
};

const extractLegislativeRows = (
  payload: unknown,
): {
  billGuid: string | null;
  civicProfileMap: Record<string, { N: string }> | null;
  rows: LegislativeProfileRow[];
} => {
  const nowIso = new Date().toISOString();
  if (!payload || typeof payload !== "object") {
    return { billGuid: null, civicProfileMap: null, rows: [] };
  }

  const root = payload as Record<string, unknown>;
  const billGuid = toTrimmedString(root.guid) || null;
  const civicProfileMap = toCivicProfileMap(root.civicProfile);
  const officialVotes = (root.officialVotes as Record<string, unknown> | undefined) ?? undefined;
  const house = (officialVotes?.house as Record<string, unknown> | undefined) ?? undefined;
  const senate = (officialVotes?.senate as Record<string, unknown> | undefined) ?? undefined;
  const occurredAtSource =
    toTrimmedString(house?.actionDate) ||
    toTrimmedString(senate?.actionDate) ||
    toTrimmedString(officialVotes?.lastSyncedAt) ||
    toTrimmedString(root.storedAt) ||
    nowIso;
  const occurredAt = Number.isNaN(Date.parse(occurredAtSource)) ? nowIso : new Date(occurredAtSource).toISOString();

  const { sponsorIds, cosponsorIds } = processedSponsorIds(root);

  const rows: LegislativeProfileRow[] = [
    ...[...sponsorIds].map((bioguideId) => ({ bioguideId, evidenceType: "sponsor" as const, occurredAt })),
    ...[...cosponsorIds].map((bioguideId) => ({ bioguideId, evidenceType: "cosponsor" as const, occurredAt })),
  ];

  return { billGuid, civicProfileMap, rows };
};

const queryExistingVoteProfileRowsForBill = async (billGuid: string): Promise<Set<string>> => {
  if (!VOTE_PROFILE_TABLE_NAME) return new Set<string>();

  const existing = new Set<string>();
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: VOTE_PROFILE_TABLE_NAME,
        IndexName: VOTE_PROFILE_BILL_GUID_INDEX_NAME,
        KeyConditionExpression: "#billGuid = :billGuid",
        ExpressionAttributeNames: {
          "#billGuid": VOTE_PROFILE_BILL_GUID_INDEX_PK,
          "#memberId": VOTE_PROFILE_BILL_GUID_INDEX_SK,
        },
        ExpressionAttributeValues: {
          ":billGuid": { S: billGuid },
        },
        ProjectionExpression: "#memberId",
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const value = item?.[VOTE_PROFILE_BILL_GUID_INDEX_SK]?.S;
      if (typeof value === "string" && value.length > 0) {
        existing.add(value);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return existing;
};

const queryExistingLegislativeRowsForBill = async (billGuid: string): Promise<Set<string>> => {
  if (!LEGISLATIVE_PROFILE_TABLE_NAME) return new Set<string>();

  const existing = new Set<string>();
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: LEGISLATIVE_PROFILE_TABLE_NAME,
        IndexName: LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME,
        KeyConditionExpression: "#billGuid = :billGuid",
        ExpressionAttributeNames: {
          "#billGuid": LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PK,
          "#memberId": LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SK,
        },
        ExpressionAttributeValues: {
          ":billGuid": { S: billGuid },
        },
        ProjectionExpression: "#memberId",
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const value = item?.[LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SK]?.S;
      if (typeof value === "string" && value.length > 0) {
        existing.add(value);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return existing;
};

const putVoteProfileRows = async (
  rows: VoteProfileRow[],
  billGuid: string,
  civicProfileMap: Record<string, { N: string }>,
): Promise<void> => {
  if (!VOTE_PROFILE_TABLE_NAME || rows.length === 0) return;

  const timestamp = new Date().toISOString();
  const requests: WriteRequest[] = rows.map((row) => ({
    PutRequest: {
      Item: {
        [VOTE_PROFILE_PRIMARY_KEY]: { S: row.bioguideId },
        [VOTE_PROFILE_SORT_KEY]: { S: billGuid },
        evidenceType: { S: row.votePosition === "Yea" ? "voteYea" : "voteNay" },
        votePosition: { S: row.votePosition },
        occurredAt: { S: row.votedAt },
        votedAt: { S: row.votedAt },
        updatedAt: { S: timestamp },
        civicProfile: { M: civicProfileMap },
      },
    },
  }));

  await batchWriteAll({ db: ddb, tableName: VOTE_PROFILE_TABLE_NAME, requests });
};

const putLegislativeProfileRows = async (
  rows: LegislativeProfileRow[],
  billGuid: string,
  civicProfileMap: Record<string, { N: string }>,
): Promise<void> => {
  if (!LEGISLATIVE_PROFILE_TABLE_NAME || rows.length === 0) return;

  const timestamp = new Date().toISOString();
  const requests: WriteRequest[] = rows.map((row) => ({
    PutRequest: {
      Item: {
        [LEGISLATIVE_PROFILE_PRIMARY_KEY]: { S: row.bioguideId },
        [LEGISLATIVE_PROFILE_SORT_KEY]: { S: billGuid },
        evidenceType: { S: row.evidenceType },
        occurredAt: { S: row.occurredAt },
        updatedAt: { S: timestamp },
        civicProfile: { M: civicProfileMap },
      },
    },
  }));

  await batchWriteAll({ db: ddb, tableName: LEGISLATIVE_PROFILE_TABLE_NAME, requests });
};

const deleteVoteProfileRows = async (bioguideIds: string[], billGuid: string): Promise<void> => {
  if (!VOTE_PROFILE_TABLE_NAME || bioguideIds.length === 0) return;

  const requests: WriteRequest[] = bioguideIds.map((bioguideId) => ({
    DeleteRequest: {
      Key: {
        [VOTE_PROFILE_PRIMARY_KEY]: { S: bioguideId },
        [VOTE_PROFILE_SORT_KEY]: { S: billGuid },
      },
    },
  }));

  await batchWriteAll({ db: ddb, tableName: VOTE_PROFILE_TABLE_NAME, requests });
};

const deleteLegislativeProfileRows = async (bioguideIds: string[], billGuid: string): Promise<void> => {
  if (!LEGISLATIVE_PROFILE_TABLE_NAME || bioguideIds.length === 0) return;

  const requests: WriteRequest[] = bioguideIds.map((bioguideId) => ({
    DeleteRequest: {
      Key: {
        [LEGISLATIVE_PROFILE_PRIMARY_KEY]: { S: bioguideId },
        [LEGISLATIVE_PROFILE_SORT_KEY]: { S: billGuid },
      },
    },
  }));

  await batchWriteAll({ db: ddb, tableName: LEGISLATIVE_PROFILE_TABLE_NAME, requests });
};

// The processed-bill fields everything below reads. storedAt is left out on purpose: it changes on
// every write (an actions-only patch too) and only stands in for a missing vote or action date.
const MEMBER_STATS_INPUT_FIELDS = ["guid", "sponsors", "cosponsors", "officialVotes", "civicProfile"] as const;

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

/** Canonical form of what member stats read from a processed bill; equal strings give equal writes. */
const memberStatsInputsOf = (payload: unknown): string => {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return stableStringify(Object.fromEntries(MEMBER_STATS_INPUT_FIELDS.map((field) => [field, root[field] ?? null])));
};

type ContentVersion = { versionId: string; isLatest: boolean };

/** A processed bill as read from S3, with its version when that is known. */
type ProcessedBillVersion = { bill: unknown; versionId?: string };

/** The key's versions newest first, without delete markers. */
const listContentVersions = async (storage: BillStorage, key: string): Promise<ContentVersion[]> =>
  (await storage.listObjectVersionsForKey(key)).filter((version) => !version.isDeleteMarker);

/** The latest version, read by its versionId so the caller knows which one it applied. */
const loadLatestVersion = async (
  storage: BillStorage,
  key: string,
  versions: ContentVersion[],
): Promise<ProcessedBillVersion> => {
  const latest = versions[0];
  if (latest?.isLatest) {
    return { bill: await storage.getJsonWithVersionId<unknown>(key, latest.versionId), versionId: latest.versionId };
  }
  // No content version is current (a delete marker, or an unversioned listing): read the key as it is.
  return { bill: await storage.getJson<unknown>(key) };
};

/**
 * Loads the processed bill to apply, or null when this message cannot change anything: its version
 * has the same member-stats inputs as the version before it, whose own message applies them.
 * What is applied is always the latest version, so a message handled late cannot undo a newer one.
 * A message without a versionId (the replay script, older producers) reads the latest version once.
 */
const loadProcessedBillToApply = async (
  storage: BillStorage,
  key: string,
  versionId?: string,
): Promise<ProcessedBillVersion | null> => {
  if (!versionId) return { bill: await storage.getJson<unknown>(key) };

  const versions = await listContentVersions(storage, key);
  const index = versions.findIndex((version) => version.versionId === versionId);
  // A version the listing does not know cannot be compared: apply the latest in full.
  if (index >= 0) {
    const previousVersionId = versions[index + 1]?.versionId;
    const [current, previous] = await Promise.all([
      storage.getJsonWithVersionId<unknown>(key, versionId),
      previousVersionId ? storage.getJsonWithVersionId<unknown>(key, previousVersionId) : Promise.resolve(null),
    ]);
    if (current && previous && memberStatsInputsOf(current) === memberStatsInputsOf(previous)) return null;
    if (current && versions[index].isLatest) return { bill: current, versionId };
  }
  return loadLatestVersion(storage, key, versions);
};

/**
 * The key's latest version when it is newer than the one just applied and its member-stats inputs
 * differ, else null. Two messages for one key can be handled at the same time: the one holding the
 * older version may finish its profile writes last, and later messages whose inputs match the
 * newer version are skipped, so those older rows would stay. Re-listing after the writes catches
 * that; S3 listings are strongly consistent, so a version written after this check is applied by
 * its own message, whose writes all start after it was written.
 */
const loadNewerVersionToApply = async (
  storage: BillStorage,
  key: string,
  applied: ProcessedBillVersion,
): Promise<ProcessedBillVersion | null> => {
  const latest = (await listContentVersions(storage, key))[0];
  if (!latest?.isLatest || latest.versionId === applied.versionId) return null;
  const bill = await storage.getJsonWithVersionId<unknown>(key, latest.versionId);
  if (!bill || memberStatsInputsOf(bill) === memberStatsInputsOf(applied.bill)) return null;
  return { bill, versionId: latest.versionId };
};

const processProcessedBillKey = async (storage: BillStorage, key: string, versionId?: string): Promise<number> => {
  const toApply = await loadProcessedBillToApply(storage, key, versionId);
  if (!toApply) {
    console.log("Skipping congress member stats; sponsors, cosponsors, official votes and civic profile unchanged", {
      key,
      versionId,
    });
    return 0;
  }

  let writes = await applyProcessedBill(key, toApply.bill);
  // One extra pass at most. A version whose own message finished while this one was applying would
  // otherwise be overwritten by these older rows, and the CAP-05 skip would keep them.
  if (toApply.versionId && toApply.bill && typeof toApply.bill === "object") {
    const newer = await loadNewerVersionToApply(storage, key, toApply);
    if (newer) {
      console.log("Applying the processed bill version written while this message was being applied", {
        key,
        appliedVersionId: toApply.versionId,
        latestVersionId: newer.versionId,
      });
      writes += await applyProcessedBill(key, newer.bill);
      // Still behind after the extra pass: fail the record so SQS redelivers it; the redelivery
      // applies whatever version is latest then.
      const newest = await loadNewerVersionToApply(storage, key, newer);
      if (newest) {
        throw new Error(
          `Processed bill ${key} changed again during the extra member-stats pass (applied ${newer.versionId}, latest ${newest.versionId}); retrying`,
        );
      }
    }
  }
  return writes;
};

/** Writes the counters and the vote and legislative profile rows for one processed bill. */
const applyProcessedBill = async (key: string, current: unknown): Promise<number> => {
  if (!current || typeof current !== "object") {
    console.warn("Skipping processed bill member stats; could not load processed bill", { key });
    return 0;
  }

  const fallbackBillGuid = extractBillGuidFromKey(key);
  const root = current as Record<string, unknown>;
  const rootGuid = toTrimmedString(root.guid);

  // Sponsor/cosponsor counters. Every current sponsor and cosponsor is offered; the per-member
  // counted-guid sets drop the ones already counted, so this also repairs a count an earlier
  // message missed. Rows counted before the sets existed are left alone (COUNTER_INCREMENT_CONDITION).
  let writes = 0;
  const guidForCounters = rootGuid || fallbackBillGuid;
  const counterGuid = guidForCounters ? normalizeBillGuidForKey(guidForCounters) : null;
  const { sponsorIds, cosponsorIds } = processedSponsorIds(root);
  const counterUpdates: Array<{ bioguideId: string; field: MemberCounterField }> = [
    ...[...sponsorIds].map((bioguideId) => ({ bioguideId, field: "billsSponsored" as const })),
    ...[...cosponsorIds].map((bioguideId) => ({ bioguideId, field: "billsSupported" as const })),
  ];
  if (counterGuid && counterUpdates.length > 0) {
    writes += await applyCounterUpdates(counterGuid, counterUpdates, key);
  }

  if (!VOTE_PROFILE_TABLE_NAME && !LEGISLATIVE_PROFILE_TABLE_NAME) {
    console.warn("Skipping processed bill profile ingest; missing profile table env vars", { key });
    return writes;
  }

  const voteExtracted = await extractVoteRows(current);
  const legislativeExtracted = extractLegislativeRows(current);
  // The key's plain guid: a suffixed document guid (BILLS-119hr1181rh) gave the bill a second set of profile rows,
  // which the stale-row cleanup below never reached.
  const billGuid = processedBillGuid(key, rootGuid);
  if (!billGuid) {
    console.warn("Skipping processed bill profile ingest; missing bill guid", { key });
    return writes;
  }

  // A version without a civic profile (its summary scored no axis) is no civic evidence (REL-43): it writes no
  // profile rows, so every row an earlier version wrote for the bill is stale and is deleted. Kept, those rows would
  // go on scoring the members with civic values the bill no longer has. The counters above do not use it.
  const voteRows = voteExtracted.civicProfileMap ? voteExtracted.rows : [];
  const legislativeRows = legislativeExtracted.civicProfileMap ? legislativeExtracted.rows : [];
  let staleVoteRows = 0;
  let staleLegislativeRows = 0;

  if (VOTE_PROFILE_TABLE_NAME) {
    const existingVoteMemberIds = await queryExistingVoteProfileRowsForBill(billGuid);
    const incomingVoteMemberIds = new Set(voteRows.map((r) => r.bioguideId));
    const staleVoteMemberIds = [...existingVoteMemberIds].filter(
      (existingMemberId) => !incomingVoteMemberIds.has(existingMemberId),
    );

    if (voteExtracted.civicProfileMap) {
      await putVoteProfileRows(voteRows, billGuid, voteExtracted.civicProfileMap);
    }
    await deleteVoteProfileRows(staleVoteMemberIds, billGuid);
    staleVoteRows = staleVoteMemberIds.length;
    writes += voteRows.length + staleVoteRows;
  }

  if (LEGISLATIVE_PROFILE_TABLE_NAME) {
    const existingLegislativeMemberIds = await queryExistingLegislativeRowsForBill(billGuid);
    const incomingLegislativeMemberIds = new Set(legislativeRows.map((r) => r.bioguideId));
    const staleLegislativeMemberIds = [...existingLegislativeMemberIds].filter(
      (existingMemberId) => !incomingLegislativeMemberIds.has(existingMemberId),
    );

    if (legislativeExtracted.civicProfileMap) {
      await putLegislativeProfileRows(legislativeRows, billGuid, legislativeExtracted.civicProfileMap);
    }
    await deleteLegislativeProfileRows(staleLegislativeMemberIds, billGuid);
    staleLegislativeRows = staleLegislativeMemberIds.length;
    writes += legislativeRows.length + staleLegislativeRows;
  }

  if (!legislativeExtracted.civicProfileMap && staleVoteRows + staleLegislativeRows > 0) {
    console.log("Deleted the bill's member profile rows; the processed bill has no civic profile", {
      key,
      billGuid,
      voteRows: staleVoteRows,
      legislativeRows: staleLegislativeRows,
    });
  }

  return writes;
};

const processRecord = async (storage: BillStorage, record: SQSRecord): Promise<void> => {
  const refs = extractS3ObjectRefsFromSQSEvent({ Records: [record] });
  for (const ref of refs) {
    if (!ref.key.endsWith(".json")) continue;
    if (ref.key.startsWith(RAW_BILLS_PREFIX)) {
      await processBillKey(storage, ref.key, ref.versionId);
    } else if (ref.key.startsWith(PROCESSED_BILLS_PREFIX)) {
      await processProcessedBillKey(storage, ref.key, ref.versionId);
    }
  }
};

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  if (!BUCKET_NAME) throw new Error("Missing env var BUCKET_NAME");
  if (!TABLE_NAME) throw new Error("Missing env var TABLE_NAME");

  const storage = new BillStorage(s3, BUCKET_NAME);

  // Only the records that failed are retried; the others already applied their writes.
  return processSqsRecords(event, (record) => processRecord(storage, record), {
    label: "Failed to process S3 object for congress member stats:",
  });
}
