import { APP_ATTEST_DEFAULTS } from "../shared/abuseLimits";
import { appAttestConfigFromEnv } from "../shared/appAttest/config";
import type { DeviceCheckClient } from "../shared/appAttest/deviceCheck";
import {
  evaluateRequestAttestation,
  evaluateSignUp,
  evaluateSignUpAttestation,
  evaluateSignUpDeviceCheck,
  signUpRejectionError,
  type SignUpEventLike,
} from "../shared/appAttest/evaluate";
import { AppAttestStore, bindingItemKey, keyItemKey } from "../shared/appAttest/store";
import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { applyTestEnv } from "./fixtures/env";
import type { LogLine } from "./logLines";
import {
  FakeAppAttestTable,
  assertionAuthData,
  assertionMarker,
  challengeOf,
  challengeRow,
  generateDeviceKey,
  keyRow,
  requestClientData,
  signAssertion,
  signUpClientData,
  type DeviceKey,
} from "./fixtures/appAttest/helpers";

const NOW = new Date("2026-10-08T12:00:00.000Z");
/** Accounts (and sign-ups) one install's key may carry, and the exempt group: the defaults the config falls back to. */
const LIMIT = APP_ATTEST_DEFAULTS.maxAccountsPerKey;
const EXEMPT = APP_ATTEST_DEFAULTS.exemptGroup;
const BODY = '{"billId":"BILLS-119hr1","feedback":"Yea"}';
const EMAIL = "voter@example.com";

let table: FakeAppAttestTable;
let store: AppAttestStore;
let device: DeviceKey;
let logSpy: jest.SpyInstance;
let challengeCounter = 0;

const config = (env: Record<string, string> = {}) =>
  appAttestConfigFromEnv({ APP_ATTEST_TABLE_NAME: "AppAttest", APP_ATTEST_MODE: "watch", ...env });
const deps = (env: Record<string, string> = {}) => ({ config: config(env), store, now: () => NOW });

interface EmfLine {
  names: string[];
  dimensions: Record<string, string>;
  line: LogLine;
}

/** The EMF lines written so far (namespace BillBoard/AppAttest). */
const emf = (): EmfLine[] =>
  logSpy.mock.calls.flatMap(([text]) => {
    if (typeof text !== "string" || !text.includes('"_aws"')) return [];
    const line = JSON.parse(text) as LogLine;
    const directive = line._aws!.CloudWatchMetrics[0];
    if (directive.Namespace !== "BillBoard/AppAttest") return [];
    const dimensions: Record<string, string> = {};
    for (const name of directive.Dimensions[0]) dimensions[name] = line[name] as string;
    return [{ names: directive.Metrics.map((metric: { Name: string }) => metric.Name), dimensions, line }];
  });
const metricCount = (name: string, dimensions?: Record<string, string>): number =>
  emf().filter(
    (entry) =>
      entry.names.includes(name) &&
      (!dimensions || Object.entries(dimensions).every(([k, v]) => entry.dimensions[k] === v)),
  ).length;

