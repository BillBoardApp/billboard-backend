import type { BillSponsorDetail, RawBill } from "../models/bill";

// Sponsor and cosponsor bioguide ids as processed bills store them, and the sponsors' names and seats
// (sponsorDetails). billSummarizer builds a processed bill's lists with these and billDiffer patches
// them with the same functions, so the two cannot drift (REL-28).

type UnknownRecord = Record<string, unknown>;

const contentOf = (rawBill: RawBill): UnknownRecord | undefined => {
  const content = (rawBill as unknown as { content?: unknown })?.content;
  return content && typeof content === "object" ? (content as UnknownRecord) : undefined;
};

const bioguideIdsOf = (entries: unknown): string[] => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry: unknown) => ((entry as UnknownRecord | null)?.bioguideId as string) || "").filter(Boolean);
};

/** Sponsor bioguide ids from content.bill.bill.sponsors. */
export const extractSponsorIdsFromRawBill = (rawBill: RawBill): string[] => {
  const bill = contentOf(rawBill)?.bill as UnknownRecord | undefined;
  const innerBill = bill?.bill as UnknownRecord | undefined;
  return bioguideIdsOf(innerBill?.sponsors);
};

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// congress.gov's titles before a sponsor's fullName ("Rep. Smith, John [R-TX-7]").
const FULL_NAME_TITLE = /^(?:rep|sen|del|resident commissioner)\.?(?:\s+|$)/i;

/**
 * "First Last" from firstName and lastName, else from fullName without its title and its "[R-TX-7]" bracket, turned
 * from "Last, First Middle" into "First Middle Last". "" when neither gives a name.
 */
const sponsorNameOf = (entry: UnknownRecord): string => {
  const first = toTrimmedString(entry.firstName);
  const last = toTrimmedString(entry.lastName);
  if (first && last) return `${first} ${last}`;
  const full = toTrimmedString(entry.fullName)
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(FULL_NAME_TITLE, "")
    .trim();
  const comma = full.indexOf(",");
  if (comma < 0) return full;
  const lastPart = full.slice(0, comma).trim();
  const rest = full.slice(comma + 1).trim();
  return [rest, lastPart].filter(Boolean).join(" ");
};

/**
 * The party letter the apps know (D, R or I), from congress.gov's code. "ID" (Independent Democrat) is an independent;
 * any other code is left out rather than shown as one of the three.
 */
const PARTY_LETTERS: Readonly<Record<string, BillSponsorDetail["party"]>> = { D: "D", R: "R", I: "I", ID: "I" };

/** A House seat as the members manifest writes it: two digits, "00" at-large. Null for a senator, who has no district. */
const sponsorDistrictOf = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value).padStart(2, "0");
  const text = toTrimmedString(value);
  if (/^at[\s-]*large$/i.test(text)) return "00";
  return /^\d{1,2}$/.test(text) ? text.padStart(2, "0") : null;
};

/**
 * The sponsors' names and seats from content.bill.bill.sponsors, in the raw order, so a bill can still name its sponsor
 * once the sponsor has left the members list (REL-46 5.3). An entry without a bioguide id or a name is left out.
 */
export const extractSponsorDetailsFromRawBill = (rawBill: RawBill): BillSponsorDetail[] => {
  const bill = contentOf(rawBill)?.bill as UnknownRecord | undefined;
  const sponsors = (bill?.bill as UnknownRecord | undefined)?.sponsors;
  if (!Array.isArray(sponsors)) return [];
  const details: BillSponsorDetail[] = [];
  for (const raw of sponsors) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as UnknownRecord;
    const bioguideId = toTrimmedString(entry.bioguideId);
    const name = sponsorNameOf(entry);
    if (!bioguideId || !name) continue;
    const party = PARTY_LETTERS[toTrimmedString(entry.party).toUpperCase()];
    const state = toTrimmedString(entry.state).toUpperCase();
    details.push({
      bioguideId,
      name,
      ...(party ? { party } : {}),
      ...(/^[A-Z]{2}$/.test(state) ? { state } : {}),
      district: sponsorDistrictOf(entry.district),
    });
  }
  return details;
};

/** Cosponsor bioguide ids from content.cosponsors.cosponsors. */
export const extractCosponsorIdsFromRawBill = (rawBill: RawBill): string[] => {
  const wrapper = contentOf(rawBill)?.cosponsors as UnknownRecord | undefined;
  return bioguideIdsOf(wrapper?.cosponsors);
};

/**
 * True when the stored /cosponsors response holds fewer cosponsors than congress.gov reported:
 * a raw bill fetched before FetchRawBill read every page (REL-28) keeps the first page only, with
 * pagination.next still set and pagination.count above the list's length.
 */
export const isCosponsorListTruncated = (rawBill: RawBill): boolean => {
  const wrapper = contentOf(rawBill)?.cosponsors as UnknownRecord | undefined;
  if (!wrapper || typeof wrapper !== "object") return false;
  const pagination = wrapper.pagination as UnknownRecord | undefined;
  if (typeof pagination?.next === "string" && pagination.next.length > 0) return true;
  const stored = Array.isArray(wrapper.cosponsors) ? wrapper.cosponsors.length : 0;
  return typeof pagination?.count === "number" && pagination.count > stored;
};
