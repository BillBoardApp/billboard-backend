/**
 * What the Weekly Brief says (feature review 2026-10-28: S2, and S6 for the brief). The builder alone, on the
 * test week Mar 15-21, 2026 (Sunday to Saturday, New York time; published Sunday Mar 22, 10:00).
 *
 * App 1.1 shows each item's title, summary, detail (two lines) and reason, the section titles and subtitles, and
 * the figures with the server's labels. App 1.2 shows the title, summary and reason, its own section titles and
 * its own figure words. So the summary carries what happened, and the detail only what the summary did not say.
 */
import type { BillManifestEntry, ProcessedBillDocument } from "../models/bill";
import type { WeeklyDigest, WeeklyDigestItem } from "../models/weeklyDigest";
import { applyTestEnv } from "./fixtures/env";
import { WEEKLY_DIGEST_TEST_ENV, WEEKLY_DIGEST_TEST_NOW } from "./fixtures/weeklyDigest";
import { CURATED_OVERRIDE_CASES } from "./fixtures/curatedCeremonialOverrides";

type Builder = typeof import("../shared/weeklyDigestBuilder").buildWeeklyDigest;
type Window = import("../shared/weeklyDigestSchedule").WeeklyDigestPublicationWindow;

let restoreEnv: () => void;
let buildWeeklyDigest: Builder;
let window: Window;

beforeEach(() => {
  jest.resetModules();
  restoreEnv = applyTestEnv(WEEKLY_DIGEST_TEST_ENV, { replace: true });
  ({ buildWeeklyDigest } = require("../shared/weeklyDigestBuilder"));
  window = require("../shared/weeklyDigestSchedule").latestPublishedWindow(new Date(WEEKLY_DIGEST_TEST_NOW));
});

afterEach(() => restoreEnv());

/** A manifest row for `guid` ("BILLS-119hr77"), Updated on Wednesday Mar 18 in the followed topic Energy. */
function entry(guid: string, fields: Partial<BillManifestEntry> = {}): BillManifestEntry {
  const [, billType, billNumber] = /^BILLS-\d+([a-z]+?)(\d+)/.exec(guid) ?? [];
  return {
    guid,
    billType,
    congress: "119",
    billNumber,
    updatedAt: "2026-03-18T15:00:00.000Z",
    title: `Title of ${guid}`,
    subCategories: ["Energy"],
    lifeAreas: [],
    sponsors: [],
    cosponsors: [],
    billStatus: "Updated",
    ...fields,
  };
}

type Processed = Record<string, unknown>;

/** A processed bill: "what it does", a bottom line, and Congress's actions newest first. */
function processed(fields: Processed = {}): Processed {
  return {
    soWhat: "Households could pay less for power.",
    billBreakdown: { who: "", what: "Funds grid repairs in rural areas.", how: "", when: "", where: "", why: "" },
    actions: [],
    ...fields,
  };
}

interface BuildOptions {
  items: BillManifestEntry[];
  bills?: Record<string, Processed>;
  topics?: string[];
  lifeAreas?: string[];
  followed?: string[];
  watched?: string[];
  votedOn?: string[];
  memberNames?: Record<string, string>;
  /** Companion pairs (APPF-23), House bill first. */
  companions?: Array<[string, string]>;
  /** Collects the guids whose processed bills the builder loads. */
  loaded?: string[];
}

async function build(options: BuildOptions): Promise<WeeklyDigest | null> {
  return buildWeeklyDigest({
    window,
    preferences: {
      trackedTopics: options.topics ?? ["Energy"],
      trackedLifeAreas: options.lifeAreas ?? [],
      followedMembers: options.followed ?? [],
      watchedBillGuids: options.watched ?? [],
      selectedBillContentTypes: [],
    },
    voteStatesByBillId: new Map(
      (options.votedOn ?? []).map((billId) => [billId.toLowerCase(), { billId, feedback: "Yea" }]),
    ),
    manifestItems: options.items,
    memberNameById: new Map(Object.entries(options.memberNames ?? {})),
    ...(options.companions
      ? { companionIndex: require("../shared/billCompanions").companionIndex(options.companions) }
      : {}),
    loadProcessedBill: async (item) => {
      options.loaded?.push(item.guid);
      const bill = options.bills?.[item.guid];
      if (!bill) return null;
      return {
        schemaVersion: 1,
        kind: "processed",
        storedAt: item.updatedAt,
        identifier: { congress: "119", billType: item.billType, billNumber: item.billNumber },
        guid: item.guid,
        title: item.title,
        link: "",
        subCategories: item.subCategories,
        lifeAreas: item.lifeAreas,
        sponsors: item.sponsors,
        cosponsors: item.cosponsors,
        committees: [],
        billStatus: item.billStatus,
        ...(bill as Partial<ProcessedBillDocument>),
      } as ProcessedBillDocument;
    },
  });
}

const section = (digest: WeeklyDigest | null, kind: string): WeeklyDigestItem[] =>
  digest?.sections.find((candidate) => candidate.kind === kind)?.items ?? [];

const items = (digest: WeeklyDigest | null): WeeklyDigestItem[] =>
  digest?.sections.flatMap((candidate) => candidate.items) ?? [];

/** Every text either app can show: the headline, the figure labels, section titles and subtitles, item texts. */
const shownTexts = (digest: WeeklyDigest): string[] =>
  [
    digest.title,
    digest.summary,
    ...digest.stats.map((stat) => stat.label),
    ...digest.sections.flatMap((candidate) => [candidate.title, candidate.subtitle]),
    ...items(digest).flatMap((item) => [item.title, item.eyebrow, item.summary, item.detail, item.reason]),
  ].filter((text): text is string => typeof text === "string");

