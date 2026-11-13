import { applyTestEnv } from "./fixtures/env";

const originalEnv = { ...process.env };

const mockS3Send = jest.fn();
const mockSecretsSend = jest.fn();
const mockSQSSend = jest.fn();
const mockCloudWatchSend = jest.fn();
const mockFetch = jest.fn();

// Mock global fetch
global.fetch = mockFetch as typeof fetch;

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCloudWatchSend })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

interface SendBatchCommand {
  input: { Entries: Array<{ MessageBody: string }> };
}

type HandlerReturn = Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
interface SqsEventLike {
  Records: Array<{ messageId?: string; body: string }>;
}
let handler: (event: SqsEventLike) => HandlerReturn;
let restoreEnv: (() => void) | undefined;

beforeEach(() => {
  mockS3Send.mockReset();
  mockSecretsSend.mockReset();
  mockSQSSend.mockReset();
  mockCloudWatchSend.mockReset();
  mockFetch.mockReset();

  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({ congressApiKey: "test-key" }),
  });

  mockS3Send.mockResolvedValue({});
  mockSQSSend.mockResolvedValue({});
  mockCloudWatchSend.mockResolvedValue({});

  loadHandler();
});

const loadHandler = (env: Record<string, string | undefined> = {}) => {
  jest.resetModules();
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      BUCKET_NAME: "test-bucket",
      SECRET_NAME: "test-secret",
      QUEUE_URL: "https://example.com/congress-member-summarizer-queue",
      QUEUE_BATCH_SIZE: "10",
      CONGRESS_API_BASE_URL: "https://api.congress.gov/v3",
      CONGRESS_API_CALL_DELAY_MS: "0",
      CONGRESS_API_BASE_DELAY_MS: "1",
      CONGRESS_API_MAX_DELAY_MS: "5",
      ...env,
    },
    { replace: true, base: originalEnv },
  );

  const mod = require("../handlers/fetchRawCongressMembers");
  handler = mod.handler;
};

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: new Headers(headers),
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

const memberResponse = (bioguideId: string) =>
  jsonResponse({ member: { bioguideId, currentMember: true, terms: [{ chamber: "Senate", stateCode: "CA" }] } });

const sqsRecord = (messageId: string, bioguideId: string) => ({
  messageId,
  body: JSON.stringify({ bioguideId }),
});

const enqueuedIds = (): string[] =>
  mockSQSSend.mock.calls.flatMap(([command]: [SendBatchCommand]) =>
    command.input.Entries.map((entry) => (JSON.parse(entry.MessageBody) as { bioguideId: string }).bioguideId),
  );

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

