/**
 * Cross-cutting tests for the CodeDeploy / alias / alarm deployment model.
 *
 * Asserts:
 *  - Lambda prod aliases exist for every release-backed function
 *  - Lambda prod alias versions are pinned from SSM so CloudFormation does not shift traffic
 *  - CodeDeploy deployment groups exist, one per Lambda
 *  - Deployment config is CodeDeploy's built-in 10% / 10-minute canary for 'api' functions (CON-08)
 *    and ALL_AT_ONCE for 'worker' functions; no stack creates a custom DeploymentConfig
 *  - Auto-rollback is configured for failedDeployment, stoppedDeployment, deploymentInAlarm
 *  - Per-alias error alarms are created and attached to each deployment group
 *  - API Gateway integrations reference the alias (resource URI contains ':prod')
 *  - EventBridge rules target the alias
 *  - CfnSchedule targets the alias ARN
 *  - SQS event source mappings target the alias
 *  - CloudWatch Synthetics canary exists with correct schedule
 *  - Synthetics alarm exists and gates deployments
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SharedInfraStack } from '../lib/stacks/shared-infra';
import { CongressIntegrationServiceStack } from '../lib/stacks/congress-integration-service';
import { PriorityServiceStack } from '../lib/stacks/priority-service';
import { UserAPIServiceStack } from '../lib/stacks/user-api-service';
import { NotificationServiceStack } from '../lib/stacks/notification-service';
import { SummarizerServiceStack } from '../lib/stacks/summarizer-service';
import { AnalyticsServiceStack } from '../lib/stacks/analytics-service';
import { CongressStoreStack } from '../lib/stacks/congress-store';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { BILL_PRIORITY_TABLE_PARTITION_KEY } from '../lib/config/priority-service-constants';
import { parseOptionalReservedConcurrency, parseReservedConcurrencyWithDefault } from '../lib/config/env';
import {
  addProdAliasWithDeployment,
  billboardApiDeploymentConfig,
  LambdaDeploymentKind,
} from '../lib/stacks/helpers/codedeploy-utils';
import { alarmTopicFromName } from '../lib/stacks/helpers/alarm-topic';
import { createReleaseBackedLambdaFactory } from '../lib/stacks/helpers/lambda-utils';
import { createDummyLambdaFactory, createNamedQueue } from './helpers/cdk-test-helpers';
import { synthesizeStacks } from './helpers/synth-stacks';

// ── shared synthesis ──────────────────────────────────────────────────────────

let templates: ReturnType<typeof synthesizeStacks>;
beforeAll(() => {
  templates = synthesizeStacks();
});

// ── helpers ───────────────────────────────────────────────────────────────────

// Templates are only read, so each stack is synthesized once per file.
const memo = <T>(build: () => T): (() => T) => {
  let value: T | undefined;
  return () => (value ??= build());
};

const congressTemplate = memo(() => {
  const app = new cdk.App();
  const shared = new SharedInfraStack(app, 'SharedInfraStack');
  const stack = new CongressIntegrationServiceStack(app, 'CongressIntegrationServiceStack', {
    lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
  });
  return Template.fromStack(stack);
});

const priorityTemplate = memo(() => {
  const app = new cdk.App();
  const shared = new SharedInfraStack(app, 'SharedInfraStack');
  const stack = new PriorityServiceStack(app, 'PriorityServiceStack', {
    lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
  });
  return Template.fromStack(stack);
});

const userApiTemplate = memo(() => {
  const app = new cdk.App();
  const shared = new SharedInfraStack(app, 'SharedInfraStack');
  const deps = new cdk.Stack(app, 'Deps');
  const billPriorityTable = new ddb.Table(deps, 'BPTable', {
    partitionKey: { name: BILL_PRIORITY_TABLE_PARTITION_KEY, type: ddb.AttributeType.STRING },
    billingMode: ddb.BillingMode.PAY_PER_REQUEST,
  });
  const stack = new UserAPIServiceStack(app, 'UserAPIServiceStack', {
    lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
    billPriorityTable,
  });
  return Template.fromStack(stack);
});

const notificationTemplate = memo(() => {
  const app = new cdk.App();
  const shared = new SharedInfraStack(app, 'SharedInfraStack');
  const deps = new cdk.Stack(app, 'Deps');
  const billPriorityTable = new ddb.Table(deps, 'BPTable', {
    partitionKey: { name: BILL_PRIORITY_TABLE_PARTITION_KEY, type: ddb.AttributeType.STRING },
    billingMode: ddb.BillingMode.PAY_PER_REQUEST,
  });
  const stack = new NotificationServiceStack(app, 'NotificationServiceStack', {
    lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
    notificationTypeQueue: shared.notificationTypeQueue,
    billPriorityTable,
  });
  return Template.fromStack(stack);
});

const summarizerTemplate = memo(() => {
  const app = new cdk.App();
  const shared = new SharedInfraStack(app, 'SharedInfraStack');
  const deps = new cdk.Stack(app, 'Deps');
  const billDifferQueue = createNamedQueue(deps, 'BillDifferQueue');
  const congressMemberSummarizerQueue = createNamedQueue(deps, 'CongressMemberSummarizerQueue');
  const stack = new SummarizerServiceStack(app, 'SummarizerServiceStack', {
    lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
    billDifferQueue,
    congressMemberSummarizerQueue,
  });
  return Template.fromStack(stack);
});

const analyticsTemplate = memo(() => {
  const app = new cdk.App();
  const shared = new SharedInfraStack(app, 'SharedInfraStack');
  const deps = new cdk.Stack(app, 'Deps');
  const feedbackTable = new ddb.Table(deps, 'FbTable', {
    partitionKey: { name: 'userId', type: ddb.AttributeType.STRING },
    sortKey: { name: 'billId', type: ddb.AttributeType.STRING },
    billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    stream: ddb.StreamViewType.NEW_IMAGE,
  });
  const stack = new AnalyticsServiceStack(app, 'AnalyticsServiceStack', {
    lambdaArtifactsBucket: shared.lambdaArtifactsBucket,
    congressMemberStatsQueue: shared.congressMemberStatsQueue,
    feedbackTableStreamArn: feedbackTable.tableStreamArn!,
    enableFeedbackStreamAggregation: true,
  });
  return Template.fromStack(stack);
});

// ── Lambda aliases ────────────────────────────────────────────────────────────

describe('Lambda prod aliases', () => {
  it('CongressIntegrationServiceStack has prod alias for each Lambda', () => {
    const t = congressTemplate();
    // 5 Lambdas → 5 aliases
    t.resourceCountIs('AWS::Lambda::Alias', 5);
    t.allResourcesProperties('AWS::Lambda::Alias', {
      Name: 'prod',
    });
  });

  it('PriorityServiceStack has prod alias for BillPriorityResolver', () => {
    const t = priorityTemplate();
    t.resourceCountIs('AWS::Lambda::Alias', 1);
    t.hasResourceProperties('AWS::Lambda::Alias', { Name: 'prod' });
  });

  // The account-integrity work added PreSignUpCheck, RestampUserVotes and AppAttest to the 26 before it; CB-07
  // SignUpFilterCheck.
  it('UserAPIServiceStack has prod alias for all 30 Lambdas', () => {
    const t = userApiTemplate();
    // 30 Lambdas → 30 aliases
    t.resourceCountIs('AWS::Lambda::Alias', 30);
    t.allResourcesProperties('AWS::Lambda::Alias', {
      Name: 'prod',
    });
  });

  it('NotificationServiceStack has prod alias for each release-backed Lambda', () => {
    const t = notificationTemplate();
    // 5 release-backed Lambdas → 5 aliases (onEvent NodejsFunction is not aliased)
    t.resourceCountIs('AWS::Lambda::Alias', 5);
    t.allResourcesProperties('AWS::Lambda::Alias', { Name: 'prod' });
  });

  it('SummarizerServiceStack has prod alias for each Lambda', () => {
    const t = summarizerTemplate();
    t.resourceCountIs('AWS::Lambda::Alias', 3);
    t.allResourcesProperties('AWS::Lambda::Alias', { Name: 'prod' });
  });

  it('AnalyticsServiceStack has prod alias for each Lambda', () => {
    const t = analyticsTemplate();
    t.resourceCountIs('AWS::Lambda::Alias', 2);
    t.allResourcesProperties('AWS::Lambda::Alias', { Name: 'prod' });
  });

  it('CongressStoreStack has prod alias for CreateBillsManifest and CreateCongressMembersManifest', () => {
    const t = templates.congressStoreTemplate;
    t.resourceCountIs('AWS::Lambda::Alias', 2);
    t.allResourcesProperties('AWS::Lambda::Alias', { Name: 'prod' });
  });

  it('prod aliases are pinned from SSM and do not have CloudFormation CodeDeploy update policies', () => {
    const t = userApiTemplate();
    const aliases = t.findResources('AWS::Lambda::Alias');

    for (const [, alias] of Object.entries(aliases)) {
      expect(alias.UpdatePolicy).toBeUndefined();
      expect(JSON.stringify(alias.Properties?.FunctionVersion)).toMatch(
        /\{\{resolve:ssm:\/billboard\/prod\/lambda-alias-versions\//,
      );
    }
  });

  it('prod aliases wait for their function\'s published version (a new function\'s pin is "1")', () => {
    const t = userApiTemplate();
    const versions = t.findResources('AWS::Lambda::Version');
    const aliases = t.findResources('AWS::Lambda::Alias');

    for (const [id, alias] of Object.entries(aliases)) {
      const functionRef = alias.Properties.FunctionName.Ref;
      const versionIds = Object.entries(versions)
        .filter(([, version]) => version.Properties.FunctionName.Ref === functionRef)
        .map(([versionId]) => versionId);
      expect(versionIds).toHaveLength(1);
      expect({ id, dependsOn: alias.DependsOn }).toEqual({
        id,
        dependsOn: expect.arrayContaining(versionIds),
      });
    }
  });
});

// ── CodeDeploy applications and deployment groups ─────────────────────────────

describe('CodeDeploy deployment groups', () => {
  it('CongressIntegrationServiceStack has a LambdaApplication', () => {
    congressTemplate().hasResourceProperties('AWS::CodeDeploy::Application', {
      ComputePlatform: 'Lambda',
    });
  });

  it('CongressIntegrationServiceStack has 5 deployment groups (one per Lambda)', () => {
    congressTemplate().resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 5);
  });

  it('PriorityServiceStack has 1 deployment group', () => {
    priorityTemplate().resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 1);
  });

  it('UserAPIServiceStack has 30 deployment groups', () => {
    userApiTemplate().resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 30);
  });

  it('NotificationServiceStack has 5 deployment groups', () => {
    notificationTemplate().resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 5);
  });

  it('SummarizerServiceStack has 3 deployment groups', () => {
    summarizerTemplate().resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 3);
  });

  it('AnalyticsServiceStack has 2 deployment groups', () => {
    analyticsTemplate().resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 2);
  });

  it('CongressStoreStack has 2 deployment groups', () => {
    templates.congressStoreTemplate.resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 2);
  });
});

// ── Deployment config: 10% / 10-minute canary (api) or all at once (worker) ───

const ALL_AT_ONCE_CONFIG_NAME = 'CodeDeployDefault.LambdaAllAtOnce';
// CON-08: CodeDeploy's built-in config, present in every account; it replaced a custom 20% / 2-hour one.
const API_CANARY_CONFIG_NAME = 'CodeDeployDefault.LambdaCanary10Percent10Minutes';

/**
 * Every deployment group must use either the built-in 10% / 10-minute canary
 * ('api') or the built-in all-at-once config ('worker'), and no stack may create
 * a DeploymentConfig resource of its own.
 */
