import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export const createDummyLambdaFactory = (
  scope: Construct,
  // Matches the release-backed functions; newer CDK validation warns on deprecated runtimes.
  runtime: lambda.Runtime = lambda.Runtime.NODEJS_24_X,
) => (id: string): lambda.Function =>
  new lambda.Function(scope, id, {
    functionName: id,
    runtime,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {}'),
  });

export const createNamedQueue = (
  scope: Construct,
  id: string,
  queueName = id,
): sqs.Queue =>
  new sqs.Queue(scope, id, {
    queueName,
  });

// Flattens Fn::Join and shows references as ${...} ("::" becomes "_"), so the fixed-name ARN of a
// store table in an env-agnostic stack reads "arn:${AWS_Partition}:dynamodb:${AWS_Region}:...".
const renderResource = (value: unknown): string => {
  if (typeof value === 'string') return value;
  const intrinsic = value as Record<string, any>;
  if (intrinsic?.['Fn::Join']) {
    const [separator, parts] = intrinsic['Fn::Join'] as [string, unknown[]];
    return parts.map(renderResource).join(separator);
  }
  if (intrinsic?.Ref) return `\${${String(intrinsic.Ref).replace(/::/g, '_')}}`;
  if (intrinsic?.['Fn::GetAtt']) return `\${${[intrinsic['Fn::GetAtt']].flat().join('.')}}`;
  if (intrinsic?.['Fn::ImportValue']) return `\${import ${renderResource(intrinsic['Fn::ImportValue'])}}`;
  return JSON.stringify(value);
};

/**
 * The actions each statement grants on a data store (CQ-15: the service stacks name the store tables
 * and buckets by their fixed names), keyed "table/<name>", "table/<name>/index/*", "bucket/<name>" or
 * "bucket/<name>/*". Statements on any other resource are left out.
 */
export const storeActions = (statements: Array<Record<string, any>>): Record<string, string[]> => {
  const byResource: Record<string, Set<string>> = {};
  statements.forEach((statement) => {
    [statement.Resource].flat().map(renderResource).forEach((resource) => {
      const table = /:dynamodb:[^:]*:[^:]*:(table\/.+)$/.exec(resource);
      const bucket = /^arn:[^:]*:s3:::(.+)$/.exec(resource);
      const key = table ? table[1] : bucket ? `bucket/${bucket[1]}` : undefined;
      if (key) {
        [statement.Action].flat().forEach((action: string) => (byResource[key] ??= new Set()).add(action));
      }
    });
  });
  return Object.fromEntries(
    Object.keys(byResource).sort().map((key) => [key, [...byResource[key]].sort()]),
  );
};

/**
 * The statements scoped to partition key values with dynamodb:LeadingKeys, as { resource, actions,
 * condition }: resource is keyed like storeActions ("table/<name>"), actions are sorted, and condition
 * is the statement's whole Condition, so a test also sees any other condition on it.
 */
export const partitionScopedGrants = (
  statements: Array<Record<string, any>>,
): Array<{ resource: string; actions: string[]; condition: Record<string, any> }> =>
  statements
    .filter((statement) => JSON.stringify(statement.Condition ?? {}).includes('"dynamodb:LeadingKeys"'))
    .flatMap((statement) =>
      [statement.Resource].flat().map(renderResource).map((resource) => ({
        resource: /:dynamodb:[^:]*:[^:]*:(table\/.+)$/.exec(resource)?.[1] ?? resource,
        actions: [statement.Action].flat().sort(),
        condition: statement.Condition,
      })),
    );

/** The Condition that limits a grant to items whose partition key value is one of `partitionKeyValues`. */
export const leadingKeysCondition = (...partitionKeyValues: string[]): Record<string, any> => ({
  'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': partitionKeyValues },
});

export const isDataWrite = (action: string): boolean =>
  /^dynamodb:(Put|Update|Delete|BatchWrite)|^s3:(Put|Delete|Abort)/.test(action);

/** Every statement in the policies attached to the role of the function named `functionName`. */
export const roleStatementsOf = (template: Template, functionName: string): Array<Record<string, any>> => {
  const [fn] = Object.values(template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: functionName },
  }));
  const roleId: string = fn.Properties.Role['Fn::GetAtt'][0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((policy) => [policy.Properties.Roles].flat().some((role: { Ref?: string }) => role.Ref === roleId))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
};
