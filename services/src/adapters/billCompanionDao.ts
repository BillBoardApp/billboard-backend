import {
  BatchGetItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  companionCandidateGraph,
  normalizeBillTypeCode,
  parseBillGuid,
  plainBillGuid,
  resolveCompanionGroups,
  type CompanionBillRef,
  type CompanionDeclaration,
  type CompanionPair,
} from "../shared/billCompanions";
import { logger } from "../shared/logger";
import { sleep } from "../shared/retry";

/**
 * Companion-bill rows in the BillsManifest table (APPF-23). Two kinds, outside the BILL partition:
 *
 * - Link lists, pk=BILL_COMPANION_DECL, sk=<plain guid>: one bill's identical-bill links
 *   (`declared`), written by billDiffer and the backfill. A row exists only while the list is
 *   non-empty. Puts and deletes are conditional on the stored row being no newer than the raw bill
 *   they came from (`sourceFetchedAt`), so a stale raw copy never overwrites a fresher list.
 * - The published groups, pk=BILL_COMPANION_GROUPS, sk=CURRENT: the pairs PublishBillsManifest
 *   resolved, with a version number for optimistic writes. Readers cache it for up to 60 s.
 */

type Sender = Pick<DynamoDBClient, "send">;

export interface BillCompanionConfig {
  tableName: string;
  primaryKey: string;
  sortKey: string;
  declPk: string;
  groupsPk: string;
  guidLookupPk: string;
}

/**
 * MANIFEST_TABLE_NAME, else TABLE_NAME (default BillsManifest); the key attribute comes from the same
 * family (MANIFEST_PRIMARY_KEY or PRIMARY_KEY, default pk), so a Lambda whose TABLE_NAME and
 * PRIMARY_KEY describe another table still reads the manifest table's "pk". The partition values
 * are MANIFEST_COMPANION_DECL_PK (BILL_COMPANION_DECL), MANIFEST_COMPANION_GROUPS_PK
 * (BILL_COMPANION_GROUPS) and GUID_LOOKUP_PK or MANIFEST_GUID_LOOKUP_PK (BILL_GUID).
 */
export const billCompanionConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): BillCompanionConfig => {
  const manifestTableName = env.MANIFEST_TABLE_NAME?.trim();
  return {
    tableName: manifestTableName || env.TABLE_NAME?.trim() || "BillsManifest",
    primaryKey: (manifestTableName ? env.MANIFEST_PRIMARY_KEY?.trim() : env.PRIMARY_KEY?.trim()) || "pk",
    sortKey: "sk",
    declPk: env.MANIFEST_COMPANION_DECL_PK?.trim() || "BILL_COMPANION_DECL",
    groupsPk: env.MANIFEST_COMPANION_GROUPS_PK?.trim() || "BILL_COMPANION_GROUPS",
    guidLookupPk: env.GUID_LOOKUP_PK?.trim() || env.MANIFEST_GUID_LOOKUP_PK?.trim() || "BILL_GUID",
  };
};

export const CURRENT_GROUPS_SK = "CURRENT";

/** The CURRENT row: what PublishBillsManifest last published. */
export interface CompanionGroupsState {
  pairsVersion: number;
  /** COMPANION_GROUPS_ENABLED when written. false: no groups anywhere (pairs is then []). */
  enabled: boolean;
  /** [primary, other], sorted. */
  pairs: CompanionPair[];
  groupCount: number;
  ambiguousCount: number;
  oneSidedCount: number;
  declarationCount: number;
  resolvedAt: string;
}

export type CompanionGroupsStateInput = Omit<CompanionGroupsState, "pairsVersion">;

export type PutCurrentGroupsResult = { outcome: "written"; pairsVersion: number } | { outcome: "conflict" };

/** The pairs every reader should use: none when the row is missing or disabled. */
export const activeCompanionPairs = (state: CompanionGroupsState | null | undefined): CompanionPair[] =>
  state?.enabled ? state.pairs : [];

const BATCH_GET_LIMIT = 100;
const BATCH_GET_MAX_ATTEMPTS = 5;
const BATCH_GET_BACKOFF_MS = 100;

const isConditionalCheckFailed = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";

const readString = (value: AttributeValue | undefined): string | undefined =>
  typeof value?.S === "string" ? value.S : undefined;

