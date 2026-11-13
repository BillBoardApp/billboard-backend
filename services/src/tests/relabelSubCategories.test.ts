import { FakeVersionedS3, type FakeS3Command } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

const mockSqsSend = jest.fn();
jest.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import {
  GetItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { SQSEvent } from "aws-lambda";
import type { ProcessedBillDocument } from "../models/bill";
import { SOURCE_METADATA_KEYS } from "../shared/billSourceReconcile";
import { applyTestEnv } from "./fixtures/env";
import { s3RecordsForKeys } from "./fixtures/awsEvents";
import {
  BILL_RELABEL_HOLD,
  USAGE,
  configFromEnv,
  moveFollow,
  parseArgs,
  plainGuid,
  relabelBill,
  relabelBillBody,
  relabelSubCategoryList,
  runCorrelationId,
  runRelabel,
  WRITE_CONCURRENCY,
  type CliOptions,
  type RelabelConfig,
} from "../../scripts/relabelSubCategories";

const CONFIG: RelabelConfig = {
  region: "us-east-1",
  bucket: "bill-store",
  processedPrefix: "processed-bills/",
  preferencesTable: "UserPreferences",
  userIdAttribute: "userId",
  preferenceAttribute: "preference",
};
const STARTED_AT = new Date("2026-10-20T12:00:00.000Z");
const RUN_CORRELATION_ID = "relabel-llm10-20261020T120000Z";

const SOURCE = {
  [SOURCE_METADATA_KEYS.textHash]: "v1:abc",
  [SOURCE_METADATA_KEYS.rawVersion]: "raw-v7",
  [SOURCE_METADATA_KEYS.fetchedAt]: "2026-09-01T00:00:00.000Z",
};

const processed = (guid: string, subCategories: unknown[], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2026-03-19T16:41:58.228Z",
  identifier: { congress: "119", billType: "hr", billNumber: guid.replace(/^\D+119[a-z]+/, "") },
  guid,
  title: `Headline ${guid}`,
  link: "",
  soWhat: "Summary.",
  billBreakdown: { who: "a", what: "b", how: "c", when: "d", where: "e", why: "f" },
  internalSchema: 1,
  subCategories,
  lifeAreas: ["Taxes"],
  sponsors: ["S000001"],
  cosponsors: [],
  actions: [{ actionDate: "2026-01-10", actionCode: "Intro-H", text: "Introduced in House" }],
  committees: [],
  billStatus: "New",
  civicProfile: { localVsFederal: 0.25 },
  ...overrides,
});

/**
 * The versioned fake plus what it does not model: the ContentType each version was stored with (returned by
 * GetObject, as S3 does) and the most PutObject calls in flight at once.
 */
class TypedS3 extends FakeVersionedS3 {
  readonly contentTypes = new Map<string, string>();
  inFlightPuts = 0;
  maxInFlightPuts = 0;

  seed(key: string, value: unknown, metadata?: Record<string, string>, contentType = "application/json"): void {
    this.put(key, value, metadata);
    this.contentTypes.set(key, contentType);
  }

  override async send(command: FakeS3Command): Promise<Awaited<ReturnType<FakeVersionedS3["send"]>>> {
    if (command.__cmd === "PutObject") {
      this.inFlightPuts += 1;
      this.maxInFlightPuts = Math.max(this.maxInFlightPuts, this.inFlightPuts);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const result = await super.send(command);
        this.contentTypes.set(String(command.input.Key), String(command.input.ContentType));
        return result;
      } finally {
        this.inFlightPuts -= 1;
      }
    }
    const result = await super.send(command);
    if (command.__cmd === "GetObject" && !command.input.VersionId) {
      const contentType = this.contentTypes.get(String(command.input.Key));
      return (contentType ? { ...result, ContentType: contentType } : result) as typeof result;
    }
    return result;
  }
}

type Item = Record<string, AttributeValue>;

