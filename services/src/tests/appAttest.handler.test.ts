import { X509Certificate, createPublicKey } from "node:crypto";
import { APP_ATTEST_DEFAULTS } from "../shared/abuseLimits";
import { FakeAppAttestTable, attestationFor, challengeRow, fixtureNow } from "./fixtures/appAttest/helpers";
import { asApiGatewayEvent } from "./fixtures/awsEvents";
import { applyTestEnv } from "./fixtures/env";

let mockTable = new FakeAppAttestTable();

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({
      send: (command: never, options: never) => mockTable.send(command, options),
    })),
  };
});

// Attestations in these tests chain to the synthetic root; production pins Apple's.
jest.mock("../shared/appAttest/appleRootCa", () => {
  const actual = jest.requireActual("../shared/appAttest/appleRootCa");
  const helpers = jest.requireActual("./fixtures/appAttest/helpers");
  return { ...actual, appleAppAttestationRoot: () => helpers.syntheticRoot };
});

const { handler } = require("../handlers/appAttest");

const NOW = fixtureNow();
let restoreEnv: () => void;
let logSpy: jest.SpyInstance;

const event = (resource: string, body: unknown, extra: Record<string, unknown> = {}) =>
  asApiGatewayEvent({
    httpMethod: "POST",
    resource,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    ...extra,
  });

const metricLines = (name: string) =>
  logSpy.mock.calls
    .map(([line]) => line)
    .filter((line): line is string => typeof line === "string" && line.includes('"_aws"') && line.includes(`"${name}"`))
    .map((line) => JSON.parse(line));

const json = (result: { body: string }) => JSON.parse(result.body);

