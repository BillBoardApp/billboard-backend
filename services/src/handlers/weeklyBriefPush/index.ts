import { type AttributeValue, DynamoDBClient, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { UserDeviceDao, type UserDeviceRecord } from "../../adapters/userDeviceDao";
import { WeeklyDigestSnapshotDao } from "../../adapters/weeklyDigestSnapshotDao";
import { normalizeAdultStatus, normalizeDeletionStatus } from "../../shared/adultEligibility";
import { mapWithConcurrency } from "../../shared/concurrency";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetrics, type EmbeddedMetricInput } from "../../shared/metrics";
import { isInQuietHours, localTimeIn, timeZoneForState } from "../../shared/quietHours";
import { weeklyBriefPushCopy } from "../../shared/weeklyBriefPushCopy";
import { latestPublishedWindow, WEEKLY_DIGEST_TIME_ZONE } from "../../shared/weeklyDigestSchedule";

/*
 * The Sunday Weekly Brief push (UX-28). EventBridge Scheduler runs it hourly on Sunday from 10:30 AM to 5:30 PM New
 * York (infra WEEKLY_BRIEF_PUSH_SCHEDULE_EXPRESSION), after GenerateWeeklyDigests has stored the week's briefs at 10:00.
 * Each run sends the brief to every user who has one this week, unsent, and is outside their quiet hours (UX-27, S5):
 * 10:30 Eastern for Eastern, Central and Mountain users, 11:30 for Pacific (8:30 AM there), later runs for Alaska and
 * Hawaii, and the 5:30 PM run, Monday 8:30 AM there, for Guam while New York keeps standard time.
 *
 * - Who: users not being deleted, who attested they are 18 or older, with this week's brief. Only their devices with an
 *   endpoint, notifications not turned off and notifyWeeklyBrief exactly true get it: only app 1.3 writes that flag, so
 *   1.1 and 1.2 devices, which show their own local banner, never do (decision D2).
 * - Once: before publishing, a conditional UpdateItem sets pushClaimedAt on the user's snapshot only when it has none,
 *   so a user gets the push at most once a week whatever runs or retries overlap. A publish that fails after the claim
 *   is counted, never retried.
 * - Not held by the 3-hour bill-push pace and never counted in it (decision D6): it writes no pace marker.
 * - The payload is userNotifier's message shape, read by 1.3 as a brief (domain weekly_digest, a digestId, no billIds).
 * - Metrics (EMF, BillBoard/WeeklyDigest): WeeklyBriefPushesSent (pushes SNS accepted, one per device) and
 *   WeeklyBriefPushFailed (failed publishes, and users whose reads or claim failed) every run, zero included, and on the
 *   last run WeeklyBriefPushesUnsent (users with an unsent brief and a device that takes it, still in their quiet hours
 *   or not reached).
 * - Logs carry counts and error names only: never a user id, an endpoint ARN or an SNS error message (which can hold
 *   the ARN).
 * - WEEKLY_BRIEF_PUSH exactly "on" sends; anything else sends nothing (the switch). A run more than 12 hours after the
 *   week's release sends nothing either.
 */

const METRIC_NAMESPACE = "BillBoard/WeeklyDigest";
/** Users worked on at once. */
export const WEEKLY_BRIEF_PUSH_USER_CONCURRENCY = 5;
/** No run sends more than this long after the week's release (10:00 New York): the last scheduled run is at 17:30. */
export const WEEKLY_BRIEF_PUSH_MAX_DELAY_MS = 12 * 60 * 60 * 1000;
/** Lambda time kept in hand: no new user starts once less than this remains. */
export const WEEKLY_BRIEF_PUSH_TIME_RESERVE_MS = 30_000;
const DEFAULT_LAST_RUN_HOUR = 17;

