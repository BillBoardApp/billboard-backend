import { S3Client } from "@aws-sdk/client-s3";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

import { ProcessedCongressMemberDao } from "../../adapters/processedCongressMemberDao";
import { RawCongressMemberDao } from "../../adapters/rawCongressMemberDao";
import type {
  CongressMemberTerm,
  ProcessedCongressMember,
  ProcessedCongressMemberResponse,
  RawCongressMember,
  RawCongressMemberResponse,
} from "../../models/congressMember";
import { isDepartedCongressMember, unwrapCongressMember } from "../../models/congressMember";
import { emitEmbeddedMetric } from "../../shared/metrics";
import { cachedLoader, fetchSenateSeats } from "../../shared/senateSeats";
import {
  isSenateTerm,
  latestTerm,
  mergeSenateTerms,
  resolveCurrentSenateSeat,
  type SenateSeat,
} from "../../shared/senateTerms";

const BUCKET_NAME = process.env.BUCKET_NAME!;

// REL-52: a current senator's terms are merged by the class of the seat, which only the Senate's list gives
// (shared/senateSeats.ts). One read serves an execution environment for 6 hours, so the weekly refresh of the ~100
// senators reads it a few times; after a failed read the class is inferred for 5 minutes before it is tried again.
const SENATE_SEATS_TTL_MS = 6 * 60 * 60 * 1000;
const SENATE_SEATS_RETRY_AFTER_MS = 5 * 60 * 1000;
const INGESTION_METRIC_NAMESPACE = "BillBoard/BillIngestion";

const s3 = new S3Client({});
const rawMemberDao = new RawCongressMemberDao(s3, BUCKET_NAME);
const processedMemberDao = new ProcessedCongressMemberDao(s3, BUCKET_NAME);
const loadSenateSeats = cachedLoader(() => fetchSenateSeats(), {
  ttlMs: SENATE_SEATS_TTL_MS,
  retryAfterMs: SENATE_SEATS_RETRY_AFTER_MS,
  onError: (error) => console.warn("Could not read the Senate's list of senators; inferring Senate classes", { error }),
});

const toTrimmedStringOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toFiniteNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const lastArrayEntry = <T>(value: T[] | undefined | null): T | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value[value.length - 1];
};

const getMostRecentTerm = (terms: CongressMemberTerm[] | undefined): CongressMemberTerm | null => {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  // The user note says we use the most recent term; the API ordering is typically chronological.
  // We still defensively pick the term with the highest startYear when available.
  const sorted = [...terms].sort((a, b) => {
    const ay = typeof a?.startYear === "number" ? a.startYear : -Infinity;
    const by = typeof b?.startYear === "number" ? b.startYear : -Infinity;
    return ay === by ? 0 : ay - by;
  });
  return sorted[sorted.length - 1] ?? null;
};

export interface SummarizeOptions {
  /** The seat the member holds now if they are a senator (resolveCurrentSenateSeat); null infers its class. */
  senateSeat?: SenateSeat | null;
}

export const summarizeCongressMemberPayload = (
  payload: unknown,
  { senateSeat = null }: SummarizeOptions = {},
): ProcessedCongressMemberResponse | null => {
  const member = unwrapCongressMember(payload);
  if (!member) return null;

  const bioguideId = toTrimmedStringOrNull(member.bioguideId);
  if (!bioguideId) return null;

  const cosponsoredLegislationCount = toFiniteNumberOrNull(member.cosponsoredLegislation?.count) ?? 0;
  const sponsoredLegislationCount = toFiniteNumberOrNull(member.sponsoredLegislation?.count) ?? 0;

  const depictionImageUrl = toTrimmedStringOrNull(member.depiction?.imageUrl);
  const directOrderName = toTrimmedStringOrNull(member.directOrderName);
  const firstName = toTrimmedStringOrNull(member.firstName) ?? toTrimmedStringOrNull(member.firstname);
  const lastName = toTrimmedStringOrNull(member.lastName) ?? toTrimmedStringOrNull(member.lastname);
  const name =
    directOrderName ??
    ([firstName, lastName].filter((v): v is string => typeof v === "string" && v.length > 0).join(" ") || bioguideId);
  // REL-52: one entry per term. congress.gov lists Senate service per Congress, so a senator's entries are merged
  // into six-year terms (shared/senateTerms.ts); House entries are terms already. termCount always equals
  // terms.length: apps 1.1 and 1.2 count terms[] and use termCount only when terms is missing.
  const terms = Array.isArray(member.terms) ? mergeSenateTerms(member.terms, senateSeat) : member.terms;
  const termCount = Array.isArray(terms) ? terms.length : 0;

  const lastParty = lastArrayEntry(member.partyHistory);
  const partyAbbreviation = toTrimmedStringOrNull(lastParty?.partyAbbreviation);
  const partyName = toTrimmedStringOrNull(lastParty?.partyName);

  // The current Congress's entry, as congress.gov lists it (the merged term would give the Congress it began in).
  const mostRecentTerm = getMostRecentTerm(member.terms);
  const chamber = toTrimmedStringOrNull(mostRecentTerm?.chamber) ?? toTrimmedStringOrNull(mostRecentTerm?.memberType);
  const congress = toFiniteNumberOrNull(mostRecentTerm?.congress);

  let district: number | string | null = null;
  if (mostRecentTerm && mostRecentTerm.district !== undefined) {
    if (typeof mostRecentTerm.district === "number" && Number.isFinite(mostRecentTerm.district))
      district = mostRecentTerm.district;
    else district = toTrimmedStringOrNull(mostRecentTerm.district) ?? null;
  }

  const memberType = toTrimmedStringOrNull(mostRecentTerm?.memberType);
  const startYear = toFiniteNumberOrNull(mostRecentTerm?.startYear);
  const stateCode = toTrimmedStringOrNull(mostRecentTerm?.stateCode);
  const stateName = toTrimmedStringOrNull(mostRecentTerm?.stateName);
  const state = toTrimmedStringOrNull(member.state) ?? stateName;
  const updateDate = toTrimmedStringOrNull(member.updateDate);

  const processedMember: ProcessedCongressMember = {
    bioguideId,
    name,
    cosponsoredLegislationCount,
    sponsoredLegislationCount,
    depictionImageUrl,
    directOrderName,
    firstName,
    lastName,
    termCount,
    partyAbbreviation,
    partyName,
    state,
    chamber,
    congress,
    district,
    memberType,
    startYear,
    stateCode,
    stateName,
    updateDate,
    terms,
  };

  return {
    member: processedMember,
  };
};

