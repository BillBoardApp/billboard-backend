import type { QueryCommandInput, TransactWriteItem, TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import { SQSBatchResponse, SQSEvent, SQSMessageAttributes } from "aws-lambda";
import { dispatchShardPartitionValue } from "../shared/dispatchShards";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

const originalEnv = { ...process.env };

const mockDynamoSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
  BatchGetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  TransactWriteItemsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

type Handler = (event: SQSEvent, context?: unknown) => Promise<SQSBatchResponse>;
let handler: Handler;
let restoreEnv: (() => void) | undefined;

const CORRELATION_ID = "2026-09-25T10:00:00.000Z:BILLS-119hr900is";

const loadHandler = (overrides: Record<string, string | undefined> = {}) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      PENDING_NOTIFICATIONS_TABLE: "PendingBillNotifications",
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
      PREFERENCE_TABLE: "UserPreferences",
      PREFERENCE_INDEX: "GSI_SubCategoryIndex",
      USER_ID_ATTRIBUTE: "userId",
      SUB_CATEGORY_ATTRIBUTE: "subCategory",
      ...overrides,
    },
    { replace: true, base: originalEnv },
  );
  jest.resetModules();
  handler = require("../handlers/notificationFanout").handler;
};

const users = (count: number, prefix = "user") => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

const fanoutMessage = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  billId: "BILLS-119hr900is",
  billTitle: "Fan-out Bill",
  category: "Bill Alert",
  lifeArea: "",
  notificationType: "alert",
  sourceRevision: "v1",
  correlationId: CORRELATION_ID,
  isPriorityBill: false,
  rawBillType: "house-bill",
  userIds: users(3),
  ...overrides,
});

const eventFor = (bodies: unknown[], withAttribute = true): SQSEvent => ({
  Records: bodies.map((body, idx) => ({
    messageId: `msg-${idx}`,
    receiptHandle: `receipt-${idx}`,
    body: typeof body === "string" ? body : JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: `${Date.now()}`,
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: `${Date.now()}`,
    },
    messageAttributes: (withAttribute
      ? { correlationId: { dataType: "String", stringValue: CORRELATION_ID } }
      : {}) as SQSMessageAttributes,
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:notificationFanoutQueue",
    awsRegion: "us-east-1",
  })),
});

type World = {
  /** userId -> content type preferences ("bills", "joint_resolutions", "other_resolutions"). */
  contentTypes?: Record<string, string[]>;
  /** userId -> error thrown by that user's transaction. */
  transactErrors?: Record<string, Error | Error[]>;
  onTransact?: () => Promise<void>;
};

const routeDynamo = (world: World = {}) => {
  const attempts: Record<string, number> = {};
  mockDynamoSend.mockImplementation(
    async (cmd: { input: Partial<TransactWriteItemsCommandInput & QueryCommandInput> }) => {
      const input = cmd.input;
      if (input.TransactItems) {
        await world.onTransact?.();
        const userId = input.TransactItems[1].Put!.Item!.userId.S as string;
        attempts[userId] = (attempts[userId] ?? 0) + 1;
        const configured = world.transactErrors?.[userId];
        const error = Array.isArray(configured) ? configured[attempts[userId] - 1] : configured;
        if (error) throw error;
        return {};
      }
      const userId = input.ExpressionAttributeValues?.[":uid"]?.S;
      if (userId) {
        return {
          Items: (world.contentTypes?.[userId] ?? []).map((preference) => ({
            userId: { S: userId },
            subCategory: { S: preference },
            type: { S: "Content Type" },
          })),
        };
      }
      throw new Error(`Unexpected DynamoDB call: ${JSON.stringify(input)}`);
    },
  );
  return attempts;
};

