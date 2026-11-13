import {
  buildBillGuid,
  buildLegislationUrl,
  normalizeBillType,
  normalizeIsoDate,
  toBillMessage,
  toTrimmedString,
} from "../shared/billListRow";

// The poller's message for a congress.gov list row (REL-56 moved it here so the backfill sends exactly the same
// message for a bill that was never stored). The poller's own tests still drive it through the handler.

describe("toBillMessage", () => {
  it("builds the poller's message for a list row (golden)", () => {
    const row = {
      congress: 119,
      latestAction: { actionDate: "2026-10-15", text: " Referred to the House Committee on Ways and Means. " },
      number: "10953",
      originChamber: "House",
      title: " A bill to do something. ",
      type: "HR",
      updateDate: "2026-10-16",
      updateDateIncludingText: "2026-10-16",
      url: "https://api.congress.gov/v3/bill/119/hr/10953?format=json",
    };
    expect(toBillMessage(row, "hr", "119")).toEqual({
      guid: "BILLS-119hr10953",
      title: "A bill to do something.",
      link: "https://www.congress.gov/bill/119th-congress/house-bill/10953",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/house-bill/10953",
      pubDate: "2026-10-16T00:00:00.000Z",
      category: "Congress API",
      description: "Referred to the House Committee on Ways and Means.",
      congress: "119",
      billType: "hr",
      billNumber: "10953",
      updateDate: "2026-10-16T00:00:00.000Z",
    });
  });

  it("uses the list's congress and type when the row has none (a numeric congress is not a string)", () => {
    expect(toBillMessage({ congress: 119, number: "7", updateDate: "2026-11-05" }, "sres", "119")).toMatchObject({
      guid: "BILLS-119sres7",
      congress: "119",
      billType: "sres",
      link: "https://www.congress.gov/bill/119th-congress/senate-resolution/7",
    });
  });

  it("leaves pubDate empty and updateDate out when the row has no date at all", () => {
    const message = toBillMessage({ type: "S", number: "12", title: "T", description: "Fallback text" }, "s", "119");
    expect(message).toEqual({
      guid: "BILLS-119s12",
      title: "T",
      link: "https://www.congress.gov/bill/119th-congress/senate-bill/12",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/senate-bill/12",
      pubDate: "",
      category: "Congress API",
      description: "Fallback text",
      congress: "119",
      billType: "s",
      billNumber: "12",
    });
    expect(message).not.toHaveProperty("updateDate");
  });

  it("falls back to updatedAt, then the latest action's date", () => {
    expect(toBillMessage({ number: "1", updatedAt: "2026-10-01T10:00:00Z" }, "hr", "119")?.updateDate).toBe(
      "2026-10-01T10:00:00.000Z",
    );
    expect(toBillMessage({ number: "1", latestAction: { actionDate: "2026-09-30" } }, "hr", "119")?.pubDate).toBe(
      "2026-09-30T00:00:00.000Z",
    );
    expect(toBillMessage({ number: "1", latestAction: { action_date: "2026-09-29" } }, "hr", "119")?.pubDate).toBe(
      "2026-09-29T00:00:00.000Z",
    );
  });

  it("reads a nested bill's type and number, and the human type names", () => {
    expect(
      toBillMessage({ bill: { type: "house-joint-resolution", number: "122" }, updateDate: "2026-11-06" }, "", "119"),
    ).toMatchObject({
      guid: "BILLS-119hjres122",
      billType: "hjres",
      billNumber: "122",
      legislationUrl: "https://www.congress.gov/bill/119th-congress/house-joint-resolution/122",
    });
    expect(toBillMessage({ billType: "SCONRES", billNumber: "21" }, "hr", "119")?.guid).toBe("BILLS-119sconres21");
  });

  it("returns null for a row that names no bill", () => {
    expect(toBillMessage({ title: "no number" }, "hr", "119")).toBeNull();
    expect(toBillMessage({ number: "1" }, "", "")).toBeNull();
  });
});

describe("the helpers", () => {
  it("normalizes dates, bill types, guids and legislation URLs as the poller always has", () => {
    expect(normalizeIsoDate(" 2026-10-16 ")).toBe("2026-10-16T00:00:00.000Z");
    expect(normalizeIsoDate("2026-10-16T08:05:48Z")).toBe("2026-10-16T08:05:48.000Z");
    expect(normalizeIsoDate("not a date")).toBeNull();
    expect(normalizeIsoDate(20261016)).toBeNull();
    expect(toTrimmedString(" x ")).toBe("x");
    expect(toTrimmedString(5)).toBe("");
    expect(
      ["HR", "senate-bill", "HJRES", "senate-joint-resolution", "hconres", "SCONRES", "house-resolution", "SRES"].map(
        normalizeBillType,
      ),
    ).toEqual(["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"]);
    expect(normalizeBillType("XYZ")).toBe("xyz");
    expect(buildBillGuid("119", "hres", "1610")).toBe("BILLS-119hres1610");
    expect(buildLegislationUrl("121", "sconres", "2")).toBe(
      "https://www.congress.gov/bill/121st-congress/senate-concurrent-resolution/2",
    );
    expect(buildLegislationUrl("112", "hr", "1")).toBe("https://www.congress.gov/bill/112th-congress/house-bill/1");
    expect(buildLegislationUrl("122", "hr", "1")).toBe("https://www.congress.gov/bill/122nd-congress/house-bill/1");
    expect(buildLegislationUrl("123", "hr", "1")).toBe("https://www.congress.gov/bill/123rd-congress/house-bill/1");
    expect(buildLegislationUrl("x", "zz", "1")).toBe("https://www.congress.gov/bill/xth-congress/zz/1");
  });
});
