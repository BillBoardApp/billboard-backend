/**
 * REL-51 (feature review S11): the titles news coverage names a bill by. The manifest row's title is Billboard's own
 * plain-language headline ("Requires proof of citizenship to register to vote"), which no outlet uses; coverage says
 * "SAVE Act" (the short title) or describes the official title ("Impeaching ..."). Neither is on the manifest row or
 * in the processed bill (the processed bill's officialTitle is the text's official title, or Congress's display title
 * when the text has none), so the resolver reads them from the raw bill: congress.gov's `/titles` list
 * (`content.titles.titles`, every title of every version, with its `titleType`), then the display title
 * (`metadata.title`, the bill list's title; the bill's `content.bill.bill.title`) and the text's `<official-title>`.
 */

export interface BillTitles {
  /** Congress's short (and popular) titles, latest version first, without duplicates; at most MAX_SHORT_TITLES. */
  shortTitles: string[];
  /** Congress's official title, the latest version's; absent when the raw bill has none. */
  officialTitle?: string;
}

/** Short titles sent per bill: a bill can carry dozens (one per division of an omnibus). */
export const MAX_SHORT_TITLES = 2;
/** Characters of one short title sent to the model; longer ones are cut at a word. */
export const SHORT_TITLE_MAX_CHARS = 120;
/** Characters of the official title sent to the model; longer ones are cut at a word. */
export const OFFICIAL_TITLE_MAX_CHARS = 300;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const clean = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** The text cut to at most `maxChars` at a word boundary, ending in "…"; unchanged when it fits. */
export const capTitle = (text: string, maxChars: number): string => {
  const normalized = clean(text);
  if (normalized.length <= maxChars) return normalized;
  const cut = normalized.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, "")}…`;
};

// congress.gov titleType values: "Short Title(s) as Introduced", "Short Titles as Passed House", "Popular Title",
// "Official Title as Introduced", "Official Titles as Amended by Senate", "Display Title", and the same "... for
// portions of this bill" (a division's title, not the bill's).
const SHORT_TITLE_TYPE_RE = /^(?:short|popular) title/i;
const OFFICIAL_TITLE_TYPE_RE = /^official title/i;
const PORTIONS_RE = /for portions/i;

// congress.gov's display title is the short title when the bill has one ("Laken Riley Act", "Continuing
// Appropriations Act, 2026"), else the official title ("To amend ...", "Impeaching ..."). Short titles end in "Act"
// or "Resolution", with or without a year; official titles of bills open with "To".
const SHORT_FORM_RE = /\b(?:act|resolution)(?:,?\s+(?:of\s+)?\d{4})?$/i;
const BILL_OFFICIAL_OPENING_RE = /^(?:to|an? (?:bill|act|joint resolution|resolution) to)\b/i;

const looksLikeShortTitle = (title: string): boolean =>
  !BILL_OFFICIAL_OPENING_RE.test(title) && SHORT_FORM_RE.test(title.replace(/[.\s]+$/, ""));

type TitleEntry = { title: string; titleType: string; updatedAt: number };

const titleEntries = (content: Record<string, unknown> | undefined): TitleEntry[] => {
  const list = asRecord(content?.titles)?.titles;
  if (!Array.isArray(list)) return [];
  return (
    list
      .map((value, index): TitleEntry & { index: number } => {
        const entry = asRecord(value);
        const updatedAt = Date.parse(clean(entry?.updateDate));
        return {
          title: clean(entry?.title),
          titleType: clean(entry?.titleType),
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
          index,
        };
      })
      .filter((entry) => entry.title.length > 0)
      // The latest version's titles first; the list's own order breaks ties.
      .sort((left, right) => right.updatedAt - left.updatedAt || left.index - right.index)
  );
};

/** The text's `<official-title>`, tags and entities removed; "" when there is none. */
const xmlOfficialTitle = (xml: unknown): string => {
  if (typeof xml !== "string") return "";
  const match = xml.match(/<official-title(?=[\s>])[^>]*>([\s\S]*?)<\/official-title\s*>/);
  if (!match) return "";
  return clean(
    match[1]
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#8217;|&#x2019;/g, "'")
      .replace(/&#?\w+;/g, " "),
  );
};

const sameTitle = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/**
 * The short and official titles of a raw bill (RawBill: `metadata`, and `content` as fetchRawBill stores it).
 * Never throws: anything missing or malformed reads as no title.
 *
 * - Short titles: the `/titles` entries typed short or popular (not "for portions of this bill"), latest first. A
 *   raw bill without any falls back to the display title when that reads as a short title (it ends in "Act" or
 *   "Resolution", perhaps with a year, and does not open with "To").
 * - Official title: the latest `/titles` entry typed official, else the text's `<official-title>`, else the display
 *   title when it does not read as a short title.
 */
export const titlesFromRawBill = (raw: unknown): BillTitles => {
  const document = asRecord(raw);
  const content = asRecord(document?.content);
  const entries = titleEntries(content);

  const shortTitles: string[] = [];
  let officialTitle = "";
  for (const entry of entries) {
    if (PORTIONS_RE.test(entry.titleType)) continue;
    if (SHORT_TITLE_TYPE_RE.test(entry.titleType)) {
      if (!shortTitles.some((title) => sameTitle(title, entry.title))) shortTitles.push(entry.title);
    } else if (OFFICIAL_TITLE_TYPE_RE.test(entry.titleType) && !officialTitle) {
      officialTitle = entry.title;
    }
  }

  const contentBill = asRecord(asRecord(content?.bill)?.bill) ?? asRecord(content?.bill);
  const displayTitle = clean(asRecord(document?.metadata)?.title) || clean(contentBill?.title);
  officialTitle ||= xmlOfficialTitle(content?.billXML ?? content?.billXml ?? content?.bill_xml);
  if (displayTitle && !looksLikeShortTitle(displayTitle)) {
    officialTitle ||= displayTitle;
  } else if (displayTitle && shortTitles.length === 0 && !(officialTitle && sameTitle(displayTitle, officialTitle))) {
    shortTitles.push(displayTitle);
  }

  return {
    shortTitles: shortTitles.slice(0, MAX_SHORT_TITLES).map((title) => capTitle(title, SHORT_TITLE_MAX_CHARS)),
    ...(officialTitle ? { officialTitle: capTitle(officialTitle, OFFICIAL_TITLE_MAX_CHARS) } : {}),
  };
};
