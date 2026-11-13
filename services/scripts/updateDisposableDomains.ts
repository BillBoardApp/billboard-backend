#!/usr/bin/env node

// Updates the disposable email domain lists the pre-sign-up trigger uses (INT-05, C2 3.5).
//
//   npm run update:disposable-domains -- --ref <40-character commit SHA>
//
// Downloads disposable_email_blocklist.conf and, if the commit still has it, allowlist.conf from
// github.com/disposable-email-domains/disposable-email-domains (CC0 1.0) at that commit and rewrites
// src/handlers/preSignUp/disposableDomains.generated.ts: two sorted string arrays plus a header with the
// source URL, the commit, the date, the counts and the SHA-256 of each downloaded file.
//
// It writes nothing, and exits with status 1, when:
//   - --ref is not a full commit SHA (a branch or tag could move under the pin);
//   - a download fails (a missing allowlist.conf is not a failure: upstream removed it on 2026-04-12,
//     and GUARD_DOMAINS plus EXTRA_ALLOWED_DOMAINS keep real providers allowed) or the blocklist is empty;
//   - the blocklist shrinks by more than 20% against the current file;
//   - the new lists would block any domain in GUARD_DOMAINS (gmail.com, outlook.com, ...).
// Prints the counts and what was added and removed. Review the diff and ship it with the next deploy
// (quarterly, or after a SignUpFilterHits alarm shows a new disposable domain getting through). For an
// urgent single domain, edit EXTRA_BLOCKED_DOMAINS / EXTRA_ALLOWED_DOMAINS in emailPolicy.ts instead.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DISPOSABLE_DOMAINS_SOURCE,
  DISPOSABLE_EMAIL_ALLOWLIST,
  DISPOSABLE_EMAIL_BLOCKLIST,
} from "../src/handlers/preSignUp/disposableDomains.generated";
import { GUARD_DOMAINS, buildDomainLists, matchDisposableDomain } from "../src/handlers/preSignUp/emailPolicy";

export const UPSTREAM_REPOSITORY = "https://github.com/disposable-email-domains/disposable-email-domains";
export const UPSTREAM_RAW_BASE = "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains";
export const BLOCKLIST_FILE = "disposable_email_blocklist.conf";
export const ALLOWLIST_FILE = "allowlist.conf";
export const GENERATED_FILE = join(__dirname, "../src/handlers/preSignUp/disposableDomains.generated.ts");

/** The update refuses a blocklist smaller than this share of the current one. */
export const MIN_KEPT_SHARE = 0.8;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const USAGE = `Usage: npm run update:disposable-domains -- --ref <commit SHA>

  --ref <sha>   Full 40-character commit SHA of ${UPSTREAM_REPOSITORY}
  --help        Show this text`;

export interface CliOptions {
  help: boolean;
  ref: string | null;
}

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { help: false, ref: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--ref") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--ref needs a commit SHA");
      options.ref = value.trim().toLowerCase();
      index += 1;
    } else if (arg.startsWith("--ref=")) options.ref = arg.slice("--ref=".length).trim().toLowerCase();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

export const isCommitSha = (ref: string): boolean => /^[0-9a-f]{40}$/.test(ref);

const DOMAIN_LINE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface ParsedList {
  domains: string[];
  /** Lines that were neither a domain, a comment nor blank (skipped and reported). */
  invalid: string[];
}

/** One domain per line; "#" starts a comment. Lower-cased, de-duplicated and sorted. */
export const parseDomainList = (text: string): ParsedList => {
  const domains = new Set<string>();
  const invalid: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim().toLowerCase().replace(/\.$/, "");
    if (!line) continue;
    if (DOMAIN_LINE.test(line)) domains.add(line);
    else invalid.push(rawLine.trim());
  }
  return { domains: [...domains].sort(), invalid };
};

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Guard domains the given lists would block (checked without the runtime guard override). */
export const blockedGuardDomains = (blocklist: readonly string[], allowlist: readonly string[]): string[] => {
  const lists = buildDomainLists({ blocklist, allowlist });
  return GUARD_DOMAINS.filter((domain) => matchDisposableDomain(domain, lists) !== null);
};

export interface ListFile {
  name: string;
  sha256: string | null;
  domains: readonly string[];
}

