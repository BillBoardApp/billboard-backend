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
