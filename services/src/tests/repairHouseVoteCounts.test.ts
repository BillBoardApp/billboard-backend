import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient, SendMessageCommandInput } from "@aws-sdk/client-sqs";
import { FakeVersionedS3, preconditionFailed, type FakeS3Command } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

import {
  USAGE,
  applyRepairs,
  checkHouseChamber,
  configFromEnv,
  parseArgs,
  planRawBillRepair,
  runRepair,
  scanRawBills,
  type CliOptions,
  type RepairConfig,
} from "../../scripts/repairHouseVoteCounts";

const config: RepairConfig = configFromEnv({});
const NOW = new Date("2026-10-31T12:00:00.000Z");
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/BillDifferQueue";
const STORED_SYNC = "2026-10-29T08:00:00.000Z";

type Position = "Yea" | "Nay" | "Present" | "Not Voting";
const row = (bioguideId: string, votePosition: Position) => ({
  bioguideId,
  displayName: `Member ${bioguideId}`,
  party: "D",
  state: "CA",
  votePosition,
});

/** A House chamber as enrichment stored it before the fix: the action text's Yea and Nay, Present and Not voting 0. */
const houseChamber = (
  yea: number,
  nay: number,
  members: ReturnType<typeof row>[],
  extra: Record<string, unknown> = {},
) => ({
  yea,
  nay,
  present: 0,
  notVoting: 0,
  totalCounted: yea + nay,
  actionCode: "H37100",
  actionDate: "2026-07-23",
  resultText: `On passage Passed by the Yeas and Nays: ${yea} - ${nay} (Roll no. 278).`,
  memberDataAvailable: members.length > 0,
  members,
  ...extra,
});

const officialVotes = (house: unknown, extra: Record<string, unknown> = {}) => ({
  house,
  lastSyncedAt: STORED_SYNC,
  source: "congress_api",
  completeness: "complete",
  ...extra,
});

interface OfficialVotesFixture {
  [field: string]: unknown;
  house?: ReturnType<typeof houseChamber>;
}
interface RawFixture {
  [field: string]: unknown;
  metadata: { guid: string; [field: string]: unknown };
  content: { [field: string]: unknown; officialVotes?: OfficialVotesFixture };
}

const rawBill = (number: string, votes: unknown): RawFixture => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-10-29T08:00:00.000Z",
  identifier: { congress: "119", billType: "hr", billNumber: number },
  metadata: { guid: `BILLS-119hr${number}`, title: "A title", fetchedAt: "2026-10-29T07:59:00.000Z" },
  content: {
    bill: { bill: { title: "A title" } },
    billXML: "<bill/>",
    actions: { actions: [{ actionCode: "H37100", actionDate: "2026-07-23", text: "On passage Passed" }] },
    ...(votes ? { officialVotes: votes as OfficialVotesFixture } : {}),
  },
});

// H.R. 8800 in small: 2 - 1 from the text, plus 2 Not Voting rows.
const HR8800_ROWS = [
  row("A1", "Yea"),
  row("A2", "Yea"),
  row("B1", "Nay"),
  row("C1", "Not Voting"),
  row("C2", "Not Voting"),
];
const hr8800 = () => rawBill("8800", officialVotes(houseChamber(2, 1, HR8800_ROWS)));
// H.R. 227 in small: a hidden Present row, a hidden Not Voting row, and a row listed twice.
const HR227_ROWS = [
  row("A1", "Yea"),
  row("B1", "Nay"),
  row("B2", "Nay"),
  row("P1", "Present"),
  row("C1", "Not Voting"),
];
const hr227 = () => rawBill("227", officialVotes(houseChamber(1, 2, [...HR227_ROWS, row("P1", "Present")])));
// Rows that are not this roll call (their Yea and Nay disagree with the text's 220 - 210): never rewritten.
const mismatched = () =>
  rawBill("10", officialVotes(houseChamber(220, 210, [row("A1", "Yea"), row("B1", "Nay"), row("C1", "Not Voting")])));
// Already right: the figures equal the rows' count.
const matching = () =>
  rawBill(
    "11",
    officialVotes(
      houseChamber(1, 1, [row("A1", "Yea"), row("B1", "Nay"), row("C1", "Not Voting")], {
        notVoting: 1,
        totalCounted: 3,
      }),
    ),
  );
