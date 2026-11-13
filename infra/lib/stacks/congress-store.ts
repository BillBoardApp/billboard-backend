import * as cdk from 'aws-cdk-lib';
import { Construct, IDependable } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  BILL_STORE_BUCKET_NAME,
  CONGRESS_MEMBER_STORE_BUCKET_NAME,
  BILLS_MANIFEST_TABLE_NAME,
  BILLS_MANIFEST_TABLE_PRIMARY_KEY,
  BILLS_MANIFEST_TABLE_SORT_KEY,
  BILLS_MANIFEST_TABLE_PK_VALUE,
  BILLS_MANIFEST_BATCH_SIZE,
  CONGRESS_MEMBERS_MANIFEST_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
  CONGRESS_MEMBERS_MANIFEST_BATCH_SIZE,
  MEMBER_STATS_RAW_BILL_TRIGGER,
} from '../config/congress-store-constants';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import {
  createReleaseBackedLambdaFactory,
} from './helpers/lambda-utils';
import { addProdAliasWithDeployment } from './helpers/codedeploy-utils';

class SqsDestinationNoPolicy implements s3.IBucketNotificationDestination {
  public constructor(
    private readonly queue: sqs.IQueue,
    private readonly dependencies: IDependable[] = []
  ) {}

  public bind(_scope: Construct, _bucket: s3.IBucket): s3.BucketNotificationDestinationConfig {
    return {
      type: s3.BucketNotificationDestinationType.QUEUE,
      arn: this.queue.queueArn,
      dependencies: this.dependencies,
    };
  }
}

/**
 * The bill and member stores. Only the functions this stack creates (CreateBillsManifest and
 * CreateCongressMembersManifest) are granted here; the service stacks grant their own functions access
 * by bucket and table name (CQ-15), so this stack takes no functions from them.
 */
export interface CongressStoreStackProps extends cdk.StackProps {
  // Shared Services
  lambdaArtifactsBucket: s3.IBucket;
  notificationTypeQueue: sqs.Queue;
  congressMemberStatsQueue: sqs.IQueue;
  /**
   * Whether raw-bills/ writes also notify CongressMemberStatsQueue (CAP-05).
   * @default MEMBER_STATS_RAW_BILL_TRIGGER
   */
  memberStatsRawBillTrigger?: boolean;
}

export class CongressStoreStack extends cdk.Stack {
  public readonly congressMemberStatsQueue: sqs.IQueue;

  constructor(scope: Construct, id: string, props: CongressStoreStackProps) {
    super(scope, id, props);
    const createCongressStoreLambda = createReleaseBackedLambdaFactory(
      this,
      props.lambdaArtifactsBucket,
    );

    const codeDeployApp = new codedeploy.LambdaApplication(this, 'CongressStoreApp', {
      applicationName: 'CongressStore',
    });
    // Both functions here are SQS workers, so they deploy all at once (REL-18).
    const deploymentConfig = codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE;

    this.congressMemberStatsQueue = props.congressMemberStatsQueue;

    // ── Bills Store ───────────────────────────────────────────────────────────

    const billStoreBucket = new s3.Bucket(this, 'BillStoreBucket', {
      bucketName: BILL_STORE_BUCKET_NAME,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      // No current-version expiry (REL-34): a bill unchanged for a year must stay readable, and an
      // expired raw bill would make the next fetch look brand new. Only superseded versions expire.
      lifecycleRules: [
        {
          id: 'RawBillsExpireNoncurrentVersionsAfter7Days',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(7),
          prefix: 'raw-bills/',
        },
        {
          // Keeps a month of prior summaries so a bad summarizer run can be
          // rolled back without paying Bedrock to regenerate them.
          id: 'ProcessedBillsExpireNoncurrentVersionsAfter30Days',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
          prefix: 'processed-bills/',
        },
      ]
    });

    const billsManifestTable = new ddb.Table(this, 'BillManifestTable', {
      partitionKey: { name: BILLS_MANIFEST_TABLE_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: BILLS_MANIFEST_TABLE_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: BILLS_MANIFEST_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    // ── CreateBillsManifest ───────────────────────────────────────────────────

    const createBillsManifestFn = createCongressStoreLambda(
      'CreateBillsManifest',
      'createBillsManifest',
      {
        environment: {
          BUCKET_NAME: BILL_STORE_BUCKET_NAME,
          TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
          PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
          SORT_KEY: BILLS_MANIFEST_TABLE_SORT_KEY,
          PK_VALUE: BILLS_MANIFEST_TABLE_PK_VALUE,
          QUEUE_URL: props.notificationTypeQueue.queueUrl,
          CONGRESS_MEMBER_STATS_QUEUE_URL: props.congressMemberStatsQueue.queueUrl,
        },
        timeout: cdk.Duration.seconds(120),
      },
    );
    billStoreBucket.grantRead(createBillsManifestFn);
    billsManifestTable.grantReadWriteData(createBillsManifestFn);
    props.notificationTypeQueue.grantSendMessages(createBillsManifestFn);
    props.congressMemberStatsQueue.grantSendMessages(createBillsManifestFn);

    const { alias: createBillsManifestAlias } = addProdAliasWithDeployment(
      this, 'CreateBillsManifest', createBillsManifestFn, codeDeployApp, deploymentConfig, [],
      { deploymentKind: 'worker' },
    );

    // Explicit names: MonitoringStack alarms on these queues (and their DLQs) by name.
    const billsManifestDLQ = new sqs.Queue(this, "BillsManifestDLQ", {
      queueName: "BillsManifestDLQ",
      retentionPeriod: cdk.Duration.days(14),
    });
    const billsManifestQueue = new sqs.Queue(this, "BillsManifestQueue", {
      queueName: "BillsManifestQueue",
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: billsManifestDLQ,
      },
    });
    billsManifestQueue.grantConsumeMessages(createBillsManifestFn);

    createBillsManifestAlias.addEventSource(
      new SqsEventSource(billsManifestQueue, {
        batchSize: BILLS_MANIFEST_BATCH_SIZE,
        reportBatchItemFailures: true,
        enabled: true,
      })
    );

    // CAP-05: member stats are driven by the processed-bill versions CreateBillsManifest forwards
    // (CONGRESS_MEMBER_STATS_QUEUE_URL above). The raw-bills/ trigger, and the queue policy that
    // exists only for it, come back when MEMBER_STATS_RAW_BILL_TRIGGER is true.
    if (props.memberStatsRawBillTrigger ?? MEMBER_STATS_RAW_BILL_TRIGGER) {
      const congressMemberStatsQueuePolicy = new sqs.QueuePolicy(this, 'CongressMemberStatsQueuePolicy', {
        queues: [props.congressMemberStatsQueue],
      });
      congressMemberStatsQueuePolicy.document.addStatements(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
          actions: ['sqs:SendMessage'],
          resources: [props.congressMemberStatsQueue.queueArn],
          conditions: {
            ArnEquals: {
              'aws:SourceArn': billStoreBucket.bucketArn,
            },
            StringEquals: {
              'aws:SourceAccount': cdk.Stack.of(this).account,
            },
          },
        })
      );
      billStoreBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new SqsDestinationNoPolicy(props.congressMemberStatsQueue, [congressMemberStatsQueuePolicy]),
        { prefix: "raw-bills/", suffix: ".json" }
      );
    }

    billStoreBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(billsManifestQueue),
      { prefix: "processed-bills/", suffix: ".json" }
    );
    billStoreBucket.addEventNotification(
      s3.EventType.OBJECT_REMOVED,
      new s3n.SqsDestination(billsManifestQueue),
      { prefix: "processed-bills/", suffix: ".json" }
    );

    // ── Congress Member Store ─────────────────────────────────────────────────

    const congressMemberStoreBucket = new s3.Bucket(this, 'CongressMemberStoreBucket', {
      bucketName: CONGRESS_MEMBER_STORE_BUCKET_NAME,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      // No current-version expiry (REL-34): members who left Congress are no longer refreshed but
      // stay referenced by their bills. Only superseded versions expire.
      lifecycleRules: [
        {
          id: 'CongressMembersExpireNoncurrentVersionsAfter7Days',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(7),
        },
      ]
    });

    const congressMembersManifestTable = new ddb.Table(this, 'CongressMembersManifestTable', {
      partitionKey: { name: CONGRESS_MEMBERS_MANIFEST_TABLE_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      tableName: CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    // ── CreateCongressMembersManifest ─────────────────────────────────────────

    const createCongressMembersManifestFn = createCongressStoreLambda(
      'CreateCongressMembersManifest',
      'createCongressMembersManifest',
      {
        environment: {
          BUCKET_NAME: CONGRESS_MEMBER_STORE_BUCKET_NAME,
          TABLE_NAME: CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
          PRIMARY_KEY: CONGRESS_MEMBERS_MANIFEST_TABLE_PRIMARY_KEY,
        },
        timeout: cdk.Duration.seconds(45),
      },
    );
    congressMemberStoreBucket.grantRead(createCongressMembersManifestFn);
    congressMembersManifestTable.grantWriteData(createCongressMembersManifestFn);

    const { alias: createCongressMembersManifestAlias } = addProdAliasWithDeployment(
      this, 'CreateCongressMembersManifest', createCongressMembersManifestFn, codeDeployApp, deploymentConfig, [],
      { deploymentKind: 'worker' },
    );

    const congressMembersManifestDLQ = new sqs.Queue(this, "CongressMembersManifestDLQ", {
      queueName: "CongressMembersManifestDLQ",
      retentionPeriod: cdk.Duration.days(14),
    });
    const congressMembersManifestQueue = new sqs.Queue(this, "CongressMembersManifestQueue", {
      queueName: "CongressMembersManifestQueue",
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: congressMembersManifestDLQ,
      },
    });
    congressMembersManifestQueue.grantConsumeMessages(createCongressMembersManifestFn);

    createCongressMembersManifestAlias.addEventSource(
      new SqsEventSource(congressMembersManifestQueue, {
        batchSize: CONGRESS_MEMBERS_MANIFEST_BATCH_SIZE,
        reportBatchItemFailures: true,
        enabled: true,
      })
    );

    congressMemberStoreBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(congressMembersManifestQueue),
      { prefix: "processed-congress-members/", suffix: ".json" }
    );
    congressMemberStoreBucket.addEventNotification(
      s3.EventType.OBJECT_REMOVED,
      new s3n.SqsDestination(congressMembersManifestQueue),
      { prefix: "processed-congress-members/", suffix: ".json" }
    );
  }
}
