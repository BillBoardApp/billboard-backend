import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

import { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient, GetQueueUrlCommandInput, SendMessageCommandInput } from "@aws-sdk/client-sqs";
import type { RawBill } from "../models/bill";
import { SOURCE_METADATA_KEYS, sourceTextHash } from "../shared/billSourceReconcile";
import {
  configFromEnv,
  parseArgs,
  parseGuidsFile,
  runReconcile,
  type CliOptions,
  type ReconcileConfig,
} from "../../scripts/reconcileProcessedBills";

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/BillDifferQueue";
const STARTED_AT = new Date("2026-10-19T12:00:00.000Z");

const INTRODUCED = { actionDate: "2026-01-10", actionCode: "Intro-H", text: "Introduced in House" };
const PASSED = { actionDate: "2026-02-10", actionCode: "8000", text: "Passed House" };

const raw = (guid: string, options: { text?: string | null; actions?: unknown[]; fetchedAt?: string } = {}) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-02-01T00:00:00.000Z",
  identifier: { congress: "119", billType: "hr", billNumber: guid.replace(/^\D+119[a-z]+/, "") },
  metadata: { guid, title: `Title ${guid}`, pubDate: "", fetchedAt: options.fetchedAt ?? "2026-02-01T00:00:00.000Z" },
  content: {
    ...(options.text === null ? {} : { billXML: `<bill>${options.text ?? "text"}</bill>` }),
    actions: { actions: options.actions ?? [INTRODUCED] },
    committees: { committees: [] },
  },
});

const processed = (guid: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "processed",
  storedAt: "2026-02-01T00:00:00.000Z",
  identifier: { congress: "119", billType: "hr", billNumber: "1" },
  guid,
  title: "Headline",
  link: "",
  soWhat: "Summary.",
  billBreakdown: { who: "", what: "", how: "", when: "", where: "", why: "" },
  subCategories: [],
  lifeAreas: [],
  sponsors: [],
  cosponsors: [],
  actions: [INTRODUCED],
  committees: [],
  billStatus: "New",
  ...overrides,
});

