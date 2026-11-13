import * as cdk from "aws-cdk-lib";
import * as ddb from "aws-cdk-lib/aws-dynamodb";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AnalyticsServiceStack } from "../lib/stacks/analytics-service";
import { SharedInfraStack } from "../lib/stacks/shared-infra";
import { isDataWrite, partitionScopedGrants, roleStatementsOf, storeActions } from "./helpers/cdk-test-helpers";
import { synthesizeStacks } from "./helpers/synth-stacks";
import { BILL_STORE_BUCKET_NAME } from "../lib/config/deployment-identity";

const templates = synthesizeStacks();

// The shared helper synthesizes with stream aggregation off, so the feedback
// stream mapping is checked against its own app.
let streamTemplateCache: Template | undefined;
const streamTemplate = (): Template => {
  if (!streamTemplateCache) {
    const app = new cdk.App();
    const shared = new SharedInfraStack(app, "SharedInfraStack");
    const deps = new cdk.Stack(app, "AnalyticsStreamDeps");
    const feedbackTable = new ddb.Table(deps, "UserFeedbackTable", {
      partitionKey: { name: "userId", type: ddb.AttributeType.STRING },
      sortKey: { name: "billId", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      stream: ddb.StreamViewType.NEW_IMAGE,
    });
    const stack = new AnalyticsServiceStack(app, "AnalyticsServiceStack", {
      lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
      congressMemberStatsQueue: shared.congressMemberStatsQueue,
      feedbackTableStreamArn: feedbackTable.tableStreamArn!,
    });
    streamTemplateCache = Template.fromStack(stack);
  }
  return streamTemplateCache;
};

describe("AnalyticsServiceStack", () => {
  test("creates the analytics lambda with the expected configuration", () => {
    templates.analyticsTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "CongressMemberStats",
      Handler: "dist/index.handler",
      Runtime: "nodejs24.x",
      Timeout: 30,
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          VOTE_PROFILE_TABLE_NAME: "CongressMemberVoteProfiles",
          VOTE_PROFILE_BILL_GUID_INDEX_NAME: "BillGuidIndex",
        }),
      }),
    });
    templates.analyticsTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillStatsAggregator",
      Handler: "dist/index.handler",
      Runtime: "nodejs24.x",
      // CAP-04: batches of up to 1000 records recompute several bills at once.
      MemorySize: 1024,
      Timeout: 60,
      Environment: {
        Variables: Match.objectLike({
          BILL_STATS_CONCURRENCY: "4",
          BILL_ID_INDEX_NAME: "GSIBillIdIndex",
        }),
      },
    });
  });

  // Without LEGISLATIVE_PROFILE_TABLE_NAME the handler skips member legislative
  // profiles, so only the backfill script ever wrote them.
  test("CongressMemberStats maintains member legislative profiles", () => {
    templates.analyticsTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "CongressMemberStats",
      Environment: {
        Variables: Match.objectLike({
          LEGISLATIVE_PROFILE_TABLE_NAME: "CongressMemberLegislativeProfiles",
          LEGISLATIVE_PROFILE_PRIMARY_KEY: "bioguideId",
          LEGISLATIVE_PROFILE_SORT_KEY: "billGuid",
          LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME: "BillGuidIndex",
          LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PK: "billGuid",
          LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SK: "bioguideId",
        }),
      },
    });
  });

  test("keeps partial-batch failure reporting on the CongressMemberStats queue mapping", () => {
    templates.analyticsTemplate.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: Match.objectLike({
        "Fn::ImportValue": Match.stringLikeRegexp("CongressMemberStatsQueue"),
      }),
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  test("deploys both workers all at once instead of on the API canary", () => {
    const groups = Object.values(
      templates.analyticsTemplate.findResources("AWS::CodeDeploy::DeploymentGroup"),
    ) as Array<{ Properties: { DeploymentConfigName: unknown } }>;

    expect(groups).toHaveLength(2);
    groups.forEach((group) => {
      expect(group.Properties.DeploymentConfigName).toBe("CodeDeployDefault.LambdaAllAtOnce");
    });
    templates.analyticsTemplate.resourceCountIs("AWS::CodeDeploy::DeploymentConfig", 0);
  });

  // CAP-04: large batches gathered over 30 s, one shard reader, whole-batch retries.
  test("reads the feedback stream in batches of 1000 over a 30-second window without partial batch responses", () => {
    const mappings = Object.values(streamTemplate().findResources("AWS::Lambda::EventSourceMapping"))
      .filter((mapping) => JSON.stringify(mapping.Properties.EventSourceArn).includes("StreamArn"));
    expect(mappings).toHaveLength(1);
    const [mapping] = mappings;
    expect(mapping.Properties).toEqual(expect.objectContaining({
      BatchSize: 1000,
      MaximumBatchingWindowInSeconds: 30,
      ParallelizationFactor: 1,
      StartingPosition: "LATEST",
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 5,
    }));
    // Attached to the prod alias ("<function>:prod"), so CodeDeploy controls the version it runs.
    expect(JSON.stringify(mapping.Properties.FunctionName)).toContain(":prod");
    expect(mapping.Properties.FunctionResponseTypes).toBeUndefined();
  });

  test("bisects and retries failed feedback-stream batches, then sends them to a 14-day DLQ", () => {
    const template = streamTemplate();
    const dlqs = template.findResources("AWS::SQS::Queue", {
      Properties: {
        QueueName: "BillStatsAggregatorStreamDLQ",
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      },
    });
    const dlqLogicalIds = Object.keys(dlqs);
    expect(dlqLogicalIds).toHaveLength(1);
    const dlqArn = { "Fn::GetAtt": [dlqLogicalIds[0], "Arn"] };

    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      StartingPosition: "LATEST",
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 5,
      DestinationConfig: { OnFailure: { Destination: dlqArn } },
    });

    const aggregatorPolicies = Object.entries(template.findResources("AWS::IAM::Policy"))
      .filter(([logicalId]) => logicalId.startsWith("BillStatsAggregatorServiceRoleDefaultPolicy"))
      .map(([, policy]) => policy as { Properties: { PolicyDocument: { Statement: Array<{ Action?: unknown; Resource?: unknown }> } } });
    expect(aggregatorPolicies).toHaveLength(1);
    expect(aggregatorPolicies[0].Properties.PolicyDocument.Statement).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Action: expect.arrayContaining(["sqs:SendMessage"]),
          Resource: dlqArn,
        }),
      ]),
    );
  });

  // CQ-15: the store tables and bucket are referenced by their fixed names. Only the feedback stream
  // ARN is passed in, because a stream ARN has no fixed name.
  test("grants CongressMemberStats and BillStatsAggregator their store access by fixed name", () => {
    const access = (functionName: string) => storeActions(roleStatementsOf(streamTemplate(), functionName));

    expect(Object.keys(access("CongressMemberStats"))).toEqual([
      `bucket/${BILL_STORE_BUCKET_NAME}`,
      `bucket/${BILL_STORE_BUCKET_NAME}/*`,
      "table/CongressMemberLegislativeProfiles",
      "table/CongressMemberLegislativeProfiles/index/*",
      "table/CongressMemberVoteProfiles",
      "table/CongressMemberVoteProfiles/index/*",
      "table/CongressMembersManifest",
      "table/CongressMembersStats",
    ]);
    const memberStatsWrites = Object.entries(access("CongressMemberStats"))
      .filter(([, actions]) => actions.some(isDataWrite))
      .map(([resource]) => resource);
    expect(memberStatsWrites).toEqual([
      "table/CongressMemberLegislativeProfiles",
      "table/CongressMemberLegislativeProfiles/index/*",
      "table/CongressMemberVoteProfiles",
      "table/CongressMemberVoteProfiles/index/*",
      "table/CongressMembersStats",
    ]);

    const aggregator = access("BillStatsAggregator");
    expect(Object.keys(aggregator)).toEqual([
      "table/BillStats",
      "table/BillsManifest",
      "table/UserFeedback",
      "table/UserFeedback/index/*",
    ]);
    expect(aggregator["table/UserFeedback"].filter(isDataWrite)).toEqual([]);
    expect(aggregator["table/BillStats"]).toEqual(expect.arrayContaining(["dynamodb:PutItem"]));
    expect(aggregator["table/BillStats"]).not.toContain("dynamodb:GetItem");
    expect(aggregator["table/BillsManifest"]).toEqual(expect.arrayContaining(["dynamodb:GetItem", "dynamodb:PutItem"]));

    // The stream grant names the ARN passed in.
    const streamStatement = roleStatementsOf(streamTemplate(), "BillStatsAggregator")
      .find((statement) => [statement.Action].flat().includes("dynamodb:GetRecords") && JSON.stringify(statement.Resource).includes("StreamArn"));
    expect(streamStatement).toBeDefined();
  });

  test("BillStatsAggregator knows the bills manifest keys", () => {
    templates.analyticsTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillStatsAggregator",
      Environment: {
        Variables: Match.objectLike({
          MANIFEST_TABLE_NAME: "BillsManifest",
          MANIFEST_PRIMARY_KEY: "pk",
          MANIFEST_SORT_KEY: "sk",
          MANIFEST_PK_VALUE: "BILL",
          MANIFEST_GUID_LOOKUP_PK: "BILL_GUID",
        }),
      },
    });
  });

  // APPF-23: a recompute of a grouped bill also stores the group's COMPANIONS#... document in BillStats.
  // The existing BillStats write and BillsManifest grants cover it and the groups row, so nothing new.
  test("BillStatsAggregator knows the companion keys and needs no new grant for group stats", () => {
    templates.analyticsTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillStatsAggregator",
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: "UserFeedback",
          MANIFEST_TABLE_NAME: "BillsManifest",
          MANIFEST_PRIMARY_KEY: "pk",
          MANIFEST_COMPANION_DECL_PK: "BILL_COMPANION_DECL",
          MANIFEST_COMPANION_GROUPS_PK: "BILL_COMPANION_GROUPS",
          GUID_LOOKUP_PK: "BILL_GUID",
          COMPANION_GROUPS_ENABLED: Match.absent(),
        }),
      },
    });
    const statements = roleStatementsOf(templates.analyticsTemplate, "BillStatsAggregator");
    expect(partitionScopedGrants(statements)).toEqual([]);
    expect(storeActions(statements)["table/BillStats"]).toEqual(expect.arrayContaining(["dynamodb:PutItem"]));
    expect(storeActions(statements)["table/BillsManifest"]).toEqual(expect.arrayContaining(["dynamodb:GetItem"]));
    // CongressMemberStats reads PRIMARY_KEY for its own table, so it must never get the companion keys.
    templates.analyticsTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "CongressMemberStats",
      Environment: {
        Variables: Match.objectLike({
          PRIMARY_KEY: "bioguideId",
          MANIFEST_COMPANION_GROUPS_PK: Match.absent(),
        }),
      },
    });
  });
});
