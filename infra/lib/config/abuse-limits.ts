// Anti-abuse values: every limit, throttle, detection threshold, mode switch and name that decides how hard the
// abuse defences push back and what they let through. They live here, and only here, so that a copy of this
// repository can carry its own values: every stack and every test reads them from this module, and
// test/abuse-limits.test.ts is the one place that pins them.
//
// A switch flip is a one-line change here plus a deploy; setting it back and deploying again is the rollback, and
// nothing in the data needs undoing. The App Attest modes and the four account-integrity modes reach their
// functions when the release workflow's CodeDeploy step moves each prod alias to the version carrying the new
// value (10% for 10 minutes for the API handlers and PreSignUpCheck, at once for RestampUserVotes); the web ACL
// action and the PreSignUp trigger change with the CloudFormation update itself. The services parse every value
// leniently and never throw at load: an unrecognised mode means watch (or plan), never enforce, and an unset App
// Attest table name turns that whole feature off (services/src/shared/appAttest/config.ts). docs/RUNBOOK.md has
// each flip's condition.
//
// Some services-side limits are mirrored at the end of this file, for the alarm descriptions that state them.

import type { AppAttestMode, MethodThrottle } from './app-attest-constants';

// ── App Attest (INT-04, decision 8A; C3 3.1 with the integration plan's section 6) ───────────────

// The AppAttest function serves the public POST /app-attest/challenge and /app-attest/attest routes (no
// authorizer, no API key): sign-up and first-launch attestation happen signed out. A flood is held by the WAF's
// per-IP rule and the routes' own stage throttles below (429), and this reserved concurrency keeps it from taking
// concurrency from another function (account limit 400, all unreserved before the account-integrity switches).
export const APP_ATTEST_RESERVED_CONCURRENCY = 5;

// The two routes' own throttles on the prod stage, for all callers together, so a call over them gets 429 from
// API Gateway before it reaches the function. The reserved concurrency alone does not give a 429: API Gateway
// answers a Lambda throttle with a 500, and an anonymous burst could then fire Billboard-API-5XXError (the
// Billboard-Page-AppBroken page) and the API deployment groups' 5XX rollback alarm. The bursts add up to the
// reserved concurrency, and the summed rates times a slow call (400 ms) stay under it. Far above today's traffic
// (one challenge per R2 vote or sign-up, one attestation per install); raise them with the concurrency if R2
// outgrows them, because under enforce a refused challenge becomes a blocked vote (v1.e.challenge).
export const APP_ATTEST_CHALLENGE_THROTTLE: MethodThrottle = { rateLimit: 10, burstLimit: 3 };
export const APP_ATTEST_ATTEST_THROTTLE: MethodThrottle = { rateLimit: 2, burstLimit: 2 };

/** SetFeedback's APP_ATTEST_MODE (POST /feedback). An enforce flip comes after sign-up's, once C3 8.4 step 2 holds
 * (R2 on the App Store 30 days, 95% of votes `valid`, the canary and UI smoke users in APP_ATTEST_EXEMPT_GROUP). */
export const APP_ATTEST_VOTE_MODE: AppAttestMode = 'watch';

/** PreSignUpCheck's APP_ATTEST_MODE (self-service sign-ups). The first to flip to enforce (C3 8.4 step 1). Under
 * watch the sign-up check never throws: INT-05's email checks keep deciding alone. */
export const APP_ATTEST_SIGN_UP_MODE: AppAttestMode = 'watch';

/** PreSignUpCheck's DEVICE_CHECK_MODE. off until the project has created the DeviceCheck key and the secret
 * DEVICE_CHECK_SECRET_NAME (C3 step 2); then watch, and enforce only after sign-up App Attest enforces.
 * off makes no Apple call and never reads the secret. */
export const DEVICE_CHECK_MODE: AppAttestMode = 'off';

/** The AppAttest function's APP_ATTEST_CLIENT_MODE: R2's kill switch. off answers every challenge request
 * {"clientMode": "off"} and refuses attestations, writing nothing, and R2 stops attesting and asserting for 6
 * hours (its votes and sign-ups then carry a marker, allowed under watch). */
export const APP_ATTEST_CLIENT_MODE: 'on' | 'off' = 'on';

