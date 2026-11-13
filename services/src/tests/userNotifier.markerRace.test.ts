import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { SQSEvent } from "aws-lambda";

import { dispatchShardPartitionValue } from "../shared/dispatchShards";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { applyTestEnv } from "./fixtures/env";

/*
 * CAP-02 follow-up (adversarial review, finding 2). The pending notifications table in memory,
 * driven by the real writer (writePendingNotification) and the real userNotifier. A transaction
 * can be stamped at W and commit seconds later (SDK retries, throttling), after userNotifier has
 * queried the user's rows. Its row must not be left without a dispatch marker.
 */

type Item = Record<string, AttributeValue>;

/** The input fields the fake DynamoDB reads, across the commands UserNotifier and the writer send. */
interface FakeInput extends ConditionInput {
  TableName?: string;
  Key?: Item;
  TransactItems?: Array<{ Put: ConditionInput & { Item: Item } }>;
  RequestItems?: { Pending: Array<{ DeleteRequest: { Key: Item } }> };
}

/** What the fake reads from an AWS SDK command: its class's name and its input. */
interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

const mockTable = new Map<string, Item>();
let mockAfterPendingQuery: (() => Promise<void>) | undefined;

const tableKey = (userId: string, guid: string) => `${userId}|${guid}`;

const mockSend = async (cmd: FakeCommand): Promise<unknown> => {
  const name: string = cmd.constructor.name;
  const input = cmd.input;
  switch (name) {
    case "TransactWriteItemsCommand": {
      const puts = input.TransactItems!.map((entry) => entry.Put);
      const codes = puts.map((put) =>
        evaluateCondition(mockTable.get(tableKey(put.Item.userId.S!, put.Item.guid.S!)), put)
          ? "None"
          : "ConditionalCheckFailed",
      );
      if (codes.some((code) => code !== "None")) {
        throw Object.assign(new Error(`Transaction cancelled [${codes.join(", ")}]`), {
          name: "TransactionCanceledException",
          CancellationReasons: codes.map((Code) => ({ Code })),
        });
      }
      for (const put of puts) mockTable.set(tableKey(put.Item.userId.S!, put.Item.guid.S!), put.Item);
      return {};
    }
    case "QueryCommand": {
      if (input.TableName === "Devices") {
        return {
          Items: [
            {
              user_id: { S: "u1" },
              device_id: { S: "d1" },
              endpointArn: { S: "arn:aws:sns:us-east-1:1:endpoint/APNS/app/d1" },
            },
          ],
        };
      }
      const userId = input.ExpressionAttributeValues![":userId"].S;
      const items = [...mockTable.values()].filter((item) => item.userId.S === userId);
      const hook = mockAfterPendingQuery;
      mockAfterPendingQuery = undefined;
      // The in-flight transaction commits right after the query was answered.
      await hook?.();
      return { Items: items };
    }
    case "GetItemCommand":
      return { Item: mockTable.get(tableKey(input.Key!.userId.S!, input.Key!.guid.S!)) };
    case "DeleteItemCommand": {
      const key = tableKey(input.Key!.userId.S!, input.Key!.guid.S!);
      if (!evaluateCondition(mockTable.get(key), input)) throw conditionalCheckFailed();
      mockTable.delete(key);
      return {};
    }
    case "BatchWriteItemCommand":
      for (const request of input.RequestItems!.Pending) {
        mockTable.delete(tableKey(request.DeleteRequest.Key.userId.S!, request.DeleteRequest.Key.guid.S!));
      }
      return {};
    default:
      throw new Error(`Unexpected DynamoDB call ${name}: ${JSON.stringify(input)}`);
  }
};

jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
}));
jest.mock("@aws-sdk/client-sns", () => ({
  ...jest.requireActual("@aws-sdk/client-sns"),
  SNSClient: jest.fn(() => ({ send: async () => ({ MessageId: "m" }) })),
}));

const originalEnv = { ...process.env };
let restoreEnv: (() => void) | undefined;

const T0 = 1_760_000_000_000;
const shard = dispatchShardPartitionValue("__dispatch__", "u1", 8);
const notifierEvent = {
  Records: [{ messageId: "m1", body: JSON.stringify({ userIds: ["u1"] }) }],
} as unknown as SQSEvent;

