import type {
  AttributeValue,
  BatchGetItemCommandInput,
  BatchWriteItemCommandInput,
  ConditionCheck,
  Delete,
  DeleteItemCommandInput,
  GetItemCommandInput,
  Put,
  PutItemCommandInput,
  QueryCommandInput,
  ScanCommandInput,
  TransactWriteItem,
  TransactWriteItemsCommandInput,
  Update,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
  applyStatsSampleFloor,
  createBillStatsAccumulator,
  writeCachedStats,
  type BillStatsResponse,
} from "../../shared/billStats";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./dynamoCondition";

/**
 * INT-11 (question Q6): other users' votes, seeded where production keeps them, and checks that
 * a text or payload carries none of them.
 *
 * Production holds a bill's results in three places: the BillStats row (the payload GET /bill-stats
 * serves), the UserFeedback rows themselves (read through the bill-id index) and the voteCount that
 * BillStatsAggregator still writes on the bill's BillsManifest row. seedResults builds all three from
 * one set of synthetic votes with distinctive counts, through the same fold and writer the aggregator
 * uses, and findResultLeaks reports any of those counts or percentages, any results-shaped key and
 * any results wording found in a text or payload.
 */

export type Item = Record<string, AttributeValue>;

interface TableSpec {
  partitionKey: string;
  sortKey?: string;
}

interface Table {
  spec: TableSpec;
  rows: Map<string, Item>;
}

/** The input of a command the fake answers, in DynamoDB's own field names (the batch commands are read as their own types). */
type DynamoInput = Partial<
  GetItemCommandInput &
    QueryCommandInput &
    ScanCommandInput &
    PutItemCommandInput &
    DeleteItemCommandInput &
    UpdateItemCommandInput &
    TransactWriteItemsCommandInput
>;

/** One part of a TransactWriteItems input: a Put, Delete, Update or ConditionCheck. */
type TransactPart = Partial<Put & Delete & Update & ConditionCheck>;

/** The update fields applyUpdate reads (an UpdateItem input, or the Update part of a transaction). */
type UpdateInput = Pick<UpdateItemCommandInput, "ExpressionAttributeNames" | "ExpressionAttributeValues"> & {
  UpdateExpression?: string;
};

type Command = { constructor: { name: string }; input?: DynamoInput };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * An in-memory DynamoDB for tests that run real handlers end to end. Every table is declared with its
 * keys; reads and writes go through the exact expressions the handlers send (KeyConditionExpression,
 * FilterExpression and ConditionExpression are evaluated by fixtures/dynamoCondition), and a Query
 * with IndexName matches on the index's attributes, so a sparse index works as DynamoDB's does.
 * A command or table it does not know throws, so a test sees any read it did not plan for.
 */
export class InMemoryDynamo {
  private readonly tables = new Map<string, Table>();
  /** Every command received, in order. */
  readonly commands: Array<{ name: string; input: DynamoInput }> = [];

  define(tableName: string, spec: TableSpec): this {
    this.tables.set(tableName, { spec, rows: new Map() });
    return this;
  }

  put(tableName: string, ...items: Item[]): this {
    const table = this.table(tableName);
    for (const item of items) table.rows.set(this.keyOf(table.spec, item), clone(item));
    return this;
  }

  rows(tableName: string): Item[] {
    return Array.from(this.table(tableName).rows.values()).map(clone);
  }

  get(tableName: string, key: Item): Item | undefined {
    const table = this.table(tableName);
    const item = table.rows.get(this.keyOf(table.spec, key));
    return item ? clone(item) : undefined;
  }

