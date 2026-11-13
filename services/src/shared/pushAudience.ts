import type { NotificationType } from "../models/notifications";

/**
 * Who gets each kind of push (UX-33: feature review 2026-10-28, S4 and S14; project decisions that day and on
 * 2026-10-29). userMatcher looks up each source the rule names and sends the push to every user found, each user once.
 * Every path then applies the user's settings: the bill types they chose (the content-type filter,
 * shared/pendingNotifications.ts), and on each device the push types they turned off (userNotifier). One exception
 * keeps a vote's pushes: a bill's own voters and watchers (`billFollowers`, `groupFollowers`) are never filtered by
 * bill type, in or out of the news, for any push they are an audience of (`updated`, `alert`, `passed`, `failed`;
 * project decision 2026-10-29): a vote or a watch says more about that bill than the bill types do, and both apps show a
 * bill in the news whatever bill types the user chose, so users vote on bills outside them. The push types turned off
 * on a device still apply.
 *
 * Before UX-33 a `passed` or `failed` push went only to the followers of the bill's topics, life areas and members:
 * `passed` (2026-02-13) fell through to the `new` push's matching, `failed` (2026-04-06) followed it, and the bill's
 * voters and watchers were added only for a bill in a companion group (APPF-23, for the other member's watchers). And
 * while a bill was "in the news" (an active BillPriority record, at most 8 bills) every one of its pushes went to every
 * active user, without the bill-type filter.
 */
export type PushAudienceSource =
  /** Followers of the bill's topics, life areas, sponsors and cosponsors (so every topic follower too). */
  | "interests"
  /** Followers of the bill's topics only (under either spelling of a renamed topic, LLM-10). */
  | "topics"
  /** The bill's voters and watchers: a `Bill` row (both apps write one with each stored vote) or a `Watch` row. */
  | "billFollowers"
  /** The voters and watchers of the bill and of the other members of its companion group (APPF-23), each user once. */
  | "groupFollowers"
  /** Every active user (a Scan of UserPII). */
  | "everyone";

export interface PushAudienceRule {
  /** A bill that is not in the news. */
  readonly regular: readonly PushAudienceSource[];
  /** A bill "in the news": an active BillPriority record. */
  readonly inTheNews: readonly PushAudienceSource[];
}

const rule = (regular: readonly PushAudienceSource[], inTheNews: readonly PushAudienceSource[]): PushAudienceRule =>
  Object.freeze({ regular: Object.freeze([...regular]), inTheNews: Object.freeze([...inTheNews]) });

/**
 * An outcome reaches the bill's voters and watchers (and those of its companion) as well as the followers of its
 * topics, life areas, sponsors and cosponsors, the same people whether the bill is in the news or not (project decision
 * 2026-10-29: never fewer than for a quiet bill; not everyone).
 *
 * Each outcome audience covers the `alert` audience (`outcomeCoversAlert`), in the news and out: when one stored version
 * adds an action and passes or fails the bill, userMatcher writes the action's row beside the outcome's for every user
 * the action reaches, in one write, and userNotifier sends each device one of the two (UX-33, project decision
 * 2026-10-29, "one event, per phone"). The types with this rule are exactly OUTCOME_PUSH_TYPES (pinned by a
 * test).
 */
export const OUTCOME_AUDIENCE = rule(["interests", "groupFollowers"], ["interests", "groupFollowers"]);

/**
 * The outcome push types: the ones whose rule is OUTCOME_AUDIENCE, and the only ones a version's action is paired
 * with ("one event, per phone"). Every guard of that pairing reads this list, so a type joins the pairing everywhere
 * at once: NotificationType (the outcome a version's `alert` names, `sameVersionOutcome`, and the outcome message that
 * carries the action, `sameVersionAlert`), userMatcher (which messages name the other), the pending writer and the
 * fan-out message (`pairedAlert`, shared/pendingNotifications.ts `isPairedOutcomeType`) and userNotifier
 * (`pairedOutcome` on a row). A version stamps at most one outcome (shared/billOutcomes.ts).
 */
export const OUTCOME_PUSH_TYPES = Object.freeze(["passed", "failed"] as const satisfies readonly NotificationType[]);
export type OutcomePushType = (typeof OUTCOME_PUSH_TYPES)[number];