export {};
afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("fetchRawCongressMembers handler", () => {
  it("fetches member details and stores them in S3", async () => {
    const memberPayload = {
      member: {
        bioguideId: "A000001",
        name: "Test",
        terms: [{ chamber: "Senate", stateCode: "CA" }],
      },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(memberPayload),
      text: () => Promise.resolve(""),
    });

    const result = await handler({
      Records: [{ body: JSON.stringify({ bioguideId: "A000001" }) }],
    });

    expect(result).toEqual({ batchItemFailures: [] });

    // Verify Congress API URL
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("https://api.congress.gov/v3/member/A000001");
    expect(calledUrl).toContain("api_key=test-key");
    expect(calledUrl).toContain("format=json");

    // Verify S3 write
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const putCommandInput = mockS3Send.mock.calls[0][0].input;
    expect(putCommandInput.Bucket).toBe("test-bucket");
    expect(putCommandInput.Key).toBe("raw-congress-members/A000001.json");

    const stored = JSON.parse(putCommandInput.Body);
    expect(stored).toEqual(memberPayload);

    // Verify SQS enqueue (after S3 write)
    expect(mockSQSSend).toHaveBeenCalledTimes(1);
    const sendCommandInput = mockSQSSend.mock.calls[0][0].input;
    expect(sendCommandInput.QueueUrl).toBe(process.env.QUEUE_URL);
    expect(sendCommandInput.Entries).toHaveLength(1);
    expect(JSON.parse(sendCommandInput.Entries[0].MessageBody)).toEqual({ bioguideId: "A000001" });

    // Ensure ordering: store in S3 happens before enqueue.
    expect(mockS3Send.mock.invocationCallOrder[0]).toBeLessThan(mockSQSSend.mock.invocationCallOrder[0]);
  });

  it("marks batch item failure when a record is missing bioguideId", async () => {
    const result = await handler({
      Records: [{ messageId: "msg-1", body: JSON.stringify({}) }],
    });
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });

    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockSQSSend).not.toHaveBeenCalled();
  });

  describe("congress.gov pacing and resilience (REL-14)", () => {
    it("fetches one member at a time with the inter-call delay between congress.gov calls", async () => {
      loadHandler({ CONGRESS_API_CALL_DELAY_MS: "25" });
      let inFlight = 0;
      let maxInFlight = 0;
      const startedAt: number[] = [];
      mockFetch.mockImplementation(async (url: string) => {
        startedAt.push(Date.now());
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return memberResponse(url.match(/member\/([A-Z0-9]+)/)![1]);
      });

      const result = await handler({
        Records: [sqsRecord("m1", "A000001"), sqsRecord("m2", "B000002"), sqsRecord("m3", "C000003")],
      });

      expect(result).toEqual({ batchItemFailures: [] });
      expect(maxInFlight).toBe(1);
      expect(mockFetch.mock.calls.map((c) => c[0] as string).map((u) => u.match(/member\/([A-Z0-9]+)/)![1])).toEqual([
        "A000001",
        "B000002",
        "C000003",
      ]);
      expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(20);
      expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(20);
      expect(enqueuedIds()).toEqual(["A000001", "B000002", "C000003"]);
    });

    it("passes a timeout signal to fetch", async () => {
      mockFetch.mockResolvedValueOnce(memberResponse("A000001"));

      await handler({ Records: [sqsRecord("m1", "A000001")] });

      expect(mockFetch.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it("retries 429/5xx and reports only the member that still failed", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/member/B000002")) return jsonResponse({}, 503);
        return memberResponse(url.match(/member\/([A-Z0-9]+)/)![1]);
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "1" }));

      const result = await handler({
        Records: [sqsRecord("m1", "A000001"), sqsRecord("m2", "B000002"), sqsRecord("m3", "C000003")],
      });

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
      // A000001: 429 then success; B000002: 1 try + 2 retries; C000003: 1 try.
      expect(mockFetch).toHaveBeenCalledTimes(6);
      expect(enqueuedIds()).toEqual(["A000001", "C000003"]);
      const logged = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("returned 503");
      expect(logged).not.toContain("test-key");
    });

    it("on 401 drops the cached key, emits CongressApiAuthFailure and retries with a fresh key", async () => {
      mockSecretsSend
        .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "old-key" }) })
        .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "new-key" }) });
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401)).mockResolvedValueOnce(memberResponse("A000001"));

      const result = await handler({ Records: [sqsRecord("m1", "A000001")] });

      expect(result).toEqual({ batchItemFailures: [] });
      expect(mockFetch.mock.calls[0][0]).toContain("api_key=old-key");
      expect(mockFetch.mock.calls[1][0]).toContain("api_key=new-key");
      expect(mockCloudWatchSend).toHaveBeenCalledTimes(1);
      expect(mockCloudWatchSend.mock.calls[0][0].input).toEqual({
        Namespace: "BillBoard/BillIngestion",
        MetricData: [{ MetricName: "CongressApiAuthFailure", Unit: "Count", Value: 1 }],
      });
    });

    it("fetches a member listed twice in one batch only once", async () => {
      mockFetch.mockResolvedValueOnce(memberResponse("A000001"));

      const result = await handler({ Records: [sqsRecord("m1", "A000001"), sqsRecord("m2", "A000001")] });

      expect(result).toEqual({ batchItemFailures: [] });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(enqueuedIds()).toEqual(["A000001"]);
    });

    it("fails both duplicate messages when the summarizer enqueue fails", async () => {
      mockFetch.mockResolvedValueOnce(memberResponse("A000001"));
      mockSQSSend.mockResolvedValueOnce({ Failed: [{ Id: "msg-0", Code: "InternalError", SenderFault: false }] });

      const result = await handler({ Records: [sqsRecord("m1", "A000001"), sqsRecord("m2", "A000001")] });

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
    });
  });
});
