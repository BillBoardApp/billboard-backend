import type { RecentActionItemV1 } from "../contracts";
import {
  buildRecentActionItems,
  calendarDayOf,
  chamberRollCalls,
  easternDayOfTime,
  latestRecentAction,
  recentActionId,
  recentActionsWindowStart,
  voteTimingFor,
  type CallerVote,
  type RecentActionsInput,
} from "../handlers/fetchRecentActions/recentActions";

// 2026-11-25 10:00 Eastern: the window's first day is 2026-10-26 (30 Eastern days before 2026-11-25).
const NOW = Date.parse("2026-11-25T15:00:00.000Z");
const WINDOW_START = "2026-10-26";

const floor = { code: 2, name: "House floor actions" };
const loc = { code: 9, name: "Library of Congress" };

/** H.R. 9614's passage day as congress.gov lists it (newest first): the follow-up and the floor line come first. */
const housePassageDay = (day: string) => [
  {
    actionCode: "H38310",
    actionDate: day,
    sourceSystem: floor,
    text: "Motion to reconsider laid on the table Agreed to without objection.",
    type: "Floor",
  },
  {
    actionCode: "H37300",
    actionDate: day,
    sourceSystem: floor,
    text: "On motion to suspend the rules and pass the bill Agreed to by voice vote.",
    type: "Floor",
  },
  {
    actionCode: "8000",
    actionDate: day,
    sourceSystem: loc,
    text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.",
    type: "Floor",
  },
  {
    actionCode: "H30000",
    actionDate: day,
    sourceSystem: floor,
    text: "Considered under suspension of the rules.",
    type: "Floor",
  },
];

const reported = (day: string) => ({
  actionCode: "H12200",
  actionDate: day,
  sourceSystem: floor,
  text: "Reported by the Committee on Energy and Commerce. H. Rept. 119-876.",
  type: "Committee",
});

const officialVotes = (house?: string, senate?: string) => ({
  lastSyncedAt: "2026-11-24T12:00:00.000Z",
  source: "congress_api",
  completeness: "complete",
  ...(house ? { house: chamberVote(house) } : {}),
  ...(senate ? { senate: chamberVote(senate) } : {}),
});
const chamberVote = (actionDate: string) => ({
  yea: 300,
  nay: 120,
  present: 0,
  notVoting: 12,
  totalCounted: 432,
  actionDate,
  memberDataAvailable: false,
  members: [],
});

const bill = (guid: string, title: string, actions: unknown[], extra: Record<string, unknown> = {}) => ({
  guid,
  title,
  billStatus: "New",
  actions,
  ...extra,
});

const vote = (feedback: CallerVote["feedback"], votedAt: string | null = "2026-10-20T14:00:00.000Z"): CallerVote => ({
  feedback,
  votedAt,
});

const build = (input: Partial<RecentActionsInput> & Pick<RecentActionsInput, "groups" | "bills">) =>
  buildRecentActionItems({
    movedAt: new Map(),
    votes: new Map(),
    watched: new Set(),
    nowMs: NOW,
    windowDays: 30,
    ...input,
  });

describe("calendarDayOf", () => {
  it.each([
    ["2026-11-19", "2026-11-19"],
    ["2026-11-19T00:00:00Z", "2026-11-19"],
    [" 2026-11-19 ", "2026-11-19"],
    ["2026-02-30", null],
    ["2026-3-5", null],
    ["Nov 19, 2026", null],
    [20261119, null],
    ["", null],
  ])("reads %p as %p", (value, day) => {
    expect(calendarDayOf(value)).toBe(day);
  });
});

describe("recentActionsWindowStart", () => {
  it("counts Eastern days: 9 PM Eastern on Nov 24 is still Nov 24", () => {
    expect(recentActionsWindowStart(NOW, 30)).toBe(WINDOW_START);
    expect(recentActionsWindowStart(Date.parse("2026-11-25T02:00:00.000Z"), 30)).toBe("2026-10-25");
  });
});

