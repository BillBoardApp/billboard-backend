/**
 * INT-11, question Q6 (2026-10-17): no push notification text carries other users' vote counts,
 * percentages, abstentions or reasons for a bill the reader has not voted on.
 *
 * Every push Billboard sends is built by userNotifier from the reader's pending rows, which userMatcher
 * (inline) or notificationFanout writes from notificationType's change messages. These tests run those
 * four handlers end to end against one in-memory DynamoDB and S3 in which every bill has other users'
 * votes stored where production keeps them: the BillStats row, the UserFeedback rows (and their bill-id
 * index) and the voteCount on the bill's BillsManifest row, with the environment names the results code
 * reads. The readers have no vote on any of the bills (one has only 1.0 and 1.1 Updates dismissals,
 * which are not votes). Each stage's output, and every push the readers' devices get, is checked for
 * the seeded counts and percentages, for results-shaped keys and for results wording. A change that
 * starts reading results into any of these texts fails here.
 *
 * Bills: a passed, a failed, a became-law (Finalized), an updated and a new bill, and a second passed
 * bill. Devices: one with every type on, one with only passed and failed on, one with only passed on, and
 * one with passed and failed off (it gets the action push of a change that passed or failed a bill instead
 * of its outcome push, UX-33), so the single-bill copy for each type, the one-bill digest, the mixed
 * digest and the same-type digest ("2 Bills Passed", which lists bill titles) are all produced.
 */
import type { SQSEvent } from "aws-lambda";
import { FakeVersionedS3 } from "./fakeVersionedS3";
import { applyTestEnv } from "./fixtures/env";
import { sqsWrappedS3Keys } from "./fixtures/awsEvents";
import { findResultLeaks, InMemoryDynamo, seedResults, type Item, type SeededResults } from "./fixtures/resultsWorld";

let mockS3: FakeVersionedS3;
let mockDynamo: InMemoryDynamo;
const mockSqsSend = jest.fn();
const mockSnsSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: (command: never) => mockDynamo.send(command) })),
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  ...jest.requireActual("@aws-sdk/client-sqs"),
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
}));
jest.mock("@aws-sdk/client-sns", () => ({
  ...jest.requireActual("@aws-sdk/client-sns"),
  SNSClient: jest.fn(() => ({ send: mockSnsSend })),
}));

const originalEnv = { ...process.env };

const USER_MATCHER_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/UserMatcherQueue";
const FANOUT_QUEUE = "https://sqs.us-east-1.amazonaws.com/123456789012/NotificationFanoutQueue";
const PENDING_TABLE = "PendingNotificationsTable";

const ENV: Record<string, string> = {
  BUCKET_NAME: "bill-store",
  QUEUE_URL: USER_MATCHER_QUEUE,
  QUEUE_BATCH_SIZE: "10",
  PROCESSED_BILLS_PREFIX: "processed-bills/",
  PREFERENCE_TABLE: "UserPreferences",
  PREFERENCE_INDEX: "GSI_SubCategoryIndex",
  USER_ID_ATTRIBUTE: "userId",
  SUB_CATEGORY_ATTRIBUTE: "preference",
  PENDING_NOTIFICATIONS_TABLE: PENDING_TABLE,
  PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
  PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
  PRIORITY_TABLE_NAME: "BillPriority",
  PRIORITY_TABLE_PARTITION_KEY: "guid",
  PII_TABLE_NAME: "UserPii",
  PII_PARTITION_KEY: "userId",
  MANIFEST_TABLE_NAME: "BillsManifest",
  MANIFEST_PRIMARY_KEY: "pk",
  MANIFEST_SORT_KEY: "sk",
  DEVICE_TABLE: "UserDevices",
  DEVICE_ID_ATTRIBUTE: "deviceId",
  // Where the results live, under the names shared/billStats and GET /bill-stats read them by.
  STATS_TABLE_NAME: "BillStats",
  STATS_PARTITION_KEY: "billId",
  FEEDBACK_TABLE_NAME: "UserFeedback",
  FEEDBACK_PARTITION_KEY: "userId",
  FEEDBACK_SORT_KEY: "billId",
  FEEDBACK_BILL_ID_INDEX_NAME: "GSI_BillIdIndex",
};

