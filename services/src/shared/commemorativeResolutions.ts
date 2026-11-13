import { normalizeBillTypeCode, plainBillGuid, type BillTypeCode } from "./billCompanions";

/**
 * Ceremonial ("commemorative") resolutions: simple and concurrent resolutions that designate a day or
 * week, recognize a group, or honor or congratulate someone. They change no law and lead the Bills list
 * whenever several are introduced at once (feature review 2026-10-28, S6). The server tags them so they
 * get no topics and no life areas (topics too since 2026-10-29: a card still showed a followed topic), keep
 * their first-publication date, and stay out of "new bill" pushes, topic and
 * life-area matches and the Weekly Brief's "Worth a quick look". The stored processed bill keeps the
 * summarizer's labels; the manifest row, GET /processed-bill and userMatcher's matching leave them out.
 *
 * The test is deliberately narrow:
 * - Only simple and concurrent resolutions (H.Res., S.Res., H.Con.Res., S.Con.Res.). Bills and joint
 *   resolutions can become law, so a "Designating the facility..." bill is never tagged.
 * - The title must open with a ceremonial verb. Congress's official title is used when present; without
 *   it, the generated headline, which uses the plain form ("Recognize Community Health Workers Week").
 *   Since 2026-10-29 the openings include "Encouraging the recognition of" (BILLS-119hres1572, a card seen
 *   in the app), "Expressing support for July to be designated as", "Commending" and a leading
 *   "A resolution" or "A concurrent resolution", which official titles also use for a day, a month or an anniversary.
 * - A title that also condemns, censures, impeaches, disapproves, calls on or urges anyone, or expresses
 *   "the sense of" a chamber, is not ceremonial and is never tagged, even when it opens with "Recognizing".
 * - A headline that decides (there is no official title) is a paraphrase: "Recognize Overdose Awareness Day
 *   and fight the opioid crisis", "Celebrate Jimmy Lai and Free Hong Kong Activists". One that also asks to
 *   free, fight, stop or defend, or adds "and support ...", is not ceremonial either: an official title
 *   would ask through "calling on" or "urging", which the rule above catches, but the headline drops them.
 * - Since 2026-10-29 (second review round), a deciding headline is also ceremonial when it opens Make,
 *   Declare, Create, Name or Support (or Making, Declaring, Creating, Naming, Supporting) or National and names a day,
 *   week, month or year ("Make May ALS Awareness Month", "Declare National Clean Energy Week"), with the same
 *   exclusions and the same free, fight, stop and defend guard. A period that counts or dates ("this year", "every
 *   day", "within a week", "a 40-hour work week", "Election Day") does not designate one. Official titles are not
 *   held to this clause, but Congress's titles for the bills it tags use more openings than the verbs above
 *   ("Supports the designation of", "Expressing support for designation of", "Supporting the mission and goals of",
 *   "Raising awareness ... by designating", "A concurrent resolution supporting ..."; govinfo BILLSTATUS and bill text,
 *   read 2026-10-29). Those openings are tagged too, so a re-summary that stores the official title keeps such a bill
 *   tagged.
 * - A curated override stands over all of the above (CURATED_OVERRIDES, by guid), for the bill and for an identical
 *   companion it is carried to (CURATED_OVERRIDE_COMPANIONS). A bill held for review is not tagged until it has been
 *   reviewed, whatever its titles (HELD_FOR_REVIEW).
 *
 * Why a curated list: no wording rule separates every ceremonial resolution from one that takes a policy position. A
 * "Recognizing the importance of ..." title can honor an anniversary or argue for a national priority, and a headline
 * can paraphrase away the "calling on" that would mark it. Where the title rule and a reading of the bill's text
 * disagree, the project reviews the bill and records the result here by guid, with a one-line reason, so that the
 * label does not flip when a re-summary changes the title. The test is the same for every bill: ceremonial means it
 * designates a day, week, month or year, or recognizes, honors or commemorates, and asks no one to act; a resolution
 * that also urges a policy, calls its cause a national priority or recognizes a denial of rights is not ceremonial.
 */