/** APP_ATTEST_FAIL_CLOSED (SetFeedback, PreSignUpCheck): under enforce, whether an infrastructure error
 * (DynamoDB, a timeout, a bug) blocks the request (true) or lets it through with an alarm (false; C3 Q1). It
 * has no effect under watch. */
export const APP_ATTEST_FAIL_CLOSED: boolean = false;

/** Key environments a request may assert from under enforce: development-signed builds attest in Apple's
 * sandbox and pass only when this lists `development` (or the caller is exempt; C3 Q7). */
export const APP_ATTEST_ALLOWED_ENVIRONMENTS: 'production' | 'production,development' = 'production';
/** Accounts that may vote through one install's key, and sign-ups one key may assert (accountCount,
 * signupCount). Counted in both modes; enforced only under enforce. */
export const APP_ATTEST_MAX_ACCOUNTS_PER_KEY = 3;
/** DeviceCheck: sign-ups per physical device in the counter window (two bits hold 0 to 3). */
export const DEVICE_MAX_ACCOUNTS: 1 | 2 | 3 = 3;
/** DeviceCheck: a device's counter older than this many months reads as 0 (C3 Q2). */
export const DEVICE_COUNTER_WINDOW_MONTHS = 12;
/** The challenge lifetime, in seconds (the row is deleted by TTL an hour after that). */
export const APP_ATTEST_CHALLENGE_TTL_SECONDS = 300;

/** MIN_APP_VERSION (SetFeedback, PreSignUpCheck): under enforce, R2 builds below this dotted version get 426
 * APP_UPDATE_REQUIRED. Empty: no minimum, and the variable is left out of both functions (unset and empty mean
 * the same to the handlers). Synth fails on anything that is not one to three dot-separated numbers. */
export const MIN_APP_VERSION: string = '';

/** The Cognito group whose members' votes are never blocked (their outcomes are still recorded; C3 3.7, D9).
 * Created empty; the project adds the canary and UI smoke users before any vote enforcement. */
export const APP_ATTEST_EXEMPT_GROUP = 'AppAttestExempt';

// ── Account integrity switches (integration plan section 6) ──────────────────────────────────────
// Each ships in its safe position.

/** INT-06 (SetFeedback): 'watch' counts writes over VOTE_DAILY_LIMIT a UTC day and emits VoteDailyCapExceeded
 * but writes every vote; 'enforce' answers 429 VOTE_DAILY_LIMIT. Flip when no account went above
 * VOTE_DAILY_CAP_ENFORCE_READY_MAX writes on any day. */
export const VOTE_DAILY_CAP_MODE: 'watch' | 'enforce' = 'watch';

/** INT-03 (DistrictVerification): 'watch' writes the address claims and counters exactly as enforce does
 * but never caps an account and never answers 429; 'enforce' caps the verified account after
 * MAX_VERIFIED_ACCOUNTS_PER_ADDRESS at one address (self-attested, address_capped) and refuses an address change
 * after MAX_ADDRESS_CHANGES_PER_WINDOW in ADDRESS_CHANGE_WINDOW_DAYS. */
export const VERIFICATION_LIMITS_MODE: 'watch' | 'enforce' = 'watch';

/** INT-03 re-stamp (RestampUserVotes, X8): 'plan' reads an account's votes and logs the rows it would
 * change (VotesRestampPlanned) without writing; 'apply' rewrites their verification stamp. DistrictVerification
 * enqueues in both modes. Flip no later than, and in the same PR as, VERIFICATION_LIMITS_MODE='enforce'. */
export const VOTE_RESTAMP_MODE: 'plan' | 'apply' = 'plan';

/** INT-05 (PreSignUpCheck): 'watch' lets every sign-up through and emits SignUpFilterHit on a disposable
 * domain or a second account on one base address; 'enforce' refuses them. Claims are written in both. */
export const SIGNUP_FILTER_MODE: 'watch' | 'enforce' = 'watch';

/** 7B (the user API web ACL's CognitoSignUpRateLimit rule): 'count' only counts an IP's SignUp,
 * ResendConfirmationCode or ForgotPassword calls over COGNITO_SIGN_UP_RATE_LIMIT in its window; 'block' refuses
 * them (Cognito answers 403 ForbiddenException). Flip when the counted requests came only from the test sign-ups. */
