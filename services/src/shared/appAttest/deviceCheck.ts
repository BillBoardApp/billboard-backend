/**
 * Apple DeviceCheck two-bit counter (C3 3.5, D2): the only call from the server to Apple, on
 * sign-up only, time-boxed and failing open.
 *
 * The secret (DEVICE_CHECK_SECRET_NAME, `Billboard/AppleDeviceCheckKey`) holds
 * {"keyId", "teamId", "privateKeyPem"} for a .p8 key with DeviceCheck enabled. It is read lazily,
 * once an hour per container; the ES256 JWT is cached for 20 minutes per container.
 */

import { randomUUID, sign as signBytes, createPrivateKey, type KeyObject } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { fetchWithTimeout } from "../http";
import { APPLE_TEAM_ID, TIMING } from "./config";

export const DEVICE_CHECK_HOSTS = {
  production: "https://api.devicecheck.apple.com",
  development: "https://api.development.devicecheck.apple.com",
} as const;

export interface DeviceCheckSecret {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
}

export interface SecretsReader {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
}

export type FetchLike = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

export type QueryResult =
  | { status: "ok"; bit0: boolean; bit1: boolean; lastUpdateTime?: string }
  | { status: "not_found" }
  | { status: "bad_token" }
  | { status: "error"; detail: string };

export type UpdateResult = { status: "ok" } | { status: "bad_token" } | { status: "error"; detail: string };

/** Parses the secret JSON; throws when a field is missing. */
export const parseDeviceCheckSecret = (secretString: string | undefined): DeviceCheckSecret => {
  if (!secretString) throw new Error("DeviceCheck secret is empty");
  const parsed = JSON.parse(secretString) as Record<string, unknown> | null;
  const keyId = typeof parsed?.keyId === "string" ? parsed.keyId.trim() : "";
  const teamId = typeof parsed?.teamId === "string" && parsed.teamId.trim() ? parsed.teamId.trim() : APPLE_TEAM_ID;
  const privateKeyPem = typeof parsed?.privateKeyPem === "string" ? parsed.privateKeyPem : "";
  if (!keyId || !privateKeyPem.includes("PRIVATE KEY"))
    throw new Error("DeviceCheck secret needs keyId and privateKeyPem");
  return { keyId, teamId, privateKeyPem };
};

