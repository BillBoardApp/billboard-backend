import { SignUpCommand } from "@aws-sdk/client-cognito-identity-provider";

import { PROBE_TOKEN_METADATA_KEY } from "../../shared/signUpProbeToken";

import { SIGNUP_EMAIL_CLAIM_KEYS } from "../../shared/signUpEmailClaims";
import {
  DISPOSABLE_EMAIL_MESSAGE,
  EMAIL_VARIANT_MESSAGE,
  EMAIL_VARIANT_REASON,
  PENDING_CLAIM_WINDOW_MS,
  UNCONFIRMED_CLAIM_LIFETIME_MS,
  emailClaimNames,
  isProbeAddress,
  readEmailClaim,
  refusalMessageOf,
  type ProbeKind,
  type SignUpProbeRecord,
} from "../../shared/signUpFilter";
import {
  CLOCK_SKEW_MS,
  LEFTOVER_MIN_AGE_MS,
  MIN_TIME_FOR_SIGN_UP_MS,
  OWN_ACCOUNT_SLACK_MS,
  Tally,
  Verdict,
  errorName,
  getClaimItem,
  getUser,
  readProbeRecord,
  removeProbeSubject,
  type CheckConfig,
  type CheckDeps,
  type Context,
  type FilterMode,
  type Outcome,
  type ProbeSubject,
  type Stage,
} from "./common";
import { sweep } from "./sweep";

/**
 * One run of the sign-up filter check (CB-07, RUNBOOK 14.12): proves in production, through the same public
 * Cognito SignUp the app uses, that PreSignUpCheck allows and claims a fresh base address and records a hit
 * for a +tag of it, then removes everything it created.
 *
 * 1. The sweep (sweep.ts).
 * 2. Base: SignUp <check address>. PreSignUpCheck must allow it, claim it (claimed, renewed, retried or
 *    taken_over; USER#<sub> and EMAIL#<key> naming the new account) and write PROBE#base naming it, all before
 *    SignUp returns.
 * 3. +tag: only once PROBE#base proved a probe-aware filter handled step 2. SignUp <local>+<runTag>@<domain>.
 *    In the mode the filter reported: under watch it is created and PROBE#variant shows emailBase's hit (no
 *    claim written, EMAIL#<key> unchanged); under enforce SignUp fails with exactly the filter's variant message.
 * 4. Cleanup, always: every account and item this run created, through the guarded chain (common.ts).
 * 5. Nothing left: AdminGetUser and GetItem on all of it.
 *
 * Every decision comes from strongly consistent reads and the synchronous SignUp result; no metric or log is
 * read. Known problems are reported, never thrown; an unexpected exception is the fail internal_error.
 */

export interface CheckResult {
  action: "run" | "sweep";
  outcome: Outcome;
  reason?: string;
  /** Where the reason was found. */
  stage: Stage;
  expectedMode: FilterMode;
  observedMode?: FilterMode;
  runTag?: string;
  /** Accounts this run created. */
  signUps: number;
  durationMs: number;
  usersDeleted: number;
  claimItemsDeleted: number;
  recordsDeleted: number;
  swept: number;
  refused: number;
  /** Accounts and items still there after cleanup (0 when clean). */
  remaining: number;
  /** The name of an unexpected error (internal_error), never its message. */
  errorName?: string;
}

const EMAIL_CHECKS = new Set(["disposableDomain", "emailBase"]);
/** emailBase's outcomes that claim the base address for the sign-up ("retried": a retry of the same address). */
const CLAIM_OUTCOMES = new Set(["claimed", "renewed", "retried", "taken_over"]);
/** App Attest and DeviceCheck refuse with a bare code (APP_UPDATE_REQUIRED, DEVICE_ACCOUNT_LIMIT, ...). */
const BARE_CODE = /^[A-Z][A-Z0-9_]+$/;
const PASSWORD_SYMBOLS = "!#%*+-=?^_~";

/** "r", the UTC date and 4 random base36 characters: r20261016k3x9. Matches RUN_TAG_PATTERN. */
export const makeRunTag = (now: number, randomBytes: (size: number) => Buffer): string => {
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = [...randomBytes(4)].map((byte) => (byte % 36).toString(36)).join("");
  return `r${date}${suffix}`;
};

