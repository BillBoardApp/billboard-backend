import {
  AttributeValue,
  DynamoDBClient,
  BatchGetItemCommand,
  QueryCommand,
  QueryCommandInput,
} from "@aws-sdk/client-dynamodb";

interface UserPreferencesDaoConfig {
  tableName: string;
  userIdAttribute: string;
  subCategoryAttribute?: string;
  subCategoryIndexName?: string;
  categoryAttribute?: string;
  categoryIndexName?: string;
  typeAttribute?: string;
  preferenceAttribute?: string;
}

export class UserPreferencesDao {
  readonly dynamo: DynamoDBClient;
  readonly config: UserPreferencesDaoConfig;

  constructor(dynamo: DynamoDBClient, config: UserPreferencesDaoConfig) {
    this.dynamo = dynamo;
    this.config = config;
  }

  private getTypeAttributeName(): string {
    return this.config.typeAttribute ?? "type";
  }

  private getPreferenceAttributeName(): string {
    // In this service, the preference value is the sort-key in the base table.
    // In many deployments it's also the GSI partition key (aka subCategoryAttribute).
    return this.config.preferenceAttribute ?? this.config.subCategoryAttribute ?? "preference";
  }

  private async filterUsersByType(options: {
    preferenceValue: string;
    userIds: string[];
    types: ReadonlySet<string>;
  }): Promise<string[]> {
    const { preferenceValue, userIds, types } = options;
    const typeAttribute = this.getTypeAttributeName();
    const preferenceAttribute = this.getPreferenceAttributeName();

    if (userIds.length === 0) {
      return [];
    }

    const keys = userIds.map((userId) => ({
      [this.config.userIdAttribute]: { S: userId },
      [preferenceAttribute]: { S: preferenceValue },
    }));

    const MAX_KEYS_PER_BATCH = 100;
    const chunks: Array<Array<Record<string, AttributeValue>>> = [];
    for (let i = 0; i < keys.length; i += MAX_KEYS_PER_BATCH) {
      chunks.push(keys.slice(i, i + MAX_KEYS_PER_BATCH));
    }

    const matched = new Set<string>();

    for (const chunk of chunks) {
      let request: Record<string, { Keys: Array<Record<string, AttributeValue>> }> = {
        [this.config.tableName]: { Keys: chunk },
      };

      let attempts = 0;
      while (true) {
        const resp = await this.dynamo.send(
          new BatchGetItemCommand({
            RequestItems: request,
          }),
        );

        const responses = resp.Responses?.[this.config.tableName] as Array<Record<string, AttributeValue>> | undefined;

        for (const item of responses ?? []) {
          const uid = this.attributeValueToString(item[this.config.userIdAttribute]);
          const itemType = this.attributeValueToString(item[typeAttribute]);
          if (uid && itemType && types.has(itemType)) {
            matched.add(uid);
          }
        }

        const unprocessed = resp.UnprocessedKeys?.[this.config.tableName]?.Keys as
          | Array<Record<string, AttributeValue>>
          | undefined;

        if (!unprocessed || unprocessed.length === 0) {
          break;
        }

        attempts += 1;
        if (attempts > 4) {
          throw new Error("Failed to BatchGet all items after retries");
        }

        await new Promise((r) => setTimeout(r, 100 * attempts));
        request = { [this.config.tableName]: { Keys: unprocessed } };
      }
    }

    return Array.from(matched);
  }

