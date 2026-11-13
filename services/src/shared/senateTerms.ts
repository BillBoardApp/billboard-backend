import type { CongressMemberTerm } from "../models/congressMember";

/**
 * REL-52 (feature review S12): congress.gov lists a member's service one entry per Congress (two years), so a senator
 * elected in 2012 has seven entries (113th to 119th) for three terms, and counting entries overstated senators' terms
 * about 2 to 3 times. House entries are already terms (a House term is one Congress). This merges each senator's
 * per-Congress entries into real terms.
 *
 * A Senate term is one six-year term of the seat, three Congresses, and the seat's class fixes which three: class I
 * terms began with the 116th Congress (2019) and the 119th (2025), class II with the 117th (2021), class III with the
 * 118th (2023). A senator appointed, or elected at a special election, serves the rest of the predecessor's term: a
 * partial term that ends where the class's term ends. So consecutive entries of one state are one term when they fall
 * in the same term of the seat's class, and service in the remainder of a term plus the next full term is two terms
 * (an appointment and the special election for the same remainder are one).
 *
 * congress.gov gives no class (its terms carry only years, no dates), so the class comes from the Senate's own list of
 * senators (senateSeats.ts) for the seat a senator holds now. For earlier Senate service, or when that list is not
 * available, the class is inferred from the state: each state's two seats have two fixed classes, and the one that
 * lets the service start a term is taken (or, when neither does, the one with the shorter first remainder). That never
 * gives more terms than either seat would; it can give one fewer for a senator who was appointed at the start of a
 * Congress to the other seat (two Georgia senators sworn in on the same day of 2021 hold seats of different classes,
 * and congress.gov lists them alike).
 */

export type SenateClass = 1 | 2 | 3;

/** The seat a senator holds now, from the Senate's list of senators. */
export interface SenateSeat {
  senateClass: SenateClass;
  /** Two-letter postal code. */
  stateCode: string;
}

/** Congress number mod 3 of the Congresses that begin a term of each class (116 and 119; 117; 118). */
const TERM_START_CONGRESS_MOD_3: Readonly<Record<SenateClass, number>> = { 1: 2, 2: 0, 3: 1 };

/** The classes of each state's two seats (fixed at admission; U.S. Senate, "States in the Senate"). */
export const SENATE_CLASSES_BY_STATE: Readonly<Record<string, readonly [SenateClass, SenateClass]>> = {
  AL: [2, 3],
  AK: [2, 3],
  AZ: [1, 3],
  AR: [2, 3],
  CA: [1, 3],
  CO: [2, 3],
  CT: [1, 3],
  DE: [1, 2],
  FL: [1, 3],
  GA: [2, 3],
  HI: [1, 3],
  ID: [2, 3],
  IL: [2, 3],
  IN: [1, 3],
  IA: [2, 3],
  KS: [2, 3],
  KY: [2, 3],
  LA: [2, 3],
  ME: [1, 2],
  MD: [1, 3],
  MA: [1, 2],
  MI: [1, 2],
  MN: [1, 2],
  MS: [1, 2],
  MO: [1, 3],
  MT: [1, 2],
  NE: [1, 2],
  NV: [1, 3],
  NH: [2, 3],
  NJ: [1, 2],
  NM: [1, 2],
  NY: [1, 3],
  NC: [2, 3],
  ND: [1, 3],
  OH: [1, 3],
  OK: [2, 3],
  OR: [2, 3],
  PA: [1, 3],
  RI: [1, 2],
  SC: [2, 3],
  SD: [2, 3],
  TN: [1, 2],
  TX: [1, 2],
  UT: [1, 3],
  VT: [1, 3],
  VA: [1, 2],
  WA: [1, 3],
  WV: [1, 2],
  WI: [1, 3],
  WY: [1, 2],
};

const ALL_CLASSES: readonly SenateClass[] = [1, 2, 3];

const mod3 = (value: number): number => ((value % 3) + 3) % 3;

