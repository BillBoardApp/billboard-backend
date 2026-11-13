import * as cdk from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME,
  CONGRESS_MEMBER_STATS_TABLE_NAME,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME,
} from '../../config/aggregate-data-store-constants';
import { APP_ATTEST_TABLE_NAME } from '../../config/app-attest-constants';
import {
  BILL_STORE_BUCKET_NAME,
  BILLS_MANIFEST_TABLE_NAME,
  CONGRESS_MEMBER_STORE_BUCKET_NAME,
  CONGRESS_MEMBERS_MANIFEST_TABLE_NAME,
} from '../../config/congress-store-constants';
import {
  SIGN_UP_EMAIL_CLAIMS_TABLE_NAME,
  USER_BILL_STATS_TABLE_NAME,
  USER_DEVICES_TABLE_NAME,
  USER_FEEDBACK_TABLE_NAME,
  USER_PII_TABLE_NAME,
  USER_PREFERENCES_TABLE_NAME,
  USER_WEEKLY_DIGESTS_TABLE_NAME,
  VERIFIED_ADDRESS_CLAIMS_TABLE_NAME,
} from '../../config/user-store-constants';

// CQ-15: UserStoreStack, CongressStoreStack and AggregateDataStoreStack own these tables and buckets
// and take no Lambda functions. Each service stack grants its own functions access, referencing the
// resources through their fixed names: a grant needs no cross-stack export, and adding a handler
// touches only its own stack.

export interface StoreTable {
  readonly tableName: string;
  /**
   * The table has a secondary index. A grant then also covers `<table ARN>/index/*`, exactly as a grant
   * on the owning `ddb.Table` does. test/data-store-grants.test.ts checks this against the store stacks.
   */
  readonly hasIndexes: boolean;
}

export const STORE_TABLES = {
  // UserStoreStack
  userPreferences: { tableName: USER_PREFERENCES_TABLE_NAME, hasIndexes: true },
  userDevices: { tableName: USER_DEVICES_TABLE_NAME, hasIndexes: true },
  userFeedback: { tableName: USER_FEEDBACK_TABLE_NAME, hasIndexes: true },
  billStats: { tableName: USER_BILL_STATS_TABLE_NAME, hasIndexes: false },
  userPii: { tableName: USER_PII_TABLE_NAME, hasIndexes: false },
  userWeeklyDigests: { tableName: USER_WEEKLY_DIGESTS_TABLE_NAME, hasIndexes: false },
  // INT-03's address claims and INT-05's sign-up email claims.
  verifiedAddressClaims: { tableName: VERIFIED_ADDRESS_CLAIMS_TABLE_NAME, hasIndexes: false },
  signUpEmailClaims: { tableName: SIGN_UP_EMAIL_CLAIMS_TABLE_NAME, hasIndexes: false },
  // INT-04's App Attest challenges, keys and account bindings.
  appAttest: { tableName: APP_ATTEST_TABLE_NAME, hasIndexes: false },
  // CongressStoreStack
  billsManifest: { tableName: BILLS_MANIFEST_TABLE_NAME, hasIndexes: false },
  congressMembersManifest: { tableName: CONGRESS_MEMBERS_MANIFEST_TABLE_NAME, hasIndexes: false },
  // AggregateDataStoreStack
  congressMemberStats: { tableName: CONGRESS_MEMBER_STATS_TABLE_NAME, hasIndexes: false },
  congressMemberVoteProfiles: { tableName: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME, hasIndexes: true },
  congressMemberLegislativeProfiles: { tableName: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME, hasIndexes: true },
} as const satisfies Record<string, StoreTable>;

export const STORE_BUCKETS = {
  // CongressStoreStack
  billStore: BILL_STORE_BUCKET_NAME,
  congressMemberStore: CONGRESS_MEMBER_STORE_BUCKET_NAME,
} as const satisfies Record<string, string>;

export type StoreTableKey = keyof typeof STORE_TABLES;
export type StoreBucketKey = keyof typeof STORE_BUCKETS;

const referenceId = (prefix: string, key: string): string => `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`;

// One reference per stack and resource; the reference itself adds nothing to the template.
const referenceOnce = <T>(scope: Construct, id: string, create: (stack: cdk.Stack) => T): T => {
  const stack = cdk.Stack.of(scope);
  return (stack.node.tryFindChild(id) as T | undefined) ?? create(stack);
};

/** A store table, referenced by its fixed name from the calling stack. */
export const storeTable = (scope: Construct, key: StoreTableKey): ddb.ITable => {
  const id = referenceId('StoreTable', key);
  return referenceOnce(scope, id, (stack) =>
    ddb.Table.fromTableAttributes(stack, id, {
      tableName: STORE_TABLES[key].tableName,
      grantIndexPermissions: STORE_TABLES[key].hasIndexes,
    }),
  );
};

/** DynamoDB item actions whose requests always name the partition key, so dynamodb:LeadingKeys can scope them. */
export type PartitionScopedAction = 'GetItem' | 'BatchGetItem' | 'Query' | 'PutItem' | 'UpdateItem' | 'DeleteItem';

/**
 * Grants item actions on a store table only for items whose partition key value is one of
 * `partitionKeyValues` (dynamodb:LeadingKeys), for a table that keeps different kinds of rows apart by
 * fixed partition values, like BillsManifest. Only keyed item actions are accepted: IAM evaluates
 * ForAllValues against a key the request does not carry as true, so a Scan granted this way would
 * read every partition.
 */
export const grantStoreTablePartitions = (
  grantee: iam.IGrantable,
  table: ddb.ITable,
  actions: readonly PartitionScopedAction[],
  partitionKeyValues: readonly string[],
): iam.Grant =>
  iam.Grant.addToPrincipal({
    grantee,
    actions: actions.map((action) => `dynamodb:${action}`),
    resourceArns: [table.tableArn],
    conditions: {
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [...partitionKeyValues] },
    },
  });

/** A store bucket, referenced by its fixed name from the calling stack. */
export const storeBucket = (scope: Construct, key: StoreBucketKey): s3.IBucket => {
  const id = referenceId('StoreBucket', key);
  return referenceOnce(scope, id, (stack) => s3.Bucket.fromBucketName(stack, id, STORE_BUCKETS[key]));
};
