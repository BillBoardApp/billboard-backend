import { createHash } from "node:crypto";
import type {
  GetObjectCommandInput,
  HeadObjectCommandInput,
  ListObjectVersionsCommandInput,
  ListObjectsV2CommandInput,
  PutObjectCommandInput,
} from "@aws-sdk/client-s3";

/**
 * An in-memory, versioned S3 bucket for tests that drive real handlers against stored state (REL-30).
 * Commands are the plain objects the mocked @aws-sdk/client-s3 constructors in mockS3Module return.
 *
 * - Every put adds a version with a VersionId, an ETag (MD5 of the body, quoted, as S3 gives it), a
 *   LastModified one second after the previous write, and its user metadata. putAt gives a version a LastModified
 *   of its own (S3 lists in whole seconds, so two versions can share one).
 * - deleteObject adds a delete marker; a GET without VersionId then answers NoSuchKey.
 * - PutObject honours IfMatch (412 when the current ETag differs, 404 when there is no current
 *   object) and IfNoneMatch "*" (412 when a current object exists; a delete marker counts as none).
 * - injectPutError(key, status) makes the next put to that key fail (409 ConditionalRequestConflict,
 *   412 PreconditionFailed, or any status) before any check.
 * - afterGet / beforePut hooks run inside the call (afterGet also after a GET that finds nothing), so
 *   a test can land another writer between two reads of a handler, or between its read and its
 *   write. Each hook is removed before it runs.
 */

export interface FakeVersion {
  versionId: string;
  body: string;
  etag: string;
  lastModified: Date;
  metadata?: Record<string, string>;
  deleteMarker: boolean;
}

/** The input of any command the fake answers, in S3's own field names. */
export type FakeS3Input = Partial<
  GetObjectCommandInput &
    HeadObjectCommandInput &
    PutObjectCommandInput &
    ListObjectVersionsCommandInput &
    ListObjectsV2CommandInput
>;

export interface FakeS3Command {
  __cmd: "GetObject" | "HeadObject" | "PutObject" | "ListObjectVersions" | "ListObjectsV2";
  input: FakeS3Input;
}

type Hook = (key: string, input: FakeS3Input) => void | Promise<void>;

interface ListedEntry {
  Key: string;
  VersionId: string;
  IsLatest: boolean;
  LastModified: Date;
}

const s3Error = (name: string, status: number, message = name): Error =>
  Object.assign(new Error(message), { name, Code: name, $metadata: { httpStatusCode: status } });

export const preconditionFailed = (): Error =>
  s3Error("PreconditionFailed", 412, "At least one of the pre-conditions you specified did not hold");
export const conditionalRequestConflict = (): Error =>
  s3Error("ConditionalRequestConflict", 409, "A conflicting conditional operation is currently in progress");

export class FakeVersionedS3 {
  /** Versions per key, newest first. */
  readonly objects = new Map<string, FakeVersion[]>();
  /** Every command received, in order. */
  readonly calls: FakeS3Command[] = [];
  private clock: number;
  private seq = 0;
  private readonly afterGetHooks: Array<{ key: string | RegExp; hook: Hook }> = [];
  private readonly beforePutHooks: Array<{ key: string | RegExp; hook: Hook }> = [];
  private readonly putErrors = new Map<string, Error[]>();

  constructor(startAt = "2026-02-01T21:20:00.000Z") {
    this.clock = Date.parse(startAt);
  }

  // ── Direct access for tests ───────────────────────────────────────────────

  /** Stores a version (no conditions) and returns its VersionId. */
  put(key: string, value: unknown, metadata?: Record<string, string>): string {
    return this.addVersion(key, typeof value === "string" ? value : JSON.stringify(value), metadata, false).versionId;
  }

  /** Stores a version with this LastModified (the clock does not move), and its metadata, and returns its VersionId. */
  putAt(key: string, value: unknown, lastModified: string, metadata?: Record<string, string>): string {
    const version = this.addVersion(key, typeof value === "string" ? value : JSON.stringify(value), metadata, false);
    this.clock -= 1000;
    version.lastModified = new Date(lastModified);
    return version.versionId;
  }

