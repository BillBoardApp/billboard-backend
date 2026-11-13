import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { SqsDlq, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import {
  BILL_STORE_BUCKET_NAME,
  BILLS_MANIFEST_TABLE_NAME,
  BILLS_MANIFEST_TABLE_PK_VALUE,
  BILLS_MANIFEST_TABLE_PRIMARY_KEY,
  BILLS_MANIFEST_TABLE_SORT_KEY,
  CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
} from '../config/congress-store-constants';
import {
  BILL_STATS_AGGREGATOR_CONCURRENCY,
  BILL_STATS_AGGREGATOR_MEMORY_MB,
  BILL_STATS_AGGREGATOR_STREAM_BATCH_SIZE,
  BILL_STATS_AGGREGATOR_STREAM_MAX_BATCHING_WINDOW_SECONDS,
  BILL_STATS_AGGREGATOR_STREAM_PARALLELIZATION_FACTOR,
  BILL_STATS_AGGREGATOR_TIMEOUT_SECONDS,
  CONGRESS_MEMBERS_STATS_QUEUE_BATCH_SIZE,
} from '../config/analytics-service-constants';
import {
  CONGRESS_MEMBER_STATS_TABLE_NAME,
  CONGRESS_MEMBER_STATS_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_SORT_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_NAME,
  CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_SORT_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_SORT_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SORT_KEY,
} from '../config/aggregate-data-store-constants';
import {
  USER_BILL_STATS_PARTITION_KEY,
  USER_BILL_STATS_TABLE_NAME,
  USER_FEEDBACK_BILL_ID_INDEX,
  USER_FEEDBACK_SORT_KEY,
  USER_FEEDBACK_TABLE_NAME,
  USER_PARTITION_KEY,
} from '../config/user-store-constants';
import {
  createReleaseBackedLambdaFactory,
} from './helpers/lambda-utils';
import { addProdAliasWithDeployment } from './helpers/codedeploy-utils';
import { storeBucket, storeTable } from './helpers/data-store-refs';
import { BILL_COMPANION_ENVIRONMENT } from './helpers/bill-companions';

export interface AnalyticsServiceStackProps extends cdk.StackProps {
  readonly lambdaArtifactsBucket: s3.IBucket;
  readonly congressMemberStatsQueue: sqs.Queue;
  /**
   * UserStoreStack's UserFeedback stream. A stream ARN has no fixed name, so this is the one store
   * attribute still passed in; the tables themselves are referenced by name (CQ-15).
   */
  readonly feedbackTableStreamArn: string;
  readonly enableFeedbackStreamAggregation?: boolean;
}

export class AnalyticsServiceStack extends cdk.Stack {
  /** prod alias for congressMemberStats — use for downstream invocations */
  public readonly congressMemberStats: lambda.IFunction;
  /**
   * Underlying function for billStatsAggregator (not the alias). The DynamoDB stream ESM is attached
   * to the internal alias.
   */
  public readonly billStatsAggregator: lambda.Function;

  constructor(scope: Construct, id: string, props: AnalyticsServiceStackProps) {
    super(scope, id, props);
    const createAnalyticsLambda = createReleaseBackedLambdaFactory(
      this,
      props.lambdaArtifactsBucket,
    );

    const codeDeployApp = new codedeploy.LambdaApplication(this, 'AnalyticsServiceApp', {
      applicationName: 'AnalyticsService',
    });
    // Both functions here are queue/stream workers, so they deploy all at once (REL-18).
    const deploymentConfig = codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE;
    // The store tables and bucket, referenced by their fixed names (CQ-15).
    const billStoreBucket = storeBucket(this, 'billStore');
    const billsManifestTable = storeTable(this, 'billsManifest');

    // ── CongressMemberStats ───────────────────────────────────────────────────

    const congressMemberStatsFn = createAnalyticsLambda(
      'CongressMemberStats',
      'congressMemberStats',
      {
      environment: {
        BUCKET_NAME: BILL_STORE_BUCKET_NAME,
        TABLE_NAME: CONGRESS_MEMBER_STATS_TABLE_NAME,
        PRIMARY_KEY: CONGRESS_MEMBER_STATS_TABLE_PRIMARY_KEY,
        CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
        VOTE_PROFILE_TABLE_NAME: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME,
        VOTE_PROFILE_PRIMARY_KEY: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_PRIMARY_KEY,
        VOTE_PROFILE_SORT_KEY: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_SORT_KEY,
        VOTE_PROFILE_BILL_GUID_INDEX_NAME: CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_NAME,
        VOTE_PROFILE_BILL_GUID_INDEX_PK: CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY,
        VOTE_PROFILE_BILL_GUID_INDEX_SK: CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_SORT_KEY,
        // Without the table name the handler skips member legislative profiles, leaving
        // them to the backfill script.
        LEGISLATIVE_PROFILE_TABLE_NAME: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME,
        LEGISLATIVE_PROFILE_PRIMARY_KEY: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_PRIMARY_KEY,
        LEGISLATIVE_PROFILE_SORT_KEY: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_SORT_KEY,
        LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME,
        LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PK: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY,
        LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SK: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SORT_KEY,
      },
      timeout: cdk.Duration.seconds(30),
    });
    props.congressMemberStatsQueue.grantConsumeMessages(congressMemberStatsFn);

    const { alias: congressMemberStatsAlias } = addProdAliasWithDeployment(
      this, 'CongressMemberStats', congressMemberStatsFn, codeDeployApp, deploymentConfig, [],
      { deploymentKind: 'worker' },
    );
    this.congressMemberStats = congressMemberStatsAlias;

    congressMemberStatsAlias.addEventSource(
      new SqsEventSource(props.congressMemberStatsQueue, {
        batchSize: CONGRESS_MEMBERS_STATS_QUEUE_BATCH_SIZE,
        maxConcurrency: 2,
        reportBatchItemFailures: true,
        enabled: true,
      })
    );
    billStoreBucket.grantRead(congressMemberStatsFn);
    storeTable(this, 'congressMembersManifest').grantReadData(congressMemberStatsFn);
    storeTable(this, 'congressMemberStats').grantReadWriteData(congressMemberStatsFn);
    storeTable(this, 'congressMemberVoteProfiles').grantReadWriteData(congressMemberStatsFn);
    storeTable(this, 'congressMemberLegislativeProfiles').grantReadWriteData(congressMemberStatsFn);

    // ── BillStatsAggregator ───────────────────────────────────────────────────

    this.billStatsAggregator = createAnalyticsLambda(
      'BillStatsAggregator',
      'billStatsAggregator',
      {
      environment: {
        TABLE_NAME: USER_FEEDBACK_TABLE_NAME,
        PARTITION_KEY: USER_PARTITION_KEY,
        SORT_KEY: USER_FEEDBACK_SORT_KEY,
        BILL_ID_INDEX_NAME: USER_FEEDBACK_BILL_ID_INDEX,
        STATS_TABLE_NAME: USER_BILL_STATS_TABLE_NAME,
        STATS_PARTITION_KEY: USER_BILL_STATS_PARTITION_KEY,
        BILL_STATS_CONCURRENCY: BILL_STATS_AGGREGATOR_CONCURRENCY.toString(),
        // APPF-23: a recompute of a grouped bill also writes the group's COMPANIONS#... stats document
        // to BillStats. Its manifest and BillStats grants below cover the groups row and that write.
        ...BILL_COMPANION_ENVIRONMENT,
        MANIFEST_TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
        MANIFEST_PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
        MANIFEST_SORT_KEY: BILLS_MANIFEST_TABLE_SORT_KEY,
        MANIFEST_PK_VALUE: BILLS_MANIFEST_TABLE_PK_VALUE,
        MANIFEST_GUID_LOOKUP_PK: `${BILLS_MANIFEST_TABLE_PK_VALUE}_GUID`,
      },
      memorySize: BILL_STATS_AGGREGATOR_MEMORY_MB,
      timeout: cdk.Duration.seconds(BILL_STATS_AGGREGATOR_TIMEOUT_SECONDS),
    });
    storeTable(this, 'userFeedback').grantReadData(this.billStatsAggregator);
    storeTable(this, 'billStats').grantWriteData(this.billStatsAggregator);

    const { alias: billStatsAggregatorAlias } = addProdAliasWithDeployment(
      this, 'BillStatsAggregator', this.billStatsAggregator, codeDeployApp, deploymentConfig, [],
      { deploymentKind: 'worker' },
    );

    const enableFeedbackStreamAggregation =
      props.enableFeedbackStreamAggregation ?? true;

    if (enableFeedbackStreamAggregation) {
      this.billStatsAggregator.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'dynamodb:DescribeStream',
            'dynamodb:GetRecords',
            'dynamodb:GetShardIterator',
            'dynamodb:ListStreams',
          ],
          resources: [props.feedbackTableStreamArn],
        }),
      );

      // Receives batch metadata (shard and sequence range), not the records;
      // replay from the stream before its 24-hour retention runs out.
      const billStatsAggregatorStreamDLQ = new sqs.Queue(this, 'BillStatsAggregatorStreamDLQ', {
        queueName: 'BillStatsAggregatorStreamDLQ',
        retentionPeriod: cdk.Duration.days(14),
      });

      // ESM attached to alias so CodeDeploy traffic shifting is respected. Large batches gathered
      // over a 30 s window (CAP-04): each batch recomputes every bill it touches once. No
      // ReportBatchItemFailures: a failed batch is bisected and retried whole.
      new lambda.EventSourceMapping(this, 'BillStatsAggregatorFeedbackStream', {
        target: billStatsAggregatorAlias,
        eventSourceArn: props.feedbackTableStreamArn,
        batchSize: BILL_STATS_AGGREGATOR_STREAM_BATCH_SIZE,
        maxBatchingWindow: cdk.Duration.seconds(BILL_STATS_AGGREGATOR_STREAM_MAX_BATCHING_WINDOW_SECONDS),
        parallelizationFactor: BILL_STATS_AGGREGATOR_STREAM_PARALLELIZATION_FACTOR,
        startingPosition: lambda.StartingPosition.LATEST,
        bisectBatchOnError: true,
        retryAttempts: 5,
        onFailure: new SqsDlq(billStatsAggregatorStreamDLQ),
      });
    }
    billsManifestTable.grantReadWriteData(this.billStatsAggregator);
  }
}
