import type { AdminDeleteUserCommandInput } from "@aws-sdk/client-cognito-identity-provider";
import type {
  AttributeValue,
  BatchWriteItemCommandInput,
  ConditionCheck,
  Delete,
  DeleteItemCommandInput,
  GetItemCommandInput,
  Put,
  PutItemCommandInput,
  QueryCommandInput,
  TransactWriteItemsCommandInput,
  Update,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { DeleteEndpointInput } from "@aws-sdk/client-sns";
import { emailClaimKey, SIGNUP_EMAIL_CLAIMS_PARTITION_KEY, userClaimKey } from "../handlers/preSignUp/emailPolicy";
import {
  ACCOUNT_LINK_COUNT_KEYS,
  accountDeletionConfigFromEnv,
  APP_ATTEST_TABLE_KEYS,
  claimDeletion,
  countUserData,
  DELETION_LEASE_MS,
  deleteCognitoUser,
  deleteUserData,
  deletionErrorMessage,
  emptyAccountLinkCounts,
  markDeletionCompleted,
  markDeletionFailed,
  SIGNUP_EMAIL_CLAIM_KEYS,
  type AccountDeletionConfig,
  type AccountDeletionContext,
} from "../shared/accountDeletion";
import { ADDRESS_CLAIM_PII_ATTRIBUTES } from "../shared/addressClaims";
import { SIGNUP_EMAIL_CLAIM_KEYS as SHARED_SIGNUP_EMAIL_CLAIM_KEYS } from "../shared/signUpEmailClaims";
import { bindingItemKey, challengeItemKey, keyItemKey, userPartitionKey } from "../shared/appAttest/store";
import { conditionalCheckFailed, evaluateCondition } from "./fixtures/dynamoCondition";

const config: AccountDeletionConfig = {
  pii: { tableName: "UserPII", partitionKey: "userId" },
  feedback: { tableName: "UserFeedback", partitionKey: "userId", sortKey: "billId" },
  preferences: { tableName: "UserPreferences", partitionKey: "userId", sortKey: "preference" },
  devices: {
    tableName: "UserDevices",
    partitionKey: "userId",
    sortKey: "deviceId",
    pushTokenIndexName: "GSIPushToken",
  },
  weeklyDigests: { tableName: "UserWeeklyDigests", partitionKey: "userId", sortKey: "publishedAt" },
  userPoolId: "us-east-1_pool",
};

/** The input of any command the fakes answer (DynamoDB, SNS and Cognito), in the SDK's own field names. */
type FakeInput = Partial<
  QueryCommandInput &
    BatchWriteItemCommandInput &
    GetItemCommandInput &
    PutItemCommandInput &
    UpdateItemCommandInput &
    DeleteItemCommandInput &
    TransactWriteItemsCommandInput &
    DeleteEndpointInput &
    AdminDeleteUserCommandInput
>;
interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}
/** One part of a TransactWriteItems input. */
type TransactPart = Partial<Put & Delete & Update & ConditionCheck>;

type Item = Record<string, { S: string }>;
type Device = { deviceId: string; pushToken?: string; endpointArn?: string };

function awsError(name: string, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * An in-memory view of one user's rows. Queries page `pageSize` items at a time; `tokenOwners`
 * maps a push token to the user ids the GSI returns; `unprocessedOnce` makes the first BatchWrite
 * to that table return its first request as unprocessed.
 */
function fakeContext(
  data: { feedback?: string[]; preferences?: string[]; devices?: Device[]; weeklyDigests?: string[] } = {},
  options: {
    pageSize?: number;
    tokenOwners?: Record<string, string[]>;
    unprocessedOnce?: string;
    config?: AccountDeletionConfig;
  } = {},
) {
  const pageSize = options.pageSize ?? 100;
  const rowsByTable: Record<string, Item[]> = {
    UserFeedback: (data.feedback ?? []).map((billId) => ({ userId: { S: "u1" }, billId: { S: billId } })),
    UserPreferences: (data.preferences ?? []).map((preference) => ({
      userId: { S: "u1" },
      preference: { S: preference },
    })),
    UserDevices: (data.devices ?? []).map((device) => ({
      userId: { S: "u1" },
      deviceId: { S: device.deviceId },
      ...(device.pushToken ? { pushToken: { S: device.pushToken } } : {}),
      ...(device.endpointArn ? { endpointArn: { S: device.endpointArn } } : {}),
    })),
    UserWeeklyDigests: (data.weeklyDigests ?? []).map((publishedAt) => ({
      userId: { S: "u1" },
      publishedAt: { S: publishedAt },
    })),
  };
  let unprocessedPending = options.unprocessedOnce;

  const dbSend = jest.fn(async (command: FakeCommand) => {
    const name = command.constructor.name;
    const input = command.input ?? {};
    if (name === "QueryCommand") {
      if (input.IndexName) {
        const token = input.ExpressionAttributeValues![":pushToken"].S!;
        return { Items: (options.tokenOwners?.[token] ?? []).map((owner) => ({ userId: { S: owner } })) };
      }
      const rows = rowsByTable[input.TableName!] ?? [];
      const start = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.offset.S) : 0;
      const end = start + pageSize;
      return {
        Items: rows.slice(start, end),
        ...(end < rows.length ? { LastEvaluatedKey: { offset: { S: String(end) } } } : {}),
      };
    }
    if (name === "BatchWriteItemCommand") {
      const [table] = Object.keys(input.RequestItems!);
      if (unprocessedPending === table) {
        unprocessedPending = undefined;
        return { UnprocessedItems: { [table]: input.RequestItems![table].slice(0, 1) } };
      }
      return {};
    }
    if (name === "UpdateItemCommand" || name === "PutItemCommand") return {};
    throw new Error(`Unexpected DynamoDB command ${name}`);
  });
  const snsSend = jest.fn(async (_command: FakeCommand) => ({}));
  const cognitoSend = jest.fn(async (_command: FakeCommand) => ({}));

  const context = {
    config: options.config ?? config,
    db: { send: dbSend },
    sns: { send: snsSend },
    cognito: { send: cognitoSend },
  } as unknown as AccountDeletionContext;
  return { context, dbSend, snsSend, cognitoSend };
}

const commands = (mock: jest.Mock, name?: string): FakeCommand[] =>
  mock.mock.calls
    .map(([command]: [FakeCommand]) => command)
    .filter((command) => !name || command.constructor.name === name);

/** "Command:Table[:Index]" for every DynamoDB call, in order. */
const dynamoSequence = (mock: jest.Mock) =>
  commands(mock).map((command) => {
    const input = command.input;
    const table = input.TableName ?? Object.keys(input.RequestItems ?? {})[0];
    return [command.constructor.name, table, input.IndexName].filter(Boolean).join(":");
  });

const deletedKeys = (mock: jest.Mock, table: string, sortKey: string) =>
  commands(mock, "BatchWriteItemCommand")
    .filter((command) => command.input.RequestItems![table])
    .flatMap((command) => command.input.RequestItems![table].map((request) => request.DeleteRequest!.Key![sortKey].S));

