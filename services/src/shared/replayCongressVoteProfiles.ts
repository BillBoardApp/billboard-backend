import type { RawBill } from "../models/bill";
import { extractHouseRollCallRef, extractOfficialVotesFromActions, extractSenateRollCallRef } from "./congressVotes";

type UnknownRecord = Record<string, unknown>;

type ChamberVoteRecord =
  | {
      memberDataAvailable?: boolean;
      members?: unknown[];
    }
  | undefined;

const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const extractActionsFromRawBill = (rawBill: RawBill): UnknownRecord[] => {
  const actions = ((rawBill?.content as UnknownRecord | undefined)?.actions as UnknownRecord | undefined)?.actions;
  return Array.isArray(actions)
    ? actions.filter((action): action is UnknownRecord => Boolean(action && typeof action === "object"))
    : [];
};

const normalizeVotePosition = (value: unknown): "Yea" | "Nay" | null => {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "yea" || normalized === "yes" || normalized === "aye") return "Yea";
  if (normalized === "nay" || normalized === "no") return "Nay";
  return null;
};

const chamberNeedsVoteEnrichmentReplay = (chamberVote: ChamberVoteRecord): boolean =>
  !chamberVote?.memberDataAvailable && (!Array.isArray(chamberVote?.members) || chamberVote.members.length === 0);

const actionBelongsToChamber = (action: UnknownRecord, chamber: "house" | "senate"): boolean => {
  const sourceSystem = action.sourceSystem as UnknownRecord | undefined;
  const sourceName = toTrimmedString(sourceSystem?.name).toLowerCase();
  if (sourceName === chamber) return true;

  const recordedVotes = Array.isArray(action.recordedVotes)
    ? action.recordedVotes.filter((entry): entry is UnknownRecord => Boolean(entry && typeof entry === "object"))
    : [];
  for (const recordedVote of recordedVotes) {
    if (toTrimmedString(recordedVote.chamber).toLowerCase() === chamber) return true;
  }

  const text = toTrimmedString(action.text).toLowerCase();
  const mentionsHouse = text.includes("house");
  const mentionsSenate = text.includes("senate");
  if (chamber === "house") return mentionsHouse && !mentionsSenate;
  return mentionsSenate && !mentionsHouse;
};

const hasReplayableProceduralVoteActionForChamber = (rawBill: RawBill, chamber: "house" | "senate"): boolean => {
  const proceduralPattern = /cloture|motion to proceed|motion to discharge/i;
  return extractActionsFromRawBill(rawBill).some((action) => {
    if (!actionBelongsToChamber(action, chamber)) return false;
    return proceduralPattern.test(toTrimmedString(action.text));
  });
};

const rawBillHasReplayableOfficialVoteForChamber = (rawBill: RawBill, chamber: "house" | "senate"): boolean => {
  const content = rawBill?.content as UnknownRecord | undefined;
  if (!content || typeof content !== "object") return false;

  const extracted = extractOfficialVotesFromActions(content);
  if (chamber === "house") {
    return Boolean(extractHouseRollCallRef(rawBill) || extracted?.house);
  }

  return Boolean(
    extractSenateRollCallRef(rawBill) ||
    extracted?.senate ||
    hasReplayableProceduralVoteActionForChamber(rawBill, "senate"),
  );
};

const hasReplayableMemberVotes = (chamberVote: unknown): boolean => {
  if (!chamberVote || typeof chamberVote !== "object") return false;
  const members = Array.isArray((chamberVote as UnknownRecord).members)
    ? ((chamberVote as UnknownRecord).members as unknown[])
    : [];

  return members.some((member) => {
    if (!member || typeof member !== "object") return false;
    const record = member as UnknownRecord;
    const bioguideId = toTrimmedString(record.bioguideId ?? record.memberId ?? record.id);
    const votePosition = normalizeVotePosition(record.votePosition ?? record.vote ?? record.position);
    return bioguideId.length > 0 && votePosition !== null;
  });
};

export const computeCurrentCongressNumber = (at: Date = new Date()): number => {
  const year = at.getUTCFullYear();
  let congressStartYear = year % 2 === 0 ? year - 1 : year;
  if (year % 2 === 1 && at.getTime() < Date.UTC(year, 0, 3)) {
    congressStartYear = year - 2;
  }
  return Math.floor((congressStartYear - 1789) / 2) + 1;
};

export const rawBillNeedsVoteEnrichmentReplay = (rawBill: RawBill): boolean => {
  const content = rawBill?.content as UnknownRecord | undefined;
  if (!content || typeof content !== "object") return false;

  const officialVotes = content.officialVotes as
    | {
        house?: ChamberVoteRecord;
        senate?: ChamberVoteRecord;
      }
    | undefined;

  const needsHouse = Boolean(
    rawBillHasReplayableOfficialVoteForChamber(rawBill, "house") &&
    chamberNeedsVoteEnrichmentReplay(officialVotes?.house),
  );
  const needsSenate = Boolean(
    rawBillHasReplayableOfficialVoteForChamber(rawBill, "senate") &&
    chamberNeedsVoteEnrichmentReplay(officialVotes?.senate),
  );

  return needsHouse || needsSenate;
};

export const processedBillNeedsVoteProfileReplay = (payload: unknown): boolean => {
  if (!payload || typeof payload !== "object") return false;

  const root = payload as UnknownRecord;
  if (!root.civicProfile || typeof root.civicProfile !== "object" || Array.isArray(root.civicProfile)) {
    return false;
  }

  const officialVotes = root.officialVotes as UnknownRecord | undefined;
  return hasReplayableMemberVotes(officialVotes?.house) || hasReplayableMemberVotes(officialVotes?.senate);
};

export const buildS3WrappedObjectMessage = (bucket: string, key: string, versionId?: string): string =>
  JSON.stringify({
    Records: [
      {
        s3: {
          bucket: { name: bucket },
          object: {
            key,
            ...(versionId ? { versionId } : {}),
          },
        },
      },
    ],
  });
