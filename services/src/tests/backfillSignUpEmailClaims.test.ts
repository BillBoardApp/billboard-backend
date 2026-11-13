import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import {
  configFromEnv,
  parseArgs,
  planClaims,
  runBackfill,
  type BackfillConfig,
  type CliOptions,
  type PoolUser,
} from "../../scripts/backfillSignUpEmailClaims";
import { emailKeyFor, parseEmailAddress } from "../handlers/preSignUp/emailPolicy";
import { evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";

/*
 * `npm run backfill:signup-email-claims` (INT-05, C2 3.5 and 7 step 2; integration plan X5 and 5.2):
 * the dry run lists the pool and writes nothing, reports collisions and whether every userName equals
 * its sub; --apply writes EMAIL# and USER# in one transaction with attribute_not_exists on both. The
 * claims table is in memory and honours the exact conditions sent (fixtures/dynamoCondition).
 */

type Item = Record<string, AttributeValue>;
/** The input fields the fakes and assertions read, across the Dynamo and Cognito commands. */
interface CallInput {
  Key?: Item;
  ConsistentRead?: boolean;
  TableName?: string;
  UserPoolId?: string;
  PaginationToken?: string;
  NextToken?: string;
  TransactItems?: Array<{ Put: ConditionInput & { Item: Item } }>;
}
interface FakeCommand {
  constructor: { name: string };
  input: CallInput;
}
type Call = { name: string; input: CallInput };

const SALT = "backfill-salt";
const POOL = "us-east-1_TestPool";
const TABLE = "SignUpEmailClaims";
const NOW = new Date("2026-10-08T12:00:00.000Z");

const config: BackfillConfig = {
  region: "us-east-1",
  userPoolId: POOL,
  userPoolName: "BillboardUserPool",
  tableName: TABLE,
  saltSecretId: "Billboard/DistrictVerificationHashSalt",
  saltOverride: "",
};
const dryRun: CliOptions = { help: false, apply: false, userPoolId: null, tableName: null };
const apply: CliOptions = { ...dryRun, apply: true };

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

const cognitoUser = (
  sub: string,
  email: string | null,
  status = "CONFIRMED",
  created = hoursAgo(24 * 90),
  userName = sub,
) => ({
  Username: userName,
  UserStatus: status,
  UserCreateDate: created,
  Enabled: true,
  Attributes: [{ Name: "sub", Value: sub }, ...(email ? [{ Name: "email", Value: email }] : [])],
});

const keyFor = (address: string) => emailKeyFor(parseEmailAddress(address)!.base, SALT);

let table: Map<string, Item>;
let dynamoCalls: Call[];
let cognitoCalls: Call[];
let pages: Array<{ Users: unknown[]; PaginationToken?: string }>;
let transactError: Error | undefined;
let lines: string[];

const dynamo = {
  send: jest.fn(async (command: FakeCommand): Promise<unknown> => {
    const call = { name: command.constructor.name, input: command.input };
    dynamoCalls.push(call);
    if (call.name === "GetItemCommand") return { Item: table.get(call.input.Key!.pk.S!) };
    if (call.name === "TransactWriteItemsCommand") {
      if (transactError) throw transactError;
      const ok = call.input.TransactItems!.every(({ Put }) => evaluateCondition(table.get(Put.Item.pk.S!), Put));
      if (!ok) throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
      for (const { Put } of call.input.TransactItems!) table.set(Put.Item.pk.S!, Put.Item);
      return {};
    }
    throw new Error(`Unexpected DynamoDB command ${call.name}`);
  }),
};

const cognito = {
  send: jest.fn(async (command: FakeCommand): Promise<unknown> => {
    const call = { name: command.constructor.name, input: command.input };
    cognitoCalls.push(call);
    if (call.name === "ListUsersCommand") {
      const index = call.input.PaginationToken ? Number(call.input.PaginationToken) : 0;
      return pages[index];
    }
    if (call.name === "ListUserPoolsCommand") {
      return call.input.NextToken
        ? { UserPools: [{ Id: POOL, Name: "BillboardUserPool" }] }
        : { UserPools: [{ Id: "us-east-1_Other", Name: "Other" }], NextToken: "2" };
    }
    throw new Error(`Unexpected Cognito command ${call.name}`);
  }),
};

const secrets = { send: jest.fn(async () => ({ SecretString: `${SALT}\n` })) };

const run = (options: CliOptions = dryRun, overrides: Partial<BackfillConfig> = {}) =>
  runBackfill({
    cognito,
    dynamo,
    secrets,
    config: { ...config, ...overrides },
    options,
    now: () => NOW,
    log: (line) => lines.push(line),
  });

const writes = () => dynamoCalls.filter((call) => call.name === "TransactWriteItemsCommand");
const lastLine = () => lines[lines.length - 1];

beforeEach(() => {
  table = new Map();
  dynamoCalls = [];
  cognitoCalls = [];
  transactError = undefined;
  lines = [];
  pages = [
    {
      Users: [
        cognitoUser("sub-ann", "Ann@Example.com"),
        cognitoUser("sub-ann-tag", "ann+billboard@example.com", "CONFIRMED", hoursAgo(10)),
        cognitoUser("sub-bob", "bob.smith@gmail.com"),
      ],
      PaginationToken: "1",
    },
    {
      Users: [
        cognitoUser("sub-bob-dots", "BOBSMITH+x@googlemail.com", "UNCONFIRMED", hoursAgo(1)),
        cognitoUser("sub-cat", "cat@example.org"),
        cognitoUser("sub-noemail", null),
      ],
    },
  ];
  dynamo.send.mockClear();
  cognito.send.mockClear();
  secrets.send.mockClear();
});

describe("arguments and configuration", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual(dryRun);
    expect(parseArgs(["--apply", "--user-pool-id", "us-east-1_X", "--table", "T"])).toEqual({
      help: false,
      apply: true,
      userPoolId: "us-east-1_X",
      tableName: "T",
    });
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(() => parseArgs(["--table"])).toThrow("--table needs a value");
    expect(() => parseArgs(["--force"])).toThrow("Unknown argument: --force");
  });

  it("reads the environment with production defaults", () => {
    expect(configFromEnv({})).toEqual({
      region: "us-east-1",
      userPoolId: "",
      userPoolName: "BillboardUserPool",
      tableName: "SignUpEmailClaims",
      saltSecretId: "Billboard/DistrictVerificationHashSalt",
      saltOverride: "",
    });
    expect(
      configFromEnv({
        USER_POOL_ID: " p ",
        SIGNUP_EMAIL_CLAIMS_TABLE_NAME: "T",
        HASH_SALT: " s ",
        AWS_REGION: "eu-west-1",
      }),
    ).toMatchObject({ userPoolId: "p", tableName: "T", saltOverride: "s", region: "eu-west-1" });
  });
});

