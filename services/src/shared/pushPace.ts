import { quietHoursEndAfter } from "./quietHours";

/**
 * The push pace (UX-33: feature review 2026-10-28, S5; project decision that day): at most one push every few hours per
 * user, 3 as shipped (infra PUSH_PACE_HOURS). userNotifier records when it last sent a user a push (a `__pace__#<user>`
 * item in the user's dispatch shard partition) and, while the pace window that push opened is still running, holds
 * the user's pending rows the way the quiet hours do (shared/quietHours.ts): it keeps them, extends the dispatcher's
 * claim to the end of the window, and the first dispatch after it sends everything then pending, folded into one push
 * (plus the "updated" push, which is never folded into another; see userNotifier). Pending rows live 24 hours, so a
 * row held for at most 3 hours, or until 8 AM when the window ends in the quiet hours (at most 3 + 12 hours), is never
 * lost.
 */

/**
 * A row that arrives just after a push waits out the window and, when it ends at night, the quiet hours too (up to 12
 * hours on the night clocks fall back): 8 + 12 hours, plus the dispatch, still fits a pending row's 24 with room.
 */
const MAX_PUSH_PACE_HOURS = 8;
const HOUR_MS = 3_600_000;

/** The sort key prefix of the pace item, next to the dispatch markers (`<user>`) and claims (`__claim__#<user>`). */
export const PUSH_PACE_SORT_KEY_PREFIX = "__pace__#";
/** The pace item's `markerType`, so the dispatcher never reads it as a marker or a claim. */
export const PUSH_PACE_MARKER_TYPE = "push-pace";
/** How long the pace item is kept after its window ends (TTL deletion is lazy; the window is read from the item). */
export const PUSH_PACE_ITEM_MARGIN_SECONDS = 3600;

/**
 * The pace in hours from the environment: a whole number from 1 to 8. Anything else, `0` or no value turns it off
 * (every push goes out as soon as the quiet hours allow, as before UX-33).
 */
export const parsePushPaceHours = (raw: string | undefined): number => {
  if (typeof raw !== "string" || !/^\s*\d+\s*$/.test(raw)) return 0;
  const hours = Number(raw);
  return hours >= 1 && hours <= MAX_PUSH_PACE_HOURS ? hours : 0;
};

/** When the window a push sent at `lastPushAtMs` opened ends. */
export const paceWindowEndMs = (lastPushAtMs: number, paceHours: number): number => lastPushAtMs + paceHours * HOUR_MS;

export type PushHoldReason = "quiet_hours" | "pace";

export interface PushHold {
  /** When the user may be pushed again (epoch ms). */
  untilMs: number;
  /** Why the user is held now: the quiet hours, or the pace window of their last push. */
  reason: PushHoldReason;
}

/**
 * Whether a user's pending rows wait at `nowMs`, and until when. `timeZone` is the user's quiet-hours zone, or null
 * when the quiet hours are off; `paceEndMs` is when their last push's pace window ends, or null without one.
 *
 * - In the quiet hours: until 8 AM (reason `quiet_hours`), or until the pace window ends when that is later.
 * - Otherwise, in a pace window: until it ends (reason `pace`); when it ends in the quiet hours, until 8 AM after it,
 *   so the dispatcher wakes the user once.
 * - Otherwise: null, the rows go out now.
 */
export const pushHoldAt = (nowMs: number, timeZone: string | null, paceEndMs: number | null): PushHold | null => {
  const sendableAfter = (instantMs: number): number =>
    (timeZone ? quietHoursEndAfter(instantMs, timeZone) : null) ?? instantMs;
  const quietEndMs = timeZone ? quietHoursEndAfter(nowMs, timeZone) : null;
  const paceEnd = paceEndMs !== null && paceEndMs > nowMs ? paceEndMs : null;
  if (quietEndMs !== null) {
    return {
      untilMs: paceEnd !== null && paceEnd > quietEndMs ? sendableAfter(paceEnd) : quietEndMs,
      reason: "quiet_hours",
    };
  }
  if (paceEnd !== null) return { untilMs: sendableAfter(paceEnd), reason: "pace" };
  return null;
};