describe("a bill item says what happened this week (S2)", () => {
  const GUID = "BILLS-119hr77";

  const itemFor = async (bill: Processed, fields: Partial<BillManifestEntry> = {}) =>
    items(await build({ items: [entry(GUID, fields)], bills: { [GUID]: bill } }))[0];

  it("leads with Congress's latest action of the week and its date; 1.1's detail keeps what the bill does", async () => {
    const item = await itemFor(
      processed({
        actions: [
          { actionDate: "2026-03-23", text: "Passed the House." }, // the next week
          { actionDate: "2026-03-19", text: "Reported by the Committee on Energy and Commerce." },
          { actionDate: "2026-03-16", text: "Ordered to be reported by voice vote." },
          { actionDate: "2026-03-02", text: "Introduced in House" },
        ],
      }),
    );

    expect(item).toMatchObject({
      title: `Title of ${GUID}`,
      summary: "Mar 19: Reported by the Committee on Energy and Commerce.",
      detail: "Funds grid repairs in rural areas.",
    });
  });

  it("reads an action's date as the calendar day Congress gave, the week's Sunday and Saturday included", async () => {
    // "2026-03-15" is Sunday Mar 15 in New York, though as an instant it is Saturday evening there.
    const sunday = await itemFor(processed({ actions: [{ actionDate: "2026-03-15", text: "Introduced in House" }] }));
    expect(sunday.summary).toBe("Mar 15: Introduced in House");

    const saturday = await itemFor(processed({ actions: [{ actionDate: "2026-03-21", text: "Held at the desk." }] }));
    expect(saturday.summary).toBe("Mar 21: Held at the desk.");

    // A timestamp is placed on its New York day: 02:00 UTC on Mar 22 is still Saturday Mar 21 there.
    const late = await itemFor(processed({ actions: [{ actionDate: "2026-03-22T02:00:00Z", text: "Received." }] }));
    expect(late.summary).toBe("Mar 21: Received.");

    for (const outside of ["2026-03-14", "2026-03-22"]) {
      const item = await itemFor(processed({ actions: [{ actionDate: outside, text: "Not this week." }] }));
      expect(item.summary).toBe("Funds grid repairs in rural areas.");
    }
  });

  it("takes the first action listed on the latest day, passing over the House's motion to reconsider", async () => {
    const item = await itemFor(
      processed({
        actions: [
          { actionDate: "2026-03-19", text: "Motion to reconsider laid on the table Agreed to without objection." },
          { actionDate: "2026-03-19", text: "On passage Passed by recorded vote: 245 - 180 (Roll no. 301)." },
          { actionDate: "2026-03-19", text: "Considered as unfinished business." },
        ],
      }),
      { billStatus: "Passed" },
    );
    expect(item.summary).toBe("Mar 19: On passage Passed by recorded vote: 245 - 180 (Roll no. 301).");

    const alone = await itemFor(
      processed({
        actions: [
          { actionDate: "2026-03-19", text: "Motion to reconsider laid on the table Agreed to without objection." },
        ],
      }),
    );
    expect(alone.summary).toBe("Mar 19: Motion to reconsider laid on the table Agreed to without objection.");
  });

  // Congress.gov lists these above the action they follow, the same day or the next.
  it.each([
    [
      "Placed on the Union Calendar, Calendar No. 123.",
      "2026-03-19",
      "Reported by the Committee on Energy and Commerce. H. Rept. 119-45.",
      "Mar 19: Reported by the Committee on Energy and Commerce. H. Rept. 119-45.",
    ],
    [
      "Placed on the House Calendar, Calendar No. 12.",
      "2026-03-19",
      "Reported by the Committee on Rules. H. Rept. 119-46.",
      "Mar 19: Reported by the Committee on Rules. H. Rept. 119-46.",
    ],
    [
      "Placed on Senate Legislative Calendar under General Orders. Calendar No. 210.",
      "2026-03-19",
      "Committee on Energy and Natural Resources. Reported by Senator Lee without amendment.",
      "Mar 19: Committee on Energy and Natural Resources. Reported by Senator Lee without amendment.",
    ],
    [
      "Message on Senate action sent to the House.",
      "2026-03-18",
      "Passed Senate without amendment by Unanimous Consent.",
      "Mar 18: Passed Senate without amendment by Unanimous Consent.",
    ],
    ["Held at the desk.", "2026-03-19", "Received in the House.", "Mar 19: Received in the House."],
  ])("passes over the routine follow-up %j for the action it follows", async (followUp, day, action, summary) => {
    const item = await itemFor(
      processed({
        actions: [
          { actionDate: "2026-03-19", text: followUp },
          { actionDate: day, text: action },
          { actionDate: "2026-03-02", text: "Introduced in House" },
        ],
      }),
    );
    expect(item.summary).toBe(summary);

    // With nothing else in the week, the follow-up is still what happened.
    const alone = await itemFor(
      processed({
        actions: [
          { actionDate: "2026-03-19", text: followUp },
          { actionDate: "2026-03-12", text: action }, // the week before
        ],
      }),
    );
    expect(alone.summary).toBe(`Mar 19: ${followUp}`);
  });

  it("without an action in the week, says what the bill does, and 1.1's detail gives the bottom line", async () => {
    const item = await itemFor(processed({ actions: [{ actionDate: "2026-02-10", text: "Introduced in House" }] }));

    expect(item.summary).toBe("Funds grid repairs in rural areas.");
    expect(item.detail).toBe("Households could pay less for power.");
  });

  it("never shows a sentence twice: the detail is left out when it repeats the summary or the title", async () => {
    const sameBottomLine = await itemFor(
      processed({ soWhat: "Funds grid repairs in rural areas", actions: [] }), // the summary, without its period
    );
    expect(sameBottomLine.summary).toBe("Funds grid repairs in rural areas.");
    expect(sameBottomLine).not.toHaveProperty("detail");

    const whatIsTitle = await itemFor(
      processed({
        billBreakdown: { what: `Title of ${GUID}` },
        soWhat: "",
        actions: [{ actionDate: "2026-03-17", text: "Referred to the Subcommittee on Energy." }],
      }),
    );
    expect(whatIsTitle.summary).toBe("Mar 17: Referred to the Subcommittee on Energy.");
    expect(whatIsTitle).not.toHaveProperty("detail");
  });

  it("falls back to the status line when the processed bill cannot be read, never to the title", async () => {
    const digest = await build({ items: [entry(GUID, { billStatus: "New" })], bills: {} });
    expect(items(digest)[0]).toMatchObject({ title: `Title of ${GUID}`, summary: "New this week." });
    expect(items(digest)[0]).not.toHaveProperty("detail");
  });

  it("keeps quoted text to a sensible length, cut at a word", async () => {
    const longAction = `Providing for consideration of the bill (H.R. 77) ${"to amend the Federal Power Act and ".repeat(10)}for other purposes.`;
    const longWhat = `Funds grid repairs ${"in every rural county ".repeat(30)}nationwide.`;
    const item = await itemFor(
      processed({ billBreakdown: { what: longWhat }, actions: [{ actionDate: "2026-03-18", text: longAction }] }),
    );

    expect(item.summary.startsWith("Mar 18: Providing for consideration of the bill (H.R. 77) to amend")).toBe(true);
    expect(item.summary.endsWith("…")).toBe(true);
    expect(item.summary.length).toBeLessThanOrEqual("Mar 18: ".length + 200);
    expect(item.summary).not.toMatch(/\s…$/);
    expect(item.detail!.endsWith("…")).toBe(true);
    expect(item.detail!.length).toBeLessThanOrEqual(300);
  });
});

