import { createHash } from "node:crypto";

import { DISPOSABLE_EMAIL_ALLOWLIST, DISPOSABLE_EMAIL_BLOCKLIST } from "./disposableDomains.generated";
import {
  MAX_CLAIM_HOLDERS,
  PENDING_CLAIM_WINDOW_MS,
  UNCONFIRMED_CLAIM_LIFETIME_MS,
  type EmailClaim,
} from "../../shared/signUpFilter";

/**
 * INT-05 email policy, shared by the pre-sign-up trigger (PreSignUpCheck), the claims backfill
 * (`npm run backfill:signup-email-claims`) and the blocklist update (`npm run update:disposable-domains`).
 * Pure: no AWS call, no environment.
 *
 * - Disposable domains: an address is refused when its domain, or any parent domain, is on the
 *   blocklist (the generated upstream list plus EXTRA_BLOCKED_DOMAINS). The most specific entry wins:
 *   an allowlisted domain (the upstream allowlist, EXTRA_ALLOWED_DOMAINS and the GUARD_DOMAINS) is
 *   never refused, nor is any subdomain of it below a blocked parent.
 * - Base address: lower case; the local part cut at the first "+"; for gmail.com and googlemail.com
 *   the dots removed and the domain set to gmail.com. Plus-addressing is allowed, but a+news@x.com
 *   counts as a@x.com, so there is one account per base address. Cognito still stores the real address.
 * - emailKey: salted SHA-256 of "email:v1:" + base, with the same salt and form as DistrictVerification's
 *   hashes (sha256("<salt>:<value>"), hex). No address is stored anywhere.
 * - addressKey: the same for the exact address Cognito validated (letter case, +tag and dots kept) under its
 *   own prefix "email-address:v1:", so a retry of the same address can be told from a variant.
 *
 * The rejection messages and reasons, address parsing, the claim keys and the claim windows live in
 * shared/signUpFilter.ts (no domain list there, so the filter check, CB-07, can use them) and are
 * re-exported here unchanged.
 */

export {
  DISPOSABLE_DOMAIN_REASON,
  DISPOSABLE_EMAIL_MESSAGE,
  EMAIL_VARIANT_MESSAGE,
  EMAIL_VARIANT_REASON,
  MAX_CLAIM_HOLDERS,
  PENDING_CLAIM_WINDOW_MS,
  SIGNUP_EMAIL_CLAIMS_PARTITION_KEY,
  UNCONFIRMED_CLAIM_LIFETIME_MS,
  baseEmailAddress,
  emailClaimKey,
  emailClaimNames,
  parseEmailAddress,
  readEmailClaim,
  userClaimKey,
  type EmailClaim,
  type ParsedEmail,
} from "../../shared/signUpFilter";

// ─── Domain lists ─────────────────────────────────────────────────────────────

/**
 * Mainstream mailbox providers that must never be refused. The update script refuses to write a list
 * that would block any of them, and the runtime treats them as allowlisted as well.
 */
export const GUARD_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "fastmail.com",
  "zoho.com",
];

/**
 * Hand-kept additions for urgent cases (a disposable domain getting through before the next quarterly
 * list update). Lower case, one domain per entry; a parent domain also covers its subdomains.
 */
export const EXTRA_BLOCKED_DOMAINS: readonly string[] = [];

/** Hand-kept exceptions: a domain the upstream list blocks by mistake. */
export const EXTRA_ALLOWED_DOMAINS: readonly string[] = [];

export interface DomainLists {
  blocked: ReadonlySet<string>;
  allowed: ReadonlySet<string>;
}

export interface DomainListSources {
  blocklist: readonly string[];
  allowlist: readonly string[];
  extraBlocked?: readonly string[];
  extraAllowed?: readonly string[];
  /** Domains always treated as allowed (the guard list at runtime; none in the update script's check). */
  guard?: readonly string[];
}

const cleanDomain = (value: string): string => value.trim().toLowerCase().replace(/\.$/, "");

export const buildDomainLists = (sources: DomainListSources): DomainLists => ({
  blocked: new Set([...sources.blocklist, ...(sources.extraBlocked ?? [])].map(cleanDomain)),
  allowed: new Set([...sources.allowlist, ...(sources.extraAllowed ?? []), ...(sources.guard ?? [])].map(cleanDomain)),
});

/** The lists PreSignUpCheck uses: the generated upstream lists, the hand-kept extras and the guard list. */
export const DEFAULT_DOMAIN_LISTS: DomainLists = buildDomainLists({
  blocklist: DISPOSABLE_EMAIL_BLOCKLIST,
  allowlist: DISPOSABLE_EMAIL_ALLOWLIST,
  extraBlocked: EXTRA_BLOCKED_DOMAINS,
  extraAllowed: EXTRA_ALLOWED_DOMAINS,
  guard: GUARD_DOMAINS,
});

