import type { RawBill } from "../models/bill";
import { extractCommitteesFromRawBill } from "../shared/billCommittees";

describe("extractCommitteesFromRawBill", () => {
  it("returns content.committees.committees when present", () => {
    const rawBill = {
      kind: "raw",
      schemaVersion: 1,
      storedAt: "2025-01-01T00:00:00.000Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "1" },
      metadata: {
        guid: "BILLS-119hr1is",
        title: "Test",
        pubDate: "2025-01-01T00:00:00.000Z",
        link: "https://example.com",
        fetchedAt: "2025-01-01T00:00:00.000Z",
      },
      content: {
        committees: {
          committees: [{ name: "Judiciary" }, { name: "Health" }],
        },
      },
    } as RawBill;

    expect(extractCommitteesFromRawBill(rawBill)).toEqual([{ name: "Judiciary" }, { name: "Health" }]);
  });

  it("returns [] when path is missing", () => {
    const rawBill = { content: {} } as RawBill;
    expect(extractCommitteesFromRawBill(rawBill)).toEqual([]);
  });

  it("returns [] when committees is not an array", () => {
    const rawBill = { content: { committees: { committees: { not: "an array" } } } } as unknown as RawBill;
    expect(extractCommitteesFromRawBill(rawBill)).toEqual([]);
  });
});
