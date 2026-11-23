#!/usr/bin/env node

const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { GetObjectCommand, ListObjectsV2Command, S3Client } = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BUCKET_NAME = process.env.BUCKET_NAME || "billboard-bill-store-bucket";
const RAW_BILLS_PREFIX = process.env.RAW_BILLS_PREFIX || "raw-bills/";
const TABLE_NAME = process.env.TABLE_NAME || "CongressMembersStats";
const PRIMARY_KEY = process.env.PRIMARY_KEY || "bioguideId";

const args = process.argv.slice(2);
const HELP = args.includes("--help") || args.includes("-h");
const DRY_RUN = args.includes("--dry-run");
const ALLOW_SKIPPED = args.includes("--allow-skipped");
const MAX_ITEMS = readNumberFlag("--max-items");
// Each Congress is counted apart, as the congressMemberStats handler counts it (src/shared/memberCounters.ts): the 119th
// in billsSponsored, billsSupported, sponsoredBillGuids and supportedBillGuids, each later Congress in attributes named
// with its number (billsSponsored120, ...). A run rebuilds one Congress's attributes and never touches another's.
const LEGACY_CONGRESS = 119;
const FIRST_NUMBERED_CONGRESS = 120;
const CONGRESS = resolveCongress(args);
const PREFIX = rawBillsPrefixFor(CONGRESS);
const ATTRIBUTES = counterAttributesFor(CONGRESS);

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

// The Congress in session at a time: the Nth meets at 17:00Z on January 3 of 1789 + 2(N - 1). Same rule as
// congressInSessionAt in src/shared/memberCounters.ts.
function congressInSessionAt(atMs) {
  const year = new Date(atMs).getUTCFullYear();
  const startYear = year % 2 === 1 ? year : year - 1;
  const congress = (startYear - 1789) / 2 + 1;
  return atMs < Date.UTC(startYear, 0, 3, 17) ? congress - 1 : congress;
}

// --congress: the 119th (the default), or a later Congress that has started. Earlier Congresses are never counted.
function resolveCongress(argv, nowMs = Date.now()) {
  const index = argv.indexOf("--congress");
  if (index === -1) return String(LEGACY_CONGRESS);
  const value = (argv[index + 1] || "").trim();
  const congress = /^\d+$/.test(value) ? Number(value) : NaN;
  const inSession = congressInSessionAt(nowMs);
  if (congress !== LEGACY_CONGRESS && !(congress >= FIRST_NUMBERED_CONGRESS && congress <= inSession)) {
    throw new Error(
      `--congress ${value || "(missing)"} is not allowed: member counters count the ${LEGACY_CONGRESS}th Congress and ` +
        `each Congress from the ${FIRST_NUMBERED_CONGRESS}th that has started (the ${inSession}th is in session)`,
    );
  }
  return String(congress);
}

// The counter attributes of one Congress; must match counterAttributesFor in src/shared/memberCounters.ts.
function counterAttributesFor(congress) {
  if (String(congress) === String(LEGACY_CONGRESS)) {
    return {
      sponsored: "billsSponsored",
      supported: "billsSupported",
      sponsoredGuids: "sponsoredBillGuids",
      supportedGuids: "supportedBillGuids",
    };
  }
  return {
    sponsored: `billsSponsored${congress}`,
    supported: `billsSupported${congress}`,
    sponsoredGuids: `sponsoredBillGuids${congress}`,
    supportedGuids: `supportedBillGuids${congress}`,
  };
}

function rawBillsPrefixFor(congress) {
  return `${RAW_BILLS_PREFIX}BILLS-${congress}`;
}

