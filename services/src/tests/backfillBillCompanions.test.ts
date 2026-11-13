import type {
  AttributeValue,
  DeleteItemCommandInput,
  GetItemCommandInput,
  PutItemCommandInput,
  QueryCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { GetObjectCommandInput, ListObjectsV2CommandInput } from "@aws-sdk/client-s3";

import {
  configFromEnv,
  DEFAULT_CONCURRENCY,
  parseArgs,
  runBackfill,
  type CliOptions,
} from "../../scripts/backfillBillCompanions";
import { conditionalCheckFailed, evaluateCondition } from "./fixtures/dynamoCondition";

type Item = Record<string, AttributeValue>;
type Deps = Parameters<typeof runBackfill>[0];

/** The input of the commands the fakes answer. */
type S3Input = Partial<GetObjectCommandInput & ListObjectsV2CommandInput>;
type TableInput = Partial<QueryCommandInput & GetItemCommandInput & PutItemCommandInput & DeleteItemCommandInput>;
interface FakeCommand<Input> {
  constructor: { name: string };
  input: Input;
}

const T1 = "2026-09-01T00:00:00.000Z";
const T2 = "2026-09-10T00:00:00.000Z";

const related = (type: string, number: string, relationship = "Identical bill") => ({
  congress: 119,
  type,
  number,
  relationshipDetails: [{ type: relationship, identifiedBy: "CRS" }],
});

/** A raw bill as fetchRawBill stores it; metadata.guid carries a suffix on purpose. */
const rawBill = (guid: string, items: Array<Record<string, unknown>> = [], options: { next?: string } = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    kind: "raw",
    storedAt: T1,
    identifier: { congress: "119", billType: "house-bill", billNumber: "0" },
    metadata: { guid: `${guid}ih`, title: "T", pubDate: "", fetchedAt: T1 },
    content: {
      billXML: "<xml/>",
      relatedBills: {
        relatedBills: items,
        pagination: { count: items.length, ...(options.next ? { next: options.next } : {}) },
      },
    },
  });

const RAW: Record<string, string> = {
  "raw-bills/BILLS-119hr1285.json": rawBill("BILLS-119hr1285", [
    related("S", "570"),
    related("S", "9", "Related bill"),
  ]),
  "raw-bills/BILLS-119s570.json": rawBill("BILLS-119s570", [related("HR", "1285")]),
  "raw-bills/BILLS-119hr8849.json": rawBill("BILLS-119hr8849", [related("S", "4394")], {
    next: "https://api.congress.gov/v3/bill/119/hr/8849/relatedbills?offset=250",
  }),
  "raw-bills/BILLS-119s4394.json": rawBill("BILLS-119s4394"),
  "raw-bills/BILLS-119hres407.json": rawBill("BILLS-119hres407", [related("SRES", "208")]),
  "raw-bills/BILLS-119hres1260.json": rawBill("BILLS-119hres1260", [related("SRES", "208")]),
  "raw-bills/BILLS-119sres208.json": rawBill("BILLS-119sres208"),
  "raw-bills/BILLS-119hr1.json": rawBill("BILLS-119hr1", [related("HR", "2")]),
  "raw-bills/BILLS-119hr77.json": rawBill("BILLS-119hr77", [related("S", "77"), related("SJRES", "77")]),
  "raw-bills/BILLS-119hr5.json": rawBill("BILLS-119hr5"),
  "raw-bills/broken.json": "{not json",
  "raw-bills/weird.json": JSON.stringify({ kind: "raw", identifier: { billType: "amendment" } }),
};

const declRow = (guid: string, targets: string[], sourceFetchedAt: string): Item => {
  const parse = (value: string) => /^BILLS-(\d+)([a-z]+?)(\d+)$/.exec(value)!;
  const [, congress, billType, billNumber] = parse(guid);
  return {
    pk: { S: "BILL_COMPANION_DECL" },
    sk: { S: guid },
    congress: { S: congress },
    billType: { S: billType },
    billNumber: { S: billNumber },
    declared: {
      L: targets.map((target) => {
        const [, c, t, n] = parse(target);
        return { M: { guid: { S: target }, congress: { S: c }, billType: { S: t }, billNumber: { S: n } } };
      }),
    },
    truncated: { BOOL: false },
    sourceFetchedAt: { S: sourceFetchedAt },
  };
};

