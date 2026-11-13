/**
 * App Attest decisions for protected requests (C3 3.4) and sign-up (C3 3.5, with the time budget
 * of integration plan X4), plus their EMF metrics (C3 3.11).
 *
 * None of these functions throws, in any mode: a failure inside is the outcome `error`, which is
 * allowed unless APP_ATTEST_FAIL_CLOSED is true under enforce. With the mode `off` (the code
 * default, and whenever APP_ATTEST_TABLE_NAME is unset) they return at once: no read, no write,
 * no metric and no vote-row attribute. Under `watch` they verify, record and emit, and never block.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { jsonResponse } from "../apiGateway";
import { emitEmbeddedMetrics, type EmbeddedMetricInput } from "../metrics";
import { verifyAssertion } from "./assertion";
import {
  METRIC_NAMESPACE,
  TIMING,
  appAttestConfigFromEnv,
  parseAppVersion,
  type AppAttestConfig,
  type AppAttestMode,
  type KeyEnvironment,
} from "./config";
import { DeviceCheckClient, bitsForCount, deviceCount } from "./deviceCheck";
import { AppAttestStore, type StoredKey } from "./store";
import {
  APP_ATTEST_HEADER,
  APP_VERSION_HEADER,
  CLIENT_METADATA_KEYS,
  base64url,
  bodySha256,
  checkRequestClientData,
  checkSignUpClientData,
  decodeStandardBase64,
  emailSha256,
  isBelowMinimumVersion,
  keyIdPrefix,
  parseCognitoGroups,
  parseMarker,
  readHeader,
  sha256,
  type ClientDataCheck,
  type ParsedMarker,
} from "./wire";

export type AppAttestOutcome =
  | "valid"
  | "development"
  | "missing"
  | "unsupported"
  | "bypass"
  | "client_error"
  | "invalid"
  | "error";
/** Sign-up adds `admin` (AdminCreateUser, never checked) and `other` (any other trigger source). */
export type SignUpOutcome = AppAttestOutcome | "admin" | "other";
export type AppAttestRoute = "feedback" | "signup";

/** The codes a blocked request or sign-up carries (contracts/README.md "App Attest (INT-04)"). */
export type AppAttestBlockCode =
  | "APP_ATTEST_REQUIRED"
  | "APP_ATTEST_FAILED"
  | "APP_ATTEST_UNKNOWN_KEY"
  | "DEVICE_ACCOUNT_LIMIT"
  | "APP_UPDATE_REQUIRED"
  | "APP_ATTEST_UNAVAILABLE";

export const BLOCK_STATUS: Record<AppAttestBlockCode, number> = {
  APP_ATTEST_REQUIRED: 403,
  APP_ATTEST_FAILED: 403,
  APP_ATTEST_UNKNOWN_KEY: 403,
  DEVICE_ACCOUNT_LIMIT: 403,
  APP_UPDATE_REQUIRED: 426,
  APP_ATTEST_UNAVAILABLE: 503,
};

export interface EvaluateDeps {
  /** Defaults to appAttestConfigFromEnv() at call time. */
  config?: AppAttestConfig;
  store?: AppAttestStore;
  deviceCheck?: DeviceCheckClient;
  now?: () => Date;
}

export interface RequestAttestationResult {
  mode: AppAttestMode;
  /** The vote row's `appAttest` value; undefined when the mode is off (write no attribute then). */
  outcome?: AppAttestOutcome;
  reason?: string;
  exempt: boolean;
  /** True only under enforce: return `response` and write nothing. */
  blocked: boolean;
  code?: AppAttestBlockCode;
  response?: APIGatewayProxyResult;
}

export interface SignUpAttestationResult {
  mode: AppAttestMode;
  /** Undefined when the mode is off. */
  outcome?: SignUpOutcome;
  reason?: string;
  /** "reject" only under enforce; the caller then throws new Error(code) (see signUpRejectionError). */
  decision: "allow" | "reject";
  code?: AppAttestBlockCode;
  /** Environment of the asserting key (DeviceCheck uses Apple's development host for development keys). */
  keyEnvironment?: KeyEnvironment;
  /** A retry of the same assertion (Cognito re-invoked the trigger): counters are not incremented again. */
  replay: boolean;
}

