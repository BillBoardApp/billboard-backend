import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { RestampConfig, VoteRestampMode } from "../handlers/restampUserVotes";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { asSqsEvent } from "./fixtures/awsEvents";
import { logLines } from "./logLines";

/*
 * RestampUserVotes (INT-03 re-stamp, C2 3.3.4 with X8). UserPII and UserFeedback are held in
 * memory; UpdateItem honours the exact condition sent, so a vote deleted between the Query and the
 * update is seen as DynamoDB would see it. VOTE_RESTAMP_MODE=apply writes; anything else is plan,
 * which must send no UpdateItem at all.
 */

type Row = Record<string, AttributeValue>;

/** Every input field the fake DynamoDB reads, across the commands it answers. */
interface FakeInput extends ConditionInput {
  Key?: Row;
  ExclusiveStartKey?: Row;
  UpdateExpression?: string;
}

/** What the fake reads from an AWS SDK command: its class's name and its input. */
interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

type Call = { name: string; input: FakeInput };

const mockPii = new Map<string, Row>();
const mockVotes = new Map<string, Row>();
const mockCalls: Call[] = [];
const mockState = {
  pageSize: 1000,
  inFlight: 0,
  maxInFlight: 0,
  updateDelayMs: 0,
  failUpdateFor: undefined as string | undefined,
  beforeUpdate: undefined as ((billId: string) => void) | undefined,
};

const mockApplyUpdate = (row: Row, input: FakeInput): Row => {
  const values = input.ExpressionAttributeValues!;
  const match = /^SET (.+?)(?: REMOVE (.+))?$/.exec(input.UpdateExpression!)!;
  const next = { ...row };
  for (const assignment of match[1].split(", ")) {
    const [name, token] = assignment.split(" = ");
    next[name] = values[token];
  }
  for (const name of match[2]?.split(", ") ?? []) delete next[name];
  return next;
};

const mockSend = async (command: FakeCommand): Promise<Record<string, unknown>> => {
  const name: string = command.constructor.name;
  const input = command.input;
  mockCalls.push({ name, input });
  switch (name) {
    case "GetItemCommand":
      return { Item: mockPii.get(input.Key!.userId.S!) };
    case "QueryCommand": {
      const userId = input.ExpressionAttributeValues![":pk"].S;
      const rows = [...mockVotes.values()]
        .filter((row) => row.userId.S === userId)
        .sort((a, b) => a.billId.S!.localeCompare(b.billId.S!));
      const start = input.ExclusiveStartKey
        ? rows.findIndex((row) => row.billId.S === input.ExclusiveStartKey!.billId.S) + 1
        : 0;
      const page = rows.slice(start, start + mockState.pageSize);
      const last = page[page.length - 1];
      return {
        Items: page.map((row) => ({ ...row })),
        LastEvaluatedKey:
          start + mockState.pageSize < rows.length && last ? { userId: last.userId, billId: last.billId } : undefined,
      };
    }
    case "UpdateItemCommand": {
      const billId = input.Key!.billId.S!;
      mockState.beforeUpdate?.(billId);
      mockState.inFlight += 1;
      mockState.maxInFlight = Math.max(mockState.maxInFlight, mockState.inFlight);
      try {
        if (mockState.updateDelayMs) await new Promise((resolve) => setTimeout(resolve, mockState.updateDelayMs));
        if (mockState.failUpdateFor === billId)
          throw Object.assign(new Error("Throttled"), { name: "ThrottlingException" });
        const key = `${input.Key!.userId.S}|${billId}`;
        const current = mockVotes.get(key);
        if (!evaluateCondition(current, input)) throw conditionalCheckFailed();
        mockVotes.set(key, mockApplyUpdate(current!, input));
        return {};
      } finally {
        mockState.inFlight -= 1;
      }
    }
    default:
      throw new Error(`Unexpected DynamoDB call ${name}`);
  }
};

jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
}));

const ENV = {
  PII_TABLE_NAME: "UserPII",
  FEEDBACK_TABLE_NAME: "UserFeedback",
};
const originalEnv = { ...process.env };

const { handler, restampConfigFromEnv, voteRestampMode, RESTAMP_UPDATE_CONCURRENCY } =
  require("../handlers/restampUserVotes") as {
    handler: (event: SQSEvent) => Promise<SQSBatchResponse>;
    restampConfigFromEnv: (env?: Record<string, string | undefined>) => RestampConfig;
    voteRestampMode: (value?: string) => VoteRestampMode;
    RESTAMP_UPDATE_CONCURRENCY: number;
  };