const DROP_LOG_MESSAGE = "Message cannot be processed; acknowledged without retry";
const dropLines = () => logLines(console.warn).filter((line) => line.message === DROP_LOG_MESSAGE);
const dropMetrics = () => logLines(console.log).filter((line) => line._aws && "MessagesUnprocessable" in line);
// Makes only the drop helper's two lines throw, so the rest of the handler logs normally.
const breakDropOutput = () => {
  (console.warn as jest.Mock).mockImplementation((line: unknown) => {
    if (String(line).includes(DROP_LOG_MESSAGE)) throw new Error("console.warn broke");
  });
  (console.log as jest.Mock).mockImplementation((line: unknown) => {
    if (String(line).includes('"MessagesUnprocessable"')) throw new Error("console.log broke");
  });
};
const dropOutputAttempts = () => ({
  logs: (console.warn as jest.Mock).mock.calls.filter(([line]) => String(line).includes(DROP_LOG_MESSAGE)).length,
  metrics: (console.log as jest.Mock).mock.calls.filter(([line]) => String(line).includes('"MessagesUnprocessable"'))
    .length,
});

const transactInputs = () =>
  mockDynamoSend.mock.calls.map((call) => call[0].input).filter((input) => Array.isArray(input?.TransactItems));
const writtenUsers = () => transactInputs().map((input) => input.TransactItems[1].Put.Item.userId.S);
const preferenceReads = () =>
  mockDynamoSend.mock.calls.map((call) => call[0].input).filter((input) => input?.ExpressionAttributeValues?.[":uid"]);

const conditionalFailure = () =>
  Object.assign(
    new Error(
      "Transaction cancelled, please refer cancellation reasons for specific reasons [ConditionalCheckFailed, None, None]",
    ),
    {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }],
    },
  );

