import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BillStorage } from "./billStorage";

// Keep all processed congress member key conventions centralized here.
export const PROCESSED_CONGRESS_MEMBERS_ROOT = "processed-congress-members";

type MemberChamber = "house" | "senate";

export const buildProcessedCongressMemberKey = (bioguideId: string, _chamber?: MemberChamber): string => {
  // Flattened layout: processed-congress-members/<bioguideId>.json
  // `chamber` is ignored but kept in the signature for backward compatibility.
  return `${PROCESSED_CONGRESS_MEMBERS_ROOT}/${bioguideId}.json`;
};

export const buildProcessedCongressMemberKeyCandidates = (bioguideId: string): string[] => {
  // Prefer flattened key first.
  // If we ever introduce legacy nested keys for processed members, add candidates here.
  return [buildProcessedCongressMemberKey(bioguideId)];
};

export class ProcessedCongressMemberDao {
  private readonly storage: BillStorage;

  constructor(s3Client: S3Client, bucketName: string) {
    this.storage = new BillStorage(s3Client, bucketName);
  }

  async store(bioguideId: string, payload: unknown): Promise<void> {
    // Always write flattened key.
    const key = buildProcessedCongressMemberKey(bioguideId);
    await this.storage.putJson(key, payload);
    console.log(`Stored processed congress member in S3: ${this.storage.bucketName}/${key}`);
  }

  async get<T = unknown>(bioguideId: string): Promise<T | null> {
    for (const key of buildProcessedCongressMemberKeyCandidates(bioguideId)) {
      const found = await this.storage.getJson<T>(key);
      if (found) return found;
    }

    return null;
  }

  /**
   * Removes the processed member object. The bucket's ObjectRemoved notification then
   * drives createCongressMembersManifest to delete the member's manifest row.
   */
  async delete(bioguideId: string): Promise<void> {
    const key = buildProcessedCongressMemberKey(bioguideId);
    await this.storage.s3Client.send(new DeleteObjectCommand({ Bucket: this.storage.bucketName, Key: key }));
    console.log(`Deleted processed congress member from S3: ${this.storage.bucketName}/${key}`);
  }
}
