// Referenced by UserAPIServiceStack and by MonitoringStack's alarms and dashboard.
export const USER_API_NAME = 'BillboardUserApi';
// Infra review item 15b: the timeout of the API handlers that had none and so ran at Lambda's 3-second
// default (RegisterUserDevice, DeviceNotificationSettings, DeletePreferences, FetchPreferences,
// SetPreferences, FetchFeedback, SetFeedback, FetchProcessedCongressMembers). 10 seconds matches the
// other light API handlers and stays well under API Gateway's 29-second integration limit, so a rare
// slow request (a cold start, an SDK retry under throttling) finishes instead of returning a 502.
export const USER_API_DEFAULT_TIMEOUT_SECONDS = 10;
// Synthetics canary names must match ^[a-z][a-z0-9_-]{0,20}$.
export const USER_API_CANARY_NAME = 'billboard-api';
// UA-04: the canary emits this (BillBoard/ProductHealth, Count, value 1) when its test account cannot sign in, and
// skips the signed-in steps instead of failing the run. MonitoringStack alarms on it (routine only). It must match
// SIGN_IN_FAILED_METRIC in lib/canaries/user-api-canary.js, which cannot import this file; monitoring.test.ts pins it.
export const CANARY_SIGN_IN_FAILED_METRIC_NAME = 'CanarySmokeSignInFailed';
// ExportCognitoUsers writes one object per UTC day under this prefix; it must match EXPORT_PREFIX in
// services/src/handlers/exportCognitoUsers/index.ts.
export const COGNITO_USER_EXPORT_PREFIX = 'cognito-users/';
// UX-36 (WEB-07; project decision O1, 2026-11-12: clear the stored party values and stop new writes). With 'clear', the
// nightly ExportCognitoUsers run deletes custom:politicalParty, gender and birthdate from every user who holds one,
// after writing the export, and only then is it granted cognito-idp:AdminDeleteUserAttributes. 'count' keeps the
// counts in its summary and metrics and deletes nothing (rollback: 'count' and deploy). Apps 1.1 and earlier write
// these straight to Cognito, and the app client stays free to write them, so 1.1's saves keep working
// (services/src/shared/retiredProfileAttributes.ts; docs/RUNBOOK.md 25.2). The handler reads any other value as count.
export const RETIRED_PROFILE_ATTRIBUTES_MODE: 'count' | 'clear' = 'clear';

// CAP-01: PublishBillsManifest writes the full bills manifest to this key as one gzip JSON object, and
// FetchBillsManifest hands clients a presigned URL for it. Both handlers default to the same key.
export const BILLS_MANIFEST_SNAPSHOT_KEY = 'bills/manifest-v1.json';
export const BILLS_MANIFEST_SNAPSHOT_SCHEDULE_EXPRESSION = 'rate(10 minutes)';
// Delivery retries for the schedule stop before the next run is due.
export const BILLS_MANIFEST_SNAPSHOT_SCHEDULE_MAX_EVENT_AGE_SECONDS = 9 * 60;
export const BILLS_MANIFEST_SNAPSHOT_SCHEDULE_MAX_RETRY_ATTEMPTS = 2;
export const PUBLISH_BILLS_MANIFEST_MEMORY_MB = 1024;
export const PUBLISH_BILLS_MANIFEST_TIMEOUT_SECONDS = 120;
export const BILLS_MANIFEST_METRIC_NAMESPACE = 'BillBoard/BillsManifest';
// INT-11: FetchBillStats' results gate (ResultsLocked, ResultsGateReadFailed) and SetFeedback's
// LegacyDismissStored, emitted as embedded-metric log lines (no PutMetricData grant). UX-31: also SetFeedback's
// EarlierVoteReadFailed (a vote not stored because the caller's earlier row on the bill could not be read).
export const BILL_STATS_METRIC_NAMESPACE = 'BillBoard/BillStats';
// UX-31: FetchCivicScore's Civic Score record on UserPII (CivicRecordReadFailed, CivicRecordWriteFailed), also
// embedded-metric log lines. It must match CIVIC_SCORE_METRIC_NAMESPACE in services/src/handlers/fetchCivicScore.
export const CIVIC_SCORE_METRIC_NAMESPACE = 'BillBoard/CivicScore';

// APPF-23 kill switch for companion bills. Only PublishBillsManifest reads it; every other function
// follows the groups row it writes (BillsManifest pk=BILL_COMPANION_GROUPS, sk=CURRENT).
// - 'false': the publisher still resolves the groups and emits CompanionGroupsShadow, but publishes
//   none. Every response carries companionGroups: [], so apps show one card per bill as before.
// - To enable: run the backfill (services: npm run backfill:bill-companions, then with --apply), check
//   that CompanionGroupsShadow is about 373 on the next run, set 'true' and deploy UserAPIServiceStack.
//   The next publish (within 10 minutes) writes the groups.
// - To roll back: set 'false' and deploy UserAPIServiceStack. The next publish writes empty groups,
//   and readers follow within 10 minutes plus their 60-second cache. Votes are never moved, so
//   switching back and forth is safe. docs/RUNBOOK.md has the full steps.
export const COMPANION_GROUPS_ENABLED: 'true' | 'false' = 'true';

// ── Account integrity switches ──────────────────────────────────────────────────────────────────
// VOTE_DAILY_CAP_MODE, VERIFICATION_LIMITS_MODE, VOTE_RESTAMP_MODE, SIGNUP_FILTER_MODE, SIGNUP_RATE_LIMIT_ACTION and
// PRE_SIGN_UP_TRIGGER_ENABLED are anti-abuse values: abuse-limits.ts holds them.

