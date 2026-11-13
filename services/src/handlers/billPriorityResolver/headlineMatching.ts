import { normalizeBillTypeCode, parseBillGuid, type BillTypeCode } from "../../shared/billCompanions";
import { isCommemorativeResolution } from "../../shared/commemorativeResolutions";

/**
 * Which bills the priority resolver may pick, and how a headline is matched to one (REL-51, feature review S11).
 *
 * Candidates (project decisions 2026-10-28 and 2026-10-29): bills (H.R., S.), joint resolutions (H.J.Res., S.J.Res.),
 * which can become law, and a House resolution (H.Res.) only when it impeaches, censures or expels someone. Simple
 * resolutions are otherwise mostly ceremonial (S6), and a ceremonial resolution (shared/commemorativeResolutions.ts) is
 * never a candidate. A Senate resolution (S.Res.) never is, so neither is an expulsion from the Senate.
 *
 * A headline names a bill by its number ("H.J.Res. 106") or by one of its short titles ("SAVE Act"); either counts as
 * an explicit match, which guarantees the bill a place among the candidates. A number counts only for the newest
 * Congress's bill of that type and number in the pool (REL-46: in January, "H.R. 1" is the 120th's). A headline that
 * names neither but shares at least two distinctive words with one of the bill's titles (Billboard's headline, a short
 * title or the official title) counts as an overlap. A title with fewer than two distinctive words ("SECURE Act")
 * never overlaps: one common word ("secure votes") says nothing. Both counts are only hints for the model, which reads
 * the titles itself. Users only ever see the explicit count, in the neutral reason that replaces a loaded one ("Named
 * in 2 recent national news headlines."); overlaps never reach them.
 */

/** The bill types the resolver ranks; `hres` only to impeach, censure or expel (isImpeachmentCensureOrExpulsion). */
export type CandidateBillType = Extract<BillTypeCode, "hr" | "s" | "hjres" | "sjres" | "hres">;

const CANDIDATE_TYPES: ReadonlySet<BillTypeCode> = new Set<BillTypeCode>(["hr", "s", "hjres", "sjres", "hres"]);

/** The bill's type as a candidate type, or null for a type the resolver never ranks (sres, hconres, sconres). */
export const candidateTypeOf = (billType: unknown): CandidateBillType | null => {
  const code = normalizeBillTypeCode(billType);
  return code && CANDIDATE_TYPES.has(code) ? (code as CandidateBillType) : null;
};

// The project's patterns (2026-10-28 and 2026-10-29), anchored at the start of the official title, where Congress names
// what the measure does: "Impeaching Donald John Trump, President of the United States, for high crimes and
// misdemeanors.", "Censuring Representative ...", "Condemning and censuring Representative ...", "Expelling
// Representative George Santos from the United States House of Representatives.", and an impeachment inquiry
// ("Authorizing and directing the Committee on the Judiciary to investigate whether sufficient grounds exist for the
// House of Representatives to impeach ...", "Directing certain committees to continue their ... inquiry into whether
// sufficient grounds exist ... to impeach ..."). A measure that only names one opens otherwise and is not one: a rule
// that brings it to the floor ("Providing for consideration of the resolution (H. Res. 939) impeaching ...",
// "Providing for the adoption of ..."), a motion to table it ("Laying on the table ..."), or a resolution about it
// ("Condemning the impeachment of ...", "Condemning Representative ... and calling for his expulsion", "Expressing the
// sense of the House that the impeachment inquiry ...", "... that Representative ... should be expelled").
// Not covered, and raised on the REL-51 PR: a censure or expulsion the Ethics Committee reports itself is
// titled "In the Matter of ..." (H.Res. 495 of the 107th Congress expelled James A. Traficant, Jr.), as a reprimand is.
const IMPEACH_CENSURE_OR_EXPEL_RE =
  /^(?:impeaching\b|censuring\b|expelling\b|condemning\b.*?\band censur(?:e|es|ed|ing)\b|(?:authorizing|directing)\b.*?\b(?:investigate|inquiry into) whether\b.*?\bimpeach)/i;

/** True when the official title is that of a measure that impeaches, censures or expels someone. */
export const isImpeachmentCensureOrExpulsion = (officialTitle: string): boolean =>
  IMPEACH_CENSURE_OR_EXPEL_RE.test(officialTitle.trim());