const readNumber = (value: AttributeValue | undefined): number => {
  const parsed = Number(value?.N);
  return Number.isFinite(parsed) ? parsed : 0;
};

const refToAttribute = (ref: CompanionBillRef): AttributeValue => ({
  M: {
    guid: { S: ref.guid },
    congress: { S: ref.congress },
    billType: { S: ref.billType },
    billNumber: { S: ref.billNumber },
  },
});

const attributeToRef = (value: AttributeValue): CompanionBillRef | null => {
  const map = value?.M;
  if (!map) return null;
  const parsed = parseBillGuid(readString(map.guid));
  if (!parsed || parsed.suffix) return null;
  const billType = normalizeBillTypeCode(readString(map.billType)) ?? parsed.billType;
  return {
    guid: parsed.plainGuid,
    congress: readString(map.congress) ?? parsed.congress,
    billType,
    billNumber: readString(map.billNumber) ?? parsed.billNumber,
  };
};

const isPair = (value: unknown): value is CompanionPair =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((guid) => typeof guid === "string" && plainBillGuid(guid) === guid) &&
  value[0] !== value[1];

export class BillCompanionDao {
  private cachedGroups: { state: CompanionGroupsState | null; readAtMs: number } | undefined;

  private inFlightGroups: Promise<CompanionGroupsState | null> | undefined;

  constructor(
    private readonly ddb: Sender,
    readonly config: BillCompanionConfig = billCompanionConfigFromEnv(),
    private readonly now: () => number = Date.now,
  ) {}

  private declKey(guid: string): Record<string, AttributeValue> {
    return { [this.config.primaryKey]: { S: this.config.declPk }, [this.config.sortKey]: { S: guid } };
  }

  private toDeclaration(item: Record<string, AttributeValue> | undefined): CompanionDeclaration | null {
    if (!item) return null;
    const parsed = parseBillGuid(readString(item[this.config.sortKey]));
    if (!parsed || parsed.suffix) return null;
    const declared = (item.declared?.L ?? [])
      .map(attributeToRef)
      .filter((ref): ref is CompanionBillRef => ref !== null);
    return {
      guid: parsed.plainGuid,
      congress: readString(item.congress) ?? parsed.congress,
      billType: normalizeBillTypeCode(readString(item.billType)) ?? parsed.billType,
      billNumber: readString(item.billNumber) ?? parsed.billNumber,
      declared,
      truncated: item.truncated?.BOOL === true,
      sourceFetchedAt: readString(item.sourceFetchedAt) ?? "",
    };
  }

  // A row may be replaced or removed only by data at least as new as what it holds.
  private freshnessCondition(sourceFetchedAt: string) {
    return {
      ConditionExpression: "attribute_not_exists(#sk) OR attribute_not_exists(#src) OR #src <= :src",
      ExpressionAttributeNames: { "#sk": this.config.sortKey, "#src": "sourceFetchedAt" },
      ExpressionAttributeValues: { ":src": { S: sourceFetchedAt } },
    };
  }

