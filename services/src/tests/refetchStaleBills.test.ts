import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

import { S3Client } from "@aws-sdk/client-s3";
import { parseGuidsFile } from "../../scripts/reconcileProcessedBills";
import {
  AwsChecks,
  BACKFILL_PUSHES_QUERY,
  BACKFILL_RESUMMARIES_QUERY,
  BACKLOG_WAIT_MS,
  CHECK_INTERVAL_MS,
  CHECK_RETRY_WAIT_MS,
  DEFAULT_BATCH_LIMIT,
  ENQUEUED_DIFFS_QUERY,
  LOGS_QUERY_MAX_POLLS,
  LOGS_QUERY_POLL_MS,
  MAX_UNAVAILABLE_RECORD_FAILURES,
  PREDICT_INTERVAL_MS,
  REPEAT_SIGNAL_MS,
  TEXT_RECOVERY_MAX_BILLS,
  UNATTENDED_CHECK_ATTEMPTS,
  UNATTENDED_DEFAULT_LIMIT,
  UNATTENDED_DEFAULT_PER_HOUR,
  UNATTENDED_MAX_PER_HOUR,
  WATCHED_DLQ_NAMES,
  awsCliRunner,
  configFromEnv,
  countBackfillResummaries,
  countSummarizedBills,
  defaultHttpGet,
  effectiveLimit,
  estimateRun,
  installStopSignals,
  isGovInfoTitle,
  legislationUrlFor,
  parseArgs,
  parseProgress,
  progressHeader,
  progressLine,
  billListRowMessage,
  recordFailureStop,
  refetchMessage,
  resummaryLikely,
  runRefetch,
  sendIntervalMs,
  snapshotProgressHeader,
  stopOnMetrics,
  summarizePollerState,
  titleChange,
  weeklyDigestPauseEnd,
  type CliOptions,
  type RunDeps,
  type RunMetrics,
  type StopReason,
  type UpdatedBillMessage,
} from "../../scripts/refetchStaleBills";
import type { HttpTextResponse } from "../handlers/fetchRawBill/billText";
import type { RawBill } from "../models/bill";
import { SOURCE_METADATA_KEYS, sourceTextHash } from "../shared/billSourceReconcile";
import { toBillMessage } from "../shared/billListRow";
import { isRel56BackfillCorrelationId } from "../shared/correlation";
import { formatSnapshot, parseSnapshot, type SnapshotEntry } from "../../scripts/skippedBillSnapshot";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-20T12:00:00.000Z");
const CUTOFF = "2026-04-23T12:00:00.000Z"; // START minus 180 days
const PROGRESS = "/fake/refetch.progress.tsv";
const ACCOUNT_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012";
const POLLER_STATE = JSON.stringify({
  schemaVersion: 1,
  congress: "119",
  lastRunAt: "2026-10-20T11:40:00.000Z",
  cursors: {
    // REL-56: the oldest is the watermark, or lastUpdateAt in a cursor written before it.
    hr: { lastUpdateAt: "2026-10-20T00:00:00.000Z", lastSeenKey: "k", watermark: "2026-10-20T11:30:00.000Z" },
    s: { lastUpdateAt: "2026-10-19T08:00:00.000Z", lastSeenKey: "k", resume: { toDateTime: "x", highKey: "y#z" } },
    hres: {
      lastUpdateAt: "2026-10-19T00:00:00.000Z",
      lastSeenKey: "k",
      watermark: "2026-10-19T09:00:00.000Z",
      backlog: { to: "2026-10-20T11:30:00.000Z", offset: 225, count: 600 },
    },
  },
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const rawBill = (guid: string, fetchedAt: string | null, metadata: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: fetchedAt ?? "2024-01-01T00:00:00.000Z",
  identifier: { congress: "119", billType: "house-bill", billNumber: "1" },
  metadata: {
    guid,
    title: `Title of ${guid}`,
    pubDate: "2025-01-02T00:00:00.000Z",
    category: "Congress API",
    description: "Introduced in House",
    legislationUrl: `https://www.congress.gov/bill/stored/${guid}`,
    ...(fetchedAt ? { fetchedAt } : {}),
    ...metadata,
  },
  content: { bill: { bill: { title: "Content title" } } },
});

const put = (guid: string, fetchedAt: string | null, metadata: Record<string, unknown> = {}) =>
  mockS3.put(`raw-bills/${guid}.json`, rawBill(guid, fetchedAt, metadata));

/** Stale order: BILLS-119hr5 (no fetchedAt), BILLS-118hres4, BILLS-119hr1, BILLS-119s3. */
const seedStandard = () => {
  put("BILLS-119hr1", "2025-01-10T00:00:00.000Z", { guid: "BILLS-119hr1ih" }); // stale; legacy suffixed metadata guid
  put("BILLS-119hr2", "2026-10-01T00:00:00.000Z"); // fresh
  put("BILLS-119s3", "2025-03-01T00:00:00.000Z", { legislationUrl: undefined, category: "", description: undefined });
  put("BILLS-118hres4", "2024-06-01T00:00:00.000Z");
  put("BILLS-119hr5", null); // no fetchedAt: stale, first
  put("BILLS-119hjres6", CUTOFF); // exactly the cutoff: fresh
  mockS3.put("raw-bills/sub/BILLS-119hr7.json", rawBill("BILLS-119hr7", "2024-01-01T00:00:00.000Z")); // not a raw bill key
  mockS3.put("raw-bills/BILLS-119xx8.json", rawBill("BILLS-119xx8", "2024-01-01T00:00:00.000Z")); // unknown bill type
};
const STANDARD_ORDER = ["BILLS-119hr5", "BILLS-118hres4", "BILLS-119hr1", "BILLS-119s3"];

/** n stale bills, BILLS-119hr1001 the oldest. */
const seedMany = (n: number) => {
  for (let index = 0; index < n; index += 1) {
    put(`BILLS-119hr${1001 + index}`, new Date(Date.parse("2025-01-01T00:00:00.000Z") + index * 60_000).toISOString());
  }
};

/** BillDiffer enqueue rows for n distinct raw bills (BILLS-119hr1001 first), one invocation each. */
const diffs = (n: number, from = 1001) =>
  Array.from({ length: n }, (_, index) => ({
    key: `raw-bills/BILLS-119hr${from + index}.json`,
    awsRequestId: `req-${from + index}`,
  }));

// ─── A fake AWS account and clock ─────────────────────────────────────────────

/** Every input field the fake SQS and CloudWatch clients read, across the commands they answer. */
interface FakeCommandInput {
  QueueName?: string;
  QueueUrl?: string;
  AttributeNames?: string[];
  MessageBody?: string;
  MessageAttributes?: Record<string, { StringValue?: string }>;
  MetricDataQueries?: Array<{ Id?: string }>;
  StartTime?: Date;
  EndTime?: Date;
  NextToken?: string;
}

/** What the fakes read from an AWS SDK command: its class's name and its input. */
interface FakeCommand {
  constructor: { name: string };
  input: FakeCommandInput;
}

/** A message the run sent, as UpdatedBillsQueue would hold it. */
type SentBody = UpdatedBillMessage & { textRetryAttempt?: number };

interface World {
  t: number;
  dlq: Record<string, number>;
  /** UpdatedBillsQueue's visible messages, one value per read (the last one repeats). */
  backlog: number[];
  metrics: Partial<RunMetrics>;
  metricsError: string | null;
  /** GetMetricData calls that fail (Throttling) before the next ones answer again. */
  metricsFailuresLeft: number;
  carryMode: string | null;
  /** NotificationType:prod's BACKFILL_PUSH_MODE (REL-56, --unattended). */
  pushMode: string | null;
  esmState: string;
  ruleState: string;
  pollerState: string | undefined;
  cliError: string | null;
  /**
   * BillDiffer's "Diffed raw bill" enqueue rows the Logs Insights query returns (one per bill and invocation). The
   * --unattended query keeps only the rows with a rel56: correlationId and a reason other than no_processed.
   */
  enqueuedDiffs: Array<{ key?: string; awsRequestId?: string; reason?: string; correlationId?: string }>;
  /** UserMatcher's lines with a rel56: correlation id (--unattended's backfill_push_sent check). */
  userMatcherBackfillLines: number;
  /** BillSummarizerQueue's visible messages, one value per read (the last one repeats; --unattended). */
  summarizerBacklog: number[];
  /** Each Logs Insights query started: its log group and query string. */
  logsQueries: Array<{ group: string; query: string }>;
  /** The query's status at each get-query-results (the last one repeats). */
  logsStatuses: string[];
  logsPolls: number;
  logsError: string | null;
  sendFailFor: Set<string>;
  /** Milliseconds each GetMetricData call takes on the fake clock. */
  checkCostMs: number;
  onSend: (sent: number) => void;
  sends: Array<{ at: number; body: SentBody; queueUrl: string; correlationId?: string }>;
  sqsCommands: string[];
  cliCalls: string[][];
  metricInputs: FakeCommandInput[];
  /** When each stop check finished (its GetMetricData call). */
  checkTimes: number[];
  sleeps: number[];
  files: Map<string, string>;
  fileWrites: string[];
}

const newWorld = (overrides: Partial<World> = {}): World => ({
  t: START,
  dlq: {},
  backlog: [0],
  metrics: {},
  metricsError: null,
  metricsFailuresLeft: 0,
  carryMode: "on",
  pushMode: "skip",
  esmState: "Disabled",
  ruleState: "DISABLED",
  pollerState: POLLER_STATE,
  cliError: null,
  enqueuedDiffs: [],
  userMatcherBackfillLines: 0,
  summarizerBacklog: [0],
  logsQueries: [],
  logsStatuses: ["Complete"],
  logsPolls: 0,
  logsError: null,
  sendFailFor: new Set(),
  checkCostMs: 0,
  onSend: () => undefined,
  sends: [],
  sqsCommands: [],
  cliCalls: [],
  metricInputs: [],
  checkTimes: [],
  sleeps: [],
  files: new Map(),
  fileWrites: [],
  ...overrides,
});

const fakes = (world: World) => {
  let backlogReads = 0;
  let summarizerReads = 0;
  const sqs = {
    send: jest.fn(async (command: FakeCommand) => {
      const name = command.constructor.name;
      world.sqsCommands.push(name);
      if (name === "GetQueueUrlCommand") return { QueueUrl: `${ACCOUNT_QUEUE}/${command.input.QueueName}` };
      if (name === "GetQueueAttributesCommand") {
        const queue = String(command.input.QueueUrl).split("/").pop()!;
        if (command.input.AttributeNames?.includes("QueueArn")) {
          return { Attributes: { QueueArn: `arn:aws:sqs:us-east-1:123456789012:${queue}` } };
        }
        if (queue === "UpdatedBillsQueue") {
          const value = world.backlog[Math.min(backlogReads, world.backlog.length - 1)];
          backlogReads += 1;
          return { Attributes: { ApproximateNumberOfMessages: String(value) } };
        }
        if (queue === "BillSummarizerQueue") {
          const value = world.summarizerBacklog[Math.min(summarizerReads, world.summarizerBacklog.length - 1)];
          summarizerReads += 1;
          return { Attributes: { ApproximateNumberOfMessages: String(value) } };
        }
        return {
          Attributes: {
            ApproximateNumberOfMessages: String(world.dlq[queue] ?? 0),
            ApproximateNumberOfMessagesNotVisible: "0",
            ApproximateNumberOfMessagesDelayed: "0",
          },
        };
      }
      if (name === "SendMessageCommand") {
        const body = JSON.parse(command.input.MessageBody ?? "") as SentBody;
        if (world.sendFailFor.has(body.guid)) throw new Error("SQS unavailable");
        world.sends.push({
          at: world.t,
          body,
          queueUrl: String(command.input.QueueUrl),
          correlationId: command.input.MessageAttributes?.correlationId?.StringValue,
        });
        world.onSend(world.sends.length);
        return { MessageId: `m${world.sends.length}` };
      }
      throw new Error(`unexpected SQS command ${name}`);
    }),
  };
  const cloudwatch = {
    send: jest.fn(async (command: FakeCommand) => {
      world.metricInputs.push(command.input);
      world.t += world.checkCostMs;
      world.checkTimes.push(world.t);
      if (world.metricsError) throw new Error(world.metricsError);
      if (world.metricsFailuresLeft > 0) {
        world.metricsFailuresLeft -= 1;
        throw new Error("Throttling");
      }
      return {
        MetricDataResults: (command.input.MetricDataQueries ?? []).map((query) => ({
          Id: query.Id,
          Values: [world.metrics[query.Id as keyof RunMetrics] ?? 0],
        })),
      };
    }),
  };
  const ssm = {
    send: jest.fn(async () => {
      if (world.pollerState === undefined) {
        throw Object.assign(new Error("ParameterNotFound"), { name: "ParameterNotFound" });
      }
      return { Parameter: { Value: world.pollerState } };
    }),
  };
  const awsCli = jest.fn(async (args: readonly string[]) => {
    world.cliCalls.push([...args]);
    if (world.cliError) throw new Error(world.cliError);
    switch (args[1]) {
      case "get-function-configuration":
        return `${JSON.stringify(args.includes("NotificationType:prod") ? world.pushMode : world.carryMode)}\n`;
      case "list-event-source-mappings":
        return JSON.stringify([{ uuid: "esm-nt", state: world.esmState }]);
      case "get-alias":
        return JSON.stringify("arn:aws:lambda:us-east-1:123456789012:function:BillsApiPoller:prod");
      case "list-rule-names-by-target":
        return JSON.stringify(["BillsApiPollerSchedule"]);
      case "describe-rule":
        return JSON.stringify(world.ruleState);
      case "start-query":
        if (world.logsError) throw new Error(world.logsError);
        world.logsQueries.push({
          group: args[args.indexOf("--log-group-name") + 1],
          query: args[args.indexOf("--query-string") + 1],
        });
        return `${JSON.stringify(`query-${world.logsQueries.length}`)}\n`;
      case "get-query-results": {
        const status = world.logsStatuses[Math.min(world.logsPolls, world.logsStatuses.length - 1)];
        world.logsPolls += 1;
        const started = world.logsQueries[Number(args[args.indexOf("--query-id") + 1].split("-")[1]) - 1];
        const backfillOnly = started?.query.includes("rel56:");
        const rows =
          started?.group === "/aws/lambda/UserMatcher"
            ? world.userMatcherBackfillLines > 0
              ? [[{ field: "lines", value: String(world.userMatcherBackfillLines) }]]
              : []
            : world.enqueuedDiffs
                .filter(
                  (diff) =>
                    !backfillOnly ||
                    (Boolean(diff.correlationId?.startsWith("rel56:")) && diff.reason !== "no_processed"),
                )
                .map((diff) => [
                  ...(diff.key === undefined ? [] : [{ field: "key", value: diff.key }]),
                  ...(diff.awsRequestId === undefined ? [] : [{ field: "awsRequestId", value: diff.awsRequestId }]),
                  ...(diff.reason === undefined ? [] : [{ field: "reason", value: diff.reason }]),
                  { field: "lines", value: "1" },
                ]);
        const results = status === "Complete" ? rows : [];
        return JSON.stringify({ status, results, statistics: { recordsMatched: results.length } });
      }
      default:
        throw new Error(`unexpected aws ${args.join(" ")}`);
    }
  });
  return {
    sqs: sqs as unknown as RunDeps["sqs"],
    cloudwatch: cloudwatch as unknown as RunDeps["cloudwatch"],
    ssm: ssm as unknown as RunDeps["ssm"],
    awsCli,
  };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  ...parseArgs([]),
  progressFile: PROGRESS,
  ...overrides,
});

const run = async (world: World, cli: Partial<CliOptions> = {}, extra: Partial<RunDeps> = {}) => {
  const lines: string[] = [];
  const errors: string[] = [];
  const result = await runRefetch({
    ...extra,
    s3: new S3Client({}),
    ...fakes(world),
    config: configFromEnv({}),
    options: options(cli),
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    logError: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    now: () => new Date(world.t),
    sleep: async (ms: number) => {
      world.sleeps.push(ms);
      world.t += ms;
    },
    readFile: (path: string) => world.files.get(path) ?? null,
    writeFile: (path: string, text: string) => {
      world.fileWrites.push(path);
      world.files.set(path, text);
    },
    appendFile: (path: string, text: string) => {
      world.fileWrites.push(path);
      world.files.set(path, (world.files.get(path) ?? "") + text);
    },
  });
  return { result, lines, errors, text: lines.join("\n") };
};

const progressGuids = (world: World): string[] => parseGuidsFile(world.files.get(PROGRESS) ?? "");
const s3Commands = () => mockS3.calls.map((call) => call.__cmd);
const READ_ONLY_CLI = new Set([
  "get-function-configuration",
  "list-event-source-mappings",
  "get-alias",
  "list-rule-names-by-target",
  "describe-rule",
  "start-query",
  "get-query-results",
]);

