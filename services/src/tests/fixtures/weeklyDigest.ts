/**
 * Shared data and AWS SDK routing for the weekly digest tests (generateWeeklyDigests and
 * weeklyDigestWorker). The tests mock the DynamoDB and S3 clients with command objects shaped
 * `{ __type, input }`; these helpers answer those commands from the fixtures below.
 */

import type { MetricDatum, PutMetricDataCommandInput } from "@aws-sdk/client-cloudwatch";
import type { GetObjectCommandInput } from "@aws-sdk/client-s3";

/** A command as the tests' mocked SDK constructors build it. */
interface MockedCommand<Input> {
  __type: string;
  input?: Input;
}

/** "Now" in the tests: the release instant of the Sunday 2026-03-22 window. */
export const WEEKLY_DIGEST_TEST_NOW = "2026-03-22T14:00:00.000Z";
export const WEEKLY_DIGEST_TEST_WINDOW_ID = "2026-03-22T14:00:00.000Z";
/** The window before it. */
export const WEEKLY_DIGEST_PREVIOUS_WINDOW_ID = "2026-03-15T14:00:00.000Z";

export const WEEKLY_DIGEST_TEST_ENV: Record<string, string> = {
  TABLE_NAME: "weekly-digests-table",
  PARTITION_KEY: "userId",
  SORT_KEY: "publishedAt",
  PII_TABLE_NAME: "pii-table",
  PII_PARTITION_KEY: "userId",
  PREFERENCES_TABLE_NAME: "preferences-table",
  PREFERENCES_PARTITION_KEY: "userId",
  PREFERENCES_SORT_KEY: "preference",
  FEEDBACK_TABLE_NAME: "feedback-table",
  FEEDBACK_PARTITION_KEY: "userId",
  FEEDBACK_SORT_KEY: "billId",
  MANIFEST_TABLE_NAME: "bill-manifest-table",
  MANIFEST_PRIMARY_KEY: "pk",
  MANIFEST_PK_VALUE: "BILL",
  MANIFEST_SORT_KEY: "sk",
  CONGRESS_MEMBERS_TABLE_NAME: "members-table",
  CONGRESS_MEMBERS_PRIMARY_KEY: "bioguideId",
  BUCKET_NAME: "test-bucket",
  CANONICAL_PUBLISH_TIMEZONE: "America/New_York",
  CANONICAL_PUBLISH_HOUR: "10",
  CANONICAL_PUBLISH_MINUTE: "0",
};

const manifestRows = [
  {
    guid: "BILLS-119hr21ih",
    billType: "hr",
    congress: "119",
    billNumber: "21",
    updatedAt: "2026-03-18T15:00:00.000Z",
    title: "Current Watch Bill",
    subCategories: ["Energy"],
    lifeAreas: ["Taxes"],
    sponsors: ["A000360"],
    cosponsors: [],
    billStatus: "Updated",
  },
  {
    guid: "BILLS-119hr22ih",
    billType: "hr",
    congress: "119",
    billNumber: "22",
    updatedAt: "2026-03-19T15:00:00.000Z",
    title: "Tracked Passed Bill",
    subCategories: ["Energy"],
    lifeAreas: ["Taxes"],
    sponsors: ["B000111"],
    cosponsors: [],
    billStatus: "Passed",
  },
  {
    guid: "BILLS-119hr23ih",
    billType: "hr",
    congress: "119",
    billNumber: "23",
    updatedAt: "2026-03-20T15:00:00.000Z",
    title: "Quick Look Bill",
    subCategories: ["Energy"],
    lifeAreas: ["Taxes"],
    sponsors: ["C000222"],
    cosponsors: [],
    billStatus: "New",
  },
];

/** The processed-bill S3 keys the fixtures hold, one per manifest bill. */
export const PROCESSED_BILL_KEYS = [
  "processed-bills/BILLS-119hr21.json",
  "processed-bills/BILLS-119hr22.json",
  "processed-bills/BILLS-119hr23.json",
];

export const processedBillsByKey: Record<string, Record<string, unknown>> = {
  "processed-bills/BILLS-119hr21.json": {
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-03-18T15:00:00.000Z",
    identifier: { congress: "119", billType: "hr", billNumber: "21" },
    guid: "BILLS-119hr21ih",
    title: "Current Watch Bill",
    link: "https://example.com/bills/21",
    soWhat: "The watched bill changed this week.",
    summary: "A watched bill moved this week.",
    billBreakdown: { who: "People", what: "Current week watch item", how: "", when: "", where: "", why: "" },
    subCategories: ["Energy"],
    lifeAreas: ["Taxes"],
    sponsors: ["A000360"],
    cosponsors: [],
    actions: [{ actionDate: "2026-03-18T15:00:00.000Z", text: "Committee reported the bill." }],
    committees: [],
    billStatus: "Updated",
  },
  "processed-bills/BILLS-119hr22.json": {
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-03-19T15:00:00.000Z",
    identifier: { congress: "119", billType: "hr", billNumber: "22" },
    guid: "BILLS-119hr22ih",
    title: "Tracked Passed Bill",
    link: "https://example.com/bills/22",
    soWhat: "A tracked-area bill passed.",
    summary: "A tracked-area bill passed.",
    billBreakdown: { who: "People", what: "Current week passed item", how: "", when: "", where: "", why: "" },
    subCategories: ["Energy"],
    lifeAreas: ["Taxes"],
    sponsors: ["B000111"],
    cosponsors: [],
    actions: [{ actionDate: "2026-03-19T15:00:00.000Z", text: "Passed the House." }],
    committees: [],
    billStatus: "Passed",
  },
  "processed-bills/BILLS-119hr23.json": {
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-03-20T15:00:00.000Z",
    identifier: { congress: "119", billType: "hr", billNumber: "23" },
    guid: "BILLS-119hr23ih",
    title: "Quick Look Bill",
    link: "https://example.com/bills/23",
    soWhat: "A fresh bill in your tracked area.",
    summary: "A fresh bill worth a look.",
    billBreakdown: { who: "People", what: "Current week discovery item", how: "", when: "", where: "", why: "" },
    subCategories: ["Energy"],
    lifeAreas: ["Taxes"],
    sponsors: ["C000222"],
    cosponsors: [],
    actions: [{ actionDate: "2026-03-20T15:00:00.000Z", text: "Introduced in the House." }],
    committees: [],
    billStatus: "New",
  },
};

