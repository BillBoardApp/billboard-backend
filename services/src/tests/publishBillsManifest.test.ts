import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { BillsManifestItemV1, BillsManifestV1 } from "../contracts";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { applyTestEnv } from "./fixtures/env";
import { logLinesWithMessage } from "./logLines";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  const command = (type: string) => jest.fn().mockImplementation((input) => ({ __type: type, input }));
  return {
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    QueryCommand: command("QueryCommand"),
    GetItemCommand: command("GetItemCommand"),
    PutItemCommand: command("PutItemCommand"),
    DeleteItemCommand: command("DeleteItemCommand"),
    BatchGetItemCommand: command("BatchGetItemCommand"),
  };
});

jest.mock("@aws-sdk/client-s3", () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    HeadObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "HeadObjectCommand", input })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "PutObjectCommand", input })),
  };
});

jest.mock("../shared/metrics", () => ({
  putMetric: jest.fn(async () => undefined),
  putMetrics: jest.fn(async () => undefined),
}));

type PublishModule = typeof import("../handlers/publishBillsManifest");

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const notFound = () => Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });

type Item = Record<string, AttributeValue>;

/** A DynamoDB command as the mocked SDK constructors build it; the input fields are the ones the fake reads. */
interface FakeDdbCommand {
  __type: string;
  input: ConditionInput & { Key?: Item; Item?: Item };
}

const manifestItem = (guid: string, voteCount: number, updatedAt = "2026-09-01T00:00:00.000Z") => ({
  pk: { S: "BILL" },
  sk: { S: `${updatedAt}#${guid}` },
  guid: { S: guid },
  billType: { S: "hr" },
  congress: { S: "119" },
  billNumber: { S: guid.replace(/\D/g, "") },
  updatedAt: { S: updatedAt },
  title: { S: `Title for ${guid} — café 🏛` },
  subCategories: { L: [{ S: "Health" }] },
  lifeAreas: { L: [] },
  sponsors: { L: [{ S: "S000001" }] },
  cosponsors: { L: [] },
  voteCount: { N: String(voteCount) },
});

const PAGES = [
  {
    Items: [manifestItem("BILLS-119hr1ih", 3), manifestItem("BILLS-119hr2ih", 9)],
    LastEvaluatedKey: { pk: { S: "BILL" }, sk: { S: "cursor" } },
  },
  { Items: [manifestItem("BILLS-119s3is", 0, "2026-09-20T00:00:00.000Z")] },
];

// INT-11: newest first, then guid; the rows' vote counts (3, 9, 0) are neither sent nor used to sort.
const EXPECTED_BILLS: BillsManifestItemV1[] = [
  {
    guid: "BILLS-119s3is",
    billType: "hr",
    congress: "119",
    billNumber: "1193",
    updatedAt: "2026-09-20T00:00:00.000Z",
    title: "Title for BILLS-119s3is — café 🏛",
    subCategories: ["Health"],
    lifeAreas: [],
    sponsors: ["S000001"],
    cosponsors: [],
  },
  {
    guid: "BILLS-119hr1ih",
    billType: "hr",
    congress: "119",
    billNumber: "1191",
    updatedAt: "2026-09-01T00:00:00.000Z",
    title: "Title for BILLS-119hr1ih — café 🏛",
    subCategories: ["Health"],
    lifeAreas: [],
    sponsors: ["S000001"],
    cosponsors: [],
  },
  {
    guid: "BILLS-119hr2ih",
    billType: "hr",
    congress: "119",
    billNumber: "1192",
    updatedAt: "2026-09-01T00:00:00.000Z",
    title: "Title for BILLS-119hr2ih — café 🏛",
    subCategories: ["Health"],
    lifeAreas: [],
    sponsors: ["S000001"],
    cosponsors: [],
  },
];

/** The companion metrics of a run with no link lists and the flag off. */
const QUIET_COMPANION_METRICS = [
  { name: "CompanionGroups", value: 0 },
  { name: "CompanionGroupsAdded", value: 0 },
  { name: "CompanionGroupsRemoved", value: 0 },
  { name: "CompanionAmbiguous", value: 0 },
  { name: "CompanionOneSided", value: 0 },
  { name: "CompanionGroupsShadow", value: 0 },
  { name: "CompanionResolveFailed", value: 0 },
];