const verifiedVote = (userId: string, billId: string, overrides: Row = {}): Row => ({
  userId: { S: userId },
  billId: { S: billId },
  feedback: { S: "Yea" },
  constituentVerified: { BOOL: true },
  verificationStatus: { S: "likely_constituent" },
  resolvedState: { S: "IL" },
  resolvedDistrict: { S: "IL-13" },
  effectiveWeight: { N: "1.25" },
  ...overrides,
});
const unverifiedVote = (userId: string, billId: string): Row => ({
  userId: { S: userId },
  billId: { S: billId },
  feedback: { S: "Nay" },
  constituentVerified: { BOOL: false },
  verificationStatus: { S: "self_attested" },
  effectiveWeight: { N: "1" },
});
const putVote = (row: Row) => mockVotes.set(`${row.userId.S}|${row.billId.S}`, row);
const vote = (userId: string, billId: string) => mockVotes.get(`${userId}|${billId}`);

const verifiedProfile = (userId: string, district = "IL-13"): Row => ({
  userId: { S: userId },
  constituentVerified: { BOOL: true },
  verificationStatus: { S: "likely_constituent" },
  verificationMethod: { S: "address_geocode" },
  resolvedState: { S: district.slice(0, 2) },
  resolvedDistrict: { S: district },
});
const cappedProfile = (userId: string): Row => ({
  userId: { S: userId },
  constituentVerified: { BOOL: false },
  verificationStatus: { S: "self_attested" },
  verificationMethod: { S: "address_capped" },
  selfAttestedState: { S: "IL" },
  selfAttestedDistrict: { S: "IL-13" },
  verificationLimitReason: { S: "address_limit" },
});

const messageFor = (userId: string, messageId = `m-${userId}`) => ({
  messageId,
  body: JSON.stringify({ userId }),
});
const run = (...records: Array<{ messageId: string; body: string }>) => handler(asSqsEvent({ Records: records }));

const updates = () => mockCalls.filter((call) => call.name === "UpdateItemCommand");
const emfValues = (metric: string): number[] =>
  logLines(console.log)
    .filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === "BillBoard/AccountIntegrity" && metric in line)
    .map((line) => line[metric] as number);
const summaries = () => logLines(console.log).filter((line) => line.message === "Vote re-stamp summary");

const setMode = (mode: string | undefined) => {
  if (mode === undefined) delete process.env.VOTE_RESTAMP_MODE;
  else process.env.VOTE_RESTAMP_MODE = mode;
};

beforeEach(() => {
  process.env = { ...originalEnv, ...ENV };
  delete process.env.AWS_LAMBDA_LOG_FORMAT;
  mockPii.clear();
  mockVotes.clear();
  mockCalls.length = 0;
  Object.assign(mockState, {
    pageSize: 1000,
    inFlight: 0,
    maxInFlight: 0,
    updateDelayMs: 0,
    failUpdateFor: undefined,
    beforeUpdate: undefined,
  });
  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    jest.spyOn(console, method).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv;
});

describe("configuration", () => {
  it.each([
    ["apply", "apply"],
    ["plan", "plan"],
    ["APPLY", "plan"],
    ["", "plan"],
    [undefined, "plan"],
  ])("VOTE_RESTAMP_MODE %j is %s", (value, expected) => {
    expect(voteRestampMode(value)).toBe(expected);
  });

  it("reads the tables with the shared key defaults, and requires both table names", () => {
    expect(restampConfigFromEnv({ PII_TABLE_NAME: "P", FEEDBACK_TABLE_NAME: "F" })).toEqual({
      pii: { tableName: "P", partitionKey: "userId" },
      feedback: { tableName: "F", partitionKey: "userId", sortKey: "billId" },
      mode: "plan",
    });
    expect(
      restampConfigFromEnv({
        PII_TABLE_NAME: "P",
        PII_PARTITION_KEY: "pk",
        FEEDBACK_TABLE_NAME: "F",
        FEEDBACK_PARTITION_KEY: "fpk",
        FEEDBACK_SORT_KEY: "fsk",
        VOTE_RESTAMP_MODE: "apply",
      }),
    ).toEqual({
      pii: { tableName: "P", partitionKey: "pk" },
      feedback: { tableName: "F", partitionKey: "fpk", sortKey: "fsk" },
      mode: "apply",
    });
    expect(() => restampConfigFromEnv({ PII_TABLE_NAME: "P" })).toThrow(/FEEDBACK_TABLE_NAME/);
    expect(() => restampConfigFromEnv({ FEEDBACK_TABLE_NAME: "F" })).toThrow(/PII_TABLE_NAME/);
  });
});