/** No vote on any bill. */
const READER = "reader-no-vote";
/** Only 1.0 and 1.1 Updates dismissals (Abstain with legacyDismiss), which are not votes. */
const DISMISSED_READER = "reader-dismissed";
const READERS = [READER, DISMISSED_READER];

type Scenario = "passed" | "failed" | "law" | "updated" | "new" | "passedToo";

const BILLS: Record<Scenario, { guid: string; title: string; billType: string; billNumber: string }> = {
  passed: { guid: "BILLS-119hr2718", title: "Rural Clinic Staffing Act", billType: "hr", billNumber: "2718" },
  failed: { guid: "BILLS-119hr2719", title: "Hospital Price Notice Act", billType: "hr", billNumber: "2719" },
  law: { guid: "BILLS-119hr2720", title: "Community Health Worker Act", billType: "hr", billNumber: "2720" },
  updated: { guid: "BILLS-119hr2721", title: "Nurse Training Grants Act", billType: "hr", billNumber: "2721" },
  new: { guid: "BILLS-119hr2722", title: "Medical Debt Relief Act", billType: "hr", billNumber: "2722" },
  passedToo: { guid: "BILLS-119s611", title: "Senate Clinic Access Act", billType: "s", billNumber: "611" },
};
const SCENARIOS = Object.keys(BILLS) as Scenario[];

// Other users' votes per bill: verified and self-attested [Yea, Nay, Abstain], each count distinctive.
const VOTES: Record<Scenario, Parameters<typeof seedResults>[1]> = {
  passed: { verified: [1817, 609, 166], selfAttested: [1352, 977, 184] },
  failed: { verified: [491, 1346, 138], selfAttested: [884, 1253, 171] },
  law: { verified: [1932, 408, 302], selfAttested: [1275, 339, 157] },
  updated: { verified: [946, 887, 413], selfAttested: [732, 689, 215] },
  new: { verified: [674, 342, 126], selfAttested: [563, 1198, 208] },
  passedToo: { verified: [1381, 726, 249], selfAttested: [907, 458, 142] },
};

const action = (actionDate: string, text: string, actionCode?: string, type = "Floor") => ({
  actionDate,
  text,
  type,
  ...(actionCode ? { actionCode } : {}),
});
const INTRODUCED = action("2026-09-02", "Introduced in House", "1000", "IntroReferral");

/** A processed bill as billSummarizer stores it. */
const processedBill = (scenario: Scenario, overrides: Record<string, unknown> = {}) => {
  const bill = BILLS[scenario];
  return {
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-10-15T12:00:00.000Z",
    identifier: { congress: "119", billType: bill.billType, billNumber: bill.billNumber },
    guid: bill.guid,
    title: bill.title,
    link: `https://www.congress.gov/bill/119th-congress/${bill.billNumber}`,
    soWhat: `${bill.title} changes how clinics are staffed and paid.`,
    billBreakdown: {
      who: "Clinics",
      what: bill.title,
      how: "Grants",
      when: "2027",
      where: "Nationwide",
      why: "Access",
    },
    bodyText: "",
    billXml: "",
    actions: [INTRODUCED],
    committees: [],
    subCategories: ["Healthcare"],
    lifeAreas: ["Medical Costs"],
    sponsors: ["M001190"],
    cosponsors: [],
    billStatus: "New",
    ...overrides,
  };
};

