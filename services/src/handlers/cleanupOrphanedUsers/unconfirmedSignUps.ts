import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  ListUsersCommand,
  type AttributeType,
  type CognitoIdentityProviderClient,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";

import {
  UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS,
  UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN,
} from "../../shared/abuseLimits";
import { countUserData, type AccountDeletionContext } from "../../shared/accountDeletion";
import { emitEmbeddedMetrics } from "../../shared/metrics";
import { backoffDelayMs, sleep as defaultSleep } from "../../shared/retry";
import { deleteUserEmailClaim } from "../../shared/signUpEmailClaims";
import {
  PROJECT_EMAIL_DOMAIN,
  parseEmailAddress,
  probeKindOf,
  signUpFilterCheckAddress,
  type SignUpFilterCheckAddress,
} from "../../shared/signUpFilter";

/**
 * REL-53 (feature review S10): sign-ups left UNCONFIRMED longer than the maximum age are deleted, so the email can
 * sign up again. Leaving the app's email-code step is otherwise a dead end: the app has no way back to it (1.1), Create
 * account fails for that email (Cognito keeps the UNCONFIRMED user, and the email is the username attribute), and a
 * reset cannot help an unverified email. Such a user never signed in, so it holds no app data; the step checks
 * that before every deletion anyway.
 *
 * One step of CleanupOrphanedUsers' daily run, after the orphan path's abort check. Its own switch, independent of
 * DRY_RUN (which holds the orphan and resume paths in report-only mode while it is true):
 *
 *   UNCONFIRMED_SIGNUP_CLEANUP_MODE              off (the kill switch; also unset or any value not below), dry_run
 *                                                (reads and counts, writes nothing), delete
 *   UNCONFIRMED_SIGNUP_MAX_AGE_HOURS             a sign-up is deleted once it has been UNCONFIRMED longer than
 *                                                this (at least 24, the life of a confirmation code)
 *   UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN     at most this many deletions (dry run: candidates) per run,
 *                                                oldest first; the rest wait for the next run
 *                                                (UnconfirmedSignUpCleanupCapReached)
 *   (both default to the values in shared/abuseLimits.ts when unset)
 *   SIGNUP_FILTER_CHECK_ADDRESS                  the daily sign-up probe's address (CB-07), never deleted here
 *
 * The run:
 * 1. ListUsers with Filter cognito:user_status = "UNCONFIRMED", 60 a page, at most 100 pages, email and sub only.
 * 2. Each listed user is classified. Kept, with a reason: the sign-up filter check's probes (probeKindOf on the
 *    email, as PreSignUpCheck decides it; its own sweep removes them) and any other address on the project's domain
 *    (the project's; it also covers the probes when the check address is not set), a disabled user, a status other
 *    than UNCONFIRMED (admin-created users are FORCE_CHANGE_PASSWORD and never listed), no creation date. A
 *    sign-up younger than the maximum age is pending. The rest are candidates, oldest first.
 * 3. For each candidate up to the cap, in this order (the guard comes right before the writes):
 *    a. App data (read only): a UserPII row, votes, preferences, devices, weekly digests, an address claim or App
 *       Attest bindings under its sub. Any of them keeps the user (hasAppData; the sub is listed in the summary).
 *    b. The guard, strongly consistent: AdminGetUser must find it still UNCONFIRMED, enabled, older than the
 *       maximum age and not a probe. Never a CONFIRMED user: one that confirmed since the listing is kept
 *       (notUnconfirmed), one already gone counts as gone.
 *    c. delete only: its sign-up email claim (USER#<username>, and EMAIL#<emailKey> while it still names this
 *       account as its userName or one of its holders), then the Cognito user (UserNotFound counts as done).
 *       Claims go first, so a failure leaves at worst the user, which the next run finds again; every step is
 *       safe to repeat.
 * Throttling (TooManyRequests and the like) is retried with jittered backoff, 5 attempts per call; still
 * throttled, the run stops and the rest wait for the next run. Any other failure is an error for that user only.
 *
 * Output: the `unconfirmedSignUps` block of the run's summary (counts; no email, and a sub only for a user kept
 * with app data) and one embedded-metric line in BillBoard/Accounts without dimensions (UnconfirmedSignUpsDeleted,
 * UnconfirmedSignUpsExpired, UnconfirmedSignUpsPending, UnconfirmedSignUpCleanupErrors,
 * UnconfirmedSignUpCleanupCapReached), plus UnconfirmedSignUpsSkipped by Reason. Nothing at all while off. A step
 * that throws anyway (a bug) still counts: the handler reports it with unconfirmedCleanupFailure (errors 1,
 * stepFailed, and an UnconfirmedSignUpCleanupErrors line).
 *
 * What the apps see once a sign-up is deleted (the app client has PreventUserExistenceErrors ENABLED): sign-in
 * fails like a wrong password; Create account with the email works again; on a code step still open, Confirm
 * fails as a wrong or expired code and Resend answers as if a code was sent (Cognito does not report
 * UserNotFoundException to these calls). docs/RUNBOOK.md 8.2.
 */

