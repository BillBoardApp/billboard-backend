import {
  BILL_STORE_BUCKET_NAME,
  CONGRESS_MEMBER_STORE_BUCKET_NAME,
  LAMBDA_ARTIFACTS_BUCKET_NAME,
} from '../../lib/config/deployment-identity';
import { GITHUB_PLATFORM_MAIN_SUBJECT, GITHUB_PUBLIC_PRODUCTION_SUBJECT } from '../../lib/stacks/github-oidc';
import type { Json, SynthesizedAppStack } from './synth-app';

/**
 * Normalized identity permissions of every IAM role in the app (CQ-15).
 *
 * Every Allow/Deny statement attached to a role is expanded into resource → actions, with each
 * resource resolved to a stable string: a cross-stack Fn::ImportValue is replaced by the exported
 * value, a DynamoDB table, S3 bucket, SQS queue or Lambda function referenced through Fn::GetAtt or
 * Ref becomes the ARN (or name) its fixed physical name gives, the account and region become
 * ${Account} and ${Region}, the deployment's own names (deployment-identity.ts: the fixed bucket names
 * and the GitHub OIDC subjects) become placeholders such as ${BillStoreBucket}, and anything else stays
 * symbolic (`<Stack/LogicalId.Attribute>`). The
 * same grant therefore normalizes to the same entry whether it names a table through an export, a
 * same-stack reference or a fixed-name ARN, and whichever stack holds the policy.
 *
 * Roles are keyed by the function names that use them (`fn:UserMatcher`), the canary name, or
 * `role:Stack/LogicalId` for roles no function uses.
 */
export type RolePermissions = Record<string, Record<string, string[]>>;

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const PARTITION = 'aws';

/** The deployment's own names and the placeholders the permissions show instead (longest first). */
const DEPLOYMENT_NAMES: ReadonlyArray<readonly [string, string]> = [
  [GITHUB_PUBLIC_PRODUCTION_SUBJECT, '${GitHubPublicProductionSubject}'],
  [GITHUB_PLATFORM_MAIN_SUBJECT, '${GitHubPlatformMainSubject}'],
  [CONGRESS_MEMBER_STORE_BUCKET_NAME, '${CongressMemberStoreBucket}'],
  [LAMBDA_ARTIFACTS_BUCKET_NAME, '${LambdaArtifactsBucket}'],
  [BILL_STORE_BUCKET_NAME, '${BillStoreBucket}'],
];
const URL_SUFFIX = 'amazonaws.com';

class Resolver {
  private readonly stacks = new Map<string, SynthesizedAppStack>();
  private readonly exported = new Map<string, { stack: string; value: unknown }>();

  constructor(stacks: SynthesizedAppStack[]) {
    stacks.forEach((stack) => this.stacks.set(stack.name, stack));
    stacks.forEach((stack) =>
      Object.values((stack.template.Outputs ?? {}) as Record<string, Json>)
        .filter((output) => output.Export)
        .forEach((output) => this.exported.set(output.Export.Name, { stack: stack.name, value: output.Value })),
    );
  }

  private resource(stack: string, logicalId: string): Json | undefined {
    return this.stacks.get(stack)?.template.Resources?.[logicalId];
  }

  private literal(stack: string, value: unknown): string | undefined {
    const resolved = this.resolve(stack, value);
    return typeof resolved === 'string' && !resolved.includes('<') ? resolved : undefined;
  }

  private getAtt(stack: string, logicalId: string, attribute: string): string {
    const resource = this.resource(stack, logicalId);
    const properties = resource?.Properties ?? {};
    const account = '${Account}';
    const region = '${Region}';
    switch (resource?.Type) {
      case 'AWS::DynamoDB::Table': {
        const name = this.literal(stack, properties.TableName);
        if (name && attribute === 'Arn') return `arn:${PARTITION}:dynamodb:${region}:${account}:table/${name}`;
        if (name && attribute === 'StreamArn') return `arn:${PARTITION}:dynamodb:${region}:${account}:table/${name}/stream/<label>`;
        break;
      }
      case 'AWS::S3::Bucket': {
        const name = this.literal(stack, properties.BucketName);
        if (name && attribute === 'Arn') return `arn:${PARTITION}:s3:::${name}`;
        break;
      }
      case 'AWS::SQS::Queue': {
        const name = this.literal(stack, properties.QueueName);
        if (name && attribute === 'Arn') return `arn:${PARTITION}:sqs:${region}:${account}:${name}`;
        if (name && attribute === 'QueueName') return name;
        break;
      }
      case 'AWS::Lambda::Function': {
        const name = this.literal(stack, properties.FunctionName);
        if (name && attribute === 'Arn') return `arn:${PARTITION}:lambda:${region}:${account}:function:${name}`;
        break;
      }
      default:
        break;
    }
    return `<${stack}/${logicalId}.${attribute}>`;
  }