/** 0 when `congress` begins a term of `senateClass`, 1 or 2 for the second or third Congress of the term. */
export const congressPositionInTerm = (congress: number, senateClass: SenateClass): number =>
  mod3(congress - TERM_START_CONGRESS_MOD_3[senateClass]);

/** Which six-year term of `senateClass` the Congress falls in; equal for the three Congresses of one term. */
export const senateTermIndex = (congress: number, senateClass: SenateClass): number =>
  Math.floor((congress - TERM_START_CONGRESS_MOD_3[senateClass]) / 3);

/** The Congress in session in `year` (the 1st began in 1789; each begins in an odd year). */
export const congressOfYear = (year: number): number => Math.floor((year - 1789) / 2) + 1;

const toInteger = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return null;
};

const toStateCode = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
};

const stateKey = (term: CongressMemberTerm): string =>
  toStateCode(term.stateCode) ?? (typeof term.stateName === "string" ? term.stateName.trim().toLowerCase() : "");

/** True for an entry of Senate service ("Senate" chamber or "Senator" member type). */
export const isSenateTerm = (term: CongressMemberTerm | null | undefined): boolean => {
  if (!term || typeof term !== "object") return false;
  const label = `${typeof term.chamber === "string" ? term.chamber : ""} ${
    typeof term.memberType === "string" ? term.memberType : ""
  }`.toLowerCase();
  return label.includes("senat");
};

/** The entry's Congress, or the one in session in its start year when congress.gov left it out. */
const congressOf = (term: CongressMemberTerm): number | null => {
  const congress = toInteger(term.congress);
  if (congress !== null && congress > 0) return congress;
  const startYear = toInteger(term.startYear);
  return startYear !== null && startYear >= 1789 ? congressOfYear(startYear) : null;
};

/**
 * The class inferred for Senate service in `stateCode` that began in `firstCongress`: of the state's two seats (all
 * three classes for an unknown state), the class that puts the first Congress earliest in its term. That is the seat
 * whose term the service could have begun at an election, and otherwise the shorter remainder; it gives the fewest
 * terms of the candidates.
 */
export const inferSenateClass = (stateCode: string | null, firstCongress: number): SenateClass => {
  const candidates = (stateCode && SENATE_CLASSES_BY_STATE[stateCode]) || ALL_CLASSES;
  return candidates.reduce((best, candidate) =>
    congressPositionInTerm(firstCongress, candidate) < congressPositionInTerm(firstCongress, best) ? candidate : best,
  );
};

interface SenateEntry {
  index: number;
  term: CongressMemberTerm;
  congress: number;
  state: string;
}

/** The member's latest entry, by Congress (or start year), then start year; null when none can be placed. */
export const latestTerm = (terms: readonly CongressMemberTerm[] | null | undefined): CongressMemberTerm | null => {
  if (!Array.isArray(terms)) return null;
  let latest: { term: CongressMemberTerm; congress: number; startYear: number } | null = null;
  for (const term of terms) {
    if (!term || typeof term !== "object") continue;
    const congress = congressOf(term);
    if (congress === null) continue;
    const startYear = toInteger(term.startYear) ?? 0;
    if (!latest || congress > latest.congress || (congress === latest.congress && startYear >= latest.startYear)) {
      latest = { term, congress, startYear };
    }
  }
  return latest?.term ?? null;
};

export interface CurrentSenateSeatResolution {
  /** The seat to merge the current Senate service with, or null to infer its class. */
  seat: SenateSeat | null;
  /** Why the class of a current senator is inferred; null when the list gave it or the member is no senator now. */
  inferredReason: "list_unavailable" | "not_listed" | "state_mismatch" | null;
}

/**
 * The listed seat of a member whose latest entry is Senate service: the Senate's list (`seats`, null when it could not
 * be read) must name the member, in the state of that entry. Members who are no senator now need no seat.
 */
