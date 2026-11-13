/**
 * REL-59 end to end: CreateBillsManifest forwards each processed-bill version it gets an S3 event for to
 * NotificationTypeQueue with the event's versionId (2/2), and NotificationType judges that version against the one
 * stored just before it (1/2). Both handlers run here against one versioned S3 fake, so the message shape between them
 * is the one production uses, and every version is already stored when the messages run, as it was in production when
 * BillDiffer stored a bill again a second after the version that changed it.
 *
 * The bill is H.R. 9612 on 2026-11-10: v0 reported, v1 the House passage, v2 vote enrichment's officialVotes-only
 * version 1.5 s after v1. Before REL-59 both messages read (v2, v1) and the passage was never pushed.
 */
import { Readable } from "stream";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { FakeVersionedS3, type FakeS3Command } from "./fakeVersionedS3";
import { asSqsEvent } from "./fixtures/awsEvents";
import { applyTestEnv } from "./fixtures/env";

let mockS3: FakeVersionedS3;
const mockSqsSend = jest.fn();
const mockDdbSend = jest.fn();

const hasBody = (response: unknown): response is { Body: { transformToString: () => Promise<string> } } =>
  typeof response === "object" && response !== null && "Body" in response;

/** The fake's answer, with a GetObject body streamed as the SDK's is in Lambda (CreateBillsManifest iterates it). */
const mockStreamingS3Send = async (command: FakeS3Command): Promise<unknown> => {
  const response = await mockS3.send(command);
  if (command.__cmd !== "GetObject" || !hasBody(response)) return response;
  const body = await response.Body.transformToString();
  return { ...response, Body: Readable.from([Buffer.from(body)]) };
};

jest.mock("@aws-sdk/client-s3", () => ({
  ...require("./fakeVersionedS3").mockS3Module(() => mockS3),
  S3Client: jest.fn(() => ({ send: (command: FakeS3Command) => mockStreamingS3Send(command) })),
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  PutItemCommand: jest.fn().mockImplementation((input) => ({ __type: "PutItemCommand", input })),
  DeleteItemCommand: jest.fn().mockImplementation((input) => ({ __type: "DeleteItemCommand", input })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "GetItemCommand", input })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ __type: "QueryCommand", input })),
  TransactWriteItemsCommand: jest.fn().mockImplementation((input) => ({ __type: "TransactWriteItemsCommand", input })),
}));

const BUCKET = "bill-store";
const KEY = "processed-bills/BILLS-119hr9612.json";
const NOTIFICATION_TYPE_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/NotificationTypeQueue";
const MEMBER_STATS_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/CongressMemberStatsQueue";
const USER_MATCHER_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/userMatcherQueue";

const base = {
  kind: "processed",
  guid: "BILLS-119hr9612",
  identifier: { congress: "119", billType: "hr", billNumber: "9612" },
  title: "Grid Reliability Act",
  billBreakdown: { who: "W", what: "W", how: "H", when: "W", where: "Not Applicable", why: "Y" },
  soWhat: "S",
  subCategories: ["Energy"],
  lifeAreas: [],
  sponsors: [],
  cosponsors: [],
};
const reported = [
  { actionDate: "2026-11-05", actionCode: "H12410", type: "Calendars", text: "Placed on the Union Calendar." },
  { actionDate: "2026-07-09", actionCode: "1000", type: "IntroReferral", text: "Introduced in House" },
];
const passage = {
  actionDate: "2026-11-09",
  actionCode: "8000",
  type: "Floor",
  text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill (Roll no. 316).",
};
const v0 = { ...base, billStatus: "New", actions: reported, storedAt: "2026-11-10T14:26:33.000Z" };
const v1 = {
  ...base,
  billStatus: "Passed",
  actions: [passage, ...reported],
  officialVotes: { house: { rollCall: 316, members: [] } },
  storedAt: "2026-11-10T18:19:33.548Z",
};
const v2 = {
  ...v1,
  officialVotes: { house: { rollCall: 316, members: [{ m: 1 }, { m: 2 }] } },
  storedAt: "2026-11-10T18:19:34.995Z",
};

/** Stores the documents oldest first and returns their version ids in the same order. */
const store = (...docs: unknown[]): string[] => docs.map((doc) => mockS3.put(KEY, doc));

/** One BillsManifestQueue record: the S3 event of one write, with its versionId when it has one. */
const s3EventRecord = (messageId: string, versionId?: string) => ({
  messageId,
  body: JSON.stringify({
    Records: [
      {
        eventName: "ObjectCreated:Put",
        s3: { bucket: { name: BUCKET }, object: { key: KEY, ...(versionId ? { versionId } : {}) } },
      },
    ],
  }),
});

const bodiesSentTo = (queueUrl: string): string[] =>
  mockSqsSend.mock.calls
    .filter(([command]) => command.input.QueueUrl === queueUrl)
    .flatMap(([command]) => command.input.Entries.map((entry: { MessageBody: string }) => entry.MessageBody));

