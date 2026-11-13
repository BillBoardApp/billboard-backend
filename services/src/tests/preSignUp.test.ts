import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { PreSignUpTriggerEvent } from "aws-lambda";

import type * as PreSignUpModule from "../handlers/preSignUp";
import {
  DISPOSABLE_EMAIL_MESSAGE,
  EMAIL_VARIANT_MESSAGE,
  MAX_CLAIM_HOLDERS,
  addressKeyFor,
  emailKeyFor,
  parseEmailAddress,
} from "../handlers/preSignUp/emailPolicy";
import { APP_ATTEST_DEFAULTS, PENDING_CLAIM_WINDOW_MS, UNCONFIRMED_CLAIM_LIFETIME_MS } from "../shared/abuseLimits";
import { challengeItemKey, keyItemKey } from "../shared/appAttest/store";
import { fromProbeRecordItem, type ProbeKind } from "../shared/signUpFilter";
import {
  FakeAppAttestTable,
  assertionAuthData,
  assertionMarker,
  challengeOf,
  challengeRow,
  generateDeviceKey,
  keyRow,
  signAssertion,
  signUpClientData,
  type DeviceKey,
  type TableInput,
} from "./fixtures/appAttest/helpers";
import { evaluateCondition } from "./fixtures/dynamoCondition";
import type { PoolInput } from "./fixtures/fakeCognitoPool";
import { applyTestEnv } from "./fixtures/env";
import { logLines, type LogLine } from "./logLines";

/*
 * PreSignUpCheck (INT-05, C2 3.5 and 6.1; integration plan X4, X5, X11; acceptance 5.2 beta-S6), with the
 * App Attest and DeviceCheck sign-up checks (INT-04, C3 3.5, 3.11, 3.12 and 7.1 PreSignUp; acceptance 5.2
 * beta-H2).
 *
 * The claims table is held in memory and honours the exact condition expressions the handler sends
 * (fixtures/dynamoCondition), so the X5 two-item transaction and the concurrent-claim path are checked
 * against DynamoDB's semantics, not against a restatement of the handler's intent. The AppAttest table is
 * the in-memory FakeAppAttestTable (same idea), reached through the same mocked DynamoDB client, so the
 * handler's real wiring (table name, store, evaluator) runs. Apple's DeviceCheck service is a fake behind
 * global fetch that keeps the device's two bits. Cognito's AdminGetUser and Secrets Manager are mocked.
 * Metrics are read back from the EMF lines on console.log.
 */

type Item = Record<string, AttributeValue>;
/** What the fakes read from an AWS SDK command: its class's name and its input (a DynamoDB or a Cognito one). */
type SdkInput = TableInput & PoolInput;
type SdkCall = { name: string; input: SdkInput; abortSignal?: AbortSignal };
interface FakeCommand {
  constructor: { name: string };
  input?: SdkInput;
}

const mockDynamoSend = jest.fn();
const mockCognitoSend = jest.fn();
const mockSecretsSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
}));
jest.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  ...jest.requireActual("@aws-sdk/client-cognito-identity-provider"),
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
}));
jest.mock("@aws-sdk/client-secrets-manager", () => ({
  ...jest.requireActual("@aws-sdk/client-secrets-manager"),
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
}));

const TABLE = "SignUpEmailClaims";
const POOL = "us-east-1_TestPool";
const SALT = "salt-from-secret";
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:Billboard/DistrictVerificationHashSalt-AbCdEf";
/** INF-15: the sign-up check's probe token, and the secret that holds it. */
const PROBE_TOKEN_SECRET = "arn:aws:secretsmanager:us-east-1:123456789012:secret:Billboard/SignUpProbeToken-AbCdEf";
const PROBE_TOKEN = "probe-token-for-tests-0123456789abcdefghijklmnopqrstuv";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const NEW_USER = "6c1e8a52-0000-4000-8000-000000000001";
const OLD_USER = "6c1e8a52-0000-4000-8000-000000000002";
/** A sign-up a later check refused, so Cognito never created it. */
const REFUSED_USER = "6c1e8a52-0000-4000-8000-000000000003";

const APP_ATTEST_TABLE = "AppAttest";
const DEVICE_CHECK_SECRET = "Billboard/AppleDeviceCheckKey";

/** INT-05 only: every App Attest and DeviceCheck variable unset (their code default is off). */
const BASE_ENV = {
  SIGNUP_EMAIL_CLAIMS_TABLE_NAME: TABLE,
  HASH_SALT_SECRET_ARN: SECRET_ARN,
  HASH_SALT: undefined,
  SIGNUP_FILTER_MODE: "watch",
  APP_ATTEST_MODE: undefined,
  APP_ATTEST_TABLE_NAME: undefined,
  APP_ATTEST_ALLOWED_ENVIRONMENTS: undefined,
  APP_ATTEST_MAX_ACCOUNTS_PER_KEY: undefined,
  APP_ATTEST_FAIL_CLOSED: undefined,
  MIN_APP_VERSION: undefined,
  DEVICE_CHECK_MODE: undefined,
  DEVICE_CHECK_SECRET_NAME: undefined,
  DEVICE_MAX_ACCOUNTS: undefined,
  DEVICE_COUNTER_WINDOW_MONTHS: undefined,
};

/** Sign-ups one install's key may assert (APP_ATTEST_MAX_ACCOUNTS_PER_KEY's default). */
const KEY_LIMIT = APP_ATTEST_DEFAULTS.maxAccountsPerKey;

/** The observe-only starting positions (App Attest watch, DeviceCheck off), with the limits from abuseLimits.ts. */
const OBSERVE_ENV = {
  ...BASE_ENV,
  APP_ATTEST_MODE: "watch",
  APP_ATTEST_TABLE_NAME: APP_ATTEST_TABLE,
  APP_ATTEST_ALLOWED_ENVIRONMENTS: "production",
  APP_ATTEST_MAX_ACCOUNTS_PER_KEY: String(KEY_LIMIT),
  APP_ATTEST_FAIL_CLOSED: "false",
  DEVICE_CHECK_MODE: "off",
  DEVICE_CHECK_SECRET_NAME: DEVICE_CHECK_SECRET,
  DEVICE_MAX_ACCOUNTS: String(APP_ATTEST_DEFAULTS.deviceMaxAccounts),
  DEVICE_COUNTER_WINDOW_MONTHS: String(APP_ATTEST_DEFAULTS.deviceCounterWindowMonths),
};

/** The DeviceCheck key's secret (a real deployment creates it by hand); a test key here. */
const appleSigningKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const DEVICE_CHECK_KEY_ID = "DCKEY00001";
const DEVICE_CHECK_SECRET_STRING = JSON.stringify({
  keyId: DEVICE_CHECK_KEY_ID,
  teamId: "9R36JN7XJ5",
  privateKeyPem: appleSigningKey.privateKey.export({ type: "pkcs8", format: "pem" }),
});

const mockTable = new Map<string, Item>();
const mockUsers = new Map<string, { UserStatus: string; UserCreateDate: Date }>();
const dynamoCalls: SdkCall[] = [];
const cognitoCalls: SdkCall[] = [];
/** Every DynamoDB and Apple call in order: "<table>:<command>" and "apple:<path>". */
const callOrder: string[] = [];
let appAttestTable: FakeAppAttestTable;

type AppleCall = { url: string; body: Record<string, unknown>; authorization: string; signal?: AbortSignal | null };
const appleCalls: AppleCall[] = [];
/** The device's two bits at Apple; null means "Bit State Not Found". */
let appleBits: { bit0: boolean; bit1: boolean; last_update_time: string } | null = null;
/** Replaces Apple's behaviour for every call. */
let appleOverride: ((call: AppleCall) => Promise<Response>) | undefined;
/** Runs before a transaction is applied (simulates another sign-up writing in between). */
let beforeTransact: Array<() => void> = [];
/** Replaces the in-memory behaviour for one command name. */
let dynamoOverride: Partial<Record<string, (call: SdkCall) => Promise<unknown>>> = {};
let cognitoOverride: ((call: SdkCall) => Promise<unknown>) | undefined;

const awsError = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`${name} from the mock`), { name, ...extra });

const keyFor = (address: string) => emailKeyFor(parseEmailAddress(address)!.base, SALT);
const addressKeyOf = (address: string) => addressKeyFor(address, SALT);
const REVISION = { S: expect.stringMatching(/^[0-9a-f-]{36}$/) };

const seedClaim = (address: string, userName: string, claimedAt = "2026-01-01T00:00:00.000Z") => {
  const emailKey = keyFor(address);
  mockTable.set(`EMAIL#${emailKey}`, {
    pk: { S: `EMAIL#${emailKey}` },
    userName: { S: userName },
    claimedAt: { S: claimedAt },
  });
  mockTable.set(`USER#${userName}`, {
    pk: { S: `USER#${userName}` },
    emailKey: { S: emailKey },
    claimedAt: { S: claimedAt },
  });
};

/** The claim lifetime of an UNCONFIRMED holder, in hours (shared/abuseLimits.ts). */
const CLAIM_LIFETIME_HOURS = UNCONFIRMED_CLAIM_LIFETIME_MS / (60 * 60 * 1000);
const seedUser = (userName: string, UserStatus: string, hoursOld: number) =>
  mockUsers.set(userName, { UserStatus, UserCreateDate: new Date(NOW.getTime() - hoursOld * 60 * 60 * 1000) });

const tableOf = (input: SdkInput | undefined): string | undefined =>
  input?.TableName ?? input?.TransactItems?.[0]?.Put?.TableName;

const inMemoryDynamo = async (
  command: FakeCommand & { input: SdkInput },
  options?: { abortSignal?: AbortSignal },
): Promise<unknown> => {
  const call: SdkCall = { name: command.constructor.name, input: command.input, abortSignal: options?.abortSignal };
  dynamoCalls.push(call);
  callOrder.push(`${tableOf(call.input)}:${call.name}`);
  // The AppAttest store's own client is the same mocked DynamoDBClient; its table is the App Attest fake.
  if (tableOf(call.input) === APP_ATTEST_TABLE) return appAttestTable.send(command, options);
  const override = dynamoOverride[call.name];
  if (override) return override(call);
  switch (call.name) {
    case "GetItemCommand":
      return { Item: mockTable.get(call.input.Key!.pk.S!) };
    case "TransactWriteItemsCommand": {
      for (const hook of beforeTransact.splice(0, 1)) hook();
      const reasons = call.input.TransactItems!.map(({ Put }) => ({
        Code: evaluateCondition(mockTable.get(Put!.Item!.pk.S!), Put) ? "None" : "ConditionalCheckFailed",
      }));
      if (reasons.some((reason: { Code: string }) => reason.Code !== "None")) {
        throw awsError("TransactionCanceledException", { CancellationReasons: reasons });
      }
      for (const { Put } of call.input.TransactItems!) mockTable.set(Put!.Item!.pk.S!, Put!.Item!);
      return {};
    }
    case "PutItemCommand": {
      if (!evaluateCondition(mockTable.get(call.input.Item!.pk.S!), call.input)) {
        throw awsError("ConditionalCheckFailedException");
      }
      mockTable.set(call.input.Item!.pk.S!, call.input.Item!);
      return {};
    }
    default:
      throw new Error(`Unexpected DynamoDB command ${call.name}`);
  }
};

const inMemoryCognito = async (
  command: FakeCommand & { input: SdkInput },
  options?: { abortSignal?: AbortSignal },
): Promise<unknown> => {
  const call: SdkCall = { name: command.constructor.name, input: command.input, abortSignal: options?.abortSignal };
  cognitoCalls.push(call);
  if (cognitoOverride) return cognitoOverride(call);
  if (call.name !== "AdminGetUserCommand") throw new Error(`Unexpected Cognito command ${call.name}`);
  const user = mockUsers.get(call.input.Username!);
  if (!user) throw awsError("UserNotFoundException");
  return { Username: call.input.Username, ...user };
};

/** Apple's DeviceCheck service (C3 0): query_two_bits answers the stored bits, update_two_bits sets them. */
const appleFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const call: AppleCall = {
    url,
    body: JSON.parse(String(init?.body ?? "{}")),
    authorization: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ""),
    signal: init?.signal,
  };
  appleCalls.push(call);
  callOrder.push(`apple:${new URL(url).pathname}`);
  if (appleOverride) return appleOverride(call);
  if (url.endsWith("/v1/query_two_bits")) {
    return appleBits
      ? new Response(JSON.stringify(appleBits), { status: 200 })
      : new Response("Bit State Not Found", { status: 200 });
  }
  if (url.endsWith("/v1/update_two_bits")) {
    appleBits = { bit0: call.body.bit0 === true, bit1: call.body.bit1 === true, last_update_time: "2026-10" };
    return new Response("", { status: 200 });
  }
  return new Response("", { status: 404 });
};

const secretsByName = async (command: { input?: { SecretId?: string } }): Promise<unknown> =>
  command.input?.SecretId === DEVICE_CHECK_SECRET
    ? { SecretString: DEVICE_CHECK_SECRET_STRING }
    : command.input?.SecretId === PROBE_TOKEN_SECRET
      ? { SecretString: PROBE_TOKEN }
      : { SecretString: `  ${SALT}\n` };

/** The sign-up as SignUpFilterCheck makes it: with the probe token in its ClientMetadata (INF-15). */
const withProbeToken = (event: PreSignUpTriggerEvent, token = PROBE_TOKEN): PreSignUpTriggerEvent => {
  event.request.clientMetadata = { billboardSignUpProbe: token };
  return event;
};

/** A promise that never settles on its own and rejects like the SDK when its abort signal fires. */
const hangUntilAborted = (call: SdkCall) =>
  new Promise((_, reject) => {
    call.abortSignal?.addEventListener("abort", () => reject(awsError("AbortError")));
  });

let restoreEnv: (() => void) | undefined;

const loadModule = (env: Record<string, string | undefined> = BASE_ENV, options?: { replace?: boolean }) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(env, options?.replace ? { replace: true, base: {} } : undefined);
  let loaded: typeof PreSignUpModule | undefined;
  jest.isolateModules(() => {
    loaded = require("../handlers/preSignUp");
  });
  return loaded!;
};

const signUpEvent = (
  email: string | undefined,
  overrides: Partial<{ userName: string; triggerSource: string }> = {},
): PreSignUpTriggerEvent =>
  ({
    version: "1",
    region: "us-east-1",
    userPoolId: POOL,
    userName: overrides.userName ?? NEW_USER,
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "app-client" },
    triggerSource: overrides.triggerSource ?? "PreSignUp_SignUp",
    request: { userAttributes: email === undefined ? {} : { email } },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  }) as PreSignUpTriggerEvent;

const consoleText = (): string =>
  [console.log, console.warn, console.error]
    .flatMap((spy) => (spy as jest.Mock).mock.calls.map((args) => args.map(String).join(" ")))
    .join("\n");

const metricLines = (name: string): LogLine[] => logLines(console.log).filter((line) => line._aws && name in line);

const metricNamespaces = (name: string): string[] =>
  metricLines(name).map((line) => line._aws!.CloudWatchMetrics[0].Namespace);

/** The one line PreSignUpCheck writes per sign-up, with the report of each check that ran. */
interface SummaryLine extends LogLine {
  checks: LogLine[];
}
const summaryLinesOf = (): SummaryLine[] =>
  logLines(console.log).filter((line): line is SummaryLine => line.message === "Pre-sign-up checks");

const summaryLine = (): SummaryLine => {
  const lines = summaryLinesOf();
  expect(lines).toHaveLength(1);
  return lines[0];
};

const transactions = () => dynamoCalls.filter((call) => call.name === "TransactWriteItemsCommand");

let fetchSpy: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  mockTable.clear();
  mockUsers.clear();
  dynamoCalls.length = 0;
  cognitoCalls.length = 0;
  callOrder.length = 0;
  appleCalls.length = 0;
  appleBits = null;
  appleOverride = undefined;
  appAttestTable = new FakeAppAttestTable();
  beforeTransact = [];
  dynamoOverride = {};
  cognitoOverride = undefined;
  mockDynamoSend.mockReset().mockImplementation(inMemoryDynamo);
  mockCognitoSend.mockReset().mockImplementation(inMemoryCognito);
  mockSecretsSend.mockReset().mockImplementation(secretsByName);
  fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(appleFetch);
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate"] });
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  restoreEnv?.();
  restoreEnv = undefined;
});

