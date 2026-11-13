import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import {
  activeCompanionPairs,
  BillCompanionDao,
  billCompanionConfigFromEnv,
  type CompanionGroupsStateInput,
} from "../adapters/billCompanionDao";
import { parseBillGuid, type CompanionDeclaration } from "../shared/billCompanions";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";

type Item = Record<string, AttributeValue>;

const config = billCompanionConfigFromEnv({});

/** Every input field the fake table reads, across the commands it answers. */
interface FakeInput extends ConditionInput {
  ExclusiveStartKey?: Item;
  Key?: Item;
  Item?: Item;
  RequestItems?: Record<string, { Keys?: Item[] }>;
}

/** What the fake reads from an AWS SDK command: its class's name and its input. */
interface FakeCommand {
  constructor: { name: string };
  input: FakeInput;
}

/**
 * The manifest table in memory: paged queries (2 items a page), GetItem, conditional PutItem and
 * DeleteItem (the real condition expressions), and BatchGetItem that can leave keys unprocessed.
 */
const fakeTable = (items: Item[] = []) => {
  const key = (pk: string, sk: string) => `${pk}|${sk}`;
  const table = new Map<string, Item>(items.map((item) => [key(item.pk.S!, item.sk.S!), item]));
  const calls: Array<{ name: string; input: FakeInput }> = [];
  let unprocessedOnce = 0;
  const send = jest.fn(async (command: FakeCommand): Promise<Record<string, unknown>> => {
    const name: string = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });
    if (name === "QueryCommand") {
      const pk = input.ExpressionAttributeValues![":pk"].S;
      const all = [...table.values()].filter((item) => item.pk.S === pk).sort((a, b) => (a.sk.S! < b.sk.S! ? -1 : 1));
      const start = input.ExclusiveStartKey
        ? all.findIndex((item) => item.sk.S === input.ExclusiveStartKey!.sk.S) + 1
        : 0;
      const page = all.slice(start, start + 2);
      return {
        Items: page,
        ...(start + 2 < all.length ? { LastEvaluatedKey: { pk: page[1].pk, sk: page[1].sk } } : {}),
      };
    }
    if (name === "GetItemCommand") {
      return { Item: table.get(key(input.Key!.pk.S!, input.Key!.sk.S!)) };
    }
    if (name === "PutItemCommand" || name === "DeleteItemCommand") {
      const target = name === "PutItemCommand" ? input.Item! : input.Key!;
      const existing = table.get(key(target.pk.S!, target.sk.S!));
      if (!evaluateCondition(existing, input)) throw conditionalCheckFailed();
      if (name === "PutItemCommand") table.set(key(target.pk.S!, target.sk.S!), input.Item!);
      else table.delete(key(target.pk.S!, target.sk.S!));
      return {};
    }
    if (name === "BatchGetItemCommand") {
      const request = input.RequestItems![config.tableName];
      let keys = request.Keys as Item[];
      let unprocessed: Item[] = [];
      if (unprocessedOnce > 0) {
        unprocessed = keys.slice(0, unprocessedOnce);
        keys = keys.slice(unprocessedOnce);
        unprocessedOnce = 0;
      }
      return {
        Responses: {
          [config.tableName]: keys
            .map((k) => table.get(key(k.pk.S!, k.sk.S!)))
            .filter((item): item is Item => !!item)
            .map((item) => ({ sk: item.sk })),
        },
        ...(unprocessed.length > 0 ? { UnprocessedKeys: { [config.tableName]: { Keys: unprocessed } } } : {}),
      };
    }
    throw new Error(`Unexpected command ${name}`);
  });
  return {
    db: { send } as ConstructorParameters<typeof BillCompanionDao>[0],
    send,
    table,
    calls,
    get: (pk: string, sk: string) => table.get(key(pk, sk)),
    leaveUnprocessedOnce: (count: number) => {
      unprocessedOnce = count;
    },
  };
};

const declaration = (guid: string, targets: string[], sourceFetchedAt: string): CompanionDeclaration => {
  const self = parseBillGuid(guid)!;
  return {
    guid: self.plainGuid,
    congress: self.congress,
    billType: self.billType,
    billNumber: self.billNumber,
    declared: targets.map((target) => {
      const ref = parseBillGuid(target)!;
      return { guid: ref.plainGuid, congress: ref.congress, billType: ref.billType, billNumber: ref.billNumber };
    }),
    truncated: false,
    sourceFetchedAt,
  };
};

