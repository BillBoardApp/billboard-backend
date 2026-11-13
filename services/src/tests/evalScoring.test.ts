import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

const mockBedrockSend = jest.fn();
jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import type { AnalysisAttempt } from "../handlers/billSummarizer/analyzeBill";
import {
  NO_STATED_PURPOSE,
  buildBedrockRequestBody,
  extractMinimalBillInfo,
  getCorrectionPrompt,
  validateAnalysis,
  type BedrockBillAnalysis,
} from "../handlers/billSummarizer/prompts";
import { buildPriorityPayload, buildPriorityRequestBody } from "../handlers/billPriorityResolver/prompts";
import type { RawBill } from "../models/bill";
import { sourceTextHash } from "../shared/billSourceReconcile";
import { parseArgs as parseCompareArgs, main as compareMain } from "../../scripts/comparePriorityModels";
import { DEFAULTS, parseArgs as parseEvalArgs, main as evalMain } from "../../scripts/evalSummaries";
import { parseArgs as parseProbeArgs, main as probeMain } from "../../scripts/probeBedrockModel";
import {
  BASELINE_ARM,
  DEFAULT_PRICES,
  GATE_LIMITS,
  SpendCap,
  activatedGuids,
  axisSignAgreement,
  buildBlindReview,
  evaluateGates,
  exactStringUse,
  expectedCall,
  jaccard,
  longSoWhats,
  parseArm,
  parseBillsFile,
  parseIssueSpecs,
  parsePriorityRequests,
  percentile,
  previousAnalysis,
  priorityAnswer,
  pricesFromEnv,
  readingGrade,
  requestTextChars,
  scoreAnalysis,
  summarizeArm,
  summarizeReplay,
  tagChanges,
  usageCostUsd,
  worstCaseCallUsd,
  type ArmSummary,
  type BillRunRecord,
  type CallRecord,
  type GateResult,
  type ReplayRecord,
} from "../../scripts/eval/scoring";

const H45 = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const H55 = "us.anthropic.claude-haiku-5-5";
const H45_ARM = `${H45}:default`;
const H55_ARM = `${H55}:medium`;
const EVAL_DIR = path.join(__dirname, "../../scripts/eval");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type Analysis = Record<string, unknown>;

const analysis = (guid: string, overrides: Analysis = {}): Analysis => ({
  guid,
  title: "Funds grants for rural broadband",
  billBreakdown: {
    who: "Rural internet providers.",
    what: "Creates a grant program.",
    how: "The Secretary gives grants.",
    when: "The provided text does not say.",
    where: "Rural areas.",
    why: "The bill states its purpose is rural broadband.",
  },
  soWhat: "Rural homes could get faster internet.",
  subCategories: ["Telecommunications"],
  lifeAreas: ["Digital Services"],
  civicProfile: { localVsFederal: 0.5 },
  ...overrides,
});

const validated = (candidate: Analysis): BedrockBillAnalysis => {
  const result = validateAnalysis(candidate);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.analysis;
};

const LONG_HOW = "The Secretary awards grants to rural providers for new lines. ".repeat(9).trim();

const billXml = (guid: string) =>
  `<?xml version="1.0"?><bill><metadata><dublinCore><dc:title>${guid}</dc:title></dublinCore></metadata><form><legis-type>A BILL</legis-type><official-title>To support rural broadband (${guid}).</official-title></form><legis-body><section><enum>1.</enum><header>Short title</header><text>This Act may be cited as the Test Act for ${guid}.</text></section><section><enum>2.</enum><header>Grants</header><text>The Secretary shall award grants to rural providers.</text></section></legis-body></bill>`;

const rawBill = (guid: string, party = "R") => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-09-01T00:00:00Z",
  identifier: { congress: "119", billType: "hr", billNumber: guid.replace(/\D+/g, "").slice(3) },
  metadata: { guid, title: `Test Act ${guid}`, pubDate: "", legislationUrl: "", fetchedAt: "" },
  content: { billXML: billXml(guid), bill: { bill: { sponsors: [{ bioguideId: "S000001", party }] } } },
});

/** An InvokeModel response: the text as one text block, or the content blocks as given. */
const bedrockResponse = (
  content: string | Array<Record<string, unknown>>,
  stopReason = "end_turn",
  usage = { input_tokens: 1200, output_tokens: 300 },
  stopDetails: Record<string, unknown> | null = null,
) => ({
  $metadata: { httpStatusCode: 200 },
  body: new TextEncoder().encode(
    JSON.stringify({
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
      stop_reason: stopReason,
      stop_details: stopDetails,
      usage,
    }),
  ),
});

const billsJson = (...analyses: Analysis[]) => JSON.stringify({ bills: analyses });

const sentBody = (call: unknown[]) => JSON.parse((call[0] as { input: { body: string } }).input.body);

const guidInBody = (body: { messages: Array<{ content: Array<{ text: string }> }> }): string =>
  body.messages[0].content[0].text.match(/"guid":"(BILLS-[^"]+)"/)![1];

const record = (overrides: Partial<BillRunRecord> = {}): BillRunRecord => {
  const stored = validated(analysis(overrides.guid ?? "BILLS-119hr1"));
  return {
    run: 1,
    arm: H45_ARM,
    guid: "BILLS-119hr1",
    label: null,
    stratum: "bills",
    chamber: "House",
    party: "R",
    size: "short",
    textComplete: true,
    outcome: "stored",
    error: null,
    attempts: [{ kind: "first", outcome: "valid" }],
    calls: 1,
    chainMs: 5_000,
    revised: false,
    reducedInput: false,
    repairs: [],
    analysis: stored,
    score: scoreAnalysis(stored),
    tags: null,
    longSoWhats: [],
    events: [],
    costUsd: 0.004,
    textFile: `texts/${overrides.guid ?? "BILLS-119hr1"}.txt`,
    ...overrides,
  };
};

const call = (overrides: Partial<CallRecord> = {}): CallRecord => ({
  run: 1,
  arm: H45_ARM,
  modelId: H45,
  effort: "default",
  kind: "first",
  guids: ["BILLS-119hr1"],
  bodySha256: "sha",
  outcome: "ok",
  stopReason: "end_turn",
  refusalCategory: null,
  contentTypes: ["text"],
  thinkingBlocks: 0,
  usage: { input: 6_000, output: 500, cacheRead: null, cacheCreation: null },
  latencyMs: 5_000,
  attempt: 0,
  errorName: null,
  httpStatus: null,
  estimatedUsd: 0.01,
  costUsd: 0.0094,
  ...overrides,
});

const softIssue = (field = "billBreakdown.how", chars = 534) => ({
  field,
  kind: "soft" as const,
  rule: "max_chars" as const,
  chars,
  sentences: 4,
  text: "x".repeat(chars),
});

const statusOf = (results: GateResult[], id: string) => results.find((result) => result.id === id)?.status;

let consoleLines: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  mockS3 = new FakeVersionedS3();
  mockBedrockSend.mockReset();
  delete process.env.CI;
  delete process.env.EVAL_PRICE_HAIKU_4_5;
  delete process.env.EVAL_PRICE_HAIKU_5_5;
  consoleLines = [];
  const capture = (...parts: unknown[]) => {
    consoleLines.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
  };
  jest.spyOn(console, "log").mockImplementation(capture);
  jest.spyOn(console, "warn").mockImplementation(capture);
  jest.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...savedEnv };
});

// ─── Bill lists ───────────────────────────────────────────────────────────────

