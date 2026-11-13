import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  BILL_STORE_BUCKET_NAME,
  BILLS_MANIFEST_TABLE_NAME,
  BILLS_MANIFEST_TABLE_PK_VALUE,
  BILLS_MANIFEST_TABLE_PRIMARY_KEY,
  BILLS_MANIFEST_TABLE_SORT_KEY,
} from "../config/congress-store-constants";
import {
  BILL_PRIORITY_ACTIVE_INDEX_NAME,
  BILL_PRIORITY_ACTIVE_STATUS,
  BILL_PRIORITY_BEDROCK_CALL_TIMEOUT_MS,
  BILL_PRIORITY_DEFAULT_DURATION_HOURS,
  BILL_PRIORITY_HEADLINE_MAX_AGE_HOURS,
  BILL_PRIORITY_LOOKBACK_DAYS,
  BILL_PRIORITY_MAX_CANDIDATE_BILLS,
  BILL_PRIORITY_MAX_HEADLINES,
  BILL_PRIORITY_MAX_OUTPUT_TOKENS,
  BILL_PRIORITY_MAX_PRIORITY_RESULTS,
  BILL_PRIORITY_MAX_TITLE_LOOKUPS,
  BILL_PRIORITY_MIN_CONFIDENCE,
  BILL_PRIORITY_MIN_SCORE,
  BILL_PRIORITY_NEWS_FEED_URLS,
  BILL_PRIORITY_RESOLVER_MEMORY_MB,
  BILL_PRIORITY_RESOLVER_SCHEDULE_EXPRESSION,
  BILL_PRIORITY_RESOLVER_SCHEDULE_TIMEZONE,
  BILL_PRIORITY_RESOLVER_TIMEOUT_SECONDS,
  BILL_PRIORITY_SORT_KEY_ATTRIBUTE,
  BILL_PRIORITY_STATUS_ATTRIBUTE,
  BILL_PRIORITY_TABLE_NAME,
  BILL_PRIORITY_TABLE_PARTITION_KEY,
  BILL_PRIORITY_TITLE_LOOKUP_BUDGET_MS,
  BILL_PRIORITY_TITLE_LOOKUP_CONCURRENCY,
} from "../config/priority-service-constants";
import { BILL_PRIORITY_MODEL } from "../config/bedrock-models";
import {
  createReleaseBackedLambdaFactory,
} from "./helpers/lambda-utils";
import {
  addProdAliasWithDeployment,
  ProdAliasDeploymentOptions,
} from "./helpers/codedeploy-utils";
import { storeBucket, storeTable } from "./helpers/data-store-refs";
import { BILL_COMPANION_ENVIRONMENT } from "./helpers/bill-companions";
import { bedrockInvokeModelStatement, inferenceProfileArn } from "./helpers/bedrock-grants";
import {
  grantScheduledJobFailuresSend,
  scheduledJobFailuresQueue,
} from "./helpers/scheduled-job-failures";

export interface PriorityServiceStackProps extends cdk.StackProps {
  readonly lambdaArtifactsBucket: s3.IBucket;
}

export class PriorityServiceStack extends cdk.Stack {
  public readonly billPriorityTable: ddb.Table;
  /** prod alias — use for all downstream invocations */
  public readonly billPriorityResolver: lambda.IFunction;

