import { QueryCommand, type AttributeValue, type DynamoDBClient, type WriteRequest } from "@aws-sdk/client-dynamodb";
import {
  BILL_SUBCATEGORY_TO_CATEGORY,
  canonicalSubCategory,
  isAcceptedSubCategoryName,
  isBillCategoryName,
  isLegacySubCategoryName,
  subCategoryNameVariants,
} from "../models/categories";
import { isLifeAreaName } from "../models/lifeAreas";
import { plainBillGuid } from "./billCompanions";
import { isBillContentTypePreference } from "./billContentTypes";

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

/** One request per key: DynamoDB refuses a BatchWriteItem that names the same item twice. Later entries win. */
function uniqueBySortKey<T>(entries: T[], sortKeyOf: (entry: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const entry of entries) {
    const key = sortKeyOf(entry);
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
 * twice) writes it once, from the last entry.
 */
export function buildPreferencePutRequests(params: {
  userId: string;
  partitionKey: string;
  sortKey: string;
  preferences: NormalizedPreferenceMutation[];
}): WriteRequest[] {
  return uniqueBySortKey(params.preferences, (preference) => preference.preference).map((preference) => {
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
