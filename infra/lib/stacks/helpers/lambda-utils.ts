import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { lambdaCodeFromRelease } from '../../release/lambda-artifacts';

export const DEFAULT_LAMBDA_MEMORY_MB = 256;
export const DEFAULT_LAMBDA_LOG_RETENTION = logs.RetentionDays.ONE_MONTH;
export const DEFAULT_LAMBDA_TRACING = lambda.Tracing.ACTIVE;

export interface ReleaseBackedLambdaProps
  extends Omit<
    lambda.FunctionProps,
    'code' | 'functionName' | 'handler' | 'logGroup' | 'logRetention' | 'runtime'
  > {
  readonly artifactName: string;
  readonly artifactZipFileName?: string;
  readonly artifactsBucket: s3.IBucket;
  readonly functionName: string;
  /**
   * Retention of the function's retained `/aws/lambda/<functionName>` log group.
   * Replaces CDK's deprecated `logRetention` custom resource.
   * @default DEFAULT_LAMBDA_LOG_RETENTION (one month)
   */
  readonly logRetention?: logs.RetentionDays;
  /** @default DEFAULT_LAMBDA_MEMORY_MB (256) */
  readonly memorySize?: number;
  /** @default DEFAULT_LAMBDA_TRACING (active X-Ray tracing) */
  readonly tracing?: lambda.Tracing;
}

export type ReleaseBackedLambdaFactoryProps = Omit<
  ReleaseBackedLambdaProps,
  'artifactName' | 'artifactsBucket' | 'functionName'
>;

export type ReleaseBackedLambdaFactory = (
  functionName: string,
  artifactName: string,
  lambdaProps?: ReleaseBackedLambdaFactoryProps,
) => lambda.Function;

export const createRetainedLambdaLogGroup = (
  scope: Construct,
  id: string,
  functionName: string,
  retention: logs.RetentionDays = DEFAULT_LAMBDA_LOG_RETENTION,
): logs.LogGroup =>
  new logs.LogGroup(scope, id, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

export const createReleasedNodeLambda = (
  scope: Construct,
  id: string,
  {
    artifactName,
    artifactZipFileName = `${artifactName}.zip`,
    artifactsBucket,
    functionName,
    // Destructured defaults also cover callers passing an explicit `undefined`.
    logRetention = DEFAULT_LAMBDA_LOG_RETENTION,
    memorySize = DEFAULT_LAMBDA_MEMORY_MB,
    tracing = DEFAULT_LAMBDA_TRACING,
    ...functionProps
  }: ReleaseBackedLambdaProps,
): lambda.Function =>
  new lambda.Function(scope, id, {
    functionName,
    logGroup: createRetainedLambdaLogGroup(
      scope,
      `${id}LogGroup`,
      functionName,
      logRetention,
    ),
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'dist/index.handler',
    code: lambdaCodeFromRelease(
      artifactsBucket,
      artifactName,
      artifactZipFileName,
    ),
    memorySize,
    tracing,
    ...functionProps,
  });

/**
 * @param defaults Props applied to every function the factory creates (for
 *   example a longer `logRetention` for a whole service). Per-call props are
 *   shallow-merged over them, so a per-call `environment` replaces the default one.
 */
export const createReleaseBackedLambdaFactory = (
  scope: Construct,
  artifactsBucket: s3.IBucket,
  defaults: ReleaseBackedLambdaFactoryProps = {},
): ReleaseBackedLambdaFactory =>
  (functionName, artifactName, lambdaProps = {}) =>
    createReleasedNodeLambda(scope, functionName, {
      artifactsBucket,
      functionName,
      artifactName,
      ...defaults,
      ...lambdaProps,
    });

export const grantCloudWatchMetricNamespaceWrite = (
  lambdaFunction: lambda.Function,
  namespace: string,
): void => {
  lambdaFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'cloudwatch:namespace': namespace,
        },
      },
    }),
  );
};