const lookupRow = (guid: string): Item => ({
  pk: { S: "BILL_GUID" },
  sk: { S: guid },
  guid: { S: guid },
  manifestSk: { S: `2026-09-01T00:00:00.000Z#${guid}` },
});

const groupsInput = (pairs: Array<[string, string]>, enabled = true): CompanionGroupsStateInput => ({
  enabled,
  pairs,
  groupCount: pairs.length,
  ambiguousCount: 1,
  oneSidedCount: 0,
  declarationCount: 4,
  resolvedAt: "2026-09-25T12:00:00.000Z",
});

describe("billCompanionConfigFromEnv", () => {
  it("uses the documented defaults", () => {
    expect(config).toEqual({
      tableName: "BillsManifest",
      primaryKey: "pk",
      sortKey: "sk",
      declPk: "BILL_COMPANION_DECL",
      groupsPk: "BILL_COMPANION_GROUPS",
      guidLookupPk: "BILL_GUID",
    });
  });

  it("prefers MANIFEST_TABLE_NAME, and then ignores another table's PRIMARY_KEY", () => {
    expect(
      billCompanionConfigFromEnv({ MANIFEST_TABLE_NAME: "M", TABLE_NAME: "UserFeedback", PRIMARY_KEY: "userId" }),
    ).toMatchObject({ tableName: "M", primaryKey: "pk" });
    expect(billCompanionConfigFromEnv({ MANIFEST_TABLE_NAME: "M", MANIFEST_PRIMARY_KEY: "p" }).primaryKey).toBe("p");
    expect(billCompanionConfigFromEnv({ TABLE_NAME: "T", PRIMARY_KEY: "p2" })).toMatchObject({
      tableName: "T",
      primaryKey: "p2",
    });
    expect(
      billCompanionConfigFromEnv({
        MANIFEST_COMPANION_DECL_PK: "D",
        MANIFEST_COMPANION_GROUPS_PK: "G",
        MANIFEST_GUID_LOOKUP_PK: "L1",
      }),
    ).toMatchObject({ declPk: "D", groupsPk: "G", guidLookupPk: "L1" });
    expect(billCompanionConfigFromEnv({ GUID_LOOKUP_PK: "L0", MANIFEST_GUID_LOOKUP_PK: "L1" }).guidLookupPk).toBe("L0");
  });
});