beforeEach(() => {
  mockDynamoSend.mockReset();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  loadHandler();
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("notificationFanout handler (CAP-02)", () => {
  it("writes the pending notification, dedupe marker and sharded dispatch marker for every user", async () => {
    routeDynamo();

    const result = await handler(eventFor([fanoutMessage()]), { awsRequestId: "req-1" });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(writtenUsers()).toEqual(["user-0", "user-1", "user-2"]);
    const [dedupe, pending, dispatchMarker] = transactInputs()[1].TransactItems.map(
      (item: TransactWriteItem) => item.Put!,
    );
    expect(dedupe).toMatchObject({
      TableName: "PendingBillNotifications",
      ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
      Item: {
        userId: { S: "__dedupe__" },
        billId: { S: "user-1||BILLS-119hr900is||alert||v1" },
        markerType: { S: "notification-dedupe" },
        sourceRevision: { S: "v1" },
      },
    });
    expect(pending.Item).toMatchObject({
      userId: { S: "user-1" },
      billId: { S: "BILLS-119hr900is#alert" },
      sourceBillId: { S: "BILLS-119hr900is" },
      billTitle: { S: "Fan-out Bill" },
      category: { S: "Bill Alert" },
      lifeArea: { S: "" },
      notificationType: { S: "alert" },
      correlationId: { S: CORRELATION_ID },
    });
    expect(dispatchMarker.Item).toMatchObject({
      userId: { S: dispatchShardPartitionValue("__dispatch__", "user-1", 8) },
      billId: { S: "user-1" },
      markerType: { S: "pending-user" },
      targetUserId: { S: "user-1" },
    });
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Wrote pending notification",
        guid: "BILLS-119hr900is",
        correlationId: CORRELATION_ID,
        userId: "user-1",
        sqsMessageId: "msg-0",
        awsRequestId: "req-1",
      }),
    );
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Fanned out pending notifications", userCount: 3, written: 3, duplicates: 0 }),
    );
  });

  it("applies the content-type filter for ordinary bills", async () => {
    routeDynamo({ contentTypes: { "user-1": ["joint_resolutions"], "user-2": ["bills", "other_resolutions"] } });

    await handler(eventFor([fanoutMessage()]));

    expect(writtenUsers()).toEqual(["user-0", "user-2"]);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Skipping user due to bill content filter",
        userId: "user-1",
        billType: "house-bill",
      }),
    );
  });

  // UX-33: every push respects the bill types the user chose, a bill in the news included (it skipped the filter).
  it("applies the content-type filter to priority bills too", async () => {
    routeDynamo({ contentTypes: { "user-1": ["joint_resolutions"] } });

    await handler(eventFor([fanoutMessage({ isPriorityBill: true, category: "Priority Bill" })]));

    expect(writtenUsers()).toEqual(["user-0", "user-2"]);
    expect(preferenceReads()).toHaveLength(3);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Skipping user due to bill content filter", userId: "user-1" }),
    );
  });

  // UX-33 (project decision 2026-10-29): a bill's own voters and watchers keep its pushes outside their bill types, in or
  // out of the news.
  it.each([false, true])(
    "skips the content-type filter for a delivery to a bill's voters and watchers (in the news: %s)",
    async (isPriorityBill) => {
      routeDynamo({ contentTypes: { "user-1": ["joint_resolutions"] } });

      await handler(eventFor([fanoutMessage({ isPriorityBill, skipBillTypeFilter: true })]));

      expect(writtenUsers()).toEqual(["user-0", "user-1", "user-2"]);
      expect(preferenceReads()).toHaveLength(0);
    },
  );

  // UX-33 (project decision 2026-10-29, "one event, per phone"): an outcome whose version also added an action writes the
  // action's row beside the outcome's, in one transaction, for the users the action reaches.
  describe("an outcome with the action of its version (pairedAlert)", () => {
    const ACTION = { text: "Motion to reconsider laid on the table.", actionDate: "2026-10-27" };
    const pairedMessage = (overrides: Record<string, unknown> = {}) =>
      fanoutMessage({
        notificationType: "passed",
        category: "Health",
        lifeArea: "Health Care",
        subCategory: "Medical Costs",
        action: { text: "Passed/agreed to in House.", actionCode: "8000", actionDate: "2026-10-27" },
        pairedAlert: { category: "Bill Alert", action: ACTION },
        skipBillTypeFilter: true,
        ...overrides,
      });

    it("writes both rows and both dedupe markers, the action's marked with the outcome, in one transaction", async () => {
      routeDynamo();

      await handler(eventFor([pairedMessage()]));

      const items = transactInputs()[0].TransactItems.map((item: TransactWriteItem) => item.Put!);
      expect(items).toHaveLength(5);
      expect(items[1].Item).toMatchObject({ billId: { S: "BILLS-119hr900is#passed" }, actionCode: { S: "8000" } });
      expect(items[1].Item).not.toHaveProperty("pairedOutcome");
      expect(items[3]).toEqual({
        TableName: "PendingBillNotifications",
        Item: {
          markerType: { S: "notification-dedupe" },
          targetUserId: { S: "user-0" },
          billId: { S: "user-0||BILLS-119hr900is||alert||v1" },
          notificationType: { S: "alert" },
          sourceRevision: { S: "v1" },
          createdAt: expect.any(Object),
          ttl: expect.any(Object),
          userId: { S: "__dedupe__" },
        },
        ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
        ExpressionAttributeNames: { "#pk": "userId", "#sk": "billId" },
      });
      expect(items[4].Item).toEqual({
        userId: { S: "user-0" },
        billId: { S: "BILLS-119hr900is#alert" },
        sourceBillId: { S: "BILLS-119hr900is" },
        billTitle: { S: "Fan-out Bill" },
        category: { S: "Bill Alert" },
        lifeArea: { S: "" },
        subCategory: { S: "Medical Costs" },
        actionText: { S: ACTION.text },
        actionDate: { S: ACTION.actionDate },
        notificationType: { S: "alert" },
        pairedOutcome: { S: "passed" },
        correlationId: { S: CORRELATION_ID },
        createdAt: items[1].Item.createdAt,
        ttl: items[1].Item.ttl,
      });
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({ message: "Fanned out pending notifications", written: 3, pairedActionRows: 3 }),
      );
    });

    it("writes the outcome row alone when the action's own row for the version was already written", async () => {
      // An older userMatcher handled the version's alert message: only the action's marker (item 3) fails.
      const actionMarkerExists = Object.assign(
        new Error("Transaction cancelled [None, None, None, ConditionalCheckFailed, None]"),
        {
          name: "TransactionCanceledException",
          CancellationReasons: [
            { Code: "None" },
            { Code: "None" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
            { Code: "None" },
          ],
        },
      );
      const attempts = routeDynamo({ transactErrors: { "user-1": [actionMarkerExists] } });

      expect(await handler(eventFor([pairedMessage()]))).toEqual({ batchItemFailures: [] });

      expect(attempts["user-1"]).toBe(2);
      const userOneWrites = transactInputs().filter((input) => input.TransactItems[1].Put.Item.userId.S === "user-1");
      expect(userOneWrites.map((input) => input.TransactItems.length)).toEqual([5, 3]);
      expect(userOneWrites[1].TransactItems[1].Put.Item.billId).toEqual({ S: "BILLS-119hr900is#passed" });
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Wrote the outcome row alone; the change's action row was already written for the user",
          userId: "user-1",
        }),
      );
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({ message: "Fanned out pending notifications", written: 3, pairedActionRows: 2 }),
      );
    });

    it("writes nothing for a redelivered chunk: the outcome's own marker exists", async () => {
      const redelivered = Object.assign(new Error("Transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
        ],
      });
      const attempts = routeDynamo({ transactErrors: { "user-0": redelivered } });

      await handler(eventFor([pairedMessage()]));

      expect(attempts["user-0"]).toBe(1);
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({ message: "Fanned out pending notifications", written: 2, duplicates: 1 }),
      );
    });

    it("filters both rows of a label follower together", async () => {
      routeDynamo({ contentTypes: { "user-1": ["joint_resolutions"] } });

      await handler(eventFor([pairedMessage({ skipBillTypeFilter: undefined })]));

      expect(writtenUsers()).toEqual(["user-0", "user-2"]);
      expect(transactInputs().every((input) => input.TransactItems.length === 5)).toBe(true);
    });

    it("writes no action row beside a type that is not an outcome", async () => {
      routeDynamo();

      await handler(eventFor([pairedMessage({ notificationType: "new" })]));

      expect(transactInputs().every((input) => input.TransactItems.length === 3)).toBe(true);
    });

    it("carries it through the queue, and drops a malformed one", () => {
      const pending = require("../shared/pendingNotifications");
      const parse = (fields: Record<string, unknown>) =>
        pending.parseNotificationFanoutMessage(JSON.stringify(pairedMessage(fields)));

      expect(parse({}).message.pairedAlert).toEqual({ category: "Bill Alert", action: ACTION });
      expect(parse({ pairedAlert: { category: "Priority Bill", action: { text: " " } } }).message.pairedAlert).toEqual({
        category: "Priority Bill",
      });
      expect(parse({ pairedAlert: { action: ACTION } }).message).not.toHaveProperty("pairedAlert");
      expect(parse({ pairedAlert: "yes" }).message).not.toHaveProperty("pairedAlert");
      expect(parse({ notificationType: "alert" }).message).not.toHaveProperty("pairedAlert");
      const built = pending.buildNotificationFanoutMessage(
        { ...pairedMessage(), pairedAlert: { category: "Bill Alert", action: ACTION } },
        ["u1"],
      );
      expect(built.pairedAlert).toEqual({ category: "Bill Alert", action: ACTION });
      expect(
        pending.buildNotificationFanoutMessage({ ...pairedMessage(), notificationType: "updated" }, ["u1"]),
      ).not.toHaveProperty("pairedAlert");
    });
  });

  // Review of UX-33, F2: when the summary changed, for userNotifier's check of a newer vote.
  it("keeps an 'updated' message's change time on the pending row", async () => {
    routeDynamo();

    await handler(eventFor([fanoutMessage({ notificationType: "updated", changedAtMs: 1_793_224_805_000 })]));

    expect(transactInputs().map((input) => input.TransactItems[1].Put.Item.changedAtMs)).toEqual([
      { N: "1793224805000" },
      { N: "1793224805000" },
      { N: "1793224805000" },
    ]);
  });

  it("carries the UX-33 fields from userMatcher's message through the queue, and drops malformed ones", () => {
    const pending = require("../shared/pendingNotifications");
    const delivery = {
      billId: "BILLS-119hr1",
      billTitle: "A bill",
      category: "Priority Bill",
      lifeArea: "",
      notificationType: "updated",
      isPriorityBill: true,
      rawBillType: "hr",
      skipBillTypeFilter: true,
      changedAtMs: 1_793_224_805_000,
    };
    const roundTrip = (fields: Record<string, unknown>) =>
      pending.parseNotificationFanoutMessage(
        JSON.stringify({ ...pending.buildNotificationFanoutMessage(delivery, ["u1"]), ...fields }),
      );

    expect(roundTrip({})).toEqual({
      ok: true,
      message: expect.objectContaining({ skipBillTypeFilter: true, changedAtMs: 1_793_224_805_000 }),
    });
    const malformed = roundTrip({ skipBillTypeFilter: "yes", changedAtMs: -5 });
    expect(malformed.message).not.toHaveProperty("skipBillTypeFilter");
    expect(malformed.message).not.toHaveProperty("changedAtMs");
  });

  it("treats an existing dedupe marker as a no-op, so a redelivered chunk succeeds", async () => {
    routeDynamo({
      transactErrors: { "user-0": conditionalFailure(), "user-2": new Error("[ConditionalCheckFailed, None, None]") },
    });

    const result = await handler(eventFor([fanoutMessage()]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Fanned out pending notifications", written: 1, duplicates: 2, filtered: 0 }),
    );
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Skipping duplicate pending notification", userId: "user-0" }),
    );
  });

  it("retries a transaction conflict on the shared dispatch marker", async () => {
    const conflict = Object.assign(new Error("Transaction cancelled [None, None, TransactionConflict]"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "TransactionConflict" }],
    });
    jest.spyOn(Math, "random").mockReturnValue(0);
    const attempts = routeDynamo({ transactErrors: { "user-1": [conflict, conflict] } });

    const result = await handler(eventFor([fanoutMessage()]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(attempts["user-1"]).toBe(3);
  });

  it("fails only the message whose write fails", async () => {
    routeDynamo({
      transactErrors: {
        "b-1": Object.assign(new Error("Throughput exceeds the current capacity"), {
          name: "ProvisionedThroughputExceededException",
        }),
      },
    });

    const result = await handler(
      eventFor([
        fanoutMessage({ userIds: users(2, "a") }),
        fanoutMessage({ billId: "BILLS-119hr901is", userIds: users(3, "b") }),
        fanoutMessage({ billId: "BILLS-119hr902is", userIds: users(2, "c") }),
      ]),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
    expect(writtenUsers()).toEqual(expect.arrayContaining(["a-0", "a-1", "c-0", "c-1"]));
    expect(logLines(console.error)).toContainEqual(
      expect.objectContaining({ message: "Failed to process notification fan-out message", sqsMessageId: "msg-1" }),
    );
  });

  it("writes at most 8 users at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    routeDynamo({
      onTransact: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
      },
    });

    const result = await handler(eventFor([fanoutMessage({ userIds: users(100) })]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(writtenUsers()).toHaveLength(100);
    expect(maxInFlight).toBe(8);
  });

  it("takes the correlation id from the body when the attribute is missing", async () => {
    routeDynamo();

    await handler(eventFor([fanoutMessage({ userIds: ["user-1"] })], false));

    expect(transactInputs()[0].TransactItems[1].Put.Item.correlationId).toEqual({ S: CORRELATION_ID });
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Wrote pending notification", correlationId: CORRELATION_ID }),
    );
  });

  it("keeps the legacy dedupe key for a notification without a revision", async () => {
    routeDynamo();
    const { sourceRevision: _omit, ...withoutRevision } = fanoutMessage({ userIds: ["user-1"] });

    await handler(eventFor([withoutRevision]));

    expect(transactInputs()[0].TransactItems[0].Put.Item.billId).toEqual({ S: "user-1||BILLS-119hr900is||alert" });
  });

  it("drops malformed messages and fails a message from a newer producer", async () => {
    routeDynamo();

    const result = await handler(
      eventFor([
        "not json",
        { version: 1, billId: "BILLS-119hr900is" },
        fanoutMessage({ notificationType: "bogus" }),
        fanoutMessage({ userIds: ["", 7] }),
        fanoutMessage({ version: 2 }),
        fanoutMessage({ userIds: ["user-9"] }),
      ]),
    );

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-4" }] });
    expect(writtenUsers()).toEqual(["user-9"]);
    // C1.8: each acknowledged drop is logged once and counted once; the retryable one (msg-4) is neither.
    expect(dropLines().map((line) => [line.messageId, line.dropSite, line.reason])).toEqual([
      ["msg-0", "notificationFanout.malformed", "body is not JSON"],
      ["msg-1", "notificationFanout.malformed", "missing billId or billTitle"],
      ["msg-2", "notificationFanout.malformed", "missing or invalid notificationType"],
      ["msg-3", "notificationFanout.malformed", "no valid userIds"],
    ]);
    expect(dropMetrics().map((line) => [line.sqsMessageId, line.MessagesUnprocessable, line.dropSite])).toEqual([
      ["msg-0", 1, "notificationFanout.malformed"],
      ["msg-1", 1, "notificationFanout.malformed"],
      ["msg-2", 1, "notificationFanout.malformed"],
      ["msg-3", 1, "notificationFanout.malformed"],
    ]);
    expect(dropLines()[0].messagePreview).toBe("not json");
    expect(dropLines()[1].messageContent).toEqual({ version: 1, billId: "BILLS-119hr900is" });
  });

  describe("unprocessable-message count (C1.8)", () => {
    it("counts nothing for a well-formed message", async () => {
      routeDynamo();

      const result = await handler(eventFor([fanoutMessage()]));

      expect(result).toEqual({ batchItemFailures: [] });
      expect(dropLines()).toEqual([]);
      expect(dropMetrics()).toEqual([]);
    });

    it("still acknowledges a malformed message when its log line and metric line throw", async () => {
      routeDynamo();
      breakDropOutput();

      const result = await handler(eventFor(["not json", fanoutMessage({ userIds: ["user-9"] })]));

      expect(result).toEqual({ batchItemFailures: [] });
      expect(writtenUsers()).toEqual(["user-9"]);
      expect(dropOutputAttempts()).toEqual({ logs: 1, metrics: 1 });
    });
  });

  describe("a companion pair member's 'new' (APPF-23)", () => {
    const HOUSE = "BILLS-119hr1285";
    const SENATE = "BILLS-119s570";
    const companionNewMessage = (overrides: Record<string, unknown> = {}) =>
      fanoutMessage({
        billId: SENATE,
        billTitle: "Senate Bill",
        notificationType: "new",
        sourceRevision: "v1-senate",
        userIds: ["reached", "not-reached", "redelivered"],
        companionNew: { billId: HOUSE, sourceRevision: "v1-house" },
        ...overrides,
      });
    const cancelled = (codes: string[]) =>
      Object.assign(new Error(`Transaction cancelled [${codes.join(", ")}]`), {
        name: "TransactionCanceledException",
        CancellationReasons: codes.map((Code) => ({ Code })),
      });

    it("skips a user the other member's 'new' reached and writes that 'new''s marker for the others", async () => {
      routeDynamo({
        transactErrors: {
          // The House "new"'s marker exists: it reached this user.
          reached: cancelled(["None", "None", "None", "ConditionalCheckFailed"]),
          // A redelivery: this "new"'s own marker exists (and the House marker it wrote).
          redelivered: cancelled(["ConditionalCheckFailed", "None", "None", "ConditionalCheckFailed"]),
        },
      });

      const result = await handler(eventFor([companionNewMessage()]));

      expect(result).toEqual({ batchItemFailures: [] });
      const companionMarker = transactInputs().find(
        (input) => input.TransactItems[1].Put.Item.userId.S === "not-reached",
      ).TransactItems[3].Put;
      expect(companionMarker).toMatchObject({
        TableName: "PendingBillNotifications",
        // Only the House "new"'s own marker fails it; one another deferral left is overwritten.
        ConditionExpression: "attribute_not_exists(#sk) OR attribute_exists(#reachedBy)",
        ExpressionAttributeNames: { "#sk": "billId", "#reachedBy": "reachedByBillId" },
        Item: {
          userId: { S: "__dedupe__" },
          billId: { S: `not-reached||${HOUSE}||new||v1-house` },
          markerType: { S: "notification-dedupe" },
          targetUserId: { S: "not-reached" },
          notificationType: { S: "new" },
          sourceRevision: { S: "v1-house" },
          reachedByBillId: { S: SENATE },
        },
      });
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Fanned out pending notifications",
          written: 1,
          duplicates: 1,
          companionReached: 1,
        }),
      );
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Skipping user; its companion bill's new notification reached them",
          userId: "reached",
          companionGuid: HOUSE,
        }),
      );
      const metricLines = logLines(console.log).filter((line) => line._aws && "CompanionNewSuppressed" in line);
      expect(metricLines.map((line) => line.CompanionNewSuppressed)).toEqual([1]);
      expect(metricLines[0]._aws!.CloudWatchMetrics[0].Namespace).toBe("BillBoard/Notifications");
    });

    it("writes three items and no marker for the other member when the reference is missing or malformed", async () => {
      routeDynamo();

      await handler(
        eventFor([
          companionNewMessage({ companionNew: undefined, userIds: ["a"] }),
          companionNewMessage({ companionNew: { billId: HOUSE }, userIds: ["b"] }),
          // Only a "new" carries it.
          companionNewMessage({ notificationType: "passed", userIds: ["c"] }),
        ]),
      );

      expect(writtenUsers()).toEqual(["a", "b", "c"]);
      expect(transactInputs().map((input) => input.TransactItems.length)).toEqual([3, 3, 3]);
    });

    it("carries the reference from userMatcher's message through the queue", () => {
      const pending = require("../shared/pendingNotifications");
      const delivery = {
        billId: SENATE,
        billTitle: "Senate Bill",
        category: "Healthcare",
        lifeArea: "",
        notificationType: "new",
        sourceRevision: "v1-senate",
        isPriorityBill: false,
        rawBillType: "s",
        companionNew: { billId: HOUSE, sourceRevision: "v1-house" },
      };

      const parsed = pending.parseNotificationFanoutMessage(
        JSON.stringify(pending.buildNotificationFanoutMessage(delivery, ["u1"])),
      );

      expect(parsed).toEqual({ ok: true, message: expect.objectContaining({ companionNew: delivery.companionNew }) });
    });
  });

  it("fails the whole batch when its configuration is missing", async () => {
    loadHandler({ PENDING_NOTIFICATIONS_TABLE: undefined });
    routeDynamo();

    await expect(handler(eventFor([fanoutMessage()]))).rejects.toThrow(
      "Missing env var(s): PENDING_NOTIFICATIONS_TABLE",
    );
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });
});
