import { applyTestEnv } from "./fixtures/env";

type ScheduleModule = typeof import("../shared/weeklyDigestSchedule");

function loadSchedule(timeZone: string | undefined): ScheduleModule {
  const restore = applyTestEnv({
    CANONICAL_PUBLISH_TIMEZONE: timeZone,
    CANONICAL_PUBLISH_HOUR: "10",
    CANONICAL_PUBLISH_MINUTE: "0",
  });
  try {
    let loaded: ScheduleModule | undefined;
    jest.isolateModules(() => {
      loaded = require("../shared/weeklyDigestSchedule");
    });
    return loaded!;
  } finally {
    restore();
  }
}

function windowAt(schedule: ScheduleModule, iso: string) {
  const window = schedule.latestPublishedWindow(new Date(iso));
  return {
    id: window.id,
    releaseAt: window.releaseAt.toISOString(),
    start: window.start.toISOString(),
    end: window.end.toISOString(),
  };
}

describe("weeklyDigestSchedule (America/New_York)", () => {
  const schedule = loadSchedule("America/New_York");

  test("uses the configured zone", () => {
    expect(schedule.WEEKLY_DIGEST_TIME_ZONE).toBe("America/New_York");
  });

  test("defaults to America/New_York when the env var is unset", () => {
    expect(loadSchedule(undefined).WEEKLY_DIGEST_TIME_ZONE).toBe("America/New_York");
  });

  test("regular EDT week", () => {
    expect(windowAt(schedule, "2026-03-22T14:00:00.000Z")).toEqual({
      id: "2026-03-22T14:00:00.000Z",
      releaseAt: "2026-03-22T14:00:00.000Z",
      start: "2026-03-15T04:00:00.000Z",
      end: "2026-03-21T04:00:00.000Z",
    });
  });

  describe("second Sunday of March (DST starts 2026-03-08 02:00 local)", () => {
    test("early Sunday morning before the switch still returns the previous EST release", () => {
      // 01:30 EST on the switch day.
      expect(windowAt(schedule, "2026-03-08T06:30:00.000Z")).toEqual({
        id: "2026-03-01T15:00:00.000Z",
        releaseAt: "2026-03-01T15:00:00.000Z",
        start: "2026-02-22T05:00:00.000Z",
        end: "2026-02-28T05:00:00.000Z",
      });
    });

    test("one millisecond before 10:00 EDT returns the previous week", () => {
      expect(windowAt(schedule, "2026-03-08T13:59:59.999Z").releaseAt).toBe("2026-03-01T15:00:00.000Z");
    });

    test("10:00 EDT on the switch day releases at 14:00Z with an EST-anchored window", () => {
      expect(windowAt(schedule, "2026-03-08T14:00:00.000Z")).toEqual({
        id: "2026-03-08T14:00:00.000Z",
        releaseAt: "2026-03-08T14:00:00.000Z",
        start: "2026-03-01T05:00:00.000Z",
        end: "2026-03-07T05:00:00.000Z",
      });
    });

    test("addEasternDays crosses the spring-forward boundary at local midnight", () => {
      expect(schedule.addEasternDays(new Date("2026-03-07T05:00:00.000Z"), 1).toISOString()).toBe(
        "2026-03-08T05:00:00.000Z",
      );
      expect(schedule.addEasternDays(new Date("2026-03-08T05:00:00.000Z"), 1).toISOString()).toBe(
        "2026-03-09T04:00:00.000Z",
      );
    });
  });

  describe("first Sunday of November (DST ends 2026-11-01 02:00 local)", () => {
    test("09:30 EST on the switch day returns the previous EDT release", () => {
      expect(windowAt(schedule, "2026-11-01T14:30:00.000Z")).toEqual({
        id: "2026-10-25T14:00:00.000Z",
        releaseAt: "2026-10-25T14:00:00.000Z",
        start: "2026-10-18T04:00:00.000Z",
        end: "2026-10-24T04:00:00.000Z",
      });
    });

    test("one millisecond before 10:00 EST returns the previous week", () => {
      expect(windowAt(schedule, "2026-11-01T14:59:59.999Z").releaseAt).toBe("2026-10-25T14:00:00.000Z");
    });

    test("10:00 EST on the switch day releases at 15:00Z with an EDT-anchored window", () => {
      expect(windowAt(schedule, "2026-11-01T15:00:00.000Z")).toEqual({
        id: "2026-11-01T15:00:00.000Z",
        releaseAt: "2026-11-01T15:00:00.000Z",
        start: "2026-10-25T04:00:00.000Z",
        end: "2026-10-31T04:00:00.000Z",
      });
    });

    test("the following week starts at 00:00 EDT on the switch day and ends in EST", () => {
      expect(windowAt(schedule, "2026-11-08T15:00:00.000Z")).toEqual({
        id: "2026-11-08T15:00:00.000Z",
        releaseAt: "2026-11-08T15:00:00.000Z",
        start: "2026-11-01T04:00:00.000Z",
        end: "2026-11-07T05:00:00.000Z",
      });
    });

    test("addEasternDays crosses the fall-back boundary at local midnight", () => {
      expect(schedule.addEasternDays(new Date("2026-10-31T04:00:00.000Z"), 1).toISOString()).toBe(
        "2026-11-01T04:00:00.000Z",
      );
      expect(schedule.addEasternDays(new Date("2026-11-01T04:00:00.000Z"), 1).toISOString()).toBe(
        "2026-11-02T05:00:00.000Z",
      );
    });

    test("titles use local calendar days", () => {
      const window = schedule.latestPublishedWindow(new Date("2026-11-01T15:00:00.000Z"));
      expect(schedule.formatWeeklyDigestTitle(window.start, window.end)).toBe(
        "Your Week in Congress | Oct 25-31, 2026",
      );
      expect(schedule.formatWeeklyDigestShortDate(new Date("2026-11-01T04:30:00.000Z"))).toBe("Nov 1");
    });
  });
});

