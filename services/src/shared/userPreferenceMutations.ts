import {
  BatchGetItemCommand,
  PutItemCommand,
  QueryCommand,
  type AttributeValue,
  type DynamoDBClient,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import {
  BILL_SUBCATEGORY_TO_CATEGORY,
  canonicalSubCategory,
  isAcceptedSubCategoryName,
  isBillCategoryName,
  isLegacySubCategoryName,
  subCategoryNameVariants,
} from "../models/categories";
import { LEGACY_DISMISS_ATTRIBUTE, unlocksResults } from "../models/feedback";
import { isLifeAreaName } from "../models/lifeAreas";
import { plainBillGuid } from "./billCompanions";
import { isBillContentTypePreference } from "./billContentTypes";
import { sleep } from "./retry";

/** Types whose value is a bill guid: Bill (written with a vote) and Watch. */
const BILL_GUID_TYPES: ReadonlySet<string> = new Set(["Bill", "Watch"]);

type NormalizedPreferenceMutation = {
  preference: string;
  type: string;
  category: string;
  /** Bill and Watch: the guid as sent, when it is a legacy id of the plain guid stored (BILLS-119hr1181rh). */
  legacyGuid?: string;
};

export class PreferenceMutationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: Record<string, string>,
  ) {
    super(body.error ?? "Preference mutation error");
    this.name = "PreferenceMutationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toDdbString(value: string) {
  return { S: value };
}

function normalizePreferenceType(raw: unknown): string {
  if (typeof raw !== "string") return "";

  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "bill") return "Bill";
  if (lower === "watch") return "Watch";
  if (lower === "category") return "Category";
  if (lower === "life area" || lower === "life_area" || lower === "lifearea") return "Life Area";
  if (lower === "congress member" || lower === "congress_member" || lower === "congressmember") {
    return "Congress Member";
  }
  if (lower === "content type" || lower === "content_type" || lower === "contenttype") {
    return "Content Type";
  }

  return trimmed;
}

function validatePreferenceMutation(raw: unknown): string | null {
  if (!isRecord(raw)) return "Preference must be an object";

  const preference = typeof raw.preference === "string" ? raw.preference : null;
  const type = typeof raw.type === "string" ? raw.type : null;
  const category = raw.category;

  if (!preference) return "Missing or invalid `preference`";
  if (!type) return "Missing or invalid `type`";

  const normalizedType = normalizePreferenceType(type);

  if (normalizedType === "Category") {
    // A former name (LLM-10) is accepted until the legacy-name cleanup; normalizePreferenceMutation stores the current one.
    if (typeof category !== "string" || !isAcceptedSubCategoryName(preference) || !isBillCategoryName(category)) {
      return "Invalid preference or category for type 'Category'";
    }
  } else if (normalizedType === "Life Area") {
    if (!isLifeAreaName(preference)) {
      return "Invalid preference for type 'Life Area'";
    }
  } else if (BILL_GUID_TYPES.has(normalizedType)) {
    if (typeof category === "string" && category.trim().length > 0) {
      return `Category must be empty for type '${normalizedType}'`;
    }
    if (!plainBillGuid(preference)) {
      return `Invalid preference for type '${normalizedType}'`;
    }
  } else if (normalizedType === "Content Type") {
    if (typeof category === "string" && category.trim().length > 0) {
      return "Category must be empty for type 'Content Type'";
    }
    if (!isBillContentTypePreference(preference.trim().toLowerCase())) {
      return "Invalid preference for type 'Content Type'";
    }
  }

  return null;
}

function normalizePreferenceValue(preference: string, type: string): string {
  if (type === "Content Type") return preference.trim().toLowerCase();
  if (type === "Category") return canonicalSubCategory(preference);
  // A bill is followed under its plain guid (REL-42); a legacy id (BILLS-119hr1181rh) names the same bill.
  if (BILL_GUID_TYPES.has(type)) return plainBillGuid(preference) ?? preference;
  return preference;
}

/**
 * One request per key: DynamoDB refuses a BatchWriteItem that names the same item twice. Later entries win, except
 * where `keeps(kept, later)` says the entry already held stays.
 */
