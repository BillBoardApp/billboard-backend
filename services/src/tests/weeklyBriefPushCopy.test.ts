import type { WeeklyDigest, WeeklyDigestItem } from "../models/weeklyDigest";
import {
  weeklyBriefBillTitles,
  weeklyBriefPushBody,
  weeklyBriefPushCopy,
  weeklyBriefPushTitle,
} from "../shared/weeklyBriefPushCopy";
import { formatWeeklyDigestShortRange, latestPublishedWindow } from "../shared/weeklyDigestSchedule";

/*
 * UX-28, decision D4 (a): the Sunday push names the brief's week and its bills. The title is the front page's docket
 * range ("Weekly Brief · Nov 15–21"); the body lists the brief's bills in page order and never counts sections.
 */

const bill = (title: string, guid = `BILLS-119hr${title.length}`): WeeklyDigestItem => ({
  id: `bill|${guid}`,
  kind: "bill",
  title,
  summary: "Nov 18: Passed the House.",
  accent: "movement",
  billGuid: guid,
});

const member = (name: string): WeeklyDigestItem => ({
  id: `member|A000360|BILLS-119hr1`,
  kind: "member",
  title: name,
  summary: "Cosponsored H.R. 1, which moved this week.",
  accent: "representative",
  billGuid: "BILLS-119hr1",
  primaryMemberBioguideId: "A000360",
});

const digest = (
  sections: Array<{ kind: WeeklyDigest["sections"][number]["kind"]; items: WeeklyDigestItem[] }>,
  summary = "One bill needs your attention.",
): WeeklyDigest => ({
  id: "2026-11-22T15:00:00.000Z",
  title: "Your Week in Congress | Nov 15-21, 2026",
  summary,
  weekStart: "2026-11-15T05:00:00.000Z",
  weekEnd: "2026-11-21T05:00:00.000Z",
  publishedAt: "2026-11-22T15:00:00.000Z",
  isRead: false,
  stats: [],
  sections: sections.map((section) => ({ ...section, title: section.kind })),
});

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("the push title (the front page's docket range)", () => {
  it.each([
    ["the week of 2026-11-22", "2026-11-22T15:30:00Z", "Weekly Brief · Nov 15–21"],
    ["a week across two months", "2026-11-01T15:30:00Z", "Weekly Brief · Oct 25–31"],
    ["a week ending in the next month", "2026-11-08T15:30:00Z", "Weekly Brief · Nov 1–7"],
    ["a week across two years", "2027-01-03T15:30:00Z", "Weekly Brief · Dec 27–Jan 2"],
    ["a week across the fall clock change", "2026-11-08T16:30:00Z", "Weekly Brief · Nov 1–7"],
  ])("%s", (_label, now, title) => {
    const window = latestPublishedWindow(new Date(now));
    expect(weeklyBriefPushTitle(window.start, window.end)).toBe(title);
  });

  it("names both months when the week crosses them", () => {
    expect(
      formatWeeklyDigestShortRange(new Date("2026-10-25T04:00:00.000Z"), new Date("2026-11-01T04:00:00.000Z")),
    ).toBe("Oct 25–Nov 1");
  });

  it("is built from the snapshot's own week", () => {
    expect(weeklyBriefPushCopy(digest([{ kind: "moved_this_week", items: [bill("Rural Broadband Act")] }])).title).toBe(
      "Weekly Brief · Nov 15–21",
    );
  });
});

