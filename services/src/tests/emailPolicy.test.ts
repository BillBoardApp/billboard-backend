import { createHash } from "node:crypto";

import {
  ALLOWLIST_FILE,
  BLOCKLIST_FILE,
  GENERATED_FILE,
  UPSTREAM_REPOSITORY,
  blockedGuardDomains,
  isCommitSha,
  parseArgs,
  parseDomainList,
  renderGeneratedModule,
  runUpdate,
  sha256Hex,
  upstreamUrl,
  UpstreamFileNotFound,
} from "../../scripts/updateDisposableDomains";
import {
  DISPOSABLE_DOMAINS_SOURCE,
  DISPOSABLE_EMAIL_ALLOWLIST,
  DISPOSABLE_EMAIL_BLOCKLIST,
} from "../handlers/preSignUp/disposableDomains.generated";
import {
  DEFAULT_DOMAIN_LISTS,
  DISPOSABLE_EMAIL_MESSAGE,
  EMAIL_VARIANT_MESSAGE,
  EXTRA_ALLOWED_DOMAINS,
  EXTRA_BLOCKED_DOMAINS,
  GUARD_DOMAINS,
  MAX_CLAIM_HOLDERS,
  PENDING_CLAIM_WINDOW_MS,
  UNCONFIRMED_CLAIM_LIFETIME_MS,
  addressKeyFor,
  baseEmailAddress,
  buildDomainLists,
  claimWithoutHolder,
  decideClaim,
  domainSuffixes,
  emailClaimKey,
  emailKeyFor,
  holdersToLookUp,
  isDisposableDomain,
  isLiveClaimHolder,
  isPendingClaim,
  matchDisposableDomain,
  nextHolderLookups,
  parseEmailAddress,
  userClaimKey,
  type EmailClaim,
  type HolderLookup,
} from "../handlers/preSignUp/emailPolicy";

/*
 * INT-05 email policy (C2 3.5 and 6.1; integration plan X5, X11) and the blocklist update script
 * (`npm run update:disposable-domains`). Pure functions; the update script's download and write are
 * injected.
 */

describe("parseEmailAddress", () => {
  it("lower-cases and trims, and keeps the given local part", () => {
    expect(parseEmailAddress("  Jane.Doe+News@Example.COM ")).toEqual({
      local: "jane.doe+news",
      domain: "example.com",
      base: "jane.doe@example.com",
    });
  });

  it("drops a trailing dot on the domain and converts an internationalized domain to punycode", () => {
    expect(parseEmailAddress("a@example.com.")?.domain).toBe("example.com");
    expect(parseEmailAddress("a@bücher.example")?.domain).toBe("xn--bcher-kva.example");
  });

  it.each([
    [undefined],
    [null],
    [42],
    [""],
    ["no-at-sign"],
    ["@example.com"],
    ["a@"],
    ["a b@example.com"],
    ['"quoted"@example.com'],
    ["a@localhost"],
    ["a@exa mple.com"],
    ["a@-bad.com"],
    ["a@bad..com"],
    [`${"x".repeat(65)}@example.com`],
  ])("returns null for %p (Cognito validates the format; the checks allow it)", (value) => {
    expect(parseEmailAddress(value)).toBeNull();
  });
});

describe("baseEmailAddress (plus-addressing allowed, counted as the base address)", () => {
  it("cuts the local part at the first +", () => {
    expect(baseEmailAddress("a+news", "x.com")).toBe("a@x.com");
    expect(baseEmailAddress("a+news+more", "x.com")).toBe("a@x.com");
    expect(baseEmailAddress("a", "x.com")).toBe("a@x.com");
  });

  it("keeps a local part that starts with + whole (cutting would leave nothing)", () => {
    expect(baseEmailAddress("+tag", "x.com")).toBe("+tag@x.com");
  });

  it("removes dots for gmail.com and googlemail.com and maps both to gmail.com", () => {
    expect(baseEmailAddress("j.a.n.e", "gmail.com")).toBe("jane@gmail.com");
    expect(baseEmailAddress("j.ane+x.y", "googlemail.com")).toBe("jane@gmail.com");
  });

  it("keeps dots for every other domain", () => {
    expect(baseEmailAddress("j.ane", "outlook.com")).toBe("j.ane@outlook.com");
    expect(baseEmailAddress("j.ane", "mail.gmail.com")).toBe("j.ane@mail.gmail.com");
  });

  it("gives every variant of one Gmail address the same base", () => {
    const bases = ["Jane.Doe@gmail.com", "janedoe+billboard@gmail.com", "J.A.N.E.D.O.E@GoogleMail.com"].map(
      (address) => parseEmailAddress(address)?.base,
    );
    expect(new Set(bases)).toEqual(new Set(["janedoe@gmail.com"]));
  });
});

