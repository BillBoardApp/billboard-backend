import {
  type ClearConfig,
  type CliOptions,
  configFromEnv,
  parseArgs,
  resolveUserPoolId,
  runClear,
} from "../../scripts/clearStoredParty";

/*
 * `npm run clear:stored-party` (UX-36; project decision O1, 2026-11-12; RUNBOOK 25.2): the dry run lists the pool and
 * writes nothing; --apply refuses unless the holders are exactly --expect, deletes per user exactly the retired names
 * that user holds, and lists the pool again. Nothing it prints names a user, an email address or a value.
 */

interface Attribute {
  Name: string;
  Value: string;
}
interface PoolUser {
  Username: string;
  Attributes: Attribute[];
}
interface FakeCommand {
  constructor: { name: string };
  input: { UserPoolId?: string; Username?: string; UserAttributeNames?: string[]; PaginationToken?: string };
}

const POOL = "us-east-1_TestPool";
const config: ClearConfig = { region: "us-east-1", userPoolId: POOL, userPoolName: "BillboardUserPool" };
const dryRun: CliOptions = { help: false, apply: false, expect: null, userPoolId: null };
const apply = (expect: number): CliOptions => ({ ...dryRun, apply: true, expect });

const poolUser = (name: string, extra: Attribute[] = []): PoolUser => ({
  Username: name,
  Attributes: [
    { Name: "sub", Value: name },
    { Name: "email", Value: `${name}@example.com` },
    { Name: "custom:state", Value: "VA" },
    { Name: "custom:district", Value: "08" },
    ...extra,
  ],
});

/** An in-memory pool that honours AdminDeleteUserAttributes, paged two users at a time. */
const fakePool = (initial: PoolUser[], options: { failFor?: string; rewriteAfterDelete?: string } = {}) => {
  const users = initial.map((user) => ({ ...user, Attributes: [...user.Attributes] }));
  const calls: Array<{ name: string; input: FakeCommand["input"] }> = [];
  const send = jest.fn(async (command: FakeCommand) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "ListUsersCommand") {
      const start = Number(command.input.PaginationToken ?? 0);
      const page = users.slice(start, start + 2);
      return { Users: page, PaginationToken: start + 2 < users.length ? String(start + 2) : undefined };
    }
    if (command.constructor.name === "AdminDeleteUserAttributesCommand") {
      if (command.input.Username === options.failFor) {
        throw Object.assign(new Error(`cannot update ${command.input.Username}`), { name: "InternalErrorException" });
      }
      const user = users.find((entry) => entry.Username === command.input.Username)!;
      user.Attributes = user.Attributes.filter(
        (attribute) => !(command.input.UserAttributeNames ?? []).includes(attribute.Name),
      );
      if (command.input.Username === options.rewriteAfterDelete) {
        user.Attributes.push({ Name: "custom:politicalParty", Value: "Independent" });
      }
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  });
  return { send, calls, users };
};

const POOL_USERS = (): PoolUser[] => [
  poolUser("u-1", [{ Name: "custom:politicalParty", Value: "Independent" }]),
  poolUser("u-2"),
  poolUser("u-3", [{ Name: "custom:politicalParty", Value: "Green" }]),
  poolUser("u-4", [
    { Name: "custom:politicalParty", Value: "Libertarian" },
    { Name: "gender", Value: "Nonbinary" },
    { Name: "birthdate", Value: "1987-01-01" },
  ]),
  poolUser("u-5"),
];

const SECRETS = ["u-1", "u-2", "u-3", "u-4", "u-5", "example.com", "Independent", "Green", "Libertarian", "Nonbinary"];

