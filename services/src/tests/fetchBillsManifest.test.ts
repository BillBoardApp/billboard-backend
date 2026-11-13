process.env.TABLE_NAME = "test-table";
process.env.PRIMARY_KEY = "pk";
process.env.PK_VALUE = "BILL";
import type { QueryCommandInput } from "@aws-sdk/client-dynamodb";
import { handler } from "../handlers/fetchBillsManifest";
import { applyTestEnv } from "./fixtures/env";
import { logLines, logLinesWithMessage } from "./logLines";

// Manifest (and priority) queries go to __mockSend; the companion groups read (GetItem on CURRENT)
// goes to __mockCompanionSend, so queued query pages are never consumed by it.
jest.mock("@aws-sdk/client-dynamodb", () => {
  const mockSend = jest.fn();
  const mockCompanionSend = jest.fn();
  return {
    DynamoDBClient: jest.fn(() => ({
      send: (command: { __type: string }) =>
        command.__type === "GetItemCommand" ? mockCompanionSend(command) : mockSend(command),
    })),
    __mockSend: mockSend,
    __mockCompanionSend: mockCompanionSend,
    QueryCommand: jest.fn().mockImplementation((input) => ({ __type: "QueryCommand", input })),
    GetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "GetItemCommand", input })),
  };
});

jest.mock("@aws-sdk/client-s3", () => {
  const mockSend = jest.fn();
  return {
    S3Client: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
    HeadObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "HeadObjectCommand", input })),
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "GetObjectCommand", input })),
  };
});

jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn() }));

// The real embedded-metric helpers; PutMetricData is stubbed so a test can assert it is never called.
jest.mock("../shared/metrics", () => ({
  ...jest.requireActual("../shared/metrics"),
  putMetric: jest.fn(async () => undefined),
  putMetrics: jest.fn(async () => undefined),
}));

