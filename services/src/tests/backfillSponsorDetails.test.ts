import { FakeVersionedS3 } from "./fakeVersionedS3";

let mockS3: FakeVersionedS3;
jest.mock("@aws-sdk/client-s3", () => require("./fakeVersionedS3").mockS3Module(() => mockS3));

import type { AttributeValue, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient, SendMessageCommandInput } from "@aws-sdk/client-sqs";
import type { RawBill } from "../models/bill";
import { SOURCE_METADATA_KEYS, sourceTextHash } from "../shared/billSourceReconcile";
import {
  MIN_CURRENT_MEMBERS,
  configFromEnv,
  countDepartedSponsorBills,
  parseArgs,
  runSponsorBackfill,
  type CliOptions,
} from "../../scripts/backfillSponsorDetails";

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/BillDifferQueue";
const INTRODUCED = { actionDate: "2026-01-10", actionCode: "Intro-H", text: "Introduced in House" };
const PASSED = { actionDate: "2026-02-10", actionCode: "8000", text: "Passed House" };

// The members list: MIN_CURRENT_MEMBERS current members, M000000 to M000499.
const CURRENT = Array.from({ length: MIN_CURRENT_MEMBERS }, (_, index) => `M${String(index).padStart(6, "0")}`);
const DEPARTED = "G000001";

const sponsorEntry = (bioguideId: string) => ({
  bioguideId,
  firstName: "Gale",
  lastName: "Gone",
  fullName: "Rep. Gone, Gale [D-OH-9]",
  party: "D",
  state: "OH",
  district: 9,
});

const raw = (guid: string, sponsor: string, actions: unknown[] = [INTRODUCED]) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-02-01T00:00:00.000Z",
  identifier: { congress: "119", billType: "hr", billNumber: guid.replace(/^\D+119[a-z]+/, "") },
  metadata: { guid, title: `Title ${guid}`, pubDate: "", fetchedAt: "2026-02-01T00:00:00.000Z" },
  content: {
    billXML: "<bill>text</bill>",
    actions: { actions },
    committees: { committees: [] },
    bill: { bill: { sponsors: [sponsorEntry(sponsor)] } },
    cosponsors: { cosponsors: [] },
  },
});

const processed = (guid: string, sponsor: string, overrides: Record<string, unknown> = {}) => ({
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
  sponsors: [sponsor],
  cosponsors: [],
  actions: [INTRODUCED],
  committees: [],
  billStatus: "New",
  ...overrides,
});

/**
 * A bill as stored in S3: its processed version built from a raw version, and with `newerActions` a newer raw version
 * after it (the raw bill moved on, so the bill is behind on more than sponsorDetails).
 */
const store = (guid: string, sponsor: string, options: { newerActions?: unknown[]; processed?: object } = {}) => {
  const builtFrom = raw(guid, sponsor);
  const builtFromVersion = mockS3.put(`raw-bills/${guid}.json`, builtFrom);
  if (options.newerActions) mockS3.put(`raw-bills/${guid}.json`, raw(guid, sponsor, options.newerActions));
  mockS3.put(
    `processed-bills/${guid}.json`,
    { ...processed(guid, sponsor), ...options.processed },
    {
      [SOURCE_METADATA_KEYS.textHash]: sourceTextHash(builtFrom as RawBill),
      [SOURCE_METADATA_KEYS.rawVersion]: builtFromVersion,
      [SOURCE_METADATA_KEYS.fetchedAt]: builtFrom.metadata.fetchedAt,
    },
  );
};

type Item = Record<string, AttributeValue>;
interface DdbCommand {
  constructor: { name: string };
  input: { TableName?: string; ExclusiveStartKey?: Item };
}

/** Scans the members table and queries the manifest partition, each in two pages. */
const ddbClient = (members: string[], manifest: Array<{ guid: string; sponsors: string[] }>) => {
  const memberItems: Item[] = members.map((id) => ({ bioguideId: { S: id } }));
  const manifestItems: Item[] = manifest.map((bill) => ({
    guid: { S: bill.guid },
    sponsors: { L: bill.sponsors.map((id) => ({ S: id })) },
  }));
  const pages = (items: Item[], command: DdbCommand) => {
    const half = Math.ceil(items.length / 2);
    return command.input.ExclusiveStartKey
      ? { Items: items.slice(half) }
      : { Items: items.slice(0, half), LastEvaluatedKey: { page: { S: "2" } } };
  };
  const commands: string[] = [];
  const send = jest.fn(async (command: DdbCommand) => {
    commands.push(`${command.constructor.name} ${command.input.TableName}`);
    if (command.constructor.name === "ScanCommand") return pages(memberItems, command);
    if (command.constructor.name === "QueryCommand") return pages(manifestItems, command);
    throw new Error(`unexpected ${command.constructor.name}`);
  });
  return { client: { send } as unknown as Pick<DynamoDBClient, "send">, commands };
};

