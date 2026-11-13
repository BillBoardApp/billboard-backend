import type { AttributeValue, GetItemCommandInput, QueryCommandInput } from "@aws-sdk/client-dynamodb";

import {
  LIST_USERS_MAX_PAGES,
  SKIP_REASONS,
  THROTTLE_ATTEMPTS,
  cleanupUnconfirmedSignUps,
  unconfirmedCleanupConfigFromEnv,
  type UnconfirmedCleanupConfig,
  type UnconfirmedCleanupSummary,
} from "../handlers/cleanupOrphanedUsers/unconfirmedSignUps";
import {
  UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS,
  UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN,
} from "../shared/abuseLimits";
import { accountDeletionConfigFromEnv, type AccountDeletionContext } from "../shared/accountDeletion";
import { FakeClaimsTable, tableError } from "./fixtures/fakeClaimsTable";
import { FakeCognitoPool, cognitoError, type FakeUser, type PoolInput } from "./fixtures/fakeCognitoPool";
import { logLines } from "./logLines";

/*
 * REL-53 (feature review S10): CleanupOrphanedUsers' step that deletes sign-ups left UNCONFIRMED for more than the
 * maximum age (MAX_AGE, the default from shared/abuseLimits.ts; ages below are relative to it). Cognito is the fake pool (fixtures/fakeCognitoPool: ListUsers' status filter, AdminGetUser,
 * AdminDeleteUser), SignUpEmailClaims the in-memory claims table that honours the conditions sent
 * (fixtures/fakeClaimsTable), and the user tables a read-only fake: a write to them fails the test.
 */

type Item = Record<string, AttributeValue>;

const POOL = "us-east-1_TestPool";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
/** The default maximum age and per-run cap (shared/abuseLimits.ts). */
const MAX_AGE = UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS;
const MAX_PER_RUN = UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN;
const PROBE = "filter-probe@billboard-project.com";

const TABLE_ENV = {
  PII_TABLE_NAME: "UserPII",
  FEEDBACK_TABLE_NAME: "UserFeedback",
  PREFERENCES_TABLE_NAME: "UserPreferences",
  DEVICES_TABLE_NAME: "UserDevices",
  DEVICES_PUSH_TOKEN_INDEX_NAME: "GSIPushTokenIndex",
  WEEKLY_DIGESTS_TABLE_NAME: "UserWeeklyDigests",
  USER_POOL_ID: POOL,
  ADDRESS_CLAIMS_TABLE_NAME: "VerifiedAddressClaims",
  SIGNUP_EMAIL_CLAIMS_TABLE_NAME: "SignUpEmailClaims",
  APP_ATTEST_TABLE_NAME: "AppAttest",
};

/** The input of the commands the fake user tables answer. */
type UserTablesInput = Partial<GetItemCommandInput & QueryCommandInput>;
type UserTablesCall = { name: string; input: UserTablesInput };
/** What the user tables and the pool both read from an SDK command: its class's name and its input. */
interface FakeCommand {
  constructor: { name: string };
  input: UserTablesInput & PoolInput;
}

/** The user tables, read only: GetItem on UserPII and Query on the partition tables. */
class FakeUserTables {
  readonly pii = new Map<string, Item>();
  /** "<table>|<partition value>" to the sort values in that partition. */
  readonly partitions = new Map<string, string[]>();
  readonly calls: UserTablesCall[] = [];
  fault: ((call: UserTablesCall) => void) | undefined;

  constructor(readonly claims: FakeClaimsTable) {}

  addRows(table: string, partition: string, sortValues: string[]): void {
    this.partitions.set(`${table}|${partition}`, sortValues);
  }

  send = async (command: { constructor: { name: string }; input: UserTablesInput }): Promise<unknown> => {
    const call: UserTablesCall = { name: command.constructor.name, input: command.input };
    if (call.input?.TableName === this.claims.tableName) return this.claims.send(command);
    this.calls.push(call);
    this.fault?.(call);
    const table = call.input.TableName!;
    if (call.name === "GetItemCommand" && table === "UserPII") return { Item: this.pii.get(call.input.Key!.userId.S!) };
    if (call.name === "GetItemCommand" && table === "VerifiedAddressClaims") {
      const key = `${table}|${call.input.Key!.claimKey.S}`;
      return this.partitions.has(key) ? { Item: { claimKey: call.input.Key!.claimKey } } : {};
    }
    if (call.name === "QueryCommand" && !call.input.IndexName) {
      const partition = call.input.ExpressionAttributeValues![":pk"].S!;
      const values = this.partitions.get(`${table}|${partition}`) ?? [];
      return {
        Items: values.map((value) => ({
          userId: { S: partition },
          pk: { S: partition },
          billId: { S: value },
          preference: { S: value },
          deviceId: { S: value },
          publishedAt: { S: value },
          sk: { S: value },
        })),
      };
    }
    throw new Error(`Unexpected ${call.name} on ${table}`);
  };
}

