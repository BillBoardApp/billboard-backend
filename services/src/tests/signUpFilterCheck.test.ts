import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PreSignUpTriggerEvent } from "aws-lambda";

import type { CheckReport } from "../handlers/preSignUp";

import { emailKeyFor } from "../handlers/preSignUp/emailPolicy";
import { PENDING_CLAIM_WINDOW_MS, UNCONFIRMED_CLAIM_LIFETIME_MS } from "../shared/abuseLimits";
import {
  LEFTOVER_MIN_AGE_MS,
  Tally,
  Verdict,
  removeProbeSubject,
  type CheckConfig,
  type CheckDeps,
  type Context,
} from "../handlers/signUpFilterCheck/common";
import { generatePassword, makeRunTag, runCheck, runSweep, type CheckResult } from "../handlers/signUpFilterCheck/run";
import {
  DISPOSABLE_EMAIL_MESSAGE,
  EMAIL_VARIANT_MESSAGE,
  RUN_TAG_PATTERN,
  fromProbeRecordItem,
  parseEmailAddress,
  parseSignUpFilterCheckAddress,
  toProbeRecordItem,
} from "../shared/signUpFilter";
import { applyTestEnv } from "./fixtures/env";
import { FakeClaimsTable, tableError, type Item, type TableInput } from "./fixtures/fakeClaimsTable";
import {
  FakeCognitoPool,
  cognitoError,
  meetsPasswordPolicy,
  type FakeUser,
  type PoolInput,
} from "./fixtures/fakeCognitoPool";
import { logLines, type LogLine } from "./logLines";

/*
 * SignUpFilterCheck (CB-07, RUNBOOK 14.12) against the real filter, offline.
 *
 * FakeCognitoPool is shaped like BillboardUserPool (email usernames, case-sensitive) and runs the real
 * PreSignUpCheck handler as its PreSignUp trigger; FakeClaimsTable is SignUpEmailClaims in memory and honours
 * the exact condition expressions sent. The check and the filter share both, as they share the real pool and
 * table, so every result below is the real filter's answer to the real check's sign-ups. The filter is loaded
 * in its own module registry (its own logger, like its own Lambda), and its log lines carry
 * fn=PreSignUpCheck, the check's fn=SignUpFilterCheck. After every test, every console line is scanned: the
 * check's never hold an address, a password or a sub; the filter's never hold an address.
 */

/** A command as the fakes below receive it: the SDK's constructor name and its input. */
interface FakeCommand<Input> {
  constructor: { name: string };
  input: Input;
}

const mockPoolSend = jest.fn();
const mockTableSend = jest.fn();
const mockSecretsSend = jest.fn();
const mockCognitoClients: unknown[] = [];
const mockDynamoClients: unknown[] = [];

jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn((options: unknown) => {
    mockDynamoClients.push(options);
    return { send: (...args: unknown[]) => mockTableSend(...args) };
  }),
}));
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  ...jest.requireActual("@aws-sdk/client-cognito-identity-provider"),
  CognitoIdentityProviderClient: jest.fn((options: unknown) => {
    mockCognitoClients.push(options);
    return { send: (...args: unknown[]) => mockPoolSend(...args) };
  }),
}));
jest.mock("@aws-sdk/client-secrets-manager", () => ({
  ...jest.requireActual("@aws-sdk/client-secrets-manager"),
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
}));

const POOL = "us-east-1_TestPool";
const CLIENT = "app-client-id";
const TABLE = "SignUpEmailClaims";
const SALT = "salt-for-tests";
const CHECK_ADDRESS = "filter-probe@billboard-project.com";
const PROBE_TOKEN_SECRET = "arn:aws:secretsmanager:us-east-1:123456789012:secret:Billboard/SignUpProbeToken-AbCdEf";
const PROBE_TOKEN = "probe-token-for-tests-0123456789abcdefghijklmnopqrstuv";
const NOW = new Date("2026-10-17T11:30:00.000Z").getTime();
const MINUTE = 60_000;

/** Both functions' environment, as UserAPIServiceStack sets it (the switch on). */
const ENV = {
  AWS_LAMBDA_FUNCTION_NAME: "SignUpFilterCheck",
  // PreSignUpCheck
  SIGNUP_FILTER_MODE: "watch",
  SIGNUP_EMAIL_CLAIMS_TABLE_NAME: TABLE,
  HASH_SALT: SALT,
  HASH_SALT_SECRET_ARN: undefined,
  SIGNUP_FILTER_CHECK_ADDRESS: CHECK_ADDRESS,
  SIGNUP_PROBE_TOKEN_SECRET_ARN: PROBE_TOKEN_SECRET,
  APP_ATTEST_MODE: undefined,
  APP_ATTEST_TABLE_NAME: undefined,
  DEVICE_CHECK_MODE: undefined,
  DEVICE_CHECK_SECRET_NAME: undefined,
  // SignUpFilterCheck
  SIGNUP_FILTER_CHECK_ENABLED: "true",
  SIGNUP_FILTER_CHECK_EXPECTED_MODE: "watch",
  USER_POOL_ID: POOL,
  USER_POOL_CLIENT_ID: CLIENT,
};

let pool: FakeCognitoPool;
let table: FakeClaimsTable;
let restoreEnv: (() => void) | undefined;
let realUsers: FakeUser[];
let realItems: Map<string, Item>;
let filterEnv: Record<string, string | undefined>;

const setEnv = (overrides: Record<string, string | undefined> = {}): void => {
  restoreEnv?.();
  restoreEnv = applyTestEnv({ ...ENV, ...overrides });
};

/** Loads the real PreSignUpCheck in its own module registry and attaches it to the pool as its trigger. */
const attachFilter = (wrap?: (event: PreSignUpTriggerEvent, run: () => Promise<unknown>) => Promise<unknown>) => {
  let handler: ((event: PreSignUpTriggerEvent, context?: unknown) => Promise<unknown>) | undefined;
  jest.isolateModules(() => {
    handler = require("../handlers/preSignUp").handler;
  });
  let requests = 0;
  pool.trigger = async (event) => {
    const run = async () => {
      const restore = applyTestEnv({ AWS_LAMBDA_FUNCTION_NAME: "PreSignUpCheck", ...filterEnv });
      try {
        requests += 1;
        return await handler!(event, {
          awsRequestId: `filter-request-${requests}`,
          getRemainingTimeInMillis: () => 5_000,
        });
      } finally {
        restore();
      }
    };
    return wrap ? wrap(event, run) : run();
  };
};

const config = (overrides: Partial<CheckConfig> = {}): CheckConfig => ({
  check: parseSignUpFilterCheckAddress(CHECK_ADDRESS)!,
  expectedMode: "watch",
  userPoolId: POOL,
  clientId: CLIENT,
  tableName: TABLE,
  probeToken: PROBE_TOKEN,
  ...overrides,
});

const deps = (overrides: Partial<CheckDeps> = {}): CheckDeps => ({
  cognito: pool as unknown as CheckDeps["cognito"],
  signUp: pool as unknown as CheckDeps["signUp"],
  db: table as unknown as CheckDeps["db"],
  now: () => Date.now(),
  randomBytes,
  sleep: async () => undefined,
  timeLeftMs: () => 55_000,
  ...overrides,
});

const keyOf = (address: string): string => emailKeyFor(parseEmailAddress(address)!.base, SALT);

