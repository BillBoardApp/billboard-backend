import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { SQSEvent } from "aws-lambda";

import {
  conditionalCheckFailed as conditionFailedWithItem,
  evaluateCondition,
  type ConditionInput,
} from "./fixtures/dynamoCondition";
import { applyTestEnv } from "./fixtures/env";
import type { FakeS3Input } from "./fakeVersionedS3";
import { logLines } from "./logLines";
import { jsonReadable } from "./fixtures/streams";
import { sqsWrappedS3Keys } from "./fixtures/awsEvents";

const originalEnv = { ...process.env };

/** A request inside a BatchWriteItem. */
interface BatchRequest {
  PutRequest?: { Item: Record<string, AttributeValue> };
  DeleteRequest?: { Key: Record<string, AttributeValue> };
}

/** The DynamoDB input fields the fakes and assertions read, across the commands the handler sends. */
interface FakeDdbInput extends ConditionInput {
  TableName?: string;
  IndexName?: string;
  Key?: Record<string, AttributeValue>;
  RequestItems?: Record<string, BatchRequest[]>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ReturnValuesOnConditionCheckFailure?: string;
}

/** What the mocked command constructors return: the command's input. */
interface FakeDdbCommand {
  input: FakeDdbInput;
}
interface FakeS3Command {
  input: FakeS3Input;
}

const mockS3Send = jest.fn();
const mockDdbSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn(() => ({ send: mockS3Send })),
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
    ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ input })),
  };
});

jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
    UpdateItemCommand: jest.fn().mockImplementation((input) => ({ input })),
    BatchWriteItemCommand: jest.fn().mockImplementation((input) => ({ input })),
    BatchGetItemCommand: jest.fn().mockImplementation((input) => ({ input })),
    QueryCommand: jest.fn().mockImplementation((input) => ({ input })),
    ScanCommand: jest.fn().mockImplementation((input) => ({ input })),
  };
});

let handler: (event: SQSEvent) => Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }>;
let restoreEnv: (() => void) | undefined;

beforeEach(async () => {
  jest.resetModules();
  mockS3Send.mockReset();
  mockDdbSend.mockReset();

  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();

  restoreEnv?.();
  restoreEnv = applyTestEnv(
    {
      BUCKET_NAME: "test-bucket",
      TABLE_NAME: "congress-member-stats-table",
      PRIMARY_KEY: "bioguideId",
      VOTE_PROFILE_TABLE_NAME: "CongressMemberVoteProfiles",
      VOTE_PROFILE_PRIMARY_KEY: "bioguideId",
      VOTE_PROFILE_SORT_KEY: "billGuid",
      VOTE_PROFILE_BILL_GUID_INDEX_NAME: "BillGuidIndex",
      VOTE_PROFILE_BILL_GUID_INDEX_PK: "billGuid",
      VOTE_PROFILE_BILL_GUID_INDEX_SK: "bioguideId",
      LEGISLATIVE_PROFILE_TABLE_NAME: "CongressMemberLegislativeProfiles",
      LEGISLATIVE_PROFILE_PRIMARY_KEY: "bioguideId",
      LEGISLATIVE_PROFILE_SORT_KEY: "billGuid",
      LEGISLATIVE_PROFILE_BILL_GUID_INDEX_NAME: "BillGuidIndex",
      LEGISLATIVE_PROFILE_BILL_GUID_INDEX_PK: "billGuid",
      LEGISLATIVE_PROFILE_BILL_GUID_INDEX_SK: "bioguideId",
      CONGRESS_MEMBERS_MANIFEST_TABLE_NAME: "CongressMembersManifest",
    },
    { replace: true, base: originalEnv },
  );

  // Use CJS require to avoid NodeNext extension requirements in tooling.
  const mod = require("../handlers/congressMemberStats");
  handler = mod.handler;
});

afterEach(() => {
  restoreEnv?.();
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv as NodeJS.ProcessEnv;
});

// The idempotent counter update: bump the counter and record the bill guid in one call, only if
// that bill has not been counted for the member yet, and never on a row counted before the sets.
const counterUpdate = (bioguideId: string, field: "billsSponsored" | "billsSupported", billGuid: string) => ({
  TableName: "congress-member-stats-table",
  Key: { bioguideId: { S: bioguideId } },
  UpdateExpression: "ADD #counter :inc, #countedGuids :billGuidSet",
  ConditionExpression:
    "(attribute_exists(#countedGuids) AND NOT contains(#countedGuids, :billGuid)) OR " +
    "(attribute_not_exists(#countedGuids) AND (attribute_not_exists(#counter) OR #counter = :zero))",
  ExpressionAttributeNames: {
    "#counter": field,
    "#countedGuids": field === "billsSponsored" ? "sponsoredBillGuids" : "supportedBillGuids",
  },
  ExpressionAttributeValues: {
    ":inc": { N: "1" },
    ":billGuidSet": { SS: [billGuid] },
    ":billGuid": { S: billGuid },
    ":zero": { N: "0" },
  },
  ReturnValuesOnConditionCheckFailure: "ALL_OLD",
});

const rawBillPayload = (sponsors: string[], cosponsors: string[]) => ({
  schemaVersion: 1,
  kind: "raw",
  storedAt: "2025-12-31T17:53:44.148Z",
  identifier: { congress: "119", billType: "house-bill", billNumber: "1" },
  metadata: {
    guid: "BILLS-119hr1ih",
    title: "Example",
    pubDate: "2025-12-31T00:00:00Z",
    link: "https://example.com",
    fetchedAt: "2025-12-31T00:00:00Z",
  },
  content: {
    bill: { bill: { sponsors: sponsors.map((bioguideId) => ({ bioguideId })) } },
    cosponsors: { cosponsors: cosponsors.map((bioguideId) => ({ bioguideId })) },
  },
});

// Single-version raw bills (no previous version), keyed by S3 key.
const mockRawBills = (payloadsByKey: Record<string, unknown>) => {
  mockS3Send.mockImplementation((cmd: FakeS3Command) => {
    const input = cmd?.input ?? {};
    if (input.Prefix && payloadsByKey[input.Prefix]) {
      return {
        Versions: [{ Key: input.Prefix, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
        DeleteMarkers: [],
        IsTruncated: false,
      };
    }
    if (input.Key && payloadsByKey[input.Key]) {
      return { Body: jsonReadable(payloadsByKey[input.Key]) };
    }
    throw new Error("Unexpected S3 request: " + JSON.stringify(input));
  });
};

const sqsEventWithIds = (entries: Array<{ messageId: string; key: string }>) =>
  ({
    Records: entries.map(({ messageId, key }) => ({
      messageId,
      body: JSON.stringify({ Records: [{ s3: { object: { key } } }] }),
    })),
  }) as unknown as SQSEvent;

const conditionalCheckFailed = () =>
  Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });

