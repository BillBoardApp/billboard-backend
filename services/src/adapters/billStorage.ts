import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  type DeleteMarkerEntry,
  type GetObjectCommandOutput,
  type ListObjectVersionsCommandOutput,
  type ObjectVersion,
} from "@aws-sdk/client-s3";
import { logger } from "../shared/logger";

/** The body shapes readBodyToString reads: an SDK stream, a Node.js stream, a string or bytes. */
interface ReadableBody {
  transformToString?: () => Promise<string>;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

const readBodyToString = async (body: unknown): Promise<string | null> => {
  if (!body) return null;

  const candidate = body as ReadableBody;

  // AWS SDK v3 in Lambda often provides `transformToString()`.
  if (typeof candidate.transformToString === "function") {
    return (await candidate.transformToString()) as string;
  }

  // Node.js Readable streams are async-iterable; our Jest mocks often use Readable.
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of candidate as AsyncIterable<unknown>) {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (chunk instanceof Uint8Array) chunks.push(chunk);
      else chunks.push(Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  if (typeof candidate === "string") return candidate;
  if (candidate instanceof Uint8Array) return Buffer.from(candidate).toString("utf-8");

  return null;
};

/**
 * A stored JSON document, its S3 user metadata, and the identity of the version that was read:
 * `etag` (for a conditional write over it), `versionId` and `lastModified` (ISO time).
 */
export interface StoredJson<T> {
  value: T | null;
  metadata?: Record<string, string>;
  etag?: string;
  versionId?: string;
  lastModified?: string;
}

/** Options for putJson. `ifMatch` / `ifNoneMatch` make the write conditional (S3 answers 412 or 409). */
export interface PutJsonOptions {
  /** Stored as S3 user metadata (x-amz-meta-<name>), e.g. the pipeline correlation id. */
  metadata?: Record<string, string>;
  /** Write only if the current version still has this ETag. */
  ifMatch?: string;
  /** "*": write only if no current version exists (a delete marker counts as none). */
  ifNoneMatch?: string;
}

/** The stored version's identity, as PutObject returned it. */
export interface PutJsonResult {
  etag?: string;
  versionId?: string;
}

const toIsoString = (value: unknown): string | undefined => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
};

/** The version identity fields of a GetObject response. */
const revisionOf = (
  response: Pick<GetObjectCommandOutput, "ETag" | "VersionId" | "LastModified">,
): Pick<StoredJson<unknown>, "etag" | "versionId" | "lastModified"> => ({
  ...(typeof response?.ETag === "string" ? { etag: response.ETag } : {}),
  ...(typeof response?.VersionId === "string" ? { versionId: response.VersionId } : {}),
  ...(toIsoString(response?.LastModified) ? { lastModified: toIsoString(response?.LastModified) } : {}),
});

export class BillStorage {
  constructor(
    public readonly s3Client: S3Client,
    public readonly bucketName: string,
  ) {}

