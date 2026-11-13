import { S3Client } from "@aws-sdk/client-s3";
import { BillIdentifier, ProcessedBillDocument, type BillsManifest } from "../models/bill";
import { plainBillGuid } from "../shared/billCompanions";
import { processedSourceMetadata, type ProcessedSource } from "../shared/billSourceReconcile";
import { correlationIdMetadata } from "../shared/correlation";
import { logger } from "../shared/logger";
import { emitEmbeddedMetric } from "../shared/metrics";
import { BillStorage, type PutJsonResult } from "./billStorage";
import {
  buildProcessedBillGuidKey,
  buildProcessedBillKey,
  buildLegacyProcessedBillGuidKey,
  buildProcessedBillRootGuidKey,
  type ProcessedBillGuidLocator,
} from "./processedBillKeys";

/**
 * A processed bill as read for a conditional rewrite (REL-30). `location` "flat" is the object at
 * processed-bills/<guid>.json, with the ETag, metadata and LastModified of the version read.
 * "legacy" is a copy found only at an older key layout: it has no ETag, so a writer creates the
 * flat object with IfNoneMatch "*".
 */
export interface ProcessedBillRevision {
  bill: ProcessedBillDocument;
  key: string;
  location: "flat" | "legacy";
  etag?: string;
  versionId?: string;
  metadata?: Record<string, string>;
  lastModified?: string;
}

export interface ProcessedBillStoreOptions {
  /** Stored as x-amz-meta-correlation-id (OBS-10). */
  correlationId?: string;
  /** The raw bill the derived fields came from, stored as the source-* metadata keys (REL-30). */
  source?: ProcessedSource;
  /** Write only over this ETag (S3 IfMatch). */
  ifMatch?: string;
  /** "*": write only if no current object exists (S3 IfNoneMatch). */
  ifNoneMatch?: string;
}

// Embedded metric (no PutMetricData grant needed) counting reads that found a bill only at a legacy key.
const LEGACY_LOCATION_METRIC_NAMESPACE = "BillBoard/BillIngestion";
const LEGACY_LOCATION_METRIC = "ProcessedBillLegacyLocation";

export class ProcessedBillDao {
  private readonly storage: BillStorage;
  private manifestCache: { manifest: BillsManifest | null; loadedAt: number } | null = null;
  private readonly manifestKey = "bills-manifest.json";
  private readonly manifestTtlMs = 60 * 1000; // 60s cache

  private normalize(bill: ProcessedBillDocument): ProcessedBillDocument {
    const candidate = bill as unknown as { actions?: unknown; committees?: unknown };

    const actions = Array.isArray(candidate.actions) ? candidate.actions : [];
    const committees = Array.isArray(candidate.committees) ? candidate.committees : [];

    if (actions === candidate.actions && committees === candidate.committees) {
      return bill;
    }

    return { ...bill, actions, committees };
  }

  constructor(s3Client: S3Client, bucketName: string) {
    this.storage = new BillStorage(s3Client, bucketName);
  }

  /**
   * `correlationId` is stored as the object's x-amz-meta-correlation-id, so the steps the S3 event
   * triggers (manifest, notificationType) can continue the pipeline trace (OBS-10). `source` adds
   * the source-text-hash, source-raw-version and source-fetched-at keys billDiffer compares with
   * (REL-30). `ifMatch` / `ifNoneMatch` make the write conditional; a refused write throws.
   */
  async store(bill: ProcessedBillDocument, options: ProcessedBillStoreOptions = {}): Promise<PutJsonResult> {
    // Stored without a text-version suffix (BILLS-119hr1181rh): the key, manifest and member stats use the plain guid.
    const guid = plainBillGuid(bill.guid) ?? bill.guid;
    if (guid !== bill.guid) {
      logger.warn("processed_guid_canonicalized", { event: "processed_guid_canonicalized", received: bill.guid, guid });
    }
    const guidKey = buildProcessedBillGuidKey({
      congress: bill.identifier.congress,
      billType: bill.identifier.billType,
      guid,
    });
    const metadata = {
      ...(correlationIdMetadata(options.correlationId) ?? {}),
      ...(options.source ? processedSourceMetadata(options.source) : {}),
    };
    const result = await this.storage.putJson(guidKey, guid === bill.guid ? bill : { ...bill, guid }, {
      metadata,
      ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
      ...(options.ifNoneMatch ? { ifNoneMatch: options.ifNoneMatch } : {}),
    });
    logger.info("Stored processed bill in S3", {
      bucket: this.storage.bucketName,
      key: guidKey,
      ...(result.versionId ? { versionId: result.versionId } : {}),
    });
    return result;
  }