/**
 * A random 24-character password with an upper-case letter, a lower-case letter, a digit and a symbol, which
 * meets the pool's policy (8 or more, all four kinds). Never logged; the account is deleted minutes later.
 */
export const generatePassword = (randomBytes: (size: number) => Buffer): string => {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", PASSWORD_SYMBOLS];
  const all = sets.join("");
  const bytes = randomBytes(48);
  const characters = sets.map((set, index) => set[bytes[index] % set.length]);
  for (let index = sets.length; index < 24; index += 1) characters.push(all[bytes[index] % all.length]);
  // Shuffle so the four required kinds are not always first.
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swap = bytes[24 + index] % (index + 1);
    [characters[index], characters[swap]] = [characters[swap], characters[index]];
  }
  return characters.join("");
};

type SignUpAttempt =
  | { kind: "created"; sub: string }
  | { kind: "refused"; refusal: string | null }
  | { kind: "exists" }
  | { kind: "limited"; errorName: string }
  | { kind: "password" }
  | { kind: "error"; errorName: string };

const LIMIT_ERRORS = new Set(["TooManyRequestsException", "LimitExceededException", "CodeDeliveryFailureException"]);

/**
 * SignUp as the app does: the app client, the address as username, only the email attribute and a random password.
 * Its only ClientMetadata is the probe token (INF-15), which the filter needs to treat the sign-up as the probe and
 * which no client can know. No App Attest or app version metadata, ValidationData or SecretHash, so App Attest sees an
 * old build ("missing"). Never retried.
 */
const attemptSignUp = async (ctx: Context, address: string): Promise<SignUpAttempt> => {
  try {
    const response = (await ctx.deps.signUp.send(
      new SignUpCommand({
        ClientId: ctx.config.clientId,
        Username: address,
        Password: generatePassword(ctx.deps.randomBytes),
        UserAttributes: [{ Name: "email", Value: address }],
        ClientMetadata: { [PROBE_TOKEN_METADATA_KEY]: ctx.config.probeToken },
      }),
    )) as { UserSub?: string };
    return response.UserSub ? { kind: "created", sub: response.UserSub } : { kind: "error", errorName: "NoUserSub" };
  } catch (error) {
    const name = errorName(error);
    if (name === "UserLambdaValidationException") {
      return { kind: "refused", refusal: refusalMessageOf((error as Error).message) };
    }
    if (name === "UsernameExistsException") return { kind: "exists" };
    if (LIMIT_ERRORS.has(name)) return { kind: "limited", errorName: name };
    if (name === "InvalidPasswordException") return { kind: "password" };
    return { kind: "error", errorName: name };
  }
};