beforeEach(() => {
  mockTable = new FakeAppAttestTable();
  restoreEnv = applyTestEnv({
    APP_ATTEST_TABLE_NAME: "AppAttest",
    APP_ATTEST_CLIENT_MODE: "on",
    APP_ATTEST_CHALLENGE_TTL_SECONDS: undefined,
  });
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      "nextTick",
      "setImmediate",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "queueMicrotask",
    ],
  });
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  restoreEnv();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("module load", () => {
  it("loads and answers with no environment at all (client mode off, nothing read or written)", async () => {
    const restore = applyTestEnv({}, { replace: true, base: {} });
    try {
      let isolated: { handler: typeof handler } | undefined;
      jest.isolateModules(() => {
        isolated = require("../handlers/appAttest");
      });
      const result = await isolated!.handler(event("/app-attest/challenge", { purpose: "attest" }));
      expect(result.statusCode).toBe(200);
      expect(json(result)).toEqual({ clientMode: "off" });
      expect(mockTable.calls).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("POST /app-attest/challenge", () => {
  it("issues a 43-character challenge valid for the challenge lifetime and stores it", async () => {
    const ttl = APP_ATTEST_DEFAULTS.challengeTtlSeconds;
    const result = await handler(event("/app-attest/challenge", { purpose: "assert" }));
    expect(result.statusCode).toBe(200);
    const body = json(result);
    expect(body).toEqual({
      clientMode: "on",
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: new Date(Math.floor(NOW.getTime() / 1000) * 1000 + ttl * 1000).toISOString(),
    });
    expect(mockTable.get({ pk: { S: `CH#${body.challenge}` }, sk: { S: "CH" } })).toMatchObject({
      purpose: { S: "assert" },
      expiresAt: { N: String(Math.floor(NOW.getTime() / 1000) + ttl) },
      ttl: { N: String(Math.floor(NOW.getTime() / 1000) + ttl + 3600) },
    });
    expect(metricLines("AppAttestChallenges")).toEqual([
      expect.objectContaining({ purpose: "assert", probeHeaderSeen: false, AppAttestChallenges: 1 }),
    ]);
  });

  it("issues a different challenge each time", async () => {
    const first = json(await handler(event("/app-attest/challenge", { purpose: "attest" }))).challenge;
    const second = json(await handler(event("/app-attest/challenge", { purpose: "attest" }))).challenge;
    expect(first).not.toBe(second);
  });

  it("logs probeHeaderSeen when the request carries X-Billboard-App-Attest (the C3 7.4 probe)", async () => {
    await handler(
      event(
        "/app-attest/challenge",
        { purpose: "assert" },
        { headers: { "x-billboard-app-attest": "v1.e.challenge" } },
      ),
    );
    expect(metricLines("AppAttestChallenges")[0]).toMatchObject({ probeHeaderSeen: true });
  });

  it.each([[{ purpose: "other" }], [{}], ["not json"], [[1, 2]], [null]])(
    "rejects %j with 400 INVALID_REQUEST",
    async (body) => {
      const result = await handler(event("/app-attest/challenge", body === null ? "" : body));
      expect(result.statusCode).toBe(400);
      expect(json(result)).toEqual({ error: "INVALID_REQUEST" });
      expect(mockTable.calls).toEqual([]);
    },
  );

  it("APP_ATTEST_CLIENT_MODE=off (kill switch): clientMode off and nothing written", async () => {
    process.env.APP_ATTEST_CLIENT_MODE = "off";
    const result = await handler(event("/app-attest/challenge", { purpose: "attest" }));
    expect(result.statusCode).toBe(200);
    expect(json(result)).toEqual({ clientMode: "off" });
    expect(mockTable.calls).toEqual([]);
  });

  it("an unset table name means client mode off", async () => {
    delete process.env.APP_ATTEST_TABLE_NAME;
    expect(json(await handler(event("/app-attest/challenge", { purpose: "attest" })))).toEqual({ clientMode: "off" });
  });

  it("takes the TTL from APP_ATTEST_CHALLENGE_TTL_SECONDS", async () => {
    process.env.APP_ATTEST_CHALLENGE_TTL_SECONDS = "120";
    const body = json(await handler(event("/app-attest/challenge", { purpose: "attest" })));
    expect(Date.parse(body.expiresAt)).toBe(Math.floor(NOW.getTime() / 1000) * 1000 + 120_000);
  });

  it("answers 503 APP_ATTEST_UNAVAILABLE when the table fails", async () => {
    mockTable.failNext("PutItemCommand");
    const result = await handler(event("/app-attest/challenge", { purpose: "attest" }));
    expect(result.statusCode).toBe(503);
    expect(json(result)).toEqual({ error: "APP_ATTEST_UNAVAILABLE" });
  });

  it("retries once on a challenge collision", async () => {
    mockTable.failNext(
      "PutItemCommand",
      Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" }),
    );
    const result = await handler(event("/app-attest/challenge", { purpose: "attest" }));
    expect(result.statusCode).toBe(200);
    expect(mockTable.commandNames()).toEqual(["PutItemCommand", "PutItemCommand"]);
  });
});

describe("POST /app-attest/attest", () => {
  const offer = (name = "production_ios26") => {
    const fixture = attestationFor(name);
    mockTable.put(
      challengeRow({ challenge: fixture.challenge, purpose: "attest", expiresAt: new Date(NOW.getTime() + 120_000) }),
    );
    return {
      fixture,
      body: {
        keyId: fixture.keyIdB64,
        challenge: fixture.challenge,
        attestation: fixture.attestation.toString("base64"),
      },
    };
  };
  const keyItem = (keyId: string) => mockTable.get({ pk: { S: `KEY#${keyId}` }, sk: { S: "META" } });

  it("registers a production key: 200 attested, key row with the leaf's public key and zero counts", async () => {
    const { fixture, body } = offer();
    const result = await handler(event("/app-attest/attest", body));
    expect(result.statusCode).toBe(200);
    expect(json(result)).toEqual({ status: "attested", environment: "production" });
    const stored = keyItem(fixture.keyIdB64);
    const spki = new X509Certificate(fixture.leafDer).publicKey.export({ type: "spki", format: "der" });
    expect(stored).toMatchObject({
      publicKeySpki: { B: spki },
      signCount: { N: "0" },
      environment: { S: "production" },
      receipt: { B: fixture.receipt },
      status: { S: "active" },
      accountCount: { N: "0" },
      signupCount: { N: "0" },
    });
    expect(
      createPublicKey({ key: Buffer.from(stored!.publicKeySpki.B!), format: "der", type: "spki" }).asymmetricKeyType,
    ).toBe("ec");
    expect(metricLines("AppAttestAttestations")).toEqual([
      expect.objectContaining({
        Outcome: "accepted",
        environment: "production",
        keyIdPrefix: fixture.keyIdB64.slice(0, 8),
      }),
    ]);
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain(fixture.keyIdB64);
  });

  it("stores the key under the canonical spelling of its ID", async () => {
    const { fixture, body } = offer();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const respelled = body.keyId.slice(0, -1) + alphabet[alphabet.indexOf(body.keyId.at(-1) as string) | 1];
    expect(respelled).not.toBe(body.keyId);
    const result = await handler(event("/app-attest/attest", { ...body, keyId: respelled }));
    expect(json(result)).toEqual({ status: "attested", environment: "production" });
    expect(keyItem(fixture.keyIdB64)).toBeDefined();
    expect(keyItem(respelled)).toBeUndefined();
  });

  it("records the environment and iOS 27 extensions", async () => {
    expect(json(await handler(event("/app-attest/attest", offer("development_develop").body)))).toEqual({
      status: "attested",
      environment: "development",
    });
    mockTable = new FakeAppAttestTable();
    const { fixture, body } = offer("production_ios27_testflight");
    await handler(event("/app-attest/attest", body));
    expect(keyItem(fixture.keyIdB64)).toMatchObject({ validationCategory: { N: "2" }, bundleVersion: { S: "1.2" } });
  });

  it("a retry of the same attestation is a replay: 200 already_attested, nothing changes", async () => {
    const { fixture, body } = offer();
    await handler(event("/app-attest/attest", body));
    const before = keyItem(fixture.keyIdB64);
    const retry = await handler(event("/app-attest/attest", body));
    expect(retry.statusCode).toBe(200);
    expect(json(retry)).toEqual({ status: "already_attested", environment: "production" });
    expect(keyItem(fixture.keyIdB64)).toEqual(before);
    expect(metricLines("AppAttestAttestations").map((line) => line.Outcome)).toEqual(["accepted", "already"]);
  });

  it("a key attested before (another challenge) is already_attested and unchanged", async () => {
    const { fixture, body } = offer();
    await handler(event("/app-attest/attest", body));
    mockTable.put({ ...keyItem(fixture.keyIdB64)!, signCount: { N: "17" } });
    // A fresh unconsumed challenge row with the same string stands in for a new challenge.
    mockTable.put(
      challengeRow({ challenge: fixture.challenge, purpose: "attest", expiresAt: new Date(NOW.getTime() + 120_000) }),
    );
    const result = await handler(event("/app-attest/attest", body));
    expect(json(result)).toEqual({ status: "already_attested", environment: "production" });
    expect(keyItem(fixture.keyIdB64)?.signCount).toEqual({ N: "17" });
  });

  it("an unknown, used, expired or assert-purpose challenge: 400 APP_ATTEST_CHALLENGE_INVALID", async () => {
    const fixture = attestationFor("production_ios26");
    const body = {
      keyId: fixture.keyIdB64,
      challenge: fixture.challenge,
      attestation: fixture.attestation.toString("base64"),
    };
    const attempt = async () => {
      const result = await handler(event("/app-attest/attest", body));
      expect(result.statusCode).toBe(400);
      expect(json(result)).toEqual({ error: "APP_ATTEST_CHALLENGE_INVALID" });
    };
    await attempt();
    mockTable.put(
      challengeRow({ challenge: fixture.challenge, purpose: "assert", expiresAt: new Date(NOW.getTime() + 60_000) }),
    );
    await attempt();
    mockTable.put(
      challengeRow({ challenge: fixture.challenge, purpose: "attest", expiresAt: new Date(NOW.getTime() - 1_000) }),
    );
    await attempt();
    mockTable.put({
      ...challengeRow({ challenge: fixture.challenge, purpose: "attest", expiresAt: new Date(NOW.getTime() + 60_000) }),
      consumedAt: { S: NOW.toISOString() },
      consumedBy: { S: "someone else" },
    });
    await attempt();
    expect(keyItem(fixture.keyIdB64)).toBeUndefined();
    expect(metricLines("AppAttestAttestations").map((line) => [line.Outcome, line.reason])).toEqual([
      ["challenge", "challenge_unknown"],
      ["challenge", "challenge_purpose"],
      ["challenge", "challenge_expired"],
      ["challenge", "challenge_used"],
    ]);
  });

  it("a failed verification: 400 APP_ATTEST_REJECTED, the reason in the log only, nothing stored", async () => {
    const { fixture, body } = offer("counter_not_zero");
    const result = await handler(event("/app-attest/attest", body));
    expect(result.statusCode).toBe(400);
    expect(json(result)).toEqual({ error: "APP_ATTEST_REJECTED" });
    expect(keyItem(fixture.keyIdB64)).toBeUndefined();
    expect(metricLines("AppAttestAttestations")[0]).toMatchObject({ Outcome: "rejected", reason: "counter_not_zero" });
  });

  it("a malformed key ID or attestation encoding: 400 APP_ATTEST_REJECTED without touching the table", async () => {
    const { body } = offer();
    mockTable.calls.length = 0;
    for (const bad of [
      { ...body, keyId: "short" },
      { ...body, keyId: `${body.keyId.slice(0, 42)}+` },
      { ...body, attestation: "not*base64" },
    ]) {
      const result = await handler(event("/app-attest/attest", bad));
      expect(json(result)).toEqual({ error: "APP_ATTEST_REJECTED" });
    }
    expect(mockTable.calls).toEqual([]);
  });

  it("a malformed challenge: 400 APP_ATTEST_CHALLENGE_INVALID; a malformed body: 400 INVALID_REQUEST", async () => {
    const { body } = offer();
    expect(json(await handler(event("/app-attest/attest", { ...body, challenge: "short" })))).toEqual({
      error: "APP_ATTEST_CHALLENGE_INVALID",
    });
    for (const bad of [{}, { ...body, keyId: 5 }, "not json", [body]]) {
      const result = await handler(event("/app-attest/attest", bad));
      expect(result.statusCode).toBe(400);
      expect(json(result)).toEqual({ error: "INVALID_REQUEST" });
    }
  });

  it("caps the body at 16 KB: 413 PAYLOAD_TOO_LARGE", async () => {
    const { body } = offer();
    const padded = JSON.stringify({ ...body, padding: "x".repeat(16 * 1024) });
    const result = await handler(event("/app-attest/attest", padded));
    expect(result.statusCode).toBe(413);
    expect(json(result)).toEqual({ error: "PAYLOAD_TOO_LARGE" });
    const exact = JSON.stringify({ ...body, padding: "" });
    const fits = exact + " ".repeat(16 * 1024 - Buffer.byteLength(exact));
    expect((await handler(event("/app-attest/attest", fits))).statusCode).toBe(200);
  });

  it("reads a base64-encoded body", async () => {
    const { body } = offer();
    const result = await handler(
      event("/app-attest/attest", Buffer.from(JSON.stringify(body)).toString("base64"), { isBase64Encoded: true }),
    );
    expect(json(result)).toEqual({ status: "attested", environment: "production" });
  });

  it("answers 503 APP_ATTEST_UNAVAILABLE when the table fails at either step", async () => {
    const { body } = offer();
    mockTable.failNext("UpdateItemCommand");
    expect(json(await handler(event("/app-attest/attest", body)))).toEqual({ error: "APP_ATTEST_UNAVAILABLE" });
    mockTable.failNext("PutItemCommand");
    const second = await handler(event("/app-attest/attest", body));
    expect(second.statusCode).toBe(503);
    expect(metricLines("AppAttestAttestations").map((line) => line.Outcome)).toEqual(["error", "error"]);
  });

  it("refuses with 503 while the client mode is off, writing nothing", async () => {
    const { body } = offer();
    mockTable.calls.length = 0;
    process.env.APP_ATTEST_CLIENT_MODE = "off";
    const result = await handler(event("/app-attest/attest", body));
    expect(result.statusCode).toBe(503);
    expect(mockTable.calls).toEqual([]);
  });
});

describe("routing", () => {
  it("answers 404 for another resource and 405 for another method", async () => {
    expect((await handler(event("/app-attest/other", {}))).statusCode).toBe(404);
    expect(
      (await handler({ ...event("/app-attest/challenge", { purpose: "attest" }), httpMethod: "GET" })).statusCode,
    ).toBe(405);
    expect((await handler(null)).statusCode).toBe(405);
  });
});