  /** Every link-list row (one paged Query). */
  async listDeclarations(): Promise<CompanionDeclaration[]> {
    const declarations: CompanionDeclaration[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const response = await this.ddb.send(
        new QueryCommand({
          TableName: this.config.tableName,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": this.config.primaryKey },
          ExpressionAttributeValues: { ":pk": { S: this.config.declPk } },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of response?.Items ?? []) {
        const declaration = this.toDeclaration(item);
        if (declaration) declarations.push(declaration);
      }
      startKey = response?.LastEvaluatedKey;
    } while (startKey);
    return declarations;
  }

  /** One bill's link-list row (plain or suffixed guid), or null when it has none. */
  async getDeclaration(guid: string): Promise<CompanionDeclaration | null> {
    const plain = plainBillGuid(guid);
    if (!plain) return null;
    const response = await this.ddb.send(
      new GetItemCommand({ TableName: this.config.tableName, Key: this.declKey(plain), ConsistentRead: true }),
    );
    return this.toDeclaration(response?.Item);
  }

  /**
   * Stores a non-empty link list. "stale": the stored row came from newer raw data (not an error).
   * An empty list must go through deleteDeclaration instead.
   */
  async putDeclaration(declaration: CompanionDeclaration): Promise<"written" | "stale"> {
    if (declaration.declared.length === 0) {
      throw new Error(`putDeclaration needs at least one link (${declaration.guid}); use deleteDeclaration`);
    }
    try {
      await this.ddb.send(
        new PutItemCommand({
          TableName: this.config.tableName,
          Item: {
            ...this.declKey(declaration.guid),
            congress: { S: declaration.congress },
            billType: { S: declaration.billType },
            billNumber: { S: declaration.billNumber },
            declared: { L: declaration.declared.map(refToAttribute) },
            truncated: { BOOL: declaration.truncated },
            sourceFetchedAt: { S: declaration.sourceFetchedAt },
            updatedAt: { S: new Date(this.now()).toISOString() },
          },
          ...this.freshnessCondition(declaration.sourceFetchedAt),
        }),
      );
      return "written";
    } catch (error) {
      if (isConditionalCheckFailed(error)) return "stale";
      throw error;
    }
  }

  /** Removes a bill's row after its links went away. "stale": the stored row came from newer raw data. */
  async deleteDeclaration(guid: string, sourceFetchedAt: string): Promise<"deleted" | "stale"> {
    const plain = plainBillGuid(guid);
    if (!plain) throw new Error(`Not a bill guid: ${guid}`);
    try {
      await this.ddb.send(
        new DeleteItemCommand({
          TableName: this.config.tableName,
          Key: this.declKey(plain),
          ...this.freshnessCondition(sourceFetchedAt),
        }),
      );
      return "deleted";
    } catch (error) {
      if (isConditionalCheckFailed(error)) return "stale";
      throw error;
    }
  }

  private toGroupsState(item: Record<string, AttributeValue> | undefined): CompanionGroupsState | null {
    if (!item) return null;
    let pairs: CompanionPair[] = [];
    const raw = readString(item.pairs);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        const candidates = Array.isArray(parsed) ? parsed : [];
        pairs = candidates.filter(isPair).map(([a, b]) => [a, b] as CompanionPair);
        if (pairs.length !== candidates.length || !Array.isArray(parsed)) {
          logger.warn("Ignored malformed companion pairs in the CURRENT groups row", {
            stored: Array.isArray(parsed) ? parsed.length : typeof parsed,
            kept: pairs.length,
          });
        }
      } catch (error) {
        logger.error("The CURRENT companion groups row holds invalid JSON; treating it as no groups", { error });
      }
    }
    return {
      pairsVersion: readNumber(item.pairsVersion),
      enabled: item.enabled?.BOOL === true,
      pairs,
      groupCount: readNumber(item.groupCount),
      ambiguousCount: readNumber(item.ambiguousCount),
      oneSidedCount: readNumber(item.oneSidedCount),
      declarationCount: readNumber(item.declarationCount),
      resolvedAt: readString(item.resolvedAt) ?? "",
    };
  }

  /**
   * The CURRENT groups row, or null when it does not exist. A read younger than `maxAgeMs` is served
   * from this instance's cache (0, the default, always reads). Errors are thrown and not cached.
   */
  async getCurrentGroups({ maxAgeMs = 0 }: { maxAgeMs?: number } = {}): Promise<CompanionGroupsState | null> {
    const cached = this.cachedGroups;
    if (cached && maxAgeMs > 0 && this.now() - cached.readAtMs < maxAgeMs) return cached.state;
    if (maxAgeMs > 0 && this.inFlightGroups) return this.inFlightGroups;

    const read = (async () => {
      const response = await this.ddb.send(
        new GetItemCommand({
          TableName: this.config.tableName,
          Key: {
            [this.config.primaryKey]: { S: this.config.groupsPk },
            [this.config.sortKey]: { S: CURRENT_GROUPS_SK },
          },
          ConsistentRead: true,
        }),
      );
      const state = this.toGroupsState(response?.Item);
      this.cachedGroups = { state, readAtMs: this.now() };
      return state;
    })();
    if (maxAgeMs > 0) this.inFlightGroups = read;
    try {
      return await read;
    } finally {
      if (this.inFlightGroups === read) this.inFlightGroups = undefined;
    }
  }

