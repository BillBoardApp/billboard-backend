import * as abuseLimits from "../shared/abuseLimits";
import * as emailPolicy from "../handlers/preSignUp/emailPolicy";
import {
  DISPOSABLE_EMAIL_MESSAGE,
  EMAIL_VARIANT_MESSAGE,
  PROBE_RECORD_KEYS,
  PROJECT_EMAIL_DOMAIN,
  RUN_TAG_PATTERN,
  fromProbeRecordItem,
  isProbeAddress,
  parseSignUpFilterCheckAddress,
  probeKindOf,
  probeTagOf,
  refusalMessageOf,
  signUpFilterCheckAddress,
  toProbeRecordItem,
  type SignUpProbeRecord,
} from "../shared/signUpFilter";
import * as shared from "../shared/signUpFilter";

/*
 * shared/signUpFilter.ts: the filter's vocabulary without its domain list (CB-07). PreSignUpCheck and
 * SignUpFilterCheck decide "is this a probe" with the same functions; these tests pin them.
 */

const CHECK = parseSignUpFilterCheckAddress("filter-probe@billboard-project.com")!;

describe("moved out of emailPolicy.ts unchanged", () => {
  it.each([
    "DISPOSABLE_DOMAIN_REASON",
    "EMAIL_VARIANT_REASON",
    "DISPOSABLE_EMAIL_MESSAGE",
    "EMAIL_VARIANT_MESSAGE",
    "SIGNUP_EMAIL_CLAIMS_PARTITION_KEY",
    "UNCONFIRMED_CLAIM_LIFETIME_MS",
    "PENDING_CLAIM_WINDOW_MS",
    "parseEmailAddress",
    "baseEmailAddress",
    "emailClaimKey",
    "userClaimKey",
    "MAX_CLAIM_HOLDERS",
    "readEmailClaim",
    "emailClaimNames",
  ] as const)("emailPolicy re-exports %s as the same value", (name) => {
    expect(emailPolicy[name]).toBe(shared[name]);
  });

  it("keeps the messages, reasons and windows as before", () => {
    expect(shared.DISPOSABLE_DOMAIN_REASON).toBe("disposable_domain");
    expect(shared.EMAIL_VARIANT_REASON).toBe("email_variant_exists");
    expect(shared.UNCONFIRMED_CLAIM_LIFETIME_MS).toBe(abuseLimits.UNCONFIRMED_CLAIM_LIFETIME_MS);
    expect(shared.PENDING_CLAIM_WINDOW_MS).toBe(abuseLimits.PENDING_CLAIM_WINDOW_MS);
    expect(shared.emailClaimKey("k")).toBe("EMAIL#k");
    expect(shared.userClaimKey("u")).toBe("USER#u");
  });
});

describe("EMAIL# items (readEmailClaim, emailClaimNames)", () => {
  const AT = "2026-11-03T12:00:00.000Z";

  it("reads the current layout", () => {
    const item = {
      pk: { S: "EMAIL#k" },
      userName: { S: "b" },
      claimedAt: { S: AT },
      addressKey: { S: "ak" },
      holders: { M: { a: { S: "2026-11-03T11:59:58.000Z" }, b: { S: AT } } },
      revision: { S: "rev-1" },
    };
    expect(shared.readEmailClaim(item)).toEqual({
      userName: "b",
      claimedAt: AT,
      addressKey: "ak",
      holders: { a: "2026-11-03T11:59:58.000Z", b: AT },
      revision: "rev-1",
    });
    expect(shared.emailClaimNames(item, "a")).toBe(true);
    expect(shared.emailClaimNames(item, "b")).toBe(true);
    expect(shared.emailClaimNames(item, "c")).toBe(false);
  });

  it("reads an item written before holders existed as one holder without an address key or revision", () => {
    const item = { pk: { S: "EMAIL#k" }, userName: { S: "a" }, claimedAt: { S: AT } };
    expect(shared.readEmailClaim(item)).toEqual({ userName: "a", claimedAt: AT, holders: { a: AT } });
    expect(shared.emailClaimNames(item, "a")).toBe(true);
  });

  it("reads a released item, or none, as naming no account", () => {
    const released = { pk: { S: "EMAIL#k" }, releasedAt: { S: AT } };
    expect(shared.readEmailClaim(released)).toEqual({ holders: {} });
    expect(shared.readEmailClaim(undefined)).toBeNull();
    expect(shared.emailClaimNames(released, "a")).toBe(false);
    expect(shared.emailClaimNames(undefined, "a")).toBe(false);
  });

  it("never loses the named holder, and never matches an inherited property name", () => {
    const item = { userName: { S: "b" }, claimedAt: { S: AT }, holders: { M: { a: { S: AT } } } };
    expect(shared.readEmailClaim(item)?.holders).toEqual({ a: AT, b: AT });
    expect(shared.emailClaimNames(item, "toString")).toBe(false);
    expect(shared.MAX_CLAIM_HOLDERS).toBeGreaterThanOrEqual(2);
  });
});

