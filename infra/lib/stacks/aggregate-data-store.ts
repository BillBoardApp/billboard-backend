import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import {
  CONGRESS_MEMBER_STATS_TABLE_NAME,
  CONGRESS_MEMBER_STATS_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SORT_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_SORT_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_TABLE_SORT_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_NAME,
  CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY,
  CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_SORT_KEY,
} from '../config/aggregate-data-store-constants';

/**
 * The aggregate member tables. AnalyticsServiceStack and UserAPIServiceStack grant their own functions
 * access by table name (CQ-15), so this stack takes no Lambda functions.
 */
export type AggregateDataStoreStackProps = cdk.StackProps;

export class AggregateDataStoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AggregateDataStoreStackProps = {}) {
    super(scope, id, props);

    const congressMemberStatsTable = new ddb.Table(this, 'CongressMemberStatsTable', {
      partitionKey: { name: CONGRESS_MEMBER_STATS_TABLE_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      tableName: CONGRESS_MEMBER_STATS_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    const congressMemberVoteProfilesTable = new ddb.Table(this, 'CongressMemberVoteProfilesTable', {
      partitionKey: { name: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    congressMemberVoteProfilesTable.addGlobalSecondaryIndex({
      indexName: CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_NAME,
      partitionKey: { name: CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_SORT_KEY, type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.KEYS_ONLY,
    });

    const congressMemberLegislativeProfilesTable = new ddb.Table(this, 'CongressMemberLegislativeProfilesTable', {
      partitionKey: { name: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    congressMemberLegislativeProfilesTable.addGlobalSecondaryIndex({
      indexName: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME,
      partitionKey: { name: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SORT_KEY, type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.KEYS_ONLY,
    });
  }
}