export const UNCONFIRMED_CLEANUP_MODES = ["off", "dry_run", "delete"] as const;
export type UnconfirmedCleanupMode = (typeof UNCONFIRMED_CLEANUP_MODES)[number];

export const DEFAULT_MAX_AGE_HOURS = UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS;
/** A confirmation code lives 24 hours; a sign-up is never deleted younger than that. */
export const MIN_MAX_AGE_HOURS = 24;
export const DEFAULT_MAX_DELETIONS_PER_RUN = UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN;
const LIST_USERS_PAGE_SIZE = 60;
/** 6,000 unconfirmed users; more are left for later runs (listingTruncated). */
export const LIST_USERS_MAX_PAGES = 100;
const UNCONFIRMED_FILTER = 'cognito:user_status = "UNCONFIRMED"';
const MS_PER_HOUR = 60 * 60 * 1000;

/** Attempts per call (the first included) while Cognito or DynamoDB throttles. */
export const THROTTLE_ATTEMPTS = 5;
const THROTTLE_BACKOFF = { baseMs: 250, maxMs: 5_000 };
const THROTTLE_ERRORS = new Set([
  "TooManyRequestsException",
  "ThrottlingException",
  "LimitExceededException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
]);

export const UNCONFIRMED_METRICS_NAMESPACE = "BillBoard/Accounts";

/** Why a listed or rechecked user was kept. Every reason is emitted each run, 0 included. */
export const SKIP_REASONS = [
  "probe",
  "projectDomain",
  "disabled",
  "notUnconfirmed",
  "unknownAge",
  "hasAppData",
  "changed",
  "gone",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface UnconfirmedCleanupConfig {
  mode: UnconfirmedCleanupMode;
  /** A value of UNCONFIRMED_SIGNUP_CLEANUP_MODE that is not a mode (the run is then off). */
  ignoredModeValue?: string;
  maxAgeHours: number;
  maxPerRun: number;
  probeAddress: SignUpFilterCheckAddress | null;
}

type Env = Record<string, string | undefined>;

function numberFromEnv(env: Env, name: string, fallback: number, isValid: (value: number) => boolean): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && isValid(parsed)) return parsed;
  console.warn(`Ignoring invalid ${name}`, { value: raw, fallback });
  return fallback;
}

/** The mode alone (any value it does not know is off, and is named). */
export function unconfirmedCleanupModeFromEnv(
  env: Env = process.env,
): Pick<UnconfirmedCleanupConfig, "mode" | "ignoredModeValue"> {
  const raw = (env.UNCONFIRMED_SIGNUP_CLEANUP_MODE ?? "").trim().toLowerCase();
  const known = (UNCONFIRMED_CLEANUP_MODES as readonly string[]).includes(raw);
  return {
    mode: known ? (raw as UnconfirmedCleanupMode) : "off",
    ...(raw && !known ? { ignoredModeValue: raw.slice(0, 32) } : {}),
  };
}

