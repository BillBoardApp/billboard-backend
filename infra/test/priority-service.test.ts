import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SharedInfraStack } from "../lib/stacks/shared-infra";
import { PriorityServiceStack } from "../lib/stacks/priority-service";
import { BILL_PRIORITY_MODEL } from "../lib/config/bedrock-models";
import { BILL_PRIORITY_NEWS_FEED_QUERIES, BILL_PRIORITY_NEWS_FEED_URLS } from "../lib/config/priority-service-constants";
import { isDataWrite, roleStatementsOf, storeActions } from "./helpers/cdk-test-helpers";
import { BILL_STORE_BUCKET_NAME, DEPLOYMENT_ACCOUNT_ID } from "../lib/config/deployment-identity";

let cached: Template | undefined;
const priorityTemplate = (): Template => {
  if (!cached) {
    const app = new cdk.App();
    const shared = new SharedInfraStack(app, "SharedInfraStackForPriorityTest");
    const stack = new PriorityServiceStack(app, "PriorityServiceStack", {
      lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
    });
    cached = Template.fromStack(stack);
  }
  return cached;
};

// Renders an Fn::Join of strings and { Ref } pseudo-parameters as "${Ref}" text.
const renderJoin = (value: unknown): unknown => {
  const join = (value as { "Fn::Join"?: [string, unknown[]] } | null)?.["Fn::Join"];
  if (!join) {
    return value;
  }
  const [separator, parts] = join;
  return parts
    .map((part) => (typeof part === "string" ? part : `\${${(part as { Ref: string }).Ref}}`))
    .join(separator);
};

const inferenceProfileArn = (modelId: string) =>
  `arn:\${AWS::Partition}:bedrock:\${AWS::Region}:\${AWS::AccountId}:inference-profile/us.${modelId}`;
const foundationModelArn = (modelId: string) => `arn:\${AWS::Partition}:bedrock:*::foundation-model/${modelId}`;

