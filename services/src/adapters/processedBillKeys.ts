import { BillIdentifier } from "../models/bill";
import { plainBillGuid } from "../shared/billCompanions";

const PROCESSED_BILLS_ROOT = "processed-bills";

export type ProcessedBillGuidLocator = {
  congress: string;
  billType: string;
  guid: string;
};

// BILLS-<congress><bill type letters><number><optional version letters>, e.g. BILLS-119hr1234ih.
// The capture group is the version-less form used in S3 keys.
const PROCESSED_BILL_GUID_PATTERN = /^(BILLS-\d+[a-z]+\d+)[a-z]*$/i;
// Real guids are about 20 characters; the cap keeps an unbounded digit run out of S3 keys.
const MAX_PROCESSED_BILL_GUID_LENGTH = 64;

export const isValidProcessedBillGuid = (guid: string): boolean =>
  guid.length <= MAX_PROCESSED_BILL_GUID_LENGTH && PROCESSED_BILL_GUID_PATTERN.test(guid);

const normalizeBillGuidForKey = (guid: string): string => {
  const match = guid.match(PROCESSED_BILL_GUID_PATTERN);
  return match ? match[1] : guid;
};

export type ProcessedBillLookup =
  | { kind: "guid"; guid: string }
  | { kind: "guidWithLocator"; congress: string; billType: string; guid: string }
  | { kind: "identifier"; identifier: BillIdentifier };

export const buildProcessedBillGuidKey = ({
  congress: _congress,
  billType: _billType,
  guid,
}: ProcessedBillGuidLocator): string => {
  // Flattened layout: processed-bills/<guid>.json
  // `congress` and `billType` are ignored but kept in the signature for backward compatibility.
  const normalizedGuid = normalizeBillGuidForKey(guid);
  return `${PROCESSED_BILLS_ROOT}/${normalizedGuid}.json`;
};

export const buildLegacyProcessedBillGuidKey = ({ congress, billType, guid }: ProcessedBillGuidLocator): string => {
  const billTypeForKey = billType.toLowerCase();
  const normalizedGuid = normalizeBillGuidForKey(guid);
  return `${PROCESSED_BILLS_ROOT}/congress-${congress}/${billTypeForKey}/${normalizedGuid}.json`;
};

export const buildProcessedBillRootGuidKey = (guid: string): string => {
  // Backward compatibility for previously-written objects.
  const normalizedGuid = normalizeBillGuidForKey(guid);
  return `${PROCESSED_BILLS_ROOT}/${normalizedGuid}.json`;
};

export const buildProcessedBillKey = (id: BillIdentifier): string => {
  const billTypeForKey = id.billType.toLowerCase();
  return `${PROCESSED_BILLS_ROOT}/congress-${id.congress}/${billTypeForKey}/${id.billNumber}.json`;
};

export const parseProcessedBillLookupFromS3Key = (key: string): ProcessedBillLookup | null => {
  // New (flattened): processed-bills/<guid>.json
  const flatGuidMatch = key.match(/^processed-bills\/([^/]+)\.json$/i);
  if (flatGuidMatch) {
    const [, guid] = flatGuidMatch;
    if (guid && /^BILLS-\d+[a-z]+\d+$/i.test(guid)) return { kind: "guid", guid };
    return null;
  }

  // Legacy: processed-bills/congress-<congress>/<bill-type>/<billNumber>.json
  // Must be checked before the guid-with-locator case; otherwise billNumber would be mis-parsed as a guid.
  const legacyMatch = key.match(/^processed-bills\/congress-(\d+)\/([^/]+)\/(\d+)\.json$/i);
  if (legacyMatch) {
    const [, congress, billTypeSegment, billNumber] = legacyMatch;
    return {
      kind: "identifier",
      identifier: {
        congress,
        billType: billTypeSegment.toLowerCase(),
        billNumber,
      },
    };
  }

  // New: processed-bills/congress-<congress>/<bill-type>/<guid>.json
  const folderGuidMatch = key.match(/^processed-bills\/congress-(\d+)\/([^/]+)\/([^/]+)\.json$/i);
  if (folderGuidMatch) {
    const [, congress, billType, guid] = folderGuidMatch;
    if (congress && billType && guid && /^BILLS-\d+[a-z]+\d+$/i.test(guid)) {
      return {
        kind: "guidWithLocator",
        congress,
        billType: billType.toLowerCase(),
        guid,
      };
    }
  }

  return null;
};

/**
 * The guid a processed bill's records (manifest row and lookup, notification objectId, member-profile rows) are keyed
 * by: the guid its key names, else the document's guid, without a text-version suffix either way. Never the document's
 * guid as written: BILLS-119hr1181rh in processed-bills/BILLS-119hr1181.json gave the bill a second manifest row and
 * second member-profile rows. Null when neither names one.
 */
export const processedBillGuid = (key: string, documentGuid: unknown): string | null => {
  const lookup = parseProcessedBillLookupFromS3Key(key);
  if (lookup && lookup.kind !== "identifier") return plainBillGuid(lookup.guid) ?? lookup.guid;
  const guid = typeof documentGuid === "string" ? documentGuid.trim() : "";
  return guid ? (plainBillGuid(guid) ?? guid) : null;
};
