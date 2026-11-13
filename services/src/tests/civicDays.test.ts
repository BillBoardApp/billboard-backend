import {
  addDays,
  civicDayKey,
  civicDayKeys,
  computeStreaks,
  daysBetween,
  easternDayKey,
  nextEasternMidnight,
  recentDays,
  utcDayKey,
} from "../shared/civicDays";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("civic days (UX-31)", () => {
  it("reads an instant's day in America/New_York, on daylight and on standard time", () => {
    // 8:30 PM EDT on Oct 27 is already Oct 28 in UTC.
    expect(easternDayKey(at("2026-10-28T00:30:00.000Z"))).toBe("2026-10-27");
    expect(utcDayKey(at("2026-10-28T00:30:00.000Z"))).toBe("2026-10-28");
    expect(easternDayKey(at("2026-10-28T03:59:59.999Z"))).toBe("2026-10-27");
    expect(easternDayKey(at("2026-10-28T04:00:00.000Z"))).toBe("2026-10-28");
    // After clocks fall back on Nov 1, 2026, Eastern midnight is 05:00 UTC.
    expect(easternDayKey(at("2026-11-03T04:30:00.000Z"))).toBe("2026-11-02");
    expect(easternDayKey(at("2026-11-03T05:00:00.000Z"))).toBe("2026-11-03");
  });

  it("finds the next Eastern midnight, across both clock changes", () => {
    expect(iso(nextEasternMidnight(at("2026-10-29T15:00:00.000Z")))).toBe("2026-10-30T04:00:00.000Z");
    // Late on Oct 31 (EDT): the midnight that starts Nov 1 is still on daylight time.
    expect(iso(nextEasternMidnight(at("2026-11-01T02:00:00.000Z")))).toBe("2026-11-01T04:00:00.000Z");
    // Nov 1 is 25 hours long; the next midnight is on standard time.
    expect(iso(nextEasternMidnight(at("2026-11-01T04:00:00.000Z")))).toBe("2026-11-02T05:00:00.000Z");
    expect(iso(nextEasternMidnight(at("2026-11-01T06:30:00.000Z")))).toBe("2026-11-02T05:00:00.000Z");
    // Mar 14, 2027 is 23 hours long: it starts at 05:00 UTC and the next day at 04:00 UTC.
    expect(iso(nextEasternMidnight(at("2027-03-14T04:59:00.000Z")))).toBe("2027-03-14T05:00:00.000Z");
    expect(iso(nextEasternMidnight(at("2027-03-14T05:00:00.000Z")))).toBe("2027-03-15T04:00:00.000Z");
    // Year end.
    expect(iso(nextEasternMidnight(at("2026-12-31T20:00:00.000Z")))).toBe("2027-01-01T05:00:00.000Z");
  });

  it("counts UTC days before the switch and Eastern days from it, with no day skipped or repeated", () => {
    const switchAt = at("2026-10-30T04:00:00.000Z"); // Eastern midnight that starts Oct 30
    expect(civicDayKey(at("2026-10-29T23:59:00.000Z"), switchAt)).toBe("2026-10-29");
    // Oct 30 runs from 00:00 UTC to the next Eastern midnight: 28 hours.
    expect(civicDayKey(at("2026-10-30T00:00:00.000Z"), switchAt)).toBe("2026-10-30");
    expect(civicDayKey(at("2026-10-30T03:59:59.999Z"), switchAt)).toBe("2026-10-30");
    expect(civicDayKey(switchAt, switchAt)).toBe("2026-10-30");
    expect(civicDayKey(at("2026-10-31T03:59:59.999Z"), switchAt)).toBe("2026-10-30");
    expect(civicDayKey(at("2026-10-31T04:00:00.000Z"), switchAt)).toBe("2026-10-31");

    // Walking every 15 minutes across the switch and a clock change, the day never goes back or jumps a day.
    let previous = civicDayKey(at("2026-10-28T00:00:00.000Z"), switchAt);
    for (let ms = at("2026-10-28T00:15:00.000Z"); ms < at("2026-11-04T00:00:00.000Z"); ms += 15 * 60_000) {
      const day = civicDayKey(ms, switchAt);
      expect([0, 1]).toContain(daysBetween(previous, day));
      previous = day;
    }
  });

  it("gives the same days when it looks the Eastern day up once per UTC hour, across both clock changes", () => {
    const switchAt = at("2026-10-30T04:00:00.000Z");
    const dayOf = civicDayKeys(switchAt);
    for (const [from, to] of [
      ["2026-10-29T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
      ["2027-03-12T00:00:00.000Z", "2027-03-17T00:00:00.000Z"],
    ]) {
      for (let ms = at(from); ms < at(to); ms += 7 * 60_000 + 13_000) {
        expect(dayOf(ms)).toBe(civicDayKey(ms, switchAt));
      }
    }
  });

  it("does calendar arithmetic on day keys", () => {
    expect(daysBetween("2026-10-31", "2026-11-01")).toBe(1);
    expect(daysBetween("2026-11-01", "2026-10-30")).toBe(-2);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("finds the current and longest streaks", () => {
    expect(computeStreaks([], "2026-10-29")).toEqual({ currentStreak: 0, longestStreak: 0 });
    expect(computeStreaks(["2026-10-29", "2026-10-28", "2026-10-28", "2026-10-27"], "2026-10-29")).toEqual({
      currentStreak: 3,
      longestStreak: 3,
    });
    // Ending yesterday still counts; two days ago does not.
    expect(computeStreaks(["2026-10-27", "2026-10-28"], "2026-10-29").currentStreak).toBe(2);
    expect(computeStreaks(["2026-10-26", "2026-10-27"], "2026-10-29")).toEqual({ currentStreak: 0, longestStreak: 2 });
    expect(
      computeStreaks(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-28"], "2026-10-28"),
    ).toEqual({ currentStreak: 1, longestStreak: 4 });
    // Across the fall-back day (25 hours) and month end.
    expect(computeStreaks(["2026-10-31", "2026-11-01", "2026-11-02"], "2026-11-02").currentStreak).toBe(3);
  });

  it("lists the last days, oldest first, ending today", () => {
    const days = recentDays(
      new Map([
        ["2026-10-29", 2],
        ["2026-10-01", 1],
        ["2026-09-30", 5],
      ]),
      "2026-10-30",
      30,
    );
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ date: "2026-10-01", count: 1 });
    expect(days[28]).toEqual({ date: "2026-10-29", count: 2 });
    expect(days[29]).toEqual({ date: "2026-10-30", count: 0 });
  });
});