/** "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com", "com"]. */
export const domainSuffixes = (domain: string): string[] => {
  const labels = cleanDomain(domain).split(".");
  return labels.map((_, index) => labels.slice(index).join("."));
};

/**
 * The blocklist entry that makes `domain` disposable, or null when it is not. Walks from the most
 * specific suffix to the least: the first one on the allowlist ends the walk as allowed, the first one
 * on the blocklist ends it as blocked.
 */
export const matchDisposableDomain = (domain: string, lists: DomainLists = DEFAULT_DOMAIN_LISTS): string | null => {
  for (const suffix of domainSuffixes(domain)) {
    if (lists.allowed.has(suffix)) return null;
    if (lists.blocked.has(suffix)) return suffix;
  }
  return null;
};

export const isDisposableDomain = (domain: string, lists: DomainLists = DEFAULT_DOMAIN_LISTS): boolean =>
  matchDisposableDomain(domain, lists) !== null;

// ─── Email keys ───────────────────────────────────────────────────────────────

/** The claim key of a base address: hex SHA-256 of "<salt>:email:v1:<base>". */
export const emailKeyFor = (base: string, salt: string): string => {
  if (!salt) throw new Error("A hash salt is required to compute an email key.");
  return createHash("sha256").update(`${salt}:email:v1:${base}`).digest("hex");
};

/**
 * The key of the exact address a sign-up uses: hex SHA-256 of "<salt>:email-address:v1:<address>", where the
 * address is the email Cognito validated, exactly as it came (no trimming or case folding). The user pool is
 * case-sensitive, so Jane@x.com and jane@x.com are two Cognito users: two addresses here too, and only a string
 * Cognito itself would refuse as a duplicate counts as the same address. Its prefix differs from emailKeyFor's,
 * so an address key never equals an email key.
 */
export const addressKeyFor = (address: string, salt: string): string => {
  if (!salt) throw new Error("A hash salt is required to compute an address key.");
  return createHash("sha256").update(`${salt}:email-address:v1:${address}`).digest("hex");
};

// ─── SignUpEmailClaims layout (integration plan X5) ────────────────────────────

/**
 * Table `SignUpEmailClaims`, partition key `pk` (S), no sort key. Each claim is two items written in
 * one transaction:
 *   EMAIL#<emailKey>  { userName, claimedAt, addressKey, holders, revision }   who holds the base address
 *   USER#<userName>   { emailKey, claimedAt }   lets account deletion find and release the claim
 * `holders` lists every sign-up attempt holding the base address under the one exact address `addressKey`
 * (shared/signUpFilter.ts has the full layout). Account deletion reads USER#<cognito:username, else sub>,
 * deletes EMAIL#<emailKey> on condition that its userName or one of its holders is this account, then the USER#
 * items of the other holders it named, and the account's own USER# item. A sign-up that a later check refuses
 * (App Attest or DeviceCheck under enforce) is taken off the holders; when it was the only one, its EMAIL# item
 * becomes one that names no account (`releasedAt`), so the next sign-up on that base address claims it at once.
 *
 * Two more items belong to the filter check (CB-07, RUNBOOK 14.12): PROBE#base and PROBE#variant, one probe
 * record each (shared/signUpFilter.ts, SignUpProbeRecord), overwritten by every probe sign-up and deleted by
 * the check's cleanup. They hold no address.
 */

export interface ClaimHolderState {
  /** Cognito UserStatus (CONFIRMED, UNCONFIRMED, ...). */
  status: string | undefined;
  createdAt: Date | undefined;
}

/**
 * Whether an existing account still holds its claim: it exists (the caller checks that) and is either
 * not UNCONFIRMED or was created less than UNCONFIRMED_CLAIM_LIFETIME_MS ago. An UNCONFIRMED account
 * without a creation date is treated as live, so a claim is never taken on missing data.
 */
export const isLiveClaimHolder = (holder: ClaimHolderState, now: number): boolean => {
  if (holder.status !== "UNCONFIRMED") return true;
  const created = holder.createdAt?.getTime();
  if (created === undefined || !Number.isFinite(created)) return true;
  return now - created < UNCONFIRMED_CLAIM_LIFETIME_MS;
};

