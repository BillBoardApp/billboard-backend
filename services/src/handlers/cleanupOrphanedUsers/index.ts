import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { type AttributeValue, DeleteItemCommand, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { SNSClient } from "@aws-sdk/client-sns";
import {
  ACCOUNT_LINK_COUNT_KEYS,
  accountDeletionConfigFromEnv,
  claimDeletion,
  countUserData,
  deleteCognitoUser,
  deleteUserData,
  deletionErrorMessage,
  emptyAccountLinkCounts,
  markDeletionCompleted,
  markDeletionFailed,
  type AccountDeletionContext,
  type UserDataCounts,
} from "../../shared/accountDeletion";
import { emitEmbeddedMetric } from "../../shared/metrics";
import {
  cleanupUnconfirmedSignUps,
  unconfirmedCleanupConfigFromEnv,
  unconfirmedCleanupFailure,
  type UnconfirmedCleanupConfig,
  type UnconfirmedCleanupSummary,
} from "./unconfirmedSignUps";

// Safety limits. A wrong USER_POOL_ID or a recreated pool makes every user look
// orphaned, so the run aborts instead of deleting when the numbers look wrong.
// Accounts removed through accountData leave a PII tombstone (deletionStatus
// "completed", or "in_progress" if the deletion was cut off) after their Cognito
// user is gone; those are expected orphans and do not count toward the abort
// threshold. The threshold is the larger of ORPHAN_ABORT_MIN_COUNT (default 2) and
// ORPHAN_ABORT_FRACTION (default 2%) of the scanned users: with a handful of users
// a replaced pool (every user an orphan) must abort, so the minimum is small. Both
// limits can be raised by env to drain a known backlog.
//
// Tombstones are never deleted (REC-10): they are the only record of a deletion,
// and a Cognito restore drops the users they name (RUNBOOK section 8). A user
// whose only row is a tombstone is not cleaned up at all; a tombstoned user with
// leftover rows in the other tables loses those rows but keeps the tombstone.
//
// Stalled deletions (D3, C1.10). An "in_progress" claim is left only by an
// AccountData run that timed out or crashed (a thrown error writes "failed"), and
// every such row is a user who asked to be deleted. A claim older than
// RESUME_MIN_STALE_HOURS (or with no request time) is a resume candidate: it is
// kept out of the orphan path, and at most MAX_RESUMES_PER_RUN are handled per
// run. With DRY_RUN the run only reports them (`wouldResume`, read-only counts).
// Without it, each is claimed with AccountData's own condition (so a client retry
// and a resume never run together), its data deleted with AccountData's code, the
// tombstone written and the Cognito user deleted when it still exists. "failed"
// deletions are reported and never resumed (the user can retry from the app).
// AccountDeletionsStuck (stale "in_progress" plus "failed") is emitted every run.
//
// X5 and X23. With ADDRESS_CLAIMS_TABLE_NAME, SIGNUP_EMAIL_CLAIMS_TABLE_NAME and APP_ATTEST_TABLE_NAME
// set, a deletion also releases the address claim, deletes the sign-up email claim (looked up by the
// sub, which is the username in this pool) and the App Attest bindings, and the dry run counts them
// (`addressClaims`, `emailClaims`, `appAttestBindings` in `items`) with GetItem and Query only. This
// function has read-only grants on those tables while DRY_RUN is true: DRY_RUN=false needs their
// write grants in the same change, or a deletion that finds such a record fails after its other rows.
//
// REL-53. After the orphan and resume paths, the run deletes sign-ups left UNCONFIRMED for more than
// UNCONFIRMED_SIGNUP_MAX_AGE_HOURS (unconfirmedSignUps.ts), under its own switch UNCONFIRMED_SIGNUP_CLEANUP_MODE (off, dry_run, delete), not
// DRY_RUN. An abort above stops it too. Its counts are the summary's `unconfirmedSignUps` block; it never throws.
// S17: the listing of the pool also counts the users created in the 24 hours before the run that are CONFIRMED
// (SignUpsConfirmed, every run, 0 included), the funnel's other end next to PreSignUpCheck's SignUpAllowed. The
// sign-up filter check's probes never confirm. No extra call: ListUsers returns UserStatus and UserCreateDate.
const DEFAULT_MAX_DELETIONS_PER_RUN = 50;
const DEFAULT_ORPHAN_ABORT_MIN_COUNT = 2;
const DEFAULT_ORPHAN_ABORT_FRACTION = 0.02;
const DEFAULT_RESUME_MIN_STALE_HOURS = 24;
const DEFAULT_MAX_RESUMES_PER_RUN = 10;
const LIST_USERS_PAGE_SIZE = 60;
const MS_PER_HOUR = 60 * 60 * 1000;

export const ACCOUNT_METRICS_NAMESPACE = "BillBoard/Accounts";
export const ACCOUNT_DELETIONS_STUCK_METRIC = "AccountDeletionsStuck";
export const SIGN_UPS_CONFIRMED_METRIC = "SignUpsConfirmed";
/** The run is daily: SignUpsConfirmed counts the users created in this many hours before it. */
export const SIGN_UPS_CONFIRMED_WINDOW_HOURS = 24;

const deletion: AccountDeletionContext = {
  config: accountDeletionConfigFromEnv(),
  db: new DynamoDBClient({}),
  sns: new SNSClient({}),
  cognito: new CognitoIdentityProviderClient({}),
};
const { config, db, cognito } = deletion;
const USER_POOL_ID = config.userPoolId;

// The statuses the Cognito restore filter drops (RUNBOOK section 8): the same test
// decides which PII rows are tombstones here.
const TOMBSTONE_DELETION_STATUSES = ["completed", "in_progress"] as const;
const IN_PROGRESS = "in_progress";
const FAILED = "failed";

function isDeletionTombstone(deletionStatus: string | undefined): boolean {
  return (TOMBSTONE_DELETION_STATUSES as readonly string[]).includes(deletionStatus?.trim() ?? "");
}

/** A UserPII row whose deletion is "in_progress" or "failed". */
type DeletionClaim = {
  userId: string;
  status: typeof IN_PROGRESS | typeof FAILED;
  deletionRequestedAt?: string;
  deletionError?: string;
};

type TableScanConfig = {
  tableName: string;
  partitionKey: string;
  /** The PII table: also report tombstones and deletion claims. */
  collectDeletionState?: boolean;
};

type ScanState = {
  /** Users whose PII row is a deletion tombstone. */
  deletedUserIds: Set<string>;
  claims: DeletionClaim[];
};

const tableScans: TableScanConfig[] = [
  { tableName: config.pii.tableName, partitionKey: config.pii.partitionKey, collectDeletionState: true },
  { tableName: config.preferences.tableName, partitionKey: config.preferences.partitionKey },
  { tableName: config.devices.tableName, partitionKey: config.devices.partitionKey },
  { tableName: config.feedback.tableName, partitionKey: config.feedback.partitionKey },
  ...(config.weeklyDigests
    ? [{ tableName: config.weeklyDigests.tableName, partitionKey: config.weeklyDigests.partitionKey }]
    : []),
];

async function scanDistinctUserIds(table: TableScanConfig, state: ScanState): Promise<Set<string>> {
  const userIds = new Set<string>();
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await db.send(
      new ScanCommand({
        TableName: table.tableName,
        ProjectionExpression: table.collectDeletionState
          ? "#pk, #deletionStatus, #deletionRequestedAt, #deletionError"
          : "#pk",
        ExpressionAttributeNames: {
          "#pk": table.partitionKey,
          ...(table.collectDeletionState
            ? {
                "#deletionStatus": "deletionStatus",
                "#deletionRequestedAt": "deletionRequestedAt",
                "#deletionError": "deletionError",
              }
            : {}),
        },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const userId = item[table.partitionKey]?.S?.trim();
      if (!userId) continue;
      userIds.add(userId);
      if (!table.collectDeletionState) continue;

      const status = item.deletionStatus?.S?.trim();
      if (isDeletionTombstone(status)) state.deletedUserIds.add(userId);
      if (status === IN_PROGRESS || status === FAILED) {
        state.claims.push({
          userId,
          status,
          deletionRequestedAt: item.deletionRequestedAt?.S || undefined,
          deletionError: item.deletionError?.S || undefined,
        });
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return userIds;
}

/**
 * Every username and `sub` in the pool, read with paginated ListUsers so the
 * cost is one call per 60 users instead of one AdminGetUser per scanned user.
 * Both are collected because the tables key on `sub`, which is also the
 * username in this pool (email is a sign-in alias). S17: also counts the users
 * created in the SIGN_UPS_CONFIRMED_WINDOW_HOURS before `nowMs` that are CONFIRMED.
 */
async function listCognitoUsers(nowMs: number): Promise<{ ids: Set<string>; confirmedSignUps: number }> {
  const ids = new Set<string>();
  const windowMs = SIGN_UPS_CONFIRMED_WINDOW_HOURS * MS_PER_HOUR;
  let confirmedSignUps = 0;
  let paginationToken: string | undefined;

  do {
    const response = await cognito.send(
      new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        AttributesToGet: ["sub"],
        Limit: LIST_USERS_PAGE_SIZE,
        PaginationToken: paginationToken,
      }),
    );

    for (const user of response.Users ?? []) {
      const username = user.Username?.trim();
      if (username) ids.add(username);
      const sub = user.Attributes?.find((attribute) => attribute.Name === "sub")?.Value?.trim();
      if (sub) ids.add(sub);
      const age = user.UserCreateDate instanceof Date ? nowMs - user.UserCreateDate.getTime() : Number.NaN;
      if (user.UserStatus === "CONFIRMED" && age >= 0 && age < windowMs) confirmedSignUps += 1;
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return { ids, confirmedSignUps };
}

// Re-checks a single candidate right before deletion, so a user created or
// listed inconsistently during the run is never deleted.
async function cognitoUserExists(userId: string): Promise<boolean> {
  try {
    await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "UserNotFoundException") {
      return false;
    }
    throw error;
  }
}

/**
 * Deletes the user's PII row unless it is a deletion tombstone. The condition covers a
 * tombstone written after the scan (an account deleted during the run). Returns false
 * when the row was kept because it is a tombstone.
 */
async function deletePiiUser(userId: string): Promise<boolean> {
  try {
    await db.send(
      new DeleteItemCommand({
        TableName: config.pii.tableName,
        Key: {
          [config.pii.partitionKey]: { S: userId },
        },
        ConditionExpression:
          "attribute_not_exists(#deletionStatus) OR NOT (#deletionStatus IN (:completed, :inProgress))",
        ExpressionAttributeNames: { "#deletionStatus": "deletionStatus" },
        ExpressionAttributeValues: {
          ":completed": { S: TOMBSTONE_DELETION_STATUSES[0] },
          ":inProgress": { S: TOMBSTONE_DELETION_STATUSES[1] },
        },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

function isDryRun(): boolean {
  return (process.env.DRY_RUN ?? "").trim().toLowerCase() === "true";
}

function numberFromEnv(name: string, fallback: number, isValid: (value: number) => boolean): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && isValid(parsed)) return parsed;

  console.warn(`Ignoring invalid ${name}`, { value: raw, fallback });
  return fallback;
}

const isCount = (value: number) => Number.isInteger(value) && value >= 0;

function maxDeletionsPerRun(): number {
  return numberFromEnv("MAX_DELETIONS_PER_RUN", DEFAULT_MAX_DELETIONS_PER_RUN, isCount);
}

function orphanAbortMinCount(): number {
  return numberFromEnv("ORPHAN_ABORT_MIN_COUNT", DEFAULT_ORPHAN_ABORT_MIN_COUNT, isCount);
}

function orphanAbortFraction(): number {
  return numberFromEnv("ORPHAN_ABORT_FRACTION", DEFAULT_ORPHAN_ABORT_FRACTION, (value) => value >= 0 && value <= 1);
}

function resumeMinStaleHours(): number {
  return numberFromEnv("RESUME_MIN_STALE_HOURS", DEFAULT_RESUME_MIN_STALE_HOURS, (value) => value >= 0);
}

function maxResumesPerRun(): number {
  return numberFromEnv("MAX_RESUMES_PER_RUN", DEFAULT_MAX_RESUMES_PER_RUN, isCount);
}

/** Epoch ms of the claim's request time, or null when it is missing or unreadable. */
function requestedAtMs(claim: DeletionClaim): number | null {
  if (!claim.deletionRequestedAt) return null;
  const parsed = Date.parse(claim.deletionRequestedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stale: no readable request time, or requested more than `minStaleHours` ago. */
function isStaleClaim(claim: DeletionClaim, nowMs: number, minStaleHours: number): boolean {
  const requested = requestedAtMs(claim);
  return requested === null || nowMs - requested > minStaleHours * MS_PER_HOUR;
}

/** Oldest first; a claim with no readable request time counts as oldest. */
function compareClaimsOldestFirst(a: DeletionClaim, b: DeletionClaim): number {
  const aMs = requestedAtMs(a) ?? Number.NEGATIVE_INFINITY;
  const bMs = requestedAtMs(b) ?? Number.NEGATIVE_INFINITY;
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  return a.userId.localeCompare(b.userId);
}

function staleHours(claim: DeletionClaim, nowMs: number): number | null {
  const requested = requestedAtMs(claim);
  return requested === null ? null : Math.round(((nowMs - requested) / MS_PER_HOUR) * 10) / 10;
}

type WouldResume = {
  userId: string;
  deletionRequestedAt: string | null;
  staleHours: number | null;
  cognitoUserExists: boolean;
  items: UserDataCounts;
};

type ResumeOutcome = "completed" | "claimed_elsewhere" | "failed";

type Resumed = {
  userId: string;
  outcome: ResumeOutcome;
  cognitoUserDeleted: boolean;
  items?: UserDataCounts;
  error?: string;
};

/**
 * Finishes one stalled deletion the way AccountData would have: claim, data, tombstone, then the
 * Cognito user. Never throws; a failure is returned as outcome "failed".
 */
async function resumeDeletion(userId: string): Promise<Resumed> {
  const requestedAt = new Date().toISOString();

  let claimed: boolean;
  try {
    claimed = await claimDeletion(deletion, userId, requestedAt);
  } catch (error) {
    // Nothing was claimed, so nothing is marked failed: the row may belong to a live request.
    console.error("cleanupOrphanedUsers: could not claim a stalled deletion", { userId, error });
    return { userId, outcome: "failed", cognitoUserDeleted: false, error: deletionErrorMessage(error).slice(0, 512) };
  }
  if (!claimed) {
    // A client retry holds a live claim, or the deletion completed since the scan.
    return { userId, outcome: "claimed_elsewhere", cognitoUserDeleted: false };
  }

  let items: UserDataCounts;
  try {
    items = await deleteUserData(deletion, userId);
    await markDeletionCompleted(deletion, userId, requestedAt);
  } catch (error) {
    const message = deletionErrorMessage(error);
    console.error("cleanupOrphanedUsers: resumed deletion failed", { userId, error });
    try {
      await markDeletionFailed(deletion, userId, requestedAt, message);
    } catch (markError) {
      console.error("cleanupOrphanedUsers: could not mark the resumed deletion failed", { userId, error: markError });
    }
    return { userId, outcome: "failed", cognitoUserDeleted: false, error: message.slice(0, 512) };
  }

  // After the tombstone, as in AccountData: a Cognito failure is logged and the status stays
  // "completed" (the data is gone).
  let cognitoUserDeleted = false;
  try {
    if (await cognitoUserExists(userId)) cognitoUserDeleted = await deleteCognitoUser(deletion, userId);
  } catch (error) {
    console.error("cleanupOrphanedUsers: data deleted but Cognito user deletion failed", { userId, error });
  }
  return { userId, outcome: "completed", cognitoUserDeleted, items };
}

/**
 * The REL-53 step. A bug in it, or in reading its settings, is reported in its block and in
 * UnconfirmedSignUpCleanupErrors (so its alarm fires) instead of failing the run's report.
 */
async function runUnconfirmedSignUpStep(userPoolId: string): Promise<UnconfirmedCleanupSummary> {
  let stepConfig: UnconfirmedCleanupConfig | undefined;
  try {
    stepConfig = unconfirmedCleanupConfigFromEnv();
    return await cleanupUnconfirmedSignUps(stepConfig, { cognito, deletion, userPoolId });
  } catch (error) {
    console.error("cleanupOrphanedUsers: the unconfirmed sign-up step failed", { error });
    return unconfirmedCleanupFailure(stepConfig, error);
  }
}

export async function handler() {
  const startedAt = new Date().toISOString();
  const dryRun = isDryRun();
  const maxDeletions = maxDeletionsPerRun();
  const minStaleHours = resumeMinStaleHours();
  const maxResumes = maxResumesPerRun();

  if (!USER_POOL_ID) {
    throw new Error("USER_POOL_ID must be configured for cleanupOrphanedUsers");
  }

  // Scan before listing Cognito: every user id in the scan was written by a
  // user who already existed, so a sign-up during the run cannot look orphaned.
  const allUserIds = new Set<string>();
  const scanState: ScanState = { deletedUserIds: new Set<string>(), claims: [] };
  const { deletedUserIds } = scanState;
  // Users with at least one row other than a tombstone. The PII table is scanned
  // first, so its tombstones are known before its rows are classified.
  const userIdsWithRemovableRows = new Set<string>();
  for (const table of tableScans) {
    const tableUserIds = await scanDistinctUserIds(table, scanState);
    for (const userId of tableUserIds) {
      allUserIds.add(userId);
      if (!table.collectDeletionState || !deletedUserIds.has(userId)) userIdsWithRemovableRows.add(userId);
    }
  }

  // Deletion claims, from the PII scan alone. Emitted before the abort check, so every run that
  // got this far reports it (0 included).
  const nowMs = Date.now();
  const inProgressClaims = scanState.claims.filter((claim) => claim.status === IN_PROGRESS);
  const staleClaims = inProgressClaims
    .filter((claim) => isStaleClaim(claim, nowMs, minStaleHours))
    .sort(compareClaimsOldestFirst);
  const failedClaims = scanState.claims
    .filter((claim) => claim.status === FAILED)
    .sort((a, b) => a.userId.localeCompare(b.userId));
  emitEmbeddedMetric(
    ACCOUNT_METRICS_NAMESPACE,
    ACCOUNT_DELETIONS_STUCK_METRIC,
    staleClaims.length + failedClaims.length,
    {
      properties: { staleInProgressClaims: staleClaims.length, failedClaims: failedClaims.length },
    },
  );

  const userIds = Array.from(allUserIds).sort();
  const listing = userIds.length > 0 ? await listCognitoUsers(nowMs) : null;
  const cognitoUserIds = listing?.ids ?? new Set<string>();
  // S17, before the abort check like AccountDeletionsStuck: sign-ups confirmed in the day before the run.
  if (listing) {
    emitEmbeddedMetric(ACCOUNT_METRICS_NAMESPACE, SIGN_UPS_CONFIRMED_METRIC, listing.confirmedSignUps, {
      properties: { windowHours: SIGN_UPS_CONFIRMED_WINDOW_HOURS },
    });
  }
  const orphanCandidates = userIds.filter((userId) => !cognitoUserIds.has(userId));
  const deletedAccountOrphans = orphanCandidates.filter((userId) => deletedUserIds.has(userId)).length;
  const unexpectedOrphans = orphanCandidates.length - deletedAccountOrphans;
  const abortThreshold = Math.max(orphanAbortMinCount(), userIds.length * orphanAbortFraction());

  let abortReason: string | null = null;
  if (userIds.length > 0 && cognitoUserIds.size === 0) {
    abortReason = "Cognito pool listed zero users";
  } else if (unexpectedOrphans > abortThreshold) {
    abortReason = `Orphan candidates without a deletion tombstone (${unexpectedOrphans}) exceed the safety threshold (${abortThreshold})`;
  }

  if (abortReason) {
    console.error("cleanupOrphanedUsers aborted without deleting anything", {
      reason: abortReason,
      userPoolId: USER_POOL_ID,
      dryRun,
      scannedUsers: userIds.length,
      cognitoUsers: cognitoUserIds.size,
      orphanCandidates: orphanCandidates.length,
      deletedAccountOrphans,
      abortThreshold,
    });
    // Throwing marks the invocation as failed so the Lambda error alarm fires.
    throw new Error(`cleanupOrphanedUsers aborted: ${abortReason}`);
  }

  // Stale claims (all of them, including the ones deferred to a later run) are finished by the
  // resume path, never by the orphan path.
  const resumeUserIds = new Set(staleClaims.map((claim) => claim.userId));
  const orphanPathCandidates = orphanCandidates.filter((userId) => !resumeUserIds.has(userId));

  // A user whose only row is a tombstone has nothing to clean up and is left alone,
  // so kept tombstones never take slots in the per-run deletion cap.
  const cleanupCandidates = orphanPathCandidates.filter((userId) => userIdsWithRemovableRows.has(userId));
  let keptTombstones = orphanPathCandidates.length - cleanupCandidates.length;

  const batch = cleanupCandidates.slice(0, maxDeletions);
  const deferredUsers = cleanupCandidates.length - batch.length;

  let removedUsers = 0;
  let removedPreferences = 0;
  let removedDevices = 0;
  let removedSnsEndpoints = 0;
  let removedFeedback = 0;
  let removedWeeklyDigests = 0;
  let removedPii = 0;
  // X5: address claims, email claim items and App Attest bindings, reported only for the steps whose
  // table is configured (as in UserDataCounts).
  const removedAccountLinks = emptyAccountLinkCounts(config);
  let skippedStillInCognito = 0;
  const wouldDelete: string[] = [];

  for (const userId of batch) {
    if (await cognitoUserExists(userId)) {
      skippedStillInCognito += 1;
      continue;
    }

    if (dryRun) {
      wouldDelete.push(userId);
      if (deletedUserIds.has(userId)) keptTombstones += 1;
      continue;
    }

    removedUsers += 1;
    // AccountData's data steps, so SNS endpoints go too (except ones another user still uses).
    const removed = await deleteUserData(deletion, userId);
    removedPreferences += removed.preferences;
    removedDevices += removed.devices;
    removedSnsEndpoints += removed.snsEndpoints;
    removedFeedback += removed.feedback;
    removedWeeklyDigests += removed.weeklyDigests;
    for (const key of ACCOUNT_LINK_COUNT_KEYS) {
      const count = removed[key];
      if (count !== undefined) removedAccountLinks[key] = (removedAccountLinks[key] ?? 0) + count;
    }
    if (deletedUserIds.has(userId) || !(await deletePiiUser(userId))) {
      keptTombstones += 1;
    } else {
      removedPii += 1;
    }
  }

  const resumeBatch = staleClaims.slice(0, maxResumes);
  const deferredResumes = staleClaims.length - resumeBatch.length;
  const wouldResume: WouldResume[] = [];
  const resumed: Resumed[] = [];

  for (const claim of resumeBatch) {
    if (dryRun) {
      wouldResume.push({
        userId: claim.userId,
        deletionRequestedAt: claim.deletionRequestedAt ?? null,
        staleHours: staleHours(claim, nowMs),
        cognitoUserExists: await cognitoUserExists(claim.userId),
        items: await countUserData(deletion, claim.userId),
      });
      continue;
    }
    resumed.push(await resumeDeletion(claim.userId));
  }

  const unconfirmedSignUps = await runUnconfirmedSignUpStep(USER_POOL_ID);

  const summary = {
    startedAt,
    completedAt: new Date().toISOString(),
    dryRun,
    scannedUsers: userIds.length,
    cognitoUsers: cognitoUserIds.size,
    signUpsConfirmed: listing?.confirmedSignUps ?? 0,
    orphanCandidates: orphanCandidates.length,
    deletedAccountOrphans,
    keptTombstones,
    abortThreshold,
    maxDeletionsPerRun: maxDeletions,
    deferredUsers,
    skippedStillInCognito,
    removedUsers,
    removedItems: {
      pii: removedPii,
      preferences: removedPreferences,
      devices: removedDevices,
      snsEndpoints: removedSnsEndpoints,
      feedback: removedFeedback,
      weeklyDigests: removedWeeklyDigests,
      ...removedAccountLinks,
    },
    deletionClaims: {
      inProgress: inProgressClaims.length,
      staleInProgress: staleClaims.length,
      failed: failedClaims.length,
    },
    resumeMinStaleHours: minStaleHours,
    maxResumesPerRun: maxResumes,
    ...(dryRun ? { wouldDelete, wouldResume } : { resumed }),
    deferredResumes,
    failedDeletions: failedClaims.map((claim) => ({
      userId: claim.userId,
      deletionRequestedAt: claim.deletionRequestedAt ?? null,
      deletionError: claim.deletionError ?? null,
    })),
    unconfirmedSignUps,
  };

  console.log("cleanupOrphanedUsers summary", summary);

  // After the summary, so the run's report is complete: a failed resume fails the invocation and
  // its async failure destination keeps a record.
  const failedResumes = resumed.filter((entry) => entry.outcome === "failed");
  if (failedResumes.length > 0) {
    throw new Error(
      `cleanupOrphanedUsers: ${failedResumes.length} resumed deletion(s) failed: ${failedResumes
        .map((entry) => entry.userId)
        .join(", ")}`,
    );
  }

  return summary;
}
