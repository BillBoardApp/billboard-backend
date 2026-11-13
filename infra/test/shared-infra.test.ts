import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SharedInfraStack } from "../lib/stacks/shared-infra";
import { LAMBDA_ARTIFACTS_BUCKET_NAME } from "../lib/config/deployment-identity";

const synth = (): Template => {
  const app = new cdk.App();
  const stack = new SharedInfraStack(app, "SharedInfraStack");
  return Template.fromStack(stack);
};

type LifecycleRule = {
  Id?: string;
  Prefix?: string;
  ExpirationInDays?: number;
  NoncurrentVersionExpiration?: { NoncurrentDays: number };
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number };
};

const artifactsBucketRules = (template: Template): LifecycleRule[] => {
  const buckets = template.findResources("AWS::S3::Bucket", {
    Properties: { BucketName: LAMBDA_ARTIFACTS_BUCKET_NAME },
  });
  const [bucket] = Object.values(buckets);
  return bucket.Properties.LifecycleConfiguration.Rules as LifecycleRule[];
};

describe("SharedInfraStack", () => {
  test("applies lifecycle rules for Lambda release artifacts", () => {
    const template = synth();

    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: LAMBDA_ARTIFACTS_BUCKET_NAME,
      VersioningConfiguration: {
        Status: "Enabled",
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "ExpireHistoryArtifactsAfter30Days",
            Prefix: "history/",
            ExpirationInDays: 30,
          }),
          Match.objectLike({
            Id: "ExpireReleaseArtifactsAfter730Days",
            Prefix: "releases/",
            ExpirationInDays: 730,
          }),
          Match.objectLike({
            Id: "ExpireNoncurrentArtifactVersionsAfter7Days",
            NoncurrentVersionExpiration: {
              NoncurrentDays: 7,
            },
          }),
          Match.objectLike({
            Id: "AbortIncompleteArtifactUploadsAfter7Days",
            AbortIncompleteMultipartUpload: {
              DaysAfterInitiation: 7,
            },
          }),
        ]),
      },
    });
  });

  test("has exactly the four expected artifact lifecycle rules", () => {
    const ids = artifactsBucketRules(synth()).map((rule) => rule.Id).sort();
    expect(ids).toEqual([
      "AbortIncompleteArtifactUploadsAfter7Days",
      "ExpireHistoryArtifactsAfter30Days",
      "ExpireNoncurrentArtifactVersionsAfter7Days",
      "ExpireReleaseArtifactsAfter730Days",
    ]);
  });

  test("never expires current content-addressed artifacts that live stacks reference", () => {
    const rules = artifactsBucketRules(synth());
    const expiringArtifacts = rules.filter(
      (rule) => rule.ExpirationInDays !== undefined && (rule.Prefix === undefined || "artifacts/".startsWith(rule.Prefix)),
    );
    expect(expiringArtifacts).toEqual([]);
  });

  test("keeps pinned release manifests for at least two years", () => {
    const releaseRules = artifactsBucketRules(synth()).filter((rule) => rule.Prefix === "releases/");
    expect(releaseRules).toHaveLength(1);
    expect(releaseRules[0].ExpirationInDays).toBeGreaterThanOrEqual(730);
  });

  test("scopes every current-object expiration to a prefix (root-level objects are untouched)", () => {
    const rules = artifactsBucketRules(synth());
    for (const rule of rules.filter((candidate) => candidate.ExpirationInDays !== undefined)) {
      expect(rule.Prefix).toMatch(/^[a-z]+\/$/);
    }
  });

  test.each([
    ["NotificationTypeQueue", "NotificationTypeDLQ"],
    ["CongressMemberStatsQueue", "CongressMemberStatsDLQ"],
  ])("%s redrives to %s after 5 receives with a 180s visibility timeout", (queueName, dlqName) => {
    const template = synth();

    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: dlqName,
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });

    const dlqs = template.findResources("AWS::SQS::Queue", { Properties: { QueueName: dlqName } });
    const [dlqLogicalId] = Object.keys(dlqs);
    expect(dlqLogicalId).toBeDefined();

    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: queueName,
      VisibilityTimeout: 180,
      RedrivePolicy: {
        deadLetterTargetArn: { "Fn::GetAtt": [dlqLogicalId, "Arn"] },
        maxReceiveCount: 5,
      },
    });
  });

  test("exposes the DLQs for alarms in other stacks", () => {
    const app = new cdk.App();
    const stack = new SharedInfraStack(app, "SharedInfraStack");
    expect(stack.notificationTypeDlq.node.id).toBe("NotificationTypeDLQ");
    expect(stack.congressMemberStatsDlq.node.id).toBe("CongressMemberStatsDLQ");
  });

  // C1.1: the scheduled jobs' failure queue. Fixed name, so the service stacks reference it without an export.
  test("creates ScheduledJobFailures: SQS-managed encryption, 14 days, no DLQ, no export", () => {
    const template = synth();
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "ScheduledJobFailures",
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1209600,
      RedrivePolicy: Match.absent(),
      KmsMasterKeyId: Match.absent(),
      VisibilityTimeout: Match.absent(),
    });
    expect(JSON.stringify(template.toJSON().Outputs ?? {})).not.toContain("ScheduledJobFailures");
  });

  test("lets only EventBridge rules of this account and region send to ScheduledJobFailures", () => {
    const template = synth();
    const [queueId] = Object.keys(template.findResources("AWS::SQS::Queue", {
      Properties: { QueueName: "ScheduledJobFailures" },
    }));
    const policies = Object.values(template.findResources("AWS::SQS::QueuePolicy"));
    expect(policies).toHaveLength(1);
    expect(policies[0].Properties.Queues).toEqual([{ Ref: queueId }]);
    expect(policies[0].Properties.PolicyDocument.Statement).toEqual([
      {
        Sid: "AllowEventBridgeRuleDeadLetters",
        Effect: "Allow",
        Principal: { Service: "events.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: { "Fn::GetAtt": [queueId, "Arn"] },
        Condition: {
          StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
          ArnLike: {
            "aws:SourceArn": {
              "Fn::Join": ["", [
                "arn:", { Ref: "AWS::Partition" }, ":events:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":rule/*",
              ]],
            },
          },
        },
      },
    ]);
  });

  test("the existing queues and DLQs are unchanged by the new queue", () => {
    const template = synth();
    template.resourceCountIs("AWS::SQS::Queue", 5);
    ["NotificationTypeQueue", "NotificationTypeDLQ", "CongressMemberStatsQueue", "CongressMemberStatsDLQ"].forEach((name) =>
      template.hasResourceProperties("AWS::SQS::Queue", { QueueName: name, SqsManagedSseEnabled: Match.absent() }),
    );
  });
});
