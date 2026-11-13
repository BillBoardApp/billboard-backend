#!/usr/bin/env node

// Backfill for APPF-23 companion bills. billDiffer keeps each bill's identical-bill link list in
// the BillsManifest table from now on, but only when a raw bill is written; this seeds the rows for
// every raw bill already stored. It reads raw-bills/ (in memory, never to disk), extracts each
// bill's links, compares them with the stored link lists, builds the held set from the manifest
// and reports the groups the resolver would publish. Dry run by default: reads only.
//
// --apply writes the planned rows with the same freshness condition billDiffer uses (a row from
// newer raw data is never overwritten; it counts as stale-skipped). It writes nothing else: no S3
// objects, so no billDiffer, manifest, notification or member-stats runs, and no Bedrock or
// Congress.gov calls. The next PublishBillsManifest run (every 10 minutes) picks the rows up;
// --publish-now invokes it at once and prints the CURRENT groups row it wrote.

import { execFileSync } from "node:child_process";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import {
  activeCompanionPairs,
  BillCompanionDao,
  type BillCompanionConfig,
  billCompanionConfigFromEnv,
  type CompanionGroupsState,
} from "../src/adapters/billCompanionDao";
import {
  companionCandidateGraph,
  extractIdenticalDeclarations,
  parseBillGuid,
  plainBillGuid,
  resolveCompanionGroups,
  sameDeclaredLinks,
  type BillTypeCode,
  type CompanionDeclaration,
  type CompanionPair,
} from "../src/shared/billCompanions";
import { buildBillsManifest } from "../src/shared/billsManifestBuilder";
import { mapWithConcurrency } from "../src/shared/concurrency";

export const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 25;
const SAMPLE_SIZE = 20;
const PROGRESS_INTERVAL = 1000;

export interface CliOptions {
  help: boolean;
  apply: boolean;
  /** Plain guids to scan instead of every raw bill. */
  guids: string[];
  maxItems: number | null;
  concurrency: number;
  publishNow: boolean;
}

/** Parses the flags; unknown flags and bad values are rejected. */
export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    guids: [],
    maxItems: null,
    concurrency: DEFAULT_CONCURRENCY,
    publishNow: false,
  };
  const readValue = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--") || raw.trim().length === 0) {
      throw new Error(`${flag} requires a value`);
    }
    return raw.trim();
  };
  const readPositive = (flag: string, raw: string | undefined, max: number): number => {
    const value = Number(readValue(flag, raw));
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`${flag} needs a whole number from 1 to ${max}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--publish-now") options.publishNow = true;
    else if (arg === "--max-items") options.maxItems = readPositive(arg, argv[(index += 1)], Number.MAX_SAFE_INTEGER);
    else if (arg === "--concurrency") options.concurrency = readPositive(arg, argv[(index += 1)], MAX_CONCURRENCY);
    else if (arg === "--guid") {
      const raw = readValue(arg, argv[(index += 1)]);
      const plain = plainBillGuid(raw);
      if (!plain) throw new Error(`--guid needs a bill guid like BILLS-119hr1285 (got ${raw})`);
      if (!options.guids.includes(plain)) options.guids.push(plain);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.publishNow && !options.apply) throw new Error("--publish-now needs --apply");
  return options;
};

export const USAGE = [
  "Seed the companion-bill link lists (APPF-23) from the stored raw bills.",
  "",
  "Usage:",
  "  AWS_PROFILE=billboard AWS_REGION=us-east-1 npm run backfill:bill-companions",
  "      Dry run: reads raw bills, link lists and the manifest; prints the report; no writes",
  "  npm run backfill:bill-companions -- --apply [--publish-now]",
  "",
  "Options:",
  "  --apply             Write the planned link lists (conditional puts and deletes)",
  "  --guid <guid>       Scan only this bill (repeatable); other stored rows are kept as they are",
  "  --max-items <n>     Scan only the first n raw bills (by key)",
  `  --concurrency <n>   Raw bill reads and writes in flight (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  "  --publish-now       With --apply: invoke PublishBillsManifest:prod, then print the CURRENT groups row",
  "",
  "Environment: AWS_PROFILE, AWS_REGION (default us-east-1), BILL_STORE_BUCKET (default",
  "billboard-bill-store-bucket), MANIFEST_TABLE_NAME (default BillsManifest), RAW_BILLS_PREFIX",
  "(default raw-bills/), PUBLISH_BILLS_MANIFEST_FUNCTION (default PublishBillsManifest:prod).",
].join("\n");

export interface BackfillConfig {
  region: string;
  bucket: string;
  rawPrefix: string;
  publishFunction: string;
  companions: BillCompanionConfig;
  /** The manifest's BILL partition, for the held set. */
  manifestPkValue: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): BackfillConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || "billboard-bill-store-bucket",
  rawPrefix: env.RAW_BILLS_PREFIX || "raw-bills/",
  publishFunction: env.PUBLISH_BILLS_MANIFEST_FUNCTION || "PublishBillsManifest:prod",
  // Only the manifest table name is taken from the environment; the key names are the table's.
  companions: billCompanionConfigFromEnv({ MANIFEST_TABLE_NAME: env.MANIFEST_TABLE_NAME || "BillsManifest" }),
  manifestPkValue: "BILL",
});

