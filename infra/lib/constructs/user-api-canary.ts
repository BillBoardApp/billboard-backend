import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as synthetics from 'aws-cdk-lib/aws-synthetics';
import { Construct } from 'constructs';
import { USER_API_CANARY_NAME } from '../config/user-api-service-constants';

/**
 * The canary's handler, deployed as its inline script. It calls /health (expects 200 and
 * {status:ok}) and /bills-manifest without auth (expects 401/403, proving API Gateway and
 * Cognito are up). When the smoke-test secrets are configured, it also signs in a dedicated
 * smoke user and exercises the app-critical read paths plus optional idempotent write paths.
 * A sign-in the script cannot complete (the secret or the account is not as it expects) does not fail
 * the run: it skips the signed-in steps and emits CanarySmokeSignInFailed, which MonitoringStack alarms
 * on without paging. A failing signed-in step after a token still fails the run.
 * The bills path is the app's own (C1.9): the snapshot pointer, then the presigned snapshot download.
 */
export const USER_API_CANARY_SCRIPT_PATH = path.join(__dirname, '..', 'canaries', 'user-api-canary.js');

export interface UserApiCanaryProps {
  /** The API the canary calls, at its `prod` stage. */
  readonly api: apigateway.RestApi;
  /** The canary's own app client; it is the only one with USER_PASSWORD_AUTH. */
  readonly userPoolClient: cognito.IUserPoolClient;
  /** Secret with the smoke user's credentials. Without it the authenticated checks are skipped. */
  readonly smokeTestSecretName?: string;
  /** Secret with optional fixtures (bill guid, bioguide id, freshness timestamps). */
  readonly smokeTestFixturesSecretName?: string;
  /** Also runs the idempotent preference and feedback writes. */
  readonly smokeTestWriteChecksEnabled?: boolean;
}

/**
 * CloudWatch Synthetics canary for the user API: artifact bucket, execution role, the canary,
 * 30-day retention on its Lambda log group, and an alarm that the caller attaches to its
 * CodeDeploy deployment groups.
 *
 * Every resource is created in the parent scope, not under this construct, so each keeps the
 * logical ID it had when this code lived in UserAPIServiceStack. Nesting them would change the
 * IDs and make CloudFormation replace the canary, its bucket and its roles.
 */
