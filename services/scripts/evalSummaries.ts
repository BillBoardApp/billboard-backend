/**
 * Evaluation harness for the bill summarizer (LLM-11, REL-40).
 *
 * Runs a fixed, stratified set of bills from the bill store through production's code for each arm (a model and an
 * effort): the prompts and request bodies (src/handlers/billSummarizer/prompts.ts), the Bedrock call
 * (invokeMessages in src/shared/bedrockMessages.ts) and, by default, the per-bill ladder of analyzeBill.ts (the
 * answer, one corrective call, the fit), so a bill ends as production would store it. It scores every bill-run and
 * every arm and checks the gates in scripts/eval/rubric.md. See scripts/eval/README.md.
 *
 * This calls Amazon Bedrock and costs money. It must never run in tests or CI: jest only collects src/tests, and the
 * script refuses to start when CI is set. Without --yes it is a dry run that reads the bills and prints the plan and
 * a cost estimate. --yes needs --max-usd, a hard cap checked before every call against that call's worst case. The
 * script only reads the bill store: it writes nothing to S3, SQS or DynamoDB.
 *
 *   npm run eval:summaries                                    # dry run
 *   npm run eval:summaries -- --yes --max-usd 1               # calls Bedrock
 *   npm run eval:summaries -- --report <dir> --report <dir>   # scores earlier results together, no calls
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { ProcessedBillDao } from "../src/adapters/processedBillDao";
import { RawBillDao } from "../src/adapters/rawBillDao";
import type { RawBill } from "../src/models/bill";
import { readProcessedSource, sourceTextHash } from "../src/shared/billSourceReconcile";
import {
  BedrockCallError,
  createBedrockClient,
  invokeMessages,
  type BedrockCallResult,
  type RequestProfile,
  type MessagesRequestBody,
} from "../src/shared/bedrockMessages";
import { mapWithConcurrency } from "../src/shared/concurrency";
import {
  analyzeBill,
  type AnalyzeBillResult,
  type SummarizerCallKind,
} from "../src/handlers/billSummarizer/analyzeBill";
import { extractBillText, BILL_TEXT_BUDGET_CHARS } from "../src/handlers/billSummarizer/billText";
import {
  buildBedrockRequestBody,
  extractMinimalBillInfo,
  extractReducedBillInfo,
  interpretModelOutput,
  type BedrockBillAnalysis,
  type MinimalBillInput,
  type SummarizerRequestOptions,
} from "../src/handlers/billSummarizer/prompts";
import {
  ANSWER_TOKENS_PER_BILL,
  BASELINE_ARM,
  SpendCap,
  flagValue,
  buildBlindReview,
  evaluateGates,
  expectedCall,
  longSoWhats,
  parseArm,
  parseBillsFile,
  parsePositiveInteger,
  parseUsd,
  pricesFromEnv,
  round,
  scoreAnalysis,
  summarizeArm,
  tagChanges,
  usageCostUsd,
  worstCaseCallUsd,
  type ArmSummary,
  type BillRunRecord,
  type CallRecord,
  type EvalArm,
  type EvalBillEntry,
  type GateResult,
  type GateSet,
  type TokenPrices,
} from "./eval/scoring";

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_BILLS_FILE = path.join(__dirname, "eval", "bills.json");
const DEFAULT_RESULTS_DIR = path.join(__dirname, "eval", "results");
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const BUCKET_NAME = process.env.BUCKET_NAME ?? "billboard-bill-store-bucket";
// Production's summarizer model (BILL_SUMMARIZER_MODEL in infra/lib/config/bedrock-models.ts) through the us.
// inference profile. A constant: after Deploy B, move it (and its test) to us.anthropic.claude-haiku-5-5:medium.
const DEFAULT_ARM = "us.anthropic.claude-haiku-4-5-20251001-v1:0:default";
// The summarizer's max_tokens (infra/lib/config/summarizer-service-constants.ts); Haiku 5.5's thinking counts toward it.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? "8192");
// For the estimate: the share of bills whose first answer needs a corrective call, which costs about as much as the
// first. Before the REL-40 targets, 37.8% of first answers broke a limit.
const CORRECTIVE_SHARE = 0.4;
const LOAD_CONCURRENCY = 8;
const REVIEW_BILLS = 30;

const SHORT_BILL_MAX_CHARS = 10_000;
const OMNIBUS_BILL_MIN_CHARS = 200_000;

// Errors Bedrock returns before the model runs, so nothing is billed. Any other failure is counted at its worst case.
const UNBILLED_ERRORS = new Set(["throttled", "invalid_request", "access_denied", "not_found"]);

// ── Options ──────────────────────────────────────────────────────────────────

export interface EvalArgs {
  help: boolean;
  yes: boolean;
  arms: EvalArm[];
  billsFile: string;
  /** Leaves out the bills of another list, e.g. the core E1 already ran. */
  excludeBillsFile: string | null;
  runsPerArm: number;
  batchSize: number;
  limit: number;
  maxUsd: number | null;
  writeBodies: string | null;
  baselineStored: boolean;
  emulateProduction: boolean;
  concurrency: number;
  out: string | null;
  gates: GateSet | null;
  reference: string | null;
  report: string[];
}

// One bill per call, as production calls (MAX_BILLS_PER_BATCH 1), with production's BEDROCK_CONCURRENCY.
export const DEFAULTS = { runsPerArm: 1, batchSize: 1, concurrency: 3 } as const;

// The options --report takes; it calls nothing, so every other option is a mistake.
const REPORT_OPTIONS = new Set(["--report", "--gates", "--reference", "--out"]);

