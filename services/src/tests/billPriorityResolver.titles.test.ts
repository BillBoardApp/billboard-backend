import type { GetItemCommandInput, PutItemCommandInput, QueryCommandInput } from "@aws-sdk/client-dynamodb";
import type { GetObjectCommandInput } from "@aws-sdk/client-s3";
import { applyTestEnv } from "./fixtures/env";
import { bodyWithTransformToString } from "./fixtures/streams";
import { logLines, type LogLine } from "./logLines";

/** The input fields the Dynamo fake reads, across the commands the handler sends. */
type DynamoInput = Partial<QueryCommandInput & GetItemCommandInput & PutItemCommandInput>;
interface DynamoCommand {
  input?: DynamoInput;
}
interface S3Command {
  input: GetObjectCommandInput;
}

// REL-51 (feature review S11): "In the news" matches headlines against Congress's short and official titles, which
// the resolver reads from the raw bills, and also ranks joint resolutions and impeachment, censure or expulsion
// resolutions.

const HAIKU_45_PROFILE_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0";

const originalEnv = { ...process.env };
const mockDynamoSend = jest.fn();
const mockBedrockSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-s3", () => ({
  ...jest.requireActual("@aws-sdk/client-s3"),
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

// ─── Realistic congress.gov titles ───────────────────────────────────────────

type TitleEntry = { title: string; titleType: string; updateDate?: string };

const rawBill = (options: { displayTitle: string; titles?: TitleEntry[]; billXML?: string }) => ({
  schemaVersion: 1,
  kind: "raw",
  metadata: { guid: "x", title: options.displayTitle, pubDate: "", fetchedAt: "" },
  content: {
    bill: { bill: { title: options.displayTitle } },
    ...(options.titles ? { titles: { titles: options.titles } } : {}),
    ...(options.billXML ? { billXML: options.billXML } : {}),
  },
});

const SAVE_ACT_OFFICIAL =
  "To amend the National Voter Registration Act of 1993 to require proof of United States citizenship to register an individual to vote in elections for Federal office, and for other purposes.";
const SAVE_ACT = rawBill({
  displayTitle: "SAVE Act",
  titles: [
    { title: "SAVE Act", titleType: "Display Title", updateDate: "2025-04-11T13:13:22Z" },
    { title: "SAVE Act", titleType: "Short Titles as Passed House", updateDate: "2025-04-11T13:13:22Z" },
    {
      title: "Safeguard American Voter Eligibility Act",
      titleType: "Short Titles as Passed House",
      updateDate: "2025-04-11T13:13:22Z",
    },
    { title: SAVE_ACT_OFFICIAL, titleType: "Official Title as Introduced", updateDate: "2025-01-04T09:01:12Z" },
    { title: "SAVE Act", titleType: "Short Titles as Introduced", updateDate: "2025-01-04T09:01:12Z" },
    {
      title: "Safeguard American Voter Eligibility Act",
      titleType: "Short Titles as Introduced",
      updateDate: "2025-01-04T09:01:12Z",
    },
  ],
});

const GENIUS_ACT = rawBill({
  displayTitle: "GENIUS Act",
  titles: [
    {
      title: "Guiding and Establishing National Innovation for U.S. Stablecoins Act",
      titleType: "Short Title(s) as Introduced",
    },
    { title: "GENIUS Act", titleType: "Short Title(s) as Introduced" },
    {
      title: "To provide for the regulation of payment stablecoins, and for other purposes.",
      titleType: "Official Title as Introduced",
    },
  ],
});

const STOPGAP = rawBill({
  displayTitle: "Further Continuing Appropriations Act, 2027",
  titles: [
    { title: "Further Continuing Appropriations Act, 2027", titleType: "Short Title(s) as Introduced" },
    {
      title: "Department of Homeland Security Extension Act",
      titleType: "Short Titles as Introduced for portions of this bill",
    },
    {
      title:
        "Making further continuing appropriations for the fiscal year ending September 30, 2027, and for other purposes.",
      titleType: "Official Title as Introduced",
    },
  ],
});

const WATER_HEATER_CRA = rawBill({
  displayTitle:
    'Providing for congressional disapproval under chapter 8 of title 5, United States Code, of the rule submitted by the Department of Energy relating to "Energy Conservation Program: Energy Conservation Standards for Consumer Gas-fired Instantaneous Water Heaters".',
  titles: [
    {
      title:
        'Providing for congressional disapproval under chapter 8 of title 5, United States Code, of the rule submitted by the Department of Energy relating to "Energy Conservation Program: Energy Conservation Standards for Consumer Gas-fired Instantaneous Water Heaters".',
      titleType: "Official Title as Introduced",
    },
  ],
});

// Simple resolutions have no short title: congress.gov's display title is the official title.
const resolution = (official: string) =>
  rawBill({ displayTitle: official, titles: [{ title: official, titleType: "Official Title as Introduced" }] });

const IMPEACHMENT = resolution(
  "Impeaching Jordan Ellis, Secretary of Homeland Security, for high crimes and misdemeanors.",
);
const CENSURE = resolution("Condemning and censuring Representative Alex Rivera of Ohio.");
// How the House words an expulsion (H.Res. 878 of the 118th Congress: "Expelling Representative George Santos from the
// United States House of Representatives."), and the rule that would bring one to the floor.
const EXPULSION = resolution("Expelling Representative Morgan Lee from the United States House of Representatives.");
const EXPULSION_RULE = resolution(
  "Providing for consideration of the resolution (H. Res. 830) expelling Representative Morgan Lee from the United States House of Representatives.",
);
const COMMEMORATIVE = resolution(
  'Expressing support for the designation of October 2026 as "National Cybersecurity Awareness Month" to raise awareness of cybersecurity threats.',
);
const RULE = resolution(
  "Providing for consideration of the resolution (H. Res. 820) impeaching Jordan Ellis, Secretary of Homeland Security, for high crimes and misdemeanors.",
);