const sqsClient = () => {
  const sent: string[] = [];
  const send = jest.fn(async (command: { constructor: { name: string }; input: Partial<SendMessageCommandInput> }) => {
    if (command.constructor.name === "GetQueueUrlCommand") return { QueueUrl: QUEUE_URL };
    sent.push((JSON.parse(command.input.MessageBody!) as { guid: string }).guid);
    return { MessageId: "m" };
  });
  return { client: { send } as unknown as Pick<SQSClient, "send">, sent };
};

const options = (overrides: Partial<CliOptions> = {}): CliOptions => ({ ...parseArgs([]), ...overrides });

const MANIFEST = [
  { guid: "BILLS-119hr1", sponsors: [DEPARTED] }, // the sponsor left; built from its latest raw bill: sponsorDetails only
  { guid: "BILLS-119hr2", sponsors: [CURRENT[0]] }, // a current member's bill: not listed
  { guid: "BILLS-119hr3", sponsors: [DEPARTED] }, // already carries the details
  { guid: "BILLS-119hr4", sponsors: [DEPARTED] }, // its raw bill moved on (a passage): left to the reconcile
  { guid: "BILLS-119hr5", sponsors: [] },
];

const seedBills = () => {
  store("BILLS-119hr1", DEPARTED);
  store("BILLS-119hr2", CURRENT[0]);
  store("BILLS-119hr3", DEPARTED, {
    processed: {
      sponsorDetails: [{ bioguideId: DEPARTED, name: "Gale Gone", party: "D", state: "OH", district: "09" }],
    },
  });
  store("BILLS-119hr4", DEPARTED, { newerActions: [PASSED, INTRODUCED] });
};

const run = async (cli: Partial<CliOptions>, members = CURRENT, extra: Record<string, unknown> = {}) => {
  const lines: string[] = [];
  const ddb = ddbClient(members, MANIFEST);
  const sqs = sqsClient();
  const written: Record<string, string> = {};
  const promise = runSponsorBackfill({
    ddb: ddb.client,
    s3: new S3Client({}),
    sqs: sqs.client,
    config: { ...configFromEnv({}), reconcile: { ...configFromEnv({}).reconcile, billDifferQueueUrl: QUEUE_URL } },
    options: options(cli),
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    logError: () => undefined,
    writeFile: (path: string, text: string) => {
      written[path] = text;
    },
    fileExists: () => false,
    now: () => new Date("2027-01-20T15:00:00.000Z"),
    sleep: async () => undefined,
    ...extra,
  });
  return { promise, lines, ddb, sqs, written };
};

