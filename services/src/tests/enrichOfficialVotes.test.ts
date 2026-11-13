import { EventEmitter } from "events";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";
import type { OfficialVotesBreakdown, RawBill } from "../models/bill";

export {};

const originalEnv = { ...process.env };

const mockSecretsManagerSend = jest.fn();
const mockSqsSend = jest.fn();
const mockCloudWatchSend = jest.fn();
const mockDdbSend = jest.fn();
const getByGuidMock = jest.fn();
const storeMock = jest.fn();
// REL-36: the handler reads the raw bill with its ETag; by default the document getByGuidMock gives, at "etag-1".
const getRevisionByGuidMock = jest.fn();

const httpResponses: Array<{
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
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

/** The raw bill content as the tests read and edit it: the vote block the handler adds, and the action list. */
type VotedContent = {
  officialVotes?: OfficialVotesBreakdown;
  actions: { actions: Array<Record<string, unknown>> };
  committees?: unknown;
};

const contentOf = (bill: RawBill) => bill.content as VotedContent;

const mockHttpsRequest = jest.fn(
  (_url: unknown, _optionsOrCallback?: unknown, _callback?: (res: FakeResponse) => void) => {
    const callback = typeof _optionsOrCallback === "function" ? _optionsOrCallback : _callback;
    const config = httpResponses.shift() ?? { statusCode: 200, headers: {}, body: "{}" };

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
      if (callback) callback(res);
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

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: jest.fn() })),
}));

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  ScanCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsManagerSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn(() => ({ send: mockCloudWatchSend })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("../adapters/rawBillDao", () => ({
  RawBillDao: jest.fn().mockImplementation(() => ({
    getByGuid: getByGuidMock,
    getRevisionByGuid: getRevisionByGuidMock,
    store: storeMock,
  })),
}));

jest.mock("https", () => ({
  request: (...args: Parameters<typeof mockHttpsRequest>) => mockHttpsRequest(...args),
}));

// Pass-through spy so tests can check the fan-out bound.
jest.mock("../shared/concurrency", () => {
  const actual = jest.requireActual("../shared/concurrency");
  return { ...actual, mapWithConcurrency: jest.fn(actual.mapWithConcurrency) };
});

type HandlerReturn = Promise<SQSBatchResponse>;
let handler: (event: SQSEvent) => HandlerReturn;
let restoreEnv: (() => void) | undefined;

const baseRawBill = (guid: string): RawBill => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-02-01T00:00:00.000Z",
  identifier: {
    congress: "119",
    billType: "house-bill",
    billNumber: "10",
  },
  metadata: {
    guid,
    title: "H.R. 10",
    pubDate: "2026-02-01T00:00:00.000Z",
    fetchedAt: "2026-02-01T00:00:00.000Z",
  },
  content: {
    actions: {
      actions: [
        {
          actionCode: "8000",
          actionDate: "2025-02-01",
          recordedVotes: [{ chamber: "House", congress: 119, sessionNumber: 1, rollNumber: 123 }],
          text: "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 123).",
        },
      ],
    },
    officialVotes: {
      house: {
        yea: 220,
        nay: 210,
        present: 0,
        notVoting: 5,
        totalCounted: 435,
        actionCode: "8000",
        actionDate: "2025-02-01",
        resultText: "On passage Passed by the Yeas and Nays: 220 - 210",
        memberDataAvailable: false,
        members: [],
      },
      lastSyncedAt: "2026-02-01T00:00:00.000Z",
      source: "congress_api",
      completeness: "partial",
    },
  },
});

const baseSenateRawBill = (guid: string): RawBill => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-02-01T00:00:00.000Z",
  identifier: {
    congress: "119",
    billType: "senate-bill",
    billNumber: "25",
  },
  metadata: {
    guid,
    title: "S. 25",
    pubDate: "2026-02-01T00:00:00.000Z",
    fetchedAt: "2026-02-01T00:00:00.000Z",
  },
  content: {
    actions: {
      actions: [
        {
          actionCode: "17000",
          actionDate: "2026-02-02",
          voteNumber: "44",
          text: "Passed Senate, Yea-Nay Vote. 58 - 42. Record Vote Number: 44.",
        },
      ],
    },
    officialVotes: {
      senate: {
        yea: 58,
        nay: 42,
        present: 0,
        notVoting: 0,
        totalCounted: 100,
        actionCode: "17000",
        actionDate: "2026-02-02",
        resultText: "Passed Senate, Yea-Nay Vote. 58 - 42.",
        memberDataAvailable: false,
        members: [],
      },
      lastSyncedAt: "2026-02-01T00:00:00.000Z",
      source: "congress_api",
      completeness: "partial",
    },
  },
});

const createSQSEvent = (guid: string, attempt?: number): SQSEvent => ({
  Records: [
    {
      messageId: "msg-0",
      receiptHandle: "receipt-0",
      body: JSON.stringify(attempt === undefined ? { guid } : { guid, attempt }),
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "1234567890",
        SenderId: "test-sender",
        ApproximateFirstReceiveTimestamp: "1234567890",
      },
      messageAttributes: {},
      md5OfBody: "test-md5",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:vote-enrichment",
      awsRegion: "us-east-1",
    },
  ],
});

