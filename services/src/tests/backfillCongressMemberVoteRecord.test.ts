import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";

import {
  QUEUE_WAIT_LIMIT_MS,
  QUEUE_WAIT_MS,
  configFromEnv,
  memberRowsOf,
  parseArgs,
  runVoteRecordBackfill,
  type CliOptions,
} from "../../scripts/backfillCongressMemberVoteRecord";

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/CongressMemberStatsQueue";
const DLQ_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/CongressMemberStatsDLQ";

const votes = (...positions: string[]) => ({
  officialVotes: {
    house: {
      actionDate: "2026-02-01",
      members: positions.map((votePosition, index) => ({ bioguideId: `A00000${index}`, votePosition })),
    },
  },
});

/** processed-bills/ as a map of key to document; null is a body that does not parse. */
const BILLS: Record<string, unknown> = {
  "processed-bills/BILLS-119hr1.json": votes("Yea", "Nay", "Present", "Not Voting", "Unknown"),
  "processed-bills/BILLS-119hr2.json": { sponsors: [] }, // no official votes
  "processed-bills/BILLS-119hr3.json": votes("Unknown"), // no position the record keeps
  "processed-bills/BILLS-119s4.json": {
    officialVotes: { senate: { members: [{ bioguideId: "S123", vote: "nay" }] } },
  },
  "processed-bills/BILLS-120hr5.json": votes("Yea"),
  "processed-bills/BILLS-119hr6.json": null,
  "processed-bills/BILLS-119hr7/extra.json": votes("Yea"), // not a processed bill key
};

interface S3Command {
  constructor: { name: string };
  input: { Prefix?: string; Key?: string; ContinuationToken?: string };
}
const s3Client = (bills: Record<string, unknown> = BILLS) => {
  const send = jest.fn(async (command: S3Command) => {
    if (command.constructor.name === "ListObjectsV2Command") {
      const keys = Object.keys(bills).filter((key) => key.startsWith(command.input.Prefix ?? ""));
      // Two pages.
      const half = Math.ceil(keys.length / 2);
      return command.input.ContinuationToken
        ? { Contents: keys.slice(half).map((Key) => ({ Key })), IsTruncated: false }
        : { Contents: keys.slice(0, half).map((Key) => ({ Key })), IsTruncated: true, NextContinuationToken: "t" };
    }
    const value = bills[command.input.Key!];
    return { Body: { transformToString: async () => (value === null ? "{not json" : JSON.stringify(value)) } };
  });
  return { send } as unknown as Pick<S3Client, "send">;
};

