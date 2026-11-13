import { UNCONFIRMED_SIGNUP_CLEANUP_MODE } from '../lib/config/abuse-limits';
import { STORE_BUCKETS, STORE_TABLES } from '../lib/stacks/helpers/data-store-refs';
import { normalizedRolePermissions, type RolePermissions } from './helpers/iam-permissions';
import { Json, synthesizeApp } from './helpers/synth-app';

// CQ-15: the store stacks own the data tables and buckets and take no Lambda functions; each service
// stack grants its own functions access, naming the stores by their fixed names.

const stacks = synthesizeApp();
const stackNamed = (name: string) => {
  const stack = stacks.find((candidate) => candidate.name === name);
  expect(stack).toBeDefined();
  return stack!;
};
const resourcesOf = (name: string): Record<string, Json> => stackNamed(name).template.Resources ?? {};
const importsOf = (name: string): string[] =>
  [...new Set([...JSON.stringify(stackNamed(name).template).matchAll(/"Fn::ImportValue":"([^"]+)"/g)].map((match) => match[1]))].sort();

const STORE_STACKS = ['UserStoreStack', 'CongressStoreStack', 'AggregateDataStoreStack'];
const SERVICE_STACKS = [
  'CongressIntegrationServiceStack',
  'SummarizerServiceStack',
  'PriorityServiceStack',
  'NotificationServiceStack',
  'UserAPIServiceStack',
  'AnalyticsServiceStack',
];
// A stream ARN has no fixed name, so this is the one store export a service stack still imports.
const FEEDBACK_STREAM_EXPORT = 'UserStoreStack:ExportsOutputFnGetAttUserFeedbackTableAC038F20StreamArn7E26534C';

// REL-53: the two grants that UNCONFIRMED_SIGNUP_CLEANUP_MODE 'delete', and only it, adds to the cleanup role. The
// snapshot leaves them out, so it holds in either position; the test after it checks them against the constant.
const CLEANUP_ROLE = 'fn:CleanupOrphanedUsers';
const UNCONFIRMED_DELETE_GRANTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^<UserAPIServiceStack\/BillboardUserPool[0-9A-F]+\.Arn>$/, 'cognito-idp:AdminDeleteUser'],
  [/:table\/SignUpEmailClaims$/, 'dynamodb:DeleteItem'],
];
const isUnconfirmedDeleteGrant = (resource: string, action: string): boolean =>
  UNCONFIRMED_DELETE_GRANTS.some(([pattern, granted]) => pattern.test(resource) && action === granted);

const permissions = normalizedRolePermissions(stacks);

/** The permissions with the cleanup role's REL-53 delete grants taken out. */
const withoutUnconfirmedDeleteGrants = (all: RolePermissions): RolePermissions => ({
  ...all,
  [CLEANUP_ROLE]: Object.fromEntries(
    Object.entries(all[CLEANUP_ROLE]).map(([resource, actions]) => [
      resource,
      actions.filter((action) => !isUnconfirmedDeleteGrant(resource, action)),
    ]),
  ),
});