function assertGroupsUseCanaryOrAllAtOnce(t: Template): void {
  t.resourceCountIs('AWS::CodeDeploy::DeploymentConfig', 0);
  const groups = t.findResources('AWS::CodeDeploy::DeploymentGroup');
  expect(Object.keys(groups).length).toBeGreaterThan(0);
  for (const [id, group] of Object.entries(groups)) {
    expect({ id, config: group.Properties?.DeploymentConfigName }).toEqual({
      id,
      config: expect.stringMatching(new RegExp(`^(${ALL_AT_ONCE_CONFIG_NAME}|${API_CANARY_CONFIG_NAME})$`)),
    });
  }
}

describe('CodeDeploy deployment config', () => {
  it('CongressIntegrationServiceStack deployment groups use the canary or all-at-once config', () => {
    assertGroupsUseCanaryOrAllAtOnce(congressTemplate());
  });

  it('every service stack deployment group uses the canary or all-at-once config', () => {
    for (const t of [
      priorityTemplate(),
      userApiTemplate(),
      notificationTemplate(),
      summarizerTemplate(),
      analyticsTemplate(),
      templates.congressStoreTemplate,
    ]) {
      assertGroupsUseCanaryOrAllAtOnce(t);
    }
  });

  // CON-08: the 23 API handlers shift 10% for 10 minutes; the 7 workers shift at once. The account-integrity
  // work added two canaried functions (PreSignUpCheck, a synchronous Cognito trigger, and AppAttest) and one worker
  // (RestampUserVotes); CB-07 one worker (SignUpFilterCheck).
  it('UserAPIServiceStack API groups use the built-in 10% / 10-minute canary and create no config resource', () => {
    const t = userApiTemplate();
    t.resourceCountIs('AWS::CodeDeploy::DeploymentConfig', 0);
    const configs = Object.values(t.findResources('AWS::CodeDeploy::DeploymentGroup'))
      .map((group) => group.Properties?.DeploymentConfigName as string);
    expect(configs.filter((name) => name === API_CANARY_CONFIG_NAME)).toHaveLength(23);
    expect(configs.filter((name) => name === ALL_AT_ONCE_CONFIG_NAME)).toHaveLength(7);
    expect(configs).toHaveLength(30);
  });

  it('the helper returns the built-in config and creates nothing', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'ConfigOnlyStack');
    const config = billboardApiDeploymentConfig();
    expect(config.deploymentConfigName).toBe(API_CANARY_CONFIG_NAME);
    expect(config).toBe(codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_10MINUTES);
    expect(stack.node.children).toHaveLength(0);
  });
});