let pool: FakeCognitoPool;
let claims: FakeClaimsTable;
let tables: FakeUserTables;
let sleeps: number[];
let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  pool = new FakeCognitoPool(POOL, "app-client", () => NOW);
  claims = new FakeClaimsTable();
  tables = new FakeUserTables(claims);
  sleeps = [];
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const deletion = (): AccountDeletionContext => ({
  config: accountDeletionConfigFromEnv(TABLE_ENV),
  db: { send: tables.send } as AccountDeletionContext["db"],
  sns: { send: async () => ({}) } as AccountDeletionContext["sns"],
  cognito: { send: pool.send } as AccountDeletionContext["cognito"],
});

const configFor = (env: Record<string, string | undefined> = {}): UnconfirmedCleanupConfig =>
  unconfirmedCleanupConfigFromEnv({ SIGNUP_FILTER_CHECK_ADDRESS: PROBE, ...env });

const run = (env: Record<string, string | undefined> = {}): Promise<UnconfirmedCleanupSummary> =>
  cleanupUnconfirmedSignUps(configFor(env), {
    cognito: { send: pool.send } as AccountDeletionContext["cognito"],
    deletion: deletion(),
    userPoolId: POOL,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });

let nextId = 0;
/** A self-service sign-up `hoursOld` hours ago, with the email claim PreSignUpCheck wrote for it. */
const signUp = (
  email: string,
  hoursOld: number,
  overrides: Partial<FakeUser> = {},
  options: { claim?: boolean } = {},
): FakeUser => {
  nextId += 1;
  const sub = `6c1e8a52-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
  const user = pool.seed({
    sub,
    email,
    status: "UNCONFIRMED",
    createdAt: new Date(NOW - hoursOld * HOUR),
    ...overrides,
  });
  if (options.claim !== false) {
    const emailKey = `key-${sub}`;
    claims.put({ pk: { S: `EMAIL#${emailKey}` }, userName: { S: user.username }, claimedAt: { S: "2026-10-26" } });
    claims.put({ pk: { S: `USER#${user.username}` }, emailKey: { S: emailKey }, claimedAt: { S: "2026-10-26" } });
  }
  return user;
};

const exists = (user: FakeUser) => pool.users.has(user.username);
/** The sub the app-data cases seed rows for (set inside each case). */
const SUB_OF = { current: "" };
const claimKeysOf = (user: FakeUser) => claims.keys().filter((key) => key.endsWith(user.sub));

/** Metric values from the EMF lines in BillBoard/Accounts, keyed "Name" or "Name|Reason". */
const metrics = (): Record<string, number> => {
  const values: Record<string, number> = {};
  for (const line of logLines(logSpy)) {
    const block = line._aws?.CloudWatchMetrics?.[0];
    if (!block || block.Namespace !== "BillBoard/Accounts") continue;
    for (const { Name } of block.Metrics) values[line.Reason ? `${Name}|${line.Reason}` : Name] = line[Name] as number;
  }
  return values;
};

const allOutput = (): string =>
  [logSpy, warnSpy, errorSpy].flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args))).join("\n");

