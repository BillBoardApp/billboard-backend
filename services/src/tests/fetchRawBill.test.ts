import { EventEmitter } from "events";
import { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { FakeVersionedS3, type FakeS3Input } from "./fakeVersionedS3";
import { rawBillDifferences } from "../handlers/fetchRawBill/refetchUnchanged";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

export {};

const originalEnv = { ...process.env };
const TEXT_RETRY_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/UpdatedBillsQueue";

const mockS3Send = jest.fn();
const mockSecretsManagerSend = jest.fn();
const mockCloudWatchSend = jest.fn();
const mockSqsSend = jest.fn();
const httpResponses: Array<{
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  // Emit this network error instead of a response.
  error?: Error;
  // Never respond: fire the socket inactivity timeout instead.
  stall?: boolean;
}> = [];
const socketTimeoutsMs: number[] = [];

/** The parts of an http.IncomingMessage the mocked https.request fills in. */
interface FakeResponse extends EventEmitter {
  statusCode?: number;
  headers?: Record<string, string>;
  resume?: jest.Mock;
}

/** The parts of an http.ClientRequest the mocked https.request fills in. */
interface FakeRequest extends EventEmitter {
  setTimeout?: jest.Mock;
  destroy?: jest.Mock;
  end?: jest.Mock;
  write?: jest.Mock;
}

const mockHttpsRequest = jest.fn(
  (_url: unknown, _optionsOrCallback?: unknown, _callback?: (res: FakeResponse) => void) => {
    // Handle both signatures: (url, callback) and (url, options, callback)
    const callback = typeof _optionsOrCallback === "function" ? _optionsOrCallback : _callback;

    const config = httpResponses.shift() ?? { statusCode: 200, headers: {}, body: "" };

    const res = new EventEmitter() as FakeResponse;
    res.statusCode = config.statusCode;
    res.headers = config.headers ?? {};
    res.resume = jest.fn();

    const req = new EventEmitter() as FakeRequest;
    let onSocketTimeout: (() => void) | undefined;
    req.setTimeout = jest.fn((ms: number, cb: () => void) => {
      socketTimeoutsMs.push(ms);
      onSocketTimeout = cb;
      return req;
    });
    req.destroy = jest.fn((error?: Error) => {
      if (error) req.emit("error", error);
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
      if (callback) {
        callback(res);
      }

      if (config.body !== undefined) {
        res.emit("data", config.body);
      }
      res.emit("end");
    });
    req.on = req.on.bind(req);
    req.write = jest.fn();

    return req;
  },
);

// Commands carry __cmd, the shape FakeVersionedS3 reads, so the REL-35 tests can route them to it.
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
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("https", () => ({
  request: (...args: Parameters<typeof mockHttpsRequest>) => mockHttpsRequest(...args),
}));

/** The raw bill document as the handler stores it, reduced to the fields these tests read. */
interface StoredRaw {
  metadata: { fetchedAt: string };
  content: {
    officialVotes?: { house?: unknown; senate?: unknown; lastSyncedAt?: unknown; completeness?: unknown };
    billXML?: string;
    billXMLFetch: { retryScheduled?: unknown; source?: unknown };
  };
}

type HandlerReturn = Promise<SQSBatchResponse>;
let handler: (event: SQSEvent) => HandlerReturn;
let restoreEnv: (() => void) | undefined;

beforeEach(() => {
  jest.resetModules();
  mockS3Send.mockReset();
  mockSecretsManagerSend.mockReset();
  mockCloudWatchSend.mockReset();
  mockSqsSend.mockReset();
  mockHttpsRequest.mockClear();
  httpResponses.length = 0;
  socketTimeoutsMs.length = 0;

  // Suppress console output during tests
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      BUCKET_NAME: "test-raw-bills-bucket",
      SECRET_NAME: "CongressAPIKey",
      QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
      // REL-45: the delayed bill text retry goes back to UpdatedBillsQueue, as in production.
      TEXT_RETRY_QUEUE_URL: TEXT_RETRY_QUEUE,
      QUEUE_BATCH_SIZE: "10",
      CONGRESS_API_CALL_DELAY_MS: "0",
      CONGRESS_API_BASE_DELAY_MS: "0",
      CONGRESS_API_MAX_DELAY_MS: "0",
    },
    { replace: true, base: originalEnv },
  );

  mockS3Send.mockImplementation(() => Promise.resolve({}));
  mockSecretsManagerSend.mockImplementation(() =>
    Promise.resolve({
      SecretString: JSON.stringify({ congressApiKey: "test-api-key-123" }),
    }),
  );
  mockCloudWatchSend.mockResolvedValue({});
  mockSqsSend.mockResolvedValue({});

  const mod = require("../handlers/fetchRawBill");
  handler = mod.handler;
});

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

const createSQSEvent = (
  records: Array<{
    guid: string;
    title: string;
    link?: string;
    pubDate: string;
    category?: string;
    description?: string;
    congress?: string;
    billType?: string;
    billNumber?: string;
  }>,
): SQSEvent => {
  return {
    Records: records.map((record, idx) => ({
      messageId: `msg-${idx}`,
      receiptHandle: `receipt-${idx}`,
      body: JSON.stringify(record),
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "1234567890",
        SenderId: "test-sender",
        ApproximateFirstReceiveTimestamp: "1234567890",
      },
      messageAttributes: {},
      md5OfBody: "test-md5",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:test-queue",
      awsRegion: "us-east-1",
    })),
  };
};

/** An S3 command input; the handler writes the Body as a JSON string. */
type S3Input = Omit<FakeS3Input, "Body"> & { Body: string };

/** The inputs of the S3 commands of one kind sent so far, in order. */
const s3Inputs = (kind: "GetObject" | "PutObject"): FakeS3Input[] =>
  mockS3Send.mock.calls.filter(([cmd]) => cmd?.__cmd === kind).map(([cmd]) => cmd.input);
/** Every PutObject sent: the raw bill writes. (Each stored bill is first read once, REL-35.) */
const s3Puts = () => s3Inputs("PutObject") as S3Input[];

const metricDatums = (metricName: string): Array<Record<string, unknown>> =>
  mockCloudWatchSend.mock.calls.flatMap(([cmd]) =>
    (cmd?.input?.MetricData ?? []).filter((metric: { MetricName?: string }) => metric.MetricName === metricName),
  );

const pushSuccessfulBillResponses = () => {
  for (let i = 0; i < 8; i++) {
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify(i === 7 ? { textVersions: [] } : { bill: { number: "77", type: "hr", congress: 119 } }),
    });
  }
};

const singleBillEvent = () =>
  createSQSEvent([
    {
      guid: "BILLS-119hr77ih",
      title: "H.R. 77",
      pubDate: "2026-03-01T12:00:00Z",
      congress: "119",
      billType: "hr",
      billNumber: "77",
    },
  ]);

