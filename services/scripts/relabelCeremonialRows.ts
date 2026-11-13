#!/usr/bin/env node

// S6 (2026-10-29): takes the topics (subCategories) off the BillsManifest rows of ceremonial resolutions,
// and any life areas left on them, without moving a row or sending a push (docs/RUNBOOK.md 4.12). Since this release
// CreateBillsManifest writes both lists empty for such a resolution at the row's next write (a new version or a
// replay); this script relabels the rows that are there now. Dry run by default.
//
// Dry run (reads only): every BILL row of BillsManifest, with one consistent Query (--guid: only those bills' rows). A
// row is a candidate when its billType is a simple or concurrent resolution (normalizeBillTypeCode, so the slugs a
// March row may carry, "house-resolution" and the rest, count too) and it carries a topic or a life area. Each
// candidate's processed bill (processed-bills/<plain guid>.json, one GetObject) decides as CreateBillsManifest does
// (processedBillCommemorativeInput, isCommemorativeResolution): a ceremonial resolution is planned, any other is listed
// as "not ceremonial" (with what decided) and left alone, and a row whose document cannot be read is "unreadable" (exit
// code 1). What decides is the bill's curated override when there is one ("curated override", 2026-10-29: the rows
// in CURATED_OVERRIDES in commemorativeResolutions.ts; "curated override, companion of <guid>" for a bill an override
// is carried to, CURATED_OVERRIDE_COMPANIONS), else the hold of a bill held for review ("held for review": not
// ceremonial until it is reviewed, HELD_FOR_REVIEW), else the official title ("official title"), else the headline
// ("headline"). Each planned row prints its guid, what decided, its headline, its topics and
// life areas before -> after, and its official title; a row the headline decided also prints what the bill does
// (billBreakdown.what, else soWhat), as a paraphrase can drop what makes a resolution more than ceremonial, so the
// reviewer reads those rows with it (byHeadline counts them). The plan goes to --plan-file
// (relabel-ceremonial-rows-plan-<UTC time>.jsonl by default, never overwritten), one line per row, sorted by guid: its
// key, the lists it empties as read, and the row's version as read (officialTitle null: the bill has none). A row the
// review leaves out is taken out of the plan file before --apply (RUNBOOK 4.12). The last line is
//   Ceremonial relabel plan: rows= resolutions= labelled= planned= byHeadline= withTopics= withLifeAreas=
//   notCeremonial= unreadable=
//
// --apply --plan-file <reviewed plan> [--guid <guid>] applies that plan's lines only, never a fresh plan. It refuses to
// start (exit code 2) when a line is not ceremonial under this checkout's rule, judged by the line's own guid, type and
// titles (a curated override or a hold since the dry run, or a plan an older rule made: plans of 2026-10-29 before the
// curated overrides list BILLS-119hres1365, hconres107 and hres1304, those before their second round hres955 and
// hconres112, and those before the bills held for review sres854 and others), or unless BillsManifestQueue and
// BillsManifestDLQ hold no message (visible, in flight or delayed), so no CreateBillsManifest write of these rows is
// pending. Per line, paced (--rate, default 5 a second): one consistent GetItem of the row at the plan's sort key,
// then one UpdateItem that sets only the planned lists to [], conditioned on the row's updatedAt, contentHash,
// dateBasis and documentStoredAt being the plan's (or absent when they were) and the planned lists being as planned. Outcomes: applied; alreadyApplied (the
// planned lists are already empty: a rerun, or CreateBillsManifest relabelled the row); superseded (the row's version
// or lists changed since the dry run: take it again); moved (no row at that key any more: the bill's date moved, and
// CreateBillsManifest wrote its new row from the document, without the lists since this release); failed (exit code 1).
// A conditional write that fails is read again and reported as one of those. Each applied line's undo record is
// appended to --undo-file (relabel-ceremonial-rows-undo-<UTC time>.jsonl, created before the first write) before the
// next line starts; Ctrl-C lets the line in flight finish. A rerun is idempotent: a written line reports alreadyApplied
// and writes nothing.
//
// --undo <undo file or plan file> [--apply]: puts the lists back on each row still at its key with the record's version
// and the planned lists empty ("changedSince" or "moved" otherwise); a dry run unless --apply, which is paced and also
// refuses while the queues hold messages. Undo only with this release's CreateBillsManifest rolled back: it clears the
// lists again at a row's next write.
//
// No push and no date move. The only write is that UpdateItem on a BILL row: its sort key, updatedAt, guid lookup,
// contentHash, dateBasis, documentStoredAt and vote count stay. The BillsManifest table has no stream (UserStore's
// table is the only one with a stream), so a row write reaches no Lambda; there is no S3 write (so no BillsManifestQueue
// event and no NotificationType message), no SQS send and no Bedrock call. Devices take the new lists from the snapshot
// PublishBillsManifest writes (RUNBOOK 11.3) and from windowed fetches while a row is in the window.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";

import { normalizeBillTypeCode, plainBillGuid } from "../src/shared/billCompanions";
import { MANIFEST_CONTENT_HASH_ATTRIBUTE, MANIFEST_DATE_BASIS_ATTRIBUTE } from "../src/shared/billVersionChange";
import {
  heldForReview,
  isCommemorativeResolution,
  curatedCommemorativeOverride,
  curatedOverrideCompanionOf,
  processedBillCommemorativeInput,
} from "../src/shared/commemorativeResolutions";
import { mapWithConcurrency } from "../src/shared/concurrency";
import { sleep as sleepMs } from "../src/shared/retry";

