import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { applyTestEnv } from "./fixtures/env";
import { asSqsEvent, sqsGuidRecords } from "./fixtures/awsEvents";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { FakeVersionedS3 } from "./fakeVersionedS3";
import { logLines } from "./logLines";
import type { handler } from "../handlers/billDiffer";
import type { RawBill } from "../models/bill";
import { SOURCE_METADATA_KEYS, sourceTextHash } from "../shared/billSourceReconcile";

type BillDifferHandler = typeof handler;

const originalEnv = { ...process.env };

type Item = Record<string, AttributeValue>;

/** What the fake DynamoDB reads from an AWS SDK command: its class's name and its input. */
interface FakeDdbCommand {
  constructor: { name: string };
  input: ConditionInput & { Key?: Item; Item?: Item };
}

/** What the fake SQS sends carry: the batch entries. */
interface FakeSqsCommand {
  input: { Entries: Array<{ MessageBody: string }> };
}

// Key-based, versioned S3 (REL-30): billDiffer reads the processed bill and the latest raw bill by key.
let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

const mockSQSSend = jest.fn();
// Companion link lists (APPF-23). Answers {} (no stored row) unless a test installs a table.
const mockDdbSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const rawDoc = (guid: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-09-01T00:00:00Z",
  identifier: { congress: "119", billType: "house-bill", billNumber: "1" },
  metadata: { guid, title: "Title", pubDate: "", legislationUrl: "", fetchedAt: "2026-09-01T00:00:00.000Z" },
  content: { billXML: "<xml>same</xml>", actions: { actions: [] }, committees: { committees: [] } },
  ...overrides,
});

const processedDoc = (guid: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2026-09-01T00:00:00Z",
  identifier: { congress: "119", billType: "house-bill", billNumber: "1" },
  guid,
  title: "Processed Title",
  link: "https://example.com",
  soWhat: "",
  billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
  subCategories: [],
  lifeAreas: [],
  sponsors: [],
  cosponsors: [],
  actions: [],
  committees: [],
  billStatus: "New",
  ...overrides,
});