/** Each bill's previous and current stored version: what notificationType compares. */
const VERSIONS: Record<Scenario, Array<Record<string, unknown>>> = {
  passed: [
    processedBill("passed"),
    processedBill("passed", {
      billStatus: "Passed",
      actions: [
        INTRODUCED,
        // Congress's own roll call (not Billboard users' votes) may be quoted; the rule does not cover it.
        action("2026-10-15", "On passage Passed by recorded vote: 245 - 180 (Roll no. 301).", "8000"),
      ],
    }),
  ],
  failed: [
    processedBill("failed"),
    processedBill("failed", {
      billStatus: "Failed",
      actions: [INTRODUCED, action("2026-10-15", "Failed of passage by recorded vote: 190 - 228.", "9000")],
    }),
  ],
  law: [
    processedBill("law", {
      billStatus: "Passed",
      actions: [
        INTRODUCED,
        action("2026-09-20", "Passed/agreed to in House.", "8000"),
        action("2026-10-01", "Passed Senate without amendment by Unanimous Consent.", "17000"),
      ],
    }),
    processedBill("law", {
      billStatus: "Finalized",
      actions: [
        INTRODUCED,
        action("2026-09-20", "Passed/agreed to in House.", "8000"),
        action("2026-10-01", "Passed Senate without amendment by Unanimous Consent.", "17000"),
        action("2026-10-14", "Signed by President.", "36000", "President"),
        action("2026-10-15", "Became Public Law No: 119-41.", "E40000", "BecameLaw"),
      ],
    }),
  ],
  updated: [
    processedBill("updated"),
    // Stored after every reader's vote, so the "vote again" push goes out (UX-33 drops it after a newer vote).
    processedBill("updated", {
      storedAt: "2026-10-20T12:00:00.000Z",
      soWhat: "Nurse Training Grants Act now funds rural residencies too.",
    }),
  ],
  new: [processedBill("new")],
  passedToo: [
    processedBill("passedToo"),
    processedBill("passedToo", {
      billStatus: "Passed",
      actions: [INTRODUCED, action("2026-10-15", "Passed Senate without amendment by Unanimous Consent.", "17000")],
    }),
  ],
};

let seeded: Record<Scenario, SeededResults>;
let allSeeded: SeededResults[];

beforeAll(async () => {
  const entries = await Promise.all(
    SCENARIOS.map(async (scenario) => [scenario, await seedResults(BILLS[scenario].guid, VOTES[scenario])] as const),
  );
  seeded = Object.fromEntries(entries) as Record<Scenario, SeededResults>;
  allSeeded = Object.values(seeded);
});

const endpointArn = (userId: string, device: string) =>
  `arn:aws:sns:us-east-1:123456789012:endpoint/APNS/Billboard/${userId}-${device}`;

