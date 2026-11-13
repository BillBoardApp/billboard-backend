import { randomUUID } from "node:crypto";

import { AdminGetUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import type { AttributeValue, PutItemCommandInput } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Context, PreSignUpTriggerEvent } from "aws-lambda";

import { METRIC_NAMESPACE as APP_ATTEST_NAMESPACE, appAttestConfigFromEnv } from "../../shared/appAttest/config";
import {
  evaluateSignUpAttestation,
  evaluateSignUpDeviceCheck,
  signUpRejectionError,
  type AppAttestBlockCode,
  type DeviceCheckSignUpResult,
  type SignUpAttestationResult,
} from "../../shared/appAttest/evaluate";
import { logger } from "../../shared/logger";
import { emitEmbeddedMetric, emitEmbeddedMetrics } from "../../shared/metrics";
import {
  probeKindOf,
  probeTagOf,
  signUpFilterCheckAddress,
  toProbeRecordItem,
  type ProbeCheckEntry,
  type ProbeKind,
  type SignUpProbeRecord,
} from "../../shared/signUpFilter";
import { PROBE_TOKEN_METADATA_KEY, loadProbeToken, probeTokenMatches } from "../../shared/signUpProbeToken";
import {
  DISPOSABLE_DOMAIN_REASON,
  DISPOSABLE_EMAIL_MESSAGE,
  EMAIL_VARIANT_MESSAGE,
  EMAIL_VARIANT_REASON,
  addressKeyFor,
  claimWithoutHolder,
  MAX_CLAIM_HOLDERS,
  decideClaim,
  emailClaimKey,
  emailKeyFor,
  isLiveClaimHolder,
  matchDisposableDomain,
  nextHolderLookups,
  parseEmailAddress,
  readEmailClaim,
  userClaimKey,
  type ClaimDecisionInput,
  type ClaimDetail,
  type ClaimOutcome,
  type EmailClaim,
  type HolderLookup,
} from "./emailPolicy";

/**
 * PreSignUpCheck: the user pool's pre-sign-up trigger (INT-05, C2 3.5; integration plan X4, X5, X11).
 *
 * Only self-service sign-ups (PreSignUp_SignUp) are checked. AdminCreateUser (the hand-made test and
 * canary accounts) and ExternalProvider pass untouched. The handler runs an ordered list of checks,
 * SIGN_UP_CHECKS, under one deadline of 3.5 s from the start of the invocation (Cognito gives up after
 * 5 s). Each check has its own mode, time budget and metrics, and returns allow or a rejection:
 *
 * - watch: a rejection is a hit (metric and log line) and the sign-up goes on; later checks still run.
 * - enforce: a rejection is a hit plus SignUpRejected, and the handler throws the check's message, which
 *   Cognito returns as "PreSignUp failed with error <message>." Later checks do not run.
 * - off: the check is skipped (no reads, writes or metrics).
 * - A check that throws or runs out of time counts as error: its error metric is emitted and the
 *   sign-up is allowed. The filter fails open; it never blocks a sign-up because of its own fault.
 *
 * A check may return a commit step with its allow; commit steps run in order only when every check
 * allowed (or only hit in watch), so a later rejection leaves no counter behind (C3 3.5 "counting").
 * A check whose run already wrote something may also return a release step: release steps run, newest
 * first, only when a later check refuses the sign-up under enforce. emailBase uses it to take its sign-up
 * off the claim it wrote (freeing the claim when it was the only holder), so the person's next sign-up on
 * the base address is not refused as a variant of an account Cognito never created.
 *
 * INT-05's two checks share SIGNUP_FILTER_MODE (watch or enforce; anything else is watch) and at most
 * 1.2 s: disposableDomain (pure) and emailBase (one GetItem; AdminGetUser on the other sign-up attempts the claim
 * records, the one it names first and the rest only when the decision needs them, so usually one call and at most
 * MAX_CLAIM_HOLDERS; one TransactWriteItems on SignUpEmailClaims, or on a hit at most one conditional PutItem that
 * names the live holder; all of it again for each round lost to a concurrent sign-up, at most MAX_CLAIM_ROUNDS;
 * and, when a later check refuses the sign-up, one GetItem and one conditional PutItem that take it off the claim).
 * Claims are written in both modes, so the table is complete when enforce starts.
 *
 * emailBase and retries: Cognito runs this trigger before it checks the password, so a sign-up it then
 * refuses has already claimed the base address. The claim records every attempt holding the base address
 * under one exact address (shared/signUpFilter.ts), and a new attempt with that same address while an
 * earlier one may still be in flight is let through as "retried", not counted as a variant (decideClaim in
 * emailPolicy.ts).
 *
 * INT-04 (C3 3.5, WP-C3c) appends appAttest and then deviceCheck, so an INT-05 rejection under enforce
 * touches no attestation state. Both delegate to shared/appAttest/evaluate.ts, which verifies, counts,
 * emits the BillBoard/AppAttest metrics and never throws; enforce rejects with the bare code
 * (DEVICE_ACCOUNT_LIMIT, APP_UPDATE_REQUIRED, ...), which Cognito returns as "PreSignUp failed with error
 * <CODE>." (X11). Their modes come from APP_ATTEST_MODE and DEVICE_CHECK_MODE, where unset means off (C3
 * D5): no read, no write, no metric. App Attest gets at most 1.2 s; each DeviceCheck call gets
 * min(1.0 s, time left - 0.2 s) (X4).
 *
 * Environment (all optional: the module loads without any, and a check whose configuration is missing
 * fails open with PreSignUpCheckError):
 *   SIGNUP_FILTER_MODE              watch | enforce
 *   SIGNUP_EMAIL_CLAIMS_TABLE_NAME  the SignUpEmailClaims table (partition key pk)
 *   HASH_SALT_SECRET_ARN            the DistrictVerification hash salt secret (HASH_SALT overrides it locally)
 *   SIGNUP_PROBE_TOKEN_SECRET_ARN   the sign-up check's probe token secret (INF-15), read only for the check address
 *   APP_ATTEST_MODE                 off | watch | enforce (off when APP_ATTEST_TABLE_NAME is unset)
 *   APP_ATTEST_TABLE_NAME           the AppAttest table (GetItem and UpdateItem only: no binding at sign-up)
 *   DEVICE_CHECK_MODE               off | watch | enforce (off when DEVICE_CHECK_SECRET_NAME is unset)
 *   DEVICE_CHECK_SECRET_NAME        the DeviceCheck key secret, read only when DeviceCheck is not off
 *   APP_ATTEST_ALLOWED_ENVIRONMENTS, APP_ATTEST_MAX_ACCOUNTS_PER_KEY, APP_ATTEST_FAIL_CLOSED,
 *   MIN_APP_VERSION, DEVICE_MAX_ACCOUNTS, DEVICE_COUNTER_WINDOW_MONTHS   as in C3 3.1
 *
 * Logs carry no email address and no key: the check results, reasons, the claim outcome and detail, the number
 * of attempts the claim records and, for a disposable hit only, the domain. The App Attest and DeviceCheck metric
 * lines carry no account ID either (C3 3.11).
 *
 * The filter check's probes (CB-07, RUNBOOK 14.12). SIGNUP_FILTER_CHECK_ADDRESS (optional) names the check
 * address, the same value SignUpFilterCheck signs up with. A sign-up whose email (the address Cognito
 * validated) has that base address, "base" for the address itself and "variant" for any +tag of it, is a probe
 * only when its ClientMetadata also carries the probe token (INF-15): the secret SIGNUP_PROBE_TOKEN_SECRET_ARN
 * names, which only SignUpFilterCheck sends. The address is public; without the token, or with a wrong one, the
 * sign-up is an ordinary one. The secret is read only for a sign-up to the check address, once per container,
 * within PROBE_TOKEN_TIMEOUT_MS; a read that fails makes the sign-up ordinary too, so the daily check then fails
 * and says so. A probe changes labels only, never the decision:
 * - every line of the invocation carries the logger key probe=base|variant, the App Attest lines included;
 * - SignUpProbeHit and SignUpProbeRejected replace SignUpFilterHit and SignUpRejected (PreSignUpCheckError
 *   stays shared: an error during a probe is a real filter fault);
 * - after the summary line, and before an enforce refusal is thrown, one PROBE#<kind> record is written to
 *   SignUpEmailClaims (unconditional PutItem, at most 500 ms and never past 4.5 s from the start; a failure
 *   is a warning and changes nothing). The record holds no address.
 * Probe detection itself never throws: a failure there treats the sign-up as an ordinary one.
 *
 * The sign-up funnel (REL-53, feature review S17). Every self-service sign-up the trigger lets through that is not
 * a probe emits SignUpAllowed=1 in BillBoard/Accounts (no dimensions; the line carries no userName and no address),
 * a watch hit and a fail-open error included; a refused sign-up and a probe emit none. Cognito's own
 * SignUpSuccesses also counts the probes (two a day), so this is the count of real sign-ups. A sign-up Cognito fails
 * after the trigger (rare) is still counted. Confirmations have no trigger: CleanupOrphanedUsers counts the sign-ups
 * that stayed unconfirmed (UnconfirmedSignUpsPending, UnconfirmedSignUpsDeleted; RUNBOOK 8.2).
 */

