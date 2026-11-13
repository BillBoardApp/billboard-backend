import type { NotificationType } from "../../models/notifications";
import { billOutcomeTextForAction } from "../../shared/billOutcomes";
import type { PendingNotificationAction } from "../../shared/pendingNotifications";

/**
 * What a push says (feature review 2026-10-28, S4 and S5). Both shipped apps read the same payload: 1.1 (on the App
 * Store) and 1.2 show `aps.alert` as the banner, and for an `alert` push build a Recent actions row from `aps.alert`,
 * the nested `alert` object (`text`, `actionDate`, `actionCode`) and the top-level `category` and `subCategory`
 * (PushNotificationPayload.swift, PushDeepLinkRouter.swift). Neither reads any other key, so the added keys change
 * nothing else in either app.
 *
 * - An alert, passed or failed push names the action and its date: "Passed the House · Oct 27", "Reported by the
 *   Committee on Energy and Commerce · Oct 27". A passage or failure code, and a law line (REL-44: "Became law"), is
 *   said in plain words; other actions use Congress's text, without Congressional Record and roll-call references.
 * - Several rows make one push, as before, but it keeps their type when they all share one and an app acts on it
 *   (S5): "2 Bills Changed" is an `updated` push, so both apps ask to vote again on each bill; "3 New Bills for You",
 *   "2 Bills Passed" and "2 Bills Failed" keep `new`, `passed` and `failed`, which both apps handle like a `digest`.
 *   "Action on 2 Bills" stays a `digest`: both apps read an `alert` push as one bill (its first id, for the tap and
 *   the Recent actions row) and would drop the others. Rows of different types are a `digest`. Rows of one bill (or
 *   one companion pair) are described by the most telling row: failed, passed, an action, new, updated.
 */

export type PushType = NotificationType | "digest";

/** What the copy needs from a pending row. */
export interface PushRow {
  billId: string;
  billTitle: string;
  category: string;
  notificationType: NotificationType;
  subCategory?: string;
  action?: PendingNotificationAction;
}

export interface PushCopy {
  title: string;
  body: string;
  notificationType: PushType;
}

/** The keys a push adds next to `aps` for the apps' Updates rows (see the module comment). */
export interface PushPayloadDetails {
  category?: string;
  subCategory?: string;
  alert?: { text: string; actionDate?: string; actionCode?: string };
}

export const SINGLE_TITLE_MAX_BYTES = 140;
/** Room for an action's text and date; well inside the 4 KB APNs payload with everything else. */
export const PUSH_BODY_MAX_BYTES = 160;
const BILL_TITLE_MAX_BYTES = 110;
const EXAMPLE_TITLE_MAX_BYTES = 36;
const PAYLOAD_FIELD_MAX_BYTES = 64;
const ALERT_TEXT_MAX_BYTES = 200;
const ALERT_FIELD_MAX_BYTES = 32;
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
    const candidate = `${normalized.slice(0, end).trimEnd()}${ELLIPSIS}`;
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

/** The body of an action push when its row names no action (a row written before S4, or no single new action). */
const FALLBACK_ACTION_BODY = {
  alert: "Congress updated this bill's record.",
  passed: "It passed a vote in Congress.",
  failed: "It failed a vote in Congress.",
} as const;

