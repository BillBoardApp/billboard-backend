import type { AttributeValue, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
  buildReport,
  configFromEnv,
  formatReport,
  parseArgs,
  scanAll,
  type Scanner,
} from "../../scripts/reportAppAttest";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86400_000).toISOString();

const key = (id: string, environment: string, accountCount: number, signupCount: number, status = "active") => ({
  pk: { S: `KEY#${id}` },
  sk: { S: "META" },
  environment: { S: environment },
  status: { S: status },
  accountCount: { N: String(accountCount) },
  signupCount: { N: String(signupCount) },
});
const binding = (userId: string, keyId: string) => ({ pk: { S: `USER#${userId}` }, sk: { S: `KEY#${keyId}` } });
const vote = (userId: string, votedAt: string, appAttest?: string) => ({
  userId: { S: userId },
  votedAt: { S: votedAt },
  ...(appAttest ? { appAttest: { S: appAttest } } : {}),
});

/** A scanner over two tables that returns each in pages of `pageSize`, recording every command. */
const fakeScanner = (tables: Record<string, Array<Record<string, AttributeValue>>>, pageSize = 2) => {
  const commands: ScanCommand[] = [];
  const scanner: Scanner = {
    send: async (command) => {
      commands.push(command);
      const items = tables[command.input.TableName as string] ?? [];
      const start = Number(command.input.ExclusiveStartKey?.offset?.N ?? 0);
      const page = items.slice(start, start + pageSize);
      const next = start + pageSize < items.length ? { offset: { N: String(start + pageSize) } } : undefined;
      return { Items: page, ...(next ? { LastEvaluatedKey: next } : {}) };
    },
  };
  return { scanner, commands };
};

const config = configFromEnv({});

describe("reportAppAttest", () => {
  it("summarizes keys, bindings, vote outcomes and unbound active accounts", async () => {
    const { scanner, commands } = fakeScanner({
      AppAttest: [
        key("k1", "production", 1, 1),
        key("k2", "production", 2, 0),
        key("k3", "development", 5, 4),
        key("k4", "production", 0, 0, "revoked"),
        binding("u1", "k1"),
        binding("u2", "k2"),
        binding("u2", "k3"),
        { pk: { S: "CH#abc" }, sk: { S: "CH" } },
      ],
      UserFeedback: [
        vote("u1", daysAgo(1), "valid"),
        vote("u1", daysAgo(2), "valid"),
        vote("u2", daysAgo(3), "development"),
        vote("u3", daysAgo(5), "missing"),
        vote("u4", daysAgo(20)),
        vote("u5", daysAgo(40), "valid"),
      ],
    });
    const report = await buildReport({ db: scanner, config, options: { voteDays: 14, activeDays: 30 }, now: NOW });
    expect(report).toEqual({
      generatedAt: NOW.toISOString(),
      keys: {
        total: 4,
        byEnvironment: { production: 3, development: 1 },
        byStatus: { active: 3, revoked: 1 },
        accountsPerKey: { "0": 1, "1": 1, "2": 1, "3": 0, "4+": 1 },
        signupsPerKey: { "0": 2, "1": 1, "2": 0, "3": 0, "4+": 1 },
      },
      bindings: { total: 3, accounts: 2 },
      challengesStored: 1,
      votes: { days: 14, total: 4, byOutcome: { valid: 2, development: 1, missing: 1 }, validShare: 0.5 },
      activeAccounts: { days: 30, total: 4, withoutBinding: 2 },
      checks: { votesValidAtLeast95Percent: false, everyActiveAccountBound: false },
    });
    // Read-only: only Scans, with projections, across every page.
    expect(commands.every((command) => command.constructor.name === "ScanCommand")).toBe(true);
    expect(commands.filter((command) => command.input.TableName === "AppAttest")).toHaveLength(4);
    expect(commands[0].input.ProjectionExpression).toBe("#pk, #sk, #environment, #status, #accountCount, #signupCount");
    expect(commands.at(-1)?.input).toMatchObject({
      TableName: "UserFeedback",
      ProjectionExpression: "#user, #votedAt, #appAttest",
      ExpressionAttributeNames: { "#user": "userId", "#votedAt": "votedAt", "#appAttest": "appAttest" },
    });
  });

  it("passes both checks when nearly every vote is valid and every active account is bound", async () => {
    const votes = Array.from({ length: 20 }, (_, index) =>
      vote(`u${index % 2}`, daysAgo(1), index === 0 ? "missing" : "valid"),
    );
    const { scanner } = fakeScanner(
      { AppAttest: [key("k1", "production", 2, 2), binding("u0", "k1"), binding("u1", "k1")], UserFeedback: votes },
      50,
    );
    const report = await buildReport({ db: scanner, config, options: { voteDays: 14, activeDays: 30 }, now: NOW });
    expect(report.votes.validShare).toBe(0.95);
    expect(report.checks).toEqual({ votesValidAtLeast95Percent: true, everyActiveAccountBound: true });
    const text = formatReport(report);
    expect(text).toContain("valid 95.0%");
    expect(text).toContain("at least 95% of votes valid: PASS");
    expect(text).not.toContain("u0");
  });

  it("an empty table fails the checks rather than passing them vacuously", async () => {
    const { scanner } = fakeScanner({});
    const report = await buildReport({ db: scanner, config, options: { voteDays: 14, activeDays: 30 }, now: NOW });
    expect(report.votes.validShare).toBeNull();
    expect(report.checks).toEqual({ votesValidAtLeast95Percent: false, everyActiveAccountBound: false });
    expect(formatReport(report)).toContain("valid n/a");
  });

  it("scanAll follows LastEvaluatedKey", async () => {
    const { scanner, commands } = fakeScanner({ T: [{ a: { S: "1" } }, { a: { S: "2" } }, { a: { S: "3" } }] }, 1);
    const items = await scanAll(scanner, {
      TableName: "T",
      ProjectionExpression: "#a",
      ExpressionAttributeNames: { "#a": "a" },
    });
    expect(items).toHaveLength(3);
    expect(commands.map((command) => command.input.ExclusiveStartKey)).toEqual([
      undefined,
      { offset: { N: "1" } },
      { offset: { N: "2" } },
    ]);
  });

  it("parses its arguments and environment", () => {
    expect(parseArgs([])).toEqual({ help: false, json: false, voteDays: 14, activeDays: 30 });
    expect(parseArgs(["--json", "--vote-days", "7", "--active-days", "60"])).toEqual({
      help: false,
      json: true,
      voteDays: 7,
      activeDays: 60,
    });
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(() => parseArgs(["--vote-days", "0"])).toThrow("whole number");
    expect(() => parseArgs(["--apply"])).toThrow("Unknown argument --apply");
    expect(configFromEnv({})).toEqual({
      region: "us-east-1",
      appAttestTableName: "AppAttest",
      feedbackTableName: "UserFeedback",
      feedbackPartitionKey: "userId",
    });
    expect(configFromEnv({ AWS_REGION: "us-west-2", APP_ATTEST_TABLE_NAME: "T" })).toMatchObject({
      region: "us-west-2",
      appAttestTableName: "T",
    });
  });
});