export const ACCOUNT_INTEGRITY_NAMESPACE = "BillBoard/AccountIntegrity";
/** Where SignUpAllowed goes: the namespace CleanupOrphanedUsers writes its account metrics to. */
export const ACCOUNTS_NAMESPACE = "BillBoard/Accounts";
export const SIGN_UP_ALLOWED_METRIC = "SignUpAllowed";

/** One deadline for the whole check list, from the start of the invocation (X4). */
export const SIGN_UP_DEADLINE_MS = 3_500;
/** Kept between the deadline and the Lambda timeout when the context reports less time than usual. */
const LAMBDA_TIMEOUT_MARGIN_MS = 250;

// ─── The check seam ───────────────────────────────────────────────────────────

export type CheckMode = "off" | "watch" | "enforce";

/**
 * A time budget. Checks that name the same budget object share it: the runner adds up the time each
 * one spends within an invocation. A check never gets more than the time left before the deadline.
 */
export interface CheckBudget {
  readonly label: string;
  readonly ms: number;
}

/** The email checks get at most 1.2 s between them (X4). */
export const EMAIL_CHECKS_BUDGET: CheckBudget = { label: "email", ms: 1_200 };

export interface CheckMetrics {
  /** EMF namespace (log-based; no IAM). Metrics carry no dimensions; details go in log properties. */
  namespace: string;
  /** Emitted (1) on every rejection, in watch and in enforce. */
  hit?: string;
  /** Emitted (1) when an enforce rejection refuses the sign-up. */
  rejected?: string;
  /** Emitted (1) when the check throws or runs out of time; the sign-up is allowed. */
  error: string;
  /** Emitted instead of `hit` when the sign-up is the filter check's probe (CB-07); `hit` is then never emitted. */
  probeHit?: string;
  /** Emitted instead of `rejected` for a probe. */
  probeRejected?: string;
  /**
   * The check runs, and its metric lines are written, without the account keys (userName), for
   * namespaces whose lines must not carry an account ID (App Attest, C3 3.11). The handler's own log
   * lines keep them.
   */
  omitAccountKeys?: boolean;
}

export const SIGN_UP_FILTER_METRICS: CheckMetrics = {
  namespace: ACCOUNT_INTEGRITY_NAMESPACE,
  hit: "SignUpFilterHit",
  rejected: "SignUpRejected",
  error: "PreSignUpCheckError",
  probeHit: "SignUpProbeHit",
  probeRejected: "SignUpProbeRejected",
};

export type SignUpTriggerEvent = Extract<PreSignUpTriggerEvent, { triggerSource: "PreSignUp_SignUp" }>;

export interface SignUpCheckContext {
  event: SignUpTriggerEvent;
  /** The check's mode for this invocation (never "off": an off check does not run). */
  mode: Exclude<CheckMode, "off">;
  /** Aborted when the check's time is up; pass it to AWS SDK calls as `{ abortSignal }`. */
  signal: AbortSignal;
  /** Epoch milliseconds of the shared deadline. */
  deadlineAt: number;
  /** Milliseconds left before the shared deadline (a DeviceCheck call takes min(1,000, this - 200)). */
  timeLeftMs: () => number;
  now: () => number;
}

export type SignUpCheckCommit = (context: SignUpCheckContext) => Promise<void>;

export type SignUpCheckResult =
  | {
      outcome: "allow";
      /** Runs only when the sign-up is going to be allowed, after every check. */
      commit?: SignUpCheckCommit;
      /**
       * Runs only when a later check refuses the sign-up under enforce: undoes what run() wrote. Its
       * failure is an error (phase release); the sign-up is still refused.
       */
      release?: SignUpCheckCommit;
      /** Extra fields for the summary log line (never an email address). */
      logFields?: Record<string, unknown>;
    }
  | {
      outcome: "reject";
      /** Short machine reason for logs and metrics (disposable_domain, DEVICE_ACCOUNT_LIMIT, ...). */
      reason: string;
      /** Thrown under enforce; Cognito shows it as "PreSignUp failed with error <message>." */
      message: string;
      logFields?: Record<string, unknown>;
    };

export interface SignUpCheck {
  /** Name in logs and metric properties. */
  readonly name: string;
  /** Read on every invocation. */
  readonly mode: () => CheckMode;
  readonly budget: CheckBudget;
  readonly metrics: CheckMetrics;
  readonly run: (context: SignUpCheckContext) => Promise<SignUpCheckResult> | SignUpCheckResult;
}

export type ErrorKind = "exception" | "timeout" | "deadline";

export interface CheckReport {
  check: string;
  mode: CheckMode;
  result: "off" | "allow" | "hit" | "error";
  reason?: string;
  errorKind?: ErrorKind;
  /** Set when the error came from the check's commit or release step. */
  phase?: "commit" | "release";
  ms?: number;
  [field: string]: unknown;
}

export interface SignUpDecision {
  outcome: "allow" | "reject";
  /** The enforce rejection that refuses the sign-up. */
  rejection?: { check: string; reason: string; message: string };
  checks: CheckReport[];
}

export interface RunOptions {
  deadlineAt: number;
  now?: () => number;
  /**
   * The sign-up is the filter check's probe (CB-07): hits and rejections use the checks' probeHit and
   * probeRejected metrics instead of hit and rejected. Nothing else changes.
   */
  probe?: boolean;
}

