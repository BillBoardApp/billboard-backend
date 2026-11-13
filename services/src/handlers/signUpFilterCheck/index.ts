import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Context } from "aws-lambda";

import { logger } from "../../shared/logger";
import { emitEmbeddedMetrics } from "../../shared/metrics";
import { signUpFilterCheckAddress } from "../../shared/signUpFilter";
import { PROBE_TOKEN_SECRET_ENV, loadProbeToken } from "../../shared/signUpProbeToken";
import { SIGNUP_FILTER_CHECK_METRIC_NAMESPACE, type CheckConfig, type CheckDeps, type FilterMode } from "./common";
import { runCheck, runSweep, type CheckResult } from "./run";

/**
 * SignUpFilterCheck (CB-07, RUNBOOK 14.12): the scheduled proof that the pre-sign-up filter works in
 * production. Daily at 11:30 UTC (EventBridge, prod alias, no async retries), or by hand. Ships off.
 *
 * Environment:
 *   SIGNUP_FILTER_CHECK_ENABLED        "true" runs; anything else (unset, "false", a typo) only emits
 *                                      SignUpFilterCheckDisabled=1, before any AWS client exists
 *   SIGNUP_FILTER_CHECK_ADDRESS        the check address (the same value PreSignUpCheck gets); must be lower
 *                                      case, without "+", on billboard-project.com (else fail config)
 *   SIGNUP_FILTER_CHECK_EXPECTED_MODE  the SIGNUP_FILTER_MODE PreSignUpCheck is deployed with (watch, enforce)
 *   USER_POOL_ID, USER_POOL_CLIENT_ID  the pool and the app's client
 *   SIGNUP_EMAIL_CLAIMS_TABLE_NAME     SignUpEmailClaims
 *   SIGNUP_PROBE_TOKEN_SECRET_ARN      the probe token secret (INF-15): every SignUp sends the token in its
 *                                      ClientMetadata; unreadable, the run fails config before any SignUp
 *
 * Payload: {"action": "sweep"} runs only the sweep (no SignUp, no email); anything else, the scheduled event
 * included, is a full run (run.ts).
 *
 * Output: one EMF line in BillBoard/SignUpFilterCheck, without dimensions (SignUpFilterCheckPassed, Failed,
 * Inconclusive, Swept, SignUps; a sweep alone emits Failed and Swept), and one "Sign-up filter check" log line
 * with the same counts, the reason, stage, modes and run tag. Never an address, a password or a sub.
 */

let cognitoClient: CognitoIdentityProviderClient | undefined;
let signUpClient: CognitoIdentityProviderClient | undefined;
let dynamoClient: DynamoDBClient | undefined;
let secretsClient: SecretsManagerClient | undefined;

/** Created on first use, so a disabled or misconfigured run creates none. */
const defaultDeps = (context?: Pick<Context, "getRemainingTimeInMillis">): CheckDeps => ({
  cognito: (cognitoClient ??= new CognitoIdentityProviderClient({})),
  // SignUp is never retried, by the SDK either: one call is one sign-up and one email.
  signUp: (signUpClient ??= new CognitoIdentityProviderClient({ maxAttempts: 1 })),
  db: (dynamoClient ??= new DynamoDBClient({})),
  now: Date.now,
  randomBytes,
  sleep: (ms) => sleep(ms).then(() => undefined),
  timeLeftMs: () => {
    const remaining = context?.getRemainingTimeInMillis?.();
    return typeof remaining === "number" && Number.isFinite(remaining) ? remaining : Number.POSITIVE_INFINITY;
  },
});

export const isEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.SIGNUP_FILTER_CHECK_ENABLED ?? "").trim().toLowerCase() === "true";

/** The configuration as the environment gives it: the probe token's secret, not the token. */
export type EnvConfig = Omit<CheckConfig, "probeToken"> & { probeTokenSecretId: string };

