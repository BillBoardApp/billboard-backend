import {
  heldForReview,
  isCommemorativeResolution,
  curatedCommemorativeOverride,
  curatedOverrideCompanionOf,
  processedBillCommemorativeInput,
} from "../shared/commemorativeResolutions";
import { HELD_FOR_REVIEW_BILLS } from "./fixtures/heldForReview";
import { CURATED_CEREMONIAL_OVERRIDES, CURATED_OVERRIDE_CASES } from "./fixtures/curatedCeremonialOverrides";

describe("isCommemorativeResolution", () => {
  it.each([
    [
      "hres",
      'Expressing support for the designation of October 20 through October 24, 2025, as "Careers in Energy Week".',
    ],
    ["hres", "Recognizing the week of October 26 through November 1, 2026, as Community Health Workers Week."],
    ["sres", "Designating October 2026 as National Domestic Violence Awareness Month."],
    ["sres", "Honoring the life and legacy of a former Senator."],
    ["hconres", "Commemorating the 250th anniversary of the founding of the Navy."],
    ["hres", "Congratulating the champions of the 2026 Little League World Series."],
    ["hres", "Supporting the goals and ideals of National Apprenticeship Week."],
    ["HRES", "Celebrating the 100th anniversary of the national park."],
    ["H.Res.", "Recognizing National LGBTQ+ Servicemembers and Veterans Day."],
    ["house-resolution", "Observing the 80th anniversary of the end of World War II."],
    // Official titles the first rule missed (dry run of 2026-10-29); BILLS-119hres1572 is a card seen in the app.
    ["hres", "Encouraging the recognition of a National LGBTQ+ Servicemembers and Veterans Day."],
    ["hres", "Expressing support for July to be designated as Disability Pride Month."],
    [
      "sres",
      "Commending and congratulating Texas A&M University for 150 years of service to the State of Texas and the United States.",
    ],
    ["hres", "A resolution observing the 1-year anniversary of the 2025 Southern California wildfires."],
    ["sres", "Supporting the week of May 4 to be designated as National Nurses Week."],
    // Congress's titles for bills the day, week and month clause tags (govinfo BILLSTATUS and bill text, 2026-10-29),
    // so that a re-summary that stores one keeps the bill tagged.
    [
      "sconres",
      "A concurrent resolution supporting the goals and ideals of International Transgender Day of Visibility.",
    ],
    [
      "sconres",
      "A concurrent resolution recognizing the significance of equal pay and the disparity in wages paid to men and to " +
        "Black women.",
    ],
    [
      "hres",
      'Expressing support for designation of the first Friday of October, October 2, 2026, as "Manufacturing Day".',
    ],
    [
      "sres",
      'A resolution expressing support for the annual designation of the first Saturday after the Spring Equinox as "National Day of Play".',
    ],
    ["hres", 'Supports the designation of "ALS Awareness Month".'],
    [
      "hres",
      "Supporting the mission and goals of National Fentanyl Awareness Day in 2026, including increasing individual " +
        "and public awareness of the impact of fake or counterfeit fentanyl pills on families and young people.",
    ],
    ["hres", "Supporting the contributions and goals of Lavender Growers Month."],
    [
      "hres",
      'Expressing support of the goal of celebrating a "National Day of Honor and Respect" in conjunction with ' +
        '"Constitution Day and Citizenship Day".',
    ],
    [
      "sres",
      "A resolution supporting the contributions of Catholic schools in the United States and celebrating the 52nd " +
        "annual National Catholic Schools Week.",
    ],
    ["hres", 'Expressing support for the month of April as "Sikh History Month".'],
    ["sres", 'A resolution expressing support for declaring 2026 the "Year of Math" in the United States.'],
    [
      "hres",
      "Raising awareness and encouraging the prevention of stalking by designating January 2026 as " +
        '"National Stalking Awareness Month".',
    ],
    ["hres", "Original Black History Month Resolution of 2026"],
    ["hres", "Expressing support for honoring Earth Day, and for other purposes."],
  ])("tags a %s official title: %s", (billType, officialTitle) => {
    expect(isCommemorativeResolution({ billType, officialTitle })).toBe(true);
  });

  it("falls back to the generated headline when there is no official title", () => {
    expect(isCommemorativeResolution({ billType: "hres", title: "Recognize Community Health Workers Week" })).toBe(
      true,
    );
    expect(
      isCommemorativeResolution({
        billType: "hres",
        officialTitle: "  ",
        title: "Designate October 20-24, 2025 as Careers in Energy Week",
      }),
    ).toBe(true);
  });

  it("prefers the official title over the headline", () => {
    expect(
      isCommemorativeResolution({
        billType: "hres",
        officialTitle: "Providing for consideration of the bill (H.R. 77) to amend the Clean Air Act.",
        title: "Recognize the work of clean-air inspectors",
      }),
    ).toBe(false);
  });

  it.each([
    [
      "hr",
      "Designating the facility of the United States Postal Service located at 1 Main Street as the Jane Doe Post Office.",
    ],
    ["s", "Recognizing the contributions of veterans by establishing a new benefit."],
    ["hjres", "Designating the bald eagle as the national bird."],
    ["sjres", "Recognizing a disapproval under chapter 8 of title 5."],
  ])("never tags a %s, which can become law: %s", (billType, officialTitle) => {
    expect(isCommemorativeResolution({ billType, officialTitle })).toBe(false);
  });

  it.each([
    "Condemning the attack on the embassy and recognizing the courage of its staff.",
    "Recognizing the threat posed by the regime and calling on the President to impose sanctions.",
    "Impeaching a Federal judge for high crimes and misdemeanors.",
    "Censuring Representative Doe.",
    "Recognizing the anniversary of the strike and urging the Secretary to act.",
    "Expressing the sense of the House of Representatives that the program should be reauthorized.",
    "Recognizing the importance of the alliance and opposing any withdrawal of troops.",
    "Providing for consideration of the bill (H.R. 77) to amend the Clean Air Act.",
    "Electing Members to certain standing committees of the House of Representatives.",
    "Expressing support for a balanced budget amendment.",
    // The wider openings keep the same exclusions.
    "Encouraging the recognition of a national day and urging the Secretary of Defense to review discharges.",
    "Commending the people of Taiwan and calling on the President to support their membership in the assembly.",
    "A resolution recognizing the anniversary of the coup and condemning the junta.",
    "Expressing support for the Muslim Brotherhood to be designated as a foreign terrorist organization.",
    "Encouraging States to adopt paid family leave.",
    "A resolution to amend the Rules of the House of Representatives.",
    // The openings Congress uses for the clause's bills name a day, week, month or year; without one they are policy.
    // A bare "Supporting the goals of" is left out (BILLS-119hres666, whose headline the guard keeps).
    "Supporting the goals of Overdose Awareness Day and strengthening efforts to combat the opioid crisis in the United States.",
    "Supporting the goals of the Paris Agreement.",
    "Expressing support for a balanced budget amendment.",
    "Expressing support for declaring a national emergency on housing.",
    "Expressing support for recognizing Taiwan as a sovereign nation.",
    "Supporting the contributions of immigrants to the economy.",
    "Expressing support for a ceasefire within a week.",
    "A concurrent resolution expressing the sense of Congress that a stamp should be issued for Navy Day.",
  ])("does not tag a resolution that is not ceremonial: %s", (officialTitle) => {
    expect(isCommemorativeResolution({ billType: "hres", officialTitle })).toBe(false);
  });

  it("is false without a usable bill type or title", () => {
    expect(isCommemorativeResolution({ billType: undefined, officialTitle: "Recognizing a week." })).toBe(false);
    expect(isCommemorativeResolution({ billType: "unknown", officialTitle: "Recognizing a week." })).toBe(false);
    expect(isCommemorativeResolution({ billType: "hres" })).toBe(false);
    expect(isCommemorativeResolution({ billType: "hres", officialTitle: null, title: null })).toBe(false);
  });

  it.each([
    // Planned by the dry run of 2026-10-29 until this rule; their documents have no official title.
    "Celebrate Jimmy Lai and Free Hong Kong Activists",
    "Honoring US-Philippines friendship and defending against China",
    "Honoring Indian Americans and stopping racism against them",
    "Recognize post-9/11 discrimination and support affected people",
    "Recognize Overdose Awareness Day and fight the opioid crisis",
    "Celebrate Jewish American Heritage Month and fight hate",
    "Celebrate America's 250th Birthday and Support Better Healthcare",
    "Recognize the anniversary of the strike and call on the Secretary to act",
  ])("does not tag a headline that also asks for something, when it decides: %s", (title) => {
    expect(isCommemorativeResolution({ billType: "hres", title })).toBe(false);
    expect(isCommemorativeResolution({ billType: "hres", officialTitle: " ", title })).toBe(false);
  });

  it("holds only a deciding headline to those words", () => {
    // An official title names them of what it honors, and asks through "calling on" or "urging".
    expect(
      isCommemorativeResolution({
        billType: "hres",
        officialTitle: "Honoring the firefighters who died fighting the Palisades fire.",
        title: "Honor firefighters and fight wildfires",
      }),
    ).toBe(true);
    expect(
      isCommemorativeResolution({
        billType: "sres",
        officialTitle: "Recognizing the 35th anniversary of the Free Trade Agreement with Canada.",
      }),
    ).toBe(true);
    // "fighter" is not "fight", and a support that opens the headline is not an added ask.
    expect(
      isCommemorativeResolution({ billType: "hres", title: "Honoring 30 years of the Super Hornet fighter jet" }),
    ).toBe(true);
    expect(
      isCommemorativeResolution({
        billType: "hres",
        title: "Honoring Columbine victims and celebrating community service",
      }),
    ).toBe(true);
  });

  it("matches only at the start of the title", () => {
    expect(
      isCommemorativeResolution({
        billType: "hres",
        officialTitle: "Amending the rules and recognizing a new caucus.",
      }),
    ).toBe(false);
  });
});