/** Two real accounts and their claims: they must come through every run untouched. */
const seedRealAccounts = (): void => {
  const longAgo = new Date(NOW - 30 * 24 * 60 * MINUTE);
  realUsers = ["admin@billboard-project.com", "jane@example.com"].map((email) =>
    pool.seed({ email, status: "CONFIRMED", createdAt: longAgo }),
  );
  for (const user of realUsers) {
    const emailKey = keyOf(user.email);
    table.put({
      pk: { S: `EMAIL#${emailKey}` },
      userName: { S: user.username },
      claimedAt: { S: longAgo.toISOString() },
    });
    table.put({
      pk: { S: `USER#${user.username}` },
      emailKey: { S: emailKey },
      claimedAt: { S: longAgo.toISOString() },
    });
  }
  realItems = new Map([...table.items].map(([key, item]) => [key, structuredClone(item)]));
};

/** Only the real accounts and their claim items are left, unchanged. */
const expectOnlyRealData = (): void => {
  expect(pool.usernames()).toEqual(realUsers.map((user) => user.username).sort());
  expect(table.keys()).toEqual([...realItems.keys()].sort());
  for (const [key, item] of realItems) expect(table.get(key)).toEqual(item);
};

const metricLines = (namespace: string, name: string): LogLine[] =>
  logLines(console.log).filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === namespace && name in line);
const integrityMetric = (name: string): LogLine[] => metricLines("BillBoard/AccountIntegrity", name);
const checkMetric = (name: string): LogLine[] => metricLines("BillBoard/SignUpFilterCheck", name);

const signUpsTo = (address: string) => pool.signUpResults.filter((result) => result.address === address);
const variantAddress = (result: CheckResult) => `filter-probe+${result.runTag}@billboard-project.com`;

/** A probe sign-up by someone else (a stranger, or an earlier run that crashed), through the real filter. */
const strangerSignUp = async (
  address: string,
  clientMetadata?: Record<string, string>,
): Promise<string | undefined> => {
  try {
    const response = (await pool.send(
      new (jest.requireActual("@aws-sdk/client-cognito-identity-provider").SignUpCommand)({
        ClientId: CLIENT,
        Username: address,
        Password: "Stranger-Passw0rd!",
        UserAttributes: [{ Name: "email", Value: address }],
        ...(clientMetadata ? { ClientMetadata: clientMetadata } : {}),
      }),
    )) as { UserSub: string };
    return response.UserSub;
  } catch {
    return undefined;
  }
};

/** A sign-up an earlier check run made (with the probe token, INF-15) and left behind when it crashed. */
const leftoverSignUp = (address: string): Promise<string | undefined> =>
  strangerSignUp(address, { billboardSignUpProbe: PROBE_TOKEN });

const advance = (ms: number): void => {
  jest.setSystemTime(Date.now() + ms);
};

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate"] });
  pool = new FakeCognitoPool(POOL, CLIENT, () => Date.now());
  table = new FakeClaimsTable(TABLE);
  filterEnv = {};
  mockPoolSend.mockReset().mockImplementation(pool.send);
  mockTableSend.mockReset().mockImplementation(table.send);
  // The probe token is the only secret either function reads here (the filter's salt comes from HASH_SALT).
  mockSecretsSend.mockReset().mockImplementation(async (command: { input?: { SecretId?: string } }) => {
    if (command.input?.SecretId === PROBE_TOKEN_SECRET) return { SecretString: PROBE_TOKEN };
    throw new Error("no such secret in these tests");
  });
  mockCognitoClients.length = 0;
  mockDynamoClients.length = 0;
  setEnv();
  seedRealAccounts();
  attachFilter();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Privacy (CB-07): the check's lines never hold an address, a password or a sub; the filter's no address.
  const lines = [console.log, console.warn, console.error].flatMap((spy) =>
    (spy as jest.Mock).mock.calls.map((args) => args.map(String).join(" ")),
  );
  const secrets = [...pool.passwords, ...pool.subs];
  for (const line of lines) {
    // INF-15: neither function ever logs the probe token.
    expect({ line, token: line.includes(PROBE_TOKEN) }).toEqual({ line, token: false });
    let fn: unknown;
    try {
      fn = JSON.parse(line).fn;
    } catch {
      fn = undefined;
    }
    expect({ line, hasAt: line.includes("@") }).toEqual({ line, hasAt: false });
    if (fn !== "PreSignUpCheck") {
      expect({ line, secrets: secrets.filter((secret) => line.includes(secret)) }).toEqual({ line, secrets: [] });
    }
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
  restoreEnv?.();
  restoreEnv = undefined;
});