/** The source metadata billSummarizer stores for a processed bill built from `raw` (version `rawVersion`). */
const sourceOf = (raw: unknown, rawVersion = "built-from-older"): Record<string, string> => ({
  [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(raw as RawBill),
  [SOURCE_METADATA_KEYS.rawVersion]: rawVersion,
  [SOURCE_METADATA_KEYS.fetchedAt]: (raw as RawBill).metadata.fetchedAt,
});

const rawKey = (plain: string) => `raw-bills/${plain}.json`;
const processedKey = (plain: string) => `processed-bills/${plain}.json`;

/** Stores a raw bill as the latest version; returns its VersionId. */
const storeRaw = (plain: string, doc: unknown): string => mockS3.put(rawKey(plain), doc);

/** Stores a processed bill with the source metadata of `builtFrom` (none: a legacy bill). */
const storeProcessed = (plain: string, doc: unknown, builtFrom?: { raw: unknown; versionId?: string }) =>
  mockS3.put(processedKey(plain), doc, builtFrom ? sourceOf(builtFrom.raw, builtFrom.versionId) : undefined);

/** Processed-bill PUTs that S3 stored, as parsed bodies with their metadata and conditions. */
const processedPuts = () =>
  mockS3
    .commands("PutObject")
    .filter((call) => String(call.input.Key).startsWith("processed-bills/"))
    .map((call) => ({
      Key: call.input.Key as string,
      body: JSON.parse(call.input.Body as string),
      Metadata: call.input.Metadata as Record<string, string> | undefined,
      IfMatch: call.input.IfMatch as string | undefined,
      IfNoneMatch: call.input.IfNoneMatch as string | undefined,
    }));

const records = (guids: string[]) =>
  asSqsEvent({
    Records: guids.map((guid, i) => ({ messageId: `msg-${i + 1}`, body: JSON.stringify({ guid }) })),
  });

const sentBodies = () =>
  mockSQSSend.mock.calls.flatMap(([command]: [FakeSqsCommand]) =>
    command.input.Entries.map((entry) => JSON.parse(entry.MessageBody)),
  );

const DROP_LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";
const dropLines = () => logLines(console.warn).filter((line) => line.message === DROP_LOG_MESSAGE);
const dropMetrics = () => logLines(console.log).filter((line) => line._aws && "MessagesUnprocessable" in line);
// Makes only the drop helper's two lines throw, so the rest of the handler logs normally.
const breakDropOutput = () => {
  (console.warn as jest.Mock).mockImplementation((line: unknown) => {
    if (String(line).includes(DROP_LOG_MESSAGE)) throw new Error("console.warn broke");
  });
  (console.log as jest.Mock).mockImplementation((line: unknown) => {
    if (String(line).includes('"MessagesUnprocessable"')) throw new Error("console.log broke");
  });
};
const dropOutputAttempts = () => ({
  logs: (console.warn as jest.Mock).mock.calls.filter(([line]) => String(line).includes(DROP_LOG_MESSAGE)).length,
  metrics: (console.log as jest.Mock).mock.calls.filter(([line]) => String(line).includes('"MessagesUnprocessable"'))
    .length,
});

const s3InternalError = () =>
  Object.assign(new Error("S3 internal error"), { name: "InternalError", $metadata: { httpStatusCode: 500 } });

describe("billDiffer", () => {
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.resetModules();
    mockS3 = new FakeVersionedS3();
    mockSQSSend.mockReset();
    mockSQSSend.mockResolvedValue({ Failed: [], Successful: [{ Id: "msg-0" }] });
    mockDdbSend.mockReset();
    mockDdbSend.mockResolvedValue({});

    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-bucket",
        QUEUE_URL: "https://example.com/bill-diff-queue",
        QUEUE_BATCH_SIZE: "10",
        RAW_BILLS_PREFIX: "raw-bills/",
      },
      { replace: true, base: originalEnv },
    );

    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    restoreEnv?.();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv as NodeJS.ProcessEnv;
  });

  const loadHandler = () => require("../handlers/billDiffer").handler as BillDifferHandler;

  it("enqueues the guid with the raw version when the title changed since the summary", async () => {
    const guid = "BILLS-119hr1is";
    const old = rawDoc(guid, { metadata: { ...rawDoc(guid).metadata, title: "Old Title" } });
    storeRaw("BILLS-119hr1", old);
    storeProcessed("BILLS-119hr1", processedDoc(guid), { raw: old });
    const versionId = storeRaw(
      "BILLS-119hr1",
      rawDoc(guid, { metadata: { ...rawDoc(guid).metadata, title: "New Title" } }),
    );

    const res = await loadHandler()(sqsGuidRecords([guid]));

    expect(res.enqueued).toBe(1);
    expect(res.updatedProcessed).toBe(0);
    expect(mockSQSSend).toHaveBeenCalledTimes(1);
    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    expect(sqsInput.QueueUrl).toBe("https://example.com/bill-diff-queue");
    expect(sqsInput.Entries).toHaveLength(1);
    // Sent plain: the raw bill's legacy metadata.guid keeps its text-version suffix.
    expect(JSON.parse(sqsInput.Entries[0].MessageBody)).toEqual({ guid: "BILLS-119hr1", rawVersionId: versionId });
    expect(processedPuts()).toEqual([]);
  });

  it("enqueues a bill that has no processed copy, whatever its raw history", async () => {
    const guid = "BILLS-119hr1is";
    storeRaw("BILLS-119hr1", rawDoc(guid));
    const latest = storeRaw("BILLS-119hr1", rawDoc(guid, { content: { ...rawDoc(guid).content, officialVotes: {} } }));

    const res = await loadHandler()(sqsGuidRecords([guid]));

    expect(res).toMatchObject({ enqueued: 1, batchItemFailures: [] });
    expect(sentBodies()).toEqual([{ guid: "BILLS-119hr1", rawVersionId: latest }]);
  });

  it("patches the processed bill when actions or committees change but the title and text do not", async () => {
    const guid = "BILLS-119hr2is";
    const before = rawDoc(guid);
    storeRaw("BILLS-119hr2", before);
    storeProcessed("BILLS-119hr2", processedDoc(guid, { storedAt: "2026-01-01T00:00:00Z" }), { raw: before });
    const versionId = storeRaw(
      "BILLS-119hr2",
      rawDoc(guid, {
        content: {
          billXML: "<xml>same</xml>",
          actions: { actions: [{ code: "A" }] },
          committees: { committees: [{ name: "Judiciary" }] },
        },
      }),
    );

    const res = await loadHandler()(sqsGuidRecords([guid]));

    expect(res).toMatchObject({ enqueued: 0, updatedProcessed: 1 });
    expect(mockSQSSend).not.toHaveBeenCalled();
    const [put] = processedPuts();
    expect(put.Key).toBe("processed-bills/BILLS-119hr2.json");
    // The patch also drops the text-version suffix the processed bill was stored with.
    expect(put.body).toMatchObject({
      guid: "BILLS-119hr2",
      actions: [{ code: "A" }],
      committees: [{ name: "Judiciary" }],
    });
    expect(put.body.storedAt > "2026-01-01T00:00:00Z").toBe(true);
    // REL-30: the write is conditional on the version read, and records its source.
    expect(put.IfMatch).toBe(mockS3.versions("processed-bills/BILLS-119hr2.json")[1].etag);
    expect(put.Metadata).toMatchObject({
      [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(before as unknown as RawBill),
      [SOURCE_METADATA_KEYS.rawVersion]: versionId,
      [SOURCE_METADATA_KEYS.fetchedAt]: "2026-09-01T00:00:00.000Z",
    });
  });

  it("does nothing when no field clients can see changed (REL-33)", async () => {
    const guid = "BILLS-119hr3is";
    const raw = rawDoc(guid);
    storeRaw("BILLS-119hr3", raw);
    storeProcessed("BILLS-119hr3", processedDoc(guid), { raw });
    storeRaw("BILLS-119hr3", rawDoc(guid, { metadata: { ...raw.metadata, fetchedAt: "2026-09-05T00:00:00.000Z" } }));

    const res = await loadHandler()(sqsGuidRecords([guid]));

    expect(res).toMatchObject({ enqueued: 0, updatedProcessed: 0 });
    expect(processedPuts()).toEqual([]);
    expect(mockSQSSend).not.toHaveBeenCalled();
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Diffed raw bill",
        outcome: "unchanged",
        reason: "no_visible_change",
        decidedBy: "source-hash",
      }),
    );
  });

  it("never lets an empty fetch wipe processed fields", async () => {
    const guid = "BILLS-119hr4is";
    storeProcessed("BILLS-119hr4", processedDoc(guid, { actions: [{ code: "A" }] }));
    storeRaw("BILLS-119hr4", { schemaVersion: 1, kind: "raw", metadata: { guid }, content: {} });

    const res = await loadHandler()(sqsGuidRecords([guid]));

    expect(res).toMatchObject({ enqueued: 0, updatedProcessed: 0, batchItemFailures: [] });
    expect(processedPuts()).toEqual([]);
    expect(mockSQSSend).not.toHaveBeenCalled();
  });

  it("accepts { guid } messages (fetchRawBill format) and reads the version-less keys", async () => {
    const guid = "BILLS-119hr5rh";
    storeRaw("BILLS-119hr5", rawDoc(guid));

    const res = await loadHandler()(sqsGuidRecords([guid]));

    expect(res.enqueued).toBe(1);
    expect(mockS3.commands("GetObject").map((call) => call.input.Key)).toEqual(
      expect.arrayContaining(["processed-bills/BILLS-119hr5.json", "raw-bills/BILLS-119hr5.json"]),
    );
  });

  it("patches official votes into an existing processed bill and sends member stats nothing directly", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-bucket",
        QUEUE_URL: "https://example.com/bill-summarizer-queue",
        CONGRESS_MEMBER_STATS_QUEUE_URL: "https://example.com/congress-member-stats-queue",
        QUEUE_BATCH_SIZE: "10",
        RAW_BILLS_PREFIX: "raw-bills/",
      },
      { replace: true, base: originalEnv },
    );
    const guid = "BILLS-119sconres7";
    const before = rawDoc(guid);
    storeRaw(guid, before);
    storeProcessed(guid, processedDoc(guid), { raw: before });
    storeRaw(
      guid,
      rawDoc(guid, {
        content: {
          ...before.content,
          officialVotes: {
            source: "congress_api",
            lastSyncedAt: "2026-03-19T00:02:00Z",
            completeness: "complete",
            senate: {
              actionDate: "2025-02-21",
              yea: 52,
              nay: 48,
              memberDataAvailable: true,
              members: [{ bioguideId: "B001135", votePosition: "Yea" }],
            },
          },
        },
      }),
    );

    const res = await loadHandler()(sqsGuidRecords([guid]));

    expect(res.enqueued).toBe(0);
    expect(res.updatedProcessed).toBe(1);
    expect(processedPuts()[0].body.officialVotes.senate.members).toEqual([
      { bioguideId: "B001135", votePosition: "Yea" },
    ]);
    // CAP-05: the stored patch's own S3 event reaches member stats through createBillsManifest,
    // even with CONGRESS_MEMBER_STATS_QUEUE_URL still set on this function.
    expect(mockSQSSend).not.toHaveBeenCalled();
  });

  it("emits the outcome metrics and logs reason and decidedBy (REL-30)", async () => {
    const guid = "BILLS-119hr6is";
    // Legacy (no source metadata), written before the only raw version: no raw history to anchor on.
    storeProcessed("BILLS-119hr6", processedDoc(guid));
    storeRaw("BILLS-119hr6", rawDoc(guid));

    await loadHandler()(sqsGuidRecords([guid]));

    const lines = logLines(console.log);
    expect(lines).toContainEqual(
      expect.objectContaining({ message: "Diffed raw bill", outcome: "unchanged", decidedBy: "assumed" }),
    );
    expect(lines.filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/BillIngestion")).toEqual([
      expect.objectContaining({ BillDifferLegacyAnchor: 1 }),
    ]);
  });

  it("logs each enqueue with the plain raw key and the invocation's awsRequestId, one BillDifferEnqueued per bill", async () => {
    // refetch:stale-bills counts its --max-summaries bills from these fields (ENQUEUED_DIFFS_QUERY): one row per key
    // and awsRequestId is one BillDifferEnqueued, and the distinct keys are the bills.
    storeRaw("BILLS-119hr8", rawDoc("BILLS-119hr8ih"));

    const res = await loadHandler()(sqsGuidRecords(["BILLS-119hr8ih", "BILLS-119hr8"]), {
      awsRequestId: "req-1",
    });

    expect(res.enqueued).toBe(1);
    const lines = logLines(console.log);
    expect(lines.filter((line) => line.message === "Diffed raw bill")).toEqual([
      expect.objectContaining({ outcome: "enqueued", key: "raw-bills/BILLS-119hr8.json", awsRequestId: "req-1" }),
      expect.objectContaining({ outcome: "enqueued", key: "raw-bills/BILLS-119hr8.json", awsRequestId: "req-1" }),
    ]);
    expect(lines.filter((line) => line._aws && "BillDifferEnqueued" in line)).toEqual([
      expect.objectContaining({ BillDifferEnqueued: 1 }),
    ]);
  });

  describe("partial batch failures (REL-02)", () => {
    it("returns an empty batchItemFailures list alongside the counters on success", async () => {
      storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));

      const res = await loadHandler()(records(["BILLS-119hr1is"]));

      expect(res).toEqual({ batchItemFailures: [], status: "ok", scanned: 1, enqueued: 1, updatedProcessed: 0 });
    });

    it("fails only the record whose raw bill could not be loaded", async () => {
      storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));
      storeRaw("BILLS-119hr2", rawDoc("BILLS-119hr2is"));
      mockS3.afterGet("raw-bills/BILLS-119hr1.json", () => {
        throw s3InternalError();
      });

      const res = await loadHandler()(records(["BILLS-119hr1is", "BILLS-119hr2is"]));

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
      expect(res.enqueued).toBe(1);
      expect(mockSQSSend).toHaveBeenCalledTimes(1);
      expect(sentBodies()).toEqual([{ guid: "BILLS-119hr2", rawVersionId: expect.any(String) }]);
    });

    it("fails only the record whose summarizer enqueue failed", async () => {
      storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));
      storeRaw("BILLS-119hr2", rawDoc("BILLS-119hr2is"));
      mockSQSSend
        .mockResolvedValueOnce({ Failed: [{ Id: "msg-0", Code: "InternalError", SenderFault: false }], Successful: [] })
        .mockResolvedValueOnce({ Failed: [], Successful: [{ Id: "msg-0" }] });

      const res = await loadHandler()(records(["BILLS-119hr1is", "BILLS-119hr2is"]));

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
      expect(res.enqueued).toBe(1);
    });

    it("does not send a member-stats message when it patches sponsors or official votes", async () => {
      restoreEnv?.();
      restoreEnv = applyTestEnv(
        {
          BUCKET_NAME: "test-bucket",
          QUEUE_URL: "https://example.com/bill-summarizer-queue",
          CONGRESS_MEMBER_STATS_QUEUE_URL: "https://example.com/congress-member-stats-queue",
          QUEUE_BATCH_SIZE: "10",
          RAW_BILLS_PREFIX: "raw-bills/",
        },
        { replace: true, base: originalEnv },
      );
      const guid = "BILLS-119sconres7";
      const votes = { source: "congress_api", lastSyncedAt: "2026-09-02T00:00:00Z", completeness: "complete" };
      const before = rawDoc(guid);
      storeRaw(guid, before);
      storeProcessed(guid, processedDoc(guid), { raw: before });
      storeRaw(guid, rawDoc(guid, { content: { ...before.content, officialVotes: votes } }));

      const res = await loadHandler()(records([guid]));

      expect(processedPuts()).toHaveLength(1);
      expect(processedPuts()[0].body.officialVotes).toEqual({ ...votes, completeness: "none" });
      expect(res.batchItemFailures).toEqual([]);
      expect(res.updatedProcessed).toBe(1);
      expect(mockSQSSend).not.toHaveBeenCalled();
    });

    it("diffs a bill named by several records once and reports them together", async () => {
      storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));
      mockS3.afterGet("raw-bills/BILLS-119hr1.json", () => {
        throw s3InternalError();
      });

      const res = await loadHandler()(records(["BILLS-119hr1is", "BILLS-119hr1rh"]));

      expect(res.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }, { itemIdentifier: "msg-2" }]);
      expect(res.scanned).toBe(1);
      expect(mockS3.commands("GetObject", "raw-bills/BILLS-119hr1.json")).toHaveLength(1);
    });

    it("skips records without a guid instead of failing them", async () => {
      const res = await loadHandler()(
        asSqsEvent({
          Records: [
            { messageId: "msg-1", body: "not json" },
            { messageId: "msg-2", body: "{}" },
          ],
        }),
      );

      expect(res.batchItemFailures).toEqual([]);
      expect(mockS3.calls).toEqual([]);
    });

    describe("unprocessable-message count (C1.8)", () => {
      it("logs and counts each record without a guid once, with its reason, and still acknowledges it", async () => {
        storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));

        const res = await loadHandler()(
          asSqsEvent({
            Records: [
              { messageId: "msg-1", body: "not json" },
              { messageId: "msg-2", body: "{}" },
              { messageId: "msg-3", body: "" },
              { messageId: "msg-4", body: JSON.stringify({ guid: "  " }) },
              { messageId: "msg-5", body: JSON.stringify({ guid: "BILLS-119hr1is" }) },
            ],
          }),
        );

        expect(res.batchItemFailures).toEqual([]);
        expect(res.scanned).toBe(1);
        expect(dropLines().map((line) => [line.messageId, line.dropSite, line.reason])).toEqual([
          ["msg-1", "billDiffer.missingGuid", "invalid_json"],
          ["msg-2", "billDiffer.missingGuid", "missing_guid"],
          ["msg-3", "billDiffer.missingGuid", "empty_body"],
          ["msg-4", "billDiffer.missingGuid", "missing_guid"],
        ]);
        expect(dropLines()[0].messagePreview).toBe("not json");
        expect(dropLines()[1].messageContent).toEqual({});
        expect(dropMetrics().map((line) => [line.sqsMessageId, line.MessagesUnprocessable, line.dropSite])).toEqual([
          ["msg-1", 1, "billDiffer.missingGuid"],
          ["msg-2", 1, "billDiffer.missingGuid"],
          ["msg-3", 1, "billDiffer.missingGuid"],
          ["msg-4", 1, "billDiffer.missingGuid"],
        ]);
      });

      it("counts nothing for a record with a guid", async () => {
        storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));

        const res = await loadHandler()(records(["BILLS-119hr1is"]));

        expect(res.batchItemFailures).toEqual([]);
        expect(dropLines()).toEqual([]);
        expect(dropMetrics()).toEqual([]);
      });

      it("still acknowledges the record when the drop's log line and metric line throw", async () => {
        storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));
        breakDropOutput();

        const res = await loadHandler()(
          asSqsEvent({
            Records: [
              { messageId: "msg-1", body: "{}" },
              { messageId: "msg-2", body: JSON.stringify({ guid: "BILLS-119hr1is" }) },
            ],
          }),
        );

        expect(res.batchItemFailures).toEqual([]);
        expect(res.enqueued).toBe(1);
        expect(dropOutputAttempts()).toEqual({ logs: 1, metrics: 1 });
      });
    });

    describe("correlation id (OBS-10)", () => {
      const correlationId = "2026-09-02T10:00:00.000Z:BILLS-119hr1is";
      const tracedRecords = (guids: string[]) =>
        asSqsEvent({
          Records: records(guids).Records.map((record) => ({
            ...record,
            messageAttributes: { correlationId: { dataType: "String", stringValue: correlationId } },
          })),
        });
      const attributes = { correlationId: { DataType: "String", StringValue: correlationId } };

      it("passes the record's id to billSummarizer and logs the outcome with it", async () => {
        const versionId = storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));

        await loadHandler()(tracedRecords(["BILLS-119hr1is"]), { awsRequestId: "req-3" });

        const sent = mockSQSSend.mock.calls[0][0].input;
        expect(sent.QueueUrl).toBe("https://example.com/bill-diff-queue");
        expect(sent.Entries).toEqual([
          expect.objectContaining({
            MessageBody: JSON.stringify({ guid: "BILLS-119hr1", rawVersionId: versionId }),
            MessageAttributes: attributes,
          }),
        ]);
        expect(logLines(console.log)).toContainEqual(
          expect.objectContaining({
            message: "Diffed raw bill",
            outcome: "enqueued",
            reason: "no_processed",
            guid: "BILLS-119hr1is",
            correlationId,
            sqsMessageId: "msg-1",
            awsRequestId: "req-3",
          }),
        );
      });

      it("stores a patched processed bill with the id and the source keys as S3 metadata", async () => {
        const guid = "BILLS-119hr1is";
        const votes = { source: "congress_api", lastSyncedAt: "2026-09-02T00:00:00Z", completeness: "complete" };
        const before = rawDoc(guid);
        storeRaw("BILLS-119hr1", before);
        storeProcessed("BILLS-119hr1", processedDoc(guid), { raw: before });
        const versionId = storeRaw(
          "BILLS-119hr1",
          rawDoc(guid, { content: { ...before.content, officialVotes: votes } }),
        );

        const res = await loadHandler()(tracedRecords([guid]));

        expect(res.updatedProcessed).toBe(1);
        expect(processedPuts()).toEqual([
          expect.objectContaining({
            Key: "processed-bills/BILLS-119hr1.json",
            Metadata: {
              "correlation-id": correlationId,
              "source-text-hash": sourceTextHash(before as unknown as RawBill),
              "source-raw-version": versionId,
              "source-fetched-at": "2026-09-01T00:00:00.000Z",
            },
          }),
        ]);
        expect(mockSQSSend).not.toHaveBeenCalled();
      });

      it("mints one when the record carries none", async () => {
        storeRaw("BILLS-119hr1", rawDoc("BILLS-119hr1is"));

        await loadHandler()(records(["BILLS-119hr1is"]));

        expect(mockSQSSend.mock.calls[0][0].input.Entries[0].MessageAttributes.correlationId.StringValue).toMatch(
          /^\d{4}-\d{2}-\d{2}T[\d:.]+Z:BILLS-119hr1is$/,
        );
      });
    });

    describe("sponsor and cosponsor patches (REL-28)", () => {
      const guid = "BILLS-119hr1is";
      const memberIds = (count: number) =>
        Array.from({ length: count }, (_, index) => `M${String(index + 1).padStart(6, "0")}`);
      const rawWithSponsors = (sponsors: string[], cosponsors: string[]) =>
        rawDoc(guid, {
          content: {
            billXML: "<xml>same</xml>",
            actions: { actions: [] },
            committees: { committees: [] },
            bill: { bill: { sponsors: sponsors.map((bioguideId) => ({ bioguideId })) } },
            cosponsors: {
              cosponsors: cosponsors.map((bioguideId) => ({ bioguideId, fullName: `Rep. ${bioguideId}` })),
              pagination: { count: cosponsors.length },
            },
          },
        });

      beforeEach(() => {
        process.env.CONGRESS_MEMBER_STATS_QUEUE_URL = "https://example.com/member-stats";
      });

      it("patches the full lists into the processed bill without re-summarizing it", async () => {
        const before = rawWithSponsors(["S000001"], memberIds(20));
        storeRaw("BILLS-119hr1", before);
        storeProcessed("BILLS-119hr1", processedDoc(guid, { sponsors: ["S000001"], cosponsors: memberIds(20) }), {
          raw: before,
        });
        storeRaw("BILLS-119hr1", rawWithSponsors(["S000002"], memberIds(25)));

        const res = await loadHandler()(records([guid]));

        expect(res).toMatchObject({ batchItemFailures: [], enqueued: 0, updatedProcessed: 1 });
        expect(processedPuts()).toHaveLength(1);
        const stored = processedPuts()[0].body;
        expect(stored.sponsors).toEqual(["S000002"]);
        expect(stored.cosponsors).toEqual(memberIds(25));
        expect(stored.actions).toEqual([]);
        // Nothing goes to billSummarizer, and member stats follow from the stored patch's S3 event.
        expect(mockSQSSend).not.toHaveBeenCalled();
      });

      it("leaves the processed bill alone when neither list changed", async () => {
        const raw = rawWithSponsors(["S000001"], memberIds(20));
        storeRaw("BILLS-119hr1", raw);
        storeProcessed("BILLS-119hr1", processedDoc(guid, { sponsors: ["S000001"], cosponsors: memberIds(20) }), {
          raw,
        });
        storeRaw("BILLS-119hr1", raw);

        const res = await loadHandler()(records([guid]));

        expect(res).toMatchObject({ batchItemFailures: [], enqueued: 0, updatedProcessed: 0 });
        expect(processedPuts()).toEqual([]);
        expect(mockSQSSend).not.toHaveBeenCalled();
      });
    });

    describe("companion link lists (APPF-23)", () => {
      type Item = Record<string, AttributeValue>;
      const HOUSE = "BILLS-119hr1285";

      const identical = (type: string, number: string, relationship = "Identical bill") => ({
        congress: 119,
        type,
        number,
        relationshipDetails: [{ type: relationship, identifiedBy: "CRS" }],
      });
      const rawWithRelated = (related: Array<Record<string, unknown>>, fetchedAt = "2026-09-20T00:00:00.000Z") =>
        rawDoc(`${HOUSE}ih`, {
          identifier: { congress: "119", billType: "house-bill", billNumber: "1285" },
          metadata: { guid: `${HOUSE}ih`, title: "Title", pubDate: "", legislationUrl: "", fetchedAt },
          content: {
            billXML: "<xml>same</xml>",
            actions: { actions: [] },
            committees: { committees: [] },
            relatedBills: { relatedBills: related, pagination: { count: related.length } },
          },
        });
      /** The raw bill as the latest version, and a processed bill already built from it. */
      const storeInSync = (raw: unknown) => {
        const versionId = storeRaw(HOUSE, raw);
        storeProcessed(HOUSE, processedDoc(`${HOUSE}ih`), { raw, versionId });
      };
      const storedRow = (targets: string[], sourceFetchedAt: string): Item => ({
        pk: { S: "BILL_COMPANION_DECL" },
        sk: { S: HOUSE },
        congress: { S: "119" },
        billType: { S: "hr" },
        billNumber: { S: "1285" },
        declared: {
          L: targets.map((guid) => ({
            M: {
              guid: { S: guid },
              congress: { S: "119" },
              billType: { S: guid.replace(/^BILLS-119([a-z]+)\d+$/, "$1") },
              billNumber: { S: guid.replace(/^\D+119[a-z]+/, "") },
            },
          })),
        },
        truncated: { BOOL: false },
        sourceFetchedAt: { S: sourceFetchedAt },
      });

      /** The manifest table's link-list rows in memory, with the real condition expressions. */
      const setupDynamo = (rows: Item[] = []) => {
        const table = new Map(rows.map((row) => [row.sk.S!, row]));
        const commands: string[] = [];
        mockDdbSend.mockImplementation(async (command: FakeDdbCommand) => {
          const name: string = command.constructor.name;
          const input = command.input;
          commands.push(name);
          if (name === "GetItemCommand") return { Item: table.get(input.Key!.sk.S!) };
          if (name === "PutItemCommand" || name === "DeleteItemCommand") {
            const sk = (input.Item ?? input.Key)!.sk.S!;
            if (!evaluateCondition(table.get(sk), input)) throw conditionalCheckFailed();
            if (input.Item) table.set(sk, input.Item);
            else table.delete(sk);
            return {};
          }
          throw new Error(`Unexpected command ${name}`);
        });
        return { table, commands };
      };

      const metricLines = () =>
        logLines(console.log).filter(
          (line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/BillsManifest",
        );

      it("stores the identical links under the key's plain guid before anything is enqueued", async () => {
        storeRaw(HOUSE, rawWithRelated([identical("S", "570"), identical("S", "9", "Related bill")]));
        const dynamo = setupDynamo();

        const res = await loadHandler()(records([`${HOUSE}ih`]));

        expect(res).toMatchObject({ batchItemFailures: [], enqueued: 1 });
        expect(dynamo.commands).toEqual(["GetItemCommand", "PutItemCommand"]);
        const row = dynamo.table.get(HOUSE)!;
        expect(row.declared.L!.map((ref) => ref.M!.guid.S)).toEqual(["BILLS-119s570"]);
        expect(row.sourceFetchedAt).toEqual({ S: "2026-09-20T00:00:00.000Z" });
        const put = mockDdbSend.mock.calls.find(([command]) => command.constructor.name === "PutItemCommand")!;
        expect(put[0].input.ConditionExpression).toContain("#src <= :src");
        // The DynamoDB write precedes the summarizer message.
        expect(mockDdbSend.mock.invocationCallOrder.at(-1)!).toBeLessThan(mockSQSSend.mock.invocationCallOrder[0]);
        expect(metricLines()).toEqual([expect.objectContaining({ CompanionDeclWritten: 1 })]);
      });

      it("writes nothing when the stored links are the same and come from the same fetch", async () => {
        storeInSync(rawWithRelated([identical("S", "570")]));
        const dynamo = setupDynamo([storedRow(["BILLS-119s570"], "2026-09-20T00:00:00.000Z")]);

        const res = await loadHandler()(records([`${HOUSE}ih`]));

        expect(res).toMatchObject({ batchItemFailures: [], enqueued: 0, updatedProcessed: 0 });
        expect(dynamo.commands).toEqual(["GetItemCommand"]);
        expect(metricLines()).toEqual([]);
      });

      it("moves sourceFetchedAt up when a newer fetch confirms the same links, so an older copy cannot remove them", async () => {
        // The row was written from a 09-01 fetch; a 09-11 fetch lists the same link again.
        storeInSync(rawWithRelated([identical("S", "570")], "2026-09-11T00:00:00.000Z"));
        const dynamo = setupDynamo([storedRow(["BILLS-119s570"], "2026-09-01T00:00:00.000Z")]);
        const handler = loadHandler();

        const refreshed = await handler(records([`${HOUSE}ih`]));

        expect(refreshed).toMatchObject({ batchItemFailures: [], enqueued: 0 });
        expect(dynamo.commands).toEqual(["GetItemCommand", "PutItemCommand"]);
        expect(dynamo.table.get(HOUSE)?.sourceFetchedAt).toEqual({ S: "2026-09-11T00:00:00.000Z" });
        expect(metricLines()).toEqual([]);

        // A 09-10 copy whose fetch had briefly lost the link is stored late.
        storeRaw(HOUSE, rawWithRelated([], "2026-09-10T00:00:00.000Z"));
        const late = await handler(records([`${HOUSE}ih`]));

        expect(dynamo.table.get(HOUSE)?.declared.L!.map((ref) => ref.M!.guid.S)).toEqual(["BILLS-119s570"]);
        expect(metricLines()).toEqual([expect.objectContaining({ CompanionDeclStale: 1 })]);
        // The processed bill is not rolled back to it either (REL-30 stale_raw).
        expect(late).toMatchObject({ enqueued: 0, updatedProcessed: 0 });
        expect(logLines(console.log)).toContainEqual(expect.objectContaining({ outcome: "stale_raw" }));
      });

      it("deletes the row when the links are gone, without touching the processed bill", async () => {
        storeInSync(rawWithRelated([identical("S", "9", "Related bill")]));
        const dynamo = setupDynamo([storedRow(["BILLS-119s570"], "2026-09-01T00:00:00.000Z")]);

        const res = await loadHandler()(records([`${HOUSE}ih`]));

        expect(res).toMatchObject({ batchItemFailures: [], enqueued: 0, updatedProcessed: 0 });
        expect(dynamo.commands).toEqual(["GetItemCommand", "DeleteItemCommand"]);
        expect(dynamo.table.has(HOUSE)).toBe(false);
        expect(processedPuts()).toEqual([]);
        expect(metricLines()).toEqual([expect.objectContaining({ CompanionDeclDeleted: 1 })]);
      });

      it("skips a stale raw copy as stale and carries on with the diff", async () => {
        // An older copy restored by enrichOfficialVotes keeps its old fetchedAt.
        storeRaw(HOUSE, rawWithRelated([], "2026-08-01T00:00:00.000Z"));
        const dynamo = setupDynamo([storedRow(["BILLS-119s570"], "2026-09-01T00:00:00.000Z")]);

        const res = await loadHandler()(records([`${HOUSE}ih`]));

        expect(res).toMatchObject({ batchItemFailures: [], enqueued: 1 });
        expect(dynamo.commands).toEqual(["GetItemCommand", "DeleteItemCommand"]);
        expect(dynamo.table.get(HOUSE)?.declared.L).toHaveLength(1);
        expect(metricLines()).toEqual([expect.objectContaining({ CompanionDeclStale: 1 })]);
      });

      it("fails the record before anything is sent or patched when DynamoDB fails (acceptance 14)", async () => {
        storeRaw(HOUSE, rawWithRelated([identical("S", "570")]));
        storeRaw("BILLS-119hr2", rawDoc("BILLS-119hr2is"));
        mockDdbSend.mockImplementation(async (command: FakeDdbCommand) => {
          if (command.input.Key?.sk?.S === HOUSE || command.input.Item?.sk?.S === HOUSE) {
            throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
          }
          return {};
        });

        const res = await loadHandler()(records([`${HOUSE}ih`, "BILLS-119hr2is"]));

        expect(res.batchItemFailures).toEqual([{ itemIdentifier: "msg-1" }]);
        expect(res.enqueued).toBe(1);
        expect(mockSQSSend).toHaveBeenCalledTimes(1);
        expect(sentBodies()).toEqual([{ guid: "BILLS-119hr2", rawVersionId: expect.any(String) }]);
        expect(processedPuts()).toEqual([]);
      });
    });
  });
});
