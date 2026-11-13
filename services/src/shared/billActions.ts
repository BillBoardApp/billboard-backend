import type { RawBill } from "../models/bill";

export const extractActionsFromRawBill = (rawBill: RawBill): unknown[] => {
  const content = (rawBill as unknown as { content?: unknown })?.content;
  if (!content || typeof content !== "object") {
    return [];
  }

  const actionsContainer = (content as Record<string, unknown>).actions;
  if (!actionsContainer || typeof actionsContainer !== "object") {
    return [];
  }

  const actions = (actionsContainer as Record<string, unknown>).actions;
  return Array.isArray(actions) ? actions : [];
};
