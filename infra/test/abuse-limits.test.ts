import * as fs from 'node:fs';
import * as path from 'node:path';
import * as abuseLimits from '../lib/config/abuse-limits';

/*
 * The one pin of every anti-abuse value in lib/config/abuse-limits.ts. Every stack reads the values from that module
 * and every other test compares with the module, so a copy of the repository that carries its own values changes
 * this test with it and nothing else. The switches' flip tests (user-api-service.test.ts) start from the positions
 * pinned here.
 */

describe('lib/config/abuse-limits.ts', () => {
  test('holds the values production runs with', () => {
    expect({ ...abuseLimits }).toEqual({
      APP_ATTEST_RESERVED_CONCURRENCY: 5,
      APP_ATTEST_CHALLENGE_THROTTLE: { rateLimit: 10, burstLimit: 3 },
      APP_ATTEST_ATTEST_THROTTLE: { rateLimit: 2, burstLimit: 2 },
      APP_ATTEST_VOTE_MODE: 'watch',
      APP_ATTEST_SIGN_UP_MODE: 'watch',
      DEVICE_CHECK_MODE: 'off',
      APP_ATTEST_CLIENT_MODE: 'on',
      APP_ATTEST_FAIL_CLOSED: false,
      APP_ATTEST_ALLOWED_ENVIRONMENTS: 'production',
      APP_ATTEST_MAX_ACCOUNTS_PER_KEY: 3,
      DEVICE_MAX_ACCOUNTS: 3,
      DEVICE_COUNTER_WINDOW_MONTHS: 12,
      APP_ATTEST_CHALLENGE_TTL_SECONDS: 300,
      MIN_APP_VERSION: '',
      APP_ATTEST_EXEMPT_GROUP: 'AppAttestExempt',
      VOTE_DAILY_CAP_MODE: 'watch',
      VERIFICATION_LIMITS_MODE: 'watch',
      VOTE_RESTAMP_MODE: 'plan',
      SIGNUP_FILTER_MODE: 'watch',
      SIGNUP_RATE_LIMIT_ACTION: 'count',
      PRE_SIGN_UP_TRIGGER_ENABLED: true,
      SIGNUP_FILTER_CHECK_ENABLED: 'true',
      SIGNUP_FILTER_CHECK_ADDRESS: 'signup-check@billboard-project.com',
      UNCONFIRMED_SIGNUP_CLEANUP_MODE: 'delete',
      UNCONFIRMED_SIGNUP_MAX_AGE_HOURS: 48,
      UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN: 50,
      USER_API_RATE_LIMIT_PER_5_MINUTES: 2000,
      COGNITO_SIGN_UP_RATE_LIMIT: 10,
      COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS: 600,
      SHARE_SITE_RATE_LIMIT_PER_5_MINUTES: 2000,
      USER_API_STAGE_THROTTLE: { rateLimit: 50, burstLimit: 100 },
      SHARE_PUBLIC_USAGE_PLAN_THROTTLE: { rateLimit: 25, burstLimit: 50 },
      ACCOUNT_INTEGRITY_ALARM_THRESHOLDS: {
        voteDailyCapExceeded: { threshold: 1, periodMinutes: 60 },
        voteVelocity: { threshold: 300, periodMinutes: 10 },
        addressVerificationBurst: { threshold: 10, periodMinutes: 60 },
        addressCapSignal: { threshold: 1, periodMinutes: 60 },
      },
      APP_ATTEST_ALARM_THRESHOLDS: { invalid: 5, errors: 3, rejected: 3, challengeFlood: 1000 },
      VOTE_DAILY_LIMIT: 200,
      VOTE_DAILY_CAP_ENFORCE_READY_MAX: 150,
      MAX_VERIFIED_ACCOUNTS_PER_ADDRESS: 4,
      MAX_ADDRESS_CHANGES_PER_WINDOW: 3,
      ADDRESS_CHANGE_WINDOW_DAYS: 30,
      STREET_CLUSTER_FLAG_THRESHOLD: 10,
    });
  });

  // The services enforce these limits themselves; this file's copies only feed the alarm descriptions.
  test('the mirrored services limits match services/src/shared/abuseLimits.ts', () => {
    const services = fs.readFileSync(
      path.join(__dirname, '..', '..', 'services', 'src', 'shared', 'abuseLimits.ts'),
      'utf8',
    );
    const declared = (name: string): string | undefined =>
      new RegExp(`export const ${name} = ([^;]+);`).exec(services)?.[1];
    expect({
      VOTE_DAILY_LIMIT: declared('VOTE_DAILY_LIMIT'),
      MAX_VERIFIED_ACCOUNTS_PER_ADDRESS: declared('MAX_VERIFIED_ACCOUNTS_PER_ADDRESS'),
      MAX_ADDRESS_CHANGES_PER_WINDOW: declared('MAX_ADDRESS_CHANGES_PER_WINDOW'),
      ADDRESS_CHANGE_WINDOW_MS: declared('ADDRESS_CHANGE_WINDOW_MS'),
      STREET_CLUSTER_FLAG_THRESHOLD: declared('STREET_CLUSTER_FLAG_THRESHOLD'),
      UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS: declared('UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS'),
      UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN: declared('UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN'),
    }).toEqual({
      VOTE_DAILY_LIMIT: String(abuseLimits.VOTE_DAILY_LIMIT),
      MAX_VERIFIED_ACCOUNTS_PER_ADDRESS: String(abuseLimits.MAX_VERIFIED_ACCOUNTS_PER_ADDRESS),
      MAX_ADDRESS_CHANGES_PER_WINDOW: String(abuseLimits.MAX_ADDRESS_CHANGES_PER_WINDOW),
      ADDRESS_CHANGE_WINDOW_MS: `${abuseLimits.ADDRESS_CHANGE_WINDOW_DAYS} * 24 * 60 * 60 * 1000`,
      STREET_CLUSTER_FLAG_THRESHOLD: String(abuseLimits.STREET_CLUSTER_FLAG_THRESHOLD),
      // The services' defaults for the variables this file sets on CleanupOrphanedUsers.
      UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS: String(abuseLimits.UNCONFIRMED_SIGNUP_MAX_AGE_HOURS),
      UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN: String(abuseLimits.UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN),
    });
  });

  test("the services' App Attest defaults match the values this file sets", () => {
    const services = fs.readFileSync(
      path.join(__dirname, '..', '..', 'services', 'src', 'shared', 'abuseLimits.ts'),
      'utf8',
    );
    const defaults = /export const APP_ATTEST_DEFAULTS = \{([^}]*)\}/.exec(services)?.[1] ?? '';
    expect(defaults).toContain(`challengeTtlSeconds: ${abuseLimits.APP_ATTEST_CHALLENGE_TTL_SECONDS},`);
    expect(defaults).toContain(`maxAccountsPerKey: ${abuseLimits.APP_ATTEST_MAX_ACCOUNTS_PER_KEY},`);
    expect(defaults).toContain(`deviceMaxAccounts: ${abuseLimits.DEVICE_MAX_ACCOUNTS},`);
    expect(defaults).toContain(`deviceCounterWindowMonths: ${abuseLimits.DEVICE_COUNTER_WINDOW_MONTHS},`);
    expect(defaults).toContain(`exemptGroup: "${abuseLimits.APP_ATTEST_EXEMPT_GROUP}",`);
  });

  // A security ceiling: the two public App Attest routes (no authorizer, no API key) keep their own stage throttles at
  // or below these, whatever the values above become. security.test.ts checks that the template carries these
  // constants.
  test('keeps the App Attest route throttles within their security ceiling', () => {
    [abuseLimits.APP_ATTEST_CHALLENGE_THROTTLE, abuseLimits.APP_ATTEST_ATTEST_THROTTLE].forEach((throttle) => {
      expect(throttle.rateLimit).toBeLessThanOrEqual(10);
      expect(throttle.burstLimit).toBeLessThanOrEqual(3);
    });
  });

  test('keeps the alarm windows whole minutes the descriptions can state', () => {
    Object.values(abuseLimits.ACCOUNT_INTEGRITY_ALARM_THRESHOLDS).forEach(({ periodMinutes }) => {
      expect(Number.isInteger(periodMinutes) && periodMinutes > 0).toBe(true);
    });
  });
});
