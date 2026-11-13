/**
 * App Attest (INT-04, decision 8A): constants and the environment switches.
 *
 * Every switch is read per call from the environment and parsing never throws, so a module that
 * imports this one loads with no environment at all (C3 3.12). With nothing set, every mode is
 * `off`: no reads, no writes, no metric and no vote-row attribute (C3 3.1, D5).
 *
 * The defaults and the key lifetimes are anti-abuse values: they live in ../abuseLimits.ts.
 */

import { APP_ATTEST_BINDING_TTL_SECONDS, APP_ATTEST_DEFAULTS, APP_ATTEST_KEY_TTL_SECONDS } from "../abuseLimits";

/** Apple developer team that signs the app (project.pbxproj DEVELOPMENT_TEAM). */
export const APPLE_TEAM_ID = "9R36JN7XJ5";
export const APP_BUNDLE_ID = "com.billboardproject.app";
/** The App ID App Attest binds keys to. */
export const APP_ID = `${APPLE_TEAM_ID}.${APP_BUNDLE_ID}`;
/** SHA-256 of APP_ID: the RP ID hash in every authenticator data. A unit test recomputes it. */
export const APP_ID_HASH = Buffer.from("054a8f8782734b4084bf83fbaeca9f683224e73efcae00801a005e900a7fcf2b", "hex");

/** aaguid of a production attestation: "appattest" followed by seven zero bytes. */
export const AAGUID_PRODUCTION = Buffer.from("61707061747465737400000000000000", "hex");
/** aaguid of a development (sandbox) attestation: "appattestdevelop". */
export const AAGUID_DEVELOPMENT = Buffer.from("617070617474657374646576656c6f70", "hex");
/** The value a second Apple page gives for the sandbox: "appattestsandbox". Accepted as development. */
export const AAGUID_SANDBOX = Buffer.from("61707061747465737473616e64626f78", "hex");

/** DER of OID 1.2.840.113635.100.8.2, the leaf extension that carries the attestation nonce. */
export const NONCE_EXTENSION_OID_DER = Buffer.from("06092a864886f763640802", "hex");

/** CloudWatch namespace of every App Attest metric (EMF, so no PutMetricData grant). */
export const METRIC_NAMESPACE = "BillBoard/AppAttest";

export const LIMITS = {
  /** X-Billboard-App-Attest and ClientMetadata billboardAppAttest, in characters. */
  maxMarkerLength: 2048,
  keyIdBytes: 32,
  maxClientDataBytes: 1024,
  maxAssertionBytes: 512,
  /** POST /app-attest/attest body, in bytes (413 above it). */
  maxAttestBodyBytes: 16 * 1024,
  /** Decoded attestation object, in bytes (the CBOR decoder's input cap). */
  maxAttestationBytes: 16 * 1024,
  maxCborDepth: 8,
  challengeBytes: 32,
  /** X-Billboard-App-Version / billboardAppVersion, in characters. */
  maxAppVersionLength: 32,
} as const;

export const TIMING = {
  /** Each DynamoDB call in the request path (C3 3.4). */
  dynamoRequestTimeoutMs: 800,
  dynamoMaxAttempts: 2,
  /** The whole evaluation of a protected request (C3 3.4). */
  requestBudgetMs: 1500,
  /** The App Attest sign-up check, inside PreSignUpCheck's shared 3.5 s deadline (integration plan X4). */
  signUpBudgetMs: 1200,
  /** Each DeviceCheck call: at most min(1,000 ms, time left - 200 ms) (X4). */
  deviceCheckCallMaxMs: 1000,
  deviceCheckReserveMs: 200,
  /** A challenge row lives one hour past its expiry (then DynamoDB TTL removes it). */
  challengeRowGraceSeconds: 3600,
  /** Keys and bindings expire this long after their last use. */
  keyTtlSeconds: APP_ATTEST_KEY_TTL_SECONDS,
  bindingTtlSeconds: APP_ATTEST_BINDING_TTL_SECONDS,
  /** A binding's lastSeenAt is refreshed when older than this. */
  bindingRefreshMs: 24 * 60 * 60 * 1000,
  deviceCheckJwtCacheMs: 20 * 60 * 1000,
  deviceCheckSecretCacheMs: 60 * 60 * 1000,
} as const;

export const DEFAULTS = APP_ATTEST_DEFAULTS;

/** off: nothing at all. watch: verify, record, emit metrics, never block. enforce: block. */
export type AppAttestMode = "off" | "watch" | "enforce";
/** APP_ATTEST_CLIENT_MODE on the AppAttest function: off is R2's kill switch. */
export type ClientMode = "on" | "off";
export type KeyEnvironment = "production" | "development";

