/**
 * C1.1 (infra review item 3): every scheduled job leaves a record when it cannot run.
 *
 * Asserted on the real app (bin/billboard-infra.ts, synthesized the way `cdk synth` runs it), so a schedule
 * added later without a dead-letter queue fails here:
 *
 * - SharedInfraStack owns one queue, ScheduledJobFailures: SQS-managed encryption, 14 days, no consumer.
 *   Its queue policy has exactly one statement, letting EventBridge rules of this account write to it.
 * - All 10 schedules (7 EventBridge rules, 3 Scheduler schedules) send the deliveries they cannot make there.
 *   Their targets, expressions and retry policies are otherwise unchanged.
 * - FetchCongressMembersList, GenerateWeeklyDigests and CleanupOrphanedUsers record a failed run there
 *   (Lambda async OnFailure on the prod alias), with their retries unchanged: 2, 2 and 0.
 * - Only those three function roles and the three Scheduler roles may send to it.
 */
import { SCHEDULED_JOB_FAILURES_QUEUE_NAME } from '../lib/config/scheduled-jobs-constants';
import { type Json, type SynthesizedAppStack, synthesizeApp } from './helpers/synth-app';
import { DEPLOYMENT_ACCOUNT_ID, DEPLOYMENT_REGION } from '../lib/config/deployment-identity';

