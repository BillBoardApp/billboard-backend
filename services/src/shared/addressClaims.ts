import {
  BatchGetItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DynamoDBClient,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import {
  ADDRESS_CHANGE_WINDOW_MS,
  MAX_ADDRESS_CHANGES_PER_WINDOW,
  MAX_VERIFIED_ACCOUNTS_PER_ADDRESS,
  STREET_CLUSTER_FLAG_THRESHOLD,
} from "./abuseLimits";
import { normalizeDeletionStatus } from "./adultEligibility";
import { logger } from "./logger";
import { backoffDelayMs, sleep } from "./retry";

/**
 * INT-03 verification limits (decision 3A): at most MAX_VERIFIED_ACCOUNTS_PER_ADDRESS verified accounts per
 * address (matched address + unit) and at most MAX_ADDRESS_CHANGES_PER_WINDOW changes to a new verified address
 * per account in ADDRESS_CHANGE_WINDOW_MS (the values live in abuseLimits.ts).
 *
 * Table `VerifiedAddressClaims` (PK `claimKey`, SK `member`) holds, for each address:
 * - `U#<unitKey>` / `USER#<userId>`: one claim per verified account at that unit (`claimedAt`);
 * - `U#<unitKey>` / `#COUNT`: `n`, the unit's active claims;
 * - `S#<streetKey>` / `#COUNT`: `n`, the active claims across every unit of the street address.
 * The keys are salted one-way hashes; neither the address nor the unit is stored. A claim and its
 * two counters always change in one transaction, so the counters equal the claims.
 *
 * The account's current claim is mirrored on its UserPII row (`verifiedAddressKey`,
 * `verifiedStreetKey`), with `addressChangeLog` (the times of its last MAX_ADDRESS_CHANGES_PER_WINDOW address
 * changes).
 *
 * Used by DistrictVerification (claims, limits, self-heal), RestampUserVotes (the vote stamp) and
 * the shared account deletion (X5: `releaseAddressClaim`, `addressClaimExists`).
 */

type Db = Pick<DynamoDBClient, "send">;
type Item = Record<string, AttributeValue>;

/** EMF namespace of the account-integrity metrics (C2 3.11); no IAM permission needed. */
export const ACCOUNT_INTEGRITY_METRIC_NAMESPACE = "BillBoard/AccountIntegrity";

export {
  ADDRESS_CHANGE_WINDOW_MS,
  MAX_ADDRESS_CHANGES_PER_WINDOW,
  MAX_VERIFIED_ACCOUNTS_PER_ADDRESS,
  STREET_CLUSTER_FLAG_THRESHOLD,
};

export const ADDRESS_CLAIM_PARTITION_KEY = "claimKey";
export const ADDRESS_CLAIM_SORT_KEY = "member";
export const ADDRESS_CLAIM_COUNT_MEMBER = "#COUNT";
export const ADDRESS_CLAIM_USER_PREFIX = "USER#";
const COUNTER_ATTRIBUTE = "n";

/** UserPII attributes that describe the account's address claim (X5 removes them at deletion). */
export const ADDRESS_CLAIM_PII_ATTRIBUTES = ["verifiedAddressKey", "verifiedStreetKey", "addressChangeLog"] as const;

/** Delay on the re-stamp message, so the verification write lands before the worker reads it. */
export const RESTAMP_MESSAGE_DELAY_SECONDS = 10;

// ─── Modes ────────────────────────────────────────────────────────────────────

export type VerificationLimitsMode = "watch" | "enforce";

/**
 * VERIFICATION_LIMITS_MODE: `enforce` caps and refuses; anything else (unset included) is `watch`,
 * which writes claims and counters exactly as enforce does but only emits the metrics.
 */
export const verificationLimitsMode = (
  value: string | undefined = process.env.VERIFICATION_LIMITS_MODE,
): VerificationLimitsMode => (value === "enforce" ? "enforce" : "watch");

// ─── Keys ─────────────────────────────────────────────────────────────────────

const UNIT_DESIGNATOR_ALTERNATION = "APT|APARTMENT|UNIT|STE|SUITE|FL|FLOOR|BLDG|BUILDING|RM|ROOM|#";
const UNIT_SUFFIX_AFTER_COMMA = new RegExp(`,\\s*(${UNIT_DESIGNATOR_ALTERNATION})\\s*[\\w-]+.*$`, "i");
const UNIT_SUFFIX_AFTER_SPACE = new RegExp(`\\s+(${UNIT_DESIGNATOR_ALTERNATION})\\s*[\\w-]+.*$`, "i");
// Longest first, so a designator glued to its number ("APT4B") loses the whole word.
const UNIT_DESIGNATOR_WORDS = [
  "APARTMENT",
  "BUILDING",
  "SUITE",
  "FLOOR",
  "UNIT",
  "BLDG",
  "ROOM",
  "APT",
  "STE",
  "FL",
  "RM",
];

const collapseSpaces = (raw: string): string => raw.replace(/\s+/g, " ").trim();

/** The street line without a trailing unit ("1 Main St Apt 4" becomes "1 Main St"). */
export function stripUnitSuffix(street: string): string {
  return collapseSpaces(street.replace(UNIT_SUFFIX_AFTER_COMMA, "").replace(UNIT_SUFFIX_AFTER_SPACE, ""));
}

/** The geocoder's matched address as keyed: upper case, single spaces. */
export function normalizeMatchedAddress(raw: string): string {
  return collapseSpaces(raw).toUpperCase();
}

/**
 * A unit as keyed: upper case, designators (APT, APARTMENT, UNIT, STE, SUITE, FL, FLOOR, BLDG,
 * BUILDING, RM, ROOM, #) removed, only A-Z and 0-9 kept. "#4b", "Apt 4B" and "APT4B" all give "4B".
 * Empty when there is no unit.
 */
export function normalizeUnit(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((token) => {
      if (UNIT_DESIGNATOR_WORDS.includes(token)) return "";
      const glued = UNIT_DESIGNATOR_WORDS.find(
        (word) => token.startsWith(word) && /^[0-9]/.test(token.slice(word.length)),
      );
      return glued ? token.slice(glued.length) : token;
    })
    .join("");
}

/** The unit from `line2`, or else the suffix `stripUnitSuffix` removes from `line1`. */
export function unitFromAddressLines(line1: string, line2?: string | null): string {
  const fromLine2 = normalizeUnit(line2);
  if (fromLine2) return fromLine2;
  const primary = collapseSpaces(line1);
  const stripped = stripUnitSuffix(primary);
  return stripped.length < primary.length ? normalizeUnit(primary.slice(stripped.length)) : "";
}

export interface AddressClaimKeys {
  /** Hash of the matched address and unit: one verified-account slot set per unit. */
  unitKey: string;
  /** Hash of the matched address alone: every unit of the street address. */
  streetKey: string;
}

/**
 * The claim keys for a geocoded address. `hash` is DistrictVerification's salted SHA-256 (the same
 * salt secret as its log hashes); the versioned prefixes keep these hashes apart from those.
 */
export function addressClaimKeys(
  matchedAddress: string,
  unit: string,
  hash: (value: string) => string,
): AddressClaimKeys {
  const matched = normalizeMatchedAddress(matchedAddress);
  return {
    unitKey: hash(`addr-unit:v1:${matched}|${unit}`),
    streetKey: hash(`addr-street:v1:${matched}`),
  };
}

export const unitClaimKey = (unitKey: string): string => `U#${unitKey}`;
export const streetClaimKey = (streetKey: string): string => `S#${streetKey}`;
export const userClaimMember = (userId: string): string => `${ADDRESS_CLAIM_USER_PREFIX}${userId}`;

const claimTableKey = (claimKey: string, member: string): Item => ({
  [ADDRESS_CLAIM_PARTITION_KEY]: { S: claimKey },
  [ADDRESS_CLAIM_SORT_KEY]: { S: member },
});

// ─── The account's claim, change log and vote stamp (UserPII) ─────────────────

/** The claim an account holds, as its UserPII row records it. */
export interface HeldAddressClaim {
  unitKey: string;
  /** Absent only on a row written by hand; the street counter is then left alone. */
  streetKey?: string;
}

/** The claim recorded on a UserPII item (`verifiedAddressKey`, `verifiedStreetKey`), or null. */
export function heldAddressClaimFromPii(item: Item | null | undefined): HeldAddressClaim | null {
  const unitKey = item?.verifiedAddressKey?.S;
  if (!unitKey) return null;
  const streetKey = item?.verifiedStreetKey?.S;
  return streetKey ? { unitKey, streetKey } : { unitKey };
}

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

/** `addressChangeLog` (L of S, ISO times) from a UserPII item; unreadable entries are dropped. */
export function addressChangeLogFromPii(item: Item | null | undefined): string[] {
  return (item?.addressChangeLog?.L ?? []).map((entry) => entry?.S).filter(isTimestamp);
}

/** The change times (epoch ms, oldest first) less than ADDRESS_CHANGE_WINDOW_MS before `nowMs`. */
export function recentAddressChangeTimes(log: readonly string[], nowMs: number): number[] {
  return log
    .map((entry) => Date.parse(entry))
    .filter((time) => Number.isFinite(time) && nowMs - time < ADDRESS_CHANGE_WINDOW_MS)
    .sort((a, b) => a - b);
}

/**
 * When the account may change to a new address again (epoch ms), or null when it may now: after
 * MAX_ADDRESS_CHANGES_PER_WINDOW changes in ADDRESS_CHANGE_WINDOW_MS, the time the oldest of them leaves the window.
 */
export function nextAddressChangeAllowedAt(log: readonly string[], nowMs: number): number | null {
  const recent = recentAddressChangeTimes(log, nowMs);
  if (recent.length < MAX_ADDRESS_CHANGES_PER_WINDOW) return null;
  return recent[recent.length - MAX_ADDRESS_CHANGES_PER_WINDOW] + ADDRESS_CHANGE_WINDOW_MS;
}

/** The log with `nowIso` appended, oldest first, keeping the newest MAX_ADDRESS_CHANGES_PER_WINDOW. */
export function appendAddressChange(log: readonly string[], nowIso: string): string[] {
  return [...log.filter(isTimestamp), nowIso]
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .slice(-MAX_ADDRESS_CHANGES_PER_WINDOW);
}

/** The verification fields a vote row carries (SetFeedback stamps them; RestampUserVotes rewrites them). */
export interface VerificationStamp {
  constituentVerified: boolean;
  verificationStatus: string;
  /** Only when verified. */
  resolvedState?: string;
  /** Only when verified. */
  resolvedDistrict?: string;
}

/** The stamp a vote cast now would get from this UserPII item, exactly as SetFeedback derives it. */
export function verificationStampFromPii(item: Item | null | undefined): VerificationStamp {
  const verified = item?.constituentVerified?.BOOL === true;
  const stamp: VerificationStamp = {
    constituentVerified: verified,
    verificationStatus: item?.verificationStatus?.S ?? (verified ? "likely_constituent" : "self_attested"),
  };
  if (verified && item?.resolvedState?.S) stamp.resolvedState = item.resolvedState.S;
  if (verified && item?.resolvedDistrict?.S) stamp.resolvedDistrict = item.resolvedDistrict.S;
  return stamp;
}

export function sameVerificationStamp(a: VerificationStamp, b: VerificationStamp): boolean {
  return (
    a.constituentVerified === b.constituentVerified &&
    a.verificationStatus === b.verificationStatus &&
    (a.resolvedState ?? null) === (b.resolvedState ?? null) &&
    (a.resolvedDistrict ?? null) === (b.resolvedDistrict ?? null)
  );
}

// ─── Re-stamp message ─────────────────────────────────────────────────────────

/** The RestampUserVotesQueue message body: `{"userId": "<sub>"}`. */
export const restampMessageBody = (userId: string): string => JSON.stringify({ userId });

/** The user ID of a re-stamp message, or null when the body is not `{"userId": "<non-empty string>"}`. */
export function parseRestampMessage(body: string | null | undefined): string | null {
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body) as { userId?: unknown } | null;
    const userId = typeof parsed?.userId === "string" ? parsed.userId.trim() : "";
    return userId || null;
  } catch {
    return null;
  }
}