describe("congressMemberStats handler", () => {
  it("reads a raw bill from S3 and increments sponsor/cosponsor stats", async () => {
    const key = "raw-bills/BILLS-119hr2312.json";
    const payload = {
      schemaVersion: 1,
      kind: "raw",
      storedAt: "2025-12-31T17:53:44.148Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "2312" },
      metadata: {
        guid: "BILLS-119hr2312rh",
        title: "H.R. 2312 - Example",
        pubDate: "2025-12-31T00:00:00Z",
        link: "https://example.com",
        fetchedAt: "2025-12-31T00:00:00Z",
      },
      content: {
        bill: {
          bill: {
            sponsors: [{ bioguideId: "W000809" }],
          },
        },
        cosponsors: {
          cosponsors: [{ bioguideId: "B001322" }, { bioguideId: "S000250" }],
        },
      },
    };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(payload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });
    mockDdbSend.mockResolvedValue({});

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).toHaveBeenCalledTimes(3);

    // Sponsor increment
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: counterUpdate("W000809", "billsSponsored", "BILLS-119hr2312"),
      }),
    );

    // Cosponsor increments (order not guaranteed)
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: counterUpdate("B001322", "billsSupported", "BILLS-119hr2312"),
      }),
    );
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: counterUpdate("S000250", "billsSupported", "BILLS-119hr2312"),
      }),
    );
  });

  it("increments sponsor only when bill has no cosponsors", async () => {
    const key = "raw-bills/BILLS-119hr9999.json";
    const payload = {
      schemaVersion: 1,
      kind: "raw",
      storedAt: "2025-12-31T17:53:44.148Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "9999" },
      metadata: {
        guid: "BILLS-119hr9999ih",
        title: "H.R. 9999 - Example",
        pubDate: "2025-12-31T00:00:00Z",
        link: "https://example.com",
        fetchedAt: "2025-12-31T00:00:00Z",
      },
      content: {
        bill: {
          bill: {
            sponsors: [{ bioguideId: "A000001" }],
          },
        },
        cosponsors: {
          cosponsors: [],
        },
      },
    };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(payload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });
    mockDdbSend.mockResolvedValue({});

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: counterUpdate("A000001", "billsSponsored", "BILLS-119hr9999"),
      }),
    );
  });

  it("does not double-count when a bill object is updated", async () => {
    const key = "raw-bills/BILLS-119hr1234.json";
    const currentPayload = {
      schemaVersion: 1,
      kind: "raw",
      storedAt: "2025-12-31T17:53:44.148Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "1234" },
      metadata: {
        guid: "BILLS-119hr1234ih",
        title: "H.R. 1234 - Example",
        pubDate: "2025-12-31T00:00:00Z",
        link: "https://example.com",
        fetchedAt: "2025-12-31T00:00:00Z",
      },
      content: {
        bill: { bill: { sponsors: [{ bioguideId: "A000001" }] } },
        cosponsors: { cosponsors: [{ bioguideId: "B000002" }] },
      },
    };
    const previousPayload = { ...currentPayload, storedAt: "2025-12-30T00:00:00Z" };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [
            { Key: key, VersionId: "v2", IsLatest: true, LastModified: new Date().toISOString() },
            { Key: key, VersionId: "v1", IsLatest: false, LastModified: new Date(Date.now() - 1000).toISOString() },
          ],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key && input.VersionId === "v1") {
        return { Body: jsonReadable(previousPayload) };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(currentPayload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });
    mockDdbSend.mockResolvedValue({});

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it("skips non-matching keys", async () => {
    mockDdbSend.mockResolvedValue({});
    mockS3Send.mockResolvedValue({ Body: jsonReadable({}) });

    const event = sqsWrappedS3Keys(["processed-congress-members/A000001.json"]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it("upserts House yea/nay vote profile rows from processed bills and removes stale rows", async () => {
    const key = "processed-bills/BILLS-119hr2312.json";
    const payload = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-02-01T00:00:00.000Z",
      guid: "BILLS-119hr2312",
      civicProfile: {
        individualVsCommunity: 0.8,
        localVsFederal: 0.2,
      },
      officialVotes: {
        lastSyncedAt: "2026-02-01T12:00:00.000Z",
        source: "congress_api",
        completeness: "complete",
        house: {
          actionDate: "2026-02-01",
          members: [
            { bioguideId: "A000001", votePosition: "Yea" },
            { bioguideId: "B000002", votePosition: "Nay" },
            { bioguideId: "C000003", votePosition: "Present" },
          ],
        },
      },
    };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(payload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });
    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd?.input ?? {};
      if (input.IndexName === "BillGuidIndex" && input.TableName === "CongressMemberVoteProfiles") {
        return {
          Items: [{ bioguideId: { S: "A000001" } }, { bioguideId: { S: "OLD000" } }],
        };
      }
      return {};
    });

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberVoteProfiles: expect.arrayContaining([
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "A000001" },
                    billGuid: { S: "BILLS-119hr2312" },
                    votePosition: { S: "Yea" },
                  }),
                },
              }),
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "B000002" },
                    billGuid: { S: "BILLS-119hr2312" },
                    votePosition: { S: "Nay" },
                  }),
                },
              }),
            ]),
          }),
        }),
      }),
    );
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberVoteProfiles: expect.arrayContaining([
              expect.objectContaining({
                DeleteRequest: {
                  Key: {
                    bioguideId: { S: "OLD000" },
                    billGuid: { S: "BILLS-119hr2312" },
                  },
                },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("upserts sponsor and cosponsor legislative profile rows from processed bills", async () => {
    const key = "processed-bills/BILLS-119hr777.json";
    const payload = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-02-05T00:00:00.000Z",
      guid: "BILLS-119hr777",
      sponsors: ["A000001"],
      cosponsors: ["B000002", "A000001"],
      civicProfile: {
        individualVsCommunity: 0.7,
        localVsFederal: 0.3,
      },
      officialVotes: {
        lastSyncedAt: "2026-02-05T12:00:00.000Z",
        source: "congress_api",
        completeness: "complete",
      },
    };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(payload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });
    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd?.input ?? {};
      if (input.IndexName === "BillGuidIndex" && input.TableName === "CongressMemberLegislativeProfiles") {
        return {
          Items: [{ bioguideId: { S: "A000001" } }, { bioguideId: { S: "STALE999" } }],
        };
      }
      return {};
    });

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberLegislativeProfiles: expect.arrayContaining([
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "A000001" },
                    billGuid: { S: "BILLS-119hr777" },
                    evidenceType: { S: "sponsor" },
                  }),
                },
              }),
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "B000002" },
                    billGuid: { S: "BILLS-119hr777" },
                    evidenceType: { S: "cosponsor" },
                  }),
                },
              }),
            ]),
          }),
        }),
      }),
    );
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberLegislativeProfiles: expect.arrayContaining([
              expect.objectContaining({
                DeleteRequest: {
                  Key: {
                    bioguideId: { S: "STALE999" },
                    billGuid: { S: "BILLS-119hr777" },
                  },
                },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("upserts Senate yea/nay vote profile rows from processed bills", async () => {
    const key = "processed-bills/BILLS-119s25.json";
    const payload = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-02-03T00:00:00.000Z",
      guid: "BILLS-119s25",
      civicProfile: {
        individualVsCommunity: 0.6,
        localVsFederal: 0.4,
      },
      officialVotes: {
        lastSyncedAt: "2026-02-03T12:00:00.000Z",
        source: "congress_api",
        completeness: "complete",
        senate: {
          actionDate: "2026-02-03T18:15:00.000Z",
          members: [
            { bioguideId: "S000001", votePosition: "Yea" },
            { bioguideId: "S000002", votePosition: "Nay" },
            { bioguideId: "S000003", votePosition: "Present" },
          ],
        },
      },
    };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(payload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });
    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd?.input ?? {};
      if (input.IndexName === "BillGuidIndex" && input.TableName === "CongressMemberVoteProfiles") {
        return { Items: [] };
      }
      return {};
    });

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberVoteProfiles: expect.arrayContaining([
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "S000001" },
                    billGuid: { S: "BILLS-119s25" },
                    votePosition: { S: "Yea" },
                    votedAt: { S: "2026-02-03T18:15:00.000Z" },
                  }),
                },
              }),
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "S000002" },
                    billGuid: { S: "BILLS-119s25" },
                    votePosition: { S: "Nay" },
                    votedAt: { S: "2026-02-03T18:15:00.000Z" },
                  }),
                },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("canonicalizes Senate short member ids through the member manifest when writing vote profile rows", async () => {
    const key = "processed-bills/BILLS-119sconres7.json";
    const payload = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-03-19T00:00:00.000Z",
      guid: "BILLS-119sconres7",
      civicProfile: {
        individualVsCommunity: 0.7,
      },
      officialVotes: {
        lastSyncedAt: "2026-03-19T12:00:00.000Z",
        source: "congress_api",
        completeness: "complete",
        senate: {
          actionDate: "2025-02-21T18:15:00.000Z",
          members: [
            { bioguideId: "S428", displayName: "Alsobrooks (D-MD)", state: "MD", votePosition: "Nay" },
            { bioguideId: "S317", displayName: "Barrasso (R-WY)", state: "WY", votePosition: "Yea" },
          ],
        },
      },
    };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(payload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd?.input ?? {};
      if (input.IndexName === "BillGuidIndex" && input.TableName === "CongressMemberVoteProfiles") {
        return { Items: [] };
      }
      if (input.TableName === "CongressMembersManifest") {
        return {
          Items: [
            {
              bioguideId: { S: "A000382" },
              name: { S: "Angela D. Alsobrooks" },
              chamber: { S: "Senate" },
              state: { S: "MD" },
            },
            {
              bioguideId: { S: "B001288" },
              name: { S: "John Barrasso" },
              chamber: { S: "Senate" },
              state: { S: "WY" },
            },
          ],
        };
      }
      return {};
    });

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberVoteProfiles: expect.arrayContaining([
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "A000382" },
                    billGuid: { S: "BILLS-119sconres7" },
                    votePosition: { S: "Nay" },
                  }),
                },
              }),
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "B001288" },
                    billGuid: { S: "BILLS-119sconres7" },
                    votePosition: { S: "Yea" },
                  }),
                },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("overrides a mismatched canonical-looking Senate member id using the member manifest", async () => {
    const key = "processed-bills/BILLS-119s1383.json";
    const payload = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-03-19T00:00:00.000Z",
      guid: "BILLS-119s1383",
      civicProfile: {
        individualVsCommunity: 0.3,
      },
      officialVotes: {
        lastSyncedAt: "2026-03-19T12:00:00.000Z",
        source: "congress_api",
        completeness: "complete",
        senate: {
          actionDate: "2026-02-11T00:00:00.000Z",
          members: [{ bioguideId: "A000380", displayName: "Alsobrooks (D-MD)", state: "MD", votePosition: "Nay" }],
        },
      },
    };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(payload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd?.input ?? {};
      if (input.IndexName === "BillGuidIndex" && input.TableName === "CongressMemberVoteProfiles") {
        return { Items: [{ bioguideId: { S: "A000380" } }] };
      }
      if (input.TableName === "CongressMembersManifest") {
        return {
          Items: [
            {
              bioguideId: { S: "A000382" },
              name: { S: "Angela D. Alsobrooks" },
              chamber: { S: "Senate" },
              state: { S: "MD" },
            },
          ],
        };
      }
      return {};
    });

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberVoteProfiles: expect.arrayContaining([
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "A000382" },
                    billGuid: { S: "BILLS-119s1383" },
                    votePosition: { S: "Nay" },
                  }),
                },
              }),
            ]),
          }),
        }),
      }),
    );
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberVoteProfiles: expect.arrayContaining([
              expect.objectContaining({
                DeleteRequest: {
                  Key: {
                    bioguideId: { S: "A000380" },
                    billGuid: { S: "BILLS-119s1383" },
                  },
                },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("canonicalizes Senate lis ids for accented and suffixed member names when writing vote profile rows", async () => {
    const key = "processed-bills/BILLS-119s2296.json";
    const payload = {
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-03-19T00:00:00.000Z",
      guid: "BILLS-119s2296",
      civicProfile: {
        individualVsCommunity: 0.4,
      },
      officialVotes: {
        lastSyncedAt: "2026-03-19T12:00:00.000Z",
        source: "congress_api",
        completeness: "complete",
        senate: {
          actionDate: "2025-10-09T20:59:00.000Z",
          members: [
            { bioguideId: "S363", displayName: "King (I-ME)", state: "ME", votePosition: "Yea" },
            { bioguideId: "S409", displayName: "Lujan (D-NM)", state: "NM", votePosition: "Yea" },
          ],
        },
      },
    };

    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) {
        return { Body: jsonReadable(payload) };
      }
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });

    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd?.input ?? {};
      if (input.IndexName === "BillGuidIndex" && input.TableName === "CongressMemberVoteProfiles") {
        return { Items: [] };
      }
      if (input.TableName === "CongressMembersManifest") {
        return {
          Items: [
            {
              bioguideId: { S: "K000383" },
              name: { S: "Angus S. King Jr." },
              chamber: { S: "Senate" },
              state: { S: "ME" },
            },
            {
              bioguideId: { S: "L000570" },
              name: { S: "Ben Ray Luján" },
              chamber: { S: "Senate" },
              state: { S: "NM" },
            },
          ],
        };
      }
      return {};
    });

    const event = sqsWrappedS3Keys([key]) as unknown as SQSEvent;
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(mockDdbSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          RequestItems: expect.objectContaining({
            CongressMemberVoteProfiles: expect.arrayContaining([
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "K000383" },
                    billGuid: { S: "BILLS-119s2296" },
                  }),
                },
              }),
              expect.objectContaining({
                PutRequest: {
                  Item: expect.objectContaining({
                    bioguideId: { S: "L000570" },
                    billGuid: { S: "BILLS-119s2296" },
                  }),
                },
              }),
            ]),
          }),
        }),
      }),
    );
  });

  describe("idempotent counters and partial batch failures (REL-07, REL-02, REL-17)", () => {
    it("treats an already-counted bill as done when the message is redelivered", async () => {
      const key = "raw-bills/BILLS-119hr42.json";
      mockRawBills({ [key]: rawBillPayload(["A000001"], ["B000002"]) });
      // Sponsor was counted on an earlier delivery; the cosponsor was not.
      mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
        if (cmd.input?.Key?.bioguideId?.S === "A000001") throw conditionalCheckFailed();
        return {};
      });

      const res = await handler(sqsEventWithIds([{ messageId: "m1", key }]));

      expect(res).toEqual({ batchItemFailures: [] });
      expect(mockDdbSend).toHaveBeenCalledTimes(2);
      expect(mockDdbSend).toHaveBeenCalledWith(
        expect.objectContaining({ input: counterUpdate("A000001", "billsSponsored", "BILLS-119hr42") }),
      );
      expect(mockDdbSend).toHaveBeenCalledWith(
        expect.objectContaining({ input: counterUpdate("B000002", "billsSupported", "BILLS-119hr42") }),
      );
    });

    it("reports only the failed record instead of failing the whole batch", async () => {
      const okKey = "raw-bills/BILLS-119hr1.json";
      const badKey = "raw-bills/BILLS-119hr2.json";
      mockRawBills({
        [okKey]: rawBillPayload(["A000001"], []),
        [badKey]: rawBillPayload(["C000003"], []),
      });
      mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
        if (cmd.input?.Key?.bioguideId?.S === "C000003") {
          throw Object.assign(new Error("Throughput exceeded"), { name: "ProvisionedThroughputExceededException" });
        }
        return {};
      });

      const res = await handler(
        sqsEventWithIds([
          { messageId: "m-bad", key: badKey },
          { messageId: "m-ok", key: okKey },
        ]),
      );

      expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "m-bad" }] });
      expect(mockDdbSend).toHaveBeenCalledWith(
        expect.objectContaining({ input: counterUpdate("A000001", "billsSponsored", "BILLS-119hr1") }),
      );
      expect(logLines(console.error)).toContainEqual(
        expect.objectContaining({
          message: "Failed to process S3 object for congress member stats:",
          messageId: "m-bad",
          sqsMessageId: "m-bad",
        }),
      );
    });

    it("counts a retried record exactly once per member", async () => {
      const key = "raw-bills/BILLS-119hr7.json";
      mockRawBills({ [key]: rawBillPayload(["A000001"], ["B000002", "C000003"]) });

      // In-memory stats table that honours the guid-set condition.
      const table = new Map<string, Record<string, unknown>>();
      let failNextFor: string | null = "C000003";
      mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
        const input = cmd.input;
        const id = input.Key!.bioguideId.S as string;
        if (failNextFor === id) {
          failNextFor = null;
          throw Object.assign(new Error("Internal"), { name: "InternalServerError" });
        }
        const item = table.get(id) ?? {};
        const counter = input.ExpressionAttributeNames!["#counter"];
        const setName = input.ExpressionAttributeNames!["#countedGuids"];
        const guid = input.ExpressionAttributeValues![":billGuid"].S as string;
        const set = (item[setName] as Set<string> | undefined) ?? new Set<string>();
        if (set.has(guid)) throw conditionalCheckFailed();
        set.add(guid);
        table.set(id, { ...item, [setName]: set, [counter]: ((item[counter] as number | undefined) ?? 0) + 1 });
        return {};
      });

      const event = sqsEventWithIds([{ messageId: "m1", key }]);
      expect(await handler(event)).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      // SQS redelivers the failed message (and may deliver it again): everyone ends at exactly one.
      expect(await handler(event)).toEqual({ batchItemFailures: [] });
      expect(await handler(event)).toEqual({ batchItemFailures: [] });

      expect(table.get("A000001")?.billsSponsored).toBe(1);
      expect(table.get("B000002")?.billsSupported).toBe(1);
      expect(table.get("C000003")?.billsSupported).toBe(1);
      expect([...(table.get("B000002")!.supportedBillGuids as Set<string>)]).toEqual(["BILLS-119hr7"]);
    });

    it("caps concurrent counter updates for bills with many cosponsors", async () => {
      const key = "raw-bills/BILLS-119hr3.json";
      const cosponsors = Array.from({ length: 35 }, (_, i) => `B${String(i).padStart(6, "0")}`);
      mockRawBills({ [key]: rawBillPayload(["A000001"], cosponsors) });

      let inFlight = 0;
      let maxInFlight = 0;
      mockDdbSend.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return {};
      });

      const res = await handler(sqsEventWithIds([{ messageId: "m1", key }]));

      expect(res).toEqual({ batchItemFailures: [] });
      expect(mockDdbSend).toHaveBeenCalledTimes(36);
      expect(maxInFlight).toBeLessThanOrEqual(10);
      expect(maxInFlight).toBeGreaterThan(1);
    });
  });

  describe("one run per changed processed bill (CAP-05)", () => {
    const key = "processed-bills/BILLS-119hr55.json";
    const processed = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      kind: "processed",
      storedAt: "2026-09-01T00:00:00.000Z",
      // Stored with a legacy versioned guid; the counters and the profile rows key on the key's version-less guid.
      guid: "BILLS-119hr55ih",
      sponsors: ["A000001"],
      cosponsors: ["B000002"],
      civicProfile: { individualVsCommunity: 0.7 },
      officialVotes: {
        lastSyncedAt: "2026-09-01T12:00:00.000Z",
        source: "congress_api",
        completeness: "complete",
        house: { actionDate: "2026-08-30", members: [{ bioguideId: "A000001", votePosition: "Yea" }] },
      },
      actions: [{ code: "A" }],
      ...overrides,
    });

    // Versions newest first. GETs by VersionId return that version; an unversioned GET the newest.
    const mockVersions = (versions: Array<{ versionId: string; body: unknown }>) => {
      mockS3Send.mockImplementation((cmd: FakeS3Command) => {
        const input = cmd?.input ?? {};
        if (input.Prefix === key) {
          return {
            Versions: versions.map((version, index) => ({
              Key: key,
              VersionId: version.versionId,
              IsLatest: index === 0,
              LastModified: new Date(Date.UTC(2026, 8, 25, 12, 0, 0) - index * 60_000).toISOString(),
            })),
            DeleteMarkers: [],
            IsTruncated: false,
          };
        }
        if (input.Key === key) {
          const version = input.VersionId ? versions.find((v) => v.versionId === input.VersionId) : versions[0];
          if (!version) throw Object.assign(new Error("NoSuchVersion"), { name: "NoSuchVersion" });
          return { Body: jsonReadable(version.body) };
        }
        throw new Error("Unexpected S3 request: " + JSON.stringify(input));
      });
    };
    const s3Calls = () =>
      mockS3Send.mock.calls.map(([cmd]: [FakeS3Command]) =>
        cmd.input.Prefix ? "list" : cmd.input.VersionId ? `get@${cmd.input.VersionId}` : "get@latest",
      );
    const tableCalls = (tableName: string) =>
      mockDdbSend.mock.calls.filter(
        ([cmd]: [FakeDdbCommand]) => cmd.input?.TableName === tableName || cmd.input?.RequestItems?.[tableName],
      );

    beforeEach(() => {
      mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => (cmd.input?.IndexName ? { Items: [] } : {}));
    });

    it("does nothing but read the two versions when only unrelated fields changed", async () => {
      mockVersions([
        { versionId: "v2", body: processed({ storedAt: "2026-09-02T00:00:00.000Z", actions: [{ code: "B" }] }) },
        { versionId: "v1", body: processed() },
      ]);

      const res = await handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(res).toEqual({ batchItemFailures: [] });
      expect(mockDdbSend).not.toHaveBeenCalled();
      expect(s3Calls().sort()).toEqual(["get@v1", "get@v2", "list"]);
    });

    it("does nothing but read the two versions for a status repair's write (repair:failed-status, page only too)", async () => {
      mockVersions([
        { versionId: "v2", body: processed({ storedAt: "2026-09-01T00:00:00.657Z", billStatus: "New" }) },
        { versionId: "v1", body: processed({ billStatus: "Failed" }) },
      ]);

      const res = await handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(res).toEqual({ batchItemFailures: [] });
      expect(mockDdbSend).not.toHaveBeenCalled();
      expect(s3Calls().sort()).toEqual(["get@v1", "get@v2", "list"]);
    });

    it("treats key order inside the compared fields as no change", async () => {
      const reordered = processed();
      reordered.officialVotes = {
        house: reordered.officialVotes.house,
        completeness: "complete",
        source: "congress_api",
        lastSyncedAt: "2026-09-01T12:00:00.000Z",
      };
      mockVersions([
        { versionId: "v2", body: reordered },
        { versionId: "v1", body: processed() },
      ]);

      await handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(mockDdbSend).not.toHaveBeenCalled();
    });

    it.each([
      ["a cosponsor was added", { cosponsors: ["B000002", "C000003"] }],
      ["the sponsor changed", { sponsors: ["D000004"] }],
      [
        "official votes were enriched",
        {
          officialVotes: {
            lastSyncedAt: "2026-09-02T12:00:00.000Z",
            source: "congress_api",
            completeness: "complete",
            house: {
              actionDate: "2026-08-30",
              members: [
                { bioguideId: "A000001", votePosition: "Yea" },
                { bioguideId: "E000005", votePosition: "Nay" },
              ],
            },
          },
        },
      ],
      ["the bill was re-summarized with a new civic profile", { civicProfile: { individualVsCommunity: 0.2 } }],
      // A repair of suffixed guids rewrites only the guid; the rows under the plain guid must then be written.
      ["only the guid lost its text-version suffix", { guid: "BILLS-119hr55" }],
    ])("applies the bill in full when %s", async (_label, change) => {
      mockVersions([
        { versionId: "v2", body: processed(change) },
        { versionId: "v1", body: processed() },
      ]);

      const res = await handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(res).toEqual({ batchItemFailures: [] });
      expect(tableCalls("congress-member-stats-table").length).toBeGreaterThan(0);
      expect(tableCalls("CongressMemberVoteProfiles").length).toBeGreaterThan(0);
      expect(tableCalls("CongressMemberLegislativeProfiles").length).toBeGreaterThan(0);
      // The version the event named is the latest, so it is not fetched twice.
      expect(s3Calls().filter((call) => call === "get@latest")).toEqual([]);
    });

    it("keys the profile rows and the stale-row cleanup by the key's plain guid, not the document's suffixed guid", async () => {
      mockVersions([{ versionId: "v1", body: processed() }]);

      const res = await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

      expect(res).toEqual({ batchItemFailures: [] });
      for (const table of ["CongressMemberVoteProfiles", "CongressMemberLegislativeProfiles"]) {
        const inputs = tableCalls(table).map(([cmd]: [FakeDdbCommand]) => cmd.input);
        const cleanupQueries = inputs.filter((input) => input.IndexName === "BillGuidIndex");
        expect(cleanupQueries.map((input) => input.ExpressionAttributeValues![":billGuid"])).toEqual([
          { S: "BILLS-119hr55" },
        ]);
        const putGuids = inputs.flatMap((input) =>
          (input.RequestItems?.[table] ?? []).map((request) => request.PutRequest!.Item.billGuid.S),
        );
        expect(putGuids.length).toBeGreaterThan(0);
        expect(new Set(putGuids)).toEqual(new Set(["BILLS-119hr55"]));
      }
    });

    it("deletes the bill's profile rows when a re-summary has no civic profile, and still counts (REL-43)", async () => {
      mockVersions([
        { versionId: "v2", body: processed({ civicProfile: undefined }) },
        { versionId: "v1", body: processed() },
      ]);
      // The rows v1 wrote, plus one from an older cosponsor list.
      const existing: Record<string, string[]> = {
        CongressMemberVoteProfiles: ["A000001"],
        CongressMemberLegislativeProfiles: ["A000001", "B000002", "OLD000"],
      };
      mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) =>
        cmd.input?.IndexName
          ? { Items: existing[cmd.input.TableName!].map((bioguideId) => ({ bioguideId: { S: bioguideId } })) }
          : {},
      );

      const res = await handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      expect(res).toEqual({ batchItemFailures: [] });
      for (const [table, members] of Object.entries(existing)) {
        const requests = tableCalls(table).flatMap(([cmd]: [FakeDdbCommand]) => cmd.input.RequestItems?.[table] ?? []);
        expect(requests.filter((request) => request.PutRequest)).toEqual([]);
        expect(requests.map((request) => request.DeleteRequest!.Key)).toEqual(
          members.map((bioguideId) => ({ bioguideId: { S: bioguideId }, billGuid: { S: "BILLS-119hr55" } })),
        );
      }
      expect(tableCalls("congress-member-stats-table").map(([cmd]: [FakeDdbCommand]) => cmd.input)).toEqual([
        counterUpdate("A000001", "billsSponsored", "BILLS-119hr55"),
        counterUpdate("B000002", "billsSupported", "BILLS-119hr55"),
      ]);
      expect(console.log).toHaveBeenCalledWith(
        "Deleted the bill's member profile rows; the processed bill has no civic profile",
        { key, billGuid: "BILLS-119hr55", voteRows: 1, legislativeRows: 3 },
      );
    });

    it("writes the bill's profile rows again when a later re-summary has a civic profile again (REL-43)", async () => {
      mockVersions([
        { versionId: "v3", body: processed() },
        { versionId: "v2", body: processed({ civicProfile: undefined }) },
        { versionId: "v1", body: processed() },
      ]);

      const res = await handler(sqsWrappedS3Keys([key], { versionId: "v3" }));

      expect(res).toEqual({ batchItemFailures: [] });
      const putMembers = (table: string) =>
        tableCalls(table)
          .flatMap(([cmd]: [FakeDdbCommand]) => cmd.input.RequestItems?.[table] ?? [])
          .map((request) => request.PutRequest!.Item.bioguideId.S);
      expect(putMembers("CongressMemberLegislativeProfiles").sort()).toEqual(["A000001", "B000002"]);
      expect(putMembers("CongressMemberVoteProfiles")).toEqual(["A000001"]);
    });

    it("writes no profile rows for a bill that never had a civic profile", async () => {
      mockVersions([{ versionId: "v1", body: processed({ civicProfile: undefined }) }]);

      await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

      for (const table of ["CongressMemberVoteProfiles", "CongressMemberLegislativeProfiles"]) {
        const inputs = tableCalls(table).map(([cmd]: [FakeDdbCommand]) => cmd.input);
        expect(inputs.map((input) => input.IndexName)).toEqual(["BillGuidIndex"]);
      }
    });

    it("counts sponsors and cosponsors from a new bill's first processed version, keyed on the version-less guid", async () => {
      mockVersions([{ versionId: "v1", body: processed({ cosponsors: ["B000002", "A000001", "C000003"] }) }]);

      await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

      const counters = tableCalls("congress-member-stats-table").map(([cmd]: [FakeDdbCommand]) => cmd.input);
      expect(counters).toEqual(
        expect.arrayContaining([
          counterUpdate("A000001", "billsSponsored", "BILLS-119hr55"),
          counterUpdate("B000002", "billsSupported", "BILLS-119hr55"),
          counterUpdate("C000003", "billsSupported", "BILLS-119hr55"),
        ]),
      );
      // A sponsor listed as a cosponsor too is counted as a sponsor only.
      expect(counters).toHaveLength(3);
    });

    it("applies the latest version when the event's version has been superseded", async () => {
      mockVersions([
        { versionId: "v3", body: processed({ cosponsors: ["B000002", "C000003", "F000006"] }) },
        { versionId: "v2", body: processed({ cosponsors: ["B000002", "C000003"] }) },
        { versionId: "v1", body: processed() },
      ]);

      await handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

      // The latest version is read by its id, so the applied version is known for the re-check.
      expect(s3Calls()).toContain("get@v3");
      expect(s3Calls()).not.toContain("get@latest");
      const legislativePuts = tableCalls("CongressMemberLegislativeProfiles")
        .flatMap(([cmd]: [FakeDdbCommand]) => cmd.input.RequestItems?.CongressMemberLegislativeProfiles ?? [])
        .map((request) => request.PutRequest?.Item?.bioguideId?.S)
        .filter(Boolean);
      expect(legislativePuts.sort()).toEqual(["A000001", "B000002", "C000003", "F000006"]);
    });

    it("applies a message without a versionId in full from one read of the latest version", async () => {
      mockVersions([
        { versionId: "v2", body: processed({ storedAt: "2026-09-02T00:00:00.000Z" }) },
        { versionId: "v1", body: processed() },
      ]);

      await handler(sqsWrappedS3Keys([key]));

      expect(s3Calls()).toEqual(["get@latest"]);
      expect(tableCalls("CongressMemberVoteProfiles").length).toBeGreaterThan(0);
    });

    it("applies the latest version in full when the listing does not know the event's version", async () => {
      mockVersions([
        { versionId: "v2", body: processed() },
        { versionId: "v1", body: processed() },
      ]);

      await handler(sqsWrappedS3Keys([key], { versionId: "gone" }));

      // The listing, the latest version by id, and the re-check listing (nothing newer).
      expect(s3Calls()).toEqual(["list", "get@v2", "list"]);
      expect(tableCalls("congress-member-stats-table").length).toBeGreaterThan(0);
    });

    it("counts a bill once whether its raw-bill key or its processed bill arrives first", async () => {
      const rawKey = "raw-bills/BILLS-119hr55.json";
      const counted = new Map<string, Set<string>>();
      mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
        const input = cmd.input ?? {};
        if (input.IndexName) return { Items: [] };
        if (!input.UpdateExpression) return {};
        const setKey = `${input.Key!.bioguideId.S}|${input.ExpressionAttributeNames!["#countedGuids"]}`;
        const set = counted.get(setKey) ?? new Set<string>();
        if (set.has(input.ExpressionAttributeValues![":billGuid"].S!)) throw conditionalCheckFailed();
        set.add(input.ExpressionAttributeValues![":billGuid"].S!);
        counted.set(setKey, set);
        return {};
      });
      const rawBody = rawBillPayload(["A000001"], ["B000002"]);
      mockS3Send.mockImplementation((cmd: FakeS3Command) => {
        const input = cmd?.input ?? {};
        const body = input.Prefix === rawKey || input.Key === rawKey ? rawBody : processed();
        if (input.Prefix) {
          return {
            Versions: [
              { Key: input.Prefix, VersionId: "v1", IsLatest: true, LastModified: "2026-09-25T00:00:00.000Z" },
            ],
            DeleteMarkers: [],
            IsTruncated: false,
          };
        }
        return { Body: jsonReadable(body) };
      });

      await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));
      await handler(sqsWrappedS3Keys([rawKey], { versionId: "v1" }));

      const increments = [...counted.entries()].map(([setKey, guids]) => [setKey, [...guids]]);
      expect(increments).toEqual([
        ["A000001|sponsoredBillGuids", ["BILLS-119hr55"]],
        ["B000002|supportedBillGuids", ["BILLS-119hr55"]],
      ]);
    });
  });
});