const stacks: SynthesizedAppStack[] = synthesizeApp();
const ACCOUNT = DEPLOYMENT_ACCOUNT_ID;
const REGION = DEPLOYMENT_REGION;
const QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:${SCHEDULED_JOB_FAILURES_QUEUE_NAME}`;

interface Found {
  stack: string;
  logicalId: string;
  resource: Json;
}

const resourcesOfType = (type: string): Found[] =>
  stacks.flatMap((stack) =>
    Object.entries((stack.template.Resources ?? {}) as Record<string, Json>)
      .filter(([, resource]) => resource.Type === type)
      .map(([logicalId, resource]) => ({ stack: stack.name, logicalId, resource })),
  );

const stackNamed = (name: string): SynthesizedAppStack => {
  const stack = stacks.find((candidate) => candidate.name === name);
  if (!stack) throw new Error(`No stack named ${name}`);
  return stack;
};

const asArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** The function whose role is `roleLogicalId` in `stack`, or the role's logical ID when no function uses it. */
const roleOwner = (stack: string, roleLogicalId: string): string => {
  const fn = resourcesOfType('AWS::Lambda::Function').find(
    (candidate) => candidate.stack === stack && candidate.resource.Properties?.Role?.['Fn::GetAtt']?.[0] === roleLogicalId,
  );
  return fn ? `fn:${fn.resource.Properties.FunctionName}` : `role:${stack}/${roleLogicalId.replace(/[0-9A-F]{8}$/, '')}`;
};

/** Every identity statement in the app, with the owners of the roles it is attached to. */
const identityStatements = (): Array<{ owners: string[]; statement: Json }> =>
  stacks.flatMap((stack) =>
    Object.entries((stack.template.Resources ?? {}) as Record<string, Json>).flatMap(([logicalId, resource]) => {
      if (resource.Type === 'AWS::IAM::Policy') {
        const owners = asArray<Json>(resource.Properties.Roles).map((role) => roleOwner(stack.name, role.Ref));
        return asArray<Json>(resource.Properties.PolicyDocument.Statement).map((statement) => ({ owners, statement }));
      }
      if (resource.Type === 'AWS::IAM::Role') {
        return asArray<Json>(resource.Properties.Policies).flatMap((policy) =>
          asArray<Json>(policy.PolicyDocument.Statement).map((statement) => ({
            owners: [roleOwner(stack.name, logicalId)],
            statement,
          })),
        );
      }
      return [];
    }),
  );

const sendsToFailureQueue = (statement: Json): boolean =>
  statement.Effect === 'Allow' &&
  asArray<string>(statement.Action).some((action) => action === 'sqs:SendMessage' || action === 'sqs:*') &&
  JSON.stringify(statement.Resource).includes(SCHEDULED_JOB_FAILURES_QUEUE_NAME);

describe('ScheduledJobFailures queue (C1.1)', () => {
  const queues = resourcesOfType('AWS::SQS::Queue').filter(
    ({ resource }) => resource.Properties.QueueName === SCHEDULED_JOB_FAILURES_QUEUE_NAME,
  );

  test('SharedInfraStack owns the one queue: SQS-managed encryption, 14 days, no DLQ of its own', () => {
    expect(queues.map(({ stack }) => stack)).toEqual(['SharedInfraStack']);
    const [{ resource }] = queues;
    expect(resource.Properties).toEqual({
      QueueName: SCHEDULED_JOB_FAILURES_QUEUE_NAME,
      MessageRetentionPeriod: 1209600,
      SqsManagedSseEnabled: true,
      Tags: expect.any(Array),
    });
  });

  test('nothing consumes it: no event source mapping reads it', () => {
    const mappings = resourcesOfType('AWS::Lambda::EventSourceMapping').filter(({ resource }) =>
      JSON.stringify(resource.Properties.EventSourceArn).includes('ScheduledJobFailures'),
    );
    expect(mappings).toEqual([]);
  });

  test('its queue policy has exactly one statement: EventBridge rules of this account may send', () => {
    const [{ logicalId }] = queues;
    const policies = resourcesOfType('AWS::SQS::QueuePolicy').filter(({ resource }) =>
      JSON.stringify(resource.Properties.Queues).includes(logicalId) ||
      JSON.stringify(resource.Properties.Queues).includes('ScheduledJobFailures'),
    );
    expect(policies).toHaveLength(1);
    expect(policies[0].stack).toBe('SharedInfraStack');
    expect(policies[0].resource.Properties.PolicyDocument.Statement).toEqual([
      {
        Sid: 'AllowEventBridgeRuleDeadLetters',
        Effect: 'Allow',
        Principal: { Service: 'events.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: { 'Fn::GetAtt': [logicalId, 'Arn'] },
        Condition: {
          StringEquals: { 'aws:SourceAccount': ACCOUNT },
          ArnLike: { 'aws:SourceArn': `arn:aws:events:${REGION}:${ACCOUNT}:rule/*` },
        },
      },
    ]);
  });

  test('the other stacks name it by its fixed ARN, with no export or import', () => {
    expect(JSON.stringify(stackNamed('SharedInfraStack').template.Outputs ?? {})).not.toContain('ScheduledJobFailures');
    stacks.forEach((stack) => {
      const imports = [...JSON.stringify(stack.template).matchAll(/"Fn::ImportValue":"([^"]+)"/g)].map((match) => match[1]);
      expect({ stack: stack.name, imports: imports.filter((name) => name.includes('ScheduledJobFailures')) }).toEqual({
        stack: stack.name,
        imports: [],
      });
    });
  });
});

describe('every schedule has a dead-letter queue (C1.1)', () => {
  const rules = resourcesOfType('AWS::Events::Rule');
  const schedules = resourcesOfType('AWS::Scheduler::Schedule');

  // CB-07 added SignUpFilterCheckSchedule (always ENABLED; its switch decides whether a run does anything).
  test('the app has exactly 7 EventBridge rules and 3 Scheduler schedules', () => {
    expect(rules.map(({ stack, logicalId }) => `${stack}/${logicalId.replace(/[0-9A-F]{8}$/, '')}`).sort()).toEqual([
      'CongressIntegrationServiceStack/BillsApiPollerSchedule',
      'CongressIntegrationServiceStack/CongressMembersChangeoverSchedule',
      'CongressIntegrationServiceStack/CongressMembersSchedule',
      'NotificationServiceStack/NotificationDispatcherSchedule',
      'UserAPIServiceStack/CleanupOrphanedUsersSchedule',
      'UserAPIServiceStack/ExportCognitoUsersSchedule',
      'UserAPIServiceStack/SignUpFilterCheckSchedule',
    ]);
    expect(schedules.map(({ stack, logicalId }) => `${stack}/${logicalId}`).sort()).toEqual([
      'PriorityServiceStack/BillPriorityResolverSchedule',
      'UserAPIServiceStack/PublishBillsManifestSchedule',
      'UserAPIServiceStack/WeeklyDigestGenerationSchedule',
    ]);
  });

  test('every rule target sends what it cannot deliver to ScheduledJobFailures, with retries unchanged', () => {
    rules.forEach(({ stack, logicalId, resource }) => {
      const targets = asArray<Json>(resource.Properties.Targets);
      expect({ rule: `${stack}/${logicalId}`, targets: targets.length }).toEqual({ rule: `${stack}/${logicalId}`, targets: 1 });
      targets.forEach((target) => {
        expect({ rule: logicalId, deadLetter: target.DeadLetterConfig }).toEqual({
          rule: logicalId,
          deadLetter: { Arn: QUEUE_ARN },
        });
        // EventBridge's default retry policy, as before.
        expect({ rule: logicalId, retry: target.RetryPolicy }).toEqual({ rule: logicalId, retry: undefined });
        // Still the prod alias.
        expect(JSON.stringify(target.Arn)).toMatch(/ProdAlias/);
      });
      expect(resource.Properties.State).toBe('ENABLED');
    });
  });

  test('the rule schedules are unchanged', () => {
    const expressionOf = (prefix: string) =>
      rules.find(({ logicalId }) => logicalId.startsWith(prefix))?.resource.Properties.ScheduleExpression;
    expect(expressionOf('BillsApiPollerSchedule')).toBe('rate(5 minutes)');
    expect(expressionOf('CongressMembersSchedule')).toBe('rate(7 days)');
    // REL-46: daily at 22:00 UTC (17:00 EST) from 2027-01-02 to 2027-01-17; the year field ends it.
    expect(expressionOf('CongressMembersChangeoverSchedule')).toBe('cron(0 22 2-17 1 ? 2027)');
    expect(expressionOf('NotificationDispatcherSchedule')).toBe('rate(5 minutes)');
    expect(expressionOf('CleanupOrphanedUsersSchedule')).toBe('rate(1 day)');
    expect(expressionOf('ExportCognitoUsersSchedule')).toBe('cron(0 8 * * ? *)');
    // CB-07: daily at 11:30 UTC, 3.5 hours after the Cognito export.
    expect(expressionOf('SignUpFilterCheckSchedule')).toBe('cron(30 11 * * ? *)');
  });

  test('every Scheduler schedule has the DLQ, its role may send to it, and its retry policy is unchanged', () => {
    const statements = identityStatements();
    schedules.forEach(({ stack, logicalId, resource }) => {
      const target = resource.Properties.Target;
      expect({ schedule: logicalId, deadLetter: target.DeadLetterConfig }).toEqual({
        schedule: logicalId,
        deadLetter: { Arn: QUEUE_ARN },
      });
      expect(resource.Properties.State).toBe('ENABLED');
      expect(JSON.stringify(target.Arn)).toMatch(/ProdAlias/);

      // Scheduler writes dead letters with the schedule's own role.
      const roleOwnerName = roleOwner(stack, target.RoleArn['Fn::GetAtt'][0]);
      const roleSends = statements.filter(
        ({ owners, statement }) => owners.includes(roleOwnerName) && sendsToFailureQueue(statement),
      );
      expect({ schedule: logicalId, grants: roleSends.length }).toEqual({ schedule: logicalId, grants: 1 });
      expect(roleSends[0].statement.Resource).toBe(QUEUE_ARN);
    });

    const retryOf = (name: string) =>
      schedules.find(({ logicalId }) => logicalId === name)?.resource.Properties.Target.RetryPolicy;
    expect(retryOf('BillPriorityResolverSchedule')).toBeUndefined();
    expect(retryOf('WeeklyDigestGenerationSchedule')).toBeUndefined();
    expect(retryOf('PublishBillsManifestSchedule')).toEqual({ MaximumEventAgeInSeconds: 540, MaximumRetryAttempts: 2 });
  });

  test('every stack with a schedule deploys after SharedInfraStack, which creates the queue and its policy', () => {
    const scheduleStacks = [...new Set([...rules, ...schedules].map(({ stack }) => stack))].sort();
    expect(scheduleStacks).toEqual([
      'CongressIntegrationServiceStack',
      'NotificationServiceStack',
      'PriorityServiceStack',
      'UserAPIServiceStack',
    ]);
    scheduleStacks.forEach((name) =>
      expect({ stack: name, dependsOnShared: stackNamed(name).dependencies.includes('SharedInfraStack') }).toEqual({
        stack: name,
        dependsOnShared: true,
      }),
    );
  });
});

describe('failure destinations on the prod alias (C1.1)', () => {
  const invokeConfigs = resourcesOfType('AWS::Lambda::EventInvokeConfig').map(({ stack, resource }) => {
    const functionId = resource.Properties.FunctionName.Ref as string;
    const fn = stackNamed(stack).template.Resources[functionId];
    return { stack, functionName: fn.Properties.FunctionName as string, properties: resource.Properties as Json };
  });
  const configOf = (functionName: string): Json | undefined =>
    invokeConfigs.find((config) => config.functionName === functionName)?.properties;

  test.each([
    ['FetchCongressMembersList', 2],
    ['GenerateWeeklyDigests', 2],
    ['CleanupOrphanedUsers', 0],
  ])('%s records a failed run after %d retries', (functionName, retries) => {
    const config = configOf(functionName);
    expect(config).toEqual({
      FunctionName: expect.anything(),
      Qualifier: expect.anything(),
      MaximumRetryAttempts: retries,
      DestinationConfig: { OnFailure: { Destination: QUEUE_ARN } },
    });
    // The prod alias's name, taken from its ARN.
    expect(config!.Qualifier).toEqual({
      'Fn::Select': [7, { 'Fn::Split': [':', { Ref: expect.stringMatching(new RegExp(`^${functionName}ProdAlias`)) }] }],
    });
  });

  test('the jobs whose next run is the rerun get no destination, with their retries unchanged', () => {
    expect(configOf('ExportCognitoUsers')).toEqual(expect.objectContaining({ MaximumRetryAttempts: 2 }));
    expect(configOf('PublishBillsManifest')).toEqual(expect.objectContaining({ MaximumRetryAttempts: 0 }));
    // CB-07: never retried (a retry would sign up again and send more email); its metrics report a failed run.
    expect(configOf('SignUpFilterCheck')).toEqual(expect.objectContaining({ MaximumRetryAttempts: 0 }));
    ['ExportCognitoUsers', 'PublishBillsManifest', 'SignUpFilterCheck'].forEach((functionName) =>
      expect({ functionName, destination: configOf(functionName)?.DestinationConfig }).toEqual({
        functionName,
        destination: undefined,
      }),
    );
    ['BillsApiPoller', 'NotificationDispatcher', 'BillPriorityResolver'].forEach((functionName) =>
      expect({ functionName, config: configOf(functionName) }).toEqual({ functionName, config: undefined }),
    );
    expect(invokeConfigs.map((config) => config.functionName).sort()).toEqual([
      'CleanupOrphanedUsers',
      'ExportCognitoUsers',
      'FetchCongressMembersList',
      'GenerateWeeklyDigests',
      'PublishBillsManifest',
      'SignUpFilterCheck',
    ]);
  });

  test('only the three destination functions and the three Scheduler roles may send to the queue', () => {
    const senders = [
      ...new Set(identityStatements().filter(({ statement }) => sendsToFailureQueue(statement)).flatMap(({ owners }) => owners)),
    ].sort();
    expect(senders).toEqual([
      'fn:CleanupOrphanedUsers',
      'fn:FetchCongressMembersList',
      'fn:GenerateWeeklyDigests',
      'role:PriorityServiceStack/BillPriorityResolverSchedulerRole',
      'role:UserAPIServiceStack/PublishBillsManifestSchedulerRole',
      'role:UserAPIServiceStack/WeeklyDigestSchedulerRole',
    ]);
  });
});
