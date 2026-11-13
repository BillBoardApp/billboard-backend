import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

import { S3Client } from "@aws-sdk/client-s3";
import {
  BILL_TYPES,
  CongressClient,
  DEFAULT_CUTOFF,
  DEMO_KEY,
  JOURNAL_TITLE,
  POLLER_RELISTED_FROM,
  RuleWatch,
  StopError,
  USAGE,
  classifyByDetail,
  classifyRow,
  congressApiTime,
  listType,
  parseArgs,
  parseJournal,
  resolveKey,
  runSnapshot,
  withholdKey,
  type CongressHttpGet,
  type SnapshotDeps,
  type SnapshotOptions,
} from "../../scripts/listSkippedBillUpdates";
import { parseGuidsFile } from "../../scripts/reconcileProcessedBills";
import { configFromEnv } from "../../scripts/refetchStaleBills";
import {
  SNAPSHOT_TITLE,
  laterUpdateTime,
  parseSnapshot,
  parseUpdateTime,
  primaryCongressAt,
  recordUpdateTime,
  storedUpdateTime,
} from "../../scripts/skippedBillSnapshot";

const START = Date.parse("2026-11-12T12:00:00.000Z");
const TOP = "2026-11-12T12:00:00.000Z";
const KEY = "k3y-Secret-Value-123";
const OUT = "/fake/rel56.tsv";
const JOURNAL = `${OUT}.partial`;
const POLLER_STATE = JSON.stringify({
  schemaVersion: 1,
  congress: "119",
  lastRunAt: "2026-11-12T11:55:00.000Z",
  cursors: {
    hr: { lastUpdateAt: "2026-11-12T00:00:00.000Z", lastSeenKey: "k", watermark: "2026-11-12T11:55:00.000Z" },
  },
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const row = (type: string, number: number, updateDate: string, extra: Row = {}): Row => ({
  congress: 119,
  latestAction: { actionDate: updateDate.slice(0, 10), text: "Referred to the Committee." },
  number: String(number),
  originChamber: type.startsWith("s") ? "Senate" : "House",
  title: `Title of BILLS-119${type}${number}`,
  type: type.toUpperCase(),
  updateDate,
  updateDateIncludingText: updateDate,
  url: `https://api.congress.gov/v3/bill/119/${type}/${number}?format=json`,
  ...extra,
});

const store = (guid: string, updateDate: string, includingText = updateDate, title = `Title of ${guid}`) =>
  mockS3.put(`raw-bills/${guid}.json`, {
    schemaVersion: 1,
    kind: "raw",
    storedAt: "2026-10-01T00:00:00.000Z",
    metadata: { guid, title, pubDate: "2026-10-01T00:00:00.000Z", fetchedAt: "2026-10-01T00:00:00.000Z" },
    content: { bill: { bill: { updateDate, updateDateIncludingText: includingText, title } } },
  });

// ─── A fake congress.gov, AWS account, clock and disk ─────────────────────────

interface Gov {
  /** Each type's list in the window, newest first. */
  lists: Record<string, Row[]>;
  /** Detail bills by guid; a guid that is not here answers 404. */
  details: Record<string, Row>;
  /** pagination.count is this much above the list, per type (rows the scan cannot read). */
  countExtra: Record<string, number>;
  /** Answers to force, by request number (1-based), with a status and body. */
  forced: Map<number, { status: number; body: string }>;
  /** Called after each answered list page, to change the list between pages. */
  afterPage: (type: string, offset: number) => void;
  calls: Array<{ url: URL; headers: Record<string, string>; at: number }>;
}

interface World {
  t: number;
  gov: Gov;
  /** describe-rule's answer; "THROW" makes the call fail. */
  ruleState: string;
  pollerState: string | undefined;
  cliCalls: string[][];
  ssmCalls: number;
  files: Map<string, string>;
  fileWrites: string[];
  sleeps: number[];
}

const newWorld = (gov: Partial<Gov> = {}, overrides: Partial<World> = {}): World => ({
  t: START,
  gov: {
    lists: {},
    details: {},
    countExtra: {},
    forced: new Map(),
    afterPage: () => undefined,
    calls: [],
    ...gov,
  },
  ruleState: "ENABLED",
  pollerState: POLLER_STATE,
  cliCalls: [],
  ssmCalls: 0,
  files: new Map(),
  fileWrites: [],
  sleeps: [],
  ...overrides,
});

const congressGov =
  (world: World): CongressHttpGet =>
  async (url, headers) => {
    const parsed = new URL(url);
    world.gov.calls.push({ url: parsed, headers: { ...headers }, at: world.t });
    const forced = world.gov.forced.get(world.gov.calls.length);
    if (forced) return forced;
    const list = parsed.pathname.match(/^\/v3\/bill\/119\/([a-z]+)$/);
    if (list) {
      const type = list[1];
      const rows = world.gov.lists[type] ?? [];
      const offset = Number(parsed.searchParams.get("offset"));
      const limit = Number(parsed.searchParams.get("limit"));
      const body = JSON.stringify({
        bills: rows.slice(offset, offset + limit),
        pagination: { count: rows.length + (world.gov.countExtra[type] ?? 0) },
      });
      world.gov.afterPage(type, offset);
      return { status: 200, body };
    }
    const detail = parsed.pathname.match(/^\/v3\/bill\/119\/([a-z]+)\/(\d+)$/);
    if (detail) {
      const bill = world.gov.details[`BILLS-119${detail[1]}${detail[2]}`];
      return bill ? { status: 200, body: JSON.stringify({ bill }) } : { status: 404, body: '{"error":"not found"}' };
    }
    return { status: 400, body: "unexpected" };
  };

const awsFakes = (world: World) => ({
  ssm: {
    send: jest.fn(async () => {
      world.ssmCalls += 1;
      if (world.pollerState === undefined) throw Object.assign(new Error("ParameterNotFound"), { name: "x" });
      return { Parameter: { Value: world.pollerState } };
    }),
  } as unknown as SnapshotDeps["ssm"],
  awsCli: jest.fn(async (args: readonly string[]) => {
    world.cliCalls.push([...args]);
    if (args[1] === "get-alias")
      return JSON.stringify("arn:aws:lambda:us-east-1:000000000000:function:BillsApiPoller:prod");
    if (args[1] === "list-rule-names-by-target") return JSON.stringify(["BillsApiPollerSchedule"]);
    if (args[1] === "describe-rule") {
      if (world.ruleState === "THROW") throw new Error("aws events describe-rule failed: the SSO session has expired");
      return JSON.stringify(world.ruleState);
    }
    throw new Error(`unexpected aws ${args.join(" ")}`);
  }),
});

const options = (overrides: Partial<SnapshotOptions> = {}): SnapshotOptions => ({
  ...parseArgs([]),
  out: OUT,
  ...overrides,
});

const run = async (
  world: World,
  cli: Partial<SnapshotOptions> = {},
  extra: Partial<SnapshotDeps> = {},
  env: NodeJS.ProcessEnv = { CONGRESS_API_KEY: KEY },
) => {
  const lines: string[] = [];
  const errors: string[] = [];
  const result = await runSnapshot({
    s3: new S3Client({}),
    ...awsFakes(world),
    config: configFromEnv({}),
    options: options(cli),
    env,
    httpGet: congressGov(world),
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    logError: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    now: () => new Date(world.t),
    sleep: async (ms: number) => {
      world.sleeps.push(ms);
      world.t += ms;
    },
    readFile: (path: string) => world.files.get(path) ?? null,
    writeFile: (path: string, text: string) => {
      world.fileWrites.push(`write ${path}`);
      world.files.set(path, text);
    },
    appendFile: (path: string, text: string) => {
      world.fileWrites.push(`append ${path}`);
      world.files.set(path, (world.files.get(path) ?? "") + text);
    },
    rename: (from: string, to: string) => {
      world.fileWrites.push(`rename ${from} ${to}`);
      world.files.set(to, world.files.get(from)!);
      world.files.delete(from);
    },
    remove: (path: string) => {
      world.fileWrites.push(`remove ${path}`);
      world.files.delete(path);
    },
    ...extra,
  });
  return { result, lines, errors, text: [...lines, ...errors].join("\n") };
};

/**
 * A sleep on a fake clock that runs timers in the order they end, so sleeps in flight at once overlap as real ones do
 * (the plain fake adds every sleep to the clock).
 */
const timerSleep = (world: World) => {
  const timers: Array<{ at: number; resolve: () => void }> = [];
  return (ms: number) =>
    new Promise<void>((resolve) => {
      timers.push({ at: world.t + ms, resolve });
      setImmediate(() => {
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        if (!next) return;
        world.t = Math.max(world.t, next.at);
        next.resolve();
      });
    });
};

const listCalls = (world: World) =>
  world.gov.calls.filter((call) => /^\/v3\/bill\/119\/[a-z]+$/.test(call.url.pathname));
const detailCalls = (world: World) =>
  world.gov.calls.filter((call) => /^\/v3\/bill\/119\/[a-z]+\/\d+$/.test(call.url.pathname));

/** The standard world: one row of each class (hr and s), each stored copy as the comment says. */
const seedStandard = (): World => {
  const rows = {
    hr: [
      row("hr", 503, "2026-11-11"), // recent (its whole day is after recentFrom)
      row("hr", 9821, "2026-10-20"), // stale: stored 10-01
      row("hr", 500, "2026-10-20"), // same date, a date alone: the detail says 15:00, after 08:00: stale_same_day
      row("hr", 501, "2026-10-20"), // same date: the detail is the stored time: fresh
      row("hr", 502, "2026-10-19"), // fresh: stored on a later day
      row("hr", 504, "2026-10-18"), // same date, the detail answers 500: unresolved
      // Full times, the later after the stored 19:00. (A date alone with a time the same day goes to the detail.)
      row("hr", 505, "2026-10-17T18:00:00Z", { updateDateIncludingText: "2026-10-17T20:00:00Z" }),
      row("hr", 10953, "2026-10-16"), // never stored: missing
      row("hr", 507, "2026-09-01", { updateDateIncludingText: "2026-10-15" }), // the row's later field: stale
      row("hr", 506, "2026-10-10"), // the stored copy's later field is 10-12: fresh
    ],
    s: [row("s", 12, "2026-10-20")], // never stored: missing, before hr9821 on the same date
  };
  store("BILLS-119hr503", "2026-09-01T00:00:00Z");
  store("BILLS-119hr9821", "2026-10-01T10:00:00Z", "2026-10-01T10:00:00Z", "An older title");
  store("BILLS-119hr500", "2026-10-20T08:00:00Z");
  store("BILLS-119hr501", "2026-10-20T16:00:00Z");
  store("BILLS-119hr502", "2026-10-21T00:00:00Z");
  store("BILLS-119hr504", "2026-10-18T09:00:00Z");
  store("BILLS-119hr505", "2026-10-17T19:00:00Z");
  store("BILLS-119hr507", "2026-10-01T00:00:00Z");
  store("BILLS-119hr506", "2026-09-01T00:00:00Z", "2026-10-12T00:00:00Z");
  return newWorld({
    lists: rows,
    details: {
      "BILLS-119hr500": { updateDate: "2026-10-20T15:00:00Z", updateDateIncludingText: "2026-10-20T15:00:00Z" },
      "BILLS-119hr501": { updateDate: "2026-10-20T16:00:00Z", updateDateIncludingText: "2026-10-20T16:00:00Z" },
    },
    // hr504's detail request is the 5th request (2 lists, then hr500, hr501, hr504 in list order).
    forced: new Map([[5, { status: 500, body: `{"error":"upstream ${KEY} broke"}` }]]),
  });
};

beforeEach(() => {
  mockS3 = new FakeVersionedS3();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

// ─── Arguments and the key ────────────────────────────────────────────────────

describe("arguments and the key", () => {
  it("defaults to the design's settings", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      countOnly: false,
      cutoff: "2026-03-05T00:00:00.000Z",
      types: ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"],
      out: "rel56-snapshot.tsv",
      perHour: 1500,
      recentHours: 48,
      concurrency: 8,
      maxRequests: null,
      demoKey: false,
      separateKey: false,
    });
    expect(DEFAULT_CUTOFF).toBe("2026-03-05T00:00:00.000Z");
    expect(BILL_TYPES).toHaveLength(8);
  });

  it("parses every flag, keeps the types in the poller's order, and refuses bad values and unknown flags", () => {
    expect(
      parseArgs([
        "--count-only",
        "--cutoff",
        "2025-01-03T00:00:00Z",
        "--types",
        "sres,HR,hr",
        "--out",
        "x.tsv",
        "--per-hour",
        "4000",
        "--recent-hours",
        "0",
        "--concurrency",
        "25",
        "--max-requests",
        "90",
        "--separate-key",
      ]),
    ).toEqual({
      help: false,
      countOnly: true,
      cutoff: "2025-01-03T00:00:00.000Z",
      types: ["hr", "sres"],
      out: "x.tsv",
      perHour: 4000,
      recentHours: 0,
      concurrency: 25,
      maxRequests: 90,
      demoKey: false,
      separateKey: true,
    });
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(() => parseArgs(["--per-hour", "0"])).toThrow("--per-hour needs a whole number from 1 to 4000");
    expect(() => parseArgs(["--per-hour", "4001"])).toThrow("from 1 to 4000");
    expect(() => parseArgs(["--recent-hours", "721"])).toThrow("from 0 to 720");
    expect(() => parseArgs(["--concurrency", "26"])).toThrow("from 1 to 25");
    expect(() => parseArgs(["--max-requests", "0"])).toThrow("--max-requests");
    expect(() => parseArgs(["--types", "hr,xx"])).toThrow("--types takes");
    expect(() => parseArgs(["--types", ""])).toThrow("--types needs a value");
    expect(() => parseArgs(["--cutoff", "yesterday"])).toThrow("--cutoff needs an ISO time");
    expect(() => parseArgs(["--cutoff"])).toThrow("--cutoff needs a value");
    expect(() => parseArgs(["--apply"])).toThrow("Unknown argument: --apply");
    expect(() => parseArgs(["--api-key", KEY])).toThrow("Unknown argument: --api-key");
  });

  it("takes --per-hour above 1500 only with --separate-key, the statement that the key is not production's", () => {
    // The production key's 5,000 an hour is shared with the poller and FetchRawBill (a peak of about 1,100 an hour):
    // 4,000 more would pass the limit. The script cannot tell keys apart, so the flag states that it is another key.
    expect(parseArgs(["--per-hour", "1500"])).toMatchObject({ perHour: 1500, separateKey: false });
    expect(() => parseArgs(["--per-hour", "1501"])).toThrow(
      "--per-hour above 1500 needs --separate-key: the production key is shared with the poller and FetchRawBill",
    );
    expect(() => parseArgs(["--per-hour", "4000"])).toThrow("needs --separate-key");
    expect(parseArgs(["--per-hour", "4000", "--separate-key"])).toMatchObject({ perHour: 4000, separateKey: true });
    expect(parseArgs(["--separate-key", "--per-hour", "2500"])).toMatchObject({ perHour: 2500, separateKey: true });
    expect(parseArgs(["--separate-key"])).toMatchObject({ perHour: 1500, separateKey: true });
    expect(() => parseArgs(["--per-hour", "4001", "--separate-key"])).toThrow("from 1 to 4000");
    expect(USAGE).toContain("--separate-key");
  });

  it("caps a --demo-key run at 5 requests", () => {
    expect(parseArgs(["--demo-key"]).maxRequests).toBe(5);
    expect(parseArgs(["--demo-key", "--max-requests", "3"]).maxRequests).toBe(3);
    expect(parseArgs(["--max-requests", "50", "--demo-key"]).maxRequests).toBe(5);
  });

  it("reads the key from CONGRESS_API_KEY only, and refuses without it unless --demo-key", () => {
    expect(() => resolveKey({}, { demoKey: false })).toThrow("CONGRESS_API_KEY is not set");
    expect(() => resolveKey({ CONGRESS_API_KEY: "  " }, { demoKey: false })).toThrow("is not set");
    expect(() => resolveKey({ CONGRESS_API_KEY: "ab cd" }, { demoKey: false })).toThrow("a space or a line break");
    expect(resolveKey({ CONGRESS_API_KEY: ` ${KEY}\n` }, { demoKey: false })).toEqual({
      key: KEY,
      secret: true,
      label: `CONGRESS_API_KEY (${KEY.length} characters, not shown)`,
    });
    expect(resolveKey({ CONGRESS_API_KEY: KEY }, { demoKey: true })).toMatchObject({ key: DEMO_KEY, secret: false });
  });

  it("--help shows the key read with read -rs, never typed on the command line", () => {
    expect(USAGE).toContain("read -rs CONGRESS_API_KEY; export CONGRESS_API_KEY");
    expect(USAGE).toContain("unset CONGRESS_API_KEY");
    expect(USAGE).not.toMatch(/CONGRESS_API_KEY=/);
    expect(USAGE).toContain("  npm run list:skipped-bill-updates -- --count-only ");
  });

  it("takes the key out of its own environment, so the aws CLI processes it starts do not inherit it", () => {
    const processEnv: NodeJS.ProcessEnv = { CONGRESS_API_KEY: KEY, AWS_PROFILE: "billboard" };
    const env = withholdKey(processEnv);
    expect(env).toEqual({ CONGRESS_API_KEY: KEY, AWS_PROFILE: "billboard" });
    expect(processEnv).toEqual({ AWS_PROFILE: "billboard" });
    expect(resolveKey(env, { demoKey: false }).key).toBe(KEY);
  });

  it("refuses to run without the key before any AWS or congress.gov call", async () => {
    const world = seedStandard();
    await expect(run(world, {}, {}, {})).rejects.toThrow("CONGRESS_API_KEY is not set");
    expect(world.gov.calls).toEqual([]);
    expect(world.cliCalls).toEqual([]);
    expect(world.ssmCalls).toBe(0);
    expect(mockS3.calls).toEqual([]);
  });

  it("refuses a cutoff that is not before the run's start, and an existing snapshot file", async () => {
    await expect(run(newWorld(), { cutoff: "2026-11-12T12:00:00.000Z" })).rejects.toThrow(
      "is not before the run's start",
    );
    const world = newWorld();
    world.files.set(OUT, "a finished snapshot");
    await expect(run(world)).rejects.toThrow(`${OUT} exists`);
    expect(world.gov.calls).toEqual([]);
  });
});

// ─── Update times and classification ──────────────────────────────────────────

describe("update times and classification", () => {
  const t = (value: string) => parseUpdateTime(value)!;
  const recentFromMs = Date.parse("2026-11-10T12:00:00.000Z");

  it("reads dates alone and full times, and takes the later of the two fields", () => {
    expect(parseUpdateTime("2026-10-16")).toEqual({
      text: "2026-10-16",
      ms: Date.parse("2026-10-16T00:00:00Z"),
      day: "2026-10-16",
      full: false,
    });
    expect(parseUpdateTime("2026-11-07T00:23:51Z")).toMatchObject({ text: "2026-11-07T00:23:51.000Z", full: true });
    expect(parseUpdateTime("Oct 16 2026")).toBeNull();
    expect(parseUpdateTime(20261016)).toBeNull();
    expect(laterUpdateTime(t("2026-10-15"), t("2026-10-16"))?.text).toBe("2026-10-16");
    // The same day: a date alone over a full time (it may be later that day); the later of two full times.
    expect(laterUpdateTime(t("2026-10-16"), t("2026-10-16T08:00:00Z"))?.text).toBe("2026-10-16");
    expect(laterUpdateTime(t("2026-10-16T08:00:00Z"), t("2026-10-16"))?.text).toBe("2026-10-16");
    expect(laterUpdateTime(t("2026-10-16T09:00:00Z"), t("2026-10-16T08:00:00Z"))?.text).toBe(
      "2026-10-16T09:00:00.000Z",
    );
    expect(laterUpdateTime(null, t("2026-10-16"))?.text).toBe("2026-10-16");
    expect(
      recordUpdateTime({ updateDate: "2026-04-16T15:21:20Z", updateDateIncludingText: "2026-10-31T16:28:03Z" })?.text,
    ).toBe("2026-10-31T16:28:03.000Z");
    expect(storedUpdateTime({ content: { bill: { bill: { updateDate: "2026-10-01T00:00:00Z" } } } })?.text).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(storedUpdateTime({ content: {} })).toBeNull();
  });

  it("classifies by the stored copy, the recent cut, the date, then the time", () => {
    const stored = (time: string | null) => ({ exists: true, time: time ? t(time) : null });
    const classify = (rowTime: string | null, storedTime: string | null, exists = true, listedTime = rowTime) =>
      classifyRow({
        rowTime: rowTime ? t(rowTime) : null,
        listedTime: listedTime ? t(listedTime) : null,
        stored: exists ? stored(storedTime) : { exists: false, time: null },
        recentFromMs,
      });
    expect(classify("2026-10-16", null, false)).toBe("missing");
    expect(classify("2026-11-11", null, false)).toBe("missing"); // a never-stored bill is never "recent"
    expect(classify("2026-11-11", "2026-01-01T00:00:00Z")).toBe("recent");
    expect(classify("2026-11-10T12:00:00Z", "2026-01-01T00:00:00Z")).toBe("recent");
    expect(classify("2026-11-10T11:59:59Z", "2026-01-01T00:00:00Z")).toBe("stale");
    // A date alone is recent only when its whole day is: 11-10's midnight is before the 12:00 cut.
    expect(classify("2026-11-10", "2026-01-01T00:00:00Z")).toBe("stale");
    expect(classify("2026-10-20", "2026-10-01T10:00:00Z")).toBe("stale");
    expect(classify("2026-10-19", "2026-10-21T00:00:00Z")).toBe("fresh");
    expect(classify("2026-10-20", "2026-10-20T08:00:00Z")).toBe("same_date");
    expect(classify("2026-10-17T20:00:00Z", "2026-10-17T19:00:00Z")).toBe("stale_same_day");
    expect(classify("2026-10-17T19:00:00Z", "2026-10-17T19:00:00Z")).toBe("fresh");
    expect(classify("2026-10-20", null)).toBe("stale"); // a stored copy with no update time
    expect(classify(null, "2026-10-20T08:00:00Z")).toBe("same_date"); // a row with no update date
    // Recent goes by updateDate alone: a text-only change within the cut (updateDateIncludingText 11-11) to a bill
    // last listed on 11-05 was never listed by the poller, so it is compared, with the later time.
    expect(classify("2026-11-11T09:00:00Z", "2026-11-05T08:00:00Z", true, "2026-11-05")).toBe("stale");
    expect(classify("2026-11-11T09:00:00Z", "2026-11-11T09:00:00Z", true, "2026-11-05")).toBe("fresh");
    expect(classify("2026-11-11T09:00:00Z", "2026-11-05T08:00:00Z", true, null)).toBe("stale");
    expect(classify("2026-11-11T09:00:00Z", "2026-11-05T08:00:00Z", true, "2026-11-11")).toBe("recent");
  });

  it("takes a date alone over a full time on the same day, so a mixed row goes to the detail request", () => {
    // A row with a full updateDate and a date-only updateDateIncludingText the same day: the text may have changed
    // later that day than the full time, and later than a copy stored in between. Read as the full time, the row
    // would be fresh against that copy, and the change would be lost.
    const row = recordUpdateTime({ updateDate: "2026-10-17T08:00:00Z", updateDateIncludingText: "2026-10-17" });
    expect(row?.text).toBe("2026-10-17");
    const classified = classifyRow({
      rowTime: row,
      listedTime: t("2026-10-17T08:00:00Z"),
      stored: { exists: true, time: t("2026-10-17T09:00:00Z") },
      recentFromMs,
    });
    expect(classified).toBe("same_date");
    // The other way round as well: the date alone, whichever field it is.
    expect(recordUpdateTime({ updateDate: "2026-10-17", updateDateIncludingText: "2026-10-17T08:00:00Z" })?.text).toBe(
      "2026-10-17",
    );
    // A later day still wins, whatever its precision.
    expect(recordUpdateTime({ updateDate: "2026-10-17T08:00:00Z", updateDateIncludingText: "2026-10-18" })?.text).toBe(
      "2026-10-18",
    );
    expect(recordUpdateTime({ updateDate: "2026-10-17", updateDateIncludingText: "2026-10-18T01:00:00Z" })?.text).toBe(
      "2026-10-18T01:00:00.000Z",
    );
  });

  it("decides a same-date row by its detail, and calls a failed one unresolved", () => {
    expect(classifyByDetail(t("2026-10-20T15:00:00Z"), t("2026-10-20T08:00:00Z"))).toBe("stale_same_day");
    expect(classifyByDetail(t("2026-10-21T01:00:00Z"), t("2026-10-20T08:00:00Z"))).toBe("stale_same_day");
    expect(classifyByDetail(t("2026-10-20T08:00:00Z"), t("2026-10-20T08:00:00Z"))).toBe("fresh");
    expect(classifyByDetail(t("2026-10-19T08:00:00Z"), t("2026-10-20T08:00:00Z"))).toBe("fresh");
    expect(classifyByDetail(null, t("2026-10-20T08:00:00Z"))).toBe("unresolved");
    expect(classifyByDetail(t("2026-10-20"), t("2026-10-20T08:00:00Z"))).toBe("unresolved");
  });

  it("knows the primary Congress around the 120th's start", () => {
    expect(primaryCongressAt(START)).toBe("119");
    expect(primaryCongressAt(Date.parse("2027-01-03T16:59:59Z"))).toBe("119");
    expect(primaryCongressAt(Date.parse("2027-01-03T17:00:00Z"))).toBe("120");
    expect(primaryCongressAt(Date.parse("2025-01-02T00:00:00Z"))).toBe("118");
  });
});

// ─── The snapshot ─────────────────────────────────────────────────────────────

describe("the snapshot", () => {
  it("writes the bills to send, newest first, never stored before stored on the same time (golden)", async () => {
    const world = seedStandard();
    const { result, text } = await run(world, { types: ["hr", "s"] });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done", file: OUT, requests: 5, stop: null });

    const json = (type: string, number: number) =>
      JSON.stringify(world.gov.lists[type].find((entry) => entry.number === String(number)));
    expect(world.files.get(OUT)).toBe(
      [
        SNAPSHOT_TITLE,
        "# congress=119 cutoff=2026-03-05T00:00:00.000Z top=2026-11-12T12:00:00.000Z " +
          "listedAt=2026-11-12T12:00:02.400Z rowTimes=mixed requests=5 types=hr,s recentHours=48 " +
          "recentFrom=2026-11-10T12:00:00.000Z",
        "# counts missing=2 stale=2 stale_same_day=2 unresolved=1 fresh=3 recent=1 titles_differ=1 titles_govinfo=0",
        "# type hr missing=1 stale=2 stale_same_day=2 unresolved=1 fresh=3 recent=1",
        "# type s missing=1 stale=0 stale_same_day=0 unresolved=0 fresh=0 recent=0",
        "# columns: guid, class, row time, stored time (or -), list row (JSON)",
        `BILLS-119s12\tmissing\t2026-10-20\t-\t${json("s", 12)}`,
        `BILLS-119hr500\tstale_same_day\t2026-10-20\t2026-10-20T08:00:00.000Z\t${json("hr", 500)}`,
        `BILLS-119hr9821\tstale\t2026-10-20\t2026-10-01T10:00:00.000Z\t${json("hr", 9821)}`,
        `BILLS-119hr504\tunresolved\t2026-10-18\t2026-10-18T09:00:00.000Z\t${json("hr", 504)}`,
        `BILLS-119hr505\tstale_same_day\t2026-10-17T20:00:00.000Z\t2026-10-17T19:00:00.000Z\t${json("hr", 505)}`,
        `BILLS-119hr10953\tmissing\t2026-10-16\t-\t${json("hr", 10953)}`,
        `BILLS-119hr507\tstale\t2026-10-15\t2026-10-01T00:00:00.000Z\t${json("hr", 507)}`,
        "",
      ].join("\n"),
    );
    // Written whole and renamed; the journal is removed.
    expect(world.fileWrites.slice(-3)).toEqual([`write ${OUT}.tmp`, `rename ${OUT}.tmp ${OUT}`, `remove ${JOURNAL}`]);
    expect(world.files.has(JOURNAL)).toBe(false);

    // Its first column is a guids file for reconcile:processed-bills, and refetch:stale-bills reads it back.
    const guids = [
      "BILLS-119s12",
      "BILLS-119hr500",
      "BILLS-119hr9821",
      "BILLS-119hr504",
      "BILLS-119hr505",
      "BILLS-119hr10953",
      "BILLS-119hr507",
    ];
    expect(parseGuidsFile(world.files.get(OUT)!)).toEqual(guids);
    const parsed = parseSnapshot(world.files.get(OUT)!);
    expect(parsed).toMatchObject({ congress: "119", top: TOP, listedAt: "2026-11-12T12:00:02.400Z" });
    expect(parsed.entries.map((entry) => entry.guid)).toEqual(guids);
    expect(parsed.entries[0]).toEqual({
      guid: "BILLS-119s12",
      cls: "missing",
      rowTime: "2026-10-20",
      storedTime: null,
      row: world.gov.lists.s[0],
    });

    // Only the same-date rows without a time cost a detail request; the 500 made hr504 unresolved.
    expect(detailCalls(world).map((call) => call.url.pathname)).toEqual([
      "/v3/bill/119/hr/500",
      "/v3/bill/119/hr/501",
      "/v3/bill/119/hr/504",
    ]);
    expect(text).toContain(
      "BILLS-119hr504: the detail request failed (congress.gov answered 500 for /v3/bill/119/hr/504",
    );
    expect(text).toContain(
      "counts: missing=2 stale=2 stale_same_day=2 unresolved=1 fresh=3 recent=1 titles_differ=1 titles_govinfo=0",
    );
    expect(text).toContain("  month 2026-10: missing=2 stale=2 stale_same_day=2 unresolved=1 fresh=3 recent=0");
    expect(text).toContain(
      "Snapshot summary: mode=SNAPSHOT outcome=done rows=11 missing=2 stale=2 stale_same_day=2 unresolved=1 fresh=3 " +
        `recent=1 same_date=0 titles_differ=1 titles_govinfo=0 requests=5 file=${OUT}`,
    );
    // Read-only: S3 lists and reads, SSM reads, read-only CLI calls. The rule is read in the preflight, then again
    // before s is listed and before the detail requests (hr, the first type, follows the preflight at once).
    expect(mockS3.calls.every((call) => call.__cmd === "ListObjectsV2" || call.__cmd === "GetObject")).toBe(true);
    expect(world.cliCalls.map((args) => args[1])).toEqual([
      "get-alias",
      "list-rule-names-by-target",
      "describe-rule",
      "describe-rule",
      "describe-rule",
    ]);
  });

  it("sends the key only in the X-Api-Key header, and never prints or writes it", async () => {
    const world = seedStandard();
    const { text } = await run(world, { types: ["hr", "s"] });
    expect(world.gov.calls.length).toBeGreaterThan(0);
    for (const call of world.gov.calls) {
      expect(call.url.origin).toBe("https://api.congress.gov");
      expect(call.url.toString()).not.toContain(KEY);
      expect(call.url.searchParams.has("api_key")).toBe(false);
      expect(call.headers["X-Api-Key"]).toBe(KEY);
      expect(call.headers["User-Agent"]).toContain("BillBoardFetcher");
    }
    // The 500 answer echoed the key: the error line has it scrubbed.
    expect(text).toContain("upstream <key> broke");
    expect(text).not.toContain(KEY);
    for (const [path, content] of world.files) {
      expect(`${path}\n${content}`).not.toContain(KEY);
    }
  });

  it("lists each type over the cutoff to the start, newest first, 250 rows a page at offsets 0, 225, 450", async () => {
    const rows = Array.from({ length: 500 }, (_, index) => row("hr", 20_000 - index, "2026-10-01"));
    const world = newWorld({ lists: { hr: rows } });
    const { result } = await run(world, { types: ["hr"], countOnly: true });
    expect(result.outcome).toBe("done");
    expect(result.counts.missing).toBe(500);
    const calls = listCalls(world);
    expect(calls.map((call) => Number(call.url.searchParams.get("offset")))).toEqual([0, 225, 450]);
    for (const call of calls) {
      expect(call.url.pathname).toBe("/v3/bill/119/hr");
      expect(Object.fromEntries(call.url.searchParams)).toEqual({
        fromDateTime: "2026-03-05T00:00:00Z",
        toDateTime: "2026-11-12T12:00:00Z",
        sort: "updateDate+desc",
        limit: "250",
        offset: call.url.searchParams.get("offset"),
        format: "json",
      });
      // The poller's encoding of the sort ("+" as %2B).
      expect(call.url.search).toContain("sort=updateDate%2Bdesc");
    }
    expect(congressApiTime("2026-03-05T00:00:00.000Z")).toBe("2026-03-05T00:00:00Z");
  });

  it("still reads a row when rows leave the window between pages, thanks to the overlap", async () => {
    const rows = Array.from({ length: 480 }, (_, index) => row("hr", 20_000 - index, "2026-10-01"));
    const world = newWorld({
      lists: { hr: rows },
      // After the first page, the 10 newest rows are updated again (after top): they leave the window, the rest move up.
      afterPage: (type, offset) => {
        if (type === "hr" && offset === 0) world.gov.lists.hr = rows.slice(10);
      },
    });
    const { result } = await run(world, { types: ["hr"], countOnly: true });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
    // Every one of the 480 was read: the 10 on the first page, and the 470 still there. The second page (offset 225)
    // starts at the 236th row of the first reading; at offset 250 it would have stepped over 10 rows.
    expect(result.counts.missing).toBe(480);
    expect(listCalls(world).map((call) => Number(call.url.searchParams.get("offset")))).toEqual([0, 225]);
  });

  it("steps back a page when more rows leave above the offset than the overlap covers, and reads every row", async () => {
    // Review probe (REL-56 backfill): 700 never-stored rows; after the page at offset 225, the 40 newest are updated
    // again (after top) and leave the window, so every row below moves up 40, more than the 25-row overlap. Without the
    // continuity check the page at 450 began at the 491st row: the 15 rows from 476 to 490 were never read, and the last
    // page's count (660) still passed.
    const rows = Array.from({ length: 700 }, (_, index) => row("hr", 20_000 - index, "2026-10-01"));
    const world = newWorld({
      lists: { hr: rows },
      afterPage: (type, offset) => {
        if (type === "hr" && offset === 225 && world.gov.lists.hr.length === 700) world.gov.lists.hr = rows.slice(40);
      },
    });
    const { result, text } = await run(world, { types: ["hr"], countOnly: true });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
    expect(result.counts.missing).toBe(700);
    // The page at 450 shared no row with the end of the page at 225: back to 225, then on.
    expect(listCalls(world).map((call) => Number(call.url.searchParams.get("offset")))).toEqual([
      0, 225, 450, 225, 450,
    ]);
    expect(text).toContain(
      "hr: the page at offset 450 shares no row with the end of the page before (rows left the window above it); " +
        "reading again from offset 225",
    );
    expect(text).toContain("hr: 700 rows in 5 pages (pagination.count 660, 1 step back)");
  });

  it("starts the next page earlier by as many rows as the count dropped between two pages", async () => {
    const rows = Array.from({ length: 900 }, (_, index) => row("hr", 20_000 - index, "2026-10-01"));
    const world = newWorld({
      lists: { hr: rows },
      // Between the first two pages, 20 rows above the second page's offset leave (the overlap still joins the two):
      // the second page shows it in its count (880), and the third page starts 20 rows earlier than 450, as the
      // poller's does.
      afterPage: (type, offset) => {
        if (type === "hr" && offset === 0) world.gov.lists.hr = rows.slice(20);
      },
    });
    const { result, text } = await run(world, { types: ["hr"], countOnly: true });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
    expect(result.counts.missing).toBe(900);
    expect(listCalls(world).map((call) => Number(call.url.searchParams.get("offset")))).toEqual([0, 225, 430, 655]);
    expect(text).not.toContain("shares no row");
  });

  it("stops (count_short) when the pages do not join up in either reading", async () => {
    // After every page at offset 675 the whole list is replaced by other bills: the pages after it never share a row
    // with the end of the page before, two steps back do not mend it, and the second reading fares the same.
    const listOf = (generation: number) =>
      Array.from({ length: 2_000 }, (_, index) => row("hr", 100_000 * (generation + 1) + index, "2026-10-01"));
    let generation = 0;
    const world = newWorld({
      lists: { hr: listOf(0) },
      afterPage: (type, offset) => {
        if (type === "hr" && offset === 675) world.gov.lists.hr = listOf((generation += 1));
      },
    });
    const { result, text } = await run(world, { types: ["hr"] });
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_count_short", file: null });
    expect(result.stop!.detail).toBe(
      "hr: read twice, and the pages did not join up after 2 steps back (rows kept leaving the window); rows between " +
        "two pages may not have been read. Run again later.",
    );
    expect(text).toContain(
      "hr: the pages did not join up after 2 steps back (rows kept leaving the window); reading it once more",
    );
    const offsets = listCalls(world).map((call) => Number(call.url.searchParams.get("offset")));
    // Each reading: 0, 225, 450, 675, then 900 shares nothing, back to 675 and 450, still nothing.
    expect(offsets).toEqual([0, 225, 450, 675, 900, 675, 450, 0, 225, 450, 675, 900, 675, 450]);
    expect(parseJournal(world.files.get(JOURNAL)!).listed.size).toBe(0);
  });

  it("reads a type again when rows left the window before they were read, and passes the second on its own count", async () => {
    const rows = Array.from({ length: 500 }, (_, index) => row("hr", 20_000 - index, "2026-10-01"));
    // In the first reading, 10 rows below the page being read are updated again (they leave the window): it lists 490
    // of the 500 its first page counts. The second lists all 490 its first page counts.
    let pageAt225 = 0;
    const world = newWorld({
      lists: { hr: rows },
      afterPage: (type, offset) => {
        if (type !== "hr" || offset !== 225 || (pageAt225 += 1) !== 1) return;
        world.gov.lists.hr = world.gov.lists.hr.filter((entry) => !rows.slice(480, 490).includes(entry));
      },
    });
    const { result, text } = await run(world, { types: ["hr"], countOnly: true });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
    expect(text).toContain("hr: read 490 distinct rows but congress.gov counts 500; reading it once more");
    // Every row still in the window (the 10 that left before the first reading reached them are the poller's).
    expect(result.counts.missing).toBe(490);
    expect(text).toContain("hr: 490 rows in 6 pages (pagination.count 490, read twice)");

    // Rows leave in both readings: the second lists 485 of the 490 its first page counts. Its last page counts 485,
    // but against that count a row read before it left makes up for a row the reading missed (the next test): stop.
    let again = 0;
    const both = newWorld({
      lists: { hr: rows },
      afterPage: (type, offset) => {
        if (type !== "hr" || offset !== 225) return;
        again += 1;
        const leaving = again === 1 ? rows.slice(480, 490) : rows.slice(495, 500);
        both.gov.lists.hr = both.gov.lists.hr.filter((entry) => !leaving.includes(entry));
      },
    });
    const stopped = await run(both, { types: ["hr"], countOnly: true });
    expect(stopped.result).toMatchObject({ exitCode: 2, outcome: "stopped_count_short" });
    expect(stopped.result.stop!.detail).toBe(
      "hr: read 485 distinct rows twice, but congress.gov counts 490; rows may have moved between pages. Run again later.",
    );
  });

  it("does not pass a second reading in which a row that left makes up for a row a changed order hid", async () => {
    // Review probe (round 2): 500 never-stored rows with the same time. Each request after a page at offset 0 sees
    // rows[100] and rows[300] swapped, so both readings miss rows[300] (BILLS-119hr19700), in the window throughout.
    // In the second, rows[5], already read, is updated again and leaves: the last page counts 499, as many as the
    // reading listed. The rule that a second reading with no new row passes on its last page's count ended this
    // "done" without rows[300]; now only a reading's own first count passes it, and the run stops.
    const rows = Array.from({ length: 500 }, (_, index) => row("hr", 20_000 - index, "2026-10-01"));
    const swap = (list: Row[]) => {
      const out = [...list];
      const [a, b] = [out.indexOf(rows[100]), out.indexOf(rows[300])];
      [out[a], out[b]] = [out[b], out[a]];
      return out;
    };
    let current = rows;
    let page0 = 0;
    const world = newWorld({
      lists: { hr: rows },
      afterPage: (type, offset) => {
        if (type !== "hr") return;
        if (offset === 0 && (page0 += 1) === 2) current = current.filter((entry) => entry !== rows[5]);
        world.gov.lists.hr = offset === 0 ? swap(current) : current;
      },
    });
    const { result, text } = await run(world, { types: ["hr"], countOnly: true });
    expect(text).toContain("hr: read 499 distinct rows but congress.gov counts 500; reading it once more");
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_count_short" });
    expect(result.stop!.detail).toContain("hr: read 499 distinct rows twice, but congress.gov counts 500");
  });

  it("counts a row that names no bill once, though the overlap of two pages reads it twice", async () => {
    // Review probe (round 2): a row with no number at 230 is on the pages at 0 and 225. Counted twice, it made up for
    // rows[300] (BILLS-119hr19700), which a changed order hid from the first reading: 498 + 2 met the count of 500,
    // and the run ended "done" without it. Counted once, the first reading is short and the second lists it.
    const rows = Array.from({ length: 500 }, (_, index) => row("hr", 20_000 - index, "2026-10-01"));
    rows[230] = { ...rows[230], number: undefined };
    const swapped = [...rows];
    [swapped[100], swapped[300]] = [rows[300], rows[100]];
    let page0 = 0;
    const world = newWorld({
      lists: { hr: rows },
      // Only the request after the first page at offset 0 sees the changed order.
      afterPage: (type, offset) => {
        if (type === "hr") world.gov.lists.hr = offset === 0 && (page0 += 1) === 1 ? swapped : rows;
      },
    });
    const { result, text } = await run(world, { types: ["hr"], countOnly: true });
    expect(text).toContain("hr: read 499 distinct rows but congress.gov counts 500; reading it once more");
    expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
    expect(text).toContain("hr: 499 rows in 6 pages (pagination.count 500, 1 naming no hr bill, read twice)");
    expect(result.rows.map((entry) => entry.guid)).toContain("BILLS-119hr19700");
    expect(result.counts.missing).toBe(499);
  });

  it("keeps a row only the second reading found, and stops when that reading is short of its own count", async () => {
    // In the first reading the list's order changes between two pages (rows with the same time): the row at 300 swaps
    // with the row at 100, already read, so the first reading never sees it.
    const rows = Array.from({ length: 500 }, (_, index) => row("hr", 20_000 - index, "2026-10-01"));
    const swapped = [...rows];
    [swapped[100], swapped[300]] = [rows[300], rows[100]];
    let page0 = 0;
    const world = newWorld({
      lists: { hr: rows },
      afterPage: (type, offset) => {
        if (type === "hr" && offset === 0 && (page0 += 1) === 1) world.gov.lists.hr = swapped;
      },
    });
    const { result, text } = await run(world, { types: ["hr"], countOnly: true });
    expect(text).toContain("hr: read 499 distinct rows but congress.gov counts 500; reading it once more");
    expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
    expect(result.counts.missing).toBe(500);

    // The same, but rows also leave while the second reading is read: it found a row the first lacked, so only its own
    // first count can pass it, and it is short.
    page0 = 0;
    let secondReading = false;
    const short = newWorld({
      lists: { hr: rows },
      afterPage: (type, offset) => {
        if (type !== "hr") return;
        if (offset === 0 && (page0 += 1) === 1) short.gov.lists.hr = swapped;
        if (offset === 0 && page0 === 2) secondReading = true;
        if (offset === 225 && secondReading) short.gov.lists.hr = swapped.slice(0, 490);
      },
    });
    const stopped = await run(short, { types: ["hr"], countOnly: true });
    expect(stopped.result).toMatchObject({ exitCode: 2, outcome: "stopped_count_short" });
    expect(stopped.result.stop!.detail).toContain("hr: read 490 distinct rows twice, but congress.gov counts 500");
  });

  it("reads a type once more when it read fewer rows than congress.gov counts, then stops naming it", async () => {
    const world = newWorld({ lists: { hr: [row("hr", 1, "2026-10-01")], s: [row("s", 1, "2026-10-01")] } });
    world.gov.countExtra.s = 3;
    const { result, text } = await run(world, { types: ["hr", "s"] });
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_count_short", file: null });
    expect(result.stop!.detail).toContain("s: read 1 distinct rows twice, but congress.gov counts 4");
    expect(text).toContain("s: read 1 distinct rows but congress.gov counts 4; reading it once more");
    expect(listCalls(world).map((call) => call.url.pathname)).toEqual([
      "/v3/bill/119/hr",
      "/v3/bill/119/s",
      "/v3/bill/119/s",
    ]);
    // The journal keeps hr, listed in full; s is listed again on the rerun.
    const journal = parseJournal(world.files.get(JOURNAL)!);
    expect([...journal.listed.keys()]).toEqual(["hr"]);
    expect(world.files.has(OUT)).toBe(false);

    // A count that drops on the second reading (rows left the window) passes.
    const recovers = newWorld({ lists: { s: [row("s", 1, "2026-10-01")] } });
    recovers.gov.countExtra.s = 3;
    recovers.gov.afterPage = () => (recovers.gov.countExtra.s = 0);
    const second = await run(recovers, { types: ["s"], countOnly: true });
    expect(second.result.outcome).toBe("done");
    expect(listCalls(recovers)).toHaveLength(2);
  });

  it("paces requests to --per-hour, detail requests in flight at once included", async () => {
    const world = seedStandard();
    world.gov.forced.clear();
    world.gov.details["BILLS-119hr504"] = { updateDate: "2026-10-18T10:00:00Z" };
    await run(world, { types: ["hr", "s"], perHour: 1500, concurrency: 8 }, { sleep: timerSleep(world) });
    const starts = world.gov.calls.map((call) => call.at - START);
    expect(starts).toEqual([0, 2_400, 4_800, 7_200, 9_600]);
    // At 1 an hour, two requests are an hour apart.
    const client = new CongressClient({
      key: KEY,
      httpGet: async () => ({ status: 200, body: "{}" }),
      perHour: 1,
      maxRequests: null,
      now: () => new Date(world.t),
      sleep: async (ms) => {
        world.t += ms;
      },
      scrub: (line) => line,
    });
    const before = world.t;
    await client.get("bill/119/hr");
    await client.get("bill/119/hr");
    expect(world.t - before).toBe(3_600_000);
  });

  it("stops at the first 429 with exit 2, keeps the journal, and a rerun resumes it", async () => {
    const world = seedStandard();
    // hr500's detail (the 3rd request) is refused: nothing after it is asked.
    world.gov.forced = new Map([[3, { status: 429, body: '{"error":{"code":"OVER_RATE_LIMIT"}}' }]]);
    const first = await run(world, { types: ["hr", "s"], concurrency: 1 });
    expect(first.result).toMatchObject({ exitCode: 2, outcome: "stopped_rate_limited", file: null, requests: 3 });
    expect(first.text).toContain("Stopped: rate_limited: congress.gov answered 429 for /v3/bill/119/hr/500");
    expect(first.text).toContain("OVER_RATE_LIMIT");
    expect(world.gov.calls).toHaveLength(3);
    expect(world.files.has(OUT)).toBe(false);
    const journal = parseJournal(world.files.get(JOURNAL)!);
    expect(journal.settings).toEqual({
      congress: "119",
      cutoff: DEFAULT_CUTOFF,
      top: TOP,
      types: "hr,s",
      recentHours: 48,
    });
    expect([...journal.listed.keys()]).toEqual(["hr", "s"]);
    expect(journal.listed.get("hr")!.size).toBe(10);
    expect(journal.listedAt).toBe("2026-11-12T12:00:02.400Z");
    expect(journal.requests).toBe(3);
    expect(world.files.get(JOURNAL)!.split("\n")[0]).toBe(JOURNAL_TITLE);

    // The next day: the same top, no list request, hr500 and the rest asked once.
    world.t = START + 24 * 3_600_000;
    world.gov.forced = new Map();
    world.gov.details["BILLS-119hr504"] = { updateDate: "2026-10-18T10:00:00Z" };
    const callsBefore = world.gov.calls.length;
    const second = await run(world, { types: ["hr", "s"], concurrency: 1 });
    expect(second.result).toMatchObject({ exitCode: 0, outcome: "done", file: OUT, requests: 6 });
    expect(world.gov.calls.slice(callsBefore).map((call) => call.url.pathname)).toEqual([
      "/v3/bill/119/hr/500",
      "/v3/bill/119/hr/501",
      "/v3/bill/119/hr/504",
    ]);
    expect(second.text).toContain("top=2026-11-12T12:00:00.000Z (from the journal)");
    const snapshot = parseSnapshot(world.files.get(OUT)!);
    expect(snapshot).toMatchObject({ top: TOP, listedAt: "2026-11-12T12:00:02.400Z" });
    expect(snapshot.settings.requests).toBe("6");
    expect(snapshot.entries.find((entry) => entry.guid === "BILLS-119hr504")?.cls).toBe("stale_same_day");
    expect(world.files.has(JOURNAL)).toBe(false);

    // A detail already in the journal is not asked again.
    const third = seedStandard();
    third.gov.forced = new Map([[4, { status: 429, body: "{}" }]]);
    await run(third, { types: ["hr", "s"], concurrency: 1 });
    expect(parseJournal(third.files.get(JOURNAL)!).details.get("BILLS-119hr500")?.text).toBe(
      "2026-10-20T15:00:00.000Z",
    );
    third.gov.forced = new Map();
    const before = third.gov.calls.length;
    await run(third, { types: ["hr", "s"], concurrency: 1 });
    expect(third.gov.calls.slice(before).map((call) => call.url.pathname)).toEqual([
      "/v3/bill/119/hr/501",
      "/v3/bill/119/hr/504",
    ]);
  });

  it("sends no request already waiting for its turn after the first 429, with detail requests in flight at once", async () => {
    // Review probe: 8 detail requests paced and waiting; the first answers 429. Before, the other 7 still went out.
    const numbers = Array.from({ length: 12 }, (_, index) => 600 + index);
    for (const number of numbers) store(`BILLS-119hr${number}`, "2026-10-20T08:00:00Z");
    const world = newWorld({
      lists: { hr: numbers.map((number) => row("hr", number, "2026-10-20")) },
      forced: new Map([[2, { status: 429, body: '{"error":{"code":"OVER_RATE_LIMIT"}}' }]]),
    });
    const { result, text } = await run(
      world,
      { types: ["hr"], perHour: 1500, concurrency: 8 },
      { sleep: timerSleep(world) },
    );
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_rate_limited", requests: 2 });
    // The list page and the first detail request only.
    expect(world.gov.calls.map((call) => call.url.pathname)).toEqual(["/v3/bill/119/hr", "/v3/bill/119/hr/600"]);
    expect(text).toContain("Stopped: rate_limited: congress.gov answered 429 for /v3/bill/119/hr/600");
    expect(parseJournal(world.files.get(JOURNAL)!).requests).toBe(2);

    // A request asked after the stop is not sent either.
    const client = new CongressClient({
      key: KEY,
      httpGet: async () => ({ status: 403, body: "{}" }),
      perHour: 1500,
      maxRequests: null,
      now: () => new Date(world.t),
      sleep: async () => undefined,
      scrub: (line) => line,
    });
    await expect(client.get("bill/119/hr/1")).rejects.toThrow("congress.gov answered 403 for /v3/bill/119/hr/1");
    await expect(client.get("bill/119/hr/2")).rejects.toThrow("(/v3/bill/119/hr/2 not sent)");
    expect(client.requests).toBe(1);
  });

  it("checks the poller rule again before each type: a window opened during the run stops it, and a rerun resumes", async () => {
    // Review probe (round 2): the preflight's check alone let a 4.1 window opened during a 2.5-hour snapshot add the
    // snapshot's requests to the refetch's on the same key (1,500 and 4,000 an hour, against 5,000).
    const world = seedStandard();
    world.gov.forced.clear();
    world.gov.details["BILLS-119hr504"] = { updateDate: "2026-10-18T10:00:00Z" };
    world.gov.afterPage = (type) => {
      if (type === "hr") world.ruleState = "DISABLED";
    };
    const first = await run(world, { types: ["hr", "s"] });
    expect(first.result).toMatchObject({ exitCode: 2, outcome: "stopped_window_open", file: null, requests: 1 });
    expect(first.result.stop!.detail).toBe(
      "BillsApiPollerSchedule DISABLED: a quiet window opened during the run. Run the same command again once it is " +
        "closed.",
    );
    // hr's page only; s is not listed.
    expect(listCalls(world).map((call) => call.url.pathname)).toEqual(["/v3/bill/119/hr"]);
    expect(world.cliCalls.map((args) => args[1])).toEqual([
      "get-alias",
      "list-rule-names-by-target",
      "describe-rule",
      "describe-rule",
    ]);
    expect([...parseJournal(world.files.get(JOURNAL)!).listed.keys()]).toEqual(["hr"]);
    expect(first.text).toContain(`The journal ${JOURNAL} is kept: run the same command again to resume.`);

    // The window closed: the same command lists s alone and finishes.
    world.ruleState = "ENABLED";
    world.gov.afterPage = () => undefined;
    const callsBefore = world.gov.calls.length;
    const second = await run(world, { types: ["hr", "s"] });
    expect(second.result).toMatchObject({ exitCode: 0, outcome: "done", file: OUT });
    expect(world.gov.calls.slice(callsBefore).map((call) => call.url.pathname)).toEqual([
      "/v3/bill/119/s",
      "/v3/bill/119/hr/500",
      "/v3/bill/119/hr/501",
      "/v3/bill/119/hr/504",
    ]);
  });

  it("checks the poller rule every 100 requests among the detail requests, and sends none waiting after a window", async () => {
    const numbers = Array.from({ length: 300 }, (_, index) => 1_000 + index);
    for (const number of numbers) store(`BILLS-119hr${number}`, "2026-10-20T08:00:00Z");
    const world = newWorld({
      lists: { hr: numbers.map((number) => row("hr", number, "2026-10-20")) },
      details: Object.fromEntries(
        numbers.map((number) => [`BILLS-119hr${number}`, { updateDate: "2026-10-20T15:00:00Z" }]),
      ),
    });
    // The window opens once 150 detail requests have been answered.
    const gov = congressGov(world);
    const httpGet: CongressHttpGet = async (url, headers) => {
      const answer = await gov(url, headers);
      if (detailCalls(world).length === 150) world.ruleState = "DISABLED";
      return answer;
    };
    const { result } = await run(
      world,
      { types: ["hr"], perHour: 1500, concurrency: 8 },
      { httpGet, sleep: timerSleep(world) },
    );
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_window_open", file: null });
    // Checks: the preflight, before the details, then after 100 and 200 detail requests had started. The last finds
    // the window: of those 200, the 7 still waiting for their turn (8 in flight at once) are not sent.
    expect(world.cliCalls.filter((args) => args[1] === "describe-rule")).toHaveLength(4);
    const asked = detailCalls(world).length;
    expect(asked).toBe(193);
    expect(result.requests).toBe(2 + asked);
    const journal = parseJournal(world.files.get(JOURNAL)!);
    expect(journal.details.size).toBe(asked);

    // After the window: the rest only, each asked once.
    world.ruleState = "ENABLED";
    const before = world.gov.calls.length;
    const second = await run(world, { types: ["hr"], perHour: 1500, concurrency: 8 }, { sleep: timerSleep(world) });
    expect(second.result).toMatchObject({ exitCode: 0, outcome: "done" });
    expect(world.gov.calls.length - before).toBe(300 - asked);
    expect(second.result.counts.stale_same_day).toBe(300);
  });

  it("stops (check_failed) when the poller rule cannot be checked during the run", async () => {
    const world = seedStandard();
    world.gov.afterPage = (type) => {
      if (type === "hr") world.ruleState = "THROW";
    };
    const { result } = await run(world, { types: ["hr", "s"] });
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_check_failed", file: null, requests: 1 });
    expect(result.stop!.detail).toBe(
      "the poller rule could not be checked (aws events describe-rule failed: the SSO session has expired); check " +
        "the AWS login, then run the same command",
    );
    expect(world.files.has(JOURNAL)).toBe(true);
  });

  it("refuses to resume a journal started with other settings", async () => {
    const world = seedStandard();
    world.gov.forced = new Map([[1, { status: 429, body: "{}" }]]);
    await run(world, { types: ["hr", "s"] });
    expect(world.files.has(JOURNAL)).toBe(true);
    await expect(run(world, { types: ["hr", "s"], cutoff: "2025-01-03T00:00:00.000Z" })).rejects.toThrow(
      "was started with --cutoff 2026-03-05T00:00:00.000Z",
    );
    await expect(run(world, { types: ["hr"] })).rejects.toThrow("--types hr,s");
    await expect(run(world, { types: ["hr", "s"], recentHours: 24 })).rejects.toThrow("--recent-hours 48");
  });

  it.each<[number, string]>([
    [401, "key_refused"],
    [403, "key_refused"],
    [429, "rate_limited"],
  ])("stops at a %d without trying again", async (status, reason) => {
    const world = seedStandard();
    world.gov.forced = new Map([[1, { status, body: `{"error":"no ${KEY}"}` }]]);
    const { result, text } = await run(world, { types: ["hr", "s"] });
    expect(result).toMatchObject({ exitCode: 2, outcome: `stopped_${reason}` });
    expect(world.gov.calls).toHaveLength(1);
    expect(text).not.toContain(KEY);
  });

  it("tries a failing list page 3 times, then stops", async () => {
    const world = seedStandard();
    world.gov.forced = new Map([
      [1, { status: 503, body: "busy" }],
      [2, { status: 503, body: "busy" }],
    ]);
    const recovered = await run(world, { types: ["hr"], countOnly: true });
    expect(recovered.result.outcome).toBe("done");
    expect(recovered.text).toContain(
      "hr at offset 0: congress.gov answered 503 for /v3/bill/119/hr: busy; trying again (2 of 3)",
    );

    const broken = seedStandard();
    broken.gov.forced = new Map([1, 2, 3].map((n) => [n, { status: 502, body: "bad gateway" }]));
    const { result } = await run(broken, { types: ["hr"], countOnly: true });
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_list_failed" });
    expect(result.stop!.detail).toContain("hr at offset 0 failed 3 times");
    expect(broken.gov.calls).toHaveLength(3);
  });

  it("--count-only asks no detail, writes no file and counts the same-date rows", async () => {
    const world = seedStandard();
    const { result, text } = await run(world, { types: ["hr", "s"], countOnly: true });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done", file: null, requests: 2 });
    expect(detailCalls(world)).toEqual([]);
    expect(world.fileWrites).toEqual([]);
    expect(result.counts).toMatchObject({ missing: 2, stale: 2, stale_same_day: 1, same_date: 3, fresh: 2, recent: 1 });
    expect(text).toContain("A snapshot asks 3 detail requests for the same-date rows");
    expect(text).toContain("same_date=3");
    expect(text).toContain("Snapshot summary: mode=COUNT-ONLY outcome=done rows=11");
  });

  it("counts titles_differ only for a row whose title is there and differs, as the refetch sends it", async () => {
    store("BILLS-119hr600", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "Stored title");
    store("BILLS-119hr601", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "Stored title");
    store("BILLS-119hr602", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "Stored title");
    const world = newWorld({
      lists: {
        hr: [
          row("hr", 600, "2026-10-01", { title: "A short title" }),
          row("hr", 601, "2026-10-01", { title: "" }),
          row("hr", 602, "2026-10-01", { title: " Stored title " }),
        ],
      },
    });
    const { result, text } = await run(world, { types: ["hr"], countOnly: true });
    expect(result.counts).toMatchObject({ stale: 3 });
    expect(text).toContain("titles_differ=1");
  });

  it("counts a stored title in GovInfo's form apart (titles_govinfo), and compares with the title the hash reads", async () => {
    // GovInfo's form, kept by the refetch: not a title change.
    store("BILLS-119hr603", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "H.R.&nbsp;603&nbsp;(IH) - Stored title");
    store("BILLS-119s604", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "S.&nbsp;604&nbsp;(IS) - Another title");
    // No stored metadata title: the text hash reads the content's title, which the row has.
    mockS3.put("raw-bills/BILLS-119hr605.json", {
      schemaVersion: 1,
      kind: "raw",
      storedAt: "2026-10-01T00:00:00.000Z",
      metadata: { guid: "BILLS-119hr605", title: "", fetchedAt: "2026-10-01T00:00:00.000Z" },
      content: { bill: { bill: { updateDate: "2026-09-01T00:00:00Z", title: "Content title" } } },
    });
    // congress.gov retitled it.
    store("BILLS-119hr606", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "Stored title");
    const world = newWorld({
      lists: {
        hr: [
          row("hr", 603, "2026-10-01", { title: "Stored title" }),
          row("hr", 605, "2026-10-01", { title: "Content title" }),
          row("hr", 606, "2026-10-01", { title: "A new title" }),
        ],
        s: [row("s", 604, "2026-10-01", { title: "AT Act" })],
      },
    });
    const { result, text } = await run(world, { types: ["hr", "s"], countOnly: true });
    expect(result.counts).toMatchObject({ stale: 4 });
    expect(result.rows.map((entry) => [entry.guid, entry.titleChange])).toEqual([
      ["BILLS-119hr603", "govinfo"],
      ["BILLS-119hr605", "same"],
      ["BILLS-119hr606", "differs"],
      ["BILLS-119s604", "govinfo"],
    ]);
    expect(text).toContain("titles_differ=1 titles_govinfo=2");
  });

  it("--demo-key sends DEMO_KEY and stops after 5 requests", async () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => row("hr", 30_000 - index, "2026-10-01"));
    const world = newWorld({ lists: { hr: rows } });
    const { result, text } = await run(world, parseArgs(["--demo-key", "--types", "hr", "--count-only"]), {}, {});
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_max_requests", requests: 5 });
    expect(world.gov.calls).toHaveLength(5);
    expect(world.gov.calls.every((call) => call.headers["X-Api-Key"] === DEMO_KEY)).toBe(true);
    expect(text).toContain("key=the public DEMO_KEY (--demo-key)");
  });

  it("calls a bill updated since the fixed poller relisted every type recent, whatever --recent-hours says", async () => {
    store("BILLS-119hr1", "2026-01-01T00:00:00Z");
    store("BILLS-119hr2", "2026-01-01T00:00:00Z");
    const world = newWorld(
      { lists: { hr: [row("hr", 1, "2026-11-07"), row("hr", 2, "2026-11-06")] } },
      { t: Date.parse("2026-11-09T06:00:00.000Z") },
    );
    // 72 hours before the start is 11-06T06:00Z, before the fixed poller's relisting: the cut is the relisting.
    const { result, text } = await run(world, { types: ["hr"], countOnly: true, recentHours: 72 });
    expect(text).toContain(`recentFrom=${POLLER_RELISTED_FROM}`);
    // 11-07 is wholly after 11-06T23:58Z: the poller enqueued it. 11-06 is not.
    expect(result.counts).toMatchObject({ recent: 1, stale: 1 });
  });

  it("decides recent by the row's updateDate, so a text-only change the poller never listed is still compared", async () => {
    // Review probe: an update on 11-05 at 15:00Z skipped before REL-56 (stored copy 08:00Z), then text on 11-11, within
    // the recent hours before top. The list's filter goes by updateDate (11-05), so the poller never listed the row.
    store("BILLS-119hr9000", "2026-11-05T08:00:00Z");
    // The same, with the text fetched since: compared, and fresh.
    store("BILLS-119hr9001", "2026-11-05T15:00:00Z", "2026-11-11T09:00:00Z");
    const world = newWorld({
      lists: {
        hr: [
          row("hr", 9000, "2026-11-05", { updateDateIncludingText: "2026-11-11T09:00:00Z" }),
          row("hr", 9001, "2026-11-05", { updateDateIncludingText: "2026-11-11T09:00:00Z" }),
        ],
      },
    });
    const { result } = await run(world, { types: ["hr"] });
    expect(result.counts).toMatchObject({ recent: 0, stale: 1, fresh: 1 });
    expect(result.rows.map((entry) => [entry.guid, entry.cls, entry.rowTime?.text])).toEqual([
      ["BILLS-119hr9000", "stale", "2026-11-11T09:00:00.000Z"],
    ]);
    expect(detailCalls(world)).toEqual([]);
  });
});