  /**
   * `metadata` is stored as S3 user metadata (x-amz-meta-<name>), e.g. the pipeline correlation id.
   * With `ifMatch` or `ifNoneMatch` the write is conditional; a refused write throws (see
   * isPreconditionFailure). Returns the new version's ETag and VersionId.
   */
  async putJson(key: string, payload: unknown, options: PutJsonOptions = {}): Promise<PutJsonResult> {
    const metadata = options.metadata && Object.keys(options.metadata).length > 0 ? options.metadata : undefined;
    const response = await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: JSON.stringify(payload),
        ContentType: "application/json",
        ...(metadata ? { Metadata: metadata } : {}),
        ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
        ...(options.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
      }),
    );
    return {
      ...(typeof response?.ETag === "string" ? { etag: response.ETag } : {}),
      ...(typeof response?.VersionId === "string" ? { versionId: response.VersionId } : {}),
    };
  }

  async getJson<T>(key: string): Promise<T | null> {
    return (await this.getJsonObject<T>(key)).value;
  }

  /**
   * Like getJson, plus the object's S3 user metadata (names without the x-amz-meta- prefix) and the
   * version's ETag, VersionId and LastModified.
   */
  async getJsonObject<T>(key: string): Promise<StoredJson<T>> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      );

      const body = await readBodyToString(response.Body);

      if (!body) {
        logger.warn("S3 bill payload missing body", { bucket: this.bucketName, key });
        return { value: null };
      }

      try {
        return { value: JSON.parse(body) as T, metadata: response.Metadata, ...revisionOf(response) };
      } catch (error) {
        logger.warn("Failed to parse S3 bill payload", { bucket: this.bucketName, key, error });
        throw error;
      }
    } catch (error) {
      if (isNoSuchKeyError(error) || isNoSuchVersionError(error)) {
        return { value: null };
      }

      logger.error("Failed to load bill from S3", { bucket: this.bucketName, key, error });
      throw error;
    }
  }

  /**
   * Returns all known versions for a specific key (including delete markers).
   *
   * Notes:
   * - Requires bucket versioning to be enabled (otherwise VersionId is typically "null").
   * - For callers that only care about content, filter out entries where `isDeleteMarker` is true.
   */
  async listObjectVersionsForKey(key: string): Promise<
    Array<{
      key: string;
      versionId: string;
      isLatest: boolean;
      isDeleteMarker: boolean;
      lastModified?: string;
      eTag?: string;
      size?: number;
    }>
  > {
    const results: Array<{
      key: string;
      versionId: string;
      isLatest: boolean;
      isDeleteMarker: boolean;
      lastModified?: string;
      eTag?: string;
      size?: number;
    }> = [];

    // Pagination uses KeyMarker + VersionIdMarker.
    let keyMarker: string | undefined = undefined;
    let versionIdMarker: string | undefined = undefined;

    do {
      const resp: ListObjectVersionsCommandOutput = await this.s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucketName,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );

      const versions = (resp?.Versions ?? []) as ObjectVersion[];
      for (const v of versions) {
        if (!v?.Key || v.Key !== key) continue;
        if (!v?.VersionId) continue;

        results.push({
          key: v.Key,
          versionId: String(v.VersionId),
          isLatest: Boolean(v.IsLatest),
          isDeleteMarker: false,
          lastModified: v.LastModified
            ? v.LastModified instanceof Date
              ? v.LastModified.toISOString()
              : new Date(v.LastModified).toISOString()
            : undefined,
          eTag: v.ETag ? String(v.ETag) : undefined,
          size: typeof v.Size === "number" ? v.Size : undefined,
        });
      }

      const deleteMarkers = (resp?.DeleteMarkers ?? []) as DeleteMarkerEntry[];
      for (const dm of deleteMarkers) {
        if (!dm?.Key || dm.Key !== key) continue;
        if (!dm?.VersionId) continue;

        results.push({
          key: dm.Key,
          versionId: String(dm.VersionId),
          isLatest: Boolean(dm.IsLatest),
          isDeleteMarker: true,
          lastModified: dm.LastModified
            ? dm.LastModified instanceof Date
              ? dm.LastModified.toISOString()
              : new Date(dm.LastModified).toISOString()
            : undefined,
        });
      }

      const isTruncated = Boolean(resp?.IsTruncated);
      if (isTruncated) {
        keyMarker = resp?.NextKeyMarker;
        versionIdMarker = resp?.NextVersionIdMarker;
      } else {
        keyMarker = undefined;
        versionIdMarker = undefined;
      }
    } while (keyMarker);

    // Deterministic ordering: newest first when LastModified is available.
    // S3 generally returns newest first, but we sort defensively.
    results.sort((a, b) => {
      const at = a.lastModified ? Date.parse(a.lastModified) : 0;
      const bt = b.lastModified ? Date.parse(b.lastModified) : 0;
      return bt - at;
    });

    return results;
  }

  /**
   * Returns the previous (non-delete-marker) VersionId for `key`.
   *
   * If `currentVersionId` is provided, "previous" means the content version just older than it in S3's listing, and
   * null when it is the oldest stored or is not stored at all: never the version itself or a newer one (REL-59).
   * If not provided, "previous" means the 2nd-latest version.
   */
  async getPreviousVersionId(key: string, currentVersionId?: string): Promise<string | null> {
    const contentVersions = (await this.listObjectVersionsForKey(key)).filter((v) => !v.isDeleteMarker);
    if (!currentVersionId) return contentVersions[1]?.versionId ?? null;
    const idx = contentVersions.findIndex((v) => v.versionId === currentVersionId);
    return idx >= 0 ? (contentVersions[idx + 1]?.versionId ?? null) : null;
  }

  async getJsonWithVersionId<T>(key: string, versionId: string): Promise<T | null> {
    return (await this.getJsonObjectWithVersionId<T>(key, versionId)).value;
  }

  /** Like getJsonWithVersionId, plus that version's S3 user metadata, ETag, VersionId and LastModified. */
  async getJsonObjectWithVersionId<T>(key: string, versionId: string): Promise<StoredJson<T>> {
    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          VersionId: versionId,
        }),
      );

      const body = await readBodyToString(response.Body);

      if (!body) {
        logger.warn("S3 bill payload missing body", { bucket: this.bucketName, key, versionId });
        return { value: null };
      }

      return { value: JSON.parse(body) as T, metadata: response.Metadata, ...revisionOf(response) };
    } catch (error) {
      if (isNoSuchKeyError(error) || isNoSuchVersionError(error) || isNotFoundError(error)) {
        return { value: null };
      }

      logger.error("Failed to load bill from S3", { bucket: this.bucketName, key, versionId, error });
      throw error;
    }
  }

  /**
   * A stored version of `key` and the content version stored just before it: the pair a change is judged on (REL-59).
   *
   * - With `currentVersionId` (the version an S3 event named): that version, never another. When it is not stored,
   *   `current` is null and the latest is not read in its place.
   * - Without one: the latest version.
   *
   * `previous` is the content version just after the version read in S3's listing (newest first, delete markers
   * skipped; two versions of one second keep S3's order), or null when the version read is the oldest stored. It is
   * chosen from the version read, not from the 2nd-latest, so a write between the reads cannot pair the latest with
   * itself. A GetObject answer without a VersionId (an unversioned bucket) is paired with the 2nd-latest listed.
   *
   * Throws when the version read is missing from the listing (S3 lists a version once its write returns, so this is
   * not expected): the record is retried rather than judged against a guessed predecessor.
   */
  async getLatestAndPreviousJson<T>(
    key: string,
    currentVersionId?: string,
  ): Promise<{
    current: T | null;
    previous: T | null;
    /** The version returned as `current`: the one named, else the one GetObject returned (absent when unversioned). */
    currentVersionId?: string;
    previousVersionId: string | null;
    /** S3 user metadata of the version returned as `current`. */
    currentMetadata?: Record<string, string>;
    /** When the version returned as `current` was written (its S3 LastModified, ISO time). */
    currentLastModified?: string;
  }> {
    const currentObject = currentVersionId
      ? await this.getJsonObjectWithVersionId<T>(key, currentVersionId)
      : await this.getJsonObject<T>(key);
    if (currentObject.value === null || currentObject.value === undefined) {
      return { current: null, previous: null, previousVersionId: null };
    }

    const readVersionId = currentVersionId ?? currentObject.versionId;
    const contentVersions = (await this.listObjectVersionsForKey(key)).filter((v) => !v.isDeleteMarker);
    let previousVersionId: string | null;
    if (readVersionId) {
      const idx = contentVersions.findIndex((v) => v.versionId === readVersionId);
      if (idx < 0) throw new Error(`Version ${readVersionId} of ${key} is not in its version listing`);
      previousVersionId = contentVersions[idx + 1]?.versionId ?? null;
    } else {
      previousVersionId = contentVersions[1]?.versionId ?? null;
    }

    const previous = previousVersionId ? await this.getJsonWithVersionId<T>(key, previousVersionId) : null;
    return {
      current: currentObject.value,
      previous,
      ...(readVersionId ? { currentVersionId: readVersionId } : {}),
      previousVersionId,
      currentMetadata: currentObject.metadata,
      ...(currentObject.lastModified ? { currentLastModified: currentObject.lastModified } : {}),
    };
  }
}