export const runCheck = async (config: CheckConfig, deps: CheckDeps): Promise<CheckResult> => {
  const startedAt = deps.now();
  const ctx: Context = { config, deps, verdict: new Verdict(), tally: new Tally() };
  const { verdict, tally } = ctx;
  const runTag = makeRunTag(startedAt, deps.randomBytes);
  const variantAddress = `${config.check.local}+${runTag}@${config.check.domain}`;
  /** Accounts (and claim chains) to remove, in the order found; cleanup goes newest first. */
  const subjects: ProbeSubject[] = [];
  /** Email keys whose EMAIL# item must not name a subject after cleanup. */
  const emailKeys = new Set<string>();
  let observedMode: FilterMode | undefined;
  let signUps = 0;
  let baseSub: string | undefined;
  let baseEmailKey: string | undefined;
  let unexpected: string | undefined;

  const addSubject = (subject: ProbeSubject): void => {
    if (!subjects.some((existing) => existing.sub === subject.sub)) subjects.push(subject);
  };
  const timeLeft = (): boolean => deps.timeLeftMs() >= MIN_TIME_FOR_SIGN_UP_MS;
  const isRecent = (record: SignUpProbeRecord, callStart: number): boolean =>
    Date.parse(record.at) >= callStart - CLOCK_SKEW_MS;

  /**
   * After a sign-up that created no account we know of: the account or the claim items the trigger may still
   * have made. Only what this sign-up can have made is taken, so another sign-up's (a stranger's, or a run
   * that overlapped despite reserved concurrency 1) never is:
   * - "refused" (the trigger threw, UserLambdaValidationException): Cognito created no account, so nothing at
   *   the address is this run's. PROBE#<kind> is this run's only as a rejection (the trigger writes it just
   *   before it throws), recent, and for the variant with this run's tag.
   * - "ambiguous" (a limit, a password or another error, where Cognito may have run the trigger and even
   *   created the account): PROBE#<kind> as an allowed sign-up, recent (and the tag), and an account at the
   *   exact address created after the call started.
   */
  const locate = async (
    kind: ProbeKind,
    address: string,
    callStart: number,
    how: "refused" | "ambiguous",
  ): Promise<void> => {
    const record = await readProbeRecord(ctx, kind);
    const outcome = how === "refused" ? "rejected" : "allowed";
    if (
      record &&
      record.outcome === outcome &&
      isRecent(record, callStart) &&
      (kind === "base" || record.tag === runTag)
    ) {
      addSubject({ sub: record.userName, kind, createdAtLeast: callStart - OWN_ACCOUNT_SLACK_MS, deleteRecord: true });
    }
    if (how === "refused") return;
    const account = await getUser(ctx, address);
    if (account?.username && (account.createdAt ?? 0) >= callStart - OWN_ACCOUNT_SLACK_MS) {
      addSubject({ sub: account.username, kind, createdAtLeast: callStart - OWN_ACCOUNT_SLACK_MS, deleteRecord: true });
    }
  };

  /** A sign-up that did not create an account: the reason, and what it may have left behind. */
  const notCreated = async (
    attempt: Exclude<SignUpAttempt, { kind: "created" }>,
    kind: ProbeKind,
    address: string,
    callStart: number,
  ): Promise<void> => {
    switch (attempt.kind) {
      case "exists":
        // Never deleted here: the sweep removes it once it is 15 minutes old.
        verdict.inconclusive("leftover_exists");
        return;
      case "limited":
        verdict.inconclusive("cognito_limit");
        break;
      case "password":
        verdict.fail("password_policy");
        break;
      case "error":
        verdict.fail("signup_error");
        break;
      case "refused":
        if (attempt.refusal !== null && BARE_CODE.test(attempt.refusal)) verdict.inconclusive("blocked_by_app_attest");
        break;
    }
    await locate(kind, address, callStart, attempt.kind === "refused" ? "refused" : "ambiguous");
  };

  /**
   * The base address was refused (enforce) or hit (watch). Only a probe-address account can hold a probe's
   * base address, so this is usually a leftover the sweep could not see; the filter is at fault only when
   * the holder it names should not hold the address any more, or it names none.
   */
  const classifyHolder = async (record: SignUpProbeRecord | null): Promise<void> => {
    const holder = record?.holder;
    if (!holder) {
      verdict.fail("base_rejected");
      return;
    }
    const now = deps.now();
    const account = await getUser(ctx, holder);
    if (!account) {
      // A holder Cognito cannot find holds the address only while its claim is pending (PENDING_CLAIM_WINDOW_MS):
      // the EMAIL# item still records it, as its userName or one of its holders, with a recent claimedAt.
      const userItem = await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.userItem(holder));
      const emailKey = userItem?.emailKey?.S;
      const emailItem = emailKey ? await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.emailItem(emailKey)) : undefined;
      const claim = readEmailClaim(emailItem);
      const claimedAt = Date.parse(claim && Object.hasOwn(claim.holders, holder) ? claim.holders[holder] : "");
      if (Number.isFinite(claimedAt) && now - claimedAt < PENDING_CLAIM_WINDOW_MS) {
        verdict.inconclusive("base_claim_pending");
      } else {
        verdict.fail("base_rejected");
      }
      return;
    }
    if (!isProbeAddress(account.email, config.check)) {
      verdict.fail("base_rejected");
      return;
    }
    if (account.status !== "UNCONFIRMED") {
      verdict.fail("probe_address_confirmed");
      return;
    }
    const age = now - (account.createdAt ?? now);
    if (age >= UNCONFIRMED_CLAIM_LIFETIME_MS) {
      // An abandoned UNCONFIRMED sign-up no longer holds its address: the filter should have taken it over.
      verdict.fail("base_rejected");
      return;
    }
    if (age < LEFTOVER_MIN_AGE_MS) {
      verdict.inconclusive("busy");
      return;
    }
    const removal = await removeProbeSubject(ctx, {
      sub: holder,
      kind: "base",
      createdAtMost: now - LEFTOVER_MIN_AGE_MS,
      leftover: true,
    });
    if (removal.status === "removed") verdict.inconclusive("leftover_holder");
    else verdict.fail(removal.status === "refused" ? "refused_delete" : "cleanup_incomplete");
  };

  /** A take-over: the former holder's leftovers (its USER# item, or its abandoned account) go now. */
  const removeFormerHolder = async (holder: string): Promise<void> => {
    const removal = await removeProbeSubject(ctx, {
      sub: holder,
      kind: "base",
      createdAtMost: deps.now() - LEFTOVER_MIN_AGE_MS,
      leftover: true,
    });
    if (removal.status === "refused") verdict.fail("refused_delete");
    else if (removal.status === "incomplete") verdict.fail("cleanup_incomplete");
  };

  /** Step 2. Returns whether the +tag step may run. */
  const baseStep = async (): Promise<boolean> => {
    verdict.current = "base";
    const callStart = deps.now();
    const attempt = await attemptSignUp(ctx, config.check.address);
    if (attempt.kind !== "created") {
      if (attempt.kind === "refused" && attempt.refusal !== null && !BARE_CODE.test(attempt.refusal)) {
        // Refused by the filter itself: the base address is held (variant message), or worse.
        if (attempt.refusal === EMAIL_VARIANT_MESSAGE) {
          const record = await readProbeRecord(ctx, "base");
          const recent = record && isRecent(record, callStart) ? record : null;
          // This refusal's own record is a rejection. A recent allowed one is another probe sign-up's, written
          // over this one's: that sign-up is in progress.
          if (recent && recent.outcome !== "rejected") verdict.inconclusive("busy");
          else await classifyHolder(recent);
        } else if (attempt.refusal === DISPOSABLE_EMAIL_MESSAGE) verdict.fail("base_rejected");
        else verdict.fail("signup_error");
      } else if (attempt.kind === "refused" && attempt.refusal === null) {
        verdict.fail("signup_error");
      }
      await notCreated(attempt, "base", config.check.address, callStart);
      return false;
    }
    signUps += 1;
    baseSub = attempt.sub;
    addSubject({ sub: attempt.sub, kind: "base", deleteRecord: true });

    const record = await readProbeRecord(ctx, "base");
    const userItem = await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.userItem(attempt.sub));
    if (!record || record.userName !== attempt.sub || !isRecent(record, callStart)) {
      // No record for this sign-up: no trigger ran (no claim either), or one that does not know the probe
      // address did. The +tag step would then emit a real SignUpFilterHit, so it does not run.
      if (userItem) verdict.inconclusive("probe_record_missing");
      else verdict.fail("filter_silent");
      return false;
    }
    observedMode = record.mode;
    if (record.mode !== config.expectedMode) verdict.inconclusive("mode_mismatch");

    const entry = (check: string) => record.checks.find((item) => item.check === check && item.phase === undefined);
    if (record.checks.some((item) => EMAIL_CHECKS.has(item.check) && item.result === "error")) {
      verdict.fail("base_check_error");
      return false;
    }
    if (entry("disposableDomain")?.result === "hit") {
      verdict.fail("base_rejected");
      return false;
    }
    const emailBase = entry("emailBase");
    if (emailBase?.result === "hit") {
      await classifyHolder(record);
      return false;
    }
    if (emailBase?.result !== "allow" || !CLAIM_OUTCOMES.has(emailBase.claim ?? "")) {
      verdict.fail("base_claim_missing");
      return false;
    }
    if (emailBase.claim === "taken_over" && record.holder) await removeFormerHolder(record.holder);

    const emailKey = userItem?.emailKey?.S;
    if (!emailKey) {
      verdict.fail("base_claim_missing");
      return false;
    }
    baseEmailKey = emailKey;
    emailKeys.add(emailKey);
    // The item names the account as its userName or, after a sign-up of the same address raced it, one of its
    // holders.
    const emailItem = await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.emailItem(emailKey));
    if (!emailClaimNames(emailItem, attempt.sub)) {
      verdict.fail("base_claim_missing");
      return false;
    }
    return !verdict.failed;
  };

  /** Whether EMAIL#<key> still names the base account (as its userName or one of its holders). */
  const baseClaimIntact = async (): Promise<boolean> =>
    baseEmailKey !== undefined &&
    baseSub !== undefined &&
    emailClaimNames(await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.emailItem(baseEmailKey)), baseSub);

  /** Step 3, judged in the mode the filter reported for the base sign-up. */
  const variantStep = async (mode: FilterMode): Promise<void> => {
    verdict.current = "variant";
    const callStart = deps.now();
    const attempt = await attemptSignUp(ctx, variantAddress);
    const emailEntries = (record: SignUpProbeRecord) => record.checks.filter((item) => EMAIL_CHECKS.has(item.check));
    const emailBaseOf = (record: SignUpProbeRecord) =>
      record.checks.find((item) => item.check === "emailBase" && item.phase === undefined);
    const ownRecord = (record: SignUpProbeRecord | null): record is SignUpProbeRecord =>
      record !== null && record.tag === runTag && isRecent(record, callStart);

    if (mode === "watch") {
      if (attempt.kind !== "created") {
        if (attempt.kind === "refused" && attempt.refusal === EMAIL_VARIANT_MESSAGE) {
          verdict.inconclusive("mode_mismatch");
        } else if (attempt.kind === "refused" && (attempt.refusal === null || !BARE_CODE.test(attempt.refusal))) {
          verdict.fail("variant_wrong_refusal");
        }
        await notCreated(attempt, "variant", variantAddress, callStart);
        return;
      }
      signUps += 1;
      addSubject({ sub: attempt.sub, kind: "variant", deleteRecord: true });
      const record = await readProbeRecord(ctx, "variant");
      if (!ownRecord(record) || record.userName !== attempt.sub) {
        verdict.inconclusive("probe_record_missing");
        return;
      }
      if (record.mode !== mode) {
        verdict.inconclusive("mode_mismatch");
        return;
      }
      if (emailEntries(record).some((item) => item.result === "error")) {
        verdict.fail("variant_check_error");
        return;
      }
      const emailBase = emailBaseOf(record);
      if (emailBase?.result !== "hit" || emailBase.reason !== EMAIL_VARIANT_REASON) {
        verdict.fail("variant_not_detected");
        return;
      }
      // A hit writes nothing: no claim for the +tag account, and the base claim untouched.
      const userItem = await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.userItem(attempt.sub));
      if (userItem || !(await baseClaimIntact())) verdict.fail("claim_disturbed");
      return;
    }

    // enforce
    if (attempt.kind === "created") {
      signUps += 1;
      addSubject({ sub: attempt.sub, kind: "variant", deleteRecord: true });
      verdict.fail("variant_not_refused");
      return;
    }
    if (attempt.kind !== "refused" || attempt.refusal !== EMAIL_VARIANT_MESSAGE) {
      if (attempt.kind === "refused" && (attempt.refusal === null || !BARE_CODE.test(attempt.refusal))) {
        verdict.fail("variant_wrong_refusal");
      }
      await notCreated(attempt, "variant", variantAddress, callStart);
      return;
    }
    await locate("variant", variantAddress, callStart, "refused");
    const record = await readProbeRecord(ctx, "variant");
    if (!ownRecord(record)) {
      verdict.inconclusive("probe_record_missing");
      return;
    }
    if (record.mode !== mode) {
      verdict.inconclusive("mode_mismatch");
      return;
    }
    if (emailEntries(record).some((item) => item.result === "error")) {
      verdict.fail("variant_check_error");
      return;
    }
    if (record.outcome !== "rejected" || record.rejectedBy !== "emailBase" || record.reason !== EMAIL_VARIANT_REASON) {
      verdict.fail("variant_wrong_refusal");
      return;
    }
    const account = await getUser(ctx, variantAddress);
    if (account) {
      if (account.username)
        addSubject({ sub: account.username, kind: "variant", createdAtLeast: callStart - OWN_ACCOUNT_SLACK_MS });
      verdict.fail("variant_not_refused");
      return;
    }
    if (!(await baseClaimIntact())) verdict.fail("claim_disturbed");
  };

  try {
    verdict.current = "sweep";
    const proceed = await sweep(ctx);
    verdict.current = "base";
    if (proceed && !timeLeft()) verdict.inconclusive("deadline");
    else if (proceed && (await baseStep())) {
      verdict.current = "variant";
      if (!timeLeft()) verdict.inconclusive("deadline");
      else await variantStep(observedMode ?? config.expectedMode);
    }
  } catch (error) {
    unexpected = errorName(error);
    verdict.fail("internal_error");
  }

  // Cleanup, on every path: newest subject first.
  verdict.current = "cleanup";
  for (const subject of [...subjects].reverse()) {
    try {
      const removal = await removeProbeSubject(ctx, subject);
      if (removal.status !== "refused" && removal.emailKey) emailKeys.add(removal.emailKey);
      if (removal.status === "refused") verdict.fail("refused_delete");
    } catch {
      tally.incomplete += 1;
    }
  }

  // Nothing left: every subject's account and USER# item gone, and no EMAIL# item naming one (userName or holders).
  let remaining = 0;
  for (const subject of subjects) {
    try {
      if (await getUser(ctx, subject.sub)) remaining += 1;
      if (await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.userItem(subject.sub))) remaining += 1;
    } catch {
      remaining += 1;
    }
  }
  for (const emailKey of emailKeys) {
    try {
      const emailItem = await getClaimItem(ctx, SIGNUP_EMAIL_CLAIM_KEYS.emailItem(emailKey));
      if (subjects.some((subject) => emailClaimNames(emailItem, subject.sub))) remaining += 1;
    } catch {
      remaining += 1;
    }
  }
  if (remaining > 0 || tally.incomplete > 0) verdict.fail("cleanup_incomplete");
  verdict.current = "done";

  return {
    action: "run",
    outcome: verdict.outcome,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    stage: verdict.outcome === "pass" ? "done" : verdict.stage,
    expectedMode: config.expectedMode,
    ...(observedMode ? { observedMode } : {}),
    runTag,
    signUps,
    durationMs: deps.now() - startedAt,
    usersDeleted: tally.usersDeleted,
    claimItemsDeleted: tally.claimItemsDeleted,
    recordsDeleted: tally.recordsDeleted,
    swept: tally.swept,
    refused: tally.refused,
    remaining,
    ...(unexpected ? { errorName: unexpected } : {}),
  };
};

