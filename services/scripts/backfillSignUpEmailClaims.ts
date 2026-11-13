#!/usr/bin/env node

// Backfills SignUpEmailClaims for the accounts that existed before the pre-sign-up trigger (INT-05,
// C2 3.5 and 7 step 2; integration plan X5).
//
//   npm run backfill:signup-email-claims                  dry run (read only; the default)
//   npm run backfill:signup-email-claims -- --apply       writes the planned claims
//
// Lists the user pool (Cognito ListUsers), computes each account's base address and emailKey with the
// trigger's own rules (src/handlers/preSignUp/emailPolicy.ts) and the same salt, and plans one claim per
// base address. Accounts that share a base address are a collision: the claim goes to the first of them
// by (still live, not UNCONFIRMED, oldest, userName) and the others are listed. Each planned claim is then
// read from the table: already held by the same account (nothing to do), held by another account
// (a conflict, reported and never overwritten) or missing (to write).
//
// --apply writes each missing claim, two items in one transaction:
//   EMAIL#<emailKey> {userName, claimedAt} and USER#<userName> {emailKey, claimedAt},
// both on condition attribute_not_exists(pk), so a claim written meanwhile by a real sign-up is kept.
// The EMAIL# item keeps the original layout, without addressKey, holders or revision: the trigger reads it as
// one holder whose exact address is unknown (shared/signUpFilter.ts readEmailClaim), so it never treats a
// sign-up on it as a retry, and its next write moves the item to the current layout. An existing item counts
// as already claimed when it names the planned account, as its userName or as one of its holders (of parallel
// sign-ups of one address, the account Cognito created need not be the holder the item names last).
//
// The report never prints an email address or a domain: accounts are shown by sub, claims by the first
// 12 characters of their emailKey. It also reports whether every Cognito userName equals its sub
// (account deletion looks the claim up by USER#<cognito:username, else sub>). The last line is
//   Sign-up email claims plan: users= withEmail= withoutEmail= baseAddresses= collisions= toWrite= alreadyClaimed= conflicts= userNameEqualsSub=
// and, with --apply,
//   Sign-up email claims backfill complete written= skipped= failed=
// Exits with status 1 when a write failed.
//
// Environment: AWS_REGION (us-east-1), USER_POOL_ID (else the pool named BillboardUserPool),
// SIGNUP_EMAIL_CLAIMS_TABLE_NAME (SignUpEmailClaims), HASH_SALT_SECRET_ID
// (Billboard/DistrictVerificationHashSalt; HASH_SALT overrides it for local use).

import {
  CognitoIdentityProviderClient,
  ListUserPoolsCommand,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import {
  emailClaimKey,
  emailClaimNames,
  emailKeyFor,
  isLiveClaimHolder,
  parseEmailAddress,
  userClaimKey,
} from "../src/handlers/preSignUp/emailPolicy";
import { mapWithConcurrency } from "../src/shared/concurrency";

export interface BackfillConfig {
  region: string;
  /** Empty: resolved by listing the pools and picking `userPoolName`. */
  userPoolId: string;
  userPoolName: string;
  tableName: string;
  saltSecretId: string;
  /** Local override of the salt (never set in production use). */
  saltOverride: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): BackfillConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  userPoolId: (env.USER_POOL_ID ?? "").trim(),
  userPoolName: env.USER_POOL_NAME || "BillboardUserPool",
  tableName: env.SIGNUP_EMAIL_CLAIMS_TABLE_NAME || "SignUpEmailClaims",
  saltSecretId: env.HASH_SALT_SECRET_ID || env.HASH_SALT_SECRET_ARN || "Billboard/DistrictVerificationHashSalt",
  saltOverride: (env.HASH_SALT ?? "").trim(),
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  userPoolId: string | null;
  tableName: string | null;
}

const USAGE = `Usage: npm run backfill:signup-email-claims [-- [--apply] [--user-pool-id <id>] [--table <name>]]

  (no flag)            Dry run: list the pool, plan one claim per base address, write nothing
  --apply              Write the planned claims that are missing (attribute_not_exists on both items)
  --user-pool-id <id>  The user pool (default: USER_POOL_ID, else the pool named BillboardUserPool)
  --table <name>       The claims table (default: SIGNUP_EMAIL_CLAIMS_TABLE_NAME, else SignUpEmailClaims)
  --help               Show this text`;

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { help: false, apply: false, userPoolId: null, tableName: null };
  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value.trim();
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--user-pool-id") {
      options.userPoolId = valueOf(arg, index);
      index += 1;
    } else if (arg === "--table") {
      options.tableName = valueOf(arg, index);
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

type CognitoSend = Pick<CognitoIdentityProviderClient, "send">;
type DynamoSend = Pick<DynamoDBClient, "send">;
type SecretsSend = Pick<SecretsManagerClient, "send">;

export interface PoolUser {
  userName: string;
  sub: string | null;
  email: string | null;
  status: string | undefined;
  createdAt: Date | undefined;
}

const LIST_USERS_PAGE_SIZE = 60;

const toPoolUser = (user: UserType): PoolUser => {
  const attributes = new Map((user.Attributes ?? []).map((attribute) => [attribute.Name, attribute.Value]));
  return {
    userName: user.Username ?? "",
    sub: attributes.get("sub") ?? null,
    email: attributes.get("email") ?? null,
    status: user.UserStatus,
    createdAt: user.UserCreateDate,
  };
};

export const listPoolUsers = async (cognito: CognitoSend, userPoolId: string): Promise<PoolUser[]> => {
  const users: PoolUser[] = [];
  let paginationToken: string | undefined;
  do {
    const page = await cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: LIST_USERS_PAGE_SIZE,
        AttributesToGet: ["sub", "email"],
        PaginationToken: paginationToken,
      }),
    );
    users.push(...(page.Users ?? []).map(toPoolUser));
    paginationToken = page.PaginationToken;
  } while (paginationToken);
  return users;
};

