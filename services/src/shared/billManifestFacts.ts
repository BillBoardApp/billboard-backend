import type { BillsManifestLatestActionV1 } from "../contracts";
import { isVetoAction } from "./billOutcomes";
import { calendarDay } from "./calendarDay";

// Facts of a bill that CreateBillsManifest copies onto its manifest row from the processed bill (UX-29, UX-38), so the
// apps can rank and label a bill they have not opened: when it was introduced and what Congress did last. The chamber
// passages are billOutcomes.ts chamberPassageDates, and the ceremonial flag is commemorativeResolutions.ts. None of
// them is part of what dates the row (billVersionChange.ts reads the document, not the row), so writing them moves no
// row.

type LooseAction = { actionCode?: unknown; actionDate?: unknown; text?: unknown; type?: unknown };

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

// The action types the apps label an action without text by (BillDisplayFormatting.actionTypeLabel in billboard-ios,
// website/app.js ACTION_TYPE_LABELS), as their keys: lowercased, letters only. Only the keys: the labels are the apps'
// words, never sent.
const LABELLED_ACTION_TYPES = new Set([
  "introreferral",
  "committee",
  "calendars",
  "floor",
  "discharge",
  "president",
  "becamelaw",
  "veto",
  "resolvingdifferences",
]);

/** Whether the app lists an action without text by a label: a veto by its code (isVetoAction), else by its type. */
const hasTypeLabel = (action: LooseAction): boolean =>
  isVetoAction(action) ||
  LABELLED_ACTION_TYPES.has(
    trimmedText(action.type)
      .toLowerCase()
      .replace(/[^a-z]/g, ""),
  );

/**
 * The bill's latest action for its manifest row: the one the app's bill page and the website show as Latest action,
 * the last of BillDisplayFormatting.timelineActions (billboard-ios) and of website/app.js timelineActions (UX-43).
 * Of the actions, those of the greatest actionDate (as trimmed text), then the first listed: congress.gov lists the
 * newest first, and the stored order is the only one that holds for a whole day, since many Library of Congress lines
 * have no time ("Presented to President.", "Signed by President.", "Became Public Law ..."). actionTime is not read: by
 * time, the day a bill became law named a House procedural step. An action without text counts only when no action of
 * its date has text and the app has a label for it (hasTypeLabel). A veto line (31000, 30000) of the same date and text
 * (case aside) is taken in its place, as the app takes it over the House's E30000 line.
 *
 * The text is congress.gov's, trimmed, citations included; it is left out when that action has none (the app then shows
 * its type). Null when there is no such action, or when its date is not a calendar day: the row then names no action
 * rather than one the app does not show.
 */
export const latestManifestAction = (actions: unknown): BillsManifestLatestActionV1 | null => {
  const list = actionsOf(actions);
  const dateOf = (action: LooseAction): string => trimmedText(action.actionDate);
  const datesWithText = new Set(list.filter((action) => trimmedText(action.text)).map(dateOf));
  const listed = list.filter((action) =>
    trimmedText(action.text) ? true : !datesWithText.has(dateOf(action)) && hasTypeLabel(action),
  );
  let latest: LooseAction | undefined;
  for (const action of listed) {
    // Only a greater date replaces it, so of one date the first listed stays.
    if (latest === undefined || dateOf(action) > dateOf(latest)) latest = action;
  }
  if (latest === undefined) return null;
  const chosen = latest;
  const line = trimmedText(chosen.text).toLowerCase();
  const veto =
    line && !isVetoAction(chosen)
      ? listed.find(
          (action) =>
            isVetoAction(action) &&
            dateOf(action) === dateOf(chosen) &&
            trimmedText(action.text).toLowerCase() === line,
        )
      : undefined;
  const shown = veto ?? chosen;
  const day = calendarDay(shown.actionDate);
  if (day === null) return null;
  const text = trimmedText(shown.text);
  return { actionDate: day, ...(text ? { text } : {}) };
};
