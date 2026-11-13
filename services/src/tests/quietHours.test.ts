import { DISPATCH_MARKER_TTL_SECONDS, PENDING_ROW_TTL_SECONDS } from "../shared/pendingNotifications";
import {
  DEFAULT_QUIET_HOURS_TIME_ZONE,
  isInQuietHours,
  localTimeIn,
  quietHoursEndAfter,
  STATE_TIME_ZONES,
  timeZoneForState,
} from "../shared/quietHours";

/*
 * S5 (feature review 2026-10-28): no push from 9 PM to 8 AM in the reader's time zone, taken from the state of their
 * district. These pin the boundaries, the 2026-11-01 clock change, the zones that keep standard time or sit far from
 * Eastern, the fallback to Eastern, and that a hold always ends before the pending rows it holds expire.
 */

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

describe("timeZoneForState", () => {
  it("maps every state, DC and the territories with a delegate to a zone the runtime knows", () => {
    expect(Object.keys(STATE_TIME_ZONES)).toHaveLength(56);
    for (const zone of Object.values(STATE_TIME_ZONES)) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone })).not.toThrow();
    }
  });

  it.each([
    ["NY", "America/New_York"],
    ["CA", "America/Los_Angeles"],
    ["TX", "America/Chicago"],
    ["CO", "America/Denver"],
    ["AZ", "America/Phoenix"],
    ["AK", "America/Anchorage"],
    ["HI", "Pacific/Honolulu"],
    ["PR", "America/Puerto_Rico"],
    ["GU", "Pacific/Guam"],
    // Split states: the zone of most residents.
    ["FL", "America/New_York"],
    ["IN", "America/New_York"],
    ["KY", "America/New_York"],
    ["MI", "America/New_York"],
    ["TN", "America/Chicago"],
    ["ND", "America/Chicago"],
    ["ID", "America/Boise"],
    ["OR", "America/Los_Angeles"],
    // Any case, trimmed.
    [" az ", "America/Phoenix"],
  ])("puts %j in %s", (state, zone) => {
    expect(timeZoneForState(state)).toBe(zone);
  });

  it.each([[undefined], [null], [""], ["ZZ"], ["New York"], [42]])("uses Eastern time for %j", (state) => {
    expect(timeZoneForState(state)).toBe(DEFAULT_QUIET_HOURS_TIME_ZONE);
    expect(DEFAULT_QUIET_HOURS_TIME_ZONE).toBe("America/New_York");
  });
});

describe("quiet hours in Eastern time (EDT, UTC-4, on 2026-10-28)", () => {
  const ET = "America/New_York";

  it.each([
    ["8:59 PM", "2026-10-29T00:59:00Z", null],
    ["9:00 PM", "2026-10-29T01:00:00Z", "2026-10-29T12:00:00.000Z"],
    ["11:30 PM", "2026-10-29T03:30:00Z", "2026-10-29T12:00:00.000Z"],
    ["midnight", "2026-10-29T04:00:00Z", "2026-10-29T12:00:00.000Z"],
    ["7:59 AM", "2026-10-29T11:59:00Z", "2026-10-29T12:00:00.000Z"],
    ["8:00 AM", "2026-10-29T12:00:00Z", null],
    ["noon", "2026-10-29T16:00:00Z", null],
  ])("at %s the hold ends at %s", (_label, now, end) => {
    expect(iso(quietHoursEndAfter(at(now), ET))).toBe(end);
    expect(isInQuietHours(at(now), ET)).toBe(end !== null);
  });

  it("holds across a month and a year end", () => {
    expect(iso(quietHoursEndAfter(at("2026-11-01T02:30:00Z"), ET))).toBe("2026-11-01T13:00:00.000Z");
    // 10 PM on Dec 31 (EST, UTC-5) waits for 8 AM on Jan 1.
    expect(iso(quietHoursEndAfter(at("2027-01-01T03:00:00Z"), ET))).toBe("2027-01-01T13:00:00.000Z");
  });
});