describe("bill lists", () => {
  const read = (name: string) => parseBillsFile(readFileSync(path.join(EVAL_DIR, name), "utf8"), name);
  const REL40 = [
    ...["s2402", "hr2913", "hr5334", "hr6783", "hr7032", "s1829", "hr6972", "s3447", "s2312", "s1795", "s3491"],
    ...["s3399", "s3304", "s3495", "hr1329", "hr1422", "hr1346", "hr2004", "hr2853", "hr3077", "hr3296", "hr4418"],
    ...["hr4915", "hr5267", "hr5438", "hr556", "hr6818", "hr6350"],
    // Rejected after the corrective during the U9b cosponsor refetch, 2026-10-11/12.
    ...["hr7335", "hr903", "hr8957", "hr9036", "hr8811", "hres1286", "s2511", "s3948", "hr7973", "sres852"],
  ].map((bill) => `BILLS-119${bill}`);

  it("rel40-bills.json holds the 38 REL-40 bills", () => {
    const { entries, problems } = read("rel40-bills.json");
    expect(problems).toEqual([]);
    expect(entries.map((entry) => entry.guid)).toEqual(REL40);
    expect(new Set(entries.map((entry) => entry.stratum))).toEqual(new Set(["rel40"]));
  });

  it("llm11-core.json is rel40-bills.json followed by bills.json", () => {
    const core = read("llm11-core.json");
    expect(core.problems).toEqual([]);
    expect(core.entries).toEqual([...read("rel40-bills.json").entries, ...read("bills.json").entries]);
  });

  it("llm11-bills.json is the core plus 60 sampled bills of every type and 12 classifier probes", () => {
    const all = read("llm11-bills.json");
    const core = read("llm11-core.json");
    expect(all.problems).toEqual([]);
    expect(all.entries.slice(0, core.entries.length)).toEqual(core.entries);
    const added = all.entries.slice(core.entries.length);
    expect(added).toHaveLength(72);
    expect(added.filter((entry) => entry.stratum === "classifier-probe")).toHaveLength(12);
    expect(added.filter((entry) => entry.stratum?.startsWith("sample-"))).toHaveLength(60);
    expect(new Set(all.entries.map((entry) => entry.guid.match(/^BILLS-\d+([a-z]+)\d+$/)![1]))).toEqual(
      new Set(["hr", "s", "hres", "sres", "hjres", "sjres", "hconres", "sconres"]),
    );
    expect(all.entries.every((entry) => entry.label)).toBe(true);
  });

  it("names the stratum after the file and skips invalid or repeated entries", () => {
    const parsed = parseBillsFile(
      JSON.stringify({ bills: [{ guid: "BILLS-119hr1" }, { guid: "BILLS-119hr1" }, { guid: "hr2" }, null] }),
      "/tmp/my-list.json",
    );
    expect(parsed.entries).toEqual([{ guid: "BILLS-119hr1", stratum: "my-list" }]);
    expect(parsed.problems).toHaveLength(3);
    expect(() => parseBillsFile("{}", "x.json")).toThrow('x.json has no "bills" list');
  });
});

// ─── Arms and options ─────────────────────────────────────────────────────────

describe("parseArm", () => {
  it("splits at the last colon, so a model ID may contain one", () => {
    expect(parseArm(H45_ARM)).toEqual({ name: H45_ARM, modelId: H45, effort: "default", profile: "haiku-4-5" });
    expect(parseArm(`${H55}:low`)).toEqual({ name: `${H55}:low`, modelId: H55, effort: "low", profile: "haiku-5-5" });
  });

  it("rejects a missing or unknown effort, an unknown model and an effort on Haiku 4.5", () => {
    expect(() => parseArm(H45)).toThrow("--arm takes <modelId>:<effort>");
    expect(() => parseArm(`${H55}:max`)).toThrow("--arm takes <modelId>:<effort>");
    expect(() => parseArm("anthropic.claude-sonnet-4-5:default")).toThrow("Unknown Bedrock model profile");
    expect(() => parseArm(`${H45}:medium`)).toThrow(`Haiku 4.5 takes no effort: use ${H45}:default`);
  });
});

describe("evalSummaries parseArgs", () => {
  it("defaults to production's shape: the infra model, one bill per call, the ladder, no spending", () => {
    const args = parseEvalArgs([]);
    expect(args.arms.map((arm) => arm.name)).toEqual([H45_ARM]);
    expect(args).toMatchObject({
      yes: false,
      maxUsd: null,
      runsPerArm: DEFAULTS.runsPerArm,
      batchSize: 1,
      concurrency: 3,
      emulateProduction: true,
      baselineStored: false,
      report: [],
    });
    expect(args.billsFile).toBe(path.join(EVAL_DIR, "bills.json"));
  });

  it("reads repeated arms and the other options", () => {
    const args = parseEvalArgs([
      ...["--arm", H45_ARM, "--arm", `${H55}:high`, "--bills-file", "x.json", "--runs-per-arm", "3"],
      ...["--batch-size", "5", "--concurrency", "2", "--limit", "4", "--baseline-stored", "--no-emulate-production"],
      ...["--gates", "e2", "--reference", H45_ARM, "--out", "out", "--yes", "--max-usd", "3.5"],
    ]);
    expect(args.arms.map((arm) => arm.name)).toEqual([H45_ARM, `${H55}:high`]);
    expect(args).toMatchObject({
      billsFile: path.resolve("x.json"),
      runsPerArm: 3,
      batchSize: 5,
      concurrency: 2,
      limit: 4,
      baselineStored: true,
      emulateProduction: false,
      gates: "e2",
      reference: H45_ARM,
      out: path.resolve("out"),
      yes: true,
      maxUsd: 3.5,
    });
    expect(parseEvalArgs(["--runs", "2", "--bills", "y.json", "--exclude-bills", "z.json"])).toMatchObject({
      runsPerArm: 2,
      billsFile: path.resolve("y.json"),
      excludeBillsFile: path.resolve("z.json"),
    });
  });

  it("will not spend without a cap, and rejects bad values and unknown flags", () => {
    expect(() => parseEvalArgs(["--yes"])).toThrow("--yes needs --max-usd");
    expect(() => parseEvalArgs(["--max-usd", "0"])).toThrow("--max-usd must be a positive number");
    expect(() => parseEvalArgs(["--max-usd", "lots"])).toThrow("--max-usd must be a positive number");
    expect(() => parseEvalArgs(["--runs-per-arm", "1.5"])).toThrow("--runs-per-arm must be a positive integer");
    expect(() => parseEvalArgs(["--max-usd"])).toThrow("Missing value for --max-usd");
    expect(() => parseEvalArgs(["--arm", "--yes"])).toThrow("Missing value for --arm");
    expect(() => parseEvalArgs(["--gates", "e3"])).toThrow("--gates takes e1 or e2");
    expect(() => parseEvalArgs(["--temperature", "0"])).toThrow("Unknown argument: --temperature");
    expect(() => parseEvalArgs(["--arm", H45_ARM, "--arm", H45_ARM])).toThrow("is given twice");
    expect(() => parseEvalArgs(["--write-bodies", "b", "--yes", "--max-usd", "1"])).toThrow("drop --yes");
  });

  it("--report scores results and takes no run options", () => {
    expect(parseEvalArgs(["--report", "a", "--report", "b", "--gates", "e1"])).toMatchObject({
      report: [path.resolve("a"), path.resolve("b")],
      arms: [],
      gates: "e1",
    });
    expect(() => parseEvalArgs(["--report", "a", "--arm", H45_ARM])).toThrow("drop --arm");
    expect(() => parseEvalArgs(["--report", "a", "--yes", "--max-usd", "1"])).toThrow("drop --yes, --max-usd");
  });
});

// ─── Cost ─────────────────────────────────────────────────────────────────────

describe("cost", () => {
  const body = (maxTokens = 1_000) => ({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: maxTokens,
    system: "s".repeat(400),
    messages: [
      { role: "user", content: [{ type: "text", text: "u".repeat(300) }] },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(100) }] },
    ],
  });
  const h45 = DEFAULT_PRICES["haiku-4-5"];
  const h55 = DEFAULT_PRICES["haiku-5-5"];

  it("counts the system prompt and every text block", () => {
    expect(requestTextChars(body())).toBe(800);
    expect(requestTextChars({ ...body(), system: undefined, messages: [{ role: "user", content: "plain" }] })).toBe(5);
  });

  it("expects chars/4 in and the visible answer out on Haiku 4.5", () => {
    expect(expectedCall(body(8_192), { profile: "haiku-4-5", effort: "default" }, h45, 700)).toEqual({
      inputTokens: 200,
      outputTokens: 700,
      usd: (200 * 1.1 + 700 * 5.5) / 1_000_000,
    });
  });

  it("expects 1.3 times the tokens plus thinking at the effort on Haiku 5.5, within max_tokens", () => {
    expect(expectedCall(body(8_192), { profile: "haiku-5-5", effort: "low" }, h55, 700)).toMatchObject({
      inputTokens: 260,
      outputTokens: 910 + 500,
    });
    expect(expectedCall(body(8_192), { profile: "haiku-5-5", effort: "high" }, h55, 700).outputTokens).toBe(3_910);
    expect(expectedCall(body(8_192), { profile: "haiku-5-5", effort: "default" }, h55, 700).outputTokens).toBe(2_410);
    expect(expectedCall(body(1_000), { profile: "haiku-5-5", effort: "medium" }, h55, 700).outputTokens).toBe(1_000);
  });

  it("puts the worst case at chars/3 in and every max_tokens token out", () => {
    expect(worstCaseCallUsd(body(1_000), "haiku-4-5", h45)).toBeCloseTo((267 * 1.1 + 1_000 * 5.5) / 1_000_000, 12);
    expect(worstCaseCallUsd(body(1_000), "haiku-5-5", h55)).toBeCloseTo((347 * 0.11 + 1_000 * 0.55) / 1_000_000, 12);
  });

  it("prices usage, and gives null when a count is missing", () => {
    expect(usageCostUsd({ input: 1_000, output: 200, cacheRead: null, cacheCreation: null }, h45)).toBeCloseTo(
      0.0022,
      10,
    );
    expect(usageCostUsd({ input: 1_000, output: null, cacheRead: null, cacheCreation: null }, h45)).toBeNull();
  });

  it("takes price overrides from the environment", () => {
    expect(pricesFromEnv({ EVAL_PRICE_HAIKU_5_5: "0.2/1" })).toEqual({
      "haiku-4-5": DEFAULT_PRICES["haiku-4-5"],
      "haiku-5-5": { input: 0.2, output: 1 },
    });
    expect(() => pricesFromEnv({ EVAL_PRICE_HAIKU_4_5: "1.1" })).toThrow("EVAL_PRICE_HAIKU_4_5 must be");
    expect(() => pricesFromEnv({ EVAL_PRICE_HAIKU_4_5: "1/2/3" })).toThrow("EVAL_PRICE_HAIKU_4_5 must be");
    expect(() => pricesFromEnv({ EVAL_PRICE_HAIKU_4_5: "0/5" })).toThrow("EVAL_PRICE_HAIKU_4_5 must be");
  });

  it("SpendCap lets a call start only when its worst case fits beside the spend and calls in flight", () => {
    const cap = new SpendCap(1);
    expect(cap.tryReserve(0.6)).toBe(true);
    expect(cap.tryReserve(0.5)).toBe(false);
    cap.settle(0.6, 0.1);
    expect(cap.spentUsd).toBeCloseTo(0.1);
    expect(cap.tryReserve(0.5)).toBe(true);
    expect(cap.tryReserve(0.5)).toBe(false);
    expect(cap.tryReserve(0.4)).toBe(true);
    cap.settle(0.5, 0.5);
    cap.settle(0.4, 0.4);
    expect(cap.spentUsd).toBeCloseTo(1);
    expect(cap.tryReserve(0.000001)).toBe(false);
  });
});