// ── addProdAliasWithDeployment deployment kinds ───────────────────────────────

describe('addProdAliasWithDeployment deployment kinds', () => {
  const synthWithKind = (deploymentKind?: LambdaDeploymentKind): Template => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'DeploymentKindStack');
    const fn = createDummyLambdaFactory(stack)('KindTestFunction');
    const application = new codedeploy.LambdaApplication(stack, 'KindTestApp');
    const deploymentConfig = billboardApiDeploymentConfig();
    addProdAliasWithDeployment(
      stack,
      'KindTest',
      fn,
      application,
      deploymentConfig,
      [],
      deploymentKind === undefined ? undefined : { deploymentKind },
    );
    return Template.fromStack(stack);
  };


  const assertAliasAlarmGatesRollback = (t: Template): void => {
    t.resourceCountIs('AWS::Lambda::Alias', 1);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Threshold: 1,
    });
    t.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AlarmConfiguration: {
        Enabled: true,
        Alarms: [{ Name: { Ref: Match.stringLikeRegexp('KindTestAliasErrorAlarm') } }],
      },
      AutoRollbackConfiguration: {
        Enabled: true,
        Events: Match.arrayWith(['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM']),
      },
    });
  };

  it('defaults to the api canary config passed by the caller', () => {
    const t = synthWithKind();
    t.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: API_CANARY_CONFIG_NAME,
    });
    t.resourceCountIs('AWS::CodeDeploy::DeploymentConfig', 0);
    assertAliasAlarmGatesRollback(t);
  });

  it("'api' uses the canary config passed by the caller", () => {
    const t = synthWithKind('api');
    t.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: API_CANARY_CONFIG_NAME,
    });
    assertAliasAlarmGatesRollback(t);
  });

  it("'worker' shifts all traffic at once and keeps the alarm and rollback wiring", () => {
    const t = synthWithKind('worker');
    t.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: ALL_AT_ONCE_CONFIG_NAME,
    });
    assertAliasAlarmGatesRollback(t);
  });

  it('intentionalErrorMetrics: the alias alarm is Errors less those metrics (each a 1-minute Sum, 0 when missing), still gating rollback', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'IntentionalErrorsStack');
    const fn = createDummyLambdaFactory(stack)('KindTestFunction');
    const application = new codedeploy.LambdaApplication(stack, 'KindTestApp');
    addProdAliasWithDeployment(stack, 'KindTest', fn, application, billboardApiDeploymentConfig(), [], {
      // Given with another period and statistic: the alarm reads each as a 1-minute Sum regardless.
      intentionalErrorMetrics: ['Refused', 'ProbeRefused'].map((metricName) =>
        new cloudwatch.Metric({ namespace: 'Test/Refusals', metricName, statistic: 'Average', period: cdk.Duration.minutes(5) })),
    });
    const t = Template.fromStack(stack);

    const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms).toHaveLength(1);
    const properties = alarms[0].Properties;
    expect(properties).toMatchObject({
      Threshold: 1,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect(properties.MetricName).toBeUndefined();
    const queries: any[] = properties.Metrics;
    const byId = Object.fromEntries(queries.map((query) => [query.Id, query]));
    expect(Object.keys(byId).sort()).toEqual(['errors', 'expr_1', 'intentional0', 'intentional1'].sort());
    expect(byId.expr_1).toMatchObject({
      Expression: 'errors - FILL(intentional0, 0) - FILL(intentional1, 0)',
      ReturnData: true,
    });
    expect(byId.errors).toMatchObject({
      ReturnData: false,
      MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: 'Errors' }, Period: 60, Stat: 'Sum' },
    });
    // The alias's own Errors: FunctionName and Resource <function>:prod.
    expect(JSON.stringify(byId.errors.MetricStat.Metric.Dimensions)).toContain(':prod');
    [['intentional0', 'Refused'], ['intentional1', 'ProbeRefused']].forEach(([id, metricName]) =>
      expect(byId[id]).toMatchObject({
        ReturnData: false,
        MetricStat: { Metric: { Namespace: 'Test/Refusals', MetricName: metricName }, Period: 60, Stat: 'Sum' },
      }));
    expect(byId.intentional0.MetricStat.Metric.Dimensions).toBeUndefined();
    t.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AlarmConfiguration: {
        Enabled: true,
        Alarms: [{ Name: { Ref: Match.stringLikeRegexp('KindTestAliasErrorAlarm') } }],
      },
    });
  });
});