  constructor(scope: Construct, id: string, props: PriorityServiceStackProps) {
    super(scope, id, props);

    this.billPriorityTable = new ddb.Table(this, "BillPriorityTable", {
      tableName: BILL_PRIORITY_TABLE_NAME,
      partitionKey: {
        name: BILL_PRIORITY_TABLE_PARTITION_KEY,
        type: ddb.AttributeType.STRING,
      },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
    });
    this.billPriorityTable.addGlobalSecondaryIndex({
      indexName: BILL_PRIORITY_ACTIVE_INDEX_NAME,
      partitionKey: {
        name: BILL_PRIORITY_STATUS_ATTRIBUTE,
        type: ddb.AttributeType.STRING,
      },
      sortKey: {
        name: BILL_PRIORITY_SORT_KEY_ATTRIBUTE,
        type: ddb.AttributeType.STRING,
      },
      projectionType: ddb.ProjectionType.ALL,
    });

    const codeDeployApp = new codedeploy.LambdaApplication(this, 'PriorityServiceApp', {
      applicationName: 'PriorityService',
    });
    // The resolver is a scheduled worker, so it shifts traffic all at once
    // (the helper ignores deploymentConfig for workers).
    const deploymentConfig = codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE;
    const workerDeployment: ProdAliasDeploymentOptions = { deploymentKind: 'worker' };

    // Logs are kept 90 days so an incident is still diagnosable after a month.
    const createPriorityLambda = createReleaseBackedLambdaFactory(
      this,
      props.lambdaArtifactsBucket,
      { logRetention: logs.RetentionDays.THREE_MONTHS },
    );

    const billPriorityResolverFn = createPriorityLambda(
      "BillPriorityResolver",
      "billPriorityResolver",
      {
        memorySize: BILL_PRIORITY_RESOLVER_MEMORY_MB,
        timeout: cdk.Duration.seconds(BILL_PRIORITY_RESOLVER_TIMEOUT_SECONDS),
        environment: {
          // APPF-23: a companion pair is one candidate. The manifest read grant covers the groups row.
          ...BILL_COMPANION_ENVIRONMENT,
          MANIFEST_TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
          MANIFEST_PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
          MANIFEST_SORT_KEY: BILLS_MANIFEST_TABLE_SORT_KEY,
          MANIFEST_PK_VALUE: BILLS_MANIFEST_TABLE_PK_VALUE,
          PRIORITY_TABLE_NAME: BILL_PRIORITY_TABLE_NAME,
          PRIORITY_TABLE_PARTITION_KEY: BILL_PRIORITY_TABLE_PARTITION_KEY,
          PRIORITY_ACTIVE_INDEX_NAME: BILL_PRIORITY_ACTIVE_INDEX_NAME,
          PRIORITY_STATUS_ATTRIBUTE: BILL_PRIORITY_STATUS_ATTRIBUTE,
          PRIORITY_SORT_KEY_ATTRIBUTE: BILL_PRIORITY_SORT_KEY_ATTRIBUTE,
          PRIORITY_ACTIVE_STATUS_VALUE: BILL_PRIORITY_ACTIVE_STATUS,
          MODEL_ID: inferenceProfileArn(this, BILL_PRIORITY_MODEL.modelId),
          BEDROCK_EFFORT: BILL_PRIORITY_MODEL.effort,
          BEDROCK_CALL_TIMEOUT_MS: BILL_PRIORITY_BEDROCK_CALL_TIMEOUT_MS.toString(),
          NEWS_FEED_URLS: BILL_PRIORITY_NEWS_FEED_URLS.join(","),
          BILL_LOOKBACK_DAYS: BILL_PRIORITY_LOOKBACK_DAYS.toString(),
          MAX_CANDIDATE_BILLS: BILL_PRIORITY_MAX_CANDIDATE_BILLS.toString(),
          MAX_HEADLINES: BILL_PRIORITY_MAX_HEADLINES.toString(),
          MAX_PRIORITY_RESULTS: BILL_PRIORITY_MAX_PRIORITY_RESULTS.toString(),
          MAX_OUTPUT_TOKENS: BILL_PRIORITY_MAX_OUTPUT_TOKENS.toString(),
          HEADLINE_MAX_AGE_HOURS: BILL_PRIORITY_HEADLINE_MAX_AGE_HOURS.toString(),
          DEFAULT_PRIORITY_DURATION_HOURS: BILL_PRIORITY_DEFAULT_DURATION_HOURS.toString(),
          PRIORITY_MIN_SCORE: BILL_PRIORITY_MIN_SCORE.toString(),
          PRIORITY_MIN_CONFIDENCE: BILL_PRIORITY_MIN_CONFIDENCE.toString(),
          // REL-51: the short and official titles come from the raw bills.
          BILL_STORE_BUCKET_NAME,
          MAX_TITLE_LOOKUPS: BILL_PRIORITY_MAX_TITLE_LOOKUPS.toString(),
          TITLE_LOOKUP_BUDGET_MS: BILL_PRIORITY_TITLE_LOOKUP_BUDGET_MS.toString(),
          TITLE_LOOKUP_CONCURRENCY: BILL_PRIORITY_TITLE_LOOKUP_CONCURRENCY.toString(),
        },
      },
    );
    this.billPriorityTable.grantReadWriteData(billPriorityResolverFn);
    // Every granted model, not only the one MODEL_ID names: a prod alias can move back to a version that
    // calls the other (infra/lib/config/bedrock-models.ts).
    billPriorityResolverFn.addToRolePolicy(bedrockInvokeModelStatement(this, BILL_PRIORITY_MODEL));
    // CongressStoreStack's BillsManifest, referenced by its fixed name (CQ-15).
    storeTable(this, "billsManifest").grantReadData(billPriorityResolverFn);
    // REL-51: read-only, and only the raw bills, where the short and official titles are.
    storeBucket(this, "billStore").grantRead(billPriorityResolverFn, "raw-bills/*");

    const { alias: billPriorityResolverAlias } = addProdAliasWithDeployment(
      this, 'BillPriorityResolver', billPriorityResolverFn, codeDeployApp, deploymentConfig, [], workerDeployment,
    );
    this.billPriorityResolver = billPriorityResolverAlias;

    const priorityResolverSchedulerRole = new iam.Role(this, "BillPriorityResolverSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    // Grant invoke on the alias ARN (qualifier required for CodeDeploy traffic shifting)
    priorityResolverSchedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [billPriorityResolverAlias.functionArn],
      }),
    );
    // C1.1: Scheduler writes the schedule's dead letters with this role.
    grantScheduledJobFailuresSend(priorityResolverSchedulerRole);

    new scheduler.CfnSchedule(this, "BillPriorityResolverSchedule", {
      description: "Priority bill refresh every hour from 6:00 AM through 11:00 PM America/New_York.",
      flexibleTimeWindow: {
        mode: "OFF",
      },
      scheduleExpression: BILL_PRIORITY_RESOLVER_SCHEDULE_EXPRESSION,
      scheduleExpressionTimezone: BILL_PRIORITY_RESOLVER_SCHEDULE_TIMEZONE,
      state: "ENABLED",
      target: {
        arn: billPriorityResolverAlias.functionArn,
        roleArn: priorityResolverSchedulerRole.roleArn,
        // C1.1: a delivery Scheduler cannot make (after its default retries) goes to ScheduledJobFailures
        // instead of being dropped. A failed run gets no destination: the next hourly run is the rerun, and
        // Billboard-Heartbeat-BillPriorityResolver alarms after 8 hours without a successful run.
        deadLetterConfig: { arn: scheduledJobFailuresQueue(this).queueArn },
      },
    });
  }
}
