import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { SQSEvent } from "aws-lambda";
import type { NotificationType } from "../models/notifications";
import { isPairedOutcomeType } from "../shared/pendingNotifications";
import {
  isOutcomePushType,
  OUTCOME_AUDIENCE,
  OUTCOME_PUSH_TYPES,
  outcomeCoversAlert,
  PUSH_AUDIENCE_RULES,
  pushAudienceSources,
  sourceCoveredBy,
} from "../shared/pushAudience";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

/*
 * UX-33 (feature review 2026-10-28, S4 and S14; project decisions that day and on 2026-10-29): who gets each push, as a
 * rule per event type (shared/pushAudience.ts).
 * - passed and failed also reach the bill's voters (a Bill row) and watchers (a Watch row), each user once, and reach
 *   the same people whether the bill is in the news or not;
 * - for a bill "in the news", new still goes to every active user, alert and updated only to its voters, watchers and
 *   topic followers;
 * - every path applies the bill types the user chose, a bill in the news included, but never to the bill's own voters
 *   and watchers, in or out of the news;
 * - an action whose stored version also passes or fails the bill is written by the outcome's message: the action's
 *   row beside the outcome's, in one write, for each user the action reaches; the alert message itself writes nothing
 *   ("one event, per phone": userNotifier sends each device one of the two).
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

/** A row of a pending-notification write: the Put of one TransactWriteItems entry. */
interface TransactItem {
  Put?: { Item: Record<string, AttributeValue> };
}

/** The DynamoDB input fields the route reads, across the commands the matcher sends. */
interface FakeDynamoInput {
  TableName?: string;
  IndexName?: string;
  TransactItems?: TransactItem[];
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  KeyConditionExpression?: string;
  RequestItems?: { UserPreferences?: { Keys: unknown } };
}
interface FakeDynamoCommand {
  input?: FakeDynamoInput;
}

/** One entry of a SendMessageBatch call. */
interface SqsEntry {
  Id: string;
  MessageBody: string;
}
interface FakeSqsCommand {
  input: { Entries: SqsEntry[] };
}

/** The parts of a fan-out message body the audience tests read. */
interface FanoutBody {
  userIds: string[];
  skipBillTypeFilter?: boolean;
}

const GUID = "BILLS-119hr4242";
const SPONSOR = "B000123";

const processedBill = (billType: string) => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2026-10-27T12:00:00.000Z",
  identifier: { congress: "119", billType, billNumber: "4242" },
  guid: GUID,
  title: "Home Heating Relief Act",
  link: "https://www.congress.gov/bill/119th-congress/house-bill/4242",
  soWhat: "",
  billBreakdown: { who: "", what: "", how: "", when: "", where: "Not Applicable", why: "" },
  actions: [],
  committees: [],
  subCategories: ["Energy"],
  lifeAreas: ["Utility Bills"],
  sponsors: [SPONSOR],
  cosponsors: [],
});

/** One preference row: the user follows `value` (a topic, life area, member or the bill's guid) as `type`. */
type Preference = { userId: string; value: string; type: string };

const FOLLOWS: Preference[] = [
  { userId: "voter", value: GUID, type: "Bill" },
  { userId: "watcher", value: GUID, type: "Watch" },
  { userId: "voter-and-topic", value: GUID, type: "Bill" },
  { userId: "voter-and-topic", value: "Energy", type: "Category" },
  { userId: "topic", value: "Energy", type: "Category" },
  { userId: "life-area", value: "Utility Bills", type: "Life Area" },
  { userId: "member", value: SPONSOR, type: "Congress Member" },
];
const ACTIVE_USERS = ["voter", "watcher", "voter-and-topic", "topic", "life-area", "member", "bystander"];

type World = {
  billType?: string;
  inTheNews?: boolean;
  /** Per user, the bill types they chose ("Content Type" rows); none allows every type. */
  contentTypes?: Record<string, string[]>;
  /** Fields left out of the stored processed bill. */
  without?: string[];
  env?: Record<string, string | undefined>;
  /** Fields added to the NotificationType message. */
  message?: Record<string, unknown>;
};

