/**
 * The AppAttest table (C3 4.1): pk (S), sk (S), TTL attribute `ttl`.
 *
 *   Challenge  CH#<challenge> / CH         purpose, createdAt, expiresAt (epoch s), ttl, consumedAt, consumedBy
 *   Key        KEY#<keyId> / META           publicKeySpki (B), signCount, environment, validationCategory?,
 *                                           bundleVersion?, receipt (B), attestedAt, lastUsedAt, status,
 *                                           accountCount, signupCount, ttl
 *   Binding    USER#<sub> / KEY#<keyId>     firstSeenAt, lastSeenAt, ttl (written with the key's
 *                                           accountCount in one transaction: bindAccount)
 *
 * Every write is conditional and idempotent, so nothing needs a rerun (C3 3.12). The client has an
 * 800 ms request timeout and 2 attempts; every call also takes the caller's abort signal so the
 * evaluation budget bounds it. Only ConditionalCheckFailedException is turned into a result; any
 * other error is thrown for the caller to count as `error`.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { backoffDelayMs, sleep } from "../retry";
import { TIMING, type KeyEnvironment } from "./config";

export type ChallengePurpose = "attest" | "assert";
export type KeyStatus = "active" | "revoked";

export const challengeItemKey = (challenge: string) => ({ pk: { S: `CH#${challenge}` }, sk: { S: "CH" } });
export const keyItemKey = (keyId: string) => ({ pk: { S: `KEY#${keyId}` }, sk: { S: "META" } });
/** The partition AccountData and CleanupOrphanedUsers delete for an account (X5 (c)). */
export const userPartitionKey = (userId: string): string => `USER#${userId}`;
export const bindingItemKey = (userId: string, keyId: string) => ({
  pk: { S: userPartitionKey(userId) },
  sk: { S: `KEY#${keyId}` },
});

export type ConsumeResult =
  | { ok: true; replay: boolean }
  | { ok: false; reason: "challenge_unknown" | "challenge_expired" | "challenge_purpose" | "challenge_used" };

export interface StoredKey {
  keyId: string;
  publicKeySpki: Buffer;
  signCount: number;
  environment: KeyEnvironment;
  status: KeyStatus | string;
  accountCount: number;
  signupCount: number;
  validationCategory?: number;
  bundleVersion?: string;
}

export interface StoredBinding {
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface NewKey {
  keyId: string;
  publicKeySpki: Buffer;
  environment: KeyEnvironment;
  receipt: Buffer;
  validationCategory?: number;
  bundleVersion?: string;
}

/**
 * The outcome of bindAccount: "bound" (binding written and counted), "already_bound" (a concurrent
 * request of the same account bound it first) or "limit" (the install already has `limit` accounts).
 * Only "bound" writes anything.
 */
export type BindAccountResult = "bound" | "already_bound" | "limit";

/** Cancellation codes of a transaction that are retried: nothing was decided, only contended. */
const TRANSIENT_CANCELLATION_CODES = new Set([
  "TransactionConflict",
  "ThrottlingError",
  "ProvisionedThroughputExceeded",
]);
const BIND_TRANSIENT_RETRIES = 2;

type CancellationReason = { Code?: string; Item?: Record<string, AttributeValue> } | null | undefined;

const cancellationReasonsOf = (error: unknown): CancellationReason[] | null => {
  const cancelled = error as { name?: unknown; CancellationReasons?: CancellationReason[] } | null;
  return cancelled?.name === "TransactionCanceledException" ? (cancelled.CancellationReasons ?? []) : null;
};

export interface DynamoSender {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

type CallOptions = { signal?: AbortSignal };

let defaultClient: DynamoDBClient | undefined;

/** The App Attest table's own client: 800 ms per request, at most 2 attempts. */
export const appAttestDynamoClient = (): DynamoDBClient =>
  (defaultClient ??= new DynamoDBClient({
    maxAttempts: TIMING.dynamoMaxAttempts,
    requestHandler: {
      requestTimeout: TIMING.dynamoRequestTimeoutMs,
      connectionTimeout: TIMING.dynamoRequestTimeoutMs,
    },
  }));

const epochSeconds = (now: Date): number => Math.floor(now.getTime() / 1000);

export const isConditionalCheckFailed = (error: unknown): error is { Item?: Record<string, AttributeValue> } =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "ConditionalCheckFailedException";

const numberOf = (value: AttributeValue | undefined, fallback = 0): number => {
  const parsed = Number(value?.N);
  return value?.N !== undefined && Number.isFinite(parsed) ? parsed : fallback;
};

export class AppAttestStore {
  constructor(
    readonly tableName: string,
    private readonly client: DynamoSender = appAttestDynamoClient(),
  ) {}