export interface GeneratedModuleInput {
  repository: string;
  commit: string | null;
  generatedAt: string;
  blocklist: ListFile;
  allowlist: ListFile;
  /** Extra header lines (used only by the hand-written bootstrap seed). */
  note?: readonly string[];
}

const renderArray = (name: string, domains: readonly string[]): string =>
  domains.length === 0
    ? `export const ${name}: readonly string[] = [];\n`
    : `export const ${name}: readonly string[] = [\n${domains.map((domain) => `  ${JSON.stringify(domain)},`).join("\n")}\n];\n`;

/** The text of disposableDomains.generated.ts. Deterministic for a given input. */
export const renderGeneratedModule = (input: GeneratedModuleInput): string => {
  const header = [
    "// GENERATED by `npm run update:disposable-domains -- --ref <commit>` (services/scripts/updateDisposableDomains.ts).",
    "// Do not edit by hand: hand-kept additions go in EXTRA_BLOCKED_DOMAINS / EXTRA_ALLOWED_DOMAINS in emailPolicy.ts.",
    "// Excluded from eslint and prettier.",
    "//",
    `// Source: ${input.repository} (CC0 1.0)`,
    `// Commit: ${input.commit ?? "none"}`,
    `// Generated: ${input.generatedAt}`,
    `// ${input.blocklist.name}: ${input.blocklist.domains.length} domains, sha256 ${input.blocklist.sha256 ?? "none"}`,
    `// ${input.allowlist.name}: ${input.allowlist.domains.length} domains, sha256 ${input.allowlist.sha256 ?? "none"}`,
    ...(input.note ?? []).map((line) => (line ? `// ${line}` : "//")),
  ];
  const source = [
    "export interface DisposableDomainsSource {",
    "  repository: string;",
    "  /** Upstream commit the lists were taken from; null for the hand-written bootstrap seed. */",
    "  commit: string | null;",
    "  generatedAt: string;",
    "  blocklistSha256: string | null;",
    "  allowlistSha256: string | null;",
    "}",
    "",
    "export const DISPOSABLE_DOMAINS_SOURCE: DisposableDomainsSource = {",
    `  repository: ${JSON.stringify(input.repository)},`,
    `  commit: ${JSON.stringify(input.commit)},`,
    `  generatedAt: ${JSON.stringify(input.generatedAt)},`,
    `  blocklistSha256: ${JSON.stringify(input.blocklist.sha256)},`,
    `  allowlistSha256: ${JSON.stringify(input.allowlist.sha256)},`,
    "};",
    "",
  ];
  return [
    header.join("\n"),
    "",
    source.join("\n"),
    renderArray("DISPOSABLE_EMAIL_BLOCKLIST", input.blocklist.domains),
    renderArray("DISPOSABLE_EMAIL_ALLOWLIST", input.allowlist.domains),
  ].join("\n");
};

export type FetchText = (url: string) => Promise<string>;

/** Thrown by a FetchText when the file does not exist at that commit (HTTP 404). */
export class UpstreamFileNotFound extends Error {}

const defaultFetchText: FetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (response.status === 404) throw new UpstreamFileNotFound(`GET ${url} returned 404`);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.text();
};

export const upstreamUrl = (ref: string, file: string): string => `${UPSTREAM_RAW_BASE}/${ref}/${file}`;

export interface CurrentLists {
  blocklist: readonly string[];
  allowlist: readonly string[];
  commit: string | null;
}

export interface UpdateDeps {
  fetchText?: FetchText;
  writeFile?: (path: string, text: string) => void;
  current?: CurrentLists;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface UpdateResult {
  written: boolean;
  /** Why nothing was written (empty when written). */
  refused: string[];
  blocklistCount: number;
  allowlistCount: number;
  added: string[];
  removed: string[];
}

const diff = (before: readonly string[], after: readonly string[]) => {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((domain) => !beforeSet.has(domain)),
    removed: before.filter((domain) => !afterSet.has(domain)),
  };
};

const sample = (domains: readonly string[], limit = 20): string =>
  domains.length > limit
    ? `${domains.slice(0, limit).join(", ")}, ... (${domains.length - limit} more)`
    : domains.join(", ");