describe("the switch: UNCONFIRMED_SIGNUP_CLEANUP_MODE", () => {
  it.each([undefined, "", "off", "OFF"])("%p is off: no call, no metric", async (mode) => {
    const user = signUp("stranded@example.com", MAX_AGE + 24);

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: mode });

    expect(summary).toEqual({ mode: "off", maxAgeHours: MAX_AGE, maxPerRun: MAX_PER_RUN });
    expect(pool.calls).toEqual([]);
    expect(tables.calls).toEqual([]);
    expect(metrics()).toEqual({});
    expect(exists(user)).toBe(true);
  });

  it.each(["true", "enabled", "deletee", "dry run please"])(
    "an unrecognised value (%p) is off, and the summary names it",
    async (mode) => {
      signUp("stranded@example.com", MAX_AGE + 24);

      const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: mode });

      expect(summary).toMatchObject({ mode: "off", ignoredModeValue: mode });
      expect(pool.calls).toEqual([]);
    },
  );

  it("reads the mode in any case, and the limits from the environment", () => {
    expect(
      configFor({
        UNCONFIRMED_SIGNUP_CLEANUP_MODE: " Delete ",
        UNCONFIRMED_SIGNUP_MAX_AGE_HOURS: "72",
        UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN: "10",
      }),
    ).toMatchObject({ mode: "delete", maxAgeHours: 72, maxPerRun: 10, probeAddress: { address: PROBE } });
    expect(configFor({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "DRY_RUN" }).mode).toBe("dry_run");
  });

  it.each([
    ["UNCONFIRMED_SIGNUP_MAX_AGE_HOURS", "12", "maxAgeHours", MAX_AGE],
    ["UNCONFIRMED_SIGNUP_MAX_AGE_HOURS", "soon", "maxAgeHours", MAX_AGE],
    ["UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN", "-1", "maxPerRun", MAX_PER_RUN],
    ["UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN", "2.5", "maxPerRun", MAX_PER_RUN],
  ] as const)("ignores %s=%p (never below a code's 24-hour life)", (name, value, field, fallback) => {
    expect(configFor({ [name]: value })[field]).toBe(fallback);
    expect(warnSpy).toHaveBeenCalledWith(`Ignoring invalid ${name}`, { value, fallback });
  });
});

