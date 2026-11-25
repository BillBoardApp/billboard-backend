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
  CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_ATTRIBUTES,
  CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_NAME,
  CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_PRIMARY_KEY,
  CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_SORT_KEY,
  CONGRESS_MEMBER_VOTE_RECORD_TABLE_NAME,
  CONGRESS_MEMBER_VOTE_RECORD_TABLE_PRIMARY_KEY,
  CONGRESS_MEMBER_VOTE_RECORD_TABLE_SORT_KEY,
  CONGRESS_MEMBER_VOTE_RECORD_VOTED_ON_INDEX_NAME,
  CONGRESS_MEMBER_VOTE_RECORD_VOTED_ON_INDEX_SORT_KEY,
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

    // UX-39d: the members' public roll-call record, every position, for every bill with official votes. One row per
    // member, bill and chamber, so a newer roll call overwrites it.
    const congressMemberVoteRecordTable = new ddb.Table(this, 'CongressMemberVoteRecordTable', {
      partitionKey: { name: CONGRESS_MEMBER_VOTE_RECORD_TABLE_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: CONGRESS_MEMBER_VOTE_RECORD_TABLE_SORT_KEY, type: ddb.AttributeType.STRING },
      tableName: CONGRESS_MEMBER_VOTE_RECORD_TABLE_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    });

    // A member's rows newest first, for GET /congress-member-record's pages. A local index exists only if the table is
    // created with it.
    congressMemberVoteRecordTable.addLocalSecondaryIndex({
      indexName: CONGRESS_MEMBER_VOTE_RECORD_VOTED_ON_INDEX_NAME,
      sortKey: { name: CONGRESS_MEMBER_VOTE_RECORD_VOTED_ON_INDEX_SORT_KEY, type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    // A bill's rows, with the table keys and the values CongressMemberStats compares, so it deletes the rows the bill
    // no longer gives and writes only new or changed ones.
    congressMemberVoteRecordTable.addGlobalSecondaryIndex({
      indexName: CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_NAME,
      partitionKey: { name: CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_PRIMARY_KEY, type: ddb.AttributeType.STRING },
      sortKey: { name: CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_SORT_KEY, type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.INCLUDE,
      nonKeyAttributes: CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_ATTRIBUTES,
    });
  }
}
