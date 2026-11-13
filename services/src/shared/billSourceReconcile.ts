import { createHash } from "node:crypto";
import { isPreconditionFailure, type BillStorage, type StoredJson } from "../adapters/billStorage";
import type { ProcessedBillDao, ProcessedBillRevision } from "../adapters/processedBillDao";
import type { OfficialChamberVote, OfficialVotesBreakdown, ProcessedBillDocument, RawBill } from "../models/bill";
import { extractActionsFromRawBill } from "./billActions";
import { extractCommitteesFromRawBill } from "./billCommittees";
import { plainBillGuid } from "./billCompanions";
import { deriveBillStatusFromActions } from "./billOutcomes";
import { extractCosponsorIdsFromRawBill, extractSponsorIdsFromRawBill } from "./billSponsors";
import { computeCompleteness, usableOfficialVotes, type VoteChamber } from "./congressVotes";
import { logger } from "./logger";
import { emitEmbeddedMetric } from "./metrics";

// REL-30 / REL-33. billDiffer (and billSummarizer's catch-up) reconcile the processed bill with the
// latest raw bill from stored state only: the decision never depends on which raw version a message
// was sent for, on the raw version before the latest, or on message order. A processed write records
// the raw text it was summarized from (source-text-hash), the raw version its derived fields came
// from (source-raw-version) and that fetch's time (source-fetched-at), and every processed write is
// conditional on the version that was read. A write happens, and moves storedAt, only when a field
// clients can see changes.

type UnknownRecord = Record<string, unknown>;

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : undefined;

const contentOf = (rawBill: RawBill): UnknownRecord | undefined =>
  asRecord((rawBill as unknown as { content?: unknown } | null)?.content);

const toTime = (value: unknown): number | null => {
  const text = toTrimmedString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
};

// ─── Raw bill fields ──────────────────────────────────────────────────────────

/** The raw bill's title: metadata.title, else Congress's title in content.bill. */
export const extractRawBillTitle = (rawBill: RawBill): string => {
  const metaTitle = toTrimmedString(asRecord((rawBill as unknown as { metadata?: unknown } | null)?.metadata)?.title);
  if (metaTitle) return metaTitle;
  const bill = asRecord(contentOf(rawBill)?.bill);
  return toTrimmedString(asRecord(bill?.bill)?.title ?? bill?.title);
};

/** The bill text XML, or "" while Congress has published none. */
export const extractRawBillXml = (rawBill: RawBill): string => {
  const content = contentOf(rawBill);
  return toTrimmedString(content?.billXML ?? content?.billXml ?? content?.bill_xml);
};

/** False for an empty or malformed fetch, which must never wipe processed fields. */
export const hasMeaningfulRawContent = (rawBill: RawBill): boolean => {
  const content = contentOf(rawBill);
  const officialVotes = content?.officialVotes;
  return Boolean(
    extractRawBillTitle(rawBill) ||
    extractRawBillXml(rawBill) ||
    (officialVotes && typeof officialVotes === "object") ||
    extractActionsFromRawBill(rawBill).length > 0 ||
    extractCommitteesFromRawBill(rawBill).length > 0,
  );
};

/** metadata.fetchedAt: when fetchRawBill fetched this copy (enrichOfficialVotes and the REL-31 repair keep it). */
export const rawFetchedAt = (rawBill: RawBill | null | undefined): string | undefined =>
  toTrimmedString(asRecord((rawBill as unknown as { metadata?: unknown } | null)?.metadata)?.fetchedAt) || undefined;

/**
 * When congress.gov last updated the bill, as this copy records it: the later of the bill's `updateDate` and
 * `updateDateIncludingText` (congress.gov's list dates a bill by the later of the two), as an ISO time; undefined
 * when neither is a date. A detail copy can lag the list by days or weeks (REL-56), so this can be older than the
 * update that made the poller fetch it, never newer.
 */
export const rawCongressUpdatedAt = (rawBill: RawBill | null | undefined): string | undefined => {
  const bill = asRecord(rawBill ? contentOf(rawBill)?.bill : undefined);
  const detail = asRecord(bill?.bill) ?? bill;
  const times = [toTime(detail?.updateDate), toTime(detail?.updateDateIncludingText)].filter(
    (time): time is number => time !== null,
  );
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : undefined;
};