/** The world: tables as production keys them, the readers' follows and devices, and every bill's results. */
const buildWorld = (): InMemoryDynamo => {
  const world = new InMemoryDynamo()
    .define("UserPreferences", { partitionKey: "userId", sortKey: "preference" })
    .define(PENDING_TABLE, { partitionKey: "userId", sortKey: "billId" })
    .define("BillPriority", { partitionKey: "guid" })
    .define("UserPii", { partitionKey: "userId" })
    .define("BillsManifest", { partitionKey: "pk", sortKey: "sk" })
    .define("UserDevices", { partitionKey: "userId", sortKey: "deviceId" })
    .define("BillStats", { partitionKey: "billId" })
    .define("UserFeedback", { partitionKey: "userId", sortKey: "billId" });

  for (const userId of READERS) {
    world.put("UserPii", { userId: { S: userId }, adultStatus: { S: "attested_adult" } });
    world.put("UserPreferences", {
      userId: { S: userId },
      preference: { S: "Healthcare" },
      type: { S: "Category" },
      category: { S: "Health" },
    });
    for (const scenario of SCENARIOS) {
      world.put("UserPreferences", {
        userId: { S: userId },
        preference: { S: BILLS[scenario].guid },
        type: { S: "Watch" },
      });
    }
    world.put(
      "UserDevices",
      {
        userId: { S: userId },
        deviceId: { S: "phone" },
        platform: { S: "ios" },
        endpointArn: { S: endpointArn(userId, "phone") },
      },
      {
        userId: { S: userId },
        deviceId: { S: "decisions" },
        platform: { S: "ios" },
        endpointArn: { S: endpointArn(userId, "decisions") },
        notifyNew: { BOOL: false },
        notifyUpdated: { BOOL: false },
        notifyAlert: { BOOL: false },
      },
      {
        userId: { S: userId },
        deviceId: { S: "passed-only" },
        platform: { S: "ios" },
        endpointArn: { S: endpointArn(userId, "passed-only") },
        notifyNew: { BOOL: false },
        notifyUpdated: { BOOL: false },
        notifyAlert: { BOOL: false },
        notifyFailed: { BOOL: false },
      },
      {
        userId: { S: userId },
        deviceId: { S: "actions" },
        platform: { S: "ios" },
        endpointArn: { S: endpointArn(userId, "actions") },
        notifyPassed: { BOOL: false },
        notifyFailed: { BOOL: false },
      },
    );
  }

  for (const scenario of SCENARIOS) {
    const bill = BILLS[scenario];
    const results = seeded[scenario];
    const current = VERSIONS[scenario][VERSIONS[scenario].length - 1];
    const manifestSk = `2026-10-15T12:00:00.000Z#${bill.guid}`;
    world.put(
      "BillsManifest",
      {
        pk: { S: "BILL_GUID" },
        sk: { S: bill.guid },
        manifestSk: { S: manifestSk },
        updatedAt: { S: "2026-10-15T12:00:00.000Z" },
      },
      {
        pk: { S: "BILL" },
        sk: { S: manifestSk },
        guid: { S: bill.guid },
        title: { S: bill.title },
        billType: { S: bill.billType },
        billStatus: { S: String(current.billStatus) },
        updatedAt: { S: "2026-10-15T12:00:00.000Z" },
        // As BillStatsAggregator writes it on every bill's row (prod rows carry it).
        voteCount: { N: String(results.manifestVoteCount) },
        voteCountComputedFrom: { S: "2026-03-12T09:30:00.000Z" },
      },
    );
    world.put("BillStats", results.statsItem);
    world.put("UserFeedback", ...results.feedbackRows);
    world.put("UserFeedback", {
      userId: { S: DISMISSED_READER },
      billId: { S: bill.guid },
      feedback: { S: "Abstain" },
      votedAt: { S: "2026-10-16T08:00:00.000Z" },
      adultEligible: { BOOL: true },
      legacyDismiss: { BOOL: true },
    });
  }
  return world;
};

const buildSqsEvent = (bodies: string[]): SQSEvent => ({
  Records: bodies.map((body, index) => ({
    messageId: `msg-${index}`,
    receiptHandle: `receipt-${index}`,
    body,
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: `${Date.now()}`,
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: `${Date.now()}`,
    },
    messageAttributes: {},
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:queue",
    awsRegion: "us-east-1",
  })),
});

type SqsHandler = (event: SQSEvent) => Promise<{ batchItemFailures: unknown[] }>;
let handlers: {
  notificationType: SqsHandler;
  userMatcher: SqsHandler;
  notificationFanout: SqsHandler;
  userNotifier: SqsHandler;
};
let restoreEnv: (() => void) | undefined;

const loadHandlers = (fanout: boolean) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv(
    { ...ENV, ...(fanout ? { NOTIFICATION_FANOUT_QUEUE_URL: FANOUT_QUEUE } : {}) },
    { replace: true, base: originalEnv },
  );
  jest.resetModules();
  handlers = {
    notificationType: require("../handlers/notificationType").handler,
    userMatcher: require("../handlers/userMatcher").handler,
    notificationFanout: require("../handlers/notificationFanout").handler,
    userNotifier: require("../handlers/userNotifier").handler,
  };
};

const sentBodies = (queueUrl: string): string[] =>
  mockSqsSend.mock.calls
    .map(([command]) => command.input)
    .filter((input) => input.QueueUrl === queueUrl)
    .flatMap((input) => input.Entries.map((entry: { MessageBody: string }) => entry.MessageBody));

