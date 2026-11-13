import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";

/** How long a fetched key is reused before Secrets Manager is read again (picks up rotations). */
export const CONGRESS_API_KEY_TTL_MS = 15 * 60 * 1000;

type SecretsReader = {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
};

let defaultClient: SecretsManagerClient | undefined;
let cached: { value: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;
// Bumped by invalidate so a read that started before it cannot repopulate the cache.
let generation = 0;

const readCongressApiKey = async (client: SecretsReader): Promise<string> => {
  const secretName = process.env.SECRET_NAME;
  if (!secretName) {
    throw new Error("SECRET_NAME environment variable is not set");
  }

  const response = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!response.SecretString) {
    throw new Error("Secret value is empty");
  }

  const secret = JSON.parse(response.SecretString) as Record<string, unknown> | null;
  const apiKey = secret?.congressApiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error("congressApiKey not found in secret");
  }
  return apiKey.trim();
};

/**
 * Returns the congress.gov API key from the JSON secret named by the
 * SECRET_NAME env var (field `congressApiKey`). The key is cached in memory
 * for CONGRESS_API_KEY_TTL_MS and concurrent callers share one read.
 */
export const getCongressApiKey = async (client?: SecretsReader): Promise<string> => {
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  if (inFlight) return inFlight;

  const readGeneration = generation;
  const read = readCongressApiKey(client ?? (defaultClient ??= new SecretsManagerClient({})))
    .then((value) => {
      if (readGeneration === generation) {
        cached = { value, expiresAt: Date.now() + CONGRESS_API_KEY_TTL_MS };
      }
      return value;
    })
    .finally(() => {
      if (inFlight === read) inFlight = null;
    });
  inFlight = read;
  return read;
};

/** Drops the cached key so the next getCongressApiKey() reads Secrets Manager again. */
export const invalidateCongressApiKey = (): void => {
  generation += 1;
  cached = null;
  inFlight = null;
};

/** 401/403 from congress.gov means the key was rejected (rotated or revoked), not a transient failure. */
export const isCongressApiAuthFailureStatus = (status: number): boolean => status === 401 || status === 403;