beforeEach(() => {
  mockS3 = new FakeVersionedS3();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

// ─── Arguments, configuration and the message ─────────────────────────────────

describe("arguments, configuration and the message", () => {
  it("defaults to a dry run with the addendum's defaults", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      apply: false,
      olderThanDays: 180,
      perHour: 500,
      limit: null,
      guids: [],
      guidsFile: null,
      congress: null,
      progressFile: "refetch-stale-bills.progress.tsv",
      windowMinutes: 100,
      maxBacklog: 20,
      maxSummaries: 50,
      concurrency: 8,
      textRecovery: false,
      predict: false,
      snapshotFile: null,
    });
    expect(effectiveLimit({ limit: null })).toBe(DEFAULT_BATCH_LIMIT);
    expect(DEFAULT_BATCH_LIMIT).toBe(800);
    expect(effectiveLimit({ limit: 3 })).toBe(3);
    expect(sendIntervalMs(500)).toBe(7_200);
    expect(sendIntervalMs(600)).toBe(6_000);
  });

  it("parses every flag and refuses bad values and unknown flags", () => {
    expect(
      parseArgs([
        "--apply",
        "--older-than-days",
        "200",
        "--per-hour",
        "300",
        "--limit",
        "5",
        "--guid",
        "BILLS-119hr1400ih",
        "--guid",
        "BILLS-119hr1400",
        "--guids-file",
        "list.txt",
        "--congress",
        "119",
        "--progress-file",
        "p.tsv",
        "--window-minutes",
        "90",
        "--max-backlog",
        "10",
        "--max-summaries",
        "0",
        "--concurrency",
        "4",
      ]),
    ).toEqual({
      help: false,
      apply: true,
      olderThanDays: 200,
      perHour: 300,
      limit: 5,
      guids: ["BILLS-119hr1400"],
      guidsFile: "list.txt",
      congress: "119",
      progressFile: "p.tsv",
      windowMinutes: 90,
      maxBacklog: 10,
      maxSummaries: 0,
      concurrency: 4,
      textRecovery: false,
      predict: false,
      snapshotFile: null,
    });
    expect(parseArgs(["--text-recovery", "--guids-file", "l.txt", "--predict"])).toMatchObject({
      textRecovery: true,
      predict: true,
      guidsFile: "l.txt",
    });
    expect(() => parseArgs(["--text-recovery"])).toThrow("--text-recovery needs --guids-file or --guid");
    expect(() => parseArgs(["--predict", "--guid", "BILLS-119hr1"])).toThrow("--predict needs --text-recovery");
    expect(() => parseArgs(["--text-recovery", "--guid", "BILLS-119hr1", "--predict", "--apply"])).toThrow(
      "--predict is a dry run only",
    );
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(() => parseArgs(["--per-hour", "601"])).toThrow("--per-hour needs a whole number from 1 to 600");
    expect(() => parseArgs(["--per-hour", "1.5"])).toThrow("--per-hour");
    expect(() => parseArgs(["--window-minutes", "111"])).toThrow("from 1 to 110");
    expect(() => parseArgs(["--older-than-days", "0"])).toThrow("--older-than-days");
    expect(() => parseArgs(["--limit"])).toThrow("--limit needs a whole number");
    expect(() => parseArgs(["--guid", "hr1400"])).toThrow("--guid needs a bill guid");
    expect(() => parseArgs(["--congress", "one"])).toThrow("--congress needs a congress number");
    expect(() => parseArgs(["--progress-file", "--apply"])).toThrow("--progress-file needs a value");
    expect(() => parseArgs(["--force"])).toThrow("Unknown argument: --force");
  });

  it("reads its configuration from the environment", () => {
    expect(configFromEnv({})).toEqual({
      region: "us-east-1",
      bucket: "billboard-bill-store-bucket",
      rawPrefix: "raw-bills/",
      updatedBillsQueueUrl: "",
      updatedBillsQueueName: "UpdatedBillsQueue",
      notificationTypeQueueName: "NotificationTypeQueue",
      fetchRawBillFunction: "FetchRawBill",
      pollerFunction: "BillsApiPoller",
      lambdaAlias: "prod",
      pollerStateParameter: "/billboard/congress/bills-poller-state",
      dlqNames: WATCHED_DLQ_NAMES,
      billDifferLogGroup: "/aws/lambda/BillDiffer",
      notificationTypeFunction: "NotificationType",
      billSummarizerQueueName: "BillSummarizerQueue",
      userMatcherLogGroup: "/aws/lambda/UserMatcher",
    });
    expect(WATCHED_DLQ_NAMES).toEqual([
      "UpdatedBillsDLQ",
      "BillDifferDLQ",
      "BillVoteEnrichmentDLQ",
      "BillSummarizerDLQ",
      "UpdatedCongressMembersDLQ",
      "CongressMemberSummarizerDLQ",
      "BillsManifestDLQ",
    ]);
    expect(
      configFromEnv({ AWS_REGION: "eu-west-1", BUCKET_NAME: "b", UPDATED_BILLS_QUEUE_URL: "https://q" }),
    ).toMatchObject({ region: "eu-west-1", bucket: "b", updatedBillsQueueUrl: "https://q" });
  });

  it("builds the poller's message from the stored metadata, under the plain key guid, with noTextRetry", () => {
    const stored = rawBill("BILLS-119hr1ih", "2025-01-10T00:00:00.000Z") as unknown as RawBill;
    expect(refetchMessage("BILLS-119hr1", stored)).toEqual({
      message: {
        guid: "BILLS-119hr1",
        title: "Title of BILLS-119hr1ih",
        link: "https://www.congress.gov/bill/stored/BILLS-119hr1ih",
        legislationUrl: "https://www.congress.gov/bill/stored/BILLS-119hr1ih",
        pubDate: "2025-01-02T00:00:00.000Z",
        category: "Congress API",
        description: "Introduced in House",
        congress: "119",
        billType: "hr",
        billNumber: "1",
        // REL-45: FetchRawBill sends no delayed text retry that could land after the quiet window closed.
        noTextRetry: true,
      },
    });
    // No stored URL, category or description: the poller's URL, and the optional fields left out.
    const bare = {
      metadata: { guid: "BILLS-121sconres12", fetchedAt: "2025-01-01T00:00:00.000Z" },
    } as unknown as RawBill;
    expect(refetchMessage("BILLS-121sconres12", bare).message).toEqual({
      guid: "BILLS-121sconres12",
      title: "",
      link: "https://www.congress.gov/bill/121st-congress/senate-concurrent-resolution/12",
      legislationUrl: "https://www.congress.gov/bill/121st-congress/senate-concurrent-resolution/12",
      pubDate: "",
      congress: "121",
      billType: "sconres",
      billNumber: "12",
      noTextRetry: true,
    });
    expect(refetchMessage("BILLS-119xx8", stored).problem).toBe("not a plain bill guid of a known bill type");
    expect(refetchMessage("BILLS-119hr1ih", stored).problem).toBe("not a plain bill guid of a known bill type");
    expect(refetchMessage("BILLS-119hr1", { content: {} } as unknown as RawBill).problem).toBe("no metadata");
  });

  it("builds legislation URLs with the poller's ordinals", () => {
    const url = (congress: string) => legislationUrlFor({ congress, billType: "hr", billNumber: "9" });
    expect(url("119")).toBe("https://www.congress.gov/bill/119th-congress/house-bill/9");
    expect(url("111")).toContain("/111th-congress/");
    expect(url("112")).toContain("/112th-congress/");
    expect(url("122")).toContain("/122nd-congress/");
    expect(url("103")).toContain("/103rd-congress/");
  });
});

// ─── Progress file, estimate and poller state ─────────────────────────────────

describe("progress file, estimate and poller state", () => {
  it("round-trips the header and lines, and reconcile:processed-bills reads the same guids", () => {
    const text =
      progressHeader(CUTOFF, 180) +
      progressLine("BILLS-119hr1", "2026-10-20T12:00:00.000Z", "2026-10-20T11:58:00.000Z") +
      progressLine("BILLS-119s3", "2026-10-20T12:00:07.200Z", "2026-10-20T11:58:00.000Z");
    const progress = parseProgress(text);
    expect(progress).toEqual({ cutoff: CUTOFF, olderThanDays: 180, sent: new Set(["BILLS-119hr1", "BILLS-119s3"]) });
    expect(parseGuidsFile(text)).toEqual(["BILLS-119hr1", "BILLS-119s3"]);
    expect(parseProgress("BILLS-119hr1\tx\ty\n")).toEqual({
      cutoff: null,
      olderThanDays: null,
      sent: new Set(["BILLS-119hr1"]),
    });
    expect(() => parseProgress("# cutoff=yesterday olderThanDays=180\n")).toThrow("cutoff is not a time");
    expect(() => parseProgress("not-a-guid\tx\n")).toThrow("Line 1");
  });

  it("estimates calls, hours and windows", () => {
    expect(estimateRun(4100, options())).toEqual({
      bills: 4100,
      calls: 32_800,
      callsPerHour: 4_000,
      hours: 8.2,
      batchPerWindow: 800,
      windows: 6,
    });
    // At 300 an hour a 100-minute window holds 500 bills, fewer than the 800 batch.
    expect(estimateRun(1000, options({ perHour: 300 }))).toMatchObject({ batchPerWindow: 500, windows: 2, hours: 3.3 });
    expect(estimateRun(0, options())).toMatchObject({ calls: 0, windows: 0 });
  });

  it("summarizes the poller state, and calls a missing or foreign one unknown", () => {
    expect(summarizePollerState(POLLER_STATE, new Date(START))).toEqual({
      known: true,
      congress: "119",
      detail:
        "congress=119 lastRunAt=2026-10-20T11:40:00.000Z (20 min ago) cursors=3 " +
        "oldestCursor=2026-10-19T08:00:00.000Z pendingBacklog=s,hres",
    });
    expect(summarizePollerState(undefined, new Date(START)).known).toBe(false);
    expect(summarizePollerState("UNINITIALIZED", new Date(START))).toMatchObject({ known: false });
    expect(summarizePollerState('{"schemaVersion":2}', new Date(START))).toEqual({
      known: false,
      detail: "the parameter is not a version 1 poller state",
    });
  });
});

// ─── Dry run ──────────────────────────────────────────────────────────────────

describe("dry run (the default)", () => {
  it("selects bills fetched before the cutoff, oldest first, prints the report and writes nothing", async () => {
    seedStandard();
    const world = newWorld({ esmState: "Enabled", ruleState: "ENABLED" }); // outside a window
    const { result, text } = await run(world);

    expect(result).toMatchObject({ exitCode: 0, outcome: "dry_run", cutoff: CUTOFF, alreadySent: 0, eligible: 4 });
    expect(result.scan!.stale.map((bill) => bill.guid)).toEqual(STANDARD_ORDER);
    expect(result.scan!.stale[0].fetchedAt).toBeNull();
    expect(result.scan!.fresh).toBe(2);
    expect(result.scan!.unsendable).toEqual([
      { key: "raw-bills/BILLS-119xx8.json", reason: "not a plain bill guid of a known bill type" },
    ]);
    expect(text).toContain("congress 118: hres=1 total=1");
    expect(text).toContain("congress 119: hr=2 s=1 total=3");
    expect(text).toContain("oldest fetch: 2024-06-01T00:00:00.000Z (BILLS-118hres4)");
    expect(text).toContain("FAIL  quiet window open (RUNBOOK 4.1)");
    expect(text).toContain("ok    member vote carry on (X7): FetchRawBill:prod MEMBER_VOTE_CARRY_MODE=on");
    expect(text).toContain("pendingBacklog=s,hres");
    expect(text).toContain("estimate: 32 Congress.gov calls (8 a bill), 0 hours");
    expect(text).toContain(
      "Refetch plan: stale=4 no_fetched_at=1 fresh=2 already_sent=0 to_send=4 unsendable=1 unreadable=0 missing=0 " +
        "calls=32 hours=0 windows=1",
    );

    // Writes nothing: no S3 put, no SQS send, no file, and only read-only AWS CLI calls.
    expect(s3Commands().every((cmd) => cmd === "ListObjectsV2" || cmd === "GetObject")).toBe(true);
    expect(world.sends).toEqual([]);
    expect(world.sqsCommands.every((cmd) => cmd === "GetQueueUrlCommand" || cmd === "GetQueueAttributesCommand")).toBe(
      true,
    );
    expect(world.fileWrites).toEqual([]);
    expect(world.cliCalls.length).toBeGreaterThan(0);
    expect(world.cliCalls.every((args) => READ_ONLY_CLI.has(args[1]))).toBe(true);
    expect(world.sleeps).toEqual([]);
  });

  it("uses the progress file's cutoff and skips the bills it lists", async () => {
    seedStandard();
    const world = newWorld();
    // Pinned at 2025-02-01: BILLS-119s3 (fetched 2025-03-01) is fresh under it.
    world.files.set(PROGRESS, progressHeader("2025-02-01T00:00:00.000Z", 180) + progressLine("BILLS-119hr5", "t", "t"));
    const { result, text } = await run(world);
    expect(result.cutoff).toBe("2025-02-01T00:00:00.000Z");
    expect(result.scan!.stale.map((bill) => bill.guid)).toEqual(["BILLS-119hr5", "BILLS-118hres4", "BILLS-119hr1"]);
    expect(result).toMatchObject({ alreadySent: 1, eligible: 2 });
    expect(text).toContain("cutoff=2025-02-01T00:00:00.000Z (from the progress file)");
    // Sent in an earlier window and still stale: in flight, or FetchRawBill failed it.
    expect(text).toContain("to send: 2; already sent (progress file) and still stale: 1");
    expect(text).toContain("  sent but still stale: BILLS-119hr5");
    expect(world.fileWrites).toEqual([]);
  });

  it("lists at most 50 bills sent earlier that are still stale", async () => {
    seedMany(53);
    const world = newWorld();
    const lines = Array.from({ length: 53 }, (_, index) => progressLine(`BILLS-119hr${1001 + index}`, "t", "t"));
    world.files.set(PROGRESS, progressHeader(CUTOFF, 180) + lines.join(""));
    const { result, text } = await run(world);
    expect(result).toMatchObject({ alreadySent: 53, eligible: 0 });
    expect(text).toContain("BILLS-119hr1050 and 3 more");
    expect(text).not.toContain("BILLS-119hr1051");
    expect(text).toContain("Dry run: --apply would send 0 bills now.");
  });

  it("refuses a progress file started with another --older-than-days", async () => {
    seedStandard();
    const world = newWorld();
    world.files.set(PROGRESS, progressHeader(CUTOFF, 180));
    await expect(run(world, { olderThanDays: 90 })).rejects.toThrow("was started with --older-than-days 180");
  });

  it("narrows to --guid, --guids-file and --congress, and never widens a list", async () => {
    seedStandard();
    const listed = await run(newWorld(), { guids: ["BILLS-119hr1", "BILLS-119hr2", "BILLS-119hr99"] });
    expect(listed.result.scan!.stale.map((bill) => bill.guid)).toEqual(["BILLS-119hr1"]);
    expect(listed.result.scan!.fresh).toBe(1);
    expect(listed.result.scan!.missing).toEqual(["BILLS-119hr99"]);
    expect(listed.text).toContain("missing (1): BILLS-119hr99");

    const world = newWorld();
    world.files.set("list.txt", "# guids\nBILLS-119s3\tx\nBILLS-118hres4\n");
    const fromFile = await run(world, { guidsFile: "list.txt" });
    expect(fromFile.result.scan!.stale.map((bill) => bill.guid)).toEqual(["BILLS-118hres4", "BILLS-119s3"]);

    world.files.set("empty.txt", "# nothing\n");
    await expect(run(world, { guidsFile: "empty.txt" })).rejects.toThrow("lists no bills");
    await expect(run(world, { guidsFile: "absent.txt" })).rejects.toThrow("does not exist");

    const congress = await run(newWorld(), { congress: "118" });
    expect(congress.result.scan!.stale.map((bill) => bill.guid)).toEqual(["BILLS-118hres4"]);
    expect(congress.result.scan!.fresh).toBe(0);
  });

  it("exits 1 and lists a raw bill it cannot read", async () => {
    seedStandard();
    mockS3.put("raw-bills/BILLS-119hr9.json", "not json");
    const { result, text } = await run(newWorld());
    expect(result.exitCode).toBe(1);
    expect(result.scan!.unreadable).toEqual([{ key: "raw-bills/BILLS-119hr9.json", error: expect.any(String) }]);
    expect(text).toContain("unreadable (1): raw-bills/BILLS-119hr9.json");
  });
});

// ─── Apply ────────────────────────────────────────────────────────────────────

