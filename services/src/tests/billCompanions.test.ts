import {
  chamberOf,
  COUNTERPART,
  companionCandidateGraph,
  companionGroupsFromPairs,
  companionIndex,
  companionKey,
  companionStatsKey,
  extractIdenticalDeclarations,
  IDENTICAL_RELATIONSHIP_RE,
  normalizeBillTypeCode,
  parseBillGuid,
  pickCountedRowPerGroup,
  plainBillGuid,
  resolveCompanionGroups,
  sameDeclaredLinks,
  toCompanionGroupV1,
  type CompanionDeclaration,
} from "../shared/billCompanions";

/** A link-list row for `guid` declaring `targets` (plain guids). */
const decl = (guid: string, targets: string[], sourceFetchedAt = "2026-09-01T00:00:00.000Z"): CompanionDeclaration => {
  const self = parseBillGuid(guid)!;
  return {
    guid: self.plainGuid,
    congress: self.congress,
    billType: self.billType,
    billNumber: self.billNumber,
    declared: targets
      .map((target) => parseBillGuid(target)!)
      .map((ref) => ({
        guid: ref.plainGuid,
        congress: ref.congress,
        billType: ref.billType,
        billNumber: ref.billNumber,
      }))
      .sort((a, b) => (a.guid < b.guid ? -1 : 1)),
    truncated: false,
    sourceFetchedAt,
  };
};

const heldOnly =
  (...guids: string[]) =>
  (guid: string) =>
    guids.includes(guid);

type RelatedItem = { congress?: number | string; type: string; number: string | number; rels: string[] };

const item = ({ congress = 119, type, number, rels }: RelatedItem) => ({
  congress,
  type,
  number,
  title: "A title",
  latestAction: { actionDate: "2026-01-01", text: "Referred" },
  relationshipDetails: rels.map((relType) => ({ type: relType, identifiedBy: "CRS" })),
  url: `https://api.congress.gov/v3/bill/${congress}/${String(type).toLowerCase()}/${number}?format=json`,
});

const rawBill = (overrides: Record<string, unknown> = {}, related: RelatedItem[] = [], pagination = {}) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2026-09-02T00:00:00.000Z",
  identifier: { congress: "119", billType: "house-bill", billNumber: "1285" },
  metadata: { guid: "BILLS-119hr1285ih", title: "T", pubDate: "", fetchedAt: "2026-09-01T12:00:00.000Z" },
  content: {
    bill: { bill: { congress: 119, type: "HR", number: "1285" } },
    relatedBills: { relatedBills: related.map(item), pagination: { count: related.length, ...pagination } },
  },
  ...overrides,
});

