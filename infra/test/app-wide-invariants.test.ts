/**
 * Checks across every stack of the real app (bin/billboard-infra.ts, synthesized the way `cdk synth`
 * runs it):
 *
 * - Infra review item 4 with REL-38: every dead-letter queue keeps messages 14 days, and every work
 *   queue's receive count before its DLQ is pinned (REL-38 moved four of them off the batch-size
 *   constants without changing a value). ScheduledJobFailures (C1.1) counts as a DLQ: it holds the
 *   scheduled jobs' dead letters and failure records, though its name does not end in DLQ.
 * - Infra review item 5c: every queue, function, table, canary and API an alarm names exists in some
 *   synthesized stack. The MONITORED_* lists name their targets by string, so a missing or renamed
 *   resource leaves an alarm that can never fire (four manifest-queue alarms were blind in production
 *   until the manifest queues got fixed names).
 * - The account-integrity switches (integration plan section 6): every one reaches the deployed app as
 *   abuse-limits.ts sets it (that file's test pins the positions), across UserAPIServiceStack and
 *   CongressIntegrationServiceStack.
 * - REL-54 step 1: EmailStack's SES records and the domain's DMARC record (p=none) go into billboard-project.com's
 *   existing zone under new names only, and every existing record of the domain (Microsoft 365 mail included) stays as
 *   ShareSiteStack writes it.
 * - REL-54 step 2: the user pool sends through EmailStack's identity (DEVELOPER) with the project's sender and copy,
 *   names the identity and the configuration set without an export, and is updated in place: its logical id and
 *   every property but the four email ones are main's (test/fixtures/user-pool/main-717d67f.json).
 */
import {
  BILLS_DIFFER_QUEUE_BATCH_SIZE,
  BILLS_DIFFER_QUEUE_MAX_RECEIVE_COUNT,
  CONGRESS_MEMBERS_SUMMARIZER_QUEUE_BATCH_SIZE,
  CONGRESS_MEMBERS_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT,
  INGEST_DLQ_RETENTION_DAYS,
  UPDATED_CONGRESS_MEMBERS_QUEUE_MAX_RECEIVE_COUNT,
} from '../lib/config/congress-integration-service-constants';
import {
  BILL_SUMMARIZER_QUEUE_BATCH_SIZE,
  BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT,
} from '../lib/config/summarizer-service-constants';
import {
  APNS_PLATFORM_APPLICATION_NAME,
  BACKFILL_PUSH_MODE,
  PENDING_NOTIFICATIONS_TABLE_NAME,
} from '../lib/config/notification-service-constants';
import { SCHEDULED_JOB_FAILURES_QUEUE_NAME } from '../lib/config/scheduled-jobs-constants';
import {
  PRE_SIGN_UP_TRIGGER_ENABLED,
  SIGNUP_FILTER_CHECK_ENABLED,
  SIGNUP_FILTER_MODE,
  SIGNUP_RATE_LIMIT_ACTION,
  VERIFICATION_LIMITS_MODE,
  VOTE_DAILY_CAP_MODE,
  VOTE_RESTAMP_MODE,
} from '../lib/config/abuse-limits';
import { MEMBER_VOTE_CARRY_MODE } from '../lib/stacks/congress-integration-service';
import {
  MONITORED_DLQ_NAMES,
  MONITORED_LAMBDA_NAMES,
  MONITORED_WORK_QUEUE_NAMES,
  QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_OVERRIDES_SECONDS,
  THROTTLE_MONITORED_LAMBDA_NAMES,
} from '../lib/stacks/monitoring';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Json, type SynthesizedAppStack, synthesizeApp, synthesizedAppManifest } from './helpers/synth-app';
import { DEPLOYMENT_ACCOUNT_ID, DEPLOYMENT_REGION, HOSTED_ZONE_ID } from '../lib/config/deployment-identity';

const stacks: SynthesizedAppStack[] = synthesizeApp();

const resourcesOfType = (type: string): Array<{ stack: string; logicalId: string; properties: Json }> =>
  stacks.flatMap((stack) =>
    Object.entries((stack.template.Resources ?? {}) as Record<string, Json>)
      .filter(([, resource]) => resource.Type === type)
      .map(([logicalId, resource]) => ({ stack: stack.name, logicalId, properties: resource.Properties ?? {} })),
  );

const queues = resourcesOfType('AWS::SQS::Queue');
const queueByName = new Map(queues.map((queue) => [queue.properties.QueueName as string, queue]));

const FOURTEEN_DAYS_SECONDS = 14 * 24 * 60 * 60;

/** A queue that holds failed messages for someone to read: every *DLQ, and ScheduledJobFailures. */
const isDeadLetterQueue = (queueName: string | undefined): boolean =>
  /DLQ$/.test(queueName ?? '') || queueName === SCHEDULED_JOB_FAILURES_QUEUE_NAME;

