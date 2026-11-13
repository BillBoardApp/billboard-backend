/**
 * The bills held for review (shared/commemorativeResolutions.ts HELD_FOR_REVIEW, RUNBOOK 4.12
 * "Held for review"): each bill's headline as its processed bill stores it today, and Congress's official title,
 * the one its processed bill stores (sres854) or else its bill text's (govinfo, read 2026-10-29), which a re-summary
 * stores at a later write. Without the hold, a title rule would tag each: byHeadline and byOfficialTitle say which.
 */
export interface HeldForReviewBill {
  guid: string;
  billType: "hres" | "sres" | "hconres" | "sconres";
  headline: string;
  officialTitle: string;
  /** What the rule decides by the headline alone, and by the official title, without the hold. */
  byHeadline: boolean;
  byOfficialTitle: boolean;
}

export const HELD_FOR_REVIEW_BILLS: readonly HeldForReviewBill[] = [
  {
    guid: "BILLS-119hconres53",
    billType: "hconres",
    headline: "Support World Contraception Day and birth control access",
    officialTitle:
      "Expressing support for the recognition of September 26, 2025, as World Contraception Day and expressing the " +
      "sense of the House of Representatives regarding global and domestic access to contraception.",
    byHeadline: true,
    byOfficialTitle: false,
  },
  {
    guid: "BILLS-119hres375",
    billType: "hres",
    headline: "Make May 2025 Renewable Fuels Month",
    officialTitle:
      "Expressing support for the designation of May 2025 as Renewable Fuels Month to recognize the important role " +
      "that renewable fuels play in reducing carbon impacts, lowering fuel prices for consumers, supporting rural " +
      "communities, and lessening reliance on foreign adversaries.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres390",
    billType: "hres",
    headline: "Support Foster Care Month and Help Kids in the System",
    officialTitle:
      "Recognizing National Foster Care Month as an opportunity to raise awareness about the challenges of " +
      "children in the foster care system and encouraging Congress to implement policy to improve the lives of " +
      "children in, or at risk of entering, the foster care system.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres756",
    billType: "hres",
    headline: "Make September 2025 National Voting Rights Month",
    officialTitle: "Supporting the designation of September 2025 as National Voting Rights Month.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119sres854",
    billType: "sres",
    headline: "Designates September 2026 as National Voting Rights Month",
    officialTitle: "Designating September 2026 as National Voting Rights Month.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres662",
    billType: "hres",
    headline: "Support for Black Breastfeeding Week",
    officialTitle:
      "Expressing support for the designation of the week of August 25 through August 31, 2025, as Black " +
      "Breastfeeding Week.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres535",
    billType: "hres",
    headline: "Create a Public Safety Awareness Day",
    officialTitle:
      "Recognizing June 24th as Public Safety Awareness Day to promote citizen empowerment, effective law " +
      "enforcement, community-based crime prevention, and prudent public policy in support of safer neighborhoods " +
      "nationwide.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres441",
    billType: "hres",
    headline: "Support Mental Health Awareness Month in May",
    officialTitle: "Expressing support for the designation of May 2025 as Mental Health Awareness Month.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119sres743",
    billType: "sres",
    headline: "Declare May 3-9 as Kids' Mental Health Week",
    officialTitle:
      "Supporting the designation of May 3 through May 9, 2026, as Children's Mental Health Awareness Week.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres524",
    billType: "hres",
    headline: "Make June 19 Sickle Cell Awareness Day",
    officialTitle:
      "Expressing support for the designation of June 19, 2025, as World Sickle Cell Awareness Day in order to " +
      "increase public awareness across the United States and global community about sickle cell disease and the " +
      "continued need for empirical research, early detection screenings, novel effective treatments leading to a " +
      "cure, and preventative care programs with respect to complications from sickle cell anemia and conditions " +
      "relating to sickle cell disease.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119sres292",
    billType: "sres",
    headline: "Support World Sickle Cell Awareness Day",
    officialTitle:
      "Expressing support for the designation of June 19, 2025, as World Sickle Cell Awareness Day in order to " +
      "increase public awareness across the United States and global community about sickle cell disease and the " +
      "continued need for empirical research, early detection screenings, novel effective treatments leading to a " +
      "cure, and preventative care programs with respect to complications from sickle cell anemia and conditions " +
      "relating to sickle cell disease.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres1371",
    billType: "hres",
    headline: "Support World Sickle Cell Awareness Day",
    officialTitle:
      "Expressing support for a World Sickle Cell Awareness Day in order to increase public awareness across the " +
      "United States and global community about sickle cell disease and the continued need for empirical research, " +
      "early detection screenings, novel effective treatments leading to a cure, and preventative care programs " +
      "with respect to complications from sickle cell anemia and conditions relating to sickle cell disease.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119sres780",
    billType: "sres",
    headline: "Make June 19 World Sickle Cell Awareness Day",
    officialTitle:
      "Expressing support for the designation of June 19, 2026, as World Sickle Cell Awareness Day in order to " +
      "increase public awareness across the United States and global community about sickle cell disease and the " +
      "continued need for empirical research, early detection screenings, novel effective treatments leading to a " +
      "cure, and preventative care programs with respect to complications from sickle cell anemia and conditions " +
      "relating to sickle cell disease.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres891",
    billType: "hres",
    headline: "Support National Rural Health Day",
    officialTitle: "Supporting the goals and ideals of National Rural Health Day.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres1260",
    billType: "hres",
    headline: "Create Mental Health Day for Asian Americans and Pacific Islanders",
    officialTitle:
      "Supporting the designation of May 10, 2026, as National Asian American, Native Hawaiian, and Pacific " +
      "Islander Mental Health Day.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119sres714",
    billType: "sres",
    headline: "Create National Asian American Mental Health Day",
    officialTitle:
      "Supporting the designation of May 10, 2026, as National Asian American, Native Hawaiian, and Pacific " +
      "Islander Mental Health Day.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres1039",
    billType: "hres",
    headline: "Support Black HIV/AIDS Awareness Day",
    officialTitle: "Supporting the goals and ideals of National Black HIV/AIDS Awareness Day.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres684",
    billType: "hres",
    headline: "Making September 9 National Firearm Suicide Prevention Day",
    officialTitle:
      "Expressing support for the designation of September 9, 2025, as National Firearm Suicide Prevention Day to " +
      "educate about the growing firearm suicide crisis in the United States and promote the importance of storing " +
      "firearms safely and securely as an essential component of suicide prevention.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres523",
    billType: "hres",
    headline: "National ASK Day for gun safety talks with kids",
    officialTitle:
      "Expressing support for the designation of June 21, 2025, as National ASK (Asking Saves Kids) Day to promote " +
      "children’s health and secure storage of guns in the home.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres1373",
    billType: "hres",
    headline: "Create National Day for Safe Gun Storage",
    officialTitle:
      "Expressing support for the designation of June 21, 2026, as National ASK (Asking Saves Kids) Day to promote " +
      "children’s health and secure storage of guns in the home.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres1514",
    billType: "hres",
    headline: "Making September 8 'Suicide Prevention Day' to honor 988 lifeline",
    officialTitle:
      "Recognizing suicide as a serious public health problem, expressing support for the designation of September " +
      "8, 2026, as 988 Day and the role of the 988 Suicide and Crisis Lifeline, and for other purposes.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119sres853",
    billType: "sres",
    headline: "Recognition of 988 Suicide Lifeline and Mental Health Awareness Day",
    officialTitle:
      "Recognizing suicide as a serious public health problem and expressing support for the designation of " +
      "September 8, 2026, as 988 Day and the role of 988 Suicide and Crisis Lifeline.",
    byHeadline: false,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres1024",
    billType: "hres",
    headline: "Declare January as Human Trafficking Prevention Month",
    officialTitle:
      "Expressing support for the designation of January 2026 as National Human Trafficking Prevention Month.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres735",
    billType: "hres",
    headline: "Making July American Families Month",
    officialTitle: "Supporting the designation of the month of July as American Families Month.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119hres753",
    billType: "hres",
    headline: "Make September 2025 Peace Month",
    officialTitle:
      "Expressing support for the designation of September 2025 as Peace Month and calling on Congress to take " +
      "action to promote peace.",
    byHeadline: true,
    byOfficialTitle: false,
  },
  {
    guid: "BILLS-119hres843",
    billType: "hres",
    headline: "Make October 30 the International Day of Political Prisoners",
    officialTitle: "Supporting the designation of October 30 as the International Day of Political Prisoners.",
    byHeadline: true,
    byOfficialTitle: true,
  },
  {
    guid: "BILLS-119sres640",
    billType: "sres",
    headline: "Support International Women's Day Goals",
    officialTitle: "Supporting the goals of International Women’s Day.",
    byHeadline: true,
    byOfficialTitle: false,
  },
  {
    guid: "BILLS-119sres643",
    billType: "sres",
    headline: "Make March 12 'Detransition Awareness Day'",
    officialTitle: "Designating March 12, 2026, as Detransition Awareness Day.",
    byHeadline: true,
    byOfficialTitle: true,
  },
];

/**
 * Each held bill twice, as service tests take it: by the headline its processed bill has now, and with the official
 * title a re-summary stores; billNumber from the guid.
 */
export const HELD_FOR_REVIEW_CASES = HELD_FOR_REVIEW_BILLS.flatMap((bill) => {
  const billNumber = bill.guid.replace(/^BILLS-\d+[a-z]+/, "");
  return [
    { ...bill, billNumber, titles: "the headline alone", officialTitle: undefined as string | undefined },
    { ...bill, billNumber, titles: "its official title", officialTitle: bill.officialTitle as string | undefined },
  ];
}).map((bill) => [bill.guid, bill.titles, bill] as const);
