/**
 * Which Census geocoder vintage a district lookup asks for (REL-46).
 *
 * The geocoder's "Current_Current" vintage now serves the 120th Congress lines. Those lines take effect on
 * 2027-01-03 at noon Eastern (17:00 UTC), so until then a lookup asks for "ACS2025_Current", the 119th lines.
 * From then on it asks for "Current_Current".
 *
 * Missouri stays on "ACS2025_Current" at all times: the geocoder's 120th layer holds a 2025 Missouri map that is
 * not in effect, and Missouri keeps its 2022 lines. To revisit: geocode the Missouri Capitol on
 * "Current_Current" now and then. When it gives district 3, remove MO from GEOCODER_PINNED_STATES.
 */
export const GEOCODER_VINTAGE_119TH = "ACS2025_Current";
export const GEOCODER_VINTAGE_CURRENT = "Current_Current";

/** Noon Eastern on 2027-01-03, when the 120th Congress is sworn in. */
export const SWITCH_TO_120TH_AT_MS = Date.parse("2027-01-03T17:00:00Z");

/** States that stay on GEOCODER_VINTAGE_119TH after the switch. */
export const GEOCODER_PINNED_STATES: ReadonlySet<string> = new Set(["MO"]);

export function geocoderVintageFor(state: string, now: Date | number): string {
  if (GEOCODER_PINNED_STATES.has(state)) return GEOCODER_VINTAGE_119TH;
  const nowMs = typeof now === "number" ? now : now.getTime();
  return nowMs < SWITCH_TO_120TH_AT_MS ? GEOCODER_VINTAGE_119TH : GEOCODER_VINTAGE_CURRENT;
}
