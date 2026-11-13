/**
 * Verifies an App Attest attestation object (C3 3.3 steps 2-8). Pure: no I/O, the clock and the
 * root are inputs, and it never throws; the first failed check decides the result. Consuming the
 * challenge (step 1) and storing the key (step 9) belong to the AppAttest handler.
 */

import { X509Certificate, createHash, timingSafeEqual } from "node:crypto";
import { appleAppAttestationRoot } from "./appleRootCa";
import {
  AuthenticatorDataError,
  parseAttestationAuthData,
  type AaguidKind,
  type AuthenticatorDataFailure,
} from "./authenticatorData";
import { CborError, decodeCbor, hasExactKeys, isCborMap, type CborValue } from "./cbor";
import { APP_ID_HASH, LIMITS, type KeyEnvironment } from "./config";
import { DerError, extractAttestationNonce } from "./der";

export type AttestationFailureReason =
  | "too_large"
  | "cbor"
  | "format"
  | "x5c_count"
  | "certificate_parse"
  | "chain"
  | "intermediate_not_ca"
  | "certificate_validity"
  | "leaf_key_type"
  | "nonce_extension"
  | "nonce_mismatch"
  | "key_id_mismatch"
  | "validation_category"
  | AuthenticatorDataFailure;

export interface VerifyAttestationInput {
  /** The CBOR attestation object (decoded from the request's standard base64). */
  attestation: Buffer;
  /** The decoded key ID the client sent (32 bytes). */
  keyId: Buffer;
  /** The challenge string from POST /app-attest/challenge; its UTF-8 bytes are hashed. */
  challenge: string;
  now: Date;
  /** Defaults to the pinned Apple App Attestation Root CA. Tests pass a synthetic root. */
  root?: X509Certificate;
  /** Defaults to SHA-256 of the App ID. */
  appIdHash?: Buffer;
}

export interface VerifiedAttestation {
  ok: true;
  environment: KeyEnvironment;
  aaguid: AaguidKind;
  /** DER SubjectPublicKeyInfo of the leaf key, stored to verify later assertions. */
  publicKeySpki: Buffer;
  /** Apple's fraud receipt, stored for an optional risk metric. */
  receipt: Buffer;
  validationCategory?: number;
  bundleVersion?: string;
}

export interface RejectedAttestation {
  ok: false;
  reason: AttestationFailureReason;
  detail?: string;
}

export type AttestationResult = VerifiedAttestation | RejectedAttestation;

const reject = (reason: AttestationFailureReason, detail?: string): RejectedAttestation => ({
  ok: false,
  reason,
  ...(detail ? { detail } : {}),
});

const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const equalBytes = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

const validAt = (certificate: X509Certificate, now: Date): boolean => {
  const from = Date.parse(certificate.validFrom);
  const to = Date.parse(certificate.validTo);
  const at = now.getTime();
  return Number.isFinite(from) && Number.isFinite(to) && from <= at && at <= to;
};

const signedBy = (certificate: X509Certificate, issuer: X509Certificate): boolean => {
  try {
    return certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);
  } catch {
    return false;
  }
};

/** 0x04 || x || y of an EC public key (65 bytes for P-256). */
export const uncompressedPoint = (certificate: X509Certificate): Buffer => {
  const jwk = certificate.publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("not an EC key");
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
};

/** production when the aaguid is production and the category is absent, 2 or 4; 0 is rejected. */
export const attestationEnvironment = (aaguid: AaguidKind, validationCategory: number | undefined): KeyEnvironment => {
  if (aaguid !== "production") return "development";
  if (validationCategory === undefined || validationCategory === 2 || validationCategory === 4) return "production";
  // 3 is development-signed; any other category is recorded and treated as development.
  return "development";
};

const bytesOf = (value: CborValue | undefined): Buffer | null => (Buffer.isBuffer(value) ? value : null);

export const verifyAttestation = (input: VerifyAttestationInput): AttestationResult => {
  try {
    return verify(input);
  } catch (error) {
    // Every step returns its own reason; this only keeps the function total.
    return reject("format", error instanceof Error ? error.message : String(error));
  }
};

