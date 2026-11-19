#!/usr/bin/env node

// Vetoed bills (project decision 2026-11-19): lists the BillsManifest rows of vetoed bills and whether each carries
// `vetoed`, the flag CreateBillsManifest writes from the processed bill's actions since this release
// (src/shared/billOutcomes.ts deriveBillVetoedFromActions). Rows written before it lack the flag until their next
// write; a rows-only replay (npm run backfill:bills-manifest -- --keys-file <file>) writes them now, and this script
// makes its keys file and predicts what the replay does to each row. It is also the check after the replay, and
// before app 1.3 is submitted: missing=0 stale=0.
//
// Strictly read-only: one consistent Query of the BILL partition (--guid: only those bills' rows), then one GetObject
// of processed-bills/<plain guid>.json per candidate. No other AWS call, and no write: the only file it writes is the
// local keys file. A candidate is a row whose billType is a bill or a joint resolution (hr, s, hjres, sjres;
// normalizeBillTypeCode, so the slugs a March row may carry count too) and whose billStatus is anything but Finalized,
// absent or unknown included, and any row that carries the flag, whatever its status or type, to find a stale one.
// The flag never reads the status, so neither does the choice: a vetoed bill derives Passed, or Failed once an
// override fails, but billDiffer keeps a stored Updated as it is (billSourceReconcile.ts MANAGED_BILL_STATUSES), and a
// veto whose passage lines are not coded derives New. Each of those rows gets the flag at its next write, and a row
// left out here would be neither listed nor counted, so missing=0 could pass while it lacks the flag. A Finalized row
// is the one left out: no client says VETOED on a law, whatever its row carries. So nearly every BILL row's document
// is read, one GetObject each: a few minutes for a whole Congress at the default concurrency. A row whose document
// cannot be read is "unreadable" (exit code 1).
//
// Each vetoed bill prints its guid and status, the veto's date and code (latestVetoAction), whether its row carries
// the flag, the row's date-basis version (d2, d1 or none), whether its contentHash is the document's billContentHash,
// whether the row is dated after the document's storedAt, and what a replay of the document would do to the row, as
// CreateBillsManifest's upsert decides it:
//   - in place: the row is dated by this document (its sort key is the document's storedAt, or up to 3 s after it with
//     the same or no hash, a March row), so the replay rewrites it at its own key;
//   - kept: the row is older than the document, and the document brings no news against what the row reflects (by its
//     date basis, else by an equal contentHash), so the replay rewrites it in place at its own date;
//   - may move: the row is older than the document, and the date decision may move it to the document's date, so it
//     shows as recently updated: its basis shows news, a d1 basis cannot tell (the S3 version before decides), the only
//     news is a text version (the raw copies decide), or with no basis the hash differs (the version before, else the
//     row's own status and date decide);
//   - skipped: the replay leaves the row as it is: it is dated after its document, it reflects a newer document
//     (documentStoredAt), or it is a legacy row of a suffixed guid (the replay writes the plain guid's row).
// A row that carries the flag while its document gives none (the bill became law, or both chambers overrode the veto,
// and the row missed that write) is listed as stale, with the same prediction.
//
// The keys file (--keys-file, vetoed-bills-keys-<UTC time>.txt by default, never overwritten) holds the key of each
// missing or stale row predicted "in place" or "kept", one processed-bills/<plain guid>.json per line, sorted, as
// backfill:bills-manifest --keys-file reads it. The others are listed apart, for a decision: wait for the row's next
// write, or a targeted update of the flag conditioned on the row's version, as relabel:ceremonial-rows does. Nothing is
// written when no row needs a replay. The last line is
//   Vetoed rows: rows= candidates= vetoed= missing= stale= unpredictable= unreadable=
// where unpredictable counts the missing and stale rows left out of the keys file.

import { writeFileSync } from "node:fs";
import { DynamoDBClient, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { normalizeBillTypeCode, plainBillGuid } from "../src/shared/billCompanions";
import { deriveBillVetoedFromActions, latestVetoAction } from "../src/shared/billOutcomes";
import { readProcessedSource } from "../src/shared/billSourceReconcile";
import {
  MANIFEST_CONTENT_HASH_ATTRIBUTE,
  MANIFEST_DATE_BASIS_ATTRIBUTE,
  billContentHash,
  contentHashChangeClass,
  isContentHash,
  manifestDateBasis,
  manifestDateJudgement,
  manifestTimestamp,
  parseDateBasis,
} from "../src/shared/billVersionChange";
import { mapWithConcurrency } from "../src/shared/concurrency";

type Item = Record<string, AttributeValue>;
type TableSender = Pick<DynamoDBClient, "send">;
type ObjectSender = Pick<S3Client, "send">;
type Log = (...args: unknown[]) => void;

// ─── Configuration and arguments ────────────────────────────────────────────

/** Bucket, table and key names; the defaults are production's (infra/lib/config). */
export interface ListConfig {
  region: string;
  bucket: string;
  processedPrefix: string;
  manifestTableName: string;
  manifestPrimaryKey: string;
  manifestPkValue: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): ListConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  processedPrefix: env.PROCESSED_BILLS_PREFIX || "processed-bills/",
  manifestTableName: env.MANIFEST_TABLE_NAME || "BillsManifest",
  manifestPrimaryKey: env.MANIFEST_PRIMARY_KEY || "pk",
  manifestPkValue: env.MANIFEST_PK_VALUE || "BILL",
});

