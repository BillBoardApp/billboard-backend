import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';
import { BILL_STORE_BUCKET_NAME } from '../config/congress-store-constants';
import {
  BILL_PRIORITY_TABLE_PARTITION_KEY,
} from '../config/priority-service-constants';
import {
  USER_PARTITION_KEY,
  USER_PII_TABLE_NAME,
  USER_FEEDBACK_TABLE_NAME,
  USER_FEEDBACK_SORT_KEY,
  USER_PREFERENCES_TABLE_NAME,
  USER_PREFERENCES_SORT_KEY,
  USER_PREFERENCES_SUB_CATEGORY_INDEX,
  USER_DEVICES_TABLE_NAME,
  USER_DEVICES_SORT_KEY
} from '../config/user-store-constants';
import {
  APNS_PLATFORM_APPLICATION_NAME,
  BACKFILL_PUSH_MODE,
  DISPATCH_SHARD_COUNT,
  NOTIFICATION_DISPATCHER_TIMEOUT_SECONDS,
  NOTIFICATION_DISPATCHER_USER_BATCH_SIZE,
  NOTIFICATION_FANOUT_ENABLED,
  NOTIFICATION_FANOUT_EVENT_SOURCE_MAX_CONCURRENCY,
  NOTIFICATION_FANOUT_QUEUE_BATCH_SIZE,
  NOTIFICATION_FANOUT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  NOTIFICATION_FANOUT_TIMEOUT_SECONDS,
  NOTIFICATION_SERVICE_DLQ_MAX_RECEIVE_COUNT,
  NOTIFICATION_SERVICE_DLQ_RETENTION_DAYS,
  NOTIFICATION_SERVICE_QUEUE_BATCH_SIZE,
  NOTIFICATION_TYPE_TIMEOUT_SECONDS,
  NOTIFICATIONS_METRIC_NAMESPACE,
  PENDING_NOTIFICATIONS_TABLE_NAME,
  PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY,
  PENDING_NOTIFICATIONS_TABLE_SORT_KEY,
  PUSH_PACE_HOURS,
  QUIET_HOURS_ENABLED,
  USER_MATCHER_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  USER_MATCHER_TIMEOUT_SECONDS,
  USER_NOTIFIER_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  USER_NOTIFIER_TIMEOUT_SECONDS,
} from '../config/notification-service-constants';
import {
  createReleaseBackedLambdaFactory,
  createRetainedLambdaLogGroup,
  grantCloudWatchMetricNamespaceWrite,
} from './helpers/lambda-utils';
import {
  addProdAliasWithDeployment,
  ProdAliasDeploymentOptions,
} from './helpers/codedeploy-utils';
import { storeBucket, storeTable } from './helpers/data-store-refs';
import {
  BILL_COMPANION_ENVIRONMENT,
  grantCompanionGroupsRead,
  grantCompanionResolverRead,
} from './helpers/bill-companions';
import { scheduledJobFailuresQueue } from './helpers/scheduled-job-failures';

/** Values UserNotifier understands for PENDING_EXPIRY_MODE; anything else, or no value, means 'watch'. */
export type PendingExpiryMode = 'watch' | 'enforce';

/**
 * X6 (the expired-push cutoff of C1.3, decision D1). In 'watch', UserNotifier counts a pending row past its
 * 24-hour lifetime (NotificationsExpiredUndelivered) and logs it as "would_expire", then sends and deletes it
 * exactly as before, so a unit mismatch shows as an alarm instead of lost pushes. 'enforce' deletes such
 * rows unsent. Ships as 'watch'; the flip PR sets 'enforce' once the metric stayed 0 for 7 days of normal
 * running. Changing it publishes a new UserNotifier version, which shifts all at once (a worker).
 */
export const USER_NOTIFIER_PENDING_EXPIRY_MODE: PendingExpiryMode = 'watch';

export interface NotificationServiceStackProps extends cdk.StackProps {
  readonly lambdaArtifactsBucket: s3.IBucket;
  readonly notificationTypeQueue: sqs.Queue;
  readonly billPriorityTable: ddb.ITable;
  /**
   * Whether UserMatcher hands matched users to NotificationFanout (CAP-02).
   * @default NOTIFICATION_FANOUT_ENABLED
   */
  readonly notificationFanoutEnabled?: boolean;
}