// ─── Transactions ─────────────────────────────────────────────────────────────

/** One item of a TransactWriteItems call, named so a cancellation can say which condition failed. */
export interface TransactionPart<Role extends string = string> {
  role: Role;
  item: TransactWriteItem;
}

export type TransactionResult<Role extends string> = { ok: true } | { ok: false; failed: Set<Role> };

const TRANSIENT_CANCELLATION_CODES = new Set([
  "TransactionConflict",
  "ThrottlingError",
  "ProvisionedThroughputExceeded",
]);
const TRANSIENT_RETRIES = 2;

/**
 * Runs the parts as one transaction. Returns the roles whose condition failed when DynamoDB
 * cancels it on a condition; retries a cancellation caused only by a conflicting transaction or
 * throttling twice (jittered), then throws. Any other error is thrown.
 */
export async function sendTransaction<Role extends string>(
  db: Db,
  parts: readonly TransactionPart<Role>[],
): Promise<TransactionResult<Role>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.send(new TransactWriteItemsCommand({ TransactItems: parts.map((part) => part.item) }));
      return { ok: true };
    } catch (error) {
      const cancelled = error as { name?: string; CancellationReasons?: Array<{ Code?: string } | null> };
      if (cancelled?.name !== "TransactionCanceledException") throw error;
      const reasons = cancelled.CancellationReasons ?? [];
      const failed = new Set<Role>();
      reasons.forEach((reason, index) => {
        if (reason?.Code === "ConditionalCheckFailed" && parts[index]) failed.add(parts[index].role);
      });
      if (failed.size > 0) return { ok: false, failed };
      const transient = reasons.some((reason) => TRANSIENT_CANCELLATION_CODES.has(reason?.Code ?? ""));
      if (!transient || attempt >= TRANSIENT_RETRIES) throw error;
      await sleep(backoffDelayMs(attempt, { baseMs: 50, maxMs: 400 }));
    }
  }
}