function uniqueBySortKey<T>(
  entries: T[],
  sortKeyOf: (entry: T) => string,
  keeps: (kept: T, later: T) => boolean = () => false,
): T[] {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const key = sortKeyOf(entry);
    const kept = byKey.get(key);
    if (kept !== undefined && keeps(kept, entry)) continue;
    byKey.delete(key);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function normalizePreferenceMutation(raw: unknown, partitionKey: string): NormalizedPreferenceMutation {
  const validationError = validatePreferenceMutation(raw);
  if (validationError) {
    throw new PreferenceMutationError(400, { error: validationError });
  }
  if (!isRecord(raw)) {
    throw new PreferenceMutationError(400, { error: "Preference must be an object" });
  }
  if (partitionKey in raw) {
    throw new PreferenceMutationError(400, {
      error: "Do not supply user identifiers in preference objects",
    });
  }

  const type = normalizePreferenceType(raw.type);
  const rawPreference = String(raw.preference);
  const preference = normalizePreferenceValue(rawPreference, type);
  // A former sub-category name is stored under its current name, with that name's parent category (both renames
  // keep their parent), so an old build following "Social Justice" writes the "Civil Rights and Liberties" row.
  const category =
    type === "Category" && isLegacySubCategoryName(rawPreference)
      ? BILL_SUBCATEGORY_TO_CATEGORY[canonicalSubCategory(rawPreference)]
      : typeof raw.category === "string"
        ? raw.category.trim()
        : "";

  return {
    preference,
    type,
    category,
    ...(BILL_GUID_TYPES.has(type) && rawPreference !== preference ? { legacyGuid: rawPreference } : {}),
  };
}

export function parsePreferenceMutationBody(
  rawBody: string | null | undefined,
  partitionKey: string,
): NormalizedPreferenceMutation[] {
  let body: unknown;

  try {
    body = JSON.parse(rawBody ?? "{}");
  } catch {
    throw new PreferenceMutationError(400, { error: "Invalid JSON body" });
  }

  if (isRecord(body) && partitionKey in body) {
    throw new PreferenceMutationError(400, {
      error: "Do not supply user identifiers in payload",
    });
  }

  const incoming = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.preferences)
      ? body.preferences
      : [body];

  if (incoming.length === 0) {
    throw new PreferenceMutationError(400, { error: "No preferences provided" });
  }

  return incoming.map((entry) => normalizePreferenceMutation(entry, partitionKey));
}

/**
 * One PutRequest per stored value. A body naming a label under both its former and its current name (or any value
 * twice) writes it once, from the last entry; a bill named both as a Watch and as a Bill is written as the Watch,
 * whatever the order, as putBillRowsUnlessWatched keeps a stored Watch row.
 */
export function buildPreferencePutRequests(params: {
  userId: string;
  partitionKey: string;
  sortKey: string;
  preferences: NormalizedPreferenceMutation[];
}): WriteRequest[] {
  return uniqueBySortKey(
    params.preferences,
    (preference) => preference.preference,
    (kept, later) => kept.type === "Watch" && later.type === "Bill",
  ).map((preference) => {
    const item: Record<string, { S: string }> = {
      [params.partitionKey]: toDdbString(params.userId),
      [params.sortKey]: toDdbString(preference.preference),
      type: toDdbString(preference.type),
    };

    if (preference.category.length > 0) {
      item.category = toDdbString(preference.category);
    }

    return { PutRequest: { Item: item } };
  });
}

/**
 * Bill and Watch: per plain guid, every sort key the user has a row under that names the bill (REL-42). A row written
 * before bill preferences were stored plain keeps the legacy id the app sent then (BILLS-119hr2707rh), and the app
 * now names only the plain guid. One Query of the user's rows beginning with each plain guid; rows of other bills that
 * begin the same way (BILLS-119hr27071) are left out.
 */
