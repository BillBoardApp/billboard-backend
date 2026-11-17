// The text version check (project decision 2026-11-17; docs/RUNBOOK.md 4.9 and 16.1 step 6): a version whose only
// news is its text (another source-text-hash) moves the row only when congress.gov listed a new text version or
// retitled the bill between the raw copy the row's summary text came from and the raw copy the new summary came from
// (shared/textVersionEvidence.ts). Text newly stored for a version already listed keeps the date; a copy that cannot
// be found or read moves the row as before.
process.env.BUCKET_NAME = "test-bucket";
process.env.TABLE_NAME = "test-table";
process.env.PRIMARY_KEY = "pk";
process.env.SORT_KEY = "sk";
process.env.PK_VALUE = "BILL";
process.env.QUEUE_URL = "https://example.com/notification-type";
process.env.CONGRESS_MEMBER_STATS_QUEUE_URL = "https://example.com/member-stats";

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { handler } from "../handlers/createBillsManifest";
import { sourceTextHash } from "../shared/billSourceReconcile";
import { billContentHash, formatDateBasis, manifestDateBasis, textVersionDigest } from "../shared/billVersionChange";
import type { TextVersionEvidence } from "../shared/textVersionEvidence";
import { asSqsEvent } from "./fixtures/awsEvents";
import { evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { RAW_COPY_STORED, rawCopy, type FixtureGuid } from "./fixtures/rel56TextVersions";
import { jsonReadable } from "./fixtures/streams";
import { FakeVersionedS3, type FakeS3Command } from "./fakeVersionedS3";
import { logLines, logLinesWithMessage } from "./logLines";

type Item = Record<string, AttributeValue>;
type DdbCommand = { __type: string; input: Record<string, unknown> };
type WriteSpec = ConditionInput & { Item?: Item; Key?: Item };
type TransactItem = { Put?: WriteSpec; Delete?: WriteSpec; Update?: WriteSpec };
type SqsEntry = { Id: string; MessageBody: string };

let mockS3 = new FakeVersionedS3("2026-11-17T00:00:00.000Z");
/** The table: items by "pk|sk". */
let mockTable = new Map<string, Item>();
/** Runs once, before the next transaction is checked (a concurrent writer). */
let mockBeforeTransaction: (() => Promise<void>) | null = null;
const mockDdbCommands: DdbCommand[] = [];

const mockItemKey = (key: Item | undefined): string => {
  if (!key?.pk?.S || !key?.sk?.S) throw new Error("Missing pk or sk");
  return `${key.pk.S}|${key.sk.S}`;
};

/** A GetObject answer from the fake bucket: it carries a body that reads as a string. */
const hasBody = (response: object): response is { Body: { transformToString(): Promise<string> } } =>
  "Body" in response;

const mockSendS3 = async (command: FakeS3Command) => {
  const response = await mockS3.send(command);
  if (command.__cmd !== "GetObject" || !hasBody(response)) return response;
  // The handler streams the body, as the SDK's Readable in Lambda.
  return { ...response, Body: jsonReadable(JSON.parse(await response.Body.transformToString())) };
};

const mockSendDdb = async (command: DdbCommand) => {
  mockDdbCommands.push(command);
  if (command.__type === "GetItem") {
    return { Item: mockTable.get(mockItemKey(command.input.Key as Item)) };
  }
  if (command.__type === "TransactWriteItems") {
    const hook = mockBeforeTransaction;
    mockBeforeTransaction = null;
    if (hook) await hook();
    const ops = command.input.TransactItems as TransactItem[];
    const keys = ops.map((op) => {
      if (op.Update) throw new Error("No Update expected in these tests");
      return mockItemKey(op.Put?.Item ?? op.Delete?.Key);
    });
    const codes = ops.map((op, index) =>
      evaluateCondition(mockTable.get(keys[index]), op.Put ?? op.Delete) ? "None" : "ConditionalCheckFailed",
    );
    if (codes.some((code) => code !== "None")) {
      throw Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: codes.map((Code) => ({ Code })),
      });
    }
    ops.forEach((op, index) => {
      if (op.Put?.Item) mockTable.set(keys[index], op.Put.Item);
      else mockTable.delete(keys[index]);
    });
    return {};
  }
  throw new Error(`Unexpected DynamoDB command ${command.__type}`);
};