beforeEach(() => {
  jest.resetModules();
  mockSecretsManagerSend.mockReset();
  mockSqsSend.mockReset();
  mockCloudWatchSend.mockReset();
  mockDdbSend.mockReset();
  mockHttpsRequest.mockClear();
  getByGuidMock.mockReset();
  storeMock.mockReset();
  getRevisionByGuidMock.mockReset();
  getRevisionByGuidMock.mockImplementation(async (guid: string) => {
    const value = await getByGuidMock(guid);
    return value ? { value, etag: '"etag-1"', versionId: "rv1" } : { value: null };
  });
  httpResponses.length = 0;
  socketTimeoutsMs.length = 0;

  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      BUCKET_NAME: "test-raw-bills-bucket",
      SECRET_NAME: "CongressAPIKey",
      QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/bill-differ",
      ENRICHMENT_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment",
      QUEUE_BATCH_SIZE: "10",
      CONGRESS_API_MAX_RETRIES: "2",
      CONGRESS_API_BASE_DELAY_MS: "0",
      CONGRESS_API_MAX_DELAY_MS: "0",
      CONGRESS_API_REQUEST_TIMEOUT_MS: "2500",
      CONGRESS_VOTE_CALL_DELAY_MS: "0",
      CONGRESS_API_MAX_HOUSE_VOTE_PAGES: "2",
      CONGRESS_VOTE_MAX_CALLS_PER_BILL: "4",
      VOTE_ENRICHMENT_DEFER_DELAY_SECONDS: "900",
      VOTE_ENRICHMENT_MAX_DEFER_ATTEMPTS: "4",
      CONGRESS_MEMBERS_MANIFEST_TABLE_NAME: "CongressMembersManifest",
    },
    { replace: true, base: originalEnv },
  );

  mockSecretsManagerSend.mockResolvedValue({
    SecretString: JSON.stringify({ congressApiKey: "test-api-key-123" }),
  });
  mockSqsSend.mockResolvedValue({});
  mockCloudWatchSend.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({ Items: [] });

  const mod = require("../handlers/enrichOfficialVotes");
  handler = mod.handler;
});

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("enrichOfficialVotes handler", () => {
  it("fetches House member votes from the official Congress.gov members endpoint", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));

    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        houseRollCallVoteMemberVotes: {
          results: [
            {
              bioguideID: "A000001",
              firstName: "Jane",
              lastName: "Doe",
              voteParty: "D",
              voteState: "CA",
              voteCast: "Yea",
            },
            {
              bioguideID: "B000002",
              firstName: "John",
              lastName: "Smith",
              voteParty: "R",
              voteState: "TX",
              voteCast: "Nay",
            },
          ],
        },
      }),
    });

    const result = await handler(createSQSEvent(guid));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);

    const requestUrl = String(mockHttpsRequest.mock.calls[0][0]);
    expect(requestUrl).toContain("/house-vote/119/1/123/members");
    expect(requestUrl).toContain("limit=250");
    expect(requestUrl).toContain("offset=0");
    expect(storeMock).toHaveBeenCalledTimes(1);

    const storedRawBill = storeMock.mock.calls[0][0] as RawBill;
    const officialVotes = contentOf(storedRawBill).officialVotes!;
    expect(officialVotes.house!.memberDataAvailable).toBe(true);
    expect(officialVotes.house!.members).toHaveLength(2);
    // Two rows cannot be the 220 - 210 roll call: the header's figures stay as they were.
    expect(officialVotes.house).toMatchObject({ yea: 220, nay: 210, present: 0, notVoting: 5, totalCounted: 435 });
    expect(officialVotes.house!.members[0]).toEqual({
      bioguideId: "A000001",
      displayName: "Doe, Jane",
      party: "D",
      state: "CA",
      votePosition: "Yea",
    });
    expect(officialVotes.house!.members[1]).toEqual({
      bioguideId: "B000002",
      displayName: "Smith, John",
      party: "R",
      state: "TX",
      votePosition: "Nay",
    });

    // One re-enqueue call back to BillDifferQueue
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    expect(mockSqsSend.mock.calls[0][0].input.QueueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/bill-differ",
    );
  });

  it("counts the House Present and Not voting figures from member rows that match the action's tally (H.R. 8800)", async () => {
    // Shaped like H.R. 8800, roll 278: the action text gives 216 - 212 and no other figure; the rows add 3 Not Voting.
    const guid = "BILLS-119hr8800";
    const rawBill = baseRawBill(guid);
    const content = contentOf(rawBill);
    content.actions.actions = [
      {
        actionCode: "H37100",
        actionDate: "2026-07-23",
        recordedVotes: [{ chamber: "House", congress: 119, sessionNumber: 2, rollNumber: 278 }],
        text: "On passage Passed by the Yeas and Nays: 1 - 1 (Roll no. 278).",
      },
    ];
    delete content.officialVotes;
    getByGuidMock.mockResolvedValue(rawBill);

    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        houseRollCallVoteMemberVotes: {
          results: [
            {
              bioguideID: "A000001",
              firstName: "Jane",
              lastName: "Doe",
              voteParty: "D",
              voteState: "CA",
              voteCast: "Yea",
            },
            {
              bioguideID: "B000002",
              firstName: "John",
              lastName: "Smith",
              voteParty: "R",
              voteState: "TX",
              voteCast: "Nay",
            },
            {
              bioguideID: "C000003",
              firstName: "Ann",
              lastName: "Lee",
              voteParty: "R",
              voteState: "CO",
              voteCast: "Not Voting",
            },
          ],
        },
      }),
    });

    const result = await handler(createSQSEvent(guid));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(String(mockHttpsRequest.mock.calls[0][0])).toContain("/house-vote/119/2/278/members");

    const stored = contentOf(storeMock.mock.calls[0][0] as RawBill);
    expect(stored.officialVotes!.house).toMatchObject({
      yea: 1,
      nay: 1,
      present: 0,
      notVoting: 1,
      totalCounted: 3,
      actionCode: "H37100",
      memberDataAvailable: true,
    });
    expect(stored.officialVotes!.house!.members).toHaveLength(3);
    expect(stored.officialVotes!.completeness).toBe("complete");
  });

  it("derives the House session number from the action date when recordedVotes are absent", async () => {
    const guid = "BILLS-119hr10ih";
    const rawBill = baseRawBill(guid);
    const actions = contentOf(rawBill).actions.actions;
    delete actions[0].recordedVotes;
    getByGuidMock.mockResolvedValue(rawBill);

    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        houseRollCallVoteMemberVotes: {
          results: [
            {
              bioguideID: "A000001",
              firstName: "Jane",
              lastName: "Doe",
              voteParty: "D",
              voteState: "CA",
              voteCast: "Yea",
            },
          ],
        },
      }),
    });

    const result = await handler(createSQSEvent(guid));
    expect(result.batchItemFailures).toHaveLength(0);

    const requestUrl = String(mockHttpsRequest.mock.calls[0][0]);
    expect(requestUrl).toContain("/house-vote/119/1/123/members");
  });

  it("defers retry on throttling before max deferred attempts", async () => {
    const guid = "BILLS-119hr11ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));

    httpResponses.push({ statusCode: 429, headers: { "retry-after": "0" }, body: "{}" });
    httpResponses.push({ statusCode: 429, headers: { "retry-after": "0" }, body: "{}" });
    httpResponses.push({ statusCode: 429, headers: { "retry-after": "0" }, body: "{}" });

    const result = await handler(createSQSEvent(guid, 1));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(storeMock).not.toHaveBeenCalled();

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const deferred = mockSqsSend.mock.calls[0][0].input;
    expect(deferred.QueueUrl).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment");
    expect(deferred.Entries[0].DelaySeconds).toBe(900);
    expect(JSON.parse(deferred.Entries[0].MessageBody)).toEqual({ guid, attempt: 2 });
  });

  it("finalizes as partial after max deferrals and re-enqueues to bill differ", async () => {
    const guid = "BILLS-119hr12ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));

    httpResponses.push({ statusCode: 429, headers: { "retry-after": "0" }, body: "{}" });
    httpResponses.push({ statusCode: 429, headers: { "retry-after": "0" }, body: "{}" });
    httpResponses.push({ statusCode: 429, headers: { "retry-after": "0" }, body: "{}" });

    const result = await handler(createSQSEvent(guid, 4));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(storeMock).toHaveBeenCalledTimes(1);

    const storedRawBill = storeMock.mock.calls[0][0] as RawBill;
    const officialVotes = contentOf(storedRawBill).officialVotes!;
    expect(officialVotes.completeness).toBe("partial");

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    expect(mockSqsSend.mock.calls[0][0].input.QueueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/bill-differ",
    );
  });

  it("fetches Senate member votes from official XML and patches the Senate chamber", async () => {
    const guid = "BILLS-119s25is";
    getByGuidMock.mockResolvedValue(baseSenateRawBill(guid));

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          bioguideId: { S: "A000382" },
          name: { S: "Angela D. Alsobrooks" },
          chamber: { S: "Senate" },
          state: { S: "MD" },
        },
        {
          bioguideId: { S: "B001288" },
          name: { S: "John Barrasso" },
          chamber: { S: "Senate" },
          state: { S: "WY" },
        },
      ],
    });

    httpResponses.push({
      statusCode: 200,
      body: `
        <roll_call_vote>
          <vote_date>2026-02-02T18:15:00Z</vote_date>
          <vote_result_text>Passed Senate</vote_result_text>
          <members>
            <member>
              <member_id>S428</member_id>
              <member_full>Alsobrooks (D-MD)</member_full>
              <party>D</party>
              <state>MD</state>
              <vote_cast>Yea</vote_cast>
            </member>
            <member>
              <member_id>S317</member_id>
              <member_full>Barrasso (R-WY)</member_full>
              <party>R</party>
              <state>WY</state>
              <vote_cast>Nay</vote_cast>
            </member>
          </members>
        </roll_call_vote>
      `,
    });

    const result = await handler(createSQSEvent(guid));
    expect(result.batchItemFailures).toHaveLength(0);
    expect(storeMock).toHaveBeenCalledTimes(1);

    const storedRawBill = storeMock.mock.calls[0][0] as RawBill;
    const officialVotes = contentOf(storedRawBill).officialVotes!;
    expect(officialVotes.senate!.memberDataAvailable).toBe(true);
    expect(officialVotes.senate!.members).toHaveLength(2);
    expect(officialVotes.senate!.yea).toBe(1);
    expect(officialVotes.senate!.nay).toBe(1);
    expect(officialVotes.senate!.members[0]).toEqual({
      bioguideId: "A000382",
      displayName: "Alsobrooks (D-MD)",
      party: "D",
      state: "MD",
      votePosition: "Yea",
    });
    expect(officialVotes.senate!.members[1]).toEqual({
      bioguideId: "B001288",
      displayName: "Barrasso (R-WY)",
      party: "R",
      state: "WY",
      votePosition: "Nay",
    });

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    expect(mockSqsSend.mock.calls[0][0].input.QueueUrl).toBe(
      "https://sqs.us-east-1.amazonaws.com/123456789012/bill-differ",
    );
  });

  it("overrides a mismatched canonical-looking Senate member id using manifest name+state", async () => {
    const guid = "BILLS-119s26is";
    getByGuidMock.mockResolvedValue(baseSenateRawBill(guid));

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          bioguideId: { S: "A000382" },
          name: { S: "Angela D. Alsobrooks" },
          chamber: { S: "Senate" },
          state: { S: "MD" },
        },
      ],
    });

    httpResponses.push({
      statusCode: 200,
      body: `
        <roll_call_vote>
          <vote_date>2026-02-02T18:15:00Z</vote_date>
          <vote_result_text>Passed Senate</vote_result_text>
          <members>
            <member>
              <member_id>A000380</member_id>
              <member_full>Alsobrooks (D-MD)</member_full>
              <party>D</party>
              <state>MD</state>
              <vote_cast>Yea</vote_cast>
            </member>
          </members>
        </roll_call_vote>
      `,
    });

    const result = await handler(createSQSEvent(guid));
    expect(result.batchItemFailures).toHaveLength(0);

    const storedRawBill = storeMock.mock.calls[0][0] as RawBill;
    const officialVotes = contentOf(storedRawBill).officialVotes!;
    expect(officialVotes.senate!.members[0]).toEqual(
      expect.objectContaining({
        bioguideId: "A000382",
        displayName: "Alsobrooks (D-MD)",
        state: "MD",
      }),
    );
  });

  it("canonicalizes Senate lis ids for accented and suffixed member names", async () => {
    const guid = "BILLS-119s2296";
    getByGuidMock.mockResolvedValue(baseSenateRawBill(guid));

    mockDdbSend.mockResolvedValueOnce({
      Items: [
        {
          bioguideId: { S: "K000383" },
          name: { S: "Angus S. King Jr." },
          chamber: { S: "Senate" },
          state: { S: "ME" },
        },
        {
          bioguideId: { S: "L000570" },
          name: { S: "Ben Ray Luján" },
          chamber: { S: "Senate" },
          state: { S: "NM" },
        },
      ],
    });

    httpResponses.push({
      statusCode: 200,
      body: `
        <roll_call_vote>
          <vote_date>2026-02-02T18:15:00Z</vote_date>
          <vote_result_text>Passed Senate</vote_result_text>
          <members>
            <member>
              <lis_member_id>S363</lis_member_id>
              <member_full>King (I-ME)</member_full>
              <party>I</party>
              <state>ME</state>
              <vote_cast>Yea</vote_cast>
            </member>
            <member>
              <lis_member_id>S409</lis_member_id>
              <member_full>Lujan (D-NM)</member_full>
              <party>D</party>
              <state>NM</state>
              <vote_cast>Yea</vote_cast>
            </member>
          </members>
        </roll_call_vote>
      `,
    });

    const result = await handler(createSQSEvent(guid));
    expect(result.batchItemFailures).toHaveLength(0);

    const storedRawBill = storeMock.mock.calls[0][0] as RawBill;
    const officialVotes = contentOf(storedRawBill).officialVotes!;
    expect(officialVotes.senate!.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bioguideId: "K000383", displayName: "King (I-ME)", state: "ME" }),
        expect.objectContaining({ bioguideId: "L000570", displayName: "Lujan (D-NM)", state: "NM" }),
      ]),
    );
  });
});

