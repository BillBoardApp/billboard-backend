import * as cdk from "aws-cdk-lib";
import { Match } from "aws-cdk-lib/assertions";
import { Template } from "aws-cdk-lib/assertions";
import { MEMBER_STATS_RAW_BILL_TRIGGER } from "../lib/config/congress-store-constants";
import { SharedInfraStack } from "../lib/stacks/shared-infra";
import { CongressStoreStack } from "../lib/stacks/congress-store";
import { synthesizeStacks } from "./helpers/synth-stacks";
import { BILL_STORE_BUCKET_NAME, CONGRESS_MEMBER_STORE_BUCKET_NAME } from "../lib/config/deployment-identity";

const templates = synthesizeStacks();

const logicalIdOfQueue = (template: Template, queueName: string): string => {
  const matches = Object.keys(template.findResources("AWS::SQS::Queue", {
    Properties: { QueueName: queueName },
  }));
  expect(matches).toHaveLength(1);
  return matches[0];
};

const lifecycleRules = (template: Template, bucketName: string): Array<Record<string, any>> => {
  const buckets = Object.values(template.findResources("AWS::S3::Bucket", {
    Properties: { BucketName: bucketName },
  })) as Array<{ Properties: { LifecycleConfiguration: { Rules: Array<Record<string, any>> } } }>;
  expect(buckets).toHaveLength(1);
  return buckets[0].Properties.LifecycleConfiguration.Rules;
};

type Statement = Record<string, any>;

const actionsOf = (statement: Statement): string[] => [statement.Action].flat();

// CongressStoreStack in its own app. It takes no functions from the service stacks (CQ-15).
const buildCongressStore = (
  suffix: string,
  options: { memberStatsRawBillTrigger?: boolean } = {},
): { template: Template } => {
  const app = new cdk.App();
  const shared = new SharedInfraStack(app, `SharedInfraStackFor${suffix}`);
  const stack = new CongressStoreStack(app, `CongressStoreStackFor${suffix}`, {
    lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
    notificationTypeQueue: shared.notificationTypeQueue,
    congressMemberStatsQueue: shared.congressMemberStatsQueue,
    ...options,
  });
  return { template: Template.fromStack(stack) };
};

