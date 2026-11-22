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

describe("latestManifestAction (UX-29)", () => {
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

  it("of one day, takes the greatest actionTime, then the first listed (congress.gov lists the newest first)", () => {
    const timed = {
      actionCode: "H30000",
      actionDate: "2026-03-04",
      actionTime: "14:32:10",
      text: "Considered as unfinished business.",
    };
    const earlier = {
      actionCode: "H30000",
      actionDate: "2026-03-04",
      actionTime: "09:01:00",
      text: "Rule provides for consideration.",
    };
    const untimed = { actionCode: "8000", actionDate: "2026-03-04", text: "Passed/agreed to in House." };
    expect(latestManifestAction([untimed, earlier, timed])?.text).toBe("Considered as unfinished business.");
    expect(latestManifestAction([referred, introduced])?.text).toBe(referred.text);
    expect(latestManifestAction([introduced, referred])?.text).toBe(introduced.text);
  });

  it("names the action by the first listed with text at that moment, and leaves text out when none has any", () => {
    const textless = { actionCode: "10000", actionDate: "2026-02-10", type: "IntroReferral" };
    expect(latestManifestAction([textless, { ...introduced, text: "  " }, referred])).toEqual({
      actionDate: "2026-02-10",
      text: referred.text,
    });
    expect(latestManifestAction([textless, { ...introduced, text: "" }])).toEqual({ actionDate: "2026-02-10" });
  });

  it("skips actions without a calendar day, and is null when none has one", () => {
    expect(latestManifestAction([{ actionDate: "2026-02-30", text: "Typo" }, referred])).toEqual({
      actionDate: "2026-02-10",
      text: referred.text,
    });
    expect(latestManifestAction([{ text: "Introduced in House" }])).toBeNull();
    expect(latestManifestAction([])).toBeNull();
    expect(latestManifestAction(undefined)).toBeNull();
    expect(latestManifestAction({ actions: [referred] })).toBeNull();
  });
});
