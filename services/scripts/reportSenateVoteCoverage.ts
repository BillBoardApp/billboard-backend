import { type AttributeValue, DynamoDBClient, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import type { ProcessedBillDocument, RawBill } from "../src/models/bill";
import { extractSenateRollCallRef } from "../src/shared/congressVotes";

type SenateCoverageRow = {
  guid: string;
  rawKey: string;
  billType: string | null;
  billNumber: string | null;
  title: string | null;
  rollCallNumber: string;
  actionDate: string | null;
  resultText: string | null;
  processedExists: boolean;
  hasOfficialVotesSenate: boolean;
  senateMemberCount: number;
  senateYeaNayMemberCount: number;
  hasCivicProfile: boolean;
  representedInProfiles: boolean;
  processedCompleteness: string | null;
};

const BUCKET = process.env.BUCKET_NAME ?? "billboard-bill-store-bucket";
const RAW_PREFIX = process.env.RAW_PREFIX ?? "raw-bills/BILLS-119";
const PROCESSED_PREFIX = process.env.PROCESSED_PREFIX ?? "processed-bills/BILLS-119";
const MEMBERS_TABLE = process.env.MEMBERS_TABLE ?? "CongressMembersManifest";
const VOTE_TABLE = process.env.VOTE_TABLE ?? "CongressMemberVoteProfiles";
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const RAW_CONCURRENCY = 20;
const DDB_CONCURRENCY = 15;

const s3 = new S3Client({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

const streamToString = async (body: AsyncIterable<Uint8Array> | undefined): Promise<string> => {
  if (!body) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
};

const listAllKeys = async (prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of response.Contents ?? []) {
      if (typeof object.Key === "string" && object.Key.endsWith(".json")) keys.push(object.Key);
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return keys;
};

const getJsonFromS3 = async <T>(key: string): Promise<T> => {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    }),
  );

  return JSON.parse(await streamToString(response.Body as AsyncIterable<Uint8Array> | undefined)) as T;
};

const getCurrentSenatorIds = async (): Promise<string[]> => {
  const ids = new Set<string>();
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await ddb.send(
      new ScanCommand({
        TableName: MEMBERS_TABLE,
        ProjectionExpression: "bioguideId, chamber",
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const chamber = item?.chamber?.S;
      const bioguideId = item?.bioguideId?.S;
      if (chamber === "Senate" && typeof bioguideId === "string" && bioguideId.length > 0) {
        ids.add(bioguideId);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return [...ids].sort();
};

const getProfileBillGuidsForMember = async (bioguideId: string): Promise<string[]> => {
  const billGuids: string[] = [];
  let startKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: VOTE_TABLE,
        KeyConditionExpression: "bioguideId = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: bioguideId },
        },
        ProjectionExpression: "billGuid",
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of response.Items ?? []) {
      const billGuid = item?.billGuid?.S;
      if (typeof billGuid === "string" && billGuid.length > 0) {
        billGuids.push(billGuid);
      }
    }

    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return billGuids;
};

const normalizeVotePosition = (value: unknown): "Yea" | "Nay" | null => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "yea" || normalized === "yes" || normalized === "aye") return "Yea";
  if (normalized === "nay" || normalized === "no") return "Nay";
  return null;
};

const hasCivicProfile = (value: unknown): boolean =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value as Record<string, unknown>).length > 0;

const buildProcessedKey = (guid: string): string => `processed-bills/${guid}.json`;