type Item = Record<string, AttributeValue>;
type TableSender = Pick<DynamoDBClient, "send">;
type ObjectSender = Pick<S3Client, "send">;
type QueueSender = Pick<SQSClient, "send">;
type Log = (...args: unknown[]) => void;

// ─── Configuration and arguments ────────────────────────────────────────────

/** Bucket, table, key and queue names; the defaults are production's (infra/lib/config). */
export interface RelabelConfig {
  region: string;
  bucket: string;
  processedPrefix: string;
  manifestTableName: string;
  manifestPrimaryKey: string;
  manifestSortKey: string;
  manifestPkValue: string;
  manifestQueueName: string;
  manifestDlqName: string;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): RelabelConfig => ({
  region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1",
  bucket: env.BILL_STORE_BUCKET || env.BUCKET_NAME || "billboard-bill-store-bucket",
  processedPrefix: env.PROCESSED_BILLS_PREFIX || "processed-bills/",
  manifestTableName: env.MANIFEST_TABLE_NAME || "BillsManifest",
  manifestPrimaryKey: env.MANIFEST_PRIMARY_KEY || "pk",
  manifestSortKey: env.MANIFEST_SORT_KEY || "sk",
  manifestPkValue: env.MANIFEST_PK_VALUE || "BILL",
  manifestQueueName: env.BILLS_MANIFEST_QUEUE_NAME || "BillsManifestQueue",
  manifestDlqName: env.BILLS_MANIFEST_DLQ_NAME || "BillsManifestDLQ",
});

export const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;
/** Row writes a second, at most: a few hundred rows take about a minute, far below the table's capacity. */
export const DEFAULT_RATE = 5;
const MAX_RATE = 10;
const PLAN_FILE_PREFIX = "relabel-ceremonial-rows-plan-";
const UNDO_FILE_PREFIX = "relabel-ceremonial-rows-undo-";

/** The row's lists a ceremonial resolution has none of (CreateBillsManifest writes them empty since this release). */
export const CLEARED_LISTS = ["subCategories", "lifeAreas"] as const;
export type ClearedList = (typeof CLEARED_LISTS)[number];
/**
 * The row attributes every CreateBillsManifest write of another version changes (and a re-date moves the key itself):
 * equal as read, the row still reflects the document the dry run judged.
 */
export const VERSION_ATTRIBUTES = [
  "updatedAt",
  MANIFEST_CONTENT_HASH_ATTRIBUTE,
  MANIFEST_DATE_BASIS_ATTRIBUTE,
  "documentStoredAt",
] as const;
export type VersionAttribute = (typeof VERSION_ATTRIBUTES)[number];

const RESOLUTION_TYPES = new Set(["hres", "sres", "hconres", "sconres"]);

export interface CliOptions {
  help: boolean;
  apply: boolean;
  /** Only these bills (plain guids). */
  guids: string[];
  /** Processed bills read at once in the dry run. */
  concurrency: number;
  /** Row writes a second, at most. */
  rate: number;
  /** The dry run's output, or the plan --apply applies; null for the default name (dry run only). */
  planFile: string | null;
  /** Where --apply appends the undo records; null for the default name. */
  undoFile: string | null;
  /** An undo file (or a plan file) whose lists to put back (dry run unless --apply). */
  undo: string | null;
}

const valueAfter = (argv: readonly string[], index: number, flag: string, what: string): string => {
  const raw = argv[index];
  if (!raw || raw.startsWith("--")) throw new Error(`${flag} needs ${what}`);
  return raw;
};