interface Push {
  userId: string;
  device: string;
  message: { default: string; APNS: string; APNS_SANDBOX: string };
  apns: { aps: { alert: { title: string; body: string } }; notificationType: string; billIds: string[] };
}

const pushes = (): Push[] =>
  mockSnsSend.mock.calls.map(([command]) => {
    const [, userDevice] = /endpoint\/APNS\/Billboard\/(.+)$/.exec(command.input.TargetArn)!;
    const reader = READERS.find((userId) => userDevice.startsWith(`${userId}-`))!;
    const message = JSON.parse(command.input.Message);
    return { userId: reader, device: userDevice.slice(reader.length + 1), message, apns: JSON.parse(message.APNS) };
  });

/** Fields that hold ids, keys and times, not text or counts. */
const ID_FIELDS = [
  "userId",
  "targetUserId",
  "billId",
  "sourceBillId",
  "objectId",
  "billIds",
  "correlationId",
  "sourceRevision",
  "markerVersion",
  "createdAt",
  "changedAt",
  "changedAtMs",
  "ttl",
  "updatedAtEpoch",
  "actionDate",
  "actionCode",
  "actionType",
];

/**
 * Runs the bills' latest stored versions through notificationType, userMatcher (and notificationFanout)
 * and userNotifier for the readers, checking every stage, and returns the pushes the readers got.
 */
const runPipeline = async (scenarios: Scenario[], fanout: boolean): Promise<Push[]> => {
  mockSqsSend.mockClear();
  mockSnsSend.mockClear();

  for (const scenario of scenarios) {
    const key = `processed-bills/${BILLS[scenario].guid}.json`;
    const versionId = mockS3.current(key)!.versionId;
    expect(await handlers.notificationType(sqsWrappedS3Keys([key], { versionId }))).toEqual({ batchItemFailures: [] });
  }
  const changeMessages = sentBodies(USER_MATCHER_QUEUE);
  expect(changeMessages.length).toBeGreaterThanOrEqual(scenarios.length);
  expect(findResultLeaks(changeMessages, allSeeded, { ignoreFields: ID_FIELDS })).toEqual([]);

  expect(await handlers.userMatcher(buildSqsEvent(changeMessages))).toEqual({ batchItemFailures: [] });
  if (fanout) {
    const fanoutMessages = sentBodies(FANOUT_QUEUE);
    expect(fanoutMessages.length).toBeGreaterThan(0);
    expect(findResultLeaks(fanoutMessages, allSeeded, { ignoreFields: [...ID_FIELDS, "userIds"] })).toEqual([]);
    expect(await handlers.notificationFanout(buildSqsEvent(fanoutMessages))).toEqual({ batchItemFailures: [] });
  } else {
    expect(sentBodies(FANOUT_QUEUE)).toEqual([]);
  }

  // The pending rows, dedupe markers and dispatch markers userNotifier works from.
  const pendingTable = mockDynamo.rows(PENDING_TABLE);
  const pendingRows = pendingTable.filter((row) => row.billTitle !== undefined);
  for (const userId of READERS) {
    expect(pendingRows.filter((row) => row.userId.S === userId).length).toBeGreaterThan(0);
  }
  expect(findResultLeaks(pendingTable, allSeeded, { ignoreFields: ID_FIELDS })).toEqual([]);

  expect(await handlers.userNotifier(buildSqsEvent([JSON.stringify({ userIds: READERS })]))).toEqual({
    batchItemFailures: [],
  });
  const sent = pushes();
  expect(
    findResultLeaks(
      sent.map((push) => push.message),
      allSeeded,
      { ignoreFields: ID_FIELDS },
    ),
  ).toEqual([]);
  // Every pending row was delivered and removed, so the next run starts clean.
  expect(mockDynamo.rows(PENDING_TABLE).filter((row) => row.billTitle !== undefined)).toEqual([]);
  return sent;
};