describe("accountDeletionConfigFromEnv", () => {
  it("reads every table, key, index and the pool from the environment", () => {
    expect(
      accountDeletionConfigFromEnv({
        PII_TABLE_NAME: "Pii",
        PII_PARTITION_KEY: "pk",
        FEEDBACK_TABLE_NAME: "Fb",
        FEEDBACK_PARTITION_KEY: "fpk",
        FEEDBACK_SORT_KEY: "fsk",
        PREFERENCES_TABLE_NAME: "Prefs",
        PREFERENCES_PARTITION_KEY: "ppk",
        PREFERENCES_SORT_KEY: "psk",
        DEVICES_TABLE_NAME: "Dev",
        DEVICES_PARTITION_KEY: "dpk",
        DEVICES_SORT_KEY: "dsk",
        DEVICES_PUSH_TOKEN_INDEX_NAME: "TokenIndex",
        WEEKLY_DIGESTS_TABLE_NAME: "Digests",
        WEEKLY_DIGESTS_PARTITION_KEY: "wpk",
        WEEKLY_DIGESTS_SORT_KEY: "wsk",
        USER_POOL_ID: " us-east-1_abc ",
        // Read by the old inline recompute only; ignored now.
        STATS_TABLE_NAME: "BillStats",
        FEEDBACK_BILL_ID_INDEX_NAME: "GSIBillIdIndex",
      }),
    ).toEqual({
      pii: { tableName: "Pii", partitionKey: "pk" },
      feedback: { tableName: "Fb", partitionKey: "fpk", sortKey: "fsk" },
      preferences: { tableName: "Prefs", partitionKey: "ppk", sortKey: "psk" },
      devices: { tableName: "Dev", partitionKey: "dpk", sortKey: "dsk", pushTokenIndexName: "TokenIndex" },
      weeklyDigests: { tableName: "Digests", partitionKey: "wpk", sortKey: "wsk" },
      userPoolId: "us-east-1_abc",
    });
  });

  it("uses AccountData's default keys and leaves optional parts unset", () => {
    const parsed = accountDeletionConfigFromEnv({
      PII_TABLE_NAME: "UserPII",
      FEEDBACK_TABLE_NAME: "UserFeedback",
      PREFERENCES_TABLE_NAME: "UserPreferences",
      DEVICES_TABLE_NAME: "UserDevices",
      DEVICES_PUSH_TOKEN_INDEX_NAME: "",
      WEEKLY_DIGESTS_TABLE_NAME: "",
      USER_POOL_ID: "   ",
      ADDRESS_CLAIMS_TABLE_NAME: "",
      SIGNUP_EMAIL_CLAIMS_TABLE_NAME: "  ",
    });
    expect(parsed).toEqual({
      pii: { tableName: "UserPII", partitionKey: "userId" },
      feedback: { tableName: "UserFeedback", partitionKey: "userId", sortKey: "billId" },
      preferences: { tableName: "UserPreferences", partitionKey: "userId", sortKey: "preference" },
      devices: { tableName: "UserDevices", partitionKey: "userId", sortKey: "deviceId", pushTokenIndexName: undefined },
      weeklyDigests: undefined,
      userPoolId: undefined,
      addressClaims: undefined,
      signUpEmailClaims: undefined,
      appAttest: undefined,
    });
    // Unset or blank X5 table variables turn their steps off.
    expect(parsed.addressClaims).toBeUndefined();
    expect(parsed.signUpEmailClaims).toBeUndefined();
    expect(parsed.appAttest).toBeUndefined();
    expect(emptyAccountLinkCounts(parsed)).toEqual({});
  });

  it("reads the three X5 tables from the variables AccountData and Cleanup are given (trimmed)", () => {
    const parsed = accountDeletionConfigFromEnv({
      ADDRESS_CLAIMS_TABLE_NAME: "VerifiedAddressClaims",
      SIGNUP_EMAIL_CLAIMS_TABLE_NAME: " SignUpEmailClaims ",
      APP_ATTEST_TABLE_NAME: "AppAttest",
    });
    expect(parsed.addressClaims).toEqual({ tableName: "VerifiedAddressClaims" });
    expect(parsed.signUpEmailClaims).toEqual({ tableName: "SignUpEmailClaims" });
    expect(parsed.appAttest).toEqual({ tableName: "AppAttest" });
    expect(emptyAccountLinkCounts(parsed)).toEqual({ addressClaims: 0, emailClaims: 0, appAttestBindings: 0 });
    expect(ACCOUNT_LINK_COUNT_KEYS).toEqual(["addressClaims", "emailClaims", "appAttestBindings"]);
  });
});

describe("X5 table layouts", () => {
  it("keys the sign-up email claim exactly as PreSignUpCheck and the backfill write it", () => {
    expect(SIGNUP_EMAIL_CLAIM_KEYS.partitionKey).toBe(SIGNUP_EMAIL_CLAIMS_PARTITION_KEY);
    expect(SIGNUP_EMAIL_CLAIM_KEYS.emailItem("abc123")).toBe(emailClaimKey("abc123"));
    expect(SIGNUP_EMAIL_CLAIM_KEYS.userItem("8f1c-uuid")).toBe(userClaimKey("8f1c-uuid"));
  });

  it("re-exports the shared SignUpEmailClaims keys, the ones the filter check (CB-07) uses too", () => {
    expect(SIGNUP_EMAIL_CLAIM_KEYS).toBe(SHARED_SIGNUP_EMAIL_CLAIM_KEYS);
    expect(SIGNUP_EMAIL_CLAIM_KEYS.probeItem("base")).toBe("PROBE#base");
    expect(SIGNUP_EMAIL_CLAIM_KEYS.probeItem("variant")).toBe("PROBE#variant");
  });

  it("deletes the App Attest bindings by the keys the App Attest store writes them under", () => {
    const binding = bindingItemKey("sub-1", "key-1");
    expect(Object.keys(binding)).toEqual([APP_ATTEST_TABLE_KEYS.partitionKey, APP_ATTEST_TABLE_KEYS.sortKey]);
    expect(binding[APP_ATTEST_TABLE_KEYS.partitionKey].S).toBe(userPartitionKey("sub-1"));
    expect(userPartitionKey("sub-1")).toBe("USER#sub-1");
  });
});

describe("claimDeletion", () => {
  it("claims with the conditional update that allows only a first claim, a failed one or a stale takeover", async () => {
    const { context, dbSend } = fakeContext();

    await expect(claimDeletion(context, "u1", "2026-09-24T12:00:00.000Z")).resolves.toBe(true);

    expect(DELETION_LEASE_MS).toBe(15 * 60 * 1000);
    const [claim] = commands(dbSend, "UpdateItemCommand");
    expect(claim.input).toEqual({
      TableName: "UserPII",
      Key: { userId: { S: "u1" } },
      UpdateExpression:
        "SET deletionStatus = :status, deletionRequestedAt = :requestedAt, updatedAt = :updatedAt REMOVE deletionCompletedAt, deletionError",
      ConditionExpression:
        "attribute_not_exists(deletionStatus) OR NOT (deletionStatus IN (:status, :completed)) OR (deletionStatus = :status AND (attribute_not_exists(deletionRequestedAt) OR deletionRequestedAt < :staleBefore))",
      ExpressionAttributeValues: {
        ":status": { S: "in_progress" },
        ":completed": { S: "completed" },
        ":requestedAt": { S: "2026-09-24T12:00:00.000Z" },
        ":updatedAt": { S: "2026-09-24T12:00:00.000Z" },
        ":staleBefore": { S: "2026-09-24T11:45:00.000Z" },
      },
    });
  });

  it("returns false when another claim holds the row and rethrows anything else", async () => {
    const { context, dbSend } = fakeContext();
    dbSend.mockRejectedValueOnce(awsError("ConditionalCheckFailedException"));
    await expect(claimDeletion(context, "u1", "2026-09-24T12:00:00.000Z")).resolves.toBe(false);

    dbSend.mockRejectedValueOnce(awsError("ProvisionedThroughputExceededException"));
    await expect(claimDeletion(context, "u1", "2026-09-24T12:00:00.000Z")).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
  });
});