export const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;
const KEYS_FILE_PREFIX = "vetoed-bills-keys-";

/** A row dated this long after its document's storedAt was dated by it (CreateBillsManifest's MAX_ROW_DATE_LAG_MS). */
const MAX_ROW_DATE_LAG_MS = 3_000;

/** The one status whose rows are not read: a law, which no client stamps VETOED (the candidates are at the top). */
const LAW_STATUS = "Finalized";
/** The types the President can veto: bills and joint resolutions. */
const CANDIDATE_TYPES = new Set(["hr", "s", "hjres", "sjres"]);

export interface CliOptions {
  help: boolean;
  /** Only these bills (plain guids). */
  guids: string[];
  /** Processed bills read at once. */
  concurrency: number;
  /** Where the keys go; null for the default name. */
  keysFile: string | null;
}

const valueAfter = (argv: readonly string[], index: number, flag: string, what: string): string => {
  const raw = argv[index];
  if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return raw;
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = { help: false, guids: [], concurrency: DEFAULT_CONCURRENCY, keysFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--guid") {
      const raw = argv[(index += 1)];
      const guid = raw && !raw.startsWith("--") ? plainBillGuid(raw) : null;
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hr131");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--concurrency") {
      const value = Number(valueAfter(argv, (index += 1), arg, "a number"));
      if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
        throw new Error(`--concurrency needs a whole number from 1 to ${MAX_CONCURRENCY}`);
      }
      options.concurrency = value;
    } else if (arg === "--keys-file") {
      options.keysFile = valueAfter(argv, (index += 1), arg, "a file path");
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
};

