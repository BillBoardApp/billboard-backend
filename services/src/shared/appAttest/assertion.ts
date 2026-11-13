/**
 * Verifies an App Attest assertion (C3 3.4 steps 5-8, without the store). Pure and total: it
 * returns a result and never throws.
 *
 * nonce = SHA256(authenticatorData || SHA256(clientData bytes)); the signature is DER ECDSA P-256
 * over SHA-256 of that nonce, which is what crypto.verify("sha256", nonce, ...) checks. The
 * counter must be greater than the stored one; an equal counter passes only for a replay of the
 * same assertion (a retry after a timeout).
 */

import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { AuthenticatorDataError, parseAssertionAuthData, type AuthenticatorDataFailure } from "./authenticatorData";
import { decodeCbor, hasExactKeys, isCborMap, type CborValue } from "./cbor";
import { APP_ID_HASH, LIMITS } from "./config";

export type AssertionFailureReason =
  | "too_large"
  | "cbor"
  | "format"
  | "public_key"
  | "signature"
  | "counter_not_increasing"
  | AuthenticatorDataFailure;

export interface VerifyAssertionInput {
  /** The CBOR assertion object: {signature: bytes, authenticatorData: bytes}. */
  assertion: Buffer;
  /** The exact clientData bytes the client sent and signed. */
  clientData: Buffer;
  /** DER SPKI stored at attestation. */
  publicKeySpki: Buffer;
  storedCounter: number;
  /** True when the challenge step found a replay of this same assertion. */
  allowEqualCounter?: boolean;
  appIdHash?: Buffer;
}

export interface VerifiedAssertion {
  ok: true;
  counter: number;
  validationCategory?: number;
  bundleVersion?: string;
}

export interface RejectedAssertion {
  ok: false;
  reason: AssertionFailureReason;
}

export type AssertionResult = VerifiedAssertion | RejectedAssertion;

const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const reject = (reason: AssertionFailureReason): RejectedAssertion => ({ ok: false, reason });

export const verifyAssertion = (input: VerifyAssertionInput): AssertionResult => {
  try {
    return verify(input);
  } catch {
    return reject("format");
  }
};

const verify = (input: VerifyAssertionInput): AssertionResult => {
  if (input.assertion.length > LIMITS.maxAssertionBytes) return reject("too_large");
  let decoded: CborValue;
  try {
    decoded = decodeCbor(input.assertion, { maxBytes: LIMITS.maxAssertionBytes });
  } catch {
    return reject("cbor");
  }
  if (!isCborMap(decoded) || !hasExactKeys(decoded, ["signature", "authenticatorData"])) return reject("format");
  const signature = decoded.get("signature");
  const authenticatorData = decoded.get("authenticatorData");
  if (!Buffer.isBuffer(signature) || !Buffer.isBuffer(authenticatorData)) return reject("format");

  let parsed;
  try {
    parsed = parseAssertionAuthData(authenticatorData, input.appIdHash ?? APP_ID_HASH);
  } catch (error) {
    if (error instanceof AuthenticatorDataError) return reject(error.reason);
    throw error;
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: input.publicKeySpki, format: "der", type: "spki" });
  } catch {
    return reject("public_key");
  }
  const nonce = sha256(authenticatorData, sha256(input.clientData));
  let signatureValid: boolean;
  try {
    signatureValid = verifySignature("sha256", nonce, publicKey, signature);
  } catch {
    // A signature that is not DER at all.
    signatureValid = false;
  }
  if (!signatureValid) return reject("signature");

  const increasing = parsed.counter > input.storedCounter;
  const replayed = input.allowEqualCounter === true && parsed.counter === input.storedCounter;
  if (!increasing && !replayed) return reject("counter_not_increasing");

  return {
    ok: true,
    counter: parsed.counter,
    ...(parsed.extensions.validationCategory !== undefined
      ? { validationCategory: parsed.extensions.validationCategory }
      : {}),
    ...(parsed.extensions.bundleVersion !== undefined ? { bundleVersion: parsed.extensions.bundleVersion } : {}),
  };
};