class CheckTimeoutError extends Error {
  constructor(readonly kind: Exclude<ErrorKind, "exception">) {
    super(kind === "deadline" ? "The pre-sign-up deadline has passed" : "The check ran out of its time budget");
    this.name = "CheckTimeoutError";
  }
}

/** Runs `work` with an abort signal; rejects with CheckTimeoutError after `ms` and aborts the signal. */
const runWithin = async <T>(
  ms: number,
  kind: Exclude<ErrorKind, "exception">,
  work: (signal: AbortSignal) => Promise<T> | T,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CheckTimeoutError(kind));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** The logger keys that identify the account being created. */
const ACCOUNT_KEYS = ["userName"] as const;

/** Runs `work` (and the async work it starts) with the account keys left out of every line. */
const withoutAccountKeys = <T>(work: () => T): T =>
  logger.withKeys({}, () => {
    logger.removeKeys(...ACCOUNT_KEYS);
    return work();
  });

/** SignUpAllowed=1 for a real sign-up the trigger lets through, on a line without the account keys. */
const emitSignUpAllowed = (): void =>
  withoutAccountKeys(() => emitEmbeddedMetric(ACCOUNTS_NAMESPACE, SIGN_UP_ALLOWED_METRIC, 1));

/** Runs `work` in the check's logging scope: without the account keys when its metrics ask for that. */
const inCheckScope = <T>(check: SignUpCheck, work: () => T): T =>
  check.metrics.omitAccountKeys ? withoutAccountKeys(work) : work();

const emitCheckError = (check: SignUpCheck, report: CheckReport, error: unknown): void => {
  inCheckScope(check, () =>
    emitEmbeddedMetric(check.metrics.namespace, check.metrics.error, 1, {
      properties: { check: check.name, errorKind: report.errorKind, phase: report.phase },
    }),
  );
  logger.warn("Pre-sign-up check failed open", {
    check: check.name,
    mode: report.mode,
    errorKind: report.errorKind,
    phase: report.phase,
    error,
  });
};

const errorKindOf = (error: unknown): ErrorKind => (error instanceof CheckTimeoutError ? error.kind : "exception");

/**
 * Runs the checks in order under the shared deadline and returns the decision. Never throws: a check's
 * own failure is reported as error and allowed. The caller throws the rejection's message.
 */
export const runSignUpChecks = async (
  event: SignUpTriggerEvent,
  checks: readonly SignUpCheck[],
  options: RunOptions,
): Promise<SignUpDecision> => {
  const now = options.now ?? Date.now;
  const { deadlineAt } = options;
  const spent = new Map<CheckBudget, number>();
  const reports: CheckReport[] = [];
  type Step = { check: SignUpCheck; mode: Exclude<CheckMode, "off">; step: SignUpCheckCommit };
  const commits: Step[] = [];
  const releases: Step[] = [];

  const allowance = (check: SignUpCheck): { ms: number; kind: Exclude<ErrorKind, "exception"> } => {
    const budgetLeft = check.budget.ms - (spent.get(check.budget) ?? 0);
    const timeLeft = deadlineAt - now();
    return timeLeft <= budgetLeft ? { ms: timeLeft, kind: "deadline" } : { ms: budgetLeft, kind: "timeout" };
  };

  const contextFor = (mode: Exclude<CheckMode, "off">, signal: AbortSignal): SignUpCheckContext => ({
    event,
    mode,
    signal,
    deadlineAt,
    timeLeftMs: () => deadlineAt - now(),
    now,
  });

  const timed = async <T>(
    check: SignUpCheck,
    mode: Exclude<CheckMode, "off">,
    work: (context: SignUpCheckContext) => Promise<T> | T,
  ): Promise<{ value?: T; error?: unknown; ms: number }> => {
    const startedAt = now();
    const { ms, kind } = allowance(check);
    try {
      if (ms <= 0) throw new CheckTimeoutError(kind);
      const value = await runWithin(ms, kind, (signal) => inCheckScope(check, () => work(contextFor(mode, signal))));
      return { value, ms: now() - startedAt };
    } catch (error) {
      return { error, ms: now() - startedAt };
    } finally {
      spent.set(check.budget, (spent.get(check.budget) ?? 0) + (now() - startedAt));
    }
  };

  /** Runs steps in the given order; a failing step is an error report in that phase, and the rest still run. */
  const runSteps = async (steps: readonly Step[], phase: "commit" | "release"): Promise<void> => {
    for (const { check, mode, step } of steps) {
      const { error, ms } = await timed(check, mode, step);
      if (error === undefined) continue;
      const report: CheckReport = {
        check: check.name,
        mode,
        result: "error",
        errorKind: errorKindOf(error),
        phase,
        ms,
      };
      reports.push(report);
      emitCheckError(check, report, error);
    }
  };

  for (const check of checks) {
    // Any value other than off or enforce (or a throwing mode function) means watch.
    let mode: CheckMode = "watch";
    try {
      const value = check.mode();
      if (value === "off" || value === "enforce") mode = value;
    } catch {
      mode = "watch";
    }
    if (mode === "off") {
      reports.push({ check: check.name, mode, result: "off" });
      continue;
    }

    const { value: result, error, ms } = await timed(check, mode, check.run);
    if (error !== undefined || !result) {
      const report: CheckReport = { check: check.name, mode, result: "error", errorKind: errorKindOf(error), ms };
      reports.push(report);
      emitCheckError(check, report, error ?? new Error("The check returned no result"));
      continue;
    }

    if (result.outcome === "allow") {
      reports.push({ ...result.logFields, check: check.name, mode, result: "allow", ms });
      if (result.commit) commits.push({ check, mode, step: result.commit });
      if (result.release) releases.push({ check, mode, step: result.release });
      continue;
    }

    reports.push({ ...result.logFields, check: check.name, mode, result: "hit", reason: result.reason, ms });
    const properties = { check: check.name, reason: result.reason, mode };
    const hitName = options.probe ? check.metrics.probeHit : check.metrics.hit;
    const rejectedName = options.probe ? check.metrics.probeRejected : check.metrics.rejected;
    const hitMetrics = [
      ...(hitName ? [{ name: hitName, value: 1 }] : []),
      ...(mode === "enforce" && rejectedName ? [{ name: rejectedName, value: 1 }] : []),
    ];
    if (hitMetrics.length > 0) {
      inCheckScope(check, () => emitEmbeddedMetrics(check.metrics.namespace, hitMetrics, { properties }));
    }

    if (mode === "enforce") {
      // The sign-up is refused: undo what the checks before this one wrote, newest first.
      await runSteps([...releases].reverse(), "release");
      return {
        outcome: "reject",
        rejection: { check: check.name, reason: result.reason, message: result.message || result.reason },
        checks: reports,
      };
    }
  }

  await runSteps(commits, "commit");
  return { outcome: "allow", checks: reports };
};

// ─── INT-05 checks ────────────────────────────────────────────────────────────

