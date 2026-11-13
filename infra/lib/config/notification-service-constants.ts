export const NOTIFICATION_SERVICE_QUEUE_BATCH_SIZE = 5;
export const USER_MATCHER_TIMEOUT_SECONDS = 30;
export const USER_MATCHER_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 180;

// Queue visibility timeouts are six times the consuming function's timeout.
export const NOTIFICATION_TYPE_TIMEOUT_SECONDS = 30;
export const USER_NOTIFIER_TIMEOUT_SECONDS = 120;
export const USER_NOTIFIER_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 720;
export const NOTIFICATION_DISPATCHER_TIMEOUT_SECONDS = 60;

export const NOTIFICATION_SERVICE_DLQ_MAX_RECEIVE_COUNT = 5;
export const NOTIFICATION_SERVICE_DLQ_RETENTION_DAYS = 14;

export const PENDING_NOTIFICATIONS_TABLE_NAME = 'PendingNotificationsTable';
export const PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY = 'userId';
export const PENDING_NOTIFICATIONS_TABLE_SORT_KEY = 'guid';

export const NOTIFICATION_DISPATCHER_USER_BATCH_SIZE = 50;

// CAP-02: pending-user dispatch markers are written to `__dispatch__#<n>` partitions. UserMatcher,
// NotificationFanout, NotificationDispatcher and UserNotifier must all get this same value. Only ever
// raise it, and deploy NotificationDispatcher and UserNotifier before the writers: markers in a shard
// that a lower count no longer reads are lost until their TTL (26 hours, services/src/shared/pendingNotifications.ts).
export const DISPATCH_SHARD_COUNT = 8;

// CAP-02 rollback switch. true: UserMatcher gets NOTIFICATION_FANOUT_QUEUE_URL and hands matched
// users to NotificationFanout in chunks. false: the variable is left out and UserMatcher writes the
// pending notifications inline, as before. The queue, its DLQ and NotificationFanout exist either way,
// so flipping this is a one-line change and one deploy.
export const NOTIFICATION_FANOUT_ENABLED = true;

// NotificationFanout (CAP-02). Visibility timeout is six times the function timeout. At most 2
// concurrent invocations, each working through its batch of 5 chunks one at a time with 8 writes in
// flight, keep about 16 transactions in flight and the marker partitions under DynamoDB's
// per-partition write limit.
export const NOTIFICATION_FANOUT_TIMEOUT_SECONDS = 60;
export const NOTIFICATION_FANOUT_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 6 * NOTIFICATION_FANOUT_TIMEOUT_SECONDS;
export const NOTIFICATION_FANOUT_QUEUE_BATCH_SIZE = 5;
export const NOTIFICATION_FANOUT_EVENT_SOURCE_MAX_CONCURRENCY = 2;

// S5 (feature review 2026-10-28, project decision the same day): UserNotifier holds pushes from 9 PM to 8 AM in each
// user's time zone, from the state of their district (UserPII; Eastern time when unknown), and sends them in the
// first dispatch after 8 AM. true passes QUIET_HOURS=on; false passes 'off', and pushes go out at any hour as before.
export const QUIET_HOURS_ENABLED = true;

// UX-33 (feature review 2026-10-28, S5; project decision the same day): at most one push every PUSH_PACE_HOURS per user.
// UserNotifier records each push it sends a user and holds the rows that arrive inside that window, the way the quiet
// hours hold them, until the first dispatch after it, which folds them into one push ("updated" rows keep a push of
// their own). Passed as UserNotifier's PUSH_PACE_HOURS; 0 turns the pace off (pushes go out as soon as the quiet hours
// allow, as before). At most 8, so a row held for a window and then the night still goes out inside its 24 hours.
export const PUSH_PACE_HOURS = 3;

// REL-56 (docs/RUNBOOK.md 16.1; project decision 2026-11-12): NotificationType's BACKFILL_PUSH_MODE. 'skip': a processed-bill
// change the backfill wrote (a `rel56:` correlation id on the version) is classified and logged, counted as
// BackfillPushSkipped and handed to nobody, so the backfill (`refetch:stale-bills --unattended`, which refuses unless
// NotificationType:prod reads 'skip') runs without quiet windows. The skip relies on one rule: only the backfill's own
// fetch writes a version with a `rel56:` id. So a FetchRawBill rule that skips or defers a poller listing because of a
// stored copy (REL-57) must never count a `rel56:` or `refetch:` store as covering that listing, or the listing's real
// update is published under the backfill's id and its push is skipped.
// 'push': such a change is handed to UserMatcher as before; the rollback. Backfill work still queued when 'push' goes
// live pushes, so stop the run first and deploy 'push' only once UpdatedBillsQueue, BillVoteEnrichmentQueue,
// BillDifferQueue, BillSummarizerQueue and NotificationTypeQueue read 0 0 0 (visible, in flight, delayed), or inside a
// 4.1 window. After it, purge a NotificationTypeDLQ message of a `rel56:` version instead of redriving it, and redrive
// other DLQs' `rel56:` work inside a window. NotificationType reads any other value as 'skip', which silences the
// backfill's changes only. A change publishes a new NotificationType version, which shifts at once (a worker).
export const BACKFILL_PUSH_MODE: 'skip' | 'push' = 'skip';

export const APNS_PLATFORM_APPLICATION_NAME = 'BillboardApnsProduction';
export const NOTIFICATIONS_METRIC_NAMESPACE = 'BillBoard/Notifications';
