import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  BILLS_MANIFEST_COMPANION_DECL_PK_VALUE,
  BILLS_MANIFEST_COMPANION_GROUPS_PK_VALUE,
  BILLS_MANIFEST_GUID_LOOKUP_PK_VALUE,
  BILLS_MANIFEST_TABLE_NAME,
  BILLS_MANIFEST_TABLE_PRIMARY_KEY,
} from '../../config/congress-store-constants';
import { grantStoreTablePartitions, storeTable } from './data-store-refs';

// APPF-23 companion bills. The link lists (BILL_COMPANION_DECL rows) and the resolved groups
// (BILL_COMPANION_GROUPS / CURRENT) live in BillsManifest; each function is granted only the
// partitions it uses, from its own service stack (CQ-15).

/**
 * What services/src/adapters/billCompanionDao.ts reads. MANIFEST_TABLE_NAME is always set because the
 * DAO falls back to TABLE_NAME, which names another table in most of these functions; with it set, the
 * DAO takes the key attribute from MANIFEST_PRIMARY_KEY, never from PRIMARY_KEY (which describes the
 * function's own table where it is set).
 */
export const BILL_COMPANION_ENVIRONMENT = {
  MANIFEST_TABLE_NAME: BILLS_MANIFEST_TABLE_NAME,
  MANIFEST_PRIMARY_KEY: BILLS_MANIFEST_TABLE_PRIMARY_KEY,
  MANIFEST_COMPANION_DECL_PK: BILLS_MANIFEST_COMPANION_DECL_PK_VALUE,
  MANIFEST_COMPANION_GROUPS_PK: BILLS_MANIFEST_COMPANION_GROUPS_PK_VALUE,
  GUID_LOOKUP_PK: BILLS_MANIFEST_GUID_LOOKUP_PK_VALUE,
} as const;

/** getCurrentGroups: GetItem on the groups row, and nothing else in BillsManifest. */
export const grantCompanionGroupsRead = (scope: Construct, grantee: iam.IGrantable): iam.Grant =>
  grantStoreTablePartitions(
    grantee,
    storeTable(scope, 'billsManifest'),
    ['GetItem'],
    [BILLS_MANIFEST_COMPANION_GROUPS_PK_VALUE],
  );

/** BillDiffer: reads, conditionally puts and deletes one bill's link list. */
export const grantCompanionDeclarationsWrite = (scope: Construct, grantee: iam.IGrantable): iam.Grant =>
  grantStoreTablePartitions(
    grantee,
    storeTable(scope, 'billsManifest'),
    ['GetItem', 'PutItem', 'DeleteItem'],
    [BILLS_MANIFEST_COMPANION_DECL_PK_VALUE],
  );

/** PublishBillsManifest: the versioned PutItem of the groups row. It reads through its manifest read grant. */
export const grantCompanionGroupsWrite = (scope: Construct, grantee: iam.IGrantable): iam.Grant =>
  grantStoreTablePartitions(
    grantee,
    storeTable(scope, 'billsManifest'),
    ['PutItem'],
    [BILLS_MANIFEST_COMPANION_GROUPS_PK_VALUE],
  );

/**
 * UserMatcher's "new" suppression, and only the reads it makes: getCurrentGroups (GetItem on the groups
 * row), resolveFresh (a Query of the link lists and a BatchGetItem of the BILL_GUID lookup rows for held
 * checks) and each member's manifest updatedAt (GetItem on its BILL_GUID lookup row). Nothing on the
 * BILL rows, no Scan and no writes.
 */
export const grantCompanionResolverRead = (scope: Construct, grantee: iam.IGrantable): iam.Grant => {
  const manifest = storeTable(scope, 'billsManifest');
  return grantStoreTablePartitions(
    grantee,
    manifest,
    ['GetItem'],
    [BILLS_MANIFEST_COMPANION_GROUPS_PK_VALUE, BILLS_MANIFEST_GUID_LOOKUP_PK_VALUE],
  )
    .combine(grantStoreTablePartitions(grantee, manifest, ['Query'], [BILLS_MANIFEST_COMPANION_DECL_PK_VALUE]))
    .combine(grantStoreTablePartitions(grantee, manifest, ['BatchGetItem'], [BILLS_MANIFEST_GUID_LOOKUP_PK_VALUE]));
};
