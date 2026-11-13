import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { applyTestEnv } from "./fixtures/env";
import type { LogLine } from "./logLines";
import {
  BedrockCallError,
  classifyBedrockError,
  createBedrockClient,
  invokeMessages,
  modelRequestFields,
  parseEffort,
  readMessagesResponse,
  requestProfileForModel,
  type InvokeMessagesOptions,
  type MessagesRequestBody,
} from "../shared/bedrockMessages";

// LLM-11: the request shapes, response reading and call loop both Bedrock callers and the eval share.

const HAIKU_45_PROFILE_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU_55_PROFILE_ARN = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-5-5";

const requestBody = (overrides: Partial<MessagesRequestBody> = {}): MessagesRequestBody => ({
  anthropic_version: "bedrock-2023-05-31",
  max_tokens: 8192,
  output_config: { effort: "medium" },
  system: "You summarize bills.",
  messages: [{ role: "user", content: [{ type: "text", text: "Bills: []" }] }],
  ...overrides,
});

const bedrockResponse = (fields: Record<string, unknown> = {}) => ({
  body: new TextEncoder().encode(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: '{"bills":[]}' },
      ],
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 900, output_tokens: 140 },
      ...fields,
    }),
  ),
});

const bedrockError = (name: string, httpStatusCode?: number, message = `${name} message`): Error =>
  Object.assign(new Error(message), {
    name,
    ...(httpStatusCode === undefined ? {} : { $metadata: { httpStatusCode } }),
  });

// What @smithy/node-http-handler rejects with when the request's abortSignal fires.
const sdkAbortError = (): Error => Object.assign(new Error("Request aborted"), { name: "AbortError" });

describe("requestProfileForModel", () => {
  it.each([
    "anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    HAIKU_45_PROFILE_ARN,
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
  ])("maps %s to haiku-4-5", (modelId) => {
    expect(requestProfileForModel(modelId)).toBe("haiku-4-5");
  });

  it.each([
    "anthropic.claude-haiku-5-5",
    "us.anthropic.claude-haiku-5-5",
    "global.anthropic.claude-haiku-5-5",
    HAIKU_55_PROFILE_ARN,
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5",
  ])("maps %s to haiku-5-5", (modelId) => {
    expect(requestProfileForModel(modelId)).toBe("haiku-5-5");
  });

  it.each([
    "anthropic.claude-sonnet-4-5-20250929-v1:0",
    "us.anthropic.claude-haiku-4-55",
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3",
    "haiku",
    "",
  ])("throws for %p, which has no request profile", (modelId) => {
    expect(() => requestProfileForModel(modelId)).toThrow(`Unknown Bedrock model profile: ${modelId}`);
  });

  it("throws for a missing MODEL_ID", () => {
    expect(() => requestProfileForModel(undefined as unknown as string)).toThrow(
      "Unknown Bedrock model profile: undefined",
    );
  });
});

describe("parseEffort", () => {
  it("returns the fallback when unset or blank", () => {
    expect(parseEffort(undefined, "medium")).toBe("medium");
    expect(parseEffort("  ", "low")).toBe("low");
  });

  it("accepts low, medium, high and default", () => {
    expect(["low", " medium ", "high", "default"].map((value) => parseEffort(value, "low"))).toEqual([
      "low",
      "medium",
      "high",
      "default",
    ]);
  });

  it.each(["max", "xhigh", "Medium", "none"])("throws for %p", (value) => {
    expect(() => parseEffort(value, "medium")).toThrow(`Invalid Bedrock effort: ${value}`);
  });
});