/** "<what happened> · <date>", or the action alone without a date, within PUSH_BODY_MAX_BYTES. */
const actionBody = (row: PushRow, type: keyof typeof FALLBACK_ACTION_BODY, nowMs: number): string => {
  const phrase = pushActionPhrase(row.action);
  if (!phrase) return FALLBACK_ACTION_BODY[type];
  const date = formatActionDate(row.action?.actionDate, nowMs);
  if (!date) return truncateUtf8(phrase, PUSH_BODY_MAX_BYTES);
  const suffix = ` · ${date}`;
  return `${truncateUtf8(phrase, PUSH_BODY_MAX_BYTES - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
};

/** One row's copy: "<Type>: <bill title>" and what happened. */
export const singleRowCopy = (row: PushRow, nowMs: number): { title: string; body: string } => {
  const shortTitle = truncateUtf8(row.billTitle, BILL_TITLE_MAX_BYTES);
  switch (row.notificationType) {
    case "new":
      return { title: `New: ${shortTitle}`, body: "A new bill matched your interests." };
    case "updated":
      return { title: `Updated: ${shortTitle}`, body: "Open Billboard to see what changed." };
    case "alert":
      return { title: `Action: ${shortTitle}`, body: actionBody(row, "alert", nowMs) };
    case "passed":
      return { title: `Passed: ${shortTitle}`, body: actionBody(row, "passed", nowMs) };
    case "failed":
      return { title: `Failed: ${shortTitle}`, body: actionBody(row, "failed", nowMs) };
  }
};

const pluralCountTitle = (type: NotificationType, count: number): string => {
  switch (type) {
    case "new":
      return `${count} New Bills for You`;
    case "updated":
      return `${count} Bills Changed`;
    case "alert":
      return `Action on ${count} Bills`;
    case "passed":
      return `${count} Bills Passed`;
    case "failed":
      return `${count} Bills Failed`;
  }
};

const summarizeTypeCounts = (rows: PushRow[]): string => {
  const count = (type: NotificationType) => rows.filter((row) => row.notificationType === type).length;
  const newCount = count("new");
  const updatedCount = count("updated");
  const alertCount = count("alert");
  const passedCount = count("passed");
  const failedCount = count("failed");

  const parts: string[] = [];
  if (newCount > 0) parts.push(`${newCount} new`);
  if (updatedCount > 0) parts.push(`${updatedCount} changed`);
  if (alertCount > 0) parts.push(`${alertCount} ${alertCount === 1 ? "action" : "actions"}`);
  if (passedCount > 0) parts.push(`${passedCount} passed`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);

  return parts.join(", ") || `${rows.length} bill updates`;
};

const exampleTitlesBody = (rows: PushRow[], keyOf: (billId: string) => string): string => {
  const titles = uniqueNonEmpty(rows.map((row) => row.billTitle)).map((title) =>
    truncateUtf8(title, EXAMPLE_TITLE_MAX_BYTES),
  );
  const total = uniqueNonEmpty(rows.map((row) => keyOf(row.billId))).length;

  if (titles.length === 0 || total === 0) {
    return "Open Billboard to review the latest.";
  }
  if (titles.length === 1) {
    return total === 1 ? titles[0] : `Includes ${titles[0]} and ${total - 1} more.`;
  }
  if (total === 2) {
    return `Includes ${titles[0]} and ${titles[1]}.`;
  }
  return `Includes ${titles[0]}, ${titles[1]}, and ${Math.max(1, total - 2)} more.`;
};

// The row that best tells what happened to one bill: an outcome, then an action, then new, then updated.
const LEAD_ORDER: readonly NotificationType[] = ["failed", "passed", "alert", "new", "updated"];

/** The most telling row (LEAD_ORDER), the first of equals. */
export const leadRow = <T extends PushRow>(rows: readonly T[]): T =>
  rows.reduce((best, row) =>
    LEAD_ORDER.indexOf(row.notificationType) < LEAD_ORDER.indexOf(best.notificationType) ? row : best,
  );

/**
 * The types a push about several bills keeps (see the module comment). Not `alert`: both apps take an `alert` push
 * down their single-alert path (PushNotificationsAppDelegate.handlePush, the same in 1.1 and 1.2), which opens and
 * files a Recent actions row for the first bill id only and skips the per-bill refresh a `digest` gets.
 */
const TYPES_KEPT_ACROSS_BILLS: ReadonlySet<NotificationType> = new Set(["new", "updated", "passed", "failed"]);

const sharedType = (rows: readonly PushRow[]): NotificationType | null => {
  const first = rows[0]?.notificationType;
  return first && rows.every((row) => row.notificationType === first) ? first : null;
};

/** The value every row has, or undefined when one lacks it or they differ. */
const sharedValue = (values: readonly (string | undefined)[]): string | undefined => {
  const first = normalizeInlineText(values[0]);
  return first && values.every((value) => normalizeInlineText(value) === first) ? first : undefined;
};

const distinctBills = (rows: readonly PushRow[], keyOf: (billId: string) => string): number =>
  uniqueNonEmpty(rows.map((row) => keyOf(row.billId))).length;

/**
 * The copy and type of one push for `rows` (the rows one device gets in one push, companion rows already folded).
 * `keyOf` counts a companion pair as one bill.
 */
export const pushCopyFor = (rows: PushRow[], keyOf: (billId: string) => string, nowMs: number): PushCopy => {
  const uniform = sharedType(rows);
  if (rows.length === 1 || distinctBills(rows, keyOf) <= 1) {
    const lead = leadRow(rows);
    return {
      ...singleRowCopy(lead, nowMs),
      notificationType: rows.length === 1 ? lead.notificationType : (uniform ?? "digest"),
    };
  }

  const count = distinctBills(rows, keyOf);
  if (uniform) {
    return {
      title: pluralCountTitle(uniform, count),
      body: exampleTitlesBody(rows, keyOf),
      notificationType: TYPES_KEPT_ACROSS_BILLS.has(uniform) ? uniform : "digest",
    };
  }
  return { title: `${count} Bill Updates`, body: summarizeTypeCounts(rows), notificationType: "digest" };
};

/**
 * The payload keys beside `aps` for the apps' Updates rows: `category` and `subCategory` when every row shares them,
 * and for a push about one bill the `alert` object naming its action. An `alert` push always carries a `subCategory`:
 * without one both apps put the push body in the row's topic line, under the same body as its text, so it falls back
 * to the rows' category ("Bill Alert").
 */
export const pushPayloadDetails = (
  rows: PushRow[],
  type: PushType,
  keyOf: (billId: string) => string,
): PushPayloadDetails => {
  const details: PushPayloadDetails = {};
  const category = sharedValue(rows.map((row) => row.category));
  const subCategory = sharedValue(rows.map((row) => row.subCategory));
  if (category) details.category = truncateUtf8(category, PAYLOAD_FIELD_MAX_BYTES);
  const topic = subCategory ?? (type === "alert" ? (category ?? "Bill Alert") : undefined);
  if (topic) details.subCategory = truncateUtf8(topic, PAYLOAD_FIELD_MAX_BYTES);

  if (distinctBills(rows, keyOf) <= 1) {
    const lead = leadRow(rows);
    const text = pushActionPhrase(lead.action);
    if (text && lead.action) {
      const actionDate = lead.action.actionDate && truncateUtf8(lead.action.actionDate, ALERT_FIELD_MAX_BYTES);
      const actionCode = lead.action.actionCode && truncateUtf8(lead.action.actionCode, ALERT_FIELD_MAX_BYTES);
      details.alert = {
        text: truncateUtf8(text, ALERT_TEXT_MAX_BYTES),
        ...(actionDate ? { actionDate } : {}),
        ...(actionCode ? { actionCode } : {}),
      };
    }
  }
  return details;
};
