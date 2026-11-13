const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
}));

import { S3Client } from "@aws-sdk/client-s3";
import {
  ProcessedBillDao,
  buildProcessedBillGuidKey,
  buildProcessedBillRootGuidKey,
} from "../adapters/processedBillDao";
import { isValidProcessedBillGuid, processedBillGuid } from "../adapters/processedBillKeys";
import { ProcessedBillDocument } from "../models/bill";
import { noSuchKeyError } from "./fixtures/awsErrors";
import { logLinesWithMessage } from "./logLines";

interface FakeCommand {
  input: { Key?: string };
}

const identifier = {
  congress: "119",
  billType: "house-bill",
  billNumber: "1234",
};

const processedBill: ProcessedBillDocument = {
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2025-10-02T12:05:00Z",
  identifier,
  guid: "BILLS-119hr1234is",
  title: "An Act to Promote Testing",
  link: "https://example.com/bill",
  soWhat: "This is why it matters.",
  billBreakdown: {
    who: "Healthcare patients",
    what: "Expands healthcare coverage",
    how: "Through testing purposes",
    when: "Immediately",
    where: "Not Applicable",
    why: "To improve access",
  },
  actions: [],
  committees: [],
  subCategories: ["Healthcare"],
  lifeAreas: ["Taxes"],
  sponsors: ["S001235"],
  cosponsors: ["S001213"],
};

describe("ProcessedBillDao", () => {
  const bucketName = "test-bills";
  let dao: ProcessedBillDao;

  beforeEach(() => {
    mockS3Send.mockReset();
    dao = new ProcessedBillDao(new S3Client({}) as S3Client, bucketName);
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns null when bill is not found", async () => {
    const missing = noSuchKeyError("Not Found");

    // 1) guid key lookup -> NoSuchKey
    // 2) manifest lookup -> NoSuchKey
    mockS3Send.mockRejectedValueOnce(missing).mockRejectedValueOnce(missing);

    const result = await dao.getByGuid(processedBill.guid);
    expect(result).toBeNull();
    expect(mockS3Send).toHaveBeenCalledTimes(2);
  });

  it("never lists the processed-bills prefix on a miss (REL-26)", async () => {
    const { ListObjectsV2Command } = jest.requireMock("@aws-sdk/client-s3");
    ListObjectsV2Command.mockClear();
    const missing = noSuchKeyError("Not Found");
    const manifest = {
      bills: [{ guid: processedBill.guid, congress: "119", billType: "house-bill", billNumber: "1234" }],
    };
    mockS3Send.mockImplementation(async (command: FakeCommand) => {
      if (command.input.Key === "bills-manifest.json") {
        return { Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(manifest)) } };
      }
      throw missing;
    });

    const result = await dao.getByGuid(processedBill.guid);

    expect(result).toBeNull();
    expect(ListObjectsV2Command).not.toHaveBeenCalled();
    const requestedKeys = mockS3Send.mock.calls.map(([command]: [FakeCommand]) => command.input.Key);
    expect(requestedKeys).toEqual([
      "processed-bills/BILLS-119hr1234.json",
      "bills-manifest.json",
      "processed-bills/congress-119/house-bill/BILLS-119hr1234.json",
      "processed-bills/congress-119/house-bill/1234.json",
      "processed-bills/BILLS-119hr1234.json",
    ]);
  });

  it("returns a bill found through the manifest's legacy nested key", async () => {
    const missing = noSuchKeyError("Not Found");
    const manifest = {
      bills: [{ guid: processedBill.guid, congress: "119", billType: "house-bill", billNumber: "1234" }],
    };
    mockS3Send
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(manifest)) } })
      .mockResolvedValueOnce({
        Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(processedBill)) },
      });

    await expect(dao.getByGuid(processedBill.guid)).resolves.toEqual(processedBill);
  });

  it("throws when JSON parsing fails", async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue("invalid json"),
      },
    });

    await expect(dao.getByGuid(processedBill.guid)).rejects.toThrow();
  });

  it("stores and retrieves processed bills", async () => {
    mockS3Send.mockResolvedValueOnce({}).mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(JSON.stringify(processedBill)),
      },
    });

    await dao.store(processedBill);
    const fetched = await dao.getByGuid(processedBill.guid);

    expect(fetched).toEqual(processedBill);
    expect(mockS3Send).toHaveBeenCalledTimes(2);

    const firstPutCall = mockS3Send.mock.calls[0][0];
    expect(firstPutCall.input).toMatchObject({
      Bucket: bucketName,
      Key: buildProcessedBillGuidKey({
        congress: identifier.congress,
        billType: identifier.billType,
        guid: processedBill.guid,
      }),
    });

    const getCall = mockS3Send.mock.calls[1][0];
    expect(getCall.input).toMatchObject({
      Bucket: bucketName,
      Key: buildProcessedBillRootGuidKey(processedBill.guid),
    });
  });
});