describe("publishBillsManifest handler", () => {
  const BASE_ENV = {
    TABLE_NAME: "BillsManifest",
    PRIMARY_KEY: "pk",
    PK_VALUE: "BILL",
    MANIFEST_SNAPSHOT_BUCKET: "manifest-snapshots",
    MANIFEST_SNAPSHOT_KEY: undefined,
    PRIORITY_TABLE_NAME: undefined,
    PRIORITY_ACTIVE_INDEX_NAME: undefined,
    COMPANION_GROUPS_ENABLED: undefined,
  };
  const FIRST_RUN = new Date("2026-09-25T12:00:00.000Z");

  let restoreEnv: (() => void) | undefined;
  let ddbSend: jest.Mock;
  let s3Send: jest.Mock;
  let putMetrics: jest.Mock;
  let infoSpy: jest.SpyInstance;
  let publish: PublishModule;

  // The manifest table: BILL pages queued per run, companion link lists, and the CURRENT groups row.
  let manifestPages: unknown[];
  let declRows: Item[];
  let current: Item | undefined;
  let beforeCurrentPut: (() => void) | undefined;

  const installTable = () => {
    ddbSend.mockImplementation(async ({ __type, input }: FakeDdbCommand) => {
      if (__type === "QueryCommand") {
        const pk = input.ExpressionAttributeValues![":pk"].S;
        if (pk === "BILL") return manifestPages.shift() ?? { Items: [] };
        if (pk === "BILL_COMPANION_DECL") return { Items: declRows };
      }
      if (__type === "GetItemCommand" && input.Key!.pk.S === "BILL_COMPANION_GROUPS") return { Item: current };
      if (__type === "PutItemCommand" && input.Item!.pk.S === "BILL_COMPANION_GROUPS") {
        beforeCurrentPut?.();
        if (!evaluateCondition(current, input)) throw conditionalCheckFailed();
        current = input.Item;
        return {};
      }
      throw new Error(`Unexpected ${__type} ${JSON.stringify(input)}`);
    });
  };

  const load = (env: Record<string, string | undefined> = {}) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv({ ...BASE_ENV, ...env });
    jest.resetModules();
    ddbSend = jest.requireMock("@aws-sdk/client-dynamodb").__mockSend;
    s3Send = jest.requireMock("@aws-sdk/client-s3").__mockSend;
    putMetrics = jest.requireMock("../shared/metrics").putMetrics;
    ddbSend.mockReset();
    s3Send.mockReset();
    putMetrics.mockClear();
    installTable();
    publish = require("../handlers/publishBillsManifest");
  };

  const queuePages = (pages: unknown[] = PAGES) => {
    manifestPages.push(...pages);
  };

  const putCalls = () => s3Send.mock.calls.map(([command]) => command).filter((c) => c.__type === "PutObjectCommand");
  const ddbCalls = (type: string) =>
    ddbSend.mock.calls.map(([command]: [FakeDdbCommand]) => command).filter((c) => c.__type === type);

  beforeEach(() => {
    jest.useFakeTimers({ now: FIRST_RUN, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    infoSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    manifestPages = [];
    declRows = [];
    current = undefined;
    beforeCurrentPut = undefined;
    load();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it("writes a gzip JSON snapshot with encoding, cache and metadata when none exists", async () => {
    queuePages();
    s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

    const summary = await publish.handler({}, { awsRequestId: "req-1" });

    expect(ddbCalls("QueryCommand").filter((c) => c.input.ExpressionAttributeValues![":pk"].S === "BILL")).toHaveLength(
      2,
    );
    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(s3Send.mock.calls[0][0]).toEqual({
      __type: "HeadObjectCommand",
      input: { Bucket: "manifest-snapshots", Key: "bills/manifest-v1.json" },
    });

    const [put] = putCalls();
    const { Body, Metadata, ...rest } = put.input;
    expect(rest).toEqual({
      Bucket: "manifest-snapshots",
      Key: "bills/manifest-v1.json",
      ContentType: "application/json",
      ContentEncoding: "gzip",
      CacheControl: "private, max-age=60",
    });

    // The body gunzips to exactly JSON.stringify(manifest), as the inline response would be.
    const json = gunzipSync(Body).toString("utf8");
    const expectedManifest: BillsManifestV1 = {
      generatedAt: FIRST_RUN.toISOString(),
      count: 3,
      bills: EXPECTED_BILLS,
      companionGroups: [],
    };
    expect(json).toBe(JSON.stringify(expectedManifest));
    expect(json).not.toContain("voteCount");
    expect(Metadata).toEqual({
      "generated-at": "2026-09-25T12:00:00.000Z",
      count: "3",
      sha256: sha256Hex(JSON.stringify(EXPECTED_BILLS) + "[]"),
    });

    expect(summary).toEqual({
      bucket: "manifest-snapshots",
      key: "bills/manifest-v1.json",
      outcome: "written",
      count: 3,
      generatedAt: "2026-09-25T12:00:00.000Z",
      sha256: Metadata.sha256,
      gzippedBytes: Body.length,
      jsonBytes: Buffer.byteLength(json),
      durationMs: expect.any(Number),
    });
    expect(putMetrics).toHaveBeenCalledWith("BillBoard/BillsManifest", [
      { name: "SnapshotBillCount", value: 3 },
      { name: "SnapshotGzipBytes", value: Body.length, unit: "Bytes" },
      { name: "SnapshotWritten", value: 1 },
      { name: "SnapshotUnchanged", value: 0 },
      ...QUIET_COMPANION_METRICS,
    ]);
    const [line] = logLinesWithMessage(infoSpy, "Bills manifest snapshot written");
    expect(line).toMatchObject({ level: "INFO", awsRequestId: "req-1", outcome: "written", count: 3 });
  });

  it("skips the write when the bills are unchanged, even though generatedAt moved", async () => {
    queuePages();
    s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});
    await publish.handler();
    const firstMetadata = putCalls()[0].input.Metadata;

    jest.setSystemTime(new Date("2026-09-25T12:10:00.000Z"));
    s3Send.mockReset();
    putMetrics.mockClear();
    queuePages();
    s3Send.mockResolvedValueOnce({ Metadata: firstMetadata });

    const summary = await publish.handler();

    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(putCalls()).toHaveLength(0);
    expect(summary).toMatchObject({
      outcome: "unchanged",
      count: 3,
      generatedAt: "2026-09-25T12:00:00.000Z",
      sha256: firstMetadata.sha256,
    });
    expect(putMetrics).toHaveBeenCalledWith(
      "BillBoard/BillsManifest",
      expect.arrayContaining([
        { name: "SnapshotWritten", value: 0 },
        { name: "SnapshotUnchanged", value: 1 },
      ]),
    );
    expect(logLinesWithMessage(infoSpy, "Bills manifest snapshot unchanged")).toHaveLength(1);
  });

  it("rewrites the snapshot when a bill changed", async () => {
    queuePages();
    s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});
    await publish.handler();
    const firstMetadata = putCalls()[0].input.Metadata;

    s3Send.mockReset();
    const changedPages = [
      PAGES[0],
      { Items: [{ ...manifestItem("BILLS-119s3is", 0, "2026-09-20T00:00:00.000Z"), title: { S: "A new title" } }] },
    ];
    queuePages(changedPages);
    s3Send.mockResolvedValueOnce({ Metadata: firstMetadata }).mockResolvedValueOnce({});

    const summary = await publish.handler();

    expect(summary.outcome).toBe("written");
    const [put] = putCalls();
    expect(put.input.Metadata.sha256).not.toBe(firstMetadata.sha256);
    const written = JSON.parse(gunzipSync(put.input.Body).toString("utf8"));
    expect(put.input.Metadata.sha256).toBe(
      sha256Hex(JSON.stringify(written.bills) + JSON.stringify(written.companionGroups)),
    );
  });

  it("keeps the snapshot when only a bill's vote count changed: it is not in the manifest (INT-11)", async () => {
    queuePages();
    s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});
    await publish.handler();
    const firstMetadata = putCalls()[0].input.Metadata;

    s3Send.mockReset();
    queuePages([PAGES[0], { Items: [manifestItem("BILLS-119s3is", 40, "2026-09-20T00:00:00.000Z")] }]);
    s3Send.mockResolvedValueOnce({ Metadata: firstMetadata });

    const summary = await publish.handler();

    expect(summary).toMatchObject({ outcome: "unchanged", sha256: firstMetadata.sha256 });
    expect(putCalls()).toHaveLength(0);
  });

  it("rewrites when the current object has no sha256 metadata", async () => {
    queuePages();
    s3Send.mockResolvedValueOnce({ Metadata: {} }).mockResolvedValueOnce({});
    const summary = await publish.handler();
    expect(summary.outcome).toBe("written");
    expect(putCalls()).toHaveLength(1);
  });

  it("writes to MANIFEST_SNAPSHOT_KEY when set", async () => {
    load({ MANIFEST_SNAPSHOT_KEY: "bills/other.json" });
    queuePages();
    s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

    await publish.handler();

    expect(s3Send.mock.calls[0][0].input).toEqual({ Bucket: "manifest-snapshots", Key: "bills/other.json" });
    expect(putCalls()[0].input.Key).toBe("bills/other.json");
  });

  it("throws without MANIFEST_SNAPSHOT_BUCKET and reads nothing", async () => {
    load({ MANIFEST_SNAPSHOT_BUCKET: undefined });
    await expect(publish.handler()).rejects.toThrow("Missing env var MANIFEST_SNAPSHOT_BUCKET");
    expect(ddbSend).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("throws when HeadObject fails for a reason other than a missing object, without writing", async () => {
    queuePages();
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }),
    );
    await expect(publish.handler()).rejects.toThrow("Access Denied");
    expect(putCalls()).toHaveLength(0);
    expect(putMetrics).not.toHaveBeenCalled();
  });

  it("throws when PutObject fails", async () => {
    queuePages();
    s3Send.mockRejectedValueOnce(notFound()).mockRejectedValueOnce(new Error("SlowDown"));
    await expect(publish.handler()).rejects.toThrow("SlowDown");
    expect(putMetrics).not.toHaveBeenCalled();
  });

  it("throws when DynamoDB fails, without touching S3", async () => {
    ddbSend.mockRejectedValueOnce(new Error("ProvisionedThroughputExceededException"));
    await expect(publish.handler()).rejects.toThrow("ProvisionedThroughputExceededException");
    expect(s3Send).not.toHaveBeenCalled();
  });

  describe("companion groups (APPF-23)", () => {
    const HOUSE = "BILLS-119hr1285";
    const SENATE = "BILLS-119s570";
    const GROUP = { primaryGuid: HOUSE, memberGuids: [HOUSE, SENATE], relationship: "identical" };

    const declRow = (guid: string, targets: string[]): Item => {
      const [, congress, billType, billNumber] = /^BILLS-(\d+)([a-z]+?)(\d+)$/.exec(guid)!;
      return {
        pk: { S: "BILL_COMPANION_DECL" },
        sk: { S: guid },
        congress: { S: congress },
        billType: { S: billType },
        billNumber: { S: billNumber },
        declared: {
          L: targets.map((target) => {
            const [, c, t, n] = /^BILLS-(\d+)([a-z]+?)(\d+)$/.exec(target)!;
            return { M: { guid: { S: target }, congress: { S: c }, billType: { S: t }, billNumber: { S: n } } };
          }),
        },
        truncated: { BOOL: false },
        sourceFetchedAt: { S: "2026-09-01T00:00:00.000Z" },
      };
    };
    const pairedPages = (houseGuid = HOUSE) => [
      { Items: [manifestItem(houseGuid, 2), manifestItem(SENATE, 1), manifestItem("BILLS-119hr7", 0)] },
    ];
    const snapshot = (index = 0) => JSON.parse(gunzipSync(putCalls()[index].input.Body).toString("utf8"));
    const companionMetrics = () =>
      Object.fromEntries(
        (putMetrics.mock.calls.at(-1)?.[1] ?? [])
          .filter((metric: { name: string }) => metric.name.startsWith("Companion"))
          .map((metric: { name: string; value: number }) => [metric.name, metric.value]),
      );
    const currentPairs = () => JSON.parse(current!.pairs.S!);

    beforeEach(() => {
      // hr1285 lists s570; s570's own list is stale (one-sided).
      declRows = [declRow(HOUSE, [SENATE])];
      jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("publishes [] with the flag off, and reports the resolved groups as shadow (acceptance 10)", async () => {
      queuePages(pairedPages());
      s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

      await publish.handler();

      expect(snapshot().companionGroups).toEqual([]);
      expect(current).toMatchObject({ pairsVersion: { N: "1" }, enabled: { BOOL: false }, pairs: { S: "[]" } });
      expect(companionMetrics()).toEqual({
        CompanionGroups: 0,
        CompanionGroupsAdded: 0,
        CompanionGroupsRemoved: 0,
        CompanionAmbiguous: 0,
        CompanionOneSided: 1,
        CompanionGroupsShadow: 1,
        CompanionResolveFailed: 0,
      });
    });

    it("publishes the groups when enabled, writes CURRENT once, and rewrites the snapshot for a groups-only change", async () => {
      queuePages(pairedPages());
      s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});
      await publish.handler();
      const offMetadata = putCalls()[0].input.Metadata;

      load({ COMPANION_GROUPS_ENABLED: "true" });
      queuePages(pairedPages());
      s3Send.mockResolvedValueOnce({ Metadata: offMetadata }).mockResolvedValueOnce({});
      const summary = await publish.handler();

      // Same bills, new groups: the hash moved, so the snapshot was rewritten with the same count.
      expect(summary).toMatchObject({ outcome: "written", count: 3 });
      const written = snapshot();
      expect(written.companionGroups).toEqual([GROUP]);
      expect(putCalls()[0].input.Metadata.sha256).not.toBe(offMetadata.sha256);
      expect(putCalls()[0].input.Metadata.count).toBe(offMetadata.count);
      expect(current).toMatchObject({
        pairsVersion: { N: "2" },
        enabled: { BOOL: true },
        groupCount: { N: "1" },
        oneSidedCount: { N: "1" },
        declarationCount: { N: "1" },
      });
      expect(currentPairs()).toEqual([[HOUSE, SENATE]]);
      expect(companionMetrics()).toMatchObject({
        CompanionGroups: 1,
        CompanionGroupsAdded: 1,
        CompanionGroupsShadow: 1,
      });

      // Nothing changed: no CURRENT write and no snapshot write (acceptance 9).
      const lastMetadata = putCalls()[0].input.Metadata;
      s3Send.mockReset();
      ddbSend.mockClear();
      queuePages(pairedPages());
      s3Send.mockResolvedValueOnce({ Metadata: lastMetadata });
      expect((await publish.handler()).outcome).toBe("unchanged");
      expect(ddbCalls("PutItemCommand")).toEqual([]);
      expect(companionMetrics()).toMatchObject({
        CompanionGroups: 1,
        CompanionGroupsAdded: 0,
        CompanionGroupsRemoved: 0,
      });
    });

    it("never counts a suffixed legacy row as held", async () => {
      load({ COMPANION_GROUPS_ENABLED: "true" });
      queuePages(pairedPages(`${HOUSE}ih`));
      s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

      await publish.handler();

      expect(snapshot().companionGroups).toEqual([]);
      expect(companionMetrics()).toMatchObject({ CompanionGroupsShadow: 0 });
    });

    it("re-reads and retries once when CURRENT's version moved (acceptance 9)", async () => {
      load({ COMPANION_GROUPS_ENABLED: "true" });
      current = {
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "4" },
        enabled: { BOOL: true },
        pairs: { S: "[]" },
      };
      let raced = false;
      beforeCurrentPut = () => {
        if (raced) return;
        raced = true;
        current = { ...current!, pairsVersion: { N: "5" } };
      };
      queuePages(pairedPages());
      s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

      await publish.handler();

      expect(ddbCalls("PutItemCommand").map((c) => c.input.ExpressionAttributeValues![":expected"].N)).toEqual([
        "4",
        "5",
      ]);
      expect(current!.pairsVersion).toEqual({ N: "6" });
      expect(snapshot().companionGroups).toEqual([GROUP]);
      expect(companionMetrics()).toMatchObject({ CompanionResolveFailed: 0, CompanionGroups: 1 });
    });

    it("keeps publishing the stored groups when resolution fails (acceptance 10)", async () => {
      load({ COMPANION_GROUPS_ENABLED: "true" });
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      current = {
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "3" },
        enabled: { BOOL: true },
        pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
      };
      // Every CURRENT write conflicts, so both attempts fail.
      beforeCurrentPut = () => {
        current = { ...current!, pairsVersion: { N: String(Number(current!.pairsVersion.N) + 1) } };
      };
      declRows = [];
      queuePages(pairedPages());
      s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

      const summary = await publish.handler();

      expect(summary.outcome).toBe("written");
      expect(snapshot().companionGroups).toEqual([GROUP]);
      expect(companionMetrics()).toEqual({ CompanionGroups: 1, CompanionResolveFailed: 1 });
      expect(logLinesWithMessage(errorSpy, "Companion group resolution failed; publishing the stored groups")).toEqual([
        expect.objectContaining({ fallbackGroups: 1, error: expect.objectContaining({ message: expect.any(String) }) }),
      ]);
    });

    it("publishes no groups when the link lists cannot be read and CURRENT cannot either", async () => {
      load({ COMPANION_GROUPS_ENABLED: "true" });
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      jest.spyOn(console, "warn").mockImplementation(() => undefined);
      ddbSend.mockImplementation(async ({ __type, input }: FakeDdbCommand) => {
        if (__type === "QueryCommand" && input.ExpressionAttributeValues![":pk"].S === "BILL") {
          return manifestPages.shift() ?? { Items: [] };
        }
        throw new Error("AccessDeniedException");
      });
      queuePages(pairedPages());
      s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

      const summary = await publish.handler();

      expect(summary.outcome).toBe("written");
      expect(snapshot().companionGroups).toEqual([]);
      expect(companionMetrics()).toEqual({ CompanionGroups: 0, CompanionResolveFailed: 1 });
    });

    describe("rollback while resolution fails (flag off, CURRENT still enabled)", () => {
      const enabledCurrent = (): Item => ({
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "5" },
        enabled: { BOOL: true },
        pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
        groupCount: { N: "1" },
        ambiguousCount: { N: "7" },
        oneSidedCount: { N: "1" },
        declarationCount: { N: "2" },
      });

      /** The in-memory table, except that the link lists cannot be read, plus `extra` failures. */
      const failResolution = (extra: (command: FakeDdbCommand) => void = () => undefined) => {
        const table = ddbSend.getMockImplementation()!;
        ddbSend.mockImplementation(async (command: FakeDdbCommand) => {
          if (
            command.__type === "QueryCommand" &&
            command.input.ExpressionAttributeValues![":pk"].S === "BILL_COMPANION_DECL"
          ) {
            throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
          }
          extra(command);
          return table(command);
        });
      };

      beforeEach(() => {
        jest.spyOn(console, "error").mockImplementation(() => undefined);
        current = enabledCurrent();
      });

      it("switches CURRENT off, so the API readers drop the groups along with the snapshot", async () => {
        failResolution();
        queuePages(pairedPages());
        s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

        await publish.handler();

        expect(snapshot().companionGroups).toEqual([]);
        expect(current).toMatchObject({
          pairsVersion: { N: "6" },
          enabled: { BOOL: false },
          pairs: { S: "[]" },
          groupCount: { N: "0" },
          ambiguousCount: { N: "7" },
          declarationCount: { N: "2" },
        });
        expect(companionMetrics()).toEqual({ CompanionGroups: 0, CompanionResolveFailed: 1 });
      });

      it("keeps publishing the stored groups when CURRENT cannot be switched off either", async () => {
        failResolution(({ __type }) => {
          if (__type === "PutItemCommand") throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        });
        queuePages(pairedPages());
        s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

        await publish.handler();

        // The readers still serve CURRENT's pair, so the snapshot does too until a write succeeds.
        expect(current).toEqual(enabledCurrent());
        expect(snapshot().companionGroups).toEqual([GROUP]);
        expect(companionMetrics()).toEqual({ CompanionGroups: 1, CompanionResolveFailed: 1 });
      });

      it("publishes what another writer stored when switching off conflicts", async () => {
        failResolution();
        beforeCurrentPut = () => {
          current = { ...enabledCurrent(), pairsVersion: { N: "6" }, enabled: { BOOL: false }, pairs: { S: "[]" } };
        };
        queuePages(pairedPages());
        s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

        await publish.handler();

        expect(current!.pairsVersion).toEqual({ N: "6" });
        expect(snapshot().companionGroups).toEqual([]);
      });
    });

    it("publishes no groups on a failure while the flag is off and CURRENT cannot be read", async () => {
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      current = {
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "3" },
        enabled: { BOOL: true },
        pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
      };
      ddbSend.mockImplementation(async ({ __type, input }: FakeDdbCommand) => {
        if (__type === "QueryCommand" && input.ExpressionAttributeValues![":pk"].S === "BILL") {
          return manifestPages.shift() ?? { Items: [] };
        }
        throw new Error("boom");
      });
      queuePages(pairedPages());
      s3Send.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({});

      await publish.handler();

      expect(snapshot().companionGroups).toEqual([]);
    });
  });
});