describe("dry run", () => {
  it("lists every page, plans one claim per base address, reads the claims and writes nothing", async () => {
    const result = await run();

    expect(cognitoCalls.map((call) => call.input)).toEqual([
      { UserPoolId: POOL, Limit: 60, AttributesToGet: ["sub", "email"], PaginationToken: undefined },
      { UserPoolId: POOL, Limit: 60, AttributesToGet: ["sub", "email"], PaginationToken: "1" },
    ]);
    expect(secrets.send).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);
    expect(dynamoCalls.every((call) => call.name === "GetItemCommand" && call.input.ConsistentRead === true)).toBe(
      true,
    );
    expect(table.size).toBe(0);

    expect(result.plan.claims.map((claim) => [claim.userName, claim.others.map((other) => other.userName)])).toEqual([
      ["sub-ann", ["sub-ann-tag"]],
      ["sub-bob", ["sub-bob-dots"]],
      ["sub-cat", []],
    ]);
    expect(result.plan.withoutEmail).toEqual(["sub-noemail"]);
    expect(result.userNameEqualsSub).toBe(true);
    expect(lastLine()).toBe(
      "Sign-up email claims plan: users=6 withEmail=5 withoutEmail=1 baseAddresses=3 collisions=2 toWrite=3 " +
        "alreadyClaimed=0 conflicts=0 userNameEqualsSub=true",
    );
  });

  it("uses the trigger's emailKey for each base address", async () => {
    const result = await run();
    expect(result.plan.claims.map((claim) => claim.emailKey)).toEqual([
      keyFor("ann@example.com"),
      keyFor("bobsmith@gmail.com"),
      keyFor("cat@example.org"),
    ]);
  });

  it("never prints an email address or a domain", async () => {
    await run();
    const output = lines.join("\n");
    for (const fragment of ["ann@", "Ann", "bob.smith", "bobsmith", "cat@", "example.com", "example.org", "gmail"]) {
      expect(output).not.toContain(fragment);
    }
    expect(output).toContain(
      `Collision ${keyFor("ann@example.com").slice(0, 12)}: claim to sub-ann; also sub-ann-tag (CONFIRMED)`,
    );
  });

  it("reports already-held claims and conflicts, and never plans to overwrite a conflict", async () => {
    table.set(`EMAIL#${keyFor("ann@example.com")}`, { pk: { S: "x" }, userName: { S: "sub-ann" } });
    table.set(`EMAIL#${keyFor("cat@example.org")}`, { pk: { S: "y" }, userName: { S: "someone-else" } });
    // Of two parallel sign-ups of Bob's address, Cognito created sub-bob; the item names the refused one last.
    table.set(`EMAIL#${keyFor("bobsmith@gmail.com")}`, {
      pk: { S: "z" },
      userName: { S: "refused-attempt" },
      holders: {
        M: { "sub-bob": { S: "2026-11-03T12:00:00.000Z" }, "refused-attempt": { S: "2026-11-03T12:00:01.000Z" } },
      },
    });

    const result = await run();

    expect(result.statuses.map((status) => [status.userName, status.state])).toEqual([
      ["sub-ann", "already_claimed"],
      ["sub-bob", "already_claimed"],
      ["sub-cat", "conflict"],
    ]);
    expect(lines).toContain(
      `Conflict ${keyFor("cat@example.org").slice(0, 12)}: planned for sub-cat, held by someone-else (kept)`,
    );
    expect(lastLine()).toContain("toWrite=0 alreadyClaimed=2 conflicts=1");
  });

  it("reports whether every userName equals sub (deletion looks claims up by USER#<username>)", async () => {
    pages = [
      {
        Users: [
          cognitoUser("sub-1", "a@x.com"),
          cognitoUser("sub-2", "b@x.com", "CONFIRMED", hoursAgo(5), "custom-name"),
        ],
      },
    ];

    const result = await run();

    expect(result.userNameEqualsSub).toBe(false);
    expect(result.plan.userNameMismatches).toEqual(["sub-2"]);
    expect(lines.some((line) => line.startsWith("userName differs from sub for 1 account(s): sub-2"))).toBe(true);
    expect(lines.join("\n")).not.toContain("custom-name");
    expect(lastLine()).toContain("userNameEqualsSub=false");
  });

  it("resolves the pool by name when no id is given", async () => {
    await run(dryRun, { userPoolId: "" });
    expect(cognitoCalls.slice(0, 2).map((call) => call.name)).toEqual(["ListUserPoolsCommand", "ListUserPoolsCommand"]);
    expect(cognitoCalls[2].input.UserPoolId).toBe(POOL);
  });

  it("stops when no pool (or more than one) has the name", async () => {
    await expect(run(dryRun, { userPoolId: "", userPoolName: "Missing" })).rejects.toThrow(
      "Found 0 user pools named Missing; pass --user-pool-id or set USER_POOL_ID.",
    );
    expect(dynamoCalls).toEqual([]);
  });

  it("prefers --user-pool-id and --table over the configuration", async () => {
    const result = await run({ ...dryRun, userPoolId: "us-east-1_Flag", tableName: "FlagTable" });
    expect(result.userPoolId).toBe("us-east-1_Flag");
    expect(dynamoCalls[0].input.TableName).toBe("FlagTable");
    expect(cognitoCalls[0].input.UserPoolId).toBe("us-east-1_Flag");
  });

  it("uses HASH_SALT when set, without reading the secret", async () => {
    await run(dryRun, { saltOverride: SALT });
    expect(secrets.send).not.toHaveBeenCalled();
  });
});