const canceled = (codes: string[]): Error =>
  Object.assign(new Error("Transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

/** UserPreferences in memory: Scan (paged, IN filter on the sort key), GetItem and TransactWriteItems. */
class FakePreferences {
  readonly items = new Map<string, Item>();
  readonly writes: TransactWriteItem[][] = [];
  readonly calls: string[] = [];
  /** Runs once, right before the next transaction checks its conditions. */
  beforeTransact: Array<() => void> = [];
  pageSize = 2;

  private static keyOf(userId: string, preference: string): string {
    return `${userId}\u0000${preference}`;
  }

  put(item: Item): void {
    this.items.set(FakePreferences.keyOf(item.userId.S!, item.preference.S!), item);
  }

  get(userId: string, preference: string): Item | undefined {
    return this.items.get(FakePreferences.keyOf(userId, preference));
  }

  remove(userId: string, preference: string): void {
    this.items.delete(FakePreferences.keyOf(userId, preference));
  }

  follow(userId: string, preference: string, category: string, type = "Category"): Item {
    const item: Item = {
      userId: { S: userId },
      preference: { S: preference },
      type: { S: type },
      ...(category ? { category: { S: category } } : {}),
    };
    this.put(item);
    return item;
  }

  async send(command: unknown): Promise<unknown> {
    if (command instanceof ScanCommand) {
      this.calls.push("Scan");
      const input = command.input;
      const wanted = new Set(Object.values(input.ExpressionAttributeValues ?? {}).map((value) => value.S));
      const keys = [...this.items.keys()].sort();
      const start = input.ExclusiveStartKey
        ? keys.indexOf(
            FakePreferences.keyOf(input.ExclusiveStartKey.userId.S!, input.ExclusiveStartKey.preference.S!),
          ) + 1
        : 0;
      const page = keys.slice(start, start + this.pageSize);
      const last = page.length > 0 && start + page.length < keys.length ? this.items.get(page[page.length - 1]) : null;
      return {
        Items: page.map((key) => this.items.get(key)!).filter((item) => wanted.has(item.preference.S)),
        ...(last ? { LastEvaluatedKey: { userId: last.userId, preference: last.preference } } : {}),
      };
    }
    if (command instanceof GetItemCommand) {
      this.calls.push("GetItem");
      const key = command.input.Key!;
      const item = this.get(key.userId.S!, key.preference.S!);
      return item ? { Item: { ...item } } : {};
    }
    if (command instanceof TransactWriteItemsCommand) {
      this.calls.push("TransactWriteItems");
      const hook = this.beforeTransact.shift();
      if (hook) hook();
      const transactItems = command.input.TransactItems ?? [];
      const exists = (key: Item) => Boolean(this.get(key.userId.S!, key.preference.S!));
      const codes = transactItems.map((entry) => {
        if (entry.Put) return exists(entry.Put.Item!) ? "ConditionalCheckFailed" : "None";
        if (entry.Delete) return exists(entry.Delete.Key!) ? "None" : "ConditionalCheckFailed";
        if (entry.ConditionCheck) return exists(entry.ConditionCheck.Key!) ? "None" : "ConditionalCheckFailed";
        return "ValidationError";
      });
      if (codes.some((code) => code !== "None")) throw canceled(codes);
      for (const entry of transactItems) {
        if (entry.Put) this.put(entry.Put.Item!);
        if (entry.Delete) this.remove(entry.Delete.Key!.userId.S!, entry.Delete.Key!.preference.S!);
      }
      this.writes.push(transactItems);
      return {};
    }
    throw new Error(`FakePreferences: unexpected command ${(command as object)?.constructor?.name}`);
  }
}

let preferences: FakePreferences;
let logs: string[];
let errors: unknown[][];

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  ...parseArgs([]),
  ...overrides,
});

const run = (overrides: Partial<CliOptions> = {}) =>
  runRelabel({
    s3: new S3Client({}),
    ddb: preferences,
    config: CONFIG,
    options: options(overrides),
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    logError: (...args: unknown[]) => errors.push(args),
    now: () => STARTED_AT,
  });

const typedS3 = (): TypedS3 => mockS3 as TypedS3;
const key = (guid: string) => `processed-bills/${guid}.json`;
const lastLine = () => logs[logs.length - 1];
const summaryLine = () => logs.find((line) => line.startsWith("Relabel plan:"));

