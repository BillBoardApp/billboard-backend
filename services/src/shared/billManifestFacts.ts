import type { BillsManifestLatestActionV1 } from "../contracts";
import { calendarDay } from "./calendarDay";

// Facts of a bill that CreateBillsManifest copies onto its manifest row from the processed bill (UX-29, UX-38), so the
// apps can rank and label a bill they have not opened: when it was introduced and what Congress did last. The chamber
// passages are billOutcomes.ts chamberPassageDates, and the ceremonial flag is commemorativeResolutions.ts. None of
// them is part of what dates the row (billVersionChange.ts reads the document, not the row), so writing them moves no
// row.

type LooseAction = { actionDate?: unknown; actionTime?: unknown; text?: unknown };

const asAction = (value: unknown): LooseAction | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as LooseAction) : undefined;

const actionsOf = (actions: unknown): LooseAction[] =>
  Array.isArray(actions) ? actions.map(asAction).filter((action) => action !== undefined) : [];

const trimmedText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * The day the bill was introduced (YYYY-MM-DD): `documentIntroducedDate` (congress.gov's introducedDate, where a
 * document carries one) when it is a calendar day, else the earliest calendar day among the actions, else null. A
 * processed bill stores at most the newest 250 actions (one congress.gov page), so for a longer history the earliest
 * stored action is later than the introduction.
 */
export const billIntroducedDate = (documentIntroducedDate: unknown, actions: unknown): string | null => {
  const stated = calendarDay(documentIntroducedDate);
  if (stated !== null) return stated;
  let earliest: string | null = null;
  for (const action of actionsOf(actions)) {
    const day = calendarDay(action.actionDate);
    if (day !== null && (earliest === null || day < earliest)) earliest = day;
  }
  return earliest;
};

/**
 * The bill's latest action for its manifest row: among the actions with a calendar day, those of the greatest day and
 * then the greatest actionTime (compared as text; a missing one is "" and sorts first, as in billVersionChange.ts
 * latestAction), the first listed whose text is not empty, else the first listed. congress.gov lists the newest first.
 * The text is congress.gov's, trimmed, citations included; it is left out when that action has none. Null when no action
 * has a calendar day.
 */
export const latestManifestAction = (actions: unknown): BillsManifestLatestActionV1 | null => {
  let latest: { day: string; time: string; text: string } | null = null;
  for (const action of actionsOf(actions)) {
    const day = calendarDay(action.actionDate);
    if (day === null) continue;
    const time = typeof action.actionTime === "string" ? action.actionTime.trim() : "";
    const text = trimmedText(action.text);
    if (latest === null || day > latest.day || (day === latest.day && time > latest.time)) {
      latest = { day, time, text };
    } else if (day === latest.day && time === latest.time && !latest.text && text) {
      // The same moment, listed later: it names the action when the first listed has no text.
      latest = { day, time, text };
    }
  }
  if (latest === null) return null;
  return { actionDate: latest.day, ...(latest.text ? { text: latest.text } : {}) };
};