describe("a full run through the real filter", () => {
  it("watch: the base is allowed and claimed, the +tag is a probe hit, and nothing is left", async () => {
    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({
      action: "run",
      outcome: "pass",
      stage: "done",
      expectedMode: "watch",
      observedMode: "watch",
      signUps: 2,
      swept: 0,
      remaining: 0,
      refused: 0,
    });
    expect(result.reason).toBeUndefined();
    expect(result.runTag).toMatch(RUN_TAG_PATTERN);
    expect(pool.signUpResults.map((entry) => entry.address)).toEqual([CHECK_ADDRESS, variantAddress(result)]);
    expect(pool.signUpResults.every((entry) => entry.sub && !entry.error)).toBe(true);
    // The probe's hit is counted apart from real hits, and nothing else fired.
    expect(integrityMetric("SignUpProbeHit")).toEqual([
      expect.objectContaining({ SignUpProbeHit: 1, probe: "variant" }),
    ]);
    expect(integrityMetric("SignUpFilterHit")).toEqual([]);
    expect(integrityMetric("SignUpRejected")).toEqual([]);
    expect(integrityMetric("SignUpProbeRejected")).toEqual([]);
    expect(integrityMetric("PreSignUpCheckError")).toEqual([]);
    // Every line of the filter's two invocations carries the probe key.
    const filterLines = logLines(console.log).filter((line) => line.fn === "PreSignUpCheck");
    expect(filterLines.filter((line) => line.message === "Pre-sign-up checks").map((line) => line.probe)).toEqual([
      "base",
      "variant",
    ]);
    expect(filterLines.every((line) => line.probe === "base" || line.probe === "variant")).toBe(true);
    // Each user and item it created is gone: 2 accounts, USER# and EMAIL#, and both probe records.
    expect(result).toMatchObject({ usersDeleted: 2, claimItemsDeleted: 2, recordsDeleted: 2 });
    expectOnlyRealData();
  });

  it("enforce: the +tag is refused with exactly the filter's message, and only the base account is created", async () => {
    filterEnv = { SIGNUP_FILTER_MODE: "enforce" };

    const result = await runCheck(config({ expectedMode: "enforce" }), deps());

    expect(result).toMatchObject({ outcome: "pass", observedMode: "enforce", expectedMode: "enforce", signUps: 1 });
    const [base, variant] = pool.signUpResults;
    expect(base.sub).toBeDefined();
    expect(variant.error).toEqual({
      name: "UserLambdaValidationException",
      message: `PreSignUp failed with error ${EMAIL_VARIANT_MESSAGE}.`,
    });
    expect(variant.error!.message.endsWith("password..")).toBe(true);
    // PreSignUpCheck recorded the refusal for this run's tag before it threw.
    const records = table
      .callsNamed("PutItemCommand")
      .map((call) => fromProbeRecordItem(call.input.Item))
      .filter((record) => record?.kind === "variant");
    expect(records).toEqual([
      expect.objectContaining({
        outcome: "rejected",
        rejectedBy: "emailBase",
        reason: "email_variant_exists",
        mode: "enforce",
        tag: result.runTag,
      }),
    ]);
    expect(integrityMetric("SignUpProbeRejected")).toEqual([expect.objectContaining({ SignUpProbeRejected: 1 })]);
    expect(integrityMetric("SignUpRejected")).toEqual([]);
    expect(integrityMetric("SignUpFilterHit")).toEqual([]);
    expect(pool.find(variantAddress(result))).toBeUndefined();
    expectOnlyRealData();
  });

  it("the scheduled handler runs it from the environment and writes one result line and one summary", async () => {
    let handler: (event: unknown, context?: unknown) => Promise<unknown>;
    jest.isolateModules(() => {
      handler = require("../handlers/signUpFilterCheck").handler;
    });

    const response = await handler!(
      { "detail-type": "Scheduled Event", source: "aws.events" },
      { awsRequestId: "check-1", getRemainingTimeInMillis: () => 59_000 },
    );

    expect(response).toEqual({ status: "pass" });
    expect(checkMetric("SignUpFilterCheckPassed")).toEqual([
      expect.objectContaining({
        SignUpFilterCheckPassed: 1,
        SignUpFilterCheckFailed: 0,
        SignUpFilterCheckInconclusive: 0,
        SignUpFilterCheckSwept: 0,
        SignUpFilterCheckSignUps: 2,
        action: "run",
        outcome: "pass",
        expectedMode: "watch",
        observedMode: "watch",
        runTag: expect.stringMatching(RUN_TAG_PATTERN),
      }),
    ]);
    const [line] = checkMetric("SignUpFilterCheckPassed");
    expect(line._aws!.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(logLines(console.log).filter((entry) => entry.message === "Sign-up filter check")).toEqual([
      expect.objectContaining({ outcome: "pass", signUps: 2, remaining: 0, fn: "SignUpFilterCheck" }),
    ]);
    // SignUp goes through its own client, with no SDK retries.
    expect(mockCognitoClients).toEqual(expect.arrayContaining([{ maxAttempts: 1 }]));
    expectOnlyRealData();
  });
});

describe("the filter misbehaving (each case still cleans up completely)", () => {
  it("an emailBase error (no hash salt) fails open in the filter: base_check_error, PreSignUpCheckError shared", async () => {
    filterEnv = { HASH_SALT: undefined };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "base_check_error", stage: "base", signUps: 1 });
    expect(integrityMetric("PreSignUpCheckError")).toEqual([
      expect.objectContaining({ PreSignUpCheckError: 1, check: "emailBase", probe: "base" }),
    ]);
    expectOnlyRealData();
  });

  it("a failing claim write (the transaction) is an emailBase error too: base_check_error", async () => {
    table.fault = (call) => {
      if (call.name === "TransactWriteItemsCommand") throw tableError("ProvisionedThroughputExceededException");
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "base_check_error" });
    table.fault = undefined;
    expectOnlyRealData();
  });

  it("a detached trigger: the account exists with no record and no claim, filter_silent", async () => {
    pool.trigger = null;

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "filter_silent", stage: "base", signUps: 1 });
    expect(pool.signUpResults).toHaveLength(1);
    expectOnlyRealData();
  });

  it("a claim the filter says it wrote but did not: base_claim_missing", async () => {
    table.fault = (call) => call.name === "TransactWriteItemsCommand";

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "base_claim_missing", stage: "base", signUps: 1 });
    table.fault = undefined;
    expectOnlyRealData();
  });

  it("a filter that does not know the probe address: probe_record_missing, and no +tag sign-up (no real hit)", async () => {
    filterEnv = { SIGNUP_FILTER_CHECK_ADDRESS: "other-check@billboard-project.com" };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({
      outcome: "inconclusive",
      reason: "probe_record_missing",
      stage: "base",
      signUps: 1,
    });
    expect(pool.signUpResults.map((entry) => entry.address)).toEqual([CHECK_ADDRESS]);
    expect(integrityMetric("SignUpFilterHit")).toEqual([]);
    expectOnlyRealData();
  });

  it("a +tag the filter misses: variant_not_detected", async () => {
    // The base claim disappears just before the +tag sign-up, so the filter claims the +tag instead.
    pool.faults.beforeSignUp = (address) => {
      if (address.includes("+")) {
        for (const key of table.keys()) if (key.startsWith("EMAIL#") && !realItems.has(key)) table.items.delete(key);
      }
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "variant_not_detected", stage: "variant", signUps: 2 });
    expect(integrityMetric("SignUpProbeHit")).toEqual([]);
    expectOnlyRealData();
  });

  it("an emailBase error on the +tag fails open: variant_check_error, never a pass", async () => {
    let gets = 0;
    pool.faults.beforeSignUp = (address) => {
      if (!address.includes("+")) return;
      table.fault = (call) => {
        if (call.name === "GetItemCommand" && call.input.Key!.pk.S!.startsWith("EMAIL#") && gets++ === 0) {
          throw tableError("InternalServerError");
        }
      };
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "variant_check_error", stage: "variant" });
    table.fault = undefined;
    expectOnlyRealData();
  });

  it("enforce, but the +tag is created: variant_not_refused, and the +tag account is removed", async () => {
    filterEnv = { SIGNUP_FILTER_MODE: "enforce" };
    pool.faults.beforeSignUp = (address) => {
      if (address.includes("+")) {
        for (const key of table.keys()) if (key.startsWith("EMAIL#") && !realItems.has(key)) table.items.delete(key);
      }
    };

    const result = await runCheck(config({ expectedMode: "enforce" }), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "variant_not_refused", stage: "variant", signUps: 2 });
    expectOnlyRealData();
  });

  it("enforce, refused with the disposable message instead: variant_wrong_refusal", async () => {
    filterEnv = { SIGNUP_FILTER_MODE: "enforce" };
    attachFilter(async (event, run) => {
      if (String(event.request.userAttributes.email).includes("+")) throw new Error(DISPOSABLE_EMAIL_MESSAGE);
      return run();
    });

    const result = await runCheck(config({ expectedMode: "enforce" }), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "variant_wrong_refusal", stage: "variant", signUps: 1 });
    expectOnlyRealData();
  });

  it("watch, but the base is refused (the project domain treated as disposable): base_rejected", async () => {
    attachFilter(async () => {
      throw new Error(DISPOSABLE_EMAIL_MESSAGE);
    });

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "base_rejected", stage: "base", signUps: 0 });
    expectOnlyRealData();
  });

  it.each([
    ["enforce", "watch"],
    ["watch", "enforce"],
  ] as const)(
    "expected %s while the filter runs %s: inconclusive mode_mismatch, judged by the filter's mode",
    async (expected, actual) => {
      filterEnv = { SIGNUP_FILTER_MODE: actual };

      const result = await runCheck(config({ expectedMode: expected }), deps());

      expect(result).toMatchObject({
        outcome: "inconclusive",
        reason: "mode_mismatch",
        expectedMode: expected,
        observedMode: actual,
        signUps: actual === "watch" ? 2 : 1,
      });
      expectOnlyRealData();
    },
  );

  it("App Attest sign-up enforce refuses the unattested base: blocked_by_app_attest, released claim removed", async () => {
    filterEnv = { APP_ATTEST_MODE: "enforce", APP_ATTEST_TABLE_NAME: "AppAttest" };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({
      outcome: "inconclusive",
      reason: "blocked_by_app_attest",
      stage: "base",
      signUps: 0,
    });
    expect(pool.signUpResults[0].error).toEqual({
      name: "UserLambdaValidationException",
      message: "PreSignUp failed with error APP_UPDATE_REQUIRED.",
    });
    // The filter claimed, then released the claim (an EMAIL# item naming no account) and kept USER#<refused>:
    // the check found both through PROBE#base and removed them.
    expect(table.callsNamed("PutItemCommand").some((call) => call.input.Item!.releasedAt)).toBe(true);
    expectOnlyRealData();
  });
});