export const runUpdate = async (ref: string, deps: UpdateDeps = {}): Promise<UpdateResult> => {
  const log = deps.log ?? ((line: string) => console.log(line));
  const fetchText = deps.fetchText ?? defaultFetchText;
  const writeFile = deps.writeFile ?? ((path: string, text: string) => writeFileSync(path, text, "utf8"));
  const current = deps.current ?? {
    blocklist: DISPOSABLE_EMAIL_BLOCKLIST,
    allowlist: DISPOSABLE_EMAIL_ALLOWLIST,
    commit: DISPOSABLE_DOMAINS_SOURCE.commit,
  };
  const now = deps.now ?? (() => new Date());

  const refuse = (reasons: string[], counts: Partial<UpdateResult> = {}): UpdateResult => {
    for (const reason of reasons) log(`Refused: ${reason}`);
    log("Nothing written.");
    return {
      written: false,
      refused: reasons,
      blocklistCount: 0,
      allowlistCount: 0,
      added: [],
      removed: [],
      ...counts,
    };
  };

  if (!isCommitSha(ref)) return refuse([`--ref must be a full 40-character commit SHA (got "${ref}")`]);

  const [blockText, allowText] = await Promise.all([
    fetchText(upstreamUrl(ref, BLOCKLIST_FILE)),
    // Upstream removed allowlist.conf on 2026-04-12; a commit without it means "no upstream allowlist".
    fetchText(upstreamUrl(ref, ALLOWLIST_FILE)).catch((error: unknown) => {
      if (error instanceof UpstreamFileNotFound) return null;
      throw error;
    }),
  ]);
  if (allowText === null) log(`${ALLOWLIST_FILE} is not in commit ${ref}; using no upstream allowlist.`);
  const blocklist = parseDomainList(blockText);
  const allowlist = parseDomainList(allowText ?? "");
  for (const [name, list] of [
    [BLOCKLIST_FILE, blocklist],
    [ALLOWLIST_FILE, allowlist],
  ] as const) {
    if (list.invalid.length > 0)
      log(`Skipped ${list.invalid.length} invalid line(s) in ${name}: ${sample(list.invalid)}`);
  }

  const { added, removed } = diff(current.blocklist, blocklist.domains);
  const counts = {
    blocklistCount: blocklist.domains.length,
    allowlistCount: allowlist.domains.length,
    added,
    removed,
  };
  log(
    `Blocklist ${current.blocklist.length} -> ${blocklist.domains.length} domains (added ${added.length}, ` +
      `removed ${removed.length}); allowlist ${current.allowlist.length} -> ${allowlist.domains.length}; ` +
      `commit ${current.commit ?? "none"} -> ${ref}`,
  );
  if (added.length > 0) log(`Added: ${sample(added)}`);
  if (removed.length > 0) log(`Removed: ${sample(removed)}`);

  const reasons: string[] = [];
  if (blocklist.domains.length === 0) reasons.push(`${BLOCKLIST_FILE} has no domains`);
  const minimum = Math.ceil(current.blocklist.length * MIN_KEPT_SHARE);
  if (blocklist.domains.length < minimum) {
    reasons.push(
      `the blocklist would shrink from ${current.blocklist.length} to ${blocklist.domains.length} domains ` +
        `(more than ${Math.round((1 - MIN_KEPT_SHARE) * 100)}%)`,
    );
  }
  const guarded = blockedGuardDomains(blocklist.domains, allowlist.domains);
  if (guarded.length > 0) reasons.push(`the lists would block guard domain(s): ${guarded.join(", ")}`);
  if (reasons.length > 0) return refuse(reasons, counts);

  const text = renderGeneratedModule({
    repository: UPSTREAM_REPOSITORY,
    commit: ref,
    generatedAt: now().toISOString(),
    blocklist: { name: BLOCKLIST_FILE, sha256: sha256Hex(blockText), domains: blocklist.domains },
    allowlist: {
      name: ALLOWLIST_FILE,
      sha256: allowText === null ? null : sha256Hex(allowText),
      domains: allowlist.domains,
    },
  });
  writeFile(GENERATED_FILE, text);
  log(`Wrote ${GENERATED_FILE}. Review the diff and ship it with the next deploy.`);
  return { written: true, refused: [], ...counts };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.ref) {
    console.log(USAGE);
    if (!options.help) process.exitCode = 1;
    return;
  }
  const result = await runUpdate(options.ref);
  if (!result.written) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Disposable domain update failed", error);
    process.exitCode = 1;
  });
}