describe("module load and trigger sources", () => {
  it("loads with no environment and fails open: the email-base check errors, the sign-up is allowed", async () => {
    const { handler } = loadModule({}, { replace: true });
    const event = signUpEvent("jane@example.com");

    await expect(handler(event)).resolves.toBe(event);

    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(metricLines("PreSignUpCheckError")).toHaveLength(1);
    expect(metricLines("PreSignUpCheckError")[0]).toMatchObject({ check: "emailBase", errorKind: "exception" });
    // C3 3.12: with no APP_ATTEST_* or DEVICE_CHECK_* variable both INT-04 checks are off (no metric at all).
    expect(metricLines("AppAttestRequests")).toEqual([]);
    expect(summaryLine()).toMatchObject({
      outcome: "allowed",
      appAttest: "off",
      deviceCheck: "off",
      checks: [
        { check: "disposableDomain", mode: "watch", result: "allow" },
        { check: "emailBase", mode: "watch", result: "error", errorKind: "exception" },
        { check: "appAttest", mode: "off", result: "off" },
        { check: "deviceCheck", mode: "off", result: "off" },
      ],
    });
    const warning = logLines(console.warn).find((line) => line.message === "Pre-sign-up check failed open");
    expect((warning?.error as { message?: string } | undefined)?.message).toBe(
      "SIGNUP_EMAIL_CLAIMS_TABLE_NAME is not configured.",
    );
  });

  it.each([
    ["PreSignUp_AdminCreateUser", "admin"],
    ["PreSignUp_ExternalProvider", "other"],
  ])("passes %s untouched in every mode (no call, no metric)", async (triggerSource, outcome) => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    const event = signUpEvent("someone@mailinator.com", { triggerSource });
    seedClaim("someone@mailinator.com", OLD_USER);
    seedUser(OLD_USER, "CONFIRMED", 100);

    await expect(handler(event)).resolves.toBe(event);

    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(logLines(console.log).filter((line) => line._aws)).toEqual([]);
    expect(summaryLine()).toMatchObject({ triggerSource, outcome });
  });

  it("returns the event object unchanged (Cognito's response flags untouched)", async () => {
    const { handler } = loadModule();
    const event = signUpEvent("jane@example.com");
    const before = JSON.parse(JSON.stringify(event));

    const result = await handler(event);

    expect(result).toBe(event);
    expect(result).toEqual(before);
  });

  it("allows an address it cannot parse without any call (Cognito validates the format)", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });

    await handler(signUpEvent("not an address"));
    await handler(signUpEvent(undefined));

    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockSecretsSend).not.toHaveBeenCalled();
    // Only the funnel count (REL-53): both are sign-ups the trigger let through.
    expect(logLines(console.log).filter((line) => line._aws && !("SignUpAllowed" in line))).toEqual([]);
    expect(metricLines("SignUpAllowed")).toHaveLength(2);
  });
});

describe("SIGNUP_FILTER_MODE", () => {
  it.each([
    ["enforce", "enforce"],
    [" ENFORCE ", "enforce"],
    ["watch", "watch"],
    ["block", "watch"],
    ["", "watch"],
    [undefined, "watch"],
  ])("%p means %s", (value, mode) => {
    const { signUpFilterMode } = loadModule();
    expect(signUpFilterMode({ SIGNUP_FILTER_MODE: value })).toBe(mode);
  });
});

describe("disposable domains", () => {
  it("watch: allows, emits SignUpFilterHit with the reason, logs the domain and still writes the claim", async () => {
    const { handler } = loadModule();
    const event = signUpEvent("Burner@X.Mailinator.com");

    await expect(handler(event)).resolves.toBe(event);

    expect(metricLines("SignUpFilterHit")).toEqual([
      expect.objectContaining({
        SignUpFilterHit: 1,
        check: "disposableDomain",
        reason: "disposable_domain",
        mode: "watch",
      }),
    ]);
    expect(metricNamespaces("SignUpFilterHit")).toEqual(["BillBoard/AccountIntegrity"]);
    expect(metricLines("SignUpRejected")).toEqual([]);
    expect(summaryLine()).toMatchObject({
      outcome: "allowed",
      checks: [
        { check: "disposableDomain", result: "hit", reason: "disposable_domain", domain: "x.mailinator.com" },
        { check: "emailBase", result: "allow", claim: "claimed" },
        { check: "appAttest", result: "off" },
        { check: "deviceCheck", result: "off" },
      ],
    });
    expect(mockTable.get(`EMAIL#${keyFor("burner@x.mailinator.com")}`)?.userName).toEqual({ S: NEW_USER });
    expect(consoleText()).not.toMatch(/burner/i);
  });

  it("enforce: throws the X11 message (no 'Please'), emits hit and rejected, and touches no table", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });

    await expect(handler(signUpEvent("someone@mailinator.com"))).rejects.toThrow(DISPOSABLE_EMAIL_MESSAGE);

    expect(DISPOSABLE_EMAIL_MESSAGE).toBe(
      "Use a permanent email address. Temporary email services can't be used for Billboard accounts.",
    );
    const [line] = metricLines("SignUpFilterHit");
    expect(line).toMatchObject({ SignUpFilterHit: 1, SignUpRejected: 1, reason: "disposable_domain", mode: "enforce" });
    expect(mockDynamoSend).not.toHaveBeenCalled();
    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(summaryLine()).toMatchObject({
      outcome: "rejected",
      rejectedBy: "disposableDomain",
      reason: "disposable_domain",
    });
    expect(consoleText()).not.toContain("someone");
  });

  it("never refuses a mainstream provider", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    for (const address of ["a@gmail.com", "b@outlook.com", "c@icloud.com", "d@proton.me"]) {
      await handler(signUpEvent(address, { userName: `user-${address}` }));
    }
    expect(metricLines("SignUpFilterHit")).toEqual([]);
  });
});

describe("base address claims (SignUpEmailClaims, X5)", () => {
  it("claims a new base address: EMAIL# and USER# in one transaction, after a strongly consistent read", async () => {
    const { handler } = loadModule();
    const emailKey = keyFor("jane+billboard@example.com");

    await handler(signUpEvent("Jane+Billboard@Example.com"));

    expect(dynamoCalls.map((call) => call.name)).toEqual(["GetItemCommand", "TransactWriteItemsCommand"]);
    expect(dynamoCalls[0].input).toEqual({
      TableName: TABLE,
      Key: { pk: { S: `EMAIL#${emailKey}` } },
      ConsistentRead: true,
    });
    expect(transactions()[0].input).toEqual({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: {
              pk: { S: `EMAIL#${emailKey}` },
              userName: { S: NEW_USER },
              claimedAt: { S: NOW.toISOString() },
              addressKey: { S: addressKeyOf("Jane+Billboard@Example.com") },
              holders: { M: { [NEW_USER]: { S: NOW.toISOString() } } },
              revision: REVISION,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: { pk: { S: `USER#${NEW_USER}` }, emailKey: { S: emailKey }, claimedAt: { S: NOW.toISOString() } },
          },
        },
      ],
    });
    expect(mockTable.size).toBe(2);
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(metricLines("SignUpFilterHit")).toEqual([]);
    expect(summaryLine()).toMatchObject({
      outcome: "allowed",
      checks: [{ result: "allow" }, { claim: "claimed", claimHolders: 1 }, { result: "off" }, { result: "off" }],
    });
    expect(consoleText()).not.toMatch(/jane/i);
    expect(consoleText()).not.toContain(emailKey);
    expect(consoleText()).not.toContain(addressKeyOf("Jane+Billboard@Example.com"));
  });

  it("uses the salt from HASH_SALT_SECRET_ARN, fetched once per container", async () => {
    const { handler } = loadModule();

    await handler(signUpEvent("one@example.com", { userName: "u-1" }));
    await handler(signUpEvent("two@example.com", { userName: "u-2" }));

    expect(mockSecretsSend).toHaveBeenCalledTimes(1);
    expect(mockSecretsSend.mock.calls[0][0].input).toEqual({ SecretId: SECRET_ARN });
    expect(mockTable.has(`EMAIL#${keyFor("two@example.com")}`)).toBe(true);
  });

  it("uses HASH_SALT when set (local use) without calling Secrets Manager", async () => {
    const { handler } = loadModule({ ...BASE_ENV, HASH_SALT: "local-salt" });

    await handler(signUpEvent("one@example.com"));

    expect(mockSecretsSend).not.toHaveBeenCalled();
    const emailKey = emailKeyFor("one@example.com", "local-salt");
    expect(mockTable.get(`EMAIL#${emailKey}`)?.userName).toEqual({ S: NEW_USER });
  });

  describe.each([
    ["a +tag of", "jane+news@example.com"],
    ["a Gmail dot and googlemail.com variant of", "J.A.N.E@googlemail.com"],
  ])("%s an address a live account holds", (_label, variant) => {
    const holderAddress = variant.includes("example.com") ? "jane@example.com" : "jane@gmail.com";

    beforeEach(() => {
      seedClaim(holderAddress, OLD_USER);
      seedUser(OLD_USER, "CONFIRMED", 24 * 30);
    });

    it("enforce: throws the variant message after AdminGetUser on the holder, and writes nothing", async () => {
      const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
      const before = new Map(mockTable);

      await expect(handler(signUpEvent(variant))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

      expect(cognitoCalls.map((call) => call.input)).toEqual([{ UserPoolId: POOL, Username: OLD_USER }]);
      expect(transactions()).toEqual([]);
      expect(mockTable).toEqual(before);
      expect(metricLines("SignUpFilterHit")[0]).toMatchObject({
        SignUpFilterHit: 1,
        SignUpRejected: 1,
        check: "emailBase",
        reason: "email_variant_exists",
      });
      expect(summaryLine()).toMatchObject({
        outcome: "rejected",
        rejectedBy: "emailBase",
        reason: "email_variant_exists",
      });
      expect(consoleText()).not.toMatch(/jane/i);
    });

    it("watch: allows with a hit, and leaves the live holder's claim in place", async () => {
      const { handler } = loadModule();
      const before = new Map(mockTable);
      const event = signUpEvent(variant);

      await expect(handler(event)).resolves.toBe(event);

      expect(transactions()).toEqual([]);
      expect(mockTable).toEqual(before);
      expect(metricLines("SignUpFilterHit")).toEqual([
        expect.objectContaining({ check: "emailBase", reason: "email_variant_exists", mode: "watch" }),
      ]);
      expect(metricLines("SignUpRejected")).toEqual([]);
    });
  });

  it("treats an UNCONFIRMED holder younger than the claim lifetime as live", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    seedClaim("jane@example.com", OLD_USER);
    seedUser(OLD_USER, "UNCONFIRMED", CLAIM_LIFETIME_HOURS - 1);

    await expect(handler(signUpEvent("jane+2@example.com"))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);
  });

  it.each([
    [
      "an UNCONFIRMED holder older than the claim lifetime (abandoned sign-up)",
      () => seedUser(OLD_USER, "UNCONFIRMED", CLAIM_LIFETIME_HOURS + 1),
    ],
    ["a deleted holder (UserNotFoundException)", () => undefined],
  ])("takes over the claim of %s, on condition the claim is unchanged", async (_label, seedHolder) => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    seedClaim("jane@example.com", OLD_USER);
    seedHolder();
    const emailKey = keyFor("jane@example.com");

    await expect(handler(signUpEvent("jane+new@example.com"))).resolves.toBeDefined();

    const [put] = transactions()[0].input.TransactItems!;
    // A claim written before revisions existed: compared on its userName, and that no revision appeared since.
    expect(put.Put!.ConditionExpression).toBe(
      "attribute_not_exists(pk) OR (attribute_not_exists(#revision) AND userName = :seenUserName)",
    );
    expect(put.Put!.ExpressionAttributeNames).toEqual({ "#revision": "revision" });
    expect(put.Put!.ExpressionAttributeValues).toEqual({ ":seenUserName": { S: OLD_USER } });
    expect(mockTable.get(`EMAIL#${emailKey}`)).toMatchObject({
      userName: { S: NEW_USER },
      addressKey: { S: addressKeyOf("jane+new@example.com") },
      holders: { M: { [NEW_USER]: { S: NOW.toISOString() } } },
    });
    expect(mockTable.get(`USER#${NEW_USER}`)?.emailKey).toEqual({ S: emailKey });
    expect(metricLines("SignUpFilterHit")).toEqual([]);
    expect(summaryLine().checks[1]).toMatchObject({ result: "allow", claim: "taken_over" });
  });

  it("renews its own claim when Cognito retries the same sign-up (no AdminGetUser)", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    seedClaim("jane@example.com", NEW_USER);

    await handler(signUpEvent("jane@example.com"));

    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(transactions()).toHaveLength(1);
    expect(summaryLine().checks[1]).toMatchObject({ result: "allow", claim: "renewed" });
  });

  it("replaces a claim item that names no account, on condition it still names none", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    const emailKey = keyFor("jane@example.com");
    mockTable.set(`EMAIL#${emailKey}`, { pk: { S: `EMAIL#${emailKey}` } });

    await handler(signUpEvent("jane@example.com"));

    const [put] = transactions()[0].input.TransactItems!;
    expect(put.Put!.ConditionExpression).toBe(
      "attribute_not_exists(pk) OR (attribute_not_exists(#revision) AND attribute_not_exists(userName))",
    );
    expect(put.Put!.ExpressionAttributeNames).toEqual({ "#revision": "revision" });
    expect(put.Put!.ExpressionAttributeValues).toBeUndefined();
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(mockTable.get(`EMAIL#${emailKey}`)?.userName).toEqual({ S: NEW_USER });
  });

  it("re-evaluates once when a concurrent sign-up claims the address first, then rejects (enforce)", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    beforeTransact.push(() => {
      seedClaim("jane@example.com", OLD_USER);
      seedUser(OLD_USER, "UNCONFIRMED", 0);
    });

    await expect(handler(signUpEvent("jane+b@example.com"))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

    expect(dynamoCalls.map((call) => call.name)).toEqual([
      "GetItemCommand",
      "TransactWriteItemsCommand",
      "GetItemCommand",
    ]);
    expect(cognitoCalls.map((call) => call.input.Username)).toEqual([OLD_USER]);
    expect(mockTable.get(`EMAIL#${keyFor("jane@example.com")}`)?.userName).toEqual({ S: OLD_USER });
  });

  it("a parallel sign-up's claim holds while Cognito has not created its user yet (enforce rejects)", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    // The other sign-up's trigger wrote its claim in between and returned; its user does not exist yet.
    beforeTransact.push(() => seedClaim("jane@example.com", OLD_USER, NOW.toISOString()));

    await expect(handler(signUpEvent("jane+b@example.com"))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

    expect(cognitoCalls.map((call) => call.input.Username)).toEqual([OLD_USER]);
    expect(mockTable.get(`EMAIL#${keyFor("jane@example.com")}`)?.userName).toEqual({ S: OLD_USER });
    expect(mockTable.get(`USER#${NEW_USER}`)).toBeUndefined();
  });

  it.each([
    ["just inside the pending window", PENDING_CLAIM_WINDOW_MS - 1_000, "variant_exists"],
    ["exactly the pending window", PENDING_CLAIM_WINDOW_MS, "taken_over"],
  ])("a claim %s old whose holder Cognito cannot find: %s", async (_label, ageMs, claim) => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "watch" });
    seedClaim("jane@example.com", OLD_USER, new Date(NOW.getTime() - ageMs).toISOString());

    await handler(signUpEvent("jane+c@example.com"));

    const holder = mockTable.get(`EMAIL#${keyFor("jane@example.com")}`)?.userName;
    expect(holder).toEqual({ S: claim === "taken_over" ? NEW_USER : OLD_USER });
    expect(metricLines("SignUpFilterHit")).toHaveLength(claim === "taken_over" ? 0 : 1);
  });

  it("keeps evaluating while the claim changes under it: two lost writes, then taken over in the third round", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    const stale = (userName: string) => () => {
      seedClaim("jane@example.com", userName);
      seedUser(userName, "UNCONFIRMED", 2 * CLAIM_LIFETIME_HOURS);
    };
    beforeTransact.push(stale("racer-1"), stale("racer-2"));
    const event = signUpEvent("jane@example.com");

    await expect(handler(event)).resolves.toBe(event);

    expect(transactions()).toHaveLength(3);
    expect(summaryLine().checks[1]).toMatchObject({ result: "allow", claim: "taken_over" });
    expect(mockTable.get(`EMAIL#${keyFor("jane@example.com")}`)?.userName).toEqual({ S: NEW_USER });
    expect(metricLines("PreSignUpCheckError")).toEqual([]);
  });

  it("a claim that never settles: after MAX_CLAIM_ROUNDS lost writes the sign-up is a hit (contention), never a fail-open error", async () => {
    const { handler, MAX_CLAIM_ROUNDS } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    for (let round = 0; round < MAX_CLAIM_ROUNDS + 1; round += 1) {
      beforeTransact.push(() => {
        seedClaim("jane@example.com", `racer-${round}`);
        seedUser(`racer-${round}`, "UNCONFIRMED", 2 * CLAIM_LIFETIME_HOURS);
      });
    }

    await expect(handler(signUpEvent("jane@example.com"))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

    expect(transactions()).toHaveLength(MAX_CLAIM_ROUNDS);
    expect(summaryLine().checks[1]).toMatchObject({
      result: "hit",
      claim: "variant_exists",
      claimDetail: "contention",
    });
    expect(metricLines("PreSignUpCheckError")).toEqual([]);
    expect(mockTable.get(`USER#${NEW_USER}`)).toBeUndefined();
  });

  it("a lost write is not evaluated again when less than CLAIM_ROUND_RESERVE_MS of the email budget is left (contention)", async () => {
    const { handler, CLAIM_ROUND_RESERVE_MS, EMAIL_CHECKS_BUDGET } = loadModule({
      ...BASE_ENV,
      SIGNUP_FILTER_MODE: "enforce",
    });
    beforeTransact.push(() => {
      seedClaim("jane@example.com", "racer-1");
      seedUser("racer-1", "UNCONFIRMED", 2 * CLAIM_LIFETIME_HOURS);
      jest.setSystemTime(Date.now() + EMAIL_CHECKS_BUDGET.ms - CLAIM_ROUND_RESERVE_MS + 1);
    });

    await expect(handler(signUpEvent("jane@example.com"))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

    expect(transactions()).toHaveLength(1);
    expect(summaryLine().checks[1]).toMatchObject({ result: "hit", claimDetail: "contention" });
  });

  it("a round after a lost write that runs out of time is a hit (contention) before the budget ends, not a fail-open error", async () => {
    const { handler, EMAIL_CHECKS_BUDGET } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    beforeTransact.push(() => {
      seedClaim("jane@example.com", "racer-1");
      seedUser("racer-1", "UNCONFIRMED", 2 * CLAIM_LIFETIME_HOURS);
    });
    // The first round reads and loses its write; the second round's read never answers (a slow table).
    let reads = 0;
    dynamoOverride.GetItemCommand = async (call) =>
      (reads += 1) === 1 ? { Item: mockTable.get(call.input.Key!.pk.S!) } : hangUntilAborted(call);
    let settled = false;

    const pending = handler(signUpEvent("jane@example.com")).finally(() => (settled = true));
    pending.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(EMAIL_CHECKS_BUDGET.ms - 100);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(50);

    expect(settled).toBe(true);
    await expect(pending).rejects.toThrow(EMAIL_VARIANT_MESSAGE);
    expect(reads).toBe(2);
    expect(dynamoCalls.filter((call) => call.name === "GetItemCommand").at(-1)?.abortSignal?.aborted).toBe(true);
    expect(summaryLine().checks[1]).toMatchObject({
      result: "hit",
      claim: "variant_exists",
      claimDetail: "contention",
    });
    expect(metricLines("PreSignUpCheckError")).toEqual([]);
    expect(mockTable.get(`USER#${NEW_USER}`)).toBeUndefined();
  });
});