export class NotificationServiceStack extends cdk.Stack {
  /** prod alias — use for all downstream invocations */
  public readonly notificationType: lambda.IFunction;
  /** Underlying function (not the prod alias). */
  public readonly userMatcher: lambda.Function;
  public readonly userNotifier: lambda.IFunction;
  /** prod alias */
  public readonly notificationFanout: lambda.IFunction;

  public readonly apnsPlatformApplicationArn?: string;

  constructor(scope: Construct, id: string, props: NotificationServiceStackProps) {
    super(scope, id, props);

    // The store tables and bucket, referenced by their fixed names (CQ-15).
    const billStoreBucket = storeBucket(this, 'billStore');
    const preferencesTable = storeTable(this, 'userPreferences');
    const devicesTable = storeTable(this, 'userDevices');
    const piiTable = storeTable(this, 'userPii');
    const feedbackTable = storeTable(this, 'userFeedback');
    // Built from the fixed application name, not the custom resource's
    // PlatformApplicationArn: the custom resource's own role needs this ARN
    // before the application exists, and the attribute is '' until the APNs
    // secret is seeded, which would make an invalid IAM resource.
    const apnsAppResourceName = `APNS/${APNS_PLATFORM_APPLICATION_NAME}`;
    const apnsAppArn = cdk.Stack.of(this).formatArn({
      service: 'sns',
      resource: 'app',
      resourceName: apnsAppResourceName,
    });
    const apnsEndpointArn = cdk.Stack.of(this).formatArn({
      service: 'sns',
      resource: 'endpoint',
      resourceName: `${apnsAppResourceName}/*`,
    });

    const codeDeployApp = new codedeploy.LambdaApplication(this, 'NotificationServiceApp', {
      applicationName: 'NotificationService',
    });
    // Every function here is an SQS or scheduled worker, so they deploy all at once (REL-18).
    const deploymentConfig = codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE;
    const workerDeployment: ProdAliasDeploymentOptions = { deploymentKind: 'worker' };

    const createNotificationLambda = createReleaseBackedLambdaFactory(
      this,
      props.lambdaArtifactsBucket,
    );

    // C1.7: NotificationTypeQueue has no queue policy. No bucket notification targets it (checked live
    // 2026-10-07: the bill store notifies only CongressMemberStatsQueue and BillsManifestQueue), and
    // CreateBillsManifest sends to it through its IAM grant in CongressStoreStack.

    const userMatcherDLQ = new sqs.Queue(this, 'userMatcherDLQ', {
      queueName: 'userMatcherDLQ',
      retentionPeriod: cdk.Duration.days(NOTIFICATION_SERVICE_DLQ_RETENTION_DAYS),
    });

    const userMatcherQueue = new sqs.Queue(this, 'userMatcherQueue', {
      queueName: 'userMatcherQueue',
      visibilityTimeout: cdk.Duration.seconds(USER_MATCHER_QUEUE_VISIBILITY_TIMEOUT_SECONDS),
      deadLetterQueue: {
        maxReceiveCount: NOTIFICATION_SERVICE_DLQ_MAX_RECEIVE_COUNT,
        queue: userMatcherDLQ,
      },
    });

    const userNotifierDLQ = new sqs.Queue(this, 'userNotifierDLQ', {
      queueName: 'userNotifierDLQ',
      retentionPeriod: cdk.Duration.days(NOTIFICATION_SERVICE_DLQ_RETENTION_DAYS),
    });

    const userNotifierQueue = new sqs.Queue(this, 'userNotifierQueue', {
      queueName: 'userNotifierQueue',
      visibilityTimeout: cdk.Duration.seconds(USER_NOTIFIER_QUEUE_VISIBILITY_TIMEOUT_SECONDS),
      deadLetterQueue: {
        maxReceiveCount: NOTIFICATION_SERVICE_DLQ_MAX_RECEIVE_COUNT,
        queue: userNotifierDLQ,
      },
    });

    // CAP-02: UserMatcher sends the users it matched for one bill here in chunks of about 100, and
    // NotificationFanout writes their pending notifications.
    const notificationFanoutDLQ = new sqs.Queue(this, 'notificationFanoutDLQ', {
      queueName: 'notificationFanoutDLQ',
      retentionPeriod: cdk.Duration.days(NOTIFICATION_SERVICE_DLQ_RETENTION_DAYS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const notificationFanoutQueue = new sqs.Queue(this, 'notificationFanoutQueue', {
      queueName: 'notificationFanoutQueue',
      visibilityTimeout: cdk.Duration.seconds(NOTIFICATION_FANOUT_QUEUE_VISIBILITY_TIMEOUT_SECONDS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: NOTIFICATION_SERVICE_DLQ_MAX_RECEIVE_COUNT,
        queue: notificationFanoutDLQ,
      },
    });

    const pendingNotificationsTable = new ddb.Table(this, 'PendingNotificationsTable', {
      partitionKey: { name: PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: PENDING_NOTIFICATIONS_TABLE_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: PENDING_NOTIFICATIONS_TABLE_NAME,
      timeToLiveAttribute: 'ttl',
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      deletionProtection: true,
    });

    // The value properties are left as-is on purpose: changing
    // GenerateSecretString makes CloudFormation write a new version over the
    // hand-seeded credentials. A fresh stack therefore holds a random string,
    // which the custom resource treats as "not configured yet" (REC-01).
    const apnsCredentialsSecret = new secretsmanager.Secret(
      this,
      'ApnsCredentialsSecret',
      {
        secretName: 'Billboard/ApnsCredentials'
      }
    );

    const onEvent = new NodejsFunction(this, 'ApnsPlatformApplicationOnEvent', {
      logGroup: createRetainedLambdaLogGroup(
        this,
        'ApnsPlatformApplicationOnEventLogGroup',
        'ApnsPlatformApplicationOnEvent',
      ),
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(
        __dirname,
        '..',
        'custom_resources',
        'apns-platform-application-on-event',
        'index.js'
      ),
      handler: 'handler',
      timeout: cdk.Duration.minutes(2),
    });

    apnsCredentialsSecret.grantRead(onEvent);
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:CreatePlatformApplication'],
        resources: ['*'],
      })
    );
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:SetPlatformApplicationAttributes', 'sns:DeletePlatformApplication'],
        resources: [apnsAppArn],
      })
    );

    const provider = new customResources.Provider(this, 'ApnsPlatformApplicationProvider', {
      onEventHandler: onEvent,
    });

    const platformApp = new cdk.CustomResource(this, 'ApnsPlatformApplication', {
      serviceToken: provider.serviceToken,
      properties: {
        SecretId: apnsCredentialsSecret.secretArn,
        ApplicationName: APNS_PLATFORM_APPLICATION_NAME,
        SyncToken: '2025-12-28-3',
      },
    });
    this.apnsPlatformApplicationArn = platformApp.getAttString('PlatformApplicationArn');
    new cdk.CfnOutput(this, 'ApnsPlatformApplicationArn', {
      value: this.apnsPlatformApplicationArn,
    });

    // ── NotificationType ─────────────────────────────────────────────────────

    const notificationTypeFn = createNotificationLambda('NotificationType', 'notificationType', {
      timeout: cdk.Duration.seconds(NOTIFICATION_TYPE_TIMEOUT_SECONDS),
      environment: {
        QUEUE_URL: userMatcherQueue.queueUrl,
        QUEUE_BATCH_SIZE: NOTIFICATION_SERVICE_QUEUE_BATCH_SIZE.toString(),
        BUCKET_NAME: BILL_STORE_BUCKET_NAME,
        // REL-56: see BACKFILL_PUSH_MODE. Code without the skip ignores it.
        BACKFILL_PUSH_MODE,
      },
    });
    props.notificationTypeQueue.grantConsumeMessages(notificationTypeFn);
    userMatcherQueue.grantSendMessages(notificationTypeFn);
    billStoreBucket.grantRead(notificationTypeFn);

    const { alias: notificationTypeAlias } = addProdAliasWithDeployment(
      this, 'NotificationType', notificationTypeFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.notificationType = notificationTypeAlias;

    notificationTypeAlias.addEventSourceMapping('UserMatcherSQSEventSource', {
      eventSourceArn: props.notificationTypeQueue.queueArn,
      batchSize: NOTIFICATION_SERVICE_QUEUE_BATCH_SIZE,
      enabled: true,
      reportBatchItemFailures: true,
    });

    // ── UserMatcher ──────────────────────────────────────────────────────────

    // Every function that writes, reads or deletes dispatch markers gets the same shard count.
    const dispatchShardEnvironment = {
      DISPATCH_SHARD_COUNT: DISPATCH_SHARD_COUNT.toString(),
    };
    // The pending-notification store settings UserMatcher and NotificationFanout share.
    const pendingNotificationWriterEnvironment = {
      PENDING_NOTIFICATIONS_TABLE: pendingNotificationsTable.tableName,
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY,
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: PENDING_NOTIFICATIONS_TABLE_SORT_KEY,
      PREFERENCE_TABLE: USER_PREFERENCES_TABLE_NAME,
      USER_ID_ATTRIBUTE: USER_PARTITION_KEY,
      SUB_CATEGORY_ATTRIBUTE: USER_PREFERENCES_SORT_KEY,
      ...dispatchShardEnvironment,
    };
    const notificationFanoutEnabled = props.notificationFanoutEnabled ?? NOTIFICATION_FANOUT_ENABLED;

    this.userMatcher = createNotificationLambda('UserMatcher', 'userMatcher', {
      timeout: cdk.Duration.seconds(USER_MATCHER_TIMEOUT_SECONDS),
      environment: {
        ...pendingNotificationWriterEnvironment,
        BUCKET_NAME: BILL_STORE_BUCKET_NAME,
        PREFERENCE_INDEX: USER_PREFERENCES_SUB_CATEGORY_INDEX,
        PRIORITY_TABLE_NAME: props.billPriorityTable.tableName,
        PRIORITY_TABLE_PARTITION_KEY: BILL_PRIORITY_TABLE_PARTITION_KEY,
        // Without it UserMatcher writes every pending notification inline (see NOTIFICATION_FANOUT_ENABLED).
        ...(notificationFanoutEnabled
          ? { NOTIFICATION_FANOUT_QUEUE_URL: notificationFanoutQueue.queueUrl }
          : {}),
        PII_TABLE_NAME: USER_PII_TABLE_NAME,
        PII_PARTITION_KEY: USER_PARTITION_KEY,
        // APPF-23: passed/failed/alert reach the watchers of every member of a companion group, and a
        // user both members' "new" would reach gets one of them, whichever is written first, while the
        // other member's "new" dedupe markers last (3 days; after that both go out).
        ...BILL_COMPANION_ENVIRONMENT,
      },
    });
    userMatcherQueue.grantConsumeMessages(this.userMatcher);
    // Needed by the current code whatever the fan-out switch says, so keep it after fan-out settles:
    // APPF-23 claims a companion pair's "new" deferral with a conditional PutItem of a
    // `companion-new||<House guid>` row in this table's `__dedupe__` partition (userMatcher's
    // claimCompanionNewDeferral). Without it every claim fails, the handler sends that "new" in full,
    // and users both bills match get two "new" pushes. It also covers the inline path's writes (fan-out
    // off, or an alias rollback to a version that writes inline; IAM is not versioned).
    pendingNotificationsTable.grantWriteData(this.userMatcher);
    props.billPriorityTable.grantReadData(this.userMatcher);
    // Granted whether or not fan-out is on: IAM is not versioned, so turning the switch off must not
    // deny the send to the UserMatcher version still running (it was published with the queue URL)
    // until its alias shifts, or after a rollback. Only the env var follows the switch.
    notificationFanoutQueue.grantSendMessages(this.userMatcher);
    preferencesTable.grantReadData(this.userMatcher);
    piiTable.grantReadData(this.userMatcher);
    billStoreBucket.grantRead(this.userMatcher);
    // Reads only: the groups row, the link lists and the BILL_GUID lookup rows (no BILL rows, no Scan).
    grantCompanionResolverRead(this, this.userMatcher);

    const { alias: userMatcherAlias } = addProdAliasWithDeployment(
      this, 'UserMatcher', this.userMatcher, codeDeployApp, deploymentConfig, [], workerDeployment,
    );

    userMatcherAlias.addEventSourceMapping('UserMatcherSQSEventSource', {
      eventSourceArn: userMatcherQueue.queueArn,
      batchSize: NOTIFICATION_SERVICE_QUEUE_BATCH_SIZE,
      enabled: true,
      reportBatchItemFailures: true,
    });

    // ── NotificationFanout ───────────────────────────────────────────────────

    const notificationFanoutFn = createNotificationLambda('NotificationFanout', 'notificationFanout', {
      timeout: cdk.Duration.seconds(NOTIFICATION_FANOUT_TIMEOUT_SECONDS),
      environment: pendingNotificationWriterEnvironment,
    });
    notificationFanoutQueue.grantConsumeMessages(notificationFanoutFn);
    // Each user is one TransactWriteItems of three Puts (dedupe marker, pending row, dispatch marker),
    // plus a fourth for a companion pair member's "new" (APPF-23: the other member's "new" dedupe
    // marker), or a fourth and fifth for an outcome whose change also added an action (UX-33: that
    // action's dedupe marker and row); a Put inside a transaction is authorized as dynamodb:PutItem.
    pendingNotificationsTable.grant(notificationFanoutFn, 'dynamodb:PutItem');
    // The content-type filter reads one user's preference rows (a base-table Query) and nothing else.
    notificationFanoutFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [preferencesTable.tableArn],
      })
    );

    const { alias: notificationFanoutAlias } = addProdAliasWithDeployment(
      this, 'NotificationFanout', notificationFanoutFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.notificationFanout = notificationFanoutAlias;

    notificationFanoutAlias.addEventSourceMapping('NotificationFanoutSQSEventSource', {
      eventSourceArn: notificationFanoutQueue.queueArn,
      batchSize: NOTIFICATION_FANOUT_QUEUE_BATCH_SIZE,
      maxConcurrency: NOTIFICATION_FANOUT_EVENT_SOURCE_MAX_CONCURRENCY,
      enabled: true,
      reportBatchItemFailures: true,
    });

    // ── NotificationDispatcher ───────────────────────────────────────────────

    const notificationDispatcherFn = createNotificationLambda(
      'NotificationDispatcher',
      'notificationDispatcher',
      {
        timeout: cdk.Duration.seconds(NOTIFICATION_DISPATCHER_TIMEOUT_SECONDS),
        environment: {
          PENDING_NOTIFICATIONS_TABLE: pendingNotificationsTable.tableName,
          USER_BATCH_SIZE: NOTIFICATION_DISPATCHER_USER_BATCH_SIZE.toString(),
          PARTITION_KEY: PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY,
          PENDING_NOTIFICATIONS_TABLE_SORT_KEY: PENDING_NOTIFICATIONS_TABLE_SORT_KEY,
          QUEUE_URL: userNotifierQueue.queueUrl,
          QUEUE_BATCH_SIZE: NOTIFICATION_SERVICE_QUEUE_BATCH_SIZE.toString(),
          // Same fixed ARN UserAPIService passes; the application may not exist
          // yet on a fresh stack whose APNs secret has not been seeded.
          APNS_PLATFORM_APPLICATION_ARN: apnsAppArn,
          ...dispatchShardEnvironment,
        },
      },
    );
    pendingNotificationsTable.grantReadWriteData(notificationDispatcherFn);
    userNotifierQueue.grantSendMessages(notificationDispatcherFn);
    // Reads AppleCertificateExpirationDate to publish ApnsCertificateDaysRemaining (REC-04).
    notificationDispatcherFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:GetPlatformApplicationAttributes'],
        resources: [apnsAppArn],
      })
    );
    grantCloudWatchMetricNamespaceWrite(notificationDispatcherFn, NOTIFICATIONS_METRIC_NAMESPACE);

    const { alias: notificationDispatcherAlias } = addProdAliasWithDeployment(
      this, 'NotificationDispatcher', notificationDispatcherFn, codeDeployApp, deploymentConfig, [],
      workerDeployment,
    );

    // C1.1: a delivery EventBridge cannot make goes to ScheduledJobFailures instead of being dropped. A
    // failed run gets no destination: the next run is 5 minutes later, and the heartbeat alarm
    // (Billboard-Heartbeat-NotificationDispatcher, a PushesDown page member) covers a stopped dispatcher.
    new events.Rule(this, 'NotificationDispatcherSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(notificationDispatcherAlias, {
        deadLetterQueue: scheduledJobFailuresQueue(this),
      })],
    });

    // ── UserNotifier ─────────────────────────────────────────────────────────

    const userNotifierFn = createNotificationLambda('UserNotifier', 'userNotifier', {
      timeout: cdk.Duration.seconds(USER_NOTIFIER_TIMEOUT_SECONDS),
      environment: {
        PENDING_NOTIFICATIONS_TABLE: pendingNotificationsTable.tableName,
        PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY,
        PENDING_NOTIFICATIONS_TABLE_SORT_KEY: PENDING_NOTIFICATIONS_TABLE_SORT_KEY,
        DEVICE_TABLE: USER_DEVICES_TABLE_NAME,
        USER_ID_ATTRIBUTE: USER_PARTITION_KEY,
        DEVICE_ID_ATTRIBUTE: USER_DEVICES_SORT_KEY,
        ...dispatchShardEnvironment,
        // APPF-23: counts a companion pair as one bill ("1 New Bill").
        ...BILL_COMPANION_ENVIRONMENT,
        // X6: see USER_NOTIFIER_PENDING_EXPIRY_MODE. Code without the cutoff ignores it.
        PENDING_EXPIRY_MODE: USER_NOTIFIER_PENDING_EXPIRY_MODE,
        // S5: quiet hours (QUIET_HOURS_ENABLED); the user's zone comes from the state on their UserPII row.
        QUIET_HOURS: QUIET_HOURS_ENABLED ? 'on' : 'off',
        PII_TABLE_NAME: USER_PII_TABLE_NAME,
        PII_PARTITION_KEY: USER_PARTITION_KEY,
        // UX-33: at most one push every PUSH_PACE_HOURS per user, and no "vote again" push after a newer vote (the
        // time of the user's vote on the bill, from their UserFeedback row).
        PUSH_PACE_HOURS: PUSH_PACE_HOURS.toString(),
        FEEDBACK_TABLE_NAME: USER_FEEDBACK_TABLE_NAME,
        FEEDBACK_PARTITION_KEY: USER_PARTITION_KEY,
        FEEDBACK_SORT_KEY: USER_FEEDBACK_SORT_KEY,
      },
    });
    userNotifierQueue.grantConsumeMessages(userNotifierFn);
    grantCompanionGroupsRead(this, userNotifierFn);
    pendingNotificationsTable.grantReadWriteData(userNotifierFn);
    userNotifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        resources: [apnsAppArn, apnsEndpointArn],
      })
    );
    devicesTable.grantReadWriteData(userNotifierFn);
    // S5: one GetItem of the user's row (resolvedState, selfAttestedState) for the quiet hours; nothing else in UserPII.
    // Granted whatever QUIET_HOURS_ENABLED says, since IAM is not versioned with the function.
    userNotifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [piiTable.tableArn],
      })
    );
    // UX-33: one GetItem of the user's own row on a bill with a pending "updated" push, projecting votedAt only (never
    // the vote); IAM cannot narrow the key to the user being pushed. Nothing else in UserFeedback, no index.
    userNotifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [feedbackTable.tableArn],
      })
    );

    const { alias: userNotifierAlias } = addProdAliasWithDeployment(
      this, 'UserNotifier', userNotifierFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.userNotifier = userNotifierAlias;

    userNotifierAlias.addEventSourceMapping('UserNotifierSQSEventSource', {
      eventSourceArn: userNotifierQueue.queueArn,
      batchSize: NOTIFICATION_SERVICE_QUEUE_BATCH_SIZE,
      enabled: true,
      reportBatchItemFailures: true,
    });
  }
}
