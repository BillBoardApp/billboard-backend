import { AdminDeleteUserCommand, type CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DeleteEndpointCommand, type SNSClient } from "@aws-sdk/client-sns";
import {
  ADDRESS_CLAIM_PII_ATTRIBUTES,
  addressClaimExists,
  heldAddressClaimFromPii,
  releaseAddressClaim,
  type HeldAddressClaim,
} from "./addressClaims";
import { userPartitionKey as appAttestUserPartitionKey } from "./appAttest/store";
import { batchWriteAll } from "./dynamoBatchWrite";
import {
  SIGNUP_EMAIL_CLAIM_KEYS,
  deleteUserEmailClaim as deleteEmailClaimItems,
  emailClaimTableKey,
  readUserEmailClaim,
} from "./signUpEmailClaims";
import { emailClaimNames, readEmailClaim } from "./signUpFilter";

/**
 * Account deletion, shared by AccountData (the user's DELETE) and CleanupOrphanedUsers (the safety
 * net that resumes stalled deletions and removes rows of users missing from Cognito). Extracted
 * from accountData with no behaviour change (C1.10): same claim condition, same tables, same order.
 *
 * The data steps never touch BillStats: a deleted vote leaves the counts through the UserFeedback
 * stream (BillStatsAggregator), 30 to 60 seconds later (C1.6).
 *
 * The account-integrity work (integration plan X5) adds three steps, so deletion removes the verification record and
 * the account's links "from the live service right away", as the privacy page says. Each is skipped
 * while its table variable is unset:
 *   (a) ADDRESS_CLAIMS_TABLE_NAME: release the account's address claim (the claim row goes, the unit
 *       and street counters drop by one) and remove `verifiedAddressKey`, `verifiedStreetKey` and
 *       `addressChangeLog` from the UserPII row;
 *   (b) SIGNUP_EMAIL_CLAIMS_TABLE_NAME: delete the sign-up email claim (`EMAIL#<emailKey>`, only while
 *       it still names this account as its userName or one of its holders, and `USER#<userName>`), so the
 *       base address is free at once;
 *   (c) APP_ATTEST_TABLE_NAME: delete the `USER#<sub>` partition (the account's App Attest bindings).
 *       Key rows and their counters stay: they hold no account ID, and a deleted account keeps its slot.
 * DistrictVerification's self-heal still releases the claim of an account deleted some other way.
 */

/**
 * A deletion stuck "in_progress" longer than this (a crashed or timed-out run) may be taken over by
 * a new claim. Far above the AccountData Lambda timeout (28 s).
 */
export const DELETION_LEASE_MS = 15 * 60 * 1000;

const BATCH_DELETE_BACKOFF_MS = 150;

export interface UserTableConfig {
  tableName: string;
  partitionKey: string;
  sortKey: string;
}

export interface AccountDeletionConfig {
  pii: { tableName: string; partitionKey: string };
  feedback: UserTableConfig;
  preferences: UserTableConfig;
  /** `pushTokenIndexName` is the KEYS_ONLY GSI on pushToken; unset skips the shared-endpoint check. */
  devices: UserTableConfig & { pushTokenIndexName?: string };
  /** Unset when WEEKLY_DIGESTS_TABLE_NAME is not configured; the digest step is then skipped. */
  weeklyDigests?: UserTableConfig;
  /** Unset: the Cognito user is left for the client to delete. */
  userPoolId?: string;
  /** X5 (a) `VerifiedAddressClaims`. Unset when ADDRESS_CLAIMS_TABLE_NAME is not configured: step skipped. */
  addressClaims?: { tableName: string };
  /** X5 (b) `SignUpEmailClaims`. Unset when SIGNUP_EMAIL_CLAIMS_TABLE_NAME is not configured: step skipped. */
  signUpEmailClaims?: { tableName: string };
  /** X5 (c) `AppAttest`. Unset when APP_ATTEST_TABLE_NAME is not configured: step skipped. */
  appAttest?: { tableName: string };
}

/**
 * `SignUpEmailClaims` layout (integration plan X5; written by PreSignUpCheck and the claims backfill). The keys
 * and the claim helpers live in shared/signUpEmailClaims.ts, which the sign-up filter check (CB-07) shares;
 * re-exported here for the existing callers and the test that pins them to PreSignUpCheck's.
 */
export { SIGNUP_EMAIL_CLAIM_KEYS };

