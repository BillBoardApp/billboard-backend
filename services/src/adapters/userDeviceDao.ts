import { AttributeValue, DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

interface UserDeviceDaoConfig {
  tableName: string;
  userIdAttribute: string;
  deviceIdAttribute: string;
  platformAttribute?: string;
  pushTokenAttribute?: string;
  endpointArnAttribute?: string;
  notificationsEnabledAttribute?: string;
  notifyNewAttribute?: string;
  notifyUpdatedAttribute?: string;
  notifyAlertAttribute?: string;
  notifyPassedAttribute?: string;
  notifyFailedAttribute?: string;
  userIdAttributeType?: "S" | "N";
}

export interface UserDeviceRecord {
  deviceId: string;
  platform?: string;
  pushToken?: string;
  endpointArn?: string;
  notificationsEnabled?: boolean;
  notifyNew?: boolean;
  notifyUpdated?: boolean;
  notifyAlert?: boolean;
  notifyPassed?: boolean;
  notifyFailed?: boolean;
}

export class UserDeviceDao {
  readonly dynamo: DynamoDBClient;
  readonly config: UserDeviceDaoConfig;

  constructor(dynamo: DynamoDBClient, config: UserDeviceDaoConfig) {
    this.dynamo = dynamo;
    this.config = config;
  }

  async getDevicesForUser(userId: string): Promise<UserDeviceRecord[]> {
    const keyType = this.config.userIdAttributeType ?? "S";
    const keyValue: AttributeValue = keyType === "N" ? { N: userId } : { S: userId };

    const response = await this.dynamo.send(
      new QueryCommand({
        TableName: this.config.tableName,
        KeyConditionExpression: "#user = :userValue",
        ExpressionAttributeNames: {
          "#user": this.config.userIdAttribute,
        },
        ExpressionAttributeValues: {
          ":userValue": keyValue,
        },
      }),
    );

    if (!response.Items || response.Items.length === 0) {
      return [];
    }

    const platformAttr = this.config.platformAttribute ?? "platform";
    const pushTokenAttr = this.config.pushTokenAttribute ?? "push_token";
    const endpointArnAttr = this.config.endpointArnAttribute ?? "endpointArn";
    const notificationsEnabledAttr = this.config.notificationsEnabledAttribute ?? "notificationsEnabled";
    const notifyNewAttr = this.config.notifyNewAttribute ?? "notifyNew";
    const notifyUpdatedAttr = this.config.notifyUpdatedAttribute ?? "notifyUpdated";
    const notifyAlertAttr = this.config.notifyAlertAttribute ?? "notifyAlert";
    const notifyPassedAttr = this.config.notifyPassedAttribute ?? "notifyPassed";
    const notifyFailedAttr = this.config.notifyFailedAttribute ?? "notifyFailed";

    const seenDevices = new Set<string>();
    const devices: UserDeviceRecord[] = [];

    for (const item of response.Items) {
      if (!item) {
        continue;
      }

      const deviceId = this.attributeValueToString(item[this.config.deviceIdAttribute]);
      if (!deviceId || seenDevices.has(deviceId)) {
        continue;
      }

      const platform = this.attributeValueToString(item[platformAttr]) ?? undefined;
      const pushToken = this.attributeValueToString(item[pushTokenAttr]) ?? undefined;
      const endpointArn = this.attributeValueToString(item[endpointArnAttr]) ?? undefined;
      const notificationsEnabled = this.attributeValueToBool(item[notificationsEnabledAttr]) ?? undefined;
      const notifyNew = this.attributeValueToBool(item[notifyNewAttr]) ?? undefined;
      const notifyUpdated = this.attributeValueToBool(item[notifyUpdatedAttr]) ?? undefined;
      const notifyAlert = this.attributeValueToBool(item[notifyAlertAttr]) ?? undefined;
      const notifyPassed = this.attributeValueToBool(item[notifyPassedAttr]) ?? undefined;
      const notifyFailed = this.attributeValueToBool(item[notifyFailedAttr]) ?? undefined;

      devices.push({
        deviceId,
        platform,
        pushToken,
        endpointArn,
        notificationsEnabled,
        notifyNew,
        notifyUpdated,
        notifyAlert,
        notifyPassed,
        notifyFailed,
      });
      seenDevices.add(deviceId);
    }

    return devices;
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

    return null;
  }

  attributeValueToBool(attr: AttributeValue | undefined): boolean | null {
    if (!attr) {
      return null;
    }

    if ("BOOL" in attr && typeof attr.BOOL === "boolean") {
      return attr.BOOL;
    }

    if ("S" in attr && typeof attr.S === "string") {
      const lowered = attr.S.trim().toLowerCase();
      if (lowered === "true") return true;
      if (lowered === "false") return false;
    }

    if ("N" in attr && typeof attr.N === "string") {
      if (attr.N === "1") return true;
      if (attr.N === "0") return false;
    }

    return null;
  }
}