  private send<T>(command: unknown, options: CallOptions): Promise<T> {
    return this.client.send(command, options.signal ? { abortSignal: options.signal } : undefined) as Promise<T>;
  }

  /** Stores a new challenge. Returns false only on a key collision (practically never). */
  async putChallenge(
    input: { challenge: string; purpose: ChallengePurpose; now: Date; ttlSeconds: number },
    options: CallOptions = {},
  ): Promise<{ created: boolean; expiresAt: Date }> {
    const expiresAtSeconds = epochSeconds(input.now) + input.ttlSeconds;
    try {
      await this.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            ...challengeItemKey(input.challenge),
            purpose: { S: input.purpose },
            createdAt: { S: input.now.toISOString() },
            expiresAt: { N: String(expiresAtSeconds) },
            ttl: { N: String(expiresAtSeconds + TIMING.challengeRowGraceSeconds) },
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        }),
        options,
      );
      return { created: true, expiresAt: new Date(expiresAtSeconds * 1000) };
    } catch (error) {
      if (isConditionalCheckFailed(error)) return { created: false, expiresAt: new Date(expiresAtSeconds * 1000) };
      throw error;
    }
  }

  /**
   * Consumes a challenge once (C3 3.3 step 1). A second consume with the same `consumedBy` (the
   * hash of the same attestation or assertion bytes) is a replay: a client or Cognito retry.
   */
  async consumeChallenge(
    input: { challenge: string; purpose: ChallengePurpose; consumedBy: string; now: Date },
    options: CallOptions = {},
  ): Promise<ConsumeResult> {
    const nowSeconds = epochSeconds(input.now);
    try {
      await this.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: challengeItemKey(input.challenge),
          UpdateExpression: "SET #consumedAt = :consumedAt, #consumedBy = :consumedBy",
          ConditionExpression:
            "attribute_exists(#pk) AND #purpose = :purpose AND #expiresAt > :now AND attribute_not_exists(#consumedAt)",
          ExpressionAttributeNames: {
            "#pk": "pk",
            "#purpose": "purpose",
            "#expiresAt": "expiresAt",
            "#consumedAt": "consumedAt",
            "#consumedBy": "consumedBy",
          },
          ExpressionAttributeValues: {
            ":consumedAt": { S: input.now.toISOString() },
            ":consumedBy": { S: input.consumedBy },
            ":purpose": { S: input.purpose },
            ":now": { N: String(nowSeconds) },
          },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
        options,
      );
      return { ok: true, replay: false };
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      const old = error.Item;
      if (!old) return { ok: false, reason: "challenge_unknown" };
      if (old.purpose?.S !== input.purpose) return { ok: false, reason: "challenge_purpose" };
      if (numberOf(old.expiresAt) <= nowSeconds) return { ok: false, reason: "challenge_expired" };
      if (old.consumedAt && old.consumedBy?.S === input.consumedBy) return { ok: true, replay: true };
      return { ok: false, reason: "challenge_used" };
    }
  }

  /** The key's META item with a consistent read, or null. */
  async getKey(keyId: string, options: CallOptions = {}): Promise<StoredKey | null> {
    const result = await this.send<{ Item?: Record<string, AttributeValue> }>(
      new GetItemCommand({ TableName: this.tableName, Key: keyItemKey(keyId), ConsistentRead: true }),
      options,
    );
    const item = result?.Item;
    if (!item?.publicKeySpki?.B) return null;
    return {
      keyId,
      publicKeySpki: Buffer.from(item.publicKeySpki.B),
      signCount: numberOf(item.signCount),
      environment: item.environment?.S === "production" ? "production" : "development",
      status: item.status?.S ?? "active",
      accountCount: numberOf(item.accountCount),
      signupCount: numberOf(item.signupCount),
      ...(item.validationCategory?.N !== undefined ? { validationCategory: numberOf(item.validationCategory) } : {}),
      ...(item.bundleVersion?.S !== undefined ? { bundleVersion: item.bundleVersion.S } : {}),
    };
  }

  /** Registers a key (C3 3.3 step 9); "exists" when it was registered before (nothing changes). */
  async putKey(key: NewKey, now: Date, options: CallOptions = {}): Promise<"created" | "exists"> {
    const nowIso = now.toISOString();
    try {
      await this.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            ...keyItemKey(key.keyId),
            publicKeySpki: { B: key.publicKeySpki },
            signCount: { N: "0" },
            environment: { S: key.environment },
            ...(key.validationCategory !== undefined
              ? { validationCategory: { N: String(key.validationCategory) } }
              : {}),
            ...(key.bundleVersion !== undefined ? { bundleVersion: { S: key.bundleVersion } } : {}),
            receipt: { B: key.receipt },
            attestedAt: { S: nowIso },
            lastUsedAt: { S: nowIso },
            status: { S: "active" },
            accountCount: { N: "0" },
            signupCount: { N: "0" },
            ttl: { N: String(epochSeconds(now) + TIMING.keyTtlSeconds) },
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        }),
        options,
      );
      return "created";
    } catch (error) {
      if (isConditionalCheckFailed(error)) return "exists";
      throw error;
    }
  }

  /** Moves signCount forward (C3 3.4 step 8); false when it was not lower or the key is not active. */
  async advanceCounter(input: { keyId: string; counter: number; now: Date }, options: CallOptions = {}) {
    try {
      await this.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: keyItemKey(input.keyId),
          UpdateExpression: "SET #signCount = :counter, #lastUsedAt = :now, #ttl = :ttl",
          ConditionExpression: "#signCount < :counter AND #status = :active",
          ExpressionAttributeNames: {
            "#signCount": "signCount",
            "#lastUsedAt": "lastUsedAt",
            "#ttl": "ttl",
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":counter": { N: String(input.counter) },
            ":now": { S: input.now.toISOString() },
            ":ttl": { N: String(epochSeconds(input.now) + TIMING.keyTtlSeconds) },
            ":active": { S: "active" },
          },
        }),
        options,
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) return false;
      throw error;
    }
  }

  async getBinding(userId: string, keyId: string, options: CallOptions = {}): Promise<StoredBinding | null> {
    const result = await this.send<{ Item?: Record<string, AttributeValue> }>(
      new GetItemCommand({ TableName: this.tableName, Key: bindingItemKey(userId, keyId), ConsistentRead: true }),
      options,
    );
    const item = result?.Item;
    if (!item) return null;
    return { firstSeenAt: item.firstSeenAt?.S, lastSeenAt: item.lastSeenAt?.S };
  }

  async refreshBinding(input: { userId: string; keyId: string; now: Date }, options: CallOptions = {}) {
    await this.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: bindingItemKey(input.userId, input.keyId),
        UpdateExpression: "SET #lastSeenAt = :now, #ttl = :ttl",
        ConditionExpression: "attribute_exists(#pk)",
        ExpressionAttributeNames: { "#lastSeenAt": "lastSeenAt", "#ttl": "ttl", "#pk": "pk" },
        ExpressionAttributeValues: {
          ":now": { S: input.now.toISOString() },
          ":ttl": { N: String(epochSeconds(input.now) + TIMING.bindingTtlSeconds) },
        },
      }),
      options,
    ).catch((error: unknown) => {
      // The binding expired between the read and this write; the next request recreates it.
      if (!isConditionalCheckFailed(error)) throw error;
    });
  }

  /**
   * C3 3.4 step 10 for an account with no binding: Puts the binding and ADDs 1 to the key's
   * accountCount in one transaction, so the per-install count is atomic (C3 D1) and no binding ever
   * exists without its count. With `limit` (enforce), only while accountCount < limit, so parallel
   * first votes from new accounts cannot pass the limit. A cancellation caused only by a conflicting
   * transaction or throttling is retried twice (jittered); any other error is thrown.
   */
  async bindAccount(
    input: { userId: string; keyId: string; now: Date; limit?: number },
    options: CallOptions = {},
  ): Promise<BindAccountResult> {
    const nowIso = input.now.toISOString();
    const limited = input.limit !== undefined;
    const transactItems = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...bindingItemKey(input.userId, input.keyId),
            firstSeenAt: { S: nowIso },
            lastSeenAt: { S: nowIso },
            ttl: { N: String(epochSeconds(input.now) + TIMING.bindingTtlSeconds) },
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: keyItemKey(input.keyId),
          UpdateExpression: "ADD #accountCount :one",
          ConditionExpression: limited
            ? "attribute_exists(#pk) AND (attribute_not_exists(#accountCount) OR #accountCount < :limit)"
            : "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#accountCount": "accountCount", "#pk": "pk" },
          ExpressionAttributeValues: {
            ":one": { N: "1" },
            ...(limited ? { ":limit": { N: String(input.limit) } } : {}),
          },
          // Tells "at the limit" (the key came back) from "the key is gone" (nothing came back).
          ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
        },
      },
    ];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.send(new TransactWriteItemsCommand({ TransactItems: transactItems }), options);
        return "bound";
      } catch (error) {
        const reasons = cancellationReasonsOf(error);
        if (!reasons) throw error;
        const [bindingReason, keyReason] = reasons;
        if (bindingReason?.Code === "ConditionalCheckFailed") return "already_bound";
        if (keyReason?.Code === "ConditionalCheckFailed" && limited && keyReason.Item) return "limit";
        const transient = reasons.some((reason) => TRANSIENT_CANCELLATION_CODES.has(reason?.Code ?? ""));
        if (!transient || attempt >= BIND_TRANSIENT_RETRIES || options.signal?.aborted) throw error;
        await sleep(backoffDelayMs(attempt, { baseMs: 25, maxMs: 100 }));
      }
    }
  }

  /**
   * ADD signupCount 1 on the key (C3 3.5). With `limit` (enforce), only while signupCount < limit;
   * `{ok: false}` then means the install already has `limit` sign-ups.
   */
  async incrementSignupCount(
    input: { keyId: string; limit?: number },
    options: CallOptions = {},
  ): Promise<{ ok: true; signupCount: number } | { ok: false }> {
    const limited = input.limit !== undefined;
    try {
      const result = await this.send<{ Attributes?: Record<string, AttributeValue> }>(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: keyItemKey(input.keyId),
          UpdateExpression: "ADD #signupCount :one",
          ConditionExpression: limited
            ? "attribute_exists(#pk) AND (attribute_not_exists(#signupCount) OR #signupCount < :limit)"
            : "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#signupCount": "signupCount", "#pk": "pk" },
          ExpressionAttributeValues: {
            ":one": { N: "1" },
            ...(limited ? { ":limit": { N: String(input.limit) } } : {}),
          },
          ReturnValues: "UPDATED_NEW",
        }),
        options,
      );
      return { ok: true, signupCount: numberOf(result?.Attributes?.signupCount) };
    } catch (error) {
      if (isConditionalCheckFailed(error)) return { ok: false };
      throw error;
    }
  }
}
