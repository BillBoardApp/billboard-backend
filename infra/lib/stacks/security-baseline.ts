import * as cdk from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export const MANAGEMENT_TRAIL_NAME = 'BillboardManagementEvents';
/**
 * How long a trail log is kept in all: one year, as the privacy policy says (WEB-07 privacy draft, gap G2; project
 * decision of 2026-11-12). The bucket is versioned, so expiring a log only makes it noncurrent: the log expires at
 * TRAIL_LOG_RETENTION_DAYS - TRAIL_LOG_NONCURRENT_DAYS (335) and its data goes TRAIL_LOG_NONCURRENT_DAYS later.
 * Until 2026-11 it expired at 365 days and went 30 later, about 395 days in all.
 */
export const TRAIL_LOG_RETENTION_DAYS = 365;
/** The part of TRAIL_LOG_RETENTION_DAYS an expired or deleted log is kept as a noncurrent version, to recover it. */
export const TRAIL_LOG_NONCURRENT_DAYS = 30;

/**
 * Account-level audit baseline: one multi-region CloudTrail trail for
 * management events, so API history outlives CloudTrail's rolling 90-day
 * event history. No data events and no CloudWatch Logs delivery, which keeps
 * it inside the free first copy of management events plus S3 storage.
 */
export class SecurityBaselineStack extends cdk.Stack {
  public readonly trailBucket: s3.Bucket;
  public readonly trail: cloudtrail.Trail;

  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    this.trailBucket = new s3.Bucket(this, 'CloudTrailLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: `ExpireTrailLogsWithin${TRAIL_LOG_RETENTION_DAYS}Days`,
          expiration: cdk.Duration.days(TRAIL_LOG_RETENTION_DAYS - TRAIL_LOG_NONCURRENT_DAYS),
          // Expiring a versioned object only adds a delete marker; this removes
          // the data it leaves behind, within TRAIL_LOG_RETENTION_DAYS in all.
          noncurrentVersionExpiration: cdk.Duration.days(TRAIL_LOG_NONCURRENT_DAYS),
        },
      ],
    });

    this.trail = new cloudtrail.Trail(this, 'ManagementEventsTrail', {
      trailName: MANAGEMENT_TRAIL_NAME,
      bucket: this.trailBucket,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      sendToCloudWatchLogs: false,
    });
  }
}

/**
 * Not tagged: any CloudFormation update to these resources, even a tag-only
 * one, can write the template value back over the live value. The SSM
 * parameter holds the bills poller cursor (template value `UNINITIALIZED`),
 * so an update would reset it and skip bills. The secrets hold generated or
 * hand-seeded values and are excluded as a precaution.
 *
 * `aws:cdk:stack` is the stack itself. Stack tags are skipped because
 * CloudFormation copies them onto every taggable resource in the stack,
 * including the types excluded here.
 */
export const COST_ALLOCATION_TAG_EXCLUDED_RESOURCE_TYPES: readonly string[] = [
  'aws:cdk:stack',
  'AWS::SSM::Parameter',
  'AWS::SecretsManager::Secret',
];

/**
 * OBS-14 cost-allocation tags: `project=billboard` on every resource, and
 * `service=<stack id>` on each stack's resources, except the types in
 * COST_ALLOCATION_TAG_EXCLUDED_RESOURCE_TYPES. Both keys must also be
 * activated once under Billing > Cost allocation tags before Cost Explorer
 * can group by them.
 */
export const applyCostAllocationTags = (app: cdk.App): void => {
  const props: cdk.TagProps = {
    excludeResourceTypes: [...COST_ALLOCATION_TAG_EXCLUDED_RESOURCE_TYPES],
  };
  cdk.Tags.of(app).add('project', 'billboard', props);
  for (const child of app.node.children) {
    if (cdk.Stack.isStack(child)) {
      cdk.Tags.of(child).add('service', child.node.id, props);
    }
  }
};