/** The `AppAttest` table's keys (C3 4.1); an account's bindings are its `USER#<sub>` partition. */
export const APP_ATTEST_TABLE_KEYS = { partitionKey: "pk", sortKey: "sk" } as const;

/** Who is being deleted, beyond the `sub` every user table keys on. */
export interface UserDeletionOptions {
  /**
   * The Cognito username (`cognito:username` claim), which keys the sign-up email claim. Unset: the
   * `sub` is used, which is the username in this pool (UsernameAttributes [email]).
   */
  cognitoUserName?: string;
}

export interface AccountDeletionContext {
  config: AccountDeletionConfig;
  db: Pick<DynamoDBClient, "send">;
  sns: Pick<SNSClient, "send">;
  cognito: Pick<CognitoIdentityProviderClient, "send">;
}

/** Items a deletion removes (deleteUserData) or would remove (countUserData). */
export interface UserDataCounts {
  feedback: number;
  preferences: number;
  /** Device rows. */
  devices: number;
  /** Distinct SNS platform endpoints behind the device rows that are (or would be) deleted. */
  snsEndpoints: number;
  /** Distinct endpoints kept because another user's device row still points at them. */
  sharedSnsEndpointsKept: number;
  weeklyDigests: number;
  /**
   * X5 (a): address claims released (0 or 1; the claim row is deleted and both counters drop by one).
   * Absent when ADDRESS_CLAIMS_TABLE_NAME is unset.
   */
  addressClaims?: number;
  /**
   * X5 (b): SignUpEmailClaims items deleted (0 to 2): the `USER#` item and, while it still names this
   * account (userName or holders), its `EMAIL#` item. Absent when SIGNUP_EMAIL_CLAIMS_TABLE_NAME is unset.
   */
  emailClaims?: number;
  /** X5 (c): App Attest bindings (`USER#<sub>` items) deleted. Absent when APP_ATTEST_TABLE_NAME is unset. */
  appAttestBindings?: number;
}

/** The X5 counts: the records linking an account to an address, a base email address and an install. */
export const ACCOUNT_LINK_COUNT_KEYS = ["addressClaims", "emailClaims", "appAttestBindings"] as const;
export type AccountLinkCountKey = (typeof ACCOUNT_LINK_COUNT_KEYS)[number];

/** Zero for each X5 count whose step the config turns on, so a summary can add them up per run. */
export function emptyAccountLinkCounts(config: AccountDeletionConfig): Partial<Record<AccountLinkCountKey, number>> {
  return {
    ...(config.addressClaims ? { addressClaims: 0 } : {}),
    ...(config.signUpEmailClaims ? { emailClaims: 0 } : {}),
    ...(config.appAttest ? { appAttestBindings: 0 } : {}),
  };
}

type Env = Record<string, string | undefined>;

/** `{ tableName }` from a table variable, or undefined when it is unset or blank (the step is skipped). */
const optionalTable = (value: string | undefined): { tableName: string } | undefined => {
  const tableName = value?.trim();
  return tableName ? { tableName } : undefined;
};

/** The tables and pool the deletion uses, from the environment AccountData and Cleanup share. */
export function accountDeletionConfigFromEnv(env: Env = process.env): AccountDeletionConfig {
  return {
    pii: {
      tableName: env.PII_TABLE_NAME!,
      partitionKey: env.PII_PARTITION_KEY ?? "userId",
    },
    feedback: {
      tableName: env.FEEDBACK_TABLE_NAME!,
      partitionKey: env.FEEDBACK_PARTITION_KEY ?? "userId",
      sortKey: env.FEEDBACK_SORT_KEY ?? "billId",
    },
    preferences: {
      tableName: env.PREFERENCES_TABLE_NAME!,
      partitionKey: env.PREFERENCES_PARTITION_KEY ?? "userId",
      sortKey: env.PREFERENCES_SORT_KEY ?? "preference",
    },
    devices: {
      tableName: env.DEVICES_TABLE_NAME!,
      partitionKey: env.DEVICES_PARTITION_KEY ?? "userId",
      sortKey: env.DEVICES_SORT_KEY ?? "deviceId",
      pushTokenIndexName: env.DEVICES_PUSH_TOKEN_INDEX_NAME || undefined,
    },
    weeklyDigests: env.WEEKLY_DIGESTS_TABLE_NAME
      ? {
          tableName: env.WEEKLY_DIGESTS_TABLE_NAME,
          partitionKey: env.WEEKLY_DIGESTS_PARTITION_KEY ?? "userId",
          sortKey: env.WEEKLY_DIGESTS_SORT_KEY ?? "publishedAt",
        }
      : undefined,
    userPoolId: env.USER_POOL_ID?.trim() || undefined,
    addressClaims: optionalTable(env.ADDRESS_CLAIMS_TABLE_NAME),
    signUpEmailClaims: optionalTable(env.SIGNUP_EMAIL_CLAIMS_TABLE_NAME),
    appAttest: optionalTable(env.APP_ATTEST_TABLE_NAME),
  };
}