/**
 * Curated overrides of 2026-10-29 on borderline resolutions (RUNBOOK 4.12), keyed by plain guid: true is
 * ceremonial. They hold whichever title decides: the headline now, and Congress's official title once the bill is
 * summarized again (billSummarizer stores it, from the bill text or else Congress's title), which a new version may do
 * at its next write. The first five are the headline-decided rows the relabel's review read as borderline. No title
 * rule decides all five as the review did, because their official titles (govinfo BILLSTATUS, read 2026-10-29) say
 * otherwise:
 * - BILLS-119hres48, "Honor MLK and celebrate diversity", is ceremonial; officially "Honoring Reverend Dr. Martin
 *   Luther King, Jr., by celebrating diversity, promoting tolerance, and condemning hate.", which "condemning" keeps
 *   out of the rule.
 * - BILLS-119hres862, "Honor Buffalo Soldiers with commemorative stamp", is ceremonial; officially "Expressing the
 *   sense of the House of Representatives that a commemorative postage stamp should be issued in honor of the Buffalo
 *   Soldiers.", a sense of the House.
 * - BILLS-119hres1365, "Recognize ARFID as serious eating disorder", is not; officially "Recognizing ... (ARFID) as a
 *   serious feeding and eating disorder and acknowledging the urgent need ..." for awareness, research and care.
 * - BILLS-119hconres107, "Recognizing gun violence as a serious problem on America's 250th birthday", is not;
 *   officially "Recognizing the importance of saving lives, reducing gun violence, and strengthening public safety as
 *   the United States celebrates its 250th anniversary.", which no wording test tells from a ceremonial "Recognizing
 *   the importance of".
 * - BILLS-119hres1304, "Honoring DC military members denied voting rights", is not; officially "Recognizing on Memorial
 *   Day, May 25, 2026, the denial of voting representation in Congress and full local self-government through
 *   statehood for ..." the District's servicemembers and veterans.
 * A wording rule ("Recognize X as a serious ...", a headline naming statehood, voting rights or a priority) would
 * decide hres1365 and hres1304 only, and would also untag resolutions nobody reviewed. The rest are the second review
 * round of 2026-10-29, on the look-alikes the pull request asked about, each against what its titles decide.
 * Add a guid only after such a review, with its date and reason.
 */
const CURATED_OVERRIDES: ReadonlyMap<string, boolean> = new Map([
  // 2026-10-29, first round: the five rows the relabel's review read as borderline.
  ["BILLS-119hres48", true],
  ["BILLS-119hres862", true],
  ["BILLS-119hres1365", false],
  ["BILLS-119hconres107", false],
  ["BILLS-119hres1304", false],
  // 2026-10-29, second round, answer 1. Not ceremonial: a policy goal's importance or a need (hconres107).
  ["BILLS-119hres955", false], // "Recognizing the importance of a continued commitment to ending pediatric HIV ..."
  ["BILLS-119hconres112", false], // "Recognizing the need to improve physical access to ... federally funded facilities"
  // Ceremonial: the yearly Equal Pay Day resolutions, so no title (a "disparity", a "wage gap") can untag them.
  ["BILLS-119hconres81", true], // Equal Pay Day: "Recognizing the significance of equal pay and the disparity ..."
  ["BILLS-119hconres42", true], // Equal Pay Day: "Recognizing wage gap for Black women"
  ["BILLS-119sconres36", true], // Equal Pay Day: "Recognizing wage gap between men and Black women"
  ["BILLS-119hconres114", true], // Equal Pay Day: "Recognizing ... the disparity in wages paid to ... Black women."
  ["BILLS-119hconres56", true], // Equal Pay Day: "Recognizing ... the disparity in wages paid to Latina women ..."
  ["BILLS-119hconres123", true], // Equal Pay Day: "Recognizing the disparity in wages paid to Latinas ..."
  ["BILLS-119hres829", true], // Equal Pay Day: "Recognizing ... the pay disparity between disabled women and ... men."
  // Answer 2. Not ceremonial, as hres1304 and hres1365: a denial of rights, a national priority.
  ["BILLS-119hres440", false], // hres1304's headline, "Honoring DC military members denied voting rights", for 2025
  ["BILLS-119hres1528", false], // "Recognize suicide prevention as a national health priority"
  // Ceremonial, like hres48, though the headline fights or stops hate and the official title calls on or condemns.
  ["BILLS-119sres738", true], // "Celebrate Jewish American Heritage Month and fight hate"
  ["BILLS-119hres819", true], // "Honoring Indian Americans and stopping racism against them"
]);

