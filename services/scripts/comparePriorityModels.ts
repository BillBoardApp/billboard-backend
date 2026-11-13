/**
 * Replays captured BillPriorityResolver runs on two models (LLM-11, gate G11 in scripts/eval/rubric.md).
 *
 * Reads priority_request log lines exported from CloudWatch Logs (the resolver logs the headlines and candidates
 * it showed the model, once per run), rebuilds each run's request body with production's builder
 * (buildPriorityRequestBody, with the run's own time) for a reference arm and a candidate arm, sends both, and reads
 * each answer as the resolver does. It reports the runs without a usable answer, the bills each arm would activate
 * at the resolver's thresholds (score 75, confidence 0.55), how far the candidate's picks overlap the reference's
 * (Jaccard), the activation counts, tokens, latency and cost, and checks G11.
 *
 * This calls Amazon Bedrock and costs money. Without --yes it is a dry run that prints the plan and an estimate.
 * --yes needs --max-usd, a hard cap checked before every call against that call's worst case. It refuses to run
 * in CI and writes nothing to S3, SQS or DynamoDB.
 *
 *   npm run eval:compare-priority -- --payloads priority-requests.json                        # dry run
 *   npm run eval:compare-priority -- --payloads priority-requests.json --yes --max-usd 0.75
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockCallError, createBedrockClient, invokeMessages } from "../src/shared/bedrockMessages";
import { buildPriorityRequestBody } from "../src/handlers/billPriorityResolver/prompts";
import {
  PRIORITY_ANSWER_TOKENS,
  SpendCap,
  activatedGuids,
  expectedCall,
  flagValue,
  parseArm,
  parsePositiveInteger,
  parsePriorityRequests,
  parseUsd,
  priorityAnswer,
  pricesFromEnv,
  summarizeReplay,
  usageCostUsd,
  worstCaseCallUsd,
  type EvalArm,
  type PriorityRequestCapture,
  type ReplayRecord,
  type TokenPrices,
} from "./eval/scoring";

const RESULTS_DIR = path.join(__dirname, "eval", "results");
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
// Haiku 4.5, then Deploy B's candidate (infra/lib/config/bedrock-models.ts, BILL_PRIORITY_MODEL): E2's pair.
const DEFAULT_ARMS = ["us.anthropic.claude-haiku-4-5-20251001-v1:0:default", "us.anthropic.claude-haiku-5-5:low"];
// The resolver's max_tokens and per-call deadline (infra/lib/config/priority-service-constants.ts).
const MAX_OUTPUT_TOKENS = 4096;
const CALL_TIMEOUT_MS = 75_000;
const UNBILLED_ERRORS = new Set(["throttled", "invalid_request", "access_denied", "not_found"]);

export interface CompareArgs {
  help: boolean;
  yes: boolean;
  maxUsd: number | null;
  payloads: string | null;
  /** The reference arm, then the candidate. */
  arms: [EvalArm, EvalArm];
  limit: number;
  maxTokens: number;
  out: string | null;
}