describe("the curated overrides of 2026-10-29", () => {
  it.each(CURATED_OVERRIDE_CASES)("%s is decided by its curated override, by %s", (_guid, _titles, decision) => {
    const { guid, billType, headline, officialTitle, ceremonial } = decision;
    expect(isCommemorativeResolution({ guid, billType, officialTitle, title: headline })).toBe(ceremonial);
    // A suffixed guid is the same bill.
    expect(isCommemorativeResolution({ guid: `${guid}ih`, billType, officialTitle, title: headline })).toBe(ceremonial);
    expect(curatedCommemorativeOverride(guid)).toBe(ceremonial);
  });

  it("is what stands between each bill and its titles, which alone would decide most of them otherwise", () => {
    const byTitles = CURATED_CEREMONIAL_OVERRIDES.map(({ guid, billType, headline, officialTitle }) => ({
      guid,
      headline: isCommemorativeResolution({ billType, title: headline }),
      officialTitle: isCommemorativeResolution({ billType, officialTitle, title: headline }),
    }));
    expect(byTitles).toEqual([
      // Ceremonial, though the official title condemns hate.
      { guid: "BILLS-119hres48", headline: true, officialTitle: false },
      // Ceremonial, though the official title is a sense of the House.
      { guid: "BILLS-119hres862", headline: true, officialTitle: false },
      // Not ceremonial, though both titles open with "Recognizing" or "Honoring" and ask for nothing in words.
      { guid: "BILLS-119hres1365", headline: true, officialTitle: true },
      { guid: "BILLS-119hconres107", headline: true, officialTitle: true },
      { guid: "BILLS-119hres1304", headline: true, officialTitle: true },
      // Second round. Not ceremonial, though both titles recognize: a policy goal's importance, a need.
      { guid: "BILLS-119hres955", headline: true, officialTitle: true },
      { guid: "BILLS-119hconres112", headline: true, officialTitle: true },
      // Ceremonial, Equal Pay Day: the titles agree today, and the list holds them against a later title (sconres36's
      // "A concurrent resolution recognizing ..." untagged it until "A concurrent resolution" was an opening).
      { guid: "BILLS-119hconres81", headline: true, officialTitle: true },
      { guid: "BILLS-119hconres42", headline: true, officialTitle: true },
      { guid: "BILLS-119sconres36", headline: true, officialTitle: true },
      { guid: "BILLS-119hconres114", headline: true, officialTitle: true },
      { guid: "BILLS-119hconres56", headline: true, officialTitle: true },
      { guid: "BILLS-119hconres123", headline: true, officialTitle: true },
      { guid: "BILLS-119hres829", headline: true, officialTitle: true },
      // Not ceremonial, as hres1304 and hres1365, though both titles honor or recognize.
      { guid: "BILLS-119hres440", headline: true, officialTitle: true },
      { guid: "BILLS-119hres1528", headline: true, officialTitle: true },
      // Ceremonial, as hres48, though the headline fights or stops hate and the official title calls on or condemns.
      { guid: "BILLS-119sres738", headline: false, officialTitle: false },
      { guid: "BILLS-119hres819", headline: false, officialTitle: false },
    ]);
  });

  it("decides H.Con.Res. 107's identical Senate companion, S.Con.Res. 34, as H.Con.Res. 107's curated override decides it", () => {
    const sconres34 = { guid: "BILLS-119sconres34", billType: "sconres" };
    const headline = "Recognizing gun violence as a public health problem on America's 250th birthday";
    expect(isCommemorativeResolution({ ...sconres34, title: headline })).toBe(false);
    expect(
      isCommemorativeResolution({
        ...sconres34,
        officialTitle:
          "A concurrent resolution recognizing the importance of saving lives, reducing gun violence, and strengthening " +
          "public safety as the United States celebrates its 250th anniversary.",
        title: headline,
      }),
    ).toBe(false);
    // Its headline alone would tag it, and the Brief shows the pair as one item, ceremonial when either is. The review
    // kept it so (2026-10-29, second round, answer 3).
    expect(isCommemorativeResolution({ billType: "sconres", title: headline })).toBe(true);
    // Named as a companion's, not as an override of S.Con.Res. 34 itself.
    expect(curatedCommemorativeOverride("BILLS-119sconres34is")).toBe(false);
    expect(curatedOverrideCompanionOf("BILLS-119sconres34is")).toBe("BILLS-119hconres107");
    for (const { guid } of CURATED_CEREMONIAL_OVERRIDES) expect(curatedOverrideCompanionOf(guid)).toBeUndefined();
    expect(curatedOverrideCompanionOf("BILLS-119hres440")).toBeUndefined();
  });

  it("decides S.Con.Res. 16, H.Con.Res. 42's identical Senate companion, as the curated overrides decide the Equal Pay Day resolutions", () => {
    // BILLS-119sconres16, "Recognizing Black Women's Equal Pay Day": a published companion of hconres42 (pairsVersion
    // 25), which a curated override makes ceremonial so that no title can untag it (2026-10-29, second round, answer 1).
    const sconres16 = {
      guid: "BILLS-119sconres16",
      billType: "sconres",
      title: "Recognizing Black Women's Equal Pay Day",
    };
    const officialTitle =
      "A concurrent resolution recognizing the significance of equal pay and the disparity in wages paid to men and to " +
      "Black women.";
    expect(isCommemorativeResolution(sconres16)).toBe(true);
    expect(isCommemorativeResolution({ ...sconres16, officialTitle })).toBe(true);
    // Under any later title, as hconres42 is.
    expect(
      isCommemorativeResolution({ ...sconres16, officialTitle: "Recognizing the pay gap and urging action." }),
    ).toBe(true);
    expect(curatedCommemorativeOverride("BILLS-119sconres16is")).toBe(true);
    expect(curatedOverrideCompanionOf("BILLS-119sconres16")).toBe("BILLS-119hconres42");
  });

  it("leaves every other bill to its titles", () => {
    expect(curatedCommemorativeOverride("BILLS-119hres613")).toBeUndefined();
    expect(curatedCommemorativeOverride("BILLS-118hres48")).toBeUndefined();
    expect(curatedCommemorativeOverride("BILLS-118hres440")).toBeUndefined();
    expect(curatedCommemorativeOverride(undefined)).toBeUndefined();
    expect(curatedCommemorativeOverride("not a guid")).toBeUndefined();
    // hres1304's headline on a bill with no curated override (another Congress's): its titles decide.
    expect(
      isCommemorativeResolution({
        guid: "BILLS-118hres440",
        billType: "hres",
        title: "Honoring DC military members denied voting rights",
      }),
    ).toBe(true);
    expect(
      isCommemorativeResolution({
        guid: "BILLS-119hres1572",
        billType: "hres",
        officialTitle: "Condemning the attack on the embassy.",
      }),
    ).toBe(false);
  });
});

