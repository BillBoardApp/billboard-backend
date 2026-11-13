import type {
  AttributeValue,
  BatchWriteItemCommandInput,
  DeleteItemCommandInput,
  GetItemCommandInput,
  PutItemCommandInput,
  QueryCommandInput,
  ScanCommandInput,
  TransactWriteItemsCommandInput,
  UpdateItemCommandInput,
  WriteRequest,
} from "@aws-sdk/client-dynamodb";
import type {
  AdminDeleteUserCommandInput,
  AdminGetUserCommandInput,
  ListUsersCommandInput,
} from "@aws-sdk/client-cognito-identity-provider";
import type { DeleteEndpointCommandInput } from "@aws-sdk/client-sns";
import type { LogLine } from "./logLines";
import {
  UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS,
  UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN,
} from "../shared/abuseLimits";

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

jest.mock("@aws-sdk/client-sns", () => {
  const actual = jest.requireActual("@aws-sdk/client-sns");
  const mockSend = jest.fn();
  return {
    ...actual,
    SNSClient: jest.fn(() => ({ send: mockSend })),
    __mockSnsSend: mockSend,
  };
});

jest.mock("@aws-sdk/client-cognito-identity-provider", () => {
  const actual = jest.requireActual("@aws-sdk/client-cognito-identity-provider");
  const mockSend = jest.fn();
  return {
    ...actual,
    CognitoIdentityProviderClient: jest.fn(() => ({ send: mockSend })),
    __mockCognitoSend: mockSend,
  };
});

process.env.USER_POOL_ID = "pool-1";
process.env.PII_TABLE_NAME = "UserPII";
process.env.PII_PARTITION_KEY = "userId";
process.env.PREFERENCES_TABLE_NAME = "UserPreferences";
process.env.PREFERENCES_PARTITION_KEY = "userId";
process.env.PREFERENCES_SORT_KEY = "preference";
process.env.DEVICES_TABLE_NAME = "UserDevices";
process.env.DEVICES_PARTITION_KEY = "userId";
process.env.DEVICES_SORT_KEY = "deviceId";
process.env.DEVICES_PUSH_TOKEN_INDEX_NAME = "GSIPushTokenIndex";
process.env.FEEDBACK_TABLE_NAME = "UserFeedback";
process.env.FEEDBACK_PARTITION_KEY = "userId";
process.env.FEEDBACK_SORT_KEY = "billId";
process.env.FEEDBACK_BILL_ID_INDEX_NAME = "GSIBillIdIndex";
process.env.WEEKLY_DIGESTS_TABLE_NAME = "UserWeeklyDigests";
process.env.WEEKLY_DIGESTS_PARTITION_KEY = "userId";
process.env.WEEKLY_DIGESTS_SORT_KEY = "publishedAt";
process.env.STATS_TABLE_NAME = "BillStats";
process.env.STATS_PARTITION_KEY = "billId";

/** The input of any command these tests read back (DynamoDB, SNS, Cognito), in the SDK's own field names. */
type FakeInput = Partial<
  ScanCommandInput &
    GetItemCommandInput &
    PutItemCommandInput &
    DeleteItemCommandInput &
    UpdateItemCommandInput &
    QueryCommandInput &
    BatchWriteItemCommandInput &
    TransactWriteItemsCommandInput &
    ListUsersCommandInput &
    AdminGetUserCommandInput &
    AdminDeleteUserCommandInput &
    DeleteEndpointCommandInput
>;

interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

