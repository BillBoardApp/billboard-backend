import { BillCategoryReference } from "./categories";
import type {
  BillsManifestItemV1,
  BillsManifestV1,
  BillStatusV1,
  CivicProfileAxisV1,
  CivicProfileScoresV1,
  CompanionGroupV1,
} from "../contracts";

type BillDocumentKind = "raw" | "processed";

export interface BillIdentifier {
  congress: string;
  billType: string;
  billNumber: string;
}

export interface BillDocument {
  schemaVersion: number;
  kind: BillDocumentKind;
  storedAt: string;
  identifier: BillIdentifier;
}

interface RawBillMetadata {
  guid: string;
  title: string;
  pubDate: string;
  category?: string;
  categories?: BillCategoryReference[];
  description?: string;
  legislationUrl?: string;
  fetchedAt: string;
  /**
   * REL-58: when congress.gov listed the title, description and pubDate stored with it (ISO). Written by FetchRawBill
   * under FETCH_RETRY_BACKOFF on, so a retry that comes back after a later listing keeps the later one.
   */
  listedAt?: string;
}

interface RawBillDocument extends BillDocument {
  kind: "raw";
  metadata: RawBillMetadata;
  content: Record<string, unknown>;
}

export type RawBill = RawBillDocument;

export type BillStatusValue = BillStatusV1;

export type OfficialVotePosition = "Yea" | "Nay" | "Present" | "Not Voting" | "Unknown";

export interface OfficialVoteMember {
  bioguideId: string;
  displayName: string;
  party?: string;
  state?: string;
  district?: string;
  votePosition: OfficialVotePosition;
}

export interface OfficialChamberVote {
  yea: number;
  nay: number;
  present: number;
  notVoting: number;
  totalCounted: number;
  actionCode?: string;
  actionDate?: string;
  resultText?: string;
  memberDataAvailable: boolean;
  members: OfficialVoteMember[];
}

export interface OfficialVotesBreakdown {
  house?: OfficialChamberVote;
  senate?: OfficialChamberVote;
  lastSyncedAt: string;
  source: "congress_api";
  completeness: "none" | "partial" | "complete";
}

export const CIVIC_PROFILE_AXES = [
  "individualVsCommunity",
  "localVsFederal",
  "freeMarketVsRegulated",
  "traditionalVsProgressive",
  "interventionistVsRestrained",
  "privacyVsSecurity",
] as const;

export type CivicProfileAxis = CivicProfileAxisV1;
export type CivicProfileScores = CivicProfileScoresV1;

export interface BillBreakdown {
  who: string;
  what: string;
  how: string;
  when: string;
  where: string;
  why: string;
}

/**
 * Internal schema version for processed bills.
 * Absent on legacy bills. Increment when the AI output format changes.
 *   1 = billBreakdown (who/what/how/when/where/why) + BLUF soWhat
 *   2 = added civicProfile axis scores
 */
export const CURRENT_INTERNAL_SCHEMA = 2;

export interface ProcessedBillDocument extends BillDocument {
  kind: "processed";
  storedAt: string;
  guid: string;
  /** Generated plain-language headline. */
  title: string;
  /** Official title from the bill text, or Congress's title when the text has none. */
  officialTitle?: string;
  link: string;
  soWhat: string;
  summary?: string;
  billBreakdown: BillBreakdown;
  internalSchema?: number;
  subCategories: string[];
  lifeAreas: string[];
  sponsors: string[];
  cosponsors: string[];
  isPriority?: boolean;
  priorityRank?: number;
  priorityReason?: string;
  priorityExpiresAt?: string;
  actions?: unknown[];
  committees?: unknown[];
  billStatus?: BillStatusValue;
  civicProfile?: CivicProfileScores;
  officialVotes?: OfficialVotesBreakdown;
  /**
   * The bill's companion group (APPF-23), added by GET /processed-bill and /public/processed-bill.
   * Never stored: the groups live in the manifest table (adapters/billCompanionDao.ts).
   */
  companionGroup?: CompanionGroup;
}

/** Bills grouped as one because Congress.gov lists them as identical (APPF-23). */
export type CompanionGroup = CompanionGroupV1;
export type BillManifestEntry = BillsManifestItemV1;
export type BillsManifest = BillsManifestV1;