  async send(command: Command): Promise<unknown> {
    const name = command.constructor.name;
    const input = command.input ?? {};
    this.commands.push({ name, input });
    switch (name) {
      case "GetItemCommand": {
        const item = this.get(input.TableName!, input.Key!);
        return item ? { Item: item } : {};
      }
      case "BatchGetItemCommand": {
        const Responses: Record<string, Item[]> = {};
        const { RequestItems } = input as BatchGetItemCommandInput;
        for (const [tableName, request] of Object.entries(RequestItems ?? {})) {
          Responses[tableName] = request
            .Keys!.map((key) => this.get(tableName, key))
            .filter((item): item is Item => item !== undefined);
        }
        return { Responses, UnprocessedKeys: {} };
      }
      case "QueryCommand":
      case "ScanCommand": {
        const condition = (expression: string | undefined) => ({
          ConditionExpression: expression,
          ExpressionAttributeNames: input.ExpressionAttributeNames,
          ExpressionAttributeValues: input.ExpressionAttributeValues,
        });
        const Items = Array.from(this.table(input.TableName!).rows.values())
          .filter(
            (item) =>
              (name === "ScanCommand" || evaluateCondition(item, condition(input.KeyConditionExpression))) &&
              evaluateCondition(item, condition(input.FilterExpression)),
          )
          .map(clone);
        // A Query on the table returns its partition in sort-key order, as DynamoDB does.
        const sortKey = this.table(input.TableName!).spec.sortKey;
        if (name === "QueryCommand" && !input.IndexName && sortKey) {
          Items.sort((left, right) => String(left[sortKey]?.S).localeCompare(String(right[sortKey]?.S)));
        }
        return { Items, Count: Items.length };
      }
      case "PutItemCommand":
        this.checkCondition(input.TableName!, input.Item!, input);
        this.put(input.TableName!, input.Item!);
        return {};
      case "DeleteItemCommand":
        this.checkCondition(input.TableName!, input.Key!, input);
        this.delete(input.TableName!, input.Key!);
        return {};
      case "UpdateItemCommand": {
        this.checkCondition(input.TableName!, input.Key!, input);
        const updated = applyUpdate(this.get(input.TableName!, input.Key!) ?? clone(input.Key!), input);
        this.put(input.TableName!, updated);
        return { Attributes: updated };
      }
      case "TransactWriteItemsCommand":
        return this.transact(input.TransactItems ?? []);
      case "BatchWriteItemCommand":
        for (const [tableName, requests] of Object.entries((input as BatchWriteItemCommandInput).RequestItems ?? {})) {
          for (const request of requests) {
            if (request.PutRequest) this.put(tableName, request.PutRequest.Item!);
            if (request.DeleteRequest) this.delete(tableName, request.DeleteRequest.Key!);
          }
        }
        return { UnprocessedItems: {} };
      default:
        throw new Error(`InMemoryDynamo: unexpected ${name}`);
    }
  }

  private table(tableName: string): Table {
    const table = this.tables.get(tableName);
    if (!table) {
      throw Object.assign(new Error(`Requested resource not found: Table: ${tableName} not found`), {
        name: "ResourceNotFoundException",
      });
    }
    return table;
  }

  private keyOf(spec: TableSpec, item: Item): string {
    return JSON.stringify([item[spec.partitionKey], spec.sortKey ? item[spec.sortKey] : null]);
  }

  private delete(tableName: string, key: Item): void {
    const table = this.table(tableName);
    table.rows.delete(this.keyOf(table.spec, key));
  }

  private conditionHolds(tableName: string, keyOrItem: Item, input: ConditionInput): boolean {
    return evaluateCondition(this.get(tableName, keyOrItem), input);
  }

  private checkCondition(tableName: string, keyOrItem: Item, input: ConditionInput): void {
    if (!this.conditionHolds(tableName, keyOrItem, input)) throw conditionalCheckFailed();
  }

