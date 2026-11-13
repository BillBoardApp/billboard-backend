const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { S3Client } from "@aws-sdk/client-s3";
import { RawBillDao, buildRawBillGuidKey } from "../adapters/rawBillDao";
import { RawBill } from "../models/bill";

const identifier = {
  congress: "119",
  billType: "house-bill",
  billNumber: "1234",
};

const rawBill: RawBill = {
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2025-10-02T12:00:00Z",
  identifier,
  metadata: {
    guid: "BILLS-119hr1234is",
    title: "An Act to Promote Testing",
    pubDate: "2025-10-01T00:00:00Z",
    legislationUrl: "https://www.congress.gov/bill/119th-congress/house-bill/1234",
    fetchedAt: "2025-10-02T12:00:00Z",
  },
  content: { sample: true },
};

describe("RawBillDao", () => {
  const bucketName = "test-bills";
  let dao: RawBillDao;

  beforeEach(() => {
    mockS3Send.mockReset();
    dao = new RawBillDao(new S3Client({}) as S3Client, bucketName);
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stores raw bills to S3", async () => {
    mockS3Send.mockResolvedValueOnce({});

    await dao.store(rawBill);

    expect(mockS3Send).toHaveBeenCalledTimes(1);

    const guidPutInput = mockS3Send.mock.calls[0][0].input;
    expect(guidPutInput).toMatchObject({
      Bucket: bucketName,
      Key: buildRawBillGuidKey({
        congress: identifier.congress,
        billType: identifier.billType,
        guid: rawBill.metadata.guid,
      }),
    });
  });

  it("retrieves raw bills from S3", async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(JSON.stringify(rawBill)),
      },
    });

    const fetched = await dao.getByGuid(rawBill.metadata.guid);

    expect(fetched).toEqual(rawBill);
    const getCall = mockS3Send.mock.calls[0][0];
    expect(getCall.input).toMatchObject({
      Bucket: bucketName,
      Key: buildRawBillGuidKey({
        congress: identifier.congress,
        billType: identifier.billType,
        guid: rawBill.metadata.guid,
      }),
    });
  });

  it("reads the latest raw bill with its ETag and VersionId (REL-30)", async () => {
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(rawBill)) },
      ETag: '"r1"',
      VersionId: "rv1",
      LastModified: new Date("2026-02-01T00:00:00Z"),
    });

    await expect(dao.getRevisionByGuid(rawBill.metadata.guid)).resolves.toEqual({
      value: rawBill,
      metadata: undefined,
      etag: '"r1"',
      versionId: "rv1",
      lastModified: "2026-02-01T00:00:00.000Z",
    });
    expect(mockS3Send.mock.calls[0][0].input).toMatchObject({ Key: "raw-bills/BILLS-119hr1234.json" });
  });

  it("writes conditionally on the ETag it was given (REL-36)", async () => {
    mockS3Send.mockResolvedValueOnce({ ETag: '"r2"', VersionId: "rv2" });

    await expect(dao.store(rawBill, { correlationId: "corr", ifMatch: '"r1"' })).resolves.toEqual({
      etag: '"r2"',
      versionId: "rv2",
    });
    expect(mockS3Send.mock.calls[0][0].input).toMatchObject({
      IfMatch: '"r1"',
      Metadata: { "correlation-id": "corr" },
    });
  });
});