/**
 * True when S3 refused a conditional write: 412 PreconditionFailed (the ETag no longer matches, or
 * IfNoneMatch found an object) or 409 ConditionalRequestConflict (a concurrent conditional write).
 */
export const isPreconditionFailure = (error: unknown): boolean => {
  const candidate = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } } | null;
  const status = candidate?.$metadata?.httpStatusCode;
  const name = candidate?.name ?? candidate?.Code;
  return status === 412 || status === 409 || name === "PreconditionFailed" || name === "ConditionalRequestConflict";
};

export const isNoSuchKeyError = (error: unknown): boolean => {
  const candidate = error as { Name?: unknown; name?: unknown };
  return candidate.Name === "NoSuchKey" || candidate.name === "NoSuchKey";
};

const isNoSuchVersionError = (error: unknown): boolean => {
  const candidate = error as { Code?: unknown; Name?: unknown; name?: unknown };
  return candidate.Code === "NoSuchVersion" || candidate.Name === "NoSuchVersion" || candidate.name === "NoSuchVersion";
};

const isNotFoundError = (error: unknown): boolean => {
  const candidate = error as { $metadata?: { httpStatusCode?: number }; message?: unknown };
  const status = candidate?.$metadata?.httpStatusCode;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return status === 404 || message.includes("NoSuchVersion") || message.includes("Not Found");
};
