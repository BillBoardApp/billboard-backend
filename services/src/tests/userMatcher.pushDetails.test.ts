import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { SQSEvent } from "aws-lambda";
import {
  buildNotificationFanoutMessage,
  type NotificationDelivery,
  parseNotificationFanoutMessage,
} from "../shared/pendingNotifications";
import { applyTestEnv } from "./fixtures/env";
import { CURATED_OVERRIDE_CASES } from "./fixtures/curatedCeremonialOverrides";
import { logLines } from "./logLines";

/*
 * userMatcher's part of S4 and S6 (feature review 2026-10-28):
 * - S4: the action notificationType found ("alert", "passed", "failed") and the bill's first topic reach the pending
 *   row, written inline or through the fan-out message, so userNotifier can say what happened.
 * - S6: a ceremonial resolution sends no "new" push, to topic followers or (as an "in the news" bill) to everyone.
 *   Its alert, updated, passed and failed pushes go out by their rules, but match no follower of a topic or a life
 *   area and name neither (it has none on its manifest row or from GET /processed-bill; since 2026-10-29 for
 *   the topics).
 */

const originalEnv = { ...process.env };
const mockS3Send = jest.fn();
const mockDynamoSend = jest.fn();
const mockSqsSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDynamoSend })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
  BatchGetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  PutItemCommand: jest.fn().mockImplementation((input) => ({ input })),
  ScanCommand: jest.fn().mockImplementation((input) => ({ input })),
  TransactWriteItemsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const GUID = "BILLS-119hres826";
const FANOUT_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/notificationFanoutQueue";

type Doc = {
  /** The bill's guid; GUID when not given. */
  guid?: string;
  billType: string;
  title: string;
  officialTitle?: string;
  subCategories?: string[];
  lifeAreas?: string[];
  sponsors?: string[];
};

const processedBill = (doc: Doc) => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2026-10-27T12:00:00.000Z",
  identifier: { congress: "119", billType: doc.billType, billNumber: "826" },
  guid: doc.guid ?? GUID,
  title: doc.title,
  ...(doc.officialTitle ? { officialTitle: doc.officialTitle } : {}),
  link: "https://www.congress.gov/bill/119th-congress/house-resolution/826",
  soWhat: "",
  billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
  actions: [],
  committees: [],
  subCategories: doc.subCategories ?? ["Energy"],
  lifeAreas: doc.lifeAreas ?? [],
  sponsors: doc.sponsors ?? [],
  cosponsors: [],
});

const CEREMONIAL: Doc = {
  billType: "hres",
  title: "Recognize Careers in Energy Week",
  officialTitle:
    'Supporting the designation of the week of October 16 through October 20, 2026, as "Careers in Energy Week".',
};
const POLICY_RESOLUTION: Doc = {
  billType: "hres",
  title: "Condemn price gouging on home heating oil",
  officialTitle: "Condemning price gouging on home heating oil and calling on the Department of Energy to act.",
};
const BILL: Doc = { billType: "hr", title: "Rural Broadband Access Act" };

type World = {
  doc: Doc;
  /** Users following the bill's first topic ("Category"). */
  topicFollowers?: string[];
  /** Users with a Bill or Watch row on the bill. */
  watchers?: string[];
  /** Users following one of the bill's life areas. */
  lifeAreaFollowers?: string[];
  /** Users following one of the bill's sponsors. */
  memberFollowers?: string[];
  /** An active priority record ("in the news"), with these active users. */
  priorityUsers?: string[];
};

/** A row of a pending-notification write: the Put of one TransactWriteItems entry. */
interface TransactItem {
  Put?: { Item: Record<string, AttributeValue> };
}

/** The DynamoDB input fields the route reads, across the commands the matcher sends. */
interface FakeDynamoInput {
  TableName?: string;
  IndexName?: string;
  KeyConditionExpression?: string;
  TransactItems?: TransactItem[];
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  RequestItems?: { UserPreferences?: { Keys: Array<Record<string, AttributeValue>> } };
}
interface FakeDynamoCommand {
  input?: FakeDynamoInput;
}

