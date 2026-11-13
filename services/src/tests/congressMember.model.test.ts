import {
  isDepartedCongressMember,
  normalizeCongressMemberPayload,
  unwrapCongressMember,
} from "../models/congressMember";

describe("congressMember model", () => {
  it("isDepartedCongressMember is true only for an explicit currentMember: false", () => {
    // Shapes from congress.gov /member/{id}: a member who left GA-14 mid-term and a current member.
    const departed = {
      member: {
        bioguideId: "G000596",
        currentMember: false,
        terms: [
          {
            chamber: "House of Representatives",
            congress: 119,
            district: 14,
            endYear: 2026,
            startYear: 2025,
            stateCode: "GA",
          },
        ],
      },
    };
    const current = {
      member: {
        bioguideId: "S000999",
        currentMember: true,
        terms: [{ chamber: "House of Representatives", congress: 119, district: 14, startYear: 2026, stateCode: "GA" }],
      },
    };
    expect(isDepartedCongressMember(departed)).toBe(true);
    expect(isDepartedCongressMember(departed.member)).toBe(true);
    expect(isDepartedCongressMember(current)).toBe(false);

    // Never retire on a missing or ambiguous signal.
    expect(isDepartedCongressMember({ member: { bioguideId: "X000001" } })).toBe(false);
    expect(isDepartedCongressMember({ member: { bioguideId: "X000001", currentMember: "false" } })).toBe(false);
    expect(isDepartedCongressMember(null)).toBe(false);
  });

  it("unwrapCongressMember supports both { member: ... } and raw member objects", () => {
    const wrapped = { member: { bioguideId: "A000370" } };
    expect(unwrapCongressMember(wrapped)?.bioguideId).toBe("A000370");

    const raw = { bioguideId: "B000002" };
    expect(unwrapCongressMember(raw)?.bioguideId).toBe("B000002");
  });

  it("normalizeCongressMemberPayload coerces array wrapper shapes", () => {
    const payload = {
      member: {
        bioguideId: "A000370",
        terms: { items: [{ chamber: "House of Representatives", stateCode: "NC", district: 12 }] },
        partyHistory: { item: [{ partyAbbreviation: "D", partyName: "Democratic", startYear: 2014 }] },
        previousNames: { items: [{ directOrderName: "Alma S. Adams" }] },
      },
    };

    const normalized = normalizeCongressMemberPayload(payload) as {
      member: { terms: unknown; partyHistory: unknown; previousNames: unknown };
    };
    expect(Array.isArray(normalized.member.terms)).toBe(true);
    expect(Array.isArray(normalized.member.partyHistory)).toBe(true);
    expect(Array.isArray(normalized.member.previousNames)).toBe(true);
  });
});