export const parseArgs = (
  argv: readonly string[],
  defaults: { billsFile: string; arm: string } = { billsFile: DEFAULT_BILLS_FILE, arm: DEFAULT_ARM },
): EvalArgs => {
  const args: EvalArgs = {
    help: false,
    yes: false,
    arms: [],
    billsFile: defaults.billsFile,
    excludeBillsFile: null,
    runsPerArm: DEFAULTS.runsPerArm,
    batchSize: DEFAULTS.batchSize,
    limit: Number.POSITIVE_INFINITY,
    maxUsd: null,
    writeBodies: null,
    baselineStored: false,
    emulateProduction: true,
    concurrency: DEFAULTS.concurrency,
    out: null,
    gates: null,
    reference: null,
    report: [],
  };
  const armSpecs: string[] = [];
  const runOptions = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = flagValue(argv, i);
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg === "--arm") armSpecs.push(next());
    else if (arg === "--bills-file" || arg === "--bills") args.billsFile = path.resolve(next());
    else if (arg === "--exclude-bills") args.excludeBillsFile = path.resolve(next());
    else if (arg === "--runs-per-arm" || arg === "--runs") args.runsPerArm = parsePositiveInteger(next(), arg);
    else if (arg === "--batch-size") args.batchSize = parsePositiveInteger(next(), arg);
    else if (arg === "--limit") args.limit = parsePositiveInteger(next(), arg);
    else if (arg === "--max-usd") args.maxUsd = parseUsd(next(), arg);
    else if (arg === "--write-bodies") args.writeBodies = path.resolve(next());
    else if (arg === "--baseline-stored") args.baselineStored = true;
    else if (arg === "--emulate-production") args.emulateProduction = true;
    else if (arg === "--no-emulate-production") args.emulateProduction = false;
    else if (arg === "--concurrency") args.concurrency = parsePositiveInteger(next(), arg);
    else if (arg === "--out") args.out = path.resolve(next());
    else if (arg === "--reference") args.reference = next();
    else if (arg === "--report") args.report.push(path.resolve(next()));
    else if (arg === "--gates") {
      const value = next();
      if (value !== "e1" && value !== "e2") throw new Error(`--gates takes e1 or e2 (got ${value})`);
      args.gates = value;
    } else throw new Error(`Unknown argument: ${arg}`);
    if (!REPORT_OPTIONS.has(arg)) runOptions.add(arg);
  }
  if (args.help) return args;

  if (args.report.length > 0) {
    if (runOptions.size > 0) {
      throw new Error(`--report scores earlier results and calls nothing; drop ${[...runOptions].join(", ")}`);
    }
    return args;
  }
  args.arms = (armSpecs.length > 0 ? armSpecs : [defaults.arm]).map(parseArm);
  const names = args.arms.map((arm) => arm.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) throw new Error(`--arm ${repeated} is given twice`);
  if (args.writeBodies && args.yes) throw new Error("--write-bodies only writes the request bodies; drop --yes");
  if (args.yes && args.maxUsd === null) throw new Error("--yes needs --max-usd <dollars>, the most this run may spend");
  return args;
};

// ── Bills ────────────────────────────────────────────────────────────────────

export interface LoadedBill {
  entry: EvalBillEntry;
  chamber: "House" | "Senate" | "Unknown";
  party: string;
  partySource: "raw" | "bill list" | "unknown";
  size: "short" | "medium" | "omnibus";
  fullTextChars: number;
  raw: RawBill;
  input: MinimalBillInput;
}

const chamberOf = (guid: string): LoadedBill["chamber"] => {
  const match = guid.match(/^BILLS-\d+([a-z]+)\d+/i);
  const type = match?.[1]?.toLowerCase() ?? "";
  if (type.startsWith("h")) return "House";
  if (type.startsWith("s")) return "Senate";
  return "Unknown";
};

const sponsorPartyFromRaw = (raw: RawBill): string => {
  const content = raw.content as { bill?: { bill?: { sponsors?: Array<{ party?: unknown }> } } };
  const party = content?.bill?.bill?.sponsors?.[0]?.party;
  return typeof party === "string" ? party.trim().toUpperCase() : "";
};

const sizeOf = (fullTextChars: number): LoadedBill["size"] => {
  if (fullTextChars <= SHORT_BILL_MAX_CHARS) return "short";
  if (fullTextChars >= OMNIBUS_BILL_MIN_CHARS) return "omnibus";
  return "medium";
};

/** A raw bill as the eval uses it: production's model input, plus the strata measured from the bill itself. */
export const toLoadedBill = (entry: EvalBillEntry, raw: RawBill): LoadedBill => {
  const content = raw.content as Record<string, unknown>;
  const xml = String(content?.billXML ?? content?.billXml ?? "");
  const fullTextChars = extractBillText(xml, Number.MAX_SAFE_INTEGER).fullTextChars;
  const rawParty = sponsorPartyFromRaw(raw);
  const expectedParty = (entry.expectedParty ?? "").toUpperCase();
  return {
    entry,
    chamber: chamberOf(entry.guid),
    party: rawParty || expectedParty || "?",
    partySource: rawParty ? "raw" : expectedParty ? "bill list" : "unknown",
    size: sizeOf(fullTextChars),
    fullTextChars,
    raw,
    input: extractMinimalBillInfo(raw, BILL_TEXT_BUDGET_CHARS, entry.guid),
  };
};

/** The stored summary when it was written from the bill's current text; otherwise why it is not scored. */
type Baseline = { analysis: BedrockBillAnalysis } | { missing: "no processed bill" | "written from other text" };

