jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { readFileSync } from "fs";
import { join } from "path";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { applyTestEnv } from "./fixtures/env";
import type { CivicRankDefinition } from "../shared/civicProgression";
import type { CivicScoreBody } from "../shared/civicRecord";
import { logLines } from "./logLines";

type Item = Record<string, AttributeValue>;

/** Every input field the fake DynamoDB reads, across the commands it answers. */
interface FakeInput extends ConditionInput {
  TableName?: string;
  Key?: Item;
  ProjectionExpression?: string;
  UpdateExpression?: string;
  ConsistentRead?: boolean;
  ReturnValuesOnConditionCheckFailure?: string;
}

/** What the fake reads from an AWS SDK command: its class's name and its input. */
interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

/** The score response body: the code's own fields plus the rank the handler adds. */
type ScoreBody = CivicScoreBody & {
  rank: CivicRankDefinition;
  nextRank: CivicRankDefinition | null;
  scoreToNextRank: number;
};

const FEEDBACK_TABLE = "test-table";
const PII_TABLE = "pii-table";
const USER = "user-1";

// ─── In-memory DynamoDB: the user's votes (Query), their UserPII row (GetItem, UpdateItem) and the companion groups ───

let votes: Map<string, Item[]>;
let piiRows: Map<string, Item>;
let groups: () => unknown;
/** Runs before each command; a test can play a concurrent read or fail a call. */
let beforeCommand: ((op: string, input: FakeInput) => void) | undefined;

const resolveNames = (expression: string, names: Record<string, string> = {}) =>
  expression
    .split(",")
    .map((token) => token.trim())
    .map((token) => (token.startsWith("#") ? names[token] : token));

const project = (item: Item, input: FakeInput): Item => {
  if (!input.ProjectionExpression) return { ...item };
  const wanted = resolveNames(input.ProjectionExpression, input.ExpressionAttributeNames);
  return Object.fromEntries(Object.entries(item).filter(([name]) => wanted.includes(name)));
};

/** SET name = :value, ... and ADD name :set (string sets), as the record write sends them. */
const applyUpdate = (item: Item, input: FakeInput): Item => {
  const name = (token: string) => (token.startsWith("#") ? input.ExpressionAttributeNames![token] : token);
  const value = (token: string) => input.ExpressionAttributeValues![token];
  const next = { ...item };
  const [, setPart, addPart] = /^SET (.+?)(?: ADD (.+))?$/.exec(input.UpdateExpression ?? "") ?? [];
  if (!setPart) throw new Error(`Unsupported update: ${input.UpdateExpression}`);
  for (const clause of setPart.split(",")) {
    const [lhs, rhs] = clause.split("=").map((part) => part.trim());
    next[name(lhs)] = value(rhs);
  }
  if (addPart) {
    const [lhs, rhs] = addPart.trim().split(/\s+/);
    const existing = next[name(lhs)]?.SS ?? [];
    next[name(lhs)] = { SS: [...new Set([...existing, ...value(rhs).SS!])] };
  }
  return next;
};

const route = async (command: FakeCommand) => {
  const op: string = command.constructor.name;
  const input = command.input;
  beforeCommand?.(op, input);
  if (op === "QueryCommand" && input.TableName === FEEDBACK_TABLE) {
    const rows = votes.get(input.ExpressionAttributeValues![":pk"].S!) ?? [];
    return { Items: rows.map((row) => project(row, input)) };
  }
  if (op === "GetItemCommand" && input.Key?.pk?.S === "BILL_COMPANION_GROUPS") return groups();
  if (op === "GetItemCommand" && input.TableName === PII_TABLE) {
    const row = piiRows.get(input.Key!.user_id.S!);
    return row ? { Item: project(row, input) } : {};
  }
  if (op === "UpdateItemCommand" && input.TableName === PII_TABLE) {
    const userId = input.Key!.user_id.S!;
    const existing = piiRows.get(userId);
    if (!evaluateCondition(existing, input)) {
      throw conditionalCheckFailed(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? existing : undefined);
    }
    piiRows.set(userId, applyUpdate(existing ?? { ...input.Key }, input));
    return {};
  }
  throw new Error(`Unexpected ${op} on ${input.TableName}`);
};

let send: jest.Mock<unknown, [FakeCommand]>;
let handler: (event: unknown) => Promise<{ statusCode: number; body: string }>;
let restoreEnv: (() => void) | undefined;
let logSpy: jest.SpyInstance;

const load = (env: Record<string, string | undefined> = {}) => {
  restoreEnv?.();
  restoreEnv = applyTestEnv({
    TABLE_NAME: FEEDBACK_TABLE,
    PARTITION_KEY: "user_id",
    SORT_KEY: undefined,
    PII_TABLE_NAME: PII_TABLE,
    PII_PARTITION_KEY: "user_id",
    MANIFEST_TABLE_NAME: undefined,
    MANIFEST_PRIMARY_KEY: undefined,
    ...env,
  });
  jest.resetModules();
  ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
  send.mockReset();
  send.mockImplementation(route);
  handler = require("../handlers/fetchCivicScore").handler;
};

const scoreAt = async (now: string, userId = USER) => {
  jest.setSystemTime(new Date(now));
  const response = await handler({ requestContext: { authorizer: { jwt: { claims: { sub: userId } } } } });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as ScoreBody;
};

const calls = () => send.mock.calls.map(([command]) => `${command.constructor.name} ${command.input.TableName}`);
const recordOf = (userId = USER) => piiRows.get(userId);
/** Reloads the handler with the companion groups configured and publishes these pairs (APPF-23). */
const useGroups = (pairs: [string, string][]) => {
  if (process.env.MANIFEST_TABLE_NAME !== "BillsManifest") {
    load({ MANIFEST_TABLE_NAME: "BillsManifest", MANIFEST_PRIMARY_KEY: "pk" });
  }
  groups = () => ({
    Item: {
      pk: { S: "BILL_COMPANION_GROUPS" },
      sk: { S: "CURRENT" },
      pairsVersion: { N: String(pairs.length + 1) },
      enabled: { BOOL: true },
      pairs: { S: JSON.stringify(pairs) },
    },
  });
};