describe("PriorityServiceStack", () => {
  test("schedules the resolver hourly during the Eastern daytime window", () => {
    const template = priorityTemplate();

    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "cron(0 6-23 ? * * *)",
      ScheduleExpressionTimezone: "America/New_York",
      FlexibleTimeWindow: {
        Mode: "OFF",
      },
      State: "ENABLED",
      Target: Match.objectLike({
        Arn: Match.anyValue(),
        RoleArn: Match.anyValue(),
      }),
    });

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "BillPriority",
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: "guid", KeyType: "HASH" }),
      ]),
    });
  });

  // C1.1: a delivery Scheduler cannot make goes to ScheduledJobFailures, written with the schedule's role.
  test("the schedule sends undeliverable runs to ScheduledJobFailures with its own role", () => {
    const template = priorityTemplate();
    const [schedule] = Object.values(template.findResources("AWS::Scheduler::Schedule"));
    expect(renderJoin(schedule.Properties.Target.DeadLetterConfig.Arn)).toBe(
      "arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:ScheduledJobFailures",
    );
    // The retry policy stays Scheduler's default.
    expect(schedule.Properties.Target.RetryPolicy).toBeUndefined();

    const roleId: string = schedule.Properties.Target.RoleArn["Fn::GetAtt"][0];
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((policy) => JSON.stringify(policy.Properties.Roles) === JSON.stringify([{ Ref: roleId }]))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    expect(statements.map((statement: { Action: string }) => statement.Action)).toEqual([
      "lambda:InvokeFunction",
      "sqs:SendMessage",
    ]);
    expect(renderJoin(statements[1].Resource)).toBe(
      "arn:${AWS::Partition}:sqs:${AWS::Region}:${AWS::AccountId}:ScheduledJobFailures",
    );
    // A failed run gets no destination: the next hourly run is the rerun.
    template.resourceCountIs("AWS::Lambda::EventInvokeConfig", 0);
  });

  test("protects the BillPriority table from deletion", () => {
    priorityTemplate().hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "BillPriority",
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    priorityTemplate().hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
    });
  });

  // LLM-11: the role may invoke every granted model, so switching MODEL_ID, or moving the alias back across
  // the switch, needs no IAM change.
  test("scopes bedrock:InvokeModel to the inference profiles and foundation models of the granted models", () => {
    const template = priorityTemplate();
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>)
      .filter((statement) => [statement.Action].flat().some((action) => action.startsWith("bedrock:")));
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe("bedrock:InvokeModel");
    expect([statements[0].Resource].flat().map(renderJoin)).toEqual(
      BILL_PRIORITY_MODEL.grantedModelIds.flatMap((modelId) => [inferenceProfileArn(modelId), foundationModelArn(modelId)]),
    );

    const resolver = Object.values(
      template.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "BillPriorityResolver" },
      }),
    )[0];
    expect(renderJoin(resolver.Properties.Environment.Variables.MODEL_ID)).toBe(
      inferenceProfileArn(BILL_PRIORITY_MODEL.modelId),
    );
    expect(JSON.stringify(template.toJSON())).not.toContain(DEPLOYMENT_ACCOUNT_ID);
  });

  // LLM-11: low effort, room for thinking within max_tokens, a 75-second deadline per call, and a timeout
  // that leaves room for that call after the feed and manifest reads.
  test("configures the resolver's Bedrock call", () => {
    priorityTemplate().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillPriorityResolver",
      Timeout: 120,
      Environment: {
        Variables: Match.objectLike({
          BEDROCK_EFFORT: "low",
          MAX_OUTPUT_TOKENS: "4096",
          BEDROCK_CALL_TIMEOUT_MS: "75000",
        }),
      },
    });
  });

  test("keeps 90 days of resolver logs", () => {
    priorityTemplate().hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/BillPriorityResolver",
      RetentionInDays: 90,
    });
  });

  test("deploys the scheduled resolver all at once", () => {
    const template = priorityTemplate();
    template.resourceCountIs("AWS::CodeDeploy::DeploymentConfig", 0);
    template.resourceCountIs("AWS::CodeDeploy::DeploymentGroup", 1);
    template.hasResourceProperties("AWS::CodeDeploy::DeploymentGroup", {
      DeploymentConfigName: "CodeDeployDefault.LambdaAllAtOnce",
    });
  });

  // CQ-15: CongressStoreStack's BillsManifest and bill store, referenced by their fixed names. REL-51 adds the raw
  // bills, read-only, for their short and official titles.
  test("lets the resolver read BillsManifest and the raw bills, and write to neither", () => {
    const access = storeActions(roleStatementsOf(priorityTemplate(), "BillPriorityResolver"));
    expect(Object.keys(access)).toEqual([
      `bucket/${BILL_STORE_BUCKET_NAME}`,
      `bucket/${BILL_STORE_BUCKET_NAME}/raw-bills/*`,
      "table/BillsManifest",
    ]);
    expect(access["table/BillsManifest"]).toEqual(expect.arrayContaining(["dynamodb:Query", "dynamodb:GetItem"]));
    expect(access[`bucket/${BILL_STORE_BUCKET_NAME}/raw-bills/*`]).toEqual(expect.arrayContaining(["s3:GetObject*"]));
    Object.values(access).forEach((actions) => expect(actions.filter(isDataWrite)).toEqual([]));
  });

  // REL-51: where the titles come from, how many raw bills a run reads, how many at once, and for how long it starts
  // reads.
  test("tells the resolver where the raw bills are and bounds its title lookups", () => {
    priorityTemplate().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillPriorityResolver",
      Environment: {
        Variables: Match.objectLike({
          BILL_STORE_BUCKET_NAME: BILL_STORE_BUCKET_NAME,
          MAX_TITLE_LOOKUPS: "200",
          TITLE_LOOKUP_BUDGET_MS: "15000",
          TITLE_LOOKUP_CONCURRENCY: "6",
          MAX_CANDIDATE_BILLS: "50",
          MAX_HEADLINES: "30",
          MAX_PRIORITY_RESULTS: "8",
        }),
      },
    });
  });

  // APPF-23: candidates collapse by companion group before the model call; the manifest read grant
  // above covers the groups row.
  test("the resolver knows the companion keys", () => {
    priorityTemplate().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "BillPriorityResolver",
      Environment: {
        Variables: Match.objectLike({
          MANIFEST_TABLE_NAME: "BillsManifest",
          MANIFEST_PRIMARY_KEY: "pk",
          MANIFEST_COMPANION_DECL_PK: "BILL_COMPANION_DECL",
          MANIFEST_COMPANION_GROUPS_PK: "BILL_COMPANION_GROUPS",
          GUID_LOOKUP_PK: "BILL_GUID",
          COMPANION_GROUPS_ENABLED: Match.absent(),
        }),
      },
    });
  });

  // LLM-09 (decision 2, feed A): no hard-coded topic search. The resolver reads one generic feed of
  // Congress coverage from AP, Reuters and NPR; the funding, shutdown, debt ceiling and immigration feed is gone.
  describe("news feeds (LLM-09)", () => {
    const TOPIC_WORDS = ["immigration", "shutdown", "debt", "funding", "abortion", "border", "guns", "tax"];
    const queryOf = (url: string): string => new URL(url).searchParams.get("q") ?? "";

    test("there is exactly one feed, the generic Congress search", () => {
      expect(BILL_PRIORITY_NEWS_FEED_URLS).toHaveLength(1);
      expect(BILL_PRIORITY_NEWS_FEED_QUERIES).toEqual([
        "(site:apnews.com OR site:reuters.com OR site:npr.org) (Congress OR House OR Senate) bill",
      ]);
      expect(BILL_PRIORITY_NEWS_FEED_URLS.map(queryOf)).toEqual(BILL_PRIORITY_NEWS_FEED_QUERIES);
      expect(new URL(BILL_PRIORITY_NEWS_FEED_URLS[0]).origin + new URL(BILL_PRIORITY_NEWS_FEED_URLS[0]).pathname)
        .toBe("https://news.google.com/rss/search");
    });

    test("no feed query names a topic", () => {
      BILL_PRIORITY_NEWS_FEED_URLS.map(queryOf).forEach((query) =>
        TOPIC_WORDS.forEach((word) => expect({ word, found: query.toLowerCase().includes(word) }).toEqual({ word, found: false })),
      );
    });

    test("the resolver is configured with that one URL (no comma inside it to split on)", () => {
      const [resolver] = Object.values(priorityTemplate().findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "BillPriorityResolver" },
      }));
      const configured = resolver.Properties.Environment.Variables.NEWS_FEED_URLS as string;
      expect(configured.split(",")).toEqual([...BILL_PRIORITY_NEWS_FEED_URLS]);
      TOPIC_WORDS.forEach((word) => expect(decodeURIComponent(configured).toLowerCase()).not.toContain(word));
    });
  });
});