// ─── Rows counted before the counted-bill sets (UA-03) ─────────────────────────────────────────

type StatsRow = Record<string, AttributeValue>;

/**
 * The stats table in memory. UpdateItem honours the handler's exact ConditionExpression (and
 * returns the row on failure when asked, as DynamoDB does), then applies the ADD.
 */
const statsTable = (rows: Record<string, StatsRow> = {}) => {
  mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
    const input = cmd.input ?? {};
    if (input.IndexName) return { Items: [] };
    if (input.TableName !== "congress-member-stats-table" || !input.UpdateExpression) return {};
    const id = input.Key!.bioguideId.S!;
    const row = rows[id];
    if (!evaluateCondition(row, input)) {
      throw conditionFailedWithItem(input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? row : undefined);
    }
    const counter = input.ExpressionAttributeNames!["#counter"];
    const setName = input.ExpressionAttributeNames!["#countedGuids"];
    const next: StatsRow = { ...(row ?? { bioguideId: { S: id } }) };
    next[counter] = {
      N: String(Number(row?.[counter]?.N ?? "0") + Number(input.ExpressionAttributeValues![":inc"].N)),
    };
    next[setName] = {
      SS: [...new Set([...(row?.[setName]?.SS ?? []), ...input.ExpressionAttributeValues![":billGuidSet"].SS!])],
    };
    rows[id] = next;
    return {};
  });
  return rows;
};

