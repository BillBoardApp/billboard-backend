import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type BedrockRuntimeClientConfig,
} from "@aws-sdk/client-bedrock-runtime";
import { logger } from "./logger";
import { emitEmbeddedMetrics, type EmbeddedMetricInput } from "./metrics";
import { backoffDelayMs, sleep as defaultSleep } from "./retry";

/**
 * Anthropic Messages calls through Bedrock InvokeModel (LLM-11), shared by BillSummarizer,
 * BillPriorityResolver and the eval and probe scripts, so all of them send and read the same way.
 *
 * - `requestProfileForModel` and `modelRequestFields` keep the body valid for the configured model:
 *   Haiku 4.5 takes temperature and rejects effort; Haiku 5.5 rejects temperature, top_p, top_k and an
 *   assistant prefill with a 400 and takes `output_config.effort` instead.
 * - `readMessagesResponse` checks stop_reason before content. Haiku 5.5 thinks by default, so a thinking
 *   block can come first (text is read by block type, never content[0]), and a refusal is an HTTP 200
 *   with stop_reason "refusal" whose partial content must not be used.
 * - `invokeMessages` makes the call: one attempt per send (createBedrockClient), its own retries while
 *   the invocation has time, a deadline per attempt, one `bedrock_call` log line per attempt and the
 *   BillBoard/Bedrock metrics.
 */

export const BEDROCK_METRIC_NAMESPACE = "BillBoard/Bedrock";

// ─── Request ──────────────────────────────────────────────────────────────────

/** The request shape a model takes. */
export type RequestProfile = "haiku-4-5" | "haiku-5-5";

/** Haiku 5.5's output_config.effort; "default" sends none, which is the model's default (medium). */
export type BedrockEffort = "low" | "medium" | "high" | "default";

const EFFORTS: readonly BedrockEffort[] = ["low", "medium", "high", "default"];

// Matched anywhere in a model ID, an inference profile ID or either ARN.
const PROFILE_PATTERNS: ReadonlyArray<readonly [RegExp, RequestProfile]> = [
  [/claude-haiku-4-5(?!\d)/, "haiku-4-5"],
  [/claude-haiku-5-5(?!\d)/, "haiku-5-5"],
];

const matchRequestProfile = (modelIdOrArn: string): RequestProfile | null =>
  PROFILE_PATTERNS.find(([pattern]) => pattern.test(modelIdOrArn))?.[1] ?? null;

/**
 * The request profile for a model ID, inference profile ID or ARN. Any other model throws, so a
 * function configured with a model this code has no request shape for fails at cold start instead of
 * sending bodies Bedrock rejects.
 */
export const requestProfileForModel = (modelIdOrArn: string): RequestProfile => {
  const profile = typeof modelIdOrArn === "string" ? matchRequestProfile(modelIdOrArn) : null;
  if (!profile) throw new Error(`Unknown Bedrock model profile: ${modelIdOrArn}`);
  return profile;
};

/** Reads an effort setting such as BEDROCK_EFFORT: unset or blank gives `fallback`, an unknown value throws. */
export const parseEffort = (value: string | undefined, fallback: BedrockEffort): BedrockEffort => {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return fallback;
  if (!(EFFORTS as readonly string[]).includes(trimmed)) throw new Error(`Invalid Bedrock effort: ${value}`);
  return trimmed as BedrockEffort;
};

export interface ModelRequestFields {
  temperature?: 0;
  output_config?: { effort: Exclude<BedrockEffort, "default"> };
}

/**
 * The top-level request fields that differ by model:
 * - haiku-4-5: temperature 0 when asked, never output_config (effort is an error on 4.5);
 * - haiku-5-5: output_config.effort unless "default", never temperature.
 * No profile sends thinking (Haiku 5.5's adaptive thinking is its default), top_p, top_k, fallbacks,
 * anthropic_beta, cache_control, tools, tool_choice, stop_sequences or output_config.format.
 */