  // All conditions first; one that fails cancels the whole transaction, as DynamoDB does.
  private transact(items: TransactWriteItem[]): unknown {
    const parts = items.map((part) => {
      const [kind, body] = Object.entries(part)[0] as [string, TransactPart];
      return { kind, body, target: (body.Item ?? body.Key)! };
    });
    const codes = parts.map(({ body, target }) =>
      this.conditionHolds(body.TableName!, target, body) ? "None" : "ConditionalCheckFailed",
    );
    if (codes.includes("ConditionalCheckFailed")) {
      throw Object.assign(
        new Error(
          `Transaction cancelled, please refer cancellation reasons for specific reasons [${codes.join(", ")}]`,
        ),
        { name: "TransactionCanceledException", CancellationReasons: codes.map((Code) => ({ Code })) },
      );
    }
    for (const { kind, body } of parts) {
      if (kind === "Put") this.put(body.TableName!, body.Item!);
      else if (kind === "Delete") this.delete(body.TableName!, body.Key!);
      else if (kind === "Update")
        this.put(body.TableName!, applyUpdate(this.get(body.TableName!, body.Key!) ?? clone(body.Key!), body));
      else if (kind !== "ConditionCheck") throw new Error(`InMemoryDynamo: unexpected transaction part ${kind}`);
    }
    return {};
  }
}

/** "SET a = :v, #b = :w" and "REMOVE #c", the update forms these handlers send. */
const applyUpdate = (item: Item, input: UpdateInput): Item => {
  const names: Record<string, string> = input.ExpressionAttributeNames ?? {};
  const values: Record<string, AttributeValue> = input.ExpressionAttributeValues ?? {};
  const attribute = (token: string) => (token.startsWith("#") ? names[token] : token);
  const next = clone(item);
  for (const clause of String(input.UpdateExpression ?? "").split(/\s+(?=SET\s|REMOVE\s)/)) {
    const [action, ...rest] = clause.trim().split(/\s+/);
    const body = rest.join(" ");
    if (action === "SET") {
      for (const assignment of body.split(",")) {
        const [left, right] = assignment.split("=").map((part) => part.trim());
        if (!right?.startsWith(":")) throw new Error(`InMemoryDynamo: unsupported SET ${assignment}`);
        next[attribute(left)] = values[right];
      }
    } else if (action === "REMOVE") {
      for (const token of body.split(",")) delete next[attribute(token.trim())];
    } else if (action) {
      throw new Error(`InMemoryDynamo: unsupported update ${clause}`);
    }
  }
  return next;
};

// ─── Other users' votes ─────────────────────────────────────────────────────────────────────────

/** Votes per segment: Yea, Nay and Abstain. */
export interface SeededVoteCounts {
  verified: [yea: number, nay: number, abstain: number];
  selfAttested: [yea: number, nay: number, abstain: number];
}

export interface SeededResults {
  billId: string;
  /** Other users' UserFeedback rows on the bill (plus a few 1.0 and 1.1 dismissals, which count nowhere). */
  feedbackRows: Item[];
  /** The bill's results as BillStatsAggregator computes them, before and after the sample floor. */
  rawStats: BillStatsResponse;
  stats: BillStatsResponse;
  /** The BillStats row, exactly as writeCachedStats stores it (what GET /bill-stats reads). */
  statsItem: Item;
  /** The voteCount BillStatsAggregator writes on the bill's BillsManifest row (verified Yea + Nay). */
  manifestVoteCount: number;
}

/** Verified voters are spread over these districts, so the state and district rollups are published too. */
const VOTER_DISTRICTS: ReadonlyArray<[state: string, district: string]> = [
  ["CA", "12"],
  ["CA", "13"],
  ["TX", "7"],
  ["NY", "10"],
];

/** Reasons other users gave; each one is given often enough to clear the published reasons floor. */
export const SEEDED_REASON_KEYS = ["economic_impact", "public_safety", "taxes_spending", "privacy_liberty"] as const;

const reasonsFor = (feedback: string, index: number): string[] => {
  if (feedback === "Yea") return index % 3 === 0 ? ["economic_impact"] : index % 5 === 0 ? ["public_safety"] : [];
  if (feedback === "Nay") return index % 2 === 0 ? ["taxes_spending"] : index % 7 === 0 ? ["privacy_liberty"] : [];
  return [];
};

/**
 * Other users' votes on `billId` with these counts, folded and stored as production does. `keys`
 * names the UserFeedback key attributes (setFeedback's tests use user_id and bill_id).
 */