describe("the second review round of 2026-10-29: the look-alikes now agree with the first five overrides", () => {
  // Each bill as its processed bill stores it now (the headline) and once a re-summary stores Congress's title.
  const decision = (guid: string) => CURATED_CEREMONIAL_OVERRIDES.find((entry) => entry.guid === guid)!;
  const verdicts = (guid: string) => {
    const { billType, headline, officialTitle } = decision(guid);
    return [
      isCommemorativeResolution({ guid, billType, title: headline }),
      isCommemorativeResolution({ guid, billType, officialTitle, title: headline }),
    ];
  };

  it("leaves BILLS-119hres440 untagged as hres1304, whose headline it shares (answer 2)", () => {
    expect(decision("BILLS-119hres440").headline).toBe(decision("BILLS-119hres1304").headline);
    expect(verdicts("BILLS-119hres440")).toEqual([false, false]);
    expect(verdicts("BILLS-119hres1304")).toEqual([false, false]);
  });

  it("leaves BILLS-119hres1528, a national health priority, untagged as hres1365 (answer 2)", () => {
    expect(verdicts("BILLS-119hres1528")).toEqual([false, false]);
    expect(verdicts("BILLS-119hres1365")).toEqual([false, false]);
  });

  it("tags BILLS-119sres738 and hres819, which fight or stop hate, as hres48, which condemns it (answer 2)", () => {
    expect(verdicts("BILLS-119sres738")).toEqual([true, true]);
    expect(verdicts("BILLS-119hres819")).toEqual([true, true]);
    expect(verdicts("BILLS-119hres48")).toEqual([true, true]);
  });

  it("leaves BILLS-119hres955 and hconres112, a policy goal's importance and a need, untagged as hconres107 (answer 1)", () => {
    expect(verdicts("BILLS-119hres955")).toEqual([false, false]);
    expect(verdicts("BILLS-119hconres112")).toEqual([false, false]);
    expect(verdicts("BILLS-119hconres107")).toEqual([false, false]);
  });

  it.each([
    "BILLS-119hconres81",
    "BILLS-119hconres42",
    "BILLS-119sconres36",
    "BILLS-119hconres114",
    "BILLS-119hconres56",
    "BILLS-119hconres123",
    "BILLS-119hres829",
  ])("tags the Equal Pay Day resolution %s, by either title (answer 1)", (guid) => {
    expect(verdicts(guid)).toEqual([true, true]);
  });
});