describe("enrichOfficialVotes congress.gov resilience", () => {
  const houseMembersBody = JSON.stringify({
    houseRollCallVoteMemberVotes: {
      results: [
        { bioguideID: "A000001", firstName: "Jane", lastName: "Doe", voteParty: "D", voteState: "CA", voteCast: "Yea" },
      ],
    },
  });

  const metricDatums = (metricName: string): Array<Record<string, unknown>> =>
    mockCloudWatchSend.mock.calls.flatMap(([cmd]) =>
      (cmd?.input?.MetricData ?? []).filter((metric: { MetricName?: string }) => metric.MetricName === metricName),
    );

  const expectDeferred = (guid: string, attempt: number) => {
    expect(storeMock).not.toHaveBeenCalled();
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const deferred = mockSqsSend.mock.calls[0][0].input;
    expect(deferred.QueueUrl).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment");
    expect(JSON.parse(deferred.Entries[0].MessageBody)).toEqual({ guid, attempt });
  };

  it("sets the configured socket timeout and retries a stalled congress.gov request (REL-05)", async () => {
    const guid = "BILLS-119hr20ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    httpResponses.push({ stall: true }, { statusCode: 200, body: houseMembersBody });

    const result = await handler(createSQSEvent(guid));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(socketTimeoutsMs).toEqual([2500, 2500]);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
    const officialVotes = contentOf(storeMock.mock.calls[0][0]).officialVotes!;
    expect(officialVotes.house!.members).toHaveLength(1);
  });

  it("defers the bill when every congress.gov attempt times out (REL-05)", async () => {
    const guid = "BILLS-119hr21ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    httpResponses.push({ stall: true }, { stall: true }, { stall: true });

    const result = await handler(createSQSEvent(guid, 1));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(3);
    expectDeferred(guid, 2);
  });

  it("sets the socket timeout on the Senate roll-call XML request too (REL-05)", async () => {
    const guid = "BILLS-119s27is";
    getByGuidMock.mockResolvedValue(baseSenateRawBill(guid));
    httpResponses.push({ stall: true }, { stall: true }, { stall: true });

    const result = await handler(createSQSEvent(guid, 0));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(socketTimeoutsMs).toEqual([2500, 2500, 2500]);
    expectDeferred(guid, 1);
  });

  it("re-reads the API key and retries once when congress.gov returns 401 (REL-13)", async () => {
    const guid = "BILLS-119hr22ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    mockSecretsManagerSend
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "old-key" }) })
      .mockResolvedValueOnce({ SecretString: JSON.stringify({ congressApiKey: "new-key" }) });
    httpResponses.push({ statusCode: 401, body: "" }, { statusCode: 200, body: houseMembersBody });

    const result = await handler(createSQSEvent(guid));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSecretsManagerSend).toHaveBeenCalledTimes(2);
    expect(String(mockHttpsRequest.mock.calls[0][0])).toContain("api_key=old-key");
    expect(String(mockHttpsRequest.mock.calls[1][0])).toContain("api_key=new-key");
    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(metricDatums("CongressApiAuthFailure")).toEqual([]);
  });

  it("emits CongressApiAuthFailure and defers rather than finalizing when the re-read key is rejected (REL-13)", async () => {
    const guid = "BILLS-119hr23ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    httpResponses.push({ statusCode: 403, body: "" }, { statusCode: 403, body: "" });

    const result = await handler(createSQSEvent(guid, 0));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
    expect(metricDatums("CongressApiAuthFailure")).toEqual([
      { MetricName: "CongressApiAuthFailure", Unit: "Count", Value: 1 },
    ]);
    expectDeferred(guid, 1);
  });

  it("parses Senate members with at most 5 in flight (REL-17)", async () => {
    const { mapWithConcurrency } = require("../shared/concurrency");
    const guid = "BILLS-119s28is";
    getByGuidMock.mockResolvedValue(baseSenateRawBill(guid));
    const members = Array.from(
      { length: 12 },
      (_, index) => `
      <member>
        <lis_member_id>S${100 + index}</lis_member_id>
        <member_full>Member${index} (D-MD)</member_full>
        <party>D</party>
        <state>MD</state>
        <vote_cast>${index % 2 === 0 ? "Yea" : "Nay"}</vote_cast>
      </member>`,
    ).join("");
    httpResponses.push({
      statusCode: 200,
      body: `<roll_call_vote><vote_date>2026-02-02T18:15:00Z</vote_date><members>${members}</members></roll_call_vote>`,
    });

    const result = await handler(createSQSEvent(guid));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mapWithConcurrency).toHaveBeenCalledWith(expect.any(Array), 5, expect.any(Function));
    const officialVotes = contentOf(storeMock.mock.calls[0][0]).officialVotes!;
    expect(officialVotes.senate!.members).toHaveLength(12);
    expect(officialVotes.senate!.yea).toBe(6);
    expect(officialVotes.senate!.nay).toBe(6);
  });
});