  /** Adds a delete marker as the current version. */
  deleteObject(key: string): string {
    return this.addVersion(key, "", undefined, true).versionId;
  }

  /** Versions of a key, newest first (delete markers included). */
  versions(key: string): FakeVersion[] {
    return this.objects.get(key) ?? [];
  }

  /** Content versions of a key, newest first (delete markers left out). */
  contentVersions(key: string): FakeVersion[] {
    return this.versions(key).filter((version) => !version.deleteMarker);
  }

  /** The current version, or undefined when the key is missing or its latest version is a delete marker. */
  current(key: string): FakeVersion | undefined {
    const latest = this.versions(key)[0];
    return latest && !latest.deleteMarker ? latest : undefined;
  }

  /** The current version's parsed body, or undefined. */
  json<T = unknown>(key: string): T | undefined {
    const current = this.current(key);
    return current ? (JSON.parse(current.body) as T) : undefined;
  }

  /** Commands of one kind for one key (or every key when omitted). */
  commands(kind: FakeS3Command["__cmd"], key?: string): FakeS3Command[] {
    return this.calls.filter(
      (call) => call.__cmd === kind && (key === undefined || call.input.Key === key || call.input.Prefix === key),
    );
  }

  /** Runs once, right after the next GET of a matching key has picked its version and before it returns. */
  afterGet(key: string | RegExp, hook: Hook): void {
    this.afterGetHooks.push({ key, hook });
  }

  /** Runs once, right before the next PUT to a matching key checks its conditions. */
  beforePut(key: string | RegExp, hook: Hook): void {
    this.beforePutHooks.push({ key, hook });
  }

  /** The next put to `key` fails with this status (409 ConditionalRequestConflict by default). */
  injectPutError(key: string, status = 409): void {
    const error =
      status === 409
        ? conditionalRequestConflict()
        : status === 412
          ? preconditionFailed()
          : s3Error("InternalError", status);
    this.putErrors.set(key, [...(this.putErrors.get(key) ?? []), error]);
  }

  // ── The S3 client ─────────────────────────────────────────────────────────

  async send(command: FakeS3Command) {
    this.calls.push(command);
    const input = command.input ?? {};
    switch (command.__cmd) {
      case "GetObject":
        return this.getObject(input);
      case "HeadObject":
        return this.headObject(input);
      case "PutObject":
        return this.putObject(input);
      case "ListObjectVersions":
        return this.listObjectVersions(input);
      case "ListObjectsV2":
        return this.listObjectsV2(input);
      default:
        throw new Error(`FakeVersionedS3: unexpected command ${(command as { __cmd?: string }).__cmd}`);
    }
  }

