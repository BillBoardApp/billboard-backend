import { domainToASCII } from "node:url";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { PENDING_CLAIM_WINDOW_MS, UNCONFIRMED_CLAIM_LIFETIME_MS } from "./abuseLimits";

/**
 * The sign-up filter's shared vocabulary (INT-05), without the disposable-domain list, so the filter check
 * (CB-07, handlers/signUpFilterCheck) can use it without bundling that list. Pure: no AWS call, no state.
 *
 * - The filter's refusal messages and reasons, and how to read them back out of Cognito's error.
 * - Address parsing and the base address (one account per base address).
 * - The SignUpEmailClaims key layout (integration plan X5).
 * - The filter check's probe (CB-07): the configured check address, which sign-ups are probes, and the
 *   PROBE# record PreSignUpCheck writes for each probe. PreSignUpCheck (handlers/preSignUp/index.ts) and the
 *   check both decide "is this a probe" with probeKindOf, from the address Cognito validated, so they can
 *   never disagree about an address.
 *
 * handlers/preSignUp/emailPolicy.ts re-exports everything the filter used to define there.
 */

// ─── Rejections (C2 3.5; copy per integration plan X11 and decision 5A) ───────

export const DISPOSABLE_DOMAIN_REASON = "disposable_domain";
export const EMAIL_VARIANT_REASON = "email_variant_exists";

/**
 * Thrown as the error message under enforce. Cognito answers
 * "PreSignUp failed with error <message>." (it appends the period). Build 1.0 shows that text; R2
 * parses it with the trailing period removed. No "Please" (5A).
 */
export const DISPOSABLE_EMAIL_MESSAGE =
  "Use a permanent email address. Temporary email services can't be used for Billboard accounts.";
export const EMAIL_VARIANT_MESSAGE =
  "An account already uses this email address (addresses that differ only by a +tag or dots count as the same). " +
  "Sign in or reset your password.";

/** What Cognito puts before a pre-sign-up trigger's error message (UserLambdaValidationException). */
export const PRE_SIGN_UP_ERROR_PREFIX = "PreSignUp failed with error ";

/**
 * The trigger's own message inside Cognito's "PreSignUp failed with error <message>.", or null when the text
 * is not that wrapper. Exactly one trailing period is removed: the one Cognito appends. The filter's own
 * messages end with a period too, so a refusal reads "...password.." and comes back as "...password.".
 */
export const refusalMessageOf = (text: unknown): string | null => {
  if (typeof text !== "string" || !text.startsWith(PRE_SIGN_UP_ERROR_PREFIX)) return null;
  const message = text.slice(PRE_SIGN_UP_ERROR_PREFIX.length);
  return message.endsWith(".") ? message.slice(0, -1) : message;
};

// ─── Addresses ────────────────────────────────────────────────────────────────