describe("member items name their bills, counted over the whole week (S2)", () => {
  const MEMBER = "D000001";
  const memberNames = { [MEMBER]: "Rep. Jane Doe" };

  it("names the first bill by its number and counts the rest", async () => {
    const digest = await build({
      items: [
        entry("BILLS-119hr77", { cosponsors: [MEMBER], billStatus: "Passed" }),
        entry("BILLS-119s12", { cosponsors: ["X000009", MEMBER], updatedAt: "2026-03-17T15:00:00.000Z" }),
      ],
      followed: [MEMBER],
      memberNames,
    });

    expect(section(digest, "representatives")).toEqual([
      {
        id: `member|${MEMBER}|BILLS-119hr77`,
        kind: "member",
        title: "Rep. Jane Doe",
        eyebrow: "2 bills this week",
        summary: "Cosponsored H.R. 77 and 1 more bill that moved this week.",
        detail: "H.R. 77: Title of BILLS-119hr77",
        reason: "Member you follow",
        accent: "representative",
        billGuid: "BILLS-119hr77",
        primaryMemberBioguideId: MEMBER,
      },
    ]);
  });

  it.each([
    [[{ sponsors: true }], "Sponsored H.R. 1, which moved this week."],
    [[{ sponsors: false }], "Cosponsored H.R. 1, which moved this week."],
    [
      [{ sponsors: true }, { sponsors: true }, { sponsors: true }],
      "Sponsored H.R. 1 and 2 more bills that moved this week.",
    ],
    [[{ sponsors: true }, { sponsors: false }], "Sponsored H.R. 1 and cosponsored 1 more bill that moved this week."],
    [[{ sponsors: false }, { sponsors: true }], "Cosponsored H.R. 1 and sponsored 1 more bill that moved this week."],
    [
      [{ sponsors: true }, { sponsors: true }, { sponsors: false }],
      "Sponsored H.R. 1 and sponsored or cosponsored 2 more bills that moved this week.",
    ],
  ])("says what the member's name is on: %j", async (roles, summary) => {
    const digest = await build({
      // H.R. 1 moved last, so it ranks first and is the one named.
      items: roles.map((role, index) =>
        entry(`BILLS-119hr${index + 1}`, {
          updatedAt: `2026-03-${String(19 - index).padStart(2, "0")}T15:00:00.000Z`,
          ...(role.sponsors ? { sponsors: [MEMBER] } : { cosponsors: [MEMBER] }),
        }),
      ),
      followed: [MEMBER],
      memberNames,
    });

    expect(section(digest, "representatives")[0].summary).toBe(summary);
  });

  it("counts the member's bills beyond the dozen the bill sections draw on", async () => {
    // Twelve watched bills fill every loaded slot; the member's three bills rank after them.
    const watched = Array.from({ length: 12 }, (_, index) => entry(`BILLS-119hr${100 + index}`));
    const memberBills = [7, 8, 9].map((number) =>
      entry(`BILLS-119s${number}`, { cosponsors: [MEMBER], subCategories: [], updatedAt: "2026-03-16T15:00:00.000Z" }),
    );
    const loaded: string[] = [];
    const digest = await buildWeeklyDigest({
      window,
      preferences: {
        trackedTopics: ["Energy"],
        trackedLifeAreas: [],
        followedMembers: [MEMBER],
        watchedBillGuids: watched.map((bill) => bill.guid),
        selectedBillContentTypes: [],
      },
      voteStatesByBillId: new Map(),
      manifestItems: [...watched, ...memberBills],
      memberNameById: new Map(Object.entries(memberNames)),
      loadProcessedBill: async (item) => {
        loaded.push(item.guid);
        return null;
      },
    });

    expect(loaded).toHaveLength(12);
    expect(loaded).not.toContain("BILLS-119s7");
    expect(section(digest, "representatives")).toEqual([
      expect.objectContaining({
        eyebrow: "3 bills this week",
        summary: "Cosponsored S. 7 and 2 more bills that moved this week.",
        reason: "Member you follow",
      }),
    ]);
  });

  it("without a usable bill number, says how many bills, never a guid", async () => {
    const odd = entry("custom-77", { billType: "hr", billNumber: "", sponsors: [MEMBER] });
    const digest = await build({
      items: [odd, entry("custom-78", { billType: "hr", billNumber: "", cosponsors: [MEMBER] })],
      followed: [MEMBER],
      memberNames,
    });

    expect(section(digest, "representatives")[0]).toMatchObject({
      summary: "Sponsored or cosponsored 2 bills that moved this week.",
      detail: "Title of custom-77",
    });
  });

  it("writes each kind of bill number as the apps do", () => {
    const { officialBillNumber } = require("../shared/billNumbers");
    expect(officialBillNumber({ billType: "hr", billNumber: "77" })).toBe("H.R. 77");
    expect(officialBillNumber({ billType: "HRES", billNumber: "0826" })).toBe("H.Res. 826");
    expect(officialBillNumber({ billType: "S.J.Res.", billNumber: "S.J.Res. 213" })).toBe("S.J.Res. 213");
    expect(officialBillNumber({ billType: "house-concurrent-resolution", billNumber: 5 })).toBe("H.Con.Res. 5");
    // A composite number is not a number: the guid decides.
    expect(officialBillNumber({ billType: "s", billNumber: "119-s-12", guid: "BILLS-119sconres12is" })).toBe(
      "S.Con.Res. 12",
    );
    expect(officialBillNumber({ guid: "BILLS-119hjres4enr" })).toBe("H.J.Res. 4");
    expect(officialBillNumber({ billType: "x", billNumber: "1", guid: "not-a-guid" })).toBeNull();
  });
});