describe("--apply", () => {
  it("sends the poller's message for each stale bill, oldest first, paced, and records each send", async () => {
    seedStandard();
    const world = newWorld();
    const { result, text } = await run(world, { apply: true });

    expect(result).toMatchObject({ exitCode: 0, outcome: "done", sentGuids: STANDARD_ORDER, stop: null });
    expect(world.sends.map((send) => send.body.guid)).toEqual(STANDARD_ORDER);
    expect(world.sends.every((send) => send.queueUrl === `${ACCOUNT_QUEUE}/UpdatedBillsQueue`)).toBe(true);
    expect(world.sends[2]).toMatchObject({
      correlationId: "refetch:2026-10-20T12:00:00.000Z:BILLS-119hr1",
      body: {
        guid: "BILLS-119hr1", // the plain key guid, not the stored suffixed one
        title: "Title of BILLS-119hr1",
        link: "https://www.congress.gov/bill/stored/BILLS-119hr1",
        pubDate: "2025-01-02T00:00:00.000Z",
        congress: "119",
        billType: "hr",
        billNumber: "1",
        noTextRetry: true,
      },
    });
    expect(Object.keys(world.sends[3].body).sort()).toEqual(
      [
        "billNumber",
        "billType",
        "congress",
        "guid",
        "legislationUrl",
        "link",
        "noTextRetry",
        "pubDate",
        "title",
      ].sort(),
    );
    // 500 an hour: one send every 7.2 seconds.
    const gaps = world.sends.slice(1).map((send, index) => send.at - world.sends[index].at);
    expect(gaps).toEqual([7_200, 7_200, 7_200]);

    const progress = world.files.get(PROGRESS)!;
    expect(progress.startsWith(progressHeader(CUTOFF, 180))).toBe(true);
    expect(progressGuids(world)).toEqual(STANDARD_ORDER);
    expect(progress).toContain("BILLS-119hr5\t2026-10-20T12:00:00.000Z\t2026-10-20T12:00:00.000Z\n");
    expect(text).toContain(
      "Refetch summary: mode=APPLY outcome=done selected=4 already_sent=0 eligible=4 sent=4 remaining=0 " +
        "unsendable=1 unreadable=0 missing=0",
    );
    expect(text).toContain(`--guids-file ${PROGRESS}`);
    // A queue has drained only when its delayed messages are 0 too (RUNBOOK 4.1).
    expect(text).toContain(
      "ApproximateNumberOfMessages, ApproximateNumberOfMessagesNotVisible and ApproximateNumberOfMessagesDelayed all 0",
    );
    // The only writes are the sends; every other AWS call reads.
    expect(s3Commands().every((cmd) => cmd === "ListObjectsV2" || cmd === "GetObject")).toBe(true);
    expect(world.cliCalls.every((args) => READ_ONLY_CLI.has(args[1]))).toBe(true);
  });

  it("keeps the rate when checks take time, and sends only within a minute of a passing check", async () => {
    seedMany(25);
    const world = newWorld({ checkCostMs: 2_000 });
    const { result } = await run(world, { apply: true, perHour: 600 });
    expect(result.outcome).toBe("done");
    const gaps = world.sends.slice(1).map((send, index) => send.at - world.sends[index].at);
    expect(gaps.every((gap) => gap === 6_000)).toBe(true);
    expect(world.sends[0].at).toBe(START + 2_000);
    // Checks (finish times) before sends 1, 11 and 21, each the first send 60 s or more after the last check, then
    // one after the last send (at 146 s).
    expect(world.checkTimes.map((at) => at - START)).toEqual([2_000, 58_000, 118_000, 148_000]);
    for (const send of world.sends) {
      const lastCheck = Math.max(...world.checkTimes.filter((at) => at <= send.at));
      expect(send.at - lastCheck).toBeLessThan(CHECK_INTERVAL_MS);
    }
  });

  it("sends at most --limit bills and resumes from the progress file in the next window", async () => {
    seedStandard();
    const world = newWorld();
    const first = await run(world, { apply: true, limit: 2 });
    expect(first.result).toMatchObject({ exitCode: 0, outcome: "batch_limit", sentGuids: STANDARD_ORDER.slice(0, 2) });
    expect(first.text).toContain("This window's batch is sent");

    world.t += 3 * DAY_MS; // the next window, days later: the pinned cutoff keeps the selection the same
    const second = await run(world, { apply: true, limit: 2 });
    expect(second.result).toMatchObject({ outcome: "done", alreadySent: 2, sentGuids: STANDARD_ORDER.slice(2) });
    expect(second.result.cutoff).toBe(CUTOFF);
    expect(progressGuids(world)).toEqual(STANDARD_ORDER);
    expect(world.files.get(PROGRESS)!.match(/# cutoff=/g)).toHaveLength(1);

    const third = await run(world, { apply: true });
    expect(third.result).toMatchObject({ outcome: "done", eligible: 0, sentGuids: [] });
    expect(world.sends).toHaveLength(4);
  });

  it("stops sending when the window's time is used up", async () => {
    seedMany(5);
    const world = newWorld();
    const { result, text } = await run(world, { apply: true, perHour: 100, windowMinutes: 1 });
    // One send every 36 s: at 0 and 36 s; the third would be at 72 s, past the 60-second budget.
    expect(result).toMatchObject({ exitCode: 0, outcome: "window_time" });
    expect(world.sends.map((send) => send.at - START)).toEqual([0, 36_000]);
    expect(progressGuids(world)).toHaveLength(2);
    expect(text).toContain("The window's time is used up");
  });

  it("pauses while UpdatedBillsQueue holds --max-backlog messages, without stopping", async () => {
    seedMany(3);
    const world = newWorld({ backlog: [25, 30, 4] });
    const { result, text } = await run(world, { apply: true });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
    expect(world.sleeps.filter((ms) => ms === BACKLOG_WAIT_MS)).toHaveLength(2);
    expect(world.sends[0].at).toBe(START + 2 * BACKLOG_WAIT_MS);
    expect(text).toContain("UpdatedBillsQueue holds 25 messages; pausing 30 s.");
  });

  it("stops with exit 1 when a send fails, keeping the progress of the bills sent", async () => {
    seedStandard();
    const world = newWorld({ sendFailFor: new Set(["BILLS-119hr1"]) });
    const { result, errors } = await run(world, { apply: true });
    expect(result).toMatchObject({ exitCode: 1, outcome: "send_failed", sentGuids: STANDARD_ORDER.slice(0, 2) });
    expect(progressGuids(world)).toEqual(STANDARD_ORDER.slice(0, 2));
    expect(errors.join("\n")).toContain("Could not send a bill to UpdatedBillsQueue");
  });

  it("exits 1 after sending when a raw bill could not be read", async () => {
    seedStandard();
    mockS3.put("raw-bills/BILLS-119hr9.json", "not json");
    const world = newWorld();
    const { result } = await run(world, { apply: true });
    expect(result).toMatchObject({ exitCode: 1, outcome: "done", sentGuids: STANDARD_ORDER });
  });
});

// ─── Preconditions ────────────────────────────────────────────────────────────

describe("--apply preconditions", () => {
  it.each<[string, Partial<World>, string]>([
    ["member vote carry in watch", { carryMode: "watch" }, "MEMBER_VOTE_CARRY_MODE=watch; flip it to on first (X7)"],
    [
      "no carry variable (the carry is not deployed)",
      { carryMode: null },
      "has no MEMBER_VOTE_CARRY_MODE (the carry is not deployed)",
    ],
    ["NotificationType still consuming", { esmState: "Enabled" }, "NotificationTypeQueue mapping esm-nt Enabled"],
    ["the poller rule still on", { ruleState: "ENABLED" }, "poller rule BillsApiPollerSchedule ENABLED"],
    ["a message in an ingest DLQ", { dlq: { BillSummarizerDLQ: 2 } }, "BillSummarizerDLQ=2"],
    ["the poller state unknown", { pollerState: "UNINITIALIZED" }, "the parameter does not parse"],
    ["the poller state missing", { pollerState: undefined }, "unreadable: ParameterNotFound"],
    ["the AWS CLI failing", { cliError: "aws: command not found" }, "check failed: aws: command not found"],
  ])("refuses with exit 2 before reading or sending anything: %s", async (_name, overrides, detail) => {
    seedStandard();
    const world = newWorld(overrides);
    const { result, text } = await run(world, { apply: true });
    expect(result).toMatchObject({ exitCode: 2, outcome: "refused", scan: null, sentGuids: [] });
    expect(text).toContain(detail);
    expect(text).toContain("Refused: a precondition failed; nothing was sent.");
    expect(world.sends).toEqual([]);
    expect(world.fileWrites).toEqual([]);
    expect(s3Commands()).toEqual([]);
  });
});

// ─── Stop conditions ──────────────────────────────────────────────────────────

describe("stop conditions", () => {
  it.each<[string, (world: World) => void, string, string]>([
    ["a DLQ message", (world) => (world.dlq.BillDifferDLQ = 1), "dlq_message", "BillDifferDLQ=1"],
    ["FetchRawBill errors", (world) => (world.metrics.fetchRawBillErrors = 1), "fetch_errors", "FetchRawBill Errors=1"],
    [
      "a FetchRawBill record failure that is not congress.gov's (REL-58)",
      (world) => (world.metrics.recordFailedOther = 1),
      "fetch_errors",
      "FetchRawBillRecordFailed{Kind=other}=1 since the start",
    ],
    [
      "10 FetchRawBill records failed on congress.gov (REL-58)",
      (world) => (world.metrics.recordFailedUnavailable = 10),
      "fetch_errors",
      "FetchRawBillRecordFailed{Kind=unavailable}=10 since the start (the limit is 10)",
    ],
    ["a Congress.gov 429", (world) => (world.metrics.congressApi429 = 3), "congress_key_errors", "CongressApi429=3"],
    [
      "a bill stored without text (REL-45)",
      (world) => (world.metrics.billTextUnavailable = 1),
      "text_unavailable",
      "BillTextUnavailable=1 since the start",
    ],
    [
      "a Congress.gov key refusal",
      (world) => (world.metrics.congressApiAuthFailures = 1),
      "congress_key_errors",
      "CongressApiAuthFailure=1",
    ],
    [
      "more than 50 summaries the logs do not show yet",
      (world) => (world.metrics.differEnqueued = 51),
      "too_many_summaries",
      '51 bills sent to BillSummarizer since the start (limit 50): 0 in BillDiffer\'s "Diffed raw bill" lines with outcome enqueued plus 51 BillDifferEnqueued not in the logs yet; BillDifferEnqueued=51',
    ],
    [
      "more than 50 distinct bills sent to BillSummarizer",
      (world) => {
        world.metrics.differEnqueued = 52;
        world.enqueuedDiffs = [
          ...diffs(51),
          { key: "raw-bills/BILLS-119hr1001.json", awsRequestId: "second-pass" }, // a second pass: same bill
        ];
      },
      "too_many_summaries",
      '51 bills sent to BillSummarizer since the start (limit 50): 51 in BillDiffer\'s "Diffed raw bill" lines with outcome enqueued; BillDifferEnqueued=52',
    ],
    [
      "a summary count the logs cannot give",
      (world) => {
        world.metrics.differEnqueued = 51;
        world.logsError = "AccessDeniedException: logs:StartQuery";
      },
      "check_failed",
      "AccessDeniedException: logs:StartQuery",
    ],
    ["the window closed", (world) => (world.esmState = "Enabled"), "window_closed", "mapping esm-nt Enabled"],
    ["the poller switched back on", (world) => (world.ruleState = "ENABLED"), "window_closed", "ENABLED"],
    ["a check that cannot run", (world) => (world.metricsError = "Throttling"), "check_failed", "Throttling"],
  ])("stops mid-run with exit 2 on %s", async (_name, breakIt, reason, detail) => {
    seedMany(20);
    const world = newWorld({ onSend: (sent) => sent === 3 && breakIt(world) });
    const { result, errors } = await run(world, { apply: true });
    expect(result).toMatchObject({ exitCode: 2, outcome: `stopped_${reason}`, stop: { reason } });
    expect(result.stop!.detail).toContain(detail);
    // The next check (a minute after the first) stops the run: 3 sent, then up to the check, nothing after it.
    const lastAllowed = Math.floor(CHECK_INTERVAL_MS / 7_200) + 1;
    expect(world.sends.length).toBeGreaterThanOrEqual(3);
    expect(world.sends.length).toBeLessThanOrEqual(lastAllowed);
    expect(world.sends.every((send) => send.at < START + CHECK_INTERVAL_MS)).toBe(true);
    expect(progressGuids(world)).toHaveLength(world.sends.length);
    expect(errors.join("\n")).toContain(`Stopped: ${reason}`);
  });

  // REL-58: on 2026-11-09 two records failed on one congress.gov blip and stored on their next receive; on 2026-11-10
  // the outage passed 10 failures 24 minutes in (14:21 to 14:45Z).
  it("goes on through a congress.gov blip: 9 unavailable record failures since the start", async () => {
    seedMany(3);
    const world = newWorld({ metrics: { recordFailedUnavailable: MAX_UNAVAILABLE_RECORD_FAILURES - 1 } });
    expect((await run(world, { apply: true })).result.outcome).toBe("done");
    expect(world.sends).toHaveLength(3);
  });

  const noMetrics: RunMetrics = {
    fetchRawBillErrors: 0,
    congressApi429: 0,
    congressApiAuthFailures: 0,
    differEnqueued: 0,
    billTextUnavailable: 0,
    recordFailedOther: 0,
    recordFailedUnavailable: 0,
  };

  it.each<[Partial<RunMetrics>, string | null]>([
    [{}, null],
    [{ recordFailedUnavailable: 9 }, null],
    [{ recordFailedOther: 1 }, "FetchRawBillRecordFailed{Kind=other}=1 since the start"],
    [
      { recordFailedUnavailable: 10 },
      "FetchRawBillRecordFailed{Kind=unavailable}=10 since the start (the limit is 10)",
    ],
    [{ recordFailedUnavailable: 12, recordFailedOther: 2 }, "FetchRawBillRecordFailed{Kind=other}=2 since the start"],
  ])("recordFailureStop(%p) is %p", (metrics, detail) => {
    expect(recordFailureStop({ ...noMetrics, ...metrics })).toEqual(
      detail === null ? null : { reason: "fetch_errors", detail },
    );
  });

  it.each<[Partial<RunMetrics>, StopReason | null, string | null]>([
    [{}, null, null],
    // A blip the ladder rides out stops neither mode.
    [{ recordFailedUnavailable: 9 }, null, null],
    [{ fetchRawBillErrors: 1, recordFailedOther: 1 }, "fetch_errors", "FetchRawBill Errors=1 since the start"],
    [{ recordFailedOther: 1, congressApi429: 1 }, "fetch_errors", "FetchRawBillRecordFailed{Kind=other}=1"],
    // A throttled record failure follows a 429, which FetchRawBill counts as CongressApi429: the run stops on the 429
    // (an hour's wait), not on the record failures, however many of them there are below the unavailable limit.
    [{ recordFailedUnavailable: 6, congressApi429: 4 }, "congress_key_errors", "CongressApi429=4"],
    [{ billTextUnavailable: 1 }, "text_unavailable", "BillTextUnavailable=1 since the start (RUNBOOK 4.10)"],
  ])("stopOnMetrics(%p): both modes stop on %p", (metrics, reason, detail) => {
    const stop = stopOnMetrics({ ...noMetrics, ...metrics }, "FetchRawBill");
    if (reason === null) expect(stop).toBeNull();
    else expect(stop).toEqual({ reason, detail: expect.stringContaining(detail!) });
  });

  it("does not stop at exactly --max-summaries, and reads no logs while the passes are within it", async () => {
    seedMany(3);
    const world = newWorld({ metrics: { differEnqueued: 50 } });
    expect((await run(world, { apply: true })).result.outcome).toBe("done");
    expect(world.cliCalls.filter((args) => args[0] === "logs")).toEqual([]);
  });

  it("stops before the first send when a check fails at once", async () => {
    seedMany(3);
    const world = newWorld({ metrics: { fetchRawBillErrors: 2 } });
    const { result } = await run(world, { apply: true });
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_fetch_errors", sentGuids: [] });
    expect(world.sends).toEqual([]);
    // The header still pins the cutoff for the next run.
    expect(parseProgress(world.files.get(PROGRESS)!).cutoff).toBe(CUTOFF);
  });

  it("looks once more after the last send", async () => {
    seedMany(3);
    const world = newWorld({ onSend: (sent) => sent === 3 && (world.dlq.UpdatedBillsDLQ = 1) });
    const { result } = await run(world, { apply: true });
    expect(result).toMatchObject({
      exitCode: 2,
      outcome: "stopped_dlq_message",
      stop: { detail: "UpdatedBillsDLQ=1" },
    });
    expect(world.sends).toHaveLength(3);
  });
});

// ─── The summary cap: bills, not BillDiffer passes ─────────────────────────────

describe("--max-summaries counts bills, not BillDiffer passes", () => {
  const capLine = (lines: string[]) => lines.filter((line) => line.startsWith("BillDifferEnqueued="));

  it("goes on when only second passes put BillDifferEnqueued above the cap (REL-45 batch B, 2026-10-21)", async () => {
    // 11 bills summarized; 6 of them enqueued again after EnrichOfficialVotes rewrote their raw copy: 17 passes.
    seedMany(11);
    const repeats = diffs(6).map((diff) => ({ ...diff, awsRequestId: `${diff.awsRequestId}-second` }));
    const world = newWorld({ metrics: { differEnqueued: 17 }, enqueuedDiffs: [...diffs(11), ...repeats] });
    const { result, lines } = await run(world, { apply: true, maxSummaries: 16 });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done", stop: null });
    expect(world.sends).toHaveLength(11);
    // Said once, although every check (and the last look) read the same counts.
    expect(capLine(lines)).toEqual([
      "BillDifferEnqueued=17 is above --max-summaries 16, but it counts passes: 11 bills were sent to " +
        "BillSummarizer (11 in BillDiffer's logs), within the limit.",
    ]);
    const queries = world.cliCalls.filter((args) => args[1] === "start-query");
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries[0]).toEqual([
      "logs",
      "start-query",
      "--log-group-name",
      "/aws/lambda/BillDiffer",
      "--start-time",
      String(START / 1000),
      "--end-time",
      String(START / 1000),
      "--query-string",
      ENQUEUED_DIFFS_QUERY,
      "--query",
      "queryId",
    ]);
    expect(world.cliCalls.every((args) => READ_ONLY_CLI.has(args[1]))).toBe(true);
  });

  it("counts each pass the logs do not show yet as one more bill", async () => {
    seedMany(5);
    // 20 passes, but the logs show only 12 enqueues (10 bills): 8 unseen, so 18 bills against 16.
    const world = newWorld({
      metrics: { differEnqueued: 20 },
      enqueuedDiffs: [
        ...diffs(10),
        { ...diffs(2)[0], awsRequestId: "again-1" },
        { ...diffs(2)[1], awsRequestId: "again-2" },
      ],
    });
    const { result } = await run(world, { apply: true, maxSummaries: 16 });
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_too_many_summaries", sentGuids: [] });
    expect(result.stop!.detail).toBe(
      '18 bills sent to BillSummarizer since the start (limit 16): 10 in BillDiffer\'s "Diffed raw bill" lines ' +
        "with outcome enqueued plus 8 BillDifferEnqueued not in the logs yet; BillDifferEnqueued=20",
    );
  });

  it("says when the logs show passes not counted yet, and still goes on within the limit", async () => {
    seedMany(3);
    // 17 passes; the logs show 14 enqueues of 12 bills: 12 plus 3 unseen is 15, within 16.
    const repeats = diffs(2).map((diff) => ({ ...diff, awsRequestId: `${diff.awsRequestId}-second` }));
    const world = newWorld({ metrics: { differEnqueued: 17 }, enqueuedDiffs: [...diffs(12), ...repeats] });
    const { result, lines } = await run(world, { apply: true, maxSummaries: 16 });
    expect(result.outcome).toBe("done");
    expect(capLine(lines)).toEqual([
      "BillDifferEnqueued=17 is above --max-summaries 16, but it counts passes: 15 bills were sent to " +
        "BillSummarizer (12 in BillDiffer's logs, 3 passes not in them yet), within the limit.",
    ]);
  });

  it("stops on the last look after the final send when the bills went above the cap", async () => {
    seedMany(3);
    const world = newWorld({
      onSend: (sent) => {
        if (sent !== 3) return;
        world.metrics.differEnqueued = 4;
        world.enqueuedDiffs = diffs(3);
      },
    });
    const { result } = await run(world, { apply: true, maxSummaries: 2 });
    expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_too_many_summaries" });
    expect(result.stop!.detail).toContain("4 bills sent to BillSummarizer since the start (limit 2)");
    expect(world.sends).toHaveLength(3);
  });

  it("waits for the Logs Insights query, and stops the run when it fails or does not complete", async () => {
    seedMany(3);
    const waited = newWorld({
      metrics: { differEnqueued: 3 },
      enqueuedDiffs: [...diffs(2), { ...diffs(1)[0], awsRequestId: "second-pass" }],
      logsStatuses: ["Scheduled", "Running", "Complete"],
    });
    expect((await run(waited, { apply: true, maxSummaries: 2 })).result.outcome).toBe("done");
    expect(waited.sleeps.slice(0, 3)).toEqual([LOGS_QUERY_POLL_MS, LOGS_QUERY_POLL_MS, LOGS_QUERY_POLL_MS]);

    for (const [statuses, detail] of [
      [["Running", "Failed"], "The Logs Insights query on /aws/lambda/BillDiffer ended Failed"],
      [["Running"], `did not complete in ${(LOGS_QUERY_MAX_POLLS * LOGS_QUERY_POLL_MS) / 1000} s`],
    ] as const) {
      mockS3 = new FakeVersionedS3();
      seedMany(3);
      const world = newWorld({ metrics: { differEnqueued: 3 }, logsStatuses: [...statuses] });
      const { result } = await run(world, { apply: true, maxSummaries: 2 });
      expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_check_failed", sentGuids: [] });
      expect(result.stop!.detail).toContain(detail);
    }
  });

  it("counts distinct keys, a row without a key as its own bill, and never fewer bills than unseen passes", () => {
    expect(
      countSummarizedBills(5, [
        { key: "raw-bills/BILLS-119hr1.json", requestId: "a" },
        { key: "raw-bills/BILLS-119hr1.json", requestId: "b" },
        { key: "raw-bills/BILLS-119hr2.json", requestId: "c" },
        { key: null, requestId: "d" },
      ]),
    ).toEqual({ passes: 5, inLogs: 3, unseen: 1, bills: 4 });
    // The logs ahead of the metric: no negative unseen.
    expect(
      countSummarizedBills(
        1,
        [...diffs(3)].map(({ key, awsRequestId }) => ({ key, requestId: awsRequestId })),
      ),
    ).toEqual({ passes: 1, inLogs: 3, unseen: 0, bills: 3 });
    // Nothing in the logs: every pass is a bill, as before.
    expect(countSummarizedBills(17, [])).toEqual({ passes: 17, inLogs: 0, unseen: 17, bills: 17 });
  });

  it("asks for one row per raw bill and invocation of BillDiffer's enqueued lines, since the start's minute", async () => {
    expect(ENQUEUED_DIFFS_QUERY).toBe(
      'filter message = "Diffed raw bill" and outcome = "enqueued"\n' +
        "| stats count(*) as lines by key, awsRequestId, reason\n" +
        "| limit 10000",
    );
    const world = newWorld({ t: START + 5 * 60_000 + 30_500, enqueuedDiffs: [{ key: "raw-bills/BILLS-119hr1.json" }] });
    const checks = new AwsChecks({
      ...fakes(world),
      config: configFromEnv({}),
      now: () => new Date(world.t),
      sleep: async (ms) => void (world.t += ms),
    });
    expect(await checks.enqueuedDiffsSince(new Date(START + 15_000))).toEqual([
      { key: "raw-bills/BILLS-119hr1.json", requestId: null, reason: null },
    ]);
    expect(world.cliCalls[0].slice(4, 8)).toEqual([
      "--start-time",
      String(START / 1000),
      "--end-time",
      String((START + 5 * 60_000 + 31_000) / 1000),
    ]);
    expect(world.cliCalls[1]).toEqual(["logs", "get-query-results", "--query-id", "query-1"]);
  });
});

// ─── The AWS reads ────────────────────────────────────────────────────────────

describe("AWS reads", () => {
  it("sums the watched metrics since the run started, across pages", async () => {
    const world = newWorld({ t: START + 5 * 60_000 + 30_000 });
    const pages = [
      {
        MetricDataResults: [
          { Id: "fetchRawBillErrors", Values: [0, 1] },
          { Id: "differEnqueued", Values: [2, 3] },
        ],
        NextToken: "next",
      },
      {
        MetricDataResults: [
          { Id: "differEnqueued", Values: [4] },
          { Id: "recordFailedUnavailable", Values: [2, 1] },
          { Id: "other", Values: [9] },
        ],
      },
    ];
    const inputs: FakeCommandInput[] = [];
    const cloudwatch = {
      send: jest.fn(async (command: FakeCommand) => (inputs.push(command.input), pages.shift())),
    };
    const checks = new AwsChecks({
      ...fakes(world),
      cloudwatch: cloudwatch as unknown as RunDeps["cloudwatch"],
      config: configFromEnv({}),
      now: () => new Date(world.t),
    });
    expect(await checks.metricsSince(new Date(START + 15_000))).toEqual({
      fetchRawBillErrors: 1,
      congressApi429: 0,
      congressApiAuthFailures: 0,
      differEnqueued: 9,
      billTextUnavailable: 0,
      recordFailedOther: 0,
      recordFailedUnavailable: 3,
    });
    expect(inputs[0].StartTime).toEqual(new Date(START));
    expect(inputs[0].EndTime).toEqual(new Date(START + 7 * 60_000));
    expect(inputs[1].NextToken).toBe("next");
    expect(inputs[0].MetricDataQueries).toEqual([
      {
        Id: "fetchRawBillErrors",
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: "AWS/Lambda",
            MetricName: "Errors",
            Dimensions: [{ Name: "FunctionName", Value: "FetchRawBill" }],
          },
          Period: 60,
          Stat: "Sum",
        },
      },
      expect.objectContaining({
        Id: "congressApi429",
        MetricStat: expect.objectContaining({
          Metric: { Namespace: "BillBoard/BillIngestion", MetricName: "CongressApi429" },
        }),
      }),
      expect.objectContaining({
        Id: "congressApiAuthFailures",
        MetricStat: expect.objectContaining({
          Metric: { Namespace: "BillBoard/BillIngestion", MetricName: "CongressApiAuthFailure" },
        }),
      }),
      expect.objectContaining({
        Id: "differEnqueued",
        MetricStat: expect.objectContaining({
          Metric: { Namespace: "BillBoard/BillIngestion", MetricName: "BillDifferEnqueued" },
        }),
      }),
      expect.objectContaining({
        Id: "billTextUnavailable",
        MetricStat: expect.objectContaining({
          Metric: { Namespace: "BillBoard/BillIngestion", MetricName: "BillTextUnavailable" },
        }),
      }),
      // REL-58: FetchRawBill's record failures by kind.
      ...[
        ["recordFailedOther", "other"],
        ["recordFailedUnavailable", "unavailable"],
      ].map(([id, kind]) =>
        expect.objectContaining({
          Id: id,
          MetricStat: expect.objectContaining({
            Metric: {
              Namespace: "BillBoard/BillIngestion",
              MetricName: "FetchRawBillRecordFailed",
              Dimensions: [{ Name: "Kind", Value: kind }],
            },
          }),
        }),
      ),
    ]);
  });

  it("counts in-flight and delayed DLQ messages, and uses UPDATED_BILLS_QUEUE_URL when set", async () => {
    const world = newWorld();
    const sqs = {
      send: jest.fn(async (command: FakeCommand) => {
        if (command.constructor.name === "GetQueueUrlCommand") return { QueueUrl: `q/${command.input.QueueName}` };
        return {
          Attributes: {
            ApproximateNumberOfMessages: "0",
            ApproximateNumberOfMessagesNotVisible: command.input.QueueUrl === "q/BillDifferDLQ" ? "1" : "0",
            ApproximateNumberOfMessagesDelayed: command.input.QueueUrl === "q/BillsManifestDLQ" ? "2" : "0",
          },
        };
      }),
    };
    const checks = new AwsChecks({
      ...fakes(world),
      sqs: sqs as unknown as RunDeps["sqs"],
      config: { ...configFromEnv({}), updatedBillsQueueUrl: "https://given" },
      now: () => new Date(world.t),
    });
    const depths = await checks.dlqDepths();
    expect(depths.filter((depth) => depth.messages > 0)).toEqual([
      { name: "BillDifferDLQ", messages: 1 },
      { name: "BillsManifestDLQ", messages: 2 },
    ]);
    expect(depths).toHaveLength(WATCHED_DLQ_NAMES.length);
    expect(await checks.queueUrl("UpdatedBillsQueue")).toBe("https://given");
    await checks.dlqDepths();
    // Queue URLs are resolved once.
    const lookups = sqs.send.mock.calls.filter(([command]) => command.constructor.name === "GetQueueUrlCommand");
    expect(lookups).toHaveLength(WATCHED_DLQ_NAMES.length);
  });

  it("runs the AWS CLI with the region and JSON output, and reports its stderr", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec = (
      file: string,
      args: readonly string[],
      _options: { maxBuffer: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ file, args });
      if (args[1] === "describe-rule") callback(new Error("exit 255"), "", "An error occurred (AccessDenied)\n");
      else callback(null, '"on"\n', "");
    };
    const cli = awsCliRunner("us-east-1", exec);
    await expect(cli(["lambda", "get-function-configuration", "--function-name", "FetchRawBill:prod"])).resolves.toBe(
      '"on"\n',
    );
    expect(calls[0]).toEqual({
      file: "aws",
      args: [
        "lambda",
        "get-function-configuration",
        "--function-name",
        "FetchRawBill:prod",
        "--region",
        "us-east-1",
        "--output",
        "json",
      ],
    });
    await expect(cli(["events", "describe-rule", "--name", "r"])).rejects.toThrow(
      "aws events describe-rule failed: An error occurred (AccessDenied)",
    );
  });
});