describe("fetchRawBill handler", () => {
  it("fetches comprehensive bill data from Congress API and stores in S3 with pre-parsed bill info", async () => {
    // Mock responses for all 8 endpoints - each endpoint returns its own data structure
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ bill: { number: "443", type: "sres", congress: 119, title: "Test Bill" } }),
    }); // /bill
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ actions: [] }),
    }); // /actions
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ cosponsors: [] }),
    }); // /cosponsors
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ committees: [] }),
    }); // /committees
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ relatedBills: [] }),
    }); // /relatedbills
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ subjects: [] }),
    }); // /subjects
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ titles: [] }),
    }); // /titles
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        textVersions: [
          {
            type: "Introduced in Senate",
            date: "2025-10-17T05:00:00Z",
            formats: [
              { type: "PDF", url: "https://example.com/bill.pdf" },
              { type: "Formatted XML", url: "https://example.com/bill.xml" },
            ],
          },
        ],
      }),
    }); // /text
    // Mock the actual XML text content fetch
    httpResponses.push({
      statusCode: 200,
      body: "<bill><legis-body><section><header>Section 1</header><text>This resolution condemns attacks on Federal law enforcement.</text></section></legis-body></bill>",
    });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119sres443is",
        title: "S. Res. 443 (IS) - Condemning attacks on Federal law enforcement.",
        link: "https://www.govinfo.gov/app/details/BILLS-119sres443is",
        pubDate: "Fri, 17 Oct 2025 05:52:00 +0000",
        category: "Bills and Statutes",
        description: "Content files...",
        congress: "119",
        billType: "senate-resolution",
        billNumber: "443",
      },
    ]);

    await handler(sqsEvent);

    // Verify Secrets Manager was called once
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
    const secretCommand = mockSecretsManagerSend.mock.calls[0][0].input;
    expect(secretCommand.SecretId).toBe("CongressAPIKey");

    // Verify Congress API was called for all 8 endpoints + 1 XML text fetch = 9 total
    expect(mockHttpsRequest).toHaveBeenCalledTimes(9);

    // Verify CloudWatch metrics emitted for success + core API call budget
    expect(mockCloudWatchSend).toHaveBeenCalled();
    expect(
      mockCloudWatchSend.mock.calls.some(([cmd]) =>
        cmd?.input?.MetricData?.some((metric: { MetricName?: string }) => metric.MetricName === "BillXmlFetchSuccess"),
      ),
    ).toBe(true);
    expect(
      mockCloudWatchSend.mock.calls.some(([cmd]) =>
        cmd?.input?.MetricData?.some((metric: { MetricName?: string }) => metric.MetricName === "CongressApiCallsCore"),
      ),
    ).toBe(true);

    // Verify S3 put was called (guid key)
    expect(s3Puts()).toHaveLength(1);
    const putCommandGuid = s3Puts()[0];
    expect(putCommandGuid.Bucket).toBe("test-raw-bills-bucket");
    expect(putCommandGuid.Key).toBe("raw-bills/BILLS-119sres443.json");
    expect(putCommandGuid.ContentType).toBe("application/json");

    // Verify stored data includes both Congress API response and metadata
    const storedData = JSON.parse(putCommandGuid.Body);

    expect(storedData.schemaVersion).toBe(1);
    expect(storedData.kind).toBe("raw");
    expect(typeof storedData.storedAt).toBe("string");

    // Verify bill id
    expect(storedData.identifier).toBeDefined();
    expect(storedData.identifier?.congress).toBeDefined();
    expect(storedData.identifier?.billType).toBeDefined();
    expect(storedData.identifier?.billNumber).toBeDefined();

    // Verify comprehensive data structure
    expect(storedData.content).toBeDefined();
    expect(storedData.content?.actions).toBeDefined();
    expect(storedData.content?.cosponsors).toBeDefined();
    expect(storedData.content?.committees).toBeDefined();
    expect(storedData.content?.relatedBills).toBeDefined();
    expect(storedData.content?.subjects).toBeDefined();
    expect(storedData.content?.titles).toBeDefined();
    expect(storedData.content?.text).toBeDefined();
    expect(storedData.content?.billXML).toBeDefined();
    expect(storedData.content?.billXML).toContain("condemns attacks on Federal law enforcement");

    // Verify metadata (the guid without the feed item's text-version suffix)
    expect(storedData.metadata).toMatchObject({
      guid: "BILLS-119sres443",
      title: "S. Res. 443 (IS) - Condemning attacks on Federal law enforcement.",
      pubDate: "Fri, 17 Oct 2025 05:52:00 +0000",
      category: "Bills and Statutes",
      description: "Content files...",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/senate-resolution/443",
    });
    expect(storedData.metadata.fetchedAt).toBeDefined();

    // Verify SQS enqueue (batched)
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const sqsCall = mockSqsSend.mock.calls[0][0].input;
    expect(sqsCall.QueueUrl).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/test-queue");
    expect(sqsCall.Entries).toHaveLength(1);
    const enqueued = JSON.parse(sqsCall.Entries[0].MessageBody);
    expect(enqueued.guid).toBe("BILLS-119sres443");
  });

  it("fetches a Formatted XML URL of another shape from congress.gov only, and retries a 403 later (REL-45)", async () => {
    // Mock 8 JSON endpoints
    for (let i = 0; i < 8; i++) {
      if (i === 7) {
        httpResponses.push({
          statusCode: 200,
          body: JSON.stringify({
            textVersions: [
              {
                formats: [{ type: "Formatted XML", url: "https://example.com/bad.xml" }],
              },
            ],
          }),
        });
      } else {
        httpResponses.push({
          statusCode: 200,
          body: JSON.stringify({ test: `data-${i}` }),
        });
      }
    }

    // XML fetch returns 403
    httpResponses.push({ statusCode: 403, body: "" });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119sres555is",
        title: "S. Res. 555",
        link: "https://www.govinfo.gov/app/details/BILLS-119sres555is",
        pubDate: "2025-10-17T05:52:00Z",
        congress: "119",
        billType: "senate-resolution",
        billNumber: "555",
      },
    ]);

    const result = await handler(sqsEvent);

    // No package id in the URL: no GovInfo request and no read of the stored copy for its text.
    expect(mockHttpsRequest).toHaveBeenCalledTimes(9);
    expect(String(mockHttpsRequest.mock.calls[8][0])).toBe("https://example.com/bad.xml");
    expect(s3Inputs("GetObject")).toHaveLength(1);
    // The per-source series stay for diagnosis; no alarm watches them any more.
    expect(metricDatums("BillXmlFetchFailure")).toEqual([
      {
        MetricName: "BillXmlFetchFailure",
        Dimensions: [{ Name: "Source", Value: "CongressGov" }],
        Unit: "Count",
        Value: 1,
      },
      {
        MetricName: "BillXmlFetchFailure",
        Dimensions: [
          { Name: "Source", Value: "CongressGov" },
          { Name: "StatusCode", Value: "403" },
        ],
        Unit: "Count",
        Value: 1,
      },
    ]);
    expect(metricDatums("BillTextRetryScheduled")).toHaveLength(1);
    expect(metricDatums("BillTextUnavailable")).toEqual([]);

    const putCommand = s3Puts()[0];
    const storedData = JSON.parse(putCommand.Body);
    expect(storedData.content.billXML).toBeUndefined();
    expect(storedData.content.billXMLFetch).toMatchObject({
      outcome: "refused",
      versionStem: null,
      statuses: { CongressGov: 403 },
      retryScheduled: true,
    });
    expect(result.batchItemFailures).toEqual([]);
    const retries = mockSqsSend.mock.calls
      .map(([cmd]) => cmd.input)
      .filter((input) => input.QueueUrl === TEXT_RETRY_QUEUE);
    expect(retries).toHaveLength(1);
    expect(JSON.parse(retries[0].Entries[0].MessageBody)).toMatchObject({
      guid: "BILLS-119sres555is",
      textRetryAttempt: 1,
    });
  });

  it("uses explicit congress/type/number fields when link is absent", async () => {
    for (let i = 0; i < 8; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(i === 7 ? { textVersions: [] } : { test: `data-${i}` }),
      });
    }

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr42",
        title: "H.R. 42",
        pubDate: "2026-03-01T12:00:00Z",
        congress: "119",
        billType: "hr",
        billNumber: "42",
      },
    ]);

    await handler(sqsEvent);

    expect(mockHttpsRequest).toHaveBeenCalledTimes(8);
    const putCommand = s3Puts()[0];
    const storedData = JSON.parse(putCommand.Body);
    expect(storedData.identifier).toMatchObject({
      congress: "119",
      billType: "hr",
      billNumber: "42",
    });
  });

  it("constructs Congress API URLs correctly with abbreviated billType", async () => {
    // Mock responses for all 8 endpoints
    for (let i = 0; i < 8; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(i === 7 ? { textVersions: [] } : { test: "data" }),
      });
    }

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119sres443is",
        title: "S. Res. 443",
        link: "https://www.govinfo.gov/app/details/BILLS-119sres443is",
        pubDate: "2025-10-17T05:52:00Z",
        congress: "119",
        billType: "senate-resolution",
        billNumber: "443",
      },
    ]);

    await handler(sqsEvent);

    // Verify API calls were made with abbreviated billType format
    expect(mockHttpsRequest).toHaveBeenCalledTimes(8);

    expect(mockCloudWatchSend).toHaveBeenCalledTimes(1);
    expect(mockCloudWatchSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          MetricData: expect.arrayContaining([expect.objectContaining({ MetricName: "CongressApiCallsCore" })]),
        }),
      }),
    );

    const apiCalls = mockHttpsRequest.mock.calls;
    const expectedBaseUrl = "https://api.congress.gov/v3/bill/119/sres/443";
    // Order matches sequential fetching: bill, actions, subjects, titles, cosponsors, committees, relatedBills, text
    const expectedUrls = [
      `${expectedBaseUrl}?api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/actions?limit=250&api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/subjects?api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/titles?api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/cosponsors?limit=250&api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/committees?api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/relatedbills?limit=250&api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/text?api_key=test-api-key-123&format=json`,
    ];

    // Verify each endpoint URL is constructed exactly, uses abbreviated type, and includes JSON format
    expect(apiCalls.slice(0, 8).map(([url]) => url)).toEqual(expectedUrls);
    apiCalls.slice(0, 8).forEach(([url]) => {
      expect(url).not.toContain("senate-resolution");
      expect(url).toContain("/sres/");
      expect(url).toContain("format=json");
    });

    // Verify S3 put uses guid key
    expect(s3Puts()).toHaveLength(1);
    const putCommandGuid = s3Puts()[0];
    expect(putCommandGuid.Key).toBe("raw-bills/BILLS-119sres443.json");
  });

  it("parses bill info from link when not pre-parsed", async () => {
    const congressApiResponse = {
      bill: {
        number: "1234",
        type: "hr",
        congress: 118,
        title: "House Bill 1234",
      },
    };

    // Mock responses for all 8 endpoints (no text content in this test)
    for (let i = 0; i < 8; i++) {
      if (i === 7) {
        // text endpoint with empty versions
        httpResponses.push({
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ textVersions: { item: [] } }),
        });
      } else {
        httpResponses.push({
          statusCode: 200,
          headers: {},
          body: JSON.stringify(congressApiResponse),
        });
      }
    }

    const sqsEvent = createSQSEvent([
      {
        guid: "item-1",
        title: "H.R. 1234",
        link: "https://www.congress.gov/bill/118th-congress/house-bill/1234",
        pubDate: "2025-01-01T12:00:00Z",
        description: "Test bill",
      },
    ]);

    await handler(sqsEvent);

    // Verify API calls use abbreviated format (parsed from human-readable link)
    expect(mockHttpsRequest).toHaveBeenCalledTimes(8);
    const apiCalls = mockHttpsRequest.mock.calls;
    const expectedBaseUrl = "https://api.congress.gov/v3/bill/118/hr/1234";
    // Order matches sequential fetching: bill, actions, subjects, titles, cosponsors, committees, relatedBills, text
    const expectedUrls = [
      `${expectedBaseUrl}?api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/actions?limit=250&api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/subjects?api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/titles?api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/cosponsors?limit=250&api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/committees?api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/relatedbills?limit=250&api_key=test-api-key-123&format=json`,
      `${expectedBaseUrl}/text?api_key=test-api-key-123&format=json`,
    ];

    expect(apiCalls.slice(0, 8).map(([url]) => url)).toEqual(expectedUrls);
    apiCalls.slice(0, 8).forEach(([url]) => {
      expect(url).not.toContain("house-bill");
      expect(url).toContain("/hr/");
      expect(url).toContain("format=json");
    });

    // Verify S3 put uses guid key
    expect(s3Puts()).toHaveLength(1);
    const putCommandGuid = s3Puts()[0];
    expect(putCommandGuid.Key).toBe("raw-bills/item-1.json");
  });

  it("obeys CONGRESS_API_MAX_CALLS_PER_BILL budget per bill", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
        CONGRESS_API_MAX_CALLS_PER_BILL: "3",
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    const mod = require("../handlers/fetchRawBill");
    const cappedHandler = mod.handler as typeof handler;
    mockHttpsRequest.mockClear();

    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ bill: { number: "443", type: "sres", congress: 119, title: "Test Bill" } }),
    }); // bill
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ actions: [] }),
    }); // actions
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ subjects: [] }),
    }); // subjects

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119sres443is",
        title: "S. Res. 443",
        link: "https://www.govinfo.gov/app/details/BILLS-119sres443is",
        pubDate: "Fri, 17 Oct 2025 05:52:00 +0000",
        congress: "119",
        billType: "senate-resolution",
        billNumber: "443",
      },
    ]);

    await cappedHandler(sqsEvent);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(3);
    expect(s3Puts()).toHaveLength(1);
  });

  it("enqueues eligible house votes to enrichment queue without per-member calls", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
        VOTE_ENRICHMENT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment",
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    const mod = require("../handlers/fetchRawBill");
    const enrichedQueueHandler = mod.handler as typeof handler;
    mockHttpsRequest.mockClear();
    mockSqsSend.mockClear();

    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ bill: { number: "10", type: "hr", congress: 119, title: "Test Bill" } }),
    }); // bill
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        actions: [
          {
            actionCode: "8000",
            actionDate: "2026-02-01",
            text: "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 123).",
          },
        ],
      }),
    }); // actions
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ subjects: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ titles: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ cosponsors: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ committees: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ relatedBills: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ textVersions: [] }) });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr10ih",
        title: "H.R. 10",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr10ih",
        pubDate: "Fri, 17 Oct 2025 05:52:00 +0000",
        congress: "119",
        billType: "house-bill",
        billNumber: "10",
      },
    ]);

    await enrichedQueueHandler(sqsEvent);
    expect(mockSqsSend).toHaveBeenCalledTimes(2);
    const queueUrls = mockSqsSend.mock.calls.map(([cmd]) => cmd?.input?.QueueUrl);
    expect(queueUrls).toContain("https://sqs.us-east-1.amazonaws.com/123456789012/test-queue");
    expect(queueUrls).toContain("https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment");
  });

  it("enqueues eligible Senate votes to enrichment queue using the detected roll call reference", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
        VOTE_ENRICHMENT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment",
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    const mod = require("../handlers/fetchRawBill");
    const enrichedQueueHandler = mod.handler as typeof handler;
    mockHttpsRequest.mockClear();
    mockSqsSend.mockClear();

    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ bill: { number: "25", type: "s", congress: 119, title: "Test Senate Bill" } }),
    });
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        actions: [
          {
            actionCode: "17000",
            actionDate: "2026-02-02",
            voteNumber: "44",
            text: "Passed Senate, Yea-Nay Vote. 58 - 42. Record Vote Number: 44.",
          },
        ],
      }),
    });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ subjects: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ titles: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ cosponsors: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ committees: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ relatedBills: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ textVersions: [] }) });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119s25is",
        title: "S. 25",
        link: "https://www.govinfo.gov/app/details/BILLS-119s25is",
        pubDate: "Fri, 17 Oct 2025 05:52:00 +0000",
        congress: "119",
        billType: "senate-bill",
        billNumber: "25",
      },
    ]);

    await enrichedQueueHandler(sqsEvent);
    expect(mockSqsSend).toHaveBeenCalledTimes(2);
    const queueUrls = mockSqsSend.mock.calls.map(([cmd]) => cmd?.input?.QueueUrl);
    expect(queueUrls).toContain("https://sqs.us-east-1.amazonaws.com/123456789012/test-queue");
    expect(queueUrls).toContain("https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment");
  });

  it("enqueues Senate vote enrichment when the bill has procedural vote-related actions without a roll call ref yet", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
        VOTE_ENRICHMENT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment",
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    const mod = require("../handlers/fetchRawBill");
    const enrichedQueueHandler = mod.handler as typeof handler;
    mockHttpsRequest.mockClear();
    mockSqsSend.mockClear();

    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ bill: { number: "3627", type: "s", congress: 119, title: "Procedural Senate Bill" } }),
    });
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        actions: [
          {
            actionDate: "2026-01-15",
            text: "Cloture motion on the motion to proceed presented in Senate. (CR S262)",
          },
        ],
      }),
    });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ subjects: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ titles: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ cosponsors: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ committees: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ relatedBills: [] }) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ textVersions: [] }) });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119s3627is",
        title: "S. 3627",
        link: "https://www.govinfo.gov/app/details/BILLS-119s3627is",
        pubDate: "2026-01-13T00:00:00Z",
        congress: "119",
        billType: "senate-bill",
        billNumber: "3627",
      },
    ]);

    await enrichedQueueHandler(sqsEvent);
    expect(mockSqsSend).toHaveBeenCalledTimes(2);
    const queueUrls = mockSqsSend.mock.calls.map(([cmd]) => cmd?.input?.QueueUrl);
    expect(queueUrls).toContain("https://sqs.us-east-1.amazonaws.com/123456789012/test-queue");
    expect(queueUrls).toContain("https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment");
  });

  it("processes multiple bills sequentially", async () => {
    const bill1Response = { bill: { number: "100", type: "hr", congress: 119 } };
    const bill2Response = { bill: { number: "200", type: "s", congress: 119 } };

    // Mock responses for bill 1 (8 endpoints)
    for (let i = 0; i < 8; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(i === 7 ? { textVersions: { item: [] } } : bill1Response),
      });
    }
    // Mock responses for bill 2 (8 endpoints)
    for (let i = 0; i < 8; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(i === 7 ? { textVersions: { item: [] } } : bill2Response),
      });
    }

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr100is",
        title: "H.R. 100",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr100is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "100",
      },
      {
        guid: "BILLS-119s200is",
        title: "S. 200",
        link: "https://www.govinfo.gov/app/details/BILLS-119s200is",
        pubDate: "2025-01-02T12:00:00Z",
        congress: "119",
        billType: "senate-bill",
        billNumber: "200",
      },
    ]);

    await handler(sqsEvent);

    // Verify API key was fetched only once (cached)
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);

    // Verify both bills were fetched from API (8 endpoints each = 16 total)
    expect(mockHttpsRequest).toHaveBeenCalledTimes(16);

    // Verify both bills were stored in S3 (guid key per bill)
    expect(s3Puts()).toHaveLength(2);

    const bill1GuidPut = s3Puts()[0];
    expect(bill1GuidPut.Key).toBe("raw-bills/BILLS-119hr100.json");

    const bill2GuidPut = s3Puts()[1];
    expect(bill2GuidPut.Key).toBe("raw-bills/BILLS-119s200.json");
  });

  it("handles various bill types correctly", async () => {
    const billTypes = [
      { guid: "BILLS-118hr1is", congress: "118", billType: "house-bill", billNumber: "1" },
      { guid: "BILLS-118s2is", congress: "118", billType: "senate-bill", billNumber: "2" },
      { guid: "BILLS-118hjres3is", congress: "118", billType: "house-joint-resolution", billNumber: "3" },
      { guid: "BILLS-118sjres4is", congress: "118", billType: "senate-joint-resolution", billNumber: "4" },
      { guid: "BILLS-118hconres5is", congress: "118", billType: "house-concurrent-resolution", billNumber: "5" },
      { guid: "BILLS-118sconres6is", congress: "118", billType: "senate-concurrent-resolution", billNumber: "6" },
      { guid: "BILLS-118hres7is", congress: "118", billType: "house-resolution", billNumber: "7" },
      { guid: "BILLS-118sres8is", congress: "118", billType: "senate-resolution", billNumber: "8" },
    ];

    // Mock responses for all bill types (8 bill types × 8 endpoints = 64 requests)
    billTypes.forEach(() => {
      for (let i = 0; i < 8; i++) {
        httpResponses.push({
          statusCode: 200,
          body: JSON.stringify(i === 7 ? { textVersions: { item: [] } } : { bill: { test: "data" } }),
        });
      }
    });

    const sqsEvent = createSQSEvent(
      billTypes.map((bt) => ({
        guid: bt.guid,
        title: `Bill ${bt.billNumber}`,
        link: `https://www.govinfo.gov/app/details/${bt.guid}`,
        pubDate: "2025-01-01T12:00:00Z",
        congress: bt.congress,
        billType: bt.billType,
        billNumber: bt.billNumber,
      })),
    );

    await handler(sqsEvent);

    // Verify all 8 bill types were stored (guid key per bill)
    expect(s3Puts()).toHaveLength(8);

    // Verify all API calls were made (8 bills × 8 endpoints = 64)
    expect(mockHttpsRequest).toHaveBeenCalledTimes(64);

    billTypes.forEach((bt, idx) => {
      const guidPutCommand = s3Puts()[idx];
      const normalizedGuid = bt.guid.replace(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i, "$1");
      expect(guidPutCommand.Key).toBe(`raw-bills/${normalizedGuid}.json`);
    });
  }, 30000); // Increased timeout for 64 sequential API calls

  it("returns batch item failure when main bill endpoint fails", async () => {
    // First endpoint (main bill) returns 404 - sequential fetching stops here
    httpResponses.push({
      statusCode: 404,
      headers: {},
      body: "",
    });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr999is",
        title: "H.R. 999",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr999is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "999",
      },
    ]);

    const result = await handler(sqsEvent);

    // Should return the failed message ID for retry
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-0");
    // Only 1 API call made (main bill endpoint) before failure
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("skips items with unparseable links", async () => {
    const sqsEvent = createSQSEvent([
      {
        guid: "invalid-item",
        title: "Invalid Item",
        link: "https://example.com/not-a-bill",
        pubDate: "2025-01-01T12:00:00Z",
      },
    ]);

    // Should not throw, just skip the item
    await handler(sqsEvent);

    // Should not call Congress API or S3
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("caches API key across handler invocations", async () => {
    const congressApiResponse = { bill: { number: "1", type: "hr", congress: 119 } };

    // Mock responses for first call (8 endpoints)
    for (let i = 0; i < 8; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(i === 7 ? { textVersions: { item: [] } } : congressApiResponse),
      });
    }

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr1is",
        title: "H.R. 1",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr1is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "1",
      },
    ]);

    // First call
    await handler(sqsEvent);
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);

    // Second call - should use cached API key
    // Mock responses for second call (8 endpoints)
    for (let i = 0; i < 8; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(i === 7 ? { textVersions: { item: [] } } : congressApiResponse),
      });
    }

    await handler(sqsEvent);
    // Still only called once (cached)
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(1);
  });

  it("returns batch item failure when any endpoint fails after retries", async () => {
    const congressApiResponse = {
      bill: {
        number: "500",
        type: "hr",
        congress: 119,
        title: "Test Bill",
      },
    };

    // Mock main bill endpoint success
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify(congressApiResponse),
    });

    // Mock actions endpoint failing with 404 (non-retryable)
    httpResponses.push({ statusCode: 404, body: "Not found" }); // actions

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr500is",
        title: "H.R. 500",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr500is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "500",
      },
    ]);

    const result = await handler(sqsEvent);

    // Should return the failed message ID for retry
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-0");

    // Verify S3 write did NOT happen
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("throws error when Secrets Manager fails to retrieve API key", async () => {
    mockSecretsManagerSend.mockRejectedValueOnce(new Error("Secrets Manager unavailable"));

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr1is",
        title: "H.R. 1",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr1is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "1",
      },
    ]);

    await expect(handler(sqsEvent)).rejects.toThrow("Secrets Manager unavailable");
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("throws error when secret has no SecretString", async () => {
    mockSecretsManagerSend.mockResolvedValueOnce({
      SecretString: null,
    });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr1is",
        title: "H.R. 1",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr1is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "1",
      },
    ]);

    await expect(handler(sqsEvent)).rejects.toThrow("Secret value is empty");
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("throws error when congressApiKey is missing from secret", async () => {
    mockSecretsManagerSend.mockResolvedValueOnce({
      SecretString: JSON.stringify({ someOtherKey: "value" }),
    });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr1is",
        title: "H.R. 1",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr1is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "1",
      },
    ]);

    await expect(handler(sqsEvent)).rejects.toThrow("congressApiKey not found in secret");
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("handles XML fetch failure gracefully (still stores bill data without XML)", async () => {
    const congressApiResponse = {
      bill: {
        number: "600",
        type: "hr",
        congress: 119,
        title: "Test Bill",
      },
    };

    // Mock all endpoints succeeding
    for (let i = 0; i < 7; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(congressApiResponse),
      });
    }

    // Text endpoint with XML format available
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        textVersions: [
          {
            type: "Introduced in House",
            date: "2025-10-17T05:00:00Z",
            formats: [
              { type: "PDF", url: "https://example.com/bill.pdf" },
              { type: "Formatted XML", url: "https://example.com/bill.xml" },
            ],
          },
        ],
      }),
    });

    // XML fetch fails
    httpResponses.push({
      statusCode: 404,
      body: "Not Found",
    });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr600is",
        title: "H.R. 600",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr600is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "600",
      },
    ]);

    // Should not throw
    await handler(sqsEvent);

    // Should still store bill data without XML (guid key)
    expect(s3Puts()).toHaveLength(1);
    const putCommand = s3Puts()[0];
    const storedData = JSON.parse(putCommand.Body);

    expect(storedData.content).toBeDefined();
  });

  it("handles bill with no Formatted XML format available", async () => {
    const congressApiResponse = {
      bill: {
        number: "700",
        type: "s",
        congress: 119,
        title: "Test Bill",
      },
    };

    // Mock all endpoints succeeding
    for (let i = 0; i < 7; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(congressApiResponse),
      });
    }

    // Text endpoint with only PDF format (no XML)
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        textVersions: [
          {
            type: "Introduced in Senate",
            date: "2025-10-17T05:00:00Z",
            formats: [
              { type: "PDF", url: "https://example.com/bill.pdf" },
              { type: "HTML", url: "https://example.com/bill.html" },
            ],
          },
        ],
      }),
    });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119s700is",
        title: "S. 700",
        link: "https://www.govinfo.gov/app/details/BILLS-119s700is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "senate-bill",
        billNumber: "700",
      },
    ]);

    await handler(sqsEvent);

    expect(s3Puts()).toHaveLength(1);
    const putCommand = s3Puts()[0];
    const storedData = JSON.parse(putCommand.Body);

    expect(storedData.content).toBeDefined();
  });

  it("handles network errors during API calls", async () => {
    // Simulate a network error by having the mock emit an error event
    mockHttpsRequest.mockImplementationOnce(
      (_url: unknown, _optionsOrCallback?: unknown, _callback?: (res: FakeResponse) => void) => {
        const req = new EventEmitter() as FakeRequest;
        req.end = jest.fn(() => {
          req.emit("error", new Error("Network connection failed"));
        });
        req.on = req.on.bind(req);
        req.write = jest.fn();

        return req;
      },
    );

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr800is",
        title: "H.R. 800",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr800is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "800",
      },
    ]);

    // Network error on main bill endpoint causes failure
    const result = await handler(sqsEvent);

    // Should return the failed message ID for retry
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-0");
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("throws error when S3 storage fails", async () => {
    const congressApiResponse = {
      bill: {
        number: "900",
        type: "hr",
        congress: 119,
        title: "Test Bill",
      },
    };

    // Mock all API endpoints succeeding
    for (let i = 0; i < 8; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(i === 7 ? { textVersions: [] } : congressApiResponse),
      });
    }

    // Mock the S3 write failing (the read before it, REL-35, finds nothing)
    mockS3Send.mockImplementation((cmd: { __cmd?: string }) =>
      cmd.__cmd === "PutObject" ? Promise.reject(new Error("S3 bucket access denied")) : Promise.resolve({}),
    );

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr900is",
        title: "H.R. 900",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr900is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "900",
      },
    ]);

    const result = await handler(sqsEvent);

    // Should return the failed message ID for retry
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-0");
  });

  it("handles invalid JSON from Congress API", async () => {
    // Mock main bill endpoint returning invalid JSON
    httpResponses.push({
      statusCode: 200,
      body: "{ invalid json }",
    });

    const sqsEvent = createSQSEvent([
      {
        guid: "BILLS-119hr1000is",
        title: "H.R. 1000",
        link: "https://www.govinfo.gov/app/details/BILLS-119hr1000is",
        pubDate: "2025-01-01T12:00:00Z",
        congress: "119",
        billType: "house-bill",
        billNumber: "1000",
      },
    ]);

    const result = await handler(sqsEvent);

    // Should return the failed message ID for retry
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe("msg-0");
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe("fetchRawBill congress.gov resilience", () => {
  it("sets a socket timeout on every request from CONGRESS_API_REQUEST_TIMEOUT_MS (default 10 s) (REL-05)", async () => {
    pushSuccessfulBillResponses();

    await handler(singleBillEvent());

    expect(socketTimeoutsMs).toHaveLength(8);
    expect(new Set(socketTimeoutsMs)).toEqual(new Set([10000]));
  });

  it("retries a request whose socket stalls and stores the bill (REL-05)", async () => {
    httpResponses.push({ stall: true });
    pushSuccessfulBillResponses();

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(9);
    expect(s3Puts()).toHaveLength(1);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Congress API network error"),
        reason: expect.stringContaining("timed out after 10000ms"),
      }),
    );
  });

  it("fails the record once every attempt has timed out (REL-05)", async () => {
    httpResponses.push({ stall: true }, { stall: true }, { stall: true });

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(3);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("does not put the API key in the socket timeout error", async () => {
    httpResponses.push({ stall: true }, { stall: true }, { stall: true });

    await handler(singleBillEvent());

    const logged =
      JSON.stringify((console.warn as jest.Mock).mock.calls) + JSON.stringify((console.error as jest.Mock).mock.calls);
    expect(logged).toContain("timed out");
    expect(logged).not.toContain("test-api-key-123");
  });

  it("re-reads the API key and retries once when congress.gov returns 401 (REL-13)", async () => {
    mockSecretsManagerSend
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "old-key" }) })
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "new-key" }) });
    httpResponses.push({ statusCode: 401, body: "" });
    pushSuccessfulBillResponses();

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
    const urls = mockHttpsRequest.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0].searchParams.get("api_key")).toBe("old-key");
    expect(urls.slice(1).map((url) => url.searchParams.get("api_key"))).toEqual(Array(8).fill("new-key"));
    expect(metricDatums("CongressApiAuthFailure")).toEqual([]);
  });

  it("emits CongressApiAuthFailure and fails the record when the re-read key is also rejected (REL-13)", async () => {
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
    expect(metricDatums("CongressApiAuthFailure")).toEqual([
      { MetricName: "CongressApiAuthFailure", Unit: "Count", Value: 1 },
    ]);
  });

  it("emits CongressApi429 when congress.gov throttles", async () => {
    httpResponses.push({ statusCode: 429, body: "" });
    pushSuccessfulBillResponses();

    await handler(singleBillEvent());

    expect(metricDatums("CongressApi429")).toEqual([{ MetricName: "CongressApi429", Unit: "Count", Value: 1 }]);
  });

  it("handles bill XML network errors like 5xx: 3 attempts per source, then stored without text and not retried (REL-45)", async () => {
    for (let i = 0; i < 8; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify(
          i === 7
            ? {
                textVersions: [
                  {
                    formats: [
                      { type: "Formatted XML", url: "https://www.congress.gov/119/bills/hr77/BILLS-119hr77ih.xml" },
                    ],
                  },
                ],
              }
            : { bill: { number: "77", type: "hr", congress: 119 } },
        ),
      });
    }
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    httpResponses.push(...Array(6).fill({ error: reset }));

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    expect(mockHttpsRequest.mock.calls.slice(8).map(([url]) => String(url))).toEqual([
      ...Array(3).fill("https://www.govinfo.gov/content/pkg/BILLS-119hr77ih/xml/BILLS-119hr77ih.xml"),
      ...Array(3).fill("https://www.congress.gov/119/bills/hr77/BILLS-119hr77ih.xml"),
    ]);
    // A network error has no status: only the Source-only series, once per source.
    expect(metricDatums("BillXmlFetchFailure")).toEqual(
      ["GovInfo", "CongressGov"].map((source) => ({
        MetricName: "BillXmlFetchFailure",
        Dimensions: [{ Name: "Source", Value: source }],
        Unit: "Count",
        Value: 1,
      })),
    );
    expect(metricDatums("BillTextUnavailable").map((datum) => datum.Dimensions)).toEqual([
      undefined,
      [{ Name: "Reason", Value: "network" }],
    ]);
    expect(mockSqsSend.mock.calls.map(([cmd]) => cmd.input.QueueUrl)).not.toContain(TEXT_RETRY_QUEUE);
    expect(JSON.parse(s3Puts()[0].Body).content.billXML).toBeUndefined();
  });
});

