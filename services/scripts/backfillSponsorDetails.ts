#!/usr/bin/env node

// REL-46 5.3: give the bills whose sponsor has left Congress the sponsor's name and seat (sponsorDetails), so the apps
// can still name the sponsor once the members list no longer has them. A bill gets the field on its next billDiffer
// write anyway; this reaches the bills that will not be written again (most 119th bills after 2027-01-03).
//
// Counts first, changes nothing without --apply:
//   1. Reads the members list (CongressMembersManifest) and every BILL row of BillsManifest (guid and sponsors), and
//      counts the bills with a sponsor who is not in the members list. It refuses a members list under
//      MIN_CURRENT_MEMBERS (a members run in progress), since every current member's bills would then count.
//   2. Plans those bills with reconcile:processed-bills' rule (planReconcile, read-only). A bill built from its latest
//      raw version and without sponsorDetails plans a patch of that field alone (ADDED_FIELDS); a bill whose raw bill
//      moved on plans a patch of every field it is behind on. Only the first kind is this backfill's: the others are
//      listed (and written to --out) for reconcile:processed-bills inside a RUNBOOK 4.1 quiet window, since a patch of
//      actions or a status can notify.
//   3. With --apply and --expect-bills <the dry run's sponsorDetailsOnly>, sends {guid} to BillDifferQueue for those
//      bills only (reconcile:processed-bills' send, --plans patch --added-fields, paced by --rate). It never writes to S3 itself:
//      billDiffer re-plans each bill and writes the patch, which changes no manifest date and sends no push.
//
// Last lines:
//   Sponsor details plan: bills= withSponsor= departedSponsorBills= departedSponsors= members= sponsorDetailsOnly=
//     otherPatches= unchanged= otherPlans= unreadable=
//   with --apply, reconcile:processed-bills' report for the bills sent, ending Reconcile complete sent= failed=
// Exit 0; 1 when a send failed or a bill could not be read; 2 when it refused before sending anything.

import { existsSync, writeFileSync } from "node:fs";
import { type AttributeValue, DynamoDBClient, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";

import { congressOfBillGuid } from "../src/shared/memberCounters";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_RATE,
  configFromEnv as reconcileConfigFromEnv,
  plainGuid,
  runReconcile,
  scanBills,
  type PlannedBill,
  type ReconcileConfig,
  type RunResult,
} from "./reconcileProcessedBills";

/** Fewer members than this means the members list is being rebuilt: stop rather than count current members' bills. */
export const MIN_CURRENT_MEMBERS = 500;
const MAX_CONCURRENCY = 25;
const MAX_RATE = 100;

export interface SponsorBackfillConfig {
  billsManifestTable: string;
  billsManifestPk: string;
  billsManifestPkValue: string;
  membersTable: string;
  membersPk: string;
  reconcile: ReconcileConfig;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): SponsorBackfillConfig => ({
  billsManifestTable: env.BILLS_MANIFEST_TABLE_NAME || "BillsManifest",
  billsManifestPk: env.BILLS_MANIFEST_PRIMARY_KEY || "pk",
  billsManifestPkValue: env.BILLS_MANIFEST_PK_VALUE || "BILL",
  membersTable: env.CONGRESS_MEMBERS_MANIFEST_TABLE_NAME || "CongressMembersManifest",
  membersPk: env.CONGRESS_MEMBERS_MANIFEST_PRIMARY_KEY || "bioguideId",
  reconcile: reconcileConfigFromEnv(env),
});

