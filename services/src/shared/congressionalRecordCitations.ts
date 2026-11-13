// Congressional Record citations (project decision 2026-11-12, docs/RUNBOOK.md 4.9 and 18.1). congress.gov adds a
// citation to an action it already lists, often days or months later, and sometimes changes or drops its pages; such an
// edit is not news. The manifest date (shared/billVersionChange.ts, the d2 basis) and the pushes
// (shared/billOutcomes.ts newBillActions: notificationType's alert, passed and failed) know an action without them.
// This module imports nothing, so any module can use it.
//
// The citations as congress.gov writes them at the end of an action's text, matched in the lower-case text with spaces
// collapsed. Every form below is congress.gov's, found in every processed bill and a sixth of the raw bills on
// 2026-11-12 (37,718 action texts, 3,133 with a citation, each at the end of its text, all of them matched):
//
//   (consideration: CR H6104-6105)                      BILLS-119hr9614, 2026-11-09
//   (text: CR H6104)                                    BILLS-119hr9614, 2026-11-09
//   (consideration: CR S2313; text: CR S2310)           BILLS-119sres734, 2026-05-14
//   (CR S2159), (CR E85)                                BILLS-119hconres14, BILLS-119hr7281: no label
//   (Sponsor introductory remarks on measure: CR S1745) BILLS-119s1015
//   (text of amendment in the nature of a substitute: CR H5138-5143)    BILLS-119hconres113
//   (consideration: CR S2533, S2537-2538)               BILLS-119hjres20: several pages
//   (text: CR H1741: 6), (consideration: CR S2643: 3)   BILLS-119hjres87, BILLS-119sres187: a part after the page
//   (text: CR S8533--8535)                              BILLS-119s2950: a double hyphen
//   (consideration: CR H2166-2168 )                     BILLS-119hres426: a space before the parenthesis
//   (text: 4/9/2025 CR H1533-1540), (text: CR 1/7/2026 H127), (text: CR 11/19 S8242)
//                                                       BILLS-119hconres14, BILLS-119hr4593, BILLS-119sres503: dated
//
// The page letter is H (House), S (Senate) or E (Extensions of Remarks). A label is any run of letters and spaces before
// a colon: the CR reference after it is what makes the parenthesis a citation. Nothing else in parentheses is taken,
// so a roll call ("(Roll no. 316)"), a Senate record vote ("(Record Vote No. 575)") or "(2/3 required)" still tells two
// actions apart.
const CR_DATE = String.raw`\d{1,2}/\d{1,2}(?:/\d{2,4})?`;
const CR_PAGE = String.raw`[hse]\d+(?:-{1,2}\d+)?(?:: ?\d+)?`;
const CR_REFERENCE = String.raw`(?:${CR_DATE} )?cr (?:${CR_DATE} )?${CR_PAGE}(?:, ?${CR_PAGE})*`;
const CR_PART = String.raw`(?:[a-z][a-z ]*: ?)?${CR_REFERENCE}`;
const TRAILING_CR_CITATIONS = new RegExp(String.raw`(?: ?\(${CR_PART}(?:; ?${CR_PART})* ?\))+$`);

/**
 * An action's text (trimmed, spaces collapsed, lower case) without the Congressional Record citations at its end, as
 * the d2 basis and the pushes know it. Applied twice it changes nothing more.
 */
export const actionTextWithoutCitations = (text: string): string =>
  text.replace(/\s+/g, " ").trim().toLowerCase().replace(TRAILING_CR_CITATIONS, "").trim();
