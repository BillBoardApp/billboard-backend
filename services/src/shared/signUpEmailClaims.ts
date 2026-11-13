import { DeleteItemCommand, GetItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  PROBE_RECORD_KEYS,
  SIGNUP_EMAIL_CLAIMS_PARTITION_KEY,
  emailClaimKey,
  readEmailClaim,
  userClaimKey,
  type ProbeKind,
} from "./signUpFilter";

/**
 * `SignUpEmailClaims` reads and deletes (integration plan X5), shared by account deletion
 * (shared/accountDeletion.ts, step X5 (b)) and the sign-up filter check (CB-07). Moved here unchanged from
 * accountDeletion.ts so the check does not bundle the account-deletion code.
 *
 * Layout (written by PreSignUpCheck and the claims backfill; shared/signUpFilter.ts): partition key `pk`, no
 * sort key; `EMAIL#<emailKey>` {userName, claimedAt, addressKey, holders, revision} (the backfill and older
 * trigger versions wrote {userName, claimedAt} only), `USER#<userName>` {emailKey, claimedAt}, and the check's
 * `PROBE#base` and `PROBE#variant` records.
 */
export const SIGNUP_EMAIL_CLAIM_KEYS = {
  partitionKey: SIGNUP_EMAIL_CLAIMS_PARTITION_KEY,
  emailItem: emailClaimKey,
  userItem: userClaimKey,
  probeItem: (kind: ProbeKind): string => PROBE_RECORD_KEYS[kind],
} as const;

export interface SignUpEmailClaimsTable {
  db: Pick<DynamoDBClient, "send">;
  tableName: string;
}

export const emailClaimTableKey = (value: string): Record<string, AttributeValue> => ({
  [SIGNUP_EMAIL_CLAIM_KEYS.partitionKey]: { S: value },
});

/** Deletes `USER#<holder>` while it names `emailKey`; false when it is gone or names another key. */
const deleteHolderUserItem = async (
  table: SignUpEmailClaimsTable,
  holder: string,
  emailKey: string,
): Promise<boolean> => {
  try {
    await table.db.send(
      new DeleteItemCommand({
        TableName: table.tableName,
        Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.userItem(holder)),
        ConditionExpression: "#emailKey = :emailKey",
        ExpressionAttributeNames: { "#emailKey": "emailKey" },
        ExpressionAttributeValues: { ":emailKey": { S: emailKey } },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name !== "ConditionalCheckFailedException") throw error;
    return false;
  }
};

/** The account's `USER#<userName>` item: null when there is none, else its `emailKey` (if any). */
export async function readUserEmailClaim(
  table: SignUpEmailClaimsTable,
  userName: string,
): Promise<{ emailKey?: string } | null> {
  const result = await table.db.send(
    new GetItemCommand({
      TableName: table.tableName,
      Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.userItem(userName)),
      ConsistentRead: true,
      ProjectionExpression: "#emailKey",
      ExpressionAttributeNames: { "#emailKey": "emailKey" },
    }),
  );
  if (!result.Item) return null;
  const emailKey = result.Item.emailKey?.S;
  return emailKey ? { emailKey } : {};
}

export interface DeletedEmailClaim {
  /**
   * Items deleted: 0 (no USER# item), 1 (only USER#), or 2 plus the USER# items of the EMAIL# item's other holders
   * that still pointed at it.
   */
  deleted: number;
  /** The emailKey the USER# item named, when it had one. */
  emailKey?: string;
  /** The EMAIL# item was not deleted: it names other accounts only, names none (released), or is gone. */
  emailItemKept: boolean;
}

/**
 * The condition under which an `EMAIL#` item still names the account: as its `userName`, or as one of its
 * `holders` (the sign-up attempts on one exact address that hold the base address together).
 */
export const emailItemNamesCondition = (
  userName: string,
): {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, AttributeValue>;
} => ({
  ConditionExpression: "#userName = :userName OR attribute_exists(#holders.#holder)",
  ExpressionAttributeNames: { "#userName": "userName", "#holders": "holders", "#holder": userName },
  ExpressionAttributeValues: { ":userName": { S: userName } },
});

/**
 * X5 (b): reads `USER#<userName>`, deletes `EMAIL#<emailKey>` on condition that its `userName` or one of
 * its `holders` is still this account (emailItemNamesCondition; the whole item goes, so no hash of the
 * address is left behind), then the `USER#<holder>` item of every other holder the deleted item named (the
 * sign-up attempts on the same address that Cognito refused, each of which wrote one with the same email key),
 * on condition that it still names that email key, and last the account's own `USER#` item. The deleted item is
 * returned by the delete itself (ReturnValues ALL_OLD), so no holder that joined in between is missed. A failed
 * condition means another account took the base address over, the item was released, or it is gone: it is kept,
 * and `onEmailItemKept` runs. A failure throws and leaves the account's `USER#` item, so a retry finds the
 * `EMAIL#` item by it (a retry after the `EMAIL#` item is gone no longer knows the other holders: their `USER#`
 * items then stay, as they do after a take-over; RUNBOOK 14.5).
 */
export async function deleteUserEmailClaim(
  table: SignUpEmailClaimsTable,
  userName: string,
  hooks: { onEmailItemKept?: () => void } = {},
): Promise<DeletedEmailClaim> {
  const claim = await readUserEmailClaim(table, userName);
  if (!claim) return { deleted: 0, emailItemKept: false };

  let deleted = 0;
  let emailItemKept = false;
  if (claim.emailKey) {
    let otherHolders: string[] = [];
    try {
      const result = await table.db.send(
        new DeleteItemCommand({
          TableName: table.tableName,
          Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.emailItem(claim.emailKey)),
          ...emailItemNamesCondition(userName),
          ReturnValues: "ALL_OLD",
        }),
      );
      deleted += 1;
      const old = readEmailClaim(result?.Attributes);
      otherHolders = old ? Object.keys(old.holders).filter((holder) => holder !== userName) : [];
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== "ConditionalCheckFailedException") throw error;
      emailItemKept = true;
      hooks.onEmailItemKept?.();
    }
    for (const holder of otherHolders) {
      if (await deleteHolderUserItem(table, holder, claim.emailKey)) deleted += 1;
    }
  }

  // Last, so a failure above leaves this item for the retry to find the EMAIL# item by.
  await table.db.send(
    new DeleteItemCommand({
      TableName: table.tableName,
      Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.userItem(userName)),
    }),
  );
  return { deleted: deleted + 1, ...(claim.emailKey ? { emailKey: claim.emailKey } : {}), emailItemKept };
}