/** The configuration, or the names of the variables that are missing or invalid. */
export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): EnvConfig | { invalid: string[] } => {
  const check = signUpFilterCheckAddress(env);
  const mode = (env.SIGNUP_FILTER_CHECK_EXPECTED_MODE ?? "").trim().toLowerCase();
  const userPoolId = (env.USER_POOL_ID ?? "").trim();
  const clientId = (env.USER_POOL_CLIENT_ID ?? "").trim();
  const tableName = (env.SIGNUP_EMAIL_CLAIMS_TABLE_NAME ?? "").trim();
  const probeTokenSecretId = (env.SIGNUP_PROBE_TOKEN_SECRET_ARN ?? "").trim();
  const invalid = [
    ...(check ? [] : ["SIGNUP_FILTER_CHECK_ADDRESS"]),
    ...(mode === "watch" || mode === "enforce" ? [] : ["SIGNUP_FILTER_CHECK_EXPECTED_MODE"]),
    ...(userPoolId ? [] : ["USER_POOL_ID"]),
    ...(clientId ? [] : ["USER_POOL_CLIENT_ID"]),
    ...(tableName ? [] : ["SIGNUP_EMAIL_CLAIMS_TABLE_NAME"]),
    ...(probeTokenSecretId ? [] : [PROBE_TOKEN_SECRET_ENV]),
  ];
  if (!check || invalid.length > 0) return { invalid };
  return { check, expectedMode: mode as FilterMode, userPoolId, clientId, tableName, probeTokenSecretId };
};

const isSweepAction = (event: unknown): boolean =>
  typeof event === "object" && event !== null && (event as { action?: unknown }).action === "sweep";

const configFailure = (env: NodeJS.ProcessEnv): CheckResult => ({
  action: "run",
  outcome: "fail",
  reason: "config",
  stage: "config",
  expectedMode: (env.SIGNUP_FILTER_CHECK_EXPECTED_MODE ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "watch",
  signUps: 0,
  durationMs: 0,
  usersDeleted: 0,
  claimItemsDeleted: 0,
  recordsDeleted: 0,
  swept: 0,
  refused: 0,
  remaining: 0,
});

const emitResult = (result: CheckResult): void => {
  const counts =
    result.action === "sweep"
      ? [
          { name: "SignUpFilterCheckFailed", value: result.outcome === "fail" ? 1 : 0 },
          { name: "SignUpFilterCheckSwept", value: result.swept },
        ]
      : [
          { name: "SignUpFilterCheckPassed", value: result.outcome === "pass" ? 1 : 0 },
          { name: "SignUpFilterCheckFailed", value: result.outcome === "fail" ? 1 : 0 },
          { name: "SignUpFilterCheckInconclusive", value: result.outcome === "inconclusive" ? 1 : 0 },
          { name: "SignUpFilterCheckSwept", value: result.swept },
          { name: "SignUpFilterCheckSignUps", value: result.signUps },
        ];
  const { action, outcome, reason, stage, expectedMode, observedMode, runTag, durationMs } = result;
  emitEmbeddedMetrics(SIGNUP_FILTER_CHECK_METRIC_NAMESPACE, counts, {
    properties: { action, outcome, reason, stage, expectedMode, observedMode, runTag, durationMs },
  });
  const log = result.outcome === "fail" ? logger.error.bind(logger) : logger.info.bind(logger);
  log("Sign-up filter check", { ...result });
};

export const handler = async (
  event: unknown,
  context?: Pick<Context, "awsRequestId" | "getRemainingTimeInMillis">,
): Promise<{ status: string; reason?: string }> => {
  logger.resetContext(context);
  const env = process.env;
  if (!isEnabled(env)) {
    emitEmbeddedMetrics(SIGNUP_FILTER_CHECK_METRIC_NAMESPACE, [{ name: "SignUpFilterCheckDisabled", value: 1 }]);
    logger.info("Sign-up filter check", { status: "disabled" });
    return { status: "disabled" };
  }

  const envConfig = configFromEnv(env);
  if ("invalid" in envConfig) {
    const result = configFailure(env);
    emitResult(result);
    logger.error("Sign-up filter check configuration is invalid", { invalid: envConfig.invalid });
    return { status: result.outcome, reason: result.reason };
  }

  // INF-15: without the token the filter would treat this run's sign-ups as ordinary ones, so no SignUp is made.
  const { probeTokenSecretId, ...rest } = envConfig;
  let probeToken: string;
  try {
    probeToken = await loadProbeToken((secretsClient ??= new SecretsManagerClient({})), probeTokenSecretId);
  } catch (error) {
    const result = configFailure(env);
    emitResult(result);
    logger.error("Sign-up filter check cannot read the probe token", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { status: result.outcome, reason: result.reason };
  }
  const config: CheckConfig = { ...rest, probeToken };

  const deps = defaultDeps(context);
  const result = isSweepAction(event) ? await runSweep(config, deps) : await runCheck(config, deps);
  emitResult(result);
  return { status: result.outcome, ...(result.reason ? { reason: result.reason } : {}) };
};