export interface ParsedEmail {
  /** Lower-case local part as given (with any +tag and dots). */
  local: string;
  /** Lower-case ASCII (punycode) domain, without a trailing dot. */
  domain: string;
  /** The base address: one account per base address. */
  base: string;
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const LOCAL_PATTERN = /^[^\s@"]{1,64}$/;
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** a+news@x.com -> a@x.com; A.B+x@googlemail.com -> ab@gmail.com. Expects a lower-case local and domain. */
export const baseEmailAddress = (local: string, domain: string): string => {
  const plus = local.indexOf("+");
  // A local part that starts with "+" is kept whole: cutting it would leave nothing.
  let baseLocal = plus > 0 ? local.slice(0, plus) : local;
  let baseDomain = domain;
  if (GMAIL_DOMAINS.has(domain)) {
    baseLocal = baseLocal.replace(/\./g, "") || baseLocal;
    baseDomain = "gmail.com";
  }
  return `${baseLocal}@${baseDomain}`;
};

/**
 * Parses an address into its lower-case parts and base address, or null when it is not a plain
 * local@domain address (Cognito validates the format itself, so the caller allows those).
 */
export const parseEmailAddress = (value: unknown): ParsedEmail | null => {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;

  const local = address.slice(0, at);
  if (!LOCAL_PATTERN.test(local)) return null;

  const domain = domainToASCII(address.slice(at + 1).replace(/\.$/, ""));
  if (!domain || !DOMAIN_PATTERN.test(domain)) return null;

  return { local, domain, base: baseEmailAddress(local, domain) };
};

// ─── SignUpEmailClaims layout (integration plan X5; CB-07) ────────────────────

/**
 * Table `SignUpEmailClaims`, partition key `pk`, no sort key:
 *   EMAIL#<emailKey>  { userName, claimedAt, addressKey, holders, revision }   who holds the base address
 *                     (or { releasedAt, revision } once released)
 *   USER#<userName>   { emailKey, claimedAt }   lets account deletion find and release the claim
 *   PROBE#base, PROBE#variant                     the filter check's probe records (SignUpProbeRecord)
 *
 * An EMAIL# item records every sign-up attempt that currently holds the base address, all under one exact
 * address: `holders` maps each attempt's userName to its claimedAt (at most MAX_CLAIM_HOLDERS), `addressKey` is
 * the key of that exact address, `userName` and `claimedAt` name the latest attempt (or the attempt that became the
 * account, once a sign-up finds it live), and `revision` is a random value replaced on every write, which the
 * writers compare against what they read. Cognito runs PreSignUp before it checks the password, so a retry of a
 * sign-up Cognito then refused finds the first attempt's claim: the same exact address joins the holders instead
 * of counting as a variant.
 *
 * An item written before `holders` existed has only { userName, claimedAt } (or { releasedAt }): readEmailClaim
 * reads it as one holder with no addressKey, so a retry is never recognised on it, as before.
 */
export const SIGNUP_EMAIL_CLAIMS_PARTITION_KEY = "pk";
export const emailClaimKey = (emailKey: string): string => `EMAIL#${emailKey}`;
export const userClaimKey = (userName: string): string => `USER#${userName}`;

/**
 * Most sign-up attempts one EMAIL# item records. It bounds the item and the AdminGetUser lookups a later
 * sign-up on the base address makes; a retry that would go past it counts as a variant (claim detail
 * holder_limit).
 */
export const MAX_CLAIM_HOLDERS = 8;

/** An EMAIL# item as read, in the current layout whatever layout it was written in. */
export interface EmailClaim {
  /** The latest attempt holding the base address; absent on a released item. */
  userName?: string;
  claimedAt?: string;
  /** Key of the exact address the holders signed up with; absent on an item written before it existed. */
  addressKey?: string;
  /** userName -> claimedAt of every attempt holding the base address (empty on a released item). */
  holders: Record<string, string>;
  /** Absent on an item written before it existed. */
  revision?: string;
}

/** An EMAIL# item as DynamoDB returns it (AttributeValues), or as a reader that only looks at strings types it. */
export type EmailClaimItem = Record<string, { S?: string; M?: Record<string, { S?: string }> } | undefined>;

/**
 * The EMAIL# item's claim, or null when there is no item. A legacy item's one holder is its userName; an
 * item whose holders lack its userName gets it added (a holder is never lost to a malformed map).
 */
export const readEmailClaim = (item: EmailClaimItem | undefined): EmailClaim | null => {
  if (!item) return null;
  const text = (value: { S?: string } | undefined): string | undefined =>
    typeof value?.S === "string" && value.S !== "" ? value.S : undefined;
  const userName = text(item.userName);
  const claimedAt = text(item.claimedAt);
  const holders: Record<string, string> = {};
  for (const [holder, value] of Object.entries(item.holders?.M ?? {})) {
    if (holder) holders[holder] = value?.S ?? "";
  }
  if (userName && !Object.hasOwn(holders, userName)) holders[userName] = claimedAt ?? "";
  const claim: EmailClaim = { holders };
  if (userName) claim.userName = userName;
  if (claimedAt) claim.claimedAt = claimedAt;
  const addressKey = text(item.addressKey);
  if (addressKey) claim.addressKey = addressKey;
  const revision = text(item.revision);
  if (revision) claim.revision = revision;
  return claim;
};

/** Whether an EMAIL# item names the account: as its userName or as one of its holders. */
export const emailClaimNames = (item: EmailClaimItem | undefined, userName: string): boolean => {
  const claim = readEmailClaim(item);
  return claim !== null && Object.hasOwn(claim.holders, userName);
};

/**
 * UNCONFIRMED_CLAIM_LIFETIME_MS: an UNCONFIRMED account older than this no longer holds its base address.
 * PENDING_CLAIM_WINDOW_MS: a claim written this recently may belong to a sign-up still in progress.
 * Both live in abuseLimits.ts.
 */
export { PENDING_CLAIM_WINDOW_MS, UNCONFIRMED_CLAIM_LIFETIME_MS };

// ─── The filter check's probe (CB-07) ─────────────────────────────────────────

/**
 * The only domain a check address may be on: the project's own, whose mailbox the project controls in
 * Microsoft 365, so nobody else can ever confirm an account at a probe address. Checked at run time by both
 * functions, not only by the infra test that pins the constant.
 */
export const PROJECT_EMAIL_DOMAIN = "billboard-project.com";

/** The +tag the check gives its variant sign-up: "r", the UTC date (yyyymmdd) and random base36 characters. */
export const RUN_TAG_PATTERN = /^r[0-9a-z]{8,24}$/;
const RUN_TAG_MAX_LENGTH = 25;
const LOCAL_MAX_LENGTH = 64;

export interface SignUpFilterCheckAddress {
  /** The base check address, lower case, for example probe@billboard-project.com. */
  address: string;
  local: string;
  domain: string;
}

/**
 * A check address, or null when the value is not one: it must be lower case, have no "+", be its own base
 * address, be on PROJECT_EMAIL_DOMAIN, and leave room in the 64-character local part for "+" and a run tag.
 */
export const parseSignUpFilterCheckAddress = (value: unknown): SignUpFilterCheckAddress | null => {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (!address || address !== address.toLowerCase() || address.includes("+")) return null;
  const parsed = parseEmailAddress(address);
  if (!parsed || parsed.base !== address || parsed.domain !== PROJECT_EMAIL_DOMAIN) return null;
  if (parsed.local.length + 1 + RUN_TAG_MAX_LENGTH > LOCAL_MAX_LENGTH) return null;
  return { address, local: parsed.local, domain: parsed.domain };
};

/** SIGNUP_FILTER_CHECK_ADDRESS, as both PreSignUpCheck and SignUpFilterCheck read it. */
export const signUpFilterCheckAddress = (env: NodeJS.ProcessEnv = process.env): SignUpFilterCheckAddress | null =>
  parseSignUpFilterCheckAddress(env.SIGNUP_FILTER_CHECK_ADDRESS);

export type ProbeKind = "base" | "variant";

/**
 * Whether an address is one of the check's probes, and which: "base" when its local part is the check
 * address's, "variant" for any other address with the same base address (any +tag, an empty one included).
 * Parsed exactly as the filter parses it (lower case, trailing dot removed, punycode), so a mixed-case or
 * trailing-dot address is a probe too. The pool is case-sensitive: such an address is its own Cognito user.
 */
export const probeKindOf = (value: unknown, check: SignUpFilterCheckAddress | null): ProbeKind | null => {
  if (!check) return null;
  const parsed = parseEmailAddress(value);
  if (!parsed || parsed.base !== check.address) return null;
  return parsed.local === check.local ? "base" : "variant";
};

export const isProbeAddress = (value: unknown, check: SignUpFilterCheckAddress | null): boolean =>
  probeKindOf(value, check) !== null;

/** A variant's +tag when it is a run tag, else "other" (the address itself is never stored). */
export const probeTagOf = (value: unknown): string => {
  const local = parseEmailAddress(value)?.local ?? "";
  const plus = local.indexOf("+");
  const tag = plus >= 0 ? local.slice(plus + 1) : "";
  return RUN_TAG_PATTERN.test(tag) ? tag : "other";
};

export const PROBE_RECORD_KEYS: Readonly<Record<ProbeKind, string>> = {
  base: "PROBE#base",
  variant: "PROBE#variant",
};

/** One check's result, as the probe record keeps it. */
export interface ProbeCheckEntry {
  check: string;
  result: string;
  reason?: string;
  /** emailBase's claim outcome: claimed, renewed, retried, taken_over or variant_exists. */
  claim?: string;
  /** commit or release, when the entry is that step's error. */
  phase?: string;
  errorKind?: string;
}

/**
 * What PreSignUpCheck saw for a probe sign-up, written to PROBE#<kind> (overwritten by each probe) after its
 * summary line and before an enforce refusal is thrown. The check compares it with its own SignUp result.
 */
export interface SignUpProbeRecord {
  kind: ProbeKind;
  /** The trigger's userName (the account's sub in this pool). */
  userName: string;
  /** ISO time the invocation started. */
  at: string;
  /** The filter's own reading of SIGNUP_FILTER_MODE during this invocation. */
  mode: "watch" | "enforce";
  outcome: "allowed" | "rejected";
  rejectedBy?: string;
  reason?: string;
  checks: ProbeCheckEntry[];
  requestId?: string;
  /** Variant only: the run tag, or "other". */
  tag?: string;
  /**
   * The account that held the base address before this sign-up, when it was another one (emailBase's hit,
   * or a take-over). Only probe-address accounts can hold a probe's base address.
   */
  holder?: string;
}

const ENTRY_FIELDS = ["check", "result", "reason", "claim", "phase", "errorKind"] as const;

const optionalString = (name: string, value: string | undefined): Record<string, AttributeValue> =>
  value === undefined || value === "" ? {} : { [name]: { S: value } };

export const toProbeRecordItem = (record: SignUpProbeRecord): Record<string, AttributeValue> => ({
  [SIGNUP_EMAIL_CLAIMS_PARTITION_KEY]: { S: PROBE_RECORD_KEYS[record.kind] },
  kind: { S: record.kind },
  userName: { S: record.userName },
  at: { S: record.at },
  mode: { S: record.mode },
  outcome: { S: record.outcome },
  ...optionalString("rejectedBy", record.rejectedBy),
  ...optionalString("reason", record.reason),
  checks: {
    L: record.checks.map((entry) => ({
      M: Object.fromEntries(
        ENTRY_FIELDS.filter((field) => typeof entry[field] === "string" && entry[field] !== "").map((field) => [
          field,
          { S: entry[field] as string },
        ]),
      ),
    })),
  },
  ...optionalString("requestId", record.requestId),
  ...optionalString("tag", record.tag),
  ...optionalString("holder", record.holder),
});

/** The record in an item, or null when the item is not a well-formed probe record. */
export const fromProbeRecordItem = (item: Record<string, AttributeValue> | undefined): SignUpProbeRecord | null => {
  if (!item) return null;
  const text = (name: string): string | undefined => {
    const value = item[name]?.S;
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const kind = text("kind");
  const userName = text("userName");
  const at = text("at");
  const mode = text("mode");
  const outcome = text("outcome");
  if (kind !== "base" && kind !== "variant") return null;
  if (!userName || !at || !Number.isFinite(Date.parse(at))) return null;
  if (mode !== "watch" && mode !== "enforce") return null;
  if (outcome !== "allowed" && outcome !== "rejected") return null;
  const checks: ProbeCheckEntry[] = (item.checks?.L ?? []).flatMap((value) => {
    const fields = value.M;
    const check = fields?.check?.S;
    const result = fields?.result?.S;
    if (!fields || !check || !result) return [];
    const entry: ProbeCheckEntry = { check, result };
    for (const field of ENTRY_FIELDS) {
      const fieldValue = fields[field]?.S;
      if (fieldValue !== undefined && field !== "check" && field !== "result") entry[field] = fieldValue;
    }
    return [entry];
  });
  const record: SignUpProbeRecord = { kind, userName, at, mode, outcome, checks };
  for (const name of ["rejectedBy", "reason", "requestId", "tag", "holder"] as const) {
    const value = text(name);
    if (value !== undefined) record[name] = value;
  }
  return record;
};
