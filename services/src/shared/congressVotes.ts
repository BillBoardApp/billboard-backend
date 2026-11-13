import type {
  OfficialChamberVote,
  OfficialVoteMember,
  OfficialVotePosition,
  OfficialVotesBreakdown,
  RawBill,
} from "../models/bill";

const VOTE_TEXT_PATTERNS = [
  /yeas?\s+and\s+nays?/i,
  /yea[-\s]?nay/i,
  /roll(?:\s*call)?(?:\s*no\.?)?/i,
  /record(?:ed)?\s+vote/i,
  /agreed to by .*yeas?/i,
  /passed by .*yeas?/i,
  /cloture/i,
  /motion to proceed/i,
  /motion to discharge/i,
];
const HOUSE_ACTION_CODES = new Set(["8000"]);
const SENATE_ACTION_CODES = new Set(["17000"]);

export type VoteChamber = "house" | "senate";
type ActionRecord = Record<string, unknown>;

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const toOptionalString = (value: unknown): string | undefined => {
  const trimmed = toTrimmedString(value);
  return trimmed.length > 0 ? trimmed : undefined;
};

const toNumberOrZero = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const uniqueMembers = (members: OfficialVoteMember[]): OfficialVoteMember[] => {
  const out: OfficialVoteMember[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const key = `${member.bioguideId}|${member.votePosition}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(member);
  }
  return out;
};

/** Yea, Nay, Present and Not Voting rows counted (an Unknown row counts nowhere), and their total. */
export const countVotesByPosition = (
  members: OfficialVoteMember[],
): Pick<OfficialChamberVote, "yea" | "nay" | "present" | "notVoting" | "totalCounted"> => {
  let yea = 0;
  let nay = 0;
  let present = 0;
  let notVoting = 0;

  for (const member of members) {
    switch (member.votePosition) {
      case "Yea":
        yea += 1;
        break;
      case "Nay":
        nay += 1;
        break;
      case "Present":
        present += 1;
        break;
      case "Not Voting":
        notVoting += 1;
        break;
      default:
        break;
    }
  }

  return {
    yea,
    nay,
    present,
    notVoting,
    totalCounted: yea + nay + present + notVoting,
  };
};

/**
 * The Present, Not voting and total figures of a House roll call counted from its member rows (each
 * bioguideId and position once), or null when the rows do not match the header: there are none, or
 * their Yea or Nay count differs from the header's, which comes from the action text and stays the
 * official figure. congress.gov's actions state only "Yeas and Nays: 216 - 212", so without the rows
 * the House Present and Not voting figures are 0.
 */
export const houseCountsFromMembers = (
  header: Pick<OfficialChamberVote, "yea" | "nay">,
  members: OfficialVoteMember[],
): Pick<OfficialChamberVote, "present" | "notVoting" | "totalCounted"> | null => {
  const unique = uniqueMembers(members);
  if (unique.length === 0) return null;
  const counted = countVotesByPosition(unique);
  if (counted.yea !== header.yea || counted.nay !== header.nay) return null;
  return { present: counted.present, notVoting: counted.notVoting, totalCounted: counted.totalCounted };
};

const normalizeVotePosition = (value: unknown): OfficialVotePosition => {
  const normalized = toTrimmedString(value).toLowerCase();
  if (["yea", "yes", "aye", "y"].includes(normalized)) return "Yea";
  if (["nay", "no", "n"].includes(normalized)) return "Nay";
  if (["present"].includes(normalized)) return "Present";
  if (["not voting", "not-voting", "nv"].includes(normalized)) return "Not Voting";
  return "Unknown";
};

/**
 * The most yea plus nay votes a chamber can record. House: 435 Representatives, 5 Delegates and the
 * Resident Commissioner. Senate: 100 Senators plus the Vice President's tie-breaking vote (a real
 * "51 - 50" exists). A larger tally is a misread number, never a vote (REL-31).
 */
export const MAX_DECISION_VOTES_BY_CHAMBER: Readonly<Record<VoteChamber, number>> = { house: 441, senate: 101 };

// Numbers in action text that look like a tally but are not one (REL-31). Congressional Record
// citations: "(text: CR H4758-4759)", "(consideration: CR S141-143, S157)", "CR S8533--8535",
// "(text: CR H1473: 2)", "(text: 3/26/2024 CR H1284)". Document numbers: "Rules Committee Print
// 119-21", "H. Rept. 119-45", "Public Law No: 119-21". Dates: "9-18-2025", "9/18/2025".
const CONGRESSIONAL_RECORD_PAGE = String.raw`[HSDE]?\s?\d+(?:\s*[-–]+\s*[HSDE]?\d+)?(?:\s*:\s*\d+)?`;
const CONGRESSIONAL_RECORD_CITATION_RE = new RegExp(
  String.raw`\bCR\s+(?:\d{1,2}/\d{1,2}/\d{2,4}\s+)?${CONGRESSIONAL_RECORD_PAGE}(?:\s*,\s*${CONGRESSIONAL_RECORD_PAGE})*`,
  "g",
);
const DOCUMENT_NUMBER_RE =
  /\b(?:Rules\s+Committee\s+Print|(?:[HS]\.\s*)?(?:Rept|Rpt|Doc|Prt)\.|Report(?:\s+No\.?)?|Public\s+Law(?:\s+No\.?)?|Pub\.\s*L\.|P\.\s*L\.)\s*:?\s*\d+\s*[-–]\s*\d+/gi;
const DATE_RE = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g;

const stripNonTallyNumbers = (text: string): string =>
  text.replace(CONGRESSIONAL_RECORD_CITATION_RE, " ").replace(DOCUMENT_NUMBER_RE, " ").replace(DATE_RE, " ");

// A tally is two numbers of at most 3 digits; a longer run ("4758") is never a chamber's count.
const TALLY = String.raw`([0-9]{1,3})\s*[-–]\s*([0-9]{1,3})(?![0-9])`;
const YEA_NAY_PATTERNS: readonly RegExp[] = [
  // "Agreed to by the Yeas and Nays: (2/3 required): 395 - 2 (Roll no. 58)."
  new RegExp(String.raw`yeas?\s+and\s+nays?:\s*(?:\([^)]*\)\s*:?\s*)*${TALLY}`, "i"),
  // "Passed Senate without amendment by Yea-Nay Vote. 51 - 43. Record Vote Number: 623."
  new RegExp(String.raw`yea[-\s]?nay\s+vote\.?\s*${TALLY}`, "i"),
  // "On agreeing to the resolution Agreed to by recorded vote: 208 - 187 (Roll no. 74)."
  new RegExp(String.raw`(?:passed|agreed|vote)[^0-9]{0,80}${TALLY}`, "i"),
];

/**
 * The yea and nay counts an action's text states, or null. Congressional Record page ranges,
 * document numbers and dates are removed first, so "Passed without objection. (text: CR
 * H4758-4759)" has no tally (REL-31). A tally larger than the chamber (House when `chamber` is not
 * given) is rejected as well.
 */
export const parseYeaNayFromText = (text: string, chamber?: VoteChamber): { yea: number; nay: number } | null => {
  const cleaned = stripNonTallyNumbers(text);
  const maxDecisionVotes = MAX_DECISION_VOTES_BY_CHAMBER[chamber ?? "house"];
  for (const pattern of YEA_NAY_PATTERNS) {
    const match = cleaned.match(pattern);
    if (!match) continue;
    const yea = Number.parseInt(match[1], 10);
    const nay = Number.parseInt(match[2], 10);
    if (!Number.isFinite(yea) || !Number.isFinite(nay)) continue;
    if (yea + nay > maxDecisionVotes) return null;
    return { yea, nay };
  }
  return null;
};

const toEpochMsOrNull = (value: unknown): number | null => {
  const raw = toTrimmedString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

const congressStartYear = (congress: string): number | null => {
  const parsed = Number.parseInt(congress, 10);
  if (!Number.isFinite(parsed)) return null;
  return 1789 + (parsed - 1) * 2;
};

const deriveCongressSession = (congress: string, actionDate?: string): "1" | "2" => {
  const startYear = congressStartYear(congress);
  const actionYear = (() => {
    const source = toTrimmedString(actionDate);
    if (!source) return new Date().getUTCFullYear();
    const parsed = new Date(source);
    return Number.isNaN(parsed.getTime()) ? new Date().getUTCFullYear() : parsed.getUTCFullYear();
  })();

  if (startYear === null) return "1";
  const offset = actionYear - startYear;
  if (offset <= 0) return "1";
  return offset >= 1 ? "2" : "1";
};

const inferChamber = (action: ActionRecord): VoteChamber | null => {
  const actionCode = toTrimmedString(action.actionCode);
  if (actionCode === "8000") return "house";
  if (actionCode === "17000") return "senate";

  const sourceSystem = (action.sourceSystem as Record<string, unknown> | undefined) ?? undefined;
  const sourceSystemName = toTrimmedString(sourceSystem?.name).toLowerCase();
  if (sourceSystemName === "house") return "house";
  if (sourceSystemName === "senate") return "senate";

  const recordedVotes = Array.isArray(action.recordedVotes)
    ? action.recordedVotes.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object"),
      )
    : [];
  for (const recordedVote of recordedVotes) {
    const chamberName = toTrimmedString(recordedVote.chamber).toLowerCase();
    if (chamberName === "house") return "house";
    if (chamberName === "senate") return "senate";
  }

  const text = toTrimmedString(action.text).toLowerCase();
  const mentionsHouse = text.includes("house");
  const mentionsSenate = text.includes("senate");
  if (mentionsHouse && !mentionsSenate) return "house";
  if (mentionsSenate && !mentionsHouse) return "senate";
  return null;
};

const actionCodeMatchesChamber = (actionCode: string, chamber: VoteChamber): boolean => {
  if (chamber === "house") return HOUSE_ACTION_CODES.has(actionCode);
  return SENATE_ACTION_CODES.has(actionCode);
};

const isVoteRelatedAction = (action: ActionRecord, chamber: VoteChamber): boolean => {
  if (inferChamber(action) !== chamber) return false;

  const actionCode = toTrimmedString(action.actionCode);
  if (actionCodeMatchesChamber(actionCode, chamber)) return true;
  if (extractRollCallNumber(action)) return true;

  const text = toTrimmedString(action.text);
  return VOTE_TEXT_PATTERNS.some((pattern) => pattern.test(text));
};

const sortActionsMostRecentFirst = (actions: ActionRecord[]): ActionRecord[] =>
  actions
    .map((action, index) => ({ action, index, time: toEpochMsOrNull(action.actionDate) }))
    .sort((left, right) => {
      if (left.time === null && right.time === null) return left.index - right.index;
      if (left.time === null) return 1;
      if (right.time === null) return -1;
      if (left.time !== right.time) return right.time - left.time;
      return left.index - right.index;
    })
    .map((entry) => entry.action);

const selectLatestVoteAction = (actions: ActionRecord[], chamber: VoteChamber): ActionRecord | undefined => {
  const sorted = sortActionsMostRecentFirst(actions);

  const withRollCall = sorted.find(
    (action) => isVoteRelatedAction(action, chamber) && Boolean(extractRollCallNumber(action)),
  );
  if (withRollCall) return withRollCall;

  const withCounts = sorted.find(
    (action) =>
      isVoteRelatedAction(action, chamber) && Boolean(parseYeaNayFromText(toTrimmedString(action.text), chamber)),
  );
  if (withCounts) return withCounts;

  return sorted.find((action) => isVoteRelatedAction(action, chamber));
};

export const hasVoteRelatedActionForChamber = (rawBill: RawBill, chamber: VoteChamber): boolean => {
  const content = rawBill.content as Record<string, unknown>;
  const actions = extractActionsFromRawBillContent(content);
  if (actions.length === 0) return false;
  return Boolean(selectLatestVoteAction(actions, chamber));
};

const buildChamberVote = (
  action: ActionRecord,
  yea: number,
  nay: number,
  overrides?: Partial<OfficialChamberVote>,
): OfficialChamberVote => {
  const present = overrides?.present ?? toNumberOrZero(action.present);
  const notVoting = overrides?.notVoting ?? toNumberOrZero(action.notVoting);
  const members = uniqueMembers(overrides?.members ?? []);

  return {
    yea,
    nay,
    present,
    notVoting,
    totalCounted: yea + nay + present + notVoting,
    actionCode: toOptionalString(action.actionCode),
    actionDate: toOptionalString(action.actionDate),
    resultText: toOptionalString(action.text),
    memberDataAvailable: Boolean(overrides?.memberDataAvailable && members.length > 0),
    members,
  };
};

const latestVoteActionPerChamber = (
  actions: ActionRecord[],
): {
  house?: ActionRecord;
  senate?: ActionRecord;
} => {
  return {
    house: selectLatestVoteAction(actions, "house"),
    senate: selectLatestVoteAction(actions, "senate"),
  };
};

const extractActionsFromRawBillContent = (content: Record<string, unknown>): Record<string, unknown>[] => {
  const actionWrapper = content.actions as Record<string, unknown> | undefined;
  const actions = actionWrapper?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((action): action is Record<string, unknown> => Boolean(action && typeof action === "object"));
};

export const computeCompleteness = (officialVotes?: OfficialVotesBreakdown): OfficialVotesBreakdown["completeness"] => {
  if (!officialVotes) return "none";
  const chambers = [officialVotes.house, officialVotes.senate].filter(Boolean) as OfficialChamberVote[];
  if (chambers.length === 0) return "none";

  const anyMissingMemberDetails = chambers.some((chamber) => chamber.totalCounted > 0 && !chamber.memberDataAvailable);
  if (anyMissingMemberDetails) return "partial";
  return "complete";
};

/**
 * The stored `officialVotes` when it is usable: written by our pipeline (`source` "congress_api")
 * with a `lastSyncedAt`. Anything else counts as no votes. billSummarizer builds a processed bill's
 * votes through this, and billDiffer's reconcile uses it the same way (REL-30).
 */
export const usableOfficialVotes = (value: unknown): OfficialVotesBreakdown | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const votes = value as Partial<OfficialVotesBreakdown>;
  if (votes.source !== "congress_api") return undefined;
  if (!votes.lastSyncedAt || typeof votes.lastSyncedAt !== "string") return undefined;
  return votes as OfficialVotesBreakdown;
};

export const extractOfficialVotesFromActions = (
  content: Record<string, unknown>,
): OfficialVotesBreakdown | undefined => {
  const actions = extractActionsFromRawBillContent(content);
  if (actions.length === 0) return undefined;

  const selected = latestVoteActionPerChamber(actions);

  const house = (() => {
    if (!selected.house) return undefined;
    const parsed = parseYeaNayFromText(toTrimmedString(selected.house.text), "house");
    if (!parsed) return undefined;
    return buildChamberVote(selected.house, parsed.yea, parsed.nay);
  })();

  const senate = (() => {
    if (!selected.senate) return undefined;
    const parsed = parseYeaNayFromText(toTrimmedString(selected.senate.text), "senate");
    if (!parsed) return undefined;
    return buildChamberVote(selected.senate, parsed.yea, parsed.nay);
  })();

  if (!house && !senate) return undefined;

  const now = new Date().toISOString();
  const votes: OfficialVotesBreakdown = {
    ...(house ? { house } : {}),
    ...(senate ? { senate } : {}),
    lastSyncedAt: now,
    source: "congress_api",
    completeness: "none",
  };
  votes.completeness = computeCompleteness(votes);
  return votes;
};

const extractRollCallNumber = (action: Record<string, unknown>): string | null => {
  const normalizeCandidate = (value: unknown): string => {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return toTrimmedString(value);
  };

  const candidates = [action.rollCallNumber, action.rollcallNumber, action.rollNumber, action.voteNumber];
  for (const candidate of candidates) {
    const value = normalizeCandidate(candidate);
    if (value.length > 0) return value;
  }

  const recordedVotes = Array.isArray(action.recordedVotes)
    ? action.recordedVotes.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object"),
      )
    : [];
  for (const recordedVote of recordedVotes) {
    const recordedCandidates = [
      recordedVote.rollCallNumber,
      recordedVote.rollcallNumber,
      recordedVote.rollNumber,
      recordedVote.voteNumber,
    ];
    for (const candidate of recordedCandidates) {
      const value = normalizeCandidate(candidate);
      if (value.length > 0) return value;
    }
  }

  const text = toTrimmedString(action.text);
  const textMatch = text.match(/roll(?:\s*call)?(?:\s*no\.?)?\s*([0-9]{1,6})/i);
  if (textMatch) return textMatch[1];

  return null;
};

const extractSessionNumber = (action: Record<string, unknown>): string | null => {
  const normalizeCandidate = (value: unknown): string => {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return toTrimmedString(value);
  };

  const candidates = [action.sessionNumber, action.session];
  for (const candidate of candidates) {
    const value = normalizeCandidate(candidate);
    if (value.length > 0) return value;
  }

  const recordedVotes = Array.isArray(action.recordedVotes)
    ? action.recordedVotes.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object"),
      )
    : [];
  for (const recordedVote of recordedVotes) {
    const value = normalizeCandidate(recordedVote.sessionNumber ?? recordedVote.session);
    if (value.length > 0) return value;
  }

  return null;
};

type HouseRollCallRef = {
  congress: string;
  sessionNumber?: string;
  rollCallNumber: string;
  actionDate?: string;
  actionCode?: string;
  resultText?: string;
};

type ChamberRollCallRef = HouseRollCallRef & {
  chamber: VoteChamber;
};

const extractChamberRollCallRef = (rawBill: RawBill, chamber: VoteChamber): ChamberRollCallRef | null => {
  const content = rawBill.content as Record<string, unknown>;
  const actions = extractActionsFromRawBillContent(content);
  if (actions.length === 0) return null;

  const candidate = selectLatestVoteAction(actions, chamber);
  if (!candidate) return null;

  const rollCallNumber = extractRollCallNumber(candidate);
  if (!rollCallNumber) return null;

  return {
    chamber,
    congress: rawBill.identifier.congress,
    sessionNumber:
      chamber === "house"
        ? (extractSessionNumber(candidate) ??
          deriveCongressSession(rawBill.identifier.congress, toOptionalString(candidate.actionDate)))
        : undefined,
    rollCallNumber,
    actionDate: toOptionalString(candidate.actionDate),
    actionCode: toOptionalString(candidate.actionCode),
    resultText: toOptionalString(candidate.text),
  };
};

export const extractHouseRollCallRef = (rawBill: RawBill): HouseRollCallRef | null =>
  extractChamberRollCallRef(rawBill, "house");

export const extractSenateRollCallRef = (rawBill: RawBill): ChamberRollCallRef | null =>
  extractChamberRollCallRef(rawBill, "senate");

export const mapMemberVote = (entry: Record<string, unknown>): OfficialVoteMember | null => {
  const bioguideId = toTrimmedString(entry.bioguideId ?? entry.bioguideID ?? entry.memberId ?? entry.id);
  const displayName = toTrimmedString(
    entry.name ??
      entry.memberName ??
      entry.displayName ??
      [toTrimmedString(entry.lastName), toTrimmedString(entry.firstName)].filter(Boolean).join(", "),
  );

  if (!bioguideId || !displayName) return null;

  return {
    bioguideId,
    displayName,
    party: toOptionalString(entry.party ?? entry.voteParty),
    state: toOptionalString(entry.state ?? entry.voteState),
    district: toOptionalString(entry.district ?? entry.voteDistrict),
    votePosition: normalizeVotePosition(entry.votePosition ?? entry.voteCast ?? entry.vote ?? entry.position),
  };
};

/**
 * The raw bill's officialVotes with these House member rows attached. Yea and Nay stay as the action
 * text states them; Present, Not voting and the total are counted from the rows when the rows' Yea and
 * Nay match (houseCountsFromMembers), else the header is kept as it is.
 */
export const mergeHouseMembersIntoOfficialVotes = (
  rawBill: RawBill,
  members: OfficialVoteMember[],
): OfficialVotesBreakdown | undefined => {
  const content = rawBill.content as Record<string, unknown>;
  const existing =
    (content.officialVotes as OfficialVotesBreakdown | undefined) ?? extractOfficialVotesFromActions(content);
  if (!existing || !existing.house) return existing;

  const unique = uniqueMembers(members);
  const counted = houseCountsFromMembers(existing.house, unique);
  const updatedHouse: OfficialChamberVote = {
    ...existing.house,
    ...(counted ?? {}),
    memberDataAvailable: unique.length > 0,
    members: unique,
  };

  const updated: OfficialVotesBreakdown = {
    ...existing,
    house: updatedHouse,
    lastSyncedAt: new Date().toISOString(),
    completeness: "none",
  };
  updated.completeness = computeCompleteness(updated);
  return updated;
};

export const upsertOfficialChamberVote = (
  rawBill: RawBill,
  chamber: VoteChamber,
  vote: OfficialChamberVote,
): OfficialVotesBreakdown => {
  const content = rawBill.content as Record<string, unknown>;
  const existing =
    (content.officialVotes as OfficialVotesBreakdown | undefined) ?? extractOfficialVotesFromActions(content);

  const updated: OfficialVotesBreakdown = {
    ...(existing ?? {
      lastSyncedAt: new Date().toISOString(),
      source: "congress_api",
      completeness: "none",
    }),
    [chamber]: vote,
    lastSyncedAt: new Date().toISOString(),
    completeness: "none",
  };
  updated.completeness = computeCompleteness(updated);
  return updated;
};