describe('data store grants (CQ-15)', () => {
  // The snapshot was recorded before the grants moved out of the store stacks, so it pins that every
  // role kept exactly the permissions it had. A deliberate IAM change updates it with `jest -u`.
  test('every role keeps the same normalized permissions', () => {
    expect(withoutUnconfirmedDeleteGrants(permissions)).toMatchSnapshot();
  });

  test("the cleanup role has AdminDeleteUser on the pool and DeleteItem on SignUpEmailClaims exactly while UNCONFIRMED_SIGNUP_CLEANUP_MODE is 'delete'", () => {
    const granted = Object.entries(permissions[CLEANUP_ROLE])
      .flatMap(([resource, actions]) => actions.filter((action) => isUnconfirmedDeleteGrant(resource, action)))
      .sort();
    expect(granted).toEqual(UNCONFIRMED_SIGNUP_CLEANUP_MODE === 'delete' ? ['cognito-idp:AdminDeleteUser', 'dynamodb:DeleteItem'] : []);
  });

  // APPF-23: every grant scoped to BillsManifest partitions, across all stacks. Only BillDiffer writes the
  // link lists and only PublishBillsManifest writes the groups row; the other new readers get the
  // groups row only, except UserMatcher, which resolves one bill's companion itself.
  test('the companion rows are reached only through these partition-scoped grants', () => {
    const scoped = Object.entries(normalizedRolePermissions(stacks)).flatMap(([identity, byResource]) =>
      Object.entries(byResource)
        .filter(([resource]) => resource.includes('dynamodb:LeadingKeys'))
        .map(([resource, actions]) => `${identity} ${resource.replace(/^arn:[^ ]*:table\//, 'table/')} -> ${actions.join(',')}`),
    );
    const groupsOnly = 'table/BillsManifest if {"ForAllValues:StringEquals":{"dynamodb:LeadingKeys":["BILL_COMPANION_GROUPS"]}}';
    expect(scoped.sort()).toEqual([
      'fn:BillDiffer table/BillsManifest if {"ForAllValues:StringEquals":{"dynamodb:LeadingKeys":["BILL_COMPANION_DECL"]}} -> dynamodb:DeleteItem,dynamodb:GetItem,dynamodb:PutItem',
      `fn:FetchBillStats ${groupsOnly} -> dynamodb:GetItem`,
      `fn:FetchCivicScore ${groupsOnly} -> dynamodb:GetItem`,
      `fn:FetchProcessedBill ${groupsOnly} -> dynamodb:GetItem`,
      `fn:PublishBillsManifest ${groupsOnly} -> dynamodb:PutItem`,
      'fn:UserMatcher table/BillsManifest if {"ForAllValues:StringEquals":{"dynamodb:LeadingKeys":["BILL_COMPANION_DECL"]}} -> dynamodb:Query',
      'fn:UserMatcher table/BillsManifest if {"ForAllValues:StringEquals":{"dynamodb:LeadingKeys":["BILL_COMPANION_GROUPS","BILL_GUID"]}} -> dynamodb:GetItem',
      'fn:UserMatcher table/BillsManifest if {"ForAllValues:StringEquals":{"dynamodb:LeadingKeys":["BILL_GUID"]}} -> dynamodb:BatchGetItem',
      `fn:UserNotifier ${groupsOnly} -> dynamodb:GetItem`,
    ]);
  });

  test('the fixed-name references cover every store table and bucket, with the same index grants', () => {
    const tables = STORE_STACKS.flatMap((stack) =>
      Object.values(resourcesOf(stack)).filter((resource) => resource.Type === 'AWS::DynamoDB::Table'),
    );
    expect(
      tables
        .map((table) => ({
          tableName: table.Properties.TableName,
          hasIndexes: Boolean(table.Properties.GlobalSecondaryIndexes?.length || table.Properties.LocalSecondaryIndexes?.length),
        }))
        .sort((left, right) => left.tableName.localeCompare(right.tableName)),
    ).toEqual(Object.values(STORE_TABLES).sort((left, right) => left.tableName.localeCompare(right.tableName)));

    const buckets = STORE_STACKS.flatMap((stack) =>
      Object.values(resourcesOf(stack))
        .filter((resource) => resource.Type === 'AWS::S3::Bucket')
        .map((bucket) => bucket.Properties.BucketName),
    );
    expect(buckets.sort()).toEqual(Object.values(STORE_BUCKETS).sort());
  });

  describe('no store stack references a service stack function', () => {
    const serviceFunctionNames = SERVICE_STACKS.flatMap((stack) =>
      Object.values(resourcesOf(stack))
        .filter((resource) => resource.Type === 'AWS::Lambda::Function')
        .map((fn) => fn.Properties.FunctionName)
        .filter((name): name is string => typeof name === 'string'),
    );

    test.each(STORE_STACKS)('%s imports only SharedInfraStack values', (stack) => {
      expect(importsOf(stack).filter((name) => !name.startsWith('SharedInfraStack:'))).toEqual([]);
    });

    test.each(STORE_STACKS)('%s attaches policies only to its own roles', (stack) => {
      const resources = resourcesOf(stack);
      const foreignRoles = Object.entries(resources)
        .filter(([, resource]) => resource.Type === 'AWS::IAM::Policy')
        .flatMap(([logicalId, policy]) =>
          [policy.Properties.Roles]
            .flat()
            .filter((role: Json) => resources[role?.Ref]?.Type !== 'AWS::IAM::Role')
            .map((role: Json) => `${logicalId} -> ${JSON.stringify(role)}`),
        );
      expect(foreignRoles).toEqual([]);
    });

    // INT-04: the AppAttest function and the AppAttest table share their name (C3 3.1 and 4.1), so a store
    // table's own name is not taken for a reference to a function; a function ARN still is.
    const storeTableNames = new Set<string>(Object.values(STORE_TABLES).map((table) => table.tableName));

    test('the AppAttest table and function share a name, which the next check allows for', () => {
      expect(serviceFunctionNames).toContain('AppAttest');
      expect(storeTableNames.has('AppAttest')).toBe(true);
      expect(serviceFunctionNames.filter((name) => storeTableNames.has(name))).toEqual(['AppAttest']);
    });

    test.each(STORE_STACKS)('%s names no service function', (stack) => {
      expect(serviceFunctionNames.length).toBeGreaterThan(40);
      const template = JSON.stringify(stackNamed(stack).template);
      expect(serviceFunctionNames.filter((name) =>
        (!storeTableNames.has(name) && template.includes(`"${name}"`)) || template.includes(`:function:${name}`))).toEqual([]);
    });
  });

  test('service stacks import nothing from a store stack except the feedback stream ARN', () => {
    const storeImports = SERVICE_STACKS.flatMap((stack) =>
      importsOf(stack)
        .filter((name) => STORE_STACKS.some((store) => name.startsWith(`${store}:`)))
        .map((name) => `${stack} <- ${name}`),
    );
    expect(storeImports).toEqual([`AnalyticsServiceStack <- ${FEEDBACK_STREAM_EXPORT}`]);
  });

  test('no service stack depends on a store stack except AnalyticsServiceStack on UserStoreStack (the stream)', () => {
    const dependencies = SERVICE_STACKS.flatMap((stack) =>
      stackNamed(stack)
        .dependencies.filter((dependency) => STORE_STACKS.includes(dependency))
        .map((dependency) => `${stack} -> ${dependency}`),
    );
    expect(dependencies).toEqual(['AnalyticsServiceStack -> UserStoreStack']);
  });

  // The transition exports and stack ordering for the switchover deploy went in switchover step U9f.
  test('the store stacks export only the feedback stream ARN', () => {
    const exported = STORE_STACKS.flatMap((stack) =>
      Object.values((stackNamed(stack).template.Outputs ?? {}) as Record<string, Json>)
        .filter((output) => output.Export)
        .map((output) => output.Export.Name),
    );
    expect(exported).toEqual([FEEDBACK_STREAM_EXPORT]);
  });
});