export function unconfirmedCleanupConfigFromEnv(env: Env = process.env): UnconfirmedCleanupConfig {
  return {
    ...unconfirmedCleanupModeFromEnv(env),
    maxAgeHours: numberFromEnv(
      env,
      "UNCONFIRMED_SIGNUP_MAX_AGE_HOURS",
      DEFAULT_MAX_AGE_HOURS,
      (value) => value >= MIN_MAX_AGE_HOURS,
    ),
    maxPerRun: numberFromEnv(
      env,
      "UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN",
      DEFAULT_MAX_DELETIONS_PER_RUN,
      (value) => Number.isInteger(value) && value >= 0,
    ),
    probeAddress: signUpFilterCheckAddress(env as NodeJS.ProcessEnv),
  };
}

export interface UnconfirmedCleanupDeps {
  cognito: Pick<CognitoIdentityProviderClient, "send">;
  /** The tables (UserPII, the user tables, SignUpEmailClaims) and the clients countUserData reads with. */
  deletion: AccountDeletionContext;
  userPoolId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface UnconfirmedCleanupSummary {
  mode: UnconfirmedCleanupMode;
  ignoredModeValue?: string;
  maxAgeHours: number;
  maxPerRun: number;
  /** UNCONFIRMED users ListUsers returned. */
  listed?: number;
  /** More than LIST_USERS_MAX_PAGES pages: the rest are left for later runs. */
  listingTruncated?: boolean;
  /** Unconfirmed self sign-ups (probes and the project's domain left out) younger than maxAgeHours. */
  pending?: number;
  /** Unconfirmed longer than maxAgeHours and not kept by the listing: the candidates. */
  expired?: number;
  /** Candidates left for the next run by maxPerRun, or by throttling. */
  deferred?: number;
  /** More candidates than maxPerRun, or a truncated listing (UnconfirmedSignUpCleanupCapReached). */
  capReached?: boolean;
  /** delete: Cognito users deleted. */
  deleted?: number;
  /** dry_run: candidates that passed every check. */
  wouldDelete?: number;
  /** delete: SignUpEmailClaims items deleted; dry_run: the items a deletion would remove. */
  emailClaimItems?: number;
  skipped?: Record<SkipReason, number>;
  /** Subs of users kept because they hold app data (an unconfirmed user should hold none: look at each). */
  keptWithAppData?: string[];
  errors?: number;
  /** Error names, no messages (a message could quote an address). */
  errorNames?: string[];
  /** Calls retried after throttling. */
  throttleRetries?: number;
  /** The run stopped early because Cognito or DynamoDB kept throttling. */
  stoppedByThrottling?: boolean;
  /** The oldest candidate's age in hours (null without candidates). */
  oldestExpiredHours?: number | null;
  /** The step stopped on an error it does not expect (a bug); its counts are lost, errorNames has the name. */
  stepFailed?: true;
}

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error === "object" && error !== null ? "Object" : typeof error;

export const isThrottle = (error: unknown): boolean => THROTTLE_ERRORS.has(errorName(error));

const attributeOf = (attributes: AttributeType[] | undefined, name: string): string | undefined =>
  attributes?.find((attribute) => attribute.Name === name)?.Value?.trim() || undefined;

interface ListedUser {
  username: string;
  sub: string;
  email: string | undefined;
  status: string | undefined;
  enabled: boolean;
  createdAt: number | undefined;
}

function toListedUser(user: {
  Username?: string;
  Attributes?: AttributeType[];
  UserAttributes?: AttributeType[];
  UserStatus?: string;
  Enabled?: boolean;
  UserCreateDate?: Date;
}): ListedUser | null {
  const username = user.Username?.trim();
  if (!username) return null;
  const attributes = user.Attributes ?? user.UserAttributes;
  const created = user.UserCreateDate instanceof Date ? user.UserCreateDate.getTime() : Number.NaN;
  return {
    username,
    sub: attributeOf(attributes, "sub") ?? username,
    email: attributeOf(attributes, "email"),
    status: user.UserStatus,
    // ListUsers and AdminGetUser always return Enabled; a missing value is read as disabled (kept).
    enabled: user.Enabled === true,
    createdAt: Number.isFinite(created) ? created : undefined,
  };
}

type Classification = "candidate" | "pending" | SkipReason;

function classify(user: ListedUser, config: UnconfirmedCleanupConfig, nowMs: number): Classification {
  if (user.status !== "UNCONFIRMED") return "notUnconfirmed";
  if (probeKindOf(user.email, config.probeAddress)) return "probe";
  if (parseEmailAddress(user.email)?.domain === PROJECT_EMAIL_DOMAIN) return "projectDomain";
  if (!user.enabled) return "disabled";
  if (user.createdAt === undefined) return "unknownAge";
  return nowMs - user.createdAt > config.maxAgeHours * MS_PER_HOUR ? "candidate" : "pending";
}

const emptySkipped = (): Record<SkipReason, number> =>
  Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<SkipReason, number>;

class Throttled extends Error {
  constructor(readonly lastError: unknown) {
    super("Still throttled after retries");
    this.name = "Throttled";
  }
}

/**
 * Runs the unconfirmed sign-up step. Never throws: a failure is counted in `errors` (and emitted as
 * UnconfirmedSignUpCleanupErrors), so the rest of the cleanup's run and its report are unaffected.
 */
export async function cleanupUnconfirmedSignUps(
  config: UnconfirmedCleanupConfig,
  deps: UnconfirmedCleanupDeps,
): Promise<UnconfirmedCleanupSummary> {
  const base = {
    mode: config.mode,
    ...(config.ignoredModeValue ? { ignoredModeValue: config.ignoredModeValue } : {}),
    maxAgeHours: config.maxAgeHours,
    maxPerRun: config.maxPerRun,
  };
  if (config.mode === "off") return base;

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const dryRun = config.mode === "dry_run";
  const nowMs = now();

  const skipped = emptySkipped();
  const keptWithAppData: string[] = [];
  const errorNames = new Set<string>();
  let errors = 0;
  let throttleRetries = 0;
  let stoppedByThrottling = false;
  let listed = 0;
  let listingTruncated = false;
  let pending = 0;
  let deleted = 0;
  let wouldDelete = 0;
  let emailClaimItems = 0;
  const candidates: ListedUser[] = [];

  const recordError = (error: unknown): void => {
    errors += 1;
    errorNames.add(error instanceof Throttled ? errorName(error.lastError) : errorName(error));
  };

  /** Retries `work` while it is throttled; throws Throttled when it still is after THROTTLE_ATTEMPTS. */
  const withRetry = async <T>(work: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (!isThrottle(error)) throw error;
        if (attempt + 1 >= THROTTLE_ATTEMPTS) throw new Throttled(error);
        throttleRetries += 1;
        await sleep(backoffDelayMs(attempt, { ...THROTTLE_BACKOFF, random }));
      }
    }
  };

  // 1. List the UNCONFIRMED users.
  try {
    let paginationToken: string | undefined;
    let pages = 0;
    do {
      const token = paginationToken;
      const response = (await withRetry(() =>
        deps.cognito.send(
          new ListUsersCommand({
            UserPoolId: deps.userPoolId,
            Filter: UNCONFIRMED_FILTER,
            AttributesToGet: ["sub", "email"],
            Limit: LIST_USERS_PAGE_SIZE,
            PaginationToken: token,
          }),
        ),
      )) as { Users?: UserType[]; PaginationToken?: string };
      pages += 1;
      for (const raw of response.Users ?? []) {
        const user = toListedUser(raw);
        if (!user) continue;
        listed += 1;
        // 2. Classify.
        const verdict = classify(user, config, nowMs);
        if (verdict === "candidate") candidates.push(user);
        else if (verdict === "pending") pending += 1;
        else skipped[verdict] += 1;
      }
      paginationToken = response.PaginationToken;
    } while (paginationToken && pages < LIST_USERS_MAX_PAGES);
    listingTruncated = Boolean(paginationToken);
  } catch (error) {
    recordError(error);
    stoppedByThrottling = error instanceof Throttled;
  }

  // Oldest first, so a capped run always removes the longest-stranded sign-ups.
  candidates.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.sub.localeCompare(right.sub));
  const batch = candidates.slice(0, config.maxPerRun);
  let deferred = candidates.length - batch.length;
  const { config: tables, db } = deps.deletion;

  /** App data under the sub: the UserPII row, then what a deletion would remove besides the email claim. */
  const appDataOf = async (user: ListedUser): Promise<{ appData: number; emailClaims: number }> => {
    const pii = await db.send(
      new GetItemCommand({
        TableName: tables.pii.tableName,
        Key: { [tables.pii.partitionKey]: { S: user.sub } },
        ConsistentRead: true,
        ProjectionExpression: "#pk",
        ExpressionAttributeNames: { "#pk": tables.pii.partitionKey },
      }),
    );
    const counts = await countUserData(deps.deletion, user.sub, { cognitoUserName: user.username });
    const appData =
      (pii.Item ? 1 : 0) +
      counts.feedback +
      counts.preferences +
      counts.devices +
      counts.weeklyDigests +
      (counts.addressClaims ?? 0) +
      (counts.appAttestBindings ?? 0);
    return { appData, emailClaims: counts.emailClaims ?? 0 };
  };

  /** AdminGetUser, or null when the user is gone. */
  const getUser = async (username: string): Promise<ListedUser | null> => {
    try {
      const user = await deps.cognito.send(
        new AdminGetUserCommand({ UserPoolId: deps.userPoolId, Username: username }),
      );
      return toListedUser(user as Parameters<typeof toListedUser>[0]);
    } catch (error) {
      if (errorName(error) === "UserNotFoundException") return null;
      throw error;
    }
  };

  for (let index = 0; index < batch.length; index += 1) {
    const candidate = batch[index];
    try {
      // 3a. App data, read only.
      const data = await withRetry(() => appDataOf(candidate));
      if (data.appData > 0) {
        skipped.hasAppData += 1;
        keptWithAppData.push(candidate.sub);
        continue;
      }

      // 3b. The guard, right before any write.
      const current = await withRetry(() => getUser(candidate.username));
      if (!current) {
        skipped.gone += 1;
        continue;
      }
      const verdict = current.sub === candidate.sub ? classify(current, config, now()) : "changed";
      if (verdict !== "candidate") {
        skipped[verdict === "pending" ? "changed" : verdict] += 1;
        continue;
      }

      if (dryRun) {
        wouldDelete += 1;
        emailClaimItems += data.emailClaims;
        continue;
      }

      // 3c. The email claim, then the user.
      if (tables.signUpEmailClaims) {
        const tableName = tables.signUpEmailClaims.tableName;
        const claim = await withRetry(() => deleteUserEmailClaim({ db, tableName }, candidate.username));
        emailClaimItems += claim.deleted;
      }
      await withRetry(async () => {
        try {
          await deps.cognito.send(
            new AdminDeleteUserCommand({ UserPoolId: deps.userPoolId, Username: candidate.username }),
          );
        } catch (error) {
          if (errorName(error) !== "UserNotFoundException") throw error;
        }
      });
      deleted += 1;
    } catch (error) {
      recordError(error);
      if (error instanceof Throttled) {
        // Cognito or DynamoDB is still throttling: leave the rest for the next run.
        stoppedByThrottling = true;
        deferred += batch.length - index - 1;
        break;
      }
    }
  }

  const oldest = candidates[0]?.createdAt;
  const summary: UnconfirmedCleanupSummary = {
    ...base,
    listed,
    listingTruncated,
    pending,
    expired: candidates.length,
    deferred,
    capReached: candidates.length > config.maxPerRun || listingTruncated,
    ...(dryRun ? { wouldDelete } : { deleted }),
    emailClaimItems,
    skipped,
    keptWithAppData,
    errors,
    errorNames: [...errorNames].sort(),
    throttleRetries,
    stoppedByThrottling,
    oldestExpiredHours: oldest === undefined ? null : Math.round(((nowMs - oldest) / MS_PER_HOUR) * 10) / 10,
  };
  emitUnconfirmedCleanupMetrics(summary);
  return summary;
}

