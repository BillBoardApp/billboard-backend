/**
 * AppAttest: the two public App Attest routes (C3 3.2, 3.3), both POST and without authorization.
 *
 *   /app-attest/challenge  {"purpose": "attest" | "assert"} -> 200 {"clientMode": "on", "challenge", "expiresAt"}
 *                          or 200 {"clientMode": "off"} (APP_ATTEST_CLIENT_MODE=off: R2's kill switch; nothing written)
 *   /app-attest/attest     {"keyId", "challenge", "attestation"} -> 200 {"status": "attested" | "already_attested",
 *                          "environment"}; 400 APP_ATTEST_CHALLENGE_INVALID (retry with a new challenge) or
 *                          APP_ATTEST_REJECTED (new key next time); 413 PAYLOAD_TOO_LARGE; 503 APP_ATTEST_UNAVAILABLE
 *
 * A malformed body gets 400 INVALID_REQUEST. With APP_ATTEST_TABLE_NAME unset the client mode is off:
 * the challenge route answers {"clientMode": "off"} and the attest route 503, and nothing is read or
 * written. Apple is never called: attestations are verified locally against the pinned root.
 */

import { randomBytes } from "node:crypto";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { jsonResponse } from "../../shared/apiGateway";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetrics } from "../../shared/metrics";
import { verifyAttestation } from "../../shared/appAttest/attestation";
import { LIMITS, METRIC_NAMESPACE, appAttestConfigFromEnv, type AppAttestConfig } from "../../shared/appAttest/config";
import { AppAttestStore, type ChallengePurpose } from "../../shared/appAttest/store";
import {
  APP_ATTEST_HEADER,
  base64url,
  decodeBase64url,
  decodeStandardBase64,
  keyIdPrefix,
  rawBody,
  readHeader,
  sha256,
} from "../../shared/appAttest/wire";

export const CHALLENGE_ROUTE = "/app-attest/challenge";
export const ATTEST_ROUTE = "/app-attest/attest";

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type AttestationMetricOutcome = "accepted" | "already" | "rejected" | "challenge" | "error";

const error = (statusCode: number, code: string): APIGatewayProxyResult => jsonResponse(statusCode, { error: code });

const parseJsonObject = (body: Buffer): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const storeFor = (config: AppAttestConfig): AppAttestStore => new AppAttestStore(config.tableName as string);

const issueChallenge = async (event: APIGatewayProxyEvent, config: AppAttestConfig): Promise<APIGatewayProxyResult> => {
  const body = parseJsonObject(rawBody(event));
  const purpose = body?.purpose;
  if (purpose !== "attest" && purpose !== "assert") return error(400, "INVALID_REQUEST");
  // Shows that custom headers pass through the EDGE endpoint (C3 7.4 probe).
  const probeHeaderSeen = readHeader(event, APP_ATTEST_HEADER) !== undefined;

  if (config.clientMode === "off") {
    logger.info("App Attest challenge not issued: client mode off", { purpose, probeHeaderSeen });
    return jsonResponse(200, { clientMode: "off" });
  }

  const store = storeFor(config);
  try {
    // A collision on 32 random bytes does not happen; one retry keeps the route honest if it did.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const challenge = base64url(randomBytes(LIMITS.challengeBytes));
      const stored = await store.putChallenge({
        challenge,
        purpose: purpose as ChallengePurpose,
        now: new Date(),
        ttlSeconds: config.challengeTtlSeconds,
      });
      if (!stored.created) continue;
      emitEmbeddedMetrics(METRIC_NAMESPACE, [{ name: "AppAttestChallenges", value: 1 }], {
        properties: { message: "App Attest challenge issued", purpose, probeHeaderSeen },
      });
      return jsonResponse(200, { clientMode: "on", challenge, expiresAt: stored.expiresAt.toISOString() });
    }
    throw new Error("challenge collision twice");
  } catch (failure) {
    logger.error("App Attest challenge could not be stored", { purpose, probeHeaderSeen, error: failure });
    return error(503, "APP_ATTEST_UNAVAILABLE");
  }
};

const recordAttestation = (outcome: AttestationMetricOutcome, properties: Record<string, unknown>): void =>
  emitEmbeddedMetrics(METRIC_NAMESPACE, [{ name: "AppAttestAttestations", value: 1 }], {
    dimensions: { Outcome: outcome },
    properties: { message: "App Attest attestation", ...properties },
  });