export const resolveUserPoolId = async (cognito: CognitoSend, config: BackfillConfig): Promise<string> => {
  if (config.userPoolId) return config.userPoolId;
  const matches: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken: nextToken }));
    for (const pool of page.UserPools ?? []) {
      if (pool.Name === config.userPoolName && pool.Id) matches.push(pool.Id);
    }
    nextToken = page.NextToken;
  } while (nextToken);
  if (matches.length !== 1) {
    throw new Error(
      `Found ${matches.length} user pools named ${config.userPoolName}; pass --user-pool-id or set USER_POOL_ID.`,
    );
  }
  return matches[0];
};

export const loadSalt = async (secrets: SecretsSend, config: BackfillConfig): Promise<string> => {
  if (config.saltOverride) return config.saltOverride;
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: config.saltSecretId }));
  const salt = (response.SecretString ?? "").trim();
  if (!salt) throw new Error(`The hash salt secret ${config.saltSecretId} is empty.`);
  return salt;
};

export interface PlannedClaim {
  emailKey: string;
  userName: string;
  sub: string | null;
  /** Other accounts with the same base address (a collision when not empty). */
  others: PoolUser[];
}

export interface ClaimPlan {
  users: number;
  withEmail: number;
  /** Subs (or userNames) of accounts without a parseable email; they get no claim. */
  withoutEmail: string[];
  claims: PlannedClaim[];
  /** Accounts whose userName differs from their sub (shown by sub). */
  userNameMismatches: string[];
}

const holderRank = (user: PoolUser, now: number): [number, number, number, string] => [
  isLiveClaimHolder(user, now) ? 0 : 1,
  user.status === "UNCONFIRMED" ? 1 : 0,
  user.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
  user.userName,
];

const compareRanks = (left: ReturnType<typeof holderRank>, right: ReturnType<typeof holderRank>): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return left[3].localeCompare(right[3]);
};

/** One claim per base address; pure. */
export const planClaims = (users: readonly PoolUser[], salt: string, now: number): ClaimPlan => {
  const byKey = new Map<string, PoolUser[]>();
  const withoutEmail: string[] = [];
  for (const user of users) {
    const parsed = parseEmailAddress(user.email);
    if (!parsed || !user.userName) {
      withoutEmail.push(user.sub ?? user.userName);
      continue;
    }
    const emailKey = emailKeyFor(parsed.base, salt);
    byKey.set(emailKey, [...(byKey.get(emailKey) ?? []), user]);
  }

  const claims: PlannedClaim[] = [...byKey.entries()].map(([emailKey, holders]) => {
    const [first, ...others] = [...holders].sort((left, right) =>
      compareRanks(holderRank(left, now), holderRank(right, now)),
    );
    return { emailKey, userName: first.userName, sub: first.sub, others };
  });

  return {
    users: users.length,
    withEmail: users.length - withoutEmail.length,
    withoutEmail,
    claims,
    userNameMismatches: users
      .filter((user) => user.sub !== null && user.userName !== user.sub)
      .map((user) => user.sub as string),
  };
};

export type ClaimState = "to_write" | "already_claimed" | "conflict";

export interface ClaimStatus extends PlannedClaim {
  state: ClaimState;
  /** The account named by an existing claim (conflict only). */
  existingUserName?: string;
}

const GET_CONCURRENCY = 4;

export const readClaimStates = async (
  dynamo: DynamoSend,
  tableName: string,
  claims: readonly PlannedClaim[],
): Promise<ClaimStatus[]> =>
  mapWithConcurrency(claims, GET_CONCURRENCY, async (claim): Promise<ClaimStatus> => {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { pk: { S: emailClaimKey(claim.emailKey) } },
        ConsistentRead: true,
      }),
    );
    if (!Item) return { ...claim, state: "to_write" };
    if (emailClaimNames(Item, claim.userName)) return { ...claim, state: "already_claimed" };
    return { ...claim, state: "conflict", existingUserName: Item.userName?.S };
  });