  /** Users with a row on `subCategory`; with `type`, only rows of that type (or of any of those types). */
  async getUsersForSubCategory(subCategory: string, type?: string | readonly string[]): Promise<string[]> {
    if (!this.config.subCategoryAttribute || !this.config.subCategoryIndexName) {
      throw new Error("Sub-category lookup requested but no index configuration provided");
    }

    const items = await this.queryAll((startKey) => ({
      TableName: this.config.tableName,
      IndexName: this.config.subCategoryIndexName,
      KeyConditionExpression: "#sub = :sub",
      ExpressionAttributeNames: {
        "#sub": this.config.subCategoryAttribute!,
        "#uid": this.config.userIdAttribute,
      },
      ExpressionAttributeValues: {
        ":sub": { S: subCategory },
      },
      ProjectionExpression: "#uid",
      ExclusiveStartKey: startKey,
    }));

    const userIds = this.extractDistinctUserIds(items);
    if (!type || type.length === 0) {
      return userIds;
    }

    // Can't filter on non-projected attributes in a GSI Query (DynamoDB ValidationException).
    // Instead, query for candidate userIds via the GSI, then BatchGet from base table
    // (which contains the `type` attribute) to filter accurately.
    return this.filterUsersByType({
      preferenceValue: subCategory,
      userIds,
      types: new Set(typeof type === "string" ? [type] : type),
    });
  }

  async getUsersForCategory(category: string, subCategory?: string): Promise<string[]> {
    const indexName = this.config.categoryIndexName ?? this.config.subCategoryIndexName;
    const categoryAttribute = this.config.categoryAttribute;
    const subCategoryAttribute = this.config.subCategoryAttribute;

    if (!indexName || !categoryAttribute) {
      throw new Error("Category lookup requested but index or category attribute is not configured");
    }

    const items = await this.queryAll((startKey) => {
      const expressionAttributeNames: Record<string, string> = {
        "#cat": categoryAttribute,
        "#uid": this.config.userIdAttribute,
      };

      const expressionAttributeValues: Record<string, AttributeValue> = {
        ":cat": { S: category },
      };

      let keyConditionExpression = "#cat = :cat";

      if (subCategory) {
        if (!subCategoryAttribute) {
          throw new Error("Sub-category value provided but sub-category attribute is not configured");
        }

        expressionAttributeNames["#sub"] = subCategoryAttribute;
        expressionAttributeValues[":sub"] = { S: subCategory };
        keyConditionExpression += " AND #sub = :sub";
      }

      return {
        TableName: this.config.tableName,
        IndexName: indexName,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ProjectionExpression: "#uid",
        ExclusiveStartKey: startKey,
      };
    });

    return this.extractDistinctUserIds(items);
  }

  async getUserPreferences(userId: string): Promise<Record<string, AttributeValue>[]> {
    const items = await this.queryAll((startKey) => ({
      TableName: this.config.tableName,
      KeyConditionExpression: "#uid = :uid",
      ExpressionAttributeNames: {
        "#uid": this.config.userIdAttribute,
      },
      ExpressionAttributeValues: {
        ":uid": { S: userId },
      },
      ExclusiveStartKey: startKey,
    }));

    return items;
  }

  async queryAll(
    buildInput: (startKey?: Record<string, AttributeValue>) => QueryCommandInput,
  ): Promise<Record<string, AttributeValue>[]> {
    const items: Record<string, AttributeValue>[] = [];
    let startKey: Record<string, AttributeValue> | undefined;

    do {
      const input = buildInput(startKey);
      const response = await this.dynamo.send(new QueryCommand(input));

      if (response.Items) {
        items.push(...response.Items);
      }

      startKey = response.LastEvaluatedKey;
    } while (startKey);

    return items;
  }

  extractDistinctUserIds(items: Record<string, AttributeValue>[]): string[] {
    const seen = new Set<string>();

    for (const item of items) {
      const rawUserId = item[this.config.userIdAttribute];
      const userId = this.attributeValueToString(rawUserId);

      if (userId) {
        seen.add(userId);
      }
    }

    return Array.from(seen);
  }

  attributeValueToString(attr: AttributeValue | undefined): string | null {
    if (!attr) {
      return null;
    }

    if ("S" in attr && typeof attr.S === "string") {
      return attr.S;
    }

    if ("N" in attr && typeof attr.N === "string") {
      return attr.N;
    }

    if ("SS" in attr && Array.isArray(attr.SS)) {
      const [first] = attr.SS;
      if (typeof first === "string") {
        return first;
      }
    }

    return null;
  }
}