export async function findStoredBillGuids(params: {
  db: Pick<DynamoDBClient, "send">;
  tableName: string;
  partitionKey: string;
  sortKey: string;
  userId: string;
  preferences: NormalizedPreferenceMutation[];
}): Promise<Map<string, string[]>> {
  const plainGuids = new Set(
    params.preferences
      .filter((preference) => BILL_GUID_TYPES.has(preference.type))
      .map((preference) => preference.preference),
  );
  const stored = new Map<string, string[]>();
  for (const plainGuid of plainGuids) {
    const guids: string[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const page = await params.db.send(
        new QueryCommand({
          TableName: params.tableName,
          KeyConditionExpression: "#pk = :userId AND begins_with(#sk, :plainGuid)",
          ExpressionAttributeNames: { "#pk": params.partitionKey, "#sk": params.sortKey },
          ExpressionAttributeValues: { ":userId": toDdbString(params.userId), ":plainGuid": toDdbString(plainGuid) },
          ProjectionExpression: "#sk",
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        const guid = item[params.sortKey]?.S;
        if (guid && plainBillGuid(guid) === plainGuid) guids.push(guid);
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    stored.set(plainGuid, guids);
  }
  return stored;
}

/**
 * One DeleteRequest per stored value. A Category is deleted under its current name and under every former name of
 * that label (LLM-10), so a follow written before the relabel moved it is removed too, whichever name the client sent.
 * A Bill or Watch is deleted under every spelling of the bill: its plain guid, the legacy id the client sent, and each
 * legacy id the user has a row under (`storedBillGuids`, REL-42), so a row written before bill preferences were stored
 * plain is removed too and the suffixed-preference repair cannot bring back a follow the user removed.
 */
export function buildPreferenceDeleteRequests(params: {
  userId: string;
  partitionKey: string;
  sortKey: string;
  preferences: NormalizedPreferenceMutation[];
  /** Bill and Watch: per plain guid, the sort keys of the user's rows on that bill (findStoredBillGuids). */
  storedBillGuids: ReadonlyMap<string, readonly string[]>;
}): WriteRequest[] {
  const values = params.preferences.flatMap((preference) =>
    preference.type === "Category"
      ? subCategoryNameVariants(preference.preference)
      : [
          preference.preference,
          ...(preference.legacyGuid ? [preference.legacyGuid] : []),
          ...(BILL_GUID_TYPES.has(preference.type) ? (params.storedBillGuids.get(preference.preference) ?? []) : []),
        ],
  );
  return uniqueBySortKey(values, (value) => value).map((value) => ({
    DeleteRequest: {
      Key: {
        [params.partitionKey]: toDdbString(params.userId),
        [params.sortKey]: toDdbString(value),
      },
    },
  }));
}

// ─── A vote's Bill row and the bill's Watch row (UX-47, UX-35) ──────────────────────────────────────────────────────

/**
 * The type of a Watch row, as setPreferences has written it since REL-42 and as the app has always sent it. A row
 * typed some other way (a lowercase "watch", which only another client could have stored before REL-42) is replaced
 * by a vote's Bill row, as before UX-47: userMatcher finds a bill's followers by the exact types Bill and Watch, so
 * only the Bill row keeps that voter's pushes.
 */
const WATCH_TYPE = "Watch";

/** Bill rows written at once by putBillRowsUnlessWatched. */
const BILL_ROW_WRITE_CONCURRENCY = 10;

/** Whether `request` writes a Bill row: the follow both apps save with each stored vote. */
export function isBillRowPut(request: WriteRequest): boolean {
  return request.PutRequest?.Item?.type?.S === "Bill";
}

const isConditionalCheckFailed = (error: unknown): boolean =>
  (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException";

/**
 * Writes each Bill row (PutRequest items of isBillRowPut) unless the user's row on that key is a Watch row. Both are
 * stored under the same key (user, plain guid), and the apps save a Bill row after every stored vote, so a vote
 * used to turn the bill's Watch row into a Bill row and the watch was gone at the next preferences load. A Watch
 * row reaches the user with every push a Bill row does (shared/pushAudience.ts, `billFollowers`), so the watch is
 * kept. BatchWriteItem takes no condition, so each row is its own PutItem, conditional on the stored row; a failed
 * condition means the bill is already watched, and that row is done. The condition is checked where the row is
 * written, so a Watch row written at any moment around the vote is never replaced.
 */
export async function putBillRowsUnlessWatched(params: {
  db: Pick<DynamoDBClient, "send">;
  tableName: string;
  items: readonly Record<string, AttributeValue>[];
}): Promise<{ written: number; keptWatch: number }> {
  let written = 0;
  let keptWatch = 0;
  for (let start = 0; start < params.items.length; start += BILL_ROW_WRITE_CONCURRENCY) {
    await Promise.all(
      params.items.slice(start, start + BILL_ROW_WRITE_CONCURRENCY).map(async (item) => {
        try {
          await params.db.send(
            new PutItemCommand({
              TableName: params.tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(#type) OR #type <> :watch",
              ExpressionAttributeNames: { "#type": "type" },
              ExpressionAttributeValues: { ":watch": toDdbString(WATCH_TYPE) },
            }),
          );
          written += 1;
        } catch (error) {
          if (!isConditionalCheckFailed(error)) throw error;
          keptWatch += 1;
        }
      }),
    );
  }
  return { written, keptWatch };
}

/** BatchGetItem's most keys per request. */
const VOTE_READ_BATCH_SIZE = 100;
const VOTE_READ_MAX_ATTEMPTS = 4;
const VOTE_READ_BACKOFF_MS = 50;

/**
 * Unwatching a bill keeps the user's Bill row when they voted on it. DELETE /preferences removes the bill's row under
 * every spelling whatever its type, and since a vote no longer replaces a Watch row (putBillRowsUnlessWatched), the
 * row a voter unwatches is often the only follow they hold: deleting it would stop the pushes a voter gets (an
 * `updated` push asking them to vote again, actions, the outcome). So for each bill unwatched (the plain guids that
 * key `spellings`, unwatchedBillSpellings), this reads the user's own vote rows under every spelling (one consistent
 * BatchGetItem per 100 keys, retried while keys stay unprocessed, else it throws) and answers the plain guids that
 * hold a vote (a Yea, Nay or Abstain, not a 1.0 or 1.1 dismissal: unlocksResults).
 */
export async function findVotedBillGuids(params: {
  db: Pick<DynamoDBClient, "send">;
  feedbackTableName: string;
  feedbackPartitionKey: string;
  feedbackSortKey: string;
  userId: string;
  /** Plain guid to every spelling to read the vote under: the plain guid itself, the one sent, the stored ones. */
  spellings: ReadonlyMap<string, readonly string[]>;
}): Promise<Set<string>> {
  const keys = [...new Set([...params.spellings.values()].flat())].map((billId) => ({
    [params.feedbackPartitionKey]: toDdbString(params.userId),
    [params.feedbackSortKey]: toDdbString(billId),
  }));
  const voted = new Set<string>();
  for (let start = 0; start < keys.length; start += VOTE_READ_BATCH_SIZE) {
    let pending: Record<string, AttributeValue>[] = keys.slice(start, start + VOTE_READ_BATCH_SIZE);
    for (let attempt = 1; pending.length > 0; attempt += 1) {
      const response = await params.db.send(
        new BatchGetItemCommand({
          RequestItems: {
            [params.feedbackTableName]: {
              Keys: pending,
              ConsistentRead: true,
              ProjectionExpression: "#billId, #feedback, #legacyDismiss",
              ExpressionAttributeNames: {
                "#billId": params.feedbackSortKey,
                "#feedback": "feedback",
                "#legacyDismiss": LEGACY_DISMISS_ATTRIBUTE,
              },
            },
          },
        }),
      );
      for (const row of response.Responses?.[params.feedbackTableName] ?? []) {
        const guid = plainBillGuid(row[params.feedbackSortKey]?.S);
        if (guid && params.spellings.has(guid) && unlocksResults(row)) voted.add(guid);
      }
      pending = response.UnprocessedKeys?.[params.feedbackTableName]?.Keys ?? [];
      if (pending.length === 0) break;
      if (attempt >= VOTE_READ_MAX_ATTEMPTS) {
        throw new Error(`BatchGetItem left ${pending.length} vote lookups unprocessed after ${attempt} attempts`);
      }
      await sleep(VOTE_READ_BACKOFF_MS * attempt);
    }
  }
  return voted;
}

/**
 * The bills `preferences` unwatches (type Watch), by plain guid, with every spelling of each to read the user's vote
 * under: the plain guid, the legacy id sent and the ones the user has preference rows under (`storedBillGuids`).
 */
export function unwatchedBillSpellings(
  preferences: readonly NormalizedPreferenceMutation[],
  storedBillGuids: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const spellings = new Map<string, string[]>();
  for (const preference of preferences) {
    if (preference.type !== "Watch") continue;
    const plain = preference.preference;
    const known = new Set(spellings.get(plain) ?? [plain]);
    if (preference.legacyGuid) known.add(preference.legacyGuid);
    for (const stored of storedBillGuids.get(plain) ?? []) known.add(stored);
    spellings.set(plain, [...known]);
  }
  return spellings;
}

/** The Bill row items (as buildPreferencePutRequests writes them) for each plain guid in `guids`. */
export function billRowItems(params: {
  userId: string;
  partitionKey: string;
  sortKey: string;
  guids: Iterable<string>;
}): Record<string, AttributeValue>[] {
  return [...params.guids].map((guid) => ({
    [params.partitionKey]: toDdbString(params.userId),
    [params.sortKey]: toDdbString(guid),
    type: toDdbString("Bill"),
  }));
}