type Handler = (event: SQSEvent) => Promise<SQSBatchResponse>;

/** Loads a handler module with its own environment, as each Lambda has one. */
const loadHandler = (path: string, env: Record<string, string>): Handler => {
  const restore = applyTestEnv(env);
  try {
    let handler!: Handler;
    jest.isolateModules(() => {
      handler = require(path).handler;
    });
    return handler;
  } finally {
    restore();
  }
};

/** Runs CreateBillsManifest on the records and returns the bodies it sent NotificationTypeQueue. */
const runCreateBillsManifest = async (records: object[]): Promise<string[]> => {
  const handler = loadHandler("../handlers/createBillsManifest", {
    BUCKET_NAME: BUCKET,
    TABLE_NAME: "BillsManifest",
    PRIMARY_KEY: "pk",
    SORT_KEY: "sk",
    PK_VALUE: "BILL",
    QUEUE_URL: NOTIFICATION_TYPE_QUEUE,
    CONGRESS_MEMBER_STATS_QUEUE_URL: MEMBER_STATS_QUEUE,
  });
  const response = await handler(asSqsEvent({ Records: records }));
  expect(response.batchItemFailures).toEqual([]);
  return bodiesSentTo(NOTIFICATION_TYPE_QUEUE);
};

/** Runs NotificationType on those bodies and returns each userMatcher message as "<type>@<sourceRevision>". */
const runNotificationType = async (bodies: string[]): Promise<string[]> => {
  mockSqsSend.mockClear();
  const handler = loadHandler("../handlers/notificationType", {
    BUCKET_NAME: BUCKET,
    QUEUE_URL: USER_MATCHER_QUEUE,
    QUEUE_BATCH_SIZE: "10",
    PROCESSED_BILLS_PREFIX: "processed-bills/",
  });
  const response = await handler(
    asSqsEvent({ Records: bodies.map((body, index) => ({ messageId: `nt-${index}`, body })) }),
  );
  expect(response.batchItemFailures).toEqual([]);
  return bodiesSentTo(USER_MATCHER_QUEUE).map((body) => {
    const message = JSON.parse(body) as { notificationType: string; sourceRevision: string };
    return `${message.notificationType}@${message.sourceRevision}`;
  });
};

describe("REL-59: CreateBillsManifest's forward, judged by NotificationType", () => {
  beforeEach(() => {
    mockS3 = new FakeVersionedS3("2026-11-10T14:26:32.000Z");
    mockSqsSend.mockReset();
    mockSqsSend.mockImplementation(async (command: { input: { Entries: { Id: string }[] } }) => ({
      Successful: command.input.Entries.map((entry) => ({ Id: entry.Id })),
      Failed: [],
    }));
    mockDdbSend.mockReset();
    mockDdbSend.mockImplementation(async (command: { __type: string }) =>
      command.__type === "QueryCommand" ? { Items: [] } : {},
    );
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("pushes the passage though the officialVotes-only version was stored before either message ran", async () => {
    const [, passageVersion, enrichedVersion] = store(v0, v1, v2);

    const bodies = await runCreateBillsManifest([
      s3EventRecord("m-1", passageVersion),
      s3EventRecord("m-2", enrichedVersion),
    ]);

    expect(bodies).toHaveLength(2);
    expect(await runNotificationType(bodies)).toEqual([`alert@${passageVersion}`, `passed@${passageVersion}`]);
  });

  it("sends a new bill's `new` though its second version was stored before the first message ran", async () => {
    const [firstVersion] = store(v0, { ...v0, cosponsors: ["A000001"], storedAt: "2026-11-10T14:26:35.000Z" });

    const bodies = await runCreateBillsManifest([s3EventRecord("m-1", firstVersion)]);

    expect(await runNotificationType(bodies)).toEqual([`new@${firstVersion}`]);
  });

  it("a record handled again later (a redrive) still judges its own version, not the latest", async () => {
    const [, passageVersion] = store(v0, v1, v2, { ...v2, soWhat: "S2", storedAt: "2026-11-11T09:00:00.000Z" });

    const bodies = await runCreateBillsManifest([s3EventRecord("redriven", passageVersion)]);

    expect(await runNotificationType(bodies)).toEqual([`alert@${passageVersion}`, `passed@${passageVersion}`]);
  });

  it("a record without a version (a manifest backfill run with --forward) reads the latest pair, as before", async () => {
    const [, passageVersion] = store(v0, v1);

    const bodies = await runCreateBillsManifest([s3EventRecord("backfill-0")]);

    expect(bodies.map((body) => JSON.parse(body).Records[0].s3.object)).toEqual([{ key: KEY }]);
    expect(await runNotificationType(bodies)).toEqual([`alert@${passageVersion}`, `passed@${passageVersion}`]);
  });
});
