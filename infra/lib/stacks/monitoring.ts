import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as chatbot from 'aws-cdk-lib/aws-chatbot';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import {
  BILL_STATS_AGGREGATOR_DURATION_ALARM_THRESHOLD_MS,
  BILL_STATS_AGGREGATOR_TIMEOUT_SECONDS,
} from '../config/analytics-service-constants';
import { BEDROCK_GRANTED_MODEL_IDS, BEDROCK_INFERENCE_PROFILE_GEO } from '../config/bedrock-models';
import {
  BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS,
  BILL_POLLER_TRAILING_LAG_ALARM_THRESHOLD_SECONDS,
  FETCH_RAW_BILL_FAILING_ALARM_SECONDS,
  FETCH_RAW_BILL_RETRY_LADDER_SECONDS,
  FETCH_RAW_BILL_RETRY_OTHER_SECONDS,
  FETCH_RETRY_BACKOFF,
  INGEST_DLQ_RETENTION_DAYS,
  UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT,
  UPDATED_BILLS_QUEUE_TIMEOUT_SECONDS,
} from '../config/congress-integration-service-constants';
import {
  APNS_PLATFORM_APPLICATION_NAME,
  NOTIFICATION_SERVICE_DLQ_MAX_RECEIVE_COUNT,
  NOTIFICATIONS_METRIC_NAMESPACE,
  PENDING_NOTIFICATIONS_TABLE_NAME,
  PUSH_PACE_HOURS,
  USER_MATCHER_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
} from '../config/notification-service-constants';
import {
  SCHEDULED_JOB_FAILURES_QUEUE_NAME,
  SCHEDULED_JOB_FAILURES_RETENTION_DAYS,
} from '../config/scheduled-jobs-constants';
import {
  BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT,
  BILL_SUMMARIZER_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
} from '../config/summarizer-service-constants';
import {
  ACCOUNT_INTEGRITY_METRIC_NAMESPACE,
  BILL_STATS_METRIC_NAMESPACE,
  BILLS_MANIFEST_METRIC_NAMESPACE,
  CIVIC_SCORE_METRIC_NAMESPACE,
  RESTAMP_USER_VOTES_DLQ_NAME,
  RESTAMP_USER_VOTES_QUEUE_NAME,
  CANARY_SIGN_IN_FAILED_METRIC_NAME,
  SIGNUP_FILTER_CHECK_METRIC_NAMESPACE,
  USER_API_CANARY_NAME,
  USER_API_NAME,
} from '../config/user-api-service-constants';
import { WEEKLY_DIGEST_METRIC_NAMESPACE } from '../config/weekly-digest-constants';
import {
  SES_BOUNCE_RATE_ALARM_THRESHOLD,
  SES_COMPLAINT_RATE_ALARM_THRESHOLD,
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DIMENSION_NAME,
} from '../config/email-constants';
import {
  APP_ATTEST_FUNCTION_NAME,
  APP_ATTEST_METRIC_NAMESPACE,
} from '../config/app-attest-constants';
import {
  ACCOUNT_INTEGRITY_ALARM_THRESHOLDS,
  ADDRESS_CHANGE_WINDOW_DAYS,
  APP_ATTEST_RESERVED_CONCURRENCY,
  MAX_ADDRESS_CHANGES_PER_WINDOW,
  MAX_VERIFIED_ACCOUNTS_PER_ADDRESS,
  STREET_CLUSTER_FLAG_THRESHOLD,
  UNCONFIRMED_SIGNUP_MAX_AGE_HOURS,
  VOTE_DAILY_CAP_ENFORCE_READY_MAX,
  VOTE_DAILY_LIMIT,
  type DetectionThreshold,
} from '../config/abuse-limits';
import { ALARM_TOPIC_NAME, PAGE_TOPIC_NAME } from './helpers/alarm-topic';
import { addAppAttestAlarms, appAttestMetric } from './helpers/app-attest-alarms';
import { inferenceProfileArn } from './helpers/bedrock-grants';

const QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_SECONDS = 20 * 60;
const MONTHLY_COST_BUDGET_USD = 75;

/** C1.8: where services/src/shared/unprocessableMessages.ts writes MessagesUnprocessable. */
export const PIPELINE_METRIC_NAMESPACE = 'BillBoard/Pipeline';
/**
 * C1.10: where CleanupOrphanedUsers writes AccountDeletionsStuck. REL-53: also its unconfirmed sign-up step's counts
 * (UnconfirmedSignUpsDeleted, Expired, Pending, Skipped by Reason, UnconfirmedSignUpCleanupErrors and CapReached), its
 * SignUpsConfirmed (users created in the 24 hours before the run and CONFIRMED by it) and PreSignUpCheck's
 * SignUpAllowed (real sign-ups let through; the filter check's probes are left out).
 */
export const ACCOUNTS_METRIC_NAMESPACE = 'BillBoard/Accounts';
/** REL-53: the Reason values of UnconfirmedSignUpsSkipped (SKIP_REASONS in services/src/handlers/cleanupOrphanedUsers/unconfirmedSignUps.ts). */
export const UNCONFIRMED_SIGN_UP_SKIP_REASONS: readonly string[] = [
  'probe',
  'projectDomain',
  'disabled',
  'notUnconfirmed',
  'unknownAge',
  'hasAppData',
  'changed',
  'gone',
];
/**
 * LLM-11: where BillSummarizer and BillPriorityResolver write their Bedrock call metrics (EMF, from
 * services/src/shared/bedrockMessages.ts and the resolver): BedrockCalls, BedrockLatency and
 * BedrockOutputTokens by Caller and Outcome, and BedrockRequestRejected, BedrockThrottled, BedrockRefusal
 * and PriorityResolverNoAnswer without dimensions.
 */
export const BEDROCK_METRIC_NAMESPACE = 'BillBoard/Bedrock';

/**
 * REL-54: SES's account-level reputation metrics (AWS/SES, no dimensions), which SES publishes for every account that
 * sends: the historic hard-bounce and complaint rates over a representative volume, the figures SES reviews and pauses
 * accounts on. The configuration set's own event counts are in AWS/SES under SES_EVENT_DIMENSION_NAME.
 */
export const SES_METRIC_NAMESPACE = 'AWS/SES';
export const SES_REPUTATION_ALARM_NAMES: readonly string[] = ['Billboard-Email-BounceRate', 'Billboard-Email-ComplaintRate'];

/** C1.4: the only alarms with an action on the page topic, on ALARM and on OK. */
export const PAGE_COMPOSITE_ALARM_NAMES: readonly string[] = [
  'Billboard-Page-AppBroken',
  'Billboard-Page-PushesDown',
];

/** C1.4: alarms with no action of their own, which reach the paging channel only through a page composite. */
export const PAGE_MEMBER_ONLY_ALARM_NAMES: readonly string[] = [
  'Billboard-Page-BillsManifestSnapshotStale',
  'Billboard-Page-NotificationTypeQueueStalled',
  'Billboard-Heartbeat-NotificationDispatcher',
];

/**
 * Composites with no action of their own, kept as a status view on the dashboard: each of their members notifies the
 * alarm topic itself, so their own notification only ever repeated a member's.
 */
export const STATUS_ONLY_ALARM_NAMES: readonly string[] = ['Billboard-Ingest-Unhealthy'];

/** Every application Lambda. Each one gets its own notifying Errors alarm so the page names the function. */
export const MONITORED_LAMBDA_NAMES: readonly string[] = [
  'RegisterUserDevice',
  'DeviceNotificationSettings',
  'DeletePreferences',
  'FetchPreferences',
  'SetPreferences',
  'FetchProcessedBill',
  'FetchFeedback',
  'SetFeedback',
  'FetchBillStats',
  'FetchCivicScore',
  'FetchCivicProfile',
  'FetchCongressMemberCivicProfile',
  'DistrictVerification',
  'AdultAttestation',
  'FetchMe',
  'FetchLatestWeeklyDigest',
  'GenerateWeeklyDigests',
  'AccountData',
  'AccountDataStatus',
  'CleanupOrphanedUsers',
  'ExportCognitoUsers',
  'FetchProcessedCongressMembers',
  'FetchCongressMembersManifest',
  'FetchBillsManifest',
  'PublishBillsManifest',
  'WeeklyDigestWorker',
  // The account-integrity functions: INT-05's pre-sign-up trigger, INT-03's vote re-stamp worker and INT-04's App
  // Attest routes.
  'PreSignUpCheck',
  'RestampUserVotes',
  APP_ATTEST_FUNCTION_NAME,
  // CB-07: the daily sign-up filter check.
  'SignUpFilterCheck',
  'BillPriorityResolver',
  'BillsApiPoller',
  'FetchRawBill',
  'EnrichOfficialVotes',
  'FetchCongressMembersList',
  'FetchRawCongressMembers',
  'BillDiffer',
  'BillSummarizer',
  'CongressMemberSummarizer',
  'CreateBillsManifest',
  'CreateCongressMembersManifest',
  'NotificationType',
  'UserMatcher',
  'NotificationFanout',
  'NotificationDispatcher',
  'UserNotifier',
  'CongressMemberStats',
  'BillStatsAggregator',
];

/** Functions wired for reserved concurrency through the *_RESERVED_CONCURRENCY constants. */
export const THROTTLE_MONITORED_LAMBDA_NAMES: readonly string[] = [
  'BillsApiPoller',
  'FetchRawBill',
  'EnrichOfficialVotes',
  'BillSummarizer',
  // INT-04 (C3 3.11): APP_ATTEST_RESERVED_CONCURRENCY holds a flood on the public App Attest routes.
  APP_ATTEST_FUNCTION_NAME,
];

/**
 * Throttle alarms that fire only when every one of their 3 five-minute windows had a throttle, not 2 of 3. BillsApiPoller
 * runs at reserved concurrency 1, so one overlap (an async retry, or a slow run, meeting the next scheduled run) throttles
 * a few times while the other run lasts, at most its 120-second timeout; that fits in 2 windows but fired 2 of 3 (six
 * throttles at 18:08Z on 2026-10-27). Lambda retries the throttled event, and the next run catches up from the cursor.
 */
export const SUSTAINED_THROTTLE_LAMBDA_NAMES: readonly string[] = ['BillsApiPoller'];

/** Throttle alarm descriptions that differ from the default (which describes a queue or scheduled worker). */
const THROTTLE_ALARM_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  BillsApiPoller: 'BillsApiPoller was throttled in each of the last 3 five-minute windows at its reserved concurrency of 1: runs keep colliding, so polls are being delayed or skipped. One overlap (an async retry of a failed run, or a slow run, meeting the next scheduled run) lasts at most the 120-second timeout and does not fire this. Usually runs failing every time (each failure is retried twice and meets the next runs) or running into the timeout: check Billboard-Lambda-BillsApiPoller-Errors, the run durations in /aws/lambda/BillsApiPoller, and that the reservation was not changed (BILLS_API_POLLER_RESERVED_CONCURRENCY). A congress.gov outage alone no longer fails a run (CongressApiUnavailable). RUNBOOK 6.1.',
  [APP_ATTEST_FUNCTION_NAME]: `${APP_ATTEST_FUNCTION_NAME} was throttled at its reserved concurrency of ${APP_ATTEST_RESERVED_CONCURRENCY} in at least 2 of the last 3 five-minute windows, despite the stage throttles on POST /app-attest/challenge and /attest that should keep calls under it (slow calls, or throttles raised without the concurrency). API Gateway answers a Lambda throttle with a 500, which also counts in Billboard-API-5XXError; R2 backs off and still sends its vote or sign-up with a marker, and other functions are unaffected. Check the function's duration and Billboard-AppAttest-ChallengeFlood, then lower APP_ATTEST_CHALLENGE_THROTTLE or raise APP_ATTEST_RESERVED_CONCURRENCY (infra/lib/config/abuse-limits.ts).`,
};

/**
 * Work queues: an oldest-message-age alarm each. C1.4 removed their backlog-count alarms: a bulk rerun
 * (REL-32) would flood the channel with them, and the age alarms and DLQ alarms still catch a stuck
 * consumer and poison messages. WeeklyDigestQueue (filled in one burst each Sunday, CAP-03) never had a
 * backlog alarm, so it now sits here with the rest; its age alarm keeps its logical ID.
 */
export const MONITORED_WORK_QUEUE_NAMES: readonly string[] = [
  'UpdatedBillsQueue',
  'BillVoteEnrichmentQueue',
  'BillDifferQueue',
  'UpdatedCongressMembersQueue',
  'CongressMemberSummarizerQueue',
  'BillSummarizerQueue',
  'NotificationTypeQueue',
  'userMatcherQueue',
  'notificationFanoutQueue',
  'userNotifierQueue',
  'CongressMemberStatsQueue',
  'BillsManifestQueue',
  'CongressMembersManifestQueue',
  'WeeklyDigestQueue',
  // INT-03: re-stamp messages wait 10 seconds, then take seconds each, so 20 minutes means a stuck worker.
  RESTAMP_USER_VOTES_QUEUE_NAME,
];

/** Oldest-message-age thresholds that differ from the 20-minute default. */
export const QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_OVERRIDES_SECONDS: Readonly<Record<string, number>> = {
  // Pushes wait on this queue, and a bill's chunks normally drain in well under a minute (CAP-02).
  notificationFanoutQueue: 10 * 60,
  // OBS-21: FetchRawBill drains about 9.5 bills a minute (2 at a time, about 10 s each), so one of congress.gov's
  // batches of 150 to 200 bills, which the poller can send twice (REL-56's 120 s overlap), keeps the oldest message
  // 20 to 40 minutes old on a healthy day. An hour still catches a stuck consumer; dead letters have their own alarm.
  UpdatedBillsQueue: 60 * 60,
};

/**
 * Dead-letter queues: each alarms on its own at one visible message. ScheduledJobFailures (C1.1) is the
 * scheduled jobs' DLQ and failure-record queue, though its name does not end in DLQ.
 */
export const MONITORED_DLQ_NAMES: readonly string[] = [
  'UpdatedBillsDLQ',
  'BillVoteEnrichmentDLQ',
  'BillDifferDLQ',
  'UpdatedCongressMembersDLQ',
  'CongressMemberSummarizerDLQ',
  'BillSummarizerDLQ',
  'NotificationTypeDLQ',
  'CongressMemberStatsDLQ',
  'userMatcherDLQ',
  'notificationFanoutDLQ',
  'userNotifierDLQ',
  'WeeklyDigestDLQ',
  'BillsManifestDLQ',
  'CongressMembersManifestDLQ',
  'BillStatsAggregatorStreamDLQ',
  SCHEDULED_JOB_FAILURES_QUEUE_NAME,
  RESTAMP_USER_VOTES_DLQ_NAME,
];

/**
 * REL-58: how long a bill update fails in FetchRawBill before UpdatedBillsDLQ, for its alarm. With the retry ladder
 * on: its first steps in minutes ("3, 5, 10, 20 and 30") and hourly tail, and the minute apart of any other failure
 * (each receive after the first, plus a minute for the runs). Off: the receives at the queue's visibility timeout.
 */
export const updatedBillsDeadLetterHorizon = (backoff: 'off' | 'on', receives: number): string => {
  if (backoff === 'off') {
    const minutes = Math.round((receives * UPDATED_BILLS_QUEUE_TIMEOUT_SECONDS) / 60);
    return `about ${minutes} minutes, ${UPDATED_BILLS_QUEUE_TIMEOUT_SECONDS} s apart (the retry ladder is off; RUNBOOK 6.5)`;
  }
  const minutes = FETCH_RAW_BILL_RETRY_LADDER_SECONDS.filter((step) => step < 3600).map((step) => step / 60);
  const steps = `${minutes.slice(0, -1).join(', ')} and ${minutes[minutes.length - 1]} minutes, then hourly`;
  const hours = Math.round(FETCH_RAW_BILL_RETRY_LADDER_SECONDS.reduce((sum, step) => sum + step, 0) / 3600);
  const otherMinutes = Math.round(((receives - 1) * FETCH_RAW_BILL_RETRY_OTHER_SECONDS) / 60) + 1;
  return `about ${hours} hours of congress.gov timeouts, 5xx or 429s (retried after ${steps}; RUNBOOK 6.5), or about ${otherMinutes} minutes of any other error or of a refetch or backfill message's`;
};