// ── Auto-rollback configuration ───────────────────────────────────────────────

function assertAllGroupsHaveAutoRollback(t: Template): void {
  const groups = t.findResources('AWS::CodeDeploy::DeploymentGroup');
  for (const [id, group] of Object.entries(groups)) {
    const events: string[] = (group as Record<string, any>).Properties?.AutoRollbackConfiguration?.Events ?? [];
    expect({ id, events }).toMatchObject({
      events: expect.arrayContaining(['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM']),
    });
  }
}

describe('CodeDeploy auto-rollback', () => {
  it('CongressIntegrationServiceStack deployment groups have auto-rollback', () => {
    assertAllGroupsHaveAutoRollback(congressTemplate());
  });

  it('UserAPIServiceStack deployment groups have auto-rollback', () => {
    assertAllGroupsHaveAutoRollback(userApiTemplate());
  });

  it('NotificationServiceStack deployment groups have auto-rollback', () => {
    assertAllGroupsHaveAutoRollback(notificationTemplate());
  });
});

// ── Per-alias error alarms ─────────────────────────────────────────────────────

describe('Per-alias error alarms', () => {
  it('CongressIntegrationServiceStack has 5 per-alias error alarms', () => {
    // Each Lambda gets one error alarm; stack total = 5
    const t = congressTemplate();
    const alarms = t.findResources('AWS::CloudWatch::Alarm', {
      Properties: {
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
      },
    });
    expect(Object.keys(alarms).length).toBeGreaterThanOrEqual(5);
  });

  it('UserAPIServiceStack has per-alias error alarms for every Lambda', () => {
    const t = userApiTemplate();
    const alarms = t.findResources('AWS::CloudWatch::Alarm', {
      Properties: {
        Namespace: 'AWS/Lambda',
        MetricName: 'Errors',
      },
    });
    // 23 Lambdas → at least 23 error alarms
    expect(Object.keys(alarms).length).toBeGreaterThanOrEqual(23);
  });

  it('Alias error alarms are attached to deployment groups', () => {
    // Every deployment group must reference at least one alarm
    const t = congressTemplate();
    const groups = t.findResources('AWS::CodeDeploy::DeploymentGroup');
    for (const [, group] of Object.entries(groups)) {
      const alarmList: unknown[] = group.Properties?.AlarmConfiguration?.Alarms ?? [];
      expect(alarmList.length).toBeGreaterThan(0);
    }
  });

  it('UserAPI deployment groups include the API GW 5XX alarm', () => {
    const t = userApiTemplate();
    // The API GW 5XX alarm exists
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApiGateway',
      MetricName: '5XXError',
    });
  });

  // Infra review item 15a: the canary exercises API routes only, and its alarm can stay in ALARM
  // overnight (missing data is ignored outside the canary's hours), so on a worker group it would stop
  // or roll back an unrelated worker deploy. API groups keep it; worker groups keep their own alarm.
  it('UserAPI API deployment groups include the Synthetics canary alarm, worker groups do not', () => {
    const t = userApiTemplate();
    const groups = Object.entries(t.findResources('AWS::CodeDeploy::DeploymentGroup'));
    const alarmsOf = (group: any): string => JSON.stringify(group.Properties?.AlarmConfiguration?.Alarms ?? []);
    const isWorker = (group: any): boolean =>
      group.Properties?.DeploymentConfigName === 'CodeDeployDefault.LambdaAllAtOnce';

    const workers = groups.filter(([, group]) => isWorker(group));
    const apis = groups.filter(([, group]) => !isWorker(group));
    expect(groups).toHaveLength(30);
    expect(workers.map(([logicalId]) => logicalId.replace(/DeploymentGroup.*$/, '')).sort()).toEqual([
      'CleanupOrphanedUsers',
      'ExportCognitoUsers',
      'GenerateWeeklyDigests',
      'PublishBillsManifest',
      'RestampUserVotes',
      'SignUpFilterCheck',
      'WeeklyDigestWorker',
    ]);
    expect(apis).toHaveLength(23);
    // The canaried account-integrity functions: the Cognito trigger and the App Attest routes.
    expect(apis.map(([logicalId]) => logicalId.replace(/DeploymentGroup.*$/, ''))).toEqual(
      expect.arrayContaining(['AppAttest', 'PreSignUpCheck']),
    );

    for (const [logicalId, group] of apis) {
      expect({ logicalId, alarms: alarmsOf(group) }).toEqual({
        logicalId,
        alarms: expect.stringMatching(/SyntheticsCanaryAlarm/),
      });
      // Unchanged for API handlers: their own error alarm and the API Gateway 5XX alarm.
      expect(alarmsOf(group)).toMatch(/AliasErrorAlarm/);
      expect(alarmsOf(group)).toMatch(/ApiGw5xxAlarm/);
    }
    for (const [logicalId, group] of workers) {
      expect({ logicalId, alarms: alarmsOf(group) }).toEqual({
        logicalId,
        alarms: expect.not.stringMatching(/SyntheticsCanaryAlarm/),
      });
      // A worker still rolls back on its own alias error alarm.
      expect(group.Properties.AlarmConfiguration.Alarms).toHaveLength(1);
      expect(alarmsOf(group)).toMatch(/AliasErrorAlarm/);
    }
  });
});

