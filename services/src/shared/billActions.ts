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

/**
 * Routine entries Congress.gov records right after the action they follow, the same day or the next; that action
 * says more. "Motion to reconsider laid on the table" follows a House vote, "Placed on the Union Calendar, Calendar
 * No. 123." a committee report, "Message on Senate action sent to the House." a Senate passage, and "Held at the
 * desk." a bill received from the other chamber.
 */
const ROUTINE_FOLLOW_UP_RE = new RegExp(
  "^(?:" +
    [
      "motion to reconsider",
      "placed on (?:the )?(?:union|house|private|senate legislative) calendar",
      "message on senate action sent to the house",
      "held at the desk",
    ].join("|") +
    ")\\b",
  "i",
);

/** Whether an action's text is a routine follow-up (ROUTINE_FOLLOW_UP_RE): the Weekly Brief and Updates pass over it. */
export const isRoutineFollowUpText = (text: string): boolean => ROUTINE_FOLLOW_UP_RE.test(text);
