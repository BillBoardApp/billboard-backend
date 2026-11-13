import {
  applyRepairs,
  configFromEnv,
  isRejectedTally,
  legacyParseYeaNay,
  parseArgs,
  planRawBillRepair,
  processedShowsRejectedTally,
  runRepair,
  scanRawBills,
  type CliOptions,
  type RepairConfig,
} from "../../scripts/repairOfficialVoteTallies";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient, SendMessageCommandInput } from "@aws-sdk/client-sqs";

const config: RepairConfig = configFromEnv({});
const NOW = new Date("2026-09-25T12:00:00.000Z");
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/BillDifferQueue";

const CR_HOUSE_TEXT = "Passed/agreed to in House: On passage Passed without objection. (text: CR H4758-4759)";
const CR_SENATE_TEXT =
  "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent. (consideration: CR S2747-2748; text: CR S2748)";
const REAL_HOUSE_TEXT =
  "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 231 - 196, 2 Present (Roll no. 58).";

const chamberVote = (yea: number, nay: number, resultText: string, extra: Record<string, unknown> = {}) => ({
  yea,
  nay,
  present: 0,
  notVoting: 0,
  totalCounted: yea + nay,
  actionCode: "8000",
  actionDate: "2025-11-18",
  resultText,
  memberDataAvailable: false,
  members: [],
  ...extra,
});

const senateMembers = [
  { bioguideId: "S000001", displayName: "Senator One", votePosition: "Yea" },
  { bioguideId: "S000002", displayName: "Senator Two", votePosition: "Nay" },
];

const rawBill = (guid: string, actions: unknown[], officialVotes?: Record<string, unknown>) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2025-11-19T00:00:00.000Z",
  identifier: { congress: "119", billType: "hjres", billNumber: "133" },
  metadata: { guid: `${guid}eh`, title: "A title", fetchedAt: "2025-11-19T00:00:00.000Z" },
  content: {
    bill: { title: "A title" },
    billXML: "<bill/>",
    actions: { actions },
    ...(officialVotes ? { officialVotes } : {}),
  },
});

/** hjres133 as stored: a House "vote" of 4758-4759 read from a Record page range. */
const hjres133 = () =>
  rawBill("BILLS-119hjres133", [{ actionCode: "8000", actionDate: "2025-11-18", text: CR_HOUSE_TEXT }], {
    house: chamberVote(4758, 4759, CR_HOUSE_TEXT),
    lastSyncedAt: "2025-11-19T00:00:00.000Z",
    source: "congress_api",
    completeness: "partial",
  });

/** hr5334 as stored: a bogus House tally next to a real Senate vote counted from the roll-call XML. */
const hr5334 = () =>
  rawBill(
    "BILLS-119hr5334",
    [
      {
        actionCode: "8000",
        actionDate: "2026-04-27",
        text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H3111-3112)",
      },
    ],
    {
      house: chamberVote(
        3111,
        3112,
        "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H3111-3112)",
      ),
      senate: chamberVote(86, 11, "Bill Passed (86-11)", {
        actionCode: "17000",
        actionDate: "2026-08-07T12:43:00.000Z",
        present: 0,
        notVoting: 3,
        totalCounted: 100,
        memberDataAvailable: true,
        members: senateMembers,
      }),
      lastSyncedAt: "2026-08-07T13:00:00.000Z",
      source: "congress_api",
      completeness: "partial",
    },
  );

/** A bill whose latest House action cites Record pages but whose earlier House vote is real. */
const withEarlierRealVote = () =>
  rawBill(
    "BILLS-119hr900",
    [
      { actionCode: "8000", actionDate: "2026-01-20", text: REAL_HOUSE_TEXT },
      { actionCode: "8000", actionDate: "2026-04-27", text: CR_HOUSE_TEXT },
    ],
    {
      house: chamberVote(4758, 4759, CR_HOUSE_TEXT),
      lastSyncedAt: "x",
      source: "congress_api",
      completeness: "partial",
    },
  );

const cleanBill = () =>
  rawBill("BILLS-119hr1", [{ actionCode: "8000", actionDate: "2026-01-20", text: REAL_HOUSE_TEXT }], {
    house: chamberVote(231, 196, REAL_HOUSE_TEXT),
    lastSyncedAt: "x",
    source: "congress_api",
    completeness: "partial",
  });