describe("the headline and labels (S2)", () => {
  const MEMBER = "D000001";

  it("counts each section in page order and says members you follow", async () => {
    const digest = await build({
      items: [
        entry("BILLS-119hr1", { billStatus: "Passed", updatedAt: "2026-03-20T15:00:00.000Z" }), // attention
        entry("BILLS-119hr2", { sponsors: [MEMBER] }), // moved, by a followed member
        entry("BILLS-119hr3", { sponsors: [MEMBER], updatedAt: "2026-03-17T15:00:00.000Z" }), // moved
        entry("BILLS-119hr4", { cosponsors: [MEMBER], updatedAt: "2026-03-16T15:00:00.000Z" }), // moved
        entry("BILLS-119hr5", { updatedAt: "2026-03-16T12:00:00.000Z" }), // worth a look
        entry("BILLS-119hr6", { cosponsors: ["E000002"], updatedAt: "2026-03-15T15:00:00.000Z" }),
      ],
      followed: [MEMBER, "E000002"],
      memberNames: { [MEMBER]: "Rep. Jane Doe", E000002: "Sen. Eve Roe" },
    });

    expect(digest!.summary).toBe(
      "One bill needs your attention, 3 more moved, 2 members you follow had bills move, and one more is worth a look.",
    );
    expect(section(digest, "moved_this_week")).toHaveLength(3);
    expect(digest!.stats).toEqual([
      { id: "attention", label: "Need attention", value: "1", accent: "attention" },
      { id: "representatives", label: "Members active", value: "2", accent: "representative" },
      { id: "quicklook", label: "Worth a look", value: "1", accent: "discovery" },
    ]);
    expect(digest!.sections.map((candidate) => [candidate.kind, candidate.title, candidate.subtitle])).toEqual([
      [
        "needs_attention",
        "Needs Your Attention",
        "Bills you watch, changes since your vote, and outcomes on your topics.",
      ],
      ["moved_this_week", "What Moved This Week", "Other bills that moved this week."],
      [
        "representatives",
        "Members You Follow",
        "Members you follow who sponsor or cosponsor a bill that moved this week.",
      ],
      ["worth_quick_look", "Worth A Quick Look", "More new or updated bills on your topics."],
    ]);
  });

  it.each([
    [{ items: [entry("BILLS-119hr1")] }, "One bill moved this week."],
    [{ items: [entry("BILLS-119hr1"), entry("BILLS-119hr2")] }, "2 bills moved this week."],
    [
      { items: [entry("BILLS-119hr1", { billStatus: "Failed" }), entry("BILLS-119hr2", { billStatus: "Passed" })] },
      "2 bills need your attention.",
    ],
    [
      { items: [entry("BILLS-119hr1", { billStatus: "Passed" }), entry("BILLS-119hr2")] },
      "One bill needs your attention, and one more moved.",
    ],
    [
      {
        items: [1, 2, 3, 4, 5].map((number) =>
          entry(`BILLS-119hr${number}`, { updatedAt: `2026-03-${15 + number}T15:00:00.000Z` }),
        ),
      },
      "3 bills moved this week, and 2 more are worth a look.",
    ],
  ])("words each count: %#", async (options, summary) => {
    expect((await build(options))!.summary).toBe(summary);
  });

  it("fits the three lines app 1.1's Updates card shows, for every mix of section sizes", () => {
    const { weeklyDigestHeadline } = require("../shared/weeklyDigestBuilder");
    // Each section holds at most 3 items, "Worth a quick look" 2.
    const headlines: string[] = [];
    for (const attention of [0, 1, 2, 3])
      for (const moved of [0, 1, 2, 3])
        for (const members of [0, 1, 2, 3])
          for (const quickLook of [0, 1, 2])
            if (attention + moved + members + quickLook > 0)
              headlines.push(weeklyDigestHeadline({ attention, moved, members, quickLook }));

    // 1.1 cuts the headline after three lines of 16 pt rounded type, 295 pt wide on a 375 pt phone. 115 characters
    // is the longest that was measured to fit there at the default text size and the next one up; the old
    // headline's longest was 97.
    const longest = headlines.reduce((left, right) => (right.length > left.length ? right : left));
    expect(longest).toBe(
      "One bill needs your attention, one more moved, one member you follow had a bill move, and one more is worth a look.",
    );
    expect(longest.length).toBeLessThanOrEqual(115);
    expect(new Set(headlines).size).toBe(headlines.length);
    for (const headline of headlines) {
      expect(headline).toMatch(/^[A-Z0-9].*[a-z]\.$/);
      expect(headline).not.toMatch(/took action|representative|meaningful|tracked areas/i);
    }
    expect(weeklyDigestHeadline({ attention: 3, moved: 3, members: 3, quickLook: 2 })).toBe(
      "3 bills need your attention, 3 more moved, 3 members you follow had bills move, and 2 more are worth a look.",
    );
    expect(weeklyDigestHeadline({ attention: 0, moved: 0, members: 1, quickLook: 1 })).toBe(
      "One member you follow had a bill move, and one bill is worth a look.",
    );
  });

  it("never says took action, representatives, meaningful or tracked areas, anywhere in the brief", async () => {
    const digest = await build({
      items: [
        entry("BILLS-119hr1", { billStatus: "Passed", sponsors: [MEMBER] }),
        entry("BILLS-119hr2", { cosponsors: [MEMBER] }),
        entry("BILLS-119hr3"),
        entry("BILLS-119hr4", { updatedAt: "2026-03-16T15:00:00.000Z" }),
        entry("BILLS-119hr5", { updatedAt: "2026-03-15T15:00:00.000Z" }),
        entry("BILLS-119hr6", { updatedAt: "2026-03-15T14:00:00.000Z" }),
      ],
      followed: [MEMBER],
      watched: ["BILLS-119hr3"],
      memberNames: { [MEMBER]: "Rep. Jane Doe" },
    });

    expect(section(digest, "representatives")).toHaveLength(1);
    const shown = shownTexts(digest!);
    expect(shown.length).toBeGreaterThan(20);
    for (const text of shown) {
      expect(text).not.toMatch(/took action|representative|\breps\b|meaningful|tracked areas|areas you track/i);
    }
  });
});

