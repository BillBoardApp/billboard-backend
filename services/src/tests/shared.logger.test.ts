import { Logger, REDACTED, serializeError } from "../shared/logger";
import {
  correlationIdFromMetadata,
  correlationIdFromRecord,
  correlationIdMessageAttributes,
  correlationIdMetadata,
  isRel56BackfillCorrelationId,
  mintCorrelationId,
  normalizeCorrelationId,
  REL56_BACKFILL_CORRELATION_PREFIX,
} from "../shared/correlation";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

const originalEnv = { ...process.env };

describe("shared/logger", () => {
  let restoreEnv: (() => void) | undefined;
  let debugSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let logger: Logger;

  beforeEach(() => {
    restoreEnv = applyTestEnv({ AWS_LAMBDA_FUNCTION_NAME: "FetchRawBill" }, { replace: true, base: originalEnv });
    delete process.env.LOG_LEVEL;
    debugSpy = jest.spyOn(console, "debug").mockImplementation();
    logSpy = jest.spyOn(console, "log").mockImplementation();
    warnSpy = jest.spyOn(console, "warn").mockImplementation();
    errorSpy = jest.spyOn(console, "error").mockImplementation();
    logger = new Logger();
  });

  afterEach(() => {
    restoreEnv?.();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv as NodeJS.ProcessEnv;
  });

  it("writes one JSON line with timestamp, level, message, service, fn and awsRequestId", () => {
    logger.resetContext({ awsRequestId: "req-1" });

    logger.info("Processing bill", { attempt: 2 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = logSpy.mock.calls[0];
    expect(typeof line).toBe("string");
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
      level: "INFO",
      message: "Processing bill",
      service: "billboard-services",
      fn: "FetchRawBill",
      awsRequestId: "req-1",
      attempt: 2,
    });
    expect(Object.keys(parsed).slice(0, 3)).toEqual(["timestamp", "level", "message"]);
  });

  it("routes each level to its console method and honours LOG_LEVEL", () => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logLines(logSpy)).toEqual([expect.objectContaining({ level: "INFO", message: "i" })]);
    expect(logLines(warnSpy)).toEqual([expect.objectContaining({ level: "WARN", message: "w" })]);
    expect(logLines(errorSpy)).toEqual([expect.objectContaining({ level: "ERROR", message: "e" })]);

    process.env.LOG_LEVEL = "debug";
    logger.debug("d2");
    expect(logLines(debugSpy)).toEqual([expect.objectContaining({ level: "DEBUG", message: "d2" })]);

    process.env.LOG_LEVEL = "WARN";
    logger.info("hidden");
    logger.warn("shown");
    expect(logLines(logSpy).map((line) => line.message)).toEqual(["i"]);
    expect(logLines(warnSpy).map((line) => line.message)).toEqual(["w", "shown"]);
  });

  it("serializes errors anywhere in the data with name, message and stack", () => {
    const cause = new Error("socket hang up");
    const sdkError = Object.assign(new Error("Rate exceeded", { cause }), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
      Code: "Throttling",
    });

    logger.error("Failed to enqueue", { error: sdkError, nested: { failures: [new TypeError("bad")] } });
    logger.error("Bare error", new RangeError("out of range"));

    const [first, second] = logLines(errorSpy);
    expect(first.error).toEqual({
      name: "ThrottlingException",
      message: "Rate exceeded",
      stack: expect.stringContaining("Rate exceeded"),
      code: "Throttling",
      statusCode: 429,
      cause: { name: "Error", message: "socket hang up", stack: expect.any(String) },
    });
    expect((first.nested as { failures: unknown[] }).failures[0]).toEqual({
      name: "TypeError",
      message: "bad",
      stack: expect.any(String),
    });
    expect(second.error).toEqual(expect.objectContaining({ name: "RangeError", message: "out of range" }));
    expect(serializeError("plain")).toEqual({ message: "plain" });
  });

  it("keeps the rest of the line when reading an error's stack throws", () => {
    const error = new Error("send failed");
    Object.defineProperty(error, "stack", {
      get() {
        throw new RangeError("Maximum call stack size exceeded");
      },
    });

    logger.error("Failed to process notificationType message", { messageId: "msg-0", error });

    const [line] = logLines(errorSpy);
    expect(line.messageId).toBe("msg-0");
    expect(line.error).toEqual({ name: "Error", message: "send failed" });
    expect(line.logError).toBeUndefined();
  });

  it("redacts tokens, emails, addresses, secrets and request bodies at any depth", () => {
    logger.info("Registered device", {
      userId: "sub-123",
      push_token: "abcdef",
      device: { deviceToken: "xyz", platform: "ios" },
      email: "someone@example.com",
      Address: "1 Main St",
      authorization: "Bearer t",
      body: '{"email":"x"}',
      apiKey: "k",
      input_tokens: 1500,
    });

    const [line] = logLines(logSpy);
    expect(line).toMatchObject({
      userId: "sub-123",
      push_token: REDACTED,
      device: { deviceToken: REDACTED, platform: "ios" },
      email: REDACTED,
      Address: REDACTED,
      authorization: REDACTED,
      body: REDACTED,
      apiKey: REDACTED,
      input_tokens: 1500,
    });
    expect(JSON.stringify(logSpy.mock.calls)).not.toMatch(/someone@example\.com|abcdef|1 Main St|Bearer/);
  });

  it("keeps the fields it owns when data uses the same names", () => {
    logger.resetContext({ awsRequestId: "req-1" });

    logger.info("real", {
      message: "fake",
      level: "fake",
      fn: "fake",
      service: "fake",
      awsRequestId: "fake",
      timestamp: "fake",
    });

    expect(logLines(logSpy)[0]).toEqual(
      expect.objectContaining({
        message: "real",
        level: "INFO",
        fn: "FetchRawBill",
        service: "billboard-services",
        awsRequestId: "req-1",
      }),
    );
  });

  it("survives circular data and bigints", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    logger.warn("Circular", { circular, big: BigInt(42) });

    expect(logLines(warnSpy)[0]).toEqual(
      expect.objectContaining({ circular: { name: "loop", self: "[Circular]" }, big: "42" }),
    );
  });

  it("appendKeys adds keys to every later line; resetContext drops them for the next invocation", () => {
    logger.resetContext({ awsRequestId: "req-1" });
    logger.appendKeys({ correlationId: "c-1", guid: "BILLS-119hr1", userId: undefined });
    logger.info("one");
    logger.removeKeys("guid");
    logger.info("two");
    logger.resetContext({ awsRequestId: "req-2" });
    logger.info("three");

    const [one, two, three] = logLines(logSpy);
    expect(one).toEqual(expect.objectContaining({ correlationId: "c-1", guid: "BILLS-119hr1", awsRequestId: "req-1" }));
    expect(one).not.toHaveProperty("userId");
    expect(two).toEqual(expect.objectContaining({ correlationId: "c-1" }));
    expect(two).not.toHaveProperty("guid");
    expect(three).toEqual(expect.objectContaining({ awsRequestId: "req-2" }));
    expect(three).not.toHaveProperty("correlationId");
  });

  it("withKeys scopes keys to async work, keeping concurrent records apart", async () => {
    logger.appendKeys({ correlationId: "run" });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

    await Promise.all(
      ["m1", "m2"].map((sqsMessageId, index) =>
        logger.withKeys({ sqsMessageId }, async () => {
          await tick();
          logger.appendKeys({ guid: `BILLS-119hr${index + 1}` });
          await tick();
          logger.info("record");
          await logger.withKeys({ correlationId: `bill-${index + 1}` }, async () => {
            await tick();
            logger.info("inner");
          });
          logger.info("after inner");
        }),
      ),
    );
    logger.info("outside");

    const byMessage = (message: string) =>
      logLines(logSpy)
        .filter((line) => line.message === message)
        .map(({ sqsMessageId, guid, correlationId }) => ({ sqsMessageId, guid, correlationId }));
    expect(byMessage("record")).toEqual([
      { sqsMessageId: "m1", guid: "BILLS-119hr1", correlationId: "run" },
      { sqsMessageId: "m2", guid: "BILLS-119hr2", correlationId: "run" },
    ]);
    expect(byMessage("inner")).toEqual([
      { sqsMessageId: "m1", guid: "BILLS-119hr1", correlationId: "bill-1" },
      { sqsMessageId: "m2", guid: "BILLS-119hr2", correlationId: "bill-2" },
    ]);
    expect(byMessage("after inner")).toEqual([
      { sqsMessageId: "m1", guid: "BILLS-119hr1", correlationId: "run" },
      { sqsMessageId: "m2", guid: "BILLS-119hr2", correlationId: "run" },
    ]);
    expect(byMessage("outside")).toEqual([{ sqsMessageId: undefined, guid: undefined, correlationId: "run" }]);
  });

  it("removeKeys inside a scope hides a key the invocation set", () => {
    logger.appendKeys({ correlationId: "run" });
    logger.withKeys({ guid: "BILLS-119hr1" }, () => {
      logger.removeKeys("correlationId");
      logger.info("scoped");
    });
    logger.info("after");

    const [scoped, after] = logLines(logSpy);
    expect(scoped).not.toHaveProperty("correlationId");
    expect(after.correlationId).toBe("run");
  });
});

