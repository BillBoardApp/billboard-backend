jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({
      send: mockSend,
    })),
    __mockSend: mockSend,
  };
});

// GET /district-verification reads the hash salt from Secrets Manager (the only source, UA-15) at its first request.
jest.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: jest.fn(() => ({ send: jest.fn(async () => ({ SecretString: "test-salt" })) })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ input })),
}));

import type {
  AttributeValue,
  BatchGetItemCommandInput,
  GetItemCommandInput,
  PutItemCommandInput,
  UpdateItemCommandInput,
  TransactWriteItemsCommandInput,
  Put,
  Delete,
  Update,
  ConditionCheck,
} from "@aws-sdk/client-dynamodb";

type TransactPart = Partial<Put & Delete & Update & ConditionCheck>;
import { APP_ATTEST_DEFAULTS, VOTE_DAILY_LIMIT } from "../shared/abuseLimits";
import { bindingItemKey, keyItemKey } from "../shared/appAttest/store";
import {
  FakeAppAttestTable,
  assertionAuthData,
  assertionMarker,
  challengeOf,
  challengeRow,
  generateDeviceKey,
  keyRow,
  requestClientData,
  signAssertion,
  type DeviceKey,
} from "./fixtures/appAttest/helpers";
import { conditionalCheckFailed, evaluateCondition } from "./fixtures/dynamoCondition";
import { applyTestEnv, type EnvOverrides } from "./fixtures/env";
import { seedResults, type SeededResults } from "./fixtures/resultsWorld";
import { logLines } from "./logLines";

type Item = Record<string, AttributeValue>;

const FEEDBACK_TABLE = "test-table";
const PII_TABLE = "pii-table";
const MANIFEST_TABLE = "manifest-table";
const ATTEST_TABLE = "app-attest-table";
const NOW = new Date("2026-10-08T15:30:00.000Z");
const TODAY = "2026-10-08";
/** Accounts one install's key may vote for (APP_ATTEST_MAX_ACCOUNTS_PER_KEY is unset, so the default). */
const PER_KEY_LIMIT = APP_ATTEST_DEFAULTS.maxAccountsPerKey;

const BASE_ENV: EnvOverrides = {
  TABLE_NAME: FEEDBACK_TABLE,
  PARTITION_KEY: "user_id",
  SORT_KEY: "bill_id",
  PII_TABLE_NAME: PII_TABLE,
  PII_PARTITION_KEY: "user_id",
  MANIFEST_TABLE_NAME: undefined,
  MANIFEST_PRIMARY_KEY: undefined,
  MANIFEST_SORT_KEY: undefined,
  MANIFEST_GUID_LOOKUP_PK: undefined,
  VOTE_DAILY_CAP_MODE: undefined,
  VERIFIED_VOTE_WEIGHT: undefined,
  SELF_ATTESTED_VOTE_WEIGHT: undefined,
  // App Attest (C3 3.1): every switch the request path reads, unset unless a test sets it.
  APP_ATTEST_MODE: undefined,
  APP_ATTEST_TABLE_NAME: undefined,
  APP_ATTEST_ALLOWED_ENVIRONMENTS: undefined,
  APP_ATTEST_MAX_ACCOUNTS_PER_KEY: undefined,
  APP_ATTEST_FAIL_CLOSED: undefined,
  APP_ATTEST_EXEMPT_GROUP: undefined,
  MIN_APP_VERSION: undefined,
};
const MANIFEST_ENV: EnvOverrides = {
  MANIFEST_TABLE_NAME: MANIFEST_TABLE,
  MANIFEST_PRIMARY_KEY: "pk",
  MANIFEST_SORT_KEY: "sk",
  MANIFEST_GUID_LOOKUP_PK: "BILL_GUID",
};

// ─── In-memory DynamoDB: GetItem, PutItem and UpdateItem (the SET forms the handlers send) ───────

/** The input of the commands the fake DynamoDB answers, in its own field names. */
type DynamoInput = Partial<
  GetItemCommandInput &
    PutItemCommandInput &
    UpdateItemCommandInput &
    BatchGetItemCommandInput &
    TransactWriteItemsCommandInput
>;
interface FakeCommand {
  constructor: { name: string };
  input: DynamoInput;
}
/** The mocked DynamoDBClient's send. */
type DynamoSend = jest.Mock<Promise<unknown>, [FakeCommand]>;

const keyOf = (key: Item) =>
  JSON.stringify(
    Object.keys(key)
      .sort()
      .map((name) => [name, key[name]]),
  );

const applySet = (item: Item, input: DynamoInput): Item => {
  const expression = input.UpdateExpression!;
  if (!expression.startsWith("SET ")) throw new Error(`Unsupported update: ${expression}`);
  const name = (token: string) => (token.startsWith("#") ? input.ExpressionAttributeNames![token] : token);
  const next = { ...item };
  for (const clause of expression.slice(4).split(",")) {
    const [lhs, rhs] = clause.split("=").map((part) => part.trim());
    const sum = /^(#?\w+) \+ (:\w+)$/.exec(rhs);
    if (sum) {
      const current = next[name(sum[1])]?.N;
      if (current === undefined) throw new Error("The provided expression refers to an attribute that does not exist");
      next[name(lhs)] = { N: String(Number(current) + Number(input.ExpressionAttributeValues![sum[2]].N)) };
    } else if (/^:\w+$/.test(rhs)) {
      next[name(lhs)] = input.ExpressionAttributeValues![rhs];
    } else {
      throw new Error(`Unsupported SET clause: ${clause}`);
    }
  }
  return next;
};

let tables: Map<string, Map<string, Item>>;
/** The AppAttest table (pk/sk items, SET and ADD updates, honours the abort signal). */
let attestTable: FakeAppAttestTable;
/** Runs before each command; a test can play a concurrent writer or fail a call. */
let beforeCommand: ((op: string, input: DynamoInput) => void) | undefined;

const table = (name: string) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name)!;
};
const putRow = (tableName: string, item: Item, keyNames: string[]) => {
  const key = Object.fromEntries(keyNames.map((name) => [name, item[name]]));
  table(tableName).set(keyOf(key), item);
};
const piiRow = (userId: string) => table(PII_TABLE).get(keyOf({ user_id: { S: userId } }));
const voteRow = (userId: string, billId: string) =>
  table(FEEDBACK_TABLE).get(keyOf({ user_id: { S: userId }, bill_id: { S: billId } }));

const route = async (command: FakeCommand, options?: { abortSignal?: AbortSignal }) => {
  const op: string = command.constructor.name;
  const input = command.input;
  beforeCommand?.(op, input);
  if (input.TableName === ATTEST_TABLE) return attestTable.send(command, options);
  // The App Attest binding and its count are one transaction on the AppAttest table only.
  const transactTables = (input.TransactItems ?? []).map((part) => (Object.values(part)[0] as TransactPart).TableName);
  if (transactTables.length > 0 && transactTables.every((name) => name === ATTEST_TABLE)) {
    return attestTable.send(command, options);
  }
  const rows = table(input.TableName!);
  if (op === "GetItemCommand") {
    const item = rows.get(keyOf(input.Key!));
    if (!item) return {};
    if (!input.ProjectionExpression) return { Item: { ...item } };
    // As DynamoDB does: only the projected attributes, and an empty Item when the row has none of them.
    const projected = input.ProjectionExpression.split(",")
      .map((token) => token.trim())
      .map((token) => (token.startsWith("#") ? input.ExpressionAttributeNames![token] : token));
    return { Item: Object.fromEntries(Object.entries(item).filter(([name]) => projected.includes(name))) };
  }
  if (op === "PutItemCommand") {
    const key = Object.fromEntries(
      Object.entries(input.Item!).filter(([name]) => name === "user_id" || name === "bill_id"),
    ) as Item;
    if (!evaluateCondition(rows.get(keyOf(key)), input)) throw conditionalCheckFailed();
    rows.set(keyOf(key), { ...input.Item });
    return {};
  }
  if (op === "BatchGetItemCommand") {
    // GET /bill-stats reads the caller's vote rows this way (INT-11).
    const Responses: Record<string, Item[]> = {};
    for (const [tableName, request] of Object.entries(input.RequestItems!)) {
      Responses[tableName] = request
        .Keys!.map((key) => table(tableName).get(keyOf(key)))
        .filter((item): item is Item => item !== undefined)
        .map((item) => ({ ...item }));
    }
    return { Responses, UnprocessedKeys: {} };
  }
  if (op === "UpdateItemCommand") {
    const existing = rows.get(keyOf(input.Key!));
    if (!evaluateCondition(existing, input)) {
      throw conditionalCheckFailed(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? existing : undefined);
    }
    const updated = applySet(existing ?? { ...input.Key }, input);
    rows.set(keyOf(input.Key!), updated);
    return { Attributes: updated };
  }
  throw new Error(`Unexpected ${op}`);
};

// ─── Loading the handler under an environment ───────────────────────────────────────────────────

let send: DynamoSend;
let handler: (event: unknown) => Promise<{ statusCode: number; headers?: Record<string, string>; body: string }>;
let restoreEnv: (() => void) | undefined;
let logSpy: jest.SpyInstance;

const load = (env: EnvOverrides = {}) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv({ ...BASE_ENV, ...env });
  jest.resetModules();
  ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
  send.mockReset();
  send.mockImplementation(route);
  handler = require("../handlers/setFeedback").handler;
};

const vote = (body: Record<string, unknown>, userId = "user-1") =>
  handler({
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
    body: JSON.stringify(body),
  });

const calls = () =>
  send.mock.calls.map(
    ([command]) =>
      `${command.constructor.name} ${command.input.TableName ?? (Object.values(command.input.TransactItems![0])[0] as TransactPart).TableName}`,
  );
const puts = () => send.mock.calls.filter(([command]) => command.constructor.name === "PutItemCommand");
const counterUpdates = () =>
  send.mock.calls.filter(
    ([command]) => command.constructor.name === "UpdateItemCommand" && command.input.TableName === PII_TABLE,
  );
const integrityLines = () =>
  logLines(logSpy).filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/AccountIntegrity");

const seedPii = (userId: string, attributes: Item) =>
  putRow(PII_TABLE, { user_id: { S: userId }, ...attributes }, ["user_id"]);
