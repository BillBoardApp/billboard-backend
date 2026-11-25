import type { RawBill } from "../models/bill";
import { extractActionsFromRawBill, isRoutineFollowUpText } from "../shared/billActions";

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

describe("isRoutineFollowUpText", () => {
  it.each([
    "Motion to reconsider laid on the table Agreed to without objection.",
    "Placed on the Union Calendar, Calendar No. 123.",
    "Placed on Senate Legislative Calendar under General Orders. Calendar No. 210.",
    "Message on Senate action sent to the House.",
    "Held at the desk.",
  ])("passes over %s", (text) => {
    expect(isRoutineFollowUpText(text)).toBe(true);
  });

  it.each([
    "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.",
    "Received in the Senate and Read twice and referred to the Committee on Finance.",
    "Reported by the Committee on Energy and Commerce. H. Rept. 119-876.",
  ])("keeps %s", (text) => {
    expect(isRoutineFollowUpText(text)).toBe(false);
  });
});
