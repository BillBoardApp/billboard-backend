jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  const mockSend = jest.fn();
  return {
    ...actual,
    S3Client: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RecentActionsV1 } from "../contracts";
import { noSuchKeyError } from "./fixtures/awsErrors";
import { applyTestEnv } from "./fixtures/env";
import { logLines } from "./logLines";

type Item = Record<string, AttributeValue>;

/** What the fake reads of a projection: the attributes to return, "#name" placeholders resolved through the names. */
interface Projected {
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
}

interface FakeInput extends Projected {
  TableName?: string;
  Key?: Item;
  KeyConditionExpression?: string;
  ExpressionAttributeValues?: Item;
  ExclusiveStartKey?: Item;
  RequestItems?: Record<string, { Keys: Item[] } & Projected>;
}

interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

/** What the fake S3 reads from a GetObject command. */
interface S3Command {
  constructor: { name: string };
  input: { Bucket?: string; Key?: string };
}

const FEEDBACK_TABLE = "UserFeedback";
const PREFERENCES_TABLE = "UserPreferences";
const MANIFEST_TABLE = "BillsManifest";
const BUCKET = "bill-store";
const USER_A = "user-a";
const USER_B = "user-b";
// 2026-11-25 10:00 Eastern: the window's first day is 2026-10-26.
const NOW = "2026-11-25T15:00:00.000Z";

// ─── In-memory stores ───

let feedback: Map<string, Item[]>;
let preferences: Map<string, Item[]>;
let lookups: Map<string, Item>;
let groupsRow: () => unknown;
let processed: Map<string, unknown>;
/** A test can fail or alter one command before it is answered. */
let beforeCommand: ((op: string, input: FakeInput) => void) | undefined;
/** Rows a BatchGetItem leaves unprocessed on its first try. */
let unprocessedOnce: Set<string>;
/** Query pages hold this many items, so paging is exercised. */
const PAGE = 2;

const page = (rows: Item[], input: FakeInput) => {
  const start = Number(input.ExclusiveStartKey?.offset?.N ?? 0);
  const items = rows.slice(start, start + PAGE);
  return {
    Items: items,
    ...(start + PAGE < rows.length ? { LastEvaluatedKey: { offset: { N: String(start + PAGE) } } } : {}),
  };
};

/** The item as DynamoDB returns it under the request's ProjectionExpression: only the attributes it names. */
const project = (item: Item, { ProjectionExpression, ExpressionAttributeNames = {} }: Projected): Item => {
  if (!ProjectionExpression) return item;
  const kept: Item = {};
  for (const token of ProjectionExpression.split(",").map((part) => part.trim())) {
    const name = token.startsWith("#") ? ExpressionAttributeNames[token] : token;
    if (!name) throw new Error(`ProjectionExpression names ${token} without an ExpressionAttributeNames entry`);
    if (item[name] !== undefined) kept[name] = item[name];
  }
  return kept;
};

const routeDynamo = async (command: FakeCommand) => {
  const op = command.constructor.name;
  const input = command.input;
  beforeCommand?.(op, input);
  if (op === "QueryCommand" && input.TableName === FEEDBACK_TABLE) {
    const rows = feedback.get(input.ExpressionAttributeValues![":pk"].S!) ?? [];
    return page(
      rows.map((row) => project(row, input)),
      input,
    );
  }
  if (op === "QueryCommand" && input.TableName === PREFERENCES_TABLE) {
    const rows = preferences.get(input.ExpressionAttributeValues![":pk"].S!) ?? [];
    return page(
      rows.map((row) => project(row, input)),
      input,
    );
  }
  if (op === "GetItemCommand" && input.Key?.pk?.S === "BILL_COMPANION_GROUPS") return groupsRow();
  if (op === "BatchGetItemCommand" && input.RequestItems?.[MANIFEST_TABLE]) {
    const request = input.RequestItems[MANIFEST_TABLE];
    const keys = request.Keys;
    // DynamoDB refuses more than 100 keys in one call, and a key asked for twice.
    if (keys.length > 100) throw new Error(`BatchGetItem with ${keys.length} keys`);
    if (new Set(keys.map((key) => key.sk.S)).size !== keys.length) throw new Error("BatchGetItem with duplicate keys");
    const responses: Item[] = [];
    const unprocessed: Item[] = [];
    for (const key of keys) {
      if (key.pk.S !== "BILL_GUID") throw new Error(`Unexpected partition ${key.pk.S}`);
      const guid = key.sk.S!;
      if (unprocessedOnce.delete(guid)) {
        unprocessed.push(key);
        continue;
      }
      const row = lookups.get(guid);
      if (row) responses.push(project(row, request));
    }
    return {
      Responses: { [MANIFEST_TABLE]: responses },
      ...(unprocessed.length ? { UnprocessedKeys: { [MANIFEST_TABLE]: { Keys: unprocessed } } } : {}),
    };
  }
  throw new Error(`Unexpected ${op} on ${input.TableName}`);
};

