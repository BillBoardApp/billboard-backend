import { paceWindowEndMs, parsePushPaceHours, pushHoldAt } from "../shared/pushPace";

/*
 * UX-33 (feature review 2026-10-28, S5; project decision that day): at most one push every 3 hours per user. The hold a
 * user's pending rows get combines the pace window of their last push with the quiet hours of S5.
 */

const at = (iso: string) => Date.parse(iso);
const NY = "America/New_York";

describe("parsePushPaceHours", () => {
  it.each([
    ["3", 3],
    [" 3 ", 3],
    ["1", 1],
    ["8", 8],
  ])("reads %j as %d hours", (raw, hours) => {
    expect(parsePushPaceHours(raw)).toBe(hours);
  });

  it.each([[undefined], [""], ["0"], ["9"], ["24"], ["1.5"], ["-1"], ["3h"], ["on"]])(
    "turns the pace off for %j",
    (raw) => {
      expect(parsePushPaceHours(raw)).toBe(0);
    },
  );
});

describe("paceWindowEndMs", () => {
  it("ends the window the given hours after the push", () => {
    expect(paceWindowEndMs(at("2026-10-29T14:00:00Z"), 3)).toBe(at("2026-10-29T17:00:00Z"));
  });
});

describe("pushHoldAt", () => {
  it("sends now with no pace window and no quiet hours", () => {
    expect(pushHoldAt(at("2026-10-29T18:00:00Z"), NY, null)).toBeNull();
    expect(pushHoldAt(at("2026-10-29T18:00:00Z"), null, null)).toBeNull();
  });

  it("sends now once the window has ended", () => {
    expect(pushHoldAt(at("2026-10-29T18:00:00Z"), NY, at("2026-10-29T18:00:00Z"))).toBeNull();
    expect(pushHoldAt(at("2026-10-29T18:00:00Z"), NY, at("2026-10-29T17:59:59Z"))).toBeNull();
  });

  it("holds until the window ends, at 2 PM Eastern for a push at 1 PM", () => {
    // 2 PM EDT is 18:00Z; the window of a 1 PM push ends at 4 PM, 20:00Z.
    expect(pushHoldAt(at("2026-10-29T18:00:00Z"), NY, at("2026-10-29T20:00:00Z"))).toEqual({
      untilMs: at("2026-10-29T20:00:00Z"),
      reason: "pace",
    });
  });

  it("holds by the pace alone while the quiet hours are off", () => {
    expect(pushHoldAt(at("2026-10-30T02:00:00Z"), null, at("2026-10-30T03:00:00Z"))).toEqual({
      untilMs: at("2026-10-30T03:00:00Z"),
      reason: "pace",
    });
  });

  it("holds until 8 AM when the window ends in the quiet hours, so the dispatcher wakes the user once", () => {
    // 8 PM EDT (00:00Z); the window of a 7 PM push ends at 10 PM, in the quiet hours; 8 AM EDT is 12:00Z.
    expect(pushHoldAt(at("2026-10-30T00:00:00Z"), NY, at("2026-10-30T02:00:00Z"))).toEqual({
      untilMs: at("2026-10-30T12:00:00Z"),
      reason: "pace",
    });
  });

  it("holds for the quiet hours until 8 AM, a window that ended before then changing nothing", () => {
    expect(pushHoldAt(at("2026-10-30T02:00:00Z"), NY, at("2026-10-30T01:30:00Z"))).toEqual({
      untilMs: at("2026-10-30T12:00:00Z"),
      reason: "quiet_hours",
    });
  });

  it("holds past 8 AM when a window that began in the quiet hours ends later", () => {
    // 7:30 AM EDT (11:30Z) with a window to 9 AM (13:00Z): a push sent at 6 AM, before the quiet hours were on.
    expect(pushHoldAt(at("2026-10-30T11:30:00Z"), NY, at("2026-10-30T13:00:00Z"))).toEqual({
      untilMs: at("2026-10-30T13:00:00Z"),
      reason: "quiet_hours",
    });
  });

  it("holds through the 2026-11-01 clock change until 8 AM EST", () => {
    // 8:30 PM EDT on Oct 31 (00:30Z Nov 1); the window ends at 9:30 PM, in the quiet hours; 8 AM EST is 13:00Z.
    expect(pushHoldAt(at("2026-11-01T00:30:00Z"), NY, at("2026-11-01T01:30:00Z"))).toEqual({
      untilMs: at("2026-11-01T13:00:00Z"),
      reason: "pace",
    });
  });

  it("holds a row for at most the longest window and the night, well inside its 24 hours", () => {
    // The longest: a row written just after a push at 1:01 PM EDT on Oct 31 with the longest window (8 hours), which
    // ends at 9:01 PM, in the quiet hours of the night clocks fall back: held until 8 AM EST (13:00Z), 20 hours.
    const pushedMs = at("2026-10-31T17:01:00Z");
    const hold = pushHoldAt(pushedMs, NY, paceWindowEndMs(pushedMs, parsePushPaceHours("8")));
    expect(hold).toEqual({ untilMs: at("2026-11-01T13:00:00Z"), reason: "pace" });
    expect((hold!.untilMs - pushedMs) / 3_600_000).toBeCloseTo(19.98, 2);
  });
});
