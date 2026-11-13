#!/usr/bin/env node

// REL-56 backfill, step 1 (RUNBOOK 16.1): the snapshot of the bill updates the poller skipped before REL-56. Read-only.
//
// From 2026-03-05 (the first congress.gov poller) until REL-56 was deployed on 2026-11-09, BillsApiPoller dropped every
// list row at or below its cursor "<updateDate>#<guid>", whose updateDate is a date alone. After a bill type's first
// update of a day, later updates that day to bills whose guid sorts lower ("hr10953" < "hr9821") were skipped for good,
// new bills among them. This script lists congress.gov's bill list from --cutoff to its own start ("top"), compares each
// row with the stored raw bill, and writes the bills to send again, for refetch:stale-bills --snapshot-file:
//   missing         no raw bill: never stored
//   stale           the row's date is after the stored copy's
//   stale_same_day  the same date, but a later time (the row's own time, or one detail request)
//   unresolved      the same date, and the detail request failed (a refetch is safe)
// Only counted, not written: fresh (the stored copy is as new or newer) and recent (the row's updateDate is within
// --recent-hours of top, and after the fixed poller's first run listed every type again: the poller has it). Recent goes
// by updateDate alone, the field the list's filter and sort use. In the list it moves with text changes too: the row of
// BILLS-119hr3331 read 2026-10-30, the day of its new text, while its detail's updateDate stayed 2026-01-05. So recent
// by updateDate and by the row time agree. For the rest, a row's time is the later of its updateDate and
// updateDateIncludingText, and so is the stored copy's (content.bill.bill).
//
// The key: CONGRESS_API_KEY in the environment (whoever runs it sets it with read -rs; RUNBOOK 16.1), sent only in the
// X-Api-Key header and only to https://api.congress.gov. It is never printed or written, and error texts are scrubbed
// of it. The script takes it out of its own environment first, so the aws CLI processes it starts do not inherit it.
// Without it the script exits 1. --demo-key uses the public DEMO_KEY instead, for at most 5 requests (a smoke test).
// The script never reads Secrets Manager.
//
// Preflight (read-only; exit 2 when one fails): the snapshot's Congress (the 119th) is the primary one, the poller
// state holds it, and the poller rule is ENABLED (a quiet window open means a refetch needs the key now). The rule is
// checked again before each type is listed, before the detail requests and every 100 requests: a window opened
// during the run stops it (exit 2, resumable), and so does a check that cannot run.
//
// Requests: at most --per-hour congress.gov requests in any hour (one every 3600/n seconds), and at most --max-requests
// in all. Above 1500 an hour --per-hour needs --separate-key: the production key's 5,000 an hour is shared with the
// poller and FetchRawBill, and the script cannot tell keys apart: the flag states that it is another. The first 429,
// 401 or 403 stops the run (exit 2), without a retry, and requests already waiting for their turn are not sent. A list
// page that fails otherwise (a 5xx, a timeout) is tried 3 times. Each type is read newest first, 250 rows a page, until
// a short page, as the poller pages: each page starts 25 rows before the one before ends, and as many rows earlier
// again as pagination.count dropped between the two. A row updated again while the type is read leaves the window and
// moves the rows below it up. So, as in the poller, a page that shares no row with the end of the page before makes the
// reading step back one page (twice at most), and a reading must list as many distinct rows as its first page's
// pagination.count. A reading that fails either is read again from the top, and the second must pass both on its own.
// Still failing, the run stops (exit 2) and names the type. A same-date row whose time the list does not give costs one
// detail request (/bill/{congress}/{type}/{number}).
//
// The snapshot is built in <out>.partial, a journal of the rows listed and the details read: a rerun with the same
// options resumes there, keeping the first run's top, listing only the types not listed yet and asking no detail
// twice. When done, the snapshot is written to <out>.tmp and renamed to <out> (never over an existing file), and the
// journal is removed. --count-only lists and compares without detail requests and writes nothing. The last line is
//   Snapshot summary: mode= outcome= rows= missing= stale= stale_same_day= unresolved= fresh= recent= same_date= titles_differ= titles_govinfo= requests= file=
//
// AWS calls (read-only): S3 ListObjectsV2 and GetObject on raw-bills/, SSM GetParameter, and the AWS CLI for lambda
// get-alias, events list-rule-names-by-target and describe-rule (describe-rule again during the run).
// Exit codes: 0 done; 1 a usage error, no key, or a raw bill that could not be read; 2 refused or stopped.

import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { BillStorage } from "../src/adapters/billStorage";
import type { RawBill } from "../src/models/bill";
import { toBillMessage } from "../src/shared/billListRow";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { BILLBOARD_FETCHER_USER_AGENT, fetchWithTimeout } from "../src/shared/http";
import {
  awsCliRunner,
  configFromEnv,
  pollerRuleNames,
  ruleState,
  summarizePollerState,
  titleChange,
  type AwsCli,
  type Precondition,
  type RefetchConfig,
  type TitleChange,
} from "./refetchStaleBills";
import {
  SNAPSHOT_CLASSES,
  SNAPSHOT_CONGRESS,
  formatSnapshot,
  parseUpdateTime,
  primaryCongressAt,
  recordUpdateTime,
  storedUpdateTime,
  type SnapshotClass,
  type SnapshotEntry,
  type SnapshotSettings,
  type UpdateTime,
} from "./skippedBillSnapshot";

// ─── Defaults and limits ─────────────────────────────────────────────────────

/** The first congress.gov poller (2026-03-05) brought the cursor that skipped rows; nothing was skipped before. */
export const DEFAULT_CUTOFF = "2026-03-05T00:00:00.000Z";
export const BILL_TYPES: readonly string[] = ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"];
export const DEFAULT_OUT = "rel56-snapshot.tsv";
/** Leaves most of an hourly 5,000 for the poller and FetchRawBill when the production key is used. */
export const DEFAULT_PER_HOUR = 1500;
/**
 * The most --per-hour takes without --separate-key. The production key's 5,000 an hour is shared with the poller and
 * FetchRawBill (a peak of about 1,100 an hour), so more would get them 429s. The script cannot tell keys apart:
 * --separate-key states that CONGRESS_API_KEY is not the production key.
 */
export const SHARED_KEY_MAX_PER_HOUR = 1500;
export const MAX_PER_HOUR = 4000;
export const DEFAULT_RECENT_HOURS = 48;
export const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 25;
export const DEMO_KEY = "DEMO_KEY";
export const DEMO_KEY_MAX_REQUESTS = 5;
export const KEY_ENV = "CONGRESS_API_KEY";

