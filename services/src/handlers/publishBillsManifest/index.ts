import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, type Hash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  activeCompanionPairs,
  BillCompanionDao,
  billCompanionConfigFromEnv,
  type CompanionGroupsState,
} from "../../adapters/billCompanionDao";
import type { BillsManifestV1 as BillsManifest } from "../../contracts";
import {
  companionGroupsFromPairs,
  parseBillGuid,
  resolveCompanionGroups,
  type CompanionPair,
} from "../../shared/billCompanions";
import { buildBillsManifest, billsManifestSourceFromEnv } from "../../shared/billsManifestBuilder";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { putMetrics, type MetricUnit } from "../../shared/metrics";

// Publishes the full bills manifest to S3 as one gzip JSON object (CAP-01). Runs on a schedule
// and can be invoked directly (any payload). fetchBillsManifest hands clients a presigned URL for
// this object instead of returning the whole manifest in a Lambda response.
//
// The object is rewritten only when its content changed: its sha256 metadata is a SHA-256 of the
// serialized bills array followed by the companionGroups JSON (not generatedAt), and a run whose
// hash matches the current object's skips the write, so the snapshot keeps the generatedAt of the
// build that last changed it. Errors are thrown so the invocation fails and the Lambda error alarm
// sees it.
//
// Companion groups (APPF-23): each run also reads every companion link list, pairs the bills held
// in this manifest (shared/billCompanions.ts) and, only when the pairs or the flag changed, writes
// them as the versioned CURRENT row the API readers serve. With COMPANION_GROUPS_ENABLED other than
// "true" the published pairs are [] and the resolved count is only reported (CompanionGroupsShadow).
// A failure there never stops the snapshot: it is logged, counted (CompanionResolveFailed) and the
// stored CURRENT pairs (or none) are published instead, so the snapshot matches what the API readers
// serve. With the flag off, an enabled CURRENT is first switched off even though resolution failed.

export const METRIC_NAMESPACE = "BillBoard/BillsManifest";
export const DEFAULT_SNAPSHOT_KEY = "bills/manifest-v1.json";
export const SNAPSHOT_CACHE_CONTROL = "private, max-age=60";

// JSON is fed to the hash and gzip in pieces of about this many characters, so the full
// manifest never exists as one string or one uncompressed buffer.
const CHUNK_CHARS = 64 * 1024;

const ddb = new DynamoDBClient({});
const manifestSource = billsManifestSourceFromEnv(ddb);
const companionDao = new BillCompanionDao(ddb, billCompanionConfigFromEnv());

let s3: S3Client | undefined;
const s3Client = (): S3Client => (s3 ??= new S3Client({}));

export interface SerializedSnapshot {
  /** gzip of JSON.stringify(manifest). */
  body: Buffer;
  /** Hex SHA-256 of JSON.stringify(manifest.bills), followed by JSON.stringify(manifest.companionGroups) when present. */
  sha256: string;
  /** Bytes of the uncompressed JSON. */
  jsonBytes: number;
}

export interface PublishSummary {
  bucket: string;
  key: string;
  outcome: "written" | "unchanged";
  count: number;
  /** generatedAt of the snapshot now in S3 (on "unchanged", the earlier build that wrote it). */
  generatedAt: string;
  sha256: string;
  gzippedBytes: number;
  jsonBytes: number;
  durationMs: number;
}

/**
 * Yields JSON.stringify(manifest) byte for byte ({ generatedAt, count, bills[, companionGroups] },
 * the key order the builder creates) and feeds the bills array, then the companionGroups JSON, to
 * `billsHash`, so a change to the groups alone changes the hash.
 */
function* snapshotJsonChunks(manifest: BillsManifest, billsHash: Hash): Generator<string> {
  yield `{"generatedAt":${JSON.stringify(manifest.generatedAt)},"count":${JSON.stringify(manifest.count)},"bills":`;
  const { bills } = manifest;
  let chunk = "[";
  for (let index = 0; index < bills.length; index += 1) {
    chunk += (index === 0 ? "" : ",") + JSON.stringify(bills[index]);
    if (chunk.length >= CHUNK_CHARS) {
      billsHash.update(chunk);
      yield chunk;
      chunk = "";
    }
  }
  chunk += "]";
  billsHash.update(chunk);
  yield chunk;
  if (manifest.companionGroups !== undefined) {
    const groupsJson = JSON.stringify(manifest.companionGroups);
    billsHash.update(groupsJson);
    yield `,"companionGroups":${groupsJson}`;
  }
  yield "}";
}

