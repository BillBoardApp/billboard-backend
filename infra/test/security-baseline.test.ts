import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {
  applyCostAllocationTags,
  MANAGEMENT_TRAIL_NAME,
  SecurityBaselineStack,
  TRAIL_LOG_NONCURRENT_DAYS,
  TRAIL_LOG_RETENTION_DAYS,
} from '../lib/stacks/security-baseline';
import { DEPLOYMENT_ACCOUNT_ID, DEPLOYMENT_REGION } from '../lib/config/deployment-identity';

const synth = (): Template => {
  const app = new cdk.App();
  const stack = new SecurityBaselineStack(app, 'SecurityBaselineStack', {
    env: { account: DEPLOYMENT_ACCOUNT_ID, region: DEPLOYMENT_REGION },
  });
  return Template.fromStack(stack);
};

describe('SecurityBaselineStack', () => {
  const template = synth();

  test('creates one multi-region management-events trail with log file validation', () => {
    template.resourceCountIs('AWS::CloudTrail::Trail', 1);
    template.hasResourceProperties('AWS::CloudTrail::Trail', {
      TrailName: MANAGEMENT_TRAIL_NAME,
      IsLogging: true,
      IsMultiRegionTrail: true,
      IncludeGlobalServiceEvents: true,
      EnableLogFileValidation: true,
      S3BucketName: { Ref: Match.stringLikeRegexp('^CloudTrailLogsBucket') },
    });
  });

  test('trail has no CloudWatch Logs delivery and no data events', () => {
    const [trail] = Object.values(template.findResources('AWS::CloudTrail::Trail'));
    expect(trail.Properties.CloudWatchLogsLogGroupArn).toBeUndefined();
    expect(trail.Properties.CloudWatchLogsRoleArn).toBeUndefined();
    expect(trail.Properties.AdvancedEventSelectors).toBeUndefined();
    for (const selector of trail.Properties.EventSelectors ?? []) {
      expect(selector.DataResources).toBeUndefined();
      expect(selector.IncludeManagementEvents).toBe(true);
      expect(selector.ReadWriteType).toBe('All');
    }
    template.resourceCountIs('AWS::Logs::LogGroup', 0);
  });

  test('log bucket is private, encrypted, versioned, SSL-only and retained', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
        VersioningConfiguration: { Status: 'Enabled' },
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  // The privacy policy says the audit log is kept one year (WEB-07 privacy draft, gap G2): a log expires at 335
  // days and its noncurrent version goes 30 days later, 365 in all, not 365 plus 30.
  test('log bucket keeps a trail log one year in all, the noncurrent days included', () => {
    expect(TRAIL_LOG_RETENTION_DAYS).toBe(365);
    expect(TRAIL_LOG_NONCURRENT_DAYS).toBe(30);
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'ExpireTrailLogsWithin365Days',
            Status: 'Enabled',
            ExpirationInDays: 335,
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          },
        ],
      },
    });
  });

  test('CloudTrail can write to the log bucket', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 's3:GetBucketAcl',
            Principal: { Service: 'cloudtrail.amazonaws.com' },
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: 's3:PutObject',
            Principal: { Service: 'cloudtrail.amazonaws.com' },
          }),
        ]),
      },
    });
  });
});

describe('applyCostAllocationTags', () => {
  const build = () => {
    const app = new cdk.App();
    const first = new cdk.Stack(app, 'FirstStack');
    new sqs.Queue(first, 'Queue');
    const second = new cdk.Stack(app, 'SecondStack');
    new sqs.Queue(second, 'Queue');
    new ssm.StringParameter(second, 'CursorParameter', { stringValue: 'UNINITIALIZED' });
    new secretsmanager.Secret(second, 'Secret');
    applyCostAllocationTags(app);
    return { app, first, second };
  };

  test.each(['FirstStack', 'SecondStack'])('tags %s resources with project and service', (stackId) => {
    const { app } = build();
    const stack = app.node.findChild(stackId) as cdk.Stack;
    Template.fromStack(stack).hasResourceProperties('AWS::SQS::Queue', {
      Tags: Match.arrayEquals([
        { Key: 'project', Value: 'billboard' },
        { Key: 'service', Value: stackId },
      ]),
    });
  });

  // A tag change is still a CloudFormation update, and updating the parameter
  // writes its template value over the live poller cursor.
  test('leaves SSM parameters and secrets untagged', () => {
    const { second } = build();
    const template = Template.fromStack(second);
    template.hasResourceProperties('AWS::SSM::Parameter', { Tags: Match.absent() });
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Tags: Match.absent() });
  });

  // CloudFormation copies stack tags onto every taggable resource, including the excluded ones.
  test('sets no stack-level tags', () => {
    const { app, first, second } = build();
    const assembly = app.synth();
    expect(first.tags.tagValues()).toEqual({});
    expect(second.tags.tagValues()).toEqual({});
    expect(assembly.getStackByName('SecondStack').tags).toEqual({});
  });
});