const USAGE = [
  "List the BillsManifest rows of vetoed bills, whether each carries the vetoed flag, and what a rows-only replay",
  "(backfill:bills-manifest --keys-file) would do to each (project decision 2026-11-19). Read-only.",
  "",
  "Usage:",
  "  npm run list:vetoed-bills                              Every BILL row",
  "  npm run list:vetoed-bills -- --guid BILLS-119hr131     Only this bill (repeatable)",
  "",
  "Options:",
  `  --keys-file <path>   Where the keys of the rows to replay go (default ${KEYS_FILE_PREFIX}<UTC time>.txt; never`,
  "                       overwritten, and not written when no row needs a replay)",
  "  --guid <guid>        Only this bill (repeatable; a text-version suffix is ignored)",
  `  --concurrency <n>    Processed bills read at once (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  "",
  "AWS calls: one consistent Query of the BILL partition and one GetObject per candidate row: every bill or joint",
  "resolution whose status is not Finalized (Updated, New, unknown or none included; the flag never reads the",
  "status), and every row that carries the flag. Nothing is written to AWS.",
  "Exit codes: 0 done; 1 a processed bill could not be read, or a usage error.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "PROCESSED_BILLS_PREFIX, MANIFEST_TABLE_NAME, MANIFEST_PRIMARY_KEY, MANIFEST_PK_VALUE",
].join("\n");

// ─── The candidates ──────────────────────────────────────────────────────────

/** Whether the row carries the flag as CreateBillsManifest writes it and the manifest builders serve it. */
export const rowCarriesVetoed = (row: Item): boolean => row.vetoed?.BOOL === true;

/**
 * Whether the row's processed bill is read: a bill or joint resolution whose status is anything but Finalized (a
 * stored Updated, a New, an unknown value or none included, as the flag never reads the status), or any row that
 * carries the flag.
 */
export const isCandidate = (row: Item): boolean => {
  if (rowCarriesVetoed(row)) return true;
  const code = normalizeBillTypeCode(row.billType?.S);
  return code !== null && CANDIDATE_TYPES.has(code) && row.billStatus?.S !== LAW_STATUS;
};

const guidOfRow = (row: Item): string => row.guid?.S ?? "";

/** Every BILL row, read consistently. */
export const queryBillRows = async (db: TableSender, config: ListConfig): Promise<Item[]> => {
  const rows: Item[] = [];
  let startKey: Item | undefined;
  do {
    const response = await db.send(
      new QueryCommand({
        TableName: config.manifestTableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": config.manifestPrimaryKey },
        ExpressionAttributeValues: { ":pk": { S: config.manifestPkValue } },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    rows.push(...(response.Items ?? []));
    startKey = response.LastEvaluatedKey;
  } while (startKey);
  return rows;
};

/** A processed bill as read: the parsed document and the S3 user metadata it was stored with. */
interface StoredDocument {
  document: unknown;
  metadata: Record<string, string> | undefined;
}

const readProcessedBill = async (s3: ObjectSender, config: ListConfig, guid: string): Promise<StoredDocument> => {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: `${config.processedPrefix}${guid}.json` }),
  );
  const body = await response.Body?.transformToString();
  if (!body) throw new Error("empty processed bill");
  return { document: JSON.parse(body), metadata: response.Metadata };
};

// ─── The replay's prediction ─────────────────────────────────────────────────

export const REPLAY_OUTCOMES = ["in place", "kept", "may move", "skipped"] as const;
export type ReplayOutcome = (typeof REPLAY_OUTCOMES)[number];

export interface ReplayPrediction {
  outcome: ReplayOutcome;
  /** What decided it, in a few words. */
  why: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The object CreateBillsManifest reads the status and actions from: content.rawSnapshot, else the document. */
const snapshotOf = (document: unknown): Record<string, unknown> => {
  const parsed = asRecord(document) ?? {};
  return asRecord(asRecord(parsed.content)?.rawSnapshot) ?? parsed;
};

/** The actions CreateBillsManifest derives the flag from: the snapshot's, else the document's. */
export const documentActions = (document: unknown): unknown[] => {
  const snapshot = snapshotOf(document);
  const parsed = asRecord(document) ?? {};
  if (Array.isArray(snapshot.actions)) return snapshot.actions;
  return Array.isArray(parsed.actions) ? parsed.actions : [];
};

/**
 * The date CreateBillsManifest gives the document (its resolveManifestUpdatedAt): the first readable of its storedAt
 * and its metadata's fetchedAt and pubDate, each on the document and then on the snapshot; null for none (the replay
 * would date it by the time it runs).
 */
export const documentDate = (document: unknown): string | null => {
  const parsed = asRecord(document) ?? {};
  const snapshot = snapshotOf(document);
  const metadata = asRecord(parsed.metadata);
  const snapshotMetadata = asRecord(snapshot.metadata);
  for (const candidate of [
    parsed.storedAt,
    snapshot.storedAt,
    metadata?.fetchedAt,
    snapshotMetadata?.fetchedAt,
    metadata?.pubDate,
    snapshotMetadata?.pubDate,
  ]) {
    const date = manifestTimestamp(candidate);
    if (date) return date;
  }
  return null;
};

/**
 * What a replay of the stored document does to the row (the outcomes are at the top of this file), in the order
 * CreateBillsManifest's upsert decides: a row dated after the document is skipped unless it is the row's own version,
 * a row that reflects a newer document is skipped, a row dated by the document is rewritten in place, and an older row
 * keeps its date unless the date decision finds news. `now` dates a document without a date, as the replay would.
 */
export const predictReplay = (row: Item, stored: StoredDocument, now: Date): ReplayPrediction => {
  const guid = guidOfRow(row);
  const plain = plainBillGuid(guid);
  if (plain !== guid) return { outcome: "skipped", why: `a row of the suffixed guid; the replay writes ${plain}'s` };
  const rowAt = manifestTimestamp(row.updatedAt?.S);
  if (!rowAt) return { outcome: "may move", why: "the row has no readable updatedAt" };
  const documentAt = documentDate(stored.document) ?? now.toISOString();
  const contentHash = billContentHash(stored.document);
  const rowHash = row[MANIFEST_CONTENT_HASH_ATTRIBUTE]?.S;

  if (rowAt > documentAt) {
    const lagMs = Date.parse(rowAt) - Date.parse(documentAt);
    const ownVersion = lagMs <= MAX_ROW_DATE_LAG_MS && (!isContentHash(rowHash) || rowHash === contentHash);
    if (!ownVersion) return { outcome: "skipped", why: "the row is dated after its document" };
  }
  const rowDocumentAt = manifestTimestamp(row.documentStoredAt?.S);
  if (rowAt !== documentAt && rowDocumentAt !== null && rowDocumentAt > documentAt) {
    return { outcome: "skipped", why: "the row reflects a newer document" };
  }
  if (rowAt >= documentAt) {
    return { outcome: "in place", why: rowAt === documentAt ? "dated by this document" : "the row's own version" };
  }

  const next = manifestDateBasis(stored.document, readProcessedSource(stored.metadata)?.textHash);
  const basis = parseDateBasis(row[MANIFEST_DATE_BASIS_ATTRIBUTE]?.S);
  if (basis) {
    const { moves, sameDay } = manifestDateJudgement(basis, next);
    if (sameDay === "unknown")
      return { outcome: "may move", why: "the d1 basis cannot tell; the version before decides" };
    if (moves.length === 0) return { outcome: "kept", why: `no news against the ${basis.version} basis` };
    if (moves.length === 1 && moves[0] === "textVersion") {
      return { outcome: "may move", why: "a new text version only; the raw copies decide" };
    }
    return { outcome: "may move", why: `news against the ${basis.version} basis: ${moves.join(", ")}` };
  }
  if (contentHashChangeClass(rowHash, contentHash) === "bookkeeping_only") {
    return { outcome: "kept", why: "no basis; the same contentHash" };
  }
  return { outcome: "may move", why: "no basis, and the hash differs; the version before, or the row, decides" };
};