describe("planClaims ranking", () => {
  const user = (userName: string, status: string, created: Date | undefined): PoolUser => ({
    userName,
    sub: userName,
    email: "same@example.com",
    status,
    createdAt: created,
  });

  it("gives the claim to a live account first, then a confirmed one, then the oldest, then by userName", () => {
    const now = NOW.getTime();
    const holder = (users: PoolUser[]) => planClaims(users, SALT, now).claims[0].userName;

    expect(holder([user("stale", "UNCONFIRMED", hoursAgo(100)), user("fresh", "UNCONFIRMED", hoursAgo(1))])).toBe(
      "fresh",
    );
    expect(
      holder([user("pending", "UNCONFIRMED", hoursAgo(100 * 24)), user("confirmed", "CONFIRMED", hoursAgo(1))]),
    ).toBe("confirmed");
    expect(holder([user("newer", "UNCONFIRMED", hoursAgo(1)), user("older-confirmed", "CONFIRMED", hoursAgo(2))])).toBe(
      "older-confirmed",
    );
    expect(holder([user("young", "CONFIRMED", hoursAgo(1)), user("old", "CONFIRMED", hoursAgo(2))])).toBe("old");
    expect(holder([user("b", "CONFIRMED", undefined), user("a", "CONFIRMED", undefined)])).toBe("a");
  });
});

