import { EventEmitter } from "events";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { OfficialVotesBreakdown, ProcessedBillDocument, RawBill } from "../models/bill";
import { extractOfficialVotesFromActions } from "../shared/congressVotes";
import { SOURCE_METADATA_KEYS, sourceTextHash } from "../shared/billSourceReconcile";
import { asSqsEvent } from "./fixtures/awsEvents";
import { FakeVersionedS3 } from "./fakeVersionedS3";
import { logLines } from "./logLines";

// REL-30 / REL-33 races, end to end: the real billDiffer, billSummarizer, enrichOfficialVotes and
// notificationType handlers (and the REL-31 repair script's write) run against an in-memory
// versioned bucket. SQS queues are in memory and drained by hand, so each test fixes one
// interleaving of the writers. Bedrock answers deterministically from the bill text it is sent.

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

/** A message body as the pipeline queues carry it: the fields the tests read, any other field open. */
interface SentBody {
  guid?: string;
  notificationType?: string;
  [field: string]: unknown;
}

type SentMessage = { queueUrl: string; body: SentBody };

/** What the fake SQS reads from a command the mocked constructors below return. */
interface FakeSqsCommand {
  __cmd: string;
  input: {
    QueueName?: string;
    QueueUrl?: string;
    MessageBody?: string;
    Entries?: Array<{ Id?: string; MessageBody?: string }>;
  };
}

const mockSent: SentMessage[] = [];
const mockSqsSend = jest.fn(async (command: FakeSqsCommand) => {
  const input = command.input;
  if (command.__cmd === "GetQueueUrl") return { QueueUrl: `https://sqs.example/${input.QueueName}` };
  if (command.__cmd === "SendMessage") {
    mockSent.push({ queueUrl: input.QueueUrl!, body: JSON.parse(input.MessageBody!) });
    return { MessageId: `sent-${mockSent.length}` };
  }
  for (const entry of input.Entries!)
    mockSent.push({ queueUrl: input.QueueUrl!, body: JSON.parse(entry.MessageBody!) });
  return { Successful: input.Entries!.map((entry) => ({ Id: entry.Id })), Failed: [] };
});
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: (command: FakeSqsCommand) => mockSqsSend(command) })),
  SendMessageBatchCommand: jest.fn((input: unknown) => ({ __cmd: "SendMessageBatch", input })),
  SendMessageCommand: jest.fn((input: unknown) => ({ __cmd: "SendMessage", input })),
  GetQueueUrlCommand: jest.fn((input: unknown) => ({ __cmd: "GetQueueUrl", input })),
}));

// Companion link lists (APPF-23): no stored row unless a test says otherwise.
const mockDdbSend = jest.fn(async (_command: unknown): Promise<Record<string, unknown>> => ({}));
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: (command: unknown) => mockDdbSend(command) })),
}));

jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: async () => ({ SecretString: JSON.stringify({ congressApiKey: "test-key" }) }),
  })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ input })),
}));
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: jest.fn(() => ({ send: async () => ({}) })),
  PutMetricDataCommand: jest.fn((input: unknown) => ({ input })),
}));

// Bedrock: one analysis per bill in the prompt; soWhat names the text version it read.
let mockSummaryVariant = "";
// Set to make every Bedrock call fail (a deterministic error: the summarizer fails the record).
let mockBedrockError: Error | null = null;
const mockDuringBedrock: Array<() => Promise<void>> = [];
const mockBedrockSend = jest.fn(async (command: { input: { body: string } }) => {
  const during = mockDuringBedrock.shift();
  if (during) await during();
  if (mockBedrockError) throw mockBedrockError;
  const prompt: string = JSON.parse(command.input.body).messages[0].content[0].text;
  const bills: Array<{ guid: string; text?: string }> = JSON.parse(prompt.slice(prompt.indexOf("Bills: ") + 7));
  const analyses = bills.map((bill) => ({
    guid: bill.guid,
    title: "Expands rural broadband",
    billBreakdown: {
      who: "Rural internet providers.",
      what: "Creates a grant program.",
      how: "The Secretary gives grants.",
      when: "The provided text does not say.",
      where: "Rural areas.",
      why: "The bill states its purpose is rural broadband.",
    },
    soWhat: `Summary of ${/text (\w+)/.exec(bill.text ?? "")?.[1] ?? "unknown"}${mockSummaryVariant}.`,
    subCategories: ["Telecommunications"],
    lifeAreas: ["Digital Services"],
    civicProfile: { localVsFederal: 0.4 },
  }));
  const response = {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "haiku",
    content: [{ type: "text", text: JSON.stringify({ bills: analyses }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200 },
  };
  return { body: new TextEncoder().encode(JSON.stringify(response)) };
});
jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: (command: { input: { body: string } }) => mockBedrockSend(command) })),
  InvokeModelCommand: jest.fn((input: unknown) => ({ input })),
}));

// congress.gov House roll-call members for enrichOfficialVotes; another status fails every call.
let mockHttpsStatus = 200;
const mockHouseMembers = [
  { bioguideID: "A000001", firstName: "Jane", lastName: "Doe", voteParty: "D", voteState: "CA", voteCast: "Yea" },
  { bioguideID: "B000002", firstName: "John", lastName: "Smith", voteParty: "R", voteState: "TX", voteCast: "Nay" },
];
/** The response the fake https request hands its callback. */
interface FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
}

/** The request the fake https request returns. */
interface FakeRequest extends EventEmitter {
  setTimeout: () => FakeRequest;
  destroy: () => FakeRequest;
  end: () => void;
}

const mockHttpsRequest = jest.fn((_url: unknown, _options: unknown, callback: (res: FakeResponse) => void) => {
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = mockHttpsStatus;
  res.headers = {};
  const req = new EventEmitter() as FakeRequest;
  req.setTimeout = () => req;
  req.destroy = () => req;
  req.end = () => {
    callback(res);
    res.emit(
      "data",
      res.statusCode === 200 ? JSON.stringify({ houseRollCallVoteMemberVotes: { results: mockHouseMembers } }) : "{}",
    );
    res.emit("end");
  };
  return req;
});
jest.mock("https", () => ({
  request: (...args: [unknown, unknown, (res: FakeResponse) => void]) => mockHttpsRequest(...args),
}));

const BUCKET = "billboard-bill-store-bucket";
const Q = {
  differ: "https://sqs.example/BillDifferQueue",
  summarizer: "https://sqs.example/BillSummarizerQueue",
  enrichment: "https://sqs.example/BillVoteEnrichmentQueue",
  userMatcher: "https://sqs.example/UserMatcherQueue",
};
const GUID = "BILLS-119hr6959";
const RAW_KEY = `raw-bills/${GUID}.json`;
const PROCESSED_KEY = `processed-bills/${GUID}.json`;

/** A handler as the tests drive it: an SQS event, and for billSummarizer a context with the time left. */
type Handler = (event: SQSEvent, context?: { getRemainingTimeInMillis: () => number }) => Promise<SQSBatchResponse>;

