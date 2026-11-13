import type { RawBill } from "../models/bill";
import { refetchMessageFor } from "../../scripts/backfillCosponsors";

/** A raw bill as FetchRawBill stored it before the guid was canonical: metadata.guid keeps the text version. */
const rawBill = (guid: unknown, identifier: Partial<RawBill["identifier"]> = {}): RawBill =>
  ({
    schemaVersion: 1,
    kind: "raw",
    storedAt: "2026-10-11T22:26:22.338Z",
    identifier: { congress: "119", billType: "hr", billNumber: "1181", ...identifier },
    metadata: {
      guid,
      title: "Bans Special Merchant Codes for Firearms Retailers",
      pubDate: "2025-02-10T00:00:00.000Z",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/house-bill/1181",
      fetchedAt: "2026-10-11T22:26:22.338Z",
    },
    content: {},
  }) as RawBill;

describe("backfillCosponsors refetchMessageFor (REL-41)", () => {
  it("sends the plain guid for a raw bill whose metadata.guid keeps a text-version suffix", () => {
    expect(refetchMessageFor(rawBill("BILLS-119hr1181rh"))).toEqual({
      guid: "BILLS-119hr1181",
      title: "Bans Special Merchant Codes for Firearms Retailers",
      link: "https://www.congress.gov/bill/119th-congress/house-bill/1181",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/house-bill/1181",
      pubDate: "2025-02-10T00:00:00.000Z",
      congress: "119",
      billType: "hr",
      billNumber: "1181",
      bulk: true,
    });
  });

  // REL-58: the backfill runs inside a quiet window, so FetchRawBill retries its failures after a minute, never on
  // the hours-long ladder that could land them after the window closed.
  it("marks every message bulk", () => {
    expect(refetchMessageFor(rawBill("BILLS-119hr1181"))?.bulk).toBe(true);
  });

  it("passes a plain guid through, trimmed", () => {
    expect(refetchMessageFor(rawBill(" BILLS-119hr1181 "))?.guid).toBe("BILLS-119hr1181");
  });

  it("skips a raw bill without a guid or a full identifier", () => {
    expect(refetchMessageFor(rawBill(undefined))).toBeNull();
    expect(refetchMessageFor(rawBill(""))).toBeNull();
    expect(refetchMessageFor(rawBill("BILLS-119hr1181rh", { billNumber: "" }))).toBeNull();
  });
});
