import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { LAMBDA_ARTIFACTS_BUCKET_NAME } from '../config/deployment-identity';
import {
  SCHEDULED_JOB_FAILURES_QUEUE_NAME,
  SCHEDULED_JOB_FAILURES_RETENTION_DAYS,
} from '../config/scheduled-jobs-constants';

export interface SharedInfraStackProps extends cdk.StackProps {
  readonly lambdaArtifactsBucketName?: string;
  readonly lambdaArtifactsBucketProps?: s3.BucketProps;
}

export class SharedInfraStack extends cdk.Stack {
  public readonly lambdaArtifactsBucket: s3.Bucket;
  public readonly notificationTypeQueue: sqs.Queue;
  public readonly notificationTypeDlq: sqs.Queue;
  public readonly congressMemberStatsQueue: sqs.Queue;
  public readonly congressMemberStatsDlq: sqs.Queue;
  /**
   * C1.1: the dead letters and failure records of every scheduled job. The service stacks reference it by
   * name (helpers/scheduled-job-failures.ts), not through this property.
   */
  public readonly scheduledJobFailuresQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: SharedInfraStackProps = {}) {
    super(scope, id, props);

    // Infra-only synths can fall back to stable artifact keys in the shared bucket.
    // Production release deployments use manifest-pinned object versions instead.
    cdk.Annotations.of(this).acknowledgeWarning(
      "@aws-cdk/aws-lambda:codeFromBucketObjectVersionNotSpecified",
      "Shared release artifacts bucket fallback is intentional for non-release synths.",
    );

    this.lambdaArtifactsBucket = new s3.Bucket(this, 'LambdaArtifactsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      ...props.lambdaArtifactsBucketProps,
      bucketName:
        props.lambdaArtifactsBucketName ??
        props.lambdaArtifactsBucketProps?.bucketName ??
        LAMBDA_ARTIFACTS_BUCKET_NAME,
    });
    // Live stacks load Lambda code from `artifacts/<name>/<sha256>.zip`, and the
    // deploy workflow downloads the pinned `releases/<id>/manifest.json`. An
    // object's age says nothing about whether it is still referenced: the old
    // 90/180-day rules expired the pinned manifest during a quiet spell and would
    // have deleted zips that live functions point at. So:
    //  - `artifacts/` never expires. Keys are content-addressed, so unchanged
    //    code rewrites the same key and the prefix grows only with real changes.
    //  - `releases/` expires only after two years without a deploy.
    // Superseded versions of every key still expire after 7 days (rule below).
    this.lambdaArtifactsBucket.addLifecycleRule({
      id: "ExpireHistoryArtifactsAfter30Days",
      prefix: "history/",
      expiration: cdk.Duration.days(30),
    });
    this.lambdaArtifactsBucket.addLifecycleRule({
      id: "ExpireReleaseArtifactsAfter730Days",
      prefix: "releases/",
      expiration: cdk.Duration.days(730),
    });
    this.lambdaArtifactsBucket.addLifecycleRule({
      id: "ExpireNoncurrentArtifactVersionsAfter7Days",
      noncurrentVersionExpiration: cdk.Duration.days(7),
    });
    this.lambdaArtifactsBucket.addLifecycleRule({
      id: "AbortIncompleteArtifactUploadsAfter7Days",
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
    });

    // Visibility timeouts are 6x the 30-second consumer timeouts, so a message
    // is not redelivered while a slow batch (plus its retries) is still running.
    this.notificationTypeDlq = new sqs.Queue(this, 'NotificationTypeDLQ', {
      queueName: 'NotificationTypeDLQ',
      retentionPeriod: cdk.Duration.days(14),
    });

    this.notificationTypeQueue = new sqs.Queue(this, 'NotificationTypeQueue', {
      queueName: "NotificationTypeQueue",
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: this.notificationTypeDlq,
      },
    });

    this.congressMemberStatsDlq = new sqs.Queue(this, 'CongressMemberStatsDLQ', {
      queueName: 'CongressMemberStatsDLQ',
      retentionPeriod: cdk.Duration.days(14),
    });

    this.congressMemberStatsQueue = new sqs.Queue(this, 'CongressMemberStatsQueue', {
      queueName: 'CongressMemberStatsQueue',
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: this.congressMemberStatsDlq,
      },
    });

    // C1.1: no consumer and no DLQ of its own; a record waits here (and alarms) until someone reads it.
    // This stack deploys before every stack with a schedule, since each takes the artifacts bucket from it.
    // SQS-managed encryption, not KMS, so EventBridge, Scheduler and Lambda need no key grants to write.
    this.scheduledJobFailuresQueue = new sqs.Queue(this, 'ScheduledJobFailuresQueue', {
      queueName: SCHEDULED_JOB_FAILURES_QUEUE_NAME,
      retentionPeriod: cdk.Duration.days(SCHEDULED_JOB_FAILURES_RETENTION_DAYS),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    // EventBridge rules write their dead letters under this queue policy (Scheduler and Lambda use their own
    // roles instead). The rules live in other stacks and see this queue only as an import, on which CDK's
    // events-targets helper silently adds nothing, so the statement is written here. Without it EventBridge
    // is denied and a rule's failed deliveries are dropped as before.
    this.scheduledJobFailuresQueue.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowEventBridgeRuleDeadLetters',
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [this.scheduledJobFailuresQueue.queueArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:${this.partition}:events:${this.region}:${this.account}:rule/*` },
      },
    }));
  }
}
