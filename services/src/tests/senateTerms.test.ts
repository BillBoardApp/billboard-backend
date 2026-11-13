import type { CongressMemberTerm } from "../models/congressMember";
import {
  SENATE_CLASSES_BY_STATE,
  congressOfYear,
  congressPositionInTerm,
  inferSenateClass,
  latestTerm,
  mergeSenateTerms,
  resolveCurrentSenateSeat,
  senateTermIndex,
  type SenateSeat,
} from "../shared/senateTerms";

// congress.gov lists service one entry per Congress (REL-52). These build such entries: a Congress n runs from January
// of 2n + 1787 to January two years later; the current Congress's entry has no endYear.
const CURRENT_CONGRESS = 119;
const firstYear = (congress: number): number => 2 * congress + 1787;
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const perCongress = (
  base: CongressMemberTerm,
  from: number,
  to: number,
  overrides: Record<number, Partial<CongressMemberTerm>> = {},
): CongressMemberTerm[] =>
  range(from, to).map((congress) => ({
    ...base,
    congress,
    startYear: firstYear(congress),
    ...(congress === CURRENT_CONGRESS ? {} : { endYear: firstYear(congress) + 2 }),
    ...overrides[congress],
  }));

const senate = (stateCode: string, stateName: string, from: number, to: number, overrides = {}) =>
  perCongress({ chamber: "Senate", memberType: "Senator", stateCode, stateName }, from, to, overrides);

const house = (stateCode: string, stateName: string, district: number, from: number, to: number, overrides = {}) =>
  perCongress(
    { chamber: "House of Representatives", memberType: "Representative", stateCode, stateName, district },
    from,
    to,
    overrides,
  );

const seat = (senateClass: 1 | 2 | 3, stateCode: string): SenateSeat => ({ senateClass, stateCode });

/** [chamber, first Congress, startYear, endYear or null] of each term, for compact expectations. */
const spans = (terms: CongressMemberTerm[]) =>
  terms.map((term) => [term.chamber === "Senate" ? "S" : "H", term.congress, term.startYear, term.endYear ?? null]);

describe("Senate classes and Congresses", () => {
  it("places each class's terms on the Congresses they really begin in", () => {
    // Class I: elected 2018 and 2024 (terms from the 116th and the 119th); class II: 2020 (117th); class III: 2022
    // (118th). Each term is three Congresses.
    expect([116, 117, 118, 119, 120, 121, 122].map((c) => senateTermIndex(c, 1))).toEqual([38, 38, 38, 39, 39, 39, 40]);
    expect([116, 117, 118, 119, 120].map((c) => senateTermIndex(c, 2))).toEqual([38, 39, 39, 39, 40]);
    expect([117, 118, 119, 120, 121].map((c) => senateTermIndex(c, 3))).toEqual([38, 39, 39, 39, 40]);
    expect([119, 117, 118].map((c, i) => congressPositionInTerm(c, ([1, 2, 3] as const)[i]))).toEqual([0, 0, 0]);
  });

  it("finds the Congress in session in a year", () => {
    expect([1789, 1790, 1791, 2023, 2024, 2025, 2026].map(congressOfYear)).toEqual([1, 1, 2, 118, 118, 119, 119]);
  });

  it("lists two different classes for each of the 50 states, 33 or 34 seats a class", () => {
    const pairs = Object.values(SENATE_CLASSES_BY_STATE);
    expect(pairs).toHaveLength(50);
    pairs.forEach(([a, b]) => expect(a).not.toBe(b));
    const seatsByClass = [1, 2, 3].map((c) => pairs.filter((pair) => pair.includes(c as 1 | 2 | 3)).length);
    expect(seatsByClass).toEqual([33, 33, 34]);
  });

  it("infers the class that lets the service begin a term, else the shorter remainder", () => {
    // Georgia's seats are class II and III; the 117th begins a class II term.
    expect(inferSenateClass("GA", 117)).toBe(2);
    // The 118th begins a class III term.
    expect(inferSenateClass("GA", 118)).toBe(3);
    // New York's seats are I and III; the 117th is the second Congress of a class I term, the third of a class III.
    expect(inferSenateClass("NY", 117)).toBe(1);
    // Unknown state: any class, so the service is taken to begin a term.
    expect(congressPositionInTerm(110, inferSenateClass(null, 110))).toBe(0);
  });
});

