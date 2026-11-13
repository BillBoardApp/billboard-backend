import { S3Client } from "@aws-sdk/client-s3";
import { BillStorage } from "./billStorage";

const RAW_CONGRESS_MEMBERS_ROOT = "raw-congress-members";

type MemberChamber = "house" | "senate";

const buildRawCongressMemberKey = (bioguideId: string, _chamber?: MemberChamber): string => {
  // Flattened layout: raw-congress-members/<bioguideId>.json
  // `chamber` is ignored but kept in the signature for backward compatibility.
  return `${RAW_CONGRESS_MEMBERS_ROOT}/${bioguideId}.json`;
};

const buildRawCongressMemberKeyCandidates = (bioguideId: string): string[] => {
  // Prefer flattened key first, but allow legacy nested keys during migration.
  return [
    buildRawCongressMemberKey(bioguideId),
    `${RAW_CONGRESS_MEMBERS_ROOT}/house/${bioguideId}.json`,
    `${RAW_CONGRESS_MEMBERS_ROOT}/senate/${bioguideId}.json`,
  ];
};

export class RawCongressMemberDao {
  private readonly storage: BillStorage;

  constructor(s3Client: S3Client, bucketName: string) {
    this.storage = new BillStorage(s3Client, bucketName);
  }

  async store(bioguideId: string, payload: unknown): Promise<void> {
    // Always write flattened key.
    const key = buildRawCongressMemberKey(bioguideId);
    await this.storage.putJson(key, payload);
    console.log(`Stored raw congress member in S3: ${this.storage.bucketName}/${key}`);
  }

  async get<T = unknown>(bioguideId: string): Promise<T | null> {
    for (const key of buildRawCongressMemberKeyCandidates(bioguideId)) {
      const found = await this.storage.getJson<T>(key);
      if (found) return found;
    }

    return null;
  }

  /**
   * Load a raw congress member payload by explicit S3 key.
   * Useful for S3-event driven workflows where the key is already known.
   */
  async getByKey<T = unknown>(key: string): Promise<T | null> {
    return this.storage.getJson<T>(key);
  }
}