/** The payload {"action": "sweep"}: the sweep alone, with no SignUp and so no email. */
export const runSweep = async (config: CheckConfig, deps: CheckDeps): Promise<CheckResult> => {
  const startedAt = deps.now();
  const ctx: Context = { config, deps, verdict: new Verdict(), tally: new Tally() };
  let unexpected: string | undefined;
  ctx.verdict.current = "sweep";
  try {
    await sweep(ctx);
  } catch (error) {
    unexpected = errorName(error);
    ctx.verdict.fail("internal_error");
  }
  if (ctx.tally.incomplete > 0) ctx.verdict.fail("cleanup_incomplete");
  return {
    action: "sweep",
    outcome: ctx.verdict.outcome,
    ...(ctx.verdict.reason ? { reason: ctx.verdict.reason } : {}),
    stage: ctx.verdict.outcome === "pass" ? "done" : ctx.verdict.stage,
    expectedMode: config.expectedMode,
    signUps: 0,
    durationMs: deps.now() - startedAt,
    usersDeleted: ctx.tally.usersDeleted,
    claimItemsDeleted: ctx.tally.claimItemsDeleted,
    recordsDeleted: ctx.tally.recordsDeleted,
    swept: ctx.tally.swept,
    refused: ctx.tally.refused,
    remaining: 0,
    ...(unexpected ? { errorName: unexpected } : {}),
  };
};
