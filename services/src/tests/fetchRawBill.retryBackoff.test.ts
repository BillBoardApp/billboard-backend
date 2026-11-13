import { EventEmitter } from "events";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { FakeVersionedS3 } from "./fakeVersionedS3";
import { applyTestEnv } from "./fixtures/env";
import { logLines, type LogLine } from "./logLines";

export {};

// REL-58: FetchRawBill's retry ladder (FETCH_RETRY_BACKOFF), through the real handler.

// Most tests reload the handler (jest.resetModules, then require), since it reads its settings when it loads. Under CI's
// --coverage a reload takes seconds: the deploy build of 2026-11-12 ran this suite in 255 s (about 4.8 s a test) and a
// test passed jest's default 5 s. 30 s leaves room; a test that hangs still fails.
jest.setTimeout(30_000);

const originalEnv = { ...process.env };
const QUEUE_ARN = "arn:aws:sqs:us-east-1:123456789012:UpdatedBillsQueue";
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/UpdatedBillsQueue";
const DIFFER_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/BillDifferQueue";
const RAW_KEY = "raw-bills/BILLS-119hr77.json";
const LADDER = [180, 300, 600, 1200, 1800, 3600, 3600, 3600, 3600, 3600];
const POLLER_ID = "2026-11-10T17:28:39.657Z:BILLS-119hr77";
const LISTED_AT = Date.parse("2026-11-10T17:28:39.657Z");

const mockS3Send = jest.fn();
const mockSecretsManagerSend = jest.fn();
const mockCloudWatchSend = jest.fn();
const mockSqsSend = jest.fn();

interface ResponseConfig {
  statusCode?: number;
  body?: string;
  /** Emit this network error instead of a response. */
  error?: Error;
  /** Never respond: fire the socket inactivity timeout instead. */
  stall?: boolean;
  /** Send headers and one chunk, then nothing: the inactivity timeout never fires, the body never ends. */
  trickle?: boolean;
}
const httpResponses: ResponseConfig[] = [];
const destroyedWith: Error[] = [];

interface FakeResponse extends EventEmitter {
  statusCode?: number;
  headers?: Record<string, string>;
}
interface FakeRequest extends EventEmitter {
  setTimeout?: jest.Mock;
  destroy?: jest.Mock;
  end?: jest.Mock;
}

const mockHttpsRequest = jest.fn((_url: unknown, _options?: unknown, callback?: (res: FakeResponse) => void) => {
  const config = httpResponses.shift() ?? { statusCode: 200, body: "{}" };
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = config.statusCode ?? 200;
  res.headers = {};
  const req = new EventEmitter() as FakeRequest;
  let onSocketTimeout: (() => void) | undefined;
  req.setTimeout = jest.fn((_ms: number, cb: () => void) => {
    onSocketTimeout = cb;
    return req;
  });
  req.destroy = jest.fn((error?: Error) => {
    if (error) {
      destroyedWith.push(error);
      req.emit("error", error);
    }
    return req;
  });
  req.end = jest.fn(() => {
    if (config.stall) {
      onSocketTimeout?.();
      return;
    }
    if (config.error) {
      req.emit("error", config.error);
      return;
    }
    callback?.(res);
    if (config.trickle) {
      res.emit("data", "{");
      return;
    }
    if (config.body !== undefined) res.emit("data", config.body);
    res.emit("end");
  });
  return req;
});

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __cmd: "GetObject", input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ __cmd: "PutObject", input })),
}));
jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsManagerSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCloudWatchSend })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ __sqs: "SendMessageBatch", input })),
  ChangeMessageVisibilityCommand: jest
    .fn()
    .mockImplementation((input) => ({ __sqs: "ChangeMessageVisibility", input })),
}));
jest.mock("https", () => ({
  request: (...args: Parameters<typeof mockHttpsRequest>) => mockHttpsRequest(...args),
}));

type Handler = (
  event: SQSEvent,
  context?: { awsRequestId?: string; getRemainingTimeInMillis?: () => number },
) => Promise<SQSBatchResponse>;

