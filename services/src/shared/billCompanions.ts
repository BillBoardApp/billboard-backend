import type { CompanionGroupV1 } from "../contracts";

/**
 * Companion bills (APPF-23): a House bill and a Senate bill that Congress.gov (CRS) lists as
 * "Identical bill" of each other are shown and counted as one group. Everything here is pure; the
 * DynamoDB side (link lists and the published CURRENT groups) is adapters/billCompanionDao.ts.
 *
 * A link is an item of a raw bill's content.relatedBills.relatedBills that some
 * relationshipDetails[].type calls identical (IDENTICAL_RELATIONSHIP_RE), in the bill's own
 * Congress, of one of the eight bill types. A group forms from a House/Senate counterpart edge
 * declared by either side, only when that edge is its whole connected part of the graph (each
 * bill has exactly one candidate, counting bills we do not hold) and both bills are held. The
 * House member is always the primary. Groups therefore have 2 members; the contract allows more.
 */

export type BillTypeCode = "hr" | "s" | "hjres" | "sjres" | "hconres" | "sconres" | "hres" | "sres";

export const BILL_TYPE_CODES: readonly BillTypeCode[] = [
  "hr",
  "s",
  "hjres",
  "sjres",
  "hconres",
  "sconres",
  "hres",
  "sres",
];

/** The other chamber's bill of the same kind. */
export const COUNTERPART: Readonly<Record<BillTypeCode, BillTypeCode>> = {
  hr: "s",
  s: "hr",
  hjres: "sjres",
  sjres: "hjres",
  hconres: "sconres",
  sconres: "hconres",
  hres: "sres",
  sres: "hres",
};

/** Matches "Identical bill" and "Identical Bill (Became Law)". */
export const IDENTICAL_RELATIONSHIP_RE = /^identical bill/i;

/** CompanionGroupV1.relationship for groups built from identical-bill links. */
export const COMPANION_RELATIONSHIP_IDENTICAL = "identical";

/** Prefix of the stats document that combines a group's votes. */
export const COMPANION_STATS_KEY_PREFIX = "COMPANIONS#";

const BILL_TYPE_CODE_SET: ReadonlySet<string> = new Set(BILL_TYPE_CODES);

const SLUG_TO_CODE: Readonly<Record<string, BillTypeCode>> = {
  "house-bill": "hr",
  "senate-bill": "s",
  "house-joint-resolution": "hjres",
  "senate-joint-resolution": "sjres",
  "house-concurrent-resolution": "hconres",
  "senate-concurrent-resolution": "sconres",
  "house-resolution": "hres",
  "senate-resolution": "sres",
};

// Longer codes first, so "hres" is not read as "hr" + "es". Group 4 is the text-version suffix.
const GUID_BODY_RE = /^(\d+)(hconres|hjres|hres|hr|sconres|sjres|sres|s)(\d+)([a-z]*)$/;
const GUID_PREFIX = "BILLS-";
// Real guids are about 20 characters (processedBillKeys caps request guids at 64).
const MAX_GUID_LENGTH = 64;
const DIGITS_RE = /^\d+$/;

/** A bill type as a lowercase code: accepts codes in any case ("HR", "hjres", "H.R.") and slugs ("house-bill"). */
export const normalizeBillTypeCode = (value: unknown): BillTypeCode | null => {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  if (!lowered) return null;
  if (BILL_TYPE_CODE_SET.has(lowered)) return lowered as BillTypeCode;
  const fromSlug = SLUG_TO_CODE[lowered];
  if (fromSlug) return fromSlug;
  const compact = lowered.replace(/[.\s]/g, "");
  return BILL_TYPE_CODE_SET.has(compact) ? (compact as BillTypeCode) : null;
};

export interface ParsedBillGuid {
  congress: string;
  billType: BillTypeCode;
  billNumber: string;
  /** BILLS-<congress><code><number>, without the text-version suffix. */
  plainGuid: string;
  /** The text-version suffix ("ih", "enr", ...), or "". */
  suffix: string;
}

const buildPlainGuid = (congress: string, billType: BillTypeCode, billNumber: string): string =>
  `${GUID_PREFIX}${congress}${billType}${billNumber}`;