/**
 * The block of a step that threw instead of returning (cleanupUnconfirmedSignUps catches every failure it expects,
 * so this is a bug, or the configuration could not be read), with an UnconfirmedSignUpCleanupErrors line of 1, so
 * Billboard-Accounts-UnconfirmedSignUpCleanupErrors sees it like any other failure. Nothing is emitted while the
 * mode is off.
 */
export function unconfirmedCleanupFailure(
  config: UnconfirmedCleanupConfig | undefined,
  error: unknown,
  env: Env = process.env,
): UnconfirmedCleanupSummary {
  const summary: UnconfirmedCleanupSummary = {
    ...(config
      ? { mode: config.mode, ...(config.ignoredModeValue ? { ignoredModeValue: config.ignoredModeValue } : {}) }
      : unconfirmedCleanupModeFromEnv(env)),
    maxAgeHours: config?.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS,
    maxPerRun: config?.maxPerRun ?? DEFAULT_MAX_DELETIONS_PER_RUN,
  };
  if (summary.mode === "off") return summary;
  Object.assign(summary, { errors: 1, errorNames: [errorName(error)], stepFailed: true });
  // emitEmbeddedMetrics never throws.
  emitEmbeddedMetrics(UNCONFIRMED_METRICS_NAMESPACE, [{ name: "UnconfirmedSignUpCleanupErrors", value: 1 }], {
    properties: { step: "unconfirmedSignUps", mode: summary.mode, stepFailed: true },
  });
  return summary;
}