export const CONGRESS_API_ROOT = "https://api.congress.gov/v3";
export const LIST_PAGE_SIZE = 250;
/** The poller's 25 rows of overlap: a row that leaves the window between two pages moves the rest up by one. */
export const PAGE_OVERLAP_ROWS = 25;
export const PAGE_STEP_ROWS = LIST_PAGE_SIZE - PAGE_OVERLAP_ROWS;
/** The poller's: how often a reading steps back one page when a page shares no row with the end of the page before. */
export const MAX_PAGE_DRIFT_STEP_BACKS = 2;
/** Readings of a type before the run stops (count_short). */
export const LIST_READINGS = 2;
/** 200 pages of 225 is 45,000 rows: far more than a type lists since 2025. */
const MAX_LIST_PAGES = 200;
export const LIST_ATTEMPTS = 3;
const LIST_RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * REL-56's first run (2026-11-09T02:03:40Z) listed every type again from this time or earlier (hr and s from
 * 2026-11-06T23:58Z, the others from before), and every run since lists every row: a row updated at or after it reached
 * UpdatedBillsQueue. So a row is "recent" only from here on, whatever --recent-hours says.
 */
export const POLLER_RELISTED_FROM = "2026-11-06T23:58:00.000Z";
const HOUR_MS = 60 * 60 * 1000;
const LOG_EVERY_DETAILS = 100;
/** congress.gov requests between two checks of the poller rule: 4 minutes at 1,500 an hour. */
export const RULE_CHECK_EVERY_REQUESTS = 100;
/** One window of refetch:stale-bills: 800 bills at 500 an hour, 8 congress.gov calls each. */
const BACKFILL_BATCH = 800;
const BACKFILL_PER_HOUR = 500;
const CALLS_PER_REFETCH = 8;

// ─── Arguments ───────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  help: boolean;
  countOnly: boolean;
  cutoff: string;
  types: string[];
  out: string;
  perHour: number;
  recentHours: number;
  concurrency: number;
  /** null: no cap (a --demo-key run is capped at DEMO_KEY_MAX_REQUESTS). */
  maxRequests: number | null;
  demoKey: boolean;
  /** --separate-key: a statement that the key is not the production key, so --per-hour may pass 1500. */
  separateKey: boolean;
}

export const parseArgs = (argv: readonly string[]): SnapshotOptions => {
  const options: SnapshotOptions = {
    help: false,
    countOnly: false,
    cutoff: DEFAULT_CUTOFF,
    types: [...BILL_TYPES],
    out: DEFAULT_OUT,
    perHour: DEFAULT_PER_HOUR,
    recentHours: DEFAULT_RECENT_HOURS,
    concurrency: DEFAULT_CONCURRENCY,
    maxRequests: null,
    demoKey: false,
    separateKey: false,
  };
  const readValue = (flag: string, raw: string | undefined): string => {
    if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs a value`);
    return raw;
  };
  const readWhole = (flag: string, raw: string | undefined, min: number, max: number): number => {
    const value = Number(raw);
    if (!raw || !/^\d+$/.test(raw) || value < min || value > max) {
      throw new Error(`${flag} needs a whole number from ${min} to ${max}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--count-only") options.countOnly = true;
    else if (arg === "--demo-key") options.demoKey = true;
    else if (arg === "--separate-key") options.separateKey = true;
    else if (arg === "--cutoff") {
      const raw = readValue(arg, argv[(index += 1)]);
      if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(raw) || Number.isNaN(Date.parse(raw))) {
        throw new Error("--cutoff needs an ISO time such as 2026-03-05T00:00:00Z");
      }
      options.cutoff = new Date(raw).toISOString();
    } else if (arg === "--types") {
      const types = [
        ...new Set(
          readValue(arg, argv[(index += 1)])
            .split(",")
            .map((type) => type.trim().toLowerCase()),
        ),
      ];
      const unknown = types.filter((type) => !BILL_TYPES.includes(type));
      if (types.length === 0 || unknown.length > 0) {
        throw new Error(`--types takes a comma-separated list of ${BILL_TYPES.join(", ")}`);
      }
      options.types = BILL_TYPES.filter((type) => types.includes(type));
    } else if (arg === "--out") options.out = readValue(arg, argv[(index += 1)]);
    else if (arg === "--per-hour") options.perHour = readWhole(arg, argv[(index += 1)], 1, MAX_PER_HOUR);
    else if (arg === "--recent-hours") options.recentHours = readWhole(arg, argv[(index += 1)], 0, 24 * 30);
    else if (arg === "--concurrency") options.concurrency = readWhole(arg, argv[(index += 1)], 1, MAX_CONCURRENCY);
    else if (arg === "--max-requests") options.maxRequests = readWhole(arg, argv[(index += 1)], 1, 1_000_000);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.perHour > SHARED_KEY_MAX_PER_HOUR && !options.separateKey) {
    throw new Error(
      `--per-hour above ${SHARED_KEY_MAX_PER_HOUR} needs --separate-key: the production key is shared with the poller ` +
        "and FetchRawBill, and the script cannot tell keys apart. Pass --separate-key only for a key of your own " +
        "(RUNBOOK 16.1)",
    );
  }
  if (options.demoKey)
    options.maxRequests = Math.min(options.maxRequests ?? DEMO_KEY_MAX_REQUESTS, DEMO_KEY_MAX_REQUESTS);
  return options;
};

/** The key and how to name it, or an error saying how to give one. */
export const resolveKey = (
  env: NodeJS.ProcessEnv,
  options: Pick<SnapshotOptions, "demoKey">,
): { key: string; secret: boolean; label: string } => {
  if (options.demoKey) return { key: DEMO_KEY, secret: false, label: "the public DEMO_KEY (--demo-key)" };
  const key = (env[KEY_ENV] ?? "").trim();
  if (!key) {
    throw new Error(
      `${KEY_ENV} is not set: set it to a congress.gov key (RUNBOOK 16.1: read -rs ${KEY_ENV}; export ${KEY_ENV}), ` +
        "or pass --demo-key for a smoke test of at most 5 requests",
    );
  }
  if (/\s/.test(key)) throw new Error(`${KEY_ENV} holds a space or a line break; set it to the key alone`);
  return { key, secret: true, label: `${KEY_ENV} (${key.length} characters, not shown)` };
};

/**
 * A copy of the environment for the run, and the key taken out of `processEnv`: the aws CLI processes the preflight
 * starts inherit process.env, and they need no congress.gov key.
 */
export const withholdKey = (processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...processEnv };
  delete processEnv[KEY_ENV];
  return env;
};