export type DeviceCheckOutcome = "ok" | "not_found" | "bad_token" | "missing" | "error";

export interface DeviceCheckSignUpResult {
  mode: AppAttestMode;
  /** Undefined when DeviceCheck is off or the trigger source is not a self sign-up. */
  outcome?: DeviceCheckOutcome;
  /** Sign-ups Apple's bits held for the device before this one (0-3). */
  count?: number;
  decision: "allow" | "reject";
  code?: AppAttestBlockCode;
}

/** The structural part of a Cognito pre-sign-up event these checks read. */
export interface SignUpEventLike {
  triggerSource?: string;
  userName?: string;
  request?: {
    userAttributes?: Record<string, string | undefined>;
    clientMetadata?: Record<string, string | undefined> | null;
  };
}

export interface SignUpOptions extends EvaluateDeps {
  /** Epoch milliseconds by which PreSignUpCheck must answer (its shared 3.5 s deadline, X4). */
  deadlineMs?: number;
}

/** The error the pre-sign-up trigger throws to reject: Cognito shows "PreSignUp failed with error <CODE>.". */
export const signUpRejectionError = (code: AppAttestBlockCode): Error => new Error(code);

// ─── Shared machinery ──────────────────────────────────────────────────────────

class BudgetExceededError extends Error {
  constructor() {
    super("App Attest time budget exceeded");
    this.name = "BudgetExceededError";
  }
}

/** Runs `work` with an abort signal and rejects with BudgetExceededError after `budgetMs`. */
const withBudget = async <T>(budgetMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  if (!(budgetMs > 0)) throw new BudgetExceededError();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new BudgetExceededError());
    }, budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const errorReason = (error: unknown): string =>
  error instanceof BudgetExceededError ? "timeout" : `exception:${error instanceof Error ? error.name : "unknown"}`;

interface Verification {
  outcome: AppAttestOutcome;
  reason?: string;
  replay: boolean;
  keyId?: string;
  key?: StoredKey;
  validationCategory?: number;
  bundleVersion?: string;
  /** A new account (or a 4th sign-up) on a key already at its limit. */
  overLimit?: boolean;
  /** overLimit while the limit is enforced: nothing was written. */
  limitBlocked?: boolean;
}

/** The outcome of every marker form except an assertion, which needs verification. */
const markerOutcome = (marker: ParsedMarker): Verification | null => {
  switch (marker.kind) {
    case "missing":
      return { outcome: "missing", replay: false };
    case "unsupported":
      return { outcome: "unsupported", replay: false };
    case "bypass":
      return { outcome: "bypass", replay: false };
    case "client_error":
      return { outcome: "client_error", reason: marker.code, replay: false };
    case "malformed":
      return { outcome: "invalid", reason: marker.reason, replay: false };
    default:
      return null;
  }
};

/** C3 3.4 steps 2-9: clientData, challenge, key, signature and counter. */
const verifyAssertionMarker = async (input: {
  store: AppAttestStore;
  marker: Extract<ParsedMarker, { kind: "assertion" }>;
  checkClientData: (bytes: Buffer) => ClientDataCheck;
  now: Date;
  signal: AbortSignal;
}): Promise<Verification> => {
  const { store, marker, now, signal } = input;
  const base = { keyId: marker.keyId, replay: false };
  const clientData = input.checkClientData(marker.clientData);
  if (!clientData.ok) return { ...base, outcome: "invalid", reason: clientData.reason };

  const consumed = await store.consumeChallenge(
    { challenge: clientData.challenge, purpose: "assert", consumedBy: base64url(sha256(marker.assertion)), now },
    { signal },
  );
  if (!consumed.ok) return { ...base, outcome: "invalid", reason: consumed.reason };
  const replay = consumed.replay;

  const key = await store.getKey(marker.keyId, { signal });
  if (!key) return { ...base, replay, outcome: "invalid", reason: "unknown_key" };
  if (key.status !== "active") return { ...base, replay, key, outcome: "invalid", reason: "revoked_key" };

  const verified = verifyAssertion({
    assertion: marker.assertion,
    clientData: marker.clientData,
    publicKeySpki: key.publicKeySpki,
    storedCounter: key.signCount,
    allowEqualCounter: replay,
  });
  if (!verified.ok) return { ...base, replay, key, outcome: "invalid", reason: verified.reason };
  if (verified.counter > key.signCount) {
    const advanced = await store.advanceCounter({ keyId: key.keyId, counter: verified.counter, now }, { signal });
    if (!advanced) return { ...base, replay, key, outcome: "invalid", reason: "counter_not_increasing" };
  }
  return {
    ...base,
    replay,
    key,
    outcome: key.environment === "production" ? "valid" : "development",
    validationCategory: verified.validationCategory ?? key.validationCategory,
    bundleVersion: verified.bundleVersion ?? key.bundleVersion,
  };
};