/** Gzips the manifest JSON and hashes its bills array in one streaming pass. */
export const serializeBillsManifestSnapshot = async (manifest: BillsManifest): Promise<SerializedSnapshot> => {
  const billsHash = createHash("sha256");
  let jsonBytes = 0;
  const counted = function* (): Generator<string> {
    for (const chunk of snapshotJsonChunks(manifest, billsHash)) {
      jsonBytes += Buffer.byteLength(chunk);
      yield chunk;
    }
  };

  const parts: Buffer[] = [];
  let gzippedBytes = 0;
  await pipeline(Readable.from(counted()), createGzip(), async (source: AsyncIterable<Buffer>) => {
    for await (const part of source) {
      parts.push(part);
      gzippedBytes += part.length;
    }
  });

  return { body: Buffer.concat(parts, gzippedBytes), sha256: billsHash.digest("hex"), jsonBytes };
};

const isNotFound = (error: unknown): boolean => {
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return (
    candidate?.name === "NotFound" || candidate?.name === "NoSuchKey" || candidate?.$metadata?.httpStatusCode === 404
  );
};

/** The current object's metadata, or null when there is no object yet. Other S3 errors propagate. */
const currentSnapshotMetadata = async (bucket: string, key: string): Promise<Record<string, string> | null> => {
  try {
    const head = await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.Metadata ?? {};
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
};

interface MetricEntry {
  name: string;
  value: number;
  unit?: MetricUnit;
}

interface CompanionPublication {
  /** The pairs to publish in the snapshot. */
  pairs: CompanionPair[];
  metrics: MetricEntry[];
}

const pairId = ([primary, other]: readonly [string, string]): string => `${primary}|${other}`;

const samePairs = (a: readonly CompanionPair[], b: readonly CompanionPair[]): boolean =>
  a.length === b.length && a.every((pair, index) => pairId(pair) === pairId(b[index]));

/** The plain guids of the manifest's rows; suffixed legacy rows never count as held. */
const heldGuidsOf = (manifest: BillsManifest): Set<string> => {
  const held = new Set<string>();
  for (const bill of manifest.bills) {
    const parsed = parseBillGuid(bill.guid);
    if (parsed && parsed.suffix === "") held.add(parsed.plainGuid);
  }
  return held;
};

// CURRENT write attempts: the first, plus one retry after a version conflict.
const MAX_CURRENT_WRITE_ATTEMPTS = 2;

/**
 * Rewrites an enabled CURRENT as disabled with no pairs, keeping its last resolved counts, and returns
 * the row readers now see (on a version conflict, the one another writer stored). Throws on errors.
 */
const switchOffCurrentGroups = async (stored: CompanionGroupsState): Promise<CompanionGroupsState | null> => {
  const result = await companionDao.putCurrentGroups(
    {
      enabled: false,
      pairs: [],
      groupCount: 0,
      ambiguousCount: stored.ambiguousCount,
      oneSidedCount: stored.oneSidedCount,
      declarationCount: stored.declarationCount,
      resolvedAt: new Date().toISOString(),
    },
    stored.pairsVersion,
  );
  if (result.outcome === "conflict") return companionDao.getCurrentGroups({ maxAgeMs: 0 });
  logger.info("Companion groups CURRENT switched off without a resolution", { pairsVersion: result.pairsVersion });
  return null;
};

/**
 * Resolves the companion groups of `manifest`, writes CURRENT when the pairs or the flag changed,
 * and returns the pairs to publish plus their metrics. Never throws.
 */
const publishCompanionGroups = async (manifest: BillsManifest): Promise<CompanionPublication> => {
  const enabled = process.env.COMPANION_GROUPS_ENABLED === "true";
  let current: CompanionGroupsState | null | undefined;
  try {
    const declarations = await companionDao.listDeclarations();
    const held = heldGuidsOf(manifest);
    const resolution = resolveCompanionGroups(declarations, (guid) => held.has(guid));
    const published = enabled ? resolution.pairs : [];

    let previous: CompanionPair[] = [];
    let written = false;
    for (let attempt = 1; ; attempt += 1) {
      current = await companionDao.getCurrentGroups({ maxAgeMs: 0 });
      previous = activeCompanionPairs(current);
      if (current && current.enabled === enabled && samePairs(current.pairs, published)) break;
      const result = await companionDao.putCurrentGroups(
        {
          enabled,
          pairs: published,
          groupCount: published.length,
          ambiguousCount: resolution.ambiguous.length,
          oneSidedCount: resolution.oneSided,
          declarationCount: declarations.length,
          resolvedAt: new Date().toISOString(),
        },
        current?.pairsVersion ?? null,
      );
      if (result.outcome === "written") {
        written = true;
        logger.info("Companion groups CURRENT written", {
          pairsVersion: result.pairsVersion,
          enabled,
          groups: published.length,
        });
        break;
      }
      if (attempt >= MAX_CURRENT_WRITE_ATTEMPTS) {
        throw new Error("Companion groups CURRENT changed while publishing, twice");
      }
      logger.warn("Companion groups CURRENT changed while publishing; re-reading and retrying once", {
        expectedVersion: current?.pairsVersion ?? null,
      });
    }

    const previousIds = new Set(previous.map(pairId));
    const publishedIds = new Set(published.map(pairId));
    const added = published.filter((pair) => !previousIds.has(pairId(pair))).length;
    const removed = previous.filter((pair) => !publishedIds.has(pairId(pair))).length;
    logger.info("Companion groups resolved", {
      enabled,
      declarations: declarations.length,
      held: held.size,
      resolved: resolution.pairs.length,
      published: published.length,
      added,
      removed,
      ambiguous: resolution.ambiguous,
      oneSided: resolution.oneSided,
      excluded: resolution.excluded,
      currentWritten: written,
    });
    return {
      pairs: published,
      metrics: [
        { name: "CompanionGroups", value: published.length },
        { name: "CompanionGroupsAdded", value: added },
        { name: "CompanionGroupsRemoved", value: removed },
        { name: "CompanionAmbiguous", value: resolution.ambiguous.length },
        { name: "CompanionOneSided", value: resolution.oneSided },
        { name: "CompanionGroupsShadow", value: resolution.pairs.length },
        { name: "CompanionResolveFailed", value: 0 },
      ],
    };
  } catch (error) {
    // The snapshot must show what the API readers serve: CURRENT's pairs. With the flag off, CURRENT
    // is switched off here first, since resolution may keep failing and rollback must not wait for it.
    let stored: CompanionGroupsState | null | undefined = current;
    try {
      stored ??= await companionDao.getCurrentGroups({ maxAgeMs: 0 });
      if (!enabled && stored?.enabled) stored = await switchOffCurrentGroups(stored);
    } catch (fallbackError) {
      logger.warn("Could not read or switch off the stored companion groups", { error: fallbackError });
    }
    const fallback = activeCompanionPairs(stored);
    logger.error("Companion group resolution failed; publishing the stored groups", {
      error,
      fallbackGroups: fallback.length,
    });
    return {
      pairs: fallback,
      metrics: [
        { name: "CompanionGroups", value: fallback.length },
        { name: "CompanionResolveFailed", value: 1 },
      ],
    };
  }
};

export const handler = async (_event?: unknown, context?: LambdaContextLike): Promise<PublishSummary> => {
  logger.resetContext(context);
  const startedAt = Date.now();

  const bucket = process.env.MANIFEST_SNAPSHOT_BUCKET?.trim();
  if (!bucket) throw new Error("Missing env var MANIFEST_SNAPSHOT_BUCKET");
  const key = process.env.MANIFEST_SNAPSHOT_KEY?.trim() || DEFAULT_SNAPSHOT_KEY;

  const built = await buildBillsManifest(manifestSource);
  const companions = await publishCompanionGroups(built);
  const manifest: BillsManifest = { ...built, companionGroups: companionGroupsFromPairs(companions.pairs) };
  const { count, generatedAt } = manifest;
  const { body, sha256, jsonBytes } = await serializeBillsManifestSnapshot(manifest);

  const current = await currentSnapshotMetadata(bucket, key);
  const unchanged = current?.sha256 === sha256;

  if (!unchanged) {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        ContentEncoding: "gzip",
        CacheControl: SNAPSHOT_CACHE_CONTROL,
        Metadata: { "generated-at": generatedAt, count: String(count), sha256 },
      }),
    );
  }

  const summary: PublishSummary = {
    bucket,
    key,
    outcome: unchanged ? "unchanged" : "written",
    count,
    generatedAt: unchanged ? (current?.["generated-at"] ?? generatedAt) : generatedAt,
    sha256,
    gzippedBytes: body.length,
    jsonBytes,
    durationMs: Date.now() - startedAt,
  };

  await putMetrics(METRIC_NAMESPACE, [
    { name: "SnapshotBillCount", value: count },
    { name: "SnapshotGzipBytes", value: body.length, unit: "Bytes" },
    { name: "SnapshotWritten", value: unchanged ? 0 : 1 },
    { name: "SnapshotUnchanged", value: unchanged ? 1 : 0 },
    ...companions.metrics,
  ]);
  logger.info(unchanged ? "Bills manifest snapshot unchanged" : "Bills manifest snapshot written", { ...summary });
  return summary;
};