describe("ProcessedBillDao revisions and conditional stores (REL-30)", () => {
  const bucketName = "test-bills";
  let dao: ProcessedBillDao;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    mockS3Send.mockReset();
    dao = new ProcessedBillDao(new S3Client({}) as S3Client, bucketName);
    logSpy = jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const object = (payload: unknown, extra: Record<string, unknown> = {}) => ({
    Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(payload)) },
    ...extra,
  });

  it("reads the flat key with its ETag, metadata and LastModified", async () => {
    mockS3Send.mockResolvedValueOnce(
      object(processedBill, {
        ETag: '"e1"',
        VersionId: "pv1",
        LastModified: new Date("2026-02-01T00:00:00Z"),
        Metadata: { "source-text-hash": "v1:abc" },
      }),
    );

    await expect(dao.getRevisionByGuid(processedBill.guid)).resolves.toEqual({
      bill: processedBill,
      key: "processed-bills/BILLS-119hr1234.json",
      location: "flat",
      etag: '"e1"',
      versionId: "pv1",
      metadata: { "source-text-hash": "v1:abc" },
      lastModified: "2026-02-01T00:00:00.000Z",
    });
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy locations without an ETag, and logs and counts the hit", async () => {
    const manifest = {
      bills: [{ guid: processedBill.guid, congress: "119", billType: "house-bill", billNumber: "1234" }],
    };
    mockS3Send
      .mockRejectedValueOnce(noSuchKeyError())
      .mockResolvedValueOnce(object(manifest))
      .mockResolvedValueOnce(object(processedBill, { ETag: '"legacy"' }));

    await expect(dao.getRevisionByGuid(processedBill.guid)).resolves.toEqual({
      bill: processedBill,
      key: "processed-bills/BILLS-119hr1234.json",
      location: "legacy",
    });
    expect(mockS3Send.mock.calls[2][0].input.Key).toBe("processed-bills/congress-119/house-bill/BILLS-119hr1234.json");
    expect(logSpy.mock.calls.map(([line]) => String(line)).join("\n")).toContain('"ProcessedBillLegacyLocation":1');
  });

  it("returns null when no location has the bill", async () => {
    mockS3Send.mockRejectedValue(noSuchKeyError());
    await expect(dao.getRevisionByGuid(processedBill.guid)).resolves.toBeNull();
  });

  it("stores the source metadata and the write condition, and returns the new version", async () => {
    mockS3Send.mockResolvedValueOnce({ ETag: '"e2"', VersionId: "pv2" });

    await expect(
      dao.store(processedBill, {
        correlationId: "corr-1",
        source: { textHash: "v1:abc", rawVersion: "rv9", fetchedAt: "2026-02-01T00:00:00.000Z" },
        ifMatch: '"e1"',
      }),
    ).resolves.toEqual({ etag: '"e2"', versionId: "pv2" });
    expect(mockS3Send.mock.calls[0][0].input).toMatchObject({
      Key: "processed-bills/BILLS-119hr1234.json",
      IfMatch: '"e1"',
      Metadata: {
        "correlation-id": "corr-1",
        "source-text-hash": "v1:abc",
        "source-raw-version": "rv9",
        "source-fetched-at": "2026-02-01T00:00:00.000Z",
      },
    });

    mockS3Send.mockResolvedValueOnce({});
    await dao.store(processedBill, { ifNoneMatch: "*" });
    expect(mockS3Send.mock.calls[1][0].input).toMatchObject({ IfNoneMatch: "*" });
    expect(mockS3Send.mock.calls[1][0].input).not.toHaveProperty("Metadata");
  });
});

