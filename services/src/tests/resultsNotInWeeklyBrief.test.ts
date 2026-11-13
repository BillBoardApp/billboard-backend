/**
 * INT-11, question Q6 (2026-10-17): the Weekly Brief carries no other users' vote counts,
 * percentages, abstentions or reasons for a bill the reader has not voted on.
 *
 * The Brief is generated on the server (generateWeeklyDigests inline, or weeklyDigestWorker for the
 * planner's messages), stored as one snapshot per user and served as is by GET /weekly-digest/latest.
 * The server sends no push and no email for it: its only texts are the snapshot's. Generation reads
 * the BillsManifest rows in full, and every production row still carries the voteCount
 * BillStatsAggregator writes, so these tests seed it there, and seed the bills' BillStats rows and
 * other users' UserFeedback rows too (with the environment names the results code reads), then
 * generate and serve the Brief for readers who have not voted on any of its bills: one with no rows,
 * one with only 1.0 and 1.1 Updates dismissals. The decided bills (Passed, Failed, Became law) are
 * in it.
 */
import type { SQSEvent } from "aws-lambda";
import { FakeVersionedS3 } from "./fakeVersionedS3";
import { applyTestEnv } from "./fixtures/env";
import { findResultLeaks, InMemoryDynamo, seedResults, type SeededResults } from "./fixtures/resultsWorld";
import { WEEKLY_DIGEST_TEST_ENV, WEEKLY_DIGEST_TEST_NOW, WEEKLY_DIGEST_TEST_WINDOW_ID } from "./fixtures/weeklyDigest";

let mockS3: FakeVersionedS3;
let mockDynamo: InMemoryDynamo;
const mockSqsSend = jest.fn();
const mockSnsSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: (command: never) => mockDynamo.send(command) })),
}));
jest.mock("@aws-sdk/client-cloudwatch", () => ({
  ...jest.requireActual("@aws-sdk/client-cloudwatch"),
  CloudWatchClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
}));
jest.mock("@aws-sdk/client-sqs", () => ({
  ...jest.requireActual("@aws-sdk/client-sqs"),
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
}));
jest.mock("@aws-sdk/client-sns", () => ({
  ...jest.requireActual("@aws-sdk/client-sns"),
  SNSClient: jest.fn(() => ({ send: mockSnsSend })),
}));

const ENV: Record<string, string> = {
  ...WEEKLY_DIGEST_TEST_ENV,
  // Where the results live, under the names shared/billStats and GET /bill-stats read them by.
  STATS_TABLE_NAME: "BillStats",
  STATS_PARTITION_KEY: "billId",
  FEEDBACK_BILL_ID_INDEX_NAME: "GSI_BillIdIndex",
};
const DIGEST_TABLE = ENV.TABLE_NAME;
const FEEDBACK_TABLE = ENV.FEEDBACK_TABLE_NAME;

/** No vote on any bill. */
const READER = "reader-no-vote";
/** Only 1.0 and 1.1 Updates dismissals (Abstain with legacyDismiss) on the Passed and Failed bills. */
const DISMISSED_READER = "reader-dismissed";
const READERS = [READER, DISMISSED_READER];

type Scenario = "passed" | "failed" | "law" | "updated" | "new" | "rep" | "quick";

interface DigestBill {
  guid: string;
  title: string;
  billType: string;
  billNumber: string;
  billStatus: string;
  updatedAt: string;
  sponsors: string[];
  subCategories: string[];
  lifeAreas: string[];
}