export const modelRequestFields = (
  profile: RequestProfile,
  { effort, temperatureZero = false }: { effort: BedrockEffort; temperatureZero?: boolean },
): ModelRequestFields => {
  if (profile === "haiku-4-5") return temperatureZero ? { temperature: 0 } : {};
  return effort === "default" ? {} : { output_config: { effort } };
};

/** An InvokeModel body in the Anthropic Messages format, as the prompt builders return it. */
export interface MessagesRequestBody {
  anthropic_version: string;
  max_tokens: number;
  messages: ReadonlyArray<{ role: string; content: unknown }>;
  system?: string;
  temperature?: number;
  output_config?: { effort?: string };
}

// ─── Response ─────────────────────────────────────────────────────────────────

export interface MessagesContentBlock {
  type?: string;
  text?: unknown;
  thinking?: string;
  signature?: string;
  data?: string;
}

export interface MessagesStopDetails {
  type?: string;
  category?: string | null;
  explanation?: string | null;
}

export interface MessagesResponse {
  content?: MessagesContentBlock[];
  stop_reason?: string | null;
  stop_details?: MessagesStopDetails | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens_details?: Record<string, unknown>;
  };
}

/**
 * ok: end_turn, stop_sequence or no stop reason. refusal: the model declined (the text is always '').
 * max_tokens: cut off, possibly with no text when thinking used the budget. incomplete: any other stop.
 */
export type ResponseOutcome = "ok" | "refusal" | "max_tokens" | "incomplete";

/** Token counts from the response; null when Bedrock did not report one. */
export interface MessagesUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  outputTokensDetails?: Record<string, unknown>;
}

export interface ReadResponse {
  outcome: ResponseOutcome;
  stopReason: string | null;
  stopDetails: MessagesStopDetails | null;
  /** stop_details.category of a refusal (cyber, bio, ...); null otherwise or when Bedrock sent none. */
  refusalCategory: string | null;
  /** Every text block joined, in order; thinking and other blocks are skipped. */
  text: string;
  textChars: number;
  contentTypes: string[];
  /** thinking plus redacted_thinking blocks. */
  thinkingBlocks: number;
  usage: MessagesUsage;
}

const responseOutcome = (stopReason: string | null): ResponseOutcome => {
  if (stopReason === null || stopReason === "end_turn" || stopReason === "stop_sequence") return "ok";
  if (stopReason === "refusal" || stopReason === "max_tokens") return stopReason;
  return "incomplete";
};

const tokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Reads a parsed Messages response body. Never throws; anything malformed reads as missing. */
export const readMessagesResponse = (json: unknown): ReadResponse => {
  const response = (json !== null && typeof json === "object" ? json : {}) as MessagesResponse;
  const blocks = (Array.isArray(response.content) ? response.content : []).filter(
    (block): block is MessagesContentBlock => block !== null && typeof block === "object",
  );
  const stopReason = typeof response.stop_reason === "string" ? response.stop_reason : null;
  const stopDetails =
    response.stop_details !== null && typeof response.stop_details === "object" ? response.stop_details : null;
  const outcome = responseOutcome(stopReason);
  // A refusal can carry the start of an answer the classifier then stopped: it is never used.
  const text =
    outcome === "refusal"
      ? ""
      : blocks
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("");
  const usage = response.usage !== null && typeof response.usage === "object" ? response.usage : {};
  const details = usage.output_tokens_details;

  return {
    outcome,
    stopReason,
    stopDetails,
    refusalCategory: outcome === "refusal" && typeof stopDetails?.category === "string" ? stopDetails.category : null,
    text,
    textChars: text.length,
    contentTypes: blocks.map((block) => (typeof block.type === "string" ? block.type : "unknown")),
    thinkingBlocks: blocks.filter((block) => block.type === "thinking" || block.type === "redacted_thinking").length,
    usage: {
      input: tokenCount(usage.input_tokens),
      output: tokenCount(usage.output_tokens),
      cacheRead: tokenCount(usage.cache_read_input_tokens),
      cacheCreation: tokenCount(usage.cache_creation_input_tokens),
      ...(details !== null && typeof details === "object" && !Array.isArray(details)
        ? { outputTokensDetails: details }
        : {}),
    },
  };
};

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * throttled: 429 or a throttling or quota error name. transient: 5xx, 424 (ModelErrorException),
 * ModelNotReady and network errors. invalid_request: 400 (ValidationException). access_denied: 403.
 * not_found: 404. timeout: our deadline (AbortError) or ModelTimeoutException (408). error: the rest.
 */