let fake: FakeVersionedS3;
let restoreEnv: (() => void) | undefined;

const RETRY_ENV = {
  FETCH_RETRY_LADDER_SECONDS: LADDER.join(","),
  FETCH_RETRY_OTHER_SECONDS: "60",
  FETCH_RETRY_NOT_FOUND_RECEIVES: "4",
  FETCH_RETRY_MAX_RECEIVES: "11",
};

/** The handler loaded with FETCH_RETRY_BACKOFF = mode (unset when undefined) and the ladder infra ships. */
const loadHandler = (mode: string | undefined, env: Record<string, string | undefined> = {}): Handler => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      BUCKET_NAME: "test-raw-bills-bucket",
      SECRET_NAME: "CongressAPIKey",
      QUEUE_URL: DIFFER_QUEUE,
      TEXT_RETRY_QUEUE_URL: QUEUE_URL,
      QUEUE_BATCH_SIZE: "10",
      CONGRESS_API_CALL_DELAY_MS: "0",
      CONGRESS_API_BASE_DELAY_MS: "0",
      CONGRESS_API_MAX_DELAY_MS: "0",
      MEMBER_VOTE_CARRY_MODE: "on",
      FETCH_RETRY_BACKOFF: mode,
      ...RETRY_ENV,
      ...env,
    },
    { replace: true, base: originalEnv },
  );
  jest.resetModules();
  return require("../handlers/fetchRawBill").handler as Handler;
};

beforeEach(() => {
  mockS3Send.mockReset();
  mockSecretsManagerSend.mockReset();
  mockCloudWatchSend.mockReset();
  mockSqsSend.mockReset();
  mockHttpsRequest.mockClear();
  httpResponses.length = 0;
  destroyedWith.length = 0;
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  jest.spyOn(Math, "random").mockReturnValue(0);
  fake = new FakeVersionedS3("2026-11-10T17:00:00.000Z");
  mockS3Send.mockImplementation((cmd) => fake.send(cmd));
  mockSecretsManagerSend.mockResolvedValue({ SecretString: JSON.stringify({ congressApiKey: "test-api-key-123" }) });
  mockCloudWatchSend.mockResolvedValue({});
  mockSqsSend.mockResolvedValue({});
});