// Each moved in the Brief's week (Mar 15-21, 2026) and matches the reader's follows, so every section has a bill.
const BILLS: Record<Scenario, DigestBill> = {
  passed: {
    guid: "BILLS-119hr3301",
    title: "Clean Water Grants Act",
    billType: "hr",
    billNumber: "3301",
    billStatus: "Passed",
    updatedAt: "2026-03-19T15:00:00.000Z",
    sponsors: ["B000111"],
    subCategories: ["Energy"],
    lifeAreas: [],
  },
  failed: {
    guid: "BILLS-119hr3302",
    title: "Grid Repair Loans Act",
    billType: "hr",
    billNumber: "3302",
    billStatus: "Failed",
    updatedAt: "2026-03-18T15:00:00.000Z",
    sponsors: ["B000111"],
    subCategories: ["Energy"],
    lifeAreas: [],
  },
  // Became law: the reader watches it.
  law: {
    guid: "BILLS-119hr3303",
    title: "Home Heating Aid Act",
    billType: "hr",
    billNumber: "3303",
    billStatus: "Finalized",
    updatedAt: "2026-03-20T15:00:00.000Z",
    sponsors: ["B000111"],
    subCategories: ["Energy"],
    lifeAreas: [],
  },
  updated: {
    guid: "BILLS-119hr3304",
    title: "Solar Permits Act",
    billType: "hr",
    billNumber: "3304",
    billStatus: "Updated",
    updatedAt: "2026-03-17T15:00:00.000Z",
    sponsors: ["B000111"],
    subCategories: ["Energy"],
    lifeAreas: [],
  },
  new: {
    guid: "BILLS-119hr3305",
    title: "Pipeline Safety Act",
    billType: "hr",
    billNumber: "3305",
    billStatus: "New",
    updatedAt: "2026-03-16T15:00:00.000Z",
    sponsors: ["B000111"],
    // Matched only by the reader's life area.
    subCategories: ["Transportation"],
    lifeAreas: ["Utility Bills"],
  },
  // Sponsored by the member the reader follows.
  rep: {
    guid: "BILLS-119s880",
    title: "Energy Jobs Training Act",
    billType: "s",
    billNumber: "880",
    billStatus: "New",
    updatedAt: "2026-03-21T12:00:00.000Z",
    sponsors: ["A000360"],
    subCategories: ["Energy"],
    lifeAreas: [],
  },
  // A fourth bill in the tracked topic that moved: Worth A Quick Look.
  quick: {
    guid: "BILLS-119hr3306",
    title: "Battery Recycling Act",
    billType: "hr",
    billNumber: "3306",
    billStatus: "New",
    updatedAt: "2026-03-15T15:00:00.000Z",
    sponsors: ["B000111"],
    subCategories: ["Energy"],
    lifeAreas: [],
  },
};
const SCENARIOS = Object.keys(BILLS) as Scenario[];