describe("mergeSenateTerms", () => {
  it("long-serving senator: 23 Congresses of Senate service after 3 House terms are 8 Senate terms", () => {
    // Iowa: House 94th to 96th (1975-1981), then the class III seat from the 97th (1981) to now.
    const terms = [...house("IA", "Iowa", 3, 94, 96), ...senate("IA", "Iowa", 97, 119)];
    expect(terms).toHaveLength(26);

    const merged = mergeSenateTerms(terms, seat(3, "IA"));

    expect(merged).toHaveLength(11);
    expect(spans(merged)).toEqual([
      ["H", 94, 1975, 1977],
      ["H", 95, 1977, 1979],
      ["H", 96, 1979, 1981],
      ["S", 97, 1981, 1987],
      ["S", 100, 1987, 1993],
      ["S", 103, 1993, 1999],
      ["S", 106, 1999, 2005],
      ["S", 109, 2005, 2011],
      ["S", 112, 2011, 2017],
      ["S", 115, 2017, 2023],
      ["S", 118, 2023, null],
    ]);
    // The House entries are the same objects, untouched.
    merged.slice(0, 3).forEach((term, i) => expect(term).toBe(terms[i]));
    // A merged term keeps the entry's fields and has no endYear while it runs.
    expect(merged[10]).toEqual({
      chamber: "Senate",
      memberType: "Senator",
      stateCode: "IA",
      stateName: "Iowa",
      congress: 118,
      startYear: 2023,
    });
  });

  it("a senator since 2007 in a class I seat has served 4 terms, the current one from 2025", () => {
    const merged = mergeSenateTerms(senate("MN", "Minnesota", 110, 119), seat(1, "MN"));
    expect(spans(merged)).toEqual([
      ["S", 110, 2007, 2013],
      ["S", 113, 2013, 2019],
      ["S", 116, 2019, 2025],
      ["S", 119, 2025, null],
    ]);
  });

  it("appointed senator: the rest of the predecessor's term is one partial term, then a full one", () => {
    // Minnesota's class II seat: appointed in January 2018, in the second Congress of the 2015-2021 term; won the special
    // election for its rest in 2018, then the 2020 election (2021-2027).
    const terms = senate("MN", "Minnesota", 115, 119, { 115: { startYear: 2018 } });
    const merged = mergeSenateTerms(terms, seat(2, "MN"));
    expect(spans(merged)).toEqual([
      ["S", 115, 2018, 2021],
      ["S", 117, 2021, null],
    ]);
  });

  it("appointed senator who also won the special election for the rest of the term has one term", () => {
    // Nebraska's class II seat: appointed in January 2023, elected in 2024 for the term ending in January 2027.
    const merged = mergeSenateTerms(senate("NE", "Nebraska", 118, 119), seat(2, "NE"));
    expect(spans(merged)).toEqual([["S", 118, 2023, null]]);
  });

  it("special election winner sworn in weeks before a full term of their own has two terms", () => {
    // California's class I seat: sworn in December 2024 for the rest of the 2019-2025 term, then the 2025-2031 term.
    const terms = senate("CA", "California", 118, 119, { 118: { startYear: 2024 } });
    expect(spans(mergeSenateTerms(terms, seat(1, "CA")))).toEqual([
      ["S", 118, 2024, 2025],
      ["S", 119, 2025, null],
    ]);
    // Without the Senate's list the class is inferred; California's class III seat would make it one term: one fewer,
    // never more.
    expect(spans(mergeSenateTerms(terms))).toEqual([["S", 118, 2024, null]]);
  });

  it("two senators listed alike by congress.gov are told apart by their seats' classes", () => {
    // Georgia, both sworn in in January 2021: one for the class II term (2021-2027), one for the rest of a class III
    // term (2017-2023) and then the 2023-2029 term.
    const terms = senate("GA", "Georgia", 117, 119);
    expect(spans(mergeSenateTerms(terms, seat(2, "GA")))).toEqual([["S", 117, 2021, null]]);
    expect(spans(mergeSenateTerms(terms, seat(3, "GA")))).toEqual([
      ["S", 117, 2021, 2023],
      ["S", 118, 2023, null],
    ]);
  });

  it("member who served in both chambers: House terms stay one per Congress, Senate service is merged", () => {
    // Connecticut: House 110th to 112th, then the class I seat from 2013.
    const terms = [...house("CT", "Connecticut", 5, 110, 112), ...senate("CT", "Connecticut", 113, 119)];
    const merged = mergeSenateTerms(terms, seat(1, "CT"));
    expect(spans(merged)).toEqual([
      ["H", 110, 2007, 2009],
      ["H", 111, 2009, 2011],
      ["H", 112, 2011, 2013],
      ["S", 113, 2013, 2019],
      ["S", 116, 2019, 2025],
      ["S", 119, 2025, null],
    ]);
  });

  it("a Congress served in both chambers keeps its House entry and starts the Senate service", () => {
    // Massachusetts: House until mid-2013, then the class II seat after a special election (the rest of 2009-2015).
    const terms = [
      ...house("MA", "Massachusetts", 5, 111, 113, { 113: { endYear: 2013 } }),
      ...senate("MA", "Massachusetts", 113, 119),
    ];
    const merged = mergeSenateTerms(terms, seat(2, "MA"));
    expect(spans(merged)).toEqual([
      ["H", 111, 2009, 2011],
      ["H", 112, 2011, 2013],
      ["H", 113, 2013, 2013],
      ["S", 113, 2013, 2015],
      ["S", 114, 2015, 2021],
      ["S", 117, 2021, null],
    ]);
  });

  it("House-only member: the terms are returned as they are", () => {
    const terms = house("TX", "Texas", 7, 112, 119);
    const merged = mergeSenateTerms(terms, null);
    expect(merged).toEqual(terms);
    expect(merged).not.toBe(terms);
    merged.forEach((term, i) => expect(term).toBe(terms[i]));
  });

  it("service in two separate periods is merged period by period; the earlier period's class is inferred", () => {
    // Indiana: the class I seat 1977-1983 (95th to 97th, then lost), and again from 2013. Only the current period's
    // class comes from the Senate's list.
    const terms = [...senate("IN", "Indiana", 95, 97), ...senate("IN", "Indiana", 113, 119)];
    const merged = mergeSenateTerms(terms, seat(1, "IN"));
    expect(spans(merged)).toEqual([
      ["S", 95, 1977, 1983],
      ["S", 113, 2013, 2019],
      ["S", 116, 2019, 2025],
      ["S", 119, 2025, null],
    ]);
  });

  it("merges entries without a congress by their start year, and keeps entries it cannot place", () => {
    const terms: CongressMemberTerm[] = [
      { chamber: "Senate", memberType: "Senator", stateCode: "MN", startYear: 2019, endYear: 2021 },
      { chamber: "Senate", memberType: "Senator", stateCode: "MN", startYear: 2021, endYear: 2023 },
      { chamber: "Senate", memberType: "Senator", stateCode: "MN" },
    ];
    expect(mergeSenateTerms(terms, seat(1, "MN"))).toEqual([
      { chamber: "Senate", memberType: "Senator", stateCode: "MN", congress: 116, startYear: 2019, endYear: 2023 },
      { chamber: "Senate", memberType: "Senator", stateCode: "MN" },
    ]);
  });

  it("merges a Congress listed twice (a party change) into its term", () => {
    const terms = senate("ME", "Maine", 117, 119, {});
    terms.splice(2, 0, { ...terms[1], startYear: 2024, partyName: "Independent" } as CongressMemberTerm);
    expect(spans(mergeSenateTerms(terms, seat(2, "ME")))).toEqual([["S", 117, 2021, null]]);
  });
});