const embeddedMetrics = () =>
  logLines(console.log)
    .filter((line) => line._aws)
    .flatMap((line) =>
      line._aws!.CloudWatchMetrics.flatMap((directive) =>
        directive.Metrics.map((metric) => ({
          namespace: directive.Namespace,
          name: metric.Name,
          value: line[metric.Name],
        })),
      ),
    );

describe("rows counted before the counted-bill sets (UA-03)", () => {
  const rawKey = "raw-bills/BILLS-119hr77.json";

  it("never increments a legacy row (count above 0, no set), and logs and counts the skip", async () => {
    // Production today: HEAD counted with a bare ADD, so the row has a count and no set.
    const rows = statsTable({ A000001: { bioguideId: { S: "A000001" }, billsSponsored: { N: "3" } } });
    mockRawBills({ [rawKey]: rawBillPayload(["A000001"], ["B000002"]) });

    const res = await handler(sqsEventWithIds([{ messageId: "m1", key: rawKey }]));

    expect(res).toEqual({ batchItemFailures: [] });
    expect(rows.A000001).toEqual({ bioguideId: { S: "A000001" }, billsSponsored: { N: "3" } });
    expect(rows.B000002.billsSupported).toEqual({ N: "1" });
    expect(logLines(console.warn)).toContainEqual(
      expect.objectContaining({
        level: "WARN",
        message:
          "Did not increment member counters that predate the counted-bill sets; run npm run backfill:congress-member-stats (UA-03)",
        key: rawKey,
        billGuid: "BILLS-119hr77",
        skippedUnseeded: 1,
        members: [{ bioguideId: "A000001", field: "billsSponsored" }],
        sqsMessageId: "m1",
      }),
    );
    expect(embeddedMetrics()).toEqual([
      { namespace: "BillBoard/CongressMemberStats", name: "MemberCounterSkippedUnseeded", value: 1 },
    ]);
  });

  it("counts a seeded row once, however often the bill is offered", async () => {
    const rows = statsTable({
      A000001: {
        bioguideId: { S: "A000001" },
        billsSponsored: { N: "2" },
        sponsoredBillGuids: { SS: ["BILLS-119hr1", "BILLS-119hr2"] },
      },
    });
    mockRawBills({ [rawKey]: rawBillPayload(["A000001"], []) });

    await handler(sqsEventWithIds([{ messageId: "m1", key: rawKey }]));
    await handler(sqsEventWithIds([{ messageId: "m2", key: rawKey }]));

    expect(rows.A000001.billsSponsored).toEqual({ N: "3" });
    expect(rows.A000001.sponsoredBillGuids.SS).toEqual(["BILLS-119hr1", "BILLS-119hr2", "BILLS-119hr77"]);
    expect(embeddedMetrics()).toEqual([]);
  });

  it("counts a brand-new member row", async () => {
    const rows = statsTable();
    mockRawBills({ [rawKey]: rawBillPayload(["N000001"], []) });

    await handler(sqsEventWithIds([{ messageId: "m1", key: rawKey }]));

    expect(rows.N000001).toEqual({
      bioguideId: { S: "N000001" },
      billsSponsored: { N: "1" },
      sponsoredBillGuids: { SS: ["BILLS-119hr77"] },
    });
  });

  it("counts a row whose count is 0 and has no set (the backfill writes members without bills that way)", async () => {
    const rows = statsTable({
      Z000001: { bioguideId: { S: "Z000001" }, billsSponsored: { N: "0" }, billsSupported: { N: "0" } },
    });
    mockRawBills({ [rawKey]: rawBillPayload(["Z000001"], []) });

    await handler(sqsEventWithIds([{ messageId: "m1", key: rawKey }]));

    expect(rows.Z000001.billsSponsored).toEqual({ N: "1" });
    expect(rows.Z000001.sponsoredBillGuids).toEqual({ SS: ["BILLS-119hr77"] });
    expect(rows.Z000001.billsSupported).toEqual({ N: "0" });
  });

  it("still starts a counter the legacy row never had", async () => {
    const rows = statsTable({ A000001: { bioguideId: { S: "A000001" }, billsSponsored: { N: "5" } } });
    mockRawBills({ [rawKey]: rawBillPayload(["S000001"], ["A000001"]) });

    await handler(sqsEventWithIds([{ messageId: "m1", key: rawKey }]));

    expect(rows.A000001.billsSponsored).toEqual({ N: "5" });
    expect(rows.A000001.billsSupported).toEqual({ N: "1" });
    expect(rows.A000001.supportedBillGuids).toEqual({ SS: ["BILLS-119hr77"] });
  });

  it("does not re-count a legacy row when a changed processed version offers every sponsor again (review repro)", async () => {
    const key = "processed-bills/BILLS-119hr55.json";
    const v1 = { guid: "BILLS-119hr55ih", sponsors: ["A000001"], cosponsors: [] };
    const v2 = { ...v1, cosponsors: ["B000002"] }; // a cosponsor joins
    mockS3Send.mockImplementation(async (cmd: FakeS3Command) => {
      const input = cmd.input;
      if (input.Prefix) {
        return {
          Versions: [
            { Key: key, VersionId: "v2", IsLatest: true, LastModified: "2026-09-25T12:01:00Z" },
            { Key: key, VersionId: "v1", IsLatest: false, LastModified: "2026-09-25T12:00:00Z" },
          ],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      return { Body: jsonReadable(input.VersionId === "v1" ? v1 : v2) };
    });
    // The HEAD raw-bill path counted BILLS-119hr55 for A000001 with a bare ADD.
    const rows = statsTable({ A000001: { bioguideId: { S: "A000001" }, billsSponsored: { N: "1" } } });

    await handler(sqsWrappedS3Keys([key], { versionId: "v2" }));

    expect(rows.B000002.billsSupported).toEqual({ N: "1" });
    expect(rows.A000001.billsSponsored).toEqual({ N: "1" });
  });

  it("counts exactly once per bill after the backfill has seeded the sets", async () => {
    const backfill = require("../../scripts/backfillCongressMemberStats.cjs");
    const rows = statsTable({ A000001: { bioguideId: { S: "A000001" }, billsSponsored: { N: "4" } } });

    // What `npm run backfill:congress-member-stats` writes for A000001 (one bill in raw-bills/).
    const seeded = backfill.buildMemberUpdateInput("A000001", new Set(["BILLS-119hr77"]), new Set(), {
      tableName: "congress-member-stats-table",
      primaryKey: "bioguideId",
    });
    rows.A000001 = {
      bioguideId: { S: "A000001" },
      billsSponsored: seeded.ExpressionAttributeValues[":sponsored"],
      billsSupported: seeded.ExpressionAttributeValues[":supported"],
      sponsoredBillGuids: seeded.ExpressionAttributeValues[":sponsoredGuids"],
    };

    const otherKey = "raw-bills/BILLS-119hr78.json";
    mockRawBills({
      [rawKey]: rawBillPayload(["A000001"], []),
      [otherKey]: rawBillPayload(["A000001"], []),
    });
    await handler(sqsEventWithIds([{ messageId: "m1", key: rawKey }]));
    await handler(sqsEventWithIds([{ messageId: "m2", key: otherKey }]));

    expect(rows.A000001.billsSponsored).toEqual({ N: "2" });
    expect(rows.A000001.sponsoredBillGuids.SS).toEqual(["BILLS-119hr77", "BILLS-119hr78"]);
    expect(embeddedMetrics()).toEqual([]);
  });
});

// ─── A newer version written while a message is applied (CAP-05 follow-up) ─────────────────────

describe("re-checking the latest processed version after the writes", () => {
  const key = "processed-bills/BILLS-119hr56.json";
  const bill = (cosponsors: string[], score: number) => ({
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-09-01T00:00:00.000Z",
    guid: "BILLS-119hr56ih",
    sponsors: ["A000001"],
    cosponsors,
    civicProfile: { individualVsCommunity: score },
  });

  /** S3 whose version list the test can grow; versions newest first. */
  const versionedS3 = (initial: Array<{ versionId: string; body: unknown }>) => {
    const versions = [...initial];
    mockS3Send.mockImplementation(async (cmd: FakeS3Command) => {
      const input = cmd.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: versions.map((version, index) => ({
            Key: key,
            VersionId: version.versionId,
            IsLatest: index === 0,
            LastModified: new Date(Date.UTC(2026, 8, 25, 12, 0, 0) + (versions.length - index) * 1000).toISOString(),
          })),
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      const version = input.VersionId ? versions.find((v) => v.versionId === input.VersionId) : versions[0];
      if (!version) throw Object.assign(new Error("NoSuchVersion"), { name: "NoSuchVersion" });
      return { Body: jsonReadable(version.body) };
    });
    return versions;
  };

  const s3Reads = () =>
    mockS3Send.mock.calls.map(([cmd]: [FakeS3Command]) =>
      cmd.input.Prefix ? "list" : `get@${cmd.input.VersionId ?? "latest"}`,
    );

  /** The legislative profile table in memory, with a hook that runs before the first batch write lands. */
  const legislativeTable = (beforeFirstWrite?: () => void) => {
    const rows = new Map<string, Record<string, AttributeValue>>();
    let hook = beforeFirstWrite;
    mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
      const input = cmd.input ?? {};
      if (input.TableName === "CongressMemberLegislativeProfiles" && input.IndexName) {
        return { Items: [...rows.keys()].map((bioguideId) => ({ bioguideId: { S: bioguideId } })) };
      }
      const requests = input.RequestItems?.CongressMemberLegislativeProfiles;
      if (requests) {
        const pending = hook;
        hook = undefined;
        pending?.();
        for (const request of requests) {
          if (request.PutRequest) rows.set(request.PutRequest.Item.bioguideId.S!, request.PutRequest.Item);
          if (request.DeleteRequest) rows.delete(request.DeleteRequest.Key.bioguideId.S!);
        }
        return {};
      }
      if (input.IndexName) return { Items: [] };
      return {};
    });
    return rows;
  };

  it("applies the newer version when the older message's writes landed last", async () => {
    const versions = versionedS3([{ versionId: "v1", body: bill(["B000002", "C000003"], 0.7) }]);
    // While v1 is being applied, v2 (C000003 withdrew, new civic profile) is written and its own
    // message finishes first; v1's rows then land on top of it.
    const rows = legislativeTable(() => {
      versions.unshift({ versionId: "v2", body: bill(["B000002"], 0.2) });
      rows.clear();
      for (const bioguideId of ["A000001", "B000002"]) {
        rows.set(bioguideId, {
          bioguideId: { S: bioguideId },
          civicProfile: { M: { individualVsCommunity: { N: "0.2" } } },
        });
      }
    });

    const res = await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

    expect(res).toEqual({ batchItemFailures: [] });
    expect([...rows.keys()].sort()).toEqual(["A000001", "B000002"]);
    for (const row of rows.values()) expect(row.civicProfile).toEqual({ M: { individualVsCommunity: { N: "0.2" } } });
    // The last list confirms v2 is still the latest after the extra pass.
    expect(s3Reads()).toEqual(["list", "get@v1", "list", "get@v2", "list"]);
    expect((console.log as jest.Mock).mock.calls).toContainEqual([
      "Applying the processed bill version written while this message was being applied",
      { key, appliedVersionId: "v1", latestVersionId: "v2" },
    ]);
  });

  // REL-43: a version without a civic profile deletes the bill's rows, so these two must converge too.
  const withoutCivicProfile = (cosponsors: string[]) => ({ ...bill(cosponsors, 0), civicProfile: undefined });

  it("deletes the rows the older civic version wrote when the newer version has no civic profile", async () => {
    const versions = versionedS3([{ versionId: "v1", body: bill(["B000002", "C000003"], 0.7) }]);
    // While v1 is being applied, v2 (re-summarized without a civic profile) is written and its own message, which
    // deleted the bill's rows, finishes first; v1's rows then land.
    const rows = legislativeTable(() => {
      versions.unshift({ versionId: "v2", body: withoutCivicProfile(["B000002", "C000003"]) });
      rows.clear();
    });

    const res = await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

    expect(res).toEqual({ batchItemFailures: [] });
    expect([...rows.keys()]).toEqual([]);
    expect(s3Reads()).toEqual(["list", "get@v1", "list", "get@v2", "list"]);
  });

  it("puts back the newer civic version's rows when the older no-civic version's deletes landed last", async () => {
    const versions = versionedS3([{ versionId: "v1", body: withoutCivicProfile(["B000002", "C000003"]) }]);
    // The rows an earlier civic version wrote. While v1 deletes them, v2 (C000003 withdrew, a civic profile again) is
    // written and its own message finishes first; v1's deletes then land on top of it.
    const rows = legislativeTable(() => {
      versions.unshift({ versionId: "v2", body: bill(["B000002"], 0.2) });
      rows.clear();
      for (const bioguideId of ["A000001", "B000002"]) {
        rows.set(bioguideId, {
          bioguideId: { S: bioguideId },
          civicProfile: { M: { individualVsCommunity: { N: "0.2" } } },
        });
      }
    });
    for (const bioguideId of ["A000001", "B000002", "C000003"]) {
      rows.set(bioguideId, {
        bioguideId: { S: bioguideId },
        civicProfile: { M: { individualVsCommunity: { N: "0.7" } } },
      });
    }

    const res = await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

    expect(res).toEqual({ batchItemFailures: [] });
    expect([...rows.keys()].sort()).toEqual(["A000001", "B000002"]);
    for (const row of rows.values()) expect(row.civicProfile).toEqual({ M: { individualVsCommunity: { N: "0.2" } } });
    expect(s3Reads()).toEqual(["list", "get@v1", "list", "get@v2", "list"]);
  });

  it("does not apply again when the newer version has the same member-stats inputs", async () => {
    const versions = versionedS3([{ versionId: "v1", body: bill(["B000002"], 0.7) }]);
    const rows = legislativeTable(() => {
      versions.unshift({ versionId: "v2", body: { ...bill(["B000002"], 0.7), storedAt: "2026-09-02T00:00:00.000Z" } });
    });

    await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

    expect(s3Reads()).toEqual(["list", "get@v1", "list", "get@v2"]);
    const legislativeWrites = mockDdbSend.mock.calls.filter(
      ([cmd]: [FakeDdbCommand]) => cmd.input?.RequestItems?.CongressMemberLegislativeProfiles,
    );
    expect(legislativeWrites).toHaveLength(1);
    expect([...rows.keys()].sort()).toEqual(["A000001", "B000002"]);
  });

  it("makes at most one extra pass, then fails the record so SQS redelivers it", async () => {
    const versions = versionedS3([{ versionId: "v1", body: bill(["B000002"], 0.1) }]);
    let written = 1;
    // Every write is followed by another relevant version.
    mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
      const input = cmd.input ?? {};
      if (input.IndexName) return { Items: [] };
      if (input.RequestItems?.CongressMemberLegislativeProfiles) {
        written += 1;
        versions.unshift({ versionId: `v${written}`, body: bill(["B000002"], written / 10) });
      }
      return {};
    });

    const event = sqsWrappedS3Keys([key], { versionId: "v1" });
    const res = await handler(event);

    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: event.Records[0].messageId }] });
    expect(s3Reads()).toEqual(["list", "get@v1", "list", "get@v2", "list", "get@v3"]);
  });

  it("does not re-check a message without a versionId", async () => {
    versionedS3([{ versionId: "v1", body: bill(["B000002"], 0.7) }]);
    legislativeTable();

    await handler(sqsWrappedS3Keys([key]));

    expect(s3Reads()).toEqual(["get@latest"]);
  });
});