describe("modelRequestFields", () => {
  const FORBIDDEN_FIELDS = [
    "thinking",
    "top_p",
    "top_k",
    "fallbacks",
    "anthropic_beta",
    "cache_control",
    "tools",
    "tool_choice",
    "stop_sequences",
  ];

  it("sends temperature 0 on Haiku 4.5 only when asked, and never effort", () => {
    expect(modelRequestFields("haiku-4-5", { effort: "medium", temperatureZero: true })).toEqual({ temperature: 0 });
    expect(modelRequestFields("haiku-4-5", { effort: "low", temperatureZero: false })).toEqual({});
    expect(modelRequestFields("haiku-4-5", { effort: "high" })).toEqual({});
  });

  it.each(["low", "medium", "high"] as const)("sends output_config.effort %s on Haiku 5.5", (effort) => {
    expect(modelRequestFields("haiku-5-5", { effort })).toEqual({ output_config: { effort } });
  });

  it("omits output_config on Haiku 5.5 for the default effort", () => {
    expect(modelRequestFields("haiku-5-5", { effort: "default" })).toEqual({});
  });

  it("never sends sampling parameters, thinking, fallbacks or a format on Haiku 5.5", () => {
    for (const effort of ["low", "medium", "high", "default"] as const) {
      const fields = modelRequestFields("haiku-5-5", { effort, temperatureZero: true });
      expect(fields).not.toHaveProperty("temperature");
      for (const name of FORBIDDEN_FIELDS) expect(fields).not.toHaveProperty(name);
      expect(fields.output_config ?? {}).not.toHaveProperty("format");
    }
  });
});

describe("readMessagesResponse", () => {
  it("reads the text after a leading thinking block", () => {
    const read = readMessagesResponse({
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: '{"bills":[]}' },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    expect(read).toMatchObject({
      outcome: "ok",
      stopReason: "end_turn",
      refusalCategory: null,
      text: '{"bills":[]}',
      textChars: 12,
      contentTypes: ["thinking", "text"],
      thinkingBlocks: 1,
    });
  });

  it("joins only the text blocks with string text, in order", () => {
    const read = readMessagesResponse({
      content: [
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: '{"bills":' },
        { type: "thinking", thinking: "not this" },
        { type: "text", text: 7 },
        { type: "text", text: "[]}" },
        null,
        { text: "no type" },
      ],
      stop_reason: "end_turn",
    });

    expect(read.text).toBe('{"bills":[]}');
    expect(read.contentTypes).toEqual(["redacted_thinking", "text", "thinking", "text", "text", "unknown"]);
    expect(read.thinkingBlocks).toBe(2);
  });

  it("reads a refusal with no content and its category", () => {
    const read = readMessagesResponse({
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    });

    expect(read).toMatchObject({ outcome: "refusal", refusalCategory: "cyber", text: "", textChars: 0 });
    expect(read.stopDetails).toEqual({ type: "refusal", category: "cyber", explanation: null });
  });

  it("ignores the partial content of a refusal", () => {
    const read = readMessagesResponse({
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: '{"bills":[{"guid":"BILLS-119hr1ih","title":"Sets' },
      ],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "bio" },
    });

    expect(read).toMatchObject({ outcome: "refusal", refusalCategory: "bio", text: "", textChars: 0 });
    expect(read.contentTypes).toEqual(["thinking", "text"]);
  });

  it("reads a refusal without stop_details", () => {
    const read = readMessagesResponse({ content: [], stop_reason: "refusal", stop_details: null });

    expect(read).toMatchObject({ outcome: "refusal", refusalCategory: null, stopDetails: null });
  });

  it("reads max_tokens with no text when thinking used the budget", () => {
    const read = readMessagesResponse({
      content: [{ type: "thinking", thinking: "long", signature: "s" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 5000, output_tokens: 8192 },
    });

    expect(read).toMatchObject({ outcome: "max_tokens", text: "", thinkingBlocks: 1 });
    expect(read.usage.output).toBe(8192);
  });

  it("keeps the partial text of a max_tokens answer", () => {
    const read = readMessagesResponse({ content: [{ type: "text", text: '{"bills":[{' }], stop_reason: "max_tokens" });

    expect(read).toMatchObject({ outcome: "max_tokens", text: '{"bills":[{' });
  });

  it.each([
    ["end_turn", "ok"],
    ["stop_sequence", "ok"],
    [null, "ok"],
    [undefined, "ok"],
    ["pause_turn", "incomplete"],
    ["tool_use", "incomplete"],
    ["model_context_window_exceeded", "incomplete"],
  ])("maps stop_reason %p to %s", (stopReason, outcome) => {
    expect(readMessagesResponse({ content: [], stop_reason: stopReason }).outcome).toBe(outcome);
  });

  it("reads the cache usage fields and output token details", () => {
    const read = readMessagesResponse({
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 0,
        output_tokens_details: { thinking_tokens: 30 },
      },
    });

    expect(read.usage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 4000,
      cacheCreation: 0,
      outputTokensDetails: { thinking_tokens: 30 },
    });
  });

  it("reads missing usage as null and never throws on a malformed body", () => {
    expect(readMessagesResponse({ stop_reason: "end_turn" }).usage).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheCreation: null,
    });
    for (const body of [null, "text", 42, [], { content: "text", usage: null }]) {
      expect(readMessagesResponse(body)).toMatchObject({ outcome: "ok", text: "", contentTypes: [] });
    }
  });
});

