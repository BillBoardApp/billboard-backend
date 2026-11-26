// A calendar day as the contracts' `"format": "date"` fields carry it (YYYY-MM-DD). This module imports nothing, so
// any module can use it.

const DAY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The leading YYYY-MM-DD of `value` (a congress.gov date, or a timestamp's date part) when it is a real calendar day,
 * else null: "2026-02-30", "2026-3-5", "March 5, 2026", a non-string and "" are not.
 */
export const calendarDay = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = DAY_PREFIX.exec(value.trim());
  if (!match) return null;
  const [day, year, month, date] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(date)));
  // Date.UTC rolls an impossible day over into the next month (and maps years 0-99 to 1900-1999), so a round trip
  // through the parts tells a real day.
  return parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(date)
    ? day
    : null;
};