const route = (world: World) => {
  // The follow type a preference value is stored under, and who follows it.
  const followOf = (value: string | undefined): { type: string; users: string[] } =>
    value === (world.doc.guid ?? GUID)
      ? { type: "Watch", users: world.watchers ?? [] }
      : value !== undefined && (world.doc.lifeAreas ?? []).includes(value)
        ? { type: "Life Area", users: world.lifeAreaFollowers ?? [] }
        : value !== undefined && (world.doc.sponsors ?? []).includes(value)
          ? { type: "Congress Member", users: world.memberFollowers ?? [] }
          : { type: "Category", users: world.topicFollowers ?? [] };
  mockS3Send.mockImplementation(async () => ({
    Body: { transformToString: jest.fn().mockResolvedValue(JSON.stringify(processedBill(world.doc))) },
  }));
  mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
    const input = cmd.input ?? {};
    if (input.TransactItems) return {};
    if (input.TableName === "Priority") {
      return world.priorityUsers
        ? {
            Item: {
              guid: { S: GUID },
              status: { S: "ACTIVE" },
              isPriority: { BOOL: true },
              priorityUpdatedAt: { S: "2026-10-27T00:00:00.000Z" },
            },
          }
        : {};
    }
    if (input.TableName === "Pii") {
      return { Items: (world.priorityUsers ?? []).map((userId) => ({ userId: { S: userId } })) };
    }
    if (input.IndexName) {
      const { users } = followOf(input.ExpressionAttributeValues![":sub"].S);
      return { Items: users.map((userId) => ({ userId: { S: userId } })) };
    }
    if (input.RequestItems?.UserPreferences) {
      const keys = input.RequestItems.UserPreferences.Keys;
      return {
        Responses: {
          UserPreferences: keys.map((key) => ({
            ...key,
            type: { S: followOf(key.preference?.S).type },
          })),
        },
      };
    }
    // A user's own preference rows (the content-type filter): none, so every bill type is allowed.
    if (input.KeyConditionExpression) return { Items: [] };
    throw new Error(`Unexpected DynamoDB call: ${JSON.stringify(input)}`);
  });
  mockSqsSend.mockImplementation(async (cmd: { input: { Entries: Array<{ Id: string }> } }) => ({
    Successful: cmd.input.Entries.map((entry: { Id: string }) => ({ Id: entry.Id })),
    Failed: [],
  }));
};

const sqsEvent = (bodies: unknown[]): SQSEvent =>
  ({
    Records: bodies.map((body, index) => ({
      messageId: `m-${index}`,
      body: JSON.stringify(body),
      attributes: {},
      messageAttributes: {},
    })),
  }) as unknown as SQSEvent;

let restoreEnv: (() => void) | undefined;

const loadHandler = (env: Record<string, string> = {}) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      BUCKET_NAME: "bill-store",
      PREFERENCE_TABLE: "UserPreferences",
      PREFERENCE_INDEX: "GSI_SubCategoryIndex",
      PENDING_NOTIFICATIONS_TABLE: "Pending",
      PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
      PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
      USER_ID_ATTRIBUTE: "userId",
      SUB_CATEGORY_ATTRIBUTE: "preference",
      PRIORITY_TABLE_NAME: "Priority",
      PII_TABLE_NAME: "Pii",
      ...env,
    },
    { replace: true, base: originalEnv },
  );
  jest.resetModules();
  return require("../handlers/userMatcher").handler as (event: SQSEvent) => Promise<{ batchItemFailures: unknown[] }>;
};

const pendingRows = (): Array<Record<string, AttributeValue>> =>
  mockDynamoSend.mock.calls
    .map(([cmd]: [FakeDynamoCommand]) => cmd.input)
    .flatMap((input) => (input?.TransactItems ?? []).map((item) => item.Put?.Item))
    .filter((item): item is Record<string, AttributeValue> => Boolean(item?.billTitle));

const fanoutMessages = () =>
  mockSqsSend.mock.calls
    .flatMap(([cmd]) => cmd.input.Entries)
    .map((entry: { MessageBody: string }) => JSON.parse(entry.MessageBody));

