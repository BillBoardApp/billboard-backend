#!/usr/bin/env node

// Backfill of the manifest's voteCount (INT-07). billStatsAggregator stores verified Yea/Nay votes only
// in the manifest's voteCount, but it only rewrites a bill when that bill gets new feedback, and
// createBillsManifest carries the stored value forward. A row written before that rule keeps the
// old count, which includes self-attested votes. This recomputes every manifest row with the
// same code the aggregator runs. Safe to re-run; a concurrent manifest rewrite is handled by the
// aggregator's conditional update and createBillsManifest's voteCount condition, and a live
// recompute that started after this one's keeps its count (voteCountComputedFrom).

import { type AttributeValue, DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";

import type * as Aggregator from "../src/handlers/billStatsAggregator";
import type * as BillStats from "../src/shared/billStats";
import { mapWithConcurrency } from "../src/shared/concurrency";

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

// The names the stacks create (infra/lib/config); override with the same env vars the Lambda uses.
const ENV_DEFAULTS: Record<string, string> = {
  TABLE_NAME: "UserFeedback",
  PARTITION_KEY: "userId",
  SORT_KEY: "billId",
  BILL_ID_INDEX_NAME: "GSIBillIdIndex",
  MANIFEST_TABLE_NAME: "BillsManifest",
  MANIFEST_PRIMARY_KEY: "pk",
  MANIFEST_SORT_KEY: "sk",
  MANIFEST_PK_VALUE: "BILL",
};
for (const [name, value] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[name]) process.env[name] = value;
}
if (!process.env.MANIFEST_GUID_LOOKUP_PK) process.env.MANIFEST_GUID_LOOKUP_PK = `${process.env.MANIFEST_PK_VALUE}_GUID`;
// The aggregator's own DynamoDB client takes its region from the environment.
if (!process.env.AWS_REGION) process.env.AWS_REGION = REGION;
const env = (name: string): string => process.env[name] as string;

// Required after the defaults above, because the aggregator reads its table names at load time.
/* eslint-disable @typescript-eslint/no-require-imports -- must load after the env defaults above */
const { updateManifestVoteCount } = require("../src/handlers/billStatsAggregator") as typeof Aggregator;
const { computeRawBillStats } = require("../src/shared/billStats") as typeof BillStats;
/* eslint-enable @typescript-eslint/no-require-imports */

const args = process.argv.slice(2);
const HELP = args.includes("--help") || args.includes("-h");
const DRY_RUN = args.includes("--dry-run");
// Repeatable: `--guid A --guid B` checks just those bills (a repair that recomputes some bills' stats passes its guids so).
const GUIDS = readStringFlags("--guid");
const CONGRESS = readStringFlag("--congress");
const MAX_ITEMS = readNumberFlag("--max-items");
const CONCURRENCY = readNumberFlag("--concurrency") ?? 4;
const PROGRESS_INTERVAL = 250;

const db = new DynamoDBClient({ region: REGION });

type Stats = {
  scanned: number;
  changed: number;
  unchanged: number;
  superseded: number;
  missing: number;
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

/** Every value of a flag that may be given more than once, in order. */
function readStringFlags(flagName: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg !== flagName) return;
    const raw = args[index + 1];
    if (!raw || raw.startsWith("--")) {
      throw new Error(`${flagName} requires a value`);
    }
    values.push(raw.trim());
  });
  return values;
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

function printHelp(): void {
  console.log("Recompute BillsManifest voteCount as verified Yea/Nay votes only (INT-07).");
  console.log("");
  console.log("Run once after the billStatsAggregator change is deployed. Reads every guid lookup row,");
  console.log("counts verified decision votes from UserFeedback and updates rows whose count differs.");
  console.log("");
  console.log("Usage:");
  console.log("  npm run backfill:manifest-vote-counts -- --dry-run");
  console.log("  npm run backfill:manifest-vote-counts");
  console.log("  npm run backfill:manifest-vote-counts -- --guid BILLS-119hr500ih");
  console.log("");
  console.log("Options:");
  console.log("  --dry-run          Print the changes without writing");
  console.log("  --guid <guid>      Only this bill (the guid lookup row's sort key); repeat it for several");
  console.log("  --congress <n>     Only guids starting with BILLS-<n>");
  console.log("  --max-items <n>    Stop after n bills");
  console.log("  --concurrency <n>  Bills processed at once (default 4)");
  console.log("");
  console.log("Environment overrides:");
  console.log(`  AWS_REGION / AWS_DEFAULT_REGION, ${Object.keys(ENV_DEFAULTS).join(", ")}, MANIFEST_GUID_LOOKUP_PK`);
}

