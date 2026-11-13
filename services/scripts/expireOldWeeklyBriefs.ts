#!/usr/bin/env node

// Expires the old Weekly Briefs (WEB-07 privacy draft, gap G1; project decision of 2026-11-12). Since 2026-10-28 (S15)
// WeeklyDigestWorker writes each snapshot with `ttl` = publishedAt + 21 days (src/adapters/weeklyDigestSnapshotDao.ts).
// Rows written before then have no `ttl`, so DynamoDB never deletes them, or the old 180-day one (CAP-09). This one-off
// sets `ttl` to publishedAt + 21 days on every UserWeeklyDigests row whose `ttl` is missing or later than that, so
// DynamoDB's TTL deletes the old rows within a few days and the privacy policy may say "We keep each one for about
// three weeks" (../docs/RUNBOOK.md 25.3).
//
//   npm run expire:old-weekly-briefs                          dry run (the default; reads only)
//   npm run expire:old-weekly-briefs -- --apply --expect <N>  sets the ttl; <N> is the dry run's toSet
//
// The dry run scans the table with consistent reads, reading only the keys, `ttl` and `createdAt` (never the brief),
// and counts the rows: missingTtl (no `ttl`), laterTtl (a `ttl` later than publishedAt + 21 days), alreadyRight (a
// `ttl` at or before it) and unreadable (a publishedAt that is not a date, or a `ttl` that is not a number). toSet is
// missingTtl + laterTtl. Apart from those, overdue counts the rows whose `ttl` passed more than 3 days ago: DynamoDB
// deletes an expired row only within a few days, and reads return it until then, so toSet=0 alone does not show that
// the old rows are gone. The policy's sentence waits for toSet=0 and overdue=0; overdue never changes the exit code.
// --apply refuses (exit 2, nothing written) unless toSet is exactly --expect and no row is unreadable, then updates
// the planned rows one at a time: SET ttl = publishedAt + 21 days (epoch seconds), on the condition that the row still
// exists, its `ttl` is still as read (absent, or the same later number, which is then also later than the new one) and
// its `createdAt` is as read. So it never creates a row (a deleted account's brief stays deleted), never moves a `ttl`
// later and never touches a row changed since the scan. It stops at the first error, a failed condition included
// (exit 1); a rerun picks up where it stopped, as the rows it set are already right. After the updates it scans again
// and counts. It never prints a user id, a date of a brief or a brief: counts only.
// The last lines are
//   Weekly Brief expiry plan: rows= missingTtl= laterTtl= alreadyRight= unreadable= toSet= overdue=
// and, with --apply,
//   Weekly Brief expiry complete set= missingTtlAfter= laterTtlAfter=
// Exit codes: 0 done (or nothing to do), 1 an error stopped it, a row is unreadable, or a row is left to set; 2 refused.
//
// The table has no stream, so the writes reach no Lambda. Environment: AWS_REGION (us-east-1),
// WEEKLY_DIGESTS_TABLE_NAME (UserWeeklyDigests).

import { DynamoDBClient, ScanCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";

import {
  WEEKLY_DIGEST_RETENTION_DAYS,
  WEEKLY_DIGEST_TTL_ATTRIBUTE,
  weeklyDigestExpiresAtEpochSeconds,
} from "../src/adapters/weeklyDigestSnapshotDao";

type Item = Record<string, AttributeValue>;
type TableSend = Pick<DynamoDBClient, "send">;

/** The row's creation time, written once with the row; a row replaced since the scan has another. */
const CREATED_AT_ATTRIBUTE = "createdAt";

/**
 * A row whose `ttl` passed more than this many days ago is overdue: DynamoDB deletes an expired row within a few days,
 * so one still there after this long has not been deleted as the privacy policy's "about three weeks" needs.
 */
export const OVERDUE_AFTER_DAYS = 3;
const DAY_SECONDS = 24 * 60 * 60;

export interface ExpireConfig {
  region: string;
  tableName: string;
  /** UserWeeklyDigests' keys (infra/lib/config/user-store-constants.ts). */
  partitionKey: string;
  sortKey: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): ExpireConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  tableName: (env.WEEKLY_DIGESTS_TABLE_NAME ?? "").trim() || "UserWeeklyDigests",
  partitionKey: "userId",
  sortKey: "publishedAt",
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  expect: number | null;
}