const loadBills = async (
  entries: readonly EvalBillEntry[],
  withBaseline: boolean,
): Promise<{ loaded: Array<{ bill: LoadedBill; baseline: Baseline | null }>; problems: string[] }> => {
  const s3 = new S3Client({ region: REGION });
  const rawDao = new RawBillDao(s3, BUCKET_NAME);
  const processedDao = new ProcessedBillDao(s3, BUCKET_NAME);
  const problems: string[] = [];
  const results = await mapWithConcurrency(entries, LOAD_CONCURRENCY, async (entry) => {
    try {
      const raw = await rawDao.getByGuid(entry.guid);
      if (!raw) {
        problems.push(
          `${entry.guid}: not in s3://${BUCKET_NAME}/raw-bills/ (replace it with a bill from the same stratum)`,
        );
        return null;
      }
      const bill = toLoadedBill(entry, raw);
      if (!bill.input.hasText) {
        problems.push(`${entry.guid}: raw bill has no billXML yet (production skips it too)`);
        return null;
      }
      const rawParty = sponsorPartyFromRaw(raw);
      const expectedParty = (entry.expectedParty ?? "").toUpperCase();
      if (rawParty && expectedParty && rawParty !== expectedParty) {
        problems.push(
          `${entry.guid}: the bill list says party ${expectedParty}, raw sponsor data says ${rawParty} (using ${rawParty})`,
        );
      }
      if (!withBaseline) return { bill, baseline: null };
      const stored = await processedDao.getRevisionByGuid(entry.guid);
      const baseline: Baseline = !stored
        ? { missing: "no processed bill" }
        : readProcessedSource(stored.metadata)?.textHash === sourceTextHash(raw)
          ? { analysis: storedAnalysis(stored.bill) }
          : { missing: "written from other text" };
      return { bill, baseline };
    } catch (error) {
      problems.push(`${entry.guid}: could not be read (${(error as Error)?.message ?? error})`);
      return null;
    }
  });
  return { loaded: results.filter((result) => result !== null), problems };
};

const storedAnalysis = (stored: {
  guid: string;
  title: string;
  billBreakdown: BedrockBillAnalysis["billBreakdown"];
  soWhat: string;
  subCategories?: string[];
  lifeAreas?: string[];
  civicProfile?: BedrockBillAnalysis["civicProfile"];
}): BedrockBillAnalysis => ({
  guid: stored.guid,
  title: stored.title,
  billBreakdown: stored.billBreakdown,
  soWhat: stored.soWhat,
  subCategories: stored.subCategories ?? [],
  lifeAreas: stored.lifeAreas ?? [],
  ...(stored.civicProfile ? { civicProfile: stored.civicProfile } : {}),
});

const countBy = <T>(items: readonly T[], key: (item: T) => string): Record<string, number> =>
  items.reduce<Record<string, number>>((acc, item) => {
    acc[key(item)] = (acc[key(item)] ?? 0) + 1;
    return acc;
  }, {});

const printStrata = (bills: readonly LoadedBill[], entries: readonly EvalBillEntry[]): void => {
  console.log("Strata (measured from the bill store, not the bill list):");
  console.log(
    "  stratum:",
    countBy(bills, (b) => b.entry.stratum ?? ""),
  );
  console.log(
    "  chamber:",
    countBy(bills, (b) => b.chamber),
  );
  console.log(
    "  sponsor party:",
    countBy(bills, (b) => b.party),
  );
  console.log(
    "  size:",
    countBy(bills, (b) => b.size),
  );
  console.log("  text shortened for the model:", bills.filter((b) => !b.input.textComplete).length);
  const toVerify = entries.filter((entry) => entry.verify);
  if (toVerify.length > 0) {
    const found = new Set(bills.map((bill) => bill.entry.guid));
    const missing = toVerify.filter((entry) => !found.has(entry.guid)).map((entry) => entry.guid);
    console.log(
      `  "verify" entries: ${toVerify.length - missing.length} of ${toVerify.length} in the store with text${missing.length > 0 ? `; replace ${missing.join(", ")}` : ""} (check party warnings above)`,
    );
  }
};

// ── Calls ────────────────────────────────────────────────────────────────────

/** Where records go as they are made; a stopped run keeps what it paid for. */
export interface ResultSink {
  call(record: CallRecord): Promise<void>;
  bill(record: BillRunRecord): Promise<void>;
}

export interface EvalSession {
  client: Pick<BedrockRuntimeClient, "send">;
  cap: SpendCap;
  results: ResultSink;
  /** True: the per-bill ladder (corrective call, refusal retry). False: first answers only, fitted when over a limit. */
  emulateProduction: boolean;
  /** Set once a call would pass --max-usd: no further call starts. */
  stopped: boolean;
}

/** One arm in one run. */
export interface ArmRun {
  arm: EvalArm;
  run: number;
  request: SummarizerRequestOptions;
  prices: TokenPrices;
}

const summarizerRequest = (arm: EvalArm, maxTokens = MAX_OUTPUT_TOKENS): SummarizerRequestOptions => ({
  profile: arm.profile,
  effort: arm.effort,
  maxTokens,
});

export const armRun = (arm: EvalArm, run: number, prices: TokenPrices, maxTokens = MAX_OUTPUT_TOKENS): ArmRun => ({
  arm,
  run,
  request: summarizerRequest(arm, maxTokens),
  prices,
});

/** Thrown instead of a call that could take the run past --max-usd. */
class BudgetStop extends Error {
  constructor(cap: SpendCap) {
    super(`--max-usd ${cap.capUsd} reached ($${cap.spentUsd.toFixed(4)} spent)`);
    this.name = "BudgetStop";
  }
}