const route = (world: World = {}) => {
  mockS3Send.mockImplementation(async () => ({
    Body: {
      transformToString: jest
        .fn()
        .mockResolvedValue(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(processedBill(world.billType ?? "hr")).filter(([key]) => !world.without?.includes(key)),
            ),
          ),
        ),
    },
  }));
  mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
    const input = cmd.input ?? {};
    if (input.TransactItems) return {};
    if (input.TableName === "Priority") {
      return world.inTheNews
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
    if (input.TableName === "Pii") return { Items: ACTIVE_USERS.map((userId) => ({ userId: { S: userId } })) };
    if (input.IndexName) {
      const value = input.ExpressionAttributeValues![":sub"].S;
      return { Items: FOLLOWS.filter((p) => p.value === value).map((p) => ({ userId: { S: p.userId } })) };
    }
    if (input.RequestItems?.UserPreferences) {
      const keys = input.RequestItems.UserPreferences.Keys as Array<Record<string, AttributeValue>>;
      return {
        Responses: {
          UserPreferences: keys.flatMap((key) => {
            const found = FOLLOWS.find((p) => p.userId === key.userId.S && p.value === key.preference.S);
            return found ? [{ ...key, type: { S: found.type } }] : [];
          }),
        },
      };
    }
    // A user's own preference rows: the content-type filter.
    if (input.TableName === "UserPreferences" && input.KeyConditionExpression) {
      const userId = input.ExpressionAttributeValues![":uid"].S as string;
      return {
        Items: (world.contentTypes?.[userId] ?? []).map((preference) => ({
          userId: { S: userId },
          preference: { S: preference },
          type: { S: "Content Type" },
        })),
      };
    }
    throw new Error(`Unexpected DynamoDB call: ${JSON.stringify(input)}`);
  });
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

const messageFor = (notificationType: string) => ({
  domain: "bill",
  objectId: GUID,
  notificationType,
  ...(notificationType === "alert" ? { alert: { text: "Reported by the Committee on Energy and Commerce." } } : {}),
  ...(notificationType === "passed" ? { passed: { text: "Passed/agreed to in House.", actionCode: "8000" } } : {}),
  ...(notificationType === "failed" ? { failed: { text: "Failed of passage in House.", actionCode: "9000" } } : {}),
});

let restoreEnv: (() => void) | undefined;

const run = async (notificationType: string, world: World = {}) => {
  route(world);
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
      ...world.env,
    },
    { replace: true, base: originalEnv },
  );
  jest.resetModules();
  const handler = require("../handlers/userMatcher").handler as (event: SQSEvent) => Promise<unknown>;
  return handler(sqsEvent([{ ...messageFor(notificationType), ...world.message }]));
};

const transactions = (): TransactItem[][] =>
  mockDynamoSend.mock.calls
    .map(([cmd]: [FakeDynamoCommand]) => cmd.input?.TransactItems)
    .filter((items): items is TransactItem[] => Boolean(items));
const pendingRows = (): Array<Record<string, AttributeValue>> =>
  transactions()
    .flatMap((items) => items.map((item) => item.Put?.Item))
    .filter((item): item is Record<string, AttributeValue> => Boolean(item?.billTitle));
/** The users given the message's own row (not the action row an outcome's write adds beside it). */
const recipients = () =>
  pendingRows()
    .filter((row) => !row.pairedOutcome)
    .map((row) => row.userId.S);
/** The users given an action row beside an outcome's (UX-33, "one event, per phone"). */
const pairedActionRecipients = () =>
  pendingRows()
    .filter((row) => row.pairedOutcome)
    .map((row) => row.userId.S);
const userTableScans = () => mockDynamoSend.mock.calls.filter(([cmd]) => cmd.input?.TableName === "Pii");