  private addVersion(key: string, body: string, metadata: Record<string, string> | undefined, deleteMarker: boolean) {
    this.clock += 1000;
    this.seq += 1;
    const version: FakeVersion = {
      versionId: `v${String(this.seq).padStart(4, "0")}`,
      body,
      etag: deleteMarker ? "" : `"${createHash("md5").update(body).digest("hex")}"`,
      lastModified: new Date(this.clock),
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata: { ...metadata } } : {}),
      deleteMarker,
    };
    this.objects.set(key, [version, ...this.versions(key)]);
    return version;
  }

  private takeHook(hooks: Array<{ key: string | RegExp; hook: Hook }>, key: string): Hook | undefined {
    const index = hooks.findIndex((entry) => (typeof entry.key === "string" ? entry.key === key : entry.key.test(key)));
    if (index < 0) return undefined;
    const [entry] = hooks.splice(index, 1);
    return entry.hook;
  }

  private async getObject(input: FakeS3Input) {
    const key = String(input.Key);
    const versions = this.versions(key);
    // The version is chosen before the hook runs, as S3 would have answered already.
    const found = input.VersionId
      ? versions.find((version) => version.versionId === input.VersionId)
      : this.current(key);
    const hook = this.takeHook(this.afterGetHooks, key);
    if (hook) await hook(key, input);
    if (input.VersionId) {
      if (!found) throw s3Error("NoSuchVersion", 404, "The specified version does not exist.");
      if (found.deleteMarker)
        throw s3Error("MethodNotAllowed", 405, "The specified method is not allowed against this resource.");
    } else if (!found) {
      throw s3Error("NoSuchKey", 404, "The specified key does not exist.");
    }
    const body = found.body;
    return {
      Body: { transformToString: async () => body },
      ETag: found.etag,
      VersionId: found.versionId,
      LastModified: found.lastModified,
      ...(found.metadata ? { Metadata: { ...found.metadata } } : {}),
    };
  }

  private headObject(input: FakeS3Input) {
    const key = String(input.Key);
    const found = input.VersionId
      ? this.versions(key).find((version) => version.versionId === input.VersionId)
      : this.current(key);
    if (!found || found.deleteMarker) throw s3Error("NotFound", 404, "Not Found");
    return {
      ETag: found.etag,
      VersionId: found.versionId,
      LastModified: found.lastModified,
      ...(found.metadata ? { Metadata: { ...found.metadata } } : {}),
    };
  }

  private async putObject(input: FakeS3Input) {
    const key = String(input.Key);
    const hook = this.takeHook(this.beforePutHooks, key);
    if (hook) await hook(key, input);
    const queued = this.putErrors.get(key);
    if (queued && queued.length > 0) {
      const error = queued.shift()!;
      if (queued.length === 0) this.putErrors.delete(key);
      throw error;
    }
    const current = this.current(key);
    if (input.IfMatch !== undefined) {
      if (!current) throw s3Error("NoSuchKey", 404, "The specified key does not exist.");
      if (current.etag !== input.IfMatch) throw preconditionFailed();
    }
    if (input.IfNoneMatch !== undefined && current) throw preconditionFailed();
    const version = this.addVersion(key, String(input.Body), input.Metadata, false);
    return { ETag: version.etag, VersionId: version.versionId };
  }

  private listObjectVersions(input: FakeS3Input) {
    const prefix = String(input.Prefix ?? "");
    const Versions: Array<ListedEntry & { ETag: string; Size: number }> = [];
    const DeleteMarkers: ListedEntry[] = [];
    for (const [key, versions] of this.objects) {
      if (!key.startsWith(prefix)) continue;
      versions.forEach((version, index) => {
        const entry = {
          Key: key,
          VersionId: version.versionId,
          IsLatest: index === 0,
          LastModified: version.lastModified,
        };
        if (version.deleteMarker) DeleteMarkers.push(entry);
        else Versions.push({ ...entry, ETag: version.etag, Size: version.body.length });
      });
    }
    return { IsTruncated: false, Versions, DeleteMarkers };
  }

  private listObjectsV2(input: FakeS3Input) {
    const prefix = String(input.Prefix ?? "");
    const Contents = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && this.current(key))
      .sort()
      .map((key) => ({ Key: key, ETag: this.current(key)!.etag, LastModified: this.current(key)!.lastModified }));
    return { IsTruncated: false, Contents, KeyCount: Contents.length };
  }
}

/**
 * The module to return from `jest.mock("@aws-sdk/client-s3", ...)`: every client sends to the fake
 * `getFake()` returns at call time.
 *
 *   let mockS3: FakeVersionedS3;
 *   jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));
 */
export const mockS3Module = (getFake: () => FakeVersionedS3) => {
  const command = (name: FakeS3Command["__cmd"]) =>
    jest.fn().mockImplementation((input: FakeS3Input) => ({ __cmd: name, input }));
  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: (cmd: FakeS3Command) => getFake().send(cmd) })),
    GetObjectCommand: command("GetObject"),
    HeadObjectCommand: command("HeadObject"),
    PutObjectCommand: command("PutObject"),
    ListObjectVersionsCommand: command("ListObjectVersions"),
    ListObjectsV2Command: command("ListObjectsV2"),
  };
};
