import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { BILL_STORE_BUCKET_NAME, CONGRESS_MEMBER_STORE_BUCKET_NAME, CONGRESS_MEMBERS_MANIFEST_TABLE_NAME } from '../config/congress-store-constants';
import { BILLS_DIFFER_QUEUE_BATCH_SIZE,
  BILLS_DIFFER_QUEUE_MAX_RECEIVE_COUNT,
  BILLS_API_POLLER_LAMBDA_TIMEOUT_SECONDS,
  BILLS_API_POLLER_RESERVED_CONCURRENCY,
  BILLS_API_POLLER_SEND_BATCH_SIZE,
  BILL_TEXT_MAX_RETRIES,
  BILL_TEXT_RETRY_DELAY_SECONDS,
  BILL_VOTE_ENRICHMENT_QUEUE_BATCH_SIZE,
  BILL_VOTE_ENRICHMENT_QUEUE_TIMEOUT_SECONDS,
  BILL_XML_FETCH_BUDGET_MS,
  BILL_XML_REFUSED_HOST_COOLDOWN_MS,
  BILL_XML_REUSE_SAME_VERSION,
  BILL_XML_SOURCES,
  BILLS_DIFFER_QUEUE_TIMEOUT_SECONDS,
  CONGRESS_MEMBERS_SUMMARIZER_QUEUE_BATCH_SIZE,
  CONGRESS_MEMBERS_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT,
  CONGRESS_MEMBERS_SUMMARIZER_QUEUE_TIMEOUT_SECONDS,
  ENRICH_OFFICIAL_VOTES_EVENT_SOURCE_MAX_CONCURRENCY,
  ENRICH_OFFICIAL_VOTES_LAMBDA_MEMORY_MB,
  ENRICH_OFFICIAL_VOTES_RESERVED_CONCURRENCY,
  ENRICH_OFFICIAL_VOTES_LAMBDA_TIMEOUT_SECONDS,
  FETCH_RAW_BILLS_EVENT_SOURCE_MAX_CONCURRENCY,
  FETCH_RAW_BILLS_LAMBDA_MEMORY_MB,
  FETCH_RAW_BILLS_RESERVED_CONCURRENCY,
  FETCH_CONGRESS_MEMBERS_LIST_LAMBDA_TIMEOUT_SECONDS,
  FETCH_RAW_BILLS_LAMBDA_TIMEOUT_SECONDS,
  FETCH_RAW_CONGRESS_MEMBERS_EVENT_SOURCE_MAX_CONCURRENCY,
  FETCH_RAW_CONGRESS_MEMBERS_LAMBDA_TIMEOUT_SECONDS,
  FETCH_RAW_BILL_RETRY_LADDER_SECONDS,
  FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES,
  FETCH_RAW_BILL_RETRY_OTHER_SECONDS,
  FETCH_RETRY_BACKOFF,
  UPDATED_BILLS_QUEUE_BATCH_SIZE,
  UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT,
  UPDATED_BILLS_QUEUE_TIMEOUT_SECONDS,
  UPDATED_CONGRESS_MEMBERS_QUEUE_BATCH_SIZE,
  UPDATED_CONGRESS_MEMBERS_QUEUE_MAX_RECEIVE_COUNT,
  UPDATED_CONGRESS_MEMBERS_QUEUE_TIMEOUT_SECONDS,
  INGEST_DLQ_RETENTION_DAYS,
  BILLS_API_POLLER_LAMBDA_MEMORY_MB,
  BILLS_API_POLLER_MAX_PAGES_PER_BILL_TYPE,
  CONGRESS_API_CALL_DELAY_MS,
  CONGRESS_API_MAX_CALLS_PER_BILL,
  CONGRESS_API_MAX_HOUSE_VOTE_PAGES,
  CONGRESS_API_MAX_RETRIES,
  CONGRESS_API_REQUEST_TIMEOUT_MS,
  CONGRESS_VOTE_CALL_DELAY_MS,
  CONGRESS_VOTE_MAX_CALLS_PER_BILL,
  POLL_BILL_TYPES,
  POLL_CONGRESS,
  POLL_TARGETS,
  REFETCH_UNCHANGED_MODE,
  SOFT_STOP_REMAINING_MS,
  VOTE_ENRICHMENT_DEFER_DELAY_SECONDS,
  VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS} from '../config/congress-integration-service-constants';