interface SqsCommand {
  constructor: { name: string };
  input: {
    QueueName?: string;
    QueueUrl?: string;
    Entries?: Array<{ Id: string; MessageBody: string }>;
  };
}
/** depths: [queue, dlq] answers, in order, then the last ones again. */
const sqsClient = (options: { queueDepths?: number[]; dlqDepths?: number[]; failIds?: string[] } = {}) => {
  const sent: string[] = [];
  const queueDepths = [...(options.queueDepths ?? [0])];
  const dlqDepths = [...(options.dlqDepths ?? [0])];
  const next = (depths: number[]) => (depths.length > 1 ? depths.shift()! : depths[0]);
  const send = jest.fn(async (command: SqsCommand) => {
    const name = command.constructor.name;
    if (name === "GetQueueUrlCommand") {
      return { QueueUrl: command.input.QueueName === "CongressMemberStatsDLQ" ? DLQ_URL : QUEUE_URL };
    }
    if (name === "GetQueueAttributesCommand") {
      const depth = command.input.QueueUrl === DLQ_URL ? next(dlqDepths) : next(queueDepths);
      return { Attributes: { ApproximateNumberOfMessages: String(depth) } };
    }
    const failed = (command.input.Entries ?? []).filter((entry) => options.failIds?.includes(entry.Id));
    for (const entry of command.input.Entries ?? []) {
      if (failed.includes(entry)) continue;
      const key = JSON.parse(entry.MessageBody).Records[0].s3.object;
      expect(key).not.toHaveProperty("versionId"); // applied in full
      sent.push(key.key);
    }
    return { Failed: failed.map((entry) => ({ Id: entry.Id })) };
  });
  return { client: { send } as unknown as Pick<SQSClient, "send">, sent, send };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({
  ...parseArgs([]),
  ...overrides,
});

const run = async (cli: Partial<CliOptions>, sqs = sqsClient(), bills = BILLS) => {
  const lines: string[] = [];
  const sleep = jest.fn(async () => undefined);
  const result = await runVoteRecordBackfill({
    s3: s3Client(bills),
    sqs: sqs.client,
    config: configFromEnv({}),
    options: options(cli),
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    sleep,
  });
  return { result, lines, sqs, sleep };
};

describe("backfill:member-vote-record (UX-39d)", () => {
  it("parses its flags: --apply needs a canary or the dry run's count, never both", () => {
    expect(parseArgs([])).toMatchObject({ apply: false, canary: null, expectBills: null, rate: 2, maxQueue: 100 });
    expect(parseArgs(["--apply", "--canary", "5"])).toMatchObject({ apply: true, canary: 5 });
    expect(
      parseArgs(["--apply", "--expect-bills", "3", "--congress", "119", "--start-after", "BILLS-119hr1"]),
    ).toMatchObject({
      expectBills: 3,
      congress: 119,
      startAfter: "BILLS-119hr1",
    });
    expect(() => parseArgs(["--apply"])).toThrow("--apply needs --canary");
    expect(() => parseArgs(["--apply", "--canary", "1", "--expect-bills", "3"])).toThrow("separate runs");
    expect(() => parseArgs(["--start-after", "BILLS-119hr1ih"])).toThrow("plain bill guid");
    expect(() => parseArgs(["--rate", "21"])).toThrow("--rate needs a whole number from 1 to 20");
  });

  it("counts the member rows a bill gives the record: the four positions Congress records", () => {
    expect(memberRowsOf(BILLS["processed-bills/BILLS-119hr1.json"])).toBe(4);
    expect(memberRowsOf(BILLS["processed-bills/BILLS-119hr3.json"])).toBe(0);
    expect(memberRowsOf(BILLS["processed-bills/BILLS-119s4.json"])).toBe(1);
    expect(memberRowsOf(null)).toBe(0);
  });

  it("dry run: counts and sends nothing", async () => {
    const { result, lines, sqs } = await run({});

    expect(result.scan.candidates.map((candidate) => candidate.guid)).toEqual([
      "BILLS-119hr1",
      "BILLS-119s4",
      "BILLS-120hr5",
    ]);
    expect(lines).toContain("bills with member votes by Congress: 119=2 120=1");
    expect(lines).toContain("Vote record plan: scanned=6 withVotes=3 memberRows=6 unreadable=1");
    expect(lines.at(-1)).toBe(`Dry run: would send 3 bills to ${QUEUE_URL}.`);
    expect(sqs.sent).toEqual([]);
    expect(sqs.send.mock.calls.map((call) => (call[0] as SqsCommand).constructor.name)).toEqual([
      "GetQueueUrlCommand",
      "GetQueueUrlCommand",
    ]);
  });

  it("narrows the scan to one Congress", async () => {
    const { result } = await run({ congress: 120 });
    expect(result.scan.candidates.map((candidate) => candidate.guid)).toEqual(["BILLS-120hr5"]);
  });

  it("a canary sends the first bills only, as S3 events without a versionId", async () => {
    const { result, lines, sqs } = await run({ apply: true, canary: 2 });

    expect(sqs.sent).toEqual(["processed-bills/BILLS-119hr1.json", "processed-bills/BILLS-119s4.json"]);
    expect(result).toMatchObject({ sent: 2, remaining: 1, stopped: null, lastSent: "BILLS-119s4" });
    expect(lines.at(-1)).toBe("Vote record backfill: sent=2 remaining=1 stopped=no lastSent=BILLS-119s4");
  });

  it("sends every bill with the dry run's count, and resumes after the last one sent", async () => {
    expect((await run({ apply: true, expectBills: 3 })).sqs.sent).toHaveLength(3);
    expect((await run({ apply: true, expectBills: 3, startAfter: "BILLS-119s4" })).sqs.sent).toEqual([
      "processed-bills/BILLS-120hr5.json",
    ]);
  });

  it("refuses a full send whose count moved since the dry run", async () => {
    const sqs = sqsClient();
    await expect(run({ apply: true, expectBills: 2 }, sqs)).rejects.toThrow("--expect-bills 2 but 3 bills");
    expect(sqs.sent).toEqual([]);
  });

  it("stops when the DLQ grows, naming the last bill sent", async () => {
    const many: Record<string, unknown> = {};
    for (let index = 1; index <= 25; index += 1) many[`processed-bills/BILLS-119hr${100 + index}.json`] = votes("Yea");
    // At the start 1; before batch 1 still 1; before batch 2 it is 2.
    const sqs = sqsClient({ dlqDepths: [1, 1, 2] });

    const { result, lines } = await run({ apply: true, expectBills: 25 }, sqs, many);

    expect(result).toMatchObject({ sent: 10, stopped: "dlq", lastSent: "BILLS-119hr110" });
    expect(lines).toContain("Resume with --start-after BILLS-119hr110 once the cause is fixed.");
  });

  it("waits while the queue is full, and stops after 10 minutes of it", async () => {
    const waits = QUEUE_WAIT_LIMIT_MS / QUEUE_WAIT_MS;
    const full = sqsClient({ queueDepths: [500] });
    const stopped = await run({ apply: true, canary: 1 }, full);
    expect(stopped.result).toMatchObject({ sent: 0, stopped: "queue" });
    expect(stopped.sleep).toHaveBeenCalledTimes(waits);

    const drains = sqsClient({ queueDepths: [500, 500, 0] });
    const resumed = await run({ apply: true, canary: 1 }, drains);
    expect(resumed.result).toMatchObject({ sent: 1, stopped: null });
    expect(resumed.sleep).toHaveBeenCalledTimes(2);
  });

  it("stops at a message SQS refuses", async () => {
    const sqs = sqsClient({ failIds: ["bill-1"] });

    const { result } = await run({ apply: true, expectBills: 3 }, sqs);

    expect(result).toMatchObject({ sent: 1, stopped: "send", lastSent: "BILLS-119hr1" });
  });
});
