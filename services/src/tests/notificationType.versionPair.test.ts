import { applyTestEnv } from "./fixtures/env";
import { asSqsEvent } from "./fixtures/awsEvents";
import { logLinesWithMessage } from "./logLines";
import { buildS3WrappedObjectMessage } from "../shared/replayCongressVoteProfiles";

// REL-59: NotificationType judges the version a message names against the content version stored just before it. The
// shape is H.R. 9612 on 2026-11-10: BillDiffer stored the House passage (v1), vote enrichment rewrote the raw bill, and
// BillDiffer stored a second version 1.5 s later (v2) that changed only officialVotes. Before REL-59 no message named a
// version and both read (v2, v1) when they ran, so the passage was never compared and its followers got no push.

const originalEnv = { ...process.env };
const mockS3Send = jest.fn();
const mockSQSSend = jest.fn();

/** The S3 commands the mocked constructors below return. */
interface FakeS3Command {
  kind: "get" | "list";
  input: { Key?: string; Prefix?: string; VersionId?: string };
}

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ kind: "get", input })),
  ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ kind: "list", input })),
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSQSSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const BUCKET = "test-bucket";
const KEY = "processed-bills/BILLS-119hr9612.json";
const GUID = "BILLS-119hr9612";
const CORRELATION_ID = "2026-11-10T18:18:39.680Z:BILLS-119hr9612";

const base = {
  kind: "processed",
  guid: GUID,
  title: "Grid Reliability Act",
  billBreakdown: { who: "W", what: "W", how: "H", when: "W", where: "Not Applicable", why: "Y" },
  soWhat: "S",
};
const reported = [
  {
    actionDate: "2026-11-05",
    actionCode: "H12410",
    type: "Calendars",
    text: "Placed on the Union Calendar, Calendar No. 772.",
  },
  { actionDate: "2026-07-09", actionCode: "1000", type: "IntroReferral", text: "Introduced in House" },
];
const passage = [
  {
    actionDate: "2026-11-09",
    actionCode: "H38310",
    type: "Floor",
    text: "Motion to reconsider laid on the table Agreed to without objection.",
  },
  {
    actionDate: "2026-11-09",
    actionCode: "8000",
    type: "Floor",
    text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by the Yeas and Nays: (2/3 required): 394 - 3 (Roll no. 316).",
  },
  {
    actionDate: "2026-11-09",
    actionCode: "H30000",
    type: "Floor",
    text: "Considered under suspension of the rules. (consideration: CR H6100-6102)",
  },
];
/** v0: reported, not passed. */
const v0 = { ...base, billStatus: "New", actions: reported, storedAt: "2026-11-10T14:26:33.000Z" };
/** v1: the passage, with the roll call's first, partial official votes. */
const v1 = {
  ...base,
  billStatus: "Passed",
  actions: [...passage, ...reported],
  officialVotes: { house: { rollCall: 316, members: [] }, completeness: "partial" },
  storedAt: "2026-11-10T18:19:33.548Z",
};
/** v2: vote enrichment filled in the members; nothing a push compares changed. */
const v2 = {
  ...v1,
  officialVotes: {
    house: { rollCall: 316, members: Array.from({ length: 433 }, (_, i) => ({ m: i })) },
    completeness: "full",
  },
  storedAt: "2026-11-10T18:19:34.995Z",
};

type Version = { id: string; doc: unknown; lastModified: string };

const listingOf = (newestFirst: Version[]) => ({
  IsTruncated: false,
  Versions: newestFirst.map((v, i) => ({ Key: KEY, VersionId: v.id, IsLatest: i === 0, LastModified: v.lastModified })),
  DeleteMarkers: [],
});

const objectOf = (v: Version) => ({
  Body: { transformToString: async () => JSON.stringify(v.doc) },
  Metadata: { "correlation-id": CORRELATION_ID },
  VersionId: v.id,
  LastModified: new Date(v.lastModified),
});

const noSuchVersion = () =>
  Object.assign(new Error("The specified version does not exist."), { Code: "NoSuchVersion" });

/** A versioned bucket: GetObject by VersionId or the latest, ListObjectVersions newest first, as S3 lists them. */
const serveChain = (newestFirst: Version[]) => {
  mockS3Send.mockImplementation(async (cmd: FakeS3Command) => {
    if (cmd.kind === "list") return listingOf(newestFirst);
    const v = cmd.input.VersionId ? newestFirst.find((c) => c.id === cmd.input.VersionId) : newestFirst[0];
    if (!v) throw noSuchVersion();
    return objectOf(v);
  });
};

