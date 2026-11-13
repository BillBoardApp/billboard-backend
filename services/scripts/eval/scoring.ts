import path from "node:path";
import { CIVIC_PROFILE_AXES, type CivicProfileAxis } from "../../src/models/bill";
import { canonicalSubCategory } from "../../src/models/categories";
import type { AnalysisAttempt } from "../../src/handlers/billSummarizer/analyzeBill";
import { findLoadedWords } from "../../src/handlers/billSummarizer/loadedWords";
import {
  ANALYSIS_TEXT_FIELDS,
  NO_STATED_PURPOSE,
  SO_WHAT_MAX_SENTENCES,
  answerFieldText,
  countSentences,
  interpretModelOutput,
  splitSentences,
  type AnalysisIssue,
  type BedrockBillAnalysis,
  type FieldRepair,
} from "../../src/handlers/billSummarizer/prompts";
import {
  parseBedrockResponse,
  type BedrockPriorityDecision,
  type PriorityPromptPayload,
} from "../../src/handlers/billPriorityResolver/prompts";
import {
  readMessagesResponse,
  requestProfileForModel,
  type BedrockEffort,
  type MessagesRequestBody,
  type MessagesUsage,
  type ReadResponse,
  type RequestProfile,
} from "../../src/shared/bedrockMessages";

/**
 * The pure parts of the LLM-11 eval tooling (scripts/evalSummaries.ts, probeBedrockModel.ts and
 * comparePriorityModels.ts): arms and command-line values, cost estimates and the --max-usd cap, per-bill scores,
 * per-arm summaries and the gates of rubric.md, the blinded review, and the resolver replay. Nothing here calls
 * AWS; services/src/tests/evalScoring.test.ts covers it.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ─── Command lines ────────────────────────────────────────────────────────────

/** The value after the flag at argv[index]. */
export const flagValue = (argv: readonly string[], index: number): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argv[index]}`);
  return value;
};

export const parsePositiveInteger = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer (got ${value})`);
  return parsed;
};