import { FETCH_CONGRESS_MEMBERS_LIST_ASYNC_RETRY_ATTEMPTS } from '../config/scheduled-jobs-constants';
import {
  createReleaseBackedLambdaFactory,
  grantCloudWatchMetricNamespaceWrite,
} from './helpers/lambda-utils';
import {
  addProdAliasWithDeployment,
  ProdAliasDeploymentOptions,
} from './helpers/codedeploy-utils';
import { storeBucket, storeTable } from './helpers/data-store-refs';
import {
  scheduledJobFailureDestination,
  scheduledJobFailuresQueue,
} from './helpers/scheduled-job-failures';

/**
 * REL-35 switch (FetchRawBill, integration plan X7). 'watch' works out on each refetch whether the stored
 * bill's enriched member votes would be carried forward, logs the decision and emits MemberVotesCarriable,
 * then stores the bill exactly as before (no IfMatch). 'on' carries them forward (C2 3.9): the new bill keeps
 * the previous members and lastSyncedAt for the same roll call, is stored with IfMatch on the previous ETag,
 * and emits MemberVotesCarried. Anything else means watch. 'on' since 2026-11-09, by a project decision on
 * the X7 evidence then at hand (docs/RUNBOOK.md 14.8), before the REL-56 backfill and REL-32; set it back to
 * 'watch' and deploy CongressIntegrationServiceStack to roll back.
 */
export const MEMBER_VOTE_CARRY_MODE: 'watch' | 'on' = 'on';

export interface CongressIntegrationServiceStackProps extends cdk.StackProps {
  readonly lambdaArtifactsBucket: s3.IBucket;
}