describe("delete", () => {
  it("deletes a sign-up unconfirmed for more than the maximum age, with its email claim, and keeps younger ones", async () => {
    const stranded = signUp("stranded@example.com", MAX_AGE + 1);
    const young = signUp("young@example.com", MAX_AGE - 1);
    const confirmed = signUp("confirmed@example.com", MAX_AGE + 452, { status: "CONFIRMED" });

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(stranded)).toBe(false);
    expect(claimKeysOf(stranded)).toEqual([]);
    expect(exists(young)).toBe(true);
    expect(claimKeysOf(young)).toHaveLength(2);
    expect(exists(confirmed)).toBe(true);
    expect(summary).toMatchObject({
      mode: "delete",
      listed: 2,
      pending: 1,
      expired: 1,
      deleted: 1,
      emailClaimItems: 2,
      deferred: 0,
      capReached: false,
      errors: 0,
      keptWithAppData: [],
      oldestExpiredHours: MAX_AGE + 1,
    });
    expect(summary).not.toHaveProperty("wouldDelete");
    // ListUsers asks for UNCONFIRMED users only, with the sub and email and nothing else.
    expect(pool.callsNamed("ListUsersCommand").map((call) => call.input)).toEqual([
      {
        UserPoolId: POOL,
        Filter: 'cognito:user_status = "UNCONFIRMED"',
        AttributesToGet: ["sub", "email"],
        Limit: 60,
        PaginationToken: undefined,
      },
    ]);
    expect(pool.callsNamed("AdminDeleteUserCommand").map((call) => call.input.Username)).toEqual([stranded.sub]);
    expect(metrics()).toMatchObject({
      UnconfirmedSignUpsDeleted: 1,
      UnconfirmedSignUpsExpired: 1,
      UnconfirmedSignUpsPending: 1,
      UnconfirmedSignUpCleanupErrors: 0,
      UnconfirmedSignUpCleanupCapReached: 0,
    });
  });

  it("checks for app data before the guard, and the guard before the claim, and the claim before the user", async () => {
    const stranded = signUp("stranded@example.com", MAX_AGE + 24);
    const order: string[] = [];
    const record = (send: (command: FakeCommand) => Promise<unknown>) => async (command: FakeCommand) => {
      const name = command.constructor.name;
      if (name !== "ListUsersCommand") order.push(`${command.input.TableName ?? "cognito"}:${name}`);
      return send(command);
    };
    const context = deletion();
    context.db = { send: record(tables.send) } as AccountDeletionContext["db"];

    await cleanupUnconfirmedSignUps(configFor({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" }), {
      cognito: { send: record(pool.send) } as AccountDeletionContext["cognito"],
      deletion: context,
      userPoolId: POOL,
      now: () => NOW,
    });

    expect(exists(stranded)).toBe(false);
    const guard = order.indexOf("cognito:AdminGetUserCommand");
    expect(order.slice(0, guard)).toEqual(
      expect.arrayContaining(["UserPII:GetItemCommand", "UserFeedback:QueryCommand", "AppAttest:QueryCommand"]),
    );
    expect(order.slice(guard)).toEqual([
      "cognito:AdminGetUserCommand",
      "SignUpEmailClaims:GetItemCommand",
      "SignUpEmailClaims:DeleteItemCommand",
      "SignUpEmailClaims:DeleteItemCommand",
      "cognito:AdminDeleteUserCommand",
    ]);
  });

  it("keeps an EMAIL# item another account took over, and deletes the user's own USER# item", async () => {
    const stranded = signUp("stranded@example.com", MAX_AGE + 24);
    claims.put({ pk: { S: `EMAIL#key-${stranded.sub}` }, userName: { S: "someone-else" } });

    await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(stranded)).toBe(false);
    expect(claims.get(`USER#${stranded.sub}`)).toBeUndefined();
    expect(claims.get(`EMAIL#key-${stranded.sub}`)?.userName).toEqual({ S: "someone-else" });
  });

  it("deletes the EMAIL# item when the user is one of its holders, not the latest (a retry of its address named another)", async () => {
    const stranded = signUp("stranded@example.com", MAX_AGE + 24);
    claims.put({
      pk: { S: `EMAIL#key-${stranded.sub}` },
      userName: { S: "refused-retry" },
      claimedAt: { S: "2026-10-26T00:00:02.000Z" },
      addressKey: { S: "address-key" },
      holders: {
        M: {
          [stranded.username]: { S: "2026-10-26T00:00:00.000Z" },
          "refused-retry": { S: "2026-10-26T00:00:02.000Z" },
        },
      },
      revision: { S: "rev-1" },
    });

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(stranded)).toBe(false);
    expect(summary).toMatchObject({ deleted: 1, emailClaimItems: 2 });
    expect(claimKeysOf(stranded)).toEqual([]);
  });

  it("deletes a sign-up without an email claim (one made while the trigger was detached)", async () => {
    const stranded = signUp("stranded@example.com", MAX_AGE + 24, {}, { claim: false });

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(stranded)).toBe(false);
    expect(summary).toMatchObject({ deleted: 1, emailClaimItems: 0 });
  });

  it("honours UNCONFIRMED_SIGNUP_MAX_AGE_HOURS", async () => {
    const day3 = signUp("three@example.com", 73);
    const day2 = signUp("two@example.com", 60);

    await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete", UNCONFIRMED_SIGNUP_MAX_AGE_HOURS: "72" });

    expect(exists(day3)).toBe(false);
    expect(exists(day2)).toBe(true);
  });

  it("is idempotent: a second run finds nothing more, and finishes a deletion an earlier run left halfway", async () => {
    const first = signUp("first@example.com", MAX_AGE + 24);
    const second = signUp("second@example.com", MAX_AGE + 24);
    pool.faults.beforeDelete = (username) => {
      if (username === second.username) throw cognitoError("InternalErrorException");
    };

    const run1 = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });
    expect(run1).toMatchObject({ deleted: 1, errors: 1, errorNames: ["InternalErrorException"] });
    expect(exists(second)).toBe(true);
    expect(claimKeysOf(second)).toEqual([]);

    pool.faults = {};
    const run2 = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });
    expect(run2).toMatchObject({ listed: 1, deleted: 1, emailClaimItems: 0, errors: 0 });
    expect(exists(first) || exists(second)).toBe(false);

    const run3 = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });
    expect(run3).toMatchObject({ listed: 0, expired: 0, deleted: 0, errors: 0 });
  });
});

