import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib';
import { Construct } from "constructs";
import { BILL_STORE_BUCKET_NAME, CONGRESS_MEMBER_STORE_BUCKET_NAME } from "../config/congress-store-constants";
import { BILL_DIFFER_LAMBDA_MEMORY_MB, BILL_DIFFER_LAMBDA_TIMEOUT_SECONDS, BILL_SUMMARIZER_BEDROCK_CALL_TIMEOUT_MS, BILL_SUMMARIZER_BEDROCK_CONCURRENCY, BILL_SUMMARIZER_EVENT_SOURCE_MAX_CONCURRENCY, BILL_SUMMARIZER_LAMBDA_MAX_BILLS_PER_BATCH, BILL_SUMMARIZER_LAMBDA_MAX_OUTPUT_TOKENS, BILL_SUMMARIZER_LAMBDA_TIMEOUT_SECONDS, BILL_SUMMARIZER_QUEUE_BATCH_SIZE, BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT, BILL_SUMMARIZER_QUEUE_VISIBILITY_TIMEOUT_SECONDS, BILL_SUMMARIZER_RESERVED_CONCURRENCY, CONGRESS_MEMBER_SUMMARIZER_LAMBDA_TIMEOUT_SECONDS } from '../config/summarizer-service-constants';
import { BILL_SUMMARIZER_MODEL } from '../config/bedrock-models';
import { BILLS_DIFFER_QUEUE_BATCH_SIZE, CONGRESS_MEMBERS_SUMMARIZER_QUEUE_BATCH_SIZE, INGEST_DLQ_RETENTION_DAYS } from '../config/congress-integration-service-constants';
import {
  createReleaseBackedLambdaFactory,
} from './helpers/lambda-utils';
import {
  addProdAliasWithDeployment,
  ProdAliasDeploymentOptions,
} from './helpers/codedeploy-utils';
import { storeBucket } from './helpers/data-store-refs';
import { BILL_COMPANION_ENVIRONMENT, grantCompanionDeclarationsWrite } from './helpers/bill-companions';
import { bedrockInvokeModelStatement, inferenceProfileArn } from './helpers/bedrock-grants';

export interface SummarizerServiceStackProps extends cdk.StackProps {
  billDifferQueue: sqs.Queue;
  congressMemberSummarizerQueue: sqs.Queue;
  lambdaArtifactsBucket: s3.IBucket;
}

export class SummarizerServiceStack extends cdk.Stack {
  /** prod aliases — use for all downstream invocations */
  public readonly billDiffer: lambda.IFunction;
  public readonly billSummarizer: lambda.IFunction;
  public readonly congressMemberSummarizer: lambda.IFunction;

