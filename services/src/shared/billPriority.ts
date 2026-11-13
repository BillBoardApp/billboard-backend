import type { BillsManifestItemV1 } from "../contracts";
import type { ProcessedBillDocument } from "../models/bill";
import { ACTIVE_PRIORITY_STATUS, type BillPriorityMetadata, type BillPriorityRecord } from "../models/billPriority";

const maxPriorityRank = Number.MAX_SAFE_INTEGER;

export const buildPrioritySortKey = (priorityRank: number, guid: string): string =>
  `${String(Math.max(1, priorityRank)).padStart(6, "0")}#${guid}`;

export const parseIsoDate = (value: string | null | undefined): Date | null => {
  if (!value || typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const isPriorityRecordActive = (record: BillPriorityRecord | null | undefined, now = new Date()): boolean => {
  if (!record || record.isPriority !== true || record.status !== ACTIVE_PRIORITY_STATUS) {
    return false;
  }

  const expiresAt = parseIsoDate(record.priorityExpiresAt);
  if (!expiresAt) {
    return true;
  }
  return expiresAt.getTime() > now.getTime();
};

const priorityMetadataFromRecord = (
  record: BillPriorityRecord | null | undefined,
  now = new Date(),
): Partial<BillPriorityMetadata> => {
  if (!record || !isPriorityRecordActive(record, now)) {
    return {};
  }

  return {
    isPriority: true,
    ...(typeof record.priorityRank === "number" ? { priorityRank: record.priorityRank } : {}),
    ...(typeof record.priorityReason === "string" && record.priorityReason.trim().length > 0
      ? { priorityReason: record.priorityReason.trim() }
      : {}),
    ...(typeof record.priorityExpiresAt === "string" && record.priorityExpiresAt.trim().length > 0
      ? { priorityExpiresAt: record.priorityExpiresAt.trim() }
      : {}),
  };
};

export const mergePriorityIntoManifestEntry = (
  entry: BillsManifestItemV1,
  record: BillPriorityRecord | null | undefined,
  now = new Date(),
): BillsManifestItemV1 => ({
  ...entry,
  ...priorityMetadataFromRecord(record, now),
});

export const mergePriorityIntoProcessedBill = (
  document: ProcessedBillDocument,
  record: BillPriorityRecord | null | undefined,
  now = new Date(),
): ProcessedBillDocument => ({
  ...document,
  ...priorityMetadataFromRecord(record, now),
});

export const priorityFirstRankValue = (value: Partial<BillPriorityMetadata> | null | undefined): number => {
  if (value?.isPriority !== true) {
    return maxPriorityRank;
  }
  return typeof value.priorityRank === "number" && value.priorityRank > 0 ? value.priorityRank : maxPriorityRank;
};