export async function seedResults(
  billId: string,
  counts: SeededVoteCounts,
  keys: { userId: string; billId: string } = { userId: "userId", billId: "billId" },
): Promise<SeededResults> {
  const feedbackRows: Item[] = [];
  let voter = 0;
  const addVotes = (verified: boolean, [yea, nay, abstain]: [number, number, number]) => {
    const votes = [
      ...Array<string>(yea).fill("Yea"),
      ...Array<string>(nay).fill("Nay"),
      ...Array<string>(abstain).fill("Abstain"),
    ];
    votes.forEach((feedback, index) => {
      voter += 1;
      const [state, district] = VOTER_DISTRICTS[index % VOTER_DISTRICTS.length];
      const reasons = reasonsFor(feedback, index);
      feedbackRows.push({
        [keys.userId]: { S: `voter-${billId}-${voter}` },
        [keys.billId]: { S: billId },
        feedback: { S: feedback },
        votedAt: { S: "2026-03-10T15:00:00.000Z" },
        effectiveWeight: { N: "1" },
        constituentVerified: { BOOL: verified },
        verificationStatus: { S: verified ? "likely_constituent" : "self_attested" },
        adultEligible: { BOOL: true },
        ...(verified ? { resolvedState: { S: state }, resolvedDistrict: { S: district } } : {}),
        ...(reasons.length > 0 ? { reasons: { SS: reasons } } : {}),
      });
    });
  };
  addVotes(true, counts.verified);
  addVotes(false, counts.selfAttested);
  // 1.0 and 1.1 Updates dismissals (INT-11): stored, but counted in no result.
  for (let index = 0; index < 3; index += 1) {
    voter += 1;
    feedbackRows.push({
      [keys.userId]: { S: `voter-${billId}-${voter}` },
      [keys.billId]: { S: billId },
      feedback: { S: "Abstain" },
      votedAt: { S: "2026-03-11T15:00:00.000Z" },
      adultEligible: { BOOL: true },
      legacyDismiss: { BOOL: true },
    });
  }

  const accumulator = createBillStatsAccumulator(billId);
  for (const row of feedbackRows) accumulator.add(row);
  const rawStats = { ...accumulator.result(), generatedAt: "2026-03-12T09:30:00.000Z" };
  const stats = applyStatsSampleFloor(rawStats);

  let statsItem: Item | undefined;
  await writeCachedStats({
    db: {
      send: async (command: Command) => {
        statsItem = command.input!.Item;
        return {};
      },
    } as never,
    statsTableName: "BillStats",
    statsPartitionKey: "billId",
    stats: rawStats,
  });

  return {
    billId,
    feedbackRows,
    rawStats,
    stats,
    statsItem: statsItem!,
    manifestVoteCount: rawStats.segments.verified.decisionVotes,
  };
}

// ─── Finding results in a text or payload ───────────────────────────────────────────────────────

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const numbersIn = (value: unknown, found: Set<number>): Set<number> => {
  if (typeof value === "number" && Number.isFinite(value)) found.add(value);
  else if (Array.isArray(value)) value.forEach((entry) => numbersIn(entry, found));
  else if (value && typeof value === "object") Object.values(value).forEach((entry) => numbersIn(entry, found));
  return found;
};

/** The seeded counts (of 100 or more) and percentages, as numbers. */
const seededNumbers = (seeded: readonly SeededResults[]): Set<number> => {
  const numbers = new Set<number>();
  for (const results of seeded) {
    numbersIn(results.rawStats, numbers);
    numbersIn(results.stats, numbers);
    numbers.add(results.manifestVoteCount);
  }
  return new Set([...numbers].filter((value) => !Number.isInteger(value) || value >= 100));
};

/**
 * Every way the seeded results could be written in a text: each count, plain and with thousands
 * separators ("4817", "4,817"), and each percentage to one and two decimals ("63.4", "63.41"). Counts
 * under 100 are left to the wording checks, since a push legitimately says "2 New Bills for You".
 */
