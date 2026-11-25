import {
  COMPANION_VETOED_RANK,
  companionStatusLead,
  companionStatusRank,
  type CompanionLeadFacts,
} from "../shared/companionStatusLead";

type Member = CompanionLeadFacts & { guid: string };

const member = (guid: string, facts: Partial<CompanionLeadFacts> = {}): Member => ({
  guid,
  status: "New",
  vetoed: false,
  movedAtMs: 0,
  isPrimary: false,
  ...facts,
});

const leadOf = (members: Member[]): string | undefined => companionStatusLead(members, (value) => value)?.guid;

describe("companionStatusRank", () => {
  it("ranks Finalized 5, vetoed 4, Passed 3, Failed 2, Updated 1, New 0, as the app's companion card does", () => {
    expect(companionStatusRank({ status: "Finalized", vetoed: false })).toBe(5);
    expect(companionStatusRank({ status: "Passed", vetoed: true })).toBe(COMPANION_VETOED_RANK);
    expect(companionStatusRank({ status: "Failed", vetoed: true })).toBe(4);
    expect(companionStatusRank({ status: "Passed", vetoed: false })).toBe(3);
    expect(companionStatusRank({ status: "Failed", vetoed: false })).toBe(2);
    expect(companionStatusRank({ status: "Updated", vetoed: false })).toBe(1);
    expect(companionStatusRank({ status: "New", vetoed: false })).toBe(0);
  });

  it("ranks a law as a law even with a veto flag, and a member without a status as New", () => {
    expect(companionStatusRank({ status: "Finalized", vetoed: true })).toBe(5);
    expect(companionStatusRank({ status: undefined, vetoed: false })).toBe(0);
    expect(companionStatusRank({ status: undefined, vetoed: true })).toBe(4);
  });
});

describe("companionStatusLead", () => {
  it("takes a law over a twin that moved later (REL-44)", () => {
    const lead = leadOf([
      member("hr", { status: "Finalized", movedAtMs: 1, isPrimary: true }),
      member("s", { status: "Updated", movedAtMs: 9 }),
    ]);
    expect(lead).toBe("hr");
  });

  it("takes a vetoed member over a twin that only passed, and a law over a vetoed twin", () => {
    expect(
      leadOf([
        member("hr", { status: "Passed", movedAtMs: 9, isPrimary: true }),
        member("s", { status: "Failed", vetoed: true, movedAtMs: 1 }),
      ]),
    ).toBe("s");
    expect(
      leadOf([
        member("hr", { status: "Passed", vetoed: true, movedAtMs: 9, isPrimary: true }),
        member("s", { status: "Finalized", movedAtMs: 1 }),
      ]),
    ).toBe("s");
  });

  it("takes a Passed member over its Failed twin, whichever moved later", () => {
    expect(
      leadOf([
        member("hr", { status: "Failed", movedAtMs: 9, isPrimary: true }),
        member("s", { status: "Passed", movedAtMs: 1 }),
      ]),
    ).toBe("s");
  });

  it("takes the member that moved later among equal ranks, then the primary, then the earlier listed", () => {
    expect(leadOf([member("hr", { movedAtMs: 1, isPrimary: true }), member("s", { movedAtMs: 2 })])).toBe("s");
    expect(leadOf([member("s", { movedAtMs: 2 }), member("hr", { movedAtMs: 2, isPrimary: true })])).toBe("hr");
    expect(leadOf([member("a", { movedAtMs: 2 }), member("b", { movedAtMs: 2 })])).toBe("a");
  });

  it("is undefined for no members", () => {
    expect(leadOf([])).toBeUndefined();
  });
});