/** The input fields the fake bucket reads. */
interface FakeS3Input {
  Prefix?: string;
  ContinuationToken?: string;
  Key?: string;
  IfMatch?: string;
  Body?: string;
  Metadata?: Record<string, string>;
  ContentType?: string;
}
interface FakeS3Command {
  constructor: { name: string };
  input: FakeS3Input;
}
interface FakeSqsCommand {
  constructor: { name: string };
  input: SendMessageCommandInput;
}

interface FakeObject {
  body: string;
  etag: string;
  metadata?: Record<string, string>;
}

/** The bucket in memory: paged listing (2 keys a page), NoSuchKey, and PutObject honouring IfMatch. */
const fakeS3 = (objects: Record<string, unknown>) => {
  const store = new Map<string, FakeObject>();
  let etagCounter = 0;
  const nextEtag = () => `"etag-${(etagCounter += 1)}"`;
  for (const [key, value] of Object.entries(objects)) {
    store.set(key, { body: typeof value === "string" ? value : JSON.stringify(value), etag: nextEtag() });
  }
  const commands: string[] = [];
  const puts: FakeS3Input[] = [];
  let beforePut: ((input: FakeS3Input) => void) | undefined;
  const send = jest.fn(async (command: FakeS3Command) => {
    const name: string = command.constructor.name;
    const input = command.input;
    commands.push(name);
    if (name === "ListObjectsV2Command") {
      const all = [...store.keys()].filter((key) => key.startsWith(input.Prefix!)).sort();
      const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
      return {
        Contents: all.slice(start, start + 2).map((Key) => ({ Key })),
        ...(start + 2 < all.length ? { NextContinuationToken: String(start + 2) } : {}),
      };
    }
    if (name === "GetObjectCommand") {
      const object = store.get(input.Key!);
      if (!object) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      return {
        Body: { transformToString: async () => object.body },
        ETag: object.etag,
        Metadata: object.metadata ?? { "correlation-id": "old" },
      };
    }
    if (name === "PutObjectCommand") {
      beforePut?.(input);
      const current = store.get(input.Key!);
      if (input.IfMatch && current?.etag !== input.IfMatch) {
        throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      }
      puts.push(input);
      store.set(input.Key!, { body: input.Body!, etag: nextEtag(), metadata: input.Metadata });
      return {};
    }
    throw new Error(`Unexpected S3 command ${name}`);
  });
  return {
    s3: { send } as unknown as Pick<S3Client, "send"> & { send: typeof send },
    store,
    commands,
    puts,
    json: (key: string) => JSON.parse(store.get(key)!.body) as ReturnType<typeof rawBill>,
    onPut: (hook: (input: FakeS3Input) => void) => {
      beforePut = hook;
    },
    touch: (key: string) => {
      store.get(key)!.etag = nextEtag();
    },
  };
};

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
      return { MessageId: "m-1" };
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

