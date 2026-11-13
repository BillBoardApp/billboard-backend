const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { jsonReadable } from "./fixtures/streams";
import { noSuchKeyError } from "./fixtures/awsErrors";
import { S3Client } from "@aws-sdk/client-s3";
import { BillStorage, isPreconditionFailure } from "../adapters/billStorage";

describe("BillStorage.getJson", () => {
  const bucketName = "test-bucket";
  let storage: BillStorage;

  beforeEach(() => {
    mockS3Send.mockReset();
    storage = new BillStorage(new S3Client({}) as S3Client, bucketName);
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("parses JSON from a Body.transformToString()", async () => {
    const payload = { hello: "world" };
    mockS3Send.mockResolvedValueOnce({
      Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(payload)) },
    });

    const result = await storage.getJson("some/key.json");
    expect(result).toEqual(payload);
  });

  it("parses JSON from a Node Readable stream body", async () => {
    const payload = { hello: "stream" };
    const stream = jsonReadable(payload);

    mockS3Send.mockResolvedValueOnce({ Body: stream });

    const result = await storage.getJson("some/key.json");
    expect(result).toEqual(payload);
  });

  it("returns null on NoSuchKey", async () => {
    mockS3Send.mockRejectedValueOnce(noSuchKeyError());

    const result = await storage.getJson("missing.json");
    expect(result).toBeNull();
  });
});

describe("BillStorage versioning helpers", () => {
  const bucketName = "test-bucket";
  let storage: BillStorage;

  beforeEach(() => {
    mockS3Send.mockReset();
    storage = new BillStorage(new S3Client({}) as S3Client, bucketName);
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns the 2nd-latest version id when no current version id provided", async () => {
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: "some/key.json", VersionId: "v3", IsLatest: true, LastModified: "2026-01-02T00:03:00Z" },
        { Key: "some/key.json", VersionId: "v2", IsLatest: false, LastModified: "2026-01-02T00:02:00Z" },
        { Key: "some/key.json", VersionId: "v1", IsLatest: false, LastModified: "2026-01-02T00:01:00Z" },
      ],
      DeleteMarkers: [],
    });

    const prev = await storage.getPreviousVersionId("some/key.json");
    expect(prev).toBe("v2");

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const input = mockS3Send.mock.calls[0][0].input;
    expect(input).toMatchObject({
      Bucket: bucketName,
      Prefix: "some/key.json",
    });
  });

  it("returns the version immediately older than the provided current version id", async () => {
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: "some/key.json", VersionId: "v3", IsLatest: true, LastModified: "2026-01-02T00:03:00Z" },
        { Key: "some/key.json", VersionId: "v2", IsLatest: false, LastModified: "2026-01-02T00:02:00Z" },
        { Key: "some/key.json", VersionId: "v1", IsLatest: false, LastModified: "2026-01-02T00:01:00Z" },
      ],
      DeleteMarkers: [],
    });

    const prev = await storage.getPreviousVersionId("some/key.json", "v2");
    expect(prev).toBe("v1");
  });

  it("returns null for the oldest stored version, never a newer one (REL-59)", async () => {
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: "some/key.json", VersionId: "v2", IsLatest: true, LastModified: "2026-01-02T00:02:00Z" },
        { Key: "some/key.json", VersionId: "v1", IsLatest: false, LastModified: "2026-01-02T00:01:00Z" },
      ],
      DeleteMarkers: [],
    });

    expect(await storage.getPreviousVersionId("some/key.json", "v1")).toBeNull();
  });

  it("returns null for a version that is not stored, never the 2nd-latest (REL-59)", async () => {
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: "some/key.json", VersionId: "v2", IsLatest: true, LastModified: "2026-01-02T00:02:00Z" },
        { Key: "some/key.json", VersionId: "v1", IsLatest: false, LastModified: "2026-01-02T00:01:00Z" },
      ],
      DeleteMarkers: [],
    });

    expect(await storage.getPreviousVersionId("some/key.json", "gone")).toBeNull();
  });

  it("skips delete markers when choosing previous version", async () => {
    mockS3Send.mockResolvedValueOnce({
      IsTruncated: false,
      Versions: [
        { Key: "some/key.json", VersionId: "v2", IsLatest: true, LastModified: "2026-01-02T00:02:00Z" },
        { Key: "some/key.json", VersionId: "v1", IsLatest: false, LastModified: "2026-01-02T00:01:00Z" },
      ],
      DeleteMarkers: [{ Key: "some/key.json", VersionId: "dm", IsLatest: false, LastModified: "2026-01-02T00:01:30Z" }],
    });

    const prev = await storage.getPreviousVersionId("some/key.json");
    expect(prev).toBe("v1");
  });
});