describe("latestRecentAction", () => {
  it("names the bill's own outcome on its latest day, past the follow-up and the floor line listed first", () => {
    const actions = [...housePassageDay("2026-11-19"), reported("2026-11-05")];
    expect(latestRecentAction(actions, WINDOW_START)).toEqual({
      date: "2026-11-19",
      text: "Passed the House",
      actionCode: "8000",
    });
  });

  it("takes the latest day's first line, without its final period, when the day has no outcome", () => {
    const received = {
      actionDate: "2026-11-20",
      sourceSystem: { code: 0, name: "Senate" },
      text: "Received in the Senate and Read twice and referred to the Committee on Homeland Security and Governmental Affairs.",
      type: "IntroReferral",
    };
    expect(latestRecentAction([received, ...housePassageDay("2026-11-19")], WINDOW_START)).toEqual({
      date: "2026-11-20",
      text: "Received in the Senate and Read twice and referred to the Committee on Homeland Security and Governmental Affairs",
    });
  });

  it("passes over a routine follow-up on a later day for the action it follows", () => {
    const message = { actionDate: "2026-11-20", text: "Message on Senate action sent to the House.", type: "Floor" };
    const passed = {
      actionCode: "17000",
      actionDate: "2026-11-19",
      text: "Passed Senate without amendment by Unanimous Consent.",
      type: "Floor",
    };
    expect(latestRecentAction([message, passed], WINDOW_START)).toEqual({
      date: "2026-11-19",
      text: "Passed the Senate",
      actionCode: "17000",
    });
  });

  it("uses a routine follow-up when the window has nothing else", () => {
    const held = { actionDate: "2026-11-20", text: "Held at the desk.", type: "Floor" };
    expect(latestRecentAction([held, reported("2026-09-30")], WINDOW_START)).toEqual({
      date: "2026-11-20",
      text: "Held at the desk",
    });
  });

  it("says Became law for a law line (REL-44)", () => {
    const actions = [
      { actionCode: "36000", actionDate: "2026-11-12", text: "Became Public Law No: 119-37.", type: "BecameLaw" },
      { actionCode: "36000", actionDate: "2026-11-12", text: "Signed by President.", type: "BecameLaw" },
      { actionCode: "28000", actionDate: "2026-11-12", text: "Presented to President.", type: "Floor" },
    ];
    expect(latestRecentAction(actions, WINDOW_START)).toEqual({
      date: "2026-11-12",
      text: "Became law",
      actionCode: "36000",
    });
  });

  it("says a failed suspension vote fell short of two-thirds (REL-50)", () => {
    const failed = {
      actionCode: "9000",
      actionDate: "2026-11-18",
      text: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 301).",
      type: "Floor",
    };
    expect(latestRecentAction([failed], WINDOW_START)).toEqual({
      date: "2026-11-18",
      text: "House vote fell short of two-thirds",
      actionCode: "9000",
    });
  });

  it("strips Congressional Record and roll-call references from Congress's text", () => {
    const considered = {
      actionCode: "H30000",
      actionDate: "2026-11-17",
      text: "Considered as unfinished business. (consideration: CR H4567-4570)",
      type: "Floor",
    };
    expect(latestRecentAction([considered], WINDOW_START)?.text).toBe("Considered as unfinished business");
  });

  it("leaves out actions before the window, without a calendar day, or without words", () => {
    expect(latestRecentAction([reported("2026-10-25")], WINDOW_START)).toBeNull();
    expect(latestRecentAction([{ ...reported("2026-11-05"), actionDate: "Nov 5" }], WINDOW_START)).toBeNull();
    expect(
      latestRecentAction([{ actionCode: "Intro-S", actionDate: "2026-11-05", type: "IntroReferral" }], WINDOW_START),
    ).toBeNull();
    expect(latestRecentAction([null, "text", 7, []], WINDOW_START)).toBeNull();
    expect(latestRecentAction(undefined, WINDOW_START)).toBeNull();
    expect(latestRecentAction([reported(WINDOW_START)], WINDOW_START)?.date).toBe(WINDOW_START);
  });

  it("cuts a long text at a word, within the contract's 300 characters", () => {
    const words = `${"Rule provides for consideration ".repeat(20)}end.`;
    const text = latestRecentAction([{ actionDate: "2026-11-10", text: words, type: "Floor" }], WINDOW_START)!.text;
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith("…")).toBe(true);
    const kept = text.slice(0, -1);
    expect(words.startsWith(kept)).toBe(true);
    expect(words[kept.length]).toBe(" ");
  });
});

