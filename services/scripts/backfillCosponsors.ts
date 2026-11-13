#!/usr/bin/env ts-node

// REL-28 backfill. Raw bills fetched before FetchRawBill read every /cosponsors page hold only the first page
// (20 cosponsors), and so do their processed bills, the bills manifest and userMatcher's member matching. This finds
// those raw bills and sends each one to UpdatedBillsQueue (the poller's queue) with the title and identifier stored
// in it. FetchRawBill then fetches the bill again with every page, and billDiffer patches sponsors and cosponsors into
// the processed bill. No Bedrock call is made unless the bill's text changed since its last fetch.

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";

import { BillStorage } from "../src/adapters/billStorage";
import type { RawBill } from "../src/models/bill";
import { isCosponsorListTruncated } from "../src/shared/billSponsors";
import { mapWithConcurrency } from "../src/shared/concurrency";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BUCKET_NAME = process.env.BUCKET_NAME || "billboard-bill-store-bucket";
const RAW_BILLS_PREFIX = process.env.RAW_BILLS_PREFIX || "raw-bills/";
const UPDATED_BILLS_QUEUE_URL = process.env.UPDATED_BILLS_QUEUE_URL || "";
const SQS_BATCH_SIZE = 10;
const READ_CONCURRENCY = 8;
const READ_CHUNK_SIZE = 200;

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--congress", "--guid", "--limit"]);
const SWITCHES = new Set(["--help", "-h", "--dry-run"]);
const HELP = args.includes("--help") || args.includes("-h");
const DRY_RUN = args.includes("--dry-run");

const s3 = new S3Client({ region: REGION });
const sqs = new SQSClient({ region: REGION });
const storage = new BillStorage(s3, BUCKET_NAME);

// The message shape BillsApiPoller sends and FetchRawBill reads, plus bulk (REL-58).
type UpdatedBillMessage = {
  guid: string;
  title: string;
  link: string;
  legislationUrl?: string;
  pubDate: string;
  category?: string;
  description?: string;
  congress: string;
  billType: string;
  billNumber: string;
  // REL-58: FetchRawBill retries a bulk message's failures after a minute, never on the hours-long ladder for
  // congress.gov outages, so nothing this run sends lands after its quiet window closed.
  bulk: true;
};

type Candidate = { key: string; message: UpdatedBillMessage; stored: number; reported: unknown };

// Every argument must be known: an unrecognised one (a typo of --dry-run, say) must not start a real run.
function assertKnownArgs(): void {
  for (let index = 0; index < args.length; index += 1) {
    if (VALUE_FLAGS.has(args[index])) {
      index += 1;
    } else if (!SWITCHES.has(args[index])) {
      throw new Error(`Unknown argument: ${args[index]} (see --help)`);
    }
  }
}

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
  const raw = readStringFlag(flagName);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || parsed <= 0) {
    throw new Error(`${flagName} requires a positive integer`);
  }
  return parsed;
}

function normalizeGuid(guid: string): string {
  return guid.trim().replace(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i, "$1");
}

function printHelp(): void {
  console.log("Re-fetch raw bills whose stored cosponsor list stopped at congress.gov's first page (REL-28).");
  console.log("");
  console.log("Sends each such bill to UpdatedBillsQueue. FetchRawBill re-fetches it (about 8 congress.gov calls)");
  console.log("and billDiffer patches the full sponsor and cosponsor lists into the processed bill without Bedrock.");
  console.log("Run it again after the queue drains: re-fetched bills are complete and no longer selected.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run backfill:cosponsors -- --dry-run --congress 119");
  console.log("  UPDATED_BILLS_QUEUE_URL=<url> npm run backfill:cosponsors -- --guid BILLS-119hr1234");
  console.log("  UPDATED_BILLS_QUEUE_URL=<url> npm run backfill:cosponsors -- --congress 119 --limit 300");
  console.log("");
  console.log("Options:");
  console.log("  --dry-run       List the bills without sending anything (no queue URL needed)");
  console.log("  --congress <n>  Only raw bills whose guid starts with BILLS-<n>");
  console.log("  --guid <guid>   Only this bill");
  console.log("  --limit <n>     Send at most n bills this run");
  console.log("");
  console.log("Environment:");
  console.log("  UPDATED_BILLS_QUEUE_URL (required without --dry-run)");
  console.log("  AWS_REGION / AWS_DEFAULT_REGION, BUCKET_NAME, RAW_BILLS_PREFIX");
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
      if (typeof object.Key === "string" && object.Key.endsWith(".json")) {
        keys.push(object.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys.sort();
}

// The stored metadata goes back unchanged (billDiffer re-summarizes a bill whose metadata.title changed), except the
// guid: an older raw bill's metadata.guid keeps a text-version suffix (BILLS-119hr1181rh), which is never sent on.
export function refetchMessageFor(rawBill: RawBill): UpdatedBillMessage | null {
  const { metadata, identifier } = rawBill;
  const guid = typeof metadata?.guid === "string" ? normalizeGuid(metadata.guid) : "";
  if (!guid || !identifier?.congress || !identifier.billType || !identifier.billNumber) return null;

  return {
    guid,
    title: metadata.title,
    link: metadata.legislationUrl ?? "",
    ...(metadata.legislationUrl ? { legislationUrl: metadata.legislationUrl } : {}),
    pubDate: metadata.pubDate,
    ...(metadata.category ? { category: metadata.category } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    congress: identifier.congress,
    billType: identifier.billType,
    billNumber: identifier.billNumber,
    bulk: true,
  };
}

async function sendMessages(messages: UpdatedBillMessage[]): Promise<number> {
  let sent = 0;
  for (let index = 0; index < messages.length; index += SQS_BATCH_SIZE) {
    const batch = messages.slice(index, index + SQS_BATCH_SIZE);
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: UPDATED_BILLS_QUEUE_URL,
        Entries: batch.map((message, batchIndex) => ({
          Id: `msg-${index + batchIndex}`,
          MessageBody: JSON.stringify(message),
        })),
      }),
    );

    if ((response.Failed?.length ?? 0) > 0) {
      throw new Error(`Failed to enqueue ${response.Failed?.length ?? 0} bill(s); ${sent} were sent before this batch`);
    }
    sent += response.Successful?.length ?? batch.length;
  }
  return sent;
}