/** A vote row; `votedAt` alone is a row written before UX-31 (no firstVotedAt). */
const row = (billId: string, feedback: string, votedAt: string | null, extra: Item = {}): Item => ({
  user_id: { S: USER },
  billId: { S: billId },
  feedback: { S: feedback },
  ...(votedAt ? { votedAt: { S: votedAt } } : {}),
  ...extra,
});
const firstVotedAt = (time: string): Item => ({ firstVotedAt: { S: time } });
const labels = (...names: string[]) => ({ L: names.map((name) => ({ S: name })) });
const setVotes = (rows: Item[], userId = USER) => votes.set(userId, rows);
const seedPii = (attributes: Item = {}, userId = USER) =>
  piiRows.set(userId, { user_id: { S: userId }, adultStatus: { S: "attested_adult" }, ...attributes });

/** The score the rule before UX-31 gave (the handler as it was on 2026-10-28), for the seed checks. */
const oldRuleScore = (rows: Item[], now: string): number => {
  const counted = rows.filter((item) => ["yea", "nay"].includes((item.feedback?.S ?? "").trim().toLowerCase()));
  const days = [
    ...new Set(
      counted
        .map((item) => item.votedAt?.S)
        .filter((d): d is string => !!d)
        .map((d) => d.slice(0, 10)),
    ),
  ].sort();
  const diff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  let longest = days.length ? 1 : 0;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = diff(days[i - 1], days[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  let current = 0;
  if (days.length && diff(days[days.length - 1], now.slice(0, 10)) <= 1) {
    current = 1;
    for (let i = days.length - 1; i > 0 && diff(days[i - 1], days[i]) === 1; i--) current++;
  }
  const areas = new Set(
    counted.flatMap((item) =>
      [...(item.lifeAreas?.L ?? []), ...(item.subCategories?.L ?? [])].map((v) => v.S!.trim().toLowerCase()),
    ),
  );
  const honors =
    (counted.length >= 1 ? 25 : 0) +
    (longest >= 3 ? 25 : 0) +
    (counted.length >= 25 ? 50 : 0) +
    (longest >= 7 ? 50 : 0) +
    (areas.size >= 3 ? 50 : 0) +
    (counted.filter((item) => item.civicProfile).length >= 25 ? 100 : 0) +
    (counted.length >= 100 ? 100 : 0) +
    (areas.size >= 5 ? 100 : 0);
  return counted.length * 10 + current * 5 + honors;
};

beforeEach(() => {
  votes = new Map();
  piiRows = new Map();
  groups = () => ({});
  beforeCommand = undefined;
  jest.useFakeTimers({ now: new Date("2026-03-03T12:00:00.000Z") });
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

describe("fetchCivicScore handler", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await handler({});
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      message: "Unauthorized (missing authorizer claims)",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("answers with the fields both apps decode (the OpenAPI CivicScore, every key required)", async () => {
    seedPii();
    setVotes([row("bill-1", "Yea", "2026-03-03T09:00:00.000Z")]);

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    const openapi = JSON.parse(readFileSync(join(__dirname, "../../../contracts/openapi/user-api.v1.json"), "utf8"));
    const schemas = openapi.components.schemas;
    expect(Object.keys(body).sort()).toEqual([...schemas.CivicScore.required].sort());
    expect(Object.keys(body.rank).sort()).toEqual([...schemas.CivicRank.required].sort());
    expect(Object.keys(body.honors[0]).sort()).toEqual([...schemas.CivicHonor.required].sort());
    expect(Object.keys(body.recentVoteDays[0]).sort()).toEqual(["count", "date"]);
  });
});

describe("UX-31: Abstain counts like Yea and Nay", () => {
  it("toward the votes, the streak, the last 30 days and the honors; a 1.0 or 1.1 dismissal does not", async () => {
    seedPii();
    setVotes([
      row("bill-1", "Yea", "2026-03-01T10:00:00.000Z", { lifeAreas: labels("Taxes") }),
      row("bill-2", "Abstain", "2026-03-02T11:00:00.000Z", { subCategories: labels("Healthcare") }),
      row("bill-3", "Nay", "2026-03-03T09:00:00.000Z", { lifeAreas: labels("Energy") }),
      // INT-11: an Updates dismissal from 1.0 or 1.1 is no vote.
      row("bill-4", "Abstain", "2026-02-27T09:00:00.000Z", { legacyDismiss: { BOOL: true } }),
    ]);

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.totalVotes).toBe(3);
    expect(body.currentStreak).toBe(3);
    expect(body.longestStreak).toBe(3);
    expect(body.voteScore).toBe(30);
    expect(body.streakBonus).toBe(15);
    expect(body.coverageAreaCount).toBe(3);
    // First Voice, Steady (3 days) and Broad View (3 areas).
    expect(body.honors.map((honor) => honor.id)).toEqual(["first-voice", "steady", "broad-view"]);
    expect(body.honorBonus).toBe(100);
    expect(body.civicScore).toBe(145);
    expect(body.lastVotedAt).toBe("2026-03-03T09:00:00.000Z");
    const recent = Object.fromEntries(body.recentVoteDays.map((day) => [day.date, day.count]));
    expect(body.recentVoteDays).toHaveLength(30);
    expect([recent["2026-02-27"], recent["2026-03-01"], recent["2026-03-02"], recent["2026-03-03"]]).toEqual([
      0, 1, 1, 1,
    ]);
  });

  it("but Civic Compass needs the Civic Profile unlocked: 25 Yea or Nay votes and 3 themes at 8 (UX-32)", async () => {
    seedPii();
    const themes = (...axes: string[]) => ({
      civicProfile: { M: Object.fromEntries(axes.map((a) => [a, { N: "0.4" }])) },
    });
    const rows = Array.from({ length: 25 }, (_, index) =>
      row(
        `bill-${index}`,
        index === 0 ? "Abstain" : "Yea",
        `2026-02-01T09:${String(index).padStart(2, "0")}:00.000Z`,
        themes("localVsFederal", "privacyVsSecurity", "freeMarketVsRegulated"),
      ),
    );
    setVotes(rows);
    expect((await scoreAt("2026-03-03T12:00:00.000Z")).honors.map((honor) => honor.id)).not.toContain("civic-compass");

    setVotes([...rows, row("bill-25", "Nay", "2026-02-01T10:00:00.000Z", themes("localVsFederal"))]);
    const unlocked = await scoreAt("2026-03-03T12:01:00.000Z");
    expect(unlocked.honors.map((honor) => honor.id)).toContain("civic-compass");
    expect(recordOf()?.civicHonors?.SS).toContain("civic-compass");
  });

  it("and is not earned at 25 votes on fewer than 3 themes at 8, which the rule before UX-32 allowed", async () => {
    seedPii();
    const onOneTheme = (index: number) =>
      row(`bill-${index}`, "Yea", `2026-02-01T09:${String(index).padStart(2, "0")}:00.000Z`, {
        civicProfile: { M: { localVsFederal: { N: "0.4" } } },
      });
    setVotes(Array.from({ length: 24 }, (_, index) => onOneTheme(index)));
    await scoreAt("2026-03-03T12:00:00.000Z");

    setVotes(Array.from({ length: 40 }, (_, index) => onOneTheme(index)));
    const body = await scoreAt("2026-03-03T12:01:00.000Z");
    expect(body.honors.map((honor) => honor.id)).toEqual(["first-voice", "on-record"]);
  });

  it("but a seed keeps Civic Compass on the rule before UX-32, which showed it, and later reads keep it", async () => {
    seedPii();
    // A user first read after the deploy, with 25 Yea or Nay votes on one theme: the rule before UX-32 gave the honor.
    const rows = Array.from({ length: 25 }, (_, index) =>
      row(`bill-${index}`, "Nay", `2026-02-01T09:${String(index).padStart(2, "0")}:00.000Z`, {
        civicProfile: { M: { localVsFederal: { N: "0.4" } } },
      }),
    );
    setVotes(rows);
    const seeded = await scoreAt("2026-03-03T12:00:00.000Z");
    expect(seeded.honors.map((honor) => honor.id)).toContain("civic-compass");
    expect(seeded.civicScore).toBeGreaterThanOrEqual(oldRuleScore(rows, "2026-03-03T12:00:00.000Z"));
    expect(recordOf()?.civicHonors?.SS).toContain("civic-compass");

    // Kept (UX-31) though the profile stays locked on its themes.
    setVotes([...rows, row("bill-25", "Yea", "2026-03-03T12:30:00.000Z")]);
    const later = await scoreAt("2026-03-03T13:00:00.000Z");
    expect(later.honors.map((honor) => honor.id)).toContain("civic-compass");
    expect(later.honorBonus).toBe(seeded.honorBonus);
  });

  it("derives the ranks, with 'Stalwart' where 'Delegate' was (the id stays for 1.1's colour)", async () => {
    seedPii();
    const rows = Array.from({ length: 25 }, (_, index) =>
      row(
        `bill-${index}`,
        ["Yea", "Nay", "Abstain"][index % 3],
        `2026-02-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`,
        {
          civicProfile: { M: { localVsFederal: { N: "0.4" } } },
          lifeAreas: labels(`Area ${index % 5}`),
        },
      ),
    );
    setVotes(rows);

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    // 25 votes (250), a best streak of 25 days (125), and every honor but Civic Compass (17 Yea or Nay) and Public Record.
    expect(body.voteScore).toBe(250);
    expect(body.streakBonus).toBe(125);
    expect(body.honorBonus).toBe(300);
    expect(body.civicScore).toBe(675);
    expect(body.rank).toEqual({ id: "voice", title: "Voice", minScore: 250, approxVotesRequired: 25 });
    expect(body.nextRank).toEqual({ id: "delegate", title: "Stalwart", minScore: 1000, approxVotesRequired: 100 });
    expect(body.scoreToNextRank).toBe(325);

    setVotes([
      ...rows,
      ...Array.from({ length: 40 }, (_, index) => row(`more-${index}`, "Abstain", "2026-02-20T09:00:00.000Z")),
    ]);
    const later = await scoreAt("2026-03-03T12:05:00.000Z");
    expect(later.civicScore).toBe(1075);
    expect(later.rank).toEqual({ id: "delegate", title: "Stalwart", minScore: 1000, approxVotesRequired: 100 });
    expect(later.nextRank!.title).toBe("Steward");
  });

  it("counts a former and a current label name as one coverage area (LLM-10), Abstain's labels included", async () => {
    seedPii();
    setVotes([
      // Vote rows keep the labels the bill had when the vote was cast; they are not rewritten.
      row("bill-1", "Yea", null, { subCategories: labels("Social Justice"), lifeAreas: labels("Taxes") }),
      row("bill-2", "Nay", null, { subCategories: labels("Civil Rights and Liberties", "Energy") }),
      row("bill-3", "Yea", null, { subCategories: labels(" Identity Politics ") }),
      row("bill-4", "Yea", null, { subCategories: labels("Heritage and Identity") }),
      row("bill-5", "Abstain", null, { subCategories: labels("Healthcare") }),
    ]);

    // taxes, civil rights and liberties, energy, heritage and identity, healthcare
    expect((await scoreAt("2026-03-03T12:00:00.000Z")).coverageAreaCount).toBe(5);
  });
});

describe("UX-31: days from the first vote on a bill, in America/New_York", () => {
  it("adds no day when an old vote is changed (firstVotedAt), and reads votedAt on a row written before UX-31", async () => {
    seedPii();
    setVotes([
      row("bill-1", "Yea", "2026-03-01T15:00:00.000Z"),
      // Changed today, first cast on Feb 20: it counts on Feb 20.
      row("bill-2", "Nay", "2026-03-03T11:00:00.000Z", firstVotedAt("2026-02-20T15:00:00.000Z")),
      // A vote from before votes were timed, changed since: counted, on no day.
      row("bill-3", "Yea", "2026-03-03T11:30:00.000Z", { firstVotedAt: { NULL: true } }),
    ]);

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.totalVotes).toBe(3);
    // Mar 1 is two days back: the streak has ended.
    expect(body.currentStreak).toBe(0);
    expect(body.lastVotedAt).toBe("2026-03-01T15:00:00.000Z");
    const recent = Object.fromEntries(body.recentVoteDays.map((day) => [day.date, day.count]));
    expect([recent["2026-02-20"], recent["2026-03-01"], recent["2026-03-03"]]).toEqual([1, 1, 0]);
  });

  it("switches a user to Eastern days at the first Eastern midnight after their first read, and stores it", async () => {
    seedPii();
    // 9 PM EDT on Oct 27 is Oct 28 in UTC.
    setVotes([row("bill-1", "Yea", "2026-10-28T01:00:00.000Z")]);

    const first = await scoreAt("2026-10-29T15:00:00.000Z");
    expect(recordOf()?.civicEasternFrom).toEqual({ S: "2026-10-30T04:00:00.000Z" });
    // Still UTC days: the vote is on Oct 28.
    expect(first.recentVoteDays.at(-1)).toEqual({ date: "2026-10-29", count: 0 });
    expect(first.recentVoteDays.at(-2)).toEqual({ date: "2026-10-28", count: 1 });
    expect(first.currentStreak).toBe(1);

    // A vote at 9 PM EDT on Oct 30, after the switch, counts on Oct 30.
    setVotes([
      row("bill-1", "Yea", "2026-10-28T01:00:00.000Z"),
      row("bill-2", "Nay", null, firstVotedAt("2026-10-31T01:00:00.000Z")),
    ]);
    const later = await scoreAt("2026-10-31T02:00:00.000Z");
    expect(later.recentVoteDays.at(-1)).toEqual({ date: "2026-10-30", count: 1 });
    expect(recordOf()?.civicEasternFrom).toEqual({ S: "2026-10-30T04:00:00.000Z" });
  });

  it("breaks no streak at the switch: a UTC-day streak that Eastern days would end stays alive", async () => {
    seedPii();
    // Votes at 9 PM EDT on Oct 26 and Oct 27: UTC days Oct 27 and Oct 28, Eastern days Oct 26 and Oct 27.
    setVotes([row("bill-1", "Yea", "2026-10-27T01:00:00.000Z"), row("bill-2", "Nay", "2026-10-28T01:00:00.000Z")]);

    // 11 AM EDT on Oct 29: Eastern days alone would put the last vote two days back.
    const first = await scoreAt("2026-10-29T15:00:00.000Z");
    expect(first.currentStreak).toBe(2);

    // A vote on the evening of Oct 30 (Eastern, after the switch) continues it: Oct 28 (UTC), Oct 29 missing.
    setVotes([
      row("bill-1", "Yea", "2026-10-27T01:00:00.000Z"),
      row("bill-2", "Nay", "2026-10-28T01:00:00.000Z"),
      row("bill-3", "Yea", null, firstVotedAt("2026-10-29T16:00:00.000Z")),
      row("bill-4", "Abstain", null, firstVotedAt("2026-10-31T01:00:00.000Z")),
    ]);
    const later = await scoreAt("2026-10-31T02:00:00.000Z");
    expect(later.currentStreak).toBe(4);
    expect(later.longestStreak).toBe(4);
  });

  it("counts a streak across the night clocks fall back (Nov 1, 2026)", async () => {
    seedPii({
      civicEasternFrom: { S: "2026-10-01T04:00:00.000Z" },
      civicVotes: { N: "0" },
      civicBestStreak: { N: "0" },
    });
    setVotes([
      // 11:30 PM EDT Oct 31, 11:30 PM EST Nov 1, 12:30 AM EST Nov 3.
      row("bill-1", "Yea", null, firstVotedAt("2026-11-01T03:30:00.000Z")),
      row("bill-2", "Yea", null, firstVotedAt("2026-11-02T04:30:00.000Z")),
      row("bill-3", "Yea", null, firstVotedAt("2026-11-03T05:30:00.000Z")),
    ]);

    const body = await scoreAt("2026-11-03T15:00:00.000Z");

    expect(body.recentVoteDays.slice(-4)).toEqual([
      { date: "2026-10-31", count: 1 },
      { date: "2026-11-01", count: 1 },
      { date: "2026-11-02", count: 0 },
      { date: "2026-11-03", count: 1 },
    ]);
    expect(body.currentStreak).toBe(1);
    expect(body.longestStreak).toBe(2);
  });
});

describe("UX-31: the score, the rank, the best streak and the honors never drop", () => {
  it("seeds the record at the first read from what the old rule showed, so no score drops at the deploy", async () => {
    seedPii();
    // A 3-day streak alive today under UTC days, and a 7-day one in February.
    const rows = [
      ...Array.from({ length: 7 }, (_, index) => row(`feb-${index}`, "Yea", `2026-02-0${index + 1}T22:00:00.000Z`)),
      row("mar-1", "Nay", "2026-03-01T23:30:00.000Z"),
      row("mar-2", "Yea", "2026-03-02T23:30:00.000Z"),
      row("mar-3", "Abstain", "2026-03-03T01:00:00.000Z"),
      row("mar-3b", "Yea", "2026-03-03T02:00:00.000Z"),
    ];
    setVotes(rows);
    const before = oldRuleScore(rows, "2026-03-03T12:00:00.000Z");

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.civicScore).toBeGreaterThanOrEqual(before);
    expect(body.longestStreak).toBe(7);
    expect(body.streakBonus).toBe(35);
    expect(recordOf()).toMatchObject({
      civicEasternFrom: { S: "2026-03-04T05:00:00.000Z" },
      civicVotes: { N: "11" },
      civicVoteRows: { N: "11" },
      civicCountedVotes: { N: "11" },
      civicBestStreak: { N: "7" },
      civicHonors: { SS: ["first-voice", "steady", "steady-hand"] },
      civicUpdatedAt: { S: "2026-03-03T12:00:00.000Z" },
    });
  });

  it("keeps the score and rank when a streak ends", async () => {
    seedPii();
    setVotes(
      Array.from({ length: 5 }, (_, index) => row(`bill-${index}`, "Yea", `2026-03-0${index + 1}T15:00:00.000Z`)),
    );
    const during = await scoreAt("2026-03-05T18:00:00.000Z");
    expect(during.currentStreak).toBe(5);

    const after = await scoreAt("2026-03-12T18:00:00.000Z");
    expect(after.currentStreak).toBe(0);
    expect(after.longestStreak).toBe(5);
    expect(after.civicScore).toBe(during.civicScore);
    expect(after.rank).toEqual(during.rank);
  });

  it("keeps honors and the vote points when the votes counted fall, and the next vote still earns its 10", async () => {
    seedPii();
    const rows = Array.from({ length: 25 }, (_, index) =>
      row(`BILLS-119hr${index + 1}`, "Yea", "2026-02-10T15:00:00.000Z"),
    );
    rows.push(row("BILLS-119s900", "Nay", "2026-02-10T16:00:00.000Z"));
    setVotes(rows);
    const before = await scoreAt("2026-03-03T12:00:00.000Z");
    expect(before.totalVotes).toBe(26);

    // The pair hr1/s900 is published: the two votes count once now. And 1.1 wrote a dismissal over another vote,
    // which keeps the vote's first time (SetFeedback, firstVotedAtFor).
    useGroups([["BILLS-119hr1", "BILLS-119s900"]]);
    rows[24] = row("BILLS-119hr25", "Abstain", "2026-03-03T13:00:00.000Z", {
      legacyDismiss: { BOOL: true },
      ...firstVotedAt("2026-02-10T15:00:00.000Z"),
    });
    setVotes(rows);
    const after = await scoreAt("2026-03-03T14:00:00.000Z");

    expect(after.totalVotes).toBe(24);
    expect(after.voteScore).toBe(260);
    expect(after.honors.map((honor) => honor.id)).toContain("on-record");
    expect(after.civicScore).toBe(before.civicScore);
    expect(recordOf()).toMatchObject({
      civicVotes: { N: "26" },
      civicVoteRows: { N: "26" },
      civicCountedVotes: { N: "24" },
    });

    // F1: the next vote earns its 10 at once, though "Bills voted" is still below the votes the record holds.
    setVotes([...rows, row("BILLS-119hr500", "Yea", null, firstVotedAt("2026-03-03T15:00:00.000Z"))]);
    const next = await scoreAt("2026-03-03T15:01:00.000Z");
    expect(next.totalVotes).toBe(25);
    expect(next.voteScore).toBe(270);
    expect(next.civicScore).toBe(after.civicScore + 10);
  });

  it("adds each vote once, even when a read misses it (a replica behind) between two that see it", async () => {
    seedPii();
    const rows = Array.from({ length: 30 }, (_, index) => row(`bill-${index}`, "Yea", "2026-02-10T15:00:00.000Z"));
    setVotes(rows);
    const seeded = await scoreAt("2026-03-03T12:00:00.000Z");
    expect(seeded.voteScore).toBe(300);

    const newVote = row("bill-30", "Nay", null, firstVotedAt("2026-03-03T12:30:00.000Z"));
    setVotes([...rows, newVote]);
    expect((await scoreAt("2026-03-03T12:31:00.000Z")).voteScore).toBe(310);
    // An eventually consistent Query that has not seen the vote yet.
    setVotes(rows);
    const stale = await scoreAt("2026-03-03T12:31:01.000Z");
    expect(stale.voteScore).toBe(310);
    expect(stale.totalVotes).toBe(30);
    setVotes([...rows, newVote]);
    expect((await scoreAt("2026-03-03T12:31:02.000Z")).voteScore).toBe(310);
    expect(recordOf()?.civicVotes).toEqual({ N: "31" });
  });

  it("counts a companion pair once: a vote on the other member, or the groups switched off, adds no points", async () => {
    seedPii();
    useGroups([["BILLS-119hr1", "BILLS-119s900"]]);
    setVotes([row("BILLS-119hr1", "Yea", "2026-03-02T15:00:00.000Z")]);
    expect((await scoreAt("2026-03-03T12:00:00.000Z")).voteScore).toBe(10);

    // A vote on the Senate member of the published pair (a build that shows it on its own).
    setVotes([
      row("BILLS-119hr1", "Yea", "2026-03-02T15:00:00.000Z"),
      row("BILLS-119s900", "Nay", null, firstVotedAt("2026-03-03T12:30:00.000Z")),
    ]);
    const paired = await scoreAt("2026-03-03T12:31:00.000Z");
    expect([paired.totalVotes, paired.voteScore]).toEqual([1, 10]);

    // The groups switched off (12.1): the pair counts twice in "Bills voted", but adds no points; nor does switching
    // them back on take any.
    groups = () => ({});
    const off = await scoreAt("2026-03-03T12:40:00.000Z");
    expect([off.totalVotes, off.voteScore]).toEqual([2, 10]);
    useGroups([["BILLS-119hr1", "BILLS-119s900"]]);
    const on = await scoreAt("2026-03-03T12:50:00.000Z");
    expect([on.totalVotes, on.voteScore]).toEqual([1, 10]);
  });

  it("adds nothing for a vote on a bill whose vote 1.1 had turned into a dismissal", async () => {
    seedPii();
    const kept = [row("bill-1", "Yea", "2026-03-01T15:00:00.000Z")];
    setVotes([...kept, row("bill-2", "Nay", null, firstVotedAt("2026-03-02T15:00:00.000Z"))]);
    expect((await scoreAt("2026-03-03T12:00:00.000Z")).voteScore).toBe(20);

    setVotes([
      ...kept,
      row("bill-2", "Abstain", "2026-03-03T12:10:00.000Z", {
        legacyDismiss: { BOOL: true },
        ...firstVotedAt("2026-03-02T15:00:00.000Z"),
      }),
    ]);
    const dismissed = await scoreAt("2026-03-03T12:11:00.000Z");
    expect([dismissed.totalVotes, dismissed.voteScore]).toEqual([1, 20]);

    // 1.2 votes on it again: the bill is in the record already.
    setVotes([...kept, row("bill-2", "Yea", "2026-03-03T12:20:00.000Z", firstVotedAt("2026-03-02T15:00:00.000Z"))]);
    const again = await scoreAt("2026-03-03T12:21:00.000Z");
    expect([again.totalVotes, again.voteScore]).toEqual([2, 20]);
  });

  it("does not raise the record from a read that could not apply the companion groups", async () => {
    load({ MANIFEST_TABLE_NAME: "BillsManifest", MANIFEST_PRIMARY_KEY: "pk" });
    seedPii({
      civicEasternFrom: { S: "2026-03-01T05:00:00.000Z" },
      civicVotes: { N: "1" },
      civicBestStreak: { N: "1" },
    });
    groups = () => {
      throw new Error("AccessDenied");
    };
    setVotes([
      row("BILLS-119hr1", "Yea", "2026-03-02T15:00:00.000Z"),
      row("BILLS-119s900", "Nay", "2026-03-02T16:00:00.000Z"),
    ]);

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.totalVotes).toBe(2);
    expect(calls()).not.toContain(`UpdateItemCommand ${PII_TABLE}`);
    expect(recordOf()?.civicVotes).toEqual({ N: "1" });
  });
});

