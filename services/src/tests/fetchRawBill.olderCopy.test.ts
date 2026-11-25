import { EventEmitter } from "events";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { FakeVersionedS3 } from "./fakeVersionedS3";
import { applyTestEnv } from "./fixtures/env";
import { logLines, type LogLine } from "./logLines";
import {
  billAnswerUpdateMs,
  decideOlderCopyRecheck,
  isOlderThanListing,
  isRecheckSuperseded,
  olderCopyRecheckOf,
  parseOlderCopyRecheckMode,
  pollerListingTimeMs,
  storedCopyListedAtMs,
  storedCopyUpdateMs,
} from "../handlers/fetchRawBill/olderCopy";

export {};

// REL-56 (2026-11-21): a poller fetch whose bill answer is older than its listing (OLDER_COPY_RECHECK), through the
// real handler against a fake congress.gov whose bill answer can stay older than its list for a number of requests.

// The handler is reloaded per test (it reads its settings when it loads); under --coverage that takes seconds.
jest.setTimeout(30_000);

const originalEnv = { ...process.env };
const QUEUE_ARN = "arn:aws:sqs:us-east-1:123456789012:UpdatedBillsQueue";
const UPDATED_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/UpdatedBillsQueue";
const DIFFER_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/BillDifferQueue";
const RAW_KEY = "raw-bills/BILLS-119hr77.json";
// The run that listed H.R. 77, and the times its answers can hold: the update its listing showed (2 minutes before
// the run), an older one still served after it (July), and one in between that is older than the window too.
const POLLER_ID = "2026-11-19T19:13:39.684Z:BILLS-119hr77";
const LISTED_AT = "2026-11-19T19:13:39.684Z";
const LISTED_UPDATE = "2026-11-19T19:11:35Z";
const OLD_UPDATE = "2026-07-28T08:06:33Z";
const BETWEEN_UPDATE = "2026-11-19T18:40:02Z";
const LATER_ID = "2026-11-19T19:18:39.702Z:BILLS-119hr77";
const LATER_LISTED_AT = "2026-11-19T19:18:39.702Z";

const mockS3Send = jest.fn();
const mockSecretsManagerSend = jest.fn();
const mockCloudWatchSend = jest.fn();
const mockSqsSend = jest.fn();

/** The fake congress.gov: the bill answer serves billUpdates in turn (staying on the last); the rest is fixed. */
const congress = {
  billUpdates: [LISTED_UPDATE] as string[],
  billRequests: 0,
  /** HTTP status of every bill answer request (200 when unset). */
  billStatus: undefined as number | undefined,
  /** When set, /text names a Formatted XML whose every source answers this status. */
  xmlStatus: undefined as number | undefined,
  requests: [] as string[],
};

const billAnswer = (updateDate: string) => ({
  bill: {
    number: "77",
    type: "HR",
    congress: 119,
    title: "Detail title",
    updateDate,
    updateDateIncludingText: updateDate,
    // The answer's content moves with its update, as congress.gov's does.
    latestAction: { actionDate: updateDate.slice(0, 10), text: `Action of ${updateDate}` },
  },
});

const answerFor = (url: string): { statusCode: number; body: string } => {
  const { pathname, hostname } = new URL(url);
  if (hostname !== "api.congress.gov") return { statusCode: congress.xmlStatus ?? 200, body: "" };
  const path = pathname.replace(/^\/v3\/bill\/119\/hr\/77/, "");
  if (path === "") {
    const updateDate = congress.billUpdates[Math.min(congress.billRequests, congress.billUpdates.length - 1)];
    congress.billRequests += 1;
    if (congress.billStatus && congress.billStatus !== 200) return { statusCode: congress.billStatus, body: "" };
    return { statusCode: 200, body: JSON.stringify(billAnswer(updateDate)) };
  }
  const bodies: Record<string, unknown> = {
    "/actions": { actions: [] },
    "/subjects": { subjects: [] },
    "/titles": { titles: [] },
    "/cosponsors": { cosponsors: [] },
    "/committees": { committees: [] },
    "/relatedbills": { relatedBills: [] },
    "/text": {
      textVersions: congress.xmlStatus
        ? [
            {
              type: "Introduced in House",
              formats: [{ type: "Formatted XML", url: "https://www.congress.gov/119/bills/hr77/BILLS-119hr77ih.xml" }],
            },
          ]
        : [],
    },
  };
  return { statusCode: 200, body: JSON.stringify(bodies[path] ?? {}) };
};