beforeEach(() => {
  mockS3Send.mockReset();
  mockDynamoSend.mockReset();
  mockSqsSend.mockReset();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("ceremonial resolutions and new-bill pushes (S6)", () => {
  it("sends no new-bill push for a ceremonial resolution, and says why", async () => {
    route({ doc: CEREMONIAL, topicFollowers: ["user-1", "user-2"] });

    const result = await loadHandler()(sqsEvent([{ domain: "bill", objectId: GUID, notificationType: "new" }]));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(pendingRows()).toEqual([]);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Skipping new-bill notification for a ceremonial resolution", billId: GUID }),
    );
  });

  it("sends no new-bill push for an 'in the news' ceremonial resolution, and never lists the users", async () => {
    route({ doc: CEREMONIAL, priorityUsers: ["user-1", "user-2", "user-3"] });

    await loadHandler()(sqsEvent([{ domain: "bill", objectId: GUID, notificationType: "new" }]));

    expect(pendingRows()).toEqual([]);
    expect(mockDynamoSend.mock.calls.map(([cmd]) => cmd.input.TableName)).not.toContain("Pii");
  });

  it("sends no new-bill push through the fan-out either", async () => {
    route({ doc: CEREMONIAL, topicFollowers: ["user-1"] });

    await loadHandler({ NOTIFICATION_FANOUT_QUEUE_URL: FANOUT_QUEUE })(
      sqsEvent([{ domain: "bill", objectId: GUID, notificationType: "new" }]),
    );

    expect(fanoutMessages()).toEqual([]);
  });

  it("still sends the new-bill push of a resolution that is not ceremonial, and of a bill", async () => {
    for (const doc of [POLICY_RESOLUTION, BILL]) {
      mockDynamoSend.mockReset();
      route({ doc, topicFollowers: ["user-1"] });

      await loadHandler()(sqsEvent([{ domain: "bill", objectId: GUID, notificationType: "new" }]));

      expect({ title: doc.title, users: pendingRows().map((row) => row.userId.S) }).toEqual({
        title: doc.title,
        users: ["user-1"],
      });
    }
  });

  it.each([
    ["alert", { alert: { text: "Referred to the Committee on Energy and Commerce.", actionDate: "2026-10-27" } }],
    ["updated", {}],
  ])("still sends a ceremonial resolution's %s push to its voters and watchers", async (notificationType, extra) => {
    route({ doc: CEREMONIAL, watchers: ["user-1"] });

    await loadHandler()(sqsEvent([{ domain: "bill", objectId: GUID, notificationType, ...extra }]));

    expect(pendingRows().map((row) => [row.userId.S, row.notificationType.S])).toEqual([["user-1", notificationType]]);
  });

  const outcomes = [
    ["passed", { passed: { text: "Resolution agreed to in House.", actionDate: "2026-10-27", actionCode: "8000" } }],
    ["failed", { failed: { text: "Failed of passage.", actionDate: "2026-10-27", actionCode: "9000" } }],
  ] as const;

  it.each(outcomes)(
    "sends a ceremonial resolution's %s push to its voters, watchers and sponsors' followers, never by topic or life area",
    async (notificationType, extra) => {
      route({
        doc: { ...CEREMONIAL, lifeAreas: ["Medical Costs"], sponsors: ["B001318"] },
        topicFollowers: ["user-topic"],
        lifeAreaFollowers: ["user-life"],
        watchers: ["user-watch"],
        memberFollowers: ["user-member"],
      });

      await loadHandler()(sqsEvent([{ domain: "bill", objectId: GUID, notificationType, ...extra }]));

      const rows = pendingRows();
      expect(rows.map((row) => [row.userId.S, row.notificationType.S]).sort()).toEqual([
        ["user-member", notificationType],
        ["user-watch", notificationType],
      ]);
      // No topic or life area is named: the row files under "General", as for any bill without topics.
      for (const row of rows) {
        expect(row.subCategory).toBeUndefined();
        expect(row.category).toEqual({ S: "General" });
        expect(row.lifeArea).toEqual({ S: "" });
      }
      // Neither the topic nor the life area is even looked up.
      const lookedUp = mockDynamoSend.mock.calls
        .map(([cmd]: [FakeDynamoCommand]) => cmd.input)
        .filter((input) => input?.IndexName)
        .map((input) => input!.ExpressionAttributeValues![":sub"].S);
      expect(lookedUp).not.toContain("Energy");
      expect(lookedUp).not.toContain("Medical Costs");
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Extracted match candidates",
          ceremonial: true,
          categoryCount: 0,
          lifeAreaCount: 0,
        }),
      );
    },
  );

  it.each(outcomes)(
    "still sends the %s push of a resolution that is not ceremonial to its topic and life-area followers",
    async (notificationType, extra) => {
      route({
        doc: { ...POLICY_RESOLUTION, lifeAreas: ["Medical Costs"] },
        topicFollowers: ["user-topic"],
        lifeAreaFollowers: ["user-life"],
      });

      await loadHandler()(sqsEvent([{ domain: "bill", objectId: GUID, notificationType, ...extra }]));

      const rows = pendingRows();
      expect(rows.map((row) => row.userId.S).sort()).toEqual(["user-life", "user-topic"]);
      for (const row of rows) {
        expect(row).toMatchObject({
          notificationType: { S: notificationType },
          subCategory: { S: "Energy" },
          lifeArea: { S: "Medical Costs" },
        });
      }
    },
  );

  it.each([
    ["alert", { alert: { text: "Referred to the Committee on Energy and Commerce.", actionDate: "2026-10-27" } }],
    ["updated", {}],
  ])(
    "sends an 'in the news' ceremonial resolution's %s push to its voters and watchers, not its topic followers",
    async (notificationType, extra) => {
      route({
        doc: CEREMONIAL,
        priorityUsers: ["user-topic", "user-watch"],
        topicFollowers: ["user-topic"],
        watchers: ["user-watch"],
      });

      await loadHandler()(sqsEvent([{ domain: "bill", objectId: GUID, notificationType, ...extra }]));

      expect(pendingRows().map((row) => [row.userId.S, row.notificationType.S])).toEqual([
        ["user-watch", notificationType],
      ]);
    },
  );
});