describe("bill guids and types", () => {
  it("parses plain and suffixed guids, longest code first, and lowercases after BILLS-", () => {
    expect(parseBillGuid("BILLS-119hr1285")).toEqual({
      congress: "119",
      billType: "hr",
      billNumber: "1285",
      plainGuid: "BILLS-119hr1285",
      suffix: "",
    });
    expect(parseBillGuid(" BILLS-119HRES389ih ")).toMatchObject({
      billType: "hres",
      billNumber: "389",
      plainGuid: "BILLS-119hres389",
      suffix: "ih",
    });
    expect(parseBillGuid("BILLS-119hconres82")?.billType).toBe("hconres");
    expect(parseBillGuid("BILLS-119sconres32enr")).toMatchObject({ billType: "sconres", suffix: "enr" });
    expect(parseBillGuid("BILLS-119sjres91")?.billType).toBe("sjres");
    expect(parseBillGuid("BILLS-119sres208")?.billType).toBe("sres");
    expect(parseBillGuid("BILLS-119s570is")).toMatchObject({ billType: "s", plainGuid: "BILLS-119s570" });
    for (const bad of ["", "bills-119hr1", "BILLS-119xx1", "BILLS-hr1", "BILLS-119hr", "BILLS-115house-bill2253", 7]) {
      expect(parseBillGuid(bad)).toBeNull();
    }
    expect(parseBillGuid(`BILLS-119hr${"1".repeat(80)}`)).toBeNull();
    expect(plainBillGuid("BILLS-119hjres131ih")).toBe("BILLS-119hjres131");
    expect(plainBillGuid("nope")).toBeNull();
  });

  it("normalizes codes and slugs to lowercase codes", () => {
    expect(normalizeBillTypeCode("HR")).toBe("hr");
    expect(normalizeBillTypeCode("SCONRES")).toBe("sconres");
    expect(normalizeBillTypeCode("H.J.Res.")).toBe("hjres");
    expect(normalizeBillTypeCode("house-bill")).toBe("hr");
    expect(normalizeBillTypeCode("senate-bill")).toBe("s");
    expect(normalizeBillTypeCode("house-joint-resolution")).toBe("hjres");
    expect(normalizeBillTypeCode("senate-joint-resolution")).toBe("sjres");
    expect(normalizeBillTypeCode("house-concurrent-resolution")).toBe("hconres");
    expect(normalizeBillTypeCode("senate-concurrent-resolution")).toBe("sconres");
    expect(normalizeBillTypeCode("house-resolution")).toBe("hres");
    expect(normalizeBillTypeCode("Senate-Resolution")).toBe("sres");
    expect(normalizeBillTypeCode("amendment")).toBeNull();
    expect(normalizeBillTypeCode(undefined)).toBeNull();
    expect(normalizeBillTypeCode("  ")).toBeNull();
  });

  it("pairs each type with the other chamber's type of the same kind", () => {
    expect(COUNTERPART).toEqual({
      hr: "s",
      s: "hr",
      hjres: "sjres",
      sjres: "hjres",
      hconres: "sconres",
      sconres: "hconres",
      hres: "sres",
      sres: "hres",
    });
    expect(chamberOf("hconres")).toBe("House");
    expect(chamberOf("s")).toBe("Senate");
    expect(IDENTICAL_RELATIONSHIP_RE.test("Identical Bill (Became Law)")).toBe(true);
  });
});