  private ref(stack: string, logicalId: string): string {
    const pseudo: Record<string, string> = {
      'AWS::AccountId': '${Account}',
      'AWS::Region': '${Region}',
      'AWS::Partition': PARTITION,
      'AWS::URLSuffix': URL_SUFFIX,
      'AWS::StackName': stack,
    };
    if (logicalId in pseudo) return pseudo[logicalId];
    const resource = this.resource(stack, logicalId);
    const properties = resource?.Properties ?? {};
    const nameProperty: Record<string, string> = {
      'AWS::DynamoDB::Table': 'TableName',
      'AWS::S3::Bucket': 'BucketName',
      'AWS::Lambda::Function': 'FunctionName',
      'AWS::IAM::Role': 'RoleName',
    };
    const name = resource && nameProperty[resource.Type] ? this.literal(stack, properties[nameProperty[resource.Type]]) : undefined;
    if (name) return name;
    if (resource?.Type === 'AWS::SQS::Queue') {
      const queueName = this.literal(stack, properties.QueueName);
      if (queueName) return `https://sqs.\${Region}.${URL_SUFFIX}/\${Account}/${queueName}`;
    }
    if (resource?.Type === 'AWS::Lambda::Alias') {
      const functionName = this.literal(stack, properties.FunctionName);
      if (functionName) return `arn:${PARTITION}:lambda:\${Region}:\${Account}:function:${functionName}:${properties.Name}`;
    }
    return `<${stack}/${logicalId}>`;
  }

  resolve(stack: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.resolve(stack, item));
    if (typeof value === 'string') return this.anonymize(stack, value);
    if (value === null || typeof value !== 'object') return value;
    const entries = Object.entries(value as Json);
    if (entries.length === 1) {
      const [key, argument] = entries[0];
      switch (key) {
        case 'Ref':
          return this.ref(stack, argument);
        case 'Fn::GetAtt': {
          const [logicalId, attribute] = typeof argument === 'string' ? argument.split(/\.(.*)/) : argument;
          return this.getAtt(stack, logicalId, attribute);
        }
        case 'Fn::ImportValue': {
          const name = this.resolve(stack, argument) as string;
          const exported = this.exported.get(name);
          return exported ? this.resolve(exported.stack, exported.value) : `<import:${name}>`;
        }
        case 'Fn::Join': {
          const [separator, parts] = argument as [string, unknown[]];
          return asArray(this.resolve(stack, parts))
            .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
            .join(separator);
        }
        case 'Fn::Select': {
          const [index, list] = argument as [unknown, unknown];
          const resolvedList = this.resolve(stack, list);
          const resolvedIndex = Number(this.resolve(stack, index));
          return Array.isArray(resolvedList) ? resolvedList[resolvedIndex] : `<select ${resolvedIndex} ${JSON.stringify(resolvedList)}>`;
        }
        case 'Fn::Split': {
          const [separator, source] = argument as [string, unknown];
          const resolvedSource = this.resolve(stack, source);
          return typeof resolvedSource === 'string' ? resolvedSource.split(separator) : `<split ${JSON.stringify(resolvedSource)}>`;
        }
        default:
          break;
      }
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, this.resolve(stack, item)]));
  }

  // Literal account and region (from the stack's environment) read the same as the pseudo parameters.
  private anonymize(stack: string, value: string): string {
    const environment = this.stacks.get(stack);
    let result = value;
    if (environment && !environment.account.startsWith('unknown')) result = result.split(environment.account).join('${Account}');
    if (environment && !environment.region.startsWith('unknown')) result = result.split(environment.region).join('${Region}');
    DEPLOYMENT_NAMES.forEach(([name, placeholder]) => {
      result = result.split(name).join(placeholder);
    });
    return result;
  }
}

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Json)
      .sort()
      .map((key) => [key, sortKeysDeep((value as Json)[key])]),
  );
};

