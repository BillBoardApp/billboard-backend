#!/usr/bin/env ts-node

import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Readable } from "node:stream";

import type { RawBill } from "../src/models/bill";
import {
  buildS3WrappedObjectMessage,
  computeCurrentCongressNumber,
  processedBillNeedsVoteProfileReplay,
  rawBillNeedsVoteEnrichmentReplay,
} from "../src/shared/replayCongressVoteProfiles";

type ReplayPhase = "vote-enrichment" | "member-stats" | "both";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BUCKET_NAME = process.env.BUCKET_NAME || "billboard-bill-store-bucket";
const RAW_BILLS_PREFIX = process.env.RAW_BILLS_PREFIX || "raw-bills/";
const PROCESSED_BILLS_PREFIX = process.env.PROCESSED_BILLS_PREFIX || "processed-bills/";
const VOTE_ENRICHMENT_QUEUE_URL = process.env.VOTE_ENRICHMENT_QUEUE_URL || "";
const CONGRESS_MEMBER_STATS_QUEUE_URL = process.env.CONGRESS_MEMBER_STATS_QUEUE_URL || "";
const SQS_BATCH_SIZE = 10;

const args = process.argv.slice(2);
const HELP = args.includes("--help") || args.includes("-h");
const DRY_RUN = args.includes("--dry-run");
const phase = readPhaseFlag();
const congress = readStringFlag("--congress") || String(computeCurrentCongressNumber(new Date()));
const maxItems = readNumberFlag("--max-items");
const rawPrefix = `${RAW_BILLS_PREFIX}BILLS-${congress}`;
const processedPrefix = `${PROCESSED_BILLS_PREFIX}BILLS-${congress}`;

const s3 = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });

function readStringFlag(flagName: string): string | null {
  const index = args.indexOf(flagName);
  if (index === -1) return null;
  const raw = args[index + 1];
  if (!raw || raw.startsWith("--")) {
    throw new Error(`${flagName} requires a value`);
  }
  return raw.trim();
}