/** Three bills to relabel (one without source metadata, one with both names), two to leave alone, seven follows. */
const seed = () => {
  const s3 = typedS3();
  s3.seed(key("BILLS-119hr1"), processed("BILLS-119hr1", ["Social Justice", "Healthcare"]), SOURCE);
  s3.seed(key("BILLS-119hr2"), processed("BILLS-119hr2ih", ["Identity Politics"]));
  s3.seed(
    key("BILLS-119hr3"),
    processed("BILLS-119hr3", ["Social Justice", "Civil Rights and Liberties", "Identity Politics"]),
    SOURCE,
  );
  s3.seed(key("BILLS-119hr4"), processed("BILLS-119hr4", ["Energy"]), SOURCE);
  s3.seed(key("BILLS-119hr5"), processed("BILLS-119hr5", []));
  s3.seed("processed-bills/", "");
  s3.seed("raw-bills/BILLS-119hr1.json", { subCategories: ["Social Justice"] });

  preferences.follow("user-a", "Social Justice", "Social Policy");
  preferences.follow("user-a", "Energy", "Environmental and Energy Policy");
  preferences.follow("user-b", "Identity Politics", "Cultural and Ethical Issues");
  preferences.follow("user-b", "Heritage and Identity", "Cultural and Ethical Issues");
  preferences.follow("user-c", "Social Justice", "", "Watch");
  preferences.follow("user-c", "BILLS-119hr1", "", "Bill");
  preferences.follow("user-d", "Identity Politics", "Cultural and Ethical Issues");
};

beforeEach(() => {
  mockS3 = new TypedS3();
  preferences = new FakePreferences();
  logs = [];
  errors = [];
  mockSqsSend.mockReset();
});

describe("relabelSubCategories: the rule", () => {
  it("maps each former name, removes later duplicates and keeps the order", () => {
    expect(relabelSubCategoryList(["Healthcare", "Social Justice", "Identity Politics"])).toEqual([
      "Healthcare",
      "Civil Rights and Liberties",
      "Heritage and Identity",
    ]);
    expect(relabelSubCategoryList(["Civil Rights and Liberties", "Energy", "Social Justice"])).toEqual([
      "Civil Rights and Liberties",
      "Energy",
    ]);
    expect(relabelSubCategoryList(["Social Justice", "Social Justice"])).toEqual(["Civil Rights and Liberties"]);
  });

  it("plans nothing for a list without a former name, or for no list", () => {
    expect(relabelSubCategoryList(["Energy", "Civil Rights and Liberties"])).toBeNull();
    expect(relabelSubCategoryList(["social justice", "Social Justice "])).toBeNull();
    expect(relabelSubCategoryList([])).toBeNull();
    expect(relabelSubCategoryList(undefined)).toBeNull();
    expect(relabelSubCategoryList("Social Justice")).toBeNull();
  });

  it("changes only subCategories in the body, in place, so storedAt and every other byte stay", () => {
    const original = JSON.stringify(processed("BILLS-119hr1", ["Social Justice", "Healthcare"]));
    const relabelled = relabelBillBody(original)!;

    expect(relabelled.from).toEqual(["Social Justice"]);
    expect(relabelled.body).toBe(
      original.replace(
        '"subCategories":["Social Justice","Healthcare"]',
        '"subCategories":["Civil Rights and Liberties","Healthcare"]',
      ),
    );
    expect(Object.keys(JSON.parse(relabelled.body))).toEqual(Object.keys(JSON.parse(original)));
    expect(relabelBillBody(JSON.stringify(processed("BILLS-119hr4", ["Energy"])))).toBeNull();
    expect(relabelBillBody("[]")).toBeNull();
    expect(() => relabelBillBody("{not json")).toThrow();
  });

  it("names the run in the correlation id", () => {
    expect(runCorrelationId(STARTED_AT)).toBe(RUN_CORRELATION_ID);
  });
});

