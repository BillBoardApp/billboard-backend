#!/usr/bin/env node

/**
 * Reprocess existing processed bills through the BillSummarizer queue.
 *
 * By default, only enqueues bills whose internalSchema is missing or outdated.
 * Bills that have already been processed with the current schema are skipped.
 *
 * With --missing-civic-profile, only enqueues processed bills whose civicProfile
 * is missing or empty, regardless of internalSchema.
 *
 * How it works:
 *   1. Lists all processed-bill keys in S3 (or uses the single --guid provided)
 *   2. Reads each bill to check its internalSchema or civicProfile
 *   3. Sends { guid } messages to the BillSummarizerQueue for matching bills
 *
 * Usage:
 *   node scripts/reprocessBills.cjs --guid BILLS-119hr1234  # single bill
 *   node scripts/reprocessBills.cjs                         # all outdated bills
 *   node scripts/reprocessBills.cjs --since 2026-01-01            # outdated bills from Jan 1, 2026 onward
 *   node scripts/reprocessBills.cjs --missing-civic-profile       # only bills missing civicProfile
 *   node scripts/reprocessBills.cjs --missing-civic-profile --dry-run
 *   node scripts/reprocessBills.cjs --dry-run                     # preview without sending
 *   node scripts/reprocessBills.cjs --force                       # reprocess ALL bills regardless of schema/civicProfile
 */

const cp = require("child_process");

const BUCKET = "billboard-bill-store-bucket";
const QUEUE_NAME = "BillSummarizerQueue";
const PREFIX = "processed-bills/";
// Keep in sync with src/models/bill.ts where schema 2 added civicProfile.
const CURRENT_INTERNAL_SCHEMA = 2;
const SQS_BATCH_SIZE = 10; // SQS SendMessageBatch max
const CHECK_BATCH_SIZE = 20; // How many bills to check at a time before enqueuing
const REGION = "us-east-1";

const run = (cmd, args) => cp.execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8" }).trim();

const runAsync = (cmd, args) =>
  new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { stdio: "pipe", encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });

/**
 * Extract the GUID from an S3 key.
 * Keys look like: processed-bills/BILLS-119hr2312.json
 */
const guidFromKey = (key) => {
  const filename = key.split("/").pop();
  if (!filename) return null;
  return filename.replace(/\.json$/, "");
};

/**
 * Resolve the full SQS queue URL from the queue name.
 */
const getQueueUrl = () => {
  return run("aws", [
    "sqs",
    "get-queue-url",
    "--queue-name",
    QUEUE_NAME,
    "--region",
    REGION,
    "--query",
    "QueueUrl",
    "--output",
    "text",
    "--no-cli-pager",
  ]);
};

/**
 * Read a processed bill from S3 and return a parsed metadata summary.
 */
const getProcessedBillMetadata = async (key) => {
  try {
    const body = await runAsync("aws", [
      "s3api",
      "get-object",
      "--bucket",
      BUCKET,
      "--key",
      key,
      "--region",
      REGION,
      "--no-cli-pager",
      "/dev/stdout",
    ]);
    // The output may include metadata after the JSON — extract just the JSON
    const jsonEnd = body.lastIndexOf("}");
    const jsonStr = body.substring(0, jsonEnd + 1);
    const parsed = JSON.parse(jsonStr);
    const civicProfile = parsed?.civicProfile;
    const hasCivicProfile =
      !!civicProfile &&
      typeof civicProfile === "object" &&
      !Array.isArray(civicProfile) &&
      Object.keys(civicProfile).length > 0;

    return {
      internalSchema: parsed.internalSchema ?? null,
      hasCivicProfile,
    };
  } catch {
    return {
      internalSchema: null,
      hasCivicProfile: false,
    };
  }
};

/**
 * Send a single message to SQS (used for --guid mode).
 */
const sendSingleMessage = (queueUrl, guid) => {
  return run("aws", [
    "sqs",
    "send-message",
    "--queue-url",
    queueUrl,
    "--message-body",
    JSON.stringify({ guid }),
    "--region",
    REGION,
    "--no-cli-pager",
  ]);
};

/**
 * Send a batch of messages to SQS. Returns { success, failed } counts.
 */
const sendBatch = (queueUrl, guids) => {
  const entries = guids.map((guid, idx) => ({
    Id: `msg-${idx}`,
    MessageBody: JSON.stringify({ guid }),
  }));

  const result = run("aws", [
    "sqs",
    "send-message-batch",
    "--queue-url",
    queueUrl,
    "--entries",
    JSON.stringify(entries),
    "--region",
    REGION,
    "--no-cli-pager",
  ]);

  const parsed = JSON.parse(result);
  return {
    success: (parsed.Successful || []).length,
    failed: (parsed.Failed || []).length,
    failures: parsed.Failed || [],
  };
};