/**
 * What each reader's device was shown: { device: "title | body" }, or the pushes in order when a device got more than
 * one (an "updated" push goes on its own, S5); the same for both readers.
 */
const shownByDevice = (sent: Push[]): Record<string, string | string[]> => {
  const shown: Record<string, string | string[]> = {};
  for (const userId of READERS) {
    const mine: Record<string, string[]> = {};
    for (const push of sent.filter((entry) => entry.userId === userId)) {
      (mine[push.device] ??= []).push(`${push.apns.aps.alert.title} | ${push.apns.aps.alert.body}`);
    }
    const flat = Object.fromEntries(
      Object.entries(mine).map(([device, lines]) => [device, lines.length === 1 ? lines[0] : lines]),
    );
    if (userId === READERS[0]) Object.assign(shown, flat);
    else expect(flat).toEqual(shown);
  }
  return shown;
};

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "info").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  mockSqsSend.mockReset();
  mockSqsSend.mockImplementation(async (command: { input: { Entries: Array<{ Id: string }> } }) => ({
    Successful: command.input.Entries.map((entry) => ({ Id: entry.Id, MessageId: `m-${entry.Id}` })),
    Failed: [],
  }));
  mockSnsSend.mockReset();
  mockSnsSend.mockResolvedValue({ MessageId: "sns-message" });

  mockDynamo = buildWorld();
  mockS3 = new FakeVersionedS3("2026-10-15T12:00:00.000Z");
  for (const scenario of SCENARIOS) {
    for (const version of VERSIONS[scenario]) {
      const key = `processed-bills/${BILLS[scenario].guid}.json`;
      // A version stored later than the others (the updated bill's new summary, after every reader's vote, so its
      // "vote again" push goes out: UX-33 drops one after a newer vote) is written at its storedAt.
      const storedAt = (version as { storedAt?: string }).storedAt;
      if (storedAt && storedAt > "2026-10-15T12:00:00.000Z") mockS3.putAt(key, version, storedAt);
      else mockS3.put(key, version);
    }
  }
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