describe("refusalMessageOf", () => {
  it("removes Cognito's prefix and exactly one trailing period", () => {
    expect(refusalMessageOf(`PreSignUp failed with error ${EMAIL_VARIANT_MESSAGE}.`)).toBe(EMAIL_VARIANT_MESSAGE);
    expect(EMAIL_VARIANT_MESSAGE.endsWith(".")).toBe(true);
    expect(refusalMessageOf(`PreSignUp failed with error ${DISPOSABLE_EMAIL_MESSAGE}.`)).toBe(DISPOSABLE_EMAIL_MESSAGE);
    expect(refusalMessageOf("PreSignUp failed with error APP_UPDATE_REQUIRED.")).toBe("APP_UPDATE_REQUIRED");
    expect(refusalMessageOf("PreSignUp failed with error NO_PERIOD")).toBe("NO_PERIOD");
  });

  it("is null for anything that is not the wrapper", () => {
    expect(refusalMessageOf("An account with the given email already exists.")).toBeNull();
    expect(refusalMessageOf(undefined)).toBeNull();
    expect(refusalMessageOf(42)).toBeNull();
  });
});

describe("the check address", () => {
  it("accepts a lower-case address on the project domain, with room for a run tag", () => {
    expect(CHECK).toEqual({
      address: "filter-probe@billboard-project.com",
      local: "filter-probe",
      domain: PROJECT_EMAIL_DOMAIN,
    });
    expect(parseSignUpFilterCheckAddress("  filter-probe@billboard-project.com ")).toEqual(CHECK);
    expect(parseSignUpFilterCheckAddress(`${"a".repeat(38)}@billboard-project.com`)).not.toBeNull();
  });

  it.each([
    ["upper case", "Filter-Probe@billboard-project.com"],
    ["a +tag", "filter-probe+x@billboard-project.com"],
    ["gmail.com", "filterprobe@gmail.com"],
    ["googlemail.com", "filterprobe@googlemail.com"],
    ["another domain", "filter-probe@example.com"],
    ["a subdomain of the project's", "filter-probe@mail.billboard-project.com"],
    ["a look-alike domain", "filter-probe@billboard-project.com.evil.example"],
    ["a trailing dot", "filter-probe@billboard-project.com."],
    ["no room for a run tag", `${"a".repeat(39)}@billboard-project.com`],
    ["no local part", "@billboard-project.com"],
    ["not an address", "filter-probe"],
    ["empty", ""],
    ["unset", undefined],
  ])("refuses %s", (_label, value) => {
    expect(parseSignUpFilterCheckAddress(value)).toBeNull();
    expect(signUpFilterCheckAddress({ SIGNUP_FILTER_CHECK_ADDRESS: value })).toBeNull();
  });
});

describe("probeKindOf", () => {
  it.each([
    ["filter-probe@billboard-project.com", "base"],
    ["Filter-Probe@Billboard-Project.COM", "base"],
    ["filter-probe@billboard-project.com.", "base"],
    [" filter-probe@billboard-project.com ", "base"],
    ["filter-probe+r20261017abcd@billboard-project.com", "variant"],
    ["FILTER-PROBE+News@billboard-project.com", "variant"],
    ["filter-probe+@billboard-project.com", "variant"],
    ["filter-probe+a+b@billboard-project.com", "variant"],
  ] as const)("%s is %s", (address, kind) => {
    expect(probeKindOf(address, CHECK)).toBe(kind);
    expect(isProbeAddress(address, CHECK)).toBe(true);
  });

  it.each([
    "filter-prober@billboard-project.com",
    "filter-probe@billboard-project.com.evil.example",
    "filter-probe@other.example",
    "filter.probe@billboard-project.com",
    "admin+filter-probe@billboard-project.com",
    "+filter-probe@billboard-project.com",
    "admin@billboard-project.com",
    "not an address",
    "",
  ])("%p is no probe", (address) => {
    expect(probeKindOf(address, CHECK)).toBeNull();
    expect(isProbeAddress(address, CHECK)).toBe(false);
  });

  it("nothing is a probe without a check address", () => {
    expect(probeKindOf("filter-probe@billboard-project.com", null)).toBeNull();
    expect(probeKindOf(undefined, CHECK)).toBeNull();
    expect(probeKindOf(42, CHECK)).toBeNull();
  });
});

