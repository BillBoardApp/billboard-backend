/**
 * The App Attest wire formats (C3 4.3, frozen in contracts/README.md "App Attest (INT-04)"):
 * the marker grammar of the X-Billboard-App-Attest header and the billboardAppAttest
 * ClientMetadata value, clientData parsing and checks, base64url, the email hash, version
 * comparison and the cognito:groups claim.
 */

import { createHash } from "node:crypto";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { LIMITS, parseAppVersion } from "./config";

export const APP_ATTEST_HEADER = "x-billboard-app-attest";
export const APP_VERSION_HEADER = "x-billboard-app-version";

/** Pre-sign-up ClientMetadata keys R2 sends. */
export const CLIENT_METADATA_KEYS = {
  appAttest: "billboardAppAttest",
  deviceCheck: "billboardDeviceCheck",
  appVersion: "billboardAppVersion",
} as const;

/** Client error codes recorded as sent; any other is recorded as "other". */
export const CLIENT_ERROR_CODES = ["challenge", "attest", "assert", "timeout", "disabled", "keychain"] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number] | "other";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** Strict base64url without padding; null for anything else (including the impossible length 4n+1). */
export const decodeBase64url = (value: string): Buffer | null => {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return null;
  return Buffer.from(value, "base64url");
};

/** Strict standard base64 with padding (Apple's attestation and DeviceCheck token encoding). */
export const decodeStandardBase64 = (value: string): Buffer | null => {
  if (typeof value !== "string" || value.length === 0 || !STANDARD_BASE64_PATTERN.test(value)) return null;
  return Buffer.from(value, "base64");
};

export const sha256 = (bytes: Uint8Array | string): Buffer => createHash("sha256").update(bytes).digest();

/** base64url(SHA-256(lower-case(trim(email)))): the sign-up clientData's emailSha256. */
export const emailSha256 = (email: string): string =>
  base64url(sha256(Buffer.from(email.trim().toLowerCase(), "utf8")));

export type ParsedMarker =
  | { kind: "missing" }
  | { kind: "unsupported" }
  | { kind: "bypass" }
  | { kind: "client_error"; code: ClientErrorCode }
  | { kind: "malformed"; reason: string }
  | {
      kind: "assertion";
      /** The key ID re-encoded from its bytes (canonical base64url): the table key. */
      keyId: string;
      keyIdBytes: Buffer;
      clientData: Buffer;
      assertion: Buffer;
    };

/** Parses a marker (header or ClientMetadata value). Never throws. */
export const parseMarker = (value: unknown): ParsedMarker => {
  if (value === undefined || value === null || value === "") return { kind: "missing" };
  if (typeof value !== "string") return { kind: "malformed", reason: "marker_not_text" };
  if (value.length > LIMITS.maxMarkerLength) return { kind: "malformed", reason: "marker_too_long" };
  if (value === "v1.u") return { kind: "unsupported" };
  if (value === "v1.b") return { kind: "bypass" };
  if (value.startsWith("v1.e.")) {
    const code = value.slice("v1.e.".length);
    return {
      kind: "client_error",
      code: (CLIENT_ERROR_CODES as readonly string[]).includes(code) ? (code as ClientErrorCode) : "other",
    };
  }
  if (!value.startsWith("v1.a.")) return { kind: "malformed", reason: "marker_unknown_form" };
  const segments = value.slice("v1.a.".length).split(".");
  if (segments.length !== 3) return { kind: "malformed", reason: "marker_segments" };
  const [keyId, clientDataSegment, assertionSegment] = segments;
  const keyIdBytes = decodeBase64url(keyId);
  const clientData = decodeBase64url(clientDataSegment);
  const assertion = decodeBase64url(assertionSegment);
  if (!keyIdBytes || !clientData || !assertion) return { kind: "malformed", reason: "marker_base64url" };
  if (keyIdBytes.length !== LIMITS.keyIdBytes) return { kind: "malformed", reason: "key_id_length" };
  if (clientData.length === 0 || clientData.length > LIMITS.maxClientDataBytes) {
    return { kind: "malformed", reason: "client_data_length" };
  }
  if (assertion.length === 0 || assertion.length > LIMITS.maxAssertionBytes) {
    return { kind: "malformed", reason: "assertion_length" };
  }
  // Re-encode: a 32-byte ID has several base64url spellings (the last character's spare bits),
  // and the server compares decoded bytes (C3 4.3).
  return { kind: "assertion", keyId: base64url(keyIdBytes), keyIdBytes, clientData, assertion };
};

/** First value of a header, by case-insensitive name, from a REST proxy event. */
export const readHeader = (event: Pick<APIGatewayProxyEvent, "headers" | "multiValueHeaders">, name: string) => {
  const wanted = name.toLowerCase();
  const multi = event?.multiValueHeaders ?? {};
  for (const [key, values] of Object.entries(multi)) {
    if (key.toLowerCase() === wanted && Array.isArray(values) && values.length > 0) return String(values[0]);
  }
  const single = event?.headers ?? {};
  for (const [key, value] of Object.entries(single)) {
    if (key.toLowerCase() === wanted && value !== undefined && value !== null) return String(value);
  }
  return undefined;
};