describe("SignUp errors", () => {
  it("UsernameExistsException: leftover_exists, never retried, nothing deleted", async () => {
    pool.faults.beforeSignUp = () => {
      throw cognitoError("UsernameExistsException");
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "leftover_exists", stage: "base", signUps: 0 });
    expect(signUpsTo(CHECK_ADDRESS)).toHaveLength(1);
    expect(pool.callsNamed("AdminDeleteUserCommand")).toEqual([]);
    expectOnlyRealData();
  });

  it.each(["TooManyRequestsException", "LimitExceededException"])("%s: cognito_limit, never retried", async (name) => {
    pool.faults.beforeSignUp = () => {
      throw cognitoError(name);
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "cognito_limit", signUps: 0 });
    expect(pool.callsNamed("SignUpCommand")).toHaveLength(1);
    expectOnlyRealData();
  });

  it("CodeDeliveryFailureException after Cognito created the account: cognito_limit, and this run's account is removed", async () => {
    pool.faults.afterSignUp = () => {
      throw cognitoError("CodeDeliveryFailureException");
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "cognito_limit", stage: "base" });
    expect(pool.callsNamed("SignUpCommand")).toHaveLength(1);
    expect(result.usersDeleted).toBe(1);
    expectOnlyRealData();
  });

  it("InvalidPasswordException: fail password_policy", async () => {
    pool.faults.beforeSignUp = () => {
      throw cognitoError("InvalidPasswordException");
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "password_policy", signUps: 0 });
    expectOnlyRealData();
  });

  it("an unknown SignUp error: fail signup_error, and whatever the trigger wrote is found and removed", async () => {
    pool.faults.afterSignUp = () => {
      throw cognitoError("InternalErrorException");
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "signup_error", stage: "base" });
    expect(pool.callsNamed("SignUpCommand")).toHaveLength(1);
    expectOnlyRealData();
  });
});

describe("the SignUp request", () => {
  it("is the app's: its client, the address as username, only the email attribute, and the probe token", async () => {
    await runCheck(config(), deps());

    const inputs = pool.callsNamed("SignUpCommand").map((call) => call.input);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(Object.keys(input).sort()).toEqual([
        "ClientId",
        "ClientMetadata",
        "Password",
        "UserAttributes",
        "Username",
      ]);
      expect(input.ClientId).toBe(CLIENT);
      expect(input.UserAttributes).toEqual([{ Name: "email", Value: input.Username }]);
      // INF-15: the token is the only metadata; no App Attest marker or app version.
      expect(input.ClientMetadata).toEqual({ billboardSignUpProbe: PROBE_TOKEN });
    }
    expect(inputs[0].Username).toBe(CHECK_ADDRESS);
    expect(inputs[1].Username).toMatch(/^filter-probe\+r20261017[0-9a-z]{4}@billboard-project\.com$/);
    expect(new Set(inputs.map((input) => input.Password)).size).toBe(2);
  });

  it("generates passwords that always meet the pool policy, from any random bytes", () => {
    for (let seed = 0; seed < 3_000; seed += 1) {
      const fill = (size: number) =>
        Buffer.from(Array.from({ length: size }, (_, index) => (seed * 31 + index * seed) % 256));
      const password = generatePassword(seed % 2 === 0 ? fill : randomBytes);
      expect(password).toHaveLength(24);
      expect(meetsPasswordPolicy(password)).toBe(true);
    }
  });

  it("makes run tags of the date and 4 base36 characters", () => {
    expect(makeRunTag(NOW, () => Buffer.from([0, 35, 36, 255]))).toBe("r20261017" + "0z03");
    for (let index = 0; index < 200; index += 1) expect(makeRunTag(NOW, randomBytes)).toMatch(RUN_TAG_PATTERN);
  });
});