describe('dead-letter queues (infra review item 4, REL-38)', () => {
  // The six that kept the SQS default of 4 days before item 4.
  const INGEST_DLQS = [
    'UpdatedBillsDLQ',
    'BillVoteEnrichmentDLQ',
    'BillDifferDLQ',
    'CongressMemberSummarizerDLQ',
    'UpdatedCongressMembersDLQ',
    'BillSummarizerDLQ',
  ];

  test('the ingest DLQs keep failed messages 14 days', () => {
    expect(INGEST_DLQ_RETENTION_DAYS).toBe(14);
    INGEST_DLQS.forEach((name) => {
      expect({ name, retention: queueByName.get(name)?.properties.MessageRetentionPeriod }).toEqual({
        name,
        retention: FOURTEEN_DAYS_SECONDS,
      });
    });
  });

  test('every DLQ in the app is alarmed and keeps messages 14 days', () => {
    const dlqs = queues.filter((queue) => isDeadLetterQueue(queue.properties.QueueName));
    expect(dlqs.map((queue) => queue.properties.QueueName)).toContain(SCHEDULED_JOB_FAILURES_QUEUE_NAME);
    expect(dlqs.map((queue) => queue.properties.QueueName).sort()).toEqual([...MONITORED_DLQ_NAMES].sort());
    dlqs.forEach(({ properties }) => {
      expect({ name: properties.QueueName, retention: properties.MessageRetentionPeriod }).toEqual({
        name: properties.QueueName,
        retention: FOURTEEN_DAYS_SECONDS,
      });
    });
  });

  test('retention changed on DLQs only: no work queue sets a retention other than the manifest queues\' 4 days', () => {
    queues
      .filter((queue) => !isDeadLetterQueue(queue.properties.QueueName))
      .forEach(({ properties }) => {
        const expected = ['BillsManifestQueue', 'CongressMembersManifestQueue'].includes(properties.QueueName)
          ? 4 * 24 * 60 * 60
          : undefined;
        expect({ name: properties.QueueName, retention: properties.MessageRetentionPeriod }).toEqual({
          name: properties.QueueName,
          retention: expected,
        });
      });
  });

  test('receives before the DLQ are unchanged on every work queue', () => {
    // The values the queues had before REL-38; the synthesized RedrivePolicy must not move. REL-58 raised
    // UpdatedBillsQueue's from 3 to 11 on purpose: FetchRawBill's retry ladder (docs/RUNBOOK.md 6.5).
    const expected: Record<string, number> = {
      UpdatedBillsQueue: 11,
      BillVoteEnrichmentQueue: 5,
      BillDifferQueue: 5,
      UpdatedCongressMembersQueue: 5,
      CongressMemberSummarizerQueue: 5,
      BillSummarizerQueue: 5,
      NotificationTypeQueue: 5,
      CongressMemberStatsQueue: 5,
      userMatcherQueue: 5,
      notificationFanoutQueue: 5,
      userNotifierQueue: 5,
      WeeklyDigestQueue: 3,
      BillsManifestQueue: 5,
      CongressMembersManifestQueue: 5,
      // A re-stamp is idempotent, so 5 receives before RestampUserVotesDLQ.
      RestampUserVotesQueue: 5,
    };
    const workQueues = queues.filter((queue) => queue.properties.RedrivePolicy);
    expect(workQueues.map((queue) => queue.properties.QueueName).sort()).toEqual(Object.keys(expected).sort());
    workQueues.forEach(({ properties }) => {
      expect({ name: properties.QueueName, maxReceiveCount: properties.RedrivePolicy.maxReceiveCount }).toEqual({
        name: properties.QueueName,
        maxReceiveCount: expected[properties.QueueName],
      });
    });
  });

  test('REL-38: the four receive counts are their own constants, equal to the old batch-size values', () => {
    expect(BILLS_DIFFER_QUEUE_MAX_RECEIVE_COUNT).toBe(5);
    expect(BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT).toBe(5);
    expect(CONGRESS_MEMBERS_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT).toBe(5);
    expect(UPDATED_CONGRESS_MEMBERS_QUEUE_MAX_RECEIVE_COUNT).toBe(5);
    // A batch-of-5 consumer needs at least 5 receives: a timeout charges one to every record of the batch.
    expect(BILLS_DIFFER_QUEUE_MAX_RECEIVE_COUNT).toBeGreaterThanOrEqual(BILLS_DIFFER_QUEUE_BATCH_SIZE);
    expect(BILL_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT).toBeGreaterThanOrEqual(BILL_SUMMARIZER_QUEUE_BATCH_SIZE);
    expect(CONGRESS_MEMBERS_SUMMARIZER_QUEUE_MAX_RECEIVE_COUNT).toBeGreaterThanOrEqual(
      CONGRESS_MEMBERS_SUMMARIZER_QUEUE_BATCH_SIZE,
    );
  });
});

/** Every literal value an alarm's metric dimensions give for `dimension`, across the whole app. */
const alarmDimensionValues = (dimension: string): Array<{ stack: string; alarm: string; value: string }> =>
  resourcesOfType('AWS::CloudWatch::Alarm').flatMap(({ stack, logicalId, properties }) => {
    const dimensionLists: Json[][] = [
      properties.Dimensions ?? [],
      ...((properties.Metrics ?? []) as Json[]).map((metric) => metric.MetricStat?.Metric?.Dimensions ?? []),
    ];
    return dimensionLists
      .flat()
      .filter((entry) => entry.Name === dimension && typeof entry.Value === 'string')
      .map((entry) => ({ stack, alarm: logicalId, value: entry.Value as string }));
  });