const USAGE = `Usage: npm run expire:old-weekly-briefs [-- <flags>]

  (no flag)              Dry run: count the Weekly Brief rows whose ttl is missing or later than publishedAt + ${WEEKLY_DIGEST_RETENTION_DAYS} days,
                         and (overdue) those whose ttl passed more than ${OVERDUE_AFTER_DAYS} days ago; writes nothing
  --apply --expect <N>   Set ttl = publishedAt + ${WEEKLY_DIGEST_RETENTION_DAYS} days on those rows (only those); <N> is the dry run's toSet
  --help                 Show this text

Environment: AWS_REGION (us-east-1), WEEKLY_DIGESTS_TABLE_NAME (UserWeeklyDigests).`;

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { help: false, apply: false, expect: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--expect") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--expect needs a value");
      if (!/^\d+$/.test(value.trim())) throw new Error(`--expect needs a whole number, not ${value}`);
      options.expect = Number(value.trim());
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.expect !== null && !options.apply) throw new Error("--expect goes with --apply only");
  if (options.apply && options.expect === null) {
    throw new Error("--apply needs --expect <N>, the toSet count of the dry run");
  }
  return options;
};

export type RowState = "missingTtl" | "laterTtl" | "alreadyRight" | "unreadable";

export interface ScannedRow {
  state: RowState;
  /** The row's key (partition and sort key only). */
  key: Item;
  /** publishedAt + 21 days in epoch seconds; null when the row is unreadable. */
  targetTtl: number | null;
  /** The `ttl` and `createdAt` as read, for the update's condition; undefined when absent. */
  readTtl: AttributeValue | undefined;
  readCreatedAt: AttributeValue | undefined;
}

export const classifyRow = (item: Item, config: ExpireConfig): ScannedRow => {
  const key: Item = { [config.partitionKey]: item[config.partitionKey], [config.sortKey]: item[config.sortKey] };
  const readTtl = item[WEEKLY_DIGEST_TTL_ATTRIBUTE];
  const readCreatedAt = item[CREATED_AT_ATTRIBUTE];
  const publishedAt = item[config.sortKey]?.S;
  const targetTtl = publishedAt ? weeklyDigestExpiresAtEpochSeconds(publishedAt) : null;
  const row = (state: RowState): ScannedRow => ({ state, key, targetTtl, readTtl, readCreatedAt });
  if (targetTtl === null) return row("unreadable");
  if (readTtl === undefined) return row("missingTtl");
  const ttlSeconds = readTtl.N === undefined ? Number.NaN : Number(readTtl.N);
  if (!Number.isFinite(ttlSeconds)) return row("unreadable");
  return row(ttlSeconds > targetTtl ? "laterTtl" : "alreadyRight");
};

export interface ExpiryTally {
  rows: number;
  missingTtl: number;
  laterTtl: number;
  alreadyRight: number;
  unreadable: number;
  toSet: number;
  /** Rows, whatever their state, whose `ttl` passed more than OVERDUE_AFTER_DAYS days before `nowSeconds`. */
  overdue: number;
}

/** True when the row's `ttl` is a number more than OVERDUE_AFTER_DAYS days before `nowSeconds`. */
export const isOverdue = (row: ScannedRow, nowSeconds: number): boolean => {
  const ttlSeconds = row.readTtl?.N === undefined ? Number.NaN : Number(row.readTtl.N);
  return Number.isFinite(ttlSeconds) && ttlSeconds < nowSeconds - OVERDUE_AFTER_DAYS * DAY_SECONDS;
};

export const tallyRows = (rows: readonly ScannedRow[], nowSeconds: number): ExpiryTally => {
  const count = (state: RowState): number => rows.filter((row) => row.state === state).length;
  const missingTtl = count("missingTtl");
  const laterTtl = count("laterTtl");
  return {
    rows: rows.length,
    missingTtl,
    laterTtl,
    alreadyRight: count("alreadyRight"),
    unreadable: count("unreadable"),
    toSet: missingTtl + laterTtl,
    overdue: rows.filter((row) => isOverdue(row, nowSeconds)).length,
  };
};

