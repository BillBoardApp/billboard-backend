export const CONGRESS_MEMBER_STATS_TABLE_NAME = 'CongressMembersStats';
export const CONGRESS_MEMBER_STATS_TABLE_PRIMARY_KEY = 'bioguideId';

export const CONGRESS_MEMBER_VOTE_PROFILE_TABLE_NAME = 'CongressMemberVoteProfiles';
export const CONGRESS_MEMBER_VOTE_PROFILE_TABLE_PRIMARY_KEY = 'bioguideId';
export const CONGRESS_MEMBER_VOTE_PROFILE_TABLE_SORT_KEY = 'billGuid';
export const CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_NAME = 'BillGuidIndex';
export const CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY = 'billGuid';
export const CONGRESS_MEMBER_VOTE_PROFILE_BILL_GUID_INDEX_SORT_KEY = 'bioguideId';

export const CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_NAME = 'CongressMemberLegislativeProfiles';
export const CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_PRIMARY_KEY = 'bioguideId';
export const CONGRESS_MEMBER_LEGISLATIVE_PROFILE_TABLE_SORT_KEY = 'billGuid';
export const CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME = 'BillGuidIndex';
export const CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PRIMARY_KEY = 'billGuid';
export const CONGRESS_MEMBER_LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SORT_KEY = 'bioguideId';

// UX-39d: each member's latest roll-call position on each bill in Billboard (CongressMemberStats writes it, GET
// /congress-member-record reads it). The sort key is "<votedAt>#<billGuid>", so a member's rows read newest first; the
// bill guid index finds a bill's rows to delete when a newer roll call replaces them.
export const CONGRESS_MEMBER_VOTE_RECORD_TABLE_NAME = 'CongressMemberVoteRecord';
export const CONGRESS_MEMBER_VOTE_RECORD_TABLE_PRIMARY_KEY = 'bioguideId';
export const CONGRESS_MEMBER_VOTE_RECORD_TABLE_SORT_KEY = 'recordKey';
export const CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_NAME = 'BillGuidIndex';
export const CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_PRIMARY_KEY = 'billGuid';
export const CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_SORT_KEY = 'bioguideId';
