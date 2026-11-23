import { billIntroducedDate, latestManifestAction } from "../shared/billManifestFacts";
import { calendarDay } from "../shared/calendarDay";

describe("calendarDay", () => {
  it.each([
    ["2026-03-05", "2026-03-05"],
    [" 2026-03-05 ", "2026-03-05"],
    ["2026-03-05T14:32:10Z", "2026-03-05"],
    ["2024-02-29", "2024-02-29"],
  ])("reads %j as %j", (value, expected) => {
    expect(calendarDay(value)).toBe(expected);
  });

  it.each([["2026-02-30"], ["2025-02-29"], ["2026-13-01"], ["2026-00-10"], ["2026-3-5"], ["March 5, 2026"], [""]])(
    "rejects %j",
    (value) => {
      expect(calendarDay(value)).toBeNull();
    },
  );

  it("rejects anything that is not a string", () => {
    for (const value of [undefined, null, 20260305, new Date("2026-03-05"), { S: "2026-03-05" }]) {
      expect(calendarDay(value)).toBeNull();
    }
  });
});

describe("billIntroducedDate (UX-29)", () => {
  const actions = [
    {
      actionCode: "H11100",
      actionDate: "2026-02-11",
      text: "Referred to the Subcommittee on Energy.",
      type: "Committee",
    },
    { actionCode: "1000", actionDate: "2026-02-10", text: "Introduced in House", type: "IntroReferral" },
    { actionCode: "H11100", actionDate: "2026-02-10", text: "Referred to the Committee on Energy and Commerce." },
  ];

  it("takes the document's introducedDate when it is a calendar day", () => {
    expect(billIntroducedDate("2026-02-09", actions)).toBe("2026-02-09");
  });

  it("else the earliest calendar day among the actions, whatever their order", () => {
    expect(billIntroducedDate(undefined, actions)).toBe("2026-02-10");
    expect(billIntroducedDate("2026-02-30", [...actions].reverse())).toBe("2026-02-10");
    expect(billIntroducedDate("", [{ actionDate: "Feb 1, 2026" }, ...actions])).toBe("2026-02-10");
  });

  it("is null without either", () => {
    expect(billIntroducedDate(undefined, [])).toBeNull();
    expect(billIntroducedDate(null, undefined)).toBeNull();
    expect(billIntroducedDate(undefined, [{ text: "Introduced in House" }, null, "2026-02-10"])).toBeNull();
  });
});

