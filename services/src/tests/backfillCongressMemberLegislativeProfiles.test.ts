const backfill = require("../../scripts/backfillCongressMemberLegislativeProfiles.cjs");

/** A processed bill as BillSummarizer stored it from a U9b message: the guid keeps the text version (REL-41). */
const processed = (guid: string, extra: Record<string, unknown> = {}) => ({
  guid,
  storedAt: "2026-10-11T22:26:52.772Z",
  sponsors: ["S000001"],
  cosponsors: ["C000001", "S000001"],
  civicProfile: { localVsFederal: 0.4 },
  ...extra,
});

describe("backfillCongressMemberLegislativeProfiles buildLegislativeRows (REL-41)", () => {
  it("keys every row by the plain guid, as congressMemberStats does", () => {
    const row = { occurredAt: "2026-10-11T22:26:52.772Z", civicProfile: { localVsFederal: { N: "0.4" } } };
    expect(backfill.buildLegislativeRows(processed("BILLS-119hr1181rh"))).toEqual([
      { bioguideId: "S000001", billGuid: "BILLS-119hr1181", evidenceType: "sponsor", ...row },
      { bioguideId: "C000001", billGuid: "BILLS-119hr1181", evidenceType: "cosponsor", ...row },
    ]);
  });

  it("passes a plain guid through, and writes nothing without a guid or a civic profile", () => {
    const guids = (payload: unknown) =>
      backfill.buildLegislativeRows(payload).map((row: { billGuid: string }) => row.billGuid);
    expect(guids(processed(" BILLS-119s3697 "))).toEqual(["BILLS-119s3697", "BILLS-119s3697"]);
    expect(guids(processed(""))).toEqual([]);
    expect(guids(processed("BILLS-119hr1181rh", { civicProfile: undefined }))).toEqual([]);
  });
});