describe("ProcessedBillDao.store: the plain guid", () => {
  const bucketName = "test-bills";
  let dao: ProcessedBillDao;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({ VersionId: "pv1" });
    dao = new ProcessedBillDao(new S3Client({}) as S3Client, bucketName);
    jest.spyOn(console, "log").mockImplementation();
    warnSpy = jest.spyOn(console, "warn").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const bill = (guid: string): ProcessedBillDocument => ({
    ...processedBill,
    identifier: { congress: "119", billType: "house-bill", billNumber: "1181" },
    guid,
  });

  it("stores a guid with a text-version suffix under the plain guid, in the key and the body, and logs it", async () => {
    await dao.store(bill("BILLS-119hr1181rh"));

    const put = mockS3Send.mock.calls[0][0].input;
    expect(put.Key).toBe("processed-bills/BILLS-119hr1181.json");
    expect(JSON.parse(put.Body)).toEqual(bill("BILLS-119hr1181"));
    expect(logLinesWithMessage(warnSpy, "processed_guid_canonicalized")).toEqual([
      expect.objectContaining({
        event: "processed_guid_canonicalized",
        received: "BILLS-119hr1181rh",
        guid: "BILLS-119hr1181",
      }),
    ]);
  });

  it("stores a plain guid as given and logs nothing", async () => {
    await dao.store(bill("BILLS-119hr1181"));

    const put = mockS3Send.mock.calls[0][0].input;
    expect(put.Key).toBe("processed-bills/BILLS-119hr1181.json");
    expect(put.Body).toBe(JSON.stringify(bill("BILLS-119hr1181")));
    expect(logLinesWithMessage(warnSpy, "processed_guid_canonicalized")).toEqual([]);
  });
});

describe("processedBillGuid", () => {
  it("takes the guid the key names over a suffixed document guid", () => {
    expect(processedBillGuid("processed-bills/BILLS-119hr1181.json", "BILLS-119hr1181rh")).toBe("BILLS-119hr1181");
  });

  it("takes the key's guid over another bill's document guid", () => {
    expect(processedBillGuid("processed-bills/BILLS-119hr1181.json", "BILLS-119hr7008rh")).toBe("BILLS-119hr1181");
  });

  it("takes the guid of a locator key", () => {
    expect(processedBillGuid("processed-bills/congress-119/house-bill/BILLS-119hr1181.json", undefined)).toBe(
      "BILLS-119hr1181",
    );
  });

  it("falls back to the document guid without its suffix for a legacy identifier key", () => {
    expect(processedBillGuid("processed-bills/congress-119/hr/1181.json", " BILLS-119hr1181rh ")).toBe(
      "BILLS-119hr1181",
    );
  });

  it("returns a document guid that is no bill guid trimmed, and null when neither names one", () => {
    expect(processedBillGuid("processed-bills/congress-119/hr/1181.json", " not-a-guid ")).toBe("not-a-guid");
    expect(processedBillGuid("processed-bills/congress-119/hr/1181.json", "  ")).toBeNull();
    expect(processedBillGuid("processed-bills/notes.json", 42)).toBeNull();
  });
});

describe("isValidProcessedBillGuid (SEC-12)", () => {
  it.each(["BILLS-119hr1234", "BILLS-119hr1234ih", "BILLS-118hjres131eh", "bills-108s922is", "BILLS-119hconres12enr"])(
    "accepts %s",
    (guid) => {
      expect(isValidProcessedBillGuid(guid)).toBe(true);
    },
  );

  it.each([
    "",
    "BILLS-",
    "BILLS-119",
    "BILLS-hr1234",
    "BILLS-119hr",
    "BILLS-119hr1234/../x",
    "BILLS-119hr1234.json",
    "processed-bills/BILLS-119hr1234",
    " BILLS-119hr1234",
    "BILLS-119hr1234ih2",
    `BILLS-${"1".repeat(60)}hr1`,
  ])("rejects %p", (guid) => {
    expect(isValidProcessedBillGuid(guid)).toBe(false);
  });
});