/** One bill per plan kind (keys sort in this order). */
const seed = () => {
  const put = (guid: string, rawDoc: unknown, builtFrom?: { doc: ReturnType<typeof raw>; version: string }) => {
    const versionId = mockS3.put(`raw-bills/${guid}.json`, rawDoc);
    if (builtFrom) {
      mockS3.put(`processed-bills/${guid}.json`, processed(guid), {
        [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(builtFrom.doc as RawBill),
        [SOURCE_METADATA_KEYS.rawVersion]: builtFrom.version === "same" ? versionId : builtFrom.version,
        [SOURCE_METADATA_KEYS.fetchedAt]: builtFrom.doc.metadata.fetchedAt,
      });
    }
  };
  const a = raw("BILLS-119hr1");
  put("BILLS-119hr1", a, { doc: a, version: "same" }); // unchanged
  put("BILLS-119hr2", raw("BILLS-119hr2", { actions: [PASSED, INTRODUCED] }), {
    doc: raw("BILLS-119hr2"),
    version: "older",
  }); // patch, passed + billStatus
  put("BILLS-119hr3", raw("BILLS-119hr3")); // summarize_missing
  put("BILLS-119hr4", raw("BILLS-119hr4", { text: "new" }), {
    doc: raw("BILLS-119hr4", { text: "old" }),
    version: "older",
  });
  put("BILLS-119hr5", raw("BILLS-119hr5", { text: null })); // awaiting_text
  put("BILLS-119hr6", raw("BILLS-119hr6", { fetchedAt: "2026-01-01T00:00:00.000Z" }), {
    doc: raw("BILLS-119hr6", { fetchedAt: "2026-03-01T00:00:00.000Z" }),
    version: "older",
  }); // stale_raw
  put("BILLS-119hr7", { schemaVersion: 1, kind: "raw", metadata: { guid: "BILLS-119hr7" }, content: {} }); // skipped
};

const config = (overrides: Partial<ReconcileConfig> = {}): ReconcileConfig => ({
  ...configFromEnv({}),
  ...overrides,
});
const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({ ...parseArgs([]), ...overrides });

/** An SQS command the fake client receives: GetQueueUrl or SendMessage. */
interface SqsCommand {
  constructor: { name: string };
  input: Partial<GetQueueUrlCommandInput & SendMessageCommandInput>;
}

const sqsClient = (failFor: string[] = []) => {
  const sent: Array<{ body: { guid: string }; correlationId?: string; queueUrl: string }> = [];
  const commands: string[] = [];
  const send = jest.fn(async (command: SqsCommand) => {
    commands.push(command.constructor.name);
    if (command.constructor.name === "GetQueueUrlCommand") {
      return command.input.QueueName === "BillDifferQueue" ? { QueueUrl: QUEUE_URL } : {};
    }
    const body = JSON.parse(command.input.MessageBody!) as { guid: string };
    if (failFor.includes(body.guid)) throw new Error("SQS unavailable");
    sent.push({
      body,
      queueUrl: command.input.QueueUrl!,
      correlationId: command.input.MessageAttributes?.correlationId?.StringValue,
    });
    return { MessageId: "m" };
  });
  return { client: { send } as unknown as Pick<SQSClient, "send">, sent, commands };
};

const run = async (cli: Partial<CliOptions>, sqs = sqsClient(), extra: Record<string, unknown> = {}) => {
  const lines: string[] = [];
  const sleep = jest.fn(async () => undefined);
  const result = await runReconcile({
    s3: new S3Client({}),
    sqs: sqs.client,
    config: config(),
    options: options(cli),
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    logError: () => undefined,
    now: () => STARTED_AT,
    sleep,
    ...extra,
  });
  return { result, lines, sleep, sqs };
};

beforeEach(() => {
  mockS3 = new FakeVersionedS3();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

describe("parseGuidsFile and parseArgs", () => {
  it("reads the first tab-separated column, skipping comments, blank lines and repeats", () => {
    const text = [
      "# Raw bills with text but no processed version. guid<TAB>raw LastModified",
      "BILLS-119hr6959\t2026-02-01T19:53:30+00:00",
      "",
      "BILLS-119hr1400ih\t2026-02-01T21:20:00+00:00",
      "BILLS-119hr6959\tagain",
    ].join("\n");
    expect(parseGuidsFile(text)).toEqual(["BILLS-119hr6959", "BILLS-119hr1400"]);
    expect(() => parseGuidsFile("BILLS-119hr1\nnot-a-guid\tx")).toThrow("Line 2");
  });

  it("parses the flags with their defaults and refuses anything else", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      apply: false,
      guids: [],
      guidsFile: null,
      limit: null,
      concurrency: 8,
      rate: 10,
      plans: null,
    });
    expect(
      parseArgs(["--guid", "BILLS-119hr1400ih", "--guid", "BILLS-119hr1400", "--guids-file", "list.txt", "--apply"]),
    ).toMatchObject({ guids: ["BILLS-119hr1400"], guidsFile: "list.txt", apply: true });
    expect(parseArgs(["--limit", "5", "--concurrency", "3", "--rate", "2", "--apply", "--dry-run"])).toMatchObject({
      limit: 5,
      concurrency: 3,
      rate: 2,
      apply: false,
    });
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(() => parseArgs(["--guid", "hr1400"])).toThrow("--guid needs a bill guid");
    expect(() => parseArgs(["--guids-file"])).toThrow("--guids-file needs a value");
    expect(() => parseArgs(["--rate", "0"])).toThrow("--rate needs a whole number from 1 to 100");
    expect(() => parseArgs(["--concurrency", "26"])).toThrow();
    expect(() => parseArgs(["--force"])).toThrow("Unknown argument: --force");
    expect(parseArgs(["--plans", "patch", "--apply"])).toMatchObject({ plans: ["patch"], apply: true });
    expect(parseArgs(["--plans", "patch,summarize_missing"]).plans).toEqual(["patch", "summarize_missing"]);
    expect(() => parseArgs(["--plans", "patch,unchanged"])).toThrow("--plans takes patch, summarize_missing");
    expect(() => parseArgs(["--plans"])).toThrow("--plans needs a value");
  });

  it("reads its configuration from the environment", () => {
    expect(configFromEnv({})).toEqual({
      region: "us-east-1",
      bucket: "billboard-bill-store-bucket",
      rawPrefix: "raw-bills/",
      billDifferQueueUrl: "",
      billDifferQueueName: "BillDifferQueue",
    });
    expect(
      configFromEnv({ BILL_DIFFER_QUEUE_URL: QUEUE_URL, BUCKET_NAME: "b", AWS_REGION: "eu-west-1" }),
    ).toMatchObject({
      billDifferQueueUrl: QUEUE_URL,
      bucket: "b",
      region: "eu-west-1",
    });
  });
});

