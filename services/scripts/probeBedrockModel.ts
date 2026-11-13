/**
 * One Bedrock call with a request body built by production's own builders, to check a model before a switch
 * (LLM-11 probes P1-P5, scripts/eval/README.md): the summarizer's first call, corrective call or retry after a
 * refusal for one bill, or the resolver's call for one captured priority_request payload. It prints what came back:
 * the HTTP status, or the error's name and status and how classifyBedrockError reads it; then the content block
 * types, stop_reason, stop_details, usage, latency and output tokens per second, and whether the answer is usable.
 *
 * Without --yes it only writes the body to disk. --yes sends it once, with no retries, and needs --max-usd, which
 * must cover the call's worst case. It refuses to run in CI. It reads the bill store for --guid and writes nothing
 * to S3, SQS or DynamoDB.
 *
 *   npm run probe:bedrock -- --kind summarizer-first --guid BILLS-119s2402 --model us.anthropic.claude-haiku-5-5 --effort medium
 *   npm run probe:bedrock -- --kind summarizer-first --guid BILLS-119s2402 --model us.anthropic.claude-haiku-5-5 --effort medium --yes --max-usd 0.05
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { InvokeModelCommand, type BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { RawBillDao } from "../src/adapters/rawBillDao";
import {
  classifyBedrockError,
  createBedrockClient,
  readMessagesResponse,
  type MessagesRequestBody,
} from "../src/shared/bedrockMessages";
import { BILL_TEXT_BUDGET_CHARS } from "../src/handlers/billSummarizer/billText";
import {
  buildBedrockRequestBody,
  extractMinimalBillInfo,
  extractReducedBillInfo,
  interpretModelOutput,
  validateAnalysis,
  type SummarizerRequestOptions,
} from "../src/handlers/billSummarizer/prompts";
import { buildPriorityRequestBody } from "../src/handlers/billPriorityResolver/prompts";
import {
  ANSWER_TOKENS_PER_BILL,
  PRIORITY_ANSWER_TOKENS,
  activatedGuids,
  expectedCall,
  flagValue,
  parseArm,
  parseIssueSpecs,
  parsePositiveInteger,
  parsePriorityRequests,
  parseUsd,
  previousAnalysis,
  priorityAnswer,
  pricesFromEnv,
  usageCostUsd,
  worstCaseCallUsd,
  type EvalArm,
} from "./eval/scoring";

const RESULTS_DIR = path.join(__dirname, "eval", "results");
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const BUCKET_NAME = process.env.BUCKET_NAME ?? "billboard-bill-store-bucket";
// Production's model today (infra/lib/config/bedrock-models.ts), through the us. inference profile.
const DEFAULT_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
// max_tokens of each caller (infra/lib/config/summarizer-service-constants.ts, priority-service-constants.ts).
const SUMMARIZER_MAX_TOKENS = 8192;
const PRIORITY_MAX_TOKENS = 4096;
// Longer than either caller's per-call deadline (60 s and 75 s), so the probe sees how long the model takes.
const DEFAULT_TIMEOUT_MS = 120_000;

export const PROBE_KINDS = [
  "summarizer-first",
  "summarizer-corrective",
  "summarizer-refusal-retry",
  "priority",
] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export interface ProbeArgs {
  help: boolean;
  yes: boolean;
  maxUsd: number | null;
  kind: ProbeKind;
  arm: EvalArm;
  guid: string | null;
  /** A saved answer for the corrective body: a response.json, a {"bills": [...]} answer or one analysis. */
  previous: string | null;
  issues: string | null;
  /** priority_request lines (a Logs Insights export) for the resolver body. */
  payload: string | null;
  /** Which priority_request in the file, 1-based. */
  index: number;
  maxTokens: number;
  /** Top-level fields merged over the body, e.g. {"temperature":0} for P2. */
  extra: Record<string, unknown> | null;
  timeoutMs: number;
  out: string | null;
}