export interface CliOptions {
  help: boolean;
  apply: boolean;
  /** --apply only: the dry run's sponsorDetailsOnly; any other count stops the run before a send. */
  expectBills: number | null;
  /** Writes the guids (one per line) to this new file. */
  out: string | null;
  concurrency: number;
  rate: number;
}

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    expectBills: null,
    out: null,
    concurrency: DEFAULT_CONCURRENCY,
    rate: DEFAULT_RATE,
  };
  const readValue = (flag: string, raw: string | undefined): string => {
    if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs a value`);
    return raw;
  };
  const readWhole = (flag: string, raw: string | undefined, min: number, max: number): number => {
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${flag} needs a whole number from ${min} to ${max}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--expect-bills") options.expectBills = readWhole(arg, argv[(index += 1)], 0, 1_000_000);
    else if (arg === "--out") options.out = readValue(arg, argv[(index += 1)]);
    else if (arg === "--concurrency") options.concurrency = readWhole(arg, argv[(index += 1)], 1, MAX_CONCURRENCY);
    else if (arg === "--rate") options.rate = readWhole(arg, argv[(index += 1)], 1, MAX_RATE);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.apply && options.expectBills === null) {
    throw new Error("--apply needs --expect-bills <n>: the sponsorDetailsOnly count of a dry run");
  }
  return options;
};

const USAGE = [
  "Give the bills whose sponsor has left Congress the sponsor's name and seat (REL-46 5.3).",
  "Counts first; changes nothing without --apply.",
  "",
  "Usage:",
  "  npm run backfill:sponsor-details                                  Dry run: counts and the reconcile plan",
  "  npm run backfill:sponsor-details -- --out ./departed-sponsor-bills.txt",
  "  npm run backfill:sponsor-details -- --apply --expect-bills <n>    Inside a RUNBOOK 4.1 quiet window",
  "",
  "Options:",
  "  --apply              Send the bills whose patch is sponsorDetails alone to BillDifferQueue (needs",
  "                       --expect-bills). Never writes to S3.",
  "  --expect-bills <n>   The dry run's sponsorDetailsOnly; any other count stops before a send (exit 2).",
  "  --out <file>         Also write each bill's guid and plan to this new file (refuses an existing one); its",
  "                       first column is a --guids-file for reconcile:processed-bills.",
  `  --concurrency <n>    Bills planned at once (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  `  --rate <n>           Sends per second with --apply (default ${DEFAULT_RATE}, at most ${MAX_RATE})`,
  "",
  "Environment: AWS_PROFILE, AWS_REGION, BILLS_MANIFEST_TABLE_NAME, CONGRESS_MEMBERS_MANIFEST_TABLE_NAME, and",
  "reconcile:processed-bills' BILL_STORE_BUCKET, RAW_BILLS_PREFIX, BILL_DIFFER_QUEUE_URL (or _NAME).",
].join("\n");

type DdbSender = Pick<DynamoDBClient, "send">;
type Log = (...args: unknown[]) => void;

/** Every bioguide id in the members list. */
export const readMemberIds = async (ddb: DdbSender, config: SponsorBackfillConfig): Promise<Set<string>> => {
  const ids = new Set<string>();
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: config.membersTable,
        ProjectionExpression: "#pk",
        ExpressionAttributeNames: { "#pk": config.membersPk },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of response.Items ?? []) {
      const id = item[config.membersPk]?.S?.trim();
      if (id) ids.add(id);
    }
    startKey = response.LastEvaluatedKey;
  } while (startKey);
  return ids;
};

/** A manifest bill and its sponsors. */
export interface ManifestSponsors {
  guid: string;
  sponsors: string[];
}

/** Every BILL row of BillsManifest, guid and sponsors only. */
export const readManifestSponsors = async (
  ddb: DdbSender,
  config: SponsorBackfillConfig,
): Promise<ManifestSponsors[]> => {
  const bills: ManifestSponsors[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: config.billsManifestTable,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": config.billsManifestPk, "#guid": "guid", "#sponsors": "sponsors" },
        ExpressionAttributeValues: { ":pk": { S: config.billsManifestPkValue } },
        ProjectionExpression: "#guid, #sponsors",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of response.Items ?? []) {
      const guid = plainGuid(item.guid?.S ?? "");
      if (!guid) continue;
      const sponsors = (item.sponsors?.L ?? [])
        .map((value) => value.S?.trim() ?? "")
        .filter((value) => value.length > 0);
      bills.push({ guid, sponsors });
    }
    startKey = response.LastEvaluatedKey;
  } while (startKey);
  return bills;
};

export interface DepartedSponsorCount {
  bills: number;
  withSponsor: number;
  /** The bills with a sponsor not in the members list, sorted. */
  guids: string[];
  departedSponsors: number;
  byCongress: Record<string, number>;
}