// ── API Gateway integrations use alias ───────────────────────────────────────

describe('API Gateway integrations use prod alias', () => {
  it('all Lambda integrations reference the :prod alias', () => {
    const t = userApiTemplate();
    const methods = t.findResources('AWS::ApiGateway::Method', {
      Properties: {
        Integration: {
          Type: 'AWS_PROXY',
        },
      },
    });
    for (const [, method] of Object.entries(methods)) {
      const uri: unknown = method.Properties?.Integration?.Uri;
      const uriStr = JSON.stringify(uri ?? '');
      if (uriStr.includes('lambda')) {
        // Lambda integration URIs should include the alias qualifier (:prod)
        expect(uriStr).toMatch(/prod/i);
      }
    }
  });

  it('GET /health is a mock integration (no Lambda)', () => {
    const t = userApiTemplate();
    t.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      Integration: {
        Type: 'MOCK',
      },
      AuthorizationType: 'NONE',
    });
  });
});

// ── EventBridge targets use alias ─────────────────────────────────────────────

describe('EventBridge rule targets use prod alias', () => {
  it('CongressIntegrationServiceStack EventBridge targets reference :prod', () => {
    const t = congressTemplate();
    const rules = t.findResources('AWS::Events::Rule');
    for (const [, rule] of Object.entries(rules)) {
      const targets: unknown[] = rule.Properties?.Targets ?? [];
      for (const target of targets) {
        const arn = (target as Record<string, unknown>).Arn;
        // Alias ARN ends with :prod (as a Fn::Join or plain string)
        expect(JSON.stringify(arn)).toMatch(/prod/i);
      }
    }
  });

  it('NotificationServiceStack EventBridge target references :prod', () => {
    const t = notificationTemplate();
    const rules = t.findResources('AWS::Events::Rule');
    for (const [, rule] of Object.entries(rules)) {
      const targets: unknown[] = rule.Properties?.Targets ?? [];
      for (const target of targets) {
        const arn = (target as Record<string, unknown>).Arn;
        expect(JSON.stringify(arn)).toMatch(/prod/i);
      }
    }
  });
});

