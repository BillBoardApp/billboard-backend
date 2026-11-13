/**
 * Infra review item 3 (C1.1): one failure queue for every scheduled job.
 *
 * SharedInfraStack owns the queue. The service stacks name it by this fixed name, as they do the store
 * tables (CQ-15), so there is no CloudFormation export between them. It has no consumer: a record waits
 * here until someone reads it (RUNBOOK "ScheduledJobFailures: read and rerun"), and its alarm
 * (Billboard-SQS-ScheduledJobFailures-VisibleMessages) fires at one visible message.
 *
 * What lands here:
 * - EventBridge rule and Scheduler schedule dead letters: the schedule could not invoke its target
 *   (missing permission, broken role, deleted alias). The message attributes name the cause.
 * - Lambda async OnFailure records of the jobs whose next run is too far away to be the rerun
 *   (FetchCongressMembersList, GenerateWeeklyDigests) or whose failure is an abort to read
 *   (CleanupOrphanedUsers). The record carries the original payload and the error.
 */
export const SCHEDULED_JOB_FAILURES_QUEUE_NAME = 'ScheduledJobFailures';

/** The longest SQS allows, like every DLQ in the app: a weekly job's failure is still there a week later. */
export const SCHEDULED_JOB_FAILURES_RETENTION_DAYS = 14;

/**
 * Lambda async retries before a scheduled job's failure is recorded. Two is Lambda's default, written out
 * so the destination does not silently change it. CleanupOrphanedUsers keeps 0: a safety abort throws, and
 * a retry would only repeat the scan.
 */
export const FETCH_CONGRESS_MEMBERS_LIST_ASYNC_RETRY_ATTEMPTS = 2;
export const GENERATE_WEEKLY_DIGESTS_ASYNC_RETRY_ATTEMPTS = 2;
export const CLEANUP_ORPHANED_USERS_ASYNC_RETRY_ATTEMPTS = 0;