export const parseUsd = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number of US dollars (got ${value})`);
  }
  return parsed;
};

const EFFORTS: readonly BedrockEffort[] = ["low", "medium", "high", "default"];

/** One model and effort to run; `name` is "<modelId>:<effort>", as --arm takes it. */
export interface EvalArm {
  name: string;
  modelId: string;
  effort: BedrockEffort;
  profile: RequestProfile;
}

/**
 * Parses --arm <modelId>:<effort>. A model ID can contain a colon ("...-v1:0"), so the effort is the text after the
 * last one. Haiku 4.5 takes no effort, so its arms say "default": two names for one request would split its results.
 */
export const parseArm = (spec: string): EvalArm => {
  const cut = spec.lastIndexOf(":");
  const modelId = cut > 0 ? spec.slice(0, cut).trim() : "";
  const effort = cut > 0 ? spec.slice(cut + 1).trim() : "";
  if (!modelId || !(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`--arm takes <modelId>:<effort> with effort ${EFFORTS.join(", ")} (got "${spec}")`);
  }
  const profile = requestProfileForModel(modelId);
  if (profile === "haiku-4-5" && effort !== "default") {
    throw new Error(`Haiku 4.5 takes no effort: use ${modelId}:default (got "${spec}")`);
  }
  return { name: `${modelId}:${effort}`, modelId, effort: effort as BedrockEffort, profile };
};

/** The arm that scores the summaries already stored (--baseline-stored); it makes no calls. */
export const BASELINE_ARM = "baseline-stored";

// ─── Cost ─────────────────────────────────────────────────────────────────────

/** USD per million tokens. */
export interface TokenPrices {
  input: number;
  output: number;
}

/** On-demand prices through the us. inference profiles (LLM-11 plan, section 11). */
export const DEFAULT_PRICES: Readonly<Record<RequestProfile, TokenPrices>> = {
  "haiku-4-5": { input: 1.1, output: 5.5 },
  "haiku-5-5": { input: 0.11, output: 0.55 },
};

const PRICE_ENV_VARS: Readonly<Record<RequestProfile, string>> = {
  "haiku-4-5": "EVAL_PRICE_HAIKU_4_5",
  "haiku-5-5": "EVAL_PRICE_HAIKU_5_5",
};

/** DEFAULT_PRICES, each overridable by EVAL_PRICE_HAIKU_4_5 or EVAL_PRICE_HAIKU_5_5 as "<input>/<output>". */
export const pricesFromEnv = (env: NodeJS.ProcessEnv = process.env): Record<RequestProfile, TokenPrices> => {
  const prices = { ...DEFAULT_PRICES };
  for (const profile of Object.keys(PRICE_ENV_VARS) as RequestProfile[]) {
    const name = PRICE_ENV_VARS[profile];
    const value = env[name]?.trim();
    if (!value) continue;
    const parts = value.split("/").map(Number);
    if (parts.length !== 2 || !parts.every((part) => Number.isFinite(part) && part > 0)) {
      throw new Error(`${name} must be "<input>/<output>" in USD per million tokens (got ${value})`);
    }
    prices[profile] = { input: parts[0], output: parts[1] };
  }
  return prices;
};

// Haiku 5.5's tokenizer counts about 1.3 times Haiku 4.5's tokens for the same text.
const TOKENIZER_FACTOR: Readonly<Record<RequestProfile, number>> = { "haiku-4-5": 1, "haiku-5-5": 1.3 };
const CHARS_PER_TOKEN = 4;
// The spend cap assumes denser text than the plan's estimate does.
const WORST_CASE_CHARS_PER_TOKEN = 3;

/** Visible answer tokens per bill, on Haiku 4.5's tokenizer. */
export const ANSWER_TOKENS_PER_BILL = 700;
/** Visible answer tokens of a resolver call: up to 8 decisions with a short reason each. */
export const PRIORITY_ANSWER_TOKENS = 600;

/** Thinking tokens assumed per Haiku 5.5 call; "default" is the model's own default, medium. */
export const THINKING_TOKENS: Readonly<Record<BedrockEffort, number>> = {
  low: 500,
  medium: 1_500,
  high: 3_000,
  default: 1_500,
};

/** The characters a request sends the model: the system prompt and every text block. */
export const requestTextChars = (body: MessagesRequestBody): number =>
  (body.system ?? "").length +
  body.messages.reduce((sum, message) => {
    if (typeof message.content === "string") return sum + message.content.length;
    if (!Array.isArray(message.content)) return sum;
    return (
      sum +
      (message.content as unknown[]).reduce<number>((chars, block) => {
        const text = isRecord(block) ? block.text : undefined;
        return chars + (typeof text === "string" ? text.length : 0);
      }, 0)
    );
  }, 0);

const tokensUsd = (inputTokens: number, outputTokens: number, prices: TokenPrices): number =>
  (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000;

export interface CallEstimate {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/**
 * The expected cost of one call, for the dry-run plan: the rendered text at 4 characters a token, and the visible
 * answer, both x1.3 on Haiku 5.5, plus its thinking at the arm's effort; never more output than max_tokens.
 */
export const expectedCall = (
  body: MessagesRequestBody,
  arm: Pick<EvalArm, "profile" | "effort">,
  prices: TokenPrices,
  answerTokens: number,
): CallEstimate => {
  const factor = TOKENIZER_FACTOR[arm.profile];
  const thinking = arm.profile === "haiku-5-5" ? THINKING_TOKENS[arm.effort] : 0;
  const inputTokens = Math.ceil((requestTextChars(body) / CHARS_PER_TOKEN) * factor);
  const outputTokens = Math.min(body.max_tokens, Math.ceil(answerTokens * factor + thinking));
  return { inputTokens, outputTokens, usd: tokensUsd(inputTokens, outputTokens, prices) };
};

/** The most one call can cost: the text at 3 characters a token (x1.3 on 5.5) and all of max_tokens out. */
export const worstCaseCallUsd = (body: MessagesRequestBody, profile: RequestProfile, prices: TokenPrices): number =>
  tokensUsd(
    Math.ceil((requestTextChars(body) / WORST_CASE_CHARS_PER_TOKEN) * TOKENIZER_FACTOR[profile]),
    body.max_tokens,
    prices,
  );

/** What an answered call cost, from its usage; null when Bedrock left a token count out. */
export const usageCostUsd = (usage: MessagesUsage, prices: TokenPrices): number | null => {
  if (usage.input === null || usage.output === null) return null;
  return tokensUsd(usage.input + (usage.cacheRead ?? 0) + (usage.cacheCreation ?? 0), usage.output, prices);
};

/**
 * The --max-usd cap. Before each call the caller reserves that call's worst case (worstCaseCallUsd); a call goes
 * ahead only when the spend so far plus every reservation in flight stays within the cap, so no run can pass it.
 * settle() swaps a reservation for what the call cost.
 */
export class SpendCap {
  private spent = 0;

  private reserved = 0;

  constructor(readonly capUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  tryReserve(usd: number): boolean {
    if (this.spent + this.reserved + usd > this.capUsd) return false;
    this.reserved += usd;
    return true;
  }

  settle(reservedUsd: number, costUsd: number): void {
    this.reserved = Math.max(0, this.reserved - reservedUsd);
    this.spent += costUsd;
  }
}

// ─── Bill lists ───────────────────────────────────────────────────────────────

/** An entry of a bill list (scripts/eval/*.json). */
export interface EvalBillEntry {
  guid: string;
  label?: string;
  /** Why the bill is in the set; defaults to the file's name ("bills" for bills.json). */
  stratum?: string;
  expectedParty?: string | null;
  expectedSize?: string;
  note?: string;
  /** Chosen without the bill store: confirm it with a dry run. */
  verify?: boolean;
}

const GUID_PATTERN = /^BILLS-\d+[a-z]+\d+$/;

/** A bill list's entries in order; an entry without a valid guid, or a repeated one, is reported and skipped. */
export const parseBillsFile = (text: string, fileName: string): { entries: EvalBillEntry[]; problems: string[] } => {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.bills)) throw new Error(`${fileName} has no "bills" list`);
  const stratum = path.basename(fileName, path.extname(fileName));
  const seen = new Set<string>();
  const entries: EvalBillEntry[] = [];
  const problems: string[] = [];
  for (const item of parsed.bills as unknown[]) {
    const guid = isRecord(item) ? item.guid : undefined;
    if (typeof guid !== "string" || !GUID_PATTERN.test(guid) || seen.has(guid)) {
      problems.push(`Invalid or duplicate entry: ${JSON.stringify(item)}`);
      continue;
    }
    seen.add(guid);
    const entry = item as unknown as EvalBillEntry;
    entries.push({ ...entry, stratum: entry.stratum ?? stratum });
  }
  return { entries, problems };
};

// ─── Scores of one analysis ───────────────────────────────────────────────────

/** The eval's own title rule (rubric.md); the validator limits characters only. */
export const TITLE_MAX_WORDS = 10;
/** Sentences over this many words miss the plain-language target (LLM-12). */
export const LONG_SENTENCE_WORDS = 20;

export const wordsIn = (text: string): string[] => text.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word));

const syllables = (word: string): number => {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
};

/** Flesch-Kincaid grade level, sentences split as the validator splits them. A rough guide (LLM-12). */
export const readingGrade = (texts: readonly string[]): number | null => {
  const sentences = texts.flatMap(splitSentences);
  const words = sentences.flatMap(wordsIn);
  if (sentences.length === 0 || words.length === 0) return null;
  const syllableCount = words.reduce((sum, word) => sum + syllables(word), 0);
  return 0.39 * (words.length / sentences.length) + 11.8 * (syllableCount / words.length) - 15.59;
};

export const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Population standard deviation; 0 for fewer than two values. */
export const stdev = (values: readonly number[]): number => {
  const m = mean(values);
  if (m === null || values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length);
};

export const round = (value: number | null, digits = 3): number | null =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** Nearest-rank percentile (p in 0-100); null for no values. */
export const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

// The exact strings the system prompt asks for, with what a near miss of each looks like.
const EXACT_STRINGS: ReadonlyArray<{ field: string; text: string; nearMiss: RegExp }> = [
  { field: "billBreakdown.where", text: "Not Applicable", nearMiss: /^(?:not applicable|n\/a)\W*$/i },
  {
    field: "billBreakdown.when",
    text: "The provided text does not say.",
    nearMiss: /^(?:the )?(?:provided )?text does not say\W*$/i,
  },
  {
    field: "billBreakdown.why",
    text: NO_STATED_PURPOSE,
    nearMiss: /^(?:the )?bill (?:does not|doesn't) state (?:a|any|its) purpose\W*$/i,
  },
];

/** Uses of the exact strings, and near misses ("Not applicable.", "N/A") that should have been one. */
export interface ExactStringUse {
  uses: number;
  nearMisses: Array<{ field: string; text: string }>;
}

export const exactStringUse = (analysis: BedrockBillAnalysis): ExactStringUse => {
  const result: ExactStringUse = { uses: 0, nearMisses: [] };
  for (const { field, text, nearMiss } of EXACT_STRINGS) {
    const value = answerFieldText(analysis, field);
    if (value === text) result.uses += 1;
    else if (nearMiss.test(value)) result.nearMisses.push({ field, text: value });
  }
  return result;
};

export interface AnalysisScore {
  /** Characters and sentences per text field, named as in AnalysisIssue. */
  fields: Record<string, { chars: number; sentences: number }>;
  loadedWords: string[];
  titleWords: number;
  sentences: number;
  longSentences: number;
  readingGrade: number | null;
  exactStrings: ExactStringUse;
}

/** Scores an analysis as it would be stored. */
export const scoreAnalysis = (analysis: BedrockBillAnalysis): AnalysisScore => {
  const texts = ANALYSIS_TEXT_FIELDS.map((field) => answerFieldText(analysis, field));
  const sentences = texts.flatMap(splitSentences);
  return {
    fields: Object.fromEntries(
      ANALYSIS_TEXT_FIELDS.map((field, index) => [
        field,
        { chars: texts[index].length, sentences: countSentences(texts[index]) },
      ]),
    ),
    loadedWords: texts.flatMap((text) => findLoadedWords(text)),
    titleWords: wordsIn(analysis.title).length,
    sentences: sentences.length,
    longSentences: sentences.filter((sentence) => wordsIn(sentence).length > LONG_SENTENCE_WORDS).length,
    readingGrade: round(readingGrade(texts), 2),
    exactStrings: exactStringUse(analysis),
  };
};

export interface TagChanges {
  kept: string[];
  dropped: string[];
}

/** The model's tags against those the validator kept: unknown, repeated and fourth-or-later tags are dropped. */
export const tagChanges = (
  candidate: unknown,
  analysis: BedrockBillAnalysis,
): { subCategories: TagChanges; lifeAreas: TagChanges } => {
  const answered = (key: string): string[] => {
    const value = isRecord(candidate) ? candidate[key] : undefined;
    return Array.isArray(value) ? value.map((tag) => (typeof tag === "string" ? tag.trim() : JSON.stringify(tag))) : [];
  };
  const changes = (tags: string[], kept: string[], canonical: (tag: string) => string = (tag) => tag): TagChanges => {
    const unclaimed = [...kept];
    const dropped: string[] = [];
    for (const tag of tags) {
      const index = unclaimed.indexOf(canonical(tag));
      if (index >= 0) unclaimed.splice(index, 1);
      else dropped.push(tag);
    }
    return { kept, dropped };
  };
  return {
    subCategories: changes(answered("subCategories"), analysis.subCategories, canonicalSubCategory),
    lifeAreas: changes(answered("lifeAreas"), analysis.lifeAreas),
  };
};

/** Every soWhat over SO_WHAT_MAX_SENTENCES sentences among the answers, so the sentence counter can be checked. */
export const longSoWhats = (
  attempts: readonly AnalysisAttempt[],
): Array<{ attempt: string; sentences: number; text: string }> =>
  attempts.flatMap((attempt) =>
    (attempt.issues ?? [])
      .filter((issue) => issue.field === "soWhat" && (issue.sentences ?? 0) > SO_WHAT_MAX_SENTENCES)
      .filter((issue, index, list) => list.findIndex((other) => other.text === issue.text) === index)
      .map((issue) => ({ attempt: attempt.kind, sentences: issue.sentences ?? 0, text: issue.text ?? "" })),
  );

// ─── Records ──────────────────────────────────────────────────────────────────

/** One Bedrock call, a line of calls.jsonl. */
export interface CallRecord {
  run: number;
  arm: string;
  modelId: string;
  effort: BedrockEffort;
  kind: string;
  guids: string[];
  bodySha256: string;
  /** The answer's outcome (ok, refusal, max_tokens, incomplete), or the error kind when none came back. */
  outcome: string;
  stopReason: string | null;
  refusalCategory: string | null;
  contentTypes: string[];
  thinkingBlocks: number | null;
  usage: MessagesUsage | null;
  latencyMs: number | null;
  /** invokeMessages' attempt that answered, or that failed last (0-based). */
  attempt: number | null;
  errorName: string | null;
  httpStatus: number | null;
  estimatedUsd: number;
  /** From the usage; the worst case when unknown (an aborted call may still be billed). */
  costUsd: number;
}

/**
 * stored: an analysis within the display contract (for the baseline, the stored summary). refused: refused twice.
 * failed: no analysis, so production would fail the record. budget_stop: not finished, --max-usd was reached.
 * not_current: the baseline's stored summary is missing or was written from other text.
 */
export type BillRunOutcome = "stored" | "refused" | "failed" | "budget_stop" | "not_current";

/** One bill on one arm in one run, a line of bills.jsonl. */
export interface BillRunRecord {
  run: number;
  arm: string;
  guid: string;
  label: string | null;
  stratum: string;
  chamber: string;
  party: string;
  size: string;
  textComplete: boolean;
  outcome: BillRunOutcome;
  error: string | null;
  /** Each answer and what it came to, first to last (analyzeBill); empty for the baseline. */
  attempts: AnalysisAttempt[];
  calls: number;
  /** From the first call to the bill's outcome; null for the baseline. */
  chainMs: number | null;
  revised: boolean;
  reducedInput: boolean;
  repairs: FieldRepair[];
  analysis: BedrockBillAnalysis | null;
  score: AnalysisScore | null;
  tags: { subCategories: TagChanges; lifeAreas: TagChanges } | null;
  longSoWhats: Array<{ attempt: string; sentences: number; text: string }>;
  /** analyzeBill's log lines (analysis_repaired, summary_refused, bedrock_output_problem, ...), but analysis_rejected. */
  events: Array<Record<string, unknown>>;
  costUsd: number;
  /** The text the model saw, relative to the results directory. */
  textFile: string | null;
}

const FINISHED: ReadonlySet<BillRunOutcome> = new Set(["stored", "refused", "failed"]);

/** Bill-runs that count: finished ones, without budget stops and stale baselines. */
export const finishedRuns = (records: readonly BillRunRecord[]): BillRunRecord[] =>
  records.filter((record) => FINISHED.has(record.outcome));

// ─── Summaries ────────────────────────────────────────────────────────────────

interface PartyStats {
  billRuns: number;
  loadedWordHitsPerRun: number | null;
  readingGrade: number | null;
}

/** Sponsor-party group for symmetry checks; independents caucusing with Democrats count as D. */
export const partyGroup = (party: string): "R" | "D" | null => {
  if (party === "R") return "R";
  if (party === "D" || party === "I" || party === "ID") return "D";
  return null;
};

export interface ArmSummary {
  arm: string;
  /** Finished bill-runs (stored, refused or failed). */
  billRuns: number;
  bills: number;
  runs: number;
  stored: number;
  refused: number;
  failed: number;
  budgetStopped: number;
  notCurrent: number;
  failures: Array<{ guid: string; run: number; error: string | null }>;
  /** Bill-runs with any refused answer, the retry's included. */
  refusals: Array<{ guid: string; run: number; stratum: string; categories: Array<string | null>; outcome: string }>;
  rel40: { billRuns: number; stored: number };
  /** The first answers the validator judged: the production-validator pass before any corrective or fit. */
  firstCall: {
    judged: number;
    valid: number;
    softViolations: number;
    hardIssues: number;
    softViolationRate: number | null;
  };
  repairedBillRuns: number;
  wordCutBillRuns: number;
  fieldRepairs: number;
  revisedBillRuns: number;
  reducedInputBillRuns: number;
  /** The eval's 10-word title rule, apart from the validator's. */
  titlesOverWordLimit: number;
  loadedWordHits: number;
  loadedWordsSeen: string[];
  party: { R: PartyStats; D: PartyStats; loadedWordGapPerRun: number | null };
  /** Bill-axis pairs with scores from at least two runs. */
  axes: {
    pairs: number;
    meanStdev: number | null;
    maxStdev: number | null;
    signFlips: number;
    signFlipRate: number | null;
    presenceMismatches: number;
  };
  /** Mean axis score per bill, for the sign agreement between arms. */
  axisMeans: Record<string, Partial<Record<CivicProfileAxis, number>>>;
  readingGrade: number | null;
  longSentenceRate: number | null;
  exactStrings: { uses: number; nearMisses: number; compliance: number };
  calls: {
    total: number;
    byOutcome: Record<string, number>;
    /** 400, 403 and 404: the request, the grant or the model is wrong. */
    rejectedRequests: number;
    timeouts: number;
    maxTokensStops: number;
    outputTokensP99: number | null;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
    latencyMaxMs: number | null;
    inputTokens: number;
    outputTokens: number;
  };
  chainP99Ms: number | null;
  costUsd: number;
  costPerBillRunUsd: number | null;
}

const REJECTED_REQUEST_KINDS = new Set(["invalid_request", "access_denied", "not_found"]);
const ANSWER_OUTCOMES = new Set(["ok", "refusal", "max_tokens", "incomplete"]);

const rate = (count: number, total: number): number | null => (total === 0 ? null : count / total);

export const summarizeArm = (
  arm: string,
  records: readonly BillRunRecord[],
  calls: readonly CallRecord[],
): ArmSummary => {
  const runs = finishedRuns(records.filter((record) => record.arm === arm));
  const armCalls = calls.filter((call) => call.arm === arm);
  const stored = runs.filter((record) => record.outcome === "stored" && record.analysis && record.score);
  const scores = stored.map((record) => record.score as AnalysisScore);

  const judged = runs
    .map((record) => record.attempts[0])
    .filter(
      (attempt): attempt is AnalysisAttempt =>
        attempt?.kind === "first" && (attempt.outcome === "valid" || attempt.outcome === "issues"),
    );
  const softViolations = judged.filter((attempt) =>
    (attempt.issues ?? []).some((issue) => issue.kind === "soft"),
  ).length;

  const partyStats = (group: "R" | "D"): PartyStats => {
    const groupRuns = stored.filter((record) => partyGroup(record.party) === group);
    return {
      billRuns: groupRuns.length,
      loadedWordHitsPerRun: round(mean(groupRuns.map((record) => record.score?.loadedWords.length ?? 0))),
      readingGrade: round(
        mean(groupRuns.map((record) => record.score?.readingGrade).filter((g): g is number => typeof g === "number")),
        2,
      ),
    };
  };
  const republican = partyStats("R");
  const democratic = partyStats("D");

  // Axis stability across runs, per bill and axis.
  const byBill = new Map<string, BillRunRecord[]>();
  for (const record of stored) byBill.set(record.guid, [...(byBill.get(record.guid) ?? []), record]);
  const deviations: number[] = [];
  let signFlips = 0;
  let presenceMismatches = 0;
  const axisMeans: ArmSummary["axisMeans"] = {};
  for (const [guid, billRuns] of byBill) {
    for (const axis of CIVIC_PROFILE_AXES) {
      const values = billRuns
        .map((record) => record.analysis?.civicProfile?.[axis])
        .filter((value): value is number => typeof value === "number");
      if (values.length === 0) continue;
      axisMeans[guid] = { ...axisMeans[guid], [axis]: round(mean(values), 4) ?? 0 };
      if (values.length < billRuns.length) presenceMismatches += 1;
      if (values.length < 2) continue;
      deviations.push(stdev(values));
      if (values.some((value) => value > 0) && values.some((value) => value < 0)) signFlips += 1;
    }
  }

  const answered = armCalls.filter((call) => ANSWER_OUTCOMES.has(call.outcome));
  const latencies = answered.map((call) => call.latencyMs).filter((ms): ms is number => typeof ms === "number");
  const outputTokens = armCalls.map((call) => call.usage?.output).filter((t): t is number => typeof t === "number");
  const byOutcome: Record<string, number> = {};
  for (const call of armCalls) byOutcome[call.outcome] = (byOutcome[call.outcome] ?? 0) + 1;
  const sentences = scores.reduce((sum, score) => sum + score.sentences, 0);
  const exactUses = scores.reduce((sum, score) => sum + score.exactStrings.uses, 0);
  const exactMisses = scores.reduce((sum, score) => sum + score.exactStrings.nearMisses.length, 0);
  const costUsd = armCalls.reduce((sum, call) => sum + call.costUsd, 0);
  const rel40 = runs.filter((record) => record.stratum === "rel40");
  const loadedWords = scores.flatMap((score) => score.loadedWords);

  return {
    arm,
    billRuns: runs.length,
    bills: new Set(runs.map((record) => record.guid)).size,
    runs: new Set(runs.map((record) => record.run)).size,
    stored: runs.filter((record) => record.outcome === "stored").length,
    refused: runs.filter((record) => record.outcome === "refused").length,
    failed: runs.filter((record) => record.outcome === "failed").length,
    budgetStopped: records.filter((record) => record.arm === arm && record.outcome === "budget_stop").length,
    notCurrent: records.filter((record) => record.arm === arm && record.outcome === "not_current").length,
    failures: runs
      .filter((record) => record.outcome === "failed")
      .map((record) => ({ guid: record.guid, run: record.run, error: record.error })),
    refusals: runs
      .filter((record) => record.attempts.some((attempt) => attempt.outcome === "refusal"))
      .map((record) => ({
        guid: record.guid,
        run: record.run,
        stratum: record.stratum,
        categories: record.attempts
          .filter((attempt) => attempt.outcome === "refusal")
          .map((attempt) => attempt.refusalCategory ?? null),
        outcome: record.outcome,
      })),
    rel40: { billRuns: rel40.length, stored: rel40.filter((record) => record.outcome === "stored").length },
    firstCall: {
      judged: judged.length,
      valid: judged.filter((attempt) => attempt.outcome === "valid").length,
      softViolations,
      hardIssues: judged.filter((attempt) => (attempt.issues ?? []).some((issue) => issue.kind === "hard")).length,
      softViolationRate: round(rate(softViolations, judged.length), 4),
    },
    repairedBillRuns: stored.filter((record) => record.repairs.length > 0).length,
    wordCutBillRuns: stored.filter((record) => record.repairs.some((repair) => repair.method === "words")).length,
    fieldRepairs: stored.reduce((sum, record) => sum + record.repairs.length, 0),
    revisedBillRuns: stored.filter((record) => record.revised).length,
    reducedInputBillRuns: stored.filter((record) => record.reducedInput).length,
    titlesOverWordLimit: scores.filter((score) => score.titleWords > TITLE_MAX_WORDS).length,
    loadedWordHits: loadedWords.length,
    loadedWordsSeen: [...new Set(loadedWords)],
    party: {
      R: republican,
      D: democratic,
      loadedWordGapPerRun:
        republican.loadedWordHitsPerRun !== null && democratic.loadedWordHitsPerRun !== null
          ? round(Math.abs(republican.loadedWordHitsPerRun - democratic.loadedWordHitsPerRun))
          : null,
    },
    axes: {
      pairs: deviations.length,
      meanStdev: round(mean(deviations)),
      maxStdev: deviations.length === 0 ? null : round(Math.max(...deviations)),
      signFlips,
      signFlipRate: round(rate(signFlips, deviations.length), 4),
      presenceMismatches,
    },
    axisMeans,
    readingGrade: round(
      mean(scores.map((score) => score.readingGrade).filter((grade): grade is number => grade !== null)),
      2,
    ),
    longSentenceRate: round(
      rate(
        scores.reduce((sum, score) => sum + score.longSentences, 0),
        sentences,
      ),
      4,
    ),
    exactStrings: {
      uses: exactUses,
      nearMisses: exactMisses,
      compliance: exactUses + exactMisses === 0 ? 1 : (round(exactUses / (exactUses + exactMisses), 4) ?? 1),
    },
    calls: {
      total: armCalls.length,
      byOutcome,
      rejectedRequests: armCalls.filter((call) => REJECTED_REQUEST_KINDS.has(call.outcome)).length,
      timeouts: armCalls.filter((call) => call.outcome === "timeout").length,
      maxTokensStops: armCalls.filter((call) => call.outcome === "max_tokens").length,
      outputTokensP99: percentile(outputTokens, 99),
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      latencyMaxMs: latencies.length === 0 ? null : Math.max(...latencies),
      inputTokens: armCalls.reduce((sum, call) => sum + (call.usage?.input ?? 0), 0),
      outputTokens: outputTokens.reduce((sum, tokens) => sum + tokens, 0),
    },
    chainP99Ms: percentile(
      runs.map((record) => record.chainMs).filter((ms): ms is number => typeof ms === "number"),
      99,
    ),
    costUsd: round(costUsd, 4) ?? 0,
    costPerBillRunUsd: round(rate(costUsd, runs.length), 5),
  };
};

/** Bill-axis pairs scored by both arms whose mean scores have the same sign (0 counts as its own sign). */
export const axisSignAgreement = (
  candidate: ArmSummary,
  reference: ArmSummary,
): { pairs: number; agreements: number; rate: number | null } => {
  let pairs = 0;
  let agreements = 0;
  for (const [guid, axes] of Object.entries(candidate.axisMeans)) {
    for (const [axis, value] of Object.entries(axes)) {
      const other = reference.axisMeans[guid]?.[axis as CivicProfileAxis];
      if (typeof other !== "number" || typeof value !== "number") continue;
      pairs += 1;
      if (Math.sign(value) === Math.sign(other)) agreements += 1;
    }
  }
  return { pairs, agreements, rate: round(rate(agreements, pairs), 4) };
};

// ─── Gates ────────────────────────────────────────────────────────────────────

/** E1 gates Deploy A (Haiku 4.5 with the REL-40 fix), E2 gates Deploy B (Haiku 5.5). See rubric.md. */
export type GateSet = "e1" | "e2";

export const GATE_LIMITS = {
  e1: {
    maxFirstCallSoftViolationRate: 0.15,
    maxRepairedBillRuns: 3,
    maxWordCutBillRuns: 1,
    maxLoadedWordHits: 0,
    maxPartyGap: 0.25,
    maxReadingGradeOverReference: 0.5,
  },
  e2: {
    maxRefusalRate: 0.01,
    maxRepairedRate: 0.05,
    maxWordCutRate: 0.01,
    maxOutputTokensP99: 4_096,
    maxLatencyP95Ms: 25_000,
    maxLatencyMs: 50_000,
    maxChainP99Ms: 80_000,
    maxLoadedWordHits: 0,
    maxPartyGap: 0.25,
    maxMeanAxisStdev: 0.15,
    maxSignFlipRate: 0.02,
    maxReadingGrade: 8,
    maxReadingGradeOverReference: 0.5,
  },
} as const;

/** info lines are reported and never decide a gate. */
export type CheckStatus = "pass" | "fail" | "n/a" | "info";

export interface GateCheck {
  status: CheckStatus;
  detail: string;
}

export interface GateResult {
  id: string;
  title: string;
  status: "pass" | "fail" | "n/a" | "manual";
  checks: GateCheck[];
}

/** pass true or false; null when the check cannot be made (no reference, a single run). */
const check = (pass: boolean | null, detail: string): GateCheck => ({
  status: pass === null ? "n/a" : pass ? "pass" : "fail",
  detail,
});

const gate = (id: string, title: string, checks: GateCheck[]): GateResult => {
  const decided = checks.filter((item) => item.status === "pass" || item.status === "fail");
  const status = checks.some((item) => item.status === "fail") ? "fail" : decided.length > 0 ? "pass" : "n/a";
  return { id, title, status, checks };
};

const manual = (id: string, title: string, detail: string): GateResult => ({
  id,
  title,
  status: "manual",
  checks: [{ status: "info", detail }],
});

const pct = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const seconds = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

const loadedWordChecks = (
  candidate: ArmSummary,
  limits: { maxLoadedWordHits: number; maxPartyGap: number },
): GateCheck[] => {
  const gap = candidate.party.loadedWordGapPerRun;
  return [
    check(
      candidate.loadedWordHits <= limits.maxLoadedWordHits,
      `${candidate.loadedWordHits} loaded-word hits ${JSON.stringify(candidate.loadedWordsSeen)}`,
    ),
    check(
      gap === null ? null : gap <= limits.maxPartyGap,
      gap === null
        ? "not enough R and D bills to compare"
        : `party gap ${gap} hits per run (at most ${limits.maxPartyGap})`,
    ),
  ];
};

const e1Gates = (candidate: ArmSummary, reference: ArmSummary | null): GateResult[] => {
  const limits = GATE_LIMITS.e1;
  const firstRate = candidate.firstCall.softViolationRate;
  const grade = candidate.readingGrade;
  const referenceGrade = reference?.readingGrade ?? null;
  return [
    gate("E1.1", "REL-40 bills stored", [
      check(
        candidate.rel40.billRuns === 0 ? null : candidate.rel40.stored === candidate.rel40.billRuns,
        `${candidate.rel40.stored} of ${candidate.rel40.billRuns} REL-40 bill-runs stored`,
      ),
    ]),
    gate("E1.2", "first answers within the limits", [
      check(
        firstRate === null ? null : firstRate <= limits.maxFirstCallSoftViolationRate,
        `${candidate.firstCall.softViolations} of ${candidate.firstCall.judged} first answers over a limit (${pct(firstRate)}; at most ${pct(limits.maxFirstCallSoftViolationRate)})`,
      ),
    ]),
    gate("E1.3", "repairs", [
      check(
        candidate.repairedBillRuns <= limits.maxRepairedBillRuns,
        `${candidate.repairedBillRuns} bill-runs fitted (at most ${limits.maxRepairedBillRuns})`,
      ),
      check(
        candidate.wordCutBillRuns <= limits.maxWordCutBillRuns,
        `${candidate.wordCutBillRuns} with a word cut (at most ${limits.maxWordCutBillRuns})`,
      ),
    ]),
    gate("E1.4", "loaded words and party symmetry", loadedWordChecks(candidate, limits)),
    gate("E1.5", "reading grade against the stored summaries", [
      check(
        grade === null || referenceGrade === null
          ? null
          : grade <= referenceGrade + limits.maxReadingGradeOverReference,
        reference
          ? `mean grade ${grade} vs ${reference.arm} ${referenceGrade} (at most +${limits.maxReadingGradeOverReference})`
          : "no reference arm (add --baseline-stored)",
      ),
    ]),
    manual("E1.6", "human spot check", "Read 10 bills in review.md: no loss of meaning against the extracted text."),
  ];
};

const e2Gates = (candidate: ArmSummary, reference: ArmSummary | null): GateResult[] => {
  const limits = GATE_LIMITS.e2;
  const { calls } = candidate;
  const refusalRate = rate(candidate.refusals.length, candidate.billRuns);
  const refusedOnFixedSet = candidate.refusals.filter((refusal) => refusal.stratum === "bills");
  const refusalList = candidate.refusals
    .map((refusal) => `${refusal.guid} run ${refusal.run} [${refusal.categories.join(", ")}] ${refusal.outcome}`)
    .join("; ");
  const repairedRate = rate(candidate.repairedBillRuns, candidate.billRuns);
  const wordCutRate = rate(candidate.wordCutBillRuns, candidate.billRuns);
  const firstRate = candidate.firstCall.softViolationRate;
  const referenceFirstRate = reference?.firstCall.softViolationRate ?? null;
  const agreement = reference ? axisSignAgreement(candidate, reference) : null;
  const referenceGrade = reference?.readingGrade ?? null;
  const referenceLongRate = reference?.longSentenceRate ?? null;
  const referenceCost = reference?.costPerBillRunUsd ?? null;
  const noReference = "no reference arm";

  return [
    gate("G1", "no rejected requests or aborts", [
      check(calls.rejectedRequests === 0, `${calls.rejectedRequests} calls rejected with 400, 403 or 404`),
      check(calls.timeouts === 0, `${calls.timeouts} calls aborted or timed out`),
    ]),
    gate("G2", "refusals", [
      check(
        refusalRate === null ? null : refusalRate <= limits.maxRefusalRate,
        `${candidate.refusals.length} of ${candidate.billRuns} bill-runs refused (${pct(refusalRate)}; at most ${pct(limits.maxRefusalRate)})${refusalList ? `: ${refusalList}` : ""}`,
      ),
      check(refusedOnFixedSet.length === 0, `${refusedOnFixedSet.length} refused bill-runs from bills.json`),
    ]),
    gate("G3", "stored, repairs and first answers", [
      check(
        candidate.billRuns === 0 ? null : candidate.stored === candidate.billRuns - candidate.refused,
        `${candidate.stored} of ${candidate.billRuns - candidate.refused} bill-runs that were not refused stored`,
      ),
      check(
        repairedRate === null ? null : repairedRate <= limits.maxRepairedRate,
        `${candidate.repairedBillRuns} bill-runs fitted (${pct(repairedRate)}; at most ${pct(limits.maxRepairedRate)})`,
      ),
      check(
        wordCutRate === null ? null : wordCutRate <= limits.maxWordCutRate,
        `${candidate.wordCutBillRuns} with a word cut (${pct(wordCutRate)}; at most ${pct(limits.maxWordCutRate)})`,
      ),
      check(
        firstRate === null || referenceFirstRate === null ? null : firstRate <= referenceFirstRate,
        reference
          ? `first answers over a limit ${pct(firstRate)} vs ${reference.arm} ${pct(referenceFirstRate)}`
          : noReference,
      ),
    ]),
    gate("G4", "no answer cut at max_tokens", [
      check(calls.maxTokensStops === 0, `${calls.maxTokensStops} max_tokens stops`),
      check(
        calls.outputTokensP99 === null ? null : calls.outputTokensP99 <= limits.maxOutputTokensP99,
        `p99 output tokens ${calls.outputTokensP99} (at most ${limits.maxOutputTokensP99})`,
      ),
    ]),
    gate("G5", "latency", [
      check(
        calls.latencyP95Ms === null ? null : calls.latencyP95Ms <= limits.maxLatencyP95Ms,
        `per-call p95 ${seconds(calls.latencyP95Ms)} (at most ${seconds(limits.maxLatencyP95Ms)})`,
      ),
      check(
        calls.latencyMaxMs === null ? null : calls.latencyMaxMs <= limits.maxLatencyMs,
        `per-call max ${seconds(calls.latencyMaxMs)} (at most ${seconds(limits.maxLatencyMs)})`,
      ),
      check(
        candidate.chainP99Ms === null ? null : candidate.chainP99Ms <= limits.maxChainP99Ms,
        `per-bill p99 ${seconds(candidate.chainP99Ms)} (at most ${seconds(limits.maxChainP99Ms)})`,
      ),
    ]),
    gate("G6", "loaded words and party symmetry", loadedWordChecks(candidate, limits)),
    gate("G7", "axis stability across runs", [
      check(
        candidate.axes.meanStdev === null ? null : candidate.axes.meanStdev <= limits.maxMeanAxisStdev,
        candidate.axes.pairs === 0
          ? "needs 2 or more runs"
          : `mean per-axis stdev ${candidate.axes.meanStdev} over ${candidate.axes.pairs} bill-axis pairs (at most ${limits.maxMeanAxisStdev})`,
      ),
      check(
        candidate.axes.signFlipRate === null ? null : candidate.axes.signFlipRate <= limits.maxSignFlipRate,
        candidate.axes.pairs === 0
          ? "needs 2 or more runs"
          : `${candidate.axes.signFlips} opposite-sign flips (${pct(candidate.axes.signFlipRate)}; at most ${pct(limits.maxSignFlipRate)})`,
      ),
      {
        status: "info",
        detail: agreement
          ? `axis sign agreement with ${reference?.arm}: ${pct(agreement.rate)} of ${agreement.pairs} bill-axis pairs`
          : noReference,
      },
    ]),
    gate("G8", "reading level", [
      check(
        candidate.readingGrade === null ? null : candidate.readingGrade <= limits.maxReadingGrade,
        `mean grade ${candidate.readingGrade} (at most ${limits.maxReadingGrade})`,
      ),
      check(
        candidate.readingGrade === null || referenceGrade === null
          ? null
          : candidate.readingGrade <= referenceGrade + limits.maxReadingGradeOverReference,
        reference
          ? `grade vs ${reference.arm} ${referenceGrade} (at most +${limits.maxReadingGradeOverReference})`
          : noReference,
      ),
      check(
        candidate.longSentenceRate === null || referenceLongRate === null
          ? null
          : candidate.longSentenceRate <= referenceLongRate,
        reference
          ? `sentences over ${LONG_SENTENCE_WORDS} words ${pct(candidate.longSentenceRate)} vs ${pct(referenceLongRate)}`
          : noReference,
      ),
    ]),
    gate("G9", "exact strings", [
      check(
        reference ? candidate.exactStrings.compliance >= reference.exactStrings.compliance : null,
        reference
          ? `compliance ${pct(candidate.exactStrings.compliance)} (${candidate.exactStrings.nearMisses} near misses) vs ${pct(reference.exactStrings.compliance)}`
          : noReference,
      ),
    ]),
    manual(
      "G10",
      "blinded human review",
      "Score review.md with rubric.md: neutrality at least 4 on every bill, no unsupported claim, this arm worse on at most 3 bills.",
    ),
    manual("G11", "resolver replay", "npm run eval:compare-priority on at least 40 captured payloads (see README.md)."),
    gate("G12", "cost per bill", [
      check(
        candidate.costPerBillRunUsd === null || referenceCost === null
          ? null
          : candidate.costPerBillRunUsd < referenceCost,
        reference ? `$${candidate.costPerBillRunUsd} per bill-run vs ${reference.arm} $${referenceCost}` : noReference,
      ),
    ]),
  ];
};

/** The gates of a set for one arm against its reference (the stored summaries for E1, Haiku 4.5 for E2). */
export const evaluateGates = (set: GateSet, candidate: ArmSummary, reference: ArmSummary | null): GateResult[] =>
  set === "e1" ? e1Gates(candidate, reference) : e2Gates(candidate, reference);

// ─── Blinded review ───────────────────────────────────────────────────────────

/** A small seeded generator (mulberry32), so a review's order and sides can be rebuilt. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const shuffle = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

export interface ReviewSide {
  arm: string;
  records: readonly BillRunRecord[];
}

export interface ReviewKeyEntry {
  guid: string;
  A: string;
  B: string;
  reasons: string[];
}

// Every refused, fitted or loaded-word bill is reviewed; REL-40 and omnibus bills up to these counts, then random.
const REVIEW_STRATUM_QUOTA = { rel40: 8, omnibus: 6 };

const summaryLines = (record: BillRunRecord | undefined): string[] => {
  if (!record?.analysis) {
    const why = record ? `${record.outcome}${record.error ? `: ${record.error}` : ""}` : "not run";
    return [`_No summary (${why})._`];
  }
  const { analysis } = record;
  const breakdown = analysis.billBreakdown;
  return [
    `**Title:** ${analysis.title}`,
    "",
    `**So what:** ${analysis.soWhat}`,
    "",
    ...(["who", "what", "how", "when", "where", "why"] as const).map(
      (field) => `- **${field[0].toUpperCase()}${field.slice(1)}:** ${breakdown[field]}`,
    ),
    "",
    `**Sub-categories:** ${analysis.subCategories.join(", ") || "none"}. **Life areas:** ${analysis.lifeAreas.join(", ") || "none"}.`,
  ];
};

/**
 * A blinded A/B review of up to `count` bills summarized by both arms (each arm's first run): every bill with a
 * refusal, a fit or a loaded word on either side, some REL-40 and omnibus bills, then random ones. Bills are
 * shuffled and each bill's sides are drawn at random, so the reader cannot tell the arms apart; the key says which
 * side is which.
 */
export const buildBlindReview = (
  left: ReviewSide,
  right: ReviewSide,
  options: { count?: number; seed?: number; textLink?: (record: BillRunRecord) => string | null } = {},
): { markdown: string; key: ReviewKeyEntry[] } => {
  const { count = 30, seed = 40, textLink = (record) => record.textFile } = options;
  const random = seededRandom(seed);
  const firstRuns = (side: ReviewSide): Map<string, BillRunRecord> => {
    const runs = new Map<string, BillRunRecord>();
    for (const record of finishedRuns(side.records.filter((r) => r.arm === side.arm))) {
      const seen = runs.get(record.guid);
      if (!seen || record.run < seen.run) runs.set(record.guid, record);
    }
    return runs;
  };
  const leftRuns = firstRuns(left);
  const rightRuns = firstRuns(right);
  const guids = [...leftRuns.keys()].filter((guid) => rightRuns.has(guid)).sort();
  const both = (guid: string): BillRunRecord[] => [leftRuns.get(guid)!, rightRuns.get(guid)!];

  const reasons = new Map<string, string[]>();
  const pick = (guid: string, reason: string): void => {
    if (!reasons.has(guid) && reasons.size >= count) return;
    reasons.set(guid, [...(reasons.get(guid) ?? []), reason]);
  };
  for (const guid of guids) {
    const records = both(guid);
    if (records.some((r) => r.attempts.some((attempt) => attempt.outcome === "refusal"))) pick(guid, "refusal");
    if (records.some((r) => r.repairs.length > 0)) pick(guid, "fitted");
    if (records.some((r) => (r.score?.loadedWords.length ?? 0) > 0)) pick(guid, "loaded words");
  }
  for (const [stratum, quota] of [
    ["rel40", REVIEW_STRATUM_QUOTA.rel40],
    ["omnibus", REVIEW_STRATUM_QUOTA.omnibus],
  ] as const) {
    const matching = guids.filter((guid) => {
      const record = leftRuns.get(guid)!;
      return !reasons.has(guid) && (stratum === "rel40" ? record.stratum === "rel40" : record.size === "omnibus");
    });
    for (const guid of shuffle(matching, random).slice(0, quota)) pick(guid, stratum);
  }
  for (const guid of shuffle(
    guids.filter((guid) => !reasons.has(guid)),
    random,
  )) {
    if (reasons.size >= count) break;
    pick(guid, "random");
  }

  const key: ReviewKeyEntry[] = [];
  const sections = shuffle([...reasons.keys()], random).map((guid, index) => {
    const [leftRecord, rightRecord] = both(guid);
    const leftIsA = random() < 0.5;
    key.push({
      guid,
      A: leftIsA ? left.arm : right.arm,
      B: leftIsA ? right.arm : left.arm,
      reasons: reasons.get(guid)!,
    });
    const [a, b] = leftIsA ? [leftRecord, rightRecord] : [rightRecord, leftRecord];
    const link = textLink(leftRecord);
    return [
      `## ${index + 1}. ${guid}`,
      "",
      `${leftRecord.label ?? ""}${leftRecord.label ? ". " : ""}Text the model saw: ${link ? `[${link}](${link})` : "not saved"} (textComplete ${leftRecord.textComplete}).`,
      "",
      "### Summary A",
      "",
      ...summaryLines(a),
      "",
      "### Summary B",
      "",
      ...summaryLines(b),
      "",
      "| | A | B |",
      "|---|---|---|",
      "| Factual accuracy (0-2) | | |",
      "| Neutrality (1-5) | | |",
      "| Complete for a long bill (yes/no) | | |",
      "| Incomplete text said so (yes/no) | | |",
      "| Stated purpose (yes/no) | | |",
      "| Unsupported claims (count) | | |",
      "",
      "Worse summary (A, B or neither):",
      "",
    ].join("\n");
  });

  const markdown = [
    "# Blinded summary review",
    "",
    `${key.length} bills, each summarized two ways. Score both summaries with the manual review in scripts/eval/rubric.md, judging accuracy against the text the model saw (linked per bill), not the whole bill. The sides are drawn at random per bill; review-key.json says which is which, so read it only after scoring.`,
    "",
    ...sections,
  ].join("\n");
  return { markdown, key };
};