/** "v1:" + the SHA-256 (hex) of the title and the bill text: what a summary depends on. */
export const sourceTextHash = (rawBill: RawBill): string =>
  `v1:${createHash("sha256")
    .update(JSON.stringify([extractRawBillTitle(rawBill), extractRawBillXml(rawBill)]))
    .digest("hex")}`;

// ─── Source metadata on processed-bills/<guid>.json ──────────────────────────

/** S3 user metadata names (sent as x-amz-meta-<name>) written by billDiffer and billSummarizer. */
export const SOURCE_METADATA_KEYS = {
  textHash: "source-text-hash",
  rawVersion: "source-raw-version",
  fetchedAt: "source-fetched-at",
} as const;

/** Which raw bill a processed bill was built from. */
export interface ProcessedSource {
  /** sourceTextHash of the raw text the summary was written from. */
  textHash: string;
  /** The raw VersionId the derived fields (actions, votes, sponsors...) came from. */
  rawVersion?: string;
  /** That raw version's metadata.fetchedAt. */
  fetchedAt?: string;
}

// S3 metadata values must be printable ASCII; anything else is left out rather than failing the write.
const isMetadataValue = (value: string | undefined): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value);

/** The source-* metadata a processed write stores. */
export const processedSourceMetadata = (source: ProcessedSource): Record<string, string> => ({
  ...(isMetadataValue(source.textHash) ? { [SOURCE_METADATA_KEYS.textHash]: source.textHash } : {}),
  ...(isMetadataValue(source.rawVersion) ? { [SOURCE_METADATA_KEYS.rawVersion]: source.rawVersion } : {}),
  ...(isMetadataValue(source.fetchedAt) ? { [SOURCE_METADATA_KEYS.fetchedAt]: source.fetchedAt } : {}),
});

/**
 * The processed bill's recorded source, or undefined for a legacy bill (written before REL-30, by an
 * older Lambda, by backfillBillStatus, or restored from an older version): those have no text hash.
 */
export const readProcessedSource = (
  metadata: Record<string, string> | null | undefined,
): ProcessedSource | undefined => {
  const textHash = toTrimmedString(metadata?.[SOURCE_METADATA_KEYS.textHash]);
  if (!textHash) return undefined;
  const rawVersion = toTrimmedString(metadata?.[SOURCE_METADATA_KEYS.rawVersion]);
  const fetchedAt = toTrimmedString(metadata?.[SOURCE_METADATA_KEYS.fetchedAt]);
  return { textHash, ...(rawVersion ? { rawVersion } : {}), ...(fetchedAt ? { fetchedAt } : {}) };
};

// ─── Derived fields ──────────────────────────────────────────────────────────

/**
 * Statuses derived from the actions (billOutcomes.deriveBillStatusFromActions). "Finalized" is derived since REL-44
 * (the bill became law); "Updated" is set by nothing today and is kept as stored.
 */
export const MANAGED_BILL_STATUSES: ReadonlySet<string> = new Set(["", "New", "Passed", "Failed", "Finalized"]);

const CHAMBERS = ["house", "senate"] as const;

const hasMembers = (vote: OfficialChamberVote | undefined): boolean =>
  Array.isArray(vote?.members) && vote.members.length > 0;

const datePart = (value: unknown): string => toTrimmedString(value).slice(0, 10);

// The same roll call: same action code, same day, same counts. A changed tally (a REL-31 fix) is not.
const sameRollCall = (a: OfficialChamberVote, b: OfficialChamberVote): boolean =>
  toTrimmedString(a.actionCode) === toTrimmedString(b.actionCode) &&
  datePart(a.actionDate) === datePart(b.actionDate) &&
  a.yea === b.yea &&
  a.nay === b.nay;

/**
 * The raw bill's votes as the processed bill should show them. Per chamber the raw chamber wins,
 * except that a processed chamber with member votes is kept whole when the raw chamber has none for
 * the same roll call: fetchRawBill rebuilds officialVotes from the actions on every refetch and drops
 * the members enrichOfficialVotes added (REL-35). completeness is recomputed; lastSyncedAt is the raw one.
 * Undefined when the raw bill has no usable votes.
 */