describe("the sweep", () => {
  /** Leaves what a crashed run leaves: a base and a +tag account with the base claim and both records. */
  const leaveCrashedRun = async (): Promise<string[]> => {
    const base = await leftoverSignUp(CHECK_ADDRESS);
    const variant = await leftoverSignUp("filter-probe+r20261016abcd@billboard-project.com");
    return [base!, variant!];
  };

  it("removes a crashed run's accounts older than 15 minutes, claims first, then passes", async () => {
    const leftovers = await leaveCrashedRun();
    expect(table.keys().filter((key) => key.startsWith("PROBE#"))).toEqual(["PROBE#base", "PROBE#variant"]);
    advance(20 * MINUTE);

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "pass", signUps: 2 });
    // 2 accounts, the base claim's 2 items, the 2 records.
    expect(result.swept).toBe(6);
    for (const sub of leftovers) expect(pool.find(sub)).toBeUndefined();
    expectOnlyRealData();
  });

  it("deletes a leftover's claim items before its account", async () => {
    const [base] = await leaveCrashedRun();
    advance(20 * MINUTE);
    const events: string[] = [];
    mockPoolSend.mockImplementation((command: FakeCommand<PoolInput>, options: unknown) => {
      if (command.constructor.name === "AdminDeleteUserCommand")
        events.push(`delete-account:${command.input.Username}`);
      return pool.send(command, options);
    });
    mockTableSend.mockImplementation((command: FakeCommand<TableInput>, options: unknown) => {
      if (command.constructor.name === "DeleteItemCommand") events.push(`delete-item:${command.input.Key!.pk.S}`);
      return table.send(command, options);
    });

    await runSweep(config(), {
      ...deps(),
      cognito: { send: mockPoolSend },
      db: { send: mockTableSend },
    });

    const userItem = events.indexOf(`delete-item:USER#${base}`);
    const account = events.indexOf(`delete-account:${base}`);
    expect(userItem).toBeGreaterThanOrEqual(0);
    expect(account).toBeGreaterThan(userItem);
    expect(events.filter((event) => event.startsWith("delete-item:EMAIL#"))).toHaveLength(1);
    expect(events.indexOf(events.find((event) => event.startsWith("delete-item:EMAIL#"))!)).toBeLessThan(account);
  });

  it("an account younger than 15 minutes means another run: busy, nothing deleted, no SignUp", async () => {
    await leftoverSignUp(CHECK_ADDRESS);
    const before = pool.usernames();
    advance(5 * MINUTE);

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "busy", stage: "sweep", signUps: 0, swept: 0 });
    expect(pool.usernames()).toEqual(before);
    expect(pool.signUpResults).toHaveLength(1);
  });

  it("a CONFIRMED probe account: fail probe_address_confirmed, nothing deleted, no SignUp", async () => {
    pool.seed({ email: CHECK_ADDRESS, status: "CONFIRMED", createdAt: new Date(NOW - 3 * 24 * 60 * MINUTE) });
    const before = pool.usernames();

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "probe_address_confirmed", stage: "sweep", signUps: 0 });
    expect(pool.usernames()).toEqual(before);
    expect(pool.callsNamed("AdminDeleteUserCommand")).toEqual([]);
  });

  it("6 leftovers: fail too_many_leftovers, the 5 oldest removed, and the next sweep removes the last", async () => {
    const seeded = Array.from({ length: 6 }, (_, index) =>
      pool.seed({
        email: `filter-probe+r2026101${index}aaaa@billboard-project.com`,
        status: "UNCONFIRMED",
        createdAt: new Date(NOW - (60 - index) * MINUTE),
      }),
    );

    const first = await runCheck(config(), deps());

    expect(first).toMatchObject({
      outcome: "fail",
      reason: "too_many_leftovers",
      stage: "sweep",
      signUps: 0,
      swept: 5,
    });
    expect(pool.usernames()).toEqual([...realUsers.map((user) => user.username), seeded[5].username].sort());

    const second = await runSweep(config(), deps());
    expect(second).toMatchObject({ action: "sweep", outcome: "pass", swept: 1 });
    expectOnlyRealData();
  });

  it("removes a stale record whose account is gone, with the claim items it names", async () => {
    // A sign-up the filter handled but Cognito never created: the trigger wrote a claim and a record.
    pool.faults.afterSignUp = (_address, user) => {
      pool.users.delete(user.username);
    };
    await leftoverSignUp(CHECK_ADDRESS);
    pool.faults = {};
    expect(table.keys().filter((key) => !realItems.has(key))).toHaveLength(3);
    advance(2 * MINUTE);

    const result = await runSweep(config(), deps());

    expect(result).toMatchObject({ outcome: "pass", swept: 3, recordsDeleted: 1, claimItemsDeleted: 2 });
    expectOnlyRealData();
  });

  it("a record under a minute old whose account does not exist yet is a sign-up in progress: busy", async () => {
    pool.faults.afterSignUp = (_address, user) => {
      pool.users.delete(user.username);
    };
    await leftoverSignUp(CHECK_ADDRESS);
    pool.faults = {};

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "busy", signUps: 0 });
  });

  it("{action: sweep} sweeps and signs nobody up; its line has Failed and Swept, never Passed", async () => {
    await leaveCrashedRun();
    advance(20 * MINUTE);
    let handler: (event: unknown) => Promise<unknown>;
    jest.isolateModules(() => {
      handler = require("../handlers/signUpFilterCheck").handler;
    });
    const signUpsBefore = pool.signUpResults.length;

    expect(await handler!({ action: "sweep" })).toEqual({ status: "pass" });

    expect(pool.signUpResults).toHaveLength(signUpsBefore);
    expect(checkMetric("SignUpFilterCheckSwept")).toEqual([
      expect.objectContaining({ SignUpFilterCheckSwept: 6, SignUpFilterCheckFailed: 0, action: "sweep" }),
    ]);
    expect(checkMetric("SignUpFilterCheckPassed")).toEqual([]);
    expectOnlyRealData();
  });

  it("finds mixed-case, empty-tag and trailing-dot probe accounts (each its own user here) and removes them", async () => {
    // The pool is case-sensitive and this ListUsers filter too: the mixed-case one is found only through
    // the PROBE#base record its sign-up wrote.
    const mixed = await leftoverSignUp("Filter-Probe@billboard-project.com");
    const emptyTag = await leftoverSignUp("filter-probe+@billboard-project.com");
    const trailingDot = pool.seed({
      email: "filter-probe@billboard-project.com.",
      status: "UNCONFIRMED",
      createdAt: new Date(NOW),
    });
    expect([mixed, emptyTag].every(Boolean)).toBe(true);
    advance(20 * MINUTE);

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "pass", signUps: 2 });
    for (const username of [mixed!, emptyTag!, trailingDot.username]) expect(pool.find(username)).toBeUndefined();
    expectOnlyRealData();
  });

  it("a probe account holding the base that no sweep source finds: removed at once, leftover_holder, then a pass", async () => {
    // Two strangers: the first holds the base address; the second (another case) overwrites PROBE#base, so
    // only the second is findable, and ListUsers misses both.
    const holder = await leftoverSignUp("Filter-Probe@billboard-project.com");
    advance(MINUTE);
    const second = await leftoverSignUp("FILTER-PROBE@billboard-project.com");
    advance(20 * MINUTE);

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "leftover_holder", stage: "base" });
    expect(pool.find(holder!)).toBeUndefined();
    expect(pool.find(second!)).toBeUndefined();
    expectOnlyRealData();

    advance(24 * 60 * MINUTE);
    expect(await runCheck(config(), deps())).toMatchObject({ outcome: "pass", swept: 0 });
    expectOnlyRealData();
  });
});