beforeEach(() => {
  mockS3 = new FakeVersionedS3();
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

describe("backfill:sponsor-details (REL-46 5.3)", () => {
  it("parses its flags, and --apply needs the dry run's count", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      apply: false,
      expectBills: null,
      out: null,
      concurrency: 8,
      rate: 10,
    });
    expect(parseArgs(["--apply", "--expect-bills", "3", "--rate", "2", "--out", "list.txt"])).toMatchObject({
      apply: true,
      expectBills: 3,
      rate: 2,
      out: "list.txt",
    });
    expect(() => parseArgs(["--apply"])).toThrow("--apply needs --expect-bills");
    expect(() => parseArgs(["--expect-bills", "-1"])).toThrow("--expect-bills needs a whole number");
    expect(() => parseArgs(["--plans", "patch"])).toThrow("Unknown argument: --plans");
  });

  it("counts the bills with a sponsor not in the members list, by Congress", () => {
    const count = countDepartedSponsorBills(
      [
        { guid: "BILLS-119hr1", sponsors: ["A000001", "G000001"] },
        { guid: "BILLS-119hr2", sponsors: ["A000001"] },
        { guid: "BILLS-120s1", sponsors: ["G000002"] },
        { guid: "BILLS-120s2", sponsors: ["G000002"] },
        { guid: "BILLS-119hr9", sponsors: [] },
      ],
      new Set(["A000001"]),
    );
    expect(count).toEqual({
      bills: 5,
      withSponsor: 4,
      guids: ["BILLS-119hr1", "BILLS-120s1", "BILLS-120s2"],
      departedSponsors: 2,
      byCongress: { "119": 1, "120": 2 },
    });
  });

  it("dry run: counts, plans the bills read-only, writes the list and sends nothing", async () => {
    seedBills();
    const { promise, lines, sqs, written } = await run({ out: "departed.txt" });
    const result = await promise;

    expect(result.count.guids).toEqual(["BILLS-119hr1", "BILLS-119hr3", "BILLS-119hr4"]);
    expect(result.plans).toEqual({
      sponsorDetailsOnly: ["BILLS-119hr1"],
      otherPatches: ["BILLS-119hr4"],
      unchanged: 1,
      otherPlans: 0,
      unreadable: 0,
    });
    expect(lines).toContain("departed-sponsor bills by Congress: 119=3");
    expect(lines).toContain(
      "Behind on other fields too, not sent (reconcile:processed-bills --guids-file, RUNBOOK 4.1 window): BILLS-119hr4",
    );
    expect(written["departed.txt"]).toBe(
      "# Bills whose sponsor is not in the members list (backfill:sponsor-details): guid<TAB>plan\n" +
        "BILLS-119hr1\tsponsorDetailsOnly\nBILLS-119hr3\tunchanged\nBILLS-119hr4\tpatch\n",
    );
    expect(lines.slice(-2)).toEqual([
      `Sponsor details plan: bills=5 withSponsor=4 departedSponsorBills=3 departedSponsors=1 members=${MIN_CURRENT_MEMBERS} ` +
        "sponsorDetailsOnly=1 otherPatches=1 unchanged=1 otherPlans=0 unreadable=0",
      "Dry run: would send 1 guids (sponsorDetails patches only).",
    ]);
    expect(sqs.sent).toEqual([]);
    expect(mockS3.commands("PutObject")).toEqual([]);
  });

  it("--apply with the dry run's count sends only the bills whose patch is sponsorDetails alone", async () => {
    seedBills();
    const { promise, lines, sqs } = await run({ apply: true, expectBills: 1 });
    const result = await promise;

    expect(sqs.sent).toEqual(["BILLS-119hr1"]);
    expect(result.reconcile?.sent).toBe(1);
    expect(lines).toContain(
      "patched fields: actions=0 committees=0 sponsors=0 sponsorDetails=1 cosponsors=0 billStatus=0 officialVotes=0",
    );
    expect(lines.at(-1)).toBe("Reconcile complete sent=1 failed=0 unreadable=0");
    expect(mockS3.commands("PutObject")).toEqual([]);
  });

  it("does not send a bill whose raw bill moved on between the count and the send", async () => {
    seedBills();
    const lines: string[] = [];
    const { promise, sqs } = await run({ apply: true, expectBills: 1 }, CURRENT, {
      log: (...args: unknown[]) => {
        const line = args.map(String).join(" ");
        lines.push(line);
        // After the count, before reconcile plans again: BILLS-119hr1 gains a passage.
        if (line.startsWith("Sponsor details plan:")) {
          mockS3.put("raw-bills/BILLS-119hr1.json", raw("BILLS-119hr1", DEPARTED, [PASSED, INTRODUCED]));
        }
      },
    });
    const result = await promise;

    expect(sqs.sent).toEqual([]);
    expect(result.reconcile?.refused).toEqual(["BILLS-119hr1"]);
    expect(lines).toContain("Not sent, their plan changed since they were counted (1): BILLS-119hr1");
    expect(lines.at(-1)).toBe("Reconcile complete sent=0 failed=0 unreadable=0");
  });

  it("refuses --apply when the count moved since the dry run, sending nothing", async () => {
    seedBills();
    const { promise, sqs } = await run({ apply: true, expectBills: 3 });

    await expect(promise).rejects.toThrow("--expect-bills 3 but 1 bills plan a sponsorDetails patch alone");
    expect(sqs.sent).toEqual([]);
    expect(mockS3.commands("PutObject")).toEqual([]);
  });

  it("refuses a members list too short to be whole (a members run in progress)", async () => {
    seedBills();
    const { promise, ddb, sqs } = await run({}, CURRENT.slice(0, MIN_CURRENT_MEMBERS - 1));

    await expect(promise).rejects.toThrow(
      `holds ${MIN_CURRENT_MEMBERS - 1} members, fewer than ${MIN_CURRENT_MEMBERS}`,
    );
    expect(ddb.commands.filter((command) => command.startsWith("QueryCommand"))).toEqual([]);
    expect(sqs.sent).toEqual([]);
  });

  it("refuses an --out file that exists, before reading anything", async () => {
    const { promise, ddb } = await run({ out: "departed.txt" }, CURRENT, { fileExists: () => true });

    await expect(promise).rejects.toThrow("departed.txt exists");
    expect(ddb.commands).toEqual([]);
  });

  it("plans nothing when every sponsor is a current member", async () => {
    const ddb = ddbClient(CURRENT, [{ guid: "BILLS-119hr2", sponsors: [CURRENT[1]] }]);
    const sqs = sqsClient();
    const lines: string[] = [];

    const result = await runSponsorBackfill({
      ddb: ddb.client,
      s3: new S3Client({}),
      sqs: sqs.client,
      config: configFromEnv({}),
      options: options(),
      log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    });

    expect(result.reconcile).toBeNull();
    expect(result.plans).toBeNull();
    expect(lines.at(-1)).toBe("No bill has a sponsor missing from the members list; nothing to plan.");
    expect(sqs.sent).toEqual([]);
  });
});