describe("enrichOfficialVotes correlation id (OBS-10)", () => {
  const correlationId = "2026-03-02T10:00:00.000Z:BILLS-119hr10ih";
  const tracedEvent = (guid: string, attempt?: number): SQSEvent => {
    const event = createSQSEvent(guid, attempt);
    event.Records[0].messageAttributes = { correlationId: { dataType: "String", stringValue: correlationId } };
    return event;
  };
  const houseMembersResponse = () =>
    httpResponses.push({
      statusCode: 200,
      body: JSON.stringify({
        houseRollCallVoteMemberVotes: {
          results: [
            {
              bioguideID: "A000001",
              firstName: "Jane",
              lastName: "Doe",
              voteParty: "D",
              voteState: "CA",
              voteCast: "Yea",
            },
          ],
        },
      }),
    });
  const attributes = { correlationId: { DataType: "String", StringValue: correlationId } };

  it("stores the enriched raw bill with the record's id and passes it on to billDiffer", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    houseMembersResponse();

    await handler(tracedEvent(guid));

    expect(storeMock).toHaveBeenCalledWith(expect.anything(), { correlationId, ifMatch: '"etag-1"' });
    const sent = mockSqsSend.mock.calls[0][0].input;
    expect(sent.QueueUrl).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/bill-differ");
    expect(sent.Entries[0].MessageAttributes).toEqual(attributes);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "vote enrichment completed", guid, correlationId, sqsMessageId: "msg-0" }),
    );
  });

  it("keeps the id on a deferred retry", async () => {
    const guid = "BILLS-119hr11ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    for (let i = 0; i < 3; i++) httpResponses.push({ statusCode: 429, headers: { "retry-after": "0" }, body: "{}" });

    await handler(tracedEvent(guid, 1));

    const deferred = mockSqsSend.mock.calls[0][0].input;
    expect(deferred.QueueUrl).toBe("https://sqs.us-east-1.amazonaws.com/123456789012/vote-enrichment");
    expect(deferred.Entries[0].MessageAttributes).toEqual(attributes);
  });

  it("mints one when the record carries none", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    houseMembersResponse();

    await handler(createSQSEvent(guid));

    const minted = mockSqsSend.mock.calls[0][0].input.Entries[0].MessageAttributes.correlationId.StringValue;
    expect(minted).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z:BILLS-119hr10ih$/);
    expect(storeMock).toHaveBeenCalledWith(expect.anything(), { correlationId: minted, ifMatch: '"etag-1"' });
  });
});

