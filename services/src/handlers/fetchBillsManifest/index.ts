import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { activeCompanionPairs, BillCompanionDao, billCompanionConfigFromEnv } from "../../adapters/billCompanionDao";
import type { BillsManifestSnapshotPointerV1 as BillsManifestSnapshotPointer, CompanionGroupV1 } from "../../contracts";
import { companionGroupsFromPairs } from "../../shared/billCompanions";
import {
  buildBillsManifest,
  billsManifestSourceFromEnv,
  normalizeUpdatedAfter,
} from "../../shared/billsManifestBuilder";
import { logger, type LambdaContextLike } from "../../shared/logger";
import { emitEmbeddedMetric } from "../../shared/metrics";
import { isSyntheticEvent } from "../../shared/syntheticEvent";

// GET /bills-manifest. Without updatedAfter this is the full manifest, which no longer fits a
// Lambda response at production size (CAP-01), so a client that sends delivery=snapshot gets a
// BillsManifestSnapshotPointer instead: a short-lived presigned URL for the gzip snapshot that
// publishBillsManifest writes to S3. If the snapshot cannot be offered (bucket not configured,
// object missing, bad metadata, S3 or presign error) the full manifest is returned inline as
// before. Requests without delivery=snapshot, and every windowed (updatedAfter) request, are
// answered inline exactly as before, so older app builds keep working.
//
// Every inline answer (full or windowed) also carries companionGroups (APPF-23): the complete list
// of companion groups PublishBillsManifest last published ([] when there are none or they are
// disabled), read at most every 60 s. If that read fails the field is left out, which tells the app
// to keep the list it has. The snapshot pointer is unchanged; the snapshot carries its own list.

export const METRIC_NAMESPACE = "BillBoard/BillsManifest";
export const DEFAULT_SNAPSHOT_KEY = "bills/manifest-v1.json";
/** Lifetime of the presigned snapshot URL. */
export const SNAPSHOT_URL_TTL_SECONDS = 300;

/** How long a read of the published companion groups is reused. */
export const COMPANION_GROUPS_MAX_AGE_MS = 60_000;

const ddb = new DynamoDBClient({});
const manifestSource = billsManifestSourceFromEnv(ddb);
const companionDao = new BillCompanionDao(ddb, billCompanionConfigFromEnv());

let s3: S3Client | undefined;
const s3Client = (): S3Client => (s3 ??= new S3Client({}));

const JSON_HEADERS = { "Content-Type": "application/json" };

/** An API Gateway GET, or a direct invoke: a synthetic test event, or one passing `updatedAfter` at the top level. */
type ManifestRequestEvent = Partial<APIGatewayProxyEvent> & { updatedAfter?: string };

type SnapshotFallbackReason = "not-configured" | "missing" | "invalid-metadata" | "error";

interface SnapshotMetadata {
  generatedAt: string;
  count: number;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** generated-at and count from the snapshot's S3 metadata (keys arrive lower-cased), or null if unusable. */
const parseSnapshotMetadata = (metadata: Record<string, string> | undefined): SnapshotMetadata | null => {
  const generatedAt = metadata?.["generated-at"]?.trim() ?? "";
  const countRaw = metadata?.["count"]?.trim() ?? "";
  if (!ISO_DATE_TIME.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) return null;
  if (!/^\d+$/.test(countRaw)) return null;
  const count = Number(countRaw);
  if (!Number.isSafeInteger(count)) return null;
  return { generatedAt, count };
};

const isNotFound = (error: unknown): boolean => {
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  return (
    candidate?.name === "NotFound" || candidate?.name === "NoSuchKey" || candidate?.$metadata?.httpStatusCode === 404
  );
};

// The pointer metrics are embedded-metric-format log lines, so no request waits on PutMetricData.
const fallBackToInline = (reason: SnapshotFallbackReason, data: Record<string, unknown> = {}): null => {
  logger.warn("Bills manifest snapshot unavailable; returning the manifest inline", { reason, ...data });
  emitEmbeddedMetric(METRIC_NAMESPACE, "SnapshotPointerFallback", 1);
  return null;
};

/** A pointer to the current snapshot, or null (after logging and counting the fallback) to serve inline. */
const snapshotPointer = async (): Promise<BillsManifestSnapshotPointer | null> => {
  const bucket = process.env.MANIFEST_SNAPSHOT_BUCKET?.trim();
  const key = process.env.MANIFEST_SNAPSHOT_KEY?.trim() || DEFAULT_SNAPSHOT_KEY;
  if (!bucket) return fallBackToInline("not-configured");

  try {
    const head = await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const metadata = parseSnapshotMetadata(head.Metadata);
    if (!metadata) return fallBackToInline("invalid-metadata", { bucket, key });

    // Signed with only the host header, so a plain GET with no other headers works until expiresAt.
    const signedAt = new Date();
    const snapshotUrl = await getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: SNAPSHOT_URL_TTL_SECONDS,
      signingDate: signedAt,
    });
    const pointer: BillsManifestSnapshotPointer = {
      snapshotUrl,
      generatedAt: metadata.generatedAt,
      count: metadata.count,
      expiresAt: new Date(signedAt.getTime() + SNAPSHOT_URL_TTL_SECONDS * 1000).toISOString(),
    };

    // The URL carries a signature and session token: never log it.
    logger.info("Serving bills manifest snapshot pointer", {
      bucket,
      key,
      generatedAt: pointer.generatedAt,
      count: pointer.count,
      expiresAt: pointer.expiresAt,
    });
    emitEmbeddedMetric(METRIC_NAMESPACE, "SnapshotPointerServed", 1);
    return pointer;
  } catch (error) {
    return fallBackToInline(isNotFound(error) ? "missing" : "error", { bucket, key, error });
  }
};

/** The published companion groups for an inline answer, or undefined (field left out) when they cannot be read. */
const readCompanionGroups = async (): Promise<CompanionGroupV1[] | undefined> => {
  try {
    const state = await companionDao.getCurrentGroups({ maxAgeMs: COMPANION_GROUPS_MAX_AGE_MS });
    return companionGroupsFromPairs(activeCompanionPairs(state));
  } catch (error) {
    logger.warn("Could not read the companion groups; answering without companionGroups", { error });
    emitEmbeddedMetric(METRIC_NAMESPACE, "CompanionGroupsReadFailed", 1);
    return undefined;
  }
};

export async function handler(
  event?: ManifestRequestEvent,
  context?: LambdaContextLike,
): Promise<APIGatewayProxyResult> {
  logger.resetContext(context);

  if (isSyntheticEvent(event)) {
    logger.info("Synthetic health check", { synthetic: true });
    return {
      statusCode: 200,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ status: "healthy", synthetic: true }),
    };
  }

  try {
    const updatedAfter = normalizeUpdatedAfter(event?.queryStringParameters?.updatedAfter ?? event?.updatedAfter);

    if (!updatedAfter && event?.queryStringParameters?.delivery === "snapshot") {
      const pointer = await snapshotPointer();
      if (pointer) {
        return {
          statusCode: 200,
          // The URL expires, so the pointer must not be cached.
          headers: { ...JSON_HEADERS, "Cache-Control": "no-store" },
          body: JSON.stringify(pointer),
        };
      }
    }

    const companionGroups = await readCompanionGroups();
    const manifest = await buildBillsManifest(manifestSource, { updatedAfter, companionGroups });
    return {
      statusCode: 200,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(manifest),
    };
  } catch (error) {
    logger.error("Failed to build the bills manifest", { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
