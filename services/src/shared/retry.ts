export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, Number.isFinite(ms) ? ms : 0)));

interface BackoffOptions {
  /** Delay ceiling for attempt 0; doubles on each later attempt. */
  baseMs: number;
  /** Hard cap on any single delay. Must be finite. */
  maxMs: number;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * Exponential backoff with full jitter: a uniformly random whole number of
 * milliseconds in [0, min(maxMs, baseMs * 2^attempt)]. `attempt` is 0-based.
 */
export const backoffDelayMs = (attempt: number, { baseMs, maxMs, random = Math.random }: BackoffOptions): number => {
  const exponent = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return 0;
  return Math.floor(random() * (Math.floor(ceiling) + 1));
};

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns null when the header is absent, unparseable, or not in the future,
 * so callers fall back to backoffDelayMs.
 */
export const parseRetryAfterMs = (value: unknown, nowMs: number = Date.now()): number | null => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw * 1000 : null;
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds > 0 ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - nowMs;
  return delta > 0 ? delta : null;
};

/**
 * Delay before retry `attempt` (0-based): honours Retry-After when present,
 * otherwise full-jitter backoff; never exceeds maxMs.
 */
export const retryDelayMs = (attempt: number, options: BackoffOptions, retryAfter?: unknown): number => {
  const fromHeader = parseRetryAfterMs(retryAfter);
  if (fromHeader !== null) return Math.max(0, Math.min(fromHeader, options.maxMs));
  return backoffDelayMs(attempt, options);
};

/** True for 429 (throttled) and any 5xx. */
export const isRetryableStatus = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);
