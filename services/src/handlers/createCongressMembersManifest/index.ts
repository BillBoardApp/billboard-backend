import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient, DeleteItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { S3Event, S3EventRecord, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { Readable } from "stream";
import { isNoSuchKeyError } from "../../adapters/billStorage";
import {
  toCongressMemberManifestEntryFromProcessed,
  type CongressMemberManifestEntry,
} from "../../models/congressMember";
import { processSqsRecords } from "../../shared/sqsBatch";

const BUCKET_NAME = process.env.BUCKET_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;
const PRIMARY_KEY = process.env.PRIMARY_KEY!;

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const decodeS3Key = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
};

type S3Delta = { addOrUpdateKeys: string[]; removeKeys: string[] };

/** An S3 event notification as an SQS body carries it; some senders spell Records in lower case. */
type S3NotificationBody = Partial<S3Event> & { records?: S3EventRecord[] };

const extractS3DeltasFromSqsEvent = (event: Pick<SQSEvent, "Records">): S3Delta => {
  const addOrUpdateKeys: string[] = [];
  const removeKeys: string[] = [];

  const records = event?.Records;
  if (!Array.isArray(records)) return { addOrUpdateKeys, removeKeys };

  for (const rec of records) {
    let body: S3NotificationBody;
    try {
      body = typeof rec?.body === "string" ? JSON.parse(rec.body) : ((rec?.body ?? rec) as S3NotificationBody);
    } catch {
      body = rec as S3NotificationBody;
    }

    const s3Records = body?.Records ?? body?.records;
    if (!Array.isArray(s3Records)) continue;

    for (const s3r of s3Records) {
      const keyDecoded = decodeS3Key(s3r?.s3?.object?.key);
      if (!keyDecoded) continue;
      if (!keyDecoded.toLowerCase().startsWith("processed-congress-members/")) continue;
      const eventName = (s3r?.eventName ?? "").toString();
      if (/^ObjectRemoved:/i.test(eventName)) removeKeys.push(keyDecoded);
      else addOrUpdateKeys.push(keyDecoded);
    }
  }

  return { addOrUpdateKeys, removeKeys };
};

const idFromProcessedMemberKey = (key: string): string | null => {
  const match = key.match(/^processed-congress-members\/([^/]+)\.json$/i);
  return match ? match[1] : null;
};

const isConditionalCheckFailed = (err: unknown): boolean => {
  const anyErr = err as { name?: unknown; Code?: unknown } | null | undefined;
  return anyErr?.name === "ConditionalCheckFailedException" || anyErr?.Code === "ConditionalCheckFailedException";
};

type ManifestStats = {
  addFetchProcessed: number;
  addFetchMissing: number;
  removeCount: number;
  upsertsAttempted: number;
  upsertsSucceeded: number;
  upsertsSkipped: number;
  deletesAttempted: number;
  deletesSucceeded: number;
};

const uniqueJsonKeys = (keys: string[]): string[] =>
  Array.from(new Set(keys.filter((k) => typeof k === "string" && k.endsWith(".json"))));

// Throws when the object cannot be read or parsed so the SQS record is retried.
// A missing object is not an error: it was deleted after this event was sent, and its
// ObjectRemoved event removes the row.
const readManifestEntry = async (
  key: string,
  nowIso: string,
  stats: ManifestStats,
): Promise<CongressMemberManifestEntry | null> => {
  let bodyString: string;
  try {
    const getResp = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    bodyString = await streamToString(getResp.Body as Readable);
  } catch (err) {
    if (isNoSuchKeyError(err)) {
      stats.addFetchMissing += 1;
      console.warn("Processed congress member no longer exists; skipping manifest upsert", { key });
      return null;
    }
    throw err;
  }

  const parsed = JSON.parse(bodyString) as unknown;
  const entry = toCongressMemberManifestEntryFromProcessed(parsed, { updatedAtOverride: nowIso });
  if (!entry) {
    console.warn("Processed congress member is missing manifest fields; skipping", { key });
    return null;
  }
  entry.updatedAt = nowIso;
  const bioguideId = entry.bioguideId;
  if (!bioguideId || typeof bioguideId !== "string") return null;
  stats.addFetchProcessed += 1;
  return { ...entry, bioguideId };
};

