import * as cdk from 'aws-cdk-lib';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface ProdAliasDeploymentResult {
  readonly alias: lambda.Alias;
  readonly deploymentGroup: codedeploy.LambdaDeploymentGroup;
  readonly errorAlarm: cloudwatch.Alarm;
  readonly aliasVersionParameterName: string;
}

/**
 * - `api`: request/response handlers. Uses the `deploymentConfig` passed in
 *   (the user API's 10% for 10 minutes canary, CON-08).
 * - `worker`: SQS, stream and scheduled consumers. Shifts all traffic at once,
 *   because retried transient errors are normal for them and would trip the
 *   one-error alarm during a canary bake.
 */
export type LambdaDeploymentKind = 'api' | 'worker';

export interface ProdAliasDeploymentOptions {
  /** @default 'api' */
  readonly deploymentKind?: LambdaDeploymentKind;
  /**
   * Metrics that count the invocations the function ends with a thrown error on purpose, each written just before
   * the throw: PreSignUpCheck refusing a sign-up under enforce, which Cognito needs as a thrown error. The alias
   * error alarm then watches Errors less their sum (each read as a 1-minute Sum, a minute without one as 0), so a
   * refusal never rolls a shift back and any other error still does. Lambda stamps Errors at the start of the
   * invocation and the metric line at its write, so a refusal whose two halves fall either side of a minute's
   * end can still count once (the trigger answers in under 3.5 seconds).
   * @default none: the alarm is on Errors alone
   */
  readonly intentionalErrorMetrics?: readonly cloudwatch.Metric[];
}

const ALIAS_ERROR_ALARM_PERIOD = cdk.Duration.minutes(1);

/**
 * The prod alias error alarm's metric: Errors (1-minute Sum), or with `intentionalErrorMetrics` the math
 * `errors - FILL(intentional0, 0) - ...`. Errors is left unfilled, so a minute with no invocation stays missing data.
 */
const aliasErrorAlarmMetric = (
  id: string,
  alias: lambda.Alias,
  intentionalErrorMetrics: readonly cloudwatch.Metric[],
): cloudwatch.IMetric => {
  const errors = alias.metricErrors({ period: ALIAS_ERROR_ALARM_PERIOD, statistic: 'Sum' });
  if (intentionalErrorMetrics.length === 0) return errors;
  const intentional = intentionalErrorMetrics.map((metric, index) => ({
    id: `intentional${index}`,
    metric: metric.with({ period: ALIAS_ERROR_ALARM_PERIOD, statistic: 'Sum' }),
  }));
  return new cloudwatch.MathExpression({
    expression: ['errors', ...intentional.map(({ id: metricId }) => `FILL(${metricId}, 0)`)].join(' - '),
    usingMetrics: Object.fromEntries([['errors', errors], ...intentional.map(({ id: metricId, metric }) => [metricId, metric])]),
    period: ALIAS_ERROR_ALARM_PERIOD,
    label: `${id} prod alias errors less intentional refusals`,
  });
};

export const prodAliasVersionParameterName = (functionName: string): string =>
  `/billboard/prod/lambda-alias-versions/${functionName}/prod`;

/**
 * CON-08: the API handlers' deployment config, CodeDeploy's built-in
 * `CodeDeployDefault.LambdaCanary10Percent10Minutes` (10% of traffic for 10 minutes, then 100%). It
 * replaced a custom 20% / 2-hour config. Being built in, it creates no resource: a deployment group names
 * it, and every account already has it. Rollback still fires on the group's alarms, but only inside the
 * 10 minutes, so the Synthetics canary alarm (2 of 3 fifteen-minute windows) can no longer trip a shift.
 */
export function billboardApiDeploymentConfig(): codedeploy.ILambdaDeploymentConfig {
  return codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_10MINUTES;
}

/**
 * Creates a `prod` alias, a per-alias error alarm, and a CodeDeploy deployment
 * group that manages traffic shifting and auto-rollback.
 *
 * The alias version is intentionally pinned through SSM instead of
 * `fn.currentVersion`. This keeps CloudFormation from moving production traffic
 * during stack updates; the release workflow starts CodeDeploy explicitly after
 * CloudFormation succeeds.
 *
 * @param scope    Stack scope (call from within the Lambda's stack)
 * @param id       Logical ID prefix (typically the Lambda function name)
 * @param fn       The Lambda function
 * @param application  CodeDeploy application for this service
 * @param deploymentConfig  Shared deployment config for this service; used for
 *                          `deploymentKind: 'api'` and ignored for `'worker'`
 * @param extraAlarms  Additional alarms to attach (API GW 5XX, Synthetics, etc.)
 * @param options      `deploymentKind` ('api' by default, or 'worker' for ALL_AT_ONCE), and
 *                     `intentionalErrorMetrics` (errors the alias error alarm does not count)
 */
export function addProdAliasWithDeployment(
  scope: Construct,
  id: string,
  fn: lambda.Function,
  application: codedeploy.LambdaApplication,
  deploymentConfig: codedeploy.ILambdaDeploymentConfig,
  extraAlarms: cloudwatch.IAlarm[] = [],
  options: ProdAliasDeploymentOptions = {},
): ProdAliasDeploymentResult {
  const deploymentKind = options.deploymentKind ?? 'api';
  const currentVersion = fn.currentVersion;
  currentVersion.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const aliasVersionParameterName = prodAliasVersionParameterName(fn.functionName);
  const aliasVersion = lambda.Version.fromVersionAttributes(scope, `${id}ProdAliasPinnedVersion`, {
    lambda: fn,
    version: `{{resolve:ssm:${aliasVersionParameterName}}}`,
  });

  const alias = new lambda.Alias(scope, `${id}ProdAlias`, {
    aliasName: 'prod',
    version: aliasVersion,
  });
  const cfnAlias = alias.node.defaultChild as lambda.CfnAlias;
  cfnAlias.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  // A brand-new function's pin is bootstrapped to "1"; version 1 must exist before the
  // alias. The pinned version comes from SSM, so CloudFormation cannot infer this order.
  alias.node.addDependency(currentVersion);

  const intentionalErrorMetrics = options.intentionalErrorMetrics ?? [];
  const errorAlarm = new cloudwatch.Alarm(scope, `${id}AliasErrorAlarm`, {
    alarmDescription: intentionalErrorMetrics.length === 0
      ? `${id} prod alias errors`
      : `${id} prod alias errors, less the invocations it fails on purpose (${intentionalErrorMetrics.map((metric) => metric.metricName).join(', ')})`,
    metric: aliasErrorAlarmMetric(id, alias, intentionalErrorMetrics),
    threshold: 1,
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  });

  const deploymentGroup = new codedeploy.LambdaDeploymentGroup(scope, `${id}DeploymentGroup`, {
    application,
    alias,
    deploymentConfig: deploymentKind === 'worker'
      ? codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE
      : deploymentConfig,
    autoRollback: {
      failedDeployment: true,
      stoppedDeployment: true,
      deploymentInAlarm: true,
    },
    alarms: [errorAlarm, ...extraAlarms],
  });

  cfnAlias.cfnOptions.updatePolicy = undefined;

  new cdk.CfnOutput(scope, `${id}LambdaReleaseTarget`, {
    value: cdk.Stack.of(scope).toJsonString({
      functionName: fn.functionName,
      aliasName: 'prod',
      targetVersion: currentVersion.version,
      applicationName: application.applicationName,
      deploymentGroupName: deploymentGroup.deploymentGroupName,
      aliasVersionParameterName,
    }),
  });

  return { alias, deploymentGroup, errorAlarm, aliasVersionParameterName };
}
