/**
 * Synthetic App Attest attestation scenarios. services/scripts/makeAppAttestFixtures.sh reads this
 * module to compute each scenario's nonce, issues one leaf certificate per scenario carrying that
 * nonce (OID 1.2.840.113635.100.8.2), and writes the certificates to synthetic-chain.json. The tests
 * rebuild the same authenticator data from here, check it against the stored hex, and wrap it with
 * the stored certificates into an attestation object.
 *
 * Each failing scenario has exactly one defect, so the reason it expects is the check under test.
 */

import { createHash, createPublicKey } from "node:crypto";
import { AAGUID_DEVELOPMENT, AAGUID_PRODUCTION, AAGUID_SANDBOX, APP_ID_HASH } from "../../../shared/appAttest/config";
import { encodeCbor, type Encodable } from "./cborEncode";

export type LeafKeyName = "p256" | "p384";
export type IntermediateName = "ca" | "notCa";

export interface AuthDataSpec {
  rpIdHash?: "app" | "other";
  /** Default: AT (0x40), plus ED (0x80) when there are extensions. */
  flags?: number;
  counter?: number;
  aaguid?: "production" | "development" | "sandbox" | "unknown";
  credentialIdLength?: number;
  credentialId?: "keyId" | "other";
  extensions?: Record<string, number | string | Uint8Array>;
  trailing?: boolean;
}

export type ScenarioExpectation =
  | { ok: true; environment: "production" | "development"; validationCategory?: number; bundleVersion?: string }
  | { ok: false; reason: string };

export interface AttestationScenario {
  name: string;
  leaf: LeafKeyName;
  intermediate: IntermediateName;
  /** "absent": the leaf certificate carries no nonce extension. */
  nonce?: "absent";
  authData: AuthDataSpec;
  expect: ScenarioExpectation;
}

/** The validation category as devices send it: 4 bytes, little-endian (TestFlight: 02 00 00 00). */
export const categoryBytes = (category: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(category, 0);
  return bytes;
};

export const SCENARIOS: readonly AttestationScenario[] = [
  {
    name: "production_ios26",
    leaf: "p256",
    intermediate: "ca",
    authData: {},
    expect: { ok: true, environment: "production" },
  },
  {
    name: "development_develop",
    leaf: "p256",
    intermediate: "ca",
    authData: { aaguid: "development" },
    expect: { ok: true, environment: "development" },
  },
  {
    name: "development_sandbox",
    leaf: "p256",
    intermediate: "ca",
    authData: { aaguid: "sandbox" },
    expect: { ok: true, environment: "development" },
  },
  {
    name: "production_ios27_testflight",
    leaf: "p256",
    intermediate: "ca",
    authData: { extensions: { apple_validation_category_01: categoryBytes(2), apple_bundle_version_01: "1.2" } },
    expect: { ok: true, environment: "production", validationCategory: 2, bundleVersion: "1.2" },
  },
  {
    name: "production_ios27_app_store",
    leaf: "p256",
    intermediate: "ca",
    authData: { extensions: { apple_validation_category_01: categoryBytes(4) } },
    expect: { ok: true, environment: "production", validationCategory: 4 },
  },
  {
    name: "category_as_an_integer",
    leaf: "p256",
    intermediate: "ca",
    authData: { extensions: { apple_validation_category_01: 2 } },
    expect: { ok: true, environment: "production", validationCategory: 2 },
  },
  {
    name: "category_3_development",
    leaf: "p256",
    intermediate: "ca",
    authData: { extensions: { apple_validation_category_01: categoryBytes(3) } },
    expect: { ok: true, environment: "development", validationCategory: 3 },
  },
  {
    name: "category_5_recorded_as_development",
    leaf: "p256",
    intermediate: "ca",
    authData: { extensions: { apple_validation_category_01: categoryBytes(5) } },
    expect: { ok: true, environment: "development", validationCategory: 5 },
  },
  {
    name: "category_0",
    leaf: "p256",
    intermediate: "ca",
    authData: { extensions: { apple_validation_category_01: categoryBytes(0) } },
    expect: { ok: false, reason: "validation_category" },
  },
  {
    name: "rp_id_mismatch",
    leaf: "p256",
    intermediate: "ca",
    authData: { rpIdHash: "other" },
    expect: { ok: false, reason: "rp_id_mismatch" },
  },
  {
    name: "flags_without_attested_credential",
    leaf: "p256",
    intermediate: "ca",
    authData: { flags: 0x01 },
    expect: { ok: false, reason: "flags" },
  },
  {
    name: "counter_not_zero",
    leaf: "p256",
    intermediate: "ca",
    authData: { counter: 1 },
    expect: { ok: false, reason: "counter_not_zero" },
  },
  {
    name: "aaguid_unknown",
    leaf: "p256",
    intermediate: "ca",
    authData: { aaguid: "unknown" },
    expect: { ok: false, reason: "aaguid" },
  },
  {
    name: "credential_id_length",
    leaf: "p256",
    intermediate: "ca",
    authData: { credentialIdLength: 16 },
    expect: { ok: false, reason: "credential_id_length" },
  },
  {
    name: "credential_id_mismatch",
    leaf: "p256",
    intermediate: "ca",
    authData: { credentialId: "other" },
    expect: { ok: false, reason: "credential_id_mismatch" },
  },
  {
    name: "trailing_bytes",
    leaf: "p256",
    intermediate: "ca",
    authData: { trailing: true },
    expect: { ok: false, reason: "trailing_bytes" },
  },
  {
    name: "extension_wrong_type",
    leaf: "p256",
    intermediate: "ca",
    authData: { extensions: { apple_validation_category_01: "2" } },
    expect: { ok: false, reason: "extensions" },
  },
  {
    name: "category_wrong_length",
    leaf: "p256",
    intermediate: "ca",
    authData: { extensions: { apple_validation_category_01: Buffer.from([2, 0]) } },
    expect: { ok: false, reason: "extensions" },
  },
  {
    name: "intermediate_not_ca",
    leaf: "p256",
    intermediate: "notCa",
    authData: {},
    expect: { ok: false, reason: "intermediate_not_ca" },
  },
  { name: "leaf_p384", leaf: "p384", intermediate: "ca", authData: {}, expect: { ok: false, reason: "leaf_key_type" } },
  {
    name: "leaf_without_nonce",
    leaf: "p256",
    intermediate: "ca",
    nonce: "absent",
    authData: {},
    expect: { ok: false, reason: "nonce_extension" },
  },
];