describe("a decided bill the user voted on leaves Needs attention (S2)", () => {
  it.each(["Passed", "Failed", "Finalized"] as const)(
    "a %s bill in a followed topic: under Moved this week, 'You voted on this'",
    async (billStatus) => {
      const guid = "BILLS-119hr9";
      const unvoted = await build({ items: [entry(guid, { billStatus })] });
      expect(section(unvoted, "needs_attention").map((item) => item.billGuid)).toEqual([guid]);

      const voted = await build({ items: [entry(guid, { billStatus })], votedOn: [guid] });
      expect(section(voted, "needs_attention")).toEqual([]);
      expect(section(voted, "moved_this_week")).toEqual([
        expect.objectContaining({ billGuid: guid, reason: "You voted on this" }),
      ]);
      expect(voted!.summary).toBe("One bill moved this week.");
    },
  );

  it.each(["Passed", "Failed", "Finalized"] as const)(
    "a watched %s bill the user voted on leaves it too, and stays in the brief as watched",
    async (billStatus) => {
      const guid = "BILLS-119hr9";
      const watchedOnly = await build({ items: [entry(guid, { billStatus })], watched: [guid] });
      expect(section(watchedOnly, "needs_attention").map((item) => item.billGuid)).toEqual([guid]);

      const voted = await build({ items: [entry(guid, { billStatus })], watched: [guid], votedOn: [guid] });
      expect(section(voted, "needs_attention")).toEqual([]);
      expect(section(voted, "moved_this_week")).toEqual([
        expect.objectContaining({ billGuid: guid, reason: "You're watching this" }),
      ]);
    },
  );

  it("an Updated bill the user voted on still needs attention: they may want to vote again", async () => {
    const guid = "BILLS-119hr9";
    const digest = await build({ items: [entry(guid)], votedOn: [guid] });
    expect(section(digest, "needs_attention")).toEqual([
      expect.objectContaining({ billGuid: guid, reason: "You voted on this before" }),
    ]);
  });
});

