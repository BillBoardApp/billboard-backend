import {
  congressInSessionAt,
  congressOfBillGuid,
  counterAttributesFor,
  countedCongressesAt,
  latestCountedCongressAt,
  memberCountsFromItem,
  memberCountsProjection,
} from "../shared/memberCounters";

const at = (iso: string) => Date.parse(iso);

describe("memberCounters (REL-46)", () => {
  it("reads a bill guid's Congress", () => {
    expect(congressOfBillGuid("BILLS-119hr1234ih")).toBe(119);
    expect(congressOfBillGuid("BILLS-120s5")).toBe(120);
    expect(congressOfBillGuid("not-a-bill")).toBeNull();
  });

  it.each([
    ["2025-01-03T16:59:59Z", 118],
    ["2025-01-03T17:00:00Z", 119],
    ["2026-11-23T12:00:00Z", 119],
    ["2027-01-03T16:59:59Z", 119],
    ["2027-01-03T17:00:00Z", 120],
    ["2028-06-01T00:00:00Z", 120],
    ["2029-01-03T17:00:00Z", 121],
  ])("the Congress in session at %s is the %ith", (iso, congress) => {
    expect(congressInSessionAt(at(iso))).toBe(congress);
  });

  it("counts a new Congress from a day before its start, so a clock a little behind still counts its first bills", () => {
    expect(latestCountedCongressAt(at("2027-01-02T16:59:59Z"))).toBe(119);
    expect(latestCountedCongressAt(at("2027-01-02T17:00:00Z"))).toBe(120);
    expect(countedCongressesAt(at("2026-11-23T12:00:00Z"))).toEqual([119]);
    expect(countedCongressesAt(at("2027-01-05T12:00:00Z"))).toEqual([119, 120]);
  });

  it("keeps the 119th's original attributes and names each later Congress's with its number", () => {
    const now = at("2027-01-05T12:00:00Z");
    expect(counterAttributesFor(119, now)).toEqual({
      congress: 119,
      sponsored: "billsSponsored",
      supported: "billsSupported",
      sponsoredGuids: "sponsoredBillGuids",
      supportedGuids: "supportedBillGuids",
    });
    expect(counterAttributesFor(120, now)).toEqual({
      congress: 120,
      sponsored: "billsSponsored120",
      supported: "billsSupported120",
      sponsoredGuids: "sponsoredBillGuids120",
      supportedGuids: "supportedBillGuids120",
    });
  });

  it("counts no earlier Congress, none not yet in session, and no fraction", () => {
    const now = at("2027-01-05T12:00:00Z");
    expect(counterAttributesFor(118, now)).toBeNull();
    expect(counterAttributesFor(121, now)).toBeNull();
    expect(counterAttributesFor(120, at("2026-11-23T12:00:00Z"))).toBeNull();
    expect(counterAttributesFor(119.5, now)).toBeNull();
  });

  it("projects every counter of every counted Congress", () => {
    expect(memberCountsProjection("bioguideId", at("2027-01-05T12:00:00Z"))).toEqual({
      ProjectionExpression: "#pk, #c0, #c1, #c2, #c3",
      ExpressionAttributeNames: {
        "#pk": "bioguideId",
        "#c0": "billsSponsored",
        "#c1": "billsSupported",
        "#c2": "billsSponsored120",
        "#c3": "billsSupported120",
      },
    });
  });

  describe("memberCountsFromItem", () => {
    const now = at("2027-01-05T12:00:00Z");

    it("gives the 119th counts and the newest Congress's", () => {
      expect(
        memberCountsFromItem(
          {
            billsSponsored: { N: "4" },
            billsSupported: { N: "9" },
            billsSponsored120: { N: "1" },
            billsSupported120: { N: "0" },
          },
          now,
        ),
      ).toEqual({
        tracked: { congress: 119, sponsored: 4, supported: 9 },
        current: { congress: 120, sponsored: 1, supported: 0 },
      });
    });

    it("falls back to the 119th when the member has no later counter", () => {
      expect(memberCountsFromItem({ billsSponsored: { N: "0" }, billsSupported: { N: "0" } }, now)).toEqual({
        tracked: { congress: 119, sponsored: 0, supported: 0 },
        current: { congress: 119, sponsored: 0, supported: 0 },
      });
    });

    it("gives no 119th counts for a row with later counters only (D8)", () => {
      expect(memberCountsFromItem({ billsSupported120: { N: "2" } }, now)).toEqual({
        tracked: null,
        current: { congress: 120, sponsored: 0, supported: 2 },
      });
    });

    it("gives nothing for a row with no counter, and reads a malformed count as 0", () => {
      expect(memberCountsFromItem({ bioguideId: { S: "A000001" } }, now)).toEqual({ tracked: null, current: null });
      expect(memberCountsFromItem({ billsSponsored: { N: "x" } }, now).tracked).toEqual({
        congress: 119,
        sponsored: 0,
        supported: 0,
      });
    });

    it("ignores a counter of a Congress not yet counted", () => {
      expect(memberCountsFromItem({ billsSponsored120: { N: "1" } }, at("2026-11-23T12:00:00Z"))).toEqual({
        tracked: null,
        current: null,
      });
    });
  });
});