describe("who holds the base address (only a probe account can)", () => {
  const HOUR = 60 * MINUTE;
  /** A probe sign-up whose PROBE#base record is then lost, so no sweep source can find its account. */
  const hiddenHolder = async (address = "Filter-Probe@billboard-project.com"): Promise<string> => {
    const sub = await strangerSignUp(address);
    table.items.delete("PROBE#base");
    return sub!;
  };

  it("an abandoned probe account (past the claim lifetime) is taken over, and the take-over removes it and its USER# item", async () => {
    const holder = await hiddenHolder();
    advance(UNCONFIRMED_CLAIM_LIFETIME_MS + HOUR);

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "pass", signUps: 2, swept: 2 });
    expect(pool.find(holder)).toBeUndefined();
    expectOnlyRealData();
  });

  it("a claim of a sign-up Cognito never finished on another address (letter case differs), inside PENDING_CLAIM_WINDOW_MS: base_claim_pending; a later run takes it over and cleans up", async () => {
    pool.faults.afterSignUp = (_address, user) => {
      pool.users.delete(user.username);
    };
    await hiddenHolder();
    pool.faults = {};
    advance(2 * MINUTE);

    const first = await runCheck(config(), deps());

    expect(first).toMatchObject({ outcome: "inconclusive", reason: "base_claim_pending", stage: "base" });
    advance(PENDING_CLAIM_WINDOW_MS);
    const second = await runCheck(config(), deps());
    expect(second).toMatchObject({ outcome: "pass", swept: 1 });
    expectOnlyRealData();
  });

  it("a claim of a sign-up Cognito never finished on the check address itself is a retry: the run passes (claim retried)", async () => {
    pool.faults.afterSignUp = (_address, user) => {
      pool.users.delete(user.username);
    };
    const unfinished = await hiddenHolder(CHECK_ADDRESS);
    pool.faults = {};
    advance(2 * MINUTE);
    (console.log as jest.Mock).mockClear();

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "pass", signUps: 2, remaining: 0 });
    const emailBase = logLines(console.log)
      .filter((line) => line.message === "Pre-sign-up checks" && line.probe === "base")
      .map((line) => (line.checks as CheckReport[]).find((entry) => entry.check === "emailBase"));
    expect(emailBase).toEqual([expect.objectContaining({ result: "allow", claim: "retried", claimHolders: 2 })]);
    // The cleanup removed the EMAIL# item (the run's account was one of its holders) and with it the unfinished
    // sign-up's USER# item, which the deleted item named as its other holder.
    expect(table.get(`USER#${unfinished}`)).toBeUndefined();
    expectOnlyRealData();
  });

  it("a CONFIRMED probe account no sweep source finds: probe_address_confirmed, and it is left alone", async () => {
    const confirmed = pool.seed({
      email: "Filter-Probe@billboard-project.com",
      status: "CONFIRMED",
      createdAt: new Date(NOW - 3 * 24 * HOUR),
    });
    const emailKey = keyOf(CHECK_ADDRESS);
    table.put({
      pk: { S: `EMAIL#${emailKey}` },
      userName: { S: confirmed.username },
      claimedAt: { S: new Date(NOW).toISOString() },
    });

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "probe_address_confirmed", stage: "base" });
    expect(pool.find(confirmed.username)).toBeDefined();
    expect(table.get(`EMAIL#${emailKey}`)?.userName).toEqual({ S: confirmed.username });
  });

  it("a hit on a holder the filter should have taken over (past the claim lifetime): base_rejected, a filter fault", async () => {
    const holder = await hiddenHolder();
    advance(UNCONFIRMED_CLAIM_LIFETIME_MS + HOUR);
    // The filter's own AdminGetUser is told the holder is new; the check reads the truth.
    mockPoolSend.mockImplementation(async (command: FakeCommand<PoolInput>, options: unknown) => {
      const response = (await pool.send(command, options)) as Record<string, unknown>;
      return command.constructor.name === "AdminGetUserCommand"
        ? { ...response, UserCreateDate: new Date(Date.now()) }
        : response;
    });

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "base_rejected", stage: "base", signUps: 1 });
    expect(pool.find(holder)).toBeDefined();
  });

  it("enforce, the base refused because a young probe account holds it: busy, and that account is left alone", async () => {
    filterEnv = { SIGNUP_FILTER_MODE: "enforce" };
    const holder = await hiddenHolder();
    advance(5 * MINUTE);

    const result = await runCheck(config({ expectedMode: "enforce" }), deps());

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "busy", stage: "base", signUps: 0 });
    expect(pool.signUpResults.at(-1)?.error?.message).toBe(`PreSignUp failed with error ${EMAIL_VARIANT_MESSAGE}.`);
    expect(pool.find(holder)).toBeDefined();
    expect(table.get("PROBE#base")).toBeUndefined();
  });

  it("enforce, the base refused because an old leftover holds it: removed at once, leftover_holder", async () => {
    filterEnv = { SIGNUP_FILTER_MODE: "enforce" };
    const holder = await hiddenHolder();
    advance(HOUR);

    const result = await runCheck(config({ expectedMode: "enforce" }), deps());

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "leftover_holder", signUps: 0 });
    expect(pool.find(holder)).toBeUndefined();
    expectOnlyRealData();
  });
});

describe("more ways a run cannot tell", () => {
  const failProbeRecordWrite = (kind: string) => {
    table.fault = (call) => {
      if (call.name === "PutItemCommand" && call.input.Item!.pk.S === `PROBE#${kind}`) {
        throw tableError("ProvisionedThroughputExceededException");
      }
    };
  };

  it.each(["watch", "enforce"] as const)(
    "%s: no +tag record (its write failed): probe_record_missing",
    async (mode) => {
      filterEnv = { SIGNUP_FILTER_MODE: mode };
      failProbeRecordWrite("variant");

      const result = await runCheck(config({ expectedMode: mode }), deps());

      expect(result).toMatchObject({ outcome: "inconclusive", reason: "probe_record_missing", stage: "variant" });
      table.fault = undefined;
      expectOnlyRealData();
    },
  );

  it("a refusal that is not Cognito's trigger wrapper: signup_error", async () => {
    pool.faults.beforeSignUp = () => {
      throw cognitoError("UserLambdaValidationException", "Something else went wrong.");
    };

    expect(await runCheck(config(), deps())).toMatchObject({ outcome: "fail", reason: "signup_error", signUps: 0 });
    expectOnlyRealData();
  });

  it("the sweep alone reports an unexpected exception as internal_error", async () => {
    const failing = {
      send: (command: FakeCommand<PoolInput>, options: unknown) =>
        command.constructor.name === "ListUsersCommand"
          ? Promise.reject(cognitoError("InternalErrorException"))
          : pool.send(command, options),
    };

    const result = await runSweep(config(), deps({ cognito: failing as unknown as CheckDeps["cognito"] }));

    expect(result).toMatchObject({
      action: "sweep",
      outcome: "fail",
      reason: "internal_error",
      errorName: "InternalErrorException",
    });
  });

  it("a read failing while it checks that nothing is left: cleanup_incomplete", async () => {
    let cleaning = false;
    pool.faults.beforeDelete = () => {
      cleaning = true;
    };
    pool.faults.beforeGet = () => {
      if (cleaning && pool.callsNamed("AdminDeleteUserCommand").length === 2)
        throw cognitoError("InternalErrorException");
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "cleanup_incomplete", stage: "cleanup" });
    expect(result.remaining).toBeGreaterThan(0);
    pool.faults = {};
    expectOnlyRealData();
  });
});

describe("delete safety", () => {
  const LOOK_ALIKES = [
    "filter-prober@billboard-project.com",
    "filter-probe@billboard-project.com.evil.example",
    "filter-probe@other.example",
    "filter-probe-2@billboard-project.com",
    "xfilter-probe@billboard-project.com",
  ];

  it("never deletes, or even looks up, look-alike or real accounts", async () => {
    const lookAlikes = LOOK_ALIKES.map((email) =>
      pool.seed({ email, status: "UNCONFIRMED", createdAt: new Date(NOW - 3 * 24 * 60 * MINUTE) }),
    );

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "pass", swept: 0 });
    for (const user of [...lookAlikes, ...realUsers]) {
      expect(pool.find(user.username)).toBeDefined();
      const touched = pool.calls.filter(
        (call) =>
          ["AdminGetUserCommand", "AdminDeleteUserCommand"].includes(call.name) &&
          call.input.Username === user.username,
      );
      expect({ email: user.email, touched }).toEqual({ email: user.email, touched: [] });
    }
  });

  describe("the guarded delete (removeProbeSubject)", () => {
    const context = (): Context => ({ config: config(), deps: deps(), verdict: new Verdict(), tally: new Tally() });

    it.each([
      ["a real account (email not a probe address)", () => realUsers[0].username],
      [
        "a probe address that is CONFIRMED",
        () =>
          pool.seed({ email: CHECK_ADDRESS, status: "CONFIRMED", createdAt: new Date(NOW - 3 * 24 * 60 * MINUTE) })
            .username,
      ],
      [
        "a probe account whose Username is not its sub",
        () =>
          pool.seed({
            username: "not-the-sub",
            email: CHECK_ADDRESS,
            status: "UNCONFIRMED",
            createdAt: new Date(NOW - 60 * MINUTE),
          }).username,
      ],
    ])("refuses %s and touches none of its items", async (_label, subjectOf) => {
      const sub = subjectOf();
      table.put({ pk: { S: `USER#${sub}` }, emailKey: { S: "k" }, claimedAt: { S: new Date(NOW).toISOString() } });
      const ctx = context();

      expect(await removeProbeSubject(ctx, { sub, kind: "base", deleteRecord: true })).toEqual({ status: "refused" });

      expect(pool.find(sub)).toBeDefined();
      expect(table.get(`USER#${sub}`)).toBeDefined();
      expect(pool.callsNamed("AdminDeleteUserCommand")).toEqual([]);
      expect(table.callsNamed("DeleteItemCommand")).toEqual([]);
    });

    it("refuses an account created outside the subject's time bounds", async () => {
      const user = pool.seed({ email: CHECK_ADDRESS, status: "UNCONFIRMED", createdAt: new Date(NOW - 2 * MINUTE) });

      const ctx = context();
      expect(await removeProbeSubject(ctx, { sub: user.username, kind: "base", createdAtLeast: NOW - MINUTE })).toEqual(
        {
          status: "refused",
        },
      );
      expect(
        await removeProbeSubject(ctx, { sub: user.username, kind: "base", createdAtMost: NOW - LEFTOVER_MIN_AGE_MS }),
      ).toEqual({ status: "refused" });
      expect(pool.find(user.username)).toBeDefined();
    });
  });
});

