import type { RawBill } from "../models/bill";
import {
  extractCosponsorIdsFromRawBill,
  extractSponsorDetailsFromRawBill,
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

  describe("extractSponsorDetailsFromRawBill (REL-46 5.3)", () => {
    const sponsoredBy = (...sponsors: unknown[]) => rawBill({ bill: { bill: { sponsors } } });

    it("names a representative from first and last name, with the party letter, state and two-digit district", () => {
      const bill = sponsoredBy({
        bioguideId: "D000001",
        firstName: "Jane",
        middleName: "Q.",
        lastName: "Doe",
        fullName: "Rep. Doe, Jane Q. [R-TX-7]",
        party: "R",
        state: "TX",
        district: 7,
        isByRequest: "N",
      });

      expect(extractSponsorDetailsFromRawBill(bill)).toEqual([
        { bioguideId: "D000001", name: "Jane Doe", title: "Rep", party: "R", state: "TX", district: "07" },
      ]);
    });

    it("keeps the title congress.gov puts before the name, so clients can say Delegate or Resident Commissioner", () => {
      const bill = sponsoredBy(
        { bioguideId: "D000005", fullName: "Del. Norton, Eleanor [D-DC-At Large]", state: "DC" },
        { bioguideId: "D000006", fullName: "Resident  Commissioner Ruiz, Ana [R-PR-At Large]", state: "PR" },
        { bioguideId: "D000007", fullName: "sen. Lee, Pat [R-UT]", state: "UT" },
        { bioguideId: "D000008", fullName: "Dr. Who, Al", state: "OH" },
        { bioguideId: "D000009", firstName: "No", lastName: "Title" },
      );

      expect(extractSponsorDetailsFromRawBill(bill).map((detail) => detail.title)).toEqual([
        "Del",
        "ResComm",
        "Sen",
        undefined,
        undefined,
      ]);
    });

    it("falls back to fullName without its title and bracket", () => {
      const bill = sponsoredBy(
        { bioguideId: "D000002", fullName: "Rep. Doe, Jane Q. [D-CA-12]", party: "D", state: "CA", district: 12 },
        { bioguideId: "D000003", fullName: "Resident Commissioner Ruiz, Ana [R-PR-At Large]", state: "PR" },
        { bioguideId: "D000004", fullName: "Sen. Lee" },
      );

      expect(extractSponsorDetailsFromRawBill(bill).map((detail) => detail.name)).toEqual([
        "Jane Q. Doe",
        "Ana Ruiz",
        "Lee",
      ]);
    });

    it("gives a senator a null district", () => {
      const bill = sponsoredBy({
        bioguideId: "S000001",
        firstName: "John",
        lastName: "Smith",
        party: "D",
        state: "NY",
      });

      expect(extractSponsorDetailsFromRawBill(bill)).toEqual([
        { bioguideId: "S000001", name: "John Smith", party: "D", state: "NY", district: null },
      ]);
    });

    it("writes an at-large seat or a delegate as 00", () => {
      const bill = sponsoredBy(
        { bioguideId: "W000001", firstName: "Al", lastName: "Wy", party: "R", state: "WY", district: 0 },
        { bioguideId: "P000001", firstName: "Ana", lastName: "Ruiz", party: "R", state: "PR", district: "At Large" },
      );

      expect(extractSponsorDetailsFromRawBill(bill).map((detail) => detail.district)).toEqual(["00", "00"]);
    });

    it("reads ID as an independent and leaves any other party code out rather than show a wrong letter", () => {
      const bill = sponsoredBy(
        { bioguideId: "I000001", firstName: "Ida", lastName: "Indy", party: "ID", state: "CT" },
        { bioguideId: "L000001", firstName: "Leo", lastName: "Lib", party: "L", state: "MI", district: 3 },
      );

      expect(extractSponsorDetailsFromRawBill(bill)).toEqual([
        { bioguideId: "I000001", name: "Ida Indy", party: "I", state: "CT", district: null },
        { bioguideId: "L000001", name: "Leo Lib", state: "MI", district: "03" },
      ]);
    });

    it("leaves out a sponsor without a bioguide id or a name, and a state that is not a two-letter code", () => {
      const bill = sponsoredBy(
        null,
        { firstName: "No", lastName: "Id" },
        { bioguideId: "N000001" },
        { bioguideId: "N000002", fullName: "Rep. [R-TX-1]" },
        { bioguideId: "N000003", firstName: "Sam", lastName: "Stone", state: "Texas" },
      );

      expect(extractSponsorDetailsFromRawBill(bill)).toEqual([
        { bioguideId: "N000003", name: "Sam Stone", district: null },
      ]);
      expect(extractSponsorDetailsFromRawBill(rawBill({}))).toEqual([]);
      expect(extractSponsorDetailsFromRawBill(rawBill(undefined))).toEqual([]);
    });
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