async function listLookupGuids(): Promise<string[]> {
  if (GUIDS.length > 0) return [...new Set(GUIDS)];

  const prefix = CONGRESS ? `BILLS-${CONGRESS}` : "";
  const guids: string[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await db.send(
      new QueryCommand({
        TableName: env("MANIFEST_TABLE_NAME"),
        KeyConditionExpression: prefix ? "#pk = :pk AND begins_with(#sk, :prefix)" : "#pk = :pk",
        ExpressionAttributeNames: { "#pk": env("MANIFEST_PRIMARY_KEY"), "#sk": env("MANIFEST_SORT_KEY") },
        ExpressionAttributeValues: {
          ":pk": { S: env("MANIFEST_GUID_LOOKUP_PK") },
          ...(prefix ? { ":prefix": { S: prefix } } : {}),
        },
        ProjectionExpression: "#sk",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of response.Items ?? []) {
      const guid = item[env("MANIFEST_SORT_KEY")]?.S;
      if (guid) guids.push(guid);
    }
    startKey = response.LastEvaluatedKey;
  } while (startKey && (!MAX_ITEMS || guids.length < MAX_ITEMS));

  return MAX_ITEMS ? guids.slice(0, MAX_ITEMS) : guids;
}

/** The manifest row's current voteCount; null when the lookup or row is missing. */
async function readStoredVoteCount(guid: string): Promise<number | null> {
  const lookup = await db.send(
    new GetItemCommand({
      TableName: env("MANIFEST_TABLE_NAME"),
      Key: {
        [env("MANIFEST_PRIMARY_KEY")]: { S: env("MANIFEST_GUID_LOOKUP_PK") },
        [env("MANIFEST_SORT_KEY")]: { S: guid },
      },
      ProjectionExpression: "manifestSk",
      ConsistentRead: true,
    }),
  );
  const manifestSk = lookup.Item?.manifestSk?.S;
  if (!manifestSk) return null;

  const row = await db.send(
    new GetItemCommand({
      TableName: env("MANIFEST_TABLE_NAME"),
      Key: {
        [env("MANIFEST_PRIMARY_KEY")]: { S: env("MANIFEST_PK_VALUE") },
        [env("MANIFEST_SORT_KEY")]: { S: manifestSk },
      },
      ProjectionExpression: "voteCount",
      ConsistentRead: true,
    }),
  );
  if (!row.Item) return null;
  const parsed = Number.parseInt(row.Item.voteCount?.N ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function backfillOne(guid: string, stats: Stats): Promise<void> {
  // Taken before reading votes, like the aggregator's, so a recompute that started later wins.
  const computationStartedAt = new Date().toISOString();
  const billStats = await computeRawBillStats({
    db,
    tableName: env("TABLE_NAME"),
    partitionKey: env("PARTITION_KEY"),
    sortKey: env("SORT_KEY"),
    billIdIndexName: env("BILL_ID_INDEX_NAME"),
    billId: guid,
  });
  // Same value billStatsAggregator writes.
  const verifiedVotes = billStats.segments.verified.decisionVotes;
  const stored = await readStoredVoteCount(guid);

  if (stored === null) {
    stats.missing += 1;
    return;
  }
  if (stored === verifiedVotes) {
    stats.unchanged += 1;
    return;
  }

  stats.changed += 1;
  console.log(`${DRY_RUN ? "[dry-run] would update" : "Updating"} ${guid}`, {
    from: stored,
    to: verifiedVotes,
    totalDecisionVotes: billStats.totals.decisionVotes,
  });
  if (DRY_RUN) return;

  const outcome = await updateManifestVoteCount(guid, verifiedVotes, computationStartedAt);
  // A recompute that started after this one already wrote a newer count: keep it.
  if (outcome === "superseded") stats.superseded += 1;
  if (outcome === "missing") stats.missing += 1;
  if (outcome === "failed" || outcome === "disabled") stats.failed += 1;
}

async function main(): Promise<void> {
  if (HELP) {
    printHelp();
    return;
  }

  console.log("Starting manifest voteCount backfill (verified votes only)");
  console.log(`Region: ${REGION}`);
  console.log(`Manifest table: ${env("MANIFEST_TABLE_NAME")}; feedback table: ${env("TABLE_NAME")}`);
  console.log(`Dry run: ${DRY_RUN ? "yes" : "no"}`);

  const guids = await listLookupGuids();
  console.log(`Found ${guids.length} bills to check`);

  const stats: Stats = { scanned: 0, changed: 0, unchanged: 0, superseded: 0, missing: 0, failed: 0 };
  await mapWithConcurrency(guids, CONCURRENCY, async (guid) => {
    try {
      await backfillOne(guid, stats);
    } catch (error) {
      stats.failed += 1;
      console.error("Failed to backfill voteCount", { guid, error });
    }
    stats.scanned += 1;
    if (stats.scanned % PROGRESS_INTERVAL === 0) {
      console.log(`Checked ${stats.scanned} / ${guids.length} bills...`);
    }
  });

  console.log("Manifest voteCount backfill complete", stats);
  if (stats.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Manifest voteCount backfill failed", error);
  process.exitCode = 1;
});