/** SIGNUP_FILTER_MODE: "enforce" (any case) enforces; anything else, or nothing, is watch. */
export const signUpFilterMode = (env: NodeJS.ProcessEnv = process.env): "watch" | "enforce" =>
  (env.SIGNUP_FILTER_MODE ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "watch";

let dynamoClient: DynamoDBClient | undefined;
let cognitoClient: CognitoIdentityProviderClient | undefined;
let secretsClient: SecretsManagerClient | undefined;
const dynamo = (): DynamoDBClient => (dynamoClient ??= new DynamoDBClient({}));
const cognito = (): CognitoIdentityProviderClient => (cognitoClient ??= new CognitoIdentityProviderClient({}));
const secrets = (): SecretsManagerClient => (secretsClient ??= new SecretsManagerClient({}));

let cachedHashSalt: string | null = null;

/** The DistrictVerification salt (same secret and hash form), fetched once per container. */
const loadHashSalt = async (signal: AbortSignal): Promise<string> => {
  const override = (process.env.HASH_SALT ?? "").trim();
  if (override) return override;
  if (cachedHashSalt) return cachedHashSalt;

  const secretId = (process.env.HASH_SALT_SECRET_ARN ?? "").trim();
  if (!secretId) throw new Error("HASH_SALT_SECRET_ARN is not configured.");
  const response = await secrets().send(new GetSecretValueCommand({ SecretId: secretId }), { abortSignal: signal });
  const value = (response.SecretString ?? "").trim();
  if (!value) throw new Error("The hash salt secret is empty.");
  cachedHashSalt = value;
  return value;
};

export type { ClaimOutcome };

export interface ClaimRequest {
  db: Pick<DynamoDBClient, "send">;
  cognito: Pick<CognitoIdentityProviderClient, "send">;
  tableName: string;
  userPoolId: string;
  /** The trigger's userName (a UUID in this pool), which Cognito gives the new account. */
  userName: string;
  emailKey: string;
  /** addressKeyFor the exact address this sign-up uses (the email Cognito validated, as it came). */
  addressKey: string;
  now: () => number;
  signal?: AbortSignal;
  /**
   * Epoch milliseconds by which the check must be done (its budget). A write that loses to a concurrent sign-up is
   * not evaluated again with less than CLAIM_ROUND_RESERVE_MS left: the sign-up is then a hit (detail contention).
   */
  giveUpAt?: number;
}

export interface ClaimResult {
  outcome: ClaimOutcome;
  /** The other account behind a hit, or the one a take-over replaced (for the probe record only; never logged). */
  holder?: string;
  /** How many sign-up attempts the EMAIL# item records after this sign-up (as read, for a hit). */
  holders: number;
  /** Why a hit that is not a variant of another address is one (ClaimDetail in emailPolicy.ts). */
  detail?: ClaimDetail;
}

/**
 * Rounds of read, look-up and write one sign-up gets while concurrent sign-ups keep changing the claim. Every round
 * lets at least one of the competing writes through, and each same-address attempt that gets through joins the
 * holders until the holder limit refuses the rest without a write, so this many rounds always settle a race of
 * parallel sign-ups on one address. A sign-up that still loses is a hit (detail contention) rather than an error: an
 * error fails open, and the sign-up would then go on without being recorded as a holder.
 */
export const MAX_CLAIM_ROUNDS = MAX_CLAIM_HOLDERS + 2;
/** A new round is started only with at least this much of the check's budget left (ClaimRequest.giveUpAt). */
export const CLAIM_ROUND_RESERVE_MS = 250;
/** nameLiveHolder's write is aborted this long before ClaimRequest.giveUpAt. */
const CLAIM_WRITE_MARGIN_MS = 50;

const CONCURRENT_CANCELLATION_CODES = new Set(["None", "ConditionalCheckFailed", "TransactionConflict"]);

/** A cancelled claim transaction caused by another sign-up writing the same claim in between. */
const isConcurrentClaim = (error: unknown): boolean => {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  if (!reasons || reasons.length === 0) return true;
  return reasons.every((reason) => CONCURRENT_CANCELLATION_CODES.has(reason.Code ?? "None"));
};

/**
 * AdminGetUser on a holder of an existing claim (C2 3.5 step 5): live when the account still holds the
 * address (isLiveClaimHolder), inactive when it no longer does, missing when Cognito cannot find it (decideClaim
 * then looks at that holder's own claimedAt: its sign-up may still be in progress).
 */
const lookUpHolder = async (request: ClaimRequest, holder: string): Promise<HolderLookup> => {
  try {
    const user = await request.cognito.send(
      new AdminGetUserCommand({ UserPoolId: request.userPoolId, Username: holder }),
      { abortSignal: request.signal },
    );
    return isLiveClaimHolder({ status: user.UserStatus, createdAt: user.UserCreateDate }, request.now())
      ? "live"
      : "inactive";
  } catch (error) {
    if (error instanceof Error && error.name === "UserNotFoundException") return "missing";
    throw error;
  }
};

type WriteCondition = Required<Pick<PutItemCommandInput, "ConditionExpression">> &
  Pick<PutItemCommandInput, "ExpressionAttributeNames" | "ExpressionAttributeValues">;

/**
 * The condition that makes a claim write a compare-and-set against exactly the item read: its revision, or,
 * for an item written before revisions existed, its userName (or that it names none) and no revision since.
 * An item deleted in between (account deletion) may be written again.
 */
const unchangedSince = (claim: EmailClaim | null): WriteCondition => {
  if (!claim) return { ConditionExpression: "attribute_not_exists(pk)" };
  const names = { "#revision": "revision" };
  if (claim.revision) {
    return {
      ConditionExpression: "attribute_not_exists(pk) OR #revision = :seenRevision",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ":seenRevision": { S: claim.revision } },
    };
  }
  if (claim.userName) {
    return {
      ConditionExpression: "attribute_not_exists(pk) OR (attribute_not_exists(#revision) AND userName = :seenUserName)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: { ":seenUserName": { S: claim.userName } },
    };
  }
  return {
    ConditionExpression:
      "attribute_not_exists(pk) OR (attribute_not_exists(#revision) AND attribute_not_exists(userName))",
    ExpressionAttributeNames: names,
  };
};

/**
 * The condition that a write applies to exactly the item read and only while it exists: its revision, or, for an
 * item written before revisions existed, no revision and the userName read.
 */
const exactlyAsRead = (claim: EmailClaim): WriteCondition =>
  claim.revision
    ? {
        ConditionExpression: "#revision = :seenRevision",
        ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":seenRevision": { S: claim.revision } },
      }
    : {
        ConditionExpression: "attribute_not_exists(#revision) AND userName = :userName",
        ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: { ":userName": { S: claim.userName ?? "" } },
      };

const holdersAttribute = (holders: Record<string, string>): AttributeValue => ({
  M: Object.fromEntries(Object.entries(holders).map(([name, claimedAt]) => [name, { S: claimedAt }])),
});

/**
 * Answers nextHolderLookups (emailPolicy.ts) until decideClaim can decide: the holder the claim names first, alone,
 * then, only when the answer still depends on them, the rest in parallel. At most MAX_CLAIM_HOLDERS AdminGetUser
 * calls, and usually one.
 */
const lookUpHolders = async (
  request: ClaimRequest,
  input: Omit<ClaimDecisionInput, "lookups">,
): Promise<Map<string, HolderLookup>> => {
  const lookups = new Map<string, HolderLookup>();
  for (let next = nextHolderLookups({ ...input, lookups }); next.length > 0; ) {
    const answers = await Promise.all(next.map((holder) => lookUpHolder(request, holder)));
    next.forEach((holder, index) => lookups.set(holder, answers[index]));
    next = nextHolderLookups({ ...input, lookups });
  }
  return lookups;
};

