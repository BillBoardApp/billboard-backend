export const WEEKLY_DIGEST_CANONICAL_PUBLISH_TIMEZONE = 'America/New_York';
export const WEEKLY_DIGEST_CANONICAL_SCHEDULE_EXPRESSION = 'cron(0 10 ? * SUN *)';
export const WEEKLY_DIGEST_CANONICAL_PUBLISH_DAY = 'SUNDAY';
export const WEEKLY_DIGEST_CANONICAL_PUBLISH_HOUR = 10;
export const WEEKLY_DIGEST_CANONICAL_PUBLISH_MINUTE = 0;

// WeeklyDigestWorker (CAP-03): one work message names a publication window and up to 25 users.
export const WEEKLY_DIGEST_WORKER_TIMEOUT_SECONDS = 120;
export const WEEKLY_DIGEST_WORKER_MEMORY_MB = 1024;
export const WEEKLY_DIGEST_WORKER_BATCH_SIZE = 1;
export const WEEKLY_DIGEST_WORKER_MAX_CONCURRENCY = 5;
// Six times the worker timeout.
export const WEEKLY_DIGEST_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 6 * WEEKLY_DIGEST_WORKER_TIMEOUT_SECONDS;
// A message fails whole when any of its users fails; users already stored are skipped on the retry.
export const WEEKLY_DIGEST_DLQ_MAX_RECEIVE_COUNT = 3;
export const WEEKLY_DIGEST_DLQ_RETENTION_DAYS = 14;
export const WEEKLY_DIGEST_METRIC_NAMESPACE = 'BillBoard/WeeklyDigest';

// UX-28: the Sunday Weekly Brief push (WeeklyBriefPush). EventBridge Scheduler runs it hourly on Sunday from 10:30 AM
// to 6:30 PM in WEEKLY_DIGEST_CANONICAL_PUBLISH_TIMEZONE, after GenerateWeeklyDigests (10:00), and each user gets it at
// the first run outside their quiet hours (UX-27). The function reads the last run's hour to emit
// WeeklyBriefPushesUnsent, so both come from these numbers.
// The last run is 6:30 PM so Guam and the Northern Mariana Islands get it all year (D3: Monday morning there). While
// New York keeps daylight time, 5:30 PM is 7:30 AM Monday in Guam, still quiet hours, and 6:30 PM is 8:30 AM; in
// standard time they get it at 5:30 PM. 6:30 PM is before Eastern quiet hours and 8.5 hours after the release.
export const WEEKLY_BRIEF_PUSH_RUN_MINUTE = 30;
export const WEEKLY_BRIEF_PUSH_FIRST_RUN_HOUR = 10;
export const WEEKLY_BRIEF_PUSH_LAST_RUN_HOUR = 18;
export const WEEKLY_BRIEF_PUSH_SCHEDULE_EXPRESSION = `cron(${WEEKLY_BRIEF_PUSH_RUN_MINUTE} ${WEEKLY_BRIEF_PUSH_FIRST_RUN_HOUR}-${WEEKLY_BRIEF_PUSH_LAST_RUN_HOUR} ? * SUN *)`;
// true passes WEEKLY_BRIEF_PUSH=on. Safe from the first deploy: only a device whose row says notifyWeeklyBrief true gets
// the push, and only app 1.3 writes that. false passes 'off': every run sends nothing (the switch).
export const WEEKLY_BRIEF_PUSH_ENABLED = true;
export const WEEKLY_BRIEF_PUSH_TIMEOUT_SECONDS = 300;

// The only attributes WeeklyBriefPush may read or write (UX-28 review), granted as dynamodb:Attributes conditions:
// exactly what its requests name (services weeklyBriefPush/index.ts and its DAOs; its test pins them), the tables' key
// attributes included, since a request that names a key accesses it. Change both together.
/** UserPII Scan, beside its key (userId): whether the user is being deleted, their adult status, their state. */
export const WEEKLY_BRIEF_PUSH_PII_ATTRIBUTES = ['deletionStatus', 'adultStatus', 'resolvedState', 'selfAttestedState'];
/** UserWeeklyDigests GetItem: the brief and its push claim. */
export const WEEKLY_BRIEF_PUSH_SNAPSHOT_READ_ATTRIBUTES = ['payload', 'pushClaimedAt'];
/** UserWeeklyDigests UpdateItem: the push claim, set once. */
export const WEEKLY_BRIEF_PUSH_SNAPSHOT_WRITE_ATTRIBUTES = ['pushClaimedAt'];
/** UserDevices UpdateItem: a gone endpoint's ARN, removed. */
export const WEEKLY_BRIEF_PUSH_DEVICE_WRITE_ATTRIBUTES = ['endpointArn'];