describe("markDeletionFailed and markDeletionCompleted", () => {
  it("marks the deletion failed with the error cut to 512 characters", async () => {
    const { context, dbSend } = fakeContext();

    await markDeletionFailed(context, "u1", "2026-09-24T12:00:00.000Z", "x".repeat(600));

    const [update] = commands(dbSend, "UpdateItemCommand");
    expect(update.input.TableName).toBe("UserPII");
    expect(update.input.Key).toEqual({ userId: { S: "u1" } });
    expect(update.input.ConditionExpression).toBeUndefined();
    expect(update.input.UpdateExpression).toBe(
      "SET deletionStatus = :status, deletionRequestedAt = :requestedAt, deletionError = :deletionError, updatedAt = :updatedAt",
    );
    expect(update.input.ExpressionAttributeValues).toEqual({
      ":status": { S: "failed" },
      ":requestedAt": { S: "2026-09-24T12:00:00.000Z" },
      ":deletionError": { S: "x".repeat(512) },
      ":updatedAt": { S: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    });
  });

  it("replaces the PII row with a tombstone that holds no personal data", async () => {
    const { context, dbSend } = fakeContext();

    await markDeletionCompleted(context, "u1", "2026-09-24T12:00:00.000Z");

    const [put] = commands(dbSend, "PutItemCommand");
    expect(put.input.TableName).toBe("UserPII");
    expect(put.input.ConditionExpression).toBeUndefined();
    expect(put.input.Item).toEqual({
      userId: { S: "u1" },
      deletionStatus: { S: "completed" },
      deletionRequestedAt: { S: "2026-09-24T12:00:00.000Z" },
      deletionCompletedAt: { S: expect.any(String) },
      updatedAt: { S: put.input.Item!.deletionCompletedAt.S },
    });
  });
});

describe("deleteUserData", () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  it("deletes votes, preferences, devices (endpoints first) and digests in that order, and nothing else", async () => {
    const { context, dbSend, snsSend } = fakeContext(
      {
        feedback: ["hr-1", "s-2"],
        preferences: ["Taxes"],
        devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/one" }, { deviceId: "dev-2" }],
        weeklyDigests: ["2026-10-04T14:00:00.000Z"],
      },
      { tokenOwners: { aa11: ["u1"] } },
    );

    const counts = await deleteUserData(context, "u1");

    expect(counts).toEqual({
      feedback: 2,
      preferences: 1,
      devices: 2,
      snsEndpoints: 1,
      sharedSnsEndpointsKept: 0,
      weeklyDigests: 1,
    });
    // No BillStats write and no bill-id index query (C1.6), no PII write.
    expect(dynamoSequence(dbSend)).toEqual([
      "QueryCommand:UserFeedback",
      "BatchWriteItemCommand:UserFeedback",
      "QueryCommand:UserPreferences",
      "BatchWriteItemCommand:UserPreferences",
      "QueryCommand:UserDevices",
      "QueryCommand:UserDevices:GSIPushToken",
      "BatchWriteItemCommand:UserDevices",
      "QueryCommand:UserWeeklyDigests",
      "BatchWriteItemCommand:UserWeeklyDigests",
    ]);
    expect(deletedKeys(dbSend, "UserFeedback", "billId")).toEqual(["hr-1", "s-2"]);
    expect(deletedKeys(dbSend, "UserDevices", "deviceId")).toEqual(["dev-1", "dev-2"]);
    expect(commands(snsSend).map((command) => command.input)).toEqual([{ EndpointArn: "arn:endpoint/one" }]);
    expect(snsSend.mock.invocationCallOrder[0]).toBeLessThan(
      dbSend.mock.invocationCallOrder[dynamoSequence(dbSend).indexOf("BatchWriteItemCommand:UserDevices")],
    );
    // Feedback keys only are read: no vote content.
    expect(commands(dbSend, "QueryCommand")[0].input.ProjectionExpression).toBe("#pk, #sk");
  });

  it("pages through large partitions, chunks deletes by 25 and retries unprocessed items", async () => {
    const feedback = Array.from({ length: 60 }, (_, i) => `hr-${i}`);
    const { context, dbSend } = fakeContext({ feedback }, { pageSize: 40, unprocessedOnce: "UserFeedback" });

    const counts = await deleteUserData(context, "u1");

    expect(counts.feedback).toBe(60);
    const feedbackQueries = commands(dbSend, "QueryCommand").filter((c) => c.input.TableName === "UserFeedback");
    expect(feedbackQueries).toHaveLength(2);
    expect(feedbackQueries[1].input.ExclusiveStartKey).toEqual({ offset: { S: "40" } });
    const batchSizes = commands(dbSend, "BatchWriteItemCommand")
      .filter((c) => c.input.RequestItems!.UserFeedback)
      .map((c) => c.input.RequestItems!.UserFeedback.length);
    // Page 1: 25 (one returned unprocessed, retried alone), 15; page 2: 20.
    expect(batchSizes).toEqual([25, 1, 15, 20]);
    expect(new Set(deletedKeys(dbSend, "UserFeedback", "billId"))).toEqual(new Set(feedback));
  });

  it("keeps an endpoint another user's row still uses, but deletes this user's device row", async () => {
    const { context, dbSend, snsSend } = fakeContext(
      { devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/shared" }] },
      { tokenOwners: { aa11: ["u1", "other-user"] } },
    );

    const counts = await deleteUserData(context, "u1");

    expect(snsSend).not.toHaveBeenCalled();
    expect(counts).toEqual(expect.objectContaining({ devices: 1, snsEndpoints: 0, sharedSnsEndpointsKept: 1 }));
    expect(deletedKeys(dbSend, "UserDevices", "deviceId")).toEqual(["dev-1"]);
    expect(warnSpy).toHaveBeenCalledWith("Keeping SNS endpoint still registered to another user", {
      userId: "u1",
      endpointArn: "arn:endpoint/shared",
    });
  });

  it("deletes an endpoint shared by two of the user's own rows once", async () => {
    const { context, snsSend } = fakeContext(
      {
        devices: [
          { deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/one" },
          { deviceId: "dev-2", pushToken: "aa11", endpointArn: "arn:endpoint/one" },
        ],
      },
      { tokenOwners: { aa11: ["u1", "u1"] } },
    );

    const counts = await deleteUserData(context, "u1");

    expect(snsSend).toHaveBeenCalledTimes(1);
    expect(counts).toEqual(expect.objectContaining({ devices: 2, snsEndpoints: 1 }));
  });

  it("skips the shared-endpoint check when no push-token index is configured", async () => {
    const { context, dbSend, snsSend } = fakeContext(
      { devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/one" }] },
      {
        tokenOwners: { aa11: ["other-user"] },
        config: { ...config, devices: { ...config.devices, pushTokenIndexName: undefined } },
      },
    );

    await deleteUserData(context, "u1");

    expect(commands(dbSend, "QueryCommand").some((command) => command.input.IndexName)).toBe(false);
    expect(snsSend).toHaveBeenCalledTimes(1);
  });

  it("treats an endpoint that is already gone as deleted", async () => {
    const { context, dbSend, snsSend } = fakeContext({
      devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/gone" }],
    });
    snsSend.mockRejectedValueOnce(awsError("NotFoundException"));

    await expect(deleteUserData(context, "u1")).resolves.toEqual(expect.objectContaining({ snsEndpoints: 1 }));
    expect(deletedKeys(dbSend, "UserDevices", "deviceId")).toEqual(["dev-1"]);
  });

  it("keeps the device rows and stops when an endpoint cannot be deleted", async () => {
    const { context, dbSend, snsSend } = fakeContext({
      devices: [{ deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/one" }],
      weeklyDigests: ["2026-10-04T14:00:00.000Z"],
    });
    snsSend.mockRejectedValueOnce(awsError("AuthorizationErrorException", "not authorized"));

    await expect(deleteUserData(context, "u1")).rejects.toThrow("not authorized");
    expect(deletedKeys(dbSend, "UserDevices", "deviceId")).toEqual([]);
    expect(dynamoSequence(dbSend)).not.toContain("QueryCommand:UserWeeklyDigests");
  });

  it("skips the weekly digests when their table is not configured", async () => {
    const { context, dbSend } = fakeContext(
      { weeklyDigests: ["2026-10-04T14:00:00.000Z"] },
      { config: { ...config, weeklyDigests: undefined } },
    );

    const counts = await deleteUserData(context, "u1");

    expect(counts.weeklyDigests).toBe(0);
    expect(dynamoSequence(dbSend).some((entry) => entry.includes("UserWeeklyDigests"))).toBe(false);
  });
});

describe("countUserData", () => {
  it("only reads, and counts exactly what deleteUserData then deletes", async () => {
    const data = {
      feedback: Array.from({ length: 30 }, (_, i) => `hr-${i}`),
      preferences: ["Taxes", "Healthcare"],
      devices: [
        { deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/own" },
        { deviceId: "dev-2", pushToken: "bb22", endpointArn: "arn:endpoint/shared" },
        { deviceId: "dev-3", pushToken: "aa11", endpointArn: "arn:endpoint/own" },
        { deviceId: "dev-4" },
      ],
      weeklyDigests: ["2026-09-27T14:00:00.000Z", "2026-10-04T14:00:00.000Z"],
    };
    const options = { pageSize: 7, tokenOwners: { aa11: ["u1"], bb22: ["u1", "other-user"] } };

    const reader = fakeContext(data, options);
    const counted = await countUserData(reader.context, "u1");

    expect(counted).toEqual({
      feedback: 30,
      preferences: 2,
      devices: 4,
      snsEndpoints: 1,
      sharedSnsEndpointsKept: 1,
      weeklyDigests: 2,
    });
    expect(new Set(commands(reader.dbSend).map((command) => command.constructor.name))).toEqual(
      new Set(["QueryCommand"]),
    );
    expect(reader.snsSend).not.toHaveBeenCalled();
    expect(reader.cognitoSend).not.toHaveBeenCalled();

    const deleter = fakeContext(data, options);
    jest.spyOn(console, "warn").mockImplementationOnce(() => undefined);
    await expect(deleteUserData(deleter.context, "u1")).resolves.toEqual(counted);
  });
});

describe("deleteCognitoUser", () => {
  it("deletes the user from the configured pool", async () => {
    const { context, cognitoSend } = fakeContext();

    await expect(deleteCognitoUser(context, "u1")).resolves.toBe(true);
    expect(commands(cognitoSend, "AdminDeleteUserCommand")[0].input).toEqual({
      UserPoolId: "us-east-1_pool",
      Username: "u1",
    });
  });

  it("counts a user already gone as deleted and rethrows other errors", async () => {
    const { context, cognitoSend } = fakeContext();
    cognitoSend.mockRejectedValueOnce(awsError("UserNotFoundException"));
    await expect(deleteCognitoUser(context, "u1")).resolves.toBe(true);

    cognitoSend.mockRejectedValueOnce(awsError("TooManyRequestsException"));
    await expect(deleteCognitoUser(context, "u1")).rejects.toThrow("TooManyRequestsException");
  });

  it("leaves the user to the client when no pool is configured", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { context, cognitoSend } = fakeContext({}, { config: { ...config, userPoolId: undefined } });

    await expect(deleteCognitoUser(context, "u1")).resolves.toBe(false);
    expect(cognitoSend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "USER_POOL_ID is not configured; leaving Cognito user deletion to the client",
      { userId: "u1" },
    );
    warnSpy.mockRestore();
  });
});

describe("deletionErrorMessage", () => {
  it("uses the error's message, or a fixed text when there is none", () => {
    expect(deletionErrorMessage(new Error("Rate exceeded"))).toBe("Rate exceeded");
    expect(deletionErrorMessage(new Error(""))).toBe("Unknown account deletion error");
    expect(deletionErrorMessage("boom")).toBe("Unknown account deletion error");
    expect(deletionErrorMessage(null)).toBe("Unknown account deletion error");
  });
});

// ─── X5: the address claim, the sign-up email claim and the App Attest bindings ──

type Row = Record<string, AttributeValue>;

const X5_TABLES = {
  addressClaims: { tableName: "VerifiedAddressClaims" },
  signUpEmailClaims: { tableName: "SignUpEmailClaims" },
  appAttest: { tableName: "AppAttest" },
} as const;
const x5Config: AccountDeletionConfig = { ...config, ...X5_TABLES };

const KEY_ATTRIBUTES: Record<string, string[]> = {
  UserPII: ["userId"],
  UserFeedback: ["userId", "billId"],
  UserPreferences: ["userId", "preference"],
  UserDevices: ["userId", "deviceId"],
  UserWeeklyDigests: ["userId", "publishedAt"],
  VerifiedAddressClaims: ["claimKey", "member"],
  SignUpEmailClaims: ["pk"],
  AppAttest: ["pk", "sk"],
};

const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });

/**
 * Every table the deletion touches, in memory. Conditions are evaluated exactly as sent
 * (fixtures/dynamoCondition), projections are applied, a TransactWriteItems is cancelled with
 * per-item reasons, an UpdateItem whose condition passes on a missing item creates it (as DynamoDB
 * does), and Query pages `pageSize` items at a time. `before(name, input)` runs ahead of each call
 * (to inject a failure or a concurrent write).
 */
function createStore(options: { pageSize?: number } = {}) {
  const pageSize = options.pageSize ?? 1000;
  const tables = new Map<string, Map<string, Row>>();
  const table = (name: string): Map<string, Row> => {
    if (!KEY_ATTRIBUTES[name]) throw new Error(`Unknown table ${name}`);
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const id = (tableName: string, key: Row) => KEY_ATTRIBUTES[tableName].map((name) => key[name]?.S ?? "").join("|");
  const put = (tableName: string, row: Row) => table(tableName).set(id(tableName, row), row);
  const get = (tableName: string, key: Row) => table(tableName).get(id(tableName, key));
  const remove = (tableName: string, key: Row) => table(tableName).delete(id(tableName, key));
  const rows = (tableName: string) => [...table(tableName).values()];
  const project = (row: Row, input: FakeInput): Row => {
    if (!input.ProjectionExpression) return row;
    const names = input.ProjectionExpression.split(",")
      .map((token) => token.trim())
      .map((token) => (token.startsWith("#") ? input.ExpressionAttributeNames![token] : token));
    return Object.fromEntries(Object.entries(row).filter(([name]) => names.includes(name)));
  };
  const keyOnly = (tableName: string, key: Row): Row =>
    Object.fromEntries(KEY_ATTRIBUTES[tableName].map((name) => [name, key[name]]));
  const counterAfter = (current: Row | undefined, op: TransactPart): Row => {
    const value = Number(current?.n?.N ?? 0);
    if (op.UpdateExpression === "SET #n = #n - :one") return { ...op.Key, n: n(value - 1) };
    if (op.UpdateExpression === "SET #n = if_not_exists(#n, :zero) + :one") return { ...op.Key, n: n(value + 1) };
    throw new Error(`Unexpected counter update ${op.UpdateExpression}`);
  };
  let before: ((name: string, input: FakeInput) => void) | undefined;

  const send = jest.fn(async (command: FakeCommand) => {
    const name = command.constructor.name;
    const input = command.input;
    before?.(name, input);
    switch (name) {
      case "GetItemCommand": {
        const row = get(input.TableName!, input.Key!);
        return row ? { Item: project(row, input) } : {};
      }
      case "QueryCommand": {
        if (input.IndexName) return { Items: [] };
        // Pages by key, as DynamoDB does: deleting a page's rows does not shift the next page.
        const partitionKey = input.ExpressionAttributeNames!["#pk"];
        const value = input.ExpressionAttributeValues![":pk"].S;
        const tableName = input.TableName!;
        const after = input.ExclusiveStartKey ? id(tableName, input.ExclusiveStartKey) : undefined;
        const matching = rows(tableName)
          .filter((row) => row[partitionKey]?.S === value)
          .sort((a, b) => id(tableName, a).localeCompare(id(tableName, b)))
          .filter((row) => after === undefined || id(tableName, row) > after);
        const page = matching.slice(0, pageSize);
        return {
          Items: page.map((row) => project(row, input)),
          ...(matching.length > pageSize ? { LastEvaluatedKey: keyOnly(tableName, page[page.length - 1]) } : {}),
        };
      }
      case "BatchWriteItemCommand": {
        for (const [tableName, requests] of Object.entries(input.RequestItems!)) {
          for (const request of requests) table(tableName).delete(id(tableName, request.DeleteRequest!.Key!));
        }
        return {};
      }
      case "DeleteItemCommand": {
        const old = get(input.TableName!, input.Key!);
        if (!evaluateCondition(old, input)) throw conditionalCheckFailed();
        table(input.TableName!).delete(id(input.TableName!, input.Key!));
        return input.ReturnValues === "ALL_OLD" && old ? { Attributes: old } : {};
      }
      case "UpdateItemCommand": {
        const current = get(input.TableName!, input.Key!);
        if (!evaluateCondition(current, input)) throw conditionalCheckFailed();
        const match = /^REMOVE (.+)$/.exec(input.UpdateExpression!);
        if (!match) throw new Error(`Unexpected update ${input.UpdateExpression}`);
        const removed = match[1].split(",").map((token) => input.ExpressionAttributeNames![token.trim()]);
        const next = { ...(current ?? keyOnly(input.TableName!, input.Key!)) };
        for (const attribute of removed) delete next[attribute];
        put(input.TableName!, next);
        return {};
      }
      case "TransactWriteItemsCommand": {
        const entries = input.TransactItems!.map((entry) => {
          const [kind, op] = Object.entries(entry)[0] as [string, TransactPart];
          return { kind, op, key: (kind === "Put" ? op.Item : op.Key)! };
        });
        const reasons = entries.map((entry) => ({
          Code: evaluateCondition(get(entry.op.TableName!, entry.key), entry.op) ? "None" : "ConditionalCheckFailed",
        }));
        if (reasons.some((reason) => reason.Code !== "None")) {
          throw Object.assign(new Error("Transaction cancelled"), {
            name: "TransactionCanceledException",
            CancellationReasons: reasons,
          });
        }
        for (const entry of entries) {
          if (entry.kind === "Delete") table(entry.op.TableName!).delete(id(entry.op.TableName!, entry.key));
          else if (entry.kind === "Update")
            put(entry.op.TableName!, counterAfter(get(entry.op.TableName!, entry.key), entry.op));
          else put(entry.op.TableName!, entry.op.Item!);
        }
        return {};
      }
      case "PutItemCommand":
        put(input.TableName!, input.Item!);
        return {};
      default:
        throw new Error(`Unexpected DynamoDB command ${name}`);
    }
  });

  const context = {
    config: x5Config,
    db: { send },
    sns: { send: jest.fn(async () => ({})) },
    cognito: { send: jest.fn(async () => ({})) },
  } as unknown as AccountDeletionContext;

  return {
    context,
    send,
    put,
    get,
    remove,
    rows,
    setBefore: (hook: typeof before) => {
      before = hook;
    },
    withConfig: (configOverride: AccountDeletionConfig) => ({ ...context, config: configOverride }),
  };
}

type Store = ReturnType<typeof createStore>;

const CLAIMS = "VerifiedAddressClaims";
const EMAIL_CLAIMS = "SignUpEmailClaims";
const APP_ATTEST = "AppAttest";

const claimRowKey = (claimKey: string, member: string): Row => ({ claimKey: s(claimKey), member: s(member) });
const counterOf = (store: Store, claimKey: string) => Number(store.get(CLAIMS, claimRowKey(claimKey, "#COUNT"))?.n?.N);
const hasClaim = (store: Store, unitKey: string, userId: string) =>
  store.get(CLAIMS, claimRowKey(`U#${unitKey}`, `USER#${userId}`)) !== undefined;
const piiRow = (store: Store, userId = "u1") => store.get("UserPII", { userId: s(userId) });

/** u1's claim on unit A (shared with u2) of street S, both counters, and u1's UserPII row. */
function seedAddressClaim(store: Store, pii: Row = {}) {
  store.put(CLAIMS, { ...claimRowKey("U#unitA", "USER#u1"), claimedAt: s("2026-10-01T00:00:00.000Z") });
  store.put(CLAIMS, { ...claimRowKey("U#unitA", "USER#u2"), claimedAt: s("2026-10-02T00:00:00.000Z") });
  store.put(CLAIMS, { ...claimRowKey("U#unitA", "#COUNT"), n: n(2) });
  store.put(CLAIMS, { ...claimRowKey("S#streetS", "#COUNT"), n: n(3) });
  store.put("UserPII", {
    userId: s("u1"),
    deletionStatus: s("in_progress"),
    deletionRequestedAt: s("2026-10-08T12:00:00.000Z"),
    constituentVerified: { BOOL: true },
    verifiedAddressKey: s("unitA"),
    verifiedStreetKey: s("streetS"),
    addressChangeLog: { L: [s("2026-09-20T00:00:00.000Z"), s("2026-10-01T00:00:00.000Z")] },
    ...pii,
  });
}

/** u1's email claim under `userName` (EMAIL#ek-1 and USER#<userName>), plus another account's claim. */
function seedEmailClaim(store: Store, userName = "u1", emailHolder = userName) {
  store.put(EMAIL_CLAIMS, {
    pk: s(emailClaimKey("ek-1")),
    userName: s(emailHolder),
    claimedAt: s("2026-10-01T00:00:00.000Z"),
  });
  store.put(EMAIL_CLAIMS, {
    pk: s(userClaimKey(userName)),
    emailKey: s("ek-1"),
    claimedAt: s("2026-10-01T00:00:00.000Z"),
  });
  store.put(EMAIL_CLAIMS, {
    pk: s(emailClaimKey("ek-2")),
    userName: s("u2"),
    claimedAt: s("2026-10-02T00:00:00.000Z"),
  });
  store.put(EMAIL_CLAIMS, { pk: s(userClaimKey("u2")), emailKey: s("ek-2"), claimedAt: s("2026-10-02T00:00:00.000Z") });
}

/** `bindings` App Attest bindings for u1 on key k1, one for u2, the key row and a challenge. */
function seedAppAttest(store: Store, bindings = 2) {
  for (let i = 0; i < bindings; i += 1) {
    store.put(APP_ATTEST, { ...bindingItemKey("u1", `k${i}`), firstSeenAt: s("2026-10-01T00:00:00.000Z") });
  }
  store.put(APP_ATTEST, { ...bindingItemKey("u2", "k0"), firstSeenAt: s("2026-10-02T00:00:00.000Z") });
  store.put(APP_ATTEST, { ...keyItemKey("k0"), accountCount: n(2), signupCount: n(1), status: s("active") });
  store.put(APP_ATTEST, { ...challengeItemKey("challenge-1"), purpose: s("assert") });
}

function seedAll(store: Store) {
  seedAddressClaim(store);
  seedEmailClaim(store);
  seedAppAttest(store);
}

/** "Command:Table" for each call, from the first call on an X5 table or UserPII on. */
const x5Sequence = (store: Store) => {
  const sequence = commands(store.send).map((command) => {
    const input = command.input;
    const table =
      input.TableName ??
      Object.keys(input.RequestItems ?? {})[0] ??
      (input.TransactItems
        ? (Object.values(input.TransactItems[0])[0] as { TableName?: string }).TableName
        : undefined);
    return `${command.constructor.name}:${table}`;
  });
  const first = sequence.findIndex((entry) => /UserPII|VerifiedAddressClaims|SignUpEmailClaims|AppAttest/.test(entry));
  return first === -1 ? [] : sequence.slice(first);
};

const touchesTable = (store: Store, tableName: string) =>
  commands(store.send).some((command) => JSON.stringify(command.input).includes(`"${tableName}"`));

describe("deleteUserData X5 steps", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("releases the address claim, deletes the email claim and the App Attest bindings, after the other data", async () => {
    const store = createStore();
    seedAll(store);
    store.put("UserFeedback", { userId: s("u1"), billId: s("hr-1") });

    const counts = await deleteUserData(store.context, "u1");

    expect(counts).toEqual({
      feedback: 1,
      preferences: 0,
      devices: 0,
      snsEndpoints: 0,
      sharedSnsEndpointsKept: 0,
      weeklyDigests: 0,
      addressClaims: 1,
      emailClaims: 2,
      appAttestBindings: 2,
    });

    // (a) The claim row is gone and both counters dropped by one; u2's claim is untouched.
    expect(hasClaim(store, "unitA", "u1")).toBe(false);
    expect(hasClaim(store, "unitA", "u2")).toBe(true);
    expect(counterOf(store, "U#unitA")).toBe(1);
    expect(counterOf(store, "S#streetS")).toBe(2);
    // The PII row loses exactly the three claim attributes (the caller then tombstones it).
    const pii = piiRow(store)!;
    for (const attribute of ADDRESS_CLAIM_PII_ATTRIBUTES) expect(pii).not.toHaveProperty(attribute);
    expect(pii.deletionStatus).toEqual(s("in_progress"));
    expect(pii.constituentVerified).toEqual({ BOOL: true });

    // (b) Both items of u1's claim are gone; u2's claim stays.
    expect(store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })).toBeUndefined();
    expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u1")) })).toBeUndefined();
    expect(store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-2")) })).toBeDefined();
    expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u2")) })).toBeDefined();

    // (c) u1's bindings are gone; the key row (with its counts), u2's binding and the challenge stay.
    expect(store.rows(APP_ATTEST).filter((row) => row.pk.S === userPartitionKey("u1"))).toEqual([]);
    expect(store.get(APP_ATTEST, keyItemKey("k0"))).toEqual(
      expect.objectContaining({ accountCount: n(2), signupCount: n(1) }),
    );
    expect(store.get(APP_ATTEST, bindingItemKey("u2", "k0"))).toBeDefined();
    expect(store.get(APP_ATTEST, challengeItemKey("challenge-1"))).toBeDefined();

    // After the pre-X5 steps, in X5 order: (a), (b), (c).
    expect(x5Sequence(store)).toEqual([
      "GetItemCommand:UserPII",
      "TransactWriteItemsCommand:VerifiedAddressClaims",
      "UpdateItemCommand:UserPII",
      "GetItemCommand:SignUpEmailClaims",
      "DeleteItemCommand:SignUpEmailClaims",
      "DeleteItemCommand:SignUpEmailClaims",
      "QueryCommand:AppAttest",
      "BatchWriteItemCommand:AppAttest",
    ]);
    const sequence = dynamoSequence(store.send);
    expect(sequence.indexOf("BatchWriteItemCommand:UserFeedback")).toBeLessThan(
      sequence.indexOf("GetItemCommand:UserPII"),
    );
    // No BillStats, ever.
    expect(touchesTable(store, "BillStats")).toBe(false);
  });

  it("sends the exact reads and writes X5 specifies", async () => {
    const store = createStore();
    seedAll(store);

    await deleteUserData(store.context, "u1");

    const [piiRead] = commands(store.send, "GetItemCommand");
    expect(piiRead.input).toEqual({
      TableName: "UserPII",
      Key: { userId: s("u1") },
      ConsistentRead: true,
      ProjectionExpression: "#claim0, #claim1, #claim2",
      ExpressionAttributeNames: {
        "#claim0": "verifiedAddressKey",
        "#claim1": "verifiedStreetKey",
        "#claim2": "addressChangeLog",
      },
    });

    // One transaction: delete the claim (it must exist), decrement both counters (only while n > 0).
    const [release] = commands(store.send, "TransactWriteItemsCommand");
    expect(release.input.TransactItems).toEqual([
      {
        Delete: {
          TableName: CLAIMS,
          Key: claimRowKey("U#unitA", "USER#u1"),
          ConditionExpression: "attribute_exists(#m)",
          ExpressionAttributeNames: { "#m": "member" },
        },
      },
      {
        Update: expect.objectContaining({
          TableName: CLAIMS,
          Key: claimRowKey("U#unitA", "#COUNT"),
          UpdateExpression: "SET #n = #n - :one",
          ConditionExpression: "#n > :zero",
        }),
      },
      {
        Update: expect.objectContaining({
          TableName: CLAIMS,
          Key: claimRowKey("S#streetS", "#COUNT"),
          UpdateExpression: "SET #n = #n - :one",
          ConditionExpression: "#n > :zero",
        }),
      },
    ]);

    const [piiClear] = commands(store.send, "UpdateItemCommand");
    expect(piiClear.input).toEqual({
      TableName: "UserPII",
      Key: { userId: s("u1") },
      UpdateExpression: "REMOVE #claim0, #claim1, #claim2",
      ConditionExpression: "#claim0 = :unitKey",
      ExpressionAttributeNames: {
        "#claim0": "verifiedAddressKey",
        "#claim1": "verifiedStreetKey",
        "#claim2": "addressChangeLog",
      },
      ExpressionAttributeValues: { ":unitKey": s("unitA") },
    });

    const emailCalls = commands(store.send).filter((command) => command.input.TableName === EMAIL_CLAIMS);
    expect(emailCalls.map((command) => command.input)).toEqual([
      {
        TableName: EMAIL_CLAIMS,
        Key: { pk: s("USER#u1") },
        ConsistentRead: true,
        ProjectionExpression: "#emailKey",
        ExpressionAttributeNames: { "#emailKey": "emailKey" },
      },
      {
        TableName: EMAIL_CLAIMS,
        Key: { pk: s("EMAIL#ek-1") },
        ConditionExpression: "#userName = :userName OR attribute_exists(#holders.#holder)",
        ExpressionAttributeNames: { "#userName": "userName", "#holders": "holders", "#holder": "u1" },
        ExpressionAttributeValues: { ":userName": s("u1") },
        ReturnValues: "ALL_OLD",
      },
      { TableName: EMAIL_CLAIMS, Key: { pk: s("USER#u1") } },
    ]);

    const [bindingsQuery] = commands(store.send, "QueryCommand").filter(
      (command) => command.input.TableName === APP_ATTEST,
    );
    expect(bindingsQuery.input).toEqual(
      expect.objectContaining({
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": s("USER#u1") },
        ProjectionExpression: "#pk, #sk",
      }),
    );
    expect(deletedKeys(store.send, APP_ATTEST, "sk")).toEqual(["KEY#k0", "KEY#k1"]);
  });

  it.each([
    ["addressClaims", "VerifiedAddressClaims", "ADDRESS_CLAIMS_TABLE_NAME"],
    ["signUpEmailClaims", "SignUpEmailClaims", "SIGNUP_EMAIL_CLAIMS_TABLE_NAME"],
    ["appAttest", "AppAttest", "APP_ATTEST_TABLE_NAME"],
  ] as const)(
    "skips the %s step when %s's variable (%s) is unset, and runs the other two",
    async (key, tableName, _variable) => {
      const store = createStore();
      seedAll(store);
      const context = store.withConfig({ ...x5Config, [key]: undefined });

      const counts = await deleteUserData(context, "u1");

      expect(touchesTable(store, tableName)).toBe(false);
      const countKey = {
        addressClaims: "addressClaims",
        signUpEmailClaims: "emailClaims",
        appAttest: "appAttestBindings",
      }[key];
      expect(Object.keys(counts)).not.toContain(countKey);
      const others = ACCOUNT_LINK_COUNT_KEYS.filter((name) => name !== countKey);
      for (const other of others) expect(counts[other]).toBeGreaterThan(0);
      if (key === "addressClaims") {
        // Not even the UserPII read: the row and the claim are untouched.
        expect(touchesTable(store, "UserPII")).toBe(false);
        expect(hasClaim(store, "unitA", "u1")).toBe(true);
        expect(piiRow(store)?.verifiedAddressKey).toEqual(s("unitA"));
      }
    },
  );

  it("with no X5 table configured, makes no extra call and reports no X5 count", async () => {
    const store = createStore();
    seedAll(store);

    const counts = await deleteUserData(store.withConfig(config), "u1");

    expect(Object.keys(counts).sort()).toEqual(
      ["devices", "feedback", "preferences", "sharedSnsEndpointsKept", "snsEndpoints", "weeklyDigests"].sort(),
    );
    expect(x5Sequence(store)).toEqual([]);
    expect(hasClaim(store, "unitA", "u1")).toBe(true);
  });

  it("(a) makes no write when the account holds no claim, and creates no UserPII row when there is none", async () => {
    const withoutClaim = createStore();
    withoutClaim.put("UserPII", { userId: s("u1"), deletionStatus: s("in_progress") });
    const noRow = createStore();

    for (const store of [withoutClaim, noRow]) {
      const counts = await deleteUserData(
        store.withConfig({ ...config, addressClaims: X5_TABLES.addressClaims }),
        "u1",
      );
      expect(counts.addressClaims).toBe(0);
      expect(x5Sequence(store)).toEqual(["GetItemCommand:UserPII"]);
    }
    expect(piiRow(noRow)).toBeUndefined();
  });

  it("(a) is safe to repeat: a claim row already gone counts 0, leaves the counters and still clears the row", async () => {
    const store = createStore();
    seedAddressClaim(store);
    // A first run released the claim (row gone, counters down), then failed before clearing the UserPII row.
    store.remove(CLAIMS, claimRowKey("U#unitA", "USER#u1"));
    store.put(CLAIMS, { ...claimRowKey("U#unitA", "#COUNT"), n: n(1) });
    store.put(CLAIMS, { ...claimRowKey("S#streetS", "#COUNT"), n: n(2) });

    const counts = await deleteUserData(store.withConfig({ ...config, addressClaims: X5_TABLES.addressClaims }), "u1");

    expect(counts.addressClaims).toBe(0);
    expect(counterOf(store, "U#unitA")).toBe(1);
    expect(counterOf(store, "S#streetS")).toBe(2);
    for (const attribute of ADDRESS_CLAIM_PII_ATTRIBUTES) expect(piiRow(store)).not.toHaveProperty(attribute);
    // The cancelled release (the claim's condition failed) is not retried.
    expect(commands(store.send, "TransactWriteItemsCommand")).toHaveLength(1);
  });

  it("is safe to repeat as a whole: a second run deletes nothing more and changes no counter", async () => {
    const store = createStore();
    seedAll(store);
    await deleteUserData(store.context, "u1");
    const snapshot = (name: string) => JSON.stringify(store.rows(name));
    const after = [CLAIMS, EMAIL_CLAIMS, APP_ATTEST, "UserPII"].map(snapshot);

    const again = await deleteUserData(store.context, "u1");

    expect(again).toEqual(expect.objectContaining({ addressClaims: 0, emailClaims: 0, appAttestBindings: 0 }));
    expect([CLAIMS, EMAIL_CLAIMS, APP_ATTEST, "UserPII"].map(snapshot)).toEqual(after);
  });

  it("(a) leaves the street counter alone for a claim recorded without a street key", async () => {
    const store = createStore();
    seedAddressClaim(store, {});
    const row = piiRow(store)!;
    delete row.verifiedStreetKey;
    store.put("UserPII", row);

    const counts = await deleteUserData(store.withConfig({ ...config, addressClaims: X5_TABLES.addressClaims }), "u1");

    expect(counts.addressClaims).toBe(1);
    expect(counterOf(store, "U#unitA")).toBe(1);
    expect(counterOf(store, "S#streetS")).toBe(3);
  });

  it("(a) clears the change log of a capped account (no claim) without a transaction", async () => {
    const store = createStore();
    store.put("UserPII", {
      userId: s("u1"),
      verificationMethod: s("address_capped"),
      verificationLimitReason: s("address_limit"),
      addressChangeLog: { L: [s("2026-10-01T00:00:00.000Z")] },
    });

    const counts = await deleteUserData(store.withConfig({ ...config, addressClaims: X5_TABLES.addressClaims }), "u1");

    expect(counts.addressClaims).toBe(0);
    expect(x5Sequence(store)).toEqual(["GetItemCommand:UserPII", "UpdateItemCommand:UserPII"]);
    const [clear] = commands(store.send, "UpdateItemCommand");
    expect(clear.input.ConditionExpression).toBe("attribute_exists(#pk) AND attribute_not_exists(#claim0)");
    expect(clear.input.ExpressionAttributeNames!["#pk"]).toBe("userId");
    expect(piiRow(store)).not.toHaveProperty("addressChangeLog");
    expect(piiRow(store)?.verificationMethod).toEqual(s("address_capped"));
  });

  it("(a) also releases a claim a verification moved the account to in between, so no claim is left behind", async () => {
    const store = createStore();
    seedAddressClaim(store);
    // A verification that read the row before the deletion claim commits right after the deletion's read:
    // its own transaction releases unit A and claims unit B, and its UserPII update points the row at B.
    let verificationLanded = false;
    store.setBefore((name, input) => {
      if (name !== "TransactWriteItemsCommand" || verificationLanded) return;
      verificationLanded = true;
      expect(input.TransactItems![0].Delete!.Key).toEqual(claimRowKey("U#unitA", "USER#u1"));
      store.remove(CLAIMS, claimRowKey("U#unitA", "USER#u1"));
      store.put(CLAIMS, { ...claimRowKey("U#unitA", "#COUNT"), n: n(1) });
      store.put(CLAIMS, { ...claimRowKey("S#streetS", "#COUNT"), n: n(2) });
      store.put(CLAIMS, { ...claimRowKey("U#unitB", "USER#u1"), claimedAt: s("2026-10-08T12:00:01.000Z") });
      store.put(CLAIMS, { ...claimRowKey("U#unitB", "#COUNT"), n: n(1) });
      store.put(CLAIMS, { ...claimRowKey("S#streetT", "#COUNT"), n: n(1) });
      store.put("UserPII", { ...piiRow(store)!, verifiedAddressKey: s("unitB"), verifiedStreetKey: s("streetT") });
    });

    const counts = await deleteUserData(store.withConfig({ ...config, addressClaims: X5_TABLES.addressClaims }), "u1");

    expect(counts.addressClaims).toBe(1);
    expect(store.rows(CLAIMS).filter((row) => row.member.S === "USER#u1")).toEqual([]);
    expect(counterOf(store, "U#unitA")).toBe(1);
    expect(counterOf(store, "S#streetS")).toBe(2);
    expect(counterOf(store, "U#unitB")).toBe(0);
    expect(counterOf(store, "S#streetT")).toBe(0);
    for (const attribute of ADDRESS_CLAIM_PII_ATTRIBUTES) expect(piiRow(store)).not.toHaveProperty(attribute);
    expect(x5Sequence(store)).toEqual([
      "GetItemCommand:UserPII",
      "TransactWriteItemsCommand:VerifiedAddressClaims", // unit A: cancelled, the verification released it
      "UpdateItemCommand:UserPII", // condition fails: the row now points at unit B
      "GetItemCommand:UserPII",
      "TransactWriteItemsCommand:VerifiedAddressClaims", // unit B
      "UpdateItemCommand:UserPII",
    ]);
  });

  it("(a) fails the deletion when the row keeps changing, before the email and App Attest steps", async () => {
    const store = createStore();
    seedAll(store);
    let moves = 0;
    store.setBefore((name, input) => {
      if (name !== "UpdateItemCommand" || input.TableName !== "UserPII") return;
      moves += 1;
      store.put("UserPII", { ...piiRow(store)!, verifiedAddressKey: s(`unit-moved-${moves}`) });
    });

    await expect(deleteUserData(store.context, "u1")).rejects.toThrow(
      "Address claim release did not settle after 3 attempts",
    );

    expect(commands(store.send, "UpdateItemCommand")).toHaveLength(3);
    expect(touchesTable(store, EMAIL_CLAIMS)).toBe(false);
    expect(touchesTable(store, APP_ATTEST)).toBe(false);
  });

  it("(a) rethrows a claims-table error and leaves the UserPII row pointing at the claim for the retry", async () => {
    const store = createStore();
    seedAll(store);
    store.setBefore((name) => {
      if (name === "TransactWriteItemsCommand")
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    });

    await expect(deleteUserData(store.context, "u1")).rejects.toThrow("denied");

    expect(piiRow(store)?.verifiedAddressKey).toEqual(s("unitA"));
    expect(hasClaim(store, "unitA", "u1")).toBe(true);
    expect(touchesTable(store, EMAIL_CLAIMS)).toBe(false);
  });
  it("(a) rethrows a UserPII error after the release; the retry then finds the claim row gone and clears the row", async () => {
    const store = createStore();
    seedAddressClaim(store);
    const context = store.withConfig({ ...config, addressClaims: X5_TABLES.addressClaims });
    store.setBefore((name) => {
      if (name === "UpdateItemCommand")
        throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    });

    await expect(deleteUserData(context, "u1")).rejects.toThrow("Rate exceeded");
    expect(hasClaim(store, "unitA", "u1")).toBe(false);
    expect(counterOf(store, "U#unitA")).toBe(1);

    store.setBefore(undefined);
    await expect(deleteUserData(context, "u1")).resolves.toEqual(expect.objectContaining({ addressClaims: 0 }));
    expect(counterOf(store, "U#unitA")).toBe(1);
    expect(counterOf(store, "S#streetS")).toBe(2);
    expect(piiRow(store)).not.toHaveProperty("verifiedAddressKey");
  });
});

describe("deleteUserData X5 (b) email claim and (c) App Attest bindings", () => {
  const emailOnly = { ...config, signUpEmailClaims: X5_TABLES.signUpEmailClaims };
  const appAttestOnly = { ...config, appAttest: X5_TABLES.appAttest };
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("(b) looks the claim up by the Cognito username when one is given, and matches EMAIL# on it", async () => {
    const store = createStore();
    seedEmailClaim(store, "cognito-name-1");

    const counts = await deleteUserData(store.withConfig(emailOnly), "u1", { cognitoUserName: " cognito-name-1 " });

    expect(counts.emailClaims).toBe(2);
    const [read, emailDelete, userDelete] = commands(store.send).filter(
      (command) => command.input.TableName === EMAIL_CLAIMS,
    );
    expect(read.input.Key).toEqual({ pk: s("USER#cognito-name-1") });
    expect(emailDelete.input.ExpressionAttributeValues).toEqual({ ":userName": s("cognito-name-1") });
    expect(userDelete.input.Key).toEqual({ pk: s("USER#cognito-name-1") });
    expect(store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })).toBeUndefined();
  });

  it("(b) falls back to the sub when no username is given (or it is blank)", async () => {
    for (const options of [undefined, { cognitoUserName: "  " }]) {
      const store = createStore();
      seedEmailClaim(store, "u1");
      const counts = await deleteUserData(store.withConfig(emailOnly), "u1", options);
      expect(counts.emailClaims).toBe(2);
      expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u1")) })).toBeUndefined();
    }
  });

  it("(b) keeps an EMAIL# item that now names another account and still deletes this account's USER# item", async () => {
    const store = createStore();
    // The base address was taken over by u3 (u1's claim was not live), so EMAIL#ek-1 names u3.
    seedEmailClaim(store, "u1", "u3");

    const counts = await deleteUserData(store.withConfig(emailOnly), "u1");

    expect(counts.emailClaims).toBe(1);
    expect(store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })?.userName).toEqual(s("u3"));
    expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u1")) })).toBeUndefined();
    // Logged without the email key or any address.
    expect(warnSpy).toHaveBeenCalledWith("Sign-up email claim no longer names this account; keeping it", {
      userId: "u1",
    });
  });

  it.each([
    ["one of the holders, not the latest", "u3", { u1: "2026-10-01T00:00:00.000Z", u3: "2026-10-01T00:00:02.000Z" }],
    ["the latest holder, with others", "u1", { u3: "2026-10-01T00:00:00.000Z", u1: "2026-10-01T00:00:02.000Z" }],
  ])(
    "(b) deletes the whole EMAIL# item when the account is %s, and the other holders' USER# items (no email hash is left behind)",
    async (_label, latest, holders) => {
      const build = () => {
        const store = createStore();
        seedEmailClaim(store, "u1", latest);
        store.put(EMAIL_CLAIMS, {
          ...store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })!,
          addressKey: s("ak-1"),
          holders: { M: Object.fromEntries(Object.entries(holders).map(([name, at]) => [name, s(at)])) },
          revision: s("rev-1"),
        });
        // u3, an attempt on the same address that Cognito refused, wrote its own USER# item with the base hash.
        store.put(EMAIL_CLAIMS, { pk: s(userClaimKey("u3")), emailKey: s("ek-1"), claimedAt: s(holders.u3) });
        return store;
      };
      const reader = build();
      const counted = await countUserData(reader.context, "u1");
      const store = build();

      const counts = await deleteUserData(store.withConfig(emailOnly), "u1");

      expect(counts.emailClaims).toBe(3);
      expect(counted.emailClaims).toBe(3);
      expect(store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })).toBeUndefined();
      expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u1")) })).toBeUndefined();
      expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u3")) })).toBeUndefined();
      expect(store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-2")) })).toBeDefined();
      expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u2")) })).toBeDefined();
    },
  );

  it("(b) deletes another holder's USER# item only while it names the same email key", async () => {
    const store = createStore();
    seedEmailClaim(store, "u1");
    store.put(EMAIL_CLAIMS, {
      ...store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })!,
      addressKey: s("ak-1"),
      holders: { M: { u1: s("2026-10-01T00:00:00.000Z"), u2: s("2026-10-01T00:00:01.000Z"), u5: s("x") } },
      revision: s("rev-1"),
    });

    const counts = await deleteUserData(store.withConfig(emailOnly), "u1");

    // USER#u2 names ek-2 (another claim) and USER#u5 is gone: both are left alone.
    expect(counts.emailClaims).toBe(2);
    expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u2")) })?.emailKey).toEqual(s("ek-2"));
    expect(store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })).toBeUndefined();
  });

  it("(b) keeps an EMAIL# item whose holders do not include the account", async () => {
    const store = createStore();
    seedEmailClaim(store, "u1", "u3");
    store.put(EMAIL_CLAIMS, {
      ...store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })!,
      holders: { M: { u3: s("2026-10-01T00:00:00.000Z"), u4: s("2026-10-01T00:00:01.000Z") } },
      revision: s("rev-1"),
    });

    const counts = await deleteUserData(store.withConfig(emailOnly), "u1");

    expect(counts.emailClaims).toBe(1);
    expect(store.get(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) })?.userName).toEqual(s("u3"));
  });

  it("(b) deletes only the USER# item when its EMAIL# item is already gone or it has no emailKey", async () => {
    const goneEmail = createStore();
    seedEmailClaim(goneEmail, "u1");
    goneEmail.remove(EMAIL_CLAIMS, { pk: s(emailClaimKey("ek-1")) });
    const noKey = createStore();
    noKey.put(EMAIL_CLAIMS, { pk: s(userClaimKey("u1")), claimedAt: s("2026-10-01T00:00:00.000Z") });

    for (const store of [goneEmail, noKey]) {
      const counts = await deleteUserData(store.withConfig(emailOnly), "u1");
      expect(counts.emailClaims).toBe(1);
      expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u1")) })).toBeUndefined();
    }
    expect(commands(noKey.send, "DeleteItemCommand").map((command) => command.input.Key)).toEqual([
      { pk: s("USER#u1") },
    ]);
  });

  it("(b) does nothing when the account never had an email claim (signed up before the filter)", async () => {
    const store = createStore();
    seedEmailClaim(store, "someone-else");

    const counts = await deleteUserData(store.withConfig(emailOnly), "u1");

    expect(counts.emailClaims).toBe(0);
    expect(commands(store.send, "DeleteItemCommand")).toEqual([]);
    expect(store.rows(EMAIL_CLAIMS)).toHaveLength(4);
  });

  it("(b) keeps the USER# item when the EMAIL# delete fails, so a retry can still find the claim", async () => {
    const store = createStore();
    seedEmailClaim(store, "u1");
    store.setBefore((name, input) => {
      if (name === "DeleteItemCommand" && input.Key!.pk.S!.startsWith("EMAIL#")) {
        throw Object.assign(new Error("Throughput exceeded"), { name: "ProvisionedThroughputExceededException" });
      }
    });

    await expect(deleteUserData(store.withConfig(emailOnly), "u1")).rejects.toThrow("Throughput exceeded");
    expect(store.get(EMAIL_CLAIMS, { pk: s(userClaimKey("u1")) })).toBeDefined();

    store.setBefore(undefined);
    await expect(deleteUserData(store.withConfig(emailOnly), "u1")).resolves.toEqual(
      expect.objectContaining({ emailClaims: 2 }),
    );
  });

  it("(c) deletes every binding across pages (deleting as it pages), and keeps key rows and other accounts", async () => {
    const store = createStore({ pageSize: 20 });
    seedAppAttest(store, 30);

    const counts = await deleteUserData(store.withConfig(appAttestOnly), "u1");

    expect(counts.appAttestBindings).toBe(30);
    expect(store.rows(APP_ATTEST).filter((row) => row.pk.S === "USER#u1")).toEqual([]);
    expect(
      store
        .rows(APP_ATTEST)
        .map((row) => `${row.pk.S}/${row.sk.S}`)
        .sort(),
    ).toEqual(["CH#challenge-1/CH", "KEY#k0/META", "USER#u2/KEY#k0"]);
    const queries = commands(store.send, "QueryCommand").filter((command) => command.input.TableName === APP_ATTEST);
    expect(queries).toHaveLength(2);
    const batchSizes = commands(store.send, "BatchWriteItemCommand").map(
      (command) => command.input.RequestItems![APP_ATTEST].length,
    );
    expect(batchSizes).toEqual([20, 10]);
    // Only the account's partition is ever written.
    const deletedPartitions = new Set(
      commands(store.send, "BatchWriteItemCommand").flatMap((command) =>
        command.input.RequestItems![APP_ATTEST].map((request) => request.DeleteRequest!.Key!.pk.S),
      ),
    );
    expect(deletedPartitions).toEqual(new Set(["USER#u1"]));
  });

  it("(c) reports 0 and writes nothing for an account with no binding (old builds never create one)", async () => {
    const store = createStore();
    seedAppAttest(store, 0);

    const counts = await deleteUserData(store.withConfig(appAttestOnly), "u1");

    expect(counts.appAttestBindings).toBe(0);
    expect(commands(store.send, "BatchWriteItemCommand")).toEqual([]);
  });
});