describe("the curated overrides on resolutions (2026-10-29, both rounds)", () => {
  // As each bill's document is stored now (no official title) and once a re-summary stores Congress's (RUNBOOK 4.12).
  const docOf = (decision: (typeof CURATED_OVERRIDE_CASES)[number][2]): Doc => ({
    guid: decision.guid,
    billType: decision.billType,
    title: decision.headline,
    officialTitle: decision.officialTitle,
    subCategories: decision.subCategories,
    lifeAreas: decision.lifeAreas,
  });

  // The followers of what its document lists: a topic, a life area or both (hres955, hres440, hres1528: no topic).
  const listFollowers = (decision: (typeof CURATED_OVERRIDE_CASES)[number][2]): string[] => [
    ...(decision.subCategories.length > 0 ? ["user-topic"] : []),
    ...(decision.lifeAreas.length > 0 ? ["user-life"] : []),
  ];

  it.each(CURATED_OVERRIDE_CASES)(
    "sends %s's new-bill push to its topic and life-area followers only when its curated override says it is not ceremonial, by %s",
    async (guid, _titles, decision) => {
      route({ doc: docOf(decision), topicFollowers: ["user-topic"], lifeAreaFollowers: ["user-life"] });

      await loadHandler()(sqsEvent([{ domain: "bill", objectId: guid, notificationType: "new" }]));

      const users = pendingRows()
        .map((row) => row.userId.S)
        .sort();
      expect(users).toEqual(decision.ceremonial ? [] : listFollowers(decision).sort());
    },
  );

  it.each(CURATED_OVERRIDE_CASES)(
    "sends %s's passed push to its topic and life-area followers only when its curated override says it is not ceremonial, by %s",
    async (guid, _titles, decision) => {
      route({
        doc: docOf(decision),
        topicFollowers: ["user-topic"],
        lifeAreaFollowers: ["user-life"],
        watchers: ["user-watch"],
      });

      await loadHandler()(
        sqsEvent([
          {
            domain: "bill",
            objectId: guid,
            notificationType: "passed",
            passed: { text: "Resolution agreed to in House.", actionDate: "2026-10-27", actionCode: "8000" },
          },
        ]),
      );

      const users = pendingRows()
        .map((row) => row.userId.S)
        .sort();
      if (decision.ceremonial) {
        expect(users).toEqual(["user-watch"]);
      } else {
        expect(users).toEqual([...listFollowers(decision), "user-watch"].sort());
      }
    },
  );
});

