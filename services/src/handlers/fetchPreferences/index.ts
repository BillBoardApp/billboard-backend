import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  BILL_SUBCATEGORY_TO_CATEGORY,
  canonicalSubCategory,
  isLegacySubCategoryName,
  legacySubCategoryName,
} from "../../models/categories";
import { getAuthenticatedUserId, jsonResponse } from "../../shared/apiGateway";
import { sendsAppVersion } from "../../shared/appAttest/wire";

const TABLE_NAME = process.env.TABLE_NAME!;
const PARTITION_KEY = process.env.PARTITION_KEY!;
const db = new DynamoDBClient({});

/**
 * GET /preferences
 * - derives userId from authenticated claims (jwt.sub)
 * - validates any provided path/query userId matches token-sub (rejects otherwise)
 * - queries DynamoDB partitioned by `user_id`
 * - names the two renamed topics (LLM-10) the way the calling build knows them: the current names when the request
 *   carries X-Billboard-App-Version (R2 and later), the legacy names when it does not (builds 1.0 and R1)
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getAuthenticatedUserId(event);

    if (!userId) {
      return jsonResponse(401, { message: "Unauthorized (missing authorizer claims)" });
    }

    const pathUserId = event.pathParameters?.userId;
    const queryUserId = event.queryStringParameters?.userId;
    if ((pathUserId && pathUserId !== userId) || (queryUserId && queryUserId !== userId)) {
      return jsonResponse(403, { message: "Forbidden: user mismatch" });
    }

    const result = await db.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        ConsistentRead: true,
        KeyConditionExpression: `${PARTITION_KEY} = :uid`,
        ExpressionAttributeValues: { ":uid": { S: userId } },
      }),
    );

    const items = result.Items ?? [];
    const rows: PreferenceRow[] = items.map((i) => ({
      // what the iOS client actually uses as the subscription “value”
      preference: i.preference?.S ?? null,

      // helps classify lifeArea / congressMember / topic
      type: i.type?.S ?? null,

      // optional grouping/debug
      category: i.category?.S ?? null,

      // optional legacy compatibility (only if you still store it)
      sub_category: i.sub_category?.S ?? null,
    }));
    return jsonResponse(200, sendsAppVersion(event) ? withCurrentLabelNames(rows) : withLegacyLabelNames(rows));
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { message: "Internal Server Error" });
  }
}

type PreferenceRow = {
  preference: string | null;
  type: string | null;
  category: string | null;
  sub_category: string | null;
};

const isCategoryRow = (row: PreferenceRow): boolean => row.type?.trim().toLowerCase() === "category";

// A request without X-Billboard-App-Version (sendsAppVersion) may come from a build that knows only the legacy topic
// names, so it gets those (withLegacyLabelNames); R2 maps both names to the current ones, so it reads either answer.

/**
 * LLM-10, for R2 and later (the request carries X-Billboard-App-Version): a Category row stored under a former
 * sub-category name ("Social Justice", "Identity Politics") is returned under the current name with that name's parent
 * category, and a label the user follows under both names is returned once, where it first appears. Every other row is
 * returned exactly as stored, in the stored order.
 */
export function withCurrentLabelNames(rows: PreferenceRow[]): PreferenceRow[] {
  const seenCategories = new Set<string>();
  const result: PreferenceRow[] = [];
  for (const row of rows) {
    if (!isCategoryRow(row) || row.preference === null) {
      result.push(row);
      continue;
    }
    const current = canonicalSubCategory(row.preference);
    if (seenCategories.has(current)) continue;
    seenCategories.add(current);
    if (isLegacySubCategoryName(row.preference)) {
      const renamed = canonicalSubCategory(row.preference);
      result.push({ ...row, preference: renamed, category: BILL_SUBCATEGORY_TO_CATEGORY[renamed] });
    } else {
      result.push(row);
    }
  }
  return result;
}

/**
 * LLM-10, for builds 1.0 and R1 (no X-Billboard-App-Version): they know the two renamed labels only by their legacy
 * names, and file each under the parent category it kept ("Social Justice" under "Social Policy", "Identity Politics"
 * under "Cultural and Ethical Issues"). So a Category row stored under either name of a renamed label is returned
 * under the legacy name with that parent, and a label the user follows under both names is returned once, where it
 * first appears. Those builds read a row's value as `sub_category ?? preference`, so a Category row's `sub_category`
 * that names a renamed label (older rows may carry one, and `relabel:sub-categories --preferences` moves it to the
 * current name) is returned under the legacy name too. Every other row and value is returned exactly as stored, in the
 * stored order. What those builds send back for such a row is accepted: `PUT /preferences` stores the current name,
 * `DELETE /preferences` removes both names.
 */
export function withLegacyLabelNames(rows: PreferenceRow[]): PreferenceRow[] {
  const seenLegacyNames = new Set<string>();
  const result: PreferenceRow[] = [];
  for (const row of rows) {
    if (!isCategoryRow(row)) {
      result.push(row);
      continue;
    }
    const legacySubCategory = row.sub_category === null ? undefined : legacySubCategoryName(row.sub_category);
    const named = legacySubCategory === undefined ? row : { ...row, sub_category: legacySubCategory };
    const legacyName = row.preference === null ? undefined : legacySubCategoryName(row.preference);
    if (legacyName === undefined) {
      result.push(named);
      continue;
    }
    if (seenLegacyNames.has(legacyName)) continue;
    seenLegacyNames.add(legacyName);
    result.push({
      ...named,
      preference: legacyName,
      category: BILL_SUBCATEGORY_TO_CATEGORY[canonicalSubCategory(legacyName)],
    });
  }
  return result;
}
