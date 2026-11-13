import type { CongressMemberManifestItemV1, ProcessedCongressMemberV1 } from "../contracts";

type CongressChamber = "House of Representatives" | "Senate" | string;

interface BaseCongressMember {
  bioguideId?: string;
}

interface CongressMemberAddressInformation {
  city?: string;
  district?: string;
  officeAddress?: string;
  phoneNumber?: string;
  zipCode?: number;
}

interface CongressMemberDepiction {
  attribution?: string;
  imageUrl?: string;
}

interface CongressMemberPartyHistoryEntry {
  partyAbbreviation?: string;
  partyName?: string;
  startYear?: number;
  endYear?: number;
}

export interface CongressMemberTerm {
  chamber?: CongressChamber;
  congress?: number;
  district?: number | string;
  endYear?: number;
  memberType?: string;
  startYear?: number;
  stateCode?: string;
  stateName?: string;
}

export interface RawCongressMember extends BaseCongressMember {
  addressInformation?: CongressMemberAddressInformation;
  birthYear?: string;
  currentMember?: boolean;
  depiction?: CongressMemberDepiction;
  directOrderName?: string;
  district?: number | string;
  firstName?: string;
  firstname?: string;
  honorificName?: string;
  invertedOrderName?: string;
  lastName?: string;
  lastname?: string;
  middleName?: string;
  middlename?: string;
  officialWebsiteUrl?: string;
  partyHistory?: CongressMemberPartyHistoryEntry[];
  previousNames?: unknown[];
  sponsoredLegislation?: { count?: number; url?: string };
  cosponsoredLegislation?: { count?: number; url?: string };
  state?: string;
  terms?: CongressMemberTerm[];
  updateDate?: string;
}

export interface RawCongressMemberResponse {
  member?: RawCongressMember;
  request?: { bioguideId?: string; contentType?: string; format?: string };
}

export type ProcessedCongressMember = ProcessedCongressMemberV1 & BaseCongressMember;

export interface ProcessedCongressMemberResponse {
  member: ProcessedCongressMember;
}

export type CongressMemberManifestEntry = CongressMemberManifestItemV1;

const coerceToArray = (value: unknown): unknown[] | null => {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    const v = value as { items?: unknown; item?: unknown };
    if (Array.isArray(v.items)) return v.items;
    if (Array.isArray(v.item)) return v.item;
  }
  return null;
};

export const normalizeCongressMemberPayload = (payload: unknown): unknown => {
  if (!payload || typeof payload !== "object") return payload;
  const root = payload as RawCongressMemberResponse & Record<string, unknown>;
  const member = (root.member ?? (payload as RawCongressMember)) as RawCongressMember | undefined;
  if (!member || typeof member !== "object") return payload;

  const normalizedTerms = coerceToArray(member.terms);
  if (normalizedTerms) member.terms = normalizedTerms as CongressMemberTerm[];

  const normalizedPartyHistory = coerceToArray(member.partyHistory);
  if (normalizedPartyHistory) member.partyHistory = normalizedPartyHistory as CongressMemberPartyHistoryEntry[];

  const normalizedPreviousNames = coerceToArray(member.previousNames);
  if (normalizedPreviousNames) member.previousNames = normalizedPreviousNames;

  return payload;
};

export const unwrapCongressMember = (payload: unknown): RawCongressMember | null => {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { member?: unknown };
  const member = root.member ?? root;
  if (!member || typeof member !== "object") return null;
  return member as RawCongressMember;
};

/**
 * True only when congress.gov explicitly reports `currentMember: false` for this member
 * (resigned, died, retired or lost). A missing or non-boolean flag counts as current,
 * so a member is never retired on an absent signal.
 */
export const isDepartedCongressMember = (payload: unknown): boolean => {
  const member = unwrapCongressMember(payload);
  return member?.currentMember === false;
};

const unwrapProcessedCongressMember = (payload: unknown): ProcessedCongressMember | null => {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as { member?: unknown };
  const member = root.member ?? root;
  if (!member || typeof member !== "object") return null;
  return member as ProcessedCongressMember;
};

const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const safeIsoString = (value: unknown): string | null => {
  const s = toNonEmptyString(value);
  if (!s) return null;
  try {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
};

const padHouseDistrict = (raw: unknown): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw).padStart(2, "0");
  const s = toNonEmptyString(raw);
  if (!s) return null;
  // If it's a 1-digit numeric district like "7", pad it; otherwise keep as-is ("07" stays "07").
  if (/^\d$/.test(s)) return s.padStart(2, "0");
  return s;
};

export const toCongressMemberManifestEntryFromProcessed = (
  payload: unknown,
  options?: { updatedAtOverride?: string | null },
): CongressMemberManifestEntry | null => {
  const member = unwrapProcessedCongressMember(payload);
  if (!member) return null;

  const bioguideId = toNonEmptyString(member.bioguideId);
  const name =
    toNonEmptyString(member.directOrderName) ??
    (`${toNonEmptyString(member.firstName) ?? ""} ${toNonEmptyString(member.lastName) ?? ""}`.trim() || null);
  const chamber = toNonEmptyString(member.chamber);
  const state =
    toNonEmptyString(member.stateCode) ?? toNonEmptyString(member.stateName) ?? toNonEmptyString(member.state);
  const party = toNonEmptyString(member.partyAbbreviation) ?? toNonEmptyString(member.partyName);

  if (!bioguideId || !name || !chamber || !state || !party) return null;

  const district = chamber.toLowerCase().includes("house") ? padHouseDistrict(member.district) : null;
  const updatedAt = (options?.updatedAtOverride ?? null) || safeIsoString(member.updateDate) || null;
  const depictionImageUrl =
    toNonEmptyString(member?.depictionImageUrl) ??
    toNonEmptyString((member as ProcessedCongressMember & Pick<RawCongressMember, "depiction">)?.depiction?.imageUrl) ??
    null;

  return { bioguideId, name, chamber, state, party, district, depictionImageUrl, updatedAt };
};