describe("fetchRawBill cosponsor pagination (REL-28)", () => {
  const cosponsorPage = (start: number, size: number, total: number, next?: string) => ({
    cosponsors: Array.from({ length: size }, (_, i) => ({ bioguideId: `C${String(start + i).padStart(6, "0")}` })),
    pagination: { count: total, ...(next ? { next } : {}) },
    request: { contentType: "application/json", format: "json" },
  });

  // bill, actions, subjects, titles, then the given cosponsor pages, then committees, relatedBills, text.
  const pushBillResponsesWithCosponsorPages = (pages: Array<Record<string, unknown>>) => {
    for (let i = 0; i < 4; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify({ bill: { number: "77", type: "hr", congress: 119 } }),
      });
    }
    for (const page of pages) {
      httpResponses.push({ statusCode: 200, body: JSON.stringify(page) });
    }
    httpResponses.push(
      { statusCode: 200, body: JSON.stringify({ committees: [] }) },
      { statusCode: 200, body: JSON.stringify({ relatedBills: [] }) },
      { statusCode: 200, body: JSON.stringify({ textVersions: [] }) },
    );
  };

  const requestedUrls = () => mockHttpsRequest.mock.calls.map(([url]) => new URL(String(url)));
  const cosponsorRequests = () => requestedUrls().filter((url) => url.pathname.endsWith("/cosponsors"));
  const storedRawBill = () => JSON.parse(s3Puts()[0].Body);

  it("requests 250 cosponsors per page and merges every page into content.cosponsors", async () => {
    // pagination.next points elsewhere on purpose: the handler builds its own offset URL instead.
    pushBillResponsesWithCosponsorPages([
      cosponsorPage(0, 250, 312, "https://attacker.example/v3/bill/119/hr/77/cosponsors?offset=250&limit=250"),
      cosponsorPage(250, 62, 312),
    ]);

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    const pages = cosponsorRequests();
    expect(pages).toHaveLength(2);
    expect(pages.map((url) => [url.searchParams.get("limit"), url.searchParams.get("offset")])).toEqual([
      ["250", null],
      ["250", "250"],
    ]);
    expect(new Set(requestedUrls().map((url) => url.host))).toEqual(new Set(["api.congress.gov"]));

    const stored = storedRawBill().content.cosponsors;
    expect(stored.cosponsors).toHaveLength(312);
    expect(stored.cosponsors[0]).toEqual({ bioguideId: "C000000" });
    expect(stored.cosponsors[311]).toEqual({ bioguideId: "C000311" });
    expect(stored.pagination).toEqual({ count: 312 });
    expect(stored.request).toEqual({ contentType: "application/json", format: "json" });
    expect(metricDatums("CongressApiCallsCore")).toEqual([expect.objectContaining({ Value: 9 })]);
  });

  it("makes one cosponsor request and stores the response unchanged when there is no next page", async () => {
    const onlyPage = cosponsorPage(0, 3, 3);
    pushBillResponsesWithCosponsorPages([onlyPage]);

    await handler(singleBillEvent());

    expect(cosponsorRequests()).toHaveLength(1);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(8);
    expect(storedRawBill().content.cosponsors).toEqual(onlyPage);
    expect(metricDatums("CongressApiCallsCore")).toEqual([expect.objectContaining({ Value: 8 })]);
  });

  it("stops after four pages when congress.gov keeps reporting a next page", async () => {
    const next = "https://api.congress.gov/v3/bill/119/hr/77/cosponsors?offset=0";
    pushBillResponsesWithCosponsorPages([
      cosponsorPage(0, 250, 2000, next),
      cosponsorPage(250, 250, 2000, next),
      cosponsorPage(500, 250, 2000, next),
      cosponsorPage(750, 250, 2000, next),
    ]);

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    expect(cosponsorRequests().map((url) => url.searchParams.get("offset"))).toEqual([null, "250", "500", "750"]);
    expect(storedRawBill().content.cosponsors.cosponsors).toHaveLength(1000);
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Stopped reading cosponsors after 4 pages (1000 cosponsors)"),
      }),
    );
  });

  it("stops when a page has no cosponsors even if it reports a next page", async () => {
    const next = "https://api.congress.gov/v3/bill/119/hr/77/cosponsors?offset=250";
    pushBillResponsesWithCosponsorPages([cosponsorPage(0, 250, 400, next), cosponsorPage(250, 0, 400, next)]);

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    expect(cosponsorRequests()).toHaveLength(2);
    expect(storedRawBill().content.cosponsors.cosponsors).toHaveLength(250);
  });

  it("fails the record without storing a partial cosponsor list when a later page fails", async () => {
    for (let i = 0; i < 4; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify({ bill: { number: "77", type: "hr", congress: 119 } }),
      });
    }
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify(
        cosponsorPage(0, 250, 300, "https://api.congress.gov/v3/bill/119/hr/77/cosponsors?offset=250"),
      ),
    });
    httpResponses.push({ statusCode: 404, body: "" });

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(cosponsorRequests()).toHaveLength(2);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(logLines(console.error)).toContainEqual(
      expect.objectContaining({
        message: "Failed to fetch cosponsors after all retries",
        endpoint: "cosponsors",
        error: expect.objectContaining({ message: expect.stringContaining("status 404") }),
      }),
    );
  });
});