// Nothing to count: no House rows, a Senate vote only, votes the pipeline did not write.
const noRows = () => rawBill("12", officialVotes(houseChamber(2, 1, [])));
const senateOnly = () =>
  rawBill("13", {
    senate: houseChamber(1, 0, [row("S1", "Yea"), row("S2", "Not Voting")], { actionCode: "17000" }),
    lastSyncedAt: STORED_SYNC,
    source: "congress_api",
    completeness: "complete",
  });
const unusable = () => rawBill("14", { ...officialVotes(houseChamber(2, 1, HR8800_ROWS)), source: "other" });

const RAW = (guid: string) => `raw-bills/${guid}.json`;
const PROCESSED = (guid: string) => `processed-bills/${guid}.json`;
const processedOf = (raw: ReturnType<typeof rawBill>) => ({
  guid: raw.metadata.guid,
  title: "A title",
  storedAt: "2026-10-29T08:01:00.000Z",
  officialVotes: raw.content.officialVotes,
});

/** The bucket with every fixture's raw bill and a processed copy that shows the same votes. */
const seedBucket = (
  bills: Array<ReturnType<typeof rawBill>> = [
    hr8800(),
    hr227(),
    mismatched(),
    matching(),
    noRows(),
    senateOnly(),
    unusable(),
  ],
) => {
  mockS3 = new FakeVersionedS3();
  for (const bill of bills) {
    mockS3.put(RAW(bill.metadata.guid), bill, { "correlation-id": `fetch:${bill.metadata.guid}`, "source-x": "kept" });
    mockS3.put(PROCESSED(bill.metadata.guid), processedOf(bill));
  }
  return mockS3;
};

interface FakeSqsCommand {
  constructor: { name: string };
  input: SendMessageCommandInput;
}

const fakeSqs = ({ failSend = false } = {}) => {
  const commands: string[] = [];
  const sent: SendMessageCommandInput[] = [];
  const send = jest.fn(async (command: FakeSqsCommand) => {
    const name: string = command.constructor.name;
    commands.push(name);
    if (name === "GetQueueUrlCommand") return { QueueUrl: QUEUE_URL };
    if (name === "SendMessageCommand") {
      if (failSend) throw new Error("SQS unavailable");
      sent.push(command.input);
      return { MessageId: `m-${sent.length}` };
    }
    throw new Error(`Unexpected SQS command ${name}`);
  });
  return { sqs: { send } as unknown as Pick<SQSClient, "send">, commands, sent };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  help: false,
  apply: false,
  guids: [],
  maxItems: null,
  concurrency: 2,
  scanProcessed: false,
  ...overrides,
});

const silent = () => undefined;
const s3Writes = () => mockS3.calls.filter((call: FakeS3Command) => call.__cmd === "PutObject");
const raw = (guid: string) => mockS3.json<RawFixture>(RAW(guid))!;
const sentGuids = (sent: SendMessageCommandInput[]) =>
  sent.map((input) => (JSON.parse(input.MessageBody!) as { guid: string }).guid).sort();
/** The fake bucket as the client the script takes: it answers the same commands. */
const asS3 = (fake: Pick<FakeVersionedS3, "send">) => fake as unknown as Pick<S3Client, "send">;

const run = async (apply: boolean, queue = fakeSqs(), extra: Partial<CliOptions> = {}) => {
  const lines: string[] = [];
  const result = await runRepair({
    s3: asS3(mockS3),
    sqs: queue.sqs,
    config,
    options: options({ apply, ...extra }),
    log: (...args) => lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")),
    logError: silent,
    now: () => NOW,
  });
  return { ...result, output: lines.join("\n"), queue };
};