// ── CfnSchedule targets use alias ARN ────────────────────────────────────────

describe('EventBridge Scheduler targets use prod alias', () => {
  it('PriorityServiceStack CfnSchedule target ARN contains :prod', () => {
    const t = priorityTemplate();
    const schedules = t.findResources('AWS::Scheduler::Schedule');
    for (const [, schedule] of Object.entries(schedules)) {
      const arn: unknown = schedule.Properties?.Target?.Arn;
      expect(JSON.stringify(arn)).toMatch(/prod/i);
    }
  });

  it('UserAPIServiceStack CfnSchedules (GenerateWeeklyDigests, PublishBillsManifest) target ARNs contain :prod', () => {
    const t = userApiTemplate();
    const schedules = t.findResources('AWS::Scheduler::Schedule');
    expect(Object.keys(schedules)).toHaveLength(2);
    for (const [, schedule] of Object.entries(schedules)) {
      const arn: unknown = schedule.Properties?.Target?.Arn;
      expect(JSON.stringify(arn)).toMatch(/prod/i);
    }
  });
});

// ── SQS event source mappings target alias ────────────────────────────────────

describe('SQS event source mappings use prod alias', () => {
  it('CongressIntegrationServiceStack ESMs reference alias ARN', () => {
    const t = congressTemplate();
    const esms = t.findResources('AWS::Lambda::EventSourceMapping');
    for (const [, esm] of Object.entries(esms)) {
      const fn: unknown = esm.Properties?.FunctionName;
      // FunctionName for an alias is a Ref or Fn::GetAtt containing 'ProdAlias'
      expect(JSON.stringify(fn)).toMatch(/ProdAlias|prod/i);
    }
  });

  it('NotificationServiceStack ESMs reference alias ARN', () => {
    const t = notificationTemplate();
    const esms = t.findResources('AWS::Lambda::EventSourceMapping');
    for (const [, esm] of Object.entries(esms)) {
      const fn: unknown = esm.Properties?.FunctionName;
      expect(JSON.stringify(fn)).toMatch(/ProdAlias|prod/i);
    }
  });

  it('UserAPIServiceStack ESMs (WeeklyDigestWorker, RestampUserVotes) reference alias ARNs', () => {
    const t = userApiTemplate();
    const esms = Object.values(t.findResources('AWS::Lambda::EventSourceMapping'));
    expect(esms).toHaveLength(2);
    const targets = esms.map((esm) => JSON.stringify(esm.Properties?.FunctionName));
    expect(targets.filter((fn) => /WeeklyDigestWorkerProdAlias/.test(fn))).toHaveLength(1);
    expect(targets.filter((fn) => /RestampUserVotesProdAlias/.test(fn))).toHaveLength(1);
  });

  it('SummarizerServiceStack ESMs reference alias ARN', () => {
    const t = summarizerTemplate();
    const esms = t.findResources('AWS::Lambda::EventSourceMapping');
    for (const [, esm] of Object.entries(esms)) {
      const fn: unknown = esm.Properties?.FunctionName;
      expect(JSON.stringify(fn)).toMatch(/ProdAlias|prod/i);
    }
  });

  it('AnalyticsServiceStack DynamoDB stream ESM references alias ARN', () => {
    const t = analyticsTemplate();
    const esms = t.findResources('AWS::Lambda::EventSourceMapping');
    for (const [, esm] of Object.entries(esms)) {
      const fn: unknown = esm.Properties?.FunctionName;
      expect(JSON.stringify(fn)).toMatch(/ProdAlias|prod/i);
    }
  });
});

// ── CloudWatch Synthetics canary ──────────────────────────────────────────────

