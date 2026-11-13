import { localTimeIn } from "./quietHours";

/**
 * UX-31: the days the Civic Score counts (streaks and the last 30 days) are calendar days in America/New_York, the zone
 * app 1.2 turns the day over in (CivicStatsRefresh re-reads the score at Eastern midnight). Before UX-31 they were UTC
 * days, so a vote after 8 PM Eastern counted for the next day.
 *
 * The switch is per user and never breaks a streak: a user's days stay UTC days up to `easternFrom`, the first Eastern
 * midnight after the read that first stored their Civic Score record (civicRecord.ts), and are Eastern days from then
 * on. An Eastern midnight falls inside the UTC day of the same date (04:00 or 05:00 UTC), so the day of that date runs
 * from its UTC start to the next Eastern midnight, 28 or 29 hours, and no day is skipped or counted twice. Every vote
 * cast before the switch keeps the day it had, and a streak alive before it stays alive at least as long as it would
 * have under UTC days.
 *
 * Day keys are "YYYY-MM-DD"; their arithmetic is on calendar dates, so a 23- or 25-hour day at a clock change is
 * still one day.
 */
export const CIVIC_DAY_TIME_ZONE = "America/New_York";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
const dayKey = (year: number, month: number, day: number): string => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;

/** The UTC calendar day of an instant. */
export const utcDayKey = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/** The calendar day of an instant in America/New_York. */
export const easternDayKey = (epochMs: number): string => {
  const { year, month, day } = localTimeIn(epochMs, CIVIC_DAY_TIME_ZONE);
  return dayKey(year, month, day);
};

/**
 * The first midnight in America/New_York strictly after `epochMs`. US clocks change at 2 AM, so midnight is never
 * skipped or repeated there: it is 04:00 UTC on daylight time and 05:00 UTC on standard time.
 */
export const nextEasternMidnight = (epochMs: number): number => {
  const { year, month, day } = localTimeIn(epochMs, CIVIC_DAY_TIME_ZONE);
  const nextDayStartUtc = Date.UTC(year, month - 1, day + 1);
  const nextDay = utcDayKey(nextDayStartUtc);
  for (const offsetHours of [4, 5]) {
    const candidate = nextDayStartUtc + offsetHours * HOUR_MS;
    const local = localTimeIn(candidate, CIVIC_DAY_TIME_ZONE);
    if (local.hour === 0 && local.minute === 0 && dayKey(local.year, local.month, local.day) === nextDay) {
      return candidate;
    }
  }
  throw new Error(`No Eastern midnight found on ${nextDay}`);
};

/** The day an instant counts on: its UTC day before `easternFromMs`, its America/New_York day from then on. */
export const civicDayKey = (epochMs: number, easternFromMs: number): string =>
  epochMs < easternFromMs ? utcDayKey(epochMs) : easternDayKey(epochMs);

/**
 * civicDayKey for many instants: the Eastern day is looked up once per UTC hour, which is exact because Eastern
 * offsets are whole hours and change on a whole UTC hour, so an Eastern date never changes inside a UTC hour.
 */
export const civicDayKeys = (easternFromMs: number): ((epochMs: number) => string) => {
  const easternDayByHour = new Map<number, string>();
  return (epochMs) => {
    if (epochMs < easternFromMs) return utcDayKey(epochMs);
    const hour = Math.floor(epochMs / HOUR_MS);
    let day = easternDayByHour.get(hour);
    if (day === undefined) {
      day = easternDayKey(epochMs);
      easternDayByHour.set(hour, day);
    }
    return day;
  };
};

const dayNumber = (key: string): number => {
  const [year, month, day] = key.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
};

/** Calendar days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** The day `days` calendar days after `key` (before it when negative). */
export const addDays = (key: string, days: number): string => utcDayKey((dayNumber(key) + days) * DAY_MS);

export interface Streaks {
  /** The run of consecutive days that ends today or yesterday; 0 when the last day is earlier. */
  currentStreak: number;
  /** The longest run of consecutive days. */
  longestStreak: number;
}

/** The runs of consecutive days among `days` (any order, repeats allowed), with today's day key. */
export function computeStreaks(days: Iterable<string>, today: string): Streaks {
  const sorted = [...new Set(days)].sort();
  if (sorted.length === 0) return { currentStreak: 0, longestStreak: 0 };

  let longestStreak = 1;
  let run = 1;
  for (let index = 1; index < sorted.length; index++) {
    run = daysBetween(sorted[index - 1], sorted[index]) === 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  }

  // The last day is today or yesterday (or later than today: a vote on a day the clock has not reached here).
  if (daysBetween(sorted[sorted.length - 1], today) > 1) return { currentStreak: 0, longestStreak };
  let currentStreak = 1;
  for (let index = sorted.length - 1; index > 0; index--) {
    if (daysBetween(sorted[index - 1], sorted[index]) !== 1) break;
    currentStreak++;
  }
  return { currentStreak, longestStreak };
}

/** The `count` days that end today, oldest first, each with its number from `counts` (0 when absent). */
export function recentDays(counts: ReadonlyMap<string, number>, today: string, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const date = addDays(today, index - (count - 1));
    return { date, count: counts.get(date) ?? 0 };
  });
}