// ─── Scores ───────────────────────────────────────────────────────────────────

describe("scoring one analysis", () => {
  it("measures each field, loaded words, long sentences and the reading grade", () => {
    const longSentence = `Many ${"more ".repeat(20).trim()} words here.`;
    const score = scoreAnalysis(
      validated(analysis("BILLS-119hr1", { soWhat: `This radical change matters. ${longSentence}` })),
    );
    expect(score.fields.title).toEqual({ chars: 32, sentences: 1 });
    expect(score.fields.soWhat.sentences).toBe(2);
    expect(score.fields["billBreakdown.when"]).toEqual({ chars: 31, sentences: 1 });
    expect(score.loadedWords).toEqual(["radical"]);
    expect(score.titleWords).toBe(5);
    expect(score.longSentences).toBe(1);
    expect(score.sentences).toBe(9);
    expect(typeof score.readingGrade).toBe("number");
    expect(readingGrade([])).toBeNull();
  });

  it("counts exact strings and the near misses that should have been one", () => {
    const breakdown = (overrides: Record<string, string>) =>
      validated(
        analysis("BILLS-119hr1", { billBreakdown: { ...(analysis("x").billBreakdown as object), ...overrides } }),
      );
    expect(exactStringUse(breakdown({ where: "Not Applicable", why: NO_STATED_PURPOSE }))).toEqual({
      uses: 3,
      nearMisses: [],
    });
    expect(
      exactStringUse(
        breakdown({ where: "Not applicable.", when: "Text does not say", why: "The bill does not state its purpose" }),
      ),
    ).toEqual({
      uses: 0,
      nearMisses: [
        { field: "billBreakdown.where", text: "Not applicable." },
        { field: "billBreakdown.when", text: "Text does not say" },
        { field: "billBreakdown.why", text: "The bill does not state its purpose" },
      ],
    });
    expect(exactStringUse(breakdown({ when: "The provided text does not say when this starts." })).uses).toBe(0);
  });

  it("lists the tags the validator dropped, a former sub-category name counting as kept", () => {
    const candidate = analysis("BILLS-119hr1", {
      subCategories: ["Telecommunications", "Made Up", "Telecommunications", "Social Justice"],
      lifeAreas: ["Digital Services", 7],
    });
    expect(tagChanges(candidate, validated(candidate))).toEqual({
      subCategories: {
        kept: ["Telecommunications", "Civil Rights and Liberties"],
        dropped: ["Made Up", "Telecommunications"],
      },
      lifeAreas: { kept: ["Digital Services"], dropped: ["7"] },
    });
    expect(tagChanges(undefined, validated(candidate)).subCategories.dropped).toEqual([]);
  });

  it("keeps each over-long soWhat once per answer", () => {
    const text = "One. Two. Three.";
    const attempts: AnalysisAttempt[] = [
      {
        kind: "first",
        outcome: "issues",
        issues: [
          { field: "soWhat", kind: "soft", rule: "max_chars", chars: 300, sentences: 3, text },
          { field: "soWhat", kind: "soft", rule: "max_sentences", chars: 300, sentences: 3, text },
          softIssue(),
        ],
      },
      { kind: "corrective", outcome: "valid" },
    ];
    expect(longSoWhats(attempts)).toEqual([{ attempt: "first", sentences: 3, text }]);
  });

  it("takes nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([3, 1, 2], 99)).toBe(3);
    expect(percentile([], 50)).toBeNull();
  });
});

// ─── Summaries and gates ──────────────────────────────────────────────────────

describe("summarizeArm", () => {
  const fitted = {
    field: "billBreakdown.how",
    rules: ["max_chars" as const],
    method: "words" as const,
    beforeChars: 534,
    afterChars: 399,
    beforeSentences: 1,
    afterSentences: 1,
    original: "x",
  };

  it("counts outcomes, first answers, repairs, axes, calls and cost", () => {
    const withAxis = (guid: string, run: number, value: number, overrides: Partial<BillRunRecord> = {}) => {
      const stored = validated(analysis(guid, { civicProfile: { localVsFederal: value } }));
      return record({ guid, run, analysis: stored, score: scoreAnalysis(stored), ...overrides });
    };
    const records = [
      withAxis("BILLS-119hr1", 1, 0.5, { stratum: "rel40" }),
      withAxis("BILLS-119hr1", 2, -0.25, {
        stratum: "rel40",
        attempts: [
          { kind: "first", outcome: "issues", issues: [softIssue()] },
          { kind: "corrective", outcome: "valid" },
        ],
        revised: true,
      }),
      withAxis("BILLS-119hr2", 1, 0.25, { party: "D", repairs: [fitted] }),
      withAxis("BILLS-119hr2", 2, 0.25, { party: "D" }),
      record({
        guid: "BILLS-119hr3",
        stratum: "rel40",
        outcome: "failed",
        error: "cut off",
        analysis: null,
        score: null,
        attempts: [{ kind: "first", outcome: "no_analysis" }],
      }),
      record({
        guid: "BILLS-119hr4",
        outcome: "refused",
        analysis: null,
        score: null,
        attempts: [
          { kind: "first", outcome: "refusal", refusalCategory: "cyber" },
          { kind: "refusal_retry", outcome: "refusal", refusalCategory: null },
        ],
      }),
      record({ guid: "BILLS-119hr5", outcome: "budget_stop", analysis: null, score: null }),
      record({ guid: "BILLS-119hr6", arm: "other", outcome: "stored" }),
    ];
    const calls = [
      call({ latencyMs: 1_000, usage: { input: 6_000, output: 100, cacheRead: null, cacheCreation: null } }),
      call({ latencyMs: 30_000, usage: { input: 6_000, output: 5_000, cacheRead: null, cacheCreation: null } }),
      call({ outcome: "max_tokens" }),
      call({ outcome: "invalid_request", usage: null, latencyMs: 200, httpStatus: 400, costUsd: 0 }),
      call({ outcome: "timeout", usage: null, latencyMs: 60_000, costUsd: 0.05 }),
      call({ arm: "other", costUsd: 9 }),
    ];
    const summary = summarizeArm(H45_ARM, records, calls);
    expect(summary).toMatchObject({
      billRuns: 6,
      bills: 4,
      runs: 2,
      stored: 4,
      refused: 1,
      failed: 1,
      budgetStopped: 1,
      notCurrent: 0,
      failures: [{ guid: "BILLS-119hr3", run: 1, error: "cut off" }],
      refusals: [{ guid: "BILLS-119hr4", run: 1, stratum: "bills", categories: ["cyber", null], outcome: "refused" }],
      rel40: { billRuns: 3, stored: 2 },
      firstCall: { judged: 4, valid: 3, softViolations: 1, hardIssues: 0, softViolationRate: 0.25 },
      repairedBillRuns: 1,
      wordCutBillRuns: 1,
      fieldRepairs: 1,
      revisedBillRuns: 1,
      loadedWordHits: 0,
      axes: { pairs: 2, meanStdev: 0.188, maxStdev: 0.375, signFlips: 1, signFlipRate: 0.5, presenceMismatches: 0 },
      axisMeans: { "BILLS-119hr1": { localVsFederal: 0.125 }, "BILLS-119hr2": { localVsFederal: 0.25 } },
      exactStrings: { uses: 4, nearMisses: 0, compliance: 1 },
      calls: {
        total: 5,
        rejectedRequests: 1,
        timeouts: 1,
        maxTokensStops: 1,
        outputTokensP99: 5_000,
        latencyP50Ms: 5_000,
        latencyP95Ms: 30_000,
        latencyMaxMs: 30_000,
      },
      chainP99Ms: 5_000,
    });
    expect(summary.party.loadedWordGapPerRun).toBe(0);
    expect(summary.costUsd).toBeCloseTo(0.0094 * 3 + 0.05, 6);
    expect(summary.costPerBillRunUsd).toBeCloseTo((0.0094 * 3 + 0.05) / 6, 5);
  });

  it("agrees on the sign of each bill's mean axis score", () => {
    const one = (value: number, arm: string) => {
      const stored = validated(
        analysis("BILLS-119hr1", { civicProfile: { localVsFederal: value, privacyVsSecurity: 0 } }),
      );
      return record({ arm, analysis: stored, score: scoreAnalysis(stored) });
    };
    const left = summarizeArm("a", [one(0.5, "a")], []);
    const right = summarizeArm("b", [one(-0.25, "b")], []);
    expect(axisSignAgreement(left, right)).toEqual({ pairs: 2, agreements: 1, rate: 0.5 });
  });
});