export const mergeOfficialVotes = (
  processed: OfficialVotesBreakdown | undefined,
  raw: OfficialVotesBreakdown | undefined,
): OfficialVotesBreakdown | undefined => {
  if (!raw) return undefined;
  const merged: OfficialVotesBreakdown = { ...raw };
  for (const chamber of CHAMBERS) {
    const rawChamber = raw[chamber];
    const processedChamber = processed?.[chamber];
    if (
      rawChamber &&
      processedChamber &&
      !hasMembers(rawChamber) &&
      hasMembers(processedChamber) &&
      sameRollCall(rawChamber, processedChamber)
    ) {
      merged[chamber] = processedChamber;
    }
  }
  merged.lastSyncedAt = raw.lastSyncedAt;
  merged.completeness = computeCompleteness(merged);
  return merged;
};

/**
 * The processed bill with every field billDiffer maintains taken from the raw bill. A field is
 * replaced only when its raw container is present: actions (content.actions), committees
 * (content.committees), sponsors (content.bill.bill), cosponsors (content.cosponsors). Votes: usable
 * raw votes are merged (mergeOfficialVotes); none, with the actions container present, removes them
 * (the REL-31 repair's delete case); otherwise the processed votes stay. A missing, "", "New",
 * "Passed", "Failed" or "Finalized" billStatus is derived from the resulting actions (REL-37, REL-44).
 */
export const applyDerivedFields = (processed: ProcessedBillDocument, rawBill: RawBill): ProcessedBillDocument => {
  const content = contentOf(rawBill) ?? {};
  const next: ProcessedBillDocument = { ...processed };
  const actionsPresent = asRecord(content.actions) !== undefined;

  if (actionsPresent) next.actions = extractActionsFromRawBill(rawBill);
  if (asRecord(content.committees)) next.committees = extractCommitteesFromRawBill(rawBill);
  if (asRecord(asRecord(content.bill)?.bill)) next.sponsors = extractSponsorIdsFromRawBill(rawBill);
  if (asRecord(content.cosponsors)) next.cosponsors = extractCosponsorIdsFromRawBill(rawBill);

  const rawVotes = usableOfficialVotes(content.officialVotes);
  if (rawVotes) next.officialVotes = mergeOfficialVotes(processed.officialVotes, rawVotes);
  else if (actionsPresent) delete next.officialVotes;

  const status = processed.billStatus as string | null | undefined;
  if (status == null || MANAGED_BILL_STATUSES.has(status)) {
    next.billStatus = deriveBillStatusFromActions(next.actions);
  }
  return next;
};

// ─── What clients can see ────────────────────────────────────────────────────

/** The processed fields billDiffer maintains, in visibleKey order. */
export const VISIBLE_FIELDS = [
  "actions",
  "committees",
  "sponsors",
  "cosponsors",
  "billStatus",
  "officialVotes",
] as const;
export type VisibleField = (typeof VISIBLE_FIELDS)[number];

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const record = asRecord(value);
  if (!record) return value;
  const out: UnknownRecord = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) out[key] = sortKeysDeep(record[key]);
  }
  return out;
};

/** JSON with object keys sorted and undefined members dropped; arrays keep their order. */
export const stableStringify = (value: unknown): string => JSON.stringify(sortKeysDeep(value)) ?? "null";

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// lastSyncedAt moves on every fetch and completeness follows from the rest, so neither counts;
// member order is not meaningful.
export const visibleVotes = (votes: unknown): unknown => {
  const record = asRecord(votes);
  if (!record) return null;
  const rest: UnknownRecord = { ...record };
  delete rest.lastSyncedAt;
  delete rest.completeness;
  for (const chamber of CHAMBERS) {
    const vote = asRecord(rest[chamber]);
    if (vote && Array.isArray(vote.members)) {
      rest[chamber] = {
        ...vote,
        members: [...vote.members].sort(
          (a, b) =>
            compareStrings(toTrimmedString(asRecord(a)?.bioguideId), toTrimmedString(asRecord(b)?.bioguideId)) ||
            compareStrings(stableStringify(a), stableStringify(b)),
        ),
      };
    }
  }
  return rest;
};

const visibleParts = (doc: ProcessedBillDocument): Record<VisibleField, unknown> => ({
  actions: doc.actions ?? [],
  committees: doc.committees ?? [],
  sponsors: doc.sponsors ?? [],
  cosponsors: doc.cosponsors ?? [],
  billStatus: doc.billStatus ?? "",
  officialVotes: visibleVotes(doc.officialVotes),
});