/** DLQ alarm descriptions that differ from the default. */
const DLQ_ALARM_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  // OBS-21: the bills in it stay unstored or stale until a redrive, as the poller does not send a row it sent again.
  // REL-57: or stored but not yet diffed (stored, then the send failed), which a later equal listing does not heal
  // under REFETCH_UNCHANGED_MODE on. REL-58: the receives span about 6 hours of congress.gov trouble.
  UpdatedBillsDLQ: `A bill update failed its ${UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT} receives in FetchRawBill: ${updatedBillsDeadLetterHorizon(FETCH_RETRY_BACKOFF, UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT)}. So that bill keeps its previous raw copy, is not stored at all, or is stored but not yet diffed, until it is sent again: the poller does not send a row it already sent, and under REFETCH_UNCHANGED_MODE on a later listing that changes nothing does not send it on (RUNBOOK 6.4). Usually a congress.gov outage longer than that ("Failed record will be retried" lines with failureKind unavailable in /aws/lambda/FetchRawBill, CongressApiUnavailable from the poller): once those stop, redrive with aws sqs start-message-move-task (RUNBOOK 6.2). Any other error: read the record's lines first. While this alarm stays in ALARM, a new dead letter sends no notification, so redrive soon.`,
  BillSummarizerDLQ: `A bill's summary failed ${BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT} receives (about ${BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT * BILL_SUMMARIZER_QUEUE_VISIBILITY_TIMEOUT_SECONDS / 60} minutes), so the bill keeps its previous summary, or still has none. What still fails a receive: Bedrock errors, throttling or timeouts that outlast the retries, an answer cut at max_tokens or not parseable, or a field still empty after the corrective call. An over-limit field is fitted to its limit instead (REL-40), and a refused bill is acknowledged (Billboard-Pipeline-MessagesUnprocessable). Read the bill's bedrock_call, analysis_rejected and "billSummarizer record failed" lines in /aws/lambda/BillSummarizer, and check Billboard-Bedrock-RequestRejected and -InvocationThrottles. A redrive before the fix fails the same way. The message only points at the bill and stays ${INGEST_DLQ_RETENTION_DAYS} days; after that, reconcile:processed-bills recreates the work. RUNBOOK 11.7 has the redrive.`,
  // UX-33 review (F4): a dead-lettered outcome message now also holds its version's action push.
  NotificationTypeDLQ: `A processed bill's S3 event failed 5 receives in NotificationType (about 15 minutes), so that change's pushes were not handed to UserMatcher, or only some. Read "Failed to classify processed bill record" in /aws/lambda/NotificationType and fix the cause. Then redrive to NotificationTypeQueue within 24 hours of the change: it compares the same stored version with the one before it again, and a user already written is a no-op (the dedupe markers last 3 days). Older than 24 hours, purge (stale news, D1). RUNBOOK 11.1.`,
  userMatcherDLQ: `A UserMatcher message (one push type of one bill change) failed ${NOTIFICATION_SERVICE_DLQ_MAX_RECEIVE_COUNT} receives (about ${NOTIFICATION_SERVICE_DLQ_MAX_RECEIVE_COUNT * USER_MATCHER_QUEUE_VISIBILITY_TIMEOUT_SECONDS / 60} minutes), so its audience was not written, or only some. Since UX-33 a passed or failed message also carries its stored version's action push (that version's alert message wrote nothing), so the bill's voters and watchers get neither push until the redrive. Read "Failed to process notificationType message" in /aws/lambda/UserMatcher and fix the cause. Then redrive to userMatcherQueue within 24 hours of the change: a user already written is a no-op (the dedupe markers, the paired action's too, last 3 days). Older than 24 hours, purge (stale news, D1). RUNBOOK 11.1.`,
  [RESTAMP_USER_VOTES_DLQ_NAME]: `A vote re-stamp message failed 5 times (an unreadable message, missing configuration or a DynamoDB error), so that account's stored votes keep their old verification stamp. Read the message ({"userId": "<sub>"}) and /aws/lambda/RestampUserVotes, fix the cause, then redrive it to RestampUserVotesQueue: the worker is idempotent and converges on the account's current UserPII row. Messages stay 14 days. RUNBOOK section 14 has the redrive.`,
  [SCHEDULED_JOB_FAILURES_QUEUE_NAME]: `A scheduled job failed after its retries, or an EventBridge rule or Scheduler schedule could not invoke its target. A Lambda failure record (FetchCongressMembersList, GenerateWeeklyDigests, CleanupOrphanedUsers) holds the requestPayload and the error; a rule or schedule dead letter names the cause in its ERROR_CODE and ERROR_MESSAGE attributes. Messages stay ${SCHEDULED_JOB_FAILURES_RETENTION_DAYS} days. RUNBOOK 11.6 says which jobs may be rerun and how; never rerun CleanupOrphanedUsers before reading its log. Delete the message once handled.`,
};

export interface MonitoringStackProps extends cdk.StackProps {
  readonly alarmTopicName?: string;
  readonly slackChannelId?: string;
  readonly slackWorkspaceId?: string;
  /**
   * C1.4: the Slack channel that receives pages (context key monitoringSlackPageChannelId, set in S4).
   * Unset, the existing alarm channel also subscribes to the page topic, so pages appear there. Set, a
   * second configuration (BillboardOpsPages) takes the page topic and the alarm channel goes back to the
   * alarm topic only. Needs slackWorkspaceId.
   */
  readonly slackPageChannelId?: string;
}

/**
 * C2 3.11: the account-integrity alarms on the INT-03, INT-05 and INT-06 metrics, all routine
 * (the alarm topic), none paging, missing data not breaching. Under watch they show what enforce would refuse.
 */
export const ACCOUNT_INTEGRITY_ALARM_NAMES: readonly string[] = [
  'Billboard-Integrity-VoteDailyCapExceeded',
  'Billboard-Integrity-VoteVelocity',
  'Billboard-Integrity-AddressVerificationBurst',
  'Billboard-Integrity-AddressCapSignal',
  'Billboard-Integrity-SignUpFilterHits',
  'Billboard-Integrity-SignUpFilterErrors',
  // CB-07: the sign-up filter check failed, or swept an earlier run's leftovers.
  'Billboard-Integrity-SignUpFilterCheckFailed',
  // REL-46: a district lookup fell back to the geocoder's Current_Current vintage.
  'Billboard-Integrity-GeocoderVintageFallback',
];

