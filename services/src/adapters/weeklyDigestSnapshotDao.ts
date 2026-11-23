import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { WeeklyDigest } from "../models/weeklyDigest";

// The table's TTL attribute (infra enables TTL on it). Snapshots expire this
// long after they were published. Only the current week's snapshot is ever read
// (fetchLatestWeeklyDigest, and the generator's skip-if-stored check), and each one
// lists the user's watched bills, followed members and topics, so it is kept just
// past its week (feature review 2026-10-28, S15; was 180 days, CAP-09). scripts/expireOldWeeklyBriefs.ts brings
// the rows written before then to the same rule (WEB-07, G1).
export const WEEKLY_DIGEST_TTL_ATTRIBUTE = "ttl";
export const WEEKLY_DIGEST_RETENTION_DAYS = 21;

/** Epoch seconds at which a snapshot published at `publishedAt` expires, or null if unparseable. */
export function weeklyDigestExpiresAtEpochSeconds(publishedAt: string): number | null {
  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) {
    return null;
  }

  return Math.floor(publishedMs / 1000) + WEEKLY_DIGEST_RETENTION_DAYS * 24 * 60 * 60;
}

/**
 * UX-28: when the Sunday push for this snapshot was claimed (ISO-8601). Set once, by weeklyBriefPush, before it
 * publishes, so a user gets the push at most once per week. `get` never returns it.
 */
export const WEEKLY_BRIEF_PUSH_CLAIM_ATTRIBUTE = "pushClaimedAt";

/** A snapshot as weeklyBriefPush reads it: the brief, and when its push was claimed (absent until then). */
export interface WeeklyDigestPushState {
  digest: WeeklyDigest;
  pushClaimedAt?: string;
}

interface WeeklyDigestSnapshotDaoConfig {
  tableName?: string;
  partitionKey?: string;
  sortKey?: string;
}

export class WeeklyDigestSnapshotDao {
  constructor(
    private readonly dynamo: DynamoDBClient,
    private readonly config: WeeklyDigestSnapshotDaoConfig,
  ) {}

  private isConfigured(): boolean {
    return Boolean(this.config.tableName && this.config.partitionKey && this.config.sortKey);
  }

  async get(userId: string, publishedAt: string): Promise<WeeklyDigest | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await this.dynamo.send(
      new GetItemCommand({
        TableName: this.config.tableName,
        Key: {
          [this.config.partitionKey!]: { S: userId },
          [this.config.sortKey!]: { S: publishedAt },
        },
        ProjectionExpression: "payload",
      }),
    );

    const payload = response.Item?.payload?.S;
    if (!payload) {
      return null;
    }

    try {
      return JSON.parse(payload) as WeeklyDigest;
    } catch (error) {
      console.warn("Failed to parse weekly digest snapshot payload", { userId, publishedAt, error });
      return null;
    }
  }

  /** The snapshot and its push claim, or null when there is none (or its payload cannot be read). */
  async getPushState(userId: string, publishedAt: string): Promise<WeeklyDigestPushState | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const response = await this.dynamo.send(
      new GetItemCommand({
        TableName: this.config.tableName,
        Key: {
          [this.config.partitionKey!]: { S: userId },
          [this.config.sortKey!]: { S: publishedAt },
        },
        ProjectionExpression: "payload, #claimed",
        ExpressionAttributeNames: { "#claimed": WEEKLY_BRIEF_PUSH_CLAIM_ATTRIBUTE },
        ConsistentRead: true,
      }),
    );

    const payload = response.Item?.payload?.S;
    if (!payload) {
      return null;
    }

    let digest: WeeklyDigest;
    try {
      digest = JSON.parse(payload) as WeeklyDigest;
    } catch {
      return null;
    }

    const pushClaimedAt = response.Item?.[WEEKLY_BRIEF_PUSH_CLAIM_ATTRIBUTE]?.S;
    return pushClaimedAt ? { digest, pushClaimedAt } : { digest };
  }

  /**
   * Claims the snapshot's Sunday push: sets pushClaimedAt only on an existing snapshot that has none. True when this
   * call set it; false when it was already claimed or the snapshot is gone (the update never creates a row).
   */
  async claimPush(userId: string, publishedAt: string, claimedAt: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      await this.dynamo.send(
        new UpdateItemCommand({
          TableName: this.config.tableName,
          Key: {
            [this.config.partitionKey!]: { S: userId },
            [this.config.sortKey!]: { S: publishedAt },
          },
          UpdateExpression: "SET #claimed = :claimedAt",
          ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#claimed)",
          ExpressionAttributeNames: {
            "#pk": this.config.partitionKey!,
            "#claimed": WEEKLY_BRIEF_PUSH_CLAIM_ATTRIBUTE,
          },
          ExpressionAttributeValues: { ":claimedAt": { S: claimedAt } },
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") {
        return false;
      }

      throw error;
    }
  }

  async put(userId: string, digest: WeeklyDigest): Promise<void> {
    if (!this.isConfigured()) {
      return;
    }

    const expiresAt = weeklyDigestExpiresAtEpochSeconds(digest.publishedAt);
    if (expiresAt === null) {
      console.warn("Weekly digest has an unparseable publishedAt; storing without TTL", {
        userId,
        publishedAt: digest.publishedAt,
      });
    }

    try {
      await this.dynamo.send(
        new PutItemCommand({
          TableName: this.config.tableName,
          Item: {
            [this.config.partitionKey!]: { S: userId },
            [this.config.sortKey!]: { S: digest.publishedAt },
            payload: { S: JSON.stringify(digest) },
            publishedAt: { S: digest.publishedAt },
            weekStart: { S: digest.weekStart },
            weekEnd: { S: digest.weekEnd },
            createdAt: { S: new Date().toISOString() },
            ...(expiresAt !== null ? { [WEEKLY_DIGEST_TTL_ATTRIBUTE]: { N: String(expiresAt) } } : {}),
          },
          ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
          ExpressionAttributeNames: {
            "#pk": this.config.partitionKey!,
            "#sk": this.config.sortKey!,
          },
        }),
      );
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") {
        return;
      }

      throw error;
    }
  }
}
