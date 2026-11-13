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

    it("scans the 119th prefix with no flag, even after the 120th starts", () => {
      jest.useFakeTimers().setSystemTime(new Date("2027-01-04T12:00:00Z")); // the day after the 120th starts
      const script = loadScript([]);
      expect(script.CONGRESS).toBe("119");
      expect(script.PREFIX).toBe("raw-bills/BILLS-119");
      expect(loadScript(["--congress", "119"]).PREFIX).toBe("raw-bills/BILLS-119");
    });

    it("refuses any other Congress", () => {
      jest.useFakeTimers().setSystemTime(new Date("2027-01-04T12:00:00Z"));
      expect(() => loadScript(["--congress", "120"])).toThrow(/119/);
      expect(() => loadScript(["--congress"])).toThrow(/119/);
    });
  });
});