describe("CongressStoreStack", () => {
  test("creates the bill storage bucket with processed-object notifications into the manifest queues", () => {
    templates.congressStoreTemplate.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: BILL_STORE_BUCKET_NAME,
    });
    templates.congressStoreTemplate.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: CONGRESS_MEMBER_STORE_BUCKET_NAME,
    });
    templates.congressStoreTemplate.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "CreateBillsManifest",
      Environment: {
        Variables: Match.objectLike({
          CONGRESS_MEMBER_STATS_QUEUE_URL: Match.anyValue(),
        }),
      },
    });

    const notifications = templates.congressStoreTemplate.findResources("Custom::S3BucketNotifications");
    const notificationResources = Object.values(notifications);
    expect(notificationResources).toHaveLength(2);

    const allQueueConfigurations = notificationResources.flatMap((resource) => {
      const notification = resource as {
        Properties: {
          NotificationConfiguration: {
            QueueConfigurations: Array<Record<string, unknown>>;
          };
        };
      };

      const queueConfigurations = notification.Properties.NotificationConfiguration.QueueConfigurations;
      expect(Array.isArray(queueConfigurations)).toBe(true);
      return queueConfigurations;
    });

    const events = allQueueConfigurations.flatMap((config) => {
      const queueConfig = config as { Events?: string[]; Event?: string };
      if (Array.isArray(queueConfig.Events)) {
        return queueConfig.Events;
      }
      return queueConfig.Event ? [queueConfig.Event] : [];
    });

    expect(events).toContain("s3:ObjectCreated:*");

    const prefixes = allQueueConfigurations.flatMap((config) => {
      const queueConfig = config as { Filter?: { Key?: { FilterRules?: Array<{ Name?: string; Value?: string }> } } };
      const rules = queueConfig.Filter?.Key?.FilterRules ?? [];
      return rules.filter((r) => r.Name === 'prefix').map((r) => r.Value);
    });
    // raw-bills/ appears only through the member stats switch (tested below).
    expect(prefixes.filter((p) => p === 'raw-bills/')).toHaveLength(MEMBER_STATS_RAW_BILL_TRIGGER ? 1 : 0);
    expect(prefixes).toContain('processed-bills/');
    expect(prefixes).toContain('processed-congress-members/');
  });

  test("names the manifest queues so the monitoring alarms can find them", () => {
    ["BillsManifestQueue", "CongressMembersManifestQueue"].forEach((queueName) => {
      templates.congressStoreTemplate.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: queueName,
      });
    });
  });

  test("dead-letters each manifest queue after five receives into a 14-day DLQ", () => {
    [
      ["BillsManifestQueue", "BillsManifestDLQ"],
      ["CongressMembersManifestQueue", "CongressMembersManifestDLQ"],
    ].forEach(([queueName, dlqName]) => {
      templates.congressStoreTemplate.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: dlqName,
        MessageRetentionPeriod: 14 * 24 * 60 * 60,
      });
      templates.congressStoreTemplate.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: queueName,
        RedrivePolicy: {
          deadLetterTargetArn: { "Fn::GetAtt": [logicalIdOfQueue(templates.congressStoreTemplate, dlqName), "Arn"] },
          maxReceiveCount: 5,
        },
      });
    });
  });

  test("protects both manifest tables with deletion protection, PITR and RETAIN", () => {
    templates.congressStoreTemplate.resourceCountIs("AWS::DynamoDB::Table", 2);
    templates.congressStoreTemplate.allResourcesProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: true,
    });
    ["BillsManifest", "CongressMembersManifest"].forEach((tableName) => {
      templates.congressStoreTemplate.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: tableName,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });
  });

  test("gives BillsManifest no stream, so a script's row write (relabel:ceremonial-rows) reaches no function", () => {
    // relabel:ceremonial-rows, redate:manifest-rows and repair:failed-status write BillsManifest rows directly and rely
    // on this: with no stream, a row write starts no Lambda, so no push can follow from it (RUNBOOK 4.12).
    const tables = Object.values(templates.congressStoreTemplate.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: "BillsManifest" },
    })) as Array<{ Properties: Record<string, unknown> }>;
    expect(tables).toHaveLength(1);
    expect(tables[0].Properties.StreamSpecification).toBeUndefined();
  });

  test("keeps noncurrent processed-bill versions for 30 days so bad summaries can be rolled back", () => {
    const processedNoncurrentDays = lifecycleRules(templates.congressStoreTemplate, BILL_STORE_BUCKET_NAME)
      .filter((rule) => rule.Prefix === "processed-bills/" && rule.NoncurrentVersionExpiration)
      .map((rule) => rule.NoncurrentVersionExpiration.NoncurrentDays);

    expect(processedNoncurrentDays).toEqual([30]);
  });

  test("never expires the current version of a stored bill or member (REL-34)", () => {
    for (const bucketName of [BILL_STORE_BUCKET_NAME, CONGRESS_MEMBER_STORE_BUCKET_NAME]) {
      const rules = lifecycleRules(templates.congressStoreTemplate, bucketName);
      expect(rules.filter((rule) => rule.ExpirationInDays !== undefined || rule.ExpirationDate !== undefined)).toEqual([]);
      expect(rules.every((rule) => rule.NoncurrentVersionExpiration)).toBe(true);
    }
    const billNoncurrentPrefixes = lifecycleRules(templates.congressStoreTemplate, BILL_STORE_BUCKET_NAME)
      .map((rule) => rule.Prefix)
      .sort();
    expect(billNoncurrentPrefixes).toEqual(["processed-bills/", "raw-bills/"]);
  });

  test("versions the congress-member bucket and expires noncurrent versions after 7 days", () => {
    templates.congressStoreTemplate.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: CONGRESS_MEMBER_STORE_BUCKET_NAME,
      VersioningConfiguration: { Status: "Enabled" },
    });

    const noncurrentRules = lifecycleRules(templates.congressStoreTemplate, CONGRESS_MEMBER_STORE_BUCKET_NAME)
      .filter((rule) => rule.NoncurrentVersionExpiration);

    expect(noncurrentRules).toHaveLength(1);
    expect(noncurrentRules[0].Prefix).toBeUndefined();
    expect(noncurrentRules[0].NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 7 });
  });

  test("deploys the manifest workers all at once instead of on the API canary", () => {
    const groups = Object.values(
      templates.congressStoreTemplate.findResources("AWS::CodeDeploy::DeploymentGroup"),
    ) as Array<{ Properties: { DeploymentConfigName: unknown } }>;

    expect(groups).toHaveLength(2);
    groups.forEach((group) => {
      expect(group.Properties.DeploymentConfigName).toBe("CodeDeployDefault.LambdaAllAtOnce");
    });
    templates.congressStoreTemplate.resourceCountIs("AWS::CodeDeploy::DeploymentConfig", 0);
  });

  // CQ-15: the service stacks grant their own functions access to these buckets and tables by name
  // (tested with each service stack); this stack grants only the functions it creates.
  test("grants only its own functions and the S3 notification handler", () => {
    const template = templates.congressStoreTemplate;
    const roles = Object.keys(template.findResources("AWS::IAM::Role"));
    const policies = Object.values(template.findResources("AWS::IAM::Policy"));
    expect(policies.length).toBeGreaterThan(0);
    policies.forEach((policy) => {
      [policy.Properties.Roles].flat().forEach((role: { Ref?: string }) => expect(roles).toContain(role.Ref));
    });
    const functionNames = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((fn) => fn.Properties.FunctionName)
      .filter((name) => name !== undefined)
      .sort();
    expect(functionNames).toEqual(["CreateBillsManifest", "CreateCongressMembersManifest"]);
  });

  describe("member stats raw-bills trigger (CAP-05)", () => {
    const queueConfigurations = (template: Template): Array<Record<string, any>> =>
      Object.values(template.findResources("Custom::S3BucketNotifications"))
        .flatMap((resource) => resource.Properties.NotificationConfiguration.QueueConfigurations ?? []);
    const prefixOf = (config: Record<string, any>): string | undefined =>
      (config.Filter?.Key?.FilterRules ?? []).find((rule: { Name?: string }) => rule.Name === "prefix")?.Value;
    const targetsMemberStatsQueue = (config: Record<string, any>): boolean =>
      JSON.stringify(config.QueueArn).includes("CongressMemberStatsQueue");
    // The manifest queues have their own S3 queue policies; only the member stats queue's matters here.
    const memberStatsQueuePolicies = (template: Template) =>
      Object.values(template.findResources("AWS::SQS::QueuePolicy"))
        .filter((policy) => JSON.stringify(policy.Properties.Queues).includes("CongressMemberStatsQueue"));

    test("pinned value: off since U9c, so raw-bills/ no longer notifies the member stats queue", () => {
      expect(MEMBER_STATS_RAW_BILL_TRIGGER).toBe(false);
      const memberStatsConfigs = queueConfigurations(templates.congressStoreTemplate).filter(targetsMemberStatsQueue);

      expect(memberStatsConfigs.map(prefixOf)).toEqual([]);
      expect(memberStatsQueuePolicies(templates.congressStoreTemplate)).toEqual([]);
    });

    test("false: raw-bills/ notifies nothing and the member stats queue has no S3 policy", () => {
      const { template } = buildCongressStore("NoRawBillTrigger", { memberStatsRawBillTrigger: false });
      const configs = queueConfigurations(template);

      expect(configs.map(prefixOf)).not.toContain("raw-bills/");
      expect(configs.filter(targetsMemberStatsQueue)).toEqual([]);
      expect(memberStatsQueuePolicies(template)).toEqual([]);
    });

    test("member stats still get every processed-bill version through CreateBillsManifest", () => {
      templates.congressStoreTemplate.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "CreateBillsManifest",
        Environment: {
          Variables: Match.objectLike({
            CONGRESS_MEMBER_STATS_QUEUE_URL: { "Fn::ImportValue": Match.stringLikeRegexp("CongressMemberStatsQueue") },
          }),
        },
      });
      const createBillsManifest = Object.values(templates.congressStoreTemplate.findResources("AWS::Lambda::Function", {
        Properties: { FunctionName: "CreateBillsManifest" },
      }))[0];
      const roleId = createBillsManifest.Properties.Role["Fn::GetAtt"][0];
      const sendStatements = Object.values(templates.congressStoreTemplate.findResources("AWS::IAM::Policy"))
        .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleId))
        .flatMap((policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, any>>)
        .filter((statement) => actionsOf(statement).includes("sqs:SendMessage"));
      expect(sendStatements.some((statement) => JSON.stringify(statement.Resource).includes("CongressMemberStatsQueue"))).toBe(true);
    });

    test("true restores the raw-bills/ notification and the queue policy that lets S3 send", () => {
      const { template } = buildCongressStore("RawBillTrigger", { memberStatsRawBillTrigger: true });
      const memberStatsConfigs = queueConfigurations(template).filter(targetsMemberStatsQueue);

      expect(memberStatsConfigs).toHaveLength(1);
      expect(prefixOf(memberStatsConfigs[0])).toBe("raw-bills/");
      expect(memberStatsConfigs[0].Events).toEqual(["s3:ObjectCreated:*"]);

      const policies = memberStatsQueuePolicies(template);
      expect(policies).toHaveLength(1);
      expect(policies[0].Properties.PolicyDocument.Statement).toEqual([
        expect.objectContaining({
          Action: "sqs:SendMessage",
          Effect: "Allow",
          Principal: { Service: "s3.amazonaws.com" },
          Condition: expect.objectContaining({ ArnEquals: { "aws:SourceArn": expect.anything() } }),
        }),
      ]);
    });
  });
});