describe("BillCompanionDao link lists", () => {
  it("round-trips a link list and lists every row across pages", async () => {
    const fake = fakeTable();
    const dao = new BillCompanionDao(fake.db, config, () => Date.parse("2026-09-25T12:00:00.000Z"));
    const rows = [
      declaration("BILLS-119hr1285", ["BILLS-119s570"], "2026-09-01T00:00:00.000Z"),
      declaration("BILLS-119s570", ["BILLS-119hr1285"], "2026-09-02T00:00:00.000Z"),
      declaration("BILLS-119hjres131", ["BILLS-119sjres91"], "2026-09-03T00:00:00.000Z"),
    ];
    for (const row of rows) expect(await dao.putDeclaration(row)).toBe("written");

    expect(fake.get("BILL_COMPANION_DECL", "BILLS-119hr1285")).toEqual({
      pk: { S: "BILL_COMPANION_DECL" },
      sk: { S: "BILLS-119hr1285" },
      congress: { S: "119" },
      billType: { S: "hr" },
      billNumber: { S: "1285" },
      declared: {
        L: [
          {
            M: { guid: { S: "BILLS-119s570" }, congress: { S: "119" }, billType: { S: "s" }, billNumber: { S: "570" } },
          },
        ],
      },
      truncated: { BOOL: false },
      sourceFetchedAt: { S: "2026-09-01T00:00:00.000Z" },
      updatedAt: { S: "2026-09-25T12:00:00.000Z" },
    });
    expect(await dao.getDeclaration("BILLS-119hr1285ih")).toEqual(rows[0]);
    expect(await dao.getDeclaration("BILLS-119hr1")).toBeNull();
    expect(await dao.getDeclaration("junk")).toBeNull();

    const listed = await dao.listDeclarations();
    expect(listed.map((row) => row.guid).sort()).toEqual(["BILLS-119hjres131", "BILLS-119hr1285", "BILLS-119s570"]);
    expect(fake.calls.filter((call) => call.name === "QueryCommand")).toHaveLength(2);
  });

  it("rejects older data on put and delete, and accepts equal or newer (acceptance 8)", async () => {
    const fake = fakeTable();
    const dao = new BillCompanionDao(fake.db, config);
    const fresh = declaration("BILLS-119hr1285", ["BILLS-119s570"], "2026-09-10T00:00:00.000Z");
    expect(await dao.putDeclaration(fresh)).toBe("written");

    // A stale copy (older fetchedAt, e.g. restored by enrichOfficialVotes) must not replace it.
    const stale = declaration("BILLS-119hr1285", ["BILLS-119s999"], "2026-09-01T00:00:00.000Z");
    expect(await dao.putDeclaration(stale)).toBe("stale");
    expect(await dao.deleteDeclaration("BILLS-119hr1285", "2026-09-01T00:00:00.000Z")).toBe("stale");
    expect((await dao.getDeclaration("BILLS-119hr1285"))?.declared.map((ref) => ref.guid)).toEqual(["BILLS-119s570"]);

    const put = fake.calls.find((call) => call.name === "PutItemCommand")!.input;
    expect(put.ConditionExpression).toBe("attribute_not_exists(#sk) OR attribute_not_exists(#src) OR #src <= :src");

    expect(await dao.putDeclaration({ ...fresh, truncated: true })).toBe("written");
    const newer = declaration("BILLS-119hr1285", ["BILLS-119s571"], "2026-09-11T00:00:00.000Z");
    expect(await dao.putDeclaration(newer)).toBe("written");
    expect(await dao.deleteDeclaration("BILLS-119hr1285ih", "2026-09-12T00:00:00.000Z")).toBe("deleted");
    expect(await dao.getDeclaration("BILLS-119hr1285")).toBeNull();
    // Deleting a missing row passes the condition.
    expect(await dao.deleteDeclaration("BILLS-119hr1285", "2026-09-01T00:00:00.000Z")).toBe("deleted");
  });

  it("refuses an empty put and a bad guid, and passes other DynamoDB errors on", async () => {
    const fake = fakeTable();
    const dao = new BillCompanionDao(fake.db, config);
    await expect(dao.putDeclaration(declaration("BILLS-119hr1", [], "t"))).rejects.toThrow("use deleteDeclaration");
    await expect(dao.deleteDeclaration("junk", "t")).rejects.toThrow("Not a bill guid");

    fake.send.mockRejectedValueOnce(
      Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }),
    );
    await expect(dao.putDeclaration(declaration("BILLS-119hr1", ["BILLS-119s1"], "t"))).rejects.toThrow("throttled");
    fake.send.mockRejectedValueOnce(new Error("boom"));
    await expect(dao.deleteDeclaration("BILLS-119hr1", "t")).rejects.toThrow("boom");
  });

  it("skips rows it cannot read", async () => {
    const fake = fakeTable([
      { pk: { S: "BILL_COMPANION_DECL" }, sk: { S: "not-a-guid" } },
      {
        pk: { S: "BILL_COMPANION_DECL" },
        sk: { S: "BILLS-119hr5" },
        declared: { L: [{ M: { guid: { S: "junk" } } }, { M: { guid: { S: "BILLS-119s5" } } }, { S: "x" }] },
      },
    ]);
    const dao = new BillCompanionDao(fake.db, config);
    expect(await dao.listDeclarations()).toEqual([
      {
        guid: "BILLS-119hr5",
        congress: "119",
        billType: "hr",
        billNumber: "5",
        declared: [{ guid: "BILLS-119s5", congress: "119", billType: "s", billNumber: "5" }],
        truncated: false,
        sourceFetchedAt: "",
      },
    ]);
  });
});