describe("runReconcile", () => {
  it("dry run: plans every raw bill and reports counts, summaries and notable patches, sending nothing", async () => {
    seed();
    const { result, lines, sqs } = await run({});

    expect(lines.at(-1)).toBe(
      "Reconcile plan: total=7 unchanged=1 patch=1 summarize_missing=1 summarize_text_changed=1 awaiting_text=1 stale_raw=1 skipped=1 unreadable=0",
    );
    expect(lines).toContain("summarize_missing (1): BILLS-119hr3");
    expect(lines).toContain("summarize_text_changed (1): BILLS-119hr4");
    expect(lines).toContain(
      "patched fields: actions=1 committees=0 sponsors=0 cosponsors=0 billStatus=1 officialVotes=0",
    );
    expect(lines).toContain("patches that add a passed or failed action or change billStatus (1)");
    expect(lines).toContain('  BILLS-119hr2 passed 2026-02-10 "Passed House"; billStatus New -> Passed');
    expect(lines).toContain(`Dry run: would send 3 guids (patch and summarize plans) to ${QUEUE_URL}.`);
    expect(result.sent).toBe(0);
    expect(sqs.sent).toEqual([]);
    expect(mockS3.commands("PutObject")).toEqual([]);
  });

  it("resolves the queue before it reads anything, and stops when the queue is missing", async () => {
    seed();
    const sqs = sqsClient();
    const s3Before = mockS3.calls.length;
    await expect(
      runReconcile({
        s3: new S3Client({}),
        sqs: sqs.client,
        config: config({ billDifferQueueName: "NoSuchQueue" }),
        options: options({ apply: true }),
        log: () => undefined,
      }),
    ).rejects.toThrow("Queue NoSuchQueue not found");
    expect(mockS3.calls.length).toBe(s3Before);

    const { result, sqs: withUrl } = await run({}, sqsClient(), {
      config: config({ billDifferQueueUrl: "https://q" }),
    });
    expect(result.queueUrl).toBe("https://q");
    expect(withUrl.commands).toEqual([]);
  });

  it("--apply sends {guid} for the patch and summarize plans only, paced, and never writes to S3", async () => {
    seed();
    const { result, lines, sleep, sqs } = await run({ apply: true, rate: 4 });

    expect(sqs.sent).toEqual(
      ["BILLS-119hr2", "BILLS-119hr3", "BILLS-119hr4"].map((guid) => ({
        body: { guid },
        queueUrl: QUEUE_URL,
        correlationId: `reconcile:2026-10-19T12:00:00.000Z:${guid}`,
      })),
    );
    expect(sleep.mock.calls).toEqual([[250], [250]]);
    expect(mockS3.commands("PutObject")).toEqual([]);
    expect(result).toMatchObject({ sent: 3, failed: [] });
    expect(lines.at(-1)).toBe("Reconcile complete sent=3 failed=0 unreadable=0");
  });

  it("--apply counts failed sends", async () => {
    seed();
    const { result, lines } = await run({ apply: true }, sqsClient(["BILLS-119hr3"]));

    expect(result).toMatchObject({ sent: 2, failed: ["BILLS-119hr3"] });
    expect(lines.at(-1)).toBe("Reconcile complete sent=2 failed=1 unreadable=0");
  });

  it("--plans patch sends only the patch plans", async () => {
    seed();
    const { result, lines, sqs } = await run({ apply: true, plans: ["patch"] });

    expect(sqs.sent.map((message) => message.body)).toEqual([{ guid: "BILLS-119hr2" }]);
    expect(lines).toContain(`Sending 1 guids (patch plans only) to ${QUEUE_URL}.`);
    expect(result).toMatchObject({ sent: 1, failed: [] });
  });

  it("a guids file that lists no bill stops the run before anything is planned or sent", async () => {
    seed();
    const readFile = jest.fn(() => "# guid\traw LastModified\n\n");
    const s3Before = mockS3.commands("GetObject").length + mockS3.commands("ListObjectsV2").length;

    await expect(run({ guidsFile: "subset.txt", apply: true }, sqsClient(), { readFile })).rejects.toThrow(
      "The guids file subset.txt lists no bills",
    );
    expect(mockS3.commands("GetObject").length + mockS3.commands("ListObjectsV2").length).toBe(s3Before);
  });

  it("reports a text change's pre-summary patch with the notable patches", async () => {
    mockS3.put("raw-bills/BILLS-119hr9.json", raw("BILLS-119hr9", { text: "new", actions: [PASSED, INTRODUCED] }));
    mockS3.put("processed-bills/BILLS-119hr9.json", processed("BILLS-119hr9"), {
      [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(raw("BILLS-119hr9", { text: "old" }) as RawBill),
      [SOURCE_METADATA_KEYS.rawVersion]: "older",
      [SOURCE_METADATA_KEYS.fetchedAt]: "2026-02-01T00:00:00.000Z",
    });

    const { lines } = await run({});

    expect(lines).toContain("summarize_text_changed (1): BILLS-119hr9");
    expect(lines).toContain('  BILLS-119hr9 passed 2026-02-10 "Passed House"; billStatus New -> Passed');
  });

  it("plans only the listed bills, from --guid and --guids-file, up to --limit, and reports unreadable ones", async () => {
    seed();
    mockS3.put("raw-bills/BILLS-119hr8.json", "{not json");
    const readFile = jest.fn(() => "# list\nBILLS-119hr3ih\t2026-02-01\nBILLS-119hr8\t2026-02-01\n");

    const { result, lines } = await run({ guids: ["BILLS-119hr4"], guidsFile: "list.txt" }, sqsClient(), { readFile });

    expect(readFile).toHaveBeenCalledWith("list.txt");
    expect(result.scan.planned.map((bill) => bill.guid)).toEqual(["BILLS-119hr3", "BILLS-119hr4"]);
    expect(result.scan.unreadable).toEqual([{ key: "raw-bills/BILLS-119hr8.json", error: expect.any(String) }]);
    expect(lines.some((line) => line.startsWith("unreadable (1): raw-bills/BILLS-119hr8.json"))).toBe(true);
    expect(lines.at(-1)).toMatch(/ unreadable=1$/);
    const applied = await run({ guids: ["BILLS-119hr8", "BILLS-119hr3"], apply: true });
    expect(applied.lines.at(-1)).toBe("Reconcile complete sent=1 failed=0 unreadable=1");

    const limited = await run({ limit: 2 });
    expect(limited.result.scan.planned.map((bill) => bill.guid)).toEqual(["BILLS-119hr1", "BILLS-119hr2"]);
  });
});
