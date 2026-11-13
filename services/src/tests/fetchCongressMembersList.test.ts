import { applyTestEnv } from "./fixtures/env";

const originalEnv = { ...process.env };

const mockSecretsSend = jest.fn();
const mockSQSSend = jest.fn();
const mockDdbSend = jest.fn();
const mockCloudWatchSend = jest.fn();
const mockFetch = jest.fn();

/** A SendMessageBatchCommand the SQS mock received; the tests read the queue URL and the entry bodies. */
interface SentBatch {
  input: { QueueUrl?: string; Entries: Array<{ MessageBody: string }> };
}

// Mock global fetch
global.fetch = mockFetch;

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  ScanCommand: jest.fn().mockImplementation((input) => ({ __type: "ScanCommand", input })),
}));

jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCloudWatchSend })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type HandlerReturn = Promise<{
  status: "ok";
  discovered: number;
  enqueued: number;
  pages: number;
  departedChecks: number;
}>;
let handler: () => HandlerReturn;
let restoreEnv: (() => void) | undefined;

beforeEach(() => {
  mockSecretsSend.mockReset();
  mockSQSSend.mockReset();
  mockDdbSend.mockReset();
  mockCloudWatchSend.mockReset();
  mockFetch.mockReset();

  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  mockSecretsSend.mockResolvedValue({
    SecretString: JSON.stringify({ congressApiKey: "test-key" }),
  });
  mockSQSSend.mockImplementation((cmd) =>
    Promise.resolve({
      Successful: (cmd.input?.Entries ?? []).map((_: unknown, idx: number) => ({ Id: `msg-${idx}` })),
    }),
  );
  mockCloudWatchSend.mockResolvedValue({});

  loadHandler();
});

const loadHandler = (env: Record<string, string | undefined> = {}) => {
  jest.resetModules();
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      SECRET_NAME: "test-secret",
      QUEUE_URL: "https://example.com/queue",
      QUEUE_BATCH_SIZE: "10",
      CONGRESS_API_BASE_URL: "https://api.congress.gov/v3",
      CONGRESS_API_BASE_DELAY_MS: "1",
      CONGRESS_API_MAX_DELAY_MS: "5",
      ...env,
    },
    { replace: true, base: originalEnv },
  );

  const mod = require("../handlers/fetchCongressMembersList");
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

const memberPage = (ids: string[], next?: string) =>
  jsonResponse({ members: ids.map((bioguideId) => ({ bioguideId })), pagination: next ? { next } : {} });

const enqueuedIds = (): string[] =>
  mockSQSSend.mock.calls.flatMap(([command]: [SentBatch]) =>
    command.input.Entries.map((e) => (JSON.parse(e.MessageBody) as { bioguideId: string }).bioguideId),
  );

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