export const USAGE = [
  "List the bill updates the poller skipped before REL-56 and write the backfill's snapshot (read-only).",
  "",
  "Usage:",
  `  read -rs ${KEY_ENV}; export ${KEY_ENV}   The key: paste it, then Enter (not shown, not kept in the history)`,
  "  npm run list:skipped-bill-updates -- --count-only     Counts only, about 50 to 90 requests",
  `  npm run list:skipped-bill-updates                     The snapshot, ${DEFAULT_OUT}`,
  `  unset ${KEY_ENV}                                When done`,
  "  npm run list:skipped-bill-updates -- --demo-key --types sconres --count-only   Smoke test (5 requests at most)",
  "",
  "Options:",
  "  --count-only            List and compare, without detail requests; write nothing",
  `  --cutoff <iso>          List rows updated from this time (default ${DEFAULT_CUTOFF})`,
  `  --types <list>          Bill types, comma-separated (default ${BILL_TYPES.join(",")})`,
  `  --out <file>            The snapshot (default ${DEFAULT_OUT}); built in <file>.partial, which a rerun resumes`,
  `  --per-hour <n>          congress.gov requests in any hour (default ${DEFAULT_PER_HOUR}; above ${SHARED_KEY_MAX_PER_HOUR}, at most ${MAX_PER_HOUR},`,
  "                          only with --separate-key)",
  "  --separate-key          Your statement that the key is not the production key (the script cannot tell)",
  `  --recent-hours <n>      Rows updated this close to the start are the poller's: counted only (default ${DEFAULT_RECENT_HOURS})`,
  `  --concurrency <n>       Raw bills read and detail requests in flight at once (default ${DEFAULT_CONCURRENCY})`,
  "  --max-requests <n>      Stop (exit 2) before request n+1",
  `  --demo-key              Use the public DEMO_KEY instead of ${KEY_ENV}, for at most ${DEMO_KEY_MAX_REQUESTS} requests`,
  "",
  `The key is read from ${KEY_ENV}, sent only in the X-Api-Key header to api.congress.gov, and never printed or`,
  "written. Exit codes: 0 done; 1 a usage error, no key, or a raw bill that could not be read; 2 the preflight refused",
  "(the 119th not primary, the poller state, the poller rule not ENABLED) or the run stopped (429, 401, 403, a type",
  "still short of its count, a list page that kept failing, --max-requests, a quiet window opened during the run or",
  "a rule check that failed). A stopped run keeps <out>.partial: the same command resumes it.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME), RAW_BILLS_PREFIX.",
  "Needs the AWS CLI on PATH for the poller rule check.",
].join("\n");

// ─── congress.gov ────────────────────────────────────────────────────────────

export interface HttpAnswer {
  status: number;
  body: string;
}

/** A GET to congress.gov; the key is in `headers`, never in `url`. */
export type CongressHttpGet = (url: string, headers: Readonly<Record<string, string>>) => Promise<HttpAnswer>;

/** fetch with a timeout; a redirect is returned, not followed, so the key header never goes to another host. */
export const defaultCongressGet: CongressHttpGet = async (url, headers) => {
  const response = await fetchWithTimeout(url, { headers, redirect: "manual" }, REQUEST_TIMEOUT_MS);
  return { status: response.status, body: await response.text() };
};

export type StopReason =
  | "rate_limited"
  | "key_refused"
  | "max_requests"
  | "count_short"
  | "list_failed"
  | "window_open"
  | "check_failed";

/** A condition that ends the run with exit 2, keeping the journal for a rerun. */
export class StopError extends Error {
  constructor(
    readonly reason: StopReason,
    message: string,
  ) {
    super(message);
    this.name = "StopError";
  }
}

/** A request that failed in another way (a 5xx, a 404, a timeout, a body that is not JSON). */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** congress.gov's list filter takes whole seconds with a Z. */
export const congressApiTime = (iso: string): string => `${new Date(iso).toISOString().slice(0, 19)}Z`;

/** Paced, counted GETs to api.congress.gov with the key in the X-Api-Key header. */
export class CongressClient {
  requests = 0;
  readonly intervalMs: number;
  private nextSlotMs = Number.NEGATIVE_INFINITY;
  /** The stop (a 429, 401 or 403, or a window opened): a request still waiting for its turn is not sent after it. */
  private stopped: StopError | null = null;

  constructor(
    private readonly deps: {
      key: string;
      httpGet: CongressHttpGet;
      perHour: number;
      maxRequests: number | null;
      now: () => Date;
      sleep: (ms: number) => Promise<void>;
      scrub: (text: string) => string;
    },
  ) {
    // Starts at least this far apart: any hour holds at most perHour of them.
    this.intervalMs = Math.ceil(HOUR_MS / deps.perHour);
  }

  /** Stops the run from outside (the first stop is kept): no request still waiting for its turn is sent. */
  stop(error: StopError): StopError {
    this.stopped ??= error;
    return error;
  }

  async get(path: string, params: Readonly<Record<string, string | number>> = {}): Promise<Record<string, unknown>> {
    const { key, httpGet, maxRequests, now, sleep, scrub } = this.deps;
    const url = new URL(`${CONGRESS_API_ROOT}/${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    url.searchParams.set("format", "json");
    const where = url.pathname;
    // Counted and paced before the first await, so requests in flight at once never pass either limit.
    if (maxRequests !== null && this.requests >= maxRequests) {
      throw new StopError("max_requests", `--max-requests ${maxRequests} reached before ${where}`);
    }
    this.requests += 1;
    const nowMs = now().getTime();
    const slot = Math.max(nowMs, this.nextSlotMs);
    this.nextSlotMs = slot + this.intervalMs;
    if (slot > nowMs) await sleep(slot - nowMs);
    if (this.stopped) {
      this.requests -= 1;
      throw new StopError(this.stopped.reason, `${this.stopped.message} (${where} not sent)`);
    }

    let answer: HttpAnswer;
    try {
      answer = await httpGet(url.toString(), {
        "X-Api-Key": key,
        Accept: "application/json",
        "User-Agent": BILLBOARD_FETCHER_USER_AGENT,
      });
    } catch (error) {
      throw new RequestError(scrub(`GET ${where} failed: ${errorText(error)}`), null);
    }
    const excerpt = scrub(answer.body.slice(0, 200).replace(/\s+/g, " ").trim());
    if (answer.status === 429) {
      this.stopped = new StopError("rate_limited", `congress.gov answered 429 for ${where}: ${excerpt}`);
      throw this.stopped;
    }
    if (answer.status === 401 || answer.status === 403) {
      this.stopped = new StopError("key_refused", `congress.gov answered ${answer.status} for ${where}: ${excerpt}`);
      throw this.stopped;
    }
    if (answer.status !== 200) {
      throw new RequestError(`congress.gov answered ${answer.status} for ${where}: ${excerpt}`, answer.status);
    }
    try {
      const parsed: unknown = JSON.parse(answer.body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch {
      throw new RequestError(`congress.gov's answer for ${where} is not a JSON object`, 200);
    }
  }
}

/**
 * The poller rule, checked again while the run goes on. A 4.1 quiet window opened during a snapshot would add the
 * snapshot's requests to the refetch's on the same key (1,500 and 4,000 an hour, against 5,000). So before each type
 * is listed, before the detail requests and every RULE_CHECK_EVERY_REQUESTS requests, every poller rule must still
 * read ENABLED. Otherwise the run stops (window_open, or check_failed when the check cannot run), keeping the journal.
 */