/**
 * A stable string of what clients can see of the maintained fields: actions, committees, sponsors,
 * cosponsors, billStatus and officialVotes (without lastSyncedAt and completeness, members sorted by
 * bioguideId). Object keys are sorted; arrays of actions, committees and ids keep their order.
 */
export const visibleKey = (doc: ProcessedBillDocument): string => stableStringify(visibleParts(doc));

/** The maintained fields whose visible value differs. */
export const changedVisibleFields = (before: ProcessedBillDocument, after: ProcessedBillDocument): VisibleField[] => {
  const a = visibleParts(before);
  const b = visibleParts(after);
  return VISIBLE_FIELDS.filter((field) => stableStringify(a[field]) !== stableStringify(b[field]));
};

/** applyDerivedFields and the fields it changed, or null when nothing clients can see changes. */
export const derivedPatch = (
  processed: ProcessedBillDocument,
  rawBill: RawBill,
): { next: ProcessedBillDocument; changedFields: VisibleField[] } | null => {
  const next = applyDerivedFields(processed, rawBill);
  if (visibleKey(next) === visibleKey(processed)) return null;
  return { next, changedFields: changedVisibleFields(processed, next) };
};

// ─── REL-35: member votes across a refetch (fetchRawBill) ────────────────────

/** What the carry rule did with one chamber. */
export type MemberVoteCarryOutcome =
  /** The previous chamber, members included, replaced the fetched one: same roll call, fetched without members. */
  | "carried"
  /** The previous members are for another roll call (action code, day or tally differ); the fetched chamber stays. */
  | "new_roll_call"
  /** The fetched chamber already has members; it stays. */
  | "fetched_members"
  /** The previous chamber had no members, or there was no previous chamber; the fetched chamber stays. */
  | "no_previous_members"
  /** The previous raw bill had this chamber's vote and the fetch has none; nothing is carried. */
  | "no_fetched_vote";

/** A chamber vote's roll-call identity and member count, as the carry decision logs it. */
export interface RollCallSummary {
  actionCode?: string;
  actionDate?: string;
  yea: number;
  nay: number;
  members: number;
}

export interface MemberVoteCarryChamber {
  outcome: MemberVoteCarryOutcome;
  previous?: RollCallSummary;
  fetched?: RollCallSummary;
}

export interface MemberVoteCarryDecision {
  /**
   * The votes to store: the fetched votes with each carried chamber replaced by the previous one,
   * completeness recomputed, and lastSyncedAt per lastSyncedAtKept. Undefined when the fetch has no votes.
   */
  votes: OfficialVotesBreakdown | undefined;
  /** The chambers whose previous member votes were kept, in house, senate order. */
  carried: VoteChamber[];
  /** One entry per chamber present in the previous or the fetched votes. */
  chambers: Partial<Record<VoteChamber, MemberVoteCarryChamber>>;
  /** True when `votes` keeps the previous lastSyncedAt because nothing visible changed. */
  lastSyncedAtKept: boolean;
  /** True when the previous raw bill had member votes in at least one chamber. */
  previousHadMembers: boolean;
}

const rollCallSummary = (vote: OfficialChamberVote): RollCallSummary => ({
  ...(toTrimmedString(vote.actionCode) ? { actionCode: toTrimmedString(vote.actionCode) } : {}),
  ...(datePart(vote.actionDate) ? { actionDate: datePart(vote.actionDate) } : {}),
  yea: vote.yea,
  nay: vote.nay,
  members: Array.isArray(vote.members) ? vote.members.length : 0,
});

/**
 * REL-35, the decision behind carryForwardOfficialVotes. fetchRawBill rebuilds officialVotes from the
 * actions on every fetch, so a refetch would drop the member votes enrichOfficialVotes added. Per
 * chamber: when the fetched chamber has no members, the previous chamber has members and both are the
 * same roll call (action code, day, yea, nay: the rule mergeOfficialVotes applies to processed bills),
 * the previous chamber is kept whole (members, memberDataAvailable and the tallies enrichment wrote),
 * so the stored chamber, and the processed bill billDiffer builds from it, do not change. completeness
 * is recomputed. lastSyncedAt keeps the previous value when the visible votes (visibleVotes: without
 * lastSyncedAt and completeness, members in bioguideId order) are unchanged, else it is the fetched one.
 * Pure: neither argument is modified. A previous value that is not usable stored votes
 * (usableOfficialVotes) counts as none.
 */