export const SIGNUP_RATE_LIMIT_ACTION: 'count' | 'block' = 'count';

/** INT-05 kill switch: true attaches PreSignUpCheck to the user pool as its PreSignUp trigger. false detaches
 * it (the pool's template loses its LambdaConfig, exactly as U9 left it, and sign-ups run without the filter)
 * and leaves the function in place; use it only if the function itself breaks sign-up. Takes effect when
 * UserAPIServiceStack deploys, with no CodeDeploy step. */
export const PRE_SIGN_UP_TRIGGER_ENABLED: boolean = true;

// ── SignUpFilterCheck (CB-07) ─────────────────────────────────────────────────────────────────────
// A daily check that proves the sign-up filter in production (docs/RUNBOOK.md 14.12): it signs up
// SIGNUP_FILTER_CHECK_ADDRESS and a +tag of it through the app's public Cognito SignUp, expects PreSignUpCheck to
// allow and claim the first and record a hit for the second (watch) or refuse it (enforce), and deletes both
// accounts and their claim items. Two Cognito verification emails a run under watch (one under enforce).

/** The switch. 'false': each run emits SignUpFilterCheckDisabled and does nothing else, before any AWS call.
 * 'true' only once the project has created SIGNUP_FILTER_CHECK_ADDRESS as a mailbox and checked that plus
 * addressing reaches it; then deploy UserAPIServiceStack (only the SignUpFilterCheck worker changes) and invoke
 * SignUpFilterCheck:prod once by hand. Rollback: 'false' and deploy. It must be 'false' while
 * APP_ATTEST_SIGN_UP_MODE or DEVICE_CHECK_MODE is 'enforce' (app-wide-invariants.test.ts): the check's sign-ups are
 * unattested, like an old build's. */
export const SIGNUP_FILTER_CHECK_ENABLED: 'true' | 'false' = 'true';

/** The check address. PreSignUpCheck gets the same value and labels the sign-ups whose base address it is as
 * probes (SignUpProbeHit instead of SignUpFilterHit, and a PROBE# record). Lower case, no '+', and on the
 * project's own email domain (EMAIL_DOMAIN), whose mailboxes the project controls: both functions refuse any other
 * value at run time. */
export const SIGNUP_FILTER_CHECK_ADDRESS = 'signup-check@billboard-project.com';

// ── CleanupOrphanedUsers: sign-ups left unconfirmed (REL-53) ──────────────────────────────────────

/** The switch, independent of the cleanup's DRY_RUN. 'off' is the kill switch (no call at all); 'dry_run' lists and
 * counts what it would delete and writes nothing; 'delete' deletes. The Cognito AdminDeleteUser and SignUpEmailClaims
 * DeleteItem grants come only with 'delete' (the role is shared with the D3 resume path, which DRY_RUN then holds
 * alone). 'delete' after 14 daily dry-run reports (RUNBOOK 8.2); it must stay 'delete' while SIGNUP_FILTER_MODE is
 * 'enforce' (UA-29, app-wide-invariants.test.ts). Rollback: 'off' (or 'dry_run') and deploy. The handler reads any
 * other value as off. */
export const UNCONFIRMED_SIGNUP_CLEANUP_MODE: 'off' | 'dry_run' | 'delete' = 'delete';

/** A sign-up UNCONFIRMED longer than this is deleted. The handler refuses less than 24 (a code's lifetime). */
export const UNCONFIRMED_SIGNUP_MAX_AGE_HOURS = 48;

/** At most this many deletions a run, oldest first; more emit UnconfirmedSignUpCleanupCapReached=1 and wait for the
 * next daily run. Raise it if real sign-ups outgrow it (the metric says so). */
export const UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN = 50;

// ── Rate limits: the web ACLs and API Gateway throttles ──────────────────────────────────────────

/** The user API web ACL's rule 0 (7B: SEC-02, CAP-10): every request per IP, API and Cognito alike, blocked above
 * this many in WAF's default 5-minute window. */