describe("enrichOfficialVotes conditional raw writes (REL-36)", () => {
  const houseMembersBody = JSON.stringify({
    houseRollCallVoteMemberVotes: {
      results: [
        { bioguideID: "A000001", firstName: "Jane", lastName: "Doe", voteParty: "D", voteState: "CA", voteCast: "Yea" },
      ],
    },
  });
  const preconditionFailed = () =>
    Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    });
  const conflict = () =>
    Object.assign(new Error("A conflicting conditional operation is currently in progress"), {
      name: "ConditionalRequestConflict",
      $metadata: { httpStatusCode: 409 },
    });
  const members = (doc: RawBill) => contentOf(doc).officialVotes!.house!.members;
  const sentToDiffer = () =>
    mockSqsSend.mock.calls.filter(
      ([command]) => command.input.QueueUrl === "https://sqs.us-east-1.amazonaws.com/123456789012/bill-differ",
    );
  const embeddedMetric = (name: string) =>
    logLines(console.log).filter(
      (line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/BillIngestion" && name in line,
    );

  it("writes the enriched raw bill only over the ETag it read", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    httpResponses.push({ statusCode: 200, body: houseMembersBody });

    await handler(createSQSEvent(guid));

    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(storeMock.mock.calls[0][1]).toMatchObject({ ifMatch: '"etag-1"' });
  });

  it("re-applies the same enrichment to a fresh copy after a 412 when the roll calls are the same", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    // A newer fetch landed meanwhile: same vote, new fetchedAt, and a new committee.
    const fresher = baseRawBill(guid);
    fresher.metadata.fetchedAt = "2026-02-03T00:00:00.000Z";
    contentOf(fresher).committees = { committees: [{ name: "Rules" }] };
    getRevisionByGuidMock
      .mockImplementationOnce(async () => ({ value: baseRawBill(guid), etag: '"etag-1"' }))
      .mockImplementationOnce(async () => ({ value: fresher, etag: '"etag-2"' }));
    storeMock.mockRejectedValueOnce(preconditionFailed()).mockResolvedValueOnce({});
    httpResponses.push({ statusCode: 200, body: houseMembersBody });

    const result = await handler(createSQSEvent(guid));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(storeMock).toHaveBeenCalledTimes(2);
    const [retried, options] = storeMock.mock.calls[1];
    expect(options).toMatchObject({ ifMatch: '"etag-2"' });
    expect(retried.metadata.fetchedAt).toBe("2026-02-03T00:00:00.000Z");
    expect(contentOf(retried).committees).toEqual({ committees: [{ name: "Rules" }] });
    expect(members(retried)).toEqual([expect.objectContaining({ bioguideId: "A000001" })]);
    expect(sentToDiffer()).toHaveLength(1);
    expect(embeddedMetric("VoteEnrichmentWriteConflict")).toHaveLength(1);
  });

  it("keeps the members a fresher copy has when this run finalized the chamber as partial, and still sends", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    // Another enrichment of the same roll call wrote the members meanwhile.
    const enrichedMeanwhile = baseRawBill(guid);
    Object.assign(contentOf(enrichedMeanwhile).officialVotes!.house!, {
      memberDataAvailable: true,
      members: [{ bioguideId: "A000001", displayName: "Doe, Jane", votePosition: "Yea" as const }],
    });
    getRevisionByGuidMock
      .mockImplementationOnce(async () => ({ value: baseRawBill(guid), etag: '"etag-1"' }))
      .mockImplementationOnce(async () => ({ value: enrichedMeanwhile, etag: '"etag-2"' }));
    storeMock.mockRejectedValueOnce(preconditionFailed());
    // The last deferred attempt: congress.gov keeps failing, so House is finalized as partial.
    for (let call = 0; call < 3; call += 1) httpResponses.push({ statusCode: 500, body: "{}" });

    const result = await handler(createSQSEvent(guid, 4));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(members(storeMock.mock.calls[0][0])).toEqual([]); // the first write, over the copy it read
    expect(storeMock).toHaveBeenCalledTimes(1); // nothing written over the fresher copy
    expect(sentToDiffer()).toHaveLength(1);
    expect(logLines(console.log)).toContainEqual(expect.objectContaining({ event: "enrichment_already_complete" }));
  });

  it("writes and sends nothing when the fresh copy names another roll call", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    const newerVote = baseRawBill(guid);
    const actions = contentOf(newerVote).actions.actions;
    actions[0] = {
      ...actions[0],
      recordedVotes: [{ chamber: "House", congress: 119, sessionNumber: 1, rollNumber: 150 }],
    };
    getRevisionByGuidMock
      .mockImplementationOnce(async () => ({ value: baseRawBill(guid), etag: '"etag-1"' }))
      .mockImplementationOnce(async () => ({ value: newerVote, etag: '"etag-2"' }));
    storeMock.mockRejectedValueOnce(conflict());
    httpResponses.push({ statusCode: 200, body: houseMembersBody });

    const result = await handler(createSQSEvent(guid));

    expect(result.batchItemFailures).toHaveLength(0);
    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(logLines(console.warn)).toContainEqual(expect.objectContaining({ message: "enrichment_superseded" }));
    expect(embeddedMetric("VoteEnrichmentSuperseded")).toHaveLength(1);
  });

  it("fails the record after 3 refused writes and sends nothing", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockImplementation(async () => baseRawBill(guid));
    storeMock.mockRejectedValue(preconditionFailed());
    httpResponses.push({ statusCode: 200, body: houseMembersBody });

    const result = await handler(createSQSEvent(guid));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(storeMock).toHaveBeenCalledTimes(3);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(embeddedMetric("VoteEnrichmentWriteConflict")).toHaveLength(3);
  });

  it("applies fetched members the same way every time (applyEnrichment)", () => {
    const { applyEnrichment } = require("../handlers/enrichOfficialVotes");
    const first = baseRawBill("BILLS-119hr10ih");
    const second = baseRawBill("BILLS-119hr10ih");
    const fetched = { house: [{ bioguideId: "A000001", displayName: "Doe, Jane", votePosition: "Yea" }] };
    applyEnrichment(first, fetched);
    applyEnrichment(second, fetched);
    const strip = (doc: RawBill) => ({
      ...contentOf(doc).officialVotes,
      lastSyncedAt: undefined,
    });
    expect(strip(first)).toEqual(strip(second));
    expect(strip(first)).toMatchObject({ completeness: "complete", house: { memberDataAvailable: true } });
    // An empty list finalizes the chamber as partial.
    const finalized = baseRawBill("BILLS-119hr10ih");
    applyEnrichment(finalized, { house: [] });
    expect(contentOf(finalized).officialVotes!.completeness).toBe("partial");
  });
});