describe("titlesFromRawBill (REL-51)", () => {
  const {
    titlesFromRawBill,
    capTitle,
    OFFICIAL_TITLE_MAX_CHARS,
  } = require("../handlers/billPriorityResolver/billTitles");

  it("reads the short titles, latest version first and without duplicates, and the latest official title", () => {
    expect(titlesFromRawBill(SAVE_ACT)).toEqual({
      shortTitles: ["SAVE Act", "Safeguard American Voter Eligibility Act"],
      officialTitle: SAVE_ACT_OFFICIAL,
    });
  });

  it("leaves out a division's title ('for portions of this bill')", () => {
    expect(titlesFromRawBill(STOPGAP).shortTitles).toEqual(["Further Continuing Appropriations Act, 2027"]);
  });

  it("gives a simple resolution no short title: its display title is its official title", () => {
    expect(titlesFromRawBill(IMPEACHMENT)).toEqual({
      shortTitles: [],
      officialTitle: "Impeaching Jordan Ellis, Secretary of Homeland Security, for high crimes and misdemeanors.",
    });
  });

  it("keeps an official title of up to 300 characters whole and cuts a longer one at a word", () => {
    expect(titlesFromRawBill(WATER_HEATER_CRA).officialTitle).toMatch(/Water Heaters"\.$/);

    const omnibus =
      "Making consolidated appropriations for the fiscal year ending September 30, 2027, providing emergency " +
      "assistance for disaster relief, extending expiring health care and agriculture programs, authorizing the " +
      "national flood insurance program, establishing a commission on fiscal responsibility, and for other purposes.";
    const { officialTitle } = titlesFromRawBill(resolution(omnibus));
    expect(omnibus.length).toBeGreaterThan(OFFICIAL_TITLE_MAX_CHARS);
    expect(officialTitle.length).toBeLessThanOrEqual(OFFICIAL_TITLE_MAX_CHARS);
    expect(officialTitle).toMatch(/^Making consolidated appropriations .*[a-z]…$/);
    expect(capTitle("Short enough.", 300)).toBe("Short enough.");
  });

  it("without a titles list, takes the display title as the short title and the text's <official-title>", () => {
    const raw = rawBill({
      displayTitle: "Laken Riley Act",
      billXML:
        "<bill><form><official-title>To require the Secretary of Homeland Security to take into custody aliens who have been charged in the United States with theft, and for other purposes.</official-title></form></bill>",
    });
    expect(titlesFromRawBill(raw)).toEqual({
      shortTitles: ["Laken Riley Act"],
      officialTitle:
        "To require the Secretary of Homeland Security to take into custody aliens who have been charged in the United States with theft, and for other purposes.",
    });
  });

  it("without a titles list, takes a display title that reads as an official title as the official title", () => {
    expect(
      titlesFromRawBill(rawBill({ displayTitle: "To amend title 38, United States Code, to extend a pilot program." })),
    ).toEqual({
      shortTitles: [],
      officialTitle: "To amend title 38, United States Code, to extend a pilot program.",
    });
  });

  it("reads nothing from a malformed or empty document", () => {
    expect(titlesFromRawBill(null)).toEqual({ shortTitles: [] });
    expect(titlesFromRawBill({ content: { titles: { titles: [null, { title: 7 }] } } })).toEqual({ shortTitles: [] });
  });
});

describe("headline matching and candidate types (REL-51)", () => {
  const {
    billReferencesIn,
    candidateExclusion,
    isImpeachmentCensureOrExpulsion,
    matchHeadlines,
    normalizeText,
    shortTitlePhrases,
    stemWord,
  } = require("../handlers/billPriorityResolver/headlineMatching");
  const { titlesFromRawBill } = require("../handlers/billPriorityResolver/billTitles");

  const headline = (title: string) => ({ title, normalizedTitle: normalizeText(title) });

  it("reads bill, joint resolution and House resolution numbers", () => {
    expect([...billReferencesIn("House to vote on H.J.Res. 150 as shutdown deadline nears")]).toEqual(["hjres150"]);
    expect([...billReferencesIn("Senate passes S.J. Res. 88, overturning water heater rule")]).toEqual(["sjres88"]);
    expect([...billReferencesIn("Democrats file H. Res. 820 to impeach Ellis")]).toEqual(["hres820"]);
    expect([...billReferencesIn("House passes H.R. 5371 and sends S. 1582 to committee")]).toEqual(["hr5371", "s1582"]);
    expect([...billReferencesIn("House Joint Resolution 150 clears the Rules Committee")]).toEqual(["hjres150"]);
  });

  it("does not read 'U.S. 2026', \"Trump's 2026\" or 'Res. 5' as a Senate bill", () => {
    expect([...billReferencesIn("U.S. 2026 budget fight moves to the Senate")]).toEqual([]);
    expect([...billReferencesIn("What's in Trump's 2026 spending plan")]).toEqual([]);
    expect([...billReferencesIn("H.Res. 5 adopted")]).toEqual(["hres5"]);
  });

  it("names a bill by its short title, without its year, or without 'Act' when three words remain", () => {
    expect(shortTitlePhrases("Laken Riley Act")).toEqual(["laken riley act"]);
    expect(shortTitlePhrases("Further Continuing Appropriations Act, 2027")).toEqual([
      "further continuing appropriations act 2027",
      "further continuing appropriations act",
      "further continuing appropriations",
    ]);
    expect(shortTitlePhrases("One Big Beautiful Bill Act")).toEqual([
      "one big beautiful bill act",
      "one big beautiful bill",
    ]);
    // One word alone never names a bill.
    expect(shortTitlePhrases("GENIUS Act")).toEqual(["genius act"]);
  });

  const saveAct = {
    billType: "hr",
    billNumber: "22",
    title: "Requires proof of citizenship to register to vote",
    ...titlesFromRawBill(SAVE_ACT),
  };

  it("counts a headline that names the bill by its short title as explicit", () => {
    expect(
      matchHeadlines(saveAct, [
        headline("House Republicans push SAVE Act vote ahead of midterms - AP News"),
        headline("Senate Democrats vow to block Safeguard American Voter Eligibility Act - Reuters"),
      ]),
    ).toEqual({ explicitHeadlineMatches: 2, shortTitleMatches: 2, headlineOverlapCount: 0 });
  });

  it("counts a headline that names it by number as explicit, not as a short-title match", () => {
    expect(matchHeadlines(saveAct, [headline("What H.R. 22 would change at the DMV - NPR")])).toEqual({
      explicitHeadlineMatches: 1,
      shortTitleMatches: 0,
      headlineOverlapCount: 0,
    });
  });

  it("counts words shared with the official title as an overlap, stems included", () => {
    const impeachment = {
      billType: "hres",
      billNumber: "820",
      title: "Remove a cabinet secretary from office",
      ...titlesFromRawBill(IMPEACHMENT),
    };
    expect(
      matchHeadlines(impeachment, [
        headline("House Democrats force vote to impeach Homeland Security chief Ellis - AP News"),
      ]),
    ).toEqual({ explicitHeadlineMatches: 0, shortTitleMatches: 0, headlineOverlapCount: 1 });

    const censure = {
      billType: "hres",
      billNumber: "821",
      title: "Rebuke a House member",
      ...titlesFromRawBill(CENSURE),
    };
    expect(matchHeadlines(censure, [headline("Rivera censured by House over floor remarks - Reuters")])).toEqual({
      explicitHeadlineMatches: 0,
      shortTitleMatches: 0,
      headlineOverlapCount: 1,
    });

    const expulsion = {
      billType: "hres",
      billNumber: "830",
      title: "Remove a House member from office",
      ...titlesFromRawBill(EXPULSION),
    };
    expect(
      matchHeadlines(expulsion, [headline("Morgan Lee expelled from House in rare bipartisan vote - AP News")]),
    ).toEqual({ explicitHeadlineMatches: 0, shortTitleMatches: 0, headlineOverlapCount: 1 });
    // News more often says "expel", "expels" or "expulsion" than "expelled", and rarely gives the number. Billboard's
    // headline does not say "expel", so each overlap below comes from the official title's "Expelling".
    for (const title of [
      "House votes to expel Rep. Morgan Lee after ethics report - AP News",
      "House expels Morgan Lee in historic vote - NPR",
      "Morgan Lee expulsion vote set for Friday - Politico",
    ]) {
      expect(matchHeadlines(expulsion, [headline(title)])).toEqual({
        explicitHeadlineMatches: 0,
        shortTitleMatches: 0,
        headlineOverlapCount: 1,
      });
    }
    // "Morgan" alone is one word, not an overlap.
    expect(matchHeadlines(expulsion, [headline("Morgan Lee wins primary in Ohio - Reuters")])).toEqual({
      explicitHeadlineMatches: 0,
      shortTitleMatches: 0,
      headlineOverlapCount: 0,
    });
    expect(matchHeadlines(expulsion, [headline("House expels Rep. Morgan Lee: H. Res. 830 passes - NPR")])).toEqual({
      explicitHeadlineMatches: 1,
      shortTitleMatches: 0,
      headlineOverlapCount: 0,
    });
  });

  it("stems every form of impeach, censure and expel to one root, and keeps other words apart", () => {
    const stems = (words: string[]) => [...new Set(words.map((word) => stemWord(word)))];
    expect(stems(["impeach", "impeaches", "impeached", "impeaching", "impeachment"])).toEqual(["impeach"]);
    expect(stems(["censure", "censures", "censured", "censuring"])).toEqual(["censur"]);
    expect(stems(["expel", "expels", "expelled", "expelling", "expulsion", "expulsions"])).toEqual(["expel"]);
    // A final "ll" loses an "l" in every form of a longer word, so the forms still meet; a short word keeps it.
    expect(stems(["install", "installs", "installed", "installing"])).toHaveLength(1);
    expect(stems(["cancel", "cancels", "canceled", "cancelled", "cancelling"])).toEqual(["cancel"]);
    expect(stems(["bill", "bills", "billed", "billing"])).toEqual(["bill"]);
    expect(stemWord("small")).toBe("small");
    expect(stemWord("expire")).not.toBe(stemWord("expel"));
  });

  it("does not match on the words every congressional headline carries", () => {
    expect(
      matchHeadlines(saveAct, [headline("House and Senate leaders vote on federal bill to amend United States code")]),
    ).toEqual({ explicitHeadlineMatches: 0, shortTitleMatches: 0, headlineOverlapCount: 0 });
  });

  // Headlines of the same day about other things: none names or concerns the bills below.
  const UNRELATED = [
    "Lawmakers race to secure votes for stopgap funding bill - NPR",
    "Government shutdown looms as fiscal year ends without a deal - AP News",
    "House passes 2026 defense bill as fiscal fights continue - Reuters",
    "Internal Revenue Service layoffs draw bipartisan criticism - AP News",
    "Senate panel moves to protect children online - Reuters",
    "Lawmakers vow support for Ukraine as aid talks stall - AP News",
    "Health officials warn Congress of a hard flu season - NPR",
    "Families save on groceries as food prices dip - AP News",
    "Energy Department rule on gas stoves draws Senate fire - Reuters",
  ].map(headline);

  it.each([
    ["SECURE Act", "Expands retirement savings options"],
    ["PROTECT Act", "Sets penalties for online exploitation"],
    ["SUPPORT Act", "Renews opioid treatment grants"],
    ["HEALTH Act", "Caps medical malpractice damages"],
    ["SAVE Act", "Requires proof of citizenship to register to vote"],
  ])("never counts one shared common word as an overlap for a one-word short title: %s", (shortTitle, title) => {
    const bill = { billType: "hr", billNumber: "4100", title, shortTitles: [shortTitle] };
    expect(matchHeadlines(bill, UNRELATED)).toEqual({
      explicitHeadlineMatches: 0,
      shortTitleMatches: 0,
      headlineOverlapCount: 0,
    });
    // It is still named by its short title.
    expect(matchHeadlines(bill, [headline(`House to vote on the ${shortTitle} this week - AP News`)])).toEqual({
      explicitHeadlineMatches: 1,
      shortTitleMatches: 1,
      headlineOverlapCount: 0,
    });
  });

  it("does not count an official title's formula, or a year, as shared words", () => {
    const nasa = {
      billType: "s",
      billNumber: "2120",
      title: "Funds NASA science and moon missions",
      officialTitle:
        "To authorize appropriations for the National Aeronautics and Space Administration for fiscal years 2026 through 2028, and for other purposes.",
    };
    const tips = {
      billType: "hr",
      billNumber: "4300",
      title: "Exempts tips from income tax",
      officialTitle: "To amend the Internal Revenue Code of 1986 to exclude cash tips from gross income.",
    };
    const stopgap = {
      billType: "hjres",
      billNumber: "130",
      title: "Extends government funding",
      shortTitles: ["Continuing Appropriations Act, 2026"],
      officialTitle:
        "Making continuing appropriations for the fiscal year ending September 30, 2026, and for other purposes.",
    };
    const waterHeaters = {
      billType: "sjres",
      billNumber: "88",
      title: "Overturns a water heater efficiency standard",
      ...titlesFromRawBill(WATER_HEATER_CRA),
    };
    for (const bill of [nasa, tips, stopgap]) {
      expect(matchHeadlines(bill, UNRELATED).headlineOverlapCount).toBe(0);
    }
    // "Energy Department rule" is the formula of every rule disapproval; the headline is about gas stoves.
    expect(matchHeadlines(waterHeaters, UNRELATED).headlineOverlapCount).toBe(0);

    // The subject still overlaps.
    expect(
      matchHeadlines(nasa, [
        headline("Senate passes bill funding National Aeronautics and Space Administration through 2028 - Reuters"),
      ]).headlineOverlapCount,
    ).toBe(1);
    expect(
      matchHeadlines(waterHeaters, [headline("Senate votes to overturn Biden-era water heater efficiency rule - AP")])
        .headlineOverlapCount,
    ).toBe(1);
  });

  it("before REL-51 the headline alone found none of these", () => {
    const headlineOnly = { billType: "hr", billNumber: "22", title: saveAct.title };
    expect(
      matchHeadlines(headlineOnly, [headline("House Republicans push SAVE Act vote ahead of midterms - AP News")]),
    ).toEqual({ explicitHeadlineMatches: 0, shortTitleMatches: 0, headlineOverlapCount: 0 });
  });

  it.each([
    ["hr", "Requires proof of citizenship to register to vote", undefined],
    ["s", "Sets federal rules for stablecoin issuers", undefined],
    ["hjres", "Extends government funding into December", undefined],
    ["sjres", "Overturn an Energy Department water heater rule", undefined],
    ["HRES", "Impeach the Homeland Security Secretary", titlesFromRawBill(IMPEACHMENT).officialTitle],
    ["house-resolution", "Censure a House member", titlesFromRawBill(CENSURE).officialTitle],
    // The project's 2026-10-29 answer: an expulsion counts like an impeachment or a censure.
    ["hres", "Expel Representative Morgan Lee", titlesFromRawBill(EXPULSION).officialTitle],
    ["H.Res.", "Expel a House member", "Expelling Representative Morgan Lee from the House of Representatives."],
    ["hres", "Expel a House member", "Expelling Morgan Lee from the House of Representatives."],
  ])("ranks a %s: %s", (billType, title, officialTitle) => {
    expect(candidateExclusion({ billType, title, officialTitle })).toBeNull();
  });

  it.each([
    [
      "hres",
      "Recognize National Cybersecurity Awareness Month",
      titlesFromRawBill(COMMEMORATIVE).officialTitle,
      "ceremonial",
    ],
    ["hres", "Recognize National Cybersecurity Awareness Month", undefined, "ceremonial"],
    ["hres", "Set House rules for the impeachment debate", titlesFromRawBill(RULE).officialTitle, "resolution"],
    ["hres", "Condemn rising antisemitism", "Condemning the rise in antisemitic incidents.", "resolution"],
    // Measures that name an impeachment or a censure without being one: rules, a motion to table, counter-resolutions.
    [
      "hres",
      "Continue the debate on censuring a member",
      "Providing for further consideration of the resolution (H. Res. 5) censuring Representative Alex Rivera.",
      "resolution",
    ],
    [
      "hres",
      "Adopt a censure resolution without a separate vote",
      "Providing for the adoption of the resolution (H. Res. 24) censuring Representative Alex Rivera.",
      "resolution",
    ],
    [
      "hres",
      "Table an impeachment resolution",
      "Laying on the table the resolution (H. Res. 1) impeaching Jordan Ellis.",
      "resolution",
    ],
    [
      "hres",
      "Condemn the impeachment of the president",
      "Condemning the House Democrats' impeachment of President Dana Hale.",
      "resolution",
    ],
    [
      "hres",
      "Call the impeachment inquiry illegitimate",
      "Expressing the sense of the House of Representatives that the impeachment inquiry into President Dana Hale is illegitimate.",
      "resolution",
    ],
    ["hres", "Condemn a censure", "Condemning the censure of Representative Alex Rivera.", "resolution"],
    // The same for an expulsion: the rule for it, a motion to table it, condemning a member without expelling them,
    // and the sense of the House that a member should be expelled.
    ["hres", "Set House rules for the expulsion vote", titlesFromRawBill(EXPULSION_RULE).officialTitle, "resolution"],
    [
      "hres",
      "Table the expulsion of a member",
      "Laying on the table the resolution (H. Res. 830) expelling Representative Morgan Lee from the United States House of Representatives.",
      "resolution",
    ],
    [
      "hres",
      "Condemn a House member",
      "Condemning Representative Morgan Lee for fabricating his biography and misusing campaign funds.",
      "resolution",
    ],
    [
      "hres",
      "Condemn a member and call for his expulsion",
      "Condemning Representative Morgan Lee and calling for his expulsion from the House of Representatives.",
      "resolution",
    ],
    [
      "hres",
      "Say a member should be expelled",
      "Expressing the sense of the House of Representatives that Representative Morgan Lee should be expelled.",
      "resolution",
    ],
    // Billboard's headline is a paraphrase: an H.Res. whose official title was not read is never sent.
    ["hres", "Impeach the Homeland Security Secretary", undefined, "noOfficialTitle"],
    ["hres", "Expel Representative Morgan Lee", undefined, "noOfficialTitle"],
    // Not covered yet (an open question): the Ethics Committee titles its own reports "In the Matter of ...", an
    // expulsion (H.Res. 495, 107th Congress), a censure (H.Res. 1737, 111th) and a reprimand alike.
    ["hres", "Expel a House member", "In the Matter of James A. Traficant, Jr.", "resolution"],
    ["hres", "Censure a House member", "In the matter of Representative Charles B. Rangel of New York.", "resolution"],
    // A Senate resolution is never a candidate, an expulsion from the Senate included.
    ["sres", "Censure a senator", "A resolution censuring Senator Casey Morgan.", "type"],
    ["sres", "Expel a senator", "A resolution expelling Senator Casey Morgan from the United States Senate.", "type"],
    ["hconres", "Set the budget", undefined, "type"],
  ])("leaves out a %s: %s", (billType, title, officialTitle, reason) => {
    expect(candidateExclusion({ billType, title, officialTitle })).toBe(reason);
  });

  it("knows an impeachment, censure or expulsion by how its official title opens, not by the word anywhere in it", () => {
    expect(isImpeachmentCensureOrExpulsion("Impeaching Jordan Ellis, Secretary of Homeland Security.")).toBe(true);
    expect(isImpeachmentCensureOrExpulsion("Censuring Representative Alex Rivera.")).toBe(true);
    expect(isImpeachmentCensureOrExpulsion("Condemning and censuring Representative Alex Rivera of Ohio.")).toBe(true);
    expect(
      isImpeachmentCensureOrExpulsion(
        "Condemning Representative Alex Rivera for remarks on the House floor, and censuring him.",
      ),
    ).toBe(true);
    // An impeachment inquiry.
    expect(
      isImpeachmentCensureOrExpulsion(
        "Authorizing and directing the Committee on the Judiciary to investigate whether sufficient grounds exist for the House of Representatives to impeach Jordan Ellis.",
      ),
    ).toBe(true);
    expect(
      isImpeachmentCensureOrExpulsion(
        "Directing certain committees to continue their ongoing investigations as part of the existing House of Representatives inquiry into whether sufficient grounds exist for the House of Representatives to exercise its Constitutional power to impeach Dana Hale, President of the United States, and for other purposes.",
      ),
    ).toBe(true);
    // An expulsion (project decision, 2026-10-29), with or without leading spaces.
    expect(isImpeachmentCensureOrExpulsion(titlesFromRawBill(EXPULSION).officialTitle)).toBe(true);
    expect(isImpeachmentCensureOrExpulsion("  Expelling Representative Morgan Lee from the House.")).toBe(true);
    expect(isImpeachmentCensureOrExpulsion(titlesFromRawBill(RULE).officialTitle)).toBe(false);
    expect(isImpeachmentCensureOrExpulsion(titlesFromRawBill(EXPULSION_RULE).officialTitle)).toBe(false);
    expect(isImpeachmentCensureOrExpulsion("Condemning the House Democrats' impeachment of President Dana Hale.")).toBe(
      false,
    );
    expect(
      isImpeachmentCensureOrExpulsion(
        "Condemning Representative Morgan Lee and calling for his expulsion from the House of Representatives.",
      ),
    ).toBe(false);
  });
});

// REL-46 (changeover plan PR 6): from 2027-01-03 the week's bills come from the 119th and the 120th Congress, and each
// Congress numbers its bills from 1 again.
describe("bill numbers across two Congresses (REL-46)", () => {
  const {
    matchHeadlines,
    newestCongressByNumber,
    normalizeText,
  } = require("../handlers/billPriorityResolver/headlineMatching");

  const headline = (title: string) => ({ title, normalizedTitle: normalizeText(title) });
  const none = { explicitHeadlineMatches: 0, shortTitleMatches: 0, headlineOverlapCount: 0 };
  const byNumber = { explicitHeadlineMatches: 1, shortTitleMatches: 0, headlineOverlapCount: 0 };

  const hr1Of119 = {
    guid: "BILLS-119hr1",
    congress: "119",
    billType: "hr",
    billNumber: "1",
    title: "Cuts taxes and changes Medicaid and SNAP",
    shortTitles: ["One Big Beautiful Bill Act"],
  };
  const hr1Of120 = {
    guid: "BILLS-120hr1",
    congress: "120",
    billType: "hr",
    billNumber: "1",
    title: "Sets new rules for federal elections",
  };
  const hr1234Of119 = {
    guid: "BILLS-119hr1234",
    congress: "119",
    billType: "hr",
    billNumber: "1234",
    title: "Names a post office in Dayton, Ohio",
  };

  it("counts a headline naming H.R. 1 for the newest Congress's H.R. 1 only", () => {
    const newest = newestCongressByNumber([hr1Of119, hr1Of120]);
    const headlines = [headline("House passes H.R. 1 on a party-line vote - AP News")];
    expect(matchHeadlines(hr1Of120, headlines, newest)).toEqual(byNumber);
    expect(matchHeadlines(hr1Of119, headlines, newest)).toEqual(none);
  });

  it("still counts a number only an older Congress's bill has", () => {
    const newest = newestCongressByNumber([hr1Of119, hr1Of120, hr1234Of119]);
    expect(matchHeadlines(hr1234Of119, [headline("President signs H.R. 1234 into law - Reuters")], newest)).toEqual(
      byNumber,
    );
  });

  it("drops an older bill's number match only for a newer bill of the same type", () => {
    const s1Of120 = {
      guid: "BILLS-120s1",
      congress: "120",
      billType: "s",
      billNumber: "1",
      title: "Sets up a commission",
    };
    const newest = newestCongressByNumber([hr1Of119, s1Of120]);
    expect(matchHeadlines(hr1Of119, [headline("House passes H.R. 1 on a party-line vote - AP News")], newest)).toEqual(
      byNumber,
    );
  });

  it("keeps an older bill's short title and word matches", () => {
    const newest = newestCongressByNumber([hr1Of119, hr1Of120]);
    expect(
      matchHeadlines(
        hr1Of119,
        [headline("One Big Beautiful Bill Act's Medicaid cuts start in January - AP News")],
        newest,
      ),
    ).toEqual({ explicitHeadlineMatches: 1, shortTitleMatches: 1, headlineOverlapCount: 0 });
    expect(
      matchHeadlines(hr1Of119, [headline("Medicaid and SNAP cuts start as H.R. 1 debate opens - NPR")], newest),
    ).toEqual({ explicitHeadlineMatches: 0, shortTitleMatches: 0, headlineOverlapCount: 1 });
  });

  it("reads a bill's Congress from its guid when its row has none, and never drops a bill whose Congress is unknown", () => {
    const headlines = [headline("House passes H.R. 1 on a party-line vote - AP News")];
    const noCongressField = { ...hr1Of119, congress: "" };
    expect(matchHeadlines(noCongressField, headlines, newestCongressByNumber([noCongressField, hr1Of120]))).toEqual(
      none,
    );
    const unknown = { billType: "hr", billNumber: "1", title: hr1Of119.title };
    expect(matchHeadlines(unknown, headlines, newestCongressByNumber([unknown, hr1Of120]))).toEqual(byNumber);
    // Without the pool's numbers every number match counts, as before REL-46.
    expect(matchHeadlines(hr1Of119, headlines)).toEqual(byNumber);
  });
});

describe("billPriorityResolver with titles and new candidate types (REL-51)", () => {
  let restoreEnv: (() => void) | undefined;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const useEnv = (overrides: Record<string, string | undefined> = {}) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        MANIFEST_TABLE_NAME: "BillsManifest",
        PRIORITY_TABLE_NAME: "BillPriority",
        PRIORITY_ACTIVE_INDEX_NAME: "PriorityStatusIndex",
        MODEL_ID: HAIKU_45_PROFILE_ARN,
        NEWS_FEED_URLS: "https://news.example/feed.xml",
        BILL_STORE_BUCKET_NAME: "billboard-bill-store-bucket",
        MAX_PRIORITY_RESULTS: "8",
        PRIORITY_MIN_SCORE: "75",
        PRIORITY_MIN_CONFIDENCE: "0.55",
        AWS_LAMBDA_LOG_FORMAT: undefined,
        LOG_LEVEL: undefined,
        ...overrides,
      },
      { replace: true, base: originalEnv },
    );
  };

  // A week of manifest rows: a bill and a joint resolution in the news under their short titles or number, an
  // impeachment and a censure, and three House resolutions that must not be ranked (a commemorative one, the rule
  // for the impeachment debate) or a Senate resolution, which is never loaded.
  const ROWS: Array<{
    guid: string;
    /** "119" when not given. */
    congress?: string;
    billType: string;
    billNumber: string;
    title: string;
    raw: unknown;
    hours: number;
  }> = [
    {
      guid: "BILLS-119hr22ih",
      billType: "hr",
      billNumber: "22",
      title: "Requires proof of citizenship to register to vote",
      raw: SAVE_ACT,
      hours: 30,
    },
    {
      guid: "BILLS-119s1582",
      billType: "s",
      billNumber: "1582",
      title: "Sets federal rules for stablecoin issuers",
      raw: GENIUS_ACT,
      hours: 50,
    },
    {
      guid: "BILLS-119hjres150",
      billType: "hjres",
      billNumber: "150",
      title: "Extends government funding into December",
      raw: STOPGAP,
      hours: 6,
    },
    {
      guid: "BILLS-119sjres88",
      billType: "sjres",
      billNumber: "88",
      title: "Overturns an Energy Department water heater rule",
      raw: WATER_HEATER_CRA,
      hours: 100,
    },
    {
      guid: "BILLS-119hres820",
      billType: "hres",
      billNumber: "820",
      title: "Impeach the Homeland Security Secretary",
      raw: IMPEACHMENT,
      hours: 20,
    },
    {
      guid: "BILLS-119hres821",
      billType: "hres",
      billNumber: "821",
      title: "Censure Representative Alex Rivera",
      raw: CENSURE,
      hours: 22,
    },
    {
      guid: "BILLS-119hres822",
      billType: "hres",
      billNumber: "822",
      title: "Support Cybersecurity Awareness Month",
      raw: COMMEMORATIVE,
      hours: 2,
    },
    {
      guid: "BILLS-119hres823",
      billType: "hres",
      billNumber: "823",
      title: "Set House rules for the impeachment debate",
      raw: RULE,
      hours: 3,
    },
    {
      guid: "BILLS-119sres400",
      billType: "sres",
      billNumber: "400",
      title: "Censure a senator",
      raw: resolution("A resolution censuring Senator Casey Morgan."),
      hours: 4,
    },
  ];
  // An expulsion (project decision, 2026-10-29), the rule that would bring it to the floor and a Senate expulsion, which the test
  // of expulsions adds to the week.
  const EXPULSION_ROWS: typeof ROWS = [
    {
      guid: "BILLS-119hres830",
      billType: "hres",
      billNumber: "830",
      title: "Expel Representative Morgan Lee",
      raw: EXPULSION,
      hours: 8,
    },
    {
      guid: "BILLS-119hres831",
      billType: "hres",
      billNumber: "831",
      title: "Set House rules for the expulsion vote",
      raw: EXPULSION_RULE,
      hours: 9,
    },
    {
      guid: "BILLS-119sres401",
      billType: "sres",
      billNumber: "401",
      title: "Expel a senator",
      raw: resolution("A resolution expelling Senator Casey Morgan from the United States Senate."),
      hours: 10,
    },
  ];
  const RAW_BY_KEY = new Map(
    [...ROWS, ...EXPULSION_ROWS].map((row) => [`raw-bills/${row.guid.replace(/ih$/, "")}.json`, row.raw]),
  );

  const HEADLINES = [
    "Senate passes GENIUS Act, sending stablecoin bill to the House - Reuters",
    "House Republicans push SAVE Act vote ahead of midterms - AP News",
    "House to vote on H.J.Res. 150 as shutdown deadline nears - NPR",
    "House Democrats force vote to impeach Homeland Security chief Ellis - AP News",
    "House votes to censure Rep. Alex Rivera over floor remarks - Reuters",
    "Lawmakers mark Cybersecurity Awareness Month with House resolution - NPR",
  ];

  const feedWith = (titles: string[]) => {
    const published = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        `<rss><channel>${titles
          .map(
            (title, index) =>
              `<item><title>${title}</title><link>https://news.example/${index}</link><source>Wire</source><pubDate>${published}</pubDate></item>`,
          )
          .join("")}</channel></rss>`,
    } as Response);
  };

  const manifestItem = (row: (typeof ROWS)[number]) => ({
    pk: { S: "BILL" },
    sk: { S: `${hoursAgo(row.hours)}#${row.guid}` },
    guid: { S: row.guid },
    billType: { S: row.billType },
    congress: { S: row.congress ?? "119" },
    billNumber: { S: row.billNumber },
    updatedAt: { S: hoursAgo(row.hours) },
    title: { S: row.title },
    subCategories: { L: [] },
    lifeAreas: { L: [] },
    sponsors: { L: [] },
    cosponsors: { L: [] },
    // INT-11: the row's vote count is never read or sent.
    voteCount: { N: "41" },
  });

  const route = (options: { active?: Array<Record<string, unknown>>; rows?: typeof ROWS } = {}) =>
    mockDynamoSend.mockImplementation(async (command: DynamoCommand) => {
      const input = command.input ?? {};
      if (input.IndexName === "PriorityStatusIndex") return { Items: options.active ?? [] };
      if (input?.Key?.pk?.S === "BILL_COMPANION_GROUPS") return {};
      if (input.TableName === "BillsManifest") return { Items: (options.rows ?? ROWS).map(manifestItem) };
      if (input.TableName === "BillPriority" && input.Item) return {};
      throw new Error(`Unexpected DynamoDB request: ${JSON.stringify(input)}`);
    });

  const s3Serves = (overrides: Record<string, () => unknown> = {}) =>
    mockS3Send.mockImplementation(async (command: S3Command) => {
      const key = command.input.Key!;
      if (overrides[key]) return overrides[key]();
      const raw = RAW_BY_KEY.get(key);
      if (!raw) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      return { Body: bodyWithTransformToString(raw) };
    });

  const modelReturns = (bills: Array<{ guid: string; score: number; confidence?: number }>, inputTokens = 7400) =>
    mockBedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                bills: bills.map(({ guid, score, confidence }) => ({
                  guid,
                  isPriority: true,
                  score,
                  confidence: confidence ?? 0.85,
                  reason: "Covered by several national outlets this week.",
                })),
              }),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: inputTokens, output_tokens: 240 },
        }),
      ),
    });

  const candidatesSent = (): Array<{ guid: string }> => {
    const text: string = JSON.parse(mockBedrockSend.mock.calls[0][0].input.body).messages[0].content[0].text;
    return JSON.parse(text.slice(text.indexOf("{"))).candidates;
  };
  const sent = (guid: string) => candidatesSent().find((candidate) => candidate.guid === guid);
  const activePuts = () =>
    mockDynamoSend.mock.calls
      .map(([command]) => command.input)
      .filter((input) => input?.TableName === "BillPriority" && input?.Item?.status?.S === "ACTIVE")
      .map((input) => ({ guid: input.Item.guid.S, rank: input.Item.priorityRank.N }));
  const lines = (): LogLine[] => [...logLines(logSpy), ...logLines(warnSpy)];
  const eventLine = (event: string) => lines().find((line) => line.event === event);
  const metricLine = (name: string) =>
    lines().find((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/Bedrock" && name in line);

  const loadHandler = () => require("../handlers/billPriorityResolver").handler;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockBedrockSend.mockReset();
    mockS3Send.mockReset();
    useEnv();
    logSpy = jest.spyOn(console, "log").mockImplementation();
    warnSpy = jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
    feedWith(HEADLINES);
    route();
    s3Serves();
  });

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
    jest.restoreAllMocks();
  });

  it("sends bills, joint resolutions and impeachment or censure resolutions with their titles, and no ceremonial or procedural resolution", async () => {
    modelReturns([]);

    await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "ok", candidateBills: 6, titlesRead: 8 });

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(candidatesSent().map((candidate) => candidate.guid)).toEqual([
      "BILLS-119hjres150",
      "BILLS-119hr22",
      "BILLS-119hres820",
      "BILLS-119hres821",
      "BILLS-119s1582",
      "BILLS-119sjres88",
    ]);
    expect(sent("BILLS-119hr22")).toEqual({
      guid: "BILLS-119hr22",
      congress: "119",
      billType: "hr",
      billNumber: "22",
      title: "Requires proof of citizenship to register to vote",
      shortTitles: ["SAVE Act", "Safeguard American Voter Eligibility Act"],
      officialTitle: SAVE_ACT_OFFICIAL,
      billStatus: "",
      updatedAt: expect.any(String),
      explicitHeadlineMatches: 1,
      headlineOverlapCount: 0,
    });
    expect(sent("BILLS-119s1582")).toMatchObject({
      shortTitles: ["Guiding and Establishing National Innovation for U.S. Stablecoins Act", "GENIUS Act"],
      explicitHeadlineMatches: 1,
    });
    expect(sent("BILLS-119hjres150")).toMatchObject({ explicitHeadlineMatches: 1 });
    expect(sent("BILLS-119hres820")).not.toHaveProperty("shortTitles");
    expect(sent("BILLS-119hres820")).toMatchObject({
      officialTitle: "Impeaching Jordan Ellis, Secretary of Homeland Security, for high crimes and misdemeanors.",
      headlineOverlapCount: 1,
    });
    expect(sent("BILLS-119hres821")).toMatchObject({ headlineOverlapCount: 1 });
    expect(JSON.stringify(candidatesSent())).not.toContain("voteCount");

    // Raw bills are read under the plain guid; the Senate resolution was never loaded.
    const keys = mockS3Send.mock.calls.map(([command]) => command.input.Key).sort();
    expect(keys).toEqual([
      "raw-bills/BILLS-119hjres150.json",
      "raw-bills/BILLS-119hr22.json",
      "raw-bills/BILLS-119hres820.json",
      "raw-bills/BILLS-119hres821.json",
      "raw-bills/BILLS-119hres822.json",
      "raw-bills/BILLS-119hres823.json",
      "raw-bills/BILLS-119s1582.json",
      "raw-bills/BILLS-119sjres88.json",
    ]);
    expect(mockS3Send.mock.calls.every(([command]) => command.input.Bucket === "billboard-bill-store-bucket")).toBe(
      true,
    );

    expect(eventLine("priority_candidates")).toEqual(
      expect.objectContaining({
        level: "INFO",
        windowBills: 8,
        pool: 8,
        titleLookups: { found: 8, missing: 0, failed: 0, skipped: 0, tooLarge: 0 },
        excluded: { type: 0, ceremonial: 1, resolution: 1, noOfficialTitle: 0 },
        candidatesSent: 6,
        candidateTypes: { hjres: 1, hr: 1, hres: 2, s: 1, sjres: 1 },
        withShortTitle: 3,
        withOfficialTitle: 6,
        namedByNumber: 1,
        namedByShortTitle: 2,
        overlapping: 2,
      }),
    );
  });

  it("activates what the model picks from them, never a resolution it was not sent, and counts the new picks", async () => {
    modelReturns([
      { guid: "BILLS-119hjres150", score: 95 },
      { guid: "BILLS-119hr22", score: 88 },
      { guid: "BILLS-119hres820", score: 81 },
      // The commemorative resolution was never a candidate, whatever the model says about it.
      { guid: "BILLS-119hres822", score: 97 },
      { guid: "BILLS-119s1582", score: 62 },
    ]);

    await expect(loadHandler()()).resolves.toMatchObject({ activated: 3 });

    expect(activePuts()).toEqual([
      { guid: "BILLS-119hjres150", rank: "1" },
      { guid: "BILLS-119hr22", rank: "2" },
      { guid: "BILLS-119hres820", rank: "3" },
    ]);
    expect(eventLine("priority_answer")).toMatchObject({
      billsReturned: 5,
      billsPassing: 3,
      newPicks: 3,
      newPickGuids: ["BILLS-119hjres150", "BILLS-119hr22", "BILLS-119hres820"],
    });
    expect(metricLine("PriorityNewPicks")).toMatchObject({ PriorityNewPicks: 3, PriorityPassingBills: 3 });
    expect(metricLine("PriorityInputTokens")).toMatchObject({ PriorityInputTokens: 7400 });
  });

  it("sends an expulsion and activates it when picked, never the rule for it or a Senate expulsion", async () => {
    route({ rows: [...ROWS, ...EXPULSION_ROWS] });
    feedWith([...HEADLINES, "House votes to expel Rep. Morgan Lee over fraud charges - AP News"]);
    modelReturns([
      { guid: "BILLS-119hres830", score: 90 },
      // Neither was sent, whatever the model says about them.
      { guid: "BILLS-119hres831", score: 92 },
      { guid: "BILLS-119sres401", score: 92 },
    ]);

    await expect(loadHandler()()).resolves.toMatchObject({
      modelAnswer: "ok",
      candidateBills: 7,
      titlesRead: 10,
      activated: 1,
    });

    expect(sent("BILLS-119hres830")).toMatchObject({
      billType: "hres",
      billNumber: "830",
      officialTitle: "Expelling Representative Morgan Lee from the United States House of Representatives.",
      // "expel" and "Morgan" are in Billboard's headline and in the official title ("Expelling" stems to "expel").
      headlineOverlapCount: 1,
    });
    expect(sent("BILLS-119hres831")).toBeUndefined();
    expect(sent("BILLS-119sres401")).toBeUndefined();
    expect(mockS3Send.mock.calls.map(([command]) => command.input.Key)).not.toContain(
      "raw-bills/BILLS-119sres401.json",
    );
    expect(eventLine("priority_candidates")).toEqual(
      expect.objectContaining({
        windowBills: 10,
        pool: 10,
        excluded: { type: 0, ceremonial: 1, resolution: 2, noOfficialTitle: 0 },
        candidatesSent: 7,
        candidateTypes: { hjres: 1, hr: 1, hres: 3, s: 1, sjres: 1 },
      }),
    );
    expect(activePuts()).toEqual([{ guid: "BILLS-119hres830", rank: "1" }]);
  });

  it("does not count a bill picked again while it is in the news as a new pick", async () => {
    route({
      active: [
        {
          guid: { S: "BILLS-119hjres150" },
          status: { S: "ACTIVE" },
          isPriority: { BOOL: true },
          congress: { S: "119" },
          billType: { S: "hjres" },
          billNumber: { S: "150" },
          title: { S: "Extends government funding into December" },
          priorityRank: { N: "1" },
          priorityUpdatedAt: { S: hoursAgo(1) },
          priorityExpiresAt: { S: new Date(Date.now() + 11 * 60 * 60 * 1000).toISOString() },
        },
      ],
    });
    modelReturns([{ guid: "BILLS-119hjres150", score: 93 }]);

    await loadHandler()();

    expect(activePuts()).toEqual([{ guid: "BILLS-119hjres150", rank: "1" }]);
    expect(eventLine("priority_answer")).toMatchObject({ billsActivated: 1, newPicks: 0, newPickGuids: [] });
  });

  it("matches a bill whose raw bill cannot be read by its headline only, and still runs", async () => {
    s3Serves({
      "raw-bills/BILLS-119hr22.json": () => {
        throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
      },
      "raw-bills/BILLS-119s1582.json": () => {
        throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
      },
    });
    modelReturns([]);

    await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "ok", titlesRead: 6 });

    expect(sent("BILLS-119hr22")).toMatchObject({ explicitHeadlineMatches: 0 });
    expect(sent("BILLS-119hr22")).not.toHaveProperty("shortTitles");
    expect(sent("BILLS-119s1582")).not.toHaveProperty("officialTitle");
    expect(eventLine("priority_candidates")).toMatchObject({
      titleLookups: { found: 6, missing: 1, failed: 1, skipped: 0, tooLarge: 0 },
    });
    expect(lines().filter((line) => /could not read a raw bill's titles/.test(line.message!))).toEqual([
      expect.objectContaining({ level: "WARN", guid: "BILLS-119hr22" }),
    ]);
  });

  it("reads at most MAX_TITLE_LOOKUPS raw bills, the most likely first", async () => {
    useEnv({ MAX_TITLE_LOOKUPS: "1" });
    modelReturns([]);

    await loadHandler()();

    // H.J.Res. 150 is the only bill a headline names by number, so the heuristic without titles ranks it first.
    expect(mockS3Send.mock.calls.map(([command]) => command.input.Key)).toEqual(["raw-bills/BILLS-119hjres150.json"]);
    // Unread, H.Res. 822 ("Support Cybersecurity Awareness Month") is ceremonial by its headline alone (S6's day, week
    // and month clause, 2026-10-29), so it is counted as such, not as lacking an official title; it is not sent either
    // way.
    expect(eventLine("priority_candidates")).toMatchObject({
      titleLookups: { found: 1, missing: 0, failed: 0, skipped: 7, tooLarge: 0 },
      excluded: { type: 0, ceremonial: 1, resolution: 0, noOfficialTitle: 3 },
    });
    // Unread, no H.Res. is sent: Billboard's headline of the rule ("Set House rules for the impeachment debate") names
    // the impeachment too, and only the official title tells them apart. The bills and joint resolutions still go.
    expect(candidatesSent().map((candidate) => candidate.guid)).toEqual([
      "BILLS-119hjres150",
      "BILLS-119hr22",
      "BILLS-119s1582",
      "BILLS-119sjres88",
    ]);
  });

  it("reads no raw bill without a bill store, as before REL-51", async () => {
    useEnv({ BILL_STORE_BUCKET_NAME: undefined });
    modelReturns([]);

    await expect(loadHandler()()).resolves.toMatchObject({ titlesRead: 0 });

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(sent("BILLS-119hr22")).toMatchObject({ explicitHeadlineMatches: 0 });
    expect(eventLine("priority_candidates")).toMatchObject({
      titleLookups: { found: 0, missing: 0, failed: 0, skipped: 8, tooLarge: 0 },
      excluded: { ceremonial: 1, noOfficialTitle: 3 },
    });
  });

  it("counts only the headlines that name a bill in the neutral reason, never the word overlaps", async () => {
    mockBedrockSend.mockResolvedValueOnce({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                // Both reasons use a loaded word, so both are replaced by the neutral template.
                bills: [
                  {
                    guid: "BILLS-119hr22",
                    isPriority: true,
                    score: 90,
                    confidence: 0.8,
                    reason: "Critics call it a radical power grab.",
                  },
                  {
                    guid: "BILLS-119hres820",
                    isPriority: true,
                    score: 86,
                    confidence: 0.8,
                    reason: "A radical power grab, critics say.",
                  },
                ],
              }),
            },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 7400, output_tokens: 120 },
        }),
      ),
    });

    await loadHandler()();

    const reasonOf = (guid: string) =>
      mockDynamoSend.mock.calls
        .map(([command]) => command.input)
        .find((input) => input?.TableName === "BillPriority" && input?.Item?.guid?.S === guid)?.Item.priorityReason.S;
    // The SAVE Act is named by its short title in one headline.
    expect(reasonOf("BILLS-119hr22")).toBe("Named in 1 recent national news headline.");
    // The impeachment only shares words with one ("impeach Homeland Security chief Ellis"): no headline names it.
    expect(sent("BILLS-119hres820")).toMatchObject({ explicitHeadlineMatches: 0, headlineOverlapCount: 1 });
    expect(reasonOf("BILLS-119hres820")).toBe("In recent national news coverage.");
  });

  describe("bill numbers across two Congresses (REL-46)", () => {
    // A January week: the 120th's H.R. 1, and two 119th bills a late action touched.
    const JANUARY_ROWS: typeof ROWS = [
      {
        guid: "BILLS-119hr1",
        congress: "119",
        billType: "hr",
        billNumber: "1",
        title: "Cuts taxes and changes Medicaid and SNAP",
        raw: undefined,
        hours: 2,
      },
      {
        guid: "BILLS-120hr1ih",
        congress: "120",
        billType: "hr",
        billNumber: "1",
        title: "Sets new rules for federal elections",
        raw: undefined,
        hours: 5,
      },
      {
        guid: "BILLS-119hr1234",
        congress: "119",
        billType: "hr",
        billNumber: "1234",
        title: "Names a post office in Dayton, Ohio",
        raw: undefined,
        hours: 30,
      },
    ];
    const JANUARY_HEADLINES = [
      "House passes H.R. 1 on a party-line vote - AP News",
      "President signs H.R. 1234 into law - Reuters",
    ];

    it("counts a headline's bill number for the newest Congress's bill of that type and number only", async () => {
      route({ rows: JANUARY_ROWS });
      feedWith(JANUARY_HEADLINES);
      modelReturns([]);

      await loadHandler()();

      expect(sent("BILLS-120hr1")).toMatchObject({ congress: "120", explicitHeadlineMatches: 1 });
      expect(sent("BILLS-119hr1")).toMatchObject({ congress: "119", explicitHeadlineMatches: 0 });
      expect(sent("BILLS-119hr1234")).toMatchObject({ congress: "119", explicitHeadlineMatches: 1 });
      expect(eventLine("priority_candidates")).toEqual(
        expect.objectContaining({ candidatesSent: 3, namedByNumber: 2 }),
      );
    });

    it("gives the older H.R. 1 no guaranteed place among the candidates", async () => {
      useEnv({ MAX_CANDIDATE_BILLS: "2" });
      route({ rows: JANUARY_ROWS });
      feedWith(JANUARY_HEADLINES);
      modelReturns([]);

      await loadHandler()();

      expect(candidatesSent().map((candidate) => candidate.guid)).toEqual(["BILLS-119hr1234", "BILLS-120hr1"]);
    });
  });

  describe("raw bill reads: time, concurrency and size (REL-51: Bedrock's time and the function's memory)", () => {
    const keyOf = (command: S3Command): string => command.input.Key!;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const destroyableBody = (raw: unknown, onRead: () => Promise<void> = async () => undefined) => ({
      transformToString: jest.fn(async () => {
        await onRead();
        return JSON.stringify(raw);
      }),
      destroy: jest.fn(),
    });

    it("gives every read an abort signal and counts a read that does not answer in TITLE_READ_TIMEOUT_MS as failed", async () => {
      useEnv({ TITLE_READ_TIMEOUT_MS: "30" });
      mockS3Send.mockImplementation(async (command: S3Command, options?: { abortSignal?: AbortSignal }) => {
        if (keyOf(command) === "raw-bills/BILLS-119hr22.json") {
          // S3 never answers: only the abort ends the read.
          return await new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("Request aborted"), { name: "AbortError" })),
            );
          });
        }
        return { Body: bodyWithTransformToString(RAW_BY_KEY.get(keyOf(command))) };
      });
      modelReturns([]);

      await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "ok", titlesRead: 7 });

      expect(mockS3Send).toHaveBeenCalledTimes(8);
      for (const [, options] of mockS3Send.mock.calls) {
        expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      }
      expect(eventLine("priority_candidates")).toMatchObject({
        titleLookups: { found: 7, missing: 0, failed: 1, skipped: 0, tooLarge: 0 },
      });
      expect(sent("BILLS-119hr22")).not.toHaveProperty("shortTitles");
    });

    it("has at most TITLE_LOOKUP_CONCURRENCY reads in flight", async () => {
      useEnv({ TITLE_LOOKUP_CONCURRENCY: "3" });
      let inFlight = 0;
      let most = 0;
      mockS3Send.mockImplementation(async (command: S3Command) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await wait(5);
        return {
          Body: destroyableBody(RAW_BY_KEY.get(keyOf(command)), async () => {
            await wait(5);
            inFlight -= 1;
          }),
        };
      });
      modelReturns([]);

      await expect(loadHandler()()).resolves.toMatchObject({ titlesRead: 8 });

      expect(most).toBe(3);
    });

    it("starts no read after TITLE_LOOKUP_BUDGET_MS and counts the rest as skipped", async () => {
      useEnv({ TITLE_LOOKUP_CONCURRENCY: "1", TITLE_LOOKUP_BUDGET_MS: "1000" });
      const realNow = Date.now.bind(Date);
      let elapsed = 0;
      jest.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
      mockS3Send.mockImplementation(async (command: S3Command) => {
        // The first read takes the whole budget.
        elapsed += 2000;
        return { Body: bodyWithTransformToString(RAW_BY_KEY.get(keyOf(command))) };
      });
      modelReturns([]);

      await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "ok", titlesRead: 1 });

      expect(mockS3Send.mock.calls.map(([command]) => keyOf(command))).toEqual(["raw-bills/BILLS-119hjres150.json"]);
      expect(eventLine("priority_candidates")).toMatchObject({
        titleLookups: { found: 1, missing: 0, failed: 0, skipped: 7, tooLarge: 0 },
      });
    });

    it("reads a large raw bill alone, and the small ones beside it", async () => {
      useEnv({ TITLE_LOOKUP_CONCURRENCY: "6", TITLE_LARGE_BODY_BYTES: "10000" });
      const large = new Set([
        "raw-bills/BILLS-119hr22.json",
        "raw-bills/BILLS-119s1582.json",
        "raw-bills/BILLS-119hjres150.json",
        "raw-bills/BILLS-119hres820.json",
      ]);
      let largeInFlight = 0;
      let mostLarge = 0;
      let smallInFlight = 0;
      let mostSmall = 0;
      mockS3Send.mockImplementation(async (command: S3Command) => {
        const isLarge = large.has(keyOf(command));
        return {
          ContentLength: isLarge ? 3_000_000 : 4_000,
          Body: destroyableBody(RAW_BY_KEY.get(keyOf(command)), async () => {
            if (isLarge) {
              largeInFlight += 1;
              mostLarge = Math.max(mostLarge, largeInFlight);
            } else {
              smallInFlight += 1;
              mostSmall = Math.max(mostSmall, smallInFlight);
            }
            await wait(5);
            if (isLarge) largeInFlight -= 1;
            else smallInFlight -= 1;
          }),
        };
      });
      modelReturns([]);

      await expect(loadHandler()()).resolves.toMatchObject({ titlesRead: 8 });

      expect(mostLarge).toBe(1);
      expect(mostSmall).toBeGreaterThan(1);
      expect(sent("BILLS-119hr22")).toMatchObject({
        shortTitles: ["SAVE Act", "Safeguard American Voter Eligibility Act"],
      });
    });

    it("does not read a large raw bill whose turn comes after the budget", async () => {
      useEnv({ TITLE_LOOKUP_CONCURRENCY: "2", TITLE_LOOKUP_BUDGET_MS: "1000", TITLE_LARGE_BODY_BYTES: "10000" });
      const realNow = Date.now.bind(Date);
      let elapsed = 0;
      jest.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
      const bodies: Array<ReturnType<typeof destroyableBody>> = [];
      mockS3Send.mockImplementation(async (command: S3Command) => {
        const body = destroyableBody(RAW_BY_KEY.get(keyOf(command)), async () => {
          // The first large body takes the whole budget to read.
          await wait(5);
          elapsed += 2000;
        });
        bodies.push(body);
        return { ContentLength: 3_000_000, Body: body };
      });
      modelReturns([]);

      await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "ok", titlesRead: 1 });

      // Two reads started side by side; the second waited for the first and was let go unread.
      expect(mockS3Send).toHaveBeenCalledTimes(2);
      expect(bodies.map((body) => body.transformToString.mock.calls.length)).toEqual([1, 0]);
      expect(bodies[1].destroy).toHaveBeenCalled();
      expect(eventLine("priority_candidates")).toMatchObject({
        titleLookups: { found: 1, missing: 0, failed: 0, skipped: 7, tooLarge: 0 },
      });
    });

    it("does not read a raw bill over TITLE_MAX_BODY_BYTES, and matches that bill by its headline only", async () => {
      useEnv({ TITLE_MAX_BODY_BYTES: "50000000" });
      const omnibus = destroyableBody(SAVE_ACT);
      mockS3Send.mockImplementation(async (command: S3Command) =>
        keyOf(command) === "raw-bills/BILLS-119hr22.json"
          ? { ContentLength: 60_000_000, Body: omnibus }
          : { Body: bodyWithTransformToString(RAW_BY_KEY.get(keyOf(command))) },
      );
      modelReturns([]);

      await expect(loadHandler()()).resolves.toMatchObject({ modelAnswer: "ok", titlesRead: 7 });

      expect(omnibus.transformToString).not.toHaveBeenCalled();
      expect(omnibus.destroy).toHaveBeenCalled();
      expect(sent("BILLS-119hr22")).not.toHaveProperty("shortTitles");
      expect(eventLine("priority_candidates")).toMatchObject({
        titleLookups: { found: 7, missing: 0, failed: 0, skipped: 0, tooLarge: 1 },
      });
      expect(lines().filter((line) => /too large/.test(line.message!))).toEqual([
        expect.objectContaining({ level: "INFO", guid: "BILLS-119hr22", bytes: 60_000_000 }),
      ]);
    });
  });
});