/**
 * After a hit on a live holder that the claim does not name (of parallel sign-ups of one address, Cognito created
 * an earlier one), names that holder as the claim's userName and claimedAt, holders unchanged, on condition that
 * the item is still the revision read. The next sign-up on the base address then finds the account with its first
 * AdminGetUser instead of looking up every holder. No other attempt on that exact address can become an account
 * while it exists, so the holders cannot change any more except through a release or a take-over. Best effort: a
 * lost or failed write changes nothing for this sign-up, which is a hit either way. It is skipped with less than
 * CLAIM_ROUND_RESERVE_MS left and aborted CLAIM_WRITE_MARGIN_MS before giveUpAt, so it can never push the hit past
 * the check's budget (which would turn it into a fail-open error).
 */
const nameLiveHolder = async (request: ClaimRequest, claim: EmailClaim, holder: string): Promise<void> => {
  if (!claim.revision || claim.userName === holder) return;
  const timeLeft = request.giveUpAt === undefined ? Infinity : request.giveUpAt - request.now();
  if (timeLeft < CLAIM_ROUND_RESERVE_MS) return;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.signal?.addEventListener("abort", abort);
  const timer = Number.isFinite(timeLeft) ? setTimeout(abort, timeLeft - CLAIM_WRITE_MARGIN_MS) : undefined;
  const claimedAt = claim.holders[holder] || claim.claimedAt;
  try {
    await request.db.send(
      new PutItemCommand({
        TableName: request.tableName,
        Item: {
          pk: { S: emailClaimKey(request.emailKey) },
          userName: { S: holder },
          ...(claimedAt ? { claimedAt: { S: claimedAt } } : {}),
          ...(claim.addressKey ? { addressKey: { S: claim.addressKey } } : {}),
          holders: holdersAttribute(claim.holders),
          revision: { S: randomUUID() },
        },
        ...exactlyAsRead(claim),
      }),
      { abortSignal: controller.signal },
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    if (name !== "ConditionalCheckFailedException") logger.warn("Email claim not pointed at its live holder", { name });
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
  }
};

/**
 * Claims the base address for this sign-up, or reports that another sign-up or a live account already holds it.
 *
 * GetItem EMAIL#<emailKey> (strongly consistent). The other holders are looked up with AdminGetUser as far as the
 * decision needs (lookUpHolders: usually one call, at most MAX_CLAIM_HOLDERS), and decideClaim (emailPolicy.ts)
 * decides. A hit writes nothing of this sign-up; a hit on a live holder the claim does not name points the claim at
 * it (nameLiveHolder). Otherwise one transaction writes EMAIL#<emailKey> {userName, claimedAt, addressKey, holders,
 * revision} on condition that the item is still exactly what was read (unchangedSince), and USER#<userName>
 * {emailKey, claimedAt}. A transaction cancelled by a concurrent sign-up is evaluated again, up to
 * MAX_CLAIM_ROUNDS rounds in all and while CLAIM_ROUND_RESERVE_MS of the budget is left; after that the sign-up is
 * a hit with detail contention, never an error (which would fail open with the sign-up recorded nowhere). Each
 * round after a lost write also runs on its own signal, which fires CLAIM_WRITE_MARGIN_MS before giveUpAt
 * (boundRound): a round that runs out of time is likewise a hit with detail contention.
 */
export const claimBaseAddress = async (request: ClaimRequest): Promise<ClaimResult> => {
  let heldBefore = 0;
  for (let round = 1; ; round += 1) {
    const bound = round > 1 ? boundRound(request) : undefined;
    try {
      const result = await claimRound(bound?.request ?? request);
      if ("done" in result) return result.done;
      heldBefore = result.lost;
    } catch (error) {
      if (bound?.request.signal?.aborted)
        return { outcome: "variant_exists", holders: heldBefore, detail: "contention" };
      throw error;
    } finally {
      bound?.dispose();
    }
    const outOfTime = request.giveUpAt !== undefined && request.now() + CLAIM_ROUND_RESERVE_MS > request.giveUpAt;
    if (round >= MAX_CLAIM_ROUNDS || outOfTime) {
      return { outcome: "variant_exists", holders: heldBefore, detail: "contention" };
    }
  }
};

/**
 * A copy of the request for a round after a lost write, whose signal fires with the request's own signal or
 * CLAIM_WRITE_MARGIN_MS before giveUpAt, whichever comes first. Without it a late round (GetItem, up to two stages
 * of AdminGetUser, the transaction) could run past the check's budget, and the runner would end it as a fail-open
 * error with the sign-up recorded nowhere. The first round keeps the runner's deadline alone, as before.
 */
const boundRound = (request: ClaimRequest): { request: ClaimRequest; dispose: () => void } => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (request.signal?.aborted) abort();
  else request.signal?.addEventListener("abort", abort);
  const timeLeft = request.giveUpAt === undefined ? Infinity : request.giveUpAt - request.now();
  const timer = Number.isFinite(timeLeft)
    ? setTimeout(abort, Math.max(0, timeLeft - CLAIM_WRITE_MARGIN_MS))
    : undefined;
  return {
    request: { ...request, signal: controller.signal },
    dispose: () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    },
  };
};

/**
 * One round of claimBaseAddress: read, look up, decide and write. Returns the result, or `lost` (how many holders
 * the claim recorded as read) when a concurrent sign-up changed the claim before the write.
 */
const claimRound = async (request: ClaimRequest): Promise<{ done: ClaimResult } | { lost: number }> => {
  const options = { abortSignal: request.signal };
  const existing = await request.db.send(
    new GetItemCommand({
      TableName: request.tableName,
      Key: { pk: { S: emailClaimKey(request.emailKey) } },
      ConsistentRead: true,
    }),
    options,
  );
  const claim = readEmailClaim(existing.Item);
  const input = { claim, userName: request.userName, addressKey: request.addressKey, now: request.now() };
  const lookups = await lookUpHolders(request, input);
  const decision = decideClaim({ ...input, lookups });
  const heldBefore = claim ? Object.keys(claim.holders).length : 0;
  if (decision.outcome === "variant_exists") {
    if (claim && decision.holder && lookups.get(decision.holder) === "live") {
      await nameLiveHolder(request, claim, decision.holder);
    }
    return {
      done: {
        outcome: decision.outcome,
        holders: heldBefore,
        ...(decision.holder ? { holder: decision.holder } : {}),
        ...(decision.detail ? { detail: decision.detail } : {}),
      },
    };
  }

  const claimedAt = decision.holders[request.userName];
  try {
    await request.db.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: request.tableName,
              Item: {
                pk: { S: emailClaimKey(request.emailKey) },
                userName: { S: request.userName },
                claimedAt: { S: claimedAt },
                addressKey: { S: decision.addressKey },
                holders: holdersAttribute(decision.holders),
                revision: { S: randomUUID() },
              },
              ...unchangedSince(claim),
            },
          },
          {
            Put: {
              TableName: request.tableName,
              Item: {
                pk: { S: userClaimKey(request.userName) },
                emailKey: { S: request.emailKey },
                claimedAt: { S: claimedAt },
              },
            },
          },
        ],
      }),
      options,
    );
    return {
      done: {
        outcome: decision.outcome,
        holders: Object.keys(decision.holders).length,
        ...(decision.holder ? { holder: decision.holder } : {}),
      },
    };
  } catch (error) {
    if (!isConcurrentClaim(error)) throw error;
    return { lost: heldBefore };
  }
};