  constructor(scope: Construct, id: string, props: SummarizerServiceStackProps) {
    super(scope, id, props);
    // Ingestion logs are kept 90 days so an incident is still diagnosable after a month.
    const createSummarizerLambda = createReleaseBackedLambdaFactory(
      this,
      props.lambdaArtifactsBucket,
      { logRetention: logs.RetentionDays.THREE_MONTHS },
    );

    const codeDeployApp = new codedeploy.LambdaApplication(this, 'SummarizerServiceApp', {
      applicationName: 'SummarizerService',
    });
    // Every function here is an SQS worker, so each shifts traffic all at once
    // (the helper ignores deploymentConfig for workers).
    const deploymentConfig = codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE;
    const workerDeployment: ProdAliasDeploymentOptions = { deploymentKind: 'worker' };
    // CongressStoreStack's buckets, referenced by their fixed names (CQ-15).
    const billStoreBucket = storeBucket(this, 'billStore');
    const congressMemberStoreBucket = storeBucket(this, 'congressMemberStore');

    // One of the six ingest DLQs: 14 days instead of the SQS default of 4 (INGEST_DLQ_RETENTION_DAYS).
    const billSummarizerDLQ = new sqs.Queue(this, 'BillSummarizerDLQ', {
      queueName: 'BillSummarizerDLQ',
      retentionPeriod: cdk.Duration.days(INGEST_DLQ_RETENTION_DAYS),
    });

    const billSummarizerQueue = new sqs.Queue(this, 'BillSummarizerQueue', {
      queueName: 'BillSummarizerQueue',
      deadLetterQueue: {
        maxReceiveCount: BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT,
        queue: billSummarizerDLQ,
      },
      visibilityTimeout: cdk.Duration.seconds(BILL_SUMMARIZER_QUEUE_VISIBILITY_TIMEOUT_SECONDS),
    });

    // ── BillDiffer ────────────────────────────────────────────────────────────

    // BillDiffer does not send to CongressMemberStatsQueue (CAP-05): CreateBillsManifest forwards
    // each processed-bill version to member stats.
    const billDifferFn = createSummarizerLambda('BillDiffer', 'billDiffer', {
      environment: {
        BUCKET_NAME: BILL_STORE_BUCKET_NAME,
        QUEUE_URL: billSummarizerQueue.queueUrl,
        QUEUE_BATCH_SIZE: BILL_SUMMARIZER_QUEUE_BATCH_SIZE.toString(),
        // APPF-23: keeps each bill's companion link list (BILL_COMPANION_DECL row) in step with its raw bill.
        ...BILL_COMPANION_ENVIRONMENT,
      },
      memorySize: BILL_DIFFER_LAMBDA_MEMORY_MB,
      timeout: cdk.Duration.seconds(BILL_DIFFER_LAMBDA_TIMEOUT_SECONDS),
    });
    props.billDifferQueue.grantConsumeMessages(billDifferFn);
    billSummarizerQueue.grantSendMessages(billDifferFn);
    billStoreBucket.grantReadWrite(billDifferFn);
    // APPF-23: GetItem, and the conditional PutItem and DeleteItem, on BILL_COMPANION_DECL rows only.
    grantCompanionDeclarationsWrite(this, billDifferFn);

    const { alias: billDifferAlias } = addProdAliasWithDeployment(
      this, 'BillDiffer', billDifferFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.billDiffer = billDifferAlias;

    billDifferAlias.addEventSourceMapping('BillDifferSQSEventSource', {
      eventSourceArn: props.billDifferQueue.queueArn,
      batchSize: BILLS_DIFFER_QUEUE_BATCH_SIZE,
      reportBatchItemFailures: true,
      enabled: true,
    });

    // ── BillSummarizer ────────────────────────────────────────────────────────

    const billSummarizerFn = createSummarizerLambda('BillSummarizer', 'billSummarizer', {
      environment: {
        BUCKET_NAME: BILL_STORE_BUCKET_NAME,
        MODEL_ID: inferenceProfileArn(this, BILL_SUMMARIZER_MODEL.modelId),
        BEDROCK_EFFORT: BILL_SUMMARIZER_MODEL.effort,
        MAX_BILLS_PER_BATCH: BILL_SUMMARIZER_LAMBDA_MAX_BILLS_PER_BATCH.toString(),
        MAX_OUTPUT_TOKENS: BILL_SUMMARIZER_LAMBDA_MAX_OUTPUT_TOKENS.toString(),
        BEDROCK_CONCURRENCY: BILL_SUMMARIZER_BEDROCK_CONCURRENCY.toString(),
        BEDROCK_CALL_TIMEOUT_MS: BILL_SUMMARIZER_BEDROCK_CALL_TIMEOUT_MS.toString(),
      },
      reservedConcurrentExecutions: BILL_SUMMARIZER_RESERVED_CONCURRENCY,
      timeout: cdk.Duration.seconds(BILL_SUMMARIZER_LAMBDA_TIMEOUT_SECONDS),
    });
    // Every granted model, not only the one MODEL_ID names: a prod alias can move back to a version that
    // calls the other (infra/lib/config/bedrock-models.ts).
    billSummarizerFn.addToRolePolicy(bedrockInvokeModelStatement(this, BILL_SUMMARIZER_MODEL));
    billSummarizerQueue.grantConsumeMessages(billSummarizerFn);
    billStoreBucket.grantReadWrite(billSummarizerFn);

    const { alias: billSummarizerAlias } = addProdAliasWithDeployment(
      this, 'BillSummarizer', billSummarizerFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.billSummarizer = billSummarizerAlias;

    billSummarizerAlias.addEventSourceMapping("BillSummarizerSQSEventSource", {
      eventSourceArn: billSummarizerQueue.queueArn,
      batchSize: BILL_SUMMARIZER_QUEUE_BATCH_SIZE,
      maxConcurrency: BILL_SUMMARIZER_EVENT_SOURCE_MAX_CONCURRENCY,
      reportBatchItemFailures: true,
      enabled: true,
    });

    // ── CongressMemberSummarizer ──────────────────────────────────────────────

    const congressMemberSummarizerFn = createSummarizerLambda(
      'CongressMemberSummarizer',
      'congressMemberSummarizer',
      {
        environment: {
          BUCKET_NAME: CONGRESS_MEMBER_STORE_BUCKET_NAME,
        },
        timeout: cdk.Duration.seconds(CONGRESS_MEMBER_SUMMARIZER_LAMBDA_TIMEOUT_SECONDS),
      },
    );
    props.congressMemberSummarizerQueue.grantConsumeMessages(congressMemberSummarizerFn);
    congressMemberStoreBucket.grantReadWrite(congressMemberSummarizerFn);

    const { alias: congressMemberSummarizerAlias } = addProdAliasWithDeployment(
      this, 'CongressMemberSummarizer', congressMemberSummarizerFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.congressMemberSummarizer = congressMemberSummarizerAlias;

    congressMemberSummarizerAlias.addEventSourceMapping("CongressMemberSummarizerSQSEventSource", {
      eventSourceArn: props.congressMemberSummarizerQueue.queueArn,
      batchSize: CONGRESS_MEMBERS_SUMMARIZER_QUEUE_BATCH_SIZE,
      reportBatchItemFailures: true,
      enabled: true,
    });
  }
}
