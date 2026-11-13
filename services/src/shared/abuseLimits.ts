/**
 * Anti-abuse values the services hold themselves: the limits the code applies on its own, and the defaults it
 * falls back to when infra sets no variable. Infra sends the switches, the App Attest limits and the cleanup's
 * limits to each function as environment variables (infra/lib/config/abuse-limits.ts); the defaults here match
 * those values, so a function reads the same limit with or without its variable.
 *
 * They live here, and only here, so that a copy of this repository can carry its own values: the modules that
 * use them (voteDailyCap, addressClaims, appAttest/config, signUpFilter, cleanupOrphanedUsers) import them from
 * this file and re-export them where they always have, every test reads them from there, and
 * src/tests/abuseLimits.test.ts is the one place that pins them.
 */

// ─── INT-06: the daily vote cap (C2 3.2) ─────────────────────────────────────

/** Vote writes per account per UTC day. */
export const VOTE_DAILY_LIMIT = 200;

// ─── INT-03: verification limits (decision 3A) ───────────────────────────────

/** Verified accounts per address (matched address and unit). */
export const MAX_VERIFIED_ACCOUNTS_PER_ADDRESS = 4;
/** Changes to a new verified address per account in ADDRESS_CHANGE_WINDOW_MS. */
export const MAX_ADDRESS_CHANGES_PER_WINDOW = 3;
export const ADDRESS_CHANGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** `StreetClusterFlagged` is emitted when a street address holds more active claims than this. */
export const STREET_CLUSTER_FLAG_THRESHOLD = 10;

// ─── INT-04: App Attest (C3 3.1) ─────────────────────────────────────────────

/** What appAttestConfigFromEnv uses when a variable is unset or out of range. */
export const APP_ATTEST_DEFAULTS = {
  challengeTtlSeconds: 300,
  maxAccountsPerKey: 3,
  deviceMaxAccounts: 3,
  deviceCounterWindowMonths: 12,
  exemptGroup: "AppAttestExempt",
} as const;

/** Attested keys expire this long after their last use. */
export const APP_ATTEST_KEY_TTL_SECONDS = 400 * 24 * 60 * 60;
/** Bindings of an account to a key expire this long after their last use. */
export const APP_ATTEST_BINDING_TTL_SECONDS = 400 * 24 * 60 * 60;

// ─── INT-05: the sign-up filter's email claims (integration plan X5) ─────────

/** An UNCONFIRMED account older than this no longer holds its base address (an abandoned sign-up). */
export const UNCONFIRMED_CLAIM_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * A claim written this recently may belong to a sign-up still in progress: the trigger runs before
 * Cognito creates the user, so AdminGetUser cannot find its holder yet. Far above Cognito's 5 s
 * trigger time plus user creation.
 */
export const PENDING_CLAIM_WINDOW_MS = 5 * 60 * 1000;

// ─── REL-53: sign-ups left unconfirmed (CleanupOrphanedUsers) ───────────────

/** UNCONFIRMED_SIGNUP_MAX_AGE_HOURS when unset: a sign-up UNCONFIRMED longer than this is deleted. */
export const UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS = 48;
/** UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN when unset: deletions (dry run: candidates) per run. */
export const UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN = 50;