// ─── Probes ───────────────────────────────────────────────────────────────────

/**
 * The previous answer for a corrective probe, from a saved Bedrock response body (probe:bedrock's response.json), a
 * {"bills": [...]} answer, or one analysis object. Undefined when it holds no analysis for the bill.
 */
export const previousAnalysis = (json: unknown, guid: string): unknown => {
  if (isRecord(json) && Array.isArray(json.content)) {
    const read = readMessagesResponse(json);
    return interpretModelOutput(read.text, read.stopReason, [guid]).analyses.get(guid);
  }
  if (isRecord(json) && Array.isArray(json.bills)) {
    return interpretModelOutput(JSON.stringify(json), "end_turn", [guid]).analyses.get(guid);
  }
  return isRecord(json) ? json : undefined;
};

/**
 * Issues named on the command line ("billBreakdown.how:max_chars,soWhat:max_sentences,title:missing"), measured on
 * the previous answer, for a corrective probe whose previous answer broke no rule.
 */
export const parseIssueSpecs = (spec: string, previous: unknown): AnalysisIssue[] =>
  spec
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item): AnalysisIssue => {
      const [field, rule] = item.split(":");
      if (!(ANALYSIS_TEXT_FIELDS as readonly string[]).includes(field)) {
        throw new Error(`--issues: unknown field "${field}" (one of ${ANALYSIS_TEXT_FIELDS.join(", ")})`);
      }
      if (rule === "missing") return { field, kind: "hard", rule };
      if (rule !== "max_chars" && !(rule === "max_sentences" && field === "soWhat")) {
        throw new Error(`--issues: "${item}" needs the rule max_chars, missing, or max_sentences (soWhat only)`);
      }
      const text = answerFieldText(previous, field);
      return { field, kind: "soft", rule, chars: text.length, sentences: countSentences(text), text };
    });