beforeEach(() => {
  mockS3Send.mockReset();
  mockDynamoSend.mockReset();
  mockSqsSend.mockReset();
  mockSqsSend.mockImplementation(async (cmd: FakeSqsCommand) => ({
    Successful: cmd.input.Entries.map((entry) => ({ Id: entry.Id, MessageId: `m-${entry.Id}` })),
    Failed: [],
  }));
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

describe("the push audience rules (UX-33)", () => {
  it("names each event type's audience, for a bill in the news and any other", () => {
    expect(PUSH_AUDIENCE_RULES).toEqual({
      new: { regular: ["interests"], inTheNews: ["everyone"] },
      updated: { regular: ["billFollowers"], inTheNews: ["billFollowers", "topics"] },
      alert: { regular: ["groupFollowers"], inTheNews: ["groupFollowers", "topics"] },
      passed: { regular: ["interests", "groupFollowers"], inTheNews: ["interests", "groupFollowers"] },
      failed: { regular: ["interests", "groupFollowers"], inTheNews: ["interests", "groupFollowers"] },
    });
    expect(pushAudienceSources("alert", true)).toEqual(["groupFollowers", "topics"]);
    expect(pushAudienceSources("alert", false)).toEqual(["groupFollowers"]);
  });

  // Project decision 2026-10-29: an outcome of a bill in the news reaches the same people as every other bill's outcome.
  it("gives an outcome the same audience in the news and out", () => {
    expect(OUTCOME_PUSH_TYPES).toEqual(["passed", "failed"]);
    for (const outcome of OUTCOME_PUSH_TYPES) {
      expect(pushAudienceSources(outcome, true)).toEqual(pushAudienceSources(outcome, false));
    }
  });

  it.each(OUTCOME_PUSH_TYPES.flatMap((outcome) => [false, true].map((inTheNews) => [outcome, inTheNews] as const)))(
    "reaches with '%s' (in the news: %s) everyone the action push reaches",
    (outcome, inTheNews) => {
      expect(outcomeCoversAlert(outcome, inTheNews)).toBe(true);
    },
  );

  // Review of the project's answers (F3): the pairing of an action with an outcome reads one list, OUTCOME_PUSH_TYPES. A
  // new outcome (REL-44's "law") given the outcome rule but left out of the list, or the reverse, would ship unpaired:
  // its action and outcome rows written apart, and two pushes for one change.
  it("pairs exactly the push types whose rule is the outcome rule, in every guard that reads the list", () => {
    const types = Object.keys(PUSH_AUDIENCE_RULES) as NotificationType[];
    expect(types.filter((type) => PUSH_AUDIENCE_RULES[type] === OUTCOME_AUDIENCE)).toEqual([...OUTCOME_PUSH_TYPES]);
    for (const type of types) {
      expect({ type, outcome: isOutcomePushType(type) }).toEqual({
        type,
        outcome: PUSH_AUDIENCE_RULES[type] === OUTCOME_AUDIENCE,
      });
      expect({ type, paired: isPairedOutcomeType(type) }).toEqual({ type, paired: isOutcomePushType(type) });
    }
    for (const notAType of ["law", "Passed", "", undefined, null, 1]) {
      expect(isOutcomePushType(notAType)).toBe(false);
      expect(isPairedOutcomeType(notAType)).toBe(false);
    }
  });

  it("covers a source by itself or by a wider one, never by a narrower one", () => {
    expect(sourceCoveredBy("topics", ["interests"])).toBe(true);
    expect(sourceCoveredBy("billFollowers", ["groupFollowers"])).toBe(true);
    expect(sourceCoveredBy("groupFollowers", ["everyone"])).toBe(true);
    expect(sourceCoveredBy("interests", ["topics"])).toBe(false);
    expect(sourceCoveredBy("groupFollowers", ["billFollowers"])).toBe(false);
    expect(sourceCoveredBy("everyone", ["interests", "groupFollowers"])).toBe(false);
    // So no other push type's audience would cover an action's, in or out of the news.
    for (const inTheNews of [false, true]) {
      expect(outcomeCoversAlert("updated", inTheNews)).toBe(false);
      expect(outcomeCoversAlert("new", inTheNews)).toBe(inTheNews);
    }
  });

  it("only ever reaches everyone with a new bill in the news", () => {
    for (const [type, rule] of Object.entries(PUSH_AUDIENCE_RULES)) {
      expect({ type, regular: rule.regular.includes("everyone") }).toEqual({ type, regular: false });
      expect({ type, inTheNews: rule.inTheNews.includes("everyone") }).toEqual({ type, inTheNews: type === "new" });
    }
  });
});

describe("who gets a push about a bill that is not in the news (UX-33)", () => {
  it.each(["passed", "failed"])(
    "sends '%s' to the bill's voters and watchers and the followers of its labels, each user once",
    async (type) => {
      await run(type);

      expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic", "topic", "life-area", "member"]);
      expect(pendingRows().every((row) => row.notificationType.S === type && row.sourceBillId.S === GUID)).toBe(true);
      // The outcome keeps the bill's topic group, as before.
      expect(pendingRows()[0].category).toEqual({ S: "Environmental and Energy Policy" });
      expect(userTableScans()).toEqual([]);
    },
  );

  it.each(["alert", "updated"])("sends '%s' to the bill's voters and watchers only, as before", async (type) => {
    await run(type);

    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
    expect(pendingRows()[0].category).toEqual({ S: "Bill Alert" });
    expect(pendingRows()[0].lifeArea).toEqual({ S: "" });
  });

  // Before UX-33 an alert or updated push never read these fields of the document.
  it("still sends an action to the bill's voters and watchers when the stored bill has no topic list or guid", async () => {
    await run("alert", { without: ["subCategories", "guid"] });

    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
    expect(pendingRows()[0].subCategory).toBeUndefined();
    expect(pendingRows()[0].sourceBillId).toEqual({ S: GUID });
  });

  it("sends 'new' to the followers of the bill's labels only, as before", async () => {
    await run("new");

    expect(recipients()).toEqual(["voter-and-topic", "topic", "life-area", "member"]);
  });

  it("applies the bill types a label follower chose to an outcome push", async () => {
    await run("passed", { contentTypes: { topic: ["bills"], "life-area": ["joint_resolutions"] } });

    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic", "topic", "member"]);
  });
});

describe("who gets a push about a bill in the news (UX-33, S14)", () => {
  it("still sends 'new' to every active user, but no longer outside the bill types they chose", async () => {
    await run("new", { inTheNews: true, contentTypes: { bystander: ["joint_resolutions"] } });

    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic", "topic", "life-area", "member"]);
    expect(pendingRows()[0].category).toEqual({ S: "Priority Bill" });
    expect(userTableScans()).toHaveLength(1);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Skipping user due to bill content filter", userId: "bystander" }),
    );
  });

  it.each(["alert", "updated"])(
    "sends '%s' to the bill's voters, watchers and topic followers only, without reading the user list",
    async (type) => {
      await run(type, { inTheNews: true });

      expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic", "topic"]);
      expect(pendingRows().every((row) => row.category.S === "Priority Bill")).toBe(true);
      expect(userTableScans()).toEqual([]);
    },
  );

  // Project decision 2026-10-29: the same people as every other bill's outcome (not everyone; never fewer than for a quiet bill).
  it.each(["passed", "failed"])(
    "sends '%s' to its voters, watchers and label followers, as for any bill, without reading the user list",
    async (type) => {
      await run(type, { inTheNews: true });

      expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic", "topic", "life-area", "member"]);
      expect(pendingRows().every((row) => row.category.S === "Priority Bill")).toBe(true);
      expect(userTableScans()).toEqual([]);
    },
  );

  it("applies the bill types a topic follower chose to an action push", async () => {
    await run("alert", { inTheNews: true, billType: "hres", contentTypes: { topic: ["bills"] } });

    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
  });

  it("sends a new bill in the news only within the bill types each user chose, voters and watchers included", async () => {
    await run("new", { inTheNews: true, billType: "hjres", contentTypes: { voter: ["bills"], topic: ["bills"] } });

    expect(recipients()).toEqual(["watcher", "voter-and-topic", "life-area", "member", "bystander"]);
  });

  it("sends a new bill to the followers of its labels when there is no user list to read", async () => {
    await run("new", { inTheNews: true, env: { PII_TABLE_NAME: undefined } });

    expect(recipients()).toEqual(["voter-and-topic", "topic", "life-area", "member"]);
    expect(userTableScans()).toEqual([]);
  });

  it("logs the audience each push reached", async () => {
    await run("alert", { inTheNews: true });

    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Push audience",
        notificationType: "alert",
        inTheNews: true,
        sources: ["groupFollowers", "topics"],
      }),
    );
  });
});

