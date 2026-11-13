import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  type AttributeType,
  type CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteItemCommand, GetItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  SIGNUP_EMAIL_CLAIM_KEYS,
  deleteUserEmailClaim,
  emailClaimTableKey,
  type SignUpEmailClaimsTable,
} from "../../shared/signUpEmailClaims";
import {
  fromProbeRecordItem,
  isProbeAddress,
  type ProbeKind,
  type SignUpFilterCheckAddress,
  type SignUpProbeRecord,
} from "../../shared/signUpFilter";

/**
 * What the filter check's run (run.ts) and sweep (sweep.ts) share: configuration, the injectable
 * dependencies, the verdict, and the one guarded path to delete a probe account and its items.
 */

export const SIGNUP_FILTER_CHECK_METRIC_NAMESPACE = "BillBoard/SignUpFilterCheck";

/** A leftover probe account younger than this may belong to a run in progress: never deleted by the sweep. */
export const LEFTOVER_MIN_AGE_MS = 15 * 60 * 1000;
/** At most this many leftover accounts are deleted by one sweep, oldest first. */
export const MAX_SWEEP_DELETIONS = 5;
/** ListUsers pages (60 users each) the sweep reads at most. */
export const LIST_USERS_MAX_PAGES = 5;
/** Allowed difference between the Lambda's clock and the trigger's when matching a probe record. */
export const CLOCK_SKEW_MS = 5_000;
/** An account found by address after an ambiguous SignUp error is this run's only if created this recently. */
export const OWN_ACCOUNT_SLACK_MS = 60_000;
/** No SignUp starts with less time than this left before the Lambda timeout. */
export const MIN_TIME_FOR_SIGN_UP_MS = 20_000;
/** AdminDeleteUser is retried this many times on throttling. */
export const DELETE_RETRIES = 3;
const DELETE_BACKOFF_MS = 200;

export type FilterMode = "watch" | "enforce";

export interface CheckConfig {
  check: SignUpFilterCheckAddress;
  /** SIGNUP_FILTER_CHECK_EXPECTED_MODE: the SIGNUP_FILTER_MODE constant PreSignUpCheck is deployed with. */
  expectedMode: FilterMode;
  userPoolId: string;
  /** The app's client (BillboardUserPoolClient): the same public SignUp path the app uses. */
  clientId: string;
  tableName: string;
  /** The probe token (INF-15) every SignUp carries in its ClientMetadata, so the filter knows the probe. */
  probeToken: string;
}

export interface CheckDeps {
  /** Admin calls (AdminGetUser, ListUsers, AdminDeleteUser). */
  cognito: Pick<CognitoIdentityProviderClient, "send">;
  /** The public SignUp call, made with no SDK retries: a sign-up is never sent twice. */
  signUp: Pick<CognitoIdentityProviderClient, "send">;
  db: Pick<DynamoDBClient, "send">;
  now: () => number;
  randomBytes: (size: number) => Buffer;
  sleep: (ms: number) => Promise<void>;
  /** Milliseconds before the Lambda times out. */
  timeLeftMs: () => number;
}

export type Outcome = "pass" | "fail" | "inconclusive";

export const FAIL_REASONS = [
  "config",
  "probe_address_confirmed",
  "too_many_leftovers",
  "filter_silent",
  "base_rejected",
  "base_check_error",
  "base_claim_missing",
  "variant_not_detected",
  "variant_not_refused",
  "variant_wrong_refusal",
  "variant_check_error",
  "claim_disturbed",
  "password_policy",
  "signup_error",
  "refused_delete",
  "cleanup_incomplete",
  "internal_error",
] as const;
export const INCONCLUSIVE_REASONS = [
  "busy",
  "leftover_exists",
  "leftover_holder",
  "base_claim_pending",
  "cognito_limit",
  "blocked_by_app_attest",
  "mode_mismatch",
  "probe_record_missing",
  "deadline",
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];
export type InconclusiveReason = (typeof INCONCLUSIVE_REASONS)[number];

export type Stage = "config" | "sweep" | "base" | "variant" | "cleanup" | "done";

const SEVERITY: Record<Outcome, number> = { pass: 0, inconclusive: 1, fail: 2 };

/** The run's result: fail outranks inconclusive, which outranks pass; the first reason at that rank stays. */
export class Verdict {
  outcome: Outcome = "pass";
  reason: FailReason | InconclusiveReason | undefined;
  /** Where the reason was found. */
  stage: Stage = "config";
  /** Where the run is now. */
  current: Stage = "config";

  fail(reason: FailReason): void {
    this.note("fail", reason);
  }

  inconclusive(reason: InconclusiveReason): void {
    this.note("inconclusive", reason);
  }

  get failed(): boolean {
    return this.outcome === "fail";
  }