/** What enforce would do with this verification (ignoring exemption and mode). */
const blockingCode = (
  config: AppAttestConfig,
  verification: Verification,
  versionBlocked: boolean,
): AppAttestBlockCode | undefined => {
  if (versionBlocked) return "APP_UPDATE_REQUIRED";
  switch (verification.outcome) {
    case "valid":
      return verification.limitBlocked ? "DEVICE_ACCOUNT_LIMIT" : undefined;
    case "development":
      if (!config.developmentAllowed) return "APP_ATTEST_FAILED";
      return verification.limitBlocked ? "DEVICE_ACCOUNT_LIMIT" : undefined;
    case "missing":
      return "APP_UPDATE_REQUIRED";
    case "unsupported":
    case "bypass":
    case "client_error":
      return "APP_ATTEST_REQUIRED";
    case "invalid":
      return verification.reason === "unknown_key" || verification.reason === "revoked_key"
        ? "APP_ATTEST_UNKNOWN_KEY"
        : "APP_ATTEST_FAILED";
    case "error":
      return config.failClosed ? "APP_ATTEST_UNAVAILABLE" : undefined;
  }
};

const decide = (
  config: AppAttestConfig,
  verification: Verification,
  context: { exempt: boolean; versionBlocked: boolean },
): { blocked: boolean; code?: AppAttestBlockCode; wouldBlock?: AppAttestBlockCode } => {
  const code = blockingCode(config, verification, context.versionBlocked);
  if (!code) return { blocked: false };
  if (config.mode === "enforce" && !context.exempt) return { blocked: true, code };
  return { blocked: false, wouldBlock: code };
};

/** True when development keys would be refused under enforce (no binding or count is written for them). */
const refusedDevelopmentKey = (config: AppAttestConfig, verification: Verification, exempt: boolean): boolean =>
  config.mode === "enforce" && !exempt && verification.outcome === "development" && !config.developmentAllowed;

const emit = (metrics: EmbeddedMetricInput[], options: Parameters<typeof emitEmbeddedMetrics>[2]): void =>
  emitEmbeddedMetrics(METRIC_NAMESPACE, metrics, options);

const loggedAppVersion = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  return parseAppVersion(value) ?? "unreadable";
};

const emitEvaluation = (input: {
  route: AppAttestRoute;
  mode: AppAttestMode;
  outcome: SignUpOutcome;
  verification?: Verification;
  decision: { blocked: boolean; code?: AppAttestBlockCode; wouldBlock?: AppAttestBlockCode };
  exempt: boolean;
  appVersion?: unknown;
  durationMs: number;
}): void => {
  const { route, outcome, verification, decision } = input;
  emit([{ name: "AppAttestRequests", value: 1 }], {
    dimensions: { Route: route, Outcome: outcome },
    properties: {
      message: "App Attest evaluated",
      mode: input.mode,
      reason: verification?.reason,
      environment: verification?.key?.environment,
      validationCategory: verification?.validationCategory,
      bundleVersion: verification?.bundleVersion,
      appVersion: loggedAppVersion(input.appVersion),
      keyIdPrefix: keyIdPrefix(verification?.keyId),
      exempt: input.exempt,
      replay: verification?.replay ?? false,
      blocked: decision.blocked,
      code: decision.code,
      wouldBlock: decision.wouldBlock,
      durationMs: input.durationMs,
    },
  });
  const counters: EmbeddedMetricInput[] = [];
  if (outcome === "invalid") counters.push({ name: "AppAttestInvalid", value: 1 });
  if (outcome === "error") counters.push({ name: "AppAttestErrors", value: 1 });
  if (decision.blocked) counters.push({ name: "AppAttestRejected", value: 1 });
  if (counters.length > 0) emit(counters, { properties: { route, reason: verification?.reason, code: decision.code } });
  if (verification?.overLimit) {
    emit([{ name: "AppAttestOverLimit", value: 1 }], {
      dimensions: { Kind: "install" },
      properties: { route, keyIdPrefix: keyIdPrefix(verification.keyId), blocked: decision.blocked },
    });
  }
};

