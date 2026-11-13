import type { RawBill } from "../models/bill";

export const extractCommitteesFromRawBill = (rawBill: RawBill): unknown[] => {
  const content = (rawBill as unknown as { content?: unknown })?.content;
  if (!content || typeof content !== "object") {
    return [];
  }

  const committeesContainer = (content as Record<string, unknown>).committees;
  if (!committeesContainer || typeof committeesContainer !== "object") {
    return [];
  }

  const committees = (committeesContainer as Record<string, unknown>).committees;
  return Array.isArray(committees) ? committees : [];
};