const V2: Version = { id: "MnbuFWnH", doc: v2, lastModified: "2026-11-10T18:19:36.000Z" };
const V1: Version = { id: "bKsfwLCK", doc: v1, lastModified: "2026-11-10T18:19:34.000Z" };
const V0: Version = { id: "ruHUGfkl", doc: v0, lastModified: "2026-11-10T14:26:33.000Z" };
const CHAIN: Version[] = [V2, V1, V0];

/** An SQS record whose body is what CreateBillsManifest sends: the bucket, the key and, from REL-59 (2/2), the version. */
const record = (messageId: string, versionId?: string) => ({
  messageId,
  body: buildS3WrappedObjectMessage(BUCKET, KEY, versionId),
});

type SentMessage = { notificationType: string; sourceRevision: string; passed?: { actionCode?: string } };
const sent = (): SentMessage[] =>
  mockSQSSend.mock.calls.flatMap((call) =>
    call[0].input.Entries.map((e: { MessageBody: string }) => JSON.parse(e.MessageBody) as SentMessage),
  );
/** Each message userMatcher got, as "<type>@<sourceRevision>". */
const summary = () => sent().map((m) => `${m.notificationType}@${m.sourceRevision}`);
const classified = () =>
  logLinesWithMessage(console.log, "Classified processed bill").map((l) => [
    l.versionId,
    l.previousVersionId,
    l.pair,
    l.types,
  ]);
const s3Calls = () => mockS3Send.mock.calls.map(([c]: [FakeS3Command]) => [c.kind, c.input.VersionId]);