/**
 * Bills a curated override covers through the bill it was made for, keyed by plain guid: not an override of their
 * own, and named as such (curatedOverrideCompanionOf). Each is a published companion pair (BILL_COMPANION_GROUPS)
 * that CRS lists as identical, and the Weekly Brief shows such a pair as one item, ceremonial when either member is
 * (weeklyDigestBuilder companionGroupCandidate).
 * - BILLS-119sconres34, "Recognizing gun violence as a public health problem on America's 250th birthday", follows
 *   hconres107 ("A concurrent resolution recognizing the importance of saving lives, ..."). Tagged by its headline, it
 *   would take hconres107's topics out of the Brief whenever both bills are in it. The review kept it so on 2026-10-29
 *   (second round, answer 3).
 * - BILLS-119sconres16, "Recognizing Black Women's Equal Pay Day", follows hconres42, an Equal Pay Day resolution
 *   overridden as ceremonial so that no title can untag it (2026-10-29, second round, answer 1). Its own official
 *   title, "A concurrent resolution recognizing the significance of equal pay and the disparity in wages paid to men
 *   and to Black women.", is the one sconres36's decision guards against.
 */
const CURATED_OVERRIDE_COMPANIONS: ReadonlyMap<string, string> = new Map([
  ["BILLS-119sconres34", "BILLS-119hconres107"],
  ["BILLS-119sconres16", "BILLS-119hconres42"],
]);

/**
 * Bills held for review (RUNBOOK 4.12, "Held for review"), keyed by plain guid: not tagged, whatever their titles,
 * until they are reviewed (then a guid in CURATED_OVERRIDES). Each would be tagged by a title rule
 * (most by the day, week and month clause) while its text takes a policy position the rule's guard does not catch, the
 * kind the curated overrides record as not ceremonial (hconres107, hres1365, hres1304, hres955, hconres112, hres440,
 * hres1528).
 * Held, each stays as it is in production today, or as it was before this pull request planned it: its topics and life
 * areas on its row, from GET /processed-bill and in push matching. The quotes are from the bill text (govinfo, read
 * 2026-10-29) unless said otherwise.
 */
const HELD_FOR_REVIEW: ReadonlyMap<string, string> = new Map([
  // The review of 2026-10-29 (second round).
  ["BILLS-119hconres53", "Support World Contraception Day and birth control access: a sense of the House on access"],
  ["BILLS-119hres375", "Renewable Fuels Month: its processed bill says it also sets up an E-15 council"],
  ["BILLS-119hres390", "Foster Care Month: 'encouraging Congress to implement policy' (official title)"],
  // The review of the second round's build (2026-10-29), from the bill text rather than the headline's paraphrase.
  ["BILLS-119hres756", "Voting Rights Month 2025: 'encourages Congress to pass' the Freedom to Vote Act"],
  ["BILLS-119sres854", "Voting Rights Month 2026: encourages Congress to pass voting rights legislation (its summary)"],
  ["BILLS-119hres662", "Black Breastfeeding Week: 'Congress must fully support and encourage policies'"],
  ["BILLS-119hres535", "Public Safety Awareness Day: 'commits to advancing policies that strengthen law enforcement'"],
  ["BILLS-119hres441", "Mental Health Awareness Month: 'declares mental health a national priority'"],
  [
    "BILLS-119sres743",
    "Children's Mental Health Week: 'urges youth mental health be categorized as a national priority'",
  ],
  ["BILLS-119hres524", "Sickle Cell Awareness Day 2025: 'commits to ensuring equitable access'; calls on HHS"],
  ["BILLS-119sres292", "Sickle Cell Awareness Day 2025: 'commits to ensuring equitable access'; calls on HHS"],
  ["BILLS-119hres1371", "Sickle Cell Awareness Day 2026: 'commits to ensuring equitable access'; calls on HHS"],
  ["BILLS-119sres780", "Sickle Cell Awareness Day 2026: 'commits to ensuring equitable access'; calls on HHS"],
  ["BILLS-119hres891", "Rural Health Day: 'a commitment to advancing policies to improve health care accessibility'"],
  ["BILLS-119hres1260", "AANHPI Mental Health Day: encourages health agencies 'to adopt laws, policies'"],
  ["BILLS-119sres714", "AANHPI Mental Health Day: encourages health agencies 'to adopt laws, policies'"],
  ["BILLS-119hres1039", "Black HIV/AIDS Awareness Day: asks HHS to prioritize Minority AIDS Initiative grants"],
  ["BILLS-119hres684", "Firearm Suicide Prevention Day: safe storage of firearms (hconres107's subject)"],
  ["BILLS-119hres523", "ASK Day 2025: secure storage of guns; professionals to discuss gun ownership with patients"],
  ["BILLS-119hres1373", "ASK Day 2026: secure storage of guns; professionals to discuss gun ownership with patients"],
  ["BILLS-119hres1514", "988 Day: 'Recognizing suicide as a serious public health problem' (hres1528's framing)"],
  ["BILLS-119sres853", "988 Day, the Senate's: hres1514's twin, untagged now, which its official title would tag"],
  [
    "BILLS-119hres1024",
    "Human Trafficking Prevention Month: 'urges ... secure borders, effective immigration enforcement'",
  ],
  ["BILLS-119hres735", "American Families Month: 'calls for policies that support nuclear families'"],
  ["BILLS-119hres753", "Peace Month: 'calls on Congress to promote peace' (its official title says so too)"],
  [
    "BILLS-119hres843",
    "Day of Political Prisoners: Government efforts to 'hold accountable those regimes', 'urges it to continue'",
  ],
  ["BILLS-119sres640", "International Women's Day: 'urges the United States Government'; 'to pursue policies'"],
  [
    "BILLS-119sres643",
    "Detransition Awareness Day: 'commits to fostering the biological reality of young men and women'",
  ],
]);