const base64urlJson = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** ES256 JWT: header {alg, kid}, claims {iss: team ID, iat: seconds}, raw r||s signature. */
export const makeDeviceCheckJwt = (secret: DeviceCheckSecret, key: KeyObject, nowMs: number): string => {
  const signingInput = `${base64urlJson({ alg: "ES256", kid: secret.keyId })}.${base64urlJson({
    iss: secret.teamId,
    iat: Math.floor(nowMs / 1000),
  })}`;
  const signature = signBytes("sha256", Buffer.from(signingInput, "utf8"), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
};

/**
 * Bits to a count of sign-ups (0-3). A last_update_time ("YYYY-MM") `windowMonths` or more months
 * before `now` resets the count to 0 (C3 3.5, Q2: at most DEVICE_MAX_ACCOUNTS new accounts per device in
 * DEVICE_COUNTER_WINDOW_MONTHS).
 */
export const deviceCount = (
  bits: { bit0: boolean; bit1: boolean; lastUpdateTime?: string },
  now: Date,
  windowMonths: number,
): number => {
  const count = (bits.bit1 ? 2 : 0) + (bits.bit0 ? 1 : 0);
  const match = /^(\d{4})-(\d{2})$/.exec(bits.lastUpdateTime ?? "");
  if (count === 0 || !match) return count;
  const updatedMonths = Number(match[1]) * 12 + (Number(match[2]) - 1);
  const nowMonths = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return nowMonths - updatedMonths >= windowMonths ? 0 : count;
};

export const bitsForCount = (count: number): { bit0: boolean; bit1: boolean } => {
  const clamped = Math.max(0, Math.min(3, Math.floor(count)));
  return { bit0: (clamped & 1) === 1, bit1: (clamped & 2) === 2 };
};

interface CachedSecret {
  secret: DeviceCheckSecret;
  key: KeyObject;
  expiresAt: number;
}

const secretCache = new Map<string, CachedSecret>();
const jwtCache = new Map<string, { jwt: string; expiresAt: number }>();
let defaultSecrets: SecretsManagerClient | undefined;

/** Drops the per-container secret and JWT caches (tests, or after a key rotation). */
export const resetDeviceCheckCaches = (): void => {
  secretCache.clear();
  jwtCache.clear();
};

export interface DeviceCheckClientOptions {
  secretName: string;
  secrets?: SecretsReader;
  fetch?: FetchLike;
  now?: () => number;
}

export class DeviceCheckClient {
  private readonly secrets: SecretsReader;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: DeviceCheckClientOptions) {
    this.secrets = options.secrets ?? (defaultSecrets ??= new SecretsManagerClient({}));
    this.fetcher = options.fetch ?? ((url, init, timeoutMs) => fetchWithTimeout(url, init, timeoutMs));
    this.now = options.now ?? Date.now;
  }

  private async loadSecret(): Promise<CachedSecret> {
    const cached = secretCache.get(this.options.secretName);
    if (cached && this.now() < cached.expiresAt) return cached;
    const response = await this.secrets.send(new GetSecretValueCommand({ SecretId: this.options.secretName }));
    const secret = parseDeviceCheckSecret(response.SecretString);
    const entry = {
      secret,
      key: createPrivateKey(secret.privateKeyPem),
      expiresAt: this.now() + TIMING.deviceCheckSecretCacheMs,
    };
    secretCache.set(this.options.secretName, entry);
    return entry;
  }

  /** The bearer token, reused for 20 minutes. */
  async authorization(): Promise<string> {
    const { secret, key } = await this.loadSecret();
    const cacheKey = `${this.options.secretName}|${secret.keyId}`;
    const cached = jwtCache.get(cacheKey);
    if (cached && this.now() < cached.expiresAt) return cached.jwt;
    const jwt = makeDeviceCheckJwt(secret, key, this.now());
    jwtCache.set(cacheKey, { jwt, expiresAt: this.now() + TIMING.deviceCheckJwtCacheMs });
    return jwt;
  }

  private async post(
    path: "/v1/query_two_bits" | "/v1/update_two_bits",
    body: Record<string, unknown>,
    input: { development: boolean; timeoutMs: number },
  ): Promise<Response> {
    const host = input.development ? DEVICE_CHECK_HOSTS.development : DEVICE_CHECK_HOSTS.production;
    const jwt = await this.authorization();
    return this.fetcher(
      `${host}${path}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, transaction_id: randomUUID(), timestamp: this.now() }),
      },
      input.timeoutMs,
    );
  }

  /** query_two_bits. Never throws: a timeout, a network error, 429 or 5xx is `error`. */
  async query(token: string, input: { development: boolean; timeoutMs: number }): Promise<QueryResult> {
    try {
      const response = await this.post("/v1/query_two_bits", { device_token: token }, input);
      if (response.status === 400) return { status: "bad_token" };
      if (response.status !== 200) return { status: "error", detail: `HTTP ${response.status}` };
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // "Bit State Not Found": the device never had bits set for this team.
        return { status: "not_found" };
      }
      const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      return {
        status: "ok",
        bit0: record.bit0 === true,
        bit1: record.bit1 === true,
        ...(typeof record.last_update_time === "string" ? { lastUpdateTime: record.last_update_time } : {}),
      };
    } catch (error) {
      return { status: "error", detail: error instanceof Error ? error.name : "unknown" };
    }
  }

  /** update_two_bits. Never throws. */
  async update(
    token: string,
    bits: { bit0: boolean; bit1: boolean },
    input: { development: boolean; timeoutMs: number },
  ): Promise<UpdateResult> {
    try {
      const response = await this.post("/v1/update_two_bits", { device_token: token, ...bits }, input);
      if (response.status === 200) return { status: "ok" };
      if (response.status === 400) return { status: "bad_token" };
      return { status: "error", detail: `HTTP ${response.status}` };
    } catch (error) {
      return { status: "error", detail: error instanceof Error ? error.name : "unknown" };
    }
  }
}