const ADULT: Item = { adultStatus: { S: "attested_adult" } };
const seedCount = (userId: string, count: number, day = TODAY) =>
  seedPii(userId, { ...ADULT, voteDay: { S: day }, voteDayCount: { N: String(count) } });

const seedManifestBill = (billId: string, attributes: Item) => {
  const manifestSk = `2026-03-01T00:00:00.000Z#${billId}`;
  putRow(MANIFEST_TABLE, { pk: { S: "BILL_GUID" }, sk: { S: billId }, manifestSk: { S: manifestSk } }, ["pk", "sk"]);
  putRow(MANIFEST_TABLE, { pk: { S: "BILL" }, sk: { S: manifestSk }, ...attributes }, ["pk", "sk"]);
};

beforeEach(() => {
  tables = new Map();
  attestTable = new FakeAppAttestTable();
  beforeCommand = undefined;
  jest.useFakeTimers({ now: NOW });
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  load();
});

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("provideFeedback handler", () => {
  it("should return 400 if bill_id or feedback is missing", async () => {
    const result = await vote({});

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Missing billId or feedback" });
    expect(send).not.toHaveBeenCalled();
  });

  it("should return 200 and submit feedback successfully", async () => {
    seedPii("user-1", { ...ADULT, constituentVerified: { BOOL: false }, verificationStatus: { S: "self_attested" } });

    const result = await vote({ billId: "bill-123", feedback: "Yea", userId: "user-1" });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Feedback submitted" });
    expect(voteRow("user-1", "bill-123")).toEqual({
      bill_id: { S: "bill-123" },
      user_id: { S: "user-1" },
      feedback: { S: "Yea" },
      votedAt: { S: NOW.toISOString() },
      firstVotedAt: { S: NOW.toISOString() },
      effectiveWeight: { N: "1" },
      constituentVerified: { BOOL: false },
      verificationStatus: { S: "self_attested" },
      adultEligible: { BOOL: true },
    });
  });

  it("should persist optional feedback reasons", async () => {
    seedPii("user-1", { ...ADULT, constituentVerified: { BOOL: false }, verificationStatus: { S: "self_attested" } });

    const result = await vote({
      billId: "bill-123",
      feedback: "Nay",
      reasons: ["morals_values", "public_safety", "morals_values"],
    });

    expect(result.statusCode).toBe(200);
    expect(voteRow("user-1", "bill-123")).toMatchObject({
      feedback: { S: "Nay" },
      reasons: { SS: ["morals_values", "public_safety"] },
    });
  });

  it("should return 400 for invalid reasons payload", async () => {
    const result = await vote({ billId: "bill-123", feedback: "Yea", reasons: ["not_a_real_reason"] });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Invalid reasons value" });
    expect(send).not.toHaveBeenCalled();
  });

  it("should snapshot the verified stamp, with weight 1 (2C)", async () => {
    seedPii("user-1", {
      ...ADULT,
      constituentVerified: { BOOL: true },
      verificationStatus: { S: "likely_constituent" },
      resolvedState: { S: "CA" },
      resolvedDistrict: { S: "CA-12" },
    });

    const result = await vote({ billId: "bill-123", feedback: "Yea", userId: "user-1" });

    expect(result.statusCode).toBe(200);
    expect(voteRow("user-1", "bill-123")).toMatchObject({
      effectiveWeight: { N: "1" },
      constituentVerified: { BOOL: true },
      verificationStatus: { S: "likely_constituent" },
      resolvedState: { S: "CA" },
      resolvedDistrict: { S: "CA-12" },
      adultEligible: { BOOL: true },
    });
  });

  it("should snapshot bill metadata needed for civic honors", async () => {
    load(MANIFEST_ENV);
    seedManifestBill("bill-123", {
      civicProfile: { M: { localVsFederal: { N: "0.5" } } },
      lifeAreas: { L: [{ S: "Healthcare" }, { S: "Taxes" }] },
      subCategories: { L: [{ S: "Medicare" }] },
    });
    seedPii("user-1", { ...ADULT, constituentVerified: { BOOL: false }, verificationStatus: { S: "self_attested" } });

    const result = await vote({ billId: "bill-123", feedback: "Yea" });

    expect(result.statusCode).toBe(200);
    expect(voteRow("user-1", "bill-123")).toMatchObject({
      civicProfile: { M: { localVsFederal: { N: "0.5" } } },
      lifeAreas: { L: [{ S: "Healthcare" }, { S: "Taxes" }] },
      subCategories: { L: [{ S: "Medicare" }] },
    });
  });

  it("allows feedback when adult attestation is still unknown", async () => {
    seedPii("user-1", { constituentVerified: { BOOL: false } });

    const result = await vote({ billId: "bill-123", feedback: "Yea" });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ message: "Feedback submitted" });
  });

  it("returns 500 and stores nothing when the eligibility lookup fails", async () => {
    beforeCommand = (op) => {
      if (op === "GetItemCommand") throw new Error("DynamoDB unavailable");
    };

    const result = await vote({ billId: "bill-123", feedback: "Yea" });

    expect(result.statusCode).toBe(500);
    expect(calls()).toEqual([`GetItemCommand ${PII_TABLE}`]);
  });

  it("should return 403 ACCOUNT_INELIGIBLE when account deletion is completed", async () => {
    seedPii("user-1", { ...ADULT, deletionStatus: { S: "completed" }, constituentVerified: { BOOL: false } });

    const result = await vote({ billId: "bill-123", feedback: "Yea" });

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual(expect.objectContaining({ error: "ACCOUNT_INELIGIBLE" }));
  });

  it("rejects unknown bill ids when manifest validation is enabled", async () => {
    load(MANIFEST_ENV);

    const result = await vote({ billId: "missing-bill", feedback: "Yea" });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: "Unknown billId" });
    expect(calls()).toEqual([`GetItemCommand ${MANIFEST_TABLE}`]);
  });

  it("keeps a vote sent under a legacy suffixed id on the plain guid", async () => {
    jest.resetModules();
    process.env.TABLE_NAME = "test-table";
    process.env.PARTITION_KEY = "user_id";
    process.env.SORT_KEY = "bill_id";
    process.env.PII_TABLE_NAME = "pii-table";
    process.env.PII_PARTITION_KEY = "user_id";
    process.env.MANIFEST_TABLE_NAME = "manifest-table";
    process.env.MANIFEST_PRIMARY_KEY = "pk";
    process.env.MANIFEST_SORT_KEY = "sk";
    process.env.MANIFEST_GUID_LOOKUP_PK = "BILL_GUID";

    const { __mockSend: localMockSend }: { __mockSend: DynamoSend } = jest.requireMock("@aws-sdk/client-dynamodb");
    const { handler: handlerWithManifest } = require("../handlers/setFeedback");

    localMockSend
      .mockResolvedValueOnce({ Item: { manifestSk: { S: "2026-10-11T22:26:38.755Z#BILLS-119hr1181" } } })
      .mockResolvedValueOnce({ Item: { title: { S: "Protect Your Shopping Data" } } })
      .mockResolvedValueOnce({ Item: { adultStatus: { S: "attested_adult" }, constituentVerified: { BOOL: false } } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handlerWithManifest({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      body: JSON.stringify({ billId: "BILLS-119hr1181rh", feedback: "Yea" }),
    });

    expect(result.statusCode).toBe(200);
    const inputs = localMockSend.mock.calls.map(([command]) => command.input);
    expect(inputs[0]).toMatchObject({
      TableName: "manifest-table",
      Key: { pk: { S: "BILL_GUID" }, sk: { S: "BILLS-119hr1181" } },
    });
    expect(inputs[inputs.length - 1]).toMatchObject({
      TableName: "test-table",
      Item: { user_id: { S: "user-1" }, bill_id: { S: "BILLS-119hr1181" }, feedback: { S: "Yea" } },
    });
  });
});

describe("2C: every new vote row stores weight 1", () => {
  it("for verified and self-attested callers alike, whatever the old weight variables say", async () => {
    load({ VERIFIED_VOTE_WEIGHT: "1.25", SELF_ATTESTED_VOTE_WEIGHT: "0.5" });
    seedPii("verified", { ...ADULT, constituentVerified: { BOOL: true }, resolvedState: { S: "CA" } });
    seedPii("self", { ...ADULT, constituentVerified: { BOOL: false } });

    await vote({ billId: "bill-1", feedback: "Yea" }, "verified");
    await vote({ billId: "bill-1", feedback: "Nay" }, "self");

    expect(voteRow("verified", "bill-1")?.effectiveWeight).toEqual({ N: "1" });
    expect(voteRow("self", "bill-1")?.effectiveWeight).toEqual({ N: "1" });
  });
});