describe("latestManifestAction (UX-29, UX-43): the app's and the website's Latest action", () => {
  const referred = {
    actionCode: "H11100",
    actionDate: "2026-02-10",
    text: "Referred to the House Committee on Energy and Commerce.",
    type: "IntroReferral",
  };
  const introduced = {
    actionCode: "1000",
    actionDate: "2026-02-10",
    text: "Introduced in House",
    type: "IntroReferral",
  };
  // H.R. 5371's enactment day as congress.gov lists it, newest first (billboard-ios ProcessedBillDecodingTests
  // testTimelineKeepsTheStoredOrderOfOneDay): the Library of Congress and President lines have no time, the House's
  // floor lines do.
  const lawDay = [
    { actionCode: "36000", actionDate: "2025-11-12", text: "Became Public Law No: 119-37.", type: "President" },
    { actionCode: "36000", actionDate: "2025-11-12", text: "Became Public Law No: 119-37.", type: "BecameLaw" },
    { actionCode: "36000", actionDate: "2025-11-12", text: "Signed by President.", type: "President" },
    { actionCode: "E30000", actionDate: "2025-11-12", text: "Signed by President.", type: "BecameLaw" },
    { actionCode: "E20000", actionDate: "2025-11-12", text: "Presented to President.", type: "Floor" },
    { actionCode: "28000", actionDate: "2025-11-12", text: "Presented to President.", type: "President" },
    {
      actionCode: "H38310",
      actionDate: "2025-11-12",
      actionTime: "22:15:38",
      text: "Motion to reconsider laid on the table Agreed to without objection.",
      type: "ResolvingDifferences",
    },
    {
      actionCode: "H36210",
      actionDate: "2025-11-12",
      actionTime: "21:39:20",
      text: "The previous question was ordered pursuant to the rule.",
      type: "ResolvingDifferences",
    },
    {
      actionCode: "17000",
      actionDate: "2025-11-10",
      text: "Passed Senate with an amendment by Yea-Nay Vote. 60 - 40.",
      type: "Floor",
    },
  ];

  it("gives the day and text of the latest action, citations kept, text trimmed", () => {
    const passed = {
      actionCode: "8000",
      actionDate: "2026-03-04",
      text: "  Passed/agreed to in House: On passage Passed by voice vote.(text: CR H1234-1240) ",
      type: "Floor",
    };
    expect(latestManifestAction([passed, referred, introduced])).toEqual({
      actionDate: "2026-03-04",
      text: "Passed/agreed to in House: On passage Passed by voice vote.(text: CR H1234-1240)",
    });
    // Listed out of order: the greatest day still wins.
    expect(latestManifestAction([introduced, passed, referred])?.actionDate).toBe("2026-03-04");
  });

  it("names the law on the day a bill became law, though the House's lines of that day have a time", () => {
    expect(latestManifestAction(lawDay)).toEqual({ actionDate: "2025-11-12", text: "Became Public Law No: 119-37." });
  });

  it("of one day, takes the first listed and never reads actionTime (congress.gov lists the newest first)", () => {
    const timed = { ...lawDay[6], actionTime: "23:59:59" };
    expect(latestManifestAction([lawDay[2], timed, lawDay[0]])?.text).toBe("Signed by President.");
    expect(latestManifestAction([referred, introduced])?.text).toBe(referred.text);
    expect(latestManifestAction([introduced, referred])?.text).toBe(introduced.text);
    // A greater day wins wherever it is listed.
    expect(latestManifestAction([lawDay[8], ...lawDay.slice(0, 8)])?.text).toBe("Became Public Law No: 119-37.");
  });

  it("takes the veto's line in place of the House's line of the same day and text, as the app does", () => {
    const house = { actionCode: "E30000", actionDate: "2026-06-02", text: "Vetoed by President.", type: "President" };
    const veto = { actionCode: "31000", actionDate: "2026-06-02", text: "Vetoed by president.", type: "Veto" };
    expect(latestManifestAction([house, veto, referred])).toEqual({
      actionDate: "2026-06-02",
      text: "Vetoed by president.",
    });
    expect(latestManifestAction([house, { ...veto, text: "Vetoed." }])?.text).toBe("Vetoed by President.");
  });

  it("skips a line without text beside one with text, and leaves text out when the app shows a type", () => {
    // congress.gov gives an Intro-S IntroReferral action no text beside the chamber's own introduction line.
    const textless = { actionCode: "Intro-S", actionDate: "2026-02-10", type: "IntroReferral" };
    expect(latestManifestAction([textless, { ...introduced, text: "  " }, referred])).toEqual({
      actionDate: "2026-02-10",
      text: referred.text,
    });
    // No action of its day has text: the app lists it by its type, so it is the latest, without text.
    expect(latestManifestAction([textless, { ...introduced, text: "" }])).toEqual({ actionDate: "2026-02-10" });
    // A veto without text is listed by its code, whatever its type.
    expect(latestManifestAction([{ actionCode: "31000", actionDate: "2026-06-02" }, referred])).toEqual({
      actionDate: "2026-06-02",
    });
  });

  it("passes over a line the app leaves out: no text, and a type without a label", () => {
    const unlabelled = { actionCode: "H12345", actionDate: "2026-02-12", type: "NotAType" };
    expect(latestManifestAction([unlabelled, referred])).toEqual({ actionDate: "2026-02-10", text: referred.text });
    expect(latestManifestAction([{ ...unlabelled, type: undefined }])).toBeNull();
  });

  it("is null when the action the app shows last has no calendar day, or there is none", () => {
    // The app shows this line as the latest, so the row names no other in its place.
    expect(latestManifestAction([{ actionDate: "2026-02-30", text: "Typo" }, referred])).toBeNull();
    // An undated action sorts after every dated one, as in the app.
    expect(latestManifestAction([{ text: "Introduced in House" }, referred])).toEqual({
      actionDate: "2026-02-10",
      text: referred.text,
    });
    expect(latestManifestAction([{ text: "Introduced in House" }])).toBeNull();
    expect(latestManifestAction([])).toBeNull();
    expect(latestManifestAction(undefined)).toBeNull();
    expect(latestManifestAction({ actions: [referred] })).toBeNull();
  });
});