export const decideMemberVoteCarry = (
  previous: OfficialVotesBreakdown | undefined,
  fetched: OfficialVotesBreakdown | undefined,
): MemberVoteCarryDecision => {
  const prior = usableOfficialVotes(previous);
  const chambers: Partial<Record<VoteChamber, MemberVoteCarryChamber>> = {};
  const carried: VoteChamber[] = [];
  const previousHadMembers = CHAMBERS.some((chamber) => hasMembers(prior?.[chamber]));
  const votes: OfficialVotesBreakdown | undefined = fetched ? { ...fetched } : undefined;

  for (const chamber of CHAMBERS) {
    const before = prior?.[chamber];
    const after = fetched?.[chamber];
    if (!before && !after) continue;
    const summaries = {
      ...(before ? { previous: rollCallSummary(before) } : {}),
      ...(after ? { fetched: rollCallSummary(after) } : {}),
    };
    let outcome: MemberVoteCarryOutcome;
    if (!after) outcome = hasMembers(before) ? "no_fetched_vote" : "no_previous_members";
    else if (hasMembers(after)) outcome = "fetched_members";
    else if (!before || !hasMembers(before)) outcome = "no_previous_members";
    else if (!sameRollCall(before, after)) outcome = "new_roll_call";
    else outcome = "carried";
    if (outcome === "carried" && votes && before) {
      votes[chamber] = before;
      carried.push(chamber);
    }
    chambers[chamber] = { outcome, ...summaries };
  }

  let lastSyncedAtKept = false;
  if (votes) {
    votes.completeness = computeCompleteness(votes);
    lastSyncedAtKept = Boolean(prior && stableStringify(visibleVotes(prior)) === stableStringify(visibleVotes(votes)));
    votes.lastSyncedAt = lastSyncedAtKept && prior ? prior.lastSyncedAt : fetched!.lastSyncedAt;
  }
  return { votes, carried, chambers, lastSyncedAtKept, previousHadMembers };
};

/**
 * REL-35: the votes fetchRawBill stores for a refetch, given the previous raw bill's officialVotes and
 * the votes just built from the actions. See decideMemberVoteCarry for the rule.
 */
export const carryForwardOfficialVotes = (
  previous: OfficialVotesBreakdown | undefined,
  next: OfficialVotesBreakdown | undefined,
): OfficialVotesBreakdown | undefined => decideMemberVoteCarry(previous, next).votes;

// ─── Legacy processed bills ──────────────────────────────────────────────────

export const LEGACY_ANCHOR_MAX_GETS = 3;

type AnchorStorage = Pick<BillStorage, "listObjectVersionsForKey" | "getJsonObjectWithVersionId">;

/**
 * For a processed bill without source metadata: the text hash of the raw version it was most likely
 * summarized from. Lists the raw key's versions and drops delete markers and anything newer than the
 * current version; the current version itself counts only when the processed bill was written at or
 * after it (the old pipeline's normal text change: the summary was built from it). Tries the versions
 * written at or before the processed bill's LastModified (newest first), then later ones (oldest
 * first); reads at most 3 (the current version from `raw.value` when given). The first meaningful
 * version gives the hash. Null when none does, which means the text counts as unchanged. Raw versions
 * older than the current one are kept 7 days, so a legacy bill written before its current raw version
 * usually gets null.
 *
 * LastModified is the processed bill's last write, not when it was summarized: a text change the old
 * billDiffer missed and then wrote over (its votes patch after an enrichment write, REL-30) anchors
 * on the new text and is not found.
 */