describe("retries of the same address (Cognito checks the password after the trigger)", () => {
  const ADDRESS = "Jane.Doe@example.com";
  const SECOND = 1_000;
  const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
  const emailItem = (address = ADDRESS) => mockTable.get(`EMAIL#${keyFor(address)}`);
  const holdersOf = (address = ADDRESS) =>
    Object.fromEntries(Object.entries(emailItem(address)?.holders?.M ?? {}).map(([name, value]) => [name, value.S]));
  const summaries = summaryLinesOf;
  const emailBaseReports = () => summaries().map((line) => line.checks[1]);

  /** An EMAIL# item in the current layout: `holders` (userName -> claimedAt), the latest one named. */
  const seedHolders = (
    holders: Record<string, string>,
    options: { address?: string; addressKey?: string | null; revision?: string } = {},
  ) => {
    const address = options.address ?? ADDRESS;
    const emailKey = keyFor(address);
    const latest = Object.entries(holders).sort(([, a], [, b]) => (a < b ? 1 : -1))[0];
    const addressKey = options.addressKey === undefined ? addressKeyOf(address) : options.addressKey;
    mockTable.set(`EMAIL#${emailKey}`, {
      pk: { S: `EMAIL#${emailKey}` },
      userName: { S: latest[0] },
      claimedAt: { S: latest[1] },
      ...(addressKey === null ? {} : { addressKey: { S: addressKey } }),
      holders: { M: Object.fromEntries(Object.entries(holders).map(([name, time]) => [name, { S: time }])) },
      revision: { S: options.revision ?? "rev-seeded" },
    });
  };

  it("the case seen live: four sign-ups of one address 2 to 25 s apart, each refused by Cognito after the trigger, are all allowed with no hit (enforce)", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    const attempts: Array<[string, number]> = [
      ["attempt-1", 0],
      ["attempt-2", 2 * SECOND],
      ["attempt-3", 14 * SECOND],
      ["attempt-4", 39 * SECOND],
    ];

    for (const [userName, offset] of attempts) {
      jest.setSystemTime(NOW.getTime() + offset);
      const event = signUpEvent(ADDRESS, { userName });
      await expect(handler(event)).resolves.toBe(event);
      // Cognito then refuses the password (InvalidPasswordException): no user is created.
    }

    expect(metricLines("SignUpFilterHit")).toEqual([]);
    expect(metricLines("SignUpRejected")).toEqual([]);
    expect(emailBaseReports()).toEqual([
      expect.objectContaining({ result: "allow", claim: "claimed", claimHolders: 1 }),
      expect.objectContaining({ result: "allow", claim: "retried", claimHolders: 2 }),
      expect.objectContaining({ result: "allow", claim: "retried", claimHolders: 3 }),
      expect.objectContaining({ result: "allow", claim: "retried", claimHolders: 4 }),
    ]);
    expect(holdersOf()).toEqual(Object.fromEntries(attempts.map(([name, offset]) => [name, at(offset)])));
    expect(emailItem()).toMatchObject({
      userName: { S: "attempt-4" },
      claimedAt: { S: at(39 * SECOND) },
      addressKey: { S: addressKeyOf(ADDRESS) },
    });
    for (const [userName] of attempts)
      expect(mockTable.get(`USER#${userName}`)?.emailKey).toEqual({ S: keyFor(ADDRESS) });
    // Each retry looks up the attempt the claim names, then the earlier ones (newest first), in parallel.
    expect(cognitoCalls.map((call) => call.input.Username)).toEqual([
      "attempt-1",
      "attempt-2",
      "attempt-1",
      "attempt-3",
      "attempt-2",
      "attempt-1",
    ]);
    expect(consoleText()).not.toMatch(/jane/i);
    expect(consoleText()).not.toContain(keyFor(ADDRESS));
    expect(consoleText()).not.toContain(addressKeyOf(ADDRESS));
  });

  it("a retry 2 s after the first attempt (Cognito never created it): retried, holders {A, B}, compared on the revision read", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    await handler(signUpEvent(ADDRESS, { userName: OLD_USER }));
    const revision = emailItem()?.revision?.S;
    jest.setSystemTime(NOW.getTime() + 2 * SECOND);
    dynamoCalls.length = 0;
    cognitoCalls.length = 0;

    await handler(signUpEvent(ADDRESS));

    expect(cognitoCalls.map((call) => call.input)).toEqual([{ UserPoolId: POOL, Username: OLD_USER }]);
    const [put, userPut] = transactions()[0].input.TransactItems!;
    expect(put.Put).toEqual({
      TableName: TABLE,
      Item: {
        pk: { S: `EMAIL#${keyFor(ADDRESS)}` },
        userName: { S: NEW_USER },
        claimedAt: { S: at(2 * SECOND) },
        addressKey: { S: addressKeyOf(ADDRESS) },
        holders: { M: { [OLD_USER]: { S: at(0) }, [NEW_USER]: { S: at(2 * SECOND) } } },
        revision: REVISION,
      },
      ConditionExpression: "attribute_not_exists(pk) OR #revision = :seenRevision",
      ExpressionAttributeNames: { "#revision": "revision" },
      ExpressionAttributeValues: { ":seenRevision": { S: revision } },
    });
    expect(emailItem()?.revision?.S).not.toBe(revision);
    expect(userPut.Put!.Item).toEqual({
      pk: { S: `USER#${NEW_USER}` },
      emailKey: { S: keyFor(ADDRESS) },
      claimedAt: { S: at(2 * SECOND) },
    });
    expect(metricLines("SignUpFilterHit")).toEqual([]);
  });

  it.each([
    ["a +tag of it", "jane.doe+news@example.com"],
    ["the same address with other letter case (its own user in this case-sensitive pool)", "jane.doe@example.com"],
    ["a Gmail dot variant of it", "janedoe@gmail.com", "jane.doe@gmail.com"],
  ])(
    "a different address while the first attempt may still be in flight is a hit: %s",
    async (_label, variant, first = ADDRESS) => {
      const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
      await handler(signUpEvent(first, { userName: OLD_USER }));
      jest.setSystemTime(NOW.getTime() + 10 * SECOND);
      const before = new Map(mockTable);
      dynamoCalls.length = 0;
      (console.log as jest.Mock).mockClear();

      await expect(handler(signUpEvent(variant))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

      expect(transactions()).toEqual([]);
      expect(mockTable).toEqual(before);
      expect(metricLines("SignUpFilterHit")).toHaveLength(1);
      expect(summaryLine().checks[1]).toMatchObject({ result: "hit", claim: "variant_exists", claimHolders: 1 });
    },
  );

  it("parallel sign-ups of one address where A became the account and B was refused: after the window, a variant is still a hit because A is live", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    await handler(signUpEvent(ADDRESS, { userName: OLD_USER }));
    jest.setSystemTime(NOW.getTime() + SECOND);
    await handler(signUpEvent(ADDRESS, { userName: REFUSED_USER }));
    // Cognito created A (OLD_USER) and refused B: the claim still names B as its latest holder.
    seedUser(OLD_USER, "UNCONFIRMED", 0);
    expect(emailItem()?.userName).toEqual({ S: REFUSED_USER });
    expect(Object.keys(holdersOf())).toEqual([OLD_USER, REFUSED_USER]);
    jest.setSystemTime(NOW.getTime() + PENDING_CLAIM_WINDOW_MS + 60 * SECOND);
    const holders = holdersOf();
    cognitoCalls.length = 0;

    await expect(handler(signUpEvent("jane.doe+2@example.com"))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);
    // The hit points the claim at the live account (holders unchanged), so the next sign-up finds it at once.
    expect(emailItem()).toMatchObject({ userName: { S: OLD_USER }, claimedAt: { S: at(0) } });
    expect(holdersOf()).toEqual(holders);
    await expect(handler(signUpEvent(ADDRESS, { userName: "late-retry" }))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

    expect(cognitoCalls.map((call) => call.input.Username)).toEqual([REFUSED_USER, OLD_USER, OLD_USER]);
    expect(holdersOf()).toEqual(holders);
    expect(mockTable.get("USER#late-retry")).toBeUndefined();
  });

  it.each([
    [3, "first"],
    [3, "last"],
    [10, "first"],
    [10, "last"],
  ] as const)(
    "%i parallel sign-ups of one address: each is recorded as a holder or refused, none goes on unrecorded; with the %s holder the account, a variant after the window is a hit",
    async (count, created) => {
      const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
      const names = Array.from({ length: count }, (_, index) => `parallel-${index}`);

      const results = await Promise.allSettled(names.map((userName) => handler(signUpEvent(ADDRESS, { userName }))));

      const allowed = names.filter((_, index) => results[index].status === "fulfilled");
      const holders = Object.keys(holdersOf());
      expect([...allowed].sort()).toEqual([...holders].sort());
      expect(holders).toHaveLength(Math.min(count, MAX_CLAIM_HOLDERS));
      // The writes did collide: the race went past one round.
      expect(transactions().length).toBeGreaterThan(count);
      expect(metricLines("PreSignUpCheckError")).toEqual([]);
      const refused = emailBaseReports().filter((report) => report.result === "hit");
      expect(refused).toHaveLength(count - holders.length);
      for (const report of refused) expect(report.claimDetail).toMatch(/^(holder_limit|contention)$/);
      for (const name of holders) expect(mockTable.get(`USER#${name}`)?.emailKey).toEqual({ S: keyFor(ADDRESS) });

      // Cognito creates one of the attempts it was given and refuses the rest (one account per exact address).
      seedUser(created === "first" ? holders[0] : holders[holders.length - 1], "UNCONFIRMED", 0);
      jest.setSystemTime(NOW.getTime() + PENDING_CLAIM_WINDOW_MS + 60 * SECOND);
      (console.log as jest.Mock).mockClear();

      await expect(handler(signUpEvent("jane.doe+2@example.com"))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);
      expect(summaryLine().checks[1]).toMatchObject({ result: "hit", claim: "variant_exists" });
    },
  );

  it("a claim written before addressKey existed keeps the old rule: a pending holder is a hit even for the same address", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    seedClaim(ADDRESS, OLD_USER, at(-2 * SECOND));
    const before = new Map(mockTable);

    await expect(handler(signUpEvent(ADDRESS))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

    expect(cognitoCalls.map((call) => call.input.Username)).toEqual([OLD_USER]);
    expect(transactions()).toEqual([]);
    expect(mockTable).toEqual(before);
  });

  it("refuses a retry that would take the holders past MAX_CLAIM_HOLDERS (claim detail holder_limit), and writes nothing", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    seedHolders(
      Object.fromEntries(
        Array.from({ length: MAX_CLAIM_HOLDERS }, (_, index) => [`attempt-${index}`, at(-index * SECOND)]),
      ),
    );
    const before = new Map(mockTable);

    await expect(handler(signUpEvent(ADDRESS))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

    // Refused whatever the holders' accounts are (live or pending), so none is looked up.
    expect(cognitoCalls).toEqual([]);
    expect(transactions()).toEqual([]);
    expect(mockTable).toEqual(before);
    expect(metricLines("SignUpFilterHit")[0]).toMatchObject({ reason: "email_variant_exists" });
    expect(summaryLine().checks[1]).toMatchObject({
      result: "hit",
      claim: "variant_exists",
      claimHolders: MAX_CLAIM_HOLDERS,
      claimDetail: "holder_limit",
    });
  });

  it("a retry drops the holders that no longer hold (past the window, or an abandoned UNCONFIRMED account), so it fits under the limit", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    const pending = Object.fromEntries(
      Array.from({ length: MAX_CLAIM_HOLDERS - 1 }, (_, index) => [`pending-${index}`, at(-index * SECOND)]),
    );
    // The abandoned account signed up (and claimed) more than a day ago.
    seedHolders({
      ...pending,
      expired: at(-PENDING_CLAIM_WINDOW_MS - SECOND),
      abandoned: at(-(CLAIM_LIFETIME_HOURS + 1) * 60 * 60 * SECOND),
    });
    seedUser("abandoned", "UNCONFIRMED", CLAIM_LIFETIME_HOURS + 1);

    await expect(handler(signUpEvent(ADDRESS))).resolves.toBeDefined();

    expect(holdersOf()).toEqual({ ...pending, [NEW_USER]: at(0) });
    expect(summaryLine().checks[1]).toMatchObject({ claim: "retried", claimHolders: MAX_CLAIM_HOLDERS });
  });

  it("every holder gone and past the window: taken over, the holders reset to the new sign-up and its address", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    seedHolders({
      "old-1": at(-PENDING_CLAIM_WINDOW_MS - 2 * SECOND),
      "old-2": at(-PENDING_CLAIM_WINDOW_MS - SECOND),
    });

    await expect(handler(signUpEvent("jane.doe+new@example.com"))).resolves.toBeDefined();

    expect(holdersOf()).toEqual({ [NEW_USER]: at(0) });
    expect(emailItem()?.addressKey).toEqual({ S: addressKeyOf("jane.doe+new@example.com") });
    expect(summaryLine().checks[1]).toMatchObject({ claim: "taken_over", claimHolders: 1 });
    expect(metricLines("SignUpFilterHit")).toEqual([]);
  });

  it("renews its own claim when Cognito re-invokes the trigger, keeping the other holders (no AdminGetUser)", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    seedHolders({ [OLD_USER]: at(-3 * SECOND), [NEW_USER]: at(-SECOND) });

    await handler(signUpEvent(ADDRESS));

    expect(cognitoCalls).toEqual([]);
    expect(holdersOf()).toEqual({ [OLD_USER]: at(-3 * SECOND), [NEW_USER]: at(0) });
    expect(summaryLine().checks[1]).toMatchObject({ claim: "renewed", claimHolders: 2 });
  });

  it("a concurrent retry is never lost: the write compares the revision, loses, and is evaluated once more", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    seedHolders({ "attempt-1": at(-4 * SECOND) }, { revision: "rev-1" });
    // Another retry of the address lands between this sign-up's read and its write.
    beforeTransact.push(() =>
      seedHolders({ "attempt-1": at(-4 * SECOND), "attempt-2": at(-SECOND) }, { revision: "rev-2" }),
    );

    await expect(handler(signUpEvent(ADDRESS))).resolves.toBeDefined();

    expect(dynamoCalls.map((call) => call.name)).toEqual([
      "GetItemCommand",
      "TransactWriteItemsCommand",
      "GetItemCommand",
      "TransactWriteItemsCommand",
    ]);
    expect(transactions().map((call) => call.input.TransactItems![0].Put!.ExpressionAttributeValues)).toEqual([
      { ":seenRevision": { S: "rev-1" } },
      { ":seenRevision": { S: "rev-2" } },
    ]);
    expect(holdersOf()).toEqual({ "attempt-1": at(-4 * SECOND), "attempt-2": at(-SECOND), [NEW_USER]: at(0) });
    expect(metricLines("SignUpFilterHit")).toEqual([]);
  });

  describe("the release step (a later check refused the sign-up under enforce)", () => {
    const release = (module: typeof PreSignUpModule, userName: string) =>
      module.releaseBaseAddressClaim({
        db: { send: mockDynamoSend },
        tableName: TABLE,
        userName,
        emailKey: keyFor(ADDRESS),
        now: Date.now,
      });

    it("its only holder: the item becomes one that names no account", async () => {
      const module = loadModule();
      seedHolders({ [REFUSED_USER]: at(-SECOND) }, { revision: "rev-1" });

      await expect(release(module, REFUSED_USER)).resolves.toEqual({ outcome: "released" });

      expect(emailItem()).toEqual({
        pk: { S: `EMAIL#${keyFor(ADDRESS)}` },
        releasedAt: { S: at(0) },
        revision: REVISION,
      });
      expect(dynamoCalls.find((call) => call.name === "PutItemCommand")?.input.ExpressionAttributeValues).toEqual({
        ":seenRevision": { S: "rev-1" },
      });
    });

    it("the latest of several holders: removed, and userName and claimedAt move to the newest remaining one", async () => {
      const module = loadModule();
      seedHolders({ "attempt-1": at(-3 * SECOND), "attempt-2": at(-2 * SECOND), [REFUSED_USER]: at(-SECOND) });

      await expect(release(module, REFUSED_USER)).resolves.toEqual({ outcome: "removed" });

      expect(emailItem()).toEqual({
        pk: { S: `EMAIL#${keyFor(ADDRESS)}` },
        userName: { S: "attempt-2" },
        claimedAt: { S: at(-2 * SECOND) },
        addressKey: { S: addressKeyOf(ADDRESS) },
        holders: { M: { "attempt-1": { S: at(-3 * SECOND) }, "attempt-2": { S: at(-2 * SECOND) } } },
        revision: REVISION,
      });
      expect(emailItem()?.revision?.S).not.toBe("rev-seeded");
    });

    it("an earlier holder: removed, and userName and claimedAt stay with the latest", async () => {
      const module = loadModule();
      seedHolders({ [REFUSED_USER]: at(-3 * SECOND), "attempt-2": at(-SECOND) });

      await expect(release(module, REFUSED_USER)).resolves.toEqual({ outcome: "removed" });

      expect(holdersOf()).toEqual({ "attempt-2": at(-SECOND) });
      expect(emailItem()).toMatchObject({ userName: { S: "attempt-2" }, claimedAt: { S: at(-SECOND) } });
    });

    it("a claim written before revisions existed: released on condition that it still names this sign-up", async () => {
      const module = loadModule();
      seedClaim(ADDRESS, REFUSED_USER, at(-SECOND));

      await expect(release(module, REFUSED_USER)).resolves.toEqual({ outcome: "released" });

      const put = dynamoCalls.find((call) => call.name === "PutItemCommand")!;
      expect(put.input.ConditionExpression).toBe("attribute_not_exists(#revision) AND userName = :userName");
      expect(put.input.ExpressionAttributeValues).toEqual({ ":userName": { S: REFUSED_USER } });
      expect(emailItem()?.releasedAt).toEqual({ S: at(0) });
    });

    it("loses to a concurrent write: reads again and removes only itself from what is there now", async () => {
      const module = loadModule();
      seedHolders({ [REFUSED_USER]: at(-2 * SECOND) }, { revision: "rev-1" });
      let first = true;
      dynamoOverride.PutItemCommand = async (call) => {
        if (first) {
          first = false;
          // A retry of the same address joined the holders meanwhile.
          seedHolders({ [REFUSED_USER]: at(-2 * SECOND), "attempt-2": at(-SECOND) }, { revision: "rev-2" });
        }
        if (!evaluateCondition(mockTable.get(call.input.Item!.pk.S!), call.input)) {
          throw awsError("ConditionalCheckFailedException");
        }
        mockTable.set(call.input.Item!.pk.S!, call.input.Item!);
        return {};
      };

      await expect(release(module, REFUSED_USER)).resolves.toEqual({ outcome: "removed" });

      expect(dynamoCalls.map((call) => call.name)).toEqual([
        "GetItemCommand",
        "PutItemCommand",
        "GetItemCommand",
        "PutItemCommand",
      ]);
      expect(holdersOf()).toEqual({ "attempt-2": at(-SECOND) });
    });

    it("through the handler: App Attest refuses one of two attempts under enforce, and only that attempt leaves the claim", async () => {
      const { handler } = loadModule({ ...OBSERVE_ENV, SIGNUP_FILTER_MODE: "enforce", APP_ATTEST_MODE: "enforce" });
      seedHolders({ "attempt-1": at(-SECOND) });

      await expect(handler(signUpEvent(ADDRESS, { userName: REFUSED_USER }))).rejects.toThrow(/^APP_UPDATE_REQUIRED$/);

      expect(holdersOf()).toEqual({ "attempt-1": at(-SECOND) });
      expect(emailItem()?.userName).toEqual({ S: "attempt-1" });
    });
  });
});