/** The message stored as `deletionError`. */
export function deletionErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.length > 0 ? message : "Unknown account deletion error";
}

type DeleteRequest = { DeleteRequest: { Key: Record<string, { S: string }> } };

/**
 * Walks one user's partition page by page, keys only, and hands each page's sort-key values to
 * `onPage`. Rows without a sort-key value are skipped, as the deletion always did. `partitionValue`
 * is the user's `sub` in the user tables and `USER#<sub>` in the AppAttest table.
 */
async function forEachPartitionPage(
  context: AccountDeletionContext,
  table: UserTableConfig,
  partitionValue: string,
  onPage: (sortValues: string[]) => Promise<void>,
): Promise<void> {
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await context.db.send(
      new QueryCommand({
        TableName: table.tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: {
          "#pk": table.partitionKey,
          "#sk": table.sortKey,
        },
        ExpressionAttributeValues: {
          ":pk": { S: partitionValue },
        },
        ProjectionExpression: "#pk, #sk",
        ExclusiveStartKey: startKey,
      }),
    );

    const sortValues: string[] = [];
    for (const item of result.Items ?? []) {
      const sortValue = item[table.sortKey]?.S;
      if (sortValue) sortValues.push(sortValue);
    }
    await onPage(sortValues);

    startKey = result.LastEvaluatedKey;
  } while (startKey);
}

/** Deletes every item in the user's partition of `table`; returns how many. */
async function deletePartitionItems(
  context: AccountDeletionContext,
  table: UserTableConfig,
  partitionValue: string,
): Promise<number> {
  let deleted = 0;
  await forEachPartitionPage(context, table, partitionValue, async (sortValues) => {
    const requests: DeleteRequest[] = sortValues.map((sortValue) => ({
      DeleteRequest: {
        Key: {
          [table.partitionKey]: { S: partitionValue },
          [table.sortKey]: { S: sortValue },
        },
      },
    }));
    await batchWriteAll({
      db: context.db,
      tableName: table.tableName,
      requests,
      backoffMs: BATCH_DELETE_BACKOFF_MS,
    });
    deleted += sortValues.length;
  });
  return deleted;
}

async function countPartitionItems(
  context: AccountDeletionContext,
  table: UserTableConfig,
  partitionValue: string,
): Promise<number> {
  let count = 0;
  await forEachPartitionPage(context, table, partitionValue, async (sortValues) => {
    count += sortValues.length;
  });
  return count;
}

type DeviceRow = {
  deviceId: string;
  pushToken?: string;
  endpointArn?: string;
};