/** Every user in the fixtures has these preferences, so every digest needs all three bills. */
export const preferencesItems = [
  {
    preference: { S: "BILLS-119hr21ih" },
    type: { S: "Watch" },
  },
  {
    preference: { S: "A000360" },
    type: { S: "Congress Member" },
  },
  {
    preference: { S: "Energy" },
    type: { S: "Category" },
    category: { S: "Environmental and Energy Policy" },
  },
  {
    preference: { S: "Taxes" },
    type: { S: "Life Area" },
  },
  {
    preference: { S: "bills" },
    type: { S: "Content Type" },
  },
];

export function buildManifestDdbRows() {
  return manifestRows.map((row) => ({
    guid: { S: row.guid },
    billType: { S: row.billType },
    congress: { S: row.congress },
    billNumber: { S: row.billNumber },
    updatedAt: { S: row.updatedAt },
    title: { S: row.title },
    subCategories: { L: row.subCategories.map((value) => ({ S: value })) },
    lifeAreas: { L: row.lifeAreas.map((value) => ({ S: value })) },
    sponsors: { L: row.sponsors.map((value) => ({ S: value })) },
    cosponsors: { L: row.cosponsors.map((value) => ({ S: value })) },
    billStatus: { S: row.billStatus },
  }));
}

/**
 * Default DynamoDB routing: the PII scan lists `piiUserIds`, every user has the fixture
 * preferences and one vote, no snapshot exists yet (GetItem finds nothing) and writes succeed.
 */
export function weeklyDigestDynamoRoute(piiUserIds: string[] = ["user-1"]) {
  return async (command: MockedCommand<{ TableName?: string }>): Promise<unknown> => {
    const input = command.input ?? {};

    if (command.__type === "ScanCommand") {
      if (input.TableName === "pii-table") {
        return { Items: piiUserIds.map((userId) => ({ userId: { S: userId } })) };
      }

      if (input.TableName === "members-table") {
        return {
          Items: [
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
          ],
        };
      }

      throw new Error(`Unexpected ScanCommand table: ${input.TableName}`);
    }

    if (command.__type === "QueryCommand") {
      switch (input.TableName) {
        case "preferences-table":
          return { Items: preferencesItems };
        case "feedback-table":
          return {
            Items: [
              {
                billId: { S: "BILLS-119hr22ih" },
                feedback: { S: "Yea" },
                votedAt: { S: "2026-03-01T15:00:00.000Z" },
              },
            ],
          };
        case "bill-manifest-table":
          return { Items: buildManifestDdbRows() };
        default:
          throw new Error(`Unexpected QueryCommand table: ${input.TableName}`);
      }
    }

    if (command.__type === "GetItemCommand" || command.__type === "PutItemCommand") {
      return {};
    }

    throw new Error(`Unexpected DynamoDB command: ${command.__type}`);
  };
}

/** S3 routing: GetObject answers from `processedBillsByKey`, and a missing key is NoSuchKey. */
export async function processedBillS3Route(command: MockedCommand<GetObjectCommandInput>): Promise<unknown> {
  if (command.__type !== "GetObjectCommand") {
    throw new Error(`Unexpected S3 command: ${command.__type}`);
  }

  const payload = processedBillsByKey[command.input?.Key ?? ""];
  if (!payload) {
    const error = new Error("NoSuchKey");
    error.name = "NoSuchKey";
    throw error;
  }

  return {
    Body: {
      transformToString: async () => JSON.stringify(payload),
    },
  };
}

/** A stored snapshot for the test window, as GetItem returns it. */
export function storedSnapshotItem(windowId: string = WEEKLY_DIGEST_TEST_WINDOW_ID) {
  return {
    Item: {
      payload: { S: JSON.stringify({ id: windowId, publishedAt: windowId }) },
    },
  };
}

/** The datums sent to the BillBoard/WeeklyDigest namespace with `metricName`, in send order. */
export function weeklyDigestMetricData(mockCloudWatchSend: jest.Mock, metricName: string): MetricDatum[] {
  return (mockCloudWatchSend.mock.calls as [{ input?: PutMetricDataCommandInput }][])
    .map(([command]) => command.input)
    .filter((input) => input?.Namespace === "BillBoard/WeeklyDigest")
    .flatMap((input) => input!.MetricData!)
    .filter((datum) => datum.MetricName === metricName);
}

/** The S3 GetObject keys requested, in order. */
export function s3GetKeys(mockS3Send: jest.Mock): string[] {
  return mockS3Send.mock.calls
    .map(([command]) => command)
    .filter((command) => command.__type === "GetObjectCommand")
    .map((command) => command.input.Key);
}

/** The user ids written to the digest table, sorted. */
export function storedDigestUserIds(mockDynamoSend: jest.Mock): string[] {
  return mockDynamoSend.mock.calls
    .filter(([command]) => command.__type === "PutItemCommand")
    .map(([command]) => command.input.Item.userId.S)
    .sort();
}
