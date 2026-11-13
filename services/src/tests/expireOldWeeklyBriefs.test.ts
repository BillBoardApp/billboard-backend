import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import {
  type CliOptions,
  type ExpireConfig,
  OVERDUE_AFTER_DAYS,
  classifyRow,
  configFromEnv,
  isOverdue,
  parseArgs,
  runExpire,
  updateFor,
} from "../../scripts/expireOldWeeklyBriefs";

/*
 * `npm run expire:old-weekly-briefs` (WEB-07 privacy draft, gap G1; project decision of 2026-11-12; RUNBOOK 25.3): the
 * dry run scans UserWeeklyDigests and writes nothing; --apply refuses unless the rows to set are exactly --expect and
 * none is unreadable, then sets ttl = publishedAt + 21 days on each row whose ttl is missing or later, with a
 * condition that keeps it from creating a row, moving a ttl later or touching a row changed since the scan, and stops
 * at the first error. It also counts the rows whose ttl passed more than 3 days ago (overdue), which DynamoDB has not
 * deleted yet. Nothing it prints names a user, a brief's date or a brief.
 */

type Item = Record<string, AttributeValue>;
interface FakeCommand {
  constructor: { name: string };
  input: {
    TableName?: string;
    ExclusiveStartKey?: Item;
    ProjectionExpression?: string;
    ConsistentRead?: boolean;
    Key?: Item;
    UpdateExpression?: string;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Item;
  };
}

const config: ExpireConfig = {
  region: "us-east-1",
  tableName: "UserWeeklyDigests",
  partitionKey: "userId",
  sortKey: "publishedAt",
};
const dryRun: CliOptions = { help: false, apply: false, expect: null };
const apply = (expect: number): CliOptions => ({ help: false, apply: true, expect });

const DAY = 24 * 60 * 60;
const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const target = (publishedAt: string): number => epoch(publishedAt) + 21 * DAY;

/** The runs' clock: 2026-11-12, the day of the dry run. */
const NOW = epoch("2026-11-12T12:00:00.000Z");
const now = (): number => NOW * 1000;

const row = (
  userId: string,
  publishedAt: string,
  ttl?: AttributeValue,
  createdAt: string | null = publishedAt,
): Item => ({
  userId: { S: userId },
  publishedAt: { S: publishedAt },
  payload: { S: JSON.stringify({ secret: `brief of ${userId}` }) },
  ...(createdAt === null ? {} : { createdAt: { S: createdAt } }),
  ...(ttl === undefined ? {} : { ttl }),
});

const MARCH = "2026-03-29T14:00:00.000Z";
const OCTOBER_11 = "2026-10-11T14:00:00.000Z";
const OCTOBER_18 = "2026-10-18T14:00:00.000Z";
const NOVEMBER_8 = "2026-11-08T15:00:00.000Z";

/** The table as on 2026-11-11, in small: two rows with no ttl, one with the 180-day ttl, one already right. */
const TABLE = (): Item[] => [
  row("u-1", MARCH),
  row("u-2", OCTOBER_11, undefined, null),
  row("u-3", OCTOBER_18, { N: String(epoch(OCTOBER_18) + 180 * DAY) }),
  row("u-4", NOVEMBER_8, { N: String(target(NOVEMBER_8)) }),
];

const SECRETS = ["u-1", "u-2", "u-3", "u-4", "brief of", "2026-03-29", "2026-10-11", "2026-10-18", "2026-11-08"];

const keyOf = (item: Item): string => `${item.userId?.S}|${item.publishedAt?.S}`;

/**
 * An in-memory table that honours the update's condition as DynamoDB would for the expressions the script writes,
 * paged two rows at a time.
 */