describe("repairOfficialVoteTallies", () => {
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
    });

    it("reads every flag and normalizes repeated guids to plain guids", () => {
      expect(
        parseArgs([
          "--apply",
          "--guid",
          "BILLS-119hjres133eh",
          "--guid",
          "BILLS-119s423",
          "--guid",
          "BILLS-119hjres133",
          "--max-items",
          "50",
          "--concurrency",
          "4",
          "--scan-processed",
        ]),
      ).toEqual({
        help: false,
        apply: true,
        guids: ["BILLS-119hjres133", "BILLS-119s423"],
        maxItems: 50,
        concurrency: 4,
        scanProcessed: true,
      });
      expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
      expect(parseArgs(["-h"]).help).toBe(true);
    });

    it("rejects unknown flags and bad values", () => {
      expect(() => parseArgs(["--publish"])).toThrow("Unknown argument: --publish");
      expect(() => parseArgs(["--guid"])).toThrow("--guid needs a bill guid");
      expect(() => parseArgs(["--guid", "hr1"])).toThrow("--guid needs a bill guid");
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
      configFromEnv({ BILL_STORE_BUCKET: "b", BILL_DIFFER_QUEUE_URL: QUEUE_URL, AWS_REGION: "us-west-2" }),
    ).toMatchObject({ bucket: "b", billDifferQueueUrl: QUEUE_URL, region: "us-west-2" });
  });

  describe("classification", () => {
    it("recognises the tallies the old parser produced", () => {
      expect(legacyParseYeaNay(CR_HOUSE_TEXT)).toEqual({ yea: 4758, nay: 4759 });
      expect(legacyParseYeaNay(REAL_HOUSE_TEXT)).toEqual({ yea: 231, nay: 196 });
      expect(legacyParseYeaNay("Passed Senate without amendment by Unanimous Consent.")).toBeNull();
    });

    it("flags only a stored tally the old parser read from its text and the fixed parser rejects", () => {
      expect(isRejectedTally(chamberVote(4758, 4759, CR_HOUSE_TEXT), "house")).toBe(true);
      expect(isRejectedTally(chamberVote(74, 75, "Agreed to without objection. (text: CR H74-75)"), "house")).toBe(
        true,
      );
      expect(isRejectedTally(chamberVote(2747, 2748, CR_SENATE_TEXT), "senate")).toBe(true);
      // A real tally, a count taken from the Senate XML, and anything malformed are left alone.
      expect(isRejectedTally(chamberVote(231, 196, REAL_HOUSE_TEXT), "house")).toBe(false);
      expect(isRejectedTally(chamberVote(0, 0, "Bill Passed (86-11)"), "senate")).toBe(false);
      expect(isRejectedTally(chamberVote(86, 11, "Bill Passed (86-11)"), "senate")).toBe(false);
      expect(isRejectedTally({ yea: "4758", nay: 4759, resultText: CR_HOUSE_TEXT }, "house")).toBe(false);
      expect(isRejectedTally(undefined, "house")).toBe(false);
    });

    it("removes officialVotes when the rejected chamber was the only one", () => {
      const plan = planRawBillRepair(hjres133(), "raw-bills/BILLS-119hjres133.json", "BILLS-119hjres133", NOW);
      expect(plan).toEqual({
        guid: "BILLS-119hjres133",
        key: "raw-bills/BILLS-119hjres133.json",
        findings: [
          {
            chamber: "house",
            before: { yea: 4758, nay: 4759, actionDate: "2025-11-18", resultText: CR_HOUSE_TEXT },
            after: null,
            manualReview: false,
          },
        ],
        repairable: true,
        nextOfficialVotes: undefined,
      });
    });

    it("keeps a real chamber vote, with its members, next to the removed one", () => {
      const plan = planRawBillRepair(hr5334(), "raw-bills/BILLS-119hr5334.json", "BILLS-119hr5334", NOW)!;
      expect(plan.findings.map((finding) => [finding.chamber, finding.after])).toEqual([["house", null]]);
      expect(plan.nextOfficialVotes).toEqual({
        senate: hr5334().content.officialVotes!.senate,
        lastSyncedAt: NOW.toISOString(),
        source: "congress_api",
        completeness: "complete",
      });
    });

    it("replaces the rejected tally with an earlier real one when the actions have it", () => {
      const plan = planRawBillRepair(withEarlierRealVote(), "k", "BILLS-119hr900", NOW)!;
      expect(plan.findings[0].after).toEqual({
        yea: 231,
        nay: 196,
        actionDate: "2026-01-20",
        resultText: REAL_HOUSE_TEXT,
      });
      expect(plan.nextOfficialVotes).toMatchObject({
        house: { yea: 231, nay: 196, totalCounted: 427, actionDate: "2026-01-20", members: [] },
        lastSyncedAt: NOW.toISOString(),
        completeness: "partial",
      });
    });

    it("reports a rejected tally that carries member votes for a manual look without rewriting it", () => {
      const bill = hjres133();
      Object.assign(bill.content.officialVotes!.house as Record<string, unknown>, {
        memberDataAvailable: true,
        members: senateMembers,
      });
      const plan = planRawBillRepair(bill, "k", "BILLS-119hjres133", NOW)!;
      expect(plan.repairable).toBe(false);
      expect(plan.findings[0].manualReview).toBe(true);
      expect(plan.nextOfficialVotes).toBe(bill.content.officialVotes);
    });

    it("needs no repair for clean bills or bills without officialVotes", () => {
      expect(planRawBillRepair(cleanBill(), "k", "BILLS-119hr1", NOW)).toBeNull();
      expect(planRawBillRepair(rawBill("BILLS-119hr2", []), "k", "BILLS-119hr2", NOW)).toBeNull();
      expect(planRawBillRepair(null, "k", "BILLS-119hr3", NOW)).toBeNull();
    });

    it("tells whether the processed bill still shows the old tally", () => {
      const findings = planRawBillRepair(hjres133(), "k", "BILLS-119hjres133", NOW)!.findings;
      expect(processedShowsRejectedTally({ officialVotes: hjres133().content.officialVotes }, findings)).toBe(true);
      expect(processedShowsRejectedTally({ officialVotes: { house: { yea: 1, nay: 2 } } }, findings)).toBe(false);
      expect(processedShowsRejectedTally({}, findings)).toBe(false);
    });
  });

  describe("scanRawBills (read-only)", () => {
    const bucket = () =>
      fakeS3({
        "raw-bills/BILLS-119hjres133.json": hjres133(),
        "raw-bills/BILLS-119hr1.json": cleanBill(),
        "raw-bills/BILLS-119hr5334.json": hr5334(),
        "raw-bills/BILLS-119hr7.json": "{not json",
        "raw-bills/BILLS-119hr8.txt": "ignored",
        "processed-bills/BILLS-119hjres133.json": {
          guid: "BILLS-119hjres133",
          officialVotes: hjres133().content.officialVotes,
        },
        "processed-bills/BILLS-119hr1.json": { guid: "BILLS-119hr1", officialVotes: cleanBill().content.officialVotes },
        "processed-bills/BILLS-119hr9.json": { guid: "BILLS-119hr9", officialVotes: hjres133().content.officialVotes },
      });

    it("lists every raw bill across pages and reports the affected ones with their processed state", async () => {
      const fake = bucket();
      const result = await scanRawBills(fake.s3, config, {
        concurrency: 2,
        log: silent,
        now: NOW,
        scanProcessed: true,
      });

      expect(result).toMatchObject({
        scanned: 4,
        missing: [],
        unreadable: ["BILLS-119hr7"],
        withOfficialVotes: 3,
        chambers: { house: 2, senate: 0 },
        manualReview: 0,
        processedOnly: ["BILLS-119hr9"],
      });
      expect(result.affected.map((bill) => [bill.guid, bill.processed])).toEqual([
        ["BILLS-119hjres133", "shows-rejected-tally"],
        ["BILLS-119hr5334", "missing"],
      ]);
      expect(fake.commands.filter((name) => name === "PutObjectCommand")).toEqual([]);
    });

    it("reads only the --guid bills, and reports a guid with no raw bill", async () => {
      const fake = bucket();
      const result = await scanRawBills(fake.s3, config, {
        guids: ["BILLS-119hjres133", "BILLS-119hr404"],
        log: silent,
        now: NOW,
      });

      expect(fake.commands).not.toContain("ListObjectsV2Command");
      expect(result.scanned).toBe(2);
      expect(result.missing).toEqual(["BILLS-119hr404"]);
      expect(result.affected.map((bill) => bill.guid)).toEqual(["BILLS-119hjres133"]);
      expect(result.processedOnly).toBeNull();
    });

    it("stops after --max-items raw bills", async () => {
      const result = await scanRawBills(bucket().s3, config, { maxItems: 1, log: silent, now: NOW });
      expect(result.scanned).toBe(1);
      expect(result.affected.map((bill) => bill.guid)).toEqual(["BILLS-119hjres133"]);
    });
  });

  describe("runRepair", () => {
    it("makes no writes, sends nothing and resolves no queue in a dry run", async () => {
      const fake = fakeS3({ "raw-bills/BILLS-119hjres133.json": hjres133() });
      const queue = fakeSqs();
      const lines: string[] = [];
      const { scan, summary } = await runRepair({
        s3: fake.s3,
        sqs: queue.sqs,
        config,
        options: options(),
        log: (...args) => lines.push(args.map(String).join(" ")),
        now: () => NOW,
      });

      expect(summary).toBeUndefined();
      expect(scan.affected).toHaveLength(1);
      expect(new Set(fake.commands)).toEqual(new Set(["ListObjectsV2Command", "GetObjectCommand"]));
      expect(queue.commands).toEqual([]);
      expect(lines.join("\n")).toContain(
        `BILLS-119hjres133 house 4758-4759 (2025-11-18) -> none processed=missing text=${JSON.stringify(CR_HOUSE_TEXT)}`,
      );
      expect(lines.join("\n")).toContain("affected bills=1 chambers: house=1 senate=0 manual-review=0");
      expect(lines.join("\n")).toContain("Dry run: would rewrite 1 raw bills");
    });

    it("with --apply rewrites only officialVotes and hands each guid to BillDifferQueue", async () => {
      const fake = fakeS3({
        "raw-bills/BILLS-119hjres133.json": hjres133(),
        "raw-bills/BILLS-119hr5334.json": hr5334(),
        "raw-bills/BILLS-119hr1.json": cleanBill(),
      });
      const queue = fakeSqs();
      const { summary } = await runRepair({
        s3: fake.s3,
        sqs: queue.sqs,
        config,
        options: options({ apply: true }),
        log: silent,
        now: () => NOW,
      });

      expect(queue.commands[0]).toBe("GetQueueUrlCommand");
      expect(summary).toEqual({
        attempted: 2,
        repaired: 2,
        alreadyClean: 0,
        changedConcurrently: 0,
        missing: 0,
        failed: 0,
        enqueued: 2,
        resent: 0,
        enqueueFailed: [],
      });

      // Everything but officialVotes is unchanged, so billDiffer patches without Bedrock.
      const { officialVotes: _removed, ...hjresContent } = hjres133().content;
      expect(fake.json("raw-bills/BILLS-119hjres133.json")).toEqual({ ...hjres133(), content: hjresContent });
      const repairedHr = fake.json("raw-bills/BILLS-119hr5334.json");
      expect(repairedHr.content.officialVotes!.house).toBeUndefined();
      expect(repairedHr.content.officialVotes!.senate).toEqual(hr5334().content.officialVotes!.senate);
      expect(repairedHr.metadata).toEqual(hr5334().metadata);
      expect(fake.json("raw-bills/BILLS-119hr1.json")).toEqual(cleanBill());

      for (const put of fake.puts) {
        expect(put.IfMatch).toMatch(/^"etag-\d+"$/);
        expect(put.ContentType).toBe("application/json");
        expect(put.Metadata!["correlation-id"]).toMatch(/^rel31-repair:2026-09-25T12:00:00.000Z:BILLS-119/);
      }
      expect(
        queue.sent.map((input) => [
          input.QueueUrl,
          JSON.parse(input.MessageBody!),
          input.MessageAttributes!.correlationId.StringValue,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [QUEUE_URL, { guid: "BILLS-119hjres133" }, "rel31-repair:2026-09-25T12:00:00.000Z:BILLS-119hjres133"],
          [QUEUE_URL, { guid: "BILLS-119hr5334" }, "rel31-repair:2026-09-25T12:00:00.000Z:BILLS-119hr5334"],
        ]),
      );
      expect(queue.sent).toHaveLength(2);
    });

    describe("a bill an earlier --apply rewrote but never handed to billDiffer (stranded)", () => {
      const RAW_KEY = "raw-bills/BILLS-119hjres133.json";
      const PROCESSED_KEY = "processed-bills/BILLS-119hjres133.json";
      const repairedRaw = () => {
        const { officialVotes: _removed, ...content } = hjres133().content;
        return { ...hjres133(), content };
      };
      const bucketAfterInterruptedRun = (processedVotes = hjres133().content.officialVotes) => {
        const fake = fakeS3({
          [RAW_KEY]: repairedRaw(),
          [PROCESSED_KEY]: { guid: "BILLS-119hjres133", officialVotes: processedVotes },
        });
        fake.store.get(RAW_KEY)!.metadata = {
          "correlation-id": "rel31-repair:2026-09-24T09:00:00.000Z:BILLS-119hjres133",
        };
        return fake;
      };

      it("is reported by a dry run and sent to BillDifferQueue again by --apply", async () => {
        const lines: string[] = [];
        const dryRun = await runRepair({
          s3: bucketAfterInterruptedRun().s3,
          sqs: fakeSqs().sqs,
          config,
          options: options({ scanProcessed: true }),
          log: (...args) => lines.push(args.map(String).join(" ")),
          now: () => NOW,
        });
        expect(dryRun.scan).toMatchObject({ affected: [], stranded: ["BILLS-119hjres133"], processedOnly: [] });
        expect(lines.join("\n")).toContain("stranded: rewritten by an earlier --apply");

        const fake = bucketAfterInterruptedRun();
        const queue = fakeSqs();
        const { summary } = await runRepair({
          s3: fake.s3,
          sqs: queue.sqs,
          config,
          options: options({ apply: true }),
          log: silent,
          now: () => NOW,
        });

        expect(summary).toMatchObject({ attempted: 0, resent: 1, enqueueFailed: [] });
        expect(fake.puts).toEqual([]);
        expect(
          queue.sent.map((input) => [
            JSON.parse(input.MessageBody!),
            input.MessageAttributes!.correlationId.StringValue,
          ]),
        ).toEqual([[{ guid: "BILLS-119hjres133" }, "rel31-repair:2026-09-25T12:00:00.000Z:BILLS-119hjres133"]]);
      });

      it("is not stranded once billDiffer patched the processed bill, nor when another writer cleaned the raw bill", async () => {
        const patched = bucketAfterInterruptedRun(cleanBill().content.officialVotes);
        const notOurs = bucketAfterInterruptedRun();
        notOurs.store.get(RAW_KEY)!.metadata = { "correlation-id": "fetch-raw-bill:abc" };

        for (const fake of [patched, notOurs]) {
          const queue = fakeSqs();
          const { scan, summary } = await runRepair({
            s3: fake.s3,
            sqs: queue.sqs,
            config,
            options: options({ apply: true }),
            log: silent,
            now: () => NOW,
          });
          expect(scan.stranded).toEqual([]);
          expect(summary).toMatchObject({ resent: 0 });
          expect(queue.sent).toEqual([]);
        }
      });
    });

    it("uses BILL_DIFFER_QUEUE_URL without looking the queue up", async () => {
      const fake = fakeS3({ "raw-bills/BILLS-119hjres133.json": hjres133() });
      const queue = fakeSqs();
      await runRepair({
        s3: fake.s3,
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
    const bills = [{ guid: "BILLS-119hjres133", key: "raw-bills/BILLS-119hjres133.json" }];

    it("skips a bill that changed after it was read, and sends nothing for it", async () => {
      const fake = fakeS3({ "raw-bills/BILLS-119hjres133.json": hjres133() });
      fake.onPut((input) => fake.touch(input.Key!));
      const queue = fakeSqs();
      const summary = await applyRepairs(fake.s3, queue.sqs, config, QUEUE_URL, bills, { log: silent });

      expect(summary).toMatchObject({ repaired: 0, changedConcurrently: 1, enqueued: 0 });
      expect(fake.json("raw-bills/BILLS-119hjres133.json")).toEqual(hjres133());
      expect(queue.sent).toEqual([]);
    });

    it("sends on a rewrite that S3 stored although it refused the PUT's retry", async () => {
      // The first attempt is committed but its answer is lost; the SDK's retry (same IfMatch) gets 412.
      const fake = fakeS3({ "raw-bills/BILLS-119hjres133.json": hjres133() });
      const stored = fake.s3.send.getMockImplementation()!;
      fake.s3.send.mockImplementation(async (command: FakeS3Command) => {
        const result = await stored(command);
        if (command.constructor.name !== "PutObjectCommand") return result;
        throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), {
          name: "PreconditionFailed",
          $metadata: { httpStatusCode: 412 },
        });
      });
      const queue = fakeSqs();

      const summary = await applyRepairs(fake.s3, queue.sqs, config, QUEUE_URL, bills, {
        log: silent,
        now: () => NOW,
      });

      expect(summary).toMatchObject({ repaired: 1, changedConcurrently: 0, enqueued: 1 });
      expect(fake.json("raw-bills/BILLS-119hjres133.json").content.officialVotes).toBeUndefined();
      expect(queue.sent.map((input) => JSON.parse(input.MessageBody!))).toEqual([{ guid: "BILLS-119hjres133" }]);
    });

    it("leaves a bill that is already clean or gone", async () => {
      const fake = fakeS3({ "raw-bills/BILLS-119hr1.json": cleanBill() });
      const queue = fakeSqs();
      const summary = await applyRepairs(
        fake.s3,
        queue.sqs,
        config,
        QUEUE_URL,
        [{ guid: "BILLS-119hr1", key: "raw-bills/BILLS-119hr1.json" }, ...bills],
        { log: silent },
      );

      expect(summary).toMatchObject({ attempted: 2, alreadyClean: 1, missing: 1, repaired: 0 });
      expect(fake.puts).toEqual([]);
      expect(queue.sent).toEqual([]);
    });

    it("lists a rewritten bill it could not enqueue, and counts other errors as failed", async () => {
      const fake = fakeS3({ "raw-bills/BILLS-119hjres133.json": hjres133() });
      const logError = jest.fn();
      const summary = await applyRepairs(fake.s3, fakeSqs({ failSend: true }).sqs, config, QUEUE_URL, bills, {
        log: silent,
        logError,
      });
      expect(summary).toMatchObject({ repaired: 1, enqueued: 0, enqueueFailed: ["BILLS-119hjres133"] });

      const broken = fakeS3({ "raw-bills/BILLS-119hjres133.json": hjres133() });
      broken.onPut(() => {
        throw new Error("AccessDenied");
      });
      const failed = await applyRepairs(broken.s3, fakeSqs().sqs, config, QUEUE_URL, bills, { log: silent, logError });
      expect(failed).toMatchObject({ failed: 1, repaired: 0, enqueued: 0 });
    });
  });
});