// ─── Resolver replay ──────────────────────────────────────────────────────────

/** A priority_request log line: what the resolver showed the model in one run. */
export interface PriorityRequestCapture {
  now: string;
  maxResults: number;
  payload: PriorityPromptPayload;
}

// The logger's JSON object in a line, after any Lambda prefix ("<time>\t<request id>\tINFO\t{...}").
const loggerObject = (item: unknown): unknown => {
  if (Array.isArray(item)) {
    const message = item.find((field) => isRecord(field) && field.field === "@message");
    return loggerObject(isRecord(message) ? message.value : undefined);
  }
  if (isRecord(item)) return typeof item["@message"] === "string" ? loggerObject(item["@message"]) : item;
  if (typeof item !== "string" || !item.includes("{")) return undefined;
  try {
    return JSON.parse(item.slice(item.indexOf("{")));
  } catch {
    return undefined;
  }
};

/**
 * Reads priority_request lines as CloudWatch Logs exports them: JSON lines (the logger's lines, or rows with an
 * @message), a JSON array of either, or `aws logs get-query-results` output. Lines that are not a priority_request
 * with headlines and candidates are counted as skipped; repeated runs (the same `now`) are read once.
 */
export const parsePriorityRequests = (text: string): { captures: PriorityRequestCapture[]; skipped: number } => {
  let items: unknown[];
  try {
    const whole = JSON.parse(text) as unknown;
    items = Array.isArray(whole) ? whole : isRecord(whole) && Array.isArray(whole.results) ? whole.results : [whole];
  } catch {
    items = text.split("\n").filter((line) => line.trim());
  }
  const captures: PriorityRequestCapture[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of items) {
    let parsed: unknown = item;
    if (typeof item === "string") {
      try {
        parsed = JSON.parse(item);
      } catch {
        parsed = item;
      }
    }
    const line = loggerObject(parsed);
    const payload = isRecord(line) ? line.payload : undefined;
    if (
      !isRecord(line) ||
      line.event !== "priority_request" ||
      typeof line.now !== "string" ||
      !isRecord(payload) ||
      !Array.isArray(payload.headlines) ||
      !Array.isArray(payload.candidates)
    ) {
      skipped += 1;
      continue;
    }
    const maxResults = typeof line.maxResults === "number" ? line.maxResults : Number(payload.maxResults);
    if (!Number.isInteger(maxResults) || maxResults < 1) {
      skipped += 1;
      continue;
    }
    if (seen.has(line.now)) continue;
    seen.add(line.now);
    captures.push({ now: line.now, maxResults, payload: payload as unknown as PriorityPromptPayload });
  }
  return { captures, skipped };
};

