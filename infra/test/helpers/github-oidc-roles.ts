import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHubOidcStack } from '../../lib/stacks/github-oidc';
import { DEPLOYMENT_ACCOUNT_ID, DEPLOYMENT_REGION, LAMBDA_ARTIFACTS_BUCKET_NAME } from '../../lib/config/deployment-identity';
import { synthesizedAppDirectory } from './synth-app';

/**
 * The GitHubOidcStack roles as the tests see them: the stack synthesized for the deployment's account and region, its
 * two roles and their statements, and the AWS calls the release scripts make. github-oidc.test.ts checks the roles
 * themselves; deploy-workflow.test.ts checks the deploy workflow against them.
 */

export const ACCOUNT = DEPLOYMENT_ACCOUNT_ID;
export const REGION = DEPLOYMENT_REGION;
export const PROVIDER_ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
export const BUCKET_ARN = `arn:aws:s3:::${LAMBDA_ARTIFACTS_BUCKET_NAME}`;
export const INFRA_ROOT = join(__dirname, '..', '..');

export type Statement = {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: unknown;
};

export type RoleResource = {
  Properties: {
    RoleName: string;
    MaxSessionDuration?: number;
    ManagedPolicyArns?: unknown[];
    AssumeRolePolicyDocument: { Statement: Statement[] };
    Policies?: { PolicyName: string; PolicyDocument: { Statement: Statement[] } }[];
  };
};

export type SessionPolicy = { Version: string; Statement: Statement[] };

export const synthOidcStack = (): Template => {
  // Same flag as cdk.json, so ARNs render with a literal `aws` partition.
  const app = new cdk.App({ context: { '@aws-cdk/core:enablePartitionLiterals': true } });
  const stack = new GitHubOidcStack(app, 'GitHubOidcStack', {
    env: { account: ACCOUNT, region: REGION },
  });
  return Template.fromStack(stack);
};

export const roleNamed = (template: Template, roleName: string): RoleResource => {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } });
  const values = Object.values(roles) as RoleResource[];
  expect(values).toHaveLength(1);
  return values[0];
};

export const statementsOf = (role: RoleResource): Statement[] =>
  (role.Properties.Policies ?? []).flatMap((policy) => policy.PolicyDocument.Statement);

export const asArray = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);

export const actionsOf = (role: RoleResource): Set<string> =>
  new Set(statementsOf(role).flatMap((statement) => asArray(statement.Action)));

// Maps an `aws <service> <operation>` CLI call to its IAM action.
const CLI_SERVICE_TO_IAM_PREFIX: Record<string, string> = {
  cloudwatch: 'cloudwatch',
  deploy: 'codedeploy',
  lambda: 'lambda',
  s3api: 's3',
  ssm: 'ssm',
  sts: 'sts',
};
const S3API_OPERATION_TO_ACTION: Record<string, string> = {
  'get-object': 's3:GetObject',
  'head-object': 's3:GetObject',
  'list-objects-v2': 's3:ListBucket',
};
export const toIamAction = (service: string, operation: string): string => {
  if (service === 's3api') {
    return S3API_OPERATION_TO_ACTION[operation] ?? `s3:${operation}`;
  }
  const pascal = operation.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  return `${CLI_SERVICE_TO_IAM_PREFIX[service] ?? service}:${pascal}`;
};

// `aws(['service', 'operation', ...])` in the release scripts.
export const scriptAwsCalls = (): string[] => {
  const calls = new Set<string>();
  const scriptsDir = join(INFRA_ROOT, 'scripts');
  for (const file of readdirSync(scriptsDir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(join(scriptsDir, file), 'utf8');
    for (const match of source.matchAll(/\baws\(\s*\[\s*'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'/g)) {
      calls.add(toIamAction(match[1], match[2]));
    }
  }
  return [...calls].sort();
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** IAM resource matching: `*` spans any characters, `?` one. */
const iamResourceMatches = (pattern: string, value: string): boolean =>
  new RegExp(`^${pattern.split('*').map((part) => part.split('?').map(escapeRegExp).join('.')).join('.*')}$`).test(value);

/** True when one of the role's statements allows `action` on `resource`. */
export const roleAllows = (role: RoleResource, action: string, resource: string): boolean =>
  statementsOf(role).some(
    (statement) =>
      asArray(statement.Action).includes(action) &&
      asArray(statement.Resource).some((pattern) => iamResourceMatches(pattern, resource)),
  );

type Json = Record<string, any>;

/** The real app synthesized for the deployment's account and region, whatever the shell's AWS settings. */
export const appDirectory = (): string => {
  const saved = { CDK_DEFAULT_ACCOUNT: process.env.CDK_DEFAULT_ACCOUNT, CDK_DEFAULT_REGION: process.env.CDK_DEFAULT_REGION };
  process.env.CDK_DEFAULT_ACCOUNT = ACCOUNT;
  process.env.CDK_DEFAULT_REGION = REGION;
  try {
    return synthesizedAppDirectory();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

/**
 * The CDK bootstrap roles the CLI assumes for the real app, read from its cloud assembly the way
 * `cdk diff` and `cdk deploy` read cdk.out: each stack's deploy and lookup role and each asset's publishing
 * role. The CloudFormation execution role is passed to CloudFormation, never assumed by the CLI.
 */
export const bootstrapRolesOfApp = (): { roles: string[]; additionalOptions: unknown[] } => {
  const directory = appDirectory();
  const readJson = (file: string): Json => JSON.parse(readFileSync(join(directory, file), 'utf8')) as Json;
  const roles = new Set<string>();
  const additionalOptions: unknown[] = [];
  const add = (arn: string | undefined, options: unknown): void => {
    if (arn) {
      roles.add(arn.replace('${AWS::Partition}', 'aws'));
    }
    if (options !== undefined) {
      additionalOptions.push(options);
    }
  };
  for (const artifact of Object.values(readJson('manifest.json').artifacts as Record<string, Json>)) {
    const properties: Json = artifact.properties ?? {};
    if (artifact.type === 'aws:cloudformation:stack') {
      add(properties.assumeRoleArn, properties.assumeRoleAdditionalOptions);
      add(properties.lookupRole?.arn, properties.lookupRole?.assumeRoleAdditionalOptions);
    } else if (artifact.type === 'cdk:asset-manifest') {
      const assets = readJson(properties.file as string);
      for (const asset of [...Object.values(assets.files ?? {}), ...Object.values(assets.dockerImages ?? {})] as Json[]) {
        for (const destination of Object.values(asset.destinations as Record<string, Json>)) {
          add(destination.assumeRoleArn, destination.assumeRoleAdditionalOptions);
        }
      }
    }
  }
  return { roles: [...roles].sort(), additionalOptions };
};