/** `n += 1` on a counter row; with `maxBefore`, only while `n < maxBefore` (the enforce cap). */
export function incrementCounterItem(tableName: string, claimKey: string, maxBefore?: number): TransactWriteItem {
  const capped = maxBefore !== undefined;
  return {
    Update: {
      TableName: tableName,
      Key: claimTableKey(claimKey, ADDRESS_CLAIM_COUNT_MEMBER),
      UpdateExpression: "SET #n = if_not_exists(#n, :zero) + :one",
      ...(capped ? { ConditionExpression: "attribute_not_exists(#n) OR #n < :max" } : {}),
      ExpressionAttributeNames: { "#n": COUNTER_ATTRIBUTE },
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":one": { N: "1" },
        ...(capped ? { ":max": { N: String(maxBefore) } } : {}),
      },
    },
  };
}

/** `n -= 1` on a counter row, only while `n > 0`. */
export function decrementCounterItem(tableName: string, claimKey: string): TransactWriteItem {
  return {
    Update: {
      TableName: tableName,
      Key: claimTableKey(claimKey, ADDRESS_CLAIM_COUNT_MEMBER),
      UpdateExpression: "SET #n = #n - :one",
      ConditionExpression: "#n > :zero",
      ExpressionAttributeNames: { "#n": COUNTER_ATTRIBUTE },
      ExpressionAttributeValues: { ":zero": { N: "0" }, ":one": { N: "1" } },
    },
  };
}

