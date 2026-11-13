import * as fs from 'node:fs';
import * as path from 'node:path';
import { PENDING_NOTIFICATIONS_TABLE_NAME } from '../lib/config/notification-service-constants';
import {
  APP_ATTEST_ATTEST_THROTTLE,
  APP_ATTEST_CHALLENGE_THROTTLE,
  COGNITO_SIGN_UP_RATE_LIMIT,
  COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS,
  SIGNUP_RATE_LIMIT_ACTION,
  UNCONFIRMED_SIGNUP_CLEANUP_MODE,
  USER_API_RATE_LIMIT_PER_5_MINUTES,
} from '../lib/config/abuse-limits';
import { RETIRED_PROFILE_ATTRIBUTES_MODE } from '../lib/config/user-api-service-constants';
import {
  GITHUB_INFRA_DEPLOY_ROLE_NAME,
  GITHUB_SERVICES_RELEASE_ROLE_NAME,
} from '../lib/stacks/github-oidc';
import { cachedLookups } from './helpers/synth-app';

// Security invariants (TST-05), asserted on every stack of the real CDK app rather
// than on per-stack test fixtures, so a stack added to bin/ is covered automatically.

type Json = Record<string, any>;

interface CfnResource {
  Type: string;
  Properties?: Json;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

interface SynthesizedStack {
  name: string;
  resources: Record<string, CfnResource>;
}

interface FoundResource {
  stack: string;
  logicalId: string;
  id: string;
  resource: CfnResource;
}

const repoRoot = path.join(__dirname, '..');
const readJson = (file: string): Json => JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));

// Builds bin/billboard-infra.ts the way `cdk synth` runs it: the CLI hands the app the
// cdk.json context and any cached lookups in cdk.context.json through CDK_CONTEXT_JSON.
const synthesizeApp = (): SynthesizedStack[] => {
  const previousContext = process.env.CDK_CONTEXT_JSON;
  process.env.CDK_CONTEXT_JSON = JSON.stringify({
    ...readJson('cdk.json').context,
    ...cachedLookups(),
  });
  try {
    const { app } = require('../bin/billboard-infra') as typeof import('../bin/billboard-infra');
    return app.synth().stacks.map((stack) => ({
      name: stack.stackName,
      resources: (stack.template.Resources ?? {}) as Record<string, CfnResource>,
    }));
  } finally {
    if (previousContext === undefined) {
      delete process.env.CDK_CONTEXT_JSON;
    } else {
      process.env.CDK_CONTEXT_JSON = previousContext;
    }
  }
};

const stacks = synthesizeApp();

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const resourcesOfType = (type: string): FoundResource[] =>
  stacks.flatMap((stack) =>
    Object.entries(stack.resources)
      .filter(([, resource]) => resource.Type === type)
      .map(([logicalId, resource]) => ({ stack: stack.name, logicalId, id: `${stack.name}/${logicalId}`, resource })),
  );

const resourceIn = (stackName: string, logicalId: string): CfnResource | undefined =>
  stacks.find((stack) => stack.name === stackName)?.resources[logicalId];

// `{ "Fn::GetAtt": [id, "Arn"] }` or `{ Ref: id }` → id.
const referencedId = (value: unknown): string | undefined => {
  const reference = value as { Ref?: string; 'Fn::GetAtt'?: [string, string] } | undefined;
  return reference?.Ref ?? reference?.['Fn::GetAtt']?.[0];
};

const mentionsRef = (value: unknown, logicalId: string): boolean =>
  JSON.stringify(value ?? null).includes(JSON.stringify({ Ref: logicalId }));

// REC-02: the nightly Cognito user export. It holds every user's email.
const cognitoUserExportBuckets = resourcesOfType('AWS::S3::Bucket').filter(
  ({ stack, logicalId }) => stack === 'UserAPIServiceStack' && logicalId.startsWith('CognitoUserExportBucket'),
);