/** The calls one bill made, what they cost, and whether the cap stopped one. */
interface Tally {
  calls: number;
  costUsd: number;
  budgetStopped: boolean;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * One Bedrock call as production makes it (invokeMessages: one attempt per send, its throttle retries and
 * per-attempt deadline), after reserving the call's worst case against --max-usd. Each call is written to
 * calls.jsonl.
 */
const callBedrock = async (
  session: EvalSession,
  { arm, run, prices }: ArmRun,
  kind: string,
  body: MessagesRequestBody,
  guids: string[],
  tally: Tally,
): Promise<BedrockCallResult> => {
  const worstCase = worstCaseCallUsd(body, arm.profile, prices);
  if (session.stopped || !session.cap.tryReserve(worstCase)) {
    session.stopped = true;
    tally.budgetStopped = true;
    throw new BudgetStop(session.cap);
  }
  tally.calls += 1;
  const base = {
    run,
    arm: arm.name,
    modelId: arm.modelId,
    effort: arm.effort,
    kind,
    guids,
    bodySha256: sha256(JSON.stringify(body)),
    estimatedUsd: round(expectedCall(body, arm, prices, ANSWER_TOKENS_PER_BILL * guids.length).usd, 6) ?? 0,
  };
  let costUsd = 0;
  try {
    const result = await invokeMessages({
      client: session.client,
      modelId: arm.modelId,
      caller: "BillSummarizer",
      kind,
      body,
      // --max-usd reserves one attempt per call, and a retried attempt could have been billed with no
      // reservation. Throttles are free and keep their retries.
      maxTransientRetries: 0,
      maxModelTimeoutRetries: 0,
      logFields: { guids, arm: arm.name, run },
      emitMetrics: false,
    });
    costUsd = usageCostUsd(result.usage, prices) ?? worstCase;
    await session.results.call({
      ...base,
      outcome: result.outcome,
      stopReason: result.stopReason,
      refusalCategory: result.refusalCategory,
      contentTypes: result.contentTypes,
      thinkingBlocks: result.thinkingBlocks,
      usage: result.usage,
      latencyMs: result.latencyMs,
      attempt: result.attempt,
      errorName: null,
      httpStatus: null,
      costUsd,
    });
    return result;
  } catch (error) {
    const failure = error instanceof BedrockCallError ? error : null;
    costUsd = failure && UNBILLED_ERRORS.has(failure.kind) ? 0 : worstCase;
    await session.results.call({
      ...base,
      outcome: failure?.kind ?? "error",
      stopReason: null,
      refusalCategory: null,
      contentTypes: [],
      thinkingBlocks: null,
      usage: null,
      latencyMs: failure?.latencyMs ?? null,
      attempt: failure?.attempt ?? null,
      errorName: failure?.errorName ?? (error as Error)?.name ?? null,
      httpStatus: failure?.httpStatus ?? null,
      costUsd,
    });
    throw error;
  } finally {
    session.cap.settle(worstCase, costUsd);
    tally.costUsd += costUsd;
  }
};

const billRecord = (
  bill: LoadedBill,
  run: number,
  arm: string,
  fields: Partial<BillRunRecord> & Pick<BillRunRecord, "outcome">,
): BillRunRecord => ({
  run,
  arm,
  guid: bill.entry.guid,
  label: bill.entry.label ?? null,
  stratum: bill.entry.stratum ?? "",
  chamber: bill.chamber,
  party: bill.party,
  size: bill.size,
  textComplete: bill.input.textComplete,
  error: null,
  attempts: [],
  calls: 0,
  chainMs: null,
  revised: false,
  reducedInput: false,
  repairs: [],
  analysis: null,
  score: null,
  tags: null,
  longSoWhats: [],
  events: [],
  costUsd: 0,
  textFile: textFileOf(bill.entry.guid),
  ...fields,
});

const textFileOf = (guid: string): string => path.join("texts", `${guid}.txt`);

/**
 * One bill through analyzeBill, the handler's ladder, with the eval's call in place of the handler's. There is no
 * invocation deadline, so the corrective call and the refusal retry are always made; with emulateProduction off
 * neither is (as when production runs out of time), and an answer over a limit is fitted.
 */
export const evaluateBill = async (
  session: EvalSession,
  current: ArmRun,
  bill: LoadedBill,
  batch: { firstCandidate?: unknown; batchCall: boolean; batchCostUsd: number } = {
    batchCall: false,
    batchCostUsd: 0,
  },
): Promise<BillRunRecord> => {
  const { guid } = bill.entry;
  const tally: Tally = { calls: 0, costUsd: batch.batchCostUsd, budgetStopped: false };
  const answers = new Map<SummarizerCallKind, unknown>();
  if (batch.firstCandidate !== undefined) answers.set("first", batch.firstCandidate);
  const events: Array<Record<string, unknown>> = [];
  const startedAt = Date.now();

  const result: AnalyzeBillResult = await analyzeBill(
    bill.input,
    {
      invoke: async (kind, body) => {
        const read = await callBedrock(session, current, kind, body, [guid], tally);
        answers.set(kind, interpretModelOutput(read.text, read.stopReason, [guid]).analyses.get(guid));
        return read;
      },
      request: current.request,
      // No deadline when emulating; otherwise never time for a second call.
      remainingMs: () => (session.emulateProduction ? Number.POSITIVE_INFINITY : 0),
      minRemainingMs: session.emulateProduction ? 0 : 1,
      log: (level, event, fields) => {
        if (event !== "analysis_rejected") events.push({ level, event, ...fields });
      },
    },
    {
      ...(batch.firstCandidate === undefined ? {} : { firstCandidate: batch.firstCandidate }),
      reducedInput: () => extractReducedBillInfo(bill.raw, guid),
    },
  );

  const common = {
    attempts: result.attempts,
    calls: tally.calls + (batch.batchCall ? 1 : 0),
    chainMs: Date.now() - startedAt,
    longSoWhats: longSoWhats(result.attempts),
    events,
    costUsd: round(tally.costUsd, 6) ?? 0,
  };
  if (tally.budgetStopped) {
    return billRecord(bill, current.run, current.arm.name, {
      ...common,
      outcome: "budget_stop",
      error: new BudgetStop(session.cap).message,
    });
  }
  if (result.kind === "refused") {
    return billRecord(bill, current.run, current.arm.name, {
      ...common,
      outcome: "refused",
      error: `refused (${result.category ?? "no category"})`,
    });
  }
  if (result.kind === "failed") {
    return billRecord(bill, current.run, current.arm.name, {
      ...common,
      outcome: "failed",
      error: result.error.message,
    });
  }
  // The stored tags and axes come from the first answer, or from the retry's after a refusal.
  const tagSource = answers.get(result.reducedInput ? "refusal_retry" : "first");
  return billRecord(bill, current.run, current.arm.name, {
    ...common,
    outcome: "stored",
    revised: result.revised,
    reducedInput: result.reducedInput,
    repairs: result.repairs,
    analysis: result.analysis,
    score: scoreAnalysis(result.analysis),
    tags: tagChanges(tagSource, result.analysis),
  });
};

/**
 * A chunk of bills as summarizeBatch handles it: one bill goes straight to analyzeBill; several share one call, then
 * each bill's analysis enters analyzeBill, and a bill missing from a cut, unparseable or refused answer gets its own
 * call. The chunk call's cost is split evenly over its bills.
 */
export const evaluateChunk = async (
  session: EvalSession,
  current: ArmRun,
  bills: readonly LoadedBill[],
): Promise<BillRunRecord[]> => {
  if (bills.length === 1) return [await evaluateBill(session, current, bills[0])];
  const guids = bills.map((bill) => bill.entry.guid);
  const tally: Tally = { calls: 0, costUsd: 0, budgetStopped: false };
  const { run, arm } = current;
  let read: BedrockCallResult;
  try {
    const body = buildBedrockRequestBody(
      bills.map((bill) => bill.input),
      current.request,
    );
    read = await callBedrock(session, current, "batch", body, guids, tally);
  } catch (error) {
    const outcome = tally.budgetStopped ? "budget_stop" : "failed";
    const costUsd = round(tally.costUsd / bills.length, 6) ?? 0;
    return bills.map((bill) =>
      billRecord(bill, run, arm.name, { outcome, error: (error as Error).message, calls: tally.calls, costUsd }),
    );
  }
  const output = interpretModelOutput(read.text, read.stopReason, guids);
  const share = tally.costUsd / bills.length;
  const records: BillRunRecord[] = [];
  for (const bill of bills) {
    const candidate = output.analyses.get(bill.entry.guid);
    if (candidate === undefined && output.complete) {
      records.push(
        billRecord(bill, run, arm.name, {
          outcome: "failed",
          error: `Analysis for ${bill.entry.guid} missing from model response`,
          calls: 1,
          costUsd: round(share, 6) ?? 0,
        }),
      );
      continue;
    }
    records.push(
      await evaluateBill(session, current, bill, {
        ...(candidate === undefined ? {} : { firstCandidate: candidate }),
        batchCall: true,
        batchCostUsd: share,
      }),
    );
  }
  return records;
};

const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const describeRecord = (record: BillRunRecord, cap: SpendCap): string => {
  const details = [
    `${record.calls} call${record.calls === 1 ? "" : "s"}`,
    record.attempts[0]?.outcome === "issues" ? "first answer broke a rule" : null,
    record.revised ? "revised" : null,
    record.repairs.length > 0
      ? `fitted ${record.repairs.map((repair) => `${repair.field} (${repair.method})`).join(", ")}`
      : null,
    record.reducedInput ? "from reduced input" : null,
    record.outcome === "stored" ? null : record.error,
  ].filter(Boolean);
  const seconds = record.chainMs === null ? "" : ` ${(record.chainMs / 1000).toFixed(1)}s`;
  return `run ${record.run} ${record.arm} ${record.guid}: ${record.outcome} (${details.join("; ")})${seconds} $${record.costUsd.toFixed(4)} [spent $${cap.spentUsd.toFixed(4)} of $${cap.capUsd}]`;
};

// ── Results ──────────────────────────────────────────────────────────────────

/** calls.jsonl and bills.jsonl in a results directory, appended one line at a time. */
class ResultsWriter implements ResultSink {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {}