describe("INT-06: VOTE_DAILY_LIMIT vote writes per account per UTC day", () => {
  it("counts after the manifest and eligibility checks and before the vote write", async () => {
    load(MANIFEST_ENV);
    seedManifestBill("bill-123", {});
    seedPii("user-1", ADULT);

    expect((await vote({ billId: "bill-123", feedback: "Yea" })).statusCode).toBe(200);

    // The exact call sequence; the App Attest hook must leave it unchanged when it is off.
    expect(calls()).toEqual([
      `GetItemCommand ${MANIFEST_TABLE}`,
      `GetItemCommand ${MANIFEST_TABLE}`,
      `GetItemCommand ${PII_TABLE}`,
      `UpdateItemCommand ${PII_TABLE}`,
      `UpdateItemCommand ${PII_TABLE}`,
      `GetItemCommand ${FEEDBACK_TABLE}`,
      `PutItemCommand ${FEEDBACK_TABLE}`,
    ]);
    // Same day: one counter update.
    send.mockClear();
    expect((await vote({ billId: "bill-123", feedback: "Nay" })).statusCode).toBe(200);
    expect(calls()).toEqual([
      `GetItemCommand ${MANIFEST_TABLE}`,
      `GetItemCommand ${MANIFEST_TABLE}`,
      `GetItemCommand ${PII_TABLE}`,
      `UpdateItemCommand ${PII_TABLE}`,
      `GetItemCommand ${FEEDBACK_TABLE}`,
      `PutItemCommand ${FEEDBACK_TABLE}`,
    ]);
    expect(piiRow("user-1")).toMatchObject({ voteDay: { S: TODAY }, voteDayCount: { N: "2" } });
  });

  it("counts every accepted write: a new vote, a changed vote and an Abstain", async () => {
    seedPii("user-1", ADULT);

    await vote({ billId: "bill-1", feedback: "Yea" });
    await vote({ billId: "bill-1", feedback: "Nay" });
    await vote({ billId: "bill-2", feedback: "Abstain" });

    expect(piiRow("user-1")).toMatchObject({ voteDay: { S: TODAY }, voteDayCount: { N: "3" } });
    expect(
      integrityLines()
        .filter((line) => line.VotesCast === 1)
        .map((line) => line.voteDayCount),
    ).toEqual([1, 2, 3]);
  });

  it("creates the PII row of a user who has none, holding only the counter", async () => {
    const result = await vote({ billId: "bill-1", feedback: "Yea" }, "new-user");

    expect(result.statusCode).toBe(200);
    expect(piiRow("new-user")).toEqual({
      user_id: { S: "new-user" },
      voteDay: { S: TODAY },
      voteDayCount: { N: "1" },
    });
    expect(voteRow("new-user", "bill-1")).toMatchObject({
      constituentVerified: { BOOL: false },
      verificationStatus: { S: "self_attested" },
      adultEligible: { BOOL: true },
    });
  });

  it("starts each UTC day again at 1", async () => {
    load({ VOTE_DAILY_CAP_MODE: "enforce" });
    seedCount("user-1", 250, "2026-10-07");

    const result = await vote({ billId: "bill-1", feedback: "Yea" });

    expect(result.statusCode).toBe(200);
    expect(piiRow("user-1")).toMatchObject({ ...ADULT, voteDay: { S: TODAY }, voteDayCount: { N: "1" } });
  });

  describe("enforce", () => {
    beforeEach(() => load({ VOTE_DAILY_CAP_MODE: "enforce" }));

    it("allows the last write under the cap and refuses the next with 429 VOTE_DAILY_LIMIT and Retry-After", async () => {
      jest.setSystemTime(new Date("2026-10-08T23:59:30.000Z"));
      seedCount("user-1", VOTE_DAILY_LIMIT - 1);

      expect((await vote({ billId: "bill-last", feedback: "Yea" })).statusCode).toBe(200);
      const refused = await vote({ billId: "bill-over", feedback: "Yea" });

      expect(refused).toEqual({
        statusCode: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "30" },
        body: JSON.stringify({
          error: "VOTE_DAILY_LIMIT",
          message: `You've reached today's limit of ${VOTE_DAILY_LIMIT} votes. You can vote again after midnight UTC.`,
        }),
      });
      expect(voteRow("user-1", "bill-last")).toBeDefined();
      expect(voteRow("user-1", "bill-over")).toBeUndefined();
      expect(integrityLines().map(({ _aws, ...line }) => line)).toEqual([
        expect.objectContaining({ VotesCast: 1, voteDayCount: VOTE_DAILY_LIMIT, voteDailyCapMode: "enforce" }),
        expect.objectContaining({ VoteDailyCapExceeded: 1, voteDayCount: VOTE_DAILY_LIMIT + 1, outcome: "refused" }),
      ]);
    });

    it("answers 500 and writes nothing when the counter cannot be updated", async () => {
      seedPii("user-1", ADULT);
      beforeCommand = (op) => {
        if (op === "UpdateItemCommand") throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      };

      const result = await vote({ billId: "bill-1", feedback: "Yea" });

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ error: "Internal server error" });
      expect(puts()).toHaveLength(0);
      expect(integrityLines()).toEqual([expect.objectContaining({ VoteDailyCapError: 1 })]);
    });

    it("answers 500 when a concurrent reset makes both conditions fail and the retry fails too", async () => {
      seedCount("user-1", 5, "2026-10-07");
      let updates = 0;
      beforeCommand = (op) => {
        if (op !== "UpdateItemCommand") return;
        updates += 1;
        const row = piiRow("user-1")!;
        if (updates === 2) putRow(PII_TABLE, { ...row, voteDay: { S: TODAY } }, ["user_id"]);
        if (updates === 3) putRow(PII_TABLE, { ...row, voteDay: { S: "2026-10-07" } }, ["user_id"]);
      };

      const result = await vote({ billId: "bill-1", feedback: "Yea" });

      expect(result.statusCode).toBe(500);
      expect(counterUpdates()).toHaveLength(3);
      expect(puts()).toHaveLength(0);
    });
  });

  describe("watch", () => {
    it.each([
      ["unset", undefined],
      ["watch", "watch"],
      ["an unknown value", "block"],
    ])("never refuses with the mode %s: the first write over the cap is stored and reported", async (_label, mode) => {
      load({ VOTE_DAILY_CAP_MODE: mode });
      seedCount("user-1", VOTE_DAILY_LIMIT);

      const result = await vote({ billId: "bill-over", feedback: "Yea" });

      expect(result.statusCode).toBe(200);
      expect(voteRow("user-1", "bill-over")).toBeDefined();
      expect(integrityLines().map(({ _aws, ...line }) => line)).toEqual([
        expect.objectContaining({
          VoteDailyCapExceeded: 1,
          voteDayCount: VOTE_DAILY_LIMIT + 1,
          outcome: "would_refuse",
        }),
        expect.objectContaining({
          VotesCast: 1,
          voteDayCount: VOTE_DAILY_LIMIT + 1,
          voteDailyCapMode: "watch",
          userId: "user-1",
        }),
      ]);
    });

    it("stores the vote when the counter cannot be updated, and reports the failure", async () => {
      seedPii("user-1", ADULT);
      beforeCommand = (op) => {
        if (op === "UpdateItemCommand") throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      };

      const result = await vote({ billId: "bill-1", feedback: "Yea" });

      expect(result.statusCode).toBe(200);
      expect(voteRow("user-1", "bill-1")).toBeDefined();
      expect(integrityLines().map(({ _aws, ...line }) => line)).toEqual([
        expect.objectContaining({ VoteDailyCapError: 1 }),
        expect.objectContaining({ VotesCast: 1, voteDayCount: null }),
      ]);
    });

    it("recovers from a concurrent day reset (both conditions fail once)", async () => {
      seedCount("user-1", 5, "2026-10-07");
      let updates = 0;
      beforeCommand = (op) => {
        if (op !== "UpdateItemCommand") return;
        updates += 1;
        // Another request starts the day between this request's increment and its reset.
        if (updates === 2) seedCount("user-1", 1);
      };

      const result = await vote({ billId: "bill-1", feedback: "Yea" });

      expect(result.statusCode).toBe(200);
      expect(counterUpdates()).toHaveLength(3);
      expect(piiRow("user-1")).toMatchObject({ voteDay: { S: TODAY }, voteDayCount: { N: "2" } });
    });
  });

  describe("eligibility refuses before the counter, so no PII row is created or updated", () => {
    it.each([
      ["deletion in progress", { deletionStatus: { S: "in_progress" } }, "ACCOUNT_DELETION_IN_PROGRESS"],
      ["deletion completed", { deletionStatus: { S: "completed" } }, "ACCOUNT_INELIGIBLE"],
      ["self-reported under 18", { adultStatus: { S: "self_reported_under18" } }, "ACCOUNT_INELIGIBLE"],
    ] as const)("%s", async (_label, attributes, error) => {
      for (const mode of ["watch", "enforce"]) {
        load({ VOTE_DAILY_CAP_MODE: mode });
        seedPii("user-1", { ...ADULT, ...attributes });
        const before = piiRow("user-1");

        const result = await vote({ billId: "bill-1", feedback: "Yea" });

        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body).error).toBe(error);
        expect(counterUpdates()).toHaveLength(0);
        expect(piiRow("user-1")).toEqual(before);
        expect(puts()).toHaveLength(0);
      }
    });

    it("a deletion with no PII row left (the tombstone itself) gets no counter either", async () => {
      seedPii("user-1", { deletionStatus: { S: "completed" } });

      await vote({ billId: "bill-1", feedback: "Yea" });

      expect(piiRow("user-1")).toEqual({ user_id: { S: "user-1" }, deletionStatus: { S: "completed" } });
    });

    it("invalid bodies and unknown bills never reach the counter", async () => {
      load(MANIFEST_ENV);
      seedPii("user-1", ADULT);

      await vote({ billId: "bill-1", feedback: "Maybe" });
      await vote({ billId: "unknown", feedback: "Yea" });

      expect(counterUpdates()).toHaveLength(0);
      expect(piiRow("user-1")).toEqual({ user_id: { S: "user-1" }, ...ADULT });
    });

    it.each(["watch", "enforce"])(
      "a deletion that lands after the eligibility read is refused at the counter (%s)",
      async (mode) => {
        load({ VOTE_DAILY_CAP_MODE: mode });
        seedPii("user-1", ADULT);
        beforeCommand = (op, input) => {
          if (op === "UpdateItemCommand" && input.TableName === PII_TABLE && !piiRow("user-1")?.deletionStatus) {
            seedPii("user-1", { ...ADULT, deletionStatus: { S: "in_progress" } });
          }
        };

        const result = await vote({ billId: "bill-1", feedback: "Yea" });

        expect(result.statusCode).toBe(403);
        expect(JSON.parse(result.body).error).toBe("ACCOUNT_DELETION_IN_PROGRESS");
        expect(piiRow("user-1")).toEqual({ user_id: { S: "user-1" }, ...ADULT, deletionStatus: { S: "in_progress" } });
        expect(puts()).toHaveLength(0);
        expect(integrityLines()).toEqual([]);
      },
    );
  });
});

