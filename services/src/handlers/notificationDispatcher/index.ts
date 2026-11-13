import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { GetPlatformApplicationAttributesCommand, SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { ScheduledEvent } from "aws-lambda";
import { mapWithConcurrency } from "../../shared/concurrency";
import { correlationIdMessageAttributes, mintCorrelationId } from "../../shared/correlation";
import {
  allDispatchShardPartitionValues,
  dispatchShardPartitionValue,
  isDispatchPartitionValue,
  parseDispatchShardCount,
} from "../../shared/dispatchShards";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { putMetric } from "../../shared/metrics";
import { sendMessageBatchWithRetry } from "../../shared/sqsSendWithRetry";

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});
let sns: SNSClient | undefined;

const positiveIntFromEnv = (raw: string | undefined, fallback: number, max: number): number => {
  const value = Number(raw);
  return typeof raw === "string" && raw.trim().length > 0 && Number.isInteger(value) && value >= 1
    ? Math.min(value, max)
    : fallback;
};

const PENDING_NOTIFICATIONS_TABLE = process.env.PENDING_NOTIFICATIONS_TABLE!;
const USER_BATCH_SIZE = positiveIntFromEnv(process.env.USER_BATCH_SIZE, 50, 1000);
const PARTITION_KEY = process.env.PARTITION_KEY!;
const DISPATCH_PARTITION_KEY = process.env.DISPATCH_PARTITION_KEY ?? PARTITION_KEY;
const DISPATCH_SORT_KEY =
  process.env.DISPATCH_SORT_KEY ?? process.env.PENDING_NOTIFICATIONS_TABLE_SORT_KEY ?? process.env.SORT_KEY ?? "billId";
// The legacy unsharded marker partition; markers and claims now live under `<value>#<shard>` (CAP-02).
const DISPATCH_PARTITION_VALUE = process.env.DISPATCH_PARTITION_VALUE ?? "__dispatch__";
const DISPATCH_SHARD_COUNT = parseDispatchShardCount(process.env.DISPATCH_SHARD_COUNT);
const DISPATCH_CLAIM_PREFIX = process.env.DISPATCH_CLAIM_PREFIX ?? "__claim__#";
const DISPATCH_CLAIM_TTL_SECONDS = Number(process.env.DISPATCH_CLAIM_TTL_SECONDS ?? "900");
const DISPATCH_CLAIM_CONCURRENCY = positiveIntFromEnv(process.env.DISPATCH_CLAIM_CONCURRENCY, 16, 64);
const DEDUPE_PARTITION_VALUE = process.env.DEDUPE_PARTITION_VALUE ?? "__dedupe__";
const QUEUE_URL = process.env.QUEUE_URL!;
const QUEUE_BATCH_SIZE = positiveIntFromEnv(process.env.QUEUE_BATCH_SIZE, 10, 10);
const APNS_PLATFORM_APPLICATION_ARN = process.env.APNS_PLATFORM_APPLICATION_ARN;

const NOTIFICATIONS_METRIC_NAMESPACE = "BillBoard/Notifications";
const APNS_CERTIFICATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Time kept back from the Lambda timeout: a fifth of the time left at the start, 0.5 to 5 seconds.
// No new chunk of users is claimed once less than this remains, so every claimed user is sent.
const MIN_TIME_RESERVE_MS = 500;
const MAX_TIME_RESERVE_MS = 5000;

// Per warm container, so the schedule's 5-minute runs read the certificate at most every 6 hours.
let lastApnsCertificateCheckAtMs: number | undefined;
let loggedMissingApnsPlatformApplication = false;

type DispatcherContext = LambdaContextLike & { getRemainingTimeInMillis?: () => number };

interface RunClock {
  outOfTime(): boolean;
}

const createRunClock = (context?: DispatcherContext): RunClock => {
  const getRemaining = context?.getRemainingTimeInMillis;
  if (typeof getRemaining !== "function") return { outOfTime: () => false };
  const remaining = () => getRemaining.call(context);
  const reserveMs = Math.min(MAX_TIME_RESERVE_MS, Math.max(MIN_TIME_RESERVE_MS, Math.floor(remaining() * 0.2)));
  return { outOfTime: () => remaining() <= reserveMs };
};

const attributeValueToString = (attr: AttributeValue | undefined): string | null => {
  if (!attr) return null;
  if ("S" in attr && typeof attr.S === "string") return attr.S;
  if ("N" in attr && typeof attr.N === "string") return attr.N;
  return null;
};