const fakeTable = (
  initial: Item[],
  options: { failAt?: number; beforeUpdate?: (rows: Map<string, Item>, index: number) => void } = {},
) => {
  const rows = new Map(initial.map((item) => [keyOf(item), { ...item }]));
  const calls: Array<{ name: string; input: FakeCommand["input"] }> = [];
  let updates = 0;
  const holds = (clause: string, item: Item | undefined, values: Item, names: Record<string, string>): boolean => {
    const attribute = (token: string): AttributeValue | undefined => item?.[names[token]];
    const same = (a?: AttributeValue, b?: AttributeValue): boolean => JSON.stringify(a) === JSON.stringify(b);
    let match = /^attribute_exists\((#\w+)\)$/.exec(clause);
    if (match) return attribute(match[1]) !== undefined;
    match = /^attribute_not_exists\((#\w+)\)$/.exec(clause);
    if (match) return attribute(match[1]) === undefined;
    match = /^(#\w+) = (:\w+)$/.exec(clause);
    if (match) return attribute(match[1]) !== undefined && same(attribute(match[1]), values[match[2]]);
    match = /^(#\w+) > (:\w+)$/.exec(clause);
    if (match) {
      const left = attribute(match[1]);
      return left?.N !== undefined && Number(left.N) > Number(values[match[2]].N);
    }
    throw new Error(`Unexpected clause ${clause}`);
  };
  const send = jest.fn(async (command: FakeCommand) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "ScanCommand") {
      const all = [...rows.values()];
      const start = command.input.ExclusiveStartKey ? Number(command.input.ExclusiveStartKey.offset.N) : 0;
      return {
        // The projection: never the brief itself.
        Items: all
          .slice(start, start + 2)
          .map((item) => Object.fromEntries(Object.entries(item).filter(([name]) => name !== "payload"))),
        LastEvaluatedKey: start + 2 < all.length ? { offset: { N: String(start + 2) } } : undefined,
      };
    }
    if (command.constructor.name === "UpdateItemCommand") {
      options.beforeUpdate?.(rows, updates);
      if (updates === options.failAt) {
        updates += 1;
        throw Object.assign(new Error("Throughput exceeds the current capacity"), {
          name: "ProvisionedThroughputExceededException",
        });
      }
      updates += 1;
      const input = command.input;
      const key = keyOf(input.Key!);
      const item = rows.get(key);
      const clauses = input.ConditionExpression!.split(" AND ");
      if (
        !clauses.every((clause) =>
          holds(clause, item, input.ExpressionAttributeValues!, input.ExpressionAttributeNames!),
        )
      ) {
        throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      }
      rows.set(key, { ...(item ?? input.Key!), ttl: input.ExpressionAttributeValues![":ttl"] });
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  });
  return { send, calls, rows };
};

const ttlOf = (table: ReturnType<typeof fakeTable>, userId: string, publishedAt: string): string | undefined =>
  table.rows.get(`${userId}|${publishedAt}`)?.ttl?.N;

describe("expire:old-weekly-briefs", () => {
  describe("parseArgs", () => {
    it("is a dry run by default", () => {
      expect(parseArgs([])).toEqual(dryRun);
    });

    it("takes --apply only with --expect, and --expect only with --apply", () => {
      expect(parseArgs(["--apply", "--expect", "152"])).toEqual(apply(152));
      expect(() => parseArgs(["--apply"])).toThrow("--apply needs --expect <N>");
      expect(() => parseArgs(["--expect", "3"])).toThrow("--expect goes with --apply only");
      expect(() => parseArgs(["--apply", "--expect", "all"])).toThrow("--expect needs a whole number");
      expect(() => parseArgs(["--apply", "--expect"])).toThrow("--expect needs a value");
    });

    it("refuses unknown flags, --dry-run included", () => {
      expect(() => parseArgs(["--dry-run"])).toThrow("Unknown argument: --dry-run");
      expect(() => parseArgs(["--aply"])).toThrow("Unknown argument: --aply");
      expect(parseArgs(["--help"]).help).toBe(true);
    });

    it("reads its environment", () => {
      expect(configFromEnv({ AWS_REGION: "us-west-2", WEEKLY_DIGESTS_TABLE_NAME: " Other " })).toEqual({
        ...config,
        region: "us-west-2",
        tableName: "Other",
      });
      expect(configFromEnv({})).toEqual(config);
    });
  });

  describe("classifyRow", () => {
    it("sorts rows by their ttl against publishedAt + 21 days", () => {
      expect(classifyRow(row("u", MARCH), config)).toMatchObject({ state: "missingTtl", targetTtl: target(MARCH) });
      expect(classifyRow(row("u", MARCH, { N: String(target(MARCH) + 1) }), config).state).toBe("laterTtl");
      expect(classifyRow(row("u", MARCH, { N: String(target(MARCH)) }), config).state).toBe("alreadyRight");
      expect(classifyRow(row("u", MARCH, { N: String(target(MARCH) - DAY) }), config).state).toBe("alreadyRight");
    });

    it("calls a row unreadable when publishedAt is not a date or the ttl is not a number", () => {
      expect(classifyRow(row("u", "last week"), config)).toMatchObject({ state: "unreadable", targetTtl: null });
      expect(classifyRow(row("u", MARCH, { S: "1775000000" }), config).state).toBe("unreadable");
      expect(classifyRow(row("u", MARCH, { N: "soon" }), config).state).toBe("unreadable");
    });

    it("keeps only the key, and the ttl and createdAt as read", () => {
      const scanned = classifyRow(row("u", MARCH, { N: "1" }), config);
      expect(scanned.key).toEqual({ userId: { S: "u" }, publishedAt: { S: MARCH } });
      expect(scanned.readTtl).toEqual({ N: "1" });
      expect(scanned.readCreatedAt).toEqual({ S: MARCH });
    });
  });

  describe("updateFor", () => {
    it("sets the ttl only on a row that exists with no ttl and the createdAt as read", () => {
      const input = updateFor(classifyRow(row("u", MARCH), config), config).input;
      expect(input).toEqual({
        TableName: "UserWeeklyDigests",
        Key: { userId: { S: "u" }, publishedAt: { S: MARCH } },
        UpdateExpression: "SET #ttl = :ttl",
        ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#ttl) AND #createdAt = :readCreatedAt",
        ExpressionAttributeNames: { "#pk": "userId", "#ttl": "ttl", "#createdAt": "createdAt" },
        ExpressionAttributeValues: { ":ttl": { N: String(target(MARCH)) }, ":readCreatedAt": { S: MARCH } },
      });
    });

    it("moves a later ttl earlier only, and only from the value read", () => {
      const later = String(epoch(OCTOBER_18) + 180 * DAY);
      const input = updateFor(classifyRow(row("u", OCTOBER_18, { N: later }, null), config), config).input;
      expect(input.ConditionExpression).toBe(
        "attribute_exists(#pk) AND #ttl = :readTtl AND #ttl > :ttl AND attribute_not_exists(#createdAt)",
      );
      expect(input.ExpressionAttributeValues).toEqual({
        ":ttl": { N: String(target(OCTOBER_18)) },
        ":readTtl": { N: later },
      });
    });

    it("refuses a row that is not to be set", () => {
      expect(() => updateFor(classifyRow(row("u", NOVEMBER_8, { N: "1" }), config), config)).toThrow(
        "Not a row to set: alreadyRight",
      );
      expect(() => updateFor(classifyRow(row("u", "never"), config), config)).toThrow("Not a row to set: unreadable");
    });
  });

  it("dry run: counts the rows, reads no brief, writes nothing and prints counts only", async () => {
    const table = fakeTable(TABLE());
    const lines: string[] = [];

    const result = await runExpire({ table, config, now, options: dryRun, log: (line) => lines.push(line) });

    expect(table.calls.map((call) => call.name)).toEqual(["ScanCommand", "ScanCommand"]);
    expect(table.calls[0].input).toMatchObject({
      TableName: "UserWeeklyDigests",
      ConsistentRead: true,
      ProjectionExpression: "#pk, #sk, #ttl, #createdAt",
    });
    expect(result).toEqual({
      exitCode: 0,
      tally: { rows: 4, missingTtl: 2, laterTtl: 1, alreadyRight: 1, unreadable: 0, toSet: 3, overdue: 0 },
      set: 0,
      after: null,
    });
    expect(lines[lines.length - 1]).toBe(
      "Weekly Brief expiry plan: rows=4 missingTtl=2 laterTtl=1 alreadyRight=1 unreadable=0 toSet=3 overdue=0",
    );
    for (const secret of SECRETS) expect(lines.join("\n")).not.toContain(secret);
  });

  it("counts as overdue a ttl more than 3 days past, whatever the row's state, and exits 0 on it", async () => {
    const table = fakeTable([
      row("u-1", MARCH, { N: String(target(MARCH)) }),
      row("u-2", MARCH, { N: String(epoch(MARCH) + 180 * DAY) }),
      row("u-3", NOVEMBER_8, { N: String(NOW - OVERDUE_AFTER_DAYS * DAY - 1) }),
      row("u-4", NOVEMBER_8, { N: String(NOW - OVERDUE_AFTER_DAYS * DAY) }),
      row("u-5", NOVEMBER_8, { N: String(NOW - DAY) }),
      row("u-6", OCTOBER_11),
    ]);
    const lines: string[] = [];

    const result = await runExpire({ table, config, now, options: dryRun, log: (line) => lines.push(line) });

    expect(result).toEqual(
      expect.objectContaining({
        exitCode: 0,
        tally: { rows: 6, missingTtl: 1, laterTtl: 1, alreadyRight: 4, unreadable: 0, toSet: 2, overdue: 3 },
      }),
    );
    expect(lines[lines.length - 1]).toBe(
      "Weekly Brief expiry plan: rows=6 missingTtl=1 laterTtl=1 alreadyRight=4 unreadable=0 toSet=2 overdue=3",
    );
  });

  it("never calls an absent or unreadable ttl overdue", () => {
    expect(isOverdue(classifyRow(row("u", MARCH), config), NOW)).toBe(false);
    expect(isOverdue(classifyRow(row("u", MARCH, { S: "1" }), config), NOW)).toBe(false);
    expect(isOverdue(classifyRow(row("u", MARCH, { N: "soon" }), config), NOW)).toBe(false);
    expect(isOverdue(classifyRow(row("u", MARCH, { N: "1" }), config), NOW)).toBe(true);
  });

  it("dry run exits 1 when a row is unreadable", async () => {
    const table = fakeTable([...TABLE(), row("u-5", "not a date")]);

    const result = await runExpire({ table, config, now, options: dryRun, log: () => undefined });

    expect(result.exitCode).toBe(1);
    expect(result.tally.unreadable).toBe(1);
  });

  it("--apply refuses at another count, or with an unreadable row, and writes nothing", async () => {
    const table = fakeTable(TABLE());
    const lines: string[] = [];

    const result = await runExpire({ table, config, now, options: apply(2), log: (line) => lines.push(line) });

    expect(result.exitCode).toBe(2);
    expect(lines[lines.length - 1]).toBe("Refused: 3 row(s) to set, not --expect 2. Run the dry run again.");

    const withUnreadable = fakeTable([...TABLE(), row("u-5", MARCH, { S: "later" })]);
    const refused = await runExpire({
      table: withUnreadable,
      config,
      now,
      options: apply(3),
      log: (line) => lines.push(line),
    });

    expect(refused.exitCode).toBe(2);
    expect(lines[lines.length - 1]).toBe("Refused: 1 row(s) unreadable. Look at them before --apply.");
    expect([...table.calls, ...withUnreadable.calls].filter((call) => call.name !== "ScanCommand")).toEqual([]);
  });

  it("--apply sets publishedAt + 21 days on the missing and later rows, leaves the rest and scans again", async () => {
    const table = fakeTable(TABLE());
    const lines: string[] = [];

    const result = await runExpire({ table, config, now, options: apply(3), log: (line) => lines.push(line) });

    expect(table.calls.filter((call) => call.name === "UpdateItemCommand")).toHaveLength(3);
    expect(ttlOf(table, "u-1", MARCH)).toBe(String(target(MARCH)));
    expect(ttlOf(table, "u-2", OCTOBER_11)).toBe(String(target(OCTOBER_11)));
    expect(ttlOf(table, "u-3", OCTOBER_18)).toBe(String(target(OCTOBER_18)));
    expect(ttlOf(table, "u-4", NOVEMBER_8)).toBe(String(target(NOVEMBER_8)));
    expect([...table.rows.values()].every((item) => item.payload !== undefined)).toBe(true);
    expect(result).toEqual(
      expect.objectContaining({
        exitCode: 0,
        set: 3,
        // The three rows set are past their date (2026-10-18 + 21 days is 2026-11-08) until DynamoDB deletes them.
        after: { rows: 4, missingTtl: 0, laterTtl: 0, alreadyRight: 4, unreadable: 0, toSet: 0, overdue: 3 },
      }),
    );
    expect(lines[lines.length - 1]).toBe("Weekly Brief expiry complete set=3 missingTtlAfter=0 laterTtlAfter=0");
    for (const secret of SECRETS) expect(lines.join("\n")).not.toContain(secret);
  });

  it("a rerun after --apply has nothing to set", async () => {
    const table = fakeTable(TABLE());
    await runExpire({ table, config, now, options: apply(3), log: () => undefined });

    const rerun = await runExpire({ table, config, now, options: apply(0), log: () => undefined });

    expect(rerun).toEqual(expect.objectContaining({ exitCode: 0, set: 0 }));
    expect(table.calls.filter((call) => call.name === "UpdateItemCommand")).toHaveLength(3);
  });

  it("stops at a row deleted since the scan, without creating it, and sets nothing after it", async () => {
    const table = fakeTable(TABLE(), {
      beforeUpdate: (rows, index) => {
        if (index === 1) rows.delete(`u-2|${OCTOBER_11}`);
      },
    });
    const lines: string[] = [];

    const result = await runExpire({ table, config, now, options: apply(3), log: (line) => lines.push(line) });

    expect(result).toEqual(expect.objectContaining({ exitCode: 1, set: 1, after: null }));
    expect(table.rows.has(`u-2|${OCTOBER_11}`)).toBe(false);
    expect(ttlOf(table, "u-3", OCTOBER_18)).toBe(String(epoch(OCTOBER_18) + 180 * DAY));
    expect(table.calls.filter((call) => call.name === "UpdateItemCommand")).toHaveLength(2);
    expect(lines[lines.length - 1]).toBe(
      "Stopped after set=1 of 3: a row changed or went since the scan (ConditionalCheckFailedException). " +
        "Run the dry run again.",
    );
    for (const secret of SECRETS) expect(lines.join("\n")).not.toContain(secret);
  });

  it("never moves a ttl that changed since the scan", async () => {
    const changed = String(target(OCTOBER_18) - DAY);
    const table = fakeTable(TABLE(), {
      beforeUpdate: (rows, index) => {
        if (index === 2) rows.get(`u-3|${OCTOBER_18}`)!.ttl = { N: changed };
      },
    });

    const result = await runExpire({ table, config, now, options: apply(3), log: () => undefined });

    expect(result).toEqual(expect.objectContaining({ exitCode: 1, set: 2 }));
    expect(ttlOf(table, "u-3", OCTOBER_18)).toBe(changed);
  });

  it("does not touch a row replaced since the scan (another createdAt)", async () => {
    const table = fakeTable(TABLE(), {
      beforeUpdate: (rows, index) => {
        if (index === 0) rows.get(`u-1|${MARCH}`)!.createdAt = { S: "2026-11-12T00:00:00.000Z" };
      },
    });

    const result = await runExpire({ table, config, now, options: apply(3), log: () => undefined });

    expect(result).toEqual(expect.objectContaining({ exitCode: 1, set: 0 }));
    expect(ttlOf(table, "u-1", MARCH)).toBeUndefined();
  });

  it("stops at any other error and names only the error", async () => {
    const table = fakeTable(TABLE(), { failAt: 0 });
    const lines: string[] = [];

    const result = await runExpire({ table, config, now, options: apply(3), log: (line) => lines.push(line) });

    expect(result).toEqual(expect.objectContaining({ exitCode: 1, set: 0, after: null }));
    expect(table.calls.filter((call) => call.name === "UpdateItemCommand")).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe(
      "Stopped after set=0 of 3: the update failed (ProvisionedThroughputExceededException). Run the dry run again.",
    );
  });

  it("exits 1 when the scan after --apply still finds a row to set", async () => {
    const table = fakeTable(TABLE(), {
      beforeUpdate: (rows, index) => {
        if (index === 2) rows.set(`u-9|${MARCH}`, row("u-9", MARCH));
      },
    });

    const result = await runExpire({ table, config, now, options: apply(3), log: () => undefined });

    expect(result).toEqual(expect.objectContaining({ exitCode: 1, set: 3 }));
    expect(result.after?.missingTtl).toBe(1);
  });
});