/** The resolver's thresholds for activating a bill (PRIORITY_MIN_SCORE, PRIORITY_MIN_CONFIDENCE). */
export const PRIORITY_MIN_SCORE = 75;
export const PRIORITY_MIN_CONFIDENCE = 0.55;

/**
 * The guids the resolver would activate from these decisions: priority, at or above both thresholds, a candidate,
 * ranked by score then confidence. The handler breaks the remaining ties by its heuristic score, which the logged
 * payload does not carry; here they break by guid.
 */
export const activatedGuids = (
  decisions: readonly BedrockPriorityDecision[],
  candidateGuids: ReadonlySet<string>,
  maxResults: number,
): string[] =>
  decisions
    .filter(
      (decision) =>
        decision.isPriority &&
        decision.score >= PRIORITY_MIN_SCORE &&
        decision.confidence >= PRIORITY_MIN_CONFIDENCE &&
        candidateGuids.has(decision.guid),
    )
    .sort(
      (left, right) =>
        right.score - left.score || right.confidence - left.confidence || left.guid.localeCompare(right.guid),
    )
    .slice(0, maxResults)
    .map((decision) => decision.guid);

export type PriorityNoAnswerReason = "refusal" | "max_tokens" | "incomplete" | "empty" | "unparseable";

/** What the resolver makes of an answer (askModel): its decisions, or why it has none. */
export const priorityAnswer = (
  read: Pick<ReadResponse, "outcome" | "text">,
): { answered: true; decisions: BedrockPriorityDecision[] } | { answered: false; reason: PriorityNoAnswerReason } => {
  const hasText = read.text.trim().length > 0;
  const parsed = read.outcome === "ok" && hasText ? parseBedrockResponse(read.text) : null;
  if (parsed) return { answered: true, decisions: parsed.bills };
  return { answered: false, reason: read.outcome !== "ok" ? read.outcome : hasText ? "unparseable" : "empty" };
};