describe("apply mode", () => {
  beforeEach(() => setMode("apply"));

  it("verified to capped: removes state and district and sets the unverified stamp with weight 1", async () => {
    mockPii.set("u1", cappedProfile("u1"));
    putVote(verifiedVote("u1", "b1"));
    putVote(verifiedVote("u1", "b2"));
    putVote(verifiedVote("u2", "b1"));

    const response = await run(messageFor("u1"));

    expect(response).toEqual({ batchItemFailures: [] });
    for (const billId of ["b1", "b2"]) {
      expect(vote("u1", billId)).toEqual({
        userId: { S: "u1" },
        billId: { S: billId },
        feedback: { S: "Yea" },
        constituentVerified: { BOOL: false },
        verificationStatus: { S: "self_attested" },
        effectiveWeight: { N: "1" },
      });
    }
    expect(vote("u2", "b1")).toEqual(verifiedVote("u2", "b1"));
    expect(updates()).toHaveLength(2);
    expect(updates()[0].input).toEqual(
      expect.objectContaining({
        TableName: "UserFeedback",
        UpdateExpression:
          "SET constituentVerified = :constituentVerified, verificationStatus = :verificationStatus, effectiveWeight = :one REMOVE resolvedState, resolvedDistrict",
        ConditionExpression: "attribute_exists(#pk)",
      }),
    );
    expect(emfValues("VotesRestamped")).toEqual([2]);
    expect(summaries()[0]).toEqual(
      expect.objectContaining({
        userId: "u1",
        voteRestampMode: "apply",
        outcome: "applied",
        votes: 2,
        differing: 2,
        updated: 2,
        vanished: 0,
        targetVerified: false,
      }),
    );
  });

  it("a district change updates state and district on every vote", async () => {
    mockPii.set("u1", verifiedProfile("u1", "WI-02"));
    putVote(verifiedVote("u1", "b1"));
    putVote(unverifiedVote("u1", "b2"));

    await run(messageFor("u1"));

    for (const billId of ["b1", "b2"]) {
      expect(vote("u1", billId)).toEqual(
        expect.objectContaining({
          constituentVerified: { BOOL: true },
          verificationStatus: { S: "likely_constituent" },
          resolvedState: { S: "WI" },
          resolvedDistrict: { S: "WI-02" },
          effectiveWeight: { N: "1" },
        }),
      );
    }
  });

  it("leaves votes that already carry the stamp alone, even at the old 1.25 weight, and a rerun changes nothing", async () => {
    mockPii.set("u1", verifiedProfile("u1"));
    putVote(verifiedVote("u1", "b1"));
    putVote(unverifiedVote("u1", "b2"));

    await run(messageFor("u1"));
    expect(updates().map((call) => call.input.Key!.billId.S)).toEqual(["b2"]);
    expect(vote("u1", "b1")?.effectiveWeight).toEqual({ N: "1.25" });

    mockCalls.length = 0;
    await run(messageFor("u1"));
    expect(updates()).toEqual([]);
    expect(emfValues("VotesRestamped")).toEqual([1, 0]);
  });

  it("does not recreate a vote deleted between the read and the update", async () => {
    mockPii.set("u1", cappedProfile("u1"));
    putVote(verifiedVote("u1", "b1"));
    putVote(verifiedVote("u1", "b2"));
    mockState.beforeUpdate = (billId) => {
      if (billId === "b1") mockVotes.delete("u1|b1");
    };

    const response = await run(messageFor("u1"));

    expect(response.batchItemFailures).toEqual([]);
    expect(vote("u1", "b1")).toBeUndefined();
    expect(vote("u1", "b2")?.constituentVerified).toEqual({ BOOL: false });
    expect(summaries()[0]).toEqual(expect.objectContaining({ updated: 1, vanished: 1 }));
    expect(emfValues("VotesRestamped")).toEqual([1]);
  });

  it("reads every page of the account's votes", async () => {
    mockState.pageSize = 2;
    mockPii.set("u1", cappedProfile("u1"));
    for (let index = 0; index < 5; index += 1) putVote(verifiedVote("u1", `b${index}`));

    await run(messageFor("u1"));

    expect(mockCalls.filter((call) => call.name === "QueryCommand")).toHaveLength(3);
    expect([...mockVotes.values()].every((row) => row.constituentVerified.BOOL === false)).toBe(true);
    expect(summaries()[0]).toEqual(expect.objectContaining({ votes: 5, updated: 5 }));
  });

  it("keeps at most 8 updates in flight", async () => {
    expect(RESTAMP_UPDATE_CONCURRENCY).toBe(8);
    mockState.updateDelayMs = 2;
    mockPii.set("u1", cappedProfile("u1"));
    for (let index = 0; index < 30; index += 1) putVote(verifiedVote("u1", `b${String(index).padStart(2, "0")}`));

    await run(messageFor("u1"));

    expect(updates()).toHaveLength(30);
    expect(mockState.maxInFlight).toBe(8);
  });

  it("reads the profile with a strongly consistent read", async () => {
    mockPii.set("u1", verifiedProfile("u1"));
    await run(messageFor("u1"));
    expect(mockCalls[0]).toEqual({
      name: "GetItemCommand",
      input: expect.objectContaining({ TableName: "UserPII", Key: { userId: { S: "u1" } }, ConsistentRead: true }),
    });
  });
});

