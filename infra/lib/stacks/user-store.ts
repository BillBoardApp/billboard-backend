import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import {
  APP_ATTEST_PARTITION_KEY,
  APP_ATTEST_SORT_KEY,
  APP_ATTEST_TABLE_NAME,
  APP_ATTEST_TTL_ATTRIBUTE,
} from '../config/app-attest-constants';
import {
  SIGN_UP_EMAIL_CLAIMS_PARTITION_KEY,
  SIGN_UP_EMAIL_CLAIMS_TABLE_NAME,
  USER_BILL_STATS_PARTITION_KEY,
  USER_BILL_STATS_TABLE_NAME,
  USER_PARTITION_KEY,
  USER_PREFERENCES_TABLE_NAME,
  USER_PREFERENCES_SORT_KEY,
  USER_PREFERENCES_SUB_CATEGORY_INDEX,
  USER_DEVICES_TABLE_NAME,
  USER_DEVICES_SORT_KEY,
  USER_DEVICES_PUSH_TOKEN_ATTRIBUTE,
  USER_DEVICES_PUSH_TOKEN_INDEX,
  USER_FEEDBACK_BILL_ID_INDEX,
  USER_FEEDBACK_TABLE_NAME,
  USER_PII_TABLE_NAME,
  USER_FEEDBACK_SORT_KEY,
  USER_WEEKLY_DIGESTS_SORT_KEY,
  USER_WEEKLY_DIGESTS_TABLE_NAME,
  USER_WEEKLY_DIGESTS_TTL_ATTRIBUTE,
  VERIFIED_ADDRESS_CLAIMS_PARTITION_KEY,
  VERIFIED_ADDRESS_CLAIMS_SORT_KEY,
  VERIFIED_ADDRESS_CLAIMS_TABLE_NAME,
} from '../config/user-store-constants';

/**
 * The user tables. The service stacks grant their own functions access by table name (CQ-15), so this
 * stack takes no Lambda functions.
 */
export type UserStoreStackProps = cdk.StackProps;

export class UserStoreStack extends cdk.Stack {
  /** AnalyticsServiceStack's BillStatsAggregator reads this stream; a stream ARN has no fixed name. */
  public readonly feedbackTableStreamArn: string;

  constructor(scope: Construct, id: string, props: UserStoreStackProps = {}) {
    super(scope, id, props);

    const preferencesTable = new ddb.Table(this, 'UserPreferencesTable', {
      partitionKey: { name: USER_PARTITION_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: USER_PREFERENCES_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: USER_PREFERENCES_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });
    preferencesTable.addGlobalSecondaryIndex({
      indexName: USER_PREFERENCES_SUB_CATEGORY_INDEX,
      partitionKey: { name: USER_PREFERENCES_SORT_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: USER_PARTITION_KEY, type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.KEYS_ONLY,
    });

    const devicesTable = new ddb.Table(this, 'DevicesTable', {
      partitionKey: { name: USER_PARTITION_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: USER_DEVICES_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: USER_DEVICES_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });
    // Lets registerUserDevice find other accounts holding the same push token
    // without scanning the table.
    devicesTable.addGlobalSecondaryIndex({
      indexName: USER_DEVICES_PUSH_TOKEN_INDEX,
      partitionKey: { name: USER_DEVICES_PUSH_TOKEN_ATTRIBUTE, type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.KEYS_ONLY,
    });

    const feedbackTable = new ddb.Table(this, 'UserFeedbackTable', {
      partitionKey: { name: USER_PARTITION_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: USER_FEEDBACK_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: USER_FEEDBACK_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      stream: ddb.StreamViewType.NEW_IMAGE,
    });
    this.feedbackTableStreamArn = feedbackTable.tableStreamArn!;
    feedbackTable.addGlobalSecondaryIndex({
      indexName: USER_FEEDBACK_BILL_ID_INDEX,
      partitionKey: { name: USER_FEEDBACK_SORT_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: USER_PARTITION_KEY, type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    const billStatsTable = new ddb.Table(this, 'BillStatsTable', {
      partitionKey: { name: USER_BILL_STATS_PARTITION_KEY, type: ddb.AttributeType.STRING },
      tableName: USER_BILL_STATS_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    const piiTable = new ddb.Table(this, 'PIITable', {
      partitionKey: { name: USER_PARTITION_KEY, type: ddb.AttributeType.STRING },
      tableName: USER_PII_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    const weeklyDigestsTable = new ddb.Table(this, 'UserWeeklyDigestsTable', {
      partitionKey: { name: USER_PARTITION_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: USER_WEEKLY_DIGESTS_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: USER_WEEKLY_DIGESTS_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: USER_WEEKLY_DIGESTS_TTL_ATTRIBUTE,
    });

    // INT-03 (C2 3.3.2): one claim per verified account at an address (address + unit), with a counter per
    // unit and per street address. Keys are salted hashes; no address is stored. No stream, TTL or index:
    // DistrictVerification reads and writes items by key only.
    new ddb.Table(this, 'VerifiedAddressClaimsTable', {
      partitionKey: { name: VERIFIED_ADDRESS_CLAIMS_PARTITION_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: VERIFIED_ADDRESS_CLAIMS_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: VERIFIED_ADDRESS_CLAIMS_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    // INT-05 (C2 3.5 with X5): one claim per base email address, as two items written in one transaction
    // (EMAIL#<emailKey> and USER#<userName>), so account deletion can find and release it. No email is stored.
    new ddb.Table(this, 'SignUpEmailClaimsTable', {
      partitionKey: { name: SIGN_UP_EMAIL_CLAIMS_PARTITION_KEY, type: ddb.AttributeType.STRING },
      tableName: SIGN_UP_EMAIL_CLAIMS_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    // INT-04 (C3 4.1): App Attest challenges, attested keys and account bindings, all on pk/sk (see
    // app-attest-constants.ts). Challenges, keys and bindings expire through the TTL. No stream and no index:
    // the functions read and write items by key, and account deletion queries one USER#<sub> partition. It
    // holds no email, token or full device identifier; a key row holds no account ID.
    new ddb.Table(this, 'AppAttestTable', {
      partitionKey: { name: APP_ATTEST_PARTITION_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: APP_ATTEST_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: APP_ATTEST_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: APP_ATTEST_TTL_ATTRIBUTE,
    });
  }
}
