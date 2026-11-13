import type { BillStatusValue } from "./bill";

export const ACTIVE_PRIORITY_STATUS = "ACTIVE" as const;
export const INACTIVE_PRIORITY_STATUS = "INACTIVE" as const;

export type BillPriorityStatus = typeof ACTIVE_PRIORITY_STATUS | typeof INACTIVE_PRIORITY_STATUS;

export interface BillPriorityMetadata {
  isPriority: boolean;
  priorityRank?: number;
  priorityReason?: string;
  priorityExpiresAt?: string;
}

export interface BillPriorityRecord extends BillPriorityMetadata {
  guid: string;
  status: BillPriorityStatus;
  congress?: string;
  billType?: string;
  billNumber?: string;
  title?: string;
  billStatus?: BillStatusValue;
  updatedAt?: string;
  priorityScore?: number;
  priorityConfidence?: number;
  priorityUpdatedAt: string;
  prioritySortKey?: string;
  ttl?: number;
}