export class RuleWatch {
  checks = 0;
  /** client.requests at the last check: the preflight's is 0. */
  private checkedAt = 0;
  private running: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      client: CongressClient;
      awsCli: AwsCli;
      ruleNames: readonly string[];
      every: number;
    },
  ) {}

  /** Checks when `every` requests have started since the last check, or, with `force`, when any has. */
  due(force = false): Promise<void> {
    if (this.running) return this.running;
    const since = this.deps.client.requests - this.checkedAt;
    if (since <= 0 || (!force && since < this.deps.every)) return Promise.resolve();
    this.checkedAt = this.deps.client.requests;
    this.running = this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check(): Promise<void> {
    const { client, awsCli, ruleNames } = this.deps;
    this.checks += 1;
    const states: string[] = [];
    try {
      for (const name of ruleNames) states.push(`${name} ${await ruleState(awsCli, name)}`);
    } catch (error) {
      throw client.stop(
        new StopError(
          "check_failed",
          `the poller rule could not be checked (${errorText(error)}); check the AWS login, then run the same command`,
        ),
      );
    }
    const off = states.filter((state) => !state.endsWith(" ENABLED"));
    if (off.length > 0) {
      throw client.stop(
        new StopError(
          "window_open",
          `${off.join(", ")}: a quiet window opened during the run. Run the same command again once it is closed.`,
        ),
      );
    }
  }
}

/** A list answer's rows (`bills`), or null when it holds no list. */
export const listRows = (payload: Record<string, unknown>): Array<Record<string, unknown>> | null => {
  const bills = payload.bills;
  if (Array.isArray(bills))
    return bills.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
  return null;
};

/** pagination.count, or null when the answer has none. */
export const paginationCount = (payload: Record<string, unknown>): number | null => {
  const pagination = payload.pagination as Record<string, unknown> | undefined;
  const raw = pagination?.count;
  const count = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
};

// ─── Listing ─────────────────────────────────────────────────────────────────

export interface ListedType {
  type: string;
  /** By guid, in the order first read; every reading's rows (a row that left the window since is harmless). */
  rows: Map<string, Record<string, unknown>>;
  /** Rows that name no bill of this Congress and type (the last reading, each once): counted, not kept. */
  unnamed: number;
  /** The last page's pagination.count. */
  count: number | null;
  /** Pages read, every reading's and every step back included. */
  pages: number;
  reads: number;
  /** Times a page shared no row with the end of the page before, so the reading stepped back one page. */
  stepBacks: number;
}

type Log = (line: string) => void;

interface ListDeps {
  log: Log;
  sleep: (ms: number) => Promise<void>;
  /** Run before each list request: the poller rule check (RuleWatch.due). */
  due?: () => Promise<void>;
}

const listPage = async (
  client: CongressClient,
  congress: string,
  type: string,
  offset: number,
  window: { from: string; to: string },
  { log, sleep, due }: ListDeps,
): Promise<Record<string, unknown>> => {
  for (let attempt = 1; ; attempt += 1) {
    await due?.();
    try {
      return await client.get(`bill/${congress}/${type}`, {
        fromDateTime: congressApiTime(window.from),
        toDateTime: congressApiTime(window.to),
        sort: "updateDate+desc",
        limit: LIST_PAGE_SIZE,
        offset,
      });
    } catch (error) {
      if (error instanceof StopError) throw error;
      if (attempt >= LIST_ATTEMPTS) {
        throw new StopError("list_failed", `${type} at offset ${offset} failed ${attempt} times: ${errorText(error)}`);
      }
      log(`  ${type} at offset ${offset}: ${errorText(error)}; trying again (${attempt + 1} of ${LIST_ATTEMPTS})`);
      await sleep(LIST_RETRY_DELAY_MS * attempt);
    }
  }
};

/**
 * Every row of a type's list in the window, newest first, as the poller pages it: each page starts PAGE_OVERLAP_ROWS
 * before the one before ends, and as many rows earlier again as pagination.count dropped between the two. A row
 * updated again while the type is read leaves the window (its time is now after top) and moves the rows below it up,
 * so rows between two pages could go unread. As in the poller, two checks:
 * - A page must share a row with the end of the page before. One that shares none had more rows leave above it than
 *   the overlap covers: the reading steps back one page (MAX_PAGE_DRIFT_STEP_BACKS times at most), keeping the rows
 *   it expects, so the pages join up again.
 * - A reading must list as many distinct rows as its first page's pagination.count. Rows that leave later were read
 *   before they left; the last page's count is lowered by them, so it cannot tell a gap. A row that names no bill
 *   counts once, however many pages read it.
 * A reading that fails either is read again from the top, and the second must pass both on its own. Still failing,
 * the run stops (count_short), and a rerun lists the type again.
 */
export const listType = async (
  client: CongressClient,
  congress: string,
  type: string,
  window: { from: string; to: string },
  deps: ListDeps,
): Promise<ListedType> => {
  const ownGuid = new RegExp(`^BILLS-${congress}${type}\\d+$`);
  const rows = new Map<string, Record<string, unknown>>();
  let pages = 0;
  let stepBacks = 0;
  for (let read = 1; ; read += 1) {
    const seen = new Set<string>();
    // Rows that name no bill, by their JSON: one in the overlap of two pages is read twice but counted once.
    const unnamed = new Set<string>();
    let firstCount: number | null = null;
    let lastCount: number | null = null;
    let readingStepBacks = 0;
    let drifted = false;
    // The guids the next page should read again: the end of the page before.
    let expected: Set<string> | null = null;
    let offset = 0;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_LIST_PAGES) throw new StopError("list_failed", `${type} has more than ${MAX_LIST_PAGES} pages`);
      const payload = await listPage(client, congress, type, offset, window, deps);
      pages += 1;
      const pageCount = paginationCount(payload);
      const countBefore = lastCount;
      if (pageCount !== null) {
        firstCount ??= pageCount;
        lastCount = pageCount;
      }
      const list = listRows(payload) ?? (pageCount === 0 ? [] : null);
      if (list === null) {
        throw new StopError("list_failed", `congress.gov's answer for ${type} at offset ${offset} holds no bill list`);
      }
      const pageGuids = list.map((row) => {
        const guid = toBillMessage(row, type, congress)?.guid;
        if (!guid || !ownGuid.test(guid)) {
          unnamed.add(JSON.stringify(row));
          return null;
        }
        seen.add(guid);
        if (!rows.has(guid)) rows.set(guid, row);
        return guid;
      });
      // Nothing can be missed above offset 0.
      const tail = expected;
      if (offset > 0 && tail && tail.size > 0 && !pageGuids.some((guid) => guid !== null && tail.has(guid))) {
        if (readingStepBacks >= MAX_PAGE_DRIFT_STEP_BACKS) {
          drifted = true;
          break;
        }
        readingStepBacks += 1;
        stepBacks += 1;
        const back = Math.max(0, offset - PAGE_STEP_ROWS);
        deps.log(
          `  ${type}: the page at offset ${offset} shares no row with the end of the page before (rows left the ` +
            `window above it); reading again from offset ${back}`,
        );
        offset = back;
        continue;
      }
      if (list.length < LIST_PAGE_SIZE) break;
      const lost = countBefore !== null && pageCount !== null ? Math.max(0, countBefore - pageCount) : 0;
      const nextOffset = Math.max(0, offset + list.length - PAGE_OVERLAP_ROWS - lost);
      expected = new Set(
        pageGuids.slice(Math.max(0, nextOffset - offset)).filter((guid): guid is string => guid !== null),
      );
      offset = nextOffset;
    }
    const distinct = seen.size + unnamed.size;
    const listed: ListedType = { type, rows, unnamed: unnamed.size, count: lastCount, pages, reads: read, stepBacks };
    // Every row read was in the window when it was read, and no row enters it after top: as many distinct rows as the
    // first page counted means every row of the window was read. Nothing less proves it, in either reading: against a
    // later count, a row read before it left the window makes up for a row a changed order hid.
    const complete = firstCount === null || distinct >= firstCount;
    if (!drifted && complete) return listed;
    const why = drifted
      ? `the pages did not join up after ${MAX_PAGE_DRIFT_STEP_BACKS} steps back (rows kept leaving the window)`
      : `read ${distinct} distinct rows but congress.gov counts ${firstCount}`;
    if (read >= LIST_READINGS) {
      throw new StopError(
        "count_short",
        drifted
          ? `${type}: read twice, and ${why}; rows between two pages may not have been read. Run again later.`
          : `${type}: read ${distinct} distinct rows twice, but congress.gov counts ${firstCount}; rows may have ` +
              "moved between pages. Run again later.",
      );
    }
    deps.log(`  ${type}: ${why}; reading it once more`);
  }
};