/**
 * Removes this sign-up from the claim it wrote, when a later check refuses it (emailBase's release step).
 * GetItem EMAIL#<emailKey> (strongly consistent), then one PutItem on condition that the item is still exactly
 * what was read (unchangedSince, without the deleted-item case): when this sign-up was its only holder, an item
 * that names no account (`releasedAt`), so the next sign-up on the base address claims it without AdminGetUser
 * (released); otherwise the item without this holder, its userName and claimedAt moved to the newest remaining
 * holder when they named this one (removed). A claim that does not record this sign-up by now is left alone
 * (not_held). A write that loses to a concurrent one is evaluated once more; a second loss throws. USER#<userName>
 * stays: Cognito never creates that account, so nothing reads it, and the function has no delete grant (X5).
 */
export const releaseBaseAddressClaim = async (
  request: Pick<ClaimRequest, "db" | "tableName" | "userName" | "emailKey" | "now" | "signal">,
): Promise<{ outcome: "released" | "removed" | "not_held" }> => {
  const options = { abortSignal: request.signal };
  const pk = { S: emailClaimKey(request.emailKey) };
  for (let attempt = 1; ; attempt += 1) {
    const existing = await request.db.send(
      new GetItemCommand({ TableName: request.tableName, Key: { pk }, ConsistentRead: true }),
      options,
    );
    const claim = readEmailClaim(existing.Item);
    if (!claim || !Object.hasOwn(claim.holders, request.userName)) return { outcome: "not_held" };

    const rest = claimWithoutHolder(claim, request.userName);
    const revision = { S: randomUUID() };
    const item: Record<string, AttributeValue> = rest
      ? {
          pk,
          userName: { S: rest.userName },
          ...(rest.claimedAt ? { claimedAt: { S: rest.claimedAt } } : {}),
          ...(claim.addressKey ? { addressKey: { S: claim.addressKey } } : {}),
          holders: holdersAttribute(rest.holders),
          revision,
        }
      : { pk, releasedAt: { S: new Date(request.now()).toISOString() }, revision };
    try {
      await request.db.send(
        new PutItemCommand({ TableName: request.tableName, Item: item, ...exactlyAsRead(claim) }),
        options,
      );
      return { outcome: rest ? "removed" : "released" };
    } catch (error) {
      if (attempt < 2 && error instanceof Error && error.name === "ConditionalCheckFailedException") continue;
      throw error;
    }
  }
};

const emailAttribute = (event: SignUpTriggerEvent): unknown => event.request?.userAttributes?.email;

/**
 * The account that held the base address before this sign-up, when it was another one (a hit or a
 * take-over), for the probe record only (CB-07): never logged. Keyed by the trigger event, like
 * attestationByEvent below.
 */
const formerClaimHolders = new WeakMap<SignUpTriggerEvent, string>();

/** Refuses an address whose domain, or a parent domain, is a disposable email service. */
export const disposableDomainCheck: SignUpCheck = {
  name: "disposableDomain",
  mode: () => signUpFilterMode(),
  budget: EMAIL_CHECKS_BUDGET,
  metrics: SIGN_UP_FILTER_METRICS,
  run: ({ event }) => {
    const parsed = parseEmailAddress(emailAttribute(event));
    // Cognito validates the address format itself.
    if (!parsed) return { outcome: "allow", logFields: { parsed: false } };
    if (matchDisposableDomain(parsed.domain) === null) return { outcome: "allow" };
    return {
      outcome: "reject",
      reason: DISPOSABLE_DOMAIN_REASON,
      message: DISPOSABLE_EMAIL_MESSAGE,
      logFields: { domain: parsed.domain },
    };
  },
};

/** One account per base address: a+x@ and Gmail dot variants count as the same address. */
export const emailBaseCheck: SignUpCheck = {
  name: "emailBase",
  mode: () => signUpFilterMode(),
  budget: EMAIL_CHECKS_BUDGET,
  metrics: SIGN_UP_FILTER_METRICS,
  run: async ({ event, signal, now, deadlineAt }) => {
    // The end of this check's time: the email budget from now (disposableDomain, before it, takes no time), or the
    // shared deadline when that comes first.
    const giveUpAt = Math.min(deadlineAt, now() + EMAIL_CHECKS_BUDGET.ms);
    const email = emailAttribute(event);
    const parsed = parseEmailAddress(email);
    if (!parsed || typeof email !== "string") return { outcome: "allow", logFields: { parsed: false } };

    const tableName = (process.env.SIGNUP_EMAIL_CLAIMS_TABLE_NAME ?? "").trim();
    if (!tableName) throw new Error("SIGNUP_EMAIL_CLAIMS_TABLE_NAME is not configured.");
    if (!event.userName) throw new Error("The trigger event has no userName.");

    const salt = await loadHashSalt(signal);
    const userName = event.userName;
    const emailKey = emailKeyFor(parsed.base, salt);
    const { outcome, holder, holders, detail } = await claimBaseAddress({
      db: dynamo(),
      cognito: cognito(),
      tableName,
      userPoolId: event.userPoolId,
      userName,
      emailKey,
      addressKey: addressKeyFor(email, salt),
      now,
      signal,
      giveUpAt,
    });
    if (holder) formerClaimHolders.set(event, holder);
    // The outcome and counts only: never an address or a key.
    const logFields = { claim: outcome, claimHolders: holders, ...(detail ? { claimDetail: detail } : {}) };
    if (outcome === "variant_exists") {
      return { outcome: "reject", reason: EMAIL_VARIANT_REASON, message: EMAIL_VARIANT_MESSAGE, logFields };
    }
    return {
      outcome: "allow",
      logFields,
      // A later check refusing the sign-up (App Attest or DeviceCheck under enforce) means Cognito never
      // creates this userName: take it off the claim, so it does not hold the address for
      // PENDING_CLAIM_WINDOW_MS (a retry of another address would be refused).
      release: async (context) => {
        await releaseBaseAddressClaim({
          db: dynamo(),
          tableName,
          userName,
          emailKey,
          now: context.now,
          signal: context.signal,
        });
      },
    };
  },
};

// ─── INT-04 checks (C3 3.5, WP-C3c) ───────────────────────────────────────────

/** App Attest gets at most 1.2 s (X4). */
export const APP_ATTEST_CHECK_BUDGET: CheckBudget = { label: "appAttest", ms: 1_200 };

/**
 * DeviceCheck is bounded by the shared deadline only: the evaluator gives each of its two Apple calls
 * min(1.0 s, time left - 0.2 s) (X4), so it ends before the deadline unless its secret read hangs, and
 * the deadline cuts that.
 */
export const DEVICE_CHECK_BUDGET: CheckBudget = { label: "deviceCheck", ms: SIGN_UP_DEADLINE_MS };