export const parseArgs = (argv: readonly string[]): ProbeArgs => {
  let help = false;
  let kind: string | null = null;
  let model = DEFAULT_MODEL;
  let effort = "default";
  let maxTokens: number | null = null;
  let extra: string | null = null;
  const args: Omit<ProbeArgs, "kind" | "arm" | "maxTokens" | "extra"> = {
    help: false,
    yes: false,
    maxUsd: null,
    guid: null,
    previous: null,
    issues: null,
    payload: null,
    index: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = flagValue(argv, i);
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg === "--max-usd") args.maxUsd = parseUsd(next(), arg);
    else if (arg === "--kind") kind = next();
    else if (arg === "--model") model = next();
    else if (arg === "--effort") effort = next();
    else if (arg === "--guid") args.guid = next();
    else if (arg === "--previous") args.previous = path.resolve(next());
    else if (arg === "--issues") args.issues = next();
    else if (arg === "--payload") args.payload = path.resolve(next());
    else if (arg === "--index") args.index = parsePositiveInteger(next(), arg);
    else if (arg === "--max-tokens") maxTokens = parsePositiveInteger(next(), arg);
    else if (arg === "--extra") extra = next();
    else if (arg === "--timeout-ms") args.timeoutMs = parsePositiveInteger(next(), arg);
    else if (arg === "--out") args.out = path.resolve(next());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!help && kind === null) throw new Error(`--kind is required: ${PROBE_KINDS.join(", ")}`);
  if (kind !== null && !(PROBE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`--kind takes ${PROBE_KINDS.join(", ")} (got ${kind})`);
  }
  const probeKind = (kind ?? "summarizer-first") as ProbeKind;
  const summarizer = probeKind !== "priority";
  const parsed: ProbeArgs = {
    ...args,
    help,
    kind: probeKind,
    arm: parseArm(`${model}:${effort}`),
    maxTokens: maxTokens ?? (summarizer ? SUMMARIZER_MAX_TOKENS : PRIORITY_MAX_TOKENS),
    extra: null,
  };
  if (help) return parsed;
  if (extra !== null) {
    let value: unknown = null;
    try {
      value = JSON.parse(extra);
    } catch {
      // Reported below.
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`--extra takes a JSON object (got ${extra})`);
    }
    parsed.extra = value as Record<string, unknown>;
  }
  if (summarizer && !parsed.guid) throw new Error(`--kind ${probeKind} needs --guid`);
  if (probeKind === "summarizer-corrective" && !parsed.previous) {
    throw new Error("--kind summarizer-corrective needs --previous <file> (an earlier answer, e.g. its response.json)");
  }
  if (parsed.issues && probeKind !== "summarizer-corrective") {
    throw new Error("--issues is for summarizer-corrective");
  }
  if (probeKind === "priority" && !parsed.payload) throw new Error("--kind priority needs --payload <file>");
  if (!summarizer && parsed.guid) throw new Error("--guid is for the summarizer kinds");
  if (parsed.yes && parsed.maxUsd === null) throw new Error("--yes needs --max-usd <dollars>");
  return parsed;
};

/** The body production would send, and what the answer is checked against. */
interface Probe {
  body: MessagesRequestBody;
  answerTokens: number;
  /** The bill's guid, or the resolver's candidate guids and maxResults. */
  target: { guid: string } | { candidates: Set<string>; maxResults: number };
}