// ─── The preflight ────────────────────────────────────────────────────────────

describe("the poller rule during the run", () => {
  const fakeClient = () =>
    new CongressClient({
      key: KEY,
      httpGet: async () => ({ status: 200, body: JSON.stringify({ bills: [], pagination: { count: 0 } }) }),
      perHour: 4000,
      maxRequests: null,
      now: () => new Date(START),
      sleep: async () => undefined,
      scrub: (line) => line,
    });

  it("checks every `every` requests, with force after any request, and once for callers waiting at the same time", async () => {
    const client = fakeClient();
    const states: string[] = [];
    const awsCli = jest.fn(async (args: readonly string[]) => {
      states.push(args[3]);
      return JSON.stringify("ENABLED");
    });
    const watch = new RuleWatch({ client, awsCli, ruleNames: ["RuleA", "RuleB"], every: 3 });
    await watch.due(true); // no request since the preflight
    expect(watch.checks).toBe(0);
    await client.get("bill/119/hr");
    await watch.due(); // 1 of 3
    expect(watch.checks).toBe(0);
    await watch.due(true);
    expect(watch.checks).toBe(1);
    expect(states).toEqual(["RuleA", "RuleB"]);
    for (let index = 0; index < 3; index += 1) await client.get("bill/119/hr");
    await Promise.all([watch.due(), watch.due(), watch.due()]);
    expect(watch.checks).toBe(2);

    // One rule DISABLED: the stop names it, and the client sends nothing more.
    awsCli.mockImplementation(async (args: readonly string[]) =>
      JSON.stringify(args[3] === "RuleB" ? "DISABLED" : "ENABLED"),
    );
    for (let index = 0; index < 3; index += 1) await client.get("bill/119/hr");
    const stop = await watch.due().catch((error: unknown) => error);
    expect(stop).toBeInstanceOf(StopError);
    expect(stop).toMatchObject({ reason: "window_open" });
    expect((stop as Error).message).toMatch(/^RuleB DISABLED: a quiet window opened during the run/);
    await expect(client.get("bill/119/hr")).rejects.toMatchObject({ reason: "window_open" });
    expect(client.requests).toBe(7);
  });

  it("runs the check before each list request, a page tried again included", async () => {
    const client = fakeClient();
    const due = jest.fn(async () => undefined);
    const listed = await listType(
      client,
      "119",
      "hr",
      { from: DEFAULT_CUTOFF, to: TOP },
      { log: () => undefined, sleep: async () => undefined, due },
    );
    expect(listed.pages).toBe(1);
    expect(due).toHaveBeenCalledTimes(1);

    // A list page that fails is tried again: each try is a request, and each is checked.
    let calls = 0;
    const flaky = new CongressClient({
      key: KEY,
      httpGet: async () =>
        (calls += 1) === 1
          ? { status: 503, body: "busy" }
          : { status: 200, body: JSON.stringify({ bills: [], pagination: { count: 0 } }) },
      perHour: 4000,
      maxRequests: null,
      now: () => new Date(START),
      sleep: async () => undefined,
      scrub: (line) => line,
    });
    const checked = jest.fn(async () => undefined);
    await listType(
      flaky,
      "119",
      "hr",
      { from: DEFAULT_CUTOFF, to: TOP },
      {
        log: () => undefined,
        sleep: async () => undefined,
        due: checked,
      },
    );
    expect(checked).toHaveBeenCalledTimes(2);
  });
});

describe("the preflight", () => {
  it.each<[string, Partial<World>, string]>([
    [
      "the poller rule DISABLED (a quiet window)",
      { ruleState: "DISABLED" },
      "BillsApiPollerSchedule DISABLED: a quiet window is open",
    ],
    [
      "the poller state of another congress",
      { pollerState: POLLER_STATE.replace('"119"', '"120"') },
      "FAIL  the poller state holds it: congress=120",
    ],
    ["the poller state missing", { pollerState: undefined }, "check failed: ParameterNotFound"],
    [
      "the 120th primary",
      { t: Date.parse("2027-01-04T00:00:00.000Z") },
      "primary at 2027-01-04T00:00:00.000Z: the 120th",
    ],
  ])("refuses with exit 2 before any congress.gov request: %s", async (_name, overrides, detail) => {
    const world = { ...seedStandard(), ...overrides };
    const { result, text } = await run(world, { types: ["hr", "s"] });
    expect(result).toMatchObject({ exitCode: 2, outcome: "refused" });
    expect(text).toContain(detail);
    expect(text).toContain("Refused: a preflight check failed; no congress.gov request was made.");
    expect(world.gov.calls).toEqual([]);
    expect(world.fileWrites).toEqual([]);
  });
});