export type BedrockErrorKind =
  | "throttled"
  | "transient"
  | "invalid_request"
  | "access_denied"
  | "not_found"
  | "timeout"
  | "error";

export interface BedrockErrorClass {
  kind: BedrockErrorKind;
  errorName: string | null;
  httpStatus: number | null;
}

// Node network errors. The SDK renames ECONNRESET, EPIPE and ETIMEDOUT to TimeoutError and keeps the code.
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);

// The Bedrock client runs on HTTP/2 (NodeHttp2Handler, a fresh session per request). A refused or reset
// stream, a GOAWAY, and a connection that failed before the stream opened (ERR_HTTP2_STREAM_CANCEL, caused
// by ECONNREFUSED, ENOTFOUND, ...) arrive as these codes and messages.
const HTTP2_ERROR_CODES = new Set([
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_INVALID_SESSION",
]);
const NETWORK_ERROR_MESSAGE =
  /socket hang up|http2 request did not get a response|abnormally aborted in mid-communication|Frame type id .* has failed/i;

const TRANSIENT_ERROR_NAMES = new Set([
  "internalserverexception",
  "serviceunavailableexception",
  "modelerrorexception",
  // The SDK's own socket timeouts and the network errors it renames; our deadline is an AbortError.
  "timeouterror",
]);

const isThrottleName = (name: string): boolean =>
  name.includes("throttl") ||
  name.includes("too many") ||
  name.includes("toomanyrequests") ||
  name.includes("servicequotaexceeded");