const { __mockSend: mockDdbSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { __mockSnsSend: mockSnsSend } = jest.requireMock("@aws-sdk/client-sns");
const { __mockCognitoSend: mockCognitoSend } = jest.requireMock("@aws-sdk/client-cognito-identity-provider");
const { handler } = require("../handlers/cleanupOrphanedUsers");

// AccountData's claim condition (shared/accountDeletion.ts claimDeletion): the resume must use it unchanged.
const ACCOUNT_DATA_CLAIM_CONDITION =
  "attribute_not_exists(deletionStatus) OR NOT (deletionStatus IN (:status, :completed)) OR (deletionStatus = :status AND (attribute_not_exists(deletionRequestedAt) OR deletionRequestedAt < :staleBefore))";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function awsError(name: string, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** The summary the handler logs: the fields these tests read. */
interface LoggedSummary {
  resumed: unknown[];
  [key: string]: unknown;
}

const SORT_KEYS: Record<string, string> = {
  UserPreferences: "preference",
  UserDevices: "deviceId",
  UserFeedback: "billId",
  UserWeeklyDigests: "publishedAt",
};

type DeviceRow = { deviceId: string; pushToken?: string; endpointArn?: string };
type UserRows = Partial<Record<keyof typeof SORT_KEYS | "UserPII", Array<string | DeviceRow>>>;
/** A UserPII row's deletion fields. */
type PiiState = { status?: string; requestedAt?: string; error?: string };

type FakeOptions = {
  /** Push token to the user ids the GSIPushTokenIndex returns. */
  tokenOwners?: Record<string, string[]>;
  /** Answers the conditional claim (UpdateItem with a condition) for a user; default: granted. */
  claim?: (userId: string) => Promise<unknown>;
  /** Returns an error to throw for a command, or undefined to handle it normally. */
  failOn?: (name: string, input: FakeInput) => Error | undefined;
};

/**
 * Routes DynamoDB commands against an in-memory view of the user tables.
 * `rows[userId][table]` lists that user's sort-key values (PII just needs a key); a UserDevices
 * entry may be a device object with a push token and endpoint ARN.
 * `tombstones` gives users' PII deletion state: a Set means deletionStatus "completed", a Map gives
 * each user's status, or a full PiiState (status, deletionRequestedAt, deletionError).
 * `tombstonedAfterScan` are users whose PII row becomes a tombstone after the scan, so only the
 * conditional delete sees it.
 * Returns the users whose tombstone a DeleteItem actually removed (it must stay empty).
 */
function fakeDynamo(
  rows: Record<string, UserRows>,
  tombstones: Set<string> | Map<string, string | PiiState> = new Set(),
  tombstonedAfterScan: Set<string> = new Set(),
  options: FakeOptions = {},
) {
  const piiState = (userId: string): PiiState => {
    if (!(tombstones instanceof Map)) return tombstones.has(userId) ? { status: "completed" } : {};
    const value = tombstones.get(userId);
    return typeof value === "string" ? { status: value } : (value ?? {});
  };
  const statusOf = (userId: string): string | undefined => piiState(userId).status;
  const deletedTombstones: string[] = [];

  mockDdbSend.mockImplementation(async (command: FakeCommand) => {
    const name = command.constructor.name;
    const input = command.input ?? {};

    const failure = options.failOn?.(name, input);
    if (failure) throw failure;

    if (name === "ScanCommand") {
      const users = Object.entries(rows)
        .filter(([, tables]) => tables[input.TableName as keyof UserRows] !== undefined)
        .map(([userId]) => {
          const state = input.TableName === "UserPII" ? piiState(userId) : {};
          return {
            userId: { S: userId },
            ...(state.status ? { deletionStatus: { S: state.status } } : {}),
            ...(state.requestedAt ? { deletionRequestedAt: { S: state.requestedAt } } : {}),
            ...(state.error ? { deletionError: { S: state.error } } : {}),
          };
        });
      return { Items: users };
    }

    if (name === "DeleteItemCommand" && input.TableName === "UserPII") {
      // Evaluates the handler's condition against the row's current status.
      const userId = input.Key!.userId.S!;
      const status = tombstonedAfterScan.has(userId) ? "completed" : statusOf(userId);
      if (!status) return {};
      const protectedStatuses = Object.values(input.ExpressionAttributeValues ?? {}).map(
        (value: AttributeValue) => value.S,
      );
      if (input.ConditionExpression && protectedStatuses.includes(status)) {
        throw awsError("ConditionalCheckFailedException", "The conditional request failed");
      }
      deletedTombstones.push(userId);
      return {};
    }

    if (name === "UpdateItemCommand") {
      if (input.ConditionExpression && options.claim) return options.claim(input.Key!.userId.S!);
      return {};
    }

    if (name === "QueryCommand") {
      if (input.IndexName === "GSIPushTokenIndex") {
        const token = input.ExpressionAttributeValues![":pushToken"].S!;
        return { Items: (options.tokenOwners?.[token] ?? []).map((owner) => ({ userId: { S: owner } })) };
      }
      if (input.IndexName) throw new Error(`Unexpected index query ${input.IndexName}`);
      const userId = input.ExpressionAttributeValues![":pk"].S!;
      const sortKey = SORT_KEYS[input.TableName!];
      const values = rows[userId]?.[input.TableName as keyof UserRows] ?? [];
      return {
        Items: values.map((value) =>
          typeof value === "string"
            ? { userId: { S: userId }, [sortKey]: { S: value } }
            : {
                userId: { S: userId },
                deviceId: { S: value.deviceId },
                ...(value.pushToken ? { pushToken: { S: value.pushToken } } : {}),
                ...(value.endpointArn ? { endpointArn: { S: value.endpointArn } } : {}),
              },
        ),
      };
    }

    if (["BatchWriteItemCommand", "DeleteItemCommand", "PutItemCommand"].includes(name)) {
      return {};
    }

    throw new Error(`Unexpected DynamoDB command ${name}`);
  });

  return { deletedTombstones };
}

/**
 * ListUsers returns `pages` in order; AdminGetUser answers from `existing`; AdminDeleteUser succeeds
 * unless `deleteError` is given.
 */
function fakeCognito(pages: string[][], existing: Set<string> = new Set(pages.flat()), deleteError?: Error) {
  mockCognitoSend.mockImplementation(async (command: FakeCommand) => {
    const name = command.constructor.name;
    if (name === "ListUsersCommand") {
      const index = command.input.PaginationToken ? Number(command.input.PaginationToken) : 0;
      return {
        Users: (pages[index] ?? []).map((sub) => ({
          Username: sub,
          Attributes: [{ Name: "sub", Value: sub }],
        })),
        PaginationToken: index + 1 < pages.length ? String(index + 1) : undefined,
      };
    }
    if (name === "AdminGetUserCommand") {
      if (existing.has(command.input.Username!)) return { Username: command.input.Username };
      const error = new Error("User does not exist.");
      error.name = "UserNotFoundException";
      throw error;
    }
    if (name === "AdminDeleteUserCommand") {
      if (deleteError) throw deleteError;
      return {};
    }
    throw new Error(`Unexpected Cognito command ${name}`);
  });
}

function sentDynamo(name: string): FakeCommand[] {
  return mockDdbSend.mock.calls
    .map(([command]: [FakeCommand]) => command)
    .filter((command: FakeCommand) => command.constructor.name === name);
}

function sentCognito(name: string): FakeCommand[] {
  return mockCognitoSend.mock.calls
    .map(([command]: [FakeCommand]) => command)
    .filter((command: FakeCommand) => command.constructor.name === name);
}

function sentSns(name: string): FakeCommand[] {
  return mockSnsSend.mock.calls
    .map(([command]: [FakeCommand]) => command)
    .filter((command: FakeCommand) => command.constructor.name === name);
}

/** Every write the cleanup could make, across DynamoDB, SNS and Cognito. */
function writeCalls() {
  return [
    ...[
      "UpdateItemCommand",
      "DeleteItemCommand",
      "BatchWriteItemCommand",
      "PutItemCommand",
      "TransactWriteItemsCommand",
    ].flatMap(sentDynamo),
    ...sentSns("DeleteEndpointCommand"),
    ...sentCognito("AdminDeleteUserCommand"),
  ];
}

/** True when any DynamoDB call names BillStats or the feedback bill-id index (the removed inline recompute). */
function touchedBillStats() {
  return mockDdbSend.mock.calls.some(([command]: [FakeCommand]) => {
    const input = JSON.stringify(command.input ?? {});
    return input.includes("BillStats") || input.includes("GSIBillIdIndex");
  });
}

/** Users whose rows a BatchWriteItem deleted, in any table. */
function batchDeletedUsers() {
  return new Set(
    sentDynamo("BatchWriteItemCommand").flatMap((command: FakeCommand) =>
      Object.values(command.input.RequestItems!).flatMap((requests: WriteRequest[]) =>
        requests.map((request: WriteRequest) => request.DeleteRequest!.Key!.userId.S),
      ),
    ),
  );
}

function activeUsers(count: number, prefix = "active"): Record<string, UserRows> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${prefix}-${String(i).padStart(4, "0")}`, { UserPII: [] }]),
  );
}

const fullOrphan: UserRows = {
  UserPII: [],
  UserPreferences: ["Healthcare"],
  UserDevices: ["dev-1"],
  UserFeedback: ["hr-1"],
  UserWeeklyDigests: ["2026-03-01T10:00:00.000Z"],
};

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DRY_RUN;
  delete process.env.MAX_DELETIONS_PER_RUN;
  delete process.env.ORPHAN_ABORT_MIN_COUNT;
  delete process.env.ORPHAN_ABORT_FRACTION;
  delete process.env.RESUME_MIN_STALE_HOURS;
  delete process.env.MAX_RESUMES_PER_RUN;
  delete process.env.UNCONFIRMED_SIGNUP_CLEANUP_MODE;
  delete process.env.UNCONFIRMED_SIGNUP_MAX_AGE_HOURS;
  delete process.env.UNCONFIRMED_SIGNUP_MAX_DELETIONS_PER_RUN;
  mockSnsSend.mockResolvedValue({});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

/** The EMF lines the run wrote (console.log outside the Lambda JSON log format). */
function emfLines(): LogLine[] {
  return logSpy.mock.calls
    .map(([first]) => first)
    .filter((line): line is string => typeof line === "string" && line.includes('"_aws"'))
    .map((line) => JSON.parse(line) as LogLine);
}

function stuckMetricValues(): number[] {
  return emfLines()
    .filter((line) =>
      line._aws!.CloudWatchMetrics.some(
        (block) =>
          block.Namespace === "BillBoard/Accounts" &&
          block.Metrics.some((metric) => metric.Name === "AccountDeletionsStuck"),
      ),
    )
    .map((line) => line.AccountDeletionsStuck as number);
}

function loggedSummary(): LoggedSummary {
  const call = logSpy.mock.calls.find(([message]) => message === "cleanupOrphanedUsers summary");
  if (!call) throw new Error("no summary logged");
  return call[1];
}

describe("cleanupOrphanedUsers handler", () => {
  it("removes rows for users missing from Cognito across all user tables", async () => {
    fakeDynamo({ "gone-user": fullOrphan, "active-user": { UserPII: [] } });
    fakeCognito([["active-user"]]);

    const response = await handler();

    expect(response.removedUsers).toBe(1);
    expect(response.removedItems).toEqual({
      pii: 1,
      preferences: 1,
      devices: 1,
      snsEndpoints: 0,
      feedback: 1,
      weeklyDigests: 1,
    });
    // C1.6: no inline stats recompute; the UserFeedback stream updates the stats.
    expect(response).not.toHaveProperty("recomputedBillStatsFor");
    expect(touchedBillStats()).toBe(false);
    expect(sentDynamo("DeleteItemCommand").map((command: FakeCommand) => command.input.Key!.userId.S)).toEqual([
      "gone-user",
    ]);
    // Only the orphan candidate is checked individually.
    expect(sentCognito("AdminGetUserCommand").map((command: FakeCommand) => command.input.Username)).toEqual([
      "gone-user",
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      "cleanupOrphanedUsers summary",
      expect.objectContaining({
        scannedUsers: 2,
        cognitoUsers: 1,
        orphanCandidates: 1,
        removedUsers: 1,
        dryRun: false,
      }),
    );
  });

  it("keeps data when user still exists in Cognito", async () => {
    fakeDynamo({ "active-user": { UserPII: [], UserFeedback: ["hr-1"] } });
    fakeCognito([["active-user"]]);

    const response = await handler();

    expect(response.removedUsers).toBe(0);
    expect(response.removedItems).toEqual({
      pii: 0,
      preferences: 0,
      devices: 0,
      snsEndpoints: 0,
      feedback: 0,
      weeklyDigests: 0,
    });
    expect(sentCognito("AdminGetUserCommand")).toHaveLength(0);
    expect(sentDynamo("BatchWriteItemCommand")).toHaveLength(0);
  });

  it("builds the Cognito set from every ListUsers page", async () => {
    fakeDynamo({ ...activeUsers(3), "gone-user": { UserPII: [] } });
    fakeCognito([["active-0000"], ["active-0001"], ["active-0002"]]);

    const response = await handler();

    const listCalls = sentCognito("ListUsersCommand");
    expect(listCalls).toHaveLength(3);
    expect(listCalls[0].input).toEqual(expect.objectContaining({ UserPoolId: "pool-1", AttributesToGet: ["sub"] }));
    expect(listCalls[1].input.PaginationToken).toBe("1");
    expect(response.cognitoUsers).toBe(3);
    expect(response.removedUsers).toBe(1);
  });

  it("matches users by the sub attribute when the username differs", async () => {
    fakeDynamo({ "sub-1": { UserPII: [] } });
    mockCognitoSend.mockImplementation(async (command: FakeCommand) => {
      if (command.constructor.name === "ListUsersCommand") {
        return { Users: [{ Username: "someone@example.com", Attributes: [{ Name: "sub", Value: "sub-1" }] }] };
      }
      throw new Error("unexpected");
    });

    const response = await handler();

    expect(response.orphanCandidates).toBe(0);
    expect(response.removedUsers).toBe(0);
  });

  it("does not delete a candidate that AdminGetUser still finds", async () => {
    fakeDynamo({ "late-user": fullOrphan, "active-user": { UserPII: [] } });
    // Missing from the listing (e.g. created mid-pagination) but present on a direct read.
    fakeCognito([["active-user"]], new Set(["active-user", "late-user"]));

    const response = await handler();

    expect(response.skippedStillInCognito).toBe(1);
    expect(response.removedUsers).toBe(0);
    expect(sentDynamo("BatchWriteItemCommand")).toHaveLength(0);
    expect(sentDynamo("DeleteItemCommand")).toHaveLength(0);
  });

  it("aborts without deleting anything when the pool lists zero users", async () => {
    fakeDynamo({ "user-a": fullOrphan, "user-b": { UserPII: [] } });
    fakeCognito([[]]);

    await expect(handler()).rejects.toThrow("Cognito pool listed zero users");

    expect(sentCognito("AdminGetUserCommand")).toHaveLength(0);
    expect(sentDynamo("BatchWriteItemCommand")).toHaveLength(0);
    expect(sentDynamo("DeleteItemCommand")).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "cleanupOrphanedUsers aborted without deleting anything",
      expect.objectContaining({ scannedUsers: 2, cognitoUsers: 0, orphanCandidates: 2 }),
    );
  });

  it("aborts at the default minimum of 2: three unexpected orphans among six users (a replaced pool)", async () => {
    const orphans = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`gone-${i}`, fullOrphan]));
    fakeDynamo({ ...activeUsers(3), ...orphans });
    fakeCognito([Object.keys(activeUsers(3))]);

    await expect(handler()).rejects.toThrow(
      "Orphan candidates without a deletion tombstone (3) exceed the safety threshold (2)",
    );

    expect(sentCognito("AdminGetUserCommand")).toHaveLength(0);
    expect(writeCalls()).toHaveLength(0);
  });

  it("aborts when every one of six users is an orphan, even in dry run", async () => {
    process.env.DRY_RUN = "true";
    fakeDynamo(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`old-pool-${i}`, fullOrphan])));
    // A replaced pool that already has one new user, so the zero-users guard does not apply.
    fakeCognito([["new-pool-user"]]);

    await expect(handler()).rejects.toThrow("(6) exceed the safety threshold (2)");
    expect(writeCalls()).toHaveLength(0);
  });

  it("allows up to 2 orphans in a small table", async () => {
    const orphans = Object.fromEntries(Array.from({ length: 2 }, (_, i) => [`gone-${i}`, { UserPII: [] }]));
    fakeDynamo({ ...activeUsers(4), ...orphans });
    fakeCognito([Object.keys(activeUsers(4))]);

    const response = await handler();

    expect(response.abortThreshold).toBe(2);
    expect(response.removedUsers).toBe(2);
  });

  it("uses 2% of scanned users as the threshold for large tables", async () => {
    const active = activeUsers(1000);
    const orphans = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`gone-${String(i).padStart(3, "0")}`, { UserPII: [] }]),
      );

    // 21 of 1021 is about 2.06%, which is over the 20.42 threshold.
    fakeDynamo({ ...active, ...orphans(21) });
    fakeCognito([Object.keys(active)]);
    await expect(handler()).rejects.toThrow("exceed the safety threshold");
    expect(sentDynamo("DeleteItemCommand")).toHaveLength(0);

    jest.clearAllMocks();
    process.env.MAX_DELETIONS_PER_RUN = "100";
    // 20 of 1020 is under the 20.4 threshold.
    fakeDynamo({ ...active, ...orphans(20) });
    fakeCognito([Object.keys(active)]);
    const response = await handler();
    expect(response.removedUsers).toBe(20);
  });

  it("does not count accountData deletion tombstones toward the abort threshold", async () => {
    process.env.DRY_RUN = "true";
    const tombstoned = Array.from({ length: 30 }, (_, i) => `deleted-${String(i).padStart(2, "0")}`);
    const rows = {
      ...activeUsers(20),
      ...Object.fromEntries(tombstoned.map((userId) => [userId, { UserPII: [] }])),
      "gone-user": { UserPII: [] },
    };
    fakeDynamo(rows, new Set(tombstoned));
    fakeCognito([Object.keys(activeUsers(20))]);

    const response = await handler();

    expect(response.orphanCandidates).toBe(31);
    expect(response.deletedAccountOrphans).toBe(30);
    // REC-10: tombstone-only users have nothing to clean up, so only the real orphan is listed.
    expect(response.wouldDelete).toEqual(["gone-user"]);
    expect(response.keptTombstones).toBe(30);
    const piiScan = sentDynamo("ScanCommand").find((command: FakeCommand) => command.input.TableName === "UserPII");
    // C1.10: the PII scan also reads the claim's request time and error, nothing else.
    expect(piiScan!.input.ProjectionExpression).toBe("#pk, #deletionStatus, #deletionRequestedAt, #deletionError");
    expect(piiScan!.input.ExpressionAttributeNames).toEqual({
      "#pk": "userId",
      "#deletionStatus": "deletionStatus",
      "#deletionRequestedAt": "deletionRequestedAt",
      "#deletionError": "deletionError",
    });
    // Other tables still project the key only.
    for (const scan of sentDynamo("ScanCommand").filter(
      (command: FakeCommand) => command.input.TableName !== "UserPII",
    )) {
      expect(scan.input.ProjectionExpression).toBe("#pk");
    }
  });

  it("still aborts on too many orphans without a tombstone when tombstones are present", async () => {
    const tombstoned = ["deleted-a", "deleted-b"];
    const unexpected = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`gone-${i}`, { UserPII: [] }]));
    fakeDynamo(
      {
        ...activeUsers(20),
        ...unexpected,
        ...Object.fromEntries(tombstoned.map((userId) => [userId, { UserPII: [] }])),
      },
      new Set(tombstoned),
    );
    fakeCognito([Object.keys(activeUsers(20))]);

    await expect(handler()).rejects.toThrow("without a deletion tombstone (3) exceed the safety threshold (2)");
    expect(sentDynamo("DeleteItemCommand")).toHaveLength(0);
  });

  it("lets ORPHAN_ABORT_MIN_COUNT and ORPHAN_ABORT_FRACTION raise the threshold", async () => {
    const orphans = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`gone-${String(i).padStart(3, "0")}`, { UserPII: [] }]),
      );

    process.env.ORPHAN_ABORT_MIN_COUNT = "20";
    fakeDynamo({ ...activeUsers(20), ...orphans(15) });
    fakeCognito([Object.keys(activeUsers(20))]);
    expect((await handler()).removedUsers).toBe(15);

    jest.clearAllMocks();
    delete process.env.ORPHAN_ABORT_MIN_COUNT;
    process.env.ORPHAN_ABORT_FRACTION = "0.5";
    fakeDynamo({ ...activeUsers(100), ...orphans(60) });
    fakeCognito([Object.keys(activeUsers(100))]);
    const response = await handler();
    expect(response.abortThreshold).toBe(80);
    expect(response.removedUsers).toBe(50);
    expect(response.deferredUsers).toBe(10);
  });

  it("ignores an invalid ORPHAN_ABORT_FRACTION", async () => {
    process.env.ORPHAN_ABORT_FRACTION = "2";
    const orphans = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`gone-${i}`, { UserPII: [] }]));
    fakeDynamo({ ...activeUsers(20), ...orphans });
    fakeCognito([Object.keys(activeUsers(20))]);

    await expect(handler()).rejects.toThrow("exceed the safety threshold (2)");
    expect(warnSpy).toHaveBeenCalledWith("Ignoring invalid ORPHAN_ABORT_FRACTION", { value: "2", fallback: 0.02 });
  });

  it("DRY_RUN=true reports what would be deleted and deletes nothing", async () => {
    process.env.DRY_RUN = "true";
    fakeDynamo({ "gone-user": fullOrphan, "active-user": { UserPII: [] } });
    fakeCognito([["active-user"]]);

    const response = await handler();

    expect(response.dryRun).toBe(true);
    expect(response.wouldDelete).toEqual(["gone-user"]);
    expect(response.wouldResume).toEqual([]);
    expect(response).not.toHaveProperty("resumed");
    expect(response.removedUsers).toBe(0);
    expect(sentDynamo("QueryCommand")).toHaveLength(0);
    expect(writeCalls()).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(
      "cleanupOrphanedUsers summary",
      expect.objectContaining({ dryRun: true, wouldDelete: ["gone-user"], wouldResume: [] }),
    );
  });

  it("caps deletions at MAX_DELETIONS_PER_RUN and defers the rest", async () => {
    process.env.MAX_DELETIONS_PER_RUN = "2";
    process.env.ORPHAN_ABORT_MIN_COUNT = "3";
    fakeDynamo({
      "gone-a": { UserPII: [] },
      "gone-b": { UserPII: [] },
      "gone-c": { UserPII: [] },
      "active-user": { UserPII: [] },
    });
    fakeCognito([["active-user"]]);

    const response = await handler();

    expect(response.maxDeletionsPerRun).toBe(2);
    expect(response.removedUsers).toBe(2);
    expect(response.deferredUsers).toBe(1);
    expect(sentDynamo("DeleteItemCommand").map((command: FakeCommand) => command.input.Key!.userId.S)).toEqual([
      "gone-a",
      "gone-b",
    ]);
  });

  it("defaults MAX_DELETIONS_PER_RUN to 50", async () => {
    const active = activeUsers(3000);
    const orphans = Object.fromEntries(
      Array.from({ length: 55 }, (_, i) => [`gone-${String(i).padStart(2, "0")}`, { UserPII: [] }]),
    );
    fakeDynamo({ ...active, ...orphans });
    fakeCognito([Object.keys(active)]);

    const response = await handler();

    expect(response.maxDeletionsPerRun).toBe(50);
    expect(response.removedUsers).toBe(50);
    expect(response.deferredUsers).toBe(5);
  });

  describe("deletion tombstones (REC-10)", () => {
    it("never deletes a tombstone on a non-dry run, while real orphans are still cleaned", async () => {
      const { deletedTombstones } = fakeDynamo(
        {
          ...activeUsers(20),
          "gone-user": fullOrphan,
          "deleted-done": { UserPII: [] },
          // Deletion cut off an hour ago: leftover rows, status still in_progress. Younger than
          // RESUME_MIN_STALE_HOURS, so not a resume candidate: the orphan path removes its rows.
          "deleted-cut-off": { UserPII: [], UserPreferences: ["Taxes"], UserFeedback: ["hr-9"] },
        },
        new Map<string, string | PiiState>([
          ["deleted-done", "completed"],
          ["deleted-cut-off", { status: "in_progress", requestedAt: hoursAgo(1) }],
        ]),
      );
      fakeCognito([Object.keys(activeUsers(20))]);

      const response = await handler();

      expect(response.dryRun).toBe(false);
      expect(deletedTombstones).toEqual([]);
      expect(response.orphanCandidates).toBe(3);
      expect(response.deletedAccountOrphans).toBe(2);
      expect(response.keptTombstones).toBe(2);
      // The real orphan loses everything; the cut-off deletion loses its leftover rows only.
      expect(response.removedUsers).toBe(2);
      expect(response.removedItems).toEqual({
        pii: 1,
        preferences: 2,
        devices: 1,
        snsEndpoints: 0,
        feedback: 2,
        weeklyDigests: 1,
      });
      expect(response.resumed).toEqual([]);

      const piiDeletes = sentDynamo("DeleteItemCommand");
      expect(piiDeletes.map((command: FakeCommand) => command.input.Key!.userId.S)).toEqual(["gone-user"]);
      expect(piiDeletes[0].input.ConditionExpression).toBe(
        "attribute_not_exists(#deletionStatus) OR NOT (#deletionStatus IN (:completed, :inProgress))",
      );
      expect(piiDeletes[0].input.ExpressionAttributeValues).toEqual({
        ":completed": { S: "completed" },
        ":inProgress": { S: "in_progress" },
      });

      expect(batchDeletedUsers()).toEqual(new Set(["gone-user", "deleted-cut-off"]));
      // A tombstone-only user is not even looked up.
      expect(sentCognito("AdminGetUserCommand").map((command: FakeCommand) => command.input.Username)).toEqual([
        "deleted-cut-off",
        "gone-user",
      ]);
    });

    it("keeps a tombstone written after the scan: the PII delete is conditional", async () => {
      const { deletedTombstones } = fakeDynamo(
        { ...activeUsers(5), "racing-user": fullOrphan },
        new Set(),
        new Set(["racing-user"]),
      );
      fakeCognito([Object.keys(activeUsers(5))]);

      const response = await handler();

      expect(response.removedUsers).toBe(1);
      expect(response.removedItems.pii).toBe(0);
      expect(response.keptTombstones).toBe(1);
      expect(deletedTombstones).toEqual([]);
      expect(sentDynamo("DeleteItemCommand")).toHaveLength(1);
    });

    it("tombstone-only users do not take slots in MAX_DELETIONS_PER_RUN", async () => {
      process.env.MAX_DELETIONS_PER_RUN = "2";
      const tombstoned = ["a-deleted-1", "a-deleted-2", "a-deleted-3"];
      fakeDynamo(
        {
          ...activeUsers(20),
          ...Object.fromEntries(tombstoned.map((userId) => [userId, { UserPII: [] }])),
          "gone-a": { UserPII: [] },
          "gone-b": { UserPII: [] },
        },
        new Set(tombstoned),
      );
      fakeCognito([Object.keys(activeUsers(20))]);

      const response = await handler();

      expect(response.removedUsers).toBe(2);
      expect(response.deferredUsers).toBe(0);
      expect(response.keptTombstones).toBe(3);
      expect(sentDynamo("DeleteItemCommand").map((command: FakeCommand) => command.input.Key!.userId.S)).toEqual([
        "gone-a",
        "gone-b",
      ]);
    });

    it("DRY_RUN=true reports a tombstoned user with leftover rows and keeps its tombstone", async () => {
      process.env.DRY_RUN = "true";
      fakeDynamo(
        { "active-user": { UserPII: [] }, "deleted-cut-off": { UserPII: [], UserDevices: ["dev-9"] } },
        new Map<string, string | PiiState>([["deleted-cut-off", { status: "in_progress", requestedAt: hoursAgo(2) }]]),
      );
      fakeCognito([["active-user"]]);

      const response = await handler();

      expect(response.wouldDelete).toEqual(["deleted-cut-off"]);
      expect(response.wouldResume).toEqual([]);
      expect(response.keptTombstones).toBe(1);
      expect(writeCalls()).toHaveLength(0);
    });
  });

  it("removes an orphan's SNS endpoints with its device rows, keeping one another user still uses (live)", async () => {
    fakeDynamo(
      {
        ...activeUsers(4),
        "gone-user": {
          UserPII: [],
          UserDevices: [
            { deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/own" },
            { deviceId: "dev-2", pushToken: "bb22", endpointArn: "arn:endpoint/shared" },
          ],
        },
      },
      new Set(),
      new Set(),
      { tokenOwners: { aa11: ["gone-user"], bb22: ["gone-user", "active-0000"] } },
    );
    fakeCognito([Object.keys(activeUsers(4))]);

    const response = await handler();

    expect(sentSns("DeleteEndpointCommand").map((command: FakeCommand) => command.input.EndpointArn)).toEqual([
      "arn:endpoint/own",
    ]);
    expect(response.removedItems).toEqual(expect.objectContaining({ devices: 2, snsEndpoints: 1 }));
    expect(batchDeletedUsers()).toEqual(new Set(["gone-user"]));
  });

  describe("stalled deletions (D3 step 1)", () => {
    const sharedDevices: DeviceRow[] = [
      { deviceId: "dev-1", pushToken: "aa11", endpointArn: "arn:endpoint/own" },
      { deviceId: "dev-2", pushToken: "bb22", endpointArn: "arn:endpoint/shared" },
      { deviceId: "dev-3" },
    ];

    /**
     * stale-user: in_progress 30 h ago, still in Cognito, data everywhere, one shared endpoint.
     * no-time-user: in_progress with no request time, gone from Cognito, one leftover vote.
     * young-user: in_progress 2 h ago. failed-user: failed. done-user: completed.
     */
    function stalledFixture(options: FakeOptions = {}) {
      const claims = new Map<string, string | PiiState>([
        ["stale-user", { status: "in_progress", requestedAt: hoursAgo(30) }],
        ["no-time-user", { status: "in_progress" }],
        ["young-user", { status: "in_progress", requestedAt: hoursAgo(2) }],
        ["failed-user", { status: "failed", requestedAt: "2026-10-01T12:00:00.000Z", error: "Rate exceeded" }],
        ["done-user", "completed"],
      ]);
      fakeDynamo(
        {
          "active-user": { UserPII: [] },
          "stale-user": {
            UserPII: [],
            UserPreferences: ["Taxes"],
            UserFeedback: ["hr-1", "hr-2"],
            UserDevices: sharedDevices,
            UserWeeklyDigests: ["2026-10-04T14:00:00.000Z"],
          },
          "no-time-user": { UserPII: [], UserFeedback: ["hr-9"] },
          "young-user": { UserPII: [], UserFeedback: ["hr-3"] },
          "failed-user": { UserPII: [], UserFeedback: ["hr-4"] },
          "done-user": { UserPII: [] },
        },
        claims,
        new Set(),
        { tokenOwners: { aa11: ["stale-user"], bb22: ["stale-user", "active-user"] }, ...options },
      );
    }
    const inCognito = ["active-user", "stale-user", "young-user", "failed-user"];

    it("dry run: reports stale claims in wouldResume with read-only counts and writes nothing", async () => {
      process.env.DRY_RUN = "true";
      stalledFixture();
      fakeCognito([inCognito]);

      const response = await handler();

      expect(response.dryRun).toBe(true);
      // Missing request time counts as stale and as oldest; the 2-hour claim is not stale.
      expect(response.wouldResume).toEqual([
        {
          userId: "no-time-user",
          deletionRequestedAt: null,
          staleHours: null,
          cognitoUserExists: false,
          items: {
            feedback: 1,
            preferences: 0,
            devices: 0,
            snsEndpoints: 0,
            sharedSnsEndpointsKept: 0,
            weeklyDigests: 0,
          },
        },
        {
          userId: "stale-user",
          deletionRequestedAt: expect.any(String),
          staleHours: 30,
          cognitoUserExists: true,
          items: {
            feedback: 2,
            preferences: 1,
            devices: 3,
            snsEndpoints: 1,
            sharedSnsEndpointsKept: 1,
            weeklyDigests: 1,
          },
        },
      ]);
      expect(response.deletionClaims).toEqual({ inProgress: 3, staleInProgress: 2, failed: 1 });
      expect(response.failedDeletions).toEqual([
        { userId: "failed-user", deletionRequestedAt: "2026-10-01T12:00:00.000Z", deletionError: "Rate exceeded" },
      ]);
      expect(response.deferredResumes).toBe(0);
      expect(response.resumeMinStaleHours).toBe(24);
      expect(response.maxResumesPerRun).toBe(10);
      // The stale orphan is left to the resume path, not the orphan path; done-user is a kept tombstone.
      expect(response.orphanCandidates).toBe(2);
      expect(response.deletedAccountOrphans).toBe(2);
      expect(response.wouldDelete).toEqual([]);
      expect(response.keptTombstones).toBe(1);
      expect(loggedSummary()).toEqual(response);
      // Stale in_progress (2) plus failed (1).
      expect(stuckMetricValues()).toEqual([3]);

      expect(writeCalls()).toHaveLength(0);
      expect(sentDynamo("UpdateItemCommand")).toHaveLength(0);
      expect(sentDynamo("DeleteItemCommand")).toHaveLength(0);
      expect(sentDynamo("BatchWriteItemCommand")).toHaveLength(0);
      expect(sentSns("DeleteEndpointCommand")).toHaveLength(0);
      expect(sentCognito("AdminDeleteUserCommand")).toHaveLength(0);
      // Reads only for the two candidates: nothing for the young, failed or completed users.
      const queriedUsers = new Set(
        sentDynamo("QueryCommand")
          .filter((command: FakeCommand) => !command.input.IndexName)
          .map((command: FakeCommand) => command.input.ExpressionAttributeValues![":pk"].S),
      );
      expect(queriedUsers).toEqual(new Set(["no-time-user", "stale-user"]));
      expect(touchedBillStats()).toBe(false);
    });

    it("live: resumes each stale claim with AccountData's claim, data steps, tombstone and Cognito deletion", async () => {
      stalledFixture();
      fakeCognito([inCognito]);

      const response = await handler();

      expect(response.dryRun).toBe(false);
      expect(response).not.toHaveProperty("wouldResume");
      expect(response.resumed).toEqual([
        {
          userId: "no-time-user",
          outcome: "completed",
          cognitoUserDeleted: false,
          items: {
            feedback: 1,
            preferences: 0,
            devices: 0,
            snsEndpoints: 0,
            sharedSnsEndpointsKept: 0,
            weeklyDigests: 0,
          },
        },
        {
          userId: "stale-user",
          outcome: "completed",
          cognitoUserDeleted: true,
          items: {
            feedback: 2,
            preferences: 1,
            devices: 3,
            snsEndpoints: 1,
            sharedSnsEndpointsKept: 1,
            weeklyDigests: 1,
          },
        },
      ]);

      // Claimed with AccountData's own condition and lease.
      const claims = sentDynamo("UpdateItemCommand").filter(
        (command: FakeCommand) => command.input.ConditionExpression,
      );
      expect(claims.map((command: FakeCommand) => command.input.Key!.userId.S)).toEqual(["no-time-user", "stale-user"]);
      for (const claim of claims) {
        expect(claim.input.ConditionExpression).toBe(ACCOUNT_DATA_CLAIM_CONDITION);
        const values = claim.input.ExpressionAttributeValues!;
        expect(values[":status"]).toEqual({ S: "in_progress" });
        expect(Date.parse(values[":requestedAt"].S!) - Date.parse(values[":staleBefore"].S!)).toBe(15 * 60 * 1000);
      }

      // Only the own endpoint is deleted, before the device rows; all three device rows go.
      expect(sentSns("DeleteEndpointCommand").map((command: FakeCommand) => command.input.EndpointArn)).toEqual([
        "arn:endpoint/own",
      ]);
      const deviceDelete = sentDynamo("BatchWriteItemCommand").find(
        (command: FakeCommand) => command.input.RequestItems!.UserDevices,
      );
      expect(
        deviceDelete!.input.RequestItems!.UserDevices.map(
          (request: WriteRequest) => request.DeleteRequest!.Key!.deviceId.S,
        ),
      ).toEqual(["dev-1", "dev-2", "dev-3"]);
      const order = (mock: jest.Mock, command: unknown) =>
        mock.mock.invocationCallOrder[mock.mock.calls.findIndex(([c]) => c === command)];
      expect(order(mockSnsSend, sentSns("DeleteEndpointCommand")[0])).toBeLessThan(order(mockDdbSend, deviceDelete));

      // Tombstones written; the PII rows are never deleted; Cognito only for the user still in the pool, after
      // the tombstone.
      const tombstones = sentDynamo("PutItemCommand");
      expect(tombstones.map((command: FakeCommand) => [command.input.TableName, command.input.Item!.userId.S])).toEqual(
        [
          ["UserPII", "no-time-user"],
          ["UserPII", "stale-user"],
        ],
      );
      expect(tombstones.every((command: FakeCommand) => command.input.Item!.deletionStatus.S === "completed")).toBe(
        true,
      );
      expect(sentDynamo("DeleteItemCommand")).toHaveLength(0);
      const cognitoDeletes = sentCognito("AdminDeleteUserCommand");
      expect(cognitoDeletes.map((command: FakeCommand) => command.input)).toEqual([
        { UserPoolId: "pool-1", Username: "stale-user" },
      ]);
      expect(order(mockDdbSend, tombstones[1])).toBeLessThan(order(mockCognitoSend, cognitoDeletes[0]));

      // The young, failed and completed users are untouched.
      expect(batchDeletedUsers()).toEqual(new Set(["no-time-user", "stale-user"]));
      expect(sentDynamo("UpdateItemCommand").every((command: FakeCommand) => command.input.ConditionExpression)).toBe(
        true,
      );
      expect(touchedBillStats()).toBe(false);
    });

    it("live: skips a claim another request holds (claimed_elsewhere) and deletes nothing for it", async () => {
      stalledFixture({
        claim: async (userId) => {
          if (userId === "stale-user") throw awsError("ConditionalCheckFailedException");
          return {};
        },
      });
      fakeCognito([inCognito]);

      const response = await handler();

      expect(response.resumed).toEqual([
        expect.objectContaining({ userId: "no-time-user", outcome: "completed" }),
        { userId: "stale-user", outcome: "claimed_elsewhere", cognitoUserDeleted: false },
      ]);
      expect(batchDeletedUsers()).toEqual(new Set(["no-time-user"]));
      expect(sentSns("DeleteEndpointCommand")).toHaveLength(0);
      expect(sentCognito("AdminDeleteUserCommand")).toHaveLength(0);
      expect(sentDynamo("PutItemCommand").map((command: FakeCommand) => command.input.Item!.userId.S)).toEqual([
        "no-time-user",
      ]);
    });

    it("live: a failed data step writes failed, moves on to the next user and fails the run after the summary", async () => {
      stalledFixture();
      fakeCognito([inCognito]);
      mockSnsSend.mockRejectedValueOnce(awsError("AuthorizationErrorException", "not authorized to DeleteEndpoint"));

      await expect(handler()).rejects.toThrow("cleanupOrphanedUsers: 1 resumed deletion(s) failed: stale-user");

      const summary = loggedSummary();
      expect(summary.resumed).toEqual([
        expect.objectContaining({ userId: "no-time-user", outcome: "completed" }),
        {
          userId: "stale-user",
          outcome: "failed",
          cognitoUserDeleted: false,
          error: "not authorized to DeleteEndpoint",
        },
      ]);
      const failedWrite = sentDynamo("UpdateItemCommand").find(
        (command: FakeCommand) => command.input.ExpressionAttributeValues![":status"].S === "failed",
      );
      expect(failedWrite!.input.Key!.userId.S).toBe("stale-user");
      expect(failedWrite!.input.ExpressionAttributeValues![":deletionError"]).toEqual({
        S: "not authorized to DeleteEndpoint",
      });
      // The failed user keeps its device rows (endpoints go first) and its Cognito user.
      expect(
        sentDynamo("BatchWriteItemCommand").some((command: FakeCommand) => command.input.RequestItems!.UserDevices),
      ).toBe(false);
      expect(sentCognito("AdminDeleteUserCommand")).toHaveLength(0);
      expect(sentDynamo("PutItemCommand").map((command: FakeCommand) => command.input.Item!.userId.S)).toEqual([
        "no-time-user",
      ]);
    });

    it("live: a claim that cannot be written is a failure without a failed mark (it may be a live request's row)", async () => {
      stalledFixture({
        claim: async (userId) => {
          if (userId === "no-time-user") throw awsError("ProvisionedThroughputExceededException", "slow down");
          return {};
        },
      });
      fakeCognito([inCognito]);

      await expect(handler()).rejects.toThrow("1 resumed deletion(s) failed: no-time-user");

      expect(loggedSummary().resumed[0]).toEqual({
        userId: "no-time-user",
        outcome: "failed",
        cognitoUserDeleted: false,
        error: "slow down",
      });
      expect(
        sentDynamo("UpdateItemCommand").filter((command: FakeCommand) => !command.input.ConditionExpression),
      ).toHaveLength(0);
      expect(batchDeletedUsers()).toEqual(new Set(["stale-user"]));
    });

    it("live: a Cognito failure after the data is gone keeps the deletion completed and does not fail the run", async () => {
      stalledFixture();
      fakeCognito([inCognito], new Set(inCognito), awsError("TooManyRequestsException", "Rate exceeded"));

      const response = await handler();

      expect(response.resumed).toEqual([
        expect.objectContaining({ userId: "no-time-user", outcome: "completed", cognitoUserDeleted: false }),
        expect.objectContaining({ userId: "stale-user", outcome: "completed", cognitoUserDeleted: false }),
      ]);
      const statuses = sentDynamo("UpdateItemCommand").map(
        (command: FakeCommand) => command.input.ExpressionAttributeValues![":status"].S,
      );
      expect(statuses).not.toContain("failed");
    });

    it("never resumes a failed deletion, in dry run or live", async () => {
      for (const dryRun of ["true", "false"]) {
        jest.clearAllMocks();
        process.env.DRY_RUN = dryRun;
        fakeDynamo(
          { "active-user": { UserPII: [] }, "failed-user": { UserPII: [], UserFeedback: ["hr-4"] } },
          new Map<string, string | PiiState>([["failed-user", { status: "failed", requestedAt: hoursAgo(72) }]]),
        );
        fakeCognito([["active-user", "failed-user"]]);

        const response = await handler();

        expect(response.deletionClaims).toEqual({ inProgress: 0, staleInProgress: 0, failed: 1 });
        expect(response.failedDeletions).toEqual([
          { userId: "failed-user", deletionRequestedAt: expect.any(String), deletionError: null },
        ]);
        expect(response[dryRun === "true" ? "wouldResume" : "resumed"]).toEqual([]);
        expect(writeCalls()).toHaveLength(0);
        expect(stuckMetricValues()).toEqual([1]);
      }
    });

    it("ignores completed deletions: no claim counted, nothing resumed", async () => {
      process.env.DRY_RUN = "true";
      fakeDynamo({ "active-user": { UserPII: [] }, "done-user": { UserPII: [] } }, new Set(["done-user"]));
      fakeCognito([["active-user"]]);

      const response = await handler();

      expect(response.deletionClaims).toEqual({ inProgress: 0, staleInProgress: 0, failed: 0 });
      expect(response.wouldResume).toEqual([]);
      expect(response.failedDeletions).toEqual([]);
      expect(stuckMetricValues()).toEqual([0]);
    });

    it("honours MAX_RESUMES_PER_RUN, oldest first, and keeps the deferred ones out of the orphan path", async () => {
      process.env.MAX_RESUMES_PER_RUN = "2";
      const claims = new Map<string, string | PiiState>([
        ["claim-a", { status: "in_progress", requestedAt: hoursAgo(26) }],
        ["claim-b", { status: "in_progress", requestedAt: hoursAgo(100) }],
        ["claim-c", { status: "in_progress", requestedAt: hoursAgo(50) }],
      ]);
      fakeDynamo(
        {
          "active-user": { UserPII: [] },
          "claim-a": { UserPII: [], UserFeedback: ["hr-1"] },
          "claim-b": { UserPII: [], UserFeedback: ["hr-2"] },
          "claim-c": { UserPII: [], UserFeedback: ["hr-3"] },
        },
        claims,
      );
      fakeCognito([["active-user"]]);

      const response = await handler();

      expect(response.resumed.map((entry: { userId: string }) => entry.userId)).toEqual(["claim-b", "claim-c"]);
      expect(response.deferredResumes).toBe(1);
      expect(response.removedUsers).toBe(0);
      // claim-a (deferred) is neither resumed nor cleaned by the orphan path.
      expect(batchDeletedUsers()).toEqual(new Set(["claim-b", "claim-c"]));
      expect(stuckMetricValues()).toEqual([3]);
    });

    it("lets RESUME_MIN_STALE_HOURS change the staleness and ignores an invalid value", async () => {
      process.env.DRY_RUN = "true";
      const rows = { "active-user": { UserPII: [] }, "recent-user": { UserPII: [] } };
      const claims = () =>
        new Map<string, string | PiiState>([["recent-user", { status: "in_progress", requestedAt: hoursAgo(2) }]]);

      process.env.RESUME_MIN_STALE_HOURS = "1";
      fakeDynamo(rows, claims());
      fakeCognito([["active-user"]]);
      let response = await handler();
      expect(response.resumeMinStaleHours).toBe(1);
      expect(response.wouldResume.map((entry: { userId: string }) => entry.userId)).toEqual(["recent-user"]);

      jest.clearAllMocks();
      process.env.RESUME_MIN_STALE_HOURS = "-3";
      process.env.MAX_RESUMES_PER_RUN = "1.5";
      fakeDynamo(rows, claims());
      fakeCognito([["active-user"]]);
      response = await handler();
      expect(response.resumeMinStaleHours).toBe(24);
      expect(response.maxResumesPerRun).toBe(10);
      expect(response.wouldResume).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith("Ignoring invalid RESUME_MIN_STALE_HOURS", { value: "-3", fallback: 24 });
      expect(warnSpy).toHaveBeenCalledWith("Ignoring invalid MAX_RESUMES_PER_RUN", { value: "1.5", fallback: 10 });
    });

    it("emits AccountDeletionsStuck even when the run aborts, and resumes nothing", async () => {
      fakeDynamo(
        {
          ...Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`gone-${i}`, { UserPII: [] }])),
          "active-user": { UserPII: [] },
          "stale-user": { UserPII: [], UserFeedback: ["hr-1"] },
        },
        new Map<string, string | PiiState>([["stale-user", { status: "in_progress", requestedAt: hoursAgo(48) }]]),
      );
      fakeCognito([["active-user", "stale-user"]]);

      await expect(handler()).rejects.toThrow("exceed the safety threshold (2)");

      expect(stuckMetricValues()).toEqual([1]);
      expect(writeCalls()).toHaveLength(0);
    });
  });

  it("does nothing and skips Cognito when no user rows exist", async () => {
    fakeDynamo({});
    fakeCognito([[]]);

    const response = await handler();

    expect(response.scannedUsers).toBe(0);
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(response.deletionClaims).toEqual({ inProgress: 0, staleInProgress: 0, failed: 0 });
    expect(stuckMetricValues()).toEqual([0]);
  });
});

// REL-53: the unconfirmed sign-up step (unconfirmedSignUps.ts, tested on its own in
// cleanupUnconfirmedSignUps.test.ts), as the handler runs it.
describe("cleanupOrphanedUsers: sign-ups left unconfirmed (REL-53)", () => {
  const STRANDED = "stranded-sub";
  const unconfirmedListing = () =>
    sentCognito("ListUsersCommand").filter((command: FakeCommand) => command.input.Filter !== undefined);

  /** fakeCognito's pool, plus one sign-up UNCONFIRMED for 72 hours behind ListUsers' status filter. */
  function withStrandedSignUp(activeSubs: string[]) {
    const deleted: string[] = [];
    mockCognitoSend.mockImplementation(async (command: FakeCommand) => {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "ListUsersCommand" && input.Filter) {
        expect(input.Filter).toBe('cognito:user_status = "UNCONFIRMED"');
        return { Users: deleted.includes(STRANDED) ? [] : [strandedUser()] };
      }
      if (name === "ListUsersCommand") {
        return { Users: activeSubs.map((sub) => ({ Username: sub, Attributes: [{ Name: "sub", Value: sub }] })) };
      }
      if (name === "AdminGetUserCommand" && input.Username === STRANDED && !deleted.includes(STRANDED)) {
        const { Attributes, ...rest } = strandedUser();
        return { ...rest, UserAttributes: Attributes };
      }
      if (name === "AdminGetUserCommand") {
        if (activeSubs.includes(input.Username!)) return { Username: input.Username };
        throw awsError("UserNotFoundException");
      }
      if (name === "AdminDeleteUserCommand") {
        deleted.push(input.Username!);
        return {};
      }
      throw new Error(`Unexpected Cognito command ${name}`);
    });
    return deleted;
  }

  const strandedUser = () => ({
    Username: STRANDED,
    Attributes: [
      { Name: "sub", Value: STRANDED },
      { Name: "email", Value: "stranded@example.com" },
    ],
    UserStatus: "UNCONFIRMED",
    Enabled: true,
    UserCreateDate: new Date(Date.now() - (UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS + 24) * 60 * 60 * 1000),
  });

  /** fakeDynamo, plus GetItem (the step's UserPII read) answering that no row exists. */
  function withUserTables(rows: Record<string, UserRows>) {
    fakeDynamo(rows);
    const route = mockDdbSend.getMockImplementation()!;
    mockDdbSend.mockImplementation(async (command: FakeCommand) =>
      command.constructor.name === "GetItemCommand" ? {} : route(command),
    );
  }

  it("is off unless switched on: no listing, and the summary says so", async () => {
    fakeDynamo({ "active-user": { UserPII: [] } });
    fakeCognito([["active-user"]]);

    const response = await handler();

    expect(response.unconfirmedSignUps).toEqual({
      mode: "off",
      maxAgeHours: UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS,
      maxPerRun: UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN,
    });
    expect(unconfirmedListing()).toEqual([]);
    expect(emfLines().some((line) => "UnconfirmedSignUpsDeleted" in line)).toBe(false);
  });

  it("deletes under its own switch while DRY_RUN keeps the orphan path to a report", async () => {
    process.env.DRY_RUN = "true";
    process.env.UNCONFIRMED_SIGNUP_CLEANUP_MODE = "delete";
    withUserTables({ "gone-user": fullOrphan, "active-user": { UserPII: [] } });
    const deleted = withStrandedSignUp(["active-user"]);

    const response = await handler();

    expect(deleted).toEqual([STRANDED]);
    expect(response.dryRun).toBe(true);
    expect(response.wouldDelete).toEqual(["gone-user"]);
    expect(response.unconfirmedSignUps).toMatchObject({ mode: "delete", listed: 1, expired: 1, deleted: 1, errors: 0 });
    // The orphan path still wrote nothing.
    expect([...sentDynamo("BatchWriteItemCommand"), ...sentDynamo("DeleteItemCommand")]).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(
      "cleanupOrphanedUsers summary",
      expect.objectContaining({ unconfirmedSignUps: expect.objectContaining({ deleted: 1 }) }),
    );
    expect(emfLines().find((line) => "UnconfirmedSignUpsDeleted" in line)).toMatchObject({
      UnconfirmedSignUpsDeleted: 1,
    });
  });

  it("dry_run: counts the sign-up and deletes nothing", async () => {
    process.env.UNCONFIRMED_SIGNUP_CLEANUP_MODE = "dry_run";
    withUserTables({ "active-user": { UserPII: [] } });
    const deleted = withStrandedSignUp(["active-user"]);

    const response = await handler();

    expect(deleted).toEqual([]);
    expect(response.unconfirmedSignUps).toMatchObject({ mode: "dry_run", wouldDelete: 1 });
    expect(writeCalls()).toEqual([]);
  });

  it("does not run when the orphan path aborts", async () => {
    process.env.UNCONFIRMED_SIGNUP_CLEANUP_MODE = "delete";
    withUserTables({ "user-a": fullOrphan, "user-b": { UserPII: [] } });
    const deleted = withStrandedSignUp([]);

    await expect(handler()).rejects.toThrow("Cognito pool listed zero users");

    expect(unconfirmedListing()).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("an error in the step is reported in its block; the run and its report still complete", async () => {
    process.env.UNCONFIRMED_SIGNUP_CLEANUP_MODE = "delete";
    fakeDynamo({ "active-user": { UserPII: [] } });
    fakeCognito([["active-user"]]);
    const route = mockCognitoSend.getMockImplementation()!;
    mockCognitoSend.mockImplementation(async (command: FakeCommand) => {
      if (command.input.Filter) throw awsError("AccessDeniedException");
      return route(command);
    });

    const response = await handler();

    expect(response.unconfirmedSignUps).toMatchObject({ errors: 1, errorNames: ["AccessDeniedException"] });
    expect(stuckMetricValues()).toEqual([0]);
    expect(emfLines().find((line) => "UnconfirmedSignUpCleanupErrors" in line)).toMatchObject({
      UnconfirmedSignUpCleanupErrors: 1,
    });
  });

  describe("a step that throws anyway (a bug) still reaches its alarm", () => {
    const step = require("../handlers/cleanupOrphanedUsers/unconfirmedSignUps");
    afterEach(() => jest.restoreAllMocks());

    const errorLines = () => emfLines().filter((line) => "UnconfirmedSignUpCleanupErrors" in line);

    it("emits UnconfirmedSignUpCleanupErrors 1 and reports stepFailed; the run and its report complete", async () => {
      process.env.UNCONFIRMED_SIGNUP_CLEANUP_MODE = "delete";
      fakeDynamo({ "active-user": { UserPII: [] } });
      fakeCognito([["active-user"]]);
      jest.spyOn(step, "cleanupUnconfirmedSignUps").mockRejectedValue(new TypeError("a bug"));

      const response = await handler();

      expect(response.unconfirmedSignUps).toEqual({
        mode: "delete",
        maxAgeHours: UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS,
        maxPerRun: UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN,
        errors: 1,
        errorNames: ["TypeError"],
        stepFailed: true,
      });
      expect(errorLines()).toEqual([
        expect.objectContaining({ UnconfirmedSignUpCleanupErrors: 1, mode: "delete", stepFailed: true }),
      ]);
      expect(errorLines()[0]._aws!.CloudWatchMetrics[0]).toMatchObject({
        Namespace: "BillBoard/Accounts",
        Dimensions: [[]],
      });
      expect(stuckMetricValues()).toEqual([0]);
    });

    it("covers a failure to read the settings, with the mode read on its own", async () => {
      process.env.UNCONFIRMED_SIGNUP_CLEANUP_MODE = "dry_run";
      fakeDynamo({ "active-user": { UserPII: [] } });
      fakeCognito([["active-user"]]);
      jest.spyOn(step, "unconfirmedCleanupConfigFromEnv").mockImplementation(() => {
        throw new RangeError("a bug");
      });

      const response = await handler();

      expect(response.unconfirmedSignUps).toMatchObject({
        mode: "dry_run",
        errors: 1,
        errorNames: ["RangeError"],
        stepFailed: true,
      });
      expect(errorLines()).toHaveLength(1);
    });

    it("stays silent while the mode is off (the kill switch)", async () => {
      fakeDynamo({ "active-user": { UserPII: [] } });
      fakeCognito([["active-user"]]);
      jest.spyOn(step, "unconfirmedCleanupConfigFromEnv").mockImplementation(() => {
        throw new RangeError("a bug");
      });

      const response = await handler();

      expect(response.unconfirmedSignUps).toEqual({
        mode: "off",
        maxAgeHours: UNCONFIRMED_SIGNUP_DEFAULT_MAX_AGE_HOURS,
        maxPerRun: UNCONFIRMED_SIGNUP_DEFAULT_MAX_DELETIONS_PER_RUN,
      });
      expect(errorLines()).toEqual([]);
    });
  });
});

// REL-53 (feature review S17): the pool listing counts the sign-ups confirmed in the day before the run.
describe("cleanupOrphanedUsers: SignUpsConfirmed (REL-53, S17)", () => {
  const hours = 60 * 60 * 1000;
  type Listed = { sub: string; status?: string; createdHoursAgo?: number };

  function cognitoListing(users: Listed[]) {
    mockCognitoSend.mockImplementation(async (command: FakeCommand) => {
      const name = command.constructor.name;
      if (name === "ListUsersCommand" && !command.input.Filter) {
        expect(command.input.AttributesToGet).toEqual(["sub"]);
        return {
          Users: users.map(({ sub, status, createdHoursAgo }) => ({
            Username: sub,
            Attributes: [{ Name: "sub", Value: sub }],
            ...(status ? { UserStatus: status } : {}),
            ...(createdHoursAgo === undefined
              ? {}
              : { UserCreateDate: new Date(Date.now() - createdHoursAgo * hours) }),
          })),
        };
      }
      if (name === "AdminGetUserCommand") return { Username: command.input.Username };
      throw new Error(`Unexpected Cognito command ${name}`);
    });
  }

  const confirmedLines = () => emfLines().filter((line) => "SignUpsConfirmed" in line);

  it("counts CONFIRMED users created in the last 24 hours, every run, with no user ID on the line", async () => {
    const users: Listed[] = [
      { sub: "new-confirmed", status: "CONFIRMED", createdHoursAgo: 2 },
      { sub: "new-confirmed-2", status: "CONFIRMED", createdHoursAgo: 23.9 },
      { sub: "old-confirmed", status: "CONFIRMED", createdHoursAgo: 24.1 },
      { sub: "new-unconfirmed", status: "UNCONFIRMED", createdHoursAgo: 1 },
      { sub: "new-admin-created", status: "FORCE_CHANGE_PASSWORD", createdHoursAgo: 1 },
      { sub: "no-date", status: "CONFIRMED" },
    ];
    fakeDynamo(Object.fromEntries(users.map(({ sub }) => [sub, { UserPII: [] }])));
    cognitoListing(users);

    const response = await handler();

    expect(response.signUpsConfirmed).toBe(2);
    expect(confirmedLines()).toEqual([expect.objectContaining({ SignUpsConfirmed: 2, windowHours: 24 })]);
    expect(confirmedLines()[0]._aws!.CloudWatchMetrics[0]).toMatchObject({
      Namespace: "BillBoard/Accounts",
      Dimensions: [[]],
    });
    const line = JSON.stringify(confirmedLines()[0]);
    users.forEach(({ sub }) => expect(line).not.toContain(sub));
    // No call beyond the listing the orphan path already makes.
    expect(sentCognito("ListUsersCommand")).toHaveLength(1);
  });

  it("emits 0 on a day without one, and still emits on a run that then aborts", async () => {
    fakeDynamo({ "user-a": fullOrphan, "user-b": fullOrphan, "user-c": fullOrphan, "active-user": { UserPII: [] } });
    cognitoListing([{ sub: "active-user", status: "CONFIRMED", createdHoursAgo: 500 }]);

    await expect(handler()).rejects.toThrow("exceed the safety threshold");

    expect(confirmedLines()).toEqual([expect.objectContaining({ SignUpsConfirmed: 0 })]);
  });
});

export {};

describe("cleanupOrphanedUsers X5 steps (address claim, email claim, App Attest bindings)", () => {
  const X5_ENV = {
    ADDRESS_CLAIMS_TABLE_NAME: "VerifiedAddressClaims",
    SIGNUP_EMAIL_CLAIMS_TABLE_NAME: "SignUpEmailClaims",
    APP_ATTEST_TABLE_NAME: "AppAttest",
  };
  const X5_TABLES = Object.values(X5_ENV);

  /** The handler loaded with the X5 table variables set, as the infra sets them. */
  function x5Handler(): typeof handler {
    const previous = Object.fromEntries(Object.keys(X5_ENV).map((name) => [name, process.env[name]]));
    Object.assign(process.env, X5_ENV);
    try {
      let isolated: typeof handler;
      jest.isolateModules(() => {
        isolated = require("../handlers/cleanupOrphanedUsers").handler;
      });
      return isolated!;
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  type Links = { claim?: boolean; emailClaim?: boolean; bindings?: number };

  /**
   * fakeDynamo plus the X5 tables for `links`: a claim the user's PII row points at (and its claim
   * row), an email claim USER#<sub> -> EMAIL#ek-<sub> naming the sub, and App Attest bindings.
   */
  function withX5Tables(links: Record<string, Links>) {
    const base = mockDdbSend.getMockImplementation()!;
    mockDdbSend.mockImplementation(async (command: FakeCommand) => {
      const name = command.constructor.name;
      const input = command.input ?? {};
      if (name === "GetItemCommand" && input.TableName === "UserPII") {
        const userId = input.Key!.userId.S!;
        return links[userId]?.claim
          ? { Item: { verifiedAddressKey: { S: `unit-${userId}` }, verifiedStreetKey: { S: "street-1" } } }
          : {};
      }
      if (name === "UpdateItemCommand" && String(input.UpdateExpression).startsWith("REMOVE")) return {};
      if (name === "TransactWriteItemsCommand") return {};
      if (input.TableName === "VerifiedAddressClaims" && name === "GetItemCommand") {
        const userId = input.Key!.member.S!.replace("USER#", "");
        return links[userId]?.claim ? { Item: { member: input.Key!.member } } : {};
      }
      if (input.TableName === "SignUpEmailClaims") {
        const pk: string = input.Key!.pk.S!;
        if (name === "GetItemCommand" && pk.startsWith("USER#")) {
          const userId = pk.replace("USER#", "");
          return links[userId]?.emailClaim ? { Item: { emailKey: { S: `ek-${userId}` } } } : {};
        }
        if (name === "GetItemCommand") return { Item: { userName: { S: pk.replace("EMAIL#ek-", "") } } };
        if (name === "DeleteItemCommand") return {};
      }
      if (name === "QueryCommand" && input.TableName === "AppAttest") {
        const partition = input.ExpressionAttributeValues![":pk"].S!;
        const count = links[partition.replace("USER#", "")]?.bindings ?? 0;
        return { Items: Array.from({ length: count }, (_, i) => ({ pk: { S: partition }, sk: { S: `KEY#k${i}` } })) };
      }
      if (name === "BatchWriteItemCommand" && input.RequestItems!.AppAttest) return {};
      return base(command);
    });
  }

  /** gone-user: an orphan (orphan path). stale-user: a stalled deletion (resume path). Both linked. */
  function x5Fixture() {
    fakeDynamo(
      {
        ...activeUsers(5),
        "gone-user": fullOrphan,
        "stale-user": { UserPII: [], UserFeedback: ["hr-1"] },
      },
      new Map<string, string | PiiState>([["stale-user", { status: "in_progress", requestedAt: hoursAgo(30) }]]),
    );
    fakeCognito([Object.keys(activeUsers(5))]);
    withX5Tables({
      "gone-user": { claim: true, emailClaim: true, bindings: 1 },
      "stale-user": { claim: true, emailClaim: true, bindings: 2 },
    });
  }

  const x5Calls = () =>
    mockDdbSend.mock.calls
      .map(([command]: [FakeCommand]) => command)
      .filter(
        (command: FakeCommand) =>
          X5_TABLES.includes(command.input.TableName!) ||
          command.constructor.name === "TransactWriteItemsCommand" ||
          Object.keys(command.input.RequestItems ?? {}).some((table) => X5_TABLES.includes(table)),
      );

  it("dry run: counts the three per resume candidate with GetItem and Query only (read-only grants, X23)", async () => {
    process.env.DRY_RUN = "true";
    const isolatedHandler = x5Handler();
    x5Fixture();

    const response = await isolatedHandler();

    expect(response.wouldDelete).toEqual(["gone-user"]);
    expect(response.wouldResume).toEqual([
      expect.objectContaining({
        userId: "stale-user",
        items: {
          feedback: 1,
          preferences: 0,
          devices: 0,
          snsEndpoints: 0,
          sharedSnsEndpointsKept: 0,
          weeklyDigests: 0,
          addressClaims: 1,
          emailClaims: 2,
          appAttestBindings: 2,
        },
      }),
    ]);
    expect(writeCalls()).toHaveLength(0);
    expect(new Set(x5Calls().map((command: FakeCommand) => command.constructor.name))).toEqual(
      new Set(["GetItemCommand", "QueryCommand"]),
    );
    // Configured steps are reported, at 0 in a dry run.
    expect(response.removedItems).toEqual(
      expect.objectContaining({ addressClaims: 0, emailClaims: 0, appAttestBindings: 0 }),
    );
  });

  it("live: the orphan and the resumed deletion release the claim, delete the email claim and the bindings", async () => {
    const isolatedHandler = x5Handler();
    x5Fixture();

    const response = await isolatedHandler();

    expect(response.removedUsers).toBe(1);
    expect(response.removedItems).toEqual({
      pii: 1,
      preferences: 1,
      devices: 1,
      snsEndpoints: 0,
      feedback: 1,
      weeklyDigests: 1,
      addressClaims: 1,
      emailClaims: 2,
      appAttestBindings: 1,
    });
    expect(response.resumed).toEqual([
      expect.objectContaining({
        userId: "stale-user",
        outcome: "completed",
        items: expect.objectContaining({ addressClaims: 1, emailClaims: 2, appAttestBindings: 2 }),
      }),
    ]);

    // The email claim is found by the sub (the username in this pool), and EMAIL# is deleted only on a match.
    const emailDeletes = sentDynamo("DeleteItemCommand").filter(
      (command: FakeCommand) => command.input.TableName === "SignUpEmailClaims",
    );
    expect(emailDeletes.map((command: FakeCommand) => command.input.Key!.pk.S)).toEqual([
      "EMAIL#ek-gone-user",
      "USER#gone-user",
      "EMAIL#ek-stale-user",
      "USER#stale-user",
    ]);
    expect(emailDeletes[0].input.ExpressionAttributeValues).toEqual({ ":userName": { S: "gone-user" } });
    // The orphan's claim attributes go before its PII row is deleted; the resumed one's before its tombstone.
    const order = (command: unknown) =>
      mockDdbSend.mock.invocationCallOrder[mockDdbSend.mock.calls.findIndex(([c]: [FakeCommand]) => c === command)];
    const removes = sentDynamo("UpdateItemCommand").filter((command: FakeCommand) =>
      String(command.input.UpdateExpression).startsWith("REMOVE"),
    );
    expect(removes.map((command: FakeCommand) => command.input.Key!.userId.S)).toEqual(["gone-user", "stale-user"]);
    const piiDelete = sentDynamo("DeleteItemCommand").find(
      (command: FakeCommand) => command.input.TableName === "UserPII",
    );
    expect(order(removes[0])).toBeLessThan(order(piiDelete));
    const tombstone = sentDynamo("PutItemCommand").find(
      (command: FakeCommand) => command.input.Item!.userId.S === "stale-user",
    );
    expect(order(removes[1])).toBeLessThan(order(tombstone));
    expect(sentDynamo("TransactWriteItemsCommand")).toHaveLength(2);
    // Only the accounts' USER#<sub> App Attest partitions are deleted (no key row).
    const appAttestDeletes = sentDynamo("BatchWriteItemCommand")
      .filter((command: FakeCommand) => command.input.RequestItems!.AppAttest)
      .flatMap((command: FakeCommand) =>
        command.input.RequestItems!.AppAttest.map(
          (request: WriteRequest) => `${request.DeleteRequest!.Key!.pk.S}/${request.DeleteRequest!.Key!.sk.S}`,
        ),
      );
    expect(appAttestDeletes).toEqual(["USER#gone-user/KEY#k0", "USER#stale-user/KEY#k0", "USER#stale-user/KEY#k1"]);
  });
});