describe('CloudWatch Synthetics canary', () => {
  it('canary signs in through its own USER_PASSWORD_AUTH client', () => {
    userApiTemplate().hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'BillboardCanaryClient',
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
    });
    userApiTemplate().hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'BillboardUserPoolClient',
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
    });
  });

  it('UserAPIServiceStack creates exactly one Synthetics canary', () => {
    userApiTemplate().resourceCountIs('AWS::Synthetics::Canary', 1);
  });

  it('canary is named billboard-api', () => {
    userApiTemplate().hasResourceProperties('AWS::Synthetics::Canary', {
      Name: 'billboard-api',
    });
  });

  it('canary runs every 15 minutes on a cron aligned to US Eastern hours', () => {
    userApiTemplate().hasResourceProperties('AWS::Synthetics::Canary', {
      Schedule: {
        Expression: 'cron(0/15 13-23 ? * * *)',
      },
    });
  });

  it('canary uses nodejs puppeteer runtime', () => {
    userApiTemplate().hasResourceProperties('AWS::Synthetics::Canary', {
      RuntimeVersion: 'syn-nodejs-puppeteer-15.0',
    });
  });

  it('canary script uses the new Synthetics namespace and AWS SDK v3 clients', () => {
    const canaries = userApiTemplate().findResources('AWS::Synthetics::Canary');
    const script = JSON.stringify(Object.values(canaries)[0]?.Properties?.Code?.Script ?? '');
    expect(script).toContain('@aws/synthetics-puppeteer');
    expect(script).toContain('@aws-sdk/client-secrets-manager');
    expect(script).toContain('@aws-sdk/client-cognito-identity-provider');
    expect(script).toContain('@aws-sdk/client-cloudwatch');
  });

  it('canary has environment variables for authenticated smoke coverage', () => {
    userApiTemplate().hasResourceProperties('AWS::Synthetics::Canary', {
      RunConfig: {
        EnvironmentVariables: Match.objectLike({
          API_URL: Match.anyValue(),
          USER_POOL_CLIENT_ID: Match.anyValue(),
          SMOKE_TEST_SECRET_NAME: '',
          SMOKE_TEST_FIXTURES_SECRET_NAME: '',
          SMOKE_TEST_WRITE_CHECKS: 'false',
          MAX_WEEKLY_DIGEST_AGE_SECONDS: '691200',
        }),
      },
    });
  });

  // C1.9: the canary no longer checks the two manifest ages, which read the request time.
  it('canary no longer gets the bills or congress members manifest age limits', () => {
    const [canary] = Object.values(userApiTemplate().findResources('AWS::Synthetics::Canary'));
    const variables = Object.keys(canary.Properties.RunConfig.EnvironmentVariables);
    expect(variables).not.toContain('MAX_BILLS_MANIFEST_AGE_SECONDS');
    expect(variables).not.toContain('MAX_CONGRESS_MEMBERS_MANIFEST_AGE_SECONDS');
    expect(variables.sort()).toEqual([
      'API_URL',
      'MAX_WEEKLY_DIGEST_AGE_SECONDS',
      'SMOKE_TEST_FIXTURES_SECRET_NAME',
      'SMOKE_TEST_SECRET_NAME',
      'SMOKE_TEST_WRITE_CHECKS',
      'USER_POOL_CLIENT_ID',
    ]);
  });

  it('canary artifact retention is 7–14 days', () => {
    userApiTemplate().hasResourceProperties('AWS::Synthetics::Canary', {
      SuccessRetentionPeriod: Match.anyValue(),
      FailureRetentionPeriod: Match.anyValue(),
    });
    const t = userApiTemplate();
    const canaries = t.findResources('AWS::Synthetics::Canary');
    for (const [, canary] of Object.entries(canaries)) {
      const success: number = canary.Properties?.SuccessRetentionPeriod ?? 0;
      const failure: number = canary.Properties?.FailureRetentionPeriod ?? 0;
      expect(success).toBeGreaterThanOrEqual(7);
      expect(success).toBeLessThanOrEqual(14);
      expect(failure).toBeGreaterThanOrEqual(7);
      expect(failure).toBeLessThanOrEqual(14);
    }
  });

  it('Synthetics CloudWatch alarm exists with SuccessPercent metric', () => {
    userApiTemplate().hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'CloudWatchSynthetics',
      MetricName: 'SuccessPercent',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 34,
    });
  });

  it('Synthetics alarm period covers approximately 3 canary runs (45 min)', () => {
    const t = userApiTemplate();
    const alarms = t.findResources('AWS::CloudWatch::Alarm', {
      Properties: { Namespace: 'CloudWatchSynthetics' },
    });
    for (const [, alarm] of Object.entries(alarms)) {
      expect(alarm.Properties?.Period).toBe(2700); // 45 minutes in seconds
    }
  });
});

// ── Shared stack helpers used by every service stack ─────────────────────────

describe('release-backed Lambda defaults', () => {
  const synthLambdas = (
    build: (stack: cdk.Stack, bucket: s3.IBucket) => void,
  ): Template => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'LambdaDefaultsStack');
    const bucket = new s3.Bucket(stack, 'ArtifactsBucket');
    build(stack, bucket);
    return Template.fromStack(stack);
  };

  const logGroupRetention = (t: Template, functionName: string): unknown => {
    const groups = t.findResources('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: `/aws/lambda/${functionName}` },
    });
    return Object.values(groups)[0]?.Properties?.RetentionInDays;
  };

  it('defaults to 256 MB, active X-Ray tracing and a retained one-month log group', () => {
    const t = synthLambdas((stack, bucket) => {
      createReleaseBackedLambdaFactory(stack, bucket)('DefaultsFn', 'defaultsFn');
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'DefaultsFn',
      MemorySize: 256,
      TracingConfig: { Mode: 'Active' },
    });
    t.hasResource('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: '/aws/lambda/DefaultsFn', RetentionInDays: 30 },
      DeletionPolicy: 'Retain',
    });
  });

  it('lets each call override memory, timeout, tracing and log retention', () => {
    const t = synthLambdas((stack, bucket) => {
      createReleaseBackedLambdaFactory(stack, bucket)('TunedFn', 'tunedFn', {
        memorySize: 1024,
        timeout: cdk.Duration.seconds(20),
        tracing: lambda.Tracing.PASS_THROUGH,
        logRetention: logs.RetentionDays.THREE_MONTHS,
      });
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'TunedFn',
      MemorySize: 1024,
      Timeout: 20,
      TracingConfig: { Mode: 'PassThrough' },
    });
    expect(logGroupRetention(t, 'TunedFn')).toBe(90);
  });

  it('falls back to the defaults when a caller passes an explicit undefined', () => {
    const t = synthLambdas((stack, bucket) => {
      createReleaseBackedLambdaFactory(stack, bucket)('UndefinedFn', 'undefinedFn', {
        memorySize: undefined,
        logRetention: undefined,
      });
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'UndefinedFn',
      MemorySize: 256,
      TracingConfig: { Mode: 'Active' },
    });
    expect(logGroupRetention(t, 'UndefinedFn')).toBe(30);
  });

  it('applies factory-wide defaults, with per-call props taking precedence', () => {
    const t = synthLambdas((stack, bucket) => {
      const create = createReleaseBackedLambdaFactory(stack, bucket, {
        logRetention: logs.RetentionDays.THREE_MONTHS,
        memorySize: 512,
      });
      create('FactoryDefaultFn', 'factoryDefaultFn');
      create('FactoryOverrideFn', 'factoryOverrideFn', { memorySize: 1024 });
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'FactoryDefaultFn',
      MemorySize: 512,
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'FactoryOverrideFn',
      MemorySize: 1024,
    });
    expect(logGroupRetention(t, 'FactoryDefaultFn')).toBe(90);
    expect(logGroupRetention(t, 'FactoryOverrideFn')).toBe(90);
  });
});