// ── PreSignUpCheck (INT-05, X4) ─────────────────────────────────────────────────────────────────
// Cognito waits at most 5 seconds for a trigger. The handler's own deadline is 3.5 s from the start of the
// invocation, shared by its ordered checks, so a cold start still answers in time; a check that runs out of
// time fails open.
export const PRE_SIGN_UP_CHECK_MEMORY_MB = 256;
export const PRE_SIGN_UP_CHECK_TIMEOUT_SECONDS = 5;
/** The EMF metrics (ACCOUNT_INTEGRITY_METRIC_NAMESPACE, no dimensions) PreSignUpCheck writes, just before it throws,
 * for each sign-up it refuses on purpose under SIGNUP_FILTER_MODE 'enforce': a real one, and the filter check's
 * probe (CB-07). Its prod alias error alarm, which rolls back its CodeDeploy shift, subtracts them from Errors, so a
 * refusal is not a fault of the version being deployed. They must match SIGN_UP_FILTER_METRICS in
 * services/src/handlers/preSignUp/index.ts. */
export const PRE_SIGN_UP_CHECK_INTENTIONAL_ERROR_METRICS = ['SignUpRejected', 'SignUpProbeRejected'] as const;

// ── SignUpFilterCheck (CB-07) ───────────────────────────────────────────────────────────────────
// A daily check that proves the sign-up filter in production (docs/RUNBOOK.md 14.12). Its switch
// (SIGNUP_FILTER_CHECK_ENABLED) and its address (SIGNUP_FILTER_CHECK_ADDRESS) are in abuse-limits.ts.

/** Daily at 11:30 UTC: 3.5 hours after ExportCognitoUsers (08:00), before the Synthetics canary's hours (13:00 on)
 * and the Sunday digest. Never hourly: that would use most of the Cognito email quota. */
export const SIGNUP_FILTER_CHECK_SCHEDULE = { minute: '30', hour: '11' } as const;
export const SIGNUP_FILTER_CHECK_MEMORY_MB = 256;
export const SIGNUP_FILTER_CHECK_TIMEOUT_SECONDS = 60;
/** One run at a time. Two runs that overlap (EventBridge and Lambda's async queue both deliver at least once, or a
 * hand run near 11:30) could otherwise see each other's base sign-up half done. A second async invocation is throttled
 * and retried by Lambda's queue later (it then finds the first run's accounts, busy, or a clean pool); a second hand
 * invocation gets TooManyRequestsException. CloudFormation refuses a reservation that leaves the account fewer than
 * 100 unreserved. */
export const SIGNUP_FILTER_CHECK_RESERVED_CONCURRENCY = 1;
/** EMF namespace of SignUpFilterCheckPassed, Failed, Inconclusive, Swept, SignUps and Disabled (log-based; no IAM).
 * It must match SIGNUP_FILTER_CHECK_METRIC_NAMESPACE in services/src/handlers/signUpFilterCheck/common.ts. */
export const SIGNUP_FILTER_CHECK_METRIC_NAMESPACE = 'BillBoard/SignUpFilterCheck';

// ── CleanupOrphanedUsers: sign-ups left unconfirmed (REL-53) ────────────────────────────────────
// The daily cleanup deletes self-service sign-ups that stayed UNCONFIRMED longer than the maximum age (with their
// sign-up email claim), so a person who left the app's code step can create the account again with that email.
// It never touches a confirmed, disabled or admin-created user, the filter check's probes, any address on
// billboard-project.com, or a user that holds app data. docs/RUNBOOK.md 8.2. Its switch
// (UNCONFIRMED_SIGNUP_CLEANUP_MODE), maximum age and per-run cap are in abuse-limits.ts.

// ── RestampUserVotes (INT-03, C2 3.3.4) ─────────────────────────────────────────────────────────
// An account with several hundred votes re-stamps in a few seconds; 60 leaves room for DynamoDB retries.
export const RESTAMP_USER_VOTES_TIMEOUT_SECONDS = 60;
// Six times the worker timeout, as SQS event sources recommend.
export const RESTAMP_USER_VOTES_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 6 * RESTAMP_USER_VOTES_TIMEOUT_SECONDS;
export const RESTAMP_USER_VOTES_BATCH_SIZE = 1;
// The lowest maximum concurrency an SQS event source allows.
export const RESTAMP_USER_VOTES_MAX_CONCURRENCY = 2;
export const RESTAMP_USER_VOTES_DLQ_MAX_RECEIVE_COUNT = 5;
export const RESTAMP_USER_VOTES_DLQ_RETENTION_DAYS = 14;
export const RESTAMP_USER_VOTES_QUEUE_NAME = 'RestampUserVotesQueue';
export const RESTAMP_USER_VOTES_DLQ_NAME = 'RestampUserVotesDLQ';

// ── 7B: the user API web ACL (SEC-02, CAP-10) ───────────────────────────────────────────────────
// The two rules' limits are in abuse-limits.ts (USER_API_RATE_LIMIT_PER_5_MINUTES, COGNITO_SIGN_UP_RATE_LIMIT).
export const COGNITO_SIGN_UP_RATE_LIMIT_RULE_NAME = 'CognitoSignUpRateLimit';
export const COGNITO_SIGN_UP_RATE_LIMITED_OPERATIONS = ['SignUp', 'ResendConfirmationCode', 'ForgotPassword'] as const;

/** EMF namespace of the INT-03, INT-05 and INT-06 metrics (log-based; no IAM). */
export const ACCOUNT_INTEGRITY_METRIC_NAMESPACE = 'BillBoard/AccountIntegrity';