const isConditionCancellation = (error: unknown): boolean =>
  error instanceof Error && error.name === "TransactionCanceledException";

export const writeClaim = async (dynamo: DynamoSend, tableName: string, claim: PlannedClaim, claimedAt: string) =>
  dynamo.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: { S: emailClaimKey(claim.emailKey) },
              userName: { S: claim.userName },
              claimedAt: { S: claimedAt },
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: { S: userClaimKey(claim.userName) },
              emailKey: { S: claim.emailKey },
              claimedAt: { S: claimedAt },
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    }),
  );

export interface BackfillDeps {
  cognito: CognitoSend;
  dynamo: DynamoSend;
  secrets: SecretsSend;
  config: BackfillConfig;
  options: CliOptions;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface BackfillResult {
  userPoolId: string;
  tableName: string;
  plan: ClaimPlan;
  statuses: ClaimStatus[];
  userNameEqualsSub: boolean;
  written: number;
  skipped: number;
  failed: string[];
}

const keyLabel = (emailKey: string): string => emailKey.slice(0, 12);
const userLabel = (user: Pick<PoolUser, "sub" | "userName">): string => user.sub ?? user.userName;

export const runBackfill = async (deps: BackfillDeps): Promise<BackfillResult> => {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const tableName = deps.options.tableName || deps.config.tableName;
  const userPoolId = await resolveUserPoolId(deps.cognito, {
    ...deps.config,
    userPoolId: deps.options.userPoolId || deps.config.userPoolId,
  });
  const salt = await loadSalt(deps.secrets, deps.config);

  log(`${deps.options.apply ? "Apply" : "Dry run"}: user pool ${userPoolId}, table ${tableName}`);
  const users = await listPoolUsers(deps.cognito, userPoolId);
  const plan = planClaims(users, salt, now().getTime());
  const statuses = await readClaimStates(deps.dynamo, tableName, plan.claims);

  const collisions = statuses.filter((status) => status.others.length > 0);
  for (const status of collisions) {
    log(
      `Collision ${keyLabel(status.emailKey)}: claim to ${userLabel(status)}; also ` +
        status.others.map((other) => `${userLabel(other)} (${other.status ?? "unknown"})`).join(", "),
    );
  }
  for (const status of statuses.filter((entry) => entry.state === "conflict")) {
    log(
      `Conflict ${keyLabel(status.emailKey)}: planned for ${userLabel(status)}, held by ${status.existingUserName ?? "an item without userName"} (kept)`,
    );
  }
  if (plan.withoutEmail.length > 0) log(`No parseable email (no claim): ${plan.withoutEmail.join(", ")}`);
  const userNameEqualsSub = plan.userNameMismatches.length === 0;
  if (!userNameEqualsSub) {
    log(
      `userName differs from sub for ${plan.userNameMismatches.length} account(s): ${plan.userNameMismatches.join(", ")}` +
        " (deletion must look these claims up by cognito:username)",
    );
  }

  const toWrite = statuses.filter((status) => status.state === "to_write");
  log(
    `Sign-up email claims plan: users=${plan.users} withEmail=${plan.withEmail} withoutEmail=${plan.withoutEmail.length} ` +
      `baseAddresses=${plan.claims.length} collisions=${collisions.length} toWrite=${toWrite.length} ` +
      `alreadyClaimed=${statuses.filter((status) => status.state === "already_claimed").length} ` +
      `conflicts=${statuses.filter((status) => status.state === "conflict").length} userNameEqualsSub=${userNameEqualsSub}`,
  );

  const result: BackfillResult = {
    userPoolId,
    tableName,
    plan,
    statuses,
    userNameEqualsSub,
    written: 0,
    skipped: 0,
    failed: [],
  };
  if (!deps.options.apply) return result;

  const claimedAt = now().toISOString();
  for (const claim of toWrite) {
    try {
      await writeClaim(deps.dynamo, tableName, claim, claimedAt);
      result.written += 1;
    } catch (error) {
      if (isConditionCancellation(error)) {
        result.skipped += 1;
        log(`Skipped ${keyLabel(claim.emailKey)} (${userLabel(claim)}): a claim was written meanwhile`);
      } else {
        result.failed.push(userLabel(claim));
        log(`Failed ${keyLabel(claim.emailKey)} (${userLabel(claim)}): ${(error as Error)?.message ?? String(error)}`);
      }
    }
  }
  log(
    `Sign-up email claims backfill complete written=${result.written} skipped=${result.skipped} failed=${result.failed.length}`,
  );
  return result;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runBackfill({
    cognito: new CognitoIdentityProviderClient({ region: config.region }),
    dynamo: new DynamoDBClient({ region: config.region }),
    secrets: new SecretsManagerClient({ region: config.region }),
    config,
    options,
  });
  if (result.failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Sign-up email claims backfill failed", error);
    process.exitCode = 1;
  });
}