describe("fetchBillsManifest handler", () => {
  const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");

  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    restoreEnv?.();
    restoreEnv = applyTestEnv({ TABLE_NAME: "test-table", PRIMARY_KEY: "pk", PK_VALUE: "BILL" });
  });

  afterEach(() => {
    restoreEnv?.();
  });

  it("returns the bills manifest when present", async () => {
    const generatedAt = new Date().toISOString();

    mockSend.mockResolvedValueOnce({
      Items: [
        {
          pk: { S: "BILL" },
          sk: { S: `${generatedAt}#BILLS-118s1is` },
          guid: { S: "BILLS-118s1is" },
          billType: { S: "senate-bill" },
          congress: { S: "118" },
          billNumber: { S: "1" },
          updatedAt: { S: generatedAt },
          title: { S: "Bill 1" },
          subCategories: { L: [] },
          lifeAreas: { L: [] },
          sponsors: { L: [] },
          cosponsors: { L: [] },
          voteCount: { N: "12" },
        },
      ],
    });

    const res = await handler();

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.bills[0].guid).toBe("BILLS-118s1is");
    expect(body.bills[0].title).toBe("Bill 1");
    // INT-11: the row's vote count is never sent.
    expect(body.bills[0]).not.toHaveProperty("voteCount");
    expect(res.body).not.toContain("voteCount");

    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.KeyConditionExpression).toBe("#pk = :pk");
    expect(cmd.input.ExpressionAttributeValues[":pk"].S).toBe("BILL");
  });

  it("returns empty manifest when no items exist", async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });

    const res = await handler();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.bills).toEqual([]);
  });

  it("filters by updatedAfter when provided", async () => {
    mockSend.mockImplementationOnce((cmd: { input?: Partial<QueryCommandInput> }) => {
      const input = cmd.input || {};
      expect(input.KeyConditionExpression).toBe("#pk = :pk AND #sk > :updatedAfter");
      expect(input.ExpressionAttributeValues![":updatedAfter"]?.S).toBe("2026-01-15T00:00:00.000Z");
      expect(input.ExpressionAttributeValues![":pk"]?.S).toBe("BILL");
      return {
        Items: [
          {
            pk: { S: "BILL" },
            sk: { S: "2026-02-01T00:00:00.000Z#BILLS-118s1is" },
            guid: { S: "BILLS-118s1is" },
            billType: { S: "senate-bill" },
            congress: { S: "118" },
            billNumber: { S: "1" },
            updatedAt: { S: "2026-02-01T00:00:00.000Z" },
            title: { S: "Bill 1" },
            subCategories: { L: [] },
            lifeAreas: { L: [] },
            sponsors: { L: [] },
            cosponsors: { L: [] },
            voteCount: { N: "0" },
          },
        ],
      };
    });

    const res = await handler({ queryStringParameters: { updatedAfter: "2026-01-15T00:00:00.000Z" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.bills[0].updatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(res.body).not.toContain("voteCount");
  });

  it("sorts by updatedAt desc, never by vote count (INT-11)", async () => {
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          pk: { S: "BILL" },
          sk: { S: "2026-01-01T00:00:00.000Z#BILLS-1" },
          guid: { S: "BILLS-1" },
          billType: { S: "senate-bill" },
          updatedAt: { S: "2026-01-01T00:00:00.000Z" },
          title: { S: "Oldest, most votes" },
          subCategories: { L: [] },
          lifeAreas: { L: [] },
          sponsors: { L: [] },
          cosponsors: { L: [] },
          voteCount: { N: "50" },
        },
        {
          pk: { S: "BILL" },
          sk: { S: "2026-01-03T00:00:00.000Z#BILLS-2" },
          guid: { S: "BILLS-2" },
          billType: { S: "senate-bill" },
          updatedAt: { S: "2026-01-03T00:00:00.000Z" },
          title: { S: "Newest, no votes" },
          subCategories: { L: [] },
          lifeAreas: { L: [] },
          sponsors: { L: [] },
          cosponsors: { L: [] },
          voteCount: { N: "0" },
        },
        {
          pk: { S: "BILL" },
          sk: { S: "2026-01-02T00:00:00.000Z#BILLS-3" },
          guid: { S: "BILLS-3" },
          billType: { S: "senate-bill" },
          updatedAt: { S: "2026-01-02T00:00:00.000Z" },
          title: { S: "Between" },
          subCategories: { L: [] },
          lifeAreas: { L: [] },
          sponsors: { L: [] },
          cosponsors: { L: [] },
          voteCount: { N: "10" },
        },
      ],
    });

    const res = await handler();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.bills.map((bill: { guid: string }) => bill.guid)).toEqual(["BILLS-2", "BILLS-3", "BILLS-1"]);
    expect(res.body).not.toContain("voteCount");
  });

  it("merges active priority metadata and sorts priority bills first", async () => {
    restoreEnv?.();
    restoreEnv = applyTestEnv({
      TABLE_NAME: "test-table",
      PRIMARY_KEY: "pk",
      PK_VALUE: "BILL",
      PRIORITY_TABLE_NAME: "BillPriority",
      PRIORITY_TABLE_PARTITION_KEY: "guid",
      PRIORITY_ACTIVE_INDEX_NAME: "PriorityStatusIndex",
      PRIORITY_STATUS_ATTRIBUTE: "status",
      PRIORITY_SORT_KEY_ATTRIBUTE: "prioritySortKey",
      PRIORITY_ACTIVE_STATUS_VALUE: "ACTIVE",
    });

    jest.resetModules();
    const { __mockSend: activeMockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
    activeMockSend
      .mockResolvedValueOnce({
        Items: [
          {
            guid: { S: "BILLS-118s1is" },
            status: { S: "ACTIVE" },
            isPriority: { BOOL: true },
            priorityRank: { N: "1" },
            priorityReason: { S: "Major national funding coverage" },
            priorityExpiresAt: { S: "2099-03-08T00:00:00.000Z" },
            priorityUpdatedAt: { S: "2026-03-07T12:00:00.000Z" },
            prioritySortKey: { S: "000001#BILLS-118s1is" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: { S: "BILL" },
            sk: { S: "2026-03-07T10:00:00.000Z#BILLS-118s1is" },
            guid: { S: "BILLS-118s1is" },
            billType: { S: "s" },
            congress: { S: "118" },
            billNumber: { S: "1" },
            updatedAt: { S: "2026-03-07T10:00:00.000Z" },
            title: { S: "Funding Bill" },
            subCategories: { L: [] },
            lifeAreas: { L: [] },
            sponsors: { L: [] },
            cosponsors: { L: [] },
            voteCount: { N: "1" },
          },
          {
            pk: { S: "BILL" },
            sk: { S: "2026-03-07T11:00:00.000Z#BILLS-118hr2ih" },
            guid: { S: "BILLS-118hr2ih" },
            billType: { S: "hr" },
            congress: { S: "118" },
            billNumber: { S: "2" },
            updatedAt: { S: "2026-03-07T11:00:00.000Z" },
            title: { S: "Regular Bill" },
            subCategories: { L: [] },
            lifeAreas: { L: [] },
            sponsors: { L: [] },
            cosponsors: { L: [] },
            voteCount: { N: "99" },
          },
        ],
      });

    const { handler: priorityHandler } = require("../handlers/fetchBillsManifest");
    const res = await priorityHandler();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.bills.map((bill: { guid: string }) => bill.guid)).toEqual(["BILLS-118s1is", "BILLS-118hr2ih"]);
    expect(body.bills[0]).toMatchObject({
      guid: "BILLS-118s1is",
      isPriority: true,
      priorityRank: 1,
      priorityReason: "Major national funding coverage",
    });
  });

  it("returns 500 when DynamoDB fails", async () => {
    jest.resetModules();
    const { __mockSend: failingSend } = jest.requireMock("@aws-sdk/client-dynamodb");
    failingSend.mockReset();
    failingSend.mockRejectedValueOnce(new Error("boom"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { handler: failingHandler } = require("../handlers/fetchBillsManifest");
      const res = await failingHandler();
      expect(res).toEqual({ statusCode: 500, body: JSON.stringify({ error: "Internal server error" }) });
      expect(logLinesWithMessage(errorSpy, "Failed to build the bills manifest")).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ─── companion groups (APPF-23) ───────────────────────────────────────────────

describe("fetchBillsManifest companion groups (APPF-23)", () => {
  const GROUP = {
    primaryGuid: "BILLS-119hr1285",
    memberGuids: ["BILLS-119hr1285", "BILLS-119s570"],
    relationship: "identical",
  };
  const currentItem = (enabled: boolean, pairs: string[][]) => ({
    Item: {
      pk: { S: "BILL_COMPANION_GROUPS" },
      sk: { S: "CURRENT" },
      pairsVersion: { N: "3" },
      enabled: { BOOL: enabled },
      pairs: { S: JSON.stringify(pairs) },
    },
  });
  const manifestPage = () => ({
    Items: [
      {
        pk: { S: "BILL" },
        sk: { S: "2026-09-01T00:00:00.000Z#BILLS-119hr1285" },
        guid: { S: "BILLS-119hr1285" },
        billType: { S: "hr" },
        congress: { S: "119" },
        billNumber: { S: "1285" },
        updatedAt: { S: "2026-09-01T00:00:00.000Z" },
        title: { S: "Water Infrastructure Subcontractor and Taxpayer Protection Act" },
        subCategories: { L: [] },
        lifeAreas: { L: [] },
        sponsors: { L: [] },
        cosponsors: { L: [] },
        voteCount: { N: "3" },
      },
    ],
  });

  let restoreEnv: (() => void) | undefined;
  let querySend: jest.Mock;
  let companionSend: jest.Mock;
  let fetchHandler: typeof handler;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let now = Date.parse("2026-09-25T12:00:00.000Z");

  beforeEach(() => {
    restoreEnv = applyTestEnv({ TABLE_NAME: "BillsManifest", PRIMARY_KEY: "pk", PK_VALUE: "BILL" });
    jest.resetModules();
    querySend = jest.requireMock("@aws-sdk/client-dynamodb").__mockSend;
    companionSend = jest.requireMock("@aws-sdk/client-dynamodb").__mockCompanionSend;
    querySend.mockReset();
    companionSend.mockReset();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchHandler = require("../handlers/fetchBillsManifest").handler;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    restoreEnv?.();
  });

  it("adds the published groups to full and windowed inline answers (acceptance 11)", async () => {
    companionSend.mockResolvedValue(currentItem(true, [["BILLS-119hr1285", "BILLS-119s570"]]));
    querySend.mockResolvedValueOnce(manifestPage()).mockResolvedValueOnce(manifestPage());

    const full = JSON.parse((await fetchHandler()).body);
    const windowed = JSON.parse(
      (await fetchHandler({ queryStringParameters: { updatedAfter: "2026-08-01T00:00:00.000Z" } })).body,
    );

    expect(Object.keys(full)).toEqual(["generatedAt", "count", "bills", "companionGroups"]);
    expect(full.companionGroups).toEqual([GROUP]);
    expect(windowed.companionGroups).toEqual([GROUP]);
    expect(querySend.mock.calls[1][0].input.KeyConditionExpression).toBe("#pk = :pk AND #sk > :updatedAfter");
    expect(companionSend.mock.calls[0][0].input).toEqual({
      TableName: "BillsManifest",
      Key: { pk: { S: "BILL_COMPANION_GROUPS" }, sk: { S: "CURRENT" } },
      ConsistentRead: true,
    });
  });

  it("reads CURRENT at most once a minute", async () => {
    companionSend.mockResolvedValue(currentItem(true, [["BILLS-119hr1285", "BILLS-119s570"]]));
    querySend.mockResolvedValue(manifestPage());

    await fetchHandler();
    now += 59_000;
    await fetchHandler();
    expect(companionSend).toHaveBeenCalledTimes(1);
    now += 2_000;
    await fetchHandler();
    expect(companionSend).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the groups are disabled", currentItem(false, [["BILLS-119hr1285", "BILLS-119s570"]])],
    ["CURRENT does not exist", {}],
  ])("answers companionGroups [] when %s", async (_label, response) => {
    companionSend.mockResolvedValue(response);
    querySend.mockResolvedValueOnce(manifestPage());

    const body = JSON.parse((await fetchHandler()).body);

    expect(body.companionGroups).toEqual([]);
    expect(body.bills).toHaveLength(1);
  });

  it("leaves the field out, so apps keep their list, when CURRENT cannot be read", async () => {
    companionSend.mockRejectedValue(new Error("AccessDeniedException"));
    querySend.mockResolvedValueOnce(manifestPage());

    const res = await fetchHandler();

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Object.keys(body)).toEqual(["generatedAt", "count", "bills"]);
    expect(
      logLinesWithMessage(warnSpy, "Could not read the companion groups; answering without companionGroups"),
    ).toHaveLength(1);
    expect(logLines(logSpy).filter((line) => line._aws)).toEqual([
      expect.objectContaining({ CompanionGroupsReadFailed: 1 }),
    ]);
  });
});

// ─── delivery=snapshot (CAP-01) ───────────────────────────────────────────────

describe("fetchBillsManifest handler with delivery=snapshot", () => {
  const SNAPSHOT_ENV = {
    TABLE_NAME: "test-table",
    PRIMARY_KEY: "pk",
    PK_VALUE: "BILL",
    MANIFEST_SNAPSHOT_BUCKET: "manifest-snapshots",
    MANIFEST_SNAPSHOT_KEY: undefined,
    PRIORITY_TABLE_NAME: undefined,
    PRIORITY_ACTIVE_INDEX_NAME: undefined,
  };
  const SNAPSHOT_METADATA = { "generated-at": "2026-09-25T11:50:00.000Z", count: "18084", sha256: "ab".repeat(32) };
  const PRESIGNED_URL =
    "https://manifest-snapshots.s3.us-east-1.amazonaws.com/bills/manifest-v1.json?X-Amz-Signature=abc";
  const NOW = new Date("2026-09-25T12:00:00.000Z");

  let restoreEnv: (() => void) | undefined;
  let ddbSend: jest.Mock;
  let s3Send: jest.Mock;
  let getSignedUrl: jest.Mock;
  let putMetric: jest.Mock;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let fetchHandler: typeof handler;

  const load = (env: Record<string, string | undefined> = {}) => {
    restoreEnv?.();
    restoreEnv = applyTestEnv({ ...SNAPSHOT_ENV, ...env });
    jest.resetModules();
    ddbSend = jest.requireMock("@aws-sdk/client-dynamodb").__mockSend;
    s3Send = jest.requireMock("@aws-sdk/client-s3").__mockSend;
    getSignedUrl = jest.requireMock("@aws-sdk/s3-request-presigner").getSignedUrl;
    putMetric = jest.requireMock("../shared/metrics").putMetric;
    ddbSend.mockReset();
    s3Send.mockReset();
    getSignedUrl.mockReset();
    putMetric.mockClear();
    fetchHandler = require("../handlers/fetchBillsManifest").handler;
  };

  const manifestPage = {
    Items: [
      {
        pk: { S: "BILL" },
        sk: { S: "2026-09-01T00:00:00.000Z#BILLS-119hr1ih" },
        guid: { S: "BILLS-119hr1ih" },
        billType: { S: "hr" },
        congress: { S: "119" },
        billNumber: { S: "1" },
        updatedAt: { S: "2026-09-01T00:00:00.000Z" },
        title: { S: "Inline Bill" },
        subCategories: { L: [] },
        lifeAreas: { L: [] },
        sponsors: { L: [] },
        cosponsors: { L: [] },
        voteCount: { N: "3" },
      },
    ],
  };

  const snapshotRequest = (extra: Record<string, string> = {}) => ({
    queryStringParameters: { delivery: "snapshot", ...extra },
  });

  const expectInlineManifest = (res: { statusCode: number; headers?: unknown; body: string }) => {
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(res.body);
    expect(Object.keys(body)).toEqual(["generatedAt", "count", "bills", "companionGroups"]);
    expect(body.companionGroups).toEqual([]);
    expect(body.count).toBe(1);
    expect(body.bills[0].guid).toBe("BILLS-119hr1ih");
  };

  // The metrics the handler wrote as embedded-metric-format log lines.
  const emittedMetrics = () =>
    logLines(logSpy)
      .filter((line) => line._aws)
      .flatMap((line) =>
        line._aws!.CloudWatchMetrics.flatMap((directive) =>
          directive.Metrics.map((metric) => ({
            namespace: directive.Namespace,
            name: metric.Name,
            value: line[metric.Name],
          })),
        ),
      );

  const expectFallback = (reason: string) => {
    const lines = logLinesWithMessage(warnSpy, "Bills manifest snapshot unavailable; returning the manifest inline");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "WARN", reason });
    expect(emittedMetrics()).toEqual([
      { namespace: "BillBoard/BillsManifest", name: "SnapshotPointerFallback", value: 1 },
    ]);
    expect(putMetric).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    load();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restoreEnv?.();
    restoreEnv = undefined;
  });

  it("returns a snapshot pointer with a 300-second presigned URL when the snapshot exists", async () => {
    s3Send.mockResolvedValueOnce({ Metadata: SNAPSHOT_METADATA, ContentEncoding: "gzip" });
    getSignedUrl.mockResolvedValueOnce(PRESIGNED_URL);

    const res = await fetchHandler(snapshotRequest());

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "Content-Type": "application/json", "Cache-Control": "no-store" });
    const body = JSON.parse(res.body);
    expect(body).toEqual({
      snapshotUrl: PRESIGNED_URL,
      generatedAt: "2026-09-25T11:50:00.000Z",
      count: 18084,
      expiresAt: "2026-09-25T12:05:00.000Z",
    });
    expect(Object.keys(body)).toEqual(["snapshotUrl", "generatedAt", "count", "expiresAt"]);

    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(s3Send.mock.calls[0][0]).toEqual({
      __type: "HeadObjectCommand",
      input: { Bucket: "manifest-snapshots", Key: "bills/manifest-v1.json" },
    });
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const [client, command, options] = getSignedUrl.mock.calls[0];
    expect(client).toEqual({ send: s3Send });
    expect(command).toEqual({
      __type: "GetObjectCommand",
      input: { Bucket: "manifest-snapshots", Key: "bills/manifest-v1.json" },
    });
    expect(options).toEqual({ expiresIn: 300, signingDate: NOW });

    // The pointer path does not read DynamoDB at all (neither the manifest nor the priority table).
    expect(ddbSend).not.toHaveBeenCalled();
    // One embedded-metric line and no PutMetricData call to wait for.
    expect(emittedMetrics()).toEqual([
      { namespace: "BillBoard/BillsManifest", name: "SnapshotPointerServed", value: 1 },
    ]);
    expect(putMetric).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("uses MANIFEST_SNAPSHOT_KEY when set", async () => {
    load({ MANIFEST_SNAPSHOT_KEY: "bills/custom.json" });
    s3Send.mockResolvedValueOnce({ Metadata: SNAPSHOT_METADATA });
    getSignedUrl.mockResolvedValueOnce(PRESIGNED_URL);

    const res = await fetchHandler(snapshotRequest());

    expect(JSON.parse(res.body).snapshotUrl).toBe(PRESIGNED_URL);
    expect(s3Send.mock.calls[0][0].input).toEqual({ Bucket: "manifest-snapshots", Key: "bills/custom.json" });
    expect(getSignedUrl.mock.calls[0][1].input).toEqual({ Bucket: "manifest-snapshots", Key: "bills/custom.json" });
  });

  it("signs a URL that needs no header but Host (real presigner, local signing only)", async () => {
    const actualS3 = jest.requireActual("@aws-sdk/client-s3");
    const actualPresigner = jest.requireActual("@aws-sdk/s3-request-presigner");
    const realClient = new actualS3.S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-secret", sessionToken: "session" },
    });
    s3Send.mockResolvedValueOnce({ Metadata: SNAPSHOT_METADATA });
    getSignedUrl.mockImplementationOnce((_client: unknown, command: { input: unknown }, options: unknown) =>
      actualPresigner.getSignedUrl(realClient, new actualS3.GetObjectCommand(command.input), options),
    );

    const res = await fetchHandler(snapshotRequest());

    const url = new URL(JSON.parse(res.body).snapshotUrl);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/bills/manifest-v1.json");
    expect(url.hostname).toContain("manifest-snapshots");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260925T120000Z");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("session");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the inline manifest when the snapshot does not exist", async () => {
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } }),
    );
    ddbSend.mockResolvedValueOnce(manifestPage);

    const res = await fetchHandler(snapshotRequest());

    expectInlineManifest(res);
    expect(getSignedUrl).not.toHaveBeenCalled();
    expectFallback("missing");
  });

  it("falls back to the inline manifest when HeadObject fails", async () => {
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }),
    );
    ddbSend.mockResolvedValueOnce(manifestPage);

    const res = await fetchHandler(snapshotRequest());

    expectInlineManifest(res);
    expectFallback("error");
  });

  it("falls back to the inline manifest when presigning fails", async () => {
    s3Send.mockResolvedValueOnce({ Metadata: SNAPSHOT_METADATA });
    getSignedUrl.mockRejectedValueOnce(new Error("Could not load credentials"));
    ddbSend.mockResolvedValueOnce(manifestPage);

    const res = await fetchHandler(snapshotRequest());

    expectInlineManifest(res);
    expectFallback("error");
  });

  it.each([
    ["no metadata", undefined],
    ["a bad generated-at", { ...SNAPSHOT_METADATA, "generated-at": "yesterday" }],
    ["a negative count", { ...SNAPSHOT_METADATA, count: "-1" }],
    ["a non-integer count", { ...SNAPSHOT_METADATA, count: "12.5" }],
  ])("falls back to the inline manifest when the snapshot has %s", async (_label, metadata) => {
    s3Send.mockResolvedValueOnce({ Metadata: metadata });
    ddbSend.mockResolvedValueOnce(manifestPage);

    const res = await fetchHandler(snapshotRequest());

    expectInlineManifest(res);
    expect(getSignedUrl).not.toHaveBeenCalled();
    expectFallback("invalid-metadata");
  });

  it("falls back to the inline manifest without calling S3 when MANIFEST_SNAPSHOT_BUCKET is unset", async () => {
    load({ MANIFEST_SNAPSHOT_BUCKET: undefined });
    ddbSend.mockResolvedValueOnce(manifestPage);

    const res = await fetchHandler(snapshotRequest());

    expectInlineManifest(res);
    expect(s3Send).not.toHaveBeenCalled();
    expectFallback("not-configured");
  });

  it("serves a windowed load inline when updatedAfter is present, without touching S3", async () => {
    ddbSend.mockResolvedValueOnce(manifestPage);

    const res = await fetchHandler(snapshotRequest({ updatedAfter: "2026-08-01T00:00:00.000Z" }));

    expectInlineManifest(res);
    expect(ddbSend.mock.calls[0][0].input.KeyConditionExpression).toBe("#pk = :pk AND #sk > :updatedAfter");
    expect(s3Send).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(emittedMetrics()).toEqual([]);
  });

  it("serves a windowed load inline when updatedAfter is passed at the top level (direct invoke)", async () => {
    ddbSend.mockResolvedValueOnce(manifestPage);

    const res = await fetchHandler({ ...snapshotRequest(), updatedAfter: "2026-08-01T00:00:00.000Z" });

    expectInlineManifest(res);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it.each([
    ["no query string", {}],
    ["no delivery parameter", { queryStringParameters: {} }],
    ["another delivery value", { queryStringParameters: { delivery: "inline" } }],
    ["a differently cased value", { queryStringParameters: { delivery: "Snapshot" } }],
  ])("is unchanged with %s", async (_label, event) => {
    ddbSend.mockResolvedValueOnce(manifestPage);

    const res = await fetchHandler(event);

    expectInlineManifest(res);
    expect(ddbSend.mock.calls[0][0].input.KeyConditionExpression).toBe("#pk = :pk");
    expect(s3Send).not.toHaveBeenCalled();
    expect(emittedMetrics()).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still answers the synthetic health check without S3 or DynamoDB", async () => {
    const res = await fetchHandler({
      source: "synthetic-test",
      queryStringParameters: { delivery: "snapshot" },
    } as Parameters<typeof handler>[0]);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "healthy", synthetic: true });
    expect(ddbSend).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });
});

export {};