function printHelp() {
  console.log("Rebuild one Congress's member sponsorship/support counts from raw-bills in S3.");
  console.log("");
  console.log("Each member's counters for that Congress are rewritten from scratch: for the 119th,");
  console.log("billsSponsored/billsSupported and the sponsoredBillGuids/supportedBillGuids sets the");
  console.log("congressMemberStats handler uses to count each bill once; for the 120th, billsSponsored120,");
  console.log("billsSupported120, sponsoredBillGuids120 and supportedBillGuids120 (and so on). Another");
  console.log("Congress's attributes are never read or written. Members are the ones the raw bills name");
  console.log("and the rows that already have this Congress's counters. Safe to re-run; run it while bill");
  console.log("ingestion is quiet, because a bill counted by the handler between this script's read and");
  console.log("its write is overwritten.");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/backfillCongressMemberStats.cjs --dry-run");
  console.log("  node scripts/backfillCongressMemberStats.cjs --congress 119 --max-items 500 --dry-run");
  console.log("  node scripts/backfillCongressMemberStats.cjs --congress 120 --dry-run");
  console.log("");
  console.log("Flags:");
  console.log("  --congress <n>   119 (the default), or a Congress from the 120th that has started.");
  console.log("  --dry-run        Print the rows that would be written.");
  console.log("  --max-items N    Only scan N raw bills (requires --dry-run: a partial scan would undercount).");
  console.log("  --allow-skipped  Write even if some raw bills could not be read (they are left uncounted).");
  console.log("");
  console.log("Environment overrides:");
  console.log("  AWS_REGION / AWS_DEFAULT_REGION");
  console.log("  BUCKET_NAME");
  console.log("  RAW_BILLS_PREFIX");
  console.log("  TABLE_NAME");
  console.log("  PRIMARY_KEY");
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

function extractSponsorIds(payload) {
  const content = payload?.content ?? payload;
  const billWrapper = content?.bill;
  const innerBill = billWrapper?.bill ?? billWrapper;
  const sponsors = innerBill?.sponsors ?? content?.sponsors;
  if (!Array.isArray(sponsors)) return [];
  return sponsors
    .map((sponsor) => toTrimmedString(sponsor?.bioguideId ?? sponsor?.bioguideID ?? sponsor?.bioGuideId))
    .filter(Boolean);
}

function extractCosponsorIds(payload) {
  const content = payload?.content ?? payload;
  const wrapper = content?.cosponsors ?? content?.bill?.cosponsors;
  const cosponsors = wrapper?.cosponsors ?? wrapper;
  if (!Array.isArray(cosponsors)) return [];
  return cosponsors
    .map((cosponsor) => toTrimmedString(cosponsor?.bioguideId ?? cosponsor?.bioguideID ?? cosponsor?.bioGuideId))
    .filter(Boolean);
}

// raw-bills/<guid>.json -> <guid>. Must match the congressMemberStats handler, which uses the
// same guid as its idempotency key.
function rawBillGuidFromKey(key, prefix = RAW_BILLS_PREFIX) {
  if (!key.startsWith(prefix) || !key.endsWith(".json")) return null;
  const guid = key.slice(prefix.length, -".json".length).trim();
  return guid.length > 0 ? guid : null;
}

function createTallies() {
  return { sponsored: new Map(), supported: new Map() };
}

function addGuid(map, bioguideId, guid) {
  const guids = map.get(bioguideId) ?? new Set();
  guids.add(guid);
  map.set(bioguideId, guids);
}

// Mirrors the handler: a sponsor is not also counted as a cosponsor of the same bill.
function tallyRawBill(tallies, key, payload) {
  const guid = rawBillGuidFromKey(key);
  if (!guid) throw new Error(`Cannot derive bill guid from ${key}`);
  const sponsors = new Set(extractSponsorIds(payload));
  const cosponsors = new Set(extractCosponsorIds(payload).filter((id) => !sponsors.has(id)));
  for (const bioguideId of sponsors) addGuid(tallies.sponsored, bioguideId, guid);
  for (const bioguideId of cosponsors) addGuid(tallies.supported, bioguideId, guid);
}

// DynamoDB string sets cannot be empty, so an empty set is removed instead of written. The attribute names are plain
// (no reserved words), so the expression names them directly.
function buildMemberUpdateInput(
  bioguideId,
  sponsoredGuids,
  supportedGuids,
  { tableName = TABLE_NAME, primaryKey = PRIMARY_KEY, attributes = ATTRIBUTES } = {},
) {
  const sponsored = [...(sponsoredGuids ?? [])].sort();
  const supported = [...(supportedGuids ?? [])].sort();
  const setClauses = [`${attributes.sponsored} = :sponsored`, `${attributes.supported} = :supported`];
  const removeClauses = [];
  const values = {
    ":sponsored": { N: String(sponsored.length) },
    ":supported": { N: String(supported.length) },
  };

  if (sponsored.length > 0) {
    setClauses.push(`${attributes.sponsoredGuids} = :sponsoredGuids`);
    values[":sponsoredGuids"] = { SS: sponsored };
  } else {
    removeClauses.push(attributes.sponsoredGuids);
  }
  if (supported.length > 0) {
    setClauses.push(`${attributes.supportedGuids} = :supportedGuids`);
    values[":supportedGuids"] = { SS: supported };
  } else {
    removeClauses.push(attributes.supportedGuids);
  }

  return {
    TableName: tableName,
    Key: {
      [primaryKey]: { S: bioguideId },
    },
    UpdateExpression: `SET ${setClauses.join(", ")}${removeClauses.length > 0 ? ` REMOVE ${removeClauses.join(", ")}` : ""}`,
    ExpressionAttributeValues: values,
  };
}

// The rows that already have this Congress's counters, so a member whose bills are gone is reset to 0. A row with
// only another Congress's counters is left alone: writing zeros there would give a member new in the 120th Congress
// 119th counts of 0, which the member APIs must not send (REL-46, D8).
function rowHasCongressCounters(item, attributes = ATTRIBUTES) {
  return item?.[attributes.sponsored] !== undefined || item?.[attributes.supported] !== undefined;
}

async function scanExistingMemberIds() {
  const ids = new Set();
  let startKey;

  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: "#pk, #sponsored, #supported",
        ExpressionAttributeNames: {
          "#pk": PRIMARY_KEY,
          "#sponsored": ATTRIBUTES.sponsored,
          "#supported": ATTRIBUTES.supported,
        },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const bioguideId = item?.[PRIMARY_KEY]?.S;
      if (typeof bioguideId === "string" && bioguideId.length > 0 && rowHasCongressCounters(item)) {
        ids.add(bioguideId);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return ids;
}

async function updateMemberCounts(bioguideId, sponsoredGuids, supportedGuids) {
  await ddb.send(new UpdateItemCommand(buildMemberUpdateInput(bioguideId, sponsoredGuids, supportedGuids)));
}

async function main() {
  if (HELP) {
    printHelp();
    return;
  }
  if (MAX_ITEMS && !DRY_RUN) {
    throw new Error("--max-items only works with --dry-run: writing a partial scan would undercount every member");
  }

  console.log("Starting congress member stats backfill");
  console.log(`Region: ${REGION}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Congress: ${CONGRESS}`);
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Stats table: ${TABLE_NAME}`);
  console.log(`Attributes: ${Object.values(ATTRIBUTES).join(", ")}`);
  console.log(`Dry run: ${DRY_RUN ? "yes" : "no"}`);
  if (MAX_ITEMS) console.log(`Max items: ${MAX_ITEMS}`);

  const keys = await listKeys(PREFIX);
  console.log(`Found ${keys.length} raw bill objects under ${PREFIX}`);

  const tallies = createTallies();
  let scanned = 0;
  let skipped = 0;

  for (const key of keys) {
    if (MAX_ITEMS && scanned >= MAX_ITEMS) break;
    scanned += 1;
    if (scanned % 250 === 0 || scanned === keys.length || (MAX_ITEMS && scanned === MAX_ITEMS)) {
      console.log(`Scanned ${scanned}${MAX_ITEMS ? ` / ${MAX_ITEMS}` : ` / ${keys.length}`} raw bill objects...`);
    }

    try {
      tallyRawBill(tallies, key, await getJson(key));
    } catch (error) {
      skipped += 1;
      console.warn("Skipping raw bill during backfill", { key, error: error?.message ?? error });
    }
  }

  if (skipped > 0 && !DRY_RUN && !ALLOW_SKIPPED) {
    throw new Error(
      `${skipped} raw bill(s) could not be read; nothing was written. Re-run, or pass --allow-skipped to write without them.`,
    );
  }

  const existingMemberIds = await scanExistingMemberIds();
  const allMemberIds = new Set([...existingMemberIds, ...tallies.sponsored.keys(), ...tallies.supported.keys()]);

  let updated = 0;
  for (const bioguideId of allMemberIds) {
    const sponsoredGuids = tallies.sponsored.get(bioguideId) ?? new Set();
    const supportedGuids = tallies.supported.get(bioguideId) ?? new Set();

    if (DRY_RUN) {
      console.log("[dry-run] would set counts", {
        bioguideId,
        billsSponsored: sponsoredGuids.size,
        billsSupported: supportedGuids.size,
      });
      updated += 1;
      continue;
    }

    await updateMemberCounts(bioguideId, sponsoredGuids, supportedGuids);
    updated += 1;
    if (updated % 100 === 0 || updated === allMemberIds.size) {
      console.log(`Updated ${updated} / ${allMemberIds.size} member rows...`);
    }
  }

  console.log("");
  console.log("Congress member stats backfill complete");
  console.log(`  Raw bills scanned: ${scanned}`);
  console.log(`  Raw bills skipped: ${skipped}`);
  console.log(`  Members with sponsored counts: ${tallies.sponsored.size}`);
  console.log(`  Members with supported counts: ${tallies.supported.size}`);
  console.log(`  Existing rows with this Congress's counters: ${existingMemberIds.size}`);
  console.log(`  Member rows updated: ${updated}`);
}

module.exports = {
  CONGRESS,
  PREFIX,
  ATTRIBUTES,
  congressInSessionAt,
  counterAttributesFor,
  resolveCongress,
  rowHasCongressCounters,
  rawBillsPrefixFor,
  rawBillGuidFromKey,
  createTallies,
  tallyRawBill,
  buildMemberUpdateInput,
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Congress member stats backfill failed", error);
    process.exit(1);
  });
}