const buildProbe = async (args: ProbeArgs): Promise<Probe> => {
  if (args.kind === "priority") {
    const { captures, skipped } = parsePriorityRequests(await readFile(args.payload!, "utf8"));
    const capture = captures[args.index - 1];
    if (!capture) {
      throw new Error(
        `${args.payload} has ${captures.length} priority_request lines (${skipped} others); no #${args.index}`,
      );
    }
    const { headlines, candidates } = capture.payload;
    return {
      body: buildPriorityRequestBody(headlines, candidates, {
        profile: args.arm.profile,
        maxTokens: args.maxTokens,
        effort: args.arm.effort,
        now: new Date(capture.now),
        maxResults: capture.maxResults,
      }),
      answerTokens: PRIORITY_ANSWER_TOKENS,
      target: { candidates: new Set(candidates.map((candidate) => candidate.guid)), maxResults: capture.maxResults },
    };
  }

  const guid = args.guid!;
  const raw = await new RawBillDao(new S3Client({ region: REGION }), BUCKET_NAME).getByGuid(guid);
  if (!raw) throw new Error(`${guid} is not in s3://${BUCKET_NAME}/raw-bills/`);
  const request: SummarizerRequestOptions = {
    profile: args.arm.profile,
    effort: args.arm.effort,
    maxTokens: args.maxTokens,
  };
  const input = extractMinimalBillInfo(raw, BILL_TEXT_BUDGET_CHARS, guid);
  let body: MessagesRequestBody;
  if (args.kind === "summarizer-refusal-retry") {
    body = buildBedrockRequestBody([extractReducedBillInfo(raw, guid)], request);
  } else if (args.kind === "summarizer-corrective") {
    const previous = previousAnalysis(JSON.parse(await readFile(args.previous!, "utf8")), guid);
    if (previous === undefined) throw new Error(`${args.previous} holds no answer for ${guid}`);
    const validation = validateAnalysis(previous);
    const issues = args.issues ? parseIssueSpecs(args.issues, previous) : validation.ok ? [] : validation.issues;
    if (issues.length === 0) {
      throw new Error("The previous answer breaks no rule; name the issues to send with --issues");
    }
    body = buildBedrockRequestBody([input], request, { previous, issues });
  } else {
    body = buildBedrockRequestBody([input], request);
  }
  return { body, answerTokens: ANSWER_TOKENS_PER_BILL, target: { guid } };
};

/** The request's shape without the prompt text: what P1-P4 check was sent. */
const describeBody = (body: MessagesRequestBody): string[] => {
  const shape = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "system" && key !== "messages"),
  ) as Record<string, unknown>;
  return [
    `top-level fields: ${Object.keys(body).join(", ")}`,
    `settings: ${JSON.stringify(shape)}`,
    `messages: ${body.messages.map((message) => message.role).join(", ")} (the last is ${body.messages.at(-1)?.role})`,
  ];
};

type SendOutcome =
  | { ok: true; status: number | null; json: unknown; latencyMs: number }
  | { ok: false; error: unknown; latencyMs: number };

/** One InvokeModel call, no retries, ended at timeoutMs. */
const sendOnce = async (
  client: Pick<BedrockRuntimeClient, "send">,
  modelId: string,
  body: MessagesRequestBody,
  timeoutMs: number,
): Promise<SendOutcome> => {
  const startedAt = Date.now();
  try {
    const response = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    const json = JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    return { ok: true, status: response.$metadata?.httpStatusCode ?? null, json, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error, latencyMs: Date.now() - startedAt };
  }
};

/** Whether the answer is one the caller could use, as the handler would judge it. */
const judgeAnswer = (probe: Probe, read: ReturnType<typeof readMessagesResponse>): string[] => {
  if ("guid" in probe.target) {
    const { guid } = probe.target;
    const output = interpretModelOutput(read.text, read.stopReason, [guid]);
    const candidate = output.analyses.get(guid);
    if (candidate === undefined) {
      return [`answer: no analysis for ${guid} (parsed ${output.parsed}, complete ${output.complete})`];
    }
    const validation = validateAnalysis(candidate);
    if (validation.ok) return ["answer: valid, within every limit"];
    return [
      `answer: ${validation.issues.some((issue) => issue.kind === "hard") ? "unusable" : "over a limit (would be corrected or fitted)"}`,
      ...validation.errors.map((error) => `  - ${error}`),
    ];
  }
  const answer = priorityAnswer(read);
  if (!answer.answered) {
    return [`answer: none (${answer.reason}); the resolver would carry over and log priority_no_answer`];
  }
  const activated = activatedGuids(answer.decisions, probe.target.candidates, probe.target.maxResults);
  return [`answer: ${answer.decisions.length} decisions, ${activated.length} would activate: ${activated.join(", ")}`];
};