/**
 * The evaluator emits AppAttestRequests, AppAttestInvalid, AppAttestRejected, AppAttestOverLimit,
 * DeviceCheckCalls and its own AppAttestErrors (C3 3.11). The runner adds AppAttestErrors only when a
 * check itself throws or is cut by the deadline, and has no hit or rejected metric of its own for them.
 * None of these lines carries the account's userName (C3 3.11: never a user ID).
 */
export const APP_ATTEST_CHECK_METRICS: CheckMetrics = {
  namespace: APP_ATTEST_NAMESPACE,
  error: "AppAttestErrors",
  omitAccountKeys: true,
};

/**
 * The evaluator's own time limit ends this much before the runner's, so a slow App Attest check comes
 * back as the outcome error (one AppAttestErrors, and APP_ATTEST_FAIL_CLOSED still decides) rather than
 * being cut by the runner, which always fails open.
 */
const EVALUATOR_HEADROOM_MS = 50;

/**
 * This invocation's App Attest result, for DeviceCheck: a development key uses Apple's development host,
 * and a replay (Cognito re-invoking the trigger) does not set the bits again. Keyed by the trigger event,
 * which the runner passes unchanged to every check.
 */
const attestationByEvent = new WeakMap<SignUpTriggerEvent, SignUpAttestationResult>();

const rejectWith = (code: AppAttestBlockCode | undefined, logFields: Record<string, unknown>): SignUpCheckResult => {
  const reason = code ?? "APP_ATTEST_FAILED";
  return { outcome: "reject", reason, message: signUpRejectionError(reason).message, logFields };
};

const attestationLogFields = (result: SignUpAttestationResult): Record<string, unknown> => ({
  outcome: result.outcome,
  ...(result.reason ? { detail: result.reason } : {}),
  ...(result.keyEnvironment ? { keyEnvironment: result.keyEnvironment } : {}),
  ...(result.replay ? { replay: true } : {}),
});

const deviceCheckLogFields = (result: DeviceCheckSignUpResult): Record<string, unknown> => ({
  outcome: result.outcome,
  ...(result.count !== undefined ? { count: result.count } : {}),
});

/**
 * C3 3.5 App Attest: ClientMetadata.billboardAppAttest is verified like a vote assertion (purpose signup,
 * bound to the email's hash) and, on valid or development, the install's signupCount grows by 1 (not on
 * a replay; under enforce only below APP_ATTEST_MAX_ACCOUNTS_PER_KEY). Builds 1.0 and R1 send no
 * ClientMetadata: outcome missing, with no table call.
 *
 * The count is part of the evaluation, not a commit step, because under enforce the conditional count is
 * the limit check itself. Only deviceCheck runs after it, so the count is spent on a refused sign-up only
 * when DEVICE_CHECK_MODE is enforce and DeviceCheck then refuses.
 */
export const appAttestSignUpCheck: SignUpCheck = {
  name: "appAttest",
  mode: () => appAttestConfigFromEnv().mode,
  budget: APP_ATTEST_CHECK_BUDGET,
  metrics: APP_ATTEST_CHECK_METRICS,
  run: async ({ event, mode, deadlineAt, now }) => {
    attestationByEvent.delete(event);
    const deadlineMs = Math.min(deadlineAt, now() + APP_ATTEST_CHECK_BUDGET.ms) - EVALUATOR_HEADROOM_MS;
    const result = await evaluateSignUpAttestation(event, {
      config: { ...appAttestConfigFromEnv(), mode },
      deadlineMs,
    });
    attestationByEvent.set(event, result);
    const logFields = attestationLogFields(result);
    return result.decision === "reject" ? rejectWith(result.code, logFields) : { outcome: "allow", logFields };
  },
};

/**
 * C3 3.5 DeviceCheck (off until its key is set up): Apple's two bits for the device count its
 * sign-ups in its counter window. Under enforce a sign-up over its limit, or a missing or bad token, is refused;
 * Apple errors and timeouts let the sign-up through. It sets the bits as it allows, which is the same as
 * a commit step while it is the last check.
 */
export const deviceCheckSignUpCheck: SignUpCheck = {
  name: "deviceCheck",
  mode: () => appAttestConfigFromEnv().deviceCheckMode,
  budget: DEVICE_CHECK_BUDGET,
  metrics: APP_ATTEST_CHECK_METRICS,
  run: async ({ event, mode, deadlineAt }) => {
    const attestation = attestationByEvent.get(event);
    attestationByEvent.delete(event);
    const result = await evaluateSignUpDeviceCheck(event, {
      config: { ...appAttestConfigFromEnv(), deviceCheckMode: mode },
      deadlineMs: deadlineAt,
      ...(attestation ? { attestation } : {}),
    });
    const logFields = deviceCheckLogFields(result);
    return result.decision === "reject" ? rejectWith(result.code, logFields) : { outcome: "allow", logFields };
  },
};

/**
 * The ordered check list (X4): INT-05's email checks first, so an INT-05 rejection under enforce leaves no
 * attestation state, then App Attest, then DeviceCheck (C3 3.5).
 */
export const SIGN_UP_CHECKS: readonly SignUpCheck[] = [
  disposableDomainCheck,
  emailBaseCheck,
  appAttestSignUpCheck,
  deviceCheckSignUpCheck,
];

/**
 * C3 3.5: AdminCreateUser passes unchecked with the App Attest outcome admin (other sources: other), so
 * the sign-up readiness check before enforce (C3 8.4, from these logs) can tell admin-created accounts from
 * self sign-ups. One metric line, no table call; nothing at all while App Attest is off.
 */
const recordUncheckedSignUp = async (event: PreSignUpTriggerEvent): Promise<string | undefined> => {
  try {
    return (await evaluateSignUpAttestation(event)).outcome;
  } catch {
    // The evaluator never throws; this only keeps that promise for the trigger.
    return undefined;
  }
};

/**
 * A check's outcome for the summary line, so Logs Insights can count sign-ups by App Attest or DeviceCheck
 * outcome without indexing into `checks`: the evaluator's outcome, or off or error when it did not give one.
 */
const reportedOutcome = (decision: SignUpDecision, check: string): string | undefined => {
  const report = decision.checks.find((entry) => entry.check === check && entry.phase === undefined);
  if (!report) return undefined;
  if (report.result === "off" || report.result === "error") return report.result;
  return typeof report.outcome === "string" ? report.outcome : undefined;
};

// ─── The filter check's probes (CB-07) ────────────────────────────────────────

/** The probe record's own time limit, and the latest it may end, from the start of the invocation. */
export const PROBE_RECORD_TIMEOUT_MS = 500;
export const PROBE_RECORD_DEADLINE_MS = 4_500;

/** The probe token's read (INF-15), at most, from the start of the invocation. */
export const PROBE_TOKEN_TIMEOUT_MS = 1_000;

/**
 * This sign-up's probe kind, or null: the address must be the check address or a +tag of it, and the ClientMetadata
 * must carry the probe token (INF-15). Never throws: a failure here treats the sign-up as an ordinary one. The token
 * is never logged.
 */