const pendingRows = () =>
  [...mockTable.values()]
    .filter((item) => item.userId.S === "u1")
    .map((item) => item.guid.S)
    .sort();
const markers = () => [...mockTable.values()].filter((item) => item.markerType?.S === "pending-user");

beforeEach(() => {
  jest.resetModules();
  mockTable.clear();
  mockAfterPendingQuery = undefined;
  restoreEnv = applyTestEnv(
    {
      PENDING_NOTIFICATIONS_TABLE: "Pending",
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "guid",
      DEVICE_TABLE: "Devices",
      USER_ID_ATTRIBUTE: "user_id",
      DEVICE_ID_ATTRIBUTE: "device_id",
    },
    { replace: true, base: originalEnv },
  );
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    jest.spyOn(console, method).mockImplementation();
  }
});

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

const load = () => {
  const pending = require("../shared/pendingNotifications");
  const store = pending.pendingNotificationStoreConfigFromEnv();
  const write = (billId: string, client: { send: (cmd: FakeCommand) => Promise<unknown> } = { send: mockSend }) =>
    pending.writePendingNotification(client, store, {
      userId: "u1",
      billId,
      billTitle: `Bill ${billId}`,
      category: "Defense",
      lifeArea: "",
      notificationType: "new",
    });
  const { handler } = require("../handlers/userNotifier");
  return { write, handler, pending, store };
};

describe("userNotifier dispatch marker release (review finding 2)", () => {
  it("keeps the marker for a pending row whose transaction was stamped early and committed after the query", async () => {
    const { write, handler } = load();
    const now = jest.spyOn(Date, "now");

    // Bill 1 was written a minute ago; the dispatcher handed u1 to userNotifier.
    now.mockReturnValue(T0 - 60_000);
    await write("B1");

    // Bill 2's transaction is stamped at W = T0, but its commit is delayed ...
    now.mockReturnValue(T0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const delayed = write("B2", {
      send: async (cmd: FakeCommand) => {
        await gate;
        return mockSend(cmd);
      },
    });

    // ... userNotifier queries at Q = W + 2.2 s, and the transaction lands right after the query.
    now.mockReturnValue(T0 + 2_200);
    mockAfterPendingQuery = async () => {
      release();
      await delayed;
    };
    const result = await handler(notifierEvent);

    expect(result).toEqual({ batchItemFailures: [] });
    // Bill 1 was delivered; bill 2's row survives, and so does a marker, so the next dispatch run sends it.
    expect(pendingRows()).toEqual(["B2#new"]);
    expect(markers()).toHaveLength(1);
    expect(markers()[0].userId.S).toBe(shard);
  });

  it("deletes the marker when every row it announced was delivered", async () => {
    const { write, handler } = load();
    await write("B1");
    await write("B2");

    const result = await handler(notifierEvent);

    expect(result).toEqual({ batchItemFailures: [] });
    expect(pendingRows()).toEqual([]);
    expect(markers()).toEqual([]);
  });

  it("keeps a marker written before versions existed once a new writer has rewritten it after the query", async () => {
    const { write, handler } = load();
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(T0 - 60_000);
    await write("B1");
    // An older Lambda version wrote the marker: no markerVersion.
    const legacy = markers()[0];
    delete legacy.markerVersion;

    now.mockReturnValue(T0);
    mockAfterPendingQuery = async () => {
      // Stamped before the query's time cutoff, so the time condition alone would delete the marker.
      now.mockReturnValue(T0 - 3_000);
      await write("B2");
      now.mockReturnValue(T0);
    };
    await handler(notifierEvent);

    expect(pendingRows()).toEqual(["B2#new"]);
    expect(markers()).toHaveLength(1);
    expect(markers()[0].markerVersion?.S).toEqual(expect.any(String));
  });

  it("gives every marker write a new random markerVersion", async () => {
    const { write } = load();

    await write("B1");
    const first = markers()[0].markerVersion?.S;
    await write("B2");
    const second = markers()[0].markerVersion?.S;

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});