const safeConfig = (deps: EvaluateDeps): AppAttestConfig | null => {
  try {
    return deps.config ?? appAttestConfigFromEnv();
  } catch {
    return null;
  }
};

const nowOf = (deps: EvaluateDeps): Date => (deps.now ? deps.now() : new Date());

// ─── Protected requests (POST /feedback) ───────────────────────────────────────

/**
 * C3 3.4. Call after the authorizer claims and body validation, before the bill lookup and the
 * INT-06 daily-cap counter. When `blocked`, return `response` and write nothing; otherwise, when
 * `outcome` is set, store it on the vote row as `appAttest` (S) in the existing PutItem.
 */
export async function evaluateRequestAttestation(
  event: APIGatewayProxyEvent,
  userId: string,
  route: AppAttestRoute = "feedback",
  deps: EvaluateDeps = {},
): Promise<RequestAttestationResult> {
  const config = safeConfig(deps);
  if (!config || config.mode === "off") return { mode: "off", exempt: false, blocked: false };
  const started = Date.now();
  try {
    return await evaluateRequest(event, userId, route, config, deps, started);
  } catch (error) {
    // Only a bug in this module gets here; treat it as an infrastructure error.
    const verification: Verification = { outcome: "error", reason: errorReason(error), replay: false };
    const decision = decide(config, verification, { exempt: false, versionBlocked: false });
    try {
      emitEvaluation({
        route,
        mode: config.mode,
        outcome: "error",
        verification,
        decision,
        exempt: false,
        durationMs: 0,
      });
    } catch {
      // Metrics never throw; this only keeps the promise of never throwing.
    }
    return toRequestResult(config.mode, verification, decision, false);
  }
}

const toRequestResult = (
  mode: AppAttestMode,
  verification: Verification,
  decision: { blocked: boolean; code?: AppAttestBlockCode },
  exempt: boolean,
): RequestAttestationResult => ({
  mode,
  outcome: verification.outcome,
  ...(verification.reason ? { reason: verification.reason } : {}),
  exempt,
  blocked: decision.blocked,
  ...(decision.code ? { code: decision.code } : {}),
  ...(decision.blocked && decision.code
    ? { response: jsonResponse(BLOCK_STATUS[decision.code], { error: decision.code }) }
    : {}),
});