interface FakeResponse extends EventEmitter {
  statusCode?: number;
  headers?: Record<string, string>;
}
interface FakeRequest extends EventEmitter {
  setTimeout?: jest.Mock;
  destroy?: jest.Mock;
  end?: jest.Mock;
}

const mockHttpsRequest = jest.fn((url: unknown, _options?: unknown, callback?: (res: FakeResponse) => void) => {
  const target = String(url);
  congress.requests.push(new URL(target).pathname);
  const answer = answerFor(target);
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = answer.statusCode;
  res.headers = {};
  const req = new EventEmitter() as FakeRequest;
  req.setTimeout = jest.fn(() => req);
  req.destroy = jest.fn((error?: Error) => {
    if (error) req.emit("error", error);
    return req;
  });
  req.end = jest.fn(() => {
    callback?.(res);
    res.emit("data", answer.body);
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

/** The handler with production's settings and OLDER_COPY_RECHECK = mode (unset when undefined). */
const loadHandler = (mode: string | undefined, env: Record<string, string | undefined> = {}): Handler => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      BUCKET_NAME: "test-raw-bills-bucket",
      SECRET_NAME: "CongressAPIKey",
      QUEUE_URL: DIFFER_QUEUE,
      TEXT_RETRY_QUEUE_URL: UPDATED_QUEUE,
      QUEUE_BATCH_SIZE: "10",
      CONGRESS_API_CALL_DELAY_MS: "0",
      CONGRESS_API_BASE_DELAY_MS: "0",
      CONGRESS_API_MAX_DELAY_MS: "0",
      MEMBER_VOTE_CARRY_MODE: "on",
      REFETCH_UNCHANGED_MODE: "watch",
      FETCH_RETRY_BACKOFF: "on",
      FETCH_RETRY_LADDER_SECONDS: "180,300,600,1200,1800,3600,3600,3600,3600,3600",
      FETCH_RETRY_OTHER_SECONDS: "60",
      FETCH_RETRY_NOT_FOUND_RECEIVES: "4",
      FETCH_RETRY_MAX_RECEIVES: "11",
      BILL_XML_REFUSED_HOST_COOLDOWN_MS: "0",
      OLDER_COPY_RECHECK: mode,
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
  Object.assign(congress, {
    billUpdates: [LISTED_UPDATE],
    billRequests: 0,
    billStatus: undefined,
    xmlStatus: undefined,
    requests: [],
  });
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  jest.spyOn(Math, "random").mockReturnValue(0);
  fake = new FakeVersionedS3("2026-11-19T19:14:00.000Z");
  mockS3Send.mockImplementation((cmd) => fake.send(cmd));
  mockSecretsManagerSend.mockResolvedValue({ SecretString: JSON.stringify({ congressApiKey: "test-api-key-123" }) });
  mockCloudWatchSend.mockResolvedValue({});
  mockSqsSend.mockResolvedValue({});
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

const BODY = {
  guid: "BILLS-119hr77",
  title: "H.R. 77: Message title",
  description: "Message action",
  pubDate: "2026-11-19T00:00:00.000Z",
  congress: "119",
  billType: "hr",
  billNumber: "77",
};

const record = (body: Record<string, unknown> = BODY, correlationId: string | null = POLLER_ID): SQSRecord =>
  ({
    messageId: "msg-0",
    receiptHandle: "receipt-0",
    body: JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: String(Date.parse(LISTED_AT) + 1_000),
      SenderId: "poller",
      ApproximateFirstReceiveTimestamp: String(Date.now()),
    },
    messageAttributes: correlationId ? { correlationId: { stringValue: correlationId, dataType: "String" } } : {},
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: QUEUE_ARN,
    awsRegion: "us-east-1",
  }) as SQSRecord;

const event = (body?: Record<string, unknown>, correlationId?: string | null): SQSEvent => ({
  Records: [record(body, correlationId)],
});

interface SentEntry {
  Id: string;
  MessageBody: string;
  DelaySeconds?: number;
  MessageAttributes?: { correlationId?: { StringValue?: string } };
}
const sentTo = (queueUrl: string): SentEntry[] =>
  mockSqsSend.mock.calls
    .filter(([cmd]) => cmd?.__sqs === "SendMessageBatch" && cmd.input.QueueUrl === queueUrl)
    .flatMap(([cmd]) => cmd.input.Entries as SentEntry[]);
const rechecksSent = () => sentTo(UPDATED_QUEUE).filter((entry) => entry.Id.startsWith("older-copy-recheck-"));

/** The re-check FetchRawBill sent last, as the record UpdatedBillsQueue delivers it after its delay. */
const deliverLastRecheck = (): SQSEvent => {
  const sent = rechecksSent().at(-1);
  if (!sent) throw new Error("no re-check was sent");
  return event(JSON.parse(sent.MessageBody), sent.MessageAttributes?.correlationId?.StringValue ?? null);
};

const metricDatums = (name: string): Array<{ Value?: number; Dimensions?: Array<{ Name: string; Value: string }> }> =>
  mockCloudWatchSend.mock.calls.flatMap(([cmd]) =>
    (cmd?.input?.MetricData ?? []).filter((datum: { MetricName?: string }) => datum.MetricName === name),
  );
const recheckOutcomes = () =>
  metricDatums("RawBillOlderCopyRecheck")
    .map((datum) => datum.Dimensions?.find((dimension) => dimension.Name === "Outcome")?.Value)
    .filter((outcome): outcome is string => outcome !== undefined);
const allLines = (): LogLine[] => [...logLines(console.log), ...logLines(console.warn), ...logLines(console.error)];
const lineWith = (message: string) => allLines().find((line) => line.message === message);
const storedUpdate = () =>
  fake.json<{ content: { bill: { bill: { updateDate: string } } } }>(RAW_KEY)?.content.bill.bill.updateDate;
const billAnswerRequests = () => congress.requests.filter((path) => path === "/v3/bill/119/hr/77").length;

/** Clears what one invocation left in the mocks, so the next one is read alone. */
const nextInvocation = () => {
  mockSqsSend.mockClear();
  mockCloudWatchSend.mockClear();
  congress.requests = [];
  (console.log as jest.Mock).mockClear();
  (console.warn as jest.Mock).mockClear();
  (console.error as jest.Mock).mockClear();
};

/** Delivers the last re-check sent as the next invocation (the mocks cleared first), and returns its result. */
const runLastRecheck = (handler: Handler): Promise<SQSBatchResponse> => {
  const recheck = deliverLastRecheck();
  nextInvocation();
  return handler(recheck);
};

const OLDER_THAN_LISTING = "congress.gov's bill answer is older than its listing; it is checked again later";
const SUPERSEDED = "A later listing of the bill was stored since; it checks the bill itself, so this re-check stops";
const storedListedAt = () => fake.json<{ metadata: { listedAt?: string } }>(RAW_KEY)?.metadata.listedAt;

describe("olderCopy: the rules", () => {
  it.each([
    [undefined, "off"],
    ["", "off"],
    [" off ", "off"],
    ["watch", "watch"],
    ["on", "on"],
    [" ON ", "on"],
    ["yes", "watch"],
  ])("OLDER_COPY_RECHECK %p is %p (a value it does not know only watches)", (value, mode) => {
    expect(parseOlderCopyRecheckMode(value)).toBe(mode);
  });

  it("reads a re-check's attempt and update time, and nothing else as a re-check", () => {
    expect(olderCopyRecheckOf({ attempt: 2, updateDate: OLD_UPDATE })).toEqual({ attempt: 2, updateDate: OLD_UPDATE });
    expect(olderCopyRecheckOf({ attempt: 1, updateDate: "July" })).toEqual({ attempt: 1, updateDate: null });
    expect(olderCopyRecheckOf({ attempt: 1 })).toEqual({ attempt: 1, updateDate: null });
    for (const value of [undefined, null, 1, "1", {}, { attempt: 0 }, { attempt: 1.5 }, { attempt: "1" }]) {
      expect(olderCopyRecheckOf(value)).toBeNull();
    }
  });

  it("dates only the poller's messages, by the run start in their id", () => {
    expect(pollerListingTimeMs(BODY, POLLER_ID)).toBe(Date.parse(LISTED_AT));
    expect(pollerListingTimeMs({ ...BODY, textRetryAttempt: 1 }, POLLER_ID)).toBe(Date.parse(LISTED_AT));
    for (const [body, id] of [
      [BODY, `rel56:${LISTED_AT}:BILLS-119hr77`],
      [BODY, `refetch:${LISTED_AT}:BILLS-119hr77`],
      [BODY, "repair-official-votes-20261020:BILLS-119hr77"],
      [BODY, undefined],
      [{ ...BODY, noTextRetry: true }, POLLER_ID],
      [{ ...BODY, bulk: true }, POLLER_ID],
    ] as const) {
      expect(pollerListingTimeMs(body, id)).toBeNull();
    }
  });

  it("takes the later of updateDate and updateDateIncludingText, from an answer or a stored copy", () => {
    const answer = { bill: { updateDate: OLD_UPDATE, updateDateIncludingText: LISTED_UPDATE } };
    expect(billAnswerUpdateMs(answer)).toBe(Date.parse(LISTED_UPDATE));
    expect(billAnswerUpdateMs(answer.bill)).toBe(Date.parse(LISTED_UPDATE));
    expect(billAnswerUpdateMs({ bill: { updateDate: OLD_UPDATE } })).toBe(Date.parse(OLD_UPDATE));
    expect(billAnswerUpdateMs({ bill: { updateDate: "2026-07-28" } })).toBeNull();
    expect(billAnswerUpdateMs(undefined)).toBeNull();
    expect(storedCopyUpdateMs({ content: { bill: answer } })).toBe(Date.parse(LISTED_UPDATE));
    expect(storedCopyUpdateMs({ content: {} })).toBeNull();
    expect(storedCopyUpdateMs(null)).toBeNull();
  });

  it("calls an answer older than its listing only when its time is before the window's earliest start", () => {
    const listed = Date.parse(LISTED_AT);
    // The window's top is the run start in whole seconds (19:13:39), so its earliest start is 19:05:39.
    const edge = Date.parse("2026-11-19T19:05:39.000Z");
    expect(isOlderThanListing(edge, listed, 480)).toBe(false);
    expect(isOlderThanListing(edge - 1, listed, 480)).toBe(true);
    expect(isOlderThanListing(Date.parse(LISTED_UPDATE), listed, 480)).toBe(false);
    expect(isOlderThanListing(Date.parse(OLD_UPDATE), listed, 480)).toBe(true);
    expect(isOlderThanListing(null, listed, 480)).toBe(false);
  });

  it("decides a re-check: newer, caught_up, still_older, then gave_up on the last", () => {
    const base = {
      listedAtMs: Date.parse(LISTED_AT),
      windowSeconds: 480,
      attempt: 1,
      maxRechecks: 2,
    };
    const old = Date.parse(OLD_UPDATE);
    const listedUpdate = Date.parse(LISTED_UPDATE);
    expect(decideOlderCopyRecheck({ ...base, answerUpdateMs: listedUpdate, storedUpdateMs: old })).toBe("newer");
    expect(decideOlderCopyRecheck({ ...base, answerUpdateMs: null, storedUpdateMs: old })).toBe("newer");
    expect(decideOlderCopyRecheck({ ...base, answerUpdateMs: old, storedUpdateMs: null })).toBe("newer");
    expect(decideOlderCopyRecheck({ ...base, answerUpdateMs: listedUpdate, storedUpdateMs: listedUpdate })).toBe(
      "caught_up",
    );
    expect(decideOlderCopyRecheck({ ...base, answerUpdateMs: old, storedUpdateMs: listedUpdate })).toBe("caught_up");
    expect(decideOlderCopyRecheck({ ...base, answerUpdateMs: old, storedUpdateMs: old })).toBe("still_older");
    expect(decideOlderCopyRecheck({ ...base, attempt: 2, answerUpdateMs: old, storedUpdateMs: old })).toBe("gave_up");
  });

  it("calls a re-check superseded only when the stored copy records a later listing than its own", () => {
    const listed = Date.parse(LISTED_AT);
    expect(storedCopyListedAtMs({ metadata: { listedAt: LATER_LISTED_AT } })).toBe(Date.parse(LATER_LISTED_AT));
    // A copy without metadata.listedAt (stored under FETCH_RETRY_BACKOFF off, or before it) records no listing: its
    // fetchedAt is no listing time.
    for (const rawBill of [{ metadata: { fetchedAt: LATER_LISTED_AT } }, { metadata: {} }, {}, null, undefined]) {
      expect(storedCopyListedAtMs(rawBill)).toBeNull();
    }
    expect(isRecheckSuperseded(Date.parse(LATER_LISTED_AT), listed)).toBe(true);
    // Its own listing (the copy its first fetch, or a newer re-check, stored) and an earlier one are not later.
    expect(isRecheckSuperseded(listed, listed)).toBe(false);
    expect(isRecheckSuperseded(listed - 300_000, listed)).toBe(false);
    expect(isRecheckSuperseded(null, listed)).toBe(false);
  });
});

describe('OLDER_COPY_RECHECK "on" (as shipped)', () => {
  it("stores the older copy as before, then sends the message back 15 minutes later with the same id", async () => {
    const handler = loadHandler("on");
    congress.billUpdates = [OLD_UPDATE];

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([]);
    // Stored and sent on as before: never worse than the stored copy.
    expect(storedUpdate()).toBe(OLD_UPDATE);
    expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
    const [recheck] = rechecksSent();
    expect(rechecksSent()).toHaveLength(1);
    expect(recheck.DelaySeconds).toBe(900);
    expect(recheck.MessageAttributes?.correlationId?.StringValue).toBe(POLLER_ID);
    expect(JSON.parse(recheck.MessageBody)).toEqual({
      ...BODY,
      olderCopyRecheck: { attempt: 1, updateDate: "2026-07-28T08:06:33.000Z" },
    });
    expect(metricDatums("RawBillOlderThanListing").map((datum) => datum.Value)).toEqual([1]);
    expect(lineWith(OLDER_THAN_LISTING)).toMatchObject({
      event: "older_copy",
      billUpdatedAt: "2026-07-28T08:06:33.000Z",
      listedAt: LISTED_AT,
      listingWindowSeconds: 480,
      recheckAttempt: 0,
      nextRecheckAttempt: 1,
      maxRechecks: 5,
      delaySeconds: 900,
    });
  });

  it("sends nothing more for an answer as new as its listing, or on the window's edge", async () => {
    for (const update of [LISTED_UPDATE, "2026-11-19T19:05:39Z"]) {
      const handler = loadHandler("on");
      congress.billUpdates = [update];
      nextInvocation();
      expect((await handler(event())).batchItemFailures).toEqual([]);
      expect(storedUpdate()).toBe(update);
      expect(rechecksSent()).toEqual([]);
      expect(metricDatums("RawBillOlderThanListing")).toEqual([]);
    }
  });

  it("reads only the bill's answer while it stays older, then fetches the bill in full once it is newer", async () => {
    const handler = loadHandler("on");
    // The first fetch and the first re-check get the July copy; the second re-check gets the listed update.
    congress.billUpdates = [OLD_UPDATE, OLD_UPDATE, LISTED_UPDATE];
    await handler(event());
    const firstVersions = fake.contentVersions(RAW_KEY).length;

    expect((await runLastRecheck(handler)).batchItemFailures).toEqual([]);
    // One call, nothing stored, nothing sent on but the next re-check.
    expect(congress.requests).toEqual(["/v3/bill/119/hr/77"]);
    expect(fake.contentVersions(RAW_KEY)).toHaveLength(firstVersions);
    expect(sentTo(DIFFER_QUEUE)).toEqual([]);
    expect(rechecksSent()).toHaveLength(1);
    expect(JSON.parse(rechecksSent()[0].MessageBody).olderCopyRecheck).toEqual({
      attempt: 2,
      updateDate: "2026-07-28T08:06:33.000Z",
    });
    expect(recheckOutcomes()).toEqual(["still_older"]);
    expect(metricDatums("RawBillOlderThanListing")).toEqual([]);

    expect((await runLastRecheck(handler)).batchItemFailures).toEqual([]);
    // The bill's answer once (the re-check's), then the other seven endpoints.
    expect(billAnswerRequests()).toBe(1);
    expect(congress.requests).toHaveLength(8);
    expect(storedUpdate()).toBe(LISTED_UPDATE);
    expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
    expect(rechecksSent()).toEqual([]);
    expect(recheckOutcomes()).toEqual(["newer"]);
    expect(metricDatums("CongressApiCallsCore").map((datum) => datum.Value)).toEqual([1, 7]);
    expect(lineWith("Successfully processed bill")).toMatchObject({ callBudgetUsed: 8 });
  });

  it("re-checks 5 times by default, 15 minutes apart, one call each, then gives up: the stored copy stays", async () => {
    const handler = loadHandler("on");
    congress.billUpdates = [OLD_UPDATE];
    await handler(event());
    // The first fetch stored its own listing; that is not a later one.
    expect(storedListedAt()).toBe(LISTED_AT);

    for (const attempt of [1, 2, 3, 4]) {
      expect((await runLastRecheck(handler)).batchItemFailures).toEqual([]);
      expect(congress.requests).toEqual(["/v3/bill/119/hr/77"]);
      expect(recheckOutcomes()).toEqual(["still_older"]);
      const [next] = rechecksSent();
      expect(next.DelaySeconds).toBe(900);
      expect(JSON.parse(next.MessageBody).olderCopyRecheck).toEqual({
        attempt: attempt + 1,
        updateDate: "2026-07-28T08:06:33.000Z",
      });
    }

    const result = await runLastRecheck(handler);

    expect(result.batchItemFailures).toEqual([]);
    expect(congress.requests).toEqual(["/v3/bill/119/hr/77"]);
    expect(storedUpdate()).toBe(OLD_UPDATE);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(recheckOutcomes()).toEqual(["gave_up"]);
    expect(
      lineWith("Checked congress.gov's bill answer again: still older than its listing; the stored copy stays"),
    ).toMatchObject({
      level: "WARN",
      outcome: "gave_up",
      recheckAttempt: 5,
      maxRechecks: 5,
      storedUpdatedAt: "2026-07-28T08:06:33.000Z",
    });
  });

  it("stops with no call when a later listing was stored since (superseded)", async () => {
    const handler = loadHandler("on");
    congress.billUpdates = [OLD_UPDATE, LISTED_UPDATE];
    await handler(event());
    const recheck = deliverLastRecheck();
    // The next run's listing fetches the bill and gets the update.
    nextInvocation();
    await handler(event(BODY, LATER_ID));
    expect(storedUpdate()).toBe(LISTED_UPDATE);
    expect(storedListedAt()).toBe(LATER_LISTED_AT);
    const versions = fake.contentVersions(RAW_KEY).length;

    nextInvocation();
    expect((await handler(recheck)).batchItemFailures).toEqual([]);

    expect(congress.requests).toEqual([]);
    expect(fake.contentVersions(RAW_KEY)).toHaveLength(versions);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(recheckOutcomes()).toEqual(["superseded"]);
    expect(metricDatums("CongressApiCallsCore")).toEqual([]);
    expect(lineWith(SUPERSEDED)).toMatchObject({
      level: "INFO",
      event: "older_copy_recheck",
      outcome: "superseded",
      recheckAttempt: 1,
      listedAt: LISTED_AT,
      storedListedAt: LATER_LISTED_AT,
    });
  });

  it("leaves a bill congress.gov re-stamps to its latest listing's re-checks: the earlier ones make no call", async () => {
    const handler = loadHandler("on");
    // Listed again 5 minutes later, its answer still the July copy: each listing finds it older.
    congress.billUpdates = [OLD_UPDATE];
    await handler(event());
    const first = deliverLastRecheck();
    nextInvocation();
    await handler(event(BODY, LATER_ID));
    const later = deliverLastRecheck();
    expect(later.Records[0].messageAttributes.correlationId.stringValue).toBe(LATER_ID);

    nextInvocation();
    await handler(first);
    expect(congress.requests).toEqual([]);
    expect(recheckOutcomes()).toEqual(["superseded"]);

    nextInvocation();
    await handler(later);
    expect(congress.requests).toEqual(["/v3/bill/119/hr/77"]);
    expect(recheckOutcomes()).toEqual(["still_older"]);
  });

  it("calls as before when the stored copy records no listing (stored under FETCH_RETRY_BACKOFF off)", async () => {
    congress.billUpdates = [OLD_UPDATE, LISTED_UPDATE];
    await loadHandler("on")(event());
    const recheck = deliverLastRecheck();
    // A later listing stored without metadata.listedAt: it gets the update, but records no listing.
    nextInvocation();
    await loadHandler("on", { FETCH_RETRY_BACKOFF: "off" })(event(BODY, LATER_ID));
    expect(storedUpdate()).toBe(LISTED_UPDATE);
    expect(storedListedAt()).toBeUndefined();

    const handler = loadHandler("on");
    nextInvocation();
    expect((await handler(recheck)).batchItemFailures).toEqual([]);

    expect(congress.requests).toEqual(["/v3/bill/119/hr/77"]);
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(recheckOutcomes()).toEqual(["caught_up"]);
  });

  it("fetches a newer answer that is still older than its listing, and checks it once more", async () => {
    const handler = loadHandler("on", { OLDER_COPY_MAX_RECHECKS: "2" });
    congress.billUpdates = [OLD_UPDATE, BETWEEN_UPDATE];
    await handler(event());

    await runLastRecheck(handler);
    expect(storedUpdate()).toBe(BETWEEN_UPDATE);
    // The re-check's own store keeps its listing: no later one, so the next re-check calls.
    expect(storedListedAt()).toBe(LISTED_AT);
    expect(sentTo(DIFFER_QUEUE)).toHaveLength(1);
    expect(recheckOutcomes()).toEqual(["newer"]);
    expect(JSON.parse(rechecksSent()[0].MessageBody).olderCopyRecheck).toEqual({
      attempt: 2,
      updateDate: "2026-11-19T18:40:02.000Z",
    });
    // Counted once, on the first fetch.
    expect(metricDatums("RawBillOlderThanListing")).toEqual([]);

    await runLastRecheck(handler);
    expect(congress.requests).toEqual(["/v3/bill/119/hr/77"]);
    expect(recheckOutcomes()).toEqual(["gave_up"]);
    expect(storedUpdate()).toBe(BETWEEN_UPDATE);
  });

  it("warns when the last re-check's full fetch is still older than its listing, and sends nothing more", async () => {
    const handler = loadHandler("on", { OLDER_COPY_MAX_RECHECKS: "1" });
    congress.billUpdates = [OLD_UPDATE, BETWEEN_UPDATE];
    await handler(event());

    await runLastRecheck(handler);

    expect(storedUpdate()).toBe(BETWEEN_UPDATE);
    expect(rechecksSent()).toEqual([]);
    expect(
      lineWith("congress.gov's bill answer is still older than its listing after its last re-check"),
    ).toMatchObject({ level: "WARN", recheckAttempt: 1, maxRechecks: 1 });
  });

  it("uses the update time the re-check carries when the stored copy cannot be read", async () => {
    const handler = loadHandler("on");
    congress.billUpdates = [OLD_UPDATE];
    await handler(event());
    const recheck = deliverLastRecheck();
    nextInvocation();
    mockS3Send.mockImplementationOnce(() => Promise.reject(new Error("S3 is down")));

    expect((await handler(recheck)).batchItemFailures).toEqual([]);

    expect(recheckOutcomes()).toEqual(["still_older"]);
    expect(
      lineWith("Could not read the stored raw bill for an older-copy re-check; using the update time it carries"),
    ).toBeDefined();
  });

  it("fails the record, to retry it, when the bill's answer cannot be read on a re-check", async () => {
    const handler = loadHandler("on");
    congress.billUpdates = [OLD_UPDATE];
    await handler(event());
    const recheck = deliverLastRecheck();
    nextInvocation();
    congress.billStatus = 500;

    const result = await handler(recheck);

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(rechecksSent()).toEqual([]);
    expect(lineWith("Failed record will be retried")).toMatchObject({ failedEndpoint: "bill" });
  });

  it("fails the record when the re-check cannot be sent, so SQS retries it", async () => {
    const handler = loadHandler("on");
    congress.billUpdates = [OLD_UPDATE];
    mockSqsSend.mockImplementation((cmd) =>
      Promise.resolve(
        cmd?.__sqs === "SendMessageBatch" && cmd.input.QueueUrl === UPDATED_QUEUE
          ? { Failed: [{ Id: "older-copy-recheck-1", Message: "throttled" }] }
          : {},
      ),
    );

    const result = await handler(event());

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(allLines().some((line) => JSON.stringify(line).includes("Failed to schedule the older-copy re-check"))).toBe(
      true,
    );
  });

  it.each([
    ["the REL-56 backfill", { ...BODY, noTextRetry: true }, `rel56:${LISTED_AT}:BILLS-119hr77`],
    ["refetch:stale-bills", { ...BODY, noTextRetry: true }, `refetch:${LISTED_AT}:BILLS-119hr77`],
    ["backfill:cosponsors", { ...BODY, bulk: true }, POLLER_ID],
    ["a message without an id", BODY, null],
  ])("never re-checks a message that is not the poller's: %s", async (_name, body, correlationId) => {
    const handler = loadHandler("on");
    congress.billUpdates = [OLD_UPDATE];

    expect((await handler(event(body, correlationId))).batchItemFailures).toEqual([]);

    expect(storedUpdate()).toBe(OLD_UPDATE);
    expect(rechecksSent()).toEqual([]);
    expect(metricDatums("RawBillOlderThanListing")).toEqual([]);
  });

  it("leaves it to the bill text retry when that is sent too: it fetches the whole bill again", async () => {
    const handler = loadHandler("on");
    congress.billUpdates = [OLD_UPDATE];
    congress.xmlStatus = 403;

    expect((await handler(event())).batchItemFailures).toEqual([]);

    const sent = sentTo(UPDATED_QUEUE);
    expect(sent.map((entry) => entry.Id)).toEqual(["text-retry-1"]);
    expect(metricDatums("RawBillOlderThanListing").map((datum) => datum.Value)).toEqual([1]);
    expect(
      lineWith("congress.gov's bill answer is older than its listing; the bill text retry fetches it again"),
    ).toMatchObject({ recheckAttempt: 0 });
  });
});

describe('OLDER_COPY_RECHECK "watch" and "off"', () => {
  it('"watch" logs and counts an older answer, and sends nothing', async () => {
    const handler = loadHandler("watch");
    congress.billUpdates = [OLD_UPDATE];

    await handler(event());

    expect(storedUpdate()).toBe(OLD_UPDATE);
    expect(rechecksSent()).toEqual([]);
    expect(metricDatums("RawBillOlderThanListing").map((datum) => datum.Value)).toEqual([1]);
    expect(
      lineWith("congress.gov's bill answer is older than its listing; it would be checked again (watch)"),
    ).toMatchObject({ olderCopyRecheckMode: "watch", recheckAttempt: 0 });
  });

  it('"off" (unset, the code default) compares nothing', async () => {
    const handler = loadHandler(undefined);
    congress.billUpdates = [OLD_UPDATE];

    await handler(event());

    expect(storedUpdate()).toBe(OLD_UPDATE);
    expect(rechecksSent()).toEqual([]);
    expect(metricDatums("RawBillOlderThanListing")).toEqual([]);
    expect(allLines().some((line) => line.event === "older_copy")).toBe(false);
  });

  it.each([["watch"], [undefined]])(
    "a re-check sent before the switch went to %p is fetched in full, as any message, and sends nothing",
    async (mode) => {
      congress.billUpdates = [OLD_UPDATE, LISTED_UPDATE];
      await loadHandler("on")(event());
      const recheck = deliverLastRecheck();
      const handler = loadHandler(mode);
      nextInvocation();

      expect((await handler(recheck)).batchItemFailures).toEqual([]);

      expect(congress.requests).toHaveLength(8);
      expect(storedUpdate()).toBe(LISTED_UPDATE);
      expect(rechecksSent()).toEqual([]);
      expect(recheckOutcomes()).toEqual([]);
    },
  );
});
