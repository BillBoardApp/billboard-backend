import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  DEVICE_CHECK_HOSTS,
  DeviceCheckClient,
  bitsForCount,
  deviceCount,
  parseDeviceCheckSecret,
  resetDeviceCheckCaches,
  type FetchLike,
} from "../shared/appAttest/deviceCheck";
import { APP_ATTEST_DEFAULTS } from "../shared/abuseLimits";
import { TimeoutError } from "../shared/http";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const SECRET = {
  keyId: "ABC123DEFG",
  teamId: "9R36JN7XJ5",
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const NOW_MS = Date.parse("2026-10-08T12:00:00.000Z");

const secretsReader = (secretString: string | undefined = JSON.stringify(SECRET)) => ({
  send: jest.fn(async (_command: GetSecretValueCommand) => ({ SecretString: secretString, $metadata: {} })),
});

const response = (status: number, body: string): Response => new Response(body, { status });

const makeClient = (fetchImpl: FetchLike, secrets = secretsReader(), now = () => NOW_MS) =>
  new DeviceCheckClient({ secretName: "Billboard/AppleDeviceCheckKey", secrets, fetch: fetchImpl, now });

beforeEach(() => resetDeviceCheckCaches());

describe("JWT", () => {
  it("has header {alg: ES256, kid}, claims {iss, iat} and a raw r||s signature by the secret's key", async () => {
    const client = makeClient(jest.fn());
    const jwt = await client.authorization();
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "9R36JN7XJ5", iat: NOW_MS / 1000 });
    const raw = Buffer.from(signature, "base64url");
    expect(raw.length).toBe(64);
    expect(
      verifySignature("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, raw),
    ).toBe(true);
  });

  it("is reused for 20 minutes, and the secret is read once an hour", async () => {
    const secrets = secretsReader();
    let now = NOW_MS;
    const client = makeClient(jest.fn(), secrets, () => now);
    const first = await client.authorization();
    now += 19 * 60 * 1000;
    expect(await client.authorization()).toBe(first);
    now += 2 * 60 * 1000;
    const second = await client.authorization();
    expect(second).not.toBe(first);
    expect(secrets.send).toHaveBeenCalledTimes(1);
    // A new client in the same container shares the caches.
    expect(await makeClient(jest.fn(), secrets, () => now).authorization()).toBe(second);
    now += 60 * 60 * 1000;
    await client.authorization();
    expect(secrets.send).toHaveBeenCalledTimes(2);
    expect(secrets.send.mock.calls[0][0].input).toEqual({ SecretId: "Billboard/AppleDeviceCheckKey" });
  });

  it("parseDeviceCheckSecret requires keyId and a private key, defaulting the team", () => {
    expect(parseDeviceCheckSecret(JSON.stringify({ keyId: "K", privateKeyPem: SECRET.privateKeyPem }))).toMatchObject({
      keyId: "K",
      teamId: "9R36JN7XJ5",
    });
    expect(() => parseDeviceCheckSecret(undefined)).toThrow("empty");
    expect(() => parseDeviceCheckSecret(JSON.stringify({ keyId: "K" }))).toThrow("keyId and privateKeyPem");
    expect(() => parseDeviceCheckSecret("not json")).toThrow();
  });
});

describe("query", () => {
  it("posts the token with a transaction id and millisecond timestamp to the production host", async () => {
    const fetchImpl = jest.fn(async () => response(200, '{"bit0":true,"bit1":false,"last_update_time":"2026-09"}'));
    const result = await makeClient(fetchImpl).query("dG9rZW4=", { development: false, timeoutMs: 900 });
    expect(result).toEqual({ status: "ok", bit0: true, bit1: false, lastUpdateTime: "2026-09" });
    const [url, init, timeoutMs] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit, number];
    expect(url).toBe(`${DEVICE_CHECK_HOSTS.production}/v1/query_two_bits`);
    expect(timeoutMs).toBe(900);
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ device_token: "dG9rZW4=", transaction_id: expect.any(String), timestamp: NOW_MS });
  });

  it("uses Apple's development host for development keys", async () => {
    const fetchImpl = jest.fn(async () => response(200, "Bit State Not Found"));
    await makeClient(fetchImpl).query("dG9rZW4=", { development: true, timeoutMs: 900 });
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(`${DEVICE_CHECK_HOSTS.development}/v1/query_two_bits`);
  });

  it("maps Bit State Not Found, 400, 429, 5xx, timeouts and secret failures", async () => {
    const query = (fetchImpl: FetchLike, secrets = secretsReader()) =>
      makeClient(fetchImpl, secrets).query("dG9rZW4=", { development: false, timeoutMs: 900 });
    expect(await query(async () => response(200, "Bit State Not Found"))).toEqual({ status: "not_found" });
    expect(await query(async () => response(400, "Missing or badly formatted authorization token"))).toEqual({
      status: "bad_token",
    });
    expect(await query(async () => response(429, ""))).toEqual({ status: "error", detail: "HTTP 429" });
    expect(await query(async () => response(503, ""))).toEqual({ status: "error", detail: "HTTP 503" });
    expect(
      await query(async () => {
        throw new TimeoutError("timed out", 900);
      }),
    ).toEqual({ status: "error", detail: "TimeoutError" });
    resetDeviceCheckCaches();
    expect(await query(async () => response(200, "{}"), secretsReader("{}"))).toMatchObject({ status: "error" });
  });
});