export const legacyAnchorHash = async (
  storage: AnchorStorage,
  key: string,
  raw: Pick<StoredJson<RawBill>, "versionId" | "lastModified"> & { value?: RawBill | null },
  processedLastModified: string | undefined,
): Promise<string | null> => {
  const versions = (await storage.listObjectVersionsForKey(key)).filter((version) => !version.isDeleteMarker);
  const current = raw.versionId ? versions.find((version) => version.versionId === raw.versionId) : undefined;
  const currentTime = toTime(current?.lastModified ?? raw.lastModified);
  const processedTime = toTime(processedLastModified);
  const candidates = versions.filter((version) => {
    const time = toTime(version.lastModified);
    if (raw.versionId && version.versionId === raw.versionId) {
      return processedTime !== null && time !== null && time <= processedTime;
    }
    return currentTime === null || time === null || time <= currentTime;
  });

  const timeOf = (version: { lastModified?: string }): number => toTime(version.lastModified) ?? 0;
  const atOrBefore = candidates
    .filter((version) => {
      const time = toTime(version.lastModified);
      return processedTime === null || (time !== null && time <= processedTime);
    })
    .sort((a, b) => timeOf(b) - timeOf(a));
  const later = candidates.filter((version) => !atOrBefore.includes(version)).sort((a, b) => timeOf(a) - timeOf(b));

  for (const version of [...atOrBefore, ...later].slice(0, LEGACY_ANCHOR_MAX_GETS)) {
    const value =
      raw.value && version.versionId === raw.versionId
        ? raw.value
        : (await storage.getJsonObjectWithVersionId<RawBill>(key, version.versionId)).value;
    if (value && hasMeaningfulRawContent(value)) return sourceTextHash(value);
  }
  return null;
};

/** True when planReconcile needs legacyAnchorHash: a processed bill without source metadata and a usable raw bill. */
export const needsLegacyAnchor = (processed: ProcessedBillRevision | null, raw: StoredJson<RawBill>): boolean =>
  Boolean(processed && !readProcessedSource(processed.metadata) && raw.value && hasMeaningfulRawContent(raw.value));

// ─── The plan ────────────────────────────────────────────────────────────────

export type ReconcilePlanKind =
  | "unchanged"
  | "patch"
  | "summarize_missing"
  | "summarize_text_changed"
  | "awaiting_text"
  | "stale_raw"
  | "skipped";

/** How the text comparison was decided: recorded hash, legacy anchor, or assumed unchanged (no anchor found). */
export type DecidedBy = "source-hash" | "legacy-anchor" | "assumed";

export interface ReconcilePlan {
  kind: ReconcilePlanKind;
  /** no_raw, no_meaningful_content, no_text, no_processed, same_raw_version, older_fetch, text_changed, no_visible_change, derived_fields_changed */
  reason: string;
  /** The guid to send on: the raw bill's metadata.guid, else its guid, else the message guid; without a text-version suffix. */
  guid: string;
  decidedBy?: DecidedBy;
  /** sourceTextHash of the latest raw bill. */
  textHash?: string;
  /** The hash the processed summary was built from (recorded, anchored or assumed). */
  baseHash?: string;
  changedFields: VisibleField[];
  /**
   * The document to store (storedAt is now): a patch, or summarize_text_changed when the derived fields
   * changed too (the pre-summary patch, written before the summary is sent).
   */
  next?: ProcessedBillDocument;
  /** The source metadata to store with `next`; its textHash stays the old base hash. */
  source?: ProcessedSource;
}

export interface PlanReconcileInput {
  /** The processed bill, read before the raw bill. */
  processed: ProcessedBillRevision | null;
  /** The latest raw bill. */
  raw: StoredJson<RawBill>;
  /** The guid the message named (fallback when the raw bill names none). */
  messageGuid: string;
  /** legacyAnchorHash's result for a legacy processed bill; undefined when it was not looked up. */
  anchorHash?: string | null;
  now?: Date;
}