  private note(outcome: Outcome, reason: FailReason | InconclusiveReason): void {
    if (SEVERITY[outcome] <= SEVERITY[this.outcome]) return;
    this.outcome = outcome;
    this.reason = reason;
    this.stage = this.current;
  }
}

/** Items the run or sweep removed or could not remove (counts only). */
export class Tally {
  usersDeleted = 0;
  claimItemsDeleted = 0;
  recordsDeleted = 0;
  /** Leftovers from earlier runs (or strangers' probe sign-ups) removed: users, claim items and records. */
  swept = 0;
  refused = 0;
  incomplete = 0;
}

export interface Context {
  config: CheckConfig;
  deps: CheckDeps;
  verdict: Verdict;
  tally: Tally;
}

export const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error === "object" && error !== null ? "Object" : typeof error;

const THROTTLE_ERRORS = new Set(["TooManyRequestsException", "LimitExceededException", "ThrottlingException"]);
export const isThrottle = (error: unknown): boolean => THROTTLE_ERRORS.has(errorName(error));

export const attributeOf = (attributes: AttributeType[] | undefined, name: string): string | undefined =>
  attributes?.find((attribute) => attribute.Name === name)?.Value;

export interface ProbeUser {
  username: string;
  sub: string | undefined;
  email: string | undefined;
  status: string | undefined;
  createdAt: number | undefined;
}

/** AdminGetUser, or null when Cognito has no such user. `username` may be the sub or the email alias. */
export const getUser = async (ctx: Context, username: string): Promise<ProbeUser | null> => {
  try {
    const user = (await ctx.deps.cognito.send(
      new AdminGetUserCommand({ UserPoolId: ctx.config.userPoolId, Username: username }),
    )) as {
      Username?: string;
      UserAttributes?: AttributeType[];
      UserStatus?: string;
      UserCreateDate?: Date;
    };
    return {
      username: user.Username ?? "",
      sub: attributeOf(user.UserAttributes, "sub"),
      email: attributeOf(user.UserAttributes, "email"),
      status: user.UserStatus,
      createdAt: user.UserCreateDate instanceof Date ? user.UserCreateDate.getTime() : undefined,
    };
  } catch (error) {
    if (errorName(error) === "UserNotFoundException") return null;
    throw error;
  }
};

const claimsTable = (ctx: Context): SignUpEmailClaimsTable => ({ db: ctx.deps.db, tableName: ctx.config.tableName });

/** A strongly consistent GetItem on SignUpEmailClaims. */
export const getClaimItem = async (ctx: Context, pk: string): Promise<Record<string, { S?: string }> | undefined> => {
  const result = (await ctx.deps.db.send(
    new GetItemCommand({ TableName: ctx.config.tableName, Key: emailClaimTableKey(pk), ConsistentRead: true }),
  )) as { Item?: Record<string, { S?: string }> };
  return result.Item;
};

export const readProbeRecord = async (ctx: Context, kind: ProbeKind): Promise<SignUpProbeRecord | null> => {
  const result = (await ctx.deps.db.send(
    new GetItemCommand({
      TableName: ctx.config.tableName,
      Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.probeItem(kind)),
      ConsistentRead: true,
    }),
  )) as { Item?: Parameters<typeof fromProbeRecordItem>[0] };
  const record = fromProbeRecordItem(result.Item);
  return record && record.kind === kind ? record : null;
};

/** Deletes a probe record on condition that `attribute` still has `value` (a newer record is left alone). */
export const deleteProbeRecord = async (
  ctx: Context,
  kind: ProbeKind,
  attribute: "userName" | "at",
  value: string,
): Promise<boolean> => {
  try {
    await ctx.deps.db.send(
      new DeleteItemCommand({
        TableName: ctx.config.tableName,
        Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.probeItem(kind)),
        ConditionExpression: "#attribute = :value",
        ExpressionAttributeNames: { "#attribute": attribute },
        ExpressionAttributeValues: { ":value": { S: value } },
      }),
    );
    ctx.tally.recordsDeleted += 1;
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
};

/**
 * An EMAIL# item that names no account (released by PreSignUpCheck when a later check refused the sign-up)
 * is deleted on condition that it still names none and still has the release time read; one that names an
 * account is never touched.
 */
const deleteReleasedEmailItem = async (ctx: Context, emailKey: string): Promise<number> => {
  const item = await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.emailItem(emailKey));
  if (!item || item.userName?.S !== undefined) return 0;
  const releasedAt = item.releasedAt?.S;
  try {
    await ctx.deps.db.send(
      new DeleteItemCommand({
        TableName: ctx.config.tableName,
        Key: emailClaimTableKey(SIGNUP_EMAIL_CLAIM_KEYS.emailItem(emailKey)),
        ConditionExpression:
          releasedAt === undefined
            ? "attribute_not_exists(#userName) AND attribute_not_exists(#releasedAt)"
            : "attribute_not_exists(#userName) AND #releasedAt = :releasedAt",
        ExpressionAttributeNames: { "#userName": "userName", "#releasedAt": "releasedAt" },
        ...(releasedAt === undefined ? {} : { ExpressionAttributeValues: { ":releasedAt": { S: releasedAt } } }),
      }),
    );
    return 1;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return 0;
    throw error;
  }
};