// ─── One row ─────────────────────────────────────────────────────────────────

/** A candidate row as read against its processed bill. */
export type Assessment =
  | {
      guid: string;
      outcome: "read";
      /** The row's status, or "(none)". */
      status: string;
      /** What the document gives. */
      vetoed: boolean;
      carries: boolean;
      veto: { date: string; code: string } | null;
      basis: "d2" | "d1" | "none";
      /** Whether the row's contentHash is the document's: "yes", "no", or "none" when the row has none. */
      hashEqual: "yes" | "no" | "none";
      rowAfterDocument: boolean;
      key: string;
      prediction: ReplayPrediction;
    }
  | { guid: string; outcome: "unreadable"; detail: string };

/** Reads one candidate row's processed bill and judges the row against it. */
export const assessRow = async (
  deps: { s3: ObjectSender; config: ListConfig; now: () => Date },
  row: Item,
): Promise<Assessment> => {
  const guid = guidOfRow(row);
  const plain = plainBillGuid(guid);
  if (!plain) return { guid, outcome: "unreadable", detail: "not a bill guid" };
  let stored: StoredDocument;
  try {
    stored = await readProcessedBill(deps.s3, deps.config, plain);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { guid, outcome: "unreadable", detail: `${name}: ${message}` };
  }
  const actions = documentActions(stored.document);
  const veto = latestVetoAction(actions);
  const rowHash = row[MANIFEST_CONTENT_HASH_ATTRIBUTE]?.S;
  const rowAt = manifestTimestamp(row.updatedAt?.S);
  const documentAt = documentDate(stored.document);
  return {
    guid,
    outcome: "read",
    status: row.billStatus?.S || "(none)",
    vetoed: deriveBillVetoedFromActions(actions),
    carries: rowCarriesVetoed(row),
    veto: veto ? { date: veto.actionDate ?? "(no date)", code: veto.actionCode ?? "" } : null,
    basis: parseDateBasis(row[MANIFEST_DATE_BASIS_ATTRIBUTE]?.S)?.version ?? "none",
    hashEqual: rowHash === undefined ? "none" : rowHash === billContentHash(stored.document) ? "yes" : "no",
    rowAfterDocument: rowAt !== null && documentAt !== null && rowAt > documentAt,
    key: `${deps.config.processedPrefix}${plain}.json`,
    prediction: predictReplay(row, stored, deps.now()),
  };
};

// ─── The run ─────────────────────────────────────────────────────────────────

export interface ListSummary {
  rows: number;
  candidates: number;
  vetoed: number;
  missing: number;
  stale: number;
  unpredictable: number;
  unreadable: number;
}

export const summaryLine = (summary: ListSummary): string =>
  `Vetoed rows: rows=${summary.rows} candidates=${summary.candidates} vetoed=${summary.vetoed} ` +
  `missing=${summary.missing} stale=${summary.stale} unpredictable=${summary.unpredictable} ` +
  `unreadable=${summary.unreadable}`;

const fileStamp = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

export const defaultKeysFile = (at: Date): string => `${KEYS_FILE_PREFIX}${fileStamp(at)}.txt`;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a replay writes the row from its document without moving it. */
const safeToReplay = (prediction: ReplayPrediction): boolean =>
  prediction.outcome === "in place" || prediction.outcome === "kept";

type ReadAssessment = Extract<Assessment, { outcome: "read" }>;