describe("countUserData X5", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const readOnlyCommands = new Set(["GetItemCommand", "QueryCommand"]);

  it("reports the three counts with GetItem and Query only, equal to what deleteUserData then deletes", async () => {
    const reader = createStore();
    seedAll(reader);

    const counted = await countUserData(reader.context, "u1");

    expect(counted).toEqual(expect.objectContaining({ addressClaims: 1, emailClaims: 2, appAttestBindings: 2 }));
    expect(new Set(commands(reader.send).map((command) => command.constructor.name))).toEqual(readOnlyCommands);
    // Nothing changed.
    expect(hasClaim(reader, "unitA", "u1")).toBe(true);
    expect(piiRow(reader)?.verifiedAddressKey).toEqual(s("unitA"));

    const deleter = createStore();
    seedAll(deleter);
    await expect(deleteUserData(deleter.context, "u1")).resolves.toEqual(counted);
  });

  it("counts like the deletion in the edge cases: a claim row already gone, a taken-over email, a username", async () => {
    const build = () => {
      const store = createStore();
      seedAddressClaim(store);
      store.remove(CLAIMS, claimRowKey("U#unitA", "USER#u1"));
      seedEmailClaim(store, "name-1", "u3");
      seedAppAttest(store, 0);
      return store;
    };
    const reader = build();
    const counted = await countUserData(reader.context, "u1", { cognitoUserName: "name-1" });

    expect(counted).toEqual(expect.objectContaining({ addressClaims: 0, emailClaims: 1, appAttestBindings: 0 }));
    expect(new Set(commands(reader.send).map((command) => command.constructor.name))).toEqual(readOnlyCommands);

    const deleter = build();
    await expect(deleteUserData(deleter.context, "u1", { cognitoUserName: "name-1" })).resolves.toEqual(counted);
  });

  it("counts 0 for an account with none of the three, and omits each count whose table is unset", async () => {
    const empty = createStore();
    await expect(countUserData(empty.context, "u1")).resolves.toEqual(
      expect.objectContaining({ addressClaims: 0, emailClaims: 0, appAttestBindings: 0 }),
    );

    const unset = createStore();
    seedAll(unset);
    const counted = await countUserData(unset.withConfig(config), "u1");
    for (const key of ACCOUNT_LINK_COUNT_KEYS) expect(Object.keys(counted)).not.toContain(key);
    expect(x5Sequence(unset)).toEqual([]);
  });
});
