import { DynamoDBClient, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import type { BillsManifestItemV1 as BillManifestEntry } from "../contracts";
import { BillPriorityDao } from "../adapters/billPriorityDao";
import type { BillPriorityRecord } from "../models/billPriority";
import { mergePriorityIntoManifestEntry, priorityFirstRankValue } from "../shared/billPriority";
import {
  billsManifestSourceFromEnv,
  buildBillsManifest,
  compareManifestEntries,
  normalizeUpdatedAfter,
  toManifestEntry,
  type BillsManifestSource,
} from "../shared/billsManifestBuilder";
import { logLinesWithMessage } from "./logLines";

/** A manifest row as the fakes answer it. */
type Row = Record<string, AttributeValue>;
type Page = { Items?: Row[]; LastEvaluatedKey?: Row };

const MANIFEST_ENV = { TABLE_NAME: "test-table", PRIMARY_KEY: "pk", PK_VALUE: "BILL" };
const PRIORITY_ENV = {
  ...MANIFEST_ENV,
  PRIORITY_TABLE_NAME: "BillPriority",
  PRIORITY_TABLE_PARTITION_KEY: "guid",
  PRIORITY_ACTIVE_INDEX_NAME: "PriorityStatusIndex",
  PRIORITY_STATUS_ATTRIBUTE: "status",
  PRIORITY_SORT_KEY_ATTRIBUTE: "prioritySortKey",
  PRIORITY_ACTIVE_STATUS_VALUE: "ACTIVE",
};

/** A DynamoDB client whose send answers each call with the next response. */
const fakeDdb = (...responses: Page[]) => {
  const send = jest.fn();
  for (const response of responses) send.mockResolvedValueOnce(response);
  return { client: { send } as unknown as DynamoDBClient, send };
};

const sourceFor = (env: Record<string, string>, ...responses: Page[]) => {
  const { client, send } = fakeDdb(...responses);
  return { source: billsManifestSourceFromEnv(client, env as NodeJS.ProcessEnv), send };
};

const manifestItem = (overrides: Partial<Row> = {}): Row => ({
  pk: { S: "BILL" },
  sk: { S: "2026-01-01T00:00:00.000Z#BILLS-118s1is" },
  guid: { S: "BILLS-118s1is" },
  billType: { S: "senate-bill" },
  congress: { S: "118" },
  billNumber: { S: "1" },
  updatedAt: { S: "2026-01-01T00:00:00.000Z" },
  title: { S: "Bill 1" },
  subCategories: { L: [] },
  lifeAreas: { L: [] },
  sponsors: { L: [] },
  cosponsors: { L: [] },
  voteCount: { N: "0" },
  ...overrides,
});

// ─── The pre-CAP-01 fetchBillsManifest algorithm, verbatim, as the parity oracle ────────────────
// Except INT-11: no voteCount in the entries and no vote-count tiebreak in the order.

const legacyToStringList = (value: AttributeValue | undefined): string[] => {
  const list = value?.L;
  if (!Array.isArray(list)) return [];
  return list.map((v) => (typeof v?.S === "string" ? v.S : "")).filter((v: string) => v.length > 0);
};

const legacyToNumberMap = (value: AttributeValue | undefined): Record<string, number> | undefined => {
  const map = value?.M;
  if (!map || typeof map !== "object") return undefined;
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(map)) {
    const num = parseFloat(val?.N ?? "");
    if (!isNaN(num)) result[key] = num;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const legacyCompare = (lhs: BillManifestEntry, rhs: BillManifestEntry): number => {
  const leftPriorityRank = priorityFirstRankValue(lhs);
  const rightPriorityRank = priorityFirstRankValue(rhs);
  if (leftPriorityRank !== rightPriorityRank) {
    return leftPriorityRank - rightPriorityRank;
  }
  const dateComparison = (rhs.updatedAt ?? "").localeCompare(lhs.updatedAt ?? "");
  if (dateComparison !== 0) return dateComparison;
  return (lhs.guid ?? "").localeCompare(rhs.guid ?? "");
};

const legacyToEntry = (item: Row | null | undefined): BillManifestEntry | null => {
  if (!item) return null;
  const guid = item.guid?.S ?? "";
  const billType = item.billType?.S ?? "";
  if (!guid || !billType) return null;
  const billStatus = item.billStatus?.S ?? undefined;
  const validStatuses = new Set(["New", "Updated", "Passed", "Failed", "Finalized"]);
  return {
    guid,
    billType,
    congress: item.congress?.S ?? "",
    billNumber: item.billNumber?.S ?? "",
    updatedAt: item.updatedAt?.S ?? "",
    title: item.title?.S ?? "",
    subCategories: legacyToStringList(item.subCategories),
    lifeAreas: legacyToStringList(item.lifeAreas),
    sponsors: legacyToStringList(item.sponsors),
    cosponsors: legacyToStringList(item.cosponsors),
    ...(billStatus && validStatuses.has(billStatus)
      ? { billStatus: billStatus as BillManifestEntry["billStatus"] }
      : {}),
    ...(() => {
      const cp = legacyToNumberMap(item.civicProfile);
      return cp ? { civicProfile: cp } : {};
    })(),
  };
};

const legacyBills = (pages: Page[], activePriorities: BillPriorityRecord[]): BillManifestEntry[] => {
  const activePriorityMap = new Map(activePriorities.map((record) => [record.guid, record]));
  const bills: BillManifestEntry[] = [];
  for (const page of pages) {
    for (const item of page.Items ?? []) {
      const entry = legacyToEntry(item);
      if (entry) bills.push(mergePriorityIntoManifestEntry(entry, activePriorityMap.get(entry.guid)));
    }
  }
  return bills.sort(legacyCompare);
};

// ─── A varied, deterministic manifest partition ─────────────────────────────────────────────────

const seededRandom = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const generatePartition = (itemCount: number, pageSize: number): { pages: Page[]; priorityPage: Page } => {
  const random = seededRandom(20260925);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const statuses = ["New", "Updated", "Passed", "Failed", "Finalized", "Vetoed", "", undefined] as const;
  const days = ["2026-01-01", "2026-01-02", "2026-03-15", "2026-09-24"];
  const items: Row[] = [];

  for (let index = 0; index < itemCount; index += 1) {
    const guid = `BILLS-119hr${index}ih`;
    const updatedAt = `${pick(days)}T${String(Math.floor(random() * 24)).padStart(2, "0")}:00:00.000Z`;
    const status = pick(statuses);
    const shape = random();
    const item: Row = {
      pk: { S: "BILL" },
      sk: { S: `${updatedAt}#${guid}` },
      guid: { S: guid },
      billType: { S: pick(["hr", "s", "hjres"]) },
      updatedAt: { S: updatedAt },
      title: { S: `Bill ${index} — "quoted" \\ title` },
      subCategories: { L: [{ S: "Health" }, { S: "" }, { N: "3" }] },
      lifeAreas: random() < 0.5 ? { L: [{ S: "Family" }] } : { S: "not-a-list" },
      sponsors: { L: [{ S: `B${index}` }] },
      cosponsors: random() < 0.3 ? { L: [] } : { L: [{ S: "C1" }, { S: "C2" }] },
    };
    const voteCount = pick<AttributeValue | undefined>([
      { N: "0" },
      { N: "5" },
      { N: "12" },
      { N: "-4" },
      { N: "abc" },
      { S: "7" },
      undefined,
    ]);
    if (voteCount !== undefined) item.voteCount = voteCount;
    if (random() < 0.8) item.congress = { S: "119" };
    if (random() < 0.8) item.billNumber = { S: String(index) };
    if (status !== undefined) item.billStatus = { S: status };
    if (random() < 0.4) item.civicProfile = { M: { economy: { N: "0.5" }, bad: { N: "x" }, health: { N: "-1" } } };
    if (random() < 0.05) item.civicProfile = { M: { onlyBad: { S: "x" } } };
    if (shape < 0.02) delete item.guid;
    else if (shape < 0.04) delete item.billType;
    items.push(item);
  }

  const pages: Page[] = [];
  for (let start = 0; start < items.length; start += pageSize) {
    const page: Page = { Items: items.slice(start, start + pageSize) };
    if (start + pageSize < items.length) page.LastEvaluatedKey = { pk: { S: "BILL" }, sk: { S: `cursor-${start}` } };
    pages.push(page);
  }

  const priorityItem = (guid: string, rank: number | undefined, extra: Row = {}) => ({
    guid: { S: guid },
    status: { S: "ACTIVE" },
    isPriority: { BOOL: true },
    ...(rank === undefined ? {} : { priorityRank: { N: String(rank) } }),
    priorityReason: { S: `  Reason ${guid}  ` },
    priorityExpiresAt: { S: "2099-01-01T00:00:00.000Z" },
    priorityUpdatedAt: { S: "2026-09-24T12:00:00.000Z" },
    prioritySortKey: { S: `${String(rank ?? 0).padStart(6, "0")}#${guid}` },
    ...extra,
  });
  const priorityPage: Page = {
    Items: [
      priorityItem("BILLS-119hr10ih", 2),
      priorityItem("BILLS-119hr11ih", 1),
      priorityItem("BILLS-119hr12ih", undefined),
      priorityItem("BILLS-119hr13ih", 3, { priorityExpiresAt: { S: "2020-01-01T00:00:00.000Z" } }),
      priorityItem("BILLS-119hr14ih", 4, { isPriority: { BOOL: false } }),
      priorityItem("BILLS-119hr15ih", 1),
      priorityItem("BILLS-NOT-IN-MANIFEST", 1),
    ],
  };
  return { pages, priorityPage };
};

describe("billsManifestBuilder", () => {
  it("reads the whole BILL partition and returns the manifest entries", async () => {
    const { source, send } = sourceFor(MANIFEST_ENV, {
      Items: [manifestItem({ voteCount: { N: "12" }, billStatus: { S: "Passed" } })],
    });

    const manifest = await buildBillsManifest(source);

    expect(Object.keys(manifest)).toEqual(["generatedAt", "count", "bills"]);
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
    expect(manifest.count).toBe(1);
    expect(manifest.bills).toEqual([
      {
        guid: "BILLS-118s1is",
        billType: "senate-bill",
        congress: "118",
        billNumber: "1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        title: "Bill 1",
        subCategories: [],
        lifeAreas: [],
        sponsors: [],
        cosponsors: [],
        billStatus: "Passed",
      },
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toEqual({
      TableName: "test-table",
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": { S: "BILL" } },
      ExclusiveStartKey: undefined,
    });
  });

  it("adds the companion groups it is given after the bills, and leaves the field out otherwise (APPF-23)", async () => {
    const companionGroups = [
      { primaryGuid: "BILLS-119hr1285", memberGuids: ["BILLS-119hr1285", "BILLS-119s570"], relationship: "identical" },
    ];
    const windowed = sourceFor(MANIFEST_ENV, { Items: [manifestItem({})] });
    const withGroups = await buildBillsManifest(windowed.source, {
      updatedAfter: "2025-01-01T00:00:00.000Z",
      companionGroups,
    });
    expect(Object.keys(withGroups)).toEqual(["generatedAt", "count", "bills", "companionGroups"]);
    expect(withGroups.companionGroups).toEqual(companionGroups);
    expect(withGroups.count).toBe(1);

    const none = await buildBillsManifest(sourceFor(MANIFEST_ENV, { Items: [] }).source, { companionGroups: [] });
    expect(none.companionGroups).toEqual([]);
    const absent = await buildBillsManifest(sourceFor(MANIFEST_ENV, { Items: [] }).source, {});
    expect("companionGroups" in absent).toBe(false);
  });

  it("returns an empty manifest when the partition is empty", async () => {
    const { source } = sourceFor(MANIFEST_ENV, { Items: [] });
    const manifest = await buildBillsManifest(source);
    expect(manifest.count).toBe(0);
    expect(manifest.bills).toEqual([]);
  });

  it("filters on the sort key when updatedAfter is given (trimmed)", async () => {
    const { source, send } = sourceFor(MANIFEST_ENV, {
      Items: [manifestItem({ updatedAt: { S: "2026-02-01T00:00:00.000Z" } })],
    });

    const manifest = await buildBillsManifest(source, { updatedAfter: "  2026-01-15T00:00:00.000Z " });

    expect(manifest.count).toBe(1);
    expect(send.mock.calls[0][0].input).toEqual({
      TableName: "test-table",
      KeyConditionExpression: "#pk = :pk AND #sk > :updatedAfter",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: { ":pk": { S: "BILL" }, ":updatedAfter": { S: "2026-01-15T00:00:00.000Z" } },
      ExclusiveStartKey: undefined,
    });
  });

  it("treats a blank updatedAfter as a full load", async () => {
    const { source, send } = sourceFor(MANIFEST_ENV, { Items: [] });
    await buildBillsManifest(source, { updatedAfter: "   " });
    expect(send.mock.calls[0][0].input.KeyConditionExpression).toBe("#pk = :pk");
  });

  it("follows LastEvaluatedKey across pages", async () => {
    const cursor = { pk: { S: "BILL" }, sk: { S: "2026-01-01T00:00:00.000Z#BILLS-1" } };
    const { source, send } = sourceFor(
      MANIFEST_ENV,
      { Items: [manifestItem({ guid: { S: "BILLS-1" } })], LastEvaluatedKey: cursor },
      { Items: [manifestItem({ guid: { S: "BILLS-2" } })] },
    );

    const manifest = await buildBillsManifest(source);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(cursor);
    expect(manifest.bills.map((bill) => bill.guid)).toEqual(["BILLS-1", "BILLS-2"]);
  });

  it("sorts by updatedAt desc, then guid, whatever the stored vote counts (INT-11)", async () => {
    const { source } = sourceFor(MANIFEST_ENV, {
      Items: [
        manifestItem({ guid: { S: "BILLS-1" }, updatedAt: { S: "2026-01-01T00:00:00.000Z" }, voteCount: { N: "50" } }),
        manifestItem({ guid: { S: "BILLS-2" }, updatedAt: { S: "2026-01-03T00:00:00.000Z" }, voteCount: { N: "0" } }),
        manifestItem({ guid: { S: "BILLS-3" }, updatedAt: { S: "2026-01-02T00:00:00.000Z" }, voteCount: { N: "20" } }),
        manifestItem({ guid: { S: "BILLS-0" }, updatedAt: { S: "2026-01-02T00:00:00.000Z" }, voteCount: { N: "1" } }),
      ],
    });

    const manifest = await buildBillsManifest(source);
    expect(manifest.bills.map((bill) => bill.guid)).toEqual(["BILLS-2", "BILLS-0", "BILLS-3", "BILLS-1"]);
    expect(manifest.bills.filter((bill) => "voteCount" in bill)).toEqual([]);
  });

  it("never sends a vote count: no entry has the key, whatever the row holds (INT-11)", () => {
    for (const voteCount of [{ N: "0" }, { N: "12" }, { N: "-4" }, { S: "7" }, undefined]) {
      const entry = toManifestEntry(manifestItem({ voteCount }));
      expect(entry).not.toBeNull();
      expect(entry).not.toHaveProperty("voteCount");
      expect(JSON.stringify(entry)).not.toContain("voteCount");
    }
    expect(
      compareManifestEntries({ ...toManifestEntry(manifestItem())!, voteCount: 99 }, toManifestEntry(manifestItem())!),
    ).toBe(0);
  });

  it("merges active priority metadata and sorts priority bills first", async () => {
    const { source, send } = sourceFor(
      PRIORITY_ENV,
      {
        Items: [
          {
            guid: { S: "BILLS-118s1is" },
            status: { S: "ACTIVE" },
            isPriority: { BOOL: true },
            priorityRank: { N: "1" },
            priorityReason: { S: "Major national funding coverage" },
            priorityExpiresAt: { S: "2099-03-08T00:00:00.000Z" },
            priorityUpdatedAt: { S: "2026-03-07T12:00:00.000Z" },
            prioritySortKey: { S: "000001#BILLS-118s1is" },
          },
        ],
      },
      {
        Items: [
          manifestItem({ guid: { S: "BILLS-118s1is" }, title: { S: "Funding Bill" }, voteCount: { N: "1" } }),
          manifestItem({ guid: { S: "BILLS-118hr2ih" }, title: { S: "Regular Bill" }, voteCount: { N: "99" } }),
        ],
      },
    );

    const manifest = await buildBillsManifest(source);

    expect(send.mock.calls[0][0].input).toMatchObject({
      TableName: "BillPriority",
      IndexName: "PriorityStatusIndex",
      ExpressionAttributeValues: { ":status": { S: "ACTIVE" } },
    });
    expect(manifest.bills.map((bill) => bill.guid)).toEqual(["BILLS-118s1is", "BILLS-118hr2ih"]);
    expect(manifest.bills[0]).toMatchObject({
      guid: "BILLS-118s1is",
      isPriority: true,
      priorityRank: 1,
      priorityReason: "Major national funding coverage",
      priorityExpiresAt: "2099-03-08T00:00:00.000Z",
    });
    expect(manifest.bills[1]).not.toHaveProperty("isPriority");
  });

  it("matches the pre-CAP-01 handler output exactly (entries, key order, sort, priority merge)", async () => {
    const { pages, priorityPage } = generatePartition(1200, 250);
    const { source } = sourceFor(PRIORITY_ENV, priorityPage, ...pages);

    // The records the old handler got from BillPriorityDao.listActive for the same page.
    const { client: priorityClient } = fakeDdb(priorityPage);
    const activePriorities = await new BillPriorityDao(priorityClient, {
      tableName: "BillPriority",
      partitionKey: "guid",
      activeIndexName: "PriorityStatusIndex",
    }).listActive();

    // Parity is defined for a duplicate-free partition (the old handler had no dedupe to compare).
    const generatedGuids = pages.flatMap((page) => (page.Items ?? []).map((item) => item.guid?.S).filter(Boolean));
    expect(new Set(generatedGuids).size).toBe(generatedGuids.length);

    const manifest = await buildBillsManifest(source);
    const expected = legacyBills(pages, activePriorities);

    expect(expected.length).toBeGreaterThan(1100);
    expect(manifest.count).toBe(expected.length);
    expect(manifest.bills).toEqual(expected);
    // Byte-level: same keys in the same order, so clients and the snapshot hash see identical JSON.
    expect(JSON.stringify(manifest.bills)).toBe(JSON.stringify(expected));
    // Rank 1 (two bills, tie broken by date, then guid), then rank 2.
    expect(new Set(manifest.bills.slice(0, 2).map((bill) => bill.guid))).toEqual(
      new Set(["BILLS-119hr11ih", "BILLS-119hr15ih"]),
    );
    expect(manifest.bills[2]).toMatchObject({ guid: "BILLS-119hr10ih", isPriority: true, priorityRank: 2 });
    const expired = manifest.bills.find((bill) => bill.guid === "BILLS-119hr13ih");
    expect(expired?.isPriority).toBeUndefined();
    const unranked = manifest.bills.find((bill) => bill.guid === "BILLS-119hr12ih");
    expect(unranked).toMatchObject({ isPriority: true, priorityReason: "Reason BILLS-119hr12ih" });
  });

  describe("stale duplicate rows (CAP-13)", () => {
    let logSpy: jest.SpyInstance;
    beforeEach(() => {
      logSpy = jest.spyOn(console, "log").mockImplementation();
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    // Live example: BILLS-119hr4582 has rows at 2026-02-10 and 2026-03-19.
    const row = (guid: string, updatedAt: string, fields: Row = {}) =>
      manifestItem({
        sk: { S: `${updatedAt}#${guid}` },
        guid: { S: guid },
        billType: { S: "hr" },
        updatedAt: { S: updatedAt },
        ...fields,
      });

    it("keeps only the newest row of each guid", async () => {
      const { source } = sourceFor(MANIFEST_ENV, {
        Items: [
          row("BILLS-119hr4582", "2026-02-10T17:12:59.747Z", { title: { S: "Old title" }, voteCount: { N: "40" } }),
          row("BILLS-119hr1", "2026-03-01T00:00:00.000Z"),
          row("BILLS-119hr4582", "2026-03-19T09:00:00.000Z", { title: { S: "New title" }, voteCount: { N: "3" } }),
        ],
      });

      const manifest = await buildBillsManifest(source);

      expect(manifest.count).toBe(2);
      expect(manifest.bills.map((bill) => [bill.guid, bill.title, bill.updatedAt])).toEqual([
        ["BILLS-119hr4582", "New title", "2026-03-19T09:00:00.000Z"],
        ["BILLS-119hr1", "Bill 1", "2026-03-01T00:00:00.000Z"],
      ]);
      expect(manifest.bills.filter((bill) => "voteCount" in bill)).toEqual([]);
      const lines = logLinesWithMessage(logSpy, "Dropped stale duplicate bills manifest rows");
      expect(lines).toEqual([expect.objectContaining({ level: "INFO", duplicateRows: 1 })]);
    });

    it("compares sort keys, across pages and whatever order the rows arrive in", async () => {
      const { source } = sourceFor(
        MANIFEST_ENV,
        {
          Items: [row("BILLS-119s7", "2026-05-01T00:00:00.000Z", { title: { S: "Newest" } })],
          LastEvaluatedKey: { pk: { S: "BILL" }, sk: { S: "cursor" } },
        },
        {
          Items: [
            row("BILLS-119s7", "2026-04-01T00:00:00.000Z", { title: { S: "Older" } }),
            row("BILLS-119s7", "2026-01-01T00:00:00.000Z", { title: { S: "Oldest" } }),
          ],
        },
      );

      const manifest = await buildBillsManifest(source);

      expect(manifest.bills.map((bill) => bill.title)).toEqual(["Newest"]);
    });

    it("dedupes windowed loads too, and merges the priority into the row it keeps", async () => {
      const { source } = sourceFor(
        PRIORITY_ENV,
        {
          Items: [
            {
              guid: { S: "BILLS-119hr4582" },
              status: { S: "ACTIVE" },
              isPriority: { BOOL: true },
              priorityRank: { N: "1" },
              priorityReason: { S: "Front page" },
              priorityExpiresAt: { S: "2099-01-01T00:00:00.000Z" },
              priorityUpdatedAt: { S: "2026-09-24T12:00:00.000Z" },
              prioritySortKey: { S: "000001#BILLS-119hr4582" },
            },
          ],
        },
        {
          Items: [
            row("BILLS-119hr4582", "2026-02-10T17:12:59.747Z", { title: { S: "Old" } }),
            row("BILLS-119hr4582", "2026-03-19T09:00:00.000Z", { title: { S: "New" } }),
          ],
        },
      );

      const manifest = await buildBillsManifest(source, { updatedAfter: "2026-01-01T00:00:00.000Z" });

      expect(manifest.count).toBe(1);
      expect(manifest.bills[0]).toMatchObject({
        guid: "BILLS-119hr4582",
        title: "New",
        isPriority: true,
        priorityRank: 1,
      });
    });

    it("builds the same manifest from a partition with stale copies as from the duplicate-free one", async () => {
      const { pages, priorityPage } = generatePartition(400, 100);
      const { source: clean } = sourceFor(PRIORITY_ENV, priorityPage, ...pages);
      // Stale copies of every tenth bill, under an older sort key and with other field values.
      const stale = pages
        .flatMap((page) => page.Items ?? [])
        .filter((_item, index) => index % 10 === 0 && _item.guid)
        .map((item) => ({
          ...item,
          sk: { S: `2025-12-31T00:00:00.000Z#${item.guid.S}` },
          updatedAt: { S: "2025-12-31T00:00:00.000Z" },
          title: { S: "stale" },
          voteCount: { N: "999" },
        }));
      const withDuplicates = [{ Items: stale, LastEvaluatedKey: { pk: { S: "BILL" }, sk: { S: "stale" } } }, ...pages];
      const { source: duplicated } = sourceFor(PRIORITY_ENV, priorityPage, ...withDuplicates);

      const expected = await buildBillsManifest(clean);
      const actual = await buildBillsManifest(duplicated);

      expect(stale.length).toBeGreaterThan(30);
      expect(actual.count).toBe(expected.count);
      expect(JSON.stringify(actual.bills)).toBe(JSON.stringify(expected.bills));
    });
  });

  it("throws when TABLE_NAME is not configured", async () => {
    const { client, send } = fakeDdb();
    const source: BillsManifestSource = billsManifestSourceFromEnv(client, {} as NodeJS.ProcessEnv);
    await expect(buildBillsManifest(source)).rejects.toThrow("Missing env var TABLE_NAME");
    expect(send).not.toHaveBeenCalled();
  });

  it("propagates DynamoDB errors", async () => {
    const { client, send } = fakeDdb();
    send.mockRejectedValueOnce(new Error("ProvisionedThroughputExceededException"));
    await expect(
      buildBillsManifest(billsManifestSourceFromEnv(client, MANIFEST_ENV as NodeJS.ProcessEnv)),
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });

  it("uses the documented defaults for PRIMARY_KEY and PK_VALUE, and no priority table without its index", () => {
    const { client } = fakeDdb();
    const source = billsManifestSourceFromEnv(client, {
      TABLE_NAME: "t",
      PRIORITY_TABLE_NAME: "BillPriority",
    } as NodeJS.ProcessEnv);
    expect(source).toMatchObject({ tableName: "t", primaryKey: "pk", pkValue: "BILL", priorityDao: null });
  });

  it("serves a row's contentHash to no one: the entries, and so the snapshot hash, are those of a row without it", async () => {
    const stamped = manifestItem({ contentHash: { S: "v1:cd76cdf08d935ab3:8f86b040e2721734" } });
    expect(toManifestEntry(stamped)).toEqual(toManifestEntry(manifestItem()));
    expect(toManifestEntry(stamped)).not.toHaveProperty("contentHash");

    const withHash = await buildBillsManifest(sourceFor(MANIFEST_ENV, { Items: [stamped] }).source);
    const without = await buildBillsManifest(sourceFor(MANIFEST_ENV, { Items: [manifestItem()] }).source);
    // PublishBillsManifest hashes the JSON of the bills array (serializeBillsManifestSnapshot).
    expect(JSON.stringify(withHash.bills)).toBe(JSON.stringify(without.bills));
  });

  it("drops items without a guid or billType", () => {
    expect(toManifestEntry(undefined)).toBeNull();
    expect(toManifestEntry(manifestItem({ guid: { S: "" } }))).toBeNull();
    expect(toManifestEntry(manifestItem({ billType: undefined }))).toBeNull();
  });

  it("normalizes updatedAfter", () => {
    expect(normalizeUpdatedAfter(" 2026-01-01T00:00:00.000Z ")).toBe("2026-01-01T00:00:00.000Z");
    expect(normalizeUpdatedAfter("")).toBeUndefined();
    expect(normalizeUpdatedAfter("  ")).toBeUndefined();
    expect(normalizeUpdatedAfter(undefined)).toBeUndefined();
    expect(normalizeUpdatedAfter(42)).toBeUndefined();
  });
});