type S3Sender = Pick<S3Client, "send">;
type DdbSender = Pick<DynamoDBClient, "send">;
type Log = (...args: unknown[]) => void;

export type PlannedAction = "put" | "delete" | "unchanged" | "stale";

export interface PlannedRow {
  declaration: CompanionDeclaration;
  action: PlannedAction;
}

export interface BackfillReport {
  mode: "DRY-RUN" | "APPLY";
  raw: { scanned: number; unreadable: number; identityUnresolved: number; truncated: number };
  declarations: { withIdentical: number; put: number; delete: number; unchanged: number; staleSkipped: number };
  links: { oneWay: number; counterpart: number; sameChamber: number; crossKind: number; crossCongress: number };
  held: number;
  groups: {
    total: number;
    byKind: Record<"hr-s" | "hjres-sjres" | "hres-sres" | "hconres-sconres", number>;
    oneSided: number;
  };
  ambiguousHeld: string[];
  ambiguousNotHeld: number;
  partnerNotHeld: number;
  pairs: CompanionPair[];
  current: CompanionGroupsState | null;
  wouldAdd: number;
  wouldRemove: number;
  applied?: { written: number; deleted: number; staleSkipped: number; failed: number };
  publishOutput?: string;
  currentAfterPublish?: CompanionGroupsState | null;
}

export interface RunOptions {
  options: CliOptions;
  config: BackfillConfig;
  s3: S3Sender;
  ddb: DdbSender;
  /** Invokes PublishBillsManifest synchronously and returns its output (--publish-now). */
  invokePublish?: (functionName: string, region: string) => string;
  log?: Log;
  logError?: Log;
}

const KIND_OF: Record<BillTypeCode, keyof BackfillReport["groups"]["byKind"]> = {
  hr: "hr-s",
  s: "hr-s",
  hjres: "hjres-sjres",
  sjres: "hjres-sjres",
  hres: "hres-sres",
  sres: "hres-sres",
  hconres: "hconres-sconres",
  sconres: "hconres-sconres",
};

const shortName = (guid: string): string => {
  const parsed = parseBillGuid(guid);
  return parsed ? `${parsed.billType}${parsed.billNumber}` : guid;
};

const listRawKeys = async (s3: S3Sender, config: BackfillConfig, options: CliOptions): Promise<string[]> => {
  let keys: string[];
  if (options.guids.length > 0) {
    keys = options.guids.map((guid) => `${config.rawPrefix}${guid}.json`);
  } else {
    keys = [];
    let continuationToken: string | undefined;
    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: config.rawPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response?.Contents ?? []) {
        if (typeof object.Key === "string" && object.Key.endsWith(".json")) keys.push(object.Key);
      }
      continuationToken = response?.NextContinuationToken;
    } while (continuationToken);
  }
  keys.sort();
  return options.maxItems ? keys.slice(0, options.maxItems) : keys;
};