/** Loads a handler module with its own env (each reads QUEUE_URL and the rest at load time). */
const loadHandler = (path: string, env: Record<string, string>): Handler => {
  const saved = process.env;
  process.env = { ...saved, ...env };
  let mod: { handler: Handler } | undefined;
  try {
    jest.isolateModules(() => {
      mod = require(path);
    });
  } finally {
    process.env = saved;
  }
  return mod!.handler;
};

let billDiffer: Handler;
let billSummarizer: Handler;
let enrichOfficialVotes: Handler;
let notificationType: Handler;
let repair: typeof import("../../scripts/repairOfficialVoteTallies");
let houseRepair: typeof import("../../scripts/repairHouseVoteCounts");

beforeAll(() => {
  process.env.SECRET_NAME = "CongressAPIKey";
  billDiffer = loadHandler("../handlers/billDiffer", {
    BUCKET_NAME: BUCKET,
    QUEUE_URL: Q.summarizer,
    QUEUE_BATCH_SIZE: "10",
    RAW_BILLS_PREFIX: "raw-bills/",
  });
  billSummarizer = loadHandler("../handlers/billSummarizer", {
    BUCKET_NAME: BUCKET,
    MODEL_ID: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0",
    MAX_BILLS_PER_BATCH: "5",
    MAX_OUTPUT_TOKENS: "4096",
  });
  enrichOfficialVotes = loadHandler("../handlers/enrichOfficialVotes", {
    BUCKET_NAME: BUCKET,
    SECRET_NAME: "CongressAPIKey",
    QUEUE_URL: Q.differ,
    ENRICHMENT_QUEUE_URL: Q.enrichment,
    CONGRESS_VOTE_CALL_DELAY_MS: "0",
    CONGRESS_API_BASE_DELAY_MS: "0",
    CONGRESS_API_MAX_DELAY_MS: "0",
  });
  notificationType = loadHandler("../handlers/notificationType", {
    BUCKET_NAME: BUCKET,
    QUEUE_URL: Q.userMatcher,
    QUEUE_BATCH_SIZE: "10",
  });
  jest.isolateModules(() => {
    repair = require("../../scripts/repairOfficialVoteTallies");
    houseRepair = require("../../scripts/repairHouseVoteCounts");
  });
});

afterAll(() => {
  delete process.env.SECRET_NAME;
});

// ── Raw bills, shaped like fetchRawBill's ────────────────────────────────────

const billXml = (label: string) =>
  `<?xml version="1.0"?><bill><form><legis-type>A BILL</legis-type><official-title>To expand rural broadband.</official-title></form>` +
  `<legis-body><section><enum>1.</enum><header>Short title</header><text>This Act may be cited as the Rural Broadband Act, text ${label}.</text></section></legis-body></bill>`;

const INTRODUCED = {
  actionDate: "2026-01-10",
  actionCode: "Intro-H",
  text: "Introduced in House",
  type: "IntroReferral",
};
const PASSAGE = {
  actionDate: "2026-01-30",
  actionCode: "8000",
  text: "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 31).",
  type: "Floor",
  recordedVotes: [{ chamber: "House", congress: 119, rollNumber: 31, sessionNumber: 2, date: "2026-01-30T15:00:00Z" }],
};
// Before REL-31 the parser read this Congressional Record page range as a House vote of 4758 to 4759.
const PASSED_WITHOUT_OBJECTION = {
  actionDate: "2026-01-20",
  actionCode: "H37300",
  text: "On motion to suspend the rules and pass the bill Agreed to without objection. (text: CR H4758-4759)",
  type: "Floor",
};

const rawDoc = (
  options: { text?: string | null; actions?: Array<Record<string, unknown>>; fetchedAt?: string; title?: string } = {},
) => {
  const fetchedAt = options.fetchedAt ?? "2026-02-01T21:20:00.000Z";
  const title = options.title ?? "Rural Broadband Act";
  const actions = options.actions ?? [INTRODUCED];
  const content: Record<string, unknown> = {
    bill: { bill: { congress: 119, type: "HR", number: "6959", title, sponsors: [{ bioguideId: "S000001" }] } },
    ...(options.text === null ? {} : { billXML: billXml(options.text ?? "v1") }),
    actions: { actions },
    committees: { committees: [] },
    cosponsors: { cosponsors: [{ bioguideId: "C000001" }], pagination: { count: 1 } },
  };
  const officialVotes = extractOfficialVotesFromActions(content);
  if (officialVotes) content.officialVotes = officialVotes;
  return {
    schemaVersion: 1,
    kind: "raw",
    storedAt: fetchedAt,
    identifier: { congress: "119", billType: "hr", billNumber: "6959" },
    metadata: {
      guid: GUID,
      title,
      pubDate: "2026-01-10",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/house-bill/6959",
      fetchedAt,
    },
    content,
  };
};

/** The source-text-hash of rawDoc's text `label`. */
const textHashOf = (label: string): string => sourceTextHash(rawDoc({ text: label }) as unknown as RawBill);

// ── Writers and queues ───────────────────────────────────────────────────────

let msgSeq = 0;
const record = (body: unknown) => ({ messageId: `m${++msgSeq}`, body: JSON.stringify(body), messageAttributes: {} });

/** The S3 and SQS clients the repair scripts take, standing in with the in-memory bucket and queues. */
const fakeClients = (): [Parameters<typeof repair.applyRepairs>[0], Parameters<typeof repair.applyRepairs>[1]] => [
  mockS3 as unknown as Parameters<typeof repair.applyRepairs>[0],
  { send: mockSqsSend } as unknown as Parameters<typeof repair.applyRepairs>[1],
];

/** An SQS event with one record per body. */
const sqsEvent = (...bodies: unknown[]): SQSEvent => asSqsEvent({ Records: bodies.map(record) });

/** fetchRawBill: stores the whole document and hands the bill to BillDifferQueue. */
const fetchRaw = (doc: unknown): string => {
  const versionId = mockS3.put(RAW_KEY, doc, { "correlation-id": `fetch:${GUID}` });
  mockSent.push({ queueUrl: Q.differ, body: { guid: GUID } });
  return versionId;
};

/** The real enrichOfficialVotes for the bill (it writes the members with IfMatch and sends to BillDifferQueue). */
const enrich = (): Promise<SQSBatchResponse> => enrichOfficialVotes(sqsEvent({ guid: GUID }));

const take = (queueUrl: string): SentMessage[] => {
  const taken = mockSent.filter((message) => message.queueUrl === queueUrl);
  for (const message of taken) mockSent.splice(mockSent.indexOf(message), 1);
  return taken;
};

const runDiffer = (...bodies: unknown[]) => billDiffer(sqsEvent(...bodies));
const runSummarizer = (...bodies: unknown[]) =>
  billSummarizer(sqsEvent(...bodies), { getRemainingTimeInMillis: () => 600_000 });

const takeFirst = (queueUrl: string): SentMessage | undefined => {
  const index = mockSent.findIndex((message) => message.queueUrl === queueUrl);
  return index < 0 ? undefined : mockSent.splice(index, 1)[0];
};

/** BillDifferQueue messages one invocation each, oldest first, until the queue is empty. */
const drainDifferOneByOne = async (): Promise<string[]> => {
  const outcomes: string[] = [];
  for (let message = takeFirst(Q.differ); message; message = takeFirst(Q.differ)) {
    await runDiffer(message.body);
    outcomes.push(lastDiffOutcome());
  }
  return outcomes;
};
const drainSummarizer = async () => {
  const messages = take(Q.summarizer);
  return messages.length > 0 ? runSummarizer(...messages.map((message) => message.body)) : undefined;
};

