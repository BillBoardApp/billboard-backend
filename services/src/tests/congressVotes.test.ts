import type { OfficialVoteMember, OfficialVotePosition, RawBill } from "../models/bill";
import {
  MAX_DECISION_VOTES_BY_CHAMBER,
  countVotesByPosition,
  extractHouseRollCallRef,
  extractOfficialVotesFromActions,
  extractSenateRollCallRef,
  hasVoteRelatedActionForChamber,
  houseCountsFromMembers,
  mergeHouseMembersIntoOfficialVotes,
  parseYeaNayFromText,
  type VoteChamber,
} from "../shared/congressVotes";

const baseRawBill = (actions: unknown[]): RawBill => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-02-01T00:00:00.000Z",
  identifier: {
    congress: "119",
    billType: "senate-bill",
    billNumber: "42",
  },
  metadata: {
    guid: "BILLS-119s42is",
    title: "S. 42",
    pubDate: "2026-02-01T00:00:00.000Z",
    fetchedAt: "2026-02-01T00:00:00.000Z",
  },
  content: {
    actions: {
      actions,
    },
  },
});

describe("congressVotes", () => {
  it("selects the most recent Senate vote action, not the first one returned", () => {
    const rawBill = baseRawBill([
      {
        actionCode: "17000",
        actionDate: "2026-01-10",
        voteNumber: "21",
        text: "Passed Senate, Yea-Nay Vote. 54 - 46. Record Vote Number: 21.",
      },
      {
        actionCode: "17000",
        actionDate: "2026-02-11",
        voteNumber: "77",
        text: "Passed Senate, Yea-Nay Vote. 60 - 40. Record Vote Number: 77.",
      },
    ]);

    const officialVotes = extractOfficialVotesFromActions(rawBill.content as Record<string, unknown>);
    const ref = extractSenateRollCallRef(rawBill);

    expect(ref?.rollCallNumber).toBe("77");
    expect(officialVotes?.senate?.yea).toBe(60);
    expect(officialVotes?.senate?.nay).toBe(40);
    expect(officialVotes?.senate?.actionDate).toBe("2026-02-11");
  });

  it("extracts the Senate roll call number from recordedVotes when the action text only has record vote wording", () => {
    const rawBill = baseRawBill([
      {
        actionDate: "2026-02-11",
        recordedVotes: [
          {
            chamber: "Senate",
            congress: 119,
            date: "2026-02-11T21:00:00Z",
            rollNumber: 77,
            sessionNumber: 2,
            url: "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00077.xml",
          },
        ],
        sourceSystem: { name: "Senate" },
        text: "Passed Senate, Yea-Nay Vote. 60 - 40. Record Vote Number: 77.",
        type: "Floor",
      },
      {
        actionCode: "17000",
        actionDate: "2026-02-11",
        recordedVotes: [
          {
            chamber: "Senate",
            congress: 119,
            date: "2026-02-11T21:00:00Z",
            rollNumber: 77,
            sessionNumber: 2,
            url: "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00077.xml",
          },
        ],
        sourceSystem: { code: 9, name: "Library of Congress" },
        text: "Passed/agreed to in Senate: Passed Senate by Yea-Nay Vote. 60 - 40. Record Vote Number: 77.",
        type: "Floor",
      },
    ]);

    const ref = extractSenateRollCallRef(rawBill);

    expect(ref?.rollCallNumber).toBe("77");
    expect(ref?.actionDate).toBe("2026-02-11");
  });

  it("prefers the latest House action with a roll call reference", () => {
    const rawBill = baseRawBill([
      {
        actionCode: "8000",
        actionDate: "2026-01-12",
        rollCallNumber: "33",
        text: "On passage Passed by the Yeas and Nays: 221 - 214 (Roll no. 33).",
      },
      {
        actionCode: "8000",
        actionDate: "2026-02-18",
        rollCallNumber: "105",
        text: "On passage Passed by the Yeas and Nays: 225 - 210 (Roll no. 105).",
      },
    ]);

    const ref = extractHouseRollCallRef(rawBill);

    expect(ref?.rollCallNumber).toBe("105");
    expect(ref?.sessionNumber).toBe("2");
    expect(ref?.actionDate).toBe("2026-02-18");
  });

  it("extracts House yea/nay counts when the vote text includes a parenthetical threshold", () => {
    const rawBill = baseRawBill([
      {
        actionCode: "H37300",
        actionDate: "2026-02-09",
        recordedVotes: [
          {
            chamber: "House",
            congress: 119,
            date: "2026-02-10T00:07:28Z",
            rollNumber: 58,
            sessionNumber: 2,
            url: "https://clerk.house.gov/evs/2026/roll058.xml",
          },
        ],
        sourceSystem: { code: 2, name: "House floor actions" },
        text: "On motion to suspend the rules and pass the bill, as amended Agreed to by the Yeas and Nays: (2/3 required): 395 - 2 (Roll no. 58).",
        type: "Floor",
      },
    ]);

    const officialVotes = extractOfficialVotesFromActions(rawBill.content as Record<string, unknown>);
    const ref = extractHouseRollCallRef(rawBill);

    expect(ref?.rollCallNumber).toBe("58");
    expect(officialVotes?.house?.yea).toBe(395);
    expect(officialVotes?.house?.nay).toBe(2);
    expect(officialVotes?.house?.actionDate).toBe("2026-02-09");
  });

  it("treats procedural Senate vote actions as vote-related even before roll call extraction succeeds", () => {
    const rawBill = baseRawBill([
      {
        actionDate: "2026-01-15",
        text: "Cloture motion on the motion to proceed presented in Senate. (CR S262)",
      },
    ]);

    expect(hasVoteRelatedActionForChamber(rawBill, "senate")).toBe(true);
    expect(extractSenateRollCallRef(rawBill)).toBeNull();
  });

  it("prefers Senate metadata over mixed House/Senate wording in the action text", () => {
    const rawBill = baseRawBill([
      {
        actionDate: "2026-03-17",
        recordedVotes: [
          {
            chamber: "Senate",
            congress: 119,
            date: "2026-03-17T20:09:58Z",
            rollNumber: 57,
            sessionNumber: 2,
            url: "https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00057.xml",
          },
        ],
        sourceSystem: { name: "Senate" },
        text: "Motion to proceed to consideration of the House message to accompany S. 42 agreed to in Senate by Yea-Nay Vote. 51 - 48. Record Vote Number: 57.",
        type: "Floor",
      },
    ]);

    const ref = extractSenateRollCallRef(rawBill);

    expect(ref?.rollCallNumber).toBe("57");
    expect(ref?.actionDate).toBe("2026-03-17");
  });

  // REL-31: action texts from production raw bills (Sep 2026). Tallies must survive; Congressional
  // Record page ranges, document numbers and dates must never become one.
  describe("parseYeaNayFromText", () => {
    const tallies: Array<[string, VoteChamber, { yea: number; nay: number }]> = [
      [
        "On motion to suspend the rules and pass the bill, as amended Agreed to by the Yeas and Nays: (2/3 required): 395 - 2 (Roll no. 58). (text: CR H2078-2079)",
        "house",
        { yea: 395, nay: 2 },
      ],
      [
        "On passage Passed by the Yeas and Nays: 215 - 214, 1 Present (Roll no. 145). (text: CR H2235-2334)",
        "house",
        { yea: 215, nay: 214 },
      ],
      [
        "On passage Passed by the Yeas and Nays: 214 - 193 (Roll no. 78). (text: 3/26/2024 CR H1284)",
        "house",
        { yea: 214, nay: 193 },
      ],
      [
        "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 231 - 191 (Roll no. 111). (text: CR H1741: 6)",
        "house",
        { yea: 231, nay: 191 },
      ],
      [
        "On agreeing to the resolution Agreed to by recorded vote: 208 - 187 (Roll no. 74). (text: CR H2269)",
        "house",
        { yea: 208, nay: 187 },
      ],
      [
        "Passed/agreed to in House: On agreeing to the resolution Agreed to by recorded vote: 213 - 211 (Roll no. 92). (text: CR H1473: 2)",
        "house",
        { yea: 213, nay: 211 },
      ],
      [
        "On motion that the House agree to the Senate amendment Agreed to by recorded vote: 218 - 214 (Roll no. 190). (text: CR H3059-3143)",
        "house",
        { yea: 218, nay: 214 },
      ],
      [
        "Failed of passage/not agreed to in House On agreeing to the resolution Failed by recorded vote: 214 - 217 (Roll no. 60).",
        "house",
        { yea: 214, nay: 217 },
      ],
      [
        "On motion to suspend the rules and agree to the resolution Agreed to by the Yeas and Nays: (2/3 required): 400 - 0, 2 Present (Roll no. 159). (text: CR H2539)",
        "house",
        { yea: 400, nay: 0 },
      ],
      ["Failed of passage in House: Failed by the Yeas and Nays: 180 - 250.", "house", { yea: 180, nay: 250 }],
      [
        "Passed Senate without amendment by Yea-Nay Vote. 51 - 43. Record Vote Number: 623. (consideration: CR S8249-8259; text: CR S8249)",
        "senate",
        { yea: 51, nay: 43 },
      ],
      [
        "Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 51 - 46. Record Vote Number: 161. (CR S2137-2138)",
        "senate",
        { yea: 51, nay: 46 },
      ],
      [
        "Upon reconsideration, under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 55 - 45. Record Vote Number: 535.",
        "senate",
        { yea: 55, nay: 45 },
      ],
      // The Vice President's tie-breaking vote makes 101.
      [
        "Passed/agreed to in Senate: Passed Senate with an amendment by Yea-Nay Vote. 51 - 50. Record Vote Number: 372.",
        "senate",
        { yea: 51, nay: 50 },
      ],
      ["Passed Senate by Yea-Nay Vote. 60 - 40. Roll Call No. 51.", "senate", { yea: 60, nay: 40 }],
    ];

    it.each(tallies)("reads the tally in %j", (text, chamber, expected) => {
      expect(parseYeaNayFromText(text, chamber)).toEqual(expected);
    });

    const notTallies: Array<[string, VoteChamber]> = [
      ["Passed/agreed to in House: On passage Passed without objection. (text: CR H4758-4759)", "house"],
      [
        "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote. (text: CR H442-443)",
        "house",
      ],
      [
        "Passed/agreed to in House: On agreeing to the resolution Agreed to without objection. (text: CR H74-75)",
        "house",
      ],
      [
        "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H4279-4280: 1)",
        "house",
      ],
      [
        "On agreeing to the resolution, as amended Agreed to without objection. (text of amendment in the nature of a substitute: CR H1215-1216)",
        "house",
      ],
      [
        "On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (consideration: CR H2866-2867)",
        "house",
      ],
      [
        "Passed Senate without amendment by Unanimous Consent. (consideration: CR S3137-3138; text: CR S3137-3138)",
        "senate",
      ],
      [
        "Passed Senate with an amendment by Unanimous Consent. (consideration: CR S8533-8535; text: CR S8533--8535)",
        "senate",
      ],
      [
        "Motion to proceed to consideration of measure agreed to in Senate by Voice Vote. (consideration: CR S141-143, S157)",
        "senate",
      ],
      [
        "Submitted in the Senate, considered, and agreed to without amendment by Unanimous Consent. (consideration: CR S6-7; text: CR S6-7)",
        "senate",
      ],
      [
        "The committee substitute as amended agreed to by Unanimous Consent. (text of amendment in the nature of a substitute: CR S7-10)",
        "senate",
      ],
      [
        "Pursuant to the provisions of H. Res. 1142, the Senate amendment to H.R. 7147 is considered as agreed to with an amendment consisting of the text of Rules Committee Print 119-21.",
        "senate",
      ],
      ["Passed House, as reported in H. Rept. 119-45, by voice vote.", "house"],
      ["Agreed to in House. Became Public Law No: 119-21.", "house"],
      ["Motion agreed to by voice vote on 9-18-2025.", "senate"],
      ["Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent.", "senate"],
    ];

    it.each(notTallies)("finds no tally in %j", (text, chamber) => {
      expect(parseYeaNayFromText(text, chamber)).toBeNull();
    });

    it("rejects a tally larger than the chamber", () => {
      expect(MAX_DECISION_VOTES_BY_CHAMBER).toEqual({ house: 441, senate: 101 });
      expect(parseYeaNayFromText("On passage Passed by recorded vote: 300 - 141 (Roll no. 1).", "house")).toEqual({
        yea: 300,
        nay: 141,
      });
      expect(parseYeaNayFromText("On passage Passed by recorded vote: 300 - 142 (Roll no. 1).", "house")).toBeNull();
      expect(
        parseYeaNayFromText("Passed Senate by Yea-Nay Vote. 51 - 51. Record Vote Number: 1.", "senate"),
      ).toBeNull();
      expect(parseYeaNayFromText("Passed Senate by Yea-Nay Vote. 51 - 51. Record Vote Number: 1.")).toEqual({
        yea: 51,
        nay: 51,
      });
    });

    it("never reads a run of 4 or more digits as a count", () => {
      expect(parseYeaNayFromText("Agreed to by recorded vote: 4758-4759.")).toBeNull();
    });
  });

  it("stores no House vote for a voice vote whose text cites a Congressional Record page range (hjres133)", () => {
    const rawBill = baseRawBill([
      {
        actionCode: "8000",
        actionDate: "2025-11-18",
        sourceSystem: { code: 9, name: "Library of Congress" },
        text: "Passed/agreed to in House: On passage Passed without objection. (text: CR H4758-4759)",
        type: "Floor",
      },
      {
        actionCode: "H38310",
        actionDate: "2025-11-18",
        sourceSystem: { code: 2, name: "House floor actions" },
        text: "On passage Passed without objection. (text: CR H4758-4759)",
        type: "Floor",
      },
    ]);

    expect(hasVoteRelatedActionForChamber(rawBill, "house")).toBe(true);
    expect(extractOfficialVotesFromActions(rawBill.content as Record<string, unknown>)).toBeUndefined();
  });

  it("falls back to an earlier real tally when the latest vote action only cites Record pages", () => {
    const rawBill = baseRawBill([
      {
        actionCode: "8000",
        actionDate: "2026-01-20",
        text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 231 - 196, 2 Present (Roll no. 58).",
      },
      {
        actionCode: "17000",
        actionDate: "2026-03-02",
        text: "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent. (consideration: CR S1789-1790)",
      },
      {
        actionCode: "8000",
        actionDate: "2026-04-27",
        text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H3111-3112)",
      },
    ]);

    const officialVotes = extractOfficialVotesFromActions(rawBill.content as Record<string, unknown>);

    expect(officialVotes?.house).toMatchObject({ yea: 231, nay: 196, actionDate: "2026-01-20" });
    expect(officialVotes?.senate).toBeUndefined();
  });

  describe("House member rows and the Present and Not voting figures", () => {
    const row = (bioguideId: string, votePosition: OfficialVotePosition): OfficialVoteMember => ({
      bioguideId,
      displayName: bioguideId,
      votePosition,
    });
    // congress.gov's action text states only Yea and Nay, so the header's Present and Not voting are 0.
    const houseBill = (yea = 2, nay = 1): RawBill =>
      baseRawBill([
        {
          actionCode: "8000",
          actionDate: "2026-07-23",
          recordedVotes: [{ chamber: "House", congress: 119, sessionNumber: 2, rollNumber: 278 }],
          text: `On passage Passed by the Yeas and Nays: ${yea} - ${nay} (Roll no. 278).`,
        },
      ]);
    const rows = [row("A1", "Yea"), row("A2", "Yea"), row("B1", "Nay"), row("C1", "Present"), row("D1", "Not Voting")];

    it("counts each position, an Unknown row nowhere", () => {
      expect(countVotesByPosition([...rows, row("E1", "Unknown")])).toEqual({
        yea: 2,
        nay: 1,
        present: 1,
        notVoting: 1,
        totalCounted: 5,
      });
      expect(countVotesByPosition([])).toEqual({ yea: 0, nay: 0, present: 0, notVoting: 0, totalCounted: 0 });
    });

    it("counts Present and Not voting from rows whose Yea and Nay match the header, keeping the official Yea and Nay", () => {
      expect(extractOfficialVotesFromActions(houseBill().content as Record<string, unknown>)?.house).toMatchObject({
        yea: 2,
        nay: 1,
        present: 0,
        notVoting: 0,
        totalCounted: 3,
      });

      const merged = mergeHouseMembersIntoOfficialVotes(houseBill(), rows);

      expect(merged?.house).toMatchObject({
        yea: 2,
        nay: 1,
        present: 1,
        notVoting: 1,
        totalCounted: 5,
        actionCode: "8000",
        actionDate: "2026-07-23",
        memberDataAvailable: true,
        members: rows,
      });
      expect(merged?.completeness).toBe("complete");
    });

    it("keeps the header as it is when the rows' Yea or Nay differ from it (another roll call, or rows missing)", () => {
      const header = { present: 0, notVoting: 5, totalCounted: 436 };
      const bill = houseBill(220, 211);
      const stored = extractOfficialVotesFromActions(bill.content as Record<string, unknown>)!;
      (bill.content as Record<string, unknown>).officialVotes = { ...stored, house: { ...stored.house!, ...header } };

      const merged = mergeHouseMembersIntoOfficialVotes(bill, rows);

      expect(merged?.house).toMatchObject({ yea: 220, nay: 211, ...header, memberDataAvailable: true, members: rows });
      expect(houseCountsFromMembers({ yea: 3, nay: 1 }, rows)).toBeNull();
      expect(houseCountsFromMembers({ yea: 2, nay: 0 }, rows)).toBeNull();
    });

    it("keeps the header and marks no member data for an empty list", () => {
      const merged = mergeHouseMembersIntoOfficialVotes(houseBill(), []);

      expect(merged?.house).toMatchObject({
        yea: 2,
        nay: 1,
        present: 0,
        notVoting: 0,
        totalCounted: 3,
        memberDataAvailable: false,
        members: [],
      });
      expect(houseCountsFromMembers({ yea: 0, nay: 0 }, [])).toBeNull();
    });

    it("counts a repeated row once", () => {
      const repeated = [...rows, row("A1", "Yea"), row("D1", "Not Voting"), row("C1", "Present")];

      const merged = mergeHouseMembersIntoOfficialVotes(houseBill(), repeated);

      expect(merged?.house).toMatchObject({ yea: 2, nay: 1, present: 1, notVoting: 1, totalCounted: 5, members: rows });
      expect(houseCountsFromMembers({ yea: 2, nay: 1 }, repeated)).toEqual({
        present: 1,
        notVoting: 1,
        totalCounted: 5,
      });
    });
  });
});