describe('security invariants across every synthesized stack', () => {
  test('the app synthesizes the stacks these checks depend on', () => {
    expect(stacks.map((stack) => stack.name)).toEqual(
      expect.arrayContaining([
        'UserAPIServiceStack',
        'ShareSiteStack',
        'NotificationServiceStack',
        'UserStoreStack',
        'GitHubOidcStack',
      ]),
    );
  });

  describe('DynamoDB', () => {
    const tables = resourcesOfType('AWS::DynamoDB::Table');

    test('every table is retained on delete and replacement and has deletion protection', () => {
      expect(tables.length).toBeGreaterThan(0);
      const unprotected = tables
        .filter(
          ({ resource }) =>
            resource.DeletionPolicy !== 'Retain' ||
            resource.UpdateReplacePolicy !== 'Retain' ||
            resource.Properties?.DeletionProtectionEnabled !== true,
        )
        .map(({ id }) => id);
      expect(unprotected).toEqual([]);
    });

    test('every table except PendingNotifications has point-in-time recovery', () => {
      // PendingNotifications only queues undelivered pushes, which expire by TTL.
      // Losing it drops pending notifications, not user data.
      const exempt = tables.filter(({ resource }) => resource.Properties?.TableName === PENDING_NOTIFICATIONS_TABLE_NAME);
      expect(exempt).toHaveLength(1);

      const withoutPitr = tables
        .filter((table) => !exempt.includes(table))
        .filter(
          ({ resource }) =>
            resource.Properties?.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled !== true,
        )
        .map(({ id }) => id);
      expect(withoutPitr).toEqual([]);
    });
  });

  describe('S3', () => {
    const buckets = resourcesOfType('AWS::S3::Bucket');
    const bucketPolicies = resourcesOfType('AWS::S3::BucketPolicy');

    test('every bucket blocks all public access', () => {
      expect(buckets.length).toBeGreaterThan(0);
      const exposed = buckets
        .filter(({ resource }) => {
          const block = resource.Properties?.PublicAccessBlockConfiguration ?? {};
          return !(
            block.BlockPublicAcls === true &&
            block.BlockPublicPolicy === true &&
            block.IgnorePublicAcls === true &&
            block.RestrictPublicBuckets === true
          );
        })
        .map(({ id }) => id);
      expect(exposed).toEqual([]);
    });

    test('every bucket policy denies requests that are not over TLS, for the bucket and its objects', () => {
      const enforcesSsl = (bucket: FoundResource): boolean =>
        bucketPolicies
          .filter((policy) => policy.stack === bucket.stack && referencedId(policy.resource.Properties?.Bucket) === bucket.logicalId)
          .flatMap((policy) => asArray<Json>(policy.resource.Properties?.PolicyDocument?.Statement))
          .some((statement) => {
            const resources = JSON.stringify(statement.Resource);
            return (
              statement.Effect === 'Deny' &&
              JSON.stringify(statement.Principal) === JSON.stringify({ AWS: '*' }) &&
              asArray(statement.Action).includes('s3:*') &&
              statement.Condition?.Bool?.['aws:SecureTransport'] === 'false' &&
              resources.includes(JSON.stringify({ 'Fn::GetAtt': [bucket.logicalId, 'Arn'] })) &&
              resources.includes('/*')
            );
          });

      expect(buckets.filter((bucket) => !enforcesSsl(bucket)).map(({ id }) => id)).toEqual([]);
    });

    test('the Cognito user export bucket is encrypted, versioned, retained and expires exports after 14 days', () => {
      expect(cognitoUserExportBuckets).toHaveLength(1);
      const [{ resource }] = cognitoUserExportBuckets;
      expect(resource.DeletionPolicy).toBe('Retain');
      expect(resource.UpdateReplacePolicy).toBe('Retain');
      const properties = resource.Properties ?? {};
      expect(properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
      expect(properties.OwnershipControls).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] });
      expect(['AES256', 'aws:kms']).toContain(
        properties.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm,
      );
      expect(properties.LifecycleConfiguration?.Rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Prefix: 'cognito-users/',
            Status: 'Enabled',
            ExpirationInDays: 14,
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
          }),
        ]),
      );
    });

    // C1.7: the share site's legacy auto-delete statement was the only Allow with a wildcard principal.
    test('no bucket policy allows a wildcard principal', () => {
      const wildcardAllows = bucketPolicies.flatMap(({ id, resource }) =>
        asArray<Json>(resource.Properties?.PolicyDocument?.Statement)
          .filter((statement) => statement.Effect === 'Allow')
          .filter((statement) => ['"*"', '{"AWS":"*"}'].includes(JSON.stringify(statement.Principal)))
          .map((statement) => `${id}: ${statement.Sid ?? asArray(statement.Action).join(',')}`),
      );
      expect(wildcardAllows).toEqual([]);
    });

    test('the Cognito user export bucket policy grants nothing; it only denies requests without TLS', () => {
      const [bucket] = cognitoUserExportBuckets;
      const statements = bucketPolicies
        .filter((policy) => policy.stack === bucket.stack && referencedId(policy.resource.Properties?.Bucket) === bucket.logicalId)
        .flatMap((policy) => asArray<Json>(policy.resource.Properties?.PolicyDocument?.Statement));
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter((statement) => statement.Effect !== 'Deny')).toEqual([]);
    });
  });

  describe('SQS', () => {
    const queuePolicies = resourcesOfType('AWS::SQS::QueuePolicy');

    // A service may send to a queue only on behalf of a named source: an S3 bucket's notifications, or
    // (C1.1) this account's EventBridge rules writing their dead letters to ScheduledJobFailures.
    test('every queue policy statement allows one AWS service, scoped to its source', () => {
      expect(queuePolicies.length).toBeGreaterThan(0);
      const statements = queuePolicies.flatMap(({ id, resource }) =>
        asArray<Json>(resource.Properties?.PolicyDocument?.Statement).map((statement) => ({ id, statement })),
      );
      const unscoped = statements
        .filter(({ statement }) => {
          const sourceArn = statement.Condition?.ArnLike?.['aws:SourceArn'] ?? statement.Condition?.ArnEquals?.['aws:SourceArn'];
          return (
            statement.Effect !== 'Allow' ||
            typeof statement.Principal?.Service !== 'string' ||
            sourceArn === undefined ||
            JSON.stringify(sourceArn) === '"*"'
          );
        })
        .map(({ id }) => id);
      expect(unscoped).toEqual([]);
      expect(
        [...new Set(statements.map(({ statement }) => statement.Principal.Service as string))].sort(),
      ).toEqual(['events.amazonaws.com', 's3.amazonaws.com']);
    });

    // C1.7: no bucket notification targets NotificationTypeQueue, so S3 may no longer send to it.
    test('NotificationTypeQueue has no queue policy', () => {
      const notificationTypeQueue = resourcesOfType('AWS::SQS::Queue').find(
        ({ resource }) => resource.Properties?.QueueName === 'NotificationTypeQueue',
      );
      expect(notificationTypeQueue).toBeDefined();
      const naming = queuePolicies.filter(({ resource }) =>
        JSON.stringify(resource.Properties?.Queues ?? []).includes('NotificationTypeQueue'),
      );
      expect(naming.map(({ id }) => id)).toEqual([]);
    });

    test('EventBridge may write only to ScheduledJobFailures, and only for this account\'s rules', () => {
      const eventsStatements = queuePolicies.flatMap(({ id, resource }) =>
        asArray<Json>(resource.Properties?.PolicyDocument?.Statement)
          .filter((statement) => statement.Principal?.Service === 'events.amazonaws.com')
          .map((statement) => ({ id, statement })),
      );
      expect(eventsStatements).toHaveLength(1);
      expect(eventsStatements[0].id).toMatch(/^SharedInfraStack\/ScheduledJobFailuresQueuePolicy/);
      expect(eventsStatements[0].statement.Action).toBe('sqs:SendMessage');
      expect(eventsStatements[0].statement.Condition).toEqual({
        StringEquals: { 'aws:SourceAccount': expect.any(String) },
        ArnLike: { 'aws:SourceArn': expect.stringMatching(/^arn:aws:events:[a-z0-9-]+:\d{12}:rule\/\*$/) },
      });
    });
  });

  describe('WAF', () => {
    const webAclScope = (stackName: string, webAclArn: unknown): string | undefined => {
      const webAcl = resourceIn(stackName, referencedId(webAclArn) ?? '');
      return webAcl?.Type === 'AWS::WAFv2::WebACL' ? webAcl.Properties?.Scope : undefined;
    };

    test('every API Gateway stage is associated with a regional web ACL', () => {
      const stages = resourcesOfType('AWS::ApiGateway::Stage');
      const associations = resourcesOfType('AWS::WAFv2::WebACLAssociation');
      expect(stages.length).toBeGreaterThan(0);

      const unprotected = stages
        .filter((stage) => {
          const restApiId = referencedId(stage.resource.Properties?.RestApiId) ?? '';
          return !associations.some(
            ({ stack, resource }) =>
              stack === stage.stack &&
              mentionsRef(resource.Properties?.ResourceArn, stage.logicalId) &&
              mentionsRef(resource.Properties?.ResourceArn, restApiId) &&
              webAclScope(stack, resource.Properties?.WebACLArn) === 'REGIONAL',
          );
        })
        .map(({ id }) => id);
      expect(unprotected).toEqual([]);
    });

    // 7B (SEC-02, CAP-10): the user pool's unauthenticated API calls (SignUp, InitiateAuth, ...) pass through
    // a regional web ACL, as the API stage's requests do.
    test('every Cognito user pool is associated with a regional web ACL', () => {
      const pools = resourcesOfType('AWS::Cognito::UserPool');
      const associations = resourcesOfType('AWS::WAFv2::WebACLAssociation');
      expect(pools.length).toBeGreaterThan(0);
      const unprotected = pools
        .filter((pool) => !associations.some(
          ({ stack, resource }) =>
            stack === pool.stack &&
            JSON.stringify(resource.Properties?.ResourceArn) === JSON.stringify({ 'Fn::GetAtt': [pool.logicalId, 'Arn'] }) &&
            webAclScope(stack, resource.Properties?.WebACLArn) === 'REGIONAL',
        ))
        .map(({ id }) => id);
      expect(unprotected).toEqual([]);
    });

    describe('the user API web ACL (7B)', () => {
      const userApiAcl = () => {
        const acls = resourcesOfType('AWS::WAFv2::WebACL').filter(({ stack }) => stack === 'UserAPIServiceStack');
        expect(acls.map(({ logicalId }) => logicalId)).toEqual(['UserApiWebAcl']);
        return acls[0];
      };
      const rules = (): Json[] => userApiAcl().resource.Properties?.Rules ?? [];

      test('has exactly two rate-based rules and no managed rule group', () => {
        expect(rules().map((rule) => [rule.Priority, rule.Name])).toEqual([
          [0, 'UserApiRateLimitRule'],
          [1, 'CognitoSignUpRateLimit'],
        ]);
        expect(JSON.stringify(rules())).not.toContain('ManagedRuleGroupStatement');
        expect(userApiAcl().resource.Properties?.DefaultAction).toEqual({ Allow: {} });
      });

      // WEB-07 privacy draft, checklist item 7 (project decision of 2026-11-12): a sampled request holds the caller's
      // IP address and every header for 3 hours, which the privacy policy rules out. The metrics stay on under the
      // same names, which the sign-up rule's alarm reads. The share site's ACL keeps its samples (share-site.test.ts),
      // as the policy's website paragraph discloses the site's request records.
      test('keeps no sampled requests, on the ACL or on any rule, and keeps every metric (WEB-07)', () => {
        expect(userApiAcl().resource.Properties?.VisibilityConfig).toEqual({
          CloudWatchMetricsEnabled: true,
          MetricName: 'UserApiWebAcl',
          SampledRequestsEnabled: false,
        });
        expect(rules()).toHaveLength(2);
        rules().forEach((rule) => expect(rule.VisibilityConfig).toEqual({
          CloudWatchMetricsEnabled: true,
          MetricName: rule.Name,
          SampledRequestsEnabled: false,
        }));
        expect(JSON.stringify(userApiAcl().resource.Properties)).not.toContain('"SampledRequestsEnabled":true');
        // No alarm sends the reader to samples that no longer exist (the sign-up rule's and the challenge flood's
        // descriptions point to RUNBOOK 14.6 and the metrics instead).
        const sampleMentions = resourcesOfType('AWS::CloudWatch::Alarm')
          .map(({ resource }) => JSON.stringify(resource.Properties?.AlarmDescription ?? ''))
          .filter((description) => /sampled requests/i.test(description));
        expect(sampleMentions.length).toBeGreaterThan(0);
        sampleMentions.forEach((description) => expect(description).toMatch(/keeps no sampled requests/));
      });

      test('rule 0 blocks any IP above USER_API_RATE_LIMIT_PER_5_MINUTES requests in 5 minutes, with no scope-down', () => {
        expect(rules()[0]).toEqual(expect.objectContaining({
          Action: { Block: {} },
          Statement: { RateBasedStatement: { AggregateKeyType: 'IP', Limit: USER_API_RATE_LIMIT_PER_5_MINUTES } },
        }));
      });

      test('rule 1 applies SIGNUP_RATE_LIMIT_ACTION to an IP above COGNITO_SIGN_UP_RATE_LIMIT sign-up, resend and reset calls in its window', () => {
        const header = (name: string, value: string) => ({
          ByteMatchStatement: {
            FieldToMatch: { SingleHeader: { Name: name } },
            PositionalConstraint: 'EXACTLY',
            SearchString: value,
            TextTransformations: [{ Priority: 0, Type: 'NONE' }],
          },
        });
        const operations = ['SignUp', 'ResendConfirmationCode', 'ForgotPassword'];
        expect(rules()[1]).toEqual(expect.objectContaining({
          Action: SIGNUP_RATE_LIMIT_ACTION === 'block' ? { Block: {} } : { Count: {} },
          Statement: {
            RateBasedStatement: {
              AggregateKeyType: 'IP',
              Limit: COGNITO_SIGN_UP_RATE_LIMIT,
              EvaluationWindowSec: COGNITO_SIGN_UP_RATE_LIMIT_WINDOW_SECONDS,
              ScopeDownStatement: {
                OrStatement: {
                  Statements: [
                    ...operations.map((operation) => header('x-amz-target', `AWSCognitoIdentityProviderService.${operation}`)),
                    ...operations.map((operation) => header('x-amzn-cognito-operation-name', operation)),
                  ],
                },
              },
            },
          },
        }));
      });

      test('the API stage and the user pool share that one ACL', () => {
        const associations = resourcesOfType('AWS::WAFv2::WebACLAssociation')
          .filter(({ stack, resource }) => stack === 'UserAPIServiceStack' && referencedId(resource.Properties?.WebACLArn) === 'UserApiWebAcl')
          .map(({ logicalId, resource }) => [logicalId, resourceIn('UserAPIServiceStack', referencedId(resource.Properties?.ResourceArn) ?? '')?.Type ?? 'stage ARN']);
        expect(associations.sort()).toEqual([
          ['UserApiWebAclAssociation', 'stage ARN'],
          ['UserPoolWebAclAssociation', 'AWS::Cognito::UserPool'],
        ]);
      });
    });

    test('every CloudFront distribution, including the share site, has a CloudFront-scope web ACL', () => {
      const distributions = resourcesOfType('AWS::CloudFront::Distribution');
      expect(distributions.map(({ stack }) => stack)).toContain('ShareSiteStack');

      const unprotected = distributions
        .filter(
          ({ stack, resource }) =>
            webAclScope(stack, resource.Properties?.DistributionConfig?.WebACLId) !== 'CLOUDFRONT',
        )
        .map(({ id }) => id);
      expect(unprotected).toEqual([]);
    });
  });

  describe('API Gateway authorization', () => {
    // "GET /health" style key for every method, built from the resource PathPart chain.
    const methods = resourcesOfType('AWS::ApiGateway::Method').map((method) => {
      const pathOf = (resourceId: unknown): string => {
        const resource = resourceIn(method.stack, referencedId(resourceId) ?? '');
        if (resource?.Type !== 'AWS::ApiGateway::Resource') {
          return ''; // the API root
        }
        return `${pathOf(resource.Properties?.ParentId)}/${resource.Properties?.PathPart}`;
      };
      const route = `${method.resource.Properties?.HttpMethod} ${pathOf(method.resource.Properties?.ResourceId) || '/'}`;
      return { ...method, route, properties: method.resource.Properties ?? {} };
    });
    const methodFor = (route: string) => methods.find((method) => method.route === route);

    test('GET /health is unauthenticated but is a mock integration that reaches no backend', () => {
      const health = methodFor('GET /health');
      expect(health?.properties.AuthorizationType).toBe('NONE');
      expect(health?.properties.Integration?.Type).toBe('MOCK');
    });

    test('GET /public/processed-bill requires an API key', () => {
      const publicBill = methodFor('GET /public/processed-bill');
      expect(publicBill).toBeDefined();
      expect(publicBill?.properties.ApiKeyRequired).toBe(true);
    });

    // INT-04 (C3 3.2, 3.3): sign-up and the first attestation happen before sign-in, so the two App Attest routes
    // are public. Each has its own stage throttle (429 before the function) on top of the WAF and the stage's.
    test('POST /app-attest/challenge and /attest are public Lambda proxies to the AppAttest alias, each with its own throttle', () => {
      const stages = resourcesOfType('AWS::ApiGateway::Stage').filter(({ stack }) => stack === 'UserAPIServiceStack');
      expect(stages).toHaveLength(1);
      const settings: Json[] = stages[0].resource.Properties?.MethodSettings ?? [];
      ['challenge', 'attest'].forEach((route) => {
        const method = methodFor(`POST /app-attest/${route}`);
        expect(method).toBeDefined();
        expect(method?.properties.AuthorizationType).toBe('NONE');
        expect(method?.properties.AuthorizerId).toBeUndefined();
        expect(method?.properties.ApiKeyRequired).not.toBe(true);
        expect(method?.properties.Integration?.Type).toBe('AWS_PROXY');
        expect(JSON.stringify(method?.properties.Integration?.Uri)).toMatch(/"Ref":"AppAttestProdAlias[0-9A-F]{8}"/);
        const throttle = settings.find((setting) => setting.ResourcePath === `/~1app-attest~1${route}` && setting.HttpMethod === 'POST');
        const expected = route === 'challenge' ? APP_ATTEST_CHALLENGE_THROTTLE : APP_ATTEST_ATTEST_THROTTLE;
        expect(throttle?.ThrottlingRateLimit).toBe(expected.rateLimit);
        expect(throttle?.ThrottlingBurstLimit).toBe(expected.burstLimit);
      });
    });

    test('the unauthenticated methods are exactly these four', () => {
      const unauthenticated = methods
        .filter(({ properties }) => properties.AuthorizationType === 'NONE')
        .map(({ route }) => route)
        .sort();
      expect(unauthenticated).toEqual([
        'GET /health',
        'GET /public/processed-bill',
        'POST /app-attest/attest',
        'POST /app-attest/challenge',
      ]);
    });

    test('every other method uses a Cognito user pool authorizer', () => {
      const exempt = new Set([
        'GET /health',
        'GET /public/processed-bill',
        'POST /app-attest/challenge',
        'POST /app-attest/attest',
      ]);
      const others = methods.filter(({ route }) => !exempt.has(route));
      expect(others.length).toBeGreaterThan(0);

      const unauthorized = others
        .filter(({ stack, properties }) => {
          const authorizer = resourceIn(stack, referencedId(properties.AuthorizerId) ?? '');
          return (
            properties.AuthorizationType !== 'COGNITO_USER_POOLS' ||
            authorizer?.Type !== 'AWS::ApiGateway::Authorizer' ||
            authorizer.Properties?.Type !== 'COGNITO_USER_POOLS'
          );
        })
        .map(({ id, route }) => `${id} (${route})`);
      expect(unauthorized).toEqual([]);
    });
  });

  describe('IAM', () => {
    interface IdentityStatement {
      source: string;
      // `Stack/LogicalId` of each role, user or group the statement applies to.
      principals: string[];
      statement: Json;
    }

    const principalRef = (stackName: string, ref: unknown): string =>
      typeof ref === 'object' && ref !== null && 'Ref' in ref ? `${stackName}/${(ref as { Ref: string }).Ref}` : JSON.stringify(ref);

    // Identity-based policies only. Resource policies are covered by the S3 checks above.
    const identityStatements: IdentityStatement[] = stacks.flatMap((stack) =>
      Object.entries(stack.resources).flatMap(([logicalId, resource]): IdentityStatement[] => {
        const source = `${stack.name}/${logicalId}`;
        switch (resource.Type) {
          case 'AWS::IAM::Role':
          case 'AWS::IAM::User':
          case 'AWS::IAM::Group':
            return asArray<Json>(resource.Properties?.Policies).flatMap((policy) =>
              asArray<Json>(policy.PolicyDocument?.Statement).map((statement) => ({
                source: `${source} (${policy.PolicyName})`,
                principals: [source],
                statement,
              })),
            );
          case 'AWS::IAM::Policy':
          case 'AWS::IAM::ManagedPolicy': {
            const principals = [
              ...asArray(resource.Properties?.Roles),
              ...asArray(resource.Properties?.Users),
              ...asArray(resource.Properties?.Groups),
            ].map((ref) => principalRef(stack.name, ref));
            return asArray<Json>(resource.Properties?.PolicyDocument?.Statement).map((statement) => ({
              source,
              principals,
              statement,
            }));
          }
          default:
            return [];
        }
      }),
    );
    const allows = identityStatements.filter(({ statement }) => statement.Effect === 'Allow');

    // The only actions that may be granted on Resource "*", each limited to the principals
    // that need it. Every other grant must name its resources.
    const WILDCARD_RESOURCE_ALLOW_LIST: {
      action: string;
      principals: RegExp;
      requiresNamespaceCondition?: true;
    }[] = [
      // Metrics have no ARN, so the cloudwatch:namespace condition is the only possible scope.
      { action: 'cloudwatch:PutMetricData', principals: /./, requiresNamespaceCondition: true },
      // Creating the APNs platform application: there is no ARN until the call returns,
      // and the action supports no resource types.
      {
        action: 'sns:CreatePlatformApplication',
        principals: /^NotificationServiceStack\/ApnsPlatformApplicationOnEventServiceRole/,
      },
      // X-Ray trace writes (active tracing on every Lambda) support no resource-level permissions.
      { action: 'xray:PutTraceSegments', principals: /./ },
      { action: 'xray:PutTelemetryRecords', principals: /./ },
      // AWS lists s3:ListAllMyBuckets as required for canary roles; the action has no resource type.
      { action: 's3:ListAllMyBuckets', principals: /^UserAPIServiceStack\/SyntheticsCanaryRole/ },
    ];

    test('no statement grants Action "*" or uses NotAction or NotResource', () => {
      expect(allows.length).toBeGreaterThan(0);
      const offenders = allows
        .filter(
          ({ statement }) =>
            asArray(statement.Action).includes('*') ||
            statement.NotAction !== undefined ||
            statement.NotResource !== undefined,
        )
        .map(({ source }) => source);
      expect(offenders).toEqual([]);
    });

    test('Resource "*" is granted only for allow-listed actions and principals', () => {
      const namespaceIsPinned = (statement: Json): boolean =>
        asArray<string>(statement.Condition?.StringEquals?.['cloudwatch:namespace']).length > 0;

      const offenders = allows
        .filter(({ statement }) => asArray(statement.Resource).includes('*'))
        .flatMap(({ source, principals, statement }) =>
          asArray<string>(statement.Action)
            .filter(
              (action) =>
                !WILDCARD_RESOURCE_ALLOW_LIST.some(
                  (allowed) =>
                    allowed.action === action &&
                    principals.length > 0 &&
                    principals.every((principal) => allowed.principals.test(principal)) &&
                    (!allowed.requiresNamespaceCondition || namespaceIsPinned(statement)),
                ),
            )
            .map((action) => `${source}: ${action}`),
        );
      expect(offenders).toEqual([]);
    });

    // INT-05 (C2 3.5): the pre-sign-up trigger reads the pool through its own policy. Cognito actions anywhere
    // in the app name the pool, and only these functions hold them. CB-07: the sign-up filter check finds and
    // deletes its own probe accounts (its code guards AdminDeleteUser, which IAM cannot narrow). REL-53: with
    // UNCONFIRMED_SIGNUP_CLEANUP_MODE 'delete', and only then, CleanupOrphanedUsers gets AdminDeleteUser too (its code
    // guards it the same way; the app's policy minimization merges it into the role's pool statement). DRY_RUN is
    // then all that keeps the D3 resume path from deleting a sign-in (docs/RUNBOOK.md 8.1). UX-36: with
    // RETIRED_PROFILE_ATTRIBUTES_MODE 'clear', ExportCognitoUsers may delete user attributes (its code sends only
    // party, gender and birth date, which IAM cannot narrow to).
    test('Cognito user pool actions are granted only on the pool, and only to these functions', () => {
      const cognitoGrants = allows
        .filter(({ statement }) => asArray<string>(statement.Action).some((action) => action.startsWith('cognito-idp:')))
        .map(({ principals, statement }) => ({
          role: principals.map((principal) => principal.replace(/^UserAPIServiceStack\//, '').replace(/ServiceRole[0-9A-F]{8}$/, '')).join(','),
          actions: asArray<string>(statement.Action).sort().join(','),
          resource: JSON.stringify(statement.Resource),
        }))
        .sort((left, right) => left.role.localeCompare(right.role));
      const pool = JSON.stringify({ 'Fn::GetAtt': ['BillboardUserPoolC41FE3DD', 'Arn'] });
      const cleanupActions = [
        ...(UNCONFIRMED_SIGNUP_CLEANUP_MODE === 'delete' ? ['cognito-idp:AdminDeleteUser'] : []),
        'cognito-idp:AdminGetUser',
        'cognito-idp:ListUsers',
      ].join(',');
      const exportActions = [
        ...(RETIRED_PROFILE_ATTRIBUTES_MODE === 'clear' ? ['cognito-idp:AdminDeleteUserAttributes'] : []),
        'cognito-idp:ListUsers',
      ].join(',');
      expect(cognitoGrants).toEqual([
        { role: 'AccountData', actions: 'cognito-idp:AdminDeleteUser', resource: pool },
        { role: 'CleanupOrphanedUsers', actions: cleanupActions, resource: pool },
        { role: 'ExportCognitoUsers', actions: exportActions, resource: pool },
        { role: 'PreSignUpCheck', actions: 'cognito-idp:AdminGetUser', resource: pool },
        {
          role: 'SignUpFilterCheck',
          actions: 'cognito-idp:AdminDeleteUser,cognito-idp:AdminGetUser,cognito-idp:ListUsers',
          resource: pool,
        },
      ]);
    });

    // The three account-integrity user tables hold salted hashes, device keys and account bindings. No role may scan
    // them, and only these roles may write them (X5: AccountData's deletion steps; X23: Cleanup reads only; CB-07:
    // the sign-up filter check deletes the claim items and probe records its own sign-ups made, with no PutItem;
    // REL-53: with UNCONFIRMED_SIGNUP_CLEANUP_MODE 'delete', Cleanup deletes the email claim of the unconfirmed
    // sign-ups it deletes, DeleteItem only).
    test('the account-integrity user tables are never scanned and are written only by their owners, AccountData and the filter check', () => {
      const tableGrants = (tableName: string) => allows
        .filter(({ statement }) => JSON.stringify(statement.Resource ?? null).includes(`:table/${tableName}`))
        .map(({ principals, statement }) => ({
          role: principals.map((principal) => principal.replace(/^UserAPIServiceStack\//, '').replace(/ServiceRole[0-9A-F]{8}$/, '')).join(','),
          actions: asArray<string>(statement.Action),
        }));
      const writersOf = (tableName: string) => [...new Set(tableGrants(tableName)
        .filter(({ actions }) => actions.some((action) => /^dynamodb:(Put|Update|Delete|BatchWrite)/.test(action)))
        .map(({ role }) => role))].sort();
      ['VerifiedAddressClaims', 'SignUpEmailClaims', 'AppAttest'].forEach((tableName) => {
        const scans = tableGrants(tableName).filter(({ actions }) => actions.some((action) => action === 'dynamodb:Scan' || action === 'dynamodb:*'));
        expect({ tableName, scans }).toEqual({ tableName, scans: [] });
      });
      expect(writersOf('VerifiedAddressClaims')).toEqual(['AccountData', 'DistrictVerification']);
      const cleanupDeletesClaims = UNCONFIRMED_SIGNUP_CLEANUP_MODE === 'delete';
      expect(writersOf('SignUpEmailClaims')).toEqual([
        'AccountData',
        ...(cleanupDeletesClaims ? ['CleanupOrphanedUsers'] : []),
        'PreSignUpCheck',
        'SignUpFilterCheck',
      ]);
      expect(tableGrants('SignUpEmailClaims').filter(({ role }) => role === 'SignUpFilterCheck')).toEqual([
        { role: 'SignUpFilterCheck', actions: ['dynamodb:DeleteItem', 'dynamodb:GetItem'] },
      ]);
      const cleanupClaimActions = tableGrants('SignUpEmailClaims')
        .filter(({ role }) => role === 'CleanupOrphanedUsers')
        .flatMap(({ actions }) => actions)
        .sort();
      expect(cleanupClaimActions).toEqual([
        ...(cleanupDeletesClaims ? ['dynamodb:DeleteItem'] : []),
        'dynamodb:GetItem',
        'dynamodb:Query',
      ]);
      expect(writersOf('AppAttest')).toEqual(['AccountData', 'AppAttest', 'PreSignUpCheck', 'SetFeedback']);
    });

    // INT-04: the DeviceCheck key is read by name, and only by the pre-sign-up trigger.
    test('only PreSignUpCheck may read the DeviceCheck key, and only GetSecretValue', () => {
      const grants = allows
        .filter(({ statement }) => JSON.stringify(statement.Resource ?? null).includes('Billboard/AppleDeviceCheckKey'))
        .map(({ principals, statement }) => ({
          role: principals.map((principal) => principal.replace(/^UserAPIServiceStack\//, '').replace(/ServiceRole[0-9A-F]{8}$/, '')).join(','),
          actions: asArray<string>(statement.Action),
        }));
      expect(grants).toEqual([{ role: 'PreSignUpCheck', actions: ['secretsmanager:GetSecretValue'] }]);
    });

    test('only ExportCognitoUsers may touch the Cognito user export bucket, and only to put new exports', () => {
      const [bucket] = cognitoUserExportBuckets;
      // A grant from another stack would reference the bucket through an export named after it.
      const grants = allows
        .filter(({ statement }) => JSON.stringify(statement.Resource ?? null).includes(bucket.logicalId))
        .map(({ principals, statement }) => ({ principals, actions: asArray(statement.Action), resource: statement.Resource }));
      expect(grants).toEqual([
        {
          principals: [expect.stringMatching(/^UserAPIServiceStack\/ExportCognitoUsersServiceRole/)],
          actions: ['s3:PutObject'],
          resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucket.logicalId, 'Arn'] }, '/cognito-users/*']] },
        },
      ]);
    });

    test('no role attaches AdministratorAccess, and the GitHub deploy roles exist without it', () => {
      const roles = resourcesOfType('AWS::IAM::Role');
      const githubRoleNames = roles
        .map(({ resource }) => resource.Properties?.RoleName)
        .filter((name) => name === GITHUB_SERVICES_RELEASE_ROLE_NAME || name === GITHUB_INFRA_DEPLOY_ROLE_NAME)
        .sort();
      expect(githubRoleNames).toEqual([GITHUB_INFRA_DEPLOY_ROLE_NAME, GITHUB_SERVICES_RELEASE_ROLE_NAME]);

      const admins = roles
        .filter(({ resource }) => JSON.stringify(resource.Properties?.ManagedPolicyArns ?? []).includes('AdministratorAccess'))
        .map(({ id }) => id);
      expect(admins).toEqual([]);
    });
  });
});