  /**
   * The processed bill with what a conditional rewrite needs (REL-30). The flat key
   * processed-bills/<guid>.json first, with its ETag, metadata and LastModified ("flat"). On a miss,
   * the older key layouts getByGuid also reads ("legacy", no ETag); such a hit is logged and counted.
   * Null when the bill has no processed copy.
   */
  async getRevisionByGuid(guid: string): Promise<ProcessedBillRevision | null> {
    const rootKey = buildProcessedBillRootGuidKey(guid);
    const flat = await this.storage.getJsonObject<ProcessedBillDocument>(rootKey);
    if (flat.value) {
      return {
        bill: this.normalize(flat.value),
        key: rootKey,
        location: "flat",
        ...(flat.etag ? { etag: flat.etag } : {}),
        ...(flat.versionId ? { versionId: flat.versionId } : {}),
        ...(flat.metadata ? { metadata: flat.metadata } : {}),
        ...(flat.lastModified ? { lastModified: flat.lastModified } : {}),
      };
    }

    const legacy = await this.getFromLegacyLocations(guid);
    if (!legacy) return null;
    logger.warn("processed_legacy_location", { event: "processed_legacy_location", guid, key: rootKey });
    emitEmbeddedMetric(LEGACY_LOCATION_METRIC_NAMESPACE, LEGACY_LOCATION_METRIC, 1);
    return { bill: legacy, key: rootKey, location: "legacy" };
  }

  async get(id: BillIdentifier): Promise<ProcessedBillDocument | null> {
    // Backward compatibility: older layouts stored processed bills by identifier-derived keys.
    const legacyKey = buildProcessedBillKey(id);
    const legacyFound = await this.storage.getJson<ProcessedBillDocument>(legacyKey);
    if (legacyFound) return this.normalize(legacyFound);

    // Flattened layout stores by guid only; resolve via manifest.
    const manifest = await this.loadManifest();
    if (!manifest) return null;

    const match = manifest.bills.find(
      (b) =>
        b?.congress?.toString() === id.congress.toString() &&
        b?.billType?.toString().toLowerCase() === id.billType.toString().toLowerCase() &&
        b?.billNumber?.toString() === id.billNumber.toString(),
    );
    if (!match?.guid) return null;

    const flatKey = buildProcessedBillRootGuidKey(match.guid);
    const found = await this.storage.getJson<ProcessedBillDocument>(flatKey);
    return found ? this.normalize(found) : null;
  }

  async getByGuid(guid: string): Promise<ProcessedBillDocument | null> {
    // Flattened layout uses processed-bills/<guid>.json (same as legacy root-guid helper).
    const rootKey = buildProcessedBillRootGuidKey(guid);
    const byRoot = await this.storage.getJson<ProcessedBillDocument>(rootKey);
    if (byRoot) return this.normalize(byRoot);
    return this.getFromLegacyLocations(guid);
  }

  /** The bill at an older key layout, resolved through the legacy manifest object; null when none. */
  private async getFromLegacyLocations(guid: string): Promise<ProcessedBillDocument | null> {
    // Try manifest-based lookup (cached)
    const manifest = await this.loadManifest();
    if (manifest) {
      const foundEntry = manifest.bills.find((b) => b.guid === guid);
      if (foundEntry) {
        if (foundEntry.congress && foundEntry.billType) {
          // If an older writer used nested keys, try them as a fallback.
          const legacyNestedKey = buildLegacyProcessedBillGuidKey({
            congress: foundEntry.congress,
            billType: foundEntry.billType,
            guid,
          });
          const fromNested = await this.storage.getJson<ProcessedBillDocument>(legacyNestedKey);
          if (fromNested) return this.normalize(fromNested);
        }

        if (foundEntry.congress && foundEntry.billNumber && foundEntry.billType) {
          const id: BillIdentifier = {
            congress: foundEntry.congress,
            billType: foundEntry.billType,
            billNumber: foundEntry.billNumber,
          };
          const byId = await this.get(id);
          if (byId) return byId;
        }
      }
    }

    // No listing fallback: every writer uses the keys above, and listing the whole
    // processed-bills/ prefix on each miss is slow and costly (REL-26).
    return null;
  }

  private async loadManifest(): Promise<BillsManifest | null> {
    const now = Date.now();
    if (this.manifestCache && this.manifestCache.manifest && now - this.manifestCache.loadedAt < this.manifestTtlMs) {
      return this.manifestCache.manifest;
    }

    try {
      const manifest = await this.storage.getJson<BillsManifest>(this.manifestKey);
      this.manifestCache = { manifest: manifest ?? null, loadedAt: now };
      return manifest ?? null;
    } catch {
      this.manifestCache = { manifest: null, loadedAt: now };
      return null;
    }
  }

  async getByGuidWithLocator(locator: ProcessedBillGuidLocator): Promise<ProcessedBillDocument | null> {
    const key = buildProcessedBillGuidKey(locator);
    const found = await this.storage.getJson<ProcessedBillDocument>(key);
    if (found) {
      return this.normalize(found);
    }

    const legacyNestedKey = buildLegacyProcessedBillGuidKey(locator);
    const legacyNestedFound = await this.storage.getJson<ProcessedBillDocument>(legacyNestedKey);
    if (legacyNestedFound) return this.normalize(legacyNestedFound);

    const legacyRootKey = buildProcessedBillRootGuidKey(locator.guid);
    const rootFound = await this.storage.getJson<ProcessedBillDocument>(legacyRootKey);
    return rootFound ? this.normalize(rootFound) : null;
  }
}

export {
  buildProcessedBillKey,
  buildProcessedBillGuidKey,
  buildProcessedBillRootGuidKey,
  parseProcessedBillLookupFromS3Key,
  type ProcessedBillLookup,
} from "./processedBillKeys";