describe("emailKeyFor", () => {
  it("is the hex SHA-256 of '<salt>:email:v1:<base>' (DistrictVerification's hash form)", () => {
    const expected = createHash("sha256").update("salt-1:email:v1:a@x.com").digest("hex");
    expect(emailKeyFor("a@x.com", "salt-1")).toBe(expected);
    expect(emailKeyFor("a@x.com", "salt-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the salt and never contains the address", () => {
    expect(emailKeyFor("a@x.com", "salt-1")).not.toBe(emailKeyFor("a@x.com", "salt-2"));
    expect(emailKeyFor("a@x.com", "salt-1")).not.toContain("x.com");
  });

  it("refuses to hash without a salt", () => {
    expect(() => emailKeyFor("a@x.com", "")).toThrow("salt");
  });
});

describe("addressKeyFor", () => {
  it("is the hex SHA-256 of '<salt>:email-address:v1:<address>', the address exactly as given", () => {
    const expected = createHash("sha256").update("salt-1:email-address:v1:Jane.Doe+x@Example.com").digest("hex");
    expect(addressKeyFor("Jane.Doe+x@Example.com", "salt-1")).toBe(expected);
  });

  it("tells apart what Cognito tells apart (letter case, +tags, dots) and never equals an email key", () => {
    const keys = ["jane@x.com", "Jane@x.com", "jane+1@x.com", "j.ane@x.com"].map((address) =>
      addressKeyFor(address, "salt-1"),
    );
    expect(new Set(keys).size).toBe(4);
    expect(addressKeyFor("a@x.com", "salt-1")).not.toBe(emailKeyFor("a@x.com", "salt-1"));
    expect(addressKeyFor("a@x.com", "salt-1")).not.toBe(addressKeyFor("a@x.com", "salt-2"));
    expect(addressKeyFor("a@x.com", "salt-1")).not.toContain("x.com");
  });

  it("refuses to hash without a salt", () => {
    expect(() => addressKeyFor("a@x.com", "")).toThrow("salt");
  });
});

describe("decideClaim (emailBase)", () => {
  const NOW = Date.parse("2026-11-03T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const NOW_ISO = ago(0);
  const K = "address-key";
  const claimOf = (holders: Record<string, string>, extra: Partial<EmailClaim> = {}): EmailClaim => {
    const [userName, claimedAt] = Object.entries(holders).sort(([, a], [, b]) => (a < b ? 1 : -1))[0];
    return { userName, claimedAt, addressKey: K, holders, revision: "rev", ...extra };
  };
  const decide = (
    claim: EmailClaim | null,
    lookups: Record<string, HolderLookup> = {},
    options: { userName?: string; addressKey?: string } = {},
  ) =>
    decideClaim({
      claim,
      userName: options.userName ?? "new",
      addressKey: options.addressKey ?? K,
      lookups: new Map(Object.entries(lookups)),
      now: NOW,
    });

  it("claims a missing or released base address", () => {
    expect(decide(null)).toEqual({ outcome: "claimed", holders: { new: NOW_ISO }, addressKey: K });
    expect(decide({ holders: {} })).toEqual({ outcome: "claimed", holders: { new: NOW_ISO }, addressKey: K });
  });

  it("renews a claim that already names the sign-up, keeping the other holders and the claim's address", () => {
    const claim = claimOf({ a: ago(5_000), new: ago(1_000) });
    expect(holdersToLookUp(claim, "new")).toEqual([]);
    expect(decide(claim)).toEqual({ outcome: "renewed", holders: { a: ago(5_000), new: NOW_ISO }, addressKey: K });
    // A legacy claim gets the sign-up's own address.
    expect(decide({ userName: "new", claimedAt: ago(1_000), holders: { new: ago(1_000) } })).toMatchObject({
      outcome: "renewed",
      addressKey: K,
    });
  });

  it("may look up every other holder, the sign-up itself excluded: the one the claim names first, then the newest", () => {
    expect(holdersToLookUp(claimOf({ a: ago(3_000), new: ago(2_000), b: ago(1_000) }), "new")).toEqual(["b", "a"]);
    const named = claimOf({ a: ago(3_000), b: ago(1_000), c: ago(2_000) }, { userName: "a" });
    expect(holdersToLookUp(named, "new")).toEqual(["a", "b", "c"]);
    expect(holdersToLookUp(null, "new")).toEqual([]);
    expect(holdersToLookUp({ holders: {} }, "new")).toEqual([]);
  });

  describe("nextHolderLookups: only the AdminGetUser calls the decision needs", () => {
    const next = (
      claim: EmailClaim | null,
      lookups: Record<string, HolderLookup> = {},
      options: { addressKey?: string } = {},
    ) =>
      nextHolderLookups({
        claim,
        userName: "new",
        addressKey: options.addressKey ?? K,
        lookups: new Map(Object.entries(lookups)),
        now: NOW,
      });
    const full = Object.fromEntries(Array.from({ length: MAX_CLAIM_HOLDERS }, (_, i) => [`h${i}`, ago(i * 1_000)]));

    it("none for a missing, released or own claim", () => {
      expect(next(null)).toEqual([]);
      expect(next({ holders: {} })).toEqual([]);
      expect(next(claimOf({ new: ago(1_000), a: ago(2_000) }))).toEqual([]);
    });

    it("first the holder the claim names, alone", () => {
      expect(next(claimOf(full), {}, { addressKey: "other" })).toEqual(["h0"]);
      expect(next(claimOf({ a: ago(PENDING_CLAIM_WINDOW_MS * 2) }))).toEqual(["a"]);
    });

    it("no more once a holder is live, or once a holder is pending and the address differs", () => {
      expect(next(claimOf(full), { h0: "live" })).toEqual([]);
      expect(next(claimOf(full), { h0: "missing" }, { addressKey: "other" })).toEqual([]);
      const legacy = { userName: "a", claimedAt: ago(1_000), holders: { a: ago(1_000), b: ago(2_000) } };
      expect(next(legacy, { a: "missing" })).toEqual([]);
    });

    it("the rest together when the answer still depends on them", () => {
      const room = Object.fromEntries(Object.entries(full).slice(1));
      expect(next(claimOf(room), { h1: "missing" })).toEqual(["h2", "h3", "h4", "h5", "h6", "h7"]);
      const old = claimOf({ a: ago(PENDING_CLAIM_WINDOW_MS + 2), b: ago(PENDING_CLAIM_WINDOW_MS + 1) });
      expect(next(old, { b: "missing" }, { addressKey: "other" })).toEqual(["a"]);
      expect(next(old, { a: "missing", b: "missing" }, { addressKey: "other" })).toEqual([]);
    });

    it("none for a same-address retry the holder limit refuses whatever the answers (no fan-out on a full claim)", () => {
      expect(next(claimOf(full))).toEqual([]);
      expect(decide(claimOf(full))).toEqual({ outcome: "variant_exists", holder: "h0", detail: "holder_limit" });
    });

    it("a variant of a held address costs one lookup; settled with the answers, the decision is the same as with all", () => {
      const lookups: Record<string, HolderLookup> = { h0: "missing" };
      expect(next(claimOf(full), lookups, { addressKey: "other" })).toEqual([]);
      const all = Object.fromEntries(Object.keys(full).map((name) => [name, "missing" as const]));
      expect(decide(claimOf(full), lookups, { addressKey: "other" })).toEqual(
        decide(claimOf(full), all, { addressKey: "other" }),
      );
    });
  });

  it("any live holder is a hit, even for the same address", () => {
    const claim = claimOf({ a: ago(UNCONFIRMED_CLAIM_LIFETIME_MS), b: ago(1_000) });
    expect(decide(claim, { a: "live", b: "missing" })).toEqual({ outcome: "variant_exists", holder: "a" });
  });

  it("a pending holder on the same address: retried, keeping the pending holders and dropping the rest", () => {
    const claim = claimOf({
      a: ago(2_000),
      gone: ago(PENDING_CLAIM_WINDOW_MS),
      abandoned: ago(10_000),
    });
    expect(decide(claim, { a: "missing", gone: "missing", abandoned: "inactive" })).toEqual({
      outcome: "retried",
      holders: { a: ago(2_000), new: NOW_ISO },
      addressKey: K,
    });
  });

  it("a pending holder on another address, or on a claim without addressKey, is a hit naming the pending holder", () => {
    const claim = claimOf({ a: ago(4_000), b: ago(PENDING_CLAIM_WINDOW_MS + 1) });
    expect(decide(claim, { a: "missing", b: "missing" }, { addressKey: "other" })).toEqual({
      outcome: "variant_exists",
      holder: "a",
    });
    const legacy = { userName: "a", claimedAt: ago(4_000), holders: { a: ago(4_000) } };
    expect(decide(legacy, { a: "missing" })).toEqual({ outcome: "variant_exists", holder: "a" });
  });

  it("a hit on pending holders names the claim's own holder when it is one, else the newest", () => {
    const claim = claimOf({ a: ago(4_000), b: ago(3_000), c: ago(PENDING_CLAIM_WINDOW_MS) }, { userName: "c" });
    expect(decide(claim, { a: "missing", b: "missing", c: "missing" }, { addressKey: "other" })).toEqual({
      outcome: "variant_exists",
      holder: "b",
    });
  });

  it("refuses a retry that would make more than MAX_CLAIM_HOLDERS holders (holder_limit)", () => {
    const full = Object.fromEntries(Array.from({ length: MAX_CLAIM_HOLDERS }, (_, i) => [`h${i}`, ago(i * 1_000)]));
    const missing = Object.fromEntries(Object.keys(full).map((name) => [name, "missing" as const]));
    expect(decide(claimOf(full), missing)).toEqual({ outcome: "variant_exists", holder: "h0", detail: "holder_limit" });
    const room = Object.fromEntries(Object.entries(full).slice(1));
    expect(decide(claimOf(room), missing)).toMatchObject({ outcome: "retried" });
    expect(Object.keys((decide(claimOf(room), missing) as { holders: object }).holders)).toHaveLength(
      MAX_CLAIM_HOLDERS,
    );
  });

  it("takes over when no holder holds any more, resetting the holders and the address", () => {
    const claim = claimOf({ a: ago(PENDING_CLAIM_WINDOW_MS), b: ago(PENDING_CLAIM_WINDOW_MS + 1) });
    expect(decide(claim, { a: "missing", b: "inactive" }, { addressKey: "other" })).toEqual({
      outcome: "taken_over",
      holder: "a",
      holders: { new: NOW_ISO },
      addressKey: "other",
    });
  });

  it("never takes a claim on missing data: a holder without a lookup counts as live", () => {
    expect(decide(claimOf({ a: ago(PENDING_CLAIM_WINDOW_MS * 10) }))).toEqual({
      outcome: "variant_exists",
      holder: "a",
    });
    const claim = claimOf({ a: ago(PENDING_CLAIM_WINDOW_MS * 10), b: ago(PENDING_CLAIM_WINDOW_MS * 9) });
    expect(decide(claim, { b: "missing" }, { addressKey: "other" })).toEqual({
      outcome: "variant_exists",
      holder: "a",
    });
  });

  it("counts a recent holder not looked up towards the holder limit (it is live or pending: a hit either way)", () => {
    const seven = Object.fromEntries(
      Array.from({ length: MAX_CLAIM_HOLDERS - 1 }, (_, i) => [`h${i}`, ago(i * 1_000)]),
    );
    const claim = claimOf({ ...seven, x: ago(30_000) });
    expect(decide(claim, { h0: "missing" })).toEqual({
      outcome: "variant_exists",
      holder: "h0",
      detail: "holder_limit",
    });
    // Looked up, an abandoned UNCONFIRMED account drops out and the retry fits.
    const answers = Object.fromEntries(Object.keys(seven).map((name) => [name, "missing" as const]));
    expect(decide(claim, { ...answers, x: "inactive" })).toMatchObject({ outcome: "retried" });
  });
});

describe("claimWithoutHolder (emailBase's release)", () => {
  const claim: EmailClaim = {
    userName: "c",
    claimedAt: "2026-11-03T12:00:03.000Z",
    addressKey: "k",
    holders: { a: "2026-11-03T12:00:01.000Z", b: "2026-11-03T12:00:02.000Z", c: "2026-11-03T12:00:03.000Z" },
  };

  it("is null when the sign-up was the only holder", () => {
    expect(claimWithoutHolder({ userName: "a", holders: { a: "2026-11-03T12:00:01.000Z" } }, "a")).toBeNull();
  });

  it("moves userName and claimedAt to the newest remaining holder when they named the sign-up", () => {
    expect(claimWithoutHolder(claim, "c")).toEqual({
      userName: "b",
      claimedAt: "2026-11-03T12:00:02.000Z",
      holders: { a: "2026-11-03T12:00:01.000Z", b: "2026-11-03T12:00:02.000Z" },
    });
  });

  it("keeps userName and claimedAt when they name another holder", () => {
    expect(claimWithoutHolder(claim, "a")).toEqual({
      userName: "c",
      claimedAt: "2026-11-03T12:00:03.000Z",
      holders: { b: "2026-11-03T12:00:02.000Z", c: "2026-11-03T12:00:03.000Z" },
    });
  });
});

describe("disposable domain matching", () => {
  const lists = buildDomainLists({
    blocklist: ["mailinator.com", "temp.example", "Shout.Example."],
    allowlist: ["good.temp.example"],
    extraBlocked: ["urgent.example"],
    extraAllowed: ["mailinator.com.au"],
    guard: ["gmail.com"],
  });

  it("lists suffixes from the most specific to the least", () => {
    expect(domainSuffixes("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com", "com"]);
  });

  it("blocks a listed domain and any subdomain of it (x.mailinator.com matches mailinator.com)", () => {
    expect(matchDisposableDomain("mailinator.com", lists)).toBe("mailinator.com");
    expect(matchDisposableDomain("x.mailinator.com", lists)).toBe("mailinator.com");
    expect(matchDisposableDomain("a.b.mailinator.com", lists)).toBe("mailinator.com");
  });

  it("does not block a domain that only ends with the same letters", () => {
    expect(isDisposableDomain("notmailinator.com", lists)).toBe(false);
    expect(isDisposableDomain("mailinator.com.au", lists)).toBe(false);
  });

  it("lets the most specific allowlisted domain win over a blocked parent", () => {
    expect(isDisposableDomain("temp.example", lists)).toBe(true);
    expect(isDisposableDomain("good.temp.example", lists)).toBe(false);
    expect(isDisposableDomain("x.good.temp.example", lists)).toBe(false);
    expect(isDisposableDomain("bad.temp.example", lists)).toBe(true);
  });

  it("normalizes case and a trailing dot in both the lists and the domain", () => {
    expect(isDisposableDomain("SHOUT.example.", lists)).toBe(true);
  });

  it("includes the hand-kept extra lists", () => {
    expect(isDisposableDomain("urgent.example", lists)).toBe(true);
  });

  it("never blocks a guard domain at runtime, even when a bad list names it", () => {
    const bad = buildDomainLists({ blocklist: [...GUARD_DOMAINS, "com"], allowlist: [], guard: GUARD_DOMAINS });
    for (const domain of GUARD_DOMAINS) expect(isDisposableDomain(domain, bad)).toBe(false);
  });

  it("uses the generated lists, the extras and the guard list by default", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("sub.mailinator.com")).toBe(true);
    for (const domain of GUARD_DOMAINS) expect(isDisposableDomain(domain)).toBe(false);
    for (const domain of DISPOSABLE_EMAIL_ALLOWLIST) expect(DEFAULT_DOMAIN_LISTS.allowed.has(domain)).toBe(true);
    expect(EXTRA_BLOCKED_DOMAINS.every((domain) => domain === domain.toLowerCase())).toBe(true);
    expect(EXTRA_ALLOWED_DOMAINS.every((domain) => domain === domain.toLowerCase())).toBe(true);
  });
});

describe("rejection copy (X11, 5A)", () => {
  it("has no 'Please' and states the rule", () => {
    expect(DISPOSABLE_EMAIL_MESSAGE).toBe(
      "Use a permanent email address. Temporary email services can't be used for Billboard accounts.",
    );
    expect(DISPOSABLE_EMAIL_MESSAGE).not.toMatch(/please/i);
    expect(EMAIL_VARIANT_MESSAGE).toBe(
      "An account already uses this email address (addresses that differ only by a +tag or dots count as the same). " +
        "Sign in or reset your password.",
    );
    expect(EMAIL_VARIANT_MESSAGE).not.toMatch(/please/i);
  });
});

describe("SignUpEmailClaims layout (X5)", () => {
  it("keys the claim on pk with an EMAIL# item and a USER# item", () => {
    expect(emailClaimKey("abc")).toBe("EMAIL#abc");
    expect(userClaimKey("1f0c-uuid")).toBe("USER#1f0c-uuid");
  });

  it("treats only an UNCONFIRMED account older than the claim lifetime as no longer holding its claim", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const msAgo = (ms: number) => new Date(now - ms);
    const longAgo = msAgo(1000 * 60 * 60 * 1000);
    expect(isLiveClaimHolder({ status: "CONFIRMED", createdAt: longAgo }, now)).toBe(true);
    expect(isLiveClaimHolder({ status: "FORCE_CHANGE_PASSWORD", createdAt: longAgo }, now)).toBe(true);
    expect(isLiveClaimHolder({ status: undefined, createdAt: undefined }, now)).toBe(true);
    expect(
      isLiveClaimHolder({ status: "UNCONFIRMED", createdAt: msAgo(UNCONFIRMED_CLAIM_LIFETIME_MS - 360_000) }, now),
    ).toBe(true);
    expect(isLiveClaimHolder({ status: "UNCONFIRMED", createdAt: msAgo(UNCONFIRMED_CLAIM_LIFETIME_MS) }, now)).toBe(
      false,
    );
    expect(isLiveClaimHolder({ status: "UNCONFIRMED", createdAt: undefined }, now)).toBe(true);
  });

  it("a claim whose holder Cognito cannot find holds for the pending window (a sign-up still in progress)", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    const secondsAgo = (seconds: number) => new Date(now - seconds * 1000).toISOString();
    const windowSeconds = PENDING_CLAIM_WINDOW_MS / 1000;
    expect(isPendingClaim(secondsAgo(0), now)).toBe(true);
    expect(isPendingClaim(secondsAgo(windowSeconds - 1), now)).toBe(true);
    expect(isPendingClaim(secondsAgo(windowSeconds), now)).toBe(false);
    expect(isPendingClaim(secondsAgo(-30), now)).toBe(true);
    expect(isPendingClaim(undefined, now)).toBe(false);
    expect(isPendingClaim("not a date", now)).toBe(false);
  });
});

