import { congressInSessionAt, counterAttributesFor } from "../shared/memberCounters";

const backfill = require("../../scripts/backfillCongressMemberStats.cjs");

const rawBill = (sponsors: string[], cosponsors: string[]) => ({
  content: {
    bill: { bill: { sponsors: sponsors.map((bioguideId) => ({ bioguideId })) } },
    cosponsors: { cosponsors: cosponsors.map((bioguideId) => ({ bioguideId })) },
  },
});

describe("backfillCongressMemberStats (REL-07)", () => {
  it("derives the same bill guid from the raw key as the congressMemberStats handler", () => {
    expect(backfill.rawBillGuidFromKey("raw-bills/BILLS-119hr2312.json")).toBe("BILLS-119hr2312");
    expect(backfill.rawBillGuidFromKey("processed-bills/BILLS-119hr2312.json")).toBeNull();
  });

  it("rebuilds counters and guid sets from scratch, counting each bill once per member", () => {
    const tallies = backfill.createTallies();
    backfill.tallyRawBill(tallies, "raw-bills/BILLS-119hr1.json", rawBill(["A000001"], ["A000001", "B000002"]));
    backfill.tallyRawBill(tallies, "raw-bills/BILLS-119s2.json", rawBill(["B000002"], ["A000001", "A000001"]));

    expect(
      backfill.buildMemberUpdateInput("A000001", tallies.sponsored.get("A000001"), tallies.supported.get("A000001"), {
        tableName: "CongressMembersStats",
        primaryKey: "bioguideId",
      }),
    ).toEqual({
      TableName: "CongressMembersStats",
      Key: { bioguideId: { S: "A000001" } },
      UpdateExpression:
        "SET billsSponsored = :sponsored, billsSupported = :supported, sponsoredBillGuids = :sponsoredGuids, supportedBillGuids = :supportedGuids",
      ExpressionAttributeValues: {
        ":sponsored": { N: "1" },
        ":supported": { N: "1" },
        ":sponsoredGuids": { SS: ["BILLS-119hr1"] },
        ":supportedGuids": { SS: ["BILLS-119s2"] },
      },
    });
  });

  it("resets a member with no bills to zero and removes the empty sets", () => {
    expect(
      backfill.buildMemberUpdateInput("Z000009", undefined, undefined, { tableName: "T", primaryKey: "bioguideId" }),
    ).toEqual({
      TableName: "T",
      Key: { bioguideId: { S: "Z000009" } },
      UpdateExpression:
        "SET billsSponsored = :sponsored, billsSupported = :supported REMOVE sponsoredBillGuids, supportedBillGuids",
      ExpressionAttributeValues: {
        ":sponsored": { N: "0" },
        ":supported": { N: "0" },
      },
    });
  });

  describe("Congress selection (REL-46)", () => {
    const realArgv = process.argv;
    afterEach(() => {
      process.argv = realArgv;
      jest.useRealTimers();
    });

    // The script reads its flags when it loads, so load a fresh copy for each argv.
    const loadScript = (flags: string[]) => {
      process.argv = [...realArgv.slice(0, 2), ...flags];
      let loaded: typeof backfill | undefined;
      jest.isolateModules(() => {
        loaded = require("../../scripts/backfillCongressMemberStats.cjs");
      });
      return loaded as typeof backfill;
    };

    it("rebuilds the 119th with no flag, even after the 120th starts", () => {
      jest.useFakeTimers().setSystemTime(new Date("2027-01-04T12:00:00Z")); // the day after the 120th starts
      const script = loadScript([]);
      expect(script.CONGRESS).toBe("119");
      expect(script.PREFIX).toBe("raw-bills/BILLS-119");
      expect(script.ATTRIBUTES).toEqual({
        sponsored: "billsSponsored",
        supported: "billsSupported",
        sponsoredGuids: "sponsoredBillGuids",
        supportedGuids: "supportedBillGuids",
      });
      expect(loadScript(["--congress", "119"]).PREFIX).toBe("raw-bills/BILLS-119");
    });

    it("rebuilds the 120th from its own raw bills into its own attributes once it has started", () => {
      jest.useFakeTimers().setSystemTime(new Date("2027-01-04T12:00:00Z"));
      const script = loadScript(["--congress", "120"]);
      expect(script.CONGRESS).toBe("120");
      expect(script.PREFIX).toBe("raw-bills/BILLS-120");
      expect(script.ATTRIBUTES).toEqual({
        sponsored: "billsSponsored120",
        supported: "billsSupported120",
        sponsoredGuids: "sponsoredBillGuids120",
        supportedGuids: "supportedBillGuids120",
      });

      const tallies = script.createTallies();
      script.tallyRawBill(tallies, "raw-bills/BILLS-120hr1.json", rawBill(["A000001"], ["B000002"]));
      expect(
        script.buildMemberUpdateInput("A000001", tallies.sponsored.get("A000001"), undefined, {
          tableName: "CongressMembersStats",
          primaryKey: "bioguideId",
        }),
      ).toEqual({
        TableName: "CongressMembersStats",
        Key: { bioguideId: { S: "A000001" } },
        UpdateExpression:
          "SET billsSponsored120 = :sponsored, billsSupported120 = :supported, sponsoredBillGuids120 = :sponsoredGuids REMOVE supportedBillGuids120",
        ExpressionAttributeValues: {
          ":sponsored": { N: "1" },
          ":supported": { N: "0" },
          ":sponsoredGuids": { SS: ["BILLS-120hr1"] },
        },
      });
    });

    it("refuses an earlier Congress, one not yet in session, and a missing or malformed value", () => {
      jest.useFakeTimers().setSystemTime(new Date("2027-01-04T12:00:00Z"));
      expect(() => loadScript(["--congress", "118"])).toThrow(/119th Congress and each Congress from the 120th/);
      expect(() => loadScript(["--congress", "121"])).toThrow(/120th is in session/);
      expect(() => loadScript(["--congress"])).toThrow(/\(missing\)/);
      expect(() => loadScript(["--congress", "120th"])).toThrow(/not allowed/);
    });

    it("refuses the 120th before it starts", () => {
      jest.useFakeTimers().setSystemTime(new Date("2027-01-03T16:59:00Z"));
      expect(() => loadScript(["--congress", "120"])).toThrow(/119th is in session/);
    });

    it("resets only the rows that have this Congress's counters (a 120th-only row never gets 119th zeros)", () => {
      const attributes120 = backfill.counterAttributesFor(120);
      const newIn120th = { bioguideId: { S: "N000001" }, billsSupported120: { N: "2" } };
      const returning = { bioguideId: { S: "A000001" }, billsSponsored: { N: "4" }, billsSponsored120: { N: "1" } };
      expect(backfill.rowHasCongressCounters(newIn120th)).toBe(false);
      expect(backfill.rowHasCongressCounters(returning)).toBe(true);
      expect(backfill.rowHasCongressCounters(newIn120th, attributes120)).toBe(true);
      expect(backfill.rowHasCongressCounters({ bioguideId: { S: "Z000001" } }, attributes120)).toBe(false);
    });

    it("names the attributes and the Congress in session as the handler does (src/shared/memberCounters.ts)", () => {
      const at = Date.parse("2027-01-04T12:00:00Z");
      for (const congress of [119, 120]) {
        const { congress: _congress, ...shared } = counterAttributesFor(congress, at)!;
        expect(backfill.counterAttributesFor(String(congress))).toEqual(shared);
      }
      for (const iso of [
        "2025-01-03T16:59:59Z",
        "2025-01-03T17:00:00Z",
        "2026-11-23T00:00:00Z",
        "2027-01-03T17:00:00Z",
      ]) {
        expect(backfill.congressInSessionAt(Date.parse(iso))).toBe(congressInSessionAt(Date.parse(iso)));
      }
    });
  });
});