describe("notificationType: the version a message names against the one stored before it (REL-59)", () => {
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.resetModules();
    mockS3Send.mockReset();
    mockSQSSend.mockReset();
    mockSQSSend.mockResolvedValue({ Failed: [] });
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: BUCKET,
        QUEUE_URL: "https://example.com/user-matcher-queue",
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

  it("sends v1's passage although v2 was stored before either message was read (H.R. 9612, 2026-11-10)", async () => {
    serveChain(CHAIN);
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("m-v1", V1.id)] }));
    await handler(asSqsEvent({ Records: [record("m-v2", V2.id)] }));

    expect(summary()).toEqual(["alert@bKsfwLCK", "passed@bKsfwLCK"]);
    expect(sent().find((m) => m.notificationType === "passed")?.passed?.actionCode).toBe("8000");
    expect(classified()).toEqual([
      ["bKsfwLCK", "ruHUGfkl", "named", ["alert", "passed"]],
      ["MnbuFWnH", "bKsfwLCK", "named", []],
    ]);
  });

  it("gives the same pushes when the two messages come in the other order or in one batch", async () => {
    serveChain(CHAIN);
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("m-v2", V2.id)] }));
    await handler(asSqsEvent({ Records: [record("m-v1", V1.id)] }));
    expect(summary()).toEqual(["alert@bKsfwLCK", "passed@bKsfwLCK"]);

    mockSQSSend.mockClear();
    await handler(asSqsEvent({ Records: [record("m-v2", V2.id), record("m-v1", V1.id)] }));
    expect(summary()).toEqual(["alert@bKsfwLCK", "passed@bKsfwLCK"]);
  });

  it("stamps a redelivered message with the same revision, which userMatcher's dedupe marker relies on", async () => {
    serveChain(CHAIN);
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("m-1", V1.id)] }));
    await handler(asSqsEvent({ Records: [record("m-1", V1.id)] }));

    expect(summary()).toEqual(["alert@bKsfwLCK", "passed@bKsfwLCK", "alert@bKsfwLCK", "passed@bKsfwLCK"]);
  });

  it("keeps S3's order for two versions listed in the same second (H.R. 3978: 0.26 s apart)", async () => {
    serveChain([
      { id: "agXWSGcd", doc: v2, lastModified: "2026-11-10T18:19:37.000Z" },
      { id: "PfLnZU9a", doc: v1, lastModified: "2026-11-10T18:19:37.000Z" },
      { id: "WDBtnHKw", doc: v0, lastModified: "2026-11-09T02:05:00.000Z" },
    ]);
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("a", "PfLnZU9a"), record("b", "agXWSGcd")] }));

    expect(summary()).toEqual(["alert@PfLnZU9a", "passed@PfLnZU9a"]);
    expect(classified()).toEqual([
      ["PfLnZU9a", "WDBtnHKw", "named", ["alert", "passed"]],
      ["agXWSGcd", "PfLnZU9a", "named", []],
    ]);
  });

  // A NotificationType from before REL-59 read d1 here and judged it against itself (it fell back to the 2nd-latest when
  // the named version had none before it), so it sent nothing and the bill's new was lost. That is why no message that
  // names a version may reach, or be redriven from NotificationTypeDLQ into, an older NotificationType (RUNBOOK 18.10,
  // rolling back; 2.3, 2.4 and 11.1).
  it("sends new for the oldest stored version even when a newer one exists, never judging it against that one", async () => {
    serveChain([
      { id: "s2", doc: { ...v0, soWhat: "Summarized" }, lastModified: "2026-11-10T18:19:40.000Z" },
      { id: "d1", doc: v0, lastModified: "2026-11-10T18:19:36.000Z" },
    ]);
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("a", "d1"), record("b", "s2")] }));

    expect(summary()).toEqual(["new@d1", "updated@s2"]);
    expect(classified()).toEqual([
      ["d1", null, "named", ["new"]],
      ["s2", "d1", "named", ["updated"]],
    ]);
  });

  it("drops, logs and counts a named version that is no longer stored, without reading the latest in its place", async () => {
    serveChain(CHAIN);
    const { handler } = require("../handlers/notificationType");

    const result = await handler(asSqsEvent({ Records: [record("m-gone", "expired0")] }));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(mockSQSSend).not.toHaveBeenCalled();
    expect(s3Calls()).toEqual([["get", "expired0"]]);
    expect(logLinesWithMessage(console.warn, "Message cannot be processed; acknowledged without retry")).toEqual([
      expect.objectContaining({
        dropSite: "notificationType.currentMissing",
        reason: "version_not_found",
        key: KEY,
        versionId: "expired0",
      }),
    ]);
  });

  it("fails the record, for SQS to retry, when the version read is missing from the listing", async () => {
    mockS3Send.mockImplementation(async (cmd: FakeS3Command) =>
      cmd.kind === "list" ? listingOf([V2, V0]) : objectOf(V1),
    );
    const { handler } = require("../handlers/notificationType");

    const result = await handler(asSqsEvent({ Records: [record("m-v1", V1.id)] }));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m-v1" }] });
    expect(mockSQSSend).not.toHaveBeenCalled();
    expect(classified()).toEqual([]);
  });

  it("reads the latest pair for a message without a version (CreateBillsManifest before REL-59 (2/2))", async () => {
    serveChain(CHAIN);
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("m-old")] }));

    expect(summary()).toEqual([]);
    expect(classified()).toEqual([["MnbuFWnH", "bKsfwLCK", "latest", []]]);
    expect(s3Calls()).toEqual([
      ["get", undefined],
      ["list", undefined],
      ["get", "bKsfwLCK"],
    ]);
  });

  it("pairs a versionless read with the predecessor of the version GetObject returned, not the 2nd-latest listed", async () => {
    // v2 is stored between the GetObject of the latest (then v1) and the listing.
    let stored = [V1, V0];
    mockS3Send.mockImplementation(async (cmd: FakeS3Command) => {
      if (cmd.kind === "list") {
        stored = CHAIN;
        return listingOf(stored);
      }
      const v = cmd.input.VersionId ? stored.find((c) => c.id === cmd.input.VersionId) : stored[0];
      if (!v) throw noSuchVersion();
      return objectOf(v);
    });
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("m-old")] }));

    expect(summary()).toEqual(["alert@bKsfwLCK", "passed@bKsfwLCK"]);
    expect(classified()).toEqual([["bKsfwLCK", "ruHUGfkl", "latest", ["alert", "passed"]]]);
  });

  it("gives a message without a version and one naming the same version one revision (the deploy of REL-59 (2/2))", async () => {
    serveChain([V1, V0]);
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("m-old")] }));
    await handler(asSqsEvent({ Records: [record("m-new", V1.id)] }));

    expect(summary()).toEqual(["alert@bKsfwLCK", "passed@bKsfwLCK", "alert@bKsfwLCK", "passed@bKsfwLCK"]);
    expect(classified()).toEqual([
      ["bKsfwLCK", "ruHUGfkl", "latest", ["alert", "passed"]],
      ["bKsfwLCK", "ruHUGfkl", "named", ["alert", "passed"]],
    ]);
  });

  it("stamps a versionless bill's new with its first version's id, the revision a companion bill's new defers to", async () => {
    serveChain([V0]);
    const { handler } = require("../handlers/notificationType");

    await handler(asSqsEvent({ Records: [record("m-old")] }));

    expect(summary()).toEqual(["new@ruHUGfkl"]);
  });
});
