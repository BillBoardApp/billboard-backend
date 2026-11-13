/**
 * Parses an optional reserved-concurrency override from an environment
 * variable. Unset or empty means "no reservation"; anything else must be an
 * integer >= 1 so a typo fails synth instead of silently reserving 0.
 */
export const parseOptionalReservedConcurrency = (
  value: string | undefined,
  variableName: string
): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw new Error(
      `${variableName} must be an integer >= 1 when provided (received: ${value})`
    );
  }
  return parsed;
};

/**
 * Parses a reserved-concurrency setting that reserves by default. Unset or
 * empty (a GitHub Actions variable that is not defined expands to "") means
 * `defaultValue`; "off" in any case means no reservation; anything else must
 * be a whole number >= 1, so a typo fails synth instead of silently changing
 * the reservation.
 */
export const parseReservedConcurrencyWithDefault = (
  value: string | undefined,
  variableName: string,
  defaultValue: number
): number | undefined => {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    return defaultValue;
  }
  if (trimmed.toLowerCase() === 'off') {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) < 1) {
    throw new Error(
      `${variableName} must be "off" or an integer >= 1 when provided (received: ${value})`
    );
  }
  return Number.parseInt(trimmed, 10);
};