describe("update", () => {
  it("posts the bits and maps the status", async () => {
    const fetchImpl = jest.fn(async () => response(200, ""));
    expect(
      await makeClient(fetchImpl).update(
        "dG9rZW4=",
        { bit0: true, bit1: true },
        { development: false, timeoutMs: 500 },
      ),
    ).toEqual({
      status: "ok",
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEVICE_CHECK_HOSTS.production}/v1/update_two_bits`);
    expect(JSON.parse(String(init.body))).toMatchObject({ device_token: "dG9rZW4=", bit0: true, bit1: true });
    expect(
      await makeClient(async () => response(400, "")).update(
        "x",
        { bit0: false, bit1: false },
        { development: false, timeoutMs: 1 },
      ),
    ).toEqual({
      status: "bad_token",
    });
    expect(
      await makeClient(async () => response(500, "")).update(
        "x",
        { bit0: false, bit1: false },
        { development: false, timeoutMs: 1 },
      ),
    ).toEqual({
      status: "error",
      detail: "HTTP 500",
    });
    expect(
      await makeClient(async () => {
        throw new Error("socket hang up");
      }).update("x", { bit0: false, bit1: false }, { development: false, timeoutMs: 1 }),
    ).toEqual({ status: "error", detail: "Error" });
  });
});

describe("counting", () => {
  const now = new Date(NOW_MS);
  const WINDOW = APP_ATTEST_DEFAULTS.deviceCounterWindowMonths;
  /** The "YYYY-MM" month this many months before `now`. */
  const monthsAgo = (months: number): string => {
    const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  };

  it("reads the two bits as a count", () => {
    const thisMonth = monthsAgo(0);
    expect(deviceCount({ bit0: false, bit1: false }, now, WINDOW)).toBe(0);
    expect(deviceCount({ bit0: true, bit1: false, lastUpdateTime: thisMonth }, now, WINDOW)).toBe(1);
    expect(deviceCount({ bit0: false, bit1: true, lastUpdateTime: thisMonth }, now, WINDOW)).toBe(2);
    expect(deviceCount({ bit0: true, bit1: true, lastUpdateTime: thisMonth }, now, WINDOW)).toBe(3);
  });

  it("resets to 0 when the last update is the window or more months old", () => {
    expect(deviceCount({ bit0: true, bit1: true, lastUpdateTime: monthsAgo(WINDOW - 1) }, now, WINDOW)).toBe(3);
    expect(deviceCount({ bit0: true, bit1: true, lastUpdateTime: monthsAgo(WINDOW) }, now, WINDOW)).toBe(0);
    expect(deviceCount({ bit0: true, bit1: true, lastUpdateTime: "2019-01" }, now, WINDOW)).toBe(0);
    // A narrower window passed as the parameter resets sooner.
    expect(deviceCount({ bit0: true, bit1: true, lastUpdateTime: monthsAgo(WINDOW - 1) }, now, WINDOW - 1)).toBe(0);
    expect(deviceCount({ bit0: true, bit1: true }, now, WINDOW)).toBe(3);
  });

  it("writes a count back as bits", () => {
    expect(bitsForCount(0)).toEqual({ bit0: false, bit1: false });
    expect(bitsForCount(1)).toEqual({ bit0: true, bit1: false });
    expect(bitsForCount(2)).toEqual({ bit0: false, bit1: true });
    expect(bitsForCount(3)).toEqual({ bit0: true, bit1: true });
    expect(bitsForCount(9)).toEqual({ bit0: true, bit1: true });
  });
});