describe("a PII row holding only the vote counter", () => {
  /** GET /me and GET /district-verification, loaded against the same in-memory tables. */
  const loadReader = (path: string, env: EnvOverrides) => {
    const restore = applyTestEnv({ ...env });
    try {
      jest.resetModules();
      const { __mockSend: readerSend } = jest.requireMock("@aws-sdk/client-dynamodb");
      readerSend.mockReset();
      readerSend.mockImplementation(route);
      return require(path).handler as (event: unknown) => Promise<{ statusCode: number; body: string }>;
    } finally {
      restore();
    }
  };
  const asUser = (userId: string, extra: Record<string, unknown> = {}) => ({
    requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
    ...extra,
  });

  it("reads as an unverified, eligible user in SetFeedback, GET /district-verification and GET /me", async () => {
    const fetchMe = loadReader("../handlers/fetchMe", { TABLE_NAME: PII_TABLE, PARTITION_KEY: "user_id" });
    const districtVerification = loadReader("../handlers/districtVerification", {
      TABLE_NAME: PII_TABLE,
      PARTITION_KEY: "user_id",
      HASH_SALT_SECRET_ARN:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:Billboard/DistrictVerificationHashSalt-AbCdEf",
      IP_LOOKUP_ENABLED: "false",
    });
    const read = async (userId: string) => ({
      me: JSON.parse((await fetchMe(asUser(userId))).body),
      verification: JSON.parse((await districtVerification(asUser(userId, { httpMethod: "GET" }))).body),
    });
    const withoutRow = await read("new-user");
    // How an existing account that never verified reads today: its row holds no verification field.
    seedPii("never-verified", { updatedAt: { S: "2026-09-01T00:00:00.000Z" } });
    const neverVerified = await read("never-verified");

    load();
    expect((await vote({ billId: "bill-1", feedback: "Yea" }, "new-user")).statusCode).toBe(200);
    expect(piiRow("new-user")).toEqual({ user_id: { S: "new-user" }, voteDay: { S: TODAY }, voteDayCount: { N: "1" } });

    const withCounter = await read("new-user");
    // GET /me answers exactly as for a user with no row: not deleting, adult status unknown.
    expect(withCounter.me).toEqual(withoutRow.me);
    expect(withCounter.me).toMatchObject({
      userId: "new-user",
      deletionStatus: "not_requested",
      adultStatus: "unknown",
    });
    // GET /district-verification answers exactly as for any account that never verified: unverified,
    // no district, no limitReason.
    expect(withCounter.verification).toEqual(neverVerified.verification);
    expect(withCounter.verification).toMatchObject({ verified: false, repsSignalEligible: false });
    expect(withCounter.verification).not.toHaveProperty("resolved");
    expect(withCounter.verification).not.toHaveProperty("limitReason");
    expect(withoutRow.verification.verified).toBe(false);

    // SetFeedback: the next vote is accepted and stamped unverified and adult-eligible.
    expect((await vote({ billId: "bill-2", feedback: "Nay" }, "new-user")).statusCode).toBe(200);
    expect(voteRow("new-user", "bill-2")).toEqual({
      user_id: { S: "new-user" },
      bill_id: { S: "bill-2" },
      feedback: { S: "Nay" },
      votedAt: { S: NOW.toISOString() },
      firstVotedAt: { S: NOW.toISOString() },
      effectiveWeight: { N: "1" },
      constituentVerified: { BOOL: false },
      verificationStatus: { S: "self_attested" },
      adultEligible: { BOOL: true },
    });
  });
});

// ─── App Attest (INT-04, C3 3.4) ────────────────────────────────────────────────────────────────

