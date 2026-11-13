#!/usr/bin/env node

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BUCKET = "billboard-bill-store-bucket";
// Invoke the released alias, not $LATEST, so a backfill never runs unreleased code mid-canary.
const FUNCTION_NAME = "CreateBillsManifest:prod";
const PREFIX = "processed-bills/";
const BATCH_SIZE = 5; // Reduced from 10 to lower DDB read pressure
const DELAY_BETWEEN_BATCHES_MS = 2000; // 2 second delay between batches
const REGION = "us-east-1";
// Above CreateBillsManifest's 120-second timeout. With the CLI's default of 60 seconds a slow invoke is
// retried while it still runs, so its keys are processed (and, with --forward, forwarded) twice.
const INVOKE_READ_TIMEOUT_SECONDS = 180;
// The S3 listing prints every key; execFileSync's default 1 MB buffer holds only about 20,000 of them.
const MAX_CLI_OUTPUT_BYTES = 64 * 1024 * 1024;
const FAILED_KEYS_FILE_PREFIX = "backfill-bills-manifest-failed-";

const EXIT_CODES = { ok: 0, failed: 1, preflightRefused: 2 };

// A direct invoke with no records: the handler returns at once, writing and forwarding nothing, and a
// release that honours rows-only answers with "forward":false in its body.
const PREFLIGHT_EVENT = { Records: [], forward: false };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USAGE = [
  "Usage: npm run backfill:bills-manifest -- [--dry-run] [--forward] [--keys-file <path>] [<batch>]",
  "",
  `Invokes ${FUNCTION_NAME} for every ${PREFIX} key, ${BATCH_SIZE} keys per invoke, and writes the BillsManifest`,
  "rows only: nothing is forwarded to NotificationTypeQueue or CongressMemberStatsQueue, so no quiet window is",
  "needed. A preflight invoke first checks that the released code honours this and stops with exit code 2",
  "when it does not (an older release would forward every key).",
  "",
  "  <batch>             Resume at this batch number (a positive integer)",
  `  --keys-file <path>  Process only the keys in this file, one ${PREFIX}...json key per line (for example`,
  "                      the failed-keys file of an earlier run), instead of listing S3",
  "  --forward           Also forward each key to NotificationTypeQueue and CongressMemberStatsQueue, as",
  "                      before this option existed. This can push old news to users again: quiet",
  "                      notifications first (docs/RUNBOOK.md section 4.1)",
  "  --dry-run           List the keys and the batches without invoking anything",
  "  --help              Print this help",
  "",
  `Keys that fail are written to ${FAILED_KEYS_FILE_PREFIX}<UTC timestamp>.txt in the current directory and the`,
  "summary prints the command that reruns them. Exit codes: 0 every key succeeded; 1 a key failed, or a usage",
  "or listing error; 2 the released code does not write rows only (the preflight, or a batch answered without",
  '"forward":false).',
].join("\n");

const isProcessedBillKey = (key) => typeof key === "string" && key.startsWith(PREFIX) && key.endsWith(".json");