type ScanResult =
  | { kind: "unreadable"; key: string; reason: string }
  | { kind: "unresolved"; key: string; truncated: boolean }
  | { kind: "declaration"; key: string; declaration: CompanionDeclaration };

const readRawBill = async (s3: S3Sender, bucket: string, key: string): Promise<ScanResult> => {
  let text: string | undefined;
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    text = await response?.Body?.transformToString();
  } catch (error) {
    return { kind: "unreadable", key, reason: error instanceof Error ? error.name || error.message : String(error) };
  }
  if (!text) return { kind: "unreadable", key, reason: "empty body" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unreadable", key, reason: "invalid JSON" };
  }
  const declaration = extractIdenticalDeclarations(raw, key);
  if (!declaration) {
    const next = (raw as { content?: { relatedBills?: { pagination?: { next?: unknown } } } })?.content?.relatedBills
      ?.pagination?.next;
    return { kind: "unresolved", key, truncated: typeof next === "string" && next.length > 0 };
  }
  return { kind: "declaration", key, declaration };
};

const planRow = (declaration: CompanionDeclaration, stored: CompanionDeclaration | undefined): PlannedAction => {
  if (declaration.declared.length === 0) {
    if (!stored) return "unchanged";
    return stored.sourceFetchedAt > declaration.sourceFetchedAt ? "stale" : "delete";
  }
  if (stored && sameDeclaredLinks(stored, declaration)) return "unchanged";
  if (stored && stored.sourceFetchedAt > declaration.sourceFetchedAt) return "stale";
  return "put";
};

const pairId = (pair: readonly string[]): string => pair.join("|");

const describeCurrent = (state: CompanionGroupsState | null): string =>
  state
    ? `pairsVersion=${state.pairsVersion} enabled=${state.enabled} groups=${state.pairs.length} resolvedAt=${state.resolvedAt || "-"}`
    : "missing (PublishBillsManifest has not written it yet)";