// ─── Classification ──────────────────────────────────────────────────────────

export type RowClass = SnapshotClass | "fresh" | "recent" | "same_date";
export const COUNTED_CLASSES: readonly RowClass[] = [...SNAPSHOT_CLASSES, "fresh", "recent", "same_date"];

/** a is a later update than b, or null when the two cannot be told apart (the same day, one with no time). */
const laterThan = (a: UpdateTime, b: UpdateTime): boolean | null => {
  if (a.day !== b.day) return a.day > b.day;
  if (a.full && b.full) return a.ms > b.ms;
  return null;
};

/**
 * A row's class from what the list and the store say; "same_date" when only the bill's detail can tell (the same
 * date, and a date alone on one side, or a row with no update date).
 */
export const classifyRow = ({
  rowTime,
  listedTime,
  stored,
  recentFromMs,
}: {
  /** The later of the row's updateDate and updateDateIncludingText: compared with the stored copy. */
  rowTime: UpdateTime | null;
  /**
   * The row's updateDate alone: the field congress.gov's list filter and sort use, so the one the fixed poller's
   * watermark covers. In the list it moves with text changes too (BILLS-119hr3331 on 2026-10-30), so it gives the same
   * recent rows as the row time.
   */
  listedTime: UpdateTime | null;
  stored: { exists: boolean; time: UpdateTime | null };
  recentFromMs: number;
}): RowClass => {
  if (!stored.exists) return "missing";
  // A date alone is recent only when its whole day is: its midnight on or after the cut.
  if (listedTime && listedTime.ms >= recentFromMs) return "recent";
  if (!stored.time) return "stale";
  if (!rowTime) return "same_date";
  const later = laterThan(rowTime, stored.time);
  if (later === null) return "same_date";
  if (later) return rowTime.day > stored.time.day ? "stale" : "stale_same_day";
  return "fresh";
};

/** A same-date row, decided by its detail's update time: null (no time, or a failed request) is unresolved. */
export const classifyByDetail = (detail: UpdateTime | null, stored: UpdateTime | null): RowClass => {
  if (!detail || !stored) return "unresolved";
  const later = laterThan(detail, stored);
  if (later === null) return "unresolved";
  return later ? "stale_same_day" : "fresh";
};

export interface ClassifiedRow {
  guid: string;
  type: string;
  cls: RowClass;
  rowTime: UpdateTime | null;
  storedTime: UpdateTime | null;
  row: Record<string, unknown>;
  /**
   * A stored bill's title against its row's (titleChange): "differs" (congress.gov retitled it; the refetch sends the
   * row's, as the poller does, a re-summary when the bill has text; RUNBOOK 16.1, D5), "govinfo" (a stored title in the
   * older GovInfo form, which the refetch keeps), "same", or "none" (no row title, or never stored).
   */
  titleChange: TitleChange;
}

export type Counts = Record<RowClass, number>;
const emptyCounts = (): Counts =>
  Object.fromEntries(COUNTED_CLASSES.map((cls) => [cls, 0])) as unknown as Record<RowClass, number>;

export const countsLine = (counts: Counts, classes: readonly RowClass[] = COUNTED_CLASSES): string =>
  classes.map((cls) => `${cls}=${counts[cls]}`).join(" ");

/** Newest row time first (rows with none last), never stored before stored on equal times, then by guid. */
export const snapshotOrder = (a: ClassifiedRow, b: ClassifiedRow): number => {
  const aMs = a.rowTime?.ms ?? Number.NEGATIVE_INFINITY;
  const bMs = b.rowTime?.ms ?? Number.NEGATIVE_INFINITY;
  if (aMs !== bMs) return aMs > bMs ? -1 : 1;
  const aMissing = a.cls === "missing" ? 0 : 1;
  const bMissing = b.cls === "missing" ? 0 : 1;
  if (aMissing !== bMissing) return aMissing - bMissing;
  return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
};

// ─── The journal (<out>.partial) ─────────────────────────────────────────────

export const JOURNAL_TITLE =
  "# list:skipped-bill-updates (REL-56) journal v1: the snapshot in progress; a rerun resumes it";

export interface JournalSettings {
  congress: string;
  cutoff: string;
  top: string;
  types: string;
  recentHours: number;
}

export const journalSettingsLine = (settings: JournalSettings): string =>
  `# congress=${settings.congress} cutoff=${settings.cutoff} top=${settings.top} types=${settings.types} ` +
  `recentHours=${settings.recentHours}`;

export interface Journal {
  settings: JournalSettings;
  /** Types listed in full: their rows by guid. */
  listed: Map<string, Map<string, Record<string, unknown>>>;
  listedAt: string | null;
  /** Detail update times read, by guid. */
  details: Map<string, UpdateTime>;
  /** Requests the earlier runs made. */
  requests: number;
}

