import { backoffDelayMs, isRetryableStatus, parseRetryAfterMs, retryDelayMs, sleep } from "../shared/retry";

describe("sleep", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves after the given delay", async () => {
    jest.useFakeTimers();
    let resolved = false;
    const pending = sleep(1000).then(() => {
      resolved = true;
    });

    await jest.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it.each([0, -50, Number.NaN])("resolves promptly for %p", async (ms) => {
    jest.useFakeTimers();
    const pending = sleep(ms);
    await jest.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("backoffDelayMs", () => {
  const options = { baseMs: 500, maxMs: 5000 };

  it("returns 0 at the bottom of the jitter range", () => {
    expect(backoffDelayMs(3, { ...options, random: () => 0 })).toBe(0);
  });

  it("doubles the ceiling on each attempt", () => {
    const top = () => 0.999999;
    expect(backoffDelayMs(0, { ...options, random: top })).toBe(500);
    expect(backoffDelayMs(1, { ...options, random: top })).toBe(1000);
    expect(backoffDelayMs(2, { ...options, random: top })).toBe(2000);
    expect(backoffDelayMs(3, { ...options, random: top })).toBe(4000);
  });

  it("caps the ceiling at maxMs, including for very large attempts", () => {
    const top = () => 0.999999;
    expect(backoffDelayMs(4, { ...options, random: top })).toBe(5000);
    expect(backoffDelayMs(2000, { ...options, random: top })).toBe(5000);
  });

  it("scales linearly with the random draw (full jitter)", () => {
    expect(backoffDelayMs(1, { ...options, random: () => 0.5 })).toBe(500);
  });

  it("treats negative, NaN and fractional attempts sensibly", () => {
    const top = () => 0.999999;
    expect(backoffDelayMs(-3, { ...options, random: top })).toBe(500);
    expect(backoffDelayMs(Number.NaN, { ...options, random: top })).toBe(500);
    expect(backoffDelayMs(1.9, { ...options, random: top })).toBe(1000);
  });

  it("returns 0 for non-positive or non-finite ceilings", () => {
    expect(backoffDelayMs(2, { baseMs: 0, maxMs: 5000 })).toBe(0);
    expect(backoffDelayMs(2, { baseMs: 500, maxMs: 0 })).toBe(0);
    expect(backoffDelayMs(2, { baseMs: Number.NaN, maxMs: 5000 })).toBe(0);
  });

  it("always stays within [0, min(maxMs, baseMs * 2^attempt)] using Math.random", () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
      for (let i = 0; i < 200; i += 1) {
        const delay = backoffDelayMs(attempt, options);
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");

  it.each([
    ["3", 3000],
    [" 2 ", 2000],
    [["4", "9"], 4000],
    [7, 7000],
  ])("parses delta-seconds %p", (value, expected) => {
    expect(parseRetryAfterMs(value, now)).toBe(expected);
  });

  it("parses an HTTP-date in the future", () => {
    expect(parseRetryAfterMs("Thu, 24 Sep 2026 12:00:30 GMT", now)).toBe(30_000);
  });

  it.each([undefined, null, "", "   ", "0", "-1", "soon", 0, -5, Number.NaN, "Thu, 24 Sep 2026 11:59:00 GMT", []])(
    "returns null for %p",
    (value) => {
      expect(parseRetryAfterMs(value, now)).toBeNull();
    },
  );
});

describe("retryDelayMs", () => {
  const options = { baseMs: 500, maxMs: 5000, random: () => 0.999999 };

  it("uses Retry-After when present", () => {
    expect(retryDelayMs(0, options, "2")).toBe(2000);
  });

  it("caps Retry-After at maxMs", () => {
    expect(retryDelayMs(0, options, "120")).toBe(5000);
  });

  it("falls back to jittered backoff without a usable header", () => {
    expect(retryDelayMs(2, options)).toBe(2000);
    expect(retryDelayMs(2, options, null)).toBe(2000);
    expect(retryDelayMs(2, options, "garbage")).toBe(2000);
  });
});

describe("isRetryableStatus", () => {
  it.each([429, 500, 502, 503, 504, 599])("returns true for %p", (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([0, 200, 204, 301, 400, 401, 403, 404, 408, 422, 600])("returns false for %p", (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});