describe("App Attest on POST /feedback (C3 3.4)", () => {
  const WATCH: EnvOverrides = { APP_ATTEST_TABLE_NAME: ATTEST_TABLE, APP_ATTEST_MODE: "watch" };
  const ENFORCE: EnvOverrides = { APP_ATTEST_TABLE_NAME: ATTEST_TABLE, APP_ATTEST_MODE: "enforce" };
  /** SetFeedback's calls for the first vote of a day with the manifest check on (the baseline). */
  const BASELINE_CALLS = [
    `GetItemCommand ${MANIFEST_TABLE}`,
    `GetItemCommand ${MANIFEST_TABLE}`,
    `GetItemCommand ${PII_TABLE}`,
    `UpdateItemCommand ${PII_TABLE}`,
    `UpdateItemCommand ${PII_TABLE}`,
    `GetItemCommand ${FEEDBACK_TABLE}`,
    `PutItemCommand ${FEEDBACK_TABLE}`,
  ];
  const throttled = () => Object.assign(new Error("throttled"), { name: "ThrottlingException" });

  let device: DeviceKey;
  let challengeSeed = 0;

  beforeAll(() => {
    device = generateDeviceKey();
  });

  const registerKey = (overrides: Partial<Parameters<typeof keyRow>[0]> = {}) =>
    attestTable.put(keyRow({ keyId: device.keyId, publicKeySpki: device.publicKeySpki, ...overrides }));

  /** A challenge as POST /app-attest/challenge stores it, valid for two more minutes. */
  const freshChallenge = (): string => {
    challengeSeed += 1;
    const challenge = challengeOf(`setFeedback-${challengeSeed}`);
    attestTable.put(challengeRow({ challenge, purpose: "assert", expiresAt: new Date(Date.now() + 120_000) }));
    return challenge;
  };

  /** The header R2 sends: a first assertion (counter 1) over these exact body bytes, POST and /feedback. */
  const signed = (body: string): string => {
    const clientData = requestClientData({ challenge: freshChallenge(), body });
    const assertion = signAssertion({
      privateKey: device.privateKey,
      authenticatorData: assertionAuthData({ counter: 1 }),
      clientData,
    });
    return assertionMarker({ keyId: device.keyId, clientData, assertion });
  };

  interface AttestedVote {
    body?: Record<string, unknown>;
    userId?: string;
    /** A header value, or a function of the exact body string (to sign it). */
    marker?: string | ((body: string) => string);
    appVersion?: string;
    groups?: unknown;
  }

  /** POST /feedback as API Gateway (REST proxy, Cognito authorizer) delivers it. */
  const attestedVote = (input: AttestedVote = {}) => {
    const body = JSON.stringify(input.body ?? { billId: "bill-1", feedback: "Yea" });
    const marker = typeof input.marker === "function" ? input.marker(body) : input.marker;
    return handler({
      httpMethod: "POST",
      resource: "/feedback",
      path: "/feedback",
      headers: {
        "Content-Type": "application/json",
        ...(marker !== undefined ? { "X-Billboard-App-Attest": marker } : {}),
        ...(input.appVersion !== undefined ? { "X-Billboard-App-Version": input.appVersion } : {}),
      },
      requestContext: {
        authorizer: {
          claims: {
            sub: input.userId ?? "user-1",
            ...(input.groups !== undefined ? { "cognito:groups": input.groups } : {}),
          },
        },
      },
      body,
    });
  };

  /** The BillBoard/AppAttest EMF lines written so far. */
  const attestLines = () =>
    logLines(logSpy).filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/AppAttest");
  const attestMetric = (name: string) => attestLines().filter((line) => line[name] === 1).length;
  /** The one "App Attest evaluated" line per request (AppAttestRequests, by Route and Outcome). */
  const evaluations = () => attestLines().filter((line) => line.message === "App Attest evaluated");
  const storedOutcome = (userId = "user-1", billId = "bill-1") => voteRow(userId, billId)?.appAttest;

  describe("off: no call, no vote-row attribute, no log line", () => {
    it.each<[string, EnvOverrides]>([
      ["no APP_ATTEST_* variable (the code default)", {}],
      ["APP_ATTEST_MODE=watch without APP_ATTEST_TABLE_NAME", { APP_ATTEST_MODE: "watch" }],
      ["APP_ATTEST_MODE=off", { APP_ATTEST_TABLE_NAME: ATTEST_TABLE, APP_ATTEST_MODE: "off" }],
      ["the table name without APP_ATTEST_MODE", { APP_ATTEST_TABLE_NAME: ATTEST_TABLE }],
    ])("%s, even for a request with an assertion and the blocking switches set", async (_label, env) => {
      load({ ...MANIFEST_ENV, ...env, APP_ATTEST_FAIL_CLOSED: "true", MIN_APP_VERSION: "9.0" });
      seedManifestBill("bill-1", {});
      seedPii("user-1", ADULT);
      registerKey();

      const result = await attestedVote({ marker: signed, appVersion: "1.0" });

      expect(result.statusCode).toBe(200);
      expect(calls()).toEqual(BASELINE_CALLS);
      expect(attestTable.calls).toEqual([]);
      expect(voteRow("user-1", "bill-1")).not.toHaveProperty("appAttest");
      expect(attestLines()).toEqual([]);
    });

    it("the handler module loads with no environment at all (C3 3.12)", async () => {
      load({ TABLE_NAME: undefined, PARTITION_KEY: undefined, SORT_KEY: undefined, PII_TABLE_NAME: undefined });

      expect(typeof handler).toBe("function");
      expect((await attestedVote({ body: {} })).statusCode).toBe(400);
    });
  });

  describe("watch: records the outcome and never blocks", () => {
    it("an old build (1.0, R1: no header) is stored as missing, with the call sequence unchanged", async () => {
      load({ ...MANIFEST_ENV, ...WATCH });
      seedManifestBill("bill-1", {});
      seedPii("user-1", ADULT);

      const result = await attestedVote();

      expect(result).toEqual({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Feedback submitted" }),
      });
      expect(calls()).toEqual(BASELINE_CALLS);
      expect(voteRow("user-1", "bill-1")).toEqual({
        user_id: { S: "user-1" },
        bill_id: { S: "bill-1" },
        feedback: { S: "Yea" },
        votedAt: { S: NOW.toISOString() },
        firstVotedAt: { S: NOW.toISOString() },
        effectiveWeight: { N: "1" },
        constituentVerified: { BOOL: false },
        verificationStatus: { S: "self_attested" },
        adultEligible: { BOOL: true },
        appAttest: { S: "missing" },
      });
      expect(attestLines()).toEqual([
        expect.objectContaining({
          message: "App Attest evaluated",
          AppAttestRequests: 1,
          Route: "feedback",
          Outcome: "missing",
          mode: "watch",
          blocked: false,
          wouldBlock: "APP_UPDATE_REQUIRED",
        }),
      ]);
      // C3 3.11: App Attest lines never carry a user ID.
      expect(JSON.stringify(attestLines())).not.toContain("user-1");
    });

    it("a valid assertion is verified, counted and bound after the eligibility check and before the INT-06 counter", async () => {
      load({ ...MANIFEST_ENV, ...WATCH });
      seedManifestBill("bill-1", {});
      seedPii("user-1", ADULT);
      registerKey();

      const result = await attestedVote({ marker: signed, appVersion: "2.0" });

      expect(result.statusCode).toBe(200);
      expect(calls()).toEqual([
        `GetItemCommand ${MANIFEST_TABLE}`,
        `GetItemCommand ${MANIFEST_TABLE}`,
        `GetItemCommand ${PII_TABLE}`,
        `UpdateItemCommand ${ATTEST_TABLE}`, // consume the challenge
        `GetItemCommand ${ATTEST_TABLE}`, // the key
        `UpdateItemCommand ${ATTEST_TABLE}`, // signCount
        `GetItemCommand ${ATTEST_TABLE}`, // the binding
        `TransactWriteItemsCommand ${ATTEST_TABLE}`, // a new binding and accountCount, together
        `UpdateItemCommand ${PII_TABLE}`,
        `UpdateItemCommand ${PII_TABLE}`,
        `GetItemCommand ${FEEDBACK_TABLE}`,
        `PutItemCommand ${FEEDBACK_TABLE}`,
      ]);
      expect(storedOutcome()).toEqual({ S: "valid" });
      expect(attestTable.get(keyItemKey(device.keyId))).toMatchObject({
        signCount: { N: "1" },
        accountCount: { N: "1" },
      });
      expect(attestTable.get(bindingItemKey("user-1", device.keyId))).toMatchObject({
        lastSeenAt: { S: NOW.toISOString() },
      });
      expect(attestLines()).toEqual([
        expect.objectContaining({ Outcome: "valid", environment: "production", appVersion: "2.0", blocked: false }),
      ]);
    });

    it("a retried request (the same header again) is a replay: stored as valid, the counter not moved again", async () => {
      load(WATCH);
      seedPii("user-1", ADULT);
      registerKey();
      const marker = signed(JSON.stringify({ billId: "bill-1", feedback: "Yea" }));

      expect((await attestedVote({ marker })).statusCode).toBe(200);
      expect((await attestedVote({ marker })).statusCode).toBe(200);

      expect(storedOutcome()).toEqual({ S: "valid" });
      expect(evaluations().map((line) => [line.Outcome, line.replay])).toEqual([
        ["valid", false],
        ["valid", true],
      ]);
      expect(attestTable.get(keyItemKey(device.keyId))).toMatchObject({
        signCount: { N: "1" },
        accountCount: { N: "1" },
      });
    });

    it.each<[string, string, () => AttestedVote]>([
      ["a development key", "development", () => (registerKey({ environment: "development" }), { marker: signed })],
      ["App Attest unsupported (v1.u)", "unsupported", () => ({ marker: "v1.u" })],
      ["the Debug bypass (v1.b)", "bypass", () => ({ marker: "v1.b" })],
      ["a client error (v1.e.keychain)", "client_error", () => ({ marker: "v1.e.keychain" })],
      ["a malformed header", "invalid", () => ({ marker: "v2.something" })],
      ["an unknown key", "invalid", () => ({ marker: signed })],
      ["a revoked key", "invalid", () => (registerKey({ status: "revoked" }), { marker: signed })],
      [
        "an assertion over another body",
        "invalid",
        () => (registerKey(), { marker: () => signed(JSON.stringify({ billId: "bill-1", feedback: "Nay" })) }),
      ],
    ])("%s is stored as %s and the vote goes through", async (_label, outcome, setup) => {
      for (const mode of ["watch", "an unknown value"]) {
        load({ ...WATCH, APP_ATTEST_MODE: mode });
        seedPii("user-1", ADULT);

        const result = await attestedVote(setup());

        expect(result.statusCode).toBe(200);
        expect(storedOutcome()).toEqual({ S: outcome });
        expect(evaluations().at(-1)).toMatchObject({ Outcome: outcome, mode: "watch", blocked: false });
      }
      expect(attestMetric("AppAttestInvalid")).toBe(outcome === "invalid" ? 2 : 0);
      expect(attestMetric("AppAttestRejected")).toBe(0);
    });

    it("one account more than the per-install limit is flagged over the limit, bound and stored", async () => {
      load(WATCH);
      seedPii("user-4", ADULT);
      registerKey({ accountCount: PER_KEY_LIMIT });

      const result = await attestedVote({ userId: "user-4", marker: signed });

      expect(result.statusCode).toBe(200);
      expect(storedOutcome("user-4")).toEqual({ S: "valid" });
      expect(attestTable.get(bindingItemKey("user-4", device.keyId))).toBeDefined();
      expect(attestTable.get(keyItemKey(device.keyId))).toMatchObject({
        accountCount: { N: String(PER_KEY_LIMIT + 1) },
      });
      expect(evaluations()).toEqual([expect.objectContaining({ Outcome: "valid", blocked: false })]);
      expect(attestLines()).toContainEqual(
        expect.objectContaining({ AppAttestOverLimit: 1, Kind: "install", blocked: false }),
      );
    });

    it("an app below MIN_APP_VERSION is only recorded", async () => {
      load({ ...WATCH, MIN_APP_VERSION: "2.0" });
      seedPii("user-1", ADULT);
      registerKey();

      const result = await attestedVote({ marker: signed, appVersion: "1.9" });

      expect(result.statusCode).toBe(200);
      expect(storedOutcome()).toEqual({ S: "valid" });
      expect(attestLines()).toEqual([expect.objectContaining({ wouldBlock: "APP_UPDATE_REQUIRED", blocked: false })]);
    });

    it("a failing App Attest table is outcome error: counted, and the vote is stored and counted", async () => {
      load({ ...WATCH, APP_ATTEST_FAIL_CLOSED: "true" });
      seedPii("user-1", ADULT);
      registerKey();
      beforeCommand = (_op, input) => {
        if (input.TableName === ATTEST_TABLE) throw throttled();
      };

      const result = await attestedVote({ marker: signed });

      expect(result.statusCode).toBe(200);
      expect(storedOutcome()).toEqual({ S: "error" });
      expect(piiRow("user-1")).toMatchObject({ voteDayCount: { N: "1" } });
      expect(attestMetric("AppAttestErrors")).toBe(1);
      expect(attestMetric("AppAttestRejected")).toBe(0);
    });

    it("a hung App Attest table is cut off at 1,500 ms and the vote is stored as error", async () => {
      load(WATCH);
      seedPii("user-1", ADULT);
      registerKey();
      attestTable.delayMs = 60_000;

      let settled = false;
      const pending = attestedVote({ marker: signed }).finally(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(1_499);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result.statusCode).toBe(200);
      expect(storedOutcome()).toEqual({ S: "error" });
      expect(evaluations()).toEqual([
        expect.objectContaining({ Outcome: "error", reason: "timeout", durationMs: 1_500 }),
      ]);
      // The budget aborted the first table call (the challenge consume); the key's counter never moved.
      expect(attestTable.calls.map((call) => call.command)).toEqual(["UpdateItemCommand"]);
      expect(attestTable.get(keyItemKey(device.keyId))).toMatchObject({ signCount: { N: "0" } });
    });
  });

  describe("enforce: the C3 3.4 decision table", () => {
    it.each<[string, number, string, EnvOverrides, () => AttestedVote]>([
      ["no header (builds 1.0 and R1)", 426, "APP_UPDATE_REQUIRED", {}, () => ({})],
      ["App Attest unsupported (v1.u)", 403, "APP_ATTEST_REQUIRED", {}, () => ({ marker: "v1.u" })],
      ["the Debug bypass (v1.b)", 403, "APP_ATTEST_REQUIRED", {}, () => ({ marker: "v1.b" })],
      ["a client error (v1.e.timeout)", 403, "APP_ATTEST_REQUIRED", {}, () => ({ marker: "v1.e.timeout" })],
      ["an unknown key", 403, "APP_ATTEST_UNKNOWN_KEY", {}, () => ({ marker: signed })],
      [
        "a revoked key",
        403,
        "APP_ATTEST_UNKNOWN_KEY",
        {},
        () => (registerKey({ status: "revoked" }), { marker: signed }),
      ],
      ["a malformed header", 403, "APP_ATTEST_FAILED", {}, () => ({ marker: "v1.a.one.two" })],
      [
        "an assertion over another body",
        403,
        "APP_ATTEST_FAILED",
        {},
        () => (registerKey(), { marker: () => signed(JSON.stringify({ billId: "bill-1", feedback: "Nay" })) }),
      ],
      [
        "a development key",
        403,
        "APP_ATTEST_FAILED",
        {},
        () => (registerKey({ environment: "development" }), { marker: signed }),
      ],
      [
        "a new account over the install's limit",
        403,
        "DEVICE_ACCOUNT_LIMIT",
        {},
        () => (registerKey({ accountCount: PER_KEY_LIMIT }), { marker: signed }),
      ],
      [
        "an app below MIN_APP_VERSION",
        426,
        "APP_UPDATE_REQUIRED",
        { MIN_APP_VERSION: "2.0" },
        () => (registerKey(), { marker: signed, appVersion: "1.9" }),
      ],
      [
        "a table failure with APP_ATTEST_FAIL_CLOSED=true",
        503,
        "APP_ATTEST_UNAVAILABLE",
        { APP_ATTEST_FAIL_CLOSED: "true" },
        () => {
          registerKey();
          beforeCommand = (_op, input) => {
            if (input.TableName === ATTEST_TABLE) throw throttled();
          };
          return { marker: signed };
        },
      ],
    ])("%s: %i %s, and nothing is written or counted", async (_label, status, code, env, setup) => {
      load({ ...ENFORCE, ...env, VOTE_DAILY_CAP_MODE: "enforce" });
      seedCount("user-1", 7);
      const pii = piiRow("user-1");

      const result = await attestedVote(setup());

      expect(result).toEqual({
        statusCode: status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: code }),
      });
      expect(puts()).toHaveLength(0);
      expect(counterUpdates()).toHaveLength(0);
      expect(piiRow("user-1")).toEqual(pii);
      expect(attestTable.get(bindingItemKey("user-1", device.keyId))).toBeUndefined();
      expect(integrityLines()).toEqual([]);
      expect(attestLines()).toContainEqual(expect.objectContaining({ AppAttestRejected: 1, route: "feedback", code }));
    });

    it.each<[string, string, EnvOverrides, () => AttestedVote]>([
      ["a valid production assertion", "valid", {}, () => (registerKey(), { marker: signed })],
      [
        "a development key when APP_ATTEST_ALLOWED_ENVIRONMENTS includes development",
        "development",
        { APP_ATTEST_ALLOWED_ENVIRONMENTS: "production,development" },
        () => (registerKey({ environment: "development" }), { marker: signed }),
      ],
      [
        "an account already bound to an install at the limit",
        "valid",
        {},
        () => {
          registerKey({ accountCount: PER_KEY_LIMIT });
          attestTable.put({
            ...bindingItemKey("user-1", device.keyId),
            firstSeenAt: { S: NOW.toISOString() },
            lastSeenAt: { S: NOW.toISOString() },
          });
          return { marker: signed };
        },
      ],
      [
        "an app at MIN_APP_VERSION",
        "valid",
        { MIN_APP_VERSION: "2.0" },
        () => (registerKey(), { marker: signed, appVersion: "2.0" }),
      ],
      [
        "a table failure (fails open by default)",
        "error",
        {},
        () => {
          registerKey();
          beforeCommand = (_op, input) => {
            if (input.TableName === ATTEST_TABLE) throw throttled();
          };
          return { marker: signed };
        },
      ],
    ])("%s is allowed and stored as %s", async (_label, outcome, env, setup) => {
      load({ ...ENFORCE, ...env });
      seedPii("user-1", ADULT);

      const result = await attestedVote(setup());

      expect(result.statusCode).toBe(200);
      expect(storedOutcome()).toEqual({ S: outcome });
      expect(piiRow("user-1")).toMatchObject({ voteDayCount: { N: "1" } });
      expect(attestMetric("AppAttestRejected")).toBe(0);
    });

    const EXEMPT = APP_ATTEST_DEFAULTS.exemptGroup;
    it.each<[string, unknown]>([
      ["a single group (REST authorizer string)", EXEMPT],
      ["a bracketed list", `[Editors ${EXEMPT}]`],
      ["a JSON array string", JSON.stringify(["Editors", EXEMPT])],
      ["an array", [EXEMPT]],
    ])("an exempt-group member is never blocked and still recorded (%s)", async (_label, groups) => {
      load(ENFORCE);
      seedPii("user-1", ADULT);

      const result = await attestedVote({ groups, marker: "v1.b" });

      expect(result.statusCode).toBe(200);
      expect(storedOutcome()).toEqual({ S: "bypass" });
      expect(attestLines()).toEqual([
        expect.objectContaining({ Outcome: "bypass", exempt: true, blocked: false, wouldBlock: "APP_ATTEST_REQUIRED" }),
      ]);
    });

    it("a retried request (the same header again) is accepted as a replay", async () => {
      load(ENFORCE);
      seedPii("user-1", ADULT);
      registerKey();
      const marker = signed(JSON.stringify({ billId: "bill-1", feedback: "Yea" }));

      expect((await attestedVote({ marker })).statusCode).toBe(200);
      expect((await attestedVote({ marker })).statusCode).toBe(200);
      expect(evaluations().map((line) => line.replay)).toEqual([false, true]);
    });

    it("decides before the INT-06 counter: a blocked vote never uses the day's quota", async () => {
      load({ ...ENFORCE, VOTE_DAILY_CAP_MODE: "enforce" });
      registerKey();
      seedCount("user-1", VOTE_DAILY_LIMIT - 1);

      expect((await attestedVote({ body: { billId: "bill-a", feedback: "Yea" } })).statusCode).toBe(426);
      expect((await attestedVote({ body: { billId: "bill-b", feedback: "Yea" }, marker: "v1.u" })).statusCode).toBe(
        403,
      );
      expect(piiRow("user-1")).toMatchObject({ voteDayCount: { N: String(VOTE_DAILY_LIMIT - 1) } });

      // The day's last write under the cap is still there for an attested vote.
      expect((await attestedVote({ body: { billId: "bill-c", feedback: "Yea" }, marker: signed })).statusCode).toBe(
        200,
      );
      expect(piiRow("user-1")).toMatchObject({ voteDayCount: { N: String(VOTE_DAILY_LIMIT) } });

      // At the limit, an unattested vote still gets the App Attest answer, not 429, and counts nothing.
      expect((await attestedVote({ body: { billId: "bill-d", feedback: "Yea" } })).statusCode).toBe(426);
      expect(piiRow("user-1")).toMatchObject({ voteDayCount: { N: String(VOTE_DAILY_LIMIT) } });
      expect(integrityLines().filter((line) => line.VoteDailyCapExceeded === 1)).toEqual([]);
      expect(voteRow("user-1", "bill-c")?.appAttest).toEqual({ S: "valid" });
      expect(["bill-a", "bill-b", "bill-d"].map((billId) => voteRow("user-1", billId))).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });
  });

  describe("requests refused before App Attest leave no App Attest state", () => {
    it.each([
      ["deletion in progress", { deletionStatus: { S: "in_progress" } }, "ACCOUNT_DELETION_IN_PROGRESS"],
      ["deletion completed", { deletionStatus: { S: "completed" } }, "ACCOUNT_INELIGIBLE"],
      ["self-reported under 18", { adultStatus: { S: "self_reported_under18" } }, "ACCOUNT_INELIGIBLE"],
    ] as const)(
      "%s: the eligibility 403 comes first, so no challenge is used and no install binding is written (X5)",
      async (_label, attributes, error) => {
        for (const env of [WATCH, ENFORCE]) {
          load(env);
          seedPii("user-1", { ...ADULT, ...attributes });
          registerKey();

          const result = await attestedVote({ marker: signed });

          expect(result.statusCode).toBe(403);
          expect(JSON.parse(result.body).error).toBe(error);
        }
        expect(attestTable.calls).toEqual([]);
        expect(attestTable.get(bindingItemKey("user-1", device.keyId))).toBeUndefined();
        expect(attestLines()).toEqual([]);
      },
    );

    it("a missing sign-in, an invalid body and an unknown bill are answered before App Attest", async () => {
      load({ ...MANIFEST_ENV, ...ENFORCE });
      seedPii("user-1", ADULT);
      registerKey();

      expect((await handler({ httpMethod: "POST", resource: "/feedback", body: "{}" })).statusCode).toBe(401);
      expect((await attestedVote({ body: { billId: "bill-1", feedback: "Maybe" } })).statusCode).toBe(400);
      expect((await attestedVote({ body: { billId: "unknown", feedback: "Yea" }, marker: signed })).statusCode).toBe(
        400,
      );
      expect(attestTable.calls).toEqual([]);
      expect(attestLines()).toEqual([]);
    });
  });
});