describe("ceremonial resolutions in the brief (S6)", () => {
  const MEMBER = "D000001";
  const RECOGNIZE = "BILLS-119hres1187";
  const recognize = (fields: Partial<BillManifestEntry> = {}) =>
    entry(RECOGNIZE, {
      title: "Recognize Community Health Workers Week",
      billStatus: "New",
      subCategories: ["Energy"],
      lifeAreas: ["Utility Bills"],
      ...fields,
    });

  it("never shows one only for a topic or life area, so never in Worth a quick look", async () => {
    const digest = await build({
      items: [
        entry("BILLS-119hr1"),
        entry("BILLS-119hr2"),
        entry("BILLS-119hr3"),
        recognize(),
        entry("BILLS-119hr4", { updatedAt: "2026-03-16T15:00:00.000Z" }),
      ],
      lifeAreas: ["Utility Bills"],
    });

    expect(section(digest, "worth_quick_look").map((item) => item.billGuid)).toEqual(["BILLS-119hr4"]);
    expect(items(digest).map((item) => item.billGuid)).not.toContain(RECOGNIZE);

    // Alone, it makes no brief at all: nothing is stored, and apps 1.1 and 1.2 build their own (RUNBOOK 11.4).
    expect(await build({ items: [recognize()], lifeAreas: ["Utility Bills"] })).toBeNull();
  });

  describe("a headline that only looks ceremonial (the official title adds 'condemning' or 'calling on')", () => {
    const HONOR = "BILLS-119sres300";
    const honor = (fields: Partial<BillManifestEntry> = {}) =>
      entry(HONOR, { title: "Honor Victims of the Springfield Attack", billStatus: "Passed", ...fields });
    const honorOfficial = {
      [HONOR]: processed({
        officialTitle: "Honoring the victims of the attack in Springfield and condemning the antisemitic violence.",
      }),
    };

    it("keeps a resolution linked only by its topic, once the official title shows it is not ceremonial", async () => {
      const digest = await build({ items: [honor()], bills: honorOfficial });
      expect(section(digest, "needs_attention")).toEqual([
        expect.objectContaining({ billGuid: HONOR, reason: "Matches your topic: Energy" }),
      ]);
      expect(digest!.summary).toBe("One bill needs your attention.");

      const nato = "BILLS-119hres410";
      const recognized = await build({
        items: [entry(nato, { title: "Recognize NATO's 75th Anniversary" })],
        bills: {
          [nato]: processed({
            officialTitle:
              "Recognizing the 75th anniversary of NATO and calling on allies to meet their defense commitments.",
          }),
        },
      });
      expect(section(recognized, "moved_this_week")).toEqual([
        expect.objectContaining({ billGuid: nato, reason: "Matches your topic: Energy" }),
      ]);
    });

    it("without an official title, the headline decides", async () => {
      expect(await build({ items: [honor()] })).toBeNull();
      expect(await build({ items: [honor()], bills: { [HONOR]: processed() } })).toBeNull();
    });

    it("until the bill is loaded, the headline only ranks it after the rest", async () => {
      // Passed in a followed topic, it would outrank twelve Updated bills; its headline puts it thirteenth.
      const others = Array.from({ length: 12 }, (_, index) =>
        entry(`BILLS-119hr${100 + index}`, { updatedAt: "2026-03-16T15:00:00.000Z" }),
      );
      const loaded: string[] = [];
      await build({
        items: [honor({ updatedAt: "2026-03-20T15:00:00.000Z" }), ...others],
        bills: honorOfficial,
        loaded,
      });
      expect(loaded).toHaveLength(12);
      expect(loaded).not.toContain(HONOR);

      // Loaded, it ranks as an ordinary bill: first, as the only Passed one.
      const few = await build({ items: [honor(), ...others.slice(0, 2)], bills: honorOfficial });
      expect(items(few).map((item) => item.billGuid)).toEqual([HONOR, "BILLS-119hr100", "BILLS-119hr101"]);
    });
  });

  // The curated overrides of 2026-10-29 (RUNBOOK 4.12), as each bill is stored now and once a re-summary stores
  // Congress's title. The row still has its lists here (a row not yet relabelled, or the review kept them). The
  // user follows the bill's first topic, or its first life area when it has no topic (hres955, hres440, hres1528).
  it.each(CURATED_OVERRIDE_CASES)(
    "counts %s's followed topic or life area only when its curated override says it is not ceremonial, by %s",
    async (guid, _titles, decision) => {
      const [topic] = decision.subCategories;
      const digest = await build({
        items: [
          entry(guid, {
            title: decision.headline,
            subCategories: decision.subCategories,
            lifeAreas: decision.lifeAreas,
            billStatus: "Passed",
          }),
        ],
        bills: { [guid]: processed(decision.officialTitle ? { officialTitle: decision.officialTitle } : {}) },
        topics: topic ? [topic] : [],
        lifeAreas: topic ? [] : [decision.lifeAreas[0]],
      });
      if (decision.ceremonial) {
        expect(digest).toBeNull();
      } else {
        // "Social Justice" is shown by its current name (LLM-10).
        expect(items(digest)).toEqual([
          expect.objectContaining({
            billGuid: guid,
            reason: expect.stringMatching(topic ? /^Matches your topic: / : /^Matches your life area: /),
          }),
        ]);
      }
    },
  );

  it("goes by the official title once the bill is loaded, which the headline may not show", async () => {
    const guid = "BILLS-119hres826";
    const supportWeek = entry(guid, { title: "Support Careers in Energy Week", billStatus: "New" });
    const official = {
      [guid]: processed({
        officialTitle:
          'Expressing support for the designation of October 20 through October 24, 2025, as "Careers in Energy Week".',
      }),
    };

    const digest = await build({ items: [entry("BILLS-119hr1"), supportWeek], bills: official });
    expect(items(digest).map((item) => item.billGuid)).toEqual(["BILLS-119hr1"]);

    // A resolution whose official title is not ceremonial counts its topic, whatever its headline says.
    const condemn = entry("BILLS-119hres900", {
      title: "Recognize the embassy staff",
      cosponsors: [MEMBER],
      updatedAt: "2026-03-20T15:00:00.000Z",
    });
    const notCeremonial = await build({
      items: [entry("BILLS-119hr1", { cosponsors: [MEMBER] }), condemn],
      bills: {
        "BILLS-119hres900": processed({
          officialTitle: "Condemning the attack on the embassy and recognizing the courage of its staff.",
        }),
      },
      followed: [MEMBER],
    });
    // Moved most recently, it ranks first as an ordinary bill would.
    expect(section(notCeremonial, "moved_this_week").map((item) => item.billGuid)).toEqual([
      "BILLS-119hres900",
      "BILLS-119hr1",
    ]);
  });

  it("a ceremonial resolution that passed in a followed topic does not need attention", async () => {
    const digest = await build({
      items: [entry("BILLS-119hr1"), recognize({ billStatus: "Passed" })],
    });
    expect(section(digest, "needs_attention")).toEqual([]);
    expect(items(digest).map((item) => item.billGuid)).toEqual(["BILLS-119hr1"]);
  });

  it("a watched one, or one the user voted on that changed, still needs attention", async () => {
    const watched = await build({ items: [recognize()], watched: [RECOGNIZE] });
    expect(section(watched, "needs_attention")).toEqual([
      expect.objectContaining({ billGuid: RECOGNIZE, reason: "You're watching this" }),
    ]);

    const voted = await build({ items: [recognize({ billStatus: "Updated" })], votedOn: [RECOGNIZE] });
    expect(section(voted, "needs_attention")).toEqual([
      expect.objectContaining({ billGuid: RECOGNIZE, reason: "You voted on this before" }),
    ]);
  });

  it("one a followed member is on ranks after every other bill, and is named last for that member", async () => {
    const digest = await build({
      items: [
        recognize({ cosponsors: [MEMBER], updatedAt: "2026-03-20T15:00:00.000Z" }),
        entry("BILLS-119hr1", { updatedAt: "2026-03-16T15:00:00.000Z" }),
        entry("BILLS-119hr2", { cosponsors: [MEMBER], updatedAt: "2026-03-15T15:00:00.000Z" }),
      ],
      followed: [MEMBER],
      memberNames: { [MEMBER]: "Rep. Jane Doe" },
    });

    expect(section(digest, "moved_this_week").map((item) => [item.billGuid, item.reason])).toEqual([
      ["BILLS-119hr2", "Backed by Rep. Jane Doe"],
      ["BILLS-119hr1", "Matches your topic: Energy"],
      [RECOGNIZE, "Backed by Rep. Jane Doe"],
    ]);
    expect(section(digest, "representatives")[0].summary).toBe(
      "Cosponsored H.R. 2 and 1 more bill that moved this week.",
    );
  });

  describe("a companion pair of resolutions (APPF-23)", () => {
    const HOUSE = "BILLS-119hres10";
    const SENATE = "BILLS-119sres20";
    const pair = (houseTitle: string, senateTitle: string, fields: Partial<BillManifestEntry> = {}) => [
      entry(HOUSE, { title: houseTitle, billStatus: "New", updatedAt: "2026-03-19T15:00:00.000Z", ...fields }),
      entry(SENATE, { title: senateTitle, billStatus: "New", ...fields }),
    ];
    const officialSupport = {
      [HOUSE]: processed({ officialTitle: "Supporting the goals and ideals of Careers in Energy Week." }),
    };

    it("is ceremonial as a whole once the loaded bill's official title says so", async () => {
      const digest = await build({
        items: [entry("BILLS-119hr1"), ...pair("Support Careers in Energy Week", "Support Careers in Energy Week")],
        bills: officialSupport,
        companions: [[HOUSE, SENATE]],
      });
      expect(items(digest).map((item) => item.billGuid)).toEqual(["BILLS-119hr1"]);

      // Kept for a followed member on the Senate bill, but ranked last.
      const backed = await build({
        items: [
          entry("BILLS-119hr1", { updatedAt: "2026-03-16T15:00:00.000Z" }),
          ...pair("Support Careers in Energy Week", "Support Careers in Energy Week").map((bill) =>
            bill.guid === SENATE ? { ...bill, cosponsors: [MEMBER] } : bill,
          ),
        ],
        bills: officialSupport,
        companions: [[HOUSE, SENATE]],
        followed: [MEMBER],
        memberNames: { [MEMBER]: "Sen. Jane Doe" },
      });
      expect(section(backed, "moved_this_week").map((item) => [item.billGuid, item.reason])).toEqual([
        ["BILLS-119hr1", "Matches your topic: Energy"],
        [HOUSE, "Backed by Sen. Jane Doe"],
      ]);
    });

    it("is not ceremonial when the loaded bill's official title is not, whatever the headlines say", async () => {
      const digest = await build({
        items: pair("Honor the Springfield Victims", "Honor the Springfield Victims", { billStatus: "Passed" }),
        bills: {
          [HOUSE]: processed({
            officialTitle: "Honoring the victims of the attack in Springfield and condemning the violence.",
          }),
        },
        companions: [[HOUSE, SENATE]],
      });
      expect(section(digest, "needs_attention")).toEqual([
        expect.objectContaining({ billGuid: HOUSE, reason: "Matches your topic: Energy" }),
      ]);
      expect(items(digest)).toHaveLength(1);
    });

    it("follows the curated overrides: H.Con.Res. 107 and its identical S.Con.Res. 34 are not ceremonial (2026-10-29)", async () => {
      // As stored now: no official titles, and headlines that read as ceremonial; S.Con.Res. 34 has no topics, and
      // is a candidate through a followed cosponsor, so the Brief shows the pair as one item.
      const house = "BILLS-119hconres107";
      const senate = "BILLS-119sconres34";
      const digest = await build({
        items: [
          entry(house, {
            title: "Recognizing gun violence as a serious problem on America's 250th birthday",
            subCategories: ["Healthcare"],
            billStatus: "Passed",
            updatedAt: "2026-03-19T15:00:00.000Z",
          }),
          entry(senate, {
            title: "Recognizing gun violence as a public health problem on America's 250th birthday",
            subCategories: [],
            cosponsors: [MEMBER],
            billStatus: "Passed",
          }),
        ],
        bills: { [house]: processed(), [senate]: processed() },
        companions: [[house, senate]],
        topics: ["Healthcare"],
        followed: [MEMBER],
        memberNames: { [MEMBER]: "Sen. Jane Doe" },
      });
      // Passed in a followed topic, the pair needs attention; tagged by S.Con.Res. 34's headline, the pair would be
      // ceremonial and its topic would not count (it would only have moved this week, for the followed member).
      expect(section(digest, "needs_attention").map((item) => item.billGuid)).toEqual([house]);
      expect(section(digest, "moved_this_week")).toEqual([]);
    });

    it("is ceremonial when either bill's headline is, and neither bill's topics count", async () => {
      const digest = await build({
        items: [
          entry("BILLS-119hr1", { updatedAt: "2026-03-16T15:00:00.000Z" }),
          ...pair("Recognize Careers in Energy Week", "Support Careers in Energy Week", { cosponsors: [MEMBER] }),
        ],
        companions: [[HOUSE, SENATE]],
        followed: [MEMBER],
        memberNames: { [MEMBER]: "Rep. Jane Doe" },
      });

      expect(section(digest, "moved_this_week").map((item) => [item.billGuid, item.reason])).toEqual([
        ["BILLS-119hr1", "Matches your topic: Energy"],
        [HOUSE, "Backed by Rep. Jane Doe"],
      ]);
      expect(section(digest, "worth_quick_look")).toEqual([]);
    });
  });
});