const evaluateRequest = async (
  event: APIGatewayProxyEvent,
  userId: string,
  route: AppAttestRoute,
  config: AppAttestConfig,
  deps: EvaluateDeps,
  started: number,
): Promise<RequestAttestationResult> => {
  const authorizer = event?.requestContext?.authorizer as
    | { claims?: Record<string, unknown>; jwt?: { claims?: Record<string, unknown> } }
    | undefined;
  const claims = authorizer?.claims ?? authorizer?.jwt?.claims;
  const exempt = parseCognitoGroups(claims?.["cognito:groups"]).includes(config.exemptGroup);
  const appVersion = readHeader(event, APP_VERSION_HEADER);
  const versionBlocked = isBelowMinimumVersion(appVersion, config.minAppVersion);
  const marker = parseMarker(readHeader(event, APP_ATTEST_HEADER));

  let verification = markerOutcome(marker);
  if (!verification && marker.kind === "assertion") {
    const now = nowOf(deps);
    const store = deps.store ?? new AppAttestStore(config.tableName as string);
    // A request enforce will refuse anyway (development key not allowed, app too old) binds nothing.
    const refusedAnyway = (verified: Verification) =>
      refusedDevelopmentKey(config, verified, exempt) || (config.mode === "enforce" && !exempt && versionBlocked);
    try {
      verification = await withBudget(TIMING.requestBudgetMs, async (signal) => {
        const verified = await verifyAssertionMarker({
          store,
          marker,
          now,
          signal,
          checkClientData: (bytes) =>
            checkRequestClientData(bytes, {
              method: String(event?.httpMethod ?? ""),
              path: String(event?.resource ?? ""),
              bodySha256: bodySha256(event),
            }),
        });
        if (!verified.key || !userId || (verified.outcome !== "valid" && verified.outcome !== "development")) {
          return verified;
        }
        if (refusedAnyway(verified)) return verified;
        return { ...verified, ...(await bindAccount(store, config, verified.key, userId, exempt, now, signal)) };
      });
    } catch (error) {
      verification = { outcome: "error", reason: errorReason(error), replay: false, keyId: marker.keyId };
    }
  }
  const resolved = verification ?? { outcome: "error" as const, reason: "unreachable", replay: false };
  const decision = decide(config, resolved, { exempt, versionBlocked });
  emitEvaluation({
    route,
    mode: config.mode,
    outcome: resolved.outcome,
    verification: resolved,
    decision,
    exempt,
    appVersion,
    durationMs: Date.now() - started,
  });
  return toRequestResult(config.mode, resolved, decision, exempt);
};

/** C3 3.4 step 10: the account-to-install binding and the key's accountCount. */
const bindAccount = async (
  store: AppAttestStore,
  config: AppAttestConfig,
  key: StoredKey,
  userId: string,
  exempt: boolean,
  now: Date,
  signal: AbortSignal,
): Promise<Pick<Verification, "overLimit" | "limitBlocked">> => {
  const binding = await store.getBinding(userId, key.keyId, { signal });
  if (binding) {
    const lastSeen = Date.parse(binding.lastSeenAt ?? "");
    if (!Number.isFinite(lastSeen) || now.getTime() - lastSeen > TIMING.bindingRefreshMs) {
      await store.refreshBinding({ userId, keyId: key.keyId, now }, { signal });
    }
    return {};
  }
  const overLimit = key.accountCount >= config.maxAccountsPerKey;
  const enforced = config.mode === "enforce" && !exempt;
  if (overLimit && enforced) return { overLimit, limitBlocked: true };
  // The binding and its count in one transaction; under enforce the limit is part of that write, so
  // parallel first votes from new accounts cannot all pass the count read above (C3 D1).
  const bound = await store.bindAccount(
    { userId, keyId: key.keyId, now, ...(enforced ? { limit: config.maxAccountsPerKey } : {}) },
    { signal },
  );
  if (bound === "limit") return { overLimit: true, limitBlocked: true };
  return { overLimit };
};

// ─── Sign-up (Cognito pre-sign-up trigger) ─────────────────────────────────────

const SELF_SIGN_UP = "PreSignUp_SignUp";
const ADMIN_CREATE_USER = "PreSignUp_AdminCreateUser";

const clientMetadataOf = (event: SignUpEventLike): Record<string, string | undefined> => {
  const metadata = event?.request?.clientMetadata;
  return metadata && typeof metadata === "object" ? metadata : {};
};

const remainingMs = (options: SignUpOptions): number =>
  options.deadlineMs === undefined ? Number.POSITIVE_INFINITY : options.deadlineMs - Date.now();

/**
 * C3 3.5, App Attest part: AdminCreateUser passes as `admin`; a self sign-up's
 * ClientMetadata.billboardAppAttest is checked like a request assertion, with purpose `signup`,
 * emailSha256 of the address instead of the method, path and body, and no account binding. On
 * `valid` or `development`, the key's signupCount grows by 1 (not on a replay); under enforce only
 * while it is below APP_ATTEST_MAX_ACCOUNTS_PER_KEY. Runs within min(1.2 s, time to the deadline).
 */