describe("fail open on every internal error (enforce mode)", () => {
  const enforce = { ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" };

  it("guards a bug in the runner itself: the sign-up is allowed and PreSignUpCheckError emitted", async () => {
    const module = loadModule(enforce);
    const broken = {
      name: "broken",
      mode: () => "enforce",
      budget: { label: "broken", ms: 1_000 },
      get metrics(): PreSignUpModule.CheckMetrics {
        throw new Error("bug");
      },
      run: () => Promise.reject(new Error("check failed")),
    } as PreSignUpModule.SignUpCheck;
    (module.SIGN_UP_CHECKS as PreSignUpModule.SignUpCheck[]).unshift(broken);
    const event = signUpEvent("someone@mailinator.com");

    await expect(module.handler(event)).resolves.toBe(event);

    expect(metricLines("PreSignUpCheckError")).toEqual([expect.objectContaining({ check: "runner" })]);
    expect(logLines(console.error).map((line) => line.message)).toEqual(["Pre-sign-up checks failed open"]);
    // The sign-up goes ahead, so the funnel counts it (REL-53).
    expect(metricLines("SignUpAllowed")).toEqual([expect.objectContaining({ SignUpAllowed: 1 })]);
  });

  it.each([
    [
      "DynamoDB GetItem",
      () => (dynamoOverride.GetItemCommand = async () => Promise.reject(awsError("ResourceNotFoundException"))),
    ],
    [
      "the claim transaction (not a concurrent claim)",
      () =>
        (dynamoOverride.TransactWriteItemsCommand = async () =>
          Promise.reject(
            awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "ThrottlingError" }] }),
          )),
    ],
    [
      "a DynamoDB validation error",
      () => (dynamoOverride.TransactWriteItemsCommand = async () => Promise.reject(awsError("ValidationException"))),
    ],
    [
      "Cognito AdminGetUser",
      () => {
        seedClaim("jane@example.com", OLD_USER);
        cognitoOverride = async () => Promise.reject(awsError("TooManyRequestsException"));
      },
    ],
    ["Secrets Manager", () => mockSecretsSend.mockRejectedValue(awsError("AccessDeniedException"))],
    ["an empty salt secret", () => mockSecretsSend.mockResolvedValue({ SecretString: "  " })],
  ])("%s: allows the sign-up and emits PreSignUpCheckError", async (_label, breakIt) => {
    const { handler } = loadModule(enforce);
    breakIt();
    const event = signUpEvent("jane+x@example.com");

    await expect(handler(event)).resolves.toBe(event);

    expect(metricLines("PreSignUpCheckError")).toEqual([
      expect.objectContaining({ PreSignUpCheckError: 1, check: "emailBase", errorKind: "exception" }),
    ]);
    expect(metricNamespaces("PreSignUpCheckError")).toEqual(["BillBoard/AccountIntegrity"]);
    expect(metricLines("SignUpRejected")).toEqual([]);
    expect(summaryLine()).toMatchObject({ outcome: "allowed" });
    expect(logLines(console.warn).filter((line) => line.message === "Pre-sign-up check failed open")).toHaveLength(1);
  });

  it("does not cache a failed salt load: the next invocation fetches it again", async () => {
    const { handler } = loadModule(enforce);
    mockSecretsSend.mockRejectedValueOnce(awsError("InternalServiceError"));

    await handler(signUpEvent("one@example.com", { userName: "u-1" }));
    await handler(signUpEvent("two@example.com", { userName: "u-2" }));

    expect(mockSecretsSend).toHaveBeenCalledTimes(2);
    expect(mockTable.has(`EMAIL#${keyFor("two@example.com")}`)).toBe(true);
  });
});