export const parseArgs = (argv: readonly string[]): CompareArgs => {
  let help = false;
  let yes = false;
  let maxUsd: number | null = null;
  let payloads: string | null = null;
  let limit = Number.POSITIVE_INFINITY;
  let maxTokens = MAX_OUTPUT_TOKENS;
  let out: string | null = null;
  const armSpecs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = flagValue(argv, i);
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--max-usd") maxUsd = parseUsd(next(), arg);
    else if (arg === "--payloads") payloads = path.resolve(next());
    else if (arg === "--arm") armSpecs.push(next());
    else if (arg === "--limit") limit = parsePositiveInteger(next(), arg);
    else if (arg === "--max-tokens") maxTokens = parsePositiveInteger(next(), arg);
    else if (arg === "--out") out = path.resolve(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (armSpecs.length !== 0 && armSpecs.length !== 2) {
    throw new Error("--arm is given twice: the reference model, then the candidate");
  }
  const [reference, candidate] = (armSpecs.length === 2 ? armSpecs : DEFAULT_ARMS).map(parseArm);
  if (!help) {
    if (!payloads) throw new Error("--payloads <file> is required (priority_request lines from CloudWatch Logs)");
    if (reference.name === candidate.name) throw new Error(`Both arms are ${reference.name}`);
    if (yes && maxUsd === null) throw new Error("--yes needs --max-usd <dollars>, the most this run may spend");
  }
  return { help, yes, maxUsd, payloads, arms: [reference, candidate], limit, maxTokens, out };
};

const bodyFor = (capture: PriorityRequestCapture, arm: EvalArm, maxTokens: number) =>
  buildPriorityRequestBody(capture.payload.headlines, capture.payload.candidates, {
    profile: arm.profile,
    maxTokens,
    effort: arm.effort,
    now: new Date(capture.now),
    maxResults: capture.maxResults,
  });

/** One payload on one arm: the call as the resolver makes it, read as the resolver reads it. */
export const replayOne = async (
  context: { client: Pick<BedrockRuntimeClient, "send">; cap: SpendCap; prices: TokenPrices; maxTokens: number },
  capture: PriorityRequestCapture,
  index: number,
  arm: EvalArm,
): Promise<ReplayRecord | null> => {
  const body = bodyFor(capture, arm, context.maxTokens);
  const worstCase = worstCaseCallUsd(body, arm.profile, context.prices);
  if (!context.cap.tryReserve(worstCase)) return null;
  const base = { index, arm: arm.name, now: capture.now, candidates: capture.payload.candidates.length };
  let costUsd = 0;
  try {
    const read = await invokeMessages({
      client: context.client,
      modelId: arm.modelId,
      caller: "BillPriorityResolver",
      kind: "priority",
      body,
      callTimeoutMs: CALL_TIMEOUT_MS,
      // --max-usd reserves one attempt per call, and a retried attempt could have been billed with no
      // reservation. Throttles are free and keep their retries.
      maxTransientRetries: 0,
      maxModelTimeoutRetries: 0,
      logFields: { index, arm: arm.name },
      emitMetrics: false,
    });
    costUsd = usageCostUsd(read.usage, context.prices) ?? worstCase;
    const answer = priorityAnswer(read);
    const candidates = new Set(capture.payload.candidates.map((candidate) => candidate.guid));
    return {
      ...base,
      outcome: read.outcome,
      answered: answer.answered,
      noAnswerReason: answer.answered ? null : answer.reason,
      decisions: answer.answered ? answer.decisions.length : 0,
      activated: answer.answered ? activatedGuids(answer.decisions, candidates, capture.maxResults) : [],
      usage: read.usage,
      latencyMs: read.latencyMs,
      costUsd,
      error: null,
    };
  } catch (error) {
    const failure = error instanceof BedrockCallError ? error : null;
    costUsd = failure && UNBILLED_ERRORS.has(failure.kind) ? 0 : worstCase;
    return {
      ...base,
      outcome: failure?.kind ?? "error",
      answered: false,
      noAnswerReason: null,
      decisions: 0,
      activated: [],
      usage: null,
      latencyMs: failure?.latencyMs ?? null,
      costUsd,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    context.cap.settle(worstCase, costUsd);
  }
};

const USAGE = `Usage: comparePriorityModels.ts --payloads FILE [--arm <modelId>:<effort> --arm <modelId>:<effort>]
         [--limit N] [--max-tokens N] [--out DIR] [--yes --max-usd USD]
Default arms: ${DEFAULT_ARMS.join(" (reference) and ")} (candidate). See scripts/eval/README.md.`;

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<number> => {
  if (process.env.CI) {
    console.error("comparePriorityModels calls Bedrock and must not run in CI.");
    return 2;
  }
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  // invokeMessages logs a bedrock_call line per attempt; the replay records keep what matters.
  process.env.LOG_LEVEL ??= "warn";
  const { captures, skipped } = parsePriorityRequests(await readFile(args.payloads!, "utf8"));
  const selected = captures.slice(0, args.limit);
  console.log(
    `${selected.length} priority_request payloads from ${args.payloads}${skipped > 0 ? ` (${skipped} other lines skipped)` : ""}`,
  );
  if (selected.length === 0) {
    console.error("No payloads to replay.");
    return 2;
  }
  console.log(`  runs from ${selected[0].now} to ${selected.at(-1)!.now}`);

  const prices = pricesFromEnv();
  let total = 0;
  for (const arm of args.arms) {
    let usd = 0;
    let worstCase = 0;
    for (const capture of selected) {
      const body = bodyFor(capture, arm, args.maxTokens);
      usd += expectedCall(body, arm, prices[arm.profile], PRIORITY_ANSWER_TOKENS).usd;
      worstCase = Math.max(worstCase, worstCaseCallUsd(body, arm.profile, prices[arm.profile]));
    }
    total += usd;
    console.log(
      `  ${arm.name}: ${selected.length} calls, about $${usd.toFixed(2)}; worst case per call $${worstCase.toFixed(3)}`,
    );
  }
  console.log(`Estimate: about $${total.toFixed(2)} in all.`);
  if (!args.yes) {
    console.log("Dry run only. Re-run with --yes --max-usd <dollars> to call Bedrock.");
    return 0;
  }

  const outDir =
    args.out ?? path.join(RESULTS_DIR, `compare-priority-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(outDir, { recursive: true });
  const cap = new SpendCap(args.maxUsd!);
  const client = createBedrockClient({ region: REGION });
  const records: ReplayRecord[] = [];
  let stopped = false;
  for (const [position, capture] of selected.entries()) {
    for (const arm of args.arms) {
      const record = await replayOne(
        { client, cap, prices: prices[arm.profile], maxTokens: args.maxTokens },
        capture,
        position + 1,
        arm,
      );
      if (!record) {
        stopped = true;
        break;
      }
      records.push(record);
      await appendFile(path.join(outDir, "calls.jsonl"), `${JSON.stringify(record)}\n`);
      console.log(
        `#${record.index} ${arm.name}: ${record.answered ? `${record.activated.length} activated` : (record.noAnswerReason ?? record.error)} (${record.outcome}, ${record.latencyMs ?? "?"} ms, $${record.costUsd.toFixed(4)})`,
      );
    }
    if (stopped) break;
  }

  const [reference, candidate] = args.arms;
  const summary = summarizeReplay(records, reference.name, candidate.name);
  await writeFile(
    path.join(outDir, "summary.json"),
    `${JSON.stringify({ payloads: args.payloads, spentUsd: cap.spentUsd, stopped, ...summary }, null, 2)}\n`,
  );
  for (const arm of [summary.reference, summary.candidate]) {
    console.log(
      `\n${arm.arm}: ${arm.answered} of ${arm.payloads} answered ${JSON.stringify(arm.noAnswers)}, ${arm.errors} errors; ${arm.activated} activations; tokens in ${arm.inputTokens} out ${arm.outputTokens} (p95 ${arm.outputTokensP95}); latency p50 ${arm.latencyP50Ms} ms p95 ${arm.latencyP95Ms} ms max ${arm.latencyMaxMs} ms; $${arm.costUsd}`,
    );
  }
  console.log(`\n${summary.gate.status.toUpperCase()} ${summary.gate.id} ${summary.gate.title}`);
  for (const item of summary.gate.checks) console.log(`  ${item.status.padEnd(4)}  ${item.detail}`);
  if (stopped) console.log(`\nStopped at --max-usd ${args.maxUsd} after ${records.length} calls.`);
  console.log(`Results in ${outDir}`);
  return summary.gate.status === "fail" || stopped ? 1 : 0;
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(2);
    });
}