function readNumberFlag(flagName: string): number | null {
  const value = readStringFlag(flagName);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} requires a positive integer`);
  }
  return parsed;
}

function readPhaseFlag(): ReplayPhase {
  const value = readStringFlag("--phase");
  if (!value) return "both";
  if (value === "vote-enrichment" || value === "member-stats" || value === "both") {
    return value;
  }
  throw new Error(`Unsupported --phase value: ${value}`);
}

function printHelp(): void {
  console.log("Replay current-congress official vote data without using BillSummarizer/Bedrock.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run replay:member-votes -- --dry-run");
  console.log("  npm run replay:member-votes -- --phase vote-enrichment");
  console.log("  npm run replay:member-votes -- --phase member-stats --congress 119");
  console.log("");
  console.log("Phases:");
  console.log("  vote-enrichment  List raw bills, enqueue only bills missing member vote data.");
  console.log("  member-stats     List processed bills, enqueue only bills that can write vote-profile rows.");
  console.log("  both             Run vote-enrichment first, then member-stats.");
  console.log("");
  console.log("Environment:");
  console.log("  AWS_REGION / AWS_DEFAULT_REGION");
  console.log("  BUCKET_NAME");
  console.log("  RAW_BILLS_PREFIX");
  console.log("  PROCESSED_BILLS_PREFIX");
  console.log("  VOTE_ENRICHMENT_QUEUE_URL");
  console.log("  CONGRESS_MEMBER_STATS_QUEUE_URL");
  console.log("");
  console.log("Notes:");
  console.log("  - This script never enqueues BillSummarizer directly.");
  console.log(
    "  - vote-enrichment still flows through billDiffer, but official-vote-only changes patch processed bills without Bedrock.",
  );
  console.log(
    "  - After a large vote-enrichment replay, a second member-stats pass can help pick up freshly patched processed bills immediately.",
  );
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (typeof key === "string" && key.endsWith(".json")) {
        keys.push(key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys.sort();
}

async function bodyToString(body: unknown): Promise<string> {
  if (!body) throw new Error("Missing S3 object body");
  if (typeof (body as { transformToString?: () => Promise<string> }).transformToString === "function") {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Unsupported S3 body type");
}

async function getJson(key: string): Promise<unknown | null> {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }),
    );
    return JSON.parse(await bodyToString(response.Body));
  } catch (error) {
    console.warn("Skipping key; failed to parse JSON", { key, error });
    return null;
  }
}

function guidFromKey(key: string): string | null {
  const filename = key.split("/").pop();
  if (!filename) return null;
  return filename.replace(/\.json$/i, "") || null;
}

async function sendGuidMessages(queueUrl: string, guids: string[]): Promise<number> {
  let sent = 0;
  for (let index = 0; index < guids.length; index += SQS_BATCH_SIZE) {
    const batch = guids.slice(index, index + SQS_BATCH_SIZE);
    if (DRY_RUN) {
      console.log("DRY RUN vote-enrichment batch", batch);
      sent += batch.length;
      continue;
    }

    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((guid, batchIndex) => ({
          Id: `guid-${index + batchIndex}`,
          MessageBody: JSON.stringify({ guid }),
        })),
      }),
    );

    if ((response.Failed?.length ?? 0) > 0) {
      throw new Error(`Failed to enqueue ${response.Failed?.length ?? 0} vote-enrichment message(s)`);
    }
    sent += response.Successful?.length ?? 0;
  }
  return sent;
}

async function sendProcessedBillKeyMessages(queueUrl: string, keys: string[]): Promise<number> {
  let sent = 0;
  for (let index = 0; index < keys.length; index += SQS_BATCH_SIZE) {
    const batch = keys.slice(index, index + SQS_BATCH_SIZE);
    if (DRY_RUN) {
      console.log("DRY RUN member-stats batch", batch);
      sent += batch.length;
      continue;
    }

    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((key, batchIndex) => ({
          Id: `processed-${index + batchIndex}`,
          MessageBody: buildS3WrappedObjectMessage(BUCKET_NAME, key),
        })),
      }),
    );

    if ((response.Failed?.length ?? 0) > 0) {
      throw new Error(`Failed to enqueue ${response.Failed?.length ?? 0} member-stats message(s)`);
    }
    sent += response.Successful?.length ?? 0;
  }
  return sent;
}

async function collectVoteEnrichmentGuids(): Promise<string[]> {
  const keys = await listKeys(rawPrefix);
  console.log(`Found ${keys.length} raw bill objects under ${rawPrefix}`);

  const guids: string[] = [];
  let scanned = 0;
  for (const key of keys) {
    if (maxItems && scanned >= maxItems) break;
    scanned += 1;

    const payload = await getJson(key);
    if (!payload) continue;

    const rawBill = payload as RawBill;
    if (!rawBillNeedsVoteEnrichmentReplay(rawBill)) continue;

    const guid = guidFromKey(key);
    if (!guid) continue;
    guids.push(guid);
  }

  console.log(`Vote-enrichment replay candidates: ${guids.length} / ${scanned} scanned`);
  return guids;
}

async function collectMemberStatsKeys(): Promise<string[]> {
  const keys = await listKeys(processedPrefix);
  console.log(`Found ${keys.length} processed bill objects under ${processedPrefix}`);

  const replayKeys: string[] = [];
  let scanned = 0;
  for (const key of keys) {
    if (maxItems && scanned >= maxItems) break;
    scanned += 1;

    const payload = await getJson(key);
    if (!payload) continue;
    if (!processedBillNeedsVoteProfileReplay(payload)) continue;
    replayKeys.push(key);
  }

  console.log(`Member-stats replay candidates: ${replayKeys.length} / ${scanned} scanned`);
  return replayKeys;
}

async function main(): Promise<void> {
  if (HELP) {
    printHelp();
    return;
  }

  console.log("Starting congress vote/profile replay");
  console.log(`Region: ${REGION}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Congress: ${congress}`);
  console.log(`Phase: ${phase}`);
  console.log(`Dry run: ${DRY_RUN ? "yes" : "no"}`);
  if (maxItems) console.log(`Max items: ${maxItems}`);

  if ((phase === "vote-enrichment" || phase === "both") && !DRY_RUN && !VOTE_ENRICHMENT_QUEUE_URL) {
    throw new Error("Missing VOTE_ENRICHMENT_QUEUE_URL env var");
  }
  if ((phase === "member-stats" || phase === "both") && !DRY_RUN && !CONGRESS_MEMBER_STATS_QUEUE_URL) {
    throw new Error("Missing CONGRESS_MEMBER_STATS_QUEUE_URL env var");
  }

  let voteReplaySent = 0;
  let memberStatsSent = 0;

  if (phase === "vote-enrichment" || phase === "both") {
    const guids = await collectVoteEnrichmentGuids();
    voteReplaySent = await sendGuidMessages(VOTE_ENRICHMENT_QUEUE_URL, guids);
  }

  if (phase === "member-stats" || phase === "both") {
    const processedKeys = await collectMemberStatsKeys();
    memberStatsSent = await sendProcessedBillKeyMessages(CONGRESS_MEMBER_STATS_QUEUE_URL, processedKeys);
  }

  console.log("Replay complete", {
    congress,
    phase,
    voteReplaySent,
    memberStatsSent,
    dryRun: DRY_RUN,
  });

  if (phase === "both") {
    console.log(
      "Tip: after the vote-enrichment queue drains, rerun with --phase member-stats if you want an immediate second pass over freshly patched processed bills.",
    );
  }
}

main().catch((error) => {
  console.error("Replay failed", error);
  process.exitCode = 1;
});
