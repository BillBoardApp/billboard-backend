import type { RawBill } from "../models/bill";

// Sponsor and cosponsor bioguide ids as processed bills store them. billSummarizer builds a
// processed bill's lists with these and billDiffer patches them with the same functions, so the
// two cannot drift (REL-28).

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