/** Parses BILLS-<congress><type><number>[suffix] (the part after "BILLS-" in any case), or null. */
export const parseBillGuid = (guid: unknown): ParsedBillGuid | null => {
  if (typeof guid !== "string") return null;
  const trimmed = guid.trim();
  if (trimmed.length > MAX_GUID_LENGTH || !trimmed.startsWith(GUID_PREFIX)) return null;
  const match = GUID_BODY_RE.exec(trimmed.slice(GUID_PREFIX.length).toLowerCase());
  if (!match) return null;
  const [, congress, billType, billNumber, suffix] = match;
  const code = billType as BillTypeCode;
  return { congress, billType: code, billNumber, plainGuid: buildPlainGuid(congress, code, billNumber), suffix };
};

/** The guid without its text-version suffix, or null when it is not a bill guid. */
export const plainBillGuid = (guid: unknown): string | null => parseBillGuid(guid)?.plainGuid ?? null;

export const chamberOf = (billType: BillTypeCode): "House" | "Senate" =>
  billType.startsWith("h") ? "House" : "Senate";

// ─── Link lists ───────────────────────────────────────────────────────────────

export interface CompanionBillRef {
  /** Plain guid. */
  guid: string;
  congress: string;
  billType: BillTypeCode;
  billNumber: string;
}

/** One bill's identical-bill links, as extracted from its raw bill (stored as a link-list row). */
export interface CompanionDeclaration extends CompanionBillRef {
  /**
   * Every same-Congress identical link, of any chamber or kind (the counterpart filter applies only
   * when resolving), without the bill itself or duplicates, sorted by guid. May be empty.
   */
  declared: CompanionBillRef[];
  /** The stored relatedbills response still had pagination.next, so the list may be incomplete. */
  truncated: boolean;
  /** metadata.fetchedAt, else storedAt, of the raw bill (the freshness key of the stored row). */
  sourceFetchedAt: string;
}

type LooseRecord = Record<string, unknown>;

const asRecord = (value: unknown): LooseRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : undefined;

const toDigits = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return DIGITS_RE.test(text) ? text : null;
};

