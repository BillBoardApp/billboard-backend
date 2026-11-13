import type { RawBill } from "../models/bill";
import {
  extractCosponsorIdsFromRawBill,
  extractSponsorIdsFromRawBill,
  isCosponsorListTruncated,
} from "../shared/billSponsors";

const rawBill = (content: unknown): RawBill => ({ schemaVersion: 1, kind: "raw", content }) as unknown as RawBill;

describe("billSponsors (REL-28)", () => {
  it("reads sponsor ids from content.bill.bill.sponsors and cosponsor ids from content.cosponsors.cosponsors", () => {
    const bill = rawBill({
      bill: { bill: { sponsors: [{ bioguideId: "S000001", fullName: "Sen. One" }] } },
      cosponsors: { cosponsors: [{ bioguideId: "C000001" }, { bioguideId: "C000002" }] },
    });

    expect(extractSponsorIdsFromRawBill(bill)).toEqual(["S000001"]);
    expect(extractCosponsorIdsFromRawBill(bill)).toEqual(["C000001", "C000002"]);
  });

  it("skips entries without a bioguide id and returns [] when the lists are missing", () => {
    const bill = rawBill({
      bill: { bill: { sponsors: [null, { fullName: "No id" }, { bioguideId: "" }, { bioguideId: "S000002" }] } },
      cosponsors: { cosponsors: "not a list" },
    });

    expect(extractSponsorIdsFromRawBill(bill)).toEqual(["S000002"]);
    expect(extractCosponsorIdsFromRawBill(bill)).toEqual([]);
    expect(extractSponsorIdsFromRawBill(rawBill(undefined))).toEqual([]);
    expect(extractCosponsorIdsFromRawBill(rawBill({}))).toEqual([]);
  });

  describe("isCosponsorListTruncated", () => {
    const cosponsors = (count: number) => Array.from({ length: count }, (_, index) => ({ bioguideId: `C${index}` }));

    it("flags a first page stored with pagination.next still set", () => {
      const bill = rawBill({
        cosponsors: {
          cosponsors: cosponsors(20),
          pagination: { count: 45, next: "https://api.congress.gov/v3/bill/119/hr/1/cosponsors?offset=20&limit=20" },
        },
      });
      expect(isCosponsorListTruncated(bill)).toBe(true);
    });

    it("flags a list shorter than congress.gov's count", () => {
      expect(
        isCosponsorListTruncated(rawBill({ cosponsors: { cosponsors: cosponsors(20), pagination: { count: 21 } } })),
      ).toBe(true);
    });

    it("accepts a complete list, a merged multi-page list and a bill without cosponsors", () => {
      expect(
        isCosponsorListTruncated(rawBill({ cosponsors: { cosponsors: cosponsors(20), pagination: { count: 20 } } })),
      ).toBe(false);
      expect(
        isCosponsorListTruncated(rawBill({ cosponsors: { cosponsors: cosponsors(300), pagination: { count: 300 } } })),
      ).toBe(false);
      expect(isCosponsorListTruncated(rawBill({ cosponsors: { cosponsors: [], pagination: { count: 0 } } }))).toBe(
        false,
      );
      expect(isCosponsorListTruncated(rawBill({}))).toBe(false);
    });
  });
});