// Project decision 2026-10-29: a bill's own voters and watchers are never filtered by the bill types they chose, in or out
// of the news, for every push they get; everyone else is.
describe("the bill types of a bill's own voters and watchers (UX-33)", () => {
  it.each([
    ["alert", false],
    ["alert", true],
    ["updated", false],
    ["updated", true],
    ["passed", false],
    ["passed", true],
    ["failed", false],
    ["failed", true],
  ] as const)("sends '%s' (in the news: %s) to them outside those types", async (type, inTheNews) => {
    await run(type, {
      inTheNews,
      billType: "hjres",
      contentTypes: { voter: ["bills"], watcher: ["bills"], "voter-and-topic": ["bills"], topic: ["bills"] },
    });

    expect(recipients().slice(0, 3)).toEqual(["voter", "watcher", "voter-and-topic"]);
    expect(recipients()).not.toContain("topic");
    expect(logLines(console.log)).not.toContainEqual(
      expect.objectContaining({ message: "Skipping user due to bill content filter", userId: "voter" }),
    );
  });

  it("filters the topic followers of a bill in the news by their bill types", async () => {
    await run("alert", { inTheNews: true, billType: "hjres", contentTypes: { voter: ["bills"], topic: ["bills"] } });

    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({ message: "Skipping user due to bill content filter", userId: "topic" }),
    );
  });

  it("marks only their delivery as skipping the filter, in its own fan-out message", async () => {
    await run("passed", { env: { NOTIFICATION_FANOUT_QUEUE_URL: "https://sqs/fanout" } });

    const bodies = mockSqsSend.mock.calls.flatMap(([cmd]: [FakeSqsCommand]) =>
      cmd.input.Entries.map((entry) => JSON.parse(entry.MessageBody) as FanoutBody),
    );
    expect(bodies.map((body) => [body.userIds, body.skipBillTypeFilter])).toEqual([
      [["voter", "watcher", "voter-and-topic"], true],
      [["topic", "life-area", "member"], undefined],
    ]);
  });
});