const routeS3 = async (command: S3Command) => {
  const op = command.constructor.name;
  beforeCommand?.(op, {});
  if (op !== "GetObjectCommand" || command.input.Bucket !== BUCKET) throw new Error(`Unexpected ${op}`);
  const document = processed.get(command.input.Key!);
  if (document === undefined) throw noSuchKeyError();
  return { Body: { transformToString: async () => JSON.stringify(document) } };
};

let dynamoSend: jest.Mock;
let s3Send: jest.Mock;
let handler: (event: unknown) => Promise<{ statusCode: number; body: string }>;
let windowDaysFrom: (value: string | undefined) => number;
let restoreEnv: (() => void) | undefined;
let warnSpy: jest.SpyInstance;

const load = (env: Record<string, string | undefined> = {}) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv({
    FEEDBACK_TABLE_NAME: FEEDBACK_TABLE,
    FEEDBACK_PARTITION_KEY: "userId",
    FEEDBACK_SORT_KEY: "billId",
    PREFERENCES_TABLE_NAME: PREFERENCES_TABLE,
    PREFERENCES_PARTITION_KEY: "userId",
    PREFERENCES_SORT_KEY: "preference",
    BUCKET_NAME: BUCKET,
    MANIFEST_TABLE_NAME: MANIFEST_TABLE,
    MANIFEST_PRIMARY_KEY: "pk",
    MANIFEST_COMPANION_GROUPS_PK: "BILL_COMPANION_GROUPS",
    GUID_LOOKUP_PK: "BILL_GUID",
    RECENT_ACTIONS_WINDOW_DAYS: undefined,
    ...env,
  });
  jest.resetModules();
  ({ __mockSend: dynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb"));
  ({ __mockSend: s3Send } = jest.requireMock("@aws-sdk/client-s3"));
  dynamoSend.mockReset();
  dynamoSend.mockImplementation(routeDynamo);
  s3Send.mockReset();
  s3Send.mockImplementation(routeS3);
  const module = require("../handlers/fetchRecentActions");
  handler = module.handler;
  windowDaysFrom = module.windowDaysFrom;
};

// ─── Seeding ───

const vote = (userId: string, billId: string, value: string, votedAt: string | null, extra: Item = {}) => {
  const rows = feedback.get(userId) ?? [];
  rows.push({
    userId: { S: userId },
    billId: { S: billId },
    feedback: { S: value },
    ...(votedAt ? { votedAt: { S: votedAt } } : {}),
    ...extra,
  });
  feedback.set(userId, rows);
};
const follow = (userId: string, guid: string, type = "Watch") => {
  const rows = preferences.get(userId) ?? [];
  rows.push({ userId: { S: userId }, preference: { S: guid }, type: { S: type } });
  preferences.set(userId, rows);
};
/** A bill whose manifest row moved at `movedAt`, stored with one action on `actionDay` (or `actions`). */
const storeBill = (
  guid: string,
  title: string,
  movedAt: string,
  actionDay: string | null,
  extra: Record<string, unknown> = {},
) => {
  lookups.set(guid, {
    pk: { S: "BILL_GUID" },
    sk: { S: guid },
    guid: { S: guid },
    manifestSk: { S: `${movedAt}#${guid}` },
    updatedAt: { S: movedAt },
  });
  processed.set(`processed-bills/${guid}.json`, {
    guid,
    title,
    billStatus: "New",
    actions: actionDay
      ? [
          {
            actionCode: "H12200",
            actionDate: actionDay,
            text: `Reported by the Committee on Energy and Commerce (${title}).`,
            type: "Committee",
          },
        ]
      : [],
    ...extra,
  });
};
const useGroups = (pairs: [string, string][]) => {
  groupsRow = () => ({
    Item: {
      pk: { S: "BILL_COMPANION_GROUPS" },
      sk: { S: "CURRENT" },
      pairsVersion: { N: "3" },
      enabled: { BOOL: true },
      pairs: { S: JSON.stringify(pairs) },
    },
  });
};

const request = async (userId?: string) => {
  const event = userId ? { requestContext: { authorizer: { claims: { sub: userId } } } } : {};
  return handler(event);
};
const listFor = async (userId: string): Promise<RecentActionsV1> => {
  const response = await request(userId);
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as RecentActionsV1;
};
const commands = (send: jest.Mock, name: string) =>
  send.mock.calls.map(([command]) => command as FakeCommand).filter((command) => command.constructor.name === name);
const s3Keys = () =>
  s3Send.mock.calls
    .map(([command]) => command as S3Command)
    .filter((command) => command.constructor.name === "GetObjectCommand")
    .map((command) => command.input.Key!);

beforeEach(() => {
  feedback = new Map();
  preferences = new Map();
  lookups = new Map();
  processed = new Map();
  groupsRow = () => ({});
  beforeCommand = undefined;
  unprocessedOnce = new Set();
  jest.spyOn(Date, "now").mockReturnValue(Date.parse(NOW));
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  load();
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.restoreAllMocks();
});

describe("fetchRecentActions", () => {
  it("answers 401 without claims and reads nothing", async () => {
    const response = await request();
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ message: "Unauthorized (missing authorizer claims)" });
    expect(dynamoSend).not.toHaveBeenCalled();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("answers 200 with no items, and reads no manifest row or bill, when the caller has no bills", async () => {
    follow(USER_A, "Health", "Category");
    const body = await listFor(USER_A);
    expect(body).toEqual({ generatedAt: NOW, windowDays: 30, items: [] });
    expect(commands(dynamoSend, "BatchGetItemCommand")).toHaveLength(0);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("lists bills the caller voted on and watches, each with the caller's vote, in the contract's shape", async () => {
    storeBill("BILLS-119hr77", "Voted bill", "2026-11-19T18:00:00.000Z", "2026-11-19", {
      officialVotes: {
        lastSyncedAt: "2026-11-20T00:00:00.000Z",
        source: "congress_api",
        completeness: "partial",
        house: { yea: 300, nay: 120, present: 0, notVoting: 12, totalCounted: 432, actionDate: "2026-11-19" },
      },
    });
    storeBill("BILLS-119s50", "Watched bill", "2026-11-12T18:00:00.000Z", "2026-11-12");
    vote(USER_A, "BILLS-119hr77", "Yea", "2026-10-26T16:00:00.000Z");
    follow(USER_A, "BILLS-119s50");

    const body = await listFor(USER_A);

    expect(body.generatedAt).toBe(NOW);
    expect(body.windowDays).toBe(30);
    expect(body.items).toEqual([
      expect.objectContaining({
        billGuid: "BILLS-119hr77",
        officialNumber: "H.R. 77",
        title: "Voted bill",
        action: {
          date: "2026-11-19",
          text: "Reported by the Committee on Energy and Commerce (Voted bill)",
          actionCode: "H12200",
          billGuid: "BILLS-119hr77",
          officialNumber: "H.R. 77",
        },
        yourVote: "Yea",
        votedOn: "2026-10-26",
        voteTiming: { chamber: "House", rollCallDate: "2026-11-19", daysBefore: 24 },
        watched: false,
      }),
      expect.objectContaining({ billGuid: "BILLS-119s50", officialNumber: "S. 50", watched: true }),
    ]);
    expect(body.items[1]).not.toHaveProperty("yourVote");

    const schema = JSON.parse(
      readFileSync(join(__dirname, "../../../contracts/schemas/entities/recent-actions.v1.schema.json"), "utf8"),
    );
    expect(Object.keys(body).sort()).toEqual([...schema.required].sort());
    const itemSchema = schema.$defs.recentActionItem;
    const actionSchema = schema.$defs.recentAction;
    for (const item of body.items) {
      for (const key of itemSchema.required) expect(item).toHaveProperty(key);
      for (const key of Object.keys(item)) expect(Object.keys(itemSchema.properties)).toContain(key);
      for (const key of actionSchema.required) expect(item.action).toHaveProperty(key);
      for (const key of Object.keys(item.action)) expect(Object.keys(actionSchema.properties)).toContain(key);
    }
  });

  it("reads only the caller's partitions, so user A never sees user B's vote", async () => {
    storeBill("BILLS-119hr77", "Shared bill", "2026-11-19T18:00:00.000Z", "2026-11-19");
    vote(USER_A, "BILLS-119hr77", "Yea", "2026-11-01T12:00:00.000Z");
    vote(USER_B, "BILLS-119hr77", "Nay", "2026-11-02T12:00:00.000Z");
    follow(USER_B, "BILLS-119hr77");

    const listA = await listFor(USER_A);
    const keysA = commands(dynamoSend, "QueryCommand").map(
      (command) => command.input.ExpressionAttributeValues![":pk"].S,
    );
    dynamoSend.mockClear();
    const listB = await listFor(USER_B);
    const keysB = commands(dynamoSend, "QueryCommand").map(
      (command) => command.input.ExpressionAttributeValues![":pk"].S,
    );

    expect(keysA).toEqual([USER_A, USER_A]);
    expect(keysB).toEqual([USER_B, USER_B]);
    expect(listA.items).toEqual([expect.objectContaining({ yourVote: "Yea", votedOn: "2026-11-01", watched: false })]);
    expect(listB.items).toEqual([expect.objectContaining({ yourVote: "Nay", votedOn: "2026-11-02", watched: true })]);
    expect(JSON.stringify(listA)).not.toContain("Nay");
  });

  it("never counts a 1.0 or 1.1 dismissal as a vote, but lists the bill when it is watched", async () => {
    storeBill("BILLS-119hr1", "Dismissed only", "2026-11-19T18:00:00.000Z", "2026-11-19");
    storeBill("BILLS-119hr2", "Dismissed and watched", "2026-11-18T18:00:00.000Z", "2026-11-18");
    const dismissed = { legacyDismiss: { BOOL: true } };
    vote(USER_A, "BILLS-119hr1", "Abstain", "2026-11-01T12:00:00.000Z", dismissed);
    vote(USER_A, "BILLS-119hr2", "Abstain", "2026-11-01T12:00:00.000Z", dismissed);
    follow(USER_A, "BILLS-119hr2");

    const { items } = await listFor(USER_A);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ billGuid: "BILLS-119hr2", watched: true });
    expect(items[0]).not.toHaveProperty("yourVote");
    expect(items[0]).not.toHaveProperty("votedOn");
  });

  it("lists an Abstain as a vote, and takes the plain guid's row over a legacy suffixed one", async () => {
    storeBill("BILLS-119hr3", "Abstained", "2026-11-19T18:00:00.000Z", "2026-11-19");
    storeBill("BILLS-119hr4", "Voted twice", "2026-11-18T18:00:00.000Z", "2026-11-18");
    vote(USER_A, "BILLS-119hr3", "Abstain", "2026-11-01T12:00:00.000Z");
    vote(USER_A, "BILLS-119hr4rh", "Yea", "2026-11-09T12:00:00.000Z");
    vote(USER_A, "BILLS-119hr4", "nay", "2026-11-03T12:00:00.000Z");
    vote(USER_A, "BILLS-119hr4ih", "Yea", "2026-11-10T12:00:00.000Z");

    const { items } = await listFor(USER_A);

    expect(items.map((item) => [item.billGuid, item.yourVote, item.votedOn])).toEqual([
      ["BILLS-119hr3", "Abstain", "2026-11-01"],
      ["BILLS-119hr4", "Nay", "2026-11-03"],
    ]);
  });

  it("does not treat the Bill row a vote writes as a watch", async () => {
    storeBill("BILLS-119hr5", "Followed by a vote row only", "2026-11-19T18:00:00.000Z", "2026-11-19");
    follow(USER_A, "BILLS-119hr5", "Bill");
    expect((await listFor(USER_A)).items).toEqual([]);
  });

  it("reads no bill whose manifest row has not moved in the window or is missing, and lists no older action", async () => {
    storeBill("BILLS-119hr6", "Moved long ago", "2026-10-20T18:00:00.000Z", "2026-10-20");
    storeBill("BILLS-119hr7", "Re-dated, old action", "2026-11-20T18:00:00.000Z", "2026-10-01");
    storeBill("BILLS-119hr8", "First day of the window", "2026-10-26T18:00:00.000Z", "2026-10-26");
    // Stored, but with no manifest row (not published, or removed): not read.
    storeBill("BILLS-119hr9", "No manifest row", "2026-11-20T18:00:00.000Z", "2026-11-20");
    lookups.delete("BILLS-119hr9");
    for (const guid of ["BILLS-119hr6", "BILLS-119hr7", "BILLS-119hr8", "BILLS-119hr9"]) follow(USER_A, guid);

    const { items } = await listFor(USER_A);

    expect(s3Keys().sort()).toEqual(["processed-bills/BILLS-119hr7.json", "processed-bills/BILLS-119hr8.json"]);
    expect(items.map((item) => item.billGuid)).toEqual(["BILLS-119hr8"]);
  });

  it("uses the lookup row's manifestSk date when it has no updatedAt", async () => {
    storeBill("BILLS-119hr10", "Lookup without updatedAt", "2026-11-19T18:00:00.000Z", "2026-11-19");
    const { updatedAt, ...lookup } = lookups.get("BILLS-119hr10")!;
    expect(updatedAt).toBeDefined();
    lookups.set("BILLS-119hr10", lookup);
    follow(USER_A, "BILLS-119hr10");
    expect((await listFor(USER_A)).items).toHaveLength(1);
  });

  it("reads at most 60 bills, the most recently moved first, and lists at most 50", async () => {
    for (let index = 0; index < 70; index += 1) {
      const guid = `BILLS-119hr${100 + index}`;
      const day = `2026-11-${String(1 + (index % 24)).padStart(2, "0")}`;
      storeBill(guid, `Bill ${index}`, `${day}T${String(index % 24).padStart(2, "0")}:00:00.000Z`, day);
      follow(USER_A, guid);
    }

    const { items } = await listFor(USER_A);

    const reads = s3Keys();
    expect(reads).toHaveLength(60);
    const movedAt = (key: string) => lookups.get(key.replace(/^processed-bills\/(.+)\.json$/, "$1"))!.updatedAt.S!;
    const unread = [...lookups.keys()].filter((guid) => !reads.includes(`processed-bills/${guid}.json`));
    expect(unread).toHaveLength(10);
    const oldestRead = reads.map(movedAt).sort()[0];
    for (const guid of unread) expect(lookups.get(guid)!.updatedAt.S! <= oldestRead).toBe(true);
    expect(items).toHaveLength(50);
    const days = items.map((item) => item.action.date);
    expect(days).toEqual([...days].sort().reverse());
    const summary = logLines(console.log).find((line) => line.message === "fetchRecentActions built the list");
    expect(summary).toMatchObject({ bills: 70, moved: 70, unread: 10, read: 60, missing: 0, items: 50 });
    const metric = logLines(console.log).find((line) => line._aws);
    expect(metric?._aws?.CloudWatchMetrics[0]).toMatchObject({
      Namespace: "BillBoard/RecentActions",
      Metrics: [{ Name: "ReadCapHit" }],
    });
    expect(JSON.stringify(metric)).not.toContain("BILLS-");
  });

  it("reads the lookup rows of 150 bills in two BatchGetItem calls of at most 100 keys", async () => {
    for (let index = 0; index < 150; index += 1) {
      const guid = `BILLS-119hr${300 + index}`;
      // Only the last one moved in the window, so one bill is read from S3.
      const movedAt = index === 149 ? "2026-11-19T18:00:00.000Z" : "2026-09-01T18:00:00.000Z";
      storeBill(guid, `Bill ${index}`, movedAt, movedAt.slice(0, 10));
      follow(USER_A, guid);
    }

    const { items } = await listFor(USER_A);

    const batches = commands(dynamoSend, "BatchGetItemCommand").map(
      (command) => command.input.RequestItems![MANIFEST_TABLE].Keys.length,
    );
    expect(batches).toEqual([100, 50]);
    expect(s3Keys()).toEqual(["processed-bills/BILLS-119hr449.json"]);
    expect(items.map((item) => item.billGuid)).toEqual(["BILLS-119hr449"]);
  });

  it("skips a bill with no processed copy and lists the rest", async () => {
    storeBill("BILLS-119hr11", "Stored", "2026-11-19T18:00:00.000Z", "2026-11-19");
    storeBill("BILLS-119hr12", "Not stored", "2026-11-19T18:00:00.000Z", "2026-11-19");
    processed.delete("processed-bills/BILLS-119hr12.json");
    follow(USER_A, "BILLS-119hr11");
    follow(USER_A, "BILLS-119hr12");

    const { items } = await listFor(USER_A);

    expect(items.map((item) => item.billGuid)).toEqual(["BILLS-119hr11"]);
    const summary = logLines(console.log).find((line) => line.message === "fetchRecentActions built the list");
    expect(summary).toMatchObject({ bills: 2, moved: 2, unread: 0, read: 2, missing: 1, items: 1 });
    expect(JSON.stringify(summary)).not.toContain(USER_A);
    expect(logLines(console.log).some((line) => line._aws)).toBe(false);
  });

  it("shows a companion pair as one row, reading the partner the caller does not hold", async () => {
    useGroups([["BILLS-119hr13", "BILLS-119s13"]]);
    storeBill("BILLS-119hr13", "House member", "2026-11-05T18:00:00.000Z", "2026-11-05");
    storeBill("BILLS-119s13", "Senate member", "2026-11-19T18:00:00.000Z", "2026-11-19", { billStatus: "Passed" });
    vote(USER_A, "BILLS-119hr13", "Yea", "2026-11-01T12:00:00.000Z");

    const { items } = await listFor(USER_A);

    expect(items).toEqual([
      expect.objectContaining({
        billGuid: "BILLS-119s13",
        title: "Senate member",
        billStatus: "Passed",
        yourVote: "Yea",
        watched: false,
      }),
    ]);
    expect(s3Keys().sort()).toEqual(["processed-bills/BILLS-119hr13.json", "processed-bills/BILLS-119s13.json"]);
  });

  it("reads a group's member that did not move, so a law keeps the row as on the Bills card", async () => {
    useGroups([["BILLS-119hr19", "BILLS-119s19"]]);
    storeBill("BILLS-119hr19", "House law", "2026-08-01T18:00:00.000Z", null, {
      billStatus: "Finalized",
      actions: [
        { actionCode: "36000", actionDate: "2026-08-01", text: "Became Public Law No: 119-20.", type: "BecameLaw" },
      ],
    });
    storeBill("BILLS-119s19", "Senate twin", "2026-11-12T18:00:00.000Z", "2026-11-12");
    follow(USER_A, "BILLS-119s19");

    const { items } = await listFor(USER_A);

    expect(s3Keys().sort()).toEqual(["processed-bills/BILLS-119hr19.json", "processed-bills/BILLS-119s19.json"]);
    expect(items).toEqual([
      expect.objectContaining({
        billGuid: "BILLS-119hr19",
        title: "House law",
        billStatus: "Finalized",
        action: expect.objectContaining({ date: "2026-11-12", billGuid: "BILLS-119s19", officialNumber: "S. 19" }),
        watched: true,
      }),
    ]);
  });

  it("reads neither member of a group that did not move, nor a member with no manifest row", async () => {
    useGroups([
      ["BILLS-119hr20", "BILLS-119s20"],
      ["BILLS-119hr21", "BILLS-119s21"],
    ]);
    storeBill("BILLS-119hr20", "Old House", "2026-09-01T18:00:00.000Z", "2026-09-01");
    storeBill("BILLS-119s20", "Old Senate", "2026-09-02T18:00:00.000Z", "2026-09-02");
    storeBill("BILLS-119hr21", "Moved House", "2026-11-19T18:00:00.000Z", "2026-11-19");
    storeBill("BILLS-119s21", "Unlisted Senate", "2026-11-20T18:00:00.000Z", "2026-11-20");
    lookups.delete("BILLS-119s21");
    follow(USER_A, "BILLS-119hr20");
    follow(USER_A, "BILLS-119s21");

    const { items } = await listFor(USER_A);

    expect(s3Keys()).toEqual(["processed-bills/BILLS-119hr21.json"]);
    expect(items.map((item) => item.billGuid)).toEqual(["BILLS-119hr21"]);
  });

  it("lists each bill on its own when the companion groups cannot be read", async () => {
    groupsRow = () => {
      throw new Error("throttled");
    };
    storeBill("BILLS-119hr14", "House member", "2026-11-05T18:00:00.000Z", "2026-11-05");
    storeBill("BILLS-119s14", "Senate member", "2026-11-19T18:00:00.000Z", "2026-11-19");
    follow(USER_A, "BILLS-119hr14");
    follow(USER_A, "BILLS-119s14");

    const { items } = await listFor(USER_A);

    expect(items.map((item) => item.billGuid)).toEqual(["BILLS-119s14", "BILLS-119hr14"]);
    const metric = logLines(console.log).find((line) => line._aws);
    expect(metric?._aws?.CloudWatchMetrics[0]).toMatchObject({
      Namespace: "BillBoard/BillsManifest",
      Metrics: [{ Name: "CompanionGroupsReadFailed" }],
    });
    expect(logLines(warnSpy).map((line) => line.message)).toContain(
      "fetchRecentActions could not read the companion groups; listing each bill on its own",
    );
  });

  it("asks again for lookup rows DynamoDB left unprocessed", async () => {
    storeBill("BILLS-119hr15", "Throttled lookup", "2026-11-19T18:00:00.000Z", "2026-11-19");
    follow(USER_A, "BILLS-119hr15");
    unprocessedOnce.add("BILLS-119hr15");

    const { items } = await listFor(USER_A);

    expect(items).toHaveLength(1);
    expect(commands(dynamoSend, "BatchGetItemCommand")).toHaveLength(2);
  });

  it("answers 500 when lookup rows stay unprocessed", async () => {
    storeBill("BILLS-119hr15", "Throttled lookup", "2026-11-19T18:00:00.000Z", "2026-11-19");
    follow(USER_A, "BILLS-119hr15");
    beforeCommand = (op) => {
      if (op === "BatchGetItemCommand") unprocessedOnce.add("BILLS-119hr15");
    };
    const response = await request(USER_A);
    expect(response.statusCode).toBe(500);
    expect(commands(dynamoSend, "BatchGetItemCommand")).toHaveLength(5);
  }, 10_000);

  it("answers 500 when the caller's votes cannot be read", async () => {
    beforeCommand = (op, input) => {
      if (op === "QueryCommand" && input.TableName === FEEDBACK_TABLE) throw new Error("throttled");
    };
    const response = await request(USER_A);
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "Internal server error" });
  });

  it("answers 500 when a bill cannot be read for another reason than not being stored", async () => {
    storeBill("BILLS-119hr16", "Unreadable", "2026-11-19T18:00:00.000Z", "2026-11-19");
    follow(USER_A, "BILLS-119hr16");
    beforeCommand = (op) => {
      if (op === "GetObjectCommand") throw Object.assign(new Error("slow down"), { name: "SlowDown" });
    };
    expect((await request(USER_A)).statusCode).toBe(500);
  });

  it("takes the window from RECENT_ACTIONS_WINDOW_DAYS", async () => {
    load({ RECENT_ACTIONS_WINDOW_DAYS: "14" });
    storeBill("BILLS-119hr17", "Inside 14 days", "2026-11-19T18:00:00.000Z", "2026-11-19");
    storeBill("BILLS-119hr18", "Inside 30 only", "2026-11-05T18:00:00.000Z", "2026-11-05");
    follow(USER_A, "BILLS-119hr17");
    follow(USER_A, "BILLS-119hr18");

    const body = await listFor(USER_A);

    expect(body.windowDays).toBe(14);
    expect(body.items.map((item) => item.billGuid)).toEqual(["BILLS-119hr17"]);
  });

  it.each([
    [undefined, 30],
    ["", 30],
    ["0", 30],
    ["91", 30],
    ["7.5", 30],
    ["thirty", 30],
    ["1", 1],
    [" 45 ", 45],
    ["90", 90],
  ])("reads RECENT_ACTIONS_WINDOW_DAYS %p as %p", (value, days) => {
    expect(windowDaysFrom(value)).toBe(days);
  });
});