// Every argument must be known: before this check `--help` or `--dry-run` parsed as batch NaN and ran
// the full backfill.
const parseArgs = (argv) => {
  const options = { help: false, dryRun: false, forward: false, keysFile: null, startFromBatch: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--forward") options.forward = true;
    else if (arg === "--keys-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new Error(`--keys-file needs a path\n\n${USAGE}`);
      options.keysFile = value;
      i += 1;
    } else if (/^[1-9]\d*$/.test(arg)) options.startFromBatch = Number.parseInt(arg, 10);
    else throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  return options;
};

/** The keys of a keys file, in file order: blank lines are skipped and a repeated key is kept once. */
const parseKeysFile = (text) => {
  const keys = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach((line, index) => {
    const key = line.trim();
    if (!key) return;
    if (!isProcessedBillKey(key)) {
      throw new Error(`Line ${index + 1} of the keys file is not a ${PREFIX}...json key: ${key}`);
    }
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  });
  return keys;
};

const messageIdFor = (index) => `backfill-${index}`;

/** An SQS-shaped event for keys[0..] at overall positions firstIndex.., with the forward flag. */
const buildInvokeEvent = (keys, firstIndex, forward) => ({
  Records: keys.map((key, idx) => ({
    messageId: messageIdFor(firstIndex + idx),
    receiptHandle: "backfill",
    body: JSON.stringify({
      Records: [{ s3: { object: { key } } }],
    }),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: Date.now().toString(),
      SenderId: "backfill",
      ApproximateFirstReceiveTimestamp: Date.now().toString(),
    },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "",
    awsRegion: REGION,
  })),
  forward,
});

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const truncate = (text, max = 300) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}...` : value;
};

/**
 * Reads one invoke: `metadata` is the CLI's output (StatusCode, FunctionError, ExecutedVersion) and
 * `response` the function's response, from the outfile. `error` is set when the invoke failed as a
 * whole: a function error, a status other than 200, or output that cannot be read.
 */
const readInvoke = ({ metadata, response }) => {
  const meta = parseJson(metadata);
  if (!meta || typeof meta !== "object") return { error: `unreadable CLI output: ${truncate(metadata)}`, meta: null };
  if (meta.FunctionError) {
    return { error: `function error (${meta.FunctionError}): ${truncate(response)}`, meta };
  }
  if (meta.StatusCode !== 200) return { error: `invoke status ${meta.StatusCode}`, meta };
  const payload = parseJson(response);
  if (!payload || typeof payload !== "object") {
    return { error: `unreadable function response: ${truncate(response)}`, meta };
  }
  const body = typeof payload.body === "string" ? (parseJson(payload.body) ?? null) : null;
  return { error: null, meta, payload, body };
};

/**
 * The keys of one batch that failed, for keys sent at overall positions firstIndex... A failed invoke
 * fails every key. Otherwise each batchItemFailures[].itemIdentifier (backfill-<index>) names one failed
 * key, and only the other keys succeeded. A response without a batchItemFailures list, or naming a record
 * that is not in the batch, fails every key, because it does not say which keys were written (rerunning
 * a written key only rewrites its row). `body` is the handler's summary when the invoke returned one.
 */
const failedKeysFromInvoke = (keys, firstIndex, invoke) => {
  const read = readInvoke(invoke);
  if (read.error) return { failedKeys: [...keys], error: read.error, body: null };
  const failures = read.payload.batchItemFailures;
  if (!Array.isArray(failures)) {
    return { failedKeys: [...keys], error: "the response has no batchItemFailures list", body: read.body };
  }
  const keyById = new Map(keys.map((key, idx) => [messageIdFor(firstIndex + idx), key]));
  const failedIds = new Set();
  for (const failure of failures) {
    const id = failure?.itemIdentifier;
    if (!keyById.has(id)) {
      return { failedKeys: [...keys], error: `unknown itemIdentifier ${JSON.stringify(id)}`, body: read.body };
    }
    failedIds.add(id);
  }
  return {
    failedKeys: keys.filter((_key, idx) => failedIds.has(messageIdFor(firstIndex + idx))),
    error: null,
    body: read.body,
  };
};

/** Accepts the preflight invoke only when the response body says "forward":false. */
const preflightCheck = (invoke) => {
  const read = readInvoke(invoke);
  if (read.error) return { accepted: false, reason: read.error, version: read.meta?.ExecutedVersion ?? null };
  const version = read.meta.ExecutedVersion ?? null;
  if (read.body?.forward !== false) {
    return {
      accepted: false,
      reason: `the response body does not say "forward":false: ${truncate(read.payload.body)}`,
      version,
    };
  }
  return { accepted: true, reason: null, version };
};

/** backfill-bills-manifest-failed-20261007T203000Z.txt for 2026-10-07T20:30:00.123Z. */
const failedKeysFileName = (date) =>
  `${FAILED_KEYS_FILE_PREFIX}${date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}.txt`;

const defaultDeps = {
  execFile: (cmd, args) =>
    cp.execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", maxBuffer: MAX_CLI_OUTPUT_BYTES }).trim(),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  writeFile: (file, text) => fs.writeFileSync(file, text),
  makeTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), "backfill-bills-manifest-")),
  removeDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  sleep,
  now: () => new Date(),
  cwd: () => process.cwd(),
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
};

const listProcessedBillKeys = (deps) => {
  const output = deps.execFile("aws", [
    "s3api",
    "list-objects-v2",
    "--bucket",
    BUCKET,
    "--prefix",
    PREFIX,
    "--query",
    "Contents[].Key",
    "--output",
    "json",
    "--region",
    REGION,
    "--no-cli-pager",
  ]);
  // The query prints null when the prefix holds no objects.
  return (JSON.parse(output) ?? []).filter(isProcessedBillKey);
};

/**
 * Invokes the function synchronously. The payload is read from a file and the response written to
 * another, so the CLI's metadata (stdout) and the function's response never mix.
 */
const invokeFunction = (event, deps) => {
  const dir = deps.makeTempDir();
  try {
    const payloadFile = path.join(dir, "payload.json");
    const responseFile = path.join(dir, "response.json");
    deps.writeFile(payloadFile, JSON.stringify(event));
    const metadata = deps.execFile("aws", [
      "lambda",
      "invoke",
      "--function-name",
      FUNCTION_NAME,
      "--payload",
      `file://${payloadFile}`,
      "--cli-binary-format",
      "raw-in-base64-out",
      "--cli-read-timeout",
      String(INVOKE_READ_TIMEOUT_SECONDS),
      "--region",
      REGION,
      "--output",
      "json",
      "--no-cli-pager",
      responseFile,
    ]);
    return { metadata, response: deps.readFile(responseFile) };
  } finally {
    deps.removeDir(dir);
  }
};