const USAGE = `Usage: probeBedrockModel.ts --kind ${PROBE_KINDS.join("|")}
         [--model ID (default ${DEFAULT_MODEL})] [--effort low|medium|high|default] [--max-tokens N]
         [--guid GUID] [--previous FILE] [--issues field:rule,...] [--payload FILE] [--index N]
         [--extra JSON] [--timeout-ms N] [--out DIR] [--yes --max-usd USD]
See scripts/eval/README.md (probes P1-P5).`;

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<number> => {
  if (process.env.CI) {
    console.error("probeBedrockModel calls Bedrock and must not run in CI.");
    return 2;
  }
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const probe = await buildProbe(args);
  const body: MessagesRequestBody = args.extra ? { ...probe.body, ...args.extra } : probe.body;
  const outDir = args.out ?? path.join(RESULTS_DIR, `probe-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(outDir, { recursive: true });
  const bodyFile = path.join(outDir, "body.json");
  await writeFile(bodyFile, `${JSON.stringify(body, null, 2)}\n`);

  const prices = pricesFromEnv()[args.arm.profile];
  const expected = expectedCall(body, args.arm, prices, probe.answerTokens);
  const worstCase = worstCaseCallUsd(body, args.arm.profile, prices);
  console.log(`${args.kind} for ${args.arm.modelId} (${args.arm.profile}, effort ${args.arm.effort})`);
  for (const line of describeBody(body)) console.log(`  ${line}`);
  console.log(`Estimate: about $${expected.usd.toFixed(4)}, at most $${worstCase.toFixed(4)}. Body: ${bodyFile}`);
  if (!args.yes) {
    console.log("Dry run only. Re-run with --yes --max-usd <dollars> to send it once.");
    return 0;
  }
  if (worstCase > args.maxUsd!) {
    console.error(`The call could cost up to $${worstCase.toFixed(4)}, over --max-usd ${args.maxUsd}.`);
    return 2;
  }

  const sent = await sendOnce(createBedrockClient({ region: REGION }), args.arm.modelId, body, args.timeoutMs);
  const seconds = `${(sent.latencyMs / 1000).toFixed(1)} s`;
  if (!sent.ok) {
    const classified = classifyBedrockError(sent.error);
    const message = sent.error instanceof Error ? sent.error.message : String(sent.error);
    console.log(
      `Error after ${seconds}: ${classified.errorName ?? "unknown"} (HTTP ${classified.httpStatus ?? "none"}), classified ${classified.kind}`,
    );
    console.log(`  ${message}`);
    await writeFile(
      path.join(outDir, "error.json"),
      `${JSON.stringify({ ...classified, message, latencyMs: sent.latencyMs }, null, 2)}\n`,
    );
    return 1;
  }

  const read = readMessagesResponse(sent.json);
  const cost = usageCostUsd(read.usage, prices);
  await writeFile(path.join(outDir, "response.json"), `${JSON.stringify(sent.json, null, 2)}\n`);
  await writeFile(path.join(outDir, "answer.txt"), read.text);
  console.log(`HTTP ${sent.status ?? "?"} in ${seconds}`);
  console.log(`  content types: ${read.contentTypes.join(", ") || "none"} (${read.thinkingBlocks} thinking)`);
  console.log(`  stop_reason: ${read.stopReason}; stop_details: ${JSON.stringify(read.stopDetails)}`);
  console.log(`  outcome: ${read.outcome}; text ${read.textChars} characters`);
  console.log(`  usage: ${JSON.stringify(read.usage)}; cost ${cost === null ? "unknown" : `$${cost.toFixed(4)}`}`);
  if (read.usage.output !== null && sent.latencyMs > 0) {
    console.log(`  output tokens per second: ${(read.usage.output / (sent.latencyMs / 1000)).toFixed(0)}`);
  }
  for (const line of judgeAnswer(probe, read)) console.log(`  ${line}`);
  console.log(`Response in ${outDir} (response.json can be the --previous of a corrective probe)`);
  return 0;
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(2);
    });
}