describe("INT-11 Q6: push notifications carry no results for a bill the reader has not voted on", () => {
  it("the seeded results are where the results code reads them, and the readers hold no vote", async () => {
    // GET /bill-stats would serve these numbers to a voter: the check below is looking for real results.
    const { readCachedStats } = require("../shared/billStats");
    const stats = await readCachedStats({
      db: mockDynamo,
      statsTableName: "BillStats",
      statsPartitionKey: "billId",
      billId: BILLS.passed.guid,
    });
    expect(stats.totals).toMatchObject({ yea: 1817 + 1352, nay: 609 + 977, abstain: 166 + 184 });
    expect(stats.reasonBreakdown.yea.reasons.length).toBeGreaterThan(0);
    expect(findResultLeaks(stats, allSeeded).length).toBeGreaterThan(0);

    const { unlocksResults } = require("../models/feedback");
    const readerRows = mockDynamo.rows("UserFeedback").filter((row) => READERS.includes(row.userId.S!));
    expect(readerRows.map((row) => row.userId.S)).toEqual(SCENARIOS.map(() => DISMISSED_READER));
    expect(readerRows.some((row: Item) => unlocksResults(row))).toBe(false);
  });

  describe.each([
    ["userMatcher writes the rows (fan-out off)", false],
    ["notificationFanout writes the rows (CAP-02 fan-out on)", true],
  ])("%s", (_label, fanout) => {
    beforeEach(() => loadHandlers(fanout));

    // S4: the action pushes name the action and its date. UX-33 ("one event, per phone"): the passed and failed bills'
    // versions write each reader (a watcher) the action's row beside the outcome's; a device that takes the outcome
    // gets the outcome push, the device with passed and failed off gets the action push, and none gets both.
    it.each<[Scenario, Record<string, string>]>([
      [
        "new",
        {
          phone: "New: Medical Debt Relief Act | A new bill matched your interests.",
          actions: "New: Medical Debt Relief Act | A new bill matched your interests.",
        },
      ],
      [
        "updated",
        {
          phone: "Updated: Nurse Training Grants Act | Open Billboard to see what changed.",
          actions: "Updated: Nurse Training Grants Act | Open Billboard to see what changed.",
        },
      ],
      [
        "law",
        {
          // REL-44: a law line reads "Became law", the label both apps give Finalized.
          phone: "Action: Community Health Worker Act | Became law · Oct 15",
          actions: "Action: Community Health Worker Act | Became law · Oct 15",
        },
      ],
      [
        "passed",
        {
          phone: "Passed: Rural Clinic Staffing Act | Passed the House · Oct 15",
          decisions: "Passed: Rural Clinic Staffing Act | Passed the House · Oct 15",
          "passed-only": "Passed: Rural Clinic Staffing Act | Passed the House · Oct 15",
          actions: "Action: Rural Clinic Staffing Act | Passed the House · Oct 15",
        },
      ],
      [
        "failed",
        {
          phone: "Failed: Hospital Price Notice Act | Failed in the House · Oct 15",
          decisions: "Failed: Hospital Price Notice Act | Failed in the House · Oct 15",
          actions: "Action: Hospital Price Notice Act | Failed in the House · Oct 15",
        },
      ],
    ])("the %s bill's push", async (scenario, expected) => {
      const sent = await runPipeline([scenario], fanout);

      expect(shownByDevice(sent)).toEqual(expected);
      for (const push of sent) {
        expect(push.apns.billIds).toEqual([BILLS[scenario].guid]);
        expect(push.message.APNS_SANDBOX).toBe(push.message.APNS);
      }
    });

    it("a week's pushes at once: the mixed digest, the decided-bills digest and the same-type digest", async () => {
      const sent = await runPipeline(SCENARIOS, fanout);

      expect(shownByDevice(sent)).toEqual({
        // The action of the bill that became law; each passed or failed bill's change counts once, as its outcome on a
        // device that takes it (UX-33, "one event, per phone"), so its action is not counted twice.
        phone: [
          "5 Bill Updates | 1 new, 1 action, 2 passed, 1 failed",
          "Updated: Nurse Training Grants Act | Open Billboard to see what changed.",
        ],
        decisions: "3 Bill Updates | 2 passed, 1 failed",
        "passed-only": "2 Bills Passed | Includes Rural Clinic Staffing Act and Senate Clinic Access Act.",
        // The passed and failed bills' changes as their actions, on the device with those outcomes off.
        actions: [
          "5 Bill Updates | 1 new, 4 actions",
          "Updated: Nurse Training Grants Act | Open Billboard to see what changed.",
        ],
      });
      // Each reader's phone: the digest, then the updated bill's own push.
      const phonePushes = sent.filter((entry) => entry.device === "phone").map((push) => push.apns);
      const readerPhonePushes = [
        expect.objectContaining({ notificationType: "digest", billCount: 5 }),
        expect.objectContaining({ notificationType: "updated", billIds: [BILLS.updated.guid] }),
      ];
      expect(phonePushes).toEqual([...readerPhonePushes, ...readerPhonePushes]);
      for (const push of sent.filter((entry) => entry.device === "passed-only")) {
        expect(push.apns).toMatchObject({ notificationType: "passed", billCount: 2 });
      }
      // UX-33: before an "updated" push, userNotifier reads the time of the reader's own vote on that bill, never a
      // vote and never another user's row (UserFeedback holds every user's votes here).
      const feedbackReads = mockDynamo.commands.filter((command) => command.input?.TableName === "UserFeedback");
      expect(feedbackReads.map(({ name, input }) => [name, input.Key!.userId.S, input.Key!.billId.S])).toEqual(
        READERS.map((reader) => ["GetItemCommand", reader, BILLS.updated.guid]),
      );
      for (const { input } of feedbackReads) expect(input.ProjectionExpression).toBe("votedAt");
    });
  });
});