const wholeNumber = (raw: string, flag: string, min: number, max: number): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${flag} needs a whole number from ${min} to ${max}`);
  }
  return value;
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const options: CliOptions = {
    help: false,
    apply: false,
    guids: [],
    concurrency: DEFAULT_CONCURRENCY,
    rate: DEFAULT_RATE,
    planFile: null,
    undoFile: null,
    undo: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--guid") {
      const raw = argv[(index += 1)];
      const guid = raw && !raw.startsWith("--") ? plainBillGuid(raw) : null;
      if (!guid) throw new Error("--guid needs a bill guid such as BILLS-119hres1572");
      if (!options.guids.includes(guid)) options.guids.push(guid);
    } else if (arg === "--concurrency") {
      options.concurrency = wholeNumber(valueAfter(argv, (index += 1), arg, "a number"), arg, 1, MAX_CONCURRENCY);
    } else if (arg === "--rate") {
      options.rate = wholeNumber(valueAfter(argv, (index += 1), arg, "a number"), arg, 1, MAX_RATE);
    } else if (arg === "--plan-file") {
      options.planFile = valueAfter(argv, (index += 1), arg, "a file path");
    } else if (arg === "--undo-file") {
      options.undoFile = valueAfter(argv, (index += 1), arg, "a file path");
    } else if (arg === "--undo") {
      options.undo = valueAfter(argv, (index += 1), arg, "an undo or plan file");
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.undo && (options.planFile || options.undoFile)) {
    throw new Error("--undo takes neither --plan-file nor --undo-file");
  }
  if (options.apply && !options.undo && !options.planFile) {
    throw new Error("--apply needs --plan-file <the reviewed dry-run plan>");
  }
  if (!options.apply && options.undoFile) {
    throw new Error("--undo-file is where --apply writes its undo records; a dry run writes none");
  }
  return options;
};

const USAGE = [
  "Take the topics (and any life areas left) off the BillsManifest rows of ceremonial resolutions, in place: no date",
  "moves and no push (feature review S6, 2026-10-29; docs/RUNBOOK.md 4.12).",
  "",
  "Usage:",
  "  npm run relabel:ceremonial-rows                                          Dry run: writes the plan (reads only)",
  "  npm run relabel:ceremonial-rows -- --apply --plan-file <plan> --guid G   Apply one row of a reviewed plan",
  "  npm run relabel:ceremonial-rows -- --apply --plan-file <plan>            Apply a reviewed plan",
  "  npm run relabel:ceremonial-rows -- --undo <undo file> [--apply]          Put the lists back (dry run first)",
  "",
  "Options:",
  "  --apply              Write (the default is a dry run, which only reads)",
  `  --plan-file <path>   Dry run: where the plan goes (default ${PLAN_FILE_PREFIX}<UTC time>.jsonl); --apply: the`,
  "                       plan to apply (required)",
  "  --guid <guid>        Only this bill (repeatable; a text-version suffix is ignored)",
  `  --concurrency <n>    Dry-run reads in flight (default ${DEFAULT_CONCURRENCY}, at most ${MAX_CONCURRENCY})`,
  `  --rate <n>           Row writes a second, at most (default ${DEFAULT_RATE}, at most ${MAX_RATE})`,
  `  --undo-file <path>   Where --apply appends the undo records (default ${UNDO_FILE_PREFIX}<UTC time>.jsonl)`,
  "  --undo <path>        Put back the lists of an undo file (or of a plan file); with --apply, else a dry run",
  "",
  "--apply refuses to start (exit code 2) when a plan line is not ceremonial under this checkout's rule (take the dry",
  "run again), or unless BillsManifestQueue and BillsManifestDLQ are empty. Ctrl-C during --apply starts no new line",
  "and lets the one in flight write its undo record (press it again to exit at once).",
  "The only write is an UpdateItem of a BILL row's subCategories and lifeAreas: no S3 write, SQS send, push or",
  "Bedrock call, and no row moves.",
  "",
  "Environment: AWS_PROFILE, AWS_REGION / AWS_DEFAULT_REGION, BILL_STORE_BUCKET (or BUCKET_NAME),",
  "PROCESSED_BILLS_PREFIX, MANIFEST_TABLE_NAME, MANIFEST_PRIMARY_KEY, MANIFEST_SORT_KEY, MANIFEST_PK_VALUE,",
  "BILLS_MANIFEST_QUEUE_NAME, BILLS_MANIFEST_DLQ_NAME",
].join("\n");

// ─── The rule ────────────────────────────────────────────────────────────────

/** A DynamoDB list of strings as read, or null when the attribute is absent or not a list of strings. */
export const stringList = (value: AttributeValue | undefined): string[] | null => {
  if (!value?.L) return null;
  const strings = value.L.map((entry) => entry.S);
  return strings.every((entry): entry is string => typeof entry === "string") ? strings : null;
};

/** Whether a row's billType (a code, or the slug a March row may carry) is a simple or concurrent resolution. */
export const isResolutionType = (billType: unknown): boolean => {
  const code = normalizeBillTypeCode(billType);
  return code !== null && RESOLUTION_TYPES.has(code);
};

/** The row's cleared lists that are not empty, as read. */
export const labelsOf = (row: Item): Partial<Record<ClearedList, string[]>> => {
  const labels: Partial<Record<ClearedList, string[]>> = {};
  for (const list of CLEARED_LISTS) {
    const values = stringList(row[list]);
    if (values && values.length > 0) labels[list] = values;
  }
  return labels;
};

/** One row the apply relabels. */
export interface PlanLine {
  guid: string;
  /** The row's sort key: the apply writes this row and no other. */
  sk: string;
  billType: string;
  /** The headline (the row's title). */
  title: string;
  /**
   * Congress's official title, which decided; null when the bill has none (then the headline decided, unless a
   * curated override did: CURATED_OVERRIDES).
   */
  officialTitle: string | null;
  /** The lists this line empties, as read: only those that were not empty. */
  before: Partial<Record<ClearedList, string[]>>;
  /** The row's version as read, each attribute null when the row had none. */
  version: Record<VersionAttribute, string | null>;
}

export type Assessment =
  | { guid: string; outcome: "planned"; line: PlanLine; what: string | null }
  | { guid: string; outcome: "notCeremonial"; title: string; officialTitle: string | null; labels: PlanLine["before"] }
  | { guid: string; outcome: "unreadable"; detail: string };

const versionOf = (row: Item): PlanLine["version"] =>
  Object.fromEntries(
    VERSION_ATTRIBUTES.map((attribute) => [attribute, row[attribute]?.S ?? null]),
  ) as PlanLine["version"];

const guidOfRow = (row: Item): string => row.guid?.S ?? "";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const WHAT_LENGTH = 240;

/**
 * What the bill does, as its processed bill says (billBreakdown.what, else soWhat; through a content.rawSnapshot
 * wrapper too), on one line and cut at WHAT_LENGTH characters; null when it says nothing.
 */
export const whatItDoes = (document: unknown): string | null => {
  const parsed = asRecord(document);
  const raw = asRecord(asRecord(parsed?.content)?.rawSnapshot) ?? parsed;
  for (const value of [asRecord(raw?.billBreakdown)?.what, raw?.soWhat]) {
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (text) return text.length > WHAT_LENGTH ? `${text.slice(0, WHAT_LENGTH - 3)}...` : text;
  }
  return null;
};

/**
 * What decided a line's verdict: the bill's curated override (commemorativeResolutions.ts CURATED_OVERRIDES), or the
 * override of the bill it is the companion of ("curated override, companion of <guid>": CURATED_OVERRIDE_COMPANIONS,
 * not an override of this bill's own), else the hold of a bill held for review ("held for review", HELD_FOR_REVIEW:
 * not ceremonial until it is reviewed), else Congress's official title, or without one the generated headline.
 */
export const decidedBy = (guid: string, officialTitle: string | null): string => {
  if (curatedCommemorativeOverride(guid) !== undefined) {
    const companionOf = curatedOverrideCompanionOf(guid);
    return companionOf ? `curated override, companion of ${companionOf}` : "curated override";
  }
  if (heldForReview(guid)) return "held for review";
  return officialTitle ? "official title" : "headline";
};

/** Whether the generated headline decided a line's verdict: the rows the review reads with what each does. */
const headlineDecided = (guid: string, officialTitle: string | null): boolean =>
  decidedBy(guid, officialTitle) === "headline";

/**
 * Whether this checkout's rule still tags a plan line's bill, judged by the line's own guid, type and titles (the row's
 * title is the document's headline: CreateBillsManifest writes it from the document). False for a line a curated
 * override untagged since its dry run, or one an older rule planned.
 */
export const lineIsCeremonial = (line: PlanLine): boolean =>
  isCommemorativeResolution({
    guid: line.guid,
    billType: line.billType,
    officialTitle: line.officialTitle,
    title: line.title,
  });

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ─── Reading ─────────────────────────────────────────────────────────────────

const rowKey = (config: RelabelConfig, sk: string): Item => ({
  [config.manifestPrimaryKey]: { S: config.manifestPkValue },
  [config.manifestSortKey]: { S: sk },
});

/** Every BILL row, read consistently. */
export const queryBillRows = async (db: TableSender, config: RelabelConfig): Promise<Item[]> => {
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

/** The processed bill of a plain guid, parsed. */
const readProcessedBill = async (s3: ObjectSender, config: RelabelConfig, guid: string): Promise<unknown> => {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: `${config.processedPrefix}${guid}.json` }),
  );
  const body = await response.Body?.transformToString();
  if (!body) throw new Error("empty processed bill");
  return JSON.parse(body);
};

/** Plans one labelled resolution row from its processed bill. */
export const assessRow = async (deps: { s3: ObjectSender; config: RelabelConfig }, row: Item): Promise<Assessment> => {
  const guid = guidOfRow(row);
  const plain = plainBillGuid(guid);
  if (!plain) return { guid, outcome: "unreadable", detail: "not a bill guid" };
  if (!row.sk?.S?.endsWith(`#${guid}`) || !row.updatedAt?.S) {
    return { guid, outcome: "unreadable", detail: "the row has no sort key of its guid or no updatedAt" };
  }
  let document: unknown;
  try {
    document = await readProcessedBill(deps.s3, deps.config, plain);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return { guid, outcome: "unreadable", detail: `${name}: ${message}` };
  }
  const input = processedBillCommemorativeInput(document);
  const officialTitle = input.officialTitle?.trim() || null;
  const title = row.title?.S ?? input.title ?? "";
  const labels = labelsOf(row);
  if (!isCommemorativeResolution(input)) {
    return { guid, outcome: "notCeremonial", title, officialTitle, labels };
  }
  return {
    guid,
    outcome: "planned",
    line: {
      guid,
      sk: row.sk?.S ?? "",
      billType: row.billType?.S ?? "",
      title,
      officialTitle,
      before: labels,
      version: versionOf(row),
    },
    what: headlineDecided(guid, officialTitle) ? whatItDoes(document) : null,
  };
};