/** Scans, plans, prints the report and, with --apply, writes. */
export const runBackfill = async ({
  options,
  config,
  s3,
  ddb,
  invokePublish,
  log = console.log,
  logError = console.error,
}: RunOptions): Promise<BackfillReport> => {
  const dao = new BillCompanionDao(ddb, config.companions);
  const mode = options.apply ? "APPLY" : "DRY-RUN";
  log(
    `backfill:bill-companions mode=${mode} bucket=${config.bucket} table=${config.companions.tableName}` +
      (options.guids.length > 0 ? ` guids=${options.guids.join(",")}` : "") +
      (options.maxItems ? ` max-items=${options.maxItems}` : ""),
  );

  // 1-3: raw bills and their link lists.
  const keys = await listRawKeys(s3, config, options);
  let done = 0;
  const scanned = await mapWithConcurrency(keys, options.concurrency, async (key) => {
    const result = await readRawBill(s3, config.bucket, key);
    done += 1;
    if (done % PROGRESS_INTERVAL === 0) log(`  read ${done} / ${keys.length} raw bills...`);
    return result;
  });
  const raw = { scanned: keys.length, unreadable: 0, identityUnresolved: 0, truncated: 0 };
  const extracted: CompanionDeclaration[] = [];
  for (const result of scanned) {
    if (result.kind === "unreadable") {
      raw.unreadable += 1;
      logError(`  unreadable raw bill ${result.key}: ${result.reason}`);
    } else if (result.kind === "unresolved") {
      raw.identityUnresolved += 1;
      if (result.truncated) raw.truncated += 1;
      logError(`  identity unresolved: ${result.key}`);
    } else {
      extracted.push(result.declaration);
      if (result.declaration.truncated) raw.truncated += 1;
    }
  }

  // 4-5: compare with the stored link lists and plan.
  const stored = new Map((await dao.listDeclarations()).map((row) => [row.guid, row]));
  const planned: PlannedRow[] = extracted.map((declaration) => ({
    declaration,
    action: planRow(declaration, stored.get(declaration.guid)),
  }));
  const declarations = {
    withIdentical: extracted.filter((declaration) => declaration.declared.length > 0).length,
    put: planned.filter((row) => row.action === "put").length,
    delete: planned.filter((row) => row.action === "delete").length,
    unchanged: planned.filter((row) => row.action === "unchanged" && row.declaration.declared.length > 0).length,
    staleSkipped: planned.filter((row) => row.action === "stale").length,
  };
  const rowsAfter = new Map(stored);
  for (const { declaration, action } of planned) {
    if (action === "put") rowsAfter.set(declaration.guid, declaration);
    else if (action === "delete") rowsAfter.delete(declaration.guid);
  }
  const plannedRows = [...rowsAfter.values()];

  // 6: held = the plain guids of the manifest (read-only build, no priority merge).
  const manifest = await buildBillsManifest({
    ddb: ddb as DynamoDBClient,
    tableName: config.companions.tableName,
    primaryKey: config.companions.primaryKey,
    pkValue: config.manifestPkValue,
    priorityDao: null,
  });
  const held = new Set<string>();
  for (const bill of manifest.bills) {
    const parsed = parseBillGuid(bill.guid);
    if (parsed && parsed.suffix === "") held.add(parsed.plainGuid);
  }

  // 7: resolve on the planned rows and report.
  const graph = companionCandidateGraph(plannedRows);
  const resolution = resolveCompanionGroups(plannedRows, (guid) => held.has(guid));
  const byKind = { "hr-s": 0, "hjres-sjres": 0, "hres-sres": 0, "hconres-sconres": 0 };
  for (const [primary] of resolution.pairs) {
    const parsed = parseBillGuid(primary);
    if (parsed) byKind[KIND_OF[parsed.billType]] += 1;
  }
  const ambiguousNotHeld = [...graph.candidates].filter(
    ([guid, candidates]) => candidates.size > 1 && !held.has(guid),
  ).length;
  const current = await dao.getCurrentGroups();
  const currentIds = new Set((current?.pairs ?? []).map(pairId));
  const resolvedIds = new Set(resolution.pairs.map(pairId));
  const wouldAdd = resolution.pairs.filter((pair) => !currentIds.has(pairId(pair))).length;
  const wouldRemove = (current?.pairs ?? []).filter((pair) => !resolvedIds.has(pairId(pair))).length;
  const links = {
    oneWay: graph.links.counterpart + graph.links.sameChamber + graph.links.crossKind + graph.links.crossCongress,
    ...graph.links,
  };

  const report: BackfillReport = {
    mode,
    raw,
    declarations,
    links,
    held: held.size,
    groups: { total: resolution.pairs.length, byKind, oneSided: resolution.oneSided },
    ambiguousHeld: resolution.ambiguous,
    ambiguousNotHeld,
    partnerNotHeld: resolution.excluded.partnerNotHeld,
    pairs: resolution.pairs,
    current,
    wouldAdd,
    wouldRemove,
  };

  log(
    `raw bills: scanned=${raw.scanned} unreadable=${raw.unreadable} identity-unresolved=${raw.identityUnresolved} truncated(pagination.next)=${raw.truncated}`,
  );
  log(
    `declarations: with-identical=${declarations.withIdentical} put=${declarations.put} delete=${declarations.delete} unchanged=${declarations.unchanged} stale-skipped=${declarations.staleSkipped}`,
  );
  log(
    `links: one-way=${links.oneWay} counterpart=${links.counterpart} same-chamber=${links.sameChamber} cross-kind=${links.crossKind} cross-congress=${links.crossCongress}`,
  );
  log(`held (plain manifest guids)=${held.size}`);
  log(
    `groups: total=${resolution.pairs.length} hr-s=${byKind["hr-s"]} hjres-sjres=${byKind["hjres-sjres"]} hres-sres=${byKind["hres-sres"]} hconres-sconres=${byKind["hconres-sconres"]} one-sided=${resolution.oneSided}`,
  );
  const ambiguousList = [
    ...resolution.ambiguous.map(shortName),
    ...(ambiguousNotHeld > 0 ? [`+${ambiguousNotHeld} not held`] : []),
  ];
  log(
    `not grouped: ambiguous=${resolution.ambiguous.length + ambiguousNotHeld} [${ambiguousList.join(", ")}] partner-not-held=${resolution.excluded.partnerNotHeld}`,
  );
  log(
    `CURRENT: ${describeCurrent(current)} -> resolver would publish +${wouldAdd} -${wouldRemove}${current?.enabled ? "" : " (once enabled)"}`,
  );
  const sampleCount = Math.min(SAMPLE_SIZE, resolution.pairs.length);
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const position = sampleCount === 1 ? 0 : Math.round((index * (resolution.pairs.length - 1)) / (sampleCount - 1));
    const [primary, other] = resolution.pairs[position];
    const both = graph.declares(primary, other) && graph.declares(other, primary);
    const side = both
      ? "both sides"
      : `listed by ${graph.declares(primary, other) ? shortName(primary) : shortName(other)} only`;
    return `${primary}=${other} (${side})`;
  });
  log(`samples(${sampleCount}): ${samples.join(" ")}`);

  if (!options.apply) {
    log("DRY-RUN: nothing was written. Re-run with --apply to write the link lists.");
    return report;
  }

  // --apply: the conditional writes.
  const applied = { written: 0, deleted: 0, staleSkipped: 0, failed: 0 };
  const writes = planned.filter((row) => row.action === "put" || row.action === "delete");
  await mapWithConcurrency(writes, options.concurrency, async ({ declaration, action }) => {
    try {
      const outcome =
        action === "put"
          ? await dao.putDeclaration(declaration)
          : await dao.deleteDeclaration(declaration.guid, declaration.sourceFetchedAt);
      if (outcome === "written") applied.written += 1;
      else if (outcome === "deleted") applied.deleted += 1;
      else applied.staleSkipped += 1;
    } catch (error) {
      applied.failed += 1;
      logError(`  failed to ${action} the link list of ${declaration.guid}`, error);
    }
  });
  report.applied = applied;
  log(
    `applied: written=${applied.written} deleted=${applied.deleted} stale-skipped=${applied.staleSkipped} failed=${applied.failed}`,
  );

  if (options.publishNow) {
    if (!invokePublish) throw new Error("--publish-now needs a way to invoke the publisher");
    log(`invoking ${config.publishFunction}...`);
    report.publishOutput = invokePublish(config.publishFunction, config.region);
    log(report.publishOutput.trim());
    report.currentAfterPublish = await dao.getCurrentGroups();
    log(`CURRENT after publish: ${describeCurrent(report.currentAfterPublish)}`);
    log(`active groups: ${activeCompanionPairs(report.currentAfterPublish).length}`);
  } else {
    log("The next PublishBillsManifest run (at most 10 minutes) resolves the groups from these rows.");
  }
  return report;
};

/** Invokes the publisher through the AWS CLI (it uses AWS_PROFILE and the region given). */
const invokePublishWithCli = (functionName: string, region: string): string =>
  execFileSync(
    "aws",
    [
      "lambda",
      "invoke",
      "--function-name",
      functionName,
      "--payload",
      "{}",
      "--cli-binary-format",
      "raw-in-base64-out",
      "--region",
      region,
      "--no-cli-pager",
      "/dev/stdout",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  // The shared modules log JSON lines at info level; keep the report readable.
  process.env.LOG_LEVEL ??= "warn";
  const config = configFromEnv();
  const report = await runBackfill({
    options,
    config,
    s3: new S3Client({ region: config.region }),
    ddb: new DynamoDBClient({ region: config.region }),
    invokePublish: invokePublishWithCli,
  });
  if ((report.applied?.failed ?? 0) > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("backfill:bill-companions failed", error);
    process.exitCode = 1;
  });
}