describe("the push body (the brief's bills, in page order)", () => {
  it("one bill: Includes {title}.", () => {
    expect(
      weeklyBriefPushBody(digest([{ kind: "needs_attention", items: [bill("Rural Broadband Access Act")] }])),
    ).toBe("Includes Rural Broadband Access Act.");
  });

  it("two bills: Includes {1} and {2}.", () => {
    const body = weeklyBriefPushBody(
      digest([
        { kind: "needs_attention", items: [bill("Rural Broadband Access Act")] },
        { kind: "moved_this_week", items: [bill("Clean Water Act")] },
      ]),
    );
    expect(body).toBe("Includes Rural Broadband Access Act and Clean Water Act.");
  });

  it("three or more: Includes {1}, {2}, and {N} more., member items skipped and sections in page order", () => {
    const body = weeklyBriefPushBody(
      digest([
        { kind: "needs_attention", items: [bill("Rural Broadband Access Act")] },
        { kind: "moved_this_week", items: [bill("Clean Water Act"), bill("Farm Credit Act of 2026")] },
        { kind: "representatives", items: [member("Jordan Example")] },
        { kind: "worth_quick_look", items: [bill("Postal Service Reform Act")] },
      ]),
    );
    expect(body).toBe("Includes Rural Broadband Access Act, Clean Water Act, and 2 more.");
  });

  it("cuts each listed title to 36 bytes with ..., and never writes four dots", () => {
    const long = "Lower Energy Costs for Families Through Tax Credits Act";
    const longer = "Strengthening Rural Hospitals Across America Act";
    const two = weeklyBriefPushBody(
      digest([{ kind: "moved_this_week", items: [bill(long, "BILLS-119hr1"), bill(longer, "BILLS-119s2")] }]),
    );
    expect(two).toBe("Includes Lower Energy Costs for Families T... and Strengthening Rural Hospitals Acr...");
    expect(
      two
        .replace(/^Includes /, "")
        .split(" and ")
        .map(bytes),
    ).toEqual([36, 36]);

    const three = weeklyBriefPushBody(
      digest([
        {
          kind: "moved_this_week",
          items: [bill(long, "BILLS-119hr1"), bill(longer, "BILLS-119s2"), bill("Clean Water Act", "BILLS-119s3")],
        },
      ]),
    );
    expect(three).toBe(
      "Includes Lower Energy Costs for Families T..., Strengthening Rural Hospitals Acr..., and 1 more.",
    );
  });

  it("gives a lone title the whole body, within 160 bytes", () => {
    const title = "A".repeat(80) + " " + "B".repeat(120);
    const body = weeklyBriefPushBody(digest([{ kind: "moved_this_week", items: [bill(title)] }]));
    expect(bytes(body)).toBeLessThanOrEqual(160);
    expect(body.startsWith(`Includes ${"A".repeat(80)}`)).toBe(true);
    expect(body.endsWith("...")).toBe(true);
  });

  it("lists a bill once when it shows twice", () => {
    const same = bill("Clean Water Act", "BILLS-119s3");
    expect(weeklyBriefBillTitles(digest([{ kind: "moved_this_week", items: [same, same] }]))).toEqual([
      "Clean Water Act",
    ]);
  });

  it("says the brief's own headline when it has no bill item (only members you follow)", () => {
    const body = weeklyBriefPushBody(
      digest(
        [{ kind: "representatives", items: [member("Jordan Example")] }],
        "One member you follow had a bill move.",
      ),
    );
    expect(body).toBe("One member you follow had a bill move.");
  });

  it("keeps every body within 160 bytes", () => {
    const many = Array.from({ length: 8 }, (_, index) => bill(`${"Ü".repeat(40)} ${index}`, `BILLS-119hr${index}`));
    const body = weeklyBriefPushBody(digest([{ kind: "moved_this_week", items: many }]));
    expect(bytes(body)).toBeLessThanOrEqual(160);
    expect(body.endsWith(", and 6 more.")).toBe(true);
  });

  it("never says digest, alert or a count of sections", () => {
    const copy = weeklyBriefPushCopy(
      digest([
        { kind: "needs_attention", items: [bill("Rural Broadband Access Act")] },
        { kind: "moved_this_week", items: [bill("Clean Water Act"), bill("Farm Credit Act of 2026")] },
      ]),
    );
    expect(`${copy.title} ${copy.body}`).not.toMatch(/digest|alert|need attention|worth a look/i);
  });
});
