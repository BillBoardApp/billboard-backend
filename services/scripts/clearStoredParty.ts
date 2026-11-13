#!/usr/bin/env node

// Deletes the political party, gender and birth date that apps 1.1 and earlier stored in the user pool (UX-36;
// project decision O1 of 2026-11-12, WEB-07: clear the stored party values). One-off: from the deploy that sets
// RETIRED_PROFILE_ATTRIBUTES_MODE to 'clear', the nightly ExportCognitoUsers run deletes any value a 1.1 save writes
// later (src/shared/retiredProfileAttributes.ts; ../docs/RUNBOOK.md 25.2).
//
//   npm run clear:stored-party                          dry run (the default; reads only)
//   npm run clear:stored-party -- --apply --expect <N>  deletes them; <N> is the dry run's `holding`
//
// The dry run lists the pool (Cognito ListUsers) and counts the users holding each attribute
// (custom:politicalParty, gender, birthdate). --apply refuses (exit 2, nothing written) unless the users holding any
// of them are exactly --expect, then deletes, per user, exactly the names that user holds (AdminDeleteUserAttributes)
// and lists the pool again to check that none is left. It never deletes another attribute, and it never prints a user
// name, an email address or a value: counts only. The last lines are
//   Stored party plan: users= holding= politicalParty= gender= birthdate=
// and, with --apply,
//   Stored party clear complete cleared= failed= leftAfter=
// Exit codes: 0 done (or nothing to do), 1 a delete failed or a value is left, 2 refused.
//
// Environment: AWS_REGION (us-east-1), USER_POOL_ID (else the one pool named BillboardUserPool).

import { CognitoIdentityProviderClient, ListUserPoolsCommand } from "@aws-sdk/client-cognito-identity-provider";

import {
  type RetiredAttributeTally,
  clearRetiredAttributes,
  listRetiredAttributeHolders,
  tallyRetiredAttributes,
} from "../src/shared/retiredProfileAttributes";

export interface ClearConfig {
  region: string;
  /** Empty: resolved by listing the pools and picking `userPoolName`. */
  userPoolId: string;
  userPoolName: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): ClearConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  userPoolId: (env.USER_POOL_ID ?? "").trim(),
  userPoolName: env.USER_POOL_NAME || "BillboardUserPool",
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  expect: number | null;
  userPoolId: string | null;
}

const USAGE = `Usage: npm run clear:stored-party [-- <flags>]

  (no flag)              Dry run: count the users holding custom:politicalParty, gender or birthdate; writes nothing
  --apply --expect <N>   Delete those attributes (only those) from each user holding one; <N> is the dry run's holding
  --user-pool-id <id>    The user pool (default: USER_POOL_ID, else the one pool named BillboardUserPool)
  --help                 Show this text

Environment: AWS_REGION (us-east-1), USER_POOL_ID.`;

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { help: false, apply: false, expect: null, userPoolId: null };
  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value.trim();
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--expect") {
      const value = valueOf(arg, index);
      if (!/^\d+$/.test(value)) throw new Error(`--expect needs a whole number, not ${value}`);
      options.expect = Number(value);
      index += 1;
    } else if (arg === "--user-pool-id") {
      options.userPoolId = valueOf(arg, index);
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.expect !== null && !options.apply) throw new Error("--expect goes with --apply only");
  if (options.apply && options.expect === null) {
    throw new Error("--apply needs --expect <N>, the holding count of the dry run");
  }
  return options;
};

type CognitoSend = Pick<CognitoIdentityProviderClient, "send">;

export const resolveUserPoolId = async (cognito: CognitoSend, config: ClearConfig): Promise<string> => {
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

export interface ClearDeps {
  cognito: CognitoSend;
  config: ClearConfig;
  options: CliOptions;
  log?: (line: string) => void;
}

export interface ClearRunResult {
  exitCode: 0 | 1 | 2;
  users: number;
  tally: RetiredAttributeTally;
  cleared: number;
  failed: number;
  /** Users still holding a retired attribute when the pool was listed again after --apply; null without --apply. */
  leftAfter: number | null;
}

const planLine = (users: number, tally: RetiredAttributeTally): string =>
  `Stored party plan: users=${users} holding=${tally.holding} ` +
  `politicalParty=${tally.byAttribute["custom:politicalParty"]} gender=${tally.byAttribute.gender} ` +
  `birthdate=${tally.byAttribute.birthdate}`;

export const runClear = async (deps: ClearDeps): Promise<ClearRunResult> => {
  const log = deps.log ?? ((line: string) => console.log(line));
  const userPoolId = await resolveUserPoolId(deps.cognito, {
    ...deps.config,
    userPoolId: deps.options.userPoolId || deps.config.userPoolId,
  });
  log(`${deps.options.apply ? "Apply" : "Dry run"}: user pool ${userPoolId}`);

  const listing = await listRetiredAttributeHolders(deps.cognito, userPoolId);
  const tally = tallyRetiredAttributes(listing.holders);
  log(planLine(listing.users, tally));
  const result: ClearRunResult = { exitCode: 0, users: listing.users, tally, cleared: 0, failed: 0, leftAfter: null };
  if (!deps.options.apply) return result;

  if (tally.holding !== deps.options.expect) {
    log(`Refused: ${tally.holding} user(s) hold a value, not --expect ${deps.options.expect}. Run the dry run again.`);
    return { ...result, exitCode: 2 };
  }

  const cleared = await clearRetiredAttributes(deps.cognito, userPoolId, listing.holders);
  for (const [name, count] of Object.entries(cleared.errorNames)) log(`Delete error ${name}: ${count}`);
  const after = await listRetiredAttributeHolders(deps.cognito, userPoolId);
  const leftAfter = after.holders.length;
  log(`Stored party clear complete cleared=${cleared.cleared} failed=${cleared.failed} leftAfter=${leftAfter}`);
  return {
    ...result,
    cleared: cleared.cleared,
    failed: cleared.failed,
    leftAfter,
    exitCode: cleared.failed > 0 || leftAfter > 0 ? 1 : 0,
  };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runClear({
    cognito: new CognitoIdentityProviderClient({ region: config.region }),
    config,
    options,
  });
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Stored party clear failed", error);
    process.exitCode = 1;
  });
}