describe("extractIdenticalDeclarations", () => {
  it("takes the identity from the S3 key, never from a suffixed metadata.guid (acceptance 2)", () => {
    const declaration = extractIdenticalDeclarations(
      rawBill({ metadata: { guid: "BILLS-119hr999ih", fetchedAt: "2026-09-01T12:00:00.000Z" } }),
      "raw-bills/BILLS-119hr1285.json",
    );
    expect(declaration).toMatchObject({ guid: "BILLS-119hr1285", congress: "119", billType: "hr", billNumber: "1285" });
  });

  it("falls back to content.bill, then to a slug identifier", () => {
    expect(extractIdenticalDeclarations(rawBill())?.guid).toBe("BILLS-119hr1285");
    const noContentBill = rawBill({
      identifier: { congress: "119", billType: "senate-bill", billNumber: "570" },
      content: { relatedBills: { relatedBills: [] } },
    });
    expect(extractIdenticalDeclarations(noContentBill, "raw-bills/not-a-guid.json")).toMatchObject({
      guid: "BILLS-119s570",
      billType: "s",
    });
    const flatBill = rawBill({ content: { bill: { congress: "119", type: "SJRES", number: 91 } } });
    expect(extractIdenticalDeclarations(flatBill)?.guid).toBe("BILLS-119sjres91");
    expect(extractIdenticalDeclarations({ identifier: { billType: "amendment" } })).toBeNull();
    expect(extractIdenticalDeclarations(null)).toBeNull();
  });

  it("keeps identical links, including 'Identical Bill (Became Law)', and drops every other type (acceptance 3)", () => {
    const declaration = extractIdenticalDeclarations(
      rawBill({}, [
        { type: "S", number: "570", rels: ["Identical bill"] },
        { type: "SJRES", number: "91", rels: ["Identical Bill (Became Law)"] },
        { type: "S", number: "1", rels: ["Related bill"] },
        { type: "HR", number: "2", rels: ["Procedurally related"] },
        { type: "HR", number: "3", rels: ["Cross-Congress related bill"] },
        { type: "S", number: "4", rels: ["Public law contains the text"] },
        { type: "S", number: "5", rels: ["Contained in public law"] },
        { type: "HR", number: "1285", rels: ["Identical bill"] },
        { type: "S", number: "6", rels: ["Related bill", "Identical bill"] },
        { type: "S", number: "570", rels: ["Identical bill"] },
      ]),
      "raw-bills/BILLS-119hr1285.json",
    );
    expect(declaration?.declared.map((ref) => ref.guid)).toEqual(["BILLS-119s570", "BILLS-119s6", "BILLS-119sjres91"]);
  });

  it("drops other Congresses and unknown types but keeps same-chamber and cross-kind links for the resolver", () => {
    const declaration = extractIdenticalDeclarations(
      rawBill({}, [
        { congress: 118, type: "S", number: "570", rels: ["Identical bill"] },
        { congress: "119", type: "HR", number: "44", rels: ["Identical bill"] },
        { type: "SCONRES", number: "9", rels: ["Identical bill"] },
        { type: "AMDT", number: "3", rels: ["Identical bill"] },
      ]),
    );
    expect(declaration?.declared).toEqual([
      { guid: "BILLS-119hr44", congress: "119", billType: "hr", billNumber: "44" },
      { guid: "BILLS-119sconres9", congress: "119", billType: "sconres", billNumber: "9" },
    ]);
  });

  it("records truncation from pagination.next only, and the freshness key", () => {
    const many = Array.from({ length: 3 }, (_, index) => ({
      type: "S",
      number: String(index + 1),
      rels: ["Related bill"],
    }));
    // count larger than the items is not truncation.
    expect(extractIdenticalDeclarations(rawBill({}, many, { count: 40 }))?.truncated).toBe(false);
    expect(
      extractIdenticalDeclarations(
        rawBill({}, many, { next: "https://api.congress.gov/v3/bill/119/hr/1285/relatedbills?offset=250" }),
      )?.truncated,
    ).toBe(true);
    expect(extractIdenticalDeclarations(rawBill())?.sourceFetchedAt).toBe("2026-09-01T12:00:00.000Z");
    expect(extractIdenticalDeclarations(rawBill({ metadata: { fetchedAt: "" } }))?.sourceFetchedAt).toBe(
      "2026-09-02T00:00:00.000Z",
    );
  });

  it("gives an empty list for a raw bill without related bills", () => {
    const declaration = extractIdenticalDeclarations(rawBill({ content: {} }), "raw-bills/BILLS-119hr7.json");
    expect(declaration).toMatchObject({ guid: "BILLS-119hr7", declared: [], truncated: false });
  });

  it("compares link lists by guids and truncation only", () => {
    const a = decl("BILLS-119hr1", ["BILLS-119s1"]);
    expect(sameDeclaredLinks(a, decl("BILLS-119hr1", ["BILLS-119s1"], "2027-01-01T00:00:00.000Z"))).toBe(true);
    expect(sameDeclaredLinks(a, { ...a, truncated: true })).toBe(false);
    expect(sameDeclaredLinks(a, decl("BILLS-119hr1", ["BILLS-119s2"]))).toBe(false);
    expect(sameDeclaredLinks(a, decl("BILLS-119hr1", []))).toBe(false);
  });
});