// ─── --text-recovery and --predict (REL-45) ───────────────────────────────────

describe("--text-recovery (REL-45)", () => {
  const congressXml = (guid: string, code = "ih") =>
    `https://www.congress.gov/119/bills/${guid.replace("BILLS-119", "")}/${guid}${code}.xml`;
  const govInfoXml = (guid: string, code = "ih") =>
    `https://www.govinfo.gov/content/pkg/${guid}${code}/xml/${guid}${code}.xml`;
  const STORED_XML = "<bill><legis-body>Same text</legis-body></bill>";
  const NEW_XML = '<?xml version="1.0"?><bill><legis-body>Corrected text</legis-body></bill>';

  /** A raw bill whose /text names `xmlUrl` (none when null), with `billXML` when given. */
  const textRaw = (guid: string, xmlUrl: string | null, billXML?: string, fetchedAt = "2026-10-16T08:10:00.000Z") => {
    const base = rawBill(guid, fetchedAt);
    return {
      ...base,
      content: {
        ...base.content,
        text: { textVersions: xmlUrl ? [{ formats: [{ type: "Formatted XML", url: xmlUrl }] }] : [] },
        ...(billXML ? { billXML } : {}),
      },
    };
  };
  const putText = (guid: string, xmlUrl: string | null, billXML?: string, fetchedAt?: string) =>
    mockS3.put(`raw-bills/${guid}.json`, textRaw(guid, xmlUrl, billXML, fetchedAt));
  /** A processed bill whose summary came from `fromXml` (source-text-hash), or a legacy one when undefined. */
  const putProcessed = (guid: string, fromXml?: string) =>
    mockS3.put(
      `processed-bills/${guid}.json`,
      {
        schemaVersion: 1,
        kind: "processed",
        storedAt: "2026-10-01T00:00:00.000Z",
        identifier: { congress: "119", billType: "hr", billNumber: "1" },
        guid,
        title: "Headline",
        link: "",
        soWhat: "Summary.",
        billBreakdown: { who: "", what: "", how: "", when: "", where: "", why: "" },
        subCategories: [],
        lifeAreas: [],
        sponsors: [],
        cosponsors: [],
        actions: [],
        committees: [],
        billStatus: "New",
      },
      fromXml === undefined
        ? undefined
        : {
            [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(textRaw(guid, null, fromXml) as unknown as RawBill),
            [SOURCE_METADATA_KEYS.fetchedAt]: "2026-10-01T00:00:00.000Z",
          },
    );

  /** hr10 selected; hr11 has text; hr12 has no Formatted XML yet; hr13 selected although fetched today; hr14 missing. */
  const seedText = () => {
    putText("BILLS-119hr10", congressXml("BILLS-119hr10"), undefined, "2026-10-13T13:31:00.000Z");
    putText("BILLS-119hr11", congressXml("BILLS-119hr11"), STORED_XML);
    putText("BILLS-119hr12", null);
    putText("BILLS-119hr13", congressXml("BILLS-119hr13", "enr"), undefined, "2026-10-20T11:00:00.000Z");
    putText("BILLS-119hr2", congressXml("BILLS-119hr2"));
  };
  const LIST = ["BILLS-119hr10", "BILLS-119hr11", "BILLS-119hr12", "BILLS-119hr13", "BILLS-119hr14"];

  it("needs a list, and refuses one of more than 100 bills before reading anything", async () => {
    const world = newWorld();
    await expect(run(world, { textRecovery: true })).rejects.toThrow("--text-recovery needs --guids-file or --guid");
    const many = Array.from({ length: TEXT_RECOVERY_MAX_BILLS + 1 }, (_, index) => `BILLS-119hr${3000 + index}`);
    world.files.set("many.txt", `${many.join("\n")}\n`);
    await expect(run(world, { textRecovery: true, guidsFile: "many.txt" })).rejects.toThrow(
      "--text-recovery takes at most 100 bills; the list has 101",
    );
    world.files.set("hundred.txt", `${many.slice(0, 100).join("\n")}\n`);
    await expect(run(world, { textRecovery: true, guidsFile: "hundred.txt" })).resolves.toBeDefined();
    expect(world.sends).toEqual([]);
  });

  it("selects only listed raw bills with a Formatted XML URL and no text, whatever their fetch date", async () => {
    seedText();
    const { result, text } = await run(newWorld(), { textRecovery: true, guids: LIST });

    expect(result).toMatchObject({ exitCode: 0, outcome: "dry_run", eligible: 2 });
    expect(result.scan!.stale.map((bill) => [bill.guid, bill.xmlUrl])).toEqual([
      ["BILLS-119hr10", congressXml("BILLS-119hr10")],
      ["BILLS-119hr13", congressXml("BILLS-119hr13", "enr")],
    ]);
    expect(result.scan).toMatchObject({ fresh: 1, awaitingText: ["BILLS-119hr12"], missing: ["BILLS-119hr14"] });
    expect(text).toContain("selected=2 (a Formatted XML URL and no text) has_text=1 awaiting_text=1");
    expect(text).toContain("Refetch plan: selection=text-recovery awaiting_text=1 stale=2");
    expect(text).toContain("to_send=2");
    // An unlisted bill without text is never read.
    expect(mockS3.commands("GetObject", "raw-bills/BILLS-119hr2.json")).toEqual([]);
  });

  it("waives the X7 precondition with a printed line, sends the selected bills and marks its progress file", async () => {
    seedText();
    const world = newWorld({ carryMode: "watch" });
    const { result, text } = await run(world, { textRecovery: true, guids: LIST, apply: true });

    expect(result).toMatchObject({ exitCode: 0, outcome: "done", sentGuids: ["BILLS-119hr10", "BILLS-119hr13"] });
    expect(text).toContain(
      "ok    member vote carry on (X7): FetchRawBill:prod MEMBER_VOTE_CARRY_MODE=watch; waived for --text-recovery",
    );
    expect(text).toContain("X7 waiver (--text-recovery): MEMBER_VOTE_CARRY_MODE=on is not required.");
    expect(world.sends.map((send) => send.body)).toEqual([
      expect.objectContaining({ guid: "BILLS-119hr10", congress: "119", billType: "hr", billNumber: "10" }),
      expect.objectContaining({ guid: "BILLS-119hr13" }),
    ]);
    expect(world.sends.every((send) => send.body.textRetryAttempt === undefined)).toBe(true);
    expect(world.files.get(PROGRESS)).toContain("# mode=text-recovery\n");
    expect(parseProgress(world.files.get(PROGRESS)!)).toMatchObject({ mode: "text-recovery" });

    // The rerun finds the progress file's bills sent and still without text (in flight): nothing more to send.
    const rerun = await run(world, { textRecovery: true, guids: LIST });
    expect(rerun.result).toMatchObject({ alreadySent: 2, eligible: 0 });
  });

  it("refuses to mix a text-recovery progress file with a cutoff run, and the other way round", async () => {
    seedText();
    const world = newWorld();
    world.files.set(PROGRESS, progressHeader(CUTOFF, 180, "text-recovery"));
    await expect(run(world)).rejects.toThrow("was started with --text-recovery");
    world.files.set(PROGRESS, progressHeader(CUTOFF, 180));
    await expect(run(world, { textRecovery: true, guids: LIST })).rejects.toThrow(
      "was started without --text-recovery",
    );
  });

  it("still refuses --apply on the other preconditions", async () => {
    seedText();
    const world = newWorld({ carryMode: "watch", esmState: "Enabled" });
    const { result } = await run(world, { textRecovery: true, guids: LIST, apply: true });
    expect(result).toMatchObject({ exitCode: 2, outcome: "refused" });
    expect(world.sends).toEqual([]);
  });

  it("--predict fetches GovInfo one bill every 2 s and counts the plans BillDiffer would make", async () => {
    putText("BILLS-119hr21", congressXml("BILLS-119hr21")); // never processed
    putText("BILLS-119hr22", congressXml("BILLS-119hr22")); // summary from the same text
    putProcessed("BILLS-119hr22", STORED_XML);
    putText("BILLS-119hr23", congressXml("BILLS-119hr23")); // summary from another text
    putProcessed("BILLS-119hr23", STORED_XML);
    putText("BILLS-119hr24", congressXml("BILLS-119hr24")); // GovInfo refuses
    putText("BILLS-119hr25", "https://example.com/odd.xml"); // no package id: not asked
    const answers: Record<string, HttpTextResponse> = {
      [govInfoXml("BILLS-119hr21")]: { statusCode: 200, headers: {}, body: NEW_XML },
      [govInfoXml("BILLS-119hr22")]: { statusCode: 200, headers: {}, body: STORED_XML },
      [govInfoXml("BILLS-119hr23")]: { statusCode: 200, headers: {}, body: NEW_XML },
      [govInfoXml("BILLS-119hr24")]: { statusCode: 403, headers: { "cf-mitigated": "challenge" }, body: "" },
    };
    const asked: string[] = [];
    const httpGet = jest.fn(async (url: string) => {
      asked.push(url);
      return answers[url];
    });
    const world = newWorld();
    const guids = ["BILLS-119hr21", "BILLS-119hr22", "BILLS-119hr23", "BILLS-119hr24", "BILLS-119hr25"];

    const { result, text } = await run(world, { textRecovery: true, predict: true, guids }, { httpGet });

    expect(asked).toEqual(guids.slice(0, 4).map((guid) => govInfoXml(guid)));
    expect(world.sleeps).toEqual([PREDICT_INTERVAL_MS, PREDICT_INTERVAL_MS, PREDICT_INTERVAL_MS]);
    expect(result.prediction).toEqual({
      bills: 5,
      fetched: 3,
      fetchFailed: 2,
      summarize_missing: 1,
      summarize_text_changed: 1,
      patch: 0,
      unchanged: 1,
      awaiting_text: 0,
      other: 0,
    });
    expect(text).toContain("BILLS-119hr22: unchanged (no_visible_change, source-hash)");
    expect(text).toContain("BILLS-119hr23: summarize_text_changed (text_changed, source-hash)");
    expect(text).toContain("BILLS-119hr24: fetch_failed (GovInfo 403 challenge)");
    expect(text).toContain(
      "Text recovery prediction: bills=5 fetched=3 fetch_failed=2 summarize_missing=1 summarize_text_changed=1 " +
        "patch=0 unchanged=1 awaiting_text=0 other=0",
    );
    // A prediction writes nothing.
    expect(mockS3.calls.every((call) => call.__cmd === "GetObject" || call.__cmd === "ListObjectsV2")).toBe(true);
    expect(world.sends).toEqual([]);
    expect(world.fileWrites).toEqual([]);
  });

  it("asks GovInfo with FetchRawBill's User-Agent and follows no redirect", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("<bill/>", { status: 200, headers: { "Content-Type": "application/xml" } }));

    const response = await defaultHttpGet("https://www.govinfo.gov/content/pkg/BILLS-119hr1ih/xml/BILLS-119hr1ih.xml");

    expect(response).toEqual({ statusCode: 200, headers: { "content-type": "application/xml" }, body: "<bill/>" });
    const [, init] = fetchSpy.mock.calls[0];
    expect(init).toMatchObject({
      redirect: "manual",
      headers: {
        "User-Agent":
          "BillBoardFetcher/1.1 (BillBoard civic app; bill text; +https://billboard-project.com/privacy.html; contact@billboard-project.com)",
        Accept: "application/xml",
      },
    });
  });
});

// ─── --snapshot-file (REL-56) ─────────────────────────────────────────────────

