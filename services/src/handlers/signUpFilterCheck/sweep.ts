import { ListUsersCommand, type UserType } from "@aws-sdk/client-cognito-identity-provider";

import { probeKindOf, type ProbeKind, type SignUpProbeRecord } from "../../shared/signUpFilter";
import {
  LEFTOVER_MIN_AGE_MS,
  LIST_USERS_MAX_PAGES,
  MAX_SWEEP_DELETIONS,
  OWN_ACCOUNT_SLACK_MS,
  attributeOf,
  deleteProbeRecord,
  getUser,
  readProbeRecord,
  removeProbeSubject,
  type Context,
  type ProbeUser,
} from "./common";

/**
 * The sweep (CB-07): removes what crashed runs, or strangers signing up at a probe address, left behind. It
 * runs at the start of every run and alone with the payload {"action": "sweep"}.
 *
 * Probe accounts are found three ways, and every one is re-checked with the filter's own probeKindOf (so
 * a longer local part such as <local part>r@, another domain or a look-alike suffix never matches):
 * 1. ListUsers with Filter email ^= "<local part>" (at most 5 pages). ListUsers is eventually consistent,
 *    and its case handling is not documented, so it is not the only source.
 * 2. AdminGetUser on the exact check address (strongly consistent): a run that started moments ago.
 * 3. The two PROBE# records: AdminGetUser on the userName each names (a mixed-case or trailing-dot address
 *    is its own user in this case-sensitive pool and may be missed by 1).
 *
 * Then:
 * - Any account that is not UNCONFIRMED (someone entered a code): fail probe_address_confirmed, nothing deleted.
 * - Any account younger than 15 minutes: inconclusive busy (another run, or a quick rerun); it is not deleted,
 *   and no SignUp follows.
 * - Older accounts are deleted through the guarded chain (common.ts), oldest first, at most 5 per sweep; more
 *   than 5 is a fail too_many_leftovers, and the rest go in later sweeps.
 * - A PROBE# record whose account is gone (deleted above, or never created: a refused sign-up, or one Cognito
 *   failed after the trigger ran): its claim items are released, then it is deleted on condition that it is
 *   still the record read. One under a minute old whose account does not exist yet may be a sign-up in
 *   progress: busy.
 *
 * Returns whether the run may go on to its sign-ups.
 */
export const sweep = async (ctx: Context): Promise<boolean> => {
  const { config, deps, verdict } = ctx;
  const now = deps.now();
  const found = new Map<string, ProbeUser>();
  const add = (user: ProbeUser): void => {
    if (user.username && probeKindOf(user.email, config.check)) found.set(user.username, user);
  };

  // 1. ListUsers by prefix.
  let paginationToken: string | undefined;
  let pages = 0;
  do {
    const response = (await deps.cognito.send(
      new ListUsersCommand({
        UserPoolId: config.userPoolId,
        Filter: `email ^= "${config.check.local}"`,
        AttributesToGet: ["email"],
        Limit: 60,
        PaginationToken: paginationToken,
      }),
    )) as { Users?: UserType[]; PaginationToken?: string };
    pages += 1;
    for (const user of response.Users ?? []) {
      add({
        username: user.Username ?? "",
        sub: undefined,
        email: attributeOf(user.Attributes, "email"),
        status: user.UserStatus,
        createdAt: user.UserCreateDate instanceof Date ? user.UserCreateDate.getTime() : undefined,
      });
    }
    paginationToken = response.PaginationToken;
  } while (paginationToken && pages < LIST_USERS_MAX_PAGES);

  // 2. The exact check address, strongly consistent.
  const exact = await getUser(ctx, config.check.address);
  if (exact) add(exact);

  // 3. The accounts the probe records name.
  const records: Array<{ kind: ProbeKind; record: SignUpProbeRecord; accountFound: boolean }> = [];
  for (const kind of ["base", "variant"] as const) {
    const record = await readProbeRecord(ctx, kind);
    if (!record) continue;
    let accountFound = found.has(record.userName);
    if (!accountFound) {
      const user = await getUser(ctx, record.userName);
      if (user) {
        add(user);
        accountFound = true;
      }
    }
    records.push({ kind, record, accountFound });
  }

  const accounts = [...found.values()];
  if (accounts.some((user) => user.status !== "UNCONFIRMED")) {
    verdict.fail("probe_address_confirmed");
    return false;
  }
  const ageOf = (user: ProbeUser): number => now - (user.createdAt ?? now);
  const busy = accounts.filter((user) => ageOf(user) < LEFTOVER_MIN_AGE_MS);
  // A record whose account does not exist (yet) may be a sign-up in progress for a minute at most.
  const recordsInProgress = records.filter(
    ({ record, accountFound }) => !accountFound && now - Date.parse(record.at) < OWN_ACCOUNT_SLACK_MS,
  );
  const stale = accounts
    .filter((user) => ageOf(user) >= LEFTOVER_MIN_AGE_MS)
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
  if (stale.length > MAX_SWEEP_DELETIONS) verdict.fail("too_many_leftovers");

  const removed = new Set<string>();
  for (const user of stale.slice(0, MAX_SWEEP_DELETIONS)) {
    const removal = await removeProbeSubject(ctx, {
      sub: user.username,
      kind: probeKindOf(user.email, config.check) ?? "variant",
      createdAtMost: now - LEFTOVER_MIN_AGE_MS,
      leftover: true,
    });
    if (removal.status === "removed") removed.add(user.username);
    else if (removal.status === "refused") verdict.fail("refused_delete");
    else verdict.fail("cleanup_incomplete");
  }

  // Records whose account is gone: deleted above, or never created (a refused sign-up, or one Cognito failed
  // after the trigger ran) more than a minute ago. Their claim items go first, then the record itself, on
  // condition that it is still the record read.
  for (const { kind, record, accountFound } of records) {
    if (accountFound ? !removed.has(record.userName) : recordsInProgress.some((entry) => entry.record === record)) {
      continue;
    }
    if (!accountFound) {
      const removal = await removeProbeSubject(ctx, { sub: record.userName, kind, leftover: true });
      if (removal.status !== "removed") {
        verdict.fail(removal.status === "refused" ? "refused_delete" : "cleanup_incomplete");
        continue;
      }
    }
    if (await deleteProbeRecord(ctx, kind, "at", record.at)) ctx.tally.swept += 1;
  }

  if (busy.length > 0 || recordsInProgress.length > 0) {
    verdict.inconclusive("busy");
    return false;
  }
  return !verdict.failed;
};
