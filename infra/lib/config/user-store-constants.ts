export const USER_PARTITION_KEY = 'userId';

export const USER_PREFERENCES_TABLE_NAME = 'UserPreferences';
export const USER_PREFERENCES_SORT_KEY = 'preference';
export const USER_PREFERENCES_SUB_CATEGORY_INDEX = 'GSISubCategoryIndex';

export const USER_DEVICES_TABLE_NAME = 'UserDevices';
export const USER_DEVICES_SORT_KEY = 'deviceId';
export const USER_DEVICES_PUSH_TOKEN_ATTRIBUTE = 'pushToken';
export const USER_DEVICES_PUSH_TOKEN_INDEX = 'GSIPushTokenIndex';

export const USER_FEEDBACK_TABLE_NAME = 'UserFeedback';
export const USER_FEEDBACK_SORT_KEY = 'billId';
export const USER_FEEDBACK_BILL_ID_INDEX = 'GSIBillIdIndex';

export const USER_BILL_STATS_TABLE_NAME = 'BillStats';
export const USER_BILL_STATS_PARTITION_KEY = 'billId';

export const USER_PII_TABLE_NAME = 'UserPII';

export const USER_WEEKLY_DIGESTS_TABLE_NAME = 'UserWeeklyDigests';
export const USER_WEEKLY_DIGESTS_SORT_KEY = 'publishedAt';
// Epoch seconds; written by generateWeeklyDigests so old digests age out.
export const USER_WEEKLY_DIGESTS_TTL_ATTRIBUTE = 'ttl';

// INT-03 (C2 3.3.2): verified-address claims. Partition `U#<unitKey>` (one item per claiming account,
// `USER#<userId>`, plus the unit's `#COUNT`) or `S#<streetKey>` (the street address's `#COUNT`). The keys
// are salted hashes; no address is stored. DistrictVerification reads and writes it; account deletion
// releases the deleted account's claim (X5).
export const VERIFIED_ADDRESS_CLAIMS_TABLE_NAME = 'VerifiedAddressClaims';
export const VERIFIED_ADDRESS_CLAIMS_PARTITION_KEY = 'claimKey';
export const VERIFIED_ADDRESS_CLAIMS_SORT_KEY = 'member';

// INT-05 (C2 3.5 with X5): one claim per base email address. Keyed `pk` with two items per claim, written
// in one transaction: `EMAIL#<emailKey>` {userName, claimedAt, addressKey, holders, revision} and
// `USER#<userName>` {emailKey, claimedAt}. emailKey is a salted hash of the address with any +tag (and Gmail
// dots) removed, addressKey one of the exact address the holders (the sign-up attempts that hold the base
// address) used; no email is stored.
export const SIGN_UP_EMAIL_CLAIMS_TABLE_NAME = 'SignUpEmailClaims';
export const SIGN_UP_EMAIL_CLAIMS_PARTITION_KEY = 'pk';
