import type { AttributeValue } from "@aws-sdk/client-dynamodb";

// The per-member sponsored and supported counters in CongressMembersStats, one set per Congress (REL-46).
//
// The 119th Congress keeps the attributes it has always had: billsSponsored and billsSupported, with the counted-bill
// sets sponsoredBillGuids and supportedBillGuids. Apps 1.1 and 1.2 label those counts "119th Congress", and the
// counter audit reads those sets as 119th bills only, so a bill of any other Congress never touches them. Each Congress
// from the 120th has its own attributes, named with its number (billsSponsored120, sponsoredBillGuids120, ...), counted
// under the same once-per-bill rule. Bills of earlier Congresses, and guids without a Congress number, count nowhere.

/** The Congress whose counters keep the original attribute names. */
export const LEGACY_COUNTED_CONGRESS = 119;

/** The first Congress counted under attributes named with its number. */
export const FIRST_NUMBERED_COUNTED_CONGRESS = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The four counter attributes of one Congress. */
export interface CongressCounterAttributes {
  congress: number;
  /** The count of sponsored bills. */
  sponsored: string;
  /** The count of supported (cosponsored) bills. */
  supported: string;
  /** The string set of the sponsored bills already counted. */
  sponsoredGuids: string;
  /** The string set of the supported bills already counted. */
  supportedGuids: string;
}

/** The counts a member has in one Congress. */
export interface CongressCounts {
  congress: number;
  sponsored: number;
  supported: number;
}

/** BILLS-119hr1234ih -> 119; null for a guid with no Congress number. */
export const congressOfBillGuid = (guid: string): number | null => {
  const match = guid.match(/^BILLS-(\d+)[a-z]/i);
  return match ? Number(match[1]) : null;
};

/**
 * The Congress in session at a time. Since the 20th Amendment the Nth Congress meets at noon Eastern (17:00Z) on
 * January 3 of 1789 + 2(N - 1); Congress can move the day by law, which this does not know.
 */
export const congressInSessionAt = (atMs: number): number => {
  const year = new Date(atMs).getUTCFullYear();
  const startYear = year % 2 === 1 ? year : year - 1;
  const startsAtMs = Date.UTC(startYear, 0, 3, 17);
  const congress = (startYear - 1789) / 2 + 1;
  return atMs < startsAtMs ? congress - 1 : congress;
};

/**
 * The newest Congress counted at a time: the one in session a day later, so a clock a little behind the poller's on
 * January 3 still counts the new Congress's first bills.
 */
export const latestCountedCongressAt = (atMs: number): number => congressInSessionAt(atMs + DAY_MS);

/** The counter attributes of a Congress, or null for a Congress that is never counted at that time. */
export const counterAttributesFor = (congress: number, atMs: number): CongressCounterAttributes | null => {
  if (!Number.isInteger(congress)) return null;
  if (congress === LEGACY_COUNTED_CONGRESS) {
    return {
      congress,
      sponsored: "billsSponsored",
      supported: "billsSupported",
      sponsoredGuids: "sponsoredBillGuids",
      supportedGuids: "supportedBillGuids",
    };
  }
  if (congress < FIRST_NUMBERED_COUNTED_CONGRESS || congress > latestCountedCongressAt(atMs)) return null;
  return {
    congress,
    sponsored: `billsSponsored${congress}`,
    supported: `billsSupported${congress}`,
    sponsoredGuids: `sponsoredBillGuids${congress}`,
    supportedGuids: `supportedBillGuids${congress}`,
  };
};

/** Every Congress counted at a time, oldest first: the 119th, then the 120th through the newest. */
export const countedCongressesAt = (atMs: number): number[] => {
  const congresses = [LEGACY_COUNTED_CONGRESS];
  for (let congress = FIRST_NUMBERED_COUNTED_CONGRESS; congress <= latestCountedCongressAt(atMs); congress += 1) {
    congresses.push(congress);
  }
  return congresses;
};

const toCount = (value: AttributeValue | undefined): number | null => {
  if (value?.N === undefined) return null;
  const parsed = Number(value.N);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

/** One Congress's counts on a stats row, or null when the row has neither of its counters. */
const countsOf = (
  item: Record<string, AttributeValue>,
  attributes: CongressCounterAttributes,
): CongressCounts | null => {
  const sponsored = toCount(item[attributes.sponsored]);
  const supported = toCount(item[attributes.supported]);
  if (sponsored === null && supported === null) return null;
  return { congress: attributes.congress, sponsored: sponsored ?? 0, supported: supported ?? 0 };
};

/** What the member APIs serve from one stats row. */
export interface MemberCounts {
  /**
   * The 119th Congress's counts (trackedSponsoredCount and trackedSupportedCount), or null when the row has no 119th
   * counter: a member new in the 120th Congress gets a row with their first 120th bill, and must still get no 119th
   * counts (REL-46, project decision D8).
   */
  tracked: CongressCounts | null;
  /** The newest Congress the row has a counter for, else null (currentCongressCounts). */
  current: CongressCounts | null;
}

/** The ProjectionExpression and names that read every counter of every Congress counted at a time, plus the key. */
export const memberCountsProjection = (
  primaryKey: string,
  atMs: number,
): { ProjectionExpression: string; ExpressionAttributeNames: Record<string, string> } => {
  const names: Record<string, string> = { "#pk": primaryKey };
  let index = 0;
  for (const congress of countedCongressesAt(atMs)) {
    const attributes = counterAttributesFor(congress, atMs)!;
    for (const name of [attributes.sponsored, attributes.supported]) {
      names[`#c${index}`] = name;
      index += 1;
    }
  }
  return { ProjectionExpression: Object.keys(names).join(", "), ExpressionAttributeNames: names };
};

/** The 119th counts and the newest Congress's counts on a stats row read with memberCountsProjection. */
export const memberCountsFromItem = (item: Record<string, AttributeValue>, atMs: number): MemberCounts => {
  const byCongress = countedCongressesAt(atMs)
    .map((congress) => countsOf(item, counterAttributesFor(congress, atMs)!))
    .filter((counts): counts is CongressCounts => counts !== null);
  const tracked = byCongress.find((counts) => counts.congress === LEGACY_COUNTED_CONGRESS) ?? null;
  const current = byCongress.length > 0 ? byCongress[byCongress.length - 1] : null;
  return { tracked, current };
};