export class CongressIntegrationServiceStack extends cdk.Stack {
  /** prod alias — use for all downstream invocations */
  public readonly billsApiPoller: lambda.IFunction;
  public readonly fetchRawBill: lambda.IFunction;
  public readonly enrichOfficialVotes: lambda.IFunction;
  public readonly fetchCongressMembersList: lambda.IFunction;
  public readonly fetchRawCongressMembers: lambda.IFunction;
  public readonly billDifferQueue: sqs.Queue;
  public readonly billVoteEnrichmentQueue: sqs.Queue;
  public readonly congressMemberSummarizerQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: CongressIntegrationServiceStackProps) {
    super(scope, id, props);
    // Ingestion logs are kept 90 days so an incident is still diagnosable after a month.
    const createCongressIntegrationLambda = createReleaseBackedLambdaFactory(
      this,
      props.lambdaArtifactsBucket,
      { logRetention: logs.RetentionDays.THREE_MONTHS },
    );

    const codeDeployApp = new codedeploy.LambdaApplication(this, 'CongressIntegrationApp', {
      applicationName: 'CongressIntegrationService',
    });
    // Every function here is an SQS or scheduled worker, so each shifts traffic all at once
    // (the helper ignores deploymentConfig for workers).
    const deploymentConfig = codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE;
    const workerDeployment: ProdAliasDeploymentOptions = { deploymentKind: 'worker' };

    const congressApiSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'CongressAPISecret',
      'CongressAPIKey'
    );
    // CongressStoreStack's stores, referenced by their fixed names (CQ-15).
    const billStoreBucket = storeBucket(this, 'billStore');
    const congressMemberStoreBucket = storeBucket(this, 'congressMemberStore');
    const congressMembersManifestTable = storeTable(this, 'congressMembersManifest');

    // Bills retrieval Bucket, Queues, and Lambdas
    // The ingest DLQs keep failed messages INGEST_DLQ_RETENTION_DAYS (14) instead of the SQS default of 4.
    const ingestDlqRetention = cdk.Duration.days(INGEST_DLQ_RETENTION_DAYS);
    const billDifferDLQ = new sqs.Queue(this, 'BillDifferDLQ', {
      queueName: 'BillDifferDLQ',
      retentionPeriod: ingestDlqRetention,
    });

    this.billDifferQueue = new sqs.Queue(this, 'BillDifferQueue', {
      queueName: 'BillDifferQueue',
      deadLetterQueue: {
        maxReceiveCount: BILLS_DIFFER_QUEUE_MAX_RECEIVE_COUNT,
        queue: billDifferDLQ,
      },
      visibilityTimeout: cdk.Duration.seconds(BILLS_DIFFER_QUEUE_TIMEOUT_SECONDS),
    });

    const updatedBillsDLQ = {
      maxReceiveCount: UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT,
      queue: new sqs.Queue(this, 'UpdatedBillsDLQ', {
        queueName: 'UpdatedBillsDLQ',
        retentionPeriod: ingestDlqRetention,
      })
    };

    const updatedBillsQueue = new sqs.Queue(this, 'UpdatedBillsQueue', {
      queueName: 'UpdatedBillsQueue',
      deadLetterQueue: updatedBillsDLQ,
      visibilityTimeout: cdk.Duration.seconds(UPDATED_BILLS_QUEUE_TIMEOUT_SECONDS),
    });

    const billVoteEnrichmentDLQ = new sqs.Queue(this, 'BillVoteEnrichmentDLQ', {
      queueName: 'BillVoteEnrichmentDLQ',
      retentionPeriod: ingestDlqRetention,
    });

    this.billVoteEnrichmentQueue = new sqs.Queue(this, 'BillVoteEnrichmentQueue', {
      queueName: 'BillVoteEnrichmentQueue',
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: billVoteEnrichmentDLQ,
      },
      visibilityTimeout: cdk.Duration.seconds(BILL_VOTE_ENRICHMENT_QUEUE_TIMEOUT_SECONDS),
    });

    // Holds the live poller cursor. Any CloudFormation update to this resource,
    // tags included, writes 'UNINITIALIZED' back over the cursor, so leave it unchanged.
    const billsPollerStateParameter = new ssm.StringParameter(this, 'BillsApiPollerStateParameter', {
      parameterName: '/billboard/congress/bills-poller-state',
      stringValue: 'UNINITIALIZED',
    });
    // REL-46: the 120th Congress's cursor (POLL_TARGETS), under the same rule: never update it once deployed. It stays
    // UNINITIALIZED until the first run after the 120th starts (17:00Z on 2027-01-03).
    const billsPollerStateParameter120 = new ssm.StringParameter(this, 'BillsApiPollerStateParameter120', {
      parameterName: '/billboard/congress/bills-poller-state-120',
      stringValue: 'UNINITIALIZED',
    });

    const billsApiPollerFn = createCongressIntegrationLambda(
      'BillsApiPoller',
      'billsApiPoller',
      {
      environment: {
        SECRET_NAME: congressApiSecret.secretName,
        STATE_PARAMETER_NAME: billsPollerStateParameter.parameterName,
        QUEUE_URL: updatedBillsQueue.queueUrl,
        // SendMessageBatch chunk size, not FetchRawBill's receive batch size.
        QUEUE_BATCH_SIZE: BILLS_API_POLLER_SEND_BATCH_SIZE.toString(),
        POLL_CONGRESS: POLL_CONGRESS.toString(),
        POLL_TARGETS,
        BILL_TYPES: POLL_BILL_TYPES,
        MAX_PAGES_PER_BILL_TYPE: BILLS_API_POLLER_MAX_PAGES_PER_BILL_TYPE.toString(),
        CONGRESS_API_MAX_RETRIES: CONGRESS_API_MAX_RETRIES.toString(),
        CONGRESS_API_REQUEST_TIMEOUT_MS: CONGRESS_API_REQUEST_TIMEOUT_MS.toString(),
        SOFT_STOP_REMAINING_MS: SOFT_STOP_REMAINING_MS.toString(),
      },
      // 1 unless BILLS_API_POLLER_RESERVED_CONCURRENCY=off; see the constant.
      reservedConcurrentExecutions: BILLS_API_POLLER_RESERVED_CONCURRENCY,
      timeout: cdk.Duration.seconds(BILLS_API_POLLER_LAMBDA_TIMEOUT_SECONDS),
      memorySize: BILLS_API_POLLER_LAMBDA_MEMORY_MB,
    });
    updatedBillsQueue.grantSendMessages(billsApiPollerFn);
    congressApiSecret.grantRead(billsApiPollerFn);
    billsPollerStateParameter.grantRead(billsApiPollerFn);
    billsPollerStateParameter.grantWrite(billsApiPollerFn);
    billsPollerStateParameter120.grantRead(billsApiPollerFn);
    billsPollerStateParameter120.grantWrite(billsApiPollerFn);
    grantCloudWatchMetricNamespaceWrite(billsApiPollerFn, 'BillBoard/BillIngestion');

    const { alias: billsApiPollerAlias } = addProdAliasWithDeployment(
      this, 'BillsApiPoller', billsApiPollerFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.billsApiPoller = billsApiPollerAlias;

    // C1.1: a delivery EventBridge cannot make (missing permission, deleted alias) goes to
    // ScheduledJobFailures instead of being dropped. A failed run gets no destination: the next run,
    // 5 minutes later, is the rerun, and Billboard-Heartbeat-BillsApiPoller covers a run of failures.
    new events.Rule(this, 'BillsApiPollerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(billsApiPollerAlias, {
        deadLetterQueue: scheduledJobFailuresQueue(this),
      })],
    });

    const fetchRawBillFn = createCongressIntegrationLambda('FetchRawBill', 'fetchRawBill', {
      environment: {
        BUCKET_NAME: BILL_STORE_BUCKET_NAME,
        SECRET_NAME: congressApiSecret.secretName,
        QUEUE_URL: this.billDifferQueue.queueUrl,
        VOTE_ENRICHMENT_QUEUE_URL: this.billVoteEnrichmentQueue.queueUrl,
        QUEUE_BATCH_SIZE: BILLS_DIFFER_QUEUE_BATCH_SIZE.toString(),
        CONGRESS_API_CALL_DELAY_MS: CONGRESS_API_CALL_DELAY_MS.toString(),
        CONGRESS_API_MAX_CALLS_PER_BILL: CONGRESS_API_MAX_CALLS_PER_BILL.toString(),
        CONGRESS_API_MAX_RETRIES: CONGRESS_API_MAX_RETRIES.toString(),
        CONGRESS_API_REQUEST_TIMEOUT_MS: CONGRESS_API_REQUEST_TIMEOUT_MS.toString(),
        // REL-35 (X7), switched by MEMBER_VOTE_CARRY_MODE. The carry read is one S3 GetObject of the stored raw bill, and the 'on'
        // write a PutObject with IfMatch; both are covered by the bill store grant below.
        MEMBER_VOTE_CARRY_MODE,
        // REL-57: an unchanged poller refetch is logged and counted ('watch') or not stored ('on'). It compares with the
        // stored copy the carry already reads, so it needs no grant.
        REFETCH_UNCHANGED_MODE,
        // REL-58: the retry ladder. FetchRawBill sets a failed record's visibility on the record's own queue (from its
        // eventSourceARN), which the consume grant below covers (sqs:ChangeMessageVisibility). The receive count is
        // the queue's maxReceiveCount, so the final receive is known.
        FETCH_RETRY_BACKOFF,
        FETCH_RETRY_LADDER_SECONDS: FETCH_RAW_BILL_RETRY_LADDER_SECONDS.join(','),
        FETCH_RETRY_OTHER_SECONDS: FETCH_RAW_BILL_RETRY_OTHER_SECONDS.toString(),
        FETCH_RETRY_NOT_FOUND_RECEIVES: FETCH_RAW_BILL_RETRY_NOT_FOUND_RECEIVES.toString(),
        FETCH_RETRY_MAX_RECEIVES: UPDATED_BILLS_QUEUE_MAX_RECEIVE_COUNT.toString(),
        // REL-45: bill text sources, reuse, and the delayed retry back onto UpdatedBillsQueue (its send grant below).
        BILL_XML_SOURCES,
        BILL_XML_REUSE_SAME_VERSION,
        TEXT_RETRY_QUEUE_URL: updatedBillsQueue.queueUrl,
        BILL_TEXT_RETRY_DELAY_SECONDS: BILL_TEXT_RETRY_DELAY_SECONDS.toString(),
        BILL_TEXT_MAX_RETRIES: BILL_TEXT_MAX_RETRIES.toString(),
        BILL_XML_FETCH_BUDGET_MS: BILL_XML_FETCH_BUDGET_MS.toString(),
        BILL_XML_REFUSED_HOST_COOLDOWN_MS: BILL_XML_REFUSED_HOST_COOLDOWN_MS.toString(),
      },
      reservedConcurrentExecutions: FETCH_RAW_BILLS_RESERVED_CONCURRENCY,
      memorySize: FETCH_RAW_BILLS_LAMBDA_MEMORY_MB,
      timeout: cdk.Duration.seconds(FETCH_RAW_BILLS_LAMBDA_TIMEOUT_SECONDS),
    });
    grantCloudWatchMetricNamespaceWrite(fetchRawBillFn, 'BillBoard/BillIngestion');
    // Receive, delete and, for REL-58's retry ladder, ChangeMessageVisibility.
    updatedBillsQueue.grantConsumeMessages(fetchRawBillFn);
    // REL-45: the delayed bill text retry (TEXT_RETRY_QUEUE_URL).
    updatedBillsQueue.grantSendMessages(fetchRawBillFn);
    this.billDifferQueue.grantSendMessages(fetchRawBillFn);
    this.billVoteEnrichmentQueue.grantSendMessages(fetchRawBillFn);
    congressApiSecret.grantRead(fetchRawBillFn);
    billStoreBucket.grantReadWrite(fetchRawBillFn);

    const { alias: fetchRawBillAlias } = addProdAliasWithDeployment(
      this, 'FetchRawBill', fetchRawBillFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.fetchRawBill = fetchRawBillAlias;

    // ESM attached to alias so CodeDeploy traffic shifting is respected
    fetchRawBillAlias.addEventSourceMapping('UpdatedBillsSQSEventSource', {
      eventSourceArn: updatedBillsQueue.queueArn,
      batchSize: UPDATED_BILLS_QUEUE_BATCH_SIZE,
      maxConcurrency: FETCH_RAW_BILLS_EVENT_SOURCE_MAX_CONCURRENCY,
      reportBatchItemFailures: true,
      enabled: true,
    });

    const enrichOfficialVotesFn = createCongressIntegrationLambda(
      'EnrichOfficialVotes',
      'enrichOfficialVotes',
      {
      environment: {
        BUCKET_NAME: BILL_STORE_BUCKET_NAME,
        SECRET_NAME: congressApiSecret.secretName,
        CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
        QUEUE_URL: this.billDifferQueue.queueUrl,
        ENRICHMENT_QUEUE_URL: this.billVoteEnrichmentQueue.queueUrl,
        QUEUE_BATCH_SIZE: BILL_VOTE_ENRICHMENT_QUEUE_BATCH_SIZE.toString(),
        CONGRESS_API_MAX_RETRIES: CONGRESS_API_MAX_RETRIES.toString(),
        CONGRESS_API_REQUEST_TIMEOUT_MS: CONGRESS_API_REQUEST_TIMEOUT_MS.toString(),
        CONGRESS_VOTE_CALL_DELAY_MS: CONGRESS_VOTE_CALL_DELAY_MS.toString(),
        CONGRESS_API_MAX_HOUSE_VOTE_PAGES: CONGRESS_API_MAX_HOUSE_VOTE_PAGES.toString(),
        CONGRESS_VOTE_MAX_CALLS_PER_BILL: CONGRESS_VOTE_MAX_CALLS_PER_BILL.toString(),
        VOTE_ENRICHMENT_DEFER_DELAY_SECONDS: VOTE_ENRICHMENT_DEFER_DELAY_SECONDS.toString(),
        VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS: VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS.toString(),
      },
      reservedConcurrentExecutions: ENRICH_OFFICIAL_VOTES_RESERVED_CONCURRENCY,
      memorySize: ENRICH_OFFICIAL_VOTES_LAMBDA_MEMORY_MB,
      timeout: cdk.Duration.seconds(ENRICH_OFFICIAL_VOTES_LAMBDA_TIMEOUT_SECONDS),
    });
    grantCloudWatchMetricNamespaceWrite(
      enrichOfficialVotesFn,
      'BillBoard/BillIngestion',
    );
    this.billVoteEnrichmentQueue.grantConsumeMessages(enrichOfficialVotesFn);
    this.billVoteEnrichmentQueue.grantSendMessages(enrichOfficialVotesFn);
    this.billDifferQueue.grantSendMessages(enrichOfficialVotesFn);
    congressApiSecret.grantRead(enrichOfficialVotesFn);
    billStoreBucket.grantReadWrite(enrichOfficialVotesFn);
    congressMembersManifestTable.grantReadData(enrichOfficialVotesFn);

    const { alias: enrichOfficialVotesAlias } = addProdAliasWithDeployment(
      this, 'EnrichOfficialVotes', enrichOfficialVotesFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.enrichOfficialVotes = enrichOfficialVotesAlias;

    enrichOfficialVotesAlias.addEventSourceMapping('BillVoteEnrichmentSQSEventSource', {
      eventSourceArn: this.billVoteEnrichmentQueue.queueArn,
      batchSize: BILL_VOTE_ENRICHMENT_QUEUE_BATCH_SIZE,
      maxConcurrency: ENRICH_OFFICIAL_VOTES_EVENT_SOURCE_MAX_CONCURRENCY,
      reportBatchItemFailures: true,
      enabled: true,
    });

    // Congress Members retrieval Queues and Lambdas
    const congressMemberSummarizerDLQ = new sqs.Queue(this, 'CongressMemberSummarizerDLQ', {
      queueName: 'CongressMemberSummarizerDLQ',
      retentionPeriod: ingestDlqRetention,
    });

    this.congressMemberSummarizerQueue = new sqs.Queue(this, 'CongressMemberSummarizerQueue', {
      queueName: 'CongressMemberSummarizerQueue',
      deadLetterQueue: {
        maxReceiveCount: CONGRESS_MEMBERS_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT,
        queue: congressMemberSummarizerDLQ,
      },
      visibilityTimeout: cdk.Duration.seconds(CONGRESS_MEMBERS_SUMMARIZER_QUEUE_TIMEOUT_SECONDS),
    });

    const updatedCongressMembersDLQ = {
      maxReceiveCount: UPDATED_CONGRESS_MEMBERS_QUEUE_MAX_RECEIVE_COUNT,
      queue: new sqs.Queue(this, 'UpdatedCongressMembersDLQ', {
        queueName: 'UpdatedCongressMembersDLQ',
        retentionPeriod: ingestDlqRetention,
      })
    };

    const updatedCongressMembersQueue = new sqs.Queue(this, 'UpdatedCongressMembersQueue', {
      queueName: 'UpdatedCongressMembersQueue',
      deadLetterQueue: updatedCongressMembersDLQ,
      visibilityTimeout: cdk.Duration.seconds(UPDATED_CONGRESS_MEMBERS_QUEUE_TIMEOUT_SECONDS),
    });

    const fetchCongressMembersListFn = createCongressIntegrationLambda(
      'FetchCongressMembersList',
      'fetchCongressMembersList',
      {
      environment: {
        QUEUE_URL: updatedCongressMembersQueue.queueUrl,
        QUEUE_BATCH_SIZE: UPDATED_CONGRESS_MEMBERS_QUEUE_BATCH_SIZE.toString(),
        SECRET_NAME: congressApiSecret.secretName,
        CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
      },
      timeout: cdk.Duration.seconds(FETCH_CONGRESS_MEMBERS_LIST_LAMBDA_TIMEOUT_SECONDS),
    });
    updatedCongressMembersQueue.grantSendMessages(fetchCongressMembersListFn);
    congressApiSecret.grantRead(fetchCongressMembersListFn);
    grantCloudWatchMetricNamespaceWrite(fetchCongressMembersListFn, 'BillBoard/BillIngestion');
    // Scans the manifest to find members who have left Congress.
    congressMembersManifestTable.grantReadData(fetchCongressMembersListFn);

    const { alias: fetchCongressMembersListAlias } = addProdAliasWithDeployment(
      this, 'FetchCongressMembersList', fetchCongressMembersListFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.fetchCongressMembersList = fetchCongressMembersListAlias;
    // C1.1: weekly, so a dropped run is a week's gap that no heartbeat can cover. After its retries
    // (Lambda's default 2, written out) a failed run is recorded in ScheduledJobFailures with its payload
    // and error, and can be rerun the same day. Grants the role sqs:SendMessage on the queue.
    fetchCongressMembersListAlias.configureAsyncInvoke({
      retryAttempts: FETCH_CONGRESS_MEMBERS_LIST_ASYNC_RETRY_ATTEMPTS,
      onFailure: scheduledJobFailureDestination(this),
    });

    new events.Rule(this, 'CongressMembersSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.days(7)),
      targets: [new targets.LambdaFunction(fetchCongressMembersListAlias, {
        deadLetterQueue: scheduledJobFailuresQueue(this),
      })],
    });

    // REL-46: the 120th Congress starts 2027-01-03. Daily from 2027-01-02 to 2027-01-17, so new members and
    // departed ones show within a day. 22:00 UTC is 17:00 EST, after congress.gov usually loads the new
    // members on opening day. The year field ends it after the Jan 17 run; a cleanup PR removes it.
    new events.Rule(this, 'CongressMembersChangeoverSchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '22', day: '2-17', month: '1', year: '2027' }),
      targets: [new targets.LambdaFunction(fetchCongressMembersListAlias, {
        deadLetterQueue: scheduledJobFailuresQueue(this),
      })],
    });

    const fetchRawCongressMembersFn = createCongressIntegrationLambda(
      'FetchRawCongressMembers',
      'fetchRawCongressMembers',
      {
      environment: {
        BUCKET_NAME: CONGRESS_MEMBER_STORE_BUCKET_NAME,
        SECRET_NAME: congressApiSecret.secretName,
        QUEUE_URL: this.congressMemberSummarizerQueue.queueUrl,
        QUEUE_BATCH_SIZE: CONGRESS_MEMBERS_SUMMARIZER_QUEUE_BATCH_SIZE.toString(),
      },
      timeout: cdk.Duration.seconds(FETCH_RAW_CONGRESS_MEMBERS_LAMBDA_TIMEOUT_SECONDS),
    });
    updatedCongressMembersQueue.grantConsumeMessages(fetchRawCongressMembersFn);
    this.congressMemberSummarizerQueue.grantSendMessages(fetchRawCongressMembersFn);
    congressApiSecret.grantRead(fetchRawCongressMembersFn);
    grantCloudWatchMetricNamespaceWrite(fetchRawCongressMembersFn, 'BillBoard/BillIngestion');
    congressMemberStoreBucket.grantReadWrite(fetchRawCongressMembersFn);

    const { alias: fetchRawCongressMembersAlias } = addProdAliasWithDeployment(
      this, 'FetchRawCongressMembers', fetchRawCongressMembersFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.fetchRawCongressMembers = fetchRawCongressMembersAlias;

    fetchRawCongressMembersAlias.addEventSourceMapping('UpdatedCongressMemebersSQSEventSource', {
      eventSourceArn: updatedCongressMembersQueue.queueArn,
      batchSize: UPDATED_CONGRESS_MEMBERS_QUEUE_BATCH_SIZE,
      maxConcurrency: FETCH_RAW_CONGRESS_MEMBERS_EVENT_SOURCE_MAX_CONCURRENCY,
      reportBatchItemFailures: true,
      enabled: true,
    });
  }
}