describe("Senate member lookup refresh (REL-46)", () => {
  const TTL_MS = 60 * 60 * 1000;
  const key = "processed-bills/BILLS-119sconres7.json";
  const payload = {
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-03-19T00:00:00.000Z",
    guid: "BILLS-119sconres7",
    civicProfile: { individualVsCommunity: 0.7 },
    officialVotes: {
      lastSyncedAt: "2026-03-19T12:00:00.000Z",
      source: "congress_api",
      completeness: "complete",
      senate: {
        actionDate: "2025-02-21T18:15:00.000Z",
        members: [{ bioguideId: "S428", displayName: "Alsobrooks (D-MD)", state: "MD", votePosition: "Nay" }],
      },
    },
  };
  const manifestScans = () =>
    mockDdbSend.mock.calls.filter(([cmd]: [FakeDdbCommand]) => cmd?.input?.TableName === "CongressMembersManifest")
      .length;
  let nowMs = 0;

  beforeEach(() => {
    nowMs = Date.UTC(2027, 0, 3, 12, 0, 0);
    jest.spyOn(Date, "now").mockImplementation(() => nowMs);
    mockS3Send.mockImplementation((cmd: FakeS3Command) => {
      const input = cmd?.input ?? {};
      if (input.Prefix === key) {
        return {
          Versions: [{ Key: key, VersionId: "v1", IsLatest: true, LastModified: new Date().toISOString() }],
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      if (input.Key === key) return { Body: jsonReadable(payload) };
      throw new Error("Unexpected S3 request: " + JSON.stringify(input));
    });
    mockDdbSend.mockImplementation((cmd: FakeDdbCommand) => {
      const input = cmd?.input ?? {};
      if (input.TableName === "CongressMembersManifest") {
        return {
          Items: [
            {
              bioguideId: { S: "A000382" },
              name: { S: "Angela D. Alsobrooks" },
              chamber: { S: "Senate" },
              state: { S: "MD" },
            },
          ],
        };
      }
      if (input.IndexName === "BillGuidIndex") return { Items: [] };
      return {};
    });
  });

  it("reuses the lookup within the TTL", async () => {
    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);
    nowMs += TTL_MS - 1;
    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);
    expect(manifestScans()).toBe(1);
  });

  it("retries on the next call after a failed scan", async () => {
    const base = mockDdbSend.getMockImplementation();
    mockDdbSend.mockImplementationOnce((cmd) => {
      if (cmd?.input?.TableName === "CongressMembersManifest") throw new Error("scan failed");
      return base?.(cmd);
    });
    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent).catch(() => undefined);
    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent).catch(() => undefined);
    expect(manifestScans()).toBe(2);
  });

  it("scans again once the lookup is older than the TTL", async () => {
    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);
    nowMs += TTL_MS + 1;
    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);
    expect(manifestScans()).toBe(2);
  });
});

