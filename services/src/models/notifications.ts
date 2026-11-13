import type { OutcomePushType } from "../shared/pushAudience";

type NotificationDomain = "bill";

export type NotificationType = "new" | "updated" | "alert" | "passed" | "failed";

export type BillAlertDetails = {
  text: string;
  actionDate?: string;
  actionCode?: string;
  actionType?: string;
};

export type NotificationTypeMessage = {
  domain: NotificationDomain;
  objectId: string;
  notificationType: NotificationType;
  // Only present for bill alerts.
  alert?: BillAlertDetails;
  // Only present for bill passage notifications.
  passed?: BillAlertDetails;
  // Only present for bill failed-vote notifications.
  failed?: BillAlertDetails;
  /**
   * UX-33, only on an "updated": when the stored version with the new summary was written (its S3 LastModified, else
   * its storedAt), ISO 8601. userNotifier drops the "vote again" push of a user whose vote is newer. Absent from older
   * producers; the pending row's write time stands in.
   */
  changedAt?: string;
  /**
   * UX-33, only on an "alert": the outcome push ("passed" or "failed", shared/pushAudience.ts OUTCOME_PUSH_TYPES) the
   * same stored version also sends, whose message carries this action as `sameVersionAlert`. userMatcher then writes no
   * rows for this message where the outcome's audience covers the alert's (shared/pushAudience.ts): the outcome message
   * writes this action's row beside its own for the alert's users. An older userMatcher ignores it and sends both, as
   * before.
   */
  sameVersionOutcome?: OutcomePushType;
  /**
   * UX-33, only on a "passed" or "failed": the action push ("alert") the same stored version also sends, with its
   * details (the newest new action, as on that alert). userMatcher writes, for each user the action push reaches, the
   * action's row beside the outcome's in one write, the action's marked with the outcome (`pairedOutcome`), and
   * userNotifier sends each device one of the two: the outcome where the device takes that outcome's pushes, else the
   * action (project decision 2026-10-29, "one event, per phone"). An older userMatcher ignores it.
   */
  sameVersionAlert?: BillAlertDetails;
};