// Other users' votes per bill: verified and self-attested [Yea, Nay, Abstain], each count distinctive.
const VOTES: Record<Scenario, Parameters<typeof seedResults>[1]> = {
  passed: { verified: [1729, 583, 214], selfAttested: [1146, 865, 193] },
  failed: { verified: [622, 1489, 157], selfAttested: [911, 1377, 164] },
  law: { verified: [2047, 451, 268], selfAttested: [1318, 394, 177] },
  updated: { verified: [1093, 1006, 382], selfAttested: [787, 741, 229] },
  new: { verified: [703, 376, 131], selfAttested: [598, 1214, 211] },
  rep: { verified: [1462, 818, 233], selfAttested: [934, 517, 148] },
  quick: { verified: [839, 1271, 196], selfAttested: [1058, 664, 187] },
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

const list = (values: string[]) => ({ L: values.map((value) => ({ S: value })) });

const buildWorld = (): InMemoryDynamo => {
  const world = new InMemoryDynamo()
    .define(DIGEST_TABLE, { partitionKey: "userId", sortKey: "publishedAt" })
    .define(ENV.PII_TABLE_NAME, { partitionKey: "userId" })
    .define(ENV.PREFERENCES_TABLE_NAME, { partitionKey: "userId", sortKey: "preference" })
    .define(FEEDBACK_TABLE, { partitionKey: "userId", sortKey: "billId" })
    .define(ENV.MANIFEST_TABLE_NAME, { partitionKey: "pk", sortKey: "sk" })
    .define(ENV.CONGRESS_MEMBERS_TABLE_NAME, { partitionKey: "bioguideId" })
    .define("BillStats", { partitionKey: "billId" });

  world.put(
    ENV.CONGRESS_MEMBERS_TABLE_NAME,
    {
      bioguideId: { S: "A000360" },
      name: { S: "Rep. Alice Example" },
      chamber: { S: "House" },
      state: { S: "CA" },
      party: { S: "D" },
      district: { S: "12" },
      depictionImageUrl: { NULL: true },
      updatedAt: { S: "2026-03-01T00:00:00.000Z" },
    },
    {
      bioguideId: { S: "B000111" },
      name: { S: "Rep. Bob Sample" },
      chamber: { S: "House" },
      state: { S: "TX" },
      party: { S: "R" },
      district: { S: "7" },
      depictionImageUrl: { NULL: true },
      updatedAt: { S: "2026-03-01T00:00:00.000Z" },
    },
  );

  for (const userId of READERS) {
    world.put(ENV.PII_TABLE_NAME, { userId: { S: userId }, adultStatus: { S: "attested_adult" } });
    world.put(
      ENV.PREFERENCES_TABLE_NAME,
      { userId: { S: userId }, preference: { S: "Energy" }, type: { S: "Category" } },
      { userId: { S: userId }, preference: { S: BILLS.law.guid }, type: { S: "Watch" } },
      { userId: { S: userId }, preference: { S: "A000360" }, type: { S: "Congress Member" } },
      { userId: { S: userId }, preference: { S: "Utility Bills" }, type: { S: "Life Area" } },
    );
  }
  // What 1.0 and 1.1 store when the user dismisses a Passed or Failed bill in Updates: not a vote.
  for (const scenario of ["passed", "failed"] as const) {
    world.put(FEEDBACK_TABLE, {
      userId: { S: DISMISSED_READER },
      billId: { S: BILLS[scenario].guid },
      feedback: { S: "Abstain" },
      votedAt: { S: "2026-03-20T08:00:00.000Z" },
      adultEligible: { BOOL: true },
      legacyDismiss: { BOOL: true },
    });
  }

  for (const scenario of SCENARIOS) {
    const bill = BILLS[scenario];
    const results = seeded[scenario];
    world.put(ENV.MANIFEST_TABLE_NAME, {
      pk: { S: "BILL" },
      sk: { S: `${bill.updatedAt}#${bill.guid}` },
      guid: { S: bill.guid },
      billType: { S: bill.billType },
      congress: { S: "119" },
      billNumber: { S: bill.billNumber },
      updatedAt: { S: bill.updatedAt },
      title: { S: bill.title },
      subCategories: list(bill.subCategories),
      lifeAreas: list(bill.lifeAreas),
      sponsors: list(bill.sponsors),
      cosponsors: list([]),
      billStatus: { S: bill.billStatus },
      // As BillStatsAggregator writes it on every bill's row (prod rows carry it).
      voteCount: { N: String(results.manifestVoteCount) },
      voteCountComputedFrom: { S: "2026-03-12T09:30:00.000Z" },
    });
    world.put("BillStats", results.statsItem);
    world.put(FEEDBACK_TABLE, ...results.feedbackRows);
  }
  return world;
};

const processedBill = (bill: DigestBill) => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt: bill.updatedAt,
  identifier: { congress: "119", billType: bill.billType, billNumber: bill.billNumber },
  guid: bill.guid,
  title: bill.title,
  link: `https://www.congress.gov/bill/119th-congress/${bill.billNumber}`,
  soWhat: `${bill.title} changes how home energy is paid for.`,
  summary: `${bill.title} funds energy work.`,
  billBreakdown: {
    who: "Households",
    what: bill.title,
    how: "Grants",
    when: "2027",
    where: "Nationwide",
    why: "Costs",
  },
  subCategories: bill.subCategories,
  lifeAreas: bill.lifeAreas,
  sponsors: bill.sponsors,
  cosponsors: [],
  // Congress's own roll call (not Billboard users' votes) may be quoted; the rule does not cover it.
  actions: [{ actionDate: bill.updatedAt, text: "On passage Passed by recorded vote: 245 - 180 (Roll no. 301)." }],
  committees: [],
  billStatus: bill.billStatus,
});

type DigestItem = { billGuid?: string; reason?: string; kind: string; title: string };
type Digest = {
  title: string;
  summary: string;
  stats: Array<{ id: string; label: string; value: string }>;
  sections: Array<{ kind: string; title: string; items: DigestItem[] }>;
};

/** Fields that hold ids, keys and times, not text or counts. */
const ID_FIELDS = [
  "userId",
  "id",
  "billGuid",
  "primaryMemberBioguideId",
  "publishedAt",
  "weekStart",
  "weekEnd",
  "createdAt",
  "ttl",
];

let restoreEnv: (() => void) | undefined;