export async function evaluateSignUpAttestation(
  event: SignUpEventLike,
  options: SignUpOptions = {},
): Promise<SignUpAttestationResult> {
  const config = safeConfig(options);
  if (!config || config.mode === "off") return { mode: "off", decision: "allow", replay: false };
  const started = Date.now();
  try {
    return await evaluateSignUpInner(event, config, options, started);
  } catch (error) {
    const verification: Verification = { outcome: "error", reason: errorReason(error), replay: false };
    const decision = decide(config, verification, { exempt: false, versionBlocked: false });
    try {
      emitEvaluation({
        route: "signup",
        mode: config.mode,
        outcome: "error",
        verification,
        decision,
        exempt: false,
        durationMs: 0,
      });
    } catch {
      // See evaluateRequestAttestation.
    }
    return toSignUpResult(config.mode, verification, decision);
  }
}

const toSignUpResult = (
  mode: AppAttestMode,
  verification: Verification,
  decision: { blocked: boolean; code?: AppAttestBlockCode },
): SignUpAttestationResult => ({
  mode,
  outcome: verification.outcome,
  ...(verification.reason ? { reason: verification.reason } : {}),
  decision: decision.blocked ? "reject" : "allow",
  ...(decision.blocked && decision.code ? { code: decision.code } : {}),
  ...(verification.key ? { keyEnvironment: verification.key.environment } : {}),
  replay: verification.replay,
});

const evaluateSignUpInner = async (
  event: SignUpEventLike,
  config: AppAttestConfig,
  options: SignUpOptions,
  started: number,
): Promise<SignUpAttestationResult> => {
  if (event?.triggerSource !== SELF_SIGN_UP) {
    // Accounts made by hand (the canary, test users) and anything else pass unchecked.
    const outcome: SignUpOutcome = event?.triggerSource === ADMIN_CREATE_USER ? "admin" : "other";
    emitEvaluation({
      route: "signup",
      mode: config.mode,
      outcome,
      decision: { blocked: false },
      exempt: false,
      durationMs: Date.now() - started,
    });
    return { mode: config.mode, outcome, decision: "allow", replay: false };
  }

  const metadata = clientMetadataOf(event);
  const appVersion = metadata[CLIENT_METADATA_KEYS.appVersion];
  const marker = parseMarker(metadata[CLIENT_METADATA_KEYS.appAttest]);
  const versionBlocked = isBelowMinimumVersion(appVersion, config.minAppVersion);

  let verification = markerOutcome(marker);
  if (!verification && marker.kind === "assertion") {
    const now = nowOf(options);
    const store = options.store ?? new AppAttestStore(config.tableName as string);
    const email = event.request?.userAttributes?.email ?? event.userName ?? "";
    try {
      verification = await withBudget(Math.min(TIMING.signUpBudgetMs, remainingMs(options)), async (signal) => {
        const verified = await verifyAssertionMarker({
          store,
          marker,
          now,
          signal,
          checkClientData: (bytes) => checkSignUpClientData(bytes, emailSha256(email)),
        });
        const counts =
          verified.key &&
          !verified.replay &&
          (verified.outcome === "valid" || verified.outcome === "development") &&
          !refusedDevelopmentKey(config, verified, false) &&
          !(config.mode === "enforce" && versionBlocked);
        if (!counts || !verified.key) return verified;
        return { ...verified, ...(await countSignUp(store, config, verified.key, signal)) };
      });
    } catch (error) {
      verification = { outcome: "error", reason: errorReason(error), replay: false, keyId: marker.keyId };
    }
  }
  const resolved = verification ?? { outcome: "error" as const, reason: "unreachable", replay: false };
  const decision = decide(config, resolved, { exempt: false, versionBlocked });
  emitEvaluation({
    route: "signup",
    mode: config.mode,
    outcome: resolved.outcome,
    verification: resolved,
    decision,
    exempt: false,
    appVersion,
    durationMs: Date.now() - started,
  });
  return toSignUpResult(config.mode, resolved, decision);
};