describe("chamberRollCalls and voteTimingFor", () => {
  it("reads the House and Senate votes How Congress voted shows, and nothing from unusable votes", () => {
    expect(chamberRollCalls({ officialVotes: officialVotes("2026-11-19", "2026-11-21T00:00:00Z") })).toEqual([
      { chamber: "House", date: "2026-11-19" },
      { chamber: "Senate", date: "2026-11-21" },
    ]);
    expect(chamberRollCalls({ officialVotes: { ...officialVotes("2026-11-19"), source: "other" } })).toEqual([]);
    expect(chamberRollCalls({ officialVotes: { ...officialVotes("2026-11-19"), house: { yea: 3 } } })).toEqual([]);
    expect(chamberRollCalls(null)).toEqual([]);
  });

  it("counts Eastern days: a vote at 9:30 PM Eastern is the day before in UTC terms", () => {
    expect(easternDayOfTime("2026-11-19T02:30:00.000Z")).toBe("2026-11-18");
    expect(easternDayOfTime("not a time")).toBeNull();
    expect(easternDayOfTime(null)).toBeNull();
    const votedOn = easternDayOfTime("2026-11-19T02:30:00.000Z");
    expect(voteTimingFor(votedOn, [{ chamber: "House", date: "2026-11-19" }], WINDOW_START)).toEqual({
      chamber: "House",
      rollCallDate: "2026-11-19",
      daysBefore: 1,
    });
  });

  it("is absent on the roll call's own day, after it, without a vote day or without a roll call in the window", () => {
    const house = [{ chamber: "House" as const, date: "2026-11-19" }];
    expect(voteTimingFor("2026-11-19", house, WINDOW_START)).toBeUndefined();
    expect(voteTimingFor("2026-11-20", house, WINDOW_START)).toBeUndefined();
    expect(voteTimingFor(null, house, WINDOW_START)).toBeUndefined();
    expect(voteTimingFor("2026-09-01", [{ chamber: "House", date: "2026-10-01" }], WINDOW_START)).toBeUndefined();
    expect(voteTimingFor("2026-09-01", [], WINDOW_START)).toBeUndefined();
  });

  it("names the latest roll call, and the House's of two on one day", () => {
    const calls = [
      { chamber: "House" as const, date: "2026-11-02" },
      { chamber: "Senate" as const, date: "2026-11-19" },
    ];
    expect(voteTimingFor("2026-10-26", calls, WINDOW_START)).toEqual({
      chamber: "Senate",
      rollCallDate: "2026-11-19",
      daysBefore: 24,
    });
    expect(
      voteTimingFor(
        "2026-10-26",
        [
          { chamber: "Senate", date: "2026-11-19" },
          { chamber: "House", date: "2026-11-19" },
        ],
        WINDOW_START,
      ),
    ).toMatchObject({ chamber: "House" });
  });

  it("crosses a clock change by calendar days", () => {
    // US clocks went back on 2026-11-01: still 7 calendar days from Oct 29 to Nov 5.
    expect(voteTimingFor("2026-10-29", [{ chamber: "Senate", date: "2026-11-05" }], WINDOW_START)?.daysBefore).toBe(7);
  });
});