/**
 * Parse CLI args for a named flag value (e.g. --guid BILLS-119hr1234).
 */
const parseFlagArg = (args, flag) => {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    console.error(`Error: ${flag} requires a value (e.g. ${flag} BILLS-119hr1234)`);
    process.exit(1);
  }
  return value;
};

const parseSinceArg = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.error(`Error: --since requires a valid date, for example --since 2026-01-01`);
    process.exit(1);
  }
  return parsed;
};

const chunkArray = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const USAGE = [
  "Usage: node scripts/reprocessBills.cjs [--dry-run] [--guid <guid> | --since <date> | --missing-civic-profile | --force]",
  "",
  "Re-queues processed bills to BillSummarizerQueue; each message costs one Bedrock call.",
  "",
  "  (no filter)              bills whose internalSchema is missing or outdated",
  "  --guid <guid>            one bill",
  "  --since <date>           outdated bills from this date onward",
  "  --missing-civic-profile  bills whose civicProfile is missing or empty",
  "  --force                  every bill",
  "  --dry-run                list what would be sent without sending",
  "  --help                   print this help",
].join("\n");

// Every argument must be known: an unrecognised one (`--help`, a typo of --dry-run) must not start a real run.
const assertKnownArgs = (args) => {
  const switches = new Set(["--dry-run", "--force", "--missing-civic-profile"]);
  const valueFlags = new Set(["--guid", "--since"]);
  for (let index = 0; index < args.length; index += 1) {
    if (valueFlags.has(args[index])) index += 1;
    else if (!switches.has(args[index])) {
      console.error(`Error: unknown argument ${args[index]}\n\n${USAGE}`);
      process.exit(1);
    }
  }
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  assertKnownArgs(args);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const missingCivicProfileOnly = args.includes("--missing-civic-profile");
  const singleGuid = parseFlagArg(args, "--guid");
  const sinceDate = parseSinceArg(parseFlagArg(args, "--since"));

  // ── Single-bill mode ──────────────────────────────────────────────
  if (singleGuid) {
    console.log(`Reprocessing single bill: ${singleGuid}`);

    if (dryRun) {
      console.log("DRY RUN — would enqueue:", JSON.stringify({ guid: singleGuid }));
      return;
    }

    const queueUrl = getQueueUrl();
    console.log(`Queue URL: ${queueUrl}`);

    try {
      const result = sendSingleMessage(queueUrl, singleGuid);
      const parsed = JSON.parse(result);
      console.log(`✓ Enqueued ${singleGuid} (MessageId: ${parsed.MessageId})`);
      console.log(`\nThe BillSummarizer Lambda will pick it up shortly.`);
      console.log("Monitor progress in CloudWatch Logs for the BillSummarizer Lambda.");
    } catch (err) {
      console.error(`✗ Failed to enqueue ${singleGuid}:`, err.message);
      process.exit(1);
    }
    return;
  }

  // ── All-bills mode ────────────────────────────────────────────────
  if (dryRun) {
    console.log("DRY RUN — will not send messages.\n");
  }
  if (force) {
    console.log("FORCE MODE — reprocessing all bills regardless of internalSchema/civicProfile.\n");
  }
  if (missingCivicProfileOnly) {
    console.log("FILTER MODE — only considering processed bills whose civicProfile is missing.\n");
  }
  if (sinceDate) {
    console.log(`DATE FILTER — only considering processed bills updated on or after ${sinceDate.toISOString()}.\n`);
  }

  // Resolve queue URL up front
  let queueUrl;
  if (!dryRun) {
    console.log(`Resolving queue URL for ${QUEUE_NAME}...`);
    queueUrl = getQueueUrl();
    console.log(`Queue URL: ${queueUrl}\n`);
  }

  console.log(`Listing all objects in s3://${BUCKET}/${PREFIX}...`);

  const listOutput = run("aws", [
    "s3api",
    "list-objects-v2",
    "--bucket",
    BUCKET,
    "--prefix",
    PREFIX,
    "--query",
    "Contents[].{Key: Key, LastModified: LastModified}",
    "--output",
    "json",
    "--region",
    REGION,
    "--no-cli-pager",
  ]);

  const listedObjects = JSON.parse(listOutput).filter((entry) => entry?.Key?.endsWith(".json"));
  const filteredObjects = sinceDate
    ? listedObjects.filter((entry) => {
        const lastModified = new Date(entry.LastModified);
        return !Number.isNaN(lastModified.getTime()) && lastModified >= sinceDate;
      })
    : listedObjects;
  const allKeys = filteredObjects.map((entry) => entry.Key);

  console.log(`Found ${listedObjects.length} processed bills in S3.`);
  if (sinceDate) {
    console.log(`Filtered to ${allKeys.length} processed bills on/after ${sinceDate.toISOString()}.`);
  }

  if (allKeys.length === 0) {
    console.log("Nothing to reprocess.");
    return;
  }

  // Check each bill and collect matching GUIDs
  if (missingCivicProfileOnly) {
    console.log("\nChecking for missing civicProfile...");
  } else {
    console.log(`\nChecking internalSchema (target: ${CURRENT_INTERNAL_SCHEMA})...`);
  }

  let checked = 0;
  let upToDate = 0;
  let withCivicProfile = 0;
  let sent = 0;
  let failed = 0;
  const pendingGuids = []; // Buffer for batch sending

  for (const keyBatch of chunkArray(allKeys, CHECK_BATCH_SIZE)) {
    const batchResults = await Promise.all(
      keyBatch.map(async (key) => {
        const guid = guidFromKey(key);
        if (!guid) return null;

        if (force) {
          return { guid, shouldReprocess: true };
        }

        const metadata = await getProcessedBillMetadata(key);
        if (missingCivicProfileOnly) {
          return {
            guid,
            shouldReprocess: !metadata.hasCivicProfile,
            hasCivicProfile: metadata.hasCivicProfile,
          };
        }

        return {
          guid,
          shouldReprocess: metadata.internalSchema < CURRENT_INTERNAL_SCHEMA,
          isUpToDate: metadata.internalSchema >= CURRENT_INTERNAL_SCHEMA,
        };
      }),
    );

    for (const result of batchResults) {
      if (!result?.guid) continue;
      checked++;

      if (!force) {
        if (missingCivicProfileOnly) {
          if (result.hasCivicProfile) {
            withCivicProfile++;
            if (checked % 50 === 0) {
              console.log(
                `  [${checked}/${allKeys.length}] Checked... (${withCivicProfile} already have civicProfile, ${pendingGuids.length + sent} missing civicProfile)`,
              );
            }
            continue;
          }
        } else if (result.isUpToDate) {
          upToDate++;
          if (checked % 50 === 0) {
            console.log(
              `  [${checked}/${allKeys.length}] Checked... (${upToDate} up-to-date, ${pendingGuids.length + sent} need reprocessing)`,
            );
          }
          continue;
        }
      }

      pendingGuids.push(result.guid);

      if (pendingGuids.length >= SQS_BATCH_SIZE) {
        const batch = pendingGuids.splice(0, SQS_BATCH_SIZE);
        console.log(
          `  Enqueuing ${batch.length} ${missingCivicProfileOnly ? "bills missing civicProfile" : "outdated bills"}: ${batch.join(", ")}`,
        );

        if (!dryRun) {
          try {
            const sendResult = sendBatch(queueUrl, batch);
            sent += sendResult.success;
            if (sendResult.failed > 0) {
              console.error(`    ⚠ ${sendResult.failed} message(s) failed:`, JSON.stringify(sendResult.failures));
              failed += sendResult.failed;
            }
          } catch (err) {
            console.error(`    ✗ Failed to enqueue batch:`, err.message);
            failed += batch.length;
          }
        } else {
          sent += batch.length;
        }
      }
    }
  }

  // Flush remaining
  if (pendingGuids.length > 0) {
    console.log(
      `  Enqueuing ${pendingGuids.length} ${missingCivicProfileOnly ? "bills missing civicProfile" : "outdated bills"}: ${pendingGuids.join(", ")}`,
    );

    if (!dryRun) {
      try {
        const result = sendBatch(queueUrl, pendingGuids);
        sent += result.success;
        if (result.failed > 0) {
          console.error(`    ⚠ ${result.failed} message(s) failed:`, JSON.stringify(result.failures));
          failed += result.failed;
        }
      } catch (err) {
        console.error(`    ✗ Failed to enqueue batch:`, err.message);
        failed += pendingGuids.length;
      }
    } else {
      sent += pendingGuids.length;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Reprocessing complete!${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`  Total bills checked: ${checked}`);
  if (missingCivicProfileOnly) {
    console.log(`  Already have civicProfile: ${withCivicProfile}`);
    console.log(`  Missing civicProfile:      ${sent}`);
  } else {
    console.log(`  Already up-to-date:  ${upToDate}`);
  }
  console.log(`  Enqueued:            ${sent}`);
  if (failed > 0) {
    console.log(`  Failed to enqueue:   ${failed}`);
  }
  console.log(`${"=".repeat(60)}`);

  if (!dryRun && sent > 0) {
    console.log(`\nMessages are now in ${QUEUE_NAME}.`);
    console.log("The BillSummarizer Lambda will pick them up automatically.");
    console.log("Monitor progress in CloudWatch Logs for the BillSummarizer Lambda.");
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
