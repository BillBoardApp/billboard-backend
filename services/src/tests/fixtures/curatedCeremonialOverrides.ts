/**
 * The curated overrides of 2026-10-29 (shared/commemorativeResolutions.ts CURATED_OVERRIDES, docs/RUNBOOK.md 4.12): five
 * headline-decided resolutions (first round), and thirteen look-alikes the pull request asked about (second round).
 * Each bill's headline as its processed bill stores it today, and Congress's official title: the one its processed bill
 * stores, or else govinfo BILLSTATUS's (read 2026-10-29), which a re-summary stores at a later write.
 */
export interface CuratedCeremonialOverride {
  guid: string;
  billType: "hres" | "sres" | "hconres" | "sconres";
  billNumber: string;
  headline: string;
  officialTitle: string;
  /** The curated override: true is ceremonial (no topics, no life areas, no "new" push). */
  ceremonial: boolean;
  /** Its processed bill's topics and life areas (the life areas as the summarizer gave them). */
  subCategories: string[];
  lifeAreas: string[];
}

export const CURATED_CEREMONIAL_OVERRIDES: readonly CuratedCeremonialOverride[] = [
  {
    guid: "BILLS-119hres48",
    billType: "hres",
    billNumber: "48",
    headline: "Honor MLK and celebrate diversity",
    officialTitle:
      "Honoring Reverend Dr. Martin Luther King, Jr., by celebrating diversity, promoting tolerance, and condemning " +
      "hate.",
    ceremonial: true,
    subCategories: ["Social Justice"],
    lifeAreas: [],
  },
  {
    guid: "BILLS-119hres862",
    billType: "hres",
    billNumber: "862",
    headline: "Honor Buffalo Soldiers with commemorative stamp",
    officialTitle:
      "Expressing the sense of the House of Representatives that a commemorative postage stamp should be issued in " +
      "honor of the Buffalo Soldiers.",
    ceremonial: true,
    subCategories: ["Social Justice"],
    lifeAreas: [],
  },
  {
    guid: "BILLS-119hres1365",
    billType: "hres",
    billNumber: "1365",
    headline: "Recognize ARFID as serious eating disorder",
    officialTitle:
      "Recognizing Avoidant/Restrictive Food Intake Disorder (ARFID) as a serious feeding and eating disorder and " +
      "acknowledging the urgent need to advance awareness, early identification, research, and equitable access to " +
      "care.",
    ceremonial: false,
    subCategories: ["Healthcare"],
    lifeAreas: ["Health Insurance", "Medical Costs"],
  },
  {
    guid: "BILLS-119hconres107",
    billType: "hconres",
    billNumber: "107",
    headline: "Recognizing gun violence as a serious problem on America's 250th birthday",
    officialTitle:
      "Recognizing the importance of saving lives, reducing gun violence, and strengthening public safety as the " +
      "United States celebrates its 250th anniversary.",
    ceremonial: false,
    subCategories: ["Social Justice", "Healthcare"],
    lifeAreas: ["Health Insurance", "Medical Costs"],
  },
  {
    guid: "BILLS-119hres1304",
    billType: "hres",
    billNumber: "1304",
    headline: "Honoring DC military members denied voting rights",
    officialTitle:
      "Recognizing on Memorial Day, May 25, 2026, the denial of voting representation in Congress and full local " +
      "self-government through statehood for active duty servicemembers, National Guard members, reservists, " +
      "veterans, and their families who are residents of the District of Columbia.",
    ceremonial: false,
    subCategories: ["Elections and Voting"],
    lifeAreas: [],
  },
  // Second round, answer 1: a policy goal's importance or a need is not ceremonial (as hconres107)...
  {
    guid: "BILLS-119hres955",
    billType: "hres",
    billNumber: "955",
    headline: "Recognizes commitment to ending pediatric HIV/AIDS worldwide",
    officialTitle: "Recognizing the importance of a continued commitment to ending pediatric HIV/AIDS worldwide.",
    ceremonial: false,
    subCategories: [],
    lifeAreas: ["Health Insurance", "Medical Costs"],
  },
  {
    guid: "BILLS-119hconres112",
    billType: "hconres",
    billNumber: "112",
    headline: "Recognizes need to improve access to federal facilities",
    officialTitle:
      "Recognizing the need to improve physical access to many federally funded facilities for all persons of the " +
      "United States, particularly persons with disabilities.",
    ceremonial: false,
    subCategories: ["Civil Rights and Liberties", "Local vs. Federal Power"],
    lifeAreas: ["Local Development", "Transportation"],
  },
  // ...and the Equal Pay Day resolutions are ceremonial, whichever wage gap they recognize.
  {
    guid: "BILLS-119hconres81",
    billType: "hconres",
    billNumber: "81",
    headline: "Recognizes wage disparity between men and women",
    officialTitle: "Recognizing the significance of equal pay and the disparity between wages paid to men and women.",
    ceremonial: true,
    subCategories: ["Labor and Employment", "Social Justice"],
    lifeAreas: ["Taxes"],
  },
  {
    guid: "BILLS-119hconres42",
    billType: "hconres",
    billNumber: "42",
    headline: "Recognizing wage gap for Black women",
    officialTitle:
      "Recognizing the significance of equal pay and the disparity in wages paid to men and to Black women.",
    ceremonial: true,
    subCategories: ["Labor and Employment", "Social Justice"],
    lifeAreas: ["Taxes"],
  },
  {
    guid: "BILLS-119sconres36",
    billType: "sconres",
    billNumber: "36",
    headline: "Recognizing wage gap between men and Black women",
    officialTitle:
      "A concurrent resolution recognizing the significance of equal pay and the disparity in wages paid to men and " +
      "to Black women.",
    ceremonial: true,
    subCategories: ["Labor and Employment", "Social Justice"],
    lifeAreas: ["Taxes"],
  },
  {
    guid: "BILLS-119hconres114",
    billType: "hconres",
    billNumber: "114",
    headline: "Recognizes wage gap between Black women and white men",
    officialTitle:
      "Recognizing the significance of equal pay and the disparity in wages paid to men and to Black women.",
    ceremonial: true,
    subCategories: [],
    lifeAreas: ["Taxes"],
  },
  {
    guid: "BILLS-119hconres56",
    billType: "hconres",
    billNumber: "56",
    headline: "Recognizes wage gap between Latina and White men",
    officialTitle:
      "Recognizing the significance of equal pay and the disparity in wages paid to Latina women in comparison to " +
      "White, non-Hispanic men.",
    ceremonial: true,
    subCategories: [],
    lifeAreas: ["Taxes"],
  },
  {
    guid: "BILLS-119hconres123",
    billType: "hconres",
    billNumber: "123",
    headline: "Recognizes wage disparity for Latina workers",
    officialTitle:
      "Recognizing the disparity in wages paid to Latinas and the impact of that disparity on women, families, the " +
      "economy, and the United States.",
    ceremonial: true,
    subCategories: [],
    lifeAreas: ["Taxes"],
  },
  {
    guid: "BILLS-119hres829",
    billType: "hres",
    billNumber: "829",
    headline: "Recognizes pay disparity affecting disabled women workers",
    officialTitle:
      "Recognizing the significance of equal pay and the pay disparity between disabled women and both disabled " +
      "and nondisabled men.",
    ceremonial: true,
    subCategories: [],
    lifeAreas: ["Taxes"],
  },
  // Second round, answer 2: hres440 and hres1528 are not ceremonial (as hres1304 and hres1365)...
  {
    guid: "BILLS-119hres440",
    billType: "hres",
    billNumber: "440",
    headline: "Honoring DC military members denied voting rights",
    officialTitle:
      "Recognizing on Memorial Day, May 26, 2025, the denial of voting representation in Congress and full local " +
      "self-government through statehood for active duty servicemembers, National Guard members, reservists, " +
      "veterans, and their families who are residents of the District of Columbia.",
    ceremonial: false,
    subCategories: [],
    lifeAreas: ["Taxes"],
  },
  {
    guid: "BILLS-119hres1528",
    billType: "hres",
    billNumber: "1528",
    headline: "Recognize suicide prevention as a national health priority",
    officialTitle:
      "Recognizing suicide as a serious public health problem and expressing support for the designation of " +
      'September, 2026, as "National Suicide Prevention Month" as well as September 10, 2026, as "World Suicide ' +
      'Prevention Day".',
    ceremonial: false,
    subCategories: [],
    lifeAreas: ["Health Insurance", "Medical Costs"],
  },
  // ...and sres738 and hres819 are (as hres48), though their headlines fight or stop hate.
  {
    guid: "BILLS-119sres738",
    billType: "sres",
    billNumber: "738",
    headline: "Celebrate Jewish American Heritage Month and fight hate",
    officialTitle:
      "A resolution recognizing the significance of Jewish American Heritage Month and calling on elected officials " +
      "and civil society leaders to counter antisemitism.",
    ceremonial: true,
    subCategories: ["Social Justice", "Identity Politics"],
    lifeAreas: [],
  },
  {
    guid: "BILLS-119hres819",
    billType: "hres",
    billNumber: "819",
    headline: "Honoring Indian Americans and stopping racism against them",
    officialTitle:
      "Recognizing the contributions made to the United States by the Indian American diaspora and condemning " +
      "recent acts of racism against Indian Americans.",
    ceremonial: true,
    subCategories: ["Social Justice", "Identity Politics"],
    lifeAreas: [],
  },
];

/** Each decision twice: as its processed bill is stored today (headline only), and with its official title. */
export const CURATED_OVERRIDE_CASES = CURATED_CEREMONIAL_OVERRIDES.flatMap((decision) => [
  { ...decision, titles: "the headline alone", officialTitle: undefined as string | undefined },
  { ...decision, titles: "its official title", officialTitle: decision.officialTitle as string | undefined },
]).map((decision) => [decision.guid, decision.titles, decision] as const);