describe("a deciding headline that designates a day, week, month or year (answer 4, 2026-10-29)", () => {
  it.each([
    "Make May ALS Awareness Month",
    'Make July "Disability Pride Month"',
    "Make May the month to talk about periods",
    "Making September 9 National Firearm Suicide Prevention Day",
    "Declare National Clean Energy Week",
    "Declaring National Diaper Need Awareness Week",
    "Create National Day of Play celebration",
    // "Creating" and "Naming" are the -ing forms of the designating verbs Create and Name, as Making and Declaring are.
    "Creating National Scam Prevention Day",
    "Name September 2026 National Literacy Month",
    "Naming October 2026 National Book Month",
    "Support Blood Clot Awareness Month",
    "Supporting Music in Our Schools Month",
    "National Hazing Awareness Week",
    "Make 2026 the Year of Math",
    "Declare 2026 National Year of Volunteer",
    "Make October 26 a Day to Honor Deployed Soldiers",
    // A word that counts or dates a period before only some of the period words: "work week", "school year".
    "Make March Social Work Month",
    "Make October 8 National Walk to School Day",
    "Support National Small Business Week",
  ])("tags %s", (title) => {
    expect(isCommemorativeResolution({ billType: "hres", title })).toBe(true);
    expect(isCommemorativeResolution({ billType: "sconres", officialTitle: " ", title })).toBe(true);
    // Never a bill or a joint resolution.
    expect(isCommemorativeResolution({ billType: "hr", title })).toBe(false);
    expect(isCommemorativeResolution({ billType: "sjres", title })).toBe(false);
  });

  it.each([
    // The guard: the headline also asks to free, fight, stop or defend, or adds "and support ...". It holds a day's
    // own name too (BILLS-119hres551).
    "Create National Stop SuiSilence Day",
    "Creating Rare Cancer Day to fight uncommon cancers",
    "Support National Public Lands Day and Free Park Visits",
    "Declare Rail Safety Week to stop train accidents",
    "Support Day of Silence to stop bullying of LGBTQ+ students",
    "Make May Mental Health Month and support new clinics",
    // The exclusions.
    "Declare a National Day of Mourning and condemn the attack",
    "Support Small Business Week and call on Congress to cut taxes",
    "Make Teacher Appreciation Week a time to urge higher pay",
    // No day, week, month or year.
    "Make housing affordable for working families",
    "Support Ukraine's sovereignty",
    "National Defense Authorization priorities",
    "Make Daylight Saving Time permanent",
    "Create the budget for fiscal year 2027",
    // A day, week, month or year that counts or dates, not one that is designated (the review of 2026-10-29).
    "Make Medicare negotiate drug prices this year",
    "Make the minimum wage $17 by next year",
    "Support Israel one year after the Hamas attack",
    "Declare the House's support for a ceasefire within a week",
    "Supporting a 40-hour work week for federal employees",
    "Support a four-day work week",
    "National security priorities for the coming year",
    "Support nurses who keep hospitals running every day",
    "Make Election Day a federal holiday",
    "Make the school year longer",
    // None of the designating verbs.
    "Call September 11-17, 2026 'Patriot Week'",
    "Supports Catholic Schools Week",
    "November is National Lung Cancer Awareness Month",
    "Hidradenitis Suppurativa Awareness Week",
  ])("does not tag %s", (title) => {
    expect(isCommemorativeResolution({ billType: "hres", title })).toBe(false);
  });

  it("is not applied to official titles, but Congress's titles for the bills it tags are tagged too", () => {
    expect(isCommemorativeResolution({ billType: "sres", officialTitle: "Making May 2026 National Beef Month." })).toBe(
      false,
    );
    // Planned rows the clause tags by their headlines, with the official title govinfo gives each (BILLSTATUS or bill
    // text, 2026-10-29): a re-summary that stores it keeps the bill tagged, so its topics do not come back.
    const congressTitles: Array<[guid: string, billType: string, headline: string, officialTitle: string]> = [
      [
        "BILLS-119hres99",
        "hres",
        "Make January National Stalking Awareness Month",
        "Raising awareness and encouraging the prevention of stalking by designating January 2025 as " +
          '"National Stalking Awareness Month".',
      ],
      [
        "BILLS-119hres359",
        "hres",
        "Make National Fentanyl Awareness Day about fake pills",
        "Supporting the mission and goals of National Fentanyl Awareness Day in 2025, including increasing " +
          "individual and public awareness of the impact of fake or counterfeit fentanyl pills on families and young people.",
      ],
      ["BILLS-119hres449", "hres", "Make May ALS Awareness Month", "Supports the designation of ALS Awareness Month."],
      [
        "BILLS-119hres1052",
        "hres",
        "Make February Teen Dating Violence Awareness Month",
        "Expressing support for designation of the month of February 2026 as " +
          '"National Teen Dating Violence Awareness and Prevention Month".',
      ],
      [
        "BILLS-119hres1376",
        "hres",
        "Support Lavender Growers Month",
        "Supporting the contributions and goals of Lavender Growers Month.",
      ],
      [
        "BILLS-119hres1615",
        "hres",
        "Support Manufacturing Day on October 2, 2026",
        'Expressing support for designation of the first Friday of October, October 2, 2026, as "Manufacturing Day".',
      ],
      [
        "BILLS-119sconres32",
        "sconres",
        "Support Transgender Day of Visibility",
        "A concurrent resolution supporting the goals and ideals of International Transgender Day of Visibility.",
      ],
      [
        "BILLS-119sres655",
        "sres",
        "Create National Day of Play on first Saturday after Spring",
        "A resolution expressing support for the annual designation of the first Saturday after the Spring Equinox " +
          'as "National Day of Play".',
      ],
    ];
    for (const [guid, billType, title, officialTitle] of congressTitles) {
      expect([guid, isCommemorativeResolution({ guid, billType, title })]).toEqual([guid, true]);
      expect([guid, isCommemorativeResolution({ guid, billType, officialTitle, title })]).toEqual([guid, true]);
    }
    // BILLS-119sres45, Catholic Schools Week 2025, whose stored official title is tagged now, as its 2026 twins
    // (hres1022, sres594) are by their headlines. Its row and document have no lists, so no plan changes.
    expect(
      isCommemorativeResolution({
        guid: "BILLS-119sres45",
        billType: "sres",
        officialTitle:
          "Supporting the contributions of Catholic schools in the United States and celebrating the 51st annual " +
          "National Catholic Schools Week.",
        title: "Supports Catholic Schools Week and recognizes their contributions",
      }),
    ).toBe(true);
    expect(
      isCommemorativeResolution({
        billType: "hres",
        officialTitle: 'Expressing support for July to be designated as "Disability Pride Month".',
        title: "Make housing affordable",
      }),
    ).toBe(true);
  });

  it("agrees with the twin it left split: BILLS-119hres613 with hres1463, Disability Pride Month", () => {
    expect(
      isCommemorativeResolution({
        guid: "BILLS-119hres613",
        billType: "hres",
        title: 'Make July "Disability Pride Month"',
      }),
    ).toBe(true);
    expect(
      isCommemorativeResolution({
        guid: "BILLS-119hres1463",
        billType: "hres",
        officialTitle: "Expressing support for July to be designated as Disability Pride Month.",
        title: "Designates July as Disability Pride Month",
      }),
    ).toBe(true);
    // And with hres613's own official title (govinfo BILLSTATUS), at its next re-summary.
    expect(
      isCommemorativeResolution({
        guid: "BILLS-119hres613",
        billType: "hres",
        officialTitle: 'Expressing support for July to be designated as "Disability Pride Month".',
        title: 'Make July "Disability Pride Month"',
      }),
    ).toBe(true);
  });

  type Member = [guid: string, billType: string, titles: { title: string; officialTitle?: string }];
  it.each<[string, Member, Member]>([
    [
      "National Language Access Month",
      ["BILLS-119hres1148", "hres", { title: "Make April National Language Access Month" }],
      ["BILLS-119sres699", "sres", { title: "Recognize April as National Language Access Month" }],
    ],
    [
      "Mental Health Awareness in Agriculture Day",
      ["BILLS-119hres1301", "hres", { title: "Make May 29 Mental Health Day for Farmers" }],
      [
        "BILLS-119sres727",
        "sres",
        {
          title: "Designates May 29, 2026, as Mental Health Awareness in Agriculture Day",
          officialTitle:
            "Supporting the designation of May 29, 2026, as Mental Health Awareness in Agriculture Day to raise " +
            "awareness around mental health in the agricultural industry and workforce and to continue to reduce " +
            "stigma associated with mental illness.",
        },
      ],
    ],
    [
      "PTSD Awareness Month and Day",
      ["BILLS-119hres1396", "hres", { title: "Make June PTSD Awareness Month and Day" }],
      ["BILLS-119sres758", "sres", { title: "Honor PTSD Awareness Month and Day" }],
    ],
  ])("tags both members of the companion pair it left split: %s", (_name, house, senate) => {
    for (const [guid, billType, titles] of [house, senate]) {
      expect(isCommemorativeResolution({ guid, billType, ...titles })).toBe(true);
    }
  });

  it("leaves the fourth pair, Asian American Mental Health Day, split while it holds BILLS-119hres1260", () => {
    // hres1260 and its 2026 Senate twin sres714 encourage health agencies "to adopt laws, policies, and guidance": held.
    // sres208 (2025), tagged by its headline since S6, is named in the question with hres407 (2025, the House's).
    for (const [guid, billType, title] of [
      ["BILLS-119hres1260", "hres", "Create Mental Health Day for Asian Americans and Pacific Islanders"],
      ["BILLS-119sres714", "sres", "Create National Asian American Mental Health Day"],
    ]) {
      expect(heldForReview(guid)).toBe(true);
      expect(isCommemorativeResolution({ billType, title })).toBe(true);
      expect(isCommemorativeResolution({ guid, billType, title })).toBe(false);
    }
    expect(
      isCommemorativeResolution({
        guid: "BILLS-119sres208",
        billType: "sres",
        title: "Recognize Asian American Mental Health Day",
      }),
    ).toBe(true);
  });
});