const verify = (input: VerifyAttestationInput): AttestationResult => {
  const appIdHash = input.appIdHash ?? APP_ID_HASH;
  if (input.attestation.length > LIMITS.maxAttestationBytes) return reject("too_large");

  // Step 2: CBOR decode.
  let decoded: CborValue;
  try {
    decoded = decodeCbor(input.attestation, { maxBytes: LIMITS.maxAttestationBytes });
  } catch (error) {
    return reject("cbor", error instanceof CborError ? error.message : undefined);
  }
  if (!isCborMap(decoded) || !hasExactKeys(decoded, ["fmt", "attStmt", "authData"])) return reject("format");
  if (decoded.get("fmt") !== "apple-appattest") return reject("format", "fmt is not apple-appattest");
  const statement = decoded.get("attStmt");
  const authData = bytesOf(decoded.get("authData"));
  if (!isCborMap(statement) || !hasExactKeys(statement, ["x5c", "receipt"]) || !authData) return reject("format");
  const x5c = statement.get("x5c");
  const receipt = bytesOf(statement.get("receipt"));
  if (!Array.isArray(x5c) || !receipt) return reject("format");
  if (x5c.length !== 2) return reject("x5c_count");
  const leafDer = bytesOf(x5c[0]);
  const intermediateDer = bytesOf(x5c[1]);
  if (!leafDer || !intermediateDer) return reject("format", "x5c entries must be byte strings");

  // Step 3: certificate chain to the pinned root.
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  try {
    leaf = new X509Certificate(leafDer);
    intermediate = new X509Certificate(intermediateDer);
  } catch (error) {
    return reject("certificate_parse", error instanceof Error ? error.message : undefined);
  }
  const root = input.root ?? appleAppAttestationRoot();
  if (!signedBy(intermediate, root)) return reject("chain", "intermediate is not signed by the root");
  if (intermediate.ca !== true) return reject("intermediate_not_ca");
  if (!signedBy(leaf, intermediate)) return reject("chain", "leaf is not signed by the intermediate");
  if (!validAt(intermediate, input.now) || !validAt(leaf, input.now)) return reject("certificate_validity");
  const leafKey = leaf.publicKey;
  if (leafKey.asymmetricKeyType !== "ec" || leafKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    return reject("leaf_key_type");
  }

  // Steps 4 and 5: the nonce in the leaf must be SHA256(authData || SHA256(challenge)).
  const clientDataHash = sha256(Buffer.from(input.challenge, "utf8"));
  const nonce = sha256(authData, clientDataHash);
  let certifiedNonce: Buffer;
  try {
    certifiedNonce = extractAttestationNonce(leaf.raw);
  } catch (error) {
    return reject("nonce_extension", error instanceof DerError ? error.message : undefined);
  }
  if (!equalBytes(certifiedNonce, nonce)) return reject("nonce_mismatch");

  // Step 6: the key ID is SHA-256 of the leaf's uncompressed public key.
  if (input.keyId.length !== LIMITS.keyIdBytes || !equalBytes(sha256(uncompressedPoint(leaf)), input.keyId)) {
    return reject("key_id_mismatch");
  }

  // Step 7: authenticator data.
  let parsed;
  try {
    parsed = parseAttestationAuthData(authData, { rpIdHash: appIdHash, keyId: input.keyId });
  } catch (error) {
    if (error instanceof AuthenticatorDataError) return reject(error.reason, error.message);
    throw error;
  }

  // Step 8: environment.
  const { validationCategory, bundleVersion } = parsed.extensions;
  if (validationCategory === 0) return reject("validation_category", "validation category 0");

  return {
    ok: true,
    environment: attestationEnvironment(parsed.aaguid, validationCategory),
    aaguid: parsed.aaguid,
    publicKeySpki: leafKey.export({ type: "spki", format: "der" }),
    receipt: Buffer.from(receipt),
    ...(validationCategory !== undefined ? { validationCategory } : {}),
    ...(bundleVersion !== undefined ? { bundleVersion } : {}),
  };
};