describe("enrichOfficialVotes unprocessable messages (C1.8)", () => {
  const DROP_LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";
  const dropLines = () => logLines(console.warn).filter((line) => line.message === DROP_LOG_MESSAGE);
  const dropMetrics = () => logLines(console.log).filter((line) => line._aws && "MessagesUnprocessable" in line);
  const eventWith = (bodies: string[]): SQSEvent => {
    const template = createSQSEvent("unused").Records[0];
    return { Records: bodies.map((body, i) => ({ ...template, messageId: `msg-${i}`, body })) };
  };
  const houseMembersBody = JSON.stringify({
    houseRollCallVoteMemberVotes: {
      results: [
        { bioguideID: "A000001", firstName: "Jane", lastName: "Doe", voteParty: "D", voteState: "CA", voteCast: "Yea" },
      ],
    },
  });

  it("acknowledges, logs and counts a record without a guid", async () => {
    const result = await handler(eventWith(["{}", "", JSON.stringify({ guid: "  ", attempt: 2 })]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(getRevisionByGuidMock).not.toHaveBeenCalled();
    expect(dropLines().map((line) => [line.messageId, line.dropSite, line.reason])).toEqual([
      ["msg-0", "enrichOfficialVotes.missingGuid", "missing_guid"],
      ["msg-1", "enrichOfficialVotes.missingGuid", "empty_body"],
      ["msg-2", "enrichOfficialVotes.missingGuid", "missing_guid"],
    ]);
    expect(dropLines()[2].messageContent).toEqual({ guid: "  ", attempt: 2 });
    expect(dropMetrics().map((line) => [line.sqsMessageId, line.MessagesUnprocessable, line.dropSite])).toEqual([
      ["msg-0", 1, "enrichOfficialVotes.missingGuid"],
      ["msg-1", 1, "enrichOfficialVotes.missingGuid"],
      ["msg-2", 1, "enrichOfficialVotes.missingGuid"],
    ]);
  });

  it("acknowledges, logs and counts a record whose raw bill does not exist, and stores or sends nothing", async () => {
    getByGuidMock.mockResolvedValue(null);

    const result = await handler(createSQSEvent("BILLS-119hr99ih", 1));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(storeMock).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(dropLines()).toEqual([
      expect.objectContaining({
        dropSite: "enrichOfficialVotes.rawBillMissing",
        reason: "raw_bill_not_found",
        messageId: "msg-0",
        guid: "BILLS-119hr99ih",
        messageContent: { guid: "BILLS-119hr99ih", attempt: 1 },
      }),
    ]);
    expect(dropMetrics()).toEqual([
      expect.objectContaining({ MessagesUnprocessable: 1, dropSite: "enrichOfficialVotes.rawBillMissing" }),
    ]);
  });

  it("counts nothing for a record it enriches", async () => {
    const guid = "BILLS-119hr10ih";
    getByGuidMock.mockResolvedValue(baseRawBill(guid));
    httpResponses.push({ statusCode: 200, body: houseMembersBody });

    const result = await handler(createSQSEvent(guid));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(storeMock).toHaveBeenCalledTimes(1);
    expect(dropLines()).toEqual([]);
    expect(dropMetrics()).toEqual([]);
  });

  it("still fails a record whose body is not JSON (retried as today, not counted)", async () => {
    const result = await handler(eventWith(["not json"]));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-0" }] });
    expect(dropMetrics()).toEqual([]);
  });

  it("still acknowledges both drops when their log and metric lines throw", async () => {
    getByGuidMock.mockResolvedValue(null);
    (console.warn as jest.Mock).mockImplementation((line: unknown) => {
      if (String(line).includes(DROP_LOG_MESSAGE)) throw new Error("console.warn broke");
    });
    (console.log as jest.Mock).mockImplementation((line: unknown) => {
      if (String(line).includes('"MessagesUnprocessable"')) throw new Error("console.log broke");
    });

    const result = await handler(eventWith(["{}", JSON.stringify({ guid: "BILLS-119hr99ih" })]));

    expect(result).toEqual({ batchItemFailures: [] });
    const attempts = (spy: unknown, needle: string) =>
      (spy as jest.Mock).mock.calls.filter(([line]) => String(line).includes(needle)).length;
    expect(attempts(console.warn, DROP_LOG_MESSAGE)).toBe(2);
    expect(attempts(console.log, '"MessagesUnprocessable"')).toBe(2);
  });
});

describe("Senate member lookup refresh (REL-46)", () => {
  const TTL_MS = 60 * 60 * 1000;
  const guid = "BILLS-119s25is";
  const senateXml = `
    <roll_call_vote>
      <vote_date>2026-02-02T18:15:00Z</vote_date>
      <vote_result_text>Passed Senate</vote_result_text>
      <members>
        <member>
          <member_id>S428</member_id>
          <member_full>Alsobrooks (D-MD)</member_full>
          <party>D</party>
          <state>MD</state>
          <vote_cast>Yea</vote_cast>
        </member>
      </members>
    </roll_call_vote>
  `;
  const manifestScans = () =>
    mockDdbSend.mock.calls.filter(([cmd]) => cmd?.input?.TableName === "CongressMembersManifest").length;
  const runOnce = async () => {
    getByGuidMock.mockResolvedValue(baseSenateRawBill(guid));
    httpResponses.push({ statusCode: 200, body: senateXml });
    return handler(createSQSEvent(guid));
  };
  let nowMs = 0;

  beforeEach(() => {
    nowMs = Date.UTC(2027, 0, 3, 12, 0, 0);
    jest.spyOn(Date, "now").mockImplementation(() => nowMs);
  });

  it("reuses the lookup within the TTL", async () => {
    await runOnce();
    nowMs += TTL_MS - 1;
    await runOnce();
    expect(manifestScans()).toBe(1);
  });

  it("scans again once the lookup is older than the TTL", async () => {
    await runOnce();
    nowMs += TTL_MS + 1;
    await runOnce();
    expect(manifestScans()).toBe(2);
  });

  it("retries on the next call after a failed scan", async () => {
    mockDdbSend.mockRejectedValueOnce(new Error("scan failed"));
    await runOnce();
    expect(manifestScans()).toBe(1);
    await runOnce();
    expect(manifestScans()).toBe(2);
  });
});