describe("the members' roll-call record (UX-39d)", () => {
  const key = "processed-bills/BILLS-119hr2312.json";
  const HOUSE_TEXT = "On passage Passed by the Yeas and Nays: 220 - 210 (Roll no. 61).";
  const bill = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2026-02-03T00:00:00.000Z",
    guid: "BILLS-119hr2312ih",
    sponsors: [],
    cosponsors: [],
    officialVotes: {
      lastSyncedAt: "2026-02-02T12:00:00.000Z",
      source: "congress_api",
      completeness: "complete",
      house: {
        actionDate: "2026-02-01",
        actionCode: "8000",
        resultText: HOUSE_TEXT,
        members: [
          { bioguideId: "A000001", displayName: "One", votePosition: "Yea" },
          { bioguideId: "B000002", displayName: "Two", votePosition: "Nay" },
          { bioguideId: "C000003", displayName: "Three", votePosition: "Present" },
          { bioguideId: "D000004", displayName: "Four", votePosition: "Not Voting" },
          { bioguideId: "E000005", displayName: "Five", votePosition: "Unknown" },
          { bioguideId: "A000001", displayName: "One", votePosition: "Yea" },
        ],
      },
      senate: {
        // A Senate vote read from its XML: the Senate's day and clock time, stored in ISO form.
        actionDate: "2026-03-05T23:30:00.000Z",
        members: [{ bioguideId: "S123", displayName: "Smith", state: "NY", votePosition: "Nay" }],
      },
    },
    ...overrides,
  });

  type Row = Record<string, AttributeValue>;
  const rowId = (row: Row) => `${row.bioguideId.S}|${row.billKey.S}`;

  /** A BatchGetItem's request for the record table. */
  interface RecordRead {
    Keys: Row[];
    ConsistentRead?: boolean;
  }
  const recordReadOf = (input: FakeDdbInput): RecordRead | undefined => {
    const requested = (input.RequestItems as Record<string, unknown> | undefined)?.CongressMemberVoteRecord;
    return requested && !Array.isArray(requested) ? (requested as RecordRead) : undefined;
  };

  /**
   * CongressMemberVoteRecord in memory. The BillGuidIndex answers from `index`, which follows the table only when
   * `indexLags` is false: an eventually consistent index that has not yet seen the latest writes. A strongly consistent
   * BatchGetItem answers from the table; any other read answers as the index does.
   */
  const recordTable = (unprocessedReads = 0) => {
    const state = { rows: new Map<string, Row>(), index: new Map<string, Row>(), indexLags: false, unprocessedReads };
    mockDdbSend.mockImplementation(async (cmd: FakeDdbCommand) => {
      const input = cmd.input ?? {};
      if (input.TableName === "CongressMemberVoteRecord" && input.IndexName) {
        return { Items: [...state.index.values()].filter((row) => row.billGuid.S === "BILLS-119hr2312") };
      }
      const read = recordReadOf(input);
      if (read) {
        if (state.unprocessedReads > 0) {
          state.unprocessedReads -= 1;
          return { Responses: { CongressMemberVoteRecord: [] }, UnprocessedKeys: { CongressMemberVoteRecord: read } };
        }
        const source = read.ConsistentRead ? state.rows : state.index;
        const found = read.Keys.map((readKey) => source.get(rowId(readKey))).filter((row): row is Row => !!row);
        return { Responses: { CongressMemberVoteRecord: found } };
      }
      const requests = input.RequestItems?.CongressMemberVoteRecord;
      if (requests) {
        for (const request of requests) {
          if (request.PutRequest) state.rows.set(rowId(request.PutRequest.Item), request.PutRequest.Item);
          if (request.DeleteRequest) state.rows.delete(rowId(request.DeleteRequest.Key));
        }
        if (!state.indexLags) state.index = new Map(state.rows);
        return {};
      }
      if (input.IndexName) return { Items: [] };
      if (input.TableName === "CongressMembersManifest") {
        return {
          Items: [
            { bioguideId: { S: "S000148" }, name: { S: "Sam Smith" }, chamber: { S: "Senate" }, state: { S: "NY" } },
          ],
        };
      }
      return {};
    });
    return state;
  };

  const recordWrites = () =>
    mockDdbSend.mock.calls.flatMap((call: unknown[]) => {
      const requests = (call[0] as FakeDdbCommand).input.RequestItems?.CongressMemberVoteRecord;
      return Array.isArray(requests) ? requests : [];
    });
  const recordReads = () =>
    mockDdbSend.mock.calls.flatMap((call: unknown[]) => recordReadOf((call[0] as FakeDdbCommand).input) ?? []);
  const puts = () => recordWrites().flatMap((request) => (request.PutRequest ? [request.PutRequest.Item] : []));
  const deletes = () => recordWrites().flatMap((request) => (request.DeleteRequest ? [request.DeleteRequest] : []));

  const houseRow = (bioguideId: string, position: string, extra: Row = {}): Row => ({
    bioguideId: { S: bioguideId },
    billKey: { S: "BILLS-119hr2312#House" },
    votedOnKey: { S: "2026-02-01#BILLS-119hr2312" },
    billGuid: { S: "BILLS-119hr2312" },
    chamber: { S: "House" },
    position: { S: position },
    votedOn: { S: "2026-02-01" },
    actionText: { S: HOUSE_TEXT },
    actionCode: { S: "8000" },
    updatedAt: { S: expect.any(String) },
    ...extra,
  });
  const senateRow: Row = {
    bioguideId: { S: "S000148" },
    billKey: { S: "BILLS-119hr2312#Senate" },
    votedOnKey: { S: "2026-03-05#BILLS-119hr2312" },
    billGuid: { S: "BILLS-119hr2312" },
    chamber: { S: "Senate" },
    position: { S: "Nay" },
    votedOn: { S: "2026-03-05" },
    updatedAt: { S: expect.any(String) },
  };
  /** A row as the BillGuidIndex projects it. */
  const indexed = (bioguideId: string, chamber: string, values: Record<string, string>): Row => ({
    bioguideId: { S: bioguideId },
    billKey: { S: `BILLS-119hr2312#${chamber}` },
    billGuid: { S: "BILLS-119hr2312" },
    ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { S: value }])),
  });
  const SAME_HOUSE = { position: "Yea", votedOn: "2026-02-01", actionText: HOUSE_TEXT, actionCode: "8000" };
  /** Rows already stored, in the table and in the index alike. */
  const store = (table: ReturnType<typeof recordTable>, rows: Row[]) => {
    table.rows = new Map(rows.map((row) => [rowId(row), row]));
    table.index = new Map(table.rows);
  };

  beforeEach(() => {
    restoreEnv?.();
    restoreEnv = applyTestEnv(
      {
        BUCKET_NAME: "test-bucket",
        TABLE_NAME: "congress-member-stats-table",
        PRIMARY_KEY: "bioguideId",
        VOTE_PROFILE_TABLE_NAME: "CongressMemberVoteProfiles",
        LEGISLATIVE_PROFILE_TABLE_NAME: "CongressMemberLegislativeProfiles",
        CONGRESS_MEMBERS_MANIFEST_TABLE_NAME: "CongressMembersManifest",
        VOTE_RECORD_TABLE_NAME: "CongressMemberVoteRecord",
        VOTE_RECORD_PRIMARY_KEY: "bioguideId",
        VOTE_RECORD_SORT_KEY: "billKey",
        VOTE_RECORD_VOTED_ON_KEY: "votedOnKey",
        VOTE_RECORD_BILL_GUID_INDEX_NAME: "BillGuidIndex",
        VOTE_RECORD_BILL_GUID_INDEX_PK: "billGuid",
      },
      { replace: true, base: originalEnv },
    );
    jest.resetModules();
    handler = require("../handlers/congressMemberStats").handler;
  });

  const apply = async (payload: unknown) => {
    mockRawBills({ [key]: payload });
    return handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);
  };

  it("writes every position Congress recorded, one row per member and chamber, dated by the roll call's day", async () => {
    recordTable();

    const res = await apply(bill());

    expect(res).toEqual({ batchItemFailures: [] });
    expect(puts()).toEqual([
      houseRow("A000001", "Yea"),
      houseRow("B000002", "Nay"),
      houseRow("C000003", "Present"),
      houseRow("D000004", "Not Voting"),
      // The Senate's lis id, resolved to the bioguide id through the members manifest; its day is the Senate's own,
      // with no time zone applied to the clock time.
      senateRow,
    ]);
    expect(deletes()).toEqual([]);
    // The index shows none of the bill's rows yet, so no row is read from the table.
    expect(recordReads()).toEqual([]);
    const queried = mockDdbSend.mock.calls
      .map((call: unknown[]) => (call[0] as FakeDdbCommand).input)
      .find((input: FakeDdbInput) => input.TableName === "CongressMemberVoteRecord" && input.IndexName);
    expect(queried).toMatchObject({
      IndexName: "BillGuidIndex",
      ExpressionAttributeValues: { ":billGuid": { S: "BILLS-119hr2312" } },
    });
  });

  it("writes the record for a bill without a civic profile, whose profile rows stay unwritten (REL-43)", async () => {
    recordTable();

    await apply(bill());

    expect(puts()).toHaveLength(5);
    const profileTables = mockDdbSend.mock.calls.flatMap((call: unknown[]) =>
      Object.keys((call[0] as FakeDdbCommand).input.RequestItems ?? {}),
    );
    expect(profileTables).not.toContain("CongressMemberVoteProfiles");
  });

  it("overwrites a member's row when a newer roll call replaces it, and deletes only rows the bill no longer gives", async () => {
    const table = recordTable();
    // An older roll call's rows (another day and text), a member the newer one does not list, and a Senate row.
    store(table, [
      indexed("A000001", "House", { position: "Nay", votedOn: "2025-12-01", actionText: "On motion to recommit" }),
      indexed("Z000009", "House", { position: "Yea", votedOn: "2025-12-01" }),
      indexed("S000148", "Senate", { position: "Nay", votedOn: "2026-03-05" }),
    ]);

    await apply(bill());

    // A000001 is written over in place; the unchanged Senate row is not written again.
    expect(puts().map(rowId)).toEqual([
      "A000001|BILLS-119hr2312#House",
      "B000002|BILLS-119hr2312#House",
      "C000003|BILLS-119hr2312#House",
      "D000004|BILLS-119hr2312#House",
    ]);
    expect(deletes()).toEqual([{ Key: { bioguideId: { S: "Z000009" }, billKey: { S: "BILLS-119hr2312#House" } } }]);
    // Only the row the index shows unchanged is read again, from the table.
    expect(recordReads()).toEqual([
      expect.objectContaining({
        ConsistentRead: true,
        Keys: [{ bioguideId: { S: "S000148" }, billKey: { S: "BILLS-119hr2312#Senate" } }],
      }),
    ]);
  });

  it("deletes every row of a bill whose official votes are gone", async () => {
    const table = recordTable();
    table.index = new Map([[rowId(indexed("A000001", "House", SAME_HOUSE)), indexed("A000001", "House", SAME_HOUSE)]]);

    await apply(bill({ officialVotes: undefined }));

    expect(puts()).toEqual([]);
    expect(deletes()).toEqual([{ Key: { bioguideId: { S: "A000001" }, billKey: { S: "BILLS-119hr2312#House" } } }]);
  });

  it("writes nothing on a redelivery: every stored row already has these values", async () => {
    const table = recordTable();
    await apply(bill());
    expect(table.rows.size).toBe(5);
    mockDdbSend.mockClear();

    await apply(bill());

    expect(puts()).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(recordReads()).toEqual([expect.objectContaining({ ConsistentRead: true })]);
    expect(recordReads()[0].Keys).toHaveLength(5);
  });

  it("writes rows back to their earlier values while the index still shows those values from before the last message", async () => {
    const table = recordTable();
    await apply(bill());
    // From here the index lags the table: it keeps showing the rows as the first message wrote them.
    table.indexLags = true;
    const v1 = bill();
    v1.officialVotes.house.members[0] = { bioguideId: "A000001", displayName: "One", votePosition: "Nay" };
    v1.officialVotes.house.members = v1.officialVotes.house.members.filter((member) => member.bioguideId !== "B000002");
    await apply(v1);
    expect(table.rows.get("A000001|BILLS-119hr2312#House")?.position.S).toBe("Nay");
    expect(table.rows.has("B000002|BILLS-119hr2312#House")).toBe(false);
    mockDdbSend.mockClear();

    // A newer version, a separate message, puts A000001's Yea and B000002's row back: the index shows both as they are
    // in this version, and only the table's consistent read shows they are not.
    await apply(bill());

    expect(puts()).toEqual([houseRow("A000001", "Yea"), houseRow("B000002", "Nay")]);
    expect(deletes()).toEqual([]);
    expect(table.rows.get("A000001|BILLS-119hr2312#House")?.position.S).toBe("Yea");
    expect(table.rows.get("B000002|BILLS-119hr2312#House")?.position.S).toBe("Nay");
    expect(console.log).toHaveBeenCalledWith(
      "Wrote member vote record rows the bill guid index showed unchanged but the table did not",
      { key, billGuid: "BILLS-119hr2312", rows: 2 },
    );
  });

  it("writes a row the table did not return after the retries, rather than leave it unchecked", async () => {
    const table = recordTable();
    await apply(bill());
    mockDdbSend.mockClear();
    table.unprocessedReads = 5;
    const retry = require("../shared/retry");
    const sleep = jest.spyOn(retry, "sleep").mockResolvedValue(undefined);

    await apply(bill());

    expect(recordReads()).toHaveLength(5);
    expect(sleep.mock.calls).toEqual([[200], [400], [600], [800]]);
    expect(puts()).toHaveLength(5);
  });

  it("writes a row again when only its position or its action text changed", async () => {
    const table = recordTable();
    await apply(bill());
    mockDdbSend.mockClear();
    const changed = bill();
    changed.officialVotes.house.members[1] = { bioguideId: "B000002", displayName: "Two", votePosition: "Present" };
    changed.officialVotes.house.resultText = "On passage Passed (corrected)";

    await apply(changed);

    expect(puts().map((row) => [row.bioguideId.S, row.position.S, row.actionText?.S])).toEqual([
      ["A000001", "Yea", "On passage Passed (corrected)"],
      ["B000002", "Present", "On passage Passed (corrected)"],
      ["C000003", "Present", "On passage Passed (corrected)"],
      ["D000004", "Not Voting", "On passage Passed (corrected)"],
    ]);
    expect(deletes()).toEqual([]);
    expect(table.rows.size).toBe(5);
  });

  it("leaves out a chamber vote without its own day, never dating it by the sync or store time", async () => {
    recordTable();
    await apply(
      bill({
        officialVotes: {
          lastSyncedAt: "2026-02-02T12:00:00.000Z",
          house: { members: [{ bioguideId: "A000001", votePosition: "Yea" }] },
          senate: { actionDate: "March 5", members: [{ bioguideId: "S123", state: "NY", votePosition: "Nay" }] },
        },
      }),
    );

    expect(puts()).toEqual([]);
  });

  it("deletes a row the first pass wrote when the newer version drops it, though the index has not seen it yet", async () => {
    const table = recordTable();
    table.indexLags = true;
    const v1 = bill();
    const v2 = bill();
    // v2: B000002's row is gone from the House roll call, and the Senate vote is gone.
    v2.officialVotes.house.members = v2.officialVotes.house.members.filter((member) => member.bioguideId !== "B000002");
    delete (v2.officialVotes as { senate?: unknown }).senate;
    const versions = [{ versionId: "v1", body: v1 }];
    let written = false;
    mockS3Send.mockImplementation(async (cmd: FakeS3Command) => {
      const input = cmd.input ?? {};
      if (input.Prefix === key) {
        // v2 is written while v1 is being applied: it is listed once v1's record rows have landed.
        if (table.rows.size > 0 && !written) {
          written = true;
          versions.unshift({ versionId: "v2", body: v2 });
        }
        return {
          Versions: versions.map((version, index) => ({
            Key: key,
            VersionId: version.versionId,
            IsLatest: index === 0,
            LastModified: new Date(Date.UTC(2026, 8, 25, 12, 0, versions.length - index)).toISOString(),
          })),
          DeleteMarkers: [],
          IsTruncated: false,
        };
      }
      const version = input.VersionId ? versions.find((v) => v.versionId === input.VersionId) : versions[0];
      return { Body: jsonReadable(version!.body) };
    });

    const res = await handler(sqsWrappedS3Keys([key], { versionId: "v1" }));

    expect(res).toEqual({ batchItemFailures: [] });
    expect([...table.rows.keys()].sort()).toEqual([
      "A000001|BILLS-119hr2312#House",
      "C000003|BILLS-119hr2312#House",
      "D000004|BILLS-119hr2312#House",
    ]);
    // The second pass wrote no row again: the first pass's values are known without the index.
    expect(puts()).toHaveLength(5);
  });
});