describe("BillStorage user metadata (OBS-10)", () => {
  let storage: BillStorage;

  beforeEach(() => {
    mockS3Send.mockReset();
    storage = new BillStorage(new S3Client({}) as S3Client, "test-bucket");
    jest.spyOn(console, "log").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("puts metadata only when there is some", async () => {
    mockS3Send.mockResolvedValue({});

    await storage.putJson("a.json", { a: 1 }, { metadata: { "correlation-id": "c-1" } });
    await storage.putJson("b.json", { b: 1 }, { metadata: {} });
    await storage.putJson("c.json", { c: 1 });

    const inputs = mockS3Send.mock.calls.map(([cmd]) => cmd.input);
    expect(inputs[0]).toEqual({
      Bucket: "test-bucket",
      Key: "a.json",
      Body: JSON.stringify({ a: 1 }),
      ContentType: "application/json",
      Metadata: { "correlation-id": "c-1" },
    });
    expect(inputs[1]).not.toHaveProperty("Metadata");
    expect(inputs[2]).not.toHaveProperty("Metadata");
  });

  it("returns the current version's metadata with the latest and previous JSON", async () => {
    mockS3Send.mockImplementation(async (cmd: { input: { Prefix?: string; VersionId?: string } }) => {
      if (cmd.input.Prefix !== undefined) {
        return {
          IsTruncated: false,
          Versions: [
            { Key: "k.json", VersionId: "v2", IsLatest: true, LastModified: "2026-01-02T00:00:00Z" },
            { Key: "k.json", VersionId: "v1", IsLatest: false, LastModified: "2026-01-01T00:00:00Z" },
          ],
        };
      }
      const version = cmd.input.VersionId;
      return {
        Body: { transformToString: async () => JSON.stringify({ version }) },
        Metadata: { "correlation-id": `c-${version}` },
      };
    });

    const result = await storage.getLatestAndPreviousJson("k.json", "v2");

    expect(result).toEqual({
      current: { version: "v2" },
      previous: { version: "v1" },
      currentVersionId: "v2",
      previousVersionId: "v1",
      currentMetadata: { "correlation-id": "c-v2" },
    });
  });
});

describe("BillStorage.getLatestAndPreviousJson: the version read and the one before it (REL-59)", () => {
  let storage: BillStorage;
  /** The S3 commands this suite saw: "get <VersionId or latest>" and "list". */
  const calls = () =>
    mockS3Send.mock.calls.map(([cmd]: [{ input: { Prefix?: string; VersionId?: string } }]) =>
      cmd.input.Prefix !== undefined ? "list" : `get ${cmd.input.VersionId ?? "latest"}`,
    );
  /** A bucket holding `newestFirst`; `latest` is what a GetObject without a VersionId returns. */
  const serve = (newestFirst: string[], latest = newestFirst[0]) =>
    mockS3Send.mockImplementation(async (cmd: { input: { Prefix?: string; VersionId?: string } }) => {
      if (cmd.input.Prefix !== undefined) {
        return {
          IsTruncated: false,
          Versions: newestFirst.map((id, i) => ({
            Key: "k.json",
            VersionId: id,
            IsLatest: i === 0,
            LastModified: "2026-11-10T18:19:37Z",
          })),
          DeleteMarkers: [],
        };
      }
      const version = cmd.input.VersionId ?? latest;
      if (!newestFirst.includes(version) && version !== latest) {
        throw Object.assign(new Error("The specified version does not exist."), { Code: "NoSuchVersion" });
      }
      return { Body: { transformToString: async () => JSON.stringify({ version }) }, VersionId: version };
    });

  beforeEach(() => {
    mockS3Send.mockReset();
    storage = new BillStorage(new S3Client({}) as S3Client, "test-bucket");
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reads the version named and the one listed after it, in S3's order for one second", async () => {
    serve(["v3", "v2", "v1"]);

    const result = await storage.getLatestAndPreviousJson("k.json", "v2");

    expect(result).toMatchObject({
      current: { version: "v2" },
      previous: { version: "v1" },
      currentVersionId: "v2",
      previousVersionId: "v1",
    });
    expect(calls()).toEqual(["get v2", "list", "get v1"]);
  });

  it("pairs the oldest stored version with nothing, never with a newer one", async () => {
    serve(["v3", "v2", "v1"]);

    const result = await storage.getLatestAndPreviousJson("k.json", "v1");

    expect(result).toMatchObject({ current: { version: "v1" }, previous: null, previousVersionId: null });
    expect(calls()).toEqual(["get v1", "list"]);
  });

  it("returns no current for a named version that is not stored, and never reads the latest in its place", async () => {
    serve(["v3", "v2"]);

    const result = await storage.getLatestAndPreviousJson("k.json", "gone");

    expect(result).toEqual({ current: null, previous: null, previousVersionId: null });
    expect(calls()).toEqual(["get gone"]);
  });

  it("throws when the version read is missing from the listing, rather than guess its predecessor", async () => {
    serve(["v3", "v1"], "v2");

    await expect(storage.getLatestAndPreviousJson("k.json", "v2")).rejects.toThrow(
      "Version v2 of k.json is not in its version listing",
    );
    await expect(storage.getLatestAndPreviousJson("k.json")).rejects.toThrow(
      "Version v2 of k.json is not in its version listing",
    );
  });

  it("without a version, pairs the latest GetObject returned with its own predecessor, not the 2nd-latest listed", async () => {
    // v3 was stored between the GetObject (which returned v2) and the listing.
    serve(["v3", "v2", "v1"], "v2");

    const result = await storage.getLatestAndPreviousJson("k.json");

    expect(result).toMatchObject({
      current: { version: "v2" },
      previous: { version: "v1" },
      currentVersionId: "v2",
      previousVersionId: "v1",
    });
    expect(calls()).toEqual(["get latest", "list", "get v1"]);
  });

  it("without a version and without a VersionId on the answer (unversioned), pairs it with the 2nd-latest listed", async () => {
    mockS3Send
      .mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify({ version: "latest" }) } })
      .mockResolvedValueOnce({
        IsTruncated: false,
        Versions: [
          { Key: "k.json", VersionId: "v2", IsLatest: true, LastModified: "2026-01-02T00:00:00Z" },
          { Key: "k.json", VersionId: "v1", IsLatest: false, LastModified: "2026-01-01T00:00:00Z" },
        ],
      })
      .mockResolvedValueOnce({ Body: { transformToString: async () => JSON.stringify({ version: "v1" }) } });

    const result = await storage.getLatestAndPreviousJson("k.json");

    expect(result).toEqual({
      current: { version: "latest" },
      previous: { version: "v1" },
      previousVersionId: "v1",
      currentMetadata: undefined,
    });
  });
});

