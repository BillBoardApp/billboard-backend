// Read-only ops check: validates every stored processed bill against processed-bill.v1.
//
//   AWS_PROFILE=billboard AWS_REGION=us-east-1 npm run validate:live
//
// Lists processed-bills/*.json in the bill store bucket (ListObjectsV2), GETs each object and validates it with
// the same ajv setup as check-contracts.mjs. Prints the counts (with the keys under the prefix that are not
// processed-bills/<name>.json, which are skipped), the most common error paths and the failing keys. It writes
// nothing, locally or in AWS.
//
// Exit codes:
//   0  every listed bill downloaded and validated
//   1  a bill failed to validate or to download
//   2  the AWS SDK is missing or the bucket cannot be listed
//   3  a schema failed to load or compile (nothing was downloaded)
//   4  nothing was validated: no key matched processed-bills/<name>.json, or every download failed
//
// Environment: BILL_STORE_BUCKET (default billboard-bill-store-bucket), AWS_REGION (default us-east-1),
// VALIDATE_CONCURRENCY (default 16). Credentials come from the default AWS chain, so set AWS_PROFILE=billboard
// (after `aws sso login --profile billboard` when the profile uses SSO).
//
// The AWS SDK is taken from services/node_modules (run `npm ci` in services/ first), so contracts/ keeps no AWS
// dependency of its own.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contractsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_FILE = "schemas/entities/processed-bill.v1.schema.json";
const PREFIX = "processed-bills/";
const KEY_PATTERN = /^processed-bills\/[^/]+\.json$/;

const bucket = process.env.BILL_STORE_BUCKET || "billboard-bill-store-bucket";
const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const concurrency = Math.max(1, Number.parseInt(process.env.VALIDATE_CONCURRENCY ?? "16", 10) || 16);
const TOP_ERRORS = 25;
const MAX_LISTED_KEYS = 50;
const MAX_LISTED_SKIPPED_KEYS = 10;

const EXIT_INVALID = 1;
const EXIT_AWS = 2;
const EXIT_SCHEMA = 3;
const EXIT_NOTHING_VALIDATED = 4;

function loadS3() {
  const servicesRequire = createRequire(path.resolve(contractsRoot, "../services/package.json"));
  try {
    return servicesRequire("@aws-sdk/client-s3");
  } catch {
    console.error("validate:live needs @aws-sdk/client-s3 from services/node_modules: run `npm ci` in services/.");
    process.exit(EXIT_AWS);
  }
}

// The processed-bill validator. A schema that cannot be read, parsed or compiled is a problem with this checkout, not
// with the stored bills, so it exits with its own code before anything is downloaded.
function loadValidator() {
  let current = SCHEMA_FILE;
  try {
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
    addFormats(ajv);
    for (const group of ["entities", "release"]) {
      const dir = path.join(contractsRoot, "schemas", group);
      current = `schemas/${group}/`;
      for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".json"))) {
        current = `schemas/${group}/${name}`;
        ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
      }
    }
    current = SCHEMA_FILE;
    const { $id } = JSON.parse(fs.readFileSync(path.join(contractsRoot, SCHEMA_FILE), "utf8"));
    const validate = ajv.getSchema($id);
    if (!validate) throw new Error(`no schema is registered as ${$id}`);
    return validate;
  } catch (error) {
    console.error(`Cannot load the schemas (${current}: ${describe(error)}).`);
    console.error("No bill was validated. Run `npm run check` in contracts/ to find the broken schema.");
    process.exit(EXIT_SCHEMA);
  }
}

// The processed-bill keys under PREFIX, and the other keys there (nested paths, other extensions), which are skipped.
async function listKeys(s3, { ListObjectsV2Command }) {
  const keys = [];
  const skipped = [];
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken }));
    for (const object of page.Contents ?? []) {
      (KEY_PATTERN.test(object.Key) ? keys : skipped).push(object.Key);
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return { keys: keys.sort(), skipped: skipped.sort() };
}

function describe(error) {
  return error instanceof Error ? `${error.name ?? "Error"}: ${error.message}` : String(error);
}

async function main() {
  const validate = loadValidator();
  const sdk = loadS3();
  const s3 = new sdk.S3Client({ region });

  let keys;
  let skipped;
  try {
    ({ keys, skipped } = await listKeys(s3, sdk));
  } catch (error) {
    console.error(`Cannot list s3://${bucket}/${PREFIX} (${describe(error)}).`);
    console.error(
      "Check the credentials: AWS_PROFILE=billboard, and `aws sso login --profile billboard` if they expired.",
    );
    process.exit(EXIT_AWS);
  }
  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} keys under ${PREFIX} that are not ${PREFIX}<name>.json:`);
    for (const key of skipped.slice(0, MAX_LISTED_SKIPPED_KEYS)) console.log(`  ${key}`);
    if (skipped.length > MAX_LISTED_SKIPPED_KEYS) console.log(`  ... and ${skipped.length - MAX_LISTED_SKIPPED_KEYS} more`);
  }
  if (keys.length === 0) {
    console.error(`Nothing to validate: no key in s3://${bucket}/${PREFIX} matches ${KEY_PATTERN}. Check BILL_STORE_BUCKET.`);
    process.exit(EXIT_NOTHING_VALIDATED);
  }
  console.log(`Validating ${keys.length} processed bills in s3://${bucket}/${PREFIX} against ${SCHEMA_FILE} ...`);

  const errorCounts = new Map();
  const invalid = [];
  const unreadable = [];
  let valid = 0;
  let next = 0;

  async function worker() {
    while (next < keys.length) {
      const key = keys[next++];
      let bill;
      try {
        const object = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
        bill = JSON.parse(await object.Body.transformToString());
      } catch (error) {
        unreadable.push({ key, reason: describe(error) });
        continue;
      }
      if (validate(bill)) {
        valid += 1;
        continue;
      }
      const messages = validate.errors.map(
        (error) => `${error.instancePath.replace(/\/\d+/g, "/*") || "/"} ${error.message}`,
      );
      invalid.push({ key, first: messages[0] });
      for (const message of new Set(messages)) errorCounts.set(message, (errorCounts.get(message) ?? 0) + 1);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));

  console.log(
    `total ${keys.length}, valid ${valid}, invalid ${invalid.length}, unreadable ${unreadable.length}, skipped ${skipped.length}`,
  );
  if (errorCounts.size > 0) {
    console.log(`\nTop error paths (bills per error, array indexes shown as *):`);
    for (const [message, count] of [...errorCounts].sort((a, b) => b[1] - a[1]).slice(0, TOP_ERRORS)) {
      console.log(`  ${String(count).padStart(5)}  ${message}`);
    }
  }
  for (const [label, entries, detail] of [
    ["Invalid", invalid, (entry) => entry.first],
    ["Unreadable", unreadable, (entry) => entry.reason],
  ]) {
    if (entries.length === 0) continue;
    console.log(`\n${label} bills${entries.length > MAX_LISTED_KEYS ? ` (first ${MAX_LISTED_KEYS})` : ""}:`);
    for (const entry of entries.sort((a, b) => a.key.localeCompare(b.key)).slice(0, MAX_LISTED_KEYS)) {
      console.log(`  ${entry.key}  ${detail(entry)}`);
    }
  }
  if (valid + invalid.length === 0) {
    console.error("\nNothing was validated: every listed bill failed to download.");
    process.exitCode = EXIT_NOTHING_VALIDATED;
  } else if (invalid.length > 0 || unreadable.length > 0) {
    process.exitCode = EXIT_INVALID;
  }
}

await main();
