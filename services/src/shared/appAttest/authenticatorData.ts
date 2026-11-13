/**
 * App Attest authenticator data (WebAuthn layout) in its two forms.
 *
 * Attestation (C3 3.3 step 7, checked in this order): bytes 0-31 RP ID hash; byte 32 flags, AT
 * (0x40) set; bytes 33-36 counter (big-endian), 0; bytes 37-52 aaguid; bytes 53-54 credential ID
 * length, 32; bytes 55-86 credential ID, equal to the key ID; then one CBOR item, the COSE key
 * (decoded only to find its end); then, when ED (0x80) is set, an extensions CBOR map; then
 * nothing.
 *
 * Assertion (C3 3.4 step 6): at least 37 bytes; RP ID hash, flags and counter as above; when ED
 * is set an extensions map may follow. The whole buffer is under the key's signature, so an
 * unreadable extensions map in an assertion only means nothing is recorded from it.
 *
 * Extensions (iOS 27 and later): apple_validation_category_01 (2 TestFlight, 3 development-signed,
 * 4 App Store) and apple_bundle_version_01 (text). Absent on iOS 26. Devices send the category as a
 * 4-byte byte string, little-endian (TestFlight: 02 00 00 00), not as a CBOR integer: every iOS 27
 * attestation was rejected for that until 2026-11-03. An unsigned integer is still accepted.
 */

import { decodeCborItem, isCborMap, type CborMap, type CborValue } from "./cbor";
import { AAGUID_DEVELOPMENT, AAGUID_PRODUCTION, AAGUID_SANDBOX, LIMITS } from "./config";

export const FLAG_ATTESTED_CREDENTIAL = 0x40;
export const FLAG_EXTENSIONS = 0x80;

const RP_ID_HASH_END = 32;
const FLAGS_OFFSET = 32;
const COUNTER_OFFSET = 33;
const MIN_LENGTH = 37;
const AAGUID_END = 53;
const CREDENTIAL_ID_START = 55;

export const EXTENSION_VALIDATION_CATEGORY = "apple_validation_category_01";
export const EXTENSION_BUNDLE_VERSION = "apple_bundle_version_01";

export type AuthenticatorDataFailure =
  | "auth_data_short"
  | "rp_id_mismatch"
  | "flags"
  | "counter_not_zero"
  | "aaguid"
  | "credential_id_length"
  | "credential_id_mismatch"
  | "cose_key"
  | "extensions"
  | "trailing_bytes";

export class AuthenticatorDataError extends Error {
  constructor(
    readonly reason: AuthenticatorDataFailure,
    message: string = reason,
  ) {
    super(message);
    this.name = "AuthenticatorDataError";
  }
}

export type AaguidKind = "production" | "development" | "sandbox";

export interface AuthenticatorExtensions {
  validationCategory?: number;
  bundleVersion?: string;
}

export interface AssertionAuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  extensions: AuthenticatorExtensions;
}

export interface AttestationAuthenticatorData extends AssertionAuthenticatorData {
  aaguid: AaguidKind;
  credentialId: Buffer;
}

export const aaguidKind = (aaguid: Buffer): AaguidKind | null => {
  if (aaguid.equals(AAGUID_PRODUCTION)) return "production";
  if (aaguid.equals(AAGUID_DEVELOPMENT)) return "development";
  if (aaguid.equals(AAGUID_SANDBOX)) return "sandbox";
  return null;
};

const VALIDATION_CATEGORY_BYTES = 4;