export const sha256 = (...parts: (Buffer | string)[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** The scenario's challenge: 43 base64url characters, fixed per name. */
export const scenarioChallenge = (name: string): string => sha256(`challenge:${name}`).toString("base64url");

/** x and y of an EC public key, from its PEM. */
export const publicKeyCoordinates = (publicKeyPem: string): { x: Buffer; y: Buffer } => {
  const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" });
  return { x: Buffer.from(String(jwk.x), "base64url"), y: Buffer.from(String(jwk.y), "base64url") };
};

/** The App Attest key ID: SHA-256 of 0x04 || x || y. */
export const keyIdForPublicKey = (publicKeyPem: string): Buffer => {
  const { x, y } = publicKeyCoordinates(publicKeyPem);
  return sha256(Buffer.concat([Buffer.from([0x04]), x, y]));
};

const AAGUIDS: Record<NonNullable<AuthDataSpec["aaguid"]>, Buffer> = {
  production: AAGUID_PRODUCTION,
  development: AAGUID_DEVELOPMENT,
  sandbox: AAGUID_SANDBOX,
  unknown: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
};

/** The attestation authenticator data a scenario describes, for a leaf public key. */
export const buildAttestationAuthData = (spec: AuthDataSpec, leafPublicKeyPem: string): Buffer => {
  const { x, y } = publicKeyCoordinates(leafPublicKeyPem);
  const keyId = keyIdForPublicKey(leafPublicKeyPem);
  const hasExtensions = spec.extensions !== undefined;
  const flags = spec.flags ?? 0x40 | (hasExtensions ? 0x80 : 0);
  const header = Buffer.alloc(37);
  (spec.rpIdHash === "other" ? sha256("TEAMID0000.com.example.other") : APP_ID_HASH).copy(header, 0);
  header[32] = flags;
  header.writeUInt32BE(spec.counter ?? 0, 33);
  const credentialIdLength = spec.credentialIdLength ?? 32;
  const lengthBytes = Buffer.alloc(2);
  lengthBytes.writeUInt16BE(credentialIdLength);
  const credentialId = (spec.credentialId === "other" ? sha256("another credential") : keyId).subarray(
    0,
    credentialIdLength,
  );
  const coseKey: Encodable = new Map<number, Encodable>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
  return Buffer.concat([
    header,
    AAGUIDS[spec.aaguid ?? "production"],
    lengthBytes,
    credentialId,
    encodeCbor(coseKey),
    ...(hasExtensions ? [encodeCbor(spec.extensions as Encodable)] : []),
    ...(spec.trailing ? [Buffer.from([0x00])] : []),
  ]);
};

/** nonce = SHA256(authData || SHA256(challenge)): what the leaf's extension must carry. */
export const attestationNonce = (authData: Buffer, challenge: string): Buffer =>
  sha256(authData, sha256(Buffer.from(challenge, "utf8")));

/** The extension value openssl writes: SEQUENCE { [1] { OCTET STRING nonce } }. */
export const nonceExtensionDerHex = (nonce: Buffer): string => `3024a1220420${nonce.toString("hex")}`;