const manifestRow = (guid: string): Item => ({
  pk: { S: "BILL" },
  sk: { S: `${T1}#${guid}` },
  guid: { S: guid },
  billType: { S: "hr" },
  congress: { S: "119" },
  billNumber: { S: "1" },
  updatedAt: { S: T1 },
  title: { S: guid },
});

const HELD = [
  "BILLS-119hr1285",
  "BILLS-119s570",
  "BILLS-119hr8849",
  "BILLS-119s4394",
  "BILLS-119hres407",
  "BILLS-119hres1260",
  "BILLS-119sres208",
  "BILLS-119hr1",
  "BILLS-119hr2",
  "BILLS-119hr77",
  "BILLS-119hr5",
  "BILLS-119s5",
];

/** S3 in memory: paged listing (5 keys a page) and GetObject. */
const fakeS3 = (objects: Record<string, string> = RAW) => {
  const commands: Array<{ name: string; input: S3Input }> = [];
  const send = jest.fn(async (command: FakeCommand<S3Input>) => {
    const name: string = command.constructor.name;
    const input = command.input;
    commands.push({ name, input });
    if (name === "ListObjectsV2Command") {
      const keys = [...Object.keys(objects), "raw-bills/readme.txt"].sort();
      const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
      return {
        Contents: keys.slice(start, start + 5).map((Key) => ({ Key })),
        ...(start + 5 < keys.length ? { NextContinuationToken: String(start + 5) } : {}),
      };
    }
    if (name === "GetObjectCommand") {
      const text = objects[input.Key!];
      if (text === undefined) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => text } };
    }
    throw new Error(`Unexpected S3 command ${name}`);
  });
  return { s3: { send } as Deps["s3"], commands };
};

/** The manifest table in memory, honouring the real condition expressions. */
const fakeTable = (rows: Item[]) => {
  const key = (pk: string, sk: string) => `${pk}|${sk}`;
  const table = new Map<string, Item>(rows.map((row) => [key(row.pk.S!, row.sk.S!), row]));
  const writes: Array<{ name: string; input: TableInput }> = [];
  let beforeWrite: ((input: TableInput) => void) | undefined;
  const send = jest.fn(async (command: FakeCommand<TableInput>) => {
    const name: string = command.constructor.name;
    const input = command.input;
    if (name === "QueryCommand") {
      const pk = input.ExpressionAttributeValues![":pk"].S;
      return { Items: [...table.values()].filter((row) => row.pk.S === pk) };
    }
    if (name === "GetItemCommand") return { Item: table.get(key(input.Key!.pk.S!, input.Key!.sk.S!)) };
    if (name === "PutItemCommand" || name === "DeleteItemCommand") {
      writes.push({ name, input });
      beforeWrite?.(input);
      const target = (input.Item ?? input.Key)!;
      if (!evaluateCondition(table.get(key(target.pk.S!, target.sk.S!)), input)) throw conditionalCheckFailed();
      if (input.Item) table.set(key(target.pk.S!, target.sk.S!), input.Item);
      else table.delete(key(target.pk.S!, target.sk.S!));
      return {};
    }
    throw new Error(`Unexpected DynamoDB command ${name}`);
  });
  return {
    ddb: { send } as Deps["ddb"] & { send: typeof send },
    table,
    writes,
    get: (pk: string, sk: string) => table.get(key(pk, sk)),
    onWrite: (hook: (input: TableInput) => void) => {
      beforeWrite = hook;
    },
  };
};