describe("never a confirmed user, a probe, an admin-created or a disabled user", () => {
  it("keeps the sign-up filter check's probes and the project's own addresses, with their reasons", async () => {
    const base = signUp(PROBE, MAX_AGE + 152);
    const variant = signUp("filter-probe+r20261026abcd@billboard-project.com", MAX_AGE + 152);
    const projectAddress = signUp("admin@billboard-project.com", MAX_AGE + 152);

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect([base, variant, projectAddress].map(exists)).toEqual([true, true, true]);
    expect(claims.keys()).toHaveLength(6);
    expect(summary.skipped).toMatchObject({ probe: 2, projectDomain: 1 });
    expect(summary).toMatchObject({ expired: 0, pending: 0, deleted: 0 });
    expect(pool.callsNamed("AdminDeleteUserCommand")).toEqual([]);
    expect(metrics()).toMatchObject({
      "UnconfirmedSignUpsSkipped|probe": 2,
      "UnconfirmedSignUpsSkipped|projectDomain": 1,
    });
  });

  it("keeps the probes when the check address is not set: they are on the project's domain", async () => {
    const base = signUp(PROBE, MAX_AGE + 152);

    const summary = await cleanupUnconfirmedSignUps(
      unconfirmedCleanupConfigFromEnv({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" }),
      {
        cognito: { send: pool.send } as AccountDeletionContext["cognito"],
        deletion: deletion(),
        userPoolId: POOL,
        now: () => NOW,
      },
    );

    expect(exists(base)).toBe(true);
    expect(summary.skipped).toMatchObject({ probe: 0, projectDomain: 1 });
  });

  it("does not rely on ListUsers' status filter: confirmed and admin-created users it returns anyway are kept", async () => {
    pool.ignoreStatusFilter = true;
    const confirmed = signUp("confirmed@example.com", MAX_AGE + 452, { status: "CONFIRMED" });
    const admin = signUp("tester@example.com", MAX_AGE + 452, { status: "FORCE_CHANGE_PASSWORD" });
    const stranded = signUp("stranded@example.com", MAX_AGE + 24);

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(confirmed)).toBe(true);
    expect(exists(admin)).toBe(true);
    expect(claimKeysOf(confirmed)).toHaveLength(2);
    expect(exists(stranded)).toBe(false);
    expect(summary.skipped).toMatchObject({ notUnconfirmed: 2 });
    expect(pool.callsNamed("AdminDeleteUserCommand").map((call) => call.input.Username)).toEqual([stranded.sub]);
  });

  it("keeps a disabled sign-up (an operator may have disabled it on purpose)", async () => {
    const disabled = signUp("disabled@example.com", MAX_AGE + 24, { enabled: false });

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(disabled)).toBe(true);
    expect(summary.skipped).toMatchObject({ disabled: 1 });
  });

  it("the guard: a sign-up confirmed after the listing is never deleted, and its claim stays", async () => {
    const racer = signUp("racer@example.com", MAX_AGE + 24);
    pool.faults.beforeGet = (username) => {
      if (username === racer.username) racer.status = "CONFIRMED";
    };

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(racer)).toBe(true);
    expect(claimKeysOf(racer)).toHaveLength(2);
    expect(summary).toMatchObject({ expired: 1, deleted: 0, errors: 0 });
    expect(summary.skipped).toMatchObject({ notUnconfirmed: 1 });
    expect(pool.callsNamed("AdminDeleteUserCommand")).toEqual([]);
    expect(claims.callsNamed("DeleteItemCommand")).toEqual([]);
  });

  it("the guard: a sign-up disabled after the listing is kept; one already gone counts as gone", async () => {
    const disabledLater = signUp("later@example.com", MAX_AGE + 24);
    const gone = signUp("gone@example.com", MAX_AGE + 24);
    pool.faults.beforeGet = (username) => {
      if (username === disabledLater.username) disabledLater.enabled = false;
      if (username === gone.username) pool.users.delete(gone.username);
    };

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(disabledLater)).toBe(true);
    expect(summary.skipped).toMatchObject({ disabled: 1, gone: 1 });
    expect(summary).toMatchObject({ deleted: 0, errors: 0 });
  });

  it.each([
    ["a UserPII row", () => tables.pii.set(SUB_OF.current, { userId: { S: SUB_OF.current } })],
    ["a vote", () => tables.addRows("UserFeedback", SUB_OF.current, ["hr-1-119"])],
    ["a preference", () => tables.addRows("UserPreferences", SUB_OF.current, ["topic#health"])],
    ["a device", () => tables.addRows("UserDevices", SUB_OF.current, ["device-1"])],
    ["a weekly digest", () => tables.addRows("UserWeeklyDigests", SUB_OF.current, ["2026-10-25"])],
    ["App Attest bindings", () => tables.addRows("AppAttest", `USER#${SUB_OF.current}`, ["KEY#abc"])],
  ])("keeps a sign-up that holds app data (%s), and names its sub", async (_label, seed) => {
    const odd = signUp("odd@example.com", MAX_AGE + 24);
    SUB_OF.current = odd.sub;
    seed();

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(odd)).toBe(true);
    expect(claimKeysOf(odd)).toHaveLength(2);
    expect(summary.skipped).toMatchObject({ hasAppData: 1 });
    expect(summary.keptWithAppData).toEqual([odd.sub]);
    expect(pool.callsNamed("AdminGetUserCommand")).toEqual([]);
  });
});