/** |A ∩ B| / |A ∪ B|; 1 when both are empty (both activate nothing). */
export const jaccard = (left: readonly string[], right: readonly string[]): number => {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  const rightSet = new Set(right);
  return [...new Set(left)].filter((guid) => rightSet.has(guid)).length / union.size;
};

/** One replayed payload on one arm, a line of the replay's calls.jsonl. */
export interface ReplayRecord {
  index: number;
  arm: string;
  now: string;
  candidates: number;
  /** The answer's outcome, or the error kind when none came back. */
  outcome: string;
  answered: boolean;
  noAnswerReason: string | null;
  decisions: number;
  activated: string[];
  usage: MessagesUsage | null;
  latencyMs: number | null;
  costUsd: number;
  error: string | null;
}

export interface ReplayArmSummary {
  arm: string;
  payloads: number;
  answered: number;
  noAnswers: Record<string, number>;
  errors: number;
  activated: number;
  inputTokens: number;
  outputTokens: number;
  outputTokensP95: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyMaxMs: number | null;
  costUsd: number;
}

/** G11 (rubric.md): what the candidate model must do on the replayed payloads. */
export const REPLAY_LIMITS = {
  maxNoAnswers: 0,
  minMeanJaccard: 0.5,
  maxActivationChange: 0.5,
  maxLatencyP95Ms: 30_000,
};