describe("UX-31: the record on the UserPII row", () => {
  it("costs one consistent GetItem a read, and a write only when something rose", async () => {
    seedPii();
    setVotes([row("bill-1", "Yea", "2026-03-03T09:00:00.000Z")]);

    await scoreAt("2026-03-03T12:00:00.000Z");
    expect(calls().sort()).toEqual([
      `GetItemCommand ${PII_TABLE}`,
      `QueryCommand ${FEEDBACK_TABLE}`,
      `UpdateItemCommand ${PII_TABLE}`,
    ]);
    const read = send.mock.calls.find(([command]) => command.input.TableName === PII_TABLE)![0].input;
    expect(read.ConsistentRead).toBe(true);
    expect(read.Key).toEqual({ user_id: { S: USER } });

    send.mockClear();
    await scoreAt("2026-03-03T18:00:00.000Z");
    expect(calls().sort()).toEqual([`GetItemCommand ${PII_TABLE}`, `QueryCommand ${FEEDBACK_TABLE}`]);
  });

  it("projects the first-vote time with the vote rows", async () => {
    seedPii();
    await scoreAt("2026-03-03T12:00:00.000Z");
    const query = send.mock.calls.find(([command]) => command.constructor.name === "QueryCommand")![0].input;
    expect(query.ProjectionExpression).toBe(
      "feedback, votedAt, #firstVotedAt, civicProfile, lifeAreas, subCategories, #sk, #legacyDismiss",
    );
    expect(query.ExpressionAttributeNames).toEqual({
      "#pk": "user_id",
      "#sk": "billId",
      "#legacyDismiss": "legacyDismiss",
      "#firstVotedAt": "firstVotedAt",
    });
  });

  it("writes nothing for a user with no votes", async () => {
    seedPii();
    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body).toMatchObject({ civicScore: 0, totalVotes: 0, currentStreak: 0, longestStreak: 0, lastVotedAt: null });
    expect(body.rank.title).toBe("Citizen");
    expect(calls()).not.toContain(`UpdateItemCommand ${PII_TABLE}`);
  });

  it("never creates a UserPII row, and answers from the votes for a user who has none", async () => {
    setVotes([row("bill-1", "Yea", "2026-03-03T09:00:00.000Z")]);

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.civicScore).toBe(10 + 5 + 25);
    expect(calls()).not.toContain(`UpdateItemCommand ${PII_TABLE}`);
    expect(piiRows.size).toBe(0);
  });

  it("writes nothing to an account being deleted or deleted", async () => {
    for (const deletionStatus of ["in_progress", "completed"]) {
      piiRows = new Map();
      seedPii({ deletionStatus: { S: deletionStatus } });
      setVotes([row("bill-1", "Yea", "2026-03-03T09:00:00.000Z")]);
      send.mockClear();

      await scoreAt("2026-03-03T12:00:00.000Z");

      expect(calls()).not.toContain(`UpdateItemCommand ${PII_TABLE}`);
      expect(Object.keys(recordOf()!).sort()).toEqual(["adultStatus", "deletionStatus", "user_id"]);
    }
  });

  it("a deletion that lands between the read and the write is not written over", async () => {
    seedPii();
    setVotes([row("bill-1", "Yea", "2026-03-03T09:00:00.000Z")]);
    beforeCommand = (op, input) => {
      if (op === "UpdateItemCommand")
        piiRows.set(USER, { user_id: input.Key!.user_id, deletionStatus: { S: "completed" } });
    };

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.totalVotes).toBe(1);
    expect(recordOf()).toEqual({ user_id: { S: USER }, deletionStatus: { S: "completed" } });
    expect(calls().filter((call) => call.startsWith("UpdateItemCommand"))).toHaveLength(1);
  });

  it("when a concurrent read raised the record first, answers from it and stores the merge", async () => {
    seedPii({
      civicEasternFrom: { S: "2026-03-01T05:00:00.000Z" },
      civicVotes: { N: "1" },
      civicVoteRows: { N: "1" },
      civicCountedVotes: { N: "1" },
      civicBestStreak: { N: "1" },
      civicHonors: { SS: ["first-voice"] },
    });
    setVotes([row("bill-1", "Yea", "2026-03-01T15:00:00.000Z"), row("bill-2", "Nay", "2026-03-02T15:00:00.000Z")]);
    let raced = false;
    beforeCommand = (op) => {
      if (op !== "UpdateItemCommand" || raced) return;
      raced = true;
      // Another read stored a higher best streak in between (and an honor this read cannot see).
      piiRows.set(USER, {
        ...piiRows.get(USER)!,
        civicVotes: { N: "2" },
        civicVoteRows: { N: "2" },
        civicCountedVotes: { N: "2" },
        civicBestStreak: { N: "9" },
        civicHonors: { SS: ["first-voice", "steady", "steady-hand"] },
      });
    };

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.longestStreak).toBe(9);
    expect(body.honors.map((honor) => honor.id)).toEqual(["first-voice", "steady", "steady-hand"]);
    expect(calls().filter((call) => call.startsWith("UpdateItemCommand"))).toHaveLength(1);
    expect(recordOf()?.civicBestStreak).toEqual({ N: "9" });
  });

  it("answers 200 from what it read when the write fails, and reports it", async () => {
    seedPii();
    setVotes([row("bill-1", "Yea", "2026-03-03T09:00:00.000Z")]);
    beforeCommand = (op) => {
      if (op === "UpdateItemCommand") throw Object.assign(new Error("Throttled"), { name: "ThrottlingException" });
    };

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.civicScore).toBe(40);
    expect(logLines(logSpy).some((line) => line.CivicRecordWriteFailed === 1)).toBe(true);
  });

  it("answers 500 when the record cannot be read, rather than a score that could be lower", async () => {
    seedPii();
    setVotes([row("bill-1", "Yea", "2026-03-03T09:00:00.000Z")]);
    beforeCommand = (op, input) => {
      if (op === "GetItemCommand" && input.TableName === PII_TABLE) throw new Error("DynamoDB unavailable");
    };

    jest.setSystemTime(new Date("2026-03-03T12:00:00.000Z"));
    const response = await handler({ requestContext: { authorizer: { jwt: { claims: { sub: USER } } } } });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "Internal server error" });
    // F2: the 500 is returned, not thrown, so only this metric (and its alarm) shows it.
    const metric = logLines(logSpy).find((line) => line.CivicRecordReadFailed === 1);
    expect(metric?._aws?.CloudWatchMetrics?.[0]?.Namespace).toBe("BillBoard/CivicScore");
  });

  it("never adds a vote twice when a concurrent read stored more vote rows first", async () => {
    seedPii({
      civicEasternFrom: { S: "2026-03-01T05:00:00.000Z" },
      civicVotes: { N: "1" },
      civicVoteRows: { N: "1" },
      civicCountedVotes: { N: "1" },
      civicBestStreak: { N: "1" },
    });
    setVotes([row("bill-1", "Yea", "2026-03-02T15:00:00.000Z"), row("bill-2", "Nay", "2026-03-03T09:00:00.000Z")]);
    let raced = false;
    beforeCommand = (op) => {
      if (op !== "UpdateItemCommand" || raced) return;
      raced = true;
      // A later read saw a third vote this read misses, and stored it.
      piiRows.set(USER, {
        ...piiRows.get(USER)!,
        civicVotes: { N: "3" },
        civicVoteRows: { N: "3" },
        civicCountedVotes: { N: "3" },
      });
    };

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.voteScore).toBe(30);
    expect(recordOf()).toMatchObject({
      civicVotes: { N: "3" },
      civicVoteRows: { N: "3" },
      civicCountedVotes: { N: "2" },
    });
    // The third vote, once this read's count is stored, adds nothing more.
    setVotes([
      row("bill-1", "Yea", "2026-03-02T15:00:00.000Z"),
      row("bill-2", "Nay", "2026-03-03T09:00:00.000Z"),
      row("bill-3", "Yea", null, firstVotedAt("2026-03-03T11:59:00.000Z")),
    ]);
    beforeCommand = undefined;
    expect((await scoreAt("2026-03-03T12:01:00.000Z")).voteScore).toBe(30);
  });

  it("keeps nothing and still answers without PII_TABLE_NAME", async () => {
    load({ PII_TABLE_NAME: undefined });
    setVotes([row("bill-1", "Abstain", "2026-03-03T09:00:00.000Z")]);

    const body = await scoreAt("2026-03-03T12:00:00.000Z");

    expect(body.civicScore).toBe(40);
    expect(calls()).toEqual([`QueryCommand ${FEEDBACK_TABLE}`]);
  });
});