/** The bills with at least one sponsor missing from the members list. */
export const countDepartedSponsorBills = (
  bills: readonly ManifestSponsors[],
  memberIds: ReadonlySet<string>,
): DepartedSponsorCount => {
  const guids = new Set<string>();
  const departed = new Set<string>();
  const byCongress: Record<string, number> = {};
  let withSponsor = 0;
  for (const bill of bills) {
    if (bill.sponsors.length === 0) continue;
    withSponsor += 1;
    const gone = bill.sponsors.filter((id) => !memberIds.has(id));
    if (gone.length === 0 || guids.has(bill.guid)) continue;
    guids.add(bill.guid);
    for (const id of gone) departed.add(id);
    const congress = String(congressOfBillGuid(bill.guid) ?? "unknown");
    byCongress[congress] = (byCongress[congress] ?? 0) + 1;
  }
  return { bills: bills.length, withSponsor, guids: [...guids].sort(), departedSponsors: departed.size, byCongress };
};

/** What the plan of each departed-sponsor bill comes to. */
export interface SponsorPlanSummary {
  /** A patch of sponsorDetails alone: this backfill's bills. */
  sponsorDetailsOnly: string[];
  /** A patch of other fields too (the raw bill moved on): left to reconcile:processed-bills. */
  otherPatches: string[];
  unchanged: number;
  /** summarize, awaiting_text, stale_raw or skipped: left to the pipeline. */
  otherPlans: number;
  unreadable: number;
}

export const isSponsorDetailsOnly = (bill: PlannedBill): boolean =>
  bill.plan.kind === "patch" && bill.plan.changedFields.length === 1 && bill.plan.changedFields[0] === "sponsorDetails";

export const summarizePlans = (planned: readonly PlannedBill[], unreadable: number): SponsorPlanSummary => ({
  sponsorDetailsOnly: planned.filter(isSponsorDetailsOnly).map((bill) => bill.guid),
  otherPatches: planned.filter((bill) => bill.plan.kind === "patch" && !isSponsorDetailsOnly(bill)).map((b) => b.guid),
  unchanged: planned.filter((bill) => bill.plan.kind === "unchanged").length,
  otherPlans: planned.filter((bill) => bill.plan.kind !== "patch" && bill.plan.kind !== "unchanged").length,
  unreadable,
});

export const planLine = (count: DepartedSponsorCount, members: number, plans: SponsorPlanSummary): string =>
  `Sponsor details plan: bills=${count.bills} withSponsor=${count.withSponsor} ` +
  `departedSponsorBills=${count.guids.length} departedSponsors=${count.departedSponsors} members=${members} ` +
  `sponsorDetailsOnly=${plans.sponsorDetailsOnly.length} otherPatches=${plans.otherPatches.length} ` +
  `unchanged=${plans.unchanged} otherPlans=${plans.otherPlans} unreadable=${plans.unreadable}`;

/** Thrown for a refusal before anything was sent (exit 2). */
export class RefusedError extends Error {}