export interface AppAttestConfig {
  /** APP_ATTEST_MODE, forced to off when APP_ATTEST_TABLE_NAME is unset. */
  mode: AppAttestMode;
  /** DEVICE_CHECK_MODE, forced to off when DEVICE_CHECK_SECRET_NAME is unset. */
  deviceCheckMode: AppAttestMode;
  /** APP_ATTEST_CLIENT_MODE, forced to off when APP_ATTEST_TABLE_NAME is unset. */
  clientMode: ClientMode;
  /** APP_ATTEST_ALLOWED_ENVIRONMENTS: whether development keys pass under enforce. */
  developmentAllowed: boolean;
  maxAccountsPerKey: number;
  deviceMaxAccounts: number;
  deviceCounterWindowMonths: number;
  failClosed: boolean;
  /** MIN_APP_VERSION; null when empty or not a dotted version. */
  minAppVersion: string | null;
  challengeTtlSeconds: number;
  tableName: string | null;
  exemptGroup: string;
  deviceCheckSecretName: string | null;
}

type Env = Record<string, string | undefined>;

const trimmed = (value: string | undefined): string => (value ?? "").trim();

/**
 * Unset or empty: off (the code default, so functions without the variable are untouched).
 * off, watch, enforce in any case: that mode. Anything else: watch, which never blocks; the same
 * rule as PENDING_EXPIRY_MODE (integration plan X6), so a typo cannot turn blocking on.
 */
export const parseMode = (value: string | undefined): AppAttestMode => {
  const normalized = trimmed(value).toLowerCase();
  if (normalized === "") return "off";
  if (normalized === "off" || normalized === "watch" || normalized === "enforce") return normalized;
  return "watch";
};

/** on in any case: on. Anything else, including unset: off (the kill-switch side). */
export const parseClientMode = (value: string | undefined): ClientMode =>
  trimmed(value).toLowerCase() === "on" ? "on" : "off";

const parseIntegerInRange = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const raw = trimmed(value);
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const VERSION_PATTERN = /^\d{1,9}(?:\.\d{1,9}){0,2}$/;

/** A dotted version of one to three numbers (the AppVersion contract), or null. */
export const parseAppVersion = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate.length <= LIMITS.maxAppVersionLength && VERSION_PATTERN.test(candidate) ? candidate : null;
};

export const appAttestConfigFromEnv = (env: Env = process.env): AppAttestConfig => {
  const tableName = trimmed(env.APP_ATTEST_TABLE_NAME) || null;
  const deviceCheckSecretName = trimmed(env.DEVICE_CHECK_SECRET_NAME) || null;
  const environments = trimmed(env.APP_ATTEST_ALLOWED_ENVIRONMENTS)
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim());
  return {
    mode: tableName ? parseMode(env.APP_ATTEST_MODE) : "off",
    deviceCheckMode: deviceCheckSecretName ? parseMode(env.DEVICE_CHECK_MODE) : "off",
    clientMode: tableName ? parseClientMode(env.APP_ATTEST_CLIENT_MODE) : "off",
    developmentAllowed: environments.includes("development"),
    maxAccountsPerKey: parseIntegerInRange(env.APP_ATTEST_MAX_ACCOUNTS_PER_KEY, DEFAULTS.maxAccountsPerKey, 1, 1000),
    // Two DeviceCheck bits hold 0 to 3.
    deviceMaxAccounts: parseIntegerInRange(env.DEVICE_MAX_ACCOUNTS, DEFAULTS.deviceMaxAccounts, 1, 3),
    deviceCounterWindowMonths: parseIntegerInRange(
      env.DEVICE_COUNTER_WINDOW_MONTHS,
      DEFAULTS.deviceCounterWindowMonths,
      1,
      120,
    ),
    failClosed: trimmed(env.APP_ATTEST_FAIL_CLOSED).toLowerCase() === "true",
    minAppVersion: parseAppVersion(env.MIN_APP_VERSION),
    challengeTtlSeconds: parseIntegerInRange(
      env.APP_ATTEST_CHALLENGE_TTL_SECONDS,
      DEFAULTS.challengeTtlSeconds,
      30,
      3600,
    ),
    tableName,
    exemptGroup: trimmed(env.APP_ATTEST_EXEMPT_GROUP) || DEFAULTS.exemptGroup,
    deviceCheckSecretName,
  };
};