export const USER_API_RATE_LIMIT_PER_5_MINUTES = 2000;
/** The user API web ACL's rule 1: Cognito's mail-sending calls per IP in COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS.
 * Each sends an email from Cognito's own mailer, whose small daily quota a script could otherwise exhaust for
 * everyone. WAF allows no limit below 10. */
export const COGNITO_SIGN_UP_RATE_LIMIT = 10;
export const COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS = 600;

/** The share site's web ACL rate rule: requests per IP in WAF's default 5-minute window. */
export const SHARE_SITE_RATE_LIMIT_PER_5_MINUTES = 2000;

/** The user API prod stage's stage-wide throttle (every method without its own), for all callers together. */
export const USER_API_STAGE_THROTTLE: MethodThrottle = { rateLimit: 50, burstLimit: 100 };

/** The share site origin's usage plan throttle on the public processed-bill route (its API key). */
export const SHARE_PUBLIC_USAGE_PLAN_THROTTLE: MethodThrottle = { rateLimit: 25, burstLimit: 50 };

// ── Detection thresholds (MonitoringStack) ───────────────────────────────────────────────────────

/** A detection alarm: it fires at `threshold` or more in one `periodMinutes` window. */
export interface DetectionThreshold {
  readonly threshold: number;
  readonly periodMinutes: number;
}

/** The account-integrity alarms (C2 3.11) on SetFeedback's, DistrictVerification's and PreSignUpCheck's
 * BillBoard/AccountIntegrity metrics. */
export const ACCOUNT_INTEGRITY_ALARM_THRESHOLDS = {
  /** Billboard-Integrity-VoteDailyCapExceeded: accounts over VOTE_DAILY_LIMIT. */
  voteDailyCapExceeded: { threshold: 1, periodMinutes: 60 },
  /** Billboard-Integrity-VoteVelocity: votes written across all accounts. */
  voteVelocity: { threshold: 300, periodMinutes: 10 },
  /** Billboard-Integrity-AddressVerificationBurst: successful address verifications. */
  addressVerificationBurst: { threshold: 10, periodMinutes: 60 },
  /** Billboard-Integrity-AddressCapSignal: the three INT-03 limit signals together. */
  addressCapSignal: { threshold: 1, periodMinutes: 60 },
} as const satisfies Record<string, DetectionThreshold>;

/** The App Attest alarms (C3 3.11) on the BillBoard/AppAttest metrics, each summed per hour. */
export const APP_ATTEST_ALARM_THRESHOLDS = {
  /** Billboard-AppAttest-Invalid (AppAttestInvalid). */
  invalid: 5,
  /** Billboard-AppAttest-Errors (AppAttestErrors). */
  errors: 3,
  /** Billboard-AppAttest-Rejected (AppAttestRejected). */
  rejected: 3,
  /** Billboard-AppAttest-ChallengeFlood (AppAttestChallenges). */
  challengeFlood: 1000,
} as const;

// ── Services-side limits, mirrored for the alarm descriptions ────────────────────────────────────
// The services enforce these themselves (services/src/shared/abuseLimits.ts); infra cannot import that file, so
// these copies only feed the alarm text and must match it.

/** VOTE_DAILY_LIMIT: vote writes per account per UTC day (INT-06). */
export const VOTE_DAILY_LIMIT = 200;
/** The watch-week ceiling VOTE_DAILY_CAP_MODE's flip waits for: no account above this many writes on any day. */
export const VOTE_DAILY_CAP_ENFORCE_READY_MAX = 150;
/** MAX_VERIFIED_ACCOUNTS_PER_ADDRESS: verified accounts per address and unit (INT-03). */
export const MAX_VERIFIED_ACCOUNTS_PER_ADDRESS = 4;
/** MAX_ADDRESS_CHANGES_PER_WINDOW: changes to a new verified address per account in ADDRESS_CHANGE_WINDOW_DAYS. */
export const MAX_ADDRESS_CHANGES_PER_WINDOW = 3;
/** ADDRESS_CHANGE_WINDOW_MS, in days. */
export const ADDRESS_CHANGE_WINDOW_DAYS = 30;
/** STREET_CLUSTER_FLAG_THRESHOLD: StreetClusterFlagged above this many active claims on one street address. */
export const STREET_CLUSTER_FLAG_THRESHOLD = 10;
