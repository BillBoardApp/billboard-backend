import {
  type AttributeValue,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { ACTIVE_PRIORITY_STATUS, type BillPriorityRecord, type BillPriorityStatus } from "../models/billPriority";

interface BillPriorityDaoConfig {
  tableName: string;
  partitionKey: string;
  activeIndexName?: string;
  statusAttribute?: string;
  prioritySortKeyAttribute?: string;
  activeStatusValue?: BillPriorityStatus;
}

const attributeValueToString = (value: AttributeValue | undefined): string | undefined => {
  if (typeof value?.S === "string") {
    return value.S;
  }
  return undefined;
};

const attributeValueToNumber = (value: AttributeValue | undefined): number | undefined => {
  const raw = typeof value?.N === "string" ? Number(value.N) : undefined;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
};

const attributeValueToBoolean = (value: AttributeValue | undefined): boolean | undefined => {
  if (typeof value?.BOOL === "boolean") {
    return value.BOOL;
  }
  return undefined;
};

export class BillPriorityDao {
  readonly dynamo: DynamoDBClient;
  readonly config: BillPriorityDaoConfig;

  constructor(dynamo: DynamoDBClient, config: BillPriorityDaoConfig) {
    this.dynamo = dynamo;
    this.config = config;
  }

  private getStatusAttribute(): string {
    return this.config.statusAttribute ?? "status";
  }

  private getPrioritySortKeyAttribute(): string {
    return this.config.prioritySortKeyAttribute ?? "prioritySortKey";
  }

  private getActiveStatusValue(): BillPriorityStatus {
    return this.config.activeStatusValue ?? ACTIVE_PRIORITY_STATUS;
  }

  private toRecord(item: Record<string, AttributeValue> | undefined): BillPriorityRecord | null {
    if (!item) {
      return null;
    }

    const guid = attributeValueToString(item[this.config.partitionKey]);
    if (!guid) {
      return null;
    }

    const status = attributeValueToString(item[this.getStatusAttribute()]);
    const priorityUpdatedAt = attributeValueToString(item.priorityUpdatedAt);
    if (!status || !priorityUpdatedAt) {
      return null;
    }

    return {
      guid,
      status: status as BillPriorityStatus,
      isPriority: attributeValueToBoolean(item.isPriority) ?? false,
      congress: attributeValueToString(item.congress),
      billType: attributeValueToString(item.billType),
      billNumber: attributeValueToString(item.billNumber),
      title: attributeValueToString(item.title),
      billStatus: attributeValueToString(item.billStatus) as BillPriorityRecord["billStatus"],
      updatedAt: attributeValueToString(item.updatedAt),
      priorityRank: attributeValueToNumber(item.priorityRank),
      priorityScore: attributeValueToNumber(item.priorityScore),
      priorityConfidence: attributeValueToNumber(item.priorityConfidence),
      priorityReason: attributeValueToString(item.priorityReason),
      priorityUpdatedAt,
      priorityExpiresAt: attributeValueToString(item.priorityExpiresAt),
      prioritySortKey: attributeValueToString(item[this.getPrioritySortKeyAttribute()]),
      ttl: attributeValueToNumber(item.ttl),
    };
  }

  private toItem(record: BillPriorityRecord): Record<string, AttributeValue> {
    const item: Record<string, AttributeValue> = {
      [this.config.partitionKey]: { S: record.guid },
      [this.getStatusAttribute()]: { S: record.status },
      isPriority: { BOOL: record.isPriority },
      priorityUpdatedAt: { S: record.priorityUpdatedAt },
    };

    const maybeString = (key: keyof BillPriorityRecord, itemKey: string = key): void => {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        item[String(itemKey)] = { S: value.trim() };
      }
    };

    const maybeNumber = (key: keyof BillPriorityRecord, itemKey: string = key): void => {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        item[String(itemKey)] = { N: String(value) };
      }
    };

    maybeString("congress");
    maybeString("billType");
    maybeString("billNumber");
    maybeString("title");
    maybeString("billStatus");
    maybeString("updatedAt");
    maybeString("priorityReason");
    maybeString("priorityExpiresAt");
    maybeString("prioritySortKey", this.getPrioritySortKeyAttribute());
    maybeNumber("priorityRank");
    maybeNumber("priorityScore");
    maybeNumber("priorityConfidence");
    maybeNumber("ttl");

    return item;
  }

  async getByGuid(guid: string): Promise<BillPriorityRecord | null> {
    const trimmedGuid = guid.trim();
    if (!trimmedGuid) {
      return null;
    }

    const response = await this.dynamo.send(
      new GetItemCommand({
        TableName: this.config.tableName,
        Key: {
          [this.config.partitionKey]: { S: trimmedGuid },
        },
      }),
    );

    return this.toRecord(response.Item);
  }

  async listActive(): Promise<BillPriorityRecord[]> {
    if (!this.config.activeIndexName) {
      return [];
    }

    const items: BillPriorityRecord[] = [];
    let startKey: Record<string, AttributeValue> | undefined;

    do {
      const response = await this.dynamo.send(
        new QueryCommand({
          TableName: this.config.tableName,
          IndexName: this.config.activeIndexName,
          KeyConditionExpression: "#status = :status",
          ExpressionAttributeNames: {
            "#status": this.getStatusAttribute(),
          },
          ExpressionAttributeValues: {
            ":status": { S: this.getActiveStatusValue() },
          },
          ExclusiveStartKey: startKey,
        }),
      );

      for (const item of response.Items ?? []) {
        const record = this.toRecord(item);
        if (record) {
          items.push(record);
        }
      }

      startKey = response.LastEvaluatedKey;
    } while (startKey);

    return items;
  }

  async put(record: BillPriorityRecord): Promise<void> {
    await this.dynamo.send(
      new PutItemCommand({
        TableName: this.config.tableName,
        Item: this.toItem(record),
      }),
    );
  }
}