export class UserApiCanary extends Construct {
  public readonly canary: synthetics.CfnCanary;
  /** Two or more of the last three runs failed. */
  public readonly alarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: UserApiCanaryProps) {
    super(scope, id);
    const stack = cdk.Stack.of(scope);

    // Schedule: every 15 minutes, 13:00–23:59 UTC ≈ 8 AM–8 PM EDT (US Eastern).
    // UTC offsets: EDT = UTC-4 (summer), EST = UTC-5 (winter).
    // Single expression cron(0/15 13-23 ? * * *) covers 13:00–23:45 UTC daily,
    // which maps to 9 AM–7:45 PM EDT or 8 AM–6:45 PM EST — approximately 12 hrs.
    // For full EDT coverage extend with a second expression: cron(0/15 12 ? * * *).
    const canaryArtifactsBucket = new s3.Bucket(scope, 'SyntheticsArtifactsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        { id: 'ExpireAfter14Days', enabled: true, expiration: cdk.Duration.days(14) },
      ],
    });

    // The signed-in checks read their secrets by name. GetSecretValue is the only call the script makes (no
    // DescribeSecret, no list), on each named secret and nothing else; the resource is the secret's ARN with
    // Secrets Manager's random six-character suffix as "-??????". With neither name set there is no statement
    // and the script skips the signed-in checks.
    const smokeTestSecretArns = [props.smokeTestSecretName, props.smokeTestFixturesSecretName]
      .filter((name): name is string => !!name)
      .map((name) =>
        stack.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: `${name}-??????`,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      );

    const canaryRole = new iam.Role(scope, 'SyntheticsCanaryRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        SyntheticsCanaryPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:PutObject', 's3:GetObject'],
              resources: [`${canaryArtifactsBucket.bucketArn}/*`],
            }),
            new iam.PolicyStatement({
              actions: ['s3:GetBucketLocation'],
              resources: [canaryArtifactsBucket.bucketArn],
            }),
            // ListAllMyBuckets has no resource type, so it cannot be scoped.
            new iam.PolicyStatement({
              actions: ['s3:ListAllMyBuckets'],
              resources: ['*'],
            }),
            new iam.PolicyStatement({
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: {
                StringEquals: { 'cloudwatch:namespace': 'CloudWatchSynthetics' },
              },
            }),
            new iam.PolicyStatement({
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*'],
              conditions: {
                StringEquals: { 'cloudwatch:namespace': 'BillBoard/ProductHealth' },
              },
            }),
            new iam.PolicyStatement({
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              resources: ['arn:aws:logs:*:*:log-group:/aws/lambda/cwsyn-*'],
            }),
            new iam.PolicyStatement({
              actions: ['xray:PutTraceSegments'],
              resources: ['*'],
            }),
            ...(smokeTestSecretArns.length > 0
              ? [
                  new iam.PolicyStatement({
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: smokeTestSecretArns,
                  }),
                ]
              : []),
          ],
        }),
      },
    });

    this.canary = new synthetics.CfnCanary(scope, 'UserApiCanary', {
      name: USER_API_CANARY_NAME,
      runtimeVersion: 'syn-nodejs-puppeteer-15.0',
      schedule: {
        // Every 15 min between 13:00 and 23:59 UTC (≈ 8 AM–8 PM ET, ~12 hrs/day)
        expression: 'cron(0/15 13-23 ? * * *)',
        durationInSeconds: '0',
      },
      code: {
        handler: 'index.handler',
        script: fs.readFileSync(USER_API_CANARY_SCRIPT_PATH, 'utf8').trim(),
      },
      runConfig: {
        timeoutInSeconds: 180,
        environmentVariables: {
          API_URL: `https://${props.api.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}/prod/`,
          USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
          SMOKE_TEST_SECRET_NAME: props.smokeTestSecretName ?? '',
          SMOKE_TEST_FIXTURES_SECRET_NAME: props.smokeTestFixturesSecretName ?? '',
          SMOKE_TEST_WRITE_CHECKS: props.smokeTestWriteChecksEnabled ? 'true' : 'false',
          // C1.9: the bills and congress members manifest age checks are gone (both read the API's
          // generatedAt, which is the request time); only the weekly digest age is checked.
          MAX_WEEKLY_DIGEST_AGE_SECONDS: '691200',
        },
      },
      artifactS3Location: `s3://${canaryArtifactsBucket.bucketName}/canary/`,
      executionRoleArn: canaryRole.roleArn,
      startCanaryAfterCreation: true,
      successRetentionPeriod: 14,
      failureRetentionPeriod: 14,
    });

    // Synthetics creates the canary's Lambda log group itself, with no retention.
    // LogRetention sets the policy on that existing group (or creates it first).
    // Its default role is granted logs:PutRetentionPolicy on "*". This role limits it to
    // Lambda log groups (the canary's and the handler's own, whose name is generated), and
    // withoutPolicyUpdates() stops CDK adding the wildcard statement back.
    const canaryLogRetentionRole = new iam.Role(scope, 'UserApiCanaryLogRetentionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        LambdaLogGroupRetention: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy'],
              resources: [
                stack.formatArn({
                  service: 'logs',
                  resource: 'log-group',
                  resourceName: '/aws/lambda/*',
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
              ],
            }),
          ],
        }),
      },
    });
    new logs.LogRetention(scope, 'UserApiCanaryLogRetention', {
      logGroupName: cdk.Fn.join('', ['/aws/lambda/cwsyn-', USER_API_CANARY_NAME, '-', this.canary.attrId]),
      retention: logs.RetentionDays.ONE_MONTH,
      role: canaryLogRetentionRole.withoutPolicyUpdates(),
    });

    // Alarm: fire when SuccessPercent < 34% in a 45-min window (= ≥2 of 3 runs failed)
    this.alarm = new cloudwatch.Alarm(scope, 'SyntheticsCanaryAlarm', {
      alarmDescription: 'CloudWatch Synthetics canary: 2+ of last 3 runs failed',
      metric: new cloudwatch.Metric({
        namespace: 'CloudWatchSynthetics',
        metricName: 'SuccessPercent',
        dimensionsMap: { CanaryName: USER_API_CANARY_NAME },
        statistic: 'Average',
        period: cdk.Duration.minutes(45),
      }),
      threshold: 34,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    });
    // The alarm references the canary resource so it isn't created before the canary
    this.alarm.node.addDependency(this.canary);
  }
}