const classifyKind = (name: string, status: number | null, code: string, message: string): BedrockErrorKind => {
  if (name === "aborterror") return "timeout";
  if (name === "modeltimeoutexception" || status === 408) return "timeout";
  // ModelNotReadyException comes back as a 429 but is not a quota problem.
  if (name === "modelnotreadyexception") return "transient";
  // Checked before the 400 rule: ServiceQuotaExceededException is a 400.
  if (status === 429 || isThrottleName(name)) return "throttled";
  if (name === "validationexception") return "invalid_request";
  if (name === "accessdeniedexception") return "access_denied";
  if (name === "resourcenotfoundexception") return "not_found";
  if (TRANSIENT_ERROR_NAMES.has(name) || status === 424 || (status !== null && status >= 500 && status <= 599)) {
    return "transient";
  }
  if (status === 400) return "invalid_request";
  if (status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (NETWORK_ERROR_CODES.has(code) || HTTP2_ERROR_CODES.has(code) || NETWORK_ERROR_MESSAGE.test(message)) {
    return "transient";
  }
  return "error";
};

/** Sorts an error from a Bedrock call into the kinds invokeMessages retries, alarms on or gives up on. */
export const classifyBedrockError = (error: unknown): BedrockErrorClass => {
  const candidate = (error ?? {}) as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    message?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const name = text(candidate.name);
  const code = text(candidate.Code) || text(candidate.code);
  // A plain Error says nothing; its code (ECONNRESET) does.
  const errorName = (name && name !== "Error" ? name : code || name) || null;
  const rawStatus = candidate.$metadata?.httpStatusCode ?? candidate.statusCode;
  const httpStatus = typeof rawStatus === "number" && Number.isFinite(rawStatus) ? rawStatus : null;

  return {
    kind: classifyKind((errorName ?? "").toLowerCase(), httpStatus, code, text(candidate.message)),
    errorName,
    httpStatus,
  };
};

/** A Bedrock call that failed for good: not retried, out of retries, or out of time. */
export class BedrockCallError extends Error {
  readonly kind: BedrockErrorKind;

  readonly errorName: string | null;

  readonly httpStatus: number | null;

  /** The last attempt, 0-based. */
  readonly attempt: number;

  /** The last attempt's latency; null when no call was started. */
  readonly latencyMs: number | null;

  constructor(
    message: string,
    details: BedrockErrorClass & { attempt: number; latencyMs: number | null },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BedrockCallError";
    this.kind = details.kind;
    this.errorName = details.errorName;
    this.httpStatus = details.httpStatus;
    this.attempt = details.attempt;
    this.latencyMs = details.latencyMs;
  }
}

// ─── Invoke ───────────────────────────────────────────────────────────────────

/**
 * A Bedrock runtime client that makes one attempt per send. The SDK's own retries (3 attempts by
 * default) would bypass the remaining-time check and write no log line; invokeMessages retries instead.
 */
export const createBedrockClient = (config: BedrockRuntimeClientConfig = {}): BedrockRuntimeClient =>
  new BedrockRuntimeClient({ ...config, maxAttempts: 1 });

/** Defaults for the invokeMessages options of the same names. */
export const BEDROCK_CALL_DEFAULTS = {
  callTimeoutMs: 60_000,
  marginMs: 5_000,
  // A Lambda timeout would fail the whole SQS batch, including bills already stored.
  minRemainingMs: 20_000,
  maxThrottleRetries: 4,
  maxTransientRetries: 2,
  // A model-side timeout is retried once; our own deadline never is.
  maxModelTimeoutRetries: 1,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
} as const;

const MAX_ERROR_MESSAGE_CHARS = 500;

export interface InvokeMessagesOptions {
  /** From createBedrockClient. */
  client: Pick<BedrockRuntimeClient, "send">;
  /** Model ID, inference profile ID or ARN, as InvokeModel takes it. */
  modelId: string;
  /** The Caller metric dimension and log field: "BillSummarizer" or "BillPriorityResolver". */
  caller: string;
  /** What the call is for, logged as `kind` ("first", "corrective", "refusal_retry", "batch", "priority"). */
  kind: string;
  body: MessagesRequestBody;
  /** Milliseconds left in the invocation (context.getRemainingTimeInMillis); unlimited when absent. */
  remainingMs?: () => number;
  /** Deadline for one attempt; an attempt also ends `marginMs` before the invocation would. */
  callTimeoutMs?: number;
  marginMs?: number;
  /** No attempt starts, and no retry is scheduled, with less than this left. */
  minRemainingMs?: number;
  maxThrottleRetries?: number;
  maxTransientRetries?: number;
  /** Retries of a ModelTimeoutException (408); an attempt our own deadline stopped is never retried. */
  maxModelTimeoutRetries?: number;
  /** Full-jitter backoff between retries (shared/retry.ts). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Added to every bedrock_call line (guids, correlationIds, ...); the line's own fields win. */
  logFields?: Record<string, unknown>;
  /** False writes no BillBoard/Bedrock metric lines (local scripts). */
  emitMetrics?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BedrockCallResult extends ReadResponse {
  latencyMs: number;
  /** The attempt that answered, 0-based. */
  attempt: number;
}

/** A bedrock_call outcome and the Outcome metric dimension. */
export type BedrockCallOutcome = ResponseOutcome | BedrockErrorKind | "skipped";

// Dimensionless counts the alarms read, by outcome.
const ALARM_METRICS: Partial<Record<BedrockCallOutcome, string>> = {
  invalid_request: "BedrockRequestRejected",
  access_denied: "BedrockRequestRejected",
  not_found: "BedrockRequestRejected",
  throttled: "BedrockThrottled",
  refusal: "BedrockRefusal",
};

const decoder = new TextDecoder();

const emitCallMetrics = (
  caller: string,
  outcome: BedrockCallOutcome,
  values: { latencyMs?: number; outputTokens?: number | null },
  alarmProperties: Record<string, unknown>,
): void => {
  const metrics: EmbeddedMetricInput[] = [{ name: "BedrockCalls", value: 1 }];
  if (values.latencyMs !== undefined) {
    metrics.push({ name: "BedrockLatency", value: values.latencyMs, unit: "Milliseconds" });
  }
  if (typeof values.outputTokens === "number") {
    metrics.push({ name: "BedrockOutputTokens", value: values.outputTokens });
  }
  emitEmbeddedMetrics(BEDROCK_METRIC_NAMESPACE, metrics, { dimensions: { Caller: caller, Outcome: outcome } });

  const alarmMetric = ALARM_METRICS[outcome];
  if (alarmMetric) {
    emitEmbeddedMetrics(BEDROCK_METRIC_NAMESPACE, [{ name: alarmMetric, value: 1 }], {
      properties: { caller, outcome, ...alarmProperties },
    });
  }
};

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE_CHARS);

/**
 * Sends one Messages request and reads the answer. Each attempt:
 * - starts only with at least `minRemainingMs` left (otherwise outcome "skipped" and a timeout error);
 * - ends at min(callTimeoutMs, remaining - marginMs) through an AbortSignal;
 * - writes one `bedrock_call` line: info when ok; warn for a refusal, max_tokens, an incomplete answer
 *   or an error that is retried; error when the call gives up.
 * Throttles are retried up to maxThrottleRetries, transient errors up to maxTransientRetries and a
 * ModelTimeoutException up to maxModelTimeoutRetries (once by default), each only while the backoff leaves
 * `minRemainingMs`. Rejected requests (400, 403, 404) and our own deadline are never retried.
 *
 * Resolves with every answer Bedrock returned, refusals and max_tokens included (check `outcome`);
 * rejects with BedrockCallError when no answer came back.
 */
export const invokeMessages = async (options: InvokeMessagesOptions): Promise<BedrockCallResult> => {
  const {
    client,
    modelId,
    caller,
    kind,
    body,
    remainingMs = () => Number.POSITIVE_INFINITY,
    callTimeoutMs = BEDROCK_CALL_DEFAULTS.callTimeoutMs,
    marginMs = BEDROCK_CALL_DEFAULTS.marginMs,
    minRemainingMs = BEDROCK_CALL_DEFAULTS.minRemainingMs,
    maxThrottleRetries = BEDROCK_CALL_DEFAULTS.maxThrottleRetries,
    maxTransientRetries = BEDROCK_CALL_DEFAULTS.maxTransientRetries,
    maxModelTimeoutRetries = BEDROCK_CALL_DEFAULTS.maxModelTimeoutRetries,
    baseDelayMs = BEDROCK_CALL_DEFAULTS.baseDelayMs,
    maxDelayMs = BEDROCK_CALL_DEFAULTS.maxDelayMs,
    logFields = {},
    emitMetrics = true,
    sleep = defaultSleep,
  } = options;
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
    throw new RangeError(`callTimeoutMs must be a positive finite number (got ${callTimeoutMs})`);
  }

  const requestBody = JSON.stringify(body);
  // What was sent, so a line shows the request shape without the prompt.
  const callFields = {
    caller,
    modelId,
    requestProfile: matchRequestProfile(modelId),
    effort: body.output_config?.effort ?? null,
    max_tokens: body.max_tokens,
    kind,
  };
  const log = (level: "info" | "warn" | "error", fields: Record<string, unknown>): void => {
    logger[level]("bedrock_call", { event: "bedrock_call", ...logFields, ...callFields, ...fields });
  };
  const retryLimits: Partial<Record<BedrockErrorKind, number>> = {
    throttled: maxThrottleRetries,
    transient: maxTransientRetries,
    timeout: maxModelTimeoutRetries,
  };
  const retries: Partial<Record<BedrockErrorKind, number>> = {};

  for (let attempt = 0; ; attempt += 1) {
    const remaining = remainingMs();
    if (remaining < minRemainingMs) {
      log("error", { attempt, outcome: "skipped", remainingMs: remaining });
      if (emitMetrics) emitCallMetrics(caller, "skipped", {}, {});
      throw new BedrockCallError(`Not enough time left for a Bedrock call (${remaining}ms remaining)`, {
        kind: "timeout",
        errorName: null,
        httpStatus: null,
        attempt,
        latencyMs: null,
      });
    }

    const timeoutMs = Math.max(1, Math.floor(Math.min(callTimeoutMs, remaining - marginMs)));
    const deadline = AbortSignal.timeout(timeoutMs);
    const startedAt = Date.now();
    let read: ReadResponse;
    try {
      const response = await client.send(
        new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body: requestBody,
        }),
        { abortSignal: deadline },
      );
      read = readMessagesResponse(JSON.parse(decoder.decode(response.body)));
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const sdkError = classifyBedrockError(error);
      // The deadline is the only signal the call gets: an attempt that ended after it fired, however the
      // SDK words it, or with an AbortError, was stopped by us.
      const ownDeadline = deadline.aborted || sdkError.errorName === "AbortError";
      const classified: BedrockErrorClass = ownDeadline ? { ...sdkError, kind: "timeout" } : sdkError;
      const used = retries[classified.kind] ?? 0;
      const limit = ownDeadline ? 0 : (retryLimits[classified.kind] ?? 0);
      const delayMs = used < limit ? backoffDelayMs(used, { baseMs: baseDelayMs, maxMs: maxDelayMs }) : null;
      const willRetry = delayMs !== null && remainingMs() - delayMs >= minRemainingMs;

      log(willRetry ? "warn" : "error", {
        attempt,
        outcome: classified.kind,
        latencyMs,
        timeoutMs,
        errorName: classified.errorName,
        httpStatus: classified.httpStatus,
        errorMessage: errorText(error),
        ...(willRetry ? { retryInMs: delayMs } : {}),
      });
      if (emitMetrics) {
        emitCallMetrics(
          caller,
          classified.kind,
          { latencyMs },
          { modelId, errorName: classified.errorName, httpStatus: classified.httpStatus },
        );
      }
      if (!willRetry) {
        const status = classified.httpStatus === null ? "" : ` ${classified.httpStatus}`;
        throw new BedrockCallError(
          `Bedrock call failed (${classified.kind}, ${classified.errorName ?? "unknown"}${status}) on attempt ${attempt + 1}: ${errorText(error)}`,
          { ...classified, attempt, latencyMs },
          { cause: error },
        );
      }
      retries[classified.kind] = used + 1;
      await sleep(delayMs);
      continue;
    }

    const latencyMs = Date.now() - startedAt;
    log(read.outcome === "ok" ? "info" : "warn", {
      attempt,
      outcome: read.outcome,
      latencyMs,
      timeoutMs,
      stop_reason: read.stopReason,
      refusal_category: read.refusalCategory,
      content_types: read.contentTypes,
      thinking_blocks: read.thinkingBlocks,
      text_chars: read.textChars,
      input_tokens: read.usage.input,
      output_tokens: read.usage.output,
      cache_read_input_tokens: read.usage.cacheRead,
      cache_creation_input_tokens: read.usage.cacheCreation,
      ...(read.usage.outputTokensDetails ? { output_tokens_details: read.usage.outputTokensDetails } : {}),
    });
    if (emitMetrics) {
      emitCallMetrics(
        caller,
        read.outcome,
        { latencyMs, outputTokens: read.usage.output },
        { modelId, category: read.refusalCategory },
      );
    }
    return { ...read, latencyMs, attempt };
  }
};