const storedRows = () => [
  ...HELD.map(manifestRow),
  // A suffixed legacy row: never held.
  manifestRow("BILLS-119hr1285ih"),
  // Unchanged.
  declRow("BILLS-119s570", ["BILLS-119hr1285"], T1),
  // Newer than the raw bill: stale, kept.
  declRow("BILLS-119hr1", ["BILLS-119hr3"], T2),
  // Its links went away: deleted.
  declRow("BILLS-119hr5", ["BILLS-119s5"], "2026-08-01T00:00:00.000Z"),
];

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({ ...parseArgs([]), ...overrides });

const quiet = () => {
  const lines: string[] = [];
  const errors: unknown[][] = [];
  return {
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    logError: (...args: unknown[]) => errors.push(args),
    lines,
    errors,
  };
};

const config = configFromEnv({ BILL_STORE_BUCKET: "bill-store" });

describe("backfillBillCompanions arguments and environment", () => {
  it("defaults to a dry run and rejects unknown flags", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      apply: false,
      guids: [],
      maxItems: null,
      concurrency: DEFAULT_CONCURRENCY,
      publishNow: false,
    });
    expect(() => parseArgs(["--aply"])).toThrow("Unknown argument: --aply");
    expect(() => parseArgs(["extra"])).toThrow("Unknown argument: extra");
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  it("reads repeatable guids, limits and --publish-now only with --apply", () => {
    expect(
      parseArgs([
        "--apply",
        "--guid",
        "BILLS-119hr1285ih",
        "--guid",
        "BILLS-119s570",
        "--guid",
        "BILLS-119hr1285",
        "--max-items",
        "10",
        "--concurrency",
        "4",
        "--publish-now",
      ]),
    ).toEqual({
      help: false,
      apply: true,
      guids: ["BILLS-119hr1285", "BILLS-119s570"],
      maxItems: 10,
      concurrency: 4,
      publishNow: true,
    });
    expect(() => parseArgs(["--publish-now"])).toThrow("--publish-now needs --apply");
    expect(() => parseArgs(["--guid", "hr1285"])).toThrow("--guid needs a bill guid");
    expect(() => parseArgs(["--guid"])).toThrow("--guid requires a value");
    expect(() => parseArgs(["--guid", "--apply"])).toThrow("--guid requires a value");
    expect(() => parseArgs(["--concurrency", "26"])).toThrow("from 1 to 25");
    expect(() => parseArgs(["--max-items", "0"])).toThrow("--max-items needs a whole number");
    expect(() => parseArgs(["--max-items", "1.5"])).toThrow("--max-items needs a whole number");
  });

  it("uses the documented environment defaults", () => {
    const defaults = configFromEnv({});
    expect(defaults).toMatchObject({
      region: "us-east-1",
      bucket: "billboard-bill-store-bucket",
      rawPrefix: "raw-bills/",
      publishFunction: "PublishBillsManifest:prod",
      manifestPkValue: "BILL",
    });
    expect(defaults.companions).toMatchObject({
      tableName: "BillsManifest",
      primaryKey: "pk",
      declPk: "BILL_COMPANION_DECL",
      groupsPk: "BILL_COMPANION_GROUPS",
    });
    expect(
      configFromEnv({ AWS_REGION: "us-west-2", BILL_STORE_BUCKET: "b", MANIFEST_TABLE_NAME: "M", TABLE_NAME: "X" }),
    ).toMatchObject({ region: "us-west-2", bucket: "b", companions: expect.objectContaining({ tableName: "M" }) });
  });
});

