const DEFAULT_WEEKLY_DIGEST_TIME_ZONE = "America/New_York";
const DEFAULT_WEEKLY_DIGEST_RELEASE_HOUR = 10;
const DEFAULT_WEEKLY_DIGEST_RELEASE_MINUTE = 0;

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function resolveTimeZone(configured: string | undefined): string {
  const trimmed = configured?.trim();
  if (!trimmed) {
    return DEFAULT_WEEKLY_DIGEST_TIME_ZONE;
  }

  if (!isValidTimeZone(trimmed)) {
    console.warn("Ignoring invalid CANONICAL_PUBLISH_TIMEZONE; using default", {
      configured: trimmed,
      fallback: DEFAULT_WEEKLY_DIGEST_TIME_ZONE,
    });
    return DEFAULT_WEEKLY_DIGEST_TIME_ZONE;
  }

  return trimmed;
}

// Must match the EventBridge schedule's time zone (infra passes the same value),
// or the digest window will not line up with the publication run.
export const WEEKLY_DIGEST_TIME_ZONE = resolveTimeZone(process.env.CANONICAL_PUBLISH_TIMEZONE);
const WEEKLY_DIGEST_RELEASE_HOUR = parseNumber(process.env.CANONICAL_PUBLISH_HOUR, DEFAULT_WEEKLY_DIGEST_RELEASE_HOUR);
const WEEKLY_DIGEST_RELEASE_MINUTE = parseNumber(
  process.env.CANONICAL_PUBLISH_MINUTE,
  DEFAULT_WEEKLY_DIGEST_RELEASE_MINUTE,
);

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
};

type LocalDateTimeParts = LocalDateParts & {
  hour: number;
  minute: number;
  second?: number;
  millisecond?: number;
};

export interface WeeklyDigestPublicationWindow {
  id: string;
  start: Date;
  end: Date;
  releaseAt: Date;
}

const localDatePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: WEEKLY_DIGEST_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const zoneOffsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: WEEKLY_DIGEST_TIME_ZONE,
  timeZoneName: "longOffset",
});

function getLocalDateParts(date: Date): LocalDateParts {
  const parts = localDatePartsFormatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "0");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "0");

  return { year, month, day };
}

/** UTC offset of the publish time zone at `epochMs`, in milliseconds ("GMT-04:00" -> -4h). */
function zoneOffsetMs(epochMs: number): number {
  const label =
    zoneOffsetFormatter.formatToParts(new Date(epochMs)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(label);
  if (!match) {
    // "GMT" alone means UTC+0.
    return 0;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes) * 60_000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Converts a wall-clock time in the publish time zone to a UTC instant using the
 * zone's real offset rules. An ambiguous fall-back time resolves to its first
 * occurrence, and a time skipped by a spring-forward gap moves forward by the
 * gap (02:30 becomes 03:30), matching Temporal's "compatible" disambiguation.
 */
function localToUtc(parts: LocalDateTimeParts): Date {
  const wallClockAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    parts.millisecond ?? 0,
  );

  // Zones change offset at most once in any 48-hour span, so the offsets a day
  // either side are the only two this wall time can map through.
  const offsetBefore = zoneOffsetMs(wallClockAsUtc - DAY_MS);
  const offsetAfter = zoneOffsetMs(wallClockAsUtc + DAY_MS);
  const valid = [wallClockAsUtc - offsetBefore, wallClockAsUtc - offsetAfter].filter(
    (candidate) => zoneOffsetMs(candidate) === wallClockAsUtc - candidate,
  );

  return new Date(valid.length > 0 ? Math.min(...valid) : wallClockAsUtc - offsetBefore);
}

function addDaysToParts(parts: LocalDateParts, days: number): LocalDateParts {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function dayOfWeek(parts: LocalDateParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function monthDay(parts: LocalDateParts): string {
  return `${MONTH_NAMES_SHORT[parts.month - 1]} ${parts.day}`;
}

/** Local midnight `days` days after `date`'s calendar day in the publish time zone. */
export function addEasternDays(date: Date, days: number): Date {
  const parts = getLocalDateParts(date);
  const next = addDaysToParts(parts, days);
  return localToUtc({
    ...next,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

export function formatWeeklyDigestShortDate(date: Date): string {
  return monthDay(getLocalDateParts(date));
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar day of `date` in the publish time zone, as "yyyy-mm-dd". */
export function weeklyDigestDayKey(date: Date): string {
  const { year, month, day } = getLocalDateParts(date);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The calendar day a Congress.gov date names, as "yyyy-mm-dd", or null. A plain date ("2026-03-19", the form
 * actionDate takes) is that day as written: it is a calendar day, not UTC midnight. A timestamp is read as an
 * instant and placed on its day in the publish time zone.
 */
export function weeklyDigestDayKeyOf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const plain = DAY_KEY_RE.exec(trimmed);
  if (plain) {
    const month = Number(plain[2]);
    const day = Number(plain[3]);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? trimmed : null;
  }

  if (!trimmed) {
    return null;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : weeklyDigestDayKey(date);
}

/** "Mar 19" for the day key "2026-03-19". */
export function formatWeeklyDigestDay(dayKey: string): string {
  const match = DAY_KEY_RE.exec(dayKey);
  if (!match) {
    return dayKey;
  }

  return monthDay({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
}

export function formatWeeklyDigestTitle(weekStart: Date, weekEnd: Date): string {
  const start = getLocalDateParts(weekStart);
  const end = getLocalDateParts(weekEnd);

  let range: string;
  if (start.year === end.year && start.month === end.month) {
    range = `${MONTH_NAMES_SHORT[start.month - 1]} ${start.day}-${end.day}, ${start.year}`;
  } else if (start.year === end.year) {
    range = `${monthDay(start)}-${monthDay(end)}, ${start.year}`;
  } else {
    range = `${monthDay(start)}, ${start.year}-${monthDay(end)}, ${end.year}`;
  }

  return `Your Week in Congress | ${range}`;
}

export function latestPublishedWindow(relativeTo: Date): WeeklyDigestPublicationWindow {
  const today = getLocalDateParts(relativeTo);
  const weekday = dayOfWeek(today);
  const currentSunday = addDaysToParts(today, -weekday);
  const currentSundayRelease = localToUtc({
    ...currentSunday,
    hour: WEEKLY_DIGEST_RELEASE_HOUR,
    minute: WEEKLY_DIGEST_RELEASE_MINUTE,
    second: 0,
    millisecond: 0,
  });

  const releaseSunday =
    relativeTo.getTime() >= currentSundayRelease.getTime() ? currentSunday : addDaysToParts(currentSunday, -7);

  const releaseAt = localToUtc({
    ...releaseSunday,
    hour: WEEKLY_DIGEST_RELEASE_HOUR,
    minute: WEEKLY_DIGEST_RELEASE_MINUTE,
    second: 0,
    millisecond: 0,
  });

  const endParts = addDaysToParts(releaseSunday, -1);
  const startParts = addDaysToParts(releaseSunday, -7);

  const start = localToUtc({
    ...startParts,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  const end = localToUtc({
    ...endParts,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });

  return {
    id: releaseAt.toISOString(),
    start,
    end,
    releaseAt,
  };
}
