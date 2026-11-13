const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "GetObjectCommand", input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "PutObjectCommand", input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "DeleteObjectCommand", input })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ __type: "ListObjectsV2Command", input })),
}));

import type { GetObjectCommandInput, ListObjectsV2CommandInput } from "@aws-sdk/client-s3";
import { S3Client } from "@aws-sdk/client-s3";
import type { GetQueueUrlCommandInput, SendMessageBatchCommandInput } from "@aws-sdk/client-sqs";
import { summarizeCongressMemberPayload } from "../handlers/congressMemberSummarizer";
import type { SenateSeat } from "../shared/senateTerms";
import { noSuchKeyError } from "./fixtures/awsErrors";
import { rawCongressMemberPayload } from "./fixtures/congressMemberSummarizer.fixtures";
import {
  appCurrentTerm,
  configFromEnv,
  parseArgs,
  planMember,
  runReprocess,
  type CliOptions,
} from "../../scripts/reprocessCongressMembers";

/** The mocked S3 and SQS commands: the constructors the mocks above return plain objects from. */
interface S3Command {
  __type: string;
  input: Partial<GetObjectCommandInput & ListObjectsV2CommandInput>;
}
interface SqsCommand {
  input: Partial<GetQueueUrlCommandInput & SendMessageBatchCommandInput>;
}

// REL-52: a processed member stored before the merge lists one "term" per Congress.
const yearOf = (congress: number) => 2 * congress + 1787;
const senatorRaw = (bioguideId: string, from: number, currentMember = true) => ({
  member: {
    bioguideId,
    currentMember,
    directOrderName: `Senator ${bioguideId}`,
    partyHistory: [{ partyAbbreviation: "D", partyName: "Democratic", startYear: 2007 }],
    state: "Minnesota",
    terms: Array.from({ length: 119 - from + 1 }, (_, i) => from + i).map((congress) => ({
      chamber: "Senate",
      congress,
      memberType: "Senator",
      startYear: yearOf(congress),
      ...(congress === 119 ? {} : { endYear: yearOf(congress) + 2 }),
      stateCode: "MN",
      stateName: "Minnesota",
    })),
    updateDate: "2026-10-01T00:00:00Z",
  },
});
/**
 * A senator who served in the House first: House from the 95th Congress (1977) into 2013, then the Senate after a
 * special election in 2013 to Massachusetts' class II seat (the rest of the 2009-2015 term). congress.gov lists 19 House
 * and 7 Senate entries; the Senate's merge into 3 terms leaves the 19 House entries as they are.
 */
const houseThenSenateRaw = () => {
  const raw = senatorRaw("M000133", 113);
  const house = Array.from({ length: 113 - 95 + 1 }, (_, i) => 95 + i).map((congress) => ({
    chamber: "House of Representatives",
    congress,
    district: 7,
    memberType: "Representative",
    startYear: yearOf(congress),
    endYear: congress === 113 ? 2013 : yearOf(congress) + 2,
    stateCode: "MA",
    stateName: "Massachusetts",
  }));
  const senate = raw.member.terms.map((term) => ({
    ...term,
    stateCode: "MA",
    stateName: "Massachusetts",
  }));
  return { member: { ...raw.member, state: "Massachusetts", terms: [...house, ...senate] } };
};
/** What the summarizer stored before REL-52: congress.gov's entries as they are. */
const storedBefore = (raw: ReturnType<typeof senatorRaw>) => {
  const member = summarizeCongressMemberPayload(raw)!.member;
  return { member: { ...member, terms: raw.member.terms, termCount: raw.member.terms.length } };
};

const SEATS = new Map<string, SenateSeat>([
  ["K000367", { senateClass: 1, stateCode: "MN" }],
  ["S001203", { senateClass: 2, stateCode: "MN" }],
  ["M000133", { senateClass: 2, stateCode: "MA" }],
]);
const config = configFromEnv({});
const dryRun: CliOptions = parseArgs([]);