const probeKindFor = async (
  event: SignUpTriggerEvent,
  startedAt: number,
  context?: Pick<Context, "getRemainingTimeInMillis">,
): Promise<ProbeKind | null> => {
  let kind: ProbeKind | null;
  try {
    kind = probeKindOf(emailAttribute(event), signUpFilterCheckAddress());
  } catch (error) {
    // The error's name only: its message could quote the address.
    logger.warn("Sign-up probe detection failed", { errorName: error instanceof Error ? error.name : typeof error });
    return null;
  }
  if (!kind) return null;
  const metadata = (event.request as { clientMetadata?: Record<string, unknown> | null }).clientMetadata;
  const sent = metadata && typeof metadata === "object" ? metadata[PROBE_TOKEN_METADATA_KEY] : undefined;
  if (typeof sent !== "string" || sent === "") {
    logger.info("Sign-up to the check address without the probe token: an ordinary sign-up", { checkAddress: kind });
    return null;
  }
  try {
    let ms = PROBE_TOKEN_TIMEOUT_MS;
    const remaining = context?.getRemainingTimeInMillis?.();
    if (typeof remaining === "number" && Number.isFinite(remaining)) {
      ms = Math.min(ms, remaining - LAMBDA_TIMEOUT_MARGIN_MS);
    }
    ms = Math.min(ms, startedAt + SIGN_UP_DEADLINE_MS - Date.now());
    const secretId = (process.env.SIGNUP_PROBE_TOKEN_SECRET_ARN ?? "").trim();
    // With no time left only a token this container already holds can still be used.
    const token = await runWithin(Math.max(ms, 0), "timeout", (signal) => loadProbeToken(secrets(), secretId, signal));
    if (probeTokenMatches(sent, token)) return kind;
    logger.info("Sign-up to the check address with a wrong probe token: an ordinary sign-up", { checkAddress: kind });
  } catch (error) {
    logger.warn("Sign-up probe token not read: an ordinary sign-up", {
      checkAddress: kind,
      errorKind: errorKindOf(error),
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  return null;
};

const probeCheckEntries = (decision: SignUpDecision): ProbeCheckEntry[] =>
  decision.checks.map((report) => {
    const entry: ProbeCheckEntry = { check: report.check, result: report.result };
    if (typeof report.reason === "string") entry.reason = report.reason;
    if (typeof report.claim === "string") entry.claim = report.claim;
    if (report.phase) entry.phase = report.phase;
    if (report.errorKind) entry.errorKind = report.errorKind;
    return entry;
  });

/**
 * Writes the probe's PROBE#<kind> record: one unconditional PutItem (PreSignUpCheck's existing grant), at
 * most PROBE_RECORD_TIMEOUT_MS and never past PROBE_RECORD_DEADLINE_MS from the start of the invocation (nor
 * past the Lambda's own time). Never throws; a failure is the warning "Sign-up probe record not written".
 */
const writeProbeRecord = async (input: {
  event: SignUpTriggerEvent;
  kind: ProbeKind;
  decision: SignUpDecision;
  startedAt: number;
  context?: Pick<Context, "awsRequestId" | "getRemainingTimeInMillis">;
}): Promise<void> => {
  const { event, kind, decision, startedAt, context } = input;
  const holder = formerClaimHolders.get(event);
  try {
    const tableName = (process.env.SIGNUP_EMAIL_CLAIMS_TABLE_NAME ?? "").trim();
    if (!tableName) throw new Error("SIGNUP_EMAIL_CLAIMS_TABLE_NAME is not configured.");
    let ms = Math.min(PROBE_RECORD_TIMEOUT_MS, startedAt + PROBE_RECORD_DEADLINE_MS - Date.now());
    const remaining = context?.getRemainingTimeInMillis?.();
    if (typeof remaining === "number" && Number.isFinite(remaining)) {
      ms = Math.min(ms, remaining - LAMBDA_TIMEOUT_MARGIN_MS);
    }
    if (ms <= 0) throw new CheckTimeoutError("deadline");
    const record: SignUpProbeRecord = {
      kind,
      userName: event.userName,
      at: new Date(startedAt).toISOString(),
      mode: signUpFilterMode(),
      outcome: decision.outcome === "reject" ? "rejected" : "allowed",
      ...(decision.rejection ? { rejectedBy: decision.rejection.check, reason: decision.rejection.reason } : {}),
      checks: probeCheckEntries(decision),
      ...(context?.awsRequestId ? { requestId: context.awsRequestId } : {}),
      ...(kind === "variant" ? { tag: probeTagOf(emailAttribute(event)) } : {}),
      ...(holder ? { holder } : {}),
    };
    await runWithin(ms, "timeout", (signal) =>
      dynamo().send(new PutItemCommand({ TableName: tableName, Item: toProbeRecordItem(record) }), {
        abortSignal: signal,
      }),
    );
  } catch (error) {
    logger.warn("Sign-up probe record not written", { errorKind: errorKindOf(error), error });
  }
};

const deadlineFor = (startedAt: number, context?: Pick<Context, "getRemainingTimeInMillis">): number => {
  const deadlineAt = startedAt + SIGN_UP_DEADLINE_MS;
  const remaining = context?.getRemainingTimeInMillis?.();
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return deadlineAt;
  return Math.min(deadlineAt, startedAt + remaining - LAMBDA_TIMEOUT_MARGIN_MS);
};

export const handler = async (
  event: PreSignUpTriggerEvent,
  context?: Pick<Context, "awsRequestId" | "getRemainingTimeInMillis">,
): Promise<PreSignUpTriggerEvent> => {
  const startedAt = Date.now();
  logger.resetContext(context);

  if (event.triggerSource !== "PreSignUp_SignUp") {
    // Accounts made by hand (AdminCreateUser: the canary and test users) and federated sign-ins.
    const appAttest = await recordUncheckedSignUp(event);
    logger.info("Pre-sign-up checks", {
      triggerSource: event.triggerSource,
      outcome: event.triggerSource === "PreSignUp_AdminCreateUser" ? "admin" : "other",
      appAttest,
    });
    return event;
  }

  logger.appendKeys({ userName: event.userName });
  const probe = await probeKindFor(event, startedAt, context);
  if (probe) logger.appendKeys({ probe });
  let decision: SignUpDecision;
  try {
    decision = await runSignUpChecks(event, SIGN_UP_CHECKS, {
      deadlineAt: deadlineFor(startedAt, context),
      ...(probe ? { probe: true } : {}),
    });
  } catch (error) {
    // runSignUpChecks does not throw; this guards a bug in it, so sign-up still fails open.
    emitEmbeddedMetric(ACCOUNT_INTEGRITY_NAMESPACE, SIGN_UP_FILTER_METRICS.error, 1, {
      properties: { check: "runner", errorKind: "exception" },
    });
    logger.error("Pre-sign-up checks failed open", { error });
    if (!probe) emitSignUpAllowed();
    return event;
  }

  logger.info("Pre-sign-up checks", {
    triggerSource: event.triggerSource,
    outcome: decision.outcome === "reject" ? "rejected" : "allowed",
    rejectedBy: decision.rejection?.check,
    reason: decision.rejection?.reason,
    appAttest: reportedOutcome(decision, appAttestSignUpCheck.name),
    deviceCheck: reportedOutcome(decision, deviceCheckSignUpCheck.name),
    ms: Date.now() - startedAt,
    checks: decision.checks,
  });

  if (!probe && decision.outcome === "allow") emitSignUpAllowed();
  if (probe) await writeProbeRecord({ event, kind: probe, decision, startedAt, context });
  formerClaimHolders.delete(event);
  if (decision.rejection) throw new Error(decision.rejection.message);
  return event;
};