describe("accounts that are skipped", () => {
  beforeEach(() => setMode("apply"));

  it.each([["in_progress"], ["completed"]])("skips an account whose deletion is %s (no vote read)", async (status) => {
    mockPii.set("u1", { ...cappedProfile("u1"), deletionStatus: { S: status } });
    putVote(verifiedVote("u1", "b1"));

    expect(await run(messageFor("u1"))).toEqual({ batchItemFailures: [] });
    expect(mockCalls.map((call) => call.name)).toEqual(["GetItemCommand"]);
    expect(vote("u1", "b1")).toEqual(verifiedVote("u1", "b1"));
    expect(summaries()[0]).toEqual(expect.objectContaining({ outcome: "skipped_deletion" }));
    expect(emfValues("VotesRestamped")).toEqual([]);
  });

  it("skips an account with no profile", async () => {
    putVote(verifiedVote("u1", "b1"));

    expect(await run(messageFor("u1"))).toEqual({ batchItemFailures: [] });
    expect(mockCalls.map((call) => call.name)).toEqual(["GetItemCommand"]);
    expect(summaries()[0]).toEqual(expect.objectContaining({ outcome: "skipped_no_profile" }));
  });

  it("re-stamps an account whose deletion failed (it still holds its votes)", async () => {
    mockPii.set("u1", { ...cappedProfile("u1"), deletionStatus: { S: "failed" } });
    putVote(verifiedVote("u1", "b1"));

    await run(messageFor("u1"));
    expect(vote("u1", "b1")?.constituentVerified).toEqual({ BOOL: false });
  });
});