/**
 * Whether the request carries X-Billboard-App-Version with a value, under any letter case, in `headers` or
 * `multiValueHeaders` (HTTP/2 sends header names in lower case). R2 (1.2) sends it on every user API request whenever
 * its version is known; builds 1.0 and R1 (1.1) never send it, so a request without it is treated as one of those.
 */
export const sendsAppVersion = (event: Pick<APIGatewayProxyEvent, "headers" | "multiValueHeaders">): boolean =>
  (readHeader(event, APP_VERSION_HEADER) ?? "").trim().length > 0;

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** clientData as a JSON object, or null when it is not UTF-8 JSON with an object at the top. */
export const parseClientData = (bytes: Buffer): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(textDecoder.decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export type ClientDataFailure =
  | "client_data_json"
  | "client_data_version"
  | "client_data_purpose"
  | "client_data_challenge"
  | "client_data_method"
  | "client_data_path"
  | "client_data_body"
  | "client_data_email";

export interface RequestBinding {
  method: string;
  path: string;
  bodySha256: string;
}

const checkCommon = (
  clientData: Record<string, unknown> | null,
  purpose: "request" | "signup",
): { failure: ClientDataFailure } | { challenge: string } => {
  if (!clientData) return { failure: "client_data_json" };
  if (clientData.v !== 1) return { failure: "client_data_version" };
  if (clientData.purpose !== purpose) return { failure: "client_data_purpose" };
  if (typeof clientData.challenge !== "string" || clientData.challenge.length === 0) {
    return { failure: "client_data_challenge" };
  }
  return { challenge: clientData.challenge };
};

export type ClientDataCheck = { ok: true; challenge: string } | { ok: false; reason: ClientDataFailure };

/** A protected request's clientData: v 1, purpose request, and the method, path and body hash. */
export const checkRequestClientData = (clientDataBytes: Buffer, binding: RequestBinding): ClientDataCheck => {
  const clientData = parseClientData(clientDataBytes);
  const common = checkCommon(clientData, "request");
  if ("failure" in common) return { ok: false, reason: common.failure };
  if (clientData?.method !== binding.method) return { ok: false, reason: "client_data_method" };
  if (clientData?.path !== binding.path) return { ok: false, reason: "client_data_path" };
  if (clientData?.bodySha256 !== binding.bodySha256) return { ok: false, reason: "client_data_body" };
  return { ok: true, challenge: common.challenge };
};

/** A sign-up's clientData: v 1, purpose signup, and emailSha256 of the address being registered. */
export const checkSignUpClientData = (clientDataBytes: Buffer, expectedEmailSha256: string): ClientDataCheck => {
  const clientData = parseClientData(clientDataBytes);
  const common = checkCommon(clientData, "signup");
  if ("failure" in common) return { ok: false, reason: common.failure };
  if (clientData?.emailSha256 !== expectedEmailSha256) return { ok: false, reason: "client_data_email" };
  return { ok: true, challenge: common.challenge };
};

/** The raw body bytes API Gateway received (empty when there is none). */
export const rawBody = (event: Pick<APIGatewayProxyEvent, "body" | "isBase64Encoded">): Buffer =>
  typeof event?.body === "string"
    ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
    : Buffer.alloc(0);

export const bodySha256 = (event: Pick<APIGatewayProxyEvent, "body" | "isBase64Encoded">): string =>
  base64url(sha256(rawBody(event)));

const versionParts = (version: string): number[] => version.split(".").map((part) => Number(part));

/** Negative when a < b, 0 when equal, positive when a > b; missing parts count as 0 (1.2 == 1.2.0). */
export const compareVersions = (a: string, b: string): number => {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** True when MIN_APP_VERSION is set and the reported version is missing, unreadable or older. */
export const isBelowMinimumVersion = (reported: unknown, minimum: string | null): boolean => {
  if (!minimum) return false;
  const version = parseAppVersion(reported);
  return version === null || compareVersions(version, minimum) < 0;
};

/**
 * The cognito:groups claim as a list. API Gateway's Cognito authorizer passes it as a string,
 * "[a b]" today; also accepted: an array, "a,b" and a JSON array string.
 */
export const parseCognitoGroups = (claim: unknown): string[] => {
  if (Array.isArray(claim)) return claim.filter((group): group is string => typeof group === "string" && group !== "");
  if (typeof claim !== "string") return [];
  const value = claim.trim();
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parseCognitoGroups(parsed);
    } catch {
      // Not JSON: the "[a b]" form.
    }
    return value
      .slice(1, value.endsWith("]") ? -1 : undefined)
      .split(/[\s,]+/)
      .filter(Boolean);
  }
  return value.split(/[\s,]+/).filter(Boolean);
};

/** The first 8 characters of a key ID: enough to correlate logs, never the full ID (C3 3.11). */
export const keyIdPrefix = (keyId: string | undefined): string | undefined => keyId?.slice(0, 8);
