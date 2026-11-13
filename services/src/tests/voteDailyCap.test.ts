import type { AttributeValue, UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";
import * as abuseLimits from "../shared/abuseLimits";
import { conditionalCheckFailed, evaluateCondition } from "./fixtures/dynamoCondition";
import { logLines } from "./logLines";
import {
  ACCOUNT_INTEGRITY_METRIC_NAMESPACE,
  VOTE_DAILY_LIMIT,
  VoteDailyCapConflictError,
  applyVoteDailyCap,
  countVoteWrite,
  emitVoteCast,
  parseVoteDailyCapMode,
  secondsUntilNextUtcMidnight,
  utcDay,
  voteDailyLimitResponse,
} from "../shared/voteDailyCap";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// INT-06 (C2 3.2): the per-account daily vote counter on the UserPII row.

type Item = Record<string, AttributeValue>;

const NOW = new Date("2026-10-08T15:30:00.000Z");
const TODAY = "2026-10-08";
const YESTERDAY = "2026-10-07";

/** Applies the SET forms the counter uses: `#a = :v` and `#a = #a + :v`. Anything else fails the test. */
const applySet = (item: Item, input: UpdateItemCommandInput): Item => {
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

/**
 * One UserPII row (or none) behind UpdateItem, honouring the exact condition, ReturnValues and
 * ReturnValuesOnConditionCheckFailure the counter sends. `before` runs ahead of each call, so a test
 * can play a concurrent writer.
 */
const fakePiiRow = (initial?: Item) => {
  const state: { row: Item | undefined } = { row: initial };
  const calls: UpdateItemCommandInput[] = [];
  let before: ((callIndex: number) => void) | undefined;
  const send = jest.fn(async (command: { constructor: { name: string }; input: UpdateItemCommandInput }) => {
    const input = command.input;
    calls.push(input);
    before?.(calls.length - 1);
    if (command.constructor.name !== "UpdateItemCommand") throw new Error(`Unexpected ${command.constructor.name}`);
    if (!evaluateCondition(state.row, input)) {
      throw conditionalCheckFailed(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? state.row : undefined);
    }
    const updated = applySet(state.row ?? { userId: input.Key!.userId }, input);
    state.row = updated;
    return { Attributes: { voteDay: updated.voteDay, voteDayCount: updated.voteDayCount } };
  });
  return {
    db: { send },
    state,
    calls,
    setBefore: (hook: (callIndex: number) => void) => {
      before = hook;
    },
  };
};

const params = (db: { send: jest.Mock }) => ({
  db,
  tableName: "UserPII",
  partitionKey: "userId",
  userId: "user-1",
  now: NOW,
});

const integrityLines = (spy: jest.SpyInstance) =>
  logLines(spy).filter((line) => line._aws?.CloudWatchMetrics?.[0]?.Namespace === ACCOUNT_INTEGRITY_METRIC_NAMESPACE);

describe("mode and clock helpers", () => {
  it.each([
    [undefined, "watch"],
    ["", "watch"],
    ["watch", "watch"],
    ["block", "watch"],
    ["enforced", "watch"],
    ["enforce", "enforce"],
    [" Enforce ", "enforce"],
  ])("reads VOTE_DAILY_CAP_MODE %p as %s", (raw, mode) => {
    expect(parseVoteDailyCapMode(raw as string | undefined)).toBe(mode);
  });

  it("uses the UTC day, whatever the local offset of the instant", () => {
    expect(utcDay(new Date("2026-10-08T23:59:59.999Z"))).toBe("2026-10-08");
    expect(utcDay(new Date("2026-10-08T20:00:00-05:00"))).toBe("2026-10-09");
  });

  it.each([
    ["2026-10-08T23:59:30.000Z", 30],
    ["2026-10-08T23:59:59.900Z", 1],
    ["2026-10-08T00:00:00.000Z", 86400],
    ["2026-10-08T12:00:00.500Z", 43200],
    ["2026-12-31T23:00:00.000Z", 3600],
  ])("Retry-After at %s is %i seconds", (iso, seconds) => {
    expect(secondsUntilNextUtcMidnight(new Date(iso))).toBe(seconds);
  });

  it("re-exports the daily cap from abuseLimits.ts", () => {
    expect(VOTE_DAILY_LIMIT).toBe(abuseLimits.VOTE_DAILY_LIMIT);
  });
});

describe("countVoteWrite", () => {
  it("increments the day's count with one conditional update", async () => {
    const fake = fakePiiRow({ userId: { S: "user-1" }, voteDay: { S: TODAY }, voteDayCount: { N: "41" } });

    await expect(countVoteWrite(params(fake.db))).resolves.toEqual({
      kind: "counted",
      voteDay: TODAY,
      voteDayCount: 42,
    });

    expect(fake.calls).toEqual([
      {
        TableName: "UserPII",
        Key: { userId: { S: "user-1" } },
        UpdateExpression: "SET #voteDayCount = #voteDayCount + :one",
        ConditionExpression:
          "#voteDay = :today AND (attribute_not_exists(#deletionStatus) OR (#deletionStatus <> :deletionInProgress AND #deletionStatus <> :deletionCompleted))",
        ExpressionAttributeNames: {
          "#voteDay": "voteDay",
          "#voteDayCount": "voteDayCount",
          "#deletionStatus": "deletionStatus",
        },
        ExpressionAttributeValues: {
          ":today": { S: TODAY },
          ":one": { N: "1" },
          ":deletionInProgress": { S: "in_progress" },
          ":deletionCompleted": { S: "completed" },
        },
        ReturnValues: "UPDATED_NEW",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    ]);
  });

  it("starts a new day at 1, keeping the rest of the row", async () => {
    const fake = fakePiiRow({
      userId: { S: "user-1" },
      constituentVerified: { BOOL: true },
      voteDay: { S: YESTERDAY },
      voteDayCount: { N: String(VOTE_DAILY_LIMIT) },
    });

    await expect(countVoteWrite(params(fake.db))).resolves.toEqual({
      kind: "counted",
      voteDay: TODAY,
      voteDayCount: 1,
    });

    expect(fake.calls.map((input) => input.UpdateExpression)).toEqual([
      "SET #voteDayCount = #voteDayCount + :one",
      "SET #voteDay = :today, #voteDayCount = :one",
    ]);
    expect(fake.calls[1].ConditionExpression).toBe(
      "(attribute_not_exists(#voteDay) OR #voteDay <> :today) AND (attribute_not_exists(#deletionStatus) OR (#deletionStatus <> :deletionInProgress AND #deletionStatus <> :deletionCompleted))",
    );
    expect(fake.state.row).toEqual({
      userId: { S: "user-1" },
      constituentVerified: { BOOL: true },
      voteDay: { S: TODAY },
      voteDayCount: { N: "1" },
    });
  });

  it("creates the PII row of a user who has none, holding only the counter", async () => {
    const fake = fakePiiRow(undefined);

    await expect(countVoteWrite(params(fake.db))).resolves.toEqual({
      kind: "counted",
      voteDay: TODAY,
      voteDayCount: 1,
    });

    expect(fake.state.row).toEqual({ userId: { S: "user-1" }, voteDay: { S: TODAY }, voteDayCount: { N: "1" } });
  });

  it("retries the increment once when a concurrent request reset the day in between (both conditions fail once)", async () => {
    const fake = fakePiiRow({ userId: { S: "user-1" }, voteDay: { S: YESTERDAY }, voteDayCount: { N: "9" } });
    // Between this request's failed increment and its reset, another request starts the day.
    fake.setBefore((callIndex) => {
      if (callIndex === 1) fake.state.row = { ...fake.state.row!, voteDay: { S: TODAY }, voteDayCount: { N: "1" } };
    });

    await expect(countVoteWrite(params(fake.db))).resolves.toEqual({
      kind: "counted",
      voteDay: TODAY,
      voteDayCount: 2,
    });

    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2].UpdateExpression).toBe("SET #voteDayCount = #voteDayCount + :one");
  });

  it("throws when the retried increment fails too", async () => {
    const fake = fakePiiRow({ userId: { S: "user-1" }, voteDay: { S: YESTERDAY }, voteDayCount: { N: "9" } });
    fake.setBefore((callIndex) => {
      if (callIndex === 1) fake.state.row = { ...fake.state.row!, voteDay: { S: TODAY } };
      if (callIndex === 2) fake.state.row = { ...fake.state.row!, voteDay: { S: "2026-10-09" } };
    });

    await expect(countVoteWrite(params(fake.db))).rejects.toBeInstanceOf(VoteDailyCapConflictError);
    expect(fake.calls).toHaveLength(3);
  });

  it("rethrows any other DynamoDB error as it is", async () => {
    const denied = Object.assign(new Error("not authorized to perform: dynamodb:UpdateItem"), {
      name: "AccessDeniedException",
    });
    const db = { send: jest.fn().mockRejectedValue(denied) };

    await expect(countVoteWrite(params(db))).rejects.toBe(denied);
    expect(db.send).toHaveBeenCalledTimes(1);
  });

  it.each(["in_progress", "completed"])(
    "writes nothing to a row whose deletion is %s, on the same day or a new one",
    async (deletionStatus) => {
      for (const voteDay of [TODAY, YESTERDAY]) {
        const row: Item = {
          userId: { S: "user-1" },
          deletionStatus: { S: deletionStatus },
          voteDay: { S: voteDay },
          voteDayCount: { N: "3" },
        };
        const fake = fakePiiRow(row);

        await expect(countVoteWrite(params(fake.db))).resolves.toEqual({ kind: "account_deleting", deletionStatus });
        expect(fake.state.row).toEqual(row);
        expect(fake.calls).toHaveLength(1);
      }
    },
  );

  it("does not create a counter on a tombstone without one", async () => {
    const tombstone: Item = { userId: { S: "user-1" }, deletionStatus: { S: "completed" } };
    const fake = fakePiiRow(tombstone);

    await expect(countVoteWrite(params(fake.db))).resolves.toEqual({
      kind: "account_deleting",
      deletionStatus: "completed",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.state.row).toEqual(tombstone);
  });

  it("counts for an account whose deletion failed (it may still vote)", async () => {
    const fake = fakePiiRow({ userId: { S: "user-1" }, deletionStatus: { S: "failed" } });

    await expect(countVoteWrite(params(fake.db))).resolves.toEqual({
      kind: "counted",
      voteDay: TODAY,
      voteDayCount: 1,
    });
  });
});

describe("applyVoteDailyCap", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const atCount = (count: number) =>
    fakePiiRow({ userId: { S: "user-1" }, voteDay: { S: TODAY }, voteDayCount: { N: String(count) } });

  it.each(["watch", "enforce"] as const)(
    "lets the last write under the cap through in %s, with no metric",
    async (mode) => {
      const fake = atCount(VOTE_DAILY_LIMIT - 1);

      await expect(applyVoteDailyCap({ ...params(fake.db), mode })).resolves.toEqual({
        action: "write",
        voteDay: TODAY,
        voteDayCount: VOTE_DAILY_LIMIT,
        overLimit: false,
      });
      expect(integrityLines(logSpy)).toEqual([]);
    },
  );

  it("refuses the first write over the cap in enforce, with Retry-After to midnight UTC and the metric", async () => {
    const fake = atCount(VOTE_DAILY_LIMIT);

    await expect(applyVoteDailyCap({ ...params(fake.db), mode: "enforce" })).resolves.toEqual({
      action: "refuse_limit",
      voteDay: TODAY,
      voteDayCount: VOTE_DAILY_LIMIT + 1,
      retryAfterSeconds: 30600,
    });
    const [line] = integrityLines(logSpy);
    expect(line).toMatchObject({
      VoteDailyCapExceeded: 1,
      userId: "user-1",
      voteDay: TODAY,
      voteDayCount: VOTE_DAILY_LIMIT + 1,
      voteDailyCapMode: "enforce",
      outcome: "refused",
    });
    expect(line._aws!.CloudWatchMetrics).toEqual([
      {
        Namespace: "BillBoard/AccountIntegrity",
        Dimensions: [[]],
        Metrics: [{ Name: "VoteDailyCapExceeded", Unit: "Count" }],
      },
    ]);
  });

  it("writes the first write over the cap in watch and still emits the metric", async () => {
    const fake = atCount(VOTE_DAILY_LIMIT);

    await expect(applyVoteDailyCap({ ...params(fake.db), mode: "watch" })).resolves.toEqual({
      action: "write",
      voteDay: TODAY,
      voteDayCount: VOTE_DAILY_LIMIT + 1,
      overLimit: true,
    });
    expect(integrityLines(logSpy)).toEqual([
      expect.objectContaining({ VoteDailyCapExceeded: 1, voteDayCount: VOTE_DAILY_LIMIT + 1, outcome: "would_refuse" }),
    ]);
  });

  it("refuses a deleting account in both modes, without a cap metric", async () => {
    for (const mode of ["watch", "enforce"] as const) {
      const fake = fakePiiRow({ userId: { S: "user-1" }, deletionStatus: { S: "in_progress" } });
      await expect(applyVoteDailyCap({ ...params(fake.db), mode })).resolves.toEqual({
        action: "refuse_deleting",
        deletionStatus: "in_progress",
      });
    }
    expect(integrityLines(logSpy)).toEqual([]);
  });

  it("lets the vote through in watch when the counter fails, and reports it", async () => {
    const db = {
      send: jest.fn().mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDeniedException" })),
    };

    await expect(applyVoteDailyCap({ ...params(db), mode: "watch" })).resolves.toEqual({
      action: "write",
      voteDay: TODAY,
      voteDayCount: null,
      overLimit: false,
    });
    expect(integrityLines(logSpy)).toEqual([
      expect.objectContaining({ VoteDailyCapError: 1, userId: "user-1", voteDailyCapMode: "watch" }),
    ]);
    expect(logLines(warnSpy)).toEqual([
      expect.objectContaining({
        level: "WARN",
        message: "Could not count the vote toward the daily cap; writing it anyway (watch)",
        error: expect.objectContaining({ name: "AccessDeniedException" }),
      }),
    ]);
  });

  it("answers error in enforce when the counter fails, including the conflict after the retry", async () => {
    const fake = fakePiiRow({ userId: { S: "user-1" }, voteDay: { S: YESTERDAY }, voteDayCount: { N: "1" } });
    fake.setBefore((callIndex) => {
      if (callIndex === 1) fake.state.row = { ...fake.state.row!, voteDay: { S: TODAY } };
      if (callIndex === 2) fake.state.row = { ...fake.state.row!, voteDay: { S: YESTERDAY } };
    });

    const decision = await applyVoteDailyCap({ ...params(fake.db), mode: "enforce" });

    expect(decision).toEqual({ action: "error", error: expect.any(VoteDailyCapConflictError) });
    expect(integrityLines(logSpy)).toEqual([expect.objectContaining({ VoteDailyCapError: 1 })]);
  });

  it("emits VotesCast with the day's count for the flip analysis", () => {
    emitVoteCast({ userId: "user-1", mode: "watch", voteDay: TODAY, voteDayCount: 12 });

    const [line] = integrityLines(logSpy);
    expect(line).toMatchObject({
      VotesCast: 1,
      userId: "user-1",
      voteDay: TODAY,
      voteDayCount: 12,
      voteDailyCapMode: "watch",
    });
    expect(line._aws!.CloudWatchMetrics[0]).toEqual({
      Namespace: "BillBoard/AccountIntegrity",
      Dimensions: [[]],
      Metrics: [{ Name: "VotesCast", Unit: "Count" }],
    });
  });
});

describe("the 429 response", () => {
  const openapi = JSON.parse(readFileSync(join(__dirname, "../../../contracts/openapi/user-api.v1.json"), "utf8"));

  it("is the documented VOTE_DAILY_LIMIT ApiError with Retry-After", () => {
    const response = voteDailyLimitResponse(30);

    expect(response).toEqual({
      statusCode: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
      body: JSON.stringify({
        error: "VOTE_DAILY_LIMIT",
        message: `You've reached today's limit of ${VOTE_DAILY_LIMIT} votes. You can vote again after midnight UTC.`,
      }),
    });
    const documented = openapi.components.responses.VoteDailyLimit;
    expect(Object.keys(documented.headers)).toEqual(["Retry-After"]);
    expect(Object.keys(JSON.parse(response.body)).sort()).toEqual(
      Object.keys(openapi.components.schemas.ApiError.properties).sort(),
    );
    expect(openapi.paths["/feedback"].post.responses["429"]).toEqual({ $ref: "#/components/responses/VoteDailyLimit" });
  });
});
