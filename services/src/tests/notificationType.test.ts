import { applyTestEnv } from "./fixtures/env";
import { asSqsEvent, s3RecordsForKeys, sqsWrappedS3Keys } from "./fixtures/awsEvents";
import { logLines, logLinesWithMessage } from "./logLines";

const originalEnv = { ...process.env };

// The fixtures store processed bills with a legacy text-version suffix; notifications name the key's plain guid.
const plain = (guid: string) => guid.replace(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/, "$1");

/** A message in a SendMessageBatch call; its body is the JSON a downstream handler reads. */
interface SqsEntry {
  MessageBody: string;
}
type SentBody = Record<string, unknown>;

/** The S3 commands the mocked constructors below return: GetObject (Key) and ListObjectVersions (Prefix). */
interface FakeS3Command {
  input: { Key?: string; Prefix?: string };
}

const mockS3Send = jest.fn();
const mockSQSSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe("notificationType", () => {
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.resetModules();
    mockS3Send.mockReset();
    mockSQSSend.mockReset();

    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-bucket",
        QUEUE_URL: "https://example.com/notification-type-queue",
        QUEUE_BATCH_SIZE: "10",
        PROCESSED_BILLS_PREFIX: "processed-bills/",
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

  it("enqueues Bill New when no previous version exists", async () => {
    const guid = "BILLS-119hr1is";
    const key = "processed-bills/BILLS-119hr1.json";

    // get current (v1)
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            kind: "processed",
            guid,
            title: "Title",
            billBreakdown: {
              who: "Citizens",
              what: "Test",
              how: "Legislation",
              when: "Now",
              where: "Not Applicable",
              why: "Testing",
            },
            soWhat: "SoWhat",
            actions: [],
          }),
        ),
      },
    });

    // list versions -> only one
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: "2026-01-01T00:00:00Z" }],
      DeleteMarkers: [],
    });

    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

    expect(mockSQSSend).toHaveBeenCalledTimes(1);
    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    expect(sqsInput.QueueUrl).toBe("https://example.com/notification-type-queue");
    expect(sqsInput.Entries).toHaveLength(1);
    expect(JSON.parse(sqsInput.Entries[0].MessageBody)).toEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "new",
      sourceRevision: "v1",
    });
  });

  it("enqueues Bill Updated when billBreakdown changes", async () => {
    const guid = "BILLS-119hr2is";
    const key = "processed-bills/BILLS-119hr2.json";

    // current
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "Everyone", what: "NEW", how: "H", when: "W", where: "Not Applicable", why: "Y" },
            soWhat: "S",
            actions: [],
          }),
        ),
      },
    });
    // list versions
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-01-01T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-01-01T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    // previous
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "Everyone", what: "OLD", how: "H", when: "W", where: "Not Applicable", why: "Y" },
            soWhat: "S",
            actions: [],
          }),
        ),
      },
    });

    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    expect(sqsInput.Entries).toHaveLength(1);
    expect(JSON.parse(sqsInput.Entries[0].MessageBody)).toEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "updated",
      sourceRevision: "v2",
    });
  });

  // UX-33 review (F2): userNotifier compares a held "vote again" push with the time of the change, not of the row.
  describe("the time of a summary change on an 'updated' message (UX-33)", () => {
    const runUpdated = async (current: { lastModified?: Date; storedAt?: string }) => {
      const key = "processed-bills/BILLS-119hr2.json";
      const doc = (what: string) =>
        JSON.stringify({
          guid: "BILLS-119hr2",
          title: "T",
          ...(current.storedAt ? { storedAt: current.storedAt } : {}),
          billBreakdown: { who: "Everyone", what, how: "H", when: "W", where: "Not Applicable", why: "Y" },
          soWhat: "S",
          actions: [],
        });
      mockS3Send.mockResolvedValueOnce({
        Body: { transformToString: jest.fn().mockResolvedValue(doc("NEW")) },
        ...(current.lastModified ? { LastModified: current.lastModified } : {}),
      });
      mockS3Send.mockResolvedValueOnce({
        IsTruncated: false,
        Versions: [
          { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-10-27T22:00:05Z" },
          { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-10-01T00:00:00Z" },
        ],
        DeleteMarkers: [],
      });
      mockS3Send.mockResolvedValueOnce({ Body: { transformToString: jest.fn().mockResolvedValue(doc("OLD")) } });
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));
      return JSON.parse(mockSQSSend.mock.calls[0][0].input.Entries[0].MessageBody);
    };

    it("is the stored version's S3 write time, also for a restored copy that kept an older storedAt", async () => {
      const body = await runUpdated({
        lastModified: new Date("2026-10-27T22:00:05Z"),
        storedAt: "2026-09-30T08:00:00.000Z",
      });

      expect(body).toEqual({
        domain: "bill",
        objectId: "BILLS-119hr2",
        notificationType: "updated",
        sourceRevision: "v2",
        changedAt: "2026-10-27T22:00:05.000Z",
      });
    });

    it("falls back to the document's storedAt, and is left out without either", async () => {
      expect((await runUpdated({ storedAt: "2026-10-27T22:00:04.120Z" })).changedAt).toBe("2026-10-27T22:00:04.120Z");
      mockS3Send.mockReset();
      mockSQSSend.mockReset();
      expect(await runUpdated({})).not.toHaveProperty("changedAt");
    });
  });

  it("enqueues Bill Updated and Alert when billBreakdown and title both change", async () => {
    const guid = "BILLS-119hr3is";
    const key = "processed-bills/BILLS-119hr3.json";

    // current
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "NEW TITLE",
            billBreakdown: { who: "All", what: "NEW", how: "H", when: "W", where: "Not Applicable", why: "Y" },
            soWhat: "S",
            actions: [{ a: 1 }],
          }),
        ),
      },
    });
    // list versions
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-01-01T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-01-01T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    // previous
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "OLD TITLE",
            billBreakdown: { who: "All", what: "OLD", how: "H", when: "W", where: "Not Applicable", why: "Y" },
            soWhat: "S",
            actions: [{ a: 1 }],
          }),
        ),
      },
    });

    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    expect(sqsInput.Entries).toHaveLength(2);
    const bodies = sqsInput.Entries.map((e: SqsEntry) => JSON.parse(e.MessageBody) as SentBody);
    expect(bodies).toContainEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "updated",
      sourceRevision: "v2",
    });
    expect(bodies).toContainEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "alert",
      sourceRevision: "v2",
      alert: { text: "Title updated: NEW TITLE" },
    });
  });

  it("includes the newest added action text in Bill Alert messages", async () => {
    const guid = "BILLS-119hr5is";
    const key = "processed-bills/BILLS-119hr5.json";

    // current
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: [
              {
                actionCode: "H11100",
                actionDate: "2025-03-24",
                text: "Referred to the House Committee on Education and Workforce.",
                type: "IntroReferral",
              },
            ],
          }),
        ),
      },
    });
    // list versions
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-01-01T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-01-01T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    // previous
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: [],
          }),
        ),
      },
    });

    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    expect(sqsInput.Entries).toHaveLength(1);
    expect(JSON.parse(sqsInput.Entries[0].MessageBody)).toEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "alert",
      sourceRevision: "v2",
      alert: {
        text: "Referred to the House Committee on Education and Workforce.",
        actionDate: "2025-03-24",
        actionCode: "H11100",
        actionType: "IntroReferral",
      },
    });
  });

  it("enqueues Bill Passed when a new action with code 8000 appears (Passed House)", async () => {
    const guid = "BILLS-119hr6is";
    const key = "processed-bills/BILLS-119hr6.json";

    // current - has a passage action
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: [
              {
                actionCode: "8000",
                actionDate: "2026-01-15",
                text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 250 - 180",
                type: "Floor",
              },
            ],
          }),
        ),
      },
    });
    // list versions
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-01-15T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-01-15T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    // previous - no passage action
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: [],
          }),
        ),
      },
    });

    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    // Should emit both "alert" and "passed"
    expect(sqsInput.Entries).toHaveLength(2);
    const bodies = sqsInput.Entries.map((e: SqsEntry) => JSON.parse(e.MessageBody) as SentBody);
    expect(bodies).toContainEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "alert",
      sourceRevision: "v2",
      alert: {
        text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 250 - 180",
        actionDate: "2026-01-15",
        actionCode: "8000",
        actionType: "Floor",
      },
      // UX-33 (project decision 2026-10-29, "one event, per phone"): the passed message writes this action's rows.
      sameVersionOutcome: "passed",
    });
    expect(bodies).toContainEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "passed",
      sourceRevision: "v2",
      passed: {
        text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 250 - 180",
        actionDate: "2026-01-15",
        actionCode: "8000",
        actionType: "Floor",
      },
      // The same version's action, which userMatcher writes beside the outcome for the action's users.
      sameVersionAlert: {
        text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 250 - 180",
        actionDate: "2026-01-15",
        actionCode: "8000",
        actionType: "Floor",
      },
    });
  });

  it("enqueues Bill Passed when a new action with code 17000 appears (Passed Senate)", async () => {
    const guid = "BILLS-119s10is";
    const key = "processed-bills/BILLS-119s10.json";

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: [
              {
                actionCode: "17000",
                actionDate: "2026-02-01",
                text: "Passed Senate with an amendment by Yea-Nay Vote. 65 - 35.",
                type: "Floor",
              },
            ],
          }),
        ),
      },
    });
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-02-01T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-02-01T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: [],
          }),
        ),
      },
    });

    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    const bodies = sqsInput.Entries.map((e: SqsEntry) => JSON.parse(e.MessageBody) as SentBody);
    expect(bodies).toContainEqual(
      expect.objectContaining({
        notificationType: "passed",
        passed: expect.objectContaining({ actionCode: "17000" }),
      }),
    );
  });

  // UX-33 (project decision 2026-10-29, "one event, per phone"): the passed message carries the alert's own action, the
  // newest new one, which a device with passed pushes off is sent instead.
  it("names the version's newest action on its outcome message, also when it is not the passage", async () => {
    const guid = "BILLS-119hr7is";
    const key = "processed-bills/BILLS-119hr7.json";
    const passage = {
      actionCode: "8000",
      actionDate: "2026-01-15",
      text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 250 - 180",
      type: "Floor",
    };
    const reconsider = {
      actionDate: "2026-01-16",
      text: "Motion to reconsider laid on the table Agreed to without objection.",
      type: "Floor",
    };
    const version = (actions: unknown[]) => ({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions,
          }),
        ),
      },
    });
    mockS3Send.mockResolvedValueOnce(version([passage, reconsider]));
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-01-16T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-01-15T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    mockS3Send.mockResolvedValueOnce(version([]));
    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const bodies = mockSQSSend.mock.calls[0][0].input.Entries.map(
      (e: SqsEntry) => JSON.parse(e.MessageBody) as SentBody,
    );
    const reconsidered = {
      text: "Motion to reconsider laid on the table Agreed to without objection.",
      actionDate: "2026-01-16",
      actionType: "Floor",
    };
    expect(bodies).toEqual([
      expect.objectContaining({ notificationType: "alert", alert: reconsidered, sameVersionOutcome: "passed" }),
      expect.objectContaining({
        notificationType: "passed",
        passed: expect.objectContaining({ actionCode: "8000" }),
        sameVersionAlert: reconsidered,
      }),
    ]);
  });

  it("names no outcome on an action of a version that neither passes nor fails the bill", async () => {
    const guid = "BILLS-119hr8is";
    const key = "processed-bills/BILLS-119hr8.json";
    const version = (actions: unknown[]) => ({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions,
          }),
        ),
      },
    });
    mockS3Send.mockResolvedValueOnce(
      version([{ actionDate: "2026-01-16", text: "Referred to the Committee on Rules.", type: "IntroReferral" }]),
    );
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-01-16T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-01-15T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    mockS3Send.mockResolvedValueOnce(version([]));
    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const bodies = mockSQSSend.mock.calls[0][0].input.Entries.map(
      (e: SqsEntry) => JSON.parse(e.MessageBody) as SentBody,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ notificationType: "alert" });
    expect(bodies[0]).not.toHaveProperty("sameVersionOutcome");
  });

  it("enqueues Bill Failed when a new action with code 9000 appears (Failed House vote)", async () => {
    const guid = "BILLS-119hr8is";
    const key = "processed-bills/BILLS-119hr8.json";

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: [
              {
                actionCode: "9000",
                actionDate: "2026-02-10",
                text: "Failed of passage in House: Failed by the Yeas and Nays: 180 - 250.",
                type: "Floor",
              },
            ],
          }),
        ),
      },
    });
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-02-10T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-02-10T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: [],
          }),
        ),
      },
    });

    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    expect(sqsInput.Entries).toHaveLength(2);
    const bodies = sqsInput.Entries.map((e: SqsEntry) => JSON.parse(e.MessageBody) as SentBody);
    expect(bodies).toContainEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "alert",
      sourceRevision: "v2",
      alert: {
        text: "Failed of passage in House: Failed by the Yeas and Nays: 180 - 250.",
        actionDate: "2026-02-10",
        actionCode: "9000",
        actionType: "Floor",
      },
      sameVersionOutcome: "failed",
    });
    expect(bodies).toContainEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "failed",
      sourceRevision: "v2",
      failed: {
        text: "Failed of passage in House: Failed by the Yeas and Nays: 180 - 250.",
        actionDate: "2026-02-10",
        actionCode: "9000",
        actionType: "Floor",
      },
      sameVersionAlert: {
        text: "Failed of passage in House: Failed by the Yeas and Nays: 180 - 250.",
        actionDate: "2026-02-10",
        actionCode: "9000",
        actionType: "Floor",
      },
    });
  });

  describe("REL-50: failed only for the bill's own failure, by action code (feature review S7)", () => {
    const key = "processed-bills/BILLS-119hr1.json";
    const summary = {
      guid: "BILLS-119hr1",
      title: "One Big Bill",
      billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
      soWhat: "W",
    };
    const passedHouse = [
      {
        actionCode: "8000",
        actionDate: "2026-05-22",
        text: "Passed/agreed to in House: On passage Passed by recorded vote: 215 - 214 (Roll no. 145).",
        type: "Floor",
      },
    ];
    const body = (doc: unknown) => ({ Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(doc)) } });
    const twoVersions = (current: unknown, previous: unknown) => {
      mockS3Send.mockResolvedValueOnce(body(current));
      mockS3Send.mockResolvedValueOnce({
        IsTruncated: false,
        Versions: [
          { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-07-01T03:00:01Z" },
          { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-06-30T18:37:58Z" },
        ],
        DeleteMarkers: [],
      });
      mockS3Send.mockResolvedValueOnce(body(previous));
    };
    const sentTypes = () =>
      mockSQSSend.mock.calls.flatMap(([cmd]) =>
        cmd.input.Entries.map((entry: SqsEntry) => (JSON.parse(entry.MessageBody) as SentBody).notificationType),
      );
    const sentMessages = () =>
      mockSQSSend.mock.calls.flatMap(([cmd]) =>
        cmd.input.Entries.map((entry: SqsEntry) => JSON.parse(entry.MessageBody) as SentBody),
      );

    it.each([
      [
        "an amendment the Senate rejected",
        { text: "Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53." },
      ],
      [
        "a motion to proceed",
        { text: "Motion to proceed to consideration of measure not agreed to in Senate by Yea-Nay Vote. 48 - 50." },
      ],
      [
        "a failed suspension vote",
        {
          actionCode: "9000",
          text: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
        },
      ],
      [
        "a failed Senate vote under a 60-vote order (H.R. 5371, which became law)",
        {
          actionCode: "18000",
          text: "Failed of passage/not agreed to in Senate: Under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48. Record Vote Number: 528.",
        },
      ],
      [
        "the Senate's own failure line, before the Library of Congress codes it",
        { text: "Failed of passage in Senate by Yea-Nay Vote. 45 - 55. Record Vote Number: 99." },
      ],
    ])("sends only an alert, never failed, for %s", async (_name, line) => {
      const action = { actionDate: "2026-07-01", type: "Floor", ...line };
      twoVersions({ ...summary, actions: [action, ...passedHouse] }, { ...summary, actions: passedHouse });
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(sentTypes()).toEqual(["alert"]);
      // UX-33: an action alone, not an outcome change, so not paired: every device that takes actions gets it.
      expect(sentMessages()[0]).not.toHaveProperty("sameVersionOutcome");
    });

    const senateFailure = {
      actionCode: "18000",
      actionDate: "2026-07-01",
      text: "Failed of passage/not agreed to in Senate: Failed of passage in Senate by Yea-Nay Vote. 45 - 55. Record Vote Number: 99.",
      type: "Floor",
    };

    // UX-33: the bill's own failure is an outcome change; its alert and its failed name each other, so each device
    // gets one push for it (shared/pushAudience.ts OUTCOME_PUSH_TYPES).
    const coded = (action: typeof senateFailure) => ({
      text: action.text,
      actionDate: action.actionDate,
      actionCode: action.actionCode,
      actionType: action.type,
    });

    it("sends failed for the Senate's coded failure of the bill, paired with its alert", async () => {
      twoVersions({ ...summary, actions: [senateFailure, ...passedHouse] }, { ...summary, actions: passedHouse });
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(sentMessages()).toEqual([
        expect.objectContaining({
          notificationType: "alert",
          alert: coded(senateFailure),
          sameVersionOutcome: "failed",
        }),
        expect.objectContaining({
          notificationType: "failed",
          failed: coded(senateFailure),
          sameVersionAlert: coded(senateFailure),
        }),
      ]);
    });

    it("sends failed once per vote: not again when the coded line follows the Senate's own line", async () => {
      const uncoded = { ...senateFailure, actionCode: undefined, text: senateFailure.text.split(": ")[1] };
      twoVersions(
        { ...summary, actions: [senateFailure, uncoded, ...passedHouse] },
        { ...summary, actions: [uncoded, ...passedHouse] },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(sentTypes()).toEqual(["alert", "failed"]);
      // The Senate's own line has no plain words of its own, so the coded line is no repeat: it is the alert's action,
      // and the change is paired.
      expect(sentMessages()).toEqual([
        expect.objectContaining({ alert: coded(senateFailure), sameVersionOutcome: "failed" }),
        expect.objectContaining({ failed: coded(senateFailure), sameVersionAlert: coded(senateFailure) }),
      ]);
    });

    it("sends only an alert for a failure of a bill whose actions already give Failed (a vote taken again)", async () => {
      const again = {
        ...senateFailure,
        actionDate: "2026-07-09",
        text: "Failed of passage/not agreed to in Senate: Upon reconsideration, failed of passage in Senate by Yea-Nay Vote. 46 - 54. Record Vote Number: 120.",
      };
      twoVersions(
        { ...summary, actions: [again, senateFailure, ...passedHouse] },
        { ...summary, actions: [senateFailure, ...passedHouse] },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(sentTypes()).toEqual(["alert"]);
      // UX-33: not an outcome change, so the alert is not paired with an outcome no message sends.
      expect(sentMessages()).toEqual([expect.objectContaining({ alert: coded(again) })]);
      expect(sentMessages()[0]).not.toHaveProperty("sameVersionOutcome");
    });

    describe("one vote on two lines sends one action push (review R2)", () => {
      const run = () => require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));
      // The House's floor line (an H-code) and the Library of Congress's coded line for the same failed suspension
      // vote, and the Senate's own line and its coded line for the same failed 60-vote vote: each pair reads the same
      // in a push ("House vote fell short of two-thirds", "Senate vote fell short of 60").
      const houseFloor = {
        actionCode: "H37300",
        actionDate: "2026-07-01",
        text: "On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
        type: "Floor",
      };
      const houseCoded = {
        ...houseFloor,
        actionCode: "9000",
        text: `Failed of passage/not agreed to in House: ${houseFloor.text}`,
      };
      const senateLine = {
        actionDate: "2025-09-19",
        text: "Under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48. Record Vote Number: 528.",
        type: "Floor",
      };
      const senateCoded = {
        ...senateLine,
        actionCode: "18000",
        text: `Failed of passage/not agreed to in Senate: ${senateLine.text}`,
      };

      it("sends an alert for the first line of the vote", async () => {
        twoVersions({ ...summary, actions: [houseFloor, ...passedHouse] }, { ...summary, actions: passedHouse });
        mockSQSSend.mockResolvedValueOnce({ Failed: [] });

        await run();

        expect(sentTypes()).toEqual(["alert"]);
      });

      it.each([
        ["the coded line after the House's floor line of a failed suspension vote", houseFloor, houseCoded],
        ["the House's floor line after the coded line", houseCoded, houseFloor],
        ["the coded line after the Senate's own line of a failed 60-vote vote", senateLine, senateCoded],
      ])("sends nothing for %s, a poll later", async (_name, first, second) => {
        twoVersions(
          { ...summary, actions: [second, first, ...passedHouse] },
          { ...summary, actions: [first, ...passedHouse] },
        );

        await run();

        expect(mockSQSSend).not.toHaveBeenCalled();
      });

      it("sends the alert for another new action of that version, with that action's text", async () => {
        const reconsider = {
          actionCode: "H38310",
          actionDate: "2026-07-01",
          text: "Motion to reconsider laid on the table Agreed to without objection.",
          type: "Floor",
        };
        twoVersions(
          { ...summary, actions: [houseCoded, reconsider, houseFloor, ...passedHouse] },
          { ...summary, actions: [houseFloor, ...passedHouse] },
        );
        mockSQSSend.mockResolvedValueOnce({ Failed: [] });

        await run();

        expect(sentMessages()).toEqual([expect.objectContaining({ notificationType: "alert" })]);
        expect(sentMessages()[0].alert).toMatchObject({ text: reconsider.text, actionCode: "H38310" });
        expect(sentMessages()[0]).not.toHaveProperty("sameVersionOutcome");
      });

      it("sends an alert for the same words on another day: a vote taken again", async () => {
        const again = {
          ...houseCoded,
          actionDate: "2026-07-09",
          text: houseCoded.text.replace("250 - 180 (Roll no. 38)", "255 - 175 (Roll no. 52)"),
        };
        twoVersions(
          { ...summary, actions: [again, houseFloor, ...passedHouse] },
          { ...summary, actions: [houseFloor, ...passedHouse] },
        );
        mockSQSSend.mockResolvedValueOnce({ Failed: [] });

        await run();

        expect(sentTypes()).toEqual(["alert"]);
        expect(sentMessages()[0].alert).toMatchObject({ actionCode: "9000", actionDate: "2026-07-09" });
      });
    });

    it("sends nothing for the status repair's write: billStatus and storedAt only (repair:failed-status)", async () => {
      const amendment = {
        actionDate: "2026-07-01",
        text: "Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53.",
        type: "Floor",
      };
      twoVersions(
        {
          ...summary,
          storedAt: "2026-07-01T03:00:00.000Z",
          billStatus: "Passed",
          actions: [amendment, ...passedHouse],
        },
        {
          ...summary,
          storedAt: "2026-07-01T09:12:44.512Z",
          billStatus: "Failed",
          actions: [amendment, ...passedHouse],
        },
      );

      await require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(mockSQSSend).not.toHaveBeenCalled();
    });

    it.each([
      [
        "H.J.Res. 139: a failed suspension vote",
        [
          {
            actionCode: "9000",
            actionDate: "2026-03-18",
            text: "Failed of passage/not agreed to in House On motion to suspend the rules and pass the resolution Failed by the Yeas and Nays: (2/3 required): 211 - 207 (Roll no. 95).",
            type: "Floor",
          },
        ],
      ],
      [
        "S. 2882: a failed vote under a 60-vote order",
        [
          {
            actionDate: "2025-09-30",
            text: "Upon reconsideration, under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 47 - 53. Record Vote Number: 534.",
            type: "Floor",
          },
          {
            actionCode: "18000",
            actionDate: "2025-09-30",
            text: "Failed of passage/not agreed to in Senate: Upon reconsideration, under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 47 - 53. Record Vote Number: 534.",
            type: "Floor",
          },
        ],
      ],
    ])("classifies a page-only status repair as nothing, %s (repair:failed-status, 2026-10-29)", async (_n, lines) => {
      // The April version backfill:bill-status stored (Failed, the March storedAt) and the repair's (New, storedAt moved
      // to the row's date), read as CreateBillsManifest forwards the key: without a version, the latest and the one before.
      const actions = [...lines, { actionCode: "1000", actionDate: "2025-09-18", text: "Introduced", type: "Intro" }];
      twoVersions(
        { ...summary, storedAt: "2026-03-20T12:20:01.325Z", billStatus: "New", actions },
        { ...summary, storedAt: "2026-03-20T12:20:00.591Z", billStatus: "Failed", actions },
      );

      await require("../handlers/notificationType").handler(sqsWrappedS3Keys([key]));

      expect(mockSQSSend).not.toHaveBeenCalled();
      expect(
        logLines(console.log)
          .filter((line) => line.message === "Classified processed bill")
          .map((line) => [line.guid, line.types]),
      ).toEqual([["BILLS-119hr1", []]]);
    });
  });

  describe("a bill that became law (REL-44)", () => {
    const key = "processed-bills/BILLS-119hjres131.json";
    const summary = {
      guid: "BILLS-119hjres131",
      title: "T",
      billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
      soWhat: "W",
    };
    const passed = [
      { actionCode: "E20000", actionDate: "2025-12-10", text: "Presented to President.", type: "Floor" },
      {
        actionCode: "17000",
        actionDate: "2025-12-04",
        text: "Passed/agreed to in Senate: Passed Senate without amendment by Yea-Nay Vote. 49 - 45. Record Vote Number: 632.",
        type: "Floor",
      },
    ];
    const signed = { actionCode: "36000", actionDate: "2025-12-11", text: "Signed by President.", type: "BecameLaw" };
    const lawLines = [
      { actionCode: "E40000", actionDate: "2025-12-11", text: "Became Public Law No: 119-52.", type: "President" },
      { actionCode: "36000", actionDate: "2025-12-11", text: "Became Public Law No: 119-52.", type: "BecameLaw" },
    ];
    const body = (doc: unknown) => ({ Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(doc)) } });
    const twoVersions = (current: unknown, previous: unknown) => {
      mockS3Send.mockResolvedValueOnce(body(current));
      mockS3Send.mockResolvedValueOnce({
        IsTruncated: false,
        Versions: [
          { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2025-12-12T03:00:01Z" },
          { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2025-12-10T18:37:58Z" },
        ],
        DeleteMarkers: [],
      });
      mockS3Send.mockResolvedValueOnce(body(previous));
    };
    const run = () => require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));
    const sentMessages = () =>
      mockSQSSend.mock.calls.flatMap(([cmd]) =>
        cmd.input.Entries.map((entry: { MessageBody: string }) => JSON.parse(entry.MessageBody)),
      );

    it("sends one alert naming the law line, and no passed, when the law actions arrive", async () => {
      twoVersions(
        { ...summary, billStatus: "Finalized", actions: [...lawLines, signed, ...passed] },
        { ...summary, billStatus: "Passed", actions: passed },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      // userNotifier says the line in plain words: "Action: T" / "Became law · Dec 11, 2025" (pushCopy tests).
      expect(sentMessages()).toEqual([
        {
          domain: "bill",
          objectId: "BILLS-119hjres131",
          notificationType: "alert",
          sourceRevision: "v2",
          alert: {
            text: "Became Public Law No: 119-52.",
            actionDate: "2025-12-11",
            actionCode: "E40000",
            actionType: "President",
          },
        },
      ]);
    });

    it("sends one alert naming the law line, and no passed, when one poll adds the passage and the law", async () => {
      // An urgent bill passed without amendment and signed the same day: the coded passage arrives with the law lines.
      const sameDayPassage = {
        actionCode: "17000",
        actionDate: "2025-12-11",
        text: "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent.",
        type: "Floor",
      };
      const received = {
        actionCode: "10000",
        actionDate: "2025-12-04",
        text: "Received in the Senate.",
        type: "Floor",
      };
      twoVersions(
        { ...summary, billStatus: "Finalized", actions: [...lawLines, signed, sameDayPassage, received] },
        { ...summary, billStatus: "Passed", actions: [received] },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      expect(sentMessages()).toEqual([
        {
          domain: "bill",
          objectId: "BILLS-119hjres131",
          notificationType: "alert",
          sourceRevision: "v2",
          alert: {
            text: "Became Public Law No: 119-52.",
            actionDate: "2025-12-11",
            actionCode: "E40000",
            actionType: "President",
          },
        },
      ]);
    });

    it("sends one alert, and no passed, for a coded passage line that arrives after the law", async () => {
      const latePassage = {
        actionCode: "8000",
        actionDate: "2025-11-20",
        text: "Passed/agreed to in House: On passage Passed by recorded vote: 220 - 205 (Roll no. 301).",
        type: "Floor",
      };
      twoVersions(
        { ...summary, billStatus: "Finalized", actions: [...lawLines, signed, ...passed, latePassage] },
        { ...summary, billStatus: "Finalized", actions: [...lawLines, signed, ...passed] },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      expect(sentMessages().map((message: { notificationType: string }) => message.notificationType)).toEqual([
        "alert",
      ]);
    });

    it("sends nothing for the law lines of the same day that follow the signature a poll later", async () => {
      twoVersions(
        { ...summary, billStatus: "Finalized", actions: [...lawLines, signed, ...passed] },
        { ...summary, billStatus: "Finalized", actions: [signed, ...passed] },
      );

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
    });

    it("sends nothing for the one-time repair's write: billStatus and storedAt only (repair:finalized-status)", async () => {
      const law = [...lawLines, signed, ...passed];
      twoVersions(
        { ...summary, storedAt: "2026-03-20T12:16:07.699Z", billStatus: "Finalized", actions: law },
        { ...summary, storedAt: "2026-03-20T12:16:06.945Z", billStatus: "Passed", actions: law },
      );

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
    });
  });

  describe("Congressional Record citations are not news (project decision 2026-11-12)", () => {
    // H.R. 9614 as stored on 2026-11-10 at 18:29Z: passed by voice vote on 2026-11-09, no citation yet. congress.gov
    // added the citations over the next day, then the Senate received the bill.
    const key = "processed-bills/BILLS-119hr9614.json";
    const summary = {
      guid: "BILLS-119hr9614",
      title: "Allows NRC to Pay Senior Staff Up to 110 Percent",
      billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
      soWhat: "W",
    };
    const floor = { code: 2, name: "House floor actions" };
    const reconsider = {
      actionCode: "H38310",
      actionDate: "2026-11-09",
      actionTime: "16:27:57",
      sourceSystem: floor,
      text: "Motion to reconsider laid on the table Agreed to without objection.",
      type: "Floor",
    };
    const suspensionVote = {
      actionCode: "H37300",
      actionDate: "2026-11-09",
      actionTime: "16:27:53",
      sourceSystem: floor,
      text: "On motion to suspend the rules and pass the bill Agreed to by voice vote.",
      type: "Floor",
    };
    const passage = {
      actionCode: "8000",
      actionDate: "2026-11-09",
      actionTime: "16:27:53",
      sourceSystem: { code: 9, name: "Library of Congress" },
      text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.",
      type: "Floor",
    };
    const debate = {
      actionCode: "H8D000",
      actionDate: "2026-11-09",
      actionTime: "16:18:14",
      sourceSystem: floor,
      text: "DEBATE - The House proceeded with forty minutes of debate on H.R. 9614.",
      type: "Floor",
    };
    const considered = {
      actionCode: "H30000",
      actionDate: "2026-11-09",
      actionTime: "16:18:12",
      sourceSystem: floor,
      text: "Considered under suspension of the rules.",
      type: "Floor",
    };
    const moved = {
      actionCode: "H30300",
      actionDate: "2026-11-09",
      actionTime: "16:17:52",
      sourceSystem: floor,
      text: "Mr. Latta moved to suspend the rules and pass the bill.",
      type: "Floor",
    };
    const reported = {
      actionCode: "H12200",
      actionDate: "2026-11-05",
      sourceSystem: floor,
      text: "Reported by the Committee on Energy and Commerce. H. Rept. 119-876.",
      type: "Committee",
    };
    const senateReferral = {
      actionDate: "2026-11-10",
      sourceSystem: { name: "Senate" },
      text: "Received in the Senate and Read twice and referred to the Committee on Homeland Security and Governmental Affairs.",
      type: "IntroReferral",
    };
    const cited = <T extends { text: string }>(action: T, citation: string): T => ({
      ...action,
      text: `${action.text} ${citation}`,
    });
    // The version of 2026-11-10 18:29Z, and the citations congress.gov added on 11-11 (04:53Z, then 09:12Z).
    const passed = [reconsider, suspensionVote, passage, debate, considered, moved, reported];
    const suspensionVoteCited = cited(suspensionVote, "(text: CR H6104)");
    const consideredCited = cited(considered, "(consideration: CR H6104-6105)");
    const passageCited = cited(passage, "(text: CR H6104)");
    const firstCitations = [reconsider, suspensionVoteCited, passage, debate, consideredCited, moved, reported];
    const allCitations = [reconsider, suspensionVoteCited, passageCited, debate, consideredCited, moved, reported];

    const body = (doc: unknown) => ({ Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(doc)) } });
    const twoVersions = (current: unknown, previous: unknown) => {
      mockS3Send.mockResolvedValueOnce(body(current));
      mockS3Send.mockResolvedValueOnce({
        IsTruncated: false,
        Versions: [
          { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-11-11T09:12:54Z" },
          { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-11-11T05:08:56Z" },
        ],
        DeleteMarkers: [],
      });
      mockS3Send.mockResolvedValueOnce(body(previous));
    };
    const run = () => require("../handlers/notificationType").handler(sqsWrappedS3Keys([key], { versionId: "v2" }));
    const sentMessages = () =>
      mockSQSSend.mock.calls.flatMap(([cmd]) =>
        cmd.input.Entries.map((entry: SqsEntry) => JSON.parse(entry.MessageBody) as SentBody),
      );
    const classifiedTypes = () =>
      logLines(console.log)
        .filter((line) => line.message === "Classified processed bill")
        .map((line) => line.types);
    const alertOf = (action: { actionCode?: string; actionDate: string; text: string; type: string }) => ({
      text: action.text,
      actionDate: action.actionDate,
      ...(action.actionCode ? { actionCode: action.actionCode } : {}),
      actionType: action.type,
    });

    it("sends no alert for citations added to two lines (2026-11-11 04:53Z)", async () => {
      twoVersions({ ...summary, actions: firstCitations }, { ...summary, actions: passed });

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
      expect(classifiedTypes()).toEqual([[]]);
    });

    it("sends no second passed when the passage line gains a citation (2026-11-11 09:12Z)", async () => {
      twoVersions({ ...summary, actions: allCitations }, { ...summary, actions: firstCitations });

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
      expect(classifiedTypes()).toEqual([[]]);
    });

    it.each([
      ["changed", cited(considered, "(text: CR H6104)")],
      ["removed", considered],
    ])("sends nothing for a citation %s", async (_name, line) => {
      twoVersions(
        { ...summary, actions: [reconsider, suspensionVote, passage, debate, line, moved, reported] },
        { ...summary, actions: [reconsider, suspensionVote, passage, debate, consideredCited, moved, reported] },
      );

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
    });

    it("sends nothing for S.Res. 734's agreed-to line gaining two citations (2026-11-09)", async () => {
      const agreed = {
        actionCode: "17000",
        actionDate: "2026-05-14",
        text:
          "Passed/agreed to in Senate: Submitted in the Senate, considered, and agreed to without amendment and with a " +
          "preamble by Unanimous Consent.",
        type: "Floor",
      };
      const senateLine = {
        actionDate: "2026-05-14",
        text:
          "Submitted in the Senate, considered, and agreed to without amendment and with a preamble by Unanimous " +
          "Consent. (consideration: CR S2313; text: CR S2310)",
        type: "Floor",
      };
      twoVersions(
        {
          ...summary,
          cosponsors: ["C001088", "B001288"],
          actions: [senateLine, cited(agreed, "(consideration: CR S2313; text: CR S2310)")],
        },
        { ...summary, cosponsors: ["C001088"], actions: [senateLine, agreed] },
      );

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
    });

    it("sends nothing for a dated citation on a recorded vote (H.R. 4593)", async () => {
      const onPassage = {
        actionCode: "H37100",
        actionDate: "2026-01-07",
        text: "On passage Passed by the Yeas and Nays: 226 - 197 (Roll no. 23).",
        type: "Floor",
      };
      twoVersions(
        { ...summary, actions: [cited(onPassage, "(text: CR 1/7/2026 H127)"), ...passed] },
        { ...summary, actions: [onPassage, ...passed] },
      );

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
    });

    it("sends the alert for a new action that comes with citation edits, and no passed", async () => {
      twoVersions({ ...summary, actions: [senateReferral, ...allCitations] }, { ...summary, actions: passed });
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      expect(sentMessages()).toEqual([
        {
          domain: "bill",
          objectId: "BILLS-119hr9614",
          notificationType: "alert",
          sourceRevision: "v2",
          alert: alertOf(senateReferral),
        },
      ]);
    });

    it("names the new action, not a line of the same day that only gained a citation", async () => {
      // The cited line comes first in the list, so it would be named if it were new (same day, list order).
      twoVersions(
        { ...summary, actions: [consideredCited, reconsider, suspensionVote, passage, debate, moved, reported] },
        { ...summary, actions: [considered, suspensionVote, passage, debate, moved, reported] },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      expect(sentMessages()).toEqual([
        expect.objectContaining({ notificationType: "alert", alert: alertOf(reconsider) }),
      ]);
    });

    it("sends no passed when an old passage line gains a citation beside new actions (H.R. 6365)", async () => {
      const housePassage = {
        actionCode: "8000",
        actionDate: "2026-03-03",
        text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote.",
        type: "Floor",
      };
      const calendar = {
        actionDate: "2026-09-17",
        sourceSystem: { name: "Senate" },
        text: "Placed on Senate Legislative Calendar under General Orders. Calendar No. 664.",
        type: "Calendars",
      };
      twoVersions(
        { ...summary, actions: [calendar, cited(housePassage, "(text: CR H2347)")] },
        { ...summary, actions: [housePassage] },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      expect(sentMessages()).toEqual([
        expect.objectContaining({ notificationType: "alert", alert: alertOf(calendar) }),
      ]);
      expect(sentMessages()[0]).not.toHaveProperty("sameVersionOutcome");
    });

    it("still sends alert and passed for a new passage that comes with its citation, quoted as stored", async () => {
      twoVersions(
        { ...summary, actions: allCitations },
        { ...summary, actions: [debate, considered, moved, reported] },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      // The newest new lines share a day and a time; the list order names the first, as before.
      expect(sentMessages()).toEqual([
        expect.objectContaining({
          notificationType: "alert",
          alert: alertOf(reconsider),
          sameVersionOutcome: "passed",
        }),
        expect.objectContaining({ notificationType: "passed", passed: alertOf(passageCited) }),
      ]);
    });

    it("still sends an alert for a reworded line and for a new title", async () => {
      const reworded = {
        ...reported,
        text: "Reported (Amended) by the Committee on Energy and Commerce. H. Rept. 119-876.",
      };
      twoVersions(
        { ...summary, actions: [reconsider, suspensionVote, passage, debate, consideredCited, moved, reworded] },
        { ...summary, actions: passed },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      expect(sentMessages()).toEqual([
        expect.objectContaining({ notificationType: "alert", alert: alertOf(reworded) }),
      ]);

      jest.resetModules();
      mockSQSSend.mockReset();
      twoVersions(
        { ...summary, title: "Lets the NRC Pay Senior Staff More", actions: firstCitations },
        { ...summary, actions: passed },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      expect(sentMessages()).toEqual([
        expect.objectContaining({
          notificationType: "alert",
          alert: { text: "Title updated: Lets the NRC Pay Senior Staff More" },
        }),
      ]);
    });

    it("still sends the alert it sent before for any other change to the actions: a line removed", async () => {
      twoVersions(
        { ...summary, actions: [reconsider, suspensionVoteCited, passage, debate, consideredCited, moved] },
        { ...summary, actions: passed },
      );
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      await run();

      expect(sentMessages()).toEqual([
        expect.objectContaining({ notificationType: "alert", alert: { text: "Bill updated" } }),
      ]);
    });

    it("still sends nothing for the coded line of a vote whose floor line gains a citation the same poll", async () => {
      // REL-50 review R2: the coded line of a failed suspension vote reads as its floor line did.
      const failedFloor = {
        actionCode: "H37300",
        actionDate: "2026-07-01",
        text: "On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
        type: "Floor",
      };
      const failedCoded = {
        ...failedFloor,
        actionCode: "9000",
        text: `Failed of passage/not agreed to in House: ${failedFloor.text}`,
      };
      twoVersions(
        { ...summary, actions: [failedCoded, cited(failedFloor, "(text: CR H6104)"), reported] },
        { ...summary, actions: [failedFloor, reported] },
      );

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
    });

    it("sends no failed when the failure line of a bill that passed on a later vote gains a citation", async () => {
      // H.R. 2262's failure as stored, then a passage: the bill's status is Passed, so no Failed status keeps a second
      // failed back.
      const failure = {
        actionCode: "9000",
        actionDate: "2026-01-13",
        actionTime: "17:52:09",
        sourceSystem: { code: 9, name: "Library of Congress" },
        text: "Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).",
        type: "Floor",
      };
      const laterPassage = {
        actionCode: "8000",
        actionDate: "2026-01-21",
        sourceSystem: { code: 9, name: "Library of Congress" },
        text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 216 - 212 (Roll no. 31).",
        type: "Floor",
      };
      twoVersions(
        { ...summary, actions: [laterPassage, cited(failure, "(consideration: CR H6104-6105)")] },
        { ...summary, actions: [laterPassage, failure] },
      );

      await run();

      expect(mockSQSSend).not.toHaveBeenCalled();
      expect(classifiedTypes()).toEqual([[]]);
    });

    describe("H.Con.Res. 89, agreed to in the House and failed in the Senate", () => {
      const library = { code: 9, name: "Library of Congress" };
      const houseAgreed = {
        actionCode: "8000",
        actionDate: "2026-07-23",
        actionTime: "10:25:10",
        sourceSystem: library,
        text: "Passed/agreed to in House: On agreeing to the resolution Agreed to by the Yeas and Nays: 214 - 208 (Roll no. 282).",
        type: "Floor",
      };
      const senateFailed = {
        actionCode: "18000",
        actionDate: "2026-09-24",
        sourceSystem: library,
        text: "Failed of passage/not agreed to in Senate: Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.",
        type: "Floor",
      };

      it.each([
        ["the Senate's failure line (18000)", [cited(senateFailed, "(consideration: CR S6785)"), houseAgreed]],
        ["the House's passage line (8000)", [senateFailed, cited(houseAgreed, "(text: CR H6104)")]],
      ])("sends nothing when %s gains a citation", async (_name, actions) => {
        twoVersions({ ...summary, actions }, { ...summary, actions: [senateFailed, houseAgreed] });

        await run();

        expect(mockSQSSend).not.toHaveBeenCalled();
        expect(classifiedTypes()).toEqual([[]]);
      });
    });

    describe("a step repeated on one day (H.R. 8800, 2026-07-22)", () => {
      // As stored: the House took the bill up as unfinished business twice that day, each line with its citation.
      const unfinishedMorning = {
        actionCode: "H30000",
        actionDate: "2026-07-22",
        actionTime: "11:20:43",
        sourceSystem: floor,
        text: "Considered as unfinished business. (consideration: CR H5029-5127)",
        type: "Floor",
      };
      const unfinishedAfternoon = {
        ...unfinishedMorning,
        actionTime: "15:31:07",
        text: "Considered as unfinished business. (consideration: CR H5153-5157)",
      };
      const committeeRises = {
        actionCode: "H32700",
        actionDate: "2026-07-22",
        actionTime: "12:47:27",
        sourceSystem: floor,
        text: "Committee of the Whole House on the state of the Union rises leaving H.R. 8800 as unfinished business.",
        type: "Floor",
      };

      it.each([
        ["with the first line as before", unfinishedMorning],
        [
          "while the first line gains its citation",
          { ...unfinishedMorning, text: "Considered as unfinished business." },
        ],
      ])("names the second line when it comes in a later version, %s", async (_name, first) => {
        twoVersions(
          { ...summary, actions: [unfinishedAfternoon, committeeRises, unfinishedMorning] },
          { ...summary, actions: [committeeRises, first] },
        );
        mockSQSSend.mockResolvedValueOnce({ Failed: [] });

        await run();

        expect(sentMessages()).toEqual([
          expect.objectContaining({ notificationType: "alert", alert: alertOf(unfinishedAfternoon) }),
        ]);
      });
    });
  });

  it("does not emit passed when passage action already existed in previous version", async () => {
    const guid = "BILLS-119hr7is";
    const key = "processed-bills/BILLS-119hr7.json";

    const passageAction = {
      actionCode: "8000",
      actionDate: "2026-01-15",
      text: "Passed the House",
      type: "Floor",
    };

    // current - same passage action as previous, but billBreakdown changed
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "All", what: "NEW", how: "H", when: "W", where: "Not Applicable", why: "Y" },
            soWhat: "W",
            actions: [passageAction],
          }),
        ),
      },
    });
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-01-16T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-01-16T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    // previous - already has the same passage action
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "All", what: "OLD", how: "H", when: "W", where: "Not Applicable", why: "Y" },
            soWhat: "W",
            actions: [passageAction],
          }),
        ),
      },
    });

    mockSQSSend.mockResolvedValueOnce({ Failed: [] });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    const sqsInput = mockSQSSend.mock.calls[0][0].input;
    // Should only emit "updated", not "passed" or "alert" (actions haven't changed)
    expect(sqsInput.Entries).toHaveLength(1);
    expect(JSON.parse(sqsInput.Entries[0].MessageBody)).toEqual({
      domain: "bill",
      objectId: plain(guid),
      notificationType: "updated",
      sourceRevision: "v2",
    });
  });

  it("does not enqueue when a silent backfill only changes billStatus", async () => {
    const guid = "BILLS-119hr9is";
    const key = "processed-bills/BILLS-119hr9.json";

    const unchangedActions = [
      {
        actionCode: "9000",
        actionDate: "2026-02-12",
        text: "Failed of passage in House: Failed by the Yeas and Nays: 180 - 250.",
        type: "Floor",
      },
    ];

    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            billStatus: "Failed",
            actions: unchangedActions,
          }),
        ),
      },
    });
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-02-12T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-02-12T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(
          JSON.stringify({
            guid,
            title: "T",
            billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
            soWhat: "W",
            actions: unchangedActions,
          }),
        ),
      },
    });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    expect(mockSQSSend).not.toHaveBeenCalled();
  });

  it("does not enqueue when nothing relevant changes", async () => {
    const guid = "BILLS-119hr4is";
    const key = "processed-bills/BILLS-119hr4.json";

    const doc = {
      guid,
      title: "T",
      billBreakdown: { who: "T", what: "T", how: "T", when: "T", where: "Not Applicable", why: "T" },
      soWhat: "W",
      actions: [],
    };

    // current
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(doc)) },
    });
    // list versions
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-01-01T00:01:00Z" },
        { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-01-01T00:00:00Z" },
      ],
      DeleteMarkers: [],
    });
    // previous identical
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(doc)) },
    });

    const mod = require("../handlers/notificationType");
    await mod.handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    expect(mockSQSSend).not.toHaveBeenCalled();
  });

  describe("per-record results", () => {
    const recordFor = (messageId: string, key: string, versionId?: string) => ({
      messageId,
      body: JSON.stringify(s3RecordsForKeys([key], versionId ? { versionId } : undefined)),
    });
    const eventOf = (...records: Array<{ messageId: string; body: string }>) => ({ Records: records });

    const docBody = (doc: Record<string, unknown>) => ({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(doc)) },
    });
    const newBillDoc = (guid: string, soWhat = "S") => ({
      guid,
      title: "T",
      billBreakdown: { who: "W", what: "W", how: "H", when: "W", where: "Not Applicable", why: "Y" },
      soWhat,
      actions: [],
    });
    const singleVersion = (key: string, versionId = "v1") => ({
      IsTruncated: false,
      Versions: [{ Key: key, VersionId: versionId, IsLatest: true, LastModified: "2026-01-01T00:00:00Z" }],
      DeleteMarkers: [],
    });
    const sentBodies = () =>
      mockSQSSend.mock.calls.flatMap((call) =>
        call[0].input.Entries.map((e: SqsEntry) => JSON.parse(e.MessageBody) as SentBody),
      );

    it("reports only the record whose bill could not be read", async () => {
      const failingKey = "processed-bills/BILLS-119hr70.json";
      const okKey = "processed-bills/BILLS-119hr71.json";

      mockS3Send
        .mockRejectedValueOnce(Object.assign(new Error("Please reduce your request rate."), { name: "SlowDown" }))
        .mockResolvedValueOnce(docBody(newBillDoc("BILLS-119hr71is")))
        .mockResolvedValueOnce(singleVersion(okKey, "v7"));
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      const mod = require("../handlers/notificationType");
      const result = await mod.handler(eventOf(recordFor("m-0", failingKey, "v3"), recordFor("m-1", okKey, "v7")));

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m-0" }] });
      expect(sentBodies()).toEqual([
        { domain: "bill", objectId: "BILLS-119hr71", notificationType: "new", sourceRevision: "v7" },
      ]);
    });

    it("reports a record whose messages SQS rejected", async () => {
      const firstKey = "processed-bills/BILLS-119hr72.json";
      const secondKey = "processed-bills/BILLS-119hr73.json";

      mockS3Send
        .mockResolvedValueOnce(docBody(newBillDoc("BILLS-119hr72is")))
        .mockResolvedValueOnce(singleVersion(firstKey))
        .mockResolvedValueOnce(docBody(newBillDoc("BILLS-119hr73is")))
        .mockResolvedValueOnce(singleVersion(secondKey));
      mockSQSSend
        .mockResolvedValueOnce({ Failed: [] })
        .mockResolvedValueOnce({ Failed: [{ Id: "msg-0", Code: "InternalError", SenderFault: false }] });

      const mod = require("../handlers/notificationType");
      const result = await mod.handler(eventOf(recordFor("m-0", firstKey, "v1"), recordFor("m-1", secondKey, "v1")));

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m-1" }] });
      expect(mockSQSSend).toHaveBeenCalledTimes(2);
    });

    it("processes an object repeated across records of one batch once", async () => {
      const key = "processed-bills/BILLS-119hr74.json";

      mockS3Send
        .mockResolvedValueOnce(docBody(newBillDoc("BILLS-119hr74is")))
        .mockResolvedValueOnce(singleVersion(key, "v4"));
      mockSQSSend.mockResolvedValueOnce({ Failed: [] });

      const mod = require("../handlers/notificationType");
      const result = await mod.handler(eventOf(recordFor("m-0", key, "v4"), recordFor("m-1", key, "v4")));

      expect(result).toEqual({ batchItemFailures: [] });
      expect(mockS3Send).toHaveBeenCalledTimes(2);
      expect(sentBodies()).toHaveLength(1);
    });

    it("falls back to a content hash revision when neither the message nor S3's answer has a version id", async () => {
      const key = "processed-bills/BILLS-119hr75.json";
      const guid = "BILLS-119hr75is";

      mockS3Send
        .mockResolvedValueOnce(docBody(newBillDoc(guid, "first")))
        .mockResolvedValueOnce(singleVersion(key))
        .mockResolvedValueOnce(docBody(newBillDoc(guid, "second")))
        .mockResolvedValueOnce(singleVersion(key))
        .mockResolvedValueOnce(docBody(newBillDoc(guid, "first")))
        .mockResolvedValueOnce(singleVersion(key));
      mockSQSSend.mockResolvedValue({ Failed: [] });

      const mod = require("../handlers/notificationType");
      await mod.handler(eventOf(recordFor("m-0", key)));
      await mod.handler(eventOf(recordFor("m-0", key)));
      await mod.handler(eventOf(recordFor("m-0", key)));

      const [first, second, third] = sentBodies().map((body: SentBody) => body.sourceRevision);
      expect(first).toMatch(/^sha256:[0-9a-f]{32}$/);
      expect(second).not.toBe(first);
      expect(third).toBe(first);
    });

    it("stamps a message without a version id with the version S3 returned as the latest (REL-59)", async () => {
      const key = "processed-bills/BILLS-119hr76.json";

      mockS3Send
        .mockResolvedValueOnce({ ...docBody(newBillDoc("BILLS-119hr76is")), VersionId: "v9" })
        .mockResolvedValueOnce(singleVersion(key, "v9"));
      mockSQSSend.mockResolvedValue({ Failed: [] });

      const mod = require("../handlers/notificationType");
      await mod.handler(eventOf(recordFor("m-0", key)));

      expect(sentBodies()).toEqual([
        { domain: "bill", objectId: "BILLS-119hr76", notificationType: "new", sourceRevision: "v9" },
      ]);
      expect(logLinesWithMessage(console.log, "Classified processed bill")).toEqual([
        expect.objectContaining({ key, versionId: "v9", previousVersionId: null, pair: "latest", types: ["new"] }),
      ]);
    });

    describe("unprocessable objects (C1.8)", () => {
      const DROP_LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";
      const dropLines = () => logLines(console.warn).filter((line) => line.message === DROP_LOG_MESSAGE);
      const dropMetrics = () => logLines(console.log).filter((line) => line._aws && "MessagesUnprocessable" in line);
      // S3 by key: a stored document has one version ("v1"); any other key does not exist.
      const routeS3 = (docs: Record<string, Record<string, unknown>>) =>
        mockS3Send.mockImplementation(async (command: FakeS3Command) => {
          const { Key, Prefix } = command.input;
          if (Prefix !== undefined) {
            return docs[Prefix] ? singleVersion(Prefix) : { IsTruncated: false, Versions: [], DeleteMarkers: [] };
          }
          if (!docs[Key!]) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
          return docBody(docs[Key!]);
        });
      const recordForKeys = (messageId: string, keys: string[]) => ({
        messageId,
        body: JSON.stringify(s3RecordsForKeys(keys, { versionId: "v1" })),
      });
      const missingKey = "processed-bills/BILLS-119hr80.json";
      const noIdKey = "processed-bills/not-a-bill.json";
      const goodKey = "processed-bills/BILLS-119hr81.json";

      it("acknowledges, logs and counts an object whose named version cannot be loaded", async () => {
        routeS3({});

        const mod = require("../handlers/notificationType");
        const result = await mod.handler(eventOf(recordForKeys("m-0", [missingKey])));

        expect(result).toEqual({ batchItemFailures: [] });
        expect(mockSQSSend).not.toHaveBeenCalled();
        expect(dropLines()).toEqual([
          expect.objectContaining({
            dropSite: "notificationType.currentMissing",
            reason: "version_not_found",
            messageId: "m-0",
            sqsMessageId: "m-0",
            key: missingKey,
            versionId: "v1",
          }),
        ]);
        expect(dropMetrics()).toEqual([
          expect.objectContaining({ MessagesUnprocessable: 1, dropSite: "notificationType.currentMissing" }),
        ]);
      });

      it("keeps the reason current_not_found for a message without a version whose key has no current version", async () => {
        routeS3({});

        const mod = require("../handlers/notificationType");
        const result = await mod.handler(
          eventOf({ messageId: "m-0", body: JSON.stringify(s3RecordsForKeys([missingKey])) }),
        );

        expect(result).toEqual({ batchItemFailures: [] });
        expect(mockSQSSend).not.toHaveBeenCalled();
        expect(dropLines()).toEqual([
          expect.objectContaining({
            dropSite: "notificationType.currentMissing",
            reason: "current_not_found",
            key: missingKey,
          }),
        ]);
      });

      it("acknowledges, logs and counts a processed bill whose id cannot be resolved", async () => {
        routeS3({ [noIdKey]: { title: "No guid", actions: [] } });

        const mod = require("../handlers/notificationType");
        const result = await mod.handler(eventOf(recordForKeys("m-0", [noIdKey])));

        expect(result).toEqual({ batchItemFailures: [] });
        expect(mockSQSSend).not.toHaveBeenCalled();
        expect(dropLines()).toEqual([
          expect.objectContaining({
            dropSite: "notificationType.unresolvedBillId",
            reason: "no_bill_id",
            messageId: "m-0",
            key: noIdKey,
          }),
        ]);
        expect(dropMetrics()).toEqual([
          expect.objectContaining({ MessagesUnprocessable: 1, dropSite: "notificationType.unresolvedBillId" }),
        ]);
      });

      it("goes on with the record's other objects after a bad one, and counts only the bad ones", async () => {
        routeS3({ [noIdKey]: { title: "No guid" }, [goodKey]: newBillDoc("BILLS-119hr81is") });
        mockSQSSend.mockResolvedValue({ Failed: [] });

        const mod = require("../handlers/notificationType");
        const result = await mod.handler(eventOf(recordForKeys("m-0", [missingKey, noIdKey, goodKey])));

        expect(result).toEqual({ batchItemFailures: [] });
        expect(sentBodies()).toEqual([
          // Named by the plain guid of its key, not the document's suffixed one (REL-41).
          { domain: "bill", objectId: "BILLS-119hr81", notificationType: "new", sourceRevision: "v1" },
        ]);
        expect(dropLines().map((line) => [line.key, line.dropSite])).toEqual([
          [missingKey, "notificationType.currentMissing"],
          [noIdKey, "notificationType.unresolvedBillId"],
        ]);
        expect(dropMetrics()).toHaveLength(2);
      });

      it("counts nothing for a processed bill it classifies", async () => {
        routeS3({ [goodKey]: newBillDoc("BILLS-119hr81is") });
        mockSQSSend.mockResolvedValue({ Failed: [] });

        const mod = require("../handlers/notificationType");
        const result = await mod.handler(eventOf(recordForKeys("m-0", [goodKey])));

        expect(result).toEqual({ batchItemFailures: [] });
        expect(sentBodies()).toHaveLength(1);
        expect(dropLines()).toEqual([]);
        expect(dropMetrics()).toEqual([]);
      });

      it("still acknowledges and goes on when the drop's log and metric lines throw", async () => {
        routeS3({ [goodKey]: newBillDoc("BILLS-119hr81is") });
        mockSQSSend.mockResolvedValue({ Failed: [] });
        (console.warn as jest.Mock).mockImplementation((line: unknown) => {
          if (String(line).includes(DROP_LOG_MESSAGE)) throw new Error("console.warn broke");
        });
        (console.log as jest.Mock).mockImplementation((line: unknown) => {
          if (String(line).includes('"MessagesUnprocessable"')) throw new Error("console.log broke");
        });

        const mod = require("../handlers/notificationType");
        const result = await mod.handler(eventOf(recordForKeys("m-0", [missingKey, goodKey])));

        expect(result).toEqual({ batchItemFailures: [] });
        expect(sentBodies()).toHaveLength(1);
        const attempts = (spy: unknown, needle: string) =>
          (spy as jest.Mock).mock.calls.filter(([line]) => String(line).includes(needle)).length;
        expect(attempts(console.warn, DROP_LOG_MESSAGE)).toBe(1);
        expect(attempts(console.log, '"MessagesUnprocessable"')).toBe(1);
      });
    });
  });

  describe("correlation id (OBS-10)", () => {
    const guid = "BILLS-119hr1is";
    const key = "processed-bills/BILLS-119hr1.json";
    const newBill = { kind: "processed", guid, title: "Title", billBreakdown: { what: "W" }, soWhat: "S", actions: [] };

    const serveNewBill = (metadata?: Record<string, string>) => {
      mockS3Send.mockImplementation(async (command: FakeS3Command) => {
        const input = command.input ?? {};
        if (input.Prefix !== undefined) {
          return { IsTruncated: false, Versions: [{ Key: key, VersionId: "v1", IsLatest: true }], DeleteMarkers: [] };
        }
        return {
          Body: { transformToString: async () => JSON.stringify(newBill) },
          ...(metadata ? { Metadata: metadata } : {}),
        };
      });
      mockSQSSend.mockResolvedValue({ Failed: [] });
    };

    it("reads the id from the processed bill's S3 metadata and sends it to userMatcher", async () => {
      const correlationId = "2026-09-02T10:00:00.000Z:BILLS-119hr1is";
      serveNewBill({ "correlation-id": correlationId });

      const mod = require("../handlers/notificationType");
      await mod.handler(sqsWrappedS3Keys([key], { versionId: "v1" }), { awsRequestId: "req-5" });

      const entry = mockSQSSend.mock.calls[0][0].input.Entries[0];
      expect(JSON.parse(entry.MessageBody)).toEqual({
        domain: "bill",
        objectId: plain(guid),
        notificationType: "new",
        sourceRevision: "v1",
      });
      expect(entry.MessageAttributes).toEqual({ correlationId: { DataType: "String", StringValue: correlationId } });
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Classified processed bill",
          guid: plain(guid),
          correlationId,
          types: ["new"],
          awsRequestId: "req-5",
        }),
      );
    });

    it("mints one when the object has no correlation-id metadata", async () => {
      serveNewBill();

      const mod = require("../handlers/notificationType");
      await mod.handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

      expect(mockSQSSend.mock.calls[0][0].input.Entries[0].MessageAttributes.correlationId.StringValue).toMatch(
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z:BILLS-119hr1$/,
      );
    });
  });

  // REL-56 (docs/RUNBOOK.md 16.1, project decision 2026-11-12): the backfill runs without quiet windows, so a change it
  // wrote (a rel56: correlation id on the processed version) is handed to nobody. BACKFILL_PUSH_MODE 'push' is the
  // rollback: such a change goes to userMatcher as before.
  describe("backfill changes (REL-56, BACKFILL_PUSH_MODE)", () => {
    const key = "processed-bills/BILLS-119hr90.json";
    const BACKFILL_ID = "rel56:2026-11-20T14:30:00.000Z:BILLS-119hr90";
    const POLLER_ID = "2026-11-20T14:33:39.000Z:BILLS-119hr90";
    const breakdown = { who: "W", what: "W", how: "H", when: "W", where: "Not Applicable", why: "Y" };
    const introduced = { actionDate: "2026-03-02", text: "Introduced in House", type: "IntroReferral" };
    const passage = {
      actionCode: "8000",
      actionDate: "2026-06-10",
      text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 250 - 180",
      type: "Floor",
    };
    const storedDoc = {
      guid: "BILLS-119hr90",
      title: "T",
      billBreakdown: breakdown,
      soWhat: "S",
      actions: [introduced],
    };
    const passedDoc = { ...storedDoc, actions: [introduced, passage] };

    interface VersionedS3Input {
      Key?: string;
      Prefix?: string;
      VersionId?: string;
    }
    type StoredVersion = { versionId: string; doc: Record<string, unknown>; metadata?: Record<string, string> };

    /** S3 for one key: its versions, newest first, each with its own metadata. */
    const serveVersions = (versions: StoredVersion[]) => {
      mockS3Send.mockImplementation(async (command: { input: VersionedS3Input }) => {
        const { Prefix, VersionId } = command.input;
        if (Prefix !== undefined) {
          return {
            IsTruncated: false,
            Versions: versions.map((version, index) => ({
              Key: key,
              VersionId: version.versionId,
              IsLatest: index === 0,
              LastModified: `2026-11-20T14:3${5 - index}:00Z`,
            })),
            DeleteMarkers: [],
          };
        }
        const found = VersionId ? versions.find((version) => version.versionId === VersionId) : versions[0];
        if (!found) throw Object.assign(new Error("The specified version does not exist."), { name: "NoSuchVersion" });
        return {
          Body: { transformToString: async () => JSON.stringify(found.doc) },
          ...(found.metadata ? { Metadata: found.metadata } : {}),
        };
      });
      mockSQSSend.mockResolvedValue({ Failed: [] });
    };
    const withId = (correlationId: string) => ({ "correlation-id": correlationId });
    const sentTypes = () =>
      mockSQSSend.mock.calls.flatMap((call) =>
        call[0].input.Entries.map((entry: SqsEntry) => (JSON.parse(entry.MessageBody) as SentBody).notificationType),
      );
    const skipLines = () => logLinesWithMessage(console.log, "Backfill change; no push sent (REL-56)");
    const skipMetrics = () => logLines(console.log).filter((line) => line._aws && "BackfillPushSkipped" in line);
    const batchLine = () => logLinesWithMessage(console.log, "notificationType batch complete")[0];
    const handle = async (event = sqsWrappedS3Keys([key], { versionId: "v2" })) => {
      const mod = require("../handlers/notificationType");
      return mod.handler(event, { awsRequestId: "req-90" });
    };

    it("sends nothing to userMatcher for a never-stored bill the backfill brought in, and logs and counts the skip", async () => {
      serveVersions([{ versionId: "v2", doc: storedDoc, metadata: withId(BACKFILL_ID) }]);

      const result = await handle();

      expect(result).toEqual({ batchItemFailures: [] });
      expect(mockSQSSend).not.toHaveBeenCalled();
      // Still classified and logged as any other change.
      expect(logLinesWithMessage(console.log, "Classified processed bill")).toEqual([
        expect.objectContaining({ guid: "BILLS-119hr90", correlationId: BACKFILL_ID, types: ["new"] }),
      ]);
      expect(skipLines()).toEqual([
        expect.objectContaining({
          guid: "BILLS-119hr90",
          correlationId: BACKFILL_ID,
          key,
          versionId: "v2",
          types: ["new"],
          backfillPushMode: "skip",
          awsRequestId: "req-90",
        }),
      ]);
      expect(skipMetrics()).toHaveLength(1);
      expect(skipMetrics()[0]).toMatchObject({ BackfillPushSkipped: 1 });
      expect(skipMetrics()[0]._aws!.CloudWatchMetrics[0]).toEqual({
        Namespace: "BillBoard/Notifications",
        Dimensions: [[]],
        Metrics: [{ Name: "BackfillPushSkipped", Unit: "Count" }],
      });
      expect(batchLine()).toMatchObject({
        records: 1,
        failedRecords: 0,
        scanned: 1,
        enqueued: 0,
        backfillPushSkipped: 1,
      });
    });

    it("skips every push of a stale bill's backfilled news, the outcome and its paired alert together", async () => {
      process.env.BACKFILL_PUSH_MODE = "skip";
      serveVersions([
        { versionId: "v2", doc: passedDoc, metadata: withId(BACKFILL_ID) },
        { versionId: "v1", doc: storedDoc, metadata: withId("2026-03-02T10:03:39.000Z:BILLS-119hr90") },
      ]);

      await handle();

      expect(mockSQSSend).not.toHaveBeenCalled();
      expect(skipLines()).toEqual([
        expect.objectContaining({ types: ["alert", "passed"], correlationId: BACKFILL_ID }),
      ]);
      expect(skipMetrics()).toHaveLength(1);
    });

    it("reads a backfill id from the record when the version carries none", async () => {
      serveVersions([{ versionId: "v2", doc: storedDoc }]);

      await handle(
        asSqsEvent({
          Records: [
            {
              messageId: "m-0",
              body: JSON.stringify(s3RecordsForKeys([key], { versionId: "v2" })),
              messageAttributes: { correlationId: { stringValue: BACKFILL_ID, dataType: "String" } },
            },
          ],
        }),
      );

      expect(mockSQSSend).not.toHaveBeenCalled();
      expect(skipLines()).toEqual([expect.objectContaining({ correlationId: BACKFILL_ID, types: ["new"] })]);
    });

    it.each([
      ["the poller's", POLLER_ID],
      ["a REL-32 refetch's", "refetch:2026-11-20T14:30:00.000Z:BILLS-119hr90"],
      ["an upper-case look-alike", "REL56:2026-11-20T14:30:00.000Z:BILLS-119hr90"],
    ])("still sends a change with %s id", async (_name, correlationId) => {
      serveVersions([
        { versionId: "v2", doc: passedDoc, metadata: withId(correlationId) },
        { versionId: "v1", doc: storedDoc },
      ]);

      await handle();

      expect(sentTypes()).toEqual(["alert", "passed"]);
      expect(mockSQSSend.mock.calls[0][0].input.Entries[0].MessageAttributes.correlationId.StringValue).toBe(
        correlationId,
      );
      expect(skipLines()).toEqual([]);
      expect(skipMetrics()).toEqual([]);
      expect(batchLine()).toMatchObject({ enqueued: 2, backfillPushSkipped: 0 });
    });

    it("still sends a change whose id it had to mint", async () => {
      serveVersions([{ versionId: "v2", doc: storedDoc }]);

      await handle();

      expect(sentTypes()).toEqual(["new"]);
      expect(skipLines()).toEqual([]);
    });

    it("counts nothing for a backfilled version that would push nothing", async () => {
      serveVersions([
        { versionId: "v2", doc: { ...storedDoc, billStatus: "Introduced" }, metadata: withId(BACKFILL_ID) },
        { versionId: "v1", doc: storedDoc },
      ]);

      await handle();

      expect(mockSQSSend).not.toHaveBeenCalled();
      expect(skipLines()).toEqual([]);
      expect(skipMetrics()).toEqual([]);
    });

    it("hands a backfill change to userMatcher as before under BACKFILL_PUSH_MODE=push (the rollback)", async () => {
      process.env.BACKFILL_PUSH_MODE = "push";
      serveVersions([
        { versionId: "v2", doc: passedDoc, metadata: withId(BACKFILL_ID) },
        { versionId: "v1", doc: storedDoc },
      ]);

      await handle();

      expect(sentTypes()).toEqual(["alert", "passed"]);
      const entry = mockSQSSend.mock.calls[0][0].input.Entries[0];
      expect(entry.MessageAttributes).toEqual({ correlationId: { DataType: "String", StringValue: BACKFILL_ID } });
      expect(skipLines()).toEqual([]);
      expect(skipMetrics()).toEqual([]);
    });

    it.each(["watch", "", "PUSH", "off"])("skips under any other value (%p): the safe side", async (value) => {
      process.env.BACKFILL_PUSH_MODE = value;
      serveVersions([{ versionId: "v2", doc: storedDoc, metadata: withId(BACKFILL_ID) }]);

      await handle();

      expect(mockSQSSend).not.toHaveBeenCalled();
      expect(skipLines()).toEqual([expect.objectContaining({ backfillPushMode: "skip" })]);
    });

    it("skips the backfill's object and sends the other objects of the same record", async () => {
      const otherKey = "processed-bills/BILLS-119hr91.json";
      mockS3Send.mockImplementation(async (command: { input: VersionedS3Input }) => {
        const { Key, Prefix } = command.input;
        const objectKey = Prefix ?? Key;
        if (Prefix !== undefined) {
          return {
            IsTruncated: false,
            Versions: [{ Key: objectKey, VersionId: "v1", IsLatest: true }],
            DeleteMarkers: [],
          };
        }
        return objectKey === key
          ? { Body: { transformToString: async () => JSON.stringify(storedDoc) }, Metadata: withId(BACKFILL_ID) }
          : {
              Body: { transformToString: async () => JSON.stringify({ ...storedDoc, guid: "BILLS-119hr91" }) },
              Metadata: withId("2026-11-20T14:33:39.000Z:BILLS-119hr91"),
            };
      });
      mockSQSSend.mockResolvedValue({ Failed: [] });

      const result = await handle(
        asSqsEvent({
          Records: [{ messageId: "m-0", body: JSON.stringify(s3RecordsForKeys([key, otherKey], { versionId: "v1" })) }],
        }),
      );

      expect(result).toEqual({ batchItemFailures: [] });
      const bodies = mockSQSSend.mock.calls.flatMap((call) =>
        call[0].input.Entries.map((entry: SqsEntry) => JSON.parse(entry.MessageBody) as SentBody),
      );
      expect(bodies).toEqual([
        { domain: "bill", objectId: "BILLS-119hr91", notificationType: "new", sourceRevision: "v1" },
      ]);
      expect(skipLines()).toEqual([expect.objectContaining({ guid: "BILLS-119hr90" })]);
      expect(batchLine()).toMatchObject({ scanned: 2, enqueued: 1, backfillPushSkipped: 1 });
    });
  });
});