describe("--apply", () => {
  it("writes EMAIL# and USER# in one transaction per claim, both on attribute_not_exists(pk)", async () => {
    const result = await run(apply);

    expect(writes()).toHaveLength(3);
    const emailKey = keyFor("ann@example.com");
    expect(writes()[0].input).toEqual({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: { pk: { S: `EMAIL#${emailKey}` }, userName: { S: "sub-ann" }, claimedAt: { S: NOW.toISOString() } },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: { pk: { S: "USER#sub-ann" }, emailKey: { S: emailKey }, claimedAt: { S: NOW.toISOString() } },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });
    expect(table.size).toBe(6);
    expect(result).toMatchObject({ written: 3, skipped: 0, failed: [] });
    expect(lastLine()).toBe("Sign-up email claims backfill complete written=3 skipped=0 failed=0");
  });

  it("is idempotent: a second run plans nothing to write", async () => {
    await run(apply);
    lines = [];
    dynamoCalls = [];

    const second = await run(apply);

    expect(writes()).toEqual([]);
    expect(second.statuses.every((status) => status.state === "already_claimed")).toBe(true);
    expect(second.written).toBe(0);
  });

  it("skips a claim a real sign-up wrote meanwhile (the condition keeps it)", async () => {
    const original = dynamo.send.getMockImplementation()!;
    let injected = false;
    dynamo.send.mockImplementation(async (command: FakeCommand) => {
      if (command.constructor.name === "TransactWriteItemsCommand" && !injected) {
        injected = true;
        table.set(`EMAIL#${keyFor("ann@example.com")}`, { pk: { S: "x" }, userName: { S: "racer" } });
      }
      return original(command);
    });

    const result = await run(apply);

    dynamo.send.mockImplementation(original);
    expect(result).toMatchObject({ written: 2, skipped: 1, failed: [] });
    expect(table.get(`EMAIL#${keyFor("ann@example.com")}`)?.userName).toEqual({ S: "racer" });
  });

  it("reports failed writes (status 1 in main)", async () => {
    transactError = Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });

    const result = await run(apply);

    expect(result.failed).toEqual(["sub-ann", "sub-bob", "sub-cat"]);
    expect(lastLine()).toBe("Sign-up email claims backfill complete written=0 skipped=0 failed=3");
  });
});