export interface PlanSummary {
  rows: number;
  resolutions: number;
  labelled: number;
  planned: number;
  /** Planned rows the headline decided (no official title, no curated override): review each with what it does. */
  byHeadline: number;
  withTopics: number;
  withLifeAreas: number;
  notCeremonial: number;
  unreadable: number;
}

export const planSummaryLine = (summary: PlanSummary): string =>
  `Ceremonial relabel plan: rows=${summary.rows} resolutions=${summary.resolutions} labelled=${summary.labelled} ` +
  `planned=${summary.planned} byHeadline=${summary.byHeadline} withTopics=${summary.withTopics} ` +
  `withLifeAreas=${summary.withLifeAreas} ` +
  `notCeremonial=${summary.notCeremonial} unreadable=${summary.unreadable}`;

const fileStamp = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

export const defaultPlanFile = (at: Date): string => `${PLAN_FILE_PREFIX}${fileStamp(at)}.jsonl`;
export const defaultUndoFile = (at: Date): string => `${UNDO_FILE_PREFIX}${fileStamp(at)}.jsonl`;

const listText = (values: readonly string[] | undefined): string => `[${(values ?? []).join(", ")}]`;

/** "topics [A, B] -> [], life areas [C] -> []": the lists a line empties. */
export const changeText = (before: PlanLine["before"]): string =>
  [
    before.subCategories ? `topics ${listText(before.subCategories)} -> []` : null,
    before.lifeAreas ? `life areas ${listText(before.lifeAreas)} -> []` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

/** The plan or undo file's lines, each checked to be a relabel of a BILL row of its own guid. */
export const parsePlanFile = (text: string): PlanLine[] =>
  text
    .split("\n")
    .map((raw, index) => ({ raw: raw.trim(), number: index + 1 }))
    .filter(({ raw }) => raw.length > 0)
    .map(({ raw, number }) => {
      const line = JSON.parse(raw) as PlanLine;
      if (typeof line.guid !== "string" || !plainBillGuid(line.guid)) {
        throw new Error(`Plan line ${number}: missing or invalid guid`);
      }
      if (typeof line.sk !== "string" || !line.sk.endsWith(`#${line.guid}`)) {
        throw new Error(`Plan line ${number} (${line.guid}): its sort key is not a row of its guid`);
      }
      const before = line.before && typeof line.before === "object" ? line.before : {};
      const lists = CLEARED_LISTS.filter((list) => before[list] !== undefined);
      if (
        lists.length === 0 ||
        lists.some((list) => {
          const values = before[list];
          return !Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string");
        }) ||
        Object.keys(before).some((list) => !(CLEARED_LISTS as readonly string[]).includes(list))
      ) {
        throw new Error(`Plan line ${number} (${line.guid}): before must hold a non-empty subCategories or lifeAreas`);
      }
      const version = line.version && typeof line.version === "object" ? line.version : null;
      if (
        !version ||
        typeof version.updatedAt !== "string" ||
        VERSION_ATTRIBUTES.some((attribute) => version[attribute] !== null && typeof version[attribute] !== "string")
      ) {
        throw new Error(`Plan line ${number} (${line.guid}): missing or invalid version`);
      }
      return line;
    });

// ─── Applying ────────────────────────────────────────────────────────────────

const stringListValue = (values: readonly string[]): AttributeValue => ({ L: values.map((value) => ({ S: value })) });

/** Whether the row is the plan's version: each version attribute equal (or absent when the plan had none). */
export const rowHasVersion = (row: Item, version: PlanLine["version"]): boolean =>
  VERSION_ATTRIBUTES.every((attribute) => (row[attribute]?.S ?? null) === version[attribute]);

/** Whether each list the line empties holds exactly `expected(list)` on the row. */
const rowListsAre = (row: Item, line: PlanLine, expected: (list: ClearedList) => readonly string[]): boolean =>
  CLEARED_LISTS.filter((list) => line.before[list]).every(
    (list) => JSON.stringify(stringList(row[list])) === JSON.stringify(expected(list)),
  );

interface Condition {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, AttributeValue>;
}

/**
 * The row is still at its key with the plan's version, and each list the line touches holds `listsNow(list)`: the
 * planned values for the relabel, [] for the undo.
 */
export const rowCondition = (
  config: RelabelConfig,
  line: PlanLine,
  listsNow: (list: ClearedList) => readonly string[],
): Condition => {
  const clauses = ["attribute_exists(#pk)"];
  const names: Record<string, string> = { "#pk": config.manifestPrimaryKey };
  const values: Record<string, AttributeValue> = {};
  VERSION_ATTRIBUTES.forEach((attribute, index) => {
    names[`#v${index}`] = attribute;
    const value = line.version[attribute];
    if (value === null) {
      clauses.push(`attribute_not_exists(#v${index})`);
    } else {
      clauses.push(`#v${index} = :v${index}`);
      values[`:v${index}`] = { S: value };
    }
  });
  CLEARED_LISTS.forEach((list, index) => {
    if (!line.before[list]) return;
    names[`#l${index}`] = list;
    clauses.push(`#l${index} = :l${index}`);
    values[`:l${index}`] = stringListValue(listsNow(list));
  });
  return {
    ConditionExpression: clauses.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
};

/** The UpdateItem that sets the line's lists to `to(list)`, on condition they hold `from(list)` (rowCondition). */
export const listsUpdate = (
  config: RelabelConfig,
  line: PlanLine,
  from: (list: ClearedList) => readonly string[],
  to: (list: ClearedList) => readonly string[],
) => {
  const condition = rowCondition(config, line, from);
  const sets: string[] = [];
  CLEARED_LISTS.forEach((list, index) => {
    if (!line.before[list]) return;
    sets.push(`#l${index} = :to${index}`);
    condition.ExpressionAttributeValues[`:to${index}`] = stringListValue(to(list));
  });
  return new UpdateItemCommand({
    TableName: config.manifestTableName,
    Key: rowKey(config, line.sk),
    UpdateExpression: `SET ${sets.join(", ")}`,
    ...condition,
  });
};

const EMPTY: readonly string[] = [];
const planned = (line: PlanLine) => (list: ClearedList) => line.before[list] ?? EMPTY;
const empty = () => EMPTY;

export interface UndoRecord extends PlanLine {
  appliedAt: string;
}

export type ApplyOutcome = "applied" | "alreadyApplied" | "superseded" | "moved" | "failed";
export const APPLY_OUTCOMES: readonly ApplyOutcome[] = ["applied", "alreadyApplied", "superseded", "moved", "failed"];

interface ApplyDeps {
  db: TableSender;
  config: RelabelConfig;
  now: () => Date;
}

const getRow = async (db: TableSender, config: RelabelConfig, sk: string): Promise<Item | undefined> => {
  const response = await db.send(
    new GetItemCommand({ TableName: config.manifestTableName, Key: rowKey(config, sk), ConsistentRead: true }),
  );
  return response.Item;
};

/** What a row read now says about a line that was not (or could not be) written. */
const settledOutcome = (row: Item | undefined, line: PlanLine): Exclude<ApplyOutcome, "applied" | "failed"> | null => {
  if (!row) return "moved";
  if (rowListsAre(row, line, empty)) return "alreadyApplied";
  if (!rowHasVersion(row, line.version) || !rowListsAre(row, line, planned(line))) return "superseded";
  return null;
};

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

/** Empties the line's lists on its row when the row is still as planned. */
export const applyPlanLine = async (
  { db, config, now }: ApplyDeps,
  line: PlanLine,
): Promise<{ outcome: ApplyOutcome; record?: UndoRecord }> => {
  const settled = settledOutcome(await getRow(db, config, line.sk), line);
  if (settled) return { outcome: settled };
  try {
    await db.send(listsUpdate(config, line, planned(line), empty));
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
    // Changed between the read and the write: read again to say how.
    return { outcome: settledOutcome(await getRow(db, config, line.sk), line) ?? "superseded" };
  }
  return { outcome: "applied", record: { ...line, appliedAt: now().toISOString() } };
};

export type UndoOutcome = "restored" | "wouldRestore" | "changedSince" | "moved" | "failed";
export const UNDO_OUTCOMES: readonly UndoOutcome[] = ["restored", "wouldRestore", "changedSince", "moved", "failed"];

/** Puts a record's lists back when its row is still at its key, at its version, with those lists empty. */
export const undoRecordLine = async (
  { db, config }: Pick<ApplyDeps, "db" | "config">,
  record: PlanLine,
  apply: boolean,
): Promise<UndoOutcome> => {
  const row = await getRow(db, config, record.sk);
  if (!row) return "moved";
  if (!rowHasVersion(row, record.version) || !rowListsAre(row, record, empty)) return "changedSince";
  if (!apply) return "wouldRestore";
  try {
    await db.send(listsUpdate(config, record, empty, planned(record)));
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
    return (await getRow(db, config, record.sk)) ? "changedSince" : "moved";
  }
  return "restored";
};

// ─── Report and run ─────────────────────────────────────────────────────────

export interface QueueDepth {
  name: string;
  visible: number;
  notVisible: number;
  delayed: number;
}

/** Messages in BillsManifestQueue and its DLQ: visible, in flight and delayed. */
export const manifestQueueDepths = async (sqs: QueueSender, config: RelabelConfig): Promise<QueueDepth[]> => {
  const depths: QueueDepth[] = [];
  for (const name of [config.manifestQueueName, config.manifestDlqName]) {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`Queue ${name} not found`);
    const { Attributes = {} } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
        ],
      }),
    );
    depths.push({
      name,
      visible: Number(Attributes.ApproximateNumberOfMessages ?? 0) || 0,
      notVisible: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0) || 0,
      delayed: Number(Attributes.ApproximateNumberOfMessagesDelayed ?? 0) || 0,
    });
  }
  return depths;
};