describe("BillCompanionDao CURRENT groups", () => {
  it("reads nothing as null, writes version 1, and bumps the version on each write", async () => {
    const fake = fakeTable();
    const dao = new BillCompanionDao(fake.db, config);
    expect(await dao.getCurrentGroups()).toBeNull();
    expect(activeCompanionPairs(null)).toEqual([]);

    expect(await dao.putCurrentGroups(groupsInput([["BILLS-119hr1285", "BILLS-119s570"]]), null)).toEqual({
      outcome: "written",
      pairsVersion: 1,
    });
    expect(fake.get("BILL_COMPANION_GROUPS", "CURRENT")).toMatchObject({
      pairsVersion: { N: "1" },
      enabled: { BOOL: true },
      pairs: { S: '[["BILLS-119hr1285","BILLS-119s570"]]' },
      groupCount: { N: "1" },
      ambiguousCount: { N: "1" },
      oneSidedCount: { N: "0" },
      declarationCount: { N: "4" },
      resolvedAt: { S: "2026-09-25T12:00:00.000Z" },
    });
    const state = await dao.getCurrentGroups();
    expect(state).toEqual({ ...groupsInput([["BILLS-119hr1285", "BILLS-119s570"]]), pairsVersion: 1 });
    expect(activeCompanionPairs(state)).toEqual([["BILLS-119hr1285", "BILLS-119s570"]]);
    expect(activeCompanionPairs({ ...state!, enabled: false })).toEqual([]);

    expect(await dao.putCurrentGroups(groupsInput([]), 1)).toEqual({ outcome: "written", pairsVersion: 2 });
  });

  it("reports a conflict when another writer moved the version", async () => {
    const fake = fakeTable();
    const dao = new BillCompanionDao(fake.db, config);
    await dao.putCurrentGroups(groupsInput([]), null);
    await dao.putCurrentGroups(groupsInput([]), 1);
    expect(await dao.putCurrentGroups(groupsInput([["BILLS-119hr1", "BILLS-119s1"]]), 1)).toEqual({
      outcome: "conflict",
    });
    expect(await dao.putCurrentGroups(groupsInput([]), null)).toEqual({ outcome: "conflict" });
    expect((await dao.getCurrentGroups())?.pairsVersion).toBe(2);

    fake.send.mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(dao.putCurrentGroups(groupsInput([]), 2)).rejects.toThrow("AccessDenied");
  });

  it("serves a read younger than maxAgeMs from the cache, shares a read in flight, and never caches errors", async () => {
    let now = 1_000_000;
    const fake = fakeTable();
    const dao = new BillCompanionDao(fake.db, config, () => now);
    const reads = () => fake.calls.filter((call) => call.name === "GetItemCommand").length;

    const [first, second] = await Promise.all([
      dao.getCurrentGroups({ maxAgeMs: 60_000 }),
      dao.getCurrentGroups({ maxAgeMs: 60_000 }),
    ]);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(reads()).toBe(1);

    await new BillCompanionDao(fake.db, config).putCurrentGroups(groupsInput([["BILLS-119hr1", "BILLS-119s1"]]), null);
    now += 59_000;
    expect(await dao.getCurrentGroups({ maxAgeMs: 60_000 })).toBeNull();
    expect(reads()).toBe(1);
    now += 2_000;
    expect((await dao.getCurrentGroups({ maxAgeMs: 60_000 }))?.pairs).toEqual([["BILLS-119hr1", "BILLS-119s1"]]);
    expect(reads()).toBe(2);
    // maxAgeMs 0 (the default) always reads.
    await dao.getCurrentGroups();
    expect(reads()).toBe(3);

    now += 120_000;
    fake.send.mockRejectedValueOnce(new Error("throttled"));
    await expect(dao.getCurrentGroups({ maxAgeMs: 60_000 })).rejects.toThrow("throttled");
    expect((await dao.getCurrentGroups({ maxAgeMs: 60_000 }))?.pairsVersion).toBe(1);
  });

  it("treats malformed stored pairs as none and drops invalid entries", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const current = (pairs: string): Item => ({
      pk: { S: "BILL_COMPANION_GROUPS" },
      sk: { S: "CURRENT" },
      pairsVersion: { N: "7" },
      enabled: { BOOL: true },
      pairs: { S: pairs },
    });
    expect((await new BillCompanionDao(fakeTable([current("{oops")]).db, config).getCurrentGroups())?.pairs).toEqual(
      [],
    );
    expect(
      (
        await new BillCompanionDao(
          fakeTable([current('[["BILLS-119hr1","BILLS-119s1"],["BILLS-119hr2ih","BILLS-119s2"],["x"],"y"]')]).db,
          config,
        ).getCurrentGroups()
      )?.pairs,
    ).toEqual([["BILLS-119hr1", "BILLS-119s1"]]);
    expect((await new BillCompanionDao(fakeTable([current('{"a":1}')]).db, config).getCurrentGroups())?.pairs).toEqual(
      [],
    );
    jest.restoreAllMocks();
  });
});

