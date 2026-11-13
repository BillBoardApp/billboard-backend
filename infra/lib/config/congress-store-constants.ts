// Store Buckets: fixed, globally unique names, so they live in deployment-identity.ts.
export { BILL_STORE_BUCKET_NAME, CONGRESS_MEMBER_STORE_BUCKET_NAME } from './deployment-identity';

// Bill Manifest
export const BILLS_MANIFEST_TABLE_NAME = 'BillsManifest';
export const BILLS_MANIFEST_TABLE_PRIMARY_KEY = 'pk';
export const BILLS_MANIFEST_TABLE_SORT_KEY = 'sk';
export const BILLS_MANIFEST_TABLE_PK_VALUE = 'BILL';
// One lookup row per guid (sk = guid) that names the bill's manifest row.
export const BILLS_MANIFEST_GUID_LOOKUP_PK_VALUE = `${BILLS_MANIFEST_TABLE_PK_VALUE}_GUID`;
// APPF-23 companion bills: internal rows kept in BillsManifest under their own partition values, apart
// from the BILL and BILL_GUID rows, so each writer's grant can be limited to its partition
// (dynamodb:LeadingKeys). BILL_COMPANION_DECL: one row per bill that lists identical bills (sk = plain
// guid), written by BillDiffer and the backfill script. BILL_COMPANION_GROUPS: the resolved pairs
// (sk = CURRENT), written only by PublishBillsManifest. Both match the defaults in
// services/src/adapters/billCompanionDao.ts.
export const BILLS_MANIFEST_COMPANION_DECL_PK_VALUE = 'BILL_COMPANION_DECL';
export const BILLS_MANIFEST_COMPANION_GROUPS_PK_VALUE = 'BILL_COMPANION_GROUPS';
export const BILLS_MANIFEST_BATCH_SIZE = 10;

// Congress Member Manifest
export const CONGRESS_MEMBERS_MANIFEST_TABLE_NAME = 'CongressMembersManifest';
export const CONGRESS_MEMBERS_MANIFEST_TABLE_PRIMARY_KEY = 'bioguideId';
export const CONGRESS_MEMBERS_MANIFEST_BATCH_SIZE = 10;

// CAP-05 switch. true: raw-bills/ writes also notify CongressMemberStatsQueue (the pre-CAP-05 trigger,
// with the queue policy that lets S3 send). false: member stats are driven only by the processed-bill
// versions CreateBillsManifest forwards, which is the CAP-05 target (at most one run per changed bill).
// It stays true for the first deploy of the CAP-05 services: CloudFormation would remove the trigger
// during the stack update, but the old CongressMemberStats keeps serving until the aliases shift after
// all stacks deploy, and bills processed in between would miss their counter updates. Both paths share
// the per-member counted-guid guard, so running both never double counts. Set it to false in the next
// deploy once the new CongressMemberStats is the pinned prod version (tracker UA-19). Set it back to
// true before rolling services back to a build older than CAP-05.
// Off since switchover step U9c (2026-10-11).
export const MEMBER_STATS_RAW_BILL_TRIGGER = false;