describe("UX-31: the seed is never below the old rule", () => {
  // Random histories of Yea, Nay, Abstain and dismissals over 40 days, read at random times.
  const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  it.each(Array.from({ length: 40 }, (_, index) => index + 1))("history %i", async (seed) => {
    const next = random(seed);
    const start = Date.parse("2026-02-01T00:00:00.000Z");
    const rows = Array.from({ length: Math.floor(next() * 60) }, (_, index) => {
      const feedback = ["Yea", "Nay", "Abstain", "Yea"][Math.floor(next() * 4)];
      const votedAt = new Date(start + Math.floor(next() * 40 * 86_400_000)).toISOString();
      return row(`bill-${index}`, feedback, next() < 0.1 ? null : votedAt, {
        ...(next() < 0.3 ? { lifeAreas: labels(`Area ${Math.floor(next() * 6)}`) } : {}),
        ...(next() < 0.5 ? { civicProfile: { M: { localVsFederal: { N: "0.1" } } } } : {}),
        ...(feedback === "Abstain" && next() < 0.2 ? { legacyDismiss: { BOOL: true } } : {}),
      });
    });
    const now = new Date(start + 30 * 86_400_000 + Math.floor(next() * 12 * 86_400_000)).toISOString();
    piiRows = new Map();
    seedPii();
    setVotes(rows);

    const body = await scoreAt(now);

    expect(body.civicScore).toBeGreaterThanOrEqual(oldRuleScore(rows, now));
    expect(body.civicScore).toBe(body.voteScore + body.streakBonus + body.honorBonus);
  });
});