describe("plan mode (X8)", () => {
  it.each([[undefined], ["plan"], ["anything"]])(
    "VOTE_RESTAMP_MODE %j sends no UpdateItem, logs the planned rows and counts them",
    async (mode) => {
      setMode(mode);
      mockPii.set("u1", cappedProfile("u1"));
      putVote(verifiedVote("u1", "b1"));
      putVote(unverifiedVote("u1", "b2"));
      putVote(verifiedVote("u1", "b3", { resolvedDistrict: { S: "IL-07" } }));

      expect(await run(messageFor("u1"))).toEqual({ batchItemFailures: [] });

      expect(updates()).toEqual([]);
      expect(vote("u1", "b1")).toEqual(verifiedVote("u1", "b1"));
      const planned = logLines(console.log).filter((line) => line.message === "Vote re-stamp planned rows");
      expect(planned).toHaveLength(1);
      expect(planned[0].rows).toEqual([
        { billId: "b1", changes: ["constituentVerified", "verificationStatus", "resolvedState", "resolvedDistrict"] },
        { billId: "b3", changes: ["constituentVerified", "verificationStatus", "resolvedState", "resolvedDistrict"] },
      ]);
      // Field names only: the user's state and district are not logged.
      expect(JSON.stringify(planned)).not.toMatch(/IL-13|IL-07/);
      expect(emfValues("VotesRestampPlanned")).toEqual([2]);
      expect(emfValues("VotesRestamped")).toEqual([]);
      expect(summaries()[0]).toEqual(
        expect.objectContaining({ voteRestampMode: "plan", outcome: "planned", differing: 2, updated: 0 }),
      );
    },
  );

  it("logs 0 planned rows when the votes already match (the plan proof)", async () => {
    mockPii.set("u1", verifiedProfile("u1"));
    putVote(verifiedVote("u1", "b1"));

    await run(messageFor("u1"));

    expect(updates()).toEqual([]);
    expect(logLines(console.log).filter((line) => line.message === "Vote re-stamp planned rows")).toEqual([]);
    expect(emfValues("VotesRestampPlanned")).toEqual([0]);
    expect(summaries()[0]).toEqual(expect.objectContaining({ outcome: "planned", votes: 1, differing: 0 }));
  });

  it.each([
    ["an unverified (capped) account", cappedProfile],
    ["a verified account", verifiedProfile],
  ])("never plans legacy unstamped rows of %s, and only counts them", async (_label, profile) => {
    mockPii.set("u1", profile("u1"));
    const stamped = profile === verifiedProfile ? verifiedVote("u1", "b2") : unverifiedVote("u1", "b2");
    const legacy: Row = { userId: { S: "u1" }, billId: { S: "b1" }, feedback: { S: "Yea" } };
    putVote(legacy);
    putVote(stamped);

    await run(messageFor("u1"));

    expect(logLines(console.log).filter((line) => line.message === "Vote re-stamp planned rows")).toEqual([]);
    expect(emfValues("VotesRestampPlanned")).toEqual([0]);
    expect(summaries()[0]).toEqual(
      expect.objectContaining({ outcome: "planned", votes: 2, differing: 0, legacyUnstamped: 1 }),
    );

    mockCalls.length = 0;
    setMode("apply");
    await run(messageFor("u1"));

    expect(updates()).toEqual([]);
    expect(vote("u1", "b1")).toEqual(legacy);
    expect(summaries()[1]).toEqual(
      expect.objectContaining({ outcome: "applied", differing: 0, updated: 0, legacyUnstamped: 1 }),
    );
  });

  it("splits a long plan into lines of 100 rows", async () => {
    mockPii.set("u1", cappedProfile("u1"));
    for (let index = 0; index < 250; index += 1) putVote(verifiedVote("u1", `b${String(index).padStart(3, "0")}`));

    await run(messageFor("u1"));

    const planned = logLines(console.log).filter((line) => line.message === "Vote re-stamp planned rows");
    expect(planned.map((line) => (line.rows as unknown[]).length)).toEqual([100, 100, 50]);
    expect(updates()).toEqual([]);
  });
});

describe("failures", () => {
  beforeEach(() => setMode("apply"));

  it.each([["not json"], ['{"user":"u1"}'], ['{"userId":""}']])(
    "fails an unreadable message %j so it is retried and then dead-lettered",
    async (body) => {
      const response = await run({ messageId: "bad", body });
      expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
      expect(mockCalls).toEqual([]);
    },
  );

  it("fails the record on a DynamoDB error, and the retry converges", async () => {
    mockPii.set("u1", cappedProfile("u1"));
    putVote(verifiedVote("u1", "b1"));
    putVote(verifiedVote("u1", "b2"));
    mockState.failUpdateFor = "b2";

    expect(await run(messageFor("u1"))).toEqual({ batchItemFailures: [{ itemIdentifier: "m-u1" }] });

    mockState.failUpdateFor = undefined;
    expect(await run(messageFor("u1"))).toEqual({ batchItemFailures: [] });
    expect([...mockVotes.values()].every((row) => row.constituentVerified.BOOL === false)).toBe(true);
  });

  it("fails only the record that failed in a batch", async () => {
    mockPii.set("u1", cappedProfile("u1"));
    putVote(verifiedVote("u1", "b1"));

    const response = await run({ messageId: "bad", body: "{}" }, messageFor("u1"));

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
    expect(vote("u1", "b1")?.constituentVerified).toEqual({ BOOL: false });
  });

  it("fails the record when the tables are not configured", async () => {
    delete process.env.FEEDBACK_TABLE_NAME;
    expect(await run(messageFor("u1"))).toEqual({ batchItemFailures: [{ itemIdentifier: "m-u1" }] });
    expect(mockCalls).toEqual([]);
  });
});