export const resolveCurrentSenateSeat = (
  bioguideId: string,
  terms: readonly CongressMemberTerm[] | null | undefined,
  seats: ReadonlyMap<string, SenateSeat> | null,
): CurrentSenateSeatResolution => {
  const latest = latestTerm(terms);
  if (!isSenateTerm(latest)) return { seat: null, inferredReason: null };
  if (!seats) return { seat: null, inferredReason: "list_unavailable" };
  const seat = seats.get(bioguideId.trim().toUpperCase());
  if (!seat) return { seat: null, inferredReason: "not_listed" };
  const latestState = toStateCode(latest?.stateCode);
  if (latestState && latestState !== seat.stateCode) return { seat: null, inferredReason: "state_mismatch" };
  return { seat, inferredReason: null };
};

/** One merged Senate term: the latest entry's fields, with the first Congress, the first start and the last end. */
const mergedSenateTerm = (group: readonly SenateEntry[]): CongressMemberTerm => {
  const first = group[0];
  const last = group[group.length - 1];
  const startYears = group
    .map((entry) => toInteger(entry.term.startYear))
    .filter((year): year is number => year !== null);
  const endYear = toInteger(last.term.endYear);
  const { endYear: _endYear, startYear: _startYear, congress: _congress, ...fields } = last.term;
  return {
    ...fields,
    congress: first.congress,
    ...(startYears.length > 0 ? { startYear: Math.min(...startYears) } : {}),
    ...(endYear !== null ? { endYear } : {}),
  };
};

/**
 * The member's terms with each Senate term as one entry (see the top of this file). House entries, and entries that
 * cannot be placed in a Congress, are kept as they are, and the order is kept: a merged term stands where its first
 * entry stood. `currentSeat` is the seat the member holds now (resolveCurrentSenateSeat); it sets the class of the
 * latest run of Senate service. Every other run's class is inferred (inferSenateClass).
 */
export const mergeSenateTerms = (
  terms: readonly CongressMemberTerm[],
  currentSeat: SenateSeat | null = null,
): CongressMemberTerm[] => {
  const senateEntries: SenateEntry[] = [];
  terms.forEach((term, index) => {
    if (!isSenateTerm(term)) return;
    const congress = congressOf(term);
    if (congress === null) return;
    senateEntries.push({ index, term, congress, state: stateKey(term) });
  });
  if (senateEntries.length === 0) return [...terms];

  senateEntries.sort(
    (a, b) =>
      a.congress - b.congress ||
      (toInteger(a.term.startYear) ?? 0) - (toInteger(b.term.startYear) ?? 0) ||
      a.index - b.index,
  );

  // Runs of unbroken service in one state: each next entry is in the same or the next Congress.
  const runs: SenateEntry[][] = [];
  for (const entry of senateEntries) {
    const run = runs[runs.length - 1];
    const previous = run?.[run.length - 1];
    if (previous && entry.congress - previous.congress <= 1 && entry.state === previous.state) run.push(entry);
    else runs.push([entry]);
  }

  const replacement = new Map<number, CongressMemberTerm>();
  const dropped = new Set<number>();
  runs.forEach((run, runIndex) => {
    const isLatestRun = runIndex === runs.length - 1;
    const senateClass =
      isLatestRun && currentSeat
        ? currentSeat.senateClass
        : inferSenateClass(toStateCode(run[0].term.stateCode), run[0].congress);

    const groups: SenateEntry[][] = [];
    for (const entry of run) {
      const group = groups[groups.length - 1];
      if (group && senateTermIndex(group[0].congress, senateClass) === senateTermIndex(entry.congress, senateClass)) {
        group.push(entry);
      } else {
        groups.push([entry]);
      }
    }

    for (const group of groups) {
      const firstIndex = Math.min(...group.map((entry) => entry.index));
      replacement.set(firstIndex, mergedSenateTerm(group));
      group.forEach((entry) => {
        if (entry.index !== firstIndex) dropped.add(entry.index);
      });
    }
  });

  const merged: CongressMemberTerm[] = [];
  terms.forEach((term, index) => {
    if (dropped.has(index)) return;
    merged.push(replacement.get(index) ?? term);
  });
  return merged;
};