describe("fetchRawBill related bills (APPF-23)", () => {
  const relatedItem = (number: string, relationship: string, type = "S", congress: number | string = 119) => ({
    congress,
    type,
    number,
    title: `Related ${type} ${number}`,
    relationshipDetails: [{ type: relationship, identifiedBy: "CRS" }],
    url: `https://api.congress.gov/v3/bill/${congress}/${type.toLowerCase()}/${number}?format=json`,
  });
  const relatedPage = (items: Array<Record<string, unknown>>, next?: string, count = items.length) => ({
    relatedBills: items,
    pagination: { count, ...(next ? { next } : {}) },
    request: { contentType: "application/json", format: "json" },
  });
  const NEXT = "https://api.congress.gov/v3/bill/119/hr/77/relatedbills?offset=250&limit=250&format=json";

  // bill, actions, subjects, titles, cosponsors, committees, then the relatedbills pages, then text.
  const pushBillResponsesWithRelatedPages = (pages: Array<Record<string, unknown>>) => {
    for (let i = 0; i < 4; i++) {
      httpResponses.push({
        statusCode: 200,
        body: JSON.stringify({ bill: { number: "77", type: "hr", congress: 119 } }),
      });
    }
    httpResponses.push(
      { statusCode: 200, body: JSON.stringify({ cosponsors: [] }) },
      { statusCode: 200, body: JSON.stringify({ committees: [] }) },
    );
    for (const page of pages) httpResponses.push({ statusCode: 200, body: JSON.stringify(page) });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ textVersions: [] }) });
  };

  const requestedUrls = () => mockHttpsRequest.mock.calls.map(([url]) => new URL(String(url)));
  const relatedRequests = () => requestedUrls().filter((url) => url.pathname.endsWith("/relatedbills"));
  const storedRelatedBills = () => JSON.parse(s3Puts()[0].Body).content.relatedBills;
  const truncationWarnings = () =>
    logLines(console.warn).filter((line) => String(line.message).startsWith("relatedbills still reports a next page"));

  it("asks for 250 rows and stores a single page unchanged, without a warning (acceptance 13)", async () => {
    const onlyPage = relatedPage([relatedItem("570", "Identical bill")], undefined, 40);
    pushBillResponsesWithRelatedPages([onlyPage]);

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    expect(relatedRequests().map((url) => url.searchParams.get("limit"))).toEqual(["250"]);
    // count above the item count is not truncation.
    expect(storedRelatedBills()).toEqual(onlyPage);
    expect(truncationWarnings()).toEqual([]);
    expect(metricDatums("RelatedBillsTruncated")).toEqual([]);
  });

  it("follows pagination.next on api.congress.gov with our key and merges items by congress, type and number", async () => {
    pushBillResponsesWithRelatedPages([
      relatedPage([relatedItem("570", "Identical bill"), relatedItem("1", "Related bill", "HR")], NEXT, 23),
      relatedPage([
        relatedItem("570", "Related bill"),
        relatedItem("570", "Identical bill"),
        relatedItem("9", "Procedurally related", "HR"),
      ]),
    ]);

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    const pages = relatedRequests();
    expect(pages).toHaveLength(2);
    expect(pages[1].searchParams.get("offset")).toBe("250");
    expect(pages[1].searchParams.get("api_key")).toBe("test-api-key-123");
    expect(new Set(requestedUrls().map((url) => url.host))).toEqual(new Set(["api.congress.gov"]));

    const stored = storedRelatedBills();
    expect(stored.pagination).toEqual({ count: 23 });
    expect(stored.relatedBills.map((entry: { type: string; number: string }) => [entry.type, entry.number])).toEqual([
      ["S", "570"],
      ["HR", "1"],
      ["HR", "9"],
    ]);
    expect(stored.relatedBills[0].relationshipDetails).toEqual([
      { type: "Identical bill", identifiedBy: "CRS" },
      { type: "Related bill", identifiedBy: "CRS" },
    ]);
    expect(truncationWarnings()).toEqual([]);
    expect(metricDatums("CongressApiCallsCore")).toEqual([expect.objectContaining({ Value: 9 })]);
  });

  it("stops after 3 extra pages, warns and counts RelatedBillsTruncated, and keeps next in the stored pagination", async () => {
    pushBillResponsesWithRelatedPages([
      relatedPage([relatedItem("1", "Related bill")], NEXT, 90),
      relatedPage([relatedItem("2", "Related bill")], NEXT.replace("offset=250", "offset=500")),
      relatedPage([relatedItem("3", "Related bill")], NEXT.replace("offset=250", "offset=750")),
      relatedPage([relatedItem("4", "Related bill")], NEXT.replace("offset=250", "offset=1000")),
    ]);

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    expect(relatedRequests().map((url) => url.searchParams.get("offset"))).toEqual([null, "250", "500", "750"]);
    const stored = storedRelatedBills();
    expect(stored.relatedBills).toHaveLength(4);
    expect(stored.pagination).toEqual({ count: 90, next: NEXT.replace("offset=250", "offset=1000") });
    expect(truncationWarnings()).toEqual([
      expect.objectContaining({ level: "WARN", pagesRead: 4, relatedBills: 4, guid: "BILLS-119hr77" }),
    ]);
    expect(metricDatums("RelatedBillsTruncated")).toEqual([
      { MetricName: "RelatedBillsTruncated", Unit: "Count", Value: 1 },
    ]);
  });

  it.each([
    ["another host", "https://attacker.example/v3/bill/119/hr/77/relatedbills?offset=250"],
    ["a look-alike host", "https://api.congress.gov.attacker.example/v3/bill/119/hr/77/relatedbills?offset=250"],
    ["another port", "https://api.congress.gov:8443/v3/bill/119/hr/77/relatedbills?offset=250"],
    ["plain http", "http://api.congress.gov/v3/bill/119/hr/77/relatedbills?offset=250"],
    ["another path", "https://api.congress.gov/v3/bill/119/hr/77/cosponsors?offset=250"],
    ["another bill", "https://api.congress.gov/v3/bill/119/hr/78/relatedbills?offset=250"],
    ["credentials", "https://user:pw@api.congress.gov/v3/bill/119/hr/77/relatedbills?offset=250"],
    ["not a URL", "offset=250"],
  ])("never follows a next page on %s, and flags the list as truncated", async (_label, next) => {
    const firstPage = relatedPage([relatedItem("570", "Identical bill")], next, 30);
    pushBillResponsesWithRelatedPages([firstPage]);

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([]);
    expect(relatedRequests()).toHaveLength(1);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(8);
    expect(new Set(requestedUrls().map((url) => url.host))).toEqual(new Set(["api.congress.gov"]));
    expect(storedRelatedBills()).toEqual(firstPage);
    expect(truncationWarnings()).toHaveLength(1);
    expect(metricDatums("RelatedBillsTruncated")).toHaveLength(1);
  });

  it("drops an api_key carried by pagination.next and sends only our key", async () => {
    pushBillResponsesWithRelatedPages([
      relatedPage([relatedItem("570", "Identical bill")], `${NEXT}&api_key=someone-elses-key#fragment`),
      relatedPage([relatedItem("571", "Identical bill")]),
    ]);

    await handler(singleBillEvent());

    const second = relatedRequests()[1];
    expect(second.searchParams.getAll("api_key")).toEqual(["test-api-key-123"]);
    expect(second.hash).toBe("");
    expect(JSON.stringify(logLines(console.warn))).not.toContain("someone-elses-key");
    expect(JSON.stringify(logLines(console.log))).not.toContain("test-api-key-123");
  });

  it("stops at an empty page and counts the list as truncated when next is still reported", async () => {
    pushBillResponsesWithRelatedPages([
      relatedPage([relatedItem("570", "Identical bill")], NEXT),
      relatedPage([], NEXT.replace("offset=250", "offset=500")),
    ]);

    await handler(singleBillEvent());

    expect(relatedRequests()).toHaveLength(2);
    expect(storedRelatedBills().relatedBills).toHaveLength(1);
    expect(metricDatums("RelatedBillsTruncated")).toHaveLength(1);
  });

  it("fails the record without storing when a later relatedbills page fails", async () => {
    pushBillResponsesWithRelatedPages([relatedPage([relatedItem("570", "Identical bill")], NEXT)]);
    httpResponses.splice(httpResponses.length - 1, 1, { statusCode: 404, body: "" });

    const result = await handler(singleBillEvent());

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe("fetchRawBill correlation id (OBS-10)", () => {
  const withCorrelationId = (event: SQSEvent, correlationId: string): SQSEvent => ({
    Records: event.Records.map((record) => ({
      ...record,
      messageAttributes: { correlationId: { dataType: "String", stringValue: correlationId } },
    })),
  });

  const pushHouseVoteBillResponses = () => {
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ bill: { number: "77", type: "hr", congress: 119, title: "Test" } }),
    });
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        actions: [
          {
            actionCode: "8000",
            actionDate: "2026-02-01",
            text: "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 123).",
          },
        ],
      }),
    });
    for (const body of [
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

  it("passes the record's correlation id to both queues and the raw bill's S3 metadata, and logs it", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
        VOTE_ENRICHMENT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment",
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    const voteHandler = require("../handlers/fetchRawBill").handler as (
      event: SQSEvent,
      context?: unknown,
    ) => HandlerReturn;
    pushHouseVoteBillResponses();
    const correlationId = "2026-03-01T12:00:00.000Z:BILLS-119hr77ih";

    await voteHandler(withCorrelationId(singleBillEvent(), correlationId), { awsRequestId: "req-7" });

    expect(s3Puts()[0].Metadata).toEqual({ "correlation-id": correlationId });
    const sends = mockSqsSend.mock.calls.map(([cmd]) => cmd.input);
    expect(sends.map((input) => input.QueueUrl)).toEqual([
      "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
      "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment",
    ]);
    for (const input of sends) {
      expect(input.Entries).toEqual([
        expect.objectContaining({
          MessageBody: JSON.stringify({ guid: "BILLS-119hr77" }),
          MessageAttributes: { correlationId: { DataType: "String", StringValue: correlationId } },
        }),
      ]);
    }
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Successfully processed bill",
        guid: "BILLS-119hr77",
        correlationId,
        sqsMessageId: "msg-0",
        awsRequestId: "req-7",
        service: "billboard-services",
      }),
    );
  });

  it("mints <time>:<guid> when the record carries none", async () => {
    pushSuccessfulBillResponses();

    await handler(singleBillEvent());

    const minted = mockSqsSend.mock.calls[0][0].input.Entries[0].MessageAttributes.correlationId.StringValue;
    expect(minted).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z:BILLS-119hr77$/);
    expect(s3Puts()[0].Metadata).toEqual({ "correlation-id": minted });
  });

  // The U9b cosponsor backfill sent an older raw bill's metadata.guid, with its text-version suffix and no correlation id.
  it("stores and sends a suffixed message guid without its suffix, and warns", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
        VOTE_ENRICHMENT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment",
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    const voteHandler = require("../handlers/fetchRawBill").handler as (event: SQSEvent) => HandlerReturn;
    pushHouseVoteBillResponses();
    const event = createSQSEvent([{ guid: "BILLS-119hr1181rh", title: "", pubDate: "" }]);
    event.Records[0].body = JSON.stringify({
      guid: "BILLS-119hr1181rh",
      congress: "119",
      billType: "house-bill",
      billNumber: "1181",
    });

    const result = await voteHandler(event);

    expect(result.batchItemFailures).toEqual([]);
    const put = s3Puts()[0];
    expect(put.Key).toBe("raw-bills/BILLS-119hr1181.json");
    expect(JSON.parse(put.Body).metadata.guid).toBe("BILLS-119hr1181");
    const sends = mockSqsSend.mock.calls.map(([cmd]) => cmd.input);
    expect(sends).toHaveLength(2);
    for (const input of sends) {
      expect(input.Entries.map((entry: { MessageBody: string }) => JSON.parse(entry.MessageBody))).toEqual([
        { guid: "BILLS-119hr1181" },
      ]);
    }
    expect(sends[0].Entries[0].MessageAttributes.correlationId.StringValue).toMatch(/:BILLS-119hr1181$/);
    expect(put.Metadata).toEqual({ "correlation-id": sends[0].Entries[0].MessageAttributes.correlationId.StringValue });
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        message: "Dropped the text-version suffix from the message guid",
        received: "BILLS-119hr1181rh",
        guid: "BILLS-119hr1181",
      }),
    );
  });
});