/** Puts the account's claim on a unit; fails when it already holds one there. */
export function putClaimItem(tableName: string, unitKey: string, userId: string, claimedAt: string): TransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: { ...claimTableKey(unitClaimKey(unitKey), userClaimMember(userId)), claimedAt: { S: claimedAt } },
      ConditionExpression: "attribute_not_exists(#m)",
      ExpressionAttributeNames: { "#m": ADDRESS_CLAIM_SORT_KEY },
    },
  };
}

/** Deletes the account's claim on a unit; fails when there is none. */
export function deleteClaimItem(tableName: string, unitKey: string, userId: string): TransactWriteItem {
  return {
    Delete: {
      TableName: tableName,
      Key: claimTableKey(unitClaimKey(unitKey), userClaimMember(userId)),
      ConditionExpression: "attribute_exists(#m)",
      ExpressionAttributeNames: { "#m": ADDRESS_CLAIM_SORT_KEY },
    },
  };
}

export type ReleaseRole = "prevClaim" | "prevUnitCounter" | "prevStreetCounter";

export interface ReleaseOptions {
  /** Leave the unit counter alone (it is already 0: counter drift). */
  skipUnitCounter?: boolean;
  /** Leave the street counter alone (drift, no street key, or the caller nets it out itself). */
  skipStreetCounter?: boolean;
}

/** The parts that release a claim: delete it, then decrement its unit and street counters. */
export function releaseClaimParts(
  tableName: string,
  userId: string,
  claim: HeldAddressClaim,
  options: ReleaseOptions = {},
): TransactionPart<ReleaseRole>[] {
  const parts: TransactionPart<ReleaseRole>[] = [
    { role: "prevClaim", item: deleteClaimItem(tableName, claim.unitKey, userId) },
  ];
  if (!options.skipUnitCounter) {
    parts.push({ role: "prevUnitCounter", item: decrementCounterItem(tableName, unitClaimKey(claim.unitKey)) });
  }
  if (!options.skipStreetCounter && claim.streetKey) {
    parts.push({ role: "prevStreetCounter", item: decrementCounterItem(tableName, streetClaimKey(claim.streetKey)) });
  }
  return parts;
}