/** C3 3.5: ADD signupCount 1; under enforce only while below the limit (else DEVICE_ACCOUNT_LIMIT). */
const countSignUp = async (
  store: AppAttestStore,
  config: AppAttestConfig,
  key: StoredKey,
  signal: AbortSignal,
): Promise<Pick<Verification, "overLimit" | "limitBlocked">> => {
  if (config.mode === "enforce") {
    const counted = await store.incrementSignupCount({ keyId: key.keyId, limit: config.maxAccountsPerKey }, { signal });
    return counted.ok ? {} : { overLimit: true, limitBlocked: true };
  }
  const counted = await store.incrementSignupCount({ keyId: key.keyId }, { signal });
  return counted.ok && counted.signupCount > config.maxAccountsPerKey ? { overLimit: true } : {};
};

// ─── Sign-up: DeviceCheck ───────────────────────────────────────────────────────

const emitDeviceCheck = (
  outcomes: DeviceCheckOutcome[],
  extra: {
    mode: AppAttestMode;
    count?: number;
    overLimit: boolean;
    code?: AppAttestBlockCode;
    wouldBlock?: AppAttestBlockCode;
    detail?: string;
  },
): void => {
  for (const outcome of outcomes) {
    emit([{ name: "DeviceCheckCalls", value: 1 }], {
      dimensions: { Outcome: outcome },
      properties: {
        message: "DeviceCheck evaluated",
        mode: extra.mode,
        count: extra.count,
        detail: extra.detail,
        code: extra.code,
        wouldBlock: extra.wouldBlock,
      },
    });
  }
  const counters: EmbeddedMetricInput[] = [];
  if (outcomes.includes("error")) counters.push({ name: "AppAttestErrors", value: 1 });
  if (extra.code) counters.push({ name: "AppAttestRejected", value: 1 });
  if (counters.length > 0) emit(counters, { properties: { route: "signup", check: "devicecheck", code: extra.code } });
  if (extra.overLimit) {
    emit([{ name: "AppAttestOverLimit", value: 1 }], {
      dimensions: { Kind: "device" },
      properties: { route: "signup", blocked: extra.code !== undefined },
    });
  }
};

/** Time for one DeviceCheck call: min(1,000 ms, time left - 200 ms) (X4). */
const deviceCheckCallMs = (options: SignUpOptions): number =>
  Math.min(TIMING.deviceCheckCallMaxMs, remainingMs(options) - TIMING.deviceCheckReserveMs);

/**
 * C3 3.5, DeviceCheck part (only when DEVICE_CHECK_MODE is not off and the secret is configured).
 * Reads Apple's two bits for the device, rejects a 4th sign-up under enforce, and otherwise sets
 * the bits to count + 1 (not on a replay). A missing or bad token is refused only under enforce;
 * Apple errors and timeouts let the sign-up through. Pass the App Attest result so a development
 * key uses Apple's development host and a replay is not counted twice.
 */