describe("reprocess:congress-members", () => {
  it("parses its arguments and keeps production's names by default", () => {
    expect(parseArgs(["--apply", "--list", "--bioguide-id", "k000367", "--limit", "3", "--rate", "2"])).toEqual({
      help: false,
      apply: true,
      list: true,
      bioguideIds: ["K000367"],
      limit: 3,
      concurrency: 8,
      rate: 2,
    });
    expect(() => parseArgs(["--bioguide-id", "K1"])).toThrow("bioguide ID");
    expect(() => parseArgs(["--rate", "50"])).toThrow("from 1 to 20");
    expect(() => parseArgs(["--force"])).toThrow("Unknown argument");
    expect(config).toEqual(
      expect.objectContaining({
        bucket: "billboard-congress-member-store-bucket",
        processedPrefix: "processed-congress-members/",
        rawPrefix: "raw-congress-members/",
        queueName: "CongressMemberSummarizerQueue",
      }),
    );
  });

  describe("planMember", () => {
    it("plans a senator stored with per-Congress entries as a terms change, with the counts before and after", () => {
      const raw = senatorRaw("K000367", 110);
      expect(planMember("K000367", storedBefore(raw), raw, SEATS)).toEqual({
        bioguideId: "K000367",
        kind: "terms",
        senator: true,
        inferredSenateClass: false,
        termsBefore: 10,
        termsAfter: 4,
        senateTermsBefore: 10,
        senateTermsAfter: 4,
        appChamberMismatch: false,
      });
    });

    it("counts a former House member's Senate terms apart: the House entries are kept, so the total falls less", () => {
      const raw = houseThenSenateRaw();
      expect(planMember("M000133", storedBefore(raw), raw, SEATS)).toEqual(
        expect.objectContaining({
          kind: "terms",
          senator: true,
          inferredSenateClass: false,
          termsBefore: 26,
          termsAfter: 22,
          senateTermsBefore: 7,
          senateTermsAfter: 3,
          appChamberMismatch: false,
        }),
      );
    });

    it("counts a senator the apps would read as a House member: a House entry ending in the current term's first year", () => {
      // Appointed from the House in January 2027 to a class II seat whose term began that month: the apps take the
      // latest startYear, then endYear, so the House entry (2027 to 2027) beats the running term (2027, no endYear).
      const raw = senatorRaw("K000367", 110);
      const terms = [
        { chamber: "House of Representatives", congress: 120, startYear: 2027, endYear: 2027, stateCode: "MN" },
        { chamber: "Senate", congress: 120, startYear: 2027, stateCode: "MN" },
        { chamber: "Senate", congress: 121, startYear: 2029, stateCode: "MN" },
      ];
      const appointed = { member: { ...raw.member, terms } };
      expect(
        planMember("K000367", appointed, appointed, new Map([["K000367", { senateClass: 2, stateCode: "MN" }]])),
      ).toEqual(expect.objectContaining({ senator: true, appChamberMismatch: true }));
      expect(appCurrentTerm(terms)).toBe(terms[2]);
      expect(appCurrentTerm([terms[0], { ...terms[1] }])).toBe(terms[0]);
    });

    it("plans every current senator as a terms change, also one whose entries are one a term (RUNBOOK 21.5)", () => {
      // Sworn in in 2025: one entry, one term. The merged term is rebuilt with its fields in a new order, so the stored
      // terms differ and the dry run's terms equals its senators.
      const raw = senatorRaw("F000001", 119);
      const seats = new Map([...SEATS, ["F000001", { senateClass: 1 as const, stateCode: "MN" }]]);
      expect(planMember("F000001", storedBefore(raw), raw, seats)).toEqual(
        expect.objectContaining({ kind: "terms", senator: true, termsBefore: 1, termsAfter: 1, senateTermsAfter: 1 }),
      );
      const current = summarizeCongressMemberPayload(raw, { senateSeat: seats.get("F000001") });
      expect(planMember("F000001", current, raw, seats).kind).toBe("unchanged");
    });

    it("plans nothing for a member already stored as the summarizer stores it now", () => {
      const raw = senatorRaw("K000367", 110);
      const current = summarizeCongressMemberPayload(raw, { senateSeat: SEATS.get("K000367") });
      expect(planMember("K000367", current, raw, SEATS).kind).toBe("unchanged");
      expect(
        planMember(
          "V000139",
          summarizeCongressMemberPayload(rawCongressMemberPayload),
          rawCongressMemberPayload,
          SEATS,
        ),
      ).toEqual(
        expect.objectContaining({
          kind: "unchanged",
          senator: false,
          termsBefore: 1,
          termsAfter: 1,
          senateTermsBefore: 0,
          senateTermsAfter: 0,
        }),
      );
    });

    it("says when only other fields would change, and skips members without raw data or who have left", () => {
      const raw = senatorRaw("K000367", 110);
      const current = summarizeCongressMemberPayload(raw, { senateSeat: SEATS.get("K000367") })!;
      const older = { member: { ...current.member, updateDate: "2026-01-01T00:00:00Z" } };
      expect(planMember("K000367", older, raw, SEATS).kind).toBe("other");
      expect(planMember("K000367", older, null, SEATS).kind).toBe("no_raw");
      expect(planMember("K000367", older, senatorRaw("K000367", 110, false), SEATS).kind).toBe("departed");
    });

    it("marks a current senator the list does not name", () => {
      const raw = senatorRaw("X000001", 116);
      expect(planMember("X000001", storedBefore(raw), raw, SEATS)).toEqual(
        expect.objectContaining({
          kind: "terms",
          senator: true,
          inferredSenateClass: true,
          termsBefore: 4,
          termsAfter: 2,
        }),
      );
    });
  });

  describe("runReprocess", () => {
    const objects: Record<string, unknown> = {};
    const sqsSend = jest.fn();
    const logs: string[] = [];
    const log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    beforeEach(() => {
      mockS3Send.mockReset();
      sqsSend.mockReset();
      logs.length = 0;
      for (const key of Object.keys(objects)) delete objects[key];
      const klobuchar = senatorRaw("K000367", 110);
      const smith = senatorRaw("S001203", 115);
      objects["raw-congress-members/K000367.json"] = klobuchar;
      objects["processed-congress-members/K000367.json"] = storedBefore(klobuchar);
      objects["raw-congress-members/S001203.json"] = smith;
      objects["processed-congress-members/S001203.json"] = summarizeCongressMemberPayload(smith, {
        senateSeat: SEATS.get("S001203"),
      });
      const markey = houseThenSenateRaw();
      objects["raw-congress-members/M000133.json"] = markey;
      objects["processed-congress-members/M000133.json"] = storedBefore(markey);
      objects["raw-congress-members/V000139.json"] = rawCongressMemberPayload;
      objects["processed-congress-members/V000139.json"] = summarizeCongressMemberPayload(rawCongressMemberPayload);
      mockS3Send.mockImplementation(async (cmd: S3Command) => {
        if (cmd.__type === "ListObjectsV2Command") {
          return {
            Contents: [
              ...Object.keys(objects).filter((key) => key.startsWith(cmd.input.Prefix!)),
              "processed-congress-members/notes.txt",
            ].map((Key) => ({ Key })),
          };
        }
        if (cmd.__type === "GetObjectCommand") {
          const payload = objects[cmd.input.Key!];
          if (!payload) throw noSuchKeyError();
          return { Body: { transformToString: async () => JSON.stringify(payload) } };
        }
        throw new Error(`unexpected S3 call ${cmd.__type}`);
      });
    });

    const run = (options: CliOptions, loadSeats = async () => SEATS) =>
      runReprocess({
        s3: new S3Client({}),
        sqs: { send: sqsSend } as Parameters<typeof runReprocess>[0]["sqs"],
        config,
        options,
        loadSeats,
        log,
        logError: log,
        sleep: async () => undefined,
      });

    it("dry run: reads only and prints the counts", async () => {
      const result = await run(dryRun);

      expect(sqsSend).not.toHaveBeenCalled();
      expect(mockS3Send.mock.calls.map((c) => c[0].__type)).not.toContain("PutObjectCommand");
      expect(result.scan?.plans.map((plan) => [plan.bioguideId, plan.kind])).toEqual([
        ["K000367", "terms"],
        ["M000133", "terms"],
        ["S001203", "unchanged"],
        ["V000139", "unchanged"],
      ]);
      // All terms: 10 -> 4, 26 -> 22 (19 House entries kept), 2 -> 2; the Senate's alone: 10 -> 4, 7 -> 3, 2 -> 2.
      expect(logs).toContain(
        "Reprocess plan: total=4 unchanged=2 terms=2 other=0 no_raw=0 departed=0 unreadable=0 senators=3 " +
          "senatorTermsBefore=38 senatorTermsAfter=28 senatorSenateTermsBefore=19 senatorSenateTermsAfter=9 " +
          "inferredSenateClasses=0 appChamberMismatch=0",
      );
      expect(logs).toContain("Dry run: would send 2 members to CongressMemberSummarizerQueue.");
      expect(logs.some((line) => line.startsWith("terms K000367"))).toBe(false);
    });

    it("--list names each member that would change", async () => {
      await run(parseArgs(["--list"]));
      expect(logs).toContain("terms K000367 terms 10 -> 4 (Senate 10 -> 4)");
      expect(logs).toContain("terms M000133 terms 26 -> 22 (Senate 7 -> 3)");
    });

    it("gives RUNBOOK 21.5's four senators exactly the lines it expects, and step 4's terms", async () => {
      const inState = (raw: ReturnType<typeof senatorRaw>, stateCode: string, stateName: string) => ({
        member: { ...raw.member, terms: raw.member.terms.map((term) => ({ ...term, stateCode, stateName })) },
      });
      const senators: Record<string, ReturnType<typeof senatorRaw>> = {
        O000174: inState(senatorRaw("O000174", 117), "GA", "Georgia"),
        R000618: inState(senatorRaw("R000618", 118), "NE", "Nebraska"),
        W000790: inState(senatorRaw("W000790", 117), "GA", "Georgia"),
      };
      for (const [id, raw] of Object.entries(senators)) {
        objects[`raw-congress-members/${id}.json`] = raw;
        objects[`processed-congress-members/${id}.json`] = storedBefore(raw);
      }
      const seats = new Map<string, SenateSeat>([
        ...SEATS,
        ["O000174", { senateClass: 2, stateCode: "GA" }],
        ["R000618", { senateClass: 2, stateCode: "NE" }],
        ["W000790", { senateClass: 3, stateCode: "GA" }],
      ]);

      await run(
        parseArgs(["--list", ...["K000367", "O000174", "R000618", "W000790"].flatMap((id) => ["--bioguide-id", id])]),
        async () => seats,
      );

      expect(logs.filter((line) => line.startsWith("terms ") || line.startsWith("Reprocess plan:"))).toEqual([
        "terms K000367 terms 10 -> 4 (Senate 10 -> 4)",
        "terms O000174 terms 3 -> 1 (Senate 3 -> 1)",
        "terms R000618 terms 2 -> 1 (Senate 2 -> 1)",
        "terms W000790 terms 3 -> 2 (Senate 3 -> 2)",
        "Reprocess plan: total=4 unchanged=0 terms=4 other=0 no_raw=0 departed=0 unreadable=0 senators=4 " +
          "senatorTermsBefore=18 senatorTermsAfter=8 senatorSenateTermsBefore=18 senatorSenateTermsAfter=8 " +
          "inferredSenateClasses=0 appChamberMismatch=0",
      ]);
      // Step 4's jq: the class III seat gives Warnock 2 terms; a class inferred from Georgia's seats would give 1.
      const termsOf = (raw: unknown, senateSeat: SenateSeat | null) =>
        (summarizeCongressMemberPayload(raw, { senateSeat })!.member.terms ?? []).map((term) => [
          term.chamber,
          term.congress,
          term.startYear,
          term.endYear ?? null,
        ]);
      expect(termsOf(objects["raw-congress-members/K000367.json"], seats.get("K000367")!)).toEqual([
        ["Senate", 110, 2007, 2013],
        ["Senate", 113, 2013, 2019],
        ["Senate", 116, 2019, 2025],
        ["Senate", 119, 2025, null],
      ]);
      expect(termsOf(senators.W000790, seats.get("W000790")!)).toEqual([
        ["Senate", 117, 2021, 2023],
        ["Senate", 118, 2023, null],
      ]);
      expect(termsOf(senators.W000790, null)).toEqual([["Senate", 117, 2021, null]]);
    });

    it("stops before planning when the Senate's list cannot be read", async () => {
      const result = await run(dryRun, async () => {
        throw new Error("answered 503");
      });
      expect(result).toEqual({ scan: null, sent: 0, failed: [] });
      expect(mockS3Send).not.toHaveBeenCalled();
    });

    it("--apply sends each member that would change to CongressMemberSummarizerQueue, and writes nothing", async () => {
      sqsSend.mockImplementation(async (cmd: SqsCommand) => {
        if (cmd.input.QueueName)
          return { QueueUrl: "https://sqs.us-east-1.amazonaws.com/1/CongressMemberSummarizerQueue" };
        return { Successful: cmd.input.Entries!.map((entry) => ({ Id: entry.Id })) };
      });

      const result = await run(parseArgs(["--apply"]));

      expect(result.sent).toBe(2);
      expect(result.failed).toEqual([]);
      const batch = sqsSend.mock.calls.map((c) => c[0].input).find((input) => input.Entries);
      expect(batch).toEqual({
        QueueUrl: "https://sqs.us-east-1.amazonaws.com/1/CongressMemberSummarizerQueue",
        Entries: [
          { Id: "member-0", MessageBody: JSON.stringify({ bioguideId: "K000367" }) },
          { Id: "member-1", MessageBody: JSON.stringify({ bioguideId: "M000133" }) },
        ],
      });
      expect(mockS3Send.mock.calls.map((c) => c[0].__type)).not.toContain("PutObjectCommand");
      expect(logs).toContain("Reprocess complete sent=2 failed=0 unreadable=0");
    });

    it("--apply reports the members SQS refused", async () => {
      sqsSend.mockImplementation(async (cmd: SqsCommand) => {
        if (cmd.input.QueueName) return { QueueUrl: "q" };
        return { Failed: [{ Id: "member-0", Code: "InternalError" }] };
      });

      const result = await run(parseArgs(["--apply", "--bioguide-id", "K000367"]));

      expect(result).toEqual(expect.objectContaining({ sent: 0, failed: ["K000367"] }));
    });
  });
});