const upsertManifestEntry = async (entry: CongressMemberManifestEntry, nowIso: string, stats: ManifestStats) => {
  const itemKey = entry.bioguideId;
  if (!itemKey || typeof itemKey !== "string") return;
  stats.upsertsAttempted += 1;
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          [PRIMARY_KEY]: { S: itemKey },
          bioguideId: { S: itemKey },
          name: { S: entry.name ?? "" },
          chamber: { S: entry.chamber ?? "" },
          state: { S: entry.state ?? "" },
          party: { S: entry.party ?? "" },
          district: entry.district == null ? { NULL: true } : { S: String(entry.district) },
          depictionImageUrl: entry.depictionImageUrl == null ? { NULL: true } : { S: entry.depictionImageUrl },
          updatedAt: { S: entry.updatedAt ?? nowIso },
        },
        ConditionExpression: "attribute_not_exists(#pk) OR #updatedAt < :updatedAt",
        ExpressionAttributeNames: { "#pk": PRIMARY_KEY, "#updatedAt": "updatedAt" },
        ExpressionAttributeValues: { ":updatedAt": { S: entry.updatedAt ?? nowIso } },
      }),
    );
    stats.upsertsSucceeded += 1;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      stats.upsertsSkipped += 1;
      return;
    }
    throw err;
  }
};

const deleteManifestEntry = async (id: string, stats: ManifestStats) => {
  stats.deletesAttempted += 1;
  await ddb.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: { [PRIMARY_KEY]: { S: id } },
    }),
  );
  stats.deletesSucceeded += 1;
};

const applyRecord = async (record: SQSRecord, nowIso: string, stats: ManifestStats): Promise<void> => {
  const deltas = extractS3DeltasFromSqsEvent({ Records: [record] });

  for (const key of uniqueJsonKeys(deltas.addOrUpdateKeys)) {
    const entry = await readManifestEntry(key, nowIso, stats);
    if (entry) await upsertManifestEntry(entry, nowIso, stats);
  }

  const removeIds = new Set<string>();
  for (const key of uniqueJsonKeys(deltas.removeKeys)) {
    const id = idFromProcessedMemberKey(key);
    if (id) removeIds.add(id);
  }
  stats.removeCount += removeIds.size;
  for (const id of removeIds) {
    await deleteManifestEntry(id, stats);
  }
};

/** Lambda reads only batchItemFailures; statusCode, headers and body summarise the run for the logs. */
type ManifestUpdateResponse = SQSBatchResponse & { statusCode: number; headers: Record<string, string>; body: string };

export const handler = async (event: SQSEvent): Promise<ManifestUpdateResponse> => {
  const nowIso = new Date().toISOString();
  const deltas = extractS3DeltasFromSqsEvent(event);

  if (uniqueJsonKeys(deltas.addOrUpdateKeys).length === 0 && uniqueJsonKeys(deltas.removeKeys).length === 0) {
    return {
      batchItemFailures: [],
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generatedAt: nowIso, updated: false, addedOrUpdated: 0, deleted: 0 }),
    };
  }

  const stats: ManifestStats = {
    addFetchProcessed: 0,
    addFetchMissing: 0,
    removeCount: 0,
    upsertsAttempted: 0,
    upsertsSucceeded: 0,
    upsertsSkipped: 0,
    deletesAttempted: 0,
    deletesSucceeded: 0,
  };

  // Records are applied one at a time, in batch order. A record whose S3 read or DynamoDB
  // write fails is reported back so SQS redelivers only that record (and dead-letters it
  // after maxReceiveCount) instead of the batch reporting success.
  const { batchItemFailures } = await processSqsRecords(event, (record) => applyRecord(record, nowIso, stats), {
    label: "Failed to apply congress members manifest update",
  });

  // statusCode/body are kept for existing log readers; Lambda only reads batchItemFailures.
  return {
    batchItemFailures,
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      generatedAt: nowIso,
      addedOrUpdated: stats.upsertsSucceeded,
      deleted: stats.deletesSucceeded,
      updated: true,
      writeAttempts: stats.upsertsAttempted + stats.deletesAttempted,
      failedRecords: batchItemFailures.length,
      stats,
    }),
  };
};