/**
 * After a cancelled release, the options for the next attempt: a counter whose `n > 0` failed is
 * left out (logged as drift; the counters equal the claims by construction, so this needs a hand
 * edit or a partial restore). Returns null when the claim itself was missing.
 */
export function adjustReleaseAfterCancellation(
  options: ReleaseOptions,
  failed: ReadonlySet<string>,
): ReleaseOptions | null {
  if (failed.has("prevClaim")) return null;
  const unitDrift = failed.has("prevUnitCounter");
  const streetDrift = failed.has("prevStreetCounter");
  if (unitDrift || streetDrift) {
    logger.warn("Address claim counter drift: a counter was already 0; releasing the claim without it", {
      unitCounter: unitDrift,
      streetCounter: streetDrift,
    });
  }
  return {
    skipUnitCounter: Boolean(options.skipUnitCounter) || unitDrift,
    skipStreetCounter: Boolean(options.skipStreetCounter) || streetDrift,
  };
}

export type ReleaseAddressClaimResult = "released" | "no_claim";

/**
 * X5 (a): releases the account's address claim in one transaction (deletes `U#<unit>/USER#<id>`
 * and decrements the unit and street counters). A no-op returning "no_claim" when `claim` is
 * null or the claim row is already gone, so a retried deletion is harmless. The caller updates
 * the UserPII row (ADDRESS_CLAIM_PII_ATTRIBUTES) itself. Throws on any other error.
 *
 * IAM: dynamodb:DeleteItem and dynamodb:UpdateItem on the claims table.
 */
export async function releaseAddressClaim(input: {
  db: Db;
  tableName: string;
  userId: string;
  claim: HeldAddressClaim | null | undefined;
}): Promise<ReleaseAddressClaimResult> {
  const { db, tableName, userId, claim } = input;
  if (!claim?.unitKey) return "no_claim";

  let options: ReleaseOptions | null = { skipStreetCounter: !claim.streetKey };
  for (let attempt = 0; attempt < 3 && options; attempt += 1) {
    const result = await sendTransaction(db, releaseClaimParts(tableName, userId, claim, options));
    if (result.ok) return "released";
    options = adjustReleaseAfterCancellation(options, result.failed);
  }
  if (!options) return "no_claim";
  throw new Error("Address claim release did not settle after 3 attempts");
}

/**
 * X5 dry run: whether the claim row the UserPII item points at exists (one GetItem; false with no
 * claim). IAM: dynamodb:GetItem on the claims table.
 */
export async function addressClaimExists(input: {
  db: Db;
  tableName: string;
  userId: string;
  claim: HeldAddressClaim | null | undefined;
}): Promise<boolean> {
  const { db, tableName, userId, claim } = input;
  if (!claim?.unitKey) return false;
  const result = await db.send(
    new GetItemCommand({
      TableName: tableName,
      Key: claimTableKey(unitClaimKey(claim.unitKey), userClaimMember(userId)),
      ProjectionExpression: "#m",
      ExpressionAttributeNames: { "#m": ADDRESS_CLAIM_SORT_KEY },
    }),
  );
  return Boolean(result.Item);
}

// ─── Reads and the self-heal ──────────────────────────────────────────────────

/** The user IDs holding a claim on a unit (Query `U#<unit>`, members beginning `USER#`). */
export async function listUnitClaimants(db: Db, tableName: string, unitKey: string): Promise<string[]> {
  const userIds: string[] = [];
  let startKey: Item | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "#k = :k AND begins_with(#m, :prefix)",
        ExpressionAttributeNames: { "#k": ADDRESS_CLAIM_PARTITION_KEY, "#m": ADDRESS_CLAIM_SORT_KEY },
        ExpressionAttributeValues: { ":k": { S: unitClaimKey(unitKey) }, ":prefix": { S: ADDRESS_CLAIM_USER_PREFIX } },
        ProjectionExpression: "#m",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const member = item[ADDRESS_CLAIM_SORT_KEY]?.S;
      if (member?.startsWith(ADDRESS_CLAIM_USER_PREFIX)) userIds.push(member.slice(ADDRESS_CLAIM_USER_PREFIX.length));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return userIds;
}

