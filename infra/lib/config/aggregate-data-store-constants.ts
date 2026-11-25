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
// /congress-member-record reads it). One row per member, bill and chamber (sort key "<billGuid>#<chamber>"), so a
// newer roll call on a bill overwrites the member's row. The VotedOnIndex (local, sort key "<votedOn>#<billGuid>")
// reads a member's rows newest first; a local index can only be created with the table. The bill guid index finds a
// bill's rows to delete the ones a newer version no longer gives.
export const CONGRESS_MEMBER_VOTE_RECORD_TABLE_NAME = 'CongressMemberVoteRecord';
export const CONGRESS_MEMBER_VOTE_RECORD_TABLE_PRIMARY_KEY = 'bioguideId';
export const CONGRESS_MEMBER_VOTE_RECORD_TABLE_SORT_KEY = 'billKey';
export const CONGRESS_MEMBER_VOTE_RECORD_VOTED_ON_INDEX_NAME = 'VotedOnIndex';
export const CONGRESS_MEMBER_VOTE_RECORD_VOTED_ON_INDEX_SORT_KEY = 'votedOnKey';
export const CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_NAME = 'BillGuidIndex';
export const CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_PRIMARY_KEY = 'billGuid';
export const CONGRESS_MEMBER_VOTE_RECORD_BILL_GUID_INDEX_SORT_KEY = 'bioguideId';