const toBillRef = (congress: unknown, billType: unknown, billNumber: unknown): CompanionBillRef | null => {
  const congressText = toDigits(congress);
  const code = normalizeBillTypeCode(billType);
  const numberText = toDigits(billNumber);
  if (!congressText || !code || !numberText) return null;
  return {
    guid: buildPlainGuid(congressText, code, numberText),
    congress: congressText,
    billType: code,
    billNumber: numberText,
  };
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * The bill's own identity: from the S3 key raw-bills/<guid>.json, else content.bill(.bill)
 * congress/type/number, else identifier. Never from metadata.guid, which often carries a suffix.
 */
const rawBillIdentity = (raw: LooseRecord, s3Key?: string): CompanionBillRef | null => {
  if (typeof s3Key === "string") {
    const baseName = s3Key.trim().split("/").pop() ?? "";
    const parsed = parseBillGuid(baseName.replace(/\.json$/i, ""));
    if (parsed) {
      return {
        guid: parsed.plainGuid,
        congress: parsed.congress,
        billType: parsed.billType,
        billNumber: parsed.billNumber,
      };
    }
  }
  const content = asRecord(raw.content);
  const billPayload = asRecord(content?.bill);
  const bill = asRecord(billPayload?.bill) ?? billPayload;
  const fromContent = bill ? toBillRef(bill.congress, bill.type, bill.number) : null;
  if (fromContent) return fromContent;
  const identifier = asRecord(raw.identifier);
  return identifier ? toBillRef(identifier.congress, identifier.billType, identifier.billNumber) : null;
};

const hasIdenticalRelationship = (item: LooseRecord): boolean =>
  Array.isArray(item.relationshipDetails) &&
  item.relationshipDetails.some((detail) => {
    const type = asRecord(detail)?.type;
    return typeof type === "string" && IDENTICAL_RELATIONSHIP_RE.test(type.trim());
  });

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The bill's identical-bill links from a raw bill document, or null when the bill's own identity
 * cannot be resolved. Excluded: other relationship types, other Congresses, unknown types and the
 * bill itself; `identifiedBy` is ignored. A raw bill without related bills gives `declared: []`.
 */
export const extractIdenticalDeclarations = (raw: unknown, s3Key?: string): CompanionDeclaration | null => {
  const document = asRecord(raw);
  if (!document) return null;
  const self = rawBillIdentity(document, s3Key);
  if (!self) return null;

  const relatedBills = asRecord(asRecord(document.content)?.relatedBills);
  const items = Array.isArray(relatedBills?.relatedBills) ? relatedBills.relatedBills : [];
  const declared = new Map<string, CompanionBillRef>();
  for (const entry of items) {
    const item = asRecord(entry);
    if (!item || !hasIdenticalRelationship(item)) continue;
    const ref = toBillRef(item.congress, item.type, item.number);
    if (!ref || ref.congress !== self.congress || ref.guid === self.guid) continue;
    declared.set(ref.guid, ref);
  }

  const pagination = asRecord(relatedBills?.pagination);
  const metadata = asRecord(document.metadata);
  return {
    ...self,
    declared: [...declared.values()].sort((a, b) => compareStrings(a.guid, b.guid)),
    truncated: typeof pagination?.next === "string" && pagination.next.trim().length > 0,
    sourceFetchedAt: nonEmptyString(metadata?.fetchedAt) ?? nonEmptyString(document.storedAt) ?? "",
  };
};

/** Same links and truncation flag (the identity and sourceFetchedAt are not compared). */
export const sameDeclaredLinks = (
  a: Pick<CompanionDeclaration, "declared" | "truncated">,
  b: Pick<CompanionDeclaration, "declared" | "truncated">,
): boolean =>
  a.truncated === b.truncated &&
  a.declared.length === b.declared.length &&
  a.declared.every((ref, index) => ref.guid === b.declared[index].guid);

// ─── Resolution ───────────────────────────────────────────────────────────────

/** [primary (House) guid, other guid]. */
export type CompanionPair = [string, string];

export interface CompanionLinkCounts {
  /** Links (one per declaring bill and target) that are House/Senate counterparts: graph edges. */
  counterpart: number;
  sameChamber: number;
  crossKind: number;
  crossCongress: number;
}

export interface CompanionCandidateGraph {
  /** guid -> its candidates (neighbours through counterpart links from either side), held or not. */
  candidates: Map<string, Set<string>>;
  /** Whether `from` itself lists `to` as identical (a counterpart link). */
  declares(from: string, to: string): boolean;
  links: CompanionLinkCounts;
}

const linkKey = (from: string, to: string): string => `${from}|${to}`;

/**
 * The undirected counterpart graph of the declarations: an edge {D, T} for every link D declares
 * to T when T is D's counterpart type, whichever side declared it. Other links are only counted.
 */
export const companionCandidateGraph = (declarations: readonly CompanionDeclaration[]): CompanionCandidateGraph => {
  const candidates = new Map<string, Set<string>>();
  const declaredLinks = new Set<string>();
  const links: CompanionLinkCounts = { counterpart: 0, sameChamber: 0, crossKind: 0, crossCongress: 0 };
  const addCandidate = (from: string, to: string) => {
    const set = candidates.get(from);
    if (set) set.add(to);
    else candidates.set(from, new Set([to]));
  };

  for (const declaration of declarations) {
    const declaringType = normalizeBillTypeCode(declaration.billType);
    if (!declaringType) continue;
    for (const target of declaration.declared) {
      if (target.guid === declaration.guid) continue;
      const targetType = normalizeBillTypeCode(target.billType);
      if (!targetType) continue;
      if (String(target.congress) !== String(declaration.congress)) {
        links.crossCongress += 1;
      } else if (COUNTERPART[declaringType] === targetType) {
        links.counterpart += 1;
        declaredLinks.add(linkKey(declaration.guid, target.guid));
        addCandidate(declaration.guid, target.guid);
        addCandidate(target.guid, declaration.guid);
      } else if (chamberOf(declaringType) === chamberOf(targetType)) {
        links.sameChamber += 1;
      } else {
        links.crossKind += 1;
      }
    }
  }

  return { candidates, declares: (from, to) => declaredLinks.has(linkKey(from, to)), links };
};

export interface CompanionResolution {
  /** [primary, other] pairs, sorted by primary guid. */
  pairs: CompanionPair[];
  /** Held bills with more than one candidate (left separate), sorted. */
  ambiguous: string[];
  /** Groups where only one side lists the other. */
  oneSided: number;
  excluded: {
    sameChamber: number;
    crossKind: number;
    crossCongress: number;
    /** One-edge parts of the graph where exactly one bill is held (no group). */
    partnerNotHeld: number;
  };
}

const houseFirst = (a: string, b: string): CompanionPair => {
  const aType = parseBillGuid(a)?.billType;
  return aType && chamberOf(aType) === "House" ? [a, b] : [b, a];
};

/**
 * Pairs the declarations (pure; the result does not depend on their order). X and Y form a group
 * only when each is the other's only candidate and both are held. Chains, hubs and 2-to-1 links
 * stay separate.
 */
export const resolveCompanionGroups = (
  declarations: readonly CompanionDeclaration[],
  isHeld: (plainGuid: string) => boolean,
): CompanionResolution => {
  const graph = companionCandidateGraph(declarations);
  const pairs: CompanionPair[] = [];
  const ambiguous: string[] = [];
  let oneSided = 0;
  let partnerNotHeld = 0;

  for (const [guid, candidates] of graph.candidates) {
    if (candidates.size > 1) {
      if (isHeld(guid)) ambiguous.push(guid);
      continue;
    }
    const [other] = candidates;
    // Each edge once, from its smaller guid.
    if (!(guid < other) || graph.candidates.get(other)?.size !== 1) continue;
    const guidHeld = isHeld(guid);
    const otherHeld = isHeld(other);
    if (!guidHeld || !otherHeld) {
      if (guidHeld || otherHeld) partnerNotHeld += 1;
      continue;
    }
    pairs.push(houseFirst(guid, other));
    if (!graph.declares(guid, other) || !graph.declares(other, guid)) oneSided += 1;
  }

  pairs.sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  ambiguous.sort(compareStrings);
  return {
    pairs,
    ambiguous,
    oneSided,
    excluded: {
      sameChamber: graph.links.sameChamber,
      crossKind: graph.links.crossKind,
      crossCongress: graph.links.crossCongress,
      partnerNotHeld,
    },
  };
};

// ─── Using the groups ─────────────────────────────────────────────────────────

/** The contract shape of a pair: primary (House) first, then the other members in guid order. */
export const toCompanionGroupV1 = (pair: readonly [string, string]): CompanionGroupV1 => {
  const [primaryGuid, other] = houseFirst(pair[0], pair[1]);
  return { primaryGuid, memberGuids: [primaryGuid, other], relationship: COMPANION_RELATIONSHIP_IDENTICAL };
};

/** The contract list for a response: one group per pair, sorted by primaryGuid. */
export const companionGroupsFromPairs = (pairs: readonly (readonly [string, string])[]): CompanionGroupV1[] =>
  pairs.map(toCompanionGroupV1).sort((a, b) => compareStrings(a.primaryGuid, b.primaryGuid));

/** plain guid -> its group; both members map to the same object. */
export type CompanionIndex = Map<string, CompanionGroupV1>;

/** Indexes the pairs by every member's plain guid. A guid already in an earlier pair is not indexed again. */
export const companionIndex = (pairs: readonly (readonly [string, string])[]): CompanionIndex => {
  const index: CompanionIndex = new Map();
  for (const pair of pairs) {
    const members = pair.map((guid) => plainBillGuid(guid));
    if (members.some((guid) => !guid || index.has(guid)) || members[0] === members[1]) continue;
    const group = toCompanionGroupV1([members[0]!, members[1]!]);
    for (const member of group.memberGuids) index.set(member, group);
  }
  return index;
};

/** The group key of a bill: its group's primary guid when grouped, else its own plain guid. */
export const companionKey = (
  guid: string,
  index: ReadonlyMap<string, Pick<CompanionGroupV1, "primaryGuid">>,
): string => {
  const plain = plainBillGuid(guid) ?? guid.trim();
  return index.get(plain)?.primaryGuid ?? plain;
};

/**
 * One row per group key (a user's votes, for example): the row on the group's primary wins,
 * otherwise the first row in input order. Suffixed ids count as their plain guid. Rows come back
 * in input order.
 */
export const pickCountedRowPerGroup = <T>(
  rows: readonly T[],
  billIdOf: (row: T) => string,
  index: ReadonlyMap<string, Pick<CompanionGroupV1, "primaryGuid">>,
): T[] => {
  const chosen = new Map<string, { position: number; onPrimary: boolean }>();
  rows.forEach((row, position) => {
    const billId = billIdOf(row);
    const key = companionKey(billId, index);
    const onPrimary = (plainBillGuid(billId) ?? billId.trim()) === key;
    const kept = chosen.get(key);
    if (!kept || (onPrimary && !kept.onPrimary)) chosen.set(key, { position, onPrimary });
  });
  return [...chosen.values()].sort((a, b) => a.position - b.position).map(({ position }) => rows[position]);
};

/** The stats key of a group's combined votes: "COMPANIONS#" + memberGuids joined by "#". */
export const companionStatsKey = (group: Pick<CompanionGroupV1, "memberGuids">): string =>
  COMPANION_STATS_KEY_PREFIX + group.memberGuids.join("#");