const diffLines = () => logLines(console.log).filter((line) => line.message === "Diffed raw bill");
const lastDiffOutcome = (): string => diffLines().at(-1)?.outcome as string;
const metricCount = (name: string): number =>
  logLines(console.log).filter((line) => line._aws && typeof line[name] === "number").length;

const processed = () => mockS3.json<ProcessedBillDocument>(PROCESSED_KEY)!;
const processedVersions = () => mockS3.contentVersions(PROCESSED_KEY);
const processedPuts = () => mockS3.commands("PutObject", PROCESSED_KEY);
const houseMemberIds = (doc?: { officialVotes?: unknown }): string[] =>
  ((doc?.officialVotes as OfficialVotesBreakdown | undefined)?.house?.members ?? [])
    .map((member) => member.bioguideId)
    .sort();

/** notificationType on the processed bill's current version: the push types it sends. */
const notificationTypes = async (): Promise<string[]> => {
  const versionId = mockS3.current(PROCESSED_KEY)!.versionId;
  await notificationType(sqsEvent({ Records: [{ s3: { object: { key: PROCESSED_KEY, versionId } } }] }));
  return take(Q.userMatcher).map((message) => message.body.notificationType as string);
};

/** An existing bill: fetched, diffed and summarized from `doc` (its processed copy has source metadata). */
const existingBill = async (doc: unknown) => {
  fetchRaw(doc);
  await drainDifferOneByOne();
  await drainSummarizer();
  expect(processed()).toBeDefined();
  mockBedrockSend.mockClear();
};