/** The pure decision of section 1 (REL-30): what to do with this processed bill and this raw bill. */
export const planReconcile = ({
  processed,
  raw,
  messageGuid,
  anchorHash,
  now = new Date(),
}: PlanReconcileInput): ReconcilePlan => {
  const rawBill = raw.value;
  const plan = (kind: ReconcilePlanKind, reason: string, extra: Partial<ReconcilePlan> = {}): ReconcilePlan => ({
    kind,
    reason,
    guid,
    changedFields: [],
    ...extra,
  });
  const rawRecord = rawBill as unknown as { metadata?: unknown; guid?: unknown } | null;
  const sourceGuid =
    toTrimmedString(asRecord(rawRecord?.metadata)?.guid) || toTrimmedString(rawRecord?.guid) || messageGuid;
  // Raw bills fetched before the guid was canonical keep a text-version suffix (BILLS-119hr1181rh).
  const guid = plainBillGuid(sourceGuid) ?? sourceGuid;

  if (!rawBill) return plan("skipped", "no_raw");
  if (!hasMeaningfulRawContent(rawBill)) return plan("skipped", "no_meaningful_content");

  const textHash = sourceTextHash(rawBill);
  const hasText = extractRawBillXml(rawBill) !== "";
  if (!processed) {
    return hasText
      ? plan("summarize_missing", "no_processed", { textHash })
      : plan("awaiting_text", "no_text", { textHash });
  }

  const source = readProcessedSource(processed.metadata);
  if (source?.rawVersion && raw.versionId && source.rawVersion === raw.versionId) {
    // A pre-summary patch (below) records this raw version while its text still waits for a summary.
    if (hasText && source.textHash !== textHash) {
      return plan("summarize_text_changed", "text_changed", {
        textHash,
        baseHash: source.textHash,
        decidedBy: "source-hash",
      });
    }
    return plan("unchanged", "same_raw_version", { textHash, baseHash: source.textHash, decidedBy: "source-hash" });
  }
  const rawFetched = toTime(rawFetchedAt(rawBill));
  const sourceFetched = toTime(source?.fetchedAt);
  if (rawFetched !== null && sourceFetched !== null && rawFetched < sourceFetched) {
    return plan("stale_raw", "older_fetch", { textHash, baseHash: source?.textHash, decidedBy: "source-hash" });
  }

  const decidedBy: DecidedBy = source ? "source-hash" : anchorHash ? "legacy-anchor" : "assumed";
  const baseHash = source?.textHash ?? anchorHash ?? textHash;
  const patch = derivedPatch(processed.bill, rawBill);
  // The patch keeps the hash the summary was written from, so a text change stays pending.
  const patchFields = (): Partial<ReconcilePlan> =>
    patch
      ? {
          changedFields: patch.changedFields,
          next: { ...patch.next, storedAt: now.toISOString() },
          source: {
            textHash: baseHash,
            ...(raw.versionId ? { rawVersion: raw.versionId } : {}),
            ...(rawFetchedAt(rawBill) ? { fetchedAt: rawFetchedAt(rawBill) } : {}),
          },
        }
      : {};
  if (hasText && baseHash !== textHash) {
    // The derived fields are patched before the summary is sent, so actions, votes and billStatus
    // land even while the new text's summary keeps failing.
    return plan("summarize_text_changed", "text_changed", { textHash, baseHash, decidedBy, ...patchFields() });
  }
  if (!patch) return plan("unchanged", "no_visible_change", { textHash, baseHash, decidedBy });
  return plan("patch", "derived_fields_changed", { textHash, baseHash, decidedBy, ...patchFields() });
};

/** Plans that need a write or a summary (what the one-time reconcile sends to BillDifferQueue). */
export const isActionablePlan = (kind: ReconcilePlanKind): boolean =>
  kind === "patch" || kind === "summarize_missing" || kind === "summarize_text_changed";

// ─── The loop ────────────────────────────────────────────────────────────────

export const BILL_INGESTION_METRIC_NAMESPACE = "BillBoard/BillIngestion";
export const RECONCILE_MAX_ATTEMPTS = 3;

export type ReconcileOutcome =
  | "enqueued"
  | "patched"
  | "unchanged"
  | "skipped"
  | "awaiting_text"
  | "stale_raw"
  | "superseded";

/** The BillSummarizerQueue message billDiffer sends: rawVersionId marks the work as billDiffer's. */
export interface SummarizerMessage {
  guid: string;
  rawVersionId?: string;
}

export interface ReconcileRequest {
  /** raw-bills/<guid>.json */
  key: string;
  /** The guid the message named; the processed bill is read by it. */
  messageGuid: string;
  correlationId?: string;
  /** "differ" sends summaries and syncs companion links; "summarizer" (the catch-up) only patches. */
  mode: "differ" | "summarizer";
}

export interface ReconcileDeps {
  storage: Pick<BillStorage, "getJsonObject" | "listObjectVersionsForKey" | "getJsonObjectWithVersionId">;
  processedDao: Pick<ProcessedBillDao, "getRevisionByGuid" | "store">;
  /** differ mode: sends the message to BillSummarizerQueue; throws when it could not. */
  sendToSummarizer?: (message: SummarizerMessage, correlationId?: string) => Promise<void>;
  /** differ mode: the APPF-23 link-list sync; a DynamoDB error throws and fails the record. */
  syncCompanionDeclaration?: (rawBill: RawBill, key: string) => Promise<unknown>;
  now?: () => Date;
}

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  plan: ReconcilePlan;
  attempts: number;
}

