import { createHash } from "node:crypto";

/**
 * Dispatch marker sharding (CAP-02).
 *
 * userMatcher (inline) and notificationFanout write one "pending-user" marker per user who has
 * pending notifications; notificationDispatcher reads them every 5 minutes and userNotifier
 * deletes them. Every marker used to share the single partition value `__dispatch__`, which
 * caps at about 1,000 writes a second. Markers and dispatch claims now live under
 * `__dispatch__#<n>`, where n is a stable hash of the user id modulo DISPATCH_SHARD_COUNT.
 *
 * The legacy unsharded value is still read by the dispatcher and deleted by userNotifier, so
 * markers written by an older Lambda version during a rollout (TTL one day for versions before D1,
 * 26 hours since) are never lost.
 *
 * DISPATCH_SHARD_COUNT must be the same for every function that reads or writes markers. It may
 * be raised later only after the dispatcher reads the larger count; lowering it hides the markers
 * in the dropped shards from the dispatcher.
 */

export const LEGACY_DISPATCH_PARTITION_VALUE = "__dispatch__";

/**
 * A random value every marker write sets anew. userNotifier reads it before querying the user's
 * pending rows and deletes the marker only if it still holds that value, so a marker rewritten by a
 * pending-notification write that committed after the read (whatever its timestamp) survives.
 */
export const DISPATCH_MARKER_VERSION_ATTRIBUTE = "markerVersion";
export const DEFAULT_DISPATCH_SHARD_COUNT = 8;
export const MAX_DISPATCH_SHARD_COUNT = 256;

/** DISPATCH_SHARD_COUNT as a whole number in [1, MAX_DISPATCH_SHARD_COUNT]; the default when unset or invalid. */
export const parseDispatchShardCount = (raw: string | undefined): number => {
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_DISPATCH_SHARD_COUNT;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_DISPATCH_SHARD_COUNT) return DEFAULT_DISPATCH_SHARD_COUNT;
  return value;
};

/**
 * Stable shard index for a user: the first four bytes of SHA-256(userId) modulo the shard count.
 * The same user id maps to the same shard in every function and on every runtime version.
 */
export const dispatchShardIndex = (userId: string, shardCount: number): number => {
  const count = Number.isInteger(shardCount) && shardCount >= 1 ? shardCount : DEFAULT_DISPATCH_SHARD_COUNT;
  return createHash("sha256").update(userId, "utf8").digest().readUInt32BE(0) % count;
};

/** `<base>#<n>`: the partition value that holds this user's marker and dispatch claim. */
export const dispatchShardPartitionValue = (baseValue: string, userId: string, shardCount: number): string =>
  `${baseValue}#${dispatchShardIndex(userId, shardCount)}`;

/** Every sharded partition value, `<base>#0` to `<base>#<count-1>`. */
export const allDispatchShardPartitionValues = (baseValue: string, shardCount: number): string[] =>
  Array.from({ length: shardCount }, (_, index) => `${baseValue}#${index}`);

/** True for the legacy value itself and for any `<base>#<digits>` shard value. */
export const isDispatchPartitionValue = (value: unknown, baseValue: string): value is string => {
  if (typeof value !== "string") return false;
  if (value === baseValue) return true;
  if (!value.startsWith(`${baseValue}#`)) return false;
  return /^\d{1,3}$/.test(value.slice(baseValue.length + 1));
};