describe("clear:stored-party", () => {
  describe("parseArgs", () => {
    it("is a dry run by default", () => {
      expect(parseArgs([])).toEqual(dryRun);
    });

    it("takes --apply only with --expect, and --expect only with --apply", () => {
      expect(parseArgs(["--apply", "--expect", "3"])).toEqual(apply(3));
      expect(() => parseArgs(["--apply"])).toThrow("--apply needs --expect <N>");
      expect(() => parseArgs(["--expect", "3"])).toThrow("--expect goes with --apply only");
      expect(() => parseArgs(["--apply", "--expect", "three"])).toThrow("--expect needs a whole number");
      expect(() => parseArgs(["--apply", "--expect"])).toThrow("--expect needs a value");
    });

    it("refuses unknown flags, --dry-run included", () => {
      expect(() => parseArgs(["--dry-run"])).toThrow("Unknown argument: --dry-run");
      expect(() => parseArgs(["--aply"])).toThrow("Unknown argument: --aply");
    });

    it("takes a pool and help", () => {
      expect(parseArgs(["--user-pool-id", "pool-x"])).toEqual({ ...dryRun, userPoolId: "pool-x" });
      expect(parseArgs(["--help"]).help).toBe(true);
    });

    it("reads its environment", () => {
      expect(configFromEnv({ AWS_REGION: "us-west-2", USER_POOL_ID: " pool-y " })).toEqual({
        region: "us-west-2",
        userPoolId: "pool-y",
        userPoolName: "BillboardUserPool",
      });
      expect(configFromEnv({})).toEqual({ region: "us-east-1", userPoolId: "", userPoolName: "BillboardUserPool" });
    });
  });

  it("resolves the one pool named BillboardUserPool, and refuses none or several", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ UserPools: [{ Name: "Other", Id: "p-0" }], NextToken: "n" })
      .mockResolvedValueOnce({ UserPools: [{ Name: "BillboardUserPool", Id: "p-1" }] });
    await expect(resolveUserPoolId({ send }, { ...config, userPoolId: "" })).resolves.toBe("p-1");

    const twice = jest.fn().mockResolvedValue({
      UserPools: [
        { Name: "BillboardUserPool", Id: "p-1" },
        { Name: "BillboardUserPool", Id: "p-2" },
      ],
    });
    await expect(resolveUserPoolId({ send: twice }, { ...config, userPoolId: "" })).rejects.toThrow(
      "Found 2 user pools named BillboardUserPool",
    );
  });

  it("dry run: counts the holders per attribute, writes nothing and prints counts only", async () => {
    const pool = fakePool(POOL_USERS());
    const lines: string[] = [];

    const result = await runClear({ cognito: pool, config, options: dryRun, log: (line) => lines.push(line) });

    expect(pool.calls.map((call) => call.name)).toEqual(["ListUsersCommand", "ListUsersCommand", "ListUsersCommand"]);
    expect(result).toEqual({
      exitCode: 0,
      users: 5,
      tally: { holding: 3, byAttribute: { "custom:politicalParty": 3, gender: 1, birthdate: 1 } },
      cleared: 0,
      failed: 0,
      leftAfter: null,
    });
    expect(lines[lines.length - 1]).toBe("Stored party plan: users=5 holding=3 politicalParty=3 gender=1 birthdate=1");
    for (const secret of SECRETS) expect(lines.join("\n")).not.toContain(secret);
  });

  it("--apply refuses at another count and writes nothing", async () => {
    const pool = fakePool(POOL_USERS());
    const lines: string[] = [];

    const result = await runClear({ cognito: pool, config, options: apply(2), log: (line) => lines.push(line) });

    expect(result.exitCode).toBe(2);
    expect(pool.calls.filter((call) => call.name !== "ListUsersCommand")).toEqual([]);
    expect(lines[lines.length - 1]).toBe("Refused: 3 user(s) hold a value, not --expect 2. Run the dry run again.");
  });

  it("--apply deletes exactly each holder's retired names, keeps every other attribute and checks the pool again", async () => {
    const pool = fakePool(POOL_USERS());
    const lines: string[] = [];

    const result = await runClear({ cognito: pool, config, options: apply(3), log: (line) => lines.push(line) });

    expect(
      pool.calls.filter((call) => call.name === "AdminDeleteUserAttributesCommand").map((call) => call.input),
    ).toEqual([
      { UserPoolId: POOL, Username: "u-1", UserAttributeNames: ["custom:politicalParty"] },
      { UserPoolId: POOL, Username: "u-3", UserAttributeNames: ["custom:politicalParty"] },
      { UserPoolId: POOL, Username: "u-4", UserAttributeNames: ["custom:politicalParty", "gender", "birthdate"] },
    ]);
    expect(pool.users.map((user) => user.Attributes.map((attribute) => attribute.Name))).toEqual(
      Array(5).fill(["sub", "email", "custom:state", "custom:district"]),
    );
    expect(result).toEqual(expect.objectContaining({ exitCode: 0, cleared: 3, failed: 0, leftAfter: 0 }));
    expect(lines[lines.length - 1]).toBe("Stored party clear complete cleared=3 failed=0 leftAfter=0");
    for (const secret of SECRETS) expect(lines.join("\n")).not.toContain(secret);
  });

  it("--apply with nothing held and --expect 0 deletes nothing and succeeds", async () => {
    const pool = fakePool([poolUser("u-2"), poolUser("u-5")]);

    const result = await runClear({ cognito: pool, config, options: apply(0), log: () => undefined });

    expect(result).toEqual(expect.objectContaining({ exitCode: 0, cleared: 0, leftAfter: 0 }));
    expect(pool.calls.filter((call) => call.name === "AdminDeleteUserAttributesCommand")).toEqual([]);
  });

  it("--apply exits 1 when a delete fails, after trying every holder, and names no user", async () => {
    const pool = fakePool(POOL_USERS(), { failFor: "u-3" });
    const lines: string[] = [];

    const result = await runClear({ cognito: pool, config, options: apply(3), log: (line) => lines.push(line) });

    expect(result).toEqual(expect.objectContaining({ exitCode: 1, cleared: 2, failed: 1, leftAfter: 1 }));
    expect(lines).toContain("Delete error InternalErrorException: 1");
    expect(lines[lines.length - 1]).toBe("Stored party clear complete cleared=2 failed=1 leftAfter=1");
    for (const secret of SECRETS) expect(lines.join("\n")).not.toContain(secret);
  });

  it("--apply exits 1 when a value is back by the second listing", async () => {
    const pool = fakePool(POOL_USERS(), { rewriteAfterDelete: "u-1" });

    const result = await runClear({ cognito: pool, config, options: apply(3), log: () => undefined });

    expect(result).toEqual(expect.objectContaining({ exitCode: 1, cleared: 3, failed: 0, leftAfter: 1 }));
  });

  it("uses --user-pool-id over the environment's pool", async () => {
    const pool = fakePool([poolUser("u-2")]);

    await runClear({ cognito: pool, config, options: { ...dryRun, userPoolId: "pool-z" }, log: () => undefined });

    expect(pool.calls[0].input.UserPoolId).toBe("pool-z");
  });
});