export interface ProbeSubject {
  /** The account's sub, which is also its Cognito username in this pool (UsernameAttributes email). */
  sub: string;
  kind: ProbeKind;
  /** Delete the account only when it was created at or after this time (epoch ms). */
  createdAtLeast?: number;
  /** Delete the account only when it was created at or before this time (the sweep's age guard). */
  createdAtMost?: number;
  /** Delete PROBE#<kind> too, when it still names this account. */
  deleteRecord?: boolean;
  /** Counted as a leftover (SignUpFilterCheckSwept). */
  leftover?: boolean;
}

export type RemovalResult =
  | { status: "removed"; emailKey?: string; accountExisted: boolean }
  | { status: "refused" }
  | { status: "incomplete"; step: "lookup" | "claims" | "account" | "record"; emailKey?: string };

/**
 * The only path to AdminDeleteUser. One subject's chain, each step only after the one before succeeded:
 *
 * 1. Guard: AdminGetUser. An existing account is deleted only when its Username is its sub, its email is a
 *    probe address (the filter's own probeKindOf), it is UNCONFIRMED, and its creation time is inside the
 *    subject's bounds. Otherwise the subject is refused and nothing of it is touched.
 * 2. Its claim items: USER#<sub>, EMAIL#<emailKey> while it names this account, and the EMAIL# item if
 *    PreSignUpCheck released it (names no account).
 * 3. The account (UserNotFound counts as done; throttling is retried).
 * 4. PROBE#<kind>, when asked and it still names this account.
 *
 * Claims go before the account, so a crash leaves at worst an account, which the next sweep finds; never
 * claim items that only a Scan could find.
 */
export const removeProbeSubject = async (ctx: Context, subject: ProbeSubject): Promise<RemovalResult> => {
  let account: ProbeUser | null;
  try {
    account = await getUser(ctx, subject.sub);
  } catch {
    ctx.tally.incomplete += 1;
    return { status: "incomplete", step: "lookup" };
  }
  if (account) {
    const allowed =
      account.username === subject.sub &&
      account.sub === subject.sub &&
      isProbeAddress(account.email, ctx.config.check) &&
      account.status === "UNCONFIRMED" &&
      account.createdAt !== undefined &&
      (subject.createdAtLeast === undefined || account.createdAt >= subject.createdAtLeast) &&
      (subject.createdAtMost === undefined || account.createdAt <= subject.createdAtMost);
    if (!allowed) {
      ctx.tally.refused += 1;
      return { status: "refused" };
    }
  }

  let emailKey: string | undefined;
  try {
    const claim = await deleteUserEmailClaim(claimsTable(ctx), subject.sub);
    emailKey = claim.emailKey;
    let removed = claim.deleted;
    if (claim.emailItemKept && claim.emailKey) removed += await deleteReleasedEmailItem(ctx, claim.emailKey);
    ctx.tally.claimItemsDeleted += removed;
    if (subject.leftover) ctx.tally.swept += removed;
  } catch {
    ctx.tally.incomplete += 1;
    return { status: "incomplete", step: "claims", ...(emailKey ? { emailKey } : {}) };
  }

  if (account) {
    try {
      await deleteAccount(ctx, subject.sub);
      ctx.tally.usersDeleted += 1;
      if (subject.leftover) ctx.tally.swept += 1;
    } catch {
      ctx.tally.incomplete += 1;
      return { status: "incomplete", step: "account", ...(emailKey ? { emailKey } : {}) };
    }
  }

  if (subject.deleteRecord) {
    try {
      if ((await deleteProbeRecord(ctx, subject.kind, "userName", subject.sub)) && subject.leftover) {
        ctx.tally.swept += 1;
      }
    } catch {
      ctx.tally.incomplete += 1;
      return { status: "incomplete", step: "record", ...(emailKey ? { emailKey } : {}) };
    }
  }
  return { status: "removed", accountExisted: account !== null, ...(emailKey ? { emailKey } : {}) };
};

const deleteAccount = async (ctx: Context, sub: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ctx.deps.cognito.send(new AdminDeleteUserCommand({ UserPoolId: ctx.config.userPoolId, Username: sub }));
      return;
    } catch (error) {
      if (errorName(error) === "UserNotFoundException") return;
      if (!isThrottle(error) || attempt >= DELETE_RETRIES) throw error;
      await ctx.deps.sleep(DELETE_BACKOFF_MS * 2 ** attempt);
    }
  }
};