describe("serializeBillsManifestSnapshot", () => {
  const { serializeBillsManifestSnapshot } = jest.requireActual(
    "../handlers/publishBillsManifest",
  ) as typeof import("../handlers/publishBillsManifest");

  const entry = (index: number): BillsManifestItemV1 => ({
    guid: `BILLS-119hr${index}ih`,
    billType: "hr",
    congress: "119",
    billNumber: String(index),
    updatedAt: "2026-09-01T00:00:00.000Z",
    title: `A long title ${"x".repeat(index % 200)} — éè 🏛 "quotes" \\ backslash \n newline`,
    subCategories: ["Health", "Economy"],
    lifeAreas: ["Family"],
    sponsors: ["S000001"],
    cosponsors: ["C000001", "C000002"],
    ...(index % 7 === 0 ? { isPriority: true, priorityRank: 1, priorityReason: "Reason" } : {}),
    ...(index % 5 === 0 ? { civicProfile: { localVsFederal: 0.25 } } : {}),
  });

  it.each([0, 1, 3000])("round-trips %i bills through gzip byte for byte and hashes only the bills", async (size) => {
    const manifest: BillsManifestV1 = {
      generatedAt: "2026-09-25T12:00:00.000Z",
      count: size,
      bills: Array.from({ length: size }, (_, index) => entry(index)),
    };
    const expectedJson = JSON.stringify(manifest);

    const { body, sha256, jsonBytes } = await serializeBillsManifestSnapshot(manifest);

    expect(body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(gunzipSync(body).toString("utf8")).toBe(expectedJson);
    expect(sha256).toBe(sha256Hex(JSON.stringify(manifest.bills)));
    expect(jsonBytes).toBe(Buffer.byteLength(expectedJson));
    if (size === 3000) {
      expect(jsonBytes).toBeGreaterThan(4 * 64 * 1024);
      expect(body.length).toBeLessThan(jsonBytes / 4);
    }
  });

  it("adds companionGroups after the bills and hashes them after the bills (APPF-23)", async () => {
    const bills = [entry(1), entry(2)];
    const companionGroups = [
      { primaryGuid: "BILLS-119hr1285", memberGuids: ["BILLS-119hr1285", "BILLS-119s570"], relationship: "identical" },
    ];
    const manifest: BillsManifestV1 = { generatedAt: "2026-09-25T12:00:00.000Z", count: 2, bills, companionGroups };

    const withGroups = await serializeBillsManifestSnapshot(manifest);
    const withNone = await serializeBillsManifestSnapshot({ ...manifest, companionGroups: [] });
    const withoutField = await serializeBillsManifestSnapshot({ generatedAt: manifest.generatedAt, count: 2, bills });

    expect(gunzipSync(withGroups.body).toString("utf8")).toBe(JSON.stringify(manifest));
    expect(withGroups.sha256).toBe(sha256Hex(JSON.stringify(bills) + JSON.stringify(companionGroups)));
    // Only the groups differ, yet every hash differs.
    expect(new Set([withGroups.sha256, withNone.sha256, withoutField.sha256]).size).toBe(3);
    expect(withoutField.sha256).toBe(sha256Hex(JSON.stringify(bills)));
  });

  it("gives the same hash for the same bills regardless of generatedAt", async () => {
    const bills = [entry(1), entry(2)];
    const first = await serializeBillsManifestSnapshot({ generatedAt: "2026-09-25T12:00:00.000Z", count: 2, bills });
    const second = await serializeBillsManifestSnapshot({ generatedAt: "2026-09-25T12:10:00.000Z", count: 2, bills });
    expect(second.sha256).toBe(first.sha256);
    expect(second.body.equals(first.body)).toBe(false);
  });
});