/** Reads a journal; a type's rows count only once its "# listed" line follows them. */
export const parseJournal = (text: string): Journal => {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== JOURNAL_TITLE) throw new Error("This is not a list:skipped-bill-updates journal");
  const settingsLine = lines[1] ?? "";
  const tokens: Record<string, string> = {};
  for (const token of settingsLine.slice(2).trim().split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator > 0) tokens[token.slice(0, separator)] = token.slice(separator + 1);
  }
  if (!tokens.congress || Number.isNaN(Date.parse(tokens.cutoff ?? "")) || Number.isNaN(Date.parse(tokens.top ?? ""))) {
    throw new Error("The journal's settings line does not read");
  }
  const journal: Journal = {
    settings: {
      congress: tokens.congress,
      cutoff: tokens.cutoff,
      top: tokens.top,
      types: tokens.types ?? "",
      recentHours: Number(tokens.recentHours),
    },
    listed: new Map(),
    listedAt: null,
    details: new Map(),
    requests: 0,
  };
  const pending = new Map<string, Map<string, Record<string, unknown>>>();
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue;
    const listing = line.match(/^# listing type=(\w+)$/);
    const listed = line.match(/^# listed type=(\w+) /);
    const at = line.match(/^# listedAt=(\S+)$/);
    const requests = line.match(/^# requests (\d+)\b/);
    if (listing) pending.set(listing[1], new Map());
    else if (listed) journal.listed.set(listed[1], pending.get(listed[1]) ?? new Map());
    else if (at && !Number.isNaN(Date.parse(at[1]))) journal.listedAt = new Date(at[1]).toISOString();
    else if (requests) journal.requests += Number(requests[1]);
    else if (line.startsWith("L\t")) {
      const [, type, guid, rowJson] = line.split("\t");
      try {
        const row: unknown = JSON.parse(rowJson);
        if (row && typeof row === "object") pending.get(type)?.set(guid, row as Record<string, unknown>);
      } catch {
        // A line cut short by a crash: its type is listed again unless its "# listed" line follows.
      }
    } else if (line.startsWith("D\t")) {
      const [, guid, time] = line.split("\t");
      const parsed = parseUpdateTime(time);
      if (guid && parsed) journal.details.set(guid, parsed);
    }
  }
  return journal;
};

// ─── The run ─────────────────────────────────────────────────────────────────

type S3Sender = Pick<S3Client, "send">;
type ParameterReader = Pick<SSMClient, "send">;

export interface SnapshotDeps {
  s3: S3Sender;
  ssm: ParameterReader;
  awsCli: AwsCli;
  config: RefetchConfig;
  options: SnapshotOptions;
  env: NodeJS.ProcessEnv;
  httpGet?: CongressHttpGet;
  log?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, text: string) => void;
  appendFile?: (path: string, text: string) => void;
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
}

export type SnapshotOutcome = "done" | "refused" | "read_failed" | `stopped_${StopReason}`;

export interface SnapshotResult {
  exitCode: 0 | 1 | 2;
  outcome: SnapshotOutcome;
  preconditions: Precondition[];
  counts: Counts;
  byType: Record<string, Counts>;
  rows: ClassifiedRow[];
  requests: number;
  file: string | null;
  stop: { reason: StopReason; detail: string } | null;
}

const defaultReadFile = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The raw-bills/ keys of a Congress, as a set. */
const rawKeysOf = async (s3: S3Sender, bucket: string, prefix: string): Promise<Set<string>> => {
  const keys = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const response = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    for (const object of response.Contents ?? []) if (object.Key) keys.add(object.Key);
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
};

/** The preflight's checks, read-only; a check that throws fails. Also the poller's rule names, for RuleWatch. */
export const preflight = async ({
  ssm,
  awsCli,
  config,
  congress,
  now,
}: {
  ssm: ParameterReader;
  awsCli: AwsCli;
  config: RefetchConfig;
  congress: string;
  now: Date;
}): Promise<{ preconditions: Precondition[]; ruleNames: string[] }> => {
  const results: Precondition[] = [];
  const ruleNames: string[] = [];
  const check = async (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => {
    try {
      results.push({ name, ...(await run()) });
    } catch (error) {
      results.push({ name, ok: false, detail: `check failed: ${errorText(error)}` });
    }
  };
  await check(`the ${congress}th is the primary Congress (REL-46)`, async () => {
    const primary = primaryCongressAt(now.getTime());
    return { ok: primary === congress, detail: `primary at ${now.toISOString()}: the ${primary}th` };
  });
  await check("the poller state holds it", async () => {
    const response = await ssm.send(new GetParameterCommand({ Name: config.pollerStateParameter }));
    const state = summarizePollerState(response.Parameter?.Value, now);
    return { ok: state.known && state.congress === congress, detail: state.detail };
  });
  await check("the poller rule is ENABLED (no quiet window open)", async () => {
    const rules: string[] = [];
    let enabled = true;
    for (const name of await pollerRuleNames(awsCli, config)) {
      ruleNames.push(name);
      const state = await ruleState(awsCli, name);
      if (state !== "ENABLED") enabled = false;
      rules.push(`${name} ${state}`);
    }
    return {
      ok: enabled,
      detail: `${rules.join(", ")}${enabled ? "" : ": a quiet window is open; list outside windows, when the refetch does not need the key"}`,
    };
  });
  return { preconditions: results, ruleNames };
};

/**
 * Lists, compares, and (unless --count-only) writes the snapshot. Never throws for a stop or a refusal (see the
 * result's exitCode); throws on a usage error (no key, bad options, an existing --out, a journal of other settings).
 */
export const runSnapshot = async ({
  s3,
  ssm,
  awsCli,
  config,
  options,
  env,
  httpGet = defaultCongressGet,
  log: baseLog = console.log,
  logError: baseLogError = console.error,
  now = () => new Date(),
  sleep = defaultSleep,
  readFile = defaultReadFile,
  writeFile = (path, text) => writeFileSync(path, text, "utf8"),
  appendFile = (path, text) => appendFileSync(path, text, "utf8"),
  rename = (from, to) => renameSync(from, to),
  remove = (path) => unlinkSync(path),
}: SnapshotDeps): Promise<SnapshotResult> => {
  const { key, secret, label } = resolveKey(env, options);
  const scrub = (text: string): string => (secret ? text.split(key).join("<key>") : text);
  const log: Log = (line) => baseLog(scrub(line));
  const logError: Log = (line) => baseLogError(scrub(line));
  const congress = SNAPSHOT_CONGRESS;
  const startedAt = now();

  const outPath = resolvePath(options.out);
  const journalPath = `${outPath}.partial`;
  const tmpPath = `${outPath}.tmp`;
  if (!options.countOnly && readFile(outPath) !== null) {
    throw new Error(`${outPath} exists: it may be the backfill's snapshot. Pass another --out, or move it first.`);
  }
  const journalText = options.countOnly ? null : readFile(journalPath);
  const journal = journalText !== null && journalText.trim() ? parseJournal(journalText) : null;
  const types = options.types.join(",");
  if (journal) {
    const settings = journal.settings;
    const mismatch = [
      settings.congress !== congress ? `congress ${settings.congress}` : "",
      settings.cutoff !== options.cutoff ? `--cutoff ${settings.cutoff}` : "",
      settings.types !== types ? `--types ${settings.types}` : "",
      settings.recentHours !== options.recentHours ? `--recent-hours ${settings.recentHours}` : "",
    ].filter(Boolean);
    if (mismatch.length > 0) {
      throw new Error(
        `${journalPath} was started with ${mismatch.join(", ")}: pass the same options to resume it, or remove it`,
      );
    }
  }
  const top = journal?.settings.top ?? new Date(Math.floor(startedAt.getTime() / 1000) * 1000).toISOString();
  if (Date.parse(options.cutoff) >= Date.parse(top)) {
    throw new Error(`--cutoff ${options.cutoff} is not before the run's start ${top}`);
  }
  const recentFromMs = Math.max(Date.parse(top) - options.recentHours * HOUR_MS, Date.parse(POLLER_RELISTED_FROM));
  const recentFrom = new Date(recentFromMs).toISOString();

  log(
    `list:skipped-bill-updates mode=${options.countOnly ? "COUNT-ONLY" : "SNAPSHOT"} congress=${congress} ` +
      `cutoff=${options.cutoff} top=${top}${journal ? " (from the journal)" : ""} types=${types} ` +
      `recentFrom=${recentFrom} perHour=${options.perHour} key=${label}` +
      `${options.separateKey ? " (--separate-key: not the production key)" : ""}` +
      `${options.maxRequests !== null ? ` maxRequests=${options.maxRequests}` : ""}` +
      `${options.countOnly ? "" : ` out=${outPath}${journal ? ` (resuming ${journalPath})` : ""}`}`,
  );

  const result: SnapshotResult = {
    exitCode: 0,
    outcome: "done",
    preconditions: [],
    counts: emptyCounts(),
    byType: {},
    rows: [],
    requests: 0,
    file: null,
    stop: null,
  };

  const checked = await preflight({ ssm, awsCli, config, congress, now: startedAt });
  result.preconditions = checked.preconditions;
  log("Preflight:");
  for (const pre of result.preconditions) log(`  ${pre.ok ? "ok  " : "FAIL"}  ${pre.name}: ${pre.detail}`);
  if (result.preconditions.some((pre) => !pre.ok)) {
    log("Refused: a preflight check failed; no congress.gov request was made.");
    return { ...result, exitCode: 2, outcome: "refused" };
  }

  const client = new CongressClient({
    key,
    httpGet,
    perHour: options.perHour,
    maxRequests: options.maxRequests,
    now,
    sleep,
    scrub,
  });
  const watch = new RuleWatch({ client, awsCli, ruleNames: checked.ruleNames, every: RULE_CHECK_EVERY_REQUESTS });
  const journalAppend = (text: string) => {
    if (!options.countOnly) appendFile(journalPath, scrub(text));
  };
  if (!options.countOnly && !journal) {
    writeFile(
      journalPath,
      `${JOURNAL_TITLE}\n${journalSettingsLine({ congress, cutoff: options.cutoff, top, types, recentHours: options.recentHours })}\n`,
    );
  }
  const earlierRequests = journal?.requests ?? 0;
  const stopWith = (error: StopError): SnapshotResult => {
    logError(`Stopped: ${error.reason}: ${error.message}`);
    journalAppend(`# stopped reason=${error.reason} at=${now().toISOString()}\n# requests ${client.requests}\n`);
    if (!options.countOnly) log(`The journal ${journalPath} is kept: run the same command again to resume.`);
    const requests = earlierRequests + client.requests;
    log(
      `Snapshot summary: mode=${options.countOnly ? "COUNT-ONLY" : "SNAPSHOT"} outcome=stopped_${error.reason} ` +
        `requests=${requests} file=none`,
    );
    return {
      ...result,
      exitCode: 2,
      outcome: `stopped_${error.reason}`,
      requests,
      stop: { reason: error.reason, detail: error.message },
    };
  };

  // 1-3. List every type over [cutoff, top], newest first.
  const rowsByType = new Map<string, Map<string, Record<string, unknown>>>(journal?.listed ?? []);
  let listedAt = journal?.listedAt ?? null;
  try {
    for (const type of options.types) {
      if (rowsByType.has(type)) {
        log(`  ${type}: ${rowsByType.get(type)!.size} rows (from the journal)`);
        continue;
      }
      await watch.due(true);
      const listed = await listType(
        client,
        congress,
        type,
        { from: options.cutoff, to: top },
        { log, sleep, due: () => watch.due() },
      );
      rowsByType.set(type, listed.rows);
      log(
        `  ${type}: ${listed.rows.size} rows in ${listed.pages} pages (pagination.count ${listed.count ?? "none"}` +
          `${listed.unnamed > 0 ? `, ${listed.unnamed} naming no ${type} bill` : ""}` +
          `${listed.stepBacks > 0 ? `, ${listed.stepBacks} step${listed.stepBacks === 1 ? "" : "s"} back` : ""}` +
          `${listed.reads > 1 ? ", read twice" : ""})`,
      );
      journalAppend(
        [
          `# listing type=${type}`,
          ...[...listed.rows].map(([guid, row]) => `L\t${type}\t${guid}\t${JSON.stringify(row)}`),
          `# listed type=${type} rows=${listed.rows.size} unnamed=${listed.unnamed} count=${listed.count ?? "none"} ` +
            `pages=${listed.pages} at=${now().toISOString()}`,
          "",
        ].join("\n"),
      );
    }
  } catch (error) {
    if (error instanceof StopError) return stopWith(error);
    throw error;
  }
  if (!listedAt) {
    listedAt = now().toISOString();
    journalAppend(`# listedAt=${listedAt}\n`);
  }
  const allRows = [...rowsByType].flatMap(([type, rows]) => [...rows].map(([guid, row]) => ({ type, guid, row })));
  const listRequests = client.requests;
  log(`Listed ${allRows.length} rows with ${listRequests} requests; listedAt=${listedAt}.`);

  // 4-6. Compare each row with its raw copy.
  const keyOf = (guid: string) => `${config.rawPrefix}${guid}.json`;
  const storedKeys = await rawKeysOf(s3, config.bucket, `${config.rawPrefix}BILLS-${congress}`);
  const storage = new BillStorage(s3 as S3Client, config.bucket);
  const unreadable: Array<{ guid: string; error: string }> = [];
  let rowTimesFull = 0;
  let rowTimesDate = 0;
  // In the list's order, whatever order the reads finish in.
  const read = await mapWithConcurrency(allRows, options.concurrency, async ({ type, guid, row }) => {
    const rowTime = recordUpdateTime(row);
    if (rowTime?.full) rowTimesFull += 1;
    else if (rowTime) rowTimesDate += 1;
    let stored: { exists: boolean; time: UpdateTime | null } = { exists: false, time: null };
    let change: TitleChange = "none";
    if (storedKeys.has(keyOf(guid))) {
      try {
        const rawBill = await storage.getJson<Record<string, unknown>>(keyOf(guid));
        if (rawBill) {
          stored = { exists: true, time: storedUpdateTime(rawBill) };
          change = titleChange(rawBill as unknown as RawBill, row, guid);
        }
      } catch (error) {
        unreadable.push({ guid, error: errorText(error) });
        return null;
      }
    }
    const entry: ClassifiedRow = {
      guid,
      type,
      cls: classifyRow({ rowTime, listedTime: parseUpdateTime(row.updateDate), stored, recentFromMs }),
      rowTime,
      storedTime: stored.time,
      row,
      titleChange: change,
    };
    return entry;
  });
  const classified = read.filter((entry): entry is ClassifiedRow => entry !== null);
  if (unreadable.length > 0) {
    unreadable.sort((a, b) => (a.guid < b.guid ? -1 : 1));
    logError(
      `Could not read ${unreadable.length} raw bills: ` +
        unreadable
          .slice(0, 20)
          .map((entry) => `${entry.guid} (${entry.error})`)
          .join(", "),
    );
    journalAppend(`# requests ${client.requests}\n`);
    log(`Snapshot summary: mode=${options.countOnly ? "COUNT-ONLY" : "SNAPSHOT"} outcome=read_failed file=none`);
    return { ...result, exitCode: 1, outcome: "read_failed", requests: earlierRequests + client.requests };
  }

  // 6. The same-date rows: one detail request each (none with --count-only).
  const sameDate = classified.filter((entry) => entry.cls === "same_date");
  if (!options.countOnly && sameDate.length > 0) {
    const toAsk = sameDate.filter((entry) => !journal?.details.has(entry.guid));
    const hours = Math.round((toAsk.length / options.perHour) * 10) / 10;
    log(
      `${sameDate.length} rows have the stored copy's date: ${sameDate.length - toAsk.length} details from the journal, ` +
        `${toAsk.length} to ask (about ${hours} hours at ${options.perHour} an hour).`,
    );
    let asked = 0;
    let failed = 0;
    try {
      if (toAsk.length > 0) await watch.due(true);
      await mapWithConcurrency(sameDate, options.concurrency, async (entry) => {
        let detail = journal?.details.get(entry.guid) ?? null;
        if (!detail) {
          const number = entry.guid.slice(`BILLS-${congress}${entry.type}`.length);
          await watch.due();
          try {
            const payload = await client.get(`bill/${congress}/${entry.type}/${number}`);
            detail = recordUpdateTime(payload.bill);
            if (detail) journalAppend(`D\t${entry.guid}\t${detail.text}\n`);
          } catch (error) {
            if (error instanceof StopError) throw error;
            failed += 1;
            logError(`  ${entry.guid}: the detail request failed (${errorText(error)}); unresolved`);
          }
          asked += 1;
          if (asked % LOG_EVERY_DETAILS === 0) log(`  details: ${asked} / ${toAsk.length}`);
        }
        entry.cls = classifyByDetail(detail, entry.storedTime);
      });
    } catch (error) {
      if (error instanceof StopError) return stopWith(error);
      throw error;
    }
    if (failed > 0) log(`${failed} detail requests failed: those bills are unresolved, and sent all the same.`);
  }

  // Counts.
  for (const entry of classified) {
    result.counts[entry.cls] += 1;
    result.byType[entry.type] ??= emptyCounts();
    result.byType[entry.type][entry.cls] += 1;
  }
  const selected = classified.filter((entry) => (SNAPSHOT_CLASSES as readonly string[]).includes(entry.cls));
  selected.sort(snapshotOrder);
  result.rows = selected;
  const titles =
    `titles_differ=${selected.filter((entry) => entry.titleChange === "differs").length} ` +
    `titles_govinfo=${selected.filter((entry) => entry.titleChange === "govinfo").length}`;
  result.requests = earlierRequests + client.requests;
  const shown: readonly RowClass[] = options.countOnly
    ? COUNTED_CLASSES
    : COUNTED_CLASSES.filter((cls) => cls !== "same_date");
  const byMonth: Record<string, Counts> = {};
  for (const entry of classified) {
    const month = entry.rowTime?.day.slice(0, 7) ?? "none";
    byMonth[month] ??= emptyCounts();
    byMonth[month][entry.cls] += 1;
  }
  log(`counts: ${countsLine(result.counts, shown)} ${titles}`);
  for (const type of options.types) {
    if (result.byType[type]) log(`  type ${type}: ${countsLine(result.byType[type], shown)}`);
  }
  for (const month of Object.keys(byMonth).sort().reverse())
    log(`  month ${month}: ${countsLine(byMonth[month], shown)}`);
  const sends = selected.length + (options.countOnly ? result.counts.same_date : 0);
  log(
    `The backfill: ${selected.length} bills${options.countOnly ? ` (and up to ${result.counts.same_date} same-date bills a detail would decide)` : ""}, ` +
      `about ${sends * CALLS_PER_REFETCH} congress.gov calls, ${Math.round((sends / BACKFILL_PER_HOUR) * 10) / 10} hours ` +
      `of sending, ${Math.ceil(sends / BACKFILL_BATCH)} windows of ${BACKFILL_BATCH}.`,
  );
  if (options.countOnly && result.counts.same_date > 0) {
    log(
      `A snapshot asks ${result.counts.same_date} detail requests for the same-date rows: about ` +
        `${Math.round((result.counts.same_date / options.perHour) * 10) / 10} hours at ${options.perHour} an hour.`,
    );
  }
  const rowTimes = rowTimesFull === 0 ? "date" : rowTimesDate === 0 ? "full" : "mixed";

  if (!options.countOnly) {
    const settings: SnapshotSettings = {
      congress,
      cutoff: options.cutoff,
      top,
      listedAt,
      rowTimes,
      requests: result.requests,
      types,
      recentHours: options.recentHours,
      recentFrom,
    };
    const countLines = [
      `# counts ${countsLine(result.counts, shown)} ${titles}`,
      ...options.types
        .filter((type) => result.byType[type])
        .map((type) => `# type ${type} ${countsLine(result.byType[type], shown)}`),
    ];
    const entries: SnapshotEntry[] = selected.map((entry) => ({
      guid: entry.guid,
      cls: entry.cls as SnapshotClass,
      rowTime: entry.rowTime?.text ?? "-",
      storedTime: entry.storedTime?.text ?? null,
      row: entry.row,
    }));
    writeFile(tmpPath, scrub(formatSnapshot(settings, countLines, entries)));
    rename(tmpPath, outPath);
    remove(journalPath);
    result.file = outPath;
    log(
      `Wrote ${outPath}: ${entries.length} bills. Next: refetch:stale-bills -- --snapshot-file ${outPath} (RUNBOOK 16.1).`,
    );
  }
  log(
    `Snapshot summary: mode=${options.countOnly ? "COUNT-ONLY" : "SNAPSHOT"} outcome=done rows=${classified.length} ` +
      `${countsLine(result.counts)} ${titles} requests=${result.requests} ` +
      `file=${result.file ?? "none"}`,
  );
  return result;
};

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runSnapshot({
    s3: new S3Client({ region: config.region }),
    ssm: new SSMClient({ region: config.region }),
    awsCli: awsCliRunner(config.region),
    config,
    options,
    env,
  });
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  const env = withholdKey(process.env);
  main(env).catch((error) => {
    const key = (env[KEY_ENV] ?? "").trim();
    const text = error instanceof Error ? error.message : String(error);
    console.error("Skipped bill listing failed:", key ? text.split(key).join("<key>") : text);
    process.exitCode = 1;
  });
}