describe("resolveCurrentSenateSeat", () => {
  const seats = new Map<string, SenateSeat>([["S000001", seat(1, "MN")]]);
  const current = senate("MN", "Minnesota", 116, 119);

  it("gives the listed seat of a current senator", () => {
    expect(resolveCurrentSenateSeat("s000001", current, seats)).toEqual({ seat: seat(1, "MN"), inferredReason: null });
  });

  it("says why a current senator's class is inferred", () => {
    expect(resolveCurrentSenateSeat("S000001", current, null)).toEqual({
      seat: null,
      inferredReason: "list_unavailable",
    });
    expect(resolveCurrentSenateSeat("S000002", current, seats)).toEqual({ seat: null, inferredReason: "not_listed" });
    expect(resolveCurrentSenateSeat("S000001", senate("WI", "Wisconsin", 118, 119), seats)).toEqual({
      seat: null,
      inferredReason: "state_mismatch",
    });
  });

  it("needs no seat for a member who is no senator now", () => {
    const formerSenator = [...senate("MN", "Minnesota", 110, 112), ...house("MN", "Minnesota", 3, 113, 119)];
    expect(resolveCurrentSenateSeat("S000001", formerSenator, null)).toEqual({ seat: null, inferredReason: null });
    expect(resolveCurrentSenateSeat("S000001", undefined, seats)).toEqual({ seat: null, inferredReason: null });
  });

  it("takes the latest entry by Congress, not by position", () => {
    const shuffled = [current[3], current[0], current[2], current[1]];
    expect(latestTerm(shuffled)).toBe(current[3]);
  });
});