describe("billPriorityResolver request size (REL-51: Bedrock cost)", () => {
  const {
    buildPriorityRequestBody,
    buildPriorityPayload,
    getSystemPrompt,
  } = require("../handlers/billPriorityResolver/prompts");
  const { requestTextChars } = require("../../scripts/eval/scoring");
  const {
    OFFICIAL_TITLE_MAX_CHARS,
    SHORT_TITLE_MAX_CHARS,
    MAX_SHORT_TITLES,
  } = require("../handlers/billPriorityResolver/billTitles");

  it("sends the titles only when a bill has them", () => {
    const payload = buildPriorityPayload({
      headlines: [],
      candidates: [
        { guid: "BILLS-119hr22", billType: "hr", title: "A", shortTitles: ["SAVE Act"], officialTitle: "To amend ..." },
        { guid: "BILLS-119hr23", billType: "hr", title: "B", shortTitles: [] },
      ],
      maxResults: 8,
    });
    expect(payload.candidates[0]).toMatchObject({ shortTitles: ["SAVE Act"], officialTitle: "To amend ..." });
    expect(payload.candidates[1]).not.toHaveProperty("shortTitles");
    expect(payload.candidates[1]).not.toHaveProperty("officialTitle");
  });

  it("tells the model what the titles and the counts are", () => {
    const prompt: string = getSystemPrompt();
    expect(prompt).toContain("shortTitles: the short titles Congress gave it");
    expect(prompt).toContain("officialTitle: its official title");
    expect(prompt).toContain("hjres or sjres (a joint resolution)");
    expect(prompt).toContain("hres (a House resolution to impeach, censure or expel)");
  });

  // 30 headlines at the cap and 50 candidates with every title at its cap: the most one call can send.
  it("stays under 64,000 characters (about 16,000 tokens) at every cap", () => {
    const longText = (chars: number) => "word ".repeat(Math.ceil(chars / 5)).slice(0, chars);
    const headlines = Array.from({ length: 30 }, (_, index) => ({
      source: "Associated Press",
      title: longText(300),
      publishedAt: `Wed, 28 Oct 2026 1${index % 10}:00:00 GMT`,
    }));
    const candidates = Array.from({ length: 50 }, (_, index) => ({
      guid: `BILLS-119hjres${10000 + index}`,
      congress: "119",
      billType: "hjres",
      billNumber: String(10000 + index),
      title: longText(100),
      shortTitles: Array.from({ length: MAX_SHORT_TITLES }, () => longText(SHORT_TITLE_MAX_CHARS)),
      officialTitle: longText(OFFICIAL_TITLE_MAX_CHARS),
      billStatus: "Updated",
      updatedAt: "2026-10-28T14:03:11.123Z",
      explicitHeadlineMatches: 12,
      headlineOverlapCount: 30,
    }));
    const body = buildPriorityRequestBody(headlines, candidates, {
      profile: "haiku-4-5",
      maxTokens: 4096,
      effort: "low",
      now: new Date("2026-10-29T12:00:00.000Z"),
      maxResults: 8,
    });
    expect(requestTextChars(body)).toBeLessThan(64_000);
  });
});