describe("buildRecentActionItems", () => {
  const HR77 = "BILLS-119hr77";
  const S50 = "BILLS-119s50";
  const HR90 = "BILLS-119hr90";

  it("lists a voted bill with the vote, its day and the days before the House's roll call", () => {
    const items = build({
      groups: [[HR77]],
      bills: new Map([
        [
          HR77,
          bill(HR77, "Rural Broadband Access Act", housePassageDay("2026-11-19"), {
            billStatus: "Passed",
            officialVotes: officialVotes("2026-11-19"),
          }),
        ],
      ]),
      votes: new Map([[HR77, vote("Yea", "2026-10-26T16:00:00.000Z")]]),
    });
    expect(items).toEqual([
      {
        id: recentActionId(HR77, { date: "2026-11-19", text: "Passed the House" }),
        billGuid: HR77,
        congress: "119",
        billType: "hr",
        billNumber: "77",
        officialNumber: "H.R. 77",
        title: "Rural Broadband Access Act",
        billStatus: "Passed",
        action: {
          date: "2026-11-19",
          text: "Passed the House",
          actionCode: "8000",
          billGuid: HR77,
          officialNumber: "H.R. 77",
        },
        yourVote: "Yea",
        votedOn: "2026-10-26",
        voteTiming: { chamber: "House", rollCallDate: "2026-11-19", daysBefore: 24 },
        watched: false,
      },
    ]);
  });

  it("lists a watched bill without a vote, and an Abstain as a vote", () => {
    const items = build({
      groups: [[HR77], [HR90]],
      bills: new Map([
        [HR77, bill(HR77, "Watched bill", [reported("2026-11-05")])],
        [HR90, bill(HR90, "Abstained bill", [reported("2026-11-06")])],
      ]),
      votes: new Map([[HR90, vote("Abstain", null)]]),
      watched: new Set([HR77]),
    });
    expect(items.map(({ billGuid, yourVote, votedOn, watched }) => ({ billGuid, yourVote, votedOn, watched }))).toEqual(
      [
        { billGuid: HR90, yourVote: "Abstain", votedOn: undefined, watched: false },
        { billGuid: HR77, yourVote: undefined, votedOn: undefined, watched: true },
      ],
    );
    expect(items[1]).not.toHaveProperty("yourVote");
    expect(items[0]).not.toHaveProperty("voteTiming");
  });

  it("leaves out a bill with no action in the window and a bill that was not read", () => {
    const items = build({
      groups: [[HR77], [HR90]],
      bills: new Map([[HR77, bill(HR77, "Old news", [reported("2026-10-01")])]]),
      watched: new Set([HR77, HR90]),
    });
    expect(items).toEqual([]);
  });

  it("shows a companion pair once: the member that leads its status, either member's vote and watch", () => {
    const items = build({
      groups: [[HR77, S50]],
      bills: new Map([
        [HR77, bill(HR77, "House headline", [reported("2026-11-05")], { officialVotes: officialVotes("2026-11-02") })],
        [
          S50,
          bill(S50, "Senate headline", [{ actionCode: "17000", actionDate: "2026-11-19", text: "Passed Senate." }], {
            billStatus: "Passed",
            officialVotes: officialVotes(undefined, "2026-11-19"),
          }),
        ],
      ]),
      votes: new Map([[HR77, vote("Nay", "2026-10-28T12:00:00.000Z")]]),
      watched: new Set([S50]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      billGuid: S50,
      officialNumber: "S. 50",
      title: "Senate headline",
      billStatus: "Passed",
      action: { date: "2026-11-19", text: "Passed the Senate", billGuid: S50, officialNumber: "S. 50" },
      yourVote: "Nay",
      votedOn: "2026-10-28",
      voteTiming: { chamber: "Senate", rollCallDate: "2026-11-19", daysBefore: 22 },
      watched: true,
    });
  });

  it("takes the primary's vote when the caller voted on both members, and the primary on a tie", () => {
    const items = build({
      groups: [[HR77, S50]],
      bills: new Map([
        [HR77, bill(HR77, "House headline", [reported("2026-11-05")])],
        [S50, bill(S50, "Senate headline", [{ ...reported("2026-11-05"), text: "Hearings held." }])],
      ]),
      votes: new Map([
        [S50, vote("Yea")],
        [HR77, vote("Nay")],
      ]),
    });
    expect(items).toEqual([expect.objectContaining({ billGuid: HR77, yourVote: "Nay" })]);
  });

  describe("a companion group's status, as the Bills card shows it", () => {
    const law = (day: string) => ({
      actionCode: "36000",
      actionDate: day,
      text: "Became Public Law No: 119-37.",
      type: "BecameLaw",
    });
    const hearing = (day: string) => ({
      actionDate: day,
      sourceSystem: { code: 0, name: "Senate" },
      text: "Committee on Finance. Hearings held.",
      type: "Committee",
    });
    const senateCommittee = (day: string) => ({
      actionDate: day,
      sourceSystem: { code: 0, name: "Senate" },
      text: "Read twice and referred to the Committee on Commerce, Science, and Transportation.",
      type: "IntroReferral",
    });

    it("keeps a law when its twin has a later action: the law's number, title and status, the twin's action", () => {
      const items = build({
        groups: [[HR77, S50]],
        bills: new Map([
          [HR77, bill(HR77, "House law", [law("2026-11-10")], { billStatus: "Finalized" })],
          [S50, bill(S50, "Senate twin", [hearing("2026-11-12")])],
        ]),
        movedAt: new Map([
          [HR77, "2026-11-10T18:00:00.000Z"],
          [S50, "2026-11-12T18:00:00.000Z"],
        ]),
        watched: new Set([S50]),
      });
      expect(items).toEqual([
        {
          id: recentActionId(HR77, { date: "2026-11-12", text: "Committee on Finance. Hearings held" }),
          billGuid: HR77,
          congress: "119",
          billType: "hr",
          billNumber: "77",
          officialNumber: "H.R. 77",
          title: "House law",
          billStatus: "Finalized",
          action: {
            date: "2026-11-12",
            text: "Committee on Finance. Hearings held",
            billGuid: S50,
            officialNumber: "S. 50",
          },
          watched: true,
        },
      ]);
    });

    it("keeps a law whose own news is older than the window", () => {
      const [item] = build({
        groups: [[HR77, S50]],
        bills: new Map([
          [HR77, bill(HR77, "House law", [law("2026-08-01")], { billStatus: "Finalized" })],
          [S50, bill(S50, "Senate twin", [hearing("2026-11-12")])],
        ]),
        watched: new Set([HR77]),
      });
      expect(item).toMatchObject({ billGuid: HR77, billStatus: "Finalized", action: { date: "2026-11-12" } });
    });

    it("keeps a House passage when the Senate twin has a later committee action", () => {
      const [item] = build({
        groups: [[HR77, S50]],
        bills: new Map([
          [HR77, bill(HR77, "House bill", housePassageDay("2026-11-19"), { billStatus: "Passed" })],
          [S50, bill(S50, "Senate twin", [senateCommittee("2026-11-20")])],
        ]),
        movedAt: new Map([
          [HR77, "2026-11-19T18:00:00.000Z"],
          [S50, "2026-11-20T18:00:00.000Z"],
        ]),
        votes: new Map([[S50, vote("Yea")]]),
      });
      expect(item).toMatchObject({
        billGuid: HR77,
        officialNumber: "H.R. 77",
        title: "House bill",
        billStatus: "Passed",
        action: {
          date: "2026-11-20",
          text: "Read twice and referred to the Committee on Commerce, Science, and Transportation",
          billGuid: S50,
          officialNumber: "S. 50",
        },
        yourVote: "Yea",
      });
      expect(item).not.toHaveProperty("vetoed");
    });

    it("keeps a veto over a twin that passed later, and names the vetoed member", () => {
      const vetoed = [{ actionCode: "31000", actionDate: "2026-11-10", text: "Vetoed by President.", type: "Veto" }];
      const passedSenate = { actionCode: "17000", actionDate: "2026-11-18", text: "Passed Senate.", type: "Floor" };
      const [item] = build({
        groups: [[HR77, S50]],
        bills: new Map([
          [HR77, bill(HR77, "Vetoed House bill", vetoed, { billStatus: "Passed" })],
          [S50, bill(S50, "Senate twin", [passedSenate], { billStatus: "Passed" })],
        ]),
        movedAt: new Map([
          [HR77, "2026-11-10T18:00:00.000Z"],
          [S50, "2026-11-18T18:00:00.000Z"],
        ]),
        watched: new Set([HR77]),
      });
      expect(item).toMatchObject({
        billGuid: HR77,
        billStatus: "Passed",
        vetoed: true,
        action: { date: "2026-11-18", text: "Passed the Senate", billGuid: S50, officialNumber: "S. 50" },
      });
    });

    it("names the twin on its outcome line, so the row never says the member shown failed", () => {
      const passedHouse = {
        actionCode: "8000",
        actionDate: "2026-11-10",
        text: "Passed/agreed to in House: On passage Passed by recorded vote: 230 - 190 (Roll no. 412).",
        type: "Floor",
      };
      const failedSenate = {
        actionCode: "18000",
        actionDate: "2026-11-18",
        text: "Failed of passage in Senate by Yea-Nay Vote. 45 - 52. Record Vote Number: 301.",
        type: "Floor",
      };
      const [item] = build({
        groups: [[HR77, S50]],
        bills: new Map([
          [HR77, bill(HR77, "House bill", [passedHouse], { billStatus: "Passed" })],
          [S50, bill(S50, "Senate twin", [failedSenate], { billStatus: "Failed" })],
        ]),
        movedAt: new Map([
          [HR77, "2026-11-10T18:00:00.000Z"],
          [S50, "2026-11-18T18:00:00.000Z"],
        ]),
        watched: new Set([HR77]),
      });
      expect(item).toMatchObject({
        billGuid: HR77,
        officialNumber: "H.R. 77",
        billStatus: "Passed",
        action: { date: "2026-11-18", text: "Failed in the Senate", billGuid: S50, officialNumber: "S. 50" },
      });
    });

    it("never says vetoed for a law, even with a veto line", () => {
      const overridden = [
        { actionCode: "36000", actionDate: "2026-11-14", text: "Became Public Law No: 119-60.", type: "BecameLaw" },
        { actionCode: "31000", actionDate: "2026-11-01", text: "Vetoed by President.", type: "Veto" },
      ];
      const [item] = build({
        groups: [[HR77]],
        bills: new Map([[HR77, bill(HR77, "Law over a veto", overridden, { billStatus: "Finalized" })]]),
        watched: new Set([HR77]),
      });
      expect(item).toMatchObject({ billStatus: "Finalized", action: { text: "Became law" } });
      expect(item).not.toHaveProperty("vetoed");
    });

    it("takes the member that moved later when both have the same status", () => {
      const [item] = build({
        groups: [[HR77, S50]],
        bills: new Map([
          [HR77, bill(HR77, "House headline", [reported("2026-11-19")])],
          [S50, bill(S50, "Senate headline", [hearing("2026-11-05")])],
        ]),
        movedAt: new Map([
          [HR77, "2026-11-01T18:00:00.000Z"],
          [S50, "2026-11-21T18:00:00.000Z"],
        ]),
        watched: new Set([HR77]),
      });
      expect(item).toMatchObject({ billGuid: S50, title: "Senate headline", action: { date: "2026-11-19" } });
    });

    it("keeps the row's id when only the other member's manifest row moves, keyed on the primary", () => {
      const bills = new Map([
        [HR77, bill(HR77, "House headline", [])],
        [S50, bill(S50, "Senate headline", [hearing("2026-11-12")])],
      ]);
      const [before] = build({
        groups: [[HR77, S50]],
        bills,
        movedAt: new Map([
          [HR77, "2026-11-05T18:00:00.000Z"],
          [S50, "2026-11-12T18:00:00.000Z"],
        ]),
        watched: new Set([HR77]),
      });
      // A text version of H.R. 77 moves its manifest row with no new action: it now stands for the pair.
      const [after] = build({
        groups: [[HR77, S50]],
        bills,
        movedAt: new Map([
          [HR77, "2026-11-15T18:00:00.000Z"],
          [S50, "2026-11-12T18:00:00.000Z"],
        ]),
        watched: new Set([HR77]),
      });
      expect(before.billGuid).toBe(S50);
      expect(after.billGuid).toBe(HR77);
      expect(after.action).toEqual(before.action);
      expect(after.id).toBe(before.id);
      expect(before.id).toBe(recentActionId(HR77, { date: "2026-11-12", text: "Committee on Finance. Hearings held" }));
    });

    it("applies the routine follow-up rule across the group: one member's follow-up never hides the other's news", () => {
      const held = { actionDate: "2026-11-20", text: "Held at the desk.", type: "Floor" };
      const [item] = build({
        groups: [[HR77, S50]],
        bills: new Map([
          [HR77, bill(HR77, "House headline", [reported("2026-11-19")])],
          [S50, bill(S50, "Senate headline", [held])],
        ]),
        watched: new Set([S50]),
      });
      expect(item.action).toEqual({
        date: "2026-11-19",
        text: "Reported by the Committee on Energy and Commerce. H. Rept. 119-876",
        actionCode: "H12200",
        billGuid: HR77,
        officialNumber: "H.R. 77",
      });
    });
  });

  it("says vetoed only as true, and a law is never vetoed", () => {
    const vetoed = [{ actionCode: "31000", actionDate: "2026-11-10", text: "Vetoed by President.", type: "Veto" }];
    const law = [
      { actionCode: "36000", actionDate: "2026-11-12", text: "Became Public Law No: 119-52.", type: "BecameLaw" },
    ];
    const items = build({
      groups: [[HR77], [HR90]],
      bills: new Map([
        [HR77, bill(HR77, "Vetoed bill", vetoed, { billStatus: "Passed" })],
        [HR90, bill(HR90, "Law", law, { billStatus: "Finalized" })],
      ]),
      watched: new Set([HR77, HR90]),
    });
    expect(items[0]).toMatchObject({ billGuid: HR90, billStatus: "Finalized", action: { text: "Became law" } });
    expect(items[0]).not.toHaveProperty("vetoed");
    expect(items[1]).toMatchObject({
      billGuid: HR77,
      billStatus: "Passed",
      vetoed: true,
      action: { text: "Vetoed by President", actionCode: "31000" },
    });
  });

  it("sorts newest first, then by title, and keeps 50", () => {
    const guids = Array.from({ length: 55 }, (_, index) => `BILLS-119hr${1000 + index}`);
    const items = build({
      groups: guids.map((guid) => [guid]),
      bills: new Map(
        guids.map((guid, index) => [
          guid,
          bill(guid, `Bill ${String.fromCharCode(90 - (index % 26))}`, [reported(`2026-11-${10 + (index % 3)}`)]),
        ]),
      ),
      watched: new Set(guids),
    });
    expect(items).toHaveLength(50);
    const keys = items.map((item) => `${item.action.date} ${item.title}`);
    const sorted = [...keys].sort((left, right) => {
      const [leftDay, ...leftTitle] = left.split(" ");
      const [rightDay, ...rightTitle] = right.split(" ");
      return leftDay === rightDay
        ? leftTitle.join(" ").localeCompare(rightTitle.join(" "))
        : leftDay > rightDay
          ? -1
          : 1;
    });
    expect(keys).toEqual(sorted);
    expect(items[0].action.date).toBe("2026-11-12");
  });

  it("keeps a row's id when congress.gov adds a citation, and changes it with a newer action", () => {
    const before = build({
      groups: [[HR77]],
      bills: new Map([[HR77, bill(HR77, "T", [reported("2026-11-05")])]]),
      watched: new Set([HR77]),
    })[0].id;
    const cited = { ...reported("2026-11-05"), text: `${reported("2026-11-05").text} (text: CR H4567-4570)` };
    const withCitation = build({
      groups: [[HR77]],
      bills: new Map([[HR77, bill(HR77, "T", [cited])]]),
      watched: new Set([HR77]),
    })[0].id;
    const newer = build({
      groups: [[HR77]],
      bills: new Map([[HR77, bill(HR77, "T", [...housePassageDay("2026-11-19"), reported("2026-11-05")])]]),
      watched: new Set([HR77]),
    })[0].id;
    expect(withCitation).toBe(before);
    expect(newer).not.toBe(before);
    expect(before.startsWith(`${HR77}#2026-11-05#`)).toBe(true);
  });

  it("falls back to the bill's number for a missing title, and leaves out an unknown status", () => {
    const [item] = build({
      groups: [[HR77]],
      bills: new Map([[HR77, { actions: [reported("2026-11-05")], billStatus: "Pending" }]]),
      watched: new Set([HR77]),
    });
    expect(item.title).toBe("H.R. 77");
    expect(item).not.toHaveProperty("billStatus");
  });

  it("never carries a count, a tally or anything but the caller's own vote", () => {
    const allowed = new Set<keyof RecentActionItemV1>([
      "id",
      "billGuid",
      "congress",
      "billType",
      "billNumber",
      "officialNumber",
      "title",
      "billStatus",
      "vetoed",
      "action",
      "yourVote",
      "votedOn",
      "voteTiming",
      "watched",
    ]);
    const items = build({
      groups: [[HR77]],
      bills: new Map([
        [
          HR77,
          bill(HR77, "T", housePassageDay("2026-11-19"), {
            voteCount: 41,
            officialVotes: officialVotes("2026-11-19"),
            civicProfile: { localVsFederal: 0.2 },
          }),
        ],
      ]),
      votes: new Map([[HR77, vote("Yea")]]),
      watched: new Set([HR77]),
    });
    expect(items).toHaveLength(1);
    for (const key of Object.keys(items[0])) expect(allowed.has(key as keyof RecentActionItemV1)).toBe(true);
    expect(JSON.stringify(items)).not.toMatch(/voteCount|"yea"|"nay"|totalCounted|members/);
  });
});