describe("resolveCompanionGroups", () => {
  it("forms a group from a link found on either side, and counts one-sided links (acceptance 1)", () => {
    const both = resolveCompanionGroups(
      [decl("BILLS-119hr1285", ["BILLS-119s570"]), decl("BILLS-119s570", ["BILLS-119hr1285"])],
      heldOnly("BILLS-119hr1285", "BILLS-119s570"),
    );
    expect(both.pairs).toEqual([["BILLS-119hr1285", "BILLS-119s570"]]);
    expect(both.oneSided).toBe(0);

    // Only the Senate bill lists the House bill (the House bill's copy is stale): still a group.
    const senateOnly = resolveCompanionGroups(
      [decl("BILLS-119s570", ["BILLS-119hr1285"]), decl("BILLS-119hr1285", [])],
      heldOnly("BILLS-119hr1285", "BILLS-119s570"),
    );
    expect(senateOnly.pairs).toEqual([["BILLS-119hr1285", "BILLS-119s570"]]);
    expect(senateOnly.oneSided).toBe(1);

    const houseOnly = resolveCompanionGroups(
      [decl("BILLS-119hr1285", ["BILLS-119s570"])],
      heldOnly("BILLS-119hr1285", "BILLS-119s570"),
    );
    expect(houseOnly.pairs).toEqual([["BILLS-119hr1285", "BILLS-119s570"]]);
    expect(houseOnly.oneSided).toBe(1);
  });

  it("excludes same-chamber, different-kind and cross-Congress links (acceptance 4)", () => {
    const result = resolveCompanionGroups(
      [
        decl("BILLS-119hr1", ["BILLS-119hr2"]),
        decl("BILLS-119hjres5", ["BILLS-119sconres6"]),
        {
          ...decl("BILLS-119hr3", []),
          declared: [{ guid: "BILLS-118s3", congress: "118", billType: "s", billNumber: "3" }],
        },
        decl("BILLS-119hconres7", ["BILLS-119hconres8"]),
      ],
      () => true,
    );
    expect(result.pairs).toEqual([]);
    expect(result.excluded).toEqual({ sameChamber: 2, crossKind: 1, crossCongress: 1, partnerNotHeld: 0 });
    expect(companionCandidateGraph([decl("BILLS-119hr1", ["BILLS-119s1", "BILLS-119hr2"])]).links).toEqual({
      counterpart: 1,
      sameChamber: 1,
      crossKind: 0,
      crossCongress: 0,
    });
  });

  it("leaves hubs, chains and yearly resolutions apart (acceptance 5)", () => {
    // 2025 and 2026 resolutions both listed as identical to sres208.
    const hub = resolveCompanionGroups(
      [decl("BILLS-119hres407", ["BILLS-119sres208"]), decl("BILLS-119hres1260", ["BILLS-119sres208"])],
      () => true,
    );
    expect(hub.pairs).toEqual([]);
    expect(hub.ambiguous).toEqual(["BILLS-119sres208"]);

    // sconres32 lists hconres82 and hconres23; hconres23 is not held. Still no group.
    const notHeldPartner = resolveCompanionGroups(
      [
        decl("BILLS-119sconres32", ["BILLS-119hconres23", "BILLS-119hconres82"]),
        decl("BILLS-119hconres82", ["BILLS-119sconres32"]),
      ],
      heldOnly("BILLS-119sconres32", "BILLS-119hconres82"),
    );
    expect(notHeldPartner.pairs).toEqual([]);
    expect(notHeldPartner.ambiguous).toEqual(["BILLS-119sconres32"]);

    // Two House bills and one Senate bill.
    const twoToOne = resolveCompanionGroups(
      [decl("BILLS-119hjres187", ["BILLS-119sjres192", "BILLS-119sjres198"])],
      () => true,
    );
    expect(twoToOne.pairs).toEqual([]);
    expect(twoToOne.ambiguous).toEqual(["BILLS-119hjres187"]);
    // An unheld hub is not reported as ambiguous.
    expect(
      resolveCompanionGroups([decl("BILLS-119hr1", ["BILLS-119s1", "BILLS-119s2"])], () => false).ambiguous,
    ).toEqual([]);
  });

  it("needs both bills held (acceptance 6)", () => {
    const result = resolveCompanionGroups([decl("BILLS-119hr8849", ["BILLS-119s4394"])], heldOnly("BILLS-119hr8849"));
    expect(result.pairs).toEqual([]);
    expect(result.excluded.partnerNotHeld).toBe(1);
    expect(
      resolveCompanionGroups([decl("BILLS-119hr8849", ["BILLS-119s4394"])], () => false).excluded.partnerNotHeld,
    ).toBe(0);
  });

  it("always puts the House bill first and does not depend on input order (acceptance 7)", () => {
    const declarations = [
      decl("BILLS-119sjres91", ["BILLS-119hjres131"]),
      decl("BILLS-119s570", ["BILLS-119hr1285"]),
      decl("BILLS-119hr1285", ["BILLS-119s570"]),
      decl("BILLS-119sres1", ["BILLS-119hres2"]),
      decl("BILLS-119sconres21", ["BILLS-119hconres58"]),
      decl("BILLS-119hres407", ["BILLS-119sres208"]),
      decl("BILLS-119hres1260", ["BILLS-119sres208"]),
      decl("BILLS-119hr2", ["BILLS-119hr3"]),
    ];
    const expected = resolveCompanionGroups(declarations, () => true);
    expect(expected.pairs).toEqual([
      ["BILLS-119hconres58", "BILLS-119sconres21"],
      ["BILLS-119hjres131", "BILLS-119sjres91"],
      ["BILLS-119hr1285", "BILLS-119s570"],
      ["BILLS-119hres2", "BILLS-119sres1"],
    ]);
    expect(expected.oneSided).toBe(3);

    let order = declarations;
    for (let round = 0; round < 12; round += 1) {
      order = [...order.slice(3), ...order.slice(0, 3)].reverse();
      expect(resolveCompanionGroups(order, () => true)).toEqual(expected);
    }
  });

  it("builds the contract shapes, index and keys", () => {
    expect(toCompanionGroupV1(["BILLS-119s570", "BILLS-119hr1285"])).toEqual({
      primaryGuid: "BILLS-119hr1285",
      memberGuids: ["BILLS-119hr1285", "BILLS-119s570"],
      relationship: "identical",
    });
    expect(
      companionGroupsFromPairs([
        ["BILLS-119hr2", "BILLS-119s9"],
        ["BILLS-119hconres1", "BILLS-119sconres1"],
      ]).map((group) => group.primaryGuid),
    ).toEqual(["BILLS-119hconres1", "BILLS-119hr2"]);

    const index = companionIndex([
      ["BILLS-119hr1285", "BILLS-119s570"],
      ["BILLS-119hr1285", "BILLS-119s9"],
      ["BILLS-119hr5", "BILLS-119hr5"],
      ["not-a-guid", "BILLS-119s1"],
    ]);
    expect([...index.keys()]).toEqual(["BILLS-119hr1285", "BILLS-119s570"]);
    expect(index.get("BILLS-119s570")).toBe(index.get("BILLS-119hr1285"));
    expect(companionKey("BILLS-119s570is", index)).toBe("BILLS-119hr1285");
    expect(companionKey("BILLS-119hr1285", index)).toBe("BILLS-119hr1285");
    expect(companionKey("BILLS-119hr77ih", index)).toBe("BILLS-119hr77");
    expect(companionKey(" legacy ", index)).toBe("legacy");
    expect(companionStatsKey(index.get("BILLS-119s570")!)).toBe("COMPANIONS#BILLS-119hr1285#BILLS-119s570");
  });

  it("keeps one row per group, the primary's row first choice", () => {
    const index = companionIndex([["BILLS-119hr1285", "BILLS-119s570"]]);
    const rows = [
      { billId: "BILLS-119s570", vote: "Nay" },
      { billId: "BILLS-119hr77", vote: "Yea" },
      { billId: "BILLS-119hr1285ih", vote: "Yea" },
      { billId: "BILLS-119hr77ih", vote: "Nay" },
      { billId: "BILLS-119s4394", vote: "Abstain" },
    ];
    expect(pickCountedRowPerGroup(rows, (row) => row.billId, index)).toEqual([
      { billId: "BILLS-119hr77", vote: "Yea" },
      { billId: "BILLS-119hr1285ih", vote: "Yea" },
      { billId: "BILLS-119s4394", vote: "Abstain" },
    ]);
    // A vote on the partner alone still counts.
    expect(pickCountedRowPerGroup([{ billId: "BILLS-119s570" }], (row) => row.billId, index)).toEqual([
      { billId: "BILLS-119s570" },
    ]);
    expect(pickCountedRowPerGroup([], (row: { billId: string }) => row.billId, index)).toEqual([]);
  });
});