// Alarm-status widgets hold at most 100 alarms each, so the dashboard shows one per group.
type AlarmGroup = 'pages' | 'service' | 'ingestion' | 'lambda' | 'queues' | 'dynamodb' | 'integrity' | 'appAttest' | 'email';

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps = {}) {
    super(scope, id, props);

    const alarmTopicName = props.alarmTopicName ?? ALARM_TOPIC_NAME;
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: alarmTopicName,
    });
    // C1.4: the paging tier. Only the two page composites below notify it.
    const pageTopic = new sns.Topic(this, 'PageTopic', {
      topicName: PAGE_TOPIC_NAME,
    });

    if (Boolean(props.slackWorkspaceId) !== Boolean(props.slackChannelId)) {
      throw new Error('Monitoring Slack alerts require both slackWorkspaceId and slackChannelId.');
    }
    if (props.slackPageChannelId && !props.slackWorkspaceId) {
      throw new Error('Monitoring Slack pages (slackPageChannelId) require slackWorkspaceId and slackChannelId.');
    }

    // Alerts are Slack only: nothing here subscribes an email address or any other endpoint to either
    // topic (the alarmSubscription* props are gone).
    if (props.slackWorkspaceId && props.slackChannelId) {
      new chatbot.SlackChannelConfiguration(this, 'SlackAlarmChannel', {
        slackChannelConfigurationName: 'BillboardOpsAlarms',
        slackWorkspaceId: props.slackWorkspaceId,
        slackChannelId: props.slackChannelId,
        // Until the paging channel is configured, pages appear here with everything else.
        notificationTopics: props.slackPageChannelId ? [alarmTopic] : [alarmTopic, pageTopic],
        loggingLevel: chatbot.LoggingLevel.ERROR,
      });
      if (props.slackPageChannelId) {
        new chatbot.SlackChannelConfiguration(this, 'SlackPageChannel', {
          slackChannelConfigurationName: 'BillboardOpsPages',
          slackWorkspaceId: props.slackWorkspaceId,
          slackChannelId: props.slackPageChannelId,
          notificationTopics: [pageTopic],
          loggingLevel: chatbot.LoggingLevel.ERROR,
        });
      }
    }

    // A topic policy replaces SNS's default one, so CloudWatch alarms (this stack's and the
    // ones other stacks attach via alarmTopicFromName) must be allowed explicitly next to Budgets.
    alarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsToPublish',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [alarmTopic.topicArn],
      conditions: {
        ArnLike: { 'aws:SourceArn': `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:*` },
      },
    }));
    pageTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmsToPublish',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [pageTopic.topicArn],
      conditions: {
        ArnLike: { 'aws:SourceArn': `arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:*` },
      },
    }));
    alarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowBudgetsToPublish',
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [alarmTopic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:${this.partition}:budgets::${this.account}:*` },
      },
    }));

    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
    const pageAction = new cloudwatchActions.SnsAction(pageTopic);
    const alarmGroups: Record<AlarmGroup, cloudwatch.AlarmBase[]> = {
      pages: [],
      service: [],
      ingestion: [],
      lambda: [],
      queues: [],
      dynamodb: [],
      integrity: [],
      appAttest: [],
      email: [],
    };
    // Every alarm in this stack appears on the dashboard's status widgets. All of them notify the alarm
    // topic (the routine tier) through notify(), except the page tier below and the status-only composites.
    const notify = <T extends cloudwatch.AlarmBase>(group: AlarmGroup, alarm: T): T => {
      alarm.addAlarmAction(alarmAction);
      alarmGroups[group].push(alarm);
      return alarm;
    };
    // A status-only composite (STATUS_ONLY_ALARM_NAMES): on the dashboard, with no action of its own.
    const statusOnly = (group: AlarmGroup, alarm: cloudwatch.CompositeAlarm): cloudwatch.CompositeAlarm => {
      alarmGroups[group].push(alarm);
      return alarm;
    };
    // C1.4: a page member has no action of its own; it reaches the paging channel only through its page.
    const pageMember = <T extends cloudwatch.AlarmBase>(alarm: T): T => {
      alarmGroups.pages.push(alarm);
      return alarm;
    };
    // C1.4: the only alarms with the page topic as an action, on ALARM and on OK.
    const page = (alarm: cloudwatch.CompositeAlarm): cloudwatch.CompositeAlarm => {
      alarm.addAlarmAction(pageAction);
      alarm.addOkAction(pageAction);
      alarmGroups.pages.push(alarm);
      return alarm;
    };

    // ── User API, canary and product health ─────────────────────────────────

    const userApi5xxAlarm = notify('service', new cloudwatch.Alarm(this, 'UserApi5xxAlarm', {
      alarmName: 'Billboard-API-5XXError',
      alarmDescription: `${USER_API_NAME} returned 5 or more 5XX responses in at least 2 of the last 3 minutes. Check the per-function Lambda error alarms for the failing handler, then API Gateway access logs.`,
      metric: this.userApiMetric('5XXError', 'Sum', cdk.Duration.minutes(1)),
      threshold: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    notify('service', new cloudwatch.Alarm(this, 'UserApiLatencyP99Alarm', {
      alarmName: 'Billboard-API-LatencyP99',
      alarmDescription: `${USER_API_NAME} p99 latency stayed above 3 seconds for 15 minutes. Check Lambda duration and memory on the slow handler (FetchBillsManifest has run out of memory before) and DynamoDB/S3 latency in X-Ray.`,
      metric: this.userApiMetric('Latency', 'p99', cdk.Duration.minutes(5)),
      threshold: 3000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    const canarySuccessMetric = new cloudwatch.Metric({
      namespace: 'CloudWatchSynthetics',
      metricName: 'SuccessPercent',
      dimensionsMap: { CanaryName: USER_API_CANARY_NAME },
      statistic: 'Average',
      period: cdk.Duration.minutes(15),
    });
    const userApiCanaryAlarm = notify('service', new cloudwatch.Alarm(this, 'UserApiCanaryAlarm', {
      alarmName: 'Billboard-Canary-SuccessPercent',
      alarmDescription: `The ${USER_API_CANARY_NAME} Synthetics canary succeeded on under 90% of runs in 2 of the last 3 fifteen-minute windows. The canary only runs 13:00-23:45 UTC, so this alarm is silent overnight. Check the failed run's screenshots and logs in the Synthetics console.`,
      metric: canarySuccessMetric,
      threshold: 90,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // UA-04: the canary's test account could not sign in (no secret, bad JSON, wrong keys, a TOTP or password-change
    // challenge, a refused password). The canary then skips its signed-in steps and emits this instead of failing
    // the run, so a mistake in the hand-made secret or account does not page (the canary alarm above is a
    // member of Billboard-Page-AppBroken) and does not stop an API deployment. This alarm is routine only: it is no
    // page member and no deployment group watches it. Same shape as the canary alarm: 2 of 3 fifteen-minute windows.
    notify('service', new cloudwatch.Alarm(this, 'CanarySmokeSignInFailedAlarm', {
      alarmName: 'Billboard-Canary-SmokeSignInFailed',
      alarmDescription: `The ${USER_API_CANARY_NAME} canary could not sign in its test account in at least 2 of the last 3 fifteen-minute windows, so it is running only /health and the unauthenticated check; the signed-in steps, the weekly digest freshness check among them, are off. This does not fail the canary, page or stop a deploy. The canary only runs 13:00-23:45 UTC. Find the reason in the latest run's log in the Synthetics console ("smoke sign-in unavailable (...)"), then fix the secret Billboard/CanarySmokeTestCredentials (JSON keys exactly username or email, and password) or the account (confirmed, permanent password, no TOTP). RUNBOOK 7.`,
      metric: new cloudwatch.Metric({
        namespace: 'BillBoard/ProductHealth',
        metricName: CANARY_SIGN_IN_FAILED_METRIC_NAME,
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // INT-11: GET /bill-stats answers 500 when it cannot read the caller's own vote, and so serves no results to
    // anyone (it fails closed). It returns that answer instead of throwing, so FetchBillStats' Errors alarms never
    // count it, and at a few /bill-stats calls a day the API 5XX alarms cannot reach their thresholds. Routine only,
    // and on purpose in no deployment group: a rollback would put back a FetchBillStats without the gate, which
    // serves results to everyone (RUNBOOK 17.4).
    notify('service', new cloudwatch.Alarm(this, 'ResultsGateReadFailedAlarm', {
      alarmName: 'Billboard-BillStats-ResultsGateReadFailed',
      alarmDescription: 'GET /bill-stats answered 500 because FetchBillStats could not read the caller\'s own UserFeedback rows (the INT-11 results gate fails closed, so that voter saw no results). Check /aws/lambda/FetchBillStats for "Could not read the caller\'s vote; not serving the bill stats": AccessDeniedException means the role lost dynamodb:BatchGetItem on UserFeedback, throttling means the table\'s capacity. Do not roll FetchBillStats back without checking first: an older version serves results to everyone. RUNBOOK 17.4.',
      metric: new cloudwatch.Metric({
        namespace: BILL_STATS_METRIC_NAMESPACE,
        metricName: 'ResultsGateReadFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // UX-31: two new reads in the vote and score paths answer a handled 500 instead of throwing, so the alias Errors
    // alarms never count them, the API 5XX alarms cannot reach 5 a minute at this traffic, and the canary calls neither
    // route. Routine only. Rolling either function back is safe (RUNBOOK 19.6), but they are in no deployment group:
    // the 10-minute shift would rarely see one at this traffic, and RUNBOOK 19.6 checks both right after the deploy.
    notify('service', new cloudwatch.Alarm(this, 'EarlierVoteReadFailedAlarm', {
      alarmName: 'Billboard-Votes-EarlierVoteReadFailed',
      alarmDescription: 'POST /feedback answered 500 and stored no vote because SetFeedback could not read the caller\'s earlier UserFeedback row on the bill (UX-31 keeps the first-vote time from it). Both apps roll the vote back, so while this lasts nobody can vote. Check /aws/lambda/SetFeedback for "Could not read the caller\'s earlier vote on the bill": AccessDeniedException means the role lost dynamodb:GetItem on UserFeedback, throttling means the table\'s capacity. Rolling SetFeedback back is safe (votes then lose their first-vote time as before UX-31). RUNBOOK 19.6.',
      metric: new cloudwatch.Metric({
        namespace: BILL_STATS_METRIC_NAMESPACE,
        metricName: 'EarlierVoteReadFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));
    notify('service', new cloudwatch.Alarm(this, 'CivicRecordFailedAlarm', {
      alarmName: 'Billboard-CivicScore-RecordFailed',
      alarmDescription: 'FetchCivicScore could not read the caller\'s Civic Score record on UserPII (CivicRecordReadFailed: GET /civic-score answered 500, both apps keep the score they show) or could not store it (CivicRecordWriteFailed: it answered from what it read, but the record did not keep what rose). Check /aws/lambda/FetchCivicScore for "Civic Score record": AccessDeniedException means the role lost dynamodb:GetItem or UpdateItem on UserPII, throttling means the table\'s capacity; one write failure after concurrent reads of one user is harmless. Rolling FetchCivicScore back shows the old scores (RUNBOOK 19.6).',
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(readFailed, 0) + FILL(writeFailed, 0)',
        usingMetrics: {
          readFailed: new cloudwatch.Metric({
            namespace: CIVIC_SCORE_METRIC_NAMESPACE,
            metricName: 'CivicRecordReadFailed',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
          writeFailed: new cloudwatch.Metric({
            namespace: CIVIC_SCORE_METRIC_NAMESPACE,
            metricName: 'CivicRecordWriteFailed',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        },
        period: cdk.Duration.minutes(5),
        label: 'Civic Score record reads and writes that failed',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // C1.9: only the weekly digest age is left. The bills and congress members manifest ages read the
    // API's generatedAt, which is the request time, so their alarms could never fire; the canary no longer
    // emits them. Billboard-Freshness-BillsManifestWriter and -BillsManifestSnapshot, the snapshot page
    // member and FetchCongressMembersList's failure destination cover the manifests instead.
    const productFreshnessMetrics = [
      {
        id: 'WeeklyDigestFreshnessAlarm',
        metricName: 'WeeklyDigestAgeSeconds',
        description: 'Weekly digest freshness exceeded 8 days.',
        thresholdSeconds: 8 * 24 * 60 * 60,
      },
    ];
    const productFreshnessMetric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: 'BillBoard/ProductHealth',
        metricName,
        statistic: 'Maximum',
        period: cdk.Duration.minutes(15),
      });

    productFreshnessMetrics.forEach(({ id, metricName, description, thresholdSeconds }) => {
      notify('service', new cloudwatch.Alarm(this, id, {
        alarmName: `Billboard-ProductHealth-${metricName}`,
        alarmDescription: `${description} Check the user API synthetic canary and manifest generation Lambda logs. Needs the canary smoke-test secret (userApiSmokeTestSecretName context): only the canary's authenticated steps emit this metric, so without the secret the alarm has no data and stays OK.`,
        metric: productFreshnessMetric(metricName),
        threshold: thresholdSeconds,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));
    });

    const createBillsManifestDailyInvocations = this.createLambdaMetric(
      'CreateBillsManifest',
      'Invocations',
      'Sum',
      cdk.Duration.days(1),
    );
    // Canary-independent freshness check: FILL turns a day with no invocations into a 0
    // datapoint, and missing data is breaching in case the whole window is empty.
    notify('service', new cloudwatch.Alarm(this, 'BillsManifestWriterFreshnessAlarm', {
      alarmName: 'Billboard-Freshness-BillsManifestWriter',
      alarmDescription: 'CreateBillsManifest has not run for 3 consecutive days, so the bills manifest the app reads is going stale. Check BillsManifestQueue and its DLQ, the upstream FetchRawBill/BillDiffer/BillSummarizer alarms, and CreateBillsManifest logs. A long congressional recess with no bill updates can also trip this.',
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(m, 0)',
        usingMetrics: { m: createBillsManifestDailyInvocations },
        label: 'CreateBillsManifest invocations per day',
        period: cdk.Duration.days(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    // The per-function Errors alarm (2 of 3 five-minute windows) can miss a nightly job: a run that
    // fails fast and its two async retries land within about three minutes. So this alarms on the
    // absence of a successful run instead: invocations minus errors, per hour, for 26 hours.
    notify('service', new cloudwatch.Alarm(this, 'CognitoUserExportFreshnessAlarm', {
      alarmName: 'Billboard-Freshness-CognitoUserExport',
      alarmDescription: 'ExportCognitoUsers has not completed a run in 26 hours, so the newest Cognito user export (the list used to re-invite users if the pool is lost) is getting old. Check /aws/lambda/ExportCognitoUsers logs and the ExportCognitoUsersSchedule rule (daily at 08:00 UTC). After a first deploy this stays in ALARM until the first nightly run, or a manual invoke of the prod alias.',
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(invocations, 0) - FILL(errors, 0)',
        usingMetrics: {
          invocations: this.createLambdaMetric('ExportCognitoUsers', 'Invocations', 'Sum', cdk.Duration.hours(1)),
          errors: this.createLambdaMetric('ExportCognitoUsers', 'Errors', 'Sum', cdk.Duration.hours(1)),
        },
        label: 'ExportCognitoUsers successful runs per hour',
        period: cdk.Duration.hours(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      // No invocation at all in the window leaves no datapoints.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    // CB-07: the sign-up filter check emits SignUpFilterCheckPassed=1 on a pass and SignUpFilterCheckDisabled=1 while
    // its switch is off, once a day each. 26 hours without either: every run was inconclusive or failed (those
    // also have their own alarm), it crashed or timed out (no line at all), or the schedule did not run it.
    const signUpFilterCheckMetric = (metricName: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: SIGNUP_FILTER_CHECK_METRIC_NAMESPACE,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      });
    notify('service', new cloudwatch.Alarm(this, 'SignUpFilterCheckFreshnessAlarm', {
      alarmName: 'Billboard-Freshness-SignUpFilterCheck',
      alarmDescription: 'The sign-up filter check (SignUpFilterCheck, CB-07) has not passed, or reported itself off, in 26 hours: every run was inconclusive or failed, it crashed or timed out, or SignUpFilterCheckSchedule (daily at 11:30 UTC) did not run it. Read the "Sign-up filter check" lines in /aws/lambda/SignUpFilterCheck (outcome, reason, stage) and the reason table in RUNBOOK 14.12. Real sign-ups are not affected. While SIGNUP_FILTER_CHECK_ENABLED is false the daily SignUpFilterCheckDisabled keeps this OK. After a first deploy this stays in ALARM until the first 11:30 UTC run, or a manual invoke of SignUpFilterCheck:prod.',
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(passed, 0) + FILL(disabled, 0)',
        usingMetrics: {
          passed: signUpFilterCheckMetric('SignUpFilterCheckPassed'),
          disabled: signUpFilterCheckMetric('SignUpFilterCheckDisabled'),
        },
        label: 'Sign-up filter check passes (or off) per hour',
        period: cdk.Duration.hours(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      // No run at all in the window leaves no datapoints.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    // PublishBillsManifest emits SnapshotBillCount on every run, written or unchanged, and runs every
    // 10 minutes; no datapoint in 30 minutes means three runs in a row failed or never started.
    notify('service', new cloudwatch.Alarm(this, 'BillsManifestSnapshotFreshnessAlarm', {
      alarmName: 'Billboard-Freshness-BillsManifestSnapshot',
      alarmDescription: 'PublishBillsManifest has not completed a run in 30 minutes, so the bills manifest snapshot that FetchBillsManifest points the app at is going stale. Check /aws/lambda/PublishBillsManifest logs and the PublishBillsManifestSchedule (every 10 minutes). After a first deploy this stays in ALARM until the schedule\'s first run, or a manual invoke of PublishBillsManifest:prod.',
      metric: new cloudwatch.Metric({
        namespace: BILLS_MANIFEST_METRIC_NAMESPACE,
        metricName: 'SnapshotBillCount',
        statistic: 'SampleCount',
        period: cdk.Duration.minutes(30),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    // APPF-23: a run that cannot resolve the companion groups emits CompanionResolveFailed=1 and still
    // publishes, with the groups it last stored. One failure can be a passing DynamoDB error; three runs
    // in a row are not.
    notify('service', new cloudwatch.Alarm(this, 'BillsManifestCompanionResolveFailedAlarm', {
      alarmName: 'Billboard-BillsManifest-CompanionResolveFailed',
      alarmDescription: 'PublishBillsManifest could not resolve the companion bill groups on 3 runs in a row (it runs every 10 minutes). It keeps publishing the manifest, with the groups it last stored while COMPANION_GROUPS_ENABLED is true, so new companion pairs do not appear and removed ones stay. Check /aws/lambda/PublishBillsManifest logs for the companion resolution error: BillsManifest access to the BILL_COMPANION_DECL and BILL_COMPANION_GROUPS rows, or the groups row (sk CURRENT) changing under both write attempts. The API readers follow that stored row, so turning COMPANION_GROUPS_ENABLED off takes effect only once a run succeeds again.',
      metric: new cloudwatch.Metric({
        namespace: BILLS_MANIFEST_METRIC_NAMESPACE,
        metricName: 'CompanionResolveFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(10),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    const apnsDeliveredMetric = this.apnsMetric('NumberOfNotificationsDelivered');
    const apnsFailedMetric = this.apnsMetric('NumberOfNotificationsFailed');
    const apnsDeliveryFailuresAlarm = notify('service', new cloudwatch.Alarm(this, 'ApnsDeliveryFailuresAlarm', {
      alarmName: 'Billboard-Notifications-ApnsDeliveryFailures',
      alarmDescription: `SNS failed to deliver 5 or more pushes through the ${APNS_PLATFORM_APPLICATION_NAME} platform application in 5 minutes. Check the APNs certificate, disabled endpoints and UserNotifier logs.`,
      metric: apnsFailedMetric.with({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    const apnsCertificateDaysRemainingMetric = new cloudwatch.Metric({
      namespace: 'BillBoard/Notifications',
      metricName: 'ApnsCertificateDaysRemaining',
      statistic: 'Minimum',
      period: cdk.Duration.days(1),
    });
    notify('service', new cloudwatch.Alarm(this, 'ApnsCertificateExpiryAlarm', {
      alarmName: 'Billboard-Notifications-ApnsCertificateExpiry',
      alarmDescription: 'The APNs certificate in Billboard/ApnsCredentials expires in under 30 days. Renew it in the Apple developer portal and update the secret before pushes stop.',
      metric: apnsCertificateDaysRemainingMetric,
      threshold: 30,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // WeeklyDigestWorker emits WeeklyDigestUsersFailed for every work message (zero included), and
    // GenerateWeeklyDigests for every inline run. No datapoint means no digest work, not a failure.
    notify('service', new cloudwatch.Alarm(this, 'WeeklyDigestUsersFailedAlarm', {
      alarmName: 'Billboard-WeeklyDigest-UsersFailed',
      alarmDescription: 'Weekly digest generation failed for at least one user. The Sunday run fans out to WeeklyDigestWorker: check /aws/lambda/WeeklyDigestWorker logs ("weeklyDigestWorker message summary" errors). A failed message is retried, users already stored are skipped, and after 3 receives it moves to WeeklyDigestDLQ; fix the cause, then redrive the DLQ. A targeted run (GenerateWeeklyDigests invoked with {"userIds":[...]}) logs its failures in /aws/lambda/GenerateWeeklyDigests.',
      metric: new cloudwatch.Metric({
        namespace: WEEKLY_DIGEST_METRIC_NAMESPACE,
        metricName: 'WeeklyDigestUsersFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // C1.2: the same "no successful run" shape as the Cognito export alarm. The resolver runs hourly 06:00
    // to 23:00 New York, so each night has 6 empty hours; 8 is the smallest window that never fires on a
    // healthy night, and leaves about 4 of the priority records' 12 hours to fix it. A run that succeeds
    // on an async retry lands in the same or the next hour and counts.
    notify('service', new cloudwatch.Alarm(this, 'BillPriorityResolverHeartbeatAlarm', {
      alarmName: 'Billboard-Heartbeat-BillPriorityResolver',
      alarmDescription: 'BillPriorityResolver has not completed a run in 8 hours (it runs hourly 06:00-23:00 New York), so the priority bills in the feed expire unrefreshed after 12 hours. Check /aws/lambda/BillPriorityResolver logs, the BillPriorityResolverSchedule (enabled?) and ScheduledJobFailures for a delivery failure.',
      metric: this.successfulRunsMetric('BillPriorityResolver', cdk.Duration.hours(1), 'BillPriorityResolver successful runs per hour'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 8,
      datapointsToAlarm: 8,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    // LLM-11: a resolver run with no usable model answer emits PriorityResolverNoAnswer=1 and still succeeds,
    // so the heartbeat and the Errors alarm stay quiet: a throw would be retried twice, refused again, and
    // trip the Errors alarm and a CodeDeploy rollback on one bad hour. One such hour can be noise; 3 of the
    // last 6 runs is not.
    notify('service', new cloudwatch.Alarm(this, 'PriorityNoModelAnswerAlarm', {
      alarmName: 'Billboard-Priority-NoModelAnswer',
      alarmDescription: 'BillPriorityResolver got no usable answer from Bedrock in at least 3 of the last 6 hours (PriorityResolverNoAnswer): a refusal, an answer cut at max_tokens, no text, or output it could not parse. Each such run keeps the active priority bills until they expire, activates none and succeeds, so neither its Errors alarm nor its heartbeat fires. The priority_no_answer lines in /aws/lambda/BillPriorityResolver give the reason, stop_reason, refusal category and output tokens. Repeated max_tokens stops need a higher BILL_PRIORITY_MAX_OUTPUT_TOKENS; refusals that began with a model switch call for moving the prod alias back (RUNBOOK 11.7).',
      metric: this.bedrockMetric('PriorityResolverNoAnswer', cdk.Duration.hours(1)),
      threshold: 1,
      evaluationPeriods: 6,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // C1.3 with X6: UserNotifier emits NotificationsExpiredUndelivered (no dimensions) for pending rows past
    // their 24-hour lifetime. In normal running none reaches 24 hours, so any datapoint is worth a look.
    notify('service', new cloudwatch.Alarm(this, 'NotificationsExpiredUndeliveredAlarm', {
      alarmName: 'Billboard-Notifications-ExpiredUndelivered',
      alarmDescription: 'UserNotifier found pending pushes past their 24-hour lifetime in the last day. With PENDING_EXPIRY_MODE=watch they were still sent and deleted as before (log outcome "would_expire"); with enforce they were deleted unsent (outcome "expired"). After a push outage longer than 24 hours this is expected. Otherwise suspect a unit mismatch between the rows\' ttl/createdAt and the clock, and do not flip to enforce: check /aws/lambda/UserNotifier for "Bill notification outcome" lines with ageSeconds.',
      metric: new cloudwatch.Metric({
        namespace: NOTIFICATIONS_METRIC_NAMESPACE,
        metricName: 'NotificationsExpiredUndelivered',
        statistic: 'Sum',
        period: cdk.Duration.days(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // UX-33: UserNotifier emits NotificationsHeldPastLifetime (no dimensions) for pending rows a hold (the quiet hours or
    // the push pace) keeps past their 24-hour lifetime. Neither hold is that long on its own, so any datapoint means
    // rows that were already late, which DynamoDB may delete unsent before the hold ends.
    notify('service', new cloudwatch.Alarm(this, 'NotificationsHeldPastLifetimeAlarm', {
      alarmName: 'Billboard-Notifications-HeldPastLifetime',
      alarmDescription: `UserNotifier held pending pushes (quiet hours 9 PM to 8 AM, or the ${PUSH_PACE_HOURS}-hour push pace) past their 24-hour lifetime in the last day. Neither hold is long enough on its own (at most a pace window and then the night), so these rows were already late, most likely from a push outage (see Billboard-Notifications-ExpiredUndelivered and the DLQs); DynamoDB may delete them unsent before the hold ends. In /aws/lambda/UserNotifier the warning "Holding pending notifications past their 24-hour lifetime" names the user, the rows, heldUntil and holdReason. To send them now (RUNBOOK 18.6): outside the user's quiet hours, delete their __pace__#<user> item, then their __claim__#<user> items; a claim deleted alone is held again for the pace. In their quiet hours either way holds them again until 8 AM, unless QUIET_HOURS_ENABLED is set to false.`,
      metric: new cloudwatch.Metric({
        namespace: NOTIFICATIONS_METRIC_NAMESPACE,
        metricName: 'NotificationsHeldPastLifetime',
        statistic: 'Sum',
        period: cdk.Duration.days(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // C1.10: CleanupOrphanedUsers emits AccountDeletionsStuck (stale in_progress plus failed deletion
    // claims) on every run, 0 included.
    notify('service', new cloudwatch.Alarm(this, 'AccountDeletionsStuckAlarm', {
      alarmName: 'Billboard-Accounts-DeletionsStuck',
      alarmDescription: 'The daily CleanupOrphanedUsers run found account deletions that did not finish: in_progress claims older than RESUME_MIN_STALE_HOURS, or failed ones. While DRY_RUN is true it only reports them (wouldResume, failedDeletions in "cleanupOrphanedUsers summary" in /aws/lambda/CleanupOrphanedUsers); a failed deletion can be retried by the user from the app. See the RUNBOOK account deletion safety net section.',
      metric: new cloudwatch.Metric({
        namespace: ACCOUNTS_METRIC_NAMESPACE,
        metricName: 'AccountDeletionsStuck',
        statistic: 'Maximum',
        period: cdk.Duration.days(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // REL-53: the daily cleanup's unconfirmed sign-up step emits UnconfirmedSignUpCleanupErrors on every run while it
    // is on, 0 included: a call that failed, Cognito or DynamoDB still throttling after its retries, or the step
    // itself failing (the handler emits 1 for it). Same shape as the deletions-stuck alarm above.
    notify('service', new cloudwatch.Alarm(this, 'UnconfirmedSignUpCleanupErrorsAlarm', {
      alarmName: 'Billboard-Accounts-UnconfirmedSignUpCleanupErrors',
      alarmDescription: `The daily CleanupOrphanedUsers run could not finish deleting sign-ups left unconfirmed for ${UNCONFIRMED_SIGNUP_MAX_AGE_HOURS} hours (REL-53): ListUsers, AdminGetUser, AdminDeleteUser or a table read or delete failed, Cognito kept throttling, or the step itself failed (stepFailed). Nothing else in the run is affected, and the next daily run retries (every step is safe to repeat). Read unconfirmedSignUps (errorNames, stoppedByThrottling) in "cleanupOrphanedUsers summary" in /aws/lambda/CleanupOrphanedUsers. To stop the step, set UNCONFIRMED_SIGNUP_CLEANUP_MODE to off and deploy. RUNBOOK 8.2.`,
      metric: new cloudwatch.Metric({
        namespace: ACCOUNTS_METRIC_NAMESPACE,
        metricName: 'UnconfirmedSignUpCleanupErrors',
        statistic: 'Sum',
        period: cdk.Duration.days(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // ── Account integrity (C2 3.11) ─────────────────────────────────────────
    //
    // SetFeedback, DistrictVerification and PreSignUpCheck write these as EMF lines without dimensions under
    // BillBoard/AccountIntegrity. While a switch they watch is in watch mode, these alarms are how the project
    // learns whether a flip to enforce would have refused someone real. Thresholds: abuse-limits.ts.
    const integrityMetric = (metricName: string, period: cdk.Duration): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: ACCOUNT_INTEGRITY_METRIC_NAMESPACE,
        metricName,
        statistic: 'Sum',
        period,
      });
    const detectionPeriod = ({ periodMinutes }: DetectionThreshold): cdk.Duration =>
      periodMinutes % 60 === 0 ? cdk.Duration.hours(periodMinutes / 60) : cdk.Duration.minutes(periodMinutes);
    const detectionWindow = ({ periodMinutes }: DetectionThreshold): string =>
      periodMinutes % 60 === 0 ? `${periodMinutes / 60} hour${periodMinutes === 60 ? '' : 's'}` : `${periodMinutes} minutes`;
    const ordinal = (value: number): string => {
      const lastTwo = value % 100;
      const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[value % 10] ?? 'th';
      return `${value}${suffix}`;
    };
    const {
      voteDailyCapExceeded,
      voteVelocity,
      addressVerificationBurst,
      addressCapSignal,
    } = ACCOUNT_INTEGRITY_ALARM_THRESHOLDS;
    const integrityAlarm = (
      id: string,
      name: string,
      description: string,
      metric: cloudwatch.IMetric,
      threshold: number,
    ): cloudwatch.Alarm =>
      notify('integrity', new cloudwatch.Alarm(this, id, {
        alarmName: `Billboard-Integrity-${name}`,
        alarmDescription: description,
        metric,
        threshold,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));

    integrityAlarm(
      'IntegrityVoteDailyCapExceededAlarm',
      'VoteDailyCapExceeded',
      `An account made more than ${VOTE_DAILY_LIMIT} vote writes in one UTC day (INT-06). With VOTE_DAILY_CAP_MODE=watch every vote was still written; with enforce the extra writes got 429 VOTE_DAILY_LIMIT. /aws/lambda/SetFeedback has the account (userId, voteDay, voteDayCount on the VoteDailyCapExceeded lines). Old app builds record a swipe-left as an Abstain write, so check the pattern before any flip: enforce waits until no account went above ${VOTE_DAILY_CAP_ENFORCE_READY_MAX} writes on any day.`,
      integrityMetric('VoteDailyCapExceeded', detectionPeriod(voteDailyCapExceeded)),
      voteDailyCapExceeded.threshold,
    );
    integrityAlarm(
      'IntegrityVoteVelocityAlarm',
      'VoteVelocity',
      `At least ${voteVelocity.threshold} votes were written across all accounts in ${detectionWindow(voteVelocity)} (VotesCast from SetFeedback), far above normal traffic: a scripted vote flood, or a launch-day spike. /aws/lambda/SetFeedback names the accounts behind it (userId on each VotesCast line); also check Billboard-Integrity-VoteDailyCapExceeded.`,
      integrityMetric('VotesCast', detectionPeriod(voteVelocity)),
      voteVelocity.threshold,
    );
    integrityAlarm(
      'IntegrityAddressVerificationBurstAlarm',
      'AddressVerificationBurst',
      `At least ${addressVerificationBurst.threshold} address verifications succeeded in ${detectionWindow(addressVerificationBurst)} (AddressVerified from DistrictVerification). Real accounts verify rarely, so a burst can be address farming. Check /aws/lambda/DistrictVerification and Billboard-Integrity-AddressCapSignal.`,
      integrityMetric('AddressVerified', detectionPeriod(addressVerificationBurst)),
      addressVerificationBurst.threshold,
    );
    integrityAlarm(
      'IntegrityAddressCapSignalAlarm',
      'AddressCapSignal',
      `An address verification hit an INT-03 limit in the last hour: a ${ordinal(MAX_VERIFIED_ACCOUNTS_PER_ADDRESS + 1)} verified account at one address and unit (AddressLimitReached), a ${ordinal(MAX_ADDRESS_CHANGES_PER_WINDOW + 1)} address change by one account in ${ADDRESS_CHANGE_WINDOW_DAYS} days (ReverificationLimitReached), or more than ${STREET_CLUSTER_FLAG_THRESHOLD} verified accounts across one street address (StreetClusterFlagged). With VERIFICATION_LIMITS_MODE=watch nothing was refused. Check /aws/lambda/DistrictVerification; flip to enforce only if no signal came from a real household.`,
      new cloudwatch.MathExpression({
        expression: 'SUM([addressLimit, reverificationLimit, streetCluster])',
        usingMetrics: {
          addressLimit: integrityMetric('AddressLimitReached', detectionPeriod(addressCapSignal)),
          reverificationLimit: integrityMetric('ReverificationLimitReached', detectionPeriod(addressCapSignal)),
          streetCluster: integrityMetric('StreetClusterFlagged', detectionPeriod(addressCapSignal)),
        },
        label: 'INT-03 limit signals per hour',
        period: detectionPeriod(addressCapSignal),
      }),
      addressCapSignal.threshold,
    );
    // REL-46: a district lookup fell back to Current_Current because the geocoder rejected the vintage it was
    // asked for, or answered a match with no congressional layer. The account then got the 120th lines before
    // 2027-01-03, or the 2025 Missouri map, which is not in effect.
    integrityAlarm(
      'IntegrityGeocoderVintageFallbackAlarm',
      'GeocoderVintageFallback',
      'A district lookup in the last hour fell back to the geocoder\'s Current_Current vintage (GeocoderVintageFallback from DistrictVerification, REL-46). The vintage it asked for (ACS2025_Current: the 119th lines until 2027-01-03 17:00 UTC, and Missouri always) was rejected, or the match had no congressional layer. That account was stored with the 120th lines early, or with the 2025 Missouri map, which is not in effect. Check /aws/lambda/DistrictVerification for "Census geocoder gave no usable answer" (state and vintage names), then RUNBOOK 14.4: if Census retired ACS2025_Current, pick the vintage that still serves the 119th lines and deploy.',
      integrityMetric('GeocoderVintageFallback', cdk.Duration.hours(1)),
      1,
    );
    integrityAlarm(
      'IntegritySignUpFilterHitsAlarm',
      'SignUpFilterHits',
      'The pre-sign-up filter matched a self-service sign-up in the last hour (INT-05): a disposable email domain, or a second account on one base address (a +tag or Gmail dots). With SIGNUP_FILTER_MODE=watch the sign-up went ahead; with enforce it was refused. /aws/lambda/PreSignUpCheck logs the reason, and the domain for a disposable hit, never the address. Flip to enforce only if every hit was a test or a real disposable address.',
      integrityMetric('SignUpFilterHit', cdk.Duration.hours(1)),
      1,
    );
    integrityAlarm(
      'IntegritySignUpFilterErrorsAlarm',
      'SignUpFilterErrors',
      'PreSignUpCheck could not finish a check in the last 15 minutes (PreSignUpCheckError: SignUpEmailClaims, Cognito AdminGetUser, the hash salt secret, or the 3.5-second deadline) and let the sign-up through. The filter fails open, so sign-ups still work, unfiltered. Check /aws/lambda/PreSignUpCheck. Only if the function itself breaks sign-up: set PRE_SIGN_UP_TRIGGER_ENABLED=false and deploy UserAPIServiceStack (RUNBOOK section 14).',
      integrityMetric('PreSignUpCheckError', cdk.Duration.minutes(15)),
      1,
    );
    // CB-07: a failed check run, or a run whose sweep removed what an earlier run (or a stranger at the probe
    // address) left. Inconclusive runs have no alarm of their own; the freshness alarm catches them after 26 hours.
    integrityAlarm(
      'IntegritySignUpFilterCheckFailedAlarm',
      'SignUpFilterCheckFailed',
      'The sign-up filter check (SignUpFilterCheck, CB-07) failed in the last hour, or its sweep removed leftovers of an earlier run (SignUpFilterCheckFailed + SignUpFilterCheckSwept). A fail means PreSignUpCheck did not allow and claim the check address, did not record the +tag hit (watch) or refuse it (enforce), or the check could not remove its own test accounts. Read the "Sign-up filter check" line in /aws/lambda/SignUpFilterCheck (reason, stage) and the reason table in RUNBOOK 14.12; base_check_error and filter_silent are real filter faults. Real sign-ups are not affected by the check. Turn it off (SIGNUP_FILTER_CHECK_ENABLED false) only if the check itself misbehaves.',
      new cloudwatch.MathExpression({
        expression: 'FILL(failed, 0) + FILL(swept, 0)',
        usingMetrics: {
          failed: signUpFilterCheckMetric('SignUpFilterCheckFailed'),
          swept: signUpFilterCheckMetric('SignUpFilterCheckSwept'),
        },
        label: 'Sign-up filter check failures and swept leftovers per hour',
        period: cdk.Duration.hours(1),
      }),
      1,
    );

    // ── App Attest (C3 3.11) ────────────────────────────────────────────────
    //
    // Routine alarms, none paging (C3: consider adding Billboard-AppAttest-Rejected to the app-broken page once
    // sign-up enforcement is on).
    addAppAttestAlarms(this, (alarm) => notify('appAttest', alarm));

    // ── Email (REL-54) ──────────────────────────────────────────────────────
    //
    // Routine, none paging. SES reviews an account at a 5% bounce rate or a 0.1% complaint rate and may pause its
    // sending at 10% or 0.5%; the user pool sends its sign-up and reset codes through SES (REL-54 step 2), so a paused
    // account sends none. Both alarm well before review. The metrics are historic rates SES updates as it sends, so an
    // hour with nothing sent can have no datapoint while the rate is still high. Missing data is ignored, as AWS
    // advises for these alarms (SES Developer Guide, "Creating reputation monitoring alarms using CloudWatch"): an
    // alarm keeps its state between datapoints, so it stays in ALARM (one message) until SES publishes a rate below
    // the threshold, and it is INSUFFICIENT_DATA until the first datapoint.
    const sesReputationMetric = (metricName: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: SES_METRIC_NAMESPACE,
        metricName,
        statistic: 'Maximum',
        period: cdk.Duration.hours(1),
      });
    const percent = (rate: number): string => `${Number((rate * 100).toFixed(4))}%`;
    const sesBounceRateMetric = sesReputationMetric('Reputation.BounceRate');
    const sesComplaintRateMetric = sesReputationMetric('Reputation.ComplaintRate');
    notify('email', new cloudwatch.Alarm(this, 'SesBounceRateAlarm', {
      alarmName: 'Billboard-Email-BounceRate',
      alarmDescription: `SES's bounce rate for this account (Reputation.BounceRate, hard bounces over a representative volume) reached ${percent(SES_BOUNCE_RATE_ALARM_THRESHOLD)}. SES puts the account under review at 5% and may pause its sending at 10%; the user pool sends its sign-up and reset codes through SES (REL-54 step 2), so a paused account sends none. Bounces here are mostly sign-ups with mistyped or made-up addresses. Check the BillboardAccountEmail counts on the BillboardOps dashboard (row 8), the bounce reports SES forwards to no-reply@billboard-project.com, the sign-up filter alarms (Billboard-Integrity-SignUpFilter*) and the WAF sign-up rule. RUNBOOK 23.5.`,
      metric: sesBounceRateMetric,
      threshold: SES_BOUNCE_RATE_ALARM_THRESHOLD,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    }));
    notify('email', new cloudwatch.Alarm(this, 'SesComplaintRateAlarm', {
      alarmName: 'Billboard-Email-ComplaintRate',
      alarmDescription: `SES's complaint rate for this account (Reputation.ComplaintRate, messages recipients marked as spam over a representative volume) reached ${percent(SES_COMPLAINT_RATE_ALARM_THRESHOLD)}. SES puts the account under review at 0.1% and may pause its sending at 0.5%; the user pool sends its sign-up and reset codes through SES (REL-54 step 2), so a paused account sends none. A complaint about a code email usually comes from someone who never signed up: their address typed by someone else, or a bot's sign-ups. Check the BillboardAccountEmail counts on the BillboardOps dashboard (row 8), the complaint reports SES forwards to no-reply@billboard-project.com and the sign-up filter alarms (Billboard-Integrity-SignUpFilter*). RUNBOOK 23.5.`,
      metric: sesComplaintRateMetric,
      threshold: SES_COMPLAINT_RATE_ALARM_THRESHOLD,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    }));

    // ── Ingestion pipeline ──────────────────────────────────────────────────

    // REL-45: FetchRawBill counts BillTextUnavailable (no dimensions, plus a {Reason} copy) once per bill stored
    // without text although a Formatted XML URL existed and no retry is pending: every source answered 404 (GovInfo:
    // 302 to /error), 5xx or a network error after the in-process retries, or an invalid body, or still refused after
    // 3 delayed retries (at once for a refetch:stale-bills message, which carries noTextRetry).
    const billTextUnavailableMetric = this.ingestionMetric(
      'BillTextUnavailable',
      'Sum',
      undefined,
      cdk.Duration.hours(3),
    );
    const congressApi429Metric = this.ingestionMetric('CongressApi429');
    const congressApiAuthFailureMetric = this.ingestionMetric('CongressApiAuthFailure');
    const billPollerLagMetric = this.ingestionMetric(
      'BillPollerLagSeconds',
      'Maximum',
      undefined,
      cdk.Duration.minutes(15),
    );

    // REL-45 replaced Billboard-Ingestion-BillXmlFetchFailure (any single failed request on congress.gov, 1 in 5
    // minutes; 9 firings in the week to 2026-10-16, each one execution environment refused by www.congress.gov).
    // GovInfo is tried first, a refusal is retried about 10 minutes later (often on another environment), and a
    // bill whose text is stored makes no request, so one blocked environment no longer fires. A real outage still
    // does: every fetch ends final within about 30 minutes (at once for 404 and 5xx), so 3 bills arrive within an
    // hour when busy and within 3 to 4 hours on a quiet day; the alarm stays in ALARM, one email, and clears itself.
    // Not a member of Billboard-Ingest-Unhealthy: bills still flow and existing summaries are kept.
    notify('ingestion', new cloudwatch.Alarm(this, 'BillTextUnavailableAlarm', {
      alarmName: 'Billboard-Ingestion-BillTextUnavailable',
      alarmDescription:
        'FetchRawBill stored 3 or more bills in 3 hours without their text although Congress.gov lists a Formatted XML version (BillTextUnavailable): GovInfo and www.congress.gov both failed (404, 5xx, network, invalid body), or refused after 3 delayed retries. Those bills get no new summary and new ones stay out of the app until text is fetched. Check the Reason dimension, the "Failed to fetch bill XML" lines in /aws/lambda/FetchRawBill (status, server, cf-ray, cf-mitigated, body excerpt) and RUNBOOK 4.10 (the BILL_XML_SOURCES switch, recovery).',
      metric: billTextUnavailableMetric,
      threshold: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    notify('ingestion', new cloudwatch.Alarm(
      this,
      'CongressApi429Alarm',
      {
        alarmDescription:
          'Sustained Congress API 429 responses detected across ingest lanes. Back off replay jobs and check Congress API quota pressure.',
        alarmName: 'Billboard-Ingestion-CongressApi429',
        metric: congressApi429Metric,
        threshold: 5,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    ));

    notify('ingestion', new cloudwatch.Alarm(this, 'CongressApiAuthFailureAlarm', {
      alarmName: 'Billboard-Ingestion-CongressApiAuthFailure',
      alarmDescription: 'Congress.gov rejected the API key (401/403). Ingestion stops until it is fixed. Check the Congress API key secret: it may have been rotated, revoked or rate-banned.',
      metric: congressApiAuthFailureMetric,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // REL-52: CongressMemberSummarizer merges a current senator's per-Congress entries into terms by the seat's class
    // from the Senate's list of senators (senate.gov). When that list cannot be read, or does not name the senator (one
    // new to the list, or one who has left while congress.gov still marks them current), the class is inferred from the
    // state, which can give one term fewer for an appointed senator; the member is still stored. Counted once per
    // senator (SenateClassInferred, no dimensions). A members refresh sends the ~100 senators within minutes,
    // so a 1-hour period holds one run; the alarm clears itself the hour after (a senator who has left fires it again
    // on each refresh (weekly, daily Jan 2-17, 2027) until congress.gov marks them gone and the pipeline retires them). Routine, not a member
    // of Billboard-Ingest-Unhealthy: members keep flowing.
    notify('ingestion', new cloudwatch.Alarm(this, 'SenateClassInferredAlarm', {
      alarmName: 'Billboard-Ingestion-SenateClassInferred',
      alarmDescription: 'CongressMemberSummarizer stored a current senator with terms merged by an inferred Senate class (SenateClassInferred): the Senate\'s list of senators (senate.gov senators_cfm.xml) could not be read (reason list_unavailable: an outage, a block or a changed format), or does not name the senator or names another state (not_listed, state_mismatch): a new senator the list does not show yet, or a senator who has left whom congress.gov still marks current (retired by the first members refresh after congress.gov marks them gone). Their "Terms served" can be one too few meanwhile. Check /aws/lambda/CongressMemberSummarizer for "Could not read the Senate\'s list of senators" and "No Senate class for a current senator" (bioguide ID and state), then RUNBOOK 21.2 to tell the cases apart (for a new senator, rerun with reprocess:congress-members, 21.5).',
      metric: this.ingestionMetric('SenateClassInferred', 'Sum', undefined, cdk.Duration.hours(1)),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // The user-impact signal for bill ingestion. BillsApiPoller emits the lag on every run that
    // reaches its end, a run that finds congress.gov unavailable included: the time from the start of
    // the last run that polled (lastPolledAt) to the end of this one. An outage keeps it growing and
    // fires this after an hour, not on the first failed request; the run that polls again reports a
    // few seconds. During a long outage a lucky run that gets through resets the lag, so a 1-of-1 alarm
    // fired again each time (the weekend of 2026-11-07: 6 notifications for one outage, each doubled by the
    // composite). So it looks at the last 12 windows of 15 minutes: any one at 1 hour of lag puts it in ALARM,
    // and it clears only after 3 hours without one, so an outage that comes and goes notifies once. A window
    // with no datapoint is not breaching here: that is our own failure (every run failing before its end,
    // the schedule stopped, a RUNBOOK 4.1 quiet window, or with POLL_TARGETS the newest Congress failed or
    // skipped: BillPollerTargetError, BillPollerStateMismatch), and Billboard-Heartbeat-BillsApiPoller below
    // takes that job in 30 minutes.
    const billPollerLagAlarm = notify('ingestion', new cloudwatch.Alarm(this, 'BillPollerLagAlarm', {
      alarmName: 'Billboard-Ingestion-BillPollerLag',
      alarmDescription: `BillsApiPoller reported a lag of ${BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS / 60} minutes or more (BillPollerLagSeconds, measured from the start of the last run that met no outage) in at least one of the last 12 fifteen-minute windows. It stays in ALARM until 3 hours pass without one, so an outage that comes and goes notifies once; it clearing does not mean congress.gov is back. Only runs that found congress.gov unavailable (CongressApiUnavailable) report this much lag, so congress.gov is down, or was within the last 3 hours, and new and changed bills wait until it answers: the poller keeps its cursors and catches up by itself (RUNBOOK 6.2). Missing datapoints do not fire this: Billboard-Heartbeat-BillsApiPoller does (RUNBOOK 6.1).`,
      metric: billPollerLagMetric,
      threshold: BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS,
      evaluationPeriods: 12,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // The poller's own failures show up as MISSING lag datapoints, not as lag. Every run that finishes polling
    // the newest Congress emits one (a congress.gov outage included), so 2 empty 15-minute windows mean every
    // run failed before that point (the Errors alarm fires too), the schedule stopped or a RUNBOOK 4.1 quiet
    // window was left open, or the newest Congress failed or was skipped (BillPollerTargetError,
    // BillPollerStateMismatch) while the runs succeed. FILL turns a window with no datapoint into 0 samples.
    // A member of Billboard-Ingest-Unhealthy.
    const billPollerHeartbeatAlarm = notify('ingestion', new cloudwatch.Alarm(this, 'BillsApiPollerHeartbeatAlarm', {
      alarmName: 'Billboard-Heartbeat-BillsApiPoller',
      alarmDescription: 'BillsApiPoller emitted no BillPollerLagSeconds for 30 minutes (every run that finishes polling the newest Congress emits one, a congress.gov outage included): every run is failing before that point (Billboard-Lambda-BillsApiPoller-Errors fires too), the schedule is stopped or a RUNBOOK 4.1 quiet window was left open, or the newest Congress failed or was skipped (BillPollerTargetError or BillPollerStateMismatch with its Congress, while the runs do not fail; RUNBOOK 6.3, 24.2). New and changed bills are not reaching the app. RUNBOOK 6.1.',
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(lagSamples, 0)',
        usingMetrics: {
          lagSamples: this.ingestionMetric('BillPollerLagSeconds', 'SampleCount', undefined, cdk.Duration.minutes(15)),
        },
        label: 'BillsApiPoller lag datapoints per 15 minutes',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    // REL-46: with POLL_TARGETS the lag above is the newest Congress's. From 2027-01-03 the 119th is trailing: polled
    // after the 120th while time remains, and its own lag (Congress=119) is emitted only by runs that poll it. So no
    // datapoint for 3 hours is breaching too: it failed every run (BillPollerTargetError), its parameter holds another
    // congress, or the 120th left it no time. Goes in the PR that takes the 119th out of POLL_TARGETS (after
    // 2027-03-31): from then on it would only see missing data. Routine, not a member of Billboard-Ingest-Unhealthy.
    notify('ingestion', new cloudwatch.Alarm(this, 'BillPollerLag119Alarm', {
      alarmName: 'Billboard-Ingestion-BillPollerLag119',
      alarmDescription: `BillsApiPoller has not polled the 119th Congress for ${BILL_POLLER_TRAILING_LAG_ALARM_THRESHOLD_SECONDS / 3600} hours (BillPollerLagSeconds with Congress=119), or no run polled it in that time. Late 119th outcomes (signings, vetoes, public law numbers) are not reaching the app. Check BillPollerTargetError and BillPollerStateMismatch (Congress=119), the "Bill poller failed for a congress" lines in /aws/lambda/BillsApiPoller and the 119th's state, /billboard/congress/bills-poller-state (RUNBOOK 6.3). In a congress.gov outage it follows Billboard-Ingestion-BillPollerLag after about 3 hours: the same outage, nothing more to do (RUNBOOK 6.2). Remove this alarm when the 119th leaves POLL_TARGETS.`,
      metric: this.ingestionMetric('BillPollerLagSeconds', 'Maximum', { Congress: '119' }, cdk.Duration.hours(3)),
      threshold: BILL_POLLER_TRAILING_LAG_ALARM_THRESHOLD_SECONDS,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    // REL-46: a POLL_TARGETS state parameter that holds another congress than its mapping. The poller skips that
    // Congress on every run and never writes the parameter, so it stays unpolled until someone looks. BillPollerStateMismatch
    // is counted without dimensions too, for any Congress. Routine.
    notify('ingestion', new cloudwatch.Alarm(this, 'BillPollerStateMismatchAlarm', {
      alarmName: 'Billboard-Ingestion-BillPollerStateMismatch',
      alarmDescription: 'A BillsApiPoller state parameter holds another congress than POLL_TARGETS maps to it (BillPollerStateMismatch; the Congress dimension says which). The poller skips that Congress on every run and never writes its parameter, so none of its bills are polled. Read the parameter and the "stored for another congress" line in /aws/lambda/BillsApiPoller, then RUNBOOK 6.3.',
      metric: this.ingestionMetric('BillPollerStateMismatch'),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // REL-56: the poller's watermark needs congress.gov's list filter to work well below a day, since its rows show
    // updateDate as a date only. The first run of each hour counts hr rows over the whole day before and over one
    // second of it (18:00:00Z); that second counting as many as the day, or more than 10, means the filter matches
    // whole days or hours. An answer with no pagination.count, or the filter rejected, is counted too: the check cannot
    // tell then. Nothing is skipped, but every run enqueues the whole day (or hour) again, more than FetchRawBill and the
    // key's 5,000 requests an hour can take. Routine, not a member of Billboard-Ingest-Unhealthy: bills still flow.
    notify('ingestion', new cloudwatch.Alarm(this, 'BillPollerFilterImpreciseAlarm', {
      alarmName: 'Billboard-Ingestion-BillPollerFilterImprecise',
      alarmDescription: 'BillsApiPoller\'s hourly check found that congress.gov\'s bill list filter does not work below an hour or a day (one second of the day before counted as many hr rows as the whole day, or more than 10), or could not tell (no pagination.count, or the filter rejected) (BillPollerFilterImprecise). The poller skips nothing, but each run enqueues every bill updated that day (or hour) again, so FetchRawBill falls behind (Billboard-SQS-UpdatedBillsQueue-OldestMessageAge) and the congress.gov key nears its hourly limit (Billboard-Ingestion-CongressApi429). Check the "congress.gov\'s list filter" error lines in /aws/lambda/BillsApiPoller, then RUNBOOK 6.1.',
      metric: this.ingestionMetric('BillPollerFilterImprecise', 'Sum', undefined, cdk.Duration.hours(1)),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // REL-56: the poller reads a window by offset, each page starting 25 rows before the end of the one before. A page
    // that shares none of them, a backlog's window that lost more rows than that since its last page, or a window read
    // to its end that listed fewer rows than congress.gov counts in it means rows moved without being read: the scan
    // reads them again (from further up, at most twice a scan; the whole window once). Routine.
    notify('ingestion', new cloudwatch.Alarm(this, 'BillPollerPageDriftAlarm', {
      alarmName: 'Billboard-Ingestion-BillPollerPageDrift',
      alarmDescription: 'BillsApiPoller found congress.gov\'s bill list moving while it read a window (BillPollerPageDrift): a page shared none of the 25 rows it overlaps with the page before, or a window listed fewer rows than congress.gov counts in it (many rows left the window while it was read, the order of rows with the same time changed between requests, or rows showed in it while it was read again). The scan read the rows again. Rows may have been missed only where it logged an error ("kept moving between pages", or "still counted more rows than the scan listed", which names the window) or the warning "Rows still showed in congress.gov\'s list while the window was read" (which names the window too). Check those lines in /aws/lambda/BillsApiPoller, then RUNBOOK 6.1.',
      metric: this.ingestionMetric('BillPollerPageDrift', 'Sum', undefined, cdk.Duration.hours(1)),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // REL-56: congress.gov rejecting the list's fromDateTime (an API change) turns on the poller's unfiltered fallback.
    // Its rows show the date only, so every run then enqueues every bill updated since the start of its window's day:
    // the whole day, every 5 minutes. Routine.
    notify('ingestion', new cloudwatch.Alarm(this, 'BillPollerFallbackAlarm', {
      alarmName: 'Billboard-Ingestion-BillPollerFallback',
      alarmDescription: 'BillsApiPoller listed a bill type without its time filter (BillPollerFallbackTypeCount): congress.gov rejected fromDateTime/toDateTime with a 400 or 422. Nothing is skipped, but every run enqueues every bill updated that day again, so FetchRawBill falls behind (Billboard-SQS-UpdatedBillsQueue-OldestMessageAge) and the congress.gov key nears its hourly limit (Billboard-Ingestion-CongressApi429). Check the "Filtered scan rejected" warnings in /aws/lambda/BillsApiPoller, then RUNBOOK 6.1.',
      metric: this.ingestionMetric('BillPollerFallbackTypeCount', 'Sum', undefined, cdk.Duration.hours(1)),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // REL-56: a bill that shows in congress.gov's list more than 120 s (the windows' overlap) after its time is in no
    // window. The first run of each hour lists again a window read an hour before; a bill in it that was not listed
    // then came late. The poller enqueues it, so that one is not lost, but others like it may be. Routine.
    notify('ingestion', new cloudwatch.Alarm(this, 'BillPollerLateRowsAlarm', {
      alarmName: 'Billboard-Ingestion-BillPollerLateRows',
      alarmDescription: 'BillsApiPoller found bills that showed in congress.gov\'s list after the window holding them was read (BillPollerLateRows): more than 120 s after their update time, or congress.gov\'s clock is behind. It enqueued them, but it checks one hr window an hour, so bills like them in other windows were skipped. Check the "showed in congress.gov\'s list after their window was read" warnings in /aws/lambda/BillsApiPoller, then RUNBOOK 6.1.',
      metric: this.ingestionMetric('BillPollerLateRows', 'Sum', undefined, cdk.Duration.hours(1)),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // REL-58: FetchRawBill's retry ladder holds a bill about 6 hours of congress.gov failures before UpdatedBillsDLQ,
    // and SQS leaves a message out of UpdatedBillsQueue's age once it has been received 3 times. When the poller sees
    // the outage too, its lag alarm is the signal (RUNBOOK 6.2). This one is for what it does not see, in any 15
    // minutes: a record failure that is not congress.gov's (Kind=other: S3, SQS, a code error, a 401 or 403, another
    // 4xx, a bill-endpoint 404 past its 38 minutes), which also retries after a minute and dead-letters in about 11;
    // or a bill failing on congress.gov for 30 minutes or more (FetchRawBillFailingSeconds, its 5th receive) while the
    // poller's runs met no outage (CongressApiUnavailable 0): trouble only FetchRawBill sees. In the 90 days to
    // 2026-11-12 neither happened: FetchRawBill's failures without a poller outage (16 windows of 15 minutes) were
    // bill-endpoint 404s that cleared within 6 minutes and timeouts that cleared, or met the poller's outage, within 30.
    // Routine, not a member of Billboard-Ingest-Unhealthy: the bills retry by themselves.
    notify('ingestion', new cloudwatch.Alarm(this, 'FetchRawBillFailingAlarm', {
      alarmName: 'Billboard-Ingestion-FetchRawBillFailing',
      alarmDescription: `FetchRawBill failed a bill for a reason that is not congress.gov's (FetchRawBillRecordFailed with Kind=other: S3, SQS, a code error, a 401 or 403, another 4xx, or a bill-endpoint 404 that outlasted its 38 minutes), or a bill has been failing on congress.gov for ${FETCH_RAW_BILL_FAILING_ALARM_SECONDS / 60} minutes or more (FetchRawBillFailingSeconds) in a 15-minute window when the poller met no outage (CongressApiUnavailable 0). The first comes back after a minute and dead-letters in about 11; the second rides the retry ladder, about 6 hours before UpdatedBillsDLQ, on trouble only FetchRawBill sees: its requests refused or held, a DNS or configuration fault, congress.gov's bill endpoints down while its list answers. Read the "Failed record will be retried" lines in /aws/lambda/FetchRawBill (failureKind, failureStatus, failedEndpoint, receiveCount), then RUNBOOK 6.5.`,
      metric: new cloudwatch.MathExpression({
        expression: `IF(FILL(other, 0) > 0 OR (FILL(failing, 0) >= ${FETCH_RAW_BILL_FAILING_ALARM_SECONDS} AND FILL(pollerUnavailable, 0) == 0), 1, 0)`,
        usingMetrics: {
          other: this.ingestionMetric('FetchRawBillRecordFailed', 'Sum', { Kind: 'other' }, cdk.Duration.minutes(15)),
          failing: this.ingestionMetric('FetchRawBillFailingSeconds', 'Maximum', undefined, cdk.Duration.minutes(15)),
          pollerUnavailable: this.ingestionMetric('CongressApiUnavailable', 'Sum', undefined, cdk.Duration.minutes(15)),
        },
        label: 'FetchRawBill failures that are not congress.gov\'s, or failing 30 minutes without a poller outage',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // Both Bedrock callers invoke a US cross-region inference profile by ARN. The ModelId Bedrock
    // reports for that may be the model ID, the profile ID or the profile ARN, so this sums all three
    // for every granted model; SUM([...]) skips a series with no datapoint instead of blanking the
    // result. The callers also count each throttled attempt themselves (BedrockThrottled), which keeps
    // the alarm working if Bedrock reports a new model under another form. Both count the same
    // throttles, so the alarm takes the larger count rather than their sum.
    const bedrockModelIds = BEDROCK_GRANTED_MODEL_IDS.flatMap((modelId) => [
      modelId,
      `${BEDROCK_INFERENCE_PROFILE_GEO}.${modelId}`,
      inferenceProfileArn(this, modelId),
    ]);
    notify('ingestion', new cloudwatch.Alarm(this, 'BedrockInvocationThrottlesAlarm', {
      alarmName: 'Billboard-Bedrock-InvocationThrottles',
      alarmDescription: `Bedrock throttled 5 or more invocations of ${BEDROCK_GRANTED_MODEL_IDS.join(' or ')} in 5 minutes: AWS/Bedrock InvocationThrottles in any ModelId form, or the callers' own BedrockThrottled count, whichever is larger. BillSummarizer and BillPriorityResolver retry with backoff while time allows, then fail: summaries back up on BillSummarizerQueue and then its DLQ. Check the cross-region (us.) tokens-per-minute and requests-per-minute quotas of the model in use, and the bedrock_call lines with outcome throttled (RUNBOOK 11.7).`,
      metric: new cloudwatch.MathExpression({
        expression: 'MAX([bedrock, callers])',
        usingMetrics: {
          bedrock: new cloudwatch.MathExpression({
            expression: `SUM([${bedrockModelIds.map((_, index) => `b${index}`).join(', ')}])`,
            usingMetrics: Object.fromEntries(
              bedrockModelIds.map((modelId, index) => [
                `b${index}`,
                new cloudwatch.Metric({
                  namespace: 'AWS/Bedrock',
                  metricName: 'InvocationThrottles',
                  dimensionsMap: { ModelId: modelId },
                  statistic: 'Sum',
                  period: cdk.Duration.minutes(5),
                }),
              ])
            ),
            label: 'AWS/Bedrock InvocationThrottles, every ModelId form',
            period: cdk.Duration.minutes(5),
          }),
          callers: this.bedrockMetric('BedrockThrottled', cdk.Duration.minutes(5)),
        },
        label: 'Bedrock InvocationThrottles',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // LLM-11: both callers emit BedrockRequestRejected=1 (no dimensions) when Bedrock answers 400, 403 or
    // 404, and retry none of them. Without this alarm a request the model does not accept, or a missing
    // grant, would show only as BillSummarizerDLQ messages about 30 minutes later.
    const bedrockRequestRejectedAlarm = notify('ingestion', new cloudwatch.Alarm(this, 'BedrockRequestRejectedAlarm', {
      alarmName: 'Billboard-Bedrock-RequestRejected',
      alarmDescription: 'Bedrock rejected a BillSummarizer or BillPriorityResolver request in the last 5 minutes (HTTP 400, 403 or 404; BedrockRequestRejected). The callers do not retry these, so every call fails the same way until it is fixed. Usually a model switch: a request field the model does not accept, the model missing from the role\'s grants (infra/lib/config/bedrock-models.ts), or model access not enabled in the account. The bedrock_call lines with outcome invalid_request, access_denied or not_found in /aws/lambda/BillSummarizer and /aws/lambda/BillPriorityResolver give errorName and httpStatus. If it started with a deploy, move the prod aliases back (RUNBOOK 2.4, 11.7); failed summaries wait on BillSummarizerQueue and then its DLQ.',
      metric: this.bedrockMetric('BedrockRequestRejected', cdk.Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // REL-40: BillSummarizer counts every stored summary (BillSummarizerStored) and every one stored with a
    // field fitted to its limit after the corrective call (BillSummarizerRepairedBills). Fitting is the
    // fallback, not the norm. Under 10 summaries a day is too few to judge, so the rate is 0 then.
    notify('ingestion', new cloudwatch.Alarm(this, 'SummarizerFieldRepairRateAlarm', {
      alarmName: 'Billboard-Summarizer-FieldRepairRate',
      alarmDescription: 'More than 10% of the bill summaries stored in the last day (at least 10 of them) had a field fitted to its length limit after the model\'s corrective rewrite (BillSummarizerRepairedBills / BillSummarizerStored). A fit drops trailing whole sentences, or cuts an overlong first sentence at a word with an ellipsis, so readers get shortened text. This is prompt or model drift: the analysis_repaired lines in /aws/lambda/BillSummarizer name each field, the rule it broke and the original text. Compare them with the prompt targets, then fix the prompt or the model choice (RUNBOOK 11.7).',
      metric: new cloudwatch.MathExpression({
        expression: 'IF(stored >= 10, 100 * FILL(repaired, 0) / stored, 0)',
        usingMetrics: {
          stored: this.ingestionMetric('BillSummarizerStored', 'Sum', undefined, cdk.Duration.days(1)),
          repaired: this.ingestionMetric('BillSummarizerRepairedBills', 'Sum', undefined, cdk.Duration.days(1)),
        },
        label: 'Stored summaries with a fitted field (%)',
        period: cdk.Duration.days(1),
      }),
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    notify('ingestion', new cloudwatch.Alarm(
      this,
      'BillStatsAggregatorIteratorAgeAlarm',
      {
        alarmDescription: 'BillStatsAggregator DynamoDB stream iterator age exceeded 10 minutes.',
        alarmName: 'Billboard-Analytics-BillStatsAggregatorIteratorAge',
        metric: this.createLambdaMetric('BillStatsAggregator', 'IteratorAge', 'Maximum'),
        threshold: 600000,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    ));

    // CAP-04: a batch recomputes every bill it touches from the lean feedback query; a slow batch
    // is the first sign of a bill outgrowing full recompute (the counters follow-up).
    notify('ingestion', new cloudwatch.Alarm(this, 'BillStatsAggregatorDurationAlarm', {
      alarmName: 'Billboard-Analytics-BillStatsAggregatorDuration',
      alarmDescription: `A BillStatsAggregator batch ran longer than ${BILL_STATS_AGGREGATOR_DURATION_ALARM_THRESHOLD_MS / 1000} seconds of its ${BILL_STATS_AGGREGATOR_TIMEOUT_SECONDS}-second timeout. A bill with a very large vote count makes each recompute slow; check /aws/lambda/BillStatsAggregator logs for the bills in the batch, the iterator age alarm and BillStatsAggregatorStreamDLQ.`,
      metric: this.createLambdaMetric('BillStatsAggregator', 'Duration', 'Maximum'),
      threshold: BILL_STATS_AGGREGATOR_DURATION_ALARM_THRESHOLD_MS,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // C1.8: the pipeline handlers acknowledge a message that can never succeed (it is not retried and
    // reaches no DLQ) and emit MessagesUnprocessable=1 (no dimensions) with its drop site. BillSummarizer's
    // twice-refused bills (billSummarizer.refused, LLM-11) count here and have no alarm of their own.
    notify('ingestion', new cloudwatch.Alarm(this, 'MessagesUnprocessableAlarm', {
      alarmName: 'Billboard-Pipeline-MessagesUnprocessable',
      alarmDescription: 'A pipeline handler acknowledged at least one message it can never process in the last day (it was not retried and is in no DLQ). The log line "Message cannot be processed; acknowledged without retry" names the dropSite (fetchRawBill, billDiffer, billSummarizer, enrichOfficialVotes, notificationFanout, notificationType, userMatcher or userNotifier), the reason and the message content. Usually an old-shape message left in a queue at a deploy, or a mistyped hand-sent one. billSummarizer.refused is different: Bedrock refused to summarize the bill twice, the second time on shortened text, so it keeps its previous summary; the line names the refusal category. billDiffer sends the bill again on each later raw write while its text is pending, so it can recur daily and hold this alarm in ALARM; forcing a rerun is a deliberate step (RUNBOOK 11.7).',
      metric: new cloudwatch.Metric({
        namespace: PIPELINE_METRIC_NAMESPACE,
        metricName: 'MessagesUnprocessable',
        statistic: 'Sum',
        period: cdk.Duration.days(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // ── Lambda errors and throttles ─────────────────────────────────────────

    MONITORED_LAMBDA_NAMES.forEach((functionName) => {
      notify('lambda', new cloudwatch.Alarm(this, `${functionName}ErrorsAlarm`, {
        alarmName: `Billboard-Lambda-${functionName}-Errors`,
        alarmDescription: `${functionName} reported errors in at least 2 of the last 3 five-minute windows. Check /aws/lambda/${functionName} logs; for queue consumers also check the queue's DLQ.`,
        metric: this.createLambdaMetric(functionName, 'Errors', 'Sum'),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));
    });

    // 2 of 3 windows: a lone throttle is retried by Lambda or SQS and should not page. BillsApiPoller
    // needs all 3 (SUSTAINED_THROTTLE_LAMBDA_NAMES): one overlap at its reserved concurrency of 1 can
    // straddle two windows.
    THROTTLE_MONITORED_LAMBDA_NAMES.forEach((functionName) => {
      notify('lambda', new cloudwatch.Alarm(this, `${functionName}ThrottlesAlarm`, {
        alarmName: `Billboard-Lambda-${functionName}-Throttles`,
        alarmDescription: THROTTLE_ALARM_DESCRIPTION_OVERRIDES[functionName] ??
          `${functionName} was throttled in at least 2 of the last 3 five-minute windows: it hit its reserved concurrency, or the account ran out of unreserved concurrency. Work is waiting in its queue or schedule; check concurrency settings and the upstream burst.`,
        metric: this.createLambdaMetric(functionName, 'Throttles', 'Sum'),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: SUSTAINED_THROTTLE_LAMBDA_NAMES.includes(functionName) ? 3 : 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }));
    });

    // ── Queues ──────────────────────────────────────────────────────────────

    MONITORED_WORK_QUEUE_NAMES.forEach((queueName) => {
      const thresholdSeconds =
        QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_OVERRIDES_SECONDS[queueName] ?? QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_SECONDS;
      notify('queues', new cloudwatch.Alarm(
        this,
        `${queueName}QueueAgeAlarm`,
        {
          alarmName: `Billboard-SQS-${queueName}-OldestMessageAge`,
          alarmDescription: `${queueName} oldest message age exceeded ${thresholdSeconds / 60} minutes. Consumer throughput is behind or messages are stuck retrying.`,
          metric: this.sqsMetric(queueName, 'ApproximateAgeOfOldestMessage'),
          threshold: thresholdSeconds,
          evaluationPeriods: 1,
          datapointsToAlarm: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }
      ));
    });

    const dlqAlarms = new Map<string, cloudwatch.Alarm>();
    MONITORED_DLQ_NAMES.forEach((queueName) => {
      dlqAlarms.set(queueName, notify('queues', new cloudwatch.Alarm(this, `${queueName}VisibleAlarm`, {
        alarmName: `Billboard-SQS-${queueName}-VisibleMessages`,
        alarmDescription: DLQ_ALARM_DESCRIPTION_OVERRIDES[queueName] ??
          `${queueName} has at least one message pending investigation. Inspect failed payloads and source Lambda logs before redriving.`,
        metric: this.sqsMetric(queueName, 'ApproximateNumberOfMessagesVisible'),
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })));
    });
    const dlqAlarm = (queueName: string): cloudwatch.Alarm => {
      const alarm = dlqAlarms.get(queueName);
      if (!alarm) {
        throw new Error(`No DLQ alarm for ${queueName}`);
      }
      return alarm;
    };

    // A status view only: every member notifies the alarm topic itself, so the composite's own notification only ever
    // repeated a member's (on 2026-11-07 and 08, once for every lag notification).
    statusOnly('ingestion', new cloudwatch.CompositeAlarm(this, 'IngestUnhealthyAlarm', {
      compositeAlarmName: 'Billboard-Ingest-Unhealthy',
      alarmDescription: 'Bill ingestion is unhealthy: poller lag (no poll of congress.gov for an hour, an outage there included), the poller\'s heartbeat (no run finishing polling for 30 minutes), dead-lettered messages in UpdatedBillsDLQ or BillSummarizerDLQ, or Bedrock rejecting summarizer or resolver requests. A dashboard status view with no notification of its own: each member notifies itself. Open the member alarm in ALARM for the specific runbook. Bills left without text (Billboard-Ingestion-BillTextUnavailable, REL-45) are not a member: ingestion keeps flowing. Nor are the poller\'s Errors and Throttles alarms: when they stop the polls, the heartbeat member fires.',
      alarmRule: cloudwatch.AlarmRule.anyOf(
        ...[
          billPollerLagAlarm,
          billPollerHeartbeatAlarm,
          dlqAlarm('UpdatedBillsDLQ'),
          dlqAlarm('BillSummarizerDLQ'),
          bedrockRequestRejectedAlarm,
        ].map((alarm) => cloudwatch.AlarmRule.fromAlarm(alarm, cloudwatch.AlarmState.ALARM)),
      ),
    }));

    // ── Pages (C1.4) ────────────────────────────────────────────────────────
    //
    // Two composites are the only alarms that page (the page topic, on ALARM and on OK). Their existing
    // members keep their routine action, so an incident shows the member in the routine channel and the
    // page in the paging channel. The three new members below have no action of their own.

    // PublishBillsManifest emits SnapshotBillCount on every run (every 10 minutes); 5 empty half-hours
    // mean the app has read the same snapshot for 2.5 to 3 hours. The snapshot's generated-at is not used:
    // it moves only when bills change. Billboard-Freshness-BillsManifestSnapshot (30 minutes) stays routine.
    const snapshotStaleAlarm = pageMember(new cloudwatch.Alarm(this, 'BillsManifestSnapshotStalePageAlarm', {
      alarmName: 'Billboard-Page-BillsManifestSnapshotStale',
      alarmDescription: 'Page member of Billboard-Page-AppBroken (no action of its own). PublishBillsManifest has not completed a run for 2.5 hours, so the app is reading a stale bills snapshot. Check /aws/lambda/PublishBillsManifest logs, the PublishBillsManifestSchedule (every 10 minutes) and ScheduledJobFailures for a delivery failure.',
      metric: new cloudwatch.Metric({
        namespace: BILLS_MANIFEST_METRIC_NAMESPACE,
        metricName: 'SnapshotBillCount',
        statistic: 'SampleCount',
        period: cdk.Duration.minutes(30),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 5,
      datapointsToAlarm: 5,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    // Failing records leave NotificationTypeQueue for its DLQ within about 15 minutes, so failures alone
    // never reach 2 hours: this is a quiet window left open (RUNBOOK 4.1 disables the consumer) or a
    // consumer that is off or throttled.
    const notificationTypeQueueStalledAlarm = pageMember(new cloudwatch.Alarm(this, 'NotificationTypeQueueStalledPageAlarm', {
      alarmName: 'Billboard-Page-NotificationTypeQueueStalled',
      alarmDescription: 'Page member of Billboard-Page-PushesDown (no action of its own). A message has waited 2 hours on NotificationTypeQueue, so no bill pushes are going out. Usually a RUNBOOK 4.1 quiet window left open (re-enable the NotificationType event source mapping), or the consumer is disabled or throttled.',
      metric: this.sqsMetric('NotificationTypeQueue', 'ApproximateAgeOfOldestMessage'),
      threshold: 2 * 60 * 60,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // C1.2: the dispatcher runs every 5 minutes. Its APNs-expiry metric treats missing data as OK, so
    // until this alarm a stopped dispatcher (rule disabled or deleted, every run failing) went unnoticed.
    const dispatcherHeartbeatAlarm = pageMember(new cloudwatch.Alarm(this, 'NotificationDispatcherHeartbeatAlarm', {
      alarmName: 'Billboard-Heartbeat-NotificationDispatcher',
      alarmDescription: 'Page member of Billboard-Page-PushesDown (no action of its own). NotificationDispatcher has not completed a run in 30 minutes (it runs every 5 minutes), so pending pushes are not being sent. Check /aws/lambda/NotificationDispatcher logs, the NotificationDispatcherSchedule rule (enabled?) and ScheduledJobFailures for a delivery failure.',
      metric: this.successfulRunsMetric('NotificationDispatcher', cdk.Duration.minutes(5), 'NotificationDispatcher successful runs per 5 minutes'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 6,
      datapointsToAlarm: 6,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }));

    const anyInAlarm = (...alarms: cloudwatch.IAlarm[]): cloudwatch.IAlarmRule =>
      cloudwatch.AlarmRule.anyOf(...alarms.map((alarm) => cloudwatch.AlarmRule.fromAlarm(alarm, cloudwatch.AlarmState.ALARM)));

    // Overnight (the canary is off 23:45 to 13:00 UTC) this relies on the 5XX and snapshot members; at a
    // few API calls an hour the 5XX member is effectively unreachable, which is accepted.
    page(new cloudwatch.CompositeAlarm(this, 'AppBrokenPageAlarm', {
      compositeAlarmName: 'Billboard-Page-AppBroken',
      alarmDescription: 'PAGE: the app is broken for users: API 5XX errors (Billboard-API-5XXError), the Synthetics canary failing (Billboard-Canary-SuccessPercent), or a bills snapshot over 2.5 hours old (Billboard-Page-BillsManifestSnapshotStale). Open the member in ALARM; RUNBOOK 1.1 has the first checks for each.',
      alarmRule: anyInAlarm(userApi5xxAlarm, userApiCanaryAlarm, snapshotStaleAlarm),
    }));

    page(new cloudwatch.CompositeAlarm(this, 'PushesDownPageAlarm', {
      compositeAlarmName: 'Billboard-Page-PushesDown',
      alarmDescription: 'PAGE: pushes are down: NotificationDispatcher has not completed a run in 30 minutes (Billboard-Heartbeat-NotificationDispatcher), APNs is rejecting pushes (Billboard-Notifications-ApnsDeliveryFailures), or NotificationTypeQueue has stalled for 2 hours (Billboard-Page-NotificationTypeQueueStalled). Pending pushes live 24 hours. Open the member in ALARM; RUNBOOK 1.1 has the first checks for each.',
      alarmRule: anyInAlarm(dispatcherHeartbeatAlarm, apnsDeliveryFailuresAlarm, notificationTypeQueueStalledAlarm),
    }));

    // ── DynamoDB ────────────────────────────────────────────────────────────
    //
    // C1.4 removed the 13 per-table SystemErrors alarms: SDK retries absorb DynamoDB 5xx errors, and a
    // persistent one shows in the callers' Errors alarms and DLQs.

    // CAP-02: every pending notification is a transaction that also writes the `__dedupe__` marker
    // partition and one of the dispatch marker shards. Sustained throttling means those partitions
    // are hot: pushes slow down and retries pile up on notificationFanoutQueue.
    notify('dynamodb', new cloudwatch.Alarm(this, 'PendingNotificationsWriteThrottleAlarm', {
      alarmName: `Billboard-DynamoDB-${PENDING_NOTIFICATIONS_TABLE_NAME}-WriteThrottleEvents`,
      alarmDescription: `${PENDING_NOTIFICATIONS_TABLE_NAME} throttled writes in at least 2 of the last 3 five-minute windows. The dedupe and dispatch marker partitions are hot; the SDK and SQS retries absorb short bursts. Check notificationFanoutQueue age, NotificationFanout errors and its DLQ, and lower NotificationFanout's event source maximum concurrency if it persists.`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'WriteThrottleEvents',
        dimensionsMap: { TableName: PENDING_NOTIFICATIONS_TABLE_NAME },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }));

    // ── Cost ────────────────────────────────────────────────────────────────

    const monthlyCostBudget = new budgets.CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: 'Billboard-Monthly-Cost',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: MONTHLY_COST_BUDGET_USD, unit: 'USD' },
        // Infra review item 7: count only this account's spend. In an organization's management account an
        // unfiltered budget also counts every linked account's spend. A LinkedAccount filter naming the
        // deploying account keeps it to Billboard; in a standalone or member account it is the same as no
        // filter.
        costFilters: { LinkedAccount: [this.account] },
      },
      notificationsWithSubscribers: [
        { notificationType: 'ACTUAL', threshold: 80 },
        { notificationType: 'FORECASTED', threshold: 100 },
      ].map(({ notificationType, threshold }) => ({
        notification: {
          notificationType,
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'SNS', address: alarmTopic.topicArn }],
      })),
    });
    // Budgets checks that it can publish when the notification is created.
    monthlyCostBudget.node.addDependency(alarmTopic);

    // ── Dashboard ───────────────────────────────────────────────────────────

    const dashboard = new cloudwatch.Dashboard(this, 'BillboardOpsDashboard', {
      dashboardName: 'BillboardOps',
      defaultInterval: cdk.Duration.days(1),
    });
    const sectionHeader = (markdown: string) =>
      new cloudwatch.TextWidget({ markdown, width: 24, height: 1 });
    const alarmStatusWidget = (title: string, group: AlarmGroup, width: number, height: number) =>
      new cloudwatch.AlarmStatusWidget({
        title,
        alarms: alarmGroups[group],
        width,
        height,
        sortBy: cloudwatch.AlarmStatusWidgetSortBy.STATE_UPDATED_TIMESTAMP,
      });

    // Row 1: is prod healthy?
    dashboard.addWidgets(
      sectionHeader('## 1. Is prod healthy? Alarms in ALARM sort first. Only the two page composites reach the paging channel; their member-only alarms have no action of their own; every other alarm notifies the alarm topic.'),
    );
    dashboard.addWidgets(
      alarmStatusWidget('Pages: Billboard-Page-AppBroken, Billboard-Page-PushesDown and their member-only alarms', 'pages', 24, 3),
    );
    dashboard.addWidgets(
      alarmStatusWidget('Alarms: API, freshness and delivery', 'service', 8, 4),
      alarmStatusWidget('Alarms: ingestion', 'ingestion', 8, 4),
      alarmStatusWidget('Alarms: DynamoDB throttles', 'dynamodb', 8, 4),
      alarmStatusWidget('Alarms: Lambda errors and throttles', 'lambda', 12, 6),
      alarmStatusWidget('Alarms: queues and DLQs', 'queues', 12, 6),
      new cloudwatch.GraphWidget({
        title: 'User API requests (left) and 4XX/5XX (right), 5m sum',
        left: [this.userApiMetric('Count', 'Sum', cdk.Duration.minutes(5))],
        right: [
          this.userApiMetric('4XXError', 'Sum', cdk.Duration.minutes(5)),
          this.userApiMetric('5XXError', 'Sum', cdk.Duration.minutes(5)),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'User API latency p99 (ms)',
        left: [this.userApiMetric('Latency', 'p99', cdk.Duration.minutes(5))],
        leftAnnotations: [{ value: 3000, label: 'Alarm' }],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda errors and throttles, all functions (5m sum)',
        left: [
          new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Errors', statistic: 'Sum', period: cdk.Duration.minutes(5) }),
          new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: 'Throttles', statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        ],
        width: 8,
      }),
    );

    // Row 2: ingestion pipeline, congress.gov to summaries.
    dashboard.addWidgets(sectionHeader('## 2. Pipeline: congress.gov to summaries'));
    dashboard.addWidgets(
      // Lag since the last poll (left) and runs that found congress.gov unavailable (right): during an
      // outage the right side counts about 3 runs per 15 minutes while the lag climbs.
      new cloudwatch.GraphWidget({
        title: 'Bill poller lag (s, left), runs with congress.gov unavailable (right)',
        left: [billPollerLagMetric],
        leftAnnotations: [{ value: BILL_POLLER_LAG_ALARM_THRESHOLD_SECONDS, label: 'Alarm' }],
        right: [this.ingestionMetric('CongressApiUnavailable', 'Sum', undefined, cdk.Duration.minutes(15))],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Poller: bills discovered and enqueued',
        left: [
          this.ingestionMetric('BillsDiscovered'),
          this.ingestionMetric('BillsEnqueued'),
          this.ingestionMetric('CongressApiCallsLister'),
        ],
        right: [
          this.ingestionMetric('BillPollerMissingUpdateDate'),
          this.ingestionMetric('BillPollerFallbackTypeCount'),
          // REL-56: these and BillPollerFallbackTypeCount alarm at 1 in an hour.
          this.ingestionMetric('BillPollerFilterImprecise'),
          this.ingestionMetric('BillPollerPageDrift'),
          this.ingestionMetric('BillPollerLateRows'),
        ],
        width: 8,
      }),
      // REL-45: requests per source on the left (a GovInfo that refuses Lambda shows as BillXmlFetchRefused there and
      // fallbacks on the right, not as an alarm; a failure with HTTP 302 is GovInfo not having a version yet); what
      // became of each bill's text on the right.
      new cloudwatch.GraphWidget({
        title: 'Bill text: XML requests per source (left), outcomes per bill (right)',
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{BillBoard/BillIngestion,Source,StatusCode} MetricName="BillXmlFetchSuccess"', 'Sum', 300)`,
            label: "BillXmlFetchSuccess ${PROP('Dim.Source')}",
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.MathExpression({
            expression: `SEARCH('{BillBoard/BillIngestion,Source,StatusCode} MetricName="BillXmlFetchFailure"', 'Sum', 300)`,
            label: "BillXmlFetchFailure ${PROP('Dim.Source')} HTTP ${PROP('Dim.StatusCode')}",
            period: cdk.Duration.minutes(5),
          }),
          // Network errors have no status code: the Source-only series counts every failure.
          new cloudwatch.MathExpression({
            expression: `SEARCH('{BillBoard/BillIngestion,Source} MetricName="BillXmlFetchFailure"', 'Sum', 300)`,
            label: "BillXmlFetchFailure ${PROP('Dim.Source')} (all)",
            period: cdk.Duration.minutes(5),
          }),
          // The source turned the environment away (401, 403, a challenge, a 429 after retries): the switch's signal.
          new cloudwatch.MathExpression({
            expression: `SEARCH('{BillBoard/BillIngestion,Source} MetricName="BillXmlFetchRefused"', 'Sum', 300)`,
            label: "BillXmlFetchRefused ${PROP('Dim.Source')}",
            period: cdk.Duration.minutes(5),
          }),
        ],
        right: [
          this.ingestionMetric('BillXmlReused'),
          this.ingestionMetric('BillTextRetryScheduled'),
          this.ingestionMetric('BillTextUnavailable'),
          new cloudwatch.MathExpression({
            expression: `SEARCH('{BillBoard/BillIngestion,Source} MetricName="BillXmlFallbackUsed"', 'Sum', 300)`,
            label: "BillXmlFallbackUsed ${PROP('Dim.Source')}",
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.MathExpression({
            expression: `SEARCH('{BillBoard/BillIngestion,Source} MetricName="BillXmlSourceSkipped"', 'Sum', 300)`,
            label: "BillXmlSourceSkipped ${PROP('Dim.Source')}",
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Congress API calls (left), 429s and auth failures (right)',
        left: [
          this.ingestionMetric('CongressApiCallsCore'),
          this.ingestionMetric('CongressApiCallsVoteEnrich'),
        ],
        right: [congressApi429Metric, congressApiAuthFailureMetric],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Official vote enrichment, and REL-35 member votes kept on refetch (MEMBER_VOTE_CARRY_MODE)',
        left: [
          this.ingestionMetric('HouseMemberVotesAttached'),
          this.ingestionMetric('SenateMemberVotesAttached'),
          // REL-35 (X7): chambers that would be (watch) or were (on) carried forward on a refetch.
          this.ingestionMetric('MemberVotesCarriable'),
          this.ingestionMetric('MemberVotesCarried'),
        ],
        right: [
          this.ingestionMetric('EnrichmentDeferred'),
          this.ingestionMetric('EnrichmentPartialFinalized'),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Bedrock invocations and throttles (left), tokens (right)',
        left: [
          this.bedrockSearch('Invocations'),
          this.bedrockSearch('InvocationThrottles'),
        ],
        right: [
          this.bedrockSearch('InputTokenCount'),
          this.bedrockSearch('OutputTokenCount'),
        ],
        width: 8,
      }),
    );

    // Row 3: queues.
    dashboard.addWidgets(sectionHeader('## 3. Queues: oldest message age on work queues, and DLQ depth (anything above zero needs a look)'));
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Oldest message age, work queues (s)',
        left: MONITORED_WORK_QUEUE_NAMES.map((queueName) =>
          this.sqsMetric(queueName, 'ApproximateAgeOfOldestMessage')
        ),
        leftAnnotations: [
          { value: QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_SECONDS, label: 'Alarm' },
          ...Object.entries(QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_OVERRIDES_SECONDS).map(([queueName, value]) => ({
            value,
            label: `Alarm (${queueName})`,
          })),
        ],
        width: 12,
        height: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'DLQ depth (visible messages)',
        left: MONITORED_DLQ_NAMES.map((queueName) =>
          this.sqsMetric(queueName, 'ApproximateNumberOfMessagesVisible')
        ),
        width: 12,
        height: 8,
      }),
    );

    // Row 4: delivery and freshness.
    dashboard.addWidgets(sectionHeader('## 4. Delivery and freshness. Canary runs 13:00-23:45 UTC; the digest age needs the canary smoke-test secret.'));
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'APNs pushes delivered (left) and failed (right), 1h sum',
        left: [apnsDeliveredMetric],
        right: [apnsFailedMetric],
        width: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Canary success (%)',
        left: [canarySuccessMetric],
        leftAnnotations: [{ value: 90, label: 'Alarm' }],
        leftYAxis: { min: 0, max: 100 },
        width: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Weekly digest age (s, left) and CreateBillsManifest runs per day (right)',
        left: productFreshnessMetrics.map(({ metricName }) => productFreshnessMetric(metricName)),
        right: [createBillsManifestDailyInvocations],
        width: 6,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'APNs certificate days remaining',
        metrics: [apnsCertificateDaysRemainingMetric],
        width: 6,
        height: 6,
      }),
    );

    // Row 5: account integrity: what each switch's watch (or plan) mode records.
    dashboard.addWidgets(sectionHeader('## 5. Account integrity: INT-06 votes, INT-03 verification, INT-05 sign-ups and the re-stamp. Under watch (or plan) each switch records what enforce would refuse.'));
    // REL-53: one datapoint a day (the cleanup runs daily; sign-ups are few).
    const accountsMetric = (
      metricName: string,
      statistic: 'Sum' | 'Maximum',
      dimensionsMap?: Record<string, string>,
      label?: string,
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: ACCOUNTS_METRIC_NAMESPACE,
        metricName,
        statistic,
        period: cdk.Duration.days(1),
        ...(dimensionsMap ? { dimensionsMap } : {}),
        ...(label ? { label } : {}),
      });
    const integrityGraph = (title: string, left: string[], right: string[] = []) =>
      new cloudwatch.GraphWidget({
        title,
        left: left.map((metricName) => integrityMetric(metricName, cdk.Duration.hours(1))),
        right: right.map((metricName) => integrityMetric(metricName, cdk.Duration.hours(1))),
        width: 6,
      });
    dashboard.addWidgets(
      alarmStatusWidget('Alarms: account integrity', 'integrity', 24, 3),
    );
    dashboard.addWidgets(
      integrityGraph('Votes written (left) and daily-cap hits (right), 1h sum', ['VotesCast'], ['VoteDailyCapExceeded']),
      integrityGraph(
        'Address verifications (left) and INT-03 limit signals (right), 1h sum',
        ['AddressVerified'],
        ['AddressLimitReached', 'ReverificationLimitReached', 'StreetClusterFlagged', 'AddressVerifiedIpMismatch', 'GeocoderVintageFallback'],
      ),
      integrityGraph(
        'Sign-up filter: hits and rejections (left), errors (right), 1h sum',
        ['SignUpFilterHit', 'SignUpRejected'],
        ['PreSignUpCheckError'],
      ),
      integrityGraph('Vote re-stamp: rows planned (left) and rewritten (right), 1h sum', ['VotesRestampPlanned'], ['VotesRestamped']),
      // CB-07: the check's own sign-ups, counted apart from the real ones above.
      integrityGraph('Sign-up filter check probes: hits and rejections, 1h sum', ['SignUpProbeHit', 'SignUpProbeRejected']),
      // REL-53 (S17): real sign-ups. SignUpAllowed leaves out the filter check's probes, which AWS/Cognito
      // SignUpSuccesses counts, and the probes never confirm; a sign-up still unconfirmed after
      // UNCONFIRMED_SIGNUP_MAX_AGE_HOURS is deleted once (delete mode). SignUpsConfirmed, Expired and Pending are levels counted once a run, so each shows its
      // day's maximum (a hand run repeats the day's count); SignUpAllowed and Deleted are events, summed.
      new cloudwatch.GraphWidget({
        title: `Sign-ups (not probes): let through by PreSignUpCheck and confirmed (left); unconfirmed after ${UNCONFIRMED_SIGNUP_MAX_AGE_HOURS} h, deleted, still pending (right), 1d`,
        left: [
          accountsMetric('SignUpAllowed', 'Sum'),
          accountsMetric('SignUpsConfirmed', 'Maximum'),
        ],
        right: [
          accountsMetric('UnconfirmedSignUpsExpired', 'Maximum'),
          accountsMetric('UnconfirmedSignUpsDeleted', 'Sum'),
          accountsMetric('UnconfirmedSignUpsPending', 'Maximum'),
        ],
        width: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Unconfirmed sign-up cleanup: kept by reason (left), errors and cap reached (right), 1d sum',
        left: UNCONFIRMED_SIGN_UP_SKIP_REASONS.map((reason) =>
          accountsMetric('UnconfirmedSignUpsSkipped', 'Sum', { Reason: reason }, reason)),
        right: [
          accountsMetric('UnconfirmedSignUpCleanupErrors', 'Sum'),
          accountsMetric('UnconfirmedSignUpCleanupCapReached', 'Maximum'),
        ],
        width: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Sign-up filter check runs: passed, failed, inconclusive, off (left), leftovers swept (right), 1h sum',
        left: [
          'SignUpFilterCheckPassed',
          'SignUpFilterCheckFailed',
          'SignUpFilterCheckInconclusive',
          'SignUpFilterCheckDisabled',
        ].map(signUpFilterCheckMetric),
        right: [signUpFilterCheckMetric('SignUpFilterCheckSwept')],
        width: 6,
      }),
    );

    // Row 6: App Attest (INT-04). Old builds show as Outcome=missing; attesting builds as valid.
    dashboard.addWidgets(sectionHeader('## 6. App Attest (INT-04): votes and sign-ups by outcome, attestations, challenges, DeviceCheck. The readiness report is npm run report:app-attest.'));
    const appAttestSearch = (dimensions: string, metricName: string, label: string): cloudwatch.MathExpression =>
      new cloudwatch.MathExpression({
        expression: `SEARCH('{${APP_ATTEST_METRIC_NAMESPACE},${dimensions}} MetricName="${metricName}"', 'Sum', 3600)`,
        label,
        period: cdk.Duration.hours(1),
      });
    dashboard.addWidgets(
      alarmStatusWidget('Alarms: App Attest', 'appAttest', 24, 2),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Votes and sign-ups by App Attest outcome, 1h sum',
        left: [appAttestSearch('Outcome,Route', 'AppAttestRequests', "${PROP('Dim.Route')} ${PROP('Dim.Outcome')}")],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Invalid, errors and rejected (left), over the 3-account limit (right), 1h sum',
        left: [appAttestMetric('AppAttestInvalid'), appAttestMetric('AppAttestErrors'), appAttestMetric('AppAttestRejected')],
        right: [appAttestSearch('Kind', 'AppAttestOverLimit', "AppAttestOverLimit ${PROP('Dim.Kind')}")],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Challenges (left), attestations and DeviceCheck calls by outcome (right), 1h sum',
        left: [appAttestMetric('AppAttestChallenges')],
        right: [
          appAttestSearch('Outcome', 'AppAttestAttestations', "AppAttestAttestations ${PROP('Dim.Outcome')}"),
          appAttestSearch('Outcome', 'DeviceCheckCalls', "DeviceCheckCalls ${PROP('Dim.Outcome')}"),
        ],
        width: 8,
      }),
    );

    // Row 7: Bedrock (LLM-11). The callers write these per attempt, next to their bedrock_call log lines.
    dashboard.addWidgets(sectionHeader('## 7. Bedrock calls (LLM-11): BillSummarizer and BillPriorityResolver by outcome, with latency and output tokens (thinking included); summaries revised by the corrective call and fitted to their limits (REL-40). RUNBOOK 11.7.'));
    const bedrockCallSearch = (metricName: string, statistic: string, label: string, filter = ''): cloudwatch.MathExpression =>
      new cloudwatch.MathExpression({
        expression: `SEARCH('{${BEDROCK_METRIC_NAMESPACE},Caller,Outcome} MetricName="${metricName}"${filter}', '${statistic}', 300)`,
        label,
        period: cdk.Duration.minutes(5),
      });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Bedrock calls by caller and outcome, 5m sum',
        left: [bedrockCallSearch('BedrockCalls', 'Sum', "${PROP('Dim.Caller')} ${PROP('Dim.Outcome')}")],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Bedrock latency of answered calls by caller, p50 and p95 (ms)',
        left: [
          bedrockCallSearch('BedrockLatency', 'p50', "${PROP('Dim.Caller')} p50", ' Outcome="ok"'),
          bedrockCallSearch('BedrockLatency', 'p95', "${PROP('Dim.Caller')} p95", ' Outcome="ok"'),
        ],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Bedrock output tokens by caller and outcome, 5m sum',
        left: [bedrockCallSearch('BedrockOutputTokens', 'Sum', "${PROP('Dim.Caller')} ${PROP('Dim.Outcome')}")],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Requests rejected, attempts throttled, refusals and resolver runs with no answer, 1h sum',
        left: ['BedrockRequestRejected', 'BedrockThrottled', 'BedrockRefusal', 'PriorityResolverNoAnswer']
          .map((metricName) => this.bedrockMetric(metricName, cdk.Duration.hours(1))),
        width: 12,
      }),
      // REL-51: what "In the news" picks and what its calls send. The resolver calls Bedrock once a run, 18 runs a day.
      new cloudwatch.GraphWidget({
        title: 'In the news: bills passing and new picks (left); resolver input tokens (right), 1h sum. RUNBOOK 22',
        left: ['PriorityPassingBills', 'PriorityNewPicks']
          .map((metricName) => this.bedrockMetric(metricName, cdk.Duration.hours(1))),
        right: [this.bedrockMetric('PriorityInputTokens', cdk.Duration.hours(1))],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Summaries stored, rejected and revised (left); bills and fields fitted to their limits (right), 1h sum',
        left: ['BillSummarizerStored', 'BillSummarizerAnalysisRejected', 'BillSummarizerAnalysisRevised']
          .map((metricName) => this.ingestionMetric(metricName, 'Sum', undefined, cdk.Duration.hours(1))),
        right: ['BillSummarizerRepairedBills', 'BillSummarizerFieldRepaired']
          .map((metricName) => this.ingestionMetric(metricName, 'Sum', undefined, cdk.Duration.hours(1))),
        width: 12,
      }),
    );

    // Row 8: email (REL-54). The configuration set's counts (BillboardAccountEmail, one metric per event type).
    dashboard.addWidgets(sectionHeader('## 8. Email (REL-54): SES reputation and the BillboardAccountEmail counts, every sign-up and reset code the user pool sends (step 2). RUNBOOK section 23.'));
    const accountEmailMetric = (metricName: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: SES_METRIC_NAMESPACE,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.days(1),
        dimensionsMap: { [SES_EVENT_DIMENSION_NAME]: SES_CONFIGURATION_SET_NAME },
      });
    dashboard.addWidgets(
      alarmStatusWidget('Alarms: email', 'email', 24, 2),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SES reputation: bounce rate (left) and complaint rate (right), account-wide, 1h max',
        left: [sesBounceRateMetric],
        right: [sesComplaintRateMetric],
        leftAnnotations: [{ value: SES_BOUNCE_RATE_ALARM_THRESHOLD, label: 'Alarm' }, { value: 0.05, label: 'SES review' }],
        rightAnnotations: [{ value: SES_COMPLAINT_RATE_ALARM_THRESHOLD, label: 'Alarm' }, { value: 0.001, label: 'SES review' }],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Account emails: sent and delivered (left), bounced, complained, rejected and delayed (right), 1d sum',
        left: ['Send', 'Delivery'].map(accountEmailMetric),
        right: ['Bounce', 'Complaint', 'Reject', 'DeliveryDelay'].map(accountEmailMetric),
        width: 12,
      }),
    );

    new cdk.CfnOutput(this, 'DashboardName', {
      value: dashboard.dashboardName,
      description: 'CloudWatch dashboard for billboard workload monitoring.',
    });
  }

  private createLambdaMetric(
    functionName: string,
    metricName: string,
    statistic: string,
    period: cdk.Duration = cdk.Duration.minutes(5),
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName,
      statistic,
      period,
      dimensionsMap: { FunctionName: functionName },
    });
  }

  /**
   * Successful runs of a function per period: invocations minus errors, each FILLed with 0, so a period
   * with no invocation is 0 and retried failures cancel out. The heartbeat and export freshness shape.
   */
  private successfulRunsMetric(functionName: string, period: cdk.Duration, label: string): cloudwatch.MathExpression {
    return new cloudwatch.MathExpression({
      expression: 'FILL(invocations, 0) - FILL(errors, 0)',
      usingMetrics: {
        invocations: this.createLambdaMetric(functionName, 'Invocations', 'Sum', period),
        errors: this.createLambdaMetric(functionName, 'Errors', 'Sum', period),
      },
      label,
      period,
    });
  }

  private ingestionMetric(
    metricName: string,
    statistic = 'Sum',
    dimensionsMap?: Record<string, string>,
    period: cdk.Duration = cdk.Duration.minutes(5),
  ): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'BillBoard/BillIngestion',
      metricName,
      statistic,
      period,
      dimensionsMap,
    });
  }

  // LLM-11: a Bedrock caller count without dimensions.
  private bedrockMetric(metricName: string, period: cdk.Duration): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: BEDROCK_METRIC_NAMESPACE,
      metricName,
      statistic: 'Sum',
      period,
    });
  }

  private sqsMetric(queueName: string, metricName: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName,
      statistic: 'Maximum',
      period: cdk.Duration.minutes(5),
      dimensionsMap: { QueueName: queueName },
    });
  }

  private userApiMetric(metricName: string, statistic: string, period: cdk.Duration): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName,
      statistic,
      period,
      dimensionsMap: { ApiName: USER_API_NAME },
    });
  }

  private apnsMetric(metricName: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/SNS',
      metricName,
      statistic: 'Sum',
      period: cdk.Duration.hours(1),
      dimensionsMap: { Application: APNS_PLATFORM_APPLICATION_NAME, Platform: 'APNS' },
    });
  }

  // Graphs every ModelId the account invokes, whichever form Bedrock reports it in.
  private bedrockSearch(metricName: string): cloudwatch.MathExpression {
    return new cloudwatch.MathExpression({
      expression: `SEARCH('{AWS/Bedrock,ModelId} MetricName="${metricName}"', 'Sum', 300)`,
      label: `${metricName} \${PROP('Dim.ModelId')}`,
      period: cdk.Duration.minutes(5),
    });
  }
}