afterEach(() => {
  jest.useRealTimers();
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

interface MessageOptions {
  receiveCount?: number;
  correlationId?: string | null;
  body?: Record<string, unknown> | string;
  sentAt?: number;
  firstReceiveAt?: number;
}

const BODY = {
  guid: "BILLS-119hr77",
  title: "H.R. 77: Message title",
  description: "Message action",
  pubDate: "2026-11-10T00:00:00.000Z",
  congress: "119",
  billType: "hr",
  billNumber: "77",
};

const record = (options: MessageOptions = {}): SQSRecord => {
  const correlationId = options.correlationId === undefined ? POLLER_ID : options.correlationId;
  return {
    messageId: "msg-0",
    receiptHandle: "receipt-0",
    body: typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? BODY),
    attributes: {
      ApproximateReceiveCount: String(options.receiveCount ?? 1),
      SentTimestamp: String(options.sentAt ?? LISTED_AT + 1_000),
      SenderId: "poller",
      ApproximateFirstReceiveTimestamp: String(options.firstReceiveAt ?? Date.now() - 600_000),
    },
    messageAttributes: correlationId ? { correlationId: { stringValue: correlationId, dataType: "String" } } : {},
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: QUEUE_ARN,
    awsRegion: "us-east-1",
  } as SQSRecord;
};

const event = (options: MessageOptions = {}): SQSEvent => ({ Records: [record(options)] });

/** The 8 endpoints of a bill that fetch fine (no text versions, so no XML request). */
const pushBill = (
  bill: Record<string, unknown> = { number: "77", type: "HR", congress: 119, title: "Detail title" },
) => {
  httpResponses.push({ statusCode: 200, body: JSON.stringify({ bill }) });
  for (const body of [
    { actions: [] },
    { subjects: [] },
    { titles: [] },
    { cosponsors: [] },
    { committees: [] },
    { relatedBills: [] },
    { textVersions: [] },
  ]) {
    httpResponses.push({ statusCode: 200, body: JSON.stringify(body) });
  }
};
const timeouts = (n: number) => httpResponses.push(...Array.from({ length: n }, () => ({ stall: true })));
const statuses = (status: number, n: number) =>
  httpResponses.push(...Array.from({ length: n }, () => ({ statusCode: status, body: "" })));

const sqsCommands = (kind: string) =>
  mockSqsSend.mock.calls.filter(([cmd]) => cmd?.__sqs === kind).map(([cmd]) => cmd.input);
const visibilityCalls = () => sqsCommands("ChangeMessageVisibility");
const metricDatums = (name: string): Array<Record<string, unknown>> =>
  mockCloudWatchSend.mock.calls.flatMap(([cmd]) =>
    (cmd?.input?.MetricData ?? []).filter((datum: { MetricName?: string }) => datum.MetricName === name),
  );
const allLines = (): LogLine[] => [...logLines(console.log), ...logLines(console.warn), ...logLines(console.error)];
const retryLine = (): LogLine | undefined =>
  allLines().find((line) => line.message === "Failed record will be retried");
const storedMetadata = () => fake.json<{ metadata: Record<string, unknown> }>(RAW_KEY)?.metadata;

describe("FETCH_RETRY_BACKOFF off: today's behaviour", () => {
  it.each([undefined, "off", "watch", "ON please"])(
    "%p: a timed-out record fails and comes back after the queue's 180 s (no visibility change, no new metric or line)",
    async (mode) => {
      const handler = loadHandler(mode);
      timeouts(3);

      const result = await handler(event({ receiveCount: 2 }), { getRemainingTimeInMillis: () => 60_000 });

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
      expect(mockHttpsRequest).toHaveBeenCalledTimes(3);
      expect(visibilityCalls()).toEqual([]);
      expect(metricDatums("FetchRawBillRecordFailed")).toEqual([]);
      expect(metricDatums("FetchRawBillFailingSeconds")).toEqual([]);
      expect(retryLine()).toBeUndefined();
      expect(allLines().find((line) => line.message === "Failed to process record msg-0")).toBeDefined();
    },
  );

  it("off: no deadline guard, a request still starts with little Lambda time left", async () => {
    const handler = loadHandler("off");
    pushBill();

    const result = await handler(event(), { getRemainingTimeInMillis: () => 5_000 });

    expect(result.batchItemFailures).toEqual([]);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(8);
  });

  it("off: a message overtaken by a later listing stores its own title, as before", async () => {
    fake.put(RAW_KEY, storedBill("2026-11-11T09:08:54.000Z"), {
      "correlation-id": "2026-11-11T09:08:39.684Z:BILLS-119hr77",
    });
    const handler = loadHandler("off");
    pushBill();

    await handler(event());

    expect(storedMetadata()).toMatchObject({ title: BODY.title, description: BODY.description });
    expect(storedMetadata()).not.toHaveProperty("listedAt");
  });

  it("an invalid ladder under on changes nothing either, and says so once at load", async () => {
    const handler = loadHandler("on", { FETCH_RETRY_LADDER_SECONDS: "180,soon" });
    timeouts(3);

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(visibilityCalls()).toEqual([]);
    expect(
      logLines(console.error).filter((line) => /FETCH_RETRY_BACKOFF is on but/.test(String(line.message))),
    ).toHaveLength(1);
  });
});

describe("FETCH_RETRY_BACKOFF on: the ladder", () => {
  it.each(LADDER.map((seconds, index) => [index + 1, seconds]))(
    "a congress.gov timeout on receive %p comes back after %p s",
    async (receiveCount, seconds) => {
      const handler = loadHandler("on");
      timeouts(3);

      const result = await handler(event({ receiveCount }));

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
      expect(visibilityCalls()).toEqual([
        { QueueUrl: QUEUE_URL, ReceiptHandle: "receipt-0", VisibilityTimeout: seconds },
      ]);
      expect(retryLine()).toMatchObject({
        level: "WARN",
        sqsMessageId: "msg-0",
        guid: "BILLS-119hr77",
        correlationId: POLLER_ID,
        failureKind: "unavailable",
        failedEndpoint: "bill",
        receiveCount,
        maxReceives: 11,
        retryInSeconds: seconds,
        retryStep: "ladder",
        final: false,
        bulk: false,
        visibilitySet: true,
      });
    },
  );

  it("counts the failure by kind, and how long the record has been failing", async () => {
    const handler = loadHandler("on");
    timeouts(3);

    await handler(event({ receiveCount: 5, firstReceiveAt: Date.now() - 2_400_000 }));

    expect(metricDatums("FetchRawBillRecordFailed")).toEqual([
      { MetricName: "FetchRawBillRecordFailed", Unit: "Count", Value: 1 },
      {
        MetricName: "FetchRawBillRecordFailed",
        Dimensions: [{ Name: "Kind", Value: "unavailable" }],
        Unit: "Count",
        Value: 1,
      },
    ]);
    const [failing] = metricDatums("FetchRawBillFailingSeconds");
    expect(failing).toMatchObject({ MetricName: "FetchRawBillFailingSeconds", Unit: "Seconds" });
    expect(Number(failing.Value)).toBeGreaterThanOrEqual(2_400);
    expect(Number(failing.Value)).toBeLessThan(2_460);
  });

  it.each<[string, () => void, string, number | null, number]>([
    ["503 on every try", () => statuses(503, 3), "unavailable", 503, 600],
    ["Cloudflare 520 on every try", () => statuses(520, 3), "unavailable", 520, 600],
    [
      "a connection reset on every try",
      () =>
        httpResponses.push(
          ...Array(3).fill({ error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }),
        ),
      "unavailable",
      null,
      600,
    ],
    ["429 on every try", () => statuses(429, 3), "throttled", 429, 600],
    ["404 on the bill endpoint", () => statuses(404, 1), "not_found", 404, 600],
    ["501 on every try", () => statuses(501, 3), "other", null, 60],
    ["400", () => statuses(400, 1), "other", null, 60],
    ["401 after the key re-read", () => statuses(401, 2), "other", null, 60],
  ])("%s on receive 3: %s", async (_name, push, kind, status, seconds) => {
    const handler = loadHandler("on");
    push();

    await handler(event({ receiveCount: 3 }));

    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: seconds })]);
    expect(retryLine()).toMatchObject({ failureKind: kind, retryInSeconds: seconds });
    if (status !== null) expect(retryLine()).toMatchObject({ failureStatus: status });
    expect(metricDatums("FetchRawBillRecordFailed")).toContainEqual(
      expect.objectContaining({ Dimensions: [{ Name: "Kind", Value: kind }] }),
    );
  });

  it("caps a bill-endpoint 404 at 4 receives (about 38 minutes), then counts it as other", async () => {
    const handler = loadHandler("on");
    statuses(404, 1);

    await handler(event({ receiveCount: 5 }));

    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: 60 })]);
    expect(retryLine()).toMatchObject({ failureKind: "other", failureCause: "not_found", retryStep: "other" });
    expect(metricDatums("FetchRawBillRecordFailed")).toContainEqual(
      expect.objectContaining({ Dimensions: [{ Name: "Kind", Value: "other" }] }),
    );
  });

  it("takes a 404 on a sub-endpoint as other (60 s)", async () => {
    const handler = loadHandler("on");
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ bill: { number: "77" } }) });
    statuses(404, 1);

    await handler(event());

    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: 60 })]);
    expect(retryLine()).toMatchObject({ failureKind: "other", failedEndpoint: "actions" });
  });

  it("gives the final receive 60 s, never 0, and says it is final", async () => {
    const handler = loadHandler("on");
    timeouts(3);

    await handler(event({ receiveCount: 11 }));

    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: 60 })]);
    expect(retryLine()).toMatchObject({ failureKind: "unavailable", retryStep: "final", final: true });
  });

  it.each<[string, MessageOptions]>([
    [
      "noTextRetry (refetch:stale-bills)",
      { body: { ...BODY, noTextRetry: true }, correlationId: "refetch:2026-11-12T02:15:00.000Z:BILLS-119hr77" },
    ],
    ["a rel56: id (the REL-56 backfill)", { correlationId: "rel56:2026-11-12T02:15:00.000Z:BILLS-119hr77" }],
    ["bulk (backfill:cosponsors)", { body: { ...BODY, bulk: true }, correlationId: null }],
  ])("keeps a bulk message at 60 s: %s", async (_name, options) => {
    const handler = loadHandler("on");
    timeouts(3);

    await handler(event({ ...options, receiveCount: 6 }));

    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: 60 })]);
    expect(retryLine()).toMatchObject({ failureKind: "unavailable", retryStep: "bulk", bulk: true });
  });

  it("retries an S3 refusal after 60 s", async () => {
    const handler = loadHandler("on");
    pushBill();
    fake.injectPutError(RAW_KEY, 403);

    await handler(event());

    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: 60 })]);
    expect(retryLine()).toMatchObject({ failureKind: "other" });
  });

  it("retries a body that is not JSON after 60 s", async () => {
    const handler = loadHandler("on");

    const result = await handler(event({ body: "not json" }));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: 60 })]);
    expect(retryLine()).toMatchObject({ failureKind: "other", bulk: false });
  });

  it("retries a stored record whose BillDiffer send failed after 60 s", async () => {
    const handler = loadHandler("on");
    pushBill();
    mockSqsSend.mockImplementation(async (cmd) =>
      cmd.__sqs === "SendMessageBatch" ? { Failed: [{ Id: "msg-0", Message: "throttled" }] } : {},
    );

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(fake.contentVersions(RAW_KEY)).toHaveLength(1);
    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: 60 })]);
    expect(retryLine()).toMatchObject({ failureKind: "other" });
  });

  it("logs a visibility it could not set and still returns the failure (the record comes back after 180 s)", async () => {
    const handler = loadHandler("on");
    timeouts(3);
    mockSqsSend.mockImplementation(async (cmd) => {
      if (cmd.__sqs === "ChangeMessageVisibility")
        throw Object.assign(new Error("Access denied"), { name: "AccessDenied" });
      return {};
    });

    const result = await handler(event({ receiveCount: 4 }));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Could not set the failed record's visibility") }),
    );
    expect(retryLine()).toMatchObject({ retryInSeconds: 1200, visibilitySet: false });
  });

  it("changes nothing for a record that succeeds", async () => {
    const handler = loadHandler("on");
    pushBill();

    const result = await handler(event({ receiveCount: 4 }));

    expect(result.batchItemFailures).toEqual([]);
    expect(visibilityCalls()).toEqual([]);
    expect(metricDatums("FetchRawBillRecordFailed")).toEqual([]);
  });

  it("keeps a text retry's body as it is: SQS retries the same message, nothing is sent again", async () => {
    const handler = loadHandler("on");
    timeouts(3);

    await handler(event({ body: { ...BODY, textRetryAttempt: 2 }, receiveCount: 2 }));

    expect(sqsCommands("SendMessageBatch")).toEqual([]);
    expect(visibilityCalls()).toEqual([expect.objectContaining({ VisibilityTimeout: 300 })]);
  });

  it("leaves a failure of the whole invocation (the key read) to the queue's visibility", async () => {
    const handler = loadHandler("on");
    mockSecretsManagerSend.mockRejectedValue(new Error("Secrets Manager unavailable"));

    await expect(handler(event())).rejects.toThrow("Secrets Manager unavailable");
    expect(visibilityCalls()).toEqual([]);
  });
});