describe("fetchCivicScore companion groups (APPF-23)", () => {
  const vote = (billId: string, feedback: string, day: number): Item => ({
    user_id: { S: USER },
    billId: { S: billId },
    feedback: { S: feedback },
    votedAt: { S: `2026-02-${String(day).padStart(2, "0")}T09:00:00.000Z` },
  });
  const groupsRow = (enabled: boolean) => ({
    Item: {
      pk: { S: "BILL_COMPANION_GROUPS" },
      sk: { S: "CURRENT" },
      pairsVersion: { N: "3" },
      enabled: { BOOL: enabled },
      pairs: {
        S: JSON.stringify([
          ["BILLS-119hr1285", "BILLS-119s570"],
          ["BILLS-119hr2000", "BILLS-119s1000"],
          ["BILLS-119hr3000", "BILLS-119s3000"],
        ]),
      },
    },
  });

  beforeEach(() => {
    load({ MANIFEST_TABLE_NAME: "BillsManifest", MANIFEST_PRIMARY_KEY: "pk" });
    seedPii();
  });

  const scoreFor = async (items: Item[], read: () => unknown = () => groupsRow(true)) => {
    groups = read;
    piiRows = new Map();
    seedPii();
    setVotes(items);
    return scoreAt("2026-03-03T12:00:00.000Z");
  };

  const pairVotes = [
    // Both members of one pair: the House row counts, once.
    vote("BILLS-119hr1285", "Yea", 1),
    vote("BILLS-119s570is", "Nay", 2),
    // The Senate member only: it still counts.
    vote("BILLS-119s1000", "Yea", 3),
    // An ungrouped bill.
    vote("BILLS-119hr77", "Nay", 4),
  ];

  it("counts a user with votes on both members once and a partner-only vote once", async () => {
    const body = await scoreFor(pairVotes);

    expect(body.totalVotes).toBe(3);
    expect(body.voteScore).toBe(30);
  });

  it("lets the primary's Abstain stand for the pair over a Yea on the other member, and counts it (UX-31)", async () => {
    const body = await scoreFor([vote("BILLS-119hr3000", "Abstain", 1), vote("BILLS-119s3000", "Yea", 2)]);

    expect(body.totalVotes).toBe(1);
    expect(body.lastVotedAt).toBe("2026-02-01T09:00:00.000Z");
  });

  // INT-11: a 1.0 or 1.1 Updates dismissal is not a vote, so it never stands for the pair.
  it("does not let a 1.0 or 1.1 dismissal on the primary hide the Yea on the other member", async () => {
    const dismissal = { ...vote("BILLS-119hr3000", "Abstain", 1), legacyDismiss: { BOOL: true } };
    const body = await scoreFor([dismissal, vote("BILLS-119s3000", "Yea", 2)]);

    expect(body.totalVotes).toBe(1);
    expect(body.lastVotedAt).toBe("2026-02-02T09:00:00.000Z");
  });

  it("still counts a dismissal as no vote when it is the user's only row on the pair", async () => {
    const dismissal = { ...vote("BILLS-119hr3000", "Abstain", 1), legacyDismiss: { BOOL: true } };
    const body = await scoreFor([dismissal, vote("BILLS-119hr77", "Nay", 4)]);

    expect(body.totalVotes).toBe(1);
  });

  it("counts every vote while the published groups are turned off", async () => {
    expect((await scoreFor(pairVotes, () => groupsRow(false))).totalVotes).toBe(4);
  });

  it("counts every vote when the groups cannot be read and none were read before, and stores nothing", async () => {
    const body = await scoreFor(pairVotes, () => {
      throw new Error("AccessDenied");
    });

    expect(body.totalVotes).toBe(4);
    expect(calls()).not.toContain(`UpdateItemCommand ${PII_TABLE}`);
  });

  it("uses the groups it read last when they cannot be read again, and stores nothing from that read (UX-31)", async () => {
    expect((await scoreFor(pairVotes)).totalVotes).toBe(3);
    expect(recordOf()?.civicVotes).toEqual({ N: "3" });

    groups = () => {
      throw new Error("AccessDenied");
    };
    setVotes([...pairVotes, vote("BILLS-119hr500", "Yea", 5)]);
    send.mockClear();
    // Over a minute later, so the groups are read again.
    const body = await scoreAt("2026-03-03T12:05:00.000Z");

    expect(body.totalVotes).toBe(4);
    expect(calls()).not.toContain(`UpdateItemCommand ${PII_TABLE}`);
    expect(recordOf()?.civicVotes).toEqual({ N: "3" });
    expect(
      logLines(console.warn).some(
        (line) => line.message === "fetchCivicScore could not read the companion groups; using the ones it read last",
      ),
    ).toBe(true);
  });

  it("does not read the groups for a user with fewer than two votes", async () => {
    send.mockClear();
    await scoreFor([vote("BILLS-119hr1285", "Yea", 1)]);

    expect(send.mock.calls.some(([command]) => command.input?.Key?.pk)).toBe(false);
  });
});