describe("relabelSubCategories: arguments and configuration", () => {
  it("defaults to a dry run over bills and follows", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      apply: false,
      preferences: false,
      guids: [],
      concurrency: 8,
      guidsOut: null,
    });
  });

  it("reads --guid (suffix dropped, repeats ignored), --apply, --preferences and --concurrency", () => {
    expect(parseArgs(["--guid", "BILLS-119hr1400ih", "--guid", "BILLS-119hr1400", "--apply"])).toMatchObject({
      apply: true,
      guids: ["BILLS-119hr1400"],
    });
    expect(parseArgs(["--apply", "--preferences", "--concurrency", "3"])).toMatchObject({
      apply: true,
      preferences: true,
      concurrency: 3,
    });
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(plainGuid(" BILLS-119sres820ats ")).toBe("BILLS-119sres820");
  });

  it("marks the bill writes ON HOLD in the usage, and says when the follows may move (LLM-10)", () => {
    const lines = USAGE.split("\n");
    expect(lines).toContain(BILL_RELABEL_HOLD);
    expect(lines.find((line) => line.includes("Relabel one bill"))).toMatch(/--guid \S+ --apply .*ON HOLD/);
    expect(lines.find((line) => line.includes("Relabel every planned bill"))).toMatch(/-- --apply .*ON HOLD/);
    expect(lines.find((line) => line.includes("Move every planned follow"))).not.toContain("ON HOLD");
    expect(USAGE).toContain(
      "Move the follows only once GET /preferences returns the former names to builds 1.0 and R1",
    );
  });

  it("refuses unknown or malformed arguments and --guid with --preferences", () => {
    expect(() => parseArgs(["--guid"])).toThrow("--guid needs a bill guid");
    expect(() => parseArgs(["--guid", "--apply"])).toThrow("--guid needs a bill guid");
    expect(() => parseArgs(["--guid", "hr1400"])).toThrow("--guid needs a bill guid");
    expect(() => parseArgs(["--concurrency", "0"])).toThrow("--concurrency needs a whole number from 1 to 25");
    expect(() => parseArgs(["--concurrency", "26"])).toThrow("--concurrency");
    expect(() => parseArgs(["--force"])).toThrow("Unknown argument: --force");
    expect(() => parseArgs(["--preferences", "--guid", "BILLS-119hr1"])).toThrow("use one or the other");
    expect(() => parseArgs(["--guids-out"])).toThrow("--guids-out needs a file path");
    expect(() => parseArgs(["--preferences", "--guids-out", "list.txt"])).toThrow("--preferences plans no bills");
    expect(parseArgs(["--guids-out", "list.txt"]).guidsOut).toBe("list.txt");
  });

  it("reads the bucket and table from the environment, with production defaults", () => {
    expect(configFromEnv({})).toEqual({
      region: "us-east-1",
      bucket: "billboard-bill-store-bucket",
      processedPrefix: "processed-bills/",
      preferencesTable: "UserPreferences",
      userIdAttribute: "userId",
      preferenceAttribute: "preference",
    });
    expect(configFromEnv({ AWS_REGION: "us-west-2", BUCKET_NAME: "b", PREFERENCES_TABLE_NAME: "P" })).toMatchObject({
      region: "us-west-2",
      bucket: "b",
      preferencesTable: "P",
    });
  });
});