export function resultPatterns(seeded: readonly SeededResults[]): Array<{ label: string; pattern: RegExp }> {
  const patterns: Array<{ label: string; pattern: RegExp }> = [];
  for (const value of seededNumbers(seeded)) {
    if (Number.isInteger(value)) {
      const forms = Array.from(new Set([String(value), value.toLocaleString("en-US")])).map(escapeRegExp);
      patterns.push({
        label: `count ${value}`,
        pattern: new RegExp(`(?<![\\d,.])(${forms.join("|")})(?![\\d]|[,.]\\d)`),
      });
    } else {
      for (const form of new Set([value.toFixed(1), value.toFixed(2)])) {
        patterns.push({ label: `percentage ${form}`, pattern: new RegExp(`(?<!\\d)${escapeRegExp(form)}(?!\\d)`) });
      }
    }
  }
  return patterns;
}

/** Keys that only results have: counts, splits, percentages, segments, rollups and reasons. */
const RESULT_KEY =
  /^(votes?|voteCount\w*|(yea|nay|abstain)(s|Count|Votes|Pct)?|decisionVotes|weighted\w*|totals|segments|verified|selfAttested|verifiedWithheld|rollups|byState|byDistrict|comparison|allUsers|minDecisionVotes|reasonBreakdown|reasons|reasonKey|feedback|\w*Pct|\w*percent\w*|results?)$/i;

/** Wording that only results use ("1,204 people abstained", "63% voted Yea", "Nay (412)"). */
const RESULT_WORDS: readonly RegExp[] = [
  /\b(yeas?|nays?)\b/i,
  /abstain/i,
  /\bvoters?\b/i,
  /\bvoted\b/i,
  /\bvotes\b/i,
  /\bpeople\b/i,
  /percent/i,
  /%/,
  ...SEEDED_REASON_KEYS.flatMap((key) => [
    new RegExp(escapeRegExp(key), "i"),
    new RegExp(key.replace("_", "\\W+"), "i"),
  ]),
];

const DYNAMO_TYPE_KEY = /^(S|N|BOOL|NULL|L|M|SS|NS)$/;

/** A JSON string inside a payload (SNS's APNS member, a stored digest payload) is checked as what it holds. */
const parseNestedJson = (value: string): unknown => {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

export interface LeakCheckOptions {
  /**
   * Fields that hold ids, keys or timestamps rather than reader-facing text or counts ("userId",
   * "createdAt"): their values skip the number and wording checks. Their keys are still checked.
   */
  ignoreFields?: readonly string[];
}

/**
 * Every trace of the seeded results in `value`: a seeded count or percentage written in a string or
 * held as a number, a key that only results have, or results wording in a string. JSON held in a
 * string is checked as what it holds. Empty when there is none.
 */
export function findResultLeaks(
  value: unknown,
  seeded: readonly SeededResults[],
  options: LeakCheckOptions = {},
): string[] {
  const leaks: string[] = [];
  const numbers = seededNumbers(seeded);
  const patterns = resultPatterns(seeded);
  const ignored = new Set(options.ignoreFields ?? []);
  // `field` is the attribute or property a value belongs to; a DynamoDB type key ({ S: ... }) keeps its parent's.
  const walk = (node: unknown, path: string, field: string | undefined): void => {
    if (typeof node === "string") {
      const nested = parseNestedJson(node);
      if (nested !== undefined) {
        walk(nested, path, field);
        return;
      }
      if (field !== undefined && ignored.has(field)) return;
      for (const { label, pattern } of patterns) {
        if (pattern.test(node)) leaks.push(`${label} at ${path}: ${JSON.stringify(node)}`);
      }
      for (const pattern of RESULT_WORDS) {
        if (pattern.test(node)) leaks.push(`results wording ${pattern} at ${path}: ${JSON.stringify(node)}`);
      }
      return;
    }
    if (typeof node === "number") {
      if (!(field !== undefined && ignored.has(field)) && numbers.has(node))
        leaks.push(`seeded number ${node} at ${path}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`, field));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (RESULT_KEY.test(key)) leaks.push(`results key at ${path}.${key}`);
        walk(child, `${path}.${key}`, DYNAMO_TYPE_KEY.test(key) ? field : key);
      }
    }
  };
  walk(value, "$", undefined);
  return leaks;
}