describe("classifyBedrockError", () => {
  it.each([
    ["ThrottlingException", 429, "throttled"],
    ["ServiceQuotaExceededException", 400, "throttled"],
    ["TooManyRequestsException", undefined, "throttled"],
    ["ModelNotReadyException", 429, "transient"],
    ["ValidationException", 400, "invalid_request"],
    ["AccessDeniedException", 403, "access_denied"],
    ["ResourceNotFoundException", 404, "not_found"],
    ["ModelTimeoutException", 408, "timeout"],
    ["ModelErrorException", 424, "transient"],
    ["InternalServerException", 500, "transient"],
    ["ServiceUnavailableException", 503, "transient"],
    ["UnknownError", 502, "transient"],
    ["UnrecognizedClientException", 403, "access_denied"],
    ["SomethingElse", 400, "invalid_request"],
    ["SomethingElse", 404, "not_found"],
    ["SomethingElse", undefined, "error"],
  ])("classifies %s (HTTP %p) as %s", (name, status, kind) => {
    expect(classifyBedrockError(bedrockError(name, status))).toEqual({
      kind,
      errorName: name,
      httpStatus: status ?? null,
    });
  });

  it("classifies the SDK's abort as a timeout", () => {
    expect(classifyBedrockError(sdkAbortError())).toEqual({
      kind: "timeout",
      errorName: "AbortError",
      httpStatus: null,
    });
  });

  it("classifies network errors as transient", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    // The SDK renames ECONNRESET, EPIPE and ETIMEDOUT to TimeoutError.
    const renamed = Object.assign(new Error("read ECONNRESET"), { name: "TimeoutError", code: "ECONNRESET" });
    const hangUp = new Error("socket hang up");

    expect(classifyBedrockError(reset)).toEqual({ kind: "transient", errorName: "ECONNRESET", httpStatus: null });
    expect(classifyBedrockError(renamed)).toEqual({ kind: "transient", errorName: "TimeoutError", httpStatus: null });
    expect(classifyBedrockError(hangUp)).toEqual({ kind: "transient", errorName: "Error", httpStatus: null });
  });

  // The client's NodeHttp2Handler opens a session per request; these are what it rejects with.
  it("classifies HTTP/2 stream and session failures as transient", () => {
    const refused = Object.assign(new Error("Stream closed with error code NGHTTP2_REFUSED_STREAM"), {
      code: "ERR_HTTP2_STREAM_ERROR",
    });
    const notConnected = Object.assign(
      new Error("The pending stream has been canceled (caused by: connect ECONNREFUSED 192.0.2.1:443)"),
      {
        code: "ERR_HTTP2_STREAM_CANCEL",
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      },
    );

    expect(classifyBedrockError(refused)).toEqual({
      kind: "transient",
      errorName: "ERR_HTTP2_STREAM_ERROR",
      httpStatus: null,
    });
    expect(classifyBedrockError(notConnected)).toEqual({
      kind: "transient",
      errorName: "ERR_HTTP2_STREAM_CANCEL",
      httpStatus: null,
    });
    for (const code of ["ERR_HTTP2_SESSION_ERROR", "ERR_HTTP2_GOAWAY_SESSION", "ERR_HTTP2_INVALID_SESSION"]) {
      expect(classifyBedrockError(Object.assign(new Error("session closed"), { code })).kind).toBe("transient");
    }
  });

  it.each([
    "Unexpected error: http2 request did not get a response",
    "HTTP/2 stream is abnormally aborted in mid-communication with result code 2.",
    "Frame type id 1 in stream id 1 has failed with code 7.",
  ])("classifies the HTTP/2 handler's %p as transient", (message) => {
    expect(classifyBedrockError(new Error(message))).toEqual({
      kind: "transient",
      errorName: "Error",
      httpStatus: null,
    });
  });

  it("classifies anything else as error", () => {
    expect(classifyBedrockError(new SyntaxError("Unexpected token"))).toEqual({
      kind: "error",
      errorName: "SyntaxError",
      httpStatus: null,
    });
    expect(classifyBedrockError("boom")).toEqual({ kind: "error", errorName: null, httpStatus: null });
    expect(classifyBedrockError(undefined)).toEqual({ kind: "error", errorName: null, httpStatus: null });
  });
});