describe("evaluateGates", () => {
  const summaryOf = (records: BillRunRecord[], calls: CallRecord[] = [], arm = H45_ARM): ArmSummary =>
    summarizeArm(arm, records, calls);
  const good = (count: number, overrides: Partial<BillRunRecord> = {}) =>
    Array.from({ length: count }, (_, index) =>
      record({ guid: `BILLS-119hr${index + 1}`, party: index % 2 ? "D" : "R", stratum: "rel40", ...overrides }),
    );

  it("E1 passes clean results against the stored summaries and leaves the spot check to a person", () => {
    const candidate = summaryOf(good(10));
    const baseline = summaryOf(good(10, { arm: BASELINE_ARM }), [], BASELINE_ARM);
    const results = evaluateGates("e1", candidate, baseline);
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ["E1.1", "pass"],
      ["E1.2", "pass"],
      ["E1.3", "pass"],
      ["E1.4", "pass"],
      ["E1.5", "pass"],
      ["E1.6", "manual"],
    ]);
    expect(statusOf(evaluateGates("e1", candidate, null), "E1.5")).toBe("n/a");
  });

  it("E1 fails an unstored REL-40 bill, first answers over 15%, too many fits and loaded words", () => {
    const loaded = validated(analysis("BILLS-119hr9", { soWhat: "A radical change." }));
    const fit = {
      field: "soWhat",
      rules: ["max_sentences" as const],
      method: "words" as const,
      beforeChars: 1,
      afterChars: 1,
      beforeSentences: 3,
      afterSentences: 1,
      original: "x",
    };
    const records = [
      ...good(4, { attempts: [{ kind: "first", outcome: "issues", issues: [softIssue()] }], repairs: [fit] }),
      record({ guid: "BILLS-119hr8", stratum: "rel40", outcome: "failed", analysis: null, score: null }),
      record({ guid: "BILLS-119hr9", analysis: loaded, score: scoreAnalysis(loaded) }),
    ];
    const results = evaluateGates("e1", summaryOf(records), null);
    expect(statusOf(results, "E1.1")).toBe("fail");
    expect(statusOf(results, "E1.2")).toBe("fail");
    expect(statusOf(results, "E1.3")).toBe("fail");
    expect(statusOf(results, "E1.4")).toBe("fail");
    expect(results.find((result) => result.id === "E1.3")!.checks.map((item) => item.status)).toEqual(["fail", "fail"]);
  });

  it("E1.5 fails a reading grade more than half a grade above the stored summaries", () => {
    const hard = validated(
      analysis("BILLS-119hr1", {
        soWhat:
          "Comprehensive intergovernmental administrative reorganization necessitates extraordinary appropriations.",
      }),
    );
    const candidate = summaryOf([record({ analysis: hard, score: scoreAnalysis(hard) })]);
    const baseline = summaryOf([record({ arm: BASELINE_ARM })], [], BASELINE_ARM);
    expect(statusOf(evaluateGates("e1", candidate, baseline), "E1.5")).toBe("fail");
  });

  it("E2 passes a clean candidate against Haiku 4.5", () => {
    const reference = summaryOf(
      [
        ...good(10, { attempts: [{ kind: "first", outcome: "issues", issues: [softIssue()] }] }),
        ...good(10, { run: 2 }),
      ],
      [call({ costUsd: 0.5 })],
    );
    const candidate = summaryOf(
      [...good(10, { arm: H55_ARM }), ...good(10, { arm: H55_ARM, run: 2 })],
      [call({ arm: H55_ARM, costUsd: 0.05 })],
      H55_ARM,
    );
    const results = evaluateGates("e2", candidate, reference);
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ["G1", "pass"],
      ["G2", "pass"],
      ["G3", "pass"],
      ["G4", "pass"],
      ["G5", "pass"],
      ["G6", "pass"],
      ["G7", "pass"],
      ["G8", "pass"],
      ["G9", "pass"],
      ["G10", "manual"],
      ["G11", "manual"],
      ["G12", "pass"],
    ]);
    expect(results.find((result) => result.id === "G7")!.checks[2]).toEqual({
      status: "info",
      detail: `axis sign agreement with ${H45_ARM}: 100.0% of 10 bill-axis pairs`,
    });
  });

  it("E2 fails rejected requests, refusals on bills.json, cut answers, slow calls and flipped axes", () => {
    const flip = (run: number, value: number) => {
      const stored = validated(analysis("BILLS-119hr1", { civicProfile: { localVsFederal: value } }));
      return record({ arm: H55_ARM, run, analysis: stored, score: scoreAnalysis(stored) });
    };
    const records = [
      flip(1, 0.5),
      flip(2, -0.5),
      record({
        arm: H55_ARM,
        guid: "BILLS-119hr2",
        outcome: "refused",
        analysis: null,
        score: null,
        attempts: [{ kind: "first", outcome: "refusal", refusalCategory: "bio" }],
      }),
    ];
    const calls = [
      call({ arm: H55_ARM, outcome: "access_denied", httpStatus: 403, usage: null }),
      call({ arm: H55_ARM, outcome: "max_tokens", latencyMs: 26_000 }),
      call({ arm: H55_ARM, latencyMs: 51_000 }),
    ];
    const results = evaluateGates("e2", summaryOf(records, calls, H55_ARM), null);
    for (const id of ["G1", "G2", "G4", "G5", "G7"]) expect(statusOf(results, id)).toBe("fail");
    expect(results.find((result) => result.id === "G2")!.checks[0].detail).toContain(
      "BILLS-119hr2 run 1 [bio] refused",
    );
    // Without a reference the comparisons cannot be made, and they decide nothing.
    expect(results.find((result) => result.id === "G3")!.checks[3]).toEqual({
      status: "n/a",
      detail: "no reference arm",
    });
    expect(statusOf(results, "G9")).toBe("n/a");
    expect(statusOf(results, "G12")).toBe("n/a");
  });

  it("E2 needs two runs for axis stability and compares cost and first answers with the reference", () => {
    const reference = summaryOf(good(4), [call({ costUsd: 0.01 })]);
    const candidate = summaryOf(
      good(4, { arm: H55_ARM, attempts: [{ kind: "first", outcome: "issues", issues: [softIssue()] }] }),
      [call({ arm: H55_ARM, costUsd: 0.02 })],
      H55_ARM,
    );
    const results = evaluateGates("e2", candidate, reference);
    expect(statusOf(results, "G7")).toBe("n/a");
    expect(statusOf(results, "G3")).toBe("fail");
    expect(statusOf(results, "G12")).toBe("fail");
  });

  it("keeps E2's thresholds as the plan sets them", () => {
    expect(GATE_LIMITS.e2).toMatchObject({
      maxRefusalRate: 0.01,
      maxRepairedRate: 0.05,
      maxWordCutRate: 0.01,
      maxOutputTokensP99: 4_096,
      maxLatencyP95Ms: 25_000,
      maxLatencyMs: 50_000,
      maxChainP99Ms: 80_000,
      maxMeanAxisStdev: 0.15,
      maxSignFlipRate: 0.02,
      maxReadingGrade: 8,
    });
  });
});

// ─── Blinded review ───────────────────────────────────────────────────────────