export async function evaluateSignUpDeviceCheck(
  event: SignUpEventLike,
  options: SignUpOptions & { attestation?: SignUpAttestationResult } = {},
): Promise<DeviceCheckSignUpResult> {
  const config = safeConfig(options);
  if (!config || config.deviceCheckMode === "off" || !config.deviceCheckSecretName) {
    return { mode: "off", decision: "allow" };
  }
  const mode = config.deviceCheckMode;
  if (event?.triggerSource !== SELF_SIGN_UP) return { mode, decision: "allow" };
  const enforce = mode === "enforce";
  try {
    const token = clientMetadataOf(event)[CLIENT_METADATA_KEYS.deviceCheck];
    const tokenMissing = typeof token !== "string" || token.length === 0;
    if (tokenMissing || !decodeStandardBase64(token)) {
      const outcome: DeviceCheckOutcome = tokenMissing ? "missing" : "bad_token";
      const code: AppAttestBlockCode | undefined = enforce ? "APP_ATTEST_REQUIRED" : undefined;
      emitDeviceCheck([outcome], {
        mode,
        overLimit: false,
        code,
        wouldBlock: enforce ? undefined : "APP_ATTEST_REQUIRED",
      });
      return { mode, outcome, decision: code ? "reject" : "allow", ...(code ? { code } : {}) };
    }

    const client = options.deviceCheck ?? new DeviceCheckClient({ secretName: config.deviceCheckSecretName });
    const development = options.attestation?.keyEnvironment === "development";
    const failOpen = (detail: string, outcomes: DeviceCheckOutcome[], count?: number): DeviceCheckSignUpResult => {
      const code: AppAttestBlockCode | undefined = enforce && config.failClosed ? "APP_ATTEST_UNAVAILABLE" : undefined;
      emitDeviceCheck(outcomes, { mode, count, overLimit: false, code, detail });
      return {
        mode,
        outcome: "error",
        ...(count !== undefined ? { count } : {}),
        decision: code ? "reject" : "allow",
        ...(code ? { code } : {}),
      };
    };

    const queryMs = deviceCheckCallMs(options);
    if (!(queryMs > 0)) return failOpen("deadline", ["error"]);
    const queried = await client.query(token, { development, timeoutMs: queryMs });
    if (queried.status === "bad_token") {
      const code: AppAttestBlockCode | undefined = enforce ? "APP_ATTEST_REQUIRED" : undefined;
      emitDeviceCheck(["bad_token"], {
        mode,
        overLimit: false,
        code,
        wouldBlock: enforce ? undefined : "APP_ATTEST_REQUIRED",
      });
      return { mode, outcome: "bad_token", decision: code ? "reject" : "allow", ...(code ? { code } : {}) };
    }
    if (queried.status === "error") return failOpen(queried.detail, ["error"]);

    const now = nowOf(options);
    const outcome: DeviceCheckOutcome = queried.status === "ok" ? "ok" : "not_found";
    const count = queried.status === "ok" ? deviceCount(queried, now, config.deviceCounterWindowMonths) : 0;
    if (count >= config.deviceMaxAccounts) {
      const code: AppAttestBlockCode | undefined = enforce ? "DEVICE_ACCOUNT_LIMIT" : undefined;
      emitDeviceCheck([outcome], {
        mode,
        count,
        overLimit: true,
        code,
        wouldBlock: enforce ? undefined : "DEVICE_ACCOUNT_LIMIT",
      });
      return { mode, outcome, count, decision: code ? "reject" : "allow", ...(code ? { code } : {}) };
    }
    if (options.attestation?.replay) {
      emitDeviceCheck([outcome], { mode, count, overLimit: false, detail: "replay" });
      return { mode, outcome, count, decision: "allow" };
    }
    const updateMs = deviceCheckCallMs(options);
    const updated =
      updateMs > 0
        ? await client.update(token, bitsForCount(count + 1), { development, timeoutMs: updateMs })
        : { status: "error" as const, detail: "deadline" };
    if (updated.status !== "ok") {
      return failOpen(`update:${"detail" in updated ? updated.detail : updated.status}`, [outcome, "error"], count);
    }
    emitDeviceCheck([outcome], { mode, count, overLimit: false });
    return { mode, outcome, count, decision: "allow" };
  } catch (error) {
    // A bug here must not block a sign-up: count it as an error and fail open (or closed if asked).
    const code: AppAttestBlockCode | undefined = enforce && config.failClosed ? "APP_ATTEST_UNAVAILABLE" : undefined;
    try {
      emitDeviceCheck(["error"], { mode, overLimit: false, code, detail: errorReason(error) });
    } catch {
      // Metrics never throw.
    }
    return { mode, outcome: "error", decision: code ? "reject" : "allow", ...(code ? { code } : {}) };
  }
}

/**
 * Both sign-up checks in order (App Attest, then DeviceCheck), stopping at the first rejection.
 * For a caller that registers one check; PreSignUpCheck's list may instead register
 * evaluateSignUpAttestation and evaluateSignUpDeviceCheck separately (X4).
 */
export async function evaluateSignUp(
  event: SignUpEventLike,
  options: SignUpOptions = {},
): Promise<{
  attestation: SignUpAttestationResult;
  deviceCheck?: DeviceCheckSignUpResult;
  decision: "allow" | "reject";
  code?: AppAttestBlockCode;
}> {
  const attestation = await evaluateSignUpAttestation(event, options);
  if (attestation.decision === "reject") return { attestation, decision: "reject", code: attestation.code };
  const deviceCheck = await evaluateSignUpDeviceCheck(event, { ...options, attestation });
  return {
    attestation,
    deviceCheck,
    decision: deviceCheck.decision,
    ...(deviceCheck.code ? { code: deviceCheck.code } : {}),
  };
}