const rerunCommand = (forward, keysFile, startFromBatch) =>
  [
    "npm run backfill:bills-manifest --",
    ...(forward ? ["--forward"] : []),
    ...(keysFile ? ["--keys-file", JSON.stringify(keysFile)] : []),
    ...(startFromBatch > 1 ? [String(startFromBatch)] : []),
  ].join(" ");

/** Runs the backfill and returns its exit code (EXIT_CODES). Usage and listing errors throw. */
async function main(argv, deps = defaultDeps) {
  const { log, error } = deps;
  const { help, dryRun, forward, keysFile, startFromBatch } = parseArgs(argv);
  if (help) {
    log(USAGE);
    return EXIT_CODES.ok;
  }
  const startedAt = deps.now();
  log(
    forward
      ? "Mode: --forward. Every key is also forwarded to NotificationTypeQueue and CongressMemberStatsQueue: quiet notifications first (docs/RUNBOOK.md section 4.1)."
      : "Mode: rows only. BillsManifest rows are written; nothing is forwarded.",
  );
  if (dryRun) {
    log("DRY RUN: nothing will be invoked.");
  }
  // Support resuming from a specific batch
  if (startFromBatch > 1) {
    log(`Resuming from batch ${startFromBatch}...`);
  }

  let allKeys;
  if (keysFile) {
    log(`Reading keys from ${keysFile}...`);
    allKeys = parseKeysFile(deps.readFile(keysFile));
    log(`Found ${allKeys.length} keys in the file.`);
  } else {
    log(`Listing all objects in s3://${BUCKET}/${PREFIX}...`);
    allKeys = listProcessedBillKeys(deps);
    log(`Found ${allKeys.length} processed bill keys.`);
  }

  if (allKeys.length === 0) {
    log("Nothing to backfill.");
    return EXIT_CODES.ok;
  }

  if (!dryRun && !forward) {
    log(`Preflight: invoking ${FUNCTION_NAME} with ${JSON.stringify(PREFLIGHT_EVENT)}...`);
    let check;
    try {
      check = preflightCheck(invokeFunction(PREFLIGHT_EVENT, deps));
    } catch (err) {
      check = { accepted: false, reason: `invoke failed: ${err?.message ?? err}`, version: null };
    }
    if (!check.accepted) {
      error(`Preflight refused: ${check.reason}`);
      error(
        `The released ${FUNCTION_NAME} does not write rows only; an older release would forward every key. Nothing was backfilled.`,
      );
      return EXIT_CODES.preflightRefused;
    }
    log(`Preflight passed: ${FUNCTION_NAME} (version ${check.version ?? "unknown"}) writes rows only.`);
  }

  // Batch keys and invoke the Lambda for each batch
  let succeeded = 0;
  let skipped = 0;
  let stoppedAtBatch = null;
  const failedKeys = [];
  const totalBatches = Math.ceil(allKeys.length / BATCH_SIZE);

  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    const batch = allKeys.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    // Skip batches before the resume point
    if (batchNum < startFromBatch) {
      skipped += batch.length;
      continue;
    }

    if (dryRun) {
      log(`[${batchNum}/${totalBatches}] [dry-run] would invoke ${FUNCTION_NAME} with`, batch);
      continue;
    }
    log(`[${batchNum}/${totalBatches}] Processing batch (${batch.length} keys)...`);

    let result;
    try {
      result = failedKeysFromInvoke(batch, i, invokeFunction(buildInvokeEvent(batch, i, forward), deps));
    } catch (err) {
      result = { failedKeys: [...batch], error: `invoke failed: ${err?.message ?? err}`, body: null };
    }
    failedKeys.push(...result.failedKeys);
    succeeded += batch.length - result.failedKeys.length;
    if (result.error) {
      error(`  ✗ Batch ${batchNum} failed (${result.error}): all ${batch.length} keys counted as failed`);
    } else if (result.failedKeys.length > 0) {
      error(`  ✗ ${result.failedKeys.length} of ${batch.length} keys failed: ${result.failedKeys.join(", ")}`);
    }
    if (result.body) {
      // Kept: rewritten at the row's own date, the version having brought no news (RUNBOOK 4.9); a release from
      // before 2026-10-14 reports none.
      log(
        `  ✓ Added: ${result.body.addedOrUpdated ?? 0}, Skipped: ${result.body.stats?.upsertsSkipped ?? 0}, ` +
          `Kept date: ${result.body.stats?.upsertsKeptDate ?? 0}`,
      );
    }

    // The preflight is checked once; a deploy or rollback during a long run can bring back a release that
    // ignores the flag, and every later batch would then be forwarded.
    if (!forward && result.body && result.body.forward !== false) {
      stoppedAtBatch = batchNum;
      break;
    }

    // Add delay between batches to avoid overwhelming DynamoDB
    if (i + BATCH_SIZE < allKeys.length) {
      await deps.sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  log(`\n${"=".repeat(60)}`);
  if (dryRun) log("Dry run complete; nothing was invoked.");
  else if (stoppedAtBatch !== null) log(`Backfill STOPPED at batch ${stoppedAtBatch}.`);
  else log("Backfill complete!");
  log(`  Mode: ${forward ? "--forward" : "rows only"}`);
  if (skipped > 0) {
    log(`  Skipped (resume): ${skipped} keys`);
  }
  log(`  Successfully processed: ${succeeded} keys`);
  log(`  Failed: ${failedKeys.length} keys`);
  log(`  Total batches: ${totalBatches}`);
  log(`${"=".repeat(60)}`);

  if (failedKeys.length > 0) {
    const failedFile = path.resolve(deps.cwd(), failedKeysFileName(startedAt));
    deps.writeFile(failedFile, `${failedKeys.join("\n")}\n`);
    log(`\nFailed keys written to ${failedFile}`);
    log("To rerun only them, run:");
    log(`  ${rerunCommand(forward, failedFile, 1)}`);
  }

  if (stoppedAtBatch !== null) {
    error(
      `\nBatch ${stoppedAtBatch} was answered without "forward":false: the released ${FUNCTION_NAME} no longer writes rows only (a deploy or rollback during the run?). Its rows were written and its keys were probably forwarded. Check the release before going on.`,
    );
    log("To resume after the batch that stopped the run, run:");
    log(`  ${rerunCommand(forward, keysFile, stoppedAtBatch + 1)}`);
    return EXIT_CODES.preflightRefused;
  }
  return failedKeys.length > 0 ? EXIT_CODES.failed : EXIT_CODES.ok;
}

/** main() with errors (usage, keys file, listing) reported and turned into exit code 1. */
const run = async (argv, deps = defaultDeps) => {
  try {
    return await main(argv, deps);
  } catch (err) {
    deps.error(err?.message ?? err);
    return EXIT_CODES.failed;
  }
};

module.exports = {
  EXIT_CODES,
  PREFLIGHT_EVENT,
  defaultDeps,
  parseArgs,
  parseKeysFile,
  buildInvokeEvent,
  failedKeysFromInvoke,
  preflightCheck,
  failedKeysFileName,
  main,
  run,
};

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