const PII_TABLE_NAME = process.env.PII_TABLE_NAME;
const PII_PARTITION_KEY = process.env.PII_PARTITION_KEY ?? "userId";
const DEVICES_TABLE_NAME = process.env.DEVICES_TABLE_NAME ?? "";
const DEVICES_PARTITION_KEY = process.env.DEVICES_PARTITION_KEY ?? "userId";
const DEVICES_SORT_KEY = process.env.DEVICES_SORT_KEY ?? "deviceId";
const ENDPOINT_ARN_ATTRIBUTE = "endpointArn";
const SNS_ENDPOINT_ARN_SEGMENT = ":endpoint/";

const dynamo = new DynamoDBClient({});
const sns = new SNSClient({});

const snapshotDao = new WeeklyDigestSnapshotDao(dynamo, {
  tableName: process.env.TABLE_NAME,
  partitionKey: process.env.PARTITION_KEY ?? "userId",
  sortKey: process.env.SORT_KEY ?? "publishedAt",
});

const deviceDao = new UserDeviceDao(dynamo, {
  tableName: DEVICES_TABLE_NAME,
  userIdAttribute: DEVICES_PARTITION_KEY,
  deviceIdAttribute: DEVICES_SORT_KEY,
  endpointArnAttribute: ENDPOINT_ARN_ATTRIBUTE,
});

const isOn = (value: string | undefined): boolean => value?.trim() === "on";

/** The New York hour of the last scheduled run (17 for 17:30); a run in or after that hour is the last of the day. */
const lastRunHour = (): number => {
  const parsed = Number.parseInt(process.env.WEEKLY_BRIEF_PUSH_LAST_RUN_HOUR ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : DEFAULT_LAST_RUN_HOUR;
};

const errorNameOf = (error: unknown): string =>
  error && typeof error === "object" && "name" in error && typeof error.name === "string" && error.name
    ? error.name
    : "Error";

/** A user as the UserPII scan reads them: only what deciding and the quiet hours need. */
interface Recipient {
  userId: string;
  state?: string;
}

type UserOutcome =
  | "no_brief"
  | "already_sent"
  | "no_device"
  | "held_quiet_hours"
  | "sent"
  | "not_delivered"
  | "failed"
  | "not_started";

export interface WeeklyBriefPushSummary {
  status: "sent" | "off" | "late";
  windowId: string;
  lastRun: boolean;
  usersScanned: number;
  usersEligible: number;
  users: Record<UserOutcome, number>;
  devices: { sent: number; failed: number; endpointsRemoved: number };
  errorNames: Record<string, number>;
}

const emptyUserCounts = (): Record<UserOutcome, number> => ({
  no_brief: 0,
  already_sent: 0,
  no_device: 0,
  held_quiet_hours: 0,
  sent: 0,
  not_delivered: 0,
  failed: 0,
  not_started: 0,
});

/** Every user not being deleted who attested they are 18 or older, with the state their quiet hours follow. */
async function listRecipients(): Promise<{ scanned: number; recipients: Recipient[] }> {
  if (!PII_TABLE_NAME) {
    throw new Error("PII_TABLE_NAME is required");
  }

  const recipients: Recipient[] = [];
  let scanned = 0;
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await dynamo.send(
      new ScanCommand({
        TableName: PII_TABLE_NAME,
        ProjectionExpression: "#pk, deletionStatus, adultStatus, resolvedState, selfAttestedState",
        ExpressionAttributeNames: { "#pk": PII_PARTITION_KEY },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const userId = item?.[PII_PARTITION_KEY]?.S?.trim();
      if (!userId) continue;
      scanned += 1;
      const deletion = normalizeDeletionStatus(item.deletionStatus?.S);
      if (deletion === "in_progress" || deletion === "completed") continue;
      if (normalizeAdultStatus(item.adultStatus?.S) !== "attested_adult") continue;
      const state = item.resolvedState?.S?.trim() || item.selfAttestedState?.S?.trim() || undefined;
      recipients.push(state ? { userId, state } : { userId });
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return { scanned, recipients };
}

/** The devices that take the Sunday push: an endpoint, notifications not off, and the Weekly Brief flag exactly true. */
export const devicesTakingTheBrief = (devices: readonly UserDeviceRecord[]): UserDeviceRecord[] =>
  devices.filter(
    (device) =>
      typeof device.endpointArn === "string" &&
      device.endpointArn.length > 0 &&
      device.notificationsEnabled !== false &&
      device.notifyWeeklyBrief === true,
  );

/** userNotifier's message shape: the same APNs payload for APNS and APNS_SANDBOX, the title as the default. */
export const weeklyBriefPushMessage = (copy: { title: string; body: string }, digestId: string): string => {
  const apns = JSON.stringify({
    aps: {
      alert: { title: copy.title, body: copy.body },
      sound: "default",
      "thread-id": "weekly-brief",
    },
    domain: "weekly_digest",
    notificationType: "digest",
    digestId,
  });
  return JSON.stringify({ default: copy.title, APNS: apns, APNS_SANDBOX: apns });
};

/** A gone or disabled endpoint, read as userNotifier reads it. */
const isGoneEndpoint = (error: unknown): boolean => {
  const name = errorNameOf(error);
  const message = error instanceof Error ? error.message : "";
  const code = (error as { Error?: { Code?: unknown } } | null)?.Error?.Code;
  return (
    (name === "InvalidParameterException" && message.includes("No endpoint found")) ||
    message.includes("No endpoint found for the target arn specified") ||
    name === "EndpointDisabledException" ||
    code === "EndpointDisabled" ||
    message.includes("Endpoint is disabled")
  );
};

/**
 * Drops a gone endpoint's ARN from the device row, as userNotifier does, so the device registers again at its next
 * launch. Only while the row still holds that ARN: a registration since then keeps its new one.
 */
async function removeEndpoint(userId: string, device: UserDeviceRecord, counts: WeeklyBriefPushSummary): Promise<void> {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: DEVICES_TABLE_NAME,
        Key: {
          [DEVICES_PARTITION_KEY]: { S: userId },
          [DEVICES_SORT_KEY]: { S: device.deviceId },
        },
        UpdateExpression: "REMOVE #endpoint",
        ConditionExpression: "#endpoint = :arn",
        ExpressionAttributeNames: { "#endpoint": ENDPOINT_ARN_ATTRIBUTE },
        ExpressionAttributeValues: { ":arn": { S: device.endpointArn! } },
      }),
    );
    counts.devices.endpointsRemoved += 1;
  } catch (error) {
    if (errorNameOf(error) !== "ConditionalCheckFailedException") {
      countError(counts, error);
    }
  }
}