describe("INT-11: an Abstain from 1.0 or 1.1 on a Passed or Failed bill is stored as a dismissal", () => {
  const HOUSE = "BILLS-119hr1285";
  const SENATE = "BILLS-119s570";
  const OTHER = "BILLS-119hr77";
  const R2_HEADERS = { "X-Billboard-App-Version": "1.2" };

  const voteFrom = (body: Record<string, unknown>, headers?: Record<string, string>, userId = "user-1") =>
    handler({
      requestContext: { authorizer: { jwt: { claims: { sub: userId } } } },
      ...(headers ? { headers } : {}),
      body: JSON.stringify(body),
    });
  const seedGroups = (enabled = true) =>
    putRow(
      MANIFEST_TABLE,
      {
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "1" },
        enabled: { BOOL: enabled },
        pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
      },
      ["pk", "sk"],
    );
  const groupReads = () => send.mock.calls.filter(([command]) => command.input?.Key?.pk?.S === "BILL_COMPANION_GROUPS");
  const dismissMetricLines = () =>
    logLines(logSpy).filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Metrics?.[0]?.Name === "LegacyDismissStored");

  beforeEach(() => {
    load(MANIFEST_ENV);
    seedPii("user-1", ADULT);
  });

  it.each(["Passed", "Failed"])(
    "marks a 1.0 or 1.1 Abstain on a %s bill, keeps the rest of the row, and counts it without the user",
    async (billStatus) => {
      seedManifestBill(OTHER, { billStatus: { S: billStatus } });

      const result = await voteFrom({ billId: OTHER, feedback: "Abstain" });

      expect(result.statusCode).toBe(200);
      expect(voteRow("user-1", OTHER)).toMatchObject({ feedback: { S: "Abstain" }, legacyDismiss: { BOOL: true } });
      // The bill's own status settles it: the groups are not read.
      expect(groupReads()).toHaveLength(0);
      expect(dismissMetricLines()).toHaveLength(1);
      expect(JSON.stringify(dismissMetricLines())).not.toContain("user-1");
    },
  );

  it.each([
    ["a Yea from 1.1", { billId: OTHER, feedback: "Yea" }, undefined],
    ["a Nay from 1.1", { billId: OTHER, feedback: "Nay" }, undefined],
    ["an Abstain from 1.2", { billId: OTHER, feedback: "Abstain" }, R2_HEADERS],
    [
      "an Abstain from 1.2 (lower-case header)",
      { billId: OTHER, feedback: "Abstain" },
      { "x-billboard-app-version": "1.2.1" },
    ],
  ])("never marks %s on a Passed bill, and reads no groups", async (_label, body, headers) => {
    seedManifestBill(OTHER, { billStatus: { S: "Passed" } });

    expect((await voteFrom(body, headers)).statusCode).toBe(200);

    expect(voteRow("user-1", OTHER)?.legacyDismiss).toBeUndefined();
    expect(voteRow("user-1", OTHER)?.feedback).toEqual({ S: body.feedback });
    expect(groupReads()).toHaveLength(0);
    expect(dismissMetricLines()).toEqual([]);
  });

  it.each(["New", "Updated", "Finalized", undefined])(
    "does not mark a 1.1 Abstain on an ungrouped bill whose status is %p",
    async (billStatus) => {
      seedGroups();
      seedManifestBill(OTHER, billStatus ? { billStatus: { S: billStatus } } : {});

      expect((await voteFrom({ billId: OTHER, feedback: "Abstain" })).statusCode).toBe(200);

      expect(voteRow("user-1", OTHER)?.legacyDismiss).toBeUndefined();
      expect(groupReads()).toHaveLength(1);
    },
  );

  // 1.1 writes a group's Abstain to the vote target, the House primary, also when it was the Senate member that
  // passed and was dismissed in Updates.
  it("marks a 1.1 Abstain on the New House primary when its Senate companion has passed", async () => {
    seedGroups();
    seedManifestBill(HOUSE, { billStatus: { S: "New" } });
    seedManifestBill(SENATE, { billStatus: { S: "Passed" } });

    expect((await voteFrom({ billId: HOUSE, feedback: "Abstain" })).statusCode).toBe(200);

    expect(voteRow("user-1", HOUSE)?.legacyDismiss).toEqual({ BOOL: true });
  });

  // 1.1 writes a group's dismissal only to the primary (and none while a member holds a vote); 1.0 knows no groups but
  // merges a House and a Senate bill into one card under the House guid, so it too writes on the House bill. So an
  // Abstain on the other member is judged by that member's own status, and its companion's status is never read.
  it("does not mark a 1.0 or 1.1 Abstain on the New Senate member when its House primary has passed", async () => {
    seedGroups();
    seedManifestBill(HOUSE, { billStatus: { S: "Passed" } });
    seedManifestBill(SENATE, { billStatus: { S: "New" } });

    expect((await voteFrom({ billId: SENATE, feedback: "Abstain" })).statusCode).toBe(200);

    expect(voteRow("user-1", SENATE)).toMatchObject({ feedback: { S: "Abstain" } });
    expect(voteRow("user-1", SENATE)?.legacyDismiss).toBeUndefined();
    expect(dismissMetricLines()).toEqual([]);
    expect(send.mock.calls.filter(([command]) => command.input?.Key?.sk?.S === HOUSE)).toEqual([]);
  });

  it("marks a 1.0 Abstain on the Senate member when that member has itself passed", async () => {
    seedGroups();
    seedManifestBill(HOUSE, { billStatus: { S: "New" } });
    seedManifestBill(SENATE, { billStatus: { S: "Passed" } });

    expect((await voteFrom({ billId: SENATE, feedback: "Abstain" })).statusCode).toBe(200);

    expect(voteRow("user-1", SENATE)?.legacyDismiss).toEqual({ BOOL: true });
  });

  it("does not mark it while both members are New, or while the groups are off", async () => {
    seedGroups();
    seedManifestBill(HOUSE, { billStatus: { S: "New" } });
    seedManifestBill(SENATE, { billStatus: { S: "New" } });
    expect((await voteFrom({ billId: HOUSE, feedback: "Abstain" })).statusCode).toBe(200);
    expect(voteRow("user-1", HOUSE)?.legacyDismiss).toBeUndefined();

    load(MANIFEST_ENV);
    seedGroups(false);
    seedManifestBill(SENATE, { billStatus: { S: "Passed" } });
    expect((await voteFrom({ billId: HOUSE, feedback: "Abstain" })).statusCode).toBe(200);
    expect(voteRow("user-1", HOUSE)?.legacyDismiss).toBeUndefined();
  });

  it("reads the groups at most once a minute", async () => {
    seedGroups();
    seedManifestBill(OTHER, { billStatus: { S: "New" } });

    await voteFrom({ billId: OTHER, feedback: "Abstain" });
    await voteFrom({ billId: OTHER, feedback: "Abstain" });
    expect(groupReads()).toHaveLength(1);

    jest.advanceTimersByTime(60_000);
    await voteFrom({ billId: OTHER, feedback: "Abstain" });
    expect(groupReads()).toHaveLength(2);
  });

  it.each([
    ["the groups", (input: DynamoInput) => input.Key?.pk?.S === "BILL_COMPANION_GROUPS"],
    ["the companion's manifest row", (input: DynamoInput) => input.Key?.sk?.S === SENATE],
  ])("answers 500 and stores nothing when %s cannot be read", async (_label, failing) => {
    seedGroups();
    seedManifestBill(HOUSE, { billStatus: { S: "New" } });
    seedManifestBill(SENATE, { billStatus: { S: "Passed" } });
    beforeCommand = (_op, input) => {
      if (failing(input)) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    };

    const result = await voteFrom({ billId: HOUSE, feedback: "Abstain" });

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: "Internal server error" });
    expect(voteRow("user-1", HOUSE)).toBeUndefined();
    // Refused before the INT-06 counter, so the refused write uses none of the day's quota.
    expect(counterUpdates()).toHaveLength(0);
  });

  it("a later Yea, or an Abstain from 1.2, replaces the marked row without the mark", async () => {
    seedManifestBill(OTHER, { billStatus: { S: "Passed" } });

    await voteFrom({ billId: OTHER, feedback: "Abstain" });
    expect(voteRow("user-1", OTHER)?.legacyDismiss).toEqual({ BOOL: true });
    await voteFrom({ billId: OTHER, feedback: "Yea" });
    expect(voteRow("user-1", OTHER)?.legacyDismiss).toBeUndefined();

    await voteFrom({ billId: OTHER, feedback: "Abstain" });
    expect(voteRow("user-1", OTHER)?.legacyDismiss).toEqual({ BOOL: true });
    await voteFrom({ billId: OTHER, feedback: "Abstain" }, R2_HEADERS);
    expect(voteRow("user-1", OTHER)).toMatchObject({ feedback: { S: "Abstain" } });
    expect(voteRow("user-1", OTHER)?.legacyDismiss).toBeUndefined();
  });

  describe("REL-50: a bill repair:failed-status put right from a false Failed", () => {
    const markFormerlyFailed = (billId: string) =>
      putRow(
        MANIFEST_TABLE,
        { pk: { S: "BILL_FORMERLY_FAILED" }, sk: { S: billId }, guid: { S: billId }, rule: { S: "REL-50" } },
        ["pk", "sk"],
      );
    const markerReads = () =>
      send.mock.calls.filter(([command]) => command.input?.Key?.pk?.S === "BILL_FORMERLY_FAILED");

    // 1.1 never lowers a status it holds, so a device that held the bill as Failed still offers Dismiss in Updates.
    it("marks a 1.0 or 1.1 Abstain on the now New bill as a dismissal, and reads no groups", async () => {
      seedGroups();
      seedManifestBill(OTHER, { billStatus: { S: "New" } });
      markFormerlyFailed(OTHER);

      expect((await voteFrom({ billId: OTHER, feedback: "Abstain" })).statusCode).toBe(200);

      expect(voteRow("user-1", OTHER)).toMatchObject({ feedback: { S: "Abstain" }, legacyDismiss: { BOOL: true } });
      expect(dismissMetricLines()).toHaveLength(1);
      expect(markerReads()).toHaveLength(1);
      expect(groupReads()).toHaveLength(0);
    });

    it("marks a 1.1 Abstain on the House primary whose Senate companion was put right", async () => {
      seedGroups();
      seedManifestBill(HOUSE, { billStatus: { S: "New" } });
      seedManifestBill(SENATE, { billStatus: { S: "New" } });
      markFormerlyFailed(SENATE);

      expect((await voteFrom({ billId: HOUSE, feedback: "Abstain" })).statusCode).toBe(200);

      expect(voteRow("user-1", HOUSE)?.legacyDismiss).toEqual({ BOOL: true });
    });

    it("never marks a Yea, an Abstain from 1.2, or an Abstain on an unmarked bill, and reads no marker for a vote", async () => {
      seedManifestBill(OTHER, { billStatus: { S: "New" } });
      markFormerlyFailed(OTHER);
      seedManifestBill(HOUSE, { billStatus: { S: "New" } });

      await voteFrom({ billId: OTHER, feedback: "Yea" });
      await voteFrom({ billId: OTHER, feedback: "Abstain" }, R2_HEADERS);
      expect(voteRow("user-1", OTHER)?.legacyDismiss).toBeUndefined();
      expect(markerReads()).toHaveLength(0);

      expect((await voteFrom({ billId: HOUSE, feedback: "Abstain" })).statusCode).toBe(200);
      expect(voteRow("user-1", HOUSE)?.legacyDismiss).toBeUndefined();
      expect(markerReads()).toHaveLength(1);
    });

    it("answers 500 and stores nothing when the marker cannot be read", async () => {
      seedManifestBill(OTHER, { billStatus: { S: "New" } });
      beforeCommand = (_op, input) => {
        if (input.Key?.pk?.S === "BILL_FORMERLY_FAILED") {
          throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
        }
      };

      const result = await voteFrom({ billId: OTHER, feedback: "Abstain" });

      expect(result.statusCode).toBe(500);
      expect(voteRow("user-1", OTHER)).toBeUndefined();
      expect(counterUpdates()).toHaveLength(0);
    });
  });

  it("marks nothing and reads nothing more without the manifest table", async () => {
    load();

    expect((await voteFrom({ billId: OTHER, feedback: "Abstain" })).statusCode).toBe(200);

    expect(voteRow("user-1", OTHER)?.legacyDismiss).toBeUndefined();
    expect(calls()).not.toContain(`GetItemCommand ${MANIFEST_TABLE}`);
  });
});