describe("relabelSubCategories: dry run", () => {
  it("plans the bills and follows with a former name and writes nothing", async () => {
    seed();

    const result = await run();

    expect(result.failed).toBe(false);
    expect(result.bills?.read).toBe(5);
    expect(result.bills?.planned.map((bill) => [bill.guid, bill.to, bill.hasSourceMetadata])).toEqual([
      ["BILLS-119hr1", ["Civil Rights and Liberties", "Healthcare"], true],
      ["BILLS-119hr2", ["Heritage and Identity"], false],
      ["BILLS-119hr3", ["Civil Rights and Liberties", "Heritage and Identity"], true],
    ]);
    expect(result.follows).toEqual([
      { userId: "user-a", from: "Social Justice", to: "Civil Rights and Liberties", kind: "move" },
      { userId: "user-b", from: "Identity Politics", to: "Heritage and Identity", kind: "drop" },
      {
        userId: "user-c",
        from: "Social Justice",
        to: "Civil Rights and Liberties",
        kind: "skipped",
        reason: "type Watch",
      },
      { userId: "user-d", from: "Identity Politics", to: "Heritage and Identity", kind: "move" },
    ]);
    expect(summaryLine()).toBe(
      "Relabel plan: bills=3 socialJustice=2 identityPolitics=2 both=1 noSourceMetadata=1 " +
        "follows=3 move=2 drop=1 skipped=1 unreadable=0",
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        '  "Social Justice": 2, "Identity Politics": 2, both: 1',
        "  guids: BILLS-119hr1, BILLS-119hr2, BILLS-119hr3",
        '  user-a: "Social Justice" -> "Civil Rights and Liberties" (move)',
        '  user-b: "Identity Politics" -> "Heritage and Identity" (already follows the new name: delete)',
        '  user-c: "Social Justice" left alone (type Watch)',
      ]),
    );
    expect(logs.some((line) => line.includes("1 have no source metadata") && line.endsWith("BILLS-119hr2"))).toBe(true);
    expect(lastLine()).toContain("Dry run: nothing written.");
    // LLM-10: the bill relabel is on hold while builds 1.0 and R1 are in use; the closing line says so.
    expect(lastLine()).toContain(BILL_RELABEL_HOLD);
    expect(lastLine()).toContain("ON HOLD");

    expect(mockS3.commands("PutObject")).toEqual([]);
    expect(mockS3.commands("ListObjectsV2")).toHaveLength(1);
    expect(preferences.calls).not.toContain("TransactWriteItems");
    // The scan pages through the whole table (page size 2 here).
    expect(preferences.calls.filter((call) => call === "Scan")).toHaveLength(4);
  });

  it("writes the planned guids to --guids-out in the reconcile list format, and nothing to AWS", async () => {
    seed();
    const files: Array<[string, string]> = [];

    await runRelabel({
      s3: new S3Client({}),
      ddb: preferences,
      config: CONFIG,
      options: options({ guidsOut: "relabel-guids.txt" }),
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      now: () => STARTED_AT,
      writeFile: (path, text) => files.push([path, text]),
    });

    expect(files).toEqual([["relabel-guids.txt", "BILLS-119hr1\nBILLS-119hr2\nBILLS-119hr3\n"]]);
    const { parseGuidsFile } = require("../../scripts/reconcileProcessedBills");
    expect(parseGuidsFile(files[0][1])).toEqual(["BILLS-119hr1", "BILLS-119hr2", "BILLS-119hr3"]);
    expect(logs).toContain("Wrote 3 planned guids to relabel-guids.txt");
    expect(mockS3.commands("PutObject")).toEqual([]);
  });

  it("reports a bill that cannot be read and fails the run, without stopping the others", async () => {
    seed();
    typedS3().seed(key("BILLS-119hr9"), "{not json");

    const result = await run();

    expect(result.failed).toBe(true);
    expect(result.bills?.planned).toHaveLength(3);
    expect(result.bills?.unreadable).toEqual([{ key: key("BILLS-119hr9"), error: expect.any(String) }]);
    expect(summaryLine()).toMatch(/ unreadable=1$/);
  });

  it("reads only the listed bill with --guid, reports a missing one, and scans no follows", async () => {
    seed();

    const result = await run({ guids: ["BILLS-119hr2", "BILLS-119hr77"] });

    expect(result.bills?.planned.map((bill) => bill.guid)).toEqual(["BILLS-119hr2"]);
    expect(result.bills?.unreadable).toEqual([{ key: key("BILLS-119hr77"), error: "no such bill" }]);
    expect(result.follows).toBeNull();
    expect(result.failed).toBe(true);
    expect(mockS3.commands("ListObjectsV2")).toEqual([]);
    expect(preferences.calls).toEqual([]);
    expect(summaryLine()).toBe(
      "Relabel plan: bills=1 socialJustice=0 identityPolitics=1 both=0 noSourceMetadata=1 unreadable=1",
    );
  });
});