/** Counter values (`n`, 0 when the row is missing) for the given claim keys, in one BatchGetItem. */
export async function readClaimCounters(
  db: Db,
  tableName: string,
  claimKeys: readonly string[],
  options: { consistentRead?: boolean } = {},
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(claimKeys.map((key) => [key, 0]));
  if (claimKeys.length === 0) return counts;
  const result = await db.send(
    new BatchGetItemCommand({
      RequestItems: {
        [tableName]: {
          Keys: [...new Set(claimKeys)].map((key) => claimTableKey(key, ADDRESS_CLAIM_COUNT_MEMBER)),
          ProjectionExpression: "#k, #n",
          ExpressionAttributeNames: { "#k": ADDRESS_CLAIM_PARTITION_KEY, "#n": COUNTER_ATTRIBUTE },
          ConsistentRead: options.consistentRead ?? false,
        },
      },
    }),
  );
  for (const item of result.Responses?.[tableName] ?? []) {
    const key = item[ADDRESS_CLAIM_PARTITION_KEY]?.S;
    const value = Number(item[COUNTER_ATTRIBUTE]?.N);
    if (key && Number.isFinite(value)) counts.set(key, value);
  }
  return counts;
}

const BATCH_GET_MAX_KEYS = 100;
const BATCH_GET_MAX_ATTEMPTS = 4;

type ClaimantState = "live" | "missing" | "deleting" | "unknown";

/**
 * Each user's UserPII state: "missing" (no row), "deleting" (`deletionStatus` in_progress or
 * completed), "live", or "unknown" when DynamoDB left the key unprocessed after the retries.
 */
async function claimantStates(
  db: Db,
  pii: { tableName: string; partitionKey: string },
  userIds: readonly string[],
): Promise<Map<string, ClaimantState>> {
  const states = new Map<string, ClaimantState>();
  for (let start = 0; start < userIds.length; start += BATCH_GET_MAX_KEYS) {
    const chunk = userIds.slice(start, start + BATCH_GET_MAX_KEYS);
    for (const userId of chunk) states.set(userId, "missing");
    let keys: Item[] = chunk.map((userId) => ({ [pii.partitionKey]: { S: userId } }));
    for (let attempt = 0; keys.length > 0; attempt += 1) {
      if (attempt >= BATCH_GET_MAX_ATTEMPTS) {
        for (const key of keys) {
          const userId = key[pii.partitionKey]?.S;
          if (userId) states.set(userId, "unknown");
        }
        break;
      }
      if (attempt > 0) await sleep(backoffDelayMs(attempt, { baseMs: 50, maxMs: 400 }));
      const result = await db.send(
        new BatchGetItemCommand({
          RequestItems: {
            [pii.tableName]: {
              Keys: keys,
              ProjectionExpression: "#pk, deletionStatus",
              ExpressionAttributeNames: { "#pk": pii.partitionKey },
              ConsistentRead: true,
            },
          },
        }),
      );
      for (const item of result.Responses?.[pii.tableName] ?? []) {
        const userId = item[pii.partitionKey]?.S;
        if (!userId) continue;
        const deletion = normalizeDeletionStatus(item.deletionStatus?.S);
        states.set(userId, deletion === "in_progress" || deletion === "completed" ? "deleting" : "live");
      }
      keys = (result.UnprocessedKeys?.[pii.tableName]?.Keys ?? []) as Item[];
    }
  }
  return states;
}

/**
 * C2 3.3.3 step 7, the self-heal: releases every claim on the unit whose account has no UserPII
 * row or is being (or was) deleted, one transaction per claim. All claimants of a unit share its
 * street, so `streetKey` is the one the new claim would take. Returns how many were released; an
 * account whose row could not be read is left alone.
 */
export async function releaseStaleUnitClaims(input: {
  db: Db;
  tableName: string;
  pii: { tableName: string; partitionKey: string };
  unitKey: string;
  streetKey: string;
}): Promise<{ claimants: number; released: number }> {
  const { db, tableName, pii, unitKey, streetKey } = input;
  const claimants = await listUnitClaimants(db, tableName, unitKey);
  if (claimants.length === 0) return { claimants: 0, released: 0 };

  const states = await claimantStates(db, pii, claimants);
  let released = 0;
  for (const userId of claimants) {
    const state = states.get(userId);
    if (state !== "missing" && state !== "deleting") continue;
    const outcome = await releaseAddressClaim({ db, tableName, userId, claim: { unitKey, streetKey } });
    if (outcome === "released") {
      released += 1;
      logger.info("Released a stale address claim", { claimantState: state });
    }
  }
  return { claimants: claimants.length, released };
}