describe("each Congress counted apart (REL-46)", () => {
  const IN_THE_120TH = Date.parse("2027-01-05T12:00:00.000Z");
  const BEFORE_THE_120TH = Date.parse("2026-11-23T12:00:00.000Z");
  const processedBill = (guid: string) => ({
    schemaVersion: 1,
    kind: "processed",
    storedAt: "2027-01-05T00:00:00.000Z",
    guid,
    sponsors: ["A000001"],
    cosponsors: ["B000002"],
    civicProfile: { individualVsCommunity: 0.7 },
    officialVotes: {
      lastSyncedAt: "2027-01-05T12:00:00.000Z",
      source: "congress_api",
      completeness: "complete",
      house: { actionDate: "2027-01-04", members: [{ bioguideId: "A000001", votePosition: "Yea" }] },
    },
  });
  type SentCommand = {
    input?: {
      TableName?: string;
      RequestItems?: Record<string, unknown>;
      ExpressionAttributeNames?: Record<string, string>;
    };
  };
  const counterCalls = () =>
    mockDdbSend.mock.calls.filter(
      (call: unknown[]) => (call[0] as SentCommand).input?.TableName === "congress-member-stats-table",
    );
  const counterAttributes = () =>
    counterCalls().map((call: unknown[]) => (call[0] as SentCommand).input?.ExpressionAttributeNames);
  const profileTables = () =>
    mockDdbSend.mock.calls.flatMap((call: unknown[]) =>
      Object.keys((call[0] as SentCommand).input?.RequestItems ?? {}),
    );
  const at = (ms: number) => jest.spyOn(Date, "now").mockReturnValue(ms);

  it("counts a processed 120th bill in the 120th's own attributes only, and still writes its profile rows", async () => {
    at(IN_THE_120TH);
    const key = "processed-bills/BILLS-120hr1.json";
    const rows = statsTable();
    mockRawBills({ [key]: processedBill("BILLS-120hr1") });

    const res = await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(counterAttributes()).toEqual([
      { "#counter": "billsSponsored120", "#countedGuids": "sponsoredBillGuids120" },
      { "#counter": "billsSupported120", "#countedGuids": "supportedBillGuids120" },
    ]);
    expect(rows).toEqual({
      A000001: {
        bioguideId: { S: "A000001" },
        billsSponsored120: { N: "1" },
        sponsoredBillGuids120: { SS: ["BILLS-120hr1"] },
      },
      B000002: {
        bioguideId: { S: "B000002" },
        billsSupported120: { N: "1" },
        supportedBillGuids120: { SS: ["BILLS-120hr1"] },
      },
    });
    expect(profileTables()).toEqual(
      expect.arrayContaining(["CongressMemberVoteProfiles", "CongressMemberLegislativeProfiles"]),
    );
    expect(embeddedMetrics()).toEqual([]);
  });

  it("counts a raw 120th bill in the 120th's attributes and keeps a returning member's 119th counts as they are", async () => {
    at(IN_THE_120TH);
    const key = "raw-bills/BILLS-120s5.json";
    const rows = statsTable({
      A000001: {
        bioguideId: { S: "A000001" },
        billsSponsored: { N: "2" },
        billsSupported: { N: "0" },
        sponsoredBillGuids: { SS: ["BILLS-119hr1", "BILLS-119hr2"] },
      },
    });
    mockRawBills({ [key]: rawBillPayload(["A000001"], ["B000002"]) });

    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);
    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent); // a redelivery counts nothing again

    expect(rows.A000001).toEqual({
      bioguideId: { S: "A000001" },
      billsSponsored: { N: "2" },
      billsSupported: { N: "0" },
      sponsoredBillGuids: { SS: ["BILLS-119hr1", "BILLS-119hr2"] },
      billsSponsored120: { N: "1" },
      sponsoredBillGuids120: { SS: ["BILLS-120s5"] },
    });
    expect(rows.B000002).toEqual({
      bioguideId: { S: "B000002" },
      billsSupported120: { N: "1" },
      supportedBillGuids120: { SS: ["BILLS-120s5"] },
    });
  });

  it("still counts a 119th bill in the original attributes after the 120th starts", async () => {
    at(IN_THE_120TH);
    const key = "raw-bills/BILLS-119hr1.json";
    const rows = statsTable();
    mockRawBills({ [key]: rawBillPayload(["A000001"], ["B000002"]) });

    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);

    expect(rows.A000001).toEqual({
      bioguideId: { S: "A000001" },
      billsSponsored: { N: "1" },
      sponsoredBillGuids: { SS: ["BILLS-119hr1"] },
    });
    expect(rows.B000002.billsSupported).toEqual({ N: "1" });
    expect(embeddedMetrics()).toEqual([]);
  });

  it("counts no bill of a Congress not yet in session", async () => {
    at(BEFORE_THE_120TH);
    const key = "processed-bills/BILLS-120hr1.json";
    const rows = statsTable();
    mockRawBills({ [key]: processedBill("BILLS-120hr1") });

    const res = await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);

    expect(res).toEqual({ batchItemFailures: [] });
    expect(counterCalls()).toEqual([]);
    expect(rows).toEqual({});
    expect(logLines(console.log)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("do not count"),
        key,
        billGuid: "BILLS-120hr1",
        congress: 120,
        latestCounted: 119,
        offered: 2,
      }),
    );
    expect(embeddedMetrics()).toContainEqual({
      namespace: "BillBoard/CongressMemberStats",
      name: "MemberCounterOtherCongress",
      value: 2,
    });
  });

  it("counts no bill of a Congress before the 119th", async () => {
    at(IN_THE_120TH);
    const key = "raw-bills/BILLS-118hr9.json";
    const rows = statsTable();
    mockRawBills({ [key]: rawBillPayload(["A000001"], ["B000002"]) });

    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);

    expect(counterCalls()).toEqual([]);
    expect(rows).toEqual({});
  });

  it("counts nothing for a guid without a Congress number", async () => {
    const key = "raw-bills/not-a-bill.json";
    const rows = statsTable();
    mockRawBills({ [key]: rawBillPayload(["A000001"], ["B000002"]) });

    await handler(sqsWrappedS3Keys([key]) as unknown as SQSEvent);

    expect(counterCalls()).toEqual([]);
    expect(rows).toEqual({});
  });
});

export {};
