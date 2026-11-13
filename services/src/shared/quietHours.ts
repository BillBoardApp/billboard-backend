/**
 * Push quiet hours (feature review 2026-10-28, S5; project decision the same day): no push between 9 PM and 8 AM in
 * the reader's time zone. userNotifier holds a user's pending rows through the night and sends them, folded as usual,
 * in the first dispatch after 8 AM.
 *
 * The zone comes from the state of the user's district (UserPII `resolvedState`, else `selfAttestedState`), through a
 * fixed state-to-zone map. A state that spans zones gets the zone where most of its residents live. A user with no
 * state, or a value that is not a known state, gets Eastern time.
 *
 * The longest hold is 9 PM to 8 AM, 11 hours (12 on the night clocks fall back). A pending row lives 24 hours and its
 * dispatch marker 26 (shared/pendingNotifications.ts), so nothing held overnight expires before morning.
 */

export const QUIET_HOURS_START_HOUR = 21;
export const QUIET_HOURS_END_HOUR = 8;
export const DEFAULT_QUIET_HOURS_TIME_ZONE = "America/New_York";

const EASTERN = "America/New_York";
const CENTRAL = "America/Chicago";
const MOUNTAIN = "America/Denver";
const ARIZONA = "America/Phoenix";
const PACIFIC = "America/Los_Angeles";

/**
 * Postal code to IANA zone. States split between two zones use the zone of most residents: Florida, Indiana,
 * Kentucky and Michigan Eastern; Kansas, Nebraska, North Dakota, South Dakota, Tennessee and Texas Central; Idaho
 * Mountain (Boise); Nevada and Oregon Pacific. Arizona keeps standard time all year. The territories with a delegate
 * are included.
 */
export const STATE_TIME_ZONES: Readonly<Record<string, string>> = Object.freeze({
  AL: CENTRAL,
  AK: "America/Anchorage",
  AZ: ARIZONA,
  AR: CENTRAL,
  CA: PACIFIC,
  CO: MOUNTAIN,
  CT: EASTERN,
  DE: EASTERN,
  DC: EASTERN,
  FL: EASTERN,
  GA: EASTERN,
  HI: "Pacific/Honolulu",
  ID: "America/Boise",
  IL: CENTRAL,
  IN: EASTERN,
  IA: CENTRAL,
  KS: CENTRAL,
  KY: EASTERN,
  LA: CENTRAL,
  ME: EASTERN,
  MD: EASTERN,
  MA: EASTERN,
  MI: EASTERN,
  MN: CENTRAL,
  MS: CENTRAL,
  MO: CENTRAL,
  MT: MOUNTAIN,
  NE: CENTRAL,
  NV: PACIFIC,
  NH: EASTERN,
  NJ: EASTERN,
  NM: MOUNTAIN,
  NY: EASTERN,
  NC: EASTERN,
  ND: CENTRAL,
  OH: EASTERN,
  OK: CENTRAL,
  OR: PACIFIC,
  PA: EASTERN,
  RI: EASTERN,
  SC: EASTERN,
  SD: CENTRAL,
  TN: CENTRAL,
  TX: CENTRAL,
  UT: MOUNTAIN,
  VT: EASTERN,
  VA: EASTERN,
  WA: PACIFIC,
  WV: EASTERN,
  WI: CENTRAL,
  WY: MOUNTAIN,
  AS: "Pacific/Pago_Pago",
  GU: "Pacific/Guam",
  MP: "Pacific/Guam",
  PR: "America/Puerto_Rico",
  VI: "America/Puerto_Rico",
});

/** The zone for a state's postal code (any case, trimmed); Eastern time for anything else, or none. */
export const timeZoneForState = (state: unknown): string => {
  if (typeof state !== "string") return DEFAULT_QUIET_HOURS_TIME_ZONE;
  return STATE_TIME_ZONES[state.trim().toUpperCase()] ?? DEFAULT_QUIET_HOURS_TIME_ZONE;
};

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/** The wall-clock time in `timeZone` at the instant `epochMs`. */
export const localTimeIn = (epochMs: number, timeZone: string): LocalTime => {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // Some ICU builds write midnight as 24 even with h23.
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
};

/** How far `timeZone` is ahead of UTC at `epochMs`, in milliseconds (negative west of Greenwich). */
const offsetMs = (epochMs: number, timeZone: string): number => {
  const local = localTimeIn(epochMs, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - (epochMs - (((epochMs % 1000) + 1000) % 1000));
};

/**
 * The instant the wall clock in `timeZone` reads `hour`:00 on the given day. Exact for any hour no clock change
 * touches (US zones change at 2 AM; the quiet hours end at 8 AM).
 */
const instantOfLocalHour = (year: number, month: number, day: number, hour: number, timeZone: string): number => {
  const asUtc = Date.UTC(year, month - 1, day, hour);
  const first = asUtc - offsetMs(asUtc, timeZone);
  const second = asUtc - offsetMs(first, timeZone);
  return second;
};

/** True when `epochMs` falls in the quiet hours (9:00 PM up to, not including, 8:00 AM) of `timeZone`. */
export const isInQuietHours = (epochMs: number, timeZone: string): boolean => {
  const { hour } = localTimeIn(epochMs, timeZone);
  return hour >= QUIET_HOURS_START_HOUR || hour < QUIET_HOURS_END_HOUR;
};

/**
 * When the quiet hours that hold `epochMs` end in `timeZone` (the next 8:00 AM there), in epoch milliseconds; null
 * when `epochMs` is outside them.
 */
export const quietHoursEndAfter = (epochMs: number, timeZone: string): number | null => {
  const local = localTimeIn(epochMs, timeZone);
  if (local.hour < QUIET_HOURS_END_HOUR) {
    return instantOfLocalHour(local.year, local.month, local.day, QUIET_HOURS_END_HOUR, timeZone);
  }
  if (local.hour >= QUIET_HOURS_START_HOUR) {
    // The next calendar day; Date.UTC carries the month and year over.
    const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    return instantOfLocalHour(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      QUIET_HOURS_END_HOUR,
      timeZone,
    );
  }
  return null;
};