export interface RunOptions {
  db: TableSender;
  s3: ObjectSender;
  sqs: QueueSender;
  config: RelabelConfig;
  options: CliOptions;
  log?: Log;
  logError?: Log;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  appendFile?: (path: string, text: string) => void;
  /** Creates a file; it must not exist. */
  createFile?: (path: string, text: string) => void;
  readFile?: (path: string) => string;
  /** True once the run should start no new line (main sets it on SIGINT or SIGTERM); defaults to never. */
  interrupted?: () => boolean;
}

export interface RunResult {
  exitCode: 0 | 1 | 2;
  summary?: PlanSummary;
  planFile?: string;
  applied?: Record<ApplyOutcome, number>;
  undone?: Record<UndoOutcome, number>;
  undoFile?: string;
  /** Lines not started because the run was interrupted. */
  remaining?: number;
}

type RunDeps = Required<Omit<RunOptions, "options">>;

/**
 * Runs `step` for each entry in turn, starting at most `rate` a second, and starts none once the run is interrupted
 * (the step in flight finishes). Returns how many entries were not started.
 */
const paced = async <T>(
  entries: readonly T[],
  rate: number,
  { now, sleep, interrupted }: Pick<RunDeps, "now" | "sleep" | "interrupted">,
  step: (entry: T) => Promise<void>,
): Promise<number> => {
  const intervalMs = 1000 / rate;
  let nextStartAt = now().getTime();
  for (const [index, entry] of entries.entries()) {
    const waitMs = nextStartAt - now().getTime();
    if (waitMs > 0) await sleep(waitMs);
    if (interrupted()) return entries.length - index;
    nextStartAt = Math.max(now().getTime(), nextStartAt) + intervalMs;
    await step(entry);
  }
  return 0;
};