/**
 * Whether a claim whose holder AdminGetUser cannot find still holds the address: true while its
 * `claimedAt` is under PENDING_CLAIM_WINDOW_MS old (a parallel sign-up has not finished), false once
 * older (a deleted account, or a sign-up that never created its user). A claim without a readable
 * `claimedAt` counts as old. A sign-up the trigger itself refuses frees its claim at once instead
 * (releaseBaseAddressClaim in index.ts), so its retry is not refused inside that window.
 */
export const isPendingClaim = (claimedAt: string | undefined, now: number): boolean => {
  const claimed = Date.parse(claimedAt ?? "");
  return Number.isFinite(claimed) && now - claimed < PENDING_CLAIM_WINDOW_MS;
};

// ─── The claim decision (emailBase) ───────────────────────────────────────────

/**
 * What AdminGetUser says of a holder: an account that still holds the address (isLiveClaimHolder), an account
 * that no longer does (an abandoned UNCONFIRMED sign-up), or no account (deleted, never created, or a sign-up
 * still in progress).
 */
export type HolderLookup = "live" | "inactive" | "missing";

export type ClaimOutcome = "claimed" | "renewed" | "retried" | "taken_over" | "variant_exists";

export interface ClaimDecisionInput {
  /** The EMAIL# item as read (readEmailClaim), or null when there is none. */
  claim: EmailClaim | null;
  /** The sign-up's userName. */
  userName: string;
  /** The sign-up's addressKeyFor. */
  addressKey: string;
  /** AdminGetUser's answers so far, for some or all of holdersToLookUp(claim, userName) (nextHolderLookups). */
  lookups: ReadonlyMap<string, HolderLookup>;
  now: number;
}

/**
 * Why a sign-up that is not a variant of another address is still a hit (`claimDetail` on the log line):
 * - holder_limit: a retry of the same address that would take the holders past MAX_CLAIM_HOLDERS;
 * - contention: the claim kept changing under the sign-up (many parallel sign-ups of one address) until it ran out
 *   of rounds or time, so it could not be recorded as a holder (claimBaseAddress in index.ts).
 */
export type ClaimDetail = "holder_limit" | "contention";

export type ClaimDecision =
  | {
      outcome: "variant_exists";
      /** The live holder, else the pending one the claim names (else the newest pending one). */
      holder?: string;
      detail?: ClaimDetail;
    }
  | {
      outcome: Exclude<ClaimOutcome, "variant_exists">;
      /** taken_over only: the account the claim named before. */
      holder?: string;
      /** What the EMAIL# item records after the write (userName and claimedAt are this sign-up's). */
      holders: Record<string, string>;
      addressKey: string;
    };

const holderTime = (holders: Record<string, string>, name: string): number => {
  const parsed = Date.parse(holders[name] ?? "");
  return Number.isFinite(parsed) ? parsed : -Infinity;
};

const newestFirst = (holders: Record<string, string>, names: readonly string[]): string[] =>
  [...names].sort((a, b) => holderTime(holders, b) - holderTime(holders, a) || (a < b ? -1 : a > b ? 1 : 0));

const newestHolder = (holders: Record<string, string>, names: readonly string[]): string | undefined =>
  newestFirst(holders, names)[0];

/**
 * The holders whose accounts may have to be looked up before deciding: every holder other than this sign-up, the
 * one the claim names first and then the newest first, and none when the claim is missing, released, or already
 * names this sign-up (Cognito re-invoking the trigger). nextHolderLookups says how many of them are needed.
 */
export const holdersToLookUp = (claim: EmailClaim | null, userName: string): string[] => {
  if (!claim?.userName || claim.userName === userName) return [];
  const others = Object.keys(claim.holders).filter((holder) => holder !== userName && holder !== claim.userName);
  return [claim.userName, ...newestFirst(claim.holders, others)];
};

/** What decideClaim needs to know of the holders, with `lookups` possibly covering only some of them. */
const holderFacts = (input: ClaimDecisionInput) => {
  const { claim, userName, addressKey, lookups, now } = input;
  const others = holdersToLookUp(claim, userName);
  const holders = claim?.holders ?? {};
  const pendingByTime = (holder: string): boolean => isPendingClaim(holders[holder], now);
  const live = others.find((holder) => lookups.get(holder) === "live");
  const pending = others.filter((holder) => lookups.get(holder) === "missing" && pendingByTime(holder));
  const unknown = others.filter((holder) => !lookups.has(holder));
  const sameAddress = claim?.addressKey !== undefined && claim.addressKey === addressKey;
  // A same-address retry keeps the pending holders; an unknown one with a recent claim may be one of them (or live,
  // a hit anyway), so it counts towards the limit before it is looked up.
  const mayStay = [...pending, ...unknown.filter(pendingByTime)];
  return {
    others,
    live,
    pending,
    unknown,
    sameAddress,
    overLimit: sameAddress && mayStay.length + 1 > MAX_CLAIM_HOLDERS,
    mayStay,
  };
};