describe("buildBlindReview", () => {
  const records = (arm: string) =>
    Array.from({ length: 8 }, (_, index) =>
      record({ arm, guid: `BILLS-119hr${index + 1}`, label: `Bill ${index + 1}` }),
    );

  it("reviews every refused, fitted or loaded-word bill first, hides the arms and keeps a key", () => {
    const left = records("left-arm");
    const right = records("right-arm");
    const loaded = validated(analysis("BILLS-119hr6", { soWhat: "A radical change." }));
    right[2] = {
      ...right[2],
      outcome: "refused",
      analysis: null,
      score: null,
      attempts: [{ kind: "first", outcome: "refusal" }],
    };
    right[4] = {
      ...right[4],
      repairs: [
        {
          field: "soWhat",
          rules: ["max_chars"],
          method: "sentences",
          beforeChars: 300,
          afterChars: 200,
          beforeSentences: 3,
          afterSentences: 2,
          original: "x",
        },
      ],
    };
    left[5] = { ...left[5], analysis: loaded, score: scoreAnalysis(loaded) };

    const review = buildBlindReview(
      { arm: "left-arm", records: left },
      { arm: "right-arm", records: right },
      { count: 4 },
    );
    expect(review.key).toHaveLength(4);
    const reasons = Object.fromEntries(review.key.map((entry) => [entry.guid, entry.reasons]));
    expect(reasons).toMatchObject({
      "BILLS-119hr3": ["refusal"],
      "BILLS-119hr5": ["fitted"],
      "BILLS-119hr6": ["loaded words"],
    });
    for (const entry of review.key) expect([entry.A, entry.B].sort()).toEqual(["left-arm", "right-arm"]);
    expect(review.markdown).not.toContain("left-arm");
    expect(review.markdown).not.toContain("right-arm");
    expect(review.markdown).toContain("### Summary A");
    expect(review.markdown).toContain("_No summary (refused)._");
    expect(review.markdown).toContain("[texts/BILLS-119hr3.txt](texts/BILLS-119hr3.txt)");
    expect(review.markdown.match(/^## \d+\. BILLS-/gm)).toHaveLength(4);
    // Seeded: the same input gives the same review.
    expect(
      buildBlindReview({ arm: "left-arm", records: left }, { arm: "right-arm", records: right }, { count: 4 }),
    ).toEqual(review);
  });
});

// ─── Probes ───────────────────────────────────────────────────────────────────

describe("probe helpers", () => {
  const guid = "BILLS-119hr1";
  const answer = analysis(guid, { billBreakdown: { ...(analysis(guid).billBreakdown as object), how: LONG_HOW } });

  it("reads the previous answer from a saved response, a bills answer or an analysis", () => {
    const response = {
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: billsJson(answer) },
      ],
      stop_reason: "end_turn",
    };
    expect(previousAnalysis(response, guid)).toEqual(answer);
    expect(previousAnalysis({ bills: [answer] }, guid)).toEqual(answer);
    expect(previousAnalysis(answer, guid)).toEqual(answer);
    expect(previousAnalysis({ bills: [analysis("BILLS-119hr2")] }, guid)).toBeUndefined();
    expect(previousAnalysis("text", guid)).toBeUndefined();
  });

  it("measures named issues on the previous answer for the correction prompt", () => {
    const issues = parseIssueSpecs("billBreakdown.how:max_chars, soWhat:max_sentences,title:missing", answer);
    expect(issues).toEqual([
      {
        field: "billBreakdown.how",
        kind: "soft",
        rule: "max_chars",
        chars: LONG_HOW.length,
        sentences: 9,
        text: LONG_HOW,
      },
      {
        field: "soWhat",
        kind: "soft",
        rule: "max_sentences",
        chars: 38,
        sentences: 1,
        text: "Rural homes could get faster internet.",
      },
      { field: "title", kind: "hard", rule: "missing" },
    ]);
    expect(getCorrectionPrompt(issues)).toContain(
      `- billBreakdown.how is ${LONG_HOW.length} characters in 9 sentences.`,
    );
    expect(() => parseIssueSpecs("billBreakdown.who:max_sentences", answer)).toThrow("max_sentences (soWhat only)");
    expect(() => parseIssueSpecs("summary:max_chars", answer)).toThrow('unknown field "summary"');
  });
});

describe("probeBedrockModel parseArgs", () => {
  it("defaults to production's model and each caller's max_tokens", () => {
    expect(parseProbeArgs(["--kind", "summarizer-first", "--guid", "BILLS-119hr1"])).toMatchObject({
      kind: "summarizer-first",
      arm: { modelId: H45, effort: "default", profile: "haiku-4-5" },
      maxTokens: 8192,
      yes: false,
      timeoutMs: 120_000,
    });
    expect(
      parseProbeArgs(["--kind", "priority", "--payload", "p.json", "--model", H55, "--effort", "low"]),
    ).toMatchObject({
      arm: { modelId: H55, effort: "low" },
      maxTokens: 4096,
      payload: path.resolve("p.json"),
      index: 1,
    });
  });

  it("checks what each kind needs", () => {
    expect(() => parseProbeArgs([])).toThrow("--kind is required");
    expect(() => parseProbeArgs(["--kind", "summarizer"])).toThrow("--kind takes");
    expect(() => parseProbeArgs(["--kind", "summarizer-first"])).toThrow("needs --guid");
    expect(() => parseProbeArgs(["--kind", "summarizer-corrective", "--guid", "g"])).toThrow("needs --previous");
    expect(() => parseProbeArgs(["--kind", "summarizer-first", "--guid", "g", "--issues", "title:missing"])).toThrow(
      "--issues is for summarizer-corrective",
    );
    expect(() => parseProbeArgs(["--kind", "priority"])).toThrow("needs --payload");
    expect(() => parseProbeArgs(["--kind", "priority", "--payload", "p", "--guid", "g"])).toThrow("--guid is for");
    expect(() => parseProbeArgs(["--kind", "summarizer-first", "--guid", "g", "--extra", "[1]"])).toThrow(
      "--extra takes a JSON object",
    );
    expect(() => parseProbeArgs(["--kind", "summarizer-first", "--guid", "g", "--yes"])).toThrow(
      "--yes needs --max-usd",
    );
    expect(() => parseProbeArgs(["--kind", "summarizer-first", "--guid", "g", "--effort", "medium"])).toThrow(
      "Haiku 4.5 takes no effort",
    );
    expect(() => parseProbeArgs(["--kind", "summarizer-first", "--guid", "g", "--fallbacks"])).toThrow(
      "Unknown argument: --fallbacks",
    );
    expect(parseProbeArgs(["--help"]).help).toBe(true);
  });
});

// ─── Resolver replay ──────────────────────────────────────────────────────────

const priorityLine = (now: string, guids = ["BILLS-119hr1", "BILLS-119hr2"]) => ({
  level: "INFO",
  message: "priority_request",
  event: "priority_request",
  now,
  maxResults: 8,
  payload: buildPriorityPayload({
    headlines: [{ source: "AP", title: "Congress weighs broadband bill", publishedAt: now }],
    candidates: guids.map((guid) => ({ guid, billType: "hr", title: `Bill ${guid}` })),
    maxResults: 8,
  }),
});

const decision = (guid: string, score = 90, confidence = 0.9, isPriority = true) => ({
  guid,
  isPriority,
  score,
  confidence,
  reason: "In the news.",
});