describe("crashes and cleanup", () => {
  it("AdminDeleteUser failing: cleanup_incomplete; the claims went first, the account and its record stay; a later run sweeps them", async () => {
    pool.faults.beforeDelete = (username) => {
      if (pool.find(username)?.email === CHECK_ADDRESS) throw cognitoError("InternalErrorException");
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "cleanup_incomplete", stage: "cleanup" });
    expect(result.remaining).toBeGreaterThan(0);
    const left = [...pool.users.values()].filter((user) => user.email === CHECK_ADDRESS);
    expect(left).toHaveLength(1);
    expect(table.get(`USER#${left[0].username}`)).toBeUndefined();
    expect(table.keys().filter((key) => !realItems.has(key))).toEqual(["PROBE#base"]);

    pool.faults = {};
    advance(20 * MINUTE);
    const next = await runCheck(config(), deps());
    expect(next).toMatchObject({ outcome: "pass", swept: 2 });
    expectOnlyRealData();
  });

  it("a claim delete failing stops that subject's chain: the account and PROBE#base stay for the next run", async () => {
    table.fault = (call) => {
      if (call.name === "DeleteItemCommand" && call.input.Key!.pk.S!.startsWith("EMAIL#")) {
        throw tableError("ProvisionedThroughputExceededException");
      }
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "cleanup_incomplete" });
    const left = [...pool.users.values()].filter((user) => user.email === CHECK_ADDRESS);
    expect(left).toHaveLength(1);
    expect(table.get("PROBE#base")).toBeDefined();
    expect(table.get(`USER#${left[0].username}`)).toBeDefined();

    table.fault = undefined;
    advance(20 * MINUTE);
    expect(await runCheck(config(), deps())).toMatchObject({ outcome: "pass" });
    expectOnlyRealData();
  });

  it("less than 20 s left after the base: the +tag step is skipped, deadline, and cleanup still runs", async () => {
    // Before the base step, then before the +tag step.
    const left = [55_000, 10_000];
    const result = await runCheck(config(), deps({ timeLeftMs: () => left.shift() ?? 10_000 }));

    expect(result).toMatchObject({ outcome: "inconclusive", reason: "deadline", stage: "variant", signUps: 1 });
    expectOnlyRealData();
  });

  it("an unexpected exception is reported as internal_error with its stage, after cleanup", async () => {
    let thrown = false;
    table.fault = (call) => {
      if (
        !thrown &&
        call.name === "GetItemCommand" &&
        call.input.Key!.pk.S! === "PROBE#base" &&
        pool.signUpResults.length > 0
      ) {
        thrown = true;
        throw tableError("InternalServerError");
      }
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({
      outcome: "fail",
      reason: "internal_error",
      stage: "base",
      errorName: "InternalServerError",
    });
    table.fault = undefined;
    expectOnlyRealData();
  });

  it.each([
    ["with", false],
    ["even without", true],
  ])(
    "interleaved runs while ListUsers lags: the second sees the first's account (%s its record) and stays out",
    async (_label, dropRecord) => {
      pool.listUsersLagMs = 10 * MINUTE;
      let second: CheckResult | undefined;
      pool.faults.beforeSignUp = async (address) => {
        if (!address.includes("+") || second) return;
        // Without PROBE#base only AdminGetUser on the exact address (strongly consistent) can see the account.
        if (dropRecord) table.items.delete("PROBE#base");
        second = await runCheck(config(), deps());
      };

      const first = await runCheck(config(), deps());

      expect(first).toMatchObject({ outcome: "pass", signUps: 2 });
      expect(second).toMatchObject({ outcome: "inconclusive", reason: "busy", signUps: 0 });
      expect(pool.callsNamed("SignUpCommand")).toHaveLength(2);
      expectOnlyRealData();
    },
  );

  /*
   * Review finding (overlapping runs): a second run that passes its sweep while the first run's base sign-up is
   * still inside PreSignUpCheck (claim written, no PROBE#base and no account yet). Reserved concurrency 1 keeps
   * this from happening in production; this pins that neither run adopts what the other's sign-up made. Both
   * sign up the same exact address, so the filter lets the second through as a retry, and Cognito, which
   * checks the address again once the trigger returns, creates only one account. The runs are stepped in turn:
   * 1. A's trigger writes the claim; B starts, sweeps (nothing to see), and signs up the base address. B's trigger
   *    finds A's pending claim on the same address: retried (holders A and B), and PROBE#base names B.
   * 2. A's trigger writes its own PROBE#base over B's, and Cognito creates A's account.
   * 3. Cognito refuses B's sign-up (UsernameExistsException): B deletes nothing and reports leftover_exists.
   * 4. A finds the claim naming it among its holders, goes on to its +tag step (a hit: A is live) and passes.
   */
  it("enforce, a run that starts during another's base sign-up never takes that run's account or claim", async () => {
    filterEnv = { SIGNUP_FILTER_MODE: "enforce" };
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { open, opened };
    };
    const bTriggered = gate();
    const aCreated = gate();
    let second: Promise<CheckResult> | undefined;
    let triggers = 0;

    attachFilter(async (_event, run) => {
      triggers += 1;
      const isB = triggers === 2;
      try {
        return await run();
      } finally {
        if (isB) {
          bTriggered.open();
          await aCreated.opened;
        }
      }
    });
    const aSignUp = {
      send: async (command: FakeCommand<PoolInput>, options?: unknown) => {
        const response = await pool.send(command, options);
        if (command.input.Username === CHECK_ADDRESS && second) {
          aCreated.open();
          await second;
        }
        return response;
      },
    };
    // Only the filter's own calls go through mockTableSend (the check's go to the table directly).
    mockTableSend.mockImplementation(async (command: FakeCommand<TableInput>, options: unknown) => {
      const response = await table.send(command, options);
      if (command.constructor.name === "TransactWriteItemsCommand" && !second) {
        second = runCheck(config({ expectedMode: "enforce" }), deps());
        void second.finally(bTriggered.open);
        await bTriggered.opened;
      }
      return response;
    });

    const first = await runCheck(
      config({ expectedMode: "enforce" }),
      deps({ signUp: aSignUp as unknown as CheckDeps["signUp"] }),
    );
    const secondResult = await second!;

    expect(pool.signUpResults.map((result) => result.error?.name ?? "created")).toEqual([
      "created",
      "UsernameExistsException",
      "UserLambdaValidationException",
    ]);
    expect(secondResult).toMatchObject({
      outcome: "inconclusive",
      reason: "leftover_exists",
      stage: "base",
      signUps: 0,
      usersDeleted: 0,
      claimItemsDeleted: 0,
      recordsDeleted: 0,
    });
    expect(first).toMatchObject({ outcome: "pass", signUps: 1, usersDeleted: 1, remaining: 0 });
    // A's cleanup removed the EMAIL# item (A was one of its holders) and with it the USER# item of B, its other
    // holder, whose sign-up Cognito refused after the trigger.
    // The pool's subs: the seeded real accounts, then A's base sign-up, B's, and A's +tag.
    const bSub = pool.subs[realUsers.length + 1];
    expect(pool.find(bSub)).toBeUndefined();
    expect(table.get(`USER#${bSub}`)).toBeUndefined();
    expectOnlyRealData();
  });

  it("an ambiguous SignUp error never takes another sign-up's refusal record (only an allowed one can be its own)", async () => {
    const strangerSub = "00000000-0000-4000-8000-00000000abcd";
    const strangerRecord = toProbeRecordItem({
      kind: "base",
      userName: strangerSub,
      at: new Date(Date.now()).toISOString(),
      mode: "enforce",
      outcome: "rejected",
      rejectedBy: "emailBase",
      reason: "email_variant_exists",
      checks: [],
    });
    pool.faults.beforeSignUp = () => {
      // A stranger's refused sign-up at the base address lands while this run's SignUp fails before its trigger.
      table.put(strangerRecord);
      throw cognitoError("InternalErrorException");
    };

    const result = await runCheck(config(), deps());

    expect(result).toMatchObject({ outcome: "fail", reason: "signup_error", stage: "base", recordsDeleted: 0 });
    expect(table.get("PROBE#base")).toEqual(strangerRecord);
    expect(pool.callsNamed("AdminGetUserCommand").map((call) => call.input.Username)).not.toContain(strangerSub);
  });
});