/**
 * The holders emailBase must look up next, given the answers it has (`lookups`), or none when decideClaim can
 * decide already. The holder the claim names comes first and alone: it is the latest attempt and, once one of the
 * attempts became an account, the claim names that account (claimBaseAddress points it there), so one AdminGetUser
 * usually settles it. The rest are looked up together only when the answer still depends on them: no live holder
 * yet, and either a same-address retry under the holder limit or no pending holder yet. So a variant of a held
 * address costs one AdminGetUser, and at most MAX_CLAIM_HOLDERS ever.
 */
export const nextHolderLookups = (input: ClaimDecisionInput): string[] => {
  const { others, live, pending, unknown, sameAddress, overLimit } = holderFacts(input);
  if (unknown.length === 0 || live !== undefined) return [];
  if (!sameAddress && pending.length > 0) return [];
  if (overLimit) return [];
  return unknown.length === others.length ? unknown.slice(0, 1) : unknown;
};

/**
 * emailBase's decision for a sign-up (userName U, address key K) on a base address (C2 3.5 step 5):
 * - no claim, or a released one: claimed (holders {U});
 * - the claim names U already (Cognito re-invoked the trigger): renewed, the other holders kept;
 * - any other holder is live: variant_exists, even for the same address (Cognito refuses that one anyway);
 * - some holder is missing but its own claimedAt is under PENDING_CLAIM_WINDOW_MS old (a sign-up that may still
 *   be in progress): retried when the claim's addressKey is K (the same person trying the same address again,
 *   typically after Cognito refused the password), keeping only the pending holders plus U, unless that is more
 *   than MAX_CLAIM_HOLDERS (variant_exists, detail holder_limit); variant_exists for a different address, or for
 *   a claim written before addressKey existed;
 * - otherwise (every holder gone, or no longer holding): taken_over (holders {U}).
 * `lookups` may cover only the holders nextHolderLookups asked for: a holder without an answer counts as live
 * where the answer would matter, so a claim is never taken on missing data. A same-address retry with an
 * unanswered holder whose claim is recent counts that holder towards the limit (it is live or pending).
 */
export const decideClaim = (input: ClaimDecisionInput): ClaimDecision => {
  const { claim, userName, addressKey, now } = input;
  const claimedAt = new Date(now).toISOString();
  if (!claim?.userName) return { outcome: "claimed", holders: { [userName]: claimedAt }, addressKey };
  if (claim.userName === userName) {
    return {
      outcome: "renewed",
      holders: { ...claim.holders, [userName]: claimedAt },
      addressKey: claim.addressKey ?? addressKey,
    };
  }

  const { live, pending, unknown, sameAddress, overLimit, mayStay } = holderFacts(input);
  const named = (names: readonly string[]): string | undefined =>
    names.includes(claim.userName!) ? claim.userName : newestHolder(claim.holders, names);
  if (live !== undefined) return { outcome: "variant_exists", holder: live };
  if (!sameAddress && pending.length > 0) return { outcome: "variant_exists", holder: named(pending) };
  if (overLimit) return { outcome: "variant_exists", holder: named(mayStay), detail: "holder_limit" };
  if (unknown.length > 0) return { outcome: "variant_exists", holder: named(unknown) };
  if (pending.length === 0) {
    return { outcome: "taken_over", holder: claim.userName, holders: { [userName]: claimedAt }, addressKey };
  }

  const holders: Record<string, string> = Object.fromEntries(pending.map((name) => [name, claim.holders[name]]));
  holders[userName] = claimedAt;
  return { outcome: "retried", holders, addressKey };
};

/**
 * What the EMAIL# item records once `userName` stops holding it (emailBase's release step): null when it was the
 * only holder (the item is then released), else the other holders, with userName and claimedAt moved to the
 * newest of them when they named this one.
 */
export const claimWithoutHolder = (
  claim: EmailClaim,
  userName: string,
): { userName: string; claimedAt?: string; holders: Record<string, string> } | null => {
  const holders = Object.fromEntries(Object.entries(claim.holders).filter(([name]) => name !== userName));
  const names = Object.keys(holders);
  if (names.length === 0) return null;
  const latest = claim.userName && claim.userName !== userName ? claim.userName : newestHolder(holders, names)!;
  const claimedAt = latest === claim.userName ? claim.claimedAt : holders[latest] || undefined;
  return { userName: latest, ...(claimedAt ? { claimedAt } : {}), holders };
};