describe("resolver replay helpers", () => {
  it("reads priority_request lines however CloudWatch Logs exports them", () => {
    const one = priorityLine("2026-10-12T01:00:00.000Z");
    const two = priorityLine("2026-10-12T02:00:00.000Z");
    const prefixed = (line: object) => `2026-10-12T01:00:00.000Z\tabc\tINFO\t${JSON.stringify(line)}`;
    const jsonLines = [
      prefixed(one),
      JSON.stringify(two),
      JSON.stringify({ event: "bedrock_call" }),
      prefixed(one),
      "not json",
    ].join("\n");
    expect(parsePriorityRequests(jsonLines)).toEqual({
      captures: [
        { now: one.now, maxResults: 8, payload: one.payload },
        { now: two.now, maxResults: 8, payload: two.payload },
      ],
      skipped: 2,
    });
    expect(
      parsePriorityRequests(JSON.stringify([{ "@timestamp": "t", "@message": prefixed(one) }])).captures,
    ).toHaveLength(1);
    const queryResults = {
      results: [
        [
          { field: "@timestamp", value: "t" },
          { field: "@message", value: prefixed(two) },
        ],
      ],
    };
    expect(parsePriorityRequests(JSON.stringify(queryResults)).captures[0].now).toBe(two.now);
    expect(
      parsePriorityRequests(JSON.stringify({ ...one, maxResults: "x", payload: { ...one.payload, maxResults: 0 } })),
    ).toEqual({
      captures: [],
      skipped: 1,
    });
  });

  it("activates as the resolver does: priority, both thresholds, a candidate, best first, at most maxResults", () => {
    const candidates = new Set(["a", "b", "c", "d", "e"]);
    const decisions = [
      decision("a", 80, 0.6),
      decision("b", 90, 0.6),
      decision("c", 90, 0.7),
      decision("d", 74, 0.99),
      decision("e", 99, 0.54),
      decision("x", 99, 0.99),
      decision("a2", 99, 0.99, false),
    ];
    expect(activatedGuids(decisions, candidates, 8)).toEqual(["c", "b", "a"]);
    expect(activatedGuids(decisions, candidates, 2)).toEqual(["c", "b"]);
  });

  it("reads an answer as askModel does", () => {
    const read = (outcome: "ok" | "refusal" | "max_tokens" | "incomplete", text: string) => ({ outcome, text });
    expect(priorityAnswer(read("ok", 'Here: {"bills":[]}'))).toEqual({ answered: true, decisions: [] });
    expect(priorityAnswer(read("ok", "  "))).toEqual({ answered: false, reason: "empty" });
    expect(priorityAnswer(read("ok", "No bills today."))).toEqual({ answered: false, reason: "unparseable" });
    expect(priorityAnswer(read("refusal", ""))).toEqual({ answered: false, reason: "refusal" });
    expect(priorityAnswer(read("max_tokens", '{"bills":[]}'))).toEqual({ answered: false, reason: "max_tokens" });
  });

  it("measures overlap with Jaccard, both empty counting as agreement", () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard(["a"], [])).toBe(0);
  });

  it("checks G11 on the replay", () => {
    const replay = (
      arm: string,
      index: number,
      activated: string[],
      overrides: Partial<ReplayRecord> = {},
    ): ReplayRecord => ({
      index,
      arm,
      now: "t",
      candidates: 5,
      outcome: "ok",
      answered: true,
      noAnswerReason: null,
      decisions: activated.length,
      activated,
      usage: { input: 10_000, output: 400, cacheRead: null, cacheCreation: null },
      latencyMs: 8_000,
      costUsd: 0.01,
      error: null,
      ...overrides,
    });
    const passing = summarizeReplay(
      [
        replay("ref", 1, ["a", "b"]),
        replay("new", 1, ["a", "b"]),
        replay("ref", 2, ["c"]),
        replay("new", 2, ["c", "d"]),
      ],
      "ref",
      "new",
    );
    expect(passing.meanJaccard).toBe(0.75);
    expect(passing.activationChange).toBeCloseTo(1 / 3);
    expect(passing.gate.status).toBe("pass");

    const failing = summarizeReplay(
      [
        replay("ref", 1, ["a"]),
        replay("new", 1, [], { answered: false, noAnswerReason: "refusal", outcome: "refusal" }),
      ],
      "ref",
      "new",
    );
    expect(failing.candidate.noAnswers).toEqual({ refusal: 1 });
    expect(failing.gate.checks.map((item) => item.status)).toEqual(["fail", "n/a", "fail", "pass"]);
    expect(failing.gate.status).toBe("fail");
  });
});

describe("comparePriorityModels parseArgs", () => {
  it("defaults to Haiku 4.5 against Haiku 5.5 at low effort", () => {
    const args = parseCompareArgs(["--payloads", "p.json"]);
    expect(args.arms.map((arm) => arm.name)).toEqual([H45_ARM, `${H55}:low`]);
    expect(args).toMatchObject({ payloads: path.resolve("p.json"), maxTokens: 4096, yes: false, maxUsd: null });
  });

  it("takes exactly two arms and will not spend without a cap", () => {
    expect(() => parseCompareArgs([])).toThrow("--payloads <file> is required");
    expect(() => parseCompareArgs(["--payloads", "p", "--arm", H45_ARM])).toThrow("--arm is given twice");
    expect(() => parseCompareArgs(["--payloads", "p", "--arm", H45_ARM, "--arm", H45_ARM])).toThrow("Both arms are");
    expect(() => parseCompareArgs(["--payloads", "p", "--yes"])).toThrow("--yes needs --max-usd");
    expect(() => parseCompareArgs(["--payloads", "p", "--top-p", "1"])).toThrow("Unknown argument: --top-p");
  });
});

// ─── The scripts end to end, against a fake bill store and a mocked Bedrock ──