beforeEach(() => {
  jest.useFakeTimers({ advanceTimers: true });
  jest.setSystemTime(new Date(WEEKLY_DIGEST_TEST_NOW));
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "info").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
  mockSqsSend.mockReset();
  mockSnsSend.mockReset();

  mockDynamo = buildWorld();
  mockS3 = new FakeVersionedS3("2026-03-20T00:00:00.000Z");
  for (const bill of Object.values(BILLS)) mockS3.put(`processed-bills/${bill.guid}.json`, processedBill(bill));

  restoreEnv = applyTestEnv(ENV, { replace: true });
  jest.resetModules();
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const workerEvent = (userIds: string[]): SQSEvent =>
  ({
    Records: [
      {
        messageId: "work-1",
        body: JSON.stringify({ windowId: WEEKLY_DIGEST_TEST_WINDOW_ID, userIds }),
        messageAttributes: {},
      },
    ],
  }) as unknown as SQSEvent;

describe("INT-11 Q6: the Weekly Brief carries no results for a bill the reader has not voted on", () => {
  it("the seeded results are where the results code reads them, and the readers hold no vote", async () => {
    const { readCachedStats } = require("../shared/billStats");
    const stats = await readCachedStats({
      db: mockDynamo,
      statsTableName: "BillStats",
      statsPartitionKey: "billId",
      billId: BILLS.passed.guid,
    });
    expect(stats.totals).toMatchObject({ yea: 1729 + 1146, nay: 583 + 865, abstain: 214 + 193 });
    expect(findResultLeaks(stats, allSeeded).length).toBeGreaterThan(0);

    const { unlocksResults } = require("../models/feedback");
    const readerRows = mockDynamo.rows(FEEDBACK_TABLE).filter((row) => READERS.includes(row.userId.S!));
    expect(readerRows).toHaveLength(2);
    expect(readerRows.some((row) => unlocksResults(row))).toBe(false);
  });

  it.each([
    ["the Sunday run (generateWeeklyDigests, inline)", "inline"],
    ["the planner's work messages (weeklyDigestWorker)", "worker"],
  ])("%s, and GET /weekly-digest/latest serving it", async (_label, path) => {
    if (path === "inline") {
      const response = await require("../handlers/generateWeeklyDigests").handler({});
      expect(JSON.parse(response.body)).toMatchObject({ userCount: 2, stored: 2, failed: 0 });
    } else {
      const response = await require("../handlers/weeklyDigestWorker").handler(workerEvent(READERS));
      expect(response).toEqual({ batchItemFailures: [] });
    }

    // The stored snapshots: everything the Brief shows.
    const stored = mockDynamo.rows(DIGEST_TABLE);
    expect(stored.map((row) => row.userId.S).sort()).toEqual([...READERS].sort());
    expect(findResultLeaks(stored, allSeeded, { ignoreFields: ID_FIELDS })).toEqual([]);

    const { handler: fetchLatest } = require("../handlers/fetchLatestWeeklyDigest");
    for (const userId of READERS) {
      const served = await fetchLatest({ requestContext: { authorizer: { jwt: { claims: { sub: userId } } } } });
      expect(served.statusCode).toBe(200);
      expect(findResultLeaks(JSON.parse(served.body), allSeeded, { ignoreFields: ID_FIELDS })).toEqual([]);

      const digest: Digest = JSON.parse(served.body);
      const items = digest.sections.flatMap((section) =>
        section.items.map((item) => ({ ...item, section: section.kind })),
      );
      expect(digest.sections.map((section) => section.kind)).toEqual([
        "needs_attention",
        "moved_this_week",
        "representatives",
        "worth_quick_look",
      ]);
      // The decided bills are in it: Passed, Failed and Became law, none of them voted on.
      expect(items.filter((item) => item.section === "needs_attention").map((item) => item.billGuid)).toEqual([
        BILLS.law.guid,
        BILLS.passed.guid,
        BILLS.failed.guid,
      ]);
      expect(items.map((item) => item.billGuid)).toEqual(
        expect.arrayContaining(SCENARIOS.map((scenario) => BILLS[scenario].guid)),
      );
      expect(items.map((item) => item.reason)).not.toContain("You voted on this before");
      // The Brief's own figures count its sections' items, nothing else.
      const sectionSize = (kind: string) => digest.sections.find((section) => section.kind === kind)?.items.length ?? 0;
      expect(digest.stats).toEqual([
        {
          id: "attention",
          label: "Need attention",
          value: String(sectionSize("needs_attention")),
          accent: "attention",
        },
        {
          id: "representatives",
          label: "Members active",
          value: String(sectionSize("representatives")),
          accent: "representative",
        },
        { id: "quicklook", label: "Worth a look", value: String(sectionSize("worth_quick_look")), accent: "discovery" },
      ]);
    }

    // The server sends the Brief with no push and no email. A change that adds one must check its text here too.
    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});

/**
 * The builder itself (S2, 2026-10-28: items now quote Congress's actions, name members' bills and count the
 * sections). Its inputs here hold other users' results: every manifest row keeps its voteCount, as the type
 * allows, and every processed bill carries the bill's results under keys a future field might use. The reader
 * voted on two bills, follows both members, watches the law and follows the topic and life area, so both of the
 * reader's own vote reasons, a member naming several bills and every new kind of text are produced.
 */
describe("INT-11 Q6: the Weekly Brief builder writes no results, even when its inputs hold them", () => {
  it("for a reader who voted on some of the bills and not on others", async () => {
    const { buildWeeklyDigest } = require("../shared/weeklyDigestBuilder");
    const { latestPublishedWindow } = require("../shared/weeklyDigestSchedule");
    const votedOn = [BILLS.passed.guid, BILLS.updated.guid];
    const scenarioOf = (guid: string) => SCENARIOS.find((scenario) => BILLS[scenario].guid === guid)!;

    const digest = await buildWeeklyDigest({
      window: latestPublishedWindow(new Date(WEEKLY_DIGEST_TEST_NOW)),
      preferences: {
        trackedTopics: ["Energy"],
        trackedLifeAreas: ["Utility Bills"],
        followedMembers: ["A000360", "B000111"],
        watchedBillGuids: [BILLS.law.guid],
        selectedBillContentTypes: [],
      },
      voteStatesByBillId: new Map(votedOn.map((billId) => [billId.toLowerCase(), { billId, feedback: "Yea" }])),
      manifestItems: SCENARIOS.map((scenario) => ({
        ...BILLS[scenario],
        congress: "119",
        cosponsors: [],
        voteCount: seeded[scenario].manifestVoteCount,
      })),
      memberNameById: new Map([
        ["A000360", "Rep. Alice Example"],
        ["B000111", "Rep. Bob Sample"],
      ]),
      loadProcessedBill: async (item: { guid: string }) => {
        const results = seeded[scenarioOf(item.guid)];
        return {
          ...processedBill(BILLS[scenarioOf(item.guid)]),
          stats: results.stats,
          totals: results.rawStats.totals,
        };
      },
    });

    const items: DigestItem[] = digest.sections.flatMap((section: Digest["sections"][number]) => section.items);
    // Both members are on every bill but the quick-look one, so it has none (its items are bill items too).
    expect(digest.sections.map((section: Digest["sections"][number]) => section.kind)).toEqual([
      "needs_attention",
      "moved_this_week",
      "representatives",
    ]);
    expect(items.filter((item) => item.kind === "member").map((item) => item.title)).toEqual([
      "Rep. Bob Sample",
      "Rep. Alice Example",
    ]);

    // The reader's own votes show only as the two fixed reasons, and only on the bills they voted on.
    const ownVoteReasons = new Set(["You voted on this", "You voted on this before"]);
    const voteReasons = items.filter((item) => ownVoteReasons.has(item.reason ?? ""));
    expect(voteReasons.map((item) => [item.billGuid, item.reason]).sort()).toEqual(
      [
        [BILLS.passed.guid, "You voted on this"],
        [BILLS.updated.guid, "You voted on this before"],
      ].sort(),
    );

    // Everything else, the reasons above aside: no seeded count or percentage, no results key or wording.
    const withoutOwnVoteReasons = {
      ...digest,
      sections: digest.sections.map((section: Digest["sections"][number]) => ({
        ...section,
        items: section.items.map((item) => (ownVoteReasons.has(item.reason ?? "") ? { ...item, reason: "" } : item)),
      })),
    };
    expect(findResultLeaks(withoutOwnVoteReasons, allSeeded, { ignoreFields: ID_FIELDS })).toEqual([]);
  });
});