describe("run tags", () => {
  it("are r, then 8 to 24 lower-case letters or digits", () => {
    expect(RUN_TAG_PATTERN.test("r20261017abcd")).toBe(true);
    expect(RUN_TAG_PATTERN.test(`r${"a".repeat(24)}`)).toBe(true);
    expect(RUN_TAG_PATTERN.test(`r${"a".repeat(25)}`)).toBe(false);
    expect(RUN_TAG_PATTERN.test("r2026101")).toBe(false);
    expect(RUN_TAG_PATTERN.test("R20261017ABCD")).toBe(false);
    expect(RUN_TAG_PATTERN.test("x20261017abcd")).toBe(false);
  });

  it.each([
    ["filter-probe+r20261017abcd@billboard-project.com", "r20261017abcd"],
    ["filter-probe+R20261017ABCD@billboard-project.com", "r20261017abcd"],
    ["filter-probe+news@billboard-project.com", "other"],
    ["filter-probe+@billboard-project.com", "other"],
    ["filter-probe@billboard-project.com", "other"],
    ["filter-probe+r20261017abcd+x@billboard-project.com", "other"],
  ])("probeTagOf(%s) is %s", (address, tag) => {
    expect(probeTagOf(address)).toBe(tag);
  });
});

describe("probe records", () => {
  const record: SignUpProbeRecord = {
    kind: "variant",
    userName: "6c1e8a52-0000-4000-8000-000000000001",
    at: "2026-10-17T11:30:00.000Z",
    mode: "enforce",
    outcome: "rejected",
    rejectedBy: "emailBase",
    reason: "email_variant_exists",
    checks: [
      { check: "disposableDomain", result: "allow" },
      { check: "emailBase", result: "hit", reason: "email_variant_exists", claim: "variant_exists" },
      { check: "appAttest", result: "error", errorKind: "timeout", phase: "release" },
    ],
    requestId: "req-1",
    tag: "r20261017abcd",
    holder: "6c1e8a52-0000-4000-8000-000000000002",
  };

  it("round-trip through their item", () => {
    const item = toProbeRecordItem(record);
    expect(item.pk).toEqual({ S: PROBE_RECORD_KEYS.variant });
    expect(fromProbeRecordItem(item)).toEqual(record);
  });

  it("leave out the fields a base record does not have", () => {
    const base: SignUpProbeRecord = {
      kind: "base",
      userName: "u",
      at: record.at,
      mode: "watch",
      outcome: "allowed",
      checks: [],
    };
    const item = toProbeRecordItem(base);
    expect(Object.keys(item).sort()).toEqual(["at", "checks", "kind", "mode", "outcome", "pk", "userName"]);
    expect(item.pk).toEqual({ S: "PROBE#base" });
    expect(fromProbeRecordItem(item)).toEqual(base);
  });

  it.each([
    ["no item", undefined],
    ["an unknown kind", { ...toProbeRecordItem(record), kind: { S: "other" } }],
    ["no userName", { ...toProbeRecordItem(record), userName: { S: "" } }],
    ["an unreadable time", { ...toProbeRecordItem(record), at: { S: "yesterday" } }],
    ["an unknown mode", { ...toProbeRecordItem(record), mode: { S: "off" } }],
    ["an unknown outcome", { ...toProbeRecordItem(record), outcome: { S: "maybe" } }],
  ])("read %s as no record", (_label, item) => {
    expect(fromProbeRecordItem(item)).toBeNull();
  });

  it("skip malformed check entries", () => {
    const item = toProbeRecordItem(record);
    item.checks = { L: [{ M: { check: { S: "emailBase" } } }, { S: "junk" }, ...(item.checks.L ?? [])] };
    expect(fromProbeRecordItem(item)?.checks).toEqual(record.checks);
  });
});