const CEREMONIAL_TYPES: ReadonlySet<BillTypeCode> = new Set(["hres", "sres", "hconres", "sconres"]);

// A day, week, month or year that designates one, not one that counts or dates: "this year", "every day", "one year
// after", "within a week", "a four-day work week", "fiscal year 2027", "Election Day" do not.
const DESIGNATED_PERIOD =
  "(?<!\\b(?:this|next|last|every|each|per|coming|one|two|three|four|five|fiscal|calendar|election|within an?|" +
  "after an?|in an?|for an?|once an?|-hour|-day)[\\s-])\\b(?:day|month|(?<!\\bwork[\\s-])week|(?<!\\bschool[\\s-])year)\\b";

// Official titles ("Expressing support for the designation of ...", "Recognizing ...") and generated
// headlines ("Recognize ...", "Designate ...", "Honor ..."). Anchored at the start of the title, after an
// optional "A resolution" or "A concurrent resolution" ("A resolution observing the 1-year anniversary of ...").
const CEREMONIAL_OPENING_RE = new RegExp(
  "^(?:a (?:concurrent )?resolution )?(?:" +
    [
      // "Expressing support for designation of ...", "... for the annual designation of ...", "Supports the designation
      // of ..." (Congress's titles for bills the day, week and month clause tags).
      "expressing support (?:for|of) (?:the )?(?:annual )?(?:designation|goals and ideals|observance|celebration|recognition)",
      "support(?:s|ing)? the (?:annual )?(?:designation|goals and ideals|observance|celebration|recognition)",
      // "Expressing support for July to be designated as Disability Pride Month." A day, week, month or year only:
      // "... to be designated as a foreign terrorist organization" is policy.
      "(?:expressing support for|supporting) [^.;]{1,80}? to be designated as [^.;]{0,100}?\\b(?:day|week|month|year)",
      // These name a day, week, month or year too: "Supporting the mission and goals of National Fentanyl Awareness Day",
      // "Supporting the contributions and goals of Lavender Growers Month", "Expressing support of the goal of celebrating
      // a "National Day of Honor and Respect"", "Supporting the contributions of Catholic schools ... and celebrating the
      // 52nd annual National Catholic Schools Week", "Expressing support for a "World Sickle Cell Awareness Day"",
      // "Expressing support for the month of April as "Sikh History Month"", "A resolution expressing support for
      // declaring 2026 the "Year of Math"", "Raising awareness and encouraging the prevention of stalking by designating
      // January 2026 as ...", "Original Black History Month Resolution of 2026". Without one they can be policy
      // ("Expressing support for declaring a national emergency"). A bare "Supporting the goals of" is left out:
      // "Supporting the goals of Overdose Awareness Day and strengthening efforts to combat the opioid crisis"
      // (BILLS-119hres666, whose headline the guard keeps) asks for more.
      `(?:expressing support (?:for|of)|support(?:s|ing)?) the (?:mission|contributions) and goals of [^.;]{0,100}?${DESIGNATED_PERIOD}`,
      `expressing support (?:for|of) the goal of (?:celebrating|recognizing|honou?ring|observing|commemorating) [^.;]{0,100}?${DESIGNATED_PERIOD}`,
      `support(?:s|ing)? the contributions of [^.;]{0,150}?${DESIGNATED_PERIOD}`,
      `expressing support for (?:the month of|an?) [^.;]{0,100}?${DESIGNATED_PERIOD}`,
      `expressing support for (?:declaring|designating|honou?ring|recognizing|celebrating|commemorating|observing) [^.;]{0,100}?${DESIGNATED_PERIOD}`,
      `raising awareness [^.;]{0,150}? by designating [^.;]{0,100}?${DESIGNATED_PERIOD}`,
      `original [^.;]{0,80}?${DESIGNATED_PERIOD} resolution of \\d{4}`,
      // "Encouraging the recognition of a National LGBTQ+ Servicemembers and Veterans Day."
      "encourag(?:e|es|ing) (?:the )?(?:recognition|designation|observance|celebration|commemoration)",
      "commend(?:s|ing)?",
      "designat(?:e|es|ing)",
      "recogniz(?:e|es|ing)",
      "honou?r(?:s|ing)?",
      "commemorat(?:e|es|ing)",
      "celebrat(?:e|es|ing)",
      "congratulat(?:e|es|ing)",
      "observ(?:e|es|ing)",
      "mark(?:s|ing)? the \\d",
      "remember(?:s|ing)?",
      "mourn(?:s|ing)?",
    ].join("|") +
    ")\\b",
  "i",
);

