#!/usr/bin/env node

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { BillStorage } from "../src/adapters/billStorage";
import type { ProcessedBillDocument } from "../src/models/bill";
import { deriveBillStatusFromActions } from "../src/shared/billOutcomes";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BUCKET_NAME = process.env.BUCKET_NAME || "billboard-bill-store-bucket";
const PROCESSED_BILLS_PREFIX = process.env.PROCESSED_BILLS_PREFIX || "processed-bills/";
const PROGRESS_INTERVAL = 250;
const MANAGED_STATUSES = new Set(["", "New", "Passed", "Failed"]);

const args = process.argv.slice(2);
const HELP = args.includes("--help") || args.includes("-h");
const DRY_RUN = args.includes("--dry-run");
const MAX_ITEMS = readNumberFlag("--max-items");
const GUID = readStringFlag("--guid");
const CONGRESS = readStringFlag("--congress");

const s3 = new S3Client({ region: REGION });
const storage = new BillStorage(s3, BUCKET_NAME);

type Stats = {
  scanned: number;
  changed: number;
  unchanged: number;
  skipped: number;
  failed: number;
};

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
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} requires a positive integer`);
  }
  return parsed;
}

function normalizeGuid(guid: string): string {
  return guid.trim().replace(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i, "$1");
}

function buildListPrefix(): string {
  if (GUID) {
    return `${PROCESSED_BILLS_PREFIX}${normalizeGuid(GUID)}`;
  }
  if (CONGRESS) {
    return `${PROCESSED_BILLS_PREFIX}BILLS-${CONGRESS}`;
  }
  return PROCESSED_BILLS_PREFIX;
}

function shouldIncludeKey(key: string): boolean {
  if (!key.endsWith(".json")) return false;
  if (GUID) {
    const normalizedGuid = normalizeGuid(GUID);
    return key.endsWith(`/${normalizedGuid}.json`) || key === `${PROCESSED_BILLS_PREFIX}${normalizedGuid}.json`;
  }
  return key.startsWith(PROCESSED_BILLS_PREFIX);
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
      if (typeof key === "string" && shouldIncludeKey(key)) {
        keys.push(key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys.sort();
}

function printHelp(): void {
  console.log("Backfill processed billStatus values from existing processed-bill actions.");
  console.log("");
  console.log("This is a deterministic maintenance script. It does not call Bedrock.");
  console.log("It rewrites processed bill JSON only when the derived billStatus changes.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run backfill:bill-status -- --dry-run");
  console.log("  npm run backfill:bill-status -- --guid BILLS-119hr500is");
  console.log("  npm run backfill:bill-status -- --congress 119 --max-items 500");
  console.log("");
  console.log("Options:");
  console.log("  --dry-run       Preview changes without writing to S3");
  console.log("  --guid <guid>   Limit to a single processed bill");
  console.log("  --congress <n>  Limit to bills whose guid starts with BILLS-<n>");
  console.log("  --max-items <n> Stop after scanning n processed bills");
  console.log("");
  console.log("Environment overrides:");
  console.log("  AWS_REGION / AWS_DEFAULT_REGION");
  console.log("  BUCKET_NAME");
  console.log("  PROCESSED_BILLS_PREFIX");
}

async function main(): Promise<void> {
  if (HELP) {
    printHelp();
    return;
  }

  const prefix = buildListPrefix();

  console.log("Starting processed billStatus backfill");
  console.log(`Region: ${REGION}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Prefix: ${prefix}`);
  console.log(`Dry run: ${DRY_RUN ? "yes" : "no"}`);
  if (GUID) console.log(`GUID filter: ${normalizeGuid(GUID)}`);
  if (CONGRESS) console.log(`Congress filter: ${CONGRESS}`);
  if (MAX_ITEMS) console.log(`Max items: ${MAX_ITEMS}`);
  console.log("Notification safety: this script only rewrites billStatus; no new actions are introduced.");

  const keys = await listKeys(prefix);
  console.log(`Found ${keys.length} processed bill objects to inspect`);

  const stats: Stats = {
    scanned: 0,
    changed: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };

  for (const key of keys) {
    if (MAX_ITEMS && stats.scanned >= MAX_ITEMS) break;
    stats.scanned += 1;

    if (
      stats.scanned % PROGRESS_INTERVAL === 0 ||
      stats.scanned === keys.length ||
      (MAX_ITEMS && stats.scanned === MAX_ITEMS)
    ) {
      const target = MAX_ITEMS ? Math.min(MAX_ITEMS, keys.length) : keys.length;
      console.log(`Scanned ${stats.scanned} / ${target} processed bills...`);
    }

    try {
      const document = await storage.getJson<ProcessedBillDocument>(key);
      if (!document || document.kind !== "processed") {
        stats.skipped += 1;
        console.warn("Skipping non-processed or unreadable document", { key });
        continue;
      }

      const nextStatus = deriveBillStatusFromActions(document.actions);
      const previousStatus = typeof document.billStatus === "string" ? document.billStatus.trim() : "";

      if (!MANAGED_STATUSES.has(previousStatus)) {
        stats.skipped += 1;
        console.warn("Skipping bill with non-outcome status during outcome backfill", {
          key,
          guid: document.guid,
          status: previousStatus,
        });
        continue;
      }

      if (previousStatus === nextStatus) {
        stats.unchanged += 1;
        continue;
      }

      stats.changed += 1;
      console.log(`${DRY_RUN ? "[dry-run] would update" : "Updating"} ${document.guid}`, {
        key,
        from: previousStatus || "(missing)",
        to: nextStatus,
      });

      if (!DRY_RUN) {
        await storage.putJson(key, {
          ...document,
          billStatus: nextStatus,
        });
      }
    } catch (error) {
      stats.failed += 1;
      console.warn("Failed to process bill during backfill", {
        key,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  console.log("");
  console.log("Processed billStatus backfill complete");
  console.log(`  Scanned: ${stats.scanned}`);
  console.log(`  Changed: ${stats.changed}`);
  console.log(`  Unchanged: ${stats.unchanged}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Failed: ${stats.failed}`);
  console.log("");
  console.log(
    "Next step: regenerate manifests if your environment does not already do so from processed-bill write events.",
  );
}

main().catch((error) => {
  console.error("Processed billStatus backfill failed", error);
  process.exit(1);
});