describe("scripts end to end", () => {
  const A = "BILLS-119hr1001";
  const B = "BILLS-119hr1002";
  const C = "BILLS-119hr1003";
  let dir: string;
  let billsFile: string;

  const seedStore = () => {
    mockS3.put(`raw-bills/${A}.json`, rawBill(A, "R"));
    mockS3.put(`raw-bills/${B}.json`, rawBill(B, "D"));
    mockS3.put(`raw-bills/${C}.json`, rawBill(C, "R"));
    // Stored summaries for the baseline arm: A from the current text, B from older text, C none.
    mockS3.put(`processed-bills/${A}.json`, analysis(A), {
      "source-text-hash": sourceTextHash(rawBill(A) as unknown as RawBill),
    });
    mockS3.put(`processed-bills/${B}.json`, analysis(B), { "source-text-hash": "v1:older" });
  };

  /** Answers per bill, in call order. */
  const answer = (queues: Record<string, Array<ReturnType<typeof bedrockResponse> | Error>>) =>
    mockBedrockSend.mockImplementation(async (command: { input: { body: string } }) => {
      const next = queues[guidInBody(JSON.parse(command.input.body))].shift();
      if (!next) throw new Error("no answer queued");
      if (next instanceof Error) throw next;
      return next;
    });

  const ladderAnswers = () => ({
    [A]: [bedrockResponse(billsJson(analysis(A)))],
    [B]: [
      bedrockResponse(
        billsJson(analysis(B, { billBreakdown: { ...(analysis(B).billBreakdown as object), how: LONG_HOW } })),
      ),
      bedrockResponse(billsJson(analysis(B, { title: "Ignored title" }))),
    ],
    [C]: [
      bedrockResponse([], "refusal", { input_tokens: 1200, output_tokens: 5 }, { type: "refusal", category: "cyber" }),
      bedrockResponse(billsJson(analysis(C))),
    ],
  });

  const readLines = async <T = BillRunRecord>(file: string): Promise<T[]> =>
    (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "eval-scoring-"));
    billsFile = path.join(dir, "bills.json");
    await writeFile(
      billsFile,
      JSON.stringify({
        bills: [
          { guid: A, label: "A", stratum: "rel40" },
          { guid: B, label: "B", stratum: "rel40" },
          { guid: C, label: "C", verify: true },
          { guid: "BILLS-119hr1004", label: "missing", verify: true },
        ],
      }),
    );
    seedStore();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to run in CI", async () => {
    process.env.CI = "true";
    expect(await evalMain(["--bills-file", billsFile])).toBe(2);
    expect(await probeMain(["--kind", "summarizer-first", "--guid", A])).toBe(2);
    expect(await compareMain(["--payloads", billsFile])).toBe(2);
    expect(mockS3.calls).toHaveLength(0);
  });

  it("dry run: reads the bills, reports the missing one and the plan, calls nothing", async () => {
    expect(await evalMain(["--bills-file", billsFile, "--max-usd", "1"])).toBe(0);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    const output = consoleLines.join("\n");
    expect(output).toContain("BILLS-119hr1004: not in s3://billboard-bill-store-bucket/raw-bills/");
    expect(output).toContain("3 bills ready for evaluation.");
    expect(output).toContain('"verify" entries: 1 of 2 in the store with text; replace BILLS-119hr1004');
    expect(output).toMatch(/us\.anthropic\.claude-haiku-4-5-20251001-v1:0:default: 3 first calls, about \$0\.\d+/);
    expect(output).toContain("Within --max-usd 1.");
    expect(output).toContain("Dry run only.");

    const done = path.join(dir, "done.json");
    await writeFile(done, JSON.stringify({ bills: [{ guid: A }, { guid: "BILLS-119hr1004" }] }));
    consoleLines.length = 0;
    expect(await evalMain(["--bills-file", billsFile, "--exclude-bills", done])).toBe(0);
    expect(consoleLines.join("\n")).toContain("2 bills ready for evaluation.");
  });

  it("--write-bodies writes the first and refusal-retry bodies production would send", async () => {
    const bodies = path.join(dir, "bodies");
    expect(await evalMain(["--bills-file", billsFile, "--arm", `${H55}:low`, "--write-bodies", bodies])).toBe(0);
    const armDir = path.join(bodies, "us.anthropic.claude-haiku-5-5_low");
    expect((await readdir(armDir)).sort()).toEqual(
      [A, B, C].flatMap((guid) => [`${guid}.first.json`, `${guid}.refusal_retry.json`]).sort(),
    );
    const first = JSON.parse(await readFile(path.join(armDir, `${A}.first.json`), "utf8"));
    expect(first).toEqual(
      buildBedrockRequestBody([extractMinimalBillInfo(rawBill(A) as unknown as RawBill, undefined, A)], {
        profile: "haiku-5-5",
        effort: "low",
        maxTokens: 8192,
      }),
    );
    expect(first.output_config).toEqual({ effort: "low" });
    expect(first).not.toHaveProperty("temperature");
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it("runs production's ladder, writes every call and bill, scores the arms and checks E1", async () => {
    answer(ladderAnswers());
    const out = path.join(dir, "out");
    const code = await evalMain([
      ...["--bills-file", billsFile, "--baseline-stored", "--concurrency", "1"],
      ...["--yes", "--max-usd", "1", "--out", out],
    ]);

    const calls = await readLines<CallRecord>(path.join(out, "calls.jsonl"));
    expect(calls.map((item) => [item.guids[0], item.kind, item.outcome])).toEqual([
      [A, "first", "ok"],
      [B, "first", "ok"],
      [B, "corrective", "ok"],
      [C, "first", "refusal"],
      [C, "refusal_retry", "ok"],
    ]);
    expect(calls[0]).toMatchObject({ arm: H45_ARM, modelId: H45, refusalCategory: null, attempt: 0 });
    expect(calls[3].refusalCategory).toBe("cyber");
    expect(calls[0].costUsd).toBeCloseTo((1200 * 1.1 + 300 * 5.5) / 1_000_000, 10);

    // Production's bodies: Haiku 4.5 at temperature 0, the corrective as three turns, the retry on shortened text.
    const bodies = mockBedrockSend.mock.calls.map(sentBody);
    expect(bodies[0]).toMatchObject({ max_tokens: 8192, temperature: 0 });
    expect(bodies[0]).not.toHaveProperty("output_config");
    expect(bodies[2].messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(bodies[4].messages[0].content[0].text).toContain('"textComplete":false');

    const bills = await readLines(path.join(out, "bills.jsonl"));
    const byArm = (arm: string): Record<string, BillRunRecord> =>
      Object.fromEntries(bills.filter((item) => item.arm === arm).map((item) => [item.guid, item]));
    expect(Object.values(byArm(BASELINE_ARM)).map((item) => [item.guid, item.outcome, item.error])).toEqual([
      [A, "stored", null],
      [B, "not_current", "written from other text"],
      [C, "not_current", "no processed bill"],
    ]);
    const model = byArm(H45_ARM);
    expect(model[A]).toMatchObject({ outcome: "stored", calls: 1, revised: false, stratum: "rel40", party: "R" });
    expect(model[B]).toMatchObject({ outcome: "stored", calls: 2, revised: true, repairs: [] });
    expect(model[B].analysis?.title).toBe("Funds grants for rural broadband");
    expect(model[B].attempts.map((attempt) => attempt.outcome)).toEqual(["issues", "valid"]);
    expect(model[B].events).toEqual([
      { level: "info", event: "analysis_revised", fields: ["billBreakdown.how"], keptFromFirst: [] },
    ]);
    expect(model[C]).toMatchObject({ outcome: "stored", calls: 2, reducedInput: true, stratum: "bills" });
    expect(model[C].tags).toEqual({
      subCategories: { kept: ["Telecommunications"], dropped: [] },
      lifeAreas: { kept: ["Digital Services"], dropped: [] },
    });
    expect(await readFile(path.join(out, model[A].textFile!), "utf8")).toContain(`guid: ${A}\ntitle: Test Act ${A}`);

    const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ gateSet: "e1", reference: BASELINE_ARM, maxUsd: 1 });
    expect(summary.arms[H45_ARM]).toMatchObject({
      billRuns: 3,
      stored: 3,
      refusals: [{ guid: C, categories: ["cyber"] }],
    });
    const gates: GateResult[] = summary.gates[H45_ARM];
    expect(statusOf(gates, "E1.1")).toBe("pass");
    // One of the two judged first answers broke a limit: over E1's 15%.
    expect(statusOf(gates, "E1.2")).toBe("fail");
    expect(code).toBe(1);

    const key = JSON.parse(await readFile(path.join(out, "review-key.json"), "utf8"));
    expect(key.map((entry: { guid: string }) => entry.guid)).toEqual([A]);
    const review = await readFile(path.join(out, "review.md"), "utf8");
    expect(review).not.toContain(H45_ARM);
    expect(review).not.toContain(BASELINE_ARM);
    expect(mockS3.calls.some((command) => command.__cmd === "PutObject")).toBe(false);

    // --report scores the same results again, the second copy as runs 2.
    const report = path.join(dir, "report");
    expect(await evalMain(["--report", out, "--report", out, "--out", report])).toBe(1);
    const merged = JSON.parse(await readFile(path.join(report, "summary.json"), "utf8"));
    expect(merged.arms[H45_ARM]).toMatchObject({ billRuns: 6, runs: 2 });
    expect(merged.sources).toEqual([out, out]);
    expect(existsSync(path.join(report, "review.md"))).toBe(true);
    expect(mockBedrockSend).toHaveBeenCalledTimes(5);
  });

  it("--batch-size: one call for the chunk, a corrective call per long answer, a bill left out fails", async () => {
    const longHow = analysis(B, { billBreakdown: { ...(analysis(B).billBreakdown as object), how: LONG_HOW } });
    // The chunk's body names A first, so its answer is queued under A.
    answer({
      [A]: [bedrockResponse(billsJson(analysis(A), longHow))],
      [B]: [bedrockResponse(billsJson(analysis(B)))],
      [C]: [],
    });
    const out = path.join(dir, "out");
    await evalMain(["--bills-file", billsFile, "--batch-size", "3", "--yes", "--max-usd", "1", "--out", out]);
    const calls = await readLines<CallRecord>(path.join(out, "calls.jsonl"));
    expect(calls.map((item) => [item.kind, item.guids])).toEqual([
      ["batch", [A, B, C]],
      ["corrective", [B]],
    ]);
    const bills = Object.fromEntries((await readLines(path.join(out, "bills.jsonl"))).map((item) => [item.guid, item]));
    expect(bills[A]).toMatchObject({ outcome: "stored", calls: 1 });
    expect(bills[B]).toMatchObject({ outcome: "stored", calls: 2, revised: true });
    expect(bills[C]).toMatchObject({
      outcome: "failed",
      calls: 1,
      error: `Analysis for ${C} missing from model response`,
    });
    expect(bills[A].costUsd).toBeCloseTo(calls[0].costUsd / 3, 6);
  });

  it("records a rejected request and a bill refused twice, and checks E2 for a Haiku 5.5 arm", async () => {
    const refusal = () =>
      bedrockResponse([], "refusal", { input_tokens: 1200, output_tokens: 5 }, { type: "refusal", category: "bio" });
    answer({
      [A]: [
        Object.assign(new Error("output_config is not supported"), {
          name: "ValidationException",
          $metadata: { httpStatusCode: 400 },
        }),
      ],
      [B]: [bedrockResponse(billsJson(analysis(B)), "end_turn", { input_tokens: 1500, output_tokens: 1800 })],
      [C]: [refusal(), refusal()],
    });
    const out = path.join(dir, "out");
    const code = await evalMain([
      ...["--bills-file", billsFile, "--arm", H55_ARM, "--concurrency", "1"],
      ...["--yes", "--max-usd", "1", "--out", out],
    ]);
    expect(code).toBe(1);
    const calls = await readLines<CallRecord>(path.join(out, "calls.jsonl"));
    expect(calls[0]).toMatchObject({
      outcome: "invalid_request",
      errorName: "ValidationException",
      httpStatus: 400,
      usage: null,
      costUsd: 0,
    });
    expect(sentBody(mockBedrockSend.mock.calls[0])).toMatchObject({ output_config: { effort: "medium" } });
    expect(sentBody(mockBedrockSend.mock.calls[0])).not.toHaveProperty("temperature");
    const bills = Object.fromEntries((await readLines(path.join(out, "bills.jsonl"))).map((item) => [item.guid, item]));
    expect(bills[A]).toMatchObject({ outcome: "failed", calls: 1 });
    expect(bills[C]).toMatchObject({ outcome: "refused", calls: 2, error: "refused (bio)" });
    expect(bills[C].events.map((event) => event.event)).toEqual(["summary_refused", "summary_refused"]);

    const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ gateSet: "e2", reference: null });
    const gates: GateResult[] = summary.gates[H55_ARM];
    expect(statusOf(gates, "G1")).toBe("fail");
    // C's stratum defaults to the list's name, bills, so its refusal also fails G2's bills.json check.
    expect(statusOf(gates, "G2")).toBe("fail");
    expect(statusOf(gates, "G12")).toBe("n/a");
    expect(existsSync(path.join(out, "review.md"))).toBe(false);

    await expect(evalMain(["--report", out, "--reference", "nope:default"])).rejects.toThrow(
      "--reference nope:default is not an arm of these results",
    );
    await expect(evalMain(["--report", path.join(dir, "empty")])).rejects.toThrow("has no bills.jsonl records");
  });

  it("first answers only: one call per bill, a long field fitted, a refusal not retried", async () => {
    answer(ladderAnswers());
    const out = path.join(dir, "out");
    await evalMain(["--bills-file", billsFile, "--no-emulate-production", "--yes", "--max-usd", "1", "--out", out]);
    const bills = Object.fromEntries((await readLines(path.join(out, "bills.jsonl"))).map((item) => [item.guid, item]));
    expect(mockBedrockSend).toHaveBeenCalledTimes(3);
    expect(bills[B]).toMatchObject({ outcome: "stored", calls: 1, revised: false });
    expect(bills[B].repairs).toMatchObject([{ field: "billBreakdown.how", method: "sentences" }]);
    expect(bills[C]).toMatchObject({ outcome: "failed", calls: 1 });
  });

  it("stops at --max-usd before a call whose worst case would pass it", async () => {
    answer(ladderAnswers());
    const request = { profile: "haiku-4-5" as const, effort: "default" as const, maxTokens: 8192 };
    const worstCase = worstCaseCallUsd(
      buildBedrockRequestBody([extractMinimalBillInfo(rawBill(A) as unknown as RawBill, undefined, A)], request),
      "haiku-4-5",
      DEFAULT_PRICES["haiku-4-5"],
    );
    const firstCost = (1200 * 1.1 + 300 * 5.5) / 1_000_000;
    const cap = worstCase + firstCost / 2;
    const out = path.join(dir, "out");
    const code = await evalMain([
      ...["--bills-file", billsFile, "--concurrency", "1", "--yes", "--max-usd", String(cap), "--out", out],
    ]);
    expect(code).toBe(1);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    const bills = await readLines(path.join(out, "bills.jsonl"));
    expect(bills.map((item) => [item.guid, item.outcome])).toEqual([
      [A, "stored"],
      [B, "budget_stop"],
      [C, "budget_stop"],
    ]);
    const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
    expect(summary.spentUsd).toBeLessThanOrEqual(cap);
    expect(summary.arms[H45_ARM]).toMatchObject({ billRuns: 1, budgetStopped: 2 });
    expect(consoleLines.join("\n")).toContain("2 bill-runs not finished: the run stopped at --max-usd.");
  });

  it("does not retry a dropped connection or a model timeout, either of which may have been billed", async () => {
    answer({
      [A]: [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
      [B]: [
        Object.assign(new Error("Model timed out"), {
          name: "ModelTimeoutException",
          $metadata: { httpStatusCode: 408 },
        }),
      ],
      [C]: [bedrockResponse(billsJson(analysis(C)))],
    });
    const out = path.join(dir, "out");
    await evalMain(["--bills-file", billsFile, "--concurrency", "1", "--yes", "--max-usd", "1", "--out", out]);

    expect(mockBedrockSend).toHaveBeenCalledTimes(3);
    const calls = await readLines<CallRecord>(path.join(out, "calls.jsonl"));
    expect(calls.map((call) => [call.guids[0], call.outcome, call.attempt])).toEqual([
      [A, "transient", 0],
      [B, "timeout", 0],
      [C, "ok", 0],
    ]);
    // Each failure is charged its worst case.
    expect(calls[0].costUsd).toBeGreaterThan(0);
    expect(calls[1].costUsd).toBeGreaterThan(0);
  });

  it("probe: writes the exact body, sends it once with --yes, and reports an error's classification", async () => {
    const out = path.join(dir, "probe");
    const base = ["--kind", "summarizer-first", "--guid", A, "--model", H55, "--effort", "medium", "--out", out];
    expect(await probeMain(base)).toBe(0);
    const body = JSON.parse(await readFile(path.join(out, "body.json"), "utf8"));
    expect(body).toEqual(
      buildBedrockRequestBody([extractMinimalBillInfo(rawBill(A) as unknown as RawBill, undefined, A)], {
        profile: "haiku-5-5",
        effort: "medium",
        maxTokens: 8192,
      }),
    );
    expect(mockBedrockSend).not.toHaveBeenCalled();

    mockBedrockSend.mockResolvedValueOnce(
      bedrockResponse(
        [
          { type: "thinking", thinking: "", signature: "s" },
          {
            type: "text",
            text: billsJson(
              analysis(A, { billBreakdown: { ...(analysis(A).billBreakdown as object), how: LONG_HOW } }),
            ),
          },
        ],
        "end_turn",
        { input_tokens: 2000, output_tokens: 1500 },
      ),
    );
    expect(await probeMain([...base, "--yes", "--max-usd", "0.05"])).toBe(0);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    const output = consoleLines.join("\n");
    expect(output).toContain("HTTP 200 in");
    expect(output).toContain("content types: thinking, text (1 thinking)");
    expect(output).toContain(`billBreakdown.how is ${LONG_HOW.length} characters (max 400)`);
    expect(existsSync(path.join(out, "response.json"))).toBe(true);

    // P3: the corrective body from that answer, as three turns ending with the user's correction.
    const corrective = path.join(dir, "corrective");
    expect(
      await probeMain([
        ...["--kind", "summarizer-corrective", "--guid", A, "--model", H55, "--effort", "medium"],
        ...["--previous", path.join(out, "response.json"), "--out", corrective],
      ]),
    ).toBe(0);
    const correctiveBody = JSON.parse(await readFile(path.join(corrective, "body.json"), "utf8"));
    expect(correctiveBody.messages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(correctiveBody.messages[2].content[0].text).toContain(
      `- billBreakdown.how is ${LONG_HOW.length} characters`,
    );

    // P2: temperature 0 on Haiku 5.5 is a 400.
    mockBedrockSend.mockRejectedValueOnce(
      Object.assign(new Error("temperature is not supported"), {
        name: "ValidationException",
        $metadata: { httpStatusCode: 400 },
      }),
    );
    const rejected = path.join(dir, "rejected");
    expect(
      await probeMain([...base.slice(0, -1), rejected, "--extra", '{"temperature":0}', "--yes", "--max-usd", "0.05"]),
    ).toBe(1);
    expect(sentBody(mockBedrockSend.mock.calls[1])).toMatchObject({
      temperature: 0,
      output_config: { effort: "medium" },
    });
    expect(JSON.parse(await readFile(path.join(rejected, "error.json"), "utf8"))).toMatchObject({
      kind: "invalid_request",
      errorName: "ValidationException",
      httpStatus: 400,
    });

    // A cap below the call's worst case sends nothing.
    expect(await probeMain([...base, "--yes", "--max-usd", "0.0001"])).toBe(2);
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
  });

  it("compare: replays each payload on both arms and checks G11", async () => {
    const payloads = path.join(dir, "payloads.jsonl");
    const lines = [priorityLine("2026-10-12T01:00:00.000Z"), priorityLine("2026-10-12T02:00:00.000Z")];
    await writeFile(payloads, lines.map((line) => JSON.stringify(line)).join("\n"));
    expect(await compareMain(["--payloads", payloads])).toBe(0);
    expect(mockBedrockSend).not.toHaveBeenCalled();

    mockBedrockSend.mockImplementation(async () =>
      bedrockResponse(JSON.stringify({ bills: [decision("BILLS-119hr1"), decision("BILLS-119hr2", 60)] })),
    );
    const out = path.join(dir, "compare");
    expect(await compareMain(["--payloads", payloads, "--yes", "--max-usd", "1", "--out", out])).toBe(0);
    expect(mockBedrockSend).toHaveBeenCalledTimes(4);
    const [h45Body, h55Body] = mockBedrockSend.mock.calls.slice(0, 2).map(sentBody);
    const capture = parsePriorityRequests(JSON.stringify(lines[0])).captures[0];
    expect(h45Body).toEqual(
      buildPriorityRequestBody(capture.payload.headlines, capture.payload.candidates, {
        profile: "haiku-4-5",
        maxTokens: 4096,
        effort: "default",
        now: new Date(capture.now),
        maxResults: 8,
      }),
    );
    expect(h55Body.output_config).toEqual({ effort: "low" });
    const summary = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ meanJaccard: 1, activationChange: 0, gate: { id: "G11", status: "pass" } });
    expect(summary.candidate).toMatchObject({ payloads: 2, answered: 2, activated: 2 });
    expect(await readLines<ReplayRecord>(path.join(out, "calls.jsonl"))).toHaveLength(4);
  });
});