describe("a bill that became law in the brief (REL-44)", () => {
  it("is listed where a Passed bill would be, first, labelled 'Became law'", async () => {
    const digest = await build({
      items: [
        entry("BILLS-119hr1", { billStatus: "Passed" }),
        entry("BILLS-119hr2", { billStatus: "Finalized" }),
        entry("BILLS-119hr3", { billStatus: "Failed" }),
      ],
    });
    expect(section(digest, "needs_attention").map((item) => [item.billGuid, item.billState])).toEqual([
      ["BILLS-119hr2", "finalized"],
      ["BILLS-119hr1", "passed"],
      ["BILLS-119hr3", "failed"],
    ]);
    expect(section(digest, "needs_attention")[0]).toMatchObject({
      eyebrow: "Became law Mar 18",
      summary: "Became law this week.",
      reason: "Matches your topic: Energy",
    });
    // The status line stands in when the bill cannot be read; no text either app shows says "Finalized".
    expect(shownTexts(digest!).some((text) => /finalized/i.test(text))).toBe(false);
  });

  it("shows a companion pair as the law when its twin moved later, as the apps do", async () => {
    // H.J.Res. 131 became law on Tuesday; S.J.Res. 91 got a late line on Thursday and is still Passed.
    const house = "BILLS-119hjres131";
    const senate = "BILLS-119sjres91";
    const digest = await build({
      items: [
        entry(house, { billStatus: "Finalized", updatedAt: "2026-03-17T15:00:00.000Z" }),
        entry(senate, { billStatus: "Passed", updatedAt: "2026-03-19T15:00:00.000Z" }),
      ],
      companions: [[house, senate]],
    });
    expect(items(digest)).toHaveLength(1);
    expect(section(digest, "needs_attention")[0]).toMatchObject({
      billGuid: house,
      billState: "finalized",
      eyebrow: "Became law Mar 17",
    });
  });

  it("shows a Passed/Failed companion pair as the Passed bill when the Failed one moved later, as app 1.2's card does", async () => {
    // Passed 3 > Failed 2 (CompanionGroupIndex.statusLead): not a tie that recency decides.
    const house = "BILLS-119hjres131";
    const senate = "BILLS-119sjres91";
    const digest = await build({
      items: [
        entry(house, { billStatus: "Passed", updatedAt: "2026-03-17T15:00:00.000Z" }),
        entry(senate, { billStatus: "Failed", updatedAt: "2026-03-19T15:00:00.000Z" }),
      ],
      companions: [[house, senate]],
    });
    expect(items(digest)).toHaveLength(1);
    expect(section(digest, "needs_attention")[0]).toMatchObject({
      billGuid: house,
      billState: "passed",
    });

    // The other way round (the Passed bill is the Senate's and moved first): still the Passed bill.
    const swapped = await build({
      items: [
        entry(house, { billStatus: "Failed", updatedAt: "2026-03-19T15:00:00.000Z" }),
        entry(senate, { billStatus: "Passed", updatedAt: "2026-03-17T15:00:00.000Z" }),
      ],
      companions: [[house, senate]],
    });
    expect(section(swapped, "needs_attention").map((item) => [item.billGuid, item.billState])).toEqual([
      [senate, "passed"],
    ]);
  });

  it("still leaves out a Finalized bill outside the user's topics", async () => {
    expect(
      await build({ items: [entry("BILLS-119hr2", { billStatus: "Finalized", subCategories: ["Healthcare"] })] }),
    ).toBeNull();
  });
});