describe("dry_run", () => {
  it("counts what a deletion would remove and writes nothing", async () => {
    const stranded = signUp("stranded@example.com", MAX_AGE + 24);
    signUp("young@example.com", 3);

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "dry_run" });

    expect(exists(stranded)).toBe(true);
    expect(claimKeysOf(stranded)).toHaveLength(2);
    expect(summary).toMatchObject({ mode: "dry_run", expired: 1, wouldDelete: 1, pending: 1, emailClaimItems: 2 });
    expect(summary).not.toHaveProperty("deleted");
    expect(pool.callsNamed("AdminDeleteUserCommand")).toEqual([]);
    expect(claims.calls.map((call) => call.name).filter((name) => name !== "GetItemCommand")).toEqual([]);
    expect(
      tables.calls.map((call) => call.name).every((name) => ["GetItemCommand", "QueryCommand"].includes(name)),
    ).toBe(true);
    expect(metrics()).toMatchObject({ UnconfirmedSignUpsDeleted: 0, UnconfirmedSignUpsExpired: 1 });
  });
});

describe("the per-run cap, paging and throttling", () => {
  it("deletes at most UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN, oldest first, and reports the cap", async () => {
    const oldest = signUp("a@example.com", MAX_AGE + 252);
    const middle = signUp("b@example.com", MAX_AGE + 152);
    const newest = signUp("c@example.com", MAX_AGE + 52);

    const summary = await run({
      UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete",
      UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN: "2",
    });

    expect([oldest, middle, newest].map(exists)).toEqual([false, false, true]);
    expect(summary).toMatchObject({
      expired: 3,
      deleted: 2,
      deferred: 1,
      capReached: true,
      oldestExpiredHours: MAX_AGE + 252,
    });
    expect(metrics()).toMatchObject({ UnconfirmedSignUpCleanupCapReached: 1 });
  });

  it("pages through ListUsers", async () => {
    for (let i = 0; i < 130; i += 1) signUp(`user${i}@example.com`, i < 65 ? MAX_AGE + 24 : 1, {}, { claim: false });

    const summary = await run({
      UNCONFIRMED_SIGNUP_CLEANUP_MODE: "dry_run",
      UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN: "200",
    });

    expect(pool.callsNamed("ListUsersCommand")).toHaveLength(3);
    expect(summary).toMatchObject({ listed: 130, expired: 65, pending: 65, wouldDelete: 65, listingTruncated: false });
  });

  it(`stops listing after ${LIST_USERS_MAX_PAGES} pages and says so`, async () => {
    let calls = 0;
    const endless = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name !== "ListUsersCommand") throw new Error("unexpected");
        calls += 1;
        return { Users: [], PaginationToken: `page-${calls}` };
      },
    };

    const summary = await cleanupUnconfirmedSignUps(configFor({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" }), {
      cognito: endless as AccountDeletionContext["cognito"],
      deletion: deletion(),
      userPoolId: POOL,
      now: () => NOW,
    });

    expect(calls).toBe(LIST_USERS_MAX_PAGES);
    expect(summary).toMatchObject({ listingTruncated: true, capReached: true });
  });

  it("retries a throttled call with jittered backoff and carries on", async () => {
    const stranded = signUp("stranded@example.com", MAX_AGE + 24);
    let throttles = 2;
    pool.faults.beforeDelete = () => {
      if (throttles-- > 0) throw cognitoError("TooManyRequestsException");
    };

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(stranded)).toBe(false);
    expect(summary).toMatchObject({ deleted: 1, errors: 0, throttleRetries: 2, stoppedByThrottling: false });
    // Full jitter at random 0.5: [0, 250] then [0, 500].
    expect(sleeps).toEqual([125, 250]);
  });

  it("still throttled after the retries: stops, counts one error and leaves the rest for the next run", async () => {
    const first = signUp("first@example.com", MAX_AGE + 42);
    const second = signUp("second@example.com", MAX_AGE + 32);
    const third = signUp("third@example.com", MAX_AGE + 22);
    pool.faults.beforeGet = (username) => {
      if (username === second.username) throw cognitoError("TooManyRequestsException");
    };

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect([first, second, third].map(exists)).toEqual([false, true, true]);
    expect(summary).toMatchObject({
      deleted: 1,
      errors: 1,
      errorNames: ["TooManyRequestsException"],
      stoppedByThrottling: true,
      deferred: 1,
      throttleRetries: THROTTLE_ATTEMPTS - 1,
      capReached: false,
    });
    expect(metrics()).toMatchObject({ UnconfirmedSignUpCleanupErrors: 1 });
  });

  it("a throttled DynamoDB read is retried too", async () => {
    const stranded = signUp("stranded@example.com", MAX_AGE + 24);
    let throttles = 1;
    tables.fault = () => {
      if (throttles-- > 0) throw tableError("ProvisionedThroughputExceededException");
    };

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(stranded)).toBe(false);
    expect(summary).toMatchObject({ deleted: 1, throttleRetries: 1, errors: 0 });
  });
});