  /**
   * Writes CURRENT as version expectedVersion + 1, only if the row is missing or still at
   * `expectedVersion` (null: the row was missing when read). "conflict": another writer got there first.
   */
  async putCurrentGroups(
    next: CompanionGroupsStateInput,
    expectedVersion: number | null,
  ): Promise<PutCurrentGroupsResult> {
    const expected = expectedVersion ?? 0;
    const pairsVersion = expected + 1;
    try {
      await this.ddb.send(
        new PutItemCommand({
          TableName: this.config.tableName,
          Item: {
            [this.config.primaryKey]: { S: this.config.groupsPk },
            [this.config.sortKey]: { S: CURRENT_GROUPS_SK },
            pairsVersion: { N: String(pairsVersion) },
            enabled: { BOOL: next.enabled },
            pairs: { S: JSON.stringify(next.pairs) },
            groupCount: { N: String(next.groupCount) },
            ambiguousCount: { N: String(next.ambiguousCount) },
            oneSidedCount: { N: String(next.oneSidedCount) },
            declarationCount: { N: String(next.declarationCount) },
            resolvedAt: { S: next.resolvedAt },
          },
          ConditionExpression: "attribute_not_exists(#pk) OR #pairsVersion = :expected",
          ExpressionAttributeNames: { "#pk": this.config.primaryKey, "#pairsVersion": "pairsVersion" },
          ExpressionAttributeValues: { ":expected": { N: String(expected) } },
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailed(error)) return { outcome: "conflict" };
      throw error;
    }
    this.cachedGroups = { state: { ...next, pairsVersion }, readAtMs: this.now() };
    return { outcome: "written", pairsVersion };
  }

  /** The plain guids among `guids` that have a manifest guid-lookup row (BatchGet on BILL_GUID). */
  async isHeld(guids: Iterable<string>): Promise<Set<string>> {
    const plainGuids = [
      ...new Set([...guids].map((guid) => plainBillGuid(guid)).filter((guid): guid is string => !!guid)),
    ];
    const held = new Set<string>();
    for (let start = 0; start < plainGuids.length; start += BATCH_GET_LIMIT) {
      let keys: Record<string, AttributeValue>[] = plainGuids.slice(start, start + BATCH_GET_LIMIT).map((guid) => ({
        [this.config.primaryKey]: { S: this.config.guidLookupPk },
        [this.config.sortKey]: { S: guid },
      }));
      for (let attempt = 1; keys.length > 0; attempt += 1) {
        const response = await this.ddb.send(
          new BatchGetItemCommand({
            RequestItems: {
              [this.config.tableName]: {
                Keys: keys,
                ProjectionExpression: "#sk",
                ExpressionAttributeNames: { "#sk": this.config.sortKey },
              },
            },
          }),
        );
        for (const item of response?.Responses?.[this.config.tableName] ?? []) {
          const guid = readString(item[this.config.sortKey]);
          if (guid) held.add(guid);
        }
        keys = response?.UnprocessedKeys?.[this.config.tableName]?.Keys ?? [];
        if (keys.length === 0) break;
        if (attempt >= BATCH_GET_MAX_ATTEMPTS) {
          throw new Error(`BatchGetItem left ${keys.length} guid lookups unprocessed after ${attempt} attempts`);
        }
        await sleep(BATCH_GET_BACKOFF_MS * attempt);
      }
    }
    return held;
  }

  /**
   * The bill's companion as the resolver would pair it right now, or null: reads every link list
   * (uncached), checks which bills of this bill's part of the graph are held, and resolves that part.
   * Independent of CURRENT and of COMPANION_GROUPS_ENABLED; callers check CURRENT.enabled.
   */
  async resolveFresh(guid: string): Promise<string | null> {
    const plain = plainBillGuid(guid);
    if (!plain) return null;
    const declarations = await this.listDeclarations();
    const { candidates } = companionCandidateGraph(declarations);
    if (!candidates.has(plain)) return null;

    const component = new Set<string>([plain]);
    const queue = [plain];
    while (queue.length > 0) {
      for (const neighbour of candidates.get(queue.shift()!) ?? []) {
        if (!component.has(neighbour)) {
          component.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
    // Only a component of exactly one edge can form a group.
    if (component.size !== 2) return null;

    const held = await this.isHeld(component);
    const { pairs } = resolveCompanionGroups(
      declarations.filter((declaration) => component.has(declaration.guid)),
      (candidate) => held.has(candidate),
    );
    const pair = pairs.find((members) => members.includes(plain));
    if (!pair) return null;
    return pair[0] === plain ? pair[1] : pair[0];
  }
}