const countError = (counts: WeeklyBriefPushSummary, error: unknown): void => {
  const name = errorNameOf(error);
  counts.errorNames[name] = (counts.errorNames[name] ?? 0) + 1;
};

/** Publishes to each device; true when SNS accepted at least one. */
async function publishToDevices(
  userId: string,
  devices: readonly UserDeviceRecord[],
  message: string,
  counts: WeeklyBriefPushSummary,
): Promise<boolean> {
  let delivered = false;
  for (const device of devices) {
    // Not an SNS endpoint ARN: dropped, as userNotifier drops it, so the device registers again.
    if (!device.endpointArn!.includes(SNS_ENDPOINT_ARN_SEGMENT)) {
      await removeEndpoint(userId, device, counts);
      continue;
    }

    try {
      await sns.send(new PublishCommand({ TargetArn: device.endpointArn, MessageStructure: "json", Message: message }));
      counts.devices.sent += 1;
      delivered = true;
    } catch (error) {
      if (isGoneEndpoint(error)) {
        await removeEndpoint(userId, device, counts);
      } else {
        counts.devices.failed += 1;
        countError(counts, error);
      }
    }
  }
  return delivered;
}

async function pushToUser(
  recipient: Recipient,
  context: { windowId: string; nowMs: number; quietHours: boolean },
  counts: WeeklyBriefPushSummary,
): Promise<UserOutcome> {
  const { userId } = recipient;
  const stored = await snapshotDao.getPushState(userId, context.windowId);
  if (!stored) return "no_brief";
  if (stored.pushClaimedAt) return "already_sent";

  const devices = devicesTakingTheBrief(await deviceDao.getDevicesForUser(userId));
  if (devices.length === 0) return "no_device";

  if (context.quietHours && isInQuietHours(context.nowMs, timeZoneForState(recipient.state))) {
    return "held_quiet_hours";
  }

  if (!(await snapshotDao.claimPush(userId, context.windowId, new Date(context.nowMs).toISOString()))) {
    return "already_sent";
  }

  const message = weeklyBriefPushMessage(weeklyBriefPushCopy(stored.digest), context.windowId);
  return (await publishToDevices(userId, devices, message, counts)) ? "sent" : "not_delivered";
}