describe("errors never stop the cleanup's run", () => {
  it("an error on one sign-up is counted, and the others are still deleted", async () => {
    const broken = signUp("broken@example.com", MAX_AGE + 42);
    const fine = signUp("fine@example.com", MAX_AGE + 32);
    tables.fault = (call) => {
      if (call.name === "GetItemCommand" && call.input.Key!.userId?.S === broken.sub) {
        throw tableError("AccessDeniedException");
      }
    };

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    expect(exists(broken)).toBe(true);
    expect(exists(fine)).toBe(false);
    expect(summary).toMatchObject({ deleted: 1, errors: 1, errorNames: ["AccessDeniedException"] });
    expect(metrics()).toMatchObject({ UnconfirmedSignUpCleanupErrors: 1 });
  });

  it("a ListUsers failure is one error, with nothing deleted", async () => {
    const denied = {
      send: async () => {
        throw cognitoError("NotAuthorizedException");
      },
    };

    const summary = await cleanupUnconfirmedSignUps(configFor({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" }), {
      cognito: denied as AccountDeletionContext["cognito"],
      deletion: deletion(),
      userPoolId: POOL,
      now: () => NOW,
    });

    expect(summary).toMatchObject({ listed: 0, deleted: 0, errors: 1, errorNames: ["NotAuthorizedException"] });
    expect(metrics()).toMatchObject({ UnconfirmedSignUpCleanupErrors: 1 });
  });
});

describe("output", () => {
  it("emits every skip reason each run (0 included), one line per Reason, and the counts without dimensions", async () => {
    await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    const lines = logLines(logSpy).filter((line) => line._aws);
    const counts = lines.find((line) => "UnconfirmedSignUpsDeleted" in line)!;
    expect(counts._aws!.CloudWatchMetrics[0]).toMatchObject({ Namespace: "BillBoard/Accounts", Dimensions: [[]] });
    const reasons = lines.filter((line) => "UnconfirmedSignUpsSkipped" in line);
    expect(reasons.map((line) => line.Reason)).toEqual([...SKIP_REASONS]);
    for (const line of reasons) {
      expect(line._aws!.CloudWatchMetrics[0]).toMatchObject({
        Namespace: "BillBoard/Accounts",
        Dimensions: [["Reason"]],
      });
      expect(line.UnconfirmedSignUpsSkipped).toBe(0);
    }
  });

  it("never logs or returns an address, and names a sub only for a user kept with app data", async () => {
    const stranded = signUp("stranded.person@example.com", MAX_AGE + 24);
    signUp("young.person@example.com", 2);

    const summary = await run({ UNCONFIRMED_SIGNUP_CLEANUP_MODE: "delete" });

    const text = `${JSON.stringify(summary)}\n${allOutput()}`;
    expect(text).not.toMatch(/person|example\.com|@/);
    expect(text).not.toContain(stranded.sub);
  });
});