// Anything adversarial or policy-making anywhere in the title keeps it out.
const NOT_CEREMONIAL_RE =
  /\b(?:condemn\w*|censur\w*|impeach\w*|disapprov\w*|reprimand\w*|expel\w*|call(?:s|ing)? (?:on|for|upon)|urg(?:e|es|ing)|demand\w*|oppos\w*|reject\w*|denounc\w*|sense of (?:the )?(?:house|senate|congress))\b/i;

// What a generated headline adds when the resolution also asks for something (see the module comment). Only a
// headline that decides is held to it: an official title says "fighting" or "free" of what it honors ("the
// firefighters who died fighting the fire"), and asks through the verbs above. "fighter" is not "fight".
const NOT_CEREMONIAL_HEADLINE_RE =
  /\b(?:free|fight(?:s|ing)?|stop(?:s|ping)?|defend(?:s|ing)?|and support(?:s|ing)?)\b/i;

// A deciding headline that designates without a ceremonial verb (since 2026-10-29, second review round): it
// opens with one of these words and names a day, week, month or year anywhere after ("Make May ALS Awareness Month",
// "Support Blood Clot Awareness Month", "National Hazing Awareness Week", "Make 2026 the Year of Math"), one that
// designates (DESIGNATED_PERIOD: not "Make Medicare negotiate drug prices this year", "Supporting a 40-hour work week",
// "Create the budget for fiscal year 2027"). The exclusions and the guard above still apply.
const CEREMONIAL_HEADLINE_RE = new RegExp(
  `^(?:mak(?:e|ing)|declar(?:e|ing)|creat(?:e|ing)|nam(?:e|ing)|support(?:ing)?|national)\\b.*?${DESIGNATED_PERIOD}`,
  "i",
);

export interface CommemorativeInput {
  /**
   * The bill's guid, any form plainBillGuid accepts (a text-version suffix is ignored): a curated override of the bill
   * (CURATED_OVERRIDES, or its companion's: CURATED_OVERRIDE_COMPANIONS) stands over its titles, and a bill held for
   * review (HELD_FOR_REVIEW) is not tagged. Without it the titles decide.
   */
  guid?: unknown;
  /** Any form normalizeBillTypeCode accepts ("hres", "HRES", "H.Res.", "house-resolution"). */
  billType: unknown;
  /** Congress's official title. Preferred when present. */
  officialTitle?: string | null;
  /** The generated plain-language headline. Used only when there is no official title. */
  title?: string | null;
}