type InvocationContext = LambdaContextLike & { getRemainingTimeInMillis?: () => number };

export async function handler(_event?: unknown, lambdaContext?: InvocationContext): Promise<WeeklyBriefPushSummary> {
  logger.resetContext(lambdaContext);
  const nowMs = Date.now();
  const window = latestPublishedWindow(new Date(nowMs));
  const lastRun = localTimeIn(nowMs, WEEKLY_DIGEST_TIME_ZONE).hour >= lastRunHour();
  const summary: WeeklyBriefPushSummary = {
    status: "sent",
    windowId: window.id,
    lastRun,
    usersScanned: 0,
    usersEligible: 0,
    users: emptyUserCounts(),
    devices: { sent: 0, failed: 0, endpointsRemoved: 0 },
    errorNames: {},
  };

  if (!isOn(process.env.WEEKLY_BRIEF_PUSH)) {
    logger.info("weeklyBriefPush is off (WEEKLY_BRIEF_PUSH); nothing sent", { windowId: window.id });
    return { ...summary, status: "off" };
  }
  if (nowMs - window.releaseAt.getTime() > WEEKLY_BRIEF_PUSH_MAX_DELAY_MS) {
    logger.info("weeklyBriefPush ran more than 12 hours after the week's release; nothing sent", {
      windowId: window.id,
    });
    return { ...summary, status: "late" };
  }

  const { scanned, recipients } = await listRecipients();
  summary.usersScanned = scanned;
  summary.usersEligible = recipients.length;
  const remainingMs = lambdaContext?.getRemainingTimeInMillis?.bind(lambdaContext);
  const context = { windowId: window.id, nowMs, quietHours: isOn(process.env.QUIET_HOURS) };

  await mapWithConcurrency(recipients, WEEKLY_BRIEF_PUSH_USER_CONCURRENCY, async (recipient) => {
    let outcome: UserOutcome;
    if (remainingMs && remainingMs() < WEEKLY_BRIEF_PUSH_TIME_RESERVE_MS) {
      outcome = "not_started";
    } else {
      try {
        outcome = await pushToUser(recipient, context, summary);
      } catch (error) {
        countError(summary, error);
        outcome = "failed";
      }
    }
    summary.users[outcome] += 1;
  });

  const metrics: EmbeddedMetricInput[] = [
    { name: "WeeklyBriefPushesSent", value: summary.devices.sent },
    { name: "WeeklyBriefPushFailed", value: summary.devices.failed + summary.users.failed },
  ];
  if (lastRun) {
    metrics.push({
      name: "WeeklyBriefPushesUnsent",
      value: summary.users.held_quiet_hours + summary.users.not_started,
    });
  }
  emitEmbeddedMetrics(METRIC_NAMESPACE, metrics);

  const failed = summary.users.failed > 0 || summary.users.not_started > 0;
  (failed || summary.devices.failed > 0 ? logger.error.bind(logger) : logger.info.bind(logger))(
    "weeklyBriefPush summary",
    { ...summary },
  );

  // A user whose reads or claim failed, or who was not reached before the timeout, was not claimed: throw so the
  // async retry (then the next hourly run) tries them again; the claim keeps everyone else from a second push.
  if (failed) {
    throw new Error(
      `weeklyBriefPush could not finish ${summary.users.failed + summary.users.not_started} of ${recipients.length} users (window ${window.id}); a retry resumes`,
    );
  }

  return summary;
}

export default { handler };