describe("fetchRawBill unprocessable messages (C1.8)", () => {
  const DROP_LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";
  const dropLines = () => logLines(console.warn).filter((line) => line.message === DROP_LOG_MESSAGE);
  const dropMetrics = () => logLines(console.log).filter((line) => line._aws && "MessagesUnprocessable" in line);
  const unparseableItem = {
    guid: "invalid-item",
    title: "Invalid Item",
    link: "https://example.com/not-a-bill",
    pubDate: "2025-01-01T12:00:00Z",
  };
  const noIdItem = { guid: "no-id-item", title: "No id", pubDate: "2025-01-01T12:00:00Z" };

  it("acknowledges, logs and counts a feed item it cannot identify, and calls nothing", async () => {
    const result = await handler(createSQSEvent([unparseableItem, noIdItem]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(dropLines()).toEqual([
      expect.objectContaining({
        level: "WARN",
        dropSite: "fetchRawBill.unidentifiedBill",
        reason: "unparseable_link",
        messageId: "msg-0",
        sqsMessageId: "msg-0",
        guid: "invalid-item",
        link: "https://example.com/not-a-bill",
        messageContent: unparseableItem,
      }),
      expect.objectContaining({
        dropSite: "fetchRawBill.unidentifiedBill",
        reason: "no_bill_id",
        messageId: "msg-1",
        guid: "no-id-item",
        messageContent: noIdItem,
      }),
    ]);
    expect(dropMetrics().map((line) => [line.sqsMessageId, line.MessagesUnprocessable, line.dropSite])).toEqual([
      ["msg-0", 1, "fetchRawBill.unidentifiedBill"],
      ["msg-1", 1, "fetchRawBill.unidentifiedBill"],
    ]);
  });

  it("counts only the unidentified item of a batch and stores and enqueues the other as before", async () => {
    pushSuccessfulBillResponses();
    const good = singleBillEvent().Records[0];
    const event = createSQSEvent([unparseableItem]);
    event.Records.push({ ...good, messageId: "msg-1" });

    const result = await handler(event);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(s3Puts()).toHaveLength(1);
    expect(
      mockSqsSend.mock.calls.map(([cmd]) =>
        cmd.input.Entries.map((entry: { MessageBody: string }) => entry.MessageBody),
      ),
    ).toEqual([
      // Sent without its text-version suffix (REL-41).
      [JSON.stringify({ guid: "BILLS-119hr77" })],
    ]);
    expect(dropLines().map((line) => line.messageId)).toEqual(["msg-0"]);
    expect(dropMetrics()).toHaveLength(1);
  });

  it("counts nothing for an item it identifies", async () => {
    pushSuccessfulBillResponses();

    const result = await handler(singleBillEvent());

    expect(result).toEqual({ batchItemFailures: [] });
    expect(dropLines()).toEqual([]);
    expect(dropMetrics()).toEqual([]);
  });

  it("still fails a record whose body is not JSON (retried as today, not counted)", async () => {
    const event = createSQSEvent([unparseableItem]);
    event.Records[0].body = "not json";

    const result = await handler(event);

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-0" }] });
    expect(dropMetrics()).toEqual([]);
  });

  it("still acknowledges the item when the drop's log and metric lines throw", async () => {
    (console.warn as jest.Mock).mockImplementation((line: unknown) => {
      if (String(line).includes(DROP_LOG_MESSAGE)) throw new Error("console.warn broke");
    });
    (console.log as jest.Mock).mockImplementation((line: unknown) => {
      if (String(line).includes('"MessagesUnprocessable"')) throw new Error("console.log broke");
    });

    const result = await handler(createSQSEvent([unparseableItem]));

    expect(result).toEqual({ batchItemFailures: [] });
    const attempts = (spy: unknown, needle: string) =>
      (spy as jest.Mock).mock.calls.filter(([line]) => String(line).includes(needle)).length;
    expect(attempts(console.warn, DROP_LOG_MESSAGE)).toBe(1);
    expect(attempts(console.log, '"MessagesUnprocessable"')).toBe(1);
  });
});

describe("fetchRawBill member votes on refetch (REL-35, X7 MEMBER_VOTE_CARRY_MODE)", () => {
  const RAW_KEY = "raw-bills/BILLS-119hr77.json";
  const DIFFER_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue";
  const ENRICHMENT_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment";
  const PREVIOUS_SYNC = "2026-02-02T10:00:00.000Z";
  const PASSAGE = {
    actionCode: "8000",
    actionDate: "2026-02-01",
    text: "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 123).",
  };
  const SENATE_PASSAGE = {
    actionCode: "17000",
    actionDate: "2026-02-05",
    voteNumber: "44",
    text: "Passed Senate, Yea-Nay Vote. 55 - 40. Record Vote Number: 44.",
  };
  const MEMBERS = [
    { bioguideId: "A000001", displayName: "Rep. A", party: "D", state: "CA", votePosition: "Yea" },
    { bioguideId: "B000002", displayName: "Rep. B", party: "R", state: "TX", votePosition: "Nay" },
  ];

  type Chamber = Record<string, unknown>;
  // The House vote fetchRawBill builds from PASSAGE (no members).
  const fetchedHouse = (overrides: Chamber = {}): Chamber => ({
    yea: 220,
    nay: 210,
    present: 0,
    notVoting: 0,
    totalCounted: 430,
    actionCode: "8000",
    actionDate: "2026-02-01",
    resultText: PASSAGE.text,
    memberDataAvailable: false,
    members: [],
    ...overrides,
  });
  // The same House vote after enrichOfficialVotes attached its members.
  const enrichedHouse = (overrides: Chamber = {}): Chamber =>
    fetchedHouse({ memberDataAvailable: true, members: MEMBERS, ...overrides });
  // A Senate vote enrichOfficialVotes rebuilt from the roll-call XML: the tallies differ from the action's.
  const enrichedSenate = (overrides: Chamber = {}): Chamber => ({
    yea: 55,
    nay: 40,
    present: 0,
    notVoting: 5,
    totalCounted: 100,
    actionCode: "17000",
    actionDate: "2026-02-05",
    resultText: SENATE_PASSAGE.text,
    memberDataAvailable: true,
    members: [{ bioguideId: "S000003", displayName: "Sen. C", votePosition: "Yea" }],
    ...overrides,
  });

  const previousRawBill = (chambers: Record<string, Chamber>, actions: unknown[] = [PASSAGE]) => ({
    schemaVersion: 1,
    kind: "raw",
    storedAt: PREVIOUS_SYNC,
    identifier: { congress: "119", billType: "hr", billNumber: "77" },
    metadata: {
      guid: "BILLS-119hr77ih",
      title: "H.R. 77",
      pubDate: "2026-03-01T12:00:00Z",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/hr/77",
      fetchedAt: "2026-02-02T09:00:00.000Z",
    },
    content: {
      bill: { number: "77", type: "hr", congress: 119, title: "Test" },
      actions: { actions },
      officialVotes: { ...chambers, lastSyncedAt: PREVIOUS_SYNC, source: "congress_api", completeness: "complete" },
    },
  });

  const pushVotedBillResponses = (actions: unknown[] = [PASSAGE]) => {
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ bill: { number: "77", type: "hr", congress: 119, title: "Test" } }),
    });
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ actions }) });
    for (const body of [
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

  let fake: FakeVersionedS3;

  beforeEach(() => {
    fake = new FakeVersionedS3("2026-02-02T09:00:00.000Z");
    mockS3Send.mockImplementation((cmd) => fake.send(cmd));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** The handler loaded with MEMBER_VOTE_CARRY_MODE = mode (unset when undefined) and an enrichment queue. */
  const loadHandler = (mode: string | undefined) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: DIFFER_QUEUE,
        VOTE_ENRICHMENT_QUEUE_URL: ENRICHMENT_QUEUE,
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
        MEMBER_VOTE_CARRY_MODE: mode,
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    return require("../handlers/fetchRawBill").handler as (event: SQSEvent) => HandlerReturn;
  };

  const storedRaw = () => fake.json<StoredRaw>(RAW_KEY)!;
  const queueUrlsSent = () => mockSqsSend.mock.calls.map(([cmd]) => cmd.input.QueueUrl);
  const metricValues = (name: string) => metricDatums(name).map((datum) => datum.Value);
  const carryLines = () => logLines(console.log).filter((line) => line.message === "Member vote carry decision");
  const processedLine = () =>
    logLines(console.log).find((line) => line.message === "Successfully processed bill") ?? {};
  const refusedWriteError = (status: number) =>
    Object.assign(new Error("We encountered an internal error. Please try again."), {
      name: "InternalError",
      $metadata: { httpStatusCode: status },
    });

  describe('"on"', () => {
    it("keeps the previous members and lastSyncedAt for the same roll call, writes over the ETag it read, and queues no enrichment", async () => {
      fake.put(RAW_KEY, previousRawBill({ house: enrichedHouse() }));
      const readEtag = fake.current(RAW_KEY)!.etag;
      const handler = loadHandler("on");
      pushVotedBillResponses();

      const result = await handler(singleBillEvent());

      expect(result.batchItemFailures).toEqual([]);
      expect(s3Inputs("GetObject")).toEqual([{ Bucket: "test-raw-bills-bucket", Key: RAW_KEY }]);
      expect(s3Puts()).toHaveLength(1);
      expect(s3Puts()[0].IfMatch).toBe(readEtag);
      const votes = storedRaw().content.officialVotes!;
      expect(votes.house).toEqual(enrichedHouse());
      expect(votes.lastSyncedAt).toBe(PREVIOUS_SYNC);
      expect(votes.completeness).toBe("complete");
      expect(storedRaw().metadata.fetchedAt).not.toBe("2026-02-02T09:00:00.000Z");
      expect(queueUrlsSent()).toEqual([DIFFER_QUEUE]);
      expect(metricValues("MemberVotesCarried")).toEqual([1]);
      expect(metricValues("MemberVotesCarriable")).toEqual([]);
      expect(carryLines()).toEqual([
        expect.objectContaining({
          event: "member_vote_carry",
          memberVoteCarryMode: "on",
          outcome: "carried",
          carriedChambers: ["house"],
          lastSyncedAtKept: true,
          previousVersionId: "v0001",
          previousFetchedAt: "2026-02-02T09:00:00.000Z",
          attempt: 1,
          chambers: {
            house: {
              outcome: "carried",
              previous: { actionCode: "8000", actionDate: "2026-02-01", yea: 220, nay: 210, members: 2 },
              fetched: { actionCode: "8000", actionDate: "2026-02-01", yea: 220, nay: 210, members: 0 },
            },
          },
        }),
      ]);
      expect(processedLine()).toMatchObject({ completeness: "complete", needsVoteEnrichment: false });
    });

    it("keeps a carried Senate vote whole, including the tallies enrichment read from the roll-call XML", async () => {
      fake.put(RAW_KEY, previousRawBill({ senate: enrichedSenate() }, [SENATE_PASSAGE]));
      const handler = loadHandler("on");
      pushVotedBillResponses([SENATE_PASSAGE]);

      await handler(singleBillEvent());

      expect(storedRaw().content.officialVotes!.senate).toEqual(enrichedSenate());
      expect(storedRaw().content.officialVotes!.lastSyncedAt).toBe(PREVIOUS_SYNC);
      expect(queueUrlsSent()).toEqual([DIFFER_QUEUE]);
      expect(metricValues("MemberVotesCarried")).toEqual([1]);
    });

    it("keeps neither members nor lastSyncedAt for a new roll call, and queues enrichment", async () => {
      const earlierVote = enrichedHouse({ actionDate: "2026-01-15", yea: 200, nay: 230, totalCounted: 430 });
      fake.put(RAW_KEY, previousRawBill({ house: earlierVote }));
      const readEtag = fake.current(RAW_KEY)!.etag;
      const handler = loadHandler("on");
      pushVotedBillResponses();

      await handler(singleBillEvent());

      expect(s3Puts()[0].IfMatch).toBe(readEtag);
      const votes = storedRaw().content.officialVotes!;
      expect(votes.house).toEqual(fetchedHouse());
      expect(votes.lastSyncedAt).not.toBe(PREVIOUS_SYNC);
      expect(votes.completeness).toBe("partial");
      expect(queueUrlsSent()).toEqual([DIFFER_QUEUE, ENRICHMENT_QUEUE]);
      expect(metricValues("MemberVotesCarried")).toEqual([]);
      expect(carryLines()).toEqual([
        expect.objectContaining({
          outcome: "none",
          carriedChambers: [],
          lastSyncedAtKept: false,
          chambers: { house: expect.objectContaining({ outcome: "new_roll_call" }) },
        }),
      ]);
    });

    it("decides per chamber: carries the House and leaves a Senate re-vote to enrichment", async () => {
      const olderSenate = enrichedSenate({ yea: 51, nay: 49, notVoting: 0, totalCounted: 100 });
      fake.put(RAW_KEY, previousRawBill({ house: enrichedHouse(), senate: olderSenate }, [PASSAGE, SENATE_PASSAGE]));
      const handler = loadHandler("on");
      pushVotedBillResponses([PASSAGE, SENATE_PASSAGE]);

      await handler(singleBillEvent());

      const votes = storedRaw().content.officialVotes!;
      expect(votes.house).toEqual(enrichedHouse());
      expect(votes.senate).toMatchObject({ yea: 55, nay: 40, members: [], memberDataAvailable: false });
      expect(votes.lastSyncedAt).not.toBe(PREVIOUS_SYNC);
      expect(votes.completeness).toBe("partial");
      // The bill is queued for its Senate vote; enrichOfficialVotes skips the House, which is complete.
      expect(queueUrlsSent()).toEqual([DIFFER_QUEUE, ENRICHMENT_QUEUE]);
      expect(metricValues("MemberVotesCarried")).toEqual([1]);
      expect(carryLines()[0].chambers).toEqual({
        house: expect.objectContaining({ outcome: "carried" }),
        senate: expect.objectContaining({ outcome: "new_roll_call" }),
      });
    });

    it("re-reads, re-decides and retries when enrichment writes between its read and its write", async () => {
      fake.put(RAW_KEY, previousRawBill({ house: fetchedHouse() }));
      const firstEtag = fake.current(RAW_KEY)!.etag;
      // enrichOfficialVotes lands its members after the refetch read the raw bill.
      fake.beforePut(RAW_KEY, () => {
        fake.put(RAW_KEY, previousRawBill({ house: enrichedHouse() }));
      });
      const handler = loadHandler("on");
      pushVotedBillResponses();

      const result = await handler(singleBillEvent());

      expect(result.batchItemFailures).toEqual([]);
      expect(s3Inputs("GetObject")).toHaveLength(2);
      expect(s3Puts().map((put) => put.IfMatch)).toEqual([firstEtag, fake.contentVersions(RAW_KEY)[1].etag]);
      expect(storedRaw().content.officialVotes!.house).toEqual(enrichedHouse());
      expect(metricValues("RawBillWriteConflict")).toEqual([1]);
      expect(metricValues("MemberVotesCarried")).toEqual([1]);
      expect(queueUrlsSent()).toEqual([DIFFER_QUEUE]);
      expect(carryLines()).toEqual([expect.objectContaining({ outcome: "carried", attempt: 2 })]);
      expect(logLines(console.warn)).toContainEqual(
        expect.objectContaining({
          message: "The raw bill changed between its read and the refetch's write",
          attempt: 1,
        }),
      );
    });

    it("fails the record after 3 refused writes, storing and sending nothing", async () => {
      fake.put(RAW_KEY, previousRawBill({ house: enrichedHouse() }));
      fake.injectPutError(RAW_KEY, 412);
      fake.injectPutError(RAW_KEY, 409);
      fake.injectPutError(RAW_KEY, 412);
      const handler = loadHandler("on");
      pushVotedBillResponses();

      const result = await handler(singleBillEvent());

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
      expect(s3Inputs("GetObject")).toHaveLength(3);
      expect(s3Puts()).toHaveLength(3);
      expect(fake.contentVersions(RAW_KEY)).toHaveLength(1);
      expect(mockSqsSend).not.toHaveBeenCalled();
      expect(metricValues("RawBillWriteConflict")).toEqual([1, 1, 1]);
      expect(metricValues("MemberVotesCarried")).toEqual([]);
      expect(carryLines()).toEqual([]);
    });

    it("does not retry a write that fails for another reason", async () => {
      fake.put(RAW_KEY, previousRawBill({ house: enrichedHouse() }));
      fake.injectPutError(RAW_KEY, 500);
      const handler = loadHandler("on");
      pushVotedBillResponses();

      const result = await handler(singleBillEvent());

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
      expect(s3Puts()).toHaveLength(1);
      expect(metricValues("RawBillWriteConflict")).toEqual([]);
    });

    it("stores a brand-new bill without a condition and queues its enrichment as before", async () => {
      const handler = loadHandler("on");
      pushVotedBillResponses();

      await handler(singleBillEvent());

      expect(s3Inputs("GetObject")).toHaveLength(1);
      expect(s3Puts()).toHaveLength(1);
      expect(s3Puts()[0]).not.toHaveProperty("IfMatch");
      expect(s3Puts()[0]).not.toHaveProperty("IfNoneMatch");
      expect(storedRaw().content.officialVotes!.house).toEqual(fetchedHouse());
      expect(queueUrlsSent()).toEqual([DIFFER_QUEUE, ENRICHMENT_QUEUE]);
      expect(carryLines()).toEqual([]);
      expect(metricValues("MemberVotesCarried")).toEqual([]);
    });

    it("keeps lastSyncedAt for an unchanged vote that has no members yet, and still queues its enrichment", async () => {
      fake.put(RAW_KEY, previousRawBill({ house: fetchedHouse() }));
      const handler = loadHandler("on");
      pushVotedBillResponses();

      await handler(singleBillEvent());

      expect(storedRaw().content.officialVotes).toMatchObject({
        house: fetchedHouse(),
        lastSyncedAt: PREVIOUS_SYNC,
        completeness: "partial",
      });
      expect(queueUrlsSent()).toEqual([DIFFER_QUEUE, ENRICHMENT_QUEUE]);
      // Nothing to decide about members, so no decision line.
      expect(carryLines()).toEqual([]);
    });

    it("fails the record, storing nothing, when the previous raw bill cannot be read", async () => {
      mockS3Send.mockImplementation((cmd) =>
        cmd.__cmd === "GetObject" ? Promise.reject(refusedWriteError(500)) : fake.send(cmd),
      );
      const handler = loadHandler("on");
      pushVotedBillResponses();

      const result = await handler(singleBillEvent());

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
      expect(s3Puts()).toEqual([]);
      expect(mockSqsSend).not.toHaveBeenCalled();
    });

    it("replaces a stored object that is not JSON without a condition", async () => {
      fake.put(RAW_KEY, "{not json");
      const handler = loadHandler("on");
      pushVotedBillResponses();

      const result = await handler(singleBillEvent());

      expect(result.batchItemFailures).toEqual([]);
      expect(s3Puts()).toHaveLength(1);
      expect(s3Puts()[0]).not.toHaveProperty("IfMatch");
      expect(storedRaw().content.officialVotes!.house).toEqual(fetchedHouse());
      expect(logLines(console.warn)).toContainEqual(
        expect.objectContaining({ event: "member_vote_carry", outcome: "previous_unreadable" }),
      );
    });

    it("stores no votes when the fetch has none, whatever the previous raw bill held", async () => {
      fake.put(RAW_KEY, previousRawBill({ house: enrichedHouse() }));
      const handler = loadHandler("on");
      pushVotedBillResponses([{ actionCode: "Intro-H", actionDate: "2026-01-10", text: "Introduced in House" }]);

      await handler(singleBillEvent());

      expect(storedRaw().content).not.toHaveProperty("officialVotes");
      expect(queueUrlsSent()).toEqual([DIFFER_QUEUE]);
      expect(carryLines()).toEqual([
        expect.objectContaining({
          outcome: "none",
          chambers: { house: expect.objectContaining({ outcome: "no_fetched_vote" }) },
        }),
      ]);
    });
  });

  describe('"watch", the shipped mode', () => {
    /** Runs one refetch of BILLS-119hr77ih against a fresh bucket holding `previous` (none when undefined). */
    const refetchOnce = async (
      handler: (event: SQSEvent) => HandlerReturn,
      previous?: unknown,
      event: SQSEvent = singleBillEvent(),
    ) => {
      fake = new FakeVersionedS3("2026-02-02T09:00:00.000Z");
      if (previous !== undefined) fake.put(RAW_KEY, previous);
      const putsBefore = s3Puts().length;
      const getsBefore = s3Inputs("GetObject").length;
      const sqsBefore = mockSqsSend.mock.calls.length;
      pushVotedBillResponses();
      const result = await handler(event);
      return {
        result,
        puts: s3Puts().slice(putsBefore),
        gets: s3Inputs("GetObject").slice(getsBefore),
        queues: mockSqsSend.mock.calls.slice(sqsBefore).map(([cmd]) => cmd.input.QueueUrl),
      };
    };

    it("stores exactly today's object (same body and metadata, no IfMatch) whatever the previous raw bill holds", async () => {
      jest.useFakeTimers({
        now: new Date("2026-03-01T12:00:00.000Z"),
        doNotFake: [
          "nextTick",
          "setImmediate",
          "clearImmediate",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "queueMicrotask",
        ],
      });
      const handler = loadHandler(undefined);
      const event = singleBillEvent();
      event.Records[0].messageAttributes = {
        correlationId: { dataType: "String", stringValue: "2026-03-01T12:00:00.000Z:BILLS-119hr77ih" },
      };

      const runs = [];
      for (const previous of [
        undefined, // a new bill: what fetchRawBill stores today
        previousRawBill({ house: enrichedHouse() }), // carriable
        previousRawBill({ house: fetchedHouse() }), // not enriched yet
        previousRawBill({ house: enrichedHouse({ yea: 1, nay: 2 }) }), // another roll call
      ]) {
        runs.push(await refetchOnce(handler, previous, event));
      }

      const [today, ...others] = runs;
      expect(today.puts).toHaveLength(1);
      expect(JSON.parse(today.puts[0].Body).content.officialVotes.house).toEqual(fetchedHouse());
      for (const run of runs) {
        expect(run.result.batchItemFailures).toEqual([]);
        expect(run.gets).toEqual([{ Bucket: "test-raw-bills-bucket", Key: RAW_KEY }]);
        expect(run.puts).toHaveLength(1);
        expect(run.puts[0]).not.toHaveProperty("IfMatch");
        expect(run.queues).toEqual([DIFFER_QUEUE, ENRICHMENT_QUEUE]);
      }
      for (const run of others) {
        expect(run.puts[0].Body).toBe(today.puts[0].Body);
        expect(run.puts[0]).toEqual(today.puts[0]);
      }
      expect(metricValues("MemberVotesCarriable")).toEqual([1]);
      expect(metricValues("MemberVotesCarried")).toEqual([]);
      expect(carryLines().map((line) => [line.memberVoteCarryMode, line.outcome])).toEqual([
        ["watch", "would_carry"],
        ["watch", "none"],
      ]);
    });

    it.each([["watch"], ["enforce"], ["ON"], [""], ["true"]])(
      "treats MEMBER_VOTE_CARRY_MODE=%j as watch",
      async (mode) => {
        const handler = loadHandler(mode);

        const run = await refetchOnce(handler, previousRawBill({ house: enrichedHouse() }));

        expect(run.puts[0]).not.toHaveProperty("IfMatch");
        expect(JSON.parse(run.puts[0].Body).content.officialVotes.house).toEqual(fetchedHouse());
        expect(run.queues).toEqual([DIFFER_QUEUE, ENRICHMENT_QUEUE]);
        expect(metricValues("MemberVotesCarriable")).toEqual([1]);
        expect(carryLines()).toEqual([
          expect.objectContaining({ memberVoteCarryMode: "watch", outcome: "would_carry", carriedChambers: ["house"] }),
        ]);
      },
    );

    it("logs none and counts nothing for a new roll call", async () => {
      const handler = loadHandler("watch");

      await refetchOnce(handler, previousRawBill({ house: enrichedHouse({ actionDate: "2026-01-15" }) }));

      expect(metricValues("MemberVotesCarriable")).toEqual([]);
      expect(carryLines()).toEqual([
        expect.objectContaining({
          outcome: "none",
          chambers: { house: expect.objectContaining({ outcome: "new_roll_call" }) },
        }),
      ]);
    });

    it("stores the bill as before when the previous raw bill cannot be read", async () => {
      const handler = loadHandler(undefined);
      mockS3Send.mockImplementation((cmd) =>
        cmd.__cmd === "GetObject" ? Promise.reject(refusedWriteError(503)) : fake.send(cmd),
      );

      const run = await refetchOnce(handler, previousRawBill({ house: enrichedHouse() }));

      expect(run.result.batchItemFailures).toEqual([]);
      expect(run.puts).toHaveLength(1);
      expect(run.puts[0]).not.toHaveProperty("IfMatch");
      expect(run.queues).toEqual([DIFFER_QUEUE, ENRICHMENT_QUEUE]);
      expect(logLines(console.warn)).toContainEqual(
        expect.objectContaining({
          message: "Could not evaluate the member vote carry; the raw bill is stored as before",
          memberVoteCarryMode: "watch",
          outcome: "read_failed",
        }),
      );
    });

    it("stores the bill as before when the previous raw bill is not JSON", async () => {
      const handler = loadHandler(undefined);

      const run = await refetchOnce(handler, "{not json");

      expect(run.result.batchItemFailures).toEqual([]);
      expect(run.puts[0]).not.toHaveProperty("IfMatch");
      expect(carryLines()).toEqual([]);
    });
  });
});

describe("fetchRawBill bill text from GovInfo and congress.gov (REL-45)", () => {
  const RAW_KEY = "raw-bills/BILLS-119hr77.json";
  const DIFFER_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue";
  const CONGRESS_XML = "https://www.congress.gov/119/bills/hr77/BILLS-119hr77ih.xml";
  const GOVINFO_XML = "https://www.govinfo.gov/content/pkg/BILLS-119hr77ih/xml/BILLS-119hr77ih.xml";
  const BILL_XML = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE bill PUBLIC "-//US Congress//DTDs/bill.dtd//EN" "bill.dtd">',
    "<bill><legis-body>Text of H.R. 77</legis-body></bill>",
  ].join("\n");
  const OLDER_XML = "<bill><legis-body>Stored text of H.R. 77</legis-body></bill>";
  // What each source answers for a text version it does not have (yet), as seen live on 2026-10-17: GovInfo
  // redirects to its error page, congress.gov answers a 404 page.
  const GOVINFO_MISS = { statusCode: 302, body: "", headers: { location: "https://www.govinfo.gov/error" } };
  const CONGRESS_MISS = {
    statusCode: 404,
    body: "<!DOCTYPE html><html><title>Page Not Found</title></html>",
    headers: { "content-type": "text/html; charset=UTF-8" },
  };
  const USER_AGENT =
    "BillBoardFetcher/1.1 (BillBoard civic app; bill text; +https://billboard-project.com/privacy.html; contact@billboard-project.com)";
  const CORRELATION_ID = "2026-10-16T08:06:25.748Z:BILLS-119hr77";

  let fake: FakeVersionedS3;

  beforeEach(() => {
    fake = new FakeVersionedS3("2026-10-16T08:00:00.000Z");
    mockS3Send.mockImplementation((cmd) => fake.send(cmd));
  });

  /** The handler loaded with the REL-45 settings production has, plus `env`. */
  const loadHandler = (env: Record<string, string | undefined> = {}) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: DIFFER_QUEUE,
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
        BILL_XML_SOURCES: "govinfo,congress",
        BILL_XML_REUSE_SAME_VERSION: "on",
        TEXT_RETRY_QUEUE_URL: TEXT_RETRY_QUEUE,
        BILL_TEXT_RETRY_DELAY_SECONDS: "600",
        BILL_TEXT_MAX_RETRIES: "3",
        BILL_XML_FETCH_BUDGET_MS: "40000",
        BILL_XML_REFUSED_HOST_COOLDOWN_MS: "600000",
        ...env,
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    return require("../handlers/fetchRawBill").handler as (event: SQSEvent, context?: unknown) => HandlerReturn;
  };

  /** The 8 API answers; /text names `xmlUrl` as the newest version's Formatted XML (none when null). */
  const pushApiResponses = (xmlUrl: string | null = CONGRESS_XML, formats?: unknown[]) => {
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({ bill: { number: "77", type: "hr", congress: 119, title: "Test" } }),
    });
    for (const body of [
      { actions: [] },
      { subjects: [] },
      { titles: [] },
      { cosponsors: [] },
      { committees: [] },
      { relatedBills: [] },
    ]) {
      httpResponses.push({ statusCode: 200, body: JSON.stringify(body) });
    }
    const textVersions =
      xmlUrl === null && !formats
        ? []
        : [
            {
              type: "Introduced in House",
              formats: formats ?? [
                { type: "PDF", url: "https://www.congress.gov/119/bills/hr77/BILLS-119hr77ih.pdf" },
                { type: "Formatted XML", url: xmlUrl },
              ],
            },
          ];
    httpResponses.push({ statusCode: 200, body: JSON.stringify({ textVersions }) });
  };

  /** A stored raw bill whose /text names `xmlUrl`, with `billXML` when given. */
  const previousRaw = (xmlUrl: string, billXML?: string, extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    kind: "raw",
    storedAt: "2026-10-10T00:00:00.000Z",
    identifier: { congress: "119", billType: "hr", billNumber: "77" },
    metadata: {
      guid: "BILLS-119hr77",
      title: "H.R. 77",
      pubDate: "2026-03-01T12:00:00Z",
      fetchedAt: "2026-10-10T00:00:00.000Z",
    },
    content: {
      bill: { number: "77", type: "hr", congress: 119, title: "Test" },
      text: { textVersions: [{ formats: [{ type: "Formatted XML", url: xmlUrl }] }] },
      ...(billXML ? { billXML } : {}),
      ...extra,
    },
  });

  const event = (fields: Record<string, unknown> = {}) => {
    const sqsEvent = singleBillEvent();
    sqsEvent.Records[0].body = JSON.stringify({ ...JSON.parse(sqsEvent.Records[0].body), ...fields });
    sqsEvent.Records[0].messageAttributes = { correlationId: { dataType: "String", stringValue: CORRELATION_ID } };
    return sqsEvent;
  };

  const xmlRequests = () =>
    mockHttpsRequest.mock.calls
      .map(([url]) => String(url))
      .filter((url) => !url.startsWith("https://api.congress.gov/"));
  const stored = () => fake.json<StoredRaw>(RAW_KEY)!;
  const sentTo = (queueUrl: string) =>
    mockSqsSend.mock.calls
      .map(([cmd]) => cmd.input)
      .filter((input) => input.QueueUrl === queueUrl)
      .flatMap((input) => input.Entries);
  const dimensionsOf = (name: string) =>
    metricDatums(name).map((datum) =>
      Object.fromEntries(
        ((datum.Dimensions as Array<{ Name: string; Value: string }>) ?? []).map((d) => [d.Name, d.Value]),
      ),
    );

  it("asks GovInfo first: one XML request, congress.gov untouched, the text stored and counted (ok)", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push({ statusCode: 200, body: BILL_XML, headers: { "content-type": "application/xml" } });

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([]);
    expect(xmlRequests()).toEqual([GOVINFO_XML]);
    expect(stored().content.billXML).toBe(BILL_XML);
    expect(stored().content.billXMLFetch).toEqual({
      outcome: "ok",
      versionStem: "BILLS-119hr77ih",
      source: "GovInfo",
      statuses: { GovInfo: 200 },
      at: expect.any(String),
    });
    expect(dimensionsOf("BillXmlFetchSuccess")).toEqual([{ Source: "GovInfo", StatusCode: "200" }]);
    expect(metricDatums("BillTextFetched")).toEqual([{ MetricName: "BillTextFetched", Unit: "Count", Value: 1 }]);
    expect(metricDatums("BillXmlFallbackUsed")).toEqual([]);
    expect(metricDatums("BillXmlFetchFailure")).toEqual([]);
    expect(sentTo(TEXT_RETRY_QUEUE)).toEqual([]);
    expect(sentTo(DIFFER_QUEUE).map((entry) => JSON.parse(entry.MessageBody))).toEqual([{ guid: "BILLS-119hr77" }]);
  });

  it("sends the descriptive User-Agent on every request: the API, GovInfo and congress.gov", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push(GOVINFO_MISS, { statusCode: 200, body: BILL_XML });

    await handler(event());

    expect(mockHttpsRequest).toHaveBeenCalledTimes(10);
    expect(xmlRequests()).toEqual([GOVINFO_XML, CONGRESS_XML]);
    for (const [, options] of mockHttpsRequest.mock.calls) {
      expect((options as { headers: Record<string, string> }).headers["User-Agent"]).toBe(USER_AGENT);
    }
  });

  it("falls back to congress.gov when GovInfo does not have the version (302 to /error) and counts BillXmlFallbackUsed", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push(GOVINFO_MISS, { statusCode: 200, body: BILL_XML });

    await handler(event());

    expect(stored().content.billXML).toBe(BILL_XML);
    expect(stored().content.billXMLFetch).toMatchObject({
      outcome: "ok",
      source: "CongressGov",
      statuses: { GovInfo: 302, CongressGov: 200 },
    });
    expect(dimensionsOf("BillXmlFallbackUsed")).toEqual([{ Source: "CongressGov" }]);
    expect(dimensionsOf("BillXmlFetchFailure")).toEqual([
      { Source: "GovInfo" },
      { Source: "GovInfo", StatusCode: "302" },
    ]);
    // A miss is not a refusal: the post-deploy check and the source switch read BillXmlFetchRefused.
    expect(metricDatums("BillXmlFetchRefused")).toEqual([]);
    expect(metricDatums("BillTextUnavailable")).toEqual([]);
  });

  it("when both sources refuse: stores the bill without text, acknowledges it, sends it on, and retries it in 10 minutes", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([]);
    expect(stored().content.billXML).toBeUndefined();
    expect(stored().content.billXMLFetch).toEqual({
      outcome: "refused",
      versionStem: "BILLS-119hr77ih",
      statuses: { GovInfo: 403, CongressGov: 403 },
      at: expect.any(String),
      retryScheduled: true,
    });
    expect(sentTo(DIFFER_QUEUE).map((entry) => JSON.parse(entry.MessageBody))).toEqual([{ guid: "BILLS-119hr77" }]);
    const [retry, ...more] = sentTo(TEXT_RETRY_QUEUE);
    expect(more).toEqual([]);
    expect(retry.DelaySeconds).toBe(600);
    expect(JSON.parse(retry.MessageBody)).toEqual({ ...JSON.parse(event().Records[0].body), textRetryAttempt: 1 });
    expect(retry.MessageAttributes.correlationId.StringValue).toBe(CORRELATION_ID);
    expect(metricDatums("BillTextRetryScheduled")).toHaveLength(1);
    expect(metricDatums("BillTextUnavailable")).toEqual([]);
    expect(dimensionsOf("BillXmlFetchFailure")).toEqual([
      { Source: "GovInfo" },
      { Source: "GovInfo", StatusCode: "403" },
      { Source: "CongressGov" },
      { Source: "CongressGov", StatusCode: "403" },
    ]);
    expect(dimensionsOf("BillXmlFetchRefused")).toEqual([{ Source: "GovInfo" }, { Source: "CongressGov" }]);
  });

  it("makes the refusal final at once for a bulk refetch's message (noTextRetry): no delayed message outlives its quiet window", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    const result = await handler(event({ noTextRetry: true }));

    expect(result.batchItemFailures).toEqual([]);
    expect(sentTo(TEXT_RETRY_QUEUE)).toEqual([]);
    expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
    expect(metricDatums("BillTextRetryScheduled")).toEqual([]);
    // Counted at once, so refetch:stale-bills stops at its next check (RUNBOOK 4.10).
    expect(dimensionsOf("BillTextUnavailable")).toEqual([{}, { Reason: "refused" }]);
    expect(stored().content.billXML).toBeUndefined();
    expect(stored().content.billXMLFetch).toMatchObject({ outcome: "refused" });
    expect(stored().content.billXMLFetch.retryScheduled).toBeUndefined();
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("no delayed retry for a bulk refetch") }),
    );
  });

  it("with noTextRetry, a refusal still keeps the stored text of the same version and counts nothing", async () => {
    fake.put(RAW_KEY, previousRaw(CONGRESS_XML, OLDER_XML));
    const handler = loadHandler({ BILL_XML_REUSE_SAME_VERSION: "off" });
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    await handler(event({ noTextRetry: true }));

    expect(sentTo(TEXT_RETRY_QUEUE)).toEqual([]);
    expect(stored().content.billXML).toBe(OLDER_XML);
    expect(stored().content.billXMLFetch).toMatchObject({ outcome: "carried", fetchOutcome: "refused" });
    expect(metricDatums("BillTextUnavailable")).toEqual([]);
  });

  it.each([["true"], [1], [false]])("schedules the retry as usual when noTextRetry is %p, not true", async (value) => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    await handler(event({ noTextRetry: value }));

    expect(sentTo(TEXT_RETRY_QUEUE)).toHaveLength(1);
  });

  it("makes the refusal final on textRetryAttempt 3: no further message, BillTextUnavailable{Reason=refused}", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    const result = await handler(event({ textRetryAttempt: 3 }));

    expect(result.batchItemFailures).toEqual([]);
    expect(sentTo(TEXT_RETRY_QUEUE)).toEqual([]);
    expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
    expect(dimensionsOf("BillTextUnavailable")).toEqual([{}, { Reason: "refused" }]);
    expect(metricDatums("BillTextRetryScheduled")).toEqual([]);
    expect(stored().content.billXMLFetch).toMatchObject({ outcome: "refused", retryAttempt: 3 });
    expect(stored().content.billXMLFetch.retryScheduled).toBeUndefined();
  });

  it("retries attempt 2 as attempt 3", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    await handler(event({ textRetryAttempt: 2 }));

    expect(sentTo(TEXT_RETRY_QUEUE).map((entry) => JSON.parse(entry.MessageBody).textRetryAttempt)).toEqual([3]);
  });

  it("fails the record when the retry cannot be sent, so SQS retries it", async () => {
    const handler = loadHandler();
    mockSqsSend.mockImplementation((cmd) =>
      cmd.input.QueueUrl === TEXT_RETRY_QUEUE ? Promise.reject(new Error("SQS unavailable")) : Promise.resolve({}),
    );
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(sentTo(DIFFER_QUEUE)).toEqual([]);
    expect(metricDatums("BillTextRetryScheduled")).toEqual([]);
  });

  it("reuses the stored text of the same version without a request (BillXmlReused)", async () => {
    fake.put(RAW_KEY, previousRaw(CONGRESS_XML, OLDER_XML, { billXMLFetch: { outcome: "ok", source: "GovInfo" } }));
    const handler = loadHandler();
    pushApiResponses();

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([]);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(8);
    expect(xmlRequests()).toEqual([]);
    expect(stored().content.billXML).toBe(OLDER_XML);
    expect(stored().content.billXMLFetch).toEqual({
      outcome: "reused",
      versionStem: "BILLS-119hr77ih",
      source: "GovInfo",
      statuses: {},
      at: expect.any(String),
    });
    expect(metricDatums("BillXmlReused")).toHaveLength(1);
    expect(metricDatums("BillTextFetched")).toEqual([]);
    // The text step's read and REL-35's own read.
    expect(s3Inputs("GetObject")).toHaveLength(2);
  });

  it("reuses the text of a raw bill stored before REL-45 (no marker): the version comes from its /text", async () => {
    fake.put(RAW_KEY, previousRaw(CONGRESS_XML, OLDER_XML));
    const handler = loadHandler();
    pushApiResponses();

    await handler(event());

    expect(xmlRequests()).toEqual([]);
    expect(stored().content.billXML).toBe(OLDER_XML);
    expect(stored().content.billXMLFetch).toMatchObject({ outcome: "reused", versionStem: "BILLS-119hr77ih" });
    expect(stored().content.billXMLFetch.source).toBeUndefined();
  });

  it("with BILL_XML_REUSE_SAME_VERSION=off fetches, and a failed fetch keeps the stored text of the same version", async () => {
    fake.put(RAW_KEY, previousRaw(CONGRESS_XML, OLDER_XML));
    const handler = loadHandler({ BILL_XML_REUSE_SAME_VERSION: "off" });
    pushApiResponses();
    httpResponses.push(GOVINFO_MISS, CONGRESS_MISS);

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([]);
    expect(xmlRequests()).toEqual([GOVINFO_XML, CONGRESS_XML]);
    expect(stored().content.billXML).toBe(OLDER_XML);
    expect(stored().content.billXMLFetch).toMatchObject({
      outcome: "carried",
      fetchOutcome: "not_found",
      statuses: { GovInfo: 302, CongressGov: 404 },
    });
    expect(metricDatums("BillTextUnavailable")).toEqual([]);
    expect(metricDatums("BillXmlReused")).toEqual([]);
    expect(sentTo(TEXT_RETRY_QUEUE)).toEqual([]);
  });

  it("with reuse off, a refusal keeps the stored text and still schedules the retry", async () => {
    fake.put(RAW_KEY, previousRaw(CONGRESS_XML, OLDER_XML));
    const handler = loadHandler({ BILL_XML_REUSE_SAME_VERSION: "off" });
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    await handler(event());

    expect(stored().content.billXML).toBe(OLDER_XML);
    expect(stored().content.billXMLFetch).toMatchObject({
      outcome: "carried",
      fetchOutcome: "refused",
      retryScheduled: true,
    });
    expect(sentTo(TEXT_RETRY_QUEUE)).toHaveLength(1);
  });

  it("a new version on neither source (GovInfo 302 to /error, congress.gov 404): stored without text, acknowledged, not retried, BillTextUnavailable{Reason=not_found}", async () => {
    // The stored text belongs to the introduced version; the newest is reported-in-House.
    fake.put(RAW_KEY, previousRaw(CONGRESS_XML, OLDER_XML));
    const handler = loadHandler();
    const reported = "https://www.congress.gov/119/bills/hr77/BILLS-119hr77rh.xml";
    pushApiResponses(reported);
    httpResponses.push(GOVINFO_MISS, CONGRESS_MISS);

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([]);
    expect(xmlRequests()).toEqual([
      "https://www.govinfo.gov/content/pkg/BILLS-119hr77rh/xml/BILLS-119hr77rh.xml",
      reported,
    ]);
    expect(stored().content.billXML).toBeUndefined();
    expect(stored().content.billXMLFetch).toMatchObject({ outcome: "not_found", versionStem: "BILLS-119hr77rh" });
    expect(sentTo(TEXT_RETRY_QUEUE)).toEqual([]);
    expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
    expect(dimensionsOf("BillXmlFetchFailure")).toEqual([
      { Source: "GovInfo" },
      { Source: "GovInfo", StatusCode: "302" },
      { Source: "CongressGov" },
      { Source: "CongressGov", StatusCode: "404" },
    ]);
    expect(metricDatums("BillXmlFetchRefused")).toEqual([]);
    expect(dimensionsOf("BillTextUnavailable")).toEqual([{}, { Reason: "not_found" }]);
  });

  it("5xx: 3 attempts per source with backoff, then the next source; all failing is final, without a retry", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push(...Array(6).fill({ statusCode: 503, body: "Service Unavailable" }));

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([]);
    expect(xmlRequests()).toEqual([...Array(3).fill(GOVINFO_XML), ...Array(3).fill(CONGRESS_XML)]);
    expect(stored().content.billXML).toBeUndefined();
    expect(sentTo(TEXT_RETRY_QUEUE)).toEqual([]);
    expect(dimensionsOf("BillTextUnavailable")).toEqual([{}, { Reason: "server_error" }]);
  });

  it("a 429 still failing after its retries counts as throttled and schedules a retry", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push(...Array(6).fill({ statusCode: 429, body: "" }));

    await handler(event());

    expect(xmlRequests()).toHaveLength(6);
    expect(stored().content.billXMLFetch).toMatchObject({
      outcome: "refused",
      statuses: { GovInfo: 429, CongressGov: 429 },
    });
    expect(sentTo(TEXT_RETRY_QUEUE)).toHaveLength(1);
    // A website 429 is not the API key's: the REL-32 stop condition CongressApi429 stays quiet.
    expect(metricDatums("CongressApi429")).toEqual([]);
  });

  it("does not try the fallback once the time budget is used up, and schedules a retry", async () => {
    const handler = loadHandler();
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" });
    const context = {
      awsRequestId: "req-1",
      getRemainingTimeInMillis: jest.fn().mockReturnValueOnce(60_000).mockReturnValue(1_000),
    };

    const result = await handler(event(), context);

    expect(result.batchItemFailures).toEqual([]);
    expect(xmlRequests()).toEqual([GOVINFO_XML]);
    expect(stored().content.billXMLFetch).toMatchObject({
      outcome: "refused",
      statuses: { GovInfo: 403, CongressGov: "budget" },
      retryScheduled: true,
    });
    expect(dimensionsOf("BillXmlSourceSkipped")).toEqual([{ Source: "CongressGov" }]);
    expect(sentTo(TEXT_RETRY_QUEUE)).toHaveLength(1);
  });

  it("skips a host that refused in this environment for the next bill (cooldown)", async () => {
    const handler = loadHandler({ BILL_XML_SOURCES: "congress" });
    pushApiResponses();
    httpResponses.push({ statusCode: 403, body: "" });
    await handler(event());
    pushApiResponses();

    await handler(event());

    expect(xmlRequests()).toEqual([CONGRESS_XML]);
    expect(dimensionsOf("BillXmlSourceSkipped")).toEqual([{ Source: "CongressGov" }]);
    expect(sentTo(TEXT_RETRY_QUEUE)).toHaveLength(2);
  });

  it("BILL_XML_SOURCES=congress never contacts GovInfo (the rollback switch)", async () => {
    const handler = loadHandler({ BILL_XML_SOURCES: "congress" });
    pushApiResponses();
    httpResponses.push({ statusCode: 200, body: BILL_XML });

    await handler(event());

    expect(xmlRequests()).toEqual([CONGRESS_XML]);
    expect(stored().content.billXMLFetch).toMatchObject({ outcome: "ok", source: "CongressGov" });
    expect(metricDatums("BillXmlFallbackUsed")).toEqual([]);
  });

  it.each([
    ["no text versions", null, undefined, "no_text_version"],
    ["no Formatted XML", null, [{ type: "PDF", url: "https://www.congress.gov/x.pdf" }], "no_xml_format"],
  ])("%s is normal: no request, no retry, no BillTextUnavailable", async (_name, xmlUrl, formats, outcome) => {
    const handler = loadHandler();
    pushApiResponses(xmlUrl, formats);

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([]);
    expect(xmlRequests()).toEqual([]);
    expect(stored().content.billXMLFetch).toEqual({ outcome, versionStem: null, statuses: {}, at: expect.any(String) });
    expect(metricDatums("BillTextUnavailable")).toEqual([]);
    expect(metricDatums("BillTextRetryScheduled")).toEqual([]);
    expect(sentTo(TEXT_RETRY_QUEUE)).toEqual([]);
    // No read for the text step: only REL-35's.
    expect(s3Inputs("GetObject")).toHaveLength(1);
  });

  it("an HTML challenge page with a 200 is a refusal, never stored as text", async () => {
    const handler = loadHandler();
    pushApiResponses();
    const page = "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>";
    httpResponses.push(
      { statusCode: 200, body: page, headers: { "content-type": "text/html", "cf-mitigated": "challenge" } },
      { statusCode: 200, body: page, headers: { "content-type": "text/html" } },
    );

    await handler(event());

    expect(stored().content.billXML).toBeUndefined();
    expect(stored().content.billXMLFetch).toMatchObject({
      outcome: "refused",
      statuses: { GovInfo: 200, CongressGov: 200 },
    });
    expect(metricDatums("BillXmlFetchSuccess")).toEqual([]);
    expect(sentTo(TEXT_RETRY_QUEUE)).toHaveLength(1);
  });
});