describe("relabelSubCategories: --apply on bills", () => {
  it("relabels the canary only: same metadata and ContentType, IfMatch on the ETag read, storedAt unchanged", async () => {
    seed();
    const before = mockS3.current(key("BILLS-119hr1"))!;

    const result = await run({ apply: true, guids: ["BILLS-119hr1"] });

    expect(result.billOutcomes).toEqual({ relabelled: 1, already_current: 0, gone: 0, conflict: 0, failed: 0 });
    expect(result.failed).toBe(false);
    const puts = mockS3.commands("PutObject");
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toMatchObject({
      Bucket: "bill-store",
      Key: key("BILLS-119hr1"),
      IfMatch: before.etag,
      ContentType: "application/json",
      Metadata: { ...SOURCE, "correlation-id": RUN_CORRELATION_ID },
    });

    const after = mockS3.current(key("BILLS-119hr1"))!;
    expect(after.metadata).toEqual({ ...SOURCE, "correlation-id": RUN_CORRELATION_ID });
    const { subCategories: beforeLabels, ...beforeRest } = JSON.parse(before.body);
    const { subCategories: afterLabels, ...afterRest } = JSON.parse(after.body);
    expect(beforeLabels).toEqual(["Social Justice", "Healthcare"]);
    expect(afterLabels).toEqual(["Civil Rights and Liberties", "Healthcare"]);
    expect(afterRest).toEqual(beforeRest);
    expect(afterRest.storedAt).toBe("2026-03-19T16:41:58.228Z");

    // Nothing else was written: not the other planned bills, not the follows.
    expect(mockS3.contentVersions(key("BILLS-119hr2"))).toHaveLength(1);
    expect(mockS3.contentVersions(key("BILLS-119hr3"))).toHaveLength(1);
    expect(preferences.calls).toEqual([]);
  });

  it("keeps a non-default ContentType and sets only the correlation id on a bill without metadata", async () => {
    typedS3().seed(key("BILLS-119hr2"), processed("BILLS-119hr2", ["Identity Politics"]), undefined, "text/plain");

    await run({ apply: true, guids: ["BILLS-119hr2"] });

    expect(mockS3.commands("PutObject")[0].input).toMatchObject({
      ContentType: "text/plain",
      Metadata: { "correlation-id": RUN_CORRELATION_ID },
    });
    expect(Object.keys(mockS3.commands("PutObject")[0].input.Metadata!)).toEqual(["correlation-id"]);
  });

  it("relabels every planned bill at most 4 at a time, leaves follows alone, and a rerun plans 0 bills", async () => {
    seed();
    for (let n = 10; n < 22; n += 1) {
      typedS3().seed(key(`BILLS-119hr${n}`), processed(`BILLS-119hr${n}`, ["Social Justice"]), SOURCE);
    }

    const result = await run({ apply: true });

    expect(result.billOutcomes.relabelled).toBe(15);
    expect(typedS3().maxInFlightPuts).toBeGreaterThan(1);
    expect(typedS3().maxInFlightPuts).toBeLessThanOrEqual(WRITE_CONCURRENCY);
    expect(mockS3.json<ProcessedBillDocument>(key("BILLS-119hr3"))!.subCategories).toEqual([
      "Civil Rights and Liberties",
      "Heritage and Identity",
    ]);
    expect(mockS3.contentVersions(key("BILLS-119hr4"))).toHaveLength(1);
    expect(preferences.calls).not.toContain("TransactWriteItems");
    expect(logs).toContain("Follows not moved; move them with --apply --preferences.");
    expect(lastLine()).toBe("Relabel complete.");

    logs = [];
    const rerun = await run();
    expect(rerun.bills?.planned).toEqual([]);
    expect(summaryLine()).toMatch(
      /^Relabel plan: bills=0 socialJustice=0 identityPolitics=0 both=0 noSourceMetadata=0 /,
    );
  });

  it("re-reads and retries when a pipeline write lands between the read and the write, keeping that write", async () => {
    typedS3().seed(key("BILLS-119hr1"), processed("BILLS-119hr1", ["Social Justice"]), SOURCE);
    mockS3.beforePut(key("BILLS-119hr1"), () => {
      // billDiffer patches the actions (the label is still the former one) after the script read the bill.
      mockS3.put(key("BILLS-119hr1"), processed("BILLS-119hr1", ["Social Justice"], { billStatus: "Passed" }), {
        ...SOURCE,
        "correlation-id": "pipeline",
      });
    });

    const result = await relabelBill(new S3Client({}), CONFIG, key("BILLS-119hr1"), RUN_CORRELATION_ID);

    expect(result).toEqual({ outcome: "relabelled" });
    const puts = mockS3.commands("PutObject");
    expect(puts).toHaveLength(2);
    expect(puts[0].input.IfMatch).not.toBe(puts[1].input.IfMatch);
    expect(mockS3.json(key("BILLS-119hr1"))).toMatchObject({
      billStatus: "Passed",
      subCategories: ["Civil Rights and Liberties"],
    });
    expect(mockS3.contentVersions(key("BILLS-119hr1"))).toHaveLength(3);
  });

  it("stops after 3 retries and reports a conflict, which fails the run", async () => {
    seed();
    for (let attempt = 0; attempt < 4; attempt += 1) mockS3.injectPutError(key("BILLS-119hr1"), 412);

    const result = await run({ apply: true, guids: ["BILLS-119hr1"] });

    expect(result.billOutcomes.conflict).toBe(1);
    expect(result.failed).toBe(true);
    expect(mockS3.commands("GetObject", key("BILLS-119hr1"))).toHaveLength(5); // the plan read + 4 attempts
    expect(mockS3.json<ProcessedBillDocument>(key("BILLS-119hr1"))!.subCategories).toEqual([
      "Social Justice",
      "Healthcare",
    ]);
    expect(errors[0][1]).toMatchObject({ guid: "BILLS-119hr1", outcome: "conflict" });
    expect(lastLine()).toContain("with problems");
  });

  it("writes nothing when a writer in between already moved the bill to the current names", async () => {
    typedS3().seed(key("BILLS-119hr1"), processed("BILLS-119hr1", ["Social Justice"]), SOURCE);
    mockS3.beforePut(key("BILLS-119hr1"), () => {
      mockS3.put(key("BILLS-119hr1"), processed("BILLS-119hr1", ["Civil Rights and Liberties"]), SOURCE);
    });

    const result = await relabelBill(new S3Client({}), CONFIG, key("BILLS-119hr1"), RUN_CORRELATION_ID);

    expect(result).toEqual({ outcome: "already_current" });
    expect(mockS3.contentVersions(key("BILLS-119hr1"))).toHaveLength(2);
  });

  it("reports a deleted bill as gone and any other S3 error as failed", async () => {
    expect(await relabelBill(new S3Client({}), CONFIG, key("BILLS-119hr1"), RUN_CORRELATION_ID)).toEqual({
      outcome: "gone",
    });

    typedS3().seed(key("BILLS-119hr2"), processed("BILLS-119hr2", ["Identity Politics"]));
    mockS3.injectPutError(key("BILLS-119hr2"), 500);
    expect(await relabelBill(new S3Client({}), CONFIG, key("BILLS-119hr2"), RUN_CORRELATION_ID)).toEqual({
      outcome: "failed",
      error: "InternalError",
    });
  });

  it("gives NotificationType no change to announce for the relabel write", async () => {
    typedS3().seed(key("BILLS-119hr1"), processed("BILLS-119hr1", ["Social Justice", "Healthcare"]), SOURCE);
    await relabelBill(new S3Client({}), CONFIG, key("BILLS-119hr1"), RUN_CORRELATION_ID);
    const written = mockS3.current(key("BILLS-119hr1"))!;

    const restoreEnv = applyTestEnv({
      BUCKET_NAME: "bill-store",
      QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/NotificationTypeQueue",
      QUEUE_BATCH_SIZE: "10",
      PROCESSED_BILLS_PREFIX: "processed-bills/",
    });
    const quiet = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      let handler!: typeof import("../handlers/notificationType").handler;
      jest.isolateModules(() => {
        ({ handler } = require("../handlers/notificationType"));
      });
      const response = await handler({
        Records: [
          {
            messageId: "m1",
            body: JSON.stringify(s3RecordsForKeys([key("BILLS-119hr1")], { versionId: written.versionId })),
          },
        ],
      } as SQSEvent);

      expect(response.batchItemFailures).toEqual([]);
      expect(mockSqsSend).not.toHaveBeenCalled();
      const classified = quiet.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("Classified processed bill"));
      expect(classified).toContain('"types":[]');
      expect(classified).toContain(RUN_CORRELATION_ID);
    } finally {
      quiet.mockRestore();
      restoreEnv();
    }
  });
});