/**
 * Why a bill is not a candidate; null when it is one. `noOfficialTitle`: an H.Res. whose official title is unknown
 * (its raw bill was not read, or holds none), so whether it impeaches, censures or expels cannot be told.
 */
export type CandidateExclusion = "type" | "ceremonial" | "resolution" | "noOfficialTitle";

/**
 * Whether the resolver may rank the bill. `title` is Billboard's headline; `officialTitle` Congress's, when known.
 * An H.Res. is judged by its official title only: Billboard's headline is a paraphrase ("Set House rules for the
 * impeachment debate"), so an H.Res. whose official title is unknown is never sent to the model.
 */
export const candidateExclusion = (bill: {
  billType: unknown;
  title: string;
  officialTitle?: string;
}): CandidateExclusion | null => {
  const type = candidateTypeOf(bill.billType);
  if (!type) return "type";
  if (isCommemorativeResolution({ billType: type, officialTitle: bill.officialTitle ?? null, title: bill.title })) {
    return "ceremonial";
  }
  if (type === "hres") {
    if (!bill.officialTitle?.trim()) return "noOfficialTitle";
    if (!isImpeachmentCensureOrExpulsion(bill.officialTitle)) return "resolution";
  }
  return null;
};

// ─── Matching ────────────────────────────────────────────────────────────────