describe("backfillBillCompanions run", () => {
  it("makes no writes in a dry run and prints the report (acceptance 15)", async () => {
    const s3 = fakeS3();
    const table = fakeTable(storedRows());
    const out = quiet();

    const report = await runBackfill({ options: options(), config, s3: s3.s3, ddb: table.ddb, ...out });

    expect(table.writes).toEqual([]);
    expect(s3.commands.every(({ name }) => name === "ListObjectsV2Command" || name === "GetObjectCommand")).toBe(true);
    expect(out.lines).toEqual([
      "backfill:bill-companions mode=DRY-RUN bucket=bill-store table=BillsManifest",
      "raw bills: scanned=12 unreadable=1 identity-unresolved=1 truncated(pagination.next)=1",
      "declarations: with-identical=7 put=5 delete=1 unchanged=1 stale-skipped=1",
      "links: one-way=8 counterpart=6 same-chamber=1 cross-kind=1 cross-congress=0",
      "held (plain manifest guids)=12",
      "groups: total=2 hr-s=2 hjres-sjres=0 hres-sres=0 hconres-sconres=0 one-sided=1",
      "not grouped: ambiguous=1 [sres208] partner-not-held=1",
      "CURRENT: missing (PublishBillsManifest has not written it yet) -> resolver would publish +2 -0 (once enabled)",
      "samples(2): BILLS-119hr1285=BILLS-119s570 (both sides) BILLS-119hr8849=BILLS-119s4394 (listed by hr8849 only)",
      "DRY-RUN: nothing was written. Re-run with --apply to write the link lists.",
    ]);
    expect(report.pairs).toEqual([
      ["BILLS-119hr1285", "BILLS-119s570"],
      ["BILLS-119hr8849", "BILLS-119s4394"],
    ]);
    expect(report.applied).toBeUndefined();
    expect(out.errors.map(([message]) => message)).toEqual([
      expect.stringContaining("unreadable raw bill raw-bills/broken.json"),
      "  identity unresolved: raw-bills/weird.json",
    ]);
  });

  it("writes the planned rows with the freshness condition under --apply (acceptance 15)", async () => {
    const table = fakeTable(storedRows());
    // hr1285's row is refreshed from newer raw data between the plan and the write.
    table.onWrite((input) => {
      if (input.Item?.sk.S === "BILLS-119hr1285") {
        table.table.set("BILL_COMPANION_DECL|BILLS-119hr1285", declRow("BILLS-119hr1285", ["BILLS-119s570"], T2));
      }
    });
    const out = quiet();

    const report = await runBackfill({
      options: options({ apply: true }),
      config,
      s3: fakeS3().s3,
      ddb: table.ddb,
      ...out,
    });

    expect(table.writes.map(({ name, input }) => [name, (input.Item ?? input.Key)!.sk.S]).sort()).toEqual([
      ["DeleteItemCommand", "BILLS-119hr5"],
      ["PutItemCommand", "BILLS-119hr1285"],
      ["PutItemCommand", "BILLS-119hr77"],
      ["PutItemCommand", "BILLS-119hr8849"],
      ["PutItemCommand", "BILLS-119hres1260"],
      ["PutItemCommand", "BILLS-119hres407"],
    ]);
    for (const { input } of table.writes) {
      expect(input.ConditionExpression).toBe("attribute_not_exists(#sk) OR attribute_not_exists(#src) OR #src <= :src");
      expect(input.ExpressionAttributeValues![":src"]).toEqual({ S: T1 });
    }
    expect(report.applied).toEqual({ written: 4, deleted: 1, staleSkipped: 1, failed: 0 });
    expect(out.lines).toContain("applied: written=4 deleted=1 stale-skipped=1 failed=0");
    expect(table.get("BILL_COMPANION_DECL", "BILLS-119hr8849")?.truncated).toEqual({ BOOL: true });
    expect(table.get("BILL_COMPANION_DECL", "BILLS-119hr5")).toBeUndefined();
    // The newer row survived; the stale row was never written.
    expect(table.get("BILL_COMPANION_DECL", "BILLS-119hr1285")?.sourceFetchedAt).toEqual({ S: T2 });
    expect(table.get("BILL_COMPANION_DECL", "BILLS-119hr1")?.declared.L).toHaveLength(1);
  });

  it("invokes the publisher and prints CURRENT with --publish-now", async () => {
    const table = fakeTable(storedRows());
    const invokePublish = jest.fn((functionName: string, region: string) => {
      table.table.set("BILL_COMPANION_GROUPS|CURRENT", {
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "2" },
        enabled: { BOOL: true },
        pairs: { S: JSON.stringify([["BILLS-119hr1285", "BILLS-119s570"]]) },
        resolvedAt: { S: T2 },
      });
      return `{"StatusCode": 200, "functionName": "${functionName}", "region": "${region}"}\n`;
    });
    const out = quiet();

    const report = await runBackfill({
      options: options({ apply: true, publishNow: true }),
      config,
      s3: fakeS3().s3,
      ddb: table.ddb,
      invokePublish,
      ...out,
    });

    expect(invokePublish).toHaveBeenCalledWith("PublishBillsManifest:prod", "us-east-1");
    expect(report.currentAfterPublish?.pairsVersion).toBe(2);
    expect(out.lines).toContain(`CURRENT after publish: pairsVersion=2 enabled=true groups=1 resolvedAt=${T2}`);
    expect(out.lines).toContain("active groups: 1");
  });

  it("scans only the given guids, keeps the other stored rows, and diffs against CURRENT", async () => {
    const s3 = fakeS3();
    const table = fakeTable([
      ...storedRows(),
      declRow("BILLS-119hr1285", ["BILLS-119s570"], T1),
      {
        pk: { S: "BILL_COMPANION_GROUPS" },
        sk: { S: "CURRENT" },
        pairsVersion: { N: "7" },
        enabled: { BOOL: true },
        pairs: { S: JSON.stringify([["BILLS-119hr5", "BILLS-119s5"]]) },
        resolvedAt: { S: T2 },
      },
    ]);
    const out = quiet();

    const report = await runBackfill({
      options: options({ guids: ["BILLS-119hr8849", "BILLS-119hr404"] }),
      config,
      s3: s3.s3,
      ddb: table.ddb,
      ...out,
    });

    expect(s3.commands.map(({ name, input }) => [name, input.Key])).toEqual([
      ["GetObjectCommand", "raw-bills/BILLS-119hr404.json"],
      ["GetObjectCommand", "raw-bills/BILLS-119hr8849.json"],
    ]);
    expect(report.raw).toEqual({ scanned: 2, unreadable: 1, identityUnresolved: 0, truncated: 1 });
    expect(report.declarations).toEqual({ withIdentical: 1, put: 1, delete: 0, unchanged: 0, staleSkipped: 0 });
    // hr1285 and s570 come from their stored rows; hr8849 from its planned row. hr5 keeps its stored row.
    expect(report.pairs).toEqual([
      ["BILLS-119hr1285", "BILLS-119s570"],
      ["BILLS-119hr5", "BILLS-119s5"],
      ["BILLS-119hr8849", "BILLS-119s4394"],
    ]);
    expect(report.wouldAdd).toBe(2);
    expect(report.wouldRemove).toBe(0);
    expect(out.lines[0]).toBe(
      "backfill:bill-companions mode=DRY-RUN bucket=bill-store table=BillsManifest guids=BILLS-119hr8849,BILLS-119hr404",
    );
    expect(out.lines).toContain(
      `CURRENT: pairsVersion=7 enabled=true groups=1 resolvedAt=${T2} -> resolver would publish +2 -0`,
    );
    expect(table.writes).toEqual([]);
  });

  it("stops after --max-items keys and reports failed writes", async () => {
    const table = fakeTable(storedRows());
    table.onWrite(() => {
      throw new Error("ProvisionedThroughputExceededException");
    });
    const out = quiet();

    const report = await runBackfill({
      options: options({ apply: true, maxItems: 3 }),
      config,
      s3: fakeS3().s3,
      ddb: table.ddb,
      ...out,
    });

    // The first three keys by name: hr1 (stale, not written), hr1285 (put) and hr5 (delete).
    expect(report.raw.scanned).toBe(3);
    expect(report.declarations).toMatchObject({ put: 1, delete: 1, staleSkipped: 1 });
    expect(report.applied).toEqual({ written: 0, deleted: 0, staleSkipped: 0, failed: 2 });
    expect(out.errors.some(([message]) => String(message).includes("failed to put the link list"))).toBe(true);
  });
});