export const normalizedRolePermissions = (stacks: SynthesizedAppStack[]): RolePermissions => {
  const resolver = new Resolver(stacks);
  const identities = new Map<string, string>(); // `${stack}/${roleLogicalId}` → identity

  stacks.forEach((stack) => {
    const resources = (stack.template.Resources ?? {}) as Record<string, Json>;
    const users = new Map<string, string[]>();
    Object.entries(resources).forEach(([logicalId, resource]) => {
      const properties = resource.Properties ?? {};
      const [roleArn, label] =
        resource.Type === 'AWS::Lambda::Function'
          ? [properties.Role, `fn:${resolver.resolve(stack.name, properties.FunctionName) ?? ''}`]
          : resource.Type === 'AWS::Synthetics::Canary'
            ? [properties.ExecutionRoleArn, `canary:${resolver.resolve(stack.name, properties.Name) ?? ''}`]
            : [undefined, ''];
      const roleId = roleArn?.['Fn::GetAtt']?.[0];
      if (!roleId) return;
      const name = /^(fn|canary):[^<]+$/.test(label) && !label.endsWith(':') ? label : `${stack.name}/${logicalId}`;
      users.set(roleId, [...(users.get(roleId) ?? []), name]);
    });
    Object.entries(resources)
      .filter(([, resource]) => resource.Type === 'AWS::IAM::Role')
      .forEach(([logicalId]) =>
        identities.set(`${stack.name}/${logicalId}`, users.get(logicalId)?.sort().join('+') ?? `role:${stack.name}/${logicalId}`),
      );
  });

  const permissions: RolePermissions = {};
  const add = (identity: string, key: string, action: string) => {
    const byResource = (permissions[identity] ??= {});
    byResource[key] = [...new Set([...(byResource[key] ?? []), action])].sort();
  };
  const addDocument = (stack: string, identity: string, document: unknown) => {
    const resolved = resolver.resolve(stack, document) as Json;
    asArray<Json>(resolved?.Statement).forEach((statement) => {
      const condition = statement.Condition ? ` if ${JSON.stringify(sortKeysDeep(statement.Condition))}` : '';
      const effect = statement.Effect === 'Allow' ? '' : `${statement.Effect} `;
      const actions = statement.NotAction ? asArray<string>(statement.NotAction).map((action) => `NotAction:${action}`) : asArray<string>(statement.Action);
      const resources = statement.NotResource
        ? asArray<string>(statement.NotResource).map((resource) => `NotResource:${resource}`)
        : asArray<string>(statement.Resource ?? '*');
      resources.forEach((resource) =>
        actions.forEach((action) => add(identity, `${effect}${typeof resource === 'string' ? resource : JSON.stringify(resource)}${condition}`, action)),
      );
    });
  };

  stacks.forEach((stack) => {
    Object.entries((stack.template.Resources ?? {}) as Record<string, Json>).forEach(([logicalId, resource]) => {
      const properties = resource.Properties ?? {};
      if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
        asArray<Json>(properties.Roles).forEach((role) => {
          const identity =
            (role?.Ref && identities.get(`${stack.name}/${role.Ref}`)) ?? `external-role:${JSON.stringify(resolver.resolve(stack.name, role))}`;
          addDocument(stack.name, identity, properties.PolicyDocument);
        });
      }
      if (resource.Type === 'AWS::IAM::Role') {
        const identity = identities.get(`${stack.name}/${logicalId}`)!;
        asArray<Json>(properties.Policies).forEach((policy) => addDocument(stack.name, identity, policy.PolicyDocument));
        asArray<unknown>(properties.ManagedPolicyArns).forEach((arn) =>
          add(identity, '(managed policies)', JSON.stringify(resolver.resolve(stack.name, arn))),
        );
        add(identity, '(trust policy)', JSON.stringify(sortKeysDeep(resolver.resolve(stack.name, properties.AssumeRolePolicyDocument))));
      }
    });
  });

  return Object.fromEntries(
    Object.keys(permissions)
      .sort()
      .map((identity) => [
        identity,
        Object.fromEntries(Object.keys(permissions[identity]).sort().map((key) => [key, permissions[identity][key]])),
      ]),
  );
};
