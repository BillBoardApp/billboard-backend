import { billOutcomeTextForAction } from "./billOutcomes";
import type { PendingNotificationAction } from "./pendingNotifications";

/**
 * Text helpers every push shares: userNotifier's bill pushes (handlers/userNotifier/pushCopy.ts, which re-exports
 * them) and the Sunday Weekly Brief push (UX-28). Moved here unchanged so no handler imports another handler's module.
 */

const ELLIPSIS = "...";

export const normalizeInlineText = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

export const truncateUtf8 = (value: string, maxBytes: number): string => {
  const normalized = normalizeInlineText(value);
  if (!normalized) return "";
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
  if (maxBytes <= Buffer.byteLength(ELLIPSIS, "utf8")) {
    return ELLIPSIS.slice(0, Math.max(0, maxBytes));
  }

  let end = normalized.length;
  while (end > 0) {
    // Periods and spaces at the cut are dropped, so a cut after "U.S." reads "U.S..." never "U.S....".
    const candidate = `${normalized.slice(0, end).replace(/[\s.]+$/, "")}${ELLIPSIS}`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      return candidate;
    }
    end -= 1;
  }

  return ELLIPSIS;
};

export const uniqueNonEmpty = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => normalizeInlineText(value)).filter(Boolean)));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Oct 27" for an action date ("2026-10-27", a calendar day, read as written), with the year ("Dec 30, 2025") when it
 * is not the current UTC year; null when the value does not start with a date.
 */
export const formatActionDate = (raw: string | undefined, nowMs: number): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((raw ?? "").trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const label = `${MONTHS[month - 1]} ${day}`;
  return year === new Date(nowMs).getUTCFullYear() ? label : `${label}, ${year}`;
};

// "(text: CR H4567-4570)", "(consideration: CR S123; text: CR S124)", "(Roll no. 301)": references, not news.
const RECORD_REFERENCE_RE = /\s*\((?=[^()]*(?:\bCR\s+[A-Z]?\d|\bRoll no\.|\btext:|\bconsideration:))[^()]*\)/gi;

/**
 * The action in plain words, without its date: the words for the bill's own coded passage or failure ("Passed the
 * House"), for a law line ("Became law", REL-44), for a failed suspension vote ("House vote fell short of two-thirds", REL-50) or for a failed 60-vote
 * Senate vote ("Senate vote fell short of 60", REL-50), else Congress's text without record references and a final
 * period ("Reported by the Committee on Energy and Commerce").
 * Null when there is no action, or only notificationType's "Bill updated" (no single new action was found).
 */
export const pushActionPhrase = (action: PendingNotificationAction | undefined): string | null => {
  if (!action) return null;
  const outcome = billOutcomeTextForAction({
    actionCode: action.actionCode,
    text: action.text,
    type: action.actionType,
  });
  if (outcome) return outcome;
  const text = normalizeInlineText(action.text)
    .replace(RECORD_REFERENCE_RE, "")
    .replace(/\s+([.,;:])/g, "$1")
    .trim()
    .replace(/(?<!\.)\.$/, "");
  if (!text || /^bill updated$/i.test(text)) return null;
  return text;
};