/**
 * The curated override for this bill (true: ceremonial), its own (CURATED_OVERRIDES) or its companion's
 * (CURATED_OVERRIDE_COMPANIONS), or undefined when its titles decide.
 */
export function curatedCommemorativeOverride(guid: unknown): boolean | undefined {
  const plain = plainBillGuid(guid);
  if (!plain) return undefined;
  return CURATED_OVERRIDES.get(plain) ?? CURATED_OVERRIDES.get(CURATED_OVERRIDE_COMPANIONS.get(plain) ?? "");
}

/**
 * The plain guid of the bill whose curated override this bill follows as its companion (CURATED_OVERRIDE_COMPANIONS),
 * or undefined when the override is the bill's own or there is none.
 */
export function curatedOverrideCompanionOf(guid: unknown): string | undefined {
  const plain = plainBillGuid(guid);
  return plain ? CURATED_OVERRIDE_COMPANIONS.get(plain) : undefined;
}

/**
 * Whether the bill is held for review (HELD_FOR_REVIEW): not tagged, whatever its titles, until it is reviewed.
 * A curated override of it stands over the hold.
 */
export function heldForReview(guid: unknown): boolean {
  const plain = plainBillGuid(guid);
  return plain !== null && HELD_FOR_REVIEW.has(plain);
}

/** True when the measure is a ceremonial simple or concurrent resolution (see the module comment). */
export function isCommemorativeResolution(input: CommemorativeInput): boolean {
  const decided = curatedCommemorativeOverride(input.guid);
  if (decided !== undefined) return decided;
  if (heldForReview(input.guid)) return false;
  const billType = normalizeBillTypeCode(input.billType);
  if (!billType || !CEREMONIAL_TYPES.has(billType)) return false;
  const official = typeof input.officialTitle === "string" ? input.officialTitle.trim() : "";
  if (official) return CEREMONIAL_OPENING_RE.test(official) && !NOT_CEREMONIAL_RE.test(official);
  const headline = typeof input.title === "string" ? input.title.trim() : "";
  if (!headline || NOT_CEREMONIAL_RE.test(headline) || NOT_CEREMONIAL_HEADLINE_RE.test(headline)) return false;
  if (CEREMONIAL_OPENING_RE.test(headline)) return true;
  return CEREMONIAL_HEADLINE_RE.test(headline);
}

/**
 * The input `isCommemorativeResolution` takes for a stored processed bill (processed-bills/<guid>.json, or a document
 * that wraps its raw snapshot in content.rawSnapshot), read as CreateBillsManifest reads it for the manifest row: the
 * guid (for a curated override), the type from its identifier, Congress's official title, and the headline the row
 * takes as its title. scripts/relabelCeremonialRows.ts reads the same, so it plans exactly the rows CreateBillsManifest
 * would relabel.
 */
export function processedBillCommemorativeInput(document: unknown): CommemorativeInput {
  const parsed = asRecord(document);
  const wrapped = asRecord(asRecord(parsed?.content)?.rawSnapshot);
  const raw = wrapped ?? parsed;
  const content = asRecord(raw?.content);
  const contentBill = asRecord(asRecord(content?.bill)?.bill) ?? asRecord(content?.bill);
  const identifier = asRecord(raw?.identifier) ?? asRecord(parsed?.identifier);
  const guid = raw?.guid ?? parsed?.guid ?? asRecord(raw?.metadata)?.guid ?? asRecord(parsed?.metadata)?.guid ?? null;
  const officialTitle = raw?.officialTitle ?? parsed?.officialTitle;
  const title =
    contentBill?.title ?? raw?.title ?? asRecord(parsed?.metadata)?.title ?? asRecord(raw?.metadata)?.title ?? null;
  return {
    guid: typeof guid === "string" ? guid : null,
    billType: identifier?.billType,
    officialTitle: typeof officialTitle === "string" ? officialTitle : null,
    title: typeof title === "string" ? title : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