/** Whether `value` is an outcome push type (OUTCOME_PUSH_TYPES). */
export const isOutcomePushType = (value: unknown): value is OutcomePushType =>
  (OUTCOME_PUSH_TYPES as readonly unknown[]).includes(value);

/**
 * The rule per event type. A bill becoming law (REL-44) has no type of its own: its law lines reach the bill's voters
 * and watchers as an `alert` that says "Became law" (shared/billOutcomes.ts BECAME_LAW_TEXT). A "law" outcome type
 * would join here in two places, once `"law"` is in the NotificationType union: its rule `law: OUTCOME_AUDIENCE` and
 * `"law"` in OUTCOME_PUSH_TYPES (a test pins the two together, so one without the other fails). That pairs its push
 * with the version's action, as for `passed` and `failed`. It also needs NotificationType to classify and send it,
 * userMatcher to accept the message and read its action (`isNotificationTypeMessage`, `actionOfMessage`), its wording
 * (handlers/userNotifier/pushCopy.ts), and a device switch that turns it off (userNotifier
 * `isNotificationTypeEnabledForDevice`, the device settings in the API contract and the apps' settings): a type with
 * no switch goes to every device, so its paired action row would go to none.
 *
 * - `new`: the followers of the bill's labels; for a bill in the news, everyone (within the bill types each chose). A
 *   ceremonial resolution sends none (S6, checked in userMatcher before any lookup).
 * - `updated` (the summary changed; both apps ask its voters to vote again): the bill's own voters and watchers, since
 *   only that bill's summary changed; in the news, also its topic followers.
 * - `alert` (a new action): the voters and watchers of the bill and of its companion; in the news, also its topic
 *   followers.
 * - `passed`, `failed`: OUTCOME_AUDIENCE, in the news and out.
 */
export const PUSH_AUDIENCE_RULES: Readonly<Record<NotificationType, PushAudienceRule>> = Object.freeze({
  new: rule(["interests"], ["everyone"]),
  updated: rule(["billFollowers"], ["billFollowers", "topics"]),
  alert: rule(["groupFollowers"], ["groupFollowers", "topics"]),
  passed: OUTCOME_AUDIENCE,
  failed: OUTCOME_AUDIENCE,
});

/** The sources a push of `type` reaches, for a bill in the news or not. */
export const pushAudienceSources = (type: NotificationType, inTheNews: boolean): readonly PushAudienceSource[] => {
  const audience = PUSH_AUDIENCE_RULES[type];
  return inTheNews ? audience.inTheNews : audience.regular;
};

/**
 * The sources whose users include every user of `source`: itself, `interests` for `topics` (a topic is one of the
 * bill's labels), `groupFollowers` for `billFollowers` (the bill is in its own group), and `everyone` for any.
 */
const SOURCES_COVERING: Readonly<Record<PushAudienceSource, readonly PushAudienceSource[]>> = Object.freeze({
  interests: ["interests", "everyone"],
  topics: ["topics", "interests", "everyone"],
  billFollowers: ["billFollowers", "groupFollowers", "everyone"],
  groupFollowers: ["groupFollowers", "everyone"],
  everyone: ["everyone"],
});

/** Whether every user `source` finds is also found by one of `sources`. */
export const sourceCoveredBy = (source: PushAudienceSource, sources: readonly PushAudienceSource[]): boolean =>
  SOURCES_COVERING[source].some((covering) => sources.includes(covering));

/**
 * Whether every user the `alert` push of a bill reaches is also reached by its `outcome` push (`passed` or `failed`):
 * each source of the alert's rule is covered by one of the outcome's (a user found through several sources gets one
 * row). Only then does userMatcher handle the action of a version that also passes or fails the bill with the outcome
 * (the action's row written beside the outcome's for the alert's users, the alert message itself skipped); otherwise
 * the two go out as two pushes, as before UX-33. The rules above keep it true in and out of the news (pinned by a test
 * for every outcome); the check keeps a later change of a rule from silently losing someone's action push.
 */
export const outcomeCoversAlert = (outcome: NotificationType, inTheNews: boolean): boolean => {
  const outcomeSources = pushAudienceSources(outcome, inTheNews);
  return pushAudienceSources("alert", inTheNews).every((source) => sourceCoveredBy(source, outcomeSources));
};
