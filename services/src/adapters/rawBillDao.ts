import { S3Client } from "@aws-sdk/client-s3";
import { BillIdentifier, RawBill } from "../models/bill";
import { correlationIdMetadata } from "../shared/correlation";
import { logger } from "../shared/logger";
import { BillStorage, type PutJsonResult, type StoredJson } from "./billStorage";
import { buildRawBillGuidKey, buildRawBillRootGuidKey, type RawBillGuidLocator } from "./rawBillKeys";

export class RawBillDao {
  private readonly storage: BillStorage;

  constructor(s3Client: S3Client, bucketName: string) {
    this.storage = new BillStorage(s3Client, bucketName);
  }

  /**
   * `correlationId` is stored as the object's x-amz-meta-correlation-id (OBS-10). With `ifMatch` the
   * write happens only over that ETag; a refused write throws (isPreconditionFailure in billStorage).
   */
  async store(bill: RawBill, options: { correlationId?: string; ifMatch?: string } = {}): Promise<PutJsonResult> {
    const guidKey = buildRawBillGuidKey({
      congress: bill.identifier.congress,
      billType: bill.identifier.billType,
      guid: bill.metadata.guid,
    });
    const result = await this.storage.putJson(guidKey, bill, {
      metadata: correlationIdMetadata(options.correlationId),
      ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
    });
    logger.info("Stored raw bill in S3", { bucket: this.storage.bucketName, key: guidKey });
    return result;
  }

  async get(_id: BillIdentifier): Promise<RawBill | null> {
    // No reliable way to resolve identifier -> guid without an index; return null.
    return null;
  }

  async getByGuid(guid: string): Promise<RawBill | null> {
    // Flattened layout uses raw-bills/<guid>.json (same as the legacy root-guid helper).
    const key = buildRawBillRootGuidKey(guid);
    return this.storage.getJson<RawBill>(key);
  }

  /** The latest raw bill with its ETag, VersionId, LastModified and metadata (REL-30); value null when missing. */
  async getRevisionByGuid(guid: string): Promise<StoredJson<RawBill>> {
    return this.storage.getJsonObject<RawBill>(buildRawBillRootGuidKey(guid));
  }

  async getByGuidWithLocator(locator: RawBillGuidLocator): Promise<RawBill | null> {
    const key = buildRawBillGuidKey(locator);
    return this.storage.getJson<RawBill>(key);
  }
}

export { buildRawBillGuidKey };