describe("BillCompanionDao held checks and fresh resolution", () => {
  it("batch-reads guid lookups 100 at a time and retries unprocessed keys", async () => {
    const guids = Array.from({ length: 150 }, (_, index) => `BILLS-119hr${index + 1}`);
    const fake = fakeTable(guids.filter((_, index) => index % 2 === 0).map(lookupRow));
    fake.leaveUnprocessedOnce(3);
    const dao = new BillCompanionDao(fake.db, config);

    const held = await dao.isHeld([...guids, "BILLS-119hr1ih", "junk"]);

    expect(held.size).toBe(75);
    expect(held.has("BILLS-119hr1")).toBe(true);
    expect(held.has("BILLS-119hr2")).toBe(false);
    const batches = fake.calls.filter((call) => call.name === "BatchGetItemCommand");
    expect(batches.map((call) => call.input.RequestItems!.BillsManifest.Keys!.length)).toEqual([100, 3, 50]);
    expect(batches[0].input.RequestItems!.BillsManifest.Keys![0]).toEqual({
      pk: { S: "BILL_GUID" },
      sk: { S: "BILLS-119hr1" },
    });
    expect(await dao.isHeld([])).toEqual(new Set());
  });

  it("gives up when keys stay unprocessed", async () => {
    const fake = fakeTable();
    fake.send.mockImplementation(async (command: FakeCommand) => ({
      Responses: {},
      UnprocessedKeys: { BillsManifest: { Keys: command.input.RequestItems!.BillsManifest.Keys } },
    }));
    const dao = new BillCompanionDao(fake.db, config);
    jest.useFakeTimers();
    const pending = dao.isHeld(["BILLS-119hr1"]);
    const assertion = expect(pending).rejects.toThrow("unprocessed after 5 attempts");
    for (let tick = 0; tick < 5; tick += 1) await jest.advanceTimersByTimeAsync(1_000);
    await assertion;
    jest.useRealTimers();
  });

  it("resolves one bill's partner from fresh link lists and held checks", async () => {
    const rows = [
      declaration("BILLS-119hr1285", ["BILLS-119s570"], "t"),
      declaration("BILLS-119hres407", ["BILLS-119sres208"], "t"),
      declaration("BILLS-119hres1260", ["BILLS-119sres208"], "t"),
      declaration("BILLS-119s4394", ["BILLS-119hr8849"], "t"),
    ];
    const fake = fakeTable(
      ["BILLS-119hr1285", "BILLS-119s570", "BILLS-119hres407", "BILLS-119sres208", "BILLS-119hr8849"].map(lookupRow),
    );
    const dao = new BillCompanionDao(fake.db, config);
    for (const row of rows) await dao.putDeclaration(row);

    expect(await dao.resolveFresh("BILLS-119s570is")).toBe("BILLS-119hr1285");
    expect(await dao.resolveFresh("BILLS-119hr1285")).toBe("BILLS-119s570");
    // Only the component's two bills are checked.
    const lastBatch = fake.calls.filter((call) => call.name === "BatchGetItemCommand").pop()!;
    expect(lastBatch.input.RequestItems!.BillsManifest.Keys!.map((k: Item) => k.sk.S).sort()).toEqual([
      "BILLS-119hr1285",
      "BILLS-119s570",
    ]);
    expect(await dao.resolveFresh("BILLS-119hres407")).toBeNull();
    // s4394 is not held.
    expect(await dao.resolveFresh("BILLS-119hr8849")).toBeNull();
    expect(await dao.resolveFresh("BILLS-119hr77")).toBeNull();
    expect(await dao.resolveFresh("junk")).toBeNull();
  });
});