describe("repairHouseVoteCounts", () => {
  describe("parseArgs", () => {
    it("defaults to a dry run over every raw bill", () => {
      expect(parseArgs([])).toEqual({
        help: false,
        apply: false,
        guids: [],
        maxItems: null,
        concurrency: 8,
        scanProcessed: false,
      });
      expect(USAGE).toContain("npm run repair:house-vote-counts");
    });

    it("reads every flag and normalizes repeated guids to plain guids", () => {
      expect(
        parseArgs([
          "--apply",
          "--guid",
          "BILLS-119hr8800eh",
          "--guid",
          "BILLS-119hr8800",
          "--guid",
          "BILLS-119hr227",
          "--max-items",
          "50",
          "--concurrency",
          "4",
          "--scan-processed",
        ]),
      ).toEqual({
        help: false,
        apply: true,
        guids: ["BILLS-119hr8800", "BILLS-119hr227"],
        maxItems: 50,
        concurrency: 4,
        scanProcessed: true,
      });
      expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
      expect(parseArgs(["-h"]).help).toBe(true);
    });

    it("rejects unknown flags and bad values", () => {
      expect(() => parseArgs(["--force"])).toThrow("Unknown argument: --force");
      expect(() => parseArgs(["--guid"])).toThrow("--guid needs a bill guid");
      expect(() => parseArgs(["--guid", "hr8800"])).toThrow("--guid needs a bill guid");
      expect(() => parseArgs(["--guid", "--apply"])).toThrow("--guid needs a bill guid");
      expect(() => parseArgs(["--concurrency", "26"])).toThrow("--concurrency needs a whole number from 1 to 25");
      expect(() => parseArgs(["--max-items", "0"])).toThrow("--max-items needs a whole number");
    });
  });

  it("reads its configuration from the environment", () => {
    expect(configFromEnv({})).toEqual({
      region: "us-east-1",
      bucket: "billboard-bill-store-bucket",
      rawPrefix: "raw-bills/",
      processedPrefix: "processed-bills/",
      billDifferQueueUrl: "",
      billDifferQueueName: "BillDifferQueue",
    });
    expect(
      configFromEnv({ BUCKET_NAME: "b", BILL_DIFFER_QUEUE_URL: QUEUE_URL, AWS_DEFAULT_REGION: "us-west-2" }),
    ).toMatchObject({
      bucket: "b",
      billDifferQueueUrl: QUEUE_URL,
      region: "us-west-2",
    });
  });

  describe("selection (pure)", () => {
    it("plans a House chamber whose figures differ from its rows' count, changing only those figures", () => {
      const plan = planRawBillRepair(hr8800(), RAW("BILLS-119hr8800"), "BILLS-119hr8800")!;

      expect(plan).toMatchObject({
        guid: "BILLS-119hr8800",
        yea: 2,
        nay: 1,
        before: { present: 0, notVoting: 0, totalCounted: 3 },
        after: { present: 0, notVoting: 2, totalCounted: 5 },
      });
      const stored = hr8800().content.officialVotes!;
      expect(plan.nextOfficialVotes).toEqual({
        ...stored,
        house: { ...stored.house, notVoting: 2, totalCounted: 5 },
      });
    });

    it("counts a repeated row once, and a hidden Present row", () => {
      expect(planRawBillRepair(hr227(), "k", "BILLS-119hr227")).toMatchObject({
        before: { present: 0, notVoting: 0, totalCounted: 3 },
        after: { present: 1, notVoting: 1, totalCounted: 5 },
      });
    });

    it("leaves rows whose Yea or Nay differ from the stored tally, figures that already match, and chambers without rows", () => {
      expect(checkHouseChamber(mismatched().content.officialVotes)).toMatchObject({
        status: "mismatch",
        yea: 220,
        nay: 210,
      });
      expect(planRawBillRepair(mismatched(), "k", "BILLS-119hr10")).toBeNull();
      expect(checkHouseChamber(matching().content.officialVotes).status).toBe("matches");
      expect(planRawBillRepair(matching(), "k", "BILLS-119hr11")).toBeNull();
      for (const bill of [noRows(), senateOnly(), unusable(), rawBill("15", undefined)]) {
        expect(planRawBillRepair(bill, "k", bill.metadata.guid)).toBeNull();
      }
      expect(checkHouseChamber(noRows().content.officialVotes).status).toBe("no-member-rows");
      expect(checkHouseChamber({ house: { yea: "2", nay: 1, members: HR8800_ROWS } }).status).toBe("no-member-rows");
      expect(planRawBillRepair(null, "k", "BILLS-119hr16")).toBeNull();
    });
  });

  describe("scanRawBills (read-only)", () => {
    it("reports the affected bills with their processed state, and the mismatched ones, writing nothing", async () => {
      seedBucket();
      mockS3.put(
        PROCESSED("BILLS-119hr99"),
        processedOf(rawBill("99", officialVotes(houseChamber(2, 1, HR8800_ROWS)))),
      );

      const result = await scanRawBills(asS3(mockS3), config, { concurrency: 2, scanProcessed: true, log: silent });

      expect(result).toMatchObject({
        scanned: 7,
        missing: [],
        unreadable: [],
        withHouseMembers: 4,
        alreadyMatching: 1,
        presentChanged: 1,
        notVotingChanged: 2,
        mismatched: ["BILLS-119hr10"],
        stranded: [],
        // hr99 has no raw bill; hr14's raw votes are not the pipeline's, so billDiffer would not copy them.
        processedOnly: ["BILLS-119hr14", "BILLS-119hr99"],
      });
      expect(result.affected.map((bill) => [bill.guid, bill.processed])).toEqual([
        ["BILLS-119hr227", "shows-old-figures"],
        ["BILLS-119hr8800", "shows-old-figures"],
      ]);
      expect(s3Writes()).toEqual([]);
    });

    it("reads only the --guid bills, and reports a guid with no raw bill", async () => {
      seedBucket();

      const result = await scanRawBills(asS3(mockS3), config, {
        guids: ["BILLS-119hr8800", "BILLS-119hr404"],
        log: silent,
      });

      expect(mockS3.commands("ListObjectsV2")).toEqual([]);
      expect(result.scanned).toBe(2);
      expect(result.missing).toEqual(["BILLS-119hr404"]);
      expect(result.affected.map((bill) => bill.guid)).toEqual(["BILLS-119hr8800"]);
      expect(result.processedOnly).toBeNull();
    });
  });

  describe("runRepair", () => {
    it("makes no writes, sends nothing and resolves no queue in a dry run, and prints counts and bill ids only", async () => {
      seedBucket();

      const { scan, summary, output, queue } = await run(false);

      expect(summary).toBeUndefined();
      expect(scan.affected).toHaveLength(2);
      expect(s3Writes()).toEqual([]);
      expect(new Set(mockS3.calls.map((call) => call.__cmd))).toEqual(new Set(["ListObjectsV2", "GetObject"]));
      expect(queue.commands).toEqual([]);
      expect(output).toContain("with-house-member-rows=4 already-matching=1");
      expect(output).toContain("affected bills=2 present-changed=1 not-voting-changed=2 mismatched=1");
      expect(output).toContain(
        "  BILLS-119hr8800 house 2-1 present 0->0 not-voting 0->2 total 3->5 processed=shows-old-figures",
      );
      expect(output).toContain(
        "mismatched: member rows whose Yea or Nay differ from the stored tally (left as they are): 1 BILLS-119hr10",
      );
      expect(output).toContain("Dry run: would rewrite 2 raw bills and send their guids to BillDifferQueue.");
      expect(output).not.toMatch(/Member |A1|C1/);
    });

    it("with --apply rewrites only the House figures, keeps the metadata, and hands each guid to BillDifferQueue", async () => {
      seedBucket();
      const before = {
        hr8800: raw("BILLS-119hr8800"),
        mismatched: raw("BILLS-119hr10"),
        matching: raw("BILLS-119hr11"),
      };
      const etagRead = mockS3.current(RAW("BILLS-119hr8800"))!.etag;

      const { summary, queue } = await run(true);

      expect(queue.commands[0]).toBe("GetQueueUrlCommand");
      expect(summary).toEqual({
        attempted: 2,
        repaired: 2,
        alreadyClean: 0,
        changedConcurrently: 0,
        missing: 0,
        failed: 0,
        enqueued: 2,
        notSentNoProcessed: 0,
        resent: 0,
        enqueueFailed: [],
      });

      const house = before.hr8800.content.officialVotes!.house;
      expect(raw("BILLS-119hr8800")).toEqual({
        ...before.hr8800,
        content: {
          ...before.hr8800.content,
          officialVotes: { ...before.hr8800.content.officialVotes, house: { ...house, notVoting: 2, totalCounted: 5 } },
        },
      });
      expect(raw("BILLS-119hr227").content.officialVotes!.house).toMatchObject({
        present: 1,
        notVoting: 1,
        totalCounted: 5,
      });
      expect(raw("BILLS-119hr10")).toEqual(before.mismatched);
      expect(raw("BILLS-119hr11")).toEqual(before.matching);
      expect(mockS3.contentVersions(RAW("BILLS-119hr10"))).toHaveLength(1);

      const put = s3Writes().find((call) => call.input.Key === RAW("BILLS-119hr8800"))!;
      expect(put.input.IfMatch).toBe(etagRead);
      expect(put.input.ContentType).toBe("application/json");
      expect(put.input.Metadata).toEqual({
        "correlation-id": "house-counts-repair:2026-10-31T12:00:00.000Z:BILLS-119hr8800",
        "source-x": "kept",
      });
      expect(
        s3Writes()
          .map((call) => call.input.Key)
          .sort(),
      ).toEqual([RAW("BILLS-119hr227"), RAW("BILLS-119hr8800")]);
      expect(
        queue.sent.map((input) => [
          input.QueueUrl,
          JSON.parse(input.MessageBody!),
          input.MessageAttributes!.correlationId.StringValue,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [QUEUE_URL, { guid: "BILLS-119hr8800" }, "house-counts-repair:2026-10-31T12:00:00.000Z:BILLS-119hr8800"],
          [QUEUE_URL, { guid: "BILLS-119hr227" }, "house-counts-repair:2026-10-31T12:00:00.000Z:BILLS-119hr227"],
        ]),
      );
      expect(queue.sent).toHaveLength(2);
    });

    it("is idempotent: a second --apply writes and sends nothing, and the dry run then finds none", async () => {
      seedBucket();
      await run(true);
      // billDiffer patched the processed bills from the rewritten raw bills.
      for (const guid of ["BILLS-119hr8800", "BILLS-119hr227"]) {
        mockS3.put(PROCESSED(guid), {
          ...mockS3.json<Record<string, unknown>>(PROCESSED(guid)),
          officialVotes: raw(guid).content.officialVotes,
        });
      }
      const writes = s3Writes().length;

      const again = await run(true);
      expect(again.scan).toMatchObject({ affected: [], stranded: [], alreadyMatching: 3 });
      expect(again.summary).toMatchObject({ attempted: 0, repaired: 0, enqueued: 0, resent: 0 });
      expect(again.queue.sent).toEqual([]);
      expect(s3Writes()).toHaveLength(writes);

      const dryRun = await run(false, fakeSqs(), { scanProcessed: true });
      expect(dryRun.output).toContain("affected bills=0");
      expect(dryRun.output).not.toContain("stranded:");
      expect(dryRun.scan.processedOnly).toEqual(["BILLS-119hr14"]);
    });

    it("lists a bill rewritten but never sent as stranded, and --apply sends it again", async () => {
      seedBucket([hr8800()]);
      const failed = await run(true, fakeSqs({ failSend: true }));
      expect(failed.summary).toMatchObject({ repaired: 1, enqueued: 0, enqueueFailed: ["BILLS-119hr8800"] });

      const dryRun = await run(false);
      expect(dryRun.scan).toMatchObject({ affected: [], stranded: ["BILLS-119hr8800"] });
      expect(dryRun.output).toContain("stranded: rewritten by an earlier --apply");
      expect(dryRun.output).toContain("re-send 1 stranded ones");

      const writes = s3Writes().length;
      const resend = await run(true);
      expect(resend.summary).toMatchObject({ attempted: 0, resent: 1, enqueueFailed: [] });
      expect(sentGuids(resend.queue.sent)).toEqual(["BILLS-119hr8800"]);
      expect(s3Writes()).toHaveLength(writes);
    });

    it("rewrites a bill with no processed copy yet without sending it to BillDifferQueue", async () => {
      seedBucket([hr8800(), hr227()]);
      mockS3.deleteObject(PROCESSED("BILLS-119hr227"));

      const dryRun = await run(false);
      expect(dryRun.output).toContain("Dry run: would rewrite 2 raw bills (1 without a processed bill, not sent)");

      const { summary, queue } = await run(true);
      expect(summary).toMatchObject({ repaired: 2, enqueued: 1, notSentNoProcessed: 1 });
      expect(sentGuids(queue.sent)).toEqual(["BILLS-119hr8800"]);
      expect(raw("BILLS-119hr227").content.officialVotes!.house).toMatchObject({ present: 1, notVoting: 1 });
      // hr8800 waits for billDiffer (not run here); hr227, never sent, is not stranded.
      expect((await run(false)).scan).toMatchObject({ affected: [], stranded: ["BILLS-119hr8800"] });
    });

    it("uses BILL_DIFFER_QUEUE_URL without looking the queue up", async () => {
      seedBucket([hr8800()]);
      const queue = fakeSqs();
      await runRepair({
        s3: asS3(mockS3),
        sqs: queue.sqs,
        config: { ...config, billDifferQueueUrl: "https://example.test/queue" },
        options: options({ apply: true }),
        log: silent,
        now: () => NOW,
      });
      expect(queue.commands).toEqual(["SendMessageCommand"]);
      expect(queue.sent[0].QueueUrl).toBe("https://example.test/queue");
    });
  });

  describe("applyRepairs", () => {
    const bills = [{ guid: "BILLS-119hr8800", key: RAW("BILLS-119hr8800") }];

    it("skips a bill that changed after it was read, and sends nothing for it", async () => {
      seedBucket([hr8800()]);
      mockS3.beforePut(RAW("BILLS-119hr8800"), (key) => {
        mockS3.put(key, { ...hr8800(), storedAt: "2026-10-31T11:59:00.000Z" });
      });
      const queue = fakeSqs();

      const summary = await applyRepairs(asS3(mockS3), queue.sqs, config, QUEUE_URL, bills, { log: silent });

      expect(summary).toMatchObject({ repaired: 0, changedConcurrently: 1, enqueued: 0 });
      expect(raw("BILLS-119hr8800").content.officialVotes!.house!.notVoting).toBe(0);
      expect(queue.sent).toEqual([]);
    });

    it("sends on a rewrite that S3 stored although it refused the PUT's retry", async () => {
      seedBucket([hr8800()]);
      const s3 = {
        send: async (command: FakeS3Command) => {
          const result = await mockS3.send(command);
          if (command.__cmd === "PutObject") throw preconditionFailed();
          return result;
        },
      };
      const queue = fakeSqs();

      const summary = await applyRepairs(asS3(s3), queue.sqs, config, QUEUE_URL, bills, {
        log: silent,
        now: () => NOW,
      });

      expect(summary).toMatchObject({ repaired: 1, changedConcurrently: 0, enqueued: 1 });
      expect(raw("BILLS-119hr8800").content.officialVotes!.house!.notVoting).toBe(2);
      expect(sentGuids(queue.sent)).toEqual(["BILLS-119hr8800"]);
    });

    it("leaves a bill that is already right or gone, and counts other errors as failed", async () => {
      seedBucket([matching()]);
      const queue = fakeSqs();
      const summary = await applyRepairs(
        asS3(mockS3),
        queue.sqs,
        config,
        QUEUE_URL,
        [{ guid: "BILLS-119hr11", key: RAW("BILLS-119hr11") }, ...bills],
        { log: silent },
      );
      expect(summary).toMatchObject({ attempted: 2, alreadyClean: 1, missing: 1, repaired: 0 });
      expect(s3Writes()).toEqual([]);
      expect(queue.sent).toEqual([]);

      seedBucket([hr8800()]);
      mockS3.injectPutError(RAW("BILLS-119hr8800"), 403);
      const failed = await applyRepairs(asS3(mockS3), fakeSqs().sqs, config, QUEUE_URL, bills, {
        log: silent,
        logError: silent,
      });
      expect(failed).toMatchObject({ failed: 1, repaired: 0, enqueued: 0 });
    });
  });
});
