import * as abuseLimits from "../shared/abuseLimits";

/*
 * The one pin of every anti-abuse value the services hold (shared/abuseLimits.ts). Every other test reads the
 * values from that module, so a copy of the repository that carries its own values changes this test with it and
 * nothing else.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("shared/abuseLimits.ts", () => {
  it("holds the values the services run with", () => {
    expect({ ...abuseLimits }).toEqual({
      VOTE_DAILY_LIMIT: 200,
      MAX_VERIFIED_ACCOUNTS_PER_ADDRESS: 4,
      MAX_ADDRESS_CHANGES_PER_WINDOW: 3,
      ADDRESS_CHANGE_WINDOW_MS: 30 * DAY_MS,
      STREET_CLUSTER_FLAG_THRESHOLD: 10,
      APP_ATTEST_DEFAULTS: {
        challengeTtlSeconds: 300,
        maxAccountsPerKey: 3,
        deviceMaxAccounts: 3,
        deviceCounterWindowMonths: 12,
        exemptGroup: "AppAttestExempt",
      },
      APP_ATTEST_KEY_TTL_SECONDS: 400 * 24 * 60 * 60,
      APP_ATTEST_BINDING_TTL_SECONDS: 400 * 24 * 60 * 60,
      UNCONFIRMED_CLAIM_LIFETIME_MS: 24 * HOUR_MS,
      PENDING_CLAIM_WINDOW_MS: 5 * 60 * 1000,
      UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS: 48,
      UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN: 50,
    });
  });

  it("keeps every value inside what the code and the other tests assume", () => {
    // Two DeviceCheck bits hold 0 to 3; appAttestConfigFromEnv accepts 1 to 3.
    expect(abuseLimits.APP_ATTEST_DEFAULTS.deviceMaxAccounts).toBeGreaterThanOrEqual(1);
    expect(abuseLimits.APP_ATTEST_DEFAULTS.deviceMaxAccounts).toBeLessThanOrEqual(3);
    // A confirmation code lives 24 hours; the cleanup never deletes a sign-up younger than that.
    expect(abuseLimits.UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS).toBeGreaterThanOrEqual(24);
    // The tests build their cases around these: two stale accounts in a full unit, a change log with room for one
    // change older than ten days, and a key with room for one more account.
    expect(abuseLimits.MAX_VERIFIED_ACCOUNTS_PER_ADDRESS).toBeGreaterThanOrEqual(3);
    expect(abuseLimits.MAX_ADDRESS_CHANGES_PER_WINDOW).toBeGreaterThanOrEqual(2);
    expect(abuseLimits.ADDRESS_CHANGE_WINDOW_MS).toBeGreaterThan(11 * DAY_MS);
    expect(abuseLimits.APP_ATTEST_DEFAULTS.maxAccountsPerKey).toBeGreaterThanOrEqual(2);
  });
});