describe("fetchRawBill unchanged refetches (REL-57, REFETCH_UNCHANGED_MODE)", () => {
  const RAW_KEY = "raw-bills/BILLS-119hr77.json";
  const DIFFER_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue";
  const ENRICHMENT_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment";
  const XML_URL = "https://www.congress.gov/119/bills/hr77/BILLS-119hr77ih.xml";
  const BILL_XML = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE bill PUBLIC "-//US Congress//DTDs/bill.dtd//EN" "bill.dtd">',
    "<bill><legis-body>Text of H.R. 77</legis-body></bill>",
  ].join("\n");
  // Two poller runs 5 minutes apart: congress.gov re-stamped the bill between them.
  const FIRST_ID = "2026-11-11T10:03:39.684Z:BILLS-119hr77";
  const REPEAT_ID = "2026-11-11T10:08:39.707Z:BILLS-119hr77";
  const PASSAGE = {
    actionCode: "8000",
    actionDate: "2026-02-01",
    text: "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 123).",
  };
  const MEMBERS = [
    { bioguideId: "A000001", displayName: "Rep. A", party: "D", state: "CA", votePosition: "Yea" },
    { bioguideId: "B000002", displayName: "Rep. B", party: "R", state: "TX", votePosition: "Nay" },
  ];

  /** The stored raw bill, reduced to what these tests read or change. */
  interface StoredDoc {
    metadata: { fetchedAt: string; title: string };
    content: {
      billXML?: string;
      billXMLFetch?: { outcome?: string };
      officialVotes?: {
        house?: Record<string, unknown>;
        lastSyncedAt?: string;
        completeness?: string;
      };
    };
  }

  let fake: FakeVersionedS3;

  beforeEach(() => {
    fake = new FakeVersionedS3("2026-11-11T10:00:00.000Z");
    mockS3Send.mockImplementation((cmd) => fake.send(cmd));
    // Only the clock is fake, so storedAt and fetchedAt move between two runs however fast they are.
    jest.useFakeTimers({
      now: new Date("2026-11-11T10:05:10.000Z"),
      doNotFake: [
        "nextTick",
        "setImmediate",
        "clearImmediate",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "queueMicrotask",
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** The handler with production's settings (MEMBER_VOTE_CARRY_MODE on, REL-45 text), REFETCH_UNCHANGED_MODE = mode. */
  const loadHandler = (mode: string | undefined, env: Record<string, string | undefined> = {}) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-raw-bills-bucket",
        SECRET_NAME: "CongressAPIKey",
        QUEUE_URL: DIFFER_QUEUE,
        VOTE_ENRICHMENT_QUEUE_URL: ENRICHMENT_QUEUE,
        QUEUE_BATCH_SIZE: "10",
        CONGRESS_API_CALL_DELAY_MS: "0",
        CONGRESS_API_BASE_DELAY_MS: "0",
        CONGRESS_API_MAX_DELAY_MS: "0",
        MEMBER_VOTE_CARRY_MODE: "on",
        BILL_XML_SOURCES: "govinfo,congress",
        BILL_XML_REUSE_SAME_VERSION: "on",
        TEXT_RETRY_QUEUE_URL: TEXT_RETRY_QUEUE,
        BILL_TEXT_RETRY_DELAY_SECONDS: "600",
        BILL_TEXT_MAX_RETRIES: "3",
        BILL_XML_REFUSED_HOST_COOLDOWN_MS: "0",
        REFETCH_UNCHANGED_MODE: mode,
        ...env,
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    return require("../handlers/fetchRawBill").handler as (event: SQSEvent) => HandlerReturn;
  };

  interface Answers {
    actions?: unknown[];
    cosponsors?: unknown[];
    updateDateIncludingText?: string;
  }

  /** The 8 congress.gov answers; /text names XML_URL as the newest version's Formatted XML. */
  const pushApi = ({
    actions = [],
    cosponsors = [],
    updateDateIncludingText = "2026-11-11T09:58:00Z",
  }: Answers = {}) => {
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        bill: {
          number: "77",
          type: "HR",
          congress: 119,
          title: "Test",
          updateDate: "2026-11-11T09:58:00Z",
          updateDateIncludingText,
        },
      }),
    });
    for (const body of [
      { actions },
      { subjects: [] },
      { titles: [] },
      { cosponsors },
      { committees: [] },
      { relatedBills: [] },
      { textVersions: [{ type: "Introduced in House", formats: [{ type: "Formatted XML", url: XML_URL }] }] },
    ]) {
      httpResponses.push({ statusCode: 200, body: JSON.stringify(body) });
    }
  };

  /** The poller's message for H.R. 77 with `correlationId` (none when null) and `fields` added to its body. */
  const pollerEvent = (correlationId: string | null = REPEAT_ID, fields: Record<string, unknown> = {}) => {
    const sqsEvent = singleBillEvent();
    const record = sqsEvent.Records[0];
    record.body = JSON.stringify({ ...JSON.parse(record.body), ...fields });
    record.messageAttributes = correlationId
      ? { correlationId: { dataType: "String", stringValue: correlationId } }
      : {};
    return sqsEvent;
  };

  /** The first fetch of the bill (GovInfo answers its text), then every mock and log spy cleared for the next run. */
  const firstFetch = async (handler: (event: SQSEvent) => HandlerReturn, answers: Answers = {}) => {
    pushApi(answers);
    httpResponses.push({ statusCode: 200, body: BILL_XML, headers: { "content-type": "application/xml" } });
    const result = await handler(pollerEvent(FIRST_ID));
    expect(result.batchItemFailures).toEqual([]);
    expect(fake.contentVersions(RAW_KEY)).toHaveLength(1);
    mockSqsSend.mockClear();
    mockCloudWatchSend.mockClear();
    mockHttpsRequest.mockClear();
    (console.log as jest.Mock).mockClear();
    (console.warn as jest.Mock).mockClear();
    jest.setSystemTime(new Date("2026-11-11T10:10:12.000Z"));
  };

  const sentTo = (queueUrl: string) =>
    mockSqsSend.mock.calls
      .map(([cmd]) => cmd.input)
      .filter((input) => input.QueueUrl === queueUrl)
      .flatMap((input) => input.Entries);
  const correlationIdsSentTo = (queueUrl: string) =>
    sentTo(queueUrl).map((entry) => entry.MessageAttributes?.correlationId?.StringValue);
  const metricValues = (name: string) => metricDatums(name).map((datum) => datum.Value);
  const lineWith = (message: string) => logLines(console.log).filter((line) => line.message === message);
  const processedLine = () => lineWith("Successfully processed bill")[0] ?? {};
  const SKIPPED = "Refetched raw bill is unchanged; not stored again";
  const WOULD_SKIP = "Refetched raw bill is unchanged; it would not be stored again (watch)";
  const versionIds = () => fake.contentVersions(RAW_KEY).map((version) => version.versionId);

  describe('"on"', () => {
    it("stores nothing and sends nothing to BillDiffer when the refetch equals the stored copy (the text reused)", async () => {
      const handler = loadHandler("on");
      await firstFetch(handler);
      const before = fake.current(RAW_KEY)!;
      pushApi();

      const result = await handler(pollerEvent());

      expect(result.batchItemFailures).toEqual([]);
      // Every congress.gov call is still made: a repeat can carry a real update.
      expect(mockHttpsRequest).toHaveBeenCalledTimes(8);
      expect(metricValues("CongressApiCallsCore")).toEqual([8]);
      expect(s3Inputs("PutObject")).toHaveLength(1);
      expect(fake.current(RAW_KEY)).toBe(before);
      expect(mockSqsSend).not.toHaveBeenCalled();
      expect(metricValues("RawBillUnchangedSkipped")).toEqual([1]);
      expect(metricValues("RawBillUnchangedWouldSkip")).toEqual([]);
      expect(metricValues("BillXmlReused")).toEqual([1]);
      expect(lineWith(SKIPPED)).toEqual([
        expect.objectContaining({
          level: "INFO",
          event: "refetch_unchanged",
          refetchUnchangedMode: "on",
          reason: "unchanged",
          volatileChanged: ["storedAt", "metadata.fetchedAt", "content.billXMLFetch"],
          storedVersionId: before.versionId,
          storedCorrelationId: FIRST_ID,
          storedFetchedAt: "2026-11-11T10:05:10.000Z",
          correlationId: REPEAT_ID,
          guid: "BILLS-119hr77",
        }),
      ]);
      expect(lineWith("Stored raw bill in S3")).toEqual([]);
      expect(processedLine()).toMatchObject({ rawBillStored: false, refetchUnchanged: "unchanged", callBudgetUsed: 8 });
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: expect.stringMatching(/^Completed processing/),
          unchanged: 1,
          succeeded: 1,
        }),
      );
    });

    it("stores and sends a refetch that brought a new cosponsor, naming what changed", async () => {
      const handler = loadHandler("on");
      await firstFetch(handler);
      pushApi({ cosponsors: [{ bioguideId: "C000003", sponsorshipDate: "2026-11-10" }] });

      await handler(pollerEvent());

      expect(fake.contentVersions(RAW_KEY)).toHaveLength(2);
      expect(fake.current(RAW_KEY)!.metadata).toEqual({ "correlation-id": REPEAT_ID });
      expect(correlationIdsSentTo(DIFFER_QUEUE)).toEqual([REPEAT_ID]);
      expect(metricValues("RawBillUnchangedSkipped")).toEqual([]);
      expect(lineWith(SKIPPED)).toEqual([]);
      expect(processedLine()).toMatchObject({
        rawBillStored: true,
        refetchUnchanged: "changed",
        refetchChangedPaths: ["content.cosponsors.cosponsors"],
      });
    });

    it("stores a refetch whose only change is congress.gov's updateDateIncludingText", async () => {
      const handler = loadHandler("on");
      await firstFetch(handler);
      pushApi({ updateDateIncludingText: "2026-11-11T10:48:51Z" });

      await handler(pollerEvent());

      expect(fake.contentVersions(RAW_KEY)).toHaveLength(2);
      expect(correlationIdsSentTo(DIFFER_QUEUE)).toEqual([REPEAT_ID]);
      expect(processedLine()).toMatchObject({
        refetchUnchanged: "changed",
        refetchChangedPaths: ["content.bill.bill.updateDateIncludingText"],
      });
    });

    it("stores a refetch whose message carries a new title (congress.gov retitled the bill in its list)", async () => {
      const handler = loadHandler("on");
      await firstFetch(handler);
      pushApi();

      await handler(pollerEvent(REPEAT_ID, { title: "Short Title Act" }));

      expect(fake.json<StoredDoc>(RAW_KEY)!.metadata.title).toBe("Short Title Act");
      expect(correlationIdsSentTo(DIFFER_QUEUE)).toEqual([REPEAT_ID]);
      expect(processedLine()).toMatchObject({ refetchUnchanged: "changed", refetchChangedPaths: ["metadata.title"] });
    });

    it("leaves the enriched member votes and lastSyncedAt as stored (REL-35 carry on), counting no carry", async () => {
      const handler = loadHandler("on");
      await firstFetch(handler, { actions: [PASSAGE] });
      // EnrichOfficialVotes adds the members, with the first message's correlation id.
      const enriched = fake.json<StoredDoc>(RAW_KEY)!;
      enriched.content.officialVotes = {
        ...enriched.content.officialVotes,
        house: { ...enriched.content.officialVotes!.house, memberDataAvailable: true, members: MEMBERS },
        completeness: "complete",
      };
      fake.put(RAW_KEY, enriched, { "correlation-id": FIRST_ID });
      const before = fake.current(RAW_KEY)!;
      pushApi({ actions: [PASSAGE] });

      const result = await handler(pollerEvent());

      expect(result.batchItemFailures).toEqual([]);
      expect(fake.current(RAW_KEY)).toBe(before);
      expect(fake.json<StoredDoc>(RAW_KEY)!.content.officialVotes).toEqual(enriched.content.officialVotes);
      expect(s3Inputs("PutObject")).toHaveLength(1);
      expect(mockSqsSend).not.toHaveBeenCalled();
      expect(metricValues("MemberVotesCarried")).toEqual([]);
      expect(lineWith("Member vote carry decision")).toEqual([]);
      expect(lineWith(SKIPPED)).toEqual([expect.objectContaining({ carriedChambers: ["house"] })]);
      expect(processedLine()).toMatchObject({ rawBillStored: false, needsVoteEnrichment: false });
    });

    it("still queues vote enrichment for a stored copy that needs it, and sends nothing to BillDiffer", async () => {
      const handler = loadHandler("on");
      await firstFetch(handler, { actions: [PASSAGE] });
      pushApi({ actions: [PASSAGE] });

      const result = await handler(pollerEvent());

      expect(result.batchItemFailures).toEqual([]);
      expect(fake.contentVersions(RAW_KEY)).toHaveLength(1);
      expect(sentTo(DIFFER_QUEUE)).toEqual([]);
      expect(sentTo(ENRICHMENT_QUEUE).map((entry) => JSON.parse(entry.MessageBody))).toEqual([
        { guid: "BILLS-119hr77" },
      ]);
      expect(correlationIdsSentTo(ENRICHMENT_QUEUE)).toEqual([REPEAT_ID]);
      expect(processedLine()).toMatchObject({ rawBillStored: false, needsVoteEnrichment: true });
    });

    it("fails a skipped record whose vote enrichment could not be queued, so SQS retries it", async () => {
      const handler = loadHandler("on");
      await firstFetch(handler, { actions: [PASSAGE] });
      mockSqsSend.mockResolvedValueOnce({ Failed: [{ Id: "msg-0", Code: "InternalError", Message: "try again" }] });
      pushApi({ actions: [PASSAGE] });

      const result = await handler(pollerEvent());

      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
      expect(fake.contentVersions(RAW_KEY)).toHaveLength(1);
      expect(mockSqsSend.mock.calls.map(([cmd]) => cmd.input.QueueUrl)).toEqual([ENRICHMENT_QUEUE]);
    });

    it.each([
      ["a REL-56 backfill message", "rel56:2026-11-20T03:10:00.000Z:BILLS-119hr77", {}, "not_poller_message"],
      ["a refetch:stale-bills message", "refetch:2026-12-01T03:10:00.000Z:BILLS-119hr77", {}, "not_poller_message"],
      ["a message without a correlation id (backfill:cosponsors, hand-sent)", null, {}, "not_poller_message"],
      ["a bulk message (noTextRetry) with a poller-form id", REPEAT_ID, { noTextRetry: true }, "bulk_message"],
      ["FetchRawBill's own text retry", REPEAT_ID, { textRetryAttempt: 1 }, "text_retry_message"],
    ])("always stores and sends %s on to BillDiffer", async (_label, correlationId, fields, reason) => {
      const handler = loadHandler("on");
      await firstFetch(handler);
      pushApi();

      await handler(pollerEvent(correlationId, fields));

      expect(fake.contentVersions(RAW_KEY)).toHaveLength(2);
      expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
      expect(metricValues("RawBillUnchangedSkipped")).toEqual([]);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: reason });
    });

    it("stores and sends again a copy this message stored itself, after its BillDiffer send failed", async () => {
      const handler = loadHandler("on");
      pushApi();
      httpResponses.push({ statusCode: 200, body: BILL_XML, headers: { "content-type": "application/xml" } });
      mockSqsSend.mockResolvedValueOnce({ Failed: [{ Id: "msg-0", Code: "InternalError", Message: "try again" }] });
      const failed = await handler(pollerEvent(FIRST_ID));
      expect(failed.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
      mockSqsSend.mockClear();
      (console.log as jest.Mock).mockClear();
      pushApi();

      // SQS delivers the same message again (or a redrive returns it from the DLQ).
      const result = await handler(pollerEvent(FIRST_ID));

      expect(result.batchItemFailures).toEqual([]);
      expect(fake.contentVersions(RAW_KEY)).toHaveLength(2);
      expect(correlationIdsSentTo(DIFFER_QUEUE)).toEqual([FIRST_ID]);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: "stored_by_this_message" });
    });

    // The covering invariant (REL-56): NotificationType skips the push of a version with a rel56: id,
    // so a copy the backfill (or refetch:stale-bills) stored must never cover a poller listing. The poller's refetch
    // that follows it is stored under the poller's id and sent to BillDiffer, even when nothing changed.
    it.each([
      ["the REL-56 backfill", "rel56:2026-11-20T03:10:00.000Z:BILLS-119hr77"],
      ["refetch:stale-bills", "refetch:2026-12-01T03:10:00.000Z:BILLS-119hr77"],
    ])("always stores and sends a poller refetch over a copy %s stored, however equal", async (_label, bulkId) => {
      const handler = loadHandler("on");
      pushApi();
      httpResponses.push({ statusCode: 200, body: BILL_XML, headers: { "content-type": "application/xml" } });
      expect((await handler(pollerEvent(bulkId, { noTextRetry: true }))).batchItemFailures).toEqual([]);
      expect(fake.current(RAW_KEY)!.metadata).toEqual({ "correlation-id": bulkId });
      mockSqsSend.mockClear();
      mockCloudWatchSend.mockClear();
      (console.log as jest.Mock).mockClear();
      jest.setSystemTime(new Date("2026-11-11T10:10:12.000Z"));
      pushApi();

      const result = await handler(pollerEvent());

      expect(result.batchItemFailures).toEqual([]);
      const [bulkCopy, pollerCopy] = fake.contentVersions(RAW_KEY);
      expect(pollerCopy).toBeDefined();
      // The refetch changed nothing a poller-stored copy would have kept it from skipping...
      expect(rawBillDifferences(JSON.parse(bulkCopy.body), JSON.parse(pollerCopy.body))).toEqual([]);
      // ...and is stored and sent on all the same, under the poller's id.
      expect(fake.current(RAW_KEY)!.metadata).toEqual({ "correlation-id": REPEAT_ID });
      expect(correlationIdsSentTo(DIFFER_QUEUE)).toEqual([REPEAT_ID]);
      expect(metricValues("RawBillUnchangedSkipped")).toEqual([]);
      expect(metricValues("RawBillUnchangedWouldSkip")).toEqual([]);
      expect(lineWith(SKIPPED)).toEqual([]);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: "stored_by_bulk_refetch" });
    });

    it("stores, sends and retries a refetch whose text was refused again (REL-45)", async () => {
      const handler = loadHandler("on");
      pushApi();
      httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });
      await handler(pollerEvent(FIRST_ID));
      expect(sentTo(TEXT_RETRY_QUEUE)).toHaveLength(1);
      mockSqsSend.mockClear();
      pushApi();
      httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

      await handler(pollerEvent());

      expect(fake.contentVersions(RAW_KEY)).toHaveLength(2);
      expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
      expect(correlationIdsSentTo(TEXT_RETRY_QUEUE)).toEqual([REPEAT_ID]);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: "text_retry_scheduled" });
    });

    it("stores, sends and counts a refetch that left the bill without text again (BillTextUnavailable)", async () => {
      const handler = loadHandler("on");
      const miss = [
        { statusCode: 302, body: "", headers: { location: "https://www.govinfo.gov/error" } },
        { statusCode: 404, body: "<!DOCTYPE html><html><title>Page Not Found</title></html>" },
      ];
      pushApi();
      httpResponses.push(...miss);
      await handler(pollerEvent(FIRST_ID));
      mockSqsSend.mockClear();
      mockCloudWatchSend.mockClear();
      pushApi();
      httpResponses.push(...miss);

      await handler(pollerEvent());

      expect(fake.contentVersions(RAW_KEY)).toHaveLength(2);
      expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
      expect(metricValues("BillTextUnavailable")).toEqual([1, 1]);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: "text_unavailable" });
    });

    it("stores a bill it has no copy of", async () => {
      const handler = loadHandler("on");
      pushApi();
      httpResponses.push({ statusCode: 200, body: BILL_XML, headers: { "content-type": "application/xml" } });

      await handler(pollerEvent());

      expect(fake.contentVersions(RAW_KEY)).toHaveLength(1);
      expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: "no_stored_copy" });
    });

    it("works the same under MEMBER_VOTE_CARRY_MODE watch, and stores when the stored copy cannot be read", async () => {
      const handler = loadHandler("on", { MEMBER_VOTE_CARRY_MODE: "watch" });
      await firstFetch(handler);
      pushApi();

      await handler(pollerEvent());

      expect(fake.contentVersions(RAW_KEY)).toHaveLength(1);
      expect(mockSqsSend).not.toHaveBeenCalled();
      expect(metricValues("RawBillUnchangedSkipped")).toEqual([1]);

      mockS3Send.mockImplementation((cmd) =>
        cmd.__cmd === "GetObject"
          ? Promise.reject(
              Object.assign(new Error("Internal"), { name: "InternalError", $metadata: { httpStatusCode: 500 } }),
            )
          : fake.send(cmd),
      );
      (console.log as jest.Mock).mockClear();
      pushApi();
      // The text step cannot read the stored copy either, so it fetches the text again.
      httpResponses.push({ statusCode: 200, body: BILL_XML, headers: { "content-type": "application/xml" } });

      const result = await handler(pollerEvent("2026-11-11T10:13:39.711Z:BILLS-119hr77"));

      expect(result.batchItemFailures).toEqual([]);
      expect(fake.contentVersions(RAW_KEY)).toHaveLength(2);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: "stored_copy_unreadable" });
    });
  });

  describe('"watch", as shipped', () => {
    it("logs and counts the would-skip, then stores and sends exactly as before", async () => {
      const handler = loadHandler("watch");
      await firstFetch(handler);
      const before = fake.current(RAW_KEY)!;
      pushApi();

      const result = await handler(pollerEvent());

      expect(result.batchItemFailures).toEqual([]);
      expect(versionIds()).toHaveLength(2);
      expect(fake.current(RAW_KEY)!.metadata).toEqual({ "correlation-id": REPEAT_ID });
      expect(correlationIdsSentTo(DIFFER_QUEUE)).toEqual([REPEAT_ID]);
      expect(metricValues("RawBillUnchangedWouldSkip")).toEqual([1]);
      expect(metricValues("RawBillUnchangedSkipped")).toEqual([]);
      expect(lineWith(WOULD_SKIP)).toEqual([
        expect.objectContaining({
          event: "refetch_unchanged",
          refetchUnchangedMode: "watch",
          reason: "unchanged",
          storedVersionId: before.versionId,
          storedCorrelationId: FIRST_ID,
        }),
      ]);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: "unchanged" });
    });

    it("counts nothing for a changed refetch, and gives the reason on the processed line", async () => {
      const handler = loadHandler("watch");
      await firstFetch(handler);
      pushApi({ cosponsors: [{ bioguideId: "C000003" }] });

      await handler(pollerEvent());

      expect(metricValues("RawBillUnchangedWouldSkip")).toEqual([]);
      expect(lineWith(WOULD_SKIP)).toEqual([]);
      expect(processedLine()).toMatchObject({ rawBillStored: true, refetchUnchanged: "changed" });
    });

    it("an unknown value is watch: it never skips a write", async () => {
      const handler = loadHandler("yes");
      await firstFetch(handler);
      pushApi();

      await handler(pollerEvent());

      expect(versionIds()).toHaveLength(2);
      expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
      expect(metricValues("RawBillUnchangedWouldSkip")).toEqual([1]);
    });
  });

  describe('"off" (unset, the code default)', () => {
    it("compares nothing: stores and sends every refetch, with today's processed line", async () => {
      const handler = loadHandler(undefined);
      await firstFetch(handler);
      pushApi();

      await handler(pollerEvent());

      expect(versionIds()).toHaveLength(2);
      expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
      expect(metricValues("RawBillUnchangedWouldSkip")).toEqual([]);
      expect(metricValues("RawBillUnchangedSkipped")).toEqual([]);
      expect(lineWith(WOULD_SKIP)).toEqual([]);
      expect(processedLine()).not.toHaveProperty("refetchUnchanged");
      expect(processedLine()).not.toHaveProperty("rawBillStored");
    });
  });
});