describe("INT-11, project decision 2026-10-17: Congress deciding a bill does not end voting", () => {
  // POST /feedback accepts Yea, Nay and Abstain on a Passed, Failed or Became law (Finalized) bill, and GET
  // /bill-stats then serves that voter the bill's results. Both handlers run on the same tables.
  const BILL = "BILLS-119hr4410";
  const HOUSE = "BILLS-119hr1285";
  const SENATE = "BILLS-119s570";
  const STATS_TABLE = "stats-table";
  const RESULTS_ENV: EnvOverrides = {
    ...MANIFEST_ENV,
    FEEDBACK_TABLE_NAME: FEEDBACK_TABLE,
    FEEDBACK_PARTITION_KEY: "user_id",
    FEEDBACK_SORT_KEY: "bill_id",
    STATS_TABLE_NAME: STATS_TABLE,
    STATS_PARTITION_KEY: "billId",
  };
  const R2_HEADERS = { "X-Billboard-App-Version": "1.2" };
  const DECIDED = ["Passed", "Failed", "Finalized"];
  const CHOICES = ["Yea", "Nay", "Abstain"];

  let seeded: SeededResults;
  let fetchBillStats: (event: unknown) => Promise<{ statusCode: number; body: string }>;

  beforeAll(async () => {
    // Other users' votes on the bill, and its stats row as BillStatsAggregator stores it.
    seeded = await seedResults(
      BILL,
      { verified: [512, 287, 103], selfAttested: [344, 198, 121] },
      { userId: "user_id", billId: "bill_id" },
    );
  });

  beforeEach(() => {
    load(RESULTS_ENV);
    fetchBillStats = require("../handlers/fetchBillStats").handler;
    seedPii("user-1", ADULT);
    for (const row of seeded.feedbackRows) putRow(FEEDBACK_TABLE, row, ["user_id", "bill_id"]);
    putRow(STATS_TABLE, seeded.statsItem, ["billId"]);
  });

  const voteFrom = (body: Record<string, unknown>, headers?: Record<string, string>) =>
    handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      ...(headers ? { headers } : {}),
      body: JSON.stringify(body),
    });
  const results = (billId: string, scope?: string) =>
    fetchBillStats({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      queryStringParameters: { billId, ...(scope ? { scope } : {}) },
    });
  const expectLocked = async (billId: string) => {
    for (const scope of [undefined, "companions"]) {
      const response = await results(billId, scope);
      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({ error: "RESULTS_LOCKED" });
    }
  };
  const expectUnlocked = async (billId: string) => {
    for (const scope of [undefined, "companions"]) {
      const response = await results(billId, scope);
      expect(response.statusCode).toBe(200);
      if (billId === BILL) expect(JSON.parse(response.body).totals).toEqual(seeded.stats.totals);
    }
  };
  const { isCountedVote } = jest.requireActual("../shared/billStats");

  it.each(DECIDED.flatMap((billStatus) => CHOICES.map((feedback) => [feedback, billStatus])))(
    "1.2 and later: a %s on a %s bill is stored as a vote, counted, and unlocks the results",
    async (feedback, billStatus) => {
      seedManifestBill(BILL, { billStatus: { S: billStatus } });
      await expectLocked(BILL);

      const response = await voteFrom({ billId: BILL, feedback }, R2_HEADERS);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ message: "Feedback submitted" });
      const row = voteRow("user-1", BILL);
      expect(row).toMatchObject({ feedback: { S: feedback }, adultEligible: { BOOL: true } });
      expect(row?.legacyDismiss).toBeUndefined();
      // BillStatsAggregator counts it in the bill's results, and it is the day's first vote write (INT-06).
      expect(isCountedVote(row)).toBe(true);
      expect(piiRow("user-1")?.voteDayCount).toEqual({ N: "1" });
      await expectUnlocked(BILL);
    },
  );

  it.each(DECIDED.flatMap((billStatus) => ["Yea", "Nay"].map((feedback) => [feedback, billStatus])))(
    "1.0 and 1.1: a %s on a %s bill is stored as a vote and unlocks the results",
    async (feedback, billStatus) => {
      seedManifestBill(BILL, { billStatus: { S: billStatus } });

      expect((await voteFrom({ billId: BILL, feedback })).statusCode).toBe(200);

      expect(voteRow("user-1", BILL)?.legacyDismiss).toBeUndefined();
      await expectUnlocked(BILL);
    },
  );

  it("1.0 and 1.1: an Abstain on a Became law bill is a vote (those builds dismiss only Passed and Failed bills)", async () => {
    seedManifestBill(BILL, { billStatus: { S: "Finalized" } });

    expect((await voteFrom({ billId: BILL, feedback: "Abstain" })).statusCode).toBe(200);

    expect(voteRow("user-1", BILL)?.legacyDismiss).toBeUndefined();
    await expectUnlocked(BILL);
  });

  it.each(["Passed", "Failed"])(
    "1.0 and 1.1: an Abstain on a %s bill is accepted and stored, as a dismissal that keeps the results locked until a Yea or Nay",
    async (billStatus) => {
      seedManifestBill(BILL, { billStatus: { S: billStatus } });

      // Not refused: the write is stored (the old build sees the bill as handled), only as a dismissal.
      expect((await voteFrom({ billId: BILL, feedback: "Abstain" })).statusCode).toBe(200);
      expect(voteRow("user-1", BILL)).toMatchObject({ feedback: { S: "Abstain" }, legacyDismiss: { BOOL: true } });
      await expectLocked(BILL);

      expect((await voteFrom({ billId: BILL, feedback: "Nay" })).statusCode).toBe(200);
      await expectUnlocked(BILL);
    },
  );

  it("a vote on the decided member of a companion pair unlocks the other member, whose own status is New", async () => {
    putRow(
      MANIFEST_TABLE,
      {
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "1" },
        enabled: { BOOL: true },
        pairs: { S: JSON.stringify([[HOUSE, SENATE]]) },
      },
      ["pk", "sk"],
    );
    seedManifestBill(HOUSE, { billStatus: { S: "New" } });
    seedManifestBill(SENATE, { billStatus: { S: "Passed" } });
    await expectLocked(HOUSE);

    expect((await voteFrom({ billId: SENATE, feedback: "Abstain" }, R2_HEADERS)).statusCode).toBe(200);

    expect(voteRow("user-1", SENATE)?.legacyDismiss).toBeUndefined();
    await expectUnlocked(HOUSE);
    await expectUnlocked(SENATE);
  });
});