/** Table names named in Metrics Insights alarm queries (`... WHERE TableName = '<name>'`). */
const alarmQueryTableNames = (): Array<{ stack: string; alarm: string; value: string }> =>
  resourcesOfType('AWS::CloudWatch::Alarm').flatMap(({ stack, logicalId, properties }) =>
    ((properties.Metrics ?? []) as Json[])
      .map((metric) => metric.Expression)
      .filter((expression): expression is string => typeof expression === 'string')
      .flatMap((expression) => [...expression.matchAll(/TableName\s*=\s*'([^']+)'/g)].map((match) => match[1]))
      .map((value) => ({ stack, alarm: logicalId, value })),
  );

const namesOf = (type: string, property: string): Set<string> =>
  new Set(
    resourcesOfType(type)
      .map((resource) => resource.properties[property])
      .filter((value): value is string => typeof value === 'string'),
  );

/** The entries whose value is not in `existing`, so a failure lists exactly what is missing. */
const missingFrom = <T extends { value: string }>(entries: T[], existing: Set<string>): T[] =>
  entries.filter((entry) => !existing.has(entry.value));

describe('every alarmed name exists in a synthesized stack (infra review item 5c)', () => {
  const functionNames = namesOf('AWS::Lambda::Function', 'FunctionName');
  const queueNames = namesOf('AWS::SQS::Queue', 'QueueName');
  const tableNames = namesOf('AWS::DynamoDB::Table', 'TableName');
  const canaryNames = namesOf('AWS::Synthetics::Canary', 'Name');
  const apiNames = namesOf('AWS::ApiGateway::RestApi', 'Name');
  const asEntries = (list: readonly string[], source: string) => list.map((value) => ({ source, value }));

  test('the helper reports names that do not exist', () => {
    expect(missingFrom([{ value: 'NoSuchQueue' }, { value: 'BillDifferQueue' }], queueNames)).toEqual([
      { value: 'NoSuchQueue' },
    ]);
  });

  test('every MONITORED_* function exists', () => {
    expect(missingFrom(asEntries(MONITORED_LAMBDA_NAMES, 'MONITORED_LAMBDA_NAMES'), functionNames)).toEqual([]);
    expect(
      missingFrom(asEntries(THROTTLE_MONITORED_LAMBDA_NAMES, 'THROTTLE_MONITORED_LAMBDA_NAMES'), functionNames),
    ).toEqual([]);
  });

  test('every MONITORED_* queue and DLQ exists', () => {
    expect(missingFrom(asEntries(MONITORED_WORK_QUEUE_NAMES, 'MONITORED_WORK_QUEUE_NAMES'), queueNames)).toEqual([]);
    expect(missingFrom(asEntries(MONITORED_DLQ_NAMES, 'MONITORED_DLQ_NAMES'), queueNames)).toEqual([]);
    expect(
      missingFrom(
        asEntries(Object.keys(QUEUE_OLDEST_MESSAGE_AGE_THRESHOLD_OVERRIDES_SECONDS), 'age overrides'),
        queueNames,
      ),
    ).toEqual([]);
  });

  // C1.4 removed the per-table SystemErrors alarms and their MONITORED_TABLE_NAMES list. The one table
  // alarm left (PendingNotifications write throttles) is checked with every other alarm below.
  test('the table named by the remaining DynamoDB alarm exists', () => {
    expect(missingFrom([{ value: PENDING_NOTIFICATIONS_TABLE_NAME }], tableNames)).toEqual([]);
  });

  test('every alarm in every stack names an existing function, queue, table, canary and API', () => {
    const functionDimensions = alarmDimensionValues('FunctionName');
    const queueDimensions = alarmDimensionValues('QueueName');
    const tableDimensions = [...alarmDimensionValues('TableName'), ...alarmQueryTableNames()];
    // The lists above feed these alarms, so each kind must actually be found.
    expect(functionDimensions.length).toBeGreaterThanOrEqual(MONITORED_LAMBDA_NAMES.length);
    expect(queueDimensions.length).toBeGreaterThanOrEqual(MONITORED_DLQ_NAMES.length);
    expect(tableDimensions.map((entry) => entry.value)).toContain(PENDING_NOTIFICATIONS_TABLE_NAME);

    expect(missingFrom(functionDimensions, functionNames)).toEqual([]);
    expect(missingFrom(queueDimensions, queueNames)).toEqual([]);
    expect(missingFrom(tableDimensions, tableNames)).toEqual([]);
    expect(missingFrom(alarmDimensionValues('CanaryName'), canaryNames)).toEqual([]);
    expect(missingFrom(alarmDimensionValues('ApiName'), apiNames)).toEqual([]);
    // A per-alias alarm's Resource dimension is "<function>:prod" when it is written out literally.
    const aliasResources = alarmDimensionValues('Resource').map((entry) => ({
      ...entry,
      value: entry.value.replace(/:prod$/, ''),
    }));
    expect(missingFrom(aliasResources, functionNames)).toEqual([]);
  });

  test('the SNS platform application the APNs alarms watch is the one the notification stack manages', () => {
    const applications = alarmDimensionValues('Application');
    expect(applications.map((entry) => entry.value)).toContain(APNS_PLATFORM_APPLICATION_NAME);
    const notificationTemplate = JSON.stringify(
      stacks.find((stack) => stack.name === 'NotificationServiceStack')?.template ?? {},
    );
    applications.forEach((entry) => expect(notificationTemplate).toContain(`"${entry.value}"`));
  });
});

describe('the account-integrity switches reach the deployed app as their constants say', () => {
  const functionEnvironment = (functionName: string): Json => {
    const matches = resourcesOfType('AWS::Lambda::Function').filter((fn) => fn.properties.FunctionName === functionName);
    expect(matches).toHaveLength(1);
    return matches[0].properties.Environment?.Variables ?? {};
  };

  test.each([
    ['SetFeedback', 'VOTE_DAILY_CAP_MODE', VOTE_DAILY_CAP_MODE],
    ['DistrictVerification', 'VERIFICATION_LIMITS_MODE', VERIFICATION_LIMITS_MODE],
    ['RestampUserVotes', 'VOTE_RESTAMP_MODE', VOTE_RESTAMP_MODE],
    ['PreSignUpCheck', 'SIGNUP_FILTER_MODE', SIGNUP_FILTER_MODE],
    ['FetchRawBill', 'MEMBER_VOTE_CARRY_MODE', 'on'],
    ['NotificationType', 'BACKFILL_PUSH_MODE', 'skip'],
  ])('%s runs with %s=%s', (functionName, variable, value) => {
    expect(functionEnvironment(functionName)[variable]).toBe(value);
  });

  test('MEMBER_VOTE_CARRY_MODE (REL-35, X7) is the constant FetchRawBill gets, and only FetchRawBill', () => {
    expect(MEMBER_VOTE_CARRY_MODE).toBe('on');
    const holders = resourcesOfType('AWS::Lambda::Function')
      .filter((fn) => 'MEMBER_VOTE_CARRY_MODE' in (fn.properties.Environment?.Variables ?? {}))
      .map((fn) => fn.properties.FunctionName);
    expect(holders).toEqual(['FetchRawBill']);
  });

  // REL-56 (RUNBOOK 16.1): refetch:stale-bills --unattended refuses unless NotificationType:prod reads 'skip'.
  test('BACKFILL_PUSH_MODE (REL-56) is the constant NotificationType gets, and only NotificationType', () => {
    expect(BACKFILL_PUSH_MODE).toBe('skip');
    const holders = resourcesOfType('AWS::Lambda::Function')
      .filter((fn) => 'BACKFILL_PUSH_MODE' in (fn.properties.Environment?.Variables ?? {}))
      .map((fn) => fn.properties.FunctionName);
    expect(holders).toEqual(['NotificationType']);
  });

  test('each mode variable is set on exactly its one function', () => {
    ['VOTE_DAILY_CAP_MODE', 'VERIFICATION_LIMITS_MODE', 'VOTE_RESTAMP_MODE', 'SIGNUP_FILTER_MODE'].forEach((variable) => {
      const holders = resourcesOfType('AWS::Lambda::Function')
        .filter((fn) => variable in (fn.properties.Environment?.Variables ?? {}))
        .map((fn) => fn.properties.FunctionName);
      expect({ variable, holders: holders.length }).toEqual({ variable, holders: 1 });
    });
  });

  test('the sign-up rule follows SIGNUP_RATE_LIMIT_ACTION, and the API rule always blocks', () => {
    const [acl] = resourcesOfType('AWS::WAFv2::WebACL').filter(({ stack }) => stack === 'UserAPIServiceStack');
    expect(Object.fromEntries((acl.properties.Rules as Json[]).map((rule) => [rule.Name, rule.Action]))).toEqual({
      UserApiRateLimitRule: { Block: {} },
      CognitoSignUpRateLimit: SIGNUP_RATE_LIMIT_ACTION === 'block' ? { Block: {} } : { Count: {} },
    });
  });

  test('the deployed pool has the PreSignUp trigger, and nothing else, exactly when PRE_SIGN_UP_TRIGGER_ENABLED', () => {
    const [pool] = resourcesOfType('AWS::Cognito::UserPool');
    expect(Object.keys(pool.properties.LambdaConfig ?? {})).toEqual(PRE_SIGN_UP_TRIGGER_ENABLED ? ['PreSignUp'] : []);
    if (PRE_SIGN_UP_TRIGGER_ENABLED) {
      expect(JSON.stringify(pool.properties.LambdaConfig)).toMatch(/PreSignUpCheckProdAlias/);
    }
  });

  // CB-07: the sign-up filter check follows its switch, both functions agree on the address and the mode, and the
  // check can never run while sign-up attestation is enforced (its sign-ups are unattested, like an old build's).
  describe('the sign-up filter check (CB-07)', () => {
    const checkEnvironment = () => functionEnvironment('SignUpFilterCheck');
    const filterEnvironment = () => functionEnvironment('PreSignUpCheck');

    test('SignUpFilterCheck runs with SIGNUP_FILTER_CHECK_ENABLED as abuse-limits.ts sets it', () => {
      expect(checkEnvironment().SIGNUP_FILTER_CHECK_ENABLED).toBe(SIGNUP_FILTER_CHECK_ENABLED);
    });

    // REL-53: CleanupOrphanedUsers gets it too, to keep the probes out of its unconfirmed sign-up step.
    test('exactly PreSignUpCheck, SignUpFilterCheck and CleanupOrphanedUsers get SIGNUP_FILTER_CHECK_ADDRESS, the same project-domain address', () => {
      const holders = resourcesOfType('AWS::Lambda::Function').filter(
        (fn) => 'SIGNUP_FILTER_CHECK_ADDRESS' in (fn.properties.Environment?.Variables ?? {}),
      );
      expect(holders.map((fn) => fn.properties.FunctionName).sort()).toEqual([
        'CleanupOrphanedUsers',
        'PreSignUpCheck',
        'SignUpFilterCheck',
      ]);
      const address = checkEnvironment().SIGNUP_FILTER_CHECK_ADDRESS as string;
      expect(filterEnvironment().SIGNUP_FILTER_CHECK_ADDRESS).toBe(address);
      const cleanup = holders.find((fn) => fn.properties.FunctionName === 'CleanupOrphanedUsers')!;
      expect(cleanup.properties.Environment.Variables.SIGNUP_FILTER_CHECK_ADDRESS).toBe(address);
      expect(address).toBe(address.toLowerCase());
      expect(address).not.toContain('+');
      expect(address).toMatch(/^[a-z0-9._-]+@billboard-project\.com$/);
    });

    test("the check expects the filter's own mode", () => {
      expect(checkEnvironment().SIGNUP_FILTER_CHECK_EXPECTED_MODE).toBe(filterEnvironment().SIGNUP_FILTER_MODE);
    });

    test('the check is never on while App Attest or DeviceCheck enforces sign-ups (turn it off first)', () => {
      const state = {
        enabled: checkEnvironment().SIGNUP_FILTER_CHECK_ENABLED,
        appAttest: filterEnvironment().APP_ATTEST_MODE,
        deviceCheck: filterEnvironment().DEVICE_CHECK_MODE,
      };
      const conflict = state.enabled === 'true' && (state.appAttest === 'enforce' || state.deviceCheck === 'enforce');
      expect({ ...state, conflict }).toEqual({ ...state, conflict: false });
    });

    test('it needs no salt, and its one secret is the probe token, which the filter reads too (INF-15)', () => {
      expect(checkEnvironment().HASH_SALT_SECRET_ARN).toBeUndefined();
      const secretVariables = (environment: Record<string, unknown>) =>
        Object.keys(environment).filter((name) => /secret/i.test(name) || /secret/i.test(JSON.stringify(environment[name])));
      expect(secretVariables(checkEnvironment())).toEqual(['SIGNUP_PROBE_TOKEN_SECRET_ARN']);
      expect(checkEnvironment().SIGNUP_PROBE_TOKEN_SECRET_ARN).toEqual(filterEnvironment().SIGNUP_PROBE_TOKEN_SECRET_ARN);
      const [secret] = resourcesOfType('AWS::SecretsManager::Secret')
        .filter(({ logicalId }) => (checkEnvironment().SIGNUP_PROBE_TOKEN_SECRET_ARN as { Ref?: string }).Ref === logicalId);
      expect(secret.properties).toMatchObject({
        Name: 'Billboard/SignUpProbeToken',
        GenerateSecretString: { ExcludePunctuation: true, PasswordLength: 48 },
      });
    });
  });

  // Question Q2 (decision 3A): an IP mismatch is a flag only and the IP lookup stays off, so no function sets
  // IP_LOOKUP_ENABLED and every INT-02 check stays "unknown".
  test('nothing turns on the IP lookup', () => {
    resourcesOfType('AWS::Lambda::Function').forEach((fn) =>
      expect({ fn: fn.properties.FunctionName, ip: fn.properties.Environment?.Variables?.IP_LOOKUP_ENABLED })
        .toEqual({ fn: fn.properties.FunctionName, ip: undefined }));
  });
});

// FN-4 (UA-15): the hash salt reaches a function only as the ARN of its secret. The handlers read it at their
// first use in a container; no function's configuration (or any published version of it) holds the value.
describe('the hash salt stays out of every function configuration (FN-4, UA-15)', () => {
  const saltSecretIds = resourcesOfType('AWS::SecretsManager::Secret')
    .filter(({ properties }) => properties.Name === 'Billboard/DistrictVerificationHashSalt')
    .map(({ logicalId }) => logicalId);

  test('the salt secret exists once', () => {
    expect(saltSecretIds).toHaveLength(1);
  });

  test('no function has a HASH_SALT variable, and none holds a resolved reference to a secret', () => {
    resourcesOfType('AWS::Lambda::Function').forEach((fn) => {
      const variables = fn.properties.Environment?.Variables ?? {};
      expect({ fn: fn.properties.FunctionName, hasHashSalt: 'HASH_SALT' in variables })
        .toEqual({ fn: fn.properties.FunctionName, hasHashSalt: false });
      expect({ fn: fn.properties.FunctionName, resolves: JSON.stringify(variables).includes('resolve:secretsmanager') })
        .toEqual({ fn: fn.properties.FunctionName, resolves: false });
    });
  });

  test('exactly DistrictVerification and PreSignUpCheck get HASH_SALT_SECRET_ARN, and it is the salt secret', () => {
    const holders = resourcesOfType('AWS::Lambda::Function').filter(
      (fn) => 'HASH_SALT_SECRET_ARN' in (fn.properties.Environment?.Variables ?? {}),
    );
    expect(holders.map((fn) => fn.properties.FunctionName).sort()).toEqual(['DistrictVerification', 'PreSignUpCheck']);
    holders.forEach((fn) =>
      expect(fn.properties.Environment.Variables.HASH_SALT_SECRET_ARN).toEqual({ Ref: saltSecretIds[0] }));
  });
});

// UA-04: the logged-in canary signs in with the project's test account, read from the secret made by hand.
// The name is the cdk.json context userApiSmokeTestSecretName; the construct's own cases are in
// user-api-canary.test.ts.
describe('the canary reads its test account from Billboard/CanarySmokeTestCredentials (UA-04)', () => {
  const SECRET_NAME = 'Billboard/CanarySmokeTestCredentials';
  const [canary] = resourcesOfType('AWS::Synthetics::Canary');
  const canaryRoleId: string = canary.properties.ExecutionRoleArn['Fn::GetAtt'][0];
  const roleStatements = (): Json[] => {
    const role = resourcesOfType('AWS::IAM::Role').find(({ logicalId }) => logicalId === canaryRoleId)!;
    const inline = ((role.properties.Policies ?? []) as Json[]).flatMap((policy) => policy.PolicyDocument.Statement);
    const attached = resourcesOfType('AWS::IAM::Policy')
      .filter(({ properties }) => JSON.stringify(properties.Roles).includes(canaryRoleId))
      .flatMap(({ properties }) => properties.PolicyDocument.Statement as Json[]);
    return [...inline, ...attached];
  };

  test('the canary is told the secret name, with no fixtures secret and the write checks off', () => {
    expect(canary.properties.RunConfig.EnvironmentVariables).toMatchObject({
      SMOKE_TEST_SECRET_NAME: SECRET_NAME,
      SMOKE_TEST_FIXTURES_SECRET_NAME: '',
      SMOKE_TEST_WRITE_CHECKS: 'false',
    });
  });

  test('its role may call GetSecretValue on that one secret and nothing else in Secrets Manager', () => {
    const secretStatements = roleStatements().filter((statement) =>
      JSON.stringify(statement.Action).includes('secretsmanager:'));
    expect(secretStatements).toHaveLength(1);
    const [statement] = secretStatements;
    expect(statement).toMatchObject({ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue' });
    expect(Array.isArray(statement.Resource)).toBe(false);
    const arn = JSON.stringify(statement.Resource);
    expect(arn).toContain(`:secret:${SECRET_NAME}-??????`);
    expect(arn.replace('-??????', '')).not.toMatch(/[*?]/);
  });

  test('no other function may read the canary secret', () => {
    const readers = resourcesOfType('AWS::IAM::Policy')
      .filter(({ properties }) => JSON.stringify(properties.PolicyDocument).includes(SECRET_NAME))
      .map(({ logicalId }) => logicalId);
    expect(readers).toEqual([]);
    const roles = resourcesOfType('AWS::IAM::Role')
      .filter(({ properties }) => JSON.stringify(properties.Policies ?? []).includes(SECRET_NAME))
      .map(({ logicalId }) => logicalId);
    expect(roles).toEqual([canaryRoleId]);
  });
});

// REL-54 step 1 (feature review S13): EmailStack adds the SES identity's records and the domain's DMARC record (project
// decision 2026-10-29, p=none) to billboard-project.com's hosted zone, and nothing else in the domain changes:
// Microsoft 365 mail (the MX, the apex SPF, autodiscover) and contact@billboard-project.com keep working. EmailStack's
// own resources are pinned in email.test.ts.
describe('the SES identity leaves the domain\'s existing records alone (REL-54 step 1)', () => {
  const stackNamed = (name: string): SynthesizedAppStack => {
    const stack = stacks.find((candidate) => candidate.name === name);
    if (!stack) throw new Error(`No stack named ${name}`);
    return stack;
  };
  const recordSets = resourcesOfType('AWS::Route53::RecordSet');
  const recordsIn = (stack: string): Json[] =>
    recordSets.filter((record) => record.stack === stack).map((record) => record.properties);
  const shareSiteZoneIds = new Set(recordsIn('ShareSiteStack').map((record) => record.HostedZoneId));

  test('EmailStack writes into the hosted zone ShareSiteStack uses (HOSTED_ZONE_ID), and only there', () => {
    expect([...shareSiteZoneIds]).toEqual([HOSTED_ZONE_ID]);
    const emailRecords = recordsIn('EmailStack');
    expect(emailRecords).toHaveLength(6);
    emailRecords.forEach((record) => expect(record.HostedZoneId).toBe(HOSTED_ZONE_ID));
  });

  test('its records are the three DKIM CNAMEs, the MX and SPF of bounce.billboard-project.com, and DMARC', () => {
    const emailRecords = recordsIn('EmailStack');
    const [identityId] = resourcesOfType('AWS::SES::EmailIdentity')
      .filter((resource) => resource.stack === 'EmailStack')
      .map((resource) => resource.logicalId);
    expect(emailRecords.filter((record) => record.Type === 'CNAME').map((record) => record.Name)).toEqual(
      [1, 2, 3].map((n) => ({ 'Fn::GetAtt': [identityId, `DkimDNSTokenName${n}`] })),
    );
    expect(
      emailRecords
        .filter((record) => record.Type !== 'CNAME')
        .map((record) => ({ name: record.Name, type: record.Type, values: record.ResourceRecords })),
    ).toEqual([
      { name: 'bounce.billboard-project.com.', type: 'MX', values: [`10 feedback-smtp.${DEPLOYMENT_REGION}.amazonses.com`] },
      { name: 'bounce.billboard-project.com.', type: 'TXT', values: ['"v=spf1 include:amazonses.com -all"'] },
      {
        name: '_dmarc.billboard-project.com.',
        type: 'TXT',
        values: ['"v=DMARC1; p=none; rua=mailto:dmarc@billboard-project.com"'],
      },
    ]);
  });

  // The whole domain, by stack: ShareSiteStack's records as they were before REL-54, and EmailStack's new names. Next
  // to the apex, EmailStack's only new names are bounce. (SES's MAIL FROM) and _dmarc; nothing at the apex is new.
  test("every record of the domain: ShareSiteStack's unchanged, and EmailStack's under new names only", () => {
    const named = recordSets
      .filter((record) => typeof record.properties.Name === 'string')
      .map((record) => `${record.stack} ${record.properties.Name} ${record.properties.Type}`);
    expect(named.sort()).toEqual([
      'EmailStack _dmarc.billboard-project.com. TXT',
      'EmailStack bounce.billboard-project.com. MX',
      'EmailStack bounce.billboard-project.com. TXT',
      'ShareSiteStack autodiscover.billboard-project.com. CNAME',
      'ShareSiteStack billboard-project.com. A',
      'ShareSiteStack billboard-project.com. AAAA',
      'ShareSiteStack billboard-project.com. MX',
      'ShareSiteStack billboard-project.com. TXT',
      'ShareSiteStack share.billboard-project.com. A',
      'ShareSiteStack share.billboard-project.com. AAAA',
    ]);
    // The other three are SES's DKIM CNAMEs, named by the identity's tokens (<token>._domainkey).
    expect(recordSets.filter((record) => typeof record.properties.Name !== 'string')).toHaveLength(3);
    const shareSiteNames = new Set(recordsIn('ShareSiteStack').map((record) => record.Name));
    recordsIn('EmailStack').forEach((record) => expect(shareSiteNames.has(record.Name)).toBe(false));
  });

  test("the domain's mail and verification records are ShareSiteStack's, unchanged", () => {
    const named = (name: string, type: string): Json[] =>
      recordSets
        .filter((record) => record.properties.Name === name && record.properties.Type === type)
        .map((record) => ({ stack: record.stack, values: record.properties.ResourceRecords, ttl: record.properties.TTL }));
    expect(named('billboard-project.com.', 'MX')).toEqual([
      { stack: 'ShareSiteStack', values: ['0 billboardproject-com02c.mail.protection.outlook.com'], ttl: '3600' },
    ]);
    expect(named('billboard-project.com.', 'TXT')).toEqual([
      {
        stack: 'ShareSiteStack',
        values: [
          '"apple-domain-verification=cJDvqnB3YjUcLioN"',
          '"MS=ms56918469"',
          '"v=spf1 include:spf.protection.outlook.com -all"',
        ],
        ttl: '3600',
      },
    ]);
    expect(named('autodiscover.billboard-project.com.', 'CNAME')).toEqual([
      { stack: 'ShareSiteStack', values: ['autodiscover.outlook.com'], ttl: '3600' },
    ]);
  });

  test("no two record sets share a name and type, and EmailStack's p=none is the domain's only DMARC record", () => {
    const keys = recordSets.map((record) =>
      JSON.stringify([record.properties.HostedZoneId, record.properties.Name, record.properties.Type]));
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    // Project decision 2026-10-29: monitoring only; a stricter policy waits for Microsoft 365 DKIM (RUNBOOK 23.6). The
    // report address is in the domain, so no `_report._dmarc` authorization record exists anywhere.
    expect(
      recordSets
        .filter((record) => JSON.stringify(record.properties.Name).toLowerCase().includes('_dmarc'))
        .map((record) => ({ stack: record.stack, ...record.properties })),
    ).toEqual([
      {
        stack: 'EmailStack',
        HostedZoneId: HOSTED_ZONE_ID,
        Name: '_dmarc.billboard-project.com.',
        ResourceRecords: ['"v=DMARC1; p=none; rua=mailto:dmarc@billboard-project.com"'],
        TTL: '1800',
        Type: 'TXT',
      },
    ]);
    expect(recordSets.filter((record) => JSON.stringify(record.properties.Name).includes('_report'))).toEqual([]);
    // The only SPF records: Microsoft 365's at the apex and SES's on the MAIL FROM subdomain.
    const spf = recordSets
      .filter((record) => JSON.stringify(record.properties.ResourceRecords ?? []).includes('v=spf1'))
      .map((record) => `${record.stack} ${record.properties.Name}`);
    expect(spf.sort()).toEqual(['EmailStack bounce.billboard-project.com.', 'ShareSiteStack billboard-project.com.']);
  });

  // Step 2 (RUNBOOK 23.4) makes UserAPIServiceStack depend on EmailStack, for the deploy order only: the pool names the
  // identity by its fixed ARN and the configuration set by name, so EmailStack exports nothing and nothing imports it.
  test('EmailStack depends on nothing, exports nothing, deploys right after SharedInfraStack, and only UserAPIServiceStack depends on it', () => {
    const email = stackNamed('EmailStack');
    expect(email.dependencies).toEqual([]);
    expect(Object.values((email.template.Outputs ?? {}) as Record<string, Json>).filter((output) => output.Export))
      .toEqual([]);
    expect(stacks.filter((stack) => stack.dependencies.includes('EmailStack')).map((stack) => stack.name))
      .toEqual(['UserAPIServiceStack']);
    const imports = stacks.flatMap((stack) =>
      [...JSON.stringify(stack.template).matchAll(/"Fn::ImportValue":"([^"]+)"/g)].map(([, name]) => `${stack.name} ${name}`));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((entry) => entry.includes('EmailStack'))).toEqual([]);
    // The order cdk deploys stacks in: the cloud assembly's, which puts dependencies first.
    const assemblyOrder = Object.entries(
      JSON.parse(synthesizedAppManifest()).artifacts as Record<string, { type: string }>,
    )
      .filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack')
      .map(([id]) => id);
    expect(assemblyOrder.slice(0, 2)).toEqual(['SharedInfraStack', 'EmailStack']);
    expect(assemblyOrder.indexOf('EmailStack')).toBeLessThan(assemblyOrder.indexOf('UserAPIServiceStack'));
  });
});

// REL-54 step 2 (project decision and copy 2026-10-29, RUNBOOK 23.4): Cognito sends every code email through SES on
// EmailStack's identity instead of its default sender, and the pool is updated in place, never replaced (a new pool
// would have none of the accounts). Every property step 2 changes is "Update requires: No interruption" in
// CloudFormation, and the deploy guard (scripts/checkDeployGuard.ts) blocks a replaced pool; these tests keep the
// logical id and everything else about the pool exactly as main synthesized and deployed it.
describe('the user pool sends through SES and is updated in place (REL-54 step 2)', () => {
  const stackNamed = (name: string): SynthesizedAppStack => {
    const stack = stacks.find((candidate) => candidate.name === name);
    if (!stack) throw new Error(`No stack named ${name}`);
    return stack;
  };
  const pools = () => resourcesOfType('AWS::Cognito::UserPool');
  const poolResource = (): Json => {
    const [pool] = pools();
    return stackNamed(pool.stack).template.Resources[pool.logicalId];
  };
  // BillboardUserPool as main synthesized it at 717d67f, the same bytes as the live template (the fixture's comment).
  const MAIN = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'user-pool', 'main-717d67f.json'), 'utf8')) as {
    stack: string;
    logicalId: string;
    resource: Json;
  };
  const STEP2_PROPERTIES = ['EmailConfiguration', 'EmailVerificationMessage', 'EmailVerificationSubject', 'VerificationMessageTemplate'];
  const withoutStep2 = (properties: Json): Json =>
    Object.fromEntries(Object.entries(properties).filter(([name]) => !STEP2_PROPERTIES.includes(name)));

  // A new logical id is the one way this change could replace the pool: no property it touches requires replacement.
  test("the app's one user pool keeps main's stack, logical id, type and retain policies", () => {
    expect(pools().map(({ stack, logicalId }) => `${stack}/${logicalId}`)).toEqual([`${MAIN.stack}/${MAIN.logicalId}`]);
    expect(MAIN.logicalId).toBe('BillboardUserPoolC41FE3DD');
    // Everything but Properties and the CLI's construct-path Metadata (which a test synth leaves out).
    const outer = ({ Properties, Metadata, ...rest }: Json): Json => rest;
    expect(outer(poolResource())).toEqual(outer(MAIN.resource));
    expect(outer(poolResource())).toEqual({ Type: 'AWS::Cognito::UserPool', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    expect(MAIN.resource.Metadata).toEqual({ 'aws:cdk:path': 'UserAPIServiceStack/BillboardUserPool/Resource' });
  });

  test("every property but the four email ones is main's, value for value (names, sign-in attributes, schema, trigger, tags)", () => {
    const properties = poolResource().Properties;
    expect(withoutStep2(properties)).toEqual(withoutStep2(MAIN.resource.Properties));
    // The ones Cognito never changes on an existing pool, named so a reader sees they are among them.
    ['UserPoolName', 'UsernameAttributes', 'Schema', 'DeletionProtection'].forEach((name) =>
      expect({ name, value: properties[name] }).toEqual({ name, value: MAIN.resource.Properties[name] }));
    ['AliasAttributes', 'UsernameConfiguration'].forEach((name) =>
      expect({ name, inMain: name in MAIN.resource.Properties, now: name in properties })
        .toEqual({ name, inMain: false, now: false }));
    expect(properties.DeletionProtection).toBe('ACTIVE');
  });

  test('exactly the four email properties differ from main: EmailConfiguration is new, the other three get the new copy', () => {
    const properties = poolResource().Properties;
    const names = [...new Set([...Object.keys(properties), ...Object.keys(MAIN.resource.Properties)])];
    const changed = names.filter((name) => JSON.stringify(properties[name]) !== JSON.stringify(MAIN.resource.Properties[name]));
    expect(changed.sort()).toEqual([...STEP2_PROPERTIES].sort());
    expect(MAIN.resource.Properties.EmailConfiguration).toBeUndefined();
  });

  test("the pool sends through EmailStack's identity (DEVELOPER) from the project's sender, with Reply-To and configuration set", () => {
    const [identity] = resourcesOfType('AWS::SES::EmailIdentity');
    const [configurationSet] = resourcesOfType('AWS::SES::ConfigurationSet');
    const email = stackNamed('EmailStack');
    expect(identity.stack).toBe('EmailStack');
    expect(poolResource().Properties.EmailConfiguration).toEqual({
      EmailSendingAccount: 'DEVELOPER',
      // The identity's well-known ARN in EmailStack's own account and region: no export, no lookup.
      SourceArn: `arn:aws:ses:${email.region}:${email.account}:identity/${identity.properties.EmailIdentity}`,
      From: 'Billboard <no-reply@billboard-project.com>',
      ReplyToEmailAddress: 'contact@billboard-project.com',
      ConfigurationSet: configurationSet.properties.Name,
    });
    expect(poolResource().Properties.EmailConfiguration.SourceArn)
      .toBe(`arn:aws:ses:${DEPLOYMENT_REGION}:${DEPLOYMENT_ACCOUNT_ID}:identity/billboard-project.com`);
    expect(configurationSet.properties.Name).toBe('BillboardAccountEmail');
    expect(stackNamed('UserAPIServiceStack')).toMatchObject({ account: email.account, region: email.region });
  });

  // The SES account has Virtual Deliverability Manager and Auto Validation on (console settings, outside the app), and
  // a configuration set without its own settings takes the account's. The set the pool names turns them off, so a code
  // email gets no open-tracking pixel or wrapped link, is never held back by optimized shared delivery, and is never
  // dropped by validation while Cognito tells the app it was sent (RUNBOOK 23.1, 23.4).
  test('the configuration set the pool names turns off VDM engagement tracking, optimized shared delivery and Auto Validation', () => {
    const sets = resourcesOfType('AWS::SES::ConfigurationSet');
    expect(sets.map(({ stack }) => stack)).toEqual(['EmailStack']);
    const [{ properties }] = sets;
    expect(properties.Name).toBe(poolResource().Properties.EmailConfiguration.ConfigurationSet);
    expect(properties.VdmOptions).toEqual({
      DashboardOptions: { EngagementMetrics: 'DISABLED' },
      GuardianOptions: { OptimizedSharedDelivery: 'DISABLED' },
    });
    expect(properties.SuppressionOptions).toEqual({
      SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
      ValidationOptions: { ConditionThreshold: { ConditionThresholdEnabled: 'DISABLED' } },
    });
    expect(properties.TrackingOptions).toBeUndefined();
    // No open or click events either: with engagement tracking off, those are what would add a pixel.
    resourcesOfType('AWS::SES::ConfigurationSetEventDestination').forEach(({ properties: destination }) =>
      expect(destination.EventDestination.MatchingEventTypes).toEqual(
        expect.not.arrayContaining([expect.stringMatching(/^(open|click)$/i)]),
      ));
  });

  test("every code email uses the project's copy: one verification template, no email trigger, no SES resource in the pool's stack", () => {
    const properties = poolResource().Properties;
    const subject = 'Your Billboard verification code';
    const body = "Your Billboard verification code is {####}. Enter it in the app to continue. If you didn't ask for this code, you can ignore this email.";
    expect(properties.VerificationMessageTemplate).toEqual({
      DefaultEmailOption: 'CONFIRM_WITH_CODE',
      EmailSubject: subject,
      EmailMessage: body,
      SmsMessage: MAIN.resource.Properties.VerificationMessageTemplate.SmsMessage,
    });
    // The legacy fields carry the same copy, so no API or console reads the old one.
    expect({ subject: properties.EmailVerificationSubject, body: properties.EmailVerificationMessage }).toEqual({ subject, body });
    // Cognito's sign-up, resent, changed-address and forgot-password codes all use that template unless a
    // CustomMessage trigger rewrites them; the pool has the PreSignUp trigger only.
    expect(Object.keys(properties.LambdaConfig)).toEqual(['PreSignUp']);
    expect(JSON.stringify(stackNamed('UserAPIServiceStack').template)).not.toContain('AWS::SES::');
  });
});