const rowLine = (label: string, entry: ReadAssessment): string =>
  `  ${label} ${entry.guid} ${entry.status}: ` +
  `veto ${entry.veto ? `${entry.veto.date} (${entry.veto.code})` : "none"}; ` +
  `row flag ${entry.carries ? "yes" : "no"}; basis ${entry.basis}; hash equal ${entry.hashEqual}; ` +
  `row after document ${entry.rowAfterDocument ? "yes" : "no"}; replay: ${entry.prediction.outcome} ` +
  `(${entry.prediction.why})`;

export interface RunOptions {
  db: TableSender;
  s3: ObjectSender;
  config: ListConfig;
  options: CliOptions;
  log?: Log;
  now?: () => Date;
  /** Creates a file; it must not exist. */
  createFile?: (path: string, text: string) => void;
}

export interface RunResult {
  exitCode: 0 | 1;
  summary: ListSummary;
  keysFile?: string;
  keys: string[];
}

/** Lists the vetoed bills' rows and writes the keys file of the rows to replay. */
export const runListVetoedBills = async ({
  db,
  s3,
  config,
  options,
  log = console.log,
  now = () => new Date(),
  createFile = (path: string, text: string) => writeFileSync(path, text, { encoding: "utf8", flag: "wx" }),
}: RunOptions): Promise<RunResult> => {
  log(
    `list:vetoed-bills table=${config.manifestTableName} bucket=${config.bucket}` +
      (options.guids.length > 0 ? ` guids=${options.guids.join(",")}` : ""),
  );
  const allRows = await queryBillRows(db, config);
  const rows =
    options.guids.length > 0
      ? allRows.filter((row) => options.guids.includes(plainBillGuid(guidOfRow(row)) ?? guidOfRow(row)))
      : allRows;
  const candidates = rows.filter(isCandidate);
  log(
    `Read ${rows.length} BILL rows: ${candidates.length} candidates (a bill or joint resolution that is not ` +
      `Finalized, or carrying the flag); reading their processed bills under s3://${config.bucket}/` +
      config.processedPrefix,
  );
  const assessments = (
    await mapWithConcurrency(candidates, options.concurrency, (row) => assessRow({ s3, config, now }, row))
  ).sort((a, b) => compareText(a.guid, b.guid));

  const read = assessments.filter((entry): entry is ReadAssessment => entry.outcome === "read");
  const vetoed = read.filter((entry) => entry.vetoed);
  const stale = read.filter((entry) => !entry.vetoed && entry.carries);
  const toReplay = [...vetoed.filter((entry) => !entry.carries), ...stale];
  const keys = Array.from(new Set(toReplay.filter((entry) => safeToReplay(entry.prediction)).map((e) => e.key))).sort(
    compareText,
  );
  const leftOut = toReplay.filter((entry) => !safeToReplay(entry.prediction));

  for (const entry of vetoed) log(rowLine(entry.carries ? "vetoed" : "missing", entry));
  for (const entry of stale) log(rowLine("stale", entry));
  for (const entry of assessments) {
    if (entry.outcome === "unreadable") log(`  unreadable ${entry.guid}: ${entry.detail}`);
  }
  if (leftOut.length > 0) {
    log(
      `Not in the keys file, for a decision (wait for the row's next write, or a targeted update conditioned on ` +
        `the row's version): ${leftOut.map((entry) => `${entry.guid} (${entry.prediction.outcome})`).join(", ")}`,
    );
  }

  let keysFile: string | undefined;
  if (keys.length > 0) {
    keysFile = options.keysFile ?? defaultKeysFile(now());
    createFile(keysFile, keys.map((key) => `${key}\n`).join(""));
    log(`Keys: ${keys.length} in ${keysFile}, for npm run backfill:bills-manifest -- --keys-file ${keysFile}`);
  } else {
    log("Keys: no row to replay; no keys file written");
  }

  const summary: ListSummary = {
    rows: rows.length,
    candidates: candidates.length,
    vetoed: vetoed.length,
    missing: vetoed.filter((entry) => !entry.carries).length,
    stale: stale.length,
    unpredictable: leftOut.length,
    unreadable: assessments.length - read.length,
  };
  log("Read-only: nothing was written to AWS.");
  log(summaryLine(summary));
  return { exitCode: summary.unreadable > 0 ? 1 : 0, summary, keys, ...(keysFile ? { keysFile } : {}) };
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  const { exitCode } = await runListVetoedBills({
    db: new DynamoDBClient({ region: config.region }),
    s3: new S3Client({ region: config.region }),
    config,
    options,
  });
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Vetoed bills listing failed", error);
    process.exitCode = 1;
  });
}
