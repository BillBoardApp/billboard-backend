const RAW_BILLS_ROOT = "raw-bills";

export type RawBillGuidLocator = {
  congress: string;
  billType: string;
  guid: string;
};

const normalizeBillGuidForKey = (guid: string): string => {
  const match = guid.match(/^(BILLS-\d+[a-z]+\d+)[a-z]*$/i);
  return match ? match[1] : guid;
};

export const buildRawBillGuidKey = ({ congress: _congress, billType: _billType, guid }: RawBillGuidLocator): string => {
  // Flattened layout: raw-bills/<guid>.json
  // `congress` and `billType` are ignored but kept in the signature for backward compatibility.
  const normalizedGuid = normalizeBillGuidForKey(guid);
  return `${RAW_BILLS_ROOT}/${normalizedGuid}.json`;
};

export const buildRawBillRootGuidKey = (guid: string): string => {
  // Backward compatibility for previously-written objects.
  const normalizedGuid = normalizeBillGuidForKey(guid);
  return `${RAW_BILLS_ROOT}/${normalizedGuid}.json`;
};