export {};

describe("UX-31: a vote keeps the time of the first vote on its bill", () => {
  const BILL = "BILLS-119hr4410";
  const EARLIER = "2026-09-20T14:00:00.000Z";
  const R2_HEADERS = { "X-Billboard-App-Version": "1.2" };
  const voteFrom = (body: Record<string, unknown>, headers?: Record<string, string>) =>
    handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
      ...(headers ? { headers } : {}),
      body: JSON.stringify(body),
    });
  const seedVote = (attributes: Item) =>
    putRow(FEEDBACK_TABLE, { user_id: { S: "user-1" }, bill_id: { S: BILL }, ...attributes }, ["user_id", "bill_id"]);

  beforeEach(() => {
    load(MANIFEST_ENV);
    seedPii("user-1", ADULT);
    seedManifestBill(BILL, { billStatus: { S: "Passed" } });
  });

  it("stamps a first vote with its time, and keeps it when the vote changes", async () => {
    expect((await voteFrom({ billId: BILL, feedback: "Yea" }, R2_HEADERS)).statusCode).toBe(200);
    expect(voteRow("user-1", BILL)?.firstVotedAt).toEqual({ S: NOW.toISOString() });

    jest.setSystemTime(new Date("2026-10-12T09:00:00.000Z"));
    expect((await voteFrom({ billId: BILL, feedback: "Abstain" }, R2_HEADERS)).statusCode).toBe(200);
    expect(voteRow("user-1", BILL)).toMatchObject({
      feedback: { S: "Abstain" },
      votedAt: { S: "2026-10-12T09:00:00.000Z" },
      firstVotedAt: { S: NOW.toISOString() },
    });
  });

  it("reads the earlier row strongly consistent, by the caller's key, right before the write", async () => {
    await voteFrom({ billId: BILL, feedback: "Nay" }, R2_HEADERS);

    expect(calls().slice(-2)).toEqual([`GetItemCommand ${FEEDBACK_TABLE}`, `PutItemCommand ${FEEDBACK_TABLE}`]);
    const read = send.mock.calls.find(
      ([command]) => command.constructor.name === "GetItemCommand" && command.input.TableName === FEEDBACK_TABLE,
    )![0].input;
    expect(read).toMatchObject({
      Key: { user_id: { S: "user-1" }, bill_id: { S: BILL } },
      ConsistentRead: true,
      ProjectionExpression: "feedback, votedAt, #firstVotedAt, #legacyDismiss",
    });
  });

  it("takes votedAt as the first time of a vote stored before UX-31, the best time known", async () => {
    seedVote({ feedback: { S: "Yea" }, votedAt: { S: EARLIER } });

    await voteFrom({ billId: BILL, feedback: "Nay" }, R2_HEADERS);

    expect(voteRow("user-1", BILL)).toMatchObject({
      feedback: { S: "Nay" },
      votedAt: { S: NOW.toISOString() },
      firstVotedAt: { S: EARLIER },
    });
  });

  it("marks a vote from before votes were timed as having no first time, so changing it adds no day", async () => {
    seedVote({ feedback: { S: "Yea" } });

    await voteFrom({ billId: BILL, feedback: "Nay" }, R2_HEADERS);
    expect(voteRow("user-1", BILL)?.firstVotedAt).toEqual({ NULL: true });

    await voteFrom({ billId: BILL, feedback: "Yea" }, R2_HEADERS);
    expect(voteRow("user-1", BILL)?.firstVotedAt).toEqual({ NULL: true });
  });

  it("gives a 1.0 or 1.1 dismissal no first time, and the vote after it its own", async () => {
    // 1.1 (no header) dismissing a Passed bill in Updates.
    await voteFrom({ billId: BILL, feedback: "Abstain" });
    expect(voteRow("user-1", BILL)).toMatchObject({ legacyDismiss: { BOOL: true } });
    expect(voteRow("user-1", BILL)?.firstVotedAt).toBeUndefined();

    jest.setSystemTime(new Date("2026-10-12T09:00:00.000Z"));
    await voteFrom({ billId: BILL, feedback: "Yea" });
    expect(voteRow("user-1", BILL)?.firstVotedAt).toEqual({ S: "2026-10-12T09:00:00.000Z" });
  });

  it("keeps the first time through a dismissal written over a vote", async () => {
    seedVote({ feedback: { S: "Nay" }, votedAt: { S: "2026-10-01T10:00:00.000Z" }, firstVotedAt: { S: EARLIER } });

    await voteFrom({ billId: BILL, feedback: "Abstain" });
    expect(voteRow("user-1", BILL)).toMatchObject({ legacyDismiss: { BOOL: true }, firstVotedAt: { S: EARLIER } });

    await voteFrom({ billId: BILL, feedback: "Yea" });
    expect(voteRow("user-1", BILL)?.firstVotedAt).toEqual({ S: EARLIER });
  });

  it("answers 500 and stores nothing when the earlier row cannot be read", async () => {
    seedVote({ feedback: { S: "Yea" }, votedAt: { S: EARLIER } });
    beforeCommand = (op, input) => {
      if (op === "GetItemCommand" && input.TableName === FEEDBACK_TABLE) {
        throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
      }
    };

    const result = await voteFrom({ billId: BILL, feedback: "Nay" }, R2_HEADERS);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: "Internal server error" });
    expect(voteRow("user-1", BILL)).toEqual({
      user_id: { S: "user-1" },
      bill_id: { S: BILL },
      feedback: { S: "Yea" },
      votedAt: { S: EARLIER },
    });
    expect(puts()).toHaveLength(0);
    // F2: the 500 is returned, not thrown, so only this metric (and its alarm) shows it.
    const metric = logLines(logSpy).find((line) => line.EarlierVoteReadFailed === 1);
    expect(metric?._aws?.CloudWatchMetrics?.[0]?.Namespace).toBe("BillBoard/BillStats");
  });
});