const main = async (): Promise<void> => {
  const rawKeys = await listAllKeys(RAW_PREFIX);
  const processedKeys = await listAllKeys(PROCESSED_PREFIX);
  const processedKeySet = new Set(processedKeys);

  const senateRollCallRows = (
    await mapLimit(rawKeys, RAW_CONCURRENCY, async (key): Promise<SenateCoverageRow | null> => {
      const rawBill = await getJsonFromS3<RawBill>(key);
      const rollCallRef = extractSenateRollCallRef(rawBill);
      if (!rollCallRef) return null;

      const guid =
        (typeof rawBill?.metadata?.guid === "string" && rawBill.metadata.guid.length > 0
          ? rawBill.metadata.guid
          : key
              .split("/")
              .pop()
              ?.replace(/\.json$/i, "")) ?? "";
      if (!guid) return null;

      return {
        guid,
        rawKey: key,
        billType: rawBill?.identifier?.billType ?? null,
        billNumber: rawBill?.identifier?.billNumber ?? null,
        title: rawBill?.metadata?.title ?? null,
        rollCallNumber: rollCallRef.rollCallNumber,
        actionDate: rollCallRef.actionDate ?? null,
        resultText: rollCallRef.resultText ?? null,
        processedExists: false,
        hasOfficialVotesSenate: false,
        senateMemberCount: 0,
        senateYeaNayMemberCount: 0,
        hasCivicProfile: false,
        representedInProfiles: false,
        processedCompleteness: null,
      };
    })
  ).filter((row): row is SenateCoverageRow => row !== null);

  senateRollCallRows.sort((left, right) => left.guid.localeCompare(right.guid));

  const senatorIds = await getCurrentSenatorIds();
  const profileBillGuidArrays = await mapLimit(senatorIds, DDB_CONCURRENCY, getProfileBillGuidsForMember);
  const representedGuids = new Set(profileBillGuidArrays.flat());

  const classifiedRows = await mapLimit(senateRollCallRows, DDB_CONCURRENCY, async (row) => {
    const processedKey = buildProcessedKey(row.guid);
    const processedExists = processedKeySet.has(processedKey);
    if (!processedExists) {
      return { ...row, representedInProfiles: representedGuids.has(row.guid) };
    }

    let processedBill: ProcessedBillDocument | null;
    try {
      processedBill = await getJsonFromS3<ProcessedBillDocument>(processedKey);
    } catch {
      processedBill = null;
    }

    const senateVote = processedBill?.officialVotes?.senate;
    const senateMembers = Array.isArray(senateVote?.members) ? senateVote.members : [];
    const senateYeaNayMemberCount = senateMembers.filter(
      (member: { votePosition?: unknown; vote?: unknown; position?: unknown }) =>
        normalizeVotePosition(member?.votePosition ?? member?.vote ?? member?.position),
    ).length;

    return {
      ...row,
      processedExists,
      hasOfficialVotesSenate: !!senateVote,
      senateMemberCount: senateMembers.length,
      senateYeaNayMemberCount,
      hasCivicProfile: hasCivicProfile(processedBill?.civicProfile),
      representedInProfiles: representedGuids.has(row.guid),
      processedCompleteness:
        typeof processedBill?.officialVotes?.completeness === "string"
          ? processedBill.officialVotes.completeness
          : null,
    };
  });

  const summary = {
    senateRollCallBills: classifiedRows.length,
    representedInProfiles: classifiedRows.filter((row) => row.representedInProfiles).length,
    missingFromProfiles: classifiedRows.filter((row) => !row.representedInProfiles).length,
    missingProcessedBill: classifiedRows.filter((row) => !row.processedExists).length,
    missingSenateOfficialVotes: classifiedRows.filter((row) => row.processedExists && !row.hasOfficialVotesSenate)
      .length,
    missingSenateMembers: classifiedRows.filter(
      (row) => row.processedExists && row.hasOfficialVotesSenate && row.senateMemberCount === 0,
    ).length,
    missingCivicProfile: classifiedRows.filter(
      (row) => row.processedExists && row.senateYeaNayMemberCount > 0 && !row.hasCivicProfile,
    ).length,
    eligibleButNotRepresented: classifiedRows.filter(
      (row) =>
        row.processedExists &&
        row.hasOfficialVotesSenate &&
        row.senateYeaNayMemberCount > 0 &&
        row.hasCivicProfile &&
        !row.representedInProfiles,
    ).length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    representedGuids: [...representedGuids].sort(),
    classifiedRows,
    missingRows: classifiedRows.filter((row) => !row.representedInProfiles),
  };

  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