describe("BillStorage revisions and conditional writes (REL-30)", () => {
  let storage: BillStorage;

  beforeEach(() => {
    mockS3Send.mockReset();
    storage = new BillStorage(new S3Client({}) as S3Client, "test-bucket");
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

  it("returns the ETag, VersionId and LastModified of the latest version", async () => {
    mockS3Send.mockResolvedValueOnce(
      object(
        { a: 1 },
        {
          ETag: '"abc"',
          VersionId: "v7",
          LastModified: new Date("2026-02-01T21:20:00Z"),
          Metadata: { "source-text-hash": "v1:x" },
        },
      ),
    );

    await expect(storage.getJsonObject("k.json")).resolves.toEqual({
      value: { a: 1 },
      metadata: { "source-text-hash": "v1:x" },
      etag: '"abc"',
      versionId: "v7",
      lastModified: "2026-02-01T21:20:00.000Z",
    });
  });

  it("returns the same fields for a versioned read, and leaves out what S3 did not send", async () => {
    mockS3Send.mockResolvedValueOnce(object({ a: 2 }, { VersionId: "v3", LastModified: "2026-02-01T00:00:00Z" }));
    await expect(storage.getJsonObjectWithVersionId("k.json", "v3")).resolves.toEqual({
      value: { a: 2 },
      metadata: undefined,
      versionId: "v3",
      lastModified: "2026-02-01T00:00:00.000Z",
    });
    expect(mockS3Send.mock.calls[0][0].input).toMatchObject({ Key: "k.json", VersionId: "v3" });

    mockS3Send.mockResolvedValueOnce(object({ a: 3 }, { LastModified: "not a date" }));
    await expect(storage.getJsonObject("k.json")).resolves.toEqual({ value: { a: 3 }, metadata: undefined });
  });

  it("sends IfMatch or IfNoneMatch only when asked, and returns the new version's identity", async () => {
    mockS3Send.mockResolvedValueOnce({ ETag: '"new"', VersionId: "v8" });
    await expect(storage.putJson("k.json", { a: 1 }, { metadata: { m: "1" }, ifMatch: '"old"' })).resolves.toEqual({
      etag: '"new"',
      versionId: "v8",
    });
    expect(mockS3Send.mock.calls[0][0].input).toEqual({
      Bucket: "test-bucket",
      Key: "k.json",
      Body: JSON.stringify({ a: 1 }),
      ContentType: "application/json",
      Metadata: { m: "1" },
      IfMatch: '"old"',
    });

    mockS3Send.mockResolvedValueOnce({});
    await expect(storage.putJson("k.json", { a: 1 }, { ifNoneMatch: "*" })).resolves.toEqual({});
    expect(mockS3Send.mock.calls[1][0].input).toMatchObject({ IfNoneMatch: "*" });
    expect(mockS3Send.mock.calls[1][0].input).not.toHaveProperty("IfMatch");

    mockS3Send.mockResolvedValueOnce(undefined);
    await storage.putJson("k.json", { a: 1 });
    expect(Object.keys(mockS3Send.mock.calls[2][0].input).sort()).toEqual(["Body", "Bucket", "ContentType", "Key"]);
  });

  it.each([
    [{ name: "PreconditionFailed" }, true],
    [{ name: "ConditionalRequestConflict" }, true],
    [{ Code: "PreconditionFailed" }, true],
    [{ $metadata: { httpStatusCode: 412 } }, true],
    [{ $metadata: { httpStatusCode: 409 } }, true],
    [{ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }, false],
    [{ name: "InternalError", $metadata: { httpStatusCode: 500 } }, false],
    [null, false],
  ])("isPreconditionFailure(%j) is %s", (error, expected) => {
    expect(isPreconditionFailure(error)).toBe(expected);
  });
});