async function main(): Promise<void> {
  assertKnownArgs();
  if (HELP) {
    printHelp();
    return;
  }

  const congress = readStringFlag("--congress");
  const guid = readStringFlag("--guid");
  const limit = readNumberFlag("--limit");
  if (congress && !/^\d+$/.test(congress)) throw new Error("--congress requires a number, for example 119");
  if (!DRY_RUN && !UPDATED_BILLS_QUEUE_URL) {
    throw new Error("Missing UPDATED_BILLS_QUEUE_URL env var (or pass --dry-run)");
  }

  const prefix = guid
    ? `${RAW_BILLS_PREFIX}${normalizeGuid(guid)}.json`
    : `${RAW_BILLS_PREFIX}${congress ? `BILLS-${congress}` : ""}`;

  console.log("Starting cosponsor backfill (REL-28)");
  console.log(`Region: ${REGION}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Prefix: ${prefix}`);
  console.log(`Dry run: ${DRY_RUN ? "yes" : "no"}`);
  if (limit) console.log(`Limit: ${limit}`);

  const keys = await listKeys(prefix);
  console.log(`Found ${keys.length} raw bill objects`);

  const candidates: Candidate[] = [];
  let scanned = 0;
  let unreadable = 0;

  for (let start = 0; start < keys.length && !(limit && candidates.length >= limit); start += READ_CHUNK_SIZE) {
    const chunk = keys.slice(start, start + READ_CHUNK_SIZE);
    const results = await mapWithConcurrency(chunk, READ_CONCURRENCY, async (key): Promise<Candidate | null> => {
      let rawBill: RawBill | null;
      try {
        rawBill = await storage.getJson<RawBill>(key);
      } catch (error) {
        unreadable += 1;
        console.warn("Skipping unreadable raw bill", { key, error: String(error) });
        return null;
      }
      if (!rawBill || !isCosponsorListTruncated(rawBill)) return null;

      const message = refetchMessageFor(rawBill);
      if (!message) {
        unreadable += 1;
        console.warn("Skipping raw bill without a guid or identifier", { key });
        return null;
      }
      const wrapper = (rawBill.content?.cosponsors ?? {}) as { cosponsors?: unknown; pagination?: { count?: unknown } };
      const stored = Array.isArray(wrapper.cosponsors) ? wrapper.cosponsors.length : 0;
      return { key, message, stored, reported: wrapper.pagination?.count };
    });

    scanned += chunk.length;
    for (const candidate of results) {
      if (candidate && !(limit && candidates.length >= limit)) candidates.push(candidate);
    }
    console.log(`Scanned ${scanned} / ${keys.length}; ${candidates.length} truncated so far`);
  }

  for (const candidate of candidates) {
    console.log(`${DRY_RUN ? "[dry-run] would re-fetch" : "Re-fetching"} ${candidate.message.guid}`, {
      storedCosponsors: candidate.stored,
      reportedCosponsors: candidate.reported,
    });
  }

  const sent = DRY_RUN ? 0 : await sendMessages(candidates.map((candidate) => candidate.message));

  console.log("Cosponsor backfill complete", {
    scanned,
    truncated: candidates.length,
    sent,
    unreadable,
    dryRun: DRY_RUN,
  });
  if (limit && candidates.length >= limit) {
    console.log("Stopped at --limit; run again once UpdatedBillsQueue has drained to send the next bills.");
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Cosponsor backfill failed", error);
    process.exitCode = 1;
  });
}