describe('alarmTopicFromName', () => {
  it('builds the BillboardAlarmTopic ARN locally, once per stack, with no cross-stack import', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'AlarmTopicStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const topic = alarmTopicFromName(stack);
    // In its own app, so the empty stack is not synthesized (and validated) with this one.
    expect(alarmTopicFromName(new cdk.Stack(new cdk.App(), 'OtherStack'))).not.toBe(topic);
    expect(alarmTopicFromName(stack)).toBe(topic);

    const alarm = new cloudwatch.Alarm(stack, 'SomeAlarm', {
      metric: new cloudwatch.Metric({ namespace: 'Test', metricName: 'Failures' }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));

    const t = Template.fromStack(stack);
    const actions = Object.values(t.findResources('AWS::CloudWatch::Alarm'))[0]?.Properties?.AlarmActions;
    // The partition stays an AWS::Partition reference, so check the rest of the ARN.
    expect(JSON.stringify(actions)).toContain(':sns:us-east-1:123456789012:BillboardAlarmTopic');
    expect(JSON.stringify(t.toJSON())).not.toContain('Fn::ImportValue');
  });

  it('uses the stack account and region pseudo parameters for env-agnostic stacks', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'EnvAgnosticAlarmTopicStack');
    const alarm = new cloudwatch.Alarm(stack, 'SomeAlarm', {
      metric: new cloudwatch.Metric({ namespace: 'Test', metricName: 'Failures' }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopicFromName(alarm)));

    const actions = Object.values(
      Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm'),
    )[0]?.Properties?.AlarmActions;
    const serialized = JSON.stringify(actions);
    expect(serialized).toContain('AWS::Region');
    expect(serialized).toContain('AWS::AccountId');
    expect(serialized).toContain(':BillboardAlarmTopic');
  });
});

describe('parseOptionalReservedConcurrency', () => {
  it('returns undefined when the variable is unset or empty', () => {
    expect(parseOptionalReservedConcurrency(undefined, 'X')).toBeUndefined();
    expect(parseOptionalReservedConcurrency('', 'X')).toBeUndefined();
  });

  it('parses a positive integer', () => {
    expect(parseOptionalReservedConcurrency('5', 'X')).toBe(5);
  });

  it.each(['0', '-1', 'abc'])('rejects %s', (value) => {
    expect(() => parseOptionalReservedConcurrency(value, 'SOME_RESERVED_CONCURRENCY')).toThrow(
      `SOME_RESERVED_CONCURRENCY must be an integer >= 1 when provided (received: ${value})`,
    );
  });
});

describe('parseReservedConcurrencyWithDefault', () => {
  // The deploy workflow passes an undefined repository variable through as "".
  it.each([undefined, '', '   '])('returns the default for %p', (value) => {
    expect(parseReservedConcurrencyWithDefault(value, 'X', 1)).toBe(1);
  });

  it.each(['off', 'OFF', ' Off '])('returns undefined (no reservation) for %p', (value) => {
    expect(parseReservedConcurrencyWithDefault(value, 'X', 1)).toBeUndefined();
  });

  it('parses a positive integer override', () => {
    expect(parseReservedConcurrencyWithDefault('2', 'X', 1)).toBe(2);
    expect(parseReservedConcurrencyWithDefault(' 3 ', 'X', 1)).toBe(3);
  });

  it.each(['0', '-1', 'abc', '1.5', '1abc', 'none'])('rejects %p', (value) => {
    expect(() => parseReservedConcurrencyWithDefault(value, 'SOME_RESERVED_CONCURRENCY', 1)).toThrow(
      `SOME_RESERVED_CONCURRENCY must be "off" or an integer >= 1 when provided (received: ${value})`,
    );
  });
});