describe("bills held for review (asked on the pull request, 2026-10-29)", () => {
  it.each(HELD_FOR_REVIEW_BILLS.map((bill) => [bill.guid, bill] as const))(
    "does not tag %s, whatever its titles, until it is reviewed",
    (guid, { billType, headline, officialTitle, byHeadline, byOfficialTitle }) => {
      expect(heldForReview(guid)).toBe(true);
      expect(curatedCommemorativeOverride(guid)).toBeUndefined();
      // A title rule would tag it, and the guard does not catch what its text asks for...
      expect(isCommemorativeResolution({ billType, title: headline })).toBe(byHeadline);
      expect(isCommemorativeResolution({ billType, officialTitle, title: headline })).toBe(byOfficialTitle);
      expect(byHeadline || byOfficialTitle).toBe(true);
      // ...so it is not tagged, by the headline it has now or by the official title a re-summary stores.
      expect(isCommemorativeResolution({ guid, billType, title: headline })).toBe(false);
      expect(isCommemorativeResolution({ guid: `${guid}ih`, billType, title: headline })).toBe(false);
      expect(isCommemorativeResolution({ guid, billType, officialTitle, title: headline })).toBe(false);
    },
  );

  it("holds the clause's advocacy headlines, and the look-alikes of the not-ceremonial overrides", () => {
    const held = HELD_FOR_REVIEW_BILLS.map(({ guid }) => guid);
    expect(held).toHaveLength(28);
    // The twins and look-alikes are held together: both Voting Rights Months (hres440 and hres1304 are not
    // ceremonial), both 988 Days (hres1528's framing), the four World Sickle Cell Awareness Days, both ASK Days.
    for (const guid of [
      "BILLS-119hres756",
      "BILLS-119sres854",
      "BILLS-119hres1514",
      "BILLS-119sres853",
      "BILLS-119hres524",
      "BILLS-119sres292",
      "BILLS-119hres1371",
      "BILLS-119sres780",
      "BILLS-119hres523",
      "BILLS-119hres1373",
    ]) {
      expect(held).toContain(guid);
    }
    // sres854 has been tagged by its stored official title since S6; held, its topics stay until it is reviewed.
    expect(
      isCommemorativeResolution({
        guid: "BILLS-119sres854",
        billType: "sres",
        officialTitle: "Designating September 2026 as National Voting Rights Month.",
        title: "Designates September 2026 as National Voting Rights Month",
      }),
    ).toBe(false);
  });

  it("holds no other bill, and a curated override would stand over a hold", () => {
    expect(heldForReview("BILLS-119hres449")).toBe(false);
    expect(heldForReview("BILLS-118hconres53")).toBe(false);
    expect(heldForReview(undefined)).toBe(false);
    expect(heldForReview("not a guid")).toBe(false);
    // hres697, hres1528's 2025 twin, is tagged by its headline since S6 and named in the question, not held: its row
    // has no lists, so the relabel leaves it alone either way.
    expect(heldForReview("BILLS-119hres697")).toBe(false);
    expect(
      isCommemorativeResolution({
        guid: "BILLS-119hres697",
        billType: "hres",
        title: "Recognize suicide prevention as important public health issue",
      }),
    ).toBe(true);
    for (const { guid } of CURATED_CEREMONIAL_OVERRIDES) expect(heldForReview(guid)).toBe(false);
  });
});

