import type { RawBill } from "../models/bill";
import { extractActionsFromRawBill } from "../shared/billActions";

describe("extractActionsFromRawBill", () => {
  it("returns content.actions.actions when present", () => {
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
        actions: {
          actions: [{ actionCode: "intro" }, { actionCode: "ref" }],
        },
      },
    } as RawBill;

    expect(extractActionsFromRawBill(rawBill)).toEqual([{ actionCode: "intro" }, { actionCode: "ref" }]);
  });

  it("returns [] when path is missing", () => {
    const rawBill = { content: {} } as RawBill;
    expect(extractActionsFromRawBill(rawBill)).toEqual([]);
  });

  it("returns [] when actions is not an array", () => {
    const rawBill = { content: { actions: { actions: { not: "an array" } } } } as unknown as RawBill;
    expect(extractActionsFromRawBill(rawBill)).toEqual([]);
  });
});