describe("shared/correlation", () => {
  it("mints <time>:<guid>, or <time>:<uuid> without a usable guid", () => {
    const at = new Date("2026-03-02T10:00:00.000Z");
    expect(mintCorrelationId("BILLS-119hr1", at)).toBe("2026-03-02T10:00:00.000Z:BILLS-119hr1");
    expect(mintCorrelationId(undefined, at)).toMatch(/^2026-03-02T10:00:00\.000Z:[0-9a-f-]{36}$/);
    expect(mintCorrelationId("has space", at)).toMatch(/^2026-03-02T10:00:00\.000Z:[0-9a-f-]{36}$/);
    expect(mintCorrelationId("x".repeat(300), at)).toMatch(/^2026-03-02T10:00:00\.000Z:[0-9a-f-]{36}$/);
  });

  it("accepts only short printable ASCII ids", () => {
    expect(normalizeCorrelationId("  abc:1  ")).toBe("abc:1");
    expect(normalizeCorrelationId("")).toBeUndefined();
    expect(normalizeCorrelationId("a b")).toBeUndefined();
    expect(normalizeCorrelationId("naïve")).toBeUndefined();
    expect(normalizeCorrelationId("x".repeat(201))).toBeUndefined();
    expect(normalizeCorrelationId(42)).toBeUndefined();
  });

  it("round-trips through SQS message attributes and S3 metadata", () => {
    const id = "2026-03-02T10:00:00.000Z:BILLS-119hr1";
    expect(correlationIdMessageAttributes(id)).toEqual({
      MessageAttributes: { correlationId: { DataType: "String", StringValue: id } },
    });
    expect(correlationIdMessageAttributes(undefined)).toEqual({});
    expect(
      correlationIdFromRecord({ messageAttributes: { correlationId: { dataType: "String", stringValue: id } } }),
    ).toBe(id);
    expect(correlationIdFromRecord({ messageAttributes: {} })).toBeUndefined();
    expect(correlationIdFromRecord(undefined)).toBeUndefined();

    expect(correlationIdMetadata(id)).toEqual({ "correlation-id": id });
    expect(correlationIdMetadata(undefined)).toBeUndefined();
    expect(correlationIdFromMetadata({ "correlation-id": id })).toBe(id);
    expect(correlationIdFromMetadata(undefined)).toBeUndefined();
  });

  it("knows the REL-56 backfill's ids (refetch:stale-bills --snapshot-file) and no others", () => {
    expect(REL56_BACKFILL_CORRELATION_PREFIX).toBe("rel56:");
    expect(isRel56BackfillCorrelationId("rel56:2026-11-20T14:30:00.000Z:BILLS-119hr2743")).toBe(true);
    expect(isRel56BackfillCorrelationId("refetch:2026-11-20T14:30:00.000Z:BILLS-119hr2743")).toBe(false);
    expect(isRel56BackfillCorrelationId(mintCorrelationId("BILLS-119hr2743"))).toBe(false);
    expect(isRel56BackfillCorrelationId("REL56:2026-11-20T14:30:00.000Z:BILLS-119hr2743")).toBe(false);
    expect(isRel56BackfillCorrelationId("rel56: with spaces")).toBe(false);
    expect(isRel56BackfillCorrelationId(undefined)).toBe(false);
  });
});