export interface RunOptions {
  ddb: DdbSender;
  s3: Pick<S3Client, "send">;
  sqs: Pick<SQSClient, "send">;
  config: SponsorBackfillConfig;
  options: CliOptions;
  log?: Log;
  logError?: Log;
  writeFile?: (path: string, text: string) => void;
  fileExists?: (path: string) => boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface BackfillResult {
  count: DepartedSponsorCount;
  members: number;
  plans: SponsorPlanSummary | null;
  reconcile: RunResult | null;
}

export const runSponsorBackfill = async ({
  ddb,
  s3,
  sqs,
  config,
  options,
  log = console.log,
  logError = console.error,
  writeFile = (path, text) => writeFileSync(path, text, { flag: "wx" }),
  fileExists = existsSync,
  now,
  sleep,
}: RunOptions): Promise<BackfillResult> => {
  if (options.out && fileExists(options.out)) throw new RefusedError(`${options.out} exists; name a new file`);
  log(
    `backfill:sponsor-details mode=${options.apply ? "APPLY" : "DRY-RUN"} manifest=${config.billsManifestTable} ` +
      `members=${config.membersTable}`,
  );

  const memberIds = await readMemberIds(ddb, config);
  if (memberIds.size < MIN_CURRENT_MEMBERS) {
    throw new RefusedError(
      `The members list holds ${memberIds.size} members, fewer than ${MIN_CURRENT_MEMBERS}: a members run may be in ` +
        "progress, and every current member's bills would count. Nothing was planned or sent.",
    );
  }
  const count = countDepartedSponsorBills(await readManifestSponsors(ddb, config), memberIds);
  const congresses = Object.keys(count.byCongress).sort();
  log(
    `departed-sponsor bills by Congress: ${congresses.map((c) => `${c}=${count.byCongress[c]}`).join(" ") || "none"}`,
  );
  if (count.guids.length === 0) {
    log("No bill has a sponsor missing from the members list; nothing to plan.");
    return { count, members: memberIds.size, plans: null, reconcile: null };
  }

  // Read-only: the processed bill and the latest raw bill of each, planned with billDiffer's rule.
  const scan = await scanBills(
    s3,
    config.reconcile,
    { guids: count.guids, guidsFile: null, limit: null, concurrency: options.concurrency },
    { log },
  );
  const plans = summarizePlans(scan.planned, scan.unreadable.length);
  if (plans.otherPatches.length > 0) {
    log(
      `Behind on other fields too, not sent (reconcile:processed-bills --guids-file, RUNBOOK 4.1 window): ` +
        plans.otherPatches.join(", "),
    );
  }
  for (const entry of scan.unreadable) log(`unreadable: ${entry.key} (${entry.error})`);
  if (options.out) {
    const planOf = (bill: PlannedBill) => (isSponsorDetailsOnly(bill) ? "sponsorDetailsOnly" : bill.plan.kind);
    const lines = scan.planned.map((bill) => `${bill.guid}\t${planOf(bill)}`);
    writeFile(
      options.out,
      `# Bills whose sponsor is not in the members list (backfill:sponsor-details): guid<TAB>plan\n${lines.join("\n")}\n`,
    );
    log(`Wrote ${lines.length} bills to ${options.out}`);
  }
  log(planLine(count, memberIds.size, plans));

  if (!options.apply) {
    log(`Dry run: would send ${plans.sponsorDetailsOnly.length} guids (sponsorDetails patches only).`);
    return { count, members: memberIds.size, plans, reconcile: null };
  }
  if (options.expectBills !== plans.sponsorDetailsOnly.length) {
    throw new RefusedError(
      `--expect-bills ${options.expectBills} but ${plans.sponsorDetailsOnly.length} bills plan a sponsorDetails patch ` +
        "alone; run the dry run again and confirm the new count. Nothing was sent.",
    );
  }
  if (plans.sponsorDetailsOnly.length === 0) {
    log("Nothing to send.");
    return { count, members: memberIds.size, plans, reconcile: null };
  }

  // reconcile:processed-bills plans these bills again just before sending, and sends the patch plans only.
  const reconcile = await runReconcile({
    s3,
    sqs,
    config: config.reconcile,
    options: {
      help: false,
      apply: true,
      guids: plans.sponsorDetailsOnly,
      guidsFile: null,
      limit: null,
      concurrency: options.concurrency,
      rate: options.rate,
      plans: ["patch"],
      // Its bills are patches that only add sponsorDetails, which reconcile otherwise leaves out.
      addedFields: true,
    },
    log,
    logError,
    ...(now ? { now } : {}),
    ...(sleep ? { sleep } : {}),
  });
  return { count, members: memberIds.size, plans, reconcile };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const region = config.reconcile.region;
  const result = await runSponsorBackfill({
    ddb: new DynamoDBClient({ region }),
    s3: new S3Client({ region }),
    sqs: new SQSClient({ region }),
    config,
    options,
  });
  const unreadable = (result.plans?.unreadable ?? 0) + (result.reconcile?.scan.unreadable.length ?? 0);
  if ((result.reconcile?.failed.length ?? 0) > 0 || unreadable > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Sponsor details backfill failed", error instanceof Error ? error.message : error);
    process.exitCode = error instanceof RefusedError ? 2 : 1;
  });
}
