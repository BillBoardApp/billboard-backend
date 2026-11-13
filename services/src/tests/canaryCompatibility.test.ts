/**
 * Canary compatibility tests — verify that handlers are safe to run alongside
 * an older version during a CodeDeploy canary deployment:
 *
 *  - Unknown enum values are dropped, never stored or returned.
 *  - Missing optional fields default to safe empty values.
 *  - Synthetic test events short-circuit without touching real data.
 */

import type { AttributeValue, TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import { isSyntheticEvent } from "../shared/syntheticEvent";
import { applyTestEnv } from "./fixtures/env";

// ─── Shared DynamoDB mock (only used by fetchBillsManifest tests) ─────────────

const mockDdbSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ __type: "QueryCommand", input })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "GetItemCommand", input })),
}));

// ─── isSyntheticEvent ─────────────────────────────────────────────────────────

describe("isSyntheticEvent", () => {
  it("returns true for { source: 'synthetic-test' }", () => {
    expect(isSyntheticEvent({ source: "synthetic-test" })).toBe(true);
  });

  it("returns true for { x-synthetic-test: 'true' }", () => {
    expect(isSyntheticEvent({ "x-synthetic-test": "true" })).toBe(true);
  });

  it("returns true for { x-synthetic-test: 'TRUE' } (case-insensitive)", () => {
    expect(isSyntheticEvent({ "x-synthetic-test": "TRUE" })).toBe(true);
  });

  it("returns false for real Lambda events", () => {
    expect(isSyntheticEvent({ Records: [] })).toBe(false);
    expect(isSyntheticEvent({ queryStringParameters: {} })).toBe(false);
    expect(isSyntheticEvent(null)).toBe(false);
    expect(isSyntheticEvent(undefined)).toBe(false);
    expect(isSyntheticEvent("string")).toBe(false);
  });

  it("returns false when source has a different value", () => {
    expect(isSyntheticEvent({ source: "aws.events" })).toBe(false);
    expect(isSyntheticEvent({ source: "synthetic" })).toBe(false);
  });
});

// ─── fetchBillsManifest: synthetic event short-circuit ────────────────────────

describe("fetchBillsManifest — synthetic event short-circuit", () => {
  let handler: (event?: unknown) => Promise<{ statusCode: number; body: string; headers?: Record<string, string> }>;
  let restoreEnv: () => void;

  beforeEach(() => {
    jest.resetModules();
    mockDdbSend.mockReset();

    restoreEnv = applyTestEnv({
      TABLE_NAME: "bills-table",
      PRIMARY_KEY: "pk",
      PK_VALUE: "BILL",
    });

    const module = require("../handlers/fetchBillsManifest/index");
    handler = module.handler;
  });

  afterEach(() => {
    restoreEnv?.();
  });

  it("returns { status: 'healthy', synthetic: true } without querying DynamoDB", async () => {
    const result = await handler({ source: "synthetic-test" });

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("healthy");
    expect(body.synthetic).toBe(true);

    // No DynamoDB calls should have been made
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  it("returns { status: 'healthy' } for x-synthetic-test: 'true' header pattern", async () => {
    const result = await handler({ "x-synthetic-test": "true" });

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("healthy");
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

// ─── fetchBillsManifest: unknown enum values are dropped ──────────────────────

describe("fetchBillsManifest — unknown billStatus values are excluded", () => {
  let handler: (event?: unknown) => Promise<{ statusCode: number; body: string }>;
  let restoreEnv: () => void;

  beforeEach(() => {
    jest.resetModules();
    mockDdbSend.mockReset();

    restoreEnv = applyTestEnv({
      TABLE_NAME: "bills-table",
      PRIMARY_KEY: "pk",
      PK_VALUE: "BILL",
    });

    const module = require("../handlers/fetchBillsManifest/index");
    handler = module.handler;
  });

  afterEach(() => {
    restoreEnv?.();
  });

  const makeItem = (guid: string, billStatus?: string) => ({
    pk: { S: "BILL" },
    sk: { S: `2024-01-01T00:00:00.000Z#${guid}` },
    guid: { S: guid },
    billType: { S: "hr" },
    congress: { S: "118" },
    billNumber: { S: "1" },
    updatedAt: { S: "2024-01-01T00:00:00.000Z" },
    title: { S: "Test Bill" },
    subCategories: { L: [] },
    lifeAreas: { L: [] },
    sponsors: { L: [] },
    cosponsors: { L: [] },
    voteCount: { N: "0" },
    ...(billStatus ? { billStatus: { S: billStatus } } : {}),
  });

  it("drops an unrecognised billStatus value and omits the field", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [makeItem("BILLS-118hr1", "Recalled")],
    });

    const result = await handler({});
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.bills).toHaveLength(1);
    expect(body.bills[0].billStatus).toBeUndefined();
  });

  it("includes a valid billStatus value unchanged", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [makeItem("BILLS-118hr2", "Passed")],
    });

    const result = await handler({});
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.bills[0].billStatus).toBe("Passed");
  });

  it("defaults missing list fields to empty arrays", async () => {
    // Item with no lifeAreas, sponsors, cosponsors
    const minimalItem = {
      pk: { S: "BILL" },
      sk: { S: "2024-01-01T00:00:00.000Z#BILLS-118hr3" },
      guid: { S: "BILLS-118hr3" },
      billType: { S: "s" },
      congress: { S: "118" },
      billNumber: { S: "3" },
      updatedAt: { S: "2024-01-01T00:00:00.000Z" },
      title: { S: "Minimal Bill" },
      // subCategories, lifeAreas, sponsors, cosponsors all absent
    };

    mockDdbSend.mockResolvedValue({ Items: [minimalItem] });

    const result = await handler({});
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.bills[0].subCategories).toEqual([]);
    expect(body.bills[0].lifeAreas).toEqual([]);
    expect(body.bills[0].sponsors).toEqual([]);
    expect(body.bills[0].cosponsors).toEqual([]);
  });
});