describe("the switch and the configuration", () => {
  const loadHandler = () => {
    let handler: (event: unknown) => Promise<unknown>;
    jest.isolateModules(() => {
      handler = require("../handlers/signUpFilterCheck").handler;
    });
    return handler!;
  };

  it.each([undefined, "false", "ture", "1", ""])(
    "SIGNUP_FILTER_CHECK_ENABLED=%p: no AWS client, no call, only Disabled",
    async (value) => {
      setEnv({ SIGNUP_FILTER_CHECK_ENABLED: value });

      expect(await loadHandler()({})).toEqual({ status: "disabled" });

      expect(mockCognitoClients).toEqual([]);
      expect(mockDynamoClients).toEqual([]);
      expect(mockPoolSend).not.toHaveBeenCalled();
      expect(mockTableSend).not.toHaveBeenCalled();
      const metricLinesAll = logLines(console.log).filter((line) => line._aws);
      expect(metricLinesAll).toEqual([expect.objectContaining({ SignUpFilterCheckDisabled: 1 })]);
      expect(Object.keys(metricLinesAll[0]).filter((key) => key.startsWith("SignUpFilterCheck"))).toEqual([
        "SignUpFilterCheckDisabled",
      ]);
    },
  );

  it.each([
    ["an address with a +tag", { SIGNUP_FILTER_CHECK_ADDRESS: "filter-probe+x@billboard-project.com" }],
    ["an upper-case address", { SIGNUP_FILTER_CHECK_ADDRESS: "Filter-Probe@billboard-project.com" }],
    ["a gmail.com address", { SIGNUP_FILTER_CHECK_ADDRESS: "filter.probe@gmail.com" }],
    ["an address on another domain", { SIGNUP_FILTER_CHECK_ADDRESS: "filter-probe@example.com" }],
    ["no address", { SIGNUP_FILTER_CHECK_ADDRESS: undefined }],
    ["no expected mode", { SIGNUP_FILTER_CHECK_EXPECTED_MODE: "block" }],
    ["no pool", { USER_POOL_ID: undefined }],
    ["no client", { USER_POOL_CLIENT_ID: "" }],
    ["no table", { SIGNUP_EMAIL_CLAIMS_TABLE_NAME: undefined }],
    ["no probe token secret", { SIGNUP_PROBE_TOKEN_SECRET_ARN: undefined }],
  ])("%s: fail config, and no client or SignUp", async (_label, overrides) => {
    setEnv(overrides);

    expect(await loadHandler()({})).toEqual({ status: "fail", reason: "config" });

    expect(mockCognitoClients).toEqual([]);
    expect(mockPoolSend).not.toHaveBeenCalled();
    expect(checkMetric("SignUpFilterCheckFailed")).toEqual([
      expect.objectContaining({ SignUpFilterCheckFailed: 1, reason: "config", stage: "config" }),
    ]);
  });

  it.each([
    ["unreadable", async () => Promise.reject(new Error("AccessDeniedException"))],
    ["empty", async () => ({ SecretString: "  " })],
    ["too short", async () => ({ SecretString: "short-token" })],
  ])("an %s probe token (INF-15): fail config, and no SignUp", async (_label, secret) => {
    setEnv();
    mockSecretsSend.mockReset().mockImplementation(secret);

    expect(await loadHandler()({})).toEqual({ status: "fail", reason: "config" });

    expect(mockPoolSend).not.toHaveBeenCalled();
    expect(checkMetric("SignUpFilterCheckFailed")).toEqual([
      expect.objectContaining({ SignUpFilterCheckFailed: 1, reason: "config", stage: "config" }),
    ]);
    expect(
      logLines(console.error).find((line) => line.message === "Sign-up filter check cannot read the probe token"),
    ).toBeDefined();
  });

  it("reads the probe token from its secret and sends it with each SignUp (INF-15)", async () => {
    setEnv();

    expect(await loadHandler()({})).toEqual({ status: "pass" });

    expect(mockSecretsSend.mock.calls.map(([command]) => command.input)).toEqual([
      { SecretId: PROBE_TOKEN_SECRET },
      // The filter reads it too, once per container, for the first probe.
      { SecretId: PROBE_TOKEN_SECRET },
    ]);
    const inputs = pool.callsNamed("SignUpCommand").map((call) => call.input);
    expect(inputs.map((input) => input.ClientMetadata)).toEqual([
      { billboardSignUpProbe: PROBE_TOKEN },
      { billboardSignUpProbe: PROBE_TOKEN },
    ]);
    expectOnlyRealData();
  });
});

describe("bundling", () => {
  /** Every relative module the handler reaches, by its import statements. */
  const importGraph = (entry: string): string[] => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from|require\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        const candidates = [`${target}.ts`, path.join(target, "index.ts")];
        const found = candidates.find((candidate) => fs.existsSync(candidate));
        if (found) visit(found);
      }
    };
    visit(entry);
    return [...seen].map((file) => path.relative(path.join(__dirname, ".."), file));
  };

  it("the check never bundles the filter, its domain list or the account-deletion code", () => {
    const modules = importGraph(path.join(__dirname, "..", "handlers", "signUpFilterCheck", "index.ts"));
    expect(modules).toEqual(expect.arrayContaining(["shared/signUpFilter.ts", "shared/signUpEmailClaims.ts"]));
    expect(modules.filter((module) => /preSignUp|disposableDomains|accountDeletion|appAttest/.test(module))).toEqual(
      [],
    );
  });
});