describe("the 2026-11-01 clock change (2 AM EDT becomes 1 AM EST)", () => {
  const ET = "America/New_York";

  it("holds from 9 PM EDT on Oct 31 to 8 AM EST on Nov 1, 12 hours", () => {
    const ninePm = at("2026-11-01T01:00:00Z");
    expect(localTimeIn(ninePm, ET)).toMatchObject({ month: 10, day: 31, hour: 21 });
    const end = quietHoursEndAfter(ninePm, ET)!;
    expect(iso(end)).toBe("2026-11-01T13:00:00.000Z");
    expect(localTimeIn(end, ET)).toMatchObject({ month: 11, day: 1, hour: 8, minute: 0 });
    expect((end - ninePm) / 3_600_000).toBe(12);
  });

  it("is quiet through both 1:30 AMs and at 7:30 AM EST (8:30 by the old offset)", () => {
    for (const now of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-01T12:30:00Z"]) {
      expect({ now, end: iso(quietHoursEndAfter(at(now), ET)) }).toEqual({ now, end: "2026-11-01T13:00:00.000Z" });
    }
  });

  it("sends from 8:00 AM EST and holds again from 9:00 PM EST (02:00Z)", () => {
    expect(quietHoursEndAfter(at("2026-11-01T13:00:00Z"), ET)).toBeNull();
    expect(quietHoursEndAfter(at("2026-11-02T01:59:00Z"), ET)).toBeNull();
    expect(iso(quietHoursEndAfter(at("2026-11-02T02:00:00Z"), ET))).toBe("2026-11-02T13:00:00.000Z");
  });

  it("moves Central and Pacific users' 8 AM by their own clocks", () => {
    expect(iso(quietHoursEndAfter(at("2026-11-01T06:00:00Z"), "America/Chicago"))).toBe("2026-11-01T14:00:00.000Z");
    expect(iso(quietHoursEndAfter(at("2026-11-01T06:00:00Z"), "America/Los_Angeles"))).toBe("2026-11-01T16:00:00.000Z");
  });
});

describe("zones far from Eastern, or without daylight time", () => {
  it.each([
    // Alaska (AKDT, UTC-8, until Nov 1): 9 PM AKDT is 05:00Z.
    ["AK", "2026-10-29T04:59:00Z", null],
    ["AK", "2026-10-29T05:00:00Z", "2026-10-29T16:00:00.000Z"],
    // Hawaii keeps HST (UTC-10) all year: 9 PM is 07:00Z, 8 AM is 18:00Z.
    ["HI", "2026-10-29T06:59:00Z", null],
    ["HI", "2026-10-29T07:00:00Z", "2026-10-29T18:00:00.000Z"],
    ["HI", "2026-10-29T17:59:00Z", "2026-10-29T18:00:00.000Z"],
    ["HI", "2026-10-29T18:00:00Z", null],
    // Arizona keeps MST (UTC-7): 9 PM is 04:00Z in summer and winter alike.
    ["AZ", "2026-07-15T04:00:00Z", "2026-07-15T15:00:00.000Z"],
    ["AZ", "2026-12-15T04:00:00Z", "2026-12-15T15:00:00.000Z"],
    ["AZ", "2026-12-15T03:59:00Z", null],
    // Guam (UTC+10): 9 PM there is 11:00Z the same day.
    ["GU", "2026-10-29T11:00:00Z", "2026-10-29T22:00:00.000Z"],
  ])("%s at %s: hold until %s", (state, now, end) => {
    expect(iso(quietHoursEndAfter(at(now), timeZoneForState(state)))).toBe(end);
  });

  it("holds an Eastern-time user and sends to a Pacific user at the same instant", () => {
    const tenPmEastern = at("2026-10-29T02:00:00Z");
    expect(quietHoursEndAfter(tenPmEastern, timeZoneForState("NY"))).not.toBeNull();
    expect(quietHoursEndAfter(tenPmEastern, timeZoneForState("CA"))).toBeNull();
  });

  it("uses Eastern time for an unknown state", () => {
    expect(iso(quietHoursEndAfter(at("2026-10-29T02:00:00Z"), timeZoneForState(undefined)))).toBe(
      "2026-10-29T12:00:00.000Z",
    );
  });
});

describe("a held row never expires before its push", () => {
  it("holds at most 12 hours in any zone and on any night, inside the row's 24 hours and the marker's 26", () => {
    const zones = Array.from(new Set(Object.values(STATE_TIME_ZONES)));
    let longest = 0;
    // Every 15 minutes through the 2026 clock changes (Mar 8 and Nov 1) and the nights around them.
    for (const [from, to] of [
      ["2026-03-06T00:00:00Z", "2026-03-10T00:00:00Z"],
      ["2026-10-30T00:00:00Z", "2026-11-03T00:00:00Z"],
    ]) {
      for (let now = at(from); now < at(to); now += 15 * 60_000) {
        for (const zone of zones) {
          const end = quietHoursEndAfter(now, zone);
          if (end === null) continue;
          expect(end).toBeGreaterThan(now);
          expect(localTimeIn(end, zone)).toMatchObject({ hour: 8, minute: 0 });
          longest = Math.max(longest, end - now);
        }
      }
    }
    expect(longest / 3_600_000).toBeLessThanOrEqual(12);
    // Plus the 5-minute dispatch that sends the rows, and margin.
    const latestSendSeconds = longest / 1000 + 5 * 60;
    expect(latestSendSeconds).toBeLessThan(PENDING_ROW_TTL_SECONDS);
    expect(latestSendSeconds).toBeLessThan(DISPATCH_MARKER_TTL_SECONDS);
  });
});