describe("FETCH_RETRY_BACKOFF on: the deadline guard", () => {
  it("starts no request it could not finish before the Lambda timeout: the record fails as unavailable", async () => {
    const handler = loadHandler("on");
    // The bill and actions endpoints answer; then less than a request timeout plus 15 s is left.
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ bill: { number: "77" } }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ actions: [] }) });
    // One read per request: the bill and actions start with 80 s left, subjects would with 24 s.
    const remaining = jest.fn().mockReturnValueOnce(80_000).mockReturnValueOnce(80_000).mockReturnValue(24_000);

    const result = await handler(event({ receiveCount: 2 }), { getRemainingTimeInMillis: remaining });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
    expect(retryLine()).toMatchObject({ failureKind: "unavailable", failedEndpoint: "subjects", retryInSeconds: 300 });
    expect(JSON.stringify(allLines())).toContain("no Lambda time left");
  });

  it("does not retry into the reserve: a stalled request with too little time left fails at once", async () => {
    const handler = loadHandler("on");
    timeouts(1);
    const remaining = jest.fn().mockReturnValueOnce(80_000).mockReturnValueOnce(80_000).mockReturnValue(20_000);

    await handler(event(), { getRemainingTimeInMillis: remaining });

    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    expect(retryLine()).toMatchObject({ failureKind: "unavailable", retryInSeconds: 180 });
  });

  it("keeps a throttled answer throttled when time runs out before its retry", async () => {
    const handler = loadHandler("on");
    statuses(429, 1);
    const remaining = jest.fn().mockReturnValueOnce(80_000).mockReturnValueOnce(80_000).mockReturnValue(20_000);

    await handler(event(), { getRemainingTimeInMillis: remaining });

    expect(retryLine()).toMatchObject({ failureKind: "throttled", failureStatus: 429 });
  });

  it("destroys a request that trickles past its deadline (15 s before the timeout), so none is in flight then", async () => {
    // A 1 ms request timeout makes the guard start a request with 15,001 ms left. It starts with 15,060 ms left, so
    // its deadline is 60 ms away. The socket never goes idle (the inactivity timeout never fires). The clock is fake
    // (setTimeout and Date only): on a busy CI runner a real 60 ms timer fired 3.2 s late.
    // The handler loads before the clock is faked: only the request runs on the fake clock.
    const handler = loadHandler("on", { CONGRESS_API_REQUEST_TIMEOUT_MS: "1" });
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "clearImmediate"] });
    try {
      httpResponses.push({ trickle: true });
      const start = Date.now();
      const remaining = () => 15_060 - (Date.now() - start);

      const pending = handler(event(), { getRemainingTimeInMillis: remaining });
      await jest.advanceTimersByTimeAsync(59);
      expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
      expect(destroyedWith).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
      expect(destroyedWith).toHaveLength(1);
      expect(destroyedWith[0]).toMatchObject({
        name: "TimeoutError",
        message: expect.stringContaining("passed its deadline of 60ms"),
      });
      expect(Date.now() - start).toBe(60);
      expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
      expect(retryLine()).toMatchObject({ failureKind: "unavailable" });
    } finally {
      jest.useRealTimers();
    }
  });
});