/** A user with a pending-user marker, and every dispatch partition the marker was found in. */
interface DispatchCandidate {
  userId: string;
  markerPartitions: Set<string>;
  /** Oldest marker time; users waiting longest are claimed first when a run cannot take everyone. */
  oldestMarkerEpoch: number;
}

/** S5 and UX-33: why userNotifier held a user: their quiet hours, or the pace window of their last push. */
type HoldReason = "quiet_hours" | "pace";

/** A user whose claim userNotifier extended to the end of a hold, until when (epoch seconds), and why. */
interface DispatchHold {
  userId: string;
  untilEpoch: number;
  reason: HoldReason;
}

interface PartitionMarkers {
  markers: Array<{ userId: string; updatedAtEpoch: number }>;
  holds: DispatchHold[];
  complete: boolean;
}

const queryMarkerPartition = async (partitionValue: string, clock: RunClock): Promise<PartitionMarkers> => {
  const markers: PartitionMarkers["markers"] = [];
  const holds: PartitionMarkers["holds"] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamo.send(
      new QueryCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        KeyConditionExpression: "#pk = :dispatch",
        ProjectionExpression:
          "#sk, targetUserId, markerType, updatedAtEpoch, leaseExpiresAtEpoch, quietHoursUntilEpoch, " +
          "holdUntilEpoch, holdReason",
        ExpressionAttributeNames: {
          "#pk": DISPATCH_PARTITION_KEY,
          "#sk": DISPATCH_SORT_KEY,
        },
        ExpressionAttributeValues: {
          ":dispatch": { S: partitionValue },
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const markerType = attributeValueToString(item.markerType);
      const sortKeyValue = attributeValueToString(item[DISPATCH_SORT_KEY]);
      const targetUserId = attributeValueToString(item.targetUserId);
      const userId =
        markerType === "pending-user"
          ? (targetUserId ?? sortKeyValue)
          : !markerType && sortKeyValue && !sortKeyValue.startsWith(DISPATCH_CLAIM_PREFIX)
            ? sortKeyValue
            : null;
      if (userId) {
        const updatedAtEpoch = Number(attributeValueToString(item.updatedAtEpoch));
        markers.push({ userId, updatedAtEpoch: Number.isFinite(updatedAtEpoch) ? updatedAtEpoch : 0 });
      } else if (sortKeyValue?.startsWith(DISPATCH_CLAIM_PREFIX)) {
        // A claim holds the user until its lease ends; a hold names its end as well (`holdUntilEpoch` since UX-33,
        // `quietHoursUntilEpoch` on a quiet-hours hold, the only mark a userNotifier older than UX-33 writes).
        // Other items here (markers' neighbours such as the `__pace__#<user>` pace items) are neither.
        const holdUntil = Number(
          attributeValueToString(item.holdUntilEpoch) ?? attributeValueToString(item.quietHoursUntilEpoch),
        );
        const leaseUntil = Number(attributeValueToString(item.leaseExpiresAtEpoch));
        if (Number.isFinite(holdUntil) && Number.isFinite(leaseUntil)) {
          holds.push({
            userId: targetUserId ?? sortKeyValue.slice(DISPATCH_CLAIM_PREFIX.length),
            untilEpoch: Math.min(holdUntil, leaseUntil),
            reason: attributeValueToString(item.holdReason) === "pace" ? "pace" : "quiet_hours",
          });
        }
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
    if (lastEvaluatedKey && clock.outOfTime()) {
      return { markers, holds, complete: false };
    }
  } while (lastEvaluatedKey);

  return { markers, holds, complete: true };
};

// Reads the legacy unsharded partition (markers written by older versions during a rollout, TTL one
// day) and every shard, merging each user's partitions so userNotifier can delete all of them.
const readDispatchMarkers = async (
  clock: RunClock,
): Promise<{ candidates: DispatchCandidate[]; holdOf: Map<string, DispatchHold>; complete: boolean }> => {
  const partitionValues = [
    DISPATCH_PARTITION_VALUE,
    ...allDispatchShardPartitionValues(DISPATCH_PARTITION_VALUE, DISPATCH_SHARD_COUNT),
  ];
  const results = await mapWithConcurrency(partitionValues, 16, (partitionValue) =>
    queryMarkerPartition(partitionValue, clock),
  );

  const byUser = new Map<string, DispatchCandidate>();
  // A user held in several partitions is held until the latest end.
  const holdOf = new Map<string, DispatchHold>();
  for (const result of results) {
    for (const hold of result.holds) {
      const known = holdOf.get(hold.userId);
      if (!known || hold.untilEpoch > known.untilEpoch) holdOf.set(hold.userId, hold);
    }
  }
  results.forEach((result, index) => {
    for (const marker of result.markers) {
      const candidate = byUser.get(marker.userId) ?? {
        userId: marker.userId,
        markerPartitions: new Set<string>(),
        oldestMarkerEpoch: marker.updatedAtEpoch,
      };
      candidate.markerPartitions.add(partitionValues[index]);
      candidate.oldestMarkerEpoch = Math.min(candidate.oldestMarkerEpoch, marker.updatedAtEpoch);
      byUser.set(marker.userId, candidate);
    }
  });

  // Stable sort: equal times keep partition order (legacy first, then shard 0, 1, ...).
  const candidates = Array.from(byUser.values()).sort((a, b) => a.oldestMarkerEpoch - b.oldestMarkerEpoch);
  return { candidates, holdOf, complete: results.every((result) => result.complete) };
};

// Pending rows written before dispatch markers existed; only used when no marker partition has any.
const scanForDistinctUserIdsLegacy = async (clock: RunClock): Promise<string[]> => {
  const userIds = new Set<string>();
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await dynamo.send(
      new ScanCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        ProjectionExpression: `#pk`,
        ExpressionAttributeNames: {
          "#pk": PARTITION_KEY,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const userId = attributeValueToString(item[PARTITION_KEY]);
      if (userId && userId !== DEDUPE_PARTITION_VALUE && !isDispatchPartitionValue(userId, DISPATCH_PARTITION_VALUE)) {
        userIds.add(userId);
      }
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey && !clock.outOfTime());

  return Array.from(userIds);
};

const findDispatchCandidates = async (
  clock: RunClock,
): Promise<{ candidates: DispatchCandidate[]; holdOf: Map<string, DispatchHold> }> => {
  const { candidates, holdOf, complete } = await readDispatchMarkers(clock);
  if (candidates.length > 0 || !complete) {
    return { candidates, holdOf };
  }
  const legacyUserIds = await scanForDistinctUserIdsLegacy(clock);
  return {
    candidates: legacyUserIds.map((userId) => ({ userId, markerPartitions: new Set<string>(), oldestMarkerEpoch: 0 })),
    holdOf,
  };
};

/**
 * S5 and UX-33: users userNotifier held, for their quiet hours or the pace window of their last push, keep their claim
 * until the hold ends; claiming them would fail anyway (the claim's lease has not ended), so they are left out of the
 * run and counted by reason. The first run after the hold claims them and userNotifier sends what is pending. Other
 * claims are left to the claim step, as before.
 */
const withoutHolds = (
  candidates: DispatchCandidate[],
  holdOf: ReadonlyMap<string, DispatchHold>,
  nowEpoch: number,
): { dispatchable: DispatchCandidate[]; heldForQuietHours: number; heldForPace: number } => {
  const dispatchable: DispatchCandidate[] = [];
  let heldForQuietHours = 0;
  let heldForPace = 0;
  for (const candidate of candidates) {
    const hold = holdOf.get(candidate.userId);
    if (!hold || hold.untilEpoch < nowEpoch) dispatchable.push(candidate);
    else if (hold.reason === "pace") heldForPace += 1;
    else heldForQuietHours += 1;
  }
  return { dispatchable, heldForQuietHours, heldForPace };
};

/**
 * The partitions a user is claimed and released in: always the user's own shard, plus every
 * partition a marker was found in (the legacy one during a rollout, so an older dispatcher, which
 * only knows the legacy claim, cannot dispatch the same user at the same time).
 */
const dispatchPartitionsFor = (candidate: DispatchCandidate): string[] =>
  Array.from(
    new Set([
      dispatchShardPartitionValue(DISPATCH_PARTITION_VALUE, candidate.userId, DISPATCH_SHARD_COUNT),
      ...candidate.markerPartitions,
    ]),
  );

const isConditionalCheckFailed = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const name =
    error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : "";
  return name === "ConditionalCheckFailedException" || message.includes("ConditionalCheckFailed");
};

const claimUserInPartition = async (userId: string, partitionValue: string): Promise<boolean> => {
  const now = Math.floor(Date.now() / 1000);
  const leaseExpiresAt = now + DISPATCH_CLAIM_TTL_SECONDS;

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: PENDING_NOTIFICATIONS_TABLE,
        Item: {
          [DISPATCH_PARTITION_KEY]: { S: partitionValue },
          [DISPATCH_SORT_KEY]: { S: `${DISPATCH_CLAIM_PREFIX}${userId}` },
          markerType: { S: "dispatch-claim" },
          targetUserId: { S: userId },
          claimedAtEpoch: { N: String(now) },
          leaseExpiresAtEpoch: { N: String(leaseExpiresAt) },
          ttl: { N: String(leaseExpiresAt) },
        },
        ConditionExpression: "attribute_not_exists(#pk) OR attribute_not_exists(#lease) OR #lease < :now",
        ExpressionAttributeNames: {
          "#pk": DISPATCH_PARTITION_KEY,
          "#lease": "leaseExpiresAtEpoch",
        },
        ExpressionAttributeValues: {
          ":now": { N: String(now) },
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return false;
    }
    throw error;
  }
};

// Best effort: a claim left behind only delays the user until its lease ends.
const releaseClaims = async (userId: string, partitions: readonly string[]): Promise<void> => {
  for (const partitionValue of partitions) {
    try {
      await dynamo.send(
        new DeleteItemCommand({
          TableName: PENDING_NOTIFICATIONS_TABLE,
          Key: {
            [DISPATCH_PARTITION_KEY]: { S: partitionValue },
            [DISPATCH_SORT_KEY]: { S: `${DISPATCH_CLAIM_PREFIX}${userId}` },
          },
        }),
      );
    } catch (error) {
      logger.warn("Failed to release a partial dispatch claim", { userId, dispatchPartition: partitionValue, error });
    }
  }
};

// False when another run holds the user in any of the partitions. Claims taken before the one that
// failed (or threw) are released, so they do not hold the user for the whole lease.
const claimUserForDispatch = async (userId: string, partitions: readonly string[]): Promise<boolean> => {
  const acquired: string[] = [];
  for (const partitionValue of partitions) {
    let claimed: boolean;
    try {
      claimed = await claimUserInPartition(userId, partitionValue);
    } catch (error) {
      await releaseClaims(userId, acquired);
      throw error;
    }
    if (!claimed) {
      await releaseClaims(userId, acquired);
      return false;
    }
    acquired.push(partitionValue);
  }
  return true;
};

interface ClaimedUser {
  userId: string;
  dispatchPartitions: string[];
}

// Publishes the days left on the APNs certificate for the expiry alarm (REC-04).
// Never throws: the dispatch run must not depend on this check.
const emitApnsCertificateDaysRemaining = async (): Promise<void> => {
  if (!APNS_PLATFORM_APPLICATION_ARN) {
    if (!loggedMissingApnsPlatformApplication) {
      loggedMissingApnsPlatformApplication = true;
      logger.info("APNS_PLATFORM_APPLICATION_ARN is not set; skipping APNs certificate expiry metric");
    }
    return;
  }
  const nowMs = Date.now();
  if (
    lastApnsCertificateCheckAtMs !== undefined &&
    nowMs - lastApnsCertificateCheckAtMs < APNS_CERTIFICATE_CHECK_INTERVAL_MS
  ) {
    return;
  }
  lastApnsCertificateCheckAtMs = nowMs;

  try {
    sns ??= new SNSClient({});
    const response = await sns.send(
      new GetPlatformApplicationAttributesCommand({ PlatformApplicationArn: APNS_PLATFORM_APPLICATION_ARN }),
    );
    const expiration = response.Attributes?.AppleCertificateExpirationDate;
    if (!expiration) {
      logger.warn("APNs platform application has no AppleCertificateExpirationDate");
      return;
    }
    const expiresAtMs = Date.parse(expiration);
    if (!Number.isFinite(expiresAtMs)) {
      logger.warn("Unparseable AppleCertificateExpirationDate", { expiration });
      return;
    }

    const daysRemaining = Math.floor((expiresAtMs - nowMs) / MS_PER_DAY);
    await putMetric(NOTIFICATIONS_METRIC_NAMESPACE, "ApnsCertificateDaysRemaining", daysRemaining);
    logger.info("APNs certificate expiry checked", { expiration, daysRemaining });
  } catch (error) {
    // The platform application is only created once the APNs secret is seeded.
    if ((error as { name?: unknown } | null)?.name === "NotFoundException") {
      logger.info("APNs platform application not found; skipping certificate expiry metric", {
        platformApplicationArn: APNS_PLATFORM_APPLICATION_ARN,
      });
      return;
    }
    logger.warn("Failed to read APNs certificate expiry", { error });
  }
};

// A message names up to USER_BATCH_SIZE users, each with pending rows for any number of bills, so it
// carries this run's correlation id; userNotifier logs each bill's own id from its pending row.
// `dispatchPartitions` tells userNotifier which marker and claim keys to delete for each user.
const sendUserIdBatches = async (
  claimed: readonly ClaimedUser[],
  correlationId: string,
  firstMessageIndex: number,
): Promise<number> => {
  if (claimed.length === 0) {
    return 0;
  }

  const messages = [];
  for (let i = 0; i < claimed.length; i += USER_BATCH_SIZE) {
    const users = claimed.slice(i, i + USER_BATCH_SIZE);
    messages.push({
      Id: `batch-${firstMessageIndex + messages.length}`,
      MessageBody: JSON.stringify({
        userIds: users.map((user) => user.userId),
        dispatchPartitions: Object.fromEntries(users.map((user) => [user.userId, user.dispatchPartitions])),
      }),
      ...correlationIdMessageAttributes(correlationId),
    });
  }

  return sendMessageBatchWithRetry(sqs, QUEUE_URL, messages, { batchSize: QUEUE_BATCH_SIZE });
};

export const handler = async (
  event: ScheduledEvent<unknown>,
  context?: DispatcherContext,
): Promise<{ status: string; distinctUsers: number; batchesSent: number }> => {
  logger.resetContext(context);
  const clock = createRunClock(context);
  // One id per dispatch run, sent to userNotifier with every batch.
  const correlationId = mintCorrelationId();
  logger.appendKeys({ correlationId });
  if (!PENDING_NOTIFICATIONS_TABLE) {
    throw new Error("Missing env var PENDING_NOTIFICATIONS_TABLE");
  }
  if (!PARTITION_KEY) {
    throw new Error("Missing env var PARTITION_KEY");
  }
  if (!QUEUE_URL) {
    throw new Error("Missing env var QUEUE_URL");
  }

  logger.info("Starting notification dispatcher", { eventTime: event.time, shardCount: DISPATCH_SHARD_COUNT });

  await emitApnsCertificateDaysRemaining();

  const found = await findDispatchCandidates(clock);
  const {
    dispatchable: candidates,
    heldForQuietHours,
    heldForPace,
  } = withoutHolds(found.candidates, found.holdOf, Math.floor(Date.now() / 1000));
  logger.info("Scanned distinct user IDs", { count: found.candidates.length, heldForQuietHours, heldForPace });

  if (candidates.length === 0) {
    logger.info(
      heldForQuietHours + heldForPace === 0
        ? "No pending notifications to dispatch"
        : heldForPace === 0
          ? "Every user with pending notifications is in quiet hours"
          : "Every user with pending notifications is held for the quiet hours or the push pace",
    );
    return { status: "ok", distinctUsers: found.candidates.length, batchesSent: 0 };
  }

  // CAP-02: claim a chunk of users at a time with bounded concurrency and send each chunk
  // before claiming the next, so a run that stops for time never holds a claim it did not send. Users
  // not reached keep their markers for the next 5-minute run.
  const chunkSize = USER_BATCH_SIZE * QUEUE_BATCH_SIZE;
  let batchesSent = 0;
  let claimedUsers = 0;
  let claimFailures = 0;
  let reached = 0;
  for (let i = 0; i < candidates.length; i += chunkSize) {
    if (clock.outOfTime()) break;
    const chunk = candidates.slice(i, i + chunkSize);
    const results = await mapWithConcurrency(chunk, DISPATCH_CLAIM_CONCURRENCY, async (candidate) => {
      const dispatchPartitions = dispatchPartitionsFor(candidate);
      try {
        return (await claimUserForDispatch(candidate.userId, dispatchPartitions))
          ? { userId: candidate.userId, dispatchPartitions }
          : null;
      } catch (error) {
        claimFailures += 1;
        logger.error("Failed to claim user for dispatch", { userId: candidate.userId, error });
        return null;
      }
    });
    const claimed = results.filter((result): result is ClaimedUser => result !== null);
    batchesSent += await sendUserIdBatches(claimed, correlationId, batchesSent);
    claimedUsers += claimed.length;
    reached += chunk.length;
  }

  const deferredUsers = candidates.length - reached;
  if (deferredUsers > 0) {
    logger.warn("Stopped dispatch run early to stay within the timeout; the rest wait for the next run", {
      deferredUsers,
      reachedUsers: reached,
    });
  }
  logger.info("Claimed user IDs for dispatch", { claimedUsers, scannedUsers: candidates.length });
  if (claimedUsers === 0) {
    logger.info("No dispatchable users after claim step");
  } else {
    logger.info("Dispatched user ID batches to queue", { batchesSent, totalUsers: claimedUsers });
  }

  // Everything claimed has been sent; fail the run so the error alarm sees DynamoDB claim failures.
  if (claimFailures > 0) {
    throw new Error(`Failed to claim ${claimFailures} user(s) for dispatch`);
  }

  return { status: deferredUsers > 0 ? "partial" : "ok", distinctUsers: found.candidates.length, batchesSent };
};