beforeEach(() => {
  mockS3 = new FakeVersionedS3();
  mockSent.length = 0;
  mockSummaryVariant = "";
  mockBedrockError = null;
  mockHttpsStatus = 200;
  mockDuringBedrock.length = 0;
  mockBedrockSend.mockClear();
  mockHttpsRequest.mockClear();
  mockDdbSend.mockReset();
  mockDdbSend.mockImplementation(async () => ({}));
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe("REL-30: a new bill is always summarized", () => {
  it("control: billDiffer runs before the enrichment write", async () => {
    const v1 = fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    expect(mockSent).toEqual([{ queueUrl: Q.summarizer, body: { guid: GUID, rawVersionId: v1 } }]);
    await drainSummarizer();

    await enrich();
    expect(await drainDifferOneByOne()).toEqual(["patched"]);

    expect(processed().soWhat).toBe("Summary of v1.");
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  it("A2: the enrichment write lands before billDiffer, and the two messages run in separate invocations", async () => {
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    await enrich();

    expect(await drainDifferOneByOne()).toEqual(["enqueued", "enqueued"]);
    const v2 = mockS3.current(RAW_KEY)!.versionId;
    expect(take(Q.summarizer).map((message) => message.body)).toEqual([
      { guid: GUID, rawVersionId: v2 },
      { guid: GUID, rawVersionId: v2 },
    ]);
  });

  it("A5: both messages in the same batch share one diff and enqueue once", async () => {
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    await enrich();

    const response = await runDiffer(...take(Q.differ).map((message) => message.body));

    expect(response).toMatchObject({ batchItemFailures: [], scanned: 1, enqueued: 1, updatedProcessed: 0 });
    await drainSummarizer();
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
  });

  it("a write landing between billDiffer's processed read and its raw read is diffed from the new version", async () => {
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    mockS3.afterGet(PROCESSED_KEY, async () => {
      await enrich();
    });

    expect(await drainDifferOneByOne()).toEqual(["enqueued", "enqueued"]);
    const v2 = mockS3.current(RAW_KEY)!.versionId;
    expect(mockSent.map((message) => message.body)).toEqual([
      { guid: GUID, rawVersionId: v2 },
      { guid: GUID, rawVersionId: v2 },
    ]);
    await drainSummarizer();

    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
    expect(processedVersions()).toHaveLength(1);
  });

  it("A3: a write landing right after billDiffer's raw read still ends with a summary that has the members", async () => {
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    mockS3.afterGet(RAW_KEY, async () => {
      await enrich();
    });

    expect(await drainDifferOneByOne()).toEqual(["enqueued", "enqueued"]);
    await drainSummarizer();

    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  it("A6: fetchRawBill retried (same content, new fetchedAt) before billDiffer ran", async () => {
    fetchRaw(rawDoc());
    fetchRaw(rawDoc({ fetchedAt: "2026-02-01T21:23:00.000Z" }));

    const response = await runDiffer(...take(Q.differ).map((message) => message.body));

    expect(response).toMatchObject({ enqueued: 1, batchItemFailures: [] });
    expect(take(Q.summarizer)).toHaveLength(1);
  });

  it("A7: the text arrives, then the enrichment write, before billDiffer handles the text's message", async () => {
    fetchRaw(rawDoc({ text: null, actions: [PASSAGE, INTRODUCED] }));
    expect(await drainDifferOneByOne()).toEqual(["awaiting_text"]);
    expect(take(Q.summarizer)).toEqual([]);

    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-03T00:00:00.000Z" }));
    await enrich();

    expect(await drainDifferOneByOne()).toEqual(["enqueued", "enqueued"]);
    await drainSummarizer();
    expect(processed().soWhat).toBe("Summary of v1.");
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
  });

  it("SQS redelivery after a DynamoDB error enqueues the summary", async () => {
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    mockDdbSend.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Throughput exceeds the current capacity"), {
        name: "ProvisionedThroughputExceededException",
      });
    });
    const [first] = take(Q.differ);
    const failed = await runDiffer(first.body);
    expect(failed.batchItemFailures).toHaveLength(1);
    expect(mockSent).toEqual([]);
    expect(mockS3.commands("PutObject", PROCESSED_KEY)).toEqual([]);

    await enrich(); // within the visibility timeout

    await runDiffer(first.body); // redelivered
    expect(lastDiffOutcome()).toBe("enqueued");
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    await drainSummarizer();
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
  });

  it("a DLQ redrive long after the raw bill moved on still summarizes it", async () => {
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    await enrich();
    const parked = take(Q.differ); // both messages failed into the DLQ
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-03-01T00:00:00.000Z" }));
    take(Q.differ); // and this one too

    await runDiffer(...parked.map((message) => message.body));
    expect(lastDiffOutcome()).toBe("enqueued");
  });

  it("A1b: the enrichment lands while billSummarizer is in Bedrock; one Bedrock call, members kept, one version", async () => {
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    await drainDifferOneByOne();
    mockDuringBedrock.push(async () => {
      await enrich();
      expect(await drainDifferOneByOne()).toEqual(["enqueued"]); // still no processed bill
    });

    await drainSummarizer(); // job 1 stores from the latest raw bill (same text)
    await drainSummarizer(); // job 2: already current, no Bedrock

    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
    expect(processedVersions()).toHaveLength(1);
    expect(metricCount("BillSummarizerAlreadyCurrent")).toBe(1);
    expect(await notificationTypes()).toEqual(["new"]);
  });

  it("A1b: two summarizer jobs both in Bedrock; the second create gets 412 and catches up (2 Bedrock calls, one version)", async () => {
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    await drainDifferOneByOne();
    const job1 = take(Q.summarizer);
    mockDuringBedrock.push(async () => {
      await enrich();
      await drainDifferOneByOne();
      await drainSummarizer(); // job 2 runs to completion while job 1 waits on Bedrock
    });

    const response = await runSummarizer(...job1.map((message) => message.body));

    expect(response.batchItemFailures).toEqual([]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);
    expect(processedVersions()).toHaveLength(1);
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
    expect(processedPuts().filter((put) => put.input.IfNoneMatch === "*")).toHaveLength(2);
  });
});

describe("REL-30: races on an existing bill", () => {
  it("B4: a passage action and the enrichment write both reach the processed bill, and notificationType sends passed", async () => {
    await existingBill(rawDoc());
    expect(processed().billStatus).toBe("New");

    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));
    await enrich(); // before billDiffer handles the fetch's message

    expect(await drainDifferOneByOne()).toEqual(["patched", "unchanged"]);
    expect(take(Q.summarizer)).toEqual([]);
    expect(processed().actions).toEqual([PASSAGE, INTRODUCED]);
    expect(processed().billStatus).toBe("Passed");
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
    expect(await notificationTypes()).toEqual(expect.arrayContaining(["passed"]));
  });

  it("B2: a text change followed by the enrichment write is enqueued (source hash)", async () => {
    await existingBill(rawDoc({ text: "v0", actions: [PASSAGE, INTRODUCED] }));
    fetchRaw(rawDoc({ text: "v1", actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));
    await enrich();

    expect(await drainDifferOneByOne()).toEqual(["enqueued", "enqueued"]);
    expect(diffLines().at(-1)).toMatchObject({ reason: "text_changed", decidedBy: "source-hash" });
    await drainSummarizer();
    expect(processed().soWhat).toBe("Summary of v1.");
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
  });

  it("B2 after the deploy on a legacy bill written before both raw writes: the anchor finds its text and enqueues", async () => {
    mockS3.put(RAW_KEY, rawDoc({ text: "v0" }));
    mockS3.put(PROCESSED_KEY, legacyProcessed("Summary of v0."), { "correlation-id": "old-lambda" });
    fetchRaw(rawDoc({ text: "v1", actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));
    await enrich();

    expect(await drainDifferOneByOne()).toEqual(["enqueued", "enqueued"]);
    // The first run's pre-summary patch stores the anchored hash as source-text-hash, so the second
    // run reads it from the metadata instead of the raw history, and still enqueues.
    expect(diffLines().map((line) => line.decidedBy)).toEqual(["legacy-anchor", "source-hash"]);
    expect(diffLines().every((line) => line.reason === "text_changed")).toBe(true);
    expect(metricCount("BillDifferLegacyAnchor")).toBe(1);
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: textHashOf("v0"),
    });
    expect(processed()).toMatchObject({ soWhat: "Summary of v0.", billStatus: "Passed" });
    await drainSummarizer();
    expect(processed().soWhat).toBe("Summary of v1.");
  });

  it("a legacy bill the old pipeline summarized from the current raw version is unchanged, not re-summarized", async () => {
    mockS3.put(RAW_KEY, rawDoc({ text: "v0" }));
    // A text change: the old billDiffer compared it with v0 and queued it, and billSummarizer built from it.
    mockS3.put(RAW_KEY, rawDoc({ text: "v1", fetchedAt: "2026-02-02T00:00:00.000Z" }));
    mockS3.put(PROCESSED_KEY, legacyProcessed("Summary of v1."), { "correlation-id": "old-lambda" });

    await runDiffer({ guid: GUID }); // the UA-28 reconcile, a no-op enrichment send or a redelivery

    expect(diffLines().at(-1)).toMatchObject({ outcome: "unchanged", decidedBy: "legacy-anchor" });
    expect(take(Q.summarizer)).toEqual([]);
    expect(mockS3.commands("GetObject", RAW_KEY).filter((call) => call.input.VersionId)).toEqual([]);
  });

  it("B2 left by the old billDiffer on a voted legacy bill is not recovered: its votes patch came after the new text", async () => {
    // Old code: the text fetch and the enrichment write both landed before the old billDiffer ran, so both runs
    // compared the enrichment write with the fetch, patched the members in (a processed write after both raw
    // writes) and never queued the summary. The anchor dates the summary by that write and finds v1's text.
    mockS3.put(RAW_KEY, rawDoc({ text: "v0", actions: [PASSAGE, INTRODUCED] }));
    fetchRaw(rawDoc({ text: "v1", actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));
    await enrich();
    mockS3.put(
      PROCESSED_KEY,
      {
        ...legacyProcessed("Summary of v0."),
        actions: [PASSAGE, INTRODUCED],
        billStatus: "Passed",
        officialVotes: mockS3.json<RawBill>(RAW_KEY)!.content.officialVotes,
      },
      { "correlation-id": "old-billDiffer-patch" },
    );

    expect(await drainDifferOneByOne()).toEqual(["unchanged", "unchanged"]);
    expect(diffLines().at(-1)).toMatchObject({ decidedBy: "legacy-anchor" });
    expect(take(Q.summarizer)).toEqual([]);
    expect(processed().soWhat).toBe("Summary of v0.");
  });

  it("B1c: billDiffer's patch gets 412 after a summary landed, and the retry keeps the new summary", async () => {
    await existingBill(rawDoc());
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));
    // A forced re-summary (no rawVersionId) stores between billDiffer's processed read and its write.
    mockS3.afterGet(PROCESSED_KEY, async () => {
      mockSummaryVariant = " (second pass)";
      await runSummarizer({ guid: GUID });
    });

    expect(await drainDifferOneByOne()).toEqual(["unchanged"]);

    expect(processed().soWhat).toBe("Summary of v1 (second pass).");
    expect(processed().actions).toEqual([PASSAGE, INTRODUCED]);
    expect(metricCount("BillDifferWriteConflict")).toBe(1);
    // Stored versions: the first summary and the second one; the refused patch of the first never landed.
    expect(processedVersions().map((version) => JSON.parse(version.body).soWhat)).toEqual([
      "Summary of v1 (second pass).",
      "Summary of v1.",
    ]);
  });

  it("B1b: a text change, then the enrichment while billSummarizer is in Bedrock: v2 members, at most 2 Bedrock calls", async () => {
    await existingBill(rawDoc({ text: "v0" }));
    fetchRaw(rawDoc({ text: "v1", actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    mockDuringBedrock.push(async () => {
      await enrich();
      expect(await drainDifferOneByOne()).toEqual(["enqueued"]); // the processed bill still has v0's text
    });

    await drainSummarizer();
    await drainSummarizer();

    expect(mockBedrockSend.mock.calls.length).toBeLessThanOrEqual(2);
    expect(processed().soWhat).toBe("Summary of v1.");
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
    expect(processed().billStatus).toBe("Passed");
  });

  it("a text change whose summary keeps failing still lands its actions, status and votes, and pushes passed", async () => {
    await existingBill(rawDoc({ text: "v0" }));
    mockBedrockError = Object.assign(new Error("Malformed input request"), { name: "ValidationException" });

    // The engrossed text arrives with the House passage.
    fetchRaw(rawDoc({ text: "v1", actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    expect(diffLines().at(-1)).toMatchObject({
      reason: "text_changed",
      changedFields: expect.arrayContaining(["actions"]),
    });
    expect(processed()).toMatchObject({
      soWhat: "Summary of v0.",
      actions: [PASSAGE, INTRODUCED],
      billStatus: "Passed",
    });
    expect(processed().officialVotes!.house).toMatchObject({ yea: 220, nay: 210 });
    expect(await notificationTypes()).toEqual(expect.arrayContaining(["alert", "passed"]));
    expect((await drainSummarizer())?.batchItemFailures).toHaveLength(1);

    // A redelivery of that message still sends the summary: the text is still pending.
    await runDiffer({ guid: GUID });
    expect(lastDiffOutcome()).toBe("enqueued");
    expect((await drainSummarizer())?.batchItemFailures).toHaveLength(1);

    // A later refetch: the same text and one more action.
    const received = {
      actionDate: "2026-02-03",
      actionCode: "10000",
      text: "Received in the Senate.",
      type: "IntroReferral",
    };
    fetchRaw(rawDoc({ text: "v1", actions: [received, PASSAGE, INTRODUCED], fetchedAt: "2026-02-03T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    expect(processed().actions).toEqual([received, PASSAGE, INTRODUCED]);
    expect(await notificationTypes()).toEqual(["alert"]);

    // Bedrock recovers: the summary of the new text lands over the patched fields.
    mockBedrockError = null;
    await drainSummarizer();
    expect(processed()).toMatchObject({ soWhat: "Summary of v1.", billStatus: "Passed" });
    expect(processed().actions).toEqual([received, PASSAGE, INTRODUCED]);
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: textHashOf("v1"),
    });
    expect(await notificationTypes()).toEqual(["updated"]);
  });
});

describe("REL-30: later raw writes while billSummarizer works", () => {
  // fetchRawBill stores a fetch without content.billXML when fetchBillXML gave up or the newest text
  // version has no Formatted XML yet, and still sends {"guid"}; billDiffer never re-sends for it.
  it("a refetch without bill text during Bedrock does not drop a new bill's summary", async () => {
    fetchRaw(rawDoc({ text: "v1", actions: [PASSAGE, INTRODUCED] }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    let textless = "";
    mockDuringBedrock.push(async () => {
      textless = fetchRaw(
        rawDoc({ text: null, actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-01T21:25:00.000Z" }),
      );
      expect(await drainDifferOneByOne()).toEqual(["awaiting_text"]);
    });

    const response = await drainSummarizer();

    expect(response?.batchItemFailures).toEqual([]);
    expect(processed()).toMatchObject({ soWhat: "Summary of v1.", billStatus: "Passed" });
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: textHashOf("v1"),
      [SOURCE_METADATA_KEYS.rawVersion]: textless,
      [SOURCE_METADATA_KEYS.fetchedAt]: "2026-02-01T21:25:00.000Z",
    });
    expect(metricCount("BillSummarizerSuperseded")).toBe(0);
    await runDiffer({ guid: GUID });
    expect(lastDiffOutcome()).toBe("unchanged");
    expect(take(Q.summarizer)).toEqual([]);
  });

  it("a refetch without bill text during Bedrock does not drop an existing bill's text change", async () => {
    await existingBill(rawDoc({ text: "v1" }));
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-02T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    mockDuringBedrock.push(async () => {
      // It also brings the passage: billDiffer patches it in and keeps v1's text hash.
      fetchRaw(rawDoc({ text: null, actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:05:00.000Z" }));
      expect(await drainDifferOneByOne()).toEqual(["patched"]);
    });

    const response = await drainSummarizer();

    expect(response?.batchItemFailures).toEqual([]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(processed()).toMatchObject({
      soWhat: "Summary of v2.",
      billStatus: "Passed",
      actions: [PASSAGE, INTRODUCED],
    });
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: textHashOf("v2"),
    });
    await runDiffer({ guid: GUID });
    expect(lastDiffOutcome()).toBe("unchanged");
  });

  it("a refetch without bill text that lands before billSummarizer loads: the version the message names is summarized", async () => {
    fetchRaw(rawDoc({ text: "v1" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const textless = fetchRaw(rawDoc({ text: null, fetchedAt: "2026-02-01T21:25:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["awaiting_text"]);

    await drainSummarizer();

    expect(processed().soWhat).toBe("Summary of v1.");
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: textHashOf("v1"),
      [SOURCE_METADATA_KEYS.rawVersion]: textless,
    });
  });

  it("an older text's summary is not stored over a newer one's because a refetch without text came last", async () => {
    await existingBill(rawDoc({ text: "v1" }));
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-02T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const jobV2 = take(Q.summarizer);
    mockDuringBedrock.push(async () => {
      fetchRaw(rawDoc({ text: "v3", fetchedAt: "2026-02-03T00:00:00.000Z" }));
      expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
      await drainSummarizer(); // the v3 job runs to completion
      fetchRaw(rawDoc({ text: null, fetchedAt: "2026-02-04T00:00:00.000Z" }));
      expect(await drainDifferOneByOne()).toEqual(["unchanged"]);
    });

    const response = await runSummarizer(...jobV2.map((message) => message.body));

    expect(response.batchItemFailures).toEqual([]);
    expect(processed().soWhat).toBe("Summary of v3.");
    expect(metricCount("BillSummarizerSuperseded")).toBe(1);
  });

  it("stale_raw: a pending job does not roll the processed bill back to an older fetch stored late", async () => {
    await existingBill(rawDoc({ text: "v1", fetchedAt: "2026-02-01T21:20:00.000Z" }));
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-01T21:21:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const jobA = take(Q.summarizer); // still waiting in BillSummarizerQueue
    fetchRaw(rawDoc({ text: "v3", fetchedAt: "2026-02-01T21:23:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    await drainSummarizer();
    expect(processed().soWhat).toBe("Summary of v3.");
    // An older fetch (it still saw text v2) is stored after the 21:23 one.
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-01T21:22:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["stale_raw"]);
    mockBedrockSend.mockClear();

    const response = await runSummarizer(...jobA.map((message) => message.body));

    expect(response.batchItemFailures).toEqual([]);
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(processed().soWhat).toBe("Summary of v3.");
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.fetchedAt]: "2026-02-01T21:23:00.000Z",
    });
    expect(metricCount("BillSummarizerSuperseded")).toBe(1);
  });

  it("stale_raw: an older fetch of the same text stored late does not stop the newer fetch's summary", async () => {
    await existingBill(rawDoc({ text: "v1", fetchedAt: "2026-02-01T21:20:00.000Z" }));
    fetchRaw(rawDoc({ text: "v2", actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-01T21:23:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]); // with the pre-summary patch from 21:23
    // An older fetch (21:22) that already saw text v2, but not the passage, is stored after it.
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-01T21:22:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["stale_raw"]);

    const response = await drainSummarizer();

    expect(response?.batchItemFailures).toEqual([]);
    expect(processed()).toMatchObject({
      soWhat: "Summary of v2.",
      actions: [PASSAGE, INTRODUCED],
      billStatus: "Passed",
    });
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: textHashOf("v2"),
      [SOURCE_METADATA_KEYS.fetchedAt]: "2026-02-01T21:23:00.000Z",
    });
  });

  it("stale_raw: a job in Bedrock while the newer summary and the older fetch land does not store", async () => {
    await existingBill(rawDoc({ text: "v1", fetchedAt: "2026-02-01T21:20:00.000Z" }));
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-01T21:21:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const jobA = take(Q.summarizer);
    mockDuringBedrock.push(async () => {
      fetchRaw(rawDoc({ text: "v3", fetchedAt: "2026-02-01T21:23:00.000Z" }));
      expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
      await drainSummarizer(); // job B stores v3's summary
      fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-01T21:22:00.000Z" }));
      expect(await drainDifferOneByOne()).toEqual(["stale_raw"]);
    });

    const response = await runSummarizer(...jobA.map((message) => message.body));

    expect(response.batchItemFailures).toEqual([]);
    expect(processed().soWhat).toBe("Summary of v3.");
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.fetchedAt]: "2026-02-01T21:23:00.000Z",
    });
  });

  // Text v2, then text v3, then a refetch without bill text, all before billSummarizer reads the two
  // messages, which arrive in one batch: each record reads the version its message names.
  const twoTextsThenTextless = async () => {
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-02T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const [jobV2] = take(Q.summarizer).map((message) => message.body);
    fetchRaw(rawDoc({ text: "v3", fetchedAt: "2026-02-03T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const [jobV3] = take(Q.summarizer).map((message) => message.body);
    fetchRaw(rawDoc({ text: null, fetchedAt: "2026-02-04T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["unchanged"]);
    return { jobV2, jobV3 };
  };

  it.each(["older text first", "newer text first"])(
    "two texts' messages in one batch after a refetch without text: the newer text is summarized (%s)",
    async (order) => {
      await existingBill(rawDoc({ text: "v1" }));
      const { jobV2, jobV3 } = await twoTextsThenTextless();

      const response = await runSummarizer(...(order === "older text first" ? [jobV2, jobV3] : [jobV3, jobV2]));

      expect(response.batchItemFailures).toEqual([]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      expect(processed().soWhat).toBe("Summary of v3.");
      expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
        [SOURCE_METADATA_KEYS.textHash]: textHashOf("v3"),
      });
      expect(metricCount("BillSummarizerSuperseded")).toBe(0);
      await runDiffer({ guid: GUID });
      expect(lastDiffOutcome()).toBe("unchanged");
      expect(take(Q.summarizer)).toEqual([]);
    },
  );

  it("a duplicate of an already stored text's message in the batch does not take the newer text's work to already_current", async () => {
    await existingBill(rawDoc({ text: "v1" }));
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-02T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const [jobV2] = take(Q.summarizer).map((message) => message.body);
    await runSummarizer(jobV2);
    expect(processed().soWhat).toBe("Summary of v2.");
    mockBedrockSend.mockClear();
    fetchRaw(rawDoc({ text: "v3", fetchedAt: "2026-02-03T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const [jobV3] = take(Q.summarizer).map((message) => message.body);
    fetchRaw(rawDoc({ text: null, fetchedAt: "2026-02-04T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["unchanged"]);

    // SQS delivers jobV2 again (at least once) in the same batch as jobV3.
    const response = await runSummarizer(jobV2, jobV3);

    expect(response.batchItemFailures).toEqual([]);
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    expect(processed().soWhat).toBe("Summary of v3.");
    expect(metricCount("BillSummarizerAlreadyCurrent")).toBe(0);
  });

  it("a summary job delayed past five raw writes without text stores its summary", async () => {
    await existingBill(rawDoc({ text: "v1" }));
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-02T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const job = take(Q.summarizer); // waits in BillSummarizerQueue (a backlog, or the DLQ until a redrive)
    for (const day of ["03", "04", "05", "06", "07"]) {
      fetchRaw(rawDoc({ text: null, fetchedAt: `2026-02-${day}T00:00:00.000Z` }));
    }
    expect(await drainDifferOneByOne()).toEqual(Array(5).fill("unchanged"));

    const response = await runSummarizer(...job.map((message) => message.body));

    expect(response.batchItemFailures).toEqual([]);
    expect(processed().soWhat).toBe("Summary of v2.");
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: textHashOf("v2"),
      [SOURCE_METADATA_KEYS.fetchedAt]: "2026-02-07T00:00:00.000Z",
    });
    expect(metricCount("BillSummarizerSuperseded")).toBe(0);
  });

  it("past 50 raw writes without text the summary is superseded as too_many_versions, with its own metric", async () => {
    await existingBill(rawDoc({ text: "v1" }));
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-02T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
    const job = take(Q.summarizer);
    for (let minute = 10; minute <= 61; minute += 1) {
      fetchRaw(rawDoc({ text: null, fetchedAt: new Date(Date.UTC(2026, 1, 3, 0, minute)).toISOString() }));
    }
    take(Q.differ); // billDiffer writes nothing for them (unchanged)
    const gets = mockS3.commands("GetObject", RAW_KEY).length;

    await runSummarizer(...job.map((message) => message.body));

    expect(processed().soWhat).toBe("Summary of v1.");
    expect(metricCount("BillSummarizerTooManyVersions")).toBe(1);
    expect(logLines(console.warn).filter((line) => line.event === "summary_superseded")).toEqual([
      expect.objectContaining({ stage: "store", reason: "too_many_versions" }),
    ]);
    // The load (latest, then the named version) and the store's latest; none of the 51 in between.
    expect(mockS3.commands("GetObject", RAW_KEY).length - gets).toBe(3);
  });

  // Racing fetches: a newer fetch stored without bill text (21:23) is patched in, then an older fetch of
  // text v2 (21:22) is stored late (stale_raw). A fetch without text never replaces the text, so v2's
  // summary is stored with the 21:23 fetch's derived fields.
  const textlessNewerFetchThenOlderFetch = async () => {
    fetchRaw(rawDoc({ text: null, actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-01T21:23:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["patched"]);
    fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-01T21:22:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["stale_raw"]);
  };

  it.each(["while the job is in Bedrock", "before the job is read"])(
    "stale_raw: an older fetch stored late after a newer fetch without text does not drop the text's summary (%s)",
    async (when) => {
      await existingBill(rawDoc({ text: "v1", fetchedAt: "2026-02-01T21:20:00.000Z" }));
      fetchRaw(rawDoc({ text: "v2", fetchedAt: "2026-02-01T21:21:00.000Z" }));
      expect(await drainDifferOneByOne()).toEqual(["enqueued"]);
      const jobA = take(Q.summarizer);
      if (when === "before the job is read") await textlessNewerFetchThenOlderFetch();
      else mockDuringBedrock.push(textlessNewerFetchThenOlderFetch);

      const response = await runSummarizer(...jobA.map((message) => message.body));

      expect(response.batchItemFailures).toEqual([]);
      expect(mockBedrockSend).toHaveBeenCalledTimes(1);
      expect(processed()).toMatchObject({
        soWhat: "Summary of v2.",
        actions: [PASSAGE, INTRODUCED],
        billStatus: "Passed",
      });
      expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
        [SOURCE_METADATA_KEYS.textHash]: textHashOf("v2"),
        [SOURCE_METADATA_KEYS.fetchedAt]: "2026-02-01T21:23:00.000Z",
      });
      expect(metricCount("BillSummarizerSuperseded")).toBe(0);
      await runDiffer({ guid: GUID });
      expect(lastDiffOutcome()).toBe("stale_raw");
      expect(take(Q.summarizer)).toEqual([]);
    },
  );
});

describe("REL-36: the enrichment write races a newer fetch", () => {
  it("re-applies the members to the newer copy instead of restoring the older one", async () => {
    await existingBill(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    const committees = [{ name: "Energy and Commerce", systemCode: "hsif00" }];
    const newer = rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" });
    newer.content.committees = { committees };
    // The fetch lands after enrichOfficialVotes read the raw bill and before it writes.
    mockS3.afterGet(RAW_KEY, () => {
      fetchRaw(newer);
    });

    await enrich();
    await drainDifferOneByOne();

    const latestRaw = mockS3.json<RawBill>(RAW_KEY)!;
    expect(latestRaw.metadata.fetchedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(latestRaw.content.committees).toEqual({ committees });
    expect(houseMemberIds({ officialVotes: latestRaw.content.officialVotes })).toEqual(["A000001", "B000002"]);
    expect(processed().committees).toEqual(committees);
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
  });

  it("a last-attempt partial finalize keeps the members another enrichment of the same roll call just wrote", async () => {
    await existingBill(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    mockHttpsStatus = 500; // job A, its last deferred attempt: congress.gov fails, so House is finalized as partial
    mockS3.beforePut(RAW_KEY, async () => {
      mockHttpsStatus = 200;
      await enrich(); // job B, a newer chain for the same roll call, writes the members first
    });

    const response = await enrichOfficialVotes(sqsEvent({ guid: GUID, attempt: 4 }));

    expect(response.batchItemFailures).toEqual([]);
    expect(houseMemberIds({ officialVotes: mockS3.json<RawBill>(RAW_KEY)!.content.officialVotes })).toEqual([
      "A000001",
      "B000002",
    ]);
    expect(mockS3.contentVersions(RAW_KEY)).toHaveLength(2); // the fetch and job B's write
    expect(await drainDifferOneByOne()).toEqual(["patched", "unchanged"]);
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
  });
});

describe("REL-33 and the REL-31 repair", () => {
  it("a no-op enrichment send and a duplicate message write nothing and leave storedAt alone", async () => {
    await existingBill(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    await enrich();
    await drainDifferOneByOne();
    const before = processed();
    const writes = processedPuts().length;

    await enrich(); // members complete: sends {guid} to BillDifferQueue without writing
    expect(mockS3.contentVersions(RAW_KEY)).toHaveLength(2);
    const [send] = take(Q.differ);
    await runDiffer(send.body);
    await runDiffer(send.body); // duplicate delivery

    expect(
      diffLines()
        .slice(-2)
        .map((line) => line.outcome),
    ).toEqual(["unchanged", "unchanged"]);
    expect(processedPuts()).toHaveLength(writes);
    expect(processed().storedAt).toBe(before.storedAt);
  });

  it("a refetch that drops the members, then the enrichment that restores them, writes nothing", async () => {
    await existingBill(rawDoc({ actions: [PASSAGE, INTRODUCED] }));
    await enrich();
    await drainDifferOneByOne();
    const storedAt = processed().storedAt;
    const writes = processedPuts().length;

    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-03-01T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["unchanged"]);
    await enrich();
    expect(await drainDifferOneByOne()).toEqual(["unchanged"]);

    expect(processedPuts()).toHaveLength(writes);
    expect(processed().storedAt).toBe(storedAt);
    expect(houseMemberIds(processed())).toEqual(["A000001", "B000002"]);
  });

  it("the repair's write patches only officialVotes: no summary, no push, storedAt moves", async () => {
    // A bill stored before REL-31: the page range was read as a House vote of 4758 to 4759.
    const bad = rawDoc({ actions: [PASSED_WITHOUT_OBJECTION, INTRODUCED] });
    bad.content.officialVotes = badTallyVotes();
    await existingBill(bad);
    // Date the summary back (same metadata), so the patch's storedAt is later whatever the clock.
    const stored = mockS3.current(PROCESSED_KEY)!;
    mockS3.put(PROCESSED_KEY, { ...JSON.parse(stored.body), storedAt: "2026-02-01T21:30:00.000Z" }, stored.metadata);
    const before = processed();
    expect(before.officialVotes!.house!.yea).toBe(4758);

    const summary = await repair.applyRepairs(
      ...fakeClients(),
      repair.configFromEnv({ BILL_STORE_BUCKET: BUCKET }),
      Q.differ,
      [{ guid: GUID, key: RAW_KEY }],
      { log: () => undefined, logError: () => undefined },
    );
    expect(summary).toMatchObject({ repaired: 1, enqueued: 1 });

    expect(await drainDifferOneByOne()).toEqual(["patched"]);
    expect(diffLines().at(-1)).toMatchObject({ changedFields: ["officialVotes"] });
    expect(take(Q.summarizer)).toEqual([]);
    const after = processed();
    expect(after.officialVotes).toBeUndefined();
    expect({ ...after, storedAt: undefined }).toEqual({ ...before, officialVotes: undefined, storedAt: undefined });
    expect(after.storedAt > before.storedAt).toBe(true);
    expect(await notificationTypes()).toEqual([]);
  });

  it("judge scenario 7: a fetch with a bad tally, then the repair with the same fetchedAt, ends with the fixed tally", async () => {
    await existingBill(rawDoc());
    const bad = rawDoc({ actions: [PASSED_WITHOUT_OBJECTION, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" });
    bad.content.officialVotes = badTallyVotes();
    fetchRaw(bad);
    // The repair (same fetchedAt) and billDiffer's run for it land between the first run's raw read and its write.
    mockS3.afterGet(RAW_KEY, async () => {
      await repair.applyRepairs(
        ...fakeClients(),
        repair.configFromEnv({ BILL_STORE_BUCKET: BUCKET }),
        Q.differ,
        [{ guid: GUID, key: RAW_KEY }],
        { log: () => undefined, logError: () => undefined },
      );
      expect(await drainDifferOneByOne()).toEqual(["patched"]);
    });

    await drainDifferOneByOne();

    expect(processed().officialVotes).toBeUndefined();
    expect(processed().actions).toEqual([PASSED_WITHOUT_OBJECTION, INTRODUCED]);
  });
});

describe("the House Present and Not voting repair", () => {
  it("its write patches only officialVotes (no summary, no push), and a refetch without members keeps the figures", async () => {
    // Enriched before the fix: the rows hold a Not Voting member, the stored figures say 0.
    const passage = { ...PASSAGE, text: "On passage Passed by the Yeas and Nays: 2 - 1 (Roll no. 31)." };
    const enriched = rawDoc({ actions: [passage, INTRODUCED] });
    const votes = enriched.content.officialVotes as OfficialVotesBreakdown;
    votes.house!.memberDataAvailable = true;
    votes.house!.members = [
      { bioguideId: "A000001", displayName: "Doe, Jane", votePosition: "Yea" },
      { bioguideId: "A000002", displayName: "Roe, Jim", votePosition: "Yea" },
      { bioguideId: "B000002", displayName: "Smith, John", votePosition: "Nay" },
      { bioguideId: "C000003", displayName: "Lee, Ann", votePosition: "Not Voting" },
    ];
    votes.completeness = "complete";
    await existingBill(enriched);
    // Date the summary back (same metadata), so the patch's storedAt is later whatever the clock.
    const stored = mockS3.current(PROCESSED_KEY)!;
    mockS3.put(PROCESSED_KEY, { ...JSON.parse(stored.body), storedAt: "2026-02-01T21:30:00.000Z" }, stored.metadata);
    const before = processed();
    expect(before.officialVotes!.house).toMatchObject({ yea: 2, nay: 1, present: 0, notVoting: 0, totalCounted: 3 });

    const summary = await houseRepair.applyRepairs(
      ...fakeClients(),
      houseRepair.configFromEnv({ BILL_STORE_BUCKET: BUCKET }),
      Q.differ,
      [{ guid: GUID, key: RAW_KEY }],
      { log: () => undefined, logError: () => undefined },
    );
    expect(summary).toMatchObject({ repaired: 1, enqueued: 1 });

    expect(await drainDifferOneByOne()).toEqual(["patched"]);
    expect(diffLines().at(-1)).toMatchObject({ changedFields: ["officialVotes"] });
    expect(take(Q.summarizer)).toEqual([]);
    const after = processed();
    expect(after.officialVotes!.house).toMatchObject({ yea: 2, nay: 1, present: 0, notVoting: 1, totalCounted: 4 });
    expect(houseMemberIds(after)).toEqual(["A000001", "A000002", "B000002", "C000003"]);
    expect({ ...after, officialVotes: undefined, storedAt: undefined }).toEqual({
      ...before,
      officialVotes: undefined,
      storedAt: undefined,
    });
    expect(after.storedAt > before.storedAt).toBe(true);
    expect(await notificationTypes()).toEqual([]);

    // A refetch rebuilds the House chamber from the actions (0 Not voting, no members): the processed bill keeps it.
    fetchRaw(rawDoc({ actions: [passage, INTRODUCED], fetchedAt: "2026-03-01T00:00:00.000Z" }));
    expect(await drainDifferOneByOne()).toEqual(["unchanged"]);
    expect(processed().officialVotes!.house).toMatchObject({ notVoting: 1, totalCounted: 4 });
  });
});

describe("guards and failure paths", () => {
  it("a raw copy from an older fetch, stored late, is not written over the processed bill", async () => {
    await existingBill(rawDoc({ fetchedAt: "2026-02-05T00:00:00.000Z" }));
    const writes = processedPuts().length;
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-01T00:00:00.000Z" }));

    expect(await drainDifferOneByOne()).toEqual(["stale_raw"]);
    expect(processedPuts()).toHaveLength(writes);
    expect(metricCount("BillDifferStaleRaw")).toBe(1);
  });

  it("a raw bill without meaningful content writes and sends nothing, after the companion sync ran", async () => {
    await existingBill(rawDoc());
    const writes = processedPuts().length;
    mockDdbSend.mockClear();
    fetchRaw({ schemaVersion: 1, kind: "raw", storedAt: "x", identifier: {}, metadata: { guid: GUID }, content: {} });

    expect(await drainDifferOneByOne()).toEqual(["skipped"]);
    expect(processedPuts()).toHaveLength(writes);
    expect(mockSent).toEqual([]);
    expect(mockDdbSend).toHaveBeenCalled();
  });

  it("a bill with no processed copy and no text yet is awaiting_text and sends nothing", async () => {
    fetchRaw(rawDoc({ text: null }));
    expect(await drainDifferOneByOne()).toEqual(["awaiting_text"]);
    expect(mockSent).toEqual([]);
  });

  it("APPF-23: a DynamoDB error fails the record before any S3 write or SQS send", async () => {
    await existingBill(rawDoc());
    const writes = processedPuts().length;
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));
    mockDdbSend.mockRejectedValue(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }));

    const response = await runDiffer(...take(Q.differ).map((message) => message.body));

    expect(response.batchItemFailures).toHaveLength(1);
    expect(processedPuts()).toHaveLength(writes);
    expect(mockSent).toEqual([]);
  });

  it("a processed bill found only at a legacy key counts as existing and is written to the flat key with IfNoneMatch", async () => {
    const legacyKey = `processed-bills/congress-119/hr/${GUID}.json`;
    mockS3.put(RAW_KEY, rawDoc());
    mockS3.put(legacyKey, legacyProcessed("Summary of v1."));
    mockS3.put("bills-manifest.json", { bills: [{ guid: GUID, congress: "119", billType: "hr", billNumber: "6959" }] });
    mockS3.put(PROCESSED_KEY, legacyProcessed("deleted copy"));
    mockS3.deleteObject(PROCESSED_KEY); // like the 2026-02-01 cleanup
    fetchRaw(rawDoc({ actions: [PASSAGE, INTRODUCED], fetchedAt: "2026-02-02T00:00:00.000Z" }));

    expect(await drainDifferOneByOne()).toEqual(["patched"]);
    expect(take(Q.summarizer)).toEqual([]);
    const [put] = processedPuts();
    expect(put.input.IfNoneMatch).toBe("*");
    expect(put.input.IfMatch).toBeUndefined();
    expect(processed()).toMatchObject({ soWhat: "Summary of v1.", billStatus: "Passed" });
    expect(mockS3.current(PROCESSED_KEY)!.metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.rawVersion]: mockS3.current(RAW_KEY)!.versionId,
    });
  });
});

function badTallyVotes() {
  return {
    house: {
      yea: 4758,
      nay: 4759,
      present: 0,
      notVoting: 0,
      totalCounted: 9517,
      actionCode: PASSED_WITHOUT_OBJECTION.actionCode,
      actionDate: PASSED_WITHOUT_OBJECTION.actionDate,
      resultText: PASSED_WITHOUT_OBJECTION.text,
      memberDataAvailable: false,
      members: [],
    },
    lastSyncedAt: "2026-02-01T21:20:00.000Z",
    source: "congress_api",
    completeness: "partial",
  };
}

/** A processed bill written before REL-30 (no source metadata), as of raw v0/v1 with only the introduction. */
function legacyProcessed(soWhat: string) {
  return {
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-01-15T00:00:00.000Z",
    identifier: { congress: "119", billType: "hr", billNumber: "6959" },
    guid: GUID,
    title: "Expands rural broadband",
    link: "https://www.congress.gov/bill/119th-congress/house-bill/6959/text",
    soWhat,
    billBreakdown: { who: "", what: "", how: "", when: "", where: "", why: "" },
    subCategories: [],
    lifeAreas: [],
    sponsors: ["S000001"],
    cosponsors: ["C000001"],
    actions: [INTRODUCED],
    committees: [],
    billStatus: "New",
  };
}