describe("weeklyDigestSchedule honours CANONICAL_PUBLISH_TIMEZONE", () => {
  test("America/Los_Angeles publishes at 10:00 Pacific", () => {
    const schedule = loadSchedule("America/Los_Angeles");
    expect(schedule.WEEKLY_DIGEST_TIME_ZONE).toBe("America/Los_Angeles");
    expect(windowAt(schedule, "2026-03-22T17:00:00.000Z")).toEqual({
      id: "2026-03-22T17:00:00.000Z",
      releaseAt: "2026-03-22T17:00:00.000Z",
      start: "2026-03-15T07:00:00.000Z",
      end: "2026-03-21T07:00:00.000Z",
    });
    // The window that spans the March switch starts in PST and ends in PDT.
    expect(windowAt(schedule, "2026-03-22T16:59:59.999Z")).toEqual({
      id: "2026-03-15T17:00:00.000Z",
      releaseAt: "2026-03-15T17:00:00.000Z",
      start: "2026-03-08T08:00:00.000Z",
      end: "2026-03-14T07:00:00.000Z",
    });
  });

  test("UTC has no offset", () => {
    const schedule = loadSchedule("UTC");
    expect(windowAt(schedule, "2026-03-22T10:00:00.000Z")).toEqual({
      id: "2026-03-22T10:00:00.000Z",
      releaseAt: "2026-03-22T10:00:00.000Z",
      start: "2026-03-15T00:00:00.000Z",
      end: "2026-03-21T00:00:00.000Z",
    });
  });

  test("positive-offset zones use their own DST dates", () => {
    const schedule = loadSchedule("Europe/Berlin");
    // Europe switches on the last Sunday of March.
    expect(windowAt(schedule, "2026-03-29T08:00:00.000Z")).toEqual({
      id: "2026-03-29T08:00:00.000Z",
      releaseAt: "2026-03-29T08:00:00.000Z",
      start: "2026-03-21T23:00:00.000Z",
      end: "2026-03-27T23:00:00.000Z",
    });
  });

  test("a local midnight skipped by DST moves forward to the first valid instant", () => {
    // Chile springs forward from 00:00 to 01:00 on 2026-09-06, so that day has no midnight.
    const schedule = loadSchedule("America/Santiago");
    expect(windowAt(schedule, "2026-09-13T14:00:00.000Z")).toEqual({
      id: "2026-09-13T13:00:00.000Z",
      releaseAt: "2026-09-13T13:00:00.000Z",
      start: "2026-09-06T04:00:00.000Z",
      end: "2026-09-12T03:00:00.000Z",
    });
  });

  test("an invalid zone falls back to America/New_York", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const schedule = loadSchedule("Mars/Olympus");
      expect(schedule.WEEKLY_DIGEST_TIME_ZONE).toBe("America/New_York");
      expect(windowAt(schedule, "2026-03-22T14:00:00.000Z").releaseAt).toBe("2026-03-22T14:00:00.000Z");
      expect(warn).toHaveBeenCalledWith(
        "Ignoring invalid CANONICAL_PUBLISH_TIMEZONE; using default",
        expect.objectContaining({ configured: "Mars/Olympus" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("weekly digest calendar days (S2: the date of a bill's action)", () => {
  const schedule = loadSchedule("America/New_York");

  test("a plain date is the day Congress gave, never shifted from UTC midnight", () => {
    expect(schedule.weeklyDigestDayKeyOf("2026-03-15")).toBe("2026-03-15");
    expect(schedule.weeklyDigestDayKeyOf(" 2026-11-01 ")).toBe("2026-11-01");
    expect(schedule.formatWeeklyDigestDay("2026-03-15")).toBe("Mar 15");
    expect(schedule.formatWeeklyDigestDay("2026-09-03")).toBe("Sep 3");
  });

  test("a timestamp is placed on its New York day", () => {
    expect(schedule.weeklyDigestDayKeyOf("2026-03-22T02:00:00Z")).toBe("2026-03-21");
    expect(schedule.weeklyDigestDayKeyOf("2026-03-22T05:00:00Z")).toBe("2026-03-22");
    expect(schedule.weeklyDigestDayKey(new Date("2026-11-01T04:30:00Z"))).toBe("2026-11-01");
  });

  test("anything else is no day", () => {
    for (const value of [undefined, null, 20260315, "", "  ", "2026-13-01", "2026-02-00", "next Tuesday"]) {
      expect(schedule.weeklyDigestDayKeyOf(value)).toBeNull();
    }
  });

  test("the week's first and last days are its Sunday and Saturday", () => {
    const window = schedule.latestPublishedWindow(new Date("2026-11-01T15:00:00.000Z"));
    expect([schedule.weeklyDigestDayKey(window.start), schedule.weeklyDigestDayKey(window.end)]).toEqual([
      "2026-10-25",
      "2026-10-31",
    ]);
  });
});