export {};
afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("fetchCongressMembersList handler", () => {
  it("paginates members and enqueues bioguideIds to SQS", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({
            members: [{ bioguideId: "A000001" }, { bioguideId: "B000002" }],
            pagination: {
              next: "https://api.congress.gov/v3/member?offset=2&limit=2",
            },
          }),
        text: () => Promise.resolve(""),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () =>
          Promise.resolve({
            members: [{ bioguideId: "C000003" }, { bioguideId: "B000002" }],
            pagination: {},
          }),
        text: () => Promise.resolve(""),
      });

    mockSQSSend.mockImplementation((cmd) =>
      Promise.resolve({
        Successful: (cmd.input?.Entries ?? []).map((_: unknown, idx: number) => ({ Id: `msg-${idx}` })),
      }),
    );

    const result = await handler();

    // ensure we requested only current members, in the largest pages congress.gov allows
    expect(mockFetch).toHaveBeenCalled();
    const firstFetchUrl = mockFetch.mock.calls[0][0];
    expect(typeof firstFetchUrl).toBe("string");
    expect(firstFetchUrl).toContain("currentMember=true");
    expect(firstFetchUrl).toContain("limit=250");

    expect(result).toEqual({ status: "ok", discovered: 3, enqueued: 3, pages: 2, departedChecks: 0 });

    // enqueues across pages (may be multiple batch calls)
    expect(mockSQSSend).toHaveBeenCalledTimes(2);
    for (const call of mockSQSSend.mock.calls) {
      expect(call[0].input.QueueUrl).toBe(process.env.QUEUE_URL);
    }

    const allEntries = mockSQSSend.mock.calls.flatMap(([command]: [SentBatch]) => command.input.Entries);
    expect(allEntries).toHaveLength(3);
    const bodies = allEntries.map((e) => (JSON.parse(e.MessageBody) as { bioguideId: string }).bioguideId);
    expect(new Set(bodies)).toEqual(new Set(["A000001", "B000002", "C000003"]));
  });

  it("enqueues nothing when API returns no members", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ members: [], pagination: {} }),
      text: () => Promise.resolve(""),
    });

    const result = await handler();

    // ensure we requested only current members
    expect(mockFetch).toHaveBeenCalled();
    const firstFetchUrl = mockFetch.mock.calls[0][0];
    expect(typeof firstFetchUrl).toBe("string");
    expect(firstFetchUrl).toContain("currentMember=true");

    expect(result).toEqual({ status: "ok", discovered: 0, enqueued: 0, pages: 1, departedChecks: 0 });
    expect(mockSQSSend).not.toHaveBeenCalled();
  });

  describe("departed members (APPF-02)", () => {
    // GA-14: G000596 left the seat and S000999 now holds it. Only the successor is current.
    const DEPARTED = "G000596";
    const SUCCESSOR = "S000999";
    const OTHER_CURRENT = "A000001";

    beforeEach(() => {
      loadHandler({ CONGRESS_MEMBERS_MANIFEST_TABLE_NAME: "CongressMembersManifest" });
    });

    it("re-queues manifest members missing from the complete current list, once each", async () => {
      mockFetch
        .mockResolvedValueOnce(
          memberPage([SUCCESSOR], "https://api.congress.gov/v3/member?currentMember=true&offset=250&limit=250"),
        )
        .mockResolvedValueOnce(memberPage([OTHER_CURRENT]));
      mockDdbSend
        .mockResolvedValueOnce({
          Items: [{ bioguideId: { S: OTHER_CURRENT } }, { bioguideId: { S: DEPARTED } }],
          LastEvaluatedKey: { bioguideId: { S: DEPARTED } },
        })
        .mockResolvedValueOnce({ Items: [{ bioguideId: { S: SUCCESSOR } }] });

      const result = await handler();

      expect(result).toEqual({ status: "ok", discovered: 2, enqueued: 2, pages: 2, departedChecks: 1 });
      expect(enqueuedIds()).toEqual([SUCCESSOR, OTHER_CURRENT, DEPARTED]);

      // Paginated scan of the manifest ids, after the list was fully read.
      expect(mockDdbSend).toHaveBeenCalledTimes(2);
      expect(mockDdbSend.mock.calls[0][0].input).toEqual(
        expect.objectContaining({ TableName: "CongressMembersManifest", ProjectionExpression: "bioguideId" }),
      );
      expect(mockDdbSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ bioguideId: { S: DEPARTED } });
      expect(mockDdbSend.mock.invocationCallOrder[0]).toBeGreaterThan(mockFetch.mock.invocationCallOrder[1]);
    });

    it("does not re-check anyone when every manifest member is still current", async () => {
      mockFetch.mockResolvedValueOnce(memberPage([SUCCESSOR, OTHER_CURRENT]));
      mockDdbSend.mockResolvedValueOnce({
        Items: [{ bioguideId: { S: SUCCESSOR } }, { bioguideId: { S: OTHER_CURRENT } }],
      });

      const result = await handler();

      expect(result.departedChecks).toBe(0);
      expect(enqueuedIds()).toEqual([SUCCESSOR, OTHER_CURRENT]);
    });

    it("skips the check when the current list is empty", async () => {
      mockFetch.mockResolvedValueOnce(memberPage([]));

      const result = await handler();

      expect(result.departedChecks).toBe(0);
      expect(mockDdbSend).not.toHaveBeenCalled();
      expect(mockSQSSend).not.toHaveBeenCalled();
    });

    it("skips the check when a list page fails, so a partial list never drives re-checks", async () => {
      mockFetch
        .mockResolvedValueOnce(memberPage([SUCCESSOR], "https://api.congress.gov/v3/member?offset=250&limit=250"))
        .mockResolvedValueOnce(jsonResponse({ error: "bad" }, 400));

      await expect(handler()).rejects.toThrow("status 400");
      expect(mockDdbSend).not.toHaveBeenCalled();
    });

    it("still succeeds when the manifest scan fails", async () => {
      mockFetch.mockResolvedValueOnce(memberPage([SUCCESSOR]));
      mockDdbSend.mockRejectedValueOnce(new Error("AccessDenied"));

      const result = await handler();

      expect(result).toEqual({ status: "ok", discovered: 1, enqueued: 1, pages: 1, departedChecks: 0 });
      expect(console.error).toHaveBeenCalledWith("Departed-member check failed", expect.any(Error));
    });
  });

  describe("congress.gov resilience (REL-14)", () => {
    it("passes a timeout signal to fetch", async () => {
      mockFetch.mockResolvedValueOnce(memberPage([]));

      await handler();

      const init = mockFetch.mock.calls[0][1];
      expect(init).toEqual(expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }));
    });

    it("retries 429 and 5xx responses with backoff, then succeeds", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "1" }))
        .mockResolvedValueOnce(jsonResponse({}, 503))
        .mockResolvedValueOnce(memberPage(["A000001"]));

      const result = await handler();

      expect(result.discovered).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const warnings = (console.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes("returned 429"))).toBe(true);
      expect(warnings.every((w) => !w.includes("test-key"))).toBe(true);
    });

    it("gives up after the configured retries", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}, 500));

      await expect(handler()).rejects.toThrow("status 500");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("retries network errors and timeouts", async () => {
      const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
      mockFetch.mockRejectedValueOnce(timeout).mockResolvedValueOnce(memberPage(["A000001"]));

      const result = await handler();

      expect(result.discovered).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("on 401 drops the cached key and retries with a fresh key, without alarming when that works", async () => {
      mockSecretsSend
        .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "old-key" }) })
        .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "new-key" }) });
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 401)).mockResolvedValueOnce(memberPage(["A000001"]));

      const result = await handler();

      expect(result.discovered).toBe(1);
      expect(mockSecretsSend).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain("api_key=old-key");
      expect(mockFetch.mock.calls[1][0]).toContain("api_key=new-key");
      expect(mockCloudWatchSend).not.toHaveBeenCalled();
    });

    it("emits CongressApiAuthFailure once and fails when the fresh key is also rejected", async () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      mockFetch.mockResolvedValue(jsonResponse({}, 403));

      await expect(handler()).rejects.toThrow("status 403");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockCloudWatchSend).toHaveBeenCalledTimes(1);
      expect(mockCloudWatchSend.mock.calls[0][0].input).toEqual({
        Namespace: "BillBoard/BillIngestion",
        MetricData: [{ MetricName: "CongressApiAuthFailure", Unit: "Count", Value: 1 }],
      });
      errorSpy.mockRestore();
    });
  });
});