/** One EMF line without dimensions, then UnconfirmedSignUpsSkipped by Reason (every reason, 0 included). */
function emitUnconfirmedCleanupMetrics(summary: UnconfirmedCleanupSummary): void {
  const properties = {
    step: "unconfirmedSignUps",
    mode: summary.mode,
    maxAgeHours: summary.maxAgeHours,
    maxPerRun: summary.maxPerRun,
    deferred: summary.deferred,
    listingTruncated: summary.listingTruncated,
    stoppedByThrottling: summary.stoppedByThrottling,
  };
  emitEmbeddedMetrics(
    UNCONFIRMED_METRICS_NAMESPACE,
    [
      { name: "UnconfirmedSignUpsDeleted", value: summary.deleted ?? 0 },
      { name: "UnconfirmedSignUpsExpired", value: summary.expired ?? 0 },
      { name: "UnconfirmedSignUpsPending", value: summary.pending ?? 0 },
      { name: "UnconfirmedSignUpCleanupErrors", value: summary.errors ?? 0 },
      { name: "UnconfirmedSignUpCleanupCapReached", value: summary.capReached ? 1 : 0 },
    ],
    { properties },
  );
  for (const reason of SKIP_REASONS) {
    emitEmbeddedMetrics(
      UNCONFIRMED_METRICS_NAMESPACE,
      [{ name: "UnconfirmedSignUpsSkipped", value: summary.skipped?.[reason] ?? 0 }],
      { dimensions: { Reason: reason }, properties: { step: "unconfirmedSignUps", mode: summary.mode } },
    );
  }
}