const selectGuids = <T extends { guid: string }>(entries: readonly T[], options: CliOptions): T[] =>
  options.guids.length > 0
    ? entries.filter((entry) => options.guids.includes(plainBillGuid(entry.guid) ?? entry.guid))
    : [...entries];

/** Refuses (false) unless both manifest queues are empty; logs their depths. */
const queuesAreQuiet = async ({ sqs, config, log, logError }: RunDeps): Promise<boolean> => {
  const depths = await manifestQueueDepths(sqs, config);
  for (const depth of depths) {
    log(`  ${depth.name}: visible=${depth.visible} notVisible=${depth.notVisible} delayed=${depth.delayed}`);
  }
  if (depths.some((depth) => depth.visible + depth.notVisible + depth.delayed > 0)) {
    logError(
      "Refusing to write: a manifest queue holds messages. BillsManifestQueue drains by itself (wait and run again); a " +
        "message in BillsManifestDLQ never does: inspect and redrive it, then take the dry run again (RUNBOOK 4.12)",
    );
    return false;
  }
  return true;
};

/** Plans every labelled resolution row and writes the plan file. */
const runDryRun = async (deps: RunDeps, options: CliOptions): Promise<RunResult> => {
  const { db, config, log, now, createFile } = deps;
  const rows = selectGuids(
    (await queryBillRows(db, config)).map((row) => ({ guid: guidOfRow(row), row })),
    options,
  );
  const resolutions = rows.filter(({ row }) => isResolutionType(row.billType?.S));
  const labelled = resolutions.filter(({ row }) => Object.keys(labelsOf(row)).length > 0);
  log(
    `Read ${rows.length} BILL rows: ${resolutions.length} simple or concurrent resolutions, ${labelled.length} with ` +
      `topics or life areas; reading their processed bills under s3://${config.bucket}/${config.processedPrefix}`,
  );
  const assessments = (await mapWithConcurrency(labelled, options.concurrency, ({ row }) => assessRow(deps, row))).sort(
    (a, b) => compareText(a.guid, b.guid),
  );

  for (const entry of assessments) {
    if (entry.outcome === "planned") {
      const { line } = entry;
      const by = decidedBy(entry.guid, line.officialTitle);
      log(`  planned ${entry.guid} (${by}) "${line.title}": ${changeText(line.before)}`);
      log(
        `    official title: ${line.officialTitle ?? (by === "headline" ? "(none; the headline decided)" : "(none)")}`,
      );
      if (by === "headline") log(`    what it does: ${entry.what ?? "(the processed bill does not say)"}`);
    } else if (entry.outcome === "notCeremonial") {
      log(
        `  not ceremonial ${entry.guid} (${decidedBy(entry.guid, entry.officialTitle)}): ` +
          `${(entry.officialTitle ?? entry.title).slice(0, 140)} (keeps ${changeText(entry.labels).replace(/ -> \[\]/g, "")})`,
      );
    } else {
      log(`  unreadable ${entry.guid}: ${entry.detail}`);
    }
  }

  const lines = assessments.flatMap((entry) => (entry.outcome === "planned" ? [entry.line] : []));
  const summary: PlanSummary = {
    rows: rows.length,
    resolutions: resolutions.length,
    labelled: labelled.length,
    planned: lines.length,
    byHeadline: lines.filter((line) => headlineDecided(line.guid, line.officialTitle)).length,
    withTopics: lines.filter((line) => line.before.subCategories).length,
    withLifeAreas: lines.filter((line) => line.before.lifeAreas).length,
    notCeremonial: assessments.filter((entry) => entry.outcome === "notCeremonial").length,
    unreadable: assessments.filter((entry) => entry.outcome === "unreadable").length,
  };
  if (summary.byHeadline > 0) {
    log(
      `Review the ${summary.byHeadline} planned rows marked (headline) with what each does; take any that asks for ` +
        "something out of the plan file before --apply (RUNBOOK 4.12).",
    );
  }
  let planFile: string | undefined;
  if (lines.length > 0) {
    planFile = options.planFile ?? defaultPlanFile(now());
    createFile(planFile, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    log(`Plan: ${lines.length} rows in ${planFile}`);
  } else {
    log("Plan: no ceremonial resolution row has topics or life areas; no plan file written");
  }
  log(planSummaryLine(summary));
  log("Dry run: nothing written to AWS. Review and archive the plan, then --apply --plan-file <plan> (RUNBOOK 4.12).");
  return { exitCode: summary.unreadable > 0 ? 1 : 0, summary, ...(planFile ? { planFile } : {}) };
};

/** Empties the planned lists of a reviewed plan's rows, paced; writes an undo record for each. */
const runApply = async (deps: RunDeps, options: CliOptions): Promise<RunResult> => {
  const { log, logError, now, appendFile, readFile } = deps;
  const lines = selectGuids(parsePlanFile(readFile(options.planFile!)), options);
  log(`Plan ${options.planFile}: ${lines.length} rows to relabel`);
  // A plan made before a curated override or a change of the rule would take the topics off a bill this release
  // leaves them on, and nothing would put them back until its next write.
  const notCeremonial = lines.filter((line) => !lineIsCeremonial(line));
  if (notCeremonial.length > 0) {
    for (const line of notCeremonial) {
      log(
        `  not ceremonial now: ${line.guid} (${decidedBy(line.guid, line.officialTitle)}) ${changeText(line.before)}`,
      );
    }
    logError(
      `Refusing to write: ${notCeremonial.length} line(s) of the plan are not ceremonial under this release's rule; ` +
        "take the dry run again and apply its plan (RUNBOOK 4.12)",
    );
    return { exitCode: 2 };
  }
  if (!(await queuesAreQuiet(deps))) return { exitCode: 2 };

  const undoFile = options.undoFile ?? defaultUndoFile(now());
  // Created before the first write, so a path that cannot be written stops the run before any write.
  appendFile(undoFile, "");
  log(`Relabelling ${lines.length} rows at most ${options.rate} a second; undo records go to ${undoFile}`);
  const applied = Object.fromEntries(APPLY_OUTCOMES.map((outcome) => [outcome, 0])) as Record<ApplyOutcome, number>;
  const remaining = await paced(lines, options.rate, deps, async (line) => {
    let result: { outcome: ApplyOutcome; record?: UndoRecord };
    try {
      result = await applyPlanLine(deps, line);
    } catch (error) {
      result = { outcome: "failed" };
      logError("Failed to relabel the manifest row", { guid: line.guid, sk: line.sk, error });
    }
    applied[result.outcome] += 1;
    log(`  ${result.outcome}: ${line.guid}${result.outcome === "applied" ? ` ${changeText(line.before)}` : ""}`);
    if (result.record) {
      try {
        appendFile(undoFile, `${JSON.stringify(result.record)}\n`);
      } catch (error) {
        // The row is relabelled; going on would relabel the next ones without an undo record too. The plan line is
        // what is left to undo it (--undo takes a plan file).
        logError("Relabelled without an undo record; stopping", { guid: line.guid, sk: line.sk, error });
        throw error;
      }
    }
  });
  log(`Applied: ${APPLY_OUTCOMES.map((outcome) => `${outcome}=${applied[outcome]}`).join(" ")} remaining=${remaining}`);
  if (remaining > 0) log(`Interrupted: ${remaining} rows remain; run the same command again to resume.`);
  if (applied.superseded > 0 || applied.moved > 0) {
    log("Superseded or moved rows changed since the dry run: take the dry run again for them.");
  }
  if (applied.failed > 0) log("A failed row may have been written: run again, which reports it (alreadyApplied).");
  return { exitCode: applied.failed > 0 ? 1 : 0, applied, undoFile, remaining };
};

/** Puts back the lists of an undo (or plan) file's rows that are still as the relabel left them. */
const runUndo = async (deps: RunDeps, options: CliOptions): Promise<RunResult> => {
  const { log, logError, readFile } = deps;
  const records = selectGuids(parsePlanFile(readFile(options.undo!)), options).reverse();
  log(`Undo ${options.undo}: ${records.length} rows${options.apply ? "" : " (dry run)"}`);
  if (options.apply && !(await queuesAreQuiet(deps))) return { exitCode: 2 };
  const undone = Object.fromEntries(UNDO_OUTCOMES.map((outcome) => [outcome, 0])) as Record<UndoOutcome, number>;
  const step = async (record: PlanLine): Promise<void> => {
    let outcome: UndoOutcome;
    try {
      outcome = await undoRecordLine(deps, record, options.apply);
    } catch (error) {
      outcome = "failed";
      logError("Failed to put the manifest row's lists back", { guid: record.guid, sk: record.sk, error });
    }
    undone[outcome] += 1;
    if (outcome !== "restored" && outcome !== "wouldRestore") log(`  ${outcome}: ${record.guid}`);
  };
  // Only writes are paced; the dry run only reads.
  let remaining = 0;
  if (options.apply) remaining = await paced(records, options.rate, deps, step);
  else await mapWithConcurrency(records, options.concurrency, step);
  log(
    `Undo: rows=${records.length} ${UNDO_OUTCOMES.map((outcome) => `${outcome}=${undone[outcome]}`).join(" ")} ` +
      `remaining=${remaining}`,
  );
  return { exitCode: undone.failed > 0 ? 1 : 0, undone, remaining };
};

/** The dry run, an apply of a plan file, or an undo, by the options. */
export const runRelabel = async ({
  db,
  s3,
  sqs,
  config,
  options,
  log = console.log,
  logError = console.error,
  now = () => new Date(),
  sleep = sleepMs,
  appendFile = (path: string, text: string) => appendFileSync(path, text, "utf8"),
  createFile = (path: string, text: string) => writeFileSync(path, text, { encoding: "utf8", flag: "wx" }),
  readFile = (path: string) => readFileSync(path, "utf8"),
  interrupted = () => false,
}: RunOptions): Promise<RunResult> => {
  const mode = options.undo ? "UNDO" : options.apply ? "APPLY" : "DRY-RUN";
  log(
    `relabel:ceremonial-rows mode=${mode}${options.undo && !options.apply ? " (dry run)" : ""} ` +
      `table=${config.manifestTableName} bucket=${config.bucket}` +
      (options.guids.length > 0 ? ` guids=${options.guids.join(",")}` : ""),
  );
  const deps: RunDeps = {
    db,
    s3,
    sqs,
    config,
    log,
    logError,
    now,
    sleep,
    appendFile,
    createFile,
    readFile,
    interrupted,
  };
  if (options.undo) return runUndo(deps, options);
  if (options.apply) return runApply(deps, options);
  return runDryRun(deps, options);
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const config = configFromEnv();
  // A write lands before its undo record, so a writing run is not killed by the first Ctrl-C (or SIGTERM): it starts
  // no new line and lets the one in flight write its record. The second exits at once; a rerun then reports a line
  // that was written (alreadyApplied). The dry runs stop at once, as they write nothing.
  let interrupted = false;
  if (options.apply) {
    const interrupt = (signal: NodeJS.Signals) => {
      if (interrupted) process.exit(130);
      interrupted = true;
      console.error(`${signal}: finishing the row in flight, then stopping (again to exit at once)`);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
  }
  const { exitCode } = await runRelabel({
    db: new DynamoDBClient({ region: config.region }),
    s3: new S3Client({ region: config.region }),
    sqs: new SQSClient({ region: config.region }),
    config,
    options,
    interrupted: () => interrupted,
  });
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Ceremonial relabel failed", error);
    process.exitCode = 1;
  });
}