// ─── createBillsManifest: unknown billStatus values are not persisted ─────────

describe("createBillsManifest — unknown billStatus values are not stored", () => {
  /** What the mocked DynamoDB commands carry: a tag naming the command and its input. */
  interface TaggedCommand<Input = unknown> {
    __type?: string;
    input: Input;
  }

  const mockS3Send = jest.fn();
  const mockDdb2Send = jest.fn();

  // createBillsManifest has its own module-level clients, so we need
  // per-test module resets with fresh mocks.
  beforeEach(() => {
    jest.resetModules();
    mockS3Send.mockReset();
    mockDdb2Send.mockReset();
  });

  const buildHandler = () => {
    jest.mock("@aws-sdk/client-s3", () => ({
      S3Client: jest.fn(() => ({ send: mockS3Send })),
      GetObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "GetObjectCommand", input })),
    }));
    jest.mock("@aws-sdk/client-dynamodb", () => ({
      DynamoDBClient: jest.fn(() => ({ send: mockDdb2Send })),
      GetItemCommand: jest.fn().mockImplementation((input) => ({ __type: "GetItemCommand", input })),
      PutItemCommand: jest.fn().mockImplementation((input) => ({ __type: "PutItemCommand", input })),
      DeleteItemCommand: jest.fn().mockImplementation((input) => ({ __type: "DeleteItemCommand", input })),
      QueryCommand: jest.fn().mockImplementation((input) => ({ __type: "QueryCommand", input })),
      TransactWriteItemsCommand: jest
        .fn()
        .mockImplementation((input) => ({ __type: "TransactWriteItemsCommand", input })),
    }));
    jest.mock("@aws-sdk/client-sqs", () => ({
      SQSClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Successful: [], Failed: [] }) })),
      SendMessageBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
    }));

    const restore = applyTestEnv({
      BUCKET_NAME: "test-bucket",
      TABLE_NAME: "test-table",
      PRIMARY_KEY: "pk",
      SORT_KEY: "sk",
      PK_VALUE: "BILL",
      QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123/test-queue",
    });
    const { handler } = require("../handlers/createBillsManifest/index");
    return { handler, restore };
  };

  it("does not store an unrecognised billStatus value in DynamoDB", async () => {
    const { handler, restore } = buildHandler();

    const { Readable } = require("stream");
    const billBody = {
      kind: "processed",
      guid: "BILLS-118hr7777",
      title: "Quirky Bill",
      storedAt: "2024-06-01T00:00:00.000Z",
      billStatus: "Withdrawn",
      identifier: { billType: "hr", congress: "118", billNumber: "7777" },
      subCategories: [],
      lifeAreas: [],
      sponsors: [],
      cosponsors: [],
    };
    const bodyStr = JSON.stringify(billBody);
    const readable = new Readable();
    readable.push(bodyStr);
    readable.push(null);

    mockS3Send.mockResolvedValue({ Body: readable });

    mockDdb2Send.mockImplementation((cmd: TaggedCommand) => {
      if (cmd.__type === "GetItemCommand") return Promise.resolve({ Item: undefined });
      return Promise.resolve({});
    });

    const event = {
      Records: [
        {
          body: JSON.stringify({
            Records: [
              {
                eventName: "ObjectCreated:Put",
                s3: { bucket: { name: "test-bucket" }, object: { key: "processed-bills/BILLS-118hr7777.json" } },
              },
            ],
          }),
        },
      ],
    };

    await handler(event);

    // Find the manifest Put inside the TransactWriteItems call
    const manifestPuts = mockDdb2Send.mock.calls
      .filter((call: [TaggedCommand?]) => call[0]?.__type === "TransactWriteItemsCommand")
      .flatMap((call: [TaggedCommand<TransactWriteItemsCommandInput>]) => call[0].input.TransactItems!)
      .filter((op) => op.Put?.Item?.pk?.S === "BILL");
    expect(manifestPuts.length).toBeGreaterThan(0);

    const item: Record<string, AttributeValue> = manifestPuts[0].Put!.Item!;
    // Unrecognised "Withdrawn" status must NOT be stored
    expect(item.billStatus).toBeUndefined();

    restore();
  });
});