async function listDeviceRows(context: AccountDeletionContext, userId: string): Promise<DeviceRow[]> {
  const { devices } = context.config;
  const rows: DeviceRow[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await context.db.send(
      new QueryCommand({
        TableName: devices.tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: {
          "#pk": devices.partitionKey,
          "#sk": devices.sortKey,
        },
        ExpressionAttributeValues: {
          ":pk": { S: userId },
        },
        ProjectionExpression: "#pk, #sk, pushToken, endpointArn",
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const deviceId = item[devices.sortKey]?.S;
      if (!deviceId) continue;
      rows.push({
        deviceId,
        pushToken: item.pushToken?.S || undefined,
        endpointArn: item.endpointArn?.S || undefined,
      });
    }

    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return rows;
}

/**
 * SNS keeps one endpoint per APNs token, so two accounts signed in on the same
 * phone share it. Registration removes the older account's row for a token, but
 * rows written before that fix may remain; never delete an endpoint that another
 * user's row still points at.
 */
async function isPushTokenUsedByAnotherUser(
  context: AccountDeletionContext,
  userId: string,
  pushToken: string | undefined,
): Promise<boolean> {
  const { devices } = context.config;
  if (!devices.pushTokenIndexName || !pushToken) return false;

  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await context.db.send(
      new QueryCommand({
        TableName: devices.tableName,
        IndexName: devices.pushTokenIndexName,
        KeyConditionExpression: "#pushToken = :pushToken",
        ExpressionAttributeNames: {
          "#pushToken": "pushToken",
          "#pk": devices.partitionKey,
        },
        ExpressionAttributeValues: {
          ":pushToken": { S: pushToken },
        },
        ProjectionExpression: "#pk",
        ExclusiveStartKey: startKey,
      }),
    );

    if (
      (result.Items ?? []).some((item) => item[devices.partitionKey]?.S && item[devices.partitionKey]?.S !== userId)
    ) {
      return true;
    }

    startKey = result.LastEvaluatedKey;
  } while (startKey);

  return false;
}

/** Each distinct endpoint ARN once, with the push token of its first row. */
function distinctEndpoints(rows: DeviceRow[]): Map<string, string | undefined> {
  const endpointTokens = new Map<string, string | undefined>();
  for (const row of rows) {
    if (row.endpointArn && !endpointTokens.has(row.endpointArn)) {
      endpointTokens.set(row.endpointArn, row.pushToken);
    }
  }
  return endpointTokens;
}

/** A caught error, read only for its name. */
type NamedError = { name?: unknown } | null;

async function deletePlatformEndpoint(context: AccountDeletionContext, endpointArn: string): Promise<void> {
  try {
    await context.sns.send(new DeleteEndpointCommand({ EndpointArn: endpointArn }));
  } catch (error) {
    if ((error as NamedError)?.name === "NotFoundException" || (error as NamedError)?.name === "NotFound") return;
    throw error;
  }
}

/**
 * Deletes the SNS platform endpoints behind the user's devices, then the device
 * rows. Endpoints go first so a failed run leaves the rows (and their ARNs) for
 * the retry to find.
 */
async function deleteDevices(
  context: AccountDeletionContext,
  userId: string,
): Promise<Pick<UserDataCounts, "devices" | "snsEndpoints" | "sharedSnsEndpointsKept">> {
  const { devices } = context.config;
  const rows = await listDeviceRows(context, userId);

  let snsEndpoints = 0;
  let sharedSnsEndpointsKept = 0;
  for (const [endpointArn, pushToken] of distinctEndpoints(rows)) {
    if (await isPushTokenUsedByAnotherUser(context, userId, pushToken)) {
      console.warn("Keeping SNS endpoint still registered to another user", { userId, endpointArn });
      sharedSnsEndpointsKept += 1;
      continue;
    }
    await deletePlatformEndpoint(context, endpointArn);
    snsEndpoints += 1;
  }

  await batchWriteAll({
    db: context.db,
    tableName: devices.tableName,
    requests: rows.map((row) => ({
      DeleteRequest: {
        Key: {
          [devices.partitionKey]: { S: userId },
          [devices.sortKey]: { S: row.deviceId },
        },
      },
    })),
    backoffMs: BATCH_DELETE_BACKOFF_MS,
  });

  return { devices: rows.length, snsEndpoints, sharedSnsEndpointsKept };
}

// ─── X5 (a): the address claim ────────────────────────────────────────────────

/** Expression names for ADDRESS_CLAIM_PII_ATTRIBUTES: #claim0 verifiedAddressKey, #claim1 ..., #claim2 .... */
const ADDRESS_CLAIM_PII_NAMES: Record<string, string> = Object.fromEntries(
  ADDRESS_CLAIM_PII_ATTRIBUTES.map((attribute, index) => [`#claim${index}`, attribute]),
);
const ADDRESS_CLAIM_PII_PLACEHOLDERS = Object.keys(ADDRESS_CLAIM_PII_NAMES).join(", ");
/** `verifiedAddressKey`'s placeholder: the attribute the clear's condition compares. */
const UNIT_KEY_PLACEHOLDER = `#claim${ADDRESS_CLAIM_PII_ATTRIBUTES.indexOf("verifiedAddressKey")}`;

/**
 * Read, release and clear tries before the deletion fails (and can be retried). A second try is
 * needed only when a verification that started before the deletion claim lands in between.
 */
const ADDRESS_CLAIM_SETTLE_ATTEMPTS = 3;

/** The address-claim attributes of the user's UserPII row (strongly consistent: right after the claim). */
async function readPiiAddressClaim(
  context: AccountDeletionContext,
  userId: string,
): Promise<Record<string, AttributeValue> | undefined> {
  const { pii } = context.config;
  const result = await context.db.send(
    new GetItemCommand({
      TableName: pii.tableName,
      Key: { [pii.partitionKey]: { S: userId } },
      ConsistentRead: true,
      ProjectionExpression: ADDRESS_CLAIM_PII_PLACEHOLDERS,
      ExpressionAttributeNames: ADDRESS_CLAIM_PII_NAMES,
    }),
  );
  return result.Item;
}

/**
 * REMOVEs the address-claim attributes from the UserPII row, on condition that the row still points
 * at the claim that was read (and, with none, that the row exists, so no row is created). Returns
 * false when the condition failed: a verification changed the row in between.
 */
async function clearPiiAddressClaim(
  context: AccountDeletionContext,
  userId: string,
  claim: HeldAddressClaim | null,
): Promise<boolean> {
  const { pii } = context.config;
  try {
    await context.db.send(
      new UpdateItemCommand({
        TableName: pii.tableName,
        Key: { [pii.partitionKey]: { S: userId } },
        UpdateExpression: `REMOVE ${ADDRESS_CLAIM_PII_PLACEHOLDERS}`,
        ...(claim
          ? {
              ConditionExpression: `${UNIT_KEY_PLACEHOLDER} = :unitKey`,
              ExpressionAttributeNames: ADDRESS_CLAIM_PII_NAMES,
              ExpressionAttributeValues: { ":unitKey": { S: claim.unitKey } },
            }
          : {
              ConditionExpression: `attribute_exists(#pk) AND attribute_not_exists(${UNIT_KEY_PLACEHOLDER})`,
              ExpressionAttributeNames: { ...ADDRESS_CLAIM_PII_NAMES, "#pk": pii.partitionKey },
            }),
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/**
 * X5 (a): releases the claim the UserPII row points at (releaseAddressClaim: one transaction deletes
 * `U#<unit>/USER#<sub>` and decrements the unit and street counters; a claim row already gone is a
 * no-op), then removes `verifiedAddressKey`, `verifiedStreetKey` and `addressChangeLog` from the row.
 * If a verification changed the row in between, it reads again and releases the new claim too.
 * Returns how many claims were released.
 */
async function releaseUserAddressClaim(
  context: AccountDeletionContext,
  table: { tableName: string },
  userId: string,
): Promise<number> {
  let released = 0;
  for (let attempt = 1; ; attempt += 1) {
    const item = await readPiiAddressClaim(context, userId);
    const claim = heldAddressClaimFromPii(item);
    const result = await releaseAddressClaim({ db: context.db, tableName: table.tableName, userId, claim });
    if (result === "released") released += 1;

    const recorded = ADDRESS_CLAIM_PII_ATTRIBUTES.some((attribute) => item?.[attribute] !== undefined);
    if (!recorded || (await clearPiiAddressClaim(context, userId, claim))) return released;
    if (attempt >= ADDRESS_CLAIM_SETTLE_ATTEMPTS) {
      throw new Error(`Address claim release did not settle after ${ADDRESS_CLAIM_SETTLE_ATTEMPTS} attempts`);
    }
  }
}

/** Dry run of (a): 1 when the UserPII row points at a claim row that exists (two GetItems). */
async function countUserAddressClaim(
  context: AccountDeletionContext,
  table: { tableName: string },
  userId: string,
): Promise<number> {
  const claim = heldAddressClaimFromPii(await readPiiAddressClaim(context, userId));
  return (await addressClaimExists({ db: context.db, tableName: table.tableName, userId, claim })) ? 1 : 0;
}

// ─── X5 (b): the sign-up email claim ──────────────────────────────────────────

/**
 * X5 (b): shared/signUpEmailClaims.ts deleteUserEmailClaim (read `USER#<userName>`, delete `EMAIL#<emailKey>`
 * on condition that it still names this account as its userName or one of its holders, then the `USER#` item).
 * Returns the items deleted.
 */
async function deleteUserEmailClaim(
  context: AccountDeletionContext,
  table: { tableName: string },
  userId: string,
  userName: string,
): Promise<number> {
  const { deleted } = await deleteEmailClaimItems({ db: context.db, tableName: table.tableName }, userName, {
    onEmailItemKept: () => console.warn("Sign-up email claim no longer names this account; keeping it", { userId }),
  });
  return deleted;
}

/**
 * Dry run of (b): the items deleteUserEmailClaim would delete now (GetItems only): the account's USER# item, its
 * EMAIL# item while that names the account, and then the USER# items of the item's other holders that name the same
 * email key.
 */
async function countUserEmailClaim(
  context: AccountDeletionContext,
  table: { tableName: string },
  userName: string,
): Promise<number> {
  const claim = await readUserEmailClaim({ db: context.db, tableName: table.tableName }, userName);
  if (!claim) return 0;
  if (!claim.emailKey) return 1;
  const result = await context.db.send(
    new GetItemCommand({
      TableName: table.tableName,
      Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.emailItem(claim.emailKey)),
      ProjectionExpression: "#userName, #holders",
      ExpressionAttributeNames: { "#userName": "userName", "#holders": "holders" },
    }),
  );
  if (!emailClaimNames(result.Item, userName)) return 1;
  const others = Object.keys(readEmailClaim(result.Item)?.holders ?? {}).filter((holder) => holder !== userName);
  let holderItems = 0;
  for (const holder of others) {
    const item = await context.db.send(
      new GetItemCommand({
        TableName: table.tableName,
        Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.userItem(holder)),
        ProjectionExpression: "#emailKey",
        ExpressionAttributeNames: { "#emailKey": "emailKey" },
      }),
    );
    if (item.Item?.emailKey?.S === claim.emailKey) holderItems += 1;
  }
  return 2 + holderItems;
}

// ─── X5 (c): App Attest bindings ──────────────────────────────────────────────

const appAttestBindingsTable = (table: { tableName: string }): UserTableConfig => ({
  tableName: table.tableName,
  ...APP_ATTEST_TABLE_KEYS,
});

/** The username keying the sign-up email claim: the Cognito username, else the `sub`. */
const emailClaimUserName = (userId: string, options: UserDeletionOptions): string =>
  options.cognitoUserName?.trim() || userId;

// ─── Deletion and its dry run ─────────────────────────────────────────────────

/**
 * Deletes the user's data, in this order: votes (UserFeedback), preferences, devices (SNS
 * endpoints first, except ones another user's row still uses, then the rows), weekly digests
 * (when configured), then the X5 steps, each when its table is configured: (a) the address claim
 * (released, and its attributes removed from the UserPII row), (b) the sign-up email claim, (c) the
 * App Attest bindings. The UserPII row is otherwise left to the caller: AccountData replaces it with
 * a tombstone, Cleanup deletes it conditionally. A failure throws and leaves the remaining rows for
 * a retry; every step is safe to repeat. Writes nothing to BillStats.
 */
export async function deleteUserData(
  context: AccountDeletionContext,
  userId: string,
  options: UserDeletionOptions = {},
): Promise<UserDataCounts> {
  const { config } = context;
  const feedback = await deletePartitionItems(context, config.feedback, userId);
  const preferences = await deletePartitionItems(context, config.preferences, userId);
  const devices = await deleteDevices(context, userId);
  const weeklyDigests = config.weeklyDigests ? await deletePartitionItems(context, config.weeklyDigests, userId) : 0;
  const counts: UserDataCounts = { feedback, preferences, ...devices, weeklyDigests };

  if (config.addressClaims) {
    counts.addressClaims = await releaseUserAddressClaim(context, config.addressClaims, userId);
  }
  if (config.signUpEmailClaims) {
    counts.emailClaims = await deleteUserEmailClaim(
      context,
      config.signUpEmailClaims,
      userId,
      emailClaimUserName(userId, options),
    );
  }
  if (config.appAttest) {
    counts.appAttestBindings = await deletePartitionItems(
      context,
      appAttestBindingsTable(config.appAttest),
      appAttestUserPartitionKey(userId),
    );
  }
  return counts;
}

/**
 * Read-only: what deleteUserData would delete for this user right now (Query and GetItem only; no
 * write and no SNS call). For the cleanup dry run, whose grants on the X5 tables are read-only (X23).
 */
export async function countUserData(
  context: AccountDeletionContext,
  userId: string,
  options: UserDeletionOptions = {},
): Promise<UserDataCounts> {
  const { config } = context;
  const feedback = await countPartitionItems(context, config.feedback, userId);
  const preferences = await countPartitionItems(context, config.preferences, userId);

  const rows = await listDeviceRows(context, userId);
  let snsEndpoints = 0;
  let sharedSnsEndpointsKept = 0;
  for (const [, pushToken] of distinctEndpoints(rows)) {
    if (await isPushTokenUsedByAnotherUser(context, userId, pushToken)) sharedSnsEndpointsKept += 1;
    else snsEndpoints += 1;
  }

  const weeklyDigests = config.weeklyDigests ? await countPartitionItems(context, config.weeklyDigests, userId) : 0;
  const counts: UserDataCounts = {
    feedback,
    preferences,
    devices: rows.length,
    snsEndpoints,
    sharedSnsEndpointsKept,
    weeklyDigests,
  };

  if (config.addressClaims) {
    counts.addressClaims = await countUserAddressClaim(context, config.addressClaims, userId);
  }
  if (config.signUpEmailClaims) {
    counts.emailClaims = await countUserEmailClaim(
      context,
      config.signUpEmailClaims,
      emailClaimUserName(userId, options),
    );
  }
  if (config.appAttest) {
    counts.appAttestBindings = await countPartitionItems(
      context,
      appAttestBindingsTable(config.appAttest),
      appAttestUserPartitionKey(userId),
    );
  }
  return counts;
}

/**
 * Claims the deletion. Fails (returns false) when another request holds a live claim (younger
 * than DELETION_LEASE_MS) or the deletion already completed, so two concurrent deletions of one
 * user cannot both run. A `failed` deletion, or an `in_progress` one past its lease, can be
 * claimed again.
 */
export async function claimDeletion(
  context: AccountDeletionContext,
  userId: string,
  requestedAt: string,
): Promise<boolean> {
  const { pii } = context.config;
  const staleBefore = new Date(Date.parse(requestedAt) - DELETION_LEASE_MS).toISOString();
  try {
    await context.db.send(
      new UpdateItemCommand({
        TableName: pii.tableName,
        Key: { [pii.partitionKey]: { S: userId } },
        UpdateExpression:
          "SET deletionStatus = :status, deletionRequestedAt = :requestedAt, updatedAt = :updatedAt REMOVE deletionCompletedAt, deletionError",
        ConditionExpression:
          "attribute_not_exists(deletionStatus) OR NOT (deletionStatus IN (:status, :completed)) OR (deletionStatus = :status AND (attribute_not_exists(deletionRequestedAt) OR deletionRequestedAt < :staleBefore))",
        ExpressionAttributeValues: {
          ":status": { S: "in_progress" },
          ":completed": { S: "completed" },
          ":requestedAt": { S: requestedAt },
          ":updatedAt": { S: requestedAt },
          ":staleBefore": { S: staleBefore },
        },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export async function markDeletionFailed(
  context: AccountDeletionContext,
  userId: string,
  requestedAt: string,
  errorMessage: string,
): Promise<void> {
  const { pii } = context.config;
  const nowIso = new Date().toISOString();
  await context.db.send(
    new UpdateItemCommand({
      TableName: pii.tableName,
      Key: { [pii.partitionKey]: { S: userId } },
      UpdateExpression:
        "SET deletionStatus = :status, deletionRequestedAt = :requestedAt, deletionError = :deletionError, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":status": { S: "failed" },
        ":requestedAt": { S: requestedAt },
        ":deletionError": { S: errorMessage.slice(0, 512) },
        ":updatedAt": { S: nowIso },
      },
    }),
  );
}

/** Replaces the UserPII row with the deletion tombstone (no personal data left in it). */
export async function markDeletionCompleted(
  context: AccountDeletionContext,
  userId: string,
  requestedAt: string,
): Promise<void> {
  const { pii } = context.config;
  const completedAt = new Date().toISOString();
  await context.db.send(
    new PutItemCommand({
      TableName: pii.tableName,
      Item: {
        [pii.partitionKey]: { S: userId },
        deletionStatus: { S: "completed" },
        deletionRequestedAt: { S: requestedAt },
        deletionCompletedAt: { S: completedAt },
        updatedAt: { S: completedAt },
      },
    }),
  );
}

/**
 * Deletes the Cognito user; a user already gone counts as deleted. Returns false when no user
 * pool is configured (the client is then left to delete the sign-in).
 */
export async function deleteCognitoUser(context: AccountDeletionContext, userId: string): Promise<boolean> {
  const { userPoolId } = context.config;
  if (!userPoolId) {
    console.warn("USER_POOL_ID is not configured; leaving Cognito user deletion to the client", { userId });
    return false;
  }

  try {
    await context.cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: userId }));
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name !== "UserNotFoundException") throw error;
  }
  return true;
}