describe("disposableDomains.generated.ts", () => {
  const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

  it("loads, holds lower-case, sorted, unique domains and contains mailinator.com", () => {
    expect(DISPOSABLE_EMAIL_BLOCKLIST).toContain("mailinator.com");
    for (const list of [DISPOSABLE_EMAIL_BLOCKLIST, DISPOSABLE_EMAIL_ALLOWLIST]) {
      expect(list.every((domain) => DOMAIN.test(domain))).toBe(true);
      expect([...list]).toEqual([...new Set(list)].sort());
    }
  });

  it("blocks no guard domain", () => {
    expect(blockedGuardDomains(DISPOSABLE_EMAIL_BLOCKLIST, DISPOSABLE_EMAIL_ALLOWLIST)).toEqual([]);
  });

  it("records its source: an upstream commit with file hashes, or the marked bootstrap seed", () => {
    expect(DISPOSABLE_DOMAINS_SOURCE.repository).toBe(UPSTREAM_REPOSITORY);
    if (DISPOSABLE_DOMAINS_SOURCE.commit === null) {
      expect(DISPOSABLE_DOMAINS_SOURCE.blocklistSha256).toBeNull();
      expect(DISPOSABLE_EMAIL_BLOCKLIST.length).toBeGreaterThanOrEqual(50);
    } else {
      expect(isCommitSha(DISPOSABLE_DOMAINS_SOURCE.commit)).toBe(true);
      expect(DISPOSABLE_DOMAINS_SOURCE.blocklistSha256).toMatch(/^[0-9a-f]{64}$/);
      // Upstream removed allowlist.conf on 2026-04-12: a pinned commit without it records no hash.
      if (DISPOSABLE_DOMAINS_SOURCE.allowlistSha256 !== null) {
        expect(DISPOSABLE_DOMAINS_SOURCE.allowlistSha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  // C2 6.1: the generated list loads with at least 1,000 domains. Runs once the file holds the upstream
  // list (after the first `npm run update:disposable-domains -- --ref <commit>`); the bootstrap seed skips it.
  (DISPOSABLE_DOMAINS_SOURCE.commit === null ? it.skip : it)("an upstream list holds at least 1,000 domains", () => {
    expect(DISPOSABLE_EMAIL_BLOCKLIST.length).toBeGreaterThanOrEqual(1000);
  });
});

describe("update:disposable-domains", () => {
  const REF = "0123456789abcdef0123456789abcdef01234567";
  const NOW = new Date("2026-10-08T12:00:00.000Z");
  const blockText = [
    "# comment",
    "MAILINATOR.com",
    "yopmail.com",
    "",
    "yopmail.com",
    "bad domain",
    "x.temp.example.",
  ].join("\n");
  const allowText = "good.example\n";

  const fetchFrom = (files: Record<string, string>) =>
    jest.fn(async (url: string) => {
      const file = Object.keys(files).find((name) => url === upstreamUrl(REF, name));
      if (file === undefined) throw new Error(`unexpected URL ${url}`);
      return files[file];
    });

  const run = (overrides: Parameters<typeof runUpdate>[1] = {}) => {
    const writeFile = jest.fn();
    const lines: string[] = [];
    const promise = runUpdate(REF, {
      fetchText: fetchFrom({ [BLOCKLIST_FILE]: blockText, [ALLOWLIST_FILE]: allowText }),
      writeFile,
      current: { blocklist: ["mailinator.com"], allowlist: [], commit: null },
      now: () => NOW,
      log: (line) => lines.push(line),
      ...overrides,
    });
    return { promise, writeFile, lines };
  };

  it("treats an allowlist.conf missing at the commit as no upstream allowlist", async () => {
    const fetchText = jest.fn(async (url: string) => {
      if (url === upstreamUrl(REF, BLOCKLIST_FILE)) return blockText;
      throw new UpstreamFileNotFound(`GET ${url} returned 404`);
    });
    const { promise, writeFile, lines } = run({ fetchText });
    const result = await promise;
    expect(result.written).toBe(true);
    expect(result.allowlistCount).toBe(0);
    const text = writeFile.mock.calls[0][1] as string;
    expect(text).toContain("allowlistSha256: null");
    expect(lines).toContainEqual(expect.stringContaining("is not in commit"));
  });

  it("still refuses when the allowlist download fails for any other reason", async () => {
    const fetchText = jest.fn(async (url: string) => {
      if (url === upstreamUrl(REF, BLOCKLIST_FILE)) return blockText;
      throw new Error(`GET ${url} returned 500`);
    });
    const { promise, writeFile } = run({ fetchText });
    await expect(promise).rejects.toThrow("returned 500");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("parses arguments", () => {
    expect(parseArgs([])).toEqual({ help: false, ref: null });
    expect(parseArgs(["--ref", REF.toUpperCase()])).toEqual({ help: false, ref: REF });
    expect(parseArgs([`--ref=${REF}`, "--help"])).toEqual({ help: true, ref: REF });
    expect(() => parseArgs(["--ref"])).toThrow("--ref needs a commit SHA");
    expect(() => parseArgs(["--apply"])).toThrow("Unknown argument: --apply");
  });

  it("parses a list: comments, blanks and duplicates dropped, lower-cased, sorted, invalid lines reported", () => {
    expect(parseDomainList(blockText)).toEqual({
      domains: ["mailinator.com", "x.temp.example", "yopmail.com"],
      invalid: ["bad domain"],
    });
  });

  it("downloads both files at the pinned commit and writes the module with the header facts", async () => {
    const { promise, writeFile, lines } = run();
    const result = await promise;

    expect(result).toMatchObject({ written: true, refused: [], blocklistCount: 3, allowlistCount: 1 });
    expect(result.added).toEqual(["x.temp.example", "yopmail.com"]);
    expect(result.removed).toEqual([]);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, text] = writeFile.mock.calls[0];
    expect(path).toBe(GENERATED_FILE);
    expect(text).toContain(`// Source: ${UPSTREAM_REPOSITORY} (CC0 1.0)`);
    expect(text).toContain(`// Commit: ${REF}`);
    expect(text).toContain("// Generated: 2026-10-08T12:00:00.000Z");
    expect(text).toContain(`// ${BLOCKLIST_FILE}: 3 domains, sha256 ${sha256Hex(blockText)}`);
    expect(text).toContain(`// ${ALLOWLIST_FILE}: 1 domains, sha256 ${sha256Hex(allowText)}`);
    expect(text).toContain(`  commit: "${REF}",`);
    expect(text).toContain('export const DISPOSABLE_EMAIL_BLOCKLIST: readonly string[] = [\n  "mailinator.com",');
    expect(text).toContain('export const DISPOSABLE_EMAIL_ALLOWLIST: readonly string[] = [\n  "good.example",\n];');
    expect(lines.some((line) => line.includes("Skipped 1 invalid line(s)"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Added: x.temp.example, yopmail.com"))).toBe(true);
  });

  it("renders the bootstrap shape (no commit, no hashes, empty arrays) deterministically", () => {
    const input = {
      repository: UPSTREAM_REPOSITORY,
      commit: null,
      generatedAt: "2026-10-08T00:00:00.000Z",
      blocklist: { name: BLOCKLIST_FILE, sha256: null, domains: [] },
      allowlist: { name: ALLOWLIST_FILE, sha256: null, domains: [] },
      note: ["", "seed"],
    };
    const text = renderGeneratedModule(input);
    expect(text).toBe(renderGeneratedModule(input));
    expect(text).toContain("// Commit: none\n");
    expect(text).toContain("//\n// seed\n");
    expect(text).toContain("  commit: null,");
    expect(text).toContain("export const DISPOSABLE_EMAIL_BLOCKLIST: readonly string[] = [];");
  });

  it("refuses a ref that is not a full commit SHA, before downloading", async () => {
    const fetchText = jest.fn();
    const writeFile = jest.fn();
    const result = await runUpdate("main", { fetchText, writeFile, log: () => undefined });
    expect(result.written).toBe(false);
    expect(result.refused[0]).toContain("full 40-character commit SHA");
    expect(fetchText).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("refuses when the blocklist shrinks by more than 20%", async () => {
    const current = Array.from({ length: 10 }, (_, index) => `old${index}.example`);
    const { promise, writeFile } = run({ current: { blocklist: current, allowlist: [], commit: REF } });
    const result = await promise;
    expect(result.written).toBe(false);
    expect(result.refused).toEqual(["the blocklist would shrink from 10 to 3 domains (more than 20%)"]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("accepts a shrink of exactly 20%", async () => {
    const current = Array.from({ length: 4 }, (_, index) => `old${index}.example`);
    const blocklist = ["a.example", "b.example", "c.example", "mailinator.com"].join("\n");
    const { promise, writeFile } = run({
      current: { blocklist: [...current, "x.example"], allowlist: [], commit: REF },
      fetchText: fetchFrom({ [BLOCKLIST_FILE]: blocklist, [ALLOWLIST_FILE]: "" }),
    });
    expect((await promise).written).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("refuses lists that would block a guard domain (directly or through a parent)", async () => {
    const { promise, writeFile } = run({
      fetchText: fetchFrom({ [BLOCKLIST_FILE]: `${blockText}\ngmail.com\nme.com`, [ALLOWLIST_FILE]: "me.com" }),
    });
    const result = await promise;
    expect(result.refused).toEqual(["the lists would block guard domain(s): gmail.com"]);
    expect(writeFile).not.toHaveBeenCalled();
    expect(blockedGuardDomains(["com"], [])).toEqual(GUARD_DOMAINS.filter((domain) => domain.endsWith(".com")));
  });

  it("refuses an empty blocklist", async () => {
    const { promise, writeFile } = run({
      current: { blocklist: [], allowlist: [], commit: null },
      fetchText: fetchFrom({ [BLOCKLIST_FILE]: "# nothing\n", [ALLOWLIST_FILE]: "" }),
    });
    expect((await promise).refused).toEqual([`${BLOCKLIST_FILE} has no domains`]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("fails when a download fails, writing nothing", async () => {
    const writeFile = jest.fn();
    await expect(
      runUpdate(REF, {
        fetchText: async () => {
          throw new Error("GET returned 404");
        },
        writeFile,
        log: () => undefined,
      }),
    ).rejects.toThrow("404");
    expect(writeFile).not.toHaveBeenCalled();
  });
});
