const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "GetObjectCommand", input })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "PutObjectCommand", input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "DeleteObjectCommand", input })),
}));

import { format } from "node:util";

import { summarizeCongressMemberPayload } from "../handlers/congressMemberSummarizer";
import { applyTestEnv } from "./fixtures/env";
import { noSuchKeyError } from "./fixtures/awsErrors";
import { processedCongressMemberPayload, rawCongressMemberPayload } from "./fixtures/congressMemberSummarizer.fixtures";

/** What the mocked S3 commands carry: the constructor mocks above tag each with its type and input. */
interface FakeCommand {
  __type: string;
  input: { Key?: string; Bucket?: string; Body?: string };
}

interface SqsEventLike {
  Records: Array<{ messageId: string; body: string }>;
}

/** The part of a stored processed member these tests read. */
interface StoredMember {
  termCount: number;
  terms: Array<{ congress: number; startYear: number; endYear?: number }>;
}

describe("congressMemberSummarizer", () => {
  it("should transform a raw Congress member payload into the processed app format", () => {
    const summarized = summarizeCongressMemberPayload(rawCongressMemberPayload);
    expect(summarized).toEqual(processedCongressMemberPayload);
  });

  it("should default legislation counts to 0 when missing", () => {
    const input = {
      member: {
        bioguideId: "X000000",
        directOrderName: "Test Person",
        firstName: "Test",
        lastName: "Person",
        partyHistory: [{ partyAbbreviation: "I", partyName: "Independent", startYear: 2024 }],
        terms: [
          {
            chamber: "Senate",
            congress: 119,
            memberType: "Senator",
            startYear: 2025,
            stateCode: "CA",
            stateName: "California",
          },
        ],
        updateDate: "2025-01-01T00:00:00Z",
      },
    };

    const summarized = summarizeCongressMemberPayload(input);
    expect(summarized?.member.sponsoredLegislationCount).toBe(0);
    expect(summarized?.member.cosponsoredLegislationCount).toBe(0);
  });

  // REL-52: congress.gov lists Senate service per Congress; the processed member has one entry per real term.
  describe("Senate terms (REL-52)", () => {
    const yearOf = (congress: number) => 2 * congress + 1787;
    const perCongress = (base: Record<string, unknown>, from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i).map((congress) => ({
        ...base,
        congress,
        startYear: yearOf(congress),
        ...(congress === 119 ? {} : { endYear: yearOf(congress) + 2 }),
      }));
    const senatorRaw = (
      bioguideId: string,
      stateCode: string,
      stateName: string,
      from: number,
      house?: [number, number],
    ) => ({
      member: {
        bioguideId,
        currentMember: true,
        directOrderName: `Senator ${bioguideId}`,
        partyHistory: [{ partyAbbreviation: "R", partyName: "Republican", startYear: 1975 }],
        state: stateName,
        terms: [
          ...(house
            ? perCongress(
                {
                  chamber: "House of Representatives",
                  memberType: "Representative",
                  stateCode,
                  stateName,
                  district: 3,
                },
                house[0],
                house[1],
              )
            : []),
          ...perCongress({ chamber: "Senate", memberType: "Senator", stateCode, stateName }, from, 119),
        ],
        updateDate: "2026-10-01T00:00:00Z",
      },
    });
    const SENATORS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<contact_information>
  <member><state>IA</state><class>Class III</class><bioguide_id>G000386</bioguide_id></member>
  <member><state>GA</state><class>Class III</class><bioguide_id>W000790</bioguide_id></member>
  <member><state>GA</state><class>Class II</class><bioguide_id>O000174</bioguide_id></member>
</contact_information>`;

    it("summarizes a long-serving senator's 23 Senate Congresses and 3 House terms as 11 terms", () => {
      const summarized = summarizeCongressMemberPayload(senatorRaw("G000386", "IA", "Iowa", 97, [94, 96]), {
        senateSeat: { senateClass: 3, stateCode: "IA" },
      });

      expect(summarized?.member.termCount).toBe(11);
      expect(summarized?.member.terms).toHaveLength(11);
      expect(summarized?.member.terms?.slice(3).map((term) => [term.congress, term.startYear, term.endYear])).toEqual([
        [97, 1981, 1987],
        [100, 1987, 1993],
        [103, 1993, 1999],
        [106, 1999, 2005],
        [109, 2005, 2011],
        [112, 2011, 2017],
        [115, 2017, 2023],
        [118, 2023, undefined],
      ]);
      // The member's own fields still describe the current Congress's entry.
      expect(summarized?.member).toEqual(
        expect.objectContaining({
          chamber: "Senate",
          congress: 119,
          startYear: 2025,
          stateCode: "IA",
          memberType: "Senator",
        }),
      );
    });

    it("keeps a House-only member's terms and termCount as congress.gov lists them", () => {
      const summarized = summarizeCongressMemberPayload(rawCongressMemberPayload);
      expect(summarized?.member.terms).toEqual(rawCongressMemberPayload.member.terms);
      expect(summarized?.member.termCount).toBe(1);
    });

    describe("handler", () => {
      const rawByKey: Record<string, unknown> = {
        "raw-congress-members/G000386.json": senatorRaw("G000386", "IA", "Iowa", 97, [94, 96]),
        "raw-congress-members/W000790.json": senatorRaw("W000790", "GA", "Georgia", 117),
        "raw-congress-members/O000174.json": senatorRaw("O000174", "GA", "Georgia", 117),
        "raw-congress-members/V000139.json": rawCongressMemberPayload,
      };
      let handler: (event: SqsEventLike) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
      let restoreEnv: (() => void) | undefined;
      let fetchSpy: jest.SpyInstance;
      let logSpy: jest.SpyInstance;
      let warnSpy: jest.SpyInstance;

      beforeEach(() => {
        mockS3Send.mockReset();
        logSpy = jest.spyOn(console, "log").mockImplementation();
        warnSpy = jest.spyOn(console, "warn").mockImplementation();
        jest.spyOn(console, "error").mockImplementation();
        fetchSpy = jest
          .spyOn(global, "fetch")
          .mockImplementation(async () => new Response(SENATORS_XML, { status: 200 }));
        restoreEnv = applyTestEnv({ BUCKET_NAME: "member-bucket" });
        mockS3Send.mockImplementation(async (cmd: FakeCommand) => {
          if (cmd.__type === "GetObjectCommand") {
            const payload = rawByKey[cmd.input.Key!];
            if (!payload) throw noSuchKeyError();
            return { Body: { transformToString: async () => JSON.stringify(payload) } };
          }
          return {};
        });
        jest.isolateModules(() => {
          handler = require("../handlers/congressMemberSummarizer").handler;
        });
      });

      afterEach(() => {
        restoreEnv?.();
        jest.restoreAllMocks();
      });

      const records = (...ids: string[]) => ({
        Records: ids.map((bioguideId) => ({ messageId: `m-${bioguideId}`, body: JSON.stringify({ bioguideId }) })),
      });
      const stored = (bioguideId: string) => {
        const put = mockS3Send.mock.calls
          .map(([cmd]: [FakeCommand]) => cmd)
          .find(
            (cmd) =>
              cmd.__type === "PutObjectCommand" && cmd.input.Key === `processed-congress-members/${bioguideId}.json`,
          );
        return (JSON.parse(put!.input.Body!) as { member: StoredMember }).member;
      };
      const inferredMetricLines = () =>
        logSpy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('"SenateClassInferred"'));

      it("merges each senator's terms by the class of the seat on the Senate's list, read once", async () => {
        const first = await handler(records("G000386", "W000790", "O000174"));
        const second = await handler(records("W000790"));

        expect(first).toEqual({ batchItemFailures: [] });
        expect(second).toEqual({ batchItemFailures: [] });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(stored("G000386").termCount).toBe(11);
        // Listed alike by congress.gov, both from January 2021: the rest of a class III term and the 2023-2029 term,
        // against one class II term.
        expect(stored("W000790").terms.map((term) => [term.congress, term.startYear, term.endYear ?? null])).toEqual([
          [117, 2021, 2023],
          [118, 2023, null],
        ]);
        expect(stored("O000174").terms.map((term) => [term.congress, term.startYear, term.endYear ?? null])).toEqual([
          [117, 2021, null],
        ]);
        expect(stored("O000174").termCount).toBe(1);
        expect(inferredMetricLines()).toEqual([]);
      });

      it("never reads the Senate's list for a House member", async () => {
        const res = await handler(records("V000139"));

        expect(res).toEqual({ batchItemFailures: [] });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(stored("V000139").termCount).toBe(1);
      });

      it("infers the class when the list cannot be read, stores the member, and counts SenateClassInferred", async () => {
        fetchSpy.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));

        const res = await handler(records("G000386", "W000790"));

        expect(res).toEqual({ batchItemFailures: [] });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(stored("G000386").termCount).toBe(11);
        // Inferred: Georgia's class II seat begins a term in 2021, so one term (the list says two).
        expect(stored("W000790").termCount).toBe(1);
        expect(warnSpy).toHaveBeenCalledWith("Could not read the Senate's list of senators; inferring Senate classes", {
          error: expect.any(TypeError),
        });
        expect(warnSpy).toHaveBeenCalledWith(
          "No Senate class for a current senator; inferring it from the state's seats",
          {
            bioguideId: "W000790",
            stateCode: "GA",
            reason: "list_unavailable",
          },
        );
        const lines = inferredMetricLines().map((line) => JSON.parse(line));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toEqual(
          expect.objectContaining({
            SenateClassInferred: 1,
            reason: "list_unavailable",
            _aws: expect.objectContaining({
              CloudWatchMetrics: [expect.objectContaining({ Namespace: "BillBoard/BillIngestion" })],
            }),
          }),
        );
      });

      it("counts a senator the list does not name, with the state in the log", async () => {
        // New to the Senate's list, or one who has left while congress.gov still marks them current (RUNBOOK 21.2).
        rawByKey["raw-congress-members/N000001.json"] = senatorRaw("N000001", "MN", "Minnesota", 116);

        const res = await handler(records("N000001"));

        expect(res).toEqual({ batchItemFailures: [] });
        expect(stored("N000001").termCount).toBe(2);
        expect(inferredMetricLines().map((line) => JSON.parse(line).reason)).toEqual(["not_listed"]);
        expect(warnSpy).toHaveBeenCalledWith(
          "No Senate class for a current senator; inferring it from the state's seats",
          { bioguideId: "N000001", stateCode: "MN", reason: "not_listed" },
        );
      });

      it("logs a member it fails with the SQS message ID and a reason naming the member (RUNBOOK 21.5 step 1)", async () => {
        const errorSpy = console.error as unknown as jest.SpyInstance;

        const res = await handler(records("Z000001"));

        expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "m-Z000001" }] });
        expect(errorSpy).toHaveBeenCalledTimes(1);
        // The text CloudWatch Logs gets, which 21.5 matches to a CongressMemberSummarizerDLQ message (SQS keeps the
        // message ID when it moves a message to the DLQ; the body names the member).
        const line = format(...(errorSpy.mock.calls[0] as [unknown, ...unknown[]]));
        expect(line).toMatch(/^Failed to process SQS record/);
        expect(line).toContain("m-Z000001");
        expect(line).toContain("No raw congress member found for bioguideId=Z000001");
      });
    });
  });

  describe("handler: departed members (APPF-02)", () => {
    // GA-14: G000596 left mid-term (congress.gov now reports currentMember: false) and
    // S000999 won the seat.
    const departedRaw = {
      member: {
        bioguideId: "G000596",
        currentMember: false,
        directOrderName: "Departed Member",
        partyHistory: [{ partyAbbreviation: "R", partyName: "Republican", startYear: 2021 }],
        terms: [
          {
            chamber: "House of Representatives",
            congress: 119,
            district: 14,
            endYear: 2026,
            memberType: "Representative",
            startYear: 2025,
            stateCode: "GA",
            stateName: "Georgia",
          },
        ],
      },
    };
    const successorRaw = {
      member: {
        bioguideId: "S000999",
        currentMember: true,
        directOrderName: "Successor Member",
        partyHistory: [{ partyAbbreviation: "R", partyName: "Republican", startYear: 2026 }],
        terms: [
          {
            chamber: "House of Representatives",
            congress: 119,
            district: 14,
            memberType: "Representative",
            startYear: 2026,
            stateCode: "GA",
            stateName: "Georgia",
          },
        ],
      },
    };
    const rawByKey: Record<string, unknown> = {
      "raw-congress-members/G000596.json": departedRaw,
      "raw-congress-members/S000999.json": successorRaw,
    };

    let handler: (event: SqsEventLike) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
    let restoreEnv: (() => void) | undefined;

    beforeEach(() => {
      mockS3Send.mockReset();
      jest.spyOn(console, "log").mockImplementation();
      jest.spyOn(console, "error").mockImplementation();
      restoreEnv = applyTestEnv({ BUCKET_NAME: "member-bucket" });
      mockS3Send.mockImplementation(async (cmd: FakeCommand) => {
        if (cmd.__type === "GetObjectCommand") {
          const payload = rawByKey[cmd.input.Key!];
          if (!payload) throw noSuchKeyError();
          return { Body: { transformToString: async () => JSON.stringify(payload) } };
        }
        return {};
      });
      jest.isolateModules(() => {
        handler = require("../handlers/congressMemberSummarizer").handler;
      });
    });

    afterEach(() => {
      restoreEnv?.();
      jest.restoreAllMocks();
    });

    const writes = () =>
      mockS3Send.mock.calls
        .map(([cmd]: [FakeCommand]) => cmd)
        .filter((cmd) => cmd.__type !== "GetObjectCommand")
        .map((cmd) => ({ type: cmd.__type, key: cmd.input.Key }));

    it("deletes the departed member's processed object and stores the successor's", async () => {
      const res = await handler({
        Records: [
          { messageId: "m-departed", body: JSON.stringify({ bioguideId: "G000596" }) },
          { messageId: "m-successor", body: JSON.stringify({ bioguideId: "S000999" }) },
        ],
      });

      expect(res).toEqual({ batchItemFailures: [] });
      expect(writes()).toEqual(
        expect.arrayContaining([
          { type: "DeleteObjectCommand", key: "processed-congress-members/G000596.json" },
          { type: "PutObjectCommand", key: "processed-congress-members/S000999.json" },
        ]),
      );
      expect(writes()).toHaveLength(2);
      const put = mockS3Send.mock.calls
        .map(([cmd]: [FakeCommand]) => cmd)
        .find((cmd) => cmd.__type === "PutObjectCommand");
      expect(put!.input.Bucket).toBe("member-bucket");
      expect((JSON.parse(put!.input.Body!) as { member: unknown }).member).toEqual(
        expect.objectContaining({
          bioguideId: "S000999",
          chamber: "House of Representatives",
          district: 14,
          stateCode: "GA",
        }),
      );
    });

    it("keeps a member whose payload has no currentMember flag", async () => {
      rawByKey["raw-congress-members/X000001.json"] = {
        member: { ...successorRaw.member, bioguideId: "X000001", currentMember: undefined },
      };

      const res = await handler({ Records: [{ messageId: "m1", body: JSON.stringify({ bioguideId: "X000001" }) }] });

      expect(res).toEqual({ batchItemFailures: [] });
      expect(writes()).toEqual([{ type: "PutObjectCommand", key: "processed-congress-members/X000001.json" }]);
    });

    it("reports a failed retirement so it is retried", async () => {
      mockS3Send.mockImplementation(async (cmd: FakeCommand) => {
        if (cmd.__type === "GetObjectCommand") {
          return { Body: { transformToString: async () => JSON.stringify(departedRaw) } };
        }
        throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied" });
      });

      const res = await handler({ Records: [{ messageId: "m1", body: JSON.stringify({ bioguideId: "G000596" }) }] });

      expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    });
  });
});