describe("processedBillCommemorativeInput", () => {
  const stored = {
    kind: "processed",
    identifier: { congress: "119", billType: "hres", billNumber: "1572" },
    guid: "BILLS-119hres1572",
    title: "Recognize Military Spouse Appreciation Day",
    officialTitle: "Recognizing Military Spouse Appreciation Day.",
  };

  it("reads the guid, the type, the official title and the headline of a stored processed bill", () => {
    expect(processedBillCommemorativeInput(stored)).toEqual({
      guid: "BILLS-119hres1572",
      billType: "hres",
      officialTitle: "Recognizing Military Spouse Appreciation Day.",
      title: "Recognize Military Spouse Appreciation Day",
    });
    expect(isCommemorativeResolution(processedBillCommemorativeInput(stored))).toBe(true);
  });

  it("reads through a content.rawSnapshot wrapper, as CreateBillsManifest does", () => {
    expect(processedBillCommemorativeInput({ kind: "processed", content: { rawSnapshot: stored } })).toEqual({
      guid: "BILLS-119hres1572",
      billType: "hres",
      officialTitle: "Recognizing Military Spouse Appreciation Day.",
      title: "Recognize Military Spouse Appreciation Day",
    });
  });

  it("gives nulls for what is missing or not text", () => {
    expect(processedBillCommemorativeInput({ identifier: {}, officialTitle: 7, guid: 7 })).toEqual({
      guid: null,
      billType: undefined,
      officialTitle: null,
      title: null,
    });
    expect(processedBillCommemorativeInput(null)).toEqual({
      guid: null,
      billType: undefined,
      officialTitle: null,
      title: null,
    });
  });

  it("carries the guid, so a curated override holds for a stored processed bill", () => {
    for (const { guid, billType, billNumber, headline, ceremonial } of CURATED_CEREMONIAL_OVERRIDES) {
      const document = {
        kind: "processed",
        identifier: { congress: "119", billType, billNumber },
        guid,
        title: headline,
      };
      expect(isCommemorativeResolution(processedBillCommemorativeInput(document))).toBe(ceremonial);
      expect(
        isCommemorativeResolution(
          processedBillCommemorativeInput({ kind: "processed", content: { rawSnapshot: document } }),
        ),
      ).toBe(ceremonial);
    }
    // A document without its own guid takes its metadata's, as CreateBillsManifest reads it.
    expect(
      processedBillCommemorativeInput({ identifier: { billType: "hres" }, metadata: { guid: "BILLS-119hres862" } })
        .guid,
    ).toBe("BILLS-119hres862");
  });
});