  private append(file: string, record: unknown): Promise<void> {
    this.queue = this.queue.then(() => appendFile(path.join(this.dir, file), `${JSON.stringify(record)}\n`));
    return this.queue;
  }

  call(record: CallRecord): Promise<void> {
    return this.append("calls.jsonl", record);
  }

  bill(record: BillRunRecord): Promise<void> {
    return this.append("bills.jsonl", record);
  }
}

/** The text the model saw, for judging accuracy in the review (rubric.md). */
const writeBillText = (dir: string, bill: LoadedBill): Promise<void> => {
  const { input } = bill;
  return writeFile(
    path.join(dir, textFileOf(input.guid)),
    [
      `guid: ${input.guid}`,
      `title: ${input.title}`,
      `officialTitle: ${input.officialTitle ?? ""}`,
      `description: ${input.description ?? ""}`,
      `textComplete: ${input.textComplete}`,
      `--- text (${input.textSnippet.length} characters) ---`,
      input.textSnippet,
      "",
    ].join("\n"),
  );
};

const readJsonLines = async <T>(file: string): Promise<T[]> => {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
};

/**
 * Records from earlier results directories. A bill-run whose arm, bill and run another directory already holds is
 * numbered after it, so two runs of one arm on the same bills count as runs 1-2 and 3-4. Text files keep their paths.
 */
const loadResults = async (dirs: readonly string[]): Promise<{ bills: BillRunRecord[]; calls: CallRecord[] }> => {
  const bills: BillRunRecord[] = [];
  const calls: CallRecord[] = [];
  for (const dir of dirs) {
    const dirBills = await readJsonLines<BillRunRecord>(path.join(dir, "bills.jsonl"));
    if (dirBills.length === 0) throw new Error(`${dir} has no bills.jsonl records`);
    const offsets = new Map<string, number>();
    for (const record of dirBills) {
      const key = `${record.arm}\u0000${record.guid}`;
      if (!offsets.has(key)) {
        offsets.set(
          key,
          bills
            .filter((other) => other.arm === record.arm && other.guid === record.guid)
            .reduce((max, other) => Math.max(max, other.run), 0),
        );
      }
    }
    for (const record of dirBills) {
      bills.push({
        ...record,
        run: record.run + (offsets.get(`${record.arm}\u0000${record.guid}`) ?? 0),
        textFile: record.textFile ? path.resolve(dir, record.textFile) : null,
      });
    }
    calls.push(...(await readJsonLines<CallRecord>(path.join(dir, "calls.jsonl"))));
  }
  return { bills, calls };
};

// ── Summary and gates ────────────────────────────────────────────────────────

const profileOf = (armName: string) => (armName === BASELINE_ARM ? null : parseArm(armName).profile);

/**
 * Summarizes every arm, checks the gates of each arm against the reference arm and writes summary.json and, with
 * two arms or more, the blinded review. Exit code 1 when a gate fails or the run stopped at --max-usd.
 */
const finish = async (
  outDir: string,
  bills: readonly BillRunRecord[],
  calls: readonly CallRecord[],
  options: { gates: GateSet | null; reference: string | null; report: Record<string, unknown> },
): Promise<number> => {
  const armNames = [...new Set(bills.map((record) => record.arm))];
  const modelArms = armNames.filter((name) => name !== BASELINE_ARM);
  const gateSet: GateSet = options.gates ?? (modelArms.every((name) => profileOf(name) === "haiku-4-5") ? "e1" : "e2");
  const reference =
    options.reference ??
    (gateSet === "e1"
      ? armNames.includes(BASELINE_ARM)
        ? BASELINE_ARM
        : null
      : modelArms.length > 1
        ? (modelArms.find((name) => profileOf(name) === "haiku-4-5") ?? null)
        : null);
  if (reference !== null && !armNames.includes(reference)) {
    throw new Error(`--reference ${reference} is not an arm of these results (${armNames.join(", ")})`);
  }
  const summaries = new Map<string, ArmSummary>(armNames.map((name) => [name, summarizeArm(name, bills, calls)]));
  const referenceSummary = reference === null ? null : summaries.get(reference)!;
  const candidates = modelArms.filter((name) => name !== reference);
  const gates = new Map<string, GateResult[]>(
    candidates.map((name) => [name, evaluateGates(gateSet, summaries.get(name)!, referenceSummary)]),
  );

  // The review sets the reference (or the stored summaries) against the first other arm.
  const reviewLeft = reference ?? (armNames.includes(BASELINE_ARM) ? BASELINE_ARM : candidates[0]);
  const reviewRight = candidates.find((name) => name !== reviewLeft);
  let reviewNote = "review.md needs two arms (add --baseline-stored or a second --arm)";
  if (reviewLeft && reviewRight) {
    const review = buildBlindReview(
      { arm: reviewLeft, records: bills },
      { arm: reviewRight, records: bills },
      {
        count: REVIEW_BILLS,
        textLink: (record) =>
          record.textFile && path.isAbsolute(record.textFile)
            ? path.relative(outDir, record.textFile)
            : record.textFile,
      },
    );
    await writeFile(path.join(outDir, "review.md"), review.markdown);
    await writeFile(path.join(outDir, "review-key.json"), `${JSON.stringify(review.key, null, 2)}\n`);
    reviewNote = `review.md compares ${reviewLeft} and ${reviewRight} on ${review.key.length} bills (key in review-key.json)`;
  }

  const budgetStopped = bills.filter((record) => record.outcome === "budget_stop").length;
  await writeFile(
    path.join(outDir, "summary.json"),
    `${JSON.stringify(
      {
        ...options.report,
        gateSet,
        reference,
        arms: Object.fromEntries(summaries),
        gates: Object.fromEntries(gates),
      },
      null,
      2,
    )}\n`,
  );

  for (const summary of summaries.values()) printSummary(summary);
  for (const [name, results] of gates) {
    console.log(`\nGates ${gateSet.toUpperCase()} for ${name}${reference ? ` against ${reference}` : ""}`);
    for (const result of results) {
      console.log(`  ${result.status.toUpperCase().padEnd(6)} ${result.id} ${result.title}`);
      for (const item of result.checks) console.log(`         ${item.status.padEnd(4)}  ${item.detail}`);
    }
  }
  if (budgetStopped > 0) console.log(`\n${budgetStopped} bill-runs not finished: the run stopped at --max-usd.`);
  console.log(`\n${reviewNote}`);
  console.log(`Results in ${outDir}`);

  const failed = [...gates.values()].some((results) => results.some((result) => result.status === "fail"));
  return failed || budgetStopped > 0 ? 1 : 0;
};

const printSummary = (summary: ArmSummary): void => {
  const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const ms = (value: number | null) => (value === null ? "n/a" : `${(value / 1000).toFixed(1)}s`);
  console.log(`\n${summary.arm}`);
  console.log(
    `  ${summary.billRuns} bill-runs (${summary.bills} bills x ${summary.runs} runs): ${summary.stored} stored, ${summary.refused} refused, ${summary.failed} failed`,
  );
  if (summary.calls.total > 0) {
    console.log(
      `  first answers: ${summary.firstCall.valid} of ${summary.firstCall.judged} valid; ${summary.firstCall.softViolations} over a limit (${percent(summary.firstCall.softViolationRate)})`,
    );
    console.log(
      `  revised ${summary.revisedBillRuns}, fitted ${summary.repairedBillRuns} (word cuts ${summary.wordCutBillRuns}), from reduced input ${summary.reducedInputBillRuns}, refusals ${summary.refusals.length}`,
    );
    console.log(
      `  calls ${summary.calls.total} ${JSON.stringify(summary.calls.byOutcome)}; latency p50 ${ms(summary.calls.latencyP50Ms)} p95 ${ms(summary.calls.latencyP95Ms)} max ${ms(summary.calls.latencyMaxMs)}; output tokens p99 ${summary.calls.outputTokensP99}; $${summary.costUsd}`,
    );
  }
  console.log(
    `  loaded words ${summary.loadedWordHits}; reading grade ${summary.readingGrade}; long sentences ${percent(summary.longSentenceRate)}; titles over 10 words ${summary.titlesOverWordLimit}; exact strings ${percent(summary.exactStrings.compliance)}`,
  );
  for (const failure of summary.failures) console.log(`  failed: ${failure.guid} run ${failure.run}: ${failure.error}`);
};

// ── Main ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  evalSummaries.ts [--arm <modelId>:<effort>]... [--bills-file FILE] [--exclude-bills FILE] [--runs-per-arm N] [--batch-size N]
                   [--concurrency N] [--limit N] [--baseline-stored] [--no-emulate-production]
                   [--gates e1|e2] [--reference ARM] [--out DIR] [--write-bodies DIR] [--yes --max-usd USD]
  evalSummaries.ts --report DIR [--report DIR]... [--gates e1|e2] [--reference ARM] [--out DIR]

Default arm: ${DEFAULT_ARM}. Effort is low, medium, high or default (Haiku 4.5 takes only default).
See scripts/eval/README.md.`;

const slug = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "_");

/** Writes each request body the run would send first, per arm; nothing is called. */
const writeBodies = async (dir: string, arms: readonly EvalArm[], bills: readonly LoadedBill[], batchSize: number) => {
  for (const arm of arms) {
    const armDir = path.join(dir, slug(arm.name));
    await mkdir(armDir, { recursive: true });
    const request = summarizerRequest(arm);
    for (const [index, chunk] of chunked(bills, batchSize).entries()) {
      const write = (name: string, body: MessagesRequestBody) =>
        writeFile(path.join(armDir, name), `${JSON.stringify(body, null, 2)}\n`);
      if (chunk.length > 1) {
        await write(
          `batch-${index + 1}.json`,
          buildBedrockRequestBody(
            chunk.map((bill) => bill.input),
            request,
          ),
        );
        continue;
      }
      const [bill] = chunk;
      await write(`${bill.entry.guid}.first.json`, buildBedrockRequestBody([bill.input], request));
      await write(
        `${bill.entry.guid}.refusal_retry.json`,
        buildBedrockRequestBody([extractReducedBillInfo(bill.raw, bill.entry.guid)], request),
      );
    }
    console.log(`Wrote ${arm.name} request bodies to ${armDir}`);
  }
};

const estimate = (
  args: EvalArgs,
  bills: readonly LoadedBill[],
  prices: Record<RequestProfile, TokenPrices>,
): { usd: number; lines: string[] } => {
  let total = 0;
  const lines = args.arms.map((arm) => {
    const request = summarizerRequest(arm);
    let firstUsd = 0;
    let worstCase = 0;
    const chunks = chunked(bills, args.batchSize);
    for (const chunk of chunks) {
      const body = buildBedrockRequestBody(
        chunk.map((bill) => bill.input),
        request,
      );
      firstUsd += expectedCall(body, arm, prices[arm.profile], ANSWER_TOKENS_PER_BILL * chunk.length).usd;
      worstCase = Math.max(worstCase, worstCaseCallUsd(body, arm.profile, prices[arm.profile]));
    }
    const perRun = firstUsd * (args.emulateProduction ? 1 + CORRECTIVE_SHARE : 1);
    total += perRun * args.runsPerArm;
    return `  ${arm.name}: ${chunks.length * args.runsPerArm} first calls, about $${(firstUsd * args.runsPerArm).toFixed(2)}${args.emulateProduction ? `, about $${(perRun * args.runsPerArm).toFixed(2)} with correctives` : ""}; worst case per call $${worstCase.toFixed(3)} (at $${prices[arm.profile].input}/$${prices[arm.profile].output} per million tokens)`;
  });
  return { usd: total, lines };
};

const report = async (args: EvalArgs, startedAt: string): Promise<number> => {
  const outDir = args.out ?? path.join(DEFAULT_RESULTS_DIR, `report-${startedAt.replace(/[:.]/g, "-")}`);
  const { bills, calls } = await loadResults(args.report);
  await mkdir(outDir, { recursive: true });
  console.log(`Scoring ${bills.length} bill-runs and ${calls.length} calls from ${args.report.join(", ")}`);
  return finish(outDir, bills, calls, {
    gates: args.gates,
    reference: args.reference,
    report: { startedAt, sources: args.report },
  });
};

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<number> => {
  if (process.env.CI) {
    console.error("evalSummaries calls Bedrock and must not run in CI.");
    return 2;
  }
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  // invokeMessages logs a bedrock_call line per attempt; calls.jsonl keeps them, so only problems are printed.
  process.env.LOG_LEVEL ??= "warn";
  const startedAt = new Date().toISOString();
  if (args.report.length > 0) return report(args, startedAt);
  if (!Number.isInteger(MAX_OUTPUT_TOKENS) || MAX_OUTPUT_TOKENS <= 0) throw new Error("Invalid MAX_OUTPUT_TOKENS");
  const prices = pricesFromEnv();

  console.log(`Loading bills from ${args.billsFile} (bucket ${BUCKET_NAME}, region ${REGION})`);
  const parsed = parseBillsFile(await readFile(args.billsFile, "utf8"), args.billsFile);
  const excluded = new Set(
    args.excludeBillsFile
      ? parseBillsFile(await readFile(args.excludeBillsFile, "utf8"), args.excludeBillsFile).entries.map(
          (entry) => entry.guid,
        )
      : [],
  );
  if (excluded.size > 0) console.log(`Leaving out the ${excluded.size} bills of ${args.excludeBillsFile}`);
  const entries = parsed.entries.filter((entry) => !excluded.has(entry.guid)).slice(0, args.limit);
  const { loaded, problems } = await loadBills(entries, args.baselineStored);
  problems.unshift(...parsed.problems);
  for (const problem of problems) console.warn(`  ! ${problem}`);
  const bills = loaded.map((item) => item.bill);
  console.log(`${bills.length} bills ready for evaluation.`);
  printStrata(bills, entries);
  if (args.baselineStored) {
    const scored = loaded.filter((item) => item.baseline && "analysis" in item.baseline).length;
    console.log(`  stored summaries written from the current text (baseline arm): ${scored} of ${loaded.length}`);
  }

  if (args.writeBodies) {
    await writeBodies(args.writeBodies, args.arms, bills, args.batchSize);
    return 0;
  }

  const plan = estimate(args, bills, prices);
  console.log(
    `Plan: ${args.runsPerArm} run(s) per arm x ${bills.length} bills, batch size ${args.batchSize}, concurrency ${args.concurrency}, ${args.emulateProduction ? "production ladder (corrective call, refusal retry, fit)" : "first answers only (fitted when over a limit)"}, max_tokens ${MAX_OUTPUT_TOKENS}`,
  );
  for (const line of plan.lines) console.log(line);
  console.log(`Estimate: about $${plan.usd.toFixed(2)} in all.`);
  if (args.maxUsd !== null) {
    console.log(
      plan.usd <= args.maxUsd
        ? `Within --max-usd ${args.maxUsd}.`
        : `The estimate is over --max-usd ${args.maxUsd}: the run will stop at the cap, with partial results.`,
    );
  }
  if (!args.yes) {
    console.log("Dry run only. Re-run with --yes --max-usd <dollars> to call Bedrock.");
    return 0;
  }
  if (bills.length === 0) {
    console.error("No bills to evaluate.");
    return 2;
  }

  const outDir = args.out ?? path.join(DEFAULT_RESULTS_DIR, `eval-${startedAt.replace(/[:.]/g, "-")}`);
  await mkdir(path.join(outDir, "texts"), { recursive: true });
  for (const bill of bills) await writeBillText(outDir, bill);
  const results = new ResultsWriter(outDir);
  const session: EvalSession = {
    client: createBedrockClient({ region: REGION }),
    cap: new SpendCap(args.maxUsd!),
    results,
    emulateProduction: args.emulateProduction,
    stopped: false,
  };

  for (const { bill, baseline } of loaded) {
    if (!baseline) continue;
    const record =
      "analysis" in baseline
        ? billRecord(bill, 1, BASELINE_ARM, {
            outcome: "stored",
            analysis: baseline.analysis,
            score: scoreAnalysis(baseline.analysis),
          })
        : billRecord(bill, 1, BASELINE_ARM, { outcome: "not_current", error: baseline.missing });
    await results.bill(record);
  }

  // Run-major order: when the cap stops the run, every arm has the same runs done.
  for (let run = 1; run <= args.runsPerArm; run += 1) {
    for (const arm of args.arms) {
      const current = armRun(arm, run, prices[arm.profile]);
      await mapWithConcurrency(chunked(bills, args.batchSize), args.concurrency, async (chunk) => {
        const records = session.stopped
          ? chunk.map((bill) =>
              billRecord(bill, run, arm.name, { outcome: "budget_stop", error: new BudgetStop(session.cap).message }),
            )
          : await evaluateChunk(session, current, chunk);
        for (const record of records) {
          await results.bill(record);
          if (record.outcome !== "budget_stop" || record.calls > 0) console.log(describeRecord(record, session.cap));
        }
      });
    }
  }

  const { bills: billRecords, calls } = await loadResults([outDir]);
  return finish(outDir, billRecords, calls, {
    gates: args.gates,
    reference: args.reference,
    report: {
      startedAt,
      billsFile: args.billsFile,
      excludeBillsFile: args.excludeBillsFile,
      armsRun: args.arms.map((arm) => arm.name),
      baselineStored: args.baselineStored,
      runsPerArm: args.runsPerArm,
      batchSize: args.batchSize,
      emulateProduction: args.emulateProduction,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      textBudgetChars: BILL_TEXT_BUDGET_CHARS,
      maxUsd: args.maxUsd,
      spentUsd: round(session.cap.spentUsd, 4),
      problems,
    },
  });
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(2);
    });
}