/** The validation category: a 4-byte little-endian byte string, as devices send it, or an unsigned integer. */
const readValidationCategory = (value: CborValue): number => {
  if (Buffer.isBuffer(value)) {
    if (value.length !== VALIDATION_CATEGORY_BYTES) {
      throw new AuthenticatorDataError("extensions", `validation category is ${value.length} bytes, not 4`);
    }
    return value.readUInt32LE(0);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return value;
  throw new AuthenticatorDataError("extensions", "validation category is neither 4 bytes nor an unsigned integer");
};

/** Reads the two known extensions; wrong types throw AuthenticatorDataError("extensions"). */
export const readExtensions = (map: CborMap): AuthenticatorExtensions => {
  const extensions: AuthenticatorExtensions = {};
  const category = map.get(EXTENSION_VALIDATION_CATEGORY);
  if (category !== undefined) extensions.validationCategory = readValidationCategory(category);
  const bundleVersion = map.get(EXTENSION_BUNDLE_VERSION);
  if (bundleVersion !== undefined) {
    if (typeof bundleVersion !== "string") {
      throw new AuthenticatorDataError("extensions", "bundle version is not text");
    }
    extensions.bundleVersion = bundleVersion;
  }
  return extensions;
};

const decodeMapAt = (
  authData: Buffer,
  offset: number,
  reason: AuthenticatorDataFailure,
): { map: CborMap; end: number } => {
  let decoded;
  try {
    decoded = decodeCborItem(authData, offset, { maxBytes: LIMITS.maxAttestationBytes });
  } catch (error) {
    throw new AuthenticatorDataError(reason, error instanceof Error ? error.message : String(error));
  }
  if (!isCborMap(decoded.value)) throw new AuthenticatorDataError(reason, "not a CBOR map");
  return { map: decoded.value, end: decoded.end };
};

const readHeader = (authData: Buffer, expectedRpIdHash: Buffer): Omit<AssertionAuthenticatorData, "extensions"> => {
  if (authData.length < MIN_LENGTH) throw new AuthenticatorDataError("auth_data_short");
  const rpIdHash = Buffer.from(authData.subarray(0, RP_ID_HASH_END));
  if (!rpIdHash.equals(expectedRpIdHash)) throw new AuthenticatorDataError("rp_id_mismatch");
  return { rpIdHash, flags: authData[FLAGS_OFFSET], counter: authData.readUInt32BE(COUNTER_OFFSET) };
};

/** Parses and checks the attestation form; throws AuthenticatorDataError with the first failure. */
export const parseAttestationAuthData = (
  authData: Buffer,
  expected: { rpIdHash: Buffer; keyId: Buffer },
): AttestationAuthenticatorData => {
  const header = readHeader(authData, expected.rpIdHash);
  if ((header.flags & FLAG_ATTESTED_CREDENTIAL) === 0) throw new AuthenticatorDataError("flags");
  if (header.counter !== 0) throw new AuthenticatorDataError("counter_not_zero");
  if (authData.length < CREDENTIAL_ID_START) throw new AuthenticatorDataError("auth_data_short");
  const aaguid = aaguidKind(authData.subarray(MIN_LENGTH, AAGUID_END));
  if (!aaguid) throw new AuthenticatorDataError("aaguid");
  const credentialIdLength = authData.readUInt16BE(AAGUID_END);
  if (credentialIdLength !== LIMITS.keyIdBytes) throw new AuthenticatorDataError("credential_id_length");
  const credentialEnd = CREDENTIAL_ID_START + credentialIdLength;
  if (authData.length < credentialEnd) throw new AuthenticatorDataError("auth_data_short");
  const credentialId = Buffer.from(authData.subarray(CREDENTIAL_ID_START, credentialEnd));
  if (!credentialId.equals(expected.keyId)) throw new AuthenticatorDataError("credential_id_mismatch");

  let offset = decodeMapAt(authData, credentialEnd, "cose_key").end;
  let extensions: AuthenticatorExtensions = {};
  if ((header.flags & FLAG_EXTENSIONS) !== 0) {
    const decoded = decodeMapAt(authData, offset, "extensions");
    extensions = readExtensions(decoded.map);
    offset = decoded.end;
  }
  if (offset !== authData.length) throw new AuthenticatorDataError("trailing_bytes");
  return { ...header, aaguid, credentialId, extensions };
};

/** Parses and checks the assertion form; throws AuthenticatorDataError (short, RP ID). */
export const parseAssertionAuthData = (authData: Buffer, expectedRpIdHash: Buffer): AssertionAuthenticatorData => {
  const header = readHeader(authData, expectedRpIdHash);
  let extensions: AuthenticatorExtensions = {};
  if ((header.flags & FLAG_EXTENSIONS) !== 0 && authData.length > MIN_LENGTH) {
    try {
      extensions = readExtensions(decodeMapAt(authData, MIN_LENGTH, "extensions").map);
    } catch {
      extensions = {};
    }
  }
  return { ...header, extensions };
};