const summarizeReplayArm = (arm: string, records: readonly ReplayRecord[]): ReplayArmSummary => {
  const own = records.filter((record) => record.arm === arm);
  const latencies = own.map((record) => record.latencyMs).filter((ms): ms is number => typeof ms === "number");
  const outputs = own.map((record) => record.usage?.output).filter((t): t is number => typeof t === "number");
  const noAnswers: Record<string, number> = {};
  for (const record of own) {
    if (record.noAnswerReason) noAnswers[record.noAnswerReason] = (noAnswers[record.noAnswerReason] ?? 0) + 1;
  }
  return {
    arm,
    payloads: own.length,
    answered: own.filter((record) => record.answered).length,
    noAnswers,
    errors: own.filter((record) => record.error !== null).length,
    activated: own.reduce((sum, record) => sum + record.activated.length, 0),
    inputTokens: own.reduce((sum, record) => sum + (record.usage?.input ?? 0), 0),
    outputTokens: outputs.reduce((sum, tokens) => sum + tokens, 0),
    outputTokensP95: percentile(outputs, 95),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyMaxMs: latencies.length === 0 ? null : Math.max(...latencies),
    costUsd: round(
      own.reduce((sum, record) => sum + record.costUsd, 0),
      4,
    )!,
  };
};

/** Both arms on the replayed payloads, how far the candidate's picks overlap the reference's, and G11. */
export const summarizeReplay = (records: readonly ReplayRecord[], reference: string, candidate: string) => {
  const referenceSummary = summarizeReplayArm(reference, records);
  const candidateSummary = summarizeReplayArm(candidate, records);
  const byIndex = (arm: string) =>
    new Map(records.filter((record) => record.arm === arm).map((record) => [record.index, record]));
  const referenceRuns = byIndex(reference);
  const candidateRuns = byIndex(candidate);
  const pairs = [...referenceRuns.keys()]
    .filter((index) => referenceRuns.get(index)!.answered && candidateRuns.get(index)?.answered)
    .map((index) => ({
      index,
      jaccard: jaccard(referenceRuns.get(index)!.activated, candidateRuns.get(index)!.activated),
      countDelta: candidateRuns.get(index)!.activated.length - referenceRuns.get(index)!.activated.length,
    }));
  const meanJaccard = round(mean(pairs.map((pair) => pair.jaccard)));
  const activationChange =
    referenceSummary.activated === 0
      ? candidateSummary.activated === 0
        ? 0
        : null
      : (candidateSummary.activated - referenceSummary.activated) / referenceSummary.activated;
  const candidateNoAnswers = candidateSummary.payloads - candidateSummary.answered;
  const g11 = gate("G11", "resolver replay", [
    check(
      candidateNoAnswers <= REPLAY_LIMITS.maxNoAnswers,
      `${candidateNoAnswers} of ${candidateSummary.payloads} payloads without a usable answer ${JSON.stringify(candidateSummary.noAnswers)}`,
    ),
    check(
      meanJaccard === null ? null : meanJaccard >= REPLAY_LIMITS.minMeanJaccard,
      `mean Jaccard of activated bills ${meanJaccard} over ${pairs.length} payloads both answered (at least ${REPLAY_LIMITS.minMeanJaccard})`,
    ),
    check(
      activationChange === null ? false : Math.abs(activationChange) <= REPLAY_LIMITS.maxActivationChange,
      `${candidateSummary.activated} activations vs ${referenceSummary.activated} (${activationChange === null ? "none before" : pct(activationChange)}; within ±${pct(REPLAY_LIMITS.maxActivationChange)})`,
    ),
    check(
      candidateSummary.latencyP95Ms === null ? null : candidateSummary.latencyP95Ms <= REPLAY_LIMITS.maxLatencyP95Ms,
      `p95 latency ${seconds(candidateSummary.latencyP95Ms)} (at most ${seconds(REPLAY_LIMITS.maxLatencyP95Ms)})`,
    ),
  ]);
  return { reference: referenceSummary, candidate: candidateSummary, meanJaccard, pairs, activationChange, gate: g11 };
};