describe("relabelSubCategories: --apply --preferences", () => {
  it("moves each follow in one transaction, drops a duplicate, leaves other rows, and a rerun plans 0", async () => {
    seed();

    const result = await run({ apply: true, preferences: true });

    expect(result.bills).toBeNull();
    expect(mockS3.calls).toEqual([]);
    expect(result.followOutcomes).toEqual({ moved: 2, dropped: 1, gone: 0, conflict: 0, failed: 0 });
    expect(result.failed).toBe(false);

    expect(preferences.get("user-a", "Social Justice")).toBeUndefined();
    expect(preferences.get("user-a", "Civil Rights and Liberties")).toEqual({
      userId: { S: "user-a" },
      preference: { S: "Civil Rights and Liberties" },
      type: { S: "Category" },
      category: { S: "Social Policy" },
    });
    expect(preferences.get("user-b", "Identity Politics")).toBeUndefined();
    expect(preferences.get("user-b", "Heritage and Identity")).toBeDefined();
    expect(preferences.get("user-d", "Heritage and Identity")?.category).toEqual({ S: "Cultural and Ethical Issues" });
    // Not a Category row, and not under a former name: untouched.
    expect(preferences.get("user-c", "Social Justice")?.type).toEqual({ S: "Watch" });
    expect(preferences.get("user-a", "Energy")).toBeDefined();

    // One transaction per follow: put + delete for a move, condition check + delete for a drop.
    expect(preferences.writes.map((items) => items.map((item) => Object.keys(item)[0]))).toEqual([
      ["Put", "Delete"],
      ["ConditionCheck", "Delete"],
      ["Put", "Delete"],
    ]);
    expect(preferences.writes[0][0].Put).toMatchObject({
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "userId" },
    });
    expect(preferences.writes[0][1].Delete).toMatchObject({ ConditionExpression: "attribute_exists(#pk)" });

    logs = [];
    const rerun = await run({ preferences: true });
    expect(rerun.follows?.filter((follow) => follow.kind !== "skipped")).toEqual([]);
    expect(summaryLine()).toBe("Relabel plan: follows=0 move=0 drop=0 skipped=1");
    // A follows-only dry run is not under the bill hold; it names when the follows may move.
    expect(lastLine()).not.toContain("ON HOLD");
    expect(lastLine()).toContain("once GET /preferences returns the former names to builds 1.0 and R1");
  });

  it("moves the rest of a sub_category row's attributes and maps a former sub_category too", async () => {
    preferences.put({
      userId: { S: "user-e" },
      preference: { S: "Social Justice" },
      type: { S: "Category" },
      category: { S: "Social Policy" },
      sub_category: { S: "Social Justice" },
      createdAt: { S: "2026-01-01T00:00:00Z" },
    });

    expect(
      await moveFollow(preferences, CONFIG, {
        userId: "user-e",
        from: "Social Justice",
        to: "Civil Rights and Liberties",
      }),
    ).toEqual({
      outcome: "moved",
    });
    expect(preferences.get("user-e", "Civil Rights and Liberties")).toEqual({
      userId: { S: "user-e" },
      preference: { S: "Civil Rights and Liberties" },
      type: { S: "Category" },
      category: { S: "Social Policy" },
      sub_category: { S: "Civil Rights and Liberties" },
      createdAt: { S: "2026-01-01T00:00:00Z" },
    });
  });

  it("does nothing for a follow the user removed after the plan", async () => {
    expect(
      await moveFollow(preferences, CONFIG, {
        userId: "user-a",
        from: "Social Justice",
        to: "Civil Rights and Liberties",
      }),
    ).toEqual({
      outcome: "gone",
    });
    expect(preferences.calls).toEqual(["GetItem"]);
  });

  it("retries when the user follows the current name between the read and the transaction, then only deletes", async () => {
    preferences.follow("user-a", "Social Justice", "Social Policy");
    preferences.beforeTransact.push(() => preferences.follow("user-a", "Civil Rights and Liberties", "Social Policy"));

    const result = await moveFollow(preferences, CONFIG, {
      userId: "user-a",
      from: "Social Justice",
      to: "Civil Rights and Liberties",
    });

    expect(result).toEqual({ outcome: "dropped" });
    expect(preferences.calls.filter((call) => call === "TransactWriteItems")).toHaveLength(2);
    expect(preferences.get("user-a", "Social Justice")).toBeUndefined();
    expect(preferences.get("user-a", "Civil Rights and Liberties")).toBeDefined();
  });

  it("reports a conflict after 3 retries and fails on any other error", async () => {
    preferences.follow("user-a", "Social Justice", "Social Policy");
    const conflicting = {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteItemsCommand) throw canceled(["None", "TransactionConflict"]);
        return preferences.send(command);
      },
    };
    expect(
      await moveFollow(conflicting, CONFIG, {
        userId: "user-a",
        from: "Social Justice",
        to: "Civil Rights and Liberties",
      }),
    ).toEqual({ outcome: "conflict", error: "the follow changed during 4 attempts" });

    const broken = {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteItemsCommand) throw new Error("AccessDenied");
        return preferences.send(command);
      },
    };
    expect(
      await moveFollow(broken, CONFIG, { userId: "user-a", from: "Social Justice", to: "Civil Rights and Liberties" }),
    ).toEqual({ outcome: "failed", error: "AccessDenied" });
    expect(preferences.get("user-a", "Social Justice")).toBeDefined();
  });

  it("fails the run when a follow could not be moved", async () => {
    seed();
    const broken = {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteItemsCommand) throw new Error("AccessDenied");
        return preferences.send(command);
      },
    };

    const result = await runRelabel({
      s3: new S3Client({}),
      ddb: broken,
      config: CONFIG,
      options: options({ apply: true, preferences: true }),
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      logError: (...args: unknown[]) => errors.push(args),
      now: () => STARTED_AT,
    });

    expect(result.followOutcomes.failed).toBe(3);
    expect(result.failed).toBe(true);
    expect(errors).toHaveLength(3);
  });
});