jest.mock("@aws-sdk/client-s3", () => {
  const command = (name: string) => jest.fn().mockImplementation((input: unknown) => ({ __cmd: name, input }));
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: (cmd: FakeS3Command) => mockSendS3(cmd) })),
    GetObjectCommand: command("GetObject"),
    HeadObjectCommand: command("HeadObject"),
    ListObjectVersionsCommand: command("ListObjectVersions"),
  };
});

jest.mock("@aws-sdk/client-dynamodb", () => {
  const command = (name: string) => jest.fn().mockImplementation((input: unknown) => ({ __type: name, input }));
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({ send: (cmd: DdbCommand) => mockSendDdb(cmd) })),
    GetItemCommand: command("GetItem"),
    QueryCommand: command("Query"),
    TransactWriteItemsCommand: command("TransactWriteItems"),
  };
});

jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn().mockImplementation(() => ({
    send: async (cmd: { input: { Entries: SqsEntry[] } }) => ({
      Successful: cmd.input.Entries.map((entry) => ({ Id: entry.Id })),
      Failed: [],
    }),
  })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

/** The parts of a raw copy the processed documents below are built from. */
type RawParts = {
  identifier: { congress: string; billType: string; billNumber: string };
  content: {
    bill: { bill: { title?: string; sponsors?: Array<{ bioguideId: string }> } };
    actions?: { actions?: Array<{ actionCode?: string; actionDate: string; text: string }> };
    cosponsors?: { cosponsors?: Array<{ bioguideId: string }> };
    billXML?: string;
  };
};

type ProcessedDoc = {
  kind: string;
  storedAt: string;
  identifier: { congress: string; billType: string; billNumber: string };
  guid: string;
  title: string;
  soWhat: string;
  subCategories: string[];
  lifeAreas: string[];
  sponsors: string[];
  cosponsors: string[];
  actions: Array<{ actionCode?: string; actionDate: string; text: string }>;
  committees: unknown[];
  billStatus: string;
};

const keyOf = (guid: FixtureGuid) => `processed-bills/${guid}.json`;
const rawKeyOf = (guid: FixtureGuid) => `raw-bills/${guid}.json`;
const textOf = (guid: FixtureGuid, copy: "pre" | "run") => sourceTextHash(rawCopy(guid, copy));

/** A processed bill as BillSummarizer writes it from the bill's run copy: its actions, sponsors and cosponsors. */
const processedDoc = (guid: FixtureGuid, storedAt: string, changes: Partial<ProcessedDoc> = {}): ProcessedDoc => {
  const raw = rawCopy(guid, "run") as unknown as RawParts;
  return {
    kind: "processed",
    storedAt,
    identifier: raw.identifier,
    guid,
    title: raw.content.bill.bill.title ?? "",
    soWhat: "Summary of the text the row reflects.",
    subCategories: ["Healthcare"],
    lifeAreas: ["Medical Costs"],
    sponsors: (raw.content.bill.bill.sponsors ?? []).map((sponsor) => sponsor.bioguideId),
    cosponsors: (raw.content.cosponsors?.cosponsors ?? []).map((cosponsor) => cosponsor.bioguideId),
    actions: (raw.content.actions?.actions ?? []).map(({ actionCode, actionDate, text }) => ({
      actionCode,
      actionDate,
      text,
    })),
    committees: [],
    billStatus: "New",
    ...changes,
  };
};

/** A processed write's S3 metadata: its text hash and, when given, the raw version it was built from (REL-30). */
const written = (textHash: string, rawVersion?: string): Record<string, string> => ({
  "source-text-hash": textHash,
  ...(rawVersion ? { "source-raw-version": rawVersion } : {}),
  "correlation-id": "rel56:2026-11-17T01:40:00.000Z:backfill",
});

const basisOf = (doc: ProcessedDoc, textHash: string) => formatDateBasis(manifestDateBasis(doc, textHash));

/** The d1 basis a release of 2026-10-28 to 2026-11-12 wrote for `doc`: its keys digest each text with its citations. */
const legacyBasisOf = (doc: ProcessedDoc, textHash: string) => {
  const computed = manifestDateBasis(doc, textHash);
  const keys = Array.from(new Set(computed.latestActionKeyPairs!.map(([d1Key]) => d1Key))).sort();
  return ["d1", computed.status, computed.latestActionDate, keys.join("."), computed.textVersion].join("|");
};

/**
 * The exact row CreateBillsManifest writes for `doc` at `updatedAt`; with `stamp`, the contentHash, date basis and
 * documentStoredAt of a release since 2026-10-28 (a legacy row has none).
 */
const manifestRow = (
  doc: ProcessedDoc,
  updatedAt: string,
  stamp?: { dateBasis: string; voteCount?: string },
): Item => ({
  pk: { S: "BILL" },
  sk: { S: `${updatedAt}#${doc.guid}` },
  guid: { S: doc.guid },
  billType: { S: doc.identifier.billType },
  congress: { S: doc.identifier.congress },
  billNumber: { S: doc.identifier.billNumber },
  updatedAt: { S: updatedAt },
  title: { S: doc.title },
  subCategories: { L: doc.subCategories.map((value) => ({ S: value })) },
  lifeAreas: { L: doc.lifeAreas.map((value) => ({ S: value })) },
  sponsors: { L: doc.sponsors.map((value) => ({ S: value })) },
  cosponsors: { L: doc.cosponsors.map((value) => ({ S: value })) },
  voteCount: { N: stamp?.voteCount ?? "0" },
  ...(stamp
    ? {
        contentHash: { S: billContentHash(doc) },
        dateBasis: { S: stamp.dateBasis },
        documentStoredAt: { S: doc.storedAt },
      }
    : {}),
  billStatus: { S: doc.billStatus },
});

const lookup = (guid: FixtureGuid, updatedAt: string): Item => ({
  pk: { S: "BILL_GUID" },
  sk: { S: guid },
  guid: { S: guid },
  manifestSk: { S: `${updatedAt}#${guid}` },
  updatedAt: { S: updatedAt },
});

const seedRow = (row: Item) => {
  const guid = row.guid.S as FixtureGuid;
  mockTable.set(`BILL|${row.sk.S}`, row);
  mockTable.set(`BILL_GUID|${guid}`, lookup(guid, row.updatedAt.S!));
};

/** Stores a fixture copy at its real LastModified and returns its VersionId. */
const storeRaw = (guid: FixtureGuid, copy: "pre" | "run") =>
  mockS3.putAt(rawKeyOf(guid), rawCopy(guid, copy), RAW_COPY_STORED[guid][copy]);

/** The table as an object, for whole-table comparisons. */
const table = () => Object.fromEntries([...mockTable.entries()].sort(([a], [b]) => a.localeCompare(b)));
const tableWith = (row: Item) => ({
  [`BILL_GUID|${row.guid.S}`]: lookup(row.guid.S as FixtureGuid, row.updatedAt.S!),
  [`BILL|${row.sk.S}`]: row,
});

const event = (guid: FixtureGuid) =>
  asSqsEvent({
    Records: [{ messageId: "m1", body: JSON.stringify({ Records: [{ s3: { object: { key: keyOf(guid) } } }] }) }],
  });

const stats = (response: { body: string }) => JSON.parse(response.body).stats;
const rawCalls = (guid: FixtureGuid, kind: FakeS3Command["__cmd"]) => mockS3.commands(kind, rawKeyOf(guid));

/** A check's evidence, as the dated line logs it. */
const evidence = (fields: Partial<TextVersionEvidence>): TextVersionEvidence => ({
  verdict: "same_text_versions",
  reason: null,
  newRawVersion: null,
  baseRawVersion: null,
  gets: 2,
  skipped: 0,
  ...fields,
});

const WARNING = "Could not read the raw copies to confirm a text version move; it moves as before";

describe("createBillsManifest: a move for the text alone is confirmed from the raw copies (2026-11-17)", () => {
  let info: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;
  const dateLines = () =>
    info.mock.calls.filter(([logged]) => logged === "Dated manifest upsert").map(([, fields]) => fields);
  /** The EMF lines (shared/metrics.ts) the handler wrote. */
  const metricLines = () => logLines(log).filter((line) => line._aws !== undefined);

  beforeEach(() => {
    mockS3 = new FakeVersionedS3("2026-11-17T00:00:00.000Z");
    mockTable = new Map();
    mockBeforeTransaction = null;
    mockDdbCommands.length = 0;
    info = jest.spyOn(console, "info").mockImplementation(() => undefined);
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(Math, "random").mockReturnValue(0); // zero retry backoff
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("golden: BILLS-119hr7349, a legacy bill whose XML the REL-56 run stored, keeps its March date", () => {
    const GUID: FixtureGuid = "BILLS-119hr7349";
    /** The legacy processed version (no S3 metadata) and the row the March load dated 0.81 s after it. */
    const LEGACY_STORED_AT = "2026-03-19T18:55:33.830Z";
    const ROW_AT = "2026-03-19T18:55:34.640Z";
    const legacy = processedDoc(GUID, LEGACY_STORED_AT, { cosponsors: ["P000613"] });
    /** BillDiffer's pre-summary patch of the run: the refetch's cosponsors, and the summarized text's hash. */
    const patch = processedDoc(GUID, "2026-11-17T01:51:24.215Z");
    /** BillSummarizer's summary of the run's text. */
    const summary = processedDoc(GUID, "2026-11-17T01:51:26.008Z", { soWhat: "Summary of the run's text." });

    it("keeps the patch by the previous version, then the summary by its basis and the raw copies", async () => {
      const pre = storeRaw(GUID, "pre");
      const run = storeRaw(GUID, "run");
      mockS3.putAt(keyOf(GUID), legacy, "2026-03-19T18:55:34.000Z");
      seedRow(manifestRow(legacy, ROW_AT));

      // (a) The patch: the same status and actions, the text hash of the copy before the run.
      mockS3.putAt(keyOf(GUID), patch, "2026-11-17T01:51:25.000Z", written(textOf(GUID, "pre"), run));
      const patched = await handler(event(GUID));

      expect(stats(patched)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
      expect(table()).toEqual(
        tableWith(manifestRow(patch, ROW_AT, { dateBasis: basisOf(patch, textOf(GUID, "pre")) })),
      );
      expect(dateLines()).toEqual([
        {
          guid: GUID,
          decision: "kept",
          moves: [],
          changeClass: "bookkeeping_only",
          decidedBy: "previousVersion",
          basis: null,
          sameDay: null,
          textVersionCheck: null,
          rowUpdatedAt: ROW_AT,
          storedAt: patch.storedAt,
        },
      ]);
      info.mockClear();

      // (b) The summary of the run's text: by the hash alone a textVersion move, which the raw copies do not confirm.
      mockS3.putAt(keyOf(GUID), summary, "2026-11-17T01:51:27.000Z", written(textOf(GUID, "run"), run));
      const summarized = await handler(event(GUID));

      expect(stats(summarized)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
      // Still at the March date, with the summary's content, hash, d2 basis (the run's text) and storedAt.
      expect(table()).toEqual(
        tableWith(manifestRow(summary, ROW_AT, { dateBasis: basisOf(summary, textOf(GUID, "run")) })),
      );
      expect(manifestDateBasis(summary, textOf(GUID, "run")).textVersion).toBe(
        textVersionDigest("v1:d2519d9c3e20b7845d391eac0a55044f4ded1bc07d5880b89bb8202f2155eb65"),
      );
      expect(dateLines()).toEqual([
        {
          guid: GUID,
          decision: "kept",
          moves: [],
          changeClass: "user_visible",
          decidedBy: "dateBasis",
          basis: "d2",
          sameDay: "same",
          textVersionCheck: evidence({ newRawVersion: run, baseRawVersion: pre }),
          rowUpdatedAt: ROW_AT,
          storedAt: summary.storedAt,
        },
      ]);
      expect(rawCalls(GUID, "ListObjectVersions")).toHaveLength(1);
      expect(rawCalls(GUID, "GetObject").map((call) => call.input.VersionId)).toEqual([run, pre]);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(metricLines()).toEqual([]);
    });
  });

  /**
   * A row a release since 2026-11-12 wrote (d2) for the bill's document summarized from the copy before the run, and
   * the run's summary, built from the run copy: the same status and actions, the run copy's text hash.
   */
  const textOnlyVersion = (
    guid: FixtureGuid,
    {
      rawCopies = ["pre", "run"],
      rawVersion = true,
      summaryChanges = {},
    }: { rawCopies?: Array<"pre" | "run">; rawVersion?: boolean; summaryChanges?: Partial<ProcessedDoc> } = {},
  ) => {
    const versions = Object.fromEntries(rawCopies.map((copy) => [copy, storeRaw(guid, copy)])) as Partial<
      Record<"pre" | "run", string>
    >;
    const rowAt = new Date(Date.parse(RAW_COPY_STORED[guid].pre) + 60_000).toISOString();
    const before = processedDoc(guid, rowAt);
    mockS3.putAt(keyOf(guid), before, rowAt, written(textOf(guid, "pre")));
    seedRow(manifestRow(before, rowAt, { dateBasis: basisOf(before, textOf(guid, "pre")) }));
    const storedAt = new Date(Date.parse(RAW_COPY_STORED[guid].run) + 3_000).toISOString();
    const after = processedDoc(guid, storedAt, { soWhat: "Summary of the run's text.", ...summaryChanges });
    mockS3.putAt(keyOf(guid), after, storedAt, written(textOf(guid, "run"), rawVersion ? versions.run : undefined));
    return { ...versions, rowAt, before, after };
  };

  describe("moves as today when the copies show news, and keeps the date when they show none", () => {
    it.each<[FixtureGuid, TextVersionEvidence["verdict"]]>([
      ["BILLS-119hres1438", "new_text_version"],
      ["BILLS-119s4903", "new_text_version"],
      ["BILLS-119s3909", "retitled"],
    ])("moves %s's row for a textVersion move the copies confirm (%s)", async (guid, verdict) => {
      const { pre, run, after } = textOnlyVersion(guid);

      const response = await handler(event(guid));

      expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 0 });
      expect(table()).toEqual(
        tableWith(manifestRow(after, after.storedAt, { dateBasis: basisOf(after, textOf(guid, "run")) })),
      );
      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "moved",
          moves: ["textVersion"],
          decidedBy: "dateBasis",
          basis: "d2",
          textVersionCheck: evidence({ verdict, newRawVersion: run, baseRawVersion: pre }),
        }),
      ]);
      expect(metricLines()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("keeps BILLS-119s4631's row: the stored XML switched between two versions of one day already listed", async () => {
      const { pre, run, rowAt } = textOnlyVersion("BILLS-119s4631");

      const response = await handler(event("BILLS-119s4631"));

      expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
      expect(mockTable.get("BILL_GUID|BILLS-119s4631")).toEqual(lookup("BILLS-119s4631", rowAt));
      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "kept",
          moves: [],
          decidedBy: "dateBasis",
          textVersionCheck: evidence({ newRawVersion: run, baseRawVersion: pre }),
        }),
      ]);
    });

    it("runs no check, and reads no raw copy, when the version brings other news too", async () => {
      const guid: FixtureGuid = "BILLS-119hr7349";
      textOnlyVersion(guid, { summaryChanges: { billStatus: "Passed" } });

      await handler(event(guid));

      expect(dateLines()).toEqual([
        expect.objectContaining({ decision: "moved", moves: ["status", "textVersion"], textVersionCheck: null }),
      ]);
      expect(rawCalls(guid, "ListObjectVersions")).toEqual([]);
      expect(rawCalls(guid, "GetObject")).toEqual([]);
      expect(metricLines()).toEqual([]);
    });
  });

  describe("every path that judges a text runs the check against the text it judged", () => {
    const GUID: FixtureGuid = "BILLS-119hr7349";
    const patch = processedDoc(GUID, "2026-11-17T01:51:24.215Z");
    const summary = processedDoc(GUID, "2026-11-17T01:51:26.008Z", { soWhat: "Summary of the run's text." });

    it("the previous-version path: a row with neither basis nor hash, dated by the patch before the summary", async () => {
      const pre = storeRaw(GUID, "pre");
      const run = storeRaw(GUID, "run");
      mockS3.putAt(keyOf(GUID), patch, "2026-11-17T01:51:25.000Z", written(textOf(GUID, "pre"), run));
      mockS3.putAt(keyOf(GUID), summary, "2026-11-17T01:51:27.000Z", written(textOf(GUID, "run"), run));
      // An older release dated the row by the patch, 0.7 s after its storedAt, and stamped nothing.
      seedRow(manifestRow(patch, "2026-11-17T01:51:24.915Z"));

      const response = await handler(event(GUID));

      expect(stats(response)).toMatchObject({ upsertsKeptDate: 1 });
      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "kept",
          moves: [],
          decidedBy: "previousVersion",
          basis: null,
          textVersionCheck: evidence({ newRawVersion: run, baseRawVersion: pre }),
        }),
      ]);
      expect(rawCalls(GUID, "ListObjectVersions")).toHaveLength(1);
    });

    it("a row with the d1 basis of a release of 2026-10-28 to 2026-11-12", async () => {
      const pre = storeRaw(GUID, "pre");
      const run = storeRaw(GUID, "run");
      mockS3.putAt(keyOf(GUID), patch, "2026-11-17T01:51:25.000Z", written(textOf(GUID, "pre"), run));
      mockS3.putAt(keyOf(GUID), summary, "2026-11-17T01:51:27.000Z", written(textOf(GUID, "run"), run));
      seedRow(manifestRow(patch, patch.storedAt, { dateBasis: legacyBasisOf(patch, textOf(GUID, "pre")) }));

      await handler(event(GUID));

      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "kept",
          moves: [],
          decidedBy: "dateBasis",
          basis: "d1",
          sameDay: "same",
          textVersionCheck: evidence({ newRawVersion: run, baseRawVersion: pre }),
        }),
      ]);
      expect(mockTable.get(`BILL|${patch.storedAt}#${GUID}`)?.dateBasis).toEqual({
        S: basisOf(summary, textOf(GUID, "run")),
      });
    });
  });

  describe("a copy that cannot be found or read moves the row as before, with its reason", () => {
    const GUID: FixtureGuid = "BILLS-119hr7349";

    it("the base copy expired: moved, base_raw_not_found, one ManifestTextVersionUnconfirmed metric, no warning", async () => {
      const { run, after } = textOnlyVersion(GUID, { rawCopies: ["run"] });

      const response = await handler(event(GUID));

      expect(mockTable.get(`BILL_GUID|${GUID}`)).toEqual(lookup(GUID, after.storedAt));
      expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 0 });
      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "moved",
          moves: ["textVersion"],
          textVersionCheck: evidence({
            verdict: "unconfirmed",
            reason: "base_raw_not_found",
            newRawVersion: run,
            gets: 1,
          }),
        }),
      ]);
      expect(metricLines()).toEqual([
        expect.objectContaining({
          guid: GUID,
          reason: "base_raw_not_found",
          ManifestTextVersionUnconfirmed: 1,
          _aws: expect.objectContaining({
            CloudWatchMetrics: [
              {
                Namespace: "BillBoard/BillsManifest",
                Dimensions: [[]],
                Metrics: [{ Name: "ManifestTextVersionUnconfirmed", Unit: "Count" }],
              },
            ],
          }),
        }),
      ]);
      expect(metricLines()[0]).not.toHaveProperty("ManifestTextVersionReadFailed");
      expect(warn).not.toHaveBeenCalled();
    });

    it("the raw listing throws: moved, one warning, both metrics, and the record does not fail", async () => {
      textOnlyVersion(GUID);
      const send = mockS3.send.bind(mockS3);
      jest.spyOn(mockS3, "send").mockImplementation(async (command: FakeS3Command) => {
        if (command.__cmd === "ListObjectVersions" && command.input.Prefix === rawKeyOf(GUID)) {
          throw Object.assign(new Error("Service Unavailable"), {
            name: "ServiceUnavailable",
            $metadata: { httpStatusCode: 503 },
          });
        }
        return send(command);
      });

      const response = await handler(event(GUID));

      expect(response.batchItemFailures).toEqual([]);
      expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 0 });
      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "moved",
          textVersionCheck: expect.objectContaining({ verdict: "unconfirmed", reason: "listing_failed", gets: 0 }),
        }),
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logLinesWithMessage(warn, WARNING)).toEqual([
        expect.objectContaining({ key: rawKeyOf(GUID), reason: "listing_failed" }),
      ]);
      expect(metricLines()).toEqual([
        expect.objectContaining({
          guid: GUID,
          reason: "listing_failed",
          ManifestTextVersionUnconfirmed: 1,
          ManifestTextVersionReadFailed: 1,
        }),
      ]);
    });

    it("a raw copy's GET throws: moved, read_failed, the warning and BillStorage's error, both metrics", async () => {
      const { run } = textOnlyVersion(GUID);
      // The new copy's GET answers; the walk's first GET (the copy before the run) fails.
      mockS3.afterGet(rawKeyOf(GUID), () =>
        mockS3.afterGet(rawKeyOf(GUID), () => {
          throw Object.assign(new Error("We encountered an internal error. Please try again."), {
            name: "InternalError",
            $metadata: { httpStatusCode: 500 },
          });
        }),
      );

      const response = await handler(event(GUID));

      expect(response.batchItemFailures).toEqual([]);
      expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 0 });
      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "moved",
          moves: ["textVersion"],
          textVersionCheck: evidence({ verdict: "unconfirmed", reason: "read_failed", newRawVersion: run, gets: 2 }),
        }),
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(logLinesWithMessage(warn, WARNING)).toEqual([
        expect.objectContaining({ key: rawKeyOf(GUID), newRawVersion: run, reason: "read_failed" }),
      ]);
      expect(logLines(error).map((line) => line.message)).toEqual(["Failed to load bill from S3"]);
      expect(metricLines()).toEqual([
        expect.objectContaining({
          guid: GUID,
          reason: "read_failed",
          ManifestTextVersionUnconfirmed: 1,
          ManifestTextVersionReadFailed: 1,
        }),
      ]);
    });

    it("the summary names no raw copy: moved, no_source_raw_version, and no raw-key call", async () => {
      textOnlyVersion(GUID, { rawVersion: false });

      await handler(event(GUID));

      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "moved",
          moves: ["textVersion"],
          textVersionCheck: evidence({ verdict: "unconfirmed", reason: "no_source_raw_version", gets: 0 }),
        }),
      ]);
      expect(rawCalls(GUID, "ListObjectVersions")).toEqual([]);
      expect(rawCalls(GUID, "GetObject")).toEqual([]);
      expect(metricLines()).toEqual([
        expect.objectContaining({ guid: GUID, reason: "no_source_raw_version", ManifestTextVersionUnconfirmed: 1 }),
      ]);
    });
  });

  it("reads the raw copies once per upsert when a concurrent vote count cancels the first write", async () => {
    const guid: FixtureGuid = "BILLS-119hr7349";
    const { run, rowAt, after } = textOnlyVersion(guid);
    mockBeforeTransaction = async () => {
      const key = `BILL|${rowAt}#${guid}`;
      mockTable.set(key, { ...mockTable.get(key)!, voteCount: { N: "5" } });
    };

    const response = await handler(event(guid));

    expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 1 });
    expect(mockDdbCommands.filter((command) => command.__type === "TransactWriteItems")).toHaveLength(2);
    expect(rawCalls(guid, "ListObjectVersions")).toHaveLength(1);
    expect(rawCalls(guid, "GetObject")).toHaveLength(2);
    // The kept write lands with the count written in between.
    expect(table()).toEqual(
      tableWith(manifestRow(after, rowAt, { dateBasis: basisOf(after, textOf(guid, "run")), voteCount: "5" })),
    );
    expect(dateLines()).toEqual([
      expect.objectContaining({ decision: "kept", textVersionCheck: expect.objectContaining({ newRawVersion: run }) }),
    ]);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "Manifest upsert raced a concurrent write; re-reading",
    ]);
  });

  it("counts an unconfirmed check once per committed upsert, not once per attempt", async () => {
    const guid: FixtureGuid = "BILLS-119hr7349";
    // The base copy expired: unconfirmed, so the row moves; a concurrent vote count cancels the first write.
    const { run, rowAt, after } = textOnlyVersion(guid, { rawCopies: ["run"] });
    mockBeforeTransaction = async () => {
      const key = `BILL|${rowAt}#${guid}`;
      mockTable.set(key, { ...mockTable.get(key)!, voteCount: { N: "5" } });
    };

    const response = await handler(event(guid));

    expect(stats(response)).toMatchObject({ upsertsSucceeded: 1, upsertsKeptDate: 0 });
    expect(mockDdbCommands.filter((command) => command.__type === "TransactWriteItems")).toHaveLength(2);
    expect(rawCalls(guid, "ListObjectVersions")).toHaveLength(1);
    expect(rawCalls(guid, "GetObject")).toHaveLength(1);
    // The moved write lands with the count written in between.
    expect(table()).toEqual(
      tableWith(manifestRow(after, after.storedAt, { dateBasis: basisOf(after, textOf(guid, "run")), voteCount: "5" })),
    );
    expect(dateLines()).toEqual([
      expect.objectContaining({
        decision: "moved",
        textVersionCheck: evidence({
          verdict: "unconfirmed",
          reason: "base_raw_not_found",
          newRawVersion: run,
          gets: 1,
        }),
      }),
    ]);
    expect(metricLines()).toHaveLength(1);
    expect(metricLines()).toEqual([
      expect.objectContaining({ guid, reason: "base_raw_not_found", ManifestTextVersionUnconfirmed: 1 }),
    ]);
  });

  describe("rollback: the release before this one reads a kept row's d2 basis as usual (RUNBOOK 2.4)", () => {
    const GUID: FixtureGuid = "BILLS-119hr7349";

    /** The handler as the release before the check: every text-only move moves (no source-raw-version, as before). */
    const loadOlderRelease = (): typeof handler => {
      let older!: typeof handler;
      jest.isolateModules(() => {
        jest.doMock("../shared/textVersionEvidence", () => ({
          ...jest.requireActual("../shared/textVersionEvidence"),
          readTextVersionEvidence: async (): Promise<TextVersionEvidence> => ({
            verdict: "unconfirmed",
            reason: "no_source_raw_version",
            newRawVersion: null,
            baseRawVersion: null,
            gets: 0,
            skipped: 0,
          }),
        }));
        older = require("../handlers/createBillsManifest").handler;
      });
      jest.dontMock("../shared/textVersionEvidence");
      return older;
    };

    /** The row kept by the check (hr7349's summary of the run), and a later processed version stored after it. */
    const keptThen =
      (later: (summary: ProcessedDoc) => { doc: ProcessedDoc; textHash: string; rawVersion: string }) => async () => {
        const { run, rowAt, after } = textOnlyVersion(GUID);
        await handler(event(GUID));
        expect(mockTable.get(`BILL_GUID|${GUID}`)).toEqual(lookup(GUID, rowAt));
        const next = later(after);
        mockS3.putAt(keyOf(GUID), next.doc, next.doc.storedAt, written(next.textHash, next.rawVersion));
        info.mockClear();
        return { run, rowAt, next: next.doc, nextRawVersion: next.rawVersion, saved: structuredClone(mockTable) };
      };

    it("a later version of the same text (a cosponsor refill) is kept by both releases", async () => {
      const { rowAt, saved } = await keptThen((summary) => ({
        doc: { ...summary, storedAt: "2026-11-20T09:00:00.000Z", cosponsors: [...summary.cosponsors, "C000001"] },
        textHash: textOf(GUID, "run"),
        rawVersion: mockS3.putAt(rawKeyOf(GUID), rawCopy(GUID, "run"), "2026-11-20T08:59:59.000Z"),
      }))();

      await handler(event(GUID));
      mockTable = structuredClone(saved);
      await loadOlderRelease()(event(GUID));

      const kept = expect.objectContaining({
        decision: "kept",
        moves: [],
        decidedBy: "dateBasis",
        basis: "d2",
        textVersionCheck: null,
        rowUpdatedAt: rowAt,
      });
      expect(dateLines()).toEqual([kept, kept]);
      expect(mockTable.get(`BILL_GUID|${GUID}`)).toEqual(lookup(GUID, rowAt));
    });

    it("another text of the version already listed is kept by this release and moved by the older one", async () => {
      // A re-fetch whose XML differs for the same listed version and title (a star print, a re-issued file).
      const { run, rowAt, next, nextRawVersion, saved } = await keptThen((summary) => {
        const reissued = rawCopy(GUID, "run");
        const content = (reissued as unknown as RawParts).content;
        content.billXML = `${content.billXML} <!-- star print -->`;
        return {
          doc: { ...summary, storedAt: "2026-11-20T09:00:00.000Z", soWhat: "Summary of the re-issued text." },
          textHash: sourceTextHash(reissued),
          rawVersion: mockS3.putAt(rawKeyOf(GUID), reissued, "2026-11-20T08:59:59.000Z"),
        };
      })();

      await handler(event(GUID));
      expect(mockTable.get(`BILL_GUID|${GUID}`)).toEqual(lookup(GUID, rowAt));
      mockTable = structuredClone(saved);
      await loadOlderRelease()(event(GUID));
      expect(mockTable.get(`BILL_GUID|${GUID}`)).toEqual(lookup(GUID, next.storedAt));

      expect(dateLines()).toEqual([
        expect.objectContaining({
          decision: "kept",
          moves: [],
          basis: "d2",
          textVersionCheck: evidence({ newRawVersion: nextRawVersion, baseRawVersion: run }),
        }),
        expect.objectContaining({ decision: "moved", moves: ["textVersion"], decidedBy: "dateBasis", basis: "d2" }),
      ]);
    });
  });
});