describe("time limits (X4)", () => {
  it("cuts the email checks at 1.2 s, aborts the SDK call and allows the sign-up (enforce)", async () => {
    const { handler, EMAIL_CHECKS_BUDGET } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    dynamoOverride.GetItemCommand = async (call) => hangUntilAborted(call);
    const event = signUpEvent("jane@example.com");
    let settled = false;

    const pending = handler(event).finally(() => (settled = true));
    await jest.advanceTimersByTimeAsync(EMAIL_CHECKS_BUDGET.ms - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(event);
    expect(EMAIL_CHECKS_BUDGET.ms).toBe(1_200);
    expect(dynamoCalls[0].abortSignal?.aborted).toBe(true);
    expect(metricLines("PreSignUpCheckError")[0]).toMatchObject({ check: "emailBase", errorKind: "timeout" });
  });

  it("allows the sign-up and emits PreSignUpCheckError when a check runs past the 3.5 s deadline", async () => {
    const module = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });
    const slowCheck: PreSignUpModule.SignUpCheck = {
      name: "slow",
      mode: () => "enforce",
      budget: { label: "slow", ms: 60_000 },
      metrics: module.SIGN_UP_FILTER_METRICS,
      run: ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    (module.SIGN_UP_CHECKS as PreSignUpModule.SignUpCheck[]).push(slowCheck);
    const event = signUpEvent("jane@example.com");
    let settled = false;

    const pending = module.handler(event).finally(() => (settled = true));
    await jest.advanceTimersByTimeAsync(module.SIGN_UP_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(event);
    expect(module.SIGN_UP_DEADLINE_MS).toBe(3_500);
    expect(metricLines("PreSignUpCheckError")).toEqual([
      expect.objectContaining({ check: "slow", errorKind: "deadline" }),
    ]);
    expect(summaryLine()).toMatchObject({
      outcome: "allowed",
      checks: [
        { result: "allow" },
        { result: "allow", claim: "claimed" },
        { check: "appAttest", result: "off" },
        { check: "deviceCheck", result: "off" },
        { check: "slow", result: "error" },
      ],
    });
  });

  it("ends the deadline earlier when the Lambda has less time left than usual", async () => {
    const { handler } = loadModule();
    dynamoOverride.GetItemCommand = async (call) => hangUntilAborted(call);
    const context = { awsRequestId: "req-1", getRemainingTimeInMillis: () => 1_000 };

    const pending = handler(signUpEvent("jane@example.com"), context);
    await jest.advanceTimersByTimeAsync(750);
    await pending;

    expect(metricLines("PreSignUpCheckError")[0]).toMatchObject({ check: "emailBase", errorKind: "deadline" });
  });
});

describe("runSignUpChecks (the check seam for App Attest and DeviceCheck)", () => {
  type Check = PreSignUpModule.SignUpCheck;
  const START = NOW.getTime();
  const DEADLINE = START + 3_500;
  const event = () => signUpEvent("jane@example.com") as PreSignUpModule.SignUpTriggerEvent;
  const appAttestMetrics = { namespace: "BillBoard/AppAttest", error: "AppAttestErrors" };

  const check = (name: string, overrides: Partial<Check> = {}): Check => ({
    name,
    mode: () => "watch",
    budget: { label: name, ms: 1_200 },
    metrics: {
      namespace: "BillBoard/AccountIntegrity",
      hit: "SignUpFilterHit",
      rejected: "SignUpRejected",
      error: "PreSignUpCheckError",
    },
    run: () => ({ outcome: "allow" }),
    ...overrides,
  });
  const after = (ms: number, result: PreSignUpModule.SignUpCheckResult) => () =>
    new Promise<PreSignUpModule.SignUpCheckResult>((resolve) => setTimeout(() => resolve(result), ms));
  const reject = (reason: string) => ({ outcome: "reject" as const, reason, message: `${reason}.` });

  it("runs commit steps in order, only after every check allowed", async () => {
    const { runSignUpChecks } = loadModule();
    const order: string[] = [];
    const checks = [
      check("a", { run: () => ({ outcome: "allow", commit: async () => void order.push("commit a") }) }),
      check("b", {
        run: () => (order.push("run b"), { outcome: "allow", commit: async () => void order.push("commit b") }),
      }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision.outcome).toBe("allow");
    expect(order).toEqual(["run b", "commit a", "commit b"]);
  });

  it("enforce: the first rejection stops the list, and no commit step runs", async () => {
    const { runSignUpChecks } = loadModule();
    const commit = jest.fn(async () => undefined);
    const later = jest.fn(() => ({ outcome: "allow" as const }));
    const checks = [
      check("counter", { run: () => ({ outcome: "allow", commit }) }),
      check("strict", { mode: () => "enforce", run: () => reject("DEVICE_ACCOUNT_LIMIT") }),
      check("later", { run: later }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision).toMatchObject({
      outcome: "reject",
      rejection: { check: "strict", reason: "DEVICE_ACCOUNT_LIMIT", message: "DEVICE_ACCOUNT_LIMIT." },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
  });

  it("enforce: a rejection runs the release steps of the checks before it, newest first; watch hits run none", async () => {
    const { runSignUpChecks } = loadModule();
    const order: string[] = [];
    const releasing = (name: string) =>
      check(name, { run: () => ({ outcome: "allow", release: async () => void order.push(`release ${name}`) }) });
    const unreached = jest.fn(async () => undefined);
    const checks = [
      releasing("a"),
      check("soft", { run: () => reject("disposable_domain") }),
      releasing("b"),
      check("strict", { mode: () => "enforce", run: () => (order.push("run strict"), reject("APP_UPDATE_REQUIRED")) }),
      check("later", { run: () => ({ outcome: "allow", release: unreached }) }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision.rejection?.check).toBe("strict");
    expect(order).toEqual(["run strict", "release b", "release a"]);
    expect(unreached).not.toHaveBeenCalled();

    const allowed = await runSignUpChecks(event(), [releasing("c"), check("soft", { run: () => reject("x") })], {
      deadlineAt: DEADLINE,
    });
    expect(allowed.outcome).toBe("allow");
    expect(order).not.toContain("release c");
  });

  it("a failing release step is an error (phase release); the others still run and the sign-up is still refused", async () => {
    const { runSignUpChecks } = loadModule();
    const release = jest.fn(async () => undefined);
    const checks = [
      check("kept", { run: () => ({ outcome: "allow", release }) }),
      check("claim", { run: () => ({ outcome: "allow", release: () => Promise.reject(new Error("boom")) }) }),
      check("strict", { mode: () => "enforce", run: () => reject("DEVICE_ACCOUNT_LIMIT") }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision.outcome).toBe("reject");
    expect(release).toHaveBeenCalledTimes(1);
    expect(decision.checks[decision.checks.length - 1]).toMatchObject({
      check: "claim",
      result: "error",
      phase: "release",
      errorKind: "exception",
    });
    expect(metricLines("PreSignUpCheckError")[0]).toMatchObject({ check: "claim", phase: "release" });
  });

  it("watch: a rejection is only a hit; later checks and commit steps still run", async () => {
    const { runSignUpChecks } = loadModule();
    const commit = jest.fn(async () => undefined);
    const checks = [
      check("soft", { run: () => reject("disposable_domain") }),
      check("next", { run: () => ({ outcome: "allow", commit }) }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision.outcome).toBe("allow");
    expect(decision.checks.map((report) => report.result)).toEqual(["hit", "allow"]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(metricLines("SignUpFilterHit")).toHaveLength(1);
    expect(metricLines("SignUpRejected")).toEqual([]);
  });

  it("off: the check does not run and emits nothing", async () => {
    const { runSignUpChecks } = loadModule();
    const run = jest.fn(() => reject("x"));

    const decision = await runSignUpChecks(event(), [check("disabled", { mode: () => "off", run })], {
      deadlineAt: DEADLINE,
    });

    expect(run).not.toHaveBeenCalled();
    expect(decision.checks).toEqual([{ check: "disabled", mode: "off", result: "off" }]);
    expect(logLines(console.log).filter((line) => line._aws)).toEqual([]);
  });

  it("emits a check's own error metric in its own namespace (App Attest: AppAttestErrors), and no hit metric it lacks", async () => {
    const { runSignUpChecks } = loadModule();
    const checks = [
      check("appAttest", { metrics: appAttestMetrics, run: () => Promise.reject(new Error("table down")) }),
      check("appAttestSoft", { metrics: appAttestMetrics, run: () => reject("APP_ATTEST_REQUIRED") }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision.outcome).toBe("allow");
    expect(metricNamespaces("AppAttestErrors")).toEqual(["BillBoard/AppAttest"]);
    expect(metricLines("PreSignUpCheckError")).toEqual([]);
    expect(metricLines("SignUpFilterHit")).toEqual([]);
  });

  it("a failing commit step is an error (phase commit) and the sign-up is still allowed", async () => {
    const { runSignUpChecks } = loadModule();
    const checks = [
      check("counter", { run: () => ({ outcome: "allow", commit: () => Promise.reject(new Error("boom")) }) }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision.outcome).toBe("allow");
    expect(decision.checks[1]).toMatchObject({
      check: "counter",
      result: "error",
      phase: "commit",
      errorKind: "exception",
    });
    expect(metricLines("PreSignUpCheckError")[0]).toMatchObject({ check: "counter", phase: "commit" });
  });

  it("treats a throwing mode as watch and a missing result as an error", async () => {
    const { runSignUpChecks } = loadModule();
    const checks = [
      check("badMode", {
        mode: () => {
          throw new Error("bad env");
        },
        run: () => reject("r"),
      }),
      check("noResult", { run: () => undefined as unknown as PreSignUpModule.SignUpCheckResult }),
      check("oddMode", { mode: () => "ENFORCE" as PreSignUpModule.CheckMode, run: () => reject("r") }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision.outcome).toBe("allow");
    expect(decision.checks.map((report) => [report.mode, report.result])).toEqual([
      ["watch", "hit"],
      ["watch", "error"],
      ["watch", "hit"],
    ]);
  });

  it("falls back to the reason when an enforce rejection has no message", async () => {
    const { runSignUpChecks } = loadModule();
    const checks = [
      check("terse", { mode: () => "enforce", run: () => ({ outcome: "reject", reason: "CODE", message: "" }) }),
    ];

    const decision = await runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });

    expect(decision.rejection).toEqual({ check: "terse", reason: "CODE", message: "CODE" });
  });

  it("checks sharing a budget share its time: the second gets what the first left", async () => {
    const { runSignUpChecks } = loadModule();
    const shared = { label: "email", ms: 1_200 };
    const hang: Check["run"] = ({ signal }) =>
      new Promise((_, rejectRun) => signal.addEventListener("abort", () => rejectRun(new Error("aborted"))));
    const checks = [
      check("first", { budget: shared, run: after(1_000, { outcome: "allow" }) }),
      check("second", { budget: shared, run: hang }),
    ];

    const pending = runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });
    await jest.advanceTimersByTimeAsync(1_199);
    const early = jest.fn();
    void pending.then(early);
    await Promise.resolve();
    expect(early).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    const decision = await pending;

    expect(decision.checks[1]).toMatchObject({ check: "second", result: "error", errorKind: "timeout", ms: 200 });
  });

  it("one deadline for all: a check gets only the time left, and a check after the deadline errors at once", async () => {
    const { runSignUpChecks } = loadModule();
    const hang: Check["run"] = ({ signal, timeLeftMs }) => {
      expect(timeLeftMs()).toBe(500);
      return new Promise((_, rejectRun) => signal.addEventListener("abort", () => rejectRun(new Error("aborted"))));
    };
    const late = jest.fn(() => ({ outcome: "allow" as const }));
    const checks = [
      check("slowButFine", { budget: { label: "x", ms: 5_000 }, run: after(3_000, { outcome: "allow" }) }),
      check("cut", { budget: { label: "y", ms: 5_000 }, run: hang }),
      check("late", { budget: { label: "z", ms: 5_000 }, run: late }),
    ];

    const pending = runSignUpChecks(event(), checks, { deadlineAt: DEADLINE });
    await jest.advanceTimersByTimeAsync(3_500);
    const decision = await pending;

    expect(decision.outcome).toBe("allow");
    expect(decision.checks.map((report) => [report.check, report.result, report.errorKind])).toEqual([
      ["slowButFine", "allow", undefined],
      ["cut", "error", "deadline"],
      ["late", "error", "deadline"],
    ]);
    expect(late).not.toHaveBeenCalled();
    expect(metricLines("PreSignUpCheckError").map((line) => line.check)).toEqual(["cut", "late"]);
  });
});

// ─── INT-04: App Attest and DeviceCheck at sign-up (C3 3.5, WP-C3c; acceptance 5.2 beta-H2) ────────────────

describe("App Attest and DeviceCheck at sign-up (INT-04, C3 3.5)", () => {
  const R2_EMAIL = "voter@example.com";
  const DEVICE_TOKEN = Buffer.from("device-check-token-bytes").toString("base64");
  const DEVICE_CHECK_WATCH = { ...OBSERVE_ENV, DEVICE_CHECK_MODE: "watch" };
  let device: DeviceKey;
  let challengeSeq = 0;

  beforeEach(() => {
    device = generateDeviceKey();
  });

  const registerKey = (overrides: Partial<Parameters<typeof keyRow>[0]> = {}) =>
    appAttestTable.put(keyRow({ keyId: device.keyId, publicKeySpki: device.publicKeySpki, ...overrides }));

  /** R2's billboardAppAttest for a sign-up: a fresh one-time challenge, clientData bound to the email hash. */
  const signUpAssertion = (input: { email?: string; counter?: number } = {}) => {
    challengeSeq += 1;
    const challenge = challengeOf(`presignup-${challengeSeq}`);
    appAttestTable.put(challengeRow({ challenge, purpose: "assert", expiresAt: new Date(NOW.getTime() + 120_000) }));
    const clientData = signUpClientData({ challenge, email: input.email ?? R2_EMAIL });
    const assertion = signAssertion({
      privateKey: device.privateKey,
      authenticatorData: assertionAuthData({ counter: input.counter ?? 1 }),
      clientData,
    });
    return { challenge, marker: assertionMarker({ keyId: device.keyId, clientData, assertion }) };
  };

  /** A sign-up from R2, with the ClientMetadata keys of C3 4.3. */
  const r2SignUp = (
    input: { email?: string; marker?: string; deviceToken?: string; userName?: string; triggerSource?: string } = {},
  ): PreSignUpTriggerEvent => {
    const event = signUpEvent(input.email ?? R2_EMAIL, {
      userName: input.userName,
      triggerSource: input.triggerSource,
    });
    event.request.clientMetadata = {
      ...(input.marker !== undefined ? { billboardAppAttest: input.marker } : {}),
      ...(input.deviceToken !== undefined ? { billboardDeviceCheck: input.deviceToken } : {}),
      billboardAppVersion: "1.2",
    };
    return event;
  };

  const appAttestLines = (): LogLine[] =>
    logLines(console.log).filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/AppAttest");
  const appAttestMetric = (name: string, dimensions: Record<string, string> = {}): LogLine[] =>
    appAttestLines().filter(
      (line) => name in line && Object.entries(dimensions).every(([key, value]) => line[key] === value),
    );
  const signupCount = () => appAttestTable.get(keyItemKey(device.keyId))?.signupCount;
  const secretIds = (): string[] => mockSecretsSend.mock.calls.map(([command]) => command.input.SecretId);
  const applePaths = (): string[] => appleCalls.map((call) => new URL(call.url).pathname);
  const summaries = summaryLinesOf;

  describe("registration and switches", () => {
    it("runs App Attest, then DeviceCheck, after INT-05's checks, with the X4 budgets and the App Attest metrics", () => {
      const module = loadModule();

      expect(module.SIGN_UP_CHECKS.map((check) => check.name)).toEqual([
        "disposableDomain",
        "emailBase",
        "appAttest",
        "deviceCheck",
      ]);
      expect(module.appAttestSignUpCheck.budget).toEqual({ label: "appAttest", ms: 1_200 });
      expect(module.deviceCheckSignUpCheck.budget).toEqual({ label: "deviceCheck", ms: module.SIGN_UP_DEADLINE_MS });
      expect(module.appAttestSignUpCheck.metrics).toEqual({
        namespace: "BillBoard/AppAttest",
        error: "AppAttestErrors",
        omitAccountKeys: true,
      });
      expect(module.deviceCheckSignUpCheck.metrics).toBe(module.appAttestSignUpCheck.metrics);
    });

    it.each([
      ["nothing set", {}, "off", "off"],
      ["APP_ATTEST_MODE=watch without a table name", { APP_ATTEST_MODE: "watch" }, "off", "off"],
      ["APP_ATTEST_MODE=watch", { APP_ATTEST_MODE: "watch", APP_ATTEST_TABLE_NAME: APP_ATTEST_TABLE }, "watch", "off"],
      [
        "APP_ATTEST_MODE=' ENFORCE '",
        { APP_ATTEST_MODE: " ENFORCE ", APP_ATTEST_TABLE_NAME: APP_ATTEST_TABLE },
        "enforce",
        "off",
      ],
      [
        "an unknown APP_ATTEST_MODE",
        { APP_ATTEST_MODE: "block", APP_ATTEST_TABLE_NAME: APP_ATTEST_TABLE },
        "watch",
        "off",
      ],
      ["an empty APP_ATTEST_MODE", { APP_ATTEST_MODE: "", APP_ATTEST_TABLE_NAME: APP_ATTEST_TABLE }, "off", "off"],
      ["DEVICE_CHECK_MODE=watch without the secret name", { DEVICE_CHECK_MODE: "watch" }, "off", "off"],
      [
        "DEVICE_CHECK_MODE=watch",
        { DEVICE_CHECK_MODE: "watch", DEVICE_CHECK_SECRET_NAME: DEVICE_CHECK_SECRET },
        "off",
        "watch",
      ],
      [
        "DEVICE_CHECK_MODE=enforce",
        { DEVICE_CHECK_MODE: "enforce", DEVICE_CHECK_SECRET_NAME: DEVICE_CHECK_SECRET },
        "off",
        "enforce",
      ],
      ["the observe-only settings", OBSERVE_ENV, "watch", "off"],
    ])("%s: appAttest %s, deviceCheck %s", (_label, env, appAttest, deviceCheck) => {
      const module = loadModule({ ...BASE_ENV, ...env });

      expect(module.appAttestSignUpCheck.mode()).toBe(appAttest);
      expect(module.deviceCheckSignUpCheck.mode()).toBe(deviceCheck);
    });

    it("with no APP_ATTEST_* or DEVICE_CHECK_* variables, R2's ClientMetadata changes nothing: INT-05's calls only", async () => {
      const { handler } = loadModule(BASE_ENV);
      registerKey();
      const { challenge, marker } = signUpAssertion();

      await handler(r2SignUp({ marker, deviceToken: DEVICE_TOKEN }));

      expect(dynamoCalls.map((call) => call.name)).toEqual(["GetItemCommand", "TransactWriteItemsCommand"]);
      expect(callOrder).toEqual([`${TABLE}:GetItemCommand`, `${TABLE}:TransactWriteItemsCommand`]);
      expect(appAttestTable.calls).toEqual([]);
      expect(appAttestTable.get(challengeItemKey(challenge))?.consumedAt).toBeUndefined();
      expect(signupCount()).toEqual({ N: "0" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(secretIds()).toEqual([SECRET_ARN]);
      expect(appAttestLines()).toEqual([]);
      expect(summaryLine()).toMatchObject({ outcome: "allowed", appAttest: "off", deviceCheck: "off" });
    });
  });

  describe("watch (the starting positions: App Attest watch, DeviceCheck off)", () => {
    it("an old build (1.0, R1) signs up unchanged: outcome missing, no AppAttest or Apple call (C3 7.4.4)", async () => {
      const { handler } = loadModule(OBSERVE_ENV);
      const event = signUpEvent("jane@example.com");

      await expect(handler(event)).resolves.toBe(event);

      expect(callOrder).toEqual([`${TABLE}:GetItemCommand`, `${TABLE}:TransactWriteItemsCommand`]);
      expect(appAttestTable.calls).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(secretIds()).toEqual([SECRET_ARN]);
      expect(appAttestMetric("AppAttestRequests")).toEqual([
        expect.objectContaining({
          AppAttestRequests: 1,
          Route: "signup",
          Outcome: "missing",
          mode: "watch",
          blocked: false,
          wouldBlock: "APP_UPDATE_REQUIRED",
        }),
      ]);
      expect(appAttestMetric("AppAttestErrors")).toEqual([]);
      expect(appAttestMetric("DeviceCheckCalls")).toEqual([]);
      expect(summaryLine()).toMatchObject({
        outcome: "allowed",
        appAttest: "missing",
        deviceCheck: "off",
        checks: [
          { check: "disposableDomain", result: "allow" },
          { check: "emailBase", result: "allow", claim: "claimed" },
          { check: "appAttest", mode: "watch", result: "allow", outcome: "missing" },
          { check: "deviceCheck", mode: "off", result: "off" },
        ],
      });
    });

    it("R2 on a device: INT-05, then App Attest (verified, signupCount 1), then DeviceCheck (bits 0 -> 1)", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      registerKey({ signCount: 0, signupCount: 0 });
      const { challenge, marker } = signUpAssertion({ counter: 1 });
      const event = r2SignUp({ marker, deviceToken: DEVICE_TOKEN });

      await expect(handler(event)).resolves.toBe(event);

      expect(callOrder).toEqual([
        `${TABLE}:GetItemCommand`,
        `${TABLE}:TransactWriteItemsCommand`,
        `${APP_ATTEST_TABLE}:UpdateItemCommand`, // consume the challenge
        `${APP_ATTEST_TABLE}:GetItemCommand`, // the key
        `${APP_ATTEST_TABLE}:UpdateItemCommand`, // signCount 0 -> 1
        `${APP_ATTEST_TABLE}:UpdateItemCommand`, // ADD signupCount 1
        "apple:/v1/query_two_bits",
        "apple:/v1/update_two_bits",
      ]);
      expect(appAttestTable.get(challengeItemKey(challenge))?.consumedAt).toEqual({ S: NOW.toISOString() });
      expect(appAttestTable.get(keyItemKey(device.keyId))).toMatchObject({
        signCount: { N: "1" },
        signupCount: { N: "1" },
      });
      // Under watch the sign-up count has no limit condition.
      expect(appAttestTable.calls[appAttestTable.calls.length - 1].input).toMatchObject({
        UpdateExpression: "ADD #signupCount :one",
        ConditionExpression: "attribute_exists(#pk)",
      });
      // Apple: the production host, the token from ClientMetadata, and a JWT signed with the deployment's key.
      expect(appleCalls.map((call) => call.url)).toEqual([
        "https://api.devicecheck.apple.com/v1/query_two_bits",
        "https://api.devicecheck.apple.com/v1/update_two_bits",
      ]);
      expect(appleCalls[0].body).toMatchObject({ device_token: DEVICE_TOKEN, timestamp: NOW.getTime() });
      expect(appleCalls[1].body).toMatchObject({ device_token: DEVICE_TOKEN, bit0: true, bit1: false });
      const [header, claims, signature] = appleCalls[0].authorization.replace(/^Bearer /, "").split(".");
      expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
        alg: "ES256",
        kid: DEVICE_CHECK_KEY_ID,
      });
      expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
        iss: "9R36JN7XJ5",
        iat: NOW.getTime() / 1000,
      });
      expect(
        verifySignature(
          "sha256",
          Buffer.from(`${header}.${claims}`),
          { key: appleSigningKey.publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      expect(secretIds()).toEqual([SECRET_ARN, DEVICE_CHECK_SECRET]);
      expect(appAttestMetric("AppAttestRequests", { Route: "signup", Outcome: "valid" })).toHaveLength(1);
      expect(appAttestMetric("DeviceCheckCalls", { Outcome: "not_found" })).toHaveLength(1);
      expect(appAttestMetric("AppAttestErrors")).toEqual([]);
      expect(appAttestMetric("AppAttestOverLimit")).toEqual([]);
      expect(summaryLine()).toMatchObject({
        outcome: "allowed",
        appAttest: "valid",
        deviceCheck: "not_found",
        checks: [
          { check: "disposableDomain", result: "allow" },
          { check: "emailBase", result: "allow", claim: "claimed" },
          { check: "appAttest", mode: "watch", result: "allow", outcome: "valid", keyEnvironment: "production" },
          { check: "deviceCheck", mode: "watch", result: "allow", outcome: "not_found", count: 0 },
        ],
      });
    });

    it("metric lines carry no account ID, email, token or full key ID; the summary keeps userName (C3 3.11)", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      registerKey();
      const { marker } = signUpAssertion();

      await handler(r2SignUp({ marker, deviceToken: DEVICE_TOKEN }));

      const lines = appAttestLines();
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) expect(line.userName).toBeUndefined();
      expect(appAttestMetric("AppAttestRequests")[0]).toMatchObject({ keyIdPrefix: device.keyId.slice(0, 8) });
      expect(summaryLine().userName).toBe(NEW_USER);
      const text = consoleText();
      expect(text).not.toContain(device.keyId);
      expect(text).not.toContain(DEVICE_TOKEN);
      expect(text).not.toMatch(/voter/i);
    });

    it("hands the App Attest result to DeviceCheck: a development key's device is counted on Apple's development host", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      registerKey({ environment: "development" });
      const { marker } = signUpAssertion();

      await handler(r2SignUp({ marker, deviceToken: DEVICE_TOKEN }));

      expect(appleCalls.map((call) => new URL(call.url).host)).toEqual([
        "api.development.devicecheck.apple.com",
        "api.development.devicecheck.apple.com",
      ]);
      expect(summaryLine()).toMatchObject({ appAttest: "development", deviceCheck: "not_found" });
    });

    it("DeviceCheck runs on its own when App Attest is off (production host)", async () => {
      const { handler } = loadModule({ ...DEVICE_CHECK_WATCH, APP_ATTEST_TABLE_NAME: undefined });

      await handler(r2SignUp({ deviceToken: DEVICE_TOKEN }));

      expect(appAttestTable.calls).toEqual([]);
      expect(appleCalls.map((call) => new URL(call.url).host)).toEqual([
        "api.devicecheck.apple.com",
        "api.devicecheck.apple.com",
      ]);
      expect(summaryLine()).toMatchObject({ appAttest: "off", deviceCheck: "not_found" });
    });

    it("a Cognito retry of the same sign-up does not count again: signupCount and the bits move once (C3 3.5)", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      registerKey();
      const { marker } = signUpAssertion();

      await handler(r2SignUp({ marker, deviceToken: DEVICE_TOKEN }));
      // Cognito re-invokes the trigger with a new event carrying the same request.
      await handler(r2SignUp({ marker, deviceToken: DEVICE_TOKEN }));

      expect(signupCount()).toEqual({ N: "1" });
      expect(applePaths()).toEqual(["/v1/query_two_bits", "/v1/update_two_bits", "/v1/query_two_bits"]);
      expect(appleBits).toMatchObject({ bit0: true, bit1: false });
      expect(summaries()[1]).toMatchObject({
        outcome: "allowed",
        appAttest: "valid",
        deviceCheck: "ok",
        checks: [
          { check: "disposableDomain" },
          { check: "emailBase", claim: "renewed" },
          { check: "appAttest", outcome: "valid", replay: true },
          { check: "deviceCheck", outcome: "ok", count: 1 },
        ],
      });
    });

    it("an assertion bound to another address is invalid, recorded and allowed; nothing is counted for the install", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      registerKey();
      const { marker } = signUpAssertion({ email: "someone-else@example.com" });
      const event = r2SignUp({ marker, deviceToken: DEVICE_TOKEN });

      await expect(handler(event)).resolves.toBe(event);

      expect(signupCount()).toEqual({ N: "0" });
      expect(appAttestMetric("AppAttestInvalid")).toHaveLength(1);
      expect(appAttestMetric("AppAttestRejected")).toEqual([]);
      expect(summaryLine()).toMatchObject({
        outcome: "allowed",
        appAttest: "invalid",
        checks: [{}, {}, { check: "appAttest", result: "allow", outcome: "invalid", detail: "client_data_email" }, {}],
      });
    });

    it("a sign-up over the install's limit is counted and flagged AppAttestOverLimit{Kind=install}, not refused", async () => {
      const { handler } = loadModule(OBSERVE_ENV);
      registerKey({ signupCount: KEY_LIMIT });
      const event = r2SignUp({ marker: signUpAssertion().marker });

      await expect(handler(event)).resolves.toBe(event);

      expect(signupCount()).toEqual({ N: String(KEY_LIMIT + 1) });
      expect(appAttestMetric("AppAttestOverLimit", { Kind: "install" })).toEqual([
        expect.objectContaining({ route: "signup", blocked: false }),
      ]);
      expect(appAttestMetric("AppAttestRejected")).toEqual([]);
    });

    it("a 4th sign-up on the device is flagged AppAttestOverLimit{Kind=device}; the bits stay at 3", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      appleBits = { bit0: true, bit1: true, last_update_time: "2026-09" };
      const event = r2SignUp({ deviceToken: DEVICE_TOKEN });

      await expect(handler(event)).resolves.toBe(event);

      expect(applePaths()).toEqual(["/v1/query_two_bits"]);
      expect(appAttestMetric("AppAttestOverLimit", { Kind: "device" })).toHaveLength(1);
      expect(summaryLine()).toMatchObject({ outcome: "allowed", deviceCheck: "ok" });
      expect(summaryLine().checks[3]).toMatchObject({ check: "deviceCheck", outcome: "ok", count: 3 });
    });

    it("a missing DeviceCheck token is recorded (DeviceCheckCalls{Outcome=missing}) with no Apple call or secret read", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      const event = r2SignUp({});

      await expect(handler(event)).resolves.toBe(event);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(secretIds()).toEqual([SECRET_ARN]);
      expect(appAttestMetric("DeviceCheckCalls", { Outcome: "missing" })).toHaveLength(1);
      expect(summaryLine()).toMatchObject({ outcome: "allowed", deviceCheck: "missing" });
    });

    it("an Apple outage (HTTP 503) is an AppAttestErrors and the sign-up goes on", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      appleOverride = async () => new Response("", { status: 503 });
      const event = r2SignUp({ deviceToken: DEVICE_TOKEN });

      await expect(handler(event)).resolves.toBe(event);

      expect(applePaths()).toEqual(["/v1/query_two_bits"]);
      expect(appAttestMetric("AppAttestErrors")).toHaveLength(1);
      expect(appAttestMetric("DeviceCheckCalls", { Outcome: "error" })).toHaveLength(1);
      expect(summaryLine()).toMatchObject({ outcome: "allowed", deviceCheck: "error" });
    });

    it("never throws, even when the AppAttest table, the DeviceCheck secret and Apple all fail", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      registerKey();
      const { marker } = signUpAssertion();
      appAttestTable.failNext("UpdateItemCommand");
      mockSecretsSend.mockImplementation(async (command: { input: { SecretId?: string } }) =>
        command.input.SecretId === DEVICE_CHECK_SECRET
          ? Promise.reject(awsError("AccessDeniedException"))
          : secretsByName(command),
      );
      appleOverride = async () => Promise.reject(new TypeError("fetch failed"));
      const event = r2SignUp({ marker, deviceToken: DEVICE_TOKEN });

      await expect(handler(event)).resolves.toBe(event);

      expect(signupCount()).toEqual({ N: "0" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(appAttestMetric("AppAttestErrors")).toHaveLength(2);
      expect(appAttestMetric("AppAttestRequests", { Outcome: "error" })).toHaveLength(1);
      expect(appAttestMetric("DeviceCheckCalls", { Outcome: "error" })).toHaveLength(1);
      expect(metricLines("PreSignUpCheckError")).toEqual([]);
      expect(summaryLine()).toMatchObject({ outcome: "allowed", appAttest: "error", deviceCheck: "error" });
    });
  });

  describe("enforce throws the bare code: 'PreSignUp failed with error <CODE>.' (X11)", () => {
    const APP_ATTEST_ENFORCE = { ...OBSERVE_ENV, APP_ATTEST_MODE: "enforce" };
    const DEVICE_CHECK_ENFORCE = { ...OBSERVE_ENV, DEVICE_CHECK_MODE: "enforce" };

    it.each([
      {
        label: "an old build (no ClientMetadata)",
        env: APP_ATTEST_ENFORCE,
        check: "appAttest",
        code: "APP_UPDATE_REQUIRED",
        event: () => signUpEvent(R2_EMAIL),
      },
      {
        label: "a Debug build's bypass marker",
        env: APP_ATTEST_ENFORCE,
        check: "appAttest",
        code: "APP_ATTEST_REQUIRED",
        event: () => r2SignUp({ marker: "v1.b" }),
      },
      {
        label: "an unknown key",
        env: APP_ATTEST_ENFORCE,
        check: "appAttest",
        code: "APP_ATTEST_UNKNOWN_KEY",
        event: () => r2SignUp({ marker: signUpAssertion().marker }),
      },
      {
        label: "a sign-up over the install's limit",
        env: APP_ATTEST_ENFORCE,
        check: "appAttest",
        code: "DEVICE_ACCOUNT_LIMIT",
        event: () => (registerKey({ signupCount: KEY_LIMIT }), r2SignUp({ marker: signUpAssertion().marker })),
        after: () => expect(signupCount()).toEqual({ N: String(KEY_LIMIT) }),
      },
      {
        label: "a 4th sign-up on the device",
        env: DEVICE_CHECK_ENFORCE,
        check: "deviceCheck",
        code: "DEVICE_ACCOUNT_LIMIT",
        event: () => {
          appleBits = { bit0: true, bit1: true, last_update_time: "2026-10" };
          return r2SignUp({ deviceToken: DEVICE_TOKEN });
        },
        after: () => expect(applePaths()).toEqual(["/v1/query_two_bits"]),
      },
      {
        label: "no DeviceCheck token",
        env: DEVICE_CHECK_ENFORCE,
        check: "deviceCheck",
        code: "APP_ATTEST_REQUIRED",
        event: () => r2SignUp({}),
        after: () => expect(fetchSpy).not.toHaveBeenCalled(),
      },
    ])("$label: $check refuses with $code", async ({ env, check, code, event, after }) => {
      const { handler } = loadModule(env);

      await expect(handler(event())).rejects.toThrow(new RegExp(`^${code}$`));

      after?.();
      expect(appAttestMetric("AppAttestRejected")).toEqual([expect.objectContaining({ AppAttestRejected: 1, code })]);
      expect(metricLines("SignUpRejected")).toEqual([]);
      expect(summaryLine()).toMatchObject({ outcome: "rejected", rejectedBy: check, reason: code });
    });

    it("allows a valid R2 sign-up under enforce, counting it with the limit condition", async () => {
      const { handler } = loadModule({ ...APP_ATTEST_ENFORCE, DEVICE_CHECK_MODE: "enforce" });
      registerKey({ signupCount: KEY_LIMIT - 1 });
      const event = r2SignUp({ marker: signUpAssertion().marker, deviceToken: DEVICE_TOKEN });

      await expect(handler(event)).resolves.toBe(event);

      expect(signupCount()).toEqual({ N: String(KEY_LIMIT) });
      expect(appAttestTable.calls[appAttestTable.calls.length - 1].input).toMatchObject({
        UpdateExpression: "ADD #signupCount :one",
        ConditionExpression: "attribute_exists(#pk) AND (attribute_not_exists(#signupCount) OR #signupCount < :limit)",
        ExpressionAttributeValues: { ":one": { N: "1" }, ":limit": { N: String(KEY_LIMIT) } },
      });
      expect(applePaths()).toEqual(["/v1/query_two_bits", "/v1/update_two_bits"]);
      expect(summaryLine()).toMatchObject({ outcome: "allowed", appAttest: "valid", deviceCheck: "not_found" });
    });

    it("an App Attest refusal stops the list: DeviceCheck reads no secret and makes no Apple call", async () => {
      const { handler } = loadModule({ ...APP_ATTEST_ENFORCE, DEVICE_CHECK_MODE: "enforce" });

      await expect(handler(r2SignUp({ marker: "v1.u", deviceToken: DEVICE_TOKEN }))).rejects.toThrow(
        /^APP_ATTEST_REQUIRED$/,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(secretIds()).toEqual([SECRET_ARN]);
      expect(summaryLine().checks.map((report: LogLine) => report.check)).toEqual([
        "disposableDomain",
        "emailBase",
        "appAttest",
      ]);
    });

    it("known gap under enforce: a DeviceCheck refusal after App Attest counted the sign-up leaves the install's count spent", async () => {
      // App Attest counts inside its evaluation (shared/appAttest/evaluate.ts), not in a commit step.
      const { handler } = loadModule(DEVICE_CHECK_ENFORCE);
      registerKey();
      appleBits = { bit0: true, bit1: true, last_update_time: "2026-10" };

      await expect(handler(r2SignUp({ marker: signUpAssertion().marker, deviceToken: DEVICE_TOKEN }))).rejects.toThrow(
        /^DEVICE_ACCOUNT_LIMIT$/,
      );

      expect(signupCount()).toEqual({ N: "1" });
    });

    it.each([
      {
        label: "App Attest refuses an old build (filter enforce)",
        env: { ...APP_ATTEST_ENFORCE, SIGNUP_FILTER_MODE: "enforce" },
        code: "APP_UPDATE_REQUIRED",
        refused: () => signUpEvent(R2_EMAIL, { userName: REFUSED_USER }),
        retry: () => (registerKey(), r2SignUp({ marker: signUpAssertion().marker })),
      },
      {
        label: "App Attest refuses an old build (filter watch)",
        env: APP_ATTEST_ENFORCE,
        code: "APP_UPDATE_REQUIRED",
        refused: () => signUpEvent(R2_EMAIL, { userName: REFUSED_USER }),
        retry: () => (registerKey(), r2SignUp({ marker: signUpAssertion().marker })),
      },
      {
        label: "DeviceCheck refuses a sign-up without a token (filter enforce)",
        env: { ...DEVICE_CHECK_ENFORCE, SIGNUP_FILTER_MODE: "enforce" },
        code: "APP_ATTEST_REQUIRED",
        refused: () => r2SignUp({ userName: REFUSED_USER }),
        retry: () => r2SignUp({ deviceToken: DEVICE_TOKEN }),
      },
    ])(
      "$label: the refused sign-up frees its email claim, so the retry 90 s later (new userName) claims it",
      async ({ env, code, refused, retry }) => {
        const { handler } = loadModule(env);
        const emailKey = keyFor(R2_EMAIL);

        await expect(handler(refused())).rejects.toThrow(new RegExp(`^${code}$`));
        // Cognito never creates REFUSED_USER; the person updates the app and taps Create account again.
        jest.setSystemTime(NOW.getTime() + 90_000);
        (console.log as jest.Mock).mockClear();
        cognitoCalls.length = 0;
        const event = retry();

        await expect(handler(event)).resolves.toBe(event);

        expect(mockTable.get(`EMAIL#${emailKey}`)?.userName).toEqual({ S: NEW_USER });
        expect(cognitoCalls).toEqual([]);
        expect(metricLines("SignUpFilterHit")).toEqual([]);
        expect(summaryLine()).toMatchObject({ outcome: "allowed" });
        expect(summaryLine().checks[1]).toMatchObject({ check: "emailBase", result: "allow", claim: "claimed" });
        // The release: a strongly consistent read, then one conditional PutItem (the grants it already has), no
        // delete. REFUSED_USER was the only holder, so the item names no account any more.
        const release = dynamoCalls.findIndex((call) => call.name === "PutItemCommand");
        expect(dynamoCalls[release - 1].input).toEqual({
          TableName: TABLE,
          Key: { pk: { S: `EMAIL#${emailKey}` } },
          ConsistentRead: true,
        });
        expect(dynamoCalls[release].input).toEqual({
          TableName: TABLE,
          Item: { pk: { S: `EMAIL#${emailKey}` }, releasedAt: { S: NOW.toISOString() }, revision: REVISION },
          ConditionExpression: "#revision = :seenRevision",
          ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: { ":seenRevision": { S: expect.any(String) } },
        });
        expect(dynamoCalls.filter((call) => call.name === "DeleteItemCommand")).toEqual([]);
      },
    );

    it("the release leaves a claim alone that names another account by then", async () => {
      const { releaseBaseAddressClaim } = loadModule();
      seedClaim(R2_EMAIL, OLD_USER);
      const before = new Map(mockTable);

      const result = await releaseBaseAddressClaim({
        db: { send: mockDynamoSend },
        tableName: TABLE,
        userName: REFUSED_USER,
        emailKey: keyFor(R2_EMAIL),
        now: Date.now,
      });

      expect(result).toEqual({ outcome: "not_held" });
      expect(mockTable).toEqual(before);
    });

    it.each([
      {
        label: "a disposable domain",
        email: "someone@mailinator.com",
        message: DISPOSABLE_EMAIL_MESSAGE,
        ran: ["disposableDomain"],
        seed: () => undefined,
      },
      {
        label: "a +tag of a live account's address",
        email: "voter+2@example.com",
        message: EMAIL_VARIANT_MESSAGE,
        ran: ["disposableDomain", "emailBase"],
        seed: () => {
          seedClaim(R2_EMAIL, OLD_USER);
          seedUser(OLD_USER, "CONFIRMED", 100);
        },
      },
    ])("INT-05 rejects first ($label): its sentence, and no attestation state touched (C3 7.1)", async (row) => {
      const { handler } = loadModule({
        ...OBSERVE_ENV,
        SIGNUP_FILTER_MODE: "enforce",
        APP_ATTEST_MODE: "enforce",
        DEVICE_CHECK_MODE: "enforce",
      });
      row.seed();
      registerKey();
      const { challenge, marker } = signUpAssertion({ email: row.email });

      await expect(handler(r2SignUp({ email: row.email, marker, deviceToken: DEVICE_TOKEN }))).rejects.toThrow(
        row.message,
      );

      expect(appAttestTable.calls).toEqual([]);
      expect(appAttestTable.get(challengeItemKey(challenge))?.consumedAt).toBeUndefined();
      expect(signupCount()).toEqual({ N: "0" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(secretIds()).not.toContain(DEVICE_CHECK_SECRET);
      expect(appAttestLines()).toEqual([]);
      const summary = summaryLine();
      expect(summary).toMatchObject({ outcome: "rejected", rejectedBy: row.ran[row.ran.length - 1] });
      expect(summary.appAttest).toBeUndefined();
      expect(summary.checks.map((report: LogLine) => report.check)).toEqual(row.ran);
    });

    it.each([
      ["PreSignUp_AdminCreateUser", "admin"],
      ["PreSignUp_ExternalProvider", "other"],
    ])(
      "%s passes unchecked in enforce, recorded as %s, with no table or Apple call",
      async (triggerSource, outcome) => {
        const { handler } = loadModule({
          ...OBSERVE_ENV,
          SIGNUP_FILTER_MODE: "enforce",
          APP_ATTEST_MODE: "enforce",
          DEVICE_CHECK_MODE: "enforce",
        });
        const event = r2SignUp({ triggerSource, marker: "v1.b" });

        await expect(handler(event)).resolves.toBe(event);

        expect(mockDynamoSend).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mockSecretsSend).not.toHaveBeenCalled();
        expect(appAttestLines()).toEqual([
          expect.objectContaining({ AppAttestRequests: 1, Route: "signup", Outcome: outcome, blocked: false }),
        ]);
        expect(summaryLine()).toMatchObject({ triggerSource, outcome, appAttest: outcome });
      },
    );
  });

  describe("time limits (X4)", () => {
    it("App Attest stops itself at 1.2 s minus headroom: outcome error, one AppAttestErrors, the sign-up goes on", async () => {
      const { handler, APP_ATTEST_CHECK_BUDGET } = loadModule(OBSERVE_ENV);
      registerKey();
      appAttestTable.delayMs = 60_000;
      const event = r2SignUp({ marker: signUpAssertion().marker });
      let settled = false;

      const pending = handler(event).finally(() => (settled = true));
      await jest.advanceTimersByTimeAsync(APP_ATTEST_CHECK_BUDGET.ms - 51);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBe(event);
      expect(APP_ATTEST_CHECK_BUDGET.ms).toBe(1_200);
      expect(appAttestTable.calls.map((call) => call.command)).toEqual(["UpdateItemCommand"]);
      expect(dynamoCalls.find((call) => tableOf(call.input) === APP_ATTEST_TABLE)?.abortSignal?.aborted).toBe(true);
      expect(appAttestMetric("AppAttestErrors")).toHaveLength(1);
      expect(appAttestMetric("AppAttestRequests", { Outcome: "error" })).toEqual([
        expect.objectContaining({ reason: "timeout" }),
      ]);
      expect(metricLines("PreSignUpCheckError")).toEqual([]);
      expect(summaryLine()).toMatchObject({
        outcome: "allowed",
        appAttest: "error",
        checks: [{}, {}, { check: "appAttest", result: "allow", outcome: "error", detail: "timeout", ms: 1_150 }, {}],
      });
    });

    it("so APP_ATTEST_FAIL_CLOSED still decides a timeout under enforce: APP_ATTEST_UNAVAILABLE", async () => {
      const { handler } = loadModule({ ...OBSERVE_ENV, APP_ATTEST_MODE: "enforce", APP_ATTEST_FAIL_CLOSED: "true" });
      registerKey();
      appAttestTable.delayMs = 60_000;

      const rejected = expect(handler(r2SignUp({ marker: signUpAssertion().marker }))).rejects.toThrow(
        /^APP_ATTEST_UNAVAILABLE$/,
      );
      await jest.advanceTimersByTimeAsync(1_150);

      await rejected;
      expect(summaryLine()).toMatchObject({ outcome: "rejected", rejectedBy: "appAttest", appAttest: "error" });
    });

    it("the shared 3.5 s deadline cuts DeviceCheck when its secret read hangs: AppAttestErrors, sign-up allowed", async () => {
      const { handler, SIGN_UP_DEADLINE_MS } = loadModule(DEVICE_CHECK_WATCH);
      mockSecretsSend.mockImplementation((command: { input: { SecretId?: string } }) =>
        command.input.SecretId === DEVICE_CHECK_SECRET ? new Promise(() => undefined) : secretsByName(command),
      );
      const event = r2SignUp({ deviceToken: DEVICE_TOKEN });
      let settled = false;

      const pending = handler(event).finally(() => (settled = true));
      await jest.advanceTimersByTimeAsync(SIGN_UP_DEADLINE_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBe(event);
      expect(fetchSpy).not.toHaveBeenCalled();
      const [errorLine] = appAttestMetric("AppAttestErrors");
      expect(errorLine).toMatchObject({ AppAttestErrors: 1, check: "deviceCheck", errorKind: "deadline" });
      expect(errorLine.userName).toBeUndefined();
      expect(metricLines("PreSignUpCheckError")).toEqual([]);
      expect(summaryLine()).toMatchObject({
        outcome: "allowed",
        deviceCheck: "error",
        checks: [{}, {}, { check: "appAttest", outcome: "missing" }, { check: "deviceCheck", errorKind: "deadline" }],
      });
    });

    it("each DeviceCheck call gets min(1.0 s, time left - 0.2 s) of the shared deadline", async () => {
      const timeoutSpy = jest.spyOn(AbortSignal, "timeout");
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      // 700 ms left in the Lambda: the deadline is 700 - 250 = 450 ms away, so each call gets 450 - 200 = 250 ms.
      const context = { awsRequestId: "req-1", getRemainingTimeInMillis: () => 700 };

      await handler(r2SignUp({ deviceToken: DEVICE_TOKEN }), context);

      expect(applePaths()).toEqual(["/v1/query_two_bits", "/v1/update_two_bits"]);
      expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([250, 250]);
      expect(summaryLine()).toMatchObject({ outcome: "allowed", deviceCheck: "not_found" });
    });

    it("with less than 0.2 s to the deadline DeviceCheck makes no Apple call and fails open", async () => {
      const { handler } = loadModule(DEVICE_CHECK_WATCH);
      // 400 ms left: the deadline is 150 ms away, under the 200 ms DeviceCheck keeps in reserve.
      const context = { awsRequestId: "req-1", getRemainingTimeInMillis: () => 400 };

      await handler(r2SignUp({ deviceToken: DEVICE_TOKEN }), context);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(appAttestMetric("AppAttestErrors")).toHaveLength(1);
      expect(summaryLine()).toMatchObject({ outcome: "allowed", deviceCheck: "error" });
    });
  });
});

// ─── The filter check's probes (CB-07) ──────────────────────────────────────────────────────────────

describe("the sign-up funnel (REL-53, feature review S17)", () => {
  const CHECK = "filter-probe@billboard-project.com";
  const PROBE_ENV = {
    ...BASE_ENV,
    SIGNUP_FILTER_CHECK_ADDRESS: CHECK,
    SIGNUP_PROBE_TOKEN_SECRET_ARN: PROBE_TOKEN_SECRET,
  };
  const funnelLines = () => metricLines("SignUpAllowed");

  it("a real sign-up let through emits SignUpAllowed=1 in BillBoard/Accounts: no dimensions, no account ID, no address", async () => {
    const { handler, ACCOUNTS_NAMESPACE, SIGN_UP_ALLOWED_METRIC } = loadModule(PROBE_ENV);

    await handler(signUpEvent("Jane.Doe@example.com"));

    expect([ACCOUNTS_NAMESPACE, SIGN_UP_ALLOWED_METRIC]).toEqual(["BillBoard/Accounts", "SignUpAllowed"]);
    const [line] = funnelLines();
    expect(funnelLines()).toHaveLength(1);
    expect(line.SignUpAllowed).toBe(1);
    expect(line._aws!.CloudWatchMetrics).toEqual([
      { Namespace: "BillBoard/Accounts", Dimensions: [[]], Metrics: [{ Name: "SignUpAllowed", Unit: "Count" }] },
    ]);
    expect(line.userName).toBeUndefined();
    expect(line.probe).toBeUndefined();
    expect(JSON.stringify(line)).not.toContain(NEW_USER);
    expect(JSON.stringify(line)).not.toMatch(/jane|example\.com|@/i);
    // The handler's own summary line keeps its userName.
    expect(summaryLine().userName).toBe(NEW_USER);
  });

  it("watch: a filter hit is still a sign-up let through, so it counts", async () => {
    const { handler } = loadModule();
    seedClaim("jane@example.com", OLD_USER);
    seedUser(OLD_USER, "CONFIRMED", 100);

    await handler(signUpEvent("jane+x@example.com"));

    expect(metricLines("SignUpFilterHit")).toHaveLength(1);
    expect(funnelLines()).toHaveLength(1);
  });

  it("enforce: a refused sign-up does not count", async () => {
    const { handler } = loadModule({ ...BASE_ENV, SIGNUP_FILTER_MODE: "enforce" });

    await expect(handler(signUpEvent("someone@mailinator.com"))).rejects.toThrow(DISPOSABLE_EMAIL_MESSAGE);

    expect(funnelLines()).toEqual([]);
  });

  it.each([CHECK, "filter-probe+r20261008abcd@billboard-project.com"])(
    "the filter check's probe %s does not count",
    async (email) => {
      const { handler } = loadModule(PROBE_ENV);

      await handler(withProbeToken(signUpEvent(email)));

      expect(summaryLine()).toMatchObject({ outcome: "allowed" });
      expect(funnelLines()).toEqual([]);
    },
  );

  it.each(["PreSignUp_AdminCreateUser", "PreSignUp_ExternalProvider"])("%s does not count", async (triggerSource) => {
    const { handler } = loadModule();

    await handler(signUpEvent("jane@example.com", { triggerSource }));

    expect(funnelLines()).toEqual([]);
  });

  it("a sign-up that fails open on a check error still counts once", async () => {
    const { handler } = loadModule({ ...BASE_ENV, HASH_SALT_SECRET_ARN: undefined });

    await handler(signUpEvent("jane@example.com"));

    expect(metricLines("PreSignUpCheckError")).toHaveLength(1);
    expect(funnelLines()).toHaveLength(1);
  });
});

describe("the filter check's probes (CB-07)", () => {
  const CHECK = "filter-probe@billboard-project.com";
  const VARIANT = "filter-probe+r20261008abcd@billboard-project.com";
  const PROBE_ENV = {
    ...BASE_ENV,
    SIGNUP_FILTER_CHECK_ADDRESS: CHECK,
    SIGNUP_PROBE_TOKEN_SECRET_ARN: PROBE_TOKEN_SECRET,
  };
  const probeRecord = (kind: ProbeKind) => fromProbeRecordItem(mockTable.get(`PROBE#${kind}`));
  const probePuts = () =>
    dynamoCalls.filter((call) => call.name === "PutItemCommand" && call.input.Item!.pk.S!.startsWith("PROBE#"));
  const allLines = (): LogLine[] => [console.log, console.warn, console.error].flatMap((spy) => logLines(spy));
  /** The probe's base address held by a live account, so a +tag of it is a hit. */
  const holdBase = (address = CHECK) => {
    seedClaim(address, OLD_USER, NOW.toISOString());
    seedUser(OLD_USER, "UNCONFIRMED", 1);
  };

  describe("detection: from the address Cognito validated, with the filter's own parsing", () => {
    it.each([
      [CHECK, "base"],
      ["Filter-Probe@Billboard-Project.com", "base"],
      ["filter-probe@billboard-project.com.", "base"],
      [VARIANT, "variant"],
      ["FILTER-PROBE+News@billboard-project.com", "variant"],
      ["filter-probe+@billboard-project.com", "variant"],
    ] as const)("%s is a %s probe", async (email, kind) => {
      const { handler } = loadModule(PROBE_ENV);

      await handler(withProbeToken(signUpEvent(email)));

      expect(summaryLine().probe).toBe(kind);
      expect(probeRecord(kind)).toMatchObject({ kind, userName: NEW_USER, mode: "watch", outcome: "allowed" });
      expect(probePuts()).toHaveLength(1);
    });

    it.each([
      ["filter-prober@billboard-project.com", PROBE_ENV],
      ["filter-probe@billboard-project.com.evil.example", PROBE_ENV],
      ["filter-probe@other.example", PROBE_ENV],
      ["admin+filter-probe@billboard-project.com", PROBE_ENV],
      ["+filter-probe@billboard-project.com", PROBE_ENV],
      [CHECK, BASE_ENV],
      [CHECK, { ...BASE_ENV, SIGNUP_FILTER_CHECK_ADDRESS: "Filter-Probe@billboard-project.com" }],
      [CHECK, { ...BASE_ENV, SIGNUP_FILTER_CHECK_ADDRESS: "filter-probe@example.com" }],
      ["filterprobe+x@gmail.com", { ...BASE_ENV, SIGNUP_FILTER_CHECK_ADDRESS: "filterprobe@gmail.com" }],
    ])("%s is not a probe (case %#)", async (email, env) => {
      const { handler } = loadModule(env);

      await handler(withProbeToken(signUpEvent(email)));

      expect(summaryLine().probe).toBeUndefined();
      expect(probePuts()).toEqual([]);
      expect([...mockTable.keys()].filter((key) => key.startsWith("PROBE#"))).toEqual([]);
    });

    it("a ClientMetadata claim of being a test changes nothing: only the email decides", async () => {
      const { handler } = loadModule(PROBE_ENV);
      const event = signUpEvent("jane@example.com");
      event.request.clientMetadata = { probe: "base", signUpFilterCheck: "true" };
      (event.request as Record<string, unknown>).validationData = { probe: "variant" };

      await handler(event);

      expect(summaryLine().probe).toBeUndefined();
      expect(probePuts()).toEqual([]);
    });

    it("never throws: a failing detection treats the sign-up as ordinary (allowed, SignUpFilterHit, no record)", async () => {
      restoreEnv?.();
      restoreEnv = applyTestEnv(PROBE_ENV);
      let handler: typeof PreSignUpModule.handler | undefined;
      jest.isolateModules(() => {
        jest.doMock("../shared/signUpFilter", () => ({
          ...jest.requireActual("../shared/signUpFilter"),
          probeKindOf: () => {
            throw new TypeError("detection failed");
          },
        }));
        handler = require("../handlers/preSignUp").handler;
      });
      jest.dontMock("../shared/signUpFilter");
      holdBase();
      const event = withProbeToken(signUpEvent(VARIANT));

      await expect(handler!(event)).resolves.toBe(event);

      expect(metricLines("SignUpFilterHit")).toHaveLength(1);
      expect(metricLines("SignUpProbeHit")).toEqual([]);
      expect(summaryLine()).toMatchObject({ outcome: "allowed" });
      expect(summaryLine().probe).toBeUndefined();
      expect(probePuts()).toEqual([]);
      const warning = logLines(console.warn).find((line) => line.message === "Sign-up probe detection failed");
      expect(warning).toMatchObject({ errorName: "TypeError" });
      expect(consoleText()).not.toContain("@");
    });
  });

  describe("the probe token (INF-15): the public address alone makes no probe", () => {
    const tokenReads = () =>
      mockSecretsSend.mock.calls.filter(([command]) => command.input?.SecretId === PROBE_TOKEN_SECRET);

    it("without the token, a +tag of the check address is an ordinary sign-up: real labels, no record, it counts", async () => {
      const { handler } = loadModule(PROBE_ENV);
      holdBase();

      await handler(signUpEvent(VARIANT));

      expect(summaryLine().probe).toBeUndefined();
      expect(metricLines("SignUpFilterHit")).toHaveLength(1);
      expect(metricLines("SignUpProbeHit")).toEqual([]);
      expect(metricLines("SignUpAllowed")).toHaveLength(1);
      expect(probePuts()).toEqual([]);
      expect(tokenReads()).toEqual([]);
      expect(
        logLines(console.log).find((line) => line.message?.startsWith("Sign-up to the check address without")),
      ).toMatchObject({ checkAddress: "variant" });
    });

    it("enforce: without the token, the check address's +tag is refused like anyone's, and writes no record", async () => {
      const { handler } = loadModule({ ...PROBE_ENV, SIGNUP_FILTER_MODE: "enforce" });
      holdBase();

      await expect(handler(signUpEvent(VARIANT))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

      expect(metricLines("SignUpRejected")).toHaveLength(1);
      expect(metricLines("SignUpProbeRejected")).toEqual([]);
      expect(probePuts()).toEqual([]);
    });

    it("a wrong token: an ordinary sign-up, and neither token is ever logged", async () => {
      const { handler } = loadModule(PROBE_ENV);
      const wrong = "wrong-token-0123456789abcdefghijklmnopqrstuvwxyz";

      await handler(withProbeToken(signUpEvent(CHECK), wrong));

      expect(summaryLine().probe).toBeUndefined();
      expect(probePuts()).toEqual([]);
      expect(tokenReads()).toHaveLength(1);
      expect(
        logLines(console.log).find((line) => line.message?.startsWith("Sign-up to the check address with a wrong")),
      ).toMatchObject({ checkAddress: "base" });
      expect(consoleText()).not.toContain(PROBE_TOKEN);
      expect(consoleText()).not.toContain(wrong);
    });

    it("an unreadable token secret: an ordinary sign-up and a warning, so the daily check fails and says so", async () => {
      const { handler } = loadModule(PROBE_ENV);
      mockSecretsSend.mockImplementation(async (command: { input?: { SecretId?: string } }) => {
        if (command.input?.SecretId === PROBE_TOKEN_SECRET) throw awsError("AccessDeniedException");
        return secretsByName(command);
      });

      await handler(withProbeToken(signUpEvent(CHECK)));

      expect(summaryLine()).toMatchObject({ outcome: "allowed" });
      expect(summaryLine().probe).toBeUndefined();
      expect(probePuts()).toEqual([]);
      expect(
        logLines(console.warn).find((line) => line.message?.startsWith("Sign-up probe token not read")),
      ).toMatchObject({ checkAddress: "base", errorKind: "exception", errorName: "AccessDeniedException" });
    });

    it("no token secret configured: an ordinary sign-up", async () => {
      const { handler } = loadModule({ ...PROBE_ENV, SIGNUP_PROBE_TOKEN_SECRET_ARN: undefined });

      await handler(withProbeToken(signUpEvent(CHECK)));

      expect(summaryLine().probe).toBeUndefined();
      expect(probePuts()).toEqual([]);
      expect(tokenReads()).toEqual([]);
    });

    it("reads the token once per container, and never for an ordinary address, whatever its metadata", async () => {
      const { handler } = loadModule(PROBE_ENV);

      await handler(withProbeToken(signUpEvent("jane@example.com")));
      expect(tokenReads()).toEqual([]);
      await handler(withProbeToken(signUpEvent(CHECK)));
      await handler(withProbeToken(signUpEvent(VARIANT), PROBE_TOKEN));

      expect(tokenReads()).toHaveLength(1);
      expect(probePuts()).toHaveLength(2);
    });
  });

  describe("labels: the probe metrics, never the real ones", () => {
    it("watch: a probe hit is SignUpProbeHit; SignUpFilterHit and SignUpRejected are never emitted", async () => {
      const { handler } = loadModule(PROBE_ENV);
      holdBase();

      await handler(withProbeToken(signUpEvent(VARIANT)));

      expect(metricLines("SignUpProbeHit")).toEqual([
        expect.objectContaining({
          SignUpProbeHit: 1,
          check: "emailBase",
          reason: "email_variant_exists",
          mode: "watch",
        }),
      ]);
      expect(metricNamespaces("SignUpProbeHit")).toEqual(["BillBoard/AccountIntegrity"]);
      expect(metricLines("SignUpFilterHit")).toEqual([]);
      expect(metricLines("SignUpRejected")).toEqual([]);
      expect(metricLines("SignUpProbeRejected")).toEqual([]);
    });

    it("enforce: SignUpProbeHit and SignUpProbeRejected, the same thrown message, no real metric", async () => {
      const { handler } = loadModule({ ...PROBE_ENV, SIGNUP_FILTER_MODE: "enforce" });
      holdBase();

      await expect(handler(withProbeToken(signUpEvent(VARIANT)))).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

      const [line] = metricLines("SignUpProbeHit");
      expect(line).toMatchObject({ SignUpProbeHit: 1, SignUpProbeRejected: 1, mode: "enforce" });
      expect(metricLines("SignUpFilterHit")).toEqual([]);
      expect(metricLines("SignUpRejected")).toEqual([]);
    });

    it("PreSignUpCheckError stays shared: an error during a probe is a real filter fault", async () => {
      const { handler } = loadModule({ ...PROBE_ENV, HASH_SALT_SECRET_ARN: undefined });

      await handler(withProbeToken(signUpEvent(CHECK)));

      expect(metricLines("PreSignUpCheckError")).toEqual([
        expect.objectContaining({ PreSignUpCheckError: 1, check: "emailBase", probe: "base" }),
      ]);
      expect(probeRecord("base")?.checks).toEqual(
        expect.arrayContaining([{ check: "emailBase", result: "error", errorKind: "exception" }]),
      );
    });

    it("an address that only looks like the check's (admin+x@ on the project domain) is a real hit", async () => {
      const { handler } = loadModule(PROBE_ENV);
      holdBase("admin@billboard-project.com");

      await handler(signUpEvent("admin+x@billboard-project.com"));

      expect(metricLines("SignUpFilterHit")).toHaveLength(1);
      expect(metricLines("SignUpProbeHit")).toEqual([]);
    });

    it("every line of a probe invocation carries probe, the App Attest lines (which drop userName) included", async () => {
      const { handler } = loadModule({
        ...OBSERVE_ENV,
        SIGNUP_FILTER_CHECK_ADDRESS: CHECK,
        SIGNUP_PROBE_TOKEN_SECRET_ARN: PROBE_TOKEN_SECRET,
      });
      holdBase();

      await handler(withProbeToken(signUpEvent(VARIANT)));

      const lines = allLines();
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines)
        expect({ message: line.message, probe: line.probe }).toEqual({ message: line.message, probe: "variant" });
      const appAttest = lines.filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/AppAttest");
      expect(appAttest.length).toBeGreaterThan(0);
      for (const line of appAttest) expect(line.userName).toBeUndefined();
      // The logger key, not a property that would replace it with a boolean.
      expect(metricLines("SignUpProbeHit")[0].probe).toBe("variant");
    });

    it("a warm container: after a probe, the next real sign-up has no probe key and emits SignUpFilterHit", async () => {
      const { handler } = loadModule(PROBE_ENV);
      holdBase();
      seedClaim("jane@example.com", "6c1e8a52-0000-4000-8000-000000000009");
      seedUser("6c1e8a52-0000-4000-8000-000000000009", "CONFIRMED", 100);

      await handler(withProbeToken(signUpEvent(VARIANT)), {
        awsRequestId: "probe",
        getRemainingTimeInMillis: () => 5_000,
      });
      (console.log as jest.Mock).mockClear();
      (console.warn as jest.Mock).mockClear();
      await handler(signUpEvent("jane+x@example.com", { userName: REFUSED_USER }), {
        awsRequestId: "real",
        getRemainingTimeInMillis: () => 5_000,
      });

      expect(metricLines("SignUpFilterHit")).toHaveLength(1);
      expect(metricLines("SignUpProbeHit")).toEqual([]);
      for (const line of allLines()) expect(line.probe).toBeUndefined();
    });
  });

  describe("decision parity: a probe gets exactly the decision, claim writes and message a real sign-up gets", () => {
    const FILTER_MODES = ["watch", "enforce"] as const;
    const ATTEST_MODES = ["off", "watch", "enforce"] as const;
    const cases = FILTER_MODES.flatMap((filter) =>
      ATTEST_MODES.flatMap((appAttest) =>
        ATTEST_MODES.flatMap((deviceCheck) =>
          (["fresh", "held"] as const).map((scenario) => ({ filter, appAttest, deviceCheck, scenario })),
        ),
      ),
    );

    const resetState = () => {
      mockTable.clear();
      mockUsers.clear();
      dynamoCalls.length = 0;
      cognitoCalls.length = 0;
      callOrder.length = 0;
      appAttestTable = new FakeAppAttestTable();
    };

    /** The decision and the claims-table writes of one sign-up, with key values and times left out. */
    const decide = async (env: Record<string, string | undefined>, base: string, address: string, held: boolean) => {
      resetState();
      const { handler } = loadModule(env);
      if (held) {
        seedClaim(base, OLD_USER);
        seedUser(OLD_USER, "CONFIRMED", 100);
      }
      let outcome: string;
      try {
        await handler(withProbeToken(signUpEvent(address)));
        outcome = "allowed";
      } catch (error) {
        outcome = `refused: ${(error as Error).message}`;
      }
      const writes = dynamoCalls
        .filter((call) => call.input?.TableName === TABLE || call.input?.TransactItems)
        .filter((call) => !(call.name === "PutItemCommand" && call.input.Item!.pk.S!.startsWith("PROBE#")))
        .map((call) =>
          JSON.stringify(call.input)
            .replace(/EMAIL#[0-9a-f]{64}/g, "EMAIL#<key>")
            .replace(/"(emailKey|addressKey)":\{"S":"[0-9a-f]{64}"\}/g, '"$1":<key>')
            .replace(/"(revision|:seenRevision)":\{"S":"[0-9a-f-]{36}"\}/g, '"$1":<revision>')
            .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>"),
        );
      return { outcome, writes, names: dynamoCalls.map((call) => call.name) };
    };

    it.each(cases)("filter $filter, App Attest $appAttest, DeviceCheck $deviceCheck, $scenario", async (input) => {
      const env = {
        ...OBSERVE_ENV,
        SIGNUP_FILTER_CHECK_ADDRESS: CHECK,
        SIGNUP_PROBE_TOKEN_SECRET_ARN: PROBE_TOKEN_SECRET,
        SIGNUP_FILTER_MODE: input.filter,
        APP_ATTEST_MODE: input.appAttest,
        DEVICE_CHECK_MODE: input.deviceCheck,
      };
      const held = input.scenario === "held";
      const real = await decide(
        env,
        "jane@billboard-project.com",
        held ? "jane+r20261008abcd@billboard-project.com" : "jane@billboard-project.com",
        held,
      );
      const probe = await decide(env, CHECK, held ? VARIANT : CHECK, held);

      expect(probe.outcome).toBe(real.outcome);
      expect(probe.writes).toEqual(real.writes);
      expect(probe.names.filter((name) => name !== "PutItemCommand")).toEqual(
        real.names.filter((name) => name !== "PutItemCommand"),
      );
      // The probe adds exactly its record.
      expect(probe.names.filter((name) => name === "PutItemCommand")).toHaveLength(
        real.names.filter((name) => name === "PutItemCommand").length + 1,
      );
    });
  });

  describe("the probe record", () => {
    it("has the exact layout, and is written after the summary line and before the enforce throw", async () => {
      const { handler } = loadModule({ ...PROBE_ENV, SIGNUP_FILTER_MODE: "enforce" });
      holdBase();
      (console.log as jest.Mock).mockImplementation((line: string) => {
        try {
          const message = JSON.parse(line).message;
          if (message) callOrder.push(`log:${message}`);
        } catch {
          // not a JSON line
        }
      });

      await expect(
        handler(withProbeToken(signUpEvent(VARIANT)), {
          awsRequestId: "req-probe",
          getRemainingTimeInMillis: () => 5_000,
        }),
      ).rejects.toThrow(EMAIL_VARIANT_MESSAGE);

      expect(callOrder.slice(-2)).toEqual(["log:Pre-sign-up checks", `${TABLE}:PutItemCommand`]);
      expect(mockTable.get("PROBE#variant")).toEqual({
        pk: { S: "PROBE#variant" },
        kind: { S: "variant" },
        userName: { S: NEW_USER },
        at: { S: NOW.toISOString() },
        mode: { S: "enforce" },
        outcome: { S: "rejected" },
        rejectedBy: { S: "emailBase" },
        reason: { S: "email_variant_exists" },
        checks: {
          L: [
            { M: { check: { S: "disposableDomain" }, result: { S: "allow" } } },
            {
              M: {
                check: { S: "emailBase" },
                result: { S: "hit" },
                reason: { S: "email_variant_exists" },
                claim: { S: "variant_exists" },
              },
            },
          ],
        },
        requestId: { S: "req-probe" },
        tag: { S: "r20261008abcd" },
        holder: { S: OLD_USER },
      });
      // Unconditional: it overwrites the previous probe's record.
      expect(probePuts()[0].input.ConditionExpression).toBeUndefined();
      expect(JSON.stringify(mockTable.get("PROBE#variant"))).not.toContain("@");
    });

    it.each([
      ["filter-probe+r20261008abcd@billboard-project.com", "r20261008abcd"],
      ["filter-probe+news@billboard-project.com", "other"],
      ["filter-probe+r2026@billboard-project.com", "other"],
      ["filter-probe+R20261008ABCD@billboard-project.com", "r20261008abcd"],
      ["filter-probe+@billboard-project.com", "other"],
    ])("%s is stored with tag %s, never the address", async (email, tag) => {
      const { handler } = loadModule(PROBE_ENV);

      await handler(withProbeToken(signUpEvent(email)));

      expect(probeRecord("variant")).toMatchObject({ tag });
    });

    it("a base record has no tag, and names the claim it made", async () => {
      const { handler } = loadModule(PROBE_ENV);

      await handler(withProbeToken(signUpEvent(CHECK)));

      const record = probeRecord("base")!;
      expect(record.tag).toBeUndefined();
      expect(record.holder).toBeUndefined();
      expect(record.checks).toEqual(
        expect.arrayContaining([{ check: "emailBase", result: "allow", claim: "claimed" }]),
      );
    });

    it("a failed write is a warning: the sign-up gets the same decision and message", async () => {
      const { handler } = loadModule({ ...PROBE_ENV, SIGNUP_FILTER_MODE: "enforce" });
      holdBase();
      dynamoOverride.PutItemCommand = async () => {
        throw awsError("ProvisionedThroughputExceededException");
      };

      await expect(handler(withProbeToken(signUpEvent(VARIANT)))).rejects.toThrow(
        new RegExp(`^${EMAIL_VARIANT_MESSAGE.replace(/[().+]/g, "\\$&")}$`),
      );

      expect(logLines(console.warn).find((line) => line.message === "Sign-up probe record not written")).toMatchObject({
        probe: "variant",
        errorKind: "exception",
      });
      expect(summaryLine()).toMatchObject({ outcome: "rejected", rejectedBy: "emailBase" });
    });

    it("stops the write after 500 ms and aborts it; the sign-up then goes on", async () => {
      const { handler, PROBE_RECORD_TIMEOUT_MS } = loadModule(PROBE_ENV);
      dynamoOverride.PutItemCommand = async (call) => hangUntilAborted(call);
      const event = withProbeToken(signUpEvent(CHECK));
      let settled = false;

      const pending = handler(event).finally(() => (settled = true));
      await jest.advanceTimersByTimeAsync(PROBE_RECORD_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);

      await expect(pending).resolves.toBe(event);
      expect(PROBE_RECORD_TIMEOUT_MS).toBe(500);
      expect(dynamoCalls.at(-1)).toMatchObject({
        name: "PutItemCommand",
        input: { Item: { pk: { S: "PROBE#base" } } },
      });
      expect(dynamoCalls.at(-1)?.abortSignal?.aborted).toBe(true);
      expect(logLines(console.warn).find((line) => line.message === "Sign-up probe record not written")).toMatchObject({
        errorKind: "timeout",
      });
    });

    it("never runs past 4.5 s from the start of the invocation, nor past the Lambda's own time", async () => {
      const { handler, PROBE_RECORD_DEADLINE_MS } = loadModule(PROBE_ENV);
      dynamoOverride.PutItemCommand = async (call) => hangUntilAborted(call);
      // The checks take 4.3 s of wall time without running any timer (a slow GetItem).
      dynamoOverride.GetItemCommand = async (call) => {
        jest.setSystemTime(NOW.getTime() + 4_300);
        return { Item: mockTable.get(call.input.Key!.pk.S!) };
      };
      let settled = false;

      const pending = handler(withProbeToken(signUpEvent(CHECK))).finally(() => (settled = true));
      await jest.advanceTimersByTimeAsync(199);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await pending;

      expect(PROBE_RECORD_DEADLINE_MS).toBe(4_500);
      expect(logLines(console.warn).find((line) => line.message === "Sign-up probe record not written")).toMatchObject({
        errorKind: "timeout",
      });
    });

    it("with too little time left it does not write at all", async () => {
      const { handler } = loadModule(PROBE_ENV);

      await handler(withProbeToken(signUpEvent(CHECK)), { awsRequestId: "late", getRemainingTimeInMillis: () => 200 });

      expect(probePuts()).toEqual([]);
      expect(logLines(console.warn).find((line) => line.message === "Sign-up probe record not written")).toMatchObject({
        errorKind: "deadline",
      });
    });
  });
});