describe("createBedrockClient", () => {
  it("makes one attempt per send, whatever the config asks", async () => {
    const client = createBedrockClient({ region: "us-east-1", maxAttempts: 3 });
    try {
      expect(client).toBeInstanceOf(BedrockRuntimeClient);
      expect(await client.config.maxAttempts()).toBe(1);
      expect(await client.config.region()).toBe("us-east-1");
    } finally {
      client.destroy();
    }
  });
});

describe("invokeMessages", () => {
  const send = jest.fn();
  const sleep = jest.fn(async (_ms: number) => undefined);
  let restoreEnv: (() => void) | undefined;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let timeoutSpy: jest.SpyInstance;
  let deadlines: AbortController[];

  beforeEach(() => {
    send.mockReset();
    sleep.mockClear();
    restoreEnv = applyTestEnv({
      AWS_LAMBDA_FUNCTION_NAME: "BillSummarizer",
      AWS_LAMBDA_LOG_FORMAT: undefined,
      LOG_LEVEL: undefined,
    });
    logSpy = jest.spyOn(console, "log").mockImplementation();
    warnSpy = jest.spyOn(console, "warn").mockImplementation();
    errorSpy = jest.spyOn(console, "error").mockImplementation();
    // Each attempt's deadline is a controller the test can fire.
    deadlines = [];
    timeoutSpy = jest.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv?.();
    restoreEnv = undefined;
  });

  const invoke = (overrides: Partial<InvokeMessagesOptions> = {}) =>
    invokeMessages({
      client: { send } as unknown as InvokeMessagesOptions["client"],
      modelId: HAIKU_55_PROFILE_ARN,
      caller: "BillSummarizer",
      kind: "first",
      body: requestBody(),
      logFields: { guids: ["BILLS-119hr1ih"], correlationIds: ["corr-1"] },
      sleep,
      ...overrides,
    });

  /** Every JSON line written through console, in the order written. */
  const linesInOrder = (): LogLine[] =>
    [logSpy, warnSpy, errorSpy]
      .flatMap((spy) => spy.mock.calls.map(([line], index) => ({ line, order: spy.mock.invocationCallOrder[index] })))
      .sort((a, b) => a.order - b.order)
      .flatMap(({ line }) => (typeof line === "string" && line.startsWith("{") ? [JSON.parse(line) as LogLine] : []));
  const callLines = () => linesInOrder().filter((line) => line.event === "bedrock_call");
  const metricLines = () =>
    linesInOrder().filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/Bedrock");
  const metricLinesWith = (name: string) => metricLines().filter((line) => name in line);

  const rejection = async (promise: Promise<unknown>): Promise<BedrockCallError> => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BedrockCallError);
    return error as BedrockCallError;
  };

  it("sends the body once with a deadline and returns the read answer", async () => {
    send.mockResolvedValueOnce(bedrockResponse());
    const body = requestBody();

    const result = await invoke({ body, remainingMs: () => 100_000, callTimeoutMs: 60_000 });

    expect(send).toHaveBeenCalledTimes(1);
    const [command, sendOptions] = send.mock.calls[0];
    expect(command.input).toEqual({
      modelId: HAIKU_55_PROFILE_ARN,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    });
    expect(sendOptions).toEqual({ abortSignal: deadlines[0].signal });
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(result).toMatchObject({
      outcome: "ok",
      text: '{"bills":[]}',
      contentTypes: ["thinking", "text"],
      thinkingBlocks: 1,
      usage: { input: 900, output: 140 },
      attempt: 0,
    });
    expect(typeof result.latencyMs).toBe("number");
  });

  it("ends an attempt 5 seconds before the invocation would", async () => {
    send.mockResolvedValueOnce(bedrockResponse());

    await invoke({ remainingMs: () => 40_000, callTimeoutMs: 60_000 });

    expect(timeoutSpy).toHaveBeenCalledWith(35_000);
  });

  it("uses the call timeout alone without an invocation deadline", async () => {
    send.mockResolvedValueOnce(bedrockResponse());

    await invoke({ callTimeoutMs: 75_000 });

    expect(timeoutSpy).toHaveBeenCalledWith(75_000);
  });

  it("does not start a call with less than the minimum time left", async () => {
    const error = await rejection(invoke({ remainingMs: () => 19_999 }));

    expect(send).not.toHaveBeenCalled();
    expect(error).toMatchObject({ kind: "timeout", errorName: null, httpStatus: null, attempt: 0, latencyMs: null });
    expect(error.message).toBe("Not enough time left for a Bedrock call (19999ms remaining)");
    expect(callLines()).toEqual([
      expect.objectContaining({ level: "ERROR", outcome: "skipped", attempt: 0, remainingMs: 19_999 }),
    ]);
    expect(metricLinesWith("BedrockCalls")).toEqual([
      expect.objectContaining({ Caller: "BillSummarizer", Outcome: "skipped" }),
    ]);
  });

  it("writes one bedrock_call line per attempt with the request shape and the answer", async () => {
    send.mockResolvedValueOnce(
      bedrockResponse({
        usage: { input_tokens: 900, output_tokens: 140, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    );

    await invoke({ kind: "corrective", logFields: { guids: ["BILLS-119hr1ih"], outcome: "not mine" } });

    expect(callLines()).toEqual([
      expect.objectContaining({
        level: "INFO",
        message: "bedrock_call",
        fn: "BillSummarizer",
        event: "bedrock_call",
        guids: ["BILLS-119hr1ih"],
        caller: "BillSummarizer",
        modelId: HAIKU_55_PROFILE_ARN,
        requestProfile: "haiku-5-5",
        effort: "medium",
        max_tokens: 8192,
        kind: "corrective",
        attempt: 0,
        outcome: "ok",
        timeoutMs: 60_000,
        stop_reason: "end_turn",
        refusal_category: null,
        content_types: ["thinking", "text"],
        thinking_blocks: 1,
        text_chars: 12,
        input_tokens: 900,
        output_tokens: 140,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ]);
    expect(typeof callLines()[0].latencyMs).toBe("number");
  });

  it("logs the Haiku 4.5 shape as no effort", async () => {
    send.mockResolvedValueOnce(bedrockResponse({ content: [{ type: "text", text: "{}" }] }));

    await invoke({
      modelId: HAIKU_45_PROFILE_ARN,
      body: requestBody({ output_config: undefined, temperature: 0, max_tokens: 4096 }),
    });

    expect(callLines()[0]).toMatchObject({ requestProfile: "haiku-4-5", effort: null, max_tokens: 4096 });
  });

  it("emits BedrockCalls, BedrockLatency and BedrockOutputTokens by caller and outcome", async () => {
    send.mockResolvedValueOnce(bedrockResponse());

    await invoke({ caller: "BillPriorityResolver", kind: "priority" });

    const lines = metricLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      Caller: "BillPriorityResolver",
      Outcome: "ok",
      BedrockCalls: 1,
      BedrockOutputTokens: 140,
    });
    expect(typeof lines[0].BedrockLatency).toBe("number");
    expect(lines[0]._aws!.CloudWatchMetrics).toEqual([
      {
        Namespace: "BillBoard/Bedrock",
        Dimensions: [["Caller", "Outcome"]],
        Metrics: [
          { Name: "BedrockCalls", Unit: "Count" },
          { Name: "BedrockLatency", Unit: "Milliseconds" },
          { Name: "BedrockOutputTokens", Unit: "Count" },
        ],
      },
    ]);
  });

  it("writes no metric lines when asked not to", async () => {
    send.mockResolvedValueOnce(bedrockResponse({ stop_reason: "refusal", stop_details: { category: "cyber" } }));

    await invoke({ emitMetrics: false });

    expect(metricLines()).toEqual([]);
    expect(callLines()).toHaveLength(1);
  });

  it("returns a refusal without retrying, with a warning and a dimensionless BedrockRefusal", async () => {
    send.mockResolvedValueOnce(
      bedrockResponse({
        content: [{ type: "text", text: '{"bills":[{"guid":' }],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "frontier_llm" },
      }),
    );

    const result = await invoke();

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "refusal", refusalCategory: "frontier_llm", text: "" });
    expect(callLines()).toEqual([
      expect.objectContaining({ level: "WARN", outcome: "refusal", refusal_category: "frontier_llm", text_chars: 0 }),
    ]);
    expect(metricLinesWith("BedrockCalls")).toEqual([expect.objectContaining({ Outcome: "refusal" })]);
    const [refusal] = metricLinesWith("BedrockRefusal");
    expect(refusal).toMatchObject({
      BedrockRefusal: 1,
      caller: "BillSummarizer",
      modelId: HAIKU_55_PROFILE_ARN,
      category: "frontier_llm",
    });
    expect(refusal._aws!.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  });

  it("returns max_tokens without retrying and warns", async () => {
    send.mockResolvedValueOnce(
      bedrockResponse({ content: [{ type: "thinking", thinking: "", signature: "s" }], stop_reason: "max_tokens" }),
    );

    const result = await invoke();

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "max_tokens", text: "" });
    expect(callLines()).toEqual([expect.objectContaining({ level: "WARN", outcome: "max_tokens", text_chars: 0 })]);
  });

  it("retries a throttle with backoff and returns the answer", async () => {
    send
      .mockRejectedValueOnce(bedrockError("ThrottlingException", 429, "Rate exceeded"))
      .mockResolvedValueOnce(bedrockResponse());

    const result = await invoke();

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.attempt).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(callLines()).toEqual([
      expect.objectContaining({
        level: "WARN",
        attempt: 0,
        outcome: "throttled",
        errorName: "ThrottlingException",
        httpStatus: 429,
        errorMessage: "Rate exceeded",
        retryInMs: sleep.mock.calls[0][0],
      }),
      expect.objectContaining({ level: "INFO", attempt: 1, outcome: "ok" }),
    ]);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toEqual({ abortSignal: deadlines[1].signal });
  });

  it("retries a throttle up to maxThrottleRetries times, then gives up", async () => {
    send.mockRejectedValue(bedrockError("ThrottlingException", 429));

    const error = await rejection(invoke({ maxThrottleRetries: 4, baseDelayMs: 1_000, maxDelayMs: 15_000 }));

    expect(send).toHaveBeenCalledTimes(5);
    expect(error).toMatchObject({ kind: "throttled", errorName: "ThrottlingException", httpStatus: 429, attempt: 4 });
    expect(error.cause).toBeInstanceOf(Error);
    const delays = sleep.mock.calls.map(([ms]) => ms);
    expect(delays).toHaveLength(4);
    delays.forEach((ms, retry) => {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(Math.min(15_000, 1_000 * 2 ** retry));
    });
    const lines = callLines();
    expect(lines.map((line) => [line.level, line.outcome, line.attempt])).toEqual([
      ["WARN", "throttled", 0],
      ["WARN", "throttled", 1],
      ["WARN", "throttled", 2],
      ["WARN", "throttled", 3],
      ["ERROR", "throttled", 4],
    ]);
    expect(lines[4]).not.toHaveProperty("retryInMs");
    expect(metricLinesWith("BedrockThrottled")).toHaveLength(5);
    expect(metricLinesWith("BedrockThrottled")[0]._aws!.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(metricLinesWith("BedrockCalls").map((line) => line.Outcome)).toEqual(Array(5).fill("throttled"));
  });

  it.each([
    ["ModelErrorException", 424],
    ["InternalServerException", 500],
    ["ServiceUnavailableException", 503],
    ["ModelNotReadyException", 429],
  ])("retries %s (HTTP %p) twice, then gives up", async (name, status) => {
    send.mockRejectedValue(bedrockError(name, status));

    const error = await rejection(invoke({ maxTransientRetries: 2 }));

    expect(send).toHaveBeenCalledTimes(3);
    expect(error).toMatchObject({ kind: "transient", errorName: name, httpStatus: status, attempt: 2 });
    expect(callLines().map((line) => line.outcome)).toEqual(["transient", "transient", "transient"]);
    expect(metricLinesWith("BedrockThrottled")).toEqual([]);
  });

  it("retries a dropped connection", async () => {
    send
      .mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { name: "TimeoutError", code: "ECONNRESET" }))
      .mockResolvedValueOnce(bedrockResponse());

    const result = await invoke();

    expect(result.attempt).toBe(1);
    expect(callLines()[0]).toMatchObject({ outcome: "transient", errorName: "TimeoutError" });
  });

  it("retries a refused HTTP/2 stream", async () => {
    send
      .mockRejectedValueOnce(
        Object.assign(new Error("Stream closed with error code NGHTTP2_REFUSED_STREAM"), {
          code: "ERR_HTTP2_STREAM_ERROR",
        }),
      )
      .mockResolvedValueOnce(bedrockResponse());

    const result = await invoke();

    expect(result.attempt).toBe(1);
    expect(callLines()[0]).toMatchObject({ level: "WARN", outcome: "transient", errorName: "ERR_HTTP2_STREAM_ERROR" });
  });

  it("retries a ModelTimeoutException once", async () => {
    send.mockRejectedValue(bedrockError("ModelTimeoutException", 408));

    const error = await rejection(invoke());

    expect(send).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ kind: "timeout", errorName: "ModelTimeoutException", httpStatus: 408, attempt: 1 });
  });

  it("gives up on the first ModelTimeoutException and network error when their retries are off", async () => {
    send.mockRejectedValueOnce(bedrockError("ModelTimeoutException", 408));
    const timedOut = await rejection(invoke({ maxModelTimeoutRetries: 0 }));

    send.mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    const dropped = await rejection(invoke({ maxTransientRetries: 0 }));

    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(timedOut).toMatchObject({ kind: "timeout", errorName: "ModelTimeoutException", attempt: 0 });
    expect(dropped).toMatchObject({ kind: "transient", errorName: "ECONNRESET", attempt: 0 });
  });

  it.each([
    ["ValidationException", 400, "invalid_request"],
    ["AccessDeniedException", 403, "access_denied"],
    ["ResourceNotFoundException", 404, "not_found"],
  ])("never retries %s and counts it as BedrockRequestRejected", async (name, status, kind) => {
    send.mockRejectedValue(bedrockError(name, status, "temperature: not supported for this model"));

    const error = await rejection(invoke());

    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error).toMatchObject({ kind, errorName: name, httpStatus: status, attempt: 0 });
    expect(error.message).toContain("temperature: not supported for this model");
    expect(callLines()).toEqual([
      expect.objectContaining({
        level: "ERROR",
        outcome: kind,
        errorName: name,
        httpStatus: status,
        errorMessage: "temperature: not supported for this model",
      }),
    ]);
    const [rejected] = metricLinesWith("BedrockRequestRejected");
    expect(rejected).toMatchObject({
      BedrockRequestRejected: 1,
      caller: "BillSummarizer",
      modelId: HAIKU_55_PROFILE_ARN,
      outcome: kind,
      errorName: name,
      httpStatus: status,
    });
    expect(rejected._aws!.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(metricLinesWith("BedrockCalls")).toEqual([expect.objectContaining({ Outcome: kind })]);
  });

  it("never retries an attempt its own deadline stopped", async () => {
    send.mockImplementationOnce(async () => {
      deadlines[0].abort();
      // Whatever the SDK says, the deadline fired: a timeout.
      throw bedrockError("InternalServerException", 500);
    });

    const error = await rejection(invoke({ remainingMs: () => 100_000 }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ kind: "timeout", errorName: "InternalServerException", attempt: 0 });
    expect(callLines()).toEqual([expect.objectContaining({ level: "ERROR", outcome: "timeout", timeoutMs: 60_000 })]);
    expect(metricLinesWith("BedrockCalls")).toEqual([expect.objectContaining({ Outcome: "timeout" })]);
  });

  it("never retries an AbortError, the only abort being its deadline", async () => {
    send.mockRejectedValue(sdkAbortError());

    const error = await rejection(invoke());

    expect(send).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ kind: "timeout", errorName: "AbortError", attempt: 0 });
  });

  it("aborts a call through the real AbortSignal deadline", async () => {
    timeoutSpy.mockRestore();
    send.mockImplementationOnce(
      (_command: unknown, { abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(sdkAbortError()));
        }),
    );

    const error = await rejection(invoke({ callTimeoutMs: 20, minRemainingMs: 0 }));

    expect(error).toMatchObject({ kind: "timeout", errorName: "AbortError", attempt: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the backoff would leave less than the minimum time", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    send.mockRejectedValue(bedrockError("ThrottlingException", 429));

    // The first backoff is 500 ms, which would leave 19,900 ms.
    const error = await rejection(invoke({ remainingMs: () => 20_400, baseDelayMs: 1_000 }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error.kind).toBe("throttled");
    expect(callLines()).toEqual([expect.objectContaining({ level: "ERROR", outcome: "throttled" })]);
    expect(callLines()[0]).not.toHaveProperty("retryInMs");
  });

  it("stops retrying once the time left drops below the minimum", async () => {
    let remaining = 60_000;
    send.mockImplementation(async () => {
      remaining -= 25_000;
      throw bedrockError("ThrottlingException", 429);
    });

    const error = await rejection(invoke({ remainingMs: () => remaining, baseDelayMs: 1, maxDelayMs: 1 }));

    // 35,000 ms left after the first attempt, 10,000 ms after the second: no third.
    expect(send).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ kind: "throttled", attempt: 1 });
  });

  it("does not retry an answer it cannot parse", async () => {
    send.mockResolvedValueOnce({ body: new TextEncoder().encode("<html>Bad gateway</html>") });

    const error = await rejection(invoke());

    expect(send).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ kind: "error", errorName: "SyntaxError" });
  });

  it("rejects a call timeout that is not a positive number", async () => {
    await expect(invoke({ callTimeoutMs: Number.NaN })).rejects.toThrow(RangeError);
    await expect(invoke({ callTimeoutMs: 0 })).rejects.toThrow(RangeError);
    expect(send).not.toHaveBeenCalled();
  });
});