export const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/&[a-z]+;/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// The abbreviations are capitals only, and the lookbehind keeps "U.S. 2026", "Trump's 2026" and "Res. 5" from reading
// as S. 2026 or S. 5.
const billReferencePatterns: ReadonlyArray<{ type: CandidateBillType; regex: RegExp }> = [
  { type: "hjres", regex: /(?<![\w.'’])H\.?\s?J\.?\s?(?:Res|RES)\.?\s*(\d{1,5})\b/g },
  { type: "sjres", regex: /(?<![\w.'’])S\.?\s?J\.?\s?(?:Res|RES)\.?\s*(\d{1,5})\b/g },
  { type: "hres", regex: /(?<![\w.'’])H\.?\s?(?:Res|RES)\.?\s*(\d{1,5})\b/g },
  { type: "hr", regex: /(?<![\w.'’])H\.?\s?R\.?\s*(\d{1,5})\b/g },
  { type: "s", regex: /(?<![\w.'’])S\.?\s*(\d{1,5})\b/g },
  { type: "hjres", regex: /\bHouse joint resolution\s+(\d{1,5})\b/gi },
  { type: "sjres", regex: /\bSenate joint resolution\s+(\d{1,5})\b/gi },
  { type: "hres", regex: /\bHouse resolution\s+(\d{1,5})\b/gi },
  { type: "hr", regex: /\bHouse bill\s+(\d{1,5})\b/gi },
  { type: "s", regex: /\bSenate bill\s+(\d{1,5})\b/gi },
];

/** The bill numbers a headline names, as `<type><number>` ("hjres106"). */
export const billReferencesIn = (text: string): Set<string> => {
  const refs = new Set<string>();
  for (const { type, regex } of billReferencePatterns) {
    for (const match of text.matchAll(regex)) {
      const number = String(Number(match[1]));
      if (number !== "NaN") refs.add(`${type}${number}`);
    }
  }
  return refs;
};

// Words that say nothing about which bill a headline is about: function words, and the words every headline of a
// search for Congress, House or Senate bills carries ("House votes on Senate bill") or every official title does
// ("To amend title 18, United States Code, ... and for other purposes").
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  "about",
  "across",
  "after",
  "against",
  "also",
  "amend",
  "amended",
  "amending",
  "amends",
  "amid",
  "among",
  "because",
  "been",
  "before",
  "being",
  "between",
  "bill",
  "bills",
  "certain",
  "code",
  "congress",
  "congressional",
  "could",
  "during",
  "each",
  "every",
  "federal",
  "from",
  "have",
  "house",
  "into",
  "joint",
  "lawmakers",
  "made",
  "make",
  "makes",
  "more",
  "only",
  "other",
  "over",
  "provide",
  "provides",
  "providing",
  "purposes",
  "resolution",
  "resolutions",
  "senate",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "title",
  "titles",
  "under",
  "united",
  "states",
  "vote",
  "voted",
  "votes",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "will",
  "with",
  "within",
  "without",
  "would",
]);

// The formula of an official title, which says nothing about its subject: "To authorize appropriations for ... for
// fiscal years 2026 through 2028", "To amend the Internal Revenue Code of 1986 to require the Secretary ...",
// "Providing for congressional disapproval ... of the rule submitted by the Department of Energy relating to ...",
// "Making appropriations ... for the fiscal year ending September 30, 2027". Headlines use these words about other
// things ("fiscal year ends", "Internal Revenue Service layoffs"). Only the official title leaves them out: in a
// short title or Billboard's headline they were chosen.
const OFFICIAL_TITLE_FORMULA_WORDS: ReadonlySet<string> = new Set([
  "administration",
  "agency",
  "appropriate",
  "appropriation",
  "appropriations",
  "authority",
  "authorization",
  "authorizations",
  "authorize",
  "authorizes",
  "authorizing",
  "carry",
  "chapter",
  "department",
  "direct",
  "directing",
  "disapproval",
  "ending",
  "establish",
  "establishes",
  "establishing",
  "extend",
  "extending",
  "fiscal",
  "improve",
  "improving",
  "include",
  "including",
  "internal",
  "making",
  "program",
  "programs",
  "relating",
  "require",
  "requires",
  "requiring",
  "respect",
  "revenue",
  "rule",
  "secretary",
  "section",
  "september",
  "submitted",
  "year",
  "years",
]);

// Nouns no ending rule reaches: news says "expulsion vote" of a resolution titled "Expelling ...".
const IRREGULAR_STEMS: ReadonlyMap<string, string> = new Map([["expulsion", "expel"]]);

/**
 * A light stem, so "impeaching", "impeachment" and "impeach", "censure" and "censured", or "expel", "expels",
 * "expelled", "expelling" and "expulsion" match each other. A final "ll" in a stem of 6 letters or more loses an "l"
 * whatever the form, so "expelled" meets "expel", "cancelled" meets "canceled", and "install" still meets "installed";
 * a short word ("bill", "small") keeps it.
 */
export const stemWord = (word: string): string => {
  let stem = word;
  if (stem.length >= 5 && stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1);
  const irregular = IRREGULAR_STEMS.get(stem);
  if (irregular) return irregular;
  const suffix = ["ment", "ing", "ed"].find((ending) => stem.length - ending.length >= 4 && stem.endsWith(ending));
  if (suffix) stem = stem.slice(0, -suffix.length);
  if (stem.length >= 6 && stem.endsWith("e")) stem = stem.slice(0, -1);
  if (stem.length >= 6 && stem.endsWith("ll")) stem = stem.slice(0, -1);
  return stem;
};

const wordsOf = (normalized: string): string[] => normalized.split(/\s+/).filter(Boolean);

/**
 * The distinctive words of a title, stemmed: 4 characters or more, not a number ("2026", "1986") and not generic. With
 * `official`, the words of an official title's formula are left out too (OFFICIAL_TITLE_FORMULA_WORDS).
 */
export const distinctiveStems = (title: string, options: { official?: boolean } = {}): string[] => [
  ...new Set(
    wordsOf(normalizeText(title))
      .filter(
        (word) =>
          word.length >= 4 &&
          !/^\d+$/.test(word) &&
          !GENERIC_WORDS.has(word) &&
          !(options.official && OFFICIAL_TITLE_FORMULA_WORDS.has(word)),
      )
      .map(stemWord),
  ),
];

/** Distinctive words a headline must share with one title to overlap it; a title with fewer never overlaps. */
export const MIN_SHARED_STEMS = 2;

/**
 * The phrases that name a bill by its short title: the title itself ("laken riley act"), without its year
 * ("continuing appropriations act" for "Continuing Appropriations Act, 2026"), and without "Act" when three words
 * or more remain ("one big beautiful bill"). Single words never count: "GENIUS" alone is not "GENIUS Act".
 */
export const shortTitlePhrases = (shortTitle: string): string[] => {
  const full = normalizeText(shortTitle);
  const withoutYear = full.replace(/\s+(?:of\s+)?\d{4}$/, "");
  const core = withoutYear.replace(/\s+(?:act|resolution)$/, "");
  const phrases = new Set([full, withoutYear]);
  if (core !== withoutYear && wordsOf(core).length >= 3) phrases.add(core);
  return [...phrases].filter((phrase) => wordsOf(phrase).length >= 2);
};

/** A headline as the matcher reads it. */
export interface MatchableHeadline {
  title: string;
  /** normalizeText(title). */
  normalizedTitle: string;
}

/** A bill as the matcher reads it. */
export interface MatchableBill {
  guid?: string;
  congress?: string;
  billType: string;
  billNumber?: string;
  /** Billboard's headline. */
  title: string;
  shortTitles?: string[];
  officialTitle?: string;
}

/** The bill's number as a headline names it, `<type><number>` ("hr1"), or null. */
const numberReferenceOf = (bill: MatchableBill): string | null => {
  const type = candidateTypeOf(bill.billType);
  const number = String(Number((bill.billNumber ?? "").trim()));
  return type && number !== "NaN" && number !== "0" ? `${type}${number}` : null;
};

/** The bill's Congress, from its row or else its guid, or null when neither says. */
const congressOf = (bill: MatchableBill): number | null => {
  const fromRow = bill.congress?.trim() ?? "";
  const congress = /^\d+$/.test(fromRow) ? fromRow : parseBillGuid(bill.guid)?.congress;
  return congress ? Number(congress) : null;
};

/**
 * REL-46: the newest Congress of each bill number in the pool (`hr1` maps to 120). Each Congress numbers its bills
 * from 1 again, so from 2027-01-03 the week can hold the 119th's H.R. 1 and the 120th's. A headline that names a
 * number is counted for the newest bill of that type and number only (matchHeadlines); a number only an older
 * Congress's bill has still counts for it ("President signs H.R. 1234" in January).
 */
export const newestCongressByNumber = (bills: readonly MatchableBill[]): Map<string, number> => {
  const newest = new Map<string, number>();
  for (const bill of bills) {
    const reference = numberReferenceOf(bill);
    const congress = congressOf(bill);
    if (reference && congress !== null && congress > (newest.get(reference) ?? 0)) newest.set(reference, congress);
  }
  return newest;
};

export interface HeadlineMatches {
  /** Headlines that name the bill, by number or by a short title. */
  explicitHeadlineMatches: number;
  /** Of those, the headlines that name it by a short title but not by number. */
  shortTitleMatches: number;
  /** Other headlines that share at least MIN_SHARED_STEMS distinctive words with one of its titles. */
  headlineOverlapCount: number;
}

/**
 * Counts the headlines that name the bill, and the others that share words with one of its titles. With the pool's
 * newestCongressByNumber, a number that a newer Congress's bill of the same type also has is not counted for this
 * bill (REL-46); its titles still are.
 */
export const matchHeadlines = (
  bill: MatchableBill,
  headlines: readonly MatchableHeadline[],
  newestCongress: ReadonlyMap<string, number> = new Map(),
): HeadlineMatches => {
  const reference = numberReferenceOf(bill);
  const congress = congressOf(bill);
  const newerBillHasNumber = reference !== null && congress !== null && (newestCongress.get(reference) ?? 0) > congress;
  const ownReference = newerBillHasNumber ? null : reference;
  const phrases = (bill.shortTitles ?? []).flatMap(shortTitlePhrases);
  // A one-word short title ("SECURE Act") is matched by its phrase only; it never overlaps.
  const titleStems = [
    ...[bill.title, ...(bill.shortTitles ?? [])].map((title) => distinctiveStems(title)),
    distinctiveStems(bill.officialTitle ?? "", { official: true }),
  ].filter((stems) => stems.length >= MIN_SHARED_STEMS);

  const matches: HeadlineMatches = { explicitHeadlineMatches: 0, shortTitleMatches: 0, headlineOverlapCount: 0 };
  for (const headline of headlines) {
    if (ownReference && billReferencesIn(headline.title).has(ownReference)) {
      matches.explicitHeadlineMatches += 1;
      continue;
    }
    const padded = ` ${headline.normalizedTitle} `;
    if (phrases.some((phrase) => padded.includes(` ${phrase} `))) {
      matches.explicitHeadlineMatches += 1;
      matches.shortTitleMatches += 1;
      continue;
    }
    const headlineStems = new Set(wordsOf(headline.normalizedTitle).map(stemWord));
    if (titleStems.some((stems) => stems.filter((stem) => headlineStems.has(stem)).length >= MIN_SHARED_STEMS)) {
      matches.headlineOverlapCount += 1;
    }
  }
  return matches;
};
