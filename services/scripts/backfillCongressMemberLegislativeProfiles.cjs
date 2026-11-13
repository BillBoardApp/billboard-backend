#!/usr/bin/env node

const { BatchWriteItemCommand, DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { GetObjectCommand, ListObjectsV2Command, S3Client } = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BUCKET_NAME = process.env.BUCKET_NAME || "billboard-bill-store-bucket";
const PROCESSED_BILLS_PREFIX = process.env.PROCESSED_BILLS_PREFIX || "processed-bills/";
const TABLE_NAME = process.env.TABLE_NAME || "CongressMemberLegislativeProfiles";
const PRIMARY_KEY = process.env.PRIMARY_KEY || "bioguideId";
const SORT_KEY = process.env.SORT_KEY || "billGuid";
const BATCH_SIZE = 25;
const MAX_RETRIES = 4;

const args = process.argv.slice(2);
const HELP = args.includes("--help") || args.includes("-h");
const DRY_RUN = args.includes("--dry-run");
const MAX_ITEMS = readNumberFlag("--max-items");
const CONGRESS = readStringFlag("--congress") || computeCurrentCongressNumber(new Date()).toString();
const PREFIX = `${PROCESSED_BILLS_PREFIX}BILLS-${CONGRESS}`;

const s3 = new S3Client({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

function readStringFlag(flagName) {
  const index = args.indexOf(flagName);
  if (index === -1) return null;
  const raw = args[index + 1];
  if (!raw || raw.startsWith("--")) {
    throw new Error(`${flagName} requires a value`);
  }
  return raw.trim();
}

function readNumberFlag(flagName) {
  const value = readStringFlag(flagName);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} requires a positive integer`);
  }
  return parsed;
}

function computeCurrentCongressNumber(at) {
  const year = at.getUTCFullYear();
  let congressStartYear = year % 2 === 0 ? year - 1 : year;
  if (year % 2 === 1 && at.getTime() < Date.UTC(year, 0, 3)) {
    congressStartYear = year - 2;
  }
  return Math.floor((congressStartYear - 1789) / 2) + 1;
}

function printHelp() {
  console.log("Backfill congress member legislative profile evidence from processed bills in S3.");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/backfillCongressMemberLegislativeProfiles.cjs --dry-run");
  console.log("  node scripts/backfillCongressMemberLegislativeProfiles.cjs --congress 119");
  console.log("  node scripts/backfillCongressMemberLegislativeProfiles.cjs --congress 119 --max-items 500");
  console.log("");
  console.log("Environment overrides:");
  console.log("  AWS_REGION / AWS_DEFAULT_REGION");
  console.log("  BUCKET_NAME");
  console.log("  PROCESSED_BILLS_PREFIX");
  console.log("  TABLE_NAME");
  console.log("  PRIMARY_KEY");
  console.log("  SORT_KEY");
}

function toTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function bodyToString(body) {
  if (!body) throw new Error("Missing S3 object body");
  if (typeof body.transformToString === "function") {
    return body.transformToString();
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Unsupported S3 body type");
}

async function listKeys(prefix) {
  const keys = [];
  let continuationToken;

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

async function getJson(key) {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }),
  );

  return JSON.parse(await bodyToString(response.Body));
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCivicProfileMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value)
    .map(([axis, score]) => {
      const numeric = typeof score === "number" ? score : Number(score);
      if (!Number.isFinite(numeric)) return null;
      return [axis, { N: String(numeric) }];
    })
    .filter(Boolean);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function computeOccurredAt(payload) {
  const nowIso = new Date().toISOString();
  const officialVotes = payload?.officialVotes ?? {};
  const houseActionDate = toTrimmedString(officialVotes?.house?.actionDate);
  const senateActionDate = toTrimmedString(officialVotes?.senate?.actionDate);
  const lastSyncedAt = toTrimmedString(officialVotes?.lastSyncedAt);
  const storedAt = toTrimmedString(payload?.storedAt);
  const source = houseActionDate || senateActionDate || lastSyncedAt || storedAt || nowIso;
  return Number.isNaN(Date.parse(source)) ? nowIso : new Date(source).toISOString();
}

function buildLegislativeRows(payload) {
  // The plain guid, as congressMemberStats keys the rows: a processed bill may carry a text-version suffix.
  const billGuid = toTrimmedString(payload?.guid).replace(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i, "$1");
  const civicProfile = toCivicProfileMap(payload?.civicProfile);
  if (!billGuid || !civicProfile) return [];

  const occurredAt = computeOccurredAt(payload);
  const sponsors = Array.isArray(payload?.sponsors) ? payload.sponsors : [];
  const cosponsors = Array.isArray(payload?.cosponsors) ? payload.cosponsors : [];
  const sponsorIds = new Set(sponsors.map(toTrimmedString).filter(Boolean));
  const cosponsorIds = new Set(cosponsors.map(toTrimmedString).filter((value) => value && !sponsorIds.has(value)));

  const rows = [];
  for (const bioguideId of sponsorIds) {
    rows.push({ bioguideId, billGuid, evidenceType: "sponsor", occurredAt, civicProfile });
  }
  for (const bioguideId of cosponsorIds) {
    rows.push({ bioguideId, billGuid, evidenceType: "cosponsor", occurredAt, civicProfile });
  }
  return rows;
}

async function sendBatchWriteWithRetry(requests) {
  let pending = requests;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await ddb.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE_NAME]: pending,
        },
      }),
    );

    const unprocessed = response.UnprocessedItems?.[TABLE_NAME];
    if (!Array.isArray(unprocessed) || unprocessed.length === 0) return;

    if (attempt === MAX_RETRIES) {
      throw new Error(`Failed to batch write ${unprocessed.length} row(s) to ${TABLE_NAME} after retries`);
    }

    pending = unprocessed;
    await sleep(50 * Math.pow(2, attempt));
  }
}

async function writeRows(rows) {
  const requests = rows.map((row) => ({
    PutRequest: {
      Item: {
        [PRIMARY_KEY]: { S: row.bioguideId },
        [SORT_KEY]: { S: row.billGuid },
        evidenceType: { S: row.evidenceType },
        occurredAt: { S: row.occurredAt },
        updatedAt: { S: new Date().toISOString() },
        civicProfile: { M: row.civicProfile },
      },
    },
  }));

  for (const batch of chunk(requests, BATCH_SIZE)) {
    await sendBatchWriteWithRetry(batch);
  }
}

async function main() {
  if (HELP) {
    printHelp();
    return;
  }

  console.log("Starting congress member legislative profile backfill");
  console.log(`Region: ${REGION}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Table: ${TABLE_NAME}`);
  console.log(`Dry run: ${DRY_RUN ? "yes" : "no"}`);
  if (MAX_ITEMS) console.log(`Max items: ${MAX_ITEMS}`);

  const keys = await listKeys(PREFIX);
  console.log(`Found ${keys.length} processed bill objects under ${PREFIX}`);

  let scanned = 0;
  let skipped = 0;
  let rowsWritten = 0;

  for (const key of keys) {
    if (MAX_ITEMS && scanned >= MAX_ITEMS) break;
    scanned += 1;

    if (scanned % 250 === 0 || scanned === keys.length || (MAX_ITEMS && scanned === MAX_ITEMS)) {
      console.log(`Scanned ${scanned}${MAX_ITEMS ? ` / ${MAX_ITEMS}` : ` / ${keys.length}`} processed bill objects...`);
    }

    try {
      const payload = await getJson(key);
      const rows = buildLegislativeRows(payload);
      if (rows.length === 0) continue;

      if (DRY_RUN) {
        console.log("[dry-run] would write rows", { key, rows: rows.length });
        rowsWritten += rows.length;
        continue;
      }

      await writeRows(rows);
      rowsWritten += rows.length;
    } catch (error) {
      skipped += 1;
      console.warn("Skipping processed bill during legislative profile backfill", {
        key,
        error: error?.message ?? error,
      });
    }
  }

  console.log("");
  console.log("Congress member legislative profile backfill complete");
  console.log(`  Processed bills scanned: ${scanned}`);
  console.log(`  Processed bills skipped: ${skipped}`);
  console.log(`  Evidence rows written: ${rowsWritten}`);
}

module.exports = { buildLegislativeRows };

if (require.main === module) {
  main().catch((error) => {
    console.error("Congress member legislative profile backfill failed", error);
    process.exit(1);
  });
}