// Project decision 2026-10-29, "one event, per phone": when one stored version adds an action and passes or fails the
// bill, each user the action reaches gets both rows, written together; userNotifier sends each device one of them.
describe("an action and an outcome of one stored version (UX-33)", () => {
  const RECONSIDER = {
    text: "Motion to reconsider laid on the table Agreed to without objection.",
    actionDate: "2026-10-27",
  };

  it.each([
    ["passed", false],
    ["failed", false],
    ["passed", true],
    ["failed", true],
  ] as const)(
    "writes nothing for the alert message when the version also sends '%s' (in the news: %s)",
    async (outcome, inTheNews) => {
      await run("alert", { inTheNews, message: { sameVersionOutcome: outcome } });

      expect(pendingRows()).toEqual([]);
      expect(logLines(console.log)).toContainEqual(
        expect.objectContaining({
          message: "Skipping the action message; the outcome message of the same version writes its rows",
          outcome,
          inTheNews,
        }),
      );
    },
  );

  it("handles an alert message as before when it names no outcome, or a value that is not one", async () => {
    await run("alert", { message: { sameVersionOutcome: "law" } });

    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
    expect(pendingRows().some((row) => row.pairedOutcome)).toBe(false);
  });

  it.each(["passed", "failed"])(
    "writes the '%s' row and, for the action's audience, the action's row beside it in one write",
    async (outcome) => {
      await run(outcome, { message: { sourceRevision: "v7", sameVersionAlert: RECONSIDER } });

      expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic", "topic", "life-area", "member"]);
      // Out of the news the action reaches the bill's voters and watchers only.
      expect(pairedActionRecipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
      const voterWrite = transactions().find((items) => items[1].Put!.Item.userId.S === "voter")!;
      expect(voterWrite).toHaveLength(5);
      expect(voterWrite[3].Put).toEqual({
        TableName: "Pending",
        Item: expect.objectContaining({
          userId: { S: "__dedupe__" },
          billId: { S: `voter||${GUID}||alert||v7` },
          notificationType: { S: "alert" },
          sourceRevision: { S: "v7" },
        }),
        ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
        ExpressionAttributeNames: { "#pk": "userId", "#sk": "billId" },
      });
      expect(voterWrite[4].Put!.Item).toEqual({
        userId: { S: "voter" },
        billId: { S: `${GUID}#alert` },
        sourceBillId: { S: GUID },
        billTitle: { S: "Home Heating Relief Act" },
        category: { S: "Bill Alert" },
        lifeArea: { S: "" },
        subCategory: { S: "Energy" },
        actionText: { S: RECONSIDER.text },
        actionDate: { S: RECONSIDER.actionDate },
        notificationType: { S: "alert" },
        pairedOutcome: { S: outcome },
        correlationId: expect.any(Object),
        createdAt: expect.any(Object),
        ttl: expect.any(Object),
      });
      // The users the action does not reach get the outcome row alone.
      expect(transactions().find((items) => items[1].Put!.Item.userId.S === "topic")).toHaveLength(3);
    },
  );

  it("gives the action's row to the topic followers of a bill in the news too, as its alert would", async () => {
    await run("passed", { inTheNews: true, message: { sameVersionAlert: RECONSIDER } });

    expect(pairedActionRecipients()).toEqual(["voter", "watcher", "voter-and-topic", "topic"]);
    expect(pendingRows().every((row) => row.category.S === "Priority Bill")).toBe(true);
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: "Push audience",
        notificationType: "passed",
        inTheNews: true,
        sources: ["interests", "groupFollowers"],
        pairedAlertSources: ["groupFollowers", "topics"],
      }),
    );
  });

  it("filters both rows of a label follower together, and never a voter's", async () => {
    await run("failed", {
      inTheNews: true,
      billType: "hjres",
      contentTypes: { voter: ["bills"], topic: ["bills"] },
      message: { sameVersionAlert: RECONSIDER },
    });

    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic", "life-area", "member"]);
    expect(pairedActionRecipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
  });

  it("writes an action row with no action when the message's action is malformed", async () => {
    await run("passed", { message: { sameVersionAlert: { text: "  " } } });

    expect(pairedActionRecipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
    expect(pendingRows().find((row) => row.pairedOutcome)?.actionText).toBeUndefined();
  });

  it("writes the outcome row alone for a message without the action (an older producer), or on another type", async () => {
    await run("passed");
    expect(pairedActionRecipients()).toEqual([]);

    mockDynamoSend.mockReset();
    await run("alert", { message: { sameVersionAlert: RECONSIDER } });
    expect(pairedActionRecipients()).toEqual([]);
    expect(recipients()).toEqual(["voter", "watcher", "voter-and-topic"]);
  });
});

describe("the time of a summary change on an 'updated' row (review of UX-33, F2)", () => {
  it("keeps the message's changedAt on each row, in epoch ms", async () => {
    await run("updated", { message: { changedAt: "2026-10-27T22:00:05.000Z" } });

    expect(pendingRows().map((row) => row.changedAtMs)).toEqual([
      { N: String(Date.parse("2026-10-27T22:00:05.000Z")) },
      { N: String(Date.parse("2026-10-27T22:00:05.000Z")) },
      { N: String(Date.parse("2026-10-27T22:00:05.000Z")) },
    ]);
  });

  it("writes none without a usable time, or for another type", async () => {
    await run("updated", { message: { changedAt: "not a time" } });
    expect(pendingRows().every((row) => row.changedAtMs === undefined)).toBe(true);

    mockDynamoSend.mockReset();
    await run("alert", { message: { changedAt: "2026-10-27T22:00:05.000Z" } });
    expect(pendingRows().every((row) => row.changedAtMs === undefined)).toBe(true);
  });
});