export const scanRows = async (table: TableSend, config: ExpireConfig): Promise<ScannedRow[]> => {
  const rows: ScannedRow[] = [];
  let exclusiveStartKey: Item | undefined;
  do {
    const page = await table.send(
      new ScanCommand({
        TableName: config.tableName,
        ConsistentRead: true,
        ProjectionExpression: "#pk, #sk, #ttl, #createdAt",
        ExpressionAttributeNames: {
          "#pk": config.partitionKey,
          "#sk": config.sortKey,
          "#ttl": WEEKLY_DIGEST_TTL_ATTRIBUTE,
          "#createdAt": CREATED_AT_ATTRIBUTE,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) rows.push(classifyRow(item, config));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return rows;
};

/** The conditional update for one planned row (missingTtl or laterTtl). */
export const updateFor = (row: ScannedRow, config: ExpireConfig): UpdateItemCommand => {
  if (row.targetTtl === null || (row.state !== "missingTtl" && row.state !== "laterTtl")) {
    throw new Error(`Not a row to set: ${row.state}`);
  }
  const values: Item = { ":ttl": { N: String(row.targetTtl) } };
  const conditions = ["attribute_exists(#pk)"];
  if (row.readTtl === undefined) conditions.push("attribute_not_exists(#ttl)");
  else {
    // The same later number as read, which is later than the new one: the ttl only ever moves earlier.
    conditions.push("#ttl = :readTtl", "#ttl > :ttl");
    values[":readTtl"] = row.readTtl;
  }
  if (row.readCreatedAt === undefined) conditions.push("attribute_not_exists(#createdAt)");
  else {
    conditions.push("#createdAt = :readCreatedAt");
    values[":readCreatedAt"] = row.readCreatedAt;
  }
  return new UpdateItemCommand({
    TableName: config.tableName,
    Key: row.key,
    UpdateExpression: "SET #ttl = :ttl",
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: {
      "#pk": config.partitionKey,
      "#ttl": WEEKLY_DIGEST_TTL_ATTRIBUTE,
      "#createdAt": CREATED_AT_ATTRIBUTE,
    },
    ExpressionAttributeValues: values,
  });
};

export interface ExpireDeps {
  table: TableSend;
  config: ExpireConfig;
  options: CliOptions;
  log?: (line: string) => void;
  /** The current time in epoch milliseconds, for `overdue`; Date.now by default. */
  now?: () => number;
}

export interface ExpireRunResult {
  exitCode: 0 | 1 | 2;
  tally: ExpiryTally;
  set: number;
  /** The rows still to set when the table was scanned again after --apply; null without a completed --apply. */
  after: ExpiryTally | null;
}

const planLine = (tally: ExpiryTally): string =>
  `Weekly Brief expiry plan: rows=${tally.rows} missingTtl=${tally.missingTtl} laterTtl=${tally.laterTtl} ` +
  `alreadyRight=${tally.alreadyRight} unreadable=${tally.unreadable} toSet=${tally.toSet} overdue=${tally.overdue}`;

const errorName = (error: unknown): string =>
  typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "Error";

export const runExpire = async (deps: ExpireDeps): Promise<ExpireRunResult> => {
  const log = deps.log ?? ((line: string) => console.log(line));
  const nowSeconds = (): number => Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  log(`${deps.options.apply ? "Apply" : "Dry run"}: table ${deps.config.tableName}`);

  const rows = await scanRows(deps.table, deps.config);
  const tally = tallyRows(rows, nowSeconds());
  log(planLine(tally));
  const result: ExpireRunResult = { exitCode: tally.unreadable > 0 ? 1 : 0, tally, set: 0, after: null };
  if (!deps.options.apply) return result;

  if (tally.unreadable > 0) {
    log(`Refused: ${tally.unreadable} row(s) unreadable. Look at them before --apply.`);
    return { ...result, exitCode: 2 };
  }
  if (tally.toSet !== deps.options.expect) {
    log(`Refused: ${tally.toSet} row(s) to set, not --expect ${deps.options.expect}. Run the dry run again.`);
    return { ...result, exitCode: 2 };
  }

  let set = 0;
  for (const row of rows) {
    if (row.state !== "missingTtl" && row.state !== "laterTtl") continue;
    try {
      await deps.table.send(updateFor(row, deps.config));
      set += 1;
    } catch (error) {
      const name = errorName(error);
      const why =
        name === "ConditionalCheckFailedException" ? "a row changed or went since the scan" : "the update failed";
      log(`Stopped after set=${set} of ${tally.toSet}: ${why} (${name}). Run the dry run again.`);
      return { ...result, exitCode: 1, set };
    }
  }

  const after = tallyRows(await scanRows(deps.table, deps.config), nowSeconds());
  log(planLine(after));
  log(`Weekly Brief expiry complete set=${set} missingTtlAfter=${after.missingTtl} laterTtlAfter=${after.laterTtl}`);
  return { ...result, set, after, exitCode: after.toSet > 0 || after.unreadable > 0 ? 1 : 0 };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const result = await runExpire({ table: new DynamoDBClient({ region: config.region }), config, options });
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`Weekly Brief expiry failed: ${errorName(error)}`, error instanceof Error ? error.message : "");
    process.exitCode = 1;
  });
}