describe("--snapshot-file (REL-56 backfill)", () => {
  const SNAPSHOT = "/fake/rel56-snapshot.tsv";
  const LISTED_AT = "2026-10-20T10:00:00.000Z";
  const listRow = (type: string, number: number, updateDate: string, extra: Record<string, unknown> = {}) => ({
    congress: 119,
    latestAction: { actionDate: updateDate, text: "Referred to the Committee." },
    number: String(number),
    title: `Row title of BILLS-119${type}${number}`,
    type: type.toUpperCase(),
    updateDate,
    updateDateIncludingText: updateDate,
    url: `https://api.congress.gov/v3/bill/119/${type}/${number}?format=json`,
    ...extra,
  });
  const entry = (
    guid: string,
    cls: SnapshotEntry["cls"],
    rowTime: string,
    row: Record<string, unknown>,
    storedTime: string | null = cls === "missing" ? null : "2026-09-01T00:00:00.000Z",
  ): SnapshotEntry => ({ guid, cls, rowTime, storedTime, row });
  const snapshotText = (entries: SnapshotEntry[], congress = "119") =>
    formatSnapshot(
      {
        congress,
        cutoff: "2026-03-05T00:00:00.000Z",
        top: "2026-10-20T09:55:00.000Z",
        listedAt: LISTED_AT,
        rowTimes: "date",
        requests: 12,
        types: "hr,s,hres",
        recentHours: 48,
        recentFrom: "2026-10-18T09:55:00.000Z",
      },
      ["# counts missing=3 stale=1 stale_same_day=1 unresolved=1 fresh=0 recent=0 titles_differ=0"],
      entries,
    );

  /**
   * File order: hr10953 (never stored), hr9821 (stale), s12 (stored since listedAt), hr500 (stale_same_day),
   * hr504 (fetched exactly at listedAt), hres7 (its row names another bill).
   */
  const STANDARD_ENTRIES = [
    entry("BILLS-119hr10953", "missing", "2026-10-16", listRow("hr", 10953, "2026-10-16")),
    entry("BILLS-119hr9821", "stale", "2026-10-16", listRow("hr", 9821, "2026-10-16")),
    entry("BILLS-119s12", "missing", "2026-10-15", listRow("s", 12, "2026-10-15")),
    entry("BILLS-119hr500", "stale_same_day", "2026-10-14", listRow("hr", 500, "2026-10-14")),
    entry("BILLS-119hr504", "unresolved", "2026-10-13", listRow("hr", 504, "2026-10-13")),
    entry("BILLS-119hres7", "missing", "2026-10-12", listRow("hres", 8, "2026-10-12")),
  ];
  const SELECTED = ["BILLS-119hr10953", "BILLS-119hr9821", "BILLS-119hr500"];
  const seedSnapshot = (world: World, entries: SnapshotEntry[] = STANDARD_ENTRIES) => {
    put("BILLS-119hr9821", "2026-10-01T00:00:00.000Z");
    put("BILLS-119s12", "2026-10-20T11:00:00.000Z"); // the poller fetched it since listedAt
    put("BILLS-119hr500", "2026-09-01T00:00:00.000Z");
    put("BILLS-119hr504", LISTED_AT); // at listedAt counts as since
    const text = snapshotText(entries);
    world.files.set(SNAPSHOT, text);
    return parseSnapshot(text);
  };

  it("refuses --older-than-days and --text-recovery with it", () => {
    expect(parseArgs(["--snapshot-file", "s.tsv"]).snapshotFile).toBe("s.tsv");
    expect(() => parseArgs(["--snapshot-file", "s.tsv", "--older-than-days", "180"])).toThrow(
      "--older-than-days does not apply to --snapshot-file",
    );
    expect(() => parseArgs(["--older-than-days", "30", "--snapshot-file", "s.tsv"])).toThrow("does not apply");
    expect(() => parseArgs(["--snapshot-file", "s.tsv", "--text-recovery", "--guid", "BILLS-119hr1"])).toThrow(
      "--snapshot-file and --text-recovery select bills in different ways",
    );
    expect(() => parseArgs(["--snapshot-file"])).toThrow("--snapshot-file needs a value");
  });

  it("builds a never-stored bill's message exactly as the poller does, plus noTextRetry", () => {
    const row = listRow("hr", 10953, "2026-10-16");
    const built = billListRowMessage("BILLS-119hr10953", row);
    expect(built.message).toEqual({ ...toBillMessage(row, "hr", "119"), noTextRetry: true });
    expect(Object.keys(built.message!)).toEqual([
      "guid",
      "title",
      "link",
      "legislationUrl",
      "pubDate",
      "category",
      "description",
      "congress",
      "billType",
      "billNumber",
      "updateDate",
      "noTextRetry",
    ]);
    expect(built.message).toMatchObject({
      title: "Row title of BILLS-119hr10953",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/house-bill/10953",
      pubDate: "2026-10-16T00:00:00.000Z",
    });
    expect(billListRowMessage("BILLS-119hres7", listRow("hres", 8, "2026-10-12"))).toEqual({
      problem: "its list row names BILLS-119hres8",
    });
    expect(billListRowMessage("BILLS-119hr1", { title: "no number" })).toEqual({
      problem: "its list row names no bill",
    });
    expect(billListRowMessage("BILLS-119xx1", {})).toEqual({ problem: "not a plain bill guid of a known bill type" });
  });

  it("selects exactly the snapshot's bills in its order, skips those fetched since listedAt, and writes nothing", async () => {
    const world = newWorld({ esmState: "Enabled", ruleState: "ENABLED" }); // a dry run outside a window
    const snapshot = seedSnapshot(world);
    const { result, text } = await run(world, { snapshotFile: SNAPSHOT });
    expect(result).toMatchObject({ exitCode: 0, outcome: "dry_run", cutoff: "2026-03-05T00:00:00.000Z", eligible: 3 });
    expect(result.scan!.stale.map((bill) => bill.guid)).toEqual(SELECTED);
    expect(result.scan!.stale.map((bill) => Boolean(bill.neverStored))).toEqual([true, false, false]);
    expect(result.scan!.fetchedSince).toEqual(["BILLS-119s12", "BILLS-119hr504"]);
    expect(result.scan!.unsendable).toEqual([
      { key: "raw-bills/BILLS-119hres7.json", reason: "its list row names BILLS-119hres8" },
    ]);
    expect(text).toContain(`selection=snapshot snapshot=${SNAPSHOT} sha256=${snapshot.sha256} congress=119`);
    expect(text).toContain("  by the snapshot's class: missing=1 stale=1 stale_same_day=1");
    expect(text).toContain("ok    snapshot congress is the poller's and the primary (REL-46): snapshot congress=119");
    expect(text).toContain("ok    before the 2026-12-28 freeze (RUNBOOK 24.1)");
    expect(text).toContain(
      "Dry run: --apply would send 3 bills now, first BILLS-119hr10953, BILLS-119hr9821, BILLS-119hr500.",
    );
    expect(text).toContain(
      "Refetch plan: mode=snapshot missing=1 stale=2 fetched_since=2 already_sent=0 to_send=3 unsendable=1 " +
        "unreadable=0 first_summaries=1 titles_differ=2 titles_govinfo=0 resummaries_likely=2 calls=24 hours=0 windows=1",
    );
    expect(world.sends).toEqual([]);
    expect(world.fileWrites).toEqual([]);
    expect(s3Commands().every((cmd) => cmd === "GetObject")).toBe(true);
  });

  it("--apply sends them in the file's order with rel56 correlation ids, and records the snapshot in the progress file", async () => {
    const world = newWorld();
    const snapshot = seedSnapshot(world);
    const { result, text } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done", sentGuids: SELECTED });
    expect(world.sends.map((send) => send.correlationId)).toEqual(
      SELECTED.map((guid) => `rel56:2026-10-20T12:00:00.000Z:${guid}`),
    );
    // CreateBillsManifest takes these as the backfill's (RUNBOOK 4.9, D2).
    expect(world.sends.every((send) => isRel56BackfillCorrelationId(send.correlationId))).toBe(true);
    // The never-stored bill: the poller's message for its row. A stored one: its stored dates, and its list row's
    // title (congress.gov retitled it) and latest action, as the poller sends them (FetchRawBill stores the message's
    // title, and the app shows it). Both carry the snapshot's listedAt: FetchRawBill dates their title by it (REL-58).
    expect(world.sends[0].body).toEqual({
      ...toBillMessage(STANDARD_ENTRIES[0].row, "hr", "119"),
      noTextRetry: true,
      listedAt: LISTED_AT,
    });
    expect(world.sends[1].body).toEqual({
      ...refetchMessage("BILLS-119hr9821", rawBill("BILLS-119hr9821", "x") as never).message,
      title: "Row title of BILLS-119hr9821",
      description: "Referred to the Committee.",
      listedAt: LISTED_AT,
    });
    const progress = world.files.get(PROGRESS)!;
    expect(progress.startsWith(snapshotProgressHeader(snapshot.sha256, LISTED_AT))).toBe(true);
    expect(parseProgress(progress)).toEqual({
      cutoff: null,
      olderThanDays: null,
      sent: new Set(SELECTED),
      mode: "snapshot",
      snapshotSha256: snapshot.sha256,
      listedAt: LISTED_AT,
    });
    expect(progressGuids(world)).toEqual(SELECTED);
    expect(text).toContain(
      "Refetch summary: mode=APPLY selection=snapshot outcome=done selected=3 already_sent=0 eligible=3 sent=3 " +
        "remaining=0 unsendable=1 unreadable=0 missing=1 missing_sent=1 fetched_since=2",
    );

    // The next window: the sent bills are skipped, and a never-stored one FetchRawBill stored since is fetched_since.
    put("BILLS-119hr10953", "2026-10-20T12:00:30.000Z");
    world.sends.length = 0;
    const again = await run(world, { snapshotFile: SNAPSHOT });
    expect(again.result.scan!.fetchedSince).toContain("BILLS-119hr10953");
    expect(again.result).toMatchObject({ alreadySent: 2, eligible: 0 });
    expect(again.text).toContain("  sent but still pending: BILLS-119hr9821, BILLS-119hr500");
  });

  it("sends a stored bill with its list row's title, and the stored one when the row has none", async () => {
    const world = newWorld();
    put("BILLS-119hr700", "2026-09-01T00:00:00.000Z");
    put("BILLS-119hr701", "2026-09-01T00:00:00.000Z");
    put("BILLS-119hr702", "2026-09-01T00:00:00.000Z");
    world.files.set(
      SNAPSHOT,
      snapshotText([
        entry("BILLS-119hr700", "stale", "2026-10-16", listRow("hr", 700, "2026-10-16", { title: "A short title" })),
        entry("BILLS-119hr701", "stale", "2026-10-16", listRow("hr", 701, "2026-10-16", { title: "  " })),
        entry(
          "BILLS-119hr702",
          "stale",
          "2026-10-16",
          listRow("hr", 702, "2026-10-16", { title: " Title of BILLS-119hr702 " }),
        ),
        // A row that names another bill gives this one neither its title nor its description.
        entry("BILLS-119hr703", "stale", "2026-10-16", listRow("hr", 704, "2026-10-16", { title: "Another bill" })),
      ]),
    );
    put("BILLS-119hr703", "2026-09-01T00:00:00.000Z");
    const { text } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
    expect(world.sends.map((send) => send.body.title)).toEqual([
      "A short title",
      "Title of BILLS-119hr701",
      "Title of BILLS-119hr702",
      "Title of BILLS-119hr703",
    ]);
    expect(world.sends[3].body.description).toBe("Introduced in House");
    expect(text).toContain("titles_differ=1");
  });

  it("tells the older GovInfo path's stored titles from congress.gov's (isGovInfoTitle, titleChange)", () => {
    // The labels GovInfo gave each bill type, as stored (&nbsp;), or with plain or no-break spaces.
    expect(isGovInfoTitle("H.R.&nbsp;7264&nbsp;(IH) - Restoring America’s Floodplains Act", "BILLS-119hr7264")).toBe(
      true,
    );
    expect(isGovInfoTitle("S.&nbsp;1809&nbsp;(RS) - Drone Espionage Act", "BILLS-119s1809")).toBe(true);
    expect(isGovInfoTitle("H. Res.&nbsp;1033&nbsp;(IH) - Expressing support", "BILLS-119hres1033")).toBe(true);
    expect(isGovInfoTitle("S. Res.&nbsp;607&nbsp;(IS) - Honoring the memories", "BILLS-119sres607")).toBe(true);
    expect(isGovInfoTitle("H.J. Res.&nbsp;149&nbsp;(IH) - Recognizing", "BILLS-119hjres149")).toBe(true);
    expect(isGovInfoTitle("S.J. Res.&nbsp;102&nbsp;(RS) - Disapproving", "BILLS-119sjres102")).toBe(true);
    expect(isGovInfoTitle("H. Con. Res.&nbsp;70&nbsp;(IH) - Affirming", "BILLS-119hconres70")).toBe(true);
    expect(isGovInfoTitle("S. Con. Res.&nbsp;27&nbsp;(IS) - Celebrating", "BILLS-119sconres27")).toBe(true);
    expect(isGovInfoTitle("H.R. 7264 (IH) - Restoring", "BILLS-119hr7264")).toBe(true);
    expect(isGovInfoTitle("H.R.\u00a07264\u00a0(ENR) - Restoring", "BILLS-119hr7264")).toBe(true);
    // Another bill's number or type, no text version, or congress.gov's own titles: not GovInfo's form.
    expect(isGovInfoTitle("H.R.&nbsp;7265&nbsp;(IH) - Restoring", "BILLS-119hr7264")).toBe(false);
    expect(isGovInfoTitle("S.&nbsp;7264&nbsp;(IS) - Restoring", "BILLS-119hr7264")).toBe(false);
    expect(isGovInfoTitle("H. Res.&nbsp;33&nbsp;(IH) - Expressing", "BILLS-119hconres33")).toBe(false);
    expect(isGovInfoTitle("H.R.&nbsp;7264 - Restoring", "BILLS-119hr7264")).toBe(false);
    expect(isGovInfoTitle("Restoring America’s Floodplains Act", "BILLS-119hr7264")).toBe(false);
    expect(isGovInfoTitle("To amend H.R. 7264 (IH) - of the 118th", "BILLS-119hr7264")).toBe(false);
    expect(isGovInfoTitle("H.R.&nbsp;7264&nbsp;(IH) - Restoring", "not-a-guid")).toBe(false);

    const raw = (title: string, contentTitle = "Content title") =>
      ({ metadata: { title }, content: { bill: { bill: { title: contentTitle } } } }) as unknown as RawBill;
    const row = (title?: string) => (title === undefined ? {} : { title });
    const govinfo =
      "H.R.&nbsp;6544&nbsp;(RH) - Regulatory Efficiency, Verification, Itemization, and Enhanced Value Act";
    expect(titleChange(raw(govinfo), row("REVIEW Act of 2025"), "BILLS-119hr6544")).toBe("govinfo");
    expect(titleChange(raw(govinfo), row(""), "BILLS-119hr6544")).toBe("none");
    expect(titleChange(raw("Old title"), row(), "BILLS-119hr1")).toBe("none");
    expect(titleChange(raw("Old title"), row(" Old title "), "BILLS-119hr1")).toBe("same");
    expect(titleChange(raw("Old title"), row("New title"), "BILLS-119hr1")).toBe("differs");
    // No stored metadata title: the text hash reads the content's, so that is what the row's is compared with.
    expect(titleChange(raw("", "CLEAR Act of 2025"), row("CLEAR Act of 2025"), "BILLS-119hr1")).toBe("same");
    expect(titleChange(raw("", "CLEAR Act of 2025"), row("Another title"), "BILLS-119hr1")).toBe("differs");
  });

  it("keeps a stored title in GovInfo's form (titles_govinfo): no new text hash, so no re-summary and no date move", async () => {
    const world = newWorld();
    const stored = new Map<string, RawBill>();
    // Each stored copy has text, and a text version dated after its row's action: nothing else forecasts a re-summary.
    const putWithText = (guid: string, title: string, contentTitle: string, description?: string) => {
      const raw = {
        ...rawBill(guid, "2026-02-01T00:00:00.000Z", { title, ...(description ? { description } : {}) }),
        content: {
          bill: { bill: { title: contentTitle } },
          text: { textVersions: [{ date: "2026-10-20T04:00:00Z" }] },
          billXML: "<bill>The text.</bill>",
        },
      } as unknown as RawBill;
      stored.set(guid, raw);
      mockS3.put(`raw-bills/${guid}.json`, raw);
    };
    // GovInfo's form: the same title after its prefix, and another title of the same text (the acronym).
    putWithText(
      "BILLS-119hr7264",
      "H.R.&nbsp;7264&nbsp;(IH) - Restoring America’s Floodplains Act",
      "Restoring America’s Floodplains Act",
    );
    putWithText(
      "BILLS-119hr6544",
      "H.R.&nbsp;6544&nbsp;(RH) - Regulatory Efficiency, Verification, Itemization, and Enhanced Value Act",
      "REVIEW Act of 2025",
    );
    // congress.gov retitled this one since it was stored.
    putWithText("BILLS-119hr700", "To provide for a thing.", "To provide for a thing.");
    // No stored metadata title, and the content's is the list's; its row has no latest action text either.
    putWithText("BILLS-119hr701", "", "CLEAR Act of 2025", "Stored description");
    const titled = (number: number, title: string, extra: Record<string, unknown> = {}) =>
      entry(`BILLS-119hr${number}`, "stale", "2026-10-16", listRow("hr", number, "2026-10-16", { title, ...extra }));
    world.files.set(
      SNAPSHOT,
      snapshotText([
        titled(7264, "Restoring America’s Floodplains Act"),
        titled(6544, "REVIEW Act of 2025"),
        titled(700, "Thing Act"),
        titled(701, "CLEAR Act of 2025", { latestAction: { actionDate: "2026-10-16" } }),
      ]),
    );

    const dry = await run(world, { snapshotFile: SNAPSHOT });
    expect(dry.result.scan!.stale.map((bill) => [bill.guid, bill.titleGovInfo, bill.titleDiffers])).toEqual([
      ["BILLS-119hr7264", true, false],
      ["BILLS-119hr6544", true, false],
      ["BILLS-119hr700", false, true],
      ["BILLS-119hr701", false, false],
    ]);
    expect(dry.text).toContain("titles_differ=1 titles_govinfo=2 resummaries_likely=1 ");
    expect(dry.text).toContain(
      '  titles_govinfo=2: stored titles in GovInfo\'s form ("H.R.&nbsp;N&nbsp;(IH) - ..."), sent as stored',
    );

    await run(world, { snapshotFile: SNAPSHOT, apply: true });
    const sent = new Map(world.sends.map((send) => [send.body.guid, send.body]));
    expect([...sent.values()].map((body) => body.title)).toEqual([
      "H.R.&nbsp;7264&nbsp;(IH) - Restoring America’s Floodplains Act",
      "H.R.&nbsp;6544&nbsp;(RH) - Regulatory Efficiency, Verification, Itemization, and Enhanced Value Act",
      "Thing Act",
      "CLEAR Act of 2025",
    ]);
    // The row's latest action text as the description, as the poller sends it; the stored one when the row has none.
    expect([...sent.values()].map((body) => body.description)).toEqual([
      "Referred to the Committee.",
      "Referred to the Committee.",
      "Referred to the Committee.",
      "Stored description",
    ]);
    // FetchRawBill stores the message's title: only the retitled bill gets a new text hash (a re-summary, D5).
    const hashChanged = [...sent.entries()].map(([guid, body]) => {
      const before = stored.get(`${guid}`)!;
      const after = { ...before, metadata: { ...before.metadata, title: body.title } } as RawBill;
      return [guid, sourceTextHash(after) !== sourceTextHash(before)];
    });
    expect(hashChanged).toEqual([
      ["BILLS-119hr7264", false],
      ["BILLS-119hr6544", false],
      ["BILLS-119hr700", true],
      ["BILLS-119hr701", false],
    ]);
  });

  it("forecasts re-summaries from the stored copy and the list row (resummaryLikely)", () => {
    const stored = (content: Record<string, unknown>) =>
      ({ metadata: { guid: "BILLS-119hr1", title: "T" }, content }) as unknown as RawBill;
    const versions = (...dates: Array<string | null>) => ({ text: { textVersions: dates.map((date) => ({ date })) } });
    const row = (actionDate?: string) => (actionDate ? { latestAction: { actionDate, text: "An action." } } : {});
    const withText = { ...versions("2026-07-21T04:00:00Z"), billXML: "<bill/>" };
    // A list title that differs, on a bill with text: the title is part of the text hash, so a re-summary.
    expect(resummaryLikely(stored(withText), row("2026-07-01"), true)).toBe(true);
    expect(resummaryLikely(stored(withText), row("2026-07-01"), false)).toBe(false);
    // An action after the newest stored text version: a new version may have come with it.
    expect(resummaryLikely(stored(withText), row("2026-07-22"), false)).toBe(true);
    expect(resummaryLikely(stored(withText), row("2026-07-21"), false)).toBe(false);
    // Text versions listed but no XML stored: the refetch may get it.
    expect(resummaryLikely(stored(versions("2026-07-21T04:00:00Z")), row("2026-07-01"), false)).toBe(true);
    // No text version stored at all: any action may bring the first.
    expect(resummaryLikely(stored({}), row("2026-07-01"), false)).toBe(true);
    expect(resummaryLikely(stored({}), row(), false)).toBe(false);
    // The newest of several versions counts, and a version with no date is passed over.
    expect(
      resummaryLikely(
        stored({ ...versions(null, "2026-09-17T04:00:00Z", "2026-01-29T05:00:00Z"), billXML: "<bill/>" }),
        row("2026-09-17"),
        false,
      ),
    ).toBe(false);
  });

  it("prints the next batch's resummaries_likely, and warns under --apply when it is above --max-summaries", async () => {
    const world = newWorld();
    const entries: SnapshotEntry[] = [];
    for (let index = 0; index < 6; index += 1) {
      const guid = `BILLS-119hr${800 + index}`;
      // Even ones hold a text dated after their row's action (unlikely); odd ones an older one (likely).
      mockS3.put(`raw-bills/${guid}.json`, {
        ...rawBill(guid, "2026-09-01T00:00:00.000Z"),
        content: {
          bill: { bill: { title: "Content title" } },
          text: { textVersions: [{ date: index % 2 === 0 ? "2026-10-20T04:00:00Z" : "2026-05-01T04:00:00Z" }] },
          billXML: "<bill/>",
        },
      });
      entries.push(
        entry(guid, "stale", "2026-10-16", listRow("hr", 800 + index, "2026-10-16", { title: `Title of ${guid}` })),
      );
    }
    world.files.set(SNAPSHOT, snapshotText(entries));
    const dry = await run(world, { snapshotFile: SNAPSHOT, limit: 4 });
    expect(dry.text).toContain("titles_differ=0 titles_govinfo=0 resummaries_likely=2 ");
    expect(dry.text).toContain(
      "Re-summaries likely: 2 in the next batch of 4 (3 of the 6 bills to send); a forecast that errs high, against " +
        "--max-summaries 50 (RUNBOOK 16.1, D5).",
    );
    const apply = await run(world, { snapshotFile: SNAPSHOT, apply: true, limit: 4, maxSummaries: 1 });
    expect(apply.text).toContain(
      "The batch's resummaries_likely=2 is above --max-summaries 1: the run may stop with too_many_summaries " +
        "(RUNBOOK 16.1, D5).",
    );
  });

  it("has no fetchedAt cutoff and no 100-bill cap", async () => {
    const world = newWorld();
    // 150 stored bills fetched two days ago (fresh by the 180-day cutoff) and 50 never stored, all in the snapshot.
    const entries: SnapshotEntry[] = [];
    for (let index = 0; index < 200; index += 1) {
      const guid = `BILLS-119hr${2000 + index}`;
      if (index < 150) put(guid, "2026-10-18T00:00:00.000Z");
      entries.push(
        entry(guid, index < 150 ? "stale" : "missing", "2026-10-10", listRow("hr", 2000 + index, "2026-10-10")),
      );
    }
    world.files.set(SNAPSHOT, snapshotText(entries));
    const { result } = await run(world, { snapshotFile: SNAPSHOT });
    expect(result.eligible).toBe(200);
    expect(result.scan!.stale.map((bill) => bill.guid)).toEqual(entries.map((each) => each.guid));
    // The cutoff run over the same raw bills selects none of them.
    const cutoffRun = await run(newWorld(), {});
    expect(cutoffRun.result.eligible).toBe(0);
  });

  it("narrows with --guid, --guids-file and --congress, and never widens", async () => {
    const world = newWorld();
    seedSnapshot(world);
    const narrowed = await run(world, { snapshotFile: SNAPSHOT, guids: ["BILLS-119hr500", "BILLS-119hr77"] });
    expect(narrowed.result.scan!.stale.map((bill) => bill.guid)).toEqual(["BILLS-119hr500"]);
    expect(narrowed.result.scan!.notInSnapshot).toEqual(["BILLS-119hr77"]);
    expect(narrowed.text).toContain("not in the snapshot (1, not sent): BILLS-119hr77");
    world.files.set("canary.txt", "BILLS-119hr10953\n");
    const fromFile = await run(world, { snapshotFile: SNAPSHOT, guidsFile: "canary.txt" });
    expect(fromFile.result.scan!.stale.map((bill) => bill.guid)).toEqual(["BILLS-119hr10953"]);
    const otherCongress = await run(world, { snapshotFile: SNAPSHOT, congress: "118" });
    expect(otherCongress.result.scan!.stale).toEqual([]);
    expect(otherCongress.result.scan!.scanned).toBe(0);
  });

  it("sends the verification snapshot's leftovers named in a guids file, wherever they sort (RUNBOOK 16.1, step 6)", async () => {
    // Review probe: by Dec 24 the verification snapshot lists detail-lag rows dated after window 1 first (newest
    // first), and the leftovers it is for last. The whole file at the default --limit 800 sends none of them.
    const world = newWorld();
    const entries: SnapshotEntry[] = [];
    for (let index = 0; index < 850; index += 1) {
      const guid = `BILLS-119hr${30_000 + index}`;
      put(guid, "2026-10-01T00:00:00.000Z");
      entries.push(entry(guid, "stale", "2026-10-19", listRow("hr", 30_000 + index, "2026-10-19")));
    }
    const leftovers = [
      entry("BILLS-119hr40000", "missing", "2026-10-18", listRow("hr", 40_000, "2026-10-18")),
      entry("BILLS-119hr40001", "stale_same_day", "2026-10-02", listRow("hr", 40_001, "2026-10-02")),
      entry("BILLS-119hr40002", "unresolved", "2026-10-01", listRow("hr", 40_002, "2026-10-01")),
    ];
    for (const leftover of leftovers.slice(1)) put(leftover.guid, "2026-09-01T00:00:00.000Z");
    world.files.set(SNAPSHOT, snapshotText([...entries, ...leftovers]));
    const whole = await run(world, { snapshotFile: SNAPSHOT });
    expect(whole.result.eligible).toBe(853);
    expect(whole.text).toContain("Dry run: --apply would send 800 bills now, first BILLS-119hr30000");

    world.files.set("leftovers.txt", `${leftovers.map((leftover) => leftover.guid).join("\n")}\n`);
    const { result } = await run(world, { snapshotFile: SNAPSHOT, guidsFile: "leftovers.txt", apply: true });
    expect(result).toMatchObject({ exitCode: 0, outcome: "done", sentGuids: leftovers.map((each) => each.guid) });
    expect(world.sends.map((send) => send.body.guid)).toEqual(leftovers.map((leftover) => leftover.guid));
  });

  it("refuses a progress file of another snapshot or another mode, and a snapshot file that is missing or malformed", async () => {
    const world = newWorld();
    seedSnapshot(world);
    world.files.set(PROGRESS, snapshotProgressHeader("a".repeat(64), LISTED_AT));
    await expect(run(world, { snapshotFile: SNAPSHOT })).rejects.toThrow("belongs to another snapshot");
    world.files.set(PROGRESS, progressHeader(CUTOFF, 180));
    await expect(run(world, { snapshotFile: SNAPSHOT })).rejects.toThrow("was started without --snapshot-file");
    world.files.set(PROGRESS, progressHeader(CUTOFF, 180, "text-recovery"));
    await expect(run(world, { snapshotFile: SNAPSHOT })).rejects.toThrow("was started without --snapshot-file");
    world.files.set(PROGRESS, snapshotProgressHeader("b".repeat(64), LISTED_AT));
    await expect(run(world, {})).rejects.toThrow("was started with --snapshot-file");
    await expect(run(world, { textRecovery: true, guids: ["BILLS-119hr1"] })).rejects.toThrow(
      "was started with --snapshot-file",
    );
    world.files.delete(PROGRESS);
    await expect(run(world, { snapshotFile: "/fake/absent.tsv" })).rejects.toThrow("does not exist");
    world.files.set("/fake/bad.tsv", "BILLS-119hr1\tmissing\n");
    await expect(run(world, { snapshotFile: "/fake/bad.tsv" })).rejects.toThrow(
      "not a list:skipped-bill-updates snapshot",
    );
    await expect(run(world, { snapshotFile: SNAPSHOT, textRecovery: true, guids: ["BILLS-119hr1"] })).rejects.toThrow(
      "select bills in different ways",
    );
    expect(world.sends).toEqual([]);
  });

  it.each<[string, Partial<World>, string]>([
    [
      "the poller state of another congress",
      { pollerState: POLLER_STATE.replace('"119"', '"120"') },
      "FAIL  snapshot congress is the poller's and the primary (REL-46): snapshot congress=119 poller state congress=120 primary=119",
    ],
    [
      "the 120th primary",
      { t: Date.parse("2027-01-04T00:00:00.000Z") },
      "FAIL  snapshot congress is the poller's and the primary (REL-46): snapshot congress=119 poller state congress=119 primary=120",
    ],
    [
      "on 2026-12-28",
      { t: Date.parse("2026-12-28T00:00:00.000Z") },
      "FAIL  before the 2026-12-28 freeze (RUNBOOK 24.1): 2026-12-28T00:00:00.000Z is on or after 2026-12-28T00:00:00.000Z",
    ],
    ["member vote carry in watch", { carryMode: "watch" }, "MEMBER_VOTE_CARRY_MODE=watch; flip it to on first (X7)"],
    ["NotificationType still consuming", { esmState: "Enabled" }, "NotificationTypeQueue mapping esm-nt Enabled"],
    ["the poller rule still on", { ruleState: "ENABLED" }, "poller rule BillsApiPollerSchedule ENABLED"],
    ["a message in an ingest DLQ", { dlq: { BillSummarizerDLQ: 2 } }, "BillSummarizerDLQ=2"],
    ["the poller state unknown", { pollerState: "UNINITIALIZED" }, "the parameter does not parse"],
    ["the AWS CLI failing", { cliError: "aws: command not found" }, "check failed: aws: command not found"],
  ])("refuses --apply with exit 2 before reading or sending anything: %s", async (_name, overrides, detail) => {
    const world = newWorld(overrides);
    seedSnapshot(world);
    const before = mockS3.calls.length;
    const { result, text } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
    expect(result).toMatchObject({ exitCode: 2, outcome: "refused", scan: null, sentGuids: [] });
    expect(text).toContain(detail);
    expect(world.sends).toEqual([]);
    expect(world.files.has(PROGRESS)).toBe(false);
    expect(mockS3.calls.length).toBe(before);
  });

  it("sends nothing from 2026-12-28T00:00Z, even in a window opened before it", async () => {
    const world = newWorld({ t: Date.parse("2026-12-27T23:59:00.000Z") });
    const entries = Array.from({ length: 30 }, (_, index) =>
      entry(`BILLS-119hr${3000 + index}`, "missing", "2026-10-10", listRow("hr", 3000 + index, "2026-10-10")),
    );
    world.files.set(SNAPSHOT, snapshotText(entries));
    const { result } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
    expect(result.outcome).toBe("window_time");
    // One every 7.2 s for the minute before midnight: 9 sends, none at or after it.
    expect(world.sends).toHaveLength(9);
    expect(world.sends.every((send) => send.at < Date.parse("2026-12-28T00:00:00.000Z"))).toBe(true);
  });

  describe("the summary cap (decision D3)", () => {
    /**
     * n never-stored bills then m stored stale ones; each send makes one BillDiffer pass that the logs show. A
     * never-stored bill's pass is a first summary (reason no_processed); a stored bill's is `storedReason`.
     */
    const capWorld = (
      neverStored: number,
      stored: number,
      { logged = true, storedReason = "text_changed" }: { logged?: boolean; storedReason?: string } = {},
    ) => {
      const entries: SnapshotEntry[] = [];
      for (let index = 0; index < neverStored; index += 1) {
        entries.push(
          entry(`BILLS-119hr${4000 + index}`, "missing", "2026-10-10", listRow("hr", 4000 + index, "2026-10-10")),
        );
      }
      for (let index = 0; index < stored; index += 1) {
        put(`BILLS-119s${5000 + index}`, "2026-09-01T00:00:00.000Z");
        entries.push(
          entry(`BILLS-119s${5000 + index}`, "stale", "2026-10-09", listRow("s", 5000 + index, "2026-10-09")),
        );
      }
      const world: World = newWorld({
        onSend: () => {
          const sent = world.sends[world.sends.length - 1];
          world.metrics.differEnqueued = (world.metrics.differEnqueued ?? 0) + 1;
          if (logged)
            world.enqueuedDiffs.push({
              key: `raw-bills/${sent.body.guid}.json`,
              awsRequestId: `r-${sent.body.guid}`,
              reason: sent.body.guid.startsWith("BILLS-119hr") ? "no_processed" : storedReason,
            });
        },
      });
      world.files.set(SNAPSHOT, snapshotText(entries));
      return world;
    };

    it("does not count the first summaries of bills sent as never stored", async () => {
      const world = capWorld(70, 3);
      const { result, lines } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
      expect(result).toMatchObject({ exitCode: 0, outcome: "done", stop: null });
      expect(world.sends).toHaveLength(73);
      const notes = lines.filter((line) => line.startsWith("BillDifferEnqueued="));
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[notes.length - 1]).toBe(
        "BillDifferEnqueued=73 is above --max-summaries 50, but it counts passes: 3 bills were sent to BillSummarizer " +
          "(3 in BillDiffer's logs, not counting 70 first summaries of bills the backfill sent (D3)), within the limit.",
      );
    });

    it("still counts re-summaries of stored bills", async () => {
      const world = capWorld(10, 60);
      const { result } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
      expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_too_many_summaries" });
      // Stopped at the first check above the cap (checks come a minute apart): every stored bill sent counts.
      const counted = Number(result.stop!.detail.match(/^(\d+) bills sent/)![1]);
      expect(counted).toBeGreaterThan(50);
      expect(result.stop!.detail).toBe(
        `${counted} bills sent to BillSummarizer since the start (limit 50): ${counted} in BillDiffer's "Diffed raw bill" ` +
          `lines with outcome enqueued, not counting 10 first summaries of bills the backfill sent (D3); ` +
          `BillDifferEnqueued=${counted + 10}`,
      );
    });

    it("does not count the first summary of a stored bill the run sent that had no processed copy", async () => {
      // About 67 stored bills had no processed copy on 2026-11-09: when their text comes, BillDiffer plans a first
      // summary (summarize_missing, reason no_processed), as for a bill never stored.
      const world = capWorld(0, 60, { storedReason: "no_processed" });
      const { result, lines } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
      expect(result).toMatchObject({ exitCode: 0, outcome: "done", stop: null });
      expect(world.sends).toHaveLength(60);
      expect(lines.filter((line) => line.startsWith("BillDifferEnqueued=")).pop()).toBe(
        "BillDifferEnqueued=60 is above --max-summaries 50, but it counts passes: 0 bills were sent to BillSummarizer " +
          "(0 in BillDiffer's logs, not counting 60 first summaries of bills the backfill sent (D3)), within the limit.",
      );
    });

    it("after a stop, a rerun does not count the first summaries of bills an earlier run sent (progress file)", async () => {
      // The first run sent 60 never-stored bills, then stopped (check_failed, say). Their first summaries land after
      // the rerun's start: expected, since the progress file lists them as sent.
      const world = capWorld(70, 0);
      const snapshot = parseSnapshot(world.files.get(SNAPSHOT)!);
      const earlier = snapshot.entries.slice(0, 60).map((earlierEntry) => earlierEntry.guid);
      world.files.set(
        PROGRESS,
        snapshotProgressHeader(snapshot.sha256, LISTED_AT) +
          earlier.map((guid) => progressLine(guid, "2026-10-20T11:00:00.000Z", "2026-10-20T10:59:00.000Z")).join(""),
      );
      world.metrics.differEnqueued = 60;
      world.enqueuedDiffs.push(
        ...earlier.map((guid) => ({
          key: `raw-bills/${guid}.json`,
          awsRequestId: `r0-${guid}`,
          reason: "no_processed",
        })),
      );
      const { result } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
      expect(result).toMatchObject({ exitCode: 0, outcome: "done", stop: null });
      expect(world.sends).toHaveLength(10);
    });

    it("still counts passes the logs do not show yet, never-stored bills' included", async () => {
      const world = capWorld(70, 0, { logged: false });
      const { result } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
      expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_too_many_summaries" });
      expect(result.stop!.detail).toMatch(
        /^(\d+) bills .*: 0 in BillDiffer's .* plus \1 BillDifferEnqueued not in the logs yet;/,
      );
    });

    it("counts as expected only the first summaries (reason no_processed) of bills the backfill sent", () => {
      const diffRows = [
        { key: "raw-bills/BILLS-119hr1.json", requestId: "a", reason: "no_processed" },
        { key: "raw-bills/BILLS-119hr1.json", requestId: "b", reason: "no_processed" },
        { key: "raw-bills/BILLS-119hr2.json", requestId: "c", reason: "no_processed" },
        { key: null, requestId: "d", reason: "no_processed" },
      ];
      expect(countSummarizedBills(5, diffRows, new Set(["raw-bills/BILLS-119hr1.json"]))).toEqual({
        passes: 5,
        inLogs: 2,
        unseen: 1,
        bills: 3,
        expected: 1,
      });
      expect(countSummarizedBills(5, diffRows, new Set())).toEqual({
        passes: 5,
        inLogs: 3,
        unseen: 1,
        bills: 4,
        expected: 0,
      });
      const sent = new Set([
        "raw-bills/BILLS-119hr1.json",
        "raw-bills/BILLS-119hr2.json",
        "raw-bills/BILLS-119hr3.json",
      ]);
      // A re-summary of a bill the backfill sent still counts, and so does a key with one of each; a first summary
      // of a bill it did not send, and a row with no reason, count too.
      expect(
        countSummarizedBills(
          6,
          [
            { key: "raw-bills/BILLS-119hr1.json", requestId: "a", reason: "no_processed" },
            { key: "raw-bills/BILLS-119hr2.json", requestId: "b", reason: "text_changed" },
            { key: "raw-bills/BILLS-119hr3.json", requestId: "c", reason: "no_processed" },
            { key: "raw-bills/BILLS-119hr3.json", requestId: "d", reason: "text_changed" },
            { key: "raw-bills/BILLS-119hr4.json", requestId: "e", reason: "no_processed" },
            { key: "raw-bills/BILLS-119hr1.json", requestId: "f", reason: null },
          ],
          sent,
        ),
      ).toEqual({ passes: 6, inLogs: 4, unseen: 0, bills: 4, expected: 0 });
      // The same pass twice in the rows (one invocation, one key) is one pass, so unseen passes are not hidden.
      expect(
        countSummarizedBills(
          3,
          [
            { key: "raw-bills/BILLS-119hr1.json", requestId: "a", reason: "no_processed" },
            { key: "raw-bills/BILLS-119hr1.json", requestId: "a", reason: "text_changed" },
          ],
          sent,
        ),
      ).toEqual({ passes: 3, inLogs: 1, unseen: 2, bills: 3, expected: 0 });
    });
  });

  it.each<[string, (world: World) => void, string]>([
    ["a DLQ message", (world) => (world.dlq.BillDifferDLQ = 1), "dlq_message"],
    ["FetchRawBill errors", (world) => (world.metrics.fetchRawBillErrors = 1), "fetch_errors"],
    ["a FetchRawBill record failure of Kind other", (world) => (world.metrics.recordFailedOther = 1), "fetch_errors"],
    ["10 congress.gov record failures", (world) => (world.metrics.recordFailedUnavailable = 10), "fetch_errors"],
    ["a congress.gov 429", (world) => (world.metrics.congressApi429 = 1), "congress_key_errors"],
    ["a bill stored without text", (world) => (world.metrics.billTextUnavailable = 1), "text_unavailable"],
    ["the window closed", (world) => (world.esmState = "Enabled"), "window_closed"],
    ["a check that cannot run", (world) => (world.metricsError = "Throttling"), "check_failed"],
  ])("stops mid-run with exit 2 on %s, as a cutoff run does", async (_name, breakIt, reason) => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry(`BILLS-119hr${6000 + index}`, "missing", "2026-10-10", listRow("hr", 6000 + index, "2026-10-10")),
    );
    const world = newWorld({ onSend: (sent) => sent === 3 && breakIt(world) });
    world.files.set(SNAPSHOT, snapshotText(entries));
    const { result } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
    expect(result).toMatchObject({ exitCode: 2, outcome: `stopped_${reason}`, stop: { reason } });
    expect(world.sends.every((send) => send.at < START + CHECK_INTERVAL_MS)).toBe(true);
    expect(progressGuids(world)).toHaveLength(world.sends.length);
  });

  it("keeps --limit, the pacing and the backlog pause", async () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry(`BILLS-119hr${7000 + index}`, "missing", "2026-10-10", listRow("hr", 7000 + index, "2026-10-10")),
    );
    const world = newWorld({ backlog: [25, 0] });
    world.files.set(SNAPSHOT, snapshotText(entries));
    const { result, text } = await run(world, { snapshotFile: SNAPSHOT, apply: true, limit: 4 });
    expect(result).toMatchObject({ outcome: "batch_limit", sentGuids: entries.slice(0, 4).map((each) => each.guid) });
    expect(text).toContain("UpdatedBillsQueue holds 25 messages; pausing 30 s.");
    const gaps = world.sends.slice(1).map((send, index) => send.at - world.sends[index].at);
    expect(gaps.every((gap) => gap >= 7_200)).toBe(true);
  });
  // ─── --unattended (project decision 2026-11-12): the backfill without quiet windows ───────────────────────────────

  describe("--unattended (REL-56 backfill without quiet windows)", () => {
    /** No window: the poller rule and the NotificationTypeQueue mapping on. */
    const OUTSIDE_WINDOW: Partial<World> = { esmState: "Enabled", ruleState: "ENABLED" };
    const unattendedOptions = (extra: Partial<CliOptions> = {}, flags: string[] = []): Partial<CliOptions> => ({
      ...parseArgs(["--unattended", "--snapshot-file", SNAPSHOT, ...flags]),
      progressFile: PROGRESS,
      ...extra,
    });
    /** n never-stored bills, BILLS-119hr<from> first. */
    const seedMissing = (world: World, n: number, from = 8000): string[] => {
      const entries = Array.from({ length: n }, (_, index) =>
        entry(`BILLS-119hr${from + index}`, "missing", "2026-10-10", listRow("hr", from + index, "2026-10-10")),
      );
      world.files.set(SNAPSHOT, snapshotText(entries));
      return entries.map((each) => each.guid);
    };

    it("needs --snapshot-file, sends 300 an hour by default (at most 400), and takes no window option", () => {
      expect(parseArgs(["--unattended", "--snapshot-file", "s.tsv"])).toEqual({
        ...parseArgs(["--snapshot-file", "s.tsv"]),
        unattended: true,
        perHour: 300,
        maxSummariesFromForecast: true,
      });
      expect([UNATTENDED_DEFAULT_PER_HOUR, UNATTENDED_MAX_PER_HOUR, UNATTENDED_DEFAULT_LIMIT]).toEqual([
        300, 400, 3_000,
      ]);
      const given = parseArgs([
        "--snapshot-file",
        "s.tsv",
        "--per-hour",
        "400",
        "--max-summaries",
        "12",
        "--unattended",
      ]);
      expect(given).toMatchObject({ unattended: true, perHour: 400, maxSummaries: 12 });
      expect(given.maxSummariesFromForecast).toBeUndefined();
      expect(() => parseArgs(["--unattended"])).toThrow(
        "--unattended is the REL-56 backfill's: it needs --snapshot-file",
      );
      expect(() => parseArgs(["--unattended", "--snapshot-file", "s.tsv", "--per-hour", "401"])).toThrow(
        "--unattended sends at most 400 bills an hour",
      );
      expect(() => parseArgs(["--window-minutes", "90", "--unattended", "--snapshot-file", "s.tsv"])).toThrow(
        "--window-minutes is a quiet window's",
      );
      expect(effectiveLimit({ limit: null, unattended: true })).toBe(3_000);
      expect(effectiveLimit({ limit: 7, unattended: true })).toBe(7);
      expect(sendIntervalMs(300)).toBe(12_000);
      expect(estimateRun(7_000, { perHour: 300, limit: null, windowMinutes: 100, unattended: true })).toMatchObject({
        hours: 23.3,
        batchPerWindow: 3_000,
        windows: 3,
      });
    });

    it("dry run: checks that no window is open and that NotificationType skips, and plans runs, not windows", async () => {
      const world = newWorld(OUTSIDE_WINDOW);
      seedSnapshot(world);
      const { result, text } = await run(world, unattendedOptions());
      expect(result).toMatchObject({ exitCode: 0, outcome: "dry_run", eligible: 3 });
      expect(text).toContain("refetch:stale-bills mode=DRY-RUN selection=snapshot unattended=true snapshot=");
      expect(text).toContain(
        "ok    no quiet window open (unattended, RUNBOOK 16.1): NotificationTypeQueue mapping esm-nt Enabled; " +
          "poller rule BillsApiPollerSchedule ENABLED",
      );
      expect(text).toContain(
        "ok    NotificationType skips the backfill's pushes (REL-56): NotificationType:prod BACKFILL_PUSH_MODE=skip",
      );
      expect(text).toContain("ok    member vote carry on (X7)");
      expect(text).not.toContain("quiet window open (RUNBOOK 4.1)");
      expect(text).toContain(
        "Refetch plan: mode=snapshot unattended=true missing=1 stale=2 fetched_since=2 already_sent=0 to_send=3 " +
          "unsendable=1 unreadable=0 first_summaries=1 titles_differ=2 titles_govinfo=0 resummaries_likely=2 " +
          "max_summaries=7 calls=24 hours=0 runs=1",
      );
      expect(world.sends).toEqual([]);
      expect(world.fileWrites).toEqual([]);
    });

    it.each<[string, Partial<World>, string]>([
      [
        "NotificationType still pushing the backfill's changes",
        { pushMode: "push" },
        "NotificationType:prod BACKFILL_PUSH_MODE=push; the backfill's changes would push",
      ],
      [
        "NotificationType without the switch",
        { pushMode: null },
        "NotificationType:prod has no BACKFILL_PUSH_MODE (the skip is not deployed)",
      ],
      [
        "a quiet window open: the poller rule off",
        { ruleState: "DISABLED" },
        "poller rule BillsApiPollerSchedule DISABLED",
      ],
      [
        "a quiet window open: the NotificationType mapping off",
        { esmState: "Disabled" },
        "NotificationTypeQueue mapping esm-nt Disabled",
      ],
      ["member vote carry in watch", { carryMode: "watch" }, "MEMBER_VOTE_CARRY_MODE=watch; flip it to on first (X7)"],
      ["a message in an ingest DLQ", { dlq: { UpdatedBillsDLQ: 1 } }, "UpdatedBillsDLQ=1"],
      [
        "the 2026-12-28 freeze",
        { t: Date.parse("2026-12-28T00:00:00.000Z") },
        "2026-12-28T00:00:00.000Z is on or after 2026-12-28T00:00:00.000Z",
      ],
      ["the AWS CLI failing", { cliError: "aws: command not found" }, "check failed: aws: command not found"],
    ])("refuses --apply with exit 2 before reading or sending anything: %s", async (_name, overrides, detail) => {
      const world = newWorld({ ...OUTSIDE_WINDOW, ...overrides });
      seedSnapshot(world);
      const { result, text } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ exitCode: 2, outcome: "refused", scan: null, sentGuids: [] });
      expect(text).toContain(detail);
      expect(text).toContain("Refused: a precondition failed; nothing was sent.");
      expect(world.sends).toEqual([]);
      expect(world.fileWrites).toEqual([]);
      expect(s3Commands()).toEqual([]);
    });

    it("--apply sends outside a window, 300 an hour, with rel56 ids, and records each send", async () => {
      const world = newWorld(OUTSIDE_WINDOW);
      const snapshot = seedSnapshot(world);
      const { result, text } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ exitCode: 0, outcome: "done", sentGuids: SELECTED, maxSummaries: 7 });
      expect(world.sends.map((send) => send.correlationId)).toEqual(
        SELECTED.map((guid) => `rel56:2026-10-20T12:00:00.000Z:${guid}`),
      );
      // 12 s apart; the first check's UserMatcher query polls once (a second on the fake clock) before the first send.
      expect(world.sends.map((send) => send.at - START)).toEqual([1_000, 13_000, 25_000]);
      expect(progressGuids(world)).toEqual(SELECTED);
      expect(parseProgress(world.files.get(PROGRESS)!)).toMatchObject({
        mode: "snapshot",
        snapshotSha256: snapshot.sha256,
      });
      expect(text).toContain(
        "Sending 3 of 3 bills to https://sqs.us-east-1.amazonaws.com/123456789012/UpdatedBillsQueue, one every 12 s, " +
          "until 2026-12-28T00:00:00.000Z, without a quiet window (BACKFILL_PUSH_MODE=skip).",
      );
      expect(text).toContain(
        "Refetch summary: mode=APPLY selection=snapshot unattended=true outcome=done selected=3 already_sent=0 " +
          "eligible=3 sent=3 remaining=0 unsendable=1 unreadable=0 missing=1 missing_sent=1 fetched_since=2 " +
          "fetched_since_run=0 max_summaries=7",
      );
      expect(text).toContain("Next: there is no window to close");
      expect(world.cliCalls.every((args) => READ_ONLY_CLI.has(args[1]))).toBe(true);
      // Every check also asked UserMatcher's logs for a backfill change.
      expect(world.logsQueries.length).toBeGreaterThan(0);
      expect(world.logsQueries.every((query) => query.group === "/aws/lambda/UserMatcher")).toBe(true);
      expect(world.logsQueries[0].query).toBe(BACKFILL_PUSHES_QUERY);
    });

    it("has no window time: a run goes on past 110 minutes until its bills are sent", async () => {
      const world = newWorld(OUTSIDE_WINDOW);
      seedMissing(world, 30);
      const { result } = await run(world, unattendedOptions({ apply: true, perHour: 12 }));
      expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
      expect(world.sends).toHaveLength(30);
      expect(world.sends[29].at - START).toBe(29 * 5 * 60_000 + LOGS_QUERY_POLL_MS);
    });

    it("sends at most --limit bills a run (3,000 by default), and the next run sends the rest", async () => {
      const world = newWorld(OUTSIDE_WINDOW);
      const guids = seedMissing(world, 6);
      const first = await run(world, unattendedOptions({ apply: true, limit: 4 }));
      expect(first.result).toMatchObject({ outcome: "batch_limit", sentGuids: guids.slice(0, 4) });
      expect(first.text).toContain("This run's bills are sent; the same command sends the next run.");
      const second = await run(world, unattendedOptions({ apply: true, limit: 4 }));
      expect(second.result).toMatchObject({ outcome: "done", alreadySent: 4, sentGuids: guids.slice(4) });
    });

    it("sends nothing from 2026-12-28T00:00Z", async () => {
      const world = newWorld({ ...OUTSIDE_WINDOW, t: Date.parse("2026-12-27T23:59:00.000Z") });
      seedMissing(world, 30);
      const { result, text } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ exitCode: 0, outcome: "deadline" });
      // One every 12 s for the minute before midnight: 5 sends, none at or after it.
      expect(world.sends).toHaveLength(5);
      expect(world.sends.every((send) => send.at < Date.parse("2026-12-28T00:00:00.000Z"))).toBe(true);
      expect(text).toContain("2026-12-28T00:00:00.000Z is reached: nothing is sent from then (RUNBOOK 24.1)");
    });

    it("pauses while UpdatedBillsQueue or BillSummarizerQueue holds --max-backlog messages", async () => {
      const world = newWorld({ ...OUTSIDE_WINDOW, backlog: [0, 25, 0], summarizerBacklog: [30, 0] });
      seedMissing(world, 4);
      const { result, text } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ outcome: "done" });
      expect(world.sends).toHaveLength(4);
      expect(text).toContain("UpdatedBillsQueue holds 0 and BillSummarizerQueue 30 messages; pausing 30 s.");
      expect(text).toContain("UpdatedBillsQueue holds 25 and BillSummarizerQueue 0 messages; pausing 30 s.");
      // Two pauses, and three checks of one Logs Insights poll each.
      expect(world.sends[0].at).toBe(START + 2 * BACKLOG_WAIT_MS + 3 * LOGS_QUERY_POLL_MS);
    });

    it("caps re-summaries at the run's resummaries_likely + 5 (D5), or at --max-summaries when given", async () => {
      const world = newWorld(OUTSIDE_WINDOW);
      seedSnapshot(world);
      const auto = await run(world, unattendedOptions({ apply: true, limit: 2 }));
      // The run's 2 bills: the never-stored one (a first summary, D3) and one stale one likely re-summarized.
      expect(auto.text).toContain("--max-summaries 6: this run's resummaries_likely 1 + 5 (RUNBOOK 16.1, D5).");
      expect(auto.result.maxSummaries).toBe(6);

      mockS3 = new FakeVersionedS3();
      const other = newWorld(OUTSIDE_WINDOW);
      seedSnapshot(other);
      const given = await run(other, unattendedOptions({ apply: true }, ["--max-summaries", "40"]));
      expect(given.result.maxSummaries).toBe(40);
      expect(given.text).toContain(
        "--max-summaries 40 (given); this run's resummaries_likely is 2 (RUNBOOK 16.1, D5).",
      );
      expect(given.text).not.toContain("held as the run goes");
    });

    /**
     * n stale bills, BILLS-119s6000 first, each with text and the stored title. `flagged(index)` picks the ones
     * resummaryLikely flags: their newest text version is older than the row's action (the others' is newer). Each
     * send makes one BillDiffer pass with the send's rel56 id when `resummarized(index)`: a re-summary (text_changed).
     */
    const resummaryWorld = (
      n: number,
      flagged: (index: number) => boolean,
      resummarized: (index: number) => boolean,
    ): World => {
      const entries: SnapshotEntry[] = [];
      for (let index = 0; index < n; index += 1) {
        const guid = `BILLS-119s${6000 + index}`;
        mockS3.put(`raw-bills/${guid}.json`, {
          ...rawBill(guid, "2026-09-01T00:00:00.000Z"),
          content: {
            bill: { bill: { title: "Content title" } },
            text: { textVersions: [{ date: flagged(index) ? "2026-05-01T04:00:00Z" : "2026-10-20T04:00:00Z" }] },
            billXML: "<bill/>",
          },
        });
        entries.push(
          entry(guid, "stale", "2026-10-16", listRow("s", 6000 + index, "2026-10-16", { title: `Title of ${guid}` })),
        );
      }
      const world: World = newWorld({
        ...OUTSIDE_WINDOW,
        onSend: (sent) => {
          const last = world.sends[sent - 1];
          if (!resummarized(Number(last.body.guid.slice("BILLS-119s".length)) - 6000)) return;
          world.metrics.differEnqueued = (world.metrics.differEnqueued ?? 0) + 1;
          world.enqueuedDiffs.push({
            key: `raw-bills/${last.body.guid}.json`,
            awsRequestId: `r-${last.body.guid}`,
            reason: "text_changed",
            correlationId: last.correlationId,
          });
        },
      });
      world.files.set(SNAPSHOT, snapshotText(entries));
      return world;
    };

    it("holds the D5 cap to the bills sent so far: an anomaly the forecast cannot see stops within a few checks", async () => {
      // 10 unflagged stale bills first, then 30 flagged: the run's cap is 30 + 5. A misread anchor re-summarizes every
      // bill, the unflagged ones too.
      const world = resummaryWorld(
        40,
        (index) => index >= 10,
        () => true,
      );
      const { result, text } = await run(world, unattendedOptions({ apply: true }));
      expect(text).toContain("--max-summaries 35: this run's resummaries_likely 30 + 5 (RUNBOOK 16.1, D5).");
      expect(text).toContain(
        "The cap is held as the run goes (D5 b for the bills sent so far): at each check, at most the bills sent so " +
          "far that resummaries_likely flags, plus 5; 35 once every bill is sent.",
      );
      expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_too_many_summaries", maxSummaries: 35 });
      expect(result.stop!.detail).toMatch(
        /^10 bills the backfill sent were re-summarized since the start \(limit 5: the 0 bills sent so far that resummaries_likely flags, plus 5, D5 b\): /,
      );
      // Checks a minute apart, 5 sends a minute: 5 re-summaries at the second check (not above 5), 10 at the third.
      // A run-wide cap of 35 would have let 36 go through first.
      expect(world.sends).toHaveLength(10);
      expect(world.checkTimes.length).toBeLessThanOrEqual(3);
      expect(text).toContain(
        "Refetch summary: mode=APPLY selection=snapshot unattended=true outcome=stopped_too_many_summaries",
      );
      expect(text).toContain("max_summaries=35");
    });

    it("lets the re-summaries the forecast flags through as their bills go out, an earlier run's tail as well", async () => {
      // Every bill flagged, every other one re-summarized (the forecast errs high, D5), an earlier run's last 4
      // re-summaries landing after this run's start, and 40 passes of the poller's own, so the logs are read at
      // every check.
      const world = resummaryWorld(
        20,
        () => true,
        (index) => index % 2 === 0,
      );
      world.metrics.differEnqueued = 44;
      for (let index = 0; index < 4; index += 1) {
        world.enqueuedDiffs.push({
          key: `raw-bills/BILLS-119s${7000 + index}.json`,
          awsRequestId: `tail-${index}`,
          reason: "text_changed",
          correlationId: `rel56:2026-10-20T02:00:00.000Z:BILLS-119s${7000 + index}`,
        });
      }
      for (let index = 0; index < 40; index += 1) {
        world.enqueuedDiffs.push({
          key: `raw-bills/BILLS-119hres${index}.json`,
          awsRequestId: `p-${index}`,
          reason: "text_changed",
          correlationId: `2026-10-20T11:48:00.000Z:BILLS-119hres${index}`,
        });
      }
      const { result, lines } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ exitCode: 0, outcome: "done", stop: null, maxSummaries: 25 });
      expect(world.sends).toHaveLength(20);
      // Before the first send: the tail's 4 against 0 + 5.
      expect(lines).toContain(
        "BillDifferEnqueued=44 is above --max-summaries 5, but it counts every pass, the poller's too: the backfill " +
          "re-summarized 4 bills (BillDiffer's logs, rel56: ids, first summaries not counted, D3), within the limit.",
      );
      // The last look after the final send: 4 + 10 re-summaries against 20 + 5.
      expect(lines).toContain(
        "BillDifferEnqueued=54 is above --max-summaries 25, but it counts every pass, the poller's too: the backfill " +
          "re-summarized 14 bills (BillDiffer's logs, rel56: ids, first summaries not counted, D3), within the limit.",
      );
    });

    it("counts only the backfill's re-summaries: not the poller's passes, and not first summaries (D3)", async () => {
      expect(BACKFILL_RESUMMARIES_QUERY).toBe(
        'filter message = "Diffed raw bill" and outcome = "enqueued" and correlationId like /^rel56:/\n' +
          '| filter isblank(reason) or reason != "no_processed"\n' +
          "| stats count(*) as lines by key, awsRequestId, reason\n" +
          "| limit 10000",
      );
      // 12 stale bills first, then 30 never-stored ones; each send makes one BillDiffer pass with its id. The poller
      // re-summarizes 40 bills of its own meanwhile.
      const entries: SnapshotEntry[] = [];
      for (let index = 0; index < 12; index += 1) {
        put(`BILLS-119s${9000 + index}`, "2026-09-01T00:00:00.000Z");
        entries.push(
          entry(`BILLS-119s${9000 + index}`, "stale", "2026-10-09", listRow("s", 9000 + index, "2026-10-09")),
        );
      }
      for (let index = 0; index < 30; index += 1) {
        entries.push(
          entry(`BILLS-119hr${9100 + index}`, "missing", "2026-10-10", listRow("hr", 9100 + index, "2026-10-10")),
        );
      }
      const world: World = newWorld({
        ...OUTSIDE_WINDOW,
        onSend: (sent) => {
          const last = world.sends[world.sends.length - 1];
          world.metrics.differEnqueued = (world.metrics.differEnqueued ?? 0) + 1;
          world.enqueuedDiffs.push({
            key: `raw-bills/${last.body.guid}.json`,
            awsRequestId: `r-${last.body.guid}`,
            reason: last.body.guid.startsWith("BILLS-119s") ? "text_changed" : "no_processed",
            correlationId: last.correlationId,
          });
          if (sent === 1) {
            world.metrics.differEnqueued += 40;
            for (let index = 0; index < 40; index += 1) {
              world.enqueuedDiffs.push({
                key: `raw-bills/BILLS-119hres${index}.json`,
                awsRequestId: `p-${index}`,
                reason: "text_changed",
                correlationId: `2026-10-20T12:03:39.000Z:BILLS-119hres${index}`,
              });
            }
          }
        },
      });
      world.files.set(SNAPSHOT, snapshotText(entries));
      const { result, lines } = await run(world, unattendedOptions({ apply: true }, ["--max-summaries", "10"]));
      // Checks a minute apart, 5 sends a minute: 10 re-summaries at 2 minutes (within the cap), 12 at 3.
      expect(result).toMatchObject({ exitCode: 2, outcome: "stopped_too_many_summaries" });
      expect(result.stop!.detail).toBe(
        "12 bills the backfill sent were re-summarized since the start (limit 10): the distinct keys of BillDiffer's " +
          '"Diffed raw bill" lines with outcome enqueued, a rel56: correlation id and a reason other than no_processed ' +
          "(first summaries do not count, D3; the poller's passes are not the backfill's). BillDifferEnqueued=55 counts " +
          "every pass",
      );
      expect(world.sends).toHaveLength(15);
      expect(lines).toContain(
        "BillDifferEnqueued=50 is above --max-summaries 10, but it counts every pass, the poller's too: the backfill " +
          "re-summarized 10 bills (BillDiffer's logs, rel56: ids, first summaries not counted, D3), within the limit.",
      );
      expect(world.logsQueries.filter((query) => query.group === "/aws/lambda/BillDiffer")[0].query).toBe(
        BACKFILL_RESUMMARIES_QUERY,
      );
      expect(
        countBackfillResummaries(7, [
          { key: "raw-bills/BILLS-119s1.json", requestId: "a", reason: "text_changed" },
          { key: "raw-bills/BILLS-119s1.json", requestId: "b", reason: "text_changed" },
          { key: null, requestId: "c", reason: null },
        ]),
      ).toEqual({ passes: 7, inLogs: 2, unseen: 0, bills: 2, backfillOnly: true });
    });

    it.each<[string, (world: World) => void, string, string]>([
      ["a DLQ message", (world) => (world.dlq.UpdatedBillsDLQ = 1), "dlq_message", "UpdatedBillsDLQ=1"],
      [
        "FetchRawBill errors",
        (world) => (world.metrics.fetchRawBillErrors = 1),
        "fetch_errors",
        "FetchRawBill Errors=1",
      ],
      [
        "a FetchRawBill record failure that is not congress.gov's (REL-58)",
        (world) => (world.metrics.recordFailedOther = 1),
        "fetch_errors",
        "FetchRawBillRecordFailed{Kind=other}=1 since the start",
      ],
      [
        "10 FetchRawBill records failed on congress.gov (REL-58)",
        (world) => (world.metrics.recordFailedUnavailable = 10),
        "fetch_errors",
        "FetchRawBillRecordFailed{Kind=unavailable}=10 since the start",
      ],
      ["a congress.gov 429", (world) => (world.metrics.congressApi429 = 1), "congress_key_errors", "CongressApi429=1"],
      [
        "a congress.gov key refusal",
        (world) => (world.metrics.congressApiAuthFailures = 1),
        "congress_key_errors",
        "CongressApiAuthFailure=1",
      ],
      [
        "a bill stored without text",
        (world) => (world.metrics.billTextUnavailable = 1),
        "text_unavailable",
        "BillTextUnavailable=1 since the start",
      ],
      [
        "NotificationType switched to push",
        (world) => (world.pushMode = "push"),
        "push_mode_changed",
        "NotificationType:prod BACKFILL_PUSH_MODE=push",
      ],
      [
        "NotificationType rolled back past the switch",
        (world) => (world.pushMode = null),
        "push_mode_changed",
        "NotificationType:prod BACKFILL_PUSH_MODE=unset",
      ],
      [
        "a backfill change handed to UserMatcher",
        (world) => (world.userMatcherBackfillLines = 2),
        "backfill_push_sent",
        "2 UserMatcher log lines with a rel56: correlation id since the start",
      ],
      [
        "the member vote carry switched to watch",
        (world) => (world.carryMode = "watch"),
        "carry_mode_changed",
        "FetchRawBill:prod MEMBER_VOTE_CARRY_MODE=watch",
      ],
      [
        "a quiet window opened: the poller rule off",
        (world) => (world.ruleState = "DISABLED"),
        "window_opened",
        "poller rule BillsApiPollerSchedule DISABLED",
      ],
      [
        "a quiet window opened: the NotificationType mapping off",
        (world) => (world.esmState = "Disabled"),
        "window_opened",
        "mapping esm-nt Disabled",
      ],
    ])("stops mid-run with exit 2 on %s, its progress file complete", async (_name, breakIt, reason, detail) => {
      const world = newWorld({ ...OUTSIDE_WINDOW, onSend: (sent) => sent === 3 && breakIt(world) });
      seedMissing(world, 20);
      const { result, errors, text } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ exitCode: 2, outcome: `stopped_${reason}`, stop: { reason } });
      expect(result.stop!.detail).toContain(detail);
      expect(world.sends.length).toBeGreaterThanOrEqual(3);
      expect(world.sends.every((send) => send.at < START + CHECK_INTERVAL_MS)).toBe(true);
      expect(progressGuids(world)).toEqual(world.sends.map((send) => send.body.guid));
      expect(errors.join("\n")).toContain(`Stopped: ${reason}`);
      expect(text).toMatch(/\nResume: /);
    });

    // REL-58's rule, as in a window's run: a record failure stops the run only when it is not congress.gov's, or at
    // MAX_UNAVAILABLE_RECORD_FAILURES; the poller's records count too, and a blip they ride out does not stop it.
    it("goes on through a congress.gov blip, as a window's run does: 9 record failures since the start", async () => {
      const world = newWorld({
        ...OUTSIDE_WINDOW,
        metrics: { recordFailedUnavailable: MAX_UNAVAILABLE_RECORD_FAILURES - 1 },
      });
      seedMissing(world, 3);
      const { result } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ exitCode: 0, outcome: "done" });
      expect(world.sends).toHaveLength(3);
    });

    it(`tries a check that cannot run ${UNATTENDED_CHECK_ATTEMPTS} times, 30 s apart, before it stops`, async () => {
      expect(CHECK_RETRY_WAIT_MS).toBe(30_000);
      // A blip: the metrics read fails twice, then answers.
      const blip: World = newWorld({
        ...OUTSIDE_WINDOW,
        onSend: (sent) => sent === 1 && (blip.metricsFailuresLeft = 2),
      });
      seedMissing(blip, 10);
      const ok = await run(blip, unattendedOptions({ apply: true }));
      expect(ok.result).toMatchObject({ exitCode: 0, outcome: "done" });
      expect(blip.sends).toHaveLength(10);
      expect(ok.lines.filter((line) => line.startsWith("A check could not run"))).toEqual([
        "A check could not run (Throttling); trying again in 30 s (attempt 1 of 3).",
        "A check could not run (Throttling); trying again in 30 s (attempt 2 of 3).",
      ]);

      // Still failing on the third: the run stops, and the same command resumes it.
      mockS3 = new FakeVersionedS3();
      const down: World = newWorld({
        ...OUTSIDE_WINDOW,
        onSend: (sent) => sent === 1 && (down.metricsError = "ExpiredToken"),
      });
      seedMissing(down, 10);
      const stopped = await run(down, unattendedOptions({ apply: true }));
      expect(stopped.result).toMatchObject({ exitCode: 2, outcome: "stopped_check_failed" });
      expect(stopped.lines.filter((line) => line.startsWith("A check could not run"))).toHaveLength(2);
      expect(progressGuids(down)).toEqual(down.sends.map((send) => send.body.guid));
      expect(stopped.text).toContain(
        "Resume: fix what the check needs (an expired AWS login, the network), then run the same command",
      );
    });

    it("stops on Ctrl-C after the send in hand, and the same command resumes with the rest", async () => {
      const world = newWorld(OUTSIDE_WINDOW);
      const guids = seedMissing(world, 8);
      let interrupted = false;
      world.onSend = (sent) => {
        if (sent === 3) interrupted = true;
      };
      const first = await run(world, unattendedOptions({ apply: true }), { interrupted: () => interrupted });
      expect(first.result).toMatchObject({ exitCode: 2, outcome: "interrupted", sentGuids: guids.slice(0, 3) });
      expect(progressGuids(world)).toEqual(guids.slice(0, 3));
      expect(first.text).toContain("Resume: run the same command; the progress file lists every bill sent.");

      interrupted = false;
      world.onSend = () => undefined;
      world.sends.length = 0;
      const second = await run(world, unattendedOptions({ apply: true }), { interrupted: () => interrupted });
      expect(second.result).toMatchObject({ exitCode: 0, outcome: "done", alreadySent: 3, sentGuids: guids.slice(3) });
      expect(progressGuids(world)).toEqual(guids);
    });

    describe("Ctrl-C under npm run (installStopSignals)", () => {
      /** A process whose signal listeners stay (process.on) and whose exit is recorded. */
      const fakeProcess = () => {
        const listeners = new Map<NodeJS.Signals, Array<(signal: NodeJS.Signals) => void>>();
        const exits: number[] = [];
        return {
          exits,
          proc: {
            on: (signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void) => {
              listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
            },
            exit: (code: number) => {
              exits.push(code);
            },
          },
          fire: (signal: NodeJS.Signals) => (listeners.get(signal) ?? []).forEach((listener) => listener(signal)),
        };
      };

      it("takes npm's forwarded copy of one Ctrl-C for the same press, and quits at once on a later press", () => {
        expect(REPEAT_SIGNAL_MS).toBe(1_000);
        const fake = fakeProcess();
        const errors: string[] = [];
        let t = 50_000;
        const interrupted = installStopSignals(
          fake.proc,
          () => t,
          (...args: unknown[]) => errors.push(args.map(String).join(" ")),
        );
        expect(interrupted()).toBe(false);
        // One Ctrl-C under `npm run`: the terminal's SIGINT, then npm's copy 5 ms later.
        fake.fire("SIGINT");
        t += 5;
        fake.fire("SIGINT");
        expect(interrupted()).toBe(true);
        expect(fake.exits).toEqual([]);
        expect(errors).toEqual([
          "SIGINT: stopping after the send in hand (the same command resumes); Ctrl-C again, a second or more " +
            "later, quits at once.",
        ]);
        // A second press, 2 s later: its first copy quits.
        t += 2_000;
        fake.fire("SIGINT");
        expect(fake.exits).toEqual([130]);
        expect(errors[1]).toBe(
          "SIGINT again: quitting at once. A bill sent but not in the progress file yet is sent again on the resume.",
        );
      });

      it("does the same for SIGTERM, and a press within a second of the last one that counted is the same press", () => {
        const fake = fakeProcess();
        let t = 0;
        const interrupted = installStopSignals(
          fake.proc,
          () => t,
          () => undefined,
        );
        fake.fire("SIGTERM");
        t = 400;
        fake.fire("SIGTERM");
        t = 999;
        fake.fire("SIGTERM");
        expect(interrupted()).toBe(true);
        expect(fake.exits).toEqual([]);
        t = 1_000;
        fake.fire("SIGTERM");
        expect(fake.exits).toEqual([143]);
      });

      it("counts another signal as another press", () => {
        const fake = fakeProcess();
        let t = 0;
        installStopSignals(
          fake.proc,
          () => t,
          () => undefined,
        );
        fake.fire("SIGINT");
        t = 10;
        fake.fire("SIGTERM");
        expect(fake.exits).toEqual([143]);
      });
    });

    it("skips a bill stored since the snapshot, read just before its send, without spending its slot", async () => {
      const world = newWorld(OUTSIDE_WINDOW);
      const guids = seedMissing(world, 4);
      // The poller stores the second bill while the run goes on.
      world.onSend = (sent) => {
        if (sent === 1) {
          mockS3.putAt(
            `raw-bills/${guids[1]}.json`,
            rawBill(guids[1], "2026-10-20T12:00:05.000Z"),
            "2026-10-20T12:00:06.000Z",
          );
        }
      };
      // A read that fails sends the bill all the same: a refetch is safe.
      const send = mockS3.send.bind(mockS3);
      jest.spyOn(mockS3, "send").mockImplementation(async (command) => {
        if (command.__cmd === "HeadObject" && command.input.Key === `raw-bills/${guids[3]}.json`) {
          throw Object.assign(new Error("Please reduce your request rate."), {
            name: "SlowDown",
            $metadata: { httpStatusCode: 503 },
          });
        }
        return send(command);
      });
      const { result, text } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ outcome: "done", sentGuids: [guids[0], guids[2], guids[3]] });
      expect(result.skippedSinceSnapshot).toEqual([guids[1]]);
      expect(world.sends[1].at - world.sends[0].at).toBe(12_000);
      expect(progressGuids(world)).toEqual([guids[0], guids[2], guids[3]]);
      expect(text).toContain(
        `${guids[1]}: stored at 2026-10-20T12:00:06.000Z, since the snapshot's listedAt; not sent (fetched_since_run)`,
      );
      expect(text).toContain(
        `Could not read raw-bills/${guids[3]}.json before its send (Please reduce your request rate.)`,
      );
      expect(text).toContain("fetched_since_run=1");
      // Read just before each send (the failed read never reached the fake store).
      expect(mockS3.commands("HeadObject").map((command) => command.input.Key)).toEqual(
        guids.slice(0, 3).map((guid) => `raw-bills/${guid}.json`),
      );
    });

    it("sends nothing on Sundays from 09:30 to 11:00 New York time (the weekly digest, 11.4)", async () => {
      // Sunday 2026-11-22: 09:29 EST is 14:29Z, and the slot is 14:30Z to 16:00Z.
      const slotStart = Date.parse("2026-11-22T14:30:00.000Z");
      const slotEnd = Date.parse("2026-11-22T16:00:00.000Z");
      const world = newWorld({ ...OUTSIDE_WINDOW, t: Date.parse("2026-11-22T14:29:00.000Z") });
      seedMissing(world, 10);
      const { result, text } = await run(world, unattendedOptions({ apply: true }));
      expect(result).toMatchObject({ outcome: "done" });
      expect(world.sends.filter((send) => send.at < slotStart)).toHaveLength(5);
      expect(world.sends.filter((send) => send.at >= slotStart && send.at < slotEnd)).toEqual([]);
      expect(world.sends[5].at).toBe(slotEnd);
      expect(text).toContain(
        "Sunday 09:30 to 11:00 New York time (the weekly digest, RUNBOOK 11.4): pausing until 2026-11-22T16:00:00.000Z.",
      );
      expect(weeklyDigestPauseEnd(new Date(slotStart))).toEqual(new Date(slotEnd));
      expect(weeklyDigestPauseEnd(new Date("2026-11-22T15:59:59.500Z"))).toEqual(new Date(slotEnd));
      expect(weeklyDigestPauseEnd(new Date(slotEnd))).toBeNull();
      expect(weeklyDigestPauseEnd(new Date("2026-11-22T14:29:59.999Z"))).toBeNull();
      expect(weeklyDigestPauseEnd(new Date("2026-11-21T14:30:00.000Z"))).toBeNull(); // a Saturday
      // Summer time: Sunday 2026-06-07 09:30 EDT is 13:30Z.
      expect(weeklyDigestPauseEnd(new Date("2026-06-07T13:30:00.000Z"))).toEqual(new Date("2026-06-07T15:00:00.000Z"));
    });

    it("leaves window mode as it was: no push-mode read, no UserMatcher query, no read before a send", async () => {
      const world = newWorld(); // a window open
      seedSnapshot(world);
      const { result, text } = await run(world, { snapshotFile: SNAPSHOT, apply: true });
      expect(result).toMatchObject({ outcome: "done", sentGuids: SELECTED });
      expect(world.cliCalls.some((args) => args.includes("NotificationType:prod"))).toBe(false);
      expect(world.logsQueries).toEqual([]);
      expect(s3Commands()).not.toContain("HeadObject");
      expect(text).toContain("ok    quiet window open (RUNBOOK 4.1)");
      expect(text).not.toContain("unattended");
      expect(world.sends.map((send) => send.at - START)).toEqual([0, 7_200, 14_400]);

      // And it still refuses outside a window.
      mockS3 = new FakeVersionedS3();
      const outside = newWorld(OUTSIDE_WINDOW);
      seedSnapshot(outside);
      expect((await run(outside, { snapshotFile: SNAPSHOT, apply: true })).result.outcome).toBe("refused");
    });
  });
});
