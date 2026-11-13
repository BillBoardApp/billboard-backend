// A row of congress.gov's bill list (/v3/bill/{congress}/{type}) and the UpdatedBillsQueue message BillsApiPoller
// builds from it. Shared by the poller and refetch:stale-bills --snapshot-file (REL-56), whose message for a bill that
// was never stored must be exactly the poller's.

export type UnknownRecord = Record<string, unknown>;

/** The message BillsApiPoller sends to UpdatedBillsQueue for a list row; FetchRawBill reads it. */
export interface UpdatedBillMessage {
  guid: string;
  title: string;
  link: string;
  legislationUrl?: string;
  pubDate: string;
  category?: string;
  description?: string;
  billType?: string;
  congress?: string;
  billNumber?: string;
  updateDate?: string;
}

export const toTrimmedString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The value as an ISO time, or null when it is empty or not a time. A date alone reads as its UTC midnight. */
export const normalizeIsoDate = (value: unknown): string | null => {
  const raw = toTrimmedString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

const toCongressOrdinal = (congress: string): string => {
  const n = Number.parseInt(congress, 10);
  if (!Number.isFinite(n)) return `${congress}th`;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
};

const HUMAN_TO_ABBREV_BILL_TYPE: Record<string, string> = {
  "house-bill": "hr",
  "senate-bill": "s",
  "house-joint-resolution": "hjres",
  "senate-joint-resolution": "sjres",
  "house-concurrent-resolution": "hconres",
  "senate-concurrent-resolution": "sconres",
  "house-resolution": "hres",
  "senate-resolution": "sres",
};

const ABBREV_TO_HUMAN_BILL_TYPE: Record<string, string> = {
  hr: "house-bill",
  s: "senate-bill",
  hjres: "house-joint-resolution",
  sjres: "senate-joint-resolution",
  hconres: "house-concurrent-resolution",
  sconres: "senate-concurrent-resolution",
  hres: "house-resolution",
  sres: "senate-resolution",
};

/** "HR", "hr" or "house-bill" -> "hr"; a type it does not know, lower-cased. */
export const normalizeBillType = (billType: string): string => {
  const lowered = billType.toLowerCase();
  return HUMAN_TO_ABBREV_BILL_TYPE[lowered] ?? lowered;
};

export const buildBillGuid = (congress: string, billType: string, billNumber: string): string =>
  `BILLS-${congress}${billType}${billNumber}`;

export const buildLegislationUrl = (congress: string, billType: string, billNumber: string): string => {
  const congressOrdinal = toCongressOrdinal(congress);
  const billTypeSegment = ABBREV_TO_HUMAN_BILL_TYPE[billType] ?? billType;
  return `https://www.congress.gov/bill/${congressOrdinal}-congress/${billTypeSegment}/${billNumber}`;
};

/**
 * The poller's message for a list row, or null when the row names no bill. The congress and bill type default to the
 * list's own; pubDate and updateDate are the row's updateDate (or updatedAt, or its latest action's date) as an ISO
 * time, and both are left out (pubDate empty) when it has none.
 */
export const toBillMessage = (
  row: UnknownRecord,
  defaultBillType: string,
  defaultCongress: string,
): UpdatedBillMessage | null => {
  const congress = toTrimmedString(row.congress) || defaultCongress;
  const billTypeRaw =
    toTrimmedString(row.type) ||
    toTrimmedString(row.billType) ||
    toTrimmedString((row.bill as UnknownRecord | undefined)?.type) ||
    defaultBillType;
  const billType = normalizeBillType(billTypeRaw);

  const billNumber =
    toTrimmedString(row.number) ||
    toTrimmedString(row.billNumber) ||
    toTrimmedString((row.bill as UnknownRecord | undefined)?.number);

  if (!congress || !billType || !billNumber) {
    return null;
  }

  const guid = buildBillGuid(congress, billType, billNumber);
  const updateDateRaw =
    row.updateDate ??
    row.updatedAt ??
    (row.latestAction as UnknownRecord | undefined)?.actionDate ??
    (row.latestAction as UnknownRecord | undefined)?.action_date;
  const updateDate = normalizeIsoDate(updateDateRaw);
  if (!updateDate) {
    return {
      guid,
      title: toTrimmedString(row.title),
      link: buildLegislationUrl(congress, billType, billNumber),
      legislationUrl: buildLegislationUrl(congress, billType, billNumber),
      pubDate: "",
      category: "Congress API",
      description:
        toTrimmedString((row.latestAction as UnknownRecord | undefined)?.text) || toTrimmedString(row.description),
      congress,
      billType,
      billNumber,
    };
  }

  const legislationUrl = buildLegislationUrl(congress, billType, billNumber);
  return {
    guid,
    title: toTrimmedString(row.title),
    link: legislationUrl,
    legislationUrl,
    pubDate: updateDate,
    category: "Congress API",
    description:
      toTrimmedString((row.latestAction as UnknownRecord | undefined)?.text) || toTrimmedString(row.description),
    congress,
    billType,
    billNumber,
    updateDate,
  };
};