/** A stored copy of the bill, fetched at `fetchedAt`, with a later listing's title and description. */
const storedBill = (fetchedAt: string) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: fetchedAt,
  identifier: { congress: "119", billType: "hr", billNumber: "77" },
  metadata: {
    guid: "BILLS-119hr77",
    title: "H.R. 77: Newer title",
    pubDate: "2026-11-11T00:00:00.000Z",
    description: "Newer action",
    legislationUrl: "https://www.congress.gov/bill/119th-congress/house-bill/77",
    fetchedAt,
  },
  content: { bill: { bill: { number: "77", title: "Stored detail" } } },
});

describe("FETCH_RETRY_BACKOFF on: a message overtaken by a later listing", () => {
  it("keeps the stored title, description and pubDate, and stores this fetch's content", async () => {
    fake.put(RAW_KEY, storedBill("2026-11-11T09:08:54.000Z"), {
      "correlation-id": "2026-11-11T09:08:39.684Z:BILLS-119hr77",
    });
    const handler = loadHandler("on");
    pushBill({ number: "77", type: "HR", congress: 119, title: "Fresh detail" });

    const result = await handler(event({ receiveCount: 7 }));

    expect(result.batchItemFailures).toEqual([]);
    expect(storedMetadata()).toMatchObject({
      title: "H.R. 77: Newer title",
      description: "Newer action",
      pubDate: "2026-11-11T00:00:00.000Z",
    });
    expect(fake.json<{ content: { bill: { bill: { title: string } } } }>(RAW_KEY)?.content.bill.bill.title).toBe(
      "Fresh detail",
    );
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Kept the stored title and description: a later listing was stored after this message's",
        keptFields: ["title", "description", "pubDate"],
        storedCorrelationId: "2026-11-11T09:08:39.684Z:BILLS-119hr77",
      }),
    );
  });

  it("dates a message by its correlation id, which a redrive keeps, not by its new SentTimestamp", async () => {
    fake.put(RAW_KEY, storedBill("2026-11-11T09:08:54.000Z"), {
      "correlation-id": "2026-11-11T09:08:39.684Z:BILLS-119hr77",
    });
    const handler = loadHandler("on");
    pushBill();

    await handler(event({ sentAt: Date.parse("2026-11-12T00:23:00.000Z") }));

    expect(storedMetadata()).toMatchObject({ title: "H.R. 77: Newer title" });
  });

  it("stores its own title when the stored copy was fetched before this message was listed", async () => {
    fake.put(RAW_KEY, storedBill("2026-11-10T14:30:15.000Z"), {
      "correlation-id": "2026-11-10T14:18:39.000Z:BILLS-119hr77",
    });
    const handler = loadHandler("on");
    pushBill();

    await handler(event());

    expect(storedMetadata()).toMatchObject({ title: BODY.title, description: BODY.description, pubDate: BODY.pubDate });
  });

  it("stores its own title when the stored copy came from an older listing retried later", async () => {
    fake.put(RAW_KEY, storedBill("2026-11-10T18:00:00.000Z"), {
      "correlation-id": "2026-11-10T16:13:39.000Z:BILLS-119hr77",
    });
    const handler = loadHandler("on");
    pushBill();

    await handler(event());

    expect(storedMetadata()).toMatchObject({ title: BODY.title });
  });

  it("records when the stored title was listed (metadata.listedAt) and keeps the message's correlation id", async () => {
    const handler = loadHandler("on");
    pushBill();

    await handler(event());

    expect(storedMetadata()).toMatchObject({ title: BODY.title, listedAt: "2026-11-10T17:28:39.657Z" });
    expect(fake.current(RAW_KEY)?.metadata).toEqual({ "correlation-id": POLLER_ID });
  });

  /** One message for the bill through the handler: its title, description and pubDate are `title`'s. */
  const deliver = async (
    handler: Handler,
    title: string,
    correlationId: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    pushBill();
    const body = { ...BODY, title, description: `${title} action`, pubDate: `pub ${title}`, ...extra };
    const result = await handler(event({ correlationId, body, receiveCount: 5 }));
    expect(result.batchItemFailures).toEqual([]);
  };
  const listing = () => {
    const metadata = storedMetadata() ?? {};
    return {
      title: metadata.title,
      description: metadata.description,
      pubDate: metadata.pubDate,
      listedAt: metadata.listedAt,
    };
  };
  const copyOf = (title: string, fetchedAt: string) => ({
    ...storedBill(fetchedAt),
    metadata: { ...storedBill(fetchedAt).metadata, title, description: `${title} action`, pubDate: `pub ${title}` },
  });

  it("keeps the newest listing whatever order three listings come back in (C, then A, then B)", async () => {
    // T1 < T2 < T3 with titles A, B, C; A and B rode the ladder past C. Each store carries its own message's id.
    const handler = loadHandler("on");
    await deliver(handler, "C", "2026-11-10T15:00:00.000Z:BILLS-119hr77");
    await deliver(handler, "A", "2026-11-10T13:00:00.000Z:BILLS-119hr77");
    expect(fake.current(RAW_KEY)?.metadata).toEqual({ "correlation-id": "2026-11-10T13:00:00.000Z:BILLS-119hr77" });
    await deliver(handler, "B", "2026-11-10T14:00:00.000Z:BILLS-119hr77");

    expect(listing()).toEqual({
      title: "C",
      description: "C action",
      pubDate: "pub C",
      listedAt: "2026-11-10T15:00:00.000Z",
    });
  });

  it("stores a poller listing that waited on the ladder while refetch:stale-bills sent the older stored copy back", async () => {
    fake.put(RAW_KEY, copyOf("OLD", "2026-05-01T00:01:00.000Z"), {
      "correlation-id": "2026-05-01T00:00:00.000Z:BILLS-119hr77",
    });
    const handler = loadHandler("on");
    await deliver(handler, "OLD", "refetch:2026-11-10T20:00:00.000Z:BILLS-119hr77", { noTextRetry: true });
    expect(listing()).toMatchObject({ title: "OLD", listedAt: "2026-05-01T00:00:00.000Z" });

    await deliver(handler, "NEW", "2026-11-10T19:00:00.000Z:BILLS-119hr77");

    expect(listing()).toEqual({
      title: "NEW",
      description: "NEW action",
      pubDate: "pub NEW",
      listedAt: "2026-11-10T19:00:00.000Z",
    });
  });

  it("stores a poller listing that waited on the ladder while backfill:cosponsors sent the stored copy back", async () => {
    fake.put(RAW_KEY, copyOf("OLD", "2026-05-01T00:01:00.000Z"), {
      "correlation-id": "2026-05-01T00:00:00.000Z:BILLS-119hr77",
    });
    const handler = loadHandler("on");
    // No correlation id: FetchRawBill mints one at its fetch time, which dates nothing.
    await deliver(handler, "OLD", null, { bulk: true });
    expect(listing()).toMatchObject({ title: "OLD", listedAt: "2026-05-01T00:00:00.000Z" });

    await deliver(handler, "NEW", "2026-11-10T19:00:00.000Z:BILLS-119hr77");

    expect(listing()).toMatchObject({ title: "NEW", listedAt: "2026-11-10T19:00:00.000Z" });
  });

  it("gives a refetch's message the stored title when a later listing was stored after the run read the copy", async () => {
    fake.put(RAW_KEY, copyOf("Newer", "2026-11-10T19:31:00.000Z"), {
      "correlation-id": "2026-11-10T19:30:00.000Z:BILLS-119hr77",
    });
    const handler = loadHandler("on");

    await deliver(handler, "Older", "refetch:2026-11-10T20:00:00.000Z:BILLS-119hr77", { noTextRetry: true });

    expect(listing()).toEqual({
      title: "Newer",
      description: "Newer action",
      pubDate: "pub Newer",
      listedAt: "2026-11-10T19:30:00.000Z",
    });
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ event: "listing_overtaken", messageListing: "stored_copy" }),
    );
  });

  it("dates a REL-56 message by the snapshot's listedAt, not its run start", async () => {
    fake.put(RAW_KEY, copyOf("Stored", "2026-11-01T00:00:00.000Z"), {
      "correlation-id": "2026-10-31T23:59:00.000Z:BILLS-119hr77",
    });
    const handler = loadHandler("on");
    await deliver(handler, "Snapshot", "rel56:2026-11-10T20:00:00.000Z:BILLS-119hr77", {
      noTextRetry: true,
      listedAt: "2026-11-10T12:00:00.000Z",
    });
    expect(listing()).toMatchObject({ title: "Snapshot", listedAt: "2026-11-10T12:00:00.000Z" });

    // Listed before the snapshot: the snapshot's title stays.
    await deliver(handler, "Before", "2026-11-10T11:00:00.000Z:BILLS-119hr77");
    expect(listing()).toMatchObject({ title: "Snapshot", listedAt: "2026-11-10T12:00:00.000Z" });

    // Listed after the snapshot but before the run started: stored.
    await deliver(handler, "After", "2026-11-10T19:00:00.000Z:BILLS-119hr77");
    expect(listing()).toMatchObject({ title: "After", listedAt: "2026-11-10T19:00:00.000Z" });
  });
});