describe("the action and topic reach the pending row (S4)", () => {
  const alertMessage = {
    domain: "bill",
    objectId: GUID,
    notificationType: "alert",
    alert: {
      text: "Reported by the Committee on Energy and Commerce.",
      actionDate: "2026-10-27",
      actionCode: "5000",
      actionType: "Committee",
    },
  };

  it("writes an alert's action and the bill's first topic on the row (inline)", async () => {
    route({ doc: { ...BILL, subCategories: ["Telecommunications", "Energy"] }, watchers: ["user-1"] });

    await loadHandler()(sqsEvent([alertMessage]));

    expect(pendingRows()).toEqual([
      expect.objectContaining({
        userId: { S: "user-1" },
        notificationType: { S: "alert" },
        category: { S: "Bill Alert" },
        subCategory: { S: "Telecommunications" },
        actionText: { S: "Reported by the Committee on Energy and Commerce." },
        actionDate: { S: "2026-10-27" },
        actionCode: { S: "5000" },
        actionType: { S: "Committee" },
      }),
    ]);
  });

  it("hands the action and topic to the fan-out, which writes the same row", async () => {
    route({ doc: { ...BILL, subCategories: ["Telecommunications"] }, watchers: ["user-1"] });

    await loadHandler({ NOTIFICATION_FANOUT_QUEUE_URL: FANOUT_QUEUE })(sqsEvent([alertMessage]));

    const [message] = fanoutMessages();
    expect(message).toMatchObject({
      version: 1,
      notificationType: "alert",
      subCategory: "Telecommunications",
      action: alertMessage.alert,
    });
    const parsed = parseNotificationFanoutMessage(JSON.stringify(message));
    expect(parsed).toMatchObject({
      ok: true,
      message: { subCategory: "Telecommunications", action: alertMessage.alert },
    });
  });

  it("writes a passed bill's passage action for its topic followers", async () => {
    route({ doc: BILL, topicFollowers: ["user-1"] });

    await loadHandler()(
      sqsEvent([
        {
          domain: "bill",
          objectId: GUID,
          notificationType: "passed",
          passed: { text: "Passed/agreed to in House.", actionDate: "2026-10-27", actionCode: "8000" },
        },
      ]),
    );

    expect(pendingRows()).toEqual([
      expect.objectContaining({
        notificationType: { S: "passed" },
        subCategory: { S: "Energy" },
        actionText: { S: "Passed/agreed to in House." },
        actionCode: { S: "8000" },
      }),
    ]);
  });

  it("writes no action on a new or updated row, nor for a message without one", async () => {
    route({ doc: BILL, topicFollowers: ["user-1"], watchers: ["user-2"] });

    await loadHandler()(
      sqsEvent([
        { domain: "bill", objectId: GUID, notificationType: "new", alert: alertMessage.alert },
        { domain: "bill", objectId: GUID, notificationType: "updated" },
        { domain: "bill", objectId: GUID, notificationType: "failed" },
      ]),
    );

    const rows = pendingRows();
    // UX-33: the failure also reaches the bill's watcher.
    expect(rows.map((row) => [row.notificationType.S, row.userId.S])).toEqual([
      ["new", "user-1"],
      ["updated", "user-2"],
      ["failed", "user-2"],
      ["failed", "user-1"],
    ]);
    for (const row of rows) {
      expect(row.actionText).toBeUndefined();
      expect(row.subCategory).toEqual({ S: "Energy" });
    }
  });
});

describe("the fan-out message's action and topic (S4)", () => {
  const delivery: NotificationDelivery = {
    billId: GUID,
    billTitle: "Rural Broadband Access Act",
    category: "Bill Alert",
    lifeArea: "",
    subCategory: "Telecommunications",
    action: { text: "Reported by the Committee on Energy and Commerce.", actionDate: "2026-10-27", actionCode: "5000" },
    notificationType: "alert",
    isPriorityBill: false,
    rawBillType: "hr",
  };

  it("round-trips through the message", () => {
    const parsed = parseNotificationFanoutMessage(JSON.stringify(buildNotificationFanoutMessage(delivery, ["u1"])));
    expect(parsed).toEqual({
      ok: true,
      message: expect.objectContaining({ subCategory: "Telecommunications", action: delivery.action, userIds: ["u1"] }),
    });
  });

  it("is optional: a message without them, or with malformed ones, is still read", () => {
    const { subCategory: _subCategory, action: _action, ...plain } = delivery;
    const base = buildNotificationFanoutMessage(plain, ["u1"]);
    expect(base).not.toHaveProperty("action");
    expect(base).not.toHaveProperty("subCategory");
    for (const malformed of [
      { ...base, action: { text: "  " }, subCategory: 7 },
      { ...base, action: "Passed the House", subCategory: "" },
      { ...base, action: ["x"] },
    ]) {
      const parsed = parseNotificationFanoutMessage(JSON.stringify(malformed));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.message.action).toBeUndefined();
        expect(parsed.message.subCategory).toBeUndefined();
      }
    }
  });

  it("bounds the action's fields", () => {
    const parsed = parseNotificationFanoutMessage(
      JSON.stringify({
        ...buildNotificationFanoutMessage(delivery, ["u1"]),
        action: { text: "x".repeat(2000), actionDate: "2".repeat(200), actionCode: 8000 },
      }),
    );
    expect(parsed.ok && parsed.message.action).toEqual({ text: "x".repeat(512), actionDate: "2".repeat(64) });
  });
});