const countMetric = (name: string): void => emitEmbeddedMetric(BILL_INGESTION_METRIC_NAMESPACE, name, 1);

/**
 * Reads the processed bill, then the latest raw bill, and acts on planReconcile, up to 3 attempts.
 * Reading the processed bill first means any processed write after that read fails this attempt's
 * conditional write, and the raw bill read after it is never older than the one the processed bill
 * was built from (apart from two racing fetches, which stale_raw covers). A refused write (412/409)
 * is counted as BillDifferWriteConflict and retried from the reads; after 3 attempts it throws, so
 * SQS retries the record. In differ mode the companion link list is synced right after the raw read
 * on every attempt, before any send or write.
 */
export const reconcileProcessedBill = async (
  request: ReconcileRequest,
  deps: ReconcileDeps,
): Promise<ReconcileResult> => {
  const now = deps.now ?? (() => new Date());
  const differ = request.mode === "differ";

  for (let attempt = 1; ; attempt += 1) {
    const processed = await deps.processedDao.getRevisionByGuid(request.messageGuid);
    const raw = await deps.storage.getJsonObject<RawBill>(request.key);
    if (!raw.value) {
      logger.warn("Skipping raw bill; could not load current", { key: request.key });
      return {
        outcome: "skipped",
        plan: planReconcile({ processed, raw, messageGuid: request.messageGuid }),
        attempts: attempt,
      };
    }

    // APPF-23: before any send or write, so a DynamoDB failure retries the record with nothing sent yet.
    if (differ && deps.syncCompanionDeclaration) await deps.syncCompanionDeclaration(raw.value, request.key);

    let anchorHash: string | null | undefined;
    if (needsLegacyAnchor(processed, raw)) {
      anchorHash = await legacyAnchorHash(deps.storage, request.key, raw, processed?.lastModified);
      if (differ) countMetric("BillDifferLegacyAnchor");
    }

    const plan = planReconcile({ processed, raw, messageGuid: request.messageGuid, anchorHash, now: now() });

    /** Stores plan.next over the processed version read; false when the write was refused (retry from the reads). */
    const writePatch = async (): Promise<boolean> => {
      try {
        await deps.processedDao.store(plan.next!, {
          correlationId: request.correlationId,
          source: plan.source,
          ...(processed?.etag ? { ifMatch: processed.etag } : { ifNoneMatch: "*" }),
        });
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
        countMetric("BillDifferWriteConflict");
        logger.warn("Processed bill changed during the reconcile", {
          key: request.key,
          attempt,
          maxAttempts: RECONCILE_MAX_ATTEMPTS,
        });
        if (attempt >= RECONCILE_MAX_ATTEMPTS) {
          throw new Error(`Processed bill for ${request.key} kept changing (${attempt} conditional writes refused)`, {
            cause: error,
          });
        }
        return false;
      }
      if (differ) countMetric("BillDifferPatched");
      return true;
    };

    switch (plan.kind) {
      case "skipped":
      case "awaiting_text":
      case "unchanged":
        return { outcome: plan.kind, plan, attempts: attempt };
      case "stale_raw":
        if (differ) countMetric("BillDifferStaleRaw");
        return { outcome: "stale_raw", plan, attempts: attempt };
      case "summarize_missing":
      case "summarize_text_changed": {
        // The catch-up never summarizes: the raw bill moved on, and its own BillDiffer message does.
        if (!differ || !deps.sendToSummarizer) return { outcome: "superseded", plan, attempts: attempt };
        // The pre-summary patch: written first, so a summary that keeps failing does not hold back the
        // actions, votes and billStatus, and a failed send is retried from a state that still plans it.
        if (plan.next && !(await writePatch())) continue;
        await deps.sendToSummarizer(
          { guid: plan.guid, ...(raw.versionId ? { rawVersionId: raw.versionId } : {}) },
          request.correlationId,
        );
        countMetric("BillDifferEnqueued");
        return { outcome: "enqueued", plan, attempts: attempt };
      }
      case "patch":
        if (!(await writePatch())) continue;
        return { outcome: "patched", plan, attempts: attempt };
    }
  }
};