const registerKey = async (event: APIGatewayProxyEvent, config: AppAttestConfig): Promise<APIGatewayProxyResult> => {
  const bytes = rawBody(event);
  if (bytes.length > LIMITS.maxAttestBodyBytes) return error(413, "PAYLOAD_TOO_LARGE");
  if (config.clientMode === "off") {
    logger.info("App Attest attestation refused: client mode off");
    return error(503, "APP_ATTEST_UNAVAILABLE");
  }
  const body = parseJsonObject(bytes);
  const { keyId, challenge, attestation } = body ?? {};
  if (typeof keyId !== "string" || typeof challenge !== "string" || typeof attestation !== "string") {
    return error(400, "INVALID_REQUEST");
  }
  const prefix = keyIdPrefix(keyId);
  if (!CHALLENGE_PATTERN.test(challenge)) {
    recordAttestation("challenge", { reason: "challenge_format", keyIdPrefix: prefix });
    return error(400, "APP_ATTEST_CHALLENGE_INVALID");
  }
  const keyIdBytes = decodeBase64url(keyId);
  const attestationBytes = decodeStandardBase64(attestation);
  if (!keyIdBytes || keyIdBytes.length !== LIMITS.keyIdBytes || keyId.length !== 43 || !attestationBytes) {
    recordAttestation("rejected", { reason: "request_format", keyIdPrefix: prefix });
    return error(400, "APP_ATTEST_REJECTED");
  }

  // The table key is the canonical spelling of the decoded bytes (C3 4.3).
  const canonicalKeyId = base64url(keyIdBytes);
  const store = storeFor(config);
  const now = new Date();
  try {
    // Step 1: consume the challenge. The same attestation bytes again is a retry: continue.
    const consumed = await store.consumeChallenge({
      challenge,
      purpose: "attest",
      consumedBy: base64url(sha256(attestationBytes)),
      now,
    });
    if (!consumed.ok) {
      recordAttestation("challenge", { reason: consumed.reason, keyIdPrefix: prefix });
      return error(400, "APP_ATTEST_CHALLENGE_INVALID");
    }

    // Steps 2-8: local verification against the pinned Apple root.
    const verified = verifyAttestation({ attestation: attestationBytes, keyId: keyIdBytes, challenge, now });
    if (!verified.ok) {
      recordAttestation("rejected", {
        reason: verified.reason,
        detail: verified.detail,
        keyIdPrefix: prefix,
        replay: consumed.replay,
      });
      return error(400, "APP_ATTEST_REJECTED");
    }

    // Step 9: store the key. An existing item is the same public key (the key ID is its hash).
    const stored = await store.putKey(
      {
        keyId: canonicalKeyId,
        publicKeySpki: verified.publicKeySpki,
        environment: verified.environment,
        receipt: verified.receipt,
        validationCategory: verified.validationCategory,
        bundleVersion: verified.bundleVersion,
      },
      now,
    );
    recordAttestation(stored === "created" ? "accepted" : "already", {
      environment: verified.environment,
      validationCategory: verified.validationCategory,
      bundleVersion: verified.bundleVersion,
      keyIdPrefix: prefix,
      replay: consumed.replay,
    });
    return jsonResponse(200, {
      status: stored === "created" ? "attested" : "already_attested",
      environment: verified.environment,
    });
  } catch (failure) {
    recordAttestation("error", { keyIdPrefix: prefix });
    logger.error("App Attest attestation could not be processed", { keyIdPrefix: prefix, error: failure });
    return error(503, "APP_ATTEST_UNAVAILABLE");
  }
};

export async function handler(
  event: APIGatewayProxyEvent,
  context?: LambdaContextLike,
): Promise<APIGatewayProxyResult> {
  logger.resetContext(context);
  try {
    const config = appAttestConfigFromEnv();
    if (String(event?.httpMethod ?? "").toUpperCase() !== "POST") return error(405, "METHOD_NOT_ALLOWED");
    switch (event?.resource) {
      case CHALLENGE_ROUTE:
        return await issueChallenge(event, config);
      case ATTEST_ROUTE:
        return await registerKey(event, config);
      default:
        return error(404, "NOT_FOUND");
    }
  } catch (failure) {
    logger.error("App Attest request failed", { resource: event?.resource, error: failure });
    return error(503, "APP_ATTEST_UNAVAILABLE");
  }
}