beforeEach(() => {
  table = new FakeAppAttestTable();
  store = new AppAttestStore("AppAttest", table);
  device = generateDeviceKey();
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

const registerKey = (overrides: Partial<Parameters<typeof keyRow>[0]> = {}) =>
  table.put(keyRow({ keyId: device.keyId, publicKeySpki: device.publicKeySpki, ...overrides }));

const freshChallenge = (): string => {
  challengeCounter += 1;
  const challenge = challengeOf(`evaluate-${challengeCounter}`);
  table.put(challengeRow({ challenge, purpose: "assert", expiresAt: new Date(NOW.getTime() + 120_000) }));
  return challenge;
};

const requestMarker = (input: { counter?: number; body?: string; key?: DeviceKey; path?: string } = {}): string => {
  const key = input.key ?? device;
  const clientData = requestClientData({ challenge: freshChallenge(), body: input.body ?? BODY, path: input.path });
  const assertion = signAssertion({
    privateKey: key.privateKey,
    authenticatorData: assertionAuthData({ counter: input.counter ?? 1 }),
    clientData,
  });
  return assertionMarker({ keyId: key.keyId, clientData, assertion });
};

const feedbackEvent = (input: { marker?: string; groups?: unknown; appVersion?: string; body?: string } = {}) =>
  asApiGatewayEvent({
    httpMethod: "POST",
    resource: "/feedback",
    body: input.body ?? BODY,
    headers: {
      "Content-Type": "application/json",
      ...(input.marker !== undefined ? { "X-Billboard-App-Attest": input.marker } : {}),
      ...(input.appVersion !== undefined ? { "X-Billboard-App-Version": input.appVersion } : {}),
    },
    requestContext: {
      authorizer: {
        claims: { sub: "user-1", ...(input.groups !== undefined ? { "cognito:groups": input.groups } : {}) },
      },
    },
  });

describe("off (the code default): nothing at all", () => {
  it("with no APP_ATTEST_* variables: no outcome, no table call, no metric", async () => {
    const restore = applyTestEnv({ APP_ATTEST_MODE: undefined, APP_ATTEST_TABLE_NAME: undefined }, {});
    try {
      const result = await evaluateRequestAttestation(
        feedbackEvent({ marker: requestMarker() }),
        "user-1",
        "feedback",
        {
          store,
        },
      );
      expect(result).toEqual({ mode: "off", exempt: false, blocked: false });
      expect(table.calls.filter((call) => call.command !== "PutItemCommand")).toEqual([]);
      expect(emf()).toEqual([]);
      expect(await evaluateSignUpAttestation({ triggerSource: "PreSignUp_SignUp" }, { store })).toEqual({
        mode: "off",
        decision: "allow",
        replay: false,
      });
      expect(await evaluateSignUpDeviceCheck({ triggerSource: "PreSignUp_SignUp" })).toEqual({
        mode: "off",
        decision: "allow",
      });
    } finally {
      restore();
    }
  });

  it("APP_ATTEST_MODE=watch without a table name is off", async () => {
    const result = await evaluateRequestAttestation(feedbackEvent(), "user-1", "feedback", {
      config: appAttestConfigFromEnv({ APP_ATTEST_MODE: "watch" }),
    });
    expect(result.mode).toBe("off");
    expect(emf()).toEqual([]);
  });

  it("reads the environment when no config is passed", async () => {
    const restore = applyTestEnv({ APP_ATTEST_MODE: "watch", APP_ATTEST_TABLE_NAME: "AppAttest" });
    try {
      const result = await evaluateRequestAttestation(feedbackEvent(), "user-1");
      expect(result).toMatchObject({ mode: "watch", outcome: "missing", blocked: false });
    } finally {
      restore();
    }
  });
});

describe("protected request in watch: records and never blocks", () => {
  it("an old build (no header): outcome missing, zero table calls, one EMF line", async () => {
    const result = await evaluateRequestAttestation(feedbackEvent(), "user-1", "feedback", deps());
    expect(result).toEqual({ mode: "watch", outcome: "missing", exempt: false, blocked: false });
    expect(table.calls).toEqual([]);
    expect(emf()).toHaveLength(1);
    expect(emf()[0]).toMatchObject({
      names: ["AppAttestRequests"],
      dimensions: { Route: "feedback", Outcome: "missing" },
    });
    expect(emf()[0].line).toMatchObject({ mode: "watch", blocked: false, wouldBlock: "APP_UPDATE_REQUIRED" });
  });

  it.each([
    ["v1.u", "unsupported", undefined],
    ["v1.b", "bypass", undefined],
    ["v1.e.timeout", "client_error", "timeout"],
    ["v1.e.mystery", "client_error", "other"],
    ["v2.zzz", "invalid", "marker_unknown_form"],
  ] as const)("marker %s: outcome %s, allowed, no table call", async (marker, outcome, reason) => {
    const result = await evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", deps());
    expect(result).toMatchObject({ outcome, blocked: false, ...(reason ? { reason } : {}) });
    expect(table.calls).toEqual([]);
  });

  it("a valid production assertion: valid, counter advanced, account bound and counted", async () => {
    registerKey({ signCount: 0, accountCount: 0 });
    const result = await evaluateRequestAttestation(
      feedbackEvent({ marker: requestMarker({ counter: 1 }) }),
      "user-1",
      "feedback",
      deps(),
    );
    expect(result).toEqual({ mode: "watch", outcome: "valid", exempt: false, blocked: false });
    expect(table.get(keyItemKey(device.keyId))).toMatchObject({ signCount: { N: "1" }, accountCount: { N: "1" } });
    expect(table.get(bindingItemKey("user-1", device.keyId))).toMatchObject({
      firstSeenAt: { S: NOW.toISOString() },
      lastSeenAt: { S: NOW.toISOString() },
    });
    const line = emf()[0].line;
    expect(line).toMatchObject({
      Outcome: "valid",
      keyIdPrefix: device.keyId.slice(0, 8),
      environment: "production",
      replay: false,
    });
    expect(JSON.stringify(emf())).not.toContain(device.keyId);
    expect(JSON.stringify(emf())).not.toContain("user-1");
  });

  it("a development key: development (allowed in watch)", async () => {
    registerKey({ environment: "development" });
    const result = await evaluateRequestAttestation(
      feedbackEvent({ marker: requestMarker() }),
      "user-1",
      "feedback",
      deps(),
    );
    expect(result).toMatchObject({ outcome: "development", blocked: false });
    expect(emf()[0].line.wouldBlock).toBe("APP_ATTEST_FAILED");
  });

  it("an invalid assertion still lets the vote through and counts AppAttestInvalid", async () => {
    registerKey();
    const marker = requestMarker({ key: generateDeviceKey() }).replace(/^v1\.a\.[^.]+/, `v1.a.${device.keyId}`);
    const result = await evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", deps());
    expect(result).toMatchObject({ outcome: "invalid", reason: "signature", blocked: false });
    expect(metricCount("AppAttestInvalid")).toBe(1);
    expect(metricCount("AppAttestRejected")).toBe(0);
  });

  it("binds the exact body: another body than the one signed is invalid", async () => {
    registerKey();
    const event = feedbackEvent({ marker: requestMarker(), body: '{"billId":"BILLS-119hr1","feedback":"Nay"}' });
    expect(await evaluateRequestAttestation(event, "user-1", "feedback", deps())).toMatchObject({
      outcome: "invalid",
      reason: "client_data_body",
    });
  });

  it("a base64-encoded body hashes its decoded bytes", async () => {
    registerKey();
    const event = {
      ...feedbackEvent({ marker: requestMarker() }),
      body: Buffer.from(BODY).toString("base64"),
      isBase64Encoded: true,
    };
    expect(await evaluateRequestAttestation(event, "user-1", "feedback", deps())).toMatchObject({ outcome: "valid" });
  });

  it("an unknown key and a revoked key are invalid", async () => {
    expect(
      await evaluateRequestAttestation(feedbackEvent({ marker: requestMarker() }), "user-1", "feedback", deps()),
    ).toMatchObject({
      outcome: "invalid",
      reason: "unknown_key",
    });
    registerKey({ status: "revoked" });
    expect(
      await evaluateRequestAttestation(feedbackEvent({ marker: requestMarker() }), "user-1", "feedback", deps()),
    ).toMatchObject({
      outcome: "invalid",
      reason: "revoked_key",
    });
  });

  it("a used, expired or unknown challenge is invalid", async () => {
    registerKey();
    const marker = requestMarker({ counter: 1 });
    await evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", deps());
    // Another assertion over the same clientData (new counter) reuses the consumed challenge.
    const [, , keyId, clientData] = marker.split(".");
    const second = signAssertion({
      privateKey: device.privateKey,
      authenticatorData: assertionAuthData({ counter: 2 }),
      clientData: Buffer.from(clientData, "base64url"),
    });
    const reused = assertionMarker({ keyId, clientData: Buffer.from(clientData, "base64url"), assertion: second });
    expect(
      await evaluateRequestAttestation(feedbackEvent({ marker: reused }), "user-1", "feedback", deps()),
    ).toMatchObject({
      outcome: "invalid",
      reason: "challenge_used",
    });
    const late = { ...deps(), now: () => new Date(NOW.getTime() + 10 * 60_000) };
    expect(
      await evaluateRequestAttestation(
        feedbackEvent({ marker: requestMarker({ counter: 3 }) }),
        "user-1",
        "feedback",
        late,
      ),
    ).toMatchObject({
      outcome: "invalid",
      reason: "challenge_expired",
    });
  });

  it("a replay of the same header (a retry) is valid without moving the counter again", async () => {
    registerKey({ signCount: 0 });
    const marker = requestMarker({ counter: 1 });
    expect(await evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", deps())).toMatchObject({
      outcome: "valid",
    });
    table.calls.length = 0;
    expect(await evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", deps())).toMatchObject({
      outcome: "valid",
    });
    expect(table.commandNames()).toEqual(["UpdateItemCommand", "GetItemCommand", "GetItemCommand"]);
    expect(emf()[1].line.replay).toBe(true);
  });

  it("a counter that lost a race is invalid (counter_not_increasing)", async () => {
    registerKey({ signCount: 0 });
    const marker = requestMarker({ counter: 1 });
    const realSend = table.send.bind(table);
    jest.spyOn(table, "send").mockImplementation(async (command, options) => {
      if (
        command.constructor.name === "UpdateItemCommand" &&
        command.input.UpdateExpression?.startsWith("SET #signCount")
      ) {
        table.put(keyRow({ keyId: device.keyId, publicKeySpki: device.publicKeySpki, signCount: 5 }));
      }
      return realSend(command, options);
    });
    expect(await evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", deps())).toMatchObject({
      outcome: "invalid",
      reason: "counter_not_increasing",
    });
  });

  it("refreshes a binding older than a day, and leaves a recent one alone", async () => {
    registerKey({ accountCount: 1 });
    table.put({
      ...bindingItemKey("user-1", device.keyId),
      firstSeenAt: { S: "2026-10-01T00:00:00.000Z" },
      lastSeenAt: { S: "2026-10-06T00:00:00.000Z" },
    });
    await evaluateRequestAttestation(
      feedbackEvent({ marker: requestMarker({ counter: 1 }) }),
      "user-1",
      "feedback",
      deps(),
    );
    expect(table.get(bindingItemKey("user-1", device.keyId))?.lastSeenAt).toEqual({ S: NOW.toISOString() });
    expect(table.get(keyItemKey(device.keyId))?.accountCount).toEqual({ N: "1" });
    table.calls.length = 0;
    await evaluateRequestAttestation(
      feedbackEvent({ marker: requestMarker({ counter: 2 }) }),
      "user-1",
      "feedback",
      deps(),
    );
    expect(table.calls.filter((call) => call.input.UpdateExpression === "SET #lastSeenAt = :now, #ttl = :ttl")).toEqual(
      [],
    );
  });

  it("an account over the limit on one install is recorded but allowed and bound", async () => {
    registerKey({ accountCount: LIMIT });
    const result = await evaluateRequestAttestation(
      feedbackEvent({ marker: requestMarker() }),
      "user-4",
      "feedback",
      deps(),
    );
    expect(result).toMatchObject({ outcome: "valid", blocked: false });
    expect(metricCount("AppAttestOverLimit", { Kind: "install" })).toBe(1);
    expect(table.get(bindingItemKey("user-4", device.keyId))).toBeDefined();
    expect(table.get(keyItemKey(device.keyId))?.accountCount).toEqual({ N: String(LIMIT + 1) });
  });

  it("the 1,500 ms budget turns a slow table into outcome error, and the vote proceeds", async () => {
    registerKey();
    const marker = requestMarker();
    table.delayMs = 5_000;
    const started = Date.now();
    const result = await evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", deps());
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ outcome: "error", reason: "timeout", blocked: false });
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(2_500);
    expect(metricCount("AppAttestErrors")).toBe(1);
  });

  it("never throws, even when every dependency throws", async () => {
    const broken = {
      consumeChallenge: () => {
        throw new TypeError("boom");
      },
    } as unknown as AppAttestStore;
    const marker = requestMarker();
    await expect(
      evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", { ...deps(), store: broken }),
    ).resolves.toMatchObject({ outcome: "error", reason: "exception:TypeError", blocked: false });
    table.failNext("UpdateItemCommand");
    await expect(
      evaluateRequestAttestation(feedbackEvent({ marker }), "user-1", "feedback", deps()),
    ).resolves.toMatchObject({
      outcome: "error",
      reason: "exception:ThrottlingException",
    });
    await expect(evaluateRequestAttestation(null as never, "user-1", "feedback", deps())).resolves.toMatchObject({
      outcome: "missing",
      blocked: false,
    });
    logSpy.mockImplementation(() => {
      throw new Error("stdout closed");
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      evaluateRequestAttestation(feedbackEvent({ marker: "v1.u" }), "user-1", "feedback", deps()),
    ).resolves.toMatchObject({
      outcome: "unsupported",
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("protected request in enforce: the C3 3.4 decision table", () => {
  const enforce = (env: Record<string, string> = {}) => deps({ APP_ATTEST_MODE: "enforce", ...env });
  const run = (event = feedbackEvent(), env: Record<string, string> = {}, userId = "user-1") =>
    evaluateRequestAttestation(event, userId, "feedback", enforce(env));

  it("valid: allowed", async () => {
    registerKey();
    expect(await run(feedbackEvent({ marker: requestMarker() }))).toMatchObject({ outcome: "valid", blocked: false });
  });

  it("development: 403 APP_ATTEST_FAILED unless development is allowed", async () => {
    registerKey({ environment: "development" });
    const blocked = await run(feedbackEvent({ marker: requestMarker({ counter: 1 }) }));
    expect(blocked).toMatchObject({ outcome: "development", blocked: true, code: "APP_ATTEST_FAILED" });
    expect(blocked.response).toEqual({
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "APP_ATTEST_FAILED" }),
    });
    expect(table.get(bindingItemKey("user-1", device.keyId))).toBeUndefined();
    const allowed = await run(feedbackEvent({ marker: requestMarker({ counter: 2 }) }), {
      APP_ATTEST_ALLOWED_ENVIRONMENTS: "production,development",
    });
    expect(allowed).toMatchObject({ outcome: "development", blocked: false });
  });

  it("missing: 426 APP_UPDATE_REQUIRED", async () => {
    const result = await run();
    expect(result).toMatchObject({ outcome: "missing", blocked: true, code: "APP_UPDATE_REQUIRED" });
    expect(result.response?.statusCode).toBe(426);
    expect(metricCount("AppAttestRejected")).toBe(1);
  });

  it.each(["v1.u", "v1.b", "v1.e.attest"])("%s: 403 APP_ATTEST_REQUIRED", async (marker) => {
    const result = await run(feedbackEvent({ marker }));
    expect(result).toMatchObject({ blocked: true, code: "APP_ATTEST_REQUIRED" });
    expect(result.response?.statusCode).toBe(403);
  });

  it("unknown or revoked key: 403 APP_ATTEST_UNKNOWN_KEY", async () => {
    expect(await run(feedbackEvent({ marker: requestMarker() }))).toMatchObject({
      code: "APP_ATTEST_UNKNOWN_KEY",
      blocked: true,
    });
    registerKey({ status: "revoked" });
    expect(await run(feedbackEvent({ marker: requestMarker() }))).toMatchObject({
      code: "APP_ATTEST_UNKNOWN_KEY",
      blocked: true,
    });
  });

  it("any other invalid: 403 APP_ATTEST_FAILED", async () => {
    registerKey({ signCount: 9 });
    expect(await run(feedbackEvent({ marker: requestMarker({ counter: 3 }) }))).toMatchObject({
      reason: "counter_not_increasing",
      code: "APP_ATTEST_FAILED",
      blocked: true,
    });
    expect(await run(feedbackEvent({ marker: "v1.a.short.Yw.Yw" }))).toMatchObject({ code: "APP_ATTEST_FAILED" });
  });

  it("error: allowed, or 503 APP_ATTEST_UNAVAILABLE when fail-closed", async () => {
    registerKey();
    table.failNext("UpdateItemCommand");
    expect(await run(feedbackEvent({ marker: requestMarker() }))).toMatchObject({ outcome: "error", blocked: false });
    table.failNext("UpdateItemCommand");
    const closed = await run(feedbackEvent({ marker: requestMarker() }), { APP_ATTEST_FAIL_CLOSED: "true" });
    expect(closed).toMatchObject({ outcome: "error", blocked: true, code: "APP_ATTEST_UNAVAILABLE" });
    expect(closed.response?.statusCode).toBe(503);
  });

  it("a new account over the limit on the install: 403 DEVICE_ACCOUNT_LIMIT and nothing written", async () => {
    registerKey({ accountCount: LIMIT });
    const result = await run(feedbackEvent({ marker: requestMarker() }), {}, "user-4");
    expect(result).toMatchObject({ outcome: "valid", blocked: true, code: "DEVICE_ACCOUNT_LIMIT" });
    expect(table.get(bindingItemKey("user-4", device.keyId))).toBeUndefined();
    expect(table.get(keyItemKey(device.keyId))?.accountCount).toEqual({ N: String(LIMIT) });
    expect(metricCount("AppAttestOverLimit", { Kind: "install" })).toBe(1);
  });

  it("parallel first votes from new accounts cannot pass the limit: the count is checked in the write", async () => {
    registerKey({ signCount: 10, accountCount: LIMIT - 1 });
    table.delayMs = 5; // every call takes time, so all four read accountCount LIMIT - 1 before any of them writes
    const users = ["user-3", "user-4", "user-5", "user-6"];
    const markers = users.map((_, index) => requestMarker({ counter: 11 + index }));
    const results = await Promise.all(
      users.map((userId, index) =>
        new Promise((resolve) => setTimeout(resolve, index)).then(() =>
          run(feedbackEvent({ marker: markers[index] }), {}, userId),
        ),
      ),
    );
    expect(results.filter((result) => !result.blocked)).toHaveLength(1);
    expect(results.filter((result) => result.code === "DEVICE_ACCOUNT_LIMIT")).toHaveLength(3);
    expect(table.get(keyItemKey(device.keyId))?.accountCount).toEqual({ N: String(LIMIT) });
    expect(users.filter((userId) => table.get(bindingItemKey(userId, device.keyId)))).toHaveLength(1);
  });

  it("an account already bound keeps voting at the limit", async () => {
    registerKey({ accountCount: LIMIT });
    table.put({ ...bindingItemKey("user-2", device.keyId), lastSeenAt: { S: NOW.toISOString() } });
    expect(await run(feedbackEvent({ marker: requestMarker() }), {}, "user-2")).toMatchObject({
      outcome: "valid",
      blocked: false,
    });
  });

  it("exempt callers (the exempt group, every claim shape) are always allowed and still recorded", async () => {
    for (const groups of [[EXEMPT], `[${EXEMPT}]`, `Admins,${EXEMPT}`, JSON.stringify([EXEMPT])]) {
      const result = await run(feedbackEvent({ groups }));
      expect(result).toEqual({ mode: "enforce", outcome: "missing", exempt: true, blocked: false });
    }
    registerKey({ accountCount: LIMIT });
    expect(await run(feedbackEvent({ marker: requestMarker(), groups: `[${EXEMPT}]` }), {}, "canary")).toMatchObject({
      outcome: "valid",
      blocked: false,
    });
    expect(table.get(bindingItemKey("canary", device.keyId))).toBeDefined();
    expect(await run(feedbackEvent({ groups: "[OtherGroup]" }))).toMatchObject({ blocked: true });
  });

  it("exempt callers are allowed even when fail-closed", async () => {
    registerKey();
    table.failNext("UpdateItemCommand");
    expect(
      await run(feedbackEvent({ marker: requestMarker(), groups: [EXEMPT] }), {
        APP_ATTEST_FAIL_CLOSED: "true",
      }),
    ).toMatchObject({ outcome: "error", blocked: false });
  });

  it("MIN_APP_VERSION: missing or older version gets 426 even with a valid assertion; exempt passes", async () => {
    registerKey();
    const env = { MIN_APP_VERSION: "1.3" };
    expect(await run(feedbackEvent({ marker: requestMarker({ counter: 1 }) }), env)).toMatchObject({
      outcome: "valid",
      blocked: true,
      code: "APP_UPDATE_REQUIRED",
    });
    // A refused request binds nothing.
    expect(table.get(bindingItemKey("user-1", device.keyId))).toBeUndefined();
    expect(await run(feedbackEvent({ marker: requestMarker({ counter: 2 }), appVersion: "1.2.9" }), env)).toMatchObject(
      {
        code: "APP_UPDATE_REQUIRED",
      },
    );
    expect(await run(feedbackEvent({ marker: requestMarker({ counter: 3 }), appVersion: "1.3" }), env)).toMatchObject({
      outcome: "valid",
      blocked: false,
    });
    expect(
      await run(feedbackEvent({ marker: requestMarker({ counter: 4 }), appVersion: "1.0", groups: [EXEMPT] }), env),
    ).toMatchObject({ blocked: false });
  });

  it("in watch the same version gate only records wouldBlock", async () => {
    const result = await evaluateRequestAttestation(
      feedbackEvent({ appVersion: "1.0" }),
      "user-1",
      "feedback",
      deps({ MIN_APP_VERSION: "1.3" }),
    );
    expect(result).toMatchObject({ blocked: false });
    expect(emf()[0].line).toMatchObject({ appVersion: "1.0", wouldBlock: "APP_UPDATE_REQUIRED" });
  });

  it("an unknown mode value behaves as watch (never blocks)", async () => {
    expect(
      await evaluateRequestAttestation(feedbackEvent(), "user-1", "feedback", deps({ APP_ATTEST_MODE: "enforec" })),
    ).toMatchObject({
      mode: "watch",
      blocked: false,
    });
  });
});

// ─── Sign-up ────────────────────────────────────────────────────────────────

const signUpEvent = (
  input: {
    marker?: string;
    deviceToken?: string;
    appVersion?: string;
    email?: string | null;
    triggerSource?: string;
  } = {},
): SignUpEventLike => ({
  triggerSource: input.triggerSource ?? "PreSignUp_SignUp",
  userName: "c0ffee00-0000-4000-8000-000000000001",
  request: {
    userAttributes: input.email === null ? {} : { email: input.email ?? EMAIL },
    clientMetadata: {
      ...(input.marker !== undefined ? { billboardAppAttest: input.marker } : {}),
      ...(input.deviceToken !== undefined ? { billboardDeviceCheck: input.deviceToken } : {}),
      ...(input.appVersion !== undefined ? { billboardAppVersion: input.appVersion } : {}),
    },
  },
});

const signUpMarker = (input: { counter?: number; email?: string } = {}): string => {
  const clientData = signUpClientData({ challenge: freshChallenge(), email: input.email ?? EMAIL });
  const assertion = signAssertion({
    privateKey: device.privateKey,
    authenticatorData: assertionAuthData({ counter: input.counter ?? 1 }),
    clientData,
  });
  return assertionMarker({ keyId: device.keyId, clientData, assertion });
};

describe("sign-up App Attest", () => {
  it("AdminCreateUser passes as admin in every mode, with no checks", async () => {
    for (const mode of ["watch", "enforce"]) {
      expect(
        await evaluateSignUpAttestation(
          signUpEvent({ triggerSource: "PreSignUp_AdminCreateUser" }),
          deps({ APP_ATTEST_MODE: mode }),
        ),
      ).toEqual({
        mode,
        outcome: "admin",
        decision: "allow",
        replay: false,
      });
    }
    expect(
      await evaluateSignUpAttestation(
        signUpEvent({ triggerSource: "PreSignUp_ExternalProvider" }),
        deps({ APP_ATTEST_MODE: "enforce" }),
      ),
    ).toMatchObject({
      outcome: "other",
      decision: "allow",
    });
    expect(table.calls).toEqual([]);
    expect(metricCount("AppAttestRequests", { Route: "signup", Outcome: "admin" })).toBe(2);
  });

  it("an old build (no ClientMetadata): missing, allowed in watch, no table call", async () => {
    expect(await evaluateSignUpAttestation(signUpEvent(), deps())).toEqual({
      mode: "watch",
      outcome: "missing",
      decision: "allow",
      replay: false,
    });
    expect(table.calls).toEqual([]);
    const noMetadata = {
      triggerSource: "PreSignUp_SignUp",
      request: { userAttributes: { email: EMAIL }, clientMetadata: null },
    };
    expect(await evaluateSignUpAttestation(noMetadata, deps())).toMatchObject({ outcome: "missing" });
  });

  it("a valid sign-up assertion counts the install's sign-up once; a replay does not count again", async () => {
    registerKey({ signupCount: 0 });
    const marker = signUpMarker();
    expect(await evaluateSignUpAttestation(signUpEvent({ marker }), deps())).toEqual({
      mode: "watch",
      outcome: "valid",
      decision: "allow",
      keyEnvironment: "production",
      replay: false,
    });
    expect(table.get(keyItemKey(device.keyId))?.signupCount).toEqual({ N: "1" });
    expect(await evaluateSignUpAttestation(signUpEvent({ marker }), deps())).toMatchObject({
      outcome: "valid",
      replay: true,
    });
    expect(table.get(keyItemKey(device.keyId))?.signupCount).toEqual({ N: "1" });
    expect(table.get(bindingItemKey("c0ffee00-0000-4000-8000-000000000001", device.keyId))).toBeUndefined();
  });

  it("binds the email: another address is invalid; userName stands in when there is no email", async () => {
    registerKey();
    expect(
      await evaluateSignUpAttestation(signUpEvent({ marker: signUpMarker({ email: "other@example.com" }) }), deps()),
    ).toMatchObject({
      outcome: "invalid",
      reason: "client_data_email",
      decision: "allow",
    });
    const userNameMarker = signUpMarker({ counter: 2, email: "c0ffee00-0000-4000-8000-000000000001" });
    expect(await evaluateSignUpAttestation(signUpEvent({ marker: userNameMarker, email: null }), deps())).toMatchObject(
      {
        outcome: "valid",
      },
    );
  });

  it("a request assertion is not accepted for sign-up", async () => {
    registerKey();
    expect(await evaluateSignUpAttestation(signUpEvent({ marker: requestMarker() }), deps())).toMatchObject({
      outcome: "invalid",
      reason: "client_data_purpose",
    });
  });

  it("watch: a sign-up over the limit from one install is counted and flagged, not refused", async () => {
    registerKey({ signupCount: LIMIT });
    expect(await evaluateSignUpAttestation(signUpEvent({ marker: signUpMarker() }), deps())).toMatchObject({
      outcome: "valid",
      decision: "allow",
    });
    expect(table.get(keyItemKey(device.keyId))?.signupCount).toEqual({ N: String(LIMIT + 1) });
    expect(metricCount("AppAttestOverLimit", { Kind: "install" })).toBe(1);
  });

  it("enforce: refuses a sign-up over the limit with DEVICE_ACCOUNT_LIMIT and does not count it", async () => {
    registerKey({ signupCount: LIMIT });
    const result = await evaluateSignUpAttestation(
      signUpEvent({ marker: signUpMarker() }),
      deps({ APP_ATTEST_MODE: "enforce" }),
    );
    expect(result).toMatchObject({ outcome: "valid", decision: "reject", code: "DEVICE_ACCOUNT_LIMIT" });
    expect(table.get(keyItemKey(device.keyId))?.signupCount).toEqual({ N: String(LIMIT) });
    expect(signUpRejectionError("DEVICE_ACCOUNT_LIMIT").message).toBe("DEVICE_ACCOUNT_LIMIT");
  });

  it("enforce: each outcome's code", async () => {
    const enforce = deps({ APP_ATTEST_MODE: "enforce" });
    expect(await evaluateSignUpAttestation(signUpEvent(), enforce)).toMatchObject({
      decision: "reject",
      code: "APP_UPDATE_REQUIRED",
    });
    expect(await evaluateSignUpAttestation(signUpEvent({ marker: "v1.b" }), enforce)).toMatchObject({
      code: "APP_ATTEST_REQUIRED",
    });
    expect(await evaluateSignUpAttestation(signUpEvent({ marker: signUpMarker() }), enforce)).toMatchObject({
      code: "APP_ATTEST_UNKNOWN_KEY",
    });
    registerKey({ environment: "development" });
    expect(
      await evaluateSignUpAttestation(signUpEvent({ marker: signUpMarker({ counter: 1 }) }), enforce),
    ).toMatchObject({
      outcome: "development",
      code: "APP_ATTEST_FAILED",
    });
    expect(table.get(keyItemKey(device.keyId))?.signupCount).toEqual({ N: "0" });
    registerKey({ environment: "production", signCount: 1 });
    expect(
      await evaluateSignUpAttestation(
        signUpEvent({ marker: signUpMarker({ counter: 2 }) }),
        deps({ APP_ATTEST_MODE: "enforce", MIN_APP_VERSION: "1.2" }),
      ),
    ).toMatchObject({ outcome: "valid", code: "APP_UPDATE_REQUIRED" });
    expect(table.get(keyItemKey(device.keyId))?.signupCount).toEqual({ N: "0" });
    expect(
      await evaluateSignUpAttestation(
        signUpEvent({ marker: signUpMarker({ counter: 3 }), appVersion: "1.2" }),
        deps({ APP_ATTEST_MODE: "enforce", MIN_APP_VERSION: "1.2" }),
      ),
    ).toMatchObject({ outcome: "valid", decision: "allow" });
  });

  it("errors are allowed, or refused with APP_ATTEST_UNAVAILABLE when fail-closed", async () => {
    registerKey();
    table.failNext("UpdateItemCommand");
    expect(
      await evaluateSignUpAttestation(signUpEvent({ marker: signUpMarker() }), deps({ APP_ATTEST_MODE: "enforce" })),
    ).toMatchObject({
      outcome: "error",
      decision: "allow",
    });
    table.failNext("UpdateItemCommand");
    expect(
      await evaluateSignUpAttestation(
        signUpEvent({ marker: signUpMarker() }),
        deps({ APP_ATTEST_MODE: "enforce", APP_ATTEST_FAIL_CLOSED: "true" }),
      ),
    ).toMatchObject({ outcome: "error", decision: "reject", code: "APP_ATTEST_UNAVAILABLE" });
  });

  it("respects the shared deadline: no time left means error without a table call", async () => {
    registerKey();
    const result = await evaluateSignUpAttestation(signUpEvent({ marker: signUpMarker() }), {
      ...deps(),
      deadlineMs: Date.now() - 1,
    });
    expect(result).toMatchObject({ outcome: "error", reason: "timeout", decision: "allow" });
    expect(table.calls).toEqual([]);
    expect(metricCount("AppAttestErrors")).toBe(1);
  });

  it("is capped at 1.2 s even with a later deadline", async () => {
    registerKey();
    const marker = signUpMarker();
    table.delayMs = 5_000;
    const started = Date.now();
    const result = await evaluateSignUpAttestation(signUpEvent({ marker }), {
      ...deps(),
      deadlineMs: Date.now() + 3_500,
    });
    expect(result).toMatchObject({ outcome: "error", reason: "timeout", decision: "allow" });
    expect(Date.now() - started).toBeLessThan(1_800);
  });

  it("watch never throws, even when the store throws synchronously", async () => {
    const broken = {
      consumeChallenge: () => {
        throw new TypeError("boom");
      },
    } as unknown as AppAttestStore;
    await expect(
      evaluateSignUpAttestation(signUpEvent({ marker: signUpMarker() }), { ...deps(), store: broken }),
    ).resolves.toMatchObject({
      outcome: "error",
      decision: "allow",
    });
    await expect(evaluateSignUpAttestation(null as never, deps())).resolves.toMatchObject({
      outcome: "other",
      decision: "allow",
    });
  });
});

describe("sign-up DeviceCheck", () => {
  const TOKEN = Buffer.from("device token").toString("base64");
  const deviceCheckEnv = (mode: string, extra: Record<string, string> = {}) =>
    deps({ DEVICE_CHECK_MODE: mode, DEVICE_CHECK_SECRET_NAME: "Billboard/AppleDeviceCheckKey", ...extra });
  const fakeClient = (query: unknown = { status: "not_found" }, update: unknown = { status: "ok" }) => ({
    query: jest.fn(async () => query),
    update: jest.fn(async () => update),
  });
  const run = (
    client: ReturnType<typeof fakeClient>,
    mode: string,
    event = signUpEvent({ deviceToken: TOKEN }),
    extra: Record<string, unknown> = {},
  ) =>
    evaluateSignUpDeviceCheck(event, {
      ...deviceCheckEnv(mode),
      deviceCheck: client as unknown as DeviceCheckClient,
      deadlineMs: Date.now() + 3_500,
      ...extra,
    });

  it("is off without the mode or without the secret name, and makes no call", async () => {
    const client = fakeClient();
    expect(
      await evaluateSignUpDeviceCheck(signUpEvent({ deviceToken: TOKEN }), {
        ...deps({ DEVICE_CHECK_MODE: "watch" }),
        deviceCheck: client as never,
      }),
    ).toEqual({
      mode: "off",
      decision: "allow",
    });
    expect(await run(client, "off")).toEqual({ mode: "off", decision: "allow" });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("first sign-up on a device: not_found, bits set to 1, per-call time 1,000 ms", async () => {
    const client = fakeClient();
    expect(await run(client, "watch")).toEqual({ mode: "watch", outcome: "not_found", count: 0, decision: "allow" });
    expect(client.query).toHaveBeenCalledWith(TOKEN, { development: false, timeoutMs: 1000 });
    expect(client.update).toHaveBeenCalledWith(
      TOKEN,
      { bit0: true, bit1: false },
      { development: false, timeoutMs: 1000 },
    );
    expect(metricCount("DeviceCheckCalls", { Outcome: "not_found" })).toBe(1);
  });

  it("counts up from the stored bits and uses the development host for a development key", async () => {
    const client = fakeClient({ status: "ok", bit0: true, bit1: false, lastUpdateTime: "2026-09" });
    const attestation = {
      mode: "watch" as const,
      outcome: "development" as const,
      decision: "allow" as const,
      keyEnvironment: "development" as const,
      replay: false,
    };
    expect(await run(client, "watch", signUpEvent({ deviceToken: TOKEN }), { attestation })).toMatchObject({
      outcome: "ok",
      count: 1,
    });
    expect(client.query).toHaveBeenCalledWith(TOKEN, { development: true, timeoutMs: 1000 });
    expect(client.update).toHaveBeenCalledWith(
      TOKEN,
      { bit0: false, bit1: true },
      { development: true, timeoutMs: 1000 },
    );
  });

  it("at the limit: watch flags and leaves the bits alone; enforce refuses", async () => {
    const atLimit = { status: "ok", bit0: true, bit1: true, lastUpdateTime: "2026-09" };
    const watchClient = fakeClient(atLimit);
    expect(await run(watchClient, "watch")).toEqual({ mode: "watch", outcome: "ok", count: 3, decision: "allow" });
    expect(watchClient.update).not.toHaveBeenCalled();
    expect(metricCount("AppAttestOverLimit", { Kind: "device" })).toBe(1);
    const enforceClient = fakeClient(atLimit);
    expect(await run(enforceClient, "enforce")).toEqual({
      mode: "enforce",
      outcome: "ok",
      count: 3,
      decision: "reject",
      code: "DEVICE_ACCOUNT_LIMIT",
    });
    expect(enforceClient.update).not.toHaveBeenCalled();
  });

  it("a count DEVICE_COUNTER_WINDOW_MONTHS old resets, and DEVICE_MAX_ACCOUNTS lowers the limit", async () => {
    // The "YYYY-MM" of the month `months` before NOW's.
    const monthsBefore = (months: number) =>
      new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - months, 1)).toISOString().slice(0, 7);
    const windowMonths = APP_ATTEST_DEFAULTS.deviceCounterWindowMonths;
    const stale = fakeClient({ status: "ok", bit0: true, bit1: true, lastUpdateTime: monthsBefore(windowMonths) });
    expect(await run(stale, "enforce")).toMatchObject({ count: 0, decision: "allow" });
    const recent = fakeClient({ status: "ok", bit0: true, bit1: true, lastUpdateTime: monthsBefore(windowMonths - 1) });
    expect(await run(recent, "enforce")).toMatchObject({ count: 3, decision: "reject" });
    const two = fakeClient({ status: "ok", bit0: false, bit1: true, lastUpdateTime: "2026-10" });
    expect(
      await evaluateSignUpDeviceCheck(signUpEvent({ deviceToken: TOKEN }), {
        ...deviceCheckEnv("enforce", { DEVICE_MAX_ACCOUNTS: "2" }),
        deviceCheck: two as never,
      }),
    ).toMatchObject({ count: 2, decision: "reject", code: "DEVICE_ACCOUNT_LIMIT" });
  });

  it("missing or malformed token: recorded in watch, APP_ATTEST_REQUIRED in enforce; Apple's 400 likewise", async () => {
    const client = fakeClient();
    expect(await run(client, "watch", signUpEvent())).toEqual({ mode: "watch", outcome: "missing", decision: "allow" });
    expect(await run(client, "enforce", signUpEvent())).toEqual({
      mode: "enforce",
      outcome: "missing",
      decision: "reject",
      code: "APP_ATTEST_REQUIRED",
    });
    expect(await run(client, "watch", signUpEvent({ deviceToken: "not base64!" }))).toMatchObject({
      outcome: "bad_token",
      decision: "allow",
    });
    expect(client.query).not.toHaveBeenCalled();
    const badToken = fakeClient({ status: "bad_token" });
    expect(await run(badToken, "enforce")).toEqual({
      mode: "enforce",
      outcome: "bad_token",
      decision: "reject",
      code: "APP_ATTEST_REQUIRED",
    });
    expect(metricCount("DeviceCheckCalls", { Outcome: "missing" })).toBe(2);
  });

  it("Apple errors and timeouts fail open (closed only with APP_ATTEST_FAIL_CLOSED under enforce)", async () => {
    expect(await run(fakeClient({ status: "error", detail: "HTTP 503" }), "enforce")).toEqual({
      mode: "enforce",
      outcome: "error",
      decision: "allow",
    });
    expect(metricCount("AppAttestErrors")).toBe(1);
    expect(
      await evaluateSignUpDeviceCheck(signUpEvent({ deviceToken: TOKEN }), {
        ...deviceCheckEnv("enforce", { APP_ATTEST_FAIL_CLOSED: "true" }),
        deviceCheck: fakeClient({ status: "error", detail: "HTTP 503" }) as never,
      }),
    ).toMatchObject({ outcome: "error", decision: "reject", code: "APP_ATTEST_UNAVAILABLE" });
    const failedUpdate = fakeClient({ status: "not_found" }, { status: "error", detail: "TimeoutError" });
    expect(await run(failedUpdate, "watch")).toMatchObject({ outcome: "error", count: 0, decision: "allow" });
    const throwing = {
      query: jest.fn(async () => {
        throw new Error("bug");
      }),
      update: jest.fn(),
    };
    expect(await run(throwing as never, "watch")).toMatchObject({ outcome: "error", decision: "allow" });
  });

  it("time per call is min(1,000 ms, time left - 200 ms); none left means no call", async () => {
    const client = fakeClient();
    await run(client, "watch", signUpEvent({ deviceToken: TOKEN }), { deadlineMs: Date.now() + 700 });
    const timeoutMs = (client.query.mock.calls[0] as unknown as [string, { timeoutMs: number }])[1].timeoutMs;
    expect(timeoutMs).toBeLessThanOrEqual(500);
    expect(timeoutMs).toBeGreaterThan(400);
    const late = fakeClient();
    expect(
      await run(late, "watch", signUpEvent({ deviceToken: TOKEN }), { deadlineMs: Date.now() + 150 }),
    ).toMatchObject({ outcome: "error", decision: "allow" });
    expect(late.query).not.toHaveBeenCalled();
  });

  it("a replayed sign-up does not set the bits again; admin-created users are not checked", async () => {
    const client = fakeClient({ status: "ok", bit0: true, bit1: false, lastUpdateTime: "2026-10" });
    const attestation = {
      mode: "watch" as const,
      outcome: "valid" as const,
      decision: "allow" as const,
      keyEnvironment: "production" as const,
      replay: true,
    };
    expect(await run(client, "watch", signUpEvent({ deviceToken: TOKEN }), { attestation })).toMatchObject({
      count: 1,
      decision: "allow",
    });
    expect(client.update).not.toHaveBeenCalled();
    expect(await run(client, "enforce", signUpEvent({ triggerSource: "PreSignUp_AdminCreateUser" }))).toEqual({
      mode: "enforce",
      decision: "allow",
    });
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});

describe("evaluateSignUp (both checks in order)", () => {
  it("stops at an App Attest rejection without calling Apple", async () => {
    const client = { query: jest.fn(), update: jest.fn() };
    const result = await evaluateSignUp(signUpEvent({ deviceToken: "dG9rZW4=" }), {
      ...deps({ APP_ATTEST_MODE: "enforce", DEVICE_CHECK_MODE: "enforce", DEVICE_CHECK_SECRET_NAME: "s" }),
      deviceCheck: client as never,
    });
    expect(result).toMatchObject({ decision: "reject", code: "APP_UPDATE_REQUIRED" });
    expect(result.deviceCheck).toBeUndefined();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("passes the App Attest result to DeviceCheck and returns its decision", async () => {
    registerKey({ environment: "development" });
    const client = {
      query: jest.fn(async () => ({ status: "not_found" })),
      update: jest.fn(async () => ({ status: "ok" })),
    };
    const result = await evaluateSignUp(signUpEvent({ marker: signUpMarker(), deviceToken: "dG9rZW4=" }), {
      ...deps({ DEVICE_CHECK_MODE: "watch", DEVICE_CHECK_SECRET_NAME: "s" }),
      deviceCheck: client as never,
    });
    expect(result).toMatchObject({
      decision: "allow",
      attestation: { outcome: "development" },
      deviceCheck: { outcome: "not_found" },
    });
    expect(client.query).toHaveBeenCalledWith("dG9rZW4=", expect.objectContaining({ development: true }));
  });
});