/** An SQS message body: the member's bioguide id, in either spelling. */
type MemberMessage = { bioguideId?: unknown; bioguide_id?: unknown };

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

  const bioguideId = (parsed as MemberMessage).bioguideId ?? (parsed as MemberMessage).bioguide_id;
  if (typeof bioguideId !== "string" || bioguideId.trim().length === 0) {
    throw new Error("Missing bioguideId in SQS message payload");
  }

  return bioguideId.trim();
};

/**
 * The seat a current senator holds, from the Senate's list; null for anyone else, and for a senator the list does not
 * give (it could not be read, does not name them, or names another state), whose class is then inferred and counted in
 * SenateClassInferred (alarm Billboard-Ingestion-SenateClassInferred, RUNBOOK 21.2). A senator the list does not name
 * is either new to it, or one who has left while congress.gov still marks them current (the summarizer retires a member
 * only once congress.gov says currentMember false); the log gives the state to tell the two apart.
 */
const currentSenateSeat = async (
  bioguideId: string,
  terms: CongressMemberTerm[] | undefined,
): Promise<SenateSeat | null> => {
  const latest = latestTerm(terms);
  if (!isSenateTerm(latest)) return null;
  const { seat, inferredReason } = resolveCurrentSenateSeat(bioguideId, terms, await loadSenateSeats());
  if (inferredReason) {
    console.warn("No Senate class for a current senator; inferring it from the state's seats", {
      bioguideId,
      stateCode: typeof latest?.stateCode === "string" ? latest.stateCode : null,
      reason: inferredReason,
    });
    emitEmbeddedMetric(INGESTION_METRIC_NAMESPACE, "SenateClassInferred", 1, {
      properties: { reason: inferredReason },
    });
  }
  return seat;
};

const processRecord = async (record: SQSRecord): Promise<void> => {
  const bioguideId = parseBioguideId(record);

  const rawPayload = await rawMemberDao.get<RawCongressMemberResponse | RawCongressMember | unknown>(bioguideId);
  if (!rawPayload) {
    throw new Error(`No raw congress member found for bioguideId=${bioguideId}`);
  }

  // Retire members congress.gov no longer lists as current (fetchCongressMembersList re-checks
  // manifest members missing from the current list). Deleting the processed object fires the
  // ObjectRemoved notification that removes the manifest row.
  if (isDepartedCongressMember(rawPayload)) {
    console.log("Retiring departed congress member", { bioguideId });
    await processedMemberDao.delete(bioguideId);
    return;
  }

  const summarized = summarizeCongressMemberPayload(rawPayload, {
    senateSeat: await currentSenateSeat(bioguideId, unwrapCongressMember(rawPayload)?.terms),
  });
  if (!summarized) {
    throw new Error(`Unable to summarize congress member payload for bioguideId=${bioguideId}`);
  }

  await processedMemberDao.store(bioguideId, summarized);
};

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  if (!BUCKET_NAME) throw new Error("Missing env var BUCKET_NAME");

  const records = event.Records ?? [];
  if (records.length === 0) {
    return { batchItemFailures: [] };
  }

  const results = await Promise.allSettled(records.map((record) => processRecord(record)));
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === "fulfilled") continue;
    console.error("Failed to process SQS record:", { messageId: records[i].messageId, reason: result.reason });
    batchItemFailures.push({ itemIdentifier: records[i].messageId });
  }

  return { batchItemFailures };
}
