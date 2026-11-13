import { createHash, timingSafeEqual } from "node:crypto";

import { GetSecretValueCommand, type GetSecretValueCommandOutput } from "@aws-sdk/client-secrets-manager";

/**
 * The sign-up filter check's probe token (INF-15). The check address is public, so anyone can sign up with it or a
 * +tag of it. Only a sign-up that also carries this token is the check's probe: SignUpFilterCheck sends it in the
 * SignUp call's ClientMetadata, and PreSignUpCheck writes a PROBE# record and uses the probe labels only when the
 * token matches. The token is a generated secret (UserAPIServiceStack's SignUpProbeTokenSecret) that only those two
 * functions can read, so a stranger can no longer overwrite the records the daily check reads or move its metrics.
 * The token is never logged.
 */

/** The ClientMetadata key the token travels in. */
export const PROBE_TOKEN_METADATA_KEY = "billboardSignUpProbe";

/** The environment variable that names the secret, on both functions. */
export const PROBE_TOKEN_SECRET_ENV = "SIGNUP_PROBE_TOKEN_SECRET_ARN";

/** A shorter secret is treated as unreadable: the stack generates 48 characters. */
export const MIN_PROBE_TOKEN_LENGTH = 32;

export interface SecretsReader {
  send(command: GetSecretValueCommand, options?: { abortSignal?: AbortSignal }): Promise<GetSecretValueCommandOutput>;
}

let cached: { secretId: string; token: string } | undefined;

/** The token, read from Secrets Manager once per container. Throws when the secret is missing, empty or too short. */
export const loadProbeToken = async (
  client: SecretsReader,
  secretId: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (!secretId) throw new Error(`${PROBE_TOKEN_SECRET_ENV} is not configured.`);
  if (cached?.secretId === secretId) return cached.token;
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
    signal ? { abortSignal: signal } : undefined,
  );
  const token = (response.SecretString ?? "").trim();
  if (token.length < MIN_PROBE_TOKEN_LENGTH) throw new Error("The sign-up probe token secret is empty or too short.");
  cached = { secretId, token };
  return token;
};

/** Whether the token a sign-up sent is the probe token, compared in constant time. */
export const probeTokenMatches = (sent: unknown, token: string): boolean => {
  if (typeof sent !== "string" || sent === "" || token === "") return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(sent), digest(token));
};
